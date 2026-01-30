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
import { Db } from '@rljson/db';
import { Client, SocketIoBridge } from '@rljson/server';

const socket = socketIoClient('http://localhost:3000', { forceNew: true });

const client = new Client(new SocketIoBridge(socket), new IoMem(), new BsMem());
await client.init();

const db = new Db(client.io!);
// db.get/insert now cascade local ➜ server automatically
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

### Client

```ts
import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';

import { Client } from '@rljson/server';

const localIo = new IoMem();
await localIo.init();
await localIo.isReady();

const localBs = new BsMem();

const client = new Client(new SocketIoBridge(clientSocket), localIo, localBs);
await client.init();

// Unified interfaces
const io = client.io;
const bs = client.bs;
```

## How the layering works

Both client and server use a **multi-layer** approach:

- **Local layer** (priority 1): always read/write to local Io/Bs
- **Peer layer** (priority 2): read-only from server Io/Bs

This is implemented with `IoMulti` and `BsMulti` internally, but the public API exposes them as `Io` and `Bs`.

## API highlights

### Client

- `init()` – builds Io/Bs multis and starts peer bridges
- `ready()` – resolves once Io is ready
- `tearDown()` – closes and clears local state
- `io` – Io interface (multi-layer)
- `bs` – Bs interface (multi-layer)

### Server

- `init()` – initializes server multis
- `ready()` – resolves when Io is ready
- `addSocket(socket)` – registers a client socket and refreshes multis
- `io` – Io interface used by server
- `bs` – Bs interface used by server

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
- Multicast includes `__origin` markers plus a `_multicastedRefs` set to prevent ref echo loops.

## Architecture Overview

### Pull-Based Reference Architecture

@rljson/server implements a **pull-based architecture** where data is retrieved on-demand using content-addressed references (hashes), not automatically pushed between clients. This fundamentally differs from traditional sync systems:

**Key Principle: References flow, data is pulled**

```
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

**Pattern: Insert on Client A, Get on Client B**

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
