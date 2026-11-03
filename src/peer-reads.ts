// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobProperties, BsPeer, DownloadBlobOptions } from '@rljson/bs';
import { Io, IoPeer } from '@rljson/io';
import { Rljson, Route } from '@rljson/rljson';

import { noopLogger, ServerLogger } from './logger.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

/** A row read: a table and a where clause, as for `Io.readRows`. */
export type ReadRowsRequest = Parameters<Io['readRows']>[0];

/** A batch read: a table and row hashes, as for `Io.readRowsByHashes`. */
export type ReadByHashesRequest = Parameters<
  NonNullable<Io['readRowsByHashes']>
>[0];

// #############################################################################
/**
 * The events a hub and its clients exchange about which node a connection
 * belongs to.
 */
export const peerReadEvents = {
  /**
   * Sent by a client to its hub, with `{ nodeId }`: the node this connection
   * belongs to. The hub names that node as the source of the refs it relays
   * from this connection.
   */
  hello: '__peer:hello',

  /**
   * Sent by a hub to a new connection, without arguments: asks its client
   * for a hello. A hello the client sent before the hub listened — a route
   * the hub was still creating — would otherwise be lost.
   */
  who: '__peer:who',
} as const;

// #############################################################################
/**
 * Opens a connection to a peer.
 *
 * Resolves `undefined` when the node cannot be reached — no address, the hub
 * itself, a node from another site. Should give up when `signal` aborts.
 * @param nodeId - The node to connect to.
 * @param signal - Aborts when the connection took too long.
 * @returns The connected socket, or undefined.
 */
export type ConnectPeer = (
  nodeId: string,
  signal: AbortSignal,
) => Promise<SocketLike | undefined>;

// #############################################################################
/**
 * Options of {@link PeerReads}.
 */
export interface PeerReadsOptions {
  /**
   * This node's id. A client sends it to its hub, so the hub can name this
   * node as the source of the refs it relays.
   */
  nodeId: string;

  /** Opens a connection to a peer. */
  connect: ConnectPeer;

  /**
   * Longest a row read or a blob lookup waits for the peers before the caller
   * asks the hub. Default 1000 ms.
   */
  timeoutMs?: number;

  /**
   * Longest one blob chunk may take on a peer. A blob is read in chunks of up
   * to 4 MB, which takes longer than a row. Default 10 000 ms.
   */
  blobTimeoutMs?: number;

  /** Longest opening a connection to a peer may take. Default 3000 ms. */
  connectTimeoutMs?: number;

  /**
   * How long a node stays a source after the last ref it sent. Default
   * 60 000 ms.
   */
  sourceTtlMs?: number;

  /** How many sources one read asks at once, newest first. Default 2. */
  maxSourcesPerRead?: number;

  /** How many peer connections stay open at once. Default 8. */
  maxConnections?: number;

  /** A peer connection unused for this long is closed. Default 60 000 ms. */
  idleMs?: number;

  /**
   * A peer that failed — refused, timed out, broke off — is skipped for this
   * long. Default 30 000 ms.
   */
  downMs?: number;

  /** Logger for connection and failure events. */
  logger?: ServerLogger;

  /**
   * The route whose relayed refs name the sources. A client takes its own
   * route when this is omitted; give it when the client has none because
   * an agent owns the route's connector.
   */
  route?: Route;
}

// #############################################################################
/**
 * What peer reads achieved so far.
 */
export interface PeerReadStats {
  /** Reads a peer answered. */
  hits: number;

  /** Reads at least one source was asked for, and none answered. */
  misses: number;

  /**
   * Times a peer failed — refused, timed out or broke off — and was set
   * aside for `downMs`. Reads in flight on it when it failed count once.
   */
  failures: number;
}

// #############################################################################
/**
 * A blob found on a peer, to be read from it in ranges.
 */
export interface PeerBlobSource {
  /** The peer holding the blob. */
  nodeId: string;

  /** The blob's properties, as the peer reported them. */
  properties: BlobProperties;

  /**
   * Reads one range of the blob from the peer.
   * @param start - First byte.
   * @param end - Byte after the last one.
   * @returns The bytes, or undefined when the peer failed.
   */
  readRange(start: number, end: number): Promise<Buffer | undefined>;
}

// .............................................................................
/** An open connection to one peer. */
interface PeerLink {
  readonly nodeId: string;
  readonly io: IoPeer;
  readonly bs: BsPeer;
  readonly disconnect: () => void;
  readonly isConnected: () => boolean;
  /**
   * Rejects the moment the connection ends, so a read in flight ends with it
   * instead of waiting out its timeout: with {@link PeerLost} when the peer
   * went away, with {@link PeerRetired} when this side closed the link.
   */
  readonly ended: Promise<never>;
  /** Whether this side closed the link (idle, pool full, close). */
  retired: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastUsed: number;
}

/** The outcome of asking one peer. */
type Attempt<T> =
  | { kind: 'hit'; nodeId: string; value: T }
  | { kind: 'miss' }
  | { kind: 'failed' };

// #############################################################################
/**
 * Reads data directly from the peers that sent it, before the hub is asked.
 *
 * An optimization, never a duty: every read answers `undefined` when no peer
 * could help — no source known, the source gone, slow or without the data —
 * and the caller then asks the hub as before. A read never throws and never
 * waits longer than {@link PeerReadsOptions.timeoutMs}.
 *
 * A peer answers from its own local store only and never forwards the
 * question, so a request costs one hop.
 *
 * Which peers are asked: the nodes that recently sent refs to this client
 * ({@link noteSource}), newest first. A read carries no ref, so the sources are
 * a hint. A wrong hint costs a quick "don't have it"; a peer that fails is
 * skipped for {@link PeerReadsOptions.downMs}.
 */
export class PeerReads {
  private readonly _options: Required<
    Omit<PeerReadsOptions, 'logger' | 'route'>
  >;
  private readonly _logger: ServerLogger;

  /** Source node → when it last sent a ref. Insertion order is recency. */
  private readonly _sources = new Map<string, number>();

  /** Node → until when it is skipped. */
  private readonly _down = new Map<string, number>();

  private readonly _links = new Map<string, PeerLink>();
  private readonly _opening = new Map<string, Promise<PeerLink | undefined>>();
  private readonly _stats: PeerReadStats = { hits: 0, misses: 0, failures: 0 };
  private _closed = false;

  // ...........................................................................
  /**
   * Creates the peer reads of one node.
   * @param options - Identity, connect function and bounds.
   */
  constructor(options: PeerReadsOptions) {
    this._logger = options.logger ?? noopLogger;
    this._options = {
      nodeId: options.nodeId,
      connect: options.connect,
      timeoutMs: options.timeoutMs ?? 1000,
      blobTimeoutMs: options.blobTimeoutMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 3000,
      sourceTtlMs: options.sourceTtlMs ?? 60_000,
      maxSourcesPerRead: options.maxSourcesPerRead ?? 2,
      maxConnections: options.maxConnections ?? 8,
      idleMs: options.idleMs ?? 60_000,
      downMs: options.downMs ?? 30_000,
    };
  }

  // ...........................................................................
  /**
   * Creates peer reads whose peers can never be reached, for tests and docs.
   * @param options - Overrides.
   * @returns The peer reads.
   */
  static example(options: Partial<PeerReadsOptions> = {}): PeerReads {
    return new PeerReads({
      nodeId: 'node-example',
      connect: async () => undefined,
      ...options,
    });
  }

  // ...........................................................................
  /** This node's id. */
  get nodeId(): string {
    return this._options.nodeId;
  }

  // ...........................................................................
  /** What peer reads achieved so far. */
  get stats(): PeerReadStats {
    return { ...this._stats };
  }

  // ...........................................................................
  /** The nodes with an open connection. */
  get connectedPeers(): string[] {
    return [...this._links.keys()];
  }

  // ...........................................................................
  /** Whether {@link close} was called. */
  get isClosed(): boolean {
    return this._closed;
  }

  // ...........................................................................
  /**
   * Records that a node sent a ref: it becomes a source for the next reads,
   * and a connection to it is opened ahead of them.
   * @param nodeId - The node that sent the ref.
   */
  noteSource(nodeId: string): void {
    if (this._closed || nodeId === this._options.nodeId) return;
    this._sources.delete(nodeId);
    this._sources.set(nodeId, Date.now());
    void this._link(nodeId);
  }

  // ...........................................................................
  /**
   * Reads rows from the sources.
   * @param request - Table and where clause, as for `Io.readRows`.
   * @returns The first answer with rows, or undefined.
   */
  async readRows(request: ReadRowsRequest): Promise<Rljson | undefined> {
    const hit = await this._first(
      (link) => link.io.readRows(request),
      (result) => PeerReads._rowCount(result, request.table) > 0,
      this._options.timeoutMs,
    );
    return hit?.value;
  }

  // ...........................................................................
  /**
   * Reads rows by their hashes from the sources.
   * @param request - Table and hashes, as for `Io.readRowsByHashes`.
   * @returns The first answer with rows — possibly not all of them — or
   *   undefined.
   */
  async readRowsByHashes(request: ReadByHashesRequest): Promise<Rljson | undefined> {
    const hit = await this._first(
      (link) => link.io.readRowsByHashes(request),
      (result) => PeerReads._rowCount(result, request.table) > 0,
      this._options.timeoutMs,
    );
    return hit?.value;
  }

  // ...........................................................................
  /**
   * Reads a blob, or a range of it, from the sources.
   * @param blobId - The blob.
   * @param options - Download options, as for `Bs.getBlob`.
   * @returns Content and properties, or undefined.
   */
  async getBlob(
    blobId: string,
    options?: DownloadBlobOptions,
  ): Promise<{ content: Buffer; properties: BlobProperties } | undefined> {
    const hit = await this._first(
      (link) => link.bs.getBlob(blobId, options),
      () => true,
      this._options.blobTimeoutMs,
    );
    return hit?.value;
  }

  // ...........................................................................
  /**
   * Reads a blob's properties from the sources.
   * @param blobId - The blob.
   * @returns The properties, or undefined.
   */
  async getBlobProperties(blobId: string): Promise<BlobProperties | undefined> {
    const hit = await this._first(
      (link) => link.bs.getBlobProperties(blobId),
      () => true,
      this._options.timeoutMs,
    );
    return hit?.value;
  }

  // ...........................................................................
  /**
   * Asks the sources whether they hold a blob.
   * @param blobId - The blob.
   * @returns True when a source holds it, false when none could say so.
   */
  async blobExists(blobId: string): Promise<boolean> {
    const hit = await this._first(
      (link) => link.bs.blobExists(blobId),
      (exists) => exists,
      this._options.timeoutMs,
    );
    return hit !== undefined;
  }

  // ...........................................................................
  /**
   * Finds a source holding a blob, to read it from there in ranges.
   * @param blobId - The blob.
   * @returns The source, or undefined.
   */
  async blobSource(blobId: string): Promise<PeerBlobSource | undefined> {
    const hit = await this._first(
      (link) => link.bs.getBlobProperties(blobId),
      () => true,
      this._options.timeoutMs,
    );
    if (!hit) return undefined;
    const { nodeId, value: properties } = hit;
    return {
      nodeId,
      properties,
      readRange: (start, end) => this._readRange(nodeId, blobId, start, end),
    };
  }

  // ...........................................................................
  /**
   * Closes every peer connection. Reads after this answer undefined.
   */
  async close(): Promise<void> {
    this._closed = true;
    for (const link of [...this._links.values()]) {
      this._drop(link);
    }
    this._sources.clear();
  }

  // ######################
  // Private
  // ######################

  /**
   * Asks the current sources at once and takes the first answer that counts
   * as a hit. Gives up after `timeoutMs`.
   * @param read - The request to one peer.
   * @param isHit - Whether an answer helps the caller.
   * @param timeoutMs - The bound of the whole read.
   * @returns The hit, or undefined.
   */
  private async _first<T>(
    read: (link: PeerLink) => Promise<T>,
    isHit: (value: T) => boolean,
    timeoutMs: number,
  ): Promise<{ nodeId: string; value: T } | undefined> {
    const sources = this._currentSources();
    if (sources.length === 0) return undefined;

    const hit = await new Promise<{ nodeId: string; value: T } | undefined>(
      (resolve) => {
        let open = sources.length;
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        const settle = (result?: { nodeId: string; value: T }) => {
          clearTimeout(timer);
          resolve(result);
        };
        for (const nodeId of sources) {
          void this._attempt(nodeId, read, isHit, timeoutMs).then((outcome) => {
            if (outcome.kind === 'hit') {
              settle({ nodeId: outcome.nodeId, value: outcome.value });
            } else if (--open === 0) {
              settle();
            }
          });
        }
      },
    );

    if (hit) this._stats.hits++;
    else this._stats.misses++;
    return hit;
  }

  // ...........................................................................
  /**
   * Asks one peer. Never rejects.
   * @param nodeId - The peer.
   * @param read - The request.
   * @param isHit - Whether the answer helps.
   * @param timeoutMs - How long the peer may take.
   * @returns What came of it.
   */
  private async _attempt<T>(
    nodeId: string,
    read: (link: PeerLink) => Promise<T>,
    isHit: (value: T) => boolean,
    timeoutMs: number,
  ): Promise<Attempt<T>> {
    const link = await this._link(nodeId);
    if (!link) return { kind: 'failed' };
    this._touch(link);

    try {
      const value = await Promise.race([
        PeerReads._bounded(read(link), timeoutMs),
        link.ended,
      ]);
      return isHit(value) ? { kind: 'hit', nodeId, value } : { kind: 'miss' };
    } catch (error) {
      // "Not here" travels as an error too — a missing table, a missing blob.
      // A link this side closed is no fault of the peer. Only a peer that
      // broke off or went quiet is a failure.
      if (error instanceof PeerRetired) return { kind: 'miss' };
      if (
        error instanceof PeerTimeout ||
        error instanceof PeerLost ||
        !link.isConnected()
      ) {
        this._fail(nodeId, error);
        return { kind: 'failed' };
      }
      return { kind: 'miss' };
    }
  }

  // ...........................................................................
  /**
   * Reads one range of a blob from one peer.
   * @param nodeId - The peer.
   * @param blobId - The blob.
   * @param start - First byte.
   * @param end - Byte after the last one.
   * @returns The bytes, or undefined when the peer failed.
   */
  private async _readRange(
    nodeId: string,
    blobId: string,
    start: number,
    end: number,
  ): Promise<Buffer | undefined> {
    const outcome = await this._attempt(
      nodeId,
      (link) => link.bs.getBlob(blobId, { range: { start, end } }),
      ({ content }) => content.length > 0,
      this._options.blobTimeoutMs,
    );
    return outcome.kind === 'hit' ? outcome.value.content : undefined;
  }

  // ...........................................................................
  /**
   * The sources a read asks: recent, not down, newest first.
   * @returns Node ids.
   */
  private _currentSources(): string[] {
    if (this._closed) return [];
    const now = Date.now();
    const result: string[] = [];
    for (const [nodeId, at] of [...this._sources.entries()].reverse()) {
      if (now - at > this._options.sourceTtlMs) {
        this._sources.delete(nodeId);
        continue;
      }
      if (this._isDown(nodeId)) continue;
      result.push(nodeId);
      if (result.length === this._options.maxSourcesPerRead) break;
    }
    return result;
  }

  // ...........................................................................
  /**
   * The open connection to a peer, opening it when needed.
   * @param nodeId - The peer.
   * @returns The connection, or undefined when it cannot be had.
   */
  private _link(nodeId: string): Promise<PeerLink | undefined> {
    const open = this._links.get(nodeId);
    if (open) return Promise.resolve(open);

    const opening = this._opening.get(nodeId);
    if (opening) return opening;

    if (this._closed || this._isDown(nodeId)) return Promise.resolve(undefined);

    const next = this._open(nodeId).finally(() => this._opening.delete(nodeId));
    this._opening.set(nodeId, next);
    return next;
  }

  // ...........................................................................
  /**
   * Opens a connection to a peer, bounded by `connectTimeoutMs`.
   * @param nodeId - The peer.
   * @returns The connection, or undefined.
   */
  private async _open(nodeId: string): Promise<PeerLink | undefined> {
    const abort = new AbortController();
    let socket: SocketLike | undefined;
    let gaveUp = false;

    try {
      const connected = (async () => {
        socket = await this._options.connect(nodeId, abort.signal);
        if (!socket) return undefined;
        const sockets = normalizeSocketBundle(socket);
        // The peers' own request timeouts must lose to this class's bounds:
        // theirs end in a plain error, which would read as "not here".
        const requestTimeoutMs =
          2 * Math.max(this._options.timeoutMs, this._options.blobTimeoutMs);
        const io = new IoPeer(sockets.ioDown, requestTimeoutMs);
        const bs = new BsPeer(sockets.bsDown, { requestTimeoutMs });
        await io.init();
        await bs.init();
        return { io, bs, sockets };
      })();

      // A late connection that arrives after the bound is closed again.
      connected.then(
        (peer) => {
          if (gaveUp) PeerReads._disconnect(peer?.sockets);
        },
        () => undefined,
      );

      const peer = await PeerReads._bounded(
        connected,
        this._options.connectTimeoutMs,
      ).catch((error) => {
        gaveUp = true;
        abort.abort();
        throw error;
      });

      if (!peer) {
        // No way to reach this node. Asking again on every read would only
        // repeat the answer.
        this._markDown(nodeId);
        return undefined;
      }

      if (this._closed) {
        PeerReads._disconnect(peer.sockets);
        return undefined;
      }

      this._evictIfFull();

      // Every socket of the connection: with split namespaces, the blob
      // channel can drop on its own.
      const watched = [...new Set([peer.sockets.ioDown, peer.sockets.bsDown])];
      const ended = new Promise<never>((_, reject) => {
        const onDisconnect = () => {
          reject(link.retired ? new PeerRetired() : new PeerLost());
          if (this._links.get(nodeId) === link) this._drop(link);
        };
        for (const watchedSocket of watched) {
          watchedSocket.on('disconnect', onDisconnect);
        }
      });
      ended.catch(() => undefined);
      const link: PeerLink = {
        nodeId,
        io: peer.io,
        bs: peer.bs,
        lastUsed: Date.now(),
        disconnect: () => PeerReads._disconnect(peer.sockets),
        isConnected: () => watched.every((w) => w.connected),
        ended,
        retired: false,
      };
      this._links.set(nodeId, link);
      this._touch(link);
      this._logger.info('PeerReads', 'Connected to peer', { nodeId });
      return link;
    } catch (error) {
      PeerReads._disconnect(
        socket === undefined ? undefined : normalizeSocketBundle(socket),
      );
      this._fail(nodeId, error);
      return undefined;
    }
  }

  // ...........................................................................
  /**
   * Marks a link as used and restarts its idle timer.
   * @param link - The link.
   */
  private _touch(link: PeerLink): void {
    link.lastUsed = Date.now();
    clearTimeout(link.idleTimer);
    link.idleTimer = setTimeout(() => this._drop(link), this._options.idleMs);
    link.idleTimer.unref?.();
  }

  // ...........................................................................
  /** Closes the least recently used link when the pool is full. */
  private _evictIfFull(): void {
    if (this._links.size < this._options.maxConnections) return;
    let oldest: PeerLink | undefined;
    for (const link of this._links.values()) {
      if (!oldest || link.lastUsed < oldest.lastUsed) oldest = link;
    }
    /* v8 ignore else -- @preserve */
    if (oldest) this._drop(oldest);
  }

  // ...........................................................................
  /**
   * Closes a link and removes it from the pool.
   * @param link - The link.
   */
  private _drop(link: PeerLink): void {
    link.retired = true;
    clearTimeout(link.idleTimer);
    if (this._links.get(link.nodeId) === link) this._links.delete(link.nodeId);
    link.disconnect();
  }

  // ...........................................................................
  /**
   * Records a failed peer: counted, skipped for `downMs`, connection closed.
   * @param nodeId - The peer.
   * @param error - What went wrong.
   */
  private _fail(nodeId: string, error: unknown): void {
    // One break-off fails every read in flight on it: count the peer once.
    const alreadyDown = this._isDown(nodeId);
    this._markDown(nodeId);
    const link = this._links.get(nodeId);
    if (link) this._drop(link);
    if (alreadyDown) return;
    this._stats.failures++;
    this._logger.warn('PeerReads', 'Peer failed, asking the hub', {
      nodeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // ...........................................................................
  /**
   * Skips a node for `downMs`.
   * @param nodeId - The node.
   */
  private _markDown(nodeId: string): void {
    this._down.set(nodeId, Date.now() + this._options.downMs);
  }

  // ...........................................................................
  /**
   * Whether a node is skipped right now.
   * @param nodeId - The node.
   * @returns True while it is down.
   */
  private _isDown(nodeId: string): boolean {
    const until = this._down.get(nodeId);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this._down.delete(nodeId);
    return false;
  }

  // ...........................................................................
  /**
   * Counts the rows of one table in an Rljson answer.
   * @param result - The answer.
   * @param table - The table.
   * @returns The number of rows.
   */
  private static _rowCount(result: Rljson, table: string): number {
    const data = (result?.[table] as { _data?: unknown[] } | undefined)?._data;
    return Array.isArray(data) ? data.length : 0;
  }

  // ...........................................................................
  /**
   * Rejects with {@link PeerTimeout} when a promise takes too long.
   * @param promise - The promise.
   * @param timeoutMs - The bound.
   * @returns The promise's value.
   */
  private static _bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PeerTimeout(timeoutMs)),
        timeoutMs,
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ...........................................................................
  /**
   * Disconnects every distinct socket of a bundle.
   * @param sockets - The bundle, if any.
   */
  private static _disconnect(
    sockets: ReturnType<typeof normalizeSocketBundle> | undefined,
  ): void {
    if (!sockets) return;
    for (const socket of new Set(Object.values(sockets))) {
      socket.disconnect();
    }
  }
}

// #############################################################################
/** A peer that did not answer in time. */
class PeerTimeout extends Error {
  // ...........................................................................
  /**
   * Creates the error.
   * @param timeoutMs - The bound that passed.
   */
  constructor(timeoutMs: number) {
    super(`Peer did not answer within ${timeoutMs} ms`);
  }
}

// #############################################################################
/** A peer whose connection ended while a read was in flight. */
class PeerLost extends Error {
  // ...........................................................................
  /** Creates the error. */
  constructor() {
    super('Peer connection lost');
  }
}

// #############################################################################
/** A link this side closed while a read was in flight. */
class PeerRetired extends Error {
  // ...........................................................................
  /** Creates the error. */
  constructor() {
    super('Peer connection closed by this node');
  }
}
