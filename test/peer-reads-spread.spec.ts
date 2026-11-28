// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, BsServer } from '@rljson/bs';
import { createSocketPair, IoMem, IoServer } from '@rljson/io';
import { exampleTableCfg } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectPeer, PeerReads, PeerReadsOptions } from '../src/index.ts';

// .............................................................................
// Which peers a read asks and how: recent senders, holders of the current ref,
// holders of older refs, the site's other nodes — and a bulk read goes to one
// of them at a time, the least busy, within bounds per peer and in total.
// .............................................................................

const TABLE = 'notes';

/** A blob store whose block reads wait until the test lets them through. */
class GatedBs extends BsMem {
  /** Block reads waiting, in order. */
  readonly waiting: Array<() => void> = [];

  /** Block reads it answered or is answering. */
  asked = 0;

  /** While true, block reads wait. */
  gated = false;

  async getBlock(blockId: string): Promise<Buffer> {
    this.asked++;
    if (this.gated) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return super.getBlock(blockId);
  }

  /** Lets every waiting block read through. */
  release(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }
}

/** A peer serving a row table and a gated blob store. */
interface Peer {
  nodeId: string;
  io: IoMem;
  bs: GatedBs;
  connect: () => Promise<ReturnType<typeof createSocketPair>[1]>;
}

const createPeer = async (nodeId: string): Promise<Peer> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  const bs = new GatedBs();
  const ioServer = new IoServer(io);
  const bsServer = new BsServer(bs);
  return {
    nodeId,
    io,
    bs,
    connect: async () => {
      const [serverSide, clientSide] = createSocketPair();
      serverSide.connect();
      await ioServer.addSocket(serverSide);
      await bsServer.addSocket(serverSide);
      return clientSide;
    },
  };
};

/** Stores a blob of one block in the given stores and returns its block. */
const blockIn = async (content: string, ...peers: Peer[]): Promise<string> => {
  let blockId = '';
  for (const peer of peers) {
    const { blobId } = await peer.bs.setBlob(Buffer.from(content));
    blockId = (await peer.bs.getBlobBlocks(blobId))[0].blockId;
  }
  return blockId;
};

/** Lets every pending promise chain run. */
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

describe('PeerReads: sources and spreading', () => {
  let reads: PeerReads | undefined;

  afterEach(async () => {
    await reads?.close();
    reads = undefined;
  });

  /** Peer reads that can reach the given peers. */
  const createReads = (
    peers: Peer[],
    options: Partial<PeerReadsOptions> = {},
  ): { reads: PeerReads; connects: string[] } => {
    const byId = new Map(peers.map((p) => [p.nodeId, p]));
    const connects: string[] = [];
    const connect: ConnectPeer = async (nodeId) => {
      connects.push(nodeId);
      return byId.get(nodeId)?.connect();
    };
    reads = new PeerReads({
      nodeId: 'me',
      connect,
      timeoutMs: 500,
      blobTimeoutMs: 500,
      ...options,
    });
    return { reads, connects };
  };

  // ...........................................................................
  describe('sources', () => {
    it('are the recent senders, the holders of the current ref, those of older refs, then the site', async () => {
      const { reads } = createReads([], {
        siteNodes: () => ['site-1', 'old-1', 'me', 'site-2'],
      });

      reads.setHolders({ 'old-1': 'ref-1', 'now-1': 'ref-2', 'now-2': 'ref-2' }, 'ref-2');
      reads.noteSource('sender-1');
      reads.noteSource('now-2');

      expect(reads.sources).toEqual([
        'now-2',
        'sender-1',
        'now-1',
        'old-1',
        'site-1',
        'site-2',
      ]);
    });

    it('take the holders as the hub last named them', async () => {
      const { reads } = createReads([]);

      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');
      reads.setHolders({ c: 'ref-2' }, 'ref-2');

      expect(reads.holders).toEqual({ c: 'ref-2' });
      expect(reads.sources).toEqual(['c']);
    });

    it('leave out holders without a usable ref', async () => {
      const { reads } = createReads([]);

      reads.setHolders(
        { a: 'ref-1', b: '', c: 42 as unknown as string },
        'ref-1',
      );

      expect(reads.holders).toEqual({ a: 'ref-1' });
    });

    it('take no holders after close', async () => {
      const { reads } = createReads([]);
      await reads.close();

      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      expect(reads.holders).toEqual({});
      expect(reads.sources).toEqual([]);
    });

    it('open connections ahead to the holders of the current ref, no more than maxBusyPeers', async () => {
      const peers = await Promise.all(
        ['a', 'b', 'c', 'old'].map((id) => createPeer(id)),
      );
      const { reads, connects } = createReads(peers, { maxBusyPeers: 2 });

      reads.setHolders({ a: 'ref-2', old: 'ref-1', b: 'ref-2', c: 'ref-2' }, 'ref-2');
      await flush();

      expect(connects).toEqual(['a', 'b']);
      expect(reads.connectedPeers.sort()).toEqual(['a', 'b']);
    });

    it('leave out a peer that is down', async () => {
      // "gone" cannot be reached, so it is marked down.
      const { reads } = createReads([]);
      reads.setHolders({ gone: 'ref-1', other: 'ref-1' }, 'ref-1');
      await flush();

      expect(reads.sources).toEqual([]);
    });
  });

  // ...........................................................................
  describe('a bulk read', () => {
    it('asks one peer: each block is sent once', async () => {
      const a = await createPeer('a');
      const b = await createPeer('b');
      const blockId = await blockIn('one block', a, b);
      const { reads } = createReads([a, b]);
      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');

      const bytes = await reads.getBlock(blockId);

      expect(bytes?.toString()).toBe('one block');
      expect(a.bs.asked + b.bs.asked).toBe(1);
    });

    it('asks the next peer when the first lacks the block', async () => {
      const a = await createPeer('a');
      const b = await createPeer('b');
      const blockId = await blockIn('only on b', b);
      const { reads } = createReads([a, b]);
      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');

      const bytes = await reads.getBlock(blockId);

      expect(bytes?.toString()).toBe('only on b');
      expect(reads.stats).toMatchObject({ hits: 1, misses: 0 });
      expect(reads.stats.bySource).toEqual({
        b: { reads: 1, rows: 0, bytes: 9 },
      });
    });

    it('answers undefined, counting a miss, when no peer has it', async () => {
      const a = await createPeer('a');
      const { reads } = createReads([a]);
      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      expect(await reads.getBlock('unknown-block')).toBeUndefined();
      expect(reads.stats).toMatchObject({ hits: 0, misses: 1 });
    });

    it('answers undefined, counting nothing, without peers', async () => {
      const { reads } = createReads([]);

      expect(await reads.getBlock('any')).toBeUndefined();
      expect(reads.stats).toMatchObject({ hits: 0, misses: 0, waits: 0 });
    });

    it('goes to the least busy peer', async () => {
      const a = await createPeer('a');
      const b = await createPeer('b');
      const block1 = await blockIn('block 1', a, b);
      const block2 = await blockIn('block 2', a, b);
      a.bs.gated = true;
      b.bs.gated = true;
      const { reads } = createReads([a, b]);
      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');

      const r1 = reads.getBlock(block1);
      const r2 = reads.getBlock(block2);
      await vi.waitFor(() => expect(a.bs.asked + b.bs.asked).toBe(2));
      a.bs.release();
      b.bs.release();

      expect((await r1)?.toString()).toBe('block 1');
      expect((await r2)?.toString()).toBe('block 2');
      expect(a.bs.asked).toBe(1);
      expect(b.bs.asked).toBe(1);
    });

    it('waits for room when its peer serves maxReadsPerPeer already', async () => {
      const a = await createPeer('a');
      const blocks = [
        await blockIn('block 1', a),
        await blockIn('block 2', a),
        await blockIn('block 3', a),
      ];
      a.bs.gated = true;
      const { reads } = createReads([a], { maxReadsPerPeer: 2 });
      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      const all = Promise.all(blocks.map((id) => reads.getBlock(id)));
      await vi.waitFor(() => expect(a.bs.asked).toBe(2));
      await flush();
      expect(a.bs.asked).toBe(2);
      expect(reads.stats.waits).toBe(1);

      a.bs.gated = false;
      a.bs.release();

      expect((await all).map((b) => b?.toString())).toEqual([
        'block 1',
        'block 2',
        'block 3',
      ]);
      expect(a.bs.asked).toBe(3);
      expect(reads.stats.bySource['a'].reads).toBe(3);
    });

    it('keeps no more than maxBusyPeers peers busy', async () => {
      const a = await createPeer('a');
      const b = await createPeer('b');
      const block1 = await blockIn('block 1', a, b);
      const block2 = await blockIn('block 2', a, b);
      a.bs.gated = true;
      b.bs.gated = true;
      const { reads } = createReads([a, b], { maxBusyPeers: 1 });
      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');

      const r1 = reads.getBlock(block1);
      const r2 = reads.getBlock(block2);
      await vi.waitFor(() => expect(a.bs.asked).toBe(2));
      a.bs.release();
      await Promise.all([r1, r2]);

      expect(b.bs.asked).toBe(0);
    });

    it('gives up, counting a miss, when no room comes in time', async () => {
      const a = await createPeer('a');
      const block1 = await blockIn('block 1', a);
      a.bs.gated = true;
      const { reads } = createReads([a], {
        maxReadsPerPeer: 1,
        timeoutMs: 100,
        blobTimeoutMs: 1000,
      });
      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      const first = reads.getBlock(block1);
      await vi.waitFor(() => expect(a.bs.asked).toBe(1));
      const second = await reads.readRowsByHashes({ table: TABLE, hashes: ['h'] });

      expect(second).toBeUndefined();
      expect(reads.stats).toMatchObject({ waits: 1, misses: 1, hits: 0 });
      a.bs.release();
      expect((await first)?.toString()).toBe('block 1');
    });

    it('stops waiting when the peer reads close', async () => {
      const a = await createPeer('a');
      const block1 = await blockIn('block 1', a);
      const block2 = await blockIn('block 2', a);
      a.bs.gated = true;
      const { reads } = createReads([a], { maxReadsPerPeer: 1 });
      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      const first = reads.getBlock(block1);
      await vi.waitFor(() => expect(a.bs.asked).toBe(1));
      const second = reads.getBlock(block2);
      await flush();
      await reads.close();

      expect(await second).toBeUndefined();
      a.bs.release();
      await first;
    });

    it('reads rows by their hashes from one peer and counts them', async () => {
      const a = await createPeer('a');
      const b = await createPeer('b');
      for (const peer of [a, b]) {
        await peer.io.write({
          data: {
            [TABLE]: {
              _data: [
                { a: 'x', b: 1 },
                { a: 'y', b: 2 },
              ],
              _hash: '',
              _type: 'components',
            },
          },
        } as never);
      }
      const dump = await a.io.dumpTable({ table: TABLE });
      const hashes = (dump[TABLE] as { _data: { _hash: string }[] })._data.map(
        (row) => row._hash,
      );
      const { reads } = createReads([a, b]);
      reads.setHolders({ a: 'ref-1', b: 'ref-1' }, 'ref-1');

      const result = await reads.readRowsByHashes({ table: TABLE, hashes });

      expect((result?.[TABLE] as { _data: unknown[] })._data).toHaveLength(2);
      expect(Object.values(reads.stats.bySource)).toEqual([
        { reads: 1, rows: 2, bytes: 0 },
      ]);
    });
  });

  // ...........................................................................
  describe('a small read', () => {
    it('counts what it read per source', async () => {
      const a = await createPeer('a');
      await a.io.write({
        data: {
          [TABLE]: { _data: [{ a: 'x', b: 1 }], _hash: '', _type: 'components' },
        },
      } as never);
      const { blobId } = await a.bs.setBlob(Buffer.from('blob'));
      const { reads } = createReads([a]);
      reads.setHolders({ a: 'ref-1' }, 'ref-1');

      await reads.readRows({ table: TABLE, where: {} });
      await reads.getBlobBlocks(blobId);
      await reads.getBlobProperties(blobId);

      expect(reads.stats.bySource).toEqual({
        a: { reads: 3, rows: 1, bytes: 0 },
      });
    });
  });
});
