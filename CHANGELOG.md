# Changelog

## [Unreleased]

### Added
- `Node` class for self-organizing topology (Epic 5.1–5.4)
- Hub/client role transitions driven by `@rljson/network` peer discovery
- Data preservation across role transitions — `IoMem`/`BsMem` owned by Node, reused across hub↔client switches
- Hub migration: data written as hub survives transition to client and back
- Injectable transport factories (`CreateHubTransport`/`CreateClientTransport`)
- Node events: `ready`, `role-changed`, `stopped`
- 31 behavioral tests covering lifecycle, role transitions, two-node integration, hub migration, and edge cases

## [0.0.1]

Initial commit.
