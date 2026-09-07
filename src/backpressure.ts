// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';

/** How a {@link BackpressuredSocket} decides when to serve again. */
export interface BackpressureOptions {
  /**
   * Bytes already queued on the transport above which this consumer is not
   * served any further requests until it drains.
   */
  highWaterMark?: number;
  /**
   * Longest a single request may wait for the drain. When it elapses the
   * request is served anyway: a consumer that never drains must degrade into
   * slow answers, not into a stalled hub.
   */
  maxWaitMs?: number;
  /** How often the queue depth is re-checked while waiting. */
  pollMs?: number;
}

/** A socket that can report how much it still owes the wire. */
interface Bufferable {
  bufferedAmount?: number;
}

/**
 * Wraps a socket so its REQUEST HANDLERS only run while that consumer's
 * transport has drained below a high-water mark.
 *
 * Serving reads is where a hub produces bulk data, and it produced it as fast
 * as the local store could answer — regardless of whether the consumer was
 * taking it. A slow or flapping cross-subnet peer during a large backfill
 * therefore accumulated an unbounded off-heap send queue: ~11–12 GB RSS
 * against a 32 MB V8 heap, until the hub wedged at its memory limit and every
 * connection went with it. Same-subnet consumers drained fast enough to hide
 * it entirely.
 *
 * Gating the handler rather than the write is what makes this real
 * backpressure: the hub stops PRODUCING answers for a consumer that is not
 * keeping up, instead of queueing more of them. Other consumers are untouched
 * — each socket has its own queue and its own gate.
 * @param socket - The consumer's socket.
 * @param options - Water mark and wait bounds.
 * @returns A socket that defers handler invocation while the consumer is
 *   behind.
 */
export const withBackpressure = (
  socket: Socket,
  options: BackpressureOptions = {},
): Socket => new BackpressuredSocket(socket, options);

/** Implementation of {@link withBackpressure}. */
class BackpressuredSocket implements Socket {
  private readonly _highWaterMark: number;
  private readonly _maxWaitMs: number;
  private readonly _pollMs: number;
  /** Original handler → the gated wrapper, so `off` can find it again. */
  private readonly _wrapped = new Map<
    (...args: any[]) => void,
    (...args: any[]) => void
  >();

  constructor(
    private readonly _socket: Socket,
    options: BackpressureOptions,
  ) {
    this._highWaterMark = options.highWaterMark ?? 8 * 1024 * 1024;
    this._maxWaitMs = options.maxWaitMs ?? 5000;
    this._pollMs = options.pollMs ?? 25;
  }

  /** Bytes this consumer still owes the wire, 0 when unknown. */
  private get _queued(): number {
    return (this._socket as unknown as Bufferable).bufferedAmount ?? 0;
  }

  /**
   * Resolves once the consumer has drained, or once the wait budget is spent.
   */
  private async _awaitDrain(): Promise<void> {
    if (this._queued <= this._highWaterMark) return;
    const until = Date.now() + this._maxWaitMs;
    while (this._queued > this._highWaterMark && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, this._pollMs));
    }
  }

  get connected(): boolean {
    return this._socket.connected;
  }

  get disconnected(): boolean {
    return this._socket.disconnected;
  }

  get bufferedAmount(): number {
    return this._queued;
  }

  connect(): void {
    this._socket.connect();
  }

  disconnect(): void {
    this._socket.disconnect();
  }

  on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const gated = (...args: any[]): void => {
      void this._awaitDrain().then(() => listener(...args));
    };
    this._wrapped.set(listener, gated);
    this._socket.on(eventName, gated);
    return this;
  }

  off(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const gated = this._wrapped.get(listener) ?? listener;
    this._wrapped.delete(listener);
    (this._socket as unknown as { off: (e: string | symbol, l: unknown) => void }).off(
      eventName,
      gated,
    );
    return this;
  }

  emit(eventName: string | symbol, ...args: any[]): this {
    this._socket.emit(eventName, ...args);
    return this;
  }

  removeAllListeners(eventName?: string | symbol): this {
    this._wrapped.clear();
    (
      this._socket as unknown as {
        removeAllListeners: (e?: string | symbol) => void;
      }
    ).removeAllListeners(eventName);
    return this;
  }
}
