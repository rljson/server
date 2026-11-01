// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
import { ConnectorPayload, exampleTableCfg } from '@rljson/rljson';

import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as socketIoClient, Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client.ts';
import { HubRoutes } from '../src/hub-routes.ts';
import { BufferedLogger } from '../src/logger.ts';
import { peerReadEvents } from '../src/peer-reads.ts';
import { SocketIoBridge } from '../src/socket-io-bridge.ts';

// .............................................................................
// A hub for many routes: one Server per route, every connection routed to the
// route it names, routes created on demand, legacy connections in every route.
// .............................................................................

/** Connects a socket pair to a route of the hub; returns the client side. */
const connect = async (
  hub: HubRoutes,
  treeKeys: string[] | undefined,
): Promise<{ hubSide: DirectionalSocketMock; clientSide: DirectionalSocketMock }> => {
  const [hubSide, clientSide] = createSocketPair();
  hubSide.connect();
  await hub.addSocket(hubSide, treeKeys);
  return { hubSide, clientSide };
};

/** Records the refs relayed to a client side. */
const received = (socket: DirectionalSocketMock, treeKey: string) => {
  const refs: string[] = [];
  socket.on(`/${treeKey}`, (payload: ConnectorPayload) => refs.push(payload.r));
  return refs;
};

describe('HubRoutes', () => {
  let hub: HubRoutes | undefined;

  afterEach(async () => {
    if (hub && !hub.isTornDown) await hub.tearDown();
    hub = undefined;
  });

  // ...........................................................................
  describe('init()', () => {
    it('creates the configured routes once each', async () => {
      const createStores = vi.fn(async () => {
        const io = new IoMem();
        await io.init();
        return { io, bs: new BsMem() };
      });
      hub = new HubRoutes({
        treeKeys: ['aTree', 'bRoute', 'aTree'],
        createStores,
      });
      await hub.init();

      expect([...hub.servers.keys()]).toEqual(['aTree', 'bRoute']);
      expect(createStores.mock.calls).toEqual([['aTree'], ['bRoute']]);
      expect(hub.server('aTree')!.route.flat).toBe('/aTree');
      expect(hub.server('unknown')).toBeUndefined();
    });

    it('creates nothing without configured routes', async () => {
      hub = HubRoutes.example();
      await hub.init();
      expect(hub.servers.size).toBe(0);
    });
  });

  // ...........................................................................
  describe('routing', () => {
    it('relays a ref only to the clients of its own route', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      const a1 = await connect(hub, ['aTree']);
      const a2 = await connect(hub, ['aTree']);
      const b1 = await connect(hub, ['bTree']);
      const a2Refs = received(a2.clientSide, 'aTree');
      const b1OnA = received(b1.clientSide, 'aTree');
      const b1OnB = received(b1.clientSide, 'bTree');

      a1.clientSide.emit('/aTree', { o: 'a1', r: 'ref-a' });

      expect(a2Refs).toEqual(['ref-a']);
      expect([...b1OnA, ...b1OnB]).toEqual([]);
      expect(hub.server('aTree')!.clients.size).toBe(2);
      expect(hub.server('bTree')!.clients.size).toBe(1);
    });

    it('creates a route nobody configured on its first connection', async () => {
      hub = HubRoutes.example();
      await hub.init();

      await connect(hub, ['newTree']);

      expect([...hub.servers.keys()]).toEqual(['newTree']);
    });

    it('creates a route once when several connect to it at the same time', async () => {
      const createStores = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const io = new IoMem();
        await io.init();
        return { io };
      });
      hub = new HubRoutes({ createStores });

      await Promise.all([
        connect(hub, ['newTree']),
        connect(hub, ['newTree']),
        connect(hub, ['newTree']),
      ]);

      expect(createStores).toHaveBeenCalledTimes(1);
      expect(hub.server('newTree')!.clients.size).toBe(3);
    });

    it('builds a route without blobs when its stores have none', async () => {
      hub = new HubRoutes({
        createStores: async () => {
          const io = new IoMem();
          await io.init();
          return { io };
        },
      });
      const server = await hub.ensure('mongoRoute');
      expect(server.ownBs).toBeDefined();
      await expect(server.ownBs.getBlob('missing')).rejects.toThrow();
    });

    it('gives each route the server options made for it', async () => {
      const serverOptions = vi.fn(() => ({ refLogSize: 7 }));
      hub = HubRoutes.example({ serverOptions, treeKeys: ['aTree'] });
      await hub.init();
      await hub.ensure('bTree');
      expect(serverOptions.mock.calls).toEqual([['aTree'], ['bTree']]);
    });

    it('logs the routes it creates', async () => {
      const logger = new BufferedLogger();
      hub = HubRoutes.example({ logger, treeKeys: ['aTree'] });
      await hub.init();
      expect(logger.byLevel('info')).toContainEqual(
        expect.objectContaining({
          source: 'HubRoutes',
          message: 'Route created',
          data: { treeKey: 'aTree', blobs: true },
        }),
      );
    });
  });

  // ...........................................................................
  describe('legacy connections', () => {
    it('adds a connection that names no route to every route, and counts it until it leaves', async () => {
      const logger = new BufferedLogger();
      hub = HubRoutes.example({ logger, treeKeys: ['aTree', 'bTree'] });
      await hub.init();

      const legacy = await connect(hub, undefined);
      const several = await connect(hub, ['aTree', 'bTree']);

      expect(hub.legacySockets).toBe(2);
      expect(hub.server('aTree')!.clients.size).toBe(2);
      expect(hub.server('bTree')!.clients.size).toBe(2);
      expect(logger.byLevel('warn')).toHaveLength(2);

      legacy.hubSide.disconnect();
      several.hubSide.disconnect();
      expect(hub.legacySockets).toBe(0);
    });

    it('adds a legacy connection to the other routes when one of them fails, and reports it', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      vi.spyOn(hub.server('aTree')!, 'addSocket').mockRejectedValue(
        new Error('aTree broke'),
      );

      await expect(connect(hub, undefined)).rejects.toThrow('aTree broke');

      expect(hub.server('bTree')!.clients.size).toBe(1);
    });

    it('relays to a legacy connection from every route', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      const legacy = await connect(hub, []);
      const a = await connect(hub, ['aTree']);
      const b = await connect(hub, ['bTree']);
      const onA = received(legacy.clientSide, 'aTree');
      const onB = received(legacy.clientSide, 'bTree');

      a.clientSide.emit('/aTree', { o: 'a', r: 'ref-a' });
      b.clientSide.emit('/bTree', { o: 'b', r: 'ref-b' });

      expect([...onA, ...onB]).toEqual(['ref-a', 'ref-b']);
    });
  });

  // ...........................................................................
  describe('connectedNodes', () => {
    it('lists the nodes that said hello on any route, once each', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      const a = await connect(hub, ['aTree']);
      const b = await connect(hub, ['bTree']);
      const again = await connect(hub, ['bTree']);
      await connect(hub, ['bTree']); // says no hello

      a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });
      b.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-b' });
      again.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });

      expect(hub.connectedNodes.sort()).toEqual(['node-a', 'node-b']);
    });
  });

  // ...........................................................................
  describe('failures and teardown', () => {
    it('does not keep a route whose stores could not be created, and retries it', async () => {
      let fail = true;
      hub = new HubRoutes({
        createStores: async () => {
          if (fail) throw new Error('disk full');
          const io = new IoMem();
          await io.init();
          return { io };
        },
      });

      await expect(hub.ensure('aTree')).rejects.toThrow('disk full');
      expect(hub.servers.size).toBe(0);

      fail = false;
      await expect(hub.ensure('aTree')).resolves.toBeDefined();
    });

    it('tears down every route', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      const servers = [...hub.servers.values()];

      await hub.tearDown();

      expect(hub.isTornDown).toBe(true);
      expect(hub.servers.size).toBe(0);
      expect(servers.map((s) => s.isTornDown)).toEqual([true, true]);
      await expect(hub.ensure('aTree')).rejects.toThrow('torn down');
    });

    it('tears down a route that was still being created', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      hub = new HubRoutes({
        createStores: async () => {
          await gate;
          const io = new IoMem();
          await io.init();
          return { io };
        },
      });

      const creating = hub.ensure('aTree');
      const tearingDown = hub.tearDown();
      release();

      await expect(creating).rejects.toThrow('torn down');
      await tearingDown;
      expect(hub.servers.size).toBe(0);
    });
  });

  // ...........................................................................
  describe('over real Socket.IO', () => {
    let httpServer: HttpServer;
    let ioServer: SocketIoServer;
    const sockets: ClientSocket[] = [];
    const clients: Client[] = [];

    afterEach(async () => {
      for (const client of clients.splice(0)) await client.tearDown();
      for (const socket of sockets.splice(0)) socket.disconnect();
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    });

    it('keeps the reads of one route away from the clients of another', async () => {
      hub = HubRoutes.example({ treeKeys: ['aTree', 'bTree'] });
      await hub.init();
      httpServer = createServer();
      ioServer = new SocketIoServer(httpServer);
      ioServer.on('connection', (socket) => {
        void hub!.addSocket(
          new SocketIoBridge(socket),
          socket.handshake.auth?.treeKeys,
        );
      });
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const port = (httpServer.address() as AddressInfo).port;

      const join = async (treeKey: string) => {
        const socket = socketIoClient(`http://localhost:${port}`, {
          forceNew: true,
          transports: ['websocket'],
          auth: { treeKeys: [treeKey] },
        });
        sockets.push(socket);
        await new Promise<void>((resolve) => socket.once('connect', resolve));
        const io = new IoMem();
        await io.init();
        await io.createOrExtendTable({
          tableCfg: exampleTableCfg({ key: 'notes' }),
        });
        const asked: string[] = [];
        socket.on('readRows', () => asked.push('readRows'));
        const client = new Client(new SocketIoBridge(socket), io, new BsMem());
        await client.init();
        clients.push(client);
        return { client, io, asked };
      };

      const a1 = await join('aTree');
      const a2 = await join('aTree');
      const b = await join('bTree');
      await vi.waitFor(() => {
        expect(hub!.server('aTree')!.clients.size).toBe(2);
        expect(hub!.server('bTree')!.clients.size).toBe(1);
      });
      await a1.io.write({
        data: { notes: { _data: [{ a: 'of a1', b: 1 }] } },
      } as never);
      const dumped = await a1.io.dumpTable({ table: 'notes' });
      const hash = (dumped.notes._data[0] as { _hash: string })._hash;

      const found = await a2.client.io!.readRows({
        table: 'notes',
        where: { _hash: hash },
      });

      expect((found.notes._data[0] as { a: string }).a).toBe('of a1');
      expect(b.asked).toEqual([]);
    });
  });
});
