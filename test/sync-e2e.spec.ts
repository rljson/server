// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db, staticExample } from '@rljson/db';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
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

// =============================================================================
// Helpers
// =============================================================================

/** One socket pair per client: server side + client side. */
interface SocketPair {
  serverSide: DirectionalSocketMock;
  clientSide: DirectionalSocketMock;
}

interface E2eSetup {
  server: Server;
  clientA: Client;
  clientB: Client;
  clientC?: Client;
  dbA: Db;
  dbB: Db;
  dbC?: Db;
  connectorA: Connector;
  connectorB: Connector;
  connectorC?: Connector;
  /** Client-side socket for A (used by Connector + IoPeer). */
  socketA: DirectionalSocketMock;
  /** Client-side socket for B. */
  socketB: DirectionalSocketMock;
  /** Client-side socket for C (when numClients === 3). */
  socketC?: DirectionalSocketMock;
  /** Server-side socket for B — useful for injecting simulated payloads. */
  serverSocketB: DirectionalSocketMock;
  route: Route;
  logger: BufferedLogger;
  tearDown: () => Promise<void>;
}

/**
 * Creates a socket pair, connects the server side, adds it to the server,
 * then creates a Client with the client side.
 */
const createClientWithPair = async (
  server: Server,
  route: Route,
  syncConfig?: SyncConfig,
): Promise<{
  client: Client;
  pair: SocketPair;
}> => {
  const [serverSide, clientSide] = createSocketPair();
  serverSide.connect();
  await server.addSocket(serverSide);

  const io = new IoMem();
  await io.init();
  await io.isReady();

  const client = new Client(clientSide, io, new BsMem(), route, {
    syncConfig,
  });
  await client.init();

  return { client, pair: { serverSide, clientSide } };
};

/**
 * Creates a full Client-Server-Client setup with DirectionalSocketMock transport.
 * Each client gets its own IoMem, BsMem, Db, and Connector (auto-created
 * by the Client constructor when a route is provided).
 */
const createE2eSetup = async (
  syncConfig?: SyncConfig,
  opts?: {
    serverOpts?: Partial<ServerOptions>;
    numClients?: 2 | 3;
  },
): Promise<E2eSetup> => {
  const numClients = opts?.numClients ?? 2;
  const route = Route.fromFlat('e2eTest');
  const logger = new BufferedLogger();

  // --- Server ---
  const serverIo = new IoMem();
  await serverIo.init();
  await serverIo.isReady();
  const serverBs = new BsMem();
  const server = new Server(route, serverIo, serverBs, {
    logger,
    syncConfig,
    refEvictionIntervalMs: 0,
    ...opts?.serverOpts,
  });
  await server.init();

  // --- Clients ---
  const { client: clientA, pair: pairA } = await createClientWithPair(
    server,
    route,
    syncConfig,
  );
  const { client: clientB, pair: pairB } = await createClientWithPair(
    server,
    route,
    syncConfig,
  );

  let clientC: Client | undefined;
  let pairC: SocketPair | undefined;

  if (numClients === 3) {
    const result = await createClientWithPair(server, route, syncConfig);
    clientC = result.client;
    pairC = result.pair;
  }

  // --- Table definitions on all parties ---
  const exampleData = staticExample();
  const tableCfgs = exampleData.tableCfgs._data;
  await server.createTables({ withInsertHistory: tableCfgs });
  await clientA.createTables({ withInsertHistory: tableCfgs });
  await clientB.createTables({ withInsertHistory: tableCfgs });
  if (clientC) {
    await clientC.createTables({ withInsertHistory: tableCfgs });
  }

  const tearDown = async () => {
    if (clientC) await clientC.tearDown();
    await clientB.tearDown();
    await clientA.tearDown();
    if (!server.isTornDown) await server.tearDown();
  };

  return {
    server,
    clientA,
    clientB,
    clientC,
    dbA: clientA.db!,
    dbB: clientB.db!,
    dbC: clientC?.db,
    connectorA: clientA.connector!,
    connectorB: clientB.connector!,
    connectorC: clientC?.connector,
    socketA: pairA.clientSide,
    socketB: pairB.clientSide,
    socketC: pairC?.clientSide,
    serverSocketB: pairB.serverSide,
    route,
    logger,
    tearDown,
  };
};

// =============================================================================
describe('Sync protocol end-to-end', () => {
  let setup: E2eSetup;

  afterEach(async () => {
    if (setup) {
      await setup.tearDown();
    }
  });

  // ===========================================================================
  describe('Basic multicast with Db', () => {
    it('should deliver ref from A to B and allow B to pull data', async () => {
      setup = await createE2eSetup();

      // Client A imports data locally
      const exampleData = staticExample();
      await setup.clientA.import(exampleData);

      // Get a ref from A's local data
      const carCakeRoute = Route.fromFlat('carCake');
      const dataFromA = await setup.dbA.get(carCakeRoute, {});
      const carRef = dataFromA.rljson.carCake._data[0]._hash;
      expect(carRef).toBeDefined();

      // A sends the ref through the connector
      setup.connectorA.send(carRef);

      // B should be able to pull the data by ref
      // (IoMulti → IoPeer → Server → IoPeerBridge → A's local IoMem)
      const dataFromB = await setup.dbB.get(carCakeRoute, { _hash: carRef });
      expect(dataFromB.rljson.carCake._data[0]._hash).toBe(carRef);
      expect(dataFromB.rljson.carCake._data[0]).toEqual(
        dataFromA.rljson.carCake._data[0],
      );
    });

    it('should send minimal payload { o, r } when no syncConfig', async () => {
      setup = await createE2eSetup(); // no syncConfig

      const received: ConnectorPayload[] = [];
      // B's client socket receives forwarded payloads from server
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      setup.connectorA.send('ref-minimal');

      expect(received).toHaveLength(1);
      expect(received[0].r).toBe('ref-minimal');
      expect(received[0].o).toBe(setup.connectorA.origin);
      // No sync fields should be present
      expect(received[0].c).toBeUndefined();
      expect(received[0].t).toBeUndefined();
      expect(received[0].seq).toBeUndefined();
      expect(received[0].p).toBeUndefined();
    });

    it('should not deliver self-echo back to sender', async () => {
      setup = await createE2eSetup();

      const receivedByB: ConnectorPayload[] = [];

      // Track what B's connector receives
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        receivedByB.push(p);
      });

      setup.connectorA.send('ref-self-echo');

      // B should receive the ref
      const bPayloads = receivedByB.filter(
        (p) => p.o !== setup.connectorB.origin,
      );
      expect(bPayloads).toHaveLength(1);
      expect(bPayloads[0].r).toBe('ref-self-echo');

      // A's connector filters self-echo via origin check in _processIncoming.
      // Server does NOT multicast back to the sender, so A's socket
      // never receives its own ref payload.
      // The send dedup set also prevents re-sending.
      setup.connectorA.send('ref-self-echo'); // should be no-op (already sent)
      // B should still only have 1
      const bPayloads2 = receivedByB.filter(
        (p) => p.o !== setup.connectorB.origin,
      );
      expect(bPayloads2).toHaveLength(1);
    });
  });

  // ===========================================================================
  describe('Client identity enrichment', () => {
    it('should attach c and t to payload when includeClientIdentity', async () => {
      setup = await createE2eSetup({ includeClientIdentity: true });

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      setup.connectorA.send('ref-identity');

      expect(received).toHaveLength(1);
      expect(received[0].c).toBeDefined();
      expect(received[0].t).toBeDefined();
      expect(typeof received[0].t).toBe('number');
      expect(received[0].t).toBeGreaterThan(0);
    });

    it('should use stable ClientId across multiple sends', async () => {
      setup = await createE2eSetup({ includeClientIdentity: true });

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      setup.connectorA.send('ref-stable-1');
      setup.connectorA.send('ref-stable-2');

      expect(received).toHaveLength(2);
      expect(received[0].c).toBe(received[1].c);
    });

    it('should produce ClientId matching client_ + 12 chars format', async () => {
      setup = await createE2eSetup({ includeClientIdentity: true });

      const clientId = setup.connectorA.clientIdentity;
      expect(clientId).toBeDefined();
      expect(clientId!.startsWith('client_')).toBe(true);
      expect(clientId!.slice('client_'.length)).toHaveLength(12);
    });
  });

  // ===========================================================================
  describe('Causal ordering + gap detection', () => {
    it('should produce monotonically increasing seq numbers', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        includeClientIdentity: true,
      });

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      setup.connectorA.send('ref-seq-1');
      setup.connectorA.send('ref-seq-2');
      setup.connectorA.send('ref-seq-3');

      expect(received).toHaveLength(3);
      expect(received[0].seq).toBe(1);
      expect(received[1].seq).toBe(2);
      expect(received[2].seq).toBe(3);
    });

    it('should transmit predecessors in p field', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        includeClientIdentity: true,
      });

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      setup.connectorA.setPredecessors(['1700000000000:Pred1']);
      setup.connectorA.send('ref-with-pred');

      expect(received).toHaveLength(1);
      expect(received[0].p).toEqual(['1700000000000:Pred1']);
      expect(received[0].seq).toBe(1);
    });

    it('should detect gap and emit gapfill:req when seq is skipped', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        includeClientIdentity: true,
      });

      // Intercept gap-fill requests that B sends back to the server
      const gapReqs: GapFillRequest[] = [];
      const events = syncEvents(setup.route.flat);
      // B's Connector emits gapFillReq on clientSocketB → arrives at serverSocketB
      setup.serverSocketB.on(events.gapFillReq, (req: GapFillRequest) => {
        gapReqs.push(req);
      });

      // A sends seq 1 — B receives normally
      setup.connectorA.send('ref-gap-1'); // seq 1

      // Inject a payload with seq 3 directly from the server side to B,
      // simulating a missed seq 2
      const clientIdA = setup.connectorA.clientIdentity!;
      const gapPayload: ConnectorPayload = {
        o: 'different-origin', // different origin so B processes it
        r: 'ref-gap-3',
        c: clientIdA,
        seq: 3,
        __origin: 'test-injected',
      };
      // Server-side socket for B emits → B's client socket receives
      setup.serverSocketB.emit(setup.route.flat, gapPayload);

      // B should detect the gap (expected seq 2, got 3)
      expect(gapReqs.length).toBeGreaterThanOrEqual(1);
      expect(gapReqs[0].afterSeq).toBe(1);
      expect(gapReqs[0].route).toBe(setup.route.flat);
    });

    it('should complete gap-fill round-trip via server ref log', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      // A sends 3 refs — all go through server and into the ref log
      setup.connectorA.send('ref-fill-1');
      setup.connectorA.send('ref-fill-2');
      setup.connectorA.send('ref-fill-3');

      expect(setup.server.refLog).toHaveLength(3);

      // B requests gap-fill for everything after seq 1 via the connector socket
      const gapResponses: GapFillResponse[] = [];
      setup.socketB.on(events.gapFillRes, (res: GapFillResponse) => {
        gapResponses.push(res);
      });

      // B's connector emits on clientSocketB → serverSocketB receives
      const req: GapFillRequest = {
        route: setup.route.flat,
        afterSeq: 1,
      };
      setup.socketB.emit(events.gapFillReq, req);

      expect(gapResponses).toHaveLength(1);
      expect(gapResponses[0].refs).toHaveLength(2);
      expect(gapResponses[0].refs[0].r).toBe('ref-fill-2');
      expect(gapResponses[0].refs[1].r).toBe('ref-fill-3');
      expect(gapResponses[0].route).toBe(setup.route.flat);
    });
  });

  // ===========================================================================
  describe('ACK aggregation end-to-end', () => {
    it('should emit server ACK with ok:true when receiver auto-ACKs', async () => {
      setup = await createE2eSetup({
        requireAck: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      // B's connector auto-sends ackClient on incoming refs
      // (built into Connector._processIncoming when requireAck is set).
      //
      // NOTE: We cannot use sendWithAck() with synchronous sockets because
      // the ACK event fires synchronously during send() — before the
      // sendWithAck listener is registered. This is fine with real Socket.IO
      // where the round-trip is asynchronous. Here we test the same flow
      // by listening directly on the socket.

      const acks: AckPayload[] = [];
      setup.socketA.on(events.ack, (ack: AckPayload) => {
        acks.push(ack);
      });

      setup.connectorA.send('ref-ack-ok');

      expect(acks).toHaveLength(1);
      expect(acks[0].r).toBe('ref-ack-ok');
      expect(acks[0].ok).toBe(true);
      expect(acks[0].receivedBy).toBe(1);
      expect(acks[0].totalClients).toBe(1);
    });

    it('should resolve partial ACK when one of two receivers does not ACK', async () => {
      vi.useFakeTimers();

      setup = await createE2eSetup(
        { requireAck: true, includeClientIdentity: true },
        { numClients: 3, serverOpts: { ackTimeoutMs: 100 } },
      );

      // C's connector auto-ACKs (built-in behavior).
      // Tear down C's connector so it won't ACK anymore. B still will.
      setup.connectorC!.teardown();

      const ackPromise = setup.connectorA
        .sendWithAck('ref-partial-ack')
        .catch((e: Error) => e);

      // B ACKs immediately (synchronous DirectionalSocketMock), C doesn't
      // Advance past server ackTimeoutMs
      vi.advanceTimersByTime(110);

      const result = await ackPromise;
      expect(result).not.toBeInstanceOf(Error);
      const ack = result as AckPayload;
      expect(ack.r).toBe('ref-partial-ack');
      expect(ack.ok).toBe(false);
      expect(ack.receivedBy).toBe(1); // only B
      expect(ack.totalClients).toBe(2); // B + C

      vi.useRealTimers();
    });

    it('should verify ACK payload field integrity', async () => {
      setup = await createE2eSetup({
        requireAck: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      // Listen for raw ACK on A's client socket
      const rawAcks: AckPayload[] = [];
      setup.socketA.on(events.ack, (ack: AckPayload) => {
        rawAcks.push(ack);
      });

      setup.connectorA.send('ref-ack-fields');

      expect(rawAcks).toHaveLength(1);
      const ack = rawAcks[0];
      // Required fields
      expect(typeof ack.r).toBe('string');
      expect(ack.r).toBe('ref-ack-fields');
      expect(typeof ack.ok).toBe('boolean');
      expect(ack.ok).toBe(true);
      // Optional fields present when receivers exist
      expect(typeof ack.receivedBy).toBe('number');
      expect(typeof ack.totalClients).toBe('number');
      expect(ack.receivedBy).toBe(1);
      expect(ack.totalClients).toBe(1);
    });
  });

  // ===========================================================================
  describe('Combined features — full hardening', () => {
    it('should handle multi-send with all flags cooperating', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) {
          received.push(p);
        }
      });

      const acks: AckPayload[] = [];
      setup.socketA.on(events.ack, (ack: AckPayload) => {
        acks.push(ack);
      });

      setup.connectorA.send('ref-combined-1');
      setup.connectorA.send('ref-combined-2');
      setup.connectorA.send('ref-combined-3');

      // All 3 should arrive at B with correct fields
      expect(received).toHaveLength(3);
      expect(received[0].seq).toBe(1);
      expect(received[1].seq).toBe(2);
      expect(received[2].seq).toBe(3);

      // All 3 should have client identity
      for (const p of received) {
        expect(p.c).toBeDefined();
        expect(p.t).toBeDefined();
      }

      // All 3 ACKs should be ok:true (B auto-ACKs)
      expect(acks).toHaveLength(3);
      for (const ack of acks) {
        expect(ack.ok).toBe(true);
        expect(ack.receivedBy).toBe(1);
        expect(ack.totalClients).toBe(1);
      }

      // Ref log should have all 3
      expect(setup.server.refLog).toHaveLength(3);
    });

    it('should fan out to multiple receivers with correct ACK counts', async () => {
      setup = await createE2eSetup(
        {
          causalOrdering: true,
          requireAck: true,
          includeClientIdentity: true,
        },
        { numClients: 3 },
      );

      const events = syncEvents(setup.route.flat);

      // Both B and C should receive the ref
      const receivedByB: ConnectorPayload[] = [];
      const receivedByC: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) receivedByB.push(p);
      });
      setup.socketC!.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorC!.origin) receivedByC.push(p);
      });

      // Listen for ACK directly (sendWithAck doesn't work with sync sockets)
      const acks: AckPayload[] = [];
      setup.socketA.on(events.ack, (ack: AckPayload) => {
        acks.push(ack);
      });

      setup.connectorA.send('ref-fanout');

      expect(receivedByB).toHaveLength(1);
      expect(receivedByC).toHaveLength(1);
      expect(receivedByB[0].r).toBe('ref-fanout');
      expect(receivedByC[0].r).toBe('ref-fanout');

      // ACK should report both B and C acknowledged
      expect(acks).toHaveLength(1);
      expect(acks[0].ok).toBe(true);
      expect(acks[0].receivedBy).toBe(2);
      expect(acks[0].totalClients).toBe(2);
    });

    it('should support gap-fill combined with ACK', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      // A sends 3 refs (all reach B and server ref log)
      setup.connectorA.send('ref-gap-ack-1');
      setup.connectorA.send('ref-gap-ack-2');
      setup.connectorA.send('ref-gap-ack-3');

      expect(setup.server.refLog).toHaveLength(3);

      // B requests gap-fill for refs after seq 1
      const gapResponses: GapFillResponse[] = [];
      setup.socketB.on(events.gapFillRes, (res: GapFillResponse) => {
        gapResponses.push(res);
      });

      setup.socketB.emit(events.gapFillReq, {
        route: setup.route.flat,
        afterSeq: 1,
      });

      // Should get seq 2 and 3 back
      expect(gapResponses).toHaveLength(1);
      expect(gapResponses[0].refs).toHaveLength(2);
      expect(gapResponses[0].refs[0].seq).toBe(2);
      expect(gapResponses[0].refs[1].seq).toBe(3);
    });
  });

  // ===========================================================================
  describe('Wire format validation', () => {
    it('should produce only o and r with no syncConfig', async () => {
      setup = await createE2eSetup();

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) received.push(p);
      });

      setup.connectorA.send('ref-wire-minimal');

      expect(received).toHaveLength(1);
      const keys = Object.keys(received[0]).filter((k) => k !== '__origin');
      expect(keys.sort()).toEqual(['o', 'r']);
    });

    it('should include all enrichment fields when all flags set', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        requireAck: true,
        includeClientIdentity: true,
      });

      const received: ConnectorPayload[] = [];
      setup.socketB.on(setup.route.flat, (p: ConnectorPayload) => {
        if (p.o !== setup.connectorB.origin) received.push(p);
      });

      setup.connectorA.setPredecessors(['1700000000000:Pred1']);
      setup.connectorA.send('ref-wire-full');

      expect(received).toHaveLength(1);
      const p = received[0];
      // Remove __origin (server-added for loop prevention)
      const keys = Object.keys(p).filter((k) => k !== '__origin');
      expect(keys.sort()).toEqual(['c', 'o', 'p', 'r', 'seq', 't']);

      // Type and value checks
      expect(typeof p.r).toBe('string');
      expect(typeof p.o).toBe('string');
      expect(typeof p.c).toBe('string');
      expect(p.c!.startsWith('client_')).toBe(true);
      expect(typeof p.t).toBe('number');
      expect(typeof p.seq).toBe('number');
      expect(p.seq).toBe(1);
      expect(Array.isArray(p.p)).toBe(true);
      expect(p.p).toEqual(['1700000000000:Pred1']);
    });

    it('should produce correct GapFillResponse format', async () => {
      setup = await createE2eSetup({
        causalOrdering: true,
        includeClientIdentity: true,
      });

      const events = syncEvents(setup.route.flat);

      // Populate ref log
      setup.connectorA.send('ref-gap-fmt-1');
      setup.connectorA.send('ref-gap-fmt-2');

      const responses: GapFillResponse[] = [];
      setup.socketB.on(events.gapFillRes, (res: GapFillResponse) => {
        responses.push(res);
      });

      setup.socketB.emit(events.gapFillReq, {
        route: setup.route.flat,
        afterSeq: 0,
      });

      expect(responses).toHaveLength(1);
      const res = responses[0];
      // Top-level fields
      expect(typeof res.route).toBe('string');
      expect(res.route).toBe(setup.route.flat);
      expect(Array.isArray(res.refs)).toBe(true);
      expect(res.refs).toHaveLength(2);

      // Each ref entry is a ConnectorPayload
      for (const ref of res.refs) {
        expect(typeof ref.r).toBe('string');
        expect(typeof ref.o).toBe('string');
        expect(typeof ref.seq).toBe('number');
        expect(typeof ref.c).toBe('string');
      }
      expect(res.refs[0].seq).toBe(1);
      expect(res.refs[1].seq).toBe(2);
    });
  });
});
