<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Architecture

## Overview

The `@rljson/server` package implements a distributed, local-first data architecture that enables multiple clients to share data through a central server while maintaining local storage priority. The system uses a multi-layer approach where local data always takes precedence over server data.

### System map (ASCII)

```text
     [ Client A ]                     [ Client B ]
  ┌────────────────┐               ┌────────────────┐
  │  IoMulti       │               │  IoMulti       │
  │  BsMulti       │               │  BsMulti       │
  │  (local first) │               │  (local first) │
  └───────┬────────┘               └────────┬───────┘
    │  IoPeer/BsPeer (pull from server) │
    │                                   │
  ┌───────▼────────┐   multicast refs   ┌──────▼────────┐
  │    Server      │◄──────────────────►│    Server     │
  │  IoMulti       │                    │  BsMulti      │
  │  (local+peers) │                    │  (local+peers)│
  └───────┬────────┘                    └────────┬──────┘
    │  IoPeerBridge/BsPeerBridge (pull to clients)
    │
  ┌───────▼────────┐
  │ Client C (etc) │
  └────────────────┘
```

- **Refs broadcast**: Clients emit hashes; server multicasts to others.
- **Data pulls**: Readers query by ref; multis cascade local ➜ server ➜ peers.
- **No push of payloads**: Only hashes traverse sockets by default.

### Request flow (pull by reference)

```text
Client B: db.get(route, {_hash: ref})
    ↓ priority walk
1) Local Io (miss)
2) IoPeer → Server IoMulti
       a) Server Local Io (miss?)
       b) IoPeer[Client A] (hit)
    ↑ data flows back A → Server → B
```

### Layer cheat sheet

- **Priority 1**: Local Io/Bs (read+write)
- **Priority 2+**: Peers (read-only), ordered insertion
- **Servers**: IoServer/BsServer expose multis to clients
- **Bridges**: IoPeerBridge/BsPeerBridge let server pull from clients
- **Peers**: IoPeer/BsPeer let clients pull from server

### Socket namespace separation (why)

- **Isolation of channels**: Io (tables) and Bs (blobs) have different payload shapes and backpressure behavior. Separate namespaces prevent cross-talk and let us tune each channel independently.
- **Avoid coupling and event collisions**: Socket.IO treats event names within a namespace; isolating `io` and `bs` avoids accidental handler overlap and makes tracing simpler.
- **Directional clarity**: We split up/down per layer (`ioUp/ioDown`, `bsUp/bsDown`) so bridges can enforce read-only vs. read/write roles and keep the API symmetrical for server and client wiring.
- **Transport flexibility**: In environments that support multiple transports or QoS settings, namespaces can be mapped to different priorities or even different sockets without changing higher-level code.

In default setups you can reuse a single socket for all four channels; the code normalizes that into a bundle. When you need stricter isolation (e.g., large blob streams vs. small Io refs), use distinct namespaces/sockets to avoid head-of-line blocking and to keep logging/metrics per channel.

### Design Pillars

- **Local-first reads, local-only writes**: All mutations stay on the caller; reads walk the priority ladder (local first, then peers through the server).
- **Pull by reference**: References (hashes) travel over the wire; data is fetched on-demand through `IoMulti`/`BsMulti`.
- **Server as proxy/aggregator**: The server multicasts refs and aggregates peers but does not duplicate client data unless explicitly imported there.
- **Unified surface area**: Public APIs expose merged multis (`Client.io/bs`, `Server.io/bs`) so callers never assemble peer lists manually.

## Core Components

### 0. Node (Self-Organizing Orchestrator)

The `Node` class sits above `Server` and `Client`, bridging `@rljson/network` topology events into role transitions. It:

1. **Owns storage**: Creates a single `IoMem`/`BsMem` pair at `start()`, reused across all role transitions. Data survives hub↔client switches because `IoMem.close()` only flips `_isOpen` — the in-memory data is never cleared.
2. **Reacts to topology**: Subscribes to `NetworkManager`'s `role-changed` event. On `'hub'`, tears down any Client and creates a Server. On `'client'`, tears down any Server and creates a Client.
3. **Manages transport**: Uses injectable factories (`CreateHubTransport`/`CreateClientTransport`) to create the transport layer, keeping the Node class transport-agnostic.

```text
┌─────────────────────────────────────────┐
│ Node                                    │
│  ┌──────┐ ┌──────┐                      │
│  │IoMem │ │BsMem │ ← owned by Node      │
│  └──┬───┘ └──┬───┘                      │
│     │        │                           │
│  ┌──▼────────▼───┐  ┌────────────────┐  │
│  │ Server/Client │──│ HubTransport   │  │
│  │ (role-based)  │  │ or ClientSocket│  │
│  └───────────────┘  └────────────────┘  │
│     ▲                                    │
│     │ role-changed                       │
│  ┌──┴───────────┐                        │
│  │NetworkManager│                        │
│  └──────────────┘                        │
└─────────────────────────────────────────┘
```

### 1. Client

The `Client` class provides a unified interface for data access by combining local storage with server storage.

**Key Responsibilities:**

- Manage local Io (data tables) and Bs (blob storage)
- Create bidirectional communication with server
- Merge local and server data layers into single interfaces (IoMulti, BsMulti)

**Data Flow Architecture:**

```text
┌─────────────────────────────────────────┐
│           Client Instance               │
├─────────────────────────────────────────┤
│                                         │
│  ┌───────────────────────────────────┐ │
│  │       IoMulti (Priority)          │ │
│  ├───────────────────────────────────┤ │
│  │ 1. Local Io    (read/write/dump) │ │  ← Priority 1: Local First
│  │ 2. IoPeer      (read only)        │ │  ← Priority 2: Server Read
│  └───────────────────────────────────┘ │
│           ▲              ▲              │
│           │              │              │
│    IoPeerBridge     IoPeer              │
│    (upstream)      (downstream)         │
│           │              │              │
└───────────┼──────────────┼──────────────┘
            │              │
            ▼              ▼
    ┌───────────────────────────┐
    │     Socket to Server      │
    └───────────────────────────┘
```

**Upstream (Client → Server):**

- `IoPeerBridge`: Exposes client's local Io to server for reading
- `BsPeerBridge`: Exposes client's local Bs to server for reading
- Server can pull data from connected clients

**Downstream (Server → Client):**

- `IoPeer`: Allows client to read from server's Io
- `BsPeer`: Allows client to read from server's Bs
- Client can pull data from server

### 2. Server

The `Server` class acts as a central coordination point that:

- Manages connections to multiple clients
- Aggregates data from all clients into unified interfaces
- Broadcasts notifications between clients
- Provides read access to its own local storage

**Relay mode (`disableLocalCache: true`):** When the `disableLocalCache` option is set, the server omits the local IoMem/BsMem from its IoMulti/BsMulti stacks. In this mode the server reads all data exclusively from connected client peers, acting as a pure relay without caching any data locally. This is useful for memory-constrained deployments where the server should not retain copies of client data.

**Data Flow Architecture:**

```text
┌────────────────────────────────────────────────────┐
│              Server Instance                       │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────────────────────────────────┐ │
│  │       IoMulti (Priority)                     │ │
│  ├──────────────────────────────────────────────┤ │
│  │ 1. Local Io         (read/write/dump)       │ │  ← Priority 1
│  │ 2. IoPeer[Client A] (read only)             │ │  ← Priority 2
│  │ 3. IoPeer[Client B] (read only)             │ │  ← Priority 2
│  │ 4. IoPeer[Client C] (read only)             │ │  ← Priority 2
│  └──────────────────────────────────────────────┘ │
│           │                                        │
│           ▼                                        │
│  ┌──────────────────────────────────────────────┐ │
│  │          IoServer                            │ │
│  │  (Exposes IoMulti to clients)                │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  Connected Clients:                                │
│  ┌──────────────────────────────────────────────┐ │
│  │ Client A → IoPeer A, Socket A                │ │
│  │ Client B → IoPeer B, Socket B                │ │
│  │ Client C → IoPeer C, Socket C                │ │
│  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

**Lifecycle and controls:**

- `addSocket()` attaches a stable `__clientId`, builds `IoPeer`/`BsPeer` (guarded by `peerInitTimeoutMs`), queues them, rebuilds multis once, refreshes servers in a batch, and registers an auto-disconnect handler.
- `removeSocket(clientId)` removes a client’s listeners and peers, rebuilds multis, and re-establishes multicast for remaining clients.
- `tearDown()` stops the eviction timer, removes all listeners/disconnect handlers, clears clients, closes IoMulti, and resets all internal state.
- Multicast uses `__origin` markers plus a **two-generation ref set** (`_multicastedRefsCurrent` / `_multicastedRefsPrevious`) to avoid echo loops and duplicate ref forwarding. Refs are evicted on a configurable interval (`refEvictionIntervalMs`, default 60 s) to prevent unbounded memory growth.
- Pending sockets are refreshed together so multiple joins trigger a single multi rebuild.
- All lifecycle events, errors, and traffic are logged via the injected `ServerLogger` (defaults to `NoopLogger`).
- Traffic logging captures inbound refs from clients and outbound multicasts with `from`/`to` client IDs.
- Disconnected sockets are auto-detected: a `'disconnect'` listener triggers `removeSocket()`, cleaning up dead peers and rebuilding multis.

### 3. Multi-Layer Priority System

Both Client and Server use `IoMulti` and `BsMulti` to merge multiple data sources:

**Priority Rules:**

- **Priority 1 (Local)**: Read/Write/Dump enabled, always checked first
- **Priority 2 (Peer)**: Read-only, fallback when data not found locally

**Example Flow:**

```text
Client A reads table "cars":
1. Check local IoMem (priority 1) → Not found
2. Check IoPeer to server (priority 2) → Found!
3. Return data from server

Client A writes to table "cars":
1. Write to local IoMem (priority 1) only
2. IoPeer is read-only, no write to server
3. Local data now takes precedence
```

### 4. BaseNode (shared helper)

`Client` and `Server` both extend `BaseNode`, which enforces an open local Io and provides Db helpers:

- `createTables()` seeds table definitions on the local Io (optionally with insert history).
- `import()` loads rljson payloads into the local Db, keeping writes local-first.
- A guard throws if the supplied local Io is not initialized/open, catching miswired setups early.

## Synchronization Patterns

### Overview: Pull-Based Reference Architecture

The system implements a **pull-based architecture** where data is retrieved on-demand using references (hashes). No data is automatically pushed between clients or to the server. Instead:

1. **Client stores data locally** (write to priority 1 layer)
2. **Client exposes data via IoPeerBridge/BsPeerBridge** (read-only upstream)
3. **Other clients retrieve data by reference** (pull from priority 2 layer)
4. **Server acts as proxy**, pulling from connected clients on-demand

### Key principle: references flow, data is pulled

```text
Reference Flow: Client A → Server → Client B
Data Flow:     Client A ← Server ← Client B (pulled on-demand)
```

### IoMulti and BsMulti Architecture

Both Client and Server use multi-layer storage to aggregate data from multiple sources:

**IoMulti (Data Tables):**

- Priority 1: Local Io (read/write/dump)
- Priority 2+: IoPeer instances (read-only) to other participants

**BsMulti (Blob Storage):**

- Priority 1: Local Bs (read/write)
- Priority 2+: BsPeer instances (read-only) to other blob stores

**Multi-Layer Query Flow:**

```text
Query: db.get(route, { _hash: "abc123" })
       │
       ▼
1. Check Local Io (priority 1)
   ├─ Found? → Return data ✓
   └─ Not found? → Continue to priority 2
       │
       ▼
2. Check IoPeer to Server (priority 2)
   ├─ Server checks its Local Io (priority 1)
   │  └─ Not found? → Continue to server's priority 2
   │      │
   │      ▼
   │  Server queries IoPeer[Client A] (server priority 2)
   │      └─ Found in Client A! → Return via chain ✓
   │
   └─ Data flows back: Client A → Server → Client B
```

## Data Synchronization Patterns

### Pattern 1: Io Data Sync (Regular Tables)

Io data represents regular relational tables (Cake, Cell, etc.) stored in the Io layer.

#### Scenario: Client A inserts data, Client B retrieves it

```text
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│Client A  │                  │  Server  │                  │Client B  │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                             │
     │ 1. db.insert(route, data)   │                             │
     ├──────────────────────►      │                             │
     │    (writes to local Io)     │                             │
     │    Returns: [{ _hash }]     │                             │
     │                             │                             │
     │ 2. Broadcast ref to server  │                             │
     │    socket.emit(route, ref)  │                             │
     ├────────────────────────────►│                             │
     │                             │                             │
     │                             │ 3. Multicast ref to Client B│
     │                             ├─────────────────────────────►
     │                             │    (with __origin marker)   │
     │                             │                             │
     │                             │ 4. Client B: db.get(route, {_hash: ref})
     │                             │◄────────────────────────────┤
     │                             │                             │
     │ 5. Server pulls from A      │                             │
     │◄────────────────────────────┤                             │
     │    via IoPeerBridge         │                             │
     │                             │                             │
     │────────────────────────────►│                             │
     │    Returns data             │                             │
     │                             │                             │
     │                             │ 6. Server returns to B      │
     │                             ├─────────────────────────────►
     │                             │    Data pulled through chain│
```

**Implementation Details:**

```typescript
// Client A: Insert data (writes locally)
const insertResults = await dbA.insert(route, [cakeData]);
const dataRef = insertResults[0]._hash;

// Client A: Broadcast reference (optional for notifications)
clientA.socket.emit(route.flat, dataRef);

// Client B: Retrieve by reference (pulls data)
const result = await dbB.get(route, { _hash: dataRef });
// Query flows: Client B → IoPeer → Server → IoPeer[A] → Client A
// Data returns: Client A → Server → Client B
```

**Key Characteristics:**

- ✅ Data never leaves Client A's local storage
- ✅ Server does NOT store the data (acts as proxy)
- ✅ Client B pulls data on-demand via reference
- ✅ Works for: Cake tables, Cell tables, custom content types

### Pattern 2: Bs Data Sync (Blob Storage)

Bs data represents binary blobs (files, images, videos) stored in the Bs layer.

#### Scenario: Client A stores blob, Client B retrieves it

```text
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│Client A  │                  │  Server  │                  │Client B  │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                             │
     │ 1. bsA.put(blob)            │                             │
     ├──────────────────────►      │                             │
     │    (writes to local Bs)     │                             │
     │    Returns: blobHash        │                             │
     │                             │                             │
     │ 2. Store ref in Io table    │                             │
     │    db.insert(route, {       │                             │
     │      blobRef: blobHash      │                             │
     │    })                       │                             │
     │                             │                             │
     │ 3. Client B gets ref        │                             │
     │                             │◄────────────────────────────┤
     │                             │    db.get(route, where)     │
     │                             │                             │
     │                             │ 4. Client B pulls blob      │
     │                             │◄────────────────────────────┤
     │                             │    bsB.get(blobHash)        │
     │                             │                             │
     │ 5. Server pulls from A      │                             │
     │◄────────────────────────────┤                             │
     │    via BsPeerBridge         │                             │
     │                             │                             │
     │────────────────────────────►│                             │
     │    Returns blob data        │                             │
     │                             │                             │
     │                             │ 6. Server returns to B      │
     │                             ├─────────────────────────────►
     │                             │    Blob data pulled through │
```

**Implementation Details:**

```typescript
// Client A: Store blob locally
const blobData = new Uint8Array([1, 2, 3, 4]);
const blobHash = await clientA.bs!.put(blobData);

// Client A: Store blob reference in Io table
await dbA.insert(route, [{
  fileName: "example.bin",
  blobRef: blobHash,
  size: blobData.length
}]);

// Client B: Retrieve blob reference from Io
const fileRecord = await dbB.get(route, { fileName: "example.bin" });
const blobHash = fileRecord.rljson.files._data[0].blobRef;

// Client B: Pull blob by hash
const blob = await clientB.bs!.get(blobHash);
// Query flows: Client B → BsPeer → Server → BsPeer[A] → Client A
// Blob returns: Client A → Server → Client B
```

**Key Characteristics:**

- ✅ Blobs stored separately from Io tables
- ✅ Io tables store blob references (hashes)
- ✅ BsMulti provides same priority-based access as IoMulti
- ✅ Hot-swapping: Downloaded blobs can be cached locally
- ✅ Deduplication: Same blob hash = same content

### Pattern 3: Tree Data Sync (Tree Structures)

Tree data represents hierarchical structures converted from JavaScript objects using `treeFromObject()`.

#### Scenario: Client A creates tree, Client B retrieves entire tree

```text
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│Client A  │                  │  Server  │                  │Client B  │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                             │
     │ 1. Create tree from object  │                             │
     │    const trees =            │                             │
     │      treeFromObject({       │                             │
     │        x: 10,               │                             │
     │        y: { z: 20 }         │                             │
     │      })                     │                             │
     │                             │                             │
     │ 2. Import tree data         │                             │
     │    clientA.import({         │                             │
     │      treeName: {            │                             │
     │        _type: 'trees',      │                             │
     │        _data: trees         │                             │
     │      }                      │                             │
     │    })                       │                             │
     │    (writes to local Io)     │                             │
     │                             │                             │
     │ 3. Get root ref             │                             │
     │    rootHash =               │                             │
     │      trees[trees.length-1]  │                             │
     │        ._hash               │                             │
     │                             │                             │
     │ 4. Broadcast root ref       │                             │
     │    socket.emit(route,       │                             │
     │      rootHash)              │                             │
     ├────────────────────────────►│                             │
     │                             │                             │
     │                             │ 5. Multicast to Client B    │
     │                             ├─────────────────────────────►
     │                             │                             │
     │                             │ 6. Client B: get by root    │
     │                             │◄────────────────────────────┤
     │                             │    db.get(route, {          │
     │                             │      _hash: rootHash        │
     │                             │    })                       │
     │                             │                             │
     │ 7. Server pulls tree nodes  │                             │
     │◄────────────────────────────┤                             │
     │    via IoPeerBridge         │                             │
     │    (pulls ALL related nodes)│                             │
     │                             │                             │
     │────────────────────────────►│                             │
     │    Returns tree nodes[]     │                             │
     │                             │                             │
     │                             │ 8. Server returns to B      │
     │                             ├─────────────────────────────►
     │                             │    Full tree structure      │
```

**Implementation Details:**

```typescript
// Client A: Convert object to tree structure
const treeObject = { x: 10, y: { z: 20 } };
const trees = treeFromObject(treeObject);
// trees = [
//   { id: 'x', meta: { value: 10 }, ... },
//   { id: 'y', isParent: true, children: ['z'], ... },
//   { id: 'z', meta: { value: 20 }, ... },
//   { id: 'root', isParent: true, children: ['x', 'y'], ... }  ← Root
// ]

// Client A: Get root reference (last tree in array)
const rootTreeHash = trees[trees.length - 1]._hash;

// Client A: Create trees table and import
const treeCfg = createTreesTableCfg('myTree');
await clientA.createTables({ withInsertHistory: [treeCfg] });
await clientA.import({
  myTree: { _type: 'trees', _data: trees }
});

// Client B: Setup same table definition
await clientB.createTables({ withInsertHistory: [treeCfg] });

// Client B: Pull entire tree by root hash
const result = await dbB.get(Route.fromFlat('myTree'), {
  _hash: rootTreeHash
});
// Returns ALL tree nodes (x, y, z, root) in result.rljson.myTree._data
// Query flows: Client B → IoPeer → Server → IoPeer[A] → Client A
// Tree flows: Client A → Server → Client B (all related nodes)
```

**Key Characteristics:**

- ✅ `treeFromObject()` converts JS objects to Tree[] arrays
- ✅ Root node is LAST element in trees array
- ✅ Query by root hash returns ALL related nodes (entire subtree)
- ✅ Trees table uses `createTreesTableCfg()` configuration
- ✅ Pull pattern: Server does NOT store tree (proxies to Client A)
- ✅ Efficient: Single query retrieves complete tree structure

**Tree Structure Details:**

```typescript
interface Tree {
  id: string;              // Unique identifier
  _hash: string;           // Content hash (reference)
  isParent?: boolean;      // Has children?
  children?: string[];     // Child node IDs
  meta?: {
    value?: any;           // Leaf value (for non-parent nodes)
    [key: string]: any;    // Additional metadata
  };
}
```

## Data Distribution Patterns

### Pattern 1: Client-to-Client via Server (Pull Pattern)

When Client A creates/modifies data that other clients need to access:

```text
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│Client A  │                  │  Server  │                  │Client B  │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                             │
     │ 1. insert(route, data)      │                             │
     ├──────────────────────►      │                             │
     │    (writes to local Io)     │                             │
     │                             │                             │
     │                             │ 2. Client B get(route, ref) │
     │                             │◄────────────────────────────┤
     │                             │    (via IoPeer)             │
     │                             │                             │
     │ 3. Server's IoMulti cascade │                             │
     │◄────────────────────────────┤                             │
     │    (automatic via priority) │                             │
     │    Reads from Client A      │                             │
     │    via IoPeerBridge         │                             │
     │                             │                             │
     │────────────────────────────►│                             │
     │    Returns data             │                             │
     │                             │                             │
     │                             ├─────────────────────────────►
     │                             │ 4. Data flows back to B     │
     │                             │    (Client A → Server → B)  │
```text

### Pattern 2: Notification Broadcasting

For real-time updates, the server multicasts references between clients:

```text
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│Client A  │                  │  Server  │                  │Client B  │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                             │
     │ 1. socket.emit(route, ref)  │                             │
     ├──────────────────────►      │                             │
     │                             │                             │
     │                             │ 2. Multicast to others      │
     │                             │    (adds __origin marker)   │
     │                             ├─────────────────────────────►
     │                             │                             │
     │                             │                             │
     │                             │ 3. Client B receives ref    │
     │                             │    and can fetch data       │
```text

**Multicast Logic:**

- Server listens on route for all connected clients
- When Client A emits on route, server forwards to all OTHER clients
- `__origin` marker prevents infinite loops
- Deduplication via `_multicastedRefs` Set
- **References are broadcast, data is pulled on-demand**

### Pattern 4: Server as Data Proxy (Not Storage)

Important: The server does NOT store client data by default.

**Incorrect Pattern (Push):**

```typescript
// ❌ WRONG: Server should NOT import client data
await server.import(clientData);  // Server becomes storage layer
```

**Correct Pattern (Pull):**

```typescript
// ✅ CORRECT: Client stores, server proxies on-demand
await clientA.import(data);       // Client A stores locally
// Server reads from Client A via IoPeerBridge only when Client B requests it
const result = await dbB.get(route, { _hash: ref });
// Server pulls from Client A dynamically
```

**When Server SHOULD Store Data:**

- ✅ Shared configuration data all clients need
- ✅ Reference data (lookup tables, constants)
- ✅ Bootstrapping data for new clients
- ❌ NOT for client-specific operational data

### Pattern 5: Reference Passing Between Clients

The most efficient pattern for distributed access:

```text
1. Client A creates data → Returns references (hashes)
2. Client A broadcasts references (not data) to server
3. Server multicasts references to Client B
4. Client B receives references
5. Client B queries by reference when needed
6. Server pulls actual data from Client A on-demand
7. Data flows: Client A → Server → Client B (only when requested)
```

**Benefits:**

- ✅ Minimal network traffic (only refs broadcast)
- ✅ Data pulled only when needed
- ✅ No stale data (always pull latest from source)
- ✅ Source of truth remains at Client A

## Complete Integration Examples

### Example 1: Io Data (Cake Table) - Complete Flow

```typescript
// Setup: All parties create table definitions
const cakeCfg = {
  name: 'carCake',
  cfg: { _type: 'cake', columns: ['brand', 'model'] }
};

await server.createTables({ withInsertHistory: [cakeCfg] });
await clientA.createTables({ withInsertHistory: [cakeCfg] });
await clientB.createTables({ withInsertHistory: [cakeCfg] });

// When route was passed to Client constructor, Db is available directly:
const dbA = clientA.db!;
const dbB = clientB.db!;

// Client A: Insert data (stores locally)
const route = Route.fromFlat('carCake');
const insertResult = await dbA.insert(route, [{
  brand: 'Tesla',
  model: 'Model S'
}]);
const carRef = insertResult[0]._hash;

// Client A: Broadcast reference
clientA.socket.emit(route.flat, carRef);

// Client B: Listen for reference
clientB.socket.on(route.flat, async (ref) => {
  // Pull data by reference
  const result = await dbB.get(route, { _hash: ref });
  console.log(result.rljson.carCake._data[0]);
  // { brand: 'Tesla', model: 'Model S', _hash: '...' }
});
```

### Example 2: Bs Data (Blob) - Complete Flow

```typescript
// Setup: All parties initialize blob storage (BsMulti)
// Already done via client.init() and server.init()

// Client A: Store blob locally
const imageData = new Uint8Array([255, 216, 255, ...]);  // JPEG bytes
const blobHash = await clientA.bs!.put(imageData);

// Client A: Store blob reference in Io table
const fileRoute = Route.fromFlat('images');
const insertResult = await dbA.insert(fileRoute, [{
  fileName: 'photo.jpg',
  blobRef: blobHash,
  size: imageData.length,
  mimeType: 'image/jpeg'
}]);
const fileRecordRef = insertResult[0]._hash;

// Client A: Broadcast file record reference
clientA.socket.emit(fileRoute.flat, fileRecordRef);

// Client B: Receive reference and pull blob
clientB.socket.on(fileRoute.flat, async (ref) => {
  // 1. Get file metadata from Io
  const fileRecord = await dbB.get(fileRoute, { _hash: ref });
  const blobHash = fileRecord.rljson.images._data[0].blobRef;

  // 2. Pull actual blob from Bs
  const imageData = await clientB.bs!.get(blobHash);
  console.log(`Downloaded ${imageData.length} bytes`);

  // 3. Optional: Cache locally (hot-swap)
  await clientB.bs!.put(imageData);  // Now in Client B's local Bs
});
```

### Example 3: Tree Data - Complete Flow

```typescript
// Setup: Create trees table configuration
const treeCfg = createTreesTableCfg('projectTree');
await server.createTables({ withInsertHistory: [treeCfg] });
await clientA.createTables({ withInsertHistory: [treeCfg] });
await clientB.createTables({ withInsertHistory: [treeCfg] });

// When route was passed to Client constructor, Db is available directly:
const dbA = clientA.db!;
const dbB = clientB.db!;

// Client A: Create tree from object
const projectData = {
  name: 'MyApp',
  version: '1.0.0',
  dependencies: {
    react: '18.0.0',
    typescript: '5.0.0'
  },
  scripts: {
    build: 'tsc',
    test: 'vitest'
  }
};

const trees = treeFromObject(projectData);
const rootHash = trees[trees.length - 1]._hash;

// Client A: Import tree (stores locally)
await clientA.import({
  projectTree: { _type: 'trees', _data: trees }
});

// Client A: Broadcast root reference
const treeRoute = Route.fromFlat('projectTree');
clientA.socket.emit(treeRoute.flat, rootHash);

// Client B: Receive reference and pull entire tree
clientB.socket.on(treeRoute.flat, async (rootRef) => {
  // Pull entire tree by root hash
  const result = await dbB.get(treeRoute, { _hash: rootRef });
  const treeNodes = result.rljson.projectTree._data;

  console.log(`Received ${treeNodes.length} tree nodes`);
  // Includes: name, version, dependencies, react, typescript,
  //           scripts, build, test, root

  // Navigate tree structure
  const root = treeNodes.find(n => n._hash === rootRef);
  console.log(`Root children: ${root.children}`);
});
```

## Performance Considerations

### IoMulti/BsMulti Query Optimization

**Priority-based short-circuiting:**

```typescript
// Query: get(route, where)
// 1. Check priority 1 (local) → Found? Return immediately ✓
// 2. Check priority 2 (IoPeer) → Found? Return immediately ✓
// 3. Check priority 3 (additional peers) → And so on...
```

**Best Practices:**

- ✅ Cache frequently accessed data locally (hot-swapping)
- ✅ Use specific queries ({ _hash: ref }) instead of broad scans
- ✅ Minimize priority 2+ queries by pre-loading critical data
- ❌ Avoid scanning large tables without where clauses

### Blob Storage Optimization

**Deduplication:**

- Same content = same hash
- Multiple references to same blob = single storage

**Streaming (Future):**

- Large blobs can be streamed via `getStream()`
- Partial retrieval via `get(hash, range)`

### Tree Query Optimization

**Single Query for Entire Tree:**

- Query root hash returns ALL related nodes
- No need for recursive queries
- Efficient for hierarchical data

**Tree Caching:**

```typescript
// After first pull, tree is available locally
await dbB.get(route, { _hash: rootRef });  // Pulls from Client A
await dbB.get(route, { _hash: rootRef });  // Reads from local cache
```

## Consistency Model (Db layer)

The `Db` class operates on top of `IoMulti`, providing distributed data access:

```text
┌────────────────────────────────────────┐
│          Client A                      │
│  ┌──────────────────────────────────┐ │
│  │  Db (dbA)                        │ │
│  │    ↓                             │ │
│  │  IoMulti                         │ │
│  │    ├─ Local Io (priority 1)     │ │
│  │    └─ IoPeer → Server (priority 2)│ │
│  └──────────────────────────────────┘ │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│          Server                        │
│  ┌──────────────────────────────────┐ │
│  │  IoMulti                         │ │
│  │    ├─ Local Io (priority 1)     │ │
│  │    ├─ IoPeer[A] (priority 2)    │ │
│  │    └─ IoPeer[B] (priority 2)    │ │
│  └──────────────────────────────────┘ │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│          Client B                      │
│  ┌──────────────────────────────────┐ │
│  │  Db (dbB)                        │ │
│  │    ↓                             │ │
│  │  IoMulti                         │ │
│  │    ├─ Local Io (priority 1)     │ │
│  │    └─ IoPeer → Server (priority 2)│ │
│  └──────────────────────────────────┘ │
└────────────────────────────────────────┘
```

**Operations:**

**db.insert(route, data):**

- Writes to local Io only (via IoMulti's priority 1 layer)
- Returns `InsertHistoryRow[]` with refs
- Data remains local until server reads it via IoPeerBridge

**db.get(route, where):**

- Searches local Io first (priority 1)
- Falls back to server (priority 2) if not found locally
- Server's IoMulti includes data from all connected clients
- Returns `Container` with rljson, tree, and cell data

## Consistency Model

### Local-First Guarantees

1. **Writes are local**: All write operations go to local storage only
2. **Reads are prioritized**: Local data is always checked first
3. **Server as fallback**: Server data accessed when not available locally
4. **Hot-swapping**: When data is read from server, it can be cached locally

### Data Visibility and Access Patterns

**What Client A can see:**

- ✅ Its own local Io data (priority 1)
- ✅ Its own local Bs blobs (priority 1)
- ✅ Server's local data (priority 2) if server has any
- ✅ Other clients' data via server (priority 2) - **pulled automatically on-demand**
  - When Client A queries by reference, server checks its cache (priority 1)
  - If not in server cache, server automatically pulls from Client B (priority 2)
  - This happens transparently through IoMulti's priority system

**What Client A cannot see:**

- ❌ Data without a valid reference (hash) to query by
- ❌ Data from disconnected clients (no IoPeer connection)
- ❌ Data that hasn't been imported/inserted anywhere in the network

**What Server can see:**

- ✅ Its own local Io data (priority 1)
- ✅ All connected clients' data (priority 2+) via IoPeerBridge
- ✅ **Server acts as aggregator** - sees union of all client data

### Data Flow Guarantees

**Io Data (Tables):**

- Writes: Always to local Io only
- Reads: Priority 1 (local) → Priority 2 (server/peers)
- Consistency: Eventually consistent via pull
- References: Content-addressed by hash

**Bs Data (Blobs):**

- Writes: Always to local Bs only
- Reads: Priority 1 (local) → Priority 2 (server/peers)
- Deduplication: Same hash = same content
- References: Content-addressed by hash

**Tree Data:**

- Storage: In Io layer as special 'trees' type
- Queries: By root hash → returns all related nodes
- Structure: Hierarchical parent-child relationships
- References: Root hash identifies entire tree

### Synchronization

**No automatic sync**: The system does not automatically replicate writes between clients.

**Pull-based sync patterns:**

1. **Via References**: Client A broadcasts ref → Client B pulls data by ref
2. **Via Server Proxy**: Client B queries → Server pulls from Client A on-demand
3. **Via IoPeerBridge/BsPeerBridge**: Exposing local storage to server for reading

**Key Differences from Push-based Sync:**

| Aspect          | Pull-based (rljson)         | Push-based (traditional)  |
| --------------- | --------------------------- | ------------------------- |
| Data movement   | On-demand via query         | Automatic replication     |
| Network traffic | Minimal (refs only)         | High (all data)           |
| Staleness       | Always fresh (pulls latest) | Possible (stale replicas) |
| Storage         | Single source of truth      | Multiple copies           |
| Bandwidth       | Low (pull when needed)      | High (push all changes)   |
| Consistency     | Eventually consistent       | Strong/eventual           |

## Architecture Comparison: Io vs Bs vs Tree

| Feature            | Io Data                   | Bs Data                   | Tree Data                 |
| ------------------ | ------------------------- | ------------------------- | ------------------------- |
| **Storage Layer**  | IoMulti (Io + IoPeer[])   | BsMulti (Bs + BsPeer[])   | IoMulti (special type)    |
| **Data Type**      | Tables, rows, columns     | Binary blobs              | Hierarchical nodes        |
| **Content Type**   | 'cake', 'cell', custom    | Raw bytes                 | 'trees'                   |
| **Query Method**   | `db.get(route, where)`    | `bs.get(hash)`            | `db.get(route, {_hash})`  |
| **Reference Type** | Row hash (_hash)          | Blob hash                 | Root node hash (_hash)    |
| **Write Target**   | Priority 1 (local Io)     | Priority 1 (local Bs)     | Priority 1 (local Io)     |
| **Read Priority**  | 1: Local, 2: Server+Peers | 1: Local, 2: Server+Peers | 1: Local, 2: Server+Peers |
| **Deduplication**  | By content hash           | By content hash           | By content hash           |
| **Query Result**   | Matching rows             | Single blob               | All related nodes         |
| **Table Config**   | `createTableCfg()`        | N/A                       | `createTreesTableCfg()`   |
| **Sync Pattern**   | Pull by ref               | Pull by ref               | Pull by root ref          |
| **Use Cases**      | Structured data           | Files, images, videos     | JSON objects, configs     |

## Real-World Scenarios

### Scenario 1: Collaborative Document Editing

```text
Team working on shared documents:
- Each client has local document storage (Io data)
- Document edits create new versions (content-addressed)
- Editor broadcasts document ref to team
- Team members pull latest version by ref on-demand
- Server never stores documents (only proxies)
- Tree data represents document structure (headings, sections)
```

### Scenario 2: Media Sharing Application

```text
Users sharing photos/videos:
- Photos stored in local Bs (Client A)
- Photo metadata in Io table (title, tags, blobRef)
- User A uploads → stores locally, broadcasts ref
- User B sees notification → pulls blob by ref
- User B caches blob locally (hot-swap)
- Server proxies blob from A to B (doesn't store)
```

### Scenario 3: Configuration Management

```text
Application configuration distribution:
- Config as JSON object → converted to Tree
- Config stored on admin client (Client A)
- Root ref broadcast to all clients
- Clients pull config tree by root ref on-demand
- Changes create new tree → new root ref
- Clients update by pulling new root ref
```

## Lifecycle

### Client Initialization

```typescript
// With route: Db and Connector are created automatically during init()
const client = new Client(socket, localIo, localBs, route);
await client.init(); // Sets up IoMulti, BsMulti, Db, and Connector
await client.ready(); // Waits for IoMulti to be ready

const db = client.db!;             // Db wrapping IoMulti
const connector = client.connector!; // Connector wired to route + socket

// With logging:
import { BufferedLogger } from '@rljson/server';
const logger = new BufferedLogger();
const client = new Client(socket, localIo, localBs, route, { logger });
await client.init();
// logger.entries now contains lifecycle events:
//   Constructing client, Initializing client, Setting up Io multi,
//   Io peer bridge started, Io multi ready, Setting up Bs multi, ...

// Without route (legacy): only IoMulti and BsMulti are created
const client = new Client(socket, localIo, localBs);
await client.init();
const db = new Db(client.io!); // Caller creates Db manually
```

### Server Initialization

```typescript
const server = new Server(route, serverIo, serverBs);
await server.init(); // Sets up IoMulti and BsMulti

// When clients connect:
await server.addSocket(socket); // Rebuilds multis with new IoPeer
```

### Adding a Client

When `server.addSocket(socket)` is called:

1. **Create IoPeer/BsPeer**: Establish connection to client
2. **Queue peers**: Add to `_ios` and `_bss` arrays
3. **Rebuild multis**: Recreate IoMulti/BsMulti with all peers
4. **Refresh servers**: Update IoServer/BsServer with new multis
5. **Setup multicast**: Register listeners for route broadcasting

Each step is logged at `info` level. Errors in any step are logged at `error` level and re-thrown.

### Teardown

```typescript
await client.tearDown(); // Closes IoMulti, clears Db, Connector, and all state
```

## Testing Patterns

### Distributed Get Pattern (Server Data)

```typescript
// Use case: Server has shared reference data
await server.createTables({ withInsertHistory: tableCfgs });
await server.import(exampleData);

// Clients need table definitions
await clientA.createTables({ withInsertHistory: tableCfgs });
await clientB.createTables({ withInsertHistory: tableCfgs });

// Client A can read server data (priority 2)
const dataFromA = await dbA.get(route, where);

// Client B can read the same server data (priority 2)
const dataFromB = await dbB.get(route, where);

// Both see identical data from server
```

### Client-to-Client Pattern (Pull via Server)

```typescript
// Setup: All parties need table definitions
await server.createTables({ withInsertHistory: tableCfgs });
await clientA.createTables({ withInsertHistory: tableCfgs });
await clientB.createTables({ withInsertHistory: tableCfgs });

// Client A creates local data
await clientA.import(localData);

// Client A sees its local data (priority 1)
const dataFromA = await dbA.get(route, where);
const ref = dataFromA.rljson.tableName._data[0]._hash;

// Client B CAN see Client A's data by reference
// Server's IoMulti automatically cascades to Client A
const dataFromB = await dbB.get(route, { _hash: ref });
// Query: Client B → IoPeer → Server IoMulti → IoPeer[A] → Client A
// Data flows back: Client A → Server → Client B

expect(dataFromB.rljson.tableName._data[0]._hash).toBe(ref);
```

### Local-Only Pattern (No Reference Query)

```typescript
// Client A creates local data
await clientA.createTables({ withInsertHistory: tableCfgs });
await clientA.import(localData);

// Client B has no reference to query by
await clientB.createTables({ withInsertHistory: tableCfgs });

// Client B cannot discover Client A's data without a reference
// Broad queries won't automatically sync all data
await expect(dbB.get(route, {})).rejects.toThrow();
// Or returns empty result if table exists but no data locally
```

## Key Design Decisions

### Why Local-First?

- **Offline capability**: Clients work without server connection
- **Low latency**: Read/write operations are fast (no network)
- **Data ownership**: Clients control their own data
- **Flexible sync**: Sync on-demand, not automatically

### Why Read-Only Peers?

- **Simplicity**: No conflict resolution needed
- **Safety**: Prevents accidental cross-client writes
- **Clear semantics**: Local writes, remote reads
- **Scalability**: Server doesn't manage write transactions

### Why Priority-Based Multi?

- **Predictable behavior**: Always check local first
- **Flexibility**: Add multiple data sources
- **Performance**: Short-circuit on local hits
- **Composability**: Easy to add new layers

## Related Packages

- **@rljson/io**: Io, IoMulti, IoPeer, IoPeerBridge, IoServer
- **@rljson/bs**: Bs, BsMulti, BsPeer, BsPeerBridge, BsServer
- **@rljson/db**: Db operations (insert, get, join, etc.)
- **@rljson/rljson**: Data structures (Route, TableCfg, etc.)

## Observability

### Structured Logging

Both `Server` and `Client` accept an optional `ServerLogger` via their options parameter. The logger is called at every significant lifecycle point, error boundary, and network traffic event.

**Logger interface:**

```typescript
interface ServerLogger {
  info(source: string, message: string, data?: Record<string, unknown>): void;
  warn(source: string, message: string, data?: Record<string, unknown>): void;
  error(source: string, message: string, error?: unknown, data?: Record<string, unknown>): void;
  traffic(direction: 'in' | 'out', source: string, event: string, data?: Record<string, unknown>): void;
}
```

**What gets logged:**

| Phase           | Source                    | Level   | Events                                      |
| --------------- | ------------------------- | ------- | ------------------------------------------- |
| Construction    | `Server` / `Client`       | info    | Route, options                              |
| Initialization  | `Server` / `Client`       | info    | Start, success                              |
| Io/Bs setup     | `Client.Io` / `Client.Bs` | info    | Multi creation, peer bridges, peer creation |
| Peer creation   | `Server.Io` / `Server.Bs` | info    | Per-client peer setup                       |
| Multi rebuild   | `Server`                  | info    | Peer count, rebuild success                 |
| Server refresh  | `Server`                  | info    | Pending socket count, completion            |
| Multicast in    | `Server.Multicast`        | traffic | Ref, sender clientId                        |
| Multicast out   | `Server.Multicast`        | traffic | Ref, sender clientId, receiver clientId     |
| Duplicate ref   | `Server.Multicast`        | warn    | Ref, sender                                 |
| Loop prevention | `Server.Multicast`        | warn    | Ref, origin, sender                         |
| Any failure     | Various                   | error   | Error object, context data                  |
| TearDown        | `Client`                  | info    | Start, completion                           |
| Socket removal  | `Server`                  | info    | Removing, rebuilding multis, removal done   |
| Server tearDown | `Server`                  | info    | Tearing down, timer stop, completion        |
| Disconnect      | `Server`                  | info    | Client disconnected, auto-removal           |

**Built-in implementations:**

- `NoopLogger` — zero overhead, used by default
- `ConsoleLogger` — `console.log`/`warn`/`error` with formatted prefixes
- `BufferedLogger` — in-memory array with `byLevel()`, `bySource()`, `clear()` helpers
- `FilteredLogger` — wraps another logger, filters by `levels` and/or `sources`

**Production recommendation:** Use `FilteredLogger` wrapping your framework's logger, filtering to `['error', 'warn']` levels. Enable `traffic` level only for debugging multicast issues.

## Sync Protocol (opt-in hardening)

The server supports an optional sync protocol that provides production-grade guarantees on top of the basic multicast mechanism. Enabled by passing `syncConfig` in `ServerOptions`.

### Architecture

```text
     Client A (Connector)                Server                    Client B (Connector)
     ────────────────────                ──────                    ────────────────────
     send(ref) →
       enriches payload:
       {o, r, c?, t?, seq?, p?}
                            ────emit(route)───►
                                                ┌─ append to ref log
                                                ├─ setup ACK collection
                                                ├─ forward to Client B  ──emit(route)──►
                                                │                                        processIncoming()
                                                │                                        ◄──ackClient──
                                                ├─ collect ackClient
                                                ├─ emit aggregated ACK
                            ◄───ack────────────┘
```

### Wire format reference

All sync payloads are JSON objects. The types are defined in `@rljson/rljson` (Layer 0) and used unchanged across all layers.

#### ConnectorPayload (bidirectional, event: `${route}`)

The main wire message between Connector and Server. Two required fields provide backward compatibility; optional fields activate based on `SyncConfig` flags.

| Field   | Type                    | Required | Activated by            | Purpose                                              |
| ------- | ----------------------- | -------- | ----------------------- | ---------------------------------------------------- |
| `r`     | `string`                | ✅        | always                  | The ref (InsertHistory timeId) being announced       |
| `o`     | `string`                | ✅        | always                  | Ephemeral origin of the sender (self-echo filtering) |
| `c`     | `ClientId`              | ❌        | `includeClientIdentity` | Stable client identity (survives reconnections)      |
| `t`     | `number`                | ❌        | `includeClientIdentity` | Client-side wall-clock timestamp (ms since epoch)    |
| `seq`   | `number`                | ❌        | `causalOrdering`        | Monotonic counter per (client, route) pair           |
| `p`     | `InsertHistoryTimeId[]` | ❌        | `causalOrdering`        | Causal predecessor timeIds                           |
| `cksum` | `string`                | ❌        | —                       | Content checksum for ACK verification                |

Minimal payload (no SyncConfig): `{ o: "...", r: "..." }`

Full payload (all flags): `{ o, r, c, t, seq, p }`

#### AckPayload (Server → Client, event: `${route}:ack`)

| Field          | Type      | Required | Purpose                                                       |
| -------------- | --------- | -------- | ------------------------------------------------------------- |
| `r`            | `string`  | ✅        | The ref being acknowledged                                    |
| `ok`           | `boolean` | ✅        | `true` if all clients confirmed; `false` on timeout / partial |
| `receivedBy`   | `number`  | ❌        | Count of clients that confirmed receipt                       |
| `totalClients` | `number`  | ❌        | Total receiver clients at broadcast time                      |

#### GapFillRequest (Client → Server, event: `${route}:gapfill:req`)

| Field         | Type                  | Required | Purpose                                    |
| ------------- | --------------------- | -------- | ------------------------------------------ |
| `route`       | `string`              | ✅        | The route for which refs are missing       |
| `afterSeq`    | `number`              | ✅        | Last seq the client successfully processed |
| `afterTimeId` | `InsertHistoryTimeId` | ❌        | Alternative anchor if seq unavailable      |

#### GapFillResponse (Server → Client, event: `${route}:gapfill:res`)

| Field   | Type                 | Required | Purpose                                         |
| ------- | -------------------- | -------- | ----------------------------------------------- |
| `route` | `string`             | ✅        | The route this response corresponds to          |
| `refs`  | `ConnectorPayload[]` | ✅        | Ordered list of missing payloads (oldest first) |

#### Event name derivation

All event names are route-specific, derived by `syncEvents(route)` from `@rljson/rljson`:

| Property     | Derived name             | Direction       |
| ------------ | ------------------------ | --------------- |
| `ref`        | `"${route}"`             | Bidirectional   |
| `ack`        | `"${route}:ack"`         | Server → Client |
| `ackClient`  | `"${route}:ack:client"`  | Client → Server |
| `gapFillReq` | `"${route}:gapfill:req"` | Client → Server |
| `gapFillRes` | `"${route}:gapfill:res"` | Server → Client |
| `bootstrap`  | `"${route}:bootstrap"`   | Server → Client |

#### SyncConfig flag activation matrix

| SyncConfig flag         | Payload fields activated       | Events activated               |
| ----------------------- | ------------------------------ | ------------------------------ |
| _(none / default)_      | `o`, `r`                       | `${route}` only                |
| `causalOrdering`        | + `seq`, `p`                   | + `gapfill:req`, `gapfill:res` |
| `requireAck`            | _(no extra fields)_            | + `ack`, `ack:client`          |
| `includeClientIdentity` | + `c`, `t`                     | _(no extra events)_            |
| All flags combined      | `o`, `r`, `c`, `t`, `seq`, `p` | All 6 events                   |
| `maxDedupSetSize`       | _(Connector-only setting)_     | _(no events)_                  |
| `bootstrapHeartbeatMs`  | _(no extra fields)_            | + `bootstrap` (periodic)       |

#### ClientId format

A `ClientId` is a `"client_"` prefix followed by a 12-character nanoid (e.g. `client_V1StGXR8_Z5j`). Unlike the ephemeral `origin` (which changes per Connector instantiation), a `ClientId` persists across reconnections and should be stored by the application.

### Ref log (ring buffer)

The server maintains a bounded ring buffer of recent `ConnectorPayload` entries. When the buffer exceeds `refLogSize` (default: 1000), the oldest entry is dropped. The ref log serves as the data source for gap-fill responses.

### ACK aggregation

When `requireAck` is enabled:

1. **Before broadcast**: The server registers `ackClient` listeners on all receiver sockets.
2. **During broadcast**: Payloads are forwarded to all other clients.
3. **After broadcast**: The server waits for individual `ackClient` events from each receiver.
4. **On completion or timeout**: An aggregated `AckPayload` is emitted back to the sender on the `ack` event.

The ACK includes `receivedBy` (count of confirmed receivers) and `totalClients` (total receiver count). If all receivers confirm, `ok: true`; if timeout fires first, `ok: false`.

### Gap-fill responder

When `causalOrdering` is enabled:

1. The server listens for `gapfill:req` events from each client.
2. On request, it filters the ref log for payloads with `seq > afterSeq`.
3. The matching payloads are sent back on the `gapfill:res` event.

### Bootstrap (late joiner support)

The server tracks the most recent ref seen on `_latestRef` (updated in `_multicastRefs` on every broadcast). This enables two mechanisms:

**Immediate bootstrap on connect:**

When `addSocket()` completes, the server calls `_sendBootstrap(ioDown)` which emits a `ConnectorPayload` with `o: '__server__'` and `r: _latestRef` on the `${route}:bootstrap` event. The Connector's `_registerBootstrapHandler()` feeds this into `_processIncoming()`, triggering listen callbacks and applying dedup automatically.

**Periodic heartbeat (optional):**

When `bootstrapHeartbeatMs > 0` in `SyncConfig`, `_startBootstrapHeartbeat()` starts an interval timer that calls `_broadcastBootstrapHeartbeat()` to emit the latest ref to all connected clients. The timer calls `.unref()` so it doesn't keep the process alive. `tearDown()` clears the timer.

```text
   addSocket(socketB)
       │
       ├─ setup IoPeer, BsPeer, multicast listeners
       ├─ _sendBootstrap(ioDown)  →  emit(bootstrap, { o: '__server__', r: latestRef })
       └─ _startBootstrapHeartbeat()  →  setInterval(broadcastBootstrapHeartbeat, ms)
```

**Design decisions:**

- `_events` is always initialized (even without `syncConfig`) because bootstrap needs event names regardless of sync config
- Bootstrap uses a dedicated event (`${route}:bootstrap`) rather than the main `${route}` event to avoid interfering with multicast payload processing
- The `'__server__'` origin ensures no Connector treats bootstrap as a self-echo

### Event registration lifecycle

- `_multicastRefs()` sets up all sync listeners (ref, ackClient, gapFillReq) per client.
- `_removeAllListeners()` tears down all sync listeners (route, ackClient, gapFillReq).
- `addSocket()` and `removeSocket()` trigger rebuild of all listeners.
- `tearDown()` clears the ref log in addition to existing cleanup.

### Client-side integration

The `Client` class accepts `syncConfig`, `clientIdentity`, and `peerInitTimeoutMs` in `ClientOptions`.

- **`peerInitTimeoutMs`** (default 30 s, 0 = disable): Guards `IoPeer` and `BsPeer` initialization during `init()` with a `Promise.race`-based timeout. If the server is unreachable, `init()` rejects cleanly instead of hanging indefinitely. Uses the same `_withTimeout()` pattern as the server.
- **`syncConfig`** + **`clientIdentity`**: When a route is provided, these are passed through to the `Connector` constructor, activating enriched payloads (sequence numbers, causal ordering, client identity) on the client side.
- **`tearDown()`**: Calls `connector.tearDown()` to remove all socket listeners before clearing internal references. This prevents leaked listeners that would keep the socket alive after the client is disposed.

## Future Considerations

- **Write replication**: Automatically sync writes to server
- **Conflict resolution**: Handle concurrent writes
- **Change detection**: Notify on data changes
- **Batch operations**: Optimize bulk transfers
- **Compression**: Reduce network payload size
- **Authentication hooks**: Verify client identity in `addSocket()`
- **Connection health introspection**: Query connected client state, connection time, etc.
- **Backpressure / rate limiting**: Protect against misbehaving clients flooding multicast
- **Metrics / counters**: Numeric counters (connected clients, refs/sec) for monitoring dashboards
