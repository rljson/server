// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem, BsMulti, BsMultiBs, BsPeer, BsServer } from '@rljson/bs';
import { ConnectorPayload } from '@rljson/db';
import { Io, IoMem, IoMulti, IoMultiIo, IoPeer, IoServer, Socket, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { BaseNode } from './base-node.ts';


export type SocketWithClientId = Socket & { __clientId?: string };

// .............................................................................
export class Server extends BaseNode {
  // Map of connected clients
  // socket => Push: Send new Refs through Route
  // io => Pull: Read from Clients Io
  private _clients: Map<
    string,
    {
      socket: SocketWithClientId;
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
  private _pendingSockets: SocketWithClientId[] = [];

  constructor(
    private _route: Route,
    protected _localIo: Io,
    protected _localBs: Bs,
  ) {
    //Call BaseNode constructor
    super(_localIo);

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
    // Initialize IoServer
    await this._ioMulti.init();
    await this._ioMulti.isReady();

    // Initialize BsServer
    await this._bsMulti.init();

    await this.ready();
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
  async addSocket(socket: Socket) {
    // attach a stable id to each socket
    const clientId = `client_${this._clients.size}_${Math.random()
      .toString(36)
      .slice(2)}`;

    // add clientId to socket (shorthand)
    (socket as any).__clientId = clientId;

    const ioPeer = await this._createIoPeer(socket);
    const bsPeer = await this._createBsPeer(socket);

    this._registerClient(clientId, socket, ioPeer, bsPeer);
    this._pendingSockets.push(socket as SocketWithClientId);
    this._queueIoPeer(ioPeer);
    this._queueBsPeer(bsPeer);

    await this._queueRefresh();

    // remove all existing listeners and re-establish multicast
    this._removeAllListeners();
    this._multicastRefs();

    return this;
  }

  // ...........................................................................
  /**
   * Removes all listeners from all connected clients.
   */
  private _removeAllListeners() {
    for (const { socket } of this._clients.values()) {
      socket.removeAllListeners(this._route.flat);
    }
  }

  // ...........................................................................
  /**
   * Broadcasts incoming payloads from any client to all other connected clients.
   * Ensures the sender is filtered out when broadcasting.
   */
  private _multicastRefs = () => {
    for (const [clientIdA, { socket: socketA }] of this._clients.entries()) {
      socketA.on(this._route.flat, (payload: ConnectorPayload) => {
        const ref = payload.r;
        // Avoid rebroadcasting the same ref multiple times
        /* v8 ignore next -- @preserve */
        if (this._multicastedRefs.has(ref)) {
          return;
        }
        this._multicastedRefs.add(ref);

        const p = payload as any;

        // If payload already has an origin, it was forwarded by the wire and should not be re-forwarded.
        /* v8 ignore next -- @preserve */
        if (p && p.__origin) {
          return;
        }

        // Broadcast to all OTHER clients (filter out the sender)
        for (const [
          clientIdB,
          { socket: socketB },
        ] of this._clients.entries()) {
          if (clientIdA !== clientIdB) {
            // clone and mark the forwarded payload with the origin to prevent loops
            const forwarded = Object.assign({}, payload, {
              __origin: clientIdA,
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
   */
  private async _createIoPeer(socket: Socket) {
    const ioPeer = new IoPeer(socket);
    await ioPeer.init();
    await ioPeer.isReady();
    return ioPeer;
  }

  /**
   * Creates and initializes a downstream Bs peer for a socket.
   * @param socket - Client socket to bind the peer to.
   */
  private async _createBsPeer(socket: Socket) {
    const bsPeer = new BsPeer(socket);
    await bsPeer.init();
    return bsPeer;
  }

  /**
   * Registers the client socket and peers.
   * @param clientId - Stable client identifier.
   * @param socket - Client socket to register.
   * @param io - Io peer associated with the client.
   * @param bs - Bs peer associated with the client.
   */
  private _registerClient(
    clientId: string,
    socket: SocketWithClientId,
    io: IoPeer,
    bs: BsPeer,
  ) {
    this._clients.set(clientId, {
      socket,
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
    this._ioMulti = new IoMulti(this._ios);
    await this._ioMulti.init();
    await this._ioMulti.isReady();

    this._bsMulti = new BsMulti(this._bss);
    await this._bsMulti.init();
  }

  /**
   * Recreates servers and reattaches sockets.
   */
  private async _refreshServers() {
    (this._ioServer as any)._io = this._ioMulti;
    (this._bsServer as any)._bs = this._bsMulti;

    for (const socket of this._pendingSockets) {
      await this._ioServer.addSocket(socket);
      await this._bsServer.addSocket(socket);
    }

    this._pendingSockets = [];
  }

  /**
   * Batches multi/server refreshes into a single queued task.
   */
  private _queueRefresh() {
    if (!this._refreshPromise) {
      this._refreshPromise = Promise.resolve()
        .then(async () => {
          await this._rebuildMultis();
          await this._refreshServers();
        })
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
