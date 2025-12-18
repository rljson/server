// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';

import { Socket as ServerSocket } from 'socket.io';
import { Socket as ClientSocket } from 'socket.io-client';


/**
 * Bridge class that adapts Socket.IO sockets to the \@rljson/io Socket interface.
 * Works with both server-side and client-side Socket.IO implementations.
 */
export class SocketIoBridge implements Socket {
  constructor(private _socket: ServerSocket | ClientSocket) {}

  get connected(): boolean {
    return this._socket.connected;
  }

  get disconnected(): boolean {
    return this._socket.disconnected;
  }

  /**
   * Connect the socket.
   * Note: Socket.IO server sockets don't have a connect() method as they are
   * already connected when created. This is a no-op for server sockets.
   * For client sockets, this calls the underlying connect() method.
   */
  connect(): void {
    // Check if this is a client socket (has connect method)
    if (
      'connect' in this._socket &&
      typeof this._socket.connect === 'function'
    ) {
      this._socket.connect();
    }
    // Server sockets don't have connect() - they're already connected
  }

  disconnect(): void {
    this._socket.disconnect();
  }

  on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    (this._socket as any).on(eventName, listener);
    return this;
  }

  emit(eventName: string | symbol, ...args: any[]): this {
    (this._socket as any).emit(eventName, ...args);
    return this;
  }

  off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    (this._socket as any).off(eventName, listener);
    return this;
  }

  removeAllListeners(eventName?: string | symbol): this {
    (this._socket as any).removeAllListeners(eventName);
    return this;
  }

  /**
   * Get the underlying Socket.IO socket instance.
   */
  get rawSocket(): ServerSocket | ClientSocket {
    return this._socket;
  }
}
