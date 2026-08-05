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
  refEvictionIntervalMs?: number;
}) => {
  const io = new IoMem();
  await io.init();
  const bs = new BsMem();
  const server = new Server(route, io, bs, {
    refEvictionIntervalMs: options?.refEvictionIntervalMs ?? 0,
    healthCheckIntervalMs: options?.healthCheckIntervalMs ?? 5_000,
    healthCheckTimeoutMs: options?.healthCheckTimeoutMs ?? 1_000,
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

// .............................................................................
describe('Server health checks', () => {
  let server: Server | undefined;
  let clients: Client[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
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

      // Should be pruned because the correct nonce never arrived
      expect(server.clients.size).toBe(0);
    });
  });
});
