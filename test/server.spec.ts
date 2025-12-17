// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { exampleEditActionColumnSelection, staticExample } from '@rljson/db';
import { IoMem, IoMultiIo, IoPeer, Socket } from '@rljson/io';
import {
  createEditHistoryTableCfg,
  createEditTableCfg,
  createMultiEditTableCfg,
  Edit,
  Route,
} from '@rljson/rljson';

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Socket as ServerSocket, Server as SocketIoServer } from 'socket.io';
import { Socket as ClientSocket, io as SocketIoClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, Mock, vi } from 'vitest';

import { Client } from '../src/client';
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

  describe('Socket message exchange', () => {
    it('From server to clients', async () => {
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

    it('From clients to server', async () => {
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
  });

  describe('Server instance', () => {
    const route = Route.fromFlat('test.route');
    const server = new Server(route);

    beforeAll(() => {});
    afterAll(() => {});

    it('Broadcasts packages', async () => {
      const callback = vi.fn();
      for (const serverSocket of serverSockets) {
        server.addSocket(serverSocket as unknown as Socket);
      }

      expect((server as any)._sockets.length).toBe(clientCount);

      // Listen on clients, should only be called on
      // clientSockets[1] and clientSockets[2]
      clientSockets[0].on(route.flat, (m) => {
        delete (m as any).__origin;
        callback(m);
      });
      clientSockets[1].on(route.flat, (m) => {
        delete (m as any).__origin;
        callback(m);
      });
      clientSockets[2].on(route.flat, (m) => {
        delete (m as any).__origin;
        callback(m);
      });

      // Emit from first client
      clientSockets[0].emit(route.flat, { data: 123 });

      // Wait until callback has been called twice
      await vi.waitUntil(() => callback.mock.calls.length === 2, {
        timeout: 2000,
        interval: 100,
      });

      // Check callback calls
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenNthCalledWith(1, { data: 123 });
      expect(callback).toHaveBeenNthCalledWith(2, { data: 123 });
    });
  });

  describe('Client instances', () => {
    const cakeKey = 'carCake';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client;
    let b: Client;
    let c: Client;

    let server: Server;

    beforeAll(async () => {
      // Create clients
      a = new Client(cakeKey, clientSockets[0] as unknown as Socket);
      b = new Client(cakeKey, clientSockets[1] as unknown as Socket);
      c = new Client(cakeKey, clientSockets[2] as unknown as Socket);

      const ioMem = new IoMem();
      await ioMem.init();
      await ioMem.isReady();

      const ioMultiIo: IoMultiIo = {
        io: ioMem,
        dump: false,
        read: true,
        write: true,
        priority: 1,
      };

      await a.addIoMultiIo(ioMultiIo);
      await b.addIoMultiIo(ioMultiIo);
      await c.addIoMultiIo(ioMultiIo);

      // Create server
      server = new Server(route);

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        server.addSocket(serverSocket as unknown as Socket);
      }
    });
    afterAll(() => {});

    it('Should create multiple clients', async () => {
      expect(a.db).toBeDefined();
      expect(b.db).toBeDefined();
      expect(c.db).toBeDefined();
    });

    it('Should sync messages between connectors', async () => {
      const callbackA = vi.fn();
      const callbackB = vi.fn();
      const callbackC = vi.fn();

      a.connector!.listen((msg: string) => callbackA(msg));

      b.connector!.listen((msg: string) => callbackB(msg));

      c.connector!.listen((msg: string) => callbackC(msg));

      a.connector!.send('testMessage');

      // Wait until both callbacks have been called
      await vi.waitUntil(
        () =>
          callbackB.mock.calls.length === 1 &&
          callbackC.mock.calls.length === 1,
        {
          timeout: 2000,
          interval: 100,
        },
      );
      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalledWith('testMessage');
      expect(callbackC).toHaveBeenCalledWith('testMessage');
    });
  });

  describe('Client instances with Db running', () => {
    const cakeKey = 'carCake';
    const cakeRef = staticExample().carCake._data[0]._hash ?? '';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client;
    let b: Client;
    let c: Client;
    let clients: Client[] = [];

    let server: Server;

    beforeAll(async () => {
      // Client setup
      a = new Client(cakeKey, clientSockets[0] as unknown as Socket);
      b = new Client(cakeKey, clientSockets[1] as unknown as Socket);
      c = new Client(cakeKey, clientSockets[2] as unknown as Socket);

      clients = [a, b, c];

      // Data setup
      const tableCfgsWithOutInsertHistory = [
        createEditTableCfg(cakeKey),
        createEditHistoryTableCfg(cakeKey),
        createMultiEditTableCfg(cakeKey),
      ];
      const tableCfgsWithInsertHistory = staticExample().tableCfgs._data;
      const tableCfgs = {
        withoutInsertHistory: tableCfgsWithOutInsertHistory,
        withInsertHistory: tableCfgsWithInsertHistory,
      };

      const exampleData = staticExample();

      for (const client of clients) {
        const ioMem = new IoMem();
        await ioMem.init();
        await ioMem.isReady();

        const ioMultiIo: IoMultiIo = {
          io: ioMem,
          dump: true,
          read: true,
          write: true,
          priority: 1,
        };

        await client.addIoMultiIo(ioMultiIo);
        await client.createTables(tableCfgs);
        await client.import(exampleData);
      }

      // Crossover Sockets to Remote SocketIos
      for (const client of clients) {
        const ioPeers = [];
        for (const otherClient of clients) {
          if (client.id !== otherClient.id) {
            const ioPeer: IoPeer = new IoPeer(otherClient.socket);
            await ioPeer.init();
            await ioPeer.isReady();

            ioPeers.push(ioPeer);
          }
        }

        // Create IoMultiIo from IoPeers
        const ioMultiIos: IoMultiIo[] = ioPeers.map((ioPeer) => ({
          io: ioPeer,
          dump: true,
          read: true,
          write: false,
          priority: 2,
        }));

        // Add IoMultiIo to client
        for (const peerIoMultiIo of ioMultiIos) {
          //await client.addIoMultiIo(peerIoMultiIo);
        }
      }

      // Create server
      server = new Server(route);

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        server.addSocket(serverSocket as unknown as Socket);
      }
    });
    afterAll(() => {});

    it('Should create multiple clients', async () => {
      for (const client of clients) {
        expect(client.db).toBeDefined();
      }
    });

    it('Should sync created EditHistories to connected clients', async () => {
      const edit: Edit = {
        name: 'Select brand, type, serviceIntervals, isElectric, height, width, length, engine, repairedByWorkshop from CarExample',
        action: exampleEditActionColumnSelection(),
        _hash: '',
      };

      expect(a.mem).toBeDefined();

      await a.mem!.edit(edit, cakeRef as string);

      expect(a.mem!.join).toBeDefined();
      expect(a.mem!.join.columnCount).toBe(9);
      expect(a.mem!.join.rows).toBeDefined();
      expect(a.mem!.join.rows.length).toBe(8);

      const aRows = [...a.mem!.join.rows];
      expect(aRows.length).toBe(8);
    }, 50000);
  });
});
