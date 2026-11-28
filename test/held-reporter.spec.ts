// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultHeldRecheckMs, HeldReporter } from '../src/held-reporter.ts';
import { BufferedLogger } from '../src/logger.ts';

// .............................................................................
// When the node holds the newest ref it received, the hub hears it once.
// .............................................................................

describe('HeldReporter', () => {
  let held: Set<string>;
  let reported: string[];
  let checked: string[];
  let reporter: HeldReporter;

  const create = (recheckMs?: readonly number[], logger?: BufferedLogger) => {
    reporter = new HeldReporter(
      async (ref) => {
        checked.push(ref);
        return held.has(ref);
      },
      (ref) => reported.push(ref),
      recheckMs,
      logger,
    );
    return reporter;
  };

  /** Lets every pending promise chain run. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    held = new Set();
    reported = [];
    checked = [];
  });

  afterEach(() => {
    reporter?.stop();
    vi.useRealTimers();
  });

  it('checks again 1, 2, 5, 10, 30 and 60 seconds apart by default', () => {
    expect(defaultHeldRecheckMs).toEqual([1000, 2000, 5000, 10_000, 30_000, 60_000]);
  });

  it('reports a ref the store holds', async () => {
    held.add('ref-1');
    create().check('ref-1');
    await flush();

    expect(reported).toEqual(['ref-1']);
    expect(reporter.reported).toBe('ref-1');
  });

  it('reports a ref once', async () => {
    held.add('ref-1');
    create().check('ref-1');
    await flush();
    reporter.check('ref-1');
    await flush();

    expect(checked).toEqual(['ref-1']);
    expect(reported).toEqual(['ref-1']);
  });

  it('checks a ref the store lacks again until it holds it', async () => {
    create([100, 200]).check('ref-1');
    await flush();
    expect(reported).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(checked).toEqual(['ref-1', 'ref-1']);

    held.add('ref-1');
    await vi.advanceTimersByTimeAsync(200);
    expect(reported).toEqual(['ref-1']);
  });

  it('gives up after the last recheck', async () => {
    create([100]).check('ref-1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(checked).toEqual(['ref-1', 'ref-1']);
    expect(reported).toEqual([]);

    // A new arrival of the same ref starts over.
    held.add('ref-1');
    reporter.check('ref-1');
    await flush();
    expect(reported).toEqual(['ref-1']);
  });

  it('ignores the ref it is checking already', async () => {
    create([100]).check('ref-1');
    reporter.check('ref-1');
    await flush();

    expect(checked).toEqual(['ref-1']);
  });

  it('drops a waiting ref for a newer one', async () => {
    create([100]).check('ref-1');
    await flush();
    held.add('ref-2');
    reporter.check('ref-2');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    expect(checked).toEqual(['ref-1', 'ref-2']);
    expect(reported).toEqual(['ref-2']);
  });

  it('checks the newer ref when one arrives during a check', async () => {
    held.add('ref-1');
    held.add('ref-2');
    create();
    reporter.check('ref-1');
    reporter.check('ref-2');
    await flush();

    expect(checked).toEqual(['ref-1', 'ref-2']);
    expect(reported).toEqual(['ref-2']);
  });

  it('reports the last held ref again', async () => {
    held.add('ref-1');
    create();
    reporter.again();
    expect(reported).toEqual([]);

    reporter.check('ref-1');
    await flush();
    reporter.again();

    expect(reported).toEqual(['ref-1', 'ref-1']);
  });

  it('logs a check that fails and checks again', async () => {
    const logger = new BufferedLogger();
    let fail = true;
    reporter = new HeldReporter(
      async () => {
        if (fail) throw new Error('store gone');
        return true;
      },
      (ref) => reported.push(ref),
      [100],
      logger,
    );
    reporter.check('ref-1');
    await flush();
    expect(logger.entries.some((e) => e.message === 'Checking a ref failed')).toBe(true);

    fail = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(reported).toEqual(['ref-1']);
  });

  it('logs a check that fails with something other than an error', async () => {
    const logger = new BufferedLogger();
    reporter = new HeldReporter(
      async () => {
        throw 'just a string';
      },
      (ref) => reported.push(ref),
      [],
      logger,
    );
    reporter.check('ref-1');
    await flush();

    expect(logger.entries.some((e) => e.data?.['error'] === 'just a string')).toBe(true);
  });

  it('checks and reports nothing after stop', async () => {
    held.add('ref-1');
    create([100]).check('ref-x');
    await flush();
    reporter.stop();
    reporter.check('ref-1');
    reporter.again();
    await vi.advanceTimersByTimeAsync(1000);

    expect(checked).toEqual(['ref-x']);
    expect(reported).toEqual([]);
  });

  it('reports nothing when stopped during a check', async () => {
    held.add('ref-1');
    create().check('ref-1');
    reporter.stop();
    await flush();

    expect(reported).toEqual([]);
  });
});
