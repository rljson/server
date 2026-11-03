// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Io, IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { noopLogger, ServerLogger } from './logger.ts';
import { Server, ServerOptions } from './server.ts';
import { normalizeSocketBundle, SocketLike } from './socket-bundle.ts';

// #############################################################################
/**
 * The stores of one route's hub server.
 */
export interface HubRouteStores {
  /** Rows the hub relays and caches. */
  io: Io;

  /** Blobs; omit on a route that carries none. */
  bs?: Bs;
}

// #############################################################################
/**
 * Options of {@link HubRoutes}.
 */
export interface HubRoutesOptions {
  /** Routes whose servers exist from the start, by tree key. */
  treeKeys?: string[];

  /**
   * Creates the stores of one route's server, ready to use — tables a route
   * needs from the start included. Called once per route.
   * @param treeKey - The route's tree key.
   */
  createStores: (treeKey: string) => Promise<HubRouteStores>;

  /**
   * Server options of one route. The logger defaults to the one of these
   * options.
   * @param treeKey - The route's tree key.
   */
  serverOptions?: (treeKey: string) => ServerOptions;

  /** Logger for route creation and socket routing. */
  logger?: ServerLogger;
}

// #############################################################################
/**
 * A hub for many routes: one {@link Server} per route, each with its own
 * stores, and every connection routed to the route it names.
 *
 * A connection names its route by its tree key. A route nobody configured is
 * created on its first connection, once, however many connect at the same
 * time. A connection that names no route, or several, is a legacy client: it
 * is added to every route that exists at that moment.
 *
 * One route, one server — never one socket in two servers: two servers would
 * both answer that socket's reads, and their cascades would pull in clients
 * of unrelated routes.
 */
export class HubRoutes {
  private readonly _servers = new Map<string, Server>();
  private readonly _creating = new Map<string, Promise<Server>>();
  private readonly _logger: ServerLogger;
  private _legacySockets = 0;
  private _tornDown = false;

  // ...........................................................................
  /**
   * Creates the hub. Call {@link init} before routing connections.
   * @param _options - Routes, stores and server options.
   */
  constructor(private readonly _options: HubRoutesOptions) {
    this._logger = _options.logger ?? noopLogger;
  }

  // ...........................................................................
  /**
   * A hub over in-memory stores, for tests and docs.
   * @param options - Overrides.
   * @returns The hub, not yet initialized.
   */
  static example(options: Partial<HubRoutesOptions> = {}): HubRoutes {
    return new HubRoutes({
      createStores: async () => {
        const io = new IoMem();
        await io.init();
        await io.isReady();
        return { io, bs: new BsMem() };
      },
      ...options,
    });
  }

  // ...........................................................................
  /** Creates the servers of the configured routes, one after the other. */
  async init(): Promise<void> {
    for (const treeKey of new Set(this._options.treeKeys ?? [])) {
      await this.ensure(treeKey);
    }
  }

  // ...........................................................................
  /** The server of every route, by tree key. */
  get servers(): ReadonlyMap<string, Server> {
    return this._servers;
  }

  // ...........................................................................
  /**
   * The server of one route.
   * @param treeKey - The route's tree key.
   * @returns The server, or undefined while the route does not exist.
   */
  server(treeKey: string): Server | undefined {
    return this._servers.get(treeKey);
  }

  // ...........................................................................
  /** Connections added to every route because they named none, or several. */
  get legacySockets(): number {
    return this._legacySockets;
  }

  // ...........................................................................
  /**
   * The nodes connected to any route, as their clients named them in their
   * hello, without duplicates.
   */
  get connectedNodes(): string[] {
    const nodes = new Set<string>();
    for (const server of this._servers.values()) {
      for (const nodeId of server.connectedNodes) nodes.add(nodeId);
    }
    return [...nodes];
  }

  // ...........................................................................
  /** Whether {@link tearDown} was called. */
  get isTornDown(): boolean {
    return this._tornDown;
  }

  // ...........................................................................
  /**
   * The server of a route, created the first time it is asked for — once,
   * even when several callers ask at the same time.
   * @param treeKey - The route's tree key.
   * @returns The route's server.
   */
  ensure(treeKey: string): Promise<Server> {
    if (this._tornDown) {
      return Promise.reject(new Error('HubRoutes is torn down'));
    }
    const existing = this._servers.get(treeKey);
    if (existing) return Promise.resolve(existing);
    let creating = this._creating.get(treeKey);
    if (!creating) {
      creating = this._create(treeKey).finally(() =>
        this._creating.delete(treeKey),
      );
      this._creating.set(treeKey, creating);
    }
    return creating;
  }

  // ...........................................................................
  /**
   * Routes a connection to the route it names. A legacy connection joins
   * every route there is; when one of them fails, it still joins the others,
   * and the first failure is thrown.
   * @param socket - The connection.
   * @param treeKeys - The routes it named in its handshake.
   */
  async addSocket(
    socket: SocketLike,
    treeKeys: readonly string[] | undefined,
  ): Promise<void> {
    if (treeKeys?.length === 1) {
      const server = await this.ensure(treeKeys[0]);
      await server.addSocket(socket);
      return;
    }

    // A legacy client: every route it could mean.
    this._legacySockets++;
    normalizeSocketBundle(socket).ioUp.on('disconnect', () => {
      this._legacySockets--;
    });
    this._logger.warn('HubRoutes', 'Connection names no single route', {
      treeKeys: treeKeys ?? [],
      routes: [...this._servers.keys()],
    });
    // Every route, even when one of them fails: the others still serve it.
    const added = await Promise.allSettled(
      [...this._servers.values()].map((server) => server.addSocket(socket)),
    );
    const failed = added.find((result) => result.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  // ...........................................................................
  /** Tears down every route's server. */
  async tearDown(): Promise<void> {
    this._tornDown = true;
    await Promise.allSettled([...this._creating.values()]);
    const servers = [...this._servers.values()];
    this._servers.clear();
    await Promise.all(servers.map((server) => server.tearDown()));
  }

  // ######################
  // Private
  // ######################

  /**
   * Builds and initializes a route's server.
   * @param treeKey - The route's tree key.
   * @returns The server.
   */
  private async _create(treeKey: string): Promise<Server> {
    const { io, bs } = await this._options.createStores(treeKey);
    const options = this._options.serverOptions?.(treeKey) ?? {};
    const server = new Server(Route.fromFlat(`/${treeKey}`), io, bs, {
      logger: this._logger,
      ...options,
    });
    await server.init();
    if (this._tornDown) {
      await server.tearDown();
      throw new Error('HubRoutes is torn down');
    }
    this._servers.set(treeKey, server);
    this._logger.info('HubRoutes', 'Route created', {
      treeKey,
      blobs: bs !== undefined,
    });
    return server;
  }
}
