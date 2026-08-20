// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@rljson/io-mssql', () => {
  return {
    // Minimal stand-in for the full @rljson/io `Io` interface — only the
    // members Server/IoMulti touch during init()/tearDown() are needed here,
    // the mssql connection itself is never exercised in these unit tests.
    IoMssql: vi.fn().mockImplementation(function (
      this: any,
      cfg: unknown,
      schema?: string,
    ) {
      this.__cfg = cfg;
      this.__schema = schema;
      this.isOpen = true;
      this.init = vi.fn().mockResolvedValue(undefined);
      this.close = vi.fn().mockResolvedValue(undefined);
      this.isReady = vi.fn().mockResolvedValue(undefined);
      this.dump = vi.fn().mockResolvedValue({});
      this.dumpTable = vi.fn().mockResolvedValue({});
      this.contentType = vi.fn().mockResolvedValue('components');
      this.tableExists = vi.fn().mockResolvedValue(false);
      this.createOrExtendTable = vi.fn().mockResolvedValue(undefined);
      this.rawTableCfgs = vi.fn().mockResolvedValue([]);
      this.write = vi.fn().mockResolvedValue(undefined);
      this.readRows = vi.fn().mockResolvedValue({});
      this.rowCount = vi.fn().mockResolvedValue(0);
    }),
  };
});

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { IoMem, IoMulti } from '@rljson/io';
import { IoMssql } from '@rljson/io-mssql';
import { createSliceIdsTableCfg, Route, TableCfg } from '@rljson/rljson';

import { Client } from '../src/client.ts';
import {
  createLocalIo,
  createOnRefArrived,
  main,
  mssqlConfigFromEnv,
  routesFromEnv,
  StartedServer,
} from '../src/server-bootstrap.ts';

const ENV_KEYS = [
  'IO_BACKEND',
  'MSSQL_HOST',
  'MSSQL_PORT',
  'MSSQL_DATABASE',
  'MSSQL_SCHEMA',
  'MSSQL_USER',
  'MSSQL_PASSWORD',
  'MSSQL_ENCRYPT',
  'MSSQL_TRUST_SERVER_CERTIFICATE',
  'RLJSON_ROUTE',
  'RLJSON_ROUTES',
  'PORT',
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('mssqlConfigFromEnv', () => {
  it('falls back to defaults when no env vars are set', () => {
    const cfg = mssqlConfigFromEnv();
    expect(cfg).toEqual({
      server: 'localhost',
      port: undefined,
      database: 'rljson',
      user: undefined,
      password: undefined,
      options: { encrypt: true, trustServerCertificate: false },
    });
  });

  it('reads all values from env vars when set', () => {
    process.env.MSSQL_HOST = 'db.example.com';
    process.env.MSSQL_PORT = '1433';
    process.env.MSSQL_DATABASE = 'rljson_prod';
    process.env.MSSQL_USER = 'sa';
    process.env.MSSQL_PASSWORD = 'secret';
    process.env.MSSQL_ENCRYPT = 'false';
    process.env.MSSQL_TRUST_SERVER_CERTIFICATE = 'true';

    const cfg = mssqlConfigFromEnv();
    expect(cfg).toEqual({
      server: 'db.example.com',
      port: 1433,
      database: 'rljson_prod',
      user: 'sa',
      password: 'secret',
      options: { encrypt: false, trustServerCertificate: true },
    });
  });
});

describe('createLocalIo', () => {
  it('returns an in-memory Io when IO_BACKEND=mem', async () => {
    process.env.IO_BACKEND = 'mem';
    const io = await createLocalIo();
    expect(io.isOpen).toBe(true);
  });

  it('returns an IoMssql instance built from the env config otherwise', async () => {
    process.env.MSSQL_SCHEMA = 'CustomSchema';
    const io = await createLocalIo();
    expect(IoMssql).toHaveBeenCalledWith(
      mssqlConfigFromEnv(),
      'CustomSchema',
    );
    expect((io as any).init).toHaveBeenCalled();
  });
});

describe('routesFromEnv', () => {
  it('defaults to a single "customerCake" route when nothing is set', () => {
    expect(routesFromEnv().map((r) => r.flat)).toEqual(['/customerCake']);
  });

  it('reads a single route from RLJSON_ROUTE', () => {
    process.env.RLJSON_ROUTE = 'productCake';
    expect(routesFromEnv().map((r) => r.flat)).toEqual(['/productCake']);
  });

  it('reads multiple comma-separated routes from RLJSON_ROUTES, taking precedence over RLJSON_ROUTE', () => {
    process.env.RLJSON_ROUTE = 'ignoredRoute';
    process.env.RLJSON_ROUTES = 'customerCake, productCake';
    expect(routesFromEnv().map((r) => r.flat)).toEqual([
      '/customerCake',
      '/productCake',
    ]);
  });
});

describe('main', () => {
  let started: StartedServer | undefined;

  beforeEach(() => {
    process.env.IO_BACKEND = 'mem';
    process.env.PORT = '0';
    process.env.RLJSON_ROUTE = 'startSpecRoute';
  });

  afterEach(async () => {
    if (started) {
      await Promise.all(started.servers.map((server) => server.tearDown()));
      started.socketIo.close();
      await new Promise<void>((resolve) => started!.httpServer.close(() => resolve()));
      started = undefined;
    }
  });

  it('boots an http + socket.io server wired to the rljson Server', async () => {
    started = await main();
    const port = (started.httpServer.address() as AddressInfo).port;
    expect(port).toBeGreaterThan(0);
    expect(started.servers.map((s) => s.route.flat)).toEqual([
      '/startSpecRoute',
    ]);
  });

  it('falls back to default route, port 3000 and mssql backend when unset', async () => {
    delete process.env.IO_BACKEND;
    delete process.env.PORT;
    delete process.env.RLJSON_ROUTE;

    started = await main();
    const port = (started.httpServer.address() as AddressInfo).port;
    expect(port).toBe(3000);
    expect(started.servers.map((s) => s.route.flat)).toEqual([
      '/customerCake',
    ]);
  });

  it('hosts every RLJSON_ROUTES entry on its own Socket.IO namespace', async () => {
    process.env.RLJSON_ROUTES = 'startSpecRoute,secondRoute';

    started = await main();
    expect(started.servers.map((s) => s.route.flat)).toEqual([
      '/startSpecRoute',
      '/secondRoute',
    ]);

    const port = (started.httpServer.address() as AddressInfo).port;
    const { io: SocketIoClient } = await import('socket.io-client');
    const client = SocketIoClient(`http://localhost:${port}/secondRoute`);
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));

    expect(started.servers[1].clients.size).toBe(1);
    client.disconnect();
  });

  it('logs an error when registering a connecting socket fails', async () => {
    started = await main();

    const addSocketError = new Error('boom');
    const addSocketSpy = vi
      .spyOn(started.servers[0], 'addSocket')
      .mockRejectedValueOnce(addSocketError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const port = (started.httpServer.address() as AddressInfo).port;
    const { io: SocketIoClient } = await import('socket.io-client');
    const client = SocketIoClient(`http://localhost:${port}/startSpecRoute`);

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to register client socket',
        addSocketError,
      );
    });

    client.disconnect();
    addSocketSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
});

describe('createOnRefArrived', () => {
  const parentCfg = {
    key: 'testParent',
    type: 'components',
    isHead: true,
    isRoot: true,
    columns: [
      { key: '_hash', type: 'string' },
      { key: 'sliceIdsTable', type: 'string' },
      { key: 'sliceIdsRow', type: 'string' },
      { key: 'childRef', type: 'string', ref: { tableKey: 'testChild' } },
      { key: 'childRef2', type: 'string', ref: { tableKey: 'testChild' } },
      // Points at the SAME row as childRef — exercises the visited-set
      // dedup path (the row must not be fetched twice).
      { key: 'childRef3', type: 'string', ref: { tableKey: 'testChild' } },
    ],
  } as unknown as TableCfg;
  const childCfg = {
    key: 'testChild',
    type: 'components',
    isHead: true,
    isRoot: true,
    columns: [
      { key: '_hash', type: 'string' },
      { key: 'value', type: 'string' },
    ],
  } as unknown as TableCfg;
  const sliceIdCfg = createSliceIdsTableCfg('testSliceId');

  /**
   * Builds server.io the way `main()` does: a local (priority 1,
   * read/write/dump) Io merged with the sending peer's Io (priority 2,
   * read-only) — the exact shape `IoMulti.readRows()` needs to hot-swap a
   * peer's row back into the local Io.
   */
  const buildServerIo = async () => {
    const localIo = new IoMem();
    await localIo.init();
    const peerIo = new IoMem();
    await peerIo.init();

    for (const io of [localIo, peerIo]) {
      const db = new Db(io);
      await db.core.createTable(sliceIdCfg);
      await db.core.createTable(childCfg);
      await db.core.createTable(parentCfg);
    }

    const serverIo = new IoMulti([
      { io: localIo, priority: 1, read: true, write: true, dump: true },
      { io: peerIo, priority: 2, read: true, write: false, dump: false },
    ]);
    await serverIo.init();

    return { localIo, peerIo, serverIo };
  };

  it('does nothing when the root ref does not resolve to any row', async () => {
    const { localIo, serverIo } = await buildServerIo();
    const getServer = () => ({ io: serverIo }) as any;

    await createOnRefArrived(getServer)({
      route: 'testParent',
      ref: 'no-such-ref',
      sourceNodeId: 'client-a',
    });

    expect(await localIo.rowCount('testParent')).toBe(0);
  });

  it('walks official child references (ref columns + sliceIds) and persists them into the local Io via hot-swap', async () => {
    // Real Db/IoMem throughout — the walker's correctness depends on real
    // Controller behaviour (getController/getChildRefs) and IoMulti's real
    // hot-swap write-back, which would be impractical to fake at the mock
    // level.
    const { localIo, peerIo, serverIo } = await buildServerIo();
    const peerDb = new Db(peerIo);

    await peerDb.core.import({
      testSliceId: { _type: 'sliceIds', _data: [{ add: ['a'] }] },
    } as any);
    const sliceIdRow = (await peerDb.core.dumpTable('testSliceId'))
      .testSliceId._data[0] as any;

    // Two rows in the same child table — reached via two different ref
    // columns on the parent — exercises the walk collecting more than one
    // row per table, not just a single leaf.
    await peerDb.core.import({
      testChild: {
        _type: 'components',
        _data: [{ value: 'leaf-1' }, { value: 'leaf-2' }],
      },
    } as any);
    const [childRow, childRow2] = (await peerDb.core.dumpTable('testChild'))
      .testChild._data as any[];

    await peerDb.core.import({
      testParent: {
        _type: 'components',
        _data: [
          {
            sliceIdsTable: 'testSliceId',
            sliceIdsRow: sliceIdRow._hash,
            childRef: childRow._hash,
            childRef2: childRow2._hash,
            childRef3: childRow._hash,
          },
        ],
      },
    } as any);
    const parentRow = (await peerDb.core.dumpTable('testParent'))
      .testParent._data[0] as any;

    const getServer = () => ({ io: serverIo }) as any;

    await createOnRefArrived(getServer)({
      route: 'testParent',
      ref: parentRow._hash,
      sourceNodeId: 'client-a',
    });

    // Assert against the LOCAL Io directly (not the merged IoMulti) to
    // prove the data was actually persisted there, not just readable
    // on-demand through the peer.
    const localParent = await localIo.dumpTable({ table: 'testParent' });
    expect(localParent.testParent._data[0]._hash).toBe(parentRow._hash);

    const localSliceId = await localIo.dumpTable({ table: 'testSliceId' });
    expect(localSliceId.testSliceId._data[0]._hash).toBe(sliceIdRow._hash);

    const localChild = await localIo.dumpTable({ table: 'testChild' });
    const localChildHashes = localChild.testChild._data.map(
      (row: any) => row._hash,
    );
    expect(localChildHashes).toEqual(
      expect.arrayContaining([childRow._hash, childRow2._hash]),
    );
    expect(localChild.testChild._data.length).toBe(2);
  });

  it('auto-provisions a table the server has never seen before persisting into it', async () => {
    // The server's local Io starts with NO tables at all — simulating a
    // brand-new entity type it has never received data for before (e.g. a
    // chart/example file the Generator just picked up for the first time).
    // Only the sending peer has the schema and the data; there is no
    // equivalent of a prior setup-server-tables run against localIo here.
    const localIo = new IoMem();
    await localIo.init();
    const peerIo = new IoMem();
    await peerIo.init();

    const peerDb = new Db(peerIo);
    await peerDb.core.createTable(childCfg);
    await peerDb.core.import({
      testChild: { _type: 'components', _data: [{ value: 'brand-new' }] },
    } as any);
    const childRow = (await peerDb.core.dumpTable('testChild'))
      .testChild._data[0] as any;

    const serverIo = new IoMulti([
      { io: localIo, priority: 1, read: true, write: true, dump: true },
      { io: peerIo, priority: 2, read: true, write: false, dump: false },
    ]);
    await serverIo.init();
    const getServer = () => ({ io: serverIo }) as any;

    await createOnRefArrived(getServer)({
      route: 'testChild',
      ref: childRow._hash,
      sourceNodeId: 'client-a',
    });

    // The table now exists locally (schema was provisioned automatically,
    // via IoMulti.rawTableCfgs() picking it up from the peer) and holds
    // the persisted row.
    const localChild = await localIo.dumpTable({ table: 'testChild' });
    expect(localChild.testChild._data[0]._hash).toBe(childRow._hash);
  });
});

describe('main sync integration', () => {
  let started: StartedServer | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    process.env.IO_BACKEND = 'mem';
    process.env.PORT = '0';
    process.env.RLJSON_ROUTE = 'syncIntegrationRoute';
  });

  afterEach(async () => {
    if (client) {
      await client.tearDown();
      client = undefined;
    }
    if (started) {
      await Promise.all(started.servers.map((server) => server.tearDown()));
      started.socketIo.close();
      await new Promise<void>((resolve) =>
        started!.httpServer.close(() => resolve()),
      );
      started = undefined;
    }
  });

  it('persists a connected client\'s write into the server\'s own local Io via onRefArrived', async () => {
    started = await main();
    const port = (started.httpServer.address() as AddressInfo).port;
    const route = Route.fromFlat('syncIntegrationRoute');

    const { io: SocketIoClient } = await import('socket.io-client');
    const { SocketIoBridge } = await import('../src/socket-io-bridge.ts');
    const socket = SocketIoClient(`http://localhost:${port}${route.flat}`);

    const clientIo = new IoMem();
    await clientIo.init();
    client = new Client(new SocketIoBridge(socket), clientIo, new BsMem(), route, {
      syncConfig: { requireAck: true },
    });
    await client.init();
    await client.ready();

    const tableCfg = {
      key: 'syncIntegrationRoute',
      type: 'components',
      isHead: true,
      isRoot: true,
      columns: [
        { key: '_hash', type: 'string' },
        { key: 'name', type: 'string' },
      ],
    } as unknown as TableCfg;
    await client.db!.core.createTable(tableCfg);
    await client.db!.core.import({
      syncIntegrationRoute: {
        _type: 'components',
        _data: [{ name: 'hello' }],
      },
    } as any);
    const insertedRow = (
      await client.db!.core.dumpTable('syncIntegrationRoute')
    ).syncIntegrationRoute._data[0] as any;

    // In production this table is provisioned once, ahead of time, by the
    // Generator repo's setup-server-tables.ts script — onRefArrived never
    // creates tables itself. Mirror that precondition here.
    await started.servers[0].io.createOrExtendTable({ tableCfg });

    const ack = await client.connector!.sendWithAck(insertedRow._hash);
    expect(ack.ok).toBe(true);

    const serverDump = await started.servers[0].io.dump();
    expect(
      (serverDump.syncIntegrationRoute as any)?._data?.[0]?.name,
    ).toBe('hello');
  });
});
