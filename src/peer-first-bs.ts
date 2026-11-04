// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  BlobBlock,
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
  readBlocks,
  streamBlocks,
} from '@rljson/bs';

import { PeerReads } from './peer-reads.ts';

// #############################################################################
/**
 * A Bs that asks the peers first and the hub second.
 *
 * The blob counterpart of {@link PeerFirstIo}: reads go to {@link PeerReads}
 * first, and whatever the peers cannot answer goes to the hub unchanged.
 * Writes, deletes, listings and signed URLs go to the hub directly.
 *
 * A blob is read block by block, and every block is asked for on its own:
 * from a peer when one holds it, otherwise from the hub. Blocks are
 * content-addressed, so a read goes on from the hub where a peer broke off,
 * and a peer serves any block it holds, whichever blob it came with.
 */
export class PeerFirstBs implements Bs {
  // ...........................................................................
  /**
   * Creates the wrapper.
   * @param _hub - The client's Bs to the hub.
   * @param _peers - The peer reads of this client.
   */
  constructor(
    private readonly _hub: Bs,
    private readonly _peers: PeerReads,
  ) {}

  // ...........................................................................
  /**
   * The hub's `isOpen` flag, when its Bs has one: a closed hub connection
   * makes the multi skip this member, exactly as it skips the hub's.
   */
  get isOpen(): boolean | undefined {
    return (this._hub as { isOpen?: boolean }).isOpen;
  }

  // ...........................................................................
  /**
   * Stores a blob on the hub.
   * @param content - The content.
   */
  setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties> {
    return this._hub.setBlob(content);
  }

  // ...........................................................................
  /**
   * Reads a blob, or a range of it, block by block: each block from a peer
   * when one has it, otherwise from the hub.
   * @param blobId - The blob.
   * @param options - Download options.
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    const properties = await this.getBlobProperties(blobId);
    const blocks = await this.getBlobBlocks(blobId);
    const content = await readBlocks(
      blocks,
      (blockId) => this.getBlock(blockId),
      options?.range,
    );
    return { content, properties };
  }

  // ...........................................................................
  /**
   * Streams a blob block by block: each block from a peer when one has it,
   * otherwise from the hub.
   * @param blobId - The blob.
   */
  async getBlobStream(blobId: string): Promise<ReadableStream> {
    const blocks = await this.getBlobBlocks(blobId);
    return streamBlocks(blobId, blocks, (blockId) => this.getBlock(blockId));
  }

  // ...........................................................................
  /**
   * A blob's blocks: from a peer when one has them, otherwise from the hub.
   * @param blobId - The blob.
   */
  async getBlobBlocks(blobId: string): Promise<BlobBlock[]> {
    return (
      (await this._peers.getBlobBlocks(blobId)) ??
      this._hub.getBlobBlocks(blobId)
    );
  }

  // ...........................................................................
  /**
   * One block: from a peer when one has it, otherwise from the hub.
   * @param blockId - The block.
   */
  async getBlock(blockId: string): Promise<Buffer> {
    return (await this._peers.getBlock(blockId)) ?? this._hub.getBlock(blockId);
  }

  // ...........................................................................
  /**
   * Whether a block exists: true as soon as a peer holds it, otherwise the
   * hub's answer.
   * @param blockId - The block.
   */
  async blockExists(blockId: string): Promise<boolean> {
    return (
      (await this._peers.blockExists(blockId)) || this._hub.blockExists(blockId)
    );
  }

  // ...........................................................................
  /**
   * Stores one block on the hub.
   * @param content - The block's bytes.
   */
  setBlock(content: Buffer): Promise<BlobBlock> {
    return this._hub.setBlock(content);
  }

  // ...........................................................................
  /**
   * Stores a blob made of blocks the hub holds.
   * @param blobId - The blob.
   * @param blocks - Its blocks, in order.
   */
  setBlobBlocks(blobId: string, blocks: BlobBlock[]): Promise<BlobProperties> {
    return this._hub.setBlobBlocks(blobId, blocks);
  }

  // ...........................................................................
  /**
   * Deletes a blob on the hub.
   * @param blobId - The blob.
   */
  deleteBlob(blobId: string): Promise<void> {
    return this._hub.deleteBlob(blobId);
  }

  // ...........................................................................
  /**
   * Whether a blob exists: true as soon as a peer holds it, otherwise the
   * hub's answer.
   * @param blobId - The blob.
   */
  async blobExists(blobId: string): Promise<boolean> {
    return (
      (await this._peers.blobExists(blobId)) || this._hub.blobExists(blobId)
    );
  }

  // ...........................................................................
  /**
   * A blob's properties: from a peer when one has it, otherwise from the hub.
   * @param blobId - The blob.
   */
  async getBlobProperties(blobId: string): Promise<BlobProperties> {
    return (
      (await this._peers.getBlobProperties(blobId)) ??
      this._hub.getBlobProperties(blobId)
    );
  }

  // ...........................................................................
  /**
   * Lists the hub's blobs.
   * @param options - List options.
   */
  listBlobs(options?: ListBlobsOptions): Promise<ListBlobsResult> {
    return this._hub.listBlobs(options);
  }

  // ...........................................................................
  /**
   * A signed URL from the hub.
   * @param blobId - The blob.
   * @param expiresIn - Seconds until it expires.
   * @param permissions - What it allows.
   */
  generateSignedUrl(
    blobId: string,
    expiresIn: number,
    permissions?: 'read' | 'delete',
  ): Promise<string> {
    return this._hub.generateSignedUrl(blobId, expiresIn, permissions);
  }
}
