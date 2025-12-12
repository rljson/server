// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { ConnectorPayload } from '@rljson/db';
import { Socket, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

export type SocketWithRelayId = Socket & { __relayId?: string };

// .............................................................................
export class Server {
  private _sockets: SocketWithRelayId[] = [];

  constructor(private _route: Route) {}

  addSocket(socket: Socket) {
    // attach a stable id to each socket
    const relayId = `socket_${this._sockets.length}_${Math.random()
      .toString(36)
      .slice(2)}`;

    (socket as any).__relayId = relayId;

    // store socket with relay id
    this._sockets.push(socket);

    // reset listeners and re-broadcast
    this._removeAllListeners();
    this._broadcast(this._route);

    return this;
  }

  private _removeAllListeners() {
    for (const socket of this._sockets) {
      socket.removeAllListeners(this._route.flat);
    }
  }

  private _broadcast = (route: Route) => {
    for (const socketA of this._sockets) {
      socketA.on(route.flat, (payload: ConnectorPayload) => {
        const p = payload as any;

        // If payload already has an origin, it was forwarded by the wire and should not be re-forwarded.
        if (p && p.__origin) {
          return;
        }

        for (const socketB of this._sockets) {
          if (socketA !== socketB) {
            // clone and mark the forwarded payload with the origin to prevent loops
            const forwarded = Object.assign({}, payload, {
              __origin: (socketA as any).__relayId,
            });
            socketB.emit(route.flat, forwarded);
          }
        }
      });
    }
  };

  /** Example instance for test purposes */
  static get example(): Server {
    const route = Route.fromFlat('example.route');
    const socket = new SocketMock();

    return new Server(route).addSocket(socket);
  }
}
