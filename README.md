<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/server

Local-first, pull-by-reference server layer for Rljson. Clients keep writes local, pull data on demand through multis, and let the server proxy references without duplicating client data.

- Writes stay local; reads cascade: local ➜ server ➜ peers
- References (hashes) flow; data is pulled on demand
- Server aggregates sockets and multicasts refs, but only stores what you explicitly import
- Graceful lifecycle: `tearDown()` for both Server and Client, automatic disconnect cleanup, `removeSocket()` for manual removal
- Configurable production defaults: ref eviction interval, peer init timeout (server and client)
- Structured logging via injectable `ServerLogger` (NoopLogger default, ConsoleLogger, BufferedLogger, FilteredLogger included)
- **Sync protocol**: Optional ACK aggregation, causal ordering with gap-fill, enriched payload forwarding via `SyncConfig`

## Quick start

Install:

```sh
pnpm add @rljson/server
```

Minimal server:

```ts
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Server, SocketIoBridge } from '@rljson/server';

const route = Route.fromFlat('my.app');
const serverIo = new IoMem();
await serverIo.init();
await serverIo.isReady();

const server = new Server(route, serverIo, new BsMem());
await server.init();

// When your runtime yields sockets, wrap them:
// await server.addSocket(new SocketIoBridge(serverSocket));
```

Minimal client:

```ts
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Client, SocketIoBridge } from '@rljson/server';

// Pass the same route as the server to get Db and Connector automatically
const route = Route.fromFlat('my.app');
const client = new Client(new SocketIoBridge(clientSocket), new IoMem(), new BsMem(), route);
await client.init();

const io = client.io;               // IoMulti merged interface
const bs = client.bs;               // BsMulti merged interface
const db = client.db;               // Db (available when route provided)
const connector = client.connector; // Connector (available when route provided)
```

## Import, edit on a client, edit on the server

The minimal setup above only wires transport. This example carries data through
it: the server **imports** a row, a client **edits** it, and the server **edits**
it too — with every change announced as a ref and pulled on demand. It runs
as-is (in-process socket pairs, in-memory stores), so it can be pasted into a
file and executed with `npx vite-node <file>.ts`.

```ts
import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { createSocketPair, IoMem } from '@rljson/io';
import { Route, TableCfg } from '@rljson/rljson';
import { Client, Server } from '@rljson/server';

const route = Route.fromFlat('cars');

// Refs travel between the parties — table definitions do not. Every party
// creates the same table itself (see "Tables on all parties" below).
const carsCfg: TableCfg = {
  key: 'cars',
  type: 'components',
  isHead: false,
  isRoot: true,
  isShared: false,
  columns: [
    { key: '_hash', type: 'string', titleLong: 'Hash', titleShort: 'Hash' },
    { key: 'brand', type: 'string', titleLong: 'Brand', titleShort: 'Brand' },
    { key: 'model', type: 'string', titleLong: 'Model', titleShort: 'Model' },
  ],
};

const openIo = async () => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  return io;
};

// One edit = one insert. `_type` is mandatory: Db.insert() reads it to pick the
// controller, and an insert tree without it writes nothing and fails on the
// InsertHistory row.
const writeCar = async (db: Db, car: { brand: string; model: string }) => {
  const [row] = await db.insert(route, {
    cars: { _type: 'components', _data: [car] },
  });
  return row.carsRef as string;
};

const example = async () => {
  // --- Server ---------------------------------------------------------------
  const server = new Server(route, await openIo(), new BsMem());
  await server.init();

  // The server joins its own multicast ring through a loopback pair, so it can
  // ANNOUNCE refs like any client. `addBroadcastSocket` (not `addSocket`) is
  // the right call: the ring only needs the socket, and the server's own data
  // already sits in its IoMulti — no IoPeer/BsPeer back to itself.
  const [serverSide, hubSide] = createSocketPair();
  serverSide.connect();
  await server.addBroadcastSocket(serverSide);

  // A Db over `server.io` writes into exactly the store the ring reads from.
  const serverDb = new Db(server.io);
  const serverConnector = new Connector(serverDb, route, hubSide);

  // --- Clients --------------------------------------------------------------
  const addClient = async () => {
    const [serverSocket, clientSocket] = createSocketPair();
    serverSocket.connect();
    await server.addSocket(serverSocket);
    const client = new Client(clientSocket, await openIo(), new BsMem(), route);
    await client.init();
    return client;
  };

  const clientA = await addClient();
  const clientB = await addClient();

  // --- Tables on all parties ------------------------------------------------
  for (const party of [server, clientA, clientB]) {
    await party.createTables({ withInsertHistory: [carsCfg] });
  }

  // --- React to arriving refs by pulling the row behind them ----------------
  // The pull cascades local ➜ server ➜ peers, so a client that holds nothing
  // still resolves a ref another party wrote.
  for (const [name, client] of [['A', clientA], ['B', clientB]] as const) {
    client.connector!.listen(async (ref) => {
      const { rljson } = await client.db!.get(route, { _hash: ref });
      console.log(`[${name}] pulled`, rljson.cars._data[0]);
    });
  }

  // --- 1. Import data into the server --------------------------------------
  // The server stores only what it is explicitly given. `import` is that
  // moment: bulk Rljson straight into the server's own store.
  await server.import({
    cars: {
      _type: 'components',
      _data: [{ brand: 'Tesla', model: 'Model S' }],
    },
  });

  const imported = await serverDb.get(route, {});
  const importedRef = imported.rljson.cars._data[0]._hash as string;
  serverConnector.send(importedRef); // → [A] pulled, [B] pulled

  // --- 2. Edit on a client --------------------------------------------------
  // Writes stay local; only the ref leaves the client. B resolves it by
  // pulling through the server back to A.
  const refFromA = await writeCar(clientA.db!, {
    brand: 'Tesla',
    model: 'Model 3',
  });
  clientA.connector!.send(refFromA); // → [B] pulled (A gets no self-echo)

  // --- 3. Edit on the server ------------------------------------------------
  // Same two steps, on the server's own Db and Connector.
  const refFromServer = await writeCar(serverDb, {
    brand: 'VW',
    model: 'ID.3',
  });
  serverConnector.send(refFromServer); // → [A] pulled, [B] pulled

  // A ref can also be resolved whenever it is needed — the pull is the read.
  const onB = await clientB.db!.get(route, { _hash: refFromA });
  console.log('[B] direct read:', onB.rljson.cars._data[0]);

  await clientA.tearDown();
  await clientB.tearDown();
  await server.tearDown();
};

example();
```

What the three steps have in common: **write locally, announce the ref, let the
others pull.** Import is the only bulk transfer, and it targets one store only —
the one that called it. In production, swap `createSocketPair` for
`SocketIoBridge(socket)` and `IoMem`/`BsMem` for the persistent Io/Bs of your
choice; nothing else in the flow changes.

Run tests and lint:

```sh
pnpm test
```

Build distribution:

```sh
pnpm build
```

## Documentation map

| Audience        | File                                             | Highlights                                        |
| --------------- | ------------------------------------------------ | ------------------------------------------------- |
| Users           | [README.public.md](README.public.md)             | Install, usage, networking model, examples        |
| Contributors    | [README.contributors.md](README.contributors.md) | Setup, dev workflow, publishing, fast coding tips |
| Architecture    | [README.architecture.md](README.architecture.md) | Deep dive into multis, peer bridges, data flows   |
| Troubleshooting | [README.trouble.md](README.trouble.md)           | Known issues and fixes                            |
| Blog            | [README.blog.md](README.blog.md)                 | Writing and collecting project blog entries       |

## Example code

See [src/example.ts](src/example.ts) for a runnable end-to-end demo and [test/server.spec.ts](test/server.spec.ts) for broader integration cases.
