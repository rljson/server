// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { RefStamp, Route, syncEvents } from '@rljson/rljson';

import { afterEach, describe, expect, it } from 'vitest';

import { Server, ServerOptions } from '../src/server';

const waitMicrotasks = () => new Promise<void>((r) => setImmediate(r));

const route = Route.fromFlat('stampRoute');
const events = syncEvents(route.flat);
const office = { domain: 'office', hub: 'hub-a' };

describe('Server — stamping what it relays', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.tearDown();
  });

  /** A server with two connected clients, `a` sending and `b` receiving. */
  const twoClients = async (options: ServerOptions = {}) => {
    const io = new IoMem();
    await io.init();
    const server = new Server(route, io, new BsMem(), options);
    await server.init();
    servers.push(server);

    const a = new SocketMock();
    const b = new SocketMock();
    a.connect();
    b.connect();
    await server.addSocket(a);
    await server.addSocket(b);

    const delivered: Array<Record<string, unknown>> = [];
    b.on(route.flat, (p: Record<string, unknown>) => delivered.push(p));
    const notices: Array<{ r: string; stamp: RefStamp }> = [];
    a.on(events.stamp, (p: { r: string; stamp: RefStamp }) => notices.push(p));

    const send = async (payload: Record<string, unknown>) => {
      a.emit(route.flat, payload);
      await waitMicrotasks();
    };
    return { server, a, b, delivered, notices, send };
  };

  it('stamps each new ref in order and tells only the sender its stamp', async () => {
    const hooked: unknown[] = [];
    const { delivered, notices, send, b } = await twoClients({
      stamp: office,
      onRefArrived: (ctx) => {
        hooked.push(ctx.stamp);
      },
    });
    const bNotices: unknown[] = [];
    b.on(events.stamp, (p: unknown) => bNotices.push(p));

    await send({ o: 'a', r: 'ref-1' });
    await send({ o: 'a', r: 'ref-2' });

    const first = { domain: 'office', epoch: 1, hub: 'hub-a', n: 1 };
    const second = { ...first, n: 2 };
    expect(delivered.map((p) => p.stamp)).toEqual([first, second]);
    expect(notices).toEqual([
      { r: 'ref-1', stamp: first },
      { r: 'ref-2', stamp: second },
    ]);
    expect(hooked).toEqual([first, second]);
    expect(bNotices).toEqual([]);
  });

  it('tells the sender its stamp again when a re-announcement is suppressed', async () => {
    const { delivered, notices, send } = await twoClients({ stamp: office });

    await send({ o: 'a', r: 'ref-1' });
    // No client identity, so the duplicate check cannot tell a sender that
    // moved on from an echo, and holds it back.
    await send({ o: 'a', r: 'ref-1' });

    const stamp = { domain: 'office', epoch: 1, hub: 'hub-a', n: 1 };
    expect(delivered).toHaveLength(1);
    expect(notices).toEqual([
      { r: 'ref-1', stamp },
      { r: 'ref-1', stamp },
    ]);
  });

  it('suppresses a duplicate silently when it does not stamp', async () => {
    const { delivered, notices, send } = await twoClients();
    await send({ o: 'a', r: 'ref-1' });
    await send({ o: 'a', r: 'ref-1' });
    expect(delivered).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('forwards a carried stamp unchanged, and does not count it', async () => {
    const { delivered, notices, send } = await twoClients({ stamp: office });
    const carried: RefStamp = { domain: 'office', epoch: 0, hub: 'hub-z', n: 40 };

    await send({ o: 'a', r: 'ref-1', stamp: carried });
    await send({ o: 'a', r: 'ref-2' });

    expect(delivered.map((p) => p.stamp)).toEqual([
      carried,
      { domain: 'office', epoch: 1, hub: 'hub-a', n: 1 },
    ]);
    expect(notices[0]).toEqual({ r: 'ref-1', stamp: carried });
  });

  it('carries ONE stamp through two servers in sequence — the first one’s', async () => {
    const first = await twoClients({ stamp: office });
    const second = await twoClients({ stamp: { domain: 'office', hub: 'hub-b' } });

    await first.send({ o: 'a', r: 'ref-1' });
    // A bridge re-emits what it received into the second server.
    const crossing = first.delivered[0];
    await second.send({ o: 'bridge', r: crossing.r, stamp: crossing.stamp });

    expect(second.delivered[0].stamp).toEqual(first.delivered[0].stamp);
    expect(second.delivered[0].stamp).toMatchObject({ hub: 'hub-a' });
  });

  it('relays as before when it does not stamp — but passes a carried stamp on', async () => {
    const hooked: unknown[] = [];
    const { delivered, notices, send } = await twoClients({
      onRefArrived: (ctx) => {
        hooked.push('stamp' in ctx ? ctx.stamp : 'none');
      },
    });
    const carried: RefStamp = { domain: 'office', epoch: 3, hub: 'hub-z', n: 1 };

    await send({ o: 'a', r: 'ref-1' });
    await send({ o: 'a', r: 'ref-2', stamp: carried });
    await send({ o: 'a', r: 'ref-3', stamp: { domain: 'broken' } });

    expect(delivered.map((p) => 'stamp' in p)).toEqual([false, true, true]);
    expect(delivered[1].stamp).toEqual(carried);
    expect(hooked).toEqual(['none', carried, 'none']);
    expect(notices).toEqual([]);
  });

  it('puts the latest ref’s stamp on the bootstrap a new client gets', async () => {
    const { server, send } = await twoClients({ stamp: office });
    await send({ o: 'a', r: 'ref-1' });

    const late = new SocketMock();
    late.connect();
    const bootstraps: Array<Record<string, unknown>> = [];
    late.on(events.bootstrap, (p: Record<string, unknown>) => bootstraps.push(p));
    await server.addSocket(late);
    await waitMicrotasks();

    expect(bootstraps[0]).toMatchObject({
      r: 'ref-1',
      stamp: { domain: 'office', epoch: 1, hub: 'hub-a', n: 1 },
    });
  });

  it('keeps the stamp in the ref log a gap-fill replays', async () => {
    const { server, send } = await twoClients({
      stamp: office,
      syncConfig: { causalOrdering: true },
    });
    await send({ o: 'a', r: 'ref-1', c: 'client_AAAAAAAAAAAA', seq: 1 });

    const log = (server as unknown as { _refLog: Array<Record<string, unknown>> })
      ._refLog;
    expect(log[0].stamp).toEqual({ domain: 'office', epoch: 1, hub: 'hub-a', n: 1 });
  });
});
