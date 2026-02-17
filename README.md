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
