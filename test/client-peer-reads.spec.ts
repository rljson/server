// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client.ts';
import { peerReadEvents } from '../src/peer-reads.ts';

// .............................................................................
// The client's part of peer reads: it says hello to its hub, records the
// source of every relayed ref, and puts the peers in front of the hub.
// .............................................................................

const route = Route.fromFlat('clientPeerReads');

describe('Client with peer reads', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.tearDown();
    client = undefined;
  });

  /** A client whose hub side is a bare socket the test drives. */
  const createClient = async (options?: { route?: Route | null }) => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    const hellos: unknown[] = [];
    hubSide.on(peerReadEvents.hello, (payload: unknown) => hellos.push(payload));
    const connect = vi.fn(async () => undefined);
    const io = new IoMem();
    await io.init();
    await io.isReady();
    client = new Client(
      clientSide,
      io,
      new BsMem(),
      options?.route === null ? undefined : (options?.route ?? route),
      { peerReads: { nodeId: 'node-me', connect } },
    );
    await client.init();
    return { hubSide, clientSide, hellos, connect, client };
  };

  /** Relays a payload from the hub to the client. */
  const relay = (hubSide: DirectionalSocketMock, payload: unknown) => {
    hubSide.emit(route.flat, payload);
  };

  it('tells its hub its node when it starts', async () => {
    const { hellos } = await createClient();
    expect(hellos).toEqual([{ nodeId: 'node-me' }]);
  });

  it('tells its hub again after every reconnect', async () => {
    const { hellos, clientSide } = await createClient();

    clientSide.disconnect();
    clientSide.connect();
    clientSide.disconnect();
    clientSide.connect();

    expect(hellos).toEqual([
      { nodeId: 'node-me' },
      { nodeId: 'node-me' },
      { nodeId: 'node-me' },
    ]);
  });

  it('takes the source of a relayed ref as a peer to read from', async () => {
    const { hubSide, connect } = await createClient();

    relay(hubSide, { o: 'o', r: 'ref-1', src: 'node-a' });

    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith('node-a', expect.any(AbortSignal)),
    );
  });

  it('ignores refs without a usable source, and its own', async () => {
    const { hubSide, connect } = await createClient();

    relay(hubSide, { o: 'o', r: 'ref-1' });
    relay(hubSide, { o: 'o', r: 'ref-2', src: 42 });
    relay(hubSide, { o: 'o', r: 'ref-3', src: '' });
    relay(hubSide, { o: 'o', r: 'ref-4', src: 'node-me' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(connect).not.toHaveBeenCalled();
  });

  it('says hello but records no sources without a route', async () => {
    const { hellos, hubSide, connect } = await createClient({ route: null });

    relay(hubSide, { o: 'o', r: 'ref-1', src: 'node-a' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hellos).toEqual([{ nodeId: 'node-me' }]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('records sources on the route given for peer reads when it has none of its own', async () => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    const connect = vi.fn(async () => undefined);
    const io = new IoMem();
    await io.init();
    await io.isReady();
    client = new Client(clientSide, io, new BsMem(), undefined, {
      peerReads: { nodeId: 'node-me', connect, route },
    });
    await client.init();

    relay(hubSide, { o: 'o', r: 'ref-1', src: 'node-a' });

    await vi.waitFor(() =>
      expect(connect).toHaveBeenCalledWith('node-a', expect.any(AbortSignal)),
    );
  });

  it('exposes its peer reads, and closes them on tear down', async () => {
    const { hubSide, connect } = await createClient();
    const peerReads = client!.peerReads!;
    expect(peerReads.nodeId).toBe('node-me');

    await client!.tearDown();
    client = undefined;
    relay(hubSide, { o: 'o', r: 'ref-1', src: 'node-a' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(peerReads.isClosed).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it('says hello with its node id when it has one, even with peer reads off', async () => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    const hellos: unknown[] = [];
    hubSide.on(peerReadEvents.hello, (p: unknown) => hellos.push(p));
    const io = new IoMem();
    await io.init();
    await io.isReady();
    client = new Client(clientSide, io, new BsMem(), route, {
      nodeId: 'node-plain',
    });
    await client.init();

    relay(hubSide, { o: 'o', r: 'ref-1', src: 'node-a' });

    expect(hellos).toEqual([{ nodeId: 'node-plain' }]);
    expect(client.peerReads).toBeUndefined();
  });

  it('has no peer reads and says no hello without a node id', async () => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    const hello = vi.fn();
    hubSide.on(peerReadEvents.hello, hello);
    const io = new IoMem();
    await io.init();
    await io.isReady();
    client = new Client(clientSide, io, new BsMem(), route);
    await client.init();

    expect(client.peerReads).toBeUndefined();
    expect(hello).not.toHaveBeenCalled();
  });
});
