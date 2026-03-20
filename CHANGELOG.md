# Changelog

## [Unreleased]

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
