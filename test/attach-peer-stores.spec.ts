// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock, createSocketPair } from '@rljson/io';
import { Route, exampleTableCfg } from '@rljson/rljson';

import { describe, expect, it } from 'vitest';

import { Client } from '../src/client';
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

  it('ownIo sees a client that joined AFTER it was handed out', async () => {
    // What a cloud bridge publishes. It takes this once, at start-up, and a
    // Server replaces its multis on every join and leave — so a captured
    // `io` serves the hub as it was before its own clients connected, and
    // answers "no such row" for everything those clients hold.
    //
    // Measured: a file that had crossed the EventHub could not be fetched
    // from the hub that announced it, until an unrelated read happened to
    // pull the row into the hub's local store and cache it there.
    const server = await emptyServer();
    const view = server.ownIo; // captured BEFORE anyone joins
    // Plain properties come through too, not only methods.
    expect(typeof view.isOpen).toBe('boolean');

    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    await server.addSocket(serverSide);

    const clientIo = new IoMem();
    await clientIo.init();
    await clientIo.isReady();
    await clientIo.createOrExtendTable({
      tableCfg: exampleTableCfg({ key: TABLE }),
    });
    await clientIo.write({
      data: { [TABLE]: { _data: [{ a: 'held by the client', b: 2 }] } },
    } as never);
    const client = new Client(clientSide, clientIo, new BsMem());
    await client.init();
    const dumped = await clientIo.dumpTable({ table: TABLE });
    const hash = (dumped[TABLE]._data[0] as { _hash: string })._hash;

    const found = await view.readRows({ table: TABLE, where: { _hash: hash } });
    expect(
      found[TABLE]?._data?.[0],
      'the view was a snapshot taken before the client joined',
    ).toMatchObject({ a: 'held by the client' });

    await client.tearDown();
    await server.tearDown();
  });

  it('ownBs is the same view for blobs', async () => {
    // A file route carries its bytes in the blob store, so the bridge needs
    // both halves live and both cascade-free.
    const server = await emptyServer();
    const view = server.ownBs;
    expect(view).toBe(server.ownBs);

    const remoteBs = new BsMem();
    await server.attachPeerStores({ bs: remoteBs });

    // Still this hub's own blobs, and still usable after the rebuild.
    expect(typeof view.setBlob).toBe('function');
    await server.tearDown();
  });

  it('ownIo does NOT include what the hub cascades to', async () => {
    // The other half, and the reason this is not simply `io`. Once the bridge
    // has attached the cloud, serving the cloud FROM the full cascade is a
    // loop: the cloud asks the hub, the hub asks the cloud.
    const { io: remote, hash } = await remoteWithRow();
    const server = await emptyServer();

    await server.attachPeerStores({ io: remote });

    // Asked FIRST, because a cascade read caches what it pulled into the hub's
    // own store — correctly — and would make this pass for the wrong reason.
    const viaOwn = await server.ownIo.readRows({
      table: TABLE,
      where: { _hash: hash },
    });
    expect(
      viaOwn[TABLE]?._data,
      'the hub published the store it cascades to, which is a loop',
    ).toEqual([]);

    // The whole cascade still answers.
    const viaAll = await server.io.readRows({
      table: TABLE,
      where: { _hash: hash },
    });
    expect(viaAll[TABLE]?._data?.[0]).toMatchObject({ a: 'from the far side' });

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

  it("REFUSES the server's own cascade, which would contain itself", async () => {
    // The defect this guard exists for, found on a lab within an hour of the
    // deploy. `Server.io` returns the multi, not the local store, so a bridge
    // that passed it along and attached the result built a store containing
    // itself — and the read recursed: multi → member → multi → …
    //
    // Refused here rather than at read time, because at read time it surfaces
    // as "Maximum call stack size exceeded" on the first LAN read the hub
    // cannot answer locally, which names nothing about the cause.
    const server = await emptyServer();

    await expect(server.attachPeerStores({ io: server.io })).rejects.toThrow(
      /own Io cascade/,
    );
    await expect(server.attachPeerStores({ bs: server.bs })).rejects.toThrow(
      /own Bs cascade/,
    );

    // And it did not half-attach on the way out.
    expect(server.ioPeerCount).toBe(0);

    await server.tearDown();
  });

  it('is what a Client offers for attaching: peers, not its multi', async () => {
    // `Client.io` is a multi whose FIRST layer is the store it was given. On a
    // hub that store is the server's own cascade, so attaching the multi
    // builds a store containing itself. `peerStores` is the downstream peers
    // alone, which is the acyclic thing to hand over.
    const io = new IoMem();
    await io.init();
    const socket = new SocketMock();
    socket.connect();
    const client = new Client(socket, io, new BsMem(), Route.fromFlat('notesTree'));
    await client.init();

    const peers = client.peerStores;
    expect(peers.io).toBeDefined();
    expect(peers.io).not.toBe(client.io);
    expect(peers.bs).not.toBe(client.bs);

    // And a server accepts them, where it refused the multi.
    const server = await emptyServer();
    const detach = await server.attachPeerStores(peers);
    await detach();

    await server.tearDown();
    await client.tearDown();
  });

  it('offers nothing until a Client has peers', async () => {
    // Before `init`, and on a route with no blob store. Empty rather than
    // undefined members: a bridge spreading these into an attach must not
    // hand over an `io: undefined` that reads as "attach nothing" in one place
    // and as a missing store in another.
    const io = new IoMem();
    await io.init();
    const socket = new SocketMock();
    socket.connect();

    const notStarted = new Client(socket, io, undefined, Route.fromFlat('notesTree'));
    expect(notStarted.peerStores).toEqual({});

    // After init both exist — including on a route with no LOCAL blob store.
    // The downstream peer is how this client reads the server's blobs, which
    // it can do whether or not it keeps any of its own.
    await notStarted.init();
    expect(notStarted.peerStores.io).toBeDefined();
    expect(notStarted.peerStores.bs).toBeDefined();

    await notStarted.tearDown();
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
