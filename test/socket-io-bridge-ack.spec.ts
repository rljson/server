// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as SocketIoClient } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SocketIoBridge } from '../src/socket-io-bridge';


describe('SocketIoBridge Acknowledgment Tests', () => {
  let socketIoServer: SocketIoServer;
  let port: number;

  beforeAll(() => {
    return new Promise((resolve) => {
      const httpServer = createServer();
      socketIoServer = new SocketIoServer(httpServer);

      httpServer.listen(() => {
        port = (httpServer.address() as AddressInfo).port;
        resolve(undefined);
      });
    });
  });

  afterAll(() => {
    socketIoServer.close();
  });

  it('Should correctly transmit boolean true through acknowledgment', async () => {
    return new Promise<void>((resolve) => {
      socketIoServer.on('connection', (serverSocket) => {
        const serverBridge = new SocketIoBridge(serverSocket);

        // When client emits 'testTrue', respond with callback(true)
        serverBridge.on(
          'testTrue',
          (data: any, callback: (result: boolean) => void) => {
            console.log('Server received testTrue, data:', data);
            console.log('Server calling callback with true');
            callback(true);
          },
        );
      });

      const clientSocket = SocketIoClient(`http://localhost:${port}`);
      const clientBridge = new SocketIoBridge(clientSocket);

      clientBridge.on('connect', () => {
        console.log('Client connected');
        clientBridge.emit('testTrue', { test: 'data' }, (result: boolean) => {
          console.log(
            'Client received acknowledgment:',
            result,
            'Type:',
            typeof result,
          );
          expect(result).toBe(true);
          expect(typeof result).toBe('boolean');
          clientSocket.disconnect();
          resolve();
        });
      });
    });
  });

  it('Should correctly transmit boolean false through acknowledgment', async () => {
    return new Promise<void>((resolve) => {
      socketIoServer.on('connection', (serverSocket) => {
        const serverBridge = new SocketIoBridge(serverSocket);

        // When client emits 'testFalse', respond with callback(false)
        serverBridge.on(
          'testFalse',
          (data: any, callback: (result: boolean) => void) => {
            console.log('Server received testFalse, data:', data);
            console.log('Server calling callback with false');
            callback(false);
          },
        );
      });

      const clientSocket = SocketIoClient(`http://localhost:${port}`);
      const clientBridge = new SocketIoBridge(clientSocket);

      clientBridge.on('connect', () => {
        console.log('Client connected');
        clientBridge.emit('testFalse', { test: 'data' }, (result: boolean) => {
          console.log(
            'Client received acknowledgment:',
            result,
            'Type:',
            typeof result,
          );
          expect(result).toBe(false);
          expect(typeof result).toBe('boolean');
          clientSocket.disconnect();
          resolve();
        });
      });
    });
  });

  it('Should correctly transmit single argument through acknowledgment', async () => {
    return new Promise<void>((resolve) => {
      socketIoServer.on('connection', (serverSocket) => {
        const serverBridge = new SocketIoBridge(serverSocket);

        serverBridge.on(
          'testSingleArg',
          (data: any, callback: (...args: any[]) => void) => {
            console.log('Server calling callback with single boolean argument');
            callback(true); // Single argument
          },
        );
      });

      const clientSocket = SocketIoClient(`http://localhost:${port}`);
      const clientBridge = new SocketIoBridge(clientSocket);

      clientBridge.on('connect', () => {
        clientBridge.emit('testSingleArg', {}, (...args: any[]) => {
          console.log('Client received', args.length, 'arguments:', args);
          expect(args.length).toBe(1);
          expect(args[0]).toBe(true);
          clientSocket.disconnect();
          resolve();
        });
      });
    });
  });
});
