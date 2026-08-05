// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem, BsMulti, BsMultiBs, BsPeer, BsServer } from '@rljson/bs';
import {
  Io,
  IoMem,
  IoMulti,
  IoMultiIo,
  IoPeer,
  IoServer,
  Socket,
  SocketMock,
} from '@rljson/io';
import {
  AckPayload,
  ConnectorPayload,
  GapFillRequest,
  GapFillResponse,
  Route,
  SyncConfig,
  SyncEventNames,
  syncEvents,
} from '@rljson/rljson';

import { BaseNode } from './base-node.ts';
import { noopLogger, ServerLogger } from './logger.ts';
import {
  normalizeSocketBundle,
  SocketLike,
  SocketNamespaceBundle,
} from './socket-bundle.ts';

export type SocketWithClientId = Socket & { __clientId?: string };

/**
 * Options for the Server constructor.
 */
export interface ServerOptions {
  /** Logger instance for monitoring (defaults to NoopLogger). */
  logger?: ServerLogger;

  /**
   * Interval in milliseconds for evicting stale multicast ref entries.
   * Uses a two-generation sweep: refs older than two intervals are discarded.
   * Defaults to 60 000 (60 s). Set to 0 to disable automatic eviction.
   */
  refEvictionIntervalMs?: number;

  /**
   * Timeout in milliseconds for peer initialization during addSocket().
   * If a peer does not respond within this window, addSocket() rejects.
   * Defaults to 30 000 (30 s). Set to 0 to disable the timeout.
   */
  peerInitTimeoutMs?: number;

  /**
   * Sync protocol configuration. When provided, the server activates
   * ACK aggregation, gap-fill response, and enriched payload forwarding.
   */
  syncConfig?: SyncConfig;

  /**
   * Maximum number of recent payloads to retain in the ref log
   * for gap-fill responses. Defaults to 1000.
   */
  refLogSize?: number;

  /**
   * Timeout in milliseconds for collecting individual client ACKs
   * before emitting the aggregated AckPayload back to the sender.
   * Defaults to the SyncConfig's ackTimeoutMs (or 10 000 ms).
   */
  ackTimeoutMs?: number;

  /**
   * When true, the server's IoMulti and BsMulti will NOT include a local
   * in-memory cache (IoMem / BsMem). The server will only read data from
   * connected client peers. Useful when the server should act as a pure
   * relay without caching any data locally.
   * Defaults to false (local cache enabled).
   */
  disableLocalCache?: boolean;

  /**
   * Interval in milliseconds for application-level health checks.
   * The server pings each connected client and prunes those that
   * do not respond within {@link healthCheckTimeoutMs}.
   * Defaults to 30 000 (30 s). Set to 0 to disable health checks.
   */
  healthCheckIntervalMs?: number;

  /**
   * Timeout in milliseconds to wait for a health check pong.
   * Clients that do not respond within this window are pruned.
   * Defaults to 10 000 (10 s).
   */
  healthCheckTimeoutMs?: number;

  /**
   * Optional hook invoked (awaited) for every new ref received by the server,
   * BEFORE the ref is multicast to other clients.
   *
   * Intended for archival use cases (e.g. EventHub writing the ref to a
   * persistent log) where archival must complete before fan-out.
   *
   * The `tenantId` field is the value pinned on `socket.data.tenantId` by an
   * external auth middleware on the sender's socket, or `undefined` if none
   * was set. The `sourceNodeId` is the server-internal client id for the
   * sender socket.
   *
   * Errors thrown by the hook are logged and DROP the ref (it is neither
   * archived nor multicast). This is intentional: archival failure must not
   * silently lose data downstream.
   */
  onRefArrived?: (ctx: {
    tenantId?: string;
    route: string;
    ref: string;
    sourceNodeId: string;
  }) => Promise<void> | void;
}

// .............................................................................
export class Server extends BaseNode {
  // Map of connected clients
  // socket => Push: Send new Refs through Route
  // io => Pull: Read from Clients Io
  private _clients: Map<
    string,
    {
      ioUp: SocketWithClientId;
      ioDown: SocketWithClientId;
      bsUp: SocketWithClientId;
      bsDown: SocketWithClientId;
      io: IoPeer;
      bs: BsPeer;
    }
  > = new Map();

  private _ios: IoMultiIo[] = [];
  private _ioMulti: IoMulti;

  // Storage => Let Clients read from Servers Io
  private _ioServer: IoServer;

  private _bss: BsMultiBs[] = [];
  private _bsMulti: BsMulti;

  // Storage => Let Clients read from Servers Bs
  private _bsServer: BsServer;

  // Two-generation ref dedup: refs in current or previous are considered seen.
  // On each eviction tick, previous is discarded and current becomes previous.
  private _multicastedRefsCurrent: Set<string> = new Set();
  private _multicastedRefsPrevious: Set<string> = new Set();
  private _refEvictionTimer?: ReturnType<typeof setInterval>;

  private _refreshPromise?: Promise<void>;
  private _pendingSockets: Array<{
    ioDown: SocketWithClientId;
    bsDown: SocketWithClientId;
  }> = [];

  private _logger: ServerLogger;
  private _peerInitTimeoutMs: number;

  // Cleanup callbacks for socket disconnect listeners (clientId → cleanup fn)
  private _disconnectCleanups: Map<string, () => void> = new Map();

  // Sync protocol state
  private _syncConfig: SyncConfig | undefined;
  private _events: SyncEventNames;
  private _refLog: ConnectorPayload[] = [];
  private _refLogSize: number;
  private _ackTimeoutMs: number;

  // Local cache toggle
  private _disableLocalCache: boolean;

  // Archival hook (EventHub etc.)
  private _onRefArrived?: ServerOptions['onRefArrived'];

  // Bootstrap state
  private _latestRef: string | undefined;
  private _bootstrapHeartbeatTimer?: ReturnType<typeof setInterval>;

  // Health check state
  private _healthCheckIntervalMs: number;
  private _healthCheckTimeoutMs: number;
  private _healthCheckTimer?: ReturnType<typeof setInterval>;

  private _tornDown = false;

  constructor(
    private _route: Route,
    protected _localIo: Io,
    protected _localBs: Bs,
    options?: ServerOptions,
  ) {
    //Call BaseNode constructor
    super(_localIo);

    this._logger = options?.logger ?? noopLogger;
    this._peerInitTimeoutMs = options?.peerInitTimeoutMs ?? 30_000;
    this._disableLocalCache = options?.disableLocalCache ?? false;
    this._healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 30_000;
    this._healthCheckTimeoutMs = options?.healthCheckTimeoutMs ?? 10_000;
    this._onRefArrived = options?.onRefArrived;

    // Sync protocol initialization
    this._syncConfig = options?.syncConfig;
    this._refLogSize = options?.refLogSize ?? 1000;
    this._ackTimeoutMs =
      options?.ackTimeoutMs ?? options?.syncConfig?.ackTimeoutMs ?? 10_000;
    // Always create event names — bootstrap needs them even without full syncConfig
    this._events = syncEvents(this._route.flat);

    this._logger.info('Server', 'Constructing server', {
      route: this._route.flat,
    });

    // Start two-generation ref eviction
    const evictionMs = options?.refEvictionIntervalMs ?? 60_000;
    /* v8 ignore if -- @preserve */
    if (evictionMs > 0) {
      this._refEvictionTimer = setInterval(() => {
        this._multicastedRefsPrevious = this._multicastedRefsCurrent;
        this._multicastedRefsCurrent = new Set();
      }, evictionMs);
      // Don't let the timer keep the process alive
      this._refEvictionTimer.unref();
    }

    // Only add local Io/Bs to the multi when local cache is enabled
    if (!this._disableLocalCache) {
      const ioMultiIoLocal = {
        io: this._localIo,
        dump: true,
        read: true,
        write: true,
        priority: 1,
      };
      this._ios.push(ioMultiIoLocal);
    }
    this._ioMulti = new IoMulti(this._ios);

    // Initialize IoServer
    this._ioServer = new IoServer(this._ioMulti);

    if (!this._disableLocalCache) {
      const bsMultiBsLocal = {
        bs: this._localBs,
        read: true,
        write: true,
        priority: 1,
      };
      this._bss.push(bsMultiBsLocal);
    }
    this._bsMulti = new BsMulti(this._bss);

    // Initialize BsServer
    this._bsServer = new BsServer(this._bsMulti);
  }

  /**
   * Initializes Io and Bs multis on the server.
   */
  async init() {
    this._logger.info('Server', 'Initializing server');

    try {
      // Initialize IoServer
      await this._ioMulti.init();
      await this._ioMulti.isReady();

      // Initialize BsServer
      await this._bsMulti.init();

      await this.ready();

      this._logger.info('Server', 'Server initialized successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to initialize server', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Resolves once the Io implementation is ready.
   */
  async ready() {
    /* v8 ignore next -- @preserve */ await this._ioMulti.isReady();
  }

  /**
   * Adds a client socket, rebuilds multis, and refreshes servers.
   * @param socket - Client socket to register.
   * @returns The server instance.
   */
  async addSocket(socket: SocketLike) {
    const sockets = normalizeSocketBundle(socket);
    // attach a stable id to each socket
    const clientId = `client_${this._clients.size}_${Math.random()
      .toString(36)
      .slice(2)}`;

    this._logger.info('Server', 'Adding client socket', { clientId });

    // add clientId to socket (shorthand)
    const ioUp = sockets.ioUp as SocketWithClientId;
    const ioDown = sockets.ioDown as SocketWithClientId;
    const bsUp = sockets.bsUp as SocketWithClientId;
    const bsDown = sockets.bsDown as SocketWithClientId;

    (ioUp as any).__clientId = clientId;
    (ioDown as any).__clientId = clientId;
    (bsUp as any).__clientId = clientId;
    (bsDown as any).__clientId = clientId;

    // F1: Register a disconnect watcher on ioUp BEFORE any of the awaits
    // below (peer creation, _queueRefresh). Socket.io — and every Socket
    // implementation used here — does not replay a 'disconnect' event
    // that fires while we are suspended on one of those awaits, so a
    // handler registered only once setup finishes (as this used to do,
    // via _registerDisconnectHandler near the very end) can miss it
    // entirely. When that happens the client's IoPeer/BsPeer still get
    // queued into _ios/_bss below, with nothing left watching the socket
    // to ever remove them — a permanently stranded dead peer.
    //
    // `clientId` is not in `_clients` yet at this point, so the real
    // disconnect handler's removeSocket(clientId) call would just no-op
    // if used here directly. Instead, remember that a disconnect
    // happened; the post-setup check further down finishes the cleanup
    // once the client actually exists to remove. Once setup succeeds,
    // this watcher is swapped for the real handler.
    let diedDuringSetup = false;
    const earlyDisconnect = () => {
      diedDuringSetup = true;
    };
    ioUp.on('disconnect', earlyDisconnect);

    try {
      const ioPeer = await this._createIoPeer(socket, clientId);
      const bsPeer = await this._createBsPeer(socket, clientId);

      this._registerClient(
        clientId,
        { ioUp, ioDown, bsUp, bsDown },
        ioPeer,
        bsPeer,
      );
      this._pendingSockets.push({ ioDown, bsDown });
      this._queueIoPeer(ioPeer);
      this._queueBsPeer(bsPeer);
    } catch (error) {
      /* v8 ignore start -- @preserve */
      ioUp.off('disconnect', earlyDisconnect);
      this._logger.error('Server', 'Failed to add client socket', error, {
        clientId,
      });
      throw error;
      /* v8 ignore stop -- @preserve */
    }

    try {
      await this._queueRefresh();
    } catch (refreshError) {
      // F1/F3: _queueRefresh() rejecting must not leave this client
      // half-registered. It is already sitting in _clients/_ios/_bss
      // (registered just above) with no disconnect handler watching it,
      // and its {ioDown, bsDown} pair is still in _pendingSockets even
      // though _refreshServers() never got to drain it. Left alone, the
      // next successful refresh (e.g. triggered by removeSocket's own
      // rebuild below, or a later addSocket) would register CRUD
      // listeners for a socket whose client we are about to tear back
      // down — a duplicate-listener leak on retry. Drop the stale
      // pending entry first, then remove the client the normal way, now
      // that it actually exists to remove.
      this._pendingSockets = this._pendingSockets.filter(
        (pending) => pending.ioDown !== ioDown,
      );
      ioUp.off('disconnect', earlyDisconnect);
      this._logger.error(
        'Server',
        'Queued refresh failed during addSocket — rolling back client',
        refreshError,
        { clientId },
      );
      await this.removeSocket(clientId);

      throw refreshError;
    }

    // Setup succeeded — swap the early watcher for the real disconnect
    // handler now that the client is fully registered.
    ioUp.off('disconnect', earlyDisconnect);
    this._registerDisconnectHandler(clientId, ioUp);

    // remove all existing listeners and re-establish multicast
    this._removeAllListeners();
    this._multicastRefs();

    // Bootstrap: send latest ref to the new client
    this._sendBootstrap(ioDown);

    // Start heartbeat timer if configured and not already running
    this._startBootstrapHeartbeat();

    // Start application-level health checks
    this._startHealthChecks();

    // F1: the socket may already be gone — either the early watcher above
    // caught a 'disconnect' event mid-setup, or (belt-and-suspenders, in
    // case a Socket implementation's event and its `connected` flag can
    // momentarily disagree) it simply is not connected right now even
    // though no event fired. Either way, do not leave a dead client
    // registered for the next health-check cycle to eventually find —
    // clean it up immediately.
    if (diedDuringSetup || ioUp.connected === false) {
      this._logger.warn(
        'Server',
        'Socket disconnected during addSocket setup — removing client',
        { clientId },
      );
      await this.removeSocket(clientId);
    } else {
      this._logger.info('Server', 'Client socket added successfully', {
        clientId,
        totalClients: this._clients.size,
      });
    }

    return this;
  }

  // ...........................................................................
  /**
   * Adds a socket to the multicast ring WITHOUT creating IoPeer/BsPeer.
   * Use this when the hub needs to participate in the multicast (send and
   * receive refs) but the server should NOT try to read data from this socket
   * via IoPeer/BsPeer RPC — because no IoPeerBridge/BsPeerBridge is set up
   * on the other end.
   * Typical use case: hub creates a loopback socket pair so its own
   * Connector can send/receive refs, but the server's IoMulti already has
   * the hub's data in its local cache (IoMem/BsMem at priority 1).
   * @param socket - Socket to register for broadcast only.
   * @returns The server instance.
   */
  async addBroadcastSocket(socket: SocketLike) {
    const sockets = normalizeSocketBundle(socket);
    const clientId = `broadcast_${this._clients.size}_${Math.random()
      .toString(36)
      .slice(2)}`;

    this._logger.info('Server', 'Adding broadcast-only socket', { clientId });

    const ioUp = sockets.ioUp as SocketWithClientId;
    const ioDown = sockets.ioDown as SocketWithClientId;
    const bsUp = sockets.bsUp as SocketWithClientId;
    const bsDown = sockets.bsDown as SocketWithClientId;

    (ioUp as any).__clientId = clientId;
    (ioDown as any).__clientId = clientId;
    (bsUp as any).__clientId = clientId;
    (bsDown as any).__clientId = clientId;

    // Register client entry with null peers — multicast only uses sockets
    this._clients.set(clientId, {
      ioUp,
      ioDown,
      bsUp,
      bsDown,
      io: null as unknown as IoPeer,
      bs: null as unknown as BsPeer,
    });

    // No IoPeer/BsPeer creation — the hub reads from IoMulti directly.
    // No _pendingSockets / _queueRefresh — no IoServer/BsServer registration
    // needed because the hub doesn't send IoPeer RPC on the loopback.

    this._removeAllListeners();
    this._multicastRefs();

    this._registerDisconnectHandler(clientId, ioUp);

    this._sendBootstrap(ioDown);
    this._startBootstrapHeartbeat();
    this._startHealthChecks();

    this._logger.info('Server', 'Broadcast-only socket added', {
      clientId,
      totalClients: this._clients.size,
    });

    return this;
  }

  // ...........................................................................
  /**
   * Removes all listeners from all connected clients.
   */
  private _removeAllListeners() {
    for (const { ioUp } of this._clients.values()) {
      ioUp.removeAllListeners(this._route.flat);
      ioUp.removeAllListeners(this._events.gapFillReq);
      ioUp.removeAllListeners(this._events.ackClient);
    }
  }

  // ...........................................................................
  /**
   * Broadcasts incoming payloads from any client to all other connected clients.
   * Enriched with ref log, ACK aggregation, and gap-fill support when
   * syncConfig is provided.
   */
  private _multicastRefs = () => {
    for (const [clientIdA, { ioUp: socketA }] of this._clients.entries()) {
      socketA.on(this._route.flat, async (payload: ConnectorPayload) => {
        const ref = payload.r;
        const senderTenantId = (socketA as any).data?.tenantId as
          | string
          | undefined;

        this._logger.traffic('in', 'Server.Multicast', this._route.flat, {
          ref,
          from: clientIdA,
          tenantId: senderTenantId,
        });

        // Avoid rebroadcasting the same ref multiple times (two-generation check)
        /* v8 ignore if -- @preserve */
        if (
          this._multicastedRefsCurrent.has(ref) ||
          this._multicastedRefsPrevious.has(ref)
        ) {
          this._logger.warn('Server.Multicast', 'Duplicate ref suppressed', {
            ref,
            from: clientIdA,
          });
          return;
        }
        this._multicastedRefsCurrent.add(ref);

        // Track latest ref for bootstrap
        this._latestRef = ref;

        const p = payload as any;

        // If payload already has an origin, it was forwarded by the wire and should not be re-forwarded.
        /* v8 ignore if -- @preserve */
        if (p && p.__origin) {
          this._logger.warn(
            'Server.Multicast',
            'Loop prevention: payload already has origin',
            { ref, origin: p.__origin, from: clientIdA },
          );
          return;
        }

        // Archival hook — must succeed before fan-out
        if (this._onRefArrived) {
          try {
            await this._onRefArrived({
              tenantId: senderTenantId,
              route: this._route.flat,
              ref,
              sourceNodeId: clientIdA,
            });
          } catch (err) {
            this._logger.error(
              'Server.Multicast',
              'onRefArrived hook failed; dropping ref',
              err,
              { ref, from: clientIdA, tenantId: senderTenantId },
            );
            return;
          }
        }

        // Append to ref log (ring buffer) for gap-fill
        if (this._syncConfig) {
          this._appendToRefLog(payload);
        }

        // Count receivers (all OTHER clients with matching tenant scope)
        let receiverCount = 0;

        // Set up ACK collection BEFORE broadcasting (so synchronous
        // ackClient events from receivers are captured).
        let ackCollector: (() => void) | undefined;
        if (this._syncConfig?.requireAck) {
          ackCollector = this._setupAckCollection(clientIdA, ref);
        }

        // Broadcast to all OTHER clients (filter out the sender).
        // When the sender's socket has a tenantId pinned, restrict delivery
        // to sockets with the SAME tenantId — cross-tenant delivery is
        // impossible by construction. Sockets without a tenantId only
        // receive from senders without a tenantId.
        for (const [
          clientIdB,
          { ioUp: socketUpB, ioDown: socketB },
        ] of this._clients.entries()) {
          if (clientIdA === clientIdB) continue;
          const receiverTenantId = (socketUpB as any).data?.tenantId as
            | string
            | undefined;
          if (receiverTenantId !== senderTenantId) continue;

          // clone and mark the forwarded payload with the origin to prevent loops
          const forwarded = Object.assign({}, payload, {
            __origin: clientIdA,
          });

          this._logger.traffic('out', 'Server.Multicast', this._route.flat, {
            ref,
            from: clientIdA,
            to: clientIdB,
            tenantId: senderTenantId,
          });

          socketB.emit(this._route.flat, forwarded);
          receiverCount++;
        }

        // If no receivers and ACK was set up, trigger immediate finish
        if (ackCollector && receiverCount === 0) {
          ackCollector();
        }
      });

      // Register gap-fill listener for this client
      if (this._syncConfig?.causalOrdering) {
        this._registerGapFillListener(clientIdA, socketA);
      }
    }
  };

  get route() {
    return this._route;
  }

  /**
   * Returns the logger instance.
   */
  get logger(): ServerLogger {
    return this._logger;
  }

  /**
   * Returns the Io implementation.
   */
  get io(): Io {
    /* v8 ignore next -- @preserve */ return this._ioMulti;
  }

  /**
   * Returns the Bs implementation.
   */
  get bs(): Bs {
    /* v8 ignore next -- @preserve */ return this._bsMulti;
  }

  /**
   * Returns the connected clients map.
   */
  get clients() {
    return this._clients;
  }

  /**
   * Number of IoPeer entries currently in the Io read cascade (`_ios`),
   * i.e. `_ios.length` minus the local cache slot (when local caching is
   * enabled). Reflects reality after any pruning, which can legitimately
   * differ from the number of connected clients — that gap is exactly
   * what {@link isLocalCacheDisabled} and the peer-count invariant (see
   * `_checkPeerInvariant`) are there to catch. Exists so tests can assert
   * on cascade membership after connect/disconnect churn without
   * reaching into the private `_ios` array.
   */
  get ioPeerCount(): number {
    return this._ios.length - (this._disableLocalCache ? 0 : 1);
  }

  /**
   * Stable identifiers for every entry currently in the Io read cascade
   * (`_ios`), in cascade order: the local cache first (as `'local'`, when
   * enabled), then one entry per peer, identified by the `clientId` of
   * the client it belongs to. Peer entries are looked up by identity
   * against `_clients` rather than using IoMulti's own positional ids
   * (`io-0`, `io-1`, …), which are reassigned on every rebuild and would
   * not survive being compared across churn. An entry that is neither
   * the local cache nor traceable to a current client is an orphan —
   * exactly what `_pruneDeadPeers` removes on the next rebuild; it
   * surfaces here as `'orphan'` so a test can observe it before that
   * happens.
   */
  get readableIds(): string[] {
    return this._ios.map((entry) => {
      if (entry.io === this._localIo) return 'local';
      for (const [clientId, client] of this._clients.entries()) {
        if (client.io === entry.io) return clientId;
      }
      return 'orphan';
    });
  }

  /**
   * Returns the sync configuration, if any.
   */
  get syncConfig(): SyncConfig | undefined {
    return this._syncConfig;
  }

  /**
   * Returns the typed sync event names.
   */
  get events(): SyncEventNames {
    return this._events;
  }

  /**
   * Returns the configured maximum ref log size.
   */
  get refLogSize(): number {
    return this._refLogSize;
  }

  /**
   * Returns the current ref log contents (for diagnostics / testing).
   */
  get refLog(): readonly ConnectorPayload[] {
    return this._refLog;
  }

  /**
   * Returns whether the local cache is disabled.
   */
  get isLocalCacheDisabled(): boolean {
    return this._disableLocalCache;
  }

  /**
   * Returns the latest ref tracked by the server (for bootstrap / diagnostics).
   */
  get latestRef(): string | undefined {
    return this._latestRef;
  }

  /**
   * Seeds the latest ref from an external source (e.g. a previous role's
   * Connector or Server). This allows bootstrap to work immediately when
   * clients connect, even if no new writes have arrived yet.
   * @param ref - The ref to seed as the latest known state.
   */
  seedLatestRef(ref: string): void {
    // Only seed if no client push has already set _latestRef.
    // During hub transitions a fast client may push before the new hub
    // finishes its own storeInDb + seedLatestRef.  Overwriting with the
    // seed would clobber the client's more-recent tree.
    if (!this._latestRef) {
      this._latestRef = ref;
    }
    // Always mark the seeded ref as already-multicast so that stale
    // client re-sends of the same ref are deduplicated.
    this._multicastedRefsCurrent.add(ref);
    this._logger.info('Server', `Seeded latestRef: ${ref.slice(0, 12)}…`);
  }

  // ...........................................................................
  // Sync protocol private methods
  // ...........................................................................

  /**
   * Appends a payload to the bounded ref log (ring buffer).
   * Drops the oldest entry when the log exceeds `_refLogSize`.
   * @param payload - The ConnectorPayload to append.
   */
  private _appendToRefLog(payload: ConnectorPayload) {
    this._refLog.push(payload);
    if (this._refLog.length > this._refLogSize) {
      this._refLog.shift();
    }
  }

  // ...........................................................................
  // Bootstrap methods
  // ...........................................................................

  /**
   * Sends the latest ref to a specific client socket as a bootstrap message.
   * If no ref has been seen yet, this is a no-op.
   * @param ioDown - The downstream socket to send the bootstrap message on.
   */
  private _sendBootstrap(ioDown: SocketWithClientId) {
    if (!this._latestRef) return;

    const payload: ConnectorPayload = {
      o: '__server__',
      r: this._latestRef,
    };

    this._logger.info('Server.Bootstrap', 'Sending bootstrap ref', {
      ref: this._latestRef,
      to: ioDown.__clientId,
    });

    ioDown.emit(this._events.bootstrap, payload);
  }

  /**
   * Broadcasts the latest ref to all connected clients as a heartbeat.
   * Each client's dedup pipeline will filter out refs it already has.
   */
  private _broadcastBootstrapHeartbeat() {
    /* v8 ignore if -- @preserve */
    if (!this._latestRef) return;

    const payload: ConnectorPayload = {
      o: '__server__',
      r: this._latestRef,
    };

    this._logger.info('Server.Bootstrap', 'Heartbeat broadcast', {
      ref: this._latestRef,
      clientCount: this._clients.size,
    });

    for (const { ioDown } of this._clients.values()) {
      ioDown.emit(this._events.bootstrap, payload);
    }
  }

  // ...........................................................................
  // Health checks
  // ...........................................................................

  /**
   * Starts the periodic health check timer if not already running.
   * Each cycle sends a ping to every non-broadcast client and waits
   * for a pong. Clients that do not respond are pruned.
   */
  private _startHealthChecks() {
    if (this._healthCheckTimer || this._healthCheckIntervalMs <= 0) return;

    this._healthCheckTimer = setInterval(() => {
      this._runHealthCheck();
    }, this._healthCheckIntervalMs);
    this._healthCheckTimer.unref();
  }

  /**
   * Sends a health ping to each connected (non-broadcast) client.
   * If a client does not respond within `_healthCheckTimeoutMs`,
   * the server force-disconnects and removes it.
   */
  private _runHealthCheck() {
    for (const [clientId, { ioUp, ioDown }] of this._clients.entries()) {
      // Skip broadcast (hub loopback) sockets — always local
      if (clientId.startsWith('broadcast_')) continue;

      const nonce = Math.random().toString(36).slice(2);
      let resolved = false;

      const handler = (payload: { nonce: string }) => {
        if (payload?.nonce !== nonce) return;
        resolved = true;
        ioUp.off('__health:pong', handler);
        clearTimeout(timer);
      };

      ioUp.on('__health:pong', handler);

      const timer = setTimeout(() => {
        /* v8 ignore if -- @preserve */
        if (resolved) return;
        ioUp.off('__health:pong', handler);
        this._logger.warn(
          'Server.Health',
          'Client failed health check — pruning',
          { clientId },
        );

        // Force-disconnect so the client's transport reconnects
        /* v8 ignore if -- @preserve */
        if ('disconnect' in ioUp) {
          (
            ioUp as unknown as { disconnect: (close?: boolean) => void }
          ).disconnect(true);
        }

        this.removeSocket(clientId);
      }, this._healthCheckTimeoutMs);

      ioDown.emit('__health:ping', { nonce });
    }
  }

  /**
   * Starts the periodic bootstrap heartbeat timer if configured
   * and not already running.
   */
  private _startBootstrapHeartbeat() {
    const ms = this._syncConfig?.bootstrapHeartbeatMs;
    if (!ms || ms <= 0 || this._bootstrapHeartbeatTimer) return;

    this._bootstrapHeartbeatTimer = setInterval(() => {
      this._broadcastBootstrapHeartbeat();
    }, ms);
    // Don't let the timer keep the process alive
    this._bootstrapHeartbeatTimer.unref();

    this._logger.info('Server.Bootstrap', 'Heartbeat timer started', {
      intervalMs: ms,
    });
  }

  /**
   * Sets up ACK collection listeners before broadcast.
   * Returns a cleanup function that emits an immediate ACK
   * (used when there are no receivers).
   * @param senderClientId - The internal client ID of the sender.
   * @param ref - The ref being acknowledged.
   * @returns A function to call for immediate ACK (zero receivers).
   */
  private _setupAckCollection(senderClientId: string, ref: string): () => void {
    const senderEntry = this._clients.get(senderClientId);
    /* v8 ignore if -- @preserve */
    if (!senderEntry) return () => {};

    const totalClients = this._clients.size - 1; // exclude sender

    let acksReceived = 0;
    let finished = false;
    const ackHandlers: Map<string, (ack: { r: string }) => void> = new Map();

    const finish = (ok: boolean) => {
      /* v8 ignore if -- @preserve */
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      // Remove individual ACK listeners
      for (const [cId, handler] of ackHandlers.entries()) {
        const clientEntry = this._clients.get(cId);
        /* v8 ignore if -- @preserve */
        if (clientEntry) {
          clientEntry.ioUp.off(this._events.ackClient, handler);
        }
      }
      ackHandlers.clear();

      const ack: AckPayload = {
        r: ref,
        ok,
        receivedBy: acksReceived,
        totalClients,
      };
      senderEntry.ioDown.emit(this._events.ack, ack);
    };

    // Timeout fallback
    const timeout = setTimeout(() => {
      finish(false);
    }, this._ackTimeoutMs);

    // Listen for ackClient from each receiver
    for (const [clientId, { ioUp }] of this._clients.entries()) {
      if (clientId === senderClientId) continue;

      const handler = (clientAck: { r: string }) => {
        if (clientAck.r !== ref) return;
        acksReceived++;
        if (acksReceived >= totalClients) {
          finish(true);
        }
      };

      ioUp.on(this._events.ackClient, handler);
      ackHandlers.set(clientId, handler);
    }

    // Return a function for the zero-receivers case
    return () => {
      finish(true);
    };
  }

  /**
   * Registers a gap-fill request listener for a specific client socket.
   * @param clientId - The internal client ID.
   * @param socket - The upstream socket to listen on.
   */
  private _registerGapFillListener(
    clientId: string,
    socket: SocketWithClientId,
  ) {
    socket.on(this._events.gapFillReq, (req: GapFillRequest) => {
      this._logger.info('Server.GapFill', 'Gap-fill request received', {
        from: clientId,
        afterSeq: req.afterSeq,
      });

      const refs = this._refLog.filter(
        (p) => p.seq != null && p.seq > req.afterSeq,
      );

      const res: GapFillResponse = {
        route: req.route,
        refs,
      };

      // Respond on the same client's ioDown
      const clientEntry = this._clients.get(clientId);
      /* v8 ignore if -- @preserve */
      if (clientEntry) {
        clientEntry.ioDown.emit(this._events.gapFillRes, res);
      }
    });
  }

  /**
   * Creates and initializes a downstream Io peer for a socket.
   * @param socket - Client socket to bind the peer to.
   * @param clientId - Client identifier for logging.
   */
  private async _createIoPeer(socket: SocketLike, clientId: string) {
    const sockets = normalizeSocketBundle(socket);
    this._logger.info('Server.Io', 'Creating Io peer', { clientId });
    try {
      const ioPeer = new IoPeer(sockets.ioUp);
      await this._withTimeout(ioPeer.init(), 'IoPeer.init()');
      await this._withTimeout(ioPeer.isReady(), 'IoPeer.isReady()');
      this._logger.info('Server.Io', 'Io peer created', { clientId });
      return ioPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server.Io', 'Failed to create Io peer', error, {
        clientId,
      });
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Creates and initializes a downstream Bs peer for a socket.
   * @param socket - Client socket to bind the peer to.
   * @param clientId - Client identifier for logging.
   */
  private async _createBsPeer(socket: SocketLike, clientId: string) {
    const sockets = normalizeSocketBundle(socket);
    this._logger.info('Server.Bs', 'Creating Bs peer', { clientId });
    try {
      const bsPeer = new BsPeer(sockets.bsUp);
      await this._withTimeout(bsPeer.init(), 'BsPeer.init()');
      this._logger.info('Server.Bs', 'Bs peer created', { clientId });
      return bsPeer;
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server.Bs', 'Failed to create Bs peer', error, {
        clientId,
      });
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Registers the client socket and peers.
   * @param clientId - Stable client identifier.
   * @param sockets - Directional sockets to register.
   * @param io - Io peer associated with the client.
   * @param bs - Bs peer associated with the client.
   */
  private _registerClient(
    clientId: string,
    sockets: SocketNamespaceBundle & { [k: string]: SocketWithClientId },
    io: IoPeer,
    bs: BsPeer,
  ) {
    this._clients.set(clientId, {
      ioUp: sockets.ioUp as SocketWithClientId,
      ioDown: sockets.ioDown as SocketWithClientId,
      bsUp: sockets.bsUp as SocketWithClientId,
      bsDown: sockets.bsDown as SocketWithClientId,
      io,
      bs,
    });
  }

  /**
   * Queues an Io peer for inclusion in the Io multi.
   * @param ioPeer - Io peer to add.
   */
  private _queueIoPeer(ioPeer: IoPeer) {
    this._ios.push({
      io: ioPeer,
      dump: false,
      read: true,
      write: false,
      priority: 2,
    });
  }

  /**
   * Queues a Bs peer for inclusion in the Bs multi.
   * @param bsPeer - Bs peer to add.
   */
  private _queueBsPeer(bsPeer: BsPeer) {
    this._bss.push({
      bs: bsPeer,
      read: true,
      write: false,
      priority: 2,
    });
  }

  /**
   * Drops dead or orphaned entries from `_ios`/`_bss` before they can be
   * fed into a fresh IoMulti/BsMulti, or silently inflate `ioPeerCount`.
   * An entry is dropped when either:
   *  - its `isOpen` is explicitly `false` — a peer whose socket has
   *    closed. `IoMulti.init()` THROWS on this (see `@rljson/io`), which
   *    would strand the entire cascade — including every future rebuild
   *    — behind that one dead member; `BsMulti.init()` tolerates it, but
   *    both cascades should stop offering a known-dead member either way.
   *  - it is not the local cache entry and does not belong to any client
   *    currently in `_clients` — an orphan, e.g. left behind by a bug or
   *    a duplicate registration.
   * Called on every rebuild (see `_rebuildMultis`), which is the single
   * choke point that guarantees `new IoMulti(...)` below never sees a
   * closed member. Logs and checks the peer-count invariant whenever
   * anything actually changes.
   */
  private _pruneDeadPeers(): void {
    const liveIos = new Set<Io>();
    const liveBss = new Set<Bs>();
    for (const client of this._clients.values()) {
      if (client.io) liveIos.add(client.io);
      if (client.bs) liveBss.add(client.bs);
    }

    const ioCountBefore = this._ios.length;
    this._ios = this._ios.filter((entry) => {
      if (entry.io === this._localIo) return true;
      if (entry.io.isOpen === false) return false;
      return liveIos.has(entry.io);
    });

    const bsCountBefore = this._bss.length;
    this._bss = this._bss.filter((entry) => {
      if (entry.bs === this._localBs) return true;
      if ((entry.bs as { isOpen?: boolean }).isOpen === false) return false;
      return liveBss.has(entry.bs);
    });

    if (
      this._ios.length !== ioCountBefore ||
      this._bss.length !== bsCountBefore
    ) {
      this._logger.warn('Server', 'Pruned dead/orphaned peers', {
        ioRemoved: ioCountBefore - this._ios.length,
        bsRemoved: bsCountBefore - this._bss.length,
      });
    }

    this._checkPeerInvariant();
  }

  /**
   * Defensive invariant: the Io read cascade (`_ios`) should hold exactly
   * one entry per non-broadcast client plus, when local caching is
   * enabled, the local cache slot — no more, no less. Violations are
   * logged rather than thrown: this is a production safety net, not a
   * hard guard, so a drifted count degrades observability, not
   * availability. The violation branch is deliberately reachable (not
   * v8-ignored) so tests can prove it fires — see
   * server-peer-lifecycle.spec.ts.
   * @returns Whether the invariant currently holds.
   */
  private _checkPeerInvariant(): boolean {
    let nonBroadcastClients = 0;
    for (const clientId of this._clients.keys()) {
      if (!clientId.startsWith('broadcast_')) nonBroadcastClients++;
    }
    const expected = nonBroadcastClients + (this._disableLocalCache ? 0 : 1);
    const ok = this._ios.length === expected;

    if (!ok) {
      this._logger.error(
        'Server',
        'Io peer-count invariant violated',
        undefined,
        {
          actual: this._ios.length,
          expected,
          nonBroadcastClients,
          disableLocalCache: this._disableLocalCache,
        },
      );
    }

    return ok;
  }

  /**
   * Rebuilds Io and Bs multis from queued peers.
   */
  private async _rebuildMultis() {
    // F2/F3: prune dead/orphaned peers BEFORE constructing the next
    // IoMulti/BsMulti — see `_pruneDeadPeers` for why this is the single
    // choke point that has to run first.
    this._pruneDeadPeers();

    this._logger.info('Server', 'Rebuilding multis', {
      ioCount: this._ios.length,
      bsCount: this._bss.length,
    });

    try {
      this._ioMulti = new IoMulti(this._ios);
      await this._ioMulti.init();
      await this._ioMulti.isReady();

      this._bsMulti = new BsMulti(this._bss);
      await this._bsMulti.init();

      this._logger.info('Server', 'Multis rebuilt successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to rebuild multis', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Recreates servers and reattaches sockets.
   */
  private async _refreshServers() {
    this._logger.info('Server', 'Refreshing servers', {
      pendingSockets: this._pendingSockets.length,
    });

    try {
      (this._ioServer as any)._io = this._ioMulti;
      (this._bsServer as any)._bs = this._bsMulti;

      for (const pending of this._pendingSockets) {
        await this._ioServer.addSocket(pending.ioDown);
        await this._bsServer.addSocket(pending.bsDown);
      }

      this._pendingSockets = [];

      this._logger.info('Server', 'Servers refreshed successfully');
    } catch (error) {
      /* v8 ignore start -- @preserve */
      this._logger.error('Server', 'Failed to refresh servers', error);
      throw error;
    }
    /* v8 ignore stop -- @preserve */
  }

  /**
   * Batches multi/server refreshes into a single queued task.
   */
  private _queueRefresh() {
    if (!this._refreshPromise) {
      this._logger.info('Server', 'Queuing refresh');

      this._refreshPromise = Promise.resolve()
        .then(async () => {
          await this._rebuildMultis();
          await this._refreshServers();
        })
        .catch(
          /* v8 ignore next -- @preserve */
          (error) => {
            this._logger.error('Server', 'Queued refresh failed', error);
            throw error;
          },
        )
        .finally(() => {
          this._refreshPromise = undefined;
        });
    }

    return this._refreshPromise;
  }

  // ...........................................................................
  /**
   * Removes a connected client by its internal client ID.
   * Cleans up listeners, peers, and rebuilds multis.
   * @param clientId - The client identifier (from server.clients keys).
   */
  async removeSocket(clientId: string): Promise<void> {
    const client = this._clients.get(clientId);
    if (!client) return;

    this._logger.info('Server', 'Removing client socket', { clientId });

    // Remove multicast listener for this client
    client.ioUp.removeAllListeners(this._route.flat);

    // Remove disconnect handler. Absent when removeSocket() is called to
    // roll back a client whose _queueRefresh() rejected during addSocket
    // (F1) — that path never got as far as registering the real
    // disconnect handler in the first place.
    const cleanup = this._disconnectCleanups.get(clientId);
    if (cleanup) {
      cleanup();
      this._disconnectCleanups.delete(clientId);
    }

    // F4: Unregister this client's CRUD listeners from IoServer/BsServer.
    // Before io 0.0.73 / bs 0.0.25 these removeSocket() calls only forgot
    // the socket in internal bookkeeping — the CRUD handlers were
    // anonymous arrows with no retained reference, so they kept firing on
    // the down socket forever (a leak, and duplicate execution if the
    // socket is later shared with, or re-added to, another server — see
    // the two-Servers-one-socket coverage in server-peer-lifecycle.spec.ts).
    // Broadcast clients (see addBroadcastSocket) never had their down
    // sockets registered here in the first place — io/bs is null for
    // those — so there is nothing to unregister.
    if (client.io) {
      this._ioServer.removeSocket(client.ioDown);
    }
    if (client.bs) {
      this._bsServer.removeSocket(client.bsDown);
    }

    // Remove peers from multi arrays
    this._ios = this._ios.filter((entry) => entry.io !== client.io);
    this._bss = this._bss.filter((entry) => entry.bs !== client.bs);

    // Remove from clients map
    this._clients.delete(clientId);

    // Rebuild multis with remaining peers
    await this._rebuildMultis();

    // Refresh servers so IoServer/BsServer use updated multis
    // (pending sockets are empty here — we only refresh the internal references)
    await this._refreshServers();

    // Re-establish multicast for remaining clients
    this._removeAllListeners();
    this._multicastRefs();

    this._logger.info('Server', 'Client socket removed', {
      clientId,
      remainingClients: this._clients.size,
    });
  }

  // ...........................................................................
  /**
   * Gracefully shuts down the server: stops timers, removes listeners,
   * clears all client state, and closes storage layers.
   */
  async tearDown(): Promise<void> {
    this._logger.info('Server', 'Tearing down server');

    // Stop ref eviction timer
    if (this._refEvictionTimer) {
      clearInterval(this._refEvictionTimer);
      this._refEvictionTimer = undefined;
    }

    // Stop bootstrap heartbeat timer
    if (this._bootstrapHeartbeatTimer) {
      clearInterval(this._bootstrapHeartbeatTimer);
      this._bootstrapHeartbeatTimer = undefined;
    }

    // Stop health check timer
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = undefined;
    }

    // Remove all multicast listeners
    this._removeAllListeners();

    // Remove disconnect handlers
    for (const cleanup of this._disconnectCleanups.values()) {
      cleanup();
    }
    this._disconnectCleanups.clear();

    // Clear all client-related data
    this._clients.clear();
    this._pendingSockets = [];

    // Close IoMulti
    /* v8 ignore else -- @preserve */
    if (this._ioMulti && this._ioMulti.isOpen) {
      this._ioMulti.close();
    }

    // Clear multi arrays
    this._ios = [];
    this._bss = [];

    // Clear ref tracking
    this._multicastedRefsCurrent.clear();
    this._multicastedRefsPrevious.clear();

    // Clear ref log
    this._refLog = [];

    // Clear bootstrap state
    this._latestRef = undefined;

    this._tornDown = true;

    this._logger.info('Server', 'Server torn down successfully');
  }

  /**
   * Whether the server has been torn down.
   */
  get isTornDown(): boolean {
    return this._tornDown;
  }

  // ...........................................................................
  /**
   * Registers a listener that auto-removes the client on socket disconnect.
   * @param clientId - Client identifier.
   * @param socket - The upstream socket to listen on.
   */
  private _registerDisconnectHandler(
    clientId: string,
    socket: SocketWithClientId,
  ) {
    const handler = async () => {
      this._logger.info('Server', 'Client disconnected', { clientId });
      // F3: nothing awaits this handler's own returned promise — it runs
      // as an event callback. Without this try/catch, a rejection from
      // removeSocket() (e.g. a rebuild failure while tearing the client
      // down) would surface as an unhandled promise rejection instead of
      // a logged, recoverable error.
      try {
        await this.removeSocket(clientId);
      } catch (error) {
        this._logger.error(
          'Server',
          'removeSocket failed while handling disconnect',
          error,
          { clientId },
        );
      }
    };
    socket.on('disconnect', handler);
    this._disconnectCleanups.set(clientId, () => {
      socket.off('disconnect', handler);
    });
  }

  // ...........................................................................
  /**
   * Races a promise against a timeout. Resolves/rejects with the original
   * promise outcome if it settles first, or rejects with a timeout error.
   * @param promise - The promise to race.
   * @param label - Human-readable label for timeout error messages.
   */
  private _withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    const ms = this._peerInitTimeoutMs;
    if (ms <= 0) return promise;

    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        /* v8 ignore next -- @preserve */
        () => reject(new Error(`Timeout after ${ms}ms: ${label}`)),
        ms,
      );
    });

    return Promise.race([promise, timeout]).finally(
      /* v8 ignore next -- @preserve */
      () => clearTimeout(timer),
    );
  }

  /** Example instance for test purposes */
  static async example(): Promise<Server> {
    const route = Route.fromFlat('example.route');

    const io = new IoMem();
    await io.init();
    await io.isReady();

    const bs = new BsMem();

    const socket = new SocketMock();
    socket.connect();

    return new Server(route, io, bs).addSocket(socket);
  }
}
