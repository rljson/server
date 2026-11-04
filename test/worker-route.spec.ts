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
  BufferedLogger,
  ChannelSocket,
  createChannelPair,
  MessageChannelLike,
  RouteMemberContext,
  RoutePeerReads,
  serveWorkerRoute,
  ServeWorkerRouteOptions,
  WorkerHandle,
  WorkerLaunchContext,
  WorkerRoute,
  WorkerRouteOptions,
  workerRouteEvents,
  WorkerRouteServing,
} from '../src/index.ts';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';

// .............................................................................
// A route member in a worker: the worker owns the stores and the hub
// connection, the node starts it, starts it again when it exits, and serves
// peers through its channel. The workers here run in this process, on the far
// end of a channel pair.
// .............................................................................

const route = Route.fromFlat('/aTree');

/** Waits until queued channel messages are delivered. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Waits a while. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Worker stores with a row in `notes` and one blob. */
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

/** A peer reading through a socket pair; the server side goes to `serve`. */
const connectPeer = async (
  serve: (socket: DirectionalSocketMock) => Promise<void>,
) => {
  const [serverSide, clientSide] = createSocketPair();
  serverSide.connect();
  await serve(serverSide);
  const io = new IoPeer(clientSide, 1000);
  const bs = new BsPeer(clientSide, { requestTimeoutMs: 1000 });
  await io.init();
  await bs.init();
  return { serverSide, io, bs };
};

/** A worker emulated in this process. */
interface FakeWorker {
  /** What its launcher got. */
  context: WorkerLaunchContext;
  /** Its side of serving. */
  serving: WorkerRouteServing;
  /** Its stop, as the member calls it. */
  stop: ReturnType<typeof vi.fn>;
  /** Lets it exit on its own. */
  crash: () => void;
}

describe('WorkerRoute', () => {
  let logger: BufferedLogger;
  let member: WorkerRoute | undefined;
  let workers: FakeWorker[];
  let stores: Awaited<ReturnType<typeof storesWithData>>;

  beforeEach(async () => {
    logger = new BufferedLogger();
    workers = [];
    stores = await storesWithData();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await member?.close();
    member = undefined;
  });

  /** Starts a worker on the far end of a channel pair, serving `stores`. */
  const launchWorker = async (
    context: WorkerLaunchContext,
  ): Promise<WorkerHandle> => {
    const [parentEnd, workerEnd] = createChannelPair();
    const serving = await serveWorkerRoute({
      channel: workerEnd,
      tag: context.tag,
      io: stores.io,
      bs: stores.bs,
    });
    const exited = deferred<void>();
    const stop = vi.fn(async () => {
      await serving.close();
      exited.resolve();
    });
    workers.push({ context, serving, stop, crash: () => exited.resolve() });
    return { channel: parentEnd, exited: exited.promise, stop };
  };

  /** A member whose launcher starts in-process workers. */
  const createMember = (options: Partial<WorkerRouteOptions> = {}) => {
    const launch = vi.fn((context: WorkerLaunchContext) =>
      launchWorker(context),
    );
    member = new WorkerRoute({ treeKey: 'aTree', launch, ...options });
    return { member, launch };
  };

  /** What the node hands the member when it starts. */
  const context = (
    overrides: Partial<RouteMemberContext> = {},
  ): RouteMemberContext => ({
    treeKey: 'aTree',
    route,
    nodeId: 'nodeA',
    hubAddress: '10.0.0.1:3000',
    connectHub: () => Promise.reject(new Error('the worker connects itself')),
    logger,
    ...overrides,
  });

  /** Peer reads that know one address. */
  const peerReads = (): RoutePeerReads => ({
    bounds: { timeoutMs: 100 },
    resolve: vi.fn((nodeId: string) =>
      nodeId === 'nodeB' ? '10.0.0.2:4000' : undefined,
    ),
    connect: async () => undefined,
  });

  /** The log entries of the member. */
  const memberLog = () =>
    logger.entries.filter((e) => e.source === 'WorkerRoute');

  // ...........................................................................
  describe('getters', () => {
    it('report the tree key and no worker before the first start', () => {
      const { member } = createMember();

      expect(member.treeKey).toBe('aTree');
      expect(member.launches).toBe(0);
      expect(member.isRunning).toBe(false);
      expect(member.peerServer).toBeUndefined();
    });
  });

  // ...........................................................................
  describe('start(context)', () => {
    it('launches a worker with the hub, the identity, the tag of the route and the bounds of peer reads', async () => {
      const { member, launch } = createMember();

      await member.start(context({ peerReads: peerReads() }));

      expect(launch.mock.calls).toEqual([
        [
          {
            treeKey: 'aTree',
            route,
            nodeId: 'nodeA',
            hubAddress: '10.0.0.1:3000',
            tag: 'route:aTree',
            peerReads: { timeoutMs: 100 },
          },
        ],
      ]);
      expect([member.launches, member.isRunning]).toEqual([1, true]);
      expect(member.peerServer).toBeDefined();
    });

    it('launches a worker without peer reads while they are off', async () => {
      const { member, launch } = createMember();

      await member.start(context());

      expect(launch.mock.calls[0][0]).toStrictEqual({
        treeKey: 'aTree',
        route,
        nodeId: 'nodeA',
        hubAddress: '10.0.0.1:3000',
        tag: 'route:aTree',
      });
    });

    it('stops a running worker, and disconnects its peers, before launching the next', async () => {
      const { member } = createMember();
      await member.start(context());
      const peer = await connectPeer((s) => member.servePeer(s));

      await member.start(context({ hubAddress: '10.0.0.9:3000' }));

      expect(workers[0].stop).toHaveBeenCalledTimes(1);
      expect(workers[1].stop).not.toHaveBeenCalled();
      expect(workers[1].context.hubAddress).toBe('10.0.0.9:3000');
      expect(peer.serverSide.connected).toBe(false);
      expect([member.launches, member.isRunning]).toEqual([2, true]);
    });

    it('rejects when the worker cannot be launched', async () => {
      const { member } = createMember({
        launch: () => Promise.reject(new Error('no node binary')),
      });

      await expect(member.start(context())).rejects.toThrow('no node binary');

      expect([member.launches, member.isRunning]).toEqual([1, false]);
    });

    it('stops a worker whose channel came up after the member was stopped', async () => {
      const [parentEnd] = createChannelPair();
      const stop = vi.fn(async () => undefined);
      let stopping: Promise<void> | undefined;
      const channel: MessageChannelLike = {
        send: (message) => parentEnd.send(message),
        on: (event, listener) => {
          // The node stops the member while the worker's channel comes up.
          stopping ??= member.stop();
          return parentEnd.on(event, listener);
        },
        off: (event, listener) => parentEnd.off(event, listener),
      };
      createMember({
        launch: async () => ({
          channel,
          exited: new Promise(() => {}),
          stop,
        }),
      });

      await member.start(context());
      await stopping;

      expect(stop).toHaveBeenCalledTimes(1);
      expect(member.isRunning).toBe(false);
      expect(member.peerServer).toBeUndefined();
    });

    it('stops a worker that finished launching after the member was stopped', async () => {
      const launched = deferred<WorkerHandle>();
      const { member } = createMember({ launch: () => launched.promise });
      const starting = member.start(context());
      await vi.waitFor(() => expect(member.launches).toBe(1));

      // Calls run one after the other: the stop waits for the start it
      // made void.
      const stopping = member.stop();
      const [parentEnd] = createChannelPair();
      const stop = vi.fn(async () => undefined);
      launched.resolve({
        channel: parentEnd,
        exited: new Promise(() => {}),
        stop,
      });
      await starting;
      await stopping;

      expect(stop).toHaveBeenCalledTimes(1);
      expect(member.isRunning).toBe(false);
      expect(member.peerServer).toBeUndefined();
    });
  });

  // ...........................................................................
  describe('servePeer(socket)', () => {
    it('serves the rows and blobs of the worker to a peer', async () => {
      const { member } = createMember();
      await member.start(context());

      const peer = await connectPeer((s) => member.servePeer(s));
      const rows = await peer.io.readRows({ table: 'notes', where: {} });
      const blob = await peer.bs.getBlob(stores.blobId);

      expect((rows.notes._data[0] as { a: string }).a).toBe('x');
      expect(Buffer.isBuffer(blob.content)).toBe(true);
      expect(blob.content.toString()).toBe('a blob');
      // One blob read is three requests: properties, block list, one block.
      expect(member.peerServer!.stats).toEqual({ rowReads: 1, blobReads: 3 });
    });

    it('gives up on a worker that does not answer within requestTimeoutMs', async () => {
      // A worker whose end of the channel nobody serves.
      const [parentEnd] = createChannelPair();
      const { member } = createMember({
        requestTimeoutMs: 50,
        launch: async () => ({
          channel: parentEnd,
          exited: new Promise(() => {}),
          stop: async () => undefined,
        }),
      });
      await member.start(context());
      const peer = await connectPeer((s) => member.servePeer(s));

      await expect(
        peer.io.readRows({ table: 'notes', where: {} }),
      ).rejects.toThrow('Timeout after 50ms');
    });

    it('disconnects a peer while no worker runs', async () => {
      const { member } = createMember();
      const [serverSide] = createSocketPair();
      serverSide.connect();

      await member.servePeer(serverSide);

      expect(serverSide.connected).toBe(false);
    });

    it('disconnects every socket of a peer split into namespaces while no worker runs', async () => {
      const { member } = createMember();
      const sockets = [1, 2, 3, 4].map(() => {
        const [serverSide] = createSocketPair();
        serverSide.connect();
        return serverSide;
      });
      const [ioUp, ioDown, bsUp, bsDown] = sockets;
      const bundle: SocketNamespaceBundle = { ioUp, ioDown, bsUp, bsDown };

      await member.servePeer(bundle);

      expect(sockets.map((s) => s.connected)).toEqual([
        false,
        false,
        false,
        false,
      ]);
    });
  });

  // ...........................................................................
  describe('resolving peers for the worker', () => {
    it('answers with the address the peer reads of the node resolve', async () => {
      const reads = peerReads();
      const { member } = createMember();
      await member.start(context({ peerReads: reads }));

      const known = await workers[0].serving.resolvePeer('nodeB');
      const unknown = await workers[0].serving.resolvePeer('nodeC');

      expect([known, unknown]).toEqual(['10.0.0.2:4000', undefined]);
      expect(reads.resolve).toHaveBeenCalledWith('nodeB');
      expect(reads.resolve).toHaveBeenCalledWith('nodeC');
    });

    it('answers none at once while peer reads are off', async () => {
      const { member } = createMember();
      await member.start(context());

      // Answered, not timed out: the worker waits 3000 ms for an answer.
      const answer = await Promise.race([
        workers[0].serving.resolvePeer('nodeB'),
        sleep(500).then(() => 'no answer'),
      ]);

      expect(answer).toBeUndefined();
    });

    it('lets the worker dial the peer the node resolved', async () => {
      const { member } = createMember();
      await member.start(context({ peerReads: peerReads() }));
      const [, socket] = createSocketPair();
      const dial = vi.fn(async () => socket);
      const signal = new AbortController().signal;

      const connect = workers[0].serving.connectPeer(dial);

      await expect(connect('nodeB', signal)).resolves.toBe(socket);
      await expect(connect('nodeC', signal)).resolves.toBeUndefined();
      expect(dial.mock.calls).toEqual([['10.0.0.2:4000', signal]]);
    });
  });

  // ...........................................................................
  describe('when the worker exits on its own', () => {
    it('releases it, disconnects its peers and launches a new one after respawnMs', async () => {
      const { member } = createMember({ respawnMs: 10 });
      await member.start(context());
      const peer = await connectPeer((s) => member.servePeer(s));

      workers[0].crash();
      await settle();

      expect(member.isRunning).toBe(false);
      expect(member.peerServer).toBeUndefined();
      expect(peer.serverSide.connected).toBe(false);
      expect(memberLog()).toEqual([
        expect.objectContaining({
          level: 'warn',
          message: 'Worker exited',
          data: { treeKey: 'aTree', respawnInMs: 10 },
        }),
      ]);

      await vi.waitFor(() => expect(member.isRunning).toBe(true));
      const again = await connectPeer((s) => member.servePeer(s));
      const rows = await again.io.readRows({ table: 'notes', where: {} });
      expect(member.launches).toBe(2);
      expect(rows.notes._data.length).toBe(1);
    });

    it('waits five seconds by default', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { member } = createMember();
      await member.start(context());

      workers[0].crash();
      await vi.advanceTimersByTimeAsync(4999);
      expect(member.launches).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(member.launches).toBe(2);
      expect(memberLog()[0].data).toEqual({
        treeKey: 'aTree',
        respawnInMs: 5000,
      });
    });

    it('logs a worker that cannot be launched again, and tries again', async () => {
      const { member, launch } = createMember({ respawnMs: 10 });
      await member.start(context());
      launch.mockRejectedValueOnce(new Error('out of memory'));

      workers[0].crash();

      await vi.waitFor(() => expect(member.launches).toBe(3));
      await vi.waitFor(() => expect(member.isRunning).toBe(true));
      expect(
        memberLog().map((e) => [e.level, e.message, e.error, e.data]),
      ).toEqual([
        [
          'warn',
          'Worker exited',
          undefined,
          { treeKey: 'aTree', respawnInMs: 10 },
        ],
        [
          'error',
          'Worker could not be started',
          new Error('out of memory'),
          { treeKey: 'aTree' },
        ],
      ]);
    });

    it('stops a new worker that finished launching after the member was stopped', async () => {
      const { member, launch } = createMember({ respawnMs: 10 });
      await member.start(context());
      const launched = deferred<WorkerHandle>();
      launch.mockReturnValueOnce(launched.promise);

      workers[0].crash();
      await vi.waitFor(() => expect(member.launches).toBe(2));
      const stopping = member.stop();
      const [parentEnd] = createChannelPair();
      const stop = vi.fn(async () => undefined);
      launched.resolve({
        channel: parentEnd,
        exited: new Promise(() => {}),
        stop,
      });
      await stopping;

      expect(stop).toHaveBeenCalledTimes(1);
      expect(member.isRunning).toBe(false);
    });

    it('gives up when the member was stopped while a new worker failed to launch', async () => {
      const { member, launch } = createMember({ respawnMs: 10 });
      await member.start(context());
      const launched = deferred<WorkerHandle>();
      launch.mockReturnValueOnce(launched.promise);

      workers[0].crash();
      await vi.waitFor(() => expect(member.launches).toBe(2));
      const stopping = member.stop();
      launched.reject(new Error('out of memory'));
      await stopping;
      await sleep(50);

      expect(member.launches).toBe(2);
      expect(member.isRunning).toBe(false);
      expect(memberLog().map((e) => e.message)).toEqual([
        'Worker exited',
        'Worker could not be started',
      ]);
    });

    it('launches nothing from a respawn timer a restart left behind, once stopped', async () => {
      // A relaunch fails while the node starts the member again: its retry
      // timer is overtaken by the timer of the restarted worker's own exit,
      // and only the latter is cleared by stop().
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { member, launch } = createMember({ respawnMs: 100 });
      await member.start(context());
      const relaunch = deferred<WorkerHandle>();
      launch.mockReturnValueOnce(relaunch.promise);

      workers[0].crash();
      await vi.advanceTimersByTimeAsync(100);
      expect(member.launches).toBe(2);
      const restarting = member.start(context());
      relaunch.reject(new Error('out of memory'));
      await vi.advanceTimersByTimeAsync(0);
      await restarting;
      workers[1].crash();
      await vi.advanceTimersByTimeAsync(0);
      await member.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(member.launches).toBe(3);
      expect(member.isRunning).toBe(false);
    });
  });

  // ...........................................................................
  describe('stop()', () => {
    it('stops the worker, waits for it and disconnects its peers', async () => {
      const { member } = createMember({ respawnMs: 10 });
      await member.start(context());
      const peer = await connectPeer((s) => member.servePeer(s));

      await member.stop();
      await sleep(30);

      expect(workers[0].stop).toHaveBeenCalledTimes(1);
      expect(member.isRunning).toBe(false);
      expect(member.peerServer).toBeUndefined();
      expect(peer.serverSide.connected).toBe(false);
      expect(member.launches).toBe(1);
      expect(memberLog()).toEqual([]);
    });

    it('does nothing on a member never started', async () => {
      const { member, launch } = createMember();

      await member.stop();

      expect(launch).not.toHaveBeenCalled();
    });

    it('prevents a respawn already scheduled', async () => {
      const { member } = createMember({ respawnMs: 20 });
      await member.start(context());
      workers[0].crash();
      await settle();

      await member.stop();
      await sleep(50);

      expect(member.launches).toBe(1);
    });
  });

  // ...........................................................................
  describe('close()', () => {
    it('stops the worker', async () => {
      const { member } = createMember();
      await member.start(context());

      await member.close();

      expect(workers[0].stop).toHaveBeenCalledTimes(1);
      expect(member.isRunning).toBe(false);
    });
  });
});

// #############################################################################
describe('serveWorkerRoute(options)', () => {
  let closing: (() => Promise<void>)[];

  beforeEach(() => {
    closing = [];
  });

  afterEach(async () => {
    for (const close of closing) await close();
  });

  /** A worker serving on one end of a channel; the parent's socket on the other. */
  const serve = async (options: Partial<ServeWorkerRouteOptions> = {}) => {
    const stores = await storesWithData();
    const [parentEnd, workerEnd] = createChannelPair();
    const serving = await serveWorkerRoute({
      channel: workerEnd,
      tag: 'route:aTree',
      io: stores.io,
      bs: stores.bs,
      ...options,
    });
    closing.push(serving.close);
    const parent = new ChannelSocket(
      parentEnd as MessageChannelLike,
      'route:aTree',
    );
    parent.connect();
    return { serving, parent, stores };
  };

  // ...........................................................................
  describe('serving', () => {
    it('serves the local rows and blobs to the parent under its tag, with its logger', async () => {
      const logger = new BufferedLogger();
      const { parent, stores } = await serve({ logger });
      const io = new IoPeer(parent, 1000);
      const bs = new BsPeer(parent, { requestTimeoutMs: 1000 });
      await io.init();
      await bs.init();

      const rows = await io.readRows({ table: 'notes', where: {} });
      const blob = await bs.getBlob(stores.blobId);

      expect((rows.notes._data[0] as { a: string }).a).toBe('x');
      expect(blob.content.toString()).toBe('a blob');
      expect(logger.entries.map((e) => [e.source, e.message])).toEqual([
        ['PeerReadServer', 'Serving a peer'],
      ]);
    });

    it('counts what it served, for the worker to report', async () => {
      const { serving, parent, stores } = await serve();
      expect(serving.stats).toEqual({ rowReads: 0, blobReads: 0 });
      const io = new IoPeer(parent, 1000);
      const bs = new BsPeer(parent, { requestTimeoutMs: 1000 });
      await io.init();
      await bs.init();

      await io.readRows({ table: 'notes', where: {} });
      await bs.getBlob(stores.blobId);

      expect(serving.stats.rowReads).toBe(1);
      expect(serving.stats.blobReads).toBeGreaterThan(0);
    });
  });

  // ...........................................................................
  describe('resolvePeer(nodeId)', () => {
    it('resolves the address the parent answers', async () => {
      const { serving, parent } = await serve();
      parent.on(
        workerRouteEvents.resolvePeer,
        (nodeId: string, ack: (address: string | null) => void) =>
          ack(nodeId === 'nodeB' ? '10.0.0.2:4000' : null),
      );

      const answers = [
        await serving.resolvePeer('nodeB'),
        await serving.resolvePeer('nodeC'),
      ];

      expect(answers).toEqual(['10.0.0.2:4000', undefined]);
    });

    it('resolves undefined when the parent does not answer in time', async () => {
      const { serving } = await serve({ resolveTimeoutMs: 20 });

      await expect(serving.resolvePeer('nodeB')).resolves.toBeUndefined();
    });

    it('resolves undefined at once while the channel to the parent is down', async () => {
      const { serving, parent } = await serve({ resolveTimeoutMs: 60_000 });
      parent.disconnect();
      await settle();

      await expect(serving.resolvePeer('nodeB')).resolves.toBeUndefined();
    });
  });

  // ...........................................................................
  describe('connectPeer(dial)', () => {
    it('dials the address the parent resolved', async () => {
      const { serving, parent } = await serve();
      parent.on(
        workerRouteEvents.resolvePeer,
        (_nodeId: string, ack: (address: string | null) => void) =>
          ack('10.0.0.2:4000'),
      );
      const [, socket] = createSocketPair();
      const dial = vi.fn(async () => socket);
      const signal = new AbortController().signal;

      await expect(serving.connectPeer(dial)('nodeB', signal)).resolves.toBe(
        socket,
      );
      expect(dial.mock.calls).toEqual([['10.0.0.2:4000', signal]]);
    });

    it('dials nothing when the parent knows no address', async () => {
      const { serving, parent } = await serve();
      parent.on(
        workerRouteEvents.resolvePeer,
        (_nodeId: string, ack: (address: string | null) => void) => ack(null),
      );
      const dial = vi.fn();

      await expect(
        serving.connectPeer(dial)('nodeB', new AbortController().signal),
      ).resolves.toBeUndefined();
      expect(dial).not.toHaveBeenCalled();
    });
  });

  // ...........................................................................
  describe('close()', () => {
    it('stops serving and disconnects from the parent', async () => {
      const { serving, parent } = await serve();
      const disconnected = vi.fn();
      parent.on('disconnect', disconnected);

      await serving.close();
      await settle();

      expect(disconnected).toHaveBeenCalledTimes(1);
      expect(parent.connected).toBe(false);
      await expect(serving.resolvePeer('nodeB')).resolves.toBeUndefined();
    });
  });
});
