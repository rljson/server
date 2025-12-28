/* eslint-disable tsdoc/syntax */
import { Db } from '@rljson/db';
import { Io } from '@rljson/io';
import { Rljson, TableCfg } from '@rljson/rljson';

// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.
export abstract class BaseNode {
  private _localDb: Db;

  constructor(protected _localIo: Io) {
    /* v8 ignore if -- @preserve */
    if (!_localIo.isOpen) {
      throw new Error('Local Io must be initialized and open');
    }

    this._localDb = new Db(this._localIo);
  }

  // ...........................................................................
  /**
   *  Creates tables in the local Db.
   * @param cfgs - Table configurations
   * @param cfgs.withInsertHistory - TableCfgs for tables with InsertHistory
   * @param cfgs.withoutInsertHistory - TableCfgs for tables without InsertHistory
   */
  async createTables(cfgs: {
    withInsertHistory?: TableCfg[];
    withoutInsertHistory?: TableCfg[];
  }) {
    /* v8 ignore if -- @preserve */
    if (!this._localDb) throw new Error('Local Db not initialized');

    //Create Tables for TableCfgs without InsertHistory
    /* v8 ignore next -- @preserve */
    for (const tableCfg of cfgs.withoutInsertHistory || []) {
      await this._localDb.core.createTable(tableCfg);
    }

    //Create Tables for TableCfgs with InsertHistory
    /* v8 ignore next -- @preserve */
    for (const tableCfg of cfgs.withInsertHistory || []) {
      await this._localDb.core.createTableWithInsertHistory(tableCfg);
    }
  }

  // ...........................................................................
  /**
   * Imports Rljson data into the local Db.
   * @param data - Rljson data to import
   */
  /* v8 ignore next -- @preserve */
  async import(data: Rljson) {
    if (!this._localDb) throw new Error('Local Db not initialized');

    await this._localDb.core.import(data);
  }
}
