// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { NetworkManager, NodeIdentity } from '@rljson/network';
import type {
  NetworkConfig,
  NetworkManagerOptions,
  NetworkTopology,
  NodeRole,
  RoleChangedEvent,
} from '@rljson/network';
import { Route } from '@rljson/rljson';

import { HubRoutes, HubRoutesOptions } from './hub-routes.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import {
  PeerReadBounds,
  RouteMember,
  RouteMemberContext,
  RoutePeerReads,
} from './route-member.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

// #############################################################################
/**
 * What a connection to a node's port says about itself in its handshake.
 */
export interface PortHandshake {
  /** The routes it names: one for a route client or a peer. */
  treeKeys?: string[];

  /** Whether it is a peer, reading this node's local stores. */
  peerRead?: boolean;
}

// #############################################################################
/**
 * A node's port: one server, open in every role, for hub connections and
 * peer connections — and the target of the network's probes.
 */
export interface PortTransport {
  /**
   * Sets the check every connection must pass before it is accepted. A
   * refused connection gets a connect error, so its client retries.
   * @param check - True to accept.
   */
  accept(check: (handshake: PortHandshake) => boolean): void;

  /**
   * Sets the handler of every accepted connection.
   * @param handler - Gets the connection and its handshake.
   */
  onConnection(
    handler: (socket: SocketLike, handshake: PortHandshake) => void,
  ): void;

  /** Closes the port and every connection on it. */
  close(): Promise<void>;
}

// #############################################################################
/**
 * Opens a node's port.
 * @param port - The port.
 */
export type CreatePortTransport = (port: number) => Promise<PortTransport>;

// #############################################################################
/**
 * Opens a connection to another node's port for one route.
 * @param address - `ip:port`.
 * @param options - The route's tree key, and a signal that aborts when the
 *   connection is no longer wanted.
 */
export type ConnectRoute = (
  address: string,
  options: { treeKey: string; signal: AbortSignal },
) => Promise<SocketLike>;

// #############################################################################
/**
 * What a {@link Node} needs from its app: the transport.
 */
export interface NodeDeps {
  /** Opens this node's port. */
  createPortTransport: CreatePortTransport;

  /**
   * Opens a route client's connection to the hub. The handshake names the
   * route: `{ treeKeys: [treeKey] }`. Only members that connect through the
   * node need it — a `ClientRoute` does; a member that dials its hub on its
   * own does not. Without it, a member asking for one is refused.
   */
  connectHub?: ConnectRoute;

  /**
   * Opens a connection to a peer for peer reads. The handshake names the
   * route and says it is a peer: `{ treeKeys: [treeKey], peerRead: true }`.
   * Without it, this node serves peers but reads only from its hub.
   */
  connectPeer?: ConnectRoute;

  /** Options of the network manager (probes, discovery layers). */
  networkManagerOptions?: NetworkManagerOptions;
}

// #############################################################################
/**
 * Configuration of a {@link Node}.
 */
export interface NodeConfig {
  /** Network domain: which nodes find each other. */
  domain: string;

  /** This node's port, in every role. */
  port: number;

  /**
   * Network configuration. The probe listener stays off: the port is this
   * node's own server in every role, and it answers the probes.
   */
  network?: Partial<NetworkConfig>;

  /** Where the node id is kept. */
  identityDir?: string;

  /** Logger of the node, its hub and its members. */
  logger?: ServerLogger;

  /**
   * The hub service every node runs: the routes it starts with, their
   * stores, their server options. It takes route clients only while this node
   * is hub.
   */
  hub: Omit<HubRoutesOptions, 'logger'>;

  /** The routes this node takes part in, one member each. */
  members?: RouteMember[];

  /**
   * Peer reads: members read announced data from the node that sent it
   * before asking the hub. Off when omitted, or without `connectPeer`.
   */
  peerReads?: PeerReadBounds;

  /**
   * After becoming hub, how long to wait for another node to connect before
   * stepping down when other nodes exist. Default 20 000 ms; 0 is off.
   */
  hubSelfCheckMs?: number;

  /**
   * How often to check that the members talk to the elected hub, in case an
   * event was missed. Default 30 000 ms; 0 is off.
   */
  driftCheckMs?: number;

  /** How long topology changes settle before members move. Default 1500 ms. */
  reconnectDelayMs?: number;

  /** Wait before starting a member again whose start failed. Default 3000 ms. */
  retryMs?: number;

  /**
   * How long a node that knows no peer and has no hub waits before it acts
   * as its own hub. The network elects nobody without peers to probe, so a
   * machine on its own would otherwise never sync with itself. It yields as
   * soon as a peer appears or the network names a hub. Default 12 000 ms;
   * 0 is off.
   */
  aloneHubMs?: number;
}

// #############################################################################
/** The hub the members moved to. */
export interface NodeHubChangedEvent {
  /** The hub before, as `ip:port`. */
  previous?: string;

  /** The hub now, as `ip:port`. */
  current: string;
}

// #############################################################################
/** Events of a {@link Node}. */
export interface NodeEvents {
  /** The node's role changed — the moment to raise a hub's stamps. */
  'role-changed': (event: RoleChangedEvent) => void;

  /** The members are moving to another hub. */
  'hub-changed': (event: NodeHubChangedEvent) => void;

  /** Every member started on the current hub. */
  ready: () => void;

  /** The node stopped. */
  stopped: () => void;
}

/** Names of the events of a {@link Node}. */
export type NodeEventName = keyof NodeEvents;

type NodeListener = NodeEvents[NodeEventName];

// #############################################################################
/**
 * A node of an rljson network: the same on every machine, whatever its role.
 *
 * - **One port, always open.** It takes hub connections while this node is
 *   hub, peer connections in every role, and answers the network's probes.
 * - **A hub service** for every route: one server per route, created on
 *   demand ({@link HubRoutes}). It never moves; only who connects to it does.
 * - **Route members**: per route this node takes part in, a client of the
 *   elected hub — over loopback while this node is hub — with local stores it
 *   serves to peers. When the hub moves, the members move with it.
 *
 * The network manager elects the hub. The node follows: on every role, hub or
 * topology change, after a short settling time, and on a periodic drift
 * check in case an event was missed.
 */
export class Node {
  private readonly _logger: ServerLogger;
  private readonly _networkManager: NetworkManager;
  private readonly _members = new Map<string, RouteMember>();
  private _hub?: HubRoutes;
  private _transport?: PortTransport;
  private _nodeId?: string;
  private _running = false;
  private _hubAddress?: string;
  /** The hub the members are being moved to, while a move runs. */
  private _movingTo?: string;
  private _reconciling: Promise<void> = Promise.resolve();
  private _reconcileTimer?: ReturnType<typeof setTimeout>;
  private _driftTimer?: ReturnType<typeof setInterval>;
  private _selfCheckTimer?: ReturnType<typeof setTimeout>;
  private _aloneTimer?: ReturnType<typeof setTimeout>;
  /** Since when this node knows no peer and no hub; undefined otherwise. */
  private _aloneSince?: number;
  /** Whether it has been alone for `aloneHubMs` and acts as its own hub. */
  private _actingAlone = false;
  private readonly _retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Members whose start on the current hub failed so far. */
  private readonly _failing = new Set<string>();
  /** The hub each member was last started on, until it is stopped. */
  private readonly _startedOn = new Map<string, string>();
  private readonly _listeners = new Map<string, Set<NodeListener>>();

  // ...........................................................................
  /**
   * Creates a node. Nothing runs before {@link start}.
   * @param _config - Domain, port, hub, members, peer reads.
   * @param _deps - The transport.
   */
  constructor(
    private readonly _config: NodeConfig,
    private readonly _deps: NodeDeps,
  ) {
    this._logger = _config.logger ?? noopLogger;
    for (const member of _config.members ?? []) {
      if (this._members.has(member.treeKey)) {
        throw new Error(`Two members for route ${member.treeKey}`);
      }
      this._members.set(member.treeKey, member);
    }
    const network = _config.network ?? {};
    const networkConfig: NetworkConfig = {
      // Anything else the app puts there travels on to the network manager.
      ...network,
      domain: _config.domain,
      port: _config.port,
      identityDir: _config.identityDir,
      broadcast: network.broadcast ?? { enabled: true, port: 41234 },
      cloud: network.cloud ?? { enabled: false, endpoint: '' },
      static: network.static ?? {},
      probing: { enabled: true, ...network.probing, listen: false },
    };
    this._networkManager = new NetworkManager(
      networkConfig,
      _deps.networkManagerOptions,
    );
  }

  // ...........................................................................
  // Lifecycle
  // ...........................................................................

  /**
   * Starts the node: identity, hub service, port, network — then the members
   * follow the elected hub.
   */
  async start(): Promise<void> {
    if (this._running) return;

    const identity = await NodeIdentity.create({
      domain: this._config.domain,
      port: this._config.port,
      identityDir: this._config.identityDir,
    });
    this._nodeId = identity.nodeId;

    await this._openPort();

    this._running = true;
    this._aloneSince = undefined;
    this._actingAlone = false;
    this._networkManager.on('role-changed', this._onRoleChanged);
    this._networkManager.on('hub-changed', this._onTopologyEvent);
    this._networkManager.on('topology-changed', this._onTopologyEvent);
    await this._networkManager.start();

    const driftCheckMs = this._config.driftCheckMs ?? 30_000;
    if (driftCheckMs > 0) {
      this._driftTimer = setInterval(() => {
        if (this._targetHubAddress() !== this._hubAddress) {
          this._logger.warn('Node', 'Members drifted from the hub', {
            connectedTo: this._hubAddress,
            elected: this._targetHubAddress(),
          });
          void this._queueReconcile();
        }
      }, driftCheckMs);
      this._driftTimer.unref?.();
    }

    // A hub already known now is followed before start() returns. A move
    // that fails is logged and tried again after `retryMs`; it does not fail
    // the start.
    await this._queueReconcile().catch(() =>
      this._scheduleReconcile(this._config.retryMs ?? 3000),
    );
    this._trackAlone();
  }

  // ...........................................................................
  /**
   * Stops the node: members, port, hub service, network.
   */
  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    clearTimeout(this._reconcileTimer);
    clearInterval(this._driftTimer);
    clearTimeout(this._aloneTimer);
    this._clearSelfCheck();
    this._clearRetries();
    this._networkManager.off('role-changed', this._onRoleChanged);
    this._networkManager.off('hub-changed', this._onTopologyEvent);
    this._networkManager.off('topology-changed', this._onTopologyEvent);
    await this._reconciling;

    for (const member of this._members.values()) {
      try {
        await member.close();
      } catch (error) {
        this._logger.error('Node', 'Member close failed', error, {
          treeKey: member.treeKey,
        });
      }
    }
    await this._closePort();
    await this._networkManager.stop();
    this._hubAddress = undefined;
    this._emit('stopped');
  }

  // ...........................................................................
  // State
  // ...........................................................................

  /** This node's id; undefined before the first start. */
  get nodeId(): string | undefined {
    return this._nodeId;
  }

  /**
   * This node's role: as the network decided it — or `'hub'` while it acts
   * as its own hub, alone (see {@link NodeConfig.aloneHubMs}).
   */
  get role(): NodeRole {
    const topology = this._networkManager.getTopology();
    return this._isAloneHub(topology) ? 'hub' : topology.myRole;
  }

  /** The network topology right now. */
  get topology(): NetworkTopology {
    return this._networkManager.getTopology();
  }

  /** The network manager. */
  get networkManager(): NetworkManager {
    return this._networkManager;
  }

  /**
   * The hub service: every route's server. Undefined before the first start;
   * while the port is closed, a torn-down one without servers.
   */
  get hubRoutes(): HubRoutes | undefined {
    return this._hub;
  }

  /** The hub the members connect to, as `ip:port`. */
  get hubAddress(): string | undefined {
    return this._hubAddress;
  }

  /** The members, by tree key. */
  get members(): ReadonlyMap<string, RouteMember> {
    return this._members;
  }

  /** Whether the node runs. */
  get isRunning(): boolean {
    return this._running;
  }

  // ...........................................................................
  // Port
  // ...........................................................................

  /** Whether the port and the hub service are open. */
  get isPortOpen(): boolean {
    return this._transport !== undefined;
  }

  /**
   * Takes the node off the network the way a crash looks from outside: its
   * port and its hub service close, so no probe, route client or peer
   * reaches it. Its members stay and follow whichever hub the network elects
   * next. For tests of a hub that went down.
   */
  async closePort(): Promise<void> {
    if (!this._running) return;
    await this._closePort();
  }

  /** Opens the port and the hub service again after {@link closePort}. */
  async openPort(): Promise<void> {
    if (!this._running || this._transport) return;
    await this._openPort();
  }

  // ...........................................................................
  // Members
  // ...........................................................................

  /**
   * Adds a route this node takes part in from now on. While the node runs and
   * knows its hub, the member starts on it right away.
   * @param member - The member.
   */
  async addMember(member: RouteMember): Promise<void> {
    if (this._members.has(member.treeKey)) {
      throw new Error(`Two members for route ${member.treeKey}`);
    }
    this._members.set(member.treeKey, member);
    await this._serializeMove(async () => {
      const hubAddress = this._hubAddress;
      if (!this._running || hubAddress === undefined) return;
      // A move queued before this one has started it already: a second start
      // would only stop it and start it again.
      if (this._startedOn.get(member.treeKey) !== hubAddress) {
        await this._startMember(member, hubAddress);
      }
      this._followIfMoved(hubAddress);
    });
  }

  /**
   * Leaves a route: its member stops and is closed.
   * @param treeKey - The route's tree key.
   * @returns Whether the node had a member for it.
   */
  async removeMember(treeKey: string): Promise<boolean> {
    const member = this._members.get(treeKey);
    if (!member) return false;
    this._members.delete(treeKey);
    this._failing.delete(treeKey);
    this._startedOn.delete(treeKey);
    clearTimeout(this._retryTimers.get(treeKey));
    this._retryTimers.delete(treeKey);
    await this._serializeMove(async () => {
      try {
        await member.close();
      } catch (error) {
        this._logger.error('Node', 'Member close failed', error, { treeKey });
      }
    });
    return true;
  }

  // ...........................................................................
  // Events
  // ...........................................................................

  /**
   * Subscribes to an event.
   * @param event - The event.
   * @param listener - The listener.
   */
  on<E extends NodeEventName>(event: E, listener: NodeEvents[E]): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener as NodeListener);
  }

  /**
   * Unsubscribes from an event.
   * @param event - The event.
   * @param listener - The listener.
   */
  off<E extends NodeEventName>(event: E, listener: NodeEvents[E]): void {
    this._listeners.get(event)?.delete(listener as NodeListener);
  }

  // ######################
  // Private
  // ######################

  /**
   * Opens the hub service and the port; a port that cannot open closes the
   * hub service again.
   */
  private async _openPort(): Promise<void> {
    const hub = new HubRoutes({ ...this._config.hub, logger: this._logger });
    await hub.init();
    let transport: PortTransport;
    try {
      transport = await this._deps.createPortTransport(this._config.port);
    } catch (error) {
      await hub.tearDown();
      throw error;
    }
    this._hub = hub;
    this._transport = transport;
    transport.accept((handshake) => this._accepts(handshake));
    transport.onConnection((socket, handshake) => {
      void this._onConnection(socket, handshake);
    });
  }

  // ...........................................................................
  /** Closes the port and the hub service, if open. */
  private async _closePort(): Promise<void> {
    const transport = this._transport;
    if (!transport) return;
    this._transport = undefined;
    await transport.close();
    await (this._hub as HubRoutes).tearDown();
  }

  // ...........................................................................
  /**
   * Whether the port accepts a connection: peers always, route clients only
   * while this node is hub.
   * @param handshake - What the connection says about itself.
   * @returns True to accept.
   */
  private _accepts(handshake: PortHandshake): boolean {
    return handshake.peerRead === true || this.role === 'hub';
  }

  // ...........................................................................
  /**
   * Hands an accepted connection to a member — a peer — or to the hub.
   * @param socket - The connection.
   * @param handshake - What it says about itself.
   */
  private async _onConnection(
    socket: SocketLike,
    handshake: PortHandshake,
  ): Promise<void> {
    if (handshake.peerRead) {
      const member = this._members.get(handshake.treeKeys?.[0] ?? '');
      if (!member) {
        Node._disconnect(socket);
        return;
      }
      try {
        await member.servePeer(socket);
      } catch (error) {
        this._logger.error('Node', 'Serving a peer failed', error, {
          treeKey: member.treeKey,
        });
        Node._disconnect(socket);
      }
      return;
    }

    // A transport that cannot refuse in its handshake still has this.
    if (!this._accepts(handshake)) {
      Node._disconnect(socket);
      return;
    }
    try {
      await (this._hub as HubRoutes).addSocket(socket, handshake.treeKeys);
    } catch (error) {
      this._logger.error('Node', 'Adding a route client failed', error, {
        treeKeys: handshake.treeKeys,
      });
      Node._disconnect(socket);
    }
  }

  // ...........................................................................
  /**
   * The role changed: tell the app, check the new hub, move the members.
   * @param event - The change.
   */
  private readonly _onRoleChanged = (event: RoleChangedEvent): void => {
    this._logger.info('Node', `Role ${event.previous} → ${event.current}`);
    this._emit('role-changed', event);
    this._clearSelfCheck();
    if (event.current === 'hub') this._startSelfCheck();
    this._scheduleReconcile();
  };

  // ...........................................................................
  /** The hub or the topology changed: move the members once it settled. */
  private readonly _onTopologyEvent = (): void => {
    this._trackAlone();
    this._scheduleReconcile();
  };

  // ...........................................................................
  /**
   * Notes when this node starts being alone — no peer, no hub — and moves
   * the members once it has been alone for `aloneHubMs`.
   */
  private _trackAlone(): void {
    const aloneHubMs = this._config.aloneHubMs ?? 12_000;
    const topology = this._networkManager.getTopology();
    if (aloneHubMs <= 0 || !this._isAlone(topology)) {
      this._aloneSince = undefined;
      this._actingAlone = false;
      clearTimeout(this._aloneTimer);
      return;
    }
    if (this._aloneSince !== undefined) return;
    this._aloneSince = Date.now();
    clearTimeout(this._aloneTimer);
    // The timer decides, not a clock comparison: a timer may fire a
    // millisecond before the measured time has passed.
    this._aloneTimer = setTimeout(() => {
      this._actingAlone = true;
      this._logger.info('Node', 'No peer and no hub: acting as its own hub', {
        aloneMs: aloneHubMs,
      });
      void this._queueReconcile();
    }, aloneHubMs);
    this._aloneTimer.unref?.();
  }

  // ...........................................................................
  /**
   * Whether this node knows no peer and the network names no hub.
   * @param topology - The topology.
   * @returns True while alone.
   */
  private _isAlone(topology: NetworkTopology): boolean {
    if (topology.myRole === 'hub' || topology.myRole === 'client') return false;
    return Object.keys(topology.nodes).every((id) => id === this._nodeId);
  }

  // ...........................................................................
  /**
   * Whether this node acts as its own hub: alone for `aloneHubMs` at least.
   * @param topology - The topology.
   * @returns True while it does.
   */
  private _isAloneHub(topology: NetworkTopology): boolean {
    return this._actingAlone && this._isAlone(topology);
  }

  // ...........................................................................
  /**
   * Moves the members after a settling time; a new call restarts the wait.
   * @param delayMs - The settling time.
   */
  private _scheduleReconcile(
    delayMs = this._config.reconnectDelayMs ?? 1500,
  ): void {
    clearTimeout(this._reconcileTimer);
    this._reconcileTimer = setTimeout(() => {
      this._reconcileTimer = undefined;
      this._abortStaleMove();
      void this._queueReconcile();
    }, delayMs);
  }

  // ...........................................................................
  /**
   * The hub moved again while members are still being moved to the last
   * one: stop them now — a member still connecting gives up at once — rather
   * than wait for each connect to fail on its own.
   */
  private _abortStaleMove(): void {
    const target = this._targetHubAddress();
    const movingTo = this._movingTo;
    if (movingTo === undefined || target === undefined || target === movingTo) {
      return;
    }
    this._logger.info('Node', 'The hub moved again during a move', {
      movingTo,
      elected: target,
    });
    for (const member of this._members.values()) {
      void this._stopMember(member);
    }
  }

  // ...........................................................................
  /**
   * Moves the members, after any move still running.
   * @returns Settles when this move is done.
   */
  private _queueReconcile(): Promise<void> {
    return this._serializeMove(() => this._reconcile());
  }

  // ...........................................................................
  /**
   * Runs a change of the members after every move and change before it.
   * @param change - The change.
   * @returns Settles when the change is done.
   */
  private _serializeMove(change: () => Promise<void>): Promise<void> {
    const next = this._reconciling.then(change);
    this._reconciling = next.catch((error) => {
      this._logger.error('Node', 'Changing the members failed', error);
    });
    return next;
  }

  // ...........................................................................
  /** Moves every member to the elected hub, if it moved. */
  private async _reconcile(): Promise<void> {
    if (!this._running) return;
    const target = this._targetHubAddress();
    if (target === undefined || target === this._hubAddress) return;

    const previous = this._hubAddress;
    this._hubAddress = target;
    this._clearRetries();
    this._logger.info('Node', 'Members move to the hub', {
      previous,
      current: target,
    });
    this._emit('hub-changed', { previous, current: target });

    this._movingTo = target;
    for (const member of this._members.values()) {
      await this._stopMember(member);
    }
    this._failing.clear();
    for (const member of this._members.values()) {
      await this._startMember(member, target);
    }
    this._movingTo = undefined;
    if (this._failing.size === 0) this._emit('ready');

    this._followIfMoved(target);
  }

  // ...........................................................................
  /**
   * The network may have moved on while members were starting, without a
   * word — an event that landed before anybody listened: move again.
   * @param hubAddress - The hub the members were started on.
   */
  private _followIfMoved(hubAddress: string): void {
    if (this._targetHubAddress() !== hubAddress) this._scheduleReconcile();
  }

  // ...........................................................................
  /**
   * The hub the members should connect to: this node over loopback while it
   * is hub, else the elected hub's address.
   * @returns `ip:port`, or undefined while no hub is known.
   */
  private _targetHubAddress(): string | undefined {
    const topology = this._networkManager.getTopology();
    if (topology.myRole === 'hub' || this._isAloneHub(topology)) {
      return `127.0.0.1:${this._config.port}`;
    }
    if (topology.myRole === 'client') return topology.hubAddress ?? undefined;
    return undefined;
  }

  // ...........................................................................
  /**
   * Starts a member on a hub; on failure, tries again after `retryMs` while
   * the hub stays the same.
   * @param member - The member.
   * @param hubAddress - The hub.
   * @returns Whether it started.
   */
  private async _startMember(
    member: RouteMember,
    hubAddress: string,
  ): Promise<boolean> {
    this._startedOn.set(member.treeKey, hubAddress);
    try {
      await member.start(this._memberContext(member.treeKey, hubAddress));
      this._failing.delete(member.treeKey);
      return true;
    } catch (error) {
      this._failing.add(member.treeKey);
      this._logger.error('Node', 'Member start failed', error, {
        treeKey: member.treeKey,
        hubAddress,
      });
      const timer = setTimeout(() => {
        this._retryTimers.delete(member.treeKey);
        if (!this._running || this._hubAddress !== hubAddress) return;
        void this._serializeMove(async () => {
          if (!this._running || this._hubAddress !== hubAddress) return;
          if (await this._startMember(member, hubAddress)) {
            this._logger.info('Node', 'Member started on retry', {
              treeKey: member.treeKey,
            });
            // The last one that was missing: every member runs now.
            if (this._failing.size === 0) this._emit('ready');
          }
        });
      }, this._config.retryMs ?? 3000);
      this._retryTimers.set(member.treeKey, timer);
      return false;
    }
  }

  // ...........................................................................
  /**
   * Stops a member; a failure is logged, never thrown.
   * @param member - The member.
   */
  private async _stopMember(member: RouteMember): Promise<void> {
    this._startedOn.delete(member.treeKey);
    try {
      await member.stop();
    } catch (error) {
      this._logger.error('Node', 'Member stop failed', error, {
        treeKey: member.treeKey,
      });
    }
  }

  // ...........................................................................
  /**
   * What a member gets to start with.
   * @param treeKey - The member's route.
   * @param hubAddress - The hub.
   * @returns The context.
   */
  private _memberContext(
    treeKey: string,
    hubAddress: string,
  ): RouteMemberContext {
    return {
      treeKey,
      route: Route.fromFlat(`/${treeKey}`),
      nodeId: this._nodeId as string,
      hubAddress,
      connectHub: (signal) =>
        this._deps.connectHub
          ? this._deps.connectHub(hubAddress, { treeKey, signal })
          : Promise.reject(
              new Error('This node opens no hub connections (connectHub)'),
            ),
      ...this._peerReads(treeKey),
      logger: this._logger,
    };
  }

  // ...........................................................................
  /**
   * Peer reads of a member's route, while they are on.
   * @param treeKey - The route.
   * @returns The member's peer reads, or nothing.
   */
  private _peerReads(treeKey: string): { peerReads?: RoutePeerReads } {
    const bounds = this._config.peerReads;
    const connectPeer = this._deps.connectPeer;
    if (!bounds || !connectPeer) return {};
    const resolve = (nodeId: string): string | undefined => {
      if (nodeId === this._nodeId) return undefined;
      // The hub is asked anyway: a second connection to it gains nothing.
      if (nodeId === this._networkManager.getTopology().hubNodeId) {
        return undefined;
      }
      return this._networkManager.resolvePeerAddress(nodeId) ?? undefined;
    };
    return {
      peerReads: {
        bounds,
        resolve,
        connect: async (nodeId, signal) => {
          const address = resolve(nodeId);
          if (address === undefined) return undefined;
          return connectPeer(address, { treeKey, signal });
        },
      },
    };
  }

  // ...........................................................................
  /** Arms the hub self-check. */
  private _startSelfCheck(): void {
    const ms = this._config.hubSelfCheckMs ?? 20_000;
    if (ms <= 0) return;
    this._selfCheckTimer = setTimeout(() => {
      this._selfCheckTimer = undefined;
      this._runSelfCheck(ms);
    }, ms);
    this._selfCheckTimer.unref?.();
  }

  // ...........................................................................
  /** Disarms the hub self-check. */
  private _clearSelfCheck(): void {
    clearTimeout(this._selfCheckTimer);
    this._selfCheckTimer = undefined;
  }

  // ...........................................................................
  /**
   * A hub no other node reached while other nodes exist cannot take
   * connections — a firewall, a wrong network profile. It steps down: it
   * excludes itself from the election for a while and hands the hub to the
   * longest-running peer the probes reached.
   *
   * Only other nodes count. This node's own members connect over loopback,
   * so they would make every hub look reachable.
   * @param ms - The self-check interval.
   */
  private _runSelfCheck(ms: number): void {
    // The timer is cleared on every role change and on stop.
    /* v8 ignore if -- @preserve */
    if (!this._running || this.role !== 'hub') return;
    const others = (this._hub as HubRoutes).connectedNodes.filter(
      (nodeId) => nodeId !== this._nodeId,
    );
    const topology = this._networkManager.getTopology();
    const peers = Object.keys(topology.nodes).filter(
      (nodeId) => nodeId !== this._nodeId,
    );
    if (others.length > 0 || peers.length === 0) {
      this._startSelfCheck();
      return;
    }

    this._logger.warn('Node', 'Hub self-check failed: no node reached us', {
      peers: peers.length,
    });
    this._networkManager.excludeFromElection(this._nodeId as string, ms * 3);
    const reachable = new Set(
      this._networkManager
        .getProbeScheduler()
        .getProbes()
        .filter((probe) => probe.reachable)
        .map((probe) => probe.toNodeId),
    );
    const candidate = Object.values(topology.nodes)
      .filter((node) => reachable.has(node.nodeId))
      .sort((a, b) => a.startedAt - b.startedAt)[0];
    if (candidate) {
      this._logger.info('Node', 'Handing the hub on', {
        nodeId: candidate.nodeId,
      });
      this._networkManager.assignHub(candidate.nodeId);
    } else {
      this._logger.warn('Node', 'No reachable peer to hand the hub to');
    }
  }

  // ...........................................................................
  /** Cancels every pending member retry. */
  private _clearRetries(): void {
    for (const timer of this._retryTimers.values()) clearTimeout(timer);
    this._retryTimers.clear();
  }

  // ...........................................................................
  /**
   * Calls the listeners of an event.
   * @param event - The event.
   * @param args - Its arguments.
   */
  private _emit(event: NodeEventName, ...args: unknown[]): void {
    for (const listener of [...(this._listeners.get(event) ?? [])]) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (error) {
        this._logger.error('Node', `Listener of ${event} failed`, error);
      }
    }
  }

  // ...........................................................................
  /**
   * Disconnects every socket of a connection.
   * @param socket - The connection.
   */
  private static _disconnect(socket: SocketLike): void {
    for (const s of new Set(Object.values(normalizeSocketBundle(socket)))) {
      s.disconnect();
    }
  }
}
