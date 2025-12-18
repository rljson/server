// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Connector, Db, MultiEditManager } from '@rljson/db';
import { Io, IoMem, IoMulti, IoMultiIo, IoPeer, IoPeerBridge, Socket } from '@rljson/io';
import { Rljson, Route, TableCfg } from '@rljson/rljson';


export class Client {
  private _id = Math.random().toString(36).substring(2, 15);

  private _ioLocalDb?: Db;
  private _ioLocal?: Io;

  private _ioMultiDb?: Db;
  private _ioMultiIos: IoMultiIo[] = [];
  private _ioMulti?: IoMulti;

  private _connector?: Connector;
  private _mem?: MultiEditManager;

  private _editRefsReceived: string[] = [];

  // ...........................................................................
  /**
   * Creates a Client instance
   * @param _route - Route for edits
   * @param _cakeKey - Cake key for MultiEditManager
   * @param _socketToServer - Socket to connect to server
   */
  constructor(
    private _route: Route,
    private _cakeKey: string,
    private _socketToServer: Socket,
  ) {}

  async init() {
    //Init ioLocalDb
    this._ioLocal = new IoMem();
    await this._ioLocal.init();
    await this._ioLocal.isReady();

    //Init ioLocalDb to manage local storage in convenient way
    this._ioLocalDb = new Db(this._ioLocal);

    //Add LocalIo to MultiIo
    this._ioMultiIos.push({
      io: this._ioLocal,
      dump: true,
      read: true,
      write: true,
      priority: 1,
    });

    //Create IoPeerBridge: Endpoint letting the Server to pull data from Client (Upload)
    const ioPeerBridge = new IoPeerBridge(this._ioLocal, this._socketToServer);
    ioPeerBridge.start();

    //Create IoPeer: Pull data from Server (Download)
    const ioPeer = new IoPeer(this._socketToServer);
    await ioPeer.init();
    await ioPeer.isReady();

    this._ioMultiIos.push({
      io: ioPeer,
      dump: true,
      read: true,
      write: false,
      priority: 2,
    });

    //Create IoMulti
    this._ioMulti = new IoMulti(this._ioMultiIos);
    await this._ioMulti.init();
    await this._ioMulti.isReady();

    //Create IoMultiDb
    this._ioMultiDb = new Db(this._ioMulti);

    //Connector
    //Receiver: Edits from Server and applies them to IoMultiDb
    //Sender: Edits made in IoLocalDb to Server
    this._connector = new Connector(
      this._ioMultiDb,
      this._route,
      this._socketToServer,
    );

    //MultiEditManager
    //Convenience to manage MultiEdits
    this._mem = new MultiEditManager(this._cakeKey, this._ioMultiDb);
    this._mem.init();

    //Wire up Connector to MultiEditManager
    //When Connector receives new EditHistoryRef, inform MultiEditManager
    this._connector.listen(async (editHistoryRef: string) => {
      this._editRefsReceived.push(editHistoryRef);
      await this._mem!.editHistoryRef(editHistoryRef);
    });

    return this._ioMulti;
  }

  async createTables(cfgs: {
    withInsertHistory?: TableCfg[];
    withoutInsertHistory?: TableCfg[];
  }) {
    if (!this._ioLocalDb) throw new Error('Local Db not initialized');

    //Create Tables for TableCfgs without InsertHistory
    for (const tableCfg of cfgs.withoutInsertHistory || []) {
      await this._ioLocalDb.core.createTable(tableCfg);
    }

    //Create Tables for TableCfgs with InsertHistory
    for (const tableCfg of cfgs.withInsertHistory || []) {
      await this._ioLocalDb.core.createTableWithInsertHistory(tableCfg);
    }
  }

  async import(data: Rljson) {
    if (!this._ioLocalDb) throw new Error('Local Db not initialized');

    await this._ioLocalDb.core.import(data);
  }

  async tearDown() {
    //Close Io
    if (this._ioMulti && this._ioMulti.isOpen) {
      this._ioMulti.close();
    }

    if (this._connector) {
      this._connector.teardown();
    }

    if (this._mem) {
      this._mem.tearDown();
    }
  }

  get id() {
    return this._id;
  }

  get db() {
    return this._ioMultiDb;
  }

  get connector() {
    return this._connector;
  }

  get mem() {
    return this._mem;
  }

  get io() {
    return this._ioMulti;
  }

  get socket() {
    return this._socketToServer;
  }
}
