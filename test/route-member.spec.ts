// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, BsPeer } from '@rljson/bs';
import {
  createSocketPair,
  DirectionalSocketMock,
  IoMem,
  IoPeer,
} from '@rljson/io';
import { exampleTableCfg, Route } from '@rljson/rljson';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentHandle,
  BufferedLogger,
  ClientRoute,
  ClientRouteAgentContext,
  HubRoutes,
  LocalStores,
  peerReadEvents,
  RouteMemberContext,
  RoutePeerReads,
} from '../src/index.ts';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';

// .............................................................................
// A route member in this process: a client of the hub over local stores that
// outlive every hub change, an agent on it, and the same stores served to
// peers.
// .............................................................................

const route = Route.fromFlat('/aTree');

/** Waits until queued work of other tasks has run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A promise the test settles. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Local stores with a row in `notes` and one blob. */
const storesWithData = async () => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({
    tableCfg: exampleTableCfg({ key: 'notes' }),
  });
  await io.write({
    data: { notes: { _data: [{ a: 'x', b: 1 }] } },
  } as never);
  const bs = new BsMem();
  const { blobId } = await bs.setBlob(Buffer.from('a blob'));
  return { io, bs, blobId };
};

describe('ClientRoute', () => {
  let hub: HubRoutes;
  let logger: BufferedLogger;
  let member: ClientRoute | undefined;
  let hubSides: DirectionalSocketMock[];
  let clientSides: DirectionalSocketMock[];
  let hellos: unknown[];

  beforeEach(async () => {
    hub = HubRoutes.example({ treeKeys: ['aTree'] });
    await hub.init();
    logger = new BufferedLogger();
    hubSides = [];
    clientSides = [];
    hellos = [];
  });

  afterEach(async () => {
    await member?.close();
    member = undefined;
    await hub.tearDown();
  });

  /** Opens a connection to the hub's route, as a node would. */
  const connectHub = async (): Promise<DirectionalSocketMock> => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    hubSide.on(peerReadEvents.hello, (payload: unknown) =>
      hellos.push(payload),
    );
    await hub.addSocket(hubSide, ['aTree']);
    hubSides.push(hubSide);
    clientSides.push(clientSide);
    return clientSide;
  };

  /** What the node hands the member when it starts. */
  const context = (
    overrides: Partial<RouteMemberContext> = {},
  ): RouteMemberContext => ({
    treeKey: 'aTree',
    route,
    nodeId: 'nodeA',
    hubAddress: '127.0.0.1:1',
    connectHub,
    logger,
    ...overrides,
  });

  /** Peer reads as the node hands them over. */
  const peerReads = (): RoutePeerReads => ({
    bounds: { timeoutMs: 100 },
    resolve: () => undefined,
    connect: vi.fn(async () => undefined),
  });

  /** A peer reading from the member's local stores. */
  const connectPeer = async (target: ClientRoute) => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    await target.servePeer(serverSide);
    const io = new IoPeer(clientSide, 1000);
    const bs = new BsPeer(clientSide, { requestTimeoutMs: 1000 });
    await io.init();
    await bs.init();
    return { serverSide, io, bs };
  };

  /** An agent whose stop the test watches. */
  const agentFactory = (stop: () => Promise<void> | void = () => undefined) => {
    const contexts: ClientRouteAgentContext[] = [];
    const agents: AgentHandle[] = [];
    const createAgent = vi.fn(async (agentContext: ClientRouteAgentContext) => {
      contexts.push(agentContext);
      const agent = { stop: vi.fn(stop) };
      agents.push(agent);
      return agent;
    });
    return { createAgent, contexts, agents };
  };

  // ...........................................................................
  describe('example(options)', () => {
    it('builds a member over empty in-memory stores under the example tree key', async () => {
      member = ClientRoute.example();
      await member.start(context());

      expect(member.treeKey).toBe('exampleTree');
      await expect(member.client!.io!.tableExists('notes')).resolves.toBe(
        false,
      );
    });

    it('takes overrides', () => {
      expect(ClientRoute.example({ treeKey: 'aTree' }).treeKey).toBe('aTree');
    });
  });

  // ...........................................................................
  describe('getters', () => {
    it('report no client, agent or peer server before the first start', () => {
      member = ClientRoute.example();

      expect([member.client, member.agent, member.peerServer]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });
  });

  // ...........................................................................
  describe('start(context)', () => {
    it('connects a client without a route to the hub, saying hello with its node id', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });

      await member.start(context());

      const client = member.client!;
      expect(client.route).toBeUndefined();
      expect(client.peerReads).toBeUndefined();
      expect(client.logger).toBe(logger);
      expect(hellos).toEqual([{ nodeId: 'nodeA' }]);
      expect(hub.server('aTree')!.connectedNodes).toEqual(['nodeA']);
      expect(member.agent).toBeUndefined();
    });

    it('puts the local stores in front of the hub, without owning them', async () => {
      const stores = await storesWithData();
      member = new ClientRoute({
        treeKey: 'aTree',
        openStores: async () => stores,
      });

      await member.start(context());
      const rows = await member.client!.io!.readRows({
        table: 'notes',
        where: {},
      });
      await member.stop();

      expect((rows.notes._data[0] as { a: string }).a).toBe('x');
      expect(stores.io.isOpen).toBe(true);
    });

    it('passes further client options on to the client, and tears the connection down when the client cannot initialize', async () => {
      member = ClientRoute.example({
        treeKey: 'aTree',
        clientOptions: { peerInitTimeoutMs: 30 },
      });
      // A connection that never comes up: only the client's own bound, an
      // option of the member, ends the wait.
      const [, silent] = createSocketPair();
      silent.connect = () => undefined;
      const disconnect = vi.spyOn(silent, 'disconnect');

      await expect(
        member.start(context({ connectHub: async () => silent })),
      ).rejects.toThrow('Timeout after 30ms: IoPeer init');
      expect(member.client).toBeUndefined();
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('gives the client the peer reads of the context, with its node id and route', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });
      const reads = peerReads();

      await member.start(context({ peerReads: reads }));
      hubSides[0].emit(route.flat, { o: 'hub', r: 'ref-1', src: 'nodeB' });

      expect(member.client!.peerReads!.nodeId).toBe('nodeA');
      expect(hellos).toEqual([{ nodeId: 'nodeA' }]);
      await vi.waitFor(() =>
        expect(reads.connect).toHaveBeenCalledWith(
          'nodeB',
          expect.any(AbortSignal),
        ),
      );
    });

    it('starts the agent with the client, the hub connection, the route and the identity', async () => {
      const { createAgent, contexts, agents } = agentFactory();
      member = ClientRoute.example({ treeKey: 'aTree', createAgent });

      await member.start(context());

      expect(contexts).toEqual([
        {
          client: member.client,
          socket: clientSides[0],
          route,
          treeKey: 'aTree',
          nodeId: 'nodeA',
          hubAddress: '127.0.0.1:1',
          logger,
        },
      ]);
      expect(member.agent).toBe(agents[0]);
    });

    it('stops a started member before it starts again, and opens its stores once', async () => {
      const openStores = vi.fn(async () => ({
        io: (await storesWithData()).io,
      }));
      const { createAgent, agents } = agentFactory();
      member = new ClientRoute({ treeKey: 'aTree', openStores, createAgent });

      await member.start(context());
      const firstClient = member.client;
      await member.start(context({ hubAddress: '127.0.0.1:2' }));

      expect(agents[0].stop).toHaveBeenCalledTimes(1);
      expect(agents[1].stop).not.toHaveBeenCalled();
      expect(clientSides.map((s) => s.connected)).toEqual([false, true]);
      expect(member.client).not.toBe(firstClient);
      expect(member.agent).toBe(agents[1]);
      expect(openStores).toHaveBeenCalledTimes(1);
    });

    it('tries to open the stores again when opening failed', async () => {
      const openStores = vi
        .fn<() => Promise<LocalStores>>()
        .mockRejectedValueOnce(new Error('disk busy'))
        .mockImplementation(async () => ({
          io: (await storesWithData()).io,
        }));
      member = new ClientRoute({ treeKey: 'aTree', openStores });

      await expect(member.start(context())).rejects.toThrow('disk busy');
      expect(clientSides).toEqual([]);
      await member.start(context());

      expect(openStores).toHaveBeenCalledTimes(2);
      expect(member.client).toBeDefined();
    });

    it('rethrows when the hub cannot be reached, and stays stopped', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });

      await expect(
        member.start(
          context({
            connectHub: () => Promise.reject(new Error('hub unreachable')),
          }),
        ),
      ).rejects.toThrow('hub unreachable');

      expect(member.client).toBeUndefined();
    });

    it('tears the connection down and rethrows when the client cannot be built', async () => {
      // An Io that was never opened: the client refuses it.
      member = new ClientRoute({
        treeKey: 'aTree',
        openStores: async () => ({ io: new IoMem() }),
      });

      await expect(member.start(context())).rejects.toThrow(
        'Local Io must be initialized and open',
      );

      expect(member.client).toBeUndefined();
      expect(clientSides[0].connected).toBe(false);
    });

    it('tears client and connection down and rethrows when the agent cannot start', async () => {
      member = ClientRoute.example({
        treeKey: 'aTree',
        createAgent: () => Promise.reject(new Error('agent broken')),
      });

      await expect(member.start(context())).rejects.toThrow('agent broken');

      expect([member.client, member.agent]).toEqual([undefined, undefined]);
      expect(clientSides[0].connected).toBe(false);
    });
  });

  // ...........................................................................
  describe('stop()', () => {
    it('stops the agent, tears the client down and disconnects from the hub', async () => {
      const { createAgent, agents } = agentFactory();
      member = ClientRoute.example({ treeKey: 'aTree', createAgent });
      await member.start(context());

      await member.stop();

      expect(agents[0].stop).toHaveBeenCalledTimes(1);
      expect([member.client, member.agent]).toEqual([undefined, undefined]);
      expect(clientSides[0].connected).toBe(false);
      expect(hub.server('aTree')!.connectedNodes).toEqual([]);
    });

    it('logs an agent that fails to stop and stops the rest anyway', async () => {
      const { createAgent } = agentFactory(() => {
        throw new Error('agent stuck');
      });
      member = ClientRoute.example({ treeKey: 'aTree', createAgent });
      await member.start(context());

      await member.stop();

      const failures = logger.entries.filter((e) => e.source === 'ClientRoute');
      expect(failures).toEqual([
        expect.objectContaining({
          level: 'error',
          message: 'Agent stop failed',
          error: new Error('agent stuck'),
          data: { treeKey: 'aTree' },
        }),
      ]);
      expect(member.client).toBeUndefined();
      expect(clientSides[0].connected).toBe(false);
    });

    it('does nothing on a member never started', async () => {
      member = ClientRoute.example();

      await member.stop();

      expect(member.client).toBeUndefined();
    });

    it('aborts a hub connection still being opened', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });
      let signal: AbortSignal | undefined;
      const connecting = deferred<void>();
      const pendingConnect = (s: AbortSignal) => {
        signal = s;
        connecting.resolve();
        return new Promise<never>((_resolve, reject) =>
          s.addEventListener('abort', () => reject(new Error('aborted'))),
        );
      };

      const starting = member.start(context({ connectHub: pendingConnect }));
      await connecting.promise;
      expect(signal!.aborted).toBe(false);
      await member.stop();

      expect(signal!.aborted).toBe(true);
      await expect(starting).rejects.toThrow('aborted');
      expect(member.client).toBeUndefined();
    });

    it('drops a hub connection that arrived after it was stopped', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });
      const opened = deferred<void>();
      const release = deferred<void>();
      const [hubSide, clientSide] = createSocketPair();
      hubSide.connect();
      const lateConnect = async () => {
        opened.resolve();
        await release.promise;
        return clientSide;
      };

      const starting = member.start(context({ connectHub: lateConnect }));
      await opened.promise;
      const stopping = member.stop();
      release.resolve();

      await expect(starting).rejects.toThrow('Stopped while connecting');
      await stopping;
      expect(member.client).toBeUndefined();
      expect(clientSide.connected).toBe(false);
    });

    it('writes the logs of a peer served before its first start to the node logger', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });
      const early = createSocketPair();
      early[0].connect();
      await member.servePeer(early[0]);

      const nodeLogger = new BufferedLogger();
      await member.start(context({ logger: nodeLogger }));
      const later = createSocketPair();
      later[0].connect();
      await member.servePeer(later[0]);

      expect(nodeLogger.byLevel('info')).toContainEqual(
        expect.objectContaining({
          source: 'PeerReadServer',
          message: 'Serving a peer',
          data: { peers: 2 },
        }),
      );
    });

    it('disconnects every socket of a hub connection split into namespaces', async () => {
      member = ClientRoute.example({ treeKey: 'aTree' });
      const [ioUp, ioDown, bsUp, bsDown] = [1, 2, 3, 4].map(() =>
        createSocketPair(),
      );
      const pairs = [ioUp, ioDown, bsUp, bsDown];
      const bundle = (side: 0 | 1): SocketNamespaceBundle => ({
        ioUp: ioUp[side],
        ioDown: ioDown[side],
        bsUp: bsUp[side],
        bsDown: bsDown[side],
      });
      const connectBundle = async () => {
        for (const [hubSide, clientSide] of pairs) {
          hubSide.connect();
          clientSide.connect();
        }
        await hub.addSocket(bundle(0), ['aTree']);
        return bundle(1);
      };
      await member.start(context({ connectHub: connectBundle }));
      expect(pairs.map(([, client]) => client.connected)).toEqual([
        true,
        true,
        true,
        true,
      ]);

      await member.stop();

      expect(pairs.map(([, client]) => client.connected)).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });
  });

  // ...........................................................................
  describe('servePeer(socket)', () => {
    it('serves the local rows and blobs to a peer before the member started', async () => {
      const stores = await storesWithData();
      const openStores = vi.fn(async () => stores);
      member = new ClientRoute({ treeKey: 'aTree', openStores });

      const peer = await connectPeer(member);
      const rows = await peer.io.readRows({ table: 'notes', where: {} });
      const blob = await peer.bs.getBlob(stores.blobId);
      await member.start(context());

      expect((rows.notes._data[0] as { a: string }).a).toBe('x');
      expect(blob.content.toString()).toBe('a blob');
      expect(member.peerServer!.stats).toEqual({ rowReads: 1, blobReads: 1 });
      expect(openStores).toHaveBeenCalledTimes(1);
    });

    it('serves every peer with one server, logging to the node once started', async () => {
      member = ClientRoute.example({
        treeKey: 'aTree',
        serve: { maxConcurrentServes: 1 },
      });
      await member.start(context());

      await connectPeer(member);
      const server = member.peerServer;
      await connectPeer(member);

      expect(member.peerServer).toBe(server);
      expect(server!.peerCount).toBe(2);
      expect(
        logger.entries.filter((e) => e.source === 'PeerReadServer').length,
      ).toBe(2);
    });

    it('keeps serving peers while the member is stopped', async () => {
      const stores = await storesWithData();
      member = new ClientRoute({
        treeKey: 'aTree',
        openStores: async () => stores,
      });
      await member.start(context());
      const peer = await connectPeer(member);

      await member.stop();
      const rows = await peer.io.readRows({ table: 'notes', where: {} });

      expect(rows.notes._data.length).toBe(1);
    });
  });

  // ...........................................................................
  describe('close()', () => {
    it('stops, disconnects every peer and releases the stores', async () => {
      const stores = await storesWithData();
      const close = vi.fn(async () => undefined);
      const { createAgent, agents } = agentFactory();
      member = new ClientRoute({
        treeKey: 'aTree',
        openStores: async () => ({ ...stores, close }),
        createAgent,
      });
      await member.start(context());
      const peer = await connectPeer(member);

      await member.close();

      expect(agents[0].stop).toHaveBeenCalledTimes(1);
      expect(clientSides[0].connected).toBe(false);
      expect(peer.serverSide.connected).toBe(false);
      expect(peer.io.isOpen).toBe(false);
      expect(member.peerServer).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('releases stores that have nothing to close, and opens them anew on the next start', async () => {
      const openStores = vi.fn(async () => ({
        io: (await storesWithData()).io,
      }));
      member = new ClientRoute({ treeKey: 'aTree', openStores });
      await member.start(context());

      await member.close();
      await member.start(context());

      expect(openStores).toHaveBeenCalledTimes(2);
    });

    it('opens nothing on a member that never opened its stores', async () => {
      const openStores = vi.fn(async () => ({ io: new IoMem() }));
      member = new ClientRoute({ treeKey: 'aTree', openStores });

      await member.close();

      expect(openStores).not.toHaveBeenCalled();
    });

    it('rethrows stores failing to open while it closes, without forgetting a newer opening', async () => {
      const first = deferred<LocalStores>();
      const stores = await storesWithData();
      const openStores = vi
        .fn<() => Promise<LocalStores>>()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(stores);
      member = new ClientRoute({ treeKey: 'aTree', openStores });

      const [serverSide] = createSocketPair();
      const serving = member.servePeer(serverSide);
      const closing = member.close();
      await settle();
      await member.start(context());
      first.reject(new Error('disk gone'));

      await expect(closing).rejects.toThrow('disk gone');
      await expect(serving).rejects.toThrow('disk gone');
      await member.stop();
      await member.start(context());
      expect(openStores).toHaveBeenCalledTimes(2);
    });
  });
});
