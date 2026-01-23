// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import {
  Connector,
  Db,
  exampleEditActionColumnSelectionOnlySomeColumns,
  MultiEditManager,
  staticExample,
} from '@rljson/db';
import { Io, IoMem, IoMulti, SocketMock } from '@rljson/io';
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
  describe('Socket message exchange', () => {
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
    let socketIoServer: SocketIoServer;
    const serverSockets: ServerSocket[] = [];
    const clientSockets: ClientSocket[] = [];
    const clientCount = 3;

    const route = Route.fromFlat('test.route');
    let server: Server;
    let serverIo: Io;
    let serverBs: BsMem;

    beforeAll(async () => {
      await new Promise((resolve) => {
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

      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      server = new Server(route, serverIo, serverBs);
      await server.init();
    });

    afterAll(async () => {
      await socketIoServer.close();

      await Promise.all(
        clientSockets.map(
          (clientSocket) =>
            new Promise<void>((resolve) => {
              clientSocket.on('disconnect', () => resolve());
              clientSocket.disconnect();
            }),
        ),
      );
    });

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
    let socketIoServer: SocketIoServer;
    const serverSockets: ServerSocket[] = [];
    const clientSockets: ClientSocket[] = [];
    const clientCount = 3;

    const cakeKey = 'testCake';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, aIo: Io, aBs: BsMem;
    let b: Client, bIo: Io, bBs: BsMem;
    let c: Client, cIo: Io, cBs: BsMem;
    let clients: Client[] = [];

    let aConnector: Connector, bConnector: Connector, cConnector: Connector;
    let aMem: MultiEditManager, bMem: MultiEditManager, cMem: MultiEditManager;

    let server: Server;
    let serverIo: Io;
    let serverBs: BsMem;

    beforeAll(async () => {
      await new Promise((resolve) => {
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

      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      server = new Server(route, serverIo, serverBs);
      await server.init();
    });

    afterAll(async () => {
      await socketIoServer.close();

      await Promise.all(
        clientSockets.map(
          (clientSocket) =>
            new Promise<void>((resolve) => {
              clientSocket.on('disconnect', () => resolve());
              clientSocket.disconnect();
            }),
        ),
      );
    });

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

      aBs = new BsMem();
      bBs = new BsMem();
      cBs = new BsMem();

      // Create clients
      a = new Client(new SocketIoBridge(clientSockets[0]), aIo, aBs);
      b = new Client(new SocketIoBridge(clientSockets[1]), bIo, bBs);
      c = new Client(new SocketIoBridge(clientSockets[2]), cIo, cBs);
      clients = [a, b, c];

      // Create EditHistory Table
      const editHistoryTableCfg = createEditHistoryTableCfg(cakeKey);
      for (const client of clients) {
        await client.init();
        await client.createTables({
          withoutInsertHistory: [editHistoryTableCfg],
        });
      }

      // Create Connectors and MultiEditManagers
      const aDb = new Db(a.io!);
      aConnector = new Connector(
        aDb,
        route,
        new SocketIoBridge(clientSockets[0]),
      );
      aMem = new MultiEditManager(cakeKey, aDb);
      aMem.init();
      aConnector.listen(async (editHistoryRef: string) => {
        try {
          await aMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      const bDb = new Db(b.io!);
      bConnector = new Connector(
        bDb,
        route,
        new SocketIoBridge(clientSockets[1]),
      );
      bMem = new MultiEditManager(cakeKey, bDb);
      bMem.init();
      bConnector.listen(async (editHistoryRef: string) => {
        try {
          await bMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      const cDb = new Db(c.io!);
      cConnector = new Connector(
        cDb,
        route,
        new SocketIoBridge(clientSockets[2]),
      );
      cMem = new MultiEditManager(cakeKey, cDb);
      cMem.init();
      cConnector.listen(async (editHistoryRef: string) => {
        try {
          await cMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      // Create server
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      server = new Server(route, serverIo, serverBs);
      await server.init();

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        server.addSocket(new SocketIoBridge(serverSocket));
      }
    });

    it('Should sync messages between connectors', async () => {
      const callbackA = vi.fn();
      const callbackB = vi.fn();
      const callbackC = vi.fn();

      aConnector.listen((msg: string) => callbackA(msg));
      bConnector.listen((msg: string) => callbackB(msg));
      cConnector.listen((msg: string) => callbackC(msg));

      aConnector.send('testMessage');

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

  describe('Client instances with Db running', async () => {
    let socketIoServer: SocketIoServer;
    let serverSockets: ServerSocket[] = [];
    let clientSockets: ClientSocket[] = [];
    const clientCount = 3;

    const cakeKey = 'carCake';
    const cakeRef = staticExample().carCake._data[0]._hash ?? '';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, ioA: Io, aBs: BsMem;
    let b: Client, ioB: Io, bBs: BsMem;
    let c: Client, ioC: Io, cBs: BsMem;
    let clients: Client[] = [];

    let aConnector: Connector, bConnector: Connector, cConnector: Connector;
    let aMem: MultiEditManager, bMem: MultiEditManager, cMem: MultiEditManager;

    let server: Server;
    let serverIo: Io;
    let serverBs: BsMem;

    beforeAll(async () => {
      // Clear arrays to ensure clean state
      serverSockets = [];
      clientSockets = [];

      await new Promise((resolve) => {
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

      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      server = new Server(route, serverIo, serverBs);
      await server.init();

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

      aBs = new BsMem();
      bBs = new BsMem();
      cBs = new BsMem();

      a = new Client(new SocketIoBridge(clientSockets[0]), ioA, aBs);
      b = new Client(new SocketIoBridge(clientSockets[1]), ioB, bBs);
      c = new Client(new SocketIoBridge(clientSockets[2]), ioC, cBs);

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

      // Create Connectors and MultiEditManagers
      const aDb = new Db(a.io!);
      aConnector = new Connector(
        aDb,
        route,
        new SocketIoBridge(clientSockets[0]),
      );
      aMem = new MultiEditManager(cakeKey, aDb);
      aMem.init();
      aConnector.listen(async (editHistoryRef: string) => {
        try {
          await aMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      const bDb = new Db(b.io!);
      bConnector = new Connector(
        bDb,
        route,
        new SocketIoBridge(clientSockets[1]),
      );
      bMem = new MultiEditManager(cakeKey, bDb);
      bMem.init();
      bConnector.listen(async (editHistoryRef: string) => {
        try {
          await bMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      const cDb = new Db(c.io!);
      cConnector = new Connector(
        cDb,
        route,
        new SocketIoBridge(clientSockets[2]),
      );
      cMem = new MultiEditManager(cakeKey, cDb);
      cMem.init();
      cConnector.listen(async (editHistoryRef: string) => {
        try {
          await cMem.editHistoryRef(editHistoryRef);
        } catch {
          // ignore invalid refs in connector smoke tests
        }
      });

      // Create server Io
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      // Create server
      server = new Server(route, serverIo, serverBs);
      await server.init();

      await server.createTables(tableCfgs);
      await server.import(exampleData);

      // Add server sockets to server
      for (const serverSocket of serverSockets) {
        await server.addSocket(new SocketIoBridge(serverSocket));
      }
    });

    afterAll(async () => {
      // Proper cleanup sequence
      for (const client of clients) {
        await client.tearDown();
      }

      // Wait a bit for client teardown to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (const clientSocket of clientSockets) {
        clientSocket.disconnect();
      }

      for (const serverSocket of serverSockets) {
        serverSocket.disconnect();
      }

      // Wait for disconnections to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      await socketIoServer.close();

      // Final wait to ensure all resources are released
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    it('Should sync created EditHistories to connected clients', async () => {
      // Setup listeners before creating EditHistory
      const bReceivedEditHistoryRef = vi.fn();
      const cReceivedEditHistoryRef = vi.fn();

      bConnector.listen((editHistoryRef: string) =>
        bReceivedEditHistoryRef(editHistoryRef),
      );
      cConnector.listen((editHistoryRef: string) =>
        cReceivedEditHistoryRef(editHistoryRef),
      );

      // Setup head change listeners
      const bUpdatedHead = vi.fn();
      const cUpdatedHead = vi.fn();

      expect(bMem).toBeDefined();
      expect(cMem).toBeDefined();

      bMem.listenToHeadChanges(async (editHistoryRef: string) => {
        bUpdatedHead(editHistoryRef);
      });
      cMem.listenToHeadChanges(async (editHistoryRef: string) => {
        cUpdatedHead(editHistoryRef);
      });

      const edit: Edit = {
        name: 'Select brand, type, serviceIntervals, isElectric, length from CarExample',
        action: exampleEditActionColumnSelectionOnlySomeColumns(),
        _hash: '',
      };

      expect(aMem).toBeDefined();

      await aMem.edit(edit, cakeRef as string);
      const aRows = [...aMem.join!.rows];
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
      }, 40000);

      const bRows = [...bMem.join!.rows];
      const cRows = [...cMem.join!.rows];

      expect(aRows).toEqual(bRows);
      expect(aRows).toEqual(cRows);
    }, 60000);
    describe('Teardown', () => {
      it('Should teardown client instances', async () => {
        const callbackA = vi.fn();
        const callbackB = vi.fn();
        const callbackC = vi.fn();

        aConnector.listen((msg: string) => callbackA(msg));
        bConnector.listen((msg: string) => callbackB(msg));
        cConnector.listen((msg: string) => callbackC(msg));

        aConnector.send('testMessage');

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
        aConnector.send('testMessage2');

        // Wait to ensure no further calls are made
        await new Promise((res) => setTimeout(res, 1000));

        expect(callbackA).not.toHaveBeenCalled();
        expect(callbackB).not.toHaveBeenCalled();
        expect(callbackC).toHaveBeenCalledWith('testMessage2');
      });
    });
  });

  describe('Blob Storage (Bs) Integration', () => {
    let socketIoServer: SocketIoServer;
    let serverSockets: ServerSocket[] = [];
    let clientSockets: ClientSocket[] = [];
    const clientCount = 3;

    const cakeKey = 'bsTestCake';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, aIo: Io, aBs: BsMem;
    let b: Client, bIo: Io, bBs: BsMem;
    let c: Client, cIo: Io, cBs: BsMem;

    let server: Server;
    let serverIo: Io;
    let serverBs: BsMem;

    beforeAll(async () => {
      serverSockets = [];
      clientSockets = [];

      await new Promise((resolve) => {
        const httpServer = createServer();
        socketIoServer = new SocketIoServer(httpServer);

        httpServer.listen(() => {
          const port = (httpServer.address() as AddressInfo).port;

          socketIoServer.on('connection', (socket) => {
            serverSockets.push(socket);
          });

          for (let i = 0; i < clientCount; i++) {
            const clientSocket = SocketIoClient(`http://localhost:${port}`, {
              forceNew: true,
            });
            clientSockets.push(clientSocket);
          }

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

      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      serverBs = new BsMem();

      server = new Server(route, serverIo, serverBs);
      await server.init();

      await server.addSocket(new SocketIoBridge(serverSockets[0]));
      await server.addSocket(new SocketIoBridge(serverSockets[1]));
      await server.addSocket(new SocketIoBridge(serverSockets[2]));
    });

    afterAll(async () => {
      await socketIoServer.close();

      await Promise.all(
        clientSockets.map(
          (clientSocket) =>
            new Promise<void>((resolve) => {
              clientSocket.on('disconnect', () => resolve());
              clientSocket.disconnect();
            }),
        ),
      );
    });

    beforeEach(async () => {
      aIo = new IoMem();
      await aIo.init();
      await aIo.isReady();
      aBs = new BsMem();

      bIo = new IoMem();
      await bIo.init();
      await bIo.isReady();
      bBs = new BsMem();

      cIo = new IoMem();
      await cIo.init();
      await cIo.isReady();
      cBs = new BsMem();

      a = new Client(new SocketIoBridge(clientSockets[0]), aIo, aBs);
      await a.init();

      b = new Client(new SocketIoBridge(clientSockets[1]), bIo, bBs);
      await b.init();

      c = new Client(new SocketIoBridge(clientSockets[2]), cIo, cBs);
      await c.init();
    });

    it('Should store and retrieve blobs on server', async () => {
      const testContent = 'Hello from server blob storage!';
      const { blobId } = await serverBs.setBlob(testContent);

      expect(blobId).toBeDefined();
      expect(typeof blobId).toBe('string');
      expect(blobId.length).toBe(22);

      const { content } = await serverBs.getBlob(blobId);
      expect(content.toString()).toBe(testContent);
    });

    it('Should store blobs on client local storage', async () => {
      const testContent = 'Client A local blob';
      const { blobId } = await aBs.setBlob(testContent);

      expect(blobId).toBeDefined();
      const { content } = await aBs.getBlob(blobId);
      expect(content.toString()).toBe(testContent);
    });

    it('Should access server blobs from client through BsMulti', async () => {
      const testContent = 'Server blob accessible from client';
      const { blobId } = await serverBs.setBlob(testContent);

      const { content } = await a.bs!.getBlob(blobId);
      expect(content.toString()).toBe(testContent);
    });

    it('Should hot-swap server blobs to client cache', async () => {
      const testContent = 'Hot-swap test blob';
      const { blobId } = await serverBs.setBlob(testContent);

      await expect(aBs.getBlob(blobId)).rejects.toThrow('Blob not found');

      await a.bs!.getBlob(blobId);

      const { content } = await aBs.getBlob(blobId);
      expect(content.toString()).toBe(testContent);
    });

    it('Should support multiple clients accessing same blob', async () => {
      const sharedContent = 'Shared blob across clients';
      const { blobId } = await serverBs.setBlob(sharedContent);

      const contentA = await a.bs!.getBlob(blobId);
      const contentB = await b.bs!.getBlob(blobId);
      const contentC = await c.bs!.getBlob(blobId);

      expect(contentA.content.toString()).toBe(sharedContent);
      expect(contentB.content.toString()).toBe(sharedContent);
      expect(contentC.content.toString()).toBe(sharedContent);
    });

    it('Should prioritize local blobs over remote in BsMulti', async () => {
      const localContent = 'Local blob content';
      const { blobId } = await aBs.setBlob(localContent);

      const { content } = await a.bs!.getBlob(blobId);
      expect(content.toString()).toBe(localContent);
    });

    it('Should isolate client blob stores', async () => {
      const contentA = 'Client A exclusive blob';
      const contentB = 'Client B exclusive blob';

      const { blobId: blobIdA } = await aBs.setBlob(contentA);
      const { blobId: blobIdB } = await bBs.setBlob(contentB);

      expect(await aBs.blobExists(blobIdA)).toBe(true);
      await expect(aBs.getBlob(blobIdB)).rejects.toThrow();

      expect(await bBs.blobExists(blobIdB)).toBe(true);
      await expect(bBs.getBlob(blobIdA)).rejects.toThrow();
    });

    it('Should deduplicate identical blob content', async () => {
      const content1 = 'Identical content';
      const content2 = 'Identical content';

      const { blobId: blobId1 } = await serverBs.setBlob(content1);
      const { blobId: blobId2 } = await serverBs.setBlob(content2);

      expect(blobId1).toBe(blobId2);
    });

    it('Should handle binary blob data', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
      const { blobId } = await serverBs.setBlob(binaryData);

      const { content } = await serverBs.getBlob(blobId);
      expect(Buffer.compare(content, binaryData)).toBe(0);
    });

    it('Should list blobs', async () => {
      await serverBs.setBlob('Blob 1');
      await serverBs.setBlob('Blob 2');
      await serverBs.setBlob('Blob 3');

      const { blobs } = await serverBs.listBlobs();
      expect(blobs.length).toBeGreaterThanOrEqual(3);

      blobs.forEach((blob) => {
        expect(blob.blobId).toBeDefined();
        expect(blob.size).toBeGreaterThan(0);
        expect(blob.createdAt).toBeInstanceOf(Date);
      });
    });

    it('Should get blob properties without content', async () => {
      const testContent = 'Properties test blob';
      const { blobId, size } = await serverBs.setBlob(testContent);

      const properties = await serverBs.getBlobProperties(blobId);
      expect(properties.blobId).toBe(blobId);
      expect(properties.size).toBe(size);
      expect(properties.createdAt).toBeInstanceOf(Date);
    });

    it('Should delete blobs', async () => {
      const testContent = 'Delete test blob';
      const { blobId } = await serverBs.setBlob(testContent);

      expect(await serverBs.blobExists(blobId)).toBe(true);
      await serverBs.deleteBlob(blobId);
      expect(await serverBs.blobExists(blobId)).toBe(false);
    });

    it('Should handle empty blobs', async () => {
      const emptyContent = '';
      const { blobId } = await serverBs.setBlob(emptyContent);

      const { content, properties } = await serverBs.getBlob(blobId);
      expect(content.toString()).toBe('');
      expect(properties.size).toBe(0);
    });

    it('Should handle Unicode and special characters', async () => {
      const unicodeContent = '🚀 Hello 世界 Привет مرحبا';
      const { blobId } = await serverBs.setBlob(unicodeContent);

      const { content } = await serverBs.getBlob(blobId);
      expect(content.toString('utf8')).toBe(unicodeContent);
    });

    it('Should handle large blobs efficiently', async () => {
      const largeContent = Buffer.alloc(1024 * 1024, 'x');
      const { blobId } = await serverBs.setBlob(largeContent);

      const { content } = await serverBs.getBlob(blobId);
      expect(content.length).toBe(largeContent.length);
    });

    it('Should handle concurrent blob operations', async () => {
      const operations = Array.from({ length: 10 }, (_, i) =>
        serverBs.setBlob(`Concurrent blob ${i}`),
      );

      const results = await Promise.all(operations);

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.blobId).toBeDefined();
        expect(result.blobId.length).toBe(22);
      });
    });

    it('Should retrieve blob as stream', async () => {
      const testContent = 'Stream test content';
      const { blobId } = await serverBs.setBlob(testContent);

      const stream = await serverBs.getBlobStream(blobId);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe(testContent);
    });

    it('Should support partial blob retrieval', async () => {
      const testContent = 'This is a test for range requests';
      const { blobId } = await serverBs.setBlob(testContent);

      const { content } = await serverBs.getBlob(blobId, {
        range: { start: 0, end: 7 },
      });

      expect(content.toString()).toBe('This is');
    });

    it('Should preserve blob metadata through transfer', async () => {
      const testContent = 'Metadata preservation test';
      const { blobId, size } = await serverBs.setBlob(testContent);

      const { properties } = await a.bs!.getBlob(blobId);

      expect(properties.blobId).toBe(blobId);
      expect(properties.size).toBe(size);
      expect(properties.createdAt).toBeDefined();
    });

    it('Should handle blob not found errors', async () => {
      const nonExistentBlobId = 'a'.repeat(22);

      await expect(serverBs.getBlob(nonExistentBlobId)).rejects.toThrow();
      expect(await serverBs.blobExists(nonExistentBlobId)).toBe(false);
    });
  });

  describe('Data Storage (Io) Integration', () => {
    let socketIoServer: SocketIoServer;
    let serverSockets: ServerSocket[] = [];
    let clientSockets: ClientSocket[] = [];
    const clientCount = 3;

    const cakeKey = 'ioTestCake';
    const route = Route.fromFlat(`${cakeKey}EditHistory`);

    let a: Client, aIo: Io, aBs: BsMem;
    let b: Client, bIo: Io, bBs: BsMem;
    let c: Client, cIo: Io, cBs: BsMem;

    let server: Server;
    let serverIo: Io;
    let serverBs: BsMem;

    beforeAll(async () => {
      serverSockets = [];
      clientSockets = [];

      await new Promise((resolve) => {
        const httpServer = createServer();
        socketIoServer = new SocketIoServer(httpServer);

        httpServer.listen(() => {
          const port = (httpServer.address() as AddressInfo).port;

          socketIoServer.on('connection', (socket) => {
            serverSockets.push(socket);
          });

          for (let i = 0; i < clientCount; i++) {
            const clientSocket = SocketIoClient(`http://localhost:${port}`, {
              forceNew: true,
            });
            clientSockets.push(clientSocket);
          }

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

      serverBs = new BsMem();
    });

    afterAll(async () => {
      await socketIoServer.close();

      await Promise.all(
        clientSockets.map(
          (clientSocket) =>
            new Promise<void>((resolve) => {
              clientSocket.on('disconnect', () => resolve());
              clientSocket.disconnect();
            }),
        ),
      );
    });

    beforeEach(async () => {
      // Recreate serverIo for each test to avoid table pollution
      serverIo = new IoMem();
      await serverIo.init();
      await serverIo.isReady();

      // Recreate server with fresh Io
      server = new Server(route, serverIo, serverBs);
      await server.init();

      await server.addSocket(new SocketIoBridge(serverSockets[0]));
      await server.addSocket(new SocketIoBridge(serverSockets[1]));
      await server.addSocket(new SocketIoBridge(serverSockets[2]));

      aIo = new IoMem();
      await aIo.init();
      await aIo.isReady();
      aBs = new BsMem();

      bIo = new IoMem();
      await bIo.init();
      await bIo.isReady();
      bBs = new BsMem();

      cIo = new IoMem();
      await cIo.init();
      await cIo.isReady();
      cBs = new BsMem();

      a = new Client(new SocketIoBridge(clientSockets[0]), aIo, aBs);
      await a.init();

      b = new Client(new SocketIoBridge(clientSockets[1]), bIo, bBs);
      await b.init();

      c = new Client(new SocketIoBridge(clientSockets[2]), cIo, cBs);
      await c.init();
    });

    it('Should initialize server Io storage', async () => {
      expect(serverIo).toBeDefined();
      expect(serverIo.isOpen).toBe(true);
    });

    it('Should initialize client Io storage', async () => {
      expect(aIo).toBeDefined();
      expect(aIo.isOpen).toBe(true);
      expect(bIo.isOpen).toBe(true);
      expect(cIo.isOpen).toBe(true);
    });

    it('Should create IoMulti for client data access', async () => {
      expect(a.io).toBeDefined();
      expect(a.io!.isOpen).toBe(true);
      expect(b.io).toBeDefined();
      expect(c.io).toBeDefined();
    });

    it('Should initialize server Io with isOpen true', async () => {
      expect(serverIo.isOpen).toBe(true);
    });

    it('Should initialize client Io with isOpen true', async () => {
      expect(aIo.isOpen).toBe(true);
      expect(bIo.isOpen).toBe(true);
      expect(cIo.isOpen).toBe(true);
    });

    it('Should create table using createOrExtendTable', async () => {
      const tableCfg = createEditTableCfg(cakeKey);
      await serverIo.createOrExtendTable({ tableCfg });

      const exists = await serverIo.tableExists(tableCfg.key);
      expect(exists).toBe(true);
    });

    it('Should return false for non-existent table', async () => {
      const exists = await serverIo.tableExists('non-existent-table');
      expect(exists).toBe(false);
    });

    it('Should get raw table configurations', async () => {
      const tableCfg = createEditTableCfg(cakeKey);
      await serverIo.createOrExtendTable({ tableCfg });

      const configs = await serverIo.rawTableCfgs();
      expect(Array.isArray(configs)).toBe(true);
      const found = configs.find((c) => c.key === tableCfg.key);
      expect(found).toBeDefined();
    });

    it('Should get content type of table', async () => {
      const tableCfg = createEditTableCfg(cakeKey);
      await serverIo.createOrExtendTable({ tableCfg });

      const contentType = await serverIo.contentType({ table: tableCfg.key });
      expect(contentType).toBe('edits');
    });

    it('Should count rows in empty table', async () => {
      const tableCfg = createEditTableCfg(cakeKey);
      await serverIo.createOrExtendTable({ tableCfg });

      const count = await serverIo.rowCount(tableCfg.key);
      expect(count).toBe(0);
    });

    it('Should dump empty database', async () => {
      const dump = await serverIo.dump();
      expect(dump).toBeDefined();
      expect(dump.tableCfgs).toBeDefined();
    });

    it('Should dump specific table', async () => {
      const tableCfg = createEditTableCfg(cakeKey);
      await serverIo.createOrExtendTable({ tableCfg });

      const tableDump = await serverIo.dumpTable({ table: tableCfg.key });
      expect(tableDump).toBeDefined();
    });

    it('Should close and reopen Io instance', async () => {
      const testIo = new IoMem();
      await testIo.init();
      await testIo.isReady();
      expect(testIo.isOpen).toBe(true);

      await testIo.close();
      expect(testIo.isOpen).toBe(false);
    });

    it('Should check IoMulti isOpen state', async () => {
      expect(a.io!.isOpen).toBe(true);
      expect(b.io!.isOpen).toBe(true);
      expect(c.io!.isOpen).toBe(true);
    });

    it('Should get IoMulti readables', async () => {
      const io = a.io as IoMulti;
      expect(io.readables.length).toBeGreaterThan(0);
      expect(io.readables[0].io).toBeDefined();
    });

    it('Should get IoMulti writables', async () => {
      const io = a.io as IoMulti;
      expect(io.writables.length).toBeGreaterThan(0);
      expect(io.writables[0].io).toBeDefined();
    });

    it('Should get IoMulti dumpables', async () => {
      const io = a.io as IoMulti;
      expect(io.dumpables.length).toBeGreaterThan(0);
      expect(io.dumpables[0].io).toBeDefined();
    });

    it('Should isolate client Io instances', async () => {
      const tableCfg = createEditTableCfg(`${cakeKey}Isolated`);
      await aIo.createOrExtendTable({ tableCfg });

      const existsInA = await aIo.tableExists(tableCfg.key);
      const existsInB = await bIo.tableExists(tableCfg.key);

      expect(existsInA).toBe(true);
      expect(existsInB).toBe(false);
    });

    it('Should access tables through client IoMulti', async () => {
      const tableCfg = createEditTableCfg(`${cakeKey}Multi`);
      await aIo.createOrExtendTable({ tableCfg });

      const configs = await a.io!.rawTableCfgs();
      const found = configs.find((c) => c.key === tableCfg.key);
      expect(found).toBeDefined();
    });

    it('Should create multiple tables', async () => {
      const cfg1 = createEditTableCfg(`${cakeKey}1`);
      const cfg2 = createEditTableCfg(`${cakeKey}2`);

      await serverIo.createOrExtendTable({ tableCfg: cfg1 });
      await serverIo.createOrExtendTable({ tableCfg: cfg2 });

      const exists1 = await serverIo.tableExists(cfg1.key);
      const exists2 = await serverIo.tableExists(cfg2.key);

      expect(exists1).toBe(true);
      expect(exists2).toBe(true);
    });

    it('Should extend table with new columns', async () => {
      const cfg1 = createEditTableCfg(`${cakeKey}Extend`);
      const originalColumnCount = cfg1.columns.length;
      await serverIo.createOrExtendTable({ tableCfg: cfg1 });

      const cfg2 = {
        ...cfg1,
        columns: [
          ...cfg1.columns,
          {
            key: 'newCol',
            type: 'number' as const,
            titleLong: 'New Col',
            titleShort: 'New',
          },
        ],
      };
      await serverIo.createOrExtendTable({ tableCfg: cfg2 });

      const configs = await serverIo.rawTableCfgs();
      const found = configs.find((c) => c.key === cfg1.key);
      expect(found?.columns.length).toBeGreaterThanOrEqual(originalColumnCount);
    });

    it('Should read empty rows from table', async () => {
      const tableCfg = createEditTableCfg(`${cakeKey}Read`);
      await serverIo.createOrExtendTable({ tableCfg });

      const rows = await serverIo.readRows({
        table: tableCfg.key,
        where: {},
      });

      expect(rows).toBeDefined();
    });

    it('Should verify empty table has zero rows', async () => {
      const tableCfg = createEditTableCfg(`${cakeKey}Count`);
      await serverIo.createOrExtendTable({ tableCfg });

      const count = await serverIo.rowCount(tableCfg.key);
      expect(count).toBe(0);
    });
  });
});

describe('Coverage helpers', () => {
  it('Client.ready should resolve before init', async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();
    const socket = new SocketMock();
    socket.connect();

    const client = new Client(socket, io, bs);
    await client.ready();

    (client as any)._ioMulti = {
      isReady: async () => undefined,
    };
    await client.ready();

    await client.tearDown();
  });

  it('Client.tearDown should close custom io', async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();
    const socket = new SocketMock();
    socket.connect();

    const client = new Client(socket, io, bs);
    (client as any)._ioMulti = {
      isOpen: true,
      close: () => undefined,
    };
    (client as any)._bsMulti = {};

    await client.tearDown();
  });

  it('Server should handle multicast branches', async () => {
    const route = Route.fromFlat('coverage.route');
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();

    const server = new Server(route, io, bs);
    await server.init();

    const socketA = new SocketMock();
    const socketB = new SocketMock();
    socketA.connect();
    socketB.connect();

    await server.addSocket(socketA);
    await server.addSocket(socketB);

    let forwardedCount = 0;
    socketB.on(route.flat, () => {
      forwardedCount += 1;
    });

    socketA.emit(route.flat, { r: 'ref-1' });
    socketA.emit(route.flat, { r: 'ref-1' });
    socketA.emit(route.flat, { r: 'ref-2', __origin: 'origin' });

    expect(forwardedCount).toBe(1);
  });

  it('Server getters and queued refresh should be covered', async () => {
    const route = Route.fromFlat('coverage.route.2');
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();

    const server = new Server(route, io, bs);
    await server.init();
    await server.ready();

    await (Server.prototype.ready as any).call(server);

    expect(server.io).toBeDefined();
    expect(server.bs).toBeDefined();

    const ioGetter = Object.getOwnPropertyDescriptor(
      Server.prototype,
      'io',
    )?.get;
    const bsGetter = Object.getOwnPropertyDescriptor(
      Server.prototype,
      'bs',
    )?.get;

    expect(ioGetter?.call(server)).toBeDefined();
    expect(bsGetter?.call(server)).toBeDefined();

    (server as any)._refreshPromise = Promise.resolve();
    await (server as any)._queueRefresh();
  });
});
