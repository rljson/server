// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client';
import { BufferedLogger } from '../src/logger';
import { Server } from '../src/server';

// .............................................................................
describe('Server production readiness', () => {
  // .........................................................................
  describe('_multicastedRefs eviction', () => {
    it('should forget refs after two eviction intervals', async () => {
      vi.useFakeTimers();

      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('evictionTest');

      // 100ms eviction interval for fast testing
      const server = new Server(route, io, bs, {
        logger,
        refEvictionIntervalMs: 100,
      });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();
      await server.addSocket(socketA);
      await server.addSocket(socketB);

      // Emit a ref — it should be tracked
      socketA.emit(route.flat, { r: 'evict-me' });

      // Same ref again immediately → should be suppressed
      logger.clear();
      socketA.emit(route.flat, { r: 'evict-me' });
      expect(
        logger.byLevel('warn').some((e) => e.data?.['ref'] === 'evict-me'),
      ).toBe(true);

      // Advance past one interval — ref is now in "previous" generation
      vi.advanceTimersByTime(110);

      // Still suppressed (in previous generation)
      logger.clear();
      socketA.emit(route.flat, { r: 'evict-me' });
      expect(
        logger.byLevel('warn').some((e) => e.data?.['ref'] === 'evict-me'),
      ).toBe(true);

      // Advance past second interval — ref should be evicted
      vi.advanceTimersByTime(110);

      // Now the ref should be treated as new (traffic logged, not warned)
      logger.clear();
      socketA.emit(route.flat, { r: 'evict-me' });
      const traffic = logger.byLevel('traffic');
      expect(
        traffic.some(
          (e) => e.direction === 'in' && e.data?.['ref'] === 'evict-me',
        ),
      ).toBe(true);

      await server.tearDown();
      vi.useRealTimers();
    });

    it('should allow disabling eviction with interval 0', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('noEviction');

      const server = new Server(route, io, bs, {
        refEvictionIntervalMs: 0,
      });
      await server.init();

      // No interval running — just verify server works
      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);

      await server.tearDown();
    });
  });

  // .........................................................................
  describe('Server.tearDown()', () => {
    it('should clean up all state', async () => {
      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('tearDownTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();
      await server.addSocket(socketA);
      await server.addSocket(socketB);

      expect(server.clients.size).toBe(2);
      expect(server.isTornDown).toBe(false);

      logger.clear();
      await server.tearDown();

      expect(server.clients.size).toBe(0);
      expect(server.isTornDown).toBe(true);

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Tearing down server')).toBe(true);
      expect(
        infos.some((e) => e.message === 'Server torn down successfully'),
      ).toBe(true);
    });

    it('should stop the eviction timer', async () => {
      vi.useFakeTimers();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('tearDownTimer');

      const server = new Server(route, io, bs, {
        refEvictionIntervalMs: 100,
      });
      await server.init();

      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      await server.tearDown();

      expect(clearSpy).toHaveBeenCalled();

      clearSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  // .........................................................................
  describe('removeSocket()', () => {
    it('should remove a client and rebuild multis', async () => {
      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('removeTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();
      await server.addSocket(socketA);
      await server.addSocket(socketB);

      expect(server.clients.size).toBe(2);
      const clientIds = Array.from(server.clients.keys());

      logger.clear();
      await server.removeSocket(clientIds[0]);

      expect(server.clients.size).toBe(1);
      expect(server.clients.has(clientIds[0])).toBe(false);
      expect(server.clients.has(clientIds[1])).toBe(true);

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Removing client socket')).toBe(
        true,
      );
      expect(infos.some((e) => e.message === 'Client socket removed')).toBe(
        true,
      );
      expect(infos.some((e) => e.message === 'Rebuilding multis')).toBe(true);

      await server.tearDown();
    });

    it('should be a no-op for unknown clientId', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('removeUnknown');

      const server = new Server(route, io, bs);
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);

      // Should not throw, should not change state
      await server.removeSocket('non-existent-id');
      expect(server.clients.size).toBe(1);

      await server.tearDown();
    });

    it('should allow remaining clients to continue multicasting', async () => {
      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('removeMulticast');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      const socketC = new SocketMock();
      socketA.connect();
      socketB.connect();
      socketC.connect();
      await server.addSocket(socketA);
      await server.addSocket(socketB);
      await server.addSocket(socketC);

      const clientIds = Array.from(server.clients.keys());

      // Remove client B
      await server.removeSocket(clientIds[1]);

      logger.clear();

      // Client A emits → should reach client C but not B
      socketA.emit(route.flat, { r: 'post-remove-ref' });

      const traffic = logger.byLevel('traffic');
      const outbound = traffic.filter((e) => e.direction === 'out');

      // Should have outbound to remaining client (C) only
      expect(outbound.length).toBe(1);
      expect(outbound[0].data?.['to']).toBe(clientIds[2]);

      await server.tearDown();
    });
  });

  // .........................................................................
  describe('disconnect handling', () => {
    it('should auto-remove client on socket disconnect event', async () => {
      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('disconnectTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);

      logger.clear();

      // Simulate disconnect (SocketMock emits 'disconnect' when disconnect() is called)
      socket.disconnect();

      // Give the async removeSocket a tick to complete
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(server.clients.size).toBe(0);

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Client disconnected')).toBe(true);

      await server.tearDown();
    });
  });

  // .........................................................................
  describe('peer init timeout', () => {
    it('should default to 30s timeout', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('defaultTimeout');

      const server = new Server(route, io, bs);
      await server.init();

      // Just verify the server works with default timeout
      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);
      await server.tearDown();
    });

    it('should accept custom timeout via options', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('customTimeout');

      const server = new Server(route, io, bs, {
        peerInitTimeoutMs: 5000,
      });
      await server.init();

      // Verify it still works with custom timeout
      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);
      await server.tearDown();
    });

    it('should allow disabling timeout with 0', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('noTimeout');

      const server = new Server(route, io, bs, {
        peerInitTimeoutMs: 0,
      });
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);
      await server.tearDown();
    });
  });

  // .........................................................................
  describe('Client tearDown (Bs cleanup)', () => {
    it('should clear Bs references on tearDown', async () => {
      const serverIo = new IoMem();
      await serverIo.init();
      const serverBs = new BsMem();
      const route = Route.fromFlat('bsTearDown');

      const server = new Server(route, serverIo, serverBs);
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const clientIo = new IoMem();
      await clientIo.init();
      const clientBs = new BsMem();

      const client = new Client(socket, clientIo, clientBs);
      await client.init();

      // Verify Bs is available before tearDown
      expect(client.bs).toBeDefined();

      await client.tearDown();

      // After tearDown, bs should be cleared
      expect(client.bs).toBeUndefined();
      expect(client.io).toBeUndefined();

      await server.tearDown();
    });

    it('should tearDown cleanly even without route/Db/Connector', async () => {
      const serverIo = new IoMem();
      await serverIo.init();
      const serverBs = new BsMem();
      const route = Route.fromFlat('noRouteTearDown');

      const server = new Server(route, serverIo, serverBs);
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const clientIo = new IoMem();
      await clientIo.init();
      const clientBs = new BsMem();

      // No route → no Db/Connector
      const client = new Client(socket, clientIo, clientBs);
      await client.init();

      expect(client.db).toBeUndefined();
      expect(client.connector).toBeUndefined();

      // Should not throw
      await client.tearDown();

      expect(client.io).toBeUndefined();
      expect(client.bs).toBeUndefined();

      await server.tearDown();
    });
  });

  // .........................................................................
  describe('ServerOptions integration', () => {
    it('should accept all options together', async () => {
      const logger = new BufferedLogger();
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('allOptions');

      const server = new Server(route, io, bs, {
        logger,
        refEvictionIntervalMs: 5000,
        peerInitTimeoutMs: 10000,
      });
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.clients.size).toBe(1);
      expect(server.logger).toBe(logger);

      await server.tearDown();
    });
  });

  // .........................................................................
  describe('addBroadcastSocket', () => {
    it('should participate in multicast without IoPeer/BsPeer', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('broadcastTest');

      const server = new Server(route, io, bs);
      await server.init();

      // Add a broadcast-only socket (simulates hub loopback)
      const broadcastSocket = new SocketMock();
      broadcastSocket.connect();
      await server.addBroadcastSocket(broadcastSocket);

      // Add a regular client socket
      const clientSocket = new SocketMock();
      clientSocket.connect();
      await server.addSocket(clientSocket);

      // Verify both are registered
      expect(server.clients.size).toBe(2);

      // Broadcast socket sends a ref → should arrive on client socket
      const received: unknown[] = [];
      clientSocket.on(route.flat, (data: unknown) => {
        received.push(data);
      });
      broadcastSocket.emit(route.flat, { r: 'from-broadcast' });
      expect(received).toHaveLength(1);

      // Client socket sends a ref → should arrive on broadcast socket
      const broadcastReceived: unknown[] = [];
      broadcastSocket.on(route.flat, (data: unknown) => {
        broadcastReceived.push(data);
      });
      clientSocket.emit(route.flat, { r: 'from-client' });
      expect(broadcastReceived).toHaveLength(1);

      await server.tearDown();
    });

    it('should not add IoPeer/BsPeer to IoMulti', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('noPeerTest');

      const server = new Server(route, io, bs);
      await server.init();

      // Add broadcast socket — should NOT add any IoPeer to IoMulti
      const broadcastSocket = new SocketMock();
      broadcastSocket.connect();
      await server.addBroadcastSocket(broadcastSocket);

      // Add a regular client — this DOES add an IoPeer
      const clientSocket = new SocketMock();
      clientSocket.connect();
      await server.addSocket(clientSocket);

      // IoMulti should have: IoMem (local cache) + 1 IoPeer (client)
      // but NOT 2 IoPeers (no broadcast peer)
      // Verify indirectly: clients map has 2, showing broadcast is registered
      // for multicast, but since we can't directly inspect _ios length,
      // we verify the broadcast socket's io field is null
      const entries = [...server.clients.entries()];
      const broadcastEntry = entries.find(([k]) => k.startsWith('broadcast_'));
      expect(broadcastEntry).toBeDefined();
      expect(broadcastEntry![1].io).toBeNull();

      await server.tearDown();
    });

    it('removeSocket should handle broadcast-only clients safely', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('removeTest');

      const server = new Server(route, io, bs);
      await server.init();

      const broadcastSocket = new SocketMock();
      broadcastSocket.connect();
      await server.addBroadcastSocket(broadcastSocket);

      expect(server.clients.size).toBe(1);

      // Find the broadcast client ID
      const [clientId] = [...server.clients.keys()];

      // removeSocket should work without errors (null io/bs filtered safely)
      await server.removeSocket(clientId);
      expect(server.clients.size).toBe(0);

      await server.tearDown();
    });
  });
});
