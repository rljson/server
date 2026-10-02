# Changelog

## [0.0.72]

### The client gets the hub's brake (ONE-441)

**What now works that did not.** A `Client` bounds what serving the hub costs
its own machine. The hub pulls from a client's local stores through the
upstream bridges — `IoPeerBridge` on `ioUp`, `BsPeerBridge` on `bsUp` — and
both are now wrapped with `withBackpressure` and share **one** `ServeGate`, the
same construction the hub uses on `ioDown`/`bsDown`. New `ClientOptions`:
`maxConcurrentServes` (default 4, the hub's own) and `backpressure`. A wait is
logged on `Client.Io` / `Client.Bs` as `Hub throttled`, with what was serving
and what was queued.

**What was wrong.** The hub has bounded its serving since ten concurrent
backfills peaked it at ~10 GB; the client had nothing. Every request the hub
sent up ran at once, each materialising its rows in a workstation's heap. That
was harmless only as long as the hub did not pull hard — and the hub's own gate
is exactly what lets it pull harder. Without this, a relieved hub would have
moved its peak onto a workplace.

**Measured** in `test/client-backpressure.spec.ts`: ten simultaneous hub reads
against a client with a limit of 2 peak at 2 and are all answered; the control
without a real limit peaks at 10. Without the change, three of the four tests
fail.

**No change in `@rljson/io` or `@rljson/bs`.** The bridges stay as they are;
the brake sits in front of them, in this package, where the hub's already is.

## [0.0.71]

### Changed

- **`@rljson/db` lifted to 0.0.48**, which bounds the RATE of gap-fill requests
  where 0.0.70 bounded their SIZE. Each half is sufficient on its own to survive
  the storm that killed the cloud EventHub; together a reconnect costs a couple
  of 25 kB messages instead of 858 x 150 kB.
- **Every `@rljson` dependency is mirrored in `pnpm.overrides`.** Only `rljson`
  was pinned there, so a dependent's own exact pin decided what actually got
  installed for everything else — the arrangement that left `@rljson/fs-agent`
  serving blobs through a nested `bs` 0.0.26 while its manifest said 0.0.27.
  `@rljson/dna-rljson` is deliberately NOT in the list: an override pins one
  exact version for the whole tree, which is right for packages that pin each
  other exactly and wrong for a `^`-ranged dev tool whose range the manifest
  leaves open on purpose.

## [0.0.70]

### A gap-fill response no longer arrives as one oversized packet

On 2026-09-29 the cloud EventHub died nine minutes after a deploy: **858
oversized `JSON.stringify` calls in 18.2 seconds**, heap to 990 MB,
`FATAL ERROR: Reached heap limit`, inside socket.io's **outbound** packet
encoder. It began four seconds after a second hub joined a route that already
had one.

The serving gate added in 0.0.69 cannot reach that: `withBackpressure` wraps
`socket.on` — inbound handlers — and this is `socket.emit` going out. So the
size of what is emitted is the only thing left to bound.

`_registerGapFillListener` answered every request with `_refLog.filter(...)` in a
single message. Measured, not assumed:

| ref log | predecessors/entry | wire size |
| --- | --- | --- |
| 500 | 0 | 62 kB |
| 1000 | 0 | **124 kB** |
| 500 | 1 | **77 kB** |
| 1000 | 1 | **154 kB** |
| 1000 | 3 | **203 kB** |

1000 is `refLogSize`'s default, so that is the steady state of any long-lived
hub, not a pathological case. socket.io stringifies every packet once per
receiver, so one answer of that size is a 150 kB string built synchronously on
the event loop.

- **Added** `GAP_FILL_BATCH_SIZE` (200). The whole answer still goes out; no
  single `emit` carries all of it. One message now weighs 25-30 kB.
- Batching rather than paging, deliberately: the receiver reads `res.refs` and
  processes each entry independently, so N smaller responses are already
  indistinguishable from one large one to every client that exists. A cursor
  would need both ends to agree; a plain cap would silently drop the newest
  refs, which is the mistake the EventHub's own replay documents having made.
- An empty log still gets exactly one answer, so a client that asked is never
  left waiting on a message that never comes.

The tests measure the wire bytes of each packet rather than trusting the shape,
and assert that every ref still arrives in sequence — losing the newest half of
a hub's history is the failure mode a bound invites.

### Still open, in `@rljson/db`

`_registerGapFillHandler` calls `_processIncoming(p)` for every ref in a
response, with `fromBootstrap` defaulting to false — so a gap-filled ref is
treated as a live announcement and can itself trigger another `gapFillReq`. The
bootstrap handler passes `fromBootstrap = true` specifically to prevent that;
gap-fill never did. That is the amplifier which turned a handful of reconnect
gaps into 858 responses, and it is a separate change in a separate package.

## [0.0.69]

### Blob serving is bounded

`_refreshServers` gated `ioDown` with `withBackpressure` and handed `bsDown` to
the blob server raw, two lines apart. Rows were bounded from the day the gate
existed; blobs — the channel that moves the largest payloads in the system — went
out beside them with no limit at all, and the asymmetry is invisible at a glance
because both lines sit together.

Measured on the cloud EventHub on 2026-09-29: 136 MB resident while idle,
1 194 MB nine seconds later, of which 487 MB was ArrayBuffers that never fell.
The process died of `Ineffective mark-compacts`, full collections reclaiming
1.5 MB of 1020 MB — none of it garbage, all of it work in flight.

- `bsDown` is now wrapped with `withBackpressure`, sharing the **same**
  `ServeGate` as `ioDown`. One gate deliberately: the memory that kills a hub is
  the total of what it is materialising, and rows and blobs come out of one heap,
  so `maxConcurrentServes` now means what it says — how many serves this process
  runs at once, of any kind.
- Throttling on the blob channel logs as `Server.Bs`.
- `removeSocket` unregisters the wrapper rather than the raw socket, so the blob
  CRUD listeners actually come off — the same bug the io side had.

Pairs with `@rljson/bs` 0.0.27, where a blob read becomes a series of ranged
pulls. Each pull passes this gate on its own, so the bound is now chunk-sized
rather than blob-sized.

## [Unreleased]

### Changed

- **Dependencies lifted to the current releases**: `db` 0.0.47 (which carries
  the gap-fill fix), `io` 0.0.80, `rljson` 0.0.83 — the set the newest `io`
  itself declares. The `rljson` override moves with the dependency, so `bs`,
  which still declares 0.0.81, does not put a second copy in the tree.

### Changed

- **`@rljson` dependencies lifted to the published releases**: `db` 0.0.45,
  `io` 0.0.79, `network` 0.0.23. `db` and `io` move together — `db` declares
  `io` itself, so lifting only one leaves a package running against a version
  it never declared. `network` 0.0.20 was simply stale: the consuming app has
  been pinning 0.0.23 through its overrides for some time, so the server's own
  declaration described a stack nobody ran.

### Added
- **The heartbeat carries the ancestry of the state it announces** (`p`, ONE-446).
  The server records the predecessors a ref's producer declared, alongside its
  origin, and every bootstrap / heartbeat announcement includes them when there
  were any. A client that lost a message needs them to tell "the hub is ahead
  of me" from "the hub holds a state I already left" — refs are content hashes,
  so both look like a ref it has seen before. Cleared when a later ref declares
  none; never set for a seeded ref, whose announcement is unchanged.
- **State beacon** (`stateBeaconMs`, event name `stateBeaconEvent` from `@rljson/db`, ONE-446). The hub's
  state, sent periodically on `${route}:state` — an event the connector does
  not listen to, so nothing is applied because of it. It lets a client notice
  that it disagrees with the hub for good, without the side effects that made
  a periodic bootstrap heartbeat net-harmful. Off by default.

## [0.0.14] — 2026-03-20

### Fixed
- **Split-brain prevention**: Node now listens to `hub-changed` events from NetworkManager. When the hub changes but the node's role stays `client`, the node tears down the old connection and reconnects to the new hub. Previously, only `role-changed` was handled, so clients would remain connected to the old (stale) hub — causing split-brain where two nodes simultaneously acted as hub.
- **Socket disconnect on teardown**: `_tearDownCurrentRole()` now calls `disconnect()` on the client socket before clearing the reference. Previously, setting `_clientSocket = undefined` without disconnecting left orphaned Socket.IO connections that kept auto-reconnecting to the old hub.

### Added
- 3 new tests for hub-changed reconnect behavior (49 total Node tests)

### Validated
- E2E Reports 18 & 19: **38/41 passed, 0 failures, 3 skipped** (suite timeout) on 4-node Windows test lab (Node v24.14.0)
- Previous Report 17 showed 23/41 passed with split-brain (two simultaneous hubs) — now fully resolved

## [0.0.13]

### Added
- `Node` class for self-organizing topology (Epic 5.1–5.5)
- Hub/client role transitions driven by `@rljson/network` peer discovery
- Data preservation across role transitions — `IoMem`/`BsMem` owned by Node, reused across hub↔client switches
- Hub migration: data written as hub survives transition to client and back
- Injectable transport factories (`CreateHubTransport`/`CreateClientTransport`)
- Node events: `ready`, `role-changed`, `stopped`
- Agent lifecycle via `createAgent` factory — called on every `ready`, stopped on next transition or `node.stop()`
- `ReadyContext` passed to `ready` event with `role`, `client`, `server`, `socket`
- `node.socket` getter for client-side socket access
- Serialized role transitions — prevents race conditions between teardown and setup
- Error resilience at system boundaries: `createAgent`, `agentHandle.stop()`, and transport factories catch and log errors without crashing the node
- 46 behavioral tests covering lifecycle, role transitions, two-node integration, hub migration, agent lifecycle, error resilience, and edge cases

## [0.0.1]

Initial commit.
