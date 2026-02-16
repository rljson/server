// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, Socket, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';

// .............................................................................
// Helpers
// .............................................................................

/** Creates a minimal server for client tests. */
const createServer = async (route: Route) => {
  const io = new IoMem();
  await io.init();
  const bs = new BsMem();
  const server = new Server(route, io, bs, { refEvictionIntervalMs: 0 });
  await server.init();
  return server;
};

/**
 * Creates a socket whose `connected` is `false` and never fires the
 * `connect` event. IoPeer.init() waits for a `connect` event, so it
 * will hang forever — exercising the timeout path.
 */
const createNeverConnectingSocket = (): Socket => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket: Socket = {
    get connected() {
      return false; // Never becomes true
    },
    connect: () => {
      // Does NOT emit 'connect' — simulates unreachable server
    },
    disconnect: () => {},
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    off: (event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb);
    },
    emit: () => {},
  };
  return socket;
};

// .............................................................................
describe('Client peerInitTimeoutMs', () => {
  let server: Server | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.tearDown();
      client = undefined;
    }
    if (server && !server.isTornDown) {
      await server.tearDown();
      server = undefined;
    }
  });

  // =========================================================================
  describe('Default behavior', () => {
    it('should default peerInitTimeoutMs to 30_000', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const socket = new SocketMock();

      client = new Client(socket, io, bs);

      expect(client.peerInitTimeoutMs).toBe(30_000);
    });

    it('should accept custom peerInitTimeoutMs', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const socket = new SocketMock();

      client = new Client(socket, io, bs, undefined, {
        peerInitTimeoutMs: 5000,
      });

      expect(client.peerInitTimeoutMs).toBe(5000);
    });

    it('should accept peerInitTimeoutMs of 0 (disabled)', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const socket = new SocketMock();

      client = new Client(socket, io, bs, undefined, {
        peerInitTimeoutMs: 0,
      });

      expect(client.peerInitTimeoutMs).toBe(0);
    });
  });

  // =========================================================================
  describe('Successful init with timeout', () => {
    it('should init normally when server responds within timeout', async () => {
      const route = Route.fromFlat('timeoutOk');
      server = await createServer(route);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      client = new Client(socket, io, bs, route, {
        peerInitTimeoutMs: 5000,
      });

      await client.init();

      expect(client.io).toBeDefined();
      expect(client.bs).toBeDefined();
      expect(client.db).toBeDefined();
      expect(client.connector).toBeDefined();
    });

    it('should init without route when server responds within timeout', async () => {
      const route = Route.fromFlat('timeoutOkNoRoute');
      server = await createServer(route);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      client = new Client(socket, io, bs, undefined, {
        peerInitTimeoutMs: 5000,
      });

      await client.init();

      expect(client.io).toBeDefined();
      expect(client.bs).toBeDefined();
      expect(client.db).toBeUndefined();
      expect(client.connector).toBeUndefined();
    });
  });

  // =========================================================================
  describe('Timeout rejection', () => {
    it('should reject init() when Io peer hangs beyond timeout', async () => {
      vi.useFakeTimers();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const hangingSocket = createNeverConnectingSocket();

      client = new Client(hangingSocket, io, bs, undefined, {
        peerInitTimeoutMs: 100,
      });

      const initPromise = client.init().catch((e: Error) => e);

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(150);

      const error = await initPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Timeout after 100ms');

      vi.useRealTimers();
    });

    it('should include label in timeout error message', async () => {
      vi.useFakeTimers();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const hangingSocket = createNeverConnectingSocket();

      client = new Client(hangingSocket, io, bs, undefined, {
        peerInitTimeoutMs: 50,
      });

      const initPromise = client.init().catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(60);

      const error = await initPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('IoPeer init');

      vi.useRealTimers();
    });
  });

  // =========================================================================
  describe('Disabled timeout (0)', () => {
    it('should not apply timeout when peerInitTimeoutMs is 0', async () => {
      const route = Route.fromFlat('noTimeoutClient');
      server = await createServer(route);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      client = new Client(socket, io, bs, route, {
        peerInitTimeoutMs: 0,
      });

      // Should succeed — the promise is not raced against any timeout
      await client.init();

      expect(client.io).toBeDefined();
      expect(client.bs).toBeDefined();
    });
  });

  // =========================================================================
  describe('Interaction with other ClientOptions', () => {
    it('should work alongside syncConfig and clientIdentity', async () => {
      const route = Route.fromFlat('timeoutWithSync');
      server = await createServer(route);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      client = new Client(socket, io, bs, route, {
        peerInitTimeoutMs: 5000,
        syncConfig: { requireAck: true },
        clientIdentity: 'test-client',
      });

      await client.init();

      expect(client.peerInitTimeoutMs).toBe(5000);
      expect(client.connector).toBeDefined();
      expect(client.connector!.syncConfig).toEqual({ requireAck: true });
      expect(client.connector!.clientIdentity).toBe('test-client');
    });

    it('should work with logger option', async () => {
      const route = Route.fromFlat('timeoutWithLogger');
      server = await createServer(route);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const { BufferedLogger } = await import('../src/logger');
      const logger = new BufferedLogger();

      client = new Client(socket, io, bs, route, {
        peerInitTimeoutMs: 5000,
        logger,
      });

      await client.init();

      expect(client.peerInitTimeoutMs).toBe(5000);
      expect(client.logger).toBe(logger);
      expect(logger.entries.length).toBeGreaterThan(0);
    });
  });
});
