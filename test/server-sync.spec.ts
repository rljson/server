// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import {
  AckPayload,
  ConnectorPayload,
  GapFillRequest,
  GapFillResponse,
  Route,
  SyncConfig,
  syncEvents,
} from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client';
import { BufferedLogger } from '../src/logger';
import { Server, ServerOptions } from '../src/server';

// .............................................................................
// Helpers
// .............................................................................

/** Creates a standard test server with sync protocol enabled. */
const createSyncServer = async (
  route: Route,
  syncConfig: SyncConfig,
  opts?: Partial<ServerOptions>,
) => {
  const io = new IoMem();
  await io.init();
  const bs = new BsMem();
  const logger = new BufferedLogger();

  const server = new Server(route, io, bs, {
    logger,
    syncConfig,
    refEvictionIntervalMs: 0,
    ...opts,
  });
  await server.init();
  return { server, io, bs, logger };
};

/** Adds a SocketMock client to the server and returns the socket. */
const addClient = async (server: Server) => {
  const socket = new SocketMock();
  socket.connect();
  await server.addSocket(socket);
  return socket;
};

// .............................................................................
describe('Server sync protocol', () => {
  let server: Server;

  afterEach(async () => {
    if (server && !server.isTornDown) {
      await server.tearDown();
    }
  });

  // =========================================================================
  describe('SyncConfig passthrough', () => {
    it('should expose syncConfig when provided', async () => {
      const route = Route.fromFlat('syncCfgTest');
      const syncConfig: SyncConfig = { requireAck: true, causalOrdering: true };
      const result = await createSyncServer(route, syncConfig);
      server = result.server;

      expect(server.syncConfig).toEqual(syncConfig);
      expect(server.events).toBeDefined();
      expect(server.events!.ref).toBe(route.flat);
      expect(server.events!.ack).toBe(`${route.flat}:ack`);
      expect(server.events!.ackClient).toBe(`${route.flat}:ack:client`);
      expect(server.events!.gapFillReq).toBe(`${route.flat}:gapfill:req`);
      expect(server.events!.gapFillRes).toBe(`${route.flat}:gapfill:res`);
    });

    it('should have undefined syncConfig/events when not provided', async () => {
      const route = Route.fromFlat('noSyncCfg');
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      server = new Server(route, io, bs, { refEvictionIntervalMs: 0 });
      await server.init();

      expect(server.syncConfig).toBeUndefined();
      expect(server.events).toBeUndefined();
    });
  });

  // =========================================================================
  describe('Ref log (ring buffer)', () => {
    it('should append payloads to ref log on multicast', async () => {
      const route = Route.fromFlat('refLogTest');
      const result = await createSyncServer(route, { requireAck: true });
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server);
      const payload: ConnectorPayload = { o: 'origin-A', r: 'ref-1' };
      socketA.emit(route.flat, payload);

      expect(server.refLog).toHaveLength(1);
      expect(server.refLog[0].r).toBe('ref-1');

      // Send another
      const payload2: ConnectorPayload = { o: 'origin-A', r: 'ref-2' };
      socketA.emit(route.flat, payload2);
      expect(server.refLog).toHaveLength(2);
    });

    it('should respect refLogSize limit', async () => {
      const route = Route.fromFlat('refLogLimit');
      const result = await createSyncServer(
        route,
        { requireAck: true },
        { refLogSize: 3 },
      );
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server);

      // Send 5 payloads — only last 3 should remain
      for (let i = 1; i <= 5; i++) {
        socketA.emit(route.flat, { o: 'origin-A', r: `ref-${i}` });
      }

      expect(server.refLog).toHaveLength(3);
      expect(server.refLog[0].r).toBe('ref-3');
      expect(server.refLog[1].r).toBe('ref-4');
      expect(server.refLog[2].r).toBe('ref-5');
    });

    it('should not populate ref log without syncConfig', async () => {
      const route = Route.fromFlat('noRefLog');
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      server = new Server(route, io, bs, { refEvictionIntervalMs: 0 });
      await server.init();

      const socketA = await addClient(server);
      await addClient(server);

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-1' });

      expect(server.refLog).toHaveLength(0);
    });

    it('should clear ref log on tearDown', async () => {
      const route = Route.fromFlat('refLogTeardown');
      const result = await createSyncServer(route, { requireAck: true });
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server);

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-1' });
      expect(server.refLog).toHaveLength(1);

      await server.tearDown();
      expect(server.refLog).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('ACK aggregation', () => {
    it('should emit immediate ACK when no receivers', async () => {
      const route = Route.fromFlat('ackNoReceivers');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { requireAck: true });
      server = result.server;

      const socketA = await addClient(server);

      // Only one client — no receivers
      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-solo' });

      expect(acks).toHaveLength(1);
      expect(acks[0]).toEqual({
        r: 'ref-solo',
        ok: true,
        receivedBy: 0,
        totalClients: 0,
      });
    });

    it('should emit full ACK when all receivers acknowledge', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('ackFull');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { requireAck: true });
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);
      const socketC = await addClient(server);

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      // Client B and C will respond with ackClient
      socketB.on(route.flat, () => {
        socketB.emit(events.ackClient, { r: 'ref-ack-full' });
      });
      socketC.on(route.flat, () => {
        socketC.emit(events.ackClient, { r: 'ref-ack-full' });
      });

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-ack-full' });

      expect(acks).toHaveLength(1);
      expect(acks[0]).toEqual({
        r: 'ref-ack-full',
        ok: true,
        receivedBy: 2,
        totalClients: 2,
      });

      vi.useRealTimers();
    });

    it('should emit partial ACK on timeout', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('ackTimeout');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(
        route,
        { requireAck: true },
        { ackTimeoutMs: 100 },
      );
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);
      await addClient(server); // socketC — does not ack

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      // Only client B responds, C does not
      socketB.on(route.flat, () => {
        socketB.emit(events.ackClient, { r: 'ref-partial' });
      });

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-partial' });

      // B responded immediately so 1 ack received, but C didn't
      expect(acks).toHaveLength(0); // not complete yet

      // Advance past timeout
      vi.advanceTimersByTime(110);

      expect(acks).toHaveLength(1);
      expect(acks[0]).toEqual({
        r: 'ref-partial',
        ok: false,
        receivedBy: 1,
        totalClients: 2,
      });

      vi.useRealTimers();
    });

    it('should ignore ackClient for wrong ref', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('ackWrongRef');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(
        route,
        { requireAck: true },
        { ackTimeoutMs: 100 },
      );
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      // Client B responds with wrong ref
      socketB.on(route.flat, () => {
        socketB.emit(events.ackClient, { r: 'wrong-ref' });
      });

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-right' });

      // Wrong ref doesn't count — timeout should fire
      vi.advanceTimersByTime(110);

      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(false);
      expect(acks[0].receivedBy).toBe(0);

      vi.useRealTimers();
    });

    it('should not emit ACK without requireAck', async () => {
      const route = Route.fromFlat('noAck');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, {
        causalOrdering: true,
      });
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server);

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      socketA.emit(route.flat, { o: 'origin-A', r: 'ref-no-ack' });

      expect(acks).toHaveLength(0);
    });

    it('should ignore duplicate finish (timeout after all-ACK)', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('doubleFinish');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(
        route,
        { requireAck: true },
        { ackTimeoutMs: 100 },
      );
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      // Client B immediately acknowledges
      socketB.on(route.flat, (p: ConnectorPayload) => {
        socketB.emit(events.ackClient, { r: p.r });
      });

      socketA.emit(route.flat, { o: 'oA', r: 'ref-double' });

      // ACK should have been emitted immediately (all clients ACK'd)
      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(true);

      // Now advance past timeout — should NOT emit a second ACK
      vi.advanceTimersByTime(110);
      expect(acks).toHaveLength(1); // still only 1

      vi.useRealTimers();
    });
  });

  // =========================================================================
  describe('Gap-fill responder', () => {
    it('should respond with matching refs from ref log', async () => {
      const route = Route.fromFlat('gapFillTest');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { causalOrdering: true });
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      // Populate ref log with sequenced payloads
      socketA.emit(route.flat, {
        o: 'origin-A',
        r: 'ref-1',
        seq: 1,
        c: 'client-A',
      });
      socketA.emit(route.flat, {
        o: 'origin-A',
        r: 'ref-2',
        seq: 2,
        c: 'client-A',
      });
      socketA.emit(route.flat, {
        o: 'origin-A',
        r: 'ref-3',
        seq: 3,
        c: 'client-A',
      });

      expect(server.refLog).toHaveLength(3);

      // Client B requests gap-fill for refs after seq 1
      const responses: GapFillResponse[] = [];
      socketB.on(events.gapFillRes, (res: GapFillResponse) =>
        responses.push(res),
      );

      const req: GapFillRequest = { route: route.flat, afterSeq: 1 };
      socketB.emit(events.gapFillReq, req);

      expect(responses).toHaveLength(1);
      expect(responses[0].refs).toHaveLength(2);
      expect(responses[0].refs[0].r).toBe('ref-2');
      expect(responses[0].refs[1].r).toBe('ref-3');
      expect(responses[0].route).toBe(route.flat);
    });

    it('should return empty refs when nothing matches', async () => {
      const route = Route.fromFlat('gapFillEmpty');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { causalOrdering: true });
      server = result.server;

      const socketA = await addClient(server);

      // No payloads in ref log yet
      const responses: GapFillResponse[] = [];
      socketA.on(events.gapFillRes, (res: GapFillResponse) =>
        responses.push(res),
      );

      const req: GapFillRequest = { route: route.flat, afterSeq: 0 };
      socketA.emit(events.gapFillReq, req);

      expect(responses).toHaveLength(1);
      expect(responses[0].refs).toHaveLength(0);
    });

    it('should not register gap-fill listener without causalOrdering', async () => {
      const route = Route.fromFlat('noGapFill');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { requireAck: true });
      server = result.server;

      const socketA = await addClient(server);

      const responses: GapFillResponse[] = [];
      socketA.on(events.gapFillRes, (res: GapFillResponse) =>
        responses.push(res),
      );

      const req: GapFillRequest = { route: route.flat, afterSeq: 0 };
      socketA.emit(events.gapFillReq, req);

      // No listener registered — no response
      expect(responses).toHaveLength(0);
    });

    it('should only return refs with seq > afterSeq', async () => {
      const route = Route.fromFlat('gapFillFilter');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, { causalOrdering: true });
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      // Mix of sequenced and unsequenced payloads
      socketA.emit(route.flat, { o: 'oA', r: 'no-seq-1' }); // no seq
      socketA.emit(route.flat, { o: 'oA', r: 'seq-5', seq: 5, c: 'cA' });
      socketA.emit(route.flat, { o: 'oA', r: 'seq-10', seq: 10, c: 'cA' });
      socketA.emit(route.flat, { o: 'oA', r: 'no-seq-2' }); // no seq

      const responses: GapFillResponse[] = [];
      socketB.on(events.gapFillRes, (res: GapFillResponse) =>
        responses.push(res),
      );

      socketB.emit(events.gapFillReq, { route: route.flat, afterSeq: 5 });

      expect(responses).toHaveLength(1);
      // Only seq:10 should match (seq > 5), unsequenced entries filtered out
      expect(responses[0].refs).toHaveLength(1);
      expect(responses[0].refs[0].r).toBe('seq-10');
    });
  });

  // =========================================================================
  describe('Enriched payload forwarding', () => {
    it('should forward all sync fields transparently', async () => {
      const route = Route.fromFlat('forwardTest');
      const result = await createSyncServer(route, {
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      });
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      const received: ConnectorPayload[] = [];
      socketB.on(route.flat, (p: ConnectorPayload) => received.push(p));

      const fullPayload: ConnectorPayload = {
        o: 'origin-A',
        r: 'ref-enriched',
        c: 'client-id-abc',
        t: 1700000000000,
        seq: 42,
        p: ['1700000000001:PrEd'],
      };

      socketA.emit(route.flat, fullPayload);

      expect(received).toHaveLength(1);
      expect(received[0].r).toBe('ref-enriched');
      expect(received[0].c).toBe('client-id-abc');
      expect(received[0].t).toBe(1700000000000);
      expect(received[0].seq).toBe(42);
      expect(received[0].p).toEqual(['1700000000001:PrEd']);
      // __origin is added for loop prevention
      expect((received[0] as any).__origin).toBeDefined();
    });
  });

  // =========================================================================
  describe('Combined sync features', () => {
    it('should support ACK + gap-fill + ref log together', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('combined');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, {
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      });
      server = result.server;

      const socketA = await addClient(server);
      const socketB = await addClient(server);

      // ACK tracking
      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      // Client B auto-acknowledges
      socketB.on(route.flat, (p: ConnectorPayload) => {
        socketB.emit(events.ackClient, { r: p.r });
      });

      // Send sequenced payload
      socketA.emit(route.flat, {
        o: 'oA',
        r: 'ref-combined-1',
        seq: 1,
        c: 'clientA',
        t: Date.now(),
      });

      // Should have ACK (all receivers acknowledged)
      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(true);

      // Ref log should have entry
      expect(server.refLog).toHaveLength(1);
      expect(server.refLog[0].seq).toBe(1);

      // Gap-fill should work
      const gapResponses: GapFillResponse[] = [];
      socketB.on(events.gapFillRes, (res: GapFillResponse) =>
        gapResponses.push(res),
      );

      socketB.emit(events.gapFillReq, { route: route.flat, afterSeq: 0 });
      expect(gapResponses).toHaveLength(1);
      expect(gapResponses[0].refs).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  describe('Client SyncConfig passthrough', () => {
    it('should pass syncConfig to Connector when route is provided', async () => {
      const route = Route.fromFlat('clientSync');
      const syncConfig: SyncConfig = {
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      };

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const socket = new SocketMock();
      socket.connect();

      const client = new Client(socket, io, bs, route, {
        syncConfig,
        clientIdentity: 'custom-client-id',
      });
      await client.init();

      expect(client.connector).toBeDefined();
      expect(client.connector!.syncConfig).toEqual(syncConfig);
      expect(client.connector!.clientIdentity).toBe('custom-client-id');

      await client.tearDown();
    });

    it('should not set syncConfig on Connector when not provided', async () => {
      const route = Route.fromFlat('clientNoSync');

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const socket = new SocketMock();
      socket.connect();

      const client = new Client(socket, io, bs, route);
      await client.init();

      expect(client.connector).toBeDefined();
      expect(client.connector!.syncConfig).toBeUndefined();
      expect(client.connector!.clientIdentity).toBeUndefined();

      await client.tearDown();
    });
  });

  // =========================================================================
  describe('Default ackTimeoutMs', () => {
    it('should use SyncConfig ackTimeoutMs when ackTimeoutMs not in ServerOptions', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('defaultAckTimeout');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(route, {
        requireAck: true,
        ackTimeoutMs: 50,
      });
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server); // socketB — does not ack

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      socketA.emit(route.flat, { o: 'oA', r: 'ref-timeout-cfg' });

      // Timeout inherited from SyncConfig (50ms)
      vi.advanceTimersByTime(60);

      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(false);

      vi.useRealTimers();
    });

    it('should prefer ServerOptions ackTimeoutMs over SyncConfig', async () => {
      vi.useFakeTimers();

      const route = Route.fromFlat('overrideAckTimeout');
      const events = syncEvents(route.flat);
      const result = await createSyncServer(
        route,
        { requireAck: true, ackTimeoutMs: 5000 },
        { ackTimeoutMs: 50 },
      );
      server = result.server;

      const socketA = await addClient(server);
      await addClient(server); // socketB — does not ack

      const acks: AckPayload[] = [];
      socketA.on(events.ack, (ack: AckPayload) => acks.push(ack));

      socketA.emit(route.flat, { o: 'oA', r: 'ref-override' });

      // ServerOptions ackTimeoutMs (50ms) takes precedence
      vi.advanceTimersByTime(60);

      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(false);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  describe('Client tearDown calls connector.tearDown()', () => {
    it('should call connector.tearDown() during client tearDown', async () => {
      const route = Route.fromFlat('teardownConnector');

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const socket = new SocketMock();
      socket.connect();

      const client = new Client(socket, io, bs, route);
      await client.init();

      const connector = client.connector!;
      expect(connector).toBeDefined();
      expect(connector.isListening).toBe(true);

      await client.tearDown();

      // Connector should have been torn down
      expect(connector.isListening).toBe(false);
      expect(client.connector).toBeUndefined();
    });

    it('should handle tearDown gracefully when no connector exists', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const socket = new SocketMock();
      socket.connect();

      // Create client without route — no connector
      const client = new Client(socket, io, bs);
      await client.init();

      expect(client.connector).toBeUndefined();

      // Should not throw
      await client.tearDown();
    });
  });
});
