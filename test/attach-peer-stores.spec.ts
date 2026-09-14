// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route, exampleTableCfg } from '@rljson/rljson';

import { describe, expect, it } from 'vitest';

import { Server } from '../src/server';

/**
 * Cascading a server's reads to stores it does not own.
 *
 * The case this exists for is a hub bridged to a cloud EventHub. The bridge
 * holds a `Client` whose stores cascade to the cloud; attaching them to the
 * hub's server is what lets the hub answer its own LAN clients for data only
 * the cloud has — and cache it once rather than once per client.
 *
 * Without it the bridge had to run a full sync agent to pull that data in,
 * which meant a second agent walking a folder some other process already
 * owned: the same scan and the same hash, twice.
 *
 * The property every test here is really about: **a server that never attaches
 * anything is unchanged.** That is what makes this safe to add to a sync layer
 * that is running in production.
 */

/** A tiny table, enough to tell a hit from a miss. */
const TABLE = 'notes';

/**
 * A store holding one row, standing in for the far side of a bridge.
 * @returns The store and the row's hash.
 */
const remoteWithRow = async (): Promise<{ io: IoMem; hash: string }> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  await io.write({
    data: {
      [TABLE]: {
        _data: [{ a: 'from the far side', b: 1 }],
        _hash: '',
        _type: 'components',
      },
    },
  });
  const dumped = await io.dump();
  const rows = (dumped as Record<string, { _data: { _hash: string }[] }>)[TABLE]
    ._data;
  return { io, hash: rows[0]!._hash };
};

/**
 * A server that KNOWS the table but holds none of its rows.
 *
 * The realistic shape of a hub: its clients created the route's table, and the
 * row in question only exists on the far side. A store that has never heard of
 * the table throws instead of missing, which is a different situation.
 * @returns The server.
 */
const emptyServer = async (): Promise<Server> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: TABLE }) });
  const server = new Server(Route.fromFlat('notesTree'), io, new BsMem());
  await server.init();
  return server;
};

describe('attachPeerStores', () => {
  it('answers a local miss from the attached store', async () => {
    // The whole point: the hub serves its LAN clients data only the cloud has.
    const { io: remote, hash } = await remoteWithRow();
    const server = await emptyServer();

    await expect(
      server.io.readRows({ table: TABLE, where: { _hash: hash } }),
    ).resolves.toMatchObject({ [TABLE]: { _data: [] } });

    await server.attachPeerStores({ io: remote });

    const found = await server.io.readRows({
      table: TABLE,
      where: { _hash: hash },
    });
    expect(found[TABLE]?._data?.[0]).toMatchObject({ a: 'from the far side' });

    await server.tearDown();
  });

  it('caches what it pulled, so the far side is asked once', async () => {
    // `IoMulti` writes a peer's answer back into the local cache. That is why
    // attaching a store is enough — the hub does not have to copy anything in
    // advance, and it does not re-fetch per client.
    const { io: remote, hash } = await remoteWithRow();
    const server = await emptyServer();
    const detach = await server.attachPeerStores({ io: remote });

    await server.io.readRows({ table: TABLE, where: { _hash: hash } });
    await detach();

    // Detached, and the row is still served: it was cached on the way through.
    const afterDetach = await server.io.readRows({
      table: TABLE,
      where: { _hash: hash },
    });
    expect(afterDetach[TABLE]?._data?.[0]).toMatchObject({
      a: 'from the far side',
    });

    await server.tearDown();
  });

  it('stops cascading once detached', async () => {
    const { io: remote, hash } = await remoteWithRow();
    const server = await emptyServer();
    const detach = await server.attachPeerStores({ io: remote });
    await detach();

    // Never read while attached, so nothing was cached — and the peer is gone.
    await expect(
      server.io.readRows({ table: TABLE, where: { _hash: hash } }),
    ).resolves.toMatchObject({ [TABLE]: { _data: [] } });

    await server.tearDown();
  });

  it('detaches idempotently', async () => {
    const { io: remote } = await remoteWithRow();
    const server = await emptyServer();
    const detach = await server.attachPeerStores({ io: remote });

    await detach();
    await expect(detach()).resolves.toBeUndefined();

    await server.tearDown();
  });

  it('survives a rebuild — it is not an orphaned peer', async () => {
    // `_pruneDeadPeers` drops every entry that is neither the local cache nor
    // owned by a live client. That is right for a peer left behind by a closed
    // socket and wrong for one an owner attached deliberately and still holds.
    const { io: remote, hash } = await remoteWithRow();
    const server = await emptyServer();
    await server.attachPeerStores({ io: remote });

    // Force the rebuild that prunes.
    await (server as unknown as { _rebuildMultis(): Promise<void> })._rebuildMultis();

    const found = await server.io.readRows({
      table: TABLE,
      where: { _hash: hash },
    });
    expect(found[TABLE]?._data?.[0]).toMatchObject({ a: 'from the far side' });

    await server.tearDown();
  });

  it('accepts a blob store on its own', async () => {
    const bs = new BsMem();
    const stored = await bs.setBlob(Buffer.from('far-side blob'));
    const server = await emptyServer();

    await server.attachPeerStores({ bs });

    const blob = await server.bs.getBlob(stored.blobId);
    expect(blob.content.toString()).toBe('far-side blob');

    await server.tearDown();
  });

  it('detaches a blob store too', async () => {
    // Both halves of the bridge come and go together when the hub stops being
    // hub, so both halves have to let go.
    const bs = new BsMem();
    const stored = await bs.setBlob(Buffer.from('far-side blob'));
    const server = await emptyServer();
    const detach = await server.attachPeerStores({ bs });
    await detach();

    // Never read while attached, so nothing was cached — and the peer is gone.
    await expect(server.bs.getBlob(stored.blobId)).rejects.toThrow();

    await server.tearDown();
  });

  it('changes nothing when called with neither store', async () => {
    const server = await emptyServer();
    const before = server.ioPeerCount;

    const detach = await server.attachPeerStores({});

    expect(server.ioPeerCount).toBe(before);
    await detach();
    await server.tearDown();
  });
});
