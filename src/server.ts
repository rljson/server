// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { ConnectorPayload } from '@rljson/db';
import { Io, IoMem, IoMulti, IoMultiIo, IoPeer, IoServer, Socket, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';


export type SocketWithClientId = Socket & { __clientId?: string };

// .............................................................................
export class Server {
  // Map of connected clients
  // socket => Push: Broadcast new Refs through Route
  // IoPeer => Pull: Read from Clients Io
  private _clients: Map<
    string,
    {
      socket: SocketWithClientId;
      io: IoPeer;
      ioServerToOtherClients?: IoServer;
    }
  > = new Map();

  // Storage => Let Clients read from Servers Io
  private _ioServer: IoServer;

  // To avoid rebroadcasting the same edit refs multiple times
  private _broadcastedRefs: Set<string> = new Set();

  constructor(private _route: Route, private _localIo: Io) {
    this._ioServer = new IoServer(this._localIo);
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

    // add socket to IoServer
    this._ioServer.addSocket(socket);

    // store socket with client id
    this._clients.set(clientId, {
      socket: socket,
      io: ioPeer,
    });

    // re-init IoServer for all clients to use updated IoMulti
    if (this._clients.size > 1) await this._reInitIoServerMultiCasting();

    // reset listeners and re-broadcast
    this._removeAllListeners();
    this._broadcast();

    return this;
  }

  // ...........................................................................
  /**
   * Combines sockets to other connected clients to a single IoMulti. On top of that, a IoServer is created for each client to read from all other clients.
   *
   */
  private async _reInitIoServerMultiCasting() {
    for (const client of this._clients.values()) {
      const { socket } = client;
      const clientId = (socket as any).__clientId;

      const otherSockets: SocketWithClientId[] = [];
      for (const { socket: otherSocket } of this._clients.values()) {
        if (otherSocket.__clientId === clientId) continue;
        otherSockets.push(otherSocket);
      }

      if (client.ioServerToOtherClients) {
        client.ioServerToOtherClients.removeSocket(client.socket);
        delete client.ioServerToOtherClients;
      }

      const otherIoMultiIos: IoMultiIo[] = [];
      for (const otherSocket of otherSockets) {
        const remoteIo = new IoPeer(otherSocket);
        await remoteIo.isReady();
        await remoteIo.init();

        otherIoMultiIos.push({
          io: remoteIo,
          dump: true,
          read: true,
          write: false,
          priority: 2,
        });
      }
      const otherIoMulti = new IoMulti(otherIoMultiIos);
      await otherIoMulti.init();
      await otherIoMulti.isReady();

      const ioServerToOtherClients = new IoServer(otherIoMulti);
      await ioServerToOtherClients.addSocket(client.socket);

      // store socket with client id
      this._clients.set(clientId, {
        socket: client.socket,
        io: client.io,
        ioServerToOtherClients,
      });
    }
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
  private _broadcast = () => {
    for (const { socket: socketA } of this._clients.values()) {
      socketA.on(this._route.flat, (payload: ConnectorPayload) => {
        const ref = payload.r;
        // Avoid rebroadcasting the same ref multiple times
        if (this._broadcastedRefs.has(ref)) {
          return;
        }
        this._broadcastedRefs.add(ref);

        const p = payload as any;

        // If payload already has an origin, it was forwarded by the wire and should not be re-forwarded.
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

  /** Example instance for test purposes */
  static get example(): Promise<Server> {
    const route = Route.fromFlat('example.route');
    const io = new IoMem();
    const socket = new SocketMock();

    return new Server(route, io).addSocket(socket);
  }
}
