// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { noopLogger, ServerLogger } from './logger.ts';

/** When a ref not held yet is checked again, in ms after the last check. */
export const defaultHeldRecheckMs: readonly number[] = [
  1000, 2000, 5000, 10_000, 30_000, 60_000,
];

// #############################################################################
/**
 * Tells the hub when this node holds the newest ref it received.
 *
 * A ref arrives before the data under it is in the local store — whatever
 * applies it does so later — so a ref is checked when it arrives and, while
 * the store still lacks rows, again on {@link defaultHeldRecheckMs}. One check
 * runs at a time; a newer ref replaces one still waiting. A ref is reported
 * once, and again by {@link again} after the hub forgot this node.
 */
export class HeldReporter {
  private _current?: string;
  private _attempt = 0;
  private _reported?: string;
  private _running = false;
  private _stopped = false;
  private _timer?: ReturnType<typeof setTimeout>;

  // ...........................................................................
  /**
   * Creates the reporter.
   * @param _holds - Whether the local store holds every row under a ref.
   * @param _report - Tells the hub the node holds a ref.
   * @param _recheckMs - When a ref not held yet is checked again.
   * @param _logger - For checks that fail.
   */
  constructor(
    private readonly _holds: (ref: string) => Promise<boolean>,
    private readonly _report: (ref: string) => void,
    private readonly _recheckMs: readonly number[] = defaultHeldRecheckMs,
    private readonly _logger: ServerLogger = noopLogger,
  ) {}

  // ...........................................................................
  /** The ref last reported as held. */
  get reported(): string | undefined {
    return this._reported;
  }

  // ...........................................................................
  /**
   * Checks a ref the node received, unless it is the one reported already
   * or the one being checked.
   * @param ref - The ref.
   */
  check(ref: string): void {
    if (this._stopped || ref === this._reported || ref === this._current) {
      return;
    }
    clearTimeout(this._timer);
    this._timer = undefined;
    this._current = ref;
    this._attempt = 0;
    if (!this._running) void this._run();
  }

  // ...........................................................................
  /** Reports the last held ref again: the hub forgot this node. */
  again(): void {
    if (!this._stopped && this._reported !== undefined) {
      this._report(this._reported);
    }
  }

  // ...........................................................................
  /** Stops checking. */
  stop(): void {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = undefined;
  }

  // ...........................................................................
  /** Checks the current ref until it is held, replaced or given up. */
  private async _run(): Promise<void> {
    this._running = true;
    while (this._current !== undefined && !this._stopped) {
      const ref = this._current;
      let held = false;
      try {
        held = await this._holds(ref);
      } catch (error) {
        this._logger.warn('HeldReporter', 'Checking a ref failed', {
          ref,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (this._stopped) break;
      if (ref !== this._current) continue;

      if (held) {
        this._current = undefined;
        this._reported = ref;
        this._report(ref);
        break;
      }

      const delay = this._recheckMs[this._attempt++];
      if (delay === undefined) {
        this._current = undefined;
        break;
      }
      this._timer = setTimeout(() => {
        this._timer = undefined;
        void this._run();
      }, delay);
      this._timer.unref?.();
      break;
    }
    this._running = false;
  }
}
