// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  BLOB_CHUNK_BYTES,
  BlobProperties,
  Bs,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
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
 * A stream switches sources mid-blob: blobs are content-addressed, so the
 * bytes after a peer broke off are the same on the hub, and the stream goes
 * on from there.
 */
export class PeerFirstBs implements Bs {
  // ...........................................................................
  /**
   * Creates the wrapper.
   * @param _hub - The client's Bs to the hub.
   * @param _peers - The peer reads of this client.
   * @param _chunkBytes - Size of one range read of a stream.
   */
  constructor(
    private readonly _hub: Bs,
    private readonly _peers: PeerReads,
    private readonly _chunkBytes: number = BLOB_CHUNK_BYTES,
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
  setBlob(
    content: Buffer | string | ReadableStream,
  ): Promise<BlobProperties> {
    return this._hub.setBlob(content);
  }

  // ...........................................................................
  /**
   * Reads a blob: from a peer when one has it, otherwise from the hub.
   * @param blobId - The blob.
   * @param options - Download options.
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties }> {
    return (
      (await this._peers.getBlob(blobId, options)) ??
      this._hub.getBlob(blobId, options)
    );
  }

  // ...........................................................................
  /**
   * Streams a blob: from a peer when one has it, finishing from the hub when
   * that peer breaks off.
   * @param blobId - The blob.
   */
  async getBlobStream(blobId: string): Promise<ReadableStream> {
    const source = await this._peers.blobSource(blobId);
    if (!source) return this._hub.getBlobStream(blobId);

    const { size } = source.properties;
    const hub = this._hub;
    const chunkBytes = this._chunkBytes;
    let offset = 0;
    let fromPeer = true;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (offset >= size) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkBytes, size);
        let content = fromPeer
          ? await source.readRange(offset, end)
          : undefined;
        if (content === undefined) {
          fromPeer = false;
          content = (await hub.getBlob(blobId, { range: { start: offset, end } }))
            .content;
        }
        if (content.length === 0) {
          throw new Error(
            `Blob '${blobId}' returned no bytes for range ` +
              `${String(offset)}-${String(end)} of ${String(size)}`,
          );
        }
        offset += content.length;
        controller.enqueue(new Uint8Array(content));
      },
    });
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
    return (await this._peers.blobExists(blobId)) || this._hub.blobExists(blobId);
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
