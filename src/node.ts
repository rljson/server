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
 */
export type CreateClientTransport = (hubAddress: string) => Promise<SocketLike>;

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
  private _transitioning?: Promise<void>;
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

    await this._networkManager.start();
  }

  /**
   * Stop the node. Tears down Server/Client and network discovery.
   */
  async stop(): Promise<void> {
    if (!this._running) return;

    this._running = false;
    this._networkManager.off('role-changed', this._onRoleChanged);

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
    const topology = this._networkManager.getTopology();
    const hubAddress = topology.hubAddress;

    if (!hubAddress) {
      this._logger.warn(
        'Node',
        'Cannot become client: no hub address in topology',
      );
      return;
    }

    try {
      this._clientSocket = await this._deps.createClientTransport(hubAddress);
    } catch (err) {
      this._logger.error(
        'Node',
        `Client transport to ${hubAddress} failed: ${err}`,
      );
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

    this._logger.info('Node', `Now client — connected to hub ${hubAddress}`);

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
}
