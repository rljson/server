// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { stateBeaconEvent } from '@rljson/db';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
import {
  ConnectorPayload,
  GapFillResponse,
  Route,
  syncEvents,
} from '@rljson/rljson';

import { afterEach, describe, expect, it } from 'vitest';

import { peerReadEvents } from '../src/peer-reads.ts';
import { Server, ServerOptions } from '../src/server.ts';

// .............................................................................
// The hub knows which node holds which ref of its route: the sender of a
// relayed ref, and every node whose client says `held`. It sends each client
// the holders of its own tenant with the relayed refs, the bootstrap, the
// heartbeat and the state beacon, and forgets a node with its last connection.
// .............................................................................

const route = Route.fromFlat('holders');
const events = syncEvents(route.flat);

interface Connection {
  hubSide: DirectionalSocketMock;
  clientSide: DirectionalSocketMock;
  clientId: string;
  /** Relayed refs this connection received. */
  received: ConnectorPayload[];
  /** Bootstraps this connection received. */
  bootstraps: ConnectorPayload[];
}

describe('Server holders', () => {
  let server: Server;

  const createServer = async (options: ServerOptions = {}) => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    server = new Server(route, io, new BsMem(), {
      refEvictionIntervalMs: 0,
      ...options,
    });
    await server.init();
  };

  const connect = async (
    nodeId?: string,
    tenantId?: string,
  ): Promise<Connection> => {
    const [hubSide, clientSide] = createSocketPair();
    if (tenantId !== undefined) {
      (hubSide as unknown as { data: object }).data = { tenantId };
    }
    hubSide.connect();
    const received: ConnectorPayload[] = [];
    const bootstraps: ConnectorPayload[] = [];
    clientSide.on(route.flat, (p: ConnectorPayload) => received.push(p));
    clientSide.on(events.bootstrap, (p: ConnectorPayload) => bootstraps.push(p));
    await server.addSocket(hubSide);
    if (nodeId !== undefined) {
      clientSide.emit(peerReadEvents.hello, { nodeId });
    }
    const clientId = (hubSide as unknown as { __clientId: string }).__clientId;
    return { hubSide, clientSide, clientId, received, bootstraps };
  };

  afterEach(async () => {
    if (server && !server.isTornDown) await server.tearDown();
  });

  describe('a relayed ref', () => {
    it('names its sender as holder', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      expect(b.received[0]).toMatchObject({
        r: 'ref-1',
        holders: { 'node-a': 'ref-1' },
      });
      expect(server.holders).toEqual({ 'node-a': 'ref-1' });
    });

    it('moves its sender on to the newer ref', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-2' });

      expect(b.received[1].holders).toEqual({ 'node-a': 'ref-2' });
    });

    it('carries no holders while no node is known', async () => {
      await createServer();
      const a = await connect();
      const b = await connect();

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      expect(b.received[0]).toEqual({ o: 'o-a', r: 'ref-1', __origin: a.clientId });
      expect(server.holders).toEqual({});
    });

    it('drops the holders a sender put there itself', async () => {
      await createServer();
      const a = await connect();
      const b = await connect();

      a.clientSide.emit(route.flat, {
        o: 'o-a',
        r: 'ref-1',
        holders: { 'node-forged': 'ref-1' },
      });

      expect('holders' in b.received[0]).toBe(false);
    });

    it('replaces the holders a sender put there with the known ones', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');

      a.clientSide.emit(route.flat, {
        o: 'o-a',
        r: 'ref-1',
        holders: { 'node-forged': 'ref-1' },
      });

      expect(b.received[0].holders).toEqual({ 'node-a': 'ref-1' });
    });

    it('names a sender that re-announces a ref the hub suppresses', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');
      const c = await connect('node-c');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      // b announces the same state without a sequence: suppressed, not
      // relayed — but b holds it.
      b.clientSide.emit(route.flat, { o: 'o-b', r: 'ref-1' });

      expect(c.received).toHaveLength(1);
      expect(server.holders).toEqual({ 'node-a': 'ref-1', 'node-b': 'ref-1' });
    });

    it('keeps the ref log free of holders', async () => {
      await createServer({ syncConfig: { causalOrdering: true } });
      const a = await connect('node-a');
      const b = await connect('node-b');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1', c: 'c-a', seq: 1 });
      expect(b.received[0].holders).toEqual({ 'node-a': 'ref-1' });

      const responses: GapFillResponse[] = [];
      b.clientSide.on(events.gapFillRes, (res: GapFillResponse) =>
        responses.push(res),
      );
      b.clientSide.emit(events.gapFillReq, { route: route.flat, afterSeq: 0 });

      expect(responses[0].refs).toHaveLength(1);
      expect(responses[0].refs[0].r).toBe('ref-1');
      expect('holders' in responses[0].refs[0]).toBe(false);
    });
  });

  describe('a held payload', () => {
    it('names the node of the connection as holder', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');
      const c = await connect('node-c');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      b.clientSide.emit(events.held, { r: 'ref-1' });
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-2' });

      expect(c.received[1].holders).toEqual({
        'node-a': 'ref-2',
        'node-b': 'ref-1',
      });
    });

    it('is ignored while the connection has not said hello', async () => {
      await createServer();
      const a = await connect();

      a.clientSide.emit(events.held, { r: 'ref-1' });

      expect(server.holders).toEqual({});
    });

    it('is ignored without a usable ref', async () => {
      await createServer();
      const a = await connect('node-a');

      a.clientSide.emit(events.held);
      a.clientSide.emit(events.held, {});
      a.clientSide.emit(events.held, { r: 42 });
      a.clientSide.emit(events.held, { r: '' });

      expect(server.holders).toEqual({});
    });
  });

  describe('a node', () => {
    it('stops being a holder when its connection ends', async () => {
      await createServer();
      const a = await connect('node-a');
      const b = await connect('node-b');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      await server.removeSocket(a.clientId);

      expect(server.holders).toEqual({});
      b.clientSide.emit(route.flat, { o: 'o-b', r: 'ref-2' });
      expect(server.holders).toEqual({ 'node-b': 'ref-2' });
    });

    it('stays a holder while another of its connections is open', async () => {
      await createServer();
      const a1 = await connect('node-a');
      const a2 = await connect('node-a');

      a1.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      await server.removeSocket(a1.clientId);
      expect(server.holders).toEqual({ 'node-a': 'ref-1' });

      await server.removeSocket(a2.clientId);
      expect(server.holders).toEqual({});
    });

    it('that a connection no longer says it is stops being a holder', async () => {
      await createServer();
      const a = await connect('node-old');

      a.clientSide.emit(events.held, { r: 'ref-1' });
      a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-new' });

      expect(server.holders).toEqual({});
      a.clientSide.emit(events.held, { r: 'ref-1' });
      expect(server.holders).toEqual({ 'node-new': 'ref-1' });
    });

    it('keeps its entry when its connection says hello again', async () => {
      await createServer();
      const a = await connect('node-a');

      a.clientSide.emit(events.held, { r: 'ref-1' });
      a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });

      expect(server.holders).toEqual({ 'node-a': 'ref-1' });
    });
  });

  describe('the holders sent', () => {
    it('go out with the bootstrap of a new connection', async () => {
      await createServer();
      const a = await connect('node-a');
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      const b = await connect('node-b');

      expect(b.bootstraps[0]).toMatchObject({
        r: 'ref-1',
        holders: { 'node-a': 'ref-1' },
      });
    });

    it('go out with the bootstrap heartbeat', async () => {
      await createServer({ syncConfig: { bootstrapHeartbeatMs: 10 } });
      const a = await connect('node-a');
      const b = await connect('node-b');
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      await expect
        .poll(() => b.bootstraps.some((p) => p.holders?.['node-a'] === 'ref-1'))
        .toBe(true);
    });

    it('go out with the state beacon', async () => {
      await createServer({ stateBeaconMs: 10 });
      const a = await connect('node-a');
      const b = await connect('node-b');
      const beacons: ConnectorPayload[] = [];
      b.clientSide.on(stateBeaconEvent(route.flat), (p: ConnectorPayload) =>
        beacons.push(p),
      );
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      await expect
        .poll(() => beacons.some((p) => p.holders?.['node-a'] === 'ref-1'))
        .toBe(true);
    });

    it('are those of the receiver’s tenant only', async () => {
      await createServer();
      const a = await connect('node-a', 'tenant-1');
      const b = await connect('node-b', 'tenant-1');
      const x = await connect('node-x', 'tenant-2');
      const y = await connect('node-y', 'tenant-2');

      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });
      x.clientSide.emit(route.flat, { o: 'o-x', r: 'ref-9' });

      expect(b.received[0].holders).toEqual({ 'node-a': 'ref-1' });
      expect(y.received[0].holders).toEqual({ 'node-x': 'ref-9' });
      expect(server.holders).toEqual({ 'node-a': 'ref-1', 'node-x': 'ref-9' });
    });

    it('leave tenant-less clients without the holders of a tenant', async () => {
      await createServer();
      const a = await connect('node-a', 'tenant-1');
      a.clientSide.emit(route.flat, { o: 'o-a', r: 'ref-1' });

      const b = await connect('node-b');

      expect(b.bootstraps[0].r).toBe('ref-1');
      expect('holders' in b.bootstraps[0]).toBe(false);
    });
  });
});
