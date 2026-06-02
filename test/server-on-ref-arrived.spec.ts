// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { describe, expect, it, vi } from 'vitest';

import { BufferedLogger } from '../src/logger';
import { Server } from '../src/server';

// .............................................................................
// New behaviour added with the EventHub upstream change:
//   1. ServerOptions.onRefArrived hook is awaited before multicast.
//   2. If the hook throws, the ref is dropped (neither archived nor forwarded).
//   3. Multicast is tenant-scoped: when the sender socket has a
//      `data.tenantId` pinned by an external auth middleware, only sockets
//      with the same `data.tenantId` receive the ref.
// .............................................................................

const waitMicrotasks = () => new Promise<void>((r) => setImmediate(r));

describe('Server.onRefArrived & tenant-keyed multicast', () => {
  it('invokes onRefArrived with full context before fan-out', async () => {
    const io = new IoMem();
    await io.init();
    const bs = new BsMem();
    const route = Route.fromFlat('hookRoute');

    const calls: any[] = [];
    const order: string[] = [];

    const server = new Server(route, io, bs, {
      onRefArrived: async (ctx) => {
        order.push('hook');
        calls.push(ctx);
      },
    });
    await server.init();

    const socketA = new SocketMock();
    const socketB = new SocketMock();
    socketA.connect();
    socketB.connect();
    (socketA as any).data = { tenantId: 'tenant-1' };
    (socketB as any).data = { tenantId: 'tenant-1' };
    await server.addSocket(socketA);
    await server.addSocket(socketB);

    socketB.on(route.flat, () => order.push('deliver'));

    socketA.emit(route.flat, { r: 'ref-1' });
    await waitMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].tenantId).toBe('tenant-1');
    expect(calls[0].route).toBe('/hookRoute');
    expect(calls[0].ref).toBe('ref-1');
    expect(typeof calls[0].sourceNodeId).toBe('string');
    expect(calls[0].sourceNodeId).toMatch(/^client_/);
    expect(order[0]).toBe('hook');
    expect(order).toContain('deliver');

    await server.tearDown();
  });

  it('passes tenantId=undefined when sender has no data.tenantId', async () => {
    const io = new IoMem();
    await io.init();
    const bs = new BsMem();
    const route = Route.fromFlat('hookRouteAnon');

    const calls: any[] = [];
    const server = new Server(route, io, bs, {
      onRefArrived: (ctx) => {
        calls.push(ctx);
      },
    });
    await server.init();

    const socketA = new SocketMock();
    const socketB = new SocketMock();
    socketA.connect();
    socketB.connect();
    await server.addSocket(socketA);
    await server.addSocket(socketB);

    socketA.emit(route.flat, { r: 'ref-anon' });
    await waitMicrotasks();

    expect(calls).toHaveLength(1);
    expect(calls[0].tenantId).toBeUndefined();
    expect(calls[0].ref).toBe('ref-anon');

    await server.tearDown();
  });

  it('drops the ref when onRefArrived throws (no multicast)', async () => {
    const logger = new BufferedLogger();
    const io = new IoMem();
    await io.init();
    const bs = new BsMem();
    const route = Route.fromFlat('hookFailRoute');

    const server = new Server(route, io, bs, {
      logger,
      onRefArrived: async () => {
        throw new Error('archive down');
      },
    });
    await server.init();

    const socketA = new SocketMock();
    const socketB = new SocketMock();
    socketA.connect();
    socketB.connect();
    await server.addSocket(socketA);
    await server.addSocket(socketB);

    const receivedB = vi.fn();
    socketB.on(route.flat, receivedB);

    socketA.emit(route.flat, { r: 'ref-drop' });
    await waitMicrotasks();

    expect(receivedB).not.toHaveBeenCalled();
    expect(
      logger
        .byLevel('error')
        .some(
          (e) =>
            (e as any).data?.['ref'] === 'ref-drop' &&
            (e.message as string).includes('onRefArrived'),
        ),
    ).toBe(true);

    await server.tearDown();
  });

  it('does NOT deliver across tenants', async () => {
    const io = new IoMem();
    await io.init();
    const bs = new BsMem();
    const route = Route.fromFlat('tenantScopedRoute');

    const server = new Server(route, io, bs);
    await server.init();

    const sender = new SocketMock();
    const sameTenant = new SocketMock();
    const otherTenant = new SocketMock();
    sender.connect();
    sameTenant.connect();
    otherTenant.connect();
    (sender as any).data = { tenantId: 't1' };
    (sameTenant as any).data = { tenantId: 't1' };
    (otherTenant as any).data = { tenantId: 't2' };

    await server.addSocket(sender);
    await server.addSocket(sameTenant);
    await server.addSocket(otherTenant);

    const sameSeen = vi.fn();
    const otherSeen = vi.fn();
    sameTenant.on(route.flat, sameSeen);
    otherTenant.on(route.flat, otherSeen);

    sender.emit(route.flat, { r: 'ref-tenant' });
    await waitMicrotasks();

    expect(sameSeen).toHaveBeenCalledTimes(1);
    expect(otherSeen).not.toHaveBeenCalled();

    await server.tearDown();
  });

  it('untagged senders only reach untagged receivers (tenant pin asymmetry)', async () => {
    const io = new IoMem();
    await io.init();
    const bs = new BsMem();
    const route = Route.fromFlat('tenantAsymRoute');

    const server = new Server(route, io, bs);
    await server.init();

    const anon = new SocketMock();
    const otherAnon = new SocketMock();
    const tagged = new SocketMock();
    anon.connect();
    otherAnon.connect();
    tagged.connect();
    (tagged as any).data = { tenantId: 't1' };

    await server.addSocket(anon);
    await server.addSocket(otherAnon);
    await server.addSocket(tagged);

    const anonSeen = vi.fn();
    const taggedSeen = vi.fn();
    otherAnon.on(route.flat, anonSeen);
    tagged.on(route.flat, taggedSeen);

    anon.emit(route.flat, { r: 'ref-anon-out' });
    await waitMicrotasks();

    expect(anonSeen).toHaveBeenCalledTimes(1);
    expect(taggedSeen).not.toHaveBeenCalled();

    await server.tearDown();
  });
});
