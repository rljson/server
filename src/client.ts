// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMulti, BsMultiBs, BsPeer, BsPeerBridge } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { Io, IoMulti, IoMultiIo, IoPeer, IoPeerBridge } from '@rljson/io';
import { ClientId, Route, SyncConfig } from '@rljson/rljson';

import { BaseNode } from './base-node.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import {
  normalizeSocketBundle,
  SocketLike,
  SocketNamespaceBundle,
} from './socket-bundle.ts';

/**
 * Options for the Client constructor.
 */
export interface ClientOptions {
  /** Logger instance for monitoring (defaults to NoopLogger). */
  logger?: ServerLogger;

  /**
   * Sync protocol configuration. When provided, the Connector created
   * by the client will use enriched payloads (sequence numbers, causal
   * ordering, ACK support, client identity).
   */
  syncConfig?: SyncConfig;

  /**
   * Stable client identity. When provided, this identity is passed
   * to the Connector. When omitted but `syncConfig.includeClientIdentity`
   * is true, a new identity is auto-generated.
   */
  clientIdentity?: ClientId;

  /**
   * Timeout in milliseconds for peer initialization during init().
   * If an Io or Bs peer does not respond within this window, init()
   * rejects. Defaults to 30 000 (30 s). Set to 0 to disable the timeout.
   */
  peerInitTimeoutMs?: number;
}

export class Client extends BaseNode {
  private _ioMultiIos: IoMultiIo[] = [];
  private _ioMulti?: IoMulti;

  private _bsMultiBss: BsMultiBs[] = [];
  private _bsMulti?: BsMulti;

  private _db?: Db;
  private _connector?: Connector;

  private _logger: ServerLogger;
  private _syncConfig?: SyncConfig;
  private _clientIdentity?: ClientId;
  private _peerInitTimeoutMs: number;

  // Connection state
  private _isConnected: boolean = true;
  private _disconnectCallbacks: Array<(reason: string) => void> = [];
  private _reconnectCallbacks: Array<() => void> = [];
  private _connectionCleanup?: () => void;

  // ...........................................................................
  /**
   * Creates a Client instance
   * @param _socketToServer - Socket or namespace bundle to connect to server
   * @param _localIo - Local Io for local storage
   * @param _localBs - Local Bs for local blob storage
   * @param _route - Optional route for automatic Db and Connector creation
   * @param options - Optional configuration including logger for monitoring
   */
  constructor(
    private _socketToServer: SocketLike,
    protected _localIo: Io,
    protected _localBs: Bs,
    private _route?: Route,
    options?: ClientOptions,
  ) {
    //Call BaseNode constructor
    super(_localIo);

    this._logger = options?.logger ?? noopLogger;
    this._syncConfig = options?.syncConfig;
    this._clientIdentity = options?.clientIdentity;
    this._peerInitTimeoutMs = options?.peerInitTimeoutMs ?? 30_000;

    this._logger.info('Client', 'Constructing client', {
      hasRoute: !!this._route,
      route: this._route?.flat,
    });
  }

  /**
   * Initializes Io and Bs multis and their peer bridges.
   * @returns The initialized Io implementation.
   */
  async init() {
    this._logger.info('Client', 'Initializing client');

    try {
      await this._setupIo();
      await this._setupBs();

      if (this._route) {
        this._setupDbAndConnector();
      }

      this._registerConnectionHandlers();

      await this.ready();

      this._logger.info('Client', 'Client initialized successfully', {
        hasRoute: !!this._route,
        hasDb: !!this._db,
        hasConnector: !!this._connector,
      });

      return this._ioMulti;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Client', 'Failed to initialize client', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Resolves once the Io implementation is ready.
   */
  async ready() {
    /* v8 ignore next -- @preserve */ if (this._ioMulti) {
      await this._ioMulti.isReady();
    }
  }

  /**
   * Closes client resources and clears internal state.
   */
  async tearDown() {
    this._logger.info('Client', 'Tearing down client');

    // Clean up connection handlers
    if (this._connectionCleanup) {
      this._connectionCleanup();
      this._connectionCleanup = undefined;
    }
    this._disconnectCallbacks = [];
    this._reconnectCallbacks = [];

    //Close Io
    /* v8 ignore else -- @preserve */
    if (this._ioMulti && this._ioMulti.isOpen) {
      this._ioMulti.close();
    }

    // Tear down connector (removes socket listeners and Db observers)
    this._connector?.tearDown();

    // Clear Bs layers (BsMulti has no close() yet — clear references so GC
    // can reclaim the inner BsPeer and BsPeerBridge instances).
    this._bsMultiBss = [];

    this._ioMultiIos = [];
    this._ioMulti = undefined;
    this._bsMulti = undefined;
    this._db = undefined;
    this._connector = undefined;

    this._logger.info('Client', 'Client torn down successfully');
  }

  /**
   * Returns the Io implementation.
   */
  get io(): Io | undefined {
    return this._ioMulti;
  }

  /**
   * Returns the Bs implementation.
   */
  get bs(): Bs | undefined {
    return this._bsMulti;
  }

  /**
   * Returns the Db instance (available when route was provided).
   */
  get db(): Db | undefined {
    return this._db;
  }

  /**
   * Returns the Connector instance (available when route was provided).
   */
  get connector(): Connector | undefined {
    return this._connector;
  }

  /**
   * Returns the route (if provided).
   */
  get route(): Route | undefined {
    return this._route;
  }

  /**
   * Returns the logger instance.
   */
  get logger(): ServerLogger {
    return this._logger;
  }

  /**
   * Whether the client is currently connected to the server.
   * Tracks socket-level connection state via `disconnect` and `connect` events.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Registers a callback that fires when the socket disconnects.
   * The callback receives the disconnect reason string.
   * @param callback - Invoked with the disconnect reason
   */
  onDisconnect(callback: (reason: string) => void): void {
    this._disconnectCallbacks.push(callback);
  }

  /**
   * Registers a callback that fires when the socket reconnects
   * after a previous disconnect.
   * @param callback - Invoked on reconnection
   */
  onReconnect(callback: () => void): void {
    this._reconnectCallbacks.push(callback);
  }

  /**
   * Creates Db and Connector from the route and IoMulti.
   * Called during init() when a route was provided.
   */
  private _setupDbAndConnector() {
    this._logger.info('Client', 'Setting up Db and Connector', {
      route: this._route!.flat,
    });

    this._db = new Db(this._ioMulti!);
    const socket = normalizeSocketBundle(this._socketToServer);
    this._connector = new Connector(
      this._db,
      this._route!,
      socket.ioUp,
      this._syncConfig,
      this._clientIdentity,
    );

    this._logger.info('Client', 'Db and Connector created');
  }

  /**
   * Registers socket-level disconnect/connect listeners.
   * Logs state transitions and invokes registered callbacks.
   * The `connect` callback only fires on RE-connections (not the initial connect).
   */
  private _registerConnectionHandlers() {
    const sockets = normalizeSocketBundle(this._socketToServer);
    const socket = sockets.ioUp;

    const disconnectHandler = (...args: unknown[]) => {
      const reason = typeof args[0] === 'string' ? args[0] : 'unknown';
      this._isConnected = false;
      this._logger.warn('Client', 'Disconnected from server', { reason });
      for (const cb of this._disconnectCallbacks) {
        /* v8 ignore start -- @preserve */
        try {
          cb(reason);
        } catch {
          // Ignore callback errors — one faulty callback must not break others
        }
        /* v8 ignore stop -- @preserve */
      }
    };

    const reconnectHandler = () => {
      /* v8 ignore else -- @preserve */
      if (!this._isConnected) {
        this._isConnected = true;
        this._logger.info('Client', 'Reconnected to server');
        for (const cb of this._reconnectCallbacks) {
          /* v8 ignore start -- @preserve */
          try {
            cb();
          } catch {
            // Ignore callback errors
          }
          /* v8 ignore stop -- @preserve */
        }
      }
    };

    socket.on('disconnect', disconnectHandler);
    socket.on('connect', reconnectHandler);

    this._connectionCleanup = () => {
      socket.off('disconnect', disconnectHandler);
      socket.off('connect', reconnectHandler);
    };
  }

  /**
   * Builds the Io multi with local and peer layers.
   */
  private async _setupIo() {
    this._logger.info('Client.Io', 'Setting up Io multi');

    try {
      const sockets = normalizeSocketBundle(this._socketToServer);

      // Add LocalIo to MultiIo
      this._ioMultiIos.push({
        io: this._localIo,
        dump: true,
        read: true,
        write: true,
        priority: 1,
      });

      // Upstream: let the server pull from client local Io
      const ioPeerBridge = new IoPeerBridge(this._localIo, sockets.ioUp);
      ioPeerBridge.start();
      this._logger.info('Client.Io', 'Io peer bridge started (upstream)');

      // Downstream: pull from server
      const ioPeer = await this._createIoPeer(sockets.ioDown);

      this._ioMultiIos.push({
        io: ioPeer,
        dump: false,
        read: true,
        write: false,
        priority: 2,
      });

      this._ioMulti = new IoMulti(this._ioMultiIos);
      await this._ioMulti.init();
      await this._ioMulti.isReady();

      this._logger.info('Client.Io', 'Io multi ready');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Client.Io', 'Failed to set up Io', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Builds the Bs multi with local and peer layers.
   */
  private async _setupBs() {
    this._logger.info('Client.Bs', 'Setting up Bs multi');

    try {
      const sockets = normalizeSocketBundle(this._socketToServer);

      // Add LocalBs to MultiBs
      this._bsMultiBss.push({
        bs: this._localBs,
        read: true,
        write: true,
        priority: 1,
      });

      // Upstream: let the server pull from client local Bs
      const bsPeerBridge = new BsPeerBridge(this._localBs, sockets.bsUp);
      bsPeerBridge.start();
      this._logger.info('Client.Bs', 'Bs peer bridge started (upstream)');

      // Downstream: pull from server
      const bsPeer = await this._createBsPeer(sockets.bsDown);

      this._bsMultiBss.push({
        bs: bsPeer,
        read: true,
        write: false,
        priority: 2,
      });

      this._bsMulti = new BsMulti(this._bsMultiBss);
      await this._bsMulti.init();

      this._logger.info('Client.Bs', 'Bs multi ready');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Client.Bs', 'Failed to set up Bs', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Creates and initializes a downstream Io peer.
   * @param socket - Downstream socket to the server Io namespace.
   */
  private async _createIoPeer(socket: SocketNamespaceBundle['ioDown']) {
    this._logger.info('Client.Io', 'Creating Io peer (downstream)');
    try {
      const ioPeer = new IoPeer(socket);
      await this._withTimeout(
        ioPeer.init().then(() => ioPeer.isReady()),
        'IoPeer init',
      );
      this._logger.info('Client.Io', 'Io peer created (downstream)');
      return ioPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error(
        'Client.Io',
        'Failed to create Io peer (downstream)',
        error,
      );
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Creates and initializes a downstream Bs peer.
   * @param socket - Downstream socket to the server Bs namespace.
   */
  private async _createBsPeer(socket: SocketNamespaceBundle['bsDown']) {
    this._logger.info('Client.Bs', 'Creating Bs peer (downstream)');
    try {
      const bsPeer = new BsPeer(socket);
      await this._withTimeout(bsPeer.init(), 'BsPeer init');
      this._logger.info('Client.Bs', 'Bs peer created (downstream)');
      return bsPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error(
        'Client.Bs',
        'Failed to create Bs peer (downstream)',
        error,
      );
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Returns the configured peer init timeout in milliseconds.
   */
  get peerInitTimeoutMs(): number {
    return this._peerInitTimeoutMs;
  }

  // ...........................................................................
  /**
   * Races a promise against a timeout. Resolves/rejects with the original
   * promise outcome if it settles first, or rejects with a timeout error.
   * @param promise - The promise to race.
   * @param label - Human-readable label for timeout error messages.
   */
  private _withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const ms = this._peerInitTimeoutMs;
    if (ms <= 0) return promise;

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        /* v8 ignore next -- @preserve */
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms,
      );
    });

    return Promise.race([promise, timeout]).finally(
      /* v8 ignore next -- @preserve */
      () => clearTimeout(timer),
    );
  }
}
