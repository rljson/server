// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Io, IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { Client, ClientOptions } from './client.ts';
import { lateLogger, noopLogger, ServerLogger } from './logger.ts';
import {
  PeerReadServer,
  PeerReadServerOptions,
} from './peer-read-server.ts';
import { ConnectPeer, PeerReadsOptions } from './peer-reads.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

// #############################################################################
/**
 * The bounds of peer reads, without who reads and how peers are reached.
 */
export type PeerReadBounds = Omit<
  PeerReadsOptions,
  'nodeId' | 'connect' | 'logger' | 'route'
>;

// #############################################################################
/**
 * Peer reads as a route member gets them from its node.
 */
export interface RoutePeerReads {
  /** Bounds of the reads. */
  readonly bounds: PeerReadBounds;

  /**
   * The address of a source to read from, or undefined: unknown,
   * unreachable, this node, or the hub — which is asked anyway.
   * @param nodeId - The source.
   */
  resolve(nodeId: string): string | undefined;

  /** Opens a connection to a source, for a member running in this process. */
  readonly connect: ConnectPeer;
}

// #############################################################################
/**
 * What a route member gets from its node when it starts.
 */
export interface RouteMemberContext {
  /** The route's tree key. */
  readonly treeKey: string;

  /** The route. */
  readonly route: Route;

  /** The node's id. */
  readonly nodeId: string;

  /** The hub to connect to, as `ip:port`. */
  readonly hubAddress: string;

  /**
   * Opens a connection to the hub for this route.
   * @param signal - Aborts when the member is stopped meanwhile.
   */
  connectHub(signal: AbortSignal): Promise<SocketLike>;

  /** Present while peer reads are on. */
  readonly peerReads?: RoutePeerReads;

  /** The node's logger. */
  readonly logger: ServerLogger;
}

// #############################################################################
/**
 * One route a node takes part in: a client of the elected hub, with local
 * stores it serves to peers.
 *
 * The node starts it with the hub's address, stops it before the hub moves,
 * and starts it again with the new one. Its local stores outlive those moves.
 */
export interface RouteMember {
  /** The route's tree key. */
  readonly treeKey: string;

  /**
   * Connects to the hub and starts syncing.
   * @param context - Hub, identity and peer reads.
   */
  start(context: RouteMemberContext): Promise<void>;

  /** Disconnects from the hub and stops syncing. Keeps the local stores. */
  stop(): Promise<void>;

  /**
   * Answers a peer's reads from the local stores, in every state.
   * @param socket - The peer's connection.
   */
  servePeer(socket: SocketLike): Promise<void>;

  /** Stops, ends serving peers and releases the local stores. */
  close(): Promise<void>;
}

// #############################################################################
/**
 * A running agent of a route — what syncs the route's data: a file sync, a
 * database sync.
 */
export interface AgentHandle {
  /** Stops the agent. */
  stop: () => Promise<void> | void;
}

// #############################################################################
/**
 * The local stores of a route.
 */
export interface LocalStores {
  /** Rows. */
  io: Io;

  /** Blobs; omit on a route that carries none. */
  bs?: Bs;

  /** Releases the stores when the member closes. */
  close?: () => Promise<void>;
}

// #############################################################################
/**
 * What a {@link ClientRoute}'s agent gets to work with.
 */
export interface ClientRouteAgentContext {
  /** The client: local stores in front of the hub (and peers). */
  readonly client: Client;

  /** The connection to the hub, for the agent's connector. */
  readonly socket: SocketLike;

  /** The route. */
  readonly route: Route;

  /** The route's tree key. */
  readonly treeKey: string;

  /** The node's id. */
  readonly nodeId: string;

  /** The hub's address. */
  readonly hubAddress: string;

  /** The node's logger. */
  readonly logger: ServerLogger;
}

// #############################################################################
/**
 * Options of {@link ClientRoute}.
 */
export interface ClientRouteOptions {
  /** The route's tree key. */
  treeKey: string;

  /** Opens the local stores — once; they outlive every hub change. */
  openStores: () => Promise<LocalStores>;

  /**
   * Starts the route's agent on a connected client. Without one, the client
   * alone takes part in the route.
   * @param context - Client, socket and route.
   */
  createAgent?: (context: ClientRouteAgentContext) => Promise<AgentHandle>;

  /** Further options of the client. */
  clientOptions?: Omit<ClientOptions, 'peerReads' | 'logger' | 'ownsStores'>;

  /** Bounds of serving peers. */
  serve?: Omit<PeerReadServerOptions, 'logger'>;
}

// #############################################################################
/**
 * A route member in this process: a {@link Client} over the local stores, an
 * agent on it, and a {@link PeerReadServer} over the same stores.
 *
 * The client is built without a route: the agent owns the route's connector.
 * Peer reads still know the route, so the client hears the sources of refs.
 */
export class ClientRoute implements RouteMember {
  private _stores?: Promise<LocalStores>;
  private _client?: Client;
  private _socket?: SocketLike;
  private _agent?: AgentHandle;
  private _peerServer?: PeerReadServer;
  private _connecting?: AbortController;
  private _logger: ServerLogger = noopLogger;
  private _queue: Promise<void> = Promise.resolve();

  // ...........................................................................
  /**
   * Creates the member.
   * @param _options - Route, stores, agent.
   */
  constructor(private readonly _options: ClientRouteOptions) {}

  // ...........................................................................
  /**
   * A member over in-memory stores, without an agent, for tests and docs.
   * @param options - Overrides.
   * @returns The member.
   */
  static example(options: Partial<ClientRouteOptions> = {}): ClientRoute {
    return new ClientRoute({
      treeKey: 'exampleTree',
      openStores: async () => {
        const io = new IoMem();
        await io.init();
        await io.isReady();
        return { io, bs: new BsMem() };
      },
      ...options,
    });
  }

  // ...........................................................................
  /** The route's tree key. */
  get treeKey(): string {
    return this._options.treeKey;
  }

  // ...........................................................................
  /** The client while started. */
  get client(): Client | undefined {
    return this._client;
  }

  // ...........................................................................
  /** The agent while started. */
  get agent(): AgentHandle | undefined {
    return this._agent;
  }

  // ...........................................................................
  /** The server answering peers, once a peer connected. */
  get peerServer(): PeerReadServer | undefined {
    return this._peerServer;
  }

  // ...........................................................................
  /**
   * Connects to the hub and starts the agent. A member already started is
   * stopped first. When a step fails, what was built is torn down again.
   * Calls of `start` and `stop` run one after the other.
   * @param context - Hub, identity and peer reads.
   */
  start(context: RouteMemberContext): Promise<void> {
    return this._serialize(() => this._start(context));
  }

  // ...........................................................................
  /**
   * Stops the agent and disconnects from the hub. The stores stay. A start
   * still connecting is aborted at once.
   */
  stop(): Promise<void> {
    this._connecting?.abort();
    return this._serialize(() => this._stop());
  }

  // ...........................................................................
  /**
   * Answers a peer's reads from the local stores.
   * @param socket - The peer's connection.
   */
  async servePeer(socket: SocketLike): Promise<void> {
    const { io, bs } = await this._localStores();
    this._peerServer ??= new PeerReadServer(io, bs, {
      ...this._options.serve,
      // The node's logger arrives with the first start, maybe after the first
      // peer: look it up on every call.
      logger: lateLogger(() => this._logger),
    });
    await this._peerServer.addSocket(socket);
  }

  // ...........................................................................
  /** Stops, disconnects every peer and releases the local stores. */
  async close(): Promise<void> {
    await this.stop();
    await this._peerServer?.close();
    this._peerServer = undefined;
    const stores = this._stores;
    this._stores = undefined;
    if (stores) await (await stores).close?.();
  }

  // ...........................................................................
  /**
   * Runs one operation after the ones before it, whatever they ended with.
   * @param operation - The operation.
   * @returns Its result.
   */
  private _serialize(operation: () => Promise<void>): Promise<void> {
    const next = this._queue.then(operation, operation);
    this._queue = next.catch(() => undefined);
    return next;
  }

  // ...........................................................................
  /**
   * See {@link start}.
   * @param context - Hub, identity and peer reads.
   */
  private async _start(context: RouteMemberContext): Promise<void> {
    await this._stop();
    this._logger = context.logger;
    const { io, bs } = await this._localStores();

    const connecting = new AbortController();
    this._connecting = connecting;
    try {
      this._socket = await context.connectHub(connecting.signal);
      if (connecting.signal.aborted) {
        throw new Error(`Stopped while connecting route ${this.treeKey}`);
      }
      const peerReads = context.peerReads;
      this._client = new Client(this._socket, io, bs, undefined, {
        ...this._options.clientOptions,
        logger: context.logger,
        ownsStores: false,
        nodeId: context.nodeId,
        ...(peerReads
          ? {
              peerReads: {
                ...peerReads.bounds,
                nodeId: context.nodeId,
                route: context.route,
                connect: peerReads.connect,
              },
            }
          : {}),
      });
      await this._client.init();
      if (this._options.createAgent) {
        this._agent = await this._options.createAgent({
          client: this._client,
          socket: this._socket,
          route: context.route,
          treeKey: context.treeKey,
          nodeId: context.nodeId,
          hubAddress: context.hubAddress,
          logger: context.logger,
        });
      }
    } catch (error) {
      await this._stop();
      throw error;
    } finally {
      // Starts run one after the other: no other start replaced it.
      this._connecting = undefined;
    }
  }

  // ...........................................................................
  /** See {@link stop}. */
  private async _stop(): Promise<void> {
    const agent = this._agent;
    this._agent = undefined;
    try {
      await agent?.stop();
    } catch (error) {
      this._logger.error('ClientRoute', 'Agent stop failed', error, {
        treeKey: this.treeKey,
      });
    }

    const client = this._client;
    this._client = undefined;
    await client?.tearDown();

    const socket = this._socket;
    this._socket = undefined;
    if (socket) {
      for (const s of new Set(Object.values(normalizeSocketBundle(socket)))) {
        s.disconnect();
      }
    }
  }

  // ...........................................................................
  /**
   * The local stores, opened on first use.
   * @returns The stores.
   */
  private _localStores(): Promise<LocalStores> {
    if (!this._stores) {
      const opening = this._options.openStores();
      this._stores = opening;
      // Stores that could not be opened are tried again next time.
      opening.catch(() => {
        if (this._stores === opening) this._stores = undefined;
      });
    }
    return this._stores;
  }
}
