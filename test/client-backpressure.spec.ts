// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client.ts';
import { ServerLogger } from '../src/logger.ts';

// .............................................................................

/**
 * The hub's brake, on the side that had none (ONE-441).
 *
 * The hub bounds how many requests it serves at once since serving ten
 * backfills peaked it at ~10 GB. A client serves too — the hub pulls from its
 * local stores through the upstream bridges — and every one of those requests
 * ran at once. A hub relieved by its own gate, pulling harder, would move the
 * peak onto the workstation.
 *
 * The hub's requests are played on the client's upstream socket directly: a
 * `SocketMock` delivers an emit to its own listeners, which is where the
 * bridge sits.
 */
describe('Client — serving the hub under a brake', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.tearDown();
    client = undefined;
    vi.restoreAllMocks();
  });

  /**
   * A client whose local reads take a while and count how many run at once.
   * @param options - Client options under test.
   */
  const start = async (
    options: ConstructorParameters<typeof Client>[4] = {},
  ) => {
    const io = new IoMem();
    await io.init();
    const socket = new SocketMock();
    client = new Client(socket, io, new BsMem(), undefined, options);
    await client.init();

    let running = 0;
    let peak = 0;
    vi.spyOn(io, 'readRows').mockImplementation(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return {} as never;
    });

    /** Sends `n` read requests at once, as the hub would. */
    const hubReads = (n: number) =>
      Promise.all(
        Array.from(
          { length: n },
          () =>
            new Promise<void>((resolve) =>
              socket.emit('readRows', { table: 't', where: {} }, () =>
                resolve(),
              ),
            ),
        ),
      );

    return { socket, hubReads, peak: () => peak };
  };

  it('serves at most maxConcurrentServes of the hub’s requests at once', async () => {
    const { hubReads, peak } = await start({ maxConcurrentServes: 2 });

    await hubReads(10);

    // All ten answered — a brake slows the hub, it never leaves it waiting.
    expect(peak()).toBe(2);
  });

  // The control: what the client did before, where nothing bounded it.
  it('runs every request at once without a limit worth the name', async () => {
    const { hubReads, peak } = await start({ maxConcurrentServes: 1000 });

    await hubReads(10);

    expect(peak()).toBe(10);
  });

  it('defaults to the hub’s own limit', async () => {
    const { hubReads, peak } = await start();

    await hubReads(10);

    expect(peak()).toBe(4);
  });

  it('says when the hub had to wait for this machine to drain', async () => {
    const warn = vi.fn();
    const onThrottle = vi.fn();
    const logger = {
      info: () => {},
      warn,
      error: () => {},
      debug: () => {},
      traffic: () => {},
    } as unknown as ServerLogger;
    const { socket, hubReads } = await start({
      logger,
      backpressure: { highWaterMark: 0, maxWaitMs: 10, pollMs: 2, onThrottle },
    });
    // The upstream transport still owes the wire more than the mark allows.
    (socket as unknown as { bufferedAmount: number }).bufferedAmount = 1;

    await hubReads(1);

    expect(warn).toHaveBeenCalledWith(
      'Client.Io',
      'Hub throttled',
      expect.objectContaining({ queuedBytes: 1 }),
    );
    expect(onThrottle).toHaveBeenCalled();
  });
});
