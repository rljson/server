import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import {
  Server as SocketIoServer,
  Socket as SocketIoServerSocket,
} from 'socket.io';
import {
  io as SocketIoClient,
  Socket as SocketIoClientSocket,
} from 'socket.io-client';

export const namespaces = {
  ioUp: '/io-up',
  ioDown: '/io-down',
  bsUp: '/bs-up',
  bsDown: '/bs-down',
};

export type ServerSocketBundle = {
  ioUp: SocketIoServerSocket;
  ioDown: SocketIoServerSocket;
  bsUp: SocketIoServerSocket;
  bsDown: SocketIoServerSocket;
};

export type ClientSocketBundle = {
  ioUp: SocketIoClientSocket;
  ioDown: SocketIoClientSocket;
  bsUp: SocketIoClientSocket;
  bsDown: SocketIoClientSocket;
};

export type NamespaceHarness = {
  httpServer: HttpServer;
  ioServer: SocketIoServer;
  serverSockets: Array<Partial<ServerSocketBundle>>;
  clientSockets: Array<Partial<ClientSocketBundle>>;
  port: number;
  close: () => Promise<void>;
};

/**
 * Spins up a Socket.IO server with four namespaces and connects the requested number of clients.
 * Returns a harness with aligned server/client socket bundles by index.
 */
export async function createNamespaceHarness(
  clientCount: number,
): Promise<NamespaceHarness> {
  const httpServer = createServer();
  // Increase buffer to accommodate large blob payloads in tests (default is 1MB)
  const ioServer = new SocketIoServer(httpServer, {
    maxHttpBufferSize: 10 * 1024 * 1024,
  });

  const serverSockets: Array<Partial<ServerSocketBundle>> = Array.from(
    { length: clientCount },
    () => ({}),
  );
  const clientSockets: Array<Partial<ClientSocketBundle>> = Array.from(
    { length: clientCount },
    () => ({}),
  );

  Object.entries(namespaces).forEach(([key, ns]) => {
    ioServer.of(ns).on('connection', (socket) => {
      // The connection order matches the client creation order; assign by index.
      const idx = socket.handshake.auth?.idx ?? socket.handshake.query?.idx;
      const index = typeof idx === 'string' ? parseInt(idx, 10) : Number(idx);
      if (Number.isFinite(index) && index >= 0 && index < clientCount) {
        (serverSockets[index] as any)[key] = socket;
      }
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(() => resolve());
  });

  const port = (httpServer.address() as AddressInfo).port;

  // Connect each client to all namespaces and wait for all to connect.
  await Promise.all(
    clientSockets.map(async (_, index) => {
      clientSockets[index].ioUp = SocketIoClient(
        `http://localhost:${port}${namespaces.ioUp}`,
        { forceNew: true, auth: { idx: index } },
      );
      clientSockets[index].ioDown = SocketIoClient(
        `http://localhost:${port}${namespaces.ioDown}`,
        { forceNew: true, auth: { idx: index } },
      );
      clientSockets[index].bsUp = SocketIoClient(
        `http://localhost:${port}${namespaces.bsUp}`,
        { forceNew: true, auth: { idx: index } },
      );
      clientSockets[index].bsDown = SocketIoClient(
        `http://localhost:${port}${namespaces.bsDown}`,
        { forceNew: true, auth: { idx: index } },
      );

      await Promise.all(
        [
          clientSockets[index].ioUp,
          clientSockets[index].ioDown,
          clientSockets[index].bsUp,
          clientSockets[index].bsDown,
        ].map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket!.on('connect', () => resolve());
            }),
        ),
      );
    }),
  );

  const close = async () => {
    for (const sockets of clientSockets) {
      sockets.ioUp?.disconnect();
      sockets.ioDown?.disconnect();
      sockets.bsUp?.disconnect();
      sockets.bsDown?.disconnect();
    }
    await ioServer.close();
    httpServer.close();
  };

  return { httpServer, ioServer, serverSockets, clientSockets, port, close };
}
