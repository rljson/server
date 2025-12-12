// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Connector, Db, MultiEditManager, staticExample } from '@rljson/db';
import { Io, IoMem, Socket } from '@rljson/io';
import {
  createEditHistoryTableCfg,
  createEditTableCfg,
  createMultiEditTableCfg,
  Route,
} from '@rljson/rljson';

export interface Client {
  db: Db;
  io: Io;
  connector: Connector;
  mem: MultiEditManager;
}

const client = async (
  cakeKey: string,
  socket: Socket,
  route: Route,
): Promise<Client> => {
  //Init io
  const io = new IoMem();
  await io.init();
  await io.isReady();

  //Init Core
  const db = new Db(io);

  //Create Tables for TableCfgs
  for (const tableCfg of staticExample().tableCfgs._data) {
    await db.core.createTableWithInsertHistory(tableCfg);
  }

  //Create Tables for Edit TableCfgs
  await db.core.createTable(createMultiEditTableCfg(cakeKey));
  await db.core.createTable(createEditTableCfg(cakeKey));
  await db.core.createTable(createEditHistoryTableCfg(cakeKey));

  //Import Data
  await db.core.import(staticExample());

  //Connect Connector and MultiEditManager
  const connector = new Connector(db, route, socket);
  const mem = new MultiEditManager(cakeKey, db);

  mem.init();

  connector.listen((editHistoryRef: string) =>
    mem.editHistoryRef(editHistoryRef),
  );

  return { db, io, connector, mem };
};

export default client;
