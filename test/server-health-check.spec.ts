// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';

// .............................................................................
// Helpers
// .............................................................................

const route = Route.fromFlat('healthTest');

const createServerWithHealth = async (options?: {
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  healthCheckMaxStrikes?: number;
  refEvictionIntervalMs?: number;
}) => {
  const io = new IoMem();
  await io.init();
  const bs = new BsMem();
  const server = new Server(route, io, bs, {
    refEvictionIntervalMs: options?.refEvictionIntervalMs ?? 0,
    healthCheckIntervalMs: options?.healthCheckIntervalMs ?? 5_000,
    healthCheckTimeoutMs: options?.healthCheckTimeoutMs ?? 1_000,
    // These tests are about the pruning mechanics, not about how much slack a
    // client gets first, so they judge on a single round. The production
    // default is 3 — 'should need three missed rounds…' below pins that.
    healthCheckMaxStrikes: options?.healthCheckMaxStrikes ?? 1,
  });
  await server.init();
  return server;
};

const addClientWithHealth = async (server: Server) => {
  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);

  const clientIo = new IoMem();
  await clientIo.init();
  const clientBs = new BsMem();

  const client = new Client(socket, clientIo, clientBs, route);
  await client.init();

  return { client, socket };
};

const addZombieSocket = async (server: Server) => {
  // A raw socket WITHOUT a Client — no health responder registered
  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);
  return socket;
};

/** Lets the check phase run, where the health check reaches its verdict. */
const flushImmediates = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Advances through `count` complete health rounds (interval + timeout). */
const runRounds = async (count: number, intervalMs = 5_000, timeoutMs = 1_000) => {
  for (let i = 0; i < count; i++) {
    vi.advanceTimersByTime(intervalMs);
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await flushImmediates();
  }
};

// .............................................................................
describe('Server health checks', () => {
  let server: Server | undefined;
  let clients: Client[] = [];

  beforeEach(() => {
    // setImmediate stays REAL. The health check deliberately defers its verdict
    // into the check phase so the poll phase can first deliver pongs that are
    // already on the wire; faking it away would test a different algorithm.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const c of clients) {
      await c.tearDown();
    }
    clients = [];
    if (server && !server.isTornDown) {
      await server.tearDown();
    }
    server = undefined;
  });

  // =========================================================================
  describe('ping/pong round-trip', () => {
    it('should keep a healthy client connected', async () => {
      server = await createServerWithHealth();
      const { client } = await addClientWithHealth(server);
      clients.push(client);

      expect(server.clients.size).toBe(1);

      // Advance past health check interval
      vi.advanceTimersByTime(5_000);
      // Allow any async callbacks to settle
      await vi.advanceTimersByTimeAsync(0);

      // Client should still be connected — pong responded synchronously
      expect(server.clients.size).toBe(1);
    });

    it('should prune a zombie socket that does not respond', async () => {
      server = await createServerWithHealth();
      await addZombieSocket(server);

      expect(server.clients.size).toBe(1);

      // Trigger health check
      vi.advanceTimersByTime(5_000);
      // Advance past timeout
      await vi.advanceTimersByTimeAsync(1_000);
      await flushImmediates();

      // Zombie should have been pruned
      expect(server.clients.size).toBe(0);
    });

    it('should prune only the zombie, keeping healthy clients', async () => {
      server = await createServerWithHealth();

      // Add a healthy client
      const { client } = await addClientWithHealth(server);
      clients.push(client);

      // Add a zombie
      await addZombieSocket(server);

      expect(server.clients.size).toBe(2);

      // Trigger health check
      vi.advanceTimersByTime(5_000);
      // Advance past timeout for zombie
      await vi.advanceTimersByTimeAsync(1_000);
      await flushImmediates();

      // Only healthy client remains
      expect(server.clients.size).toBe(1);
    });

    // T2: extends the zombie-pruning coverage above with the
    // ioPeerCount/readableIds accessors (server-peer-lifecycle.spec.ts
    // covers the F1-F4 fixes; this proves the pre-existing prune path
    // they build on still shrinks the cascade and — the part that could
    // not be asserted directly before these accessors existed — that a
    // pruned zombie is never queried by a later served read).
    it('should shrink ioPeerCount/readableIds and never query a pruned zombie again', async () => {
      server = await createServerWithHealth();
      const zombieSocket = await addZombieSocket(server);
      const emitSpy = vi.spyOn(zombieSocket, 'emit');

      const [zombieClientId] = [...server.clients.keys()];
      expect(server.ioPeerCount).toBe(1);
      expect(server.readableIds).toContain(zombieClientId);

      // Trigger health check + timeout
      vi.advanceTimersByTime(5_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await flushImmediates();

      expect(server.clients.size).toBe(0);
      expect(server.ioPeerCount).toBe(0);
      expect(server.readableIds).not.toContain(zombieClientId);

      // A served read must not attempt to reach the pruned zombie's
      // socket — it is gone from the cascade, not merely skipped.
      emitSpy.mockClear();
      await server.io.rawTableCfgs();
      expect(
        emitSpy.mock.calls.some(([event]) => event === 'rawTableCfgs'),
      ).toBe(false);
    });

    it('should need three missed rounds before pruning, by default', async () => {
      // A hub blocks its own event loop on every large serve, and while it is
      // blocked it neither sends pings nor reads the pongs already waiting in
      // its socket buffers. One missed round is therefore weak evidence about
      // the client; the default demands three in a row.
      // Built without the option, so this pins the PRODUCTION default rather
      // than the single-round setting the helper uses.
      const io = new IoMem();
      await io.init();
      server = new Server(route, io, new BsMem(), {
        refEvictionIntervalMs: 0,
        healthCheckIntervalMs: 5_000,
        healthCheckTimeoutMs: 1_000,
      });
      await server.init();
      await addZombieSocket(server);

      await runRounds(2);
      expect(server.clients.size).toBe(1);

      await runRounds(1);
      expect(server.clients.size).toBe(0);
    });
  });

  // =========================================================================
  describe('broadcast sockets', () => {
    it('should skip broadcast sockets during health check', async () => {
      server = await createServerWithHealth();

      // Add a broadcast socket (hub loopback)
      const broadcastSocket = new SocketMock();
      broadcastSocket.connect();
      await server.addBroadcastSocket(broadcastSocket);

      expect(server.clients.size).toBe(1);
      // Verify the client ID starts with 'broadcast_'
      const [clientId] = [...server.clients.keys()];
      expect(clientId).toMatch(/^broadcast_/);

      // Trigger health check + timeout
      vi.advanceTimersByTime(5_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await flushImmediates();

      // Broadcast socket should NOT be pruned
      expect(server.clients.size).toBe(1);
    });
  });

  // =========================================================================
  describe('health check lifecycle', () => {
    it('should not start when intervalMs is 0', async () => {
      server = await createServerWithHealth({ healthCheckIntervalMs: 0 });
      await addZombieSocket(server);

      expect(server.clients.size).toBe(1);

      // Advance way past any interval
      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      // Zombie should still be there — health check disabled
      expect(server.clients.size).toBe(1);
    });

    it('should not start a second timer on second addSocket', async () => {
      server = await createServerWithHealth();
      const { client: c1 } = await addClientWithHealth(server);
      clients.push(c1);
      const { client: c2 } = await addClientWithHealth(server);
      clients.push(c2);

      expect(server.clients.size).toBe(2);

      // Advance — only one timer should fire, both clients alive
      vi.advanceTimersByTime(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(server.clients.size).toBe(2);
    });

    it('should stop on tearDown', async () => {
      server = await createServerWithHealth();
      await addZombieSocket(server);

      // Tear down before check fires
      await server.tearDown();

      // Advance past what would be the health check interval
      vi.advanceTimersByTime(10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      // No errors — timer was cleaned up
      expect(server.isTornDown).toBe(true);
    });
  });

  // =========================================================================
  describe('nonce validation', () => {
    it('should ignore pongs with wrong nonce', async () => {
      server = await createServerWithHealth();

      // Create a socket that responds with wrong nonce
      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      // Register a listener that echoes back with wrong nonce
      socket.on('__health:ping', (payload: { nonce: string }) => {
        socket.emit('__health:pong', { nonce: payload.nonce + '_wrong' });
      });

      expect(server.clients.size).toBe(1);

      // Trigger health check
      vi.advanceTimersByTime(5_000);
      // Advance past timeout
      await vi.advanceTimersByTimeAsync(1_000);
      await flushImmediates();

      // Should be pruned because the correct nonce never arrived
      expect(server.clients.size).toBe(0);
    });

    it('should keep a client whose pong lands after the timeout but before the verdict', async () => {
      // The whole reason the verdict is deferred into the check phase. The
      // timers phase runs first, so on a busy hub the timeout fires while the
      // client's pong is still an unread byte in a socket buffer. Reaching a
      // verdict right there disconnects a client that answered in time.
      server = await createServerWithHealth();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      // Answer nothing yet — just remember what was asked.
      let nonce = '';
      socket.on('__health:ping', (payload: { nonce: string }) => {
        nonce = payload.nonce;
      });

      // Both advances are SYNCHRONOUS on purpose: awaiting would hand the loop
      // back and let the deferred verdict run, which is the very window this
      // test needs to reach into.
      vi.advanceTimersByTime(5_000);
      expect(nonce).not.toBe('');
      vi.advanceTimersByTime(1_000);

      // The timeout has fired; the verdict is queued behind the poll phase.
      // This is the pong arriving in that poll phase.
      socket.emit('__health:pong', { nonce });
      await flushImmediates();

      expect(server.clients.size).toBe(1);
    });
  });
});
