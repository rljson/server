// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, Server as HttpServer } from 'node:http';

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { Io, IoMem } from '@rljson/io';
import { IoMssql } from '@rljson/io-mssql';
import { Route } from '@rljson/rljson';

import type { config as MssqlConfig } from 'mssql';
import { Server as SocketIoServer } from 'socket.io';

import { ConsoleLogger } from './logger.ts';
import { Server, ServerOptions } from './server.ts';
import { SocketIoBridge } from './socket-io-bridge.ts';

/**
 * Builds the mssql connection config from environment variables.
 * See .env.example for the full list of supported variables.
 */
export const mssqlConfigFromEnv = (): MssqlConfig => ({
  server: process.env.MSSQL_HOST ?? 'localhost',
  port: process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : undefined,
  database: process.env.MSSQL_DATABASE ?? 'rljson',
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt: process.env.MSSQL_ENCRYPT !== 'false',
    trustServerCertificate:
      process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
  },
});

/**
 * Creates the server's local Io backend.
 * IO_BACKEND=mem enables an in-memory backend for quick local iteration
 * without a real MSSQL instance. Defaults to the persistent mssql backend.
 *
 * Tables are NOT created here — that's a one-time step, see the Generator
 * repo's `setup-server-tables.ts`. Run it once per environment before
 * starting the Server against a fresh database.
 */
export const createLocalIo = async (): Promise<Io> => {
  if (process.env.IO_BACKEND === 'mem') {
    const io = new IoMem();
    await io.init();
    return io;
  }

  const io = new IoMssql(mssqlConfigFromEnv(), process.env.MSSQL_SCHEMA);
  await io.init();
  return io;
};

export interface StartedServer {
  servers: Server[];
  httpServer: HttpServer;
  socketIo: SocketIoServer;
}

/**
 * Reads the set of routes this Server instance should host from the
 * environment. Each route gets its own `Server` instance and its own
 * Socket.IO namespace (`socketIo.of(route.flat)`) — a Server/Client pair is
 * inherently single-route (see the `Server`/`Client` constructors), so hosting
 * several independent entity types (e.g. "customerCake" and "productCake")
 * side by side means running one Server per route, not one Server for all.
 *
 * `RLJSON_ROUTES` (comma-separated) takes precedence; `RLJSON_ROUTE`
 * (singular) remains supported for a single-route setup. Defaults to
 * "customerCake" when neither is set.
 */
export const routesFromEnv = (): Route[] => {
  const raw =
    process.env.RLJSON_ROUTES ?? process.env.RLJSON_ROUTE ?? 'customerCake';
  return raw
    .split(',')
    .map((flat) => flat.trim())
    .filter((flat) => flat.length > 0)
    .map((flat) => Route.fromFlat(flat));
};

type FetchedTable = { _data: Record<string, unknown>[]; _type: string };

/**
 * Recursively walks a row's official child references — the same
 * `Db.getController()` / `Controller.getChildRefs()` mechanism `Db` itself
 * uses internally to resolve routes. Cakes and Layers additionally point at
 * a SliceIds row via `sliceIdsTable`/`sliceIdsRow`(`sliceIdsTableRow`),
 * which `getChildRefs()` does not surface, so that link is followed
 * explicitly.
 *
 * `db` must wrap the Server's own merged `IoMulti` (`server.io`), not the
 * sending peer's Io directly: `IoMulti.readRows()` (which every `get()`
 * call below goes through) automatically writes back any row it fetches
 * from a lower-priority peer into every other writable Io — including the
 * server's own local, persistent one. Walking the graph via reads alone is
 * therefore enough to make it durable; no explicit write-back or raw dump
 * of the client's local storage is needed.
 * @param db - A Db wrapping the Server's merged IoMulti (`server.io`).
 * @param tableKey - The table of the row to fetch.
 * @param ref - The `_hash` of the row to fetch.
 * @param visited - Set of already-visited "tableKey:ref" pairs, to avoid
 * re-fetching shared nodes and to terminate on any cyclical references.
 */
const walkAndPersistByRef = async (
  db: Db,
  tableKey: string,
  ref: string,
  visited: Set<string>,
): Promise<void> => {
  const visitKey = `${tableKey}:${ref}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);

  const controller = await db.getController(tableKey);
  const result = await controller.get({ _hash: ref });
  const table = result[tableKey] as FetchedTable | undefined;
  if (!table || table._data.length === 0) return;

  const row = table._data[0];
  const childRefs = await controller.getChildRefs({ _hash: ref });

  const sliceIdsTable = row.sliceIdsTable as string | undefined;
  const sliceIdsRef = (row.sliceIdsRow ?? row.sliceIdsTableRow) as
    | string
    | undefined;
  const allChildren = sliceIdsTable && sliceIdsRef
    ? [...childRefs, { tableKey: sliceIdsTable, ref: sliceIdsRef }]
    : childRefs;

  for (const child of allChildren) {
    await walkAndPersistByRef(db, child.tableKey, child.ref, visited);
  }
};

/**
 * Provisions every table config known to *any* currently-reachable Io
 * (the server's own persistent store plus whichever peers are connected
 * right now) into every writable Io, including the server's own —
 * `IoMulti.rawTableCfgs()` already merges across all readables rather than
 * stopping at the first one, so a batch client's brand-new table configs
 * (e.g. a chart the Generator never synced before) are included as long as
 * that client is still connected. `createOrExtendTable()` is idempotent
 * (a no-op once a table already matches its config), so calling this on
 * every ref is safe — it only ever does real work the first time a given
 * table shows up.
 *
 * This is what lets a genuinely new entity type "just work" the first time
 * it's generated, without a separate `setup-server-tables` run first (see
 * that script for the one-time, all-registered-generators equivalent of
 * this — this does the same `rawTableCfgs()` + `createOrExtendTable()`
 * pairing, just scoped to what's reachable at this exact moment, and
 * triggered automatically instead of manually).
 * @param io - The Server's own merged IoMulti (`server.io`).
 */
const ensureTablesProvisioned = async (io: Io): Promise<void> => {
  const cfgs = await io.rawTableCfgs();
  for (const cfg of cfgs) {
    await io.createOrExtendTable({ tableCfg: cfg });
  }
};

/**
 * Builds the archival hook that makes clients' writes durable server-side.
 *
 * The sync protocol is pull-based: a client's data is normally only
 * reachable while that client stays connected. Batch clients (e.g. the
 * Generator) write locally and disconnect right after, so their data must
 * be pulled and persisted into the server's own local Io BEFORE the ref is
 * acknowledged — otherwise it would vanish the moment the client hangs up.
 *
 * The pull itself uses only official Db/Controller read APIs
 * (`walkAndPersistByRef`) against the Server's own merged IoMulti, relying
 * on its built-in hot-swap write-back — never a raw dump of everything the
 * client happens to hold locally, and no manual write() call here.
 * `ensureTablesProvisioned` runs first so that write-back never fails with
 * a missing-table error for a table this exact server has never seen yet.
 *
 * `server` is assigned right after construction (see `main`); the hook
 * itself only runs later, once a client actually sends a ref.
 * @param getServer - Lazily returns the Server instance once constructed.
 * @returns The onRefArrived hook to pass into ServerOptions.
 */
export const createOnRefArrived = (
  getServer: () => Server,
): NonNullable<ServerOptions['onRefArrived']> => {
  return async (ctx) => {
    const server = getServer();
    await ensureTablesProvisioned(server.io);

    const serverDb = new Db(server.io);
    const rootTableKey = Route.fromFlat(ctx.route).top.tableKey;

    await walkAndPersistByRef(serverDb, rootTableKey, ctx.ref, new Set());
  };
};

/**
 * Boots the rljson Server on top of an HTTP + Socket.IO transport.
 * Returns the created instances so callers (tests, supervisors) can
 * inspect or tear them down; src/start.ts fires-and-forgets it.
 */
export const main = async (): Promise<StartedServer> => {
  const routes = routesFromEnv();
  const localIo = await createLocalIo();
  const localBs = new BsMem();

  const httpServer = createServer();
  const socketIo = new SocketIoServer(httpServer, {
    cors: { origin: '*' },
  });

  // Every route shares the same persistent backend (one MSSQL database) and
  // HTTP/Socket.IO listener — they only ever touch different tables, so
  // there is nothing to isolate between them beyond the namespace that
  // keeps their Socket.IO traffic apart.
  const servers = routes.map((route) => {
    const server: Server = new Server(route, localIo, localBs, {
      logger: new ConsoleLogger(),
      syncConfig: { requireAck: true },
      onRefArrived: createOnRefArrived(() => server),
    });
    return server;
  });
  await Promise.all(servers.map((server) => server.init()));

  routes.forEach((route, index) => {
    const server = servers[index];
    socketIo.of(route.flat).on('connection', (socket) => {
      server.addSocket(new SocketIoBridge(socket)).catch((err) => {
        console.error('Failed to register client socket', err);
      });
    });
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  const backend = process.env.IO_BACKEND === 'mem' ? 'mem' : 'mssql';
  console.log(
    `rljson server listening on port ${port} (routes: ${routes.map((r) => r.flat).join(', ')}, io backend: ${backend})`,
  );

  return { servers, httpServer, socketIo };
};
