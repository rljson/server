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
  /**
   * Called when a request had to wait, with how long it waited and how deep
   * the consumer's queue was. This is the only way to tell a hub that is idle
   * because there is nothing to do from one that is idle because every handler
   * is sitting in the gate.
   */
  onThrottle?: (waitedMs: number, queuedBytes: number) => void;
  /**
   * Shared across every consumer of one hub, so the COMBINED cost of serving
   * is bounded — see {@link ServeGate}. Omit it and serving is unlimited, which
   * is what let ten concurrent backfills peak the hub at ~10 GB.
   */
  gate?: ServeGate;
  /**
   * Longest a serving slot is held for one request. A handler that never
   * acknowledges would otherwise keep its slot for good.
   */
  serveTimeoutMs?: number;
}

/**
 * Caps how many consumers the hub serves AT THE SAME TIME, across all of them.
 *
 * Per-consumer flow control bounds what any ONE peer can leave queued on the
 * wire; it says nothing about what serving ten of them at once costs. Ten
 * concurrent backfill reads each materialize their rows before a byte reaches a
 * socket queue, and on the fleet that peaked the hub at ~10 GB RSS while it was
 * serving — falling back to 283 MB the moment it went idle. That memory is the
 * work in flight, not the queues.
 *
 * Turns are handed out in arrival order, so a slow peer's request is not
 * overtaken forever by faster ones: it waits for a slot rather than for the
 * fast peers to lose interest.
 */
export class ServeGate {
  private _inFlight = 0;
  private readonly _waiting: Array<() => void> = [];

  /**
   * Creates a gate.
   * @param _maxConcurrent - How many serves may run at once.
   */
  constructor(private readonly _maxConcurrent: number = 4) {}

  /** Requests waiting for a slot right now. */
  get waiting(): number {
    return this._waiting.length;
  }

  /** Serves currently running. */
  get inFlight(): number {
    return this._inFlight;
  }

  /**
   * Waits for a slot.
   * @returns A function that returns the slot; call it exactly once.
   */
  async acquire(): Promise<() => void> {
    if (this._inFlight >= this._maxConcurrent) {
      await new Promise<void>((resolve) => this._waiting.push(resolve));
    }
    this._inFlight++;
    let released = false;
    return () => {
      /* v8 ignore next -- @preserve defensive: a slot is returned once */
      if (released) return;
      released = true;
      this._inFlight--;
      this._waiting.shift()?.();
    };
  }
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
 *
 * The wait is CAPPED, so a consumer is only ever slowed, never starved. That
 * cap is also the sharp edge: a consumer parked permanently above the mark is
 * served once per `maxWaitMs`, which for a backfill of thousands of chunk
 * requests is indistinguishable from a hang — and it leaves the hub looking
 * idle, because every one of its handlers is asleep in this loop. The mark is
 * therefore generous (64 MB, against the 11-12 GB that made it necessary), and
 * `onThrottle` reports every wait so the difference between "nothing to do"
 * and "everything is gated" is visible rather than inferred.
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
  private readonly _onThrottle: (waitedMs: number, queuedBytes: number) => void;
  private readonly _gate: ServeGate | undefined;
  private readonly _serveTimeoutMs: number;
  /** Original handler → the gated wrapper, so `off` can find it again. */
  private readonly _wrapped = new Map<
    (...args: any[]) => void,
    (...args: any[]) => void
  >();

  constructor(
    private readonly _socket: Socket,
    options: BackpressureOptions,
  ) {
    this._highWaterMark = options.highWaterMark ?? 64 * 1024 * 1024;
    this._maxWaitMs = options.maxWaitMs ?? 5000;
    this._pollMs = options.pollMs ?? 25;
    this._onThrottle = options.onThrottle ?? (() => {});
    this._gate = options.gate;
    this._serveTimeoutMs = options.serveTimeoutMs ?? 60_000;
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
    const started = Date.now();
    const until = started + this._maxWaitMs;
    while (this._queued > this._highWaterMark && Date.now() < until) {
      await new Promise<void>((resolve) => setTimeout(resolve, this._pollMs));
    }
    this._onThrottle(Date.now() - started, this._queued);
  }

  /**
   * Runs one request: first wait for this consumer to drain, then for a serving
   * slot. In that order, because a peer that is already behind should not hold
   * a slot while it catches up.
   * @param listener - The handler to run.
   * @param args - Its arguments.
   */
  private async _serve(
    listener: (...args: any[]) => void,
    args: any[],
  ): Promise<void> {
    await this._awaitDrain();
    const release = await this._gate?.acquire();
    if (!release) {
      listener(...args);
      return;
    }
    // The request handler starts the work and returns; the only thing that
    // says it FINISHED is the acknowledgement it sends back. Holding the slot
    // until the synchronous return would free it before a single row had been
    // read, which is no limit at all — so the slot rides on the ack.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      release();
    };
    // A handler that never acknowledges (a dropped socket, a rejected read
    // whose error path does not answer) must not hold the slot for good.
    const timer = setTimeout(finish, this._serveTimeoutMs);
    /* v8 ignore next -- @preserve unref keeps the timer from holding the process */
    (timer as unknown as { unref?: () => void }).unref?.();

    const ack = args[args.length - 1];
    if (typeof ack !== 'function') {
      listener(...args);
      finish();
      return;
    }
    const wrapped = (...ackArgs: any[]): void => {
      finish();
      (ack as (...a: any[]) => void)(...ackArgs);
    };
    try {
      listener(...args.slice(0, -1), wrapped);
      /* v8 ignore start -- @preserve a throwing handler must still free the slot */
    } catch (error) {
      finish();
      throw error;
    }
    /* v8 ignore stop */
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
      void this._serve(listener, args);
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
