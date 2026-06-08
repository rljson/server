// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';

export type SocketNamespaceBundle = {
  ioUp: Socket;
  ioDown: Socket;
  bsUp: Socket;
  bsDown: Socket;
};

export type SocketLike = Socket | SocketNamespaceBundle;

/**
 * Normalizes a socket input into a full namespace bundle used by the server/client constructors.
 * - If you pass a single Socket (classic setup), it is reused for all namespaces (ioUp/ioDown/bsUp/bsDown).
 * - If you pass an explicit bundle (namespaces already split), the bundle is returned as-is.
 * @param socket - Single socket or pre-split namespace bundle.
 * @returns Normalized namespace bundle for Io/Bs up/down channels.
 */
export function normalizeSocketBundle(
  socket: SocketLike,
): SocketNamespaceBundle {
  const bundle = socket as SocketNamespaceBundle;
  if (bundle.ioUp && bundle.ioDown && bundle.bsUp && bundle.bsDown) {
    return bundle;
  }

  const single = socket as Socket;
  return {
    ioUp: single,
    ioDown: single,
    bsUp: single,
    bsDown: single,
  };
}

/**
 * Builds the Socket the sync Connector should use when a client's upstream
 * and downstream channels are split into separate namespaces.
 *
 * The Connector (in `@rljson/db`) uses a *single* Socket for BOTH emitting
 * (ref / ack / gap-fill upstream) and listening (ref / ack / bootstrap /
 * gap-fill downstream). The Server, however, receives a client's refs on the
 * client's `ioUp` namespace and fans forwarded refs + bootstrap back on the
 * client's `ioDown` namespace. With a single multiplexed socket
 * (`ioUp === ioDown`) this is transparent. When the namespaces are split,
 * binding the Connector to `ioUp` alone makes it listen on the wrong channel,
 * so it never sees the server's downstream traffic.
 *
 * This adapter routes:
 *  - `emit` → upstream (`ioUp`)
 *  - `on` / `off` / `removeAllListeners` → downstream (`ioDown`)
 *  - `connect` / `disconnect` / `connected` / `disconnected` → upstream (`ioUp`)
 *
 * When `ioUp` and `ioDown` are the same instance, the socket is returned
 * unchanged so the classic single-socket setup is entirely unaffected.
 * @param up - Upstream channel (client → server), used for emitting.
 * @param down - Downstream channel (server → client), used for listening.
 * @returns A Socket that emits upstream and listens downstream.
 */
export function connectorDuplexSocket(up: Socket, down: Socket): Socket {
  if (up === down) {
    return up;
  }

  const duplex: Socket = {
    get connected() {
      return up.connected;
    },
    get disconnected() {
      return up.disconnected;
    },
    connect() {
      up.connect();
    },
    disconnect() {
      up.disconnect();
    },
    emit(eventName, ...args) {
      return up.emit(eventName, ...args);
    },
    on(eventName, listener) {
      down.on(eventName, listener);
      return duplex;
    },
    off(eventName, listener) {
      down.off(eventName, listener);
      return duplex;
    },
    removeAllListeners(eventName) {
      down.removeAllListeners(eventName);
      return duplex;
    },
  };

  return duplex;
}
