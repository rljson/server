// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { exampleTableCfg } from '@rljson/rljson';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client.ts';
import { createChannelPair } from '../src/channel-socket.ts';
import { HubRoutesOptions } from '../src/hub-routes.ts';
import { Node } from '../src/node.ts';
import { ClientRoute, LocalStores } from '../src/route-member.ts';
import { SocketLike } from '../src/socket-bundle.ts';
import { serveWorkerRoute, WorkerRoute } from '../src/worker-route.ts';

import { FakeCloud, freePort, SocketIoPorts } from './helpers/node-network.ts';

// .............................................................................
// Nodes as the One Client runs them: real Socket.IO between real Nodes, each
// on its own port, the network manager electing the hub through a cloud that
// the test controls. Every node takes part in one route; its member writes
// rows and blobs into local stores and announces them through a connector.
// Peer reads are on: readers fetch from the node that sent the ref, the hub is
// the fallback. Each port counts what it served route clients — the hub load.
// .............................................................................

const treeKey = 'meshTree';
const notes = 'notes';

/** Local stores with the notes table. */
const openStores = async (): Promise<LocalStores> => {
  const io = new IoMem();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: exampleTableCfg({ key: notes }) });
  return { io, bs: new BsMem() };
};

/** Hub stores with the notes table, for every route. */
const hubOptions: Omit<HubRoutesOptions, 'logger'> = {
  treeKeys: [treeKey],
  createStores: openStores,
};

/** The agent of a mesh member: a connector for the route's refs. */
interface MeshAgent {
  connector: Connector;
  stop: () => void;
}

describe('Nodes over real Socket.IO', () => {
  let dir: string;
  let cloud: FakeCloud;
  let ports: SocketIoPorts;
  let nodes: Node[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'node-mesh-'));
    cloud = new FakeCloud();
    ports = new SocketIoPorts();
    nodes = [];
  });

  afterEach(async () => {
    for (const node of nodes) await node.stop();
    ports.closeAll();
    await rm(dir, { recursive: true, force: true });
  });

  /** Starts a node with one route member over in-memory local stores. */
  const startNode = async (member = clientMember(), peerReads = true) => {
    const port = await freePort();
    const node = new Node(
      {
        domain: 'mesh',
        port,
        identityDir: join(dir, String(port)),
        network: FakeCloud.network(),
        hub: hubOptions,
        members: [member],
        ...(peerReads
          ? { peerReads: { timeoutMs: 500, connectTimeoutMs: 500 } }
          : {}),
        reconnectDelayMs: 20,
        retryMs: 100,
        driftCheckMs: 0,
        hubSelfCheckMs: 0,
      },
      {
        createPortTransport: ports.createPortTransport,
        connectHub: ports.connectHub,
        connectPeer: ports.connectPeer,
        networkManagerOptions: cloud.networkManagerOptions,
      },
    );
    nodes.push(node);
    await node.start();
    return node;
  };

  /** A member that runs a connector for the route. */
  const clientMember = () =>
    new ClientRoute({
      treeKey,
      openStores,
      createAgent: async ({ client, socket, route }) => {
        const connector = new Connector(new Db(client.io!), route, socket);
        return { connector, stop: () => connector.tearDown() } as MeshAgent;
      },
    });

  /** A node's member. */
  const memberOf = (node: Node) => node.members.get(treeKey) as ClientRoute;

  /** A node's connector. */
  const connectorOf = (node: Node) =>
    (memberOf(node).agent as unknown as MeshAgent).connector;

  /** A node's port. */
  const portOf = (node: Node) => node['_config'].port as number;

  /** Makes a node the hub and waits until every member is connected to it. */
  const electHub = async (hub: Node) => {
    cloud.assignedHub = hub.nodeId!;
    await vi.waitFor(
      () => {
        expect(
          hub.hubRoutes!.server(treeKey)!.connectedNodes.sort(),
        ).toEqual(nodes.map((n) => n.nodeId!).sort());
        for (const node of nodes) expect(memberOf(node).agent).toBeDefined();
      },
      { timeout: 5000 },
    );
  };

  /** Writes a note into a node's local store and announces it. */
  const writeAndAnnounce = async (node: Node, text: string) => {
    const client = memberOf(node).client!;
    await client.io!.write({
      data: { [notes]: { _data: [{ a: text, b: text.length }] } },
    } as never);
    const dumped = await client.io!.dumpTable({ table: notes });
    const hash = (dumped[notes]._data as { _hash: string; a: string }[]).find(
      (row) => row.a === text,
    )!._hash;
    const blob = await client.bs!.setBlob(Buffer.from(text));
    const ref = `ref-${text}`;
    const others = nodes.filter((n) => n !== node);
    const arrived = others.map(
      (n) =>
        new Promise<void>((resolve) =>
          connectorOf(n).listen(async (r) => {
            if (r === ref) resolve();
          }),
        ),
    );
    connectorOf(node).send(ref);
    await Promise.all(arrived);
    return { hash, blobId: blob.blobId };
  };

  /** Reads a note and a blob on a node through its member's client. */
  const read = async (node: Node, hash: string, blobId: string) => {
    const client = memberOf(node).client!;
    const rows = await client.io!.readRows({
      table: notes,
      where: { _hash: hash },
    });
    const { content } = await client.bs!.getBlob(blobId);
    return {
      text: (rows[notes]._data[0] as { a: string }).a,
      blob: content.toString(),
    };
  };

  /** What the hub's port served route clients. */
  const hubLoad = (hub: Node) => ports.hubServed.get(portOf(hub))!;

  // ...........................................................................
  it('reads announced data straight from its sender, and the hub serves none of it', async () => {
    const [hub, a, b, c] = [
      await startNode(),
      await startNode(),
      await startNode(),
      await startNode(),
    ];
    await electHub(hub);

    const { hash, blobId } = await writeAndAnnounce(a, 'note of A');
    for (const reader of [b, c, hub]) {
      expect(await read(reader, hash, blobId)).toEqual({
        text: 'note of A',
        blob: 'note of A',
      });
    }

    expect(hubLoad(hub)).toEqual({ rows: 0, blobs: 0 });
    const served = memberOf(a).peerServer!.stats;
    expect(served.rowReads).toBeGreaterThanOrEqual(2);
    expect(served.blobReads).toBeGreaterThanOrEqual(2);
    for (const reader of [b, c]) {
      expect(memberOf(reader).client!.peerReads!.stats.failures).toBe(0);
    }
  });

  // ...........................................................................
  it('takes every read to the hub with peer reads off — the measure above counts', async () => {
    const off = () => startNode(clientMember(), false);
    const [hub, a, b] = [await off(), await off(), await off()];
    await electHub(hub);

    const { hash, blobId } = await writeAndAnnounce(a, 'note of A');
    expect(await read(b, hash, blobId)).toEqual({
      text: 'note of A',
      blob: 'note of A',
    });

    expect(hubLoad(hub).rows).toBeGreaterThan(0);
    expect(hubLoad(hub).blobs).toBeGreaterThan(0);
    expect(memberOf(a).peerServer).toBeUndefined();
    expect(memberOf(b).client!.peerReads).toBeUndefined();
  });

  // ...........................................................................
  it('follows the hub when it moves, and keeps reading from senders', async () => {
    const [a, b, c] = [await startNode(), await startNode(), await startNode()];
    await electHub(a);
    const first = await writeAndAnnounce(b, 'before the move');
    expect(await read(c, first.hash, first.blobId)).toEqual({
      text: 'before the move',
      blob: 'before the move',
    });

    await electHub(c);
    const second = await writeAndAnnounce(b, 'after the move');

    expect(await read(a, second.hash, second.blobId)).toEqual({
      text: 'after the move',
      blob: 'after the move',
    });
    expect(hubLoad(c)).toEqual({ rows: 0, blobs: 0 });
    expect(c.hubAddress).toBe(`127.0.0.1:${portOf(c)}`);
    expect(a.hubAddress).toBe(`127.0.0.1:${portOf(c)}`);
  });

  // ...........................................................................
  it('reads from the hub when the sender is gone', async () => {
    const [hub, a, b] = [await startNode(), await startNode(), await startNode()];
    await electHub(hub);
    const { hash, blobId } = await writeAndAnnounce(a, 'A leaves after this');

    // A's port closes: no peer reaches A any more. A's member is still a
    // client of the hub, so the hub's cascade can still fetch from it.
    await (a['_transport'] as { close: () => Promise<void> }).close();

    expect(await read(b, hash, blobId)).toEqual({
      text: 'A leaves after this',
      blob: 'A leaves after this',
    });
    expect(hubLoad(hub).rows).toBeGreaterThan(0);
    expect(memberOf(b).client!.peerReads!.stats.failures).toBe(1);
  });

  // ...........................................................................
  it('refuses a route client on a node that is not hub', async () => {
    const [hub, other] = [await startNode(), await startNode()];
    await electHub(hub);
    const signal = new AbortController().signal;

    await expect(
      ports.connectHub(`127.0.0.1:${portOf(other)}`, { treeKey, signal }),
    ).rejects.toThrow('Not accepted');
    await expect(
      ports.connectPeer(`127.0.0.1:${portOf(other)}`, { treeKey, signal }),
    ).resolves.toBeDefined();
  });

  // ...........................................................................
  it('serves peers from a route that runs in a worker, through its channel', async () => {
    const workers: { stop: () => Promise<void> }[] = [];
    const workerMember = new WorkerRoute({
      treeKey,
      respawnMs: 100,
      launch: async (context) => {
        // The worker: what a child process would run, in this process —
        // its own connection to the hub, its own stores, a channel to the
        // parent.
        const [parentEnd, workerEnd] = createChannelPair();
        const { io, bs } = await openStores();
        const serving = await serveWorkerRoute({
          channel: workerEnd,
          tag: context.tag,
          io,
          bs,
        });
        const socket = await ports.connectHub(context.hubAddress, {
          treeKey,
          signal: new AbortController().signal,
        });
        const client = new Client(socket, io, bs, undefined, {
          nodeId: context.nodeId,
          peerReads: {
            ...context.peerReads,
            nodeId: context.nodeId,
            route: context.route,
            connect: serving.connectPeer((address, signal) =>
              ports.connectPeer(address, { treeKey, signal }),
            ),
          },
          ownsStores: false,
        });
        await client.init();
        const connector = new Connector(new Db(client.io!), context.route, socket);
        let exit: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => (exit = resolve));
        const worker = {
          stop: async () => {
            connector.tearDown();
            await client.tearDown();
            await serving.close();
            (socket as SocketLike & { disconnect: () => void }).disconnect();
            exit();
          },
        };
        workers.push(worker);
        workerState.client = client;
        workerState.connector = connector;
        return { channel: parentEnd, exited, stop: worker.stop };
      },
    });
    const workerState: { client?: Client; connector?: Connector } = {};

    const hub = await startNode();
    const withWorker = await startNode(workerMember as never);
    const reader = await startNode();
    cloud.assignedHub = hub.nodeId!;
    await vi.waitFor(
      () => {
        expect(hub.hubRoutes!.server(treeKey)!.connectedNodes).toHaveLength(3);
        expect(workerState.connector).toBeDefined();
        expect(memberOf(reader).agent).toBeDefined();
      },
      { timeout: 5000 },
    );

    // The worker writes and announces.
    const client = workerState.client!;
    await client.io!.write({
      data: { [notes]: { _data: [{ a: 'from the worker', b: 1 }] } },
    } as never);
    const dumped = await client.io!.dumpTable({ table: notes });
    const hash = (dumped[notes]._data[0] as { _hash: string })._hash;
    const { blobId } = await client.bs!.setBlob(Buffer.from('worker blob'));
    const arrived = new Promise<void>((resolve) =>
      connectorOf(reader).listen(async (r) => {
        if (r === 'ref-worker') resolve();
      }),
    );
    workerState.connector!.send('ref-worker');
    await arrived;

    const rows = await memberOf(reader).client!.io!.readRows({
      table: notes,
      where: { _hash: hash },
    });
    const { content } = await memberOf(reader).client!.bs!.getBlob(blobId);

    expect((rows[notes]._data[0] as { a: string }).a).toBe('from the worker');
    expect(content.toString()).toBe('worker blob');
    expect(hubLoad(hub)).toEqual({ rows: 0, blobs: 0 });
    expect(workerMember.peerServer!.stats.rowReads).toBeGreaterThan(0);
    expect(workerMember.peerServer!.stats.blobReads).toBeGreaterThan(0);
    expect(withWorker.hubAddress).toBe(`127.0.0.1:${portOf(hub)}`);
  });
});
