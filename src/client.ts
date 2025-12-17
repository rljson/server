// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Connector, Db, MultiEditManager } from '@rljson/db';
import { Io, IoMulti, IoMultiIo, Socket } from '@rljson/io';
import { Rljson, Route, TableCfg } from '@rljson/rljson';

export class Client {
  private _id = Math.random().toString(36).substring(2, 15);

  private _db?: Db;
  private _connector?: Connector;
  private _mem?: MultiEditManager;
  private _ios: IoMultiIo[] = [];
  private _io?: Io;
  private _editRoute: Route;

  constructor(private _cakeKey: string, private _socket: Socket) {
    this._editRoute = Route.fromFlat(`/${this._cakeKey}EditHistory`);
  }

  async addIoMultiIo(ioMultiIo: IoMultiIo) {
    //Add IoMultiIo
    this._ios.push(ioMultiIo);

    //Close existing IoMulti, closes all underlying Ios
    if (this._io && this._io.isOpen) {
      await this._io.close();
    }

    //Open/Re-Open all underlying Ios
    for (const io of this._ios.map((iomio) => iomio.io)) {
      if (io.isOpen === false) {
        await io.init();
        await io.isReady();
      }
    }

    //Create IoMulti
    this._io = new IoMulti(this._ios);
    await this._io.init();
    await this._io.isReady();

    //Connect Db to new IoMulti
    if (this._db) this._db = this._db.clone(this._io);
    else this._db = new Db(this._io);

    //Connector init
    this._connector = new Connector(this._db, this._editRoute, this._socket);

    //MultiEditManager init
    this._mem = new MultiEditManager(this._cakeKey, this._db);
    this._mem.init();

    //Connect Connector and MultiEditManager
    this._connector.listen(async (editHistoryRef: string) => {
      await this._mem!.editHistoryRef(editHistoryRef);
    });

    return this._io;
  }

  async createTables(cfgs: {
    withInsertHistory?: TableCfg[];
    withoutInsertHistory?: TableCfg[];
  }) {
    if (!this._db) throw new Error('Db not initialized');

    //Create Tables for TableCfgs without InsertHistory
    for (const tableCfg of cfgs.withoutInsertHistory || []) {
      await this._db.core.createTable(tableCfg);
    }

    //Create Tables for TableCfgs with InsertHistory
    for (const tableCfg of cfgs.withInsertHistory || []) {
      await this._db.core.createTableWithInsertHistory(tableCfg);
    }
  }

  async import(data: Rljson) {
    if (!this._db) throw new Error('Db not initialized');

    await this._db.core.import(data);
  }

  async tearDown() {
    //Close Io
    if (this._io && this._io.isOpen) {
      this._io.close();
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
    return this._db;
  }

  get connector() {
    return this._connector;
  }

  get mem() {
    return this._mem;
  }

  get io() {
    return this._io;
  }

  get socket() {
    return this._socket;
  }
}
