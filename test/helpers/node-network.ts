// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createSocketPair } from '@rljson/io';
import type {
  CloudHttpClient,
  CloudPeerListResponse,
  NodeInfo,
  PeerProbe,
} from '@rljson/network';

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as socketIoClient, Socket as ClientSocket } from 'socket.io-client';

import type {
  ConnectRoute,
  CreatePortTransport,
  PortHandshake,
  PortTransport,
} from '../../src/node.ts';
import type { SocketLike } from '../../src/socket-bundle.ts';
import { SocketIoBridge } from '../../src/socket-io-bridge.ts';

// .............................................................................
/**
 * A cloud coordinator in memory: every node registers, every node sees every
 * other at 127.0.0.1, and the test decides the hub (`hubPolicy: 'auto'`).
 */
export class FakeCloud implements CloudHttpClient {
  readonly nodes = new Map<string, NodeInfo>();
  assignedHub: string | null = null;

  /** Network options a node needs to use this cloud. */
  get networkManagerOptions() {
    return {
      cloudDeps: { createHttpClient: () => this },
      probeFn: async (
        _host: string,
        _port: number,
        fromNodeId: string,
        toNodeId: string,
      ): Promise<PeerProbe> => ({
        fromNodeId,
        toNodeId,
        reachable: true,
        latencyMs: 1,
        measuredAt: Date.now(),
      }),
    };
  }

  /** Network config of a node using this cloud. */
  static network(pollIntervalMs = 40) {
    return {
      broadcast: { enabled: false, port: 41234 },
      cloud: { enabled: true, endpoint: 'http://fake.cloud', pollIntervalMs },
      probing: { enabled: true, intervalMs: 60_000 },
    };
  }

  async register(_endpoint: string, info: NodeInfo) {
    this.nodes.set(info.nodeId, { ...info, localIps: ['127.0.0.1'] });
    return this._answer();
  }

  async poll() {
    return this._answer();
  }

  async reportProbes() {}

  private _answer(): CloudPeerListResponse {
    return {
      peers: [...this.nodes.values()],
      assignedHub: this.assignedHub,
      hubPolicy: 'auto',
    };
  }
}

// .............................................................................
/** A free TCP port, found by binding port 0. */
export const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

// .............................................................................
/**
 * Ports in memory: every node's port is an entry here, and a connection is a
 * socket pair. Fast, and enough for everything but the wire.
 */
export class InProcessPorts {
  private readonly _ports = new Map<
    number,
    {
      check?: (handshake: PortHandshake) => boolean;
      handler?: (socket: SocketLike, handshake: PortHandshake) => void;
    }
  >();

  /** Connections attempted, by kind and outcome. */
  readonly log: { port: number; handshake: PortHandshake; ok: boolean }[] = [];

  /** Opens a port. */
  readonly createPortTransport: CreatePortTransport = async (port) => {
    if (this._ports.has(port)) throw new Error(`EADDRINUSE ${port}`);
    const entry: {
      check?: (handshake: PortHandshake) => boolean;
      handler?: (socket: SocketLike, handshake: PortHandshake) => void;
    } = {};
    this._ports.set(port, entry);
    const transport: PortTransport = {
      accept: (check) => (entry.check = check),
      onConnection: (handler) => (entry.handler = handler),
      close: async () => {
        this._ports.delete(port);
      },
    };
    return transport;
  };

  /**
   * Connects to a port; rejects like a refused or failed connect.
   * @param address - `ip:port`.
   * @param handshake - What the connection says about itself.
   * @returns The client side.
   */
  async connect(address: string, handshake: PortHandshake) {
    const port = Number(address.split(':')[1]);
    const entry = this._ports.get(port);
    const ok = !!entry && (entry.check?.(handshake) ?? true);
    this.log.push({ port, handshake, ok });
    if (!entry) throw new Error(`ECONNREFUSED ${address}`);
    if (!ok) throw new Error(`refused ${address}`);
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    clientSide.connect();
    entry.handler?.(serverSide, handshake);
    return clientSide;
  }

  /** Opens a route client's connection. */
  readonly connectHub: ConnectRoute = (address, { treeKey }) =>
    this.connect(address, { treeKeys: [treeKey] });

  /** Opens a peer connection. */
  readonly connectPeer: ConnectRoute = (address, { treeKey }) =>
    this.connect(address, { treeKeys: [treeKey], peerRead: true });
}

// .............................................................................
/**
 * Ports over real Socket.IO, shaped like an application's: one HTTP + Socket.IO
 * server per node, a middleware that refuses what the node does not accept,
 * and client sockets that name their route in the handshake.
 */
export class SocketIoPorts {
  private readonly _clients: ClientSocket[] = [];

  /**
   * Reads each port served to route clients — the hub's load — counted on
   * the port's side of every connection that is not a peer.
   */
  readonly hubServed = new Map<number, { rows: number; blobs: number }>();

  /** Opens a port. */
  readonly createPortTransport: CreatePortTransport = async (port) => {
    const httpServer = createServer();
    const ioServer = new SocketIoServer(httpServer, {
      maxHttpBufferSize: 64 * 1024 * 1024,
    });
    let check: (handshake: PortHandshake) => boolean = () => true;
    let handler: (socket: SocketLike, handshake: PortHandshake) => void = () =>
      undefined;
    const handshakeOf = (auth: Record<string, unknown>): PortHandshake => ({
      treeKeys: Array.isArray(auth.treeKeys)
        ? (auth.treeKeys as string[])
        : undefined,
      peerRead: auth.peerRead === true,
    });
    ioServer.use((socket, next) => {
      if (check(handshakeOf(socket.handshake.auth))) next();
      else next(new Error('Not accepted'));
    });
    const served = { rows: 0, blobs: 0 };
    this.hubServed.set(port, served);
    ioServer.on('connection', (socket) => {
      const handshake = handshakeOf(socket.handshake.auth);
      if (!handshake.peerRead) {
        for (const event of ['readRows', 'readRowsByHashes']) {
          socket.on(event, () => served.rows++);
        }
        for (const event of [
          'getBlobBlocks',
          'getBlock',
          'blockExists',
          'getBlobProperties',
          'blobExists',
        ]) {
          socket.on(event, () => served.blobs++);
        }
      }
      handler(new SocketIoBridge(socket), handshake);
    });
    await new Promise<void>((resolve) =>
      httpServer.listen(port, '127.0.0.1', resolve),
    );
    return {
      accept: (c) => (check = c),
      onConnection: (h) => (handler = h),
      close: async () => {
        ioServer.disconnectSockets(true);
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      },
    };
  };

  /**
   * Connects to a port; rejects on a connect error.
   * @param address - `ip:port`.
   * @param auth - The handshake.
   * @param signal - Aborts the attempt.
   * @returns The client side.
   */
  async connect(
    address: string,
    auth: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<SocketLike> {
    const socket = socketIoClient(`http://${address}`, {
      forceNew: true,
      transports: ['websocket'],
      reconnection: auth.peerRead !== true,
      auth,
    });
    this._clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error) => {
        socket.disconnect();
        reject(error);
      });
      signal.addEventListener('abort', () => {
        socket.disconnect();
        reject(new Error('aborted'));
      });
    });
    return new SocketIoBridge(socket);
  }

  /** Opens a route client's connection. */
  readonly connectHub: ConnectRoute = (address, { treeKey, signal }) =>
    this.connect(address, { treeKeys: [treeKey] }, signal);

  /** Opens a peer connection. */
  readonly connectPeer: ConnectRoute = (address, { treeKey, signal }) =>
    this.connect(address, { treeKeys: [treeKey], peerRead: true }, signal);

  /** Disconnects every client socket opened here. */
  closeAll(): void {
    for (const socket of this._clients.splice(0)) socket.disconnect();
  }
}
