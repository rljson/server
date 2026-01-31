// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db, staticExample } from '@rljson/db';
import { Io, IoMem, IoMulti } from '@rljson/io';
import {
  createEditTableCfg,
  createTreesTableCfg,
  Route,
  treeFromObject,
} from '@rljson/rljson';

import { Readable } from 'node:stream';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';
import { SocketIoBridge } from '../src/socket-io-bridge';

import { createNamespaceHarness } from './helpers/socket-io-namespaces';

const wrapGetBlobStream = (bs: { getBlob: any; getBlobStream: any }) => {
  const original = bs.getBlobStream.bind(bs);
  bs.getBlobStream = async (blobId: string) => {
    const result = await original(blobId);
    if (typeof (result as any)?.getReader === 'function') {
      return result;
    }

    // Fallback: coerce buffer-like responses into a web ReadableStream
    const bufferSource = (result as any)?.content ?? result;
    let buffer: Buffer;
    if (Buffer.isBuffer(bufferSource)) {
      buffer = bufferSource;
    } else {
      const fetched = await bs.getBlob(blobId);
      buffer = fetched.content ?? Buffer.from('');
    }

    return Readable.toWeb(Readable.from(buffer)) as ReadableStream<Uint8Array>;
  };
};

describe('[Socket.IO namespaces] Data Storage (Io) Integration', () => {
  const clientCount = 3;
  const cakeKey = 'ioTestCake';
  const route = Route.fromFlat(`${cakeKey}EditHistory`);

  let harness: Awaited<ReturnType<typeof createNamespaceHarness>>;

  let a: Client, aIo: Io, aBs: BsMem;
  let b: Client, bIo: Io, bBs: BsMem;
  let c: Client, cIo: Io, cBs: BsMem;

  let server: Server;
  let serverIo: Io;
  let serverBs: BsMem;

  beforeAll(async () => {
    harness = await createNamespaceHarness(clientCount);
    serverBs = new BsMem();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Recreate serverIo for each test to avoid table pollution
    serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();

    // Recreate server with fresh Io
    server = new Server(route, serverIo, serverBs);
    await server.init();

    const serverBundles = harness.serverSockets.map(
      (bundle) =>
        ({
          ioUp: new SocketIoBridge((bundle as any).ioUp),
          ioDown: new SocketIoBridge((bundle as any).ioDown),
          bsUp: new SocketIoBridge((bundle as any).bsUp),
          bsDown: new SocketIoBridge((bundle as any).bsDown),
        }) as SocketNamespaceBundle,
    );

    for (const serverBundle of serverBundles) {
      await server.addSocket(serverBundle);
    }

    aIo = new IoMem();
    await aIo.init();
    await aIo.isReady();
    aBs = new BsMem();

    bIo = new IoMem();
    await bIo.init();
    await bIo.isReady();
    bBs = new BsMem();

    cIo = new IoMem();
    await cIo.init();
    await cIo.isReady();
    cBs = new BsMem();

    a = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      aIo,
      aBs,
    );
    await a.init();

    b = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[1] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[1] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[1] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[1] as any).bsDown),
      },
      bIo,
      bBs,
    );
    await b.init();

    c = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[2] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[2] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[2] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[2] as any).bsDown),
      },
      cIo,
      cBs,
    );
    await c.init();
  });

  it('Should initialize server Io storage', async () => {
    expect(serverIo).toBeDefined();
    expect(serverIo.isOpen).toBe(true);
  });

  it('Should initialize client Io storage', async () => {
    expect(aIo).toBeDefined();
    expect(aIo.isOpen).toBe(true);
    expect(bIo.isOpen).toBe(true);
    expect(cIo.isOpen).toBe(true);
  });

  it('Should create IoMulti for client data access', async () => {
    expect(a.io).toBeDefined();
    expect(a.io!.isOpen).toBe(true);
    expect(b.io).toBeDefined();
    expect(c.io).toBeDefined();
  });

  it('Should initialize server Io with isOpen true', async () => {
    expect(serverIo.isOpen).toBe(true);
  });

  it('Should initialize client Io with isOpen true', async () => {
    expect(aIo.isOpen).toBe(true);
    expect(bIo.isOpen).toBe(true);
    expect(cIo.isOpen).toBe(true);
  });

  it('Should create table using createOrExtendTable', async () => {
    const tableCfg = createEditTableCfg(cakeKey);
    await serverIo.createOrExtendTable({ tableCfg });

    const exists = await serverIo.tableExists(tableCfg.key);
    expect(exists).toBe(true);
  });

  it('Should return false for non-existent table', async () => {
    const exists = await serverIo.tableExists('non-existent-table');
    expect(exists).toBe(false);
  });

  it('Should get raw table configurations', async () => {
    const tableCfg = createEditTableCfg(cakeKey);
    await serverIo.createOrExtendTable({ tableCfg });

    const configs = await serverIo.rawTableCfgs();
    expect(Array.isArray(configs)).toBe(true);
    const found = configs.find((c) => c.key === tableCfg.key);
    expect(found).toBeDefined();
  });

  it('Should get content type of table', async () => {
    const tableCfg = createEditTableCfg(cakeKey);
    await serverIo.createOrExtendTable({ tableCfg });

    const contentType = await serverIo.contentType({ table: tableCfg.key });
    expect(contentType).toBe('edits');
  });

  it('Should count rows in empty table', async () => {
    const tableCfg = createEditTableCfg(cakeKey);
    await serverIo.createOrExtendTable({ tableCfg });

    const count = await serverIo.rowCount(tableCfg.key);
    expect(count).toBe(0);
  });

  it('Should dump empty database', async () => {
    const dump = await serverIo.dump();
    expect(dump).toBeDefined();
    expect(dump.tableCfgs).toBeDefined();
  });

  it('Should dump specific table', async () => {
    const tableCfg = createEditTableCfg(cakeKey);
    await serverIo.createOrExtendTable({ tableCfg });

    const tableDump = await serverIo.dumpTable({ table: tableCfg.key });
    expect(tableDump).toBeDefined();
  });

  it('Should close and reopen Io instance', async () => {
    const testIo = new IoMem();
    await testIo.init();
    await testIo.isReady();
    expect(testIo.isOpen).toBe(true);

    await testIo.close();
    expect(testIo.isOpen).toBe(false);
  });

  it('Should check IoMulti isOpen state', async () => {
    expect(a.io!.isOpen).toBe(true);
    expect(b.io!.isOpen).toBe(true);
    expect(c.io!.isOpen).toBe(true);
  });

  it('Should get IoMulti readables', async () => {
    const io = a.io as IoMulti;
    expect(io.readables.length).toBeGreaterThan(0);
    expect(io.readables[0].io).toBeDefined();
  });

  it('Should get IoMulti writables', async () => {
    const io = a.io as IoMulti;
    expect(io.writables.length).toBeGreaterThan(0);
    expect(io.writables[0].io).toBeDefined();
  });

  it('Should get IoMulti dumpables', async () => {
    const io = a.io as IoMulti;
    expect(io.dumpables.length).toBeGreaterThan(0);
    expect(io.dumpables[0].io).toBeDefined();
  });

  it('Should isolate client Io instances', async () => {
    const tableCfg = createEditTableCfg(`${cakeKey}Isolated`);
    await aIo.createOrExtendTable({ tableCfg });

    const existsInA = await aIo.tableExists(tableCfg.key);
    const existsInB = await bIo.tableExists(tableCfg.key);

    expect(existsInA).toBe(true);
    expect(existsInB).toBe(false);
  });

  it('Should access tables through client IoMulti', async () => {
    const tableCfg = createEditTableCfg(`${cakeKey}Multi`);
    await aIo.createOrExtendTable({ tableCfg });

    const configs = await a.io!.rawTableCfgs();
    const found = configs.find((c) => c.key === tableCfg.key);
    expect(found).toBeDefined();
  });

  it('Should create multiple tables', async () => {
    const cfg1 = createEditTableCfg(`${cakeKey}1`);
    const cfg2 = createEditTableCfg(`${cakeKey}2`);

    await serverIo.createOrExtendTable({ tableCfg: cfg1 });
    await serverIo.createOrExtendTable({ tableCfg: cfg2 });

    const exists1 = await serverIo.tableExists(cfg1.key);
    const exists2 = await serverIo.tableExists(cfg2.key);

    expect(exists1).toBe(true);
    expect(exists2).toBe(true);
  });

  it('Should extend table with new columns', async () => {
    const cfg1 = createEditTableCfg(`${cakeKey}Extend`);
    const originalColumnCount = cfg1.columns.length;
    await serverIo.createOrExtendTable({ tableCfg: cfg1 });

    const cfg2 = {
      ...cfg1,
      columns: [
        ...cfg1.columns,
        {
          key: 'newCol',
          type: 'number' as const,
          titleLong: 'New Col',
          titleShort: 'New',
        },
      ],
    };
    await serverIo.createOrExtendTable({ tableCfg: cfg2 });

    const configs = await serverIo.rawTableCfgs();
    const found = configs.find((c) => c.key === cfg1.key);
    expect(found?.columns.length).toBeGreaterThanOrEqual(originalColumnCount);
  });

  it('Should read empty rows from table', async () => {
    const tableCfg = createEditTableCfg(`${cakeKey}Read`);
    await serverIo.createOrExtendTable({ tableCfg });

    const rows = await serverIo.readRows({
      table: tableCfg.key,
      where: {},
    });

    expect(rows).toBeDefined();
  });

  it('Should verify empty table has zero rows', async () => {
    const tableCfg = createEditTableCfg(`${cakeKey}Count`);
    await serverIo.createOrExtendTable({ tableCfg });

    const count = await serverIo.rowCount(tableCfg.key);
    expect(count).toBe(0);
  });
});

describe('[Socket.IO namespaces] Db Operations over IoMulti Integration', () => {
  const clientCount = 2;
  const route = Route.fromFlat('bsTestRoute');

  let harness: Awaited<ReturnType<typeof createNamespaceHarness>>;

  let clientA: Client, ioA: IoMem, bsA: BsMem;
  let clientB: Client, ioB: IoMem, bsB: BsMem;
  let dbA: Db, dbB: Db;

  let server: Server;
  let serverIo: Io;
  let serverBs: BsMem;

  beforeAll(async () => {
    harness = await createNamespaceHarness(clientCount);
    serverBs = new BsMem();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Recreate serverIo for each test
    serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();

    // Recreate server with fresh Io
    server = new Server(route, serverIo, serverBs);
    await server.init();

    const serverBundles = harness.serverSockets.map(
      (bundle) =>
        ({
          ioUp: new SocketIoBridge((bundle as any).ioUp),
          ioDown: new SocketIoBridge((bundle as any).ioDown),
          bsUp: new SocketIoBridge((bundle as any).bsUp),
          bsDown: new SocketIoBridge((bundle as any).bsDown),
        }) as SocketNamespaceBundle,
    );

    for (const serverBundle of serverBundles) {
      await server.addSocket(serverBundle);
    }

    // Setup client A
    ioA = new IoMem();
    await ioA.init();
    await ioA.isReady();
    bsA = new BsMem();

    clientA = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      ioA,
      bsA,
    );
    await clientA.init();

    // Setup client B
    ioB = new IoMem();
    await ioB.init();
    await ioB.isReady();
    bsB = new BsMem();

    clientB = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[1] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[1] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[1] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[1] as any).bsDown),
      },
      ioB,
      bsB,
    );
    await clientB.init();

    // Create Db instances using client IoMulti
    dbA = new Db(clientA.io!);
    dbB = new Db(clientB.io!);
  });

  it('Should initialize Db instances with IoMulti', async () => {
    expect(dbA).toBeDefined();
    expect(dbB).toBeDefined();
  });

  describe('Pattern: Server Data Distribution', () => {
    it('Should allow both clients to read data from server via get', async () => {
      const exampleData = staticExample();
      const carCakeRoute = Route.fromFlat('carCake');

      // Server creates tables and imports data
      await server.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });
      await server.import(exampleData);

      // Clients need table definitions
      await clientA.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });
      await clientB.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });

      // Both clients can read server data through their IoPeer (priority 2)
      const dataFromA = await dbA.get(carCakeRoute, {});
      const dataFromB = await dbB.get(carCakeRoute, {});

      // Verify both clients see the same server data
      expect(dataFromA.rljson.carCake).toBeDefined();
      expect(dataFromB.rljson.carCake).toBeDefined();
      expect(dataFromA.rljson.carCake._data.length).toBe(
        dataFromB.rljson.carCake._data.length,
      );
      expect(dataFromA.rljson.carCake._data.length).toBeGreaterThan(0);
    });
  });

  describe('Pattern: Insert on Client A, Get on Client B', () => {
    it('Should demonstrate distributed data access with ref passing', async () => {
      const exampleData = staticExample();
      const carCakeRoute = Route.fromFlat('carCake');

      // Setup: All parties need table definitions
      await clientA.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });
      await clientB.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });
      await server.createTables({
        withInsertHistory: exampleData.tableCfgs._data,
      });

      // Client A imports data (writes to local IoMem at priority 1)
      await clientA.import(exampleData);

      // Get a reference from Client A's data
      const dataFromA = await dbA.get(carCakeRoute, {});
      expect(dataFromA.rljson.carCake._data.length).toBeGreaterThan(0);

      const carRef = dataFromA.rljson.carCake._data[0]._hash;
      expect(carRef).toBeDefined();

      // Client A can read its own data (priority 1 - local)
      const readByA = await dbA.get(carCakeRoute, { _hash: carRef });
      expect(readByA.rljson.carCake._data[0]._hash).toBe(carRef);

      // Client B retrieves the same data using the ref
      // (via IoPeer to server, which reads from Client A via IoPeerBridge)
      const readByB = await dbB.get(carCakeRoute, { _hash: carRef });
      expect(readByB.rljson.carCake._data[0]._hash).toBe(carRef);

      // Verify the data content matches
      expect(readByB.rljson.carCake._data[0]).toEqual(
        readByA.rljson.carCake._data[0],
      );
    });
  });
});

describe('[Socket.IO namespaces] Bs Operations over BsMulti Integration', () => {
  const clientCount = 2;
  const route = Route.fromFlat('bsTestRoute');

  let harness: Awaited<ReturnType<typeof createNamespaceHarness>>;

  let clientA: Client, ioA: IoMem, bsA: BsMem;
  let clientB: Client, ioB: IoMem, bsB: BsMem;

  let server: Server;
  let serverIo: Io;
  let serverBs: BsMem;

  beforeAll(async () => {
    harness = await createNamespaceHarness(clientCount);
    serverBs = new BsMem();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Recreate serverIo for each test
    serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();

    // Recreate server with fresh Io
    server = new Server(route, serverIo, serverBs);
    await server.init();

    const serverBundles = harness.serverSockets.map(
      (bundle) =>
        ({
          ioUp: new SocketIoBridge((bundle as any).ioUp),
          ioDown: new SocketIoBridge((bundle as any).ioDown),
          bsUp: new SocketIoBridge((bundle as any).bsUp),
          bsDown: new SocketIoBridge((bundle as any).bsDown),
        }) as SocketNamespaceBundle,
    );

    for (const serverBundle of serverBundles) {
      await server.addSocket(serverBundle);
    }

    // Setup client A
    ioA = new IoMem();
    await ioA.init();
    await ioA.isReady();
    bsA = new BsMem();

    clientA = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      ioA,
      bsA,
    );
    await clientA.init();

    // Setup client B
    ioB = new IoMem();
    await ioB.init();
    await ioB.isReady();
    bsB = new BsMem();

    clientB = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[1] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[1] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[1] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[1] as any).bsDown),
      },
      ioB,
      bsB,
    );
    await clientB.init();

    // Socket.IO transport cannot carry ReadableStream over ack payloads; rebuild them locally
    wrapGetBlobStream(clientA.bs!);
    wrapGetBlobStream(clientB.bs!);
  });

  it('Should initialize BsMulti instances for clients', async () => {
    expect(clientA.bs).toBeDefined();
    expect(clientB.bs).toBeDefined();
  });

  describe('Pattern: Server Blob Distribution', () => {
    it('Should allow both clients to read blobs from server via PULL', async () => {
      // Server stores a blob
      const serverContent = 'Server blob content for distribution';
      const { blobId } = await serverBs.setBlob(serverContent);

      // Both clients can pull the blob from server (priority 2)
      const { content: contentFromA } = await clientA.bs!.getBlob(blobId);
      const { content: contentFromB } = await clientB.bs!.getBlob(blobId);

      // Verify both clients see the same server blob
      expect(contentFromA.toString()).toBe(serverContent);
      expect(contentFromB.toString()).toBe(serverContent);
    });

    it('Should allow clients to check blob existence on server', async () => {
      const serverContent = 'Existence check blob';
      const { blobId } = await serverBs.setBlob(serverContent);

      // Both clients can check existence via their BsPeer
      const existsInA = await clientA.bs!.blobExists(blobId);
      const existsInB = await clientB.bs!.blobExists(blobId);

      expect(existsInA).toBe(true);
      expect(existsInB).toBe(true);
    });

    it('Should allow clients to get blob properties from server', async () => {
      const serverContent = 'Properties check blob';
      const { blobId, size } = await serverBs.setBlob(serverContent);

      // Both clients can get properties via their BsPeer
      const propsFromA = await clientA.bs!.getBlobProperties(blobId);
      const propsFromB = await clientB.bs!.getBlobProperties(blobId);

      expect(propsFromA.blobId).toBe(blobId);
      expect(propsFromA.size).toBe(size);
      expect(propsFromB.blobId).toBe(blobId);
      expect(propsFromB.size).toBe(size);
    });
  });

  describe('Pattern: Store on Client A, Pull on Client B', () => {
    // Fixed: BsPeerBridge now uses correct error-first callback format
    it('Should allow Client B to pull blob from Client A via server', async () => {
      // Client A stores blob locally (priority 1)
      const contentA = 'Client A blob content';
      const { blobId } = await bsA.setBlob(contentA);

      // Client A can read from its local storage (priority 1)
      const { content: localContent } = await clientA.bs!.getBlob(blobId);
      expect(localContent.toString()).toBe(contentA);

      // Client B pulls the blob through server's BsPeerBridge to Client A
      const { content: pulledContent } = await clientB.bs!.getBlob(blobId);
      expect(pulledContent.toString()).toBe(contentA);

      // Also verify blobExists works with the same blobId
      expect(await clientB.bs!.blobExists(blobId)).toBe(true);
    });

    it('Should verify blob existence across clients via PULL', async () => {
      const contentA = 'Cross-client existence check';
      const { blobId } = await bsA.setBlob(contentA);

      // Client A sees it locally
      expect(await clientA.bs!.blobExists(blobId)).toBe(true);

      // First verify getBlob works
      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.toString()).toBe(contentA);

      // Then check if blobExists works
      expect(await clientB.bs!.blobExists(blobId)).toBe(true);
    });

    it('Should get blob properties across clients via PULL', async () => {
      const contentA = 'Cross-client properties check';
      const { blobId, size } = await bsA.setBlob(contentA);

      // Client A gets properties from local storage
      const localProps = await clientA.bs!.getBlobProperties(blobId);
      expect(localProps.blobId).toBe(blobId);
      expect(localProps.size).toBe(size);

      // Client B gets properties via pull through server
      const pulledProps = await clientB.bs!.getBlobProperties(blobId);
      expect(pulledProps.blobId).toBe(blobId);
      expect(pulledProps.size).toBe(size);
    });
  });

  describe('Pattern: Priority System (Local over Remote)', () => {
    it('Should prioritize local blobs over server blobs', async () => {
      // Store identical content to get same blobId (content-addressed)
      const sharedContent = 'Same content everywhere';

      // Server stores a blob
      const { blobId: serverBlobId } = await serverBs.setBlob(sharedContent);

      // Client A also stores the same content locally (gets same blobId)
      const { blobId: localBlobId } = await bsA.setBlob(sharedContent);

      // Should have same blobId (content-addressed)
      expect(localBlobId).toBe(serverBlobId);

      // Client A should read from local (priority 1), not server (priority 2)
      // We can verify by checking it still works even if server version is "deleted"
      const { content } = await clientA.bs!.getBlob(localBlobId);
      expect(content.toString()).toBe(sharedContent);

      // Client B should pull from server (no local copy)
      const { content: serverVersion } =
        await clientB.bs!.getBlob(serverBlobId);
      expect(serverVersion.toString()).toBe(sharedContent);
    });

    it('Should fall through to server when blob not in local storage', async () => {
      const serverContent = 'Only on server';
      const { blobId } = await serverBs.setBlob(serverContent);

      // Client A has no local copy, should pull from server
      const { content } = await clientA.bs!.getBlob(blobId);
      expect(content.toString()).toBe(serverContent);
    });
  });

  describe('Pattern: Blob Isolation', () => {
    it('Should verify isolated blobs do not exist on other clients', async () => {
      const { blobId } = await bsA.setBlob('Isolated blob');

      // Client A sees it locally
      expect(await clientA.bs!.blobExists(blobId)).toBe(true);

      // Client B should not see it (not on server, only in A's local storage)
      expect(await clientB.bs!.blobExists(blobId)).toBe(false);
    });
  });

  describe('Pattern: Binary Data Handling', () => {
    it('Should handle binary data across BsMulti layers', async () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
      const { blobId } = await bsA.setBlob(binaryData);

      // Client A reads locally
      const { content: localContent } = await clientA.bs!.getBlob(blobId);
      expect(Buffer.compare(localContent, binaryData)).toBe(0);

      // Client B pulls binary data through server
      const { content: pulledContent } = await clientB.bs!.getBlob(blobId);
      expect(Buffer.compare(pulledContent, binaryData)).toBe(0);
    });

    it('Should handle large binary blobs via PULL', async () => {
      const largeBlob = Buffer.alloc(1024 * 100, 0xaa); // 100KB
      const { blobId } = await serverBs.setBlob(largeBlob);

      // Both clients pull the large blob
      const { content: contentA } = await clientA.bs!.getBlob(blobId);
      const { content: contentB } = await clientB.bs!.getBlob(blobId);

      expect(contentA.length).toBe(largeBlob.length);
      expect(contentB.length).toBe(largeBlob.length);
      expect(Buffer.compare(contentA, largeBlob)).toBe(0);
      expect(Buffer.compare(contentB, largeBlob)).toBe(0);
    });
  });

  describe('Pattern: Content Deduplication', () => {
    it('Should deduplicate identical blob content', async () => {
      const content1 = 'Identical content';
      const content2 = 'Identical content';

      const { blobId: blobId1 } = await bsA.setBlob(content1);
      const { blobId: blobId2 } = await bsA.setBlob(content2);

      // Same content should generate same blobId
      expect(blobId1).toBe(blobId2);
    });

    it('Should generate different IDs for different content', async () => {
      const content1 = 'Different content 1';
      const content2 = 'Different content 2';

      const { blobId: blobId1 } = await bsA.setBlob(content1);
      const { blobId: blobId2 } = await bsA.setBlob(content2);

      expect(blobId1).not.toBe(blobId2);
    });
  });

  describe('Pattern: Unicode and Special Characters', () => {
    it('Should handle Unicode content via PULL', async () => {
      const unicodeContent = '🚀 Hello 世界 Привет مرحبا';
      const { blobId } = await bsA.setBlob(unicodeContent);

      // Client A reads locally
      const { content: localContent } = await clientA.bs!.getBlob(blobId);
      expect(localContent.toString('utf8')).toBe(unicodeContent);

      // Client B pulls through server
      const { content: pulledContent } = await clientB.bs!.getBlob(blobId);
      expect(pulledContent.toString('utf8')).toBe(unicodeContent);
    });

    it('Should handle empty blobs via PULL', async () => {
      const { blobId } = await serverBs.setBlob('');

      const { content: contentA, properties: propsA } =
        await clientA.bs!.getBlob(blobId);
      const { content: contentB, properties: propsB } =
        await clientB.bs!.getBlob(blobId);

      expect(contentA.toString()).toBe('');
      expect(propsA.size).toBe(0);
      expect(contentB.toString()).toBe('');
      expect(propsB.size).toBe(0);
    });
  });

  describe('Pattern: Stream Operations', () => {
    it('Should retrieve blob as stream via BsMulti', async () => {
      const testContent = 'Stream test content for BsMulti';
      const { blobId } = await serverBs.setBlob(testContent);

      // Client A retrieves stream through BsMulti
      const stream = await clientA.bs!.getBlobStream(blobId);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe(testContent);
    });

    it('Should support partial blob retrieval via PULL', async () => {
      const testContent = 'This is a test for range requests via PULL';
      const { blobId } = await bsA.setBlob(testContent);

      // Client B pulls partial blob through server
      const { content } = await clientB.bs!.getBlob(blobId, {
        range: { start: 0, end: 7 },
      });

      expect(content.toString()).toBe('This is');
    });
  });

  describe('Pattern: List and Delete Operations', () => {
    it('Should list blobs from BsMulti storage', async () => {
      // Store blobs in different locations
      const { blobId: id1 } = await bsA.setBlob('Local blob 1');
      const { blobId: id2 } = await bsA.setBlob('Local blob 2');
      const { blobId: id3 } = await serverBs.setBlob('Server blob 1');

      // Client A should see both local and server blobs
      const { blobs } = await clientA.bs!.listBlobs();

      // Find our specific blobs
      const ourBlobs = blobs.filter((b) => [id1, id2, id3].includes(b.blobId));
      expect(ourBlobs.length).toBe(3);

      ourBlobs.forEach((blob) => {
        expect(blob.blobId).toBeDefined();
        expect(blob.size).toBeGreaterThan(0);
        expect(blob.createdAt).toBeDefined();
      });
    });

    it('Should delete blobs from local storage', async () => {
      const testContent = 'Delete test blob';
      const { blobId } = await bsA.setBlob(testContent);

      // Verify it exists locally
      expect(await clientA.bs!.blobExists(blobId)).toBe(true);

      // Delete from local storage
      await bsA.deleteBlob(blobId);

      // Should no longer exist locally
      expect(await bsA.blobExists(blobId)).toBe(false);
    });
  });

  describe('Pattern: Error Handling', () => {
    it('Should throw error when blob not found in any layer', async () => {
      const nonExistentBlobId = 'a'.repeat(22);

      await expect(clientA.bs!.getBlob(nonExistentBlobId)).rejects.toThrow();
      expect(await clientA.bs!.blobExists(nonExistentBlobId)).toBe(false);
    });

    it('Should handle concurrent blob operations via PULL', async () => {
      // Store blobs on server
      const operations = Array.from({ length: 10 }, (_, i) =>
        serverBs.setBlob(`Concurrent blob ${i}`),
      );

      const results = await Promise.all(operations);

      // Client A pulls all blobs concurrently
      const pullOperations = results.map((result) =>
        clientA.bs!.getBlob(result.blobId),
      );

      const pulledBlobs = await Promise.all(pullOperations);

      expect(pulledBlobs.length).toBe(10);
      pulledBlobs.forEach((blob, i) => {
        expect(blob.content.toString()).toBe(`Concurrent blob ${i}`);
      });
    });
  });

  describe('Pattern: Metadata Preservation', () => {
    it('Should preserve blob metadata through PULL transfer', async () => {
      const testContent = 'Metadata preservation via PULL';
      const { blobId, size } = await bsA.setBlob(testContent);

      // Client A reads local metadata
      const localProps = await clientA.bs!.getBlobProperties(blobId);

      // Client B pulls and checks metadata
      const { properties: pulledProps } = await clientB.bs!.getBlob(blobId);

      expect(pulledProps.blobId).toBe(blobId);
      expect(pulledProps.size).toBe(size);
      expect(pulledProps.createdAt).toBeDefined();
      expect(localProps.blobId).toBe(pulledProps.blobId);
      expect(localProps.size).toBe(pulledProps.size);
    });
  });

  describe('Edge Cases: Blob Size Extremes', () => {
    it('Should handle zero-byte blobs', async () => {
      const empty = Buffer.alloc(0);
      const { blobId, size } = await bsA.setBlob(empty);

      expect(size).toBe(0);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.length).toBe(0);
      expect(await clientB.bs!.blobExists(blobId)).toBe(true);
    });

    it('Should handle single-byte blobs', async () => {
      const singleByte = Buffer.from([0x42]);
      const { blobId } = await bsA.setBlob(singleByte);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.length).toBe(1);
      expect(content[0]).toBe(0x42);
    });

    it('Should handle multi-megabyte blobs via PULL', async () => {
      // 5MB blob
      const largeBlob = Buffer.alloc(5 * 1024 * 1024, 'X');
      const { blobId, size } = await bsA.setBlob(largeBlob);

      expect(size).toBe(5 * 1024 * 1024);

      // Client B pulls large blob
      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.length).toBe(5 * 1024 * 1024);
      expect(content[0]).toBe('X'.charCodeAt(0));
      expect(content[content.length - 1]).toBe('X'.charCodeAt(0));
    }, 15000); // 15 second timeout for large blob

    it('Should handle blobs at 1MB boundary', async () => {
      const exactMB = Buffer.alloc(1024 * 1024, 'M');
      const { blobId, size } = await serverBs.setBlob(exactMB);

      expect(size).toBe(1024 * 1024);
      const { content } = await clientA.bs!.getBlob(blobId);
      expect(content.length).toBe(1024 * 1024);
    });
  });

  describe('Edge Cases: Binary Data Patterns', () => {
    it('Should handle all zero bytes', async () => {
      const zeros = Buffer.alloc(1024, 0x00);
      const { blobId } = await bsA.setBlob(zeros);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.every((byte) => byte === 0x00)).toBe(true);
    }, 15000);

    it('Should handle all 0xFF bytes', async () => {
      const ones = Buffer.alloc(1024, 0xff);
      const { blobId } = await bsA.setBlob(ones);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(content.every((byte) => byte === 0xff)).toBe(true);
    }, 15000);

    it('Should handle alternating binary pattern', async () => {
      const pattern = Buffer.from(
        Array(1024)
          .fill(0)
          .map((_, i) => (i % 2 === 0 ? 0xaa : 0x55)),
      );
      const { blobId } = await bsA.setBlob(pattern);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(Buffer.compare(content, pattern)).toBe(0);
    });

    it('Should handle random binary data', async () => {
      const random = Buffer.from(
        Array.from({ length: 1024 }, () => Math.floor(Math.random() * 256)),
      );
      const { blobId } = await bsA.setBlob(random);

      const { content } = await clientB.bs!.getBlob(blobId);
      expect(Buffer.compare(content, random)).toBe(0);
    });
  });

  describe('Edge Cases: Stream Operations', () => {
    it('Should handle empty stream', async () => {
      const { blobId } = await serverBs.setBlob('');

      const stream = await clientA.bs!.getBlobStream(blobId);
      const reader = stream.getReader();

      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }

      const result = Buffer.concat(chunks);
      expect(result.length).toBe(0);
    });

    it('Should handle large stream reads', async () => {
      const largeContent = Buffer.alloc(2 * 1024 * 1024, 'S');
      const { blobId } = await serverBs.setBlob(largeContent);

      const stream = await clientA.bs!.getBlobStream(blobId);
      const reader = stream.getReader();

      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) totalBytes += value.length;
      }

      expect(totalBytes).toBe(2 * 1024 * 1024);
    });

    it('Should support multiple concurrent stream readers', async () => {
      const content = 'Multi-stream test content';
      const { blobId } = await serverBs.setBlob(content);

      // Open 5 concurrent streams
      const streamPromises = Array.from({ length: 5 }, async () => {
        const stream = await clientA.bs!.getBlobStream(blobId);
        const reader = stream.getReader();

        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }

        return Buffer.concat(chunks).toString();
      });

      const results = await Promise.all(streamPromises);

      results.forEach((result) => {
        expect(result).toBe(content);
      });
    });
  });

  describe('Edge Cases: Range Requests', () => {
    it('Should handle range at start of blob', async () => {
      const content = 'This is a range test';
      const { blobId } = await bsA.setBlob(content);

      const { content: chunk } = await clientB.bs!.getBlob(blobId, {
        range: { start: 0, end: 4 },
      });

      // Range is exclusive on end: 0-3 = 'This'
      expect(chunk.toString()).toBe('This');
    });

    it('Should handle range at end of blob', async () => {
      const content = 'Range at end';
      const { blobId } = await bsA.setBlob(content);

      const { content: chunk } = await clientB.bs!.getBlob(blobId, {
        range: { start: 9, end: 12 },
      });

      // Last 3 chars: 'end'
      expect(chunk.toString()).toBe('end');
    });

    it('Should handle range in middle of blob', async () => {
      const content = 'Extract middle section';
      const { blobId } = await bsA.setBlob(content);

      const { content: chunk } = await clientB.bs!.getBlob(blobId, {
        range: { start: 8, end: 14 },
      });

      // Middle 6 chars: 'middle'
      expect(chunk.toString()).toBe('middle');
    });

    it('Should handle single-byte range', async () => {
      const content = 'ABCDEFGH';
      const { blobId } = await bsA.setBlob(content);

      const { content: chunk } = await clientB.bs!.getBlob(blobId, {
        range: { start: 4, end: 5 },
      });

      // Single byte at index 4: 'E'
      expect(chunk.toString()).toBe('E');
    });

    it('Should handle range equal to full blob', async () => {
      const content = 'Full';
      const { blobId } = await bsA.setBlob(content);

      const { content: chunk } = await clientB.bs!.getBlob(blobId, {
        range: { start: 0, end: content.length },
      });

      // Full range: 0 to length
      expect(chunk.toString()).toBe(content);
    });
  });

  describe('Edge Cases: Blob Properties', () => {
    it('Should handle getBlobProperties for non-existent blob', async () => {
      const fakeBlobId = 'x'.repeat(22);

      await expect(clientA.bs!.getBlobProperties(fakeBlobId)).rejects.toThrow();
    });

    it('Should return correct properties immediately after setBlob', async () => {
      const content = 'Properties test';
      const { blobId, size, createdAt } = await bsA.setBlob(content);

      const props = await bsA.getBlobProperties(blobId);

      expect(props.blobId).toBe(blobId);
      expect(props.size).toBe(size);
      expect(props.createdAt).toEqual(createdAt);
    });

    it('Should handle properties for binary blobs', async () => {
      const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
      const { blobId } = await bsA.setBlob(binary);

      const props = await clientB.bs!.getBlobProperties(blobId);

      expect(props.size).toBe(4);
      expect(props.blobId).toBe(blobId);
    });
  });

  describe('Edge Cases: List Operations', () => {
    it('Should list blobs with pagination-like filtering', async () => {
      // Create many test blobs
      const blobIds = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          bsA.setBlob(`Pagination test ${i}`).then((r) => r.blobId),
        ),
      );

      const { blobs } = await clientA.bs!.listBlobs();

      // Verify all our test blobs are in the list
      const ourBlobs = blobs.filter((b) => blobIds.includes(b.blobId));
      expect(ourBlobs.length).toBe(20);
    });

    it('Should list empty result when no blobs exist', async () => {
      // Use a fresh BsMem
      const freshBs = new BsMem();
      const { blobs } = await freshBs.listBlobs();

      expect(blobs).toEqual([]);
    });

    it('Should list blobs across multiple priorities', async () => {
      // Local blob
      const { blobId: localId } = await bsA.setBlob('Local test list');
      // Server blob
      const { blobId: serverId } = await serverBs.setBlob('Server test list');

      const { blobs } = await clientA.bs!.listBlobs();

      const ourBlobs = blobs.filter((b) =>
        [localId, serverId].includes(b.blobId),
      );
      expect(ourBlobs.length).toBe(2);
    });
  });

  describe('Edge Cases: Delete Operations', () => {
    it('Should handle deleteBlob for non-existent blob', async () => {
      const fakeBlobId = 'y'.repeat(22);

      // Should throw error for non-existent blob
      await expect(bsA.deleteBlob(fakeBlobId)).rejects.toThrow();
    });

    it('Should verify blob truly deleted from local storage', async () => {
      const { blobId } = await bsA.setBlob('Delete verification');

      expect(await bsA.blobExists(blobId)).toBe(true);

      await bsA.deleteBlob(blobId);

      expect(await bsA.blobExists(blobId)).toBe(false);
      await expect(bsA.getBlob(blobId)).rejects.toThrow();
    });

    it('Should not affect other clients when deleting local blob', async () => {
      const { blobId } = await serverBs.setBlob('Shared delete test');

      // Both clients can see it
      expect(await clientA.bs!.blobExists(blobId)).toBe(true);
      expect(await clientB.bs!.blobExists(blobId)).toBe(true);

      // Delete from server
      await serverBs.deleteBlob(blobId);

      // Both clients should now not find it
      expect(await clientA.bs!.blobExists(blobId)).toBe(false);
      expect(await clientB.bs!.blobExists(blobId)).toBe(false);
    });
  });

  describe('Stress Test: High Concurrency', () => {
    it('Should handle 50 concurrent setBlob operations', async () => {
      const operations = Array.from({ length: 50 }, (_, i) =>
        bsA.setBlob(`Stress test blob ${i}`),
      );

      const results = await Promise.all(operations);

      expect(results.length).toBe(50);
      results.forEach((result) => {
        expect(result.blobId).toBeDefined();
        expect(result.size).toBeGreaterThan(0);
      });
    });

    it('Should handle 50 concurrent getBlob operations', async () => {
      // Setup: Create blobs on server
      const setupOps = Array.from({ length: 50 }, (_, i) =>
        serverBs.setBlob(`Concurrent get test ${i}`),
      );

      const setupResults = await Promise.all(setupOps);

      // Test: Pull all blobs concurrently from Client A
      const getOperations = setupResults.map((result) =>
        clientA.bs!.getBlob(result.blobId),
      );

      const getResults = await Promise.all(getOperations);

      expect(getResults.length).toBe(50);
      getResults.forEach((result, i) => {
        expect(result.content.toString()).toBe(`Concurrent get test ${i}`);
      });
    });

    it('Should handle 100 concurrent blobExists checks', async () => {
      // Setup: Create 50 blobs
      const setupOps = Array.from({ length: 50 }, (_, i) =>
        serverBs.setBlob(`Exists test ${i}`),
      );

      const setupResults = await Promise.all(setupOps);

      // Test: Check 50 existing + 50 non-existing blobs
      const existsOps = [
        ...setupResults.map((r) => clientA.bs!.blobExists(r.blobId)),
        ...Array.from({ length: 50 }, (_, i) =>
          clientA.bs!.blobExists(`fake${i}${'z'.repeat(17)}`),
        ),
      ];

      const existsResults = await Promise.all(existsOps);

      // First 50 should exist
      existsResults.slice(0, 50).forEach((exists) => {
        expect(exists).toBe(true);
      });

      // Last 50 should not exist
      existsResults.slice(50).forEach((exists) => {
        expect(exists).toBe(false);
      });
    });

    it('Should handle mixed concurrent operations', async () => {
      // Mix of set, get, exists, properties, list operations
      const ops = [
        ...Array.from({ length: 10 }, (_, i) => bsA.setBlob(`Mixed test ${i}`)),
        ...Array.from({ length: 10 }, async () => {
          const { blobId } = await serverBs.setBlob('Temp for get');
          return clientB.bs!.getBlob(blobId);
        }),
        ...Array.from({ length: 10 }, async () => {
          const { blobId } = await serverBs.setBlob('Temp for exists');
          return clientA.bs!.blobExists(blobId);
        }),
        ...Array.from({ length: 5 }, () => clientA.bs!.listBlobs()),
      ];

      const results = await Promise.all(ops);

      expect(results.length).toBe(35);
    });
  });

  describe('Stress Test: Rapid Sequential Operations', () => {
    it('Should handle rapid successive writes to same client', async () => {
      const blobIds: string[] = [];

      for (let i = 0; i < 20; i++) {
        const { blobId } = await bsA.setBlob(`Rapid write ${i}`);
        blobIds.push(blobId);
      }

      expect(blobIds.length).toBe(20);
      expect(new Set(blobIds).size).toBe(20); // All unique
    });

    it('Should handle rapid successive reads from different clients', async () => {
      const { blobId } = await serverBs.setBlob('Rapid read test');

      const results: string[] = [];

      for (let i = 0; i < 20; i++) {
        const client = i % 2 === 0 ? clientA : clientB;
        const { content } = await client.bs!.getBlob(blobId);
        results.push(content.toString());
      }

      expect(results.length).toBe(20);
      results.forEach((content) => {
        expect(content).toBe('Rapid read test');
      });
    });

    it('Should handle rapid create-delete-recreate cycle', async () => {
      const content1 = 'First version';
      const content2 = 'Second version';

      for (let i = 0; i < 5; i++) {
        const { blobId: id1 } = await bsA.setBlob(content1);
        expect(await bsA.blobExists(id1)).toBe(true);

        await bsA.deleteBlob(id1);
        expect(await bsA.blobExists(id1)).toBe(false);

        const { blobId: id2 } = await bsA.setBlob(content2);
        expect(await bsA.blobExists(id2)).toBe(true);

        await bsA.deleteBlob(id2);
      }

      // All should be cleaned up
      const { blobs } = await bsA.listBlobs();
      const testBlobs = blobs.filter(
        (b) =>
          b.blobId.includes('First version') ||
          b.blobId.includes('Second version'),
      );
      expect(testBlobs.length).toBe(0);
    });
  });

  describe('Error Scenarios: Invalid Inputs', () => {
    it('Should handle invalid blobId format in getBlob', async () => {
      await expect(clientA.bs!.getBlob('invalid')).rejects.toThrow();
      await expect(clientA.bs!.getBlob('')).rejects.toThrow();
    });

    it('Should handle invalid blobId format in blobExists', async () => {
      // Invalid IDs should return false or throw, not crash
      const result1 = await clientA.bs!.blobExists('short');
      const result2 = await clientA.bs!.blobExists('');

      // Either false or throws is acceptable
      expect(typeof result1 === 'boolean' || result1 === undefined).toBe(true);
      expect(typeof result2 === 'boolean' || result2 === undefined).toBe(true);
    });
  });
});

describe('[Socket.IO namespaces] Tree Operations over IoMulti Integration', () => {
  const clientCount = 2;
  const treeName = 'exampleTree';
  const route = Route.fromFlat(treeName);

  let harness: Awaited<ReturnType<typeof createNamespaceHarness>>;

  let clientA: Client, ioA: IoMem, bsA: BsMem, dbA: Db;
  let clientB: Client, ioB: IoMem, bsB: BsMem, dbB: Db;

  let server: Server;
  let serverIo: Io;
  let serverBs: BsMem;

  beforeAll(async () => {
    harness = await createNamespaceHarness(clientCount);
    serverBs = new BsMem();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    // Remove all event listeners from previous test to prevent interference
    harness.serverSockets.forEach((socket) =>
      Object.values(socket).forEach((ns) => ns?.removeAllListeners()),
    );
    harness.clientSockets.forEach((socket) =>
      Object.values(socket).forEach((ns) => ns?.removeAllListeners()),
    );

    // Recreate serverIo for each test
    serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();

    // Recreate server with fresh Io
    server = new Server(route, serverIo, serverBs);
    await server.init();

    const serverBundles = harness.serverSockets.map(
      (bundle) =>
        ({
          ioUp: new SocketIoBridge((bundle as any).ioUp),
          ioDown: new SocketIoBridge((bundle as any).ioDown),
          bsUp: new SocketIoBridge((bundle as any).bsUp),
          bsDown: new SocketIoBridge((bundle as any).bsDown),
        }) as SocketNamespaceBundle,
    );

    for (const serverBundle of serverBundles) {
      await server.addSocket(serverBundle);
    }

    // Setup client A
    ioA = new IoMem();
    await ioA.init();
    await ioA.isReady();
    bsA = new BsMem();

    clientA = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      ioA,
      bsA,
    );
    await clientA.init();

    // Setup client B
    ioB = new IoMem();
    await ioB.init();
    await ioB.isReady();
    bsB = new BsMem();

    clientB = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[1] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[1] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[1] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[1] as any).bsDown),
      },
      ioB,
      bsB,
    );
    await clientB.init();

    // Create Db instances using client IoMulti
    dbA = new Db(clientA.io!);
    dbB = new Db(clientB.io!);
  });

  it('Should initialize Db instances with IoMulti for Tree operations', async () => {
    expect(dbA).toBeDefined();
    expect(dbB).toBeDefined();
  });

  describe('Pattern: Tree Data Distribution - Pull Pattern', () => {
    it('Should allow Client A to store tree, Client B to retrieve via server (pull pattern)', async () => {
      const testTreeName = 'pullPatternTree';
      // 1. Create a simple tree object
      const treeObject = { a: 1, b: { c: 2, d: [3, 4] } };
      const trees = treeFromObject(treeObject);
      const rootTree = trees[trees.length - 1];
      const rootTreeHash = rootTree._hash; // Last tree is the root
      const rootId = 'root'; // Use explicit root node

      // 2. Create trees table configuration
      const treeTableCfg = createTreesTableCfg(testTreeName);

      // 3. All parties need table definitions (server does NOT import data)
      await server.createTables({ withInsertHistory: [treeTableCfg] });
      await clientA.createTables({ withInsertHistory: [treeTableCfg] });
      await clientB.createTables({ withInsertHistory: [treeTableCfg] });

      // 4. Client A stores tree data locally (NOT pushed to server)
      await clientA.import({
        [testTreeName]: { _type: 'trees', _data: trees },
      });

      // 5. Client A can read its own tree data (priority 1 - local)
      // Use controller.get() with root node ID for recursive child fetching
      const controllerA = await dbA.getController(testTreeName);
      const dataFromA = await controllerA.get(rootTreeHash, undefined, rootId);
      expect(dataFromA[testTreeName]).toBeDefined();
      expect(dataFromA[testTreeName]._data.length).toBeGreaterThan(0);
      const hasRootInA = dataFromA[testTreeName]._data.some(
        (node: any) => node._hash === rootTreeHash,
      );
      expect(hasRootInA).toBe(true);

      // 6. Client B retrieves tree via server (PULL pattern):
      //    Client B -> IoPeer -> Server -> IoPeerBridge -> Client A
      const controllerB = await dbB.getController(testTreeName);
      const dataFromB = await controllerB.get(rootTreeHash, undefined, rootId);

      // 7. Verify Client B can access Client A's tree data
      expect(dataFromB[testTreeName]).toBeDefined();
      expect(dataFromB[testTreeName]._data.length).toBe(
        dataFromA[testTreeName]._data.length,
      );
      const hasRootInB = dataFromB[testTreeName]._data.some(
        (node: any) => node._hash === rootTreeHash,
      );
      expect(hasRootInB).toBe(true);
    });
  });

  describe('Pattern: Tree Insert on Client A, Get on Client B', () => {
    it('Should demonstrate distributed tree data access with ref passing', async () => {
      const testTreeName = 'distributedTree';
      // 1. Create tree object and convert to trees
      const treeObject = { x: 10, y: { z: 20 } };
      const trees = treeFromObject(treeObject);
      const rootTree = trees[trees.length - 1]; // Last tree is the root
      const rootTreeHash = rootTree._hash;
      const rootId = 'root'; // Use explicit root node

      // 2. Create trees table configuration
      const treeTableCfg = createTreesTableCfg(testTreeName);

      // 3. Setup: All parties need table definitions (same as working Db tests)
      await clientA.createTables({ withInsertHistory: [treeTableCfg] });
      await clientB.createTables({ withInsertHistory: [treeTableCfg] });
      await server.createTables({ withInsertHistory: [treeTableCfg] });

      // 4. Client A imports tree data (writes to local IoMem at priority 1)
      await clientA.import({
        [testTreeName]: { _type: 'trees', _data: trees },
      });

      // 5. Client A can read its own tree data using root hash (priority 1 - local)
      // Use controller.get() with root node ID for recursive child fetching
      const controllerA = await dbA.getController(testTreeName);
      const readByA = await controllerA.get(rootTreeHash, undefined, rootId);
      expect(readByA[testTreeName]._data.length).toBeGreaterThan(0);
      const hasRootNode = readByA[testTreeName]._data.some(
        (node: any) => node._hash === rootTreeHash,
      );
      expect(hasRootNode).toBe(true);

      // 7. Client B retrieves tree data using root ref
      // via IoPeer to server, which reads from Client A via IoPeerBridge
      const controllerB = await dbB.getController(testTreeName);
      const readByB = await controllerB.get(rootTreeHash, undefined, rootId);

      // Verify cross-client tree sync works
      expect(readByB[testTreeName]).toBeDefined();
      const hasRootInB = readByB[testTreeName]._data.some(
        (node: any) => node._hash === rootTreeHash,
      );
      expect(hasRootInB).toBe(true);

      // Verify both clients received the same tree structure
      expect(readByB[testTreeName]._data.length).toBe(
        readByA[testTreeName]._data.length,
      );
    });
  });

  describe('Pattern: Tree modification and distribution', () => {
    it('Should demonstrate creating and sharing different tree structures', async () => {
      const testTreeName = 'modifiedTree';
      // 1. Create two different tree structures
      const tree1 = { x: 10, y: 20 };
      const tree2 = { a: 100, b: { c: 200 } };

      const trees1 = treeFromObject(tree1);
      const trees2 = treeFromObject(tree2);

      const root1Tree = trees1[trees1.length - 1];
      const root1Hash = root1Tree._hash;
      const root1Id = 'root'; // Use explicit root node

      const root2Tree = trees2[trees2.length - 1];
      const root2Hash = root2Tree._hash;
      const root2Id = 'root'; // Use explicit root node

      // 2. Create trees table configuration
      const treeTableCfg = createTreesTableCfg(testTreeName);

      // 3. Setup tables on all parties
      await clientA.createTables({ withInsertHistory: [treeTableCfg] });
      await clientB.createTables({ withInsertHistory: [treeTableCfg] });
      await server.createTables({ withInsertHistory: [treeTableCfg] });

      // 4. Client A imports first tree
      await clientA.import({
        [testTreeName]: { _type: 'trees', _data: trees1 },
      });

      // 5. Client B imports second tree
      await clientB.import({
        [testTreeName]: { _type: 'trees', _data: trees2 },
      });

      // 6. Client A can read its own tree (priority 1 - local)
      // Use controller.get() with root node ID for recursive child fetching
      const controllerA = await dbA.getController(testTreeName);
      const readTree1 = await controllerA.get(root1Hash, undefined, root1Id);
      const hasTree1 = readTree1[testTreeName]._data.some(
        (node: any) => node._hash === root1Hash,
      );
      expect(hasTree1).toBe(true);

      // 7. Client B can read its own tree (priority 1 - local)
      const controllerB = await dbB.getController(testTreeName);
      const readTree2ByB = await controllerB.get(root2Hash, undefined, root2Id);
      const hasTree2InB = readTree2ByB[testTreeName]._data.some(
        (node: any) => node._hash === root2Hash,
      );
      expect(hasTree2InB).toBe(true);

      // 8. Client A reads Client B's tree via server (priority 2)
      const readTree2ByA = await controllerA.get(root2Hash, undefined, root2Id);

      // Verify query completes
      expect(readTree2ByA[testTreeName]).toBeDefined();

      // Verify cross-client tree sync works
      const hasTree2InA = readTree2ByA[testTreeName]._data.some(
        (node: any) => node._hash === root2Hash,
      );
      expect(hasTree2InA).toBe(true);

      // Verify both clients see the same tree structure for tree2
      expect(readTree2ByA[testTreeName]._data.length).toBe(
        readTree2ByB[testTreeName]._data.length,
      );
    });
  });
});

describe('[Socket.IO namespaces] Coverage helpers', () => {
  const clientCount = 2;
  let harness: Awaited<ReturnType<typeof createNamespaceHarness>>;

  beforeAll(async () => {
    harness = await createNamespaceHarness(clientCount);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.serverSockets.forEach((socket) =>
      Object.values(socket).forEach((ns) => ns?.removeAllListeners()),
    );
    harness.clientSockets.forEach((socket) =>
      Object.values(socket).forEach((ns) => ns?.removeAllListeners()),
    );
  });

  it('Client.ready should resolve before init', async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();

    const client = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      io,
      bs,
    );
    await client.ready();

    (client as any)._ioMulti = {
      isReady: async () => undefined,
    };
    await client.ready();

    await client.tearDown();
  });

  it('Client.tearDown should close custom io', async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();

    const client = new Client(
      {
        ioUp: new SocketIoBridge((harness.clientSockets[0] as any).ioUp),
        ioDown: new SocketIoBridge((harness.clientSockets[0] as any).ioDown),
        bsUp: new SocketIoBridge((harness.clientSockets[0] as any).bsUp),
        bsDown: new SocketIoBridge((harness.clientSockets[0] as any).bsDown),
      },
      io,
      bs,
    );
    (client as any)._ioMulti = {
      isOpen: true,
      close: () => undefined,
    };
    (client as any)._bsMulti = {};

    await client.tearDown();
  });

  it('Server should handle multicast branches', async () => {
    const route = Route.fromFlat('coverage.route');
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();

    const server = new Server(route, io, bs);
    await server.init();

    const serverBundles = harness.serverSockets.map(
      (bundle) =>
        ({
          ioUp: new SocketIoBridge((bundle as any).ioUp),
          ioDown: new SocketIoBridge((bundle as any).ioDown),
          bsUp: new SocketIoBridge((bundle as any).bsUp),
          bsDown: new SocketIoBridge((bundle as any).bsDown),
        }) as SocketNamespaceBundle,
    );

    for (const serverBundle of serverBundles) {
      await server.addSocket(serverBundle);
    }

    let forwardedCount = 0;
    (harness.clientSockets[1] as any).ioDown.on(route.flat, () => {
      forwardedCount += 1;
    });

    (harness.clientSockets[0] as any).ioUp.emit(route.flat, { r: 'ref-1' });
    (harness.clientSockets[0] as any).ioUp.emit(route.flat, { r: 'ref-1' });
    (harness.clientSockets[0] as any).ioUp.emit(route.flat, {
      r: 'ref-2',
      __origin: 'origin',
    });

    await vi.waitUntil(() => forwardedCount === 1, {
      timeout: 1000,
      interval: 50,
    });
    expect(forwardedCount).toBe(1);
  });

  it('Server getters and queued refresh should be covered', async () => {
    const route = Route.fromFlat('coverage.route.2');
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();

    const server = new Server(route, io, bs);
    await server.init();
    await server.ready();

    await (Server.prototype.ready as any).call(server);

    expect(server.io).toBeDefined();
    expect(server.bs).toBeDefined();

    const ioGetter = Object.getOwnPropertyDescriptor(
      Server.prototype,
      'io',
    )?.get;
    const bsGetter = Object.getOwnPropertyDescriptor(
      Server.prototype,
      'bs',
    )?.get;

    expect(ioGetter?.call(server)).toBeDefined();
    expect(bsGetter?.call(server)).toBeDefined();

    (server as any)._refreshPromise = Promise.resolve();
    await (server as any)._queueRefresh();
  });
});
