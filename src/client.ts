// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMulti, BsMultiBs, BsPeer, BsPeerBridge } from '@rljson/bs';
import {
  Io,
  IoMulti,
  IoMultiIo,
  IoPeer,
  IoPeerBridge,
  Socket,
} from '@rljson/io';

import { BaseNode } from './base-node.ts';

export class Client extends BaseNode {
  private _ioMultiIos: IoMultiIo[] = [];
  private _ioMulti?: IoMulti;

  private _bsMultiBss: BsMultiBs[] = [];
  private _bsMulti?: BsMulti;

  // ...........................................................................
  /**
   * Creates a Client instance
   * @param _socketToServer - Socket to connect to server
   * @param _localIo - Local Io for local storage
   * @param _localBs - Local Bs for local blob storage
   */
  constructor(
    private _socketToServer: Socket,
    protected _localIo: Io,
    protected _localBs: Bs,
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
   * Builds the Io multi with local and peer layers.
   */
  private async _setupIo() {
    // Add LocalIo to MultiIo
    this._ioMultiIos.push({
      io: this._localIo,
      dump: true,
      read: true,
      write: true,
      priority: 1,
    });

    // Upstream: let the server pull from client local Io
    const ioPeerBridge = new IoPeerBridge(this._localIo, this._socketToServer);
    ioPeerBridge.start();

    // Downstream: pull from server
    const ioPeer = await this._createIoPeer();

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
    // Add LocalBs to MultiBs
    this._bsMultiBss.push({
      bs: this._localBs,
      read: true,
      write: true,
      priority: 1,
    });

    // Upstream: let the server pull from client local Bs
    const bsPeerBridge = new BsPeerBridge(this._localBs, this._socketToServer);
    bsPeerBridge.start();

    // Downstream: pull from server
    const bsPeer = await this._createBsPeer();

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
   */
  private async _createIoPeer() {
    const ioPeer = new IoPeer(this._socketToServer);
    await ioPeer.init();
    await ioPeer.isReady();
    return ioPeer;
  }

  /**
   * Creates and initializes a downstream Bs peer.
   */
  private async _createBsPeer() {
    const bsPeer = new BsPeer(this._socketToServer);
    await bsPeer.init();
    return bsPeer;
  }
}
