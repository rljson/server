// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Io, IoMem } from '@rljson/io';
import type {
  NetworkConfig,
  NetworkManagerOptions,
  NetworkTopology,
  NodeRole,
  RoleChangedEvent,
} from '@rljson/network';
import { NetworkManager } from '@rljson/network';
import { Route } from '@rljson/rljson';

import { Client, type ClientOptions } from './client.ts';
import type { ServerLogger } from './logger.ts';
import { noopLogger } from './logger.ts';
import { Server, type ServerOptions } from './server.ts';
import type { SocketLike } from './socket-bundle.ts';

// .............................................................................

/**
 * Transport handle returned by {@link CreateHubTransport}.
 *
 * Abstracts the "server side" of the transport layer so the Node class
 * can accept incoming connections without knowing whether Socket.IO,
 * WebSocket, or mock sockets are being used.
 */
export interface HubTransport {
  /** Register a callback for incoming client connections. */
  onConnection: (callback: (socket: SocketLike) => void) => void;
  /** Shut down the transport (close HTTP server, etc.). */
  close: () => Promise<void>;
}

/**
 * Factory that creates a hub-side transport (e.g. HTTP + Socket.IO server).
 * Called when this node becomes the hub.
 */
export type CreateHubTransport = (port: number) => Promise<HubTransport>;

/**
 * Factory that creates a client-side socket to connect to the hub.
 * Called when this node becomes a client.
 * @param hubAddress - The hub's address in `"ip:port"` format.
 * @param signal - Optional {@link AbortSignal}. When aborted, the factory
 *   should disconnect any in-progress socket and reject with an error.
 *   Implementations that ignore the signal still work — the Node will
 *   simply wait for the promise to settle before proceeding.
 */
export type CreateClientTransport = (
  hubAddress: string,
  signal?: AbortSignal,
) => Promise<SocketLike>;

/**
 * Injectable dependencies for the Node class.
 */
export interface NodeDeps {
  /** Factory to create hub-side transport. */
  createHubTransport: CreateHubTransport;
  /** Factory to create client-side socket to hub. */
  createClientTransport: CreateClientTransport;
  /** Options passed to NetworkManager (e.g. mock probe function). */
  networkManagerOptions?: NetworkManagerOptions;
  /**
   * Optional factory for application-level agents (e.g. FsAgent).
   * Called on every `ready` event. The returned handle's `stop()`
   * is called before the next role transition or on `node.stop()`.
   */
  createAgent?: CreateAgent;
}

/**
 * Configuration for a self-organizing Node.
 */
export interface NodeConfig {
  /** Network domain for peer discovery. */
  domain: string;
  /** Port for this node's hub server / probing. */
  port: number;
  /** Data route for Server/Client sync. */
  route: Route;
  /** Full network configuration (broadcast, cloud, static, probing). */
  network?: Partial<NetworkConfig>;
  /** Options forwarded to the Server constructor. */
  serverOptions?: ServerOptions;
  /** Options forwarded to the Client constructor. */
  clientOptions?: ClientOptions;
  /** Logger shared across Node, Server, and Client. */
  logger?: ServerLogger;
  /** Directory for persistent node identity. */
  identityDir?: string;
}

// .............................................................................

/**
 * Context passed to the `ready` event and to {@link CreateAgent}.
 */
export interface ReadyContext {
  /** The node's current role. */
  role: NodeRole;
  /** The Client instance (defined when role is `'client'`). */
  client?: Client;
  /** The Server instance (defined when role is `'hub'`). */
  server?: Server;
  /** The socket used to connect to the hub (defined when role is `'client'`). */
  socket?: SocketLike;
}

/**
 * Handle returned by {@link CreateAgent}.
 * Node calls `stop()` before every role transition and on `node.stop()`.
 */
export interface AgentHandle {
  stop: () => Promise<void> | void;
}

/**
 * Factory called after each role transition to wire application-level agents
 * (e.g. FsAgent). Return an {@link AgentHandle} whose `stop()` will be called
 * before the next role transition or when the node stops.
 */
export type CreateAgent = (context: ReadyContext) => Promise<AgentHandle>;

/** Events emitted by Node. */
export interface NodeEvents {
  /** Emitted when the node has assumed its role and is ready. */
  ready: (context: ReadyContext) => void;
  /** Emitted when the node's role changes. */
  'role-changed': (event: RoleChangedEvent) => void;
  /** Emitted when the node is stopped. */
  stopped: () => void;
}

/** Valid event names for Node. */
export type NodeEventName = keyof NodeEvents;

type NodeListener = NodeEvents[NodeEventName];

// .............................................................................

/**
 * Self-organizing node that automatically transitions between
 * hub (Server) and client (Client) roles based on network topology.
 */
export class Node {
  private _networkManager: NetworkManager;
  private _server?: Server;
  private _client?: Client;
  private _hubTransport?: HubTransport;
  private _clientSocket?: SocketLike;
  private _agentHandle?: AgentHandle;
  private _ioMem?: IoMem;
  private _bsMem?: BsMem;
  private _role: NodeRole = 'unassigned';
  private _running = false;
  private _transportReady = false;
  private _transitioning?: Promise<void>;
  private _transitionGen = 0;
  private _sleepTimer?: ReturnType<typeof setTimeout>;
  private _sleepResolve?: () => void;
  private _connectAbort?: AbortController;
  private _listeners = new Map<string, Set<NodeListener>>();
  private readonly _logger: ServerLogger;

  constructor(
    private readonly _config: NodeConfig,
    private readonly _deps: NodeDeps,
  ) {
    this._logger = _config.logger ?? noopLogger;

    const networkConfig: NetworkConfig = {
      domain: _config.domain,
      port: _config.port,
      identityDir: _config.identityDir,
      broadcast: _config.network?.broadcast ?? {
        enabled: true,
        port: 41234,
      },
      cloud: _config.network?.cloud ?? { enabled: false, endpoint: '' },
      static: _config.network?.static ?? {},
      probing: _config.network?.probing ?? { enabled: true },
    };

    this._networkManager = new NetworkManager(
      networkConfig,
      _deps.networkManagerOptions,
    );
  }

  // .........................................................................
  // Lifecycle
  // .........................................................................

  /**
   * Start the node. Begins network discovery and role assignment.
   */
  async start(): Promise<void> {
    if (this._running) return;

    this._ioMem = new IoMem();
    await this._ioMem.init();
    await this._ioMem.isReady();

    this._bsMem = new BsMem();

    this._running = true;
    this._networkManager.on('role-changed', this._onRoleChanged);
    this._networkManager.on('hub-changed', this._onHubChanged);

    await this._networkManager.start();
  }

  /**
   * Stop the node. Tears down Server/Client and network discovery.
   */
  async stop(): Promise<void> {
    if (!this._running) return;

    this._running = false;
    this._transportReady = false;
    this._cancelRetry();
    this._networkManager.off('role-changed', this._onRoleChanged);
    this._networkManager.off('hub-changed', this._onHubChanged);

    // Wait for any in-flight role transition to finish
    if (this._transitioning) {
      await this._transitioning;
      this._transitioning = undefined;
    }

    await this._tearDownCurrentRole();
    await this._networkManager.stop();

    this._role = 'unassigned';
    this._emit('stopped');
  }

  // .........................................................................
  // State
  // .........................................................................

  /** This node's current role. */
  get role(): NodeRole {
    return this._role;
  }

  /** Current network topology snapshot. */
  get topology(): NetworkTopology {
    return this._networkManager.getTopology();
  }

  /** The Io instance (from Server or Client), or undefined if unassigned. */
  get io(): Io | undefined {
    return this._server?.io ?? this._client?.io;
  }

  /** The Bs instance (from Server or Client), or undefined if unassigned. */
  get bs(): Bs | undefined {
    return this._server?.bs ?? this._client?.bs;
  }

  /** The Server instance when this node is the hub, or undefined. */
  get server(): Server | undefined {
    return this._server;
  }

  /** The Client instance when this node is a client, or undefined. */
  get client(): Client | undefined {
    return this._client;
  }

  /** The socket used to connect to the hub (defined when role is `'client'`). */
  get socket(): SocketLike | undefined {
    return this._clientSocket;
  }

  /** Whether the node is currently running. */
  get isRunning(): boolean {
    return this._running;
  }

  /**
   * Whether the node's transport is fully ready.
   * `false` during role transitions and before the first transition completes.
   * `true` only after `_becomeHub()` or `_becomeClient()` has finished.
   */
  get isTransportReady(): boolean {
    return this._transportReady;
  }

  /** The underlying NetworkManager. */
  get networkManager(): NetworkManager {
    return this._networkManager;
  }

  // .........................................................................
  // Events
  // .........................................................................

  /**
   * Subscribe to node events.
   * @param event - Event name
   * @param cb - Callback
   */
  on<E extends NodeEventName>(event: E, cb: NodeEvents[E]): void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb as NodeListener);
  }

  /**
   * Unsubscribe from node events.
   * @param event - Event name
   * @param cb - Callback
   */
  off<E extends NodeEventName>(event: E, cb: NodeEvents[E]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(cb as NodeListener);
  }

  // .........................................................................
  // Role transitions
  // .........................................................................

  /**
   * Handle hub-changed while role stays 'client'.
   * When NetworkManager emits hub-changed but NOT role-changed (because
   * old role === new role === 'client'), the Node must tear down the old
   * client connection and reconnect to the new hub.
   */
  private _onHubChanged = (): void => {
    if (!this._running || this._role !== 'client') return;

    // Only act if the NetworkManager still considers us a client.
    // If a role-changed is also coming, _onRoleChanged will handle it.
    const topology = this._networkManager.getTopology();
    /* v8 ignore if -- @preserve */
    if (topology.myRole !== 'client') return;

    this._logger.info('Node', 'Hub changed while client — reconnecting');
    // Cancel any in-flight retry sleep so the old transition finishes fast.
    this._cancelRetry();
    /* v8 ignore next -- @preserve */
    const prev = this._transitioning ?? Promise.resolve();
    this._transitioning = prev.then(async () => {
      if (!this._running || this._role !== 'client') return;
      this._transportReady = false;
      await this._tearDownCurrentRole();
      await this._becomeClient();
    });
  };

  private _onRoleChanged = (event: RoleChangedEvent): void => {
    // Unreachable: stop() removes this listener synchronously before
    // any further events can fire from NetworkManager.
    /* v8 ignore if -- @preserve */
    if (!this._running) return;

    const { current } = event;

    // During rapid role changes, NM may emit a role that matches the
    // Node's current _role (e.g. client→hub→client fires 'client' while
    // _role is still 'client' because the hub transition is queued).
    if (current === this._role) return;

    // Cancel any in-flight retry sleep so the old transition finishes fast.
    this._cancelRetry();

    // Serialize transitions — wait for any in-flight transition to finish
    // before starting the next one.
    const prev = this._transitioning ?? Promise.resolve();
    this._transitioning = prev.then(() => this._performTransition(event));
  };

  private async _performTransition(event: RoleChangedEvent): Promise<void> {
    if (!this._running) return;

    const { current } = event;

    // A queued transition becomes stale when an earlier transition in the
    // queue already established this role (e.g. two hub transitions
    // queued during rapid flapping — the second is a no-op).
    if (current === this._role) return;

    this._transportReady = false;

    this._logger.info('Node', `Role changing: ${this._role} → ${current}`);

    // Tear down current role
    await this._tearDownCurrentRole();

    this._role = current;
    this._emit('role-changed', event);

    // Set up new role
    switch (current) {
      case 'hub':
        await this._becomeHub();
        break;
      case 'client':
        await this._becomeClient();
        break;
      /* v8 ignore next -- @preserve */
      default:
        break;
    }

    // The async teardown+setup above may have taken long enough for the
    // NetworkManager to change its mind (e.g. a probe cycle fired during
    // _becomeClient). If our new role no longer matches the network's
    // role, self-correct immediately. The staleness guard at the top of
    // this method prevents infinite recursion.
    /* v8 ignore if -- @preserve */
    if (!this._running) return;
    const networkRole = this._networkManager.getTopology().myRole;
    if (networkRole !== this._role && networkRole !== 'unassigned') {
      this._logger.info(
        'Node',
        `Reconciling stale role: node=${this._role} → network=${networkRole}`,
      );
      await this._performTransition({
        previous: this._role,
        current: networkRole,
      });
    }
  }

  private async _becomeHub(): Promise<void> {
    // Re-init IoMem after previous teardown closed it.
    // Data is preserved — IoMem.close() only sets _isOpen = false.
    await this._ioMem!.init();
    await this._ioMem!.isReady();

    this._server = new Server(this._config.route, this._ioMem!, this._bsMem!, {
      ...this._config.serverOptions,
      logger: this._logger,
    });
    await this._server.init();

    // Start transport to accept incoming connections
    try {
      this._hubTransport = await this._deps.createHubTransport(
        this._config.port,
      );
      this._hubTransport.onConnection(async (socket: SocketLike) => {
        if (!this._server) return;
        await this._server.addSocket(socket);
      });
      this._logger.info('Node', 'Now hub — accepting connections');
      this._transportReady = true;
    } catch (err) {
      this._logger.error(
        'Node',
        `Hub transport failed (no incoming connections): ${err}`,
      );
    }
    const ctx: ReadyContext = { role: 'hub', server: this._server };
    this._emit('ready', ctx);
    await this._startAgent(ctx);
  }

  private async _becomeClient(): Promise<void> {
    const maxRetries = 5;
    const gen = this._transitionGen;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (
        !this._running ||
        this._role !== 'client' ||
        gen !== this._transitionGen
      )
        return;

      const topology = this._networkManager.getTopology();
      const hubAddress = topology.hubAddress;

      /* v8 ignore next -- @preserve */
      this._logger.info(
        'Node',
        `_becomeClient attempt ${attempt}/${maxRetries}: ` +
          `hubAddress=${hubAddress ?? 'null'}, ` +
          `hubNodeId=${topology.hubNodeId?.slice(0, 8) ?? 'null'}`,
      );

      if (!hubAddress) {
        /* v8 ignore else -- @preserve */
        if (attempt < maxRetries) {
          const delay = 1000 * 2 ** attempt;
          this._logger.warn(
            'Node',
            `No hub address in topology — retrying in ${delay}ms ` +
              `(${attempt + 1}/${maxRetries})`,
          );
          await this._sleep(delay);
          continue;
        }
        /* v8 ignore start -- @preserve */
        this._logger.warn(
          'Node',
          'Cannot become client: no hub address after all retries',
        );
        return;
        /* v8 ignore stop -- @preserve */
      }

      try {
        this._connectAbort = new AbortController();
        this._clientSocket = await this._deps.createClientTransport(
          hubAddress,
          this._connectAbort.signal,
        );
        this._connectAbort = undefined;
      } catch (err) {
        this._connectAbort = undefined;
        // If gen changed while we were connecting, exit immediately.
        // The new transition will handle reconnection.
        if (gen !== this._transitionGen) return;
        /* v8 ignore else -- @preserve */
        if (attempt < maxRetries) {
          const delay = 1000 * 2 ** attempt;
          this._logger.warn(
            'Node',
            `Client transport to ${hubAddress} failed: ${err} — ` +
              `retrying in ${delay}ms (${attempt + 1}/${maxRetries})`,
          );
          await this._sleep(delay);
          continue;
        }
        /* v8 ignore start -- @preserve */
        this._logger.error(
          'Node',
          `Client transport to ${hubAddress} failed after all retries: ${err}`,
        );
        return;
        /* v8 ignore stop -- @preserve */
      }

      // Success — set up the rest of the client stack
      break;
    }

    // Abort if state changed during retries
    if (
      !this._running ||
      this._role !== 'client' ||
      gen !== this._transitionGen ||
      !this._clientSocket
    ) {
      return;
    }

    // Re-init IoMem after previous teardown closed it.
    // Data is preserved — IoMem.close() only sets _isOpen = false.
    await this._ioMem!.init();
    await this._ioMem!.isReady();

    this._client = new Client(
      this._clientSocket,
      this._ioMem!,
      this._bsMem!,
      this._config.route,
      {
        ...this._config.clientOptions,
        logger: this._logger,
      },
    );
    await this._client.init();

    this._logger.info(
      'Node',
      `Now client — connected to hub ${this._networkManager.getTopology().hubAddress}`,
    );

    this._transportReady = true;
    const ctx: ReadyContext = {
      role: 'client',
      client: this._client,
      socket: this._clientSocket,
    };
    this._emit('ready', ctx);
    await this._startAgent(ctx);
  }

  // .........................................................................
  // Internal
  // .........................................................................

  private async _tearDownCurrentRole(): Promise<void> {
    await this._stopAgent();

    if (this._server) {
      await this._server.tearDown();
      this._server = undefined;
    }

    if (this._hubTransport) {
      await this._hubTransport.close();
      this._hubTransport = undefined;
    }

    if (this._client) {
      await this._client.tearDown();
      this._client = undefined;
    }

    // Disconnect the client socket to prevent orphaned reconnection loops.
    // SocketLike may be a plain Socket (has disconnect()) or a
    // SocketNamespaceBundle (plain object). Guard accordingly.
    if (this._clientSocket && 'disconnect' in this._clientSocket) {
      (this._clientSocket as { disconnect: () => void }).disconnect();
    }
    this._clientSocket = undefined;
  }

  private async _startAgent(ctx: ReadyContext): Promise<void> {
    if (this._deps.createAgent) {
      try {
        this._agentHandle = await this._deps.createAgent(ctx);
      } catch (err) {
        this._logger.error('Node', `createAgent failed: ${err}`);
      }
    }
  }

  private async _stopAgent(): Promise<void> {
    if (this._agentHandle) {
      const handle = this._agentHandle;
      this._agentHandle = undefined;
      try {
        await handle.stop();
      } catch (err) {
        this._logger.error('Node', `Agent stop failed: ${err}`);
      }
    }
  }

  private _emit(event: string, ...args: unknown[]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this._sleepResolve = resolve;
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = undefined;
        this._sleepResolve = undefined;
        resolve();
      }, ms);
    });
  }

  private _cancelRetry(): void {
    this._transitionGen++;
    if (this._sleepTimer !== undefined) {
      clearTimeout(this._sleepTimer);
      this._sleepTimer = undefined;
    }
    if (this._sleepResolve) {
      this._sleepResolve();
      this._sleepResolve = undefined;
    }
    if (this._connectAbort) {
      this._connectAbort.abort();
      this._connectAbort = undefined;
    }
  }
}
