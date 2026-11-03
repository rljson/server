// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Io } from '@rljson/io';
import { ContentType, Rljson, TableCfg, TableKey } from '@rljson/rljson';

import {
  PeerReads,
  ReadByHashesRequest,
  ReadRowsRequest,
} from './peer-reads.ts';

/** A request naming one table. */
type TableRequest = Parameters<Io['dumpTable']>[0];

// #############################################################################
/**
 * An Io that asks the peers first and the hub second.
 *
 * Wraps the client's Io to the hub. Row reads go to {@link PeerReads} first;
 * whatever the peers cannot answer goes to the hub, whose answer — rows,
 * nothing, or an error — is returned unchanged. Every other call goes to the
 * hub directly.
 *
 * Sitting in the hub's own slot of the client's multi is deliberate: to the
 * multi this is still one member that behaves like the hub, only faster when
 * a peer helps. A failing peer never becomes a failing member, so "not found"
 * stays "not found".
 */
export class PeerFirstIo implements Io {
  /**
   * Reads rows by hashes: the peers first, the rest from the hub. Present
   * only when the hub's Io offers batch reads, like the hub itself.
   */
  readonly readRowsByHashes?: (request: ReadByHashesRequest) => Promise<Rljson>;

  // ...........................................................................
  /**
   * Creates the wrapper.
   * @param _hub - The client's Io to the hub.
   * @param _peers - The peer reads of this client.
   */
  constructor(
    private readonly _hub: Io,
    private readonly _peers: PeerReads,
  ) {
    const batch = _hub.readRowsByHashes?.bind(_hub);
    if (batch) {
      this.readRowsByHashes = (request) => this._readByHashes(request, batch);
    }
  }

  // ...........................................................................
  /** Whether the hub's Io is open. */
  get isOpen(): boolean {
    return this._hub.isOpen;
  }

  // ...........................................................................
  /** Initializes the hub's Io. */
  init(): Promise<void> {
    return this._hub.init();
  }

  // ...........................................................................
  /** Closes the hub's Io. */
  close(): Promise<void> {
    return this._hub.close();
  }

  // ...........................................................................
  /** Resolves once the hub's Io is ready. */
  isReady(): Promise<void> {
    return this._hub.isReady();
  }

  // ...........................................................................
  /** Dumps the hub's data. */
  dump(): Promise<Rljson> {
    return this._hub.dump();
  }

  // ...........................................................................
  /**
   * Dumps one table of the hub.
   * @param request - The table.
   */
  dumpTable(request: TableRequest): Promise<Rljson> {
    return this._hub.dumpTable(request);
  }

  // ...........................................................................
  /**
   * The content type of a table, from the hub.
   * @param request - The table.
   */
  contentType(request: TableRequest): Promise<ContentType> {
    return this._hub.contentType(request);
  }

  // ...........................................................................
  /**
   * Whether the hub knows a table.
   * @param tableKey - The table's key.
   */
  tableExists(tableKey: TableKey): Promise<boolean> {
    return this._hub.tableExists(tableKey);
  }

  // ...........................................................................
  /**
   * Creates or extends a table on the hub.
   * @param request - The table config.
   */
  createOrExtendTable(request: Parameters<Io['createOrExtendTable']>[0]): Promise<void> {
    return this._hub.createOrExtendTable(request);
  }

  // ...........................................................................
  /** The hub's table configurations. */
  rawTableCfgs(): Promise<TableCfg[]> {
    return this._hub.rawTableCfgs();
  }

  // ...........................................................................
  /**
   * Writes to the hub.
   * @param request - The data.
   */
  write(request: Parameters<Io['write']>[0]): Promise<void> {
    return this._hub.write(request);
  }

  // ...........................................................................
  /**
   * Reads rows: the first peer answer with rows, otherwise the hub's answer.
   * @param request - Table and where clause.
   */
  async readRows(request: ReadRowsRequest): Promise<Rljson> {
    return (await this._peers.readRows(request)) ?? this._hub.readRows(request);
  }

  // ...........................................................................
  /**
   * Counts the rows of a table on the hub.
   * @param table - The table.
   */
  rowCount(table: string): Promise<number> {
    return this._hub.rowCount(table);
  }

  // ...........................................................................
  /**
   * Reads rows by hashes: what the peers have, and the rest from the hub.
   * @param request - Table and hashes.
   * @param fromHub - The hub's batch read.
   * @returns All rows found.
   */
  private async _readByHashes(
    request: ReadByHashesRequest,
    fromHub: (request: ReadByHashesRequest) => Promise<Rljson>,
  ): Promise<Rljson> {
    const fromPeers = await this._peers.readRowsByHashes(request);
    if (!fromPeers) return fromHub(request);

    const peerTable = fromPeers[request.table] as {
      _data: { _hash?: string }[];
    };
    const found = new Set(peerTable._data.map((row) => row._hash));
    const rest = request.hashes.filter((hash) => !found.has(hash));
    if (rest.length === 0) return fromPeers;

    const hubAnswer = await fromHub({ table: request.table, hashes: rest });
    const hubTable = hubAnswer[request.table] as {
      _data: unknown[];
      _type: ContentType;
    };
    return {
      [request.table]: {
        _type: hubTable._type,
        _data: [...peerTable._data, ...hubTable._data],
      },
    } as Rljson;
  }
}
