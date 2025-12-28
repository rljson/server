// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

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
    }
  > = new Map();

  private _ios: IoMultiIo[] = [];
  private _ioMulti: IoMulti;

  // Storage => Let Clients read from Servers Io
  private _ioServer: IoServer;

  // To avoid rebroadcasting the same edit refs multiple times
  private _multicastedRefs: Set<string> = new Set();

  constructor(private _route: Route, protected _localIo: Io) {
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
  }

  async init() {
    // Initialize IoServer
    await this._ioMulti.init();
    await this._ioMulti.isReady();
  }

  async addSocket(socket: Socket) {
    // attach a stable id to each socket
    const clientId = `client_${this._clients.size}_${Math.random()
      .toString(36)
      .slice(2)}`;

    // add clientId to socket (shorthand)
    (socket as any).__clientId = clientId;

    // create IoPeer for the socket and initialize it
    const ioPeer = new IoPeer(socket);
    await ioPeer.init();
    await ioPeer.isReady();

    // add IoPeer to IoMultiIo list
    this._ios.push({
      io: ioPeer,
      dump: false,
      read: true,
      write: false,
      priority: 2,
    });

    // recreate IoMulti with new IoMultiIo list
    this._ioMulti = new IoMulti(this._ios);
    await this._ioMulti.init();
    await this._ioMulti.isReady();

    // store socket with client id
    this._clients.set(clientId, {
      socket: socket,
      io: ioPeer,
    });

    // recreate IoServer with new IoMulti
    this._ioServer = new IoServer(this._ioMulti);

    // add socket to IoServer
    for (const { socket } of this._clients.values()) {
      await this._ioServer.addSocket(socket);
    }

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
   */
  private _multicastRefs = () => {
    for (const { socket: socketA } of this._clients.values()) {
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

        for (const { socket: socketB } of this._clients.values()) {
          if (socketA !== socketB) {
            // clone and mark the forwarded payload with the origin to prevent loops
            const forwarded = Object.assign({}, payload, {
              __origin: (socketA as any).__clientId,
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

  get clients() {
    return this._clients;
  }

  /** Example instance for test purposes */
  static async example(): Promise<Server> {
    const route = Route.fromFlat('example.route');

    const io = new IoMem();
    await io.init();
    await io.isReady();

    const socket = new SocketMock();
    socket.connect();

    return new Server(route, io).addSocket(socket);
  }
}
