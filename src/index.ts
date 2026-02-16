// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

export { Client } from './client.ts';
export type { ClientOptions } from './client.ts';
export {
  BufferedLogger,
  ConsoleLogger,
  FilteredLogger,
  NoopLogger,
  noopLogger,
} from './logger.ts';
export type { LogEntry, ServerLogger } from './logger.ts';
export { Server } from './server.ts';
export type { ServerOptions } from './server.ts';
export { SocketIoBridge } from './socket-io-bridge.ts';

// Re-export sync protocol types from @rljson/rljson for convenience
export type {
  AckPayload,
  ConnectorPayload,
  GapFillRequest,
  GapFillResponse,
  SyncConfig,
  SyncEventNames,
} from '@rljson/rljson';
export { syncEvents } from '@rljson/rljson';
