// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db, DbEvents, MockHook } from '@rljson/db';
import { hip } from '@rljson/hash';
import { IoMem, IoPeer } from '@rljson/io';
import { Json } from '@rljson/json';
import { Rljson, Route, TableCfg } from '@rljson/rljson';

import { afterEach, describe, expect, it } from 'vitest';

import { Server } from '../src/server';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';
import { SocketIoBridge } from '../src/socket-io-bridge';

import {
  createNamespaceHarness,
  NamespaceHarness,
} from './helpers/socket-io-namespaces';

// .............................................................................
const column = (key: string) => ({
  key,
  type: 'string' as const,
  titleLong: key,
  titleShort: key,
});

const carsCfg = (): TableCfg =>
  hip<any>({
    version: 0,
    key: 'cars',
    type: 'components',
    isHead: false,
    isRoot: false,
    isShared: true,
    columns: [column('_hash'), column('brand'), column('owner')],
  }) as TableCfg;

const carsData = (...owners: string[]): Rljson =>
  hip<any>({
    cars: {
      _type: 'components',
      _data: owners.map((owner, i) => ({ brand: `brand${i}`, owner })),
    },
  }) as Rljson;

const ownersOf = (data: Rljson): string[] =>
  (data.cars._data as Json[]).map((row) => row.owner as string).sort();

const onlyAlice = (row: Json, table: string) =>
  table !== 'cars' || row.owner === 'alice';

// .............................................................................
describe('Server, clients served through the event model of server.db', () => {
  let harness: NamespaceHarness | undefined;
  let server: Server | undefined;
  let hubIo: IoMem;

  afterEach(async () => {
    await server?.tearDown();
    await harness?.close();
    server = undefined;
    harness = undefined;
  });

  /** A hub holding a car of alice and one of bob, and one connected client */
  const setUp = async (events?: DbEvents) => {
    hubIo = new IoMem();
    await hubIo.init();
    await hubIo.isReady();
    await hubIo.createOrExtendTable({ tableCfg: carsCfg() });
    await hubIo.write({ data: carsData('alice', 'bob') });

    server = new Server(Route.fromFlat('dbEvents'), hubIo, new BsMem(), {
      healthCheckIntervalMs: 0,
      refEvictionIntervalMs: 0,
      events,
    });
    await server.init();

    harness = await createNamespaceHarness(1);
    const serverSide = harness.serverSockets[0] as any;
    await server.addSocket({
      ioUp: new SocketIoBridge(serverSide.ioUp),
      ioDown: new SocketIoBridge(serverSide.ioDown),
      bsUp: new SocketIoBridge(serverSide.bsUp),
      bsDown: new SocketIoBridge(serverSide.bsDown),
    } as SocketNamespaceBundle);

    // The client reads and writes the hub's stores over its down channel
    const clientSide = harness.clientSockets[0] as any;
    const peer = new IoPeer(new SocketIoBridge(clientSide.ioDown));
    await peer.init();
    return peer;
  };

  it('offers a Db with a new event model by default', async () => {
    const client = await setUp();
    expect(server!.db).toBeInstanceOf(Db);
    expect(server!.db.events).toBeInstanceOf(DbEvents);

    const rows = await client.readRows({ table: 'cars', where: {} });
    expect(ownersOf(rows)).toEqual(['alice', 'bob']);
  });

  it('lets a hook filter what a client reads', async () => {
    const events = DbEvents.example();
    const hook = MockHook.example(events, { filterReads: onlyAlice });
    const client = await setUp(events);
    expect(server!.db.events).toBe(events);

    const rows = await client.readRows({ table: 'cars', where: {} });
    expect(ownersOf(rows)).toEqual(['alice']);

    // The hook learns which client asks
    const [clientId] = [...server!.clients.keys()];
    expect(hook.reads.at(-1)!.context).toEqual({ peer: clientId });

    // The hub's own reads do not pass the hooks
    expect(
      ownersOf(await server!.io.readRows({ table: 'cars', where: {} })),
    ).toEqual(['alice', 'bob']);
  });

  it('lets a hook refuse what a client writes', async () => {
    const events = DbEvents.example();
    MockHook.example(events, { refuseWrites: 'read only' });
    const client = await setUp(events);

    await expect(client.write({ data: carsData('mallory') })).rejects.toThrow(
      'Hook "mockHook" refused write on cars: read only',
    );
    expect(await hubIo.rowCount('cars')).toBe(2);
  });

  it('applies hooks registered after the client connected', async () => {
    const client = await setUp();
    MockHook.example(server!.db.events, { refuseReads: 'closed' });

    await expect(client.readRows({ table: 'cars', where: {} })).rejects.toThrow(
      'closed',
    );
  });

  it('stops serving a client once it is removed', async () => {
    await setUp();
    const [clientId] = [...server!.clients.keys()];
    await server!.removeSocket(clientId);
    expect(server!.clients.size).toBe(0);
  });
});
