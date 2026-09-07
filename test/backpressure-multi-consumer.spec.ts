// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';
import { describe, expect, it, vi } from 'vitest';

import { withBackpressure } from '../src/backpressure';

/**
 * The field shape: ten consumers pull a large backfill at once, five of them
 * across a link that never drains. The report was that five converged and five
 * hung while the hub looked idle — the signature of requests parked in a state
 * nothing releases.
 *
 * These pin the property that rules the flow control in or out as the cause:
 * every consumer must keep being served, however badly its neighbours behave.
 */
class FakeSocket {
  bufferedAmount = 0;
  connected = true;
  disconnected = false;
  private _handlers = new Map<string, Array<(...a: unknown[]) => void>>();

  connect(): void {}
  disconnect(): void {}
  emit(): this {
    return this;
  }
  on(event: string, handler: (...a: unknown[]) => void): this {
    const list = this._handlers.get(event) ?? [];
    list.push(handler);
    this._handlers.set(event, list);
    return this;
  }
  off(): this {
    return this;
  }
  removeAllListeners(): this {
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const h of [...(this._handlers.get(event) ?? [])]) h(...args);
  }
}

const tick = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('withBackpressure — many consumers at once', () => {
  it('keeps serving every consumer, including the ones that never drain', async () => {
    const raws: FakeSocket[] = [];
    const served: number[] = [];
    for (let i = 0; i < 10; i++) {
      const raw = new FakeSocket();
      // Five consumers sit permanently above the mark — a slow cross-subnet
      // link that never catches up.
      if (i >= 5) raw.bufferedAmount = 50 * 1024 * 1024;
      const gated = withBackpressure(raw as unknown as Socket, {
        highWaterMark: 1024,
        maxWaitMs: 60,
        pollMs: 5,
      });
      const index = i;
      gated.on('read', () => served.push(index));
      raws.push(raw);
    }

    // Every consumer asks three times, all at once.
    for (let round = 0; round < 3; round++) {
      for (const raw of raws) raw.fire('read');
    }
    await tick(400);

    // The draining five are served promptly; the stuck five are served late,
    // but they ARE served — a consumer that cannot keep up must get slow
    // answers, never none.
    for (let i = 0; i < 10; i++) {
      expect(
        served.filter((s) => s === i).length,
        `consumer ${i} was starved`,
      ).toBe(3);
    }
  });

  it('one stuck consumer does not delay the others', async () => {
    const stuck = new FakeSocket();
    stuck.bufferedAmount = 50 * 1024 * 1024;
    const healthy = new FakeSocket();
    const order: string[] = [];
    withBackpressure(stuck as unknown as Socket, {
      highWaterMark: 1024,
      maxWaitMs: 200,
      pollMs: 5,
    }).on('read', () => order.push('stuck'));
    withBackpressure(healthy as unknown as Socket, {
      highWaterMark: 1024,
      maxWaitMs: 200,
      pollMs: 5,
    }).on('read', () => order.push('healthy'));

    stuck.fire('read');
    healthy.fire('read');
    await tick(40);
    expect(order, 'the healthy consumer waited on the stuck one').toEqual([
      'healthy',
    ]);
    await tick(300);
    expect(order).toEqual(['healthy', 'stuck']);
  });

  it('a consumer that recovers is served immediately again', async () => {
    const raw = new FakeSocket();
    raw.bufferedAmount = 50 * 1024 * 1024;
    const served = vi.fn();
    withBackpressure(raw as unknown as Socket, {
      highWaterMark: 1024,
      maxWaitMs: 10_000,
      pollMs: 5,
    }).on('read', served);

    raw.fire('read');
    await tick(40);
    expect(served).not.toHaveBeenCalled();
    raw.bufferedAmount = 0;
    await tick(40);
    expect(served, 'a drained consumer was not resumed').toHaveBeenCalledTimes(1);
  });
});
