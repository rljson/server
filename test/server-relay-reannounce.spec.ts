// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Server } from '../src/server';
import { SocketIoBridge } from '../src/socket-io-bridge';

import { createNamespaceHarness } from './helpers/socket-io-namespaces';

import type { NamespaceHarness } from './helpers/socket-io-namespaces';
import type { SocketNamespaceBundle } from '../src/socket-bundle.ts';

/**
 * A ref is a content hash: it names a STATE, not an event. Re-announcing the
 * state you are in is therefore the only way a peer that joined — or rejoined —
 * after your first announcement can ever learn it. The relay must pass such a
 * re-announcement on.
 *
 * It did not. Repeats were suppressed by ref VALUE, for up to two eviction
 * generations (a minute each by default), so on a quiet cluster a node that
 * missed the first announcement stayed on its old state for minutes — which is
 * exactly what the ten-node fleet reported: senders logging `head=… send` and
 * every receiver still logging the previous root.
 *
 * `@rljson/db` already decides echo-vs-news properly, on the per-sender
 * sequence (db#49). These tests pin the relay to the same rule.
 */
describe('Server — relayed re-announcements', () => {
  const route = Route.fromFlat('relayRoute');
  let harness: NamespaceHarness;
  let server: Server;

  const received: string[] = [];

  beforeEach(async () => {
    harness = await createNamespaceHarness(2);
    const io = new IoMem();
    await io.init();
    await io.isReady();
    server = new Server(route, io, new BsMem());
    await server.init();
    for (const bundle of harness.serverSockets) {
      await server.addSocket({
        ioUp: new SocketIoBridge((bundle as never as Record<string, never>)['ioUp']),
        ioDown: new SocketIoBridge((bundle as never as Record<string, never>)['ioDown']),
        bsUp: new SocketIoBridge((bundle as never as Record<string, never>)['bsUp']),
        bsDown: new SocketIoBridge((bundle as never as Record<string, never>)['bsDown']),
      } as SocketNamespaceBundle);
    }
    received.length = 0;
    (
      harness.clientSockets[1] as never as Record<
        string,
        { on: (e: string, h: (p: { r: string }) => void) => void }
      >
    )['ioDown'].on(route.flat, (p) => {
      received.push(p.r);
    });
  });

  afterEach(async () => {
    await server.tearDown?.();
    await harness.close();
  });

  /** Emits a ref from client 0 as the connector would. */
  const send = (r: string, seq?: number, c = 'nodeA'): void => {
    const payload: Record<string, unknown> = { r };
    if (seq !== undefined) {
      payload['c'] = c;
      payload['seq'] = seq;
    }
    (
      harness.clientSockets[0] as never as Record<
        string,
        { emit: (e: string, p: Record<string, unknown>) => void }
      >
    )['ioUp'].emit(route.flat, payload);
  };

  it('relays a re-announcement of the SAME ref when the sender has moved on', async () => {
    send('ref-1', 1);
    await vi.waitUntil(() => received.length === 1, { timeout: 1000, interval: 20 });

    // The heartbeat re-announces the unchanged state. The sender's sequence
    // has advanced, so this is news for anyone who missed the first one.
    send('ref-1', 2);
    await vi.waitUntil(() => received.length === 2, { timeout: 1000, interval: 20 });
    expect(received).toEqual(['ref-1', 'ref-1']);
  });

  it('still suppresses a true echo — same ref, sequence not advanced', async () => {
    send('ref-1', 5);
    await vi.waitUntil(() => received.length === 1, { timeout: 1000, interval: 20 });

    send('ref-1', 5);
    send('ref-1', 4);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual(['ref-1']);
  });

  it('keeps suppressing repeats from a sender that carries no sequence', async () => {
    // An older peer gives the relay nothing to judge by, so the previous
    // behaviour stands rather than turning into a broadcast storm.
    send('ref-9');
    await vi.waitUntil(() => received.length === 1, { timeout: 1000, interval: 20 });
    send('ref-9');
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual(['ref-9']);
  });
  it('bounds the per-sender sequence map', async () => {
    // Keyed by connector client id, so it grows with process restarts rather
    // than with traffic — but it still must not grow without limit.
    (server as unknown as { _maxOriginSeqs: number })._maxOriginSeqs = 1;
    send('ref-a', 1, 'nodeA');
    await vi.waitUntil(() => received.length === 1, { timeout: 1000, interval: 20 });
    send('ref-b', 1, 'nodeB');
    await vi.waitUntil(() => received.length === 2, { timeout: 1000, interval: 20 });

    const seqs = (
      server as unknown as { _lastSeqByOrigin: Map<string, number> }
    )._lastSeqByOrigin;
    expect(seqs.size).toBe(1);
    expect([...seqs.keys()]).toEqual(['nodeB']);
  });
});
