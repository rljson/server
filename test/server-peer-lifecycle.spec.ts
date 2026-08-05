// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, IoPeer, PeerSocketMock, SocketMock } from '@rljson/io';
import { exampleTableCfg, Route } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BufferedLogger } from '../src/logger';
import { Server, ServerOptions } from '../src/server';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';
import { SocketIoBridge } from '../src/socket-io-bridge';

import { createNamespaceHarness } from './helpers/socket-io-namespaces';

// .............................................................................
// This file covers the Server's socket/peer lifecycle hardening (WS3):
//   F1 — addSocket() no longer misses a disconnect that happens mid-setup.
//   F2 — a defensive sweep + invariant catches dead/orphaned _ios/_bss
//        entries.
//   F3 — _rebuildMultis() survives a closed member instead of stranding
//        the whole cascade; a failed _queueRefresh() rolls the client
//        back completely.
//   F4 — removeSocket() actually unregisters IoServer/BsServer listeners.
// See README.architecture.md ("Socket / peer lifecycle") for the design.
// .............................................................................

let routeCounter = 0;
const freshRoute = () => Route.fromFlat(`peerLifecycle_${routeCounter++}`);

/** Builds a ready-to-use Server backed by fresh in-memory Io/Bs. Health
 * checks and ref eviction are disabled by default so tests are not at the
 * mercy of background timers unless a test opts back in explicitly. */
const makeServer = async (optionsOverride?: ServerOptions) => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  const bs = new BsMem();
  const server = new Server(freshRoute(), io, bs, {
    healthCheckIntervalMs: 0,
    refEvictionIntervalMs: 0,
    ...optionsOverride,
  });
  await server.init();
  return server;
};

let servers: Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    if (!server.isTornDown) {
      await server.tearDown();
    }
  }
  servers = [];
});

// .............................................................................
describe('Server peer lifecycle', () => {
  // ===========================================================================
  describe('T1: churn invariant', () => {
    it('ioPeerCount returns to baseline after N addSocket/disconnect cycles [SocketMock]', async () => {
      const server = await makeServer();
      servers.push(server);
      const baseline = server.ioPeerCount;

      for (let i = 0; i < 8; i++) {
        const socket = new SocketMock();
        socket.connect();
        await server.addSocket(socket);
        expect(server.ioPeerCount).toBe(baseline + 1);

        socket.disconnect();
        await vi.waitFor(() => expect(server.ioPeerCount).toBe(baseline));
      }

      expect(server.ioPeerCount).toBe(baseline);
      expect(server.clients.size).toBe(0);
    });

    it('ioPeerCount does not apply the local-cache adjustment when disableLocalCache is true', async () => {
      const io = new IoMem();
      await io.init();
      await io.isReady();
      const bs = new BsMem();
      const server = new Server(freshRoute(), io, bs, {
        disableLocalCache: true,
        healthCheckIntervalMs: 0,
        refEvictionIntervalMs: 0,
      });
      await server.init();
      servers.push(server);

      expect(server.ioPeerCount).toBe(0);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      expect(server.ioPeerCount).toBe(1);
    });

    it('ioPeerCount returns to baseline after N connect/disconnect cycles [real socket.io]', async () => {
      const clientCount = 4;
      const harness = await createNamespaceHarness(clientCount);

      try {
        const server = await makeServer();
        servers.push(server);
        const baseline = server.ioPeerCount;

        for (let i = 0; i < clientCount; i++) {
          const serverBundle = harness.serverSockets[i] as any;
          const clientBundle = harness.clientSockets[i] as any;

          const bundle = {
            ioUp: new SocketIoBridge(serverBundle.ioUp),
            ioDown: new SocketIoBridge(serverBundle.ioDown),
            bsUp: new SocketIoBridge(serverBundle.bsUp),
            bsDown: new SocketIoBridge(serverBundle.bsDown),
          } as SocketNamespaceBundle;

          await server.addSocket(bundle);
          expect(server.ioPeerCount).toBe(baseline + 1);

          clientBundle.ioUp.disconnect();
          clientBundle.ioDown.disconnect();
          clientBundle.bsUp.disconnect();
          clientBundle.bsDown.disconnect();

          await vi.waitFor(() => expect(server.ioPeerCount).toBe(baseline));
        }

        expect(server.ioPeerCount).toBe(baseline);
        expect(server.clients.size).toBe(0);
      } finally {
        await harness.close();
      }
    });
  });

  // ===========================================================================
  describe('T3: disconnect during addSocket setup (proves F1)', () => {
    it('removes the client via the early watcher when disconnect fires mid-setup', async () => {
      const server = await makeServer();
      servers.push(server);
      const baseline = server.ioPeerCount;

      const socket = new SocketMock();
      socket.connect();

      // Slow peer-init mock: _createIoPeer suspends on `gate` until the
      // test releases it, giving us a window to disconnect the socket
      // while addSocket() is suspended inside the (real) awaits.
      const realCreateIoPeer = (server as any)._createIoPeer.bind(server);
      let releaseGate: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      vi.spyOn(server as any, '_createIoPeer').mockImplementation(
        async (...args: unknown[]) => {
          await gate;
          return realCreateIoPeer(...args);
        },
      );

      const addPromise = server.addSocket(socket);

      // Let addSocket() run synchronously up to the mocked _createIoPeer's
      // own await — no real async I/O happens before that point.
      await Promise.resolve();

      // The socket dies WHILE addSocket() is suspended inside
      // _createIoPeer. Before F1, nothing listens for 'disconnect' until
      // setup finishes (registerDisconnectHandler used to run at the very
      // end), so this event would be lost and the client would be
      // stranded once peer-init eventually "succeeds" below.
      socket.disconnect();

      releaseGate!();
      await addPromise;

      expect(server.clients.size).toBe(0);
      expect(server.ioPeerCount).toBe(baseline);
    });

    it('also removes the client via the connected-state check when no disconnect event fires (belt-and-suspenders half of F1)', async () => {
      const server = await makeServer();
      servers.push(server);
      const baseline = server.ioPeerCount;

      const socket = new SocketMock();
      socket.connect();

      // Flip connectivity directly, WITHOUT going through disconnect()
      // (so no 'disconnect' event fires — the early watcher legitimately
      // has nothing to catch here) right after _queueRefresh() succeeds.
      // Only the post-setup `ioUp.connected === false` check can catch
      // this. Real sockets always pair state + event; isolating them
      // proves the state check on its own is reachable, not dead code.
      const realQueueRefresh = (server as any)._queueRefresh.bind(server);
      vi.spyOn(server as any, '_queueRefresh').mockImplementation(
        async () => {
          const result = await realQueueRefresh();
          socket.connected = false;
          return result;
        },
      );

      await server.addSocket(socket);

      expect(server.clients.size).toBe(0);
      expect(server.ioPeerCount).toBe(baseline);
    });
  });

  // ===========================================================================
  describe('T4: reconnect soak', () => {
    it('settles back to baseline every cycle with no unhandled promise rejections', async () => {
      const rejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const server = await makeServer();
        servers.push(server);
        const baseline = server.ioPeerCount;
        const samples: number[] = [];

        for (let i = 0; i < 25; i++) {
          const socket = new SocketMock();
          socket.connect();
          await server.addSocket(socket);
          socket.disconnect();
          await vi.waitFor(() => expect(server.ioPeerCount).toBe(baseline));
          samples.push(server.ioPeerCount);
        }

        // No monotonic growth: every single cycle returns to baseline,
        // not just the last one.
        expect(samples.every((count) => count === baseline)).toBe(true);
        expect(server.ioPeerCount).toBe(baseline);

        // Give any straggling microtasks/timers a chance to surface a
        // rejection before asserting none occurred.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });
  });

  // ===========================================================================
  describe('T5: rebuild survives a closed peer without a disconnect (proves F3)', () => {
    it('lets a new client join and excludes the dead peer from the cascade', async () => {
      const server = await makeServer();
      servers.push(server);
      const baseline = server.ioPeerCount;

      const deadIo = new IoMem();
      await deadIo.init();
      await deadIo.isReady();
      const deadSocket = new PeerSocketMock(deadIo);
      deadSocket.connect();
      await server.addSocket(deadSocket);
      expect(server.ioPeerCount).toBe(baseline + 1);

      const [deadClientId] = [...server.clients.keys()];
      // Force the peer dead WITHOUT going through disconnect() — no
      // 'disconnect' event ever fires. Simulates any detector other than
      // the socket's own event (a future health signal, a manual mark)
      // flipping isOpen.
      server.clients.get(deadClientId)!.io.isOpen = false;

      const freshIo = new IoMem();
      await freshIo.init();
      await freshIo.isReady();
      const freshSocket = new PeerSocketMock(freshIo);
      freshSocket.connect();

      // Before F3, _rebuildMultis() handed _ios straight to
      // `new IoMulti(...)`, whose init() throws on ANY isOpen === false
      // member (@rljson/io) — stranding the entire cascade, including
      // this brand-new healthy client, behind the one dead peer left
      // over from before.
      await expect(server.addSocket(freshSocket)).resolves.toBe(server);

      expect(server.ioPeerCount).toBe(baseline + 1);
      expect(server.readableIds).not.toContain(deadClientId);

      // The rebuilt multi is actually functional: a served read resolves
      // promptly instead of hanging or erroring on the dead peer that
      // used to strand the whole cascade at construction time.
      const cfgs = await server.io.rawTableCfgs();
      expect(Array.isArray(cfgs)).toBe(true);
    });
  });

  // ===========================================================================
  describe('T6: two Servers sharing one socket', () => {
    it('answers reads deterministically and removeSocket unregisters only its own listeners', async () => {
      const tableKey = 'sharedTable';
      const tableCfg = exampleTableCfg({ key: tableKey });
      const row = { a: 'sharedValue', b: 1 };

      const io1 = new IoMem();
      await io1.init();
      await io1.isReady();
      await io1.createOrExtendTable({ tableCfg });
      await io1.write({
        data: {
          [tableKey]: { _data: [row], _hash: '', _type: 'components' },
        },
      });
      const bs1 = new BsMem();

      const io2 = new IoMem();
      await io2.init();
      await io2.isReady();
      await io2.createOrExtendTable({ tableCfg });
      await io2.write({
        data: {
          [tableKey]: { _data: [row], _hash: '', _type: 'components' },
        },
      });
      const bs2 = new BsMem();

      const route = freshRoute();
      const server1 = new Server(route, io1, bs1, {
        healthCheckIntervalMs: 0,
      });
      await server1.init();
      servers.push(server1);

      const server2 = new Server(route, io2, bs2, {
        healthCheckIntervalMs: 0,
      });
      await server2.init();
      servers.push(server2);

      const sharedSocket = new SocketMock();
      sharedSocket.connect();

      // App-level bug WS4 fixes: the same client socket accidentally
      // registered with two Server instances. This proves the LIBRARY
      // primitives tolerate it sanely rather than crashing or wedging.
      await server1.addSocket(sharedSocket);
      await server2.addSocket(sharedSocket);

      expect(sharedSocket.listenerCount('readRows')).toBe(2);

      // Stand in for a third-party client pulling through the shared
      // socket. Both servers' IoServer have a 'readRows' listener on it;
      // whichever answers the ack callback first wins (a Promise settles
      // once) — identical seed data on both sides makes the result
      // deterministic regardless of which one that is.
      const readerPeer = new IoPeer(sharedSocket);
      await readerPeer.init();

      const before = await readerPeer.readRows({ table: tableKey, where: {} });
      expect(before[tableKey]._data).toHaveLength(1);
      expect((before[tableKey]._data[0] as any).a).toBe('sharedValue');

      const [clientId1] = [...server1.clients.keys()];
      await server1.removeSocket(clientId1);

      // F4: removeSocket() really unregisters — only server1's listener
      // is gone, server2's is untouched.
      expect(sharedSocket.listenerCount('readRows')).toBe(1);

      const after = await readerPeer.readRows({ table: tableKey, where: {} });
      expect(after[tableKey]._data).toHaveLength(1);
      expect((after[tableKey]._data[0] as any).a).toBe('sharedValue');
    });
  });

  // ===========================================================================
  describe('T7: _queueRefresh() rejection rolls back the client (proves F1/F3)', () => {
    it('rejects addSocket, fully removes the half-registered client, and dedupes _pendingSockets so a retry does not double-register CRUD listeners', async () => {
      const server = await makeServer();
      servers.push(server);
      const baseline = server.ioPeerCount;

      const socket = new SocketMock();
      socket.connect();

      const boom = new Error('rebuild boom');
      const rebuildSpy = vi
        .spyOn(server as any, '_rebuildMultis')
        .mockImplementationOnce(async () => {
          throw boom;
        });

      await expect(server.addSocket(socket)).rejects.toThrow('rebuild boom');

      // Rolled all the way back: no half-registered client left behind,
      // and no stale entry left in _pendingSockets for a later refresh
      // to (wrongly) resurrect.
      expect(server.clients.size).toBe(0);
      expect(server.ioPeerCount).toBe(baseline);
      expect((server as any)._pendingSockets).toHaveLength(0);
      expect(socket.listenerCount('readRows')).toBe(0);

      rebuildSpy.mockRestore();

      // Retry with a fresh socket succeeds normally...
      const socket2 = new SocketMock();
      socket2.connect();
      await server.addSocket(socket2);

      expect(server.ioPeerCount).toBe(baseline + 1);
      expect((server as any)._pendingSockets).toHaveLength(0);
      expect(socket2.listenerCount('readRows')).toBe(1);

      // ...and does NOT drag the earlier, already-failed socket back in
      // (it would have, pre-F3, via the stale _pendingSockets entry).
      expect(socket.listenerCount('readRows')).toBe(0);
    });
  });

  // ===========================================================================
  describe('T8: peer-count invariant violation is observable (F2)', () => {
    it('logs and returns false when _ios drifts from the expected client-derived count, then self-heals on the next rebuild', async () => {
      const logger = new BufferedLogger();
      const server = await makeServer({ logger });
      servers.push(server);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      // Healthy state: invariant holds.
      expect((server as any)._checkPeerInvariant()).toBe(true);

      // Corrupt _ios with an orphan entry: neither the local cache nor
      // traceable to any current client. Distinct from a dead peer —
      // isOpen stays true, so only the "not referenced by a client" half
      // of _pruneDeadPeers' filter would ever remove it.
      const orphanIo = new IoMem();
      await orphanIo.init();
      await orphanIo.isReady();
      (server as any)._ios.push({
        io: orphanIo,
        dump: false,
        read: true,
        write: false,
        priority: 2,
      });

      expect(server.readableIds).toContain('orphan');

      logger.clear();
      expect((server as any)._checkPeerInvariant()).toBe(false);
      expect(
        logger
          .byLevel('error')
          .some((e) => e.message === 'Io peer-count invariant violated'),
      ).toBe(true);

      // The next rebuild self-heals: the orphan is pruned and the
      // invariant holds again.
      await (server as any)._rebuildMultis();
      expect((server as any)._checkPeerInvariant()).toBe(true);
      expect(server.readableIds).not.toContain('orphan');
    });

    it('prunes a dead Bs peer independently of its Io counterpart', async () => {
      const server = await makeServer();
      servers.push(server);

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const [clientId] = [...server.clients.keys()];
      const bssBefore = (server as any)._bss.length;

      // Force only the Bs side dead, mirroring T5's Io-side scenario:
      // _pruneDeadPeers' _bss filter has its own isOpen check, entirely
      // independent from the _ios one.
      server.clients.get(clientId)!.bs.isOpen = false;

      await (server as any)._rebuildMultis();

      expect((server as any)._bss.length).toBe(bssBefore - 1);
    });
  });

  // ===========================================================================
  describe('T9: disconnect handler catches a throwing removeSocket (F3)', () => {
    it('logs the error instead of producing an unhandled rejection', async () => {
      const rejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        const logger = new BufferedLogger();
        const server = await makeServer({ logger });
        servers.push(server);

        const socket = new SocketMock();
        socket.connect();
        await server.addSocket(socket);

        const boom = new Error('removeSocket boom');
        const removeSocketSpy = vi
          .spyOn(server, 'removeSocket')
          .mockImplementationOnce(() => Promise.reject(boom));

        logger.clear();
        socket.disconnect();

        await vi.waitFor(() => expect(removeSocketSpy).toHaveBeenCalled());
        // Let the rejected promise's try/catch inside the handler settle.
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(rejections).toEqual([]);
        expect(
          logger
            .byLevel('error')
            .some(
              (e) =>
                e.message === 'removeSocket failed while handling disconnect',
            ),
        ).toBe(true);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });
  });
});
