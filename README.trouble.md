<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Trouble shooting

## Table of contents <!-- omit in toc -->

- [Split-Brain: Clients not reconnecting on hub change (fixed in v0.0.14)](#split-brain-clients-not-reconnecting-on-hub-change-fixed-in-v0014)
- [Vscode Windows: Debugging is not working](#vscode-windows-debugging-is-not-working)
- [Test Isolation: Socket.IO event listener accumulation](#test-isolation-socketio-event-listener-accumulation)
- [Refs not delivered across split namespaces (fixed in v0.0.36)](#refs-not-delivered-across-split-namespaces-fixed-in-v0036)

## Split-Brain: Clients not reconnecting on hub change (fixed in v0.0.14)

Date: 2026-03-20

**Problem:**

In a 4-node deployment, two nodes simultaneously acted as hub (split-brain). Clients stayed connected to the old hub while a new hub was elected. File sync stopped working because the hub had no real clients.

**Symptoms:**

- E2E Report 17: 23/41 passed, 18 failed
- Two nodes reporting `role=hub` simultaneously
- Files written by one hub never appearing on clients
- File counts diverging between nodes (hub accumulating files, clients stuck)

**Root Cause:**

Two bugs in the `Node` class:

1. **Missing `hub-changed` listener**: Node only subscribed to `role-changed` from NetworkManager. When the hub changed but the node's role stayed `client`, the `role-changed` handler skipped (same role). Clients never reconnected to the new hub.

2. **No socket disconnect on teardown**: `_tearDownCurrentRole()` set `_clientSocket = undefined` without calling `disconnect()`. The orphaned Socket.IO connection kept auto-reconnecting to the old hub (especially with the `socket.connect()` reconnect fix from v0.0.13).

**Solution (v0.0.14):**

1. Added `_onHubChanged` listener that tears down and reconnects when hub changes while role stays `client`
2. Added explicit `socket.disconnect()` call in `_tearDownCurrentRole()` before clearing the reference

**Validation:**

- E2E Reports 18 & 19: **38/41 passed, 0 failures** on 4-node test lab

## Vscode Windows: Debugging is not working

Date: 2025-03-08

⚠️ IMPORTANT: On Windows, please check out the repo on drive C. There is a bug
in the VS Code Vitest extension (v1.14.4), which prevents test debugging from
working: <https://github.com/vitest-dev/vscode/issues/548> Please check from
time to time if the issue has been fixed and remove this note once it is
resolved.

## Test Isolation: Socket.IO event listener accumulation

Date: 2025-01-28

**Problem:**

When running multiple tests that use Socket.IO connections, tests pass individually but fail when run together. This is caused by event listeners from previous tests remaining active on persistent socket instances.

**Symptoms:**

- Individual tests pass: ✅
- All tests together fail: ❌
- Error messages like "received 0 instead of expected number of nodes"
- Unexpected behavior when sockets receive messages from previous tests

**Root Cause:**

Socket.IO sockets persist across tests in the `beforeAll` setup. When `SocketIoBridge` instances are created in `beforeEach`, old event listeners accumulate on the underlying sockets, causing interference between tests.

**Solution:**

Clear all event listeners in `beforeEach` before creating new bridges:

```typescript
beforeEach(async () => {
  // Remove all event listeners from previous test to prevent interference
  serverSockets.forEach((socket) => socket.removeAllListeners());
  clientSockets.forEach((socket) => socket.removeAllListeners());

  // Now proceed with test setup...
  server = new Server(route, serverIo, serverBs);
  await server.init();
  // ... rest of setup
});
```

**Why This Works:**

- `removeAllListeners()` clears accumulated event handlers
- Each test starts with clean sockets
- No interference from previous test's `SocketIoBridge` instances
- Maintains socket connections established in `beforeAll`

**Alternative Approaches Considered:**

1. ❌ `tearDown()` in `afterEach`: Caused hook timeouts
2. ❌ Creating new socket connections per test: Too slow, defeats purpose of `beforeAll`
3. ✅ Clear listeners while reusing connections: Fast and reliable

## Refs not delivered across split namespaces (fixed in v0.0.36)

Date: 2026-06-08

**Problem:**

When a client connects over four genuinely separate Socket.IO namespaces
(`ioUp`/`ioDown`/`bsUp`/`bsDown`) — as a tenant-aware EventHub does — a ref
written by client A was never received by client B, even though both clients
connected, authenticated, and initialised successfully.

**Symptoms:**

- `connector.send(ref)` on A completes without error.
- B's `connector.listen(cb)` callback never fires.
- A raw listener on B's `ioDown` socket DOES receive the `${route}` event, but
  B's `Connector` (bound to `ioUp`) stays silent.
- All single-socket unit/integration tests pass, masking the bug.

**Root Cause:**

The `Connector` uses a single `Socket` for both directions — it `emit`s
upstream and `.on`-listens downstream. `Client` bound that socket to the
bundle's `ioUp`. But `Server._multicastRefs` fans forwarded refs and bootstrap
out on each receiver's **`ioDown`** namespace. With a single multiplexed socket
(`ioUp === ioDown`) the channels coincide, so every existing test passed; with
split namespaces the Connector listened on `ioUp` and missed all server →
client traffic.

**Solution (v0.0.36):**

`Client._setupDbAndConnector` now wires the Connector through
`connectorDuplexSocket(ioUp, ioDown)`, which routes `emit` upstream and
`on`/`off`/`removeAllListeners` downstream. The adapter returns the socket
unchanged when `ioUp === ioDown`, leaving single-socket setups untouched.
A real split-namespace round-trip test (`test/connector-split-namespace.spec.ts`)
locks in the behaviour.
