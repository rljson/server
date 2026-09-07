// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';
import { describe, expect, it, vi } from 'vitest';

import { ServeGate, withBackpressure } from '../src/backpressure';

/** A socket whose send-queue depth the test controls. */
class FakeSocket {
  bufferedAmount = 0;
  connected = true;
  disconnected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  emitted: Array<[string | symbol, unknown[]]> = [];
  removedAll: Array<string | symbol | undefined> = [];
  handlers = new Map<string | symbol, Array<(...a: unknown[]) => void>>();

  connect(): void {
    this.connectCalls++;
  }
  disconnect(): void {
    this.disconnectCalls++;
  }
  emit(event: string | symbol, ...args: unknown[]): this {
    this.emitted.push([event, args]);
    return this;
  }
  on(event: string | symbol, handler: (...a: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string | symbol, handler: (...a: unknown[]) => void): this {
    const list = (this.handlers.get(event) ?? []).filter((h) => h !== handler);
    this.handlers.set(event, list);
    return this;
  }
  removeAllListeners(event?: string | symbol): this {
    this.removedAll.push(event);
    this.handlers.clear();
    return this;
  }
  fire(event: string | symbol, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('withBackpressure', () => {
  it('serves immediately while the consumer is draining', async () => {
    const raw = new FakeSocket();
    const gated = withBackpressure(raw as unknown as Socket, {
      highWaterMark: 100,
      pollMs: 1,
    });
    const served = vi.fn();
    gated.on('read', served);

    raw.fire('read', 'arg');
    await tick(5);
    expect(served).toHaveBeenCalledWith('arg');
  });

  it('holds a request back until the queue drains', async () => {
    const raw = new FakeSocket();
    const gated = withBackpressure(raw as unknown as Socket, {
      highWaterMark: 100,
      maxWaitMs: 2000,
      pollMs: 1,
    });
    const served = vi.fn();
    gated.on('read', served);

    // The consumer is behind: the hub must stop producing answers for it.
    raw.bufferedAmount = 5000;
    raw.fire('read');
    await tick(20);
    expect(served, 'served a consumer that was not draining').not.toHaveBeenCalled();

    raw.bufferedAmount = 0;
    await tick(20);
    expect(served).toHaveBeenCalledTimes(1);
  });

  it('serves anyway once the wait budget is spent', async () => {
    // A consumer that never drains must degrade into slow answers, never into
    // a stalled hub.
    const raw = new FakeSocket();
    const gated = withBackpressure(raw as unknown as Socket, {
      highWaterMark: 100,
      maxWaitMs: 30,
      pollMs: 1,
    });
    const served = vi.fn();
    gated.on('read', served);

    raw.bufferedAmount = 5000;
    raw.fire('read');
    await tick(120);
    expect(served).toHaveBeenCalledTimes(1);
  });

  it('passes the rest of the socket through, and unregisters what it registered', async () => {
    const raw = new FakeSocket();
    const gated = withBackpressure(raw as unknown as Socket, { pollMs: 1 });

    expect(gated.connected).toBe(true);
    expect(gated.disconnected).toBe(false);
    expect((gated as unknown as { bufferedAmount: number }).bufferedAmount).toBe(0);
    gated.connect();
    gated.disconnect();
    expect(raw.connectCalls).toBe(1);
    expect(raw.disconnectCalls).toBe(1);
    gated.emit('hello', 1);
    expect(raw.emitted).toEqual([['hello', [1]]]);

    // `off` has to find the GATED wrapper, not the caller's handler.
    const served = vi.fn();
    gated.on('read', served);
    expect(raw.handlers.get('read')).toHaveLength(1);
    (gated as unknown as { off: (e: string, h: unknown) => void }).off('read', served);
    expect(raw.handlers.get('read')).toHaveLength(0);
    // Unknown handler falls through to the raw socket unchanged.
    (gated as unknown as { off: (e: string, h: unknown) => void }).off('read', vi.fn());

    gated.on('read', served);
    (
      gated as unknown as { removeAllListeners: (e?: string) => void }
    ).removeAllListeners('read');
    expect(raw.removedAll).toEqual(['read']);
  });

  it('treats a transport that cannot report a queue as drained', async () => {
    const raw = new FakeSocket() as unknown as Record<string, unknown>;
    delete raw['bufferedAmount'];
    const gated = withBackpressure(raw as unknown as Socket, {
      highWaterMark: 0,
      pollMs: 1,
    });
    const served = vi.fn();
    gated.on('read', served);
    (raw as unknown as FakeSocket).fire('read');
    await tick(5);
    expect(served).toHaveBeenCalledTimes(1);
  });
  it('reports every wait, so a gated hub is not mistaken for an idle one', async () => {
    // A hub whose handlers are all asleep in the gate looks exactly like a hub
    // with nothing to do. That ambiguity is what made the field report point
    // at a parked-forever state; the wait has always been capped, so what was
    // missing was the ability to see it.
    const raw = new FakeSocket();
    raw.bufferedAmount = 5000;
    const throttles: Array<[number, number]> = [];
    const gated = withBackpressure(raw as unknown as Socket, {
      highWaterMark: 100,
      maxWaitMs: 20,
      pollMs: 5,
      onThrottle: (waitedMs, queued) => throttles.push([waitedMs, queued]),
    });
    gated.on('read', () => {});
    raw.fire('read');
    await tick(120);

    expect(throttles).toHaveLength(1);
    expect(throttles[0][0], 'the reported wait was not the real one').toBeGreaterThanOrEqual(15);
    expect(throttles[0][1]).toBe(5000);
  });

  it('says nothing while the consumer keeps up', async () => {
    const raw = new FakeSocket();
    const throttles: number[] = [];
    withBackpressure(raw as unknown as Socket, {
      highWaterMark: 100,
      onThrottle: (ms) => throttles.push(ms),
    }).on('read', () => {});
    raw.fire('read');
    await tick(20);
    expect(throttles).toEqual([]);
  });
  it('bounds how many consumers are served at once, and hands slots on in order', async () => {
    // Per-consumer marks bound what one peer leaves on the wire; they say
    // nothing about serving ten of them at the same time. Ten concurrent
    // backfill reads each materialize their rows before a byte reaches a
    // queue — on the fleet that peaked the hub at ~10 GB while serving, and it
    // fell straight back to 283 MB the moment it went idle.
    const gate = new ServeGate(2);
    const acks: Array<(v?: unknown) => void> = [];
    const running: number[] = [];
    const raws: FakeSocket[] = [];
    for (let i = 0; i < 5; i++) {
      const raw = new FakeSocket();
      const index = i;
      withBackpressure(raw as unknown as Socket, { gate }).on(
        'read',
        (...args: unknown[]) => {
          running.push(index);
          acks.push(args[args.length - 1] as (v?: unknown) => void);
        },
      );
      raws.push(raw);
    }
    for (const raw of raws) raw.fire('read', () => {});
    await tick(20);

    // Only two are in flight; the rest wait for a slot.
    expect(running).toEqual([0, 1]);
    expect(gate.inFlight).toBe(2);
    expect(gate.waiting).toBe(3);

    // The slot rides on the acknowledgement, not on the handler returning —
    // otherwise it would be freed before a single row had been read.
    acks[0]();
    await tick(20);
    expect(running).toEqual([0, 1, 2]);
    acks[1]();
    acks[2]();
    await tick(20);
    expect(running).toEqual([0, 1, 2, 3, 4]);
  });

  it('frees a slot when a handler never acknowledges', async () => {
    const gate = new ServeGate(1);
    const raw = new FakeSocket();
    withBackpressure(raw as unknown as Socket, {
      gate,
      serveTimeoutMs: 20,
    }).on('read', () => {});
    raw.fire('read', () => {});
    await tick(5);
    expect(gate.inFlight).toBe(1);
    await tick(60);
    expect(gate.inFlight, 'a lost acknowledgement kept its slot').toBe(0);
  });

  it('serves an event that carries no acknowledgement', async () => {
    const gate = new ServeGate(1);
    const raw = new FakeSocket();
    const served = vi.fn();
    withBackpressure(raw as unknown as Socket, { gate }).on('ping', served);
    raw.fire('ping', 'not-a-callback');
    await tick(20);
    expect(served).toHaveBeenCalledWith('not-a-callback');
    expect(gate.inFlight).toBe(0);
  });

  it('an acknowledgement that arrives twice frees its slot once', async () => {
    const gate = new ServeGate(1);
    const raw = new FakeSocket();
    let ack: ((v?: unknown) => void) | undefined;
    withBackpressure(raw as unknown as Socket, { gate }).on(
      'read',
      (...args: unknown[]) => {
        ack = args[args.length - 1] as (v?: unknown) => void;
      },
    );
    raw.fire('read', () => {});
    await tick(10);
    ack?.();
    ack?.();
    await tick(10);
    expect(gate.inFlight).toBe(0);
  });
});
