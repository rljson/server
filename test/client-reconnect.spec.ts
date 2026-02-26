// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../src/client';
import { BufferedLogger } from '../src/logger';
import { Server } from '../src/server';

// .............................................................................
// Helpers
// .............................................................................

/** Creates a minimal server for client reconnect tests. */
const createServer = async (route: Route) => {
  const io = new IoMem();
  await io.init();
  const bs = new BsMem();
  const server = new Server(route, io, bs, { refEvictionIntervalMs: 0 });
  await server.init();
  return server;
};

/**
 * Helper that creates and initializes a server + client pair.
 * Returns the client, its SocketMock, and the logger for assertions.
 */
const createInitializedClient = async (options?: {
  logger?: BufferedLogger;
  route?: Route;
}) => {
  const route = options?.route ?? Route.fromFlat('reconnectTest');
  const logger = options?.logger ?? new BufferedLogger();

  const server = await createServer(route);

  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);

  const clientIo = new IoMem();
  await clientIo.init();
  const clientBs = new BsMem();

  const client = new Client(socket, clientIo, clientBs, route, { logger });
  await client.init();

  return { client, socket, logger, server };
};

// .............................................................................
describe('Client reconnect handling', () => {
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
  describe('isConnected', () => {
    it('should be true after init', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      expect(client.isConnected).toBe(true);
    });

    it('should become false after disconnect', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      result.socket.disconnect();

      expect(client.isConnected).toBe(false);
    });

    it('should become true after reconnect', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      result.socket.disconnect();
      expect(client.isConnected).toBe(false);

      result.socket.connect();
      expect(client.isConnected).toBe(true);
    });
  });

  // =========================================================================
  describe('onDisconnect', () => {
    it('should invoke callback on socket disconnect', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let called = false;
      client.onDisconnect(() => {
        called = true;
      });

      result.socket.disconnect();
      expect(called).toBe(true);
    });

    it('should pass disconnect reason when provided', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let receivedReason = '';
      client.onDisconnect((reason) => {
        receivedReason = reason;
      });

      // Manually emit 'disconnect' with a reason string
      result.socket.emit('disconnect', 'transport close');
      expect(receivedReason).toBe('transport close');
    });

    it('should use "unknown" when reason is not a string', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let receivedReason = '';
      client.onDisconnect((reason) => {
        receivedReason = reason;
      });

      // SocketMock.disconnect() emits 'disconnect' with no args
      result.socket.disconnect();
      expect(receivedReason).toBe('unknown');
    });

    it('should invoke multiple callbacks in order', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      const calls: string[] = [];
      client.onDisconnect(() => calls.push('first'));
      client.onDisconnect(() => calls.push('second'));

      result.socket.disconnect();
      expect(calls).toEqual(['first', 'second']);
    });
  });

  // =========================================================================
  describe('onReconnect', () => {
    it('should invoke callback on reconnect after disconnect', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let called = false;
      client.onReconnect(() => {
        called = true;
      });

      result.socket.disconnect();
      result.socket.connect();
      expect(called).toBe(true);
    });

    it('should invoke multiple callbacks in order', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      const calls: string[] = [];
      client.onReconnect(() => calls.push('first'));
      client.onReconnect(() => calls.push('second'));

      result.socket.disconnect();
      result.socket.connect();
      expect(calls).toEqual(['first', 'second']);
    });

    it('should handle multiple disconnect/reconnect cycles', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let disconnectCount = 0;
      let reconnectCount = 0;
      client.onDisconnect(() => disconnectCount++);
      client.onReconnect(() => reconnectCount++);

      // Cycle 1
      result.socket.disconnect();
      result.socket.connect();
      expect(disconnectCount).toBe(1);
      expect(reconnectCount).toBe(1);

      // Cycle 2
      result.socket.disconnect();
      result.socket.connect();
      expect(disconnectCount).toBe(2);
      expect(reconnectCount).toBe(2);
    });
  });

  // =========================================================================
  describe('Logger integration', () => {
    it('should log disconnect warning with reason', async () => {
      const logger = new BufferedLogger();
      const result = await createInitializedClient({ logger });
      client = result.client;
      server = result.server;

      result.socket.disconnect();

      const disconnectLogs = logger
        .byLevel('warn')
        .filter((e) => e.message.includes('Disconnected from server'));
      expect(disconnectLogs.length).toBe(1);
      expect(disconnectLogs[0].source).toBe('Client');
      expect(disconnectLogs[0].data).toEqual({ reason: 'unknown' });
    });

    it('should log reconnect info', async () => {
      const logger = new BufferedLogger();
      const result = await createInitializedClient({ logger });
      client = result.client;
      server = result.server;

      result.socket.disconnect();
      result.socket.connect();

      const reconnectLogs = logger
        .byLevel('info')
        .filter((e) => e.message.includes('Reconnected to server'));
      expect(reconnectLogs.length).toBe(1);
      expect(reconnectLogs[0].source).toBe('Client');
    });
  });

  // =========================================================================
  describe('tearDown cleanup', () => {
    it('should not invoke callbacks after tearDown', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      let disconnectCalled = false;
      let reconnectCalled = false;
      client.onDisconnect(() => {
        disconnectCalled = true;
      });
      client.onReconnect(() => {
        reconnectCalled = true;
      });

      await client.tearDown();

      // Manually emit events on the raw socket — handlers should be removed
      result.socket.emit('disconnect', 'test');
      result.socket.emit('connect');

      expect(disconnectCalled).toBe(false);
      expect(reconnectCalled).toBe(false);
    });

    it('should clear callback arrays on tearDown', async () => {
      const result = await createInitializedClient();
      client = result.client;
      server = result.server;

      client.onDisconnect(() => {});
      client.onReconnect(() => {});

      // After tearDown, registering new callbacks and emitting should be safe
      await client.tearDown();

      // This should not throw
      expect(() => client!.onDisconnect(() => {})).not.toThrow();
      expect(() => client!.onReconnect(() => {})).not.toThrow();
    });
  });
});
