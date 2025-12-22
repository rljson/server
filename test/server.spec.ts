// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { exampleEditActionColumnSelection, staticExample } from '@rljson/db';
import { Io, IoMem } from '@rljson/io';
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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  vi,
} from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';
import { SocketIoBridge } from '../src/socket-io-bridge';

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
    let server: Server;
    let serverIo: Io;

    beforeAll(async () => {
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      server = new Server(route, serverIo);
      await server.init();
    });
    afterAll(() => {});

    it('Multicasts packages', async () => {
      const callback = vi.fn();
      for (const serverSocket of serverSockets) {
        await server.addSocket(new SocketIoBridge(serverSocket));
      }

      expect((server as any)._clients.size).toBe(clientCount);

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
    const cakeKey = 'testCake';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, aIo: Io;
    let b: Client, bIo: Io;
    let c: Client, cIo: Io;
    let clients: Client[] = [];

    let server: Server;
    let serverIo: Io;

    beforeEach(async () => {
      // Create client Ios
      aIo = new IoMem();
      await aIo.init();
      await aIo.isReady();

      bIo = new IoMem();
      await bIo.init();
      await bIo.isReady();

      cIo = new IoMem();
      await cIo.init();
      await cIo.isReady();

      // Create clients
      a = new Client(route, cakeKey, new SocketIoBridge(clientSockets[0]), aIo);
      b = new Client(route, cakeKey, new SocketIoBridge(clientSockets[1]), bIo);
      c = new Client(route, cakeKey, new SocketIoBridge(clientSockets[2]), cIo);
      clients = [a, b, c];

      // Create EditHistory Table
      const editHistoryTableCfg = createEditHistoryTableCfg(cakeKey);
      for (const client of clients) {
        await client.init();
        await client.createTables({
          withoutInsertHistory: [editHistoryTableCfg],
        });
      }

      // Create server
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      server = new Server(route, serverIo);
      await server.init();

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        server.addSocket(new SocketIoBridge(serverSocket));
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

    it('Should teardown client instances', async () => {
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

      // Teardown client b
      await b.tearDown();

      // Reset callbacks
      callbackA.mockReset();
      callbackB.mockReset();
      callbackC.mockReset();

      // Send another message from a
      a.connector!.send('testMessage2');

      // Wait to ensure no further calls are made
      await new Promise((res) => setTimeout(res, 1000));

      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).not.toHaveBeenCalled();
      expect(callbackC).toHaveBeenCalledWith('testMessage2');
    });
  });

  describe('Client instances with Db running', () => {
    const cakeKey = 'carCake';
    const cakeRef = staticExample().carCake._data[0]._hash ?? '';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, ioA: Io;
    let b: Client, ioB: Io;
    let c: Client, ioC: Io;
    let clients: Client[] = [];

    let server: Server;
    let serverIo: Io;

    beforeEach(async () => {
      // Client setup
      ioA = new IoMem();
      await ioA.init();
      await ioA.isReady();

      ioB = new IoMem();
      await ioB.init();
      await ioB.isReady();

      ioC = new IoMem();
      await ioC.init();
      await ioC.isReady();

      a = new Client(route, cakeKey, new SocketIoBridge(clientSockets[0]), ioA);
      b = new Client(route, cakeKey, new SocketIoBridge(clientSockets[1]), ioB);
      c = new Client(route, cakeKey, new SocketIoBridge(clientSockets[2]), ioC);

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
        await client.init();
        await client.createTables(tableCfgs);
        await client.import(exampleData);
      }

      // Create server Io
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      // Create server
      server = new Server(route, serverIo);
      await server.init();

      await server.createTables(tableCfgs);
      await server.import(exampleData);

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        await server.addSocket(new SocketIoBridge(serverSocket));
      }
    });
    afterAll(() => {});

    it('Should create multiple clients', async () => {
      for (const client of clients) {
        expect(client.db).toBeDefined();
      }
    });

    it.skip('Should sync created EditHistories to connected clients', async () => {
      // Setup listeners before creating EditHistory
      const bReceivedEditHistoryRef = vi.fn();
      const cReceivedEditHistoryRef = vi.fn();

      b.connector!.listen((editHistoryRef: string) =>
        bReceivedEditHistoryRef(editHistoryRef),
      );
      c.connector!.listen((editHistoryRef: string) =>
        cReceivedEditHistoryRef(editHistoryRef),
      );

      // Setup head change listeners
      const bUpdatedHead = vi.fn();
      const cUpdatedHead = vi.fn();

      expect(b.mem).toBeDefined();
      expect(c.mem).toBeDefined();

      b.mem!.listenToHeadChanges(async (editHistoryRef: string) => {
        bUpdatedHead(editHistoryRef);
      });
      c.mem!.listenToHeadChanges(async (editHistoryRef: string) => {
        cUpdatedHead(editHistoryRef);
      });

      const edit: Edit = {
        name: 'Select brand, type, serviceIntervals, isElectric, height, width, length, engine, repairedByWorkshop from CarExample',
        action: exampleEditActionColumnSelection(),
        _hash: '',
      };

      expect(a.mem).toBeDefined();

      await a.mem!.edit(edit, cakeRef as string);
      const aRows = [...a.mem!.join!.rows];
      expect(aRows.length).toBe(8);

      await vi.waitUntil(() => {
        return (
          bReceivedEditHistoryRef.mock.calls.length >= 1 &&
          cReceivedEditHistoryRef.mock.calls.length >= 1
        );
      }, 20000);

      await vi.waitUntil(() => {
        return (
          bUpdatedHead.mock.calls.length >= 1 &&
          cUpdatedHead.mock.calls.length >= 1
        );
      }, 30000);

      const bRows = [...b.mem!.join!.rows];
      const cRows = [...c.mem!.join!.rows];

      expect(aRows).toEqual(bRows);
      expect(aRows).toEqual(cRows);
    }, 60000);
  });
});
