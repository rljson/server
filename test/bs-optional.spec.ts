// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { describe, expect, it } from 'vitest';

import { Client } from '../src/client';
import { Server } from '../src/server';

// A route that carries no blobs needs no blob store.
//
// The components/edits mongo sync is exactly that shape: documents are Io rows
// and it never calls getBlob or setBlob. Until `Bs` became optional it still
// had to be handed one purely to satisfy the constructor, so every relay route
// carried a blob directory that stayed empty for the life of the process — and
// the cloud EventHub would have had to provision a volume for a route that
// cannot use one.
describe('a node without a Bs', () => {
  it('constructs and initialises a Server with no blob store', async () => {
    const io = new IoMem();
    await io.init();

    const server = new Server(Route.fromFlat('mongoSharedDb'), io);
    await server.init();

    // The Bs layer still exists — it simply has no local member to write to.
    expect(server.bs).toBeDefined();

    await server.tearDown();
  });

  it('constructs and initialises a Client with no blob store', async () => {
    const io = new IoMem();
    await io.init();

    const socket = new SocketMock();
    socket.connect();

    const client = new Client(socket, io, undefined, Route.fromFlat('mongoSharedDb'));
    await client.init();

    expect(client.connector).toBeDefined();

    await client.tearDown();
  });

  it('refuses a blob write loudly rather than silently accepting it', async () => {
    // The failure mode that matters. A node with nowhere to put a blob must
    // say so — a silent success would leave a ref pointing at content that
    // was never stored anywhere, and content addressing makes that
    // indistinguishable from a blob that simply has not arrived yet.
    const io = new IoMem();
    await io.init();

    const server = new Server(Route.fromFlat('mongoSharedDb'), io);
    await server.init();

    await expect(server.bs!.setBlob(Buffer.from('nowhere to go'))).rejects.toThrow(
      /No writable Bs available/,
    );

    await server.tearDown();
  });

  it('still accepts a Bs when the route has one — file sync is unchanged', async () => {
    const { BsMem } = await import('@rljson/bs');
    const io = new IoMem();
    await io.init();

    const server = new Server(Route.fromFlat('fileTree'), io, new BsMem());
    await server.init();

    const { blobId } = await server.bs!.setBlob(Buffer.from('hello'));
    expect(blobId).toBeTruthy();

    await server.tearDown();
  });
});
