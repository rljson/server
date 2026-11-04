// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, BsPeer } from '@rljson/bs';
import {
  createSocketPair,
  DirectionalSocketMock,
  Io,
  IoMem,
  IoPeer,
  Socket,
} from '@rljson/io';
import { exampleTableCfg, Rljson } from '@rljson/rljson';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BufferedLogger,
  PeerReadServer,
  PeerReadServerOptions,
} from '../src/index.ts';

// .............................................................................

/** The table every test reads. */
const TABLE = 'notes';

/** A row of {@link TABLE}. */
type Note = { a: string; b: number; _hash?: string };

/** One blob, stored on the node. */
const CONTENT = Buffer.from('0123456789');

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The rows of {@link TABLE} in an answer.
 * @param answer - The answer.
 * @returns Its rows.
 */
const rowsOf = (answer: Rljson): Note[] =>
  (answer[TABLE] as unknown as { _data: Note[] })._data;

/**
 * Fills a store with {@link TABLE} and two rows.
 * @param io - The store.
 * @returns The store and the rows' hashes.
 */
const fill = async <T extends IoMem>(
  io: T,
): Promise<{ io: T; hashes: string[] }> => {
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  await io.write({
    data: {
      [TABLE]: {
        _data: [
          { a: 'first', b: 1 },
          { a: 'second', b: 2 },
        ],
        _hash: '',
        _type: 'components',
      },
    } as unknown as Rljson,
  });
  const rows = rowsOf(await io.dumpTable({ table: TABLE }));
  return { io, hashes: rows.map((row) => row._hash!) };
};

/**
 * An Io as an older store offers it: without batch reads.
 * @param io - The Io to hide them on.
 * @returns The same Io, minus `readRowsByHashes`.
 */
const withoutBatchReads = (io: Io): Io =>
  new Proxy(io, {
    get: (target, key) =>
      key === 'readRowsByHashes' ? undefined : Reflect.get(target, key),
  });

/** A local store with slow row reads that counts how many run at once. */
class SlowIo extends IoMem {
  running = 0;
  peak = 0;

  override async readRows(
    request: Parameters<IoMem['readRows']>[0],
  ): Promise<Rljson> {
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    try {
      await tick(20);
      return await super.readRows(request);
    } finally {
      this.running--;
    }
  }
}

/**
 * Sends one Io request over the wire the way `IoPeer` does, for the requests
 * `IoPeer` answers on its own side and never sends.
 * @param socket - The peer's socket.
 * @param event - The request.
 * @returns The answer.
 */
const ask = (socket: Socket, event: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    socket.emit(event, (result: unknown, error: unknown) =>
      error ? reject(error as Error) : resolve(result),
    );
  });

// .............................................................................

describe('PeerReadServer', () => {
  let local: { io: IoMem; bs: BsMem; blobId: string; hashes: string[] };
  let server: PeerReadServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /**
   * A node's local stores: two rows and one blob.
   * @returns The stores.
   */
  const localStores = async () => {
    const { io, hashes } = await fill(new IoMem());
    const bs = new BsMem();
    const { blobId } = await bs.setBlob(CONTENT);
    local = { io, bs, blobId, hashes };
    return local;
  };

  /**
   * A server over the node's local stores.
   * @param options - Server options under test.
   * @returns The server.
   */
  const serve = async (options: PeerReadServerOptions = {}) => {
    const { io, bs } = await localStores();
    server = new PeerReadServer(io, bs, options);
    return server;
  };

  /**
   * Connects a peer over one socket, the classic setup.
   * @param to - The server.
   * @param requestTimeoutMs - How long the peer waits for an answer.
   * @returns Both ends, and the peer's Io and Bs.
   */
  const connect = async (to: PeerReadServer, requestTimeoutMs = 30_000) => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    await to.addSocket(serverSide);
    const io = new IoPeer(clientSide, requestTimeoutMs);
    const bs = new BsPeer(clientSide, { requestTimeoutMs });
    await io.init();
    await bs.init();
    return { serverSide, clientSide, io, bs };
  };

  // ...........................................................................
  describe('example()', () => {
    it('serves empty stores', async () => {
      server = PeerReadServer.example();
      const { io, bs } = await connect(server);

      expect(await io.tableExists(TABLE)).toBe(false);
      expect(await bs.blobExists('anything')).toBe(false);
      expect(await bs.listBlobs()).toEqual({
        blobs: [],
        continuationToken: undefined,
      });
    });

    it('takes options', async () => {
      const logger = new BufferedLogger();
      server = PeerReadServer.example({ logger });
      await connect(server);

      expect(logger.byLevel('info').map((e) => e.message)).toEqual([
        'Serving a peer',
      ]);
    });
  });

  // ...........................................................................
  describe('addSocket(socket)', () => {
    it('serves a socket it already serves only once', async () => {
      server = await serve();
      const { serverSide, io } = await connect(server);
      const before = server.stats.rowReads;

      await server.addSocket(serverSide);
      await io.readRows({ table: TABLE, where: { a: 'first' } });

      expect(server.peerCount).toBe(1);
      expect(server.stats.rowReads).toBe(before + 1);
    });

    it('serves the peer’s reads from the local stores and says so in the log', async () => {
      const logger = new BufferedLogger();
      server = await serve({ logger });

      const { io, bs } = await connect(server);

      expect(server.peerCount).toBe(1);
      const request = { table: TABLE, where: { a: 'first' } };
      expect(rowsOf(await io.readRows(request))).toEqual(
        rowsOf(await local.io.readRows(request)),
      );
      expect((await bs.getBlob(local.blobId)).content).toEqual(CONTENT);
      expect(logger.byLevel('info')).toEqual([
        expect.objectContaining({
          source: 'PeerReadServer',
          message: 'Serving a peer',
          data: { peers: 1 },
        }),
      ]);
    });

    it('serves a peer connected over split namespaces', async () => {
      server = await serve();
      const [ioDown, ioPeerSide] = createSocketPair();
      const [bsDown, bsPeerSide] = createSocketPair();
      const [ioUp] = createSocketPair();
      const [bsUp] = createSocketPair();
      ioDown.connect();
      bsDown.connect();
      const bundle = { ioUp, ioDown, bsUp, bsDown };

      await server.addSocket(bundle);
      const io = new IoPeer(ioPeerSide);
      const bs = new BsPeer(bsPeerSide);
      await io.init();
      await bs.init();

      expect(await io.rowCount(TABLE)).toBe(2);
      expect(await bs.blobExists(local.blobId)).toBe(true);
      // Each request arrives on its own namespace only.
      expect(ioDown.listenerCount('getBlob')).toBe(0);
      expect(bsDown.listenerCount('readRows')).toBe(0);

      server.removeSocket(bundle);
      expect(server.peerCount).toBe(0);
      expect(ioDown.listenerCount('readRows')).toBe(0);
      expect(bsDown.listenerCount('getBlob')).toBe(0);
    });

    it('serves rows, and answers every blob read "not here", when the node holds no blobs', async () => {
      const { io: localIo } = await fill(new IoMem());
      server = new PeerReadServer(localIo);
      const { serverSide, io, bs } = await connect(server, 50);

      expect(await io.rowCount(TABLE)).toBe(2);
      expect(await bs.blobExists('anything')).toBe(false);
      expect(await bs.listBlobs()).toEqual(
        expect.objectContaining({ blobs: [] }),
      );
      expect(await bs.blockExists('anything')).toBe(false);
      await expect(bs.getBlob('anything')).rejects.toBeDefined();
      await expect(bs.getBlock('anything')).rejects.toThrow(
        'Block not found: anything',
      );
      await expect(bs.getBlobBlocks('anything')).rejects.toThrow(
        'Blob not found: anything',
      );
      await expect(bs.getBlobProperties('anything')).rejects.toBeDefined();
      await expect(bs.setBlob('x')).rejects.toBeDefined();
      await expect(bs.deleteBlob('anything')).rejects.toBeDefined();

      server.removeSocket(serverSide);
      expect(server.peerCount).toBe(0);
      expect(serverSide.listenerCount('readRows')).toBe(0);
    });
  });

  // ...........................................................................
  describe('reads', () => {
    it('answer every read a peer can send', async () => {
      server = await serve();
      const { clientSide, io, bs } = await connect(server);

      expect(await ask(clientSide, 'isOpen')).toBe(true);
      expect(await ask(clientSide, 'isReady')).toBeUndefined();
      expect(await io.dump()).toEqual(await local.io.dump());
      expect(await io.dumpTable({ table: TABLE })).toEqual(
        await local.io.dumpTable({ table: TABLE }),
      );
      expect(await io.contentType({ table: TABLE })).toBe('components');
      expect(await io.tableExists(TABLE)).toBe(true);
      expect(await io.rawTableCfgs()).toEqual(await local.io.rawTableCfgs());
      expect(await io.rowCount(TABLE)).toBe(2);
      const byHashes = { table: TABLE, hashes: local.hashes };
      expect(rowsOf(await io.readRowsByHashes(byHashes))).toHaveLength(2);
      expect(await bs.getBlobProperties(local.blobId)).toEqual(
        await local.bs.getBlobProperties(local.blobId),
      );
      expect(await bs.listBlobs()).toEqual(await local.bs.listBlobs());
      const range = await bs.getBlob(local.blobId, {
        range: { start: 4, end: 8 },
      });
      expect(range.content).toEqual(Buffer.from('4567'));
    });

    it('count the row and blob reads served, and nothing else', async () => {
      server = await serve();
      const { clientSide, io, bs } = await connect(server);

      // Not counted: everything that is not a row or a blob.
      await ask(clientSide, 'isOpen');
      await ask(clientSide, 'isReady');
      await io.dump();
      await io.dumpTable({ table: TABLE });
      await io.contentType({ table: TABLE });
      await io.tableExists(TABLE);
      await io.rawTableCfgs();
      await io.rowCount(TABLE);
      await bs.listBlobs();
      expect(server.stats).toEqual({ rowReads: 0, blobReads: 0 });

      await io.readRows({ table: TABLE, where: { a: 'first' } });
      await io.readRowsByHashes({ table: TABLE, hashes: local.hashes });
      // One blob read is three requests: properties, block list, one block.
      await bs.getBlob(local.blobId);
      await bs.getBlobProperties(local.blobId);
      await bs.blobExists(local.blobId);
      await bs.blockExists('a-block');
      expect(server.stats).toEqual({ rowReads: 2, blobReads: 6 });
    });

    it('report stats as a copy', async () => {
      server = await serve();
      const stats = server.stats;
      stats.rowReads = 99;
      expect(server.stats).toEqual({ rowReads: 0, blobReads: 0 });
    });

    it('offer readRowsByHashes only when the local Io has it', async () => {
      const { io: localIo, hashes } = await fill(new IoMem());
      server = new PeerReadServer(withoutBatchReads(localIo), new BsMem());
      const { clientSide, io } = await connect(server);

      await expect(
        new Promise((resolve, reject) =>
          clientSide.emit(
            'readRowsByHashes',
            { table: TABLE, hashes },
            (result: unknown, error: unknown) =>
              error ? reject(error as Error) : resolve(result),
          ),
        ),
      ).rejects.toThrow('Method "readRowsByHashes" not found on Io instance');
      expect(server.stats).toEqual({ rowReads: 0, blobReads: 0 });

      // A peer still gets its rows: IoPeer falls back to one read per hash.
      const answer = await io.readRowsByHashes({ table: TABLE, hashes });
      expect(rowsOf(answer)).toHaveLength(2);
      expect(server.stats).toEqual({ rowReads: 2, blobReads: 0 });
    });
  });

  // ...........................................................................
  describe('changes', () => {
    it('are refused for the Io, and leave the local store untouched', async () => {
      server = await serve();
      const { clientSide, io } = await connect(server);
      const before = await local.io.dump();

      await expect(ask(clientSide, 'init')).rejects.toThrow(
        'Peer reads are read-only: init refused',
      );
      await expect(ask(clientSide, 'close')).rejects.toThrow(
        'Peer reads are read-only: close refused',
      );
      await expect(
        io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: 'other' }) }),
      ).rejects.toThrow(
        'Peer reads are read-only: createOrExtendTable refused',
      );
      await expect(
        io.write({
          data: {
            [TABLE]: {
              _data: [{ a: 'third', b: 3 }],
              _hash: '',
              _type: 'components',
            },
          } as unknown as Rljson,
        }),
      ).rejects.toThrow('Peer reads are read-only: write refused');

      expect(local.io.isOpen).toBe(true);
      expect(await local.io.dump()).toEqual(before);
    });

    it('are refused for the Bs, and leave the local store untouched', async () => {
      server = await serve();
      const { bs } = await connect(server);

      // A peer's setBlob sends blocks first: refused at the first one.
      await expect(bs.setBlob(Buffer.from('new'))).rejects.toThrow(
        'Peer reads are read-only: setBlock refused',
      );
      await expect(bs.setBlobBlocks(local.blobId, [])).rejects.toThrow(
        'Peer reads are read-only: setBlobBlocks refused',
      );
      await expect(bs.deleteBlob(local.blobId)).rejects.toThrow(
        'Peer reads are read-only: deleteBlob refused',
      );
      await expect(bs.generateSignedUrl(local.blobId, 60)).rejects.toThrow(
        'Peer reads are read-only: generateSignedUrl refused',
      );

      expect((await local.bs.listBlobs()).blobs.map((b) => b.blobId)).toEqual([
        local.blobId,
      ]);
    });
  });

  // ...........................................................................
  describe('removeSocket(socket)', () => {
    it('stops serving the peer without disconnecting it', async () => {
      server = await serve();
      const { serverSide, io } = await connect(server, 50);

      server.removeSocket(serverSide);

      expect(server.peerCount).toBe(0);
      expect(serverSide.connected).toBe(true);
      expect(serverSide.listenerCount('disconnect')).toBe(0);
      await expect(io.rowCount(TABLE)).rejects.toThrow(
        'Timeout after 50ms: rowCount',
      );
    });

    it('does nothing for a socket it does not serve', async () => {
      server = await serve();
      await connect(server);

      const [stranger] = createSocketPair();
      server.removeSocket(stranger);
      server.removeSocket(stranger);

      expect(server.peerCount).toBe(1);
    });
  });

  // ...........................................................................
  describe('a peer’s disconnect', () => {
    it('removes the peer', async () => {
      server = await serve();
      const { serverSide, clientSide } = await connect(server);
      await connect(server);
      expect(server.peerCount).toBe(2);

      clientSide.disconnect();

      expect(server.peerCount).toBe(1);
      expect(serverSide.listenerCount('readRows')).toBe(0);
    });
  });

  // ...........................................................................
  describe('close()', () => {
    it('disconnects every peer and leaves the local stores open', async () => {
      server = await serve();
      const first = await connect(server);
      const second = await connect(server);

      await server.close();

      expect(server.peerCount).toBe(0);
      expect(first.io.isOpen).toBe(false);
      expect(second.bs.isOpen).toBe(false);
      expect(local.io.isOpen).toBe(true);
      expect(await local.io.rowCount(TABLE)).toBe(2);
      expect(await local.bs.blobExists(local.blobId)).toBe(true);
    });
  });

  // ...........................................................................
  describe('serving gate', () => {
    it('serves at most maxConcurrentServes reads at once', async () => {
      const { io: localIo } = await fill(new SlowIo());
      server = new PeerReadServer(localIo, new BsMem(), {
        maxConcurrentServes: 2,
      });
      const peers = [await connect(server), await connect(server)];

      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          peers[i % 2]!.io.readRows({ table: TABLE, where: {} }),
        ),
      );

      // Shared across peers: two peers do not get two slots each.
      expect(localIo.peak).toBe(2);
    });

    it('defaults to the client’s limit', async () => {
      const saved = process.env['SL_CLIENT_MAX_SERVES'];
      delete process.env['SL_CLIENT_MAX_SERVES'];
      try {
        const { io: localIo } = await fill(new SlowIo());
        server = new PeerReadServer(localIo, new BsMem());
        const { io } = await connect(server);

        await Promise.all(
          Array.from({ length: 10 }, () =>
            io.readRows({ table: TABLE, where: {} }),
          ),
        );

        expect(localIo.peak).toBe(4);
      } finally {
        if (saved !== undefined) process.env['SL_CLIENT_MAX_SERVES'] = saved;
      }
    });
  });

  // ...........................................................................
  describe('throttling', () => {
    /**
     * A peer whose transport still owes the wire more than the mark allows.
     * @param options - Server options under test.
     * @returns The server's logger and the peer.
     */
    const behind = async (options: PeerReadServerOptions) => {
      const logger = new BufferedLogger();
      server = await serve({ ...options, logger });
      const peer = await connect(server);
      (
        peer.serverSide as DirectionalSocketMock & { bufferedAmount: number }
      ).bufferedAmount = 1;
      return { logger, ...peer };
    };

    it('is logged per channel and reported to the caller’s onThrottle', async () => {
      const onThrottle = vi.fn();
      const { logger, io, bs } = await behind({
        backpressure: {
          highWaterMark: 0,
          maxWaitMs: 10,
          pollMs: 2,
          onThrottle,
        },
      });

      await io.readRows({ table: TABLE, where: { a: 'first' } });
      await bs.blobExists(local.blobId);

      expect(logger.byLevel('warn')).toEqual([
        expect.objectContaining({
          source: 'PeerReadServer.Io',
          message: 'Peer throttled',
          data: {
            waitedMs: expect.any(Number),
            queuedBytes: 1,
            serving: 0,
            queuedRequests: 0,
          },
        }),
        expect.objectContaining({
          source: 'PeerReadServer.Bs',
          message: 'Peer throttled',
          data: expect.objectContaining({ queuedBytes: 1 }),
        }),
      ]);
      expect(onThrottle).toHaveBeenCalledTimes(2);
      expect(onThrottle).toHaveBeenCalledWith(expect.any(Number), 1);
    });

    it('is logged when the caller gave no onThrottle', async () => {
      const { logger, io } = await behind({
        backpressure: { highWaterMark: 0, maxWaitMs: 10, pollMs: 2 },
      });

      await io.rowCount(TABLE);

      expect(logger.byLevel('warn').map((e) => e.source)).toEqual([
        'PeerReadServer.Io',
      ]);
    });
  });
});
