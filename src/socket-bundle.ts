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
