// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMulti, BsMultiBs, BsPeer, BsPeerBridge } from '@rljson/bs';
import { Connector, Db } from '@rljson/db';
import { Io, IoMulti, IoMultiIo, IoPeer, IoPeerBridge } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { BaseNode } from './base-node.ts';
import {
  normalizeSocketBundle,
  SocketLike,
  SocketNamespaceBundle,
} from './socket-bundle.ts';

export class Client extends BaseNode {
  private _ioMultiIos: IoMultiIo[] = [];
  private _ioMulti?: IoMulti;

  private _bsMultiBss: BsMultiBs[] = [];
  private _bsMulti?: BsMulti;

  private _db?: Db;
  private _connector?: Connector;

  // ...........................................................................
  /**
   * Creates a Client instance
   * @param _socketToServer - Socket or namespace bundle to connect to server
   * @param _localIo - Local Io for local storage
   * @param _localBs - Local Bs for local blob storage
   * @param _route - Optional route for automatic Db and Connector creation
   */
  constructor(
    private _socketToServer: SocketLike,
    protected _localIo: Io,
    protected _localBs: Bs,
    private _route?: Route,
  ) {
    //Call BaseNode constructor
    super(_localIo);
  }

  /**
   * Initializes Io and Bs multis and their peer bridges.
   * @returns The initialized Io implementation.
   */
  async init() {
    await this._setupIo();
    await this._setupBs();

    if (this._route) {
      this._setupDbAndConnector();
    }

    await this.ready();

    return this._ioMulti;
  }

  /**
   * Resolves once the Io implementation is ready.
   */
  async ready() {
    /* v8 ignore next -- @preserve */ if (this._ioMulti) {
      await this._ioMulti.isReady();
    }
  }

  /**
   * Closes client resources and clears internal state.
   */
  async tearDown() {
    //Close Io
    /* v8 ignore else -- @preserve */
    if (this._ioMulti && this._ioMulti.isOpen) {
      this._ioMulti.close();
    }

    //Close Bs
    /* v8 ignore else -- @preserve */
    if (this._bsMulti) {
      // BsMulti doesn't have isOpen, just close it
      // (Future: BsMulti should have close() method)
    }

    this._ioMultiIos = [];
    this._bsMultiBss = [];
    this._ioMulti = undefined;
    this._bsMulti = undefined;
    this._db = undefined;
    this._connector = undefined;
  }

  /**
   * Returns the Io implementation.
   */
  get io(): Io | undefined {
    return this._ioMulti;
  }

  /**
   * Returns the Bs implementation.
   */
  get bs(): Bs | undefined {
    return this._bsMulti;
  }

  /**
   * Returns the Db instance (available when route was provided).
   */
  get db(): Db | undefined {
    return this._db;
  }

  /**
   * Returns the Connector instance (available when route was provided).
   */
  get connector(): Connector | undefined {
    return this._connector;
  }

  /**
   * Returns the route (if provided).
   */
  get route(): Route | undefined {
    return this._route;
  }

  /**
   * Creates Db and Connector from the route and IoMulti.
   * Called during init() when a route was provided.
   */
  private _setupDbAndConnector() {
    this._db = new Db(this._ioMulti!);
    const socket = normalizeSocketBundle(this._socketToServer);
    this._connector = new Connector(this._db, this._route!, socket.ioUp);
  }

  /**
   * Builds the Io multi with local and peer layers.
   */
  private async _setupIo() {
    const sockets = normalizeSocketBundle(this._socketToServer);

    // Add LocalIo to MultiIo
    this._ioMultiIos.push({
      io: this._localIo,
      dump: true,
      read: true,
      write: true,
      priority: 1,
    });

    // Upstream: let the server pull from client local Io
    const ioPeerBridge = new IoPeerBridge(this._localIo, sockets.ioUp);
    ioPeerBridge.start();

    // Downstream: pull from server
    const ioPeer = await this._createIoPeer(sockets.ioDown);

    this._ioMultiIos.push({
      io: ioPeer,
      dump: false,
      read: true,
      write: false,
      priority: 2,
    });

    this._ioMulti = new IoMulti(this._ioMultiIos);
    await this._ioMulti.init();
    await this._ioMulti.isReady();
  }

  /**
   * Builds the Bs multi with local and peer layers.
   */
  private async _setupBs() {
    const sockets = normalizeSocketBundle(this._socketToServer);

    // Add LocalBs to MultiBs
    this._bsMultiBss.push({
      bs: this._localBs,
      read: true,
      write: true,
      priority: 1,
    });

    // Upstream: let the server pull from client local Bs
    const bsPeerBridge = new BsPeerBridge(this._localBs, sockets.bsUp);
    bsPeerBridge.start();

    // Downstream: pull from server
    const bsPeer = await this._createBsPeer(sockets.bsDown);

    this._bsMultiBss.push({
      bs: bsPeer,
      read: true,
      write: false,
      priority: 2,
    });

    this._bsMulti = new BsMulti(this._bsMultiBss);
    await this._bsMulti.init();
  }

  /**
   * Creates and initializes a downstream Io peer.
   * @param socket - Downstream socket to the server Io namespace.
   */
  private async _createIoPeer(socket: SocketNamespaceBundle['ioDown']) {
    const ioPeer = new IoPeer(socket);
    await ioPeer.init();
    await ioPeer.isReady();
    return ioPeer;
  }

  /**
   * Creates and initializes a downstream Bs peer.
   * @param socket - Downstream socket to the server Bs namespace.
   */
  private async _createBsPeer(socket: SocketNamespaceBundle['bsDown']) {
    const bsPeer = new BsPeer(socket);
    await bsPeer.init();
    return bsPeer;
  }
}
