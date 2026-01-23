<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/server

@rljson/server provides a lightweight client/server layer for Rljson storage. It wires Io (row/table data) and Bs (blob storage) over sockets so clients can read from server storage while still keeping their own local storage.

## What it does (quick overview)

- **Server** hosts Io + Bs and exposes them over sockets.
- **Client** combines local Io/Bs with server Io/Bs into unified interfaces.
- **Sockets** are provided by your runtime (e.g., Socket.IO) and wrapped by `SocketIoBridge`.

## Install

```sh
pnpm add @rljson/server
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
