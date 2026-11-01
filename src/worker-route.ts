// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsPeer } from '@rljson/bs';
import { Io, IoPeer } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { ChannelSocket, MessageChannelLike } from './channel-socket.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import {
  PeerReadServer,
  PeerReadServerOptions,
  PeerReadServerStats,
} from './peer-read-server.ts';
import { ConnectPeer } from './peer-reads.ts';
import {
  PeerReadBounds,
  RouteMember,
  RouteMemberContext,
} from './route-member.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

// #############################################################################
/**
 * The events between a {@link WorkerRoute} and its worker.
 */
export const workerRouteEvents = {
  /**
   * The worker asks for the address of a source, `(nodeId, ack)`; the answer
   * is `ip:port` or null.
   */
  resolvePeer: '__worker:resolvePeer',
} as const;

// #############################################################################
/**
 * A running worker, as its launcher hands it over.
 */
export interface WorkerHandle {
  /** The channel to the worker. */
  readonly channel: MessageChannelLike;

  /** Settles when the worker has exited, however. */
  readonly exited: Promise<unknown>;

  /** Ends the worker; resolves once it has exited. */
  stop(): Promise<void>;
}

// #############################################################################
/**
 * What the launcher of a worker gets, to hand on to the worker.
 */
export interface WorkerLaunchContext {
  /** The route's tree key. */
  readonly treeKey: string;

  /** The route. */
  readonly route: Route;

  /** The node's id — the worker's client says hello with it. */
  readonly nodeId: string;

  /** The hub the worker connects to, as `ip:port`. */
  readonly hubAddress: string;

  /** The worker's socket tag on the channel, for {@link serveWorkerRoute}. */
  readonly tag: string;

  /** Bounds of peer reads; undefined while they are off. */
  readonly peerReads?: PeerReadBounds;
}

// #############################################################################
/**
 * Options of {@link WorkerRoute}.
 */
export interface WorkerRouteOptions {
  /** The route's tree key. */
  treeKey: string;

  /**
   * Starts a worker for the route: a child process, typically, that connects
   * to the hub, runs the agent and calls {@link serveWorkerRoute}.
   * @param context - Hub, identity, tag, peer reads.
   */
  launch: (context: WorkerLaunchContext) => Promise<WorkerHandle>;

  /** Wait before a worker that exited on its own is started again. 5000 ms. */
  respawnMs?: number;

  /**
   * Longest a peer's request may wait for the worker. Default 30 000 ms;
   * the reading peer's own bound is shorter anyway.
   */
  requestTimeoutMs?: number;

  /** Bounds of serving peers in this process. */
  serve?: Omit<PeerReadServerOptions, 'logger'>;
}

// #############################################################################
/**
 * A route member in a worker — a separate process with its own event loop, so
 * a heavy agent cannot stall the node.
 *
 * The worker owns the route's local stores and its connection to the hub.
 * This side starts it, starts it again when it exits on its own, and moves it
 * to a new hub by starting a new one. Peers are served through it: their
 * reads cross the worker's channel to the stores the worker owns, never to a
 * second opening of them.
 */
export class WorkerRoute implements RouteMember {
  private _context?: RouteMemberContext;
  private _handle?: WorkerHandle;
  private _socket?: ChannelSocket;
  private _peerServer?: PeerReadServer;
  private _respawnTimer?: ReturnType<typeof setTimeout>;
  private _launches = 0;
  private _queue: Promise<void> = Promise.resolve();

  /**
   * Counts every start and stop. A launch, a respawn or a pending timer that
   * belongs to an older generation is void: what it brings up is stopped. A
   * stop is a generation of its own, so it voids everything before it.
   */
  private _generation = 0;

  // ...........................................................................
  /**
   * Creates the member.
   * @param _options - Route and launcher.
   */
  constructor(private readonly _options: WorkerRouteOptions) {}

  // ...........................................................................
  /** The route's tree key. */
  get treeKey(): string {
    return this._options.treeKey;
  }

  // ...........................................................................
  /** How often a worker was launched. */
  get launches(): number {
    return this._launches;
  }

  // ...........................................................................
  /** Whether a worker runs right now. */
  get isRunning(): boolean {
    return this._handle !== undefined;
  }

  // ...........................................................................
  /** The server answering peers while a worker runs. */
  get peerServer(): PeerReadServer | undefined {
    return this._peerServer;
  }

  // ...........................................................................
  /**
   * Launches the worker for a hub. A running one is stopped first. Calls of
   * `start` and `stop` run one after the other.
   * @param context - Hub, identity and peer reads.
   */
  start(context: RouteMemberContext): Promise<void> {
    return this._serialize(async () => {
      await this._stop();
      const generation = ++this._generation;
      this._context = context;
      await this._launch(generation);
    });
  }

  // ...........................................................................
  /**
   * Ends the worker and waits until it has exited. A launch or respawn still
   * under way is void from now on.
   */
  stop(): Promise<void> {
    this._generation++;
    return this._serialize(() => this._stop());
  }

  // ...........................................................................
  /**
   * Answers a peer's reads through the worker. Refused — disconnected —
   * while no worker runs.
   * @param socket - The peer's connection.
   */
  async servePeer(socket: SocketLike): Promise<void> {
    if (!this._peerServer) {
      for (const s of new Set(Object.values(normalizeSocketBundle(socket)))) {
        s.disconnect();
      }
      return;
    }
    await this._peerServer.addSocket(socket);
  }

  // ...........................................................................
  /** Ends the worker. */
  async close(): Promise<void> {
    await this.stop();
  }

  // ######################
  // Private
  // ######################

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
  /** Stops the current worker, if any, and any pending respawn. */
  private async _stop(): Promise<void> {
    clearTimeout(this._respawnTimer);
    this._respawnTimer = undefined;
    const handle = this._handle;
    this._release();
    await handle?.stop();
  }

  // ...........................................................................
  /**
   * Starts a worker and wires its channel — unless the generation changed
   * meanwhile: then the worker it brought up is stopped again.
   * @param generation - The generation this launch belongs to.
   */
  private async _launch(generation: number): Promise<void> {
    const context = this._context as RouteMemberContext;
    const tag = `route:${this.treeKey}`;
    const current = () => generation === this._generation;
    this._launches++;
    const handle = await this._options.launch({
      treeKey: context.treeKey,
      route: context.route,
      nodeId: context.nodeId,
      hubAddress: context.hubAddress,
      tag,
      ...(context.peerReads ? { peerReads: context.peerReads.bounds } : {}),
    });

    if (!current()) {
      await handle.stop();
      return;
    }

    const socket = new ChannelSocket(handle.channel, tag);
    socket.connect();
    socket.on(
      workerRouteEvents.resolvePeer,
      (nodeId: string, ack: (address: string | null) => void) => {
        ack(context.peerReads?.resolve(nodeId) ?? null);
      },
    );
    const timeout = this._options.requestTimeoutMs ?? 30_000;
    const io = new IoPeer(socket, timeout);
    const bs = new BsPeer(socket, { requestTimeoutMs: timeout });
    await io.init();
    await bs.init();

    if (!current()) {
      socket.disconnect();
      await handle.stop();
      return;
    }

    this._handle = handle;
    this._socket = socket;
    this._peerServer = new PeerReadServer(io, bs, {
      ...this._options.serve,
      logger: context.logger,
    });

    void handle.exited.then(() => this._onExit(handle));
  }

  // ...........................................................................
  /**
   * A worker exited: release it, and start a new one later unless stopped.
   * @param handle - The worker that exited.
   */
  private _onExit(handle: WorkerHandle): void {
    if (this._handle !== handle) return;
    const context = this._context as RouteMemberContext;
    this._release();
    context.logger.warn('WorkerRoute', 'Worker exited', {
      treeKey: this.treeKey,
      respawnInMs: this._options.respawnMs ?? 5000,
    });
    this._scheduleRespawn(this._generation);
  }

  // ...........................................................................
  /**
   * Starts a worker again after `respawnMs`, while the generation lasts.
   * @param generation - The generation the respawn belongs to.
   */
  private _scheduleRespawn(generation: number): void {
    if (generation !== this._generation) return;
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = undefined;
      // Every operation that changes the generation clears this timer first,
      // in the same queue: when it fires, its generation is still current.
      void this._serialize(async () => {
        try {
          await this._launch(generation);
        } catch (error) {
          (this._context as RouteMemberContext).logger.error(
            'WorkerRoute',
            'Worker could not be started',
            error,
            { treeKey: this.treeKey },
          );
          this._scheduleRespawn(generation);
        }
      });
    }, this._options.respawnMs ?? 5000);
  }

  // ...........................................................................
  /** Forgets the current worker and disconnects its peers. */
  private _release(): void {
    this._handle = undefined;
    this._socket?.disconnect();
    this._socket = undefined;
    void this._peerServer?.close();
    this._peerServer = undefined;
  }
}

// #############################################################################
/**
 * Options of {@link serveWorkerRoute}.
 */
export interface ServeWorkerRouteOptions {
  /** The channel to the parent — `process` in a child process. */
  channel: MessageChannelLike;

  /** The tag the parent gave the worker ({@link WorkerLaunchContext.tag}). */
  tag: string;

  /** The worker's local rows. */
  io: Io;

  /** The worker's local blobs; omit on a route that carries none. */
  bs?: Bs;

  /** Bounds of serving peers. */
  serve?: Omit<PeerReadServerOptions, 'logger'>;

  /** Longest a peer address lookup waits for the parent. 3000 ms. */
  resolveTimeoutMs?: number;

  /** Logger. */
  logger?: ServerLogger;
}

// #############################################################################
/**
 * What a worker gets from {@link serveWorkerRoute}.
 */
export interface WorkerRouteServing {
  /**
   * Asks the parent for the address of a source.
   * @param nodeId - The source.
   * @returns `ip:port`, or undefined when the parent knows none in time.
   */
  resolvePeer(nodeId: string): Promise<string | undefined>;

  /**
   * A connect function for the worker's peer reads: resolves the source
   * through the parent, then dials it.
   * @param dial - Opens a connection to an address for this route.
   * @returns The connect function.
   */
  connectPeer(
    dial: (address: string, signal: AbortSignal) => Promise<SocketLike>,
  ): ConnectPeer;

  /** What the worker served to peers so far. */
  readonly stats: PeerReadServerStats;

  /** Stops serving. */
  close(): Promise<void>;
}

// .............................................................................
/**
 * In a worker: serves the route's local stores to the parent — which hands
 * them on to peers — and looks up peers through the parent.
 * @param options - Channel, tag and the local stores.
 * @returns Peer lookups and the end of serving.
 */
export const serveWorkerRoute = async (
  options: ServeWorkerRouteOptions,
): Promise<WorkerRouteServing> => {
  const logger = options.logger ?? noopLogger;
  const socket = new ChannelSocket(options.channel, options.tag);
  socket.connect();
  const server = new PeerReadServer(options.io, options.bs, {
    ...options.serve,
    logger,
  });
  await server.addSocket(socket);
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 3000;

  const resolvePeer = (nodeId: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), resolveTimeoutMs);
      const sent = socket.emit(
        workerRouteEvents.resolvePeer,
        nodeId,
        (address: string | null) => {
          clearTimeout(timer);
          resolve(address ?? undefined);
        },
      );
      if (!sent) {
        clearTimeout(timer);
        resolve(undefined);
      }
    });

  return {
    resolvePeer,
    get stats() {
      return server.stats;
    },
    connectPeer: (dial) => async (nodeId, signal) => {
      const address = await resolvePeer(nodeId);
      return address === undefined ? undefined : dial(address, signal);
    },
    close: async () => {
      await server.close();
      socket.disconnect();
    },
  };
};
