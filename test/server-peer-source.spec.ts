// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
import { ConnectorPayload, Route } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { peerReadEvents } from '../src/peer-reads.ts';
import { Server } from '../src/server.ts';

// .............................................................................
// The hub names the node a ref came from as `src` when it relays it — the
// node the sending connection said hello as. Only the hub knows that, so it
// never passes on a `src` a sender put there itself.
// .............................................................................

const route = Route.fromFlat('peerSource');

interface Connection {
  /** The hub's side of the connection. */
  hubSide: DirectionalSocketMock;
  /** The client's side: what it sends, what it receives. */
  clientSide: DirectionalSocketMock;
  /** The hub's id of this connection. */
  clientId: string;
  /** Payloads relayed to this connection. */
  received: ConnectorPayload[];
}

describe('Server naming the source node of relayed refs', () => {
  let server: Server;

  const connect = async (): Promise<Connection> => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    await server.addSocket(hubSide);
    const received: ConnectorPayload[] = [];
    clientSide.on(route.flat, (payload: ConnectorPayload) => {
      received.push(payload);
    });
    const clientId = (hubSide as unknown as { __clientId: string }).__clientId;
    return { hubSide, clientSide, clientId, received };
  };

  const createServer = async () => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    server = new Server(route, io, new BsMem(), { refEvictionIntervalMs: 0 });
    await server.init();
  };

  afterEach(async () => {
    if (server && !server.isTornDown) await server.tearDown();
  });

  it('names the node a connection said hello as', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });
    a.clientSide.emit(route.flat, { o: 'origin-a', r: 'ref-1' });

    expect(b.received).toHaveLength(1);
    expect(b.received[0]).toMatchObject({ r: 'ref-1', src: 'node-a' });
  });

  it('relays without a source while the connection has not said hello', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(route.flat, { o: 'origin-a', r: 'ref-1' });

    expect(b.received).toHaveLength(1);
    expect(b.received[0].src).toBeUndefined();
  });

  it('replaces a source the sender set with the node it said hello as', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });
    a.clientSide.emit(route.flat, { o: 'o', r: 'ref-1', src: 'node-forged' });

    expect(b.received[0].src).toBe('node-a');
  });

  it('removes a source the sender set when it never said hello', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(route.flat, { o: 'o', r: 'ref-1', src: 'node-forged' });

    expect(b.received).toHaveLength(1);
    expect('src' in b.received[0]).toBe(false);
    expect(b.received[0]).toMatchObject({ o: 'o', r: 'ref-1' });
  });

  it('ignores a hello without a usable node id', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(peerReadEvents.hello);
    a.clientSide.emit(peerReadEvents.hello, {});
    a.clientSide.emit(peerReadEvents.hello, { nodeId: 42 });
    a.clientSide.emit(peerReadEvents.hello, { nodeId: '' });
    a.clientSide.emit(route.flat, { o: 'o', r: 'ref-1' });

    expect(b.received[0].src).toBeUndefined();
  });

  it('takes the latest hello of a connection', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();

    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-old' });
    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-new' });
    a.clientSide.emit(route.flat, { o: 'o', r: 'ref-1' });

    expect(b.received[0].src).toBe('node-new');
  });

  it('keeps each connection to its own node', async () => {
    await createServer();
    const a = await connect();
    const b = await connect();
    const c = await connect();

    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });
    b.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-b' });
    a.clientSide.emit(route.flat, { o: 'oa', r: 'ref-a' });
    b.clientSide.emit(route.flat, { o: 'ob', r: 'ref-b' });

    expect(c.received.map((p) => [p.r, p.src])).toEqual([
      ['ref-a', 'node-a'],
      ['ref-b', 'node-b'],
    ]);
  });

  it('stops listening for the hello of a removed connection', async () => {
    await createServer();
    const a = await connect();
    a.clientSide.emit(peerReadEvents.hello, { nodeId: 'node-a' });
    const off = vi.spyOn(a.hubSide, 'off');

    await server.removeSocket(a.clientId);

    expect(off).toHaveBeenCalledWith(
      peerReadEvents.hello,
      expect.any(Function),
    );
  });

  it('removes a connection that never got as far as a hello', async () => {
    await createServer();
    await expect(server.removeSocket('client-never-added')).resolves.toBe(
      undefined,
    );
  });
});
