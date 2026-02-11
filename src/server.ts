// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem, BsMulti, BsMultiBs, BsPeer, BsServer } from '@rljson/bs';
import { ConnectorPayload } from '@rljson/db';
import {
  Io,
  IoMem,
  IoMulti,
  IoMultiIo,
  IoPeer,
  IoServer,
  Socket,
  SocketMock,
} from '@rljson/io';
import { Route } from '@rljson/rljson';

import { BaseNode } from './base-node.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import {
  normalizeSocketBundle,
  SocketLike,
  SocketNamespaceBundle,
} from './socket-bundle.ts';

export type SocketWithClientId = Socket & { __clientId?: string };

/**
 * Options for the Server constructor.
 */
export interface ServerOptions {
  /** Logger instance for monitoring (defaults to NoopLogger). */
  logger?: ServerLogger;

  /**
   * Interval in milliseconds for evicting stale multicast ref entries.
   * Uses a two-generation sweep: refs older than two intervals are discarded.
   * Defaults to 60 000 (60 s). Set to 0 to disable automatic eviction.
   */
  refEvictionIntervalMs?: number;

  /**
   * Timeout in milliseconds for peer initialization during addSocket().
   * If a peer does not respond within this window, addSocket() rejects.
   * Defaults to 30 000 (30 s). Set to 0 to disable the timeout.
   */
  peerInitTimeoutMs?: number;
}

// .............................................................................
export class Server extends BaseNode {
  // Map of connected clients
  // socket => Push: Send new Refs through Route
  // io => Pull: Read from Clients Io
  private _clients: Map<
    string,
    {
      ioUp: SocketWithClientId;
      ioDown: SocketWithClientId;
      bsUp: SocketWithClientId;
      bsDown: SocketWithClientId;
      io: IoPeer;
      bs: BsPeer;
    }
  > = new Map();

  private _ios: IoMultiIo[] = [];
  private _ioMulti: IoMulti;

  // Storage => Let Clients read from Servers Io
  private _ioServer: IoServer;

  private _bss: BsMultiBs[] = [];
  private _bsMulti: BsMulti;

  // Storage => Let Clients read from Servers Bs
  private _bsServer: BsServer;

  // Two-generation ref dedup: refs in current or previous are considered seen.
  // On each eviction tick, previous is discarded and current becomes previous.
  private _multicastedRefsCurrent: Set<string> = new Set();
  private _multicastedRefsPrevious: Set<string> = new Set();
  private _refEvictionTimer?: ReturnType<typeof setInterval>;

  private _refreshPromise?: Promise<void>;
  private _pendingSockets: Array<{
    ioDown: SocketWithClientId;
    bsDown: SocketWithClientId;
  }> = [];

  private _logger: ServerLogger;
  private _peerInitTimeoutMs: number;

  // Cleanup callbacks for socket disconnect listeners (clientId → cleanup fn)
  private _disconnectCleanups: Map<string, () => void> = new Map();

  private _tornDown = false;

  constructor(
    private _route: Route,
    protected _localIo: Io,
    protected _localBs: Bs,
    options?: ServerOptions,
  ) {
    //Call BaseNode constructor
    super(_localIo);

    this._logger = options?.logger ?? noopLogger;
    this._peerInitTimeoutMs = options?.peerInitTimeoutMs ?? 30_000;

    this._logger.info('Server', 'Constructing server', {
      route: this._route.flat,
    });

    // Start two-generation ref eviction
    const evictionMs = options?.refEvictionIntervalMs ?? 60_000;
    /* v8 ignore if -- @preserve */
    if (evictionMs > 0) {
      this._refEvictionTimer = setInterval(() => {
        this._multicastedRefsPrevious = this._multicastedRefsCurrent;
        this._multicastedRefsCurrent = new Set();
      }, evictionMs);
      // Don't let the timer keep the process alive
      this._refEvictionTimer.unref();
    }

    const ioMultiIoLocal = {
      io: this._localIo,
      dump: true,
      read: true,
      write: true,
      priority: 1,
    };
    this._ios.push(ioMultiIoLocal);
    this._ioMulti = new IoMulti(this._ios);

    // Initialize IoServer
    this._ioServer = new IoServer(this._ioMulti);

    const bsMultiBsLocal = {
      bs: this._localBs,
      read: true,
      write: true,
      priority: 1,
    };
    this._bss.push(bsMultiBsLocal);
    this._bsMulti = new BsMulti(this._bss);

    // Initialize BsServer
    this._bsServer = new BsServer(this._bsMulti);
  }

  /**
   * Initializes Io and Bs multis on the server.
   */
  async init() {
    this._logger.info('Server', 'Initializing server');

    try {
      // Initialize IoServer
      await this._ioMulti.init();
      await this._ioMulti.isReady();

      // Initialize BsServer
      await this._bsMulti.init();

      await this.ready();

      this._logger.info('Server', 'Server initialized successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to initialize server', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Resolves once the Io implementation is ready.
   */
  async ready() {
    /* v8 ignore next -- @preserve */ await this._ioMulti.isReady();
  }

  /**
   * Adds a client socket, rebuilds multis, and refreshes servers.
   * @param socket - Client socket to register.
   * @returns The server instance.
   */
  async addSocket(socket: SocketLike) {
    const sockets = normalizeSocketBundle(socket);
    // attach a stable id to each socket
    const clientId = `client_${this._clients.size}_${Math.random()
      .toString(36)
      .slice(2)}`;

    this._logger.info('Server', 'Adding client socket', { clientId });

    // add clientId to socket (shorthand)
    const ioUp = sockets.ioUp as SocketWithClientId;
    const ioDown = sockets.ioDown as SocketWithClientId;
    const bsUp = sockets.bsUp as SocketWithClientId;
    const bsDown = sockets.bsDown as SocketWithClientId;

    (ioUp as any).__clientId = clientId;
    (ioDown as any).__clientId = clientId;
    (bsUp as any).__clientId = clientId;
    (bsDown as any).__clientId = clientId;

    try {
      const ioPeer = await this._createIoPeer(socket, clientId);
      const bsPeer = await this._createBsPeer(socket, clientId);

      this._registerClient(
        clientId,
        { ioUp, ioDown, bsUp, bsDown },
        ioPeer,
        bsPeer,
      );
      this._pendingSockets.push({ ioDown, bsDown });
      this._queueIoPeer(ioPeer);
      this._queueBsPeer(bsPeer);

      await this._queueRefresh();

      // remove all existing listeners and re-establish multicast
      this._removeAllListeners();
      this._multicastRefs();

      // Auto-cleanup on socket disconnect
      this._registerDisconnectHandler(clientId, ioUp);

      this._logger.info('Server', 'Client socket added successfully', {
        clientId,
        totalClients: this._clients.size,
      });
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to add client socket', error, {
        clientId,
      });
      throw error;
    }
    /* v8 ignore stop -- @preserve */

    return this;
  }

  // ...........................................................................
  /**
   * Removes all listeners from all connected clients.
   */
  private _removeAllListeners() {
    for (const { ioUp } of this._clients.values()) {
      ioUp.removeAllListeners(this._route.flat);
    }
  }

  // ...........................................................................
  /**
   * Broadcasts incoming payloads from any client to all other connected clients.
   * Ensures the sender is filtered out when broadcasting.
   */
  private _multicastRefs = () => {
    for (const [clientIdA, { ioUp: socketA }] of this._clients.entries()) {
      socketA.on(this._route.flat, (payload: ConnectorPayload) => {
        const ref = payload.r;

        this._logger.traffic('in', 'Server.Multicast', this._route.flat, {
          ref,
          from: clientIdA,
        });

        // Avoid rebroadcasting the same ref multiple times (two-generation check)
        /* v8 ignore if -- @preserve */
        if (
          this._multicastedRefsCurrent.has(ref) ||
          this._multicastedRefsPrevious.has(ref)
        ) {
          this._logger.warn('Server.Multicast', 'Duplicate ref suppressed', {
            ref,
            from: clientIdA,
          });
          return;
        }
        this._multicastedRefsCurrent.add(ref);

        const p = payload as any;

        // If payload already has an origin, it was forwarded by the wire and should not be re-forwarded.
        /* v8 ignore if -- @preserve */
        if (p && p.__origin) {
          this._logger.warn(
            'Server.Multicast',
            'Loop prevention: payload already has origin',
            { ref, origin: p.__origin, from: clientIdA },
          );
          return;
        }

        // Broadcast to all OTHER clients (filter out the sender)
        for (const [
          clientIdB,
          { ioDown: socketB },
        ] of this._clients.entries()) {
          if (clientIdA !== clientIdB) {
            // clone and mark the forwarded payload with the origin to prevent loops
            const forwarded = Object.assign({}, payload, {
              __origin: clientIdA,
            });

            this._logger.traffic('out', 'Server.Multicast', this._route.flat, {
              ref,
              from: clientIdA,
              to: clientIdB,
            });

            socketB.emit(this._route.flat, forwarded);
          }
        }
      });
    }
  };

  get route() {
    return this._route;
  }

  /**
   * Returns the logger instance.
   */
  get logger(): ServerLogger {
    return this._logger;
  }

  /**
   * Returns the Io implementation.
   */
  get io(): Io {
    /* v8 ignore next -- @preserve */ return this._ioMulti;
  }

  /**
   * Returns the Bs implementation.
   */
  get bs(): Bs {
    /* v8 ignore next -- @preserve */ return this._bsMulti;
  }

  /**
   * Returns the connected clients map.
   */
  get clients() {
    return this._clients;
  }

  /**
   * Creates and initializes a downstream Io peer for a socket.
   * @param socket - Client socket to bind the peer to.
   * @param clientId - Client identifier for logging.
   */
  private async _createIoPeer(socket: SocketLike, clientId: string) {
    const sockets = normalizeSocketBundle(socket);
    this._logger.info('Server.Io', 'Creating Io peer', { clientId });
    try {
      const ioPeer = new IoPeer(sockets.ioUp);
      await this._withTimeout(ioPeer.init(), 'IoPeer.init()');
      await this._withTimeout(ioPeer.isReady(), 'IoPeer.isReady()');
      this._logger.info('Server.Io', 'Io peer created', { clientId });
      return ioPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server.Io', 'Failed to create Io peer', error, {
        clientId,
      });
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Creates and initializes a downstream Bs peer for a socket.
   * @param socket - Client socket to bind the peer to.
   * @param clientId - Client identifier for logging.
   */
  private async _createBsPeer(socket: SocketLike, clientId: string) {
    const sockets = normalizeSocketBundle(socket);
    this._logger.info('Server.Bs', 'Creating Bs peer', { clientId });
    try {
      const bsPeer = new BsPeer(sockets.bsUp);
      await this._withTimeout(bsPeer.init(), 'BsPeer.init()');
      this._logger.info('Server.Bs', 'Bs peer created', { clientId });
      return bsPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server.Bs', 'Failed to create Bs peer', error, {
        clientId,
      });
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Registers the client socket and peers.
   * @param clientId - Stable client identifier.
   * @param sockets - Directional sockets to register.
   * @param io - Io peer associated with the client.
   * @param bs - Bs peer associated with the client.
   */
  private _registerClient(
    clientId: string,
    sockets: SocketNamespaceBundle & { [k: string]: SocketWithClientId },
    io: IoPeer,
    bs: BsPeer,
  ) {
    this._clients.set(clientId, {
      ioUp: sockets.ioUp as SocketWithClientId,
      ioDown: sockets.ioDown as SocketWithClientId,
      bsUp: sockets.bsUp as SocketWithClientId,
      bsDown: sockets.bsDown as SocketWithClientId,
      io,
      bs,
    });
  }

  /**
   * Queues an Io peer for inclusion in the Io multi.
   * @param ioPeer - Io peer to add.
   */
  private _queueIoPeer(ioPeer: IoPeer) {
    this._ios.push({
      io: ioPeer,
      dump: false,
      read: true,
      write: false,
      priority: 2,
    });
  }

  /**
   * Queues a Bs peer for inclusion in the Bs multi.
   * @param bsPeer - Bs peer to add.
   */
  private _queueBsPeer(bsPeer: BsPeer) {
    this._bss.push({
      bs: bsPeer,
      read: true,
      write: false,
      priority: 2,
    });
  }

  /**
   * Rebuilds Io and Bs multis from queued peers.
   */
  private async _rebuildMultis() {
    this._logger.info('Server', 'Rebuilding multis', {
      ioCount: this._ios.length,
      bsCount: this._bss.length,
    });

    try {
      this._ioMulti = new IoMulti(this._ios);
      await this._ioMulti.init();
      await this._ioMulti.isReady();

      this._bsMulti = new BsMulti(this._bss);
      await this._bsMulti.init();

      this._logger.info('Server', 'Multis rebuilt successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to rebuild multis', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Recreates servers and reattaches sockets.
   */
  private async _refreshServers() {
    this._logger.info('Server', 'Refreshing servers', {
      pendingSockets: this._pendingSockets.length,
    });

    try {
      (this._ioServer as any)._io = this._ioMulti;
      (this._bsServer as any)._bs = this._bsMulti;

      for (const pending of this._pendingSockets) {
        await this._ioServer.addSocket(pending.ioDown);
        await this._bsServer.addSocket(pending.bsDown);
      }

      this._pendingSockets = [];

      this._logger.info('Server', 'Servers refreshed successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to refresh servers', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Batches multi/server refreshes into a single queued task.
   */
  private _queueRefresh() {
    if (!this._refreshPromise) {
      this._logger.info('Server', 'Queuing refresh');

      this._refreshPromise = Promise.resolve()
        .then(async () => {
          await this._rebuildMultis();
          await this._refreshServers();
        })
        .catch(
          /* v8 ignore next -- @preserve */
          (error) => {
            this._logger.error('Server', 'Queued refresh failed', error);
            throw error;
          },
        )
        .finally(() => {
          this._refreshPromise = undefined;
        });
    }

    return this._refreshPromise;
  }

  // ...........................................................................
  /**
   * Removes a connected client by its internal client ID.
   * Cleans up listeners, peers, and rebuilds multis.
   * @param clientId - The client identifier (from server.clients keys).
   */
  async removeSocket(clientId: string): Promise<void> {
    const client = this._clients.get(clientId);
    if (!client) return;

    this._logger.info('Server', 'Removing client socket', { clientId });

    // Remove multicast listener for this client
    client.ioUp.removeAllListeners(this._route.flat);

    // Remove disconnect handler
    const cleanup = this._disconnectCleanups.get(clientId);
    /* v8 ignore if -- @preserve */
    if (cleanup) {
      cleanup();
      this._disconnectCleanups.delete(clientId);
    }

    // Remove peers from multi arrays
    this._ios = this._ios.filter((entry) => entry.io !== client.io);
    this._bss = this._bss.filter((entry) => entry.bs !== client.bs);

    // Remove from clients map
    this._clients.delete(clientId);

    // Rebuild multis with remaining peers
    await this._rebuildMultis();

    // Refresh servers so IoServer/BsServer use updated multis
    // (pending sockets are empty here — we only refresh the internal references)
    await this._refreshServers();

    // Re-establish multicast for remaining clients
    this._removeAllListeners();
    this._multicastRefs();

    this._logger.info('Server', 'Client socket removed', {
      clientId,
      remainingClients: this._clients.size,
    });
  }

  // ...........................................................................
  /**
   * Gracefully shuts down the server: stops timers, removes listeners,
   * clears all client state, and closes storage layers.
   */
  async tearDown(): Promise<void> {
    this._logger.info('Server', 'Tearing down server');

    // Stop ref eviction timer
    if (this._refEvictionTimer) {
      clearInterval(this._refEvictionTimer);
      this._refEvictionTimer = undefined;
    }

    // Remove all multicast listeners
    this._removeAllListeners();

    // Remove disconnect handlers
    for (const cleanup of this._disconnectCleanups.values()) {
      cleanup();
    }
    this._disconnectCleanups.clear();

    // Clear all client-related data
    this._clients.clear();
    this._pendingSockets = [];

    // Close IoMulti
    /* v8 ignore else -- @preserve */
    if (this._ioMulti && this._ioMulti.isOpen) {
      this._ioMulti.close();
    }

    // Clear multi arrays
    this._ios = [];
    this._bss = [];

    // Clear ref tracking
    this._multicastedRefsCurrent.clear();
    this._multicastedRefsPrevious.clear();

    this._tornDown = true;

    this._logger.info('Server', 'Server torn down successfully');
  }

  /**
   * Whether the server has been torn down.
   */
  get isTornDown(): boolean {
    return this._tornDown;
  }

  // ...........................................................................
  /**
   * Registers a listener that auto-removes the client on socket disconnect.
   * @param clientId - Client identifier.
   * @param socket - The upstream socket to listen on.
   */
  private _registerDisconnectHandler(
    clientId: string,
    socket: SocketWithClientId,
  ) {
    const handler = () => {
      this._logger.info('Server', 'Client disconnected', { clientId });
      this.removeSocket(clientId);
    };
    socket.on('disconnect', handler);
    this._disconnectCleanups.set(clientId, () => {
      socket.off('disconnect', handler);
    });
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

  /** Example instance for test purposes */
  static async example(): Promise<Server> {
    const route = Route.fromFlat('example.route');

    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();

    const socket = new SocketMock();
    socket.connect();

    return new Server(route, io, bs).addSocket(socket);
  }
}
