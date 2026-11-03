// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem, BsPeer, BsServer } from '@rljson/bs';
import { createSocketPair } from '@rljson/io';
import { afterEach, describe, expect, it } from 'vitest';

import { PeerBlobSource, PeerFirstBs, PeerReads } from '../src/index.ts';

// .............................................................................

/** Ten bytes: three ranges of four, the last one short. */
const CONTENT = Buffer.from('0123456789');

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
 * Peer reads whose one source is a hand-written blob source, for the cases a
 * real peer cannot be made to show on cue: breaking off mid-blob, or
 * answering a range with nothing.
 */
class OneBlobSource extends PeerReads {
  /** Every range the source was asked for, in order. */
  readonly asked: Array<[number, number]> = [];

  /**
   * Creates the peer reads.
   * @param _size - The size the source reports.
   * @param _answer - What the source answers for a range.
   */
  constructor(
    private readonly _size: number,
    private readonly _answer: (
      start: number,
      end: number,
      call: number,
    ) => Buffer | undefined,
  ) {
    super({ nodeId: 'me', connect: async () => undefined });
  }

  override async blobSource(blobId: string): Promise<PeerBlobSource> {
    return {
      nodeId: 'peer-1',
      properties: { blobId, size: this._size, createdAt: new Date() },
      readRange: async (start, end) => {
        this.asked.push([start, end]);
        return this._answer(start, end, this.asked.length);
      },
    };
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
      expect(peers!.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
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
  describe('getBlobStream(blobId)', () => {
    it('streams the whole blob from a peer, range by range', async () => {
      const { bs: peerBs, blobId } = await storeWith(CONTENT);
      // The hub holds nothing: a single read from it would fail the stream.
      const bs = new PeerFirstBs(new BsMem(), await peerHolding(peerBs), 4);

      const { bytes, chunks } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes).toEqual(CONTENT);
      expect(chunks).toBe(3);
    });

    it('finishes from the hub with the same bytes when the peer breaks off mid-blob', async () => {
      const { bs: hub, blobId } = await storeWith(CONTENT);
      // The peer serves the first range, then fails.
      const breaking = new OneBlobSource(CONTENT.length, (start, end, call) =>
        call === 1 ? CONTENT.subarray(start, end) : undefined,
      );
      peers = breaking;
      const bs = new PeerFirstBs(hub, breaking, 4);

      const { bytes, chunks } = await readAll(await bs.getBlobStream(blobId));

      expect(bytes).toEqual(CONTENT);
      expect(chunks).toBe(3);
      // Once broken off, the peer is not asked again.
      expect(breaking.asked).toEqual([
        [0, 4],
        [4, 8],
      ]);
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

    it('fails instead of spinning when a range comes back empty', async () => {
      const blobId = await blobIdOf();
      // The peer claims two bytes more than the blob has.
      const overstating = new OneBlobSource(CONTENT.length + 2, (start, end) =>
        CONTENT.subarray(start, end),
      );
      peers = overstating;
      const bs = new PeerFirstBs(new BsMem(), overstating, 4);

      await expect(readAll(await bs.getBlobStream(blobId))).rejects.toThrow(
        `Blob '${blobId}' returned no bytes for range 10-12 of 12`,
      );
    });
  });
});
