// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, Bs, BsMem, BsPeer, BsServer } from '@rljson/bs';
import { createSocketPair } from '@rljson/io';
import { afterEach, describe, expect, it } from 'vitest';

import { PeerFirstBs, PeerReads } from '../src/index.ts';

// .............................................................................

/** Ten bytes: one block. */
const CONTENT = Buffer.from('0123456789');

/** Bytes that do not repeat: several blocks. */
const LARGE = (() => {
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  let x = 1;
  for (let i = 0; i < bytes.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    bytes[i] = x >>> 24;
  }
  return bytes;
})();

/**
 * A blob store holding one blob.
 * @param content - The blob.
 * @returns The store and the blob's id.
 */
const storeWith = async (
  content: Buffer,
): Promise<{ bs: BsMem; blobId: string }> => {
  const bs = new BsMem();
  const { blobId } = await bs.setBlob(content);
  return { bs, blobId };
};

/** The id {@link CONTENT} has in every store. */
const blobIdOf = async (): Promise<string> =>
  (await new BsMem().setBlob(CONTENT)).blobId;

/**
 * Reads a stream to its end.
 * @param stream - The stream.
 * @returns Its bytes and how many chunks they came in.
 */
const readAll = async (
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: Buffer; chunks: number }> => {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return { bytes: Buffer.concat(parts), chunks: parts.length };
};

/**
 * Peer reads whose one source is a hand-written block source, for the cases a
 * real peer cannot be made to show on cue: breaking off mid-blob, or
 * answering with the blocks of another blob.
 */
class OneBlockSource extends PeerReads {
  /** Every block the source was asked for, in order. */
  readonly asked: string[] = [];

  /**
   * Creates the peer reads.
   * @param _blocks - The blocks the source reports.
   * @param _answer - What the source answers for a block.
   */
  constructor(
    private readonly _blocks: BlobBlock[],
    private readonly _answer: (
      blockId: string,
      call: number,
    ) => Promise<Buffer | undefined>,
  ) {
    super({ nodeId: 'me', connect: async () => undefined });
  }

  override async getBlobBlocks(): Promise<BlobBlock[]> {
    return this._blocks;
  }

  override async getBlock(blockId: string): Promise<Buffer | undefined> {
    this.asked.push(blockId);
    return this._answer(blockId, this.asked.length);
  }
}

// .............................................................................

describe('PeerFirstBs', () => {
  let peers: PeerReads | undefined;

  afterEach(async () => {
    await peers?.close();
    peers = undefined;
  });

  /**
   * Peer reads whose one source serves `peerBs` over a socket pair.
   * @param peerBs - What the peer holds.
   * @returns The peer reads, with the peer noted as a source.
   */
  const peerHolding = async (peerBs: Bs): Promise<PeerReads> => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    await new BsServer(peerBs).addSocket(serverSide);
    peers = new PeerReads({ nodeId: 'me', connect: async () => clientSide });
    peers.noteSource('peer-1');
    return peers;
  };

  /**
   * Peer reads that know no source, so every read goes to the hub.
   * @returns The peer reads.
   */
  const noPeers = (): PeerReads => {
    peers = PeerReads.example();
    return peers;
  };

  // ...........................................................................
  describe('isOpen', () => {
    it('is undefined when the hub’s Bs has no such flag', () => {
      const bs = new PeerFirstBs(new BsMem(), noPeers());
      expect(bs.isOpen).toBeUndefined();
    });

    it('follows the hub’s flag when its Bs has one', async () => {
      const [serverSide, clientSide] = createSocketPair();
      serverSide.connect();
      await new BsServer(new BsMem()).addSocket(serverSide);
      const hub = new BsPeer(clientSide);
      const bs = new PeerFirstBs(hub, noPeers());

      expect(bs.isOpen).toBe(false);
      await hub.init();
      expect(bs.isOpen).toBe(true);
      clientSide.disconnect();
      expect(bs.isOpen).toBe(false);
    });
  });

  // ...........................................................................
  describe('setBlob(), deleteBlob(), listBlobs() and generateSignedUrl()', () => {
    it('act on the hub’s blobs', async () => {
      const hub = new BsMem();
      const bs = new PeerFirstBs(hub, noPeers());

      const { blobId } = await bs.setBlob(CONTENT);
      expect(await hub.blobExists(blobId)).toBe(true);

      expect(await bs.listBlobs()).toEqual(await hub.listBlobs());
      expect(await bs.generateSignedUrl(blobId, 60, 'delete')).toMatch(
        new RegExp(`^mem://${blobId}\\?expires=\\d+&permissions=delete$`),
      );

      await bs.deleteBlob(blobId);
      expect(await hub.blobExists(blobId)).toBe(false);
    });
  });

  // ...........................................................................
  describe('getBlob(blobId, options)', () => {
    it('reads from a peer that holds the blob, before the hub', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      const { content, properties } = await bs.getBlob(blobId);

      expect(content).toEqual(CONTENT);
      expect(properties).toEqual(await peerBs.getBlobProperties(blobId));
    });

    it('passes the range on to the peer', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      const { content } = await bs.getBlob(blobId, {
        range: { start: 2, end: 5 },
      });

      expect(content).toEqual(Buffer.from('234'));
    });

    it('reads from the hub when no peer holds the blob', async () => {
      const { bs: hub, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(hub, await peerHolding(new BsMem()));

      const { content } = await bs.getBlob(blobId, {
        range: { start: 8, end: 10 },
      });

      expect(content).toEqual(Buffer.from('89'));
      // Properties, block list and block: each asked of the peer first.
      expect(peers!.stats).toEqual({ hits: 0, misses: 3, failures: 0 });
    });
  });

  // ...........................................................................
  describe('getBlobProperties(blobId)', () => {
    it('reads from a peer that holds the blob, before the hub', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      expect(await bs.getBlobProperties(blobId)).toEqual(
        await peerBs.getBlobProperties(blobId),
      );
    });

    it('reads from the hub when no peer holds the blob', async () => {
      const { bs: hub, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(hub, await peerHolding(new BsMem()));

      expect(await bs.getBlobProperties(blobId)).toEqual(
        await hub.getBlobProperties(blobId),
      );
    });

    it('rejects with the hub’s own error when nobody holds the blob', async () => {
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(new BsMem()));

      await expect(bs.getBlobProperties('missing')).rejects.toThrow(
        'Blob not found: missing',
      );
    });
  });

  // ...........................................................................
  describe('blobExists(blobId)', () => {
    it('is true as soon as a peer holds the blob, though the hub does not', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      expect(await bs.blobExists(blobId)).toBe(true);
    });

    it('is the hub’s answer when no peer holds the blob', async () => {
      const { bs: hub, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(hub, await peerHolding(new BsMem()));

      expect(await bs.blobExists(blobId)).toBe(true);
      expect(await bs.blobExists('missing')).toBe(false);
    });
  });

  // ...........................................................................
  describe('block reads and writes', () => {
    it('ask a peer that holds the block first, then the hub', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      const [block] = await peerBs.getBlobBlocks(blobId);
      const hub = new BsMem();
      const bs = new PeerFirstBs(hub, await peerHolding(peerBs));

      expect(await bs.getBlobBlocks(blobId)).toEqual([block]);
      expect(await bs.getBlock(block.blockId)).toEqual(CONTENT);
      expect(await bs.blockExists(block.blockId)).toBe(true);
      expect(await bs.blockExists('missing')).toBe(false);
      await expect(bs.getBlock('missing')).rejects.toThrow(
        'Block not found: missing',
      );
    });

    it('write blocks and blobs to the hub', async () => {
      const hub = new BsMem();
      const bs = new PeerFirstBs(hub, noPeers());

      const block = await bs.setBlock(CONTENT);
      expect(await hub.blockExists(block.blockId)).toBe(true);
      const blobId = await blobIdOf();
      expect((await bs.setBlobBlocks(blobId, [block])).blobId).toBe(blobId);
      expect(await hub.blobExists(blobId)).toBe(true);
    });
  });

  // ...........................................................................
  describe('getBlobStream(blobId)', () => {
    it('streams the whole blob from a peer, block by block', async () => {
      const { bs: peerBs, blobId } = await storeWith(LARGE);
      // The hub holds nothing: a single read from it would fail the stream.
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      const { bytes, chunks } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes.equals(LARGE)).toBe(true);
      expect(chunks).toBe((await peerBs.getBlobBlocks(blobId)).length);
      expect(chunks).toBeGreaterThan(1);
    });

    it('finishes from the hub with the same bytes when the peer breaks off mid-blob', async () => {
      const { bs: hub, blobId } = await storeWith(LARGE);
      const blocks = await hub.getBlobBlocks(blobId);
      // The peer serves the first block, then nothing.
      const breaking = new OneBlockSource(blocks, async (blockId, call) =>
        call === 1 ? hub.getBlock(blockId) : undefined,
      );
      peers = breaking;
      const bs = new PeerFirstBs(hub, breaking);

      const { bytes } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes.equals(LARGE)).toBe(true);
      expect(breaking.asked).toEqual(blocks.map((b) => b.blockId));
    });

    it('is the hub’s own stream when no peer holds the blob', async () => {
      const { bs: hub, blobId } = await storeWith(CONTENT);
      const bs = new PeerFirstBs(hub, noPeers());

      const { bytes } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes).toEqual(CONTENT);
    });

    it('ends at once for an empty blob', async () => {
      const empty = Buffer.alloc(0);
      const { bs: peerBs, blobId } = await storeWith(empty);
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs));

      const { bytes, chunks } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes).toEqual(empty);
      expect(chunks).toBe(0);
    });

    it('fails when the blocks do not make the blob', async () => {
      const blobId = await blobIdOf();
      const other = await storeWith(Buffer.from('another blob'));
      // The peer answers with the blocks of another blob.
      const lying = new OneBlockSource(
        await other.bs.getBlobBlocks(other.blobId),
        (blockId) => other.bs.getBlock(blockId),
      );
      peers = lying;
      const bs = new PeerFirstBs(new BsMem(), lying);

      await expect(readAll(await bs.getBlobStream(blobId))).rejects.toThrow(
        `Blocks of blob '${blobId}' make '${other.blobId}'`,
      );
    });
  });
});
