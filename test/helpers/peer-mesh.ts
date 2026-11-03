// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { staticExample } from '@rljson/db';
import { IoMem } from '@rljson/io';
import { exampleTableCfg, Route } from '@rljson/rljson';

import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  Server as SocketIoServer,
  Socket as SocketIoServerSocket,
} from 'socket.io';
import {
  io as socketIoClient,
  Socket as SocketIoClientSocket,
} from 'socket.io-client';

import { Client } from '../../src/client.ts';
import { PeerReadServer } from '../../src/peer-read-server.ts';
import { PeerReadsOptions } from '../../src/peer-reads.ts';
import { Server } from '../../src/server.ts';
import { SocketIoBridge } from '../../src/socket-io-bridge.ts';

/** A plain components table every node knows, for per-node rows. */
export const notesTable = 'notes';

/** Requests a hub served one client, by kind. */
export interface HubServed {
  rows: number;
  blobs: number;
}

/**
 * How a node answers peer connections:
 * - `serving` — like every node with peer reads on
 * - `silent` — accepts the connection and never answers (a hung process, a
 *   firewall that lets the handshake through)
 * - `refusing` — its port is closed
 * - `unknown` — no address for it (another site, no IP)
 */
export type PeerBehaviour = 'serving' | 'silent' | 'refusing' | 'unknown';

/** One emulated node of the mesh. */
export interface MeshNode {
  readonly name: string;
  readonly nodeId: string;
  readonly isHub: boolean;
  port: number;
  readonly io: IoMem;
  readonly bs: BsMem;
  readonly peerServer: PeerReadServer;
  /** The hub, on node 0 only. */
  server?: Server;
  /** The client, on every other node. */
  client?: Client;
  /** This client's socket to the hub. */
  hubSocket?: SocketIoClientSocket;
  /** What the hub served this client, counted on the hub's side. */
  readonly hubServed: HubServed;
  behaviour: PeerBehaviour;
  readonly httpServer: HttpServer;
  readonly ioServer: SocketIoServer;
}

/** Options of {@link createPeerMesh}. */
export interface PeerMeshOptions {
  /** Clients besides the hub. */
  clients: number;
  /**
   * Peer reads of every client; `false` for none — today's behaviour. Bounds
   * merge over test-friendly defaults.
   */
  peerReads?: Partial<Omit<PeerReadsOptions, 'nodeId' | 'connect'>> | false;
}

/** A running mesh. */
export interface PeerMesh {
  readonly route: Route;
  readonly hub: MeshNode;
  readonly clients: MeshNode[];
  readonly nodes: MeshNode[];
  /** Every peer connection a client opened, by target node name. */
  readonly peerConnections: Map<string, number>;
  /** Sends a ref from a client and resolves once every other client got it. */
  announce: (from: MeshNode, ref: string) => Promise<void>;
  /** Closes a client's peer port for good. */
  closePeerPort: (node: MeshNode) => Promise<void>;
  /** Total of what the hub served all clients. */
  hubServedTotal: () => HubServed;
  tearDown: () => Promise<void>;
}

const readEvents: Record<string, keyof HubServed> = {
  readRows: 'rows',
  readRowsByHashes: 'rows',
  getBlob: 'blobs',
  getBlobProperties: 'blobs',
  blobExists: 'blobs',
};

/** Listens on a free port. */
const listen = (httpServer: HttpServer): Promise<number> =>
  new Promise((resolve) => {
    httpServer.listen(0, () =>
      resolve((httpServer.address() as AddressInfo).port),
    );
  });

/** Resolves once a client socket is connected, rejects on a connect error. */
const connected = (
  socket: SocketIoClientSocket,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) => reject(error));
    signal?.addEventListener('abort', () => {
      socket.disconnect();
      reject(new Error('aborted'));
    });
  });

/**
 * A mesh of emulated nodes over real Socket.IO, shaped like an application's.
 *
 * Every node has local in-memory stores, a {@link PeerReadServer} over them
 * and its own HTTP + Socket.IO server on its own port — the node's port.
 * Node 0 is the hub: a {@link Server} over its local stores, taking hub
 * connections on its port. Every other node is a {@link Client} with one
 * real Socket.IO connection to the hub. A peer connection carries
 * `auth: { peerRead: true }` and goes to the target's PeerReadServer, as a
 * node's port routes it.
 *
 * The hub counts, on its own side of each connection, what that client asked
 * it to read: the load peer reads are meant to take off it.
 * @param options - Number of clients, peer reads.
 * @returns The running mesh.
 */
export const createPeerMesh = async (
  options: PeerMeshOptions,
): Promise<PeerMesh> => {
  const route = Route.fromFlat('peerMesh');
  const peerConnections = new Map<string, number>();
  const nodes: MeshNode[] = [];
  const clientSockets: SocketIoClientSocket[] = [];

  const byId = (nodeId: string) => nodes.find((n) => n.nodeId === nodeId);

  // ...........................................................................
  // The nodes and their ports
  for (let i = 0; i <= options.clients; i++) {
    const name = i === 0 ? 'hub' : String.fromCharCode(64 + i); // A, B, C …
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();
    const httpServer = createServer();
    const ioServer = new SocketIoServer(httpServer, {
      maxHttpBufferSize: 64 * 1024 * 1024,
    });
    const node: MeshNode = {
      name,
      nodeId: `node-${name}`,
      isHub: i === 0,
      port: 0,
      io,
      bs,
      peerServer: new PeerReadServer(io, bs),
      hubServed: { rows: 0, blobs: 0 },
      behaviour: 'serving',
      httpServer,
      ioServer,
    };
    ioServer.on('connection', (socket: SocketIoServerSocket) => {
      if (socket.handshake.auth?.peerRead) {
        // `silent`: keep the connection open and never answer.
        if (node.behaviour === 'serving') {
          void node.peerServer.addSocket(new SocketIoBridge(socket));
        }
        return;
      }
      /* v8 ignore if -- @preserve */
      if (!node.server) {
        socket.disconnect();
        return;
      }
      const client = byId(String(socket.handshake.auth?.nodeId));
      for (const [event, kind] of Object.entries(readEvents)) {
        socket.on(event, () => {
          if (client) client.hubServed[kind]++;
        });
      }
      void node.server.addSocket(new SocketIoBridge(socket));
    });
    node.port = await listen(httpServer);
    nodes.push(node);
  }

  const [hub, ...clients] = nodes;

  // ...........................................................................
  // The hub
  const tableCfgs = staticExample().tableCfgs._data;
  hub.server = new Server(route, hub.io, hub.bs, { refEvictionIntervalMs: 0 });
  await hub.server.init();
  await hub.server.createTables({ withInsertHistory: tableCfgs });
  await hub.io.createOrExtendTable({
    tableCfg: exampleTableCfg({ key: notesTable }),
  });

  // ...........................................................................
  // How a client reaches a peer — what Node does with the topology
  const connect = async (
    nodeId: string,
    signal: AbortSignal,
  ): Promise<SocketIoBridge | undefined> => {
    const target = byId(nodeId);
    if (!target || target.isHub || target.behaviour === 'unknown') {
      return undefined;
    }
    peerConnections.set(
      target.name,
      (peerConnections.get(target.name) ?? 0) + 1,
    );
    const socket = socketIoClient(`http://localhost:${target.port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      auth: { peerRead: true },
    });
    clientSockets.push(socket);
    await connected(socket, signal);
    return new SocketIoBridge(socket);
  };

  // ...........................................................................
  // The clients
  for (const node of clients) {
    const socket = socketIoClient(`http://localhost:${hub.port}`, {
      forceNew: true,
      transports: ['websocket'],
      auth: { nodeId: node.nodeId },
    });
    clientSockets.push(socket);
    await connected(socket);
    node.hubSocket = socket;
    node.client = new Client(new SocketIoBridge(socket), node.io, node.bs, route, {
      ...(options.peerReads === false
        ? {}
        : {
            peerReads: {
              timeoutMs: 300,
              connectTimeoutMs: 300,
              ...options.peerReads,
              nodeId: node.nodeId,
              connect,
            },
          }),
    });
    await node.client.init();
    await node.client.createTables({ withInsertHistory: tableCfgs });
    await node.io.createOrExtendTable({
      tableCfg: exampleTableCfg({ key: notesTable }),
    });
  }

  // ...........................................................................
  const announce = async (from: MeshNode, ref: string) => {
    const others = clients.filter((n) => n !== from);
    const arrived = others.map(
      (node) =>
        new Promise<void>((resolve) => {
          node.client!.connector!.listen(async (r) => {
            if (r === ref) resolve();
          });
        }),
    );
    from.client!.connector!.send(ref);
    await Promise.all(arrived);
  };

  const closePeerPort = async (node: MeshNode) => {
    node.behaviour = 'refusing';
    node.ioServer.disconnectSockets(true);
    await new Promise<void>((resolve) => {
      node.ioServer.close(() => resolve());
    });
  };

  const hubServedTotal = (): HubServed =>
    clients.reduce(
      (sum, n) => ({
        rows: sum.rows + n.hubServed.rows,
        blobs: sum.blobs + n.hubServed.blobs,
      }),
      { rows: 0, blobs: 0 },
    );

  const tearDown = async () => {
    for (const node of clients) await node.client?.tearDown();
    if (hub.server && !hub.server.isTornDown) await hub.server.tearDown();
    for (const node of nodes) await node.peerServer.close();
    for (const socket of clientSockets) socket.disconnect();
    for (const node of nodes) {
      if (node.behaviour !== 'refusing') {
        node.ioServer.disconnectSockets(true);
        await new Promise<void>((resolve) => {
          node.ioServer.close(() => resolve());
        });
      }
    }
  };

  return {
    route,
    hub,
    clients,
    nodes,
    peerConnections,
    announce,
    closePeerPort,
    hubServedTotal,
    tearDown,
  };
};
