// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';
import { describe, expect, it, vi } from 'vitest';

import { withBackpressure } from '../src/backpressure';

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
});
