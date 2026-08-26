<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/server

@rljson/server provides a lightweight client/server layer for Rljson storage. It wires Io (row/table data) and Bs (blob storage) over sockets so clients can read from server storage while still keeping their own local storage.

## Prerequisites

- Node.js v22.14.0 or newer
- A socket runtime (examples use Socket.IO)
- `Io`/`Bs` implementations (in-memory examples use `IoMem` and `BsMem`)

## Design pillars

- **Local-first, read-through**: Writes stay on the caller; reads walk priorities (local first, then peers via server).
- **Pull by reference**: Only references (hashes) travel over the wire; data is pulled on demand through `IoMulti`/`BsMulti`.
- **Server as proxy**: The server aggregates and multicasts refs, but does not duplicate client data unless you intentionally store it there.
- **Single abstraction surface**: `Client.io`/`Client.bs` and `Server.io`/`Server.bs` expose merged multis so you do not handle peers manually.

## What it does (quick overview)

- **Server** hosts Io + Bs and exposes them over sockets.
- **Client** combines local Io/Bs with server Io/Bs into unified interfaces.
- **Sockets** are provided by your runtime (e.g., Socket.IO) and wrapped by `SocketIoBridge`.

## Install

```sh
pnpm add @rljson/server
```

## Running this workspace's local dev server

This repo also ships a **standalone local server process** on top of the
library — [`src/start.ts`](src/start.ts) /
[`src/server-bootstrap.ts`](src/server-bootstrap.ts) — used by this
workspace's [generator](../data-generator) and [generator-ui](../generator-ui) to
sync against a real MSSQL database. This is specific to this checkout, not
part of what a consumer of the published `@rljson/server` package needs —
skip this section if you're only using the library API below.

```sh
npm start
```

Configured entirely via `.env` (copy `.env.example`):

| Variable | Purpose |
|---|---|
| `IO_BACKEND` | `mssql` (default, persistent) or `mem` (in-memory, lost on exit) |
| `MSSQL_*` | Connection details — must match the Generator repo's own `.env` |
| `RLJSON_ROUTES` | Comma-separated list of routes to host, one per independent entity type (e.g. `customerCake,productCake`) — each gets its own `Server` instance and Socket.IO namespace, since a `Server`/`Client` pair is single-route. `RLJSON_ROUTE` (singular) is also accepted for a single-route setup. |
| `PORT` | HTTP/Socket.IO port (default `3000`) |

`createOnRefArrived` (in `server-bootstrap.ts`) wires the
[`onRefArrived` archival hook](#onrefarrived-archival-hook) below to
recursively pull and persist every ref a client sends — necessary because
batch clients (like the Generator) write locally and disconnect right
away, so their data must be durable server-side *before* the ack, not
just reachable while they happen to stay connected. Before that walk, it
also provisions everything the persist step needs against a completely
fresh MSSQL database, in two steps:

1. `ensureMssqlAdminSchemaProvisioned` — for the `mssql` backend only
   (a no-op under `IO_BACKEND=mem`) — installs the `main` schema and its
   admin stored procedures (e.g. `GetContentType`) via the same
   `DbBasics.createSchema()`/`installProcedures()` calls
   `setup-server-tables` used to be the only thing that ran. Both are
   idempotent, so this is safe on every ref, not just the first.
2. `ensureTablesProvisioned` calls `IoMulti.rawTableCfgs()`/
   `createOrExtendTable()` to provision any table config reachable from a
   connected peer that this server doesn't have yet — so a genuinely new
   entity type (e.g. a chart file the Generator never synced before) works
   the first time too.

Both steps run concurrently with each other, and every table within step
2 is also provisioned concurrently (`Promise.all`, not a sequential
loop): against a brand-new database, a chart with many sub-entities (e.g.
"Customer", with its nested addresses) means 50+ tables, each its own
MSSQL round trip — done one after another, that alone can take longer
than a client's `sendWithAck` timeout, producing a misleading "ACK
timeout" error even though the Server finishes and archives the ref
correctly moments later.

Both steps are also **memoized**, per Server/route instance (i.e. once
per `createOnRefArrived` call, which `main()` makes exactly once per
route): `createOrExtendTable()`/`DbBasics`' calls are individually
idempotent, but each is still a real MSSQL round trip (and `DbBasics`
opens a fresh connection per call, unlike `IoMssql`'s persistent pool) —
unconditionally repeating all of them on *every single ref forever*, not
just the first, adds enough latency under real traffic (several refs
arriving close together, e.g. a `--count 30` generate run across two
entity types) to blow past the ACK timeout again, even against a database
that already has every table it needs. Step 1 caches its resolved (or
in-flight) promise; step 2 remembers which table *keys* it already
confirmed. Either cache is cleared on a failed attempt, so the next ref
retries instead of being stuck failing forever — and a genuinely new
table key (or a fresh process, e.g. after a restart) is always still
picked up.

Even with provisioning itself made cheap, one more sequential cost
remained: the archival walk that pulls and persists a ref's whole subtree
(`walkAndPersistByRef`) used to visit sibling children one after another.
A deeply-nested chart (e.g. "Customer", with several address
sub-entities each pulling in their own component tables) can mean many
sequential round trips for a *single* ref — enough, under real traffic,
to exceed the ACK timeout on its own, independent of provisioning. That
walk is now concurrent too (`Promise.all` over sibling children, which
recursively means the whole subtree), safe because the walker's
visited-set dedup check has no `await` between checking and marking a
node visited — so it stays atomic even when branches race to reach the
same shared node.

Together, this means the **only** step left that this project doesn't
automate is creating the database/login/schema container itself (needs
server-level `sysadmin`/`dbcreator` rights the app's own login
intentionally doesn't have — see the top-level README's step 1). Once
that container exists, the very first `generate` run against it does
everything else — no `setup-server-tables` run required, ever.

See the top-level [README.md](../README.md) for the full walkthrough
(one-time MSSQL setup, starting Server + generator-ui together, generating and
viewing data, adding a new entity type).

## Quick start (Socket.IO example)

Server setup:

```ts
import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Server, SocketIoBridge } from '@rljson/server';

const httpServer = createServer();
const socketIo = new SocketIoServer(httpServer);

const route = Route.fromFlat('my.app');
const server = new Server(route, new IoMem(), new BsMem());
await server.init();

// Or with logging enabled:
// import { ConsoleLogger } from '@rljson/server';
// const server = new Server(route, new IoMem(), new BsMem(), { logger: new ConsoleLogger() });

socketIo.on('connection', async (socket) => {
   await server.addSocket(new SocketIoBridge(socket));
});

httpServer.listen(0);
```

Client setup:

```ts
import { io as socketIoClient } from 'socket.io-client';
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { Client, SocketIoBridge } from '@rljson/server';

const socket = socketIoClient('http://localhost:3000', { forceNew: true });

// Pass the same route as the server to automatically create Db and Connector
const route = Route.fromFlat('my.app');
const client = new Client(new SocketIoBridge(socket), new IoMem(), new BsMem(), route);
await client.init();

// Or with logging enabled:
// import { ConsoleLogger } from '@rljson/server';
// const client = new Client(socket, io, bs, route, { logger: new ConsoleLogger() });

// client.db and client.connector are ready to use
// client.db.get/insert now cascade local ➜ server automatically
```

## Basic usage

### Server

```ts
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { Server } from '@rljson/server';

const route = Route.fromFlat('my.app.route');
const serverIo = new IoMem();
await serverIo.init();
await serverIo.isReady();

const serverBs = new BsMem();
const server = new Server(route, serverIo, serverBs);
await server.init();

// When a socket connects:
// await server.addSocket(new SocketIoBridge(serverSocket));
```

### Client API

```ts
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { Client } from '@rljson/server';

const localIo = new IoMem();
await localIo.init();
await localIo.isReady();

const localBs = new BsMem();

// With route: Db and Connector are created automatically
const route = Route.fromFlat('my.app.route');
const client = new Client(new SocketIoBridge(clientSocket), localIo, localBs, route);
await client.init();

// Unified interfaces
const io = client.io;          // IoMulti (local + server)
const bs = client.bs;          // BsMulti (local + server)
const db = client.db;          // Db (wraps IoMulti)
const connector = client.connector; // Connector (wired to route + socket)
```

The `route` parameter is optional. Without it, the client only sets up `io` and `bs`, and `db`/`connector` will be `undefined`.

## How the layering works

Both client and server use a **multi-layer** approach:

- **Local layer** (priority 1): always read/write to local Io/Bs
- **Peer layer** (priority 2): read-only from server Io/Bs

This is implemented with `IoMulti` and `BsMulti` internally, but the public API exposes them as `Io` and `Bs`.

## API highlights

### Client

- `init()` – builds Io/Bs multis, starts peer bridges, and (if route was provided) creates Db and Connector
- `ready()` – resolves once Io is ready
- `tearDown()` – closes and clears local state
- `io` – Io interface (multi-layer)
- `bs` – Bs interface (multi-layer)
- `db` – Db instance wrapping IoMulti (available when route was provided)
- `connector` – Connector wired to the route and socket (available when route was provided)
- `route` – the Route passed to the constructor
- `logger` – the `ServerLogger` instance (defaults to `noopLogger`)
- `isConnected` – whether the socket is currently connected (tracks `disconnect`/`connect` events)
- `onDisconnect(callback)` – registers a callback that fires when the socket disconnects (receives the reason string)
- `onReconnect(callback)` – registers a callback that fires when the socket reconnects after a previous disconnect

### Server API

- `init()` – initializes server multis
- `ready()` – resolves when Io is ready
- `addSocket(socket)` – registers a client socket, sets up disconnect handling, and refreshes multis
- `removeSocket(clientId)` – removes a client, cleans up peers/listeners, and rebuilds multis
- `tearDown()` – gracefully shuts down: stops timers, clears all clients, closes storage
- `io` – Io interface used by server
- `bs` – Bs interface used by server
- `clients` – `Map` of connected clients (keyed by internal clientId)
- `isTornDown` – whether the server has been shut down
- `isLocalCacheDisabled` – whether local caching is disabled (pure relay mode)
- `logger` – the `ServerLogger` instance (defaults to `noopLogger`)
- `ioPeerCount` – number of `IoPeer` entries currently in the Io read cascade (excludes the local cache slot); reflects reality after dead/orphaned-peer pruning, useful for asserting cascade size after connect/disconnect churn
- `readableIds` – stable identifiers (`'local'`, a peer's `clientId`, or `'orphan'`) for every entry currently in the Io read cascade, in cascade order

## Example

[src/example.ts](src/example.ts)

## Deeper dive

### Networking flow

1. **Client connects** using your socket runtime.
2. **Server registers** the socket with `addSocket()`.
3. **IoPeerBridge** allows the server to pull from client local Io (upstream).
4. **IoPeer** allows the client to pull from server Io (downstream).
5. `IoMulti` merges these layers into a single Io interface.

The same pattern is used for Bs (blob storage).

### Consistency model

- Local writes are immediate.
- Server data is read-only from the client perspective.
- Multi-layer priority ensures local data always wins.

### When to use this package

- You want **local-first** data access with server-backed reads.
- You want **Io and Bs** to share a consistent socket layer.
- You want a single abstraction for both **in-memory** and **networked** access.

## Notes

- `Client.io` and `Client.bs` are already merged interfaces. No need to access multis directly.
- `Server.addSocket()` batches refreshes to reduce rebuild overhead when multiple sockets connect.
- Multicast uses `__origin` markers plus a two-generation ref set to prevent echo loops. Stale refs are automatically evicted (configurable via `refEvictionIntervalMs`).
- Disconnected sockets are auto-detected and cleaned up — dead peers are removed and multis rebuilt.
- Peer initialization is guarded by a configurable timeout (`peerInitTimeoutMs`, default 30 s) on both server and client. On the server it prevents `addSocket()` from hanging on unresponsive clients; on the client it prevents `init()` from hanging when the server is unreachable.
- Logging is opt-in via `{ logger }` options. Use `ConsoleLogger` for development, `BufferedLogger` for testing, `FilteredLogger` for production. Default is `NoopLogger` (zero overhead).

## Reconnect handling

The `Client` class tracks socket connection state and provides hooks for upper layers to react to disconnects and reconnections.

### How it works

Socket.IO auto-reconnects at the transport level by default. When the connection drops and is restored:

1. The client-side Socket.IO socket emits `'disconnect'` then (later) `'connect'`.
2. The `Client` class listens for these events and updates `isConnected`.
3. Registered `onDisconnect` / `onReconnect` callbacks fire.
4. The server auto-detects the dropped socket (`removeSocket`) and re-registers the reconnected socket via a new `'connection'` event.
5. The server sends a bootstrap ref to the reconnected client, triggering a re-sync via the Connector's bootstrap handler.

### Usage

```ts
import { Client } from '@rljson/server';

const client = new Client(socket, io, bs, route, {
  logger: new ConsoleLogger(),
});
await client.init();

// Track connection state
console.log(client.isConnected); // true

// React to disconnects
client.onDisconnect((reason) => {
  console.warn(`Disconnected: ${reason}`);
  // Pause user-facing sync indicators, queue local changes, etc.
});

// React to reconnections
client.onReconnect(() => {
  console.info('Reconnected to server');
  // Resume sync, trigger re-fetch, update UI, etc.
});
```

### What survives a reconnect

| Layer             | Survives? | Details                                                           |
| ----------------- | --------- | ----------------------------------------------------------------- |
| Socket.IO         | ✅         | Auto-reconnects, reuses the same client-side socket object        |
| SocketIoBridge    | ✅         | Wraps the same socket — event listeners are preserved             |
| IoPeer / BsPeer   | ✅         | Listeners remain on the client socket; server re-creates its side |
| Connector         | ✅         | Listeners remain; server bootstrap re-syncs state                 |
| IoMulti / BsMulti | ✅         | Multi layers are unaffected; local Io/Bs always available         |

### Cleanup

All connection handlers are cleaned up automatically on `tearDown()`. After tearDown, no callbacks will fire.

## Logging

Both `Server` and `Client` support structured logging via an injectable `ServerLogger` interface. Logging is opt-in — by default a zero-overhead `NoopLogger` is used.

### Logger implementations

| Class            | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `NoopLogger`     | Default. All methods are empty — zero overhead in production. |
| `ConsoleLogger`  | Logs to `console.log`/`warn`/`error`. Good for development.   |
| `BufferedLogger` | Stores entries in memory. Ideal for test assertions.          |
| `FilteredLogger` | Wraps another logger, filtering by level and/or source.       |

### Injecting a logger

```ts
import { Server, Client, ConsoleLogger, BufferedLogger, FilteredLogger } from '@rljson/server';

// Console logging (development)
const server = new Server(route, io, bs, { logger: new ConsoleLogger() });
const client = new Client(socket, io, bs, route, { logger: new ConsoleLogger() });

// Buffered logging (testing)
const logger = new BufferedLogger();
const server = new Server(route, io, bs, { logger });
// After operations:
logger.entries;           // All log entries
logger.byLevel('error');  // Only errors
logger.bySource('Server.Multicast'); // Only multicast entries
logger.clear();           // Reset

// Filtered logging (production — errors and warnings only)
const filtered = new FilteredLogger(new ConsoleLogger(), {
  levels: ['error', 'warn'],
});
const server = new Server(route, io, bs, { logger: filtered });

// Filtered by source (only multicast traffic)
const trafficOnly = new FilteredLogger(new ConsoleLogger(), {
  levels: ['traffic'],
  sources: ['Server.Multicast'],
});
```

### Log levels

| Level     | Method                                            | What it captures                                                              |
| --------- | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `info`    | `logger.info(source, message, data?)`             | Lifecycle events: construction, init, tearDown, peer creation, multi rebuilds |
| `warn`    | `logger.warn(source, message, data?)`             | Duplicate ref suppression, loop prevention                                    |
| `error`   | `logger.error(source, message, error?, data?)`    | Failures during init, peer creation, multicast, multi rebuilds                |
| `traffic` | `logger.traffic(direction, source, event, data?)` | Socket traffic: inbound refs from clients, outbound multicasts to clients     |

### Log sources

Each log entry includes a `source` field identifying the component:

| Source             | Component                                             |
| ------------------ | ----------------------------------------------------- |
| `Server`           | Server lifecycle (init, addSocket, rebuild, refresh)  |
| `Server.Io`        | Server Io peer creation                               |
| `Server.Bs`        | Server Bs peer creation                               |
| `Server.Multicast` | Ref broadcasting between clients                      |
| `Client`           | Client lifecycle (init, tearDown, Db/Connector setup) |
| `Client.Io`        | Client Io multi setup, peer bridge, peer creation     |
| `Client.Bs`        | Client Bs multi setup, peer bridge, peer creation     |

### Custom logger

Implement the `ServerLogger` interface to integrate with any logging framework:

```ts
import type { ServerLogger } from '@rljson/server';

const myLogger: ServerLogger = {
  info(source, message, data?) { /* your logging framework */ },
  warn(source, message, data?) { /* ... */ },
  error(source, message, error?, data?) { /* ... */ },
  traffic(direction, source, event, data?) { /* ... */ },
};
```

## Server options

`ServerOptions` configures production behavior:

```ts
const server = new Server(route, io, bs, {
  logger: new ConsoleLogger(),     // Structured logging (default: NoopLogger)
  refEvictionIntervalMs: 60_000,   // Ref dedup sweep interval (default: 60 s, 0 = disable)
  peerInitTimeoutMs: 30_000,       // Peer handshake timeout (default: 30 s, 0 = disable)
  disableLocalCache: true,         // Pure relay mode — no local Io/Bs cache (default: false)
});
```

| Option                  | Default    | Description                                                                                                                                                                               |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logger`                | NoopLogger | Structured logger for lifecycle, traffic, and error events.                                                                                                                               |
| `refEvictionIntervalMs` | 60 000     | Two-generation sweep interval for multicast ref dedup. Refs older than two intervals are forgotten, preventing unbounded memory growth.                                                   |
| `peerInitTimeoutMs`     | 30 000     | Maximum time `addSocket()` waits for a peer to initialize. Prevents hanging on unresponsive clients.                                                                                      |
| `syncConfig`            | undefined  | Sync protocol configuration (see below). Enables ACK aggregation, gap-fill, and enriched payloads.                                                                                        |
| `refLogSize`            | 1 000      | Maximum number of recent payloads retained in the ref log for gap-fill responses.                                                                                                         |
| `ackTimeoutMs`          | 10 000     | Timeout for collecting individual client ACKs before emitting the aggregated ACK. Falls back to `syncConfig.ackTimeoutMs`.                                                                |
| `disableLocalCache`     | false      | When true, the server skips creating local IoMem/BsMem caches. The server acts as a pure relay, reading data only from connected client peers. Useful for memory-constrained deployments. |
| `onRefArrived`          | undefined  | Hook awaited for every new ref before multicast. Receives `{ tenantId?, route, ref, sourceNodeId }`. If it throws, the ref is dropped (neither archived nor forwarded). See [EventHub archival hook](#eventhub-archival-hook--tenant-keyed-multicast). |

## Client options

`ClientOptions` configures the client:

```ts
const client = new Client(socket, io, bs, route, {
  logger: new ConsoleLogger(),     // Structured logging (default: NoopLogger)
  peerInitTimeoutMs: 30_000,       // Peer handshake timeout (default: 30 s, 0 = disable)
  syncConfig,                      // Sync protocol config (default: undefined)
  clientIdentity: 'my-client-id',  // Stable client identity (default: auto-generated)
});
```

| Option              | Default    | Description                                                                                                                         |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `logger`            | NoopLogger | Structured logger for lifecycle, traffic, and error events.                                                                         |
| `peerInitTimeoutMs` | 30 000     | Maximum time `init()` waits for Io/Bs peers to initialize. Prevents hanging when the server is unreachable. Set to 0 to disable.    |
| `syncConfig`        | undefined  | Sync protocol configuration (see below). Passed through to the Connector for enriched payloads.                                     |
| `clientIdentity`    | undefined  | Stable client identity passed to the Connector. Auto-generated when `syncConfig.includeClientIdentity` is true and this is omitted. |

## Sync protocol

The sync protocol is **opt-in** and backward-compatible. When `syncConfig` is provided to the server (and/or client), the system activates enriched payload forwarding, ACK aggregation, and gap-fill support.

### Enabling sync

```ts
import { Server, Client, ConsoleLogger } from '@rljson/server';
import type { SyncConfig } from '@rljson/server';

const syncConfig: SyncConfig = {
  causalOrdering: true,        // Attach seq numbers, detect gaps, serve gap-fill
  requireAck: true,            // Collect client ACKs, emit aggregated AckPayload
  includeClientIdentity: true, // Attach stable ClientId and timestamp to payloads
  ackTimeoutMs: 5_000,         // Per-ref ACK timeout (default: 10 s)
  maxDedupSetSize: 10_000,     // Max refs per dedup generation (default: 10 000)
  bootstrapHeartbeatMs: 30_000, // Periodic bootstrap heartbeat interval (optional)
};

// Server — enables ref log, ACK aggregation, gap-fill responder
const server = new Server(route, io, bs, { syncConfig });
await server.init();

// Client — passes SyncConfig to the Connector for enriched payloads
const client = new Client(socket, localIo, localBs, route, { syncConfig });
await client.init();
```

### What each flag does

| Flag                    | Server effect                                    | Client (Connector) effect                                    |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `causalOrdering`        | Stores payloads in ref log; responds to gap-fill | Attaches `seq` + `p`; detects gaps; requests gap-fill        |
| `requireAck`            | Collects per-client ACKs; emits aggregated ACK   | Awaits ACK via `sendWithAck()`; emits client ACK             |
| `includeClientIdentity` | Forwards `c` and `t` transparently               | Attaches stable `ClientId` and wall-clock timestamp          |
| `ackTimeoutMs`          | Controls server-side ACK collection timeout      | Controls client-side ACK wait timeout                        |
| `maxDedupSetSize`       | —                                                | Caps dedup set size per generation (two-generation eviction) |
| `bootstrapHeartbeatMs`  | Sends latest ref to all clients periodically     | — (handled server-side only)                                 |

### ACK flow

```text
Client A ──emit(ref)──► Server ──forward──► Client B, C
                        Server ◄──ackClient── Client B
                        Server ◄──ackClient── Client C
Client A ◄──ack──────── Server (ok: true, receivedBy: 2, totalClients: 2)
```

If not all clients ACK within the timeout, the server emits a partial ACK (`ok: false`).

### Gap-fill flow

```text
Client B detects seq gap (expected 6, got 8)
Client B ──gapfill:req──► Server (afterSeq: 5)
Client B ◄──gapfill:res── Server (refs with seq 6, 7)
```

The server maintains a bounded ref log (ring buffer) of recent payloads. When a client detects a sequence gap, it requests the missing refs. The server filters the ref log and responds with matching entries.

### Bootstrap (late joiner support)

When a new client connects, the server immediately sends the **latest known ref** via the `${route}:bootstrap` event. This ensures late-joining clients catch up without waiting for the next write.

```text
Client A ──emit(ref)──► Server          (Server tracks latestRef)
         ... time passes ...
Client B ──addSocket──► Server
Client B ◄──bootstrap── Server          ({ o: '__server__', r: latestRef })
Client B ──db.get(ref)──► Server ► A     (pull data on demand)
```

For additional resilience, configure `bootstrapHeartbeatMs` in `SyncConfig` to periodically broadcast the latest ref to all clients. Each client's dedup pipeline automatically filters refs it has already seen.

```ts
const syncConfig: SyncConfig = {
  bootstrapHeartbeatMs: 30_000, // Send latest ref to all clients every 30s
};
```

**Key details:**

- Bootstrap payload uses origin `'__server__'` (not a real client)
- The Connector's `_processIncoming()` handles dedup automatically
- If no ref has been seen yet (empty server), no bootstrap is sent
- Heartbeat timer calls `.unref()` so it doesn't keep the process alive

### Sync event names

All sync events are route-specific, generated by `syncEvents(route)`:

| Event                  | Direction       | Purpose                                    |
| ---------------------- | --------------- | ------------------------------------------ |
| `${route}`             | Bidirectional   | Ref broadcast (existing)                   |
| `${route}:ack`         | Server → Client | Aggregated delivery acknowledgment         |
| `${route}:ack:client`  | Client → Server | Individual client receipt confirmation     |
| `${route}:gapfill:req` | Client → Server | Request missing refs after detected gap    |
| `${route}:gapfill:res` | Server → Client | Supply missing refs from ref log           |
| `${route}:bootstrap`   | Server → Client | Latest ref on connect / periodic heartbeat |

### Wire format reference

All payloads are JSON objects transmitted via socket events. The two required fields (`o`, `r`) provide backward-compatible self-echo filtering and ref identification. All other fields activate only when the corresponding `SyncConfig` flags are set.

#### ConnectorPayload

The main message transmitted between Connector and Server. Sent on event `${route}`.

| Field   | Type                    | Required | Activated by            | Purpose                                              |
| ------- | ----------------------- | -------- | ----------------------- | ---------------------------------------------------- |
| `r`     | `string`                | ✅        | always                  | The ref (InsertHistory timeId) being announced       |
| `o`     | `string`                | ✅        | always                  | Ephemeral origin of the sender (self-echo filtering) |
| `c`     | `ClientId`              | ❌        | `includeClientIdentity` | Stable client identity (survives reconnections)      |
| `t`     | `number`                | ❌        | `includeClientIdentity` | Client-side wall-clock timestamp (ms since epoch)    |
| `seq`   | `number`                | ❌        | `causalOrdering`        | Monotonic counter per (client, route) pair           |
| `p`     | `InsertHistoryTimeId[]` | ❌        | `causalOrdering`        | Causal predecessor timeIds                           |
| `cksum` | `string`                | ❌        | —                       | Content checksum for ACK verification                |

**Minimal** (backward-compatible, no SyncConfig):

```json
{ "o": "1700000000000:AbCd", "r": "1700000000001:EfGh" }
```

**Fully populated** (all SyncConfig flags enabled):

```json
{
  "o": "1700000000000:AbCd",
  "r": "1700000000001:EfGh",
  "c": "client_V1StGXR8_Z5j",
  "t": 1700000000001,
  "seq": 42,
  "p": ["1700000000000:XyZw"]
}
```

#### AckPayload

Server → Client acknowledgment. Sent on event `${route}:ack` after the server has collected individual client ACKs (or after a timeout).

| Field          | Type      | Required | Purpose                                                       |
| -------------- | --------- | -------- | ------------------------------------------------------------- |
| `r`            | `string`  | ✅        | The ref being acknowledged                                    |
| `ok`           | `boolean` | ✅        | `true` if all clients confirmed; `false` on timeout / partial |
| `receivedBy`   | `number`  | ❌        | Count of clients that confirmed receipt                       |
| `totalClients` | `number`  | ❌        | Total receiver clients at broadcast time                      |

**Full ACK example:**

```json
{ "r": "1700000000001:EfGh", "ok": true, "receivedBy": 3, "totalClients": 3 }
```

**Partial / timed-out ACK:**

```json
{ "r": "1700000000001:EfGh", "ok": false, "receivedBy": 1, "totalClients": 3 }
```

#### GapFillRequest

Client → Server request for missing refs. Sent on event `${route}:gapfill:req` when a Connector detects a sequence gap.

| Field         | Type                  | Required | Purpose                                                |
| ------------- | --------------------- | -------- | ------------------------------------------------------ |
| `route`       | `string`              | ✅        | The route for which refs are missing                   |
| `afterSeq`    | `number`              | ✅        | Last sequence number the client successfully processed |
| `afterTimeId` | `InsertHistoryTimeId` | ❌        | Alternative anchor if sequence numbers are unavailable |

```json
{ "route": "/sharedTree", "afterSeq": 5, "afterTimeId": "1700000000000:AbCd" }
```

#### GapFillResponse

Server → Client response containing missing refs. Sent on event `${route}:gapfill:res`, ordered chronologically (oldest first).

| Field   | Type                 | Required | Purpose                                         |
| ------- | -------------------- | -------- | ----------------------------------------------- |
| `route` | `string`             | ✅        | The route this response corresponds to          |
| `refs`  | `ConnectorPayload[]` | ✅        | Ordered list of missing payloads (oldest first) |

```json
{
  "route": "/sharedTree",
  "refs": [
    { "o": "1700000000000:AbCd", "r": "1700000000006:MnOp", "seq": 6 },
    { "o": "1700000000000:AbCd", "r": "1700000000007:QrSt", "seq": 7 }
  ]
}
```

#### SyncConfig flag → field activation summary

| SyncConfig flag         | Payload fields activated       | Events activated               |
| ----------------------- | ------------------------------ | ------------------------------ |
| _(none / default)_      | `o`, `r`                       | `${route}` only                |
| `causalOrdering`        | + `seq`, `p`                   | + `gapfill:req`, `gapfill:res` |
| `requireAck`            | _(no extra fields)_            | + `ack`, `ack:client`          |
| `includeClientIdentity` | + `c`, `t`                     | _(no extra events)_            |
| All flags combined      | `o`, `r`, `c`, `t`, `seq`, `p` | All 5 events                   |

#### ClientId format

A `ClientId` is a 12-character [nanoid](https://github.com/ai/nanoid) prefixed with `"client_"` for easy identification in logs:

```
client_V1StGXR8_Z5j
```

Unlike a Connector's ephemeral `origin` (which changes on every instantiation), a `ClientId` should be generated once and stored (e.g. in localStorage) so it persists across reconnections.

## EventHub archival hook & tenant-keyed multicast

The server has two additive features to support persistent cross-network relays (e.g. an EventHub running on a cloud platform). Both are zero-cost and backwards compatible when unused.

### `onRefArrived` archival hook

```ts
const server = new Server(route, io, bs, {
  onRefArrived: async ({ tenantId, route, ref, sourceNodeId }) => {
    await db.insert('eh_refs', { tenantId, route, ref, sourceNodeId });
  },
});
```

- Invoked (awaited) for every new ref BEFORE the multicast fan-out.
- Receives `{ tenantId?: string, route: string, ref: string, sourceNodeId: string }`.
  - `tenantId` is the value pinned on `socket.data.tenantId` on the sender's socket by an external auth middleware (e.g. a Socket.IO namespace middleware). `undefined` if none was set.
  - `sourceNodeId` is the server-internal client id of the sender socket.
- **If the hook throws, the ref is dropped** — it is neither archived nor forwarded. This is intentional: archival failure must not silently lose data downstream.

### Tenant-keyed multicast

When sockets have `data.tenantId` set by an external auth middleware, the server scopes multicast to sockets sharing the same `tenantId`:

| Sender's `socket.data.tenantId` | Receivers that get the ref                |
| ------------------------------- | ------------------------------------------ |
| `"t1"`                          | only sockets with `data.tenantId === "t1"` |
| `undefined`                     | only sockets with `data.tenantId === undefined` |

Cross-tenant delivery is impossible by construction. Sockets without `data.tenantId` behave exactly as before, so non-tenant deployments are unaffected.

## Lifecycle management

### Graceful shutdown

```ts
// Server
await server.tearDown();
// Stops eviction timer, removes all listeners, clears clients, closes IoMulti.
console.log(server.isTornDown); // true

// Client
await client.tearDown();
// Calls connector.tearDown() (removes socket listeners),
// closes IoMulti, clears Bs references, resets Db/Connector.
```

### Removing a client

```ts
// Manual removal by clientId
const clientIds = Array.from(server.clients.keys());
await server.removeSocket(clientIds[0]);

// Automatic: clients are removed when their socket emits 'disconnect'
```

## Self-Organizing Node

The `Node` class bridges `@rljson/network` peer discovery with `Server`/`Client` role transitions. Every node runs the same code — on startup it discovers peers, elects a hub, and automatically assumes the correct role.

### Quick start

```ts
import { Node } from '@rljson/server';
import { Route } from '@rljson/rljson';

const node = new Node(
  {
    domain: 'my-app',
    port: 3000,
    route: Route.fromFlat('/sharedTree'),
  },
  {
    createHubTransport: async (port) => { /* start HTTP+Socket.IO server */ },
    createClientTransport: async (hubAddress) => { /* connect to hub */ },
  },
);

await node.start();

// The node auto-discovers peers and assumes a role:
node.on('ready', ({ role, client, server, socket }) => {
  console.log(`Role: ${role}`);          // 'hub' or 'client'
  console.log(`Server: ${server}`);      // Server instance (hub only)
  console.log(`Client: ${client}`);      // Client instance (client only)
  console.log(`Socket: ${socket}`);      // Socket to hub (client only)
});
```

### Data preservation across role transitions

The `Node` owns a single `IoMem`/`BsMem` pair, created once at `start()` and reused across all role transitions. When a role changes (e.g., hub → client → hub), the underlying storage is re-initialized without losing data — `IoMem.close()` only sets `_isOpen = false`, the data in memory is preserved.

This means:
- Data written while hub survives a transition to client
- Data written while client survives a transition to hub
- A re-elected hub still serves all previously stored blobs and tables

### Agent lifecycle

The `createAgent` factory in `NodeDeps` is called on every role transition. The returned `AgentHandle.stop()` is called before the next transition or when the node stops. This is how you wire application-level agents (e.g. `FsAgent`) without creating circular dependencies:

```ts
const node = new Node(config, {
  createHubTransport: ...,
  createClientTransport: ...,
  createAgent: async ({ role, client, server, socket }) => {
    // Wire your agent here — called on every role transition
    const stopSync = await startMySync(role, client, server);
    return { stop: () => stopSync() };
  },
});
```

The Node serializes transitions — a new transition waits for the previous one to complete, ensuring agents are always stopped cleanly.

Errors in `createAgent` or `agentHandle.stop()` are caught and logged — they never crash the node. Similarly, transport factory failures degrade connectivity but leave the node functional locally.

### API

| Property / Method     | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `node.start()`        | Begin peer discovery and role assignment              |
| `node.stop()`         | Tear down current role and stop discovery             |
| `node.role`           | Current role: `'hub'`, `'client'`, or `'unassigned'`  |
| `node.io`             | IoMulti from active Server or Client                  |
| `node.bs`             | BsMulti from active Server or Client                  |
| `node.server`         | Server instance (when hub), else `undefined`          |
| `node.client`         | Client instance (when client), else `undefined`       |
| `node.socket`         | Socket to hub (when client), else `undefined`         |
| `node.topology`       | Current network topology snapshot                     |
| `node.on(event, cb)`  | Subscribe to `'ready'`, `'role-changed'`, `'stopped'` |
| `node.off(event, cb)` | Unsubscribe                                           |

## Architecture Overview

### Pull-Based Reference Architecture

@rljson/server implements a **pull-based architecture** where data is retrieved on-demand using content-addressed references (hashes), not automatically pushed between clients. This fundamentally differs from traditional sync systems:

### Key principle: references flow, data is pulled

```text
Reference Flow: Client A → Server → Client B (broadcast)
Data Flow:      Client A ← Server ← Client B (pulled on query)
```

### How It Works

1. **Client A stores data locally** (writes to priority 1 layer)

   ```ts
   const results = await db.insert(route, [data]);
   const ref = results[0]._hash;
   ```

2. **Client A broadcasts reference** (not the data)

   ```ts
   socket.emit(route.flat, ref);
   ```

3. **Client B receives reference** via multicast

   ```ts
   socket.on(route.flat, (ref) => { /* ... */ });
   ```

4. **Client B queries by reference**

   ```ts
   const result = await db.get(route, { _hash: ref });
   ```

5. **Server automatically pulls from Client A**
   - Client B's query goes to its IoMulti (priority 1: local, not found)
   - Falls back to IoPeer → Server (priority 2)
   - Server's IoMulti cascades: priority 1 (local cache), then priority 2 (IoPeer[Client A])
   - Data flows back: Client A → Server → Client B

**This cascade happens automatically** - no explicit pull operation needed.

### Three Storage Types

#### 1. Io Data (Tables)

- **What**: Relational tables (Cake, Cell, custom content types)
- **Storage**: IoMulti (local Io + IoPeer instances)
- **Query**: `db.get(route, { _hash: ref })`
- **Use Cases**: Structured data, records, metadata

#### 2. Bs Data (Blobs)

- **What**: Binary blobs (files, images, videos)
- **Storage**: BsMulti (local Bs + BsPeer instances)
- **Query**: `bs.get(blobHash)` after getting ref from Io table
- **Use Cases**: Large files, media content
- **Pattern**: Store blob → get hash → store hash in Io table → others query by hash

#### 3. Tree Data (Hierarchical)

- **What**: JSON objects converted to tree structures
- **Storage**: In Io layer with special 'trees' content type
- **Conversion**: `treeFromObject(jsObject)` creates Tree[] array
- **Root**: Last element in array (`trees[trees.length - 1]._hash`)
- **Query**: `db.get(route, { _hash: rootHash })` returns ALL related nodes
- **Use Cases**: Configuration objects, nested data structures

### Client-to-Client Communication

### Pattern: Insert on Client A, Get on Client B

```ts
// Setup: All parties create table definitions
await server.createTables({ withInsertHistory: [tableCfg] });
await clientA.createTables({ withInsertHistory: [tableCfg] });
await clientB.createTables({ withInsertHistory: [tableCfg] });

// Client A: Insert data locally
const result = await dbA.insert(route, [{ name: 'Tesla', model: 'Model S' }]);
const ref = result[0]._hash;

// Client A: Broadcast reference
clientA.socket.emit(route.flat, ref);

// Client B: Listen and pull data
clientB.socket.on(route.flat, async (ref) => {
  // This query automatically cascades through server to Client A
  const data = await dbB.get(route, { _hash: ref });
  console.log(data.rljson.cars._data[0]); // { name: 'Tesla', ... }
});
```

**Server never stores the car data** - it only proxies the query from Client B to Client A.

### Why Pull-Based?

| Aspect              | Pull-Based (@rljson/server)   | Push-Based (Traditional)     |
| ------------------- | ----------------------------- | ---------------------------- |
| **Network Traffic** | Minimal (only refs)           | High (all data replicated)   |
| **Data Freshness**  | Always latest (pull on query) | Can be stale (cached copies) |
| **Storage**         | Single source of truth        | Multiple copies to sync      |
| **Bandwidth**       | Low (on-demand only)          | High (push all changes)      |
| **Offline**         | Works fully offline           | Needs sync when reconnected  |
| **Conflicts**       | None (read from source)       | Requires resolution logic    |

### When to Use @rljson/server

✅ **Good fit:**

- Local-first applications with occasional sharing
- Collaborative tools where users own their data
- Media sharing apps (store locally, share by reference)
- Configuration management (pull config by root hash)
- Document collaboration (pull latest version by ref)

❌ **Not ideal for:**

- Real-time collaborative editing (character-by-character)
- Systems requiring strong consistency guarantees
- Centralized storage where server must have all data
- Automatic background sync without references

### Key Design Principles

1. **Local-First**: All writes go to local storage only
2. **Content-Addressed**: Everything referenced by hash
3. **Reference-Based Discovery**: Need a reference to query data
4. **Automatic Cascade**: IoMulti/BsMulti handle priority traversal
5. **Server as Proxy**: Server doesn't store client data, only routes queries
6. **Pull on Demand**: Data retrieved only when explicitly queried

### Next Steps

- See [README.architecture.md](README.architecture.md) for detailed architecture documentation
- See [test/server.spec.ts](test/server.spec.ts) for comprehensive integration examples
- See [src/example.ts](src/example.ts) for a basic usage example
