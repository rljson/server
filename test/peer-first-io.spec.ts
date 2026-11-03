// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createSocketPair, Io, IoMem, IoServer } from '@rljson/io';
import { exampleTableCfg, Rljson } from '@rljson/rljson';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PeerFirstIo, PeerReads } from '../src/index.ts';

// .............................................................................

/** The table every test reads. */
const TABLE = 'notes';

/** A row of {@link TABLE}. */
type Note = { a: string; b: number; _hash?: string };

/**
 * A store holding {@link TABLE} with the given rows.
 * @param notes - The rows.
 * @returns The open store.
 */
const storeWith = async (...notes: Note[]): Promise<IoMem> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  if (notes.length > 0) {
    await io.write({
      data: {
        [TABLE]: { _data: notes, _hash: '', _type: 'components' },
      } as unknown as Rljson,
    });
  }
  return io;
};

/**
 * The rows of {@link TABLE} in an answer.
 * @param answer - The answer.
 * @returns Its rows.
 */
const rowsOf = (answer: Rljson): Note[] =>
  (answer[TABLE] as unknown as { _data: Note[] })._data;

/**
 * A row as a store holds it, hash included.
 * @param io - The store.
 * @param a - The row's column `a`.
 * @returns The row.
 */
const rowOf = async (io: Io, a: string): Promise<Note> =>
  rowsOf(await io.readRows({ table: TABLE, where: { a } }))[0]!;

/**
 * An Io as an older hub offers it: without batch reads.
 * @param io - The Io to hide them on.
 * @returns The same Io, minus `readRowsByHashes`.
 */
const withoutBatchReads = (io: Io): Io =>
  new Proxy(io, {
    get: (target, key) =>
      key === 'readRowsByHashes' ? undefined : Reflect.get(target, key),
  });

// .............................................................................

describe('PeerFirstIo', () => {
  let peers: PeerReads | undefined;

  afterEach(async () => {
    await peers?.close();
    peers = undefined;
    vi.restoreAllMocks();
  });

  /**
   * Peer reads whose one source serves `peerIo` over a socket pair.
   * @param peerIo - What the peer holds.
   * @returns The peer reads, with the peer noted as a source.
   */
  const peerHolding = async (peerIo: Io): Promise<PeerReads> => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    await new IoServer(peerIo).addSocket(serverSide);
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
  describe('constructor(hub, peers)', () => {
    it('offers readRowsByHashes when the hub’s Io has it', async () => {
      const io = new PeerFirstIo(await storeWith(), noPeers());
      expect(io.readRowsByHashes).toBeTypeOf('function');
    });

    it('offers no readRowsByHashes when the hub’s Io lacks it', async () => {
      const io = new PeerFirstIo(
        withoutBatchReads(await storeWith()),
        noPeers(),
      );
      expect(io.readRowsByHashes).toBeUndefined();
    });
  });

  // ...........................................................................
  describe('init(), isOpen, isReady() and close()', () => {
    it('open, report and close the hub’s Io', async () => {
      const hub = new IoMem();
      const io = new PeerFirstIo(hub, noPeers());

      expect(io.isOpen).toBe(false);
      await io.init();
      expect(io.isOpen).toBe(true);
      await expect(io.isReady()).resolves.toBeUndefined();
      await io.close();
      expect(hub.isOpen).toBe(false);
      expect(io.isOpen).toBe(false);
    });
  });

  // ...........................................................................
  describe('table management', () => {
    it('acts on the hub’s tables', async () => {
      const hub = new IoMem();
      await hub.init();
      await hub.isReady();
      const io = new PeerFirstIo(hub, noPeers());

      expect(await io.tableExists(TABLE)).toBe(false);
      await io.createOrExtendTable({
        tableCfg: exampleTableCfg({ key: TABLE }),
      });

      expect(await hub.tableExists(TABLE)).toBe(true);
      expect(await io.tableExists(TABLE)).toBe(true);
      expect(await io.contentType({ table: TABLE })).toBe('components');
      expect(await io.rawTableCfgs()).toEqual(await hub.rawTableCfgs());
    });
  });

  // ...........................................................................
  describe('write(), dump(), dumpTable() and rowCount()', () => {
    it('act on the hub’s rows', async () => {
      const hub = await storeWith();
      const io = new PeerFirstIo(hub, noPeers());

      await io.write({
        data: {
          [TABLE]: {
            _data: [{ a: 'x', b: 1 }],
            _hash: '',
            _type: 'components',
          },
        } as unknown as Rljson,
      });

      expect(await hub.rowCount(TABLE)).toBe(1);
      expect(await io.rowCount(TABLE)).toBe(1);
      expect(await io.dump()).toEqual(await hub.dump());
      expect(await io.dumpTable({ table: TABLE })).toEqual(
        await hub.dumpTable({ table: TABLE }),
      );
    });
  });

  // ...........................................................................
  describe('readRows(request)', () => {
    it('answers from a peer that holds the rows, before the hub', async () => {
      const peerIo = await storeWith({ a: 'on the peer', b: 1 });
      const hub = await storeWith();
      const io = new PeerFirstIo(hub, await peerHolding(peerIo));

      const answer = await io.readRows({
        table: TABLE,
        where: { a: 'on the peer' },
      });

      expect(rowsOf(answer)).toEqual([await rowOf(peerIo, 'on the peer')]);
      expect(peers!.stats).toEqual({ hits: 1, misses: 0, failures: 0 });
    });

    it('returns the hub’s rows when no peer is known', async () => {
      const hub = await storeWith({ a: 'on the hub', b: 1 });
      const io = new PeerFirstIo(hub, noPeers());

      const answer = await io.readRows({
        table: TABLE,
        where: { a: 'on the hub' },
      });

      expect(rowsOf(answer)).toEqual([await rowOf(hub, 'on the hub')]);
    });

    it('returns the hub’s empty answer unchanged when nobody holds the rows', async () => {
      const hub = await storeWith();
      const io = new PeerFirstIo(hub, await peerHolding(await storeWith()));
      const request = { table: TABLE, where: { a: 'nowhere' } };

      const answer = await io.readRows(request);

      expect(answer).toEqual(await hub.readRows(request));
      expect(rowsOf(answer)).toEqual([]);
      expect(peers!.stats).toEqual({ hits: 0, misses: 1, failures: 0 });
    });

    it('rejects with the hub’s own error when nobody knows the table', async () => {
      const hub = new IoMem();
      await hub.init();
      await hub.isReady();
      const peerIo = new IoMem();
      await peerIo.init();
      const io = new PeerFirstIo(hub, await peerHolding(peerIo));

      await expect(
        io.readRows({ table: TABLE, where: { a: 'x' } }),
      ).rejects.toThrow(`Table "${TABLE}" not found`);
    });
  });

  // ...........................................................................
  describe('readRowsByHashes(request)', () => {
    /**
     * Two rows on the hub, and the hashes to ask for them by.
     * @returns The hub, the rows and their hashes.
     */
    const hubWithTwoRows = async () => {
      const hub = await storeWith(
        { a: 'first', b: 1 },
        { a: 'second', b: 2 },
      );
      const first = await rowOf(hub, 'first');
      const second = await rowOf(hub, 'second');
      return {
        hub,
        first,
        second,
        hashes: [first._hash!, second._hash!],
      };
    };

    it('asks the hub for every hash when the peers hold none of them', async () => {
      const { hub, first, second, hashes } = await hubWithTwoRows();
      const fromHub = vi.spyOn(hub, 'readRowsByHashes');
      const io = new PeerFirstIo(hub, await peerHolding(await storeWith()));

      const answer = await io.readRowsByHashes!({ table: TABLE, hashes });

      expect(fromHub).toHaveBeenCalledTimes(1);
      expect(fromHub).toHaveBeenCalledWith({ table: TABLE, hashes });
      expect(rowsOf(answer)).toEqual(
        expect.arrayContaining([first, second]),
      );
      expect(rowsOf(answer)).toHaveLength(2);
    });

    it('takes every row from the peers, without asking the hub, when they hold them all', async () => {
      const { hub, first, second, hashes } = await hubWithTwoRows();
      const fromHub = vi.spyOn(hub, 'readRowsByHashes');
      const peerIo = await storeWith(
        { a: 'first', b: 1 },
        { a: 'second', b: 2 },
      );
      const io = new PeerFirstIo(hub, await peerHolding(peerIo));

      const answer = await io.readRowsByHashes!({ table: TABLE, hashes });

      expect(fromHub).not.toHaveBeenCalled();
      expect(rowsOf(answer)).toEqual(
        expect.arrayContaining([first, second]),
      );
      expect(rowsOf(answer)).toHaveLength(2);
    });

    it('asks the hub only for the rows the peers lack, and merges both', async () => {
      const { hub, first, second, hashes } = await hubWithTwoRows();
      const fromHub = vi.spyOn(hub, 'readRowsByHashes');
      const peerIo = await storeWith({ a: 'first', b: 1 });
      const io = new PeerFirstIo(hub, await peerHolding(peerIo));

      const answer = await io.readRowsByHashes!({ table: TABLE, hashes });

      expect(fromHub).toHaveBeenCalledTimes(1);
      expect(fromHub).toHaveBeenCalledWith({
        table: TABLE,
        hashes: [second._hash],
      });
      expect(answer).toEqual({
        [TABLE]: { _type: 'components', _data: [first, second] },
      });
    });
  });
});
