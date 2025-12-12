// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Socket as ServerSocket, Server as SocketIoServer } from 'socket.io';
import { Socket as ClientSocket, io as SocketIoClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, Mock, vi } from 'vitest';

import { Server } from '../src/server';

describe('Server', () => {
  let socketIoServer: SocketIoServer;
  const serverSockets: ServerSocket[] = [];
  const clientSockets: ClientSocket[] = [];
  const clientCount = 3;

  beforeAll(() => {
    return new Promise((resolve) => {
      const httpServer = createServer();
      socketIoServer = new SocketIoServer(httpServer);

      httpServer.listen(() => {
        const port = (httpServer.address() as AddressInfo).port;

        // Listen for client connections
        socketIoServer.on('connection', (socket) => {
          serverSockets.push(socket);
        });

        // Create client sockets
        for (let i = 0; i < clientCount; i++) {
          const clientSocket = SocketIoClient(`http://localhost:${port}`, {
            forceNew: true,
          });
          clientSockets.push(clientSocket);
        }

        // Wait for all clients to connect
        Promise.all(
          clientSockets.map(
            (clientSocket) =>
              new Promise<void>((res) => {
                clientSocket.on('connect', () => res());
              }),
          ),
        ).then(() => resolve(undefined));
      });
    });
  });

  afterAll(() => {
    socketIoServer.close();
    for (const clientSocket of clientSockets) {
      clientSocket.disconnect();
    }
  });

  it('Should send messages from server to clients', async () => {
    const callbacks: Map<string, { socket: ClientSocket; cb: Mock }> =
      new Map();

    for (const clientSocket of clientSockets) {
      const callback = vi.fn();
      clientSocket.on('hello', (message: string) => {
        callback(message);
      });
      callbacks.set(clientSocket.id!, { socket: clientSocket, cb: callback });
    }

    // Emit 'hello' event from server to all clients
    for (const serverSocket of serverSockets) {
      serverSocket.emit('hello', 'world');
    }

    // Wait until all callbacks have been called
    await vi.waitUntil(
      () => {
        let calledCount = 0;
        for (const { cb } of callbacks.values()) {
          if (cb.mock.calls.length > 0) {
            calledCount++;
          }
        }
        return calledCount === clientCount;
      },
      {
        timeout: 2000,
        interval: 100,
      },
    );

    for (const { cb } of callbacks.values()) {
      expect(cb).toHaveBeenCalledWith('world');
    }
  });

  it('Should send messages from clients to server', async () => {
    const callbacks: Map<string, { socket: ServerSocket; cb: Mock }> =
      new Map();

    for (const serverSocket of serverSockets) {
      const callback = vi.fn();
      serverSocket.on('greet', (message: string) => {
        callback(message);
      });
      callbacks.set(serverSocket.id, { socket: serverSocket, cb: callback });
    }

    // Emit 'greet' event from all clients to server
    for (const clientSocket of clientSockets) {
      clientSocket.emit('greet', 'hello server');
    }

    // Wait until all callbacks have been called
    await vi.waitUntil(
      () => {
        let calledCount = 0;
        for (const { cb } of callbacks.values()) {
          if (cb.mock.calls.length > 0) {
            calledCount++;
          }
        }
        return calledCount === clientCount;
      },
      {
        timeout: 2000,
        interval: 100,
      },
    );

    for (const { cb } of callbacks.values()) {
      expect(cb).toHaveBeenCalledWith('hello server');
    }
  });

  it('Server example instance works', async () => {
    const callback = vi.fn();
    const route = Route.fromFlat('test.route');
    const server = new Server(route);

    for (const serverSocket of serverSockets) {
      server.addSocket(serverSocket as unknown as Socket);
    }

    expect((server as any)._sockets.length).toBe(clientCount);

    clientSockets[1].on(route.flat, (m) => {
      delete (m as any).__origin;
      callback(m);
    });
    clientSockets[2].on(route.flat, (m) => {
      delete (m as any).__origin;
      callback(m);
    });
    clientSockets[0].emit(route.flat, { data: 123 });

    // Wait until callback has been called twice
    await vi.waitUntil(() => callback.mock.calls.length === 2, {
      timeout: 2000,
      interval: 100,
    });

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, { data: 123 });
    expect(callback).toHaveBeenNthCalledWith(2, { data: 123 });
  });
});
