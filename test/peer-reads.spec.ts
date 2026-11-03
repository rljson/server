// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobProperties, BsMem, BsServer } from '@rljson/bs';
import {
  createSocketPair,
  DirectionalSocketMock,
  IoMem,
  IoServer,
  Socket,
} from '@rljson/io';
import { exampleTableCfg } from '@rljson/rljson';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BufferedLogger,
  ConnectPeer,
  PeerReads,
  PeerReadsOptions,
} from '../src/index.ts';

// .............................................................................
// Helpers
// .............................................................................

/** The table every peer knows. */
const TABLE = 'notes';

/** A read of every row of {@link TABLE}. */
const allRows = { table: TABLE, where: {} };

/** The events a peer records when it is asked. */
const readEvents = [
  'readRows',
  'readRowsByHashes',
  'getBlob',
  'getBlobProperties',
  'blobExists',
];

/** Lets every pending promise chain run to its end. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A peer serving its local stores over in-process sockets. */
interface Peer {
  nodeId: string;
  io: IoMem;
  bs: BsMem;

  /** The read requests it received, in order. */
  asked: string[];

  /** The sockets of every connection opened to it: its side and ours. */
  serverSides: DirectionalSocketMock[];
  clientSides: DirectionalSocketMock[];

  /** While true, new connections are accepted but never answered. */
  silent: boolean;

  /** While true, new connections break off on the first read request. */
  breaksOff: boolean;

  /** Opens a connection to it. */
  connect: () => Promise<DirectionalSocketMock>;
}

/**
 * Creates a peer whose table holds the given rows.
 * @param nodeId - The peer's node id.
 * @param rows - The rows of {@link TABLE}.
 * @returns The peer.
 */
const createPeer = async (
  nodeId: string,
  rows: { a: string; b: number }[] = [],
): Promise<Peer> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  if (rows.length > 0) {
    await io.write({
      data: { [TABLE]: { _data: rows, _hash: '', _type: 'components' } },
    } as any);
  }
  const bs = new BsMem();
  const ioServer = new IoServer(io);
  const bsServer = new BsServer(bs);

  const peer: Peer = {
    nodeId,
    io,
    bs,
    asked: [],
    serverSides: [],
    clientSides: [],
    silent: false,
    breaksOff: false,
    connect: async () => {
      const [serverSide, clientSide] = createSocketPair();
      serverSide.connect();
      if (peer.breaksOff) {
        serverSide.on('readRows', () => serverSide.disconnect());
      } else if (!peer.silent) {
        await ioServer.addSocket(serverSide);
        await bsServer.addSocket(serverSide);
      }
      for (const event of readEvents) {
        serverSide.on(event, () => peer.asked.push(event));
      }
      peer.serverSides.push(serverSide);
      peer.clientSides.push(clientSide);
      return clientSide;
    },
  };
  return peer;
};

/**
 * Opens connections to a peer that answers as the script says.
 * @param script - Registers the peer's handlers on both sides of a connection.
 * @returns The connect function and the sockets handed out.
 */
const scriptedPeer = (
  script: (
    serverSide: DirectionalSocketMock,
    clientSide: DirectionalSocketMock,
  ) => void,
) => {
  const clientSides: DirectionalSocketMock[] = [];
  const connect = async () => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    script(serverSide, clientSide);
    clientSides.push(clientSide);
    return clientSide;
  };
  return { connect, clientSides };
};

/**
 * The peers a node can reach, by node id. Nodes not in it cannot be reached.
 * @returns The peers, the connect function and the nodes it was asked for.
 */
const createNetwork = () => {
  const peers = new Map<string, Pick<Peer, 'connect'>>();
  const connects: string[] = [];
  const signals: AbortSignal[] = [];
  const connect: ConnectPeer = async (nodeId, signal) => {
    connects.push(nodeId);
    signals.push(signal);
    return peers.get(nodeId)?.connect();
  };
  return { peers, connects, signals, connect };
};

/** No reads, no hits, no failures. */
const noStats = { hits: 0, misses: 0, failures: 0 };

// .............................................................................
describe('PeerReads', () => {
  let network: ReturnType<typeof createNetwork>;
  let reads: PeerReads | undefined;

  /**
   * Creates the peer reads under test on {@link network}.
   * @param options - Overrides.
   * @returns The peer reads.
   */
  const createReads = (options: Partial<PeerReadsOptions> = {}) => {
    reads = PeerReads.example({
      nodeId: 'me',
      connect: network.connect,
      ...options,
    });
    return reads;
  };

  /**
   * Adds peers to the network.
   * @param peers - The peers.
   */
  const addPeers = (...peers: Peer[]) => {
    for (const peer of peers) network.peers.set(peer.nodeId, peer);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    network = createNetwork();
  });

  afterEach(async () => {
    await reads?.close();
    reads = undefined;
    vi.useRealTimers();
  });

  // ...........................................................................
  describe('example(options)', () => {
    it('creates peer reads whose peers can never be reached', async () => {
      reads = PeerReads.example();
      expect(reads.nodeId).toBe('node-example');

      reads.noteSource('a');
      expect(await reads.readRows(allRows)).toBeUndefined();
      expect(reads.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      expect(reads.connectedPeers).toEqual([]);
    });

    it('takes overrides', () => {
      reads = PeerReads.example({ nodeId: 'mine' });
      expect(reads.nodeId).toBe('mine');
    });
  });

  // ...........................................................................
  describe('stats', () => {
    it('starts at zero', () => {
      expect(createReads().stats).toEqual(noStats);
    });

    it('returns a copy the caller cannot change', () => {
      const r = createReads();
      const stats = r.stats;
      stats.hits = 99;
      expect(r.stats).toEqual(noStats);
    });
  });

  // ...........................................................................
  describe('connectedPeers', () => {
    it('lists the nodes with an open connection', async () => {
      addPeers(await createPeer('a'), await createPeer('b'));
      const r = createReads();
      expect(r.connectedPeers).toEqual([]);

      r.noteSource('a');
      r.noteSource('b');
      await flush();
      expect(r.connectedPeers).toEqual(['a', 'b']);
    });
  });

  // ...........................................................................
  describe('isClosed', () => {
    it('tells whether close was called', async () => {
      const r = createReads();
      expect(r.isClosed).toBe(false);
      await r.close();
      expect(r.isClosed).toBe(true);
    });
  });

  // ...........................................................................
  describe('noteSource(nodeId)', () => {
    it('opens a connection ahead of the first read', async () => {
      const logger = new BufferedLogger();
      addPeers(await createPeer('a'));
      const r = createReads({ logger });

      r.noteSource('a');
      await flush();

      expect(network.connects).toEqual(['a']);
      expect(r.connectedPeers).toEqual(['a']);
      expect(logger.entries).toEqual([
        {
          level: 'info',
          source: 'PeerReads',
          message: 'Connected to peer',
          data: { nodeId: 'a' },
          timestamp: expect.any(Number),
        },
      ]);
    });

    it('opens one connection while one is still opening', async () => {
      addPeers(await createPeer('a'));
      const r = createReads();

      r.noteSource('a');
      r.noteSource('a');
      await flush();

      expect(network.connects).toEqual(['a']);
      expect(r.connectedPeers).toEqual(['a']);
    });

    it('ignores this node itself', async () => {
      const r = createReads();

      r.noteSource('me');
      await flush();

      expect(network.connects).toEqual([]);
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual(noStats);
    });

    it('is ignored after close', async () => {
      addPeers(await createPeer('a'));
      const r = createReads();
      await r.close();

      r.noteSource('a');
      await flush();

      expect(network.connects).toEqual([]);
      expect(r.connectedPeers).toEqual([]);
    });

    it('opens no connection to a node that is down', async () => {
      const r = createReads();

      r.noteSource('unreachable');
      await flush();
      r.noteSource('unreachable');
      await flush();

      expect(network.connects).toEqual(['unreachable']);
    });

    it('makes a node that sends again the newest source', async () => {
      const a = await createPeer('a', [{ a: 'from a', b: 1 }]);
      const b = await createPeer('b', [{ a: 'from b', b: 2 }]);
      addPeers(a, b);
      const r = createReads({ maxSourcesPerRead: 1 });

      r.noteSource('a');
      r.noteSource('b');
      expect(await r.readRows(allRows)).toEqual(await b.io.readRows(allRows));

      r.noteSource('a');
      expect(await r.readRows(allRows)).toEqual(await a.io.readRows(allRows));

      expect(a.asked).toEqual(['readRows']);
      expect(b.asked).toEqual(['readRows']);
    });
  });

  // ...........................................................................
  describe('readRows(request)', () => {
    it('answers undefined, without counting, when no source is known', async () => {
      const r = createReads();
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual(noStats);
    });

    it('answers the rows of a source that holds them', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      addPeers(a);
      const r = createReads();

      r.noteSource('a');
      const rows = await r.readRows(allRows);

      expect(rows).toEqual(await a.io.readRows(allRows));
      expect(rows![TABLE]._data).toHaveLength(1);
      expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
    });

    it('asks the newest sources, no more than maxSourcesPerRead', async () => {
      const peers = [
        await createPeer('a'),
        await createPeer('b'),
        await createPeer('c'),
      ];
      addPeers(...peers);
      const r = createReads();

      for (const peer of peers) r.noteSource(peer.nodeId);
      expect(await r.readRows(allRows)).toBeUndefined();

      expect(peers.map((p) => p.asked)).toEqual([
        [],
        ['readRows'],
        ['readRows'],
      ]);
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });

    it('takes the rows of a later source when the newest has none', async () => {
      const empty = await createPeer('empty');
      const full = await createPeer('full', [{ a: 'x', b: 1 }]);
      addPeers(empty, full);
      const r = createReads();

      r.noteSource('full');
      r.noteSource('empty');
      expect(await r.readRows(allRows)).toEqual(
        await full.io.readRows(allRows),
      );

      expect(empty.asked).toEqual(['readRows']);
      expect(full.asked).toEqual(['readRows']);
      expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
    });

    it('forgets a source sourceTtlMs after its last ref', async () => {
      addPeers(await createPeer('a', [{ a: 'x', b: 1 }]));
      const r = createReads({ sourceTtlMs: 1000 });

      r.noteSource('a');
      await flush();
      vi.advanceTimersByTime(1000);
      expect(await r.readRows(allRows)).toBeDefined();

      vi.advanceTimersByTime(1);
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });

      r.noteSource('a');
      expect(await r.readRows(allRows)).toBeDefined();
      expect(r.stats).toEqual({ hits: 2, misses: 0, failures: 0 });
    });

    it('counts a miss when no source has a matching row', async () => {
      addPeers(await createPeer('a', [{ a: 'x', b: 1 }]));
      const r = createReads();

      r.noteSource('a');
      expect(
        await r.readRows({ table: TABLE, where: { a: 'y' } }),
      ).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });

    it('counts a miss when the answer lacks the table', async () => {
      const peer = scriptedPeer((serverSide) => {
        serverSide.on('readRows', (_request, ack) => ack({}, null));
      });
      network.peers.set('a', peer);
      const r = createReads();

      r.noteSource('a');
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });

    it('counts a miss, not a failure, when the peer answers with an error', async () => {
      addPeers(await createPeer('a'));
      const r = createReads();

      r.noteSource('a');
      expect(
        await r.readRows({ table: 'unknownTable', where: {} }),
      ).toBeUndefined();

      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      expect(r.connectedPeers).toEqual(['a']);
    });

    it('counts a failure, drops the link and skips the peer when it does not answer in time', async () => {
      const logger = new BufferedLogger();
      const a = await createPeer('a');
      a.silent = true;
      addPeers(a);
      const r = createReads({ timeoutMs: 50, logger });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await vi.advanceTimersByTimeAsync(50);

      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 1 });
      expect(r.connectedPeers).toEqual([]);
      expect(a.clientSides[0].connected).toBe(false);
      expect(logger.byLevel('warn')).toEqual([
        {
          level: 'warn',
          source: 'PeerReads',
          message: 'Peer failed, asking the hub',
          data: { nodeId: 'a', error: 'Peer did not answer within 50 ms' },
          timestamp: expect.any(Number),
        },
      ]);

      // Skipped: not even asked.
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 1 });
      expect(a.asked).toEqual(['readRows']);
    });

    it('ends a read in flight at once, counting a failure, when the peer disconnects', async () => {
      const logger = new BufferedLogger();
      const a = await createPeer('a');
      a.silent = true;
      addPeers(a);
      const r = createReads({ timeoutMs: 1000, logger });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await flush();
      a.serverSides[0].disconnect();

      // No time has passed: the read did not wait for its bound.
      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 1 });
      expect(logger.byLevel('warn').map((e) => e.data)).toEqual([
        { nodeId: 'a', error: 'Peer connection lost' },
      ]);

      // Down: not asked again.
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(network.connects).toEqual(['a']);
      expect(a.asked).toEqual(['readRows']);
    });

    it('ends a read in flight at once, counting a miss, when close drops its link', async () => {
      const a = await createPeer('a');
      a.silent = true;
      addPeers(a);
      const r = createReads({ timeoutMs: 1000 });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await flush();
      await r.close();

      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });

    it('ends a read in flight at once, counting a miss, when a full pool evicts its link', async () => {
      const a = await createPeer('a');
      a.silent = true;
      addPeers(a, await createPeer('b'));
      const r = createReads({ timeoutMs: 1000, maxConnections: 1 });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await flush();
      r.noteSource('b');

      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      expect(r.connectedPeers).toEqual(['b']);
    });

    it('ends a read in flight at once, counting a miss, when its link is idle for idleMs', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      a.silent = true;
      addPeers(a);
      const r = createReads({ timeoutMs: 1000, idleMs: 50 });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await vi.advanceTimersByTimeAsync(50);

      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });

      // Not down: the next read connects again.
      a.silent = false;
      expect(await r.readRows(allRows)).toEqual(await a.io.readRows(allRows));
      expect(network.connects).toEqual(['a', 'a']);
    });

    it('asks a failed peer again after downMs', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      a.silent = true;
      addPeers(a);
      const r = createReads({ timeoutMs: 50, downMs: 1000 });

      r.noteSource('a');
      await flush();
      const read = r.readRows(allRows);
      await vi.advanceTimersByTimeAsync(50);
      expect(await read).toBeUndefined();

      a.silent = false;
      vi.advanceTimersByTime(999);
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(network.connects).toEqual(['a']);

      vi.advanceTimersByTime(1);
      expect(await r.readRows(allRows)).toEqual(await a.io.readRows(allRows));
      expect(network.connects).toEqual(['a', 'a']);
      expect(r.stats).toEqual({ hits: 1, misses: 1, failures: 1 });
    });

    it('marks a node it cannot reach down, without counting a failure', async () => {
      const r = createReads({ downMs: 1000 });

      r.noteSource('unreachable');
      await flush();
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual(noStats);

      vi.advanceTimersByTime(1000);
      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      expect(network.connects).toEqual(['unreachable', 'unreachable']);
    });

    it('counts a failure when connecting is refused', async () => {
      for (const refusal of [new Error('refused'), 'refused']) {
        const logger = new BufferedLogger();
        const r = PeerReads.example({
          connect: () => Promise.reject(refusal),
          logger,
        });

        r.noteSource('a');
        await flush();

        expect(r.stats).toEqual({ hits: 0, misses: 0, failures: 1 });
        expect(logger.byLevel('warn').map((e) => e.data)).toEqual([
          { nodeId: 'a', error: 'refused' },
        ]);
        expect(await r.readRows(allRows)).toBeUndefined();
        expect(r.stats).toEqual({ hits: 0, misses: 0, failures: 1 });
      }
    });

    it('counts a failure when connecting takes longer than connectTimeoutMs, and closes the late connection', async () => {
      const a = await createPeer('a');
      network.peers.set('a', {
        connect: () =>
          new Promise((resolve) => setTimeout(() => resolve(a.connect()), 100)),
      });
      const r = createReads({ connectTimeoutMs: 50 });

      r.noteSource('a');
      await vi.advanceTimersByTimeAsync(50);
      expect(r.stats).toEqual({ hits: 0, misses: 0, failures: 1 });
      expect(network.signals[0].aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(50);
      expect(a.clientSides).toHaveLength(1);
      expect(a.clientSides[0].connected).toBe(false);
      expect(r.connectedPeers).toEqual([]);
    });

    it('ignores a late connect that finds no way to the node', async () => {
      network.peers.set('a', {
        connect: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(undefined as any), 100),
          ),
      });
      const r = createReads({ connectTimeoutMs: 50 });

      r.noteSource('a');
      await vi.advanceTimersByTimeAsync(100);

      expect(r.stats).toEqual({ hits: 0, misses: 0, failures: 1 });
      expect(r.connectedPeers).toEqual([]);
    });

    it('counts a failure and disconnects a socket that never connects', async () => {
      let disconnects = 0;
      const neverConnects: Socket = {
        connected: false,
        disconnected: true,
        connect: () => {},
        disconnect: () => {
          disconnects++;
        },
        on: () => neverConnects,
        off: () => neverConnects,
        removeAllListeners: () => neverConnects,
        emit: () => true,
      } as unknown as Socket;
      network.peers.set('a', { connect: async () => neverConnects as any });
      const r = createReads({ connectTimeoutMs: 50 });

      r.noteSource('a');
      await vi.advanceTimersByTimeAsync(50);

      expect(r.stats).toEqual({ hits: 0, misses: 0, failures: 1 });
      expect(disconnects).toBe(1);
    });

    it('answers undefined when its bound passes while a connection is still opening', async () => {
      network.peers.set('a', { connect: () => new Promise(() => {}) });
      const r = createReads({ timeoutMs: 50, connectTimeoutMs: 1000 });

      r.noteSource('a');
      const read = r.readRows(allRows);
      await vi.advanceTimersByTimeAsync(50);

      expect(await read).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });

      await vi.advanceTimersByTimeAsync(950);
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 1 });
    });

    it('answers undefined after close', async () => {
      addPeers(await createPeer('a', [{ a: 'x', b: 1 }]));
      const r = createReads();

      r.noteSource('a');
      await flush();
      await r.close();

      expect(await r.readRows(allRows)).toBeUndefined();
      expect(r.stats).toEqual(noStats);
    });
  });

  // ...........................................................................
  describe('readRowsByHashes(request)', () => {
    it('answers the rows with the given hashes from a source', async () => {
      const a = await createPeer('a', [
        { a: 'x', b: 1 },
        { a: 'y', b: 2 },
      ]);
      addPeers(a);
      const r = createReads();
      const row = (await a.io.readRows({ table: TABLE, where: { a: 'y' } }))[
        TABLE
      ]._data[0];

      r.noteSource('a');
      expect(
        await r.readRowsByHashes({ table: TABLE, hashes: [row._hash] }),
      ).toEqual({ [TABLE]: { _data: [row], _type: 'components' } });
      expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
    });

    it('counts a miss when no source holds the hashes', async () => {
      addPeers(await createPeer('a', [{ a: 'x', b: 1 }]));
      const r = createReads();

      r.noteSource('a');
      expect(
        await r.readRowsByHashes({ table: TABLE, hashes: ['unknownHash'] }),
      ).toBeUndefined();
      expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });
  });

  // ...........................................................................
  describe('blob reads', () => {
    let a: Peer;
    let properties: BlobProperties;

    beforeEach(async () => {
      a = await createPeer('a');
      properties = await a.bs.setBlob('hello world');
      addPeers(a);
    });

    // .........................................................................
    describe('getBlob(blobId, options)', () => {
      it('answers the content and properties from a source', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.getBlob(properties.blobId)).toEqual({
          content: Buffer.from('hello world'),
          properties,
        });
        expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
      });

      it('answers a range of the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        const blob = await r.getBlob(properties.blobId, {
          range: { start: 6, end: 11 },
        });
        expect(blob).toEqual({ content: Buffer.from('world'), properties });
      });

      it('counts a miss when no source holds the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.getBlob('unknownBlob')).toBeUndefined();
        expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      });

      it('answers undefined when the blob does not arrive within blobTimeoutMs', async () => {
        a.silent = true;
        const r = createReads({ blobTimeoutMs: 200 });

        r.noteSource('a');
        await flush();
        let blob: unknown = 'pending';
        void r.getBlob(properties.blobId).then((b) => (blob = b));

        await vi.advanceTimersByTimeAsync(199);
        expect(blob).toBe('pending');
        await vi.advanceTimersByTimeAsync(1);
        expect(blob).toBeUndefined();
      });

      it('counts a silent peer as failed and sets it aside', async () => {
        a.silent = true;
        const r = createReads({ blobTimeoutMs: 200 });

        r.noteSource('a');
        await flush();
        const read = r.getBlob(properties.blobId);
        await vi.advanceTimersByTimeAsync(200);

        expect(await read).toBeUndefined();
        expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 1 });
        expect(r.connectedPeers).toEqual([]);
      });

      it('answers undefined after close', async () => {
        const r = createReads();

        r.noteSource('a');
        await flush();
        await r.close();

        expect(await r.getBlob(properties.blobId)).toBeUndefined();
        expect(r.stats).toEqual(noStats);
      });
    });

    // .........................................................................
    describe('getBlobProperties(blobId)', () => {
      it('answers the properties from a source', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.getBlobProperties(properties.blobId)).toEqual(
          properties,
        );
        expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
      });

      it('counts a miss when no source holds the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.getBlobProperties('unknownBlob')).toBeUndefined();
        expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      });
    });

    // .........................................................................
    describe('blobExists(blobId)', () => {
      it('is true when a source holds the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.blobExists(properties.blobId)).toBe(true);
        expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
      });

      it('is false when no source holds the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.blobExists('unknownBlob')).toBe(false);
        expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      });

      it('is false after close', async () => {
        const r = createReads();

        r.noteSource('a');
        await flush();
        await r.close();

        expect(await r.blobExists(properties.blobId)).toBe(false);
      });
    });

    // .........................................................................
    describe('blobSource(blobId)', () => {
      it('finds the source holding the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.blobSource(properties.blobId)).toEqual({
          nodeId: 'a',
          properties,
          readRange: expect.any(Function),
        });
        expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
      });

      it('answers undefined when no source holds the blob', async () => {
        const r = createReads();

        r.noteSource('a');
        expect(await r.blobSource('unknownBlob')).toBeUndefined();
        expect(r.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
      });

      // .......................................................................
      describe('readRange(start, end)', () => {
        it('reads the bytes from start to end from the source', async () => {
          const r = createReads();

          r.noteSource('a');
          const source = await r.blobSource(properties.blobId);

          expect(await source!.readRange(0, 5)).toEqual(Buffer.from('hello'));
          expect(await source!.readRange(6, 11)).toEqual(Buffer.from('world'));
          expect(a.asked).toEqual(['getBlobProperties', 'getBlob', 'getBlob']);
        });

        it('answers undefined when the source sends no bytes', async () => {
          const r = createReads();

          r.noteSource('a');
          const source = await r.blobSource(properties.blobId);

          expect(await source!.readRange(3, 3)).toBeUndefined();
          expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
        });

        it('answers undefined at once, and counts a failure, when the source breaks off mid-read', async () => {
          const peer = scriptedPeer((serverSide) => {
            serverSide.on('getBlobProperties', (_blobId, ack) =>
              ack(null, properties),
            );
            serverSide.on('getBlob', () => serverSide.disconnect());
          });
          network.peers.set('b', peer);
          const r = createReads();

          r.noteSource('b');
          const source = await r.blobSource(properties.blobId);
          expect(source?.nodeId).toBe('b');

          expect(await source!.readRange(0, 5)).toBeUndefined();
          expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 1 });
          expect(r.connectedPeers).toEqual([]);
          expect(peer.clientSides[0].connected).toBe(false);
        });

        it('counts a failure when the source answers with an error after its connection closed', async () => {
          const peer = scriptedPeer((serverSide, clientSide) => {
            serverSide.on('getBlobProperties', (_blobId, ack) =>
              ack(null, properties),
            );
            serverSide.on('getBlob', (_blobId, _options, ack) => {
              // The transport is gone; its disconnect event is not out yet.
              clientSide.connected = false;
              ack(new Error('transport closed'));
            });
          });
          network.peers.set('b', peer);
          const r = createReads();

          r.noteSource('b');
          const source = await r.blobSource(properties.blobId);

          expect(await source!.readRange(0, 5)).toBeUndefined();
          expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 1 });
          expect(r.connectedPeers).toEqual([]);
        });

        it('answers undefined when the source cannot be reached any more', async () => {
          const r = createReads();

          r.noteSource('a');
          const source = await r.blobSource(properties.blobId);
          network.peers.delete('a');
          a.serverSides[0].disconnect();

          expect(await source!.readRange(0, 5)).toBeUndefined();
          expect(network.connects).toEqual(['a', 'a']);
        });

        it('answers undefined after close', async () => {
          const r = createReads();

          r.noteSource('a');
          const source = await r.blobSource(properties.blobId);
          await r.close();

          expect(await source!.readRange(0, 5)).toBeUndefined();
          expect(network.connects).toEqual(['a']);
        });
      });
    });
  });

  // ...........................................................................
  describe('connections', () => {
    it('closes a link unused for idleMs', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      addPeers(a);
      const r = createReads({ idleMs: 1000 });

      r.noteSource('a');
      await flush();
      vi.advanceTimersByTime(600);
      expect(await r.readRows(allRows)).toBeDefined();

      vi.advanceTimersByTime(999);
      expect(r.connectedPeers).toEqual(['a']);

      vi.advanceTimersByTime(1);
      expect(r.connectedPeers).toEqual([]);
      expect(a.clientSides[0].connected).toBe(false);
    });

    it('drops a link whose peer disconnects, and opens a new one on the next read', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      addPeers(a);
      const r = createReads();

      r.noteSource('a');
      await flush();
      a.serverSides[0].disconnect();
      expect(r.connectedPeers).toEqual([]);

      expect(await r.readRows(allRows)).toEqual(await a.io.readRows(allRows));
      expect(network.connects).toEqual(['a', 'a']);
      expect(r.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
    });

    it('keeps a new link when the idle timer of a dropped one fires', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      a.breaksOff = true;
      addPeers(a);
      const r = createReads({ idleMs: 1000, downMs: 10 });

      r.noteSource('a');
      await flush();
      vi.advanceTimersByTime(500);

      // The first read breaks the link off; the second, already on its way,
      // still restarts the idle timer of the dropped link.
      const reads = [r.readRows(allRows), r.readRows(allRows)];
      expect(await Promise.all(reads)).toEqual([undefined, undefined]);
      expect(r.connectedPeers).toEqual([]);

      a.breaksOff = false;
      vi.advanceTimersByTime(10);
      expect(await r.readRows(allRows)).toBeDefined();
      expect(r.connectedPeers).toEqual(['a']);

      // The dropped link's idle timer passes; the new link stays.
      vi.advanceTimersByTime(990);
      expect(r.connectedPeers).toEqual(['a']);
      expect(a.clientSides.map((s) => s.connected)).toEqual([false, true]);
      // One break-off, two reads in flight on it: one failed peer.
      expect(r.stats).toEqual({ hits: 1, misses: 2, failures: 1 });
    });

    it('closes the oldest link when the pool is full', async () => {
      const peers = [
        await createPeer('a'),
        await createPeer('b'),
        await createPeer('c'),
      ];
      addPeers(...peers);
      const r = createReads({ maxConnections: 2 });

      for (const peer of peers) {
        r.noteSource(peer.nodeId);
        await flush();
        vi.advanceTimersByTime(10);
      }

      expect(r.connectedPeers).toEqual(['b', 'c']);
      expect(peers.map((p) => p.clientSides[0].connected)).toEqual([
        false,
        true,
        true,
      ]);
    });

    it('closes the least recently used link, not the oldest, when the pool is full', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      addPeers(a, await createPeer('b'), await createPeer('c'));
      const r = createReads({ maxConnections: 2, maxSourcesPerRead: 1 });

      r.noteSource('a');
      await flush();
      vi.advanceTimersByTime(10);
      r.noteSource('b');
      await flush();
      vi.advanceTimersByTime(10);
      r.noteSource('a');
      expect(await r.readRows(allRows)).toBeDefined();
      vi.advanceTimersByTime(10);
      r.noteSource('c');
      await flush();

      expect(r.connectedPeers).toEqual(['a', 'c']);
    });

    it('opens no link when close is called while it is opening', async () => {
      const a = await createPeer('a');
      let release = () => {};
      network.peers.set('a', {
        connect: () =>
          new Promise((resolve) => {
            release = () => resolve(a.connect());
          }),
      });
      const r = createReads();

      r.noteSource('a');
      await flush();
      await r.close();
      release();
      await flush();

      expect(r.connectedPeers).toEqual([]);
      expect(a.clientSides[0].connected).toBe(false);
      expect(r.stats).toEqual(noStats);
    });

    it('serves reads over a namespace bundle and disconnects each of its sockets on close', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      const { blobId } = await a.bs.setBlob('hello');
      const clientSides: DirectionalSocketMock[] = [];
      network.peers.set('a', {
        connect: async () => {
          const [ioServerSide, ioClientSide] = createSocketPair();
          const [bsServerSide, bsClientSide] = createSocketPair();
          ioServerSide.connect();
          bsServerSide.connect();
          await new IoServer(a.io).addSocket(ioServerSide);
          await new BsServer(a.bs).addSocket(bsServerSide);
          clientSides.push(ioClientSide, bsClientSide);
          return {
            ioUp: ioClientSide,
            ioDown: ioClientSide,
            bsUp: bsClientSide,
            bsDown: bsClientSide,
          } as any;
        },
      });
      const r = createReads();

      r.noteSource('a');
      expect(await r.readRows(allRows)).toEqual(await a.io.readRows(allRows));
      expect((await r.getBlob(blobId))?.content).toEqual(Buffer.from('hello'));

      await r.close();
      expect(clientSides.map((s) => s.connected)).toEqual([false, false]);
    });

    it('ends the link when only the blob socket of a bundle drops', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      const { blobId } = await a.bs.setBlob('hello');
      const sockets: DirectionalSocketMock[] = [];
      network.peers.set('a', {
        connect: async () => {
          const [ioServerSide, ioClientSide] = createSocketPair();
          const [bsServerSide, bsClientSide] = createSocketPair();
          ioServerSide.connect();
          bsServerSide.connect();
          await new IoServer(a.io).addSocket(ioServerSide);
          await new BsServer(a.bs).addSocket(bsServerSide);
          sockets.push(ioClientSide, bsServerSide);
          return {
            ioUp: ioClientSide,
            ioDown: ioClientSide,
            bsUp: bsClientSide,
            bsDown: bsClientSide,
          } as any;
        },
      });
      const r = createReads();

      r.noteSource('a');
      expect((await r.getBlob(blobId))?.content).toEqual(Buffer.from('hello'));
      const [ioClientSide, bsServerSide] = sockets;
      bsServerSide.disconnect();

      // The whole link ends, not just its blob half …
      expect(r.connectedPeers).toEqual([]);
      expect(ioClientSide.connected).toBe(false);
      // … so the next read opens a fresh one instead of missing on a dead
      // socket until the link goes idle.
      expect((await r.getBlob(blobId))?.content).toEqual(Buffer.from('hello'));
      expect(network.connects).toEqual(['a', 'a']);
      expect(r.stats.failures).toBe(0);
    });
  });

  // ...........................................................................
  describe('close()', () => {
    it('closes every link and forgets every source', async () => {
      const a = await createPeer('a', [{ a: 'x', b: 1 }]);
      const b = await createPeer('b');
      addPeers(a, b);
      const r = createReads();

      r.noteSource('a');
      r.noteSource('b');
      await flush();
      await r.close();

      expect(r.connectedPeers).toEqual([]);
      expect([a, b].map((p) => p.clientSides[0].connected)).toEqual([
        false,
        false,
      ]);
      expect(r.isClosed).toBe(true);
    });
  });
});
