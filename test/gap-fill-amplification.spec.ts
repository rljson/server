// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route, syncEvents } from '@rljson/rljson';
import { afterEach, describe, expect, it } from 'vitest';

import { BufferedLogger } from '../src/logger';
import { Server } from '../src/server';

import type { GapFillResponse, SyncConfig } from '@rljson/rljson';

/**
 * What a gap-fill response costs, and what asks for one.
 *
 * On 2026-09-29 the cloud EventHub died nine minutes after a deploy: **858
 * oversized `JSON.stringify` calls in 18.2 seconds**, heap to 990 MB,
 * `FATAL ERROR: Reached heap limit`, inside socket.io's OUTBOUND packet encoder.
 * It began four seconds after a second hub joined a route that already had one.
 *
 * The serving gate could not bound it — `withBackpressure` wraps `socket.on`,
 * and this is `socket.emit` going out — so the size of what is emitted is the
 * only thing left to bound.
 */
describe('Server — what a gap-fill response weighs', () => {
  let server: Server;

  afterEach(async () => {
    if (server && !server.isTornDown) await server.tearDown();
  });

  const makeServer = async (
    route: Route,
    syncConfig: SyncConfig,
  ): Promise<Server> => {
    const io = new IoMem();
    await io.init();
    const s = new Server(route, io, new BsMem(), {
      logger: new BufferedLogger(),
      syncConfig,
      refEvictionIntervalMs: 0,
    });
    await s.init();
    return s;
  };

  const addClient = async (s: Server): Promise<SocketMock> => {
    const socket = new SocketMock();
    socket.connect();
    await s.addSocket(socket);
    return socket;
  };

  it('splits a full ref log across packets, none of them oversized', async () => {
    // The breadcrumb from the crash said: a 2-item array whose payload exceeds
    // 64 kB. A socket.io packet is `[eventName, payload]`, and this is the only
    // payload in the protocol that can reach that size — measured here rather
    // than reasoned about, because three earlier candidates looked plausible and
    // were not it.
    const route = Route.fromFlat('gapFillWeight');
    const events = syncEvents(route.flat);
    server = await makeServer(route, { causalOrdering: true });

    const sender = await addClient(server);
    const asker = await addClient(server);

    // A full ref log. 1000 is the default `refLogSize`, so this is the steady
    // state of any long-lived hub, not a pathological case.
    const total = server.refLogSize;
    for (let seq = 1; seq <= total; seq++) {
      sender.emit(route.flat, {
        o: `origin-${String(seq)}`,
        r: `HASH${String(seq).padStart(18, 'x')}`,
        c: 'sender-client',
        seq,
        // One predecessor, which is what an ordinary linear history carries.
        p: [`PRED${String(seq).padStart(18, 'y')}`],
      });
    }
    expect(server.refLog).toHaveLength(total);

    const responses: GapFillResponse[] = [];
    asker.on(events.gapFillRes, (res: GapFillResponse) => responses.push(res));
    asker.emit(events.gapFillReq, { route: route.flat, afterSeq: 0 });

    // Every ref still arrives — batching must not lose the newest half of a
    // hub's history, which is the mistake a plain cap would make.
    const delivered = responses.flatMap((r) => r.refs);
    expect(delivered).toHaveLength(total);
    expect(delivered.map((r) => r.seq)).toEqual(
      Array.from({ length: total }, (_, i) => i + 1),
    );
    expect(responses.length).toBeGreaterThan(1);

    // And no single packet is one of the oversized ones that killed the hub.
    for (const res of responses) {
      const wire = Buffer.byteLength(
        JSON.stringify([events.gapFillRes, res]),
        'utf8',
      );
      expect(
        wire,
        'one gap-fill packet is still over the 64 kB the crash reported',
      ).toBeLessThan(64 * 1024);
    }
  });

  it('still answers an empty log, so a client is never left waiting', async () => {
    const route = Route.fromFlat('gapFillEmptyBatched');
    const events = syncEvents(route.flat);
    server = await makeServer(route, { causalOrdering: true });
    const asker = await addClient(server);

    const responses: GapFillResponse[] = [];
    asker.on(events.gapFillRes, (res: GapFillResponse) => responses.push(res));
    asker.emit(events.gapFillReq, { route: route.flat, afterSeq: 0 });

    expect(responses).toHaveLength(1);
    expect(responses[0].refs).toEqual([]);
  });

  it('answers EVERY request in full, so the cost scales with how often it is asked', async () => {
    // The amplifier. The response is not paged and carries no cursor, so a
    // client that asks ten times is sent the entire log ten times — and the
    // encoder runs once per emit, per receiver. 858 of these in 18 seconds is
    // what exhausted a 1 GB heap.
    const route = Route.fromFlat('gapFillRepeat');
    const events = syncEvents(route.flat);
    server = await makeServer(route, { causalOrdering: true });

    const sender = await addClient(server);
    const asker = await addClient(server);

    for (let seq = 1; seq <= 200; seq++) {
      sender.emit(route.flat, {
        o: `origin-${String(seq)}`,
        r: `HASH${String(seq).padStart(18, 'x')}`,
        c: 'sender-client',
        seq,
      });
    }

    let bytes = 0;
    asker.on(events.gapFillRes, (res: GapFillResponse) => {
      bytes += Buffer.byteLength(JSON.stringify([events.gapFillRes, res]), 'utf8');
    });

    const asks = 10;
    for (let i = 0; i < asks; i++) {
      asker.emit(events.gapFillReq, { route: route.flat, afterSeq: 0 });
    }

    // Ten identical questions, ten full answers. Nothing in the protocol lets
    // the second one cost less than the first.
    expect(bytes).toBeGreaterThan(asks * 200 * 40);
  });
});
