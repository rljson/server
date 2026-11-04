// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

export { Client, clientMaxServes } from './client.ts';
export type { ClientOptions } from './client.ts';
export { FileLogger } from './file-logger.ts';
export type { FileLoggerOptions } from './file-logger.ts';
export {
  BufferedLogger,
  ConsoleLogger,
  FilteredLogger,
  lateLogger,
  NoopLogger,
  noopLogger,
} from './logger.ts';
export type { LogEntry, ServerLogger } from './logger.ts';
export { ChannelSocket, createChannelPair } from './channel-socket.ts';
export type { MessageChannelLike } from './channel-socket.ts';
export { HubRoutes } from './hub-routes.ts';
export type { HubRouteStores, HubRoutesOptions } from './hub-routes.ts';
export { Node } from './node.ts';
export type {
  ConnectRoute,
  CreatePortTransport,
  NodeConfig,
  NodeDeps,
  NodeEventName,
  NodeEvents,
  NodeHubChangedEvent,
  PortHandshake,
  PortTransport,
} from './node.ts';
export { PeerFirstBs } from './peer-first-bs.ts';
export { PeerFirstIo } from './peer-first-io.ts';
export { PeerReadServer } from './peer-read-server.ts';
export type {
  PeerReadServerOptions,
  PeerReadServerStats,
} from './peer-read-server.ts';
export { peerReadEvents, PeerReads } from './peer-reads.ts';
export type {
  ConnectPeer,
  PeerReadsOptions,
  PeerReadStats,
  ReadByHashesRequest,
  ReadRowsRequest,
} from './peer-reads.ts';
export { ClientRoute } from './route-member.ts';
export type {
  AgentHandle,
  ClientRouteAgentContext,
  ClientRouteOptions,
  LocalStores,
  PeerReadBounds,
  RouteMember,
  RouteMemberContext,
  RoutePeerReads,
} from './route-member.ts';
export type { StampOptions } from './ref-stamper.ts';
export { Server } from './server.ts';
export type { ServerOptions } from './server.ts';
export type { SocketLike, SocketNamespaceBundle } from './socket-bundle.ts';
export { SocketIoBridge } from './socket-io-bridge.ts';
export {
  serveWorkerRoute,
  WorkerRoute,
  workerRouteEvents,
} from './worker-route.ts';
export type {
  ServeWorkerRouteOptions,
  WorkerHandle,
  WorkerLaunchContext,
  WorkerRouteOptions,
  WorkerRouteServing,
} from './worker-route.ts';

// Re-export sync protocol types from @rljson/rljson for convenience
export { syncEvents } from '@rljson/rljson';
export type {
  AckPayload,
  ConnectorPayload,
  GapFillRequest,
  GapFillResponse,
  SyncConfig,
  SyncEventNames,
} from '@rljson/rljson';
export * from './live-view.ts';
