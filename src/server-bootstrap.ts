// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer, Server as HttpServer } from 'node:http';

import { BsMem } from '@rljson/bs';
import { Db } from '@rljson/db';
import { Io, IoMem } from '@rljson/io';
import { DbBasics, IoMssql } from '@rljson/io-mssql';
import { Route } from '@rljson/rljson';

import type { config as MssqlConfig } from 'mssql';
import { Server as SocketIoServer } from 'socket.io';

import { ConsoleLogger } from './logger.ts';
import { Server, ServerOptions } from './server.ts';
import { SocketIoBridge } from './socket-io-bridge.ts';

/**
 * Builds the mssql connection config from environment variables.
 * See .env.example for the full list of supported variables.
 *
 * `pool.max` is raised from the `mssql` package's own default (10) to 25:
 * `walkAndPersistByRef`'s concurrent tree walk (see below) and
 * `ensureTablesProvisioned`'s concurrent table creation both fan out many
 * simultaneous requests against this one pool — a deeply-nested chart
 * (e.g. "Customer", with several address sub-entities each pulling in
 * their own component tables) can easily want more than 10 requests in
 * flight at once. A pool that's too small doesn't break anything — extra
 * requests just queue for a free connection — but it silently caps how
 * much of that concurrency ever actually reaches MSSQL, which can matter
 * for `sendWithAck` timeouts under real traffic just as much as the
 * concurrency in application code does. `MSSQL_POOL_MAX` overrides it.
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
  pool: {
    max: process.env.MSSQL_POOL_MAX ? Number(process.env.MSSQL_POOL_MAX) : 25,
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
 * Sibling children (and, transitively, the whole rest of the tree below
 * this node) are walked concurrently (`Promise.all`), not one after
 * another — a deeply-nested chart (e.g. "Customer", with several address
 * sub-entities each pulling in their own component tables) can mean many
 * sequential round trips for a single ref; done one at a time, that alone
 * can take longer than a client's `sendWithAck` timeout, even once
 * provisioning itself is already cheap (see `createEnsureTablesProvisioned`
 * above). This is safe: the `visited.has()`/`.add()` dedup pair below has
 * no `await` between them, so it's atomic with respect to any other
 * concurrently-running call of this function — two branches racing to
 * visit the same shared node still only ever process it once.
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

  await Promise.all(
    allChildren.map((child) =>
      walkAndPersistByRef(db, child.tableKey, child.ref, visited),
    ),
  );
};

/**
 * Builds a memoized `ensureTablesProvisioned` — provisions every table
 * config known to *any* currently-reachable Io (the server's own
 * persistent store plus whichever peers are connected right now) into
 * every writable Io, including the server's own. `IoMulti.rawTableCfgs()`
 * already merges across all readables rather than stopping at the first
 * one, so a batch client's brand-new table configs (e.g. a chart the
 * Generator never synced before) are included as long as that client is
 * still connected.
 *
 * This is what lets a genuinely new entity type "just work" the first time
 * it's generated, without a separate `setup-server-tables` run first (see
 * that script for the one-time, all-registered-generators equivalent of
 * this — this does the same `rawTableCfgs()` + `createOrExtendTable()`
 * pairing, just scoped to what's reachable at this exact moment, and
 * triggered automatically instead of manually).
 *
 * `createOrExtendTable()` is idempotent, so calling it again for a table
 * already at its current config is *correct* but not free — it's still a
 * real MSSQL round trip. Left unmemoized, a database with 50+ tables (a
 * chart like "Customer" with many nested sub-entities) means 50+ wasted
 * round trips on *every single ref forever*, not just the first — cheap
 * individually, but enough in aggregate (especially with several refs
 * arriving close together, e.g. a `--count 30` generate run) to exceed a
 * client's `sendWithAck` timeout again, the exact failure this was meant
 * to fix. The returned closure instead remembers which table *keys* it has
 * already confirmed, scoped to one Server/route instance (one
 * `createOnRefArrived` call), and only ever calls `createOrExtendTable()`
 * for a key it hasn't seen yet — a genuinely new table still gets
 * provisioned; one already confirmed does not get re-sent. Memoizing by
 * key alone (not also the config's content) means a table whose columns
 * change *after* this process already provisioned it won't be picked up
 * until the process restarts — an acceptable trade-off here, matching how
 * `routesFromEnv()` below is also only ever read once at startup, not
 * hot-reloaded; a genuinely new key is still always picked up.
 *
 * The per-table calls that do run still run concurrently (`Promise.all`),
 * not one after another, for the same reason: each table's SQL touches
 * only that table (no cross-table constraints), so concurrent calls are
 * safe; the `mssql` package's `ConnectionPool` (which `IoMssql` holds one
 * of) is designed for exactly this — multiple concurrent `Request`s
 * sharing one pool.
 *
 * Memoized by (resolved-or-in-flight) `Promise`, not just a `Set` of
 * already-*confirmed* keys — a real, reproduced bug: two `onRefArrived`
 * invocations for different refs can run concurrently (see
 * `BATCH_CONCURRENCY` in the Generator repo), each independently calling
 * this function; both can see a genuinely new table's key as "not yet
 * confirmed" (neither has finished creating it yet) and both then call
 * `createOrExtendTable()` for it — two concurrent `CREATE TABLE`s for the
 * same brand-new table crash with a primary-key violation on
 * `tableCfgs_tbl`, taking the whole Server process down with them (an
 * uncaught exception, not just a dropped ref). Storing the *promise* the
 * moment a key is first seen — synchronously, before any `await`, exactly
 * like `ensureMssqlAdminSchemaProvisioned`'s own memoization — means a
 * second concurrent call for the same key finds and awaits that SAME
 * promise instead of starting a second, colliding attempt. `rawTableCfgs()`
 * can also report the same table more than once within a *single* call
 * (e.g. once from the Server's own local Io, once from a connected peer),
 * so results are deduplicated by key before mapping to attempts too.  A
 * failed attempt is discarded (not cached), so the next ref retries it.
 */
const createEnsureTablesProvisioned = (): ((io: Io) => Promise<void>) => {
  const attempts = new Map<string, Promise<void>>();

  return async (io) => {
    const cfgs = await io.rawTableCfgs();
    const uniqueByKey = new Map(cfgs.map((cfg) => [cfg.key, cfg]));

    await Promise.all(
      [...uniqueByKey.values()].map((cfg) => {
        const existing = attempts.get(cfg.key);
        if (existing) return existing;

        const attempt = io.createOrExtendTable({ tableCfg: cfg }).catch(
          (err: unknown) => {
            attempts.delete(cfg.key);
            throw err;
          },
        );
        attempts.set(cfg.key, attempt);
        return attempt;
      }),
    );
  };
};

/**
 * Builds a memoized `ensureMssqlAdminSchemaProvisioned` — provisions the
 * MSSQL-specific "main" schema and its admin stored procedures (e.g.
 * `GetContentType`) — infrastructure `IoMssql` needs before it can serve
 * `contentType()` requests, but which nothing in the regular sync flow
 * creates on its own (previously only `setup-server-tables` did this, via
 * the exact same `DbBasics` calls).
 *
 * `DbBasics.createSchema()`/`installProcedures()` are individually
 * idempotent (`IF NOT EXISTS`/`CREATE OR ALTER PROCEDURE`), but each opens
 * its own fresh MSSQL connection (unlike `IoMssql`, `DbBasics` holds no
 * persistent pool) — five or more separate connections, every single time
 * this ran. That's fine once, but calling it unconditionally on every ref
 * forever adds real, avoidable latency to every ref after the first, which
 * — like the unmemoized table provisioning above — was enough on its own
 * to blow past a client's `sendWithAck` timeout under real traffic. The
 * returned closure instead runs the underlying provisioning at most once
 * per Server/route instance (one `createOnRefArrived` call) and caches the
 * in-flight/resolved promise so concurrent and later calls all await the
 * same attempt instead of starting their own; a failed attempt clears the
 * cache so the next ref retries rather than being stuck failing forever.
 *
 * Uses the same `MSSQL_*`-derived config as the app's regular connection
 * (`mssqlConfigFromEnv()`); no elevated credentials needed, since the
 * `db_owner` role membership granted during the one-time database/login
 * setup (see the top-level README) is already enough to create a schema
 * and procedures within a database that login owns.
 *
 * A no-op for the `IO_BACKEND=mem` backend, which has no such concept.
 */
const createEnsureMssqlAdminSchemaProvisioned = (): (() => Promise<void>) => {
  let provisioned: Promise<void> | undefined;

  return () => {
    if (process.env.IO_BACKEND === 'mem') return Promise.resolve();

    if (!provisioned) {
      const dbBasics = new DbBasics();
      const dbName = process.env.MSSQL_DATABASE ?? 'rljson';
      provisioned = dbBasics
        .createSchema(mssqlConfigFromEnv(), dbName, 'main')
        .then(() => dbBasics.installProcedures(mssqlConfigFromEnv(), dbName))
        .then(() => undefined)
        .catch((err: unknown) => {
          provisioned = undefined;
          throw err;
        });
    }
    return provisioned;
  };
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
 * The memoized `ensureMssqlAdminSchemaProvisioned`/`ensureTablesProvisioned`
 * closures below run first (concurrently with each other — they touch
 * disjoint schemas, "main" vs. the data tables, so there is no ordering
 * dependency between them) so that write-back never fails against a
 * completely fresh MSSQL database — one that has never had
 * `setup-server-tables` run against it at all, not even once — nor with a
 * missing-table error for a table this exact server has never seen yet.
 * Being memoized (see each factory's own doc comment for why) is what
 * keeps that safety net cheap on every ref after the first, instead of
 * paying for real provisioning work over and over.
 *
 * `server` is assigned right after construction (see `main`); the hook
 * itself only runs later, once a client actually sends a ref. The two
 * memoized closures are created once here, per `createOnRefArrived` call
 * — i.e. once per Server/route instance, exactly matching their intended
 * "at most once per running Server" scope; a fresh call (e.g. a new test,
 * or a real process restart) starts fresh, which is correct — a brand-new
 * process has no way to know whether provisioning already happened.
 * @param getServer - Lazily returns the Server instance once constructed.
 * @returns The onRefArrived hook to pass into ServerOptions.
 */
export const createOnRefArrived = (
  getServer: () => Server,
): NonNullable<ServerOptions['onRefArrived']> => {
  const ensureMssqlAdminSchemaProvisioned =
    createEnsureMssqlAdminSchemaProvisioned();
  const ensureTablesProvisioned = createEnsureTablesProvisioned();

  return async (ctx) => {
    const server = getServer();
    await Promise.all([
      ensureMssqlAdminSchemaProvisioned(),
      ensureTablesProvisioned(server.io),
    ]);

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
