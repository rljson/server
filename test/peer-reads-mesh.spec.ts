// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsPeer } from '@rljson/bs';
import { staticExample } from '@rljson/db';
import { IoPeer } from '@rljson/io';
import { exampleTableCfg, Route } from '@rljson/rljson';

import { io as socketIoClient } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import { SocketIoBridge } from '../src/socket-io-bridge.ts';

import {
  createPeerMesh,
  MeshNode,
  notesTable,
  PeerMesh,
} from './helpers/peer-mesh.ts';

// .............................................................................
// Peer reads, end to end, over real Socket.IO connections between emulated
// nodes: one hub and several clients, each with its own port, shaped like an
// application's nodes. The hub counts what each client asked it to read —
// the load peer reads are meant to take off it.
// .............................................................................

const carCake = Route.fromFlat('carCake');

/** The peer bound the mesh uses (`timeoutMs`). */
const peerBoundMs = 300;

/** Imports the static example on a node; returns the ref of its first car. */
const importCars = async (node: MeshNode): Promise<string> => {
  await node.client!.import(staticExample());
  const cars = await node.client!.db!.get(carCake, {});
  return cars.rljson.carCake._data[0]._hash as string;
};

/** Reads a car on a node through its multi: local, then peers, then the hub. */
const readCar = async (node: MeshNode, ref: string) => {
  const result = await node.client!.db!.get(carCake, { _hash: ref });
  return result.rljson.carCake._data[0];
};

/** Writes a row only this node holds; returns its hash. */
const writeNote = async (node: MeshNode, text: string): Promise<string> => {
  await node.client!.io!.write({
    data: { [notesTable]: { _data: [{ a: text, b: text.length }] } },
  } as never);
  const dumped = await node.io.dumpTable({ table: notesTable });
  const rows = dumped[notesTable]._data as { _hash: string; a: string }[];
  return rows.find((row) => row.a === text)!._hash;
};

/** Reads a note on a node through its multi. */
const readNote = async (node: MeshNode, hash: string) => {
  const result = await node.client!.io!.readRows({
    table: notesTable,
    where: { _hash: hash },
  });
  return (result[notesTable]._data[0] as { a: string } | undefined)?.a;
};

/** Milliseconds a promise took, and its value. */
const timed = async <T>(work: Promise<T>) => {
  const started = Date.now();
  const value = await work;
  return { value, ms: Date.now() - started };
};

/** Reads a whole stream into one buffer. */
const drain = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    chunks.push(Buffer.from(value));
  }
};

/** Opens a raw peer connection to a node, as another node would. */
const rawPeerConnection = async (node: MeshNode) => {
  const socket = socketIoClient(`http://localhost:${node.port}`, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
    auth: { peerRead: true },
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const bridge = new SocketIoBridge(socket);
  const io = new IoPeer(bridge, 2000);
  const bs = new BsPeer(bridge, { requestTimeoutMs: 2000 });
  await io.init();
  await bs.init();
  return { io, bs, close: () => socket.disconnect() };
};

describe('Peer reads over real Socket.IO', () => {
  let mesh: PeerMesh;

  afterEach(async () => {
    await mesh?.tearDown();
  });

  // ...........................................................................
  describe('with the sender reachable', () => {
    it('serves an announced ref from its sender, and the hub serves none of it', async () => {
      mesh = await createPeerMesh({ clients: 4 });
      const [a, b, c, d] = mesh.clients;
      const ref = await importCars(a);
      const blob = await a.client!.bs!.setBlob(Buffer.from('a file of A'));

      await mesh.announce(a, ref);

      const expected = await readCar(a, ref);
      for (const receiver of [b, c, d]) {
        expect(await readCar(receiver, ref)).toEqual(expected);
        const { content } = await receiver.client!.bs!.getBlob(blob.blobId);
        expect(content.toString()).toBe('a file of A');
      }

      expect(mesh.hubServedTotal()).toEqual({ rows: 0, blobs: 0 });
      expect(a.peerServer.stats.rowReads).toBeGreaterThan(0);
      expect(a.peerServer.stats.blobReads).toBeGreaterThan(0);
      for (const receiver of [b, c, d]) {
        expect(receiver.client!.peerReads!.stats.failures).toBe(0);
        expect(receiver.client!.peerReads!.stats.hits).toBeGreaterThan(0);
        expect(receiver.client!.peerReads!.connectedPeers).toEqual([a.nodeId]);
      }
    });

    it('takes the reads to the hub when peer reads are off — the measure above counts', async () => {
      mesh = await createPeerMesh({ clients: 3, peerReads: false });
      const [a, b, c] = mesh.clients;
      const ref = await importCars(a);
      const blob = await a.client!.bs!.setBlob(Buffer.from('a file of A'));

      await mesh.announce(a, ref);

      const expected = await readCar(a, ref);
      for (const receiver of [b, c]) {
        expect(await readCar(receiver, ref)).toEqual(expected);
        const { content } = await receiver.client!.bs!.getBlob(blob.blobId);
        expect(content.toString()).toBe('a file of A');
        expect(receiver.hubServed.rows).toBeGreaterThan(0);
        expect(receiver.hubServed.blobs).toBeGreaterThan(0);
      }
      expect(a.peerServer.stats).toEqual({ rowReads: 0, blobReads: 0 });
      expect(mesh.peerConnections.size).toBe(0);
    });

    it('opens one connection per receiver and sender, however many reads follow', async () => {
      mesh = await createPeerMesh({ clients: 3 });
      const [a, b, c] = mesh.clients;
      const hashes: string[] = [];
      for (let i = 0; i < 10; i++) {
        hashes.push(await writeNote(a, `note ${i} of A`));
        await mesh.announce(a, `ref-${i}`);
      }

      for (const receiver of [b, c]) {
        for (const [i, hash] of hashes.entries()) {
          expect(await readNote(receiver, hash)).toBe(`note ${i} of A`);
        }
      }

      expect(mesh.peerConnections.get('A')).toBe(2);
      expect(mesh.hubServedTotal().rows).toBe(0);
    });

    it('streams a large blob from its sender in chunks, without the hub', async () => {
      mesh = await createPeerMesh({ clients: 2, peerReads: { blobTimeoutMs: 5000 } });
      const [a, b] = mesh.clients;
      const big = Buffer.alloc(9 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = i % 251;
      const blob = await a.client!.bs!.setBlob(big);
      await mesh.announce(a, 'ref-big');

      const received = await drain(
        await b.client!.bs!.getBlobStream(blob.blobId),
      );

      expect(received.equals(big)).toBe(true);
      expect(b.hubServed.blobs).toBe(0);
      expect(a.peerServer.stats.blobReads).toBeGreaterThanOrEqual(3);
    });

    it('finishes a stream from the hub when the sender breaks off mid-blob', async () => {
      mesh = await createPeerMesh({ clients: 2, peerReads: { blobTimeoutMs: 5000 } });
      const [a, b] = mesh.clients;
      const big = Buffer.alloc(9 * 1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 253;
      const blob = await a.client!.bs!.setBlob(big);
      await mesh.announce(a, 'ref-big');

      const stream = await b.client!.bs!.getBlobStream(blob.blobId);
      const reader = stream.getReader();
      const first = await reader.read();
      await mesh.closePeerPort(a);
      const rest: Buffer[] = [Buffer.from(first.value!)];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest.push(Buffer.from(value));
      }

      expect(Buffer.concat(rest).equals(big)).toBe(true);
      expect(b.hubServed.blobs).toBeGreaterThan(0);
      expect(b.client!.peerReads!.stats.failures).toBe(1);
    });
  });

  // ...........................................................................
  describe('with the sender out of reach', () => {
    it('reads from the hub when the sender refuses the connection', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a, b] = mesh.clients;
      const ref = await importCars(a);
      await mesh.closePeerPort(a);

      await mesh.announce(a, ref);
      const { value, ms } = await timed(readCar(b, ref));

      expect(value).toEqual(await readCar(a, ref));
      expect(ms).toBeLessThan(peerBoundMs + 1000);
      expect(b.hubServed.rows).toBeGreaterThan(0);
      expect(b.client!.peerReads!.stats.failures).toBe(1);
    });

    it('reads from the hub within the bound when the sender never answers, and skips it afterwards', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a, b] = mesh.clients;
      a.behaviour = 'silent';
      const first = await writeNote(a, 'first note of A');
      const second = await writeNote(a, 'second note of A');
      await mesh.announce(a, 'ref-silent');

      const one = await timed(readNote(b, first));
      const two = await timed(readNote(b, second));

      expect(one.value).toBe('first note of A');
      expect(one.ms).toBeGreaterThanOrEqual(peerBoundMs - 20);
      expect(one.ms).toBeLessThan(peerBoundMs + 1000);
      expect(two.value).toBe('second note of A');
      expect(two.ms).toBeLessThan(peerBoundMs);
      expect(b.client!.peerReads!.stats.failures).toBe(1);
      expect(b.hubServed.rows).toBeGreaterThanOrEqual(2);
    });

    it('goes straight to the hub for a sender it has no address for', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a, b] = mesh.clients;
      a.behaviour = 'unknown';
      const hash = await writeNote(a, 'a note of A');
      await mesh.announce(a, 'ref-unknown');

      const { value, ms } = await timed(readNote(b, hash));

      expect(value).toBe('a note of A');
      expect(ms).toBeLessThan(peerBoundMs);
      expect(mesh.peerConnections.size).toBe(0);
      expect(b.client!.peerReads!.stats.failures).toBe(0);
    });

    it('goes to the hub once a sender has left, and keeps the data coming', async () => {
      mesh = await createPeerMesh({ clients: 3 });
      const [a, b, c] = mesh.clients;
      const before = await writeNote(a, 'before A left');
      await mesh.announce(a, 'ref-before');
      expect(await readNote(b, before)).toBe('before A left');
      expect(b.hubServed.rows).toBe(0);

      const after = await writeNote(a, 'after A left');
      await mesh.closePeerPort(a);
      await mesh.announce(a, 'ref-after');

      expect(await readNote(b, after)).toBe('after A left');
      expect(await readNote(c, after)).toBe('after A left');
      expect(b.hubServed.rows).toBeGreaterThan(0);
    });
  });

  // ...........................................................................
  describe('with a sender that lacks the data', () => {
    it('reads from the hub when the hint points at a node without the data', async () => {
      mesh = await createPeerMesh({ clients: 3 });
      const [a, b, c] = mesh.clients;
      const ofC = await writeNote(c, 'only C holds this');
      await mesh.announce(a, 'ref-from-A');

      expect(await readNote(b, ofC)).toBe('only C holds this');
      expect(b.client!.peerReads!.stats.misses).toBeGreaterThan(0);
      expect(b.client!.peerReads!.stats.failures).toBe(0);
      expect(b.hubServed.rows).toBeGreaterThan(0);
    });

    it('answers only from what the peer holds — it never asks further', async () => {
      mesh = await createPeerMesh({ clients: 3 });
      const [a, , c] = mesh.clients;
      const ofC = await writeNote(c, 'only C holds this');
      // A itself can find C's row: its own reads cascade through the hub.
      expect(await readNote(a, ofC)).toBe('only C holds this');
      const ofCNowAlsoOnA = await a.io.readRows({
        table: notesTable,
        where: { _hash: ofC },
      });
      expect(ofCNowAlsoOnA[notesTable]._data).toHaveLength(1);

      // A row only C holds, asked of A directly: A says it does not have it.
      const onlyC = await writeNote(c, 'C again, never read by A');
      const peer = await rawPeerConnection(a);
      const asked = await peer.io.readRows({
        table: notesTable,
        where: { _hash: onlyC },
      });
      peer.close();

      expect(asked[notesTable]._data).toEqual([]);
    });
  });

  // ...........................................................................
  describe('serving', () => {
    it('refuses every change a peer asks for, and the store stays as it was', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a] = mesh.clients;
      const hash = await writeNote(a, 'kept');
      const blob = await a.client!.bs!.setBlob(Buffer.from('kept blob'));
      const before = await a.io.dump();
      const peer = await rawPeerConnection(a);

      await expect(
        peer.io.write({
          data: { [notesTable]: { _data: [{ a: 'intruder', b: 0 }] } },
        } as never),
      ).rejects.toThrow('read-only');
      await expect(
        peer.io.createOrExtendTable({
          tableCfg: exampleTableCfg({ key: 'intruders' }),
        }),
      ).rejects.toThrow('read-only');
      // BsServer sends its errors without their message; the refusal is what
      // counts here.
      const intruder = Buffer.from('intruder');
      await expect(peer.bs.setBlob(intruder)).rejects.toBeDefined();
      await expect(peer.bs.deleteBlob(blob.blobId)).rejects.toBeDefined();
      peer.close();

      expect(await a.io.dump()).toEqual(before);
      expect(await readNote(a, hash)).toBe('kept');
      expect(a.io.isOpen).toBe(true);
      expect(await a.bs.blobExists(blob.blobId)).toBe(true);
      const { blobs } = await a.bs.listBlobs();
      expect(blobs.map((b) => b.blobId)).toEqual([blob.blobId]);
    });

    it('keeps serving a node whose own hub connection is down', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a, b] = mesh.clients;
      const hash = await writeNote(a, 'served while A is off the hub');
      await mesh.announce(a, 'ref-a');
      a.hubSocket!.io.opts.reconnection = false;
      a.hubSocket!.disconnect();

      expect(await readNote(b, hash)).toBe('served while A is off the hub');
      expect(b.hubServed.rows).toBe(0);
    });
  });

  // ...........................................................................
  describe('in a busy network', () => {
    it('serves each round from its sender while every node writes in turn', async () => {
      mesh = await createPeerMesh({ clients: 6 });
      const written: { from: MeshNode; hash: string; text: string }[] = [];

      for (const sender of mesh.clients) {
        const text = `round of ${sender.name}`;
        const hash = await writeNote(sender, text);
        const blob = await sender.client!.bs!.setBlob(Buffer.from(text));
        await mesh.announce(sender, `ref-${sender.name}`);
        for (const receiver of mesh.clients.filter((n) => n !== sender)) {
          expect(await readNote(receiver, hash)).toBe(text);
          const { content } = await receiver.client!.bs!.getBlob(blob.blobId);
          expect(content.toString()).toBe(text);
        }
        written.push({ from: sender, hash, text });
      }

      expect(mesh.hubServedTotal()).toEqual({ rows: 0, blobs: 0 });
      for (const node of mesh.clients) {
        expect(node.peerServer.stats.rowReads).toBeGreaterThanOrEqual(5);
        expect(node.client!.peerReads!.stats.failures).toBe(0);
      }
      expect(written).toHaveLength(6);
    });

    it('delivers everything when all nodes write and read at the same time', async () => {
      mesh = await createPeerMesh({ clients: 6 });

      const notes = await Promise.all(
        mesh.clients.map(async (node) => ({
          node,
          text: `concurrent note of ${node.name}`,
          hash: await writeNote(node, `concurrent note of ${node.name}`),
        })),
      );
      await Promise.all(
        mesh.clients.map((node) => mesh.announce(node, `ref-${node.name}`)),
      );

      const reads = notes.flatMap(({ node, hash, text }) =>
        mesh.clients
          .filter((receiver) => receiver !== node)
          .map(async (receiver) => {
            expect(await readNote(receiver, hash)).toBe(text);
          }),
      );
      await Promise.all(reads);

      for (const node of mesh.clients) {
        expect(node.client!.peerReads!.stats.failures).toBe(0);
      }
      const peerServed = mesh.clients.reduce(
        (sum, node) => sum + node.peerServer.stats.rowReads,
        0,
      );
      expect(peerServed).toBeGreaterThan(0);
    });

    it('still reads older data from the hub once its sender is no longer a recent source', async () => {
      mesh = await createPeerMesh({
        clients: 5,
        peerReads: { maxSourcesPerRead: 1 },
      });
      const [a, b, c, d, e] = mesh.clients;
      const ofA = await writeNote(a, 'old note of A');
      await mesh.announce(a, 'ref-a');
      await mesh.announce(c, 'ref-c');
      await mesh.announce(d, 'ref-d');

      // B's newest source is D now; A's row is found through the hub.
      expect(await readNote(b, ofA)).toBe('old note of A');
      expect(await readNote(e, ofA)).toBe('old note of A');
      expect(b.hubServed.rows).toBeGreaterThan(0);
      expect(b.client!.peerReads!.stats.failures).toBe(0);
    });
  });

  // ...........................................................................
  describe('across a reconnect to the hub', () => {
    it('names the sender again after its hub connection came back', async () => {
      mesh = await createPeerMesh({ clients: 2 });
      const [a, b] = mesh.clients;
      const reconnected = new Promise<void>((resolve) =>
        a.hubSocket!.io.once('reconnect', () => resolve()),
      );
      // A network blip, not a goodbye: the transport drops, the client
      // reconnects on its own.
      [...mesh.hub.ioServer.sockets.sockets.values()]
        .find((s) => s.handshake.auth?.nodeId === a.nodeId)!
        .conn.close();
      await reconnected;
      await new Promise((resolve) => setTimeout(resolve, 100));

      const hash = await writeNote(a, 'after the reconnect');
      await mesh.announce(a, 'ref-after-reconnect');

      expect(await readNote(b, hash)).toBe('after the reconnect');
      expect(b.hubServed.rows).toBe(0);
      expect(b.client!.peerReads!.connectedPeers).toEqual([a.nodeId]);
    });
  });
});
