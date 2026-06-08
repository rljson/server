// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';
import { SocketNamespaceBundle } from '../src/socket-bundle.ts';
import { SocketIoBridge } from '../src/socket-io-bridge';

import {
  createNamespaceHarness,
  NamespaceHarness,
} from './helpers/socket-io-namespaces';

/**
 * End-to-end regression test for the split-namespace connector channel.
 *
 * The Server fans forwarded refs (and bootstrap) out on each receiver's
 * `ioDown` namespace, while the Connector emits upstream on `ioUp`. When the
 * client's namespaces are split, the Connector must LISTEN on `ioDown` —
 * otherwise B never receives A's ref. This drove the `connectorDuplexSocket`
 * adapter wired into `Client._setupDbAndConnector`.
 */
describe('Connector ref relay across split Socket.IO namespaces', () => {
  const route = Route.fromFlat('splitNsTree');

  let harness: NamespaceHarness;
  let server: Server;
  let a: Client;
  let b: Client;

  const bridgeBundle = (
    bundle: Record<string, unknown>,
  ): SocketNamespaceBundle =>
    ({
      ioUp: new SocketIoBridge(bundle.ioUp as any),
      ioDown: new SocketIoBridge(bundle.ioDown as any),
      bsUp: new SocketIoBridge(bundle.bsUp as any),
      bsDown: new SocketIoBridge(bundle.bsDown as any),
    }) as SocketNamespaceBundle;

  const makeClient = async (idx: number): Promise<Client> => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const client = new Client(
      bridgeBundle(harness.clientSockets[idx] as Record<string, unknown>),
      io,
      new BsMem(),
      route,
    );
    await client.init();
    return client;
  };

  beforeAll(async () => {
    harness = await createNamespaceHarness(2);

    const serverIo = new IoMem();
    await serverIo.init();
    await serverIo.isReady();
    server = new Server(route, serverIo, new BsMem());
    await server.init();

    for (const bundle of harness.serverSockets) {
      await server.addSocket(
        bridgeBundle(bundle as Record<string, unknown>),
      );
    }

    a = await makeClient(0);
    b = await makeClient(1);
  });

  afterAll(async () => {
    await a?.tearDown();
    await b?.tearDown();
    await harness.close();
  });

  it('relays a ref emitted by A to B', async () => {
    const ref = 'ref-split-ns-roundtrip';

    const received = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`ref "${ref}" not received by B`)),
        4000,
      );
      b.connector!.listen(async (r) => {
        if (r === ref) {
          clearTimeout(timer);
          resolve(r);
        }
      });
    });

    a.connector!.send(ref);

    await expect(received).resolves.toBe(ref);
  });
});
