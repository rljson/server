<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Trouble shooting

## Table of contents <!-- omit in toc -->

- [Vscode Windows: Debugging is not working](#vscode-windows-debugging-is-not-working)
- [Test Isolation: Socket.IO event listener accumulation](#test-isolation-socketio-event-listener-accumulation)

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
