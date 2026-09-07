// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route, SocketNamespaceBundle } from '@rljson/rljson';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';
import { SocketIoBridge } from '../src/socket-io-bridge';

import {
  createNamespaceHarness,
  NamespaceHarness,
} from './helpers/socket-io-namespaces';

// .............................................................................
// A hub in the field serves ten nodes at once. Field report 2026-09-07: the hub
// logged "connected clients: 2" while ten nodes were running, and nodes took
// turns being connected — including already-converged, idle nodes on the hub's
// own subnet. Whoever got enough connected time finished; the rest hung
// partially. These tests pin down why a hub drops clients it should keep.
// .............................................................................

const route = Route.fromFlat('hubHoldsConnections');
const CLIENTS = 10;
const HEALTH_TIMEOUT_MS = 100;

/** Burns the event loop for `ms`, the way a large synchronous serve does. */
const stallEventLoop = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* deliberately blocking */
  }
};

const bridgeBundle = (bundle: Record<string, unknown>): SocketNamespaceBundle =>
  ({
    ioUp: new SocketIoBridge(bundle.ioUp as any),
    ioDown: new SocketIoBridge(bundle.ioDown as any),
    bsUp: new SocketIoBridge(bundle.bsUp as any),
    bsDown: new SocketIoBridge(bundle.bsDown as any),
  }) as SocketNamespaceBundle;

describe('A hub keeps the connections of healthy clients', () => {
  let harness: NamespaceHarness;
  let server: Server;
  let clients: Client[] = [];

  beforeEach(async () => {
    harness = await createNamespaceHarness(CLIENTS, {
      transports: ['websocket'],
    });

    const serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();
    server = new Server(route, serverIo, new BsMem(), {
      refEvictionIntervalMs: 0,
      // Driven by hand below, so a round happens exactly when the test says.
      healthCheckIntervalMs: 0,
      healthCheckTimeoutMs: HEALTH_TIMEOUT_MS,
    });
    await server.init();

    for (const bundle of harness.serverSockets) {
      await server.addSocket(bridgeBundle(bundle as Record<string, unknown>));
    }

    clients = [];
    for (let i = 0; i < CLIENTS; i++) {
      const io = new IoMem();
      await io.init();
      await io.isReady();
      const client = new Client(
        bridgeBundle(harness.clientSockets[i] as Record<string, unknown>),
        io,
        new BsMem(),
        route,
      );
      await client.init();
      clients.push(client);
    }
  });

  afterEach(async () => {
    for (const client of clients) await client?.tearDown();
    await server?.tearDown?.();
    await harness?.close();
  });

  const connectedClientCount = (): number =>
    (server as unknown as { _clients: Map<string, unknown> })._clients.size;

  const runHealthRound = (): void =>
    (server as unknown as { _runHealthCheck: () => void })._runHealthCheck();

  const settle = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps every client across a quiet health round', async () => {
    expect(connectedClientCount()).toBe(CLIENTS);

    runHealthRound();
    await settle(HEALTH_TIMEOUT_MS * 4);

    expect(connectedClientCount()).toBe(CLIENTS);
  });

  it('keeps every client when the hub stalls while their pongs are in flight', async () => {
    expect(connectedClientCount()).toBe(CLIENTS);

    // The hub sends its pings, then does what a hub under a large backfill
    // does: it blocks. Every client answers during the stall, so ten pongs are
    // sitting in the hub's socket buffers by the time it breathes again.
    runHealthRound();
    stallEventLoop(HEALTH_TIMEOUT_MS * 2);
    await settle(HEALTH_TIMEOUT_MS * 6);

    // Node runs the timers phase BEFORE the poll phase, so the expired
    // health-check timeouts fire before a single one of those pongs is read.
    // Pruning here disconnects ten healthy clients for the hub's own stall —
    // and the reconnect storm stalls it again, which is how a ten-node lab
    // settles at "connected clients: 2".
    expect(connectedClientCount()).toBe(CLIENTS);
  });

  it('survives a stall even when a single miss would be fatal', async () => {
    // Isolates the two halves of the fix. With one strike allowed, only the
    // yield to the poll phase can save these clients — so this proves the
    // hub does not merely tolerate the stall, it actually reads the pongs
    // that arrived during it. A hub that stalls on EVERY round therefore
    // keeps its clients too, which strikes alone would not achieve.
    (
      server as unknown as { _healthCheckMaxStrikes: number }
    )._healthCheckMaxStrikes = 1;

    runHealthRound();
    stallEventLoop(HEALTH_TIMEOUT_MS * 2);
    await settle(HEALTH_TIMEOUT_MS * 6);

    expect(connectedClientCount()).toBe(CLIENTS);
  });

  it('still prunes a client that never answers, after the strike limit', async () => {
    // The check must keep doing its job: a socket whose application layer is
    // wedged answers nothing, round after round, and has to go.
    const wedged = clients[0];
    await wedged.tearDown();
    clients = clients.slice(1);

    const maxStrikes = (
      server as unknown as { _healthCheckMaxStrikes: number }
    )._healthCheckMaxStrikes;

    for (let round = 1; round < maxStrikes; round++) {
      runHealthRound();
      await settle(HEALTH_TIMEOUT_MS * 4);
      // Not yet — one or two missed rounds are not a death sentence.
      expect(connectedClientCount()).toBe(CLIENTS);
    }

    runHealthRound();
    await settle(HEALTH_TIMEOUT_MS * 6);
    expect(connectedClientCount()).toBe(CLIENTS - 1);
  });
});
