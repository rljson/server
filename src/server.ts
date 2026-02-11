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

  // To avoid rebroadcasting the same edit refs multiple times
  private _multicastedRefs: Set<string> = new Set();

  private _refreshPromise?: Promise<void>;
  private _pendingSockets: Array<{
    ioDown: SocketWithClientId;
    bsDown: SocketWithClientId;
  }> = [];

  private _logger: ServerLogger;

  constructor(
    private _route: Route,
    protected _localIo: Io,
    protected _localBs: Bs,
    options?: ServerOptions,
  ) {
    //Call BaseNode constructor
    super(_localIo);

    this._logger = options?.logger ?? noopLogger;

    this._logger.info('Server', 'Constructing server', {
      route: this._route.flat,
    });

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

        // Avoid rebroadcasting the same ref multiple times
        /* v8 ignore if -- @preserve */
        if (this._multicastedRefs.has(ref)) {
          this._logger.warn('Server.Multicast', 'Duplicate ref suppressed', {
            ref,
            from: clientIdA,
          });
          return;
        }
        this._multicastedRefs.add(ref);

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
      await ioPeer.init();
      await ioPeer.isReady();
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
      await bsPeer.init();
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
