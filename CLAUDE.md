# CLAUDE.md — @rljson/server

Server layer for the RLJSON ecosystem. Depends on `@rljson/rljson`, `@rljson/io`, `@rljson/bs`, `@rljson/db`, `@rljson/network`.

## Hub announcements (ONE-446)

- **The bootstrap payload carries `p`** (the producer's predecessors) and
  `@rljson/fs-agent`'s anti-entropy decides with it who is behind. Never drop
  or rewrite it: without it a client cannot tell "the hub is ahead" from "the
  hub holds a state I left", and guessing wrong resurrects deleted files.
- **The state beacon is not the heartbeat, and must not become one.** It goes
  on `stateBeaconEvent(route)` = `${route}:state`, which the connector does
  not listen to. Never send it on `events.bootstrap` or `events.ref`: a
  periodic announcement that enters the apply path was measured net-harmful.
- **`stateBeaconEvent` comes from `@rljson/db`**, next to the Connector that
  deliberately ignores it. Never spell the event name out here.

## Peer reads (ONE-454)

- **Peers stay inside the hub's slot.** `PeerFirstIo` / `PeerFirstBs` wrap the
  client's Io/Bs to the hub. Never add a peer as a member of its own to the
  client's multi: `IoMulti` reports a hash fetch that found nothing while a
  member failed as an error, so a slow peer would turn "not found" into a
  failure for the caller.
- **A peer read never throws and is bounded.** `PeerReads` answers `undefined`
  for anything a peer cannot give; only the hub's answer reaches the caller.
- **Peers serve their local stores only.** `PeerReadServer` gets the node's own
  Io/Bs, never a multi — a multi would let a question cascade from peer to
  peer. It stays read-only.
- **Only the hub sets `src`.** The hello listener is registered before the
  first await of `addSocket`; a `src` in an incoming payload is overwritten or
  removed.
- **Real Socket.IO in tests.** `test/helpers/peer-mesh.ts` builds a hub and
  clients with their own ports; `test/peer-reads-mesh.spec.ts` measures what
  the hub served. Assert both the data and the hub's count.

## Node (ONE-454)

- **One port, open in every role.** It is the probe target too, so `Node`
  forces `probing.listen: false`. Route clients pass the gate only while the
  node is hub; peers always.
- **The hub service never moves; members do.** A role change stops and starts
  members on the new hub's address — never tear the hub service down on a
  role change.
- **Members serialize their own `start`/`stop`.** `stop` aborts a pending hub
  connection at once. A `WorkerRoute` counts generations: anything an older
  generation brings up is stopped.
- **The store owner serves peers.** Never open a worker's stores a second time
  in the parent: serve them over the worker's channel.
- **Self-check counts other nodes only** (hello node ids); the hub's own
  members connect over loopback.
- **Real nodes in tests:** `test/node-mesh.spec.ts` runs real `Node`s over real
  Socket.IO (`test/helpers/node-network.ts`: `FakeCloud` decides the hub,
  `SocketIoPorts` counts what each port served route clients).

<!-- helix:claude_md:start -->

# gg workflow

This repo is developed ticket by ticket with the `gg` CLI. Follow the
development guide, it tells you when to ask the user and which command
comes next:

@doc/guides/for-ai/ai-dev-guide.md

The steps are also available as skills: `/gg-ticket`, `/gg-commit`,
`/gg-push`, `/gg-review`, `/gg-publish`, `/gg-cleanup`. `/gg` lists them
and says which one comes next.

# rljson additions to the gg workflow

The rules every rljson repo shares:

@doc/guides/rljson-guide.md

- **Reviews** follow `doc/guides/for-ai/rljson-review-guide.md`.
- **Pull requests:** CI on a pull request runs the quick check (`gg one did
  commit`), which passes only for commits made through gg. The full tests run
  on `main` after the merge: watch them after every release.
- **Never merge, publish or delete unasked** — no branch, ticket or ticket
  folder. The owner runs `gg do publish`.

<!-- helix:claude_md:end -->
