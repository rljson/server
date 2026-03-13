# Changelog

## [Unreleased]

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
