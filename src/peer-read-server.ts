// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import {
  BlobProperties,
  Bs,
  BsMem,
  BsServer,
  DownloadBlobOptions,
  ListBlobsOptions,
  ListBlobsResult,
} from '@rljson/bs';
import { JsonValue } from '@rljson/json';
import { Io, IoMem, IoServer, Socket } from '@rljson/io';
import { ContentType, TableKey } from '@rljson/rljson';

import {
  BackpressureOptions,
  ServeGate,
  withBackpressure,
} from './backpressure.ts';
import { clientMaxServes } from './client.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

// #############################################################################
/**
 * Options of {@link PeerReadServer}.
 */
export interface PeerReadServerOptions {
  /** Logger for connections and throttling. */
  logger?: ServerLogger;

  /** Flow control per peer. Omit for the defaults, the same as the hub's. */
  backpressure?: BackpressureOptions;

  /**
   * How many peer requests are served at the same time, rows and blobs
   * together. When omitted: `SL_CLIENT_MAX_SERVES` from the environment if it
   * is a positive number, else 4.
   */
  maxConcurrentServes?: number;
}

// #############################################################################
/**
 * What a {@link PeerReadServer} served so far.
 */
export interface PeerReadServerStats {
  /** Row reads served: `readRows` and `readRowsByHashes`. */
  rowReads: number;

  /** Blob reads served: `getBlob`, `getBlobProperties`, `blobExists`. */
  blobReads: number;
}

/** The sockets of one peer and what they were gated as. */
interface ServedPeer {
  readonly io: Socket;
  readonly bs: Socket;
  readonly gatedIo: Socket;
  readonly gatedBs: Socket;
  readonly onDisconnect: () => void;
}

/** The reads of a blob store a peer can send. */
type BlobReads = Pick<
  Bs,
  'getBlob' | 'blobExists' | 'getBlobProperties' | 'listBlobs'
>;

/**
 * The blob store of a node that holds no blobs: every read says "not here".
 */
const noBlobs: BlobReads = {
  getBlob: (blobId) => Promise.reject(new Error(`Blob not found: ${blobId}`)),
  blobExists: async () => false,
  getBlobProperties: (blobId) =>
    Promise.reject(new Error(`Blob not found: ${blobId}`)),
  listBlobs: async () => ({ blobs: [] }),
};

/**
 * Rejected for every request that would change the store.
 * @param operation - The refused request.
 * @returns A rejection naming it.
 */
const readOnly = (operation: string): Promise<never> =>
  Promise.reject(new Error(`Peer reads are read-only: ${operation} refused`));

// #############################################################################
/**
 * Answers peers' reads from this node's local stores — the node as a small
 * hub, for reading.
 *
 * The same classes a hub serves with (`IoServer`, `BsServer`), pointed at the
 * local stores instead of a cascade: a peer gets what this node holds, and the
 * question goes no further. Everything that would change the stores — writes,
 * table changes, deletes, closing — is refused.
 *
 * Serving runs under backpressure and a serving gate, like the hub's: many
 * readers at once cost this node at most `maxConcurrentServes` requests in
 * flight.
 */
export class PeerReadServer {
  private readonly _ioServer: IoServer;
  private readonly _bsServer: BsServer;
  private readonly _gate: ServeGate;
  private readonly _logger: ServerLogger;
  private readonly _backpressure: BackpressureOptions;
  private readonly _peers = new Map<Socket, ServedPeer>();
  private readonly _stats: PeerReadServerStats = { rowReads: 0, blobReads: 0 };

  // ...........................................................................
  /**
   * Creates the server.
   * @param io - The local Io to serve.
   * @param bs - The local Bs to serve; omit on a node that holds no blobs —
   *   its blob reads are then answered "not here".
   * @param options - Logger, backpressure and serving limit.
   */
  constructor(io: Io, bs?: Bs, options: PeerReadServerOptions = {}) {
    this._logger = options.logger ?? noopLogger;
    this._backpressure = options.backpressure ?? {};
    this._gate = new ServeGate(
      options.maxConcurrentServes ?? clientMaxServes(),
    );
    this._ioServer = new IoServer(this._readOnlyIo(io));
    // Without blobs, every blob read is answered "not here" — never left
    // unanswered, which a reading peer would take for a dead node.
    this._bsServer = new BsServer(this._readOnlyBs(bs ?? noBlobs));
  }

  // ...........................................................................
  /**
   * Creates a server over empty in-memory stores, for tests and docs.
   * @param options - Overrides.
   * @returns The server.
   */
  static example(options: PeerReadServerOptions = {}): PeerReadServer {
    return new PeerReadServer(new IoMem(), new BsMem(), options);
  }

  // ...........................................................................
  /** How many peers are connected. */
  get peerCount(): number {
    return this._peers.size;
  }

  // ...........................................................................
  /** What was served so far. */
  get stats(): PeerReadServerStats {
    return { ...this._stats };
  }

  // ...........................................................................
  /**
   * Serves a peer's connection until it disconnects.
   * @param socket - The peer's socket, or its namespace bundle.
   */
  async addSocket(socket: SocketLike): Promise<void> {
    const sockets = normalizeSocketBundle(socket);
    // Served already: a second set of handlers would answer every request
    // twice and outlive removeSocket.
    if (this._peers.has(sockets.ioDown)) return;
    const gatedIo = this._gated(sockets.ioDown, 'PeerReadServer.Io');
    const gatedBs = this._gated(sockets.bsDown, 'PeerReadServer.Bs');
    const onDisconnect = () => this.removeSocket(socket);
    const peer: ServedPeer = {
      io: sockets.ioDown,
      bs: sockets.bsDown,
      gatedIo,
      gatedBs,
      onDisconnect,
    };
    this._peers.set(sockets.ioDown, peer);
    sockets.ioDown.on('disconnect', onDisconnect);
    await this._ioServer.addSocket(gatedIo);
    await this._bsServer.addSocket(gatedBs);
    this._logger.info('PeerReadServer', 'Serving a peer', {
      peers: this._peers.size,
    });
  }

  // ...........................................................................
  /**
   * Stops serving a peer's connection. Does not disconnect it.
   * @param socket - The socket given to {@link addSocket}.
   */
  removeSocket(socket: SocketLike): void {
    const sockets = normalizeSocketBundle(socket);
    const peer = this._peers.get(sockets.ioDown);
    if (!peer) return;
    this._peers.delete(sockets.ioDown);
    peer.io.off('disconnect', peer.onDisconnect);
    this._ioServer.removeSocket(peer.gatedIo);
    this._bsServer.removeSocket(peer.gatedBs);
  }

  // ...........................................................................
  /**
   * Disconnects and forgets every peer. The local stores stay open: they
   * belong to the node.
   */
  async close(): Promise<void> {
    for (const peer of [...this._peers.values()]) {
      this.removeSocket(peer.io);
      peer.io.disconnect();
    }
  }

  // ######################
  // Private
  // ######################

  /**
   * Puts a peer's channel under backpressure and the serving gate.
   * @param socket - The channel.
   * @param channel - Log label.
   * @returns The gated socket.
   */
  private _gated(socket: Socket, channel: string): Socket {
    return withBackpressure(socket, {
      ...this._backpressure,
      gate: this._gate,
      onThrottle: (waitedMs, queuedBytes) => {
        this._logger.warn(channel, 'Peer throttled', {
          waitedMs,
          queuedBytes,
          serving: this._gate.inFlight,
          queuedRequests: this._gate.waiting,
        });
        this._backpressure.onThrottle?.(waitedMs, queuedBytes);
      },
    });
  }

  // ...........................................................................
  /**
   * The local Io as peers see it: reads pass, changes are refused.
   * @param io - The local Io.
   * @returns The read-only view.
   */
  private _readOnlyIo(io: Io): Io {
    const stats = this._stats;
    const view: Io = {
      get isOpen() {
        return io.isOpen;
      },
      init: () => readOnly('init'),
      close: () => readOnly('close'),
      isReady: () => io.isReady(),
      dump: () => io.dump(),
      dumpTable: (request: { table: string }) => io.dumpTable(request),
      contentType: (request: { table: string }): Promise<ContentType> =>
        io.contentType(request),
      tableExists: (tableKey: TableKey) => io.tableExists(tableKey),
      createOrExtendTable: () => readOnly('createOrExtendTable'),
      rawTableCfgs: () => io.rawTableCfgs(),
      write: () => readOnly('write'),
      readRows: (request: {
        table: string;
        where: { [column: string]: JsonValue | null };
      }) => {
        stats.rowReads++;
        return io.readRows(request);
      },
      rowCount: (table: string) => io.rowCount(table),
    };
    const batch = io.readRowsByHashes?.bind(io);
    if (batch) {
      view.readRowsByHashes = (request: { table: string; hashes: string[] }) => {
        stats.rowReads++;
        return batch(request);
      };
    }
    return view;
  }

  // ...........................................................................
  /**
   * The local Bs as peers see it: reads pass, changes are refused.
   * @param bs - The local Bs.
   * @returns The read-only view.
   */
  private _readOnlyBs(bs: BlobReads): Bs {
    const stats = this._stats;
    return {
      setBlob: () => readOnly('setBlob'),
      getBlob: (
        blobId: string,
        options?: DownloadBlobOptions,
      ): Promise<{ content: Buffer; properties: BlobProperties }> => {
        stats.blobReads++;
        return bs.getBlob(blobId, options);
      },
      // BsServer has no handler for streams — BsPeer builds them from ranged
      // getBlob calls — so no peer reaches this; the Bs type requires it.
      /* v8 ignore next -- @preserve */
      getBlobStream: () => readOnly('getBlobStream'),
      deleteBlob: () => readOnly('deleteBlob'),
      blobExists: (blobId: string) => {
        stats.blobReads++;
        return bs.blobExists(blobId);
      },
      getBlobProperties: (blobId: string) => {
        stats.blobReads++;
        return bs.getBlobProperties(blobId);
      },
      listBlobs: (options?: ListBlobsOptions): Promise<ListBlobsResult> =>
        bs.listBlobs(options),
      generateSignedUrl: () => readOnly('generateSignedUrl'),
    };
  }
}
