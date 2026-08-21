// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { Route } from '@rljson/rljson';

import { describe, expect, it, vi } from 'vitest';

import { Client } from '../src/client';
import {
  BufferedLogger,
  ConsoleLogger,
  FilteredLogger,
  NoopLogger,
  noopLogger,
} from '../src/logger';
import { Server } from '../src/server';

// .............................................................................
describe('Logger implementations', () => {
  // .........................................................................
  describe('NoopLogger', () => {
    it('should have no side effects', () => {
      const logger = new NoopLogger();
      // Just verify they don't throw
      logger.info('src', 'msg');
      logger.warn('src', 'msg');
      logger.error('src', 'msg', new Error('test'));
      logger.traffic('in', 'src', 'event');
    });

    it('should provide a shared noopLogger singleton', () => {
      expect(noopLogger).toBeInstanceOf(NoopLogger);
    });
  });

  // .........................................................................
  describe('ConsoleLogger', () => {
    it('should log info to console.log', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.info('Server', 'initialized', { port: 3000 });
      expect(spy).toHaveBeenCalledWith(
        '[INFO] [Server] initialized {"port":3000}',
      );
      spy.mockRestore();
    });

    it('should log info without data', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.info('Server', 'ready');
      expect(spy).toHaveBeenCalledWith('[INFO] [Server] ready');
      spy.mockRestore();
    });

    it('should log warn to console.warn', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.warn('Server', 'duplicate ref', { ref: 'abc' });
      expect(spy).toHaveBeenCalledWith(
        '[WARN] [Server] duplicate ref {"ref":"abc"}',
      );
      spy.mockRestore();
    });

    it('should log warn without data', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.warn('Server', 'something');
      expect(spy).toHaveBeenCalledWith('[WARN] [Server] something');
      spy.mockRestore();
    });

    it('should log error to console.error', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const err = new Error('fail');
      logger.error('Client', 'init failed', err, { step: 'io' });
      expect(spy).toHaveBeenCalledWith(
        `[ERROR] [Client] init failed ${err} {"step":"io"}`,
      );
      spy.mockRestore();
    });

    it('should log error without error or data', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      logger.error('Client', 'init failed');
      expect(spy).toHaveBeenCalledWith('[ERROR] [Client] init failed');
      spy.mockRestore();
    });

    it('should log traffic with direction arrows', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.traffic('in', 'Server', '/route', { ref: 'abc' });
      expect(spy).toHaveBeenCalledWith(
        '[TRAFFIC] ⬅ [Server] /route {"ref":"abc"}',
      );

      logger.traffic('out', 'Server', '/route', { ref: 'abc' });
      expect(spy).toHaveBeenCalledWith(
        '[TRAFFIC] ➡ [Server] /route {"ref":"abc"}',
      );

      spy.mockRestore();
    });

    it('should log traffic without data', () => {
      const logger = new ConsoleLogger();
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logger.traffic('in', 'Server', '/route');
      expect(spy).toHaveBeenCalledWith('[TRAFFIC] ⬅ [Server] /route');
      spy.mockRestore();
    });
  });

  // .........................................................................
  describe('BufferedLogger', () => {
    it('should buffer info entries', () => {
      const logger = new BufferedLogger();
      logger.info('Server', 'initialized', { port: 3000 });
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]!.level).toBe('info');
      expect(logger.entries[0]!.source).toBe('Server');
      expect(logger.entries[0]!.message).toBe('initialized');
      expect(logger.entries[0]!.data).toEqual({ port: 3000 });
      expect(logger.entries[0]!.timestamp).toBeGreaterThan(0);
    });

    it('should buffer warn entries', () => {
      const logger = new BufferedLogger();
      logger.warn('Server', 'dup ref', { ref: 'x' });
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]!.level).toBe('warn');
    });

    it('should buffer error entries with error object', () => {
      const logger = new BufferedLogger();
      const err = new Error('boom');
      logger.error('Client', 'crash', err, { step: 'io' });
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]!.level).toBe('error');
      expect(logger.entries[0]!.error).toBe(err);
      expect(logger.entries[0]!.data).toEqual({ step: 'io' });
    });

    it('should buffer traffic entries with direction and event', () => {
      const logger = new BufferedLogger();
      logger.traffic('in', 'Server.Multicast', '/route', { ref: 'abc' });
      expect(logger.entries).toHaveLength(1);
      expect(logger.entries[0]!.level).toBe('traffic');
      expect(logger.entries[0]!.direction).toBe('in');
      expect(logger.entries[0]!.event).toBe('/route');
      expect(logger.entries[0]!.source).toBe('Server.Multicast');
    });

    it('should filter by level with byLevel()', () => {
      const logger = new BufferedLogger();
      logger.info('A', 'info1');
      logger.warn('B', 'warn1');
      logger.info('C', 'info2');
      logger.error('D', 'error1');
      logger.traffic('in', 'E', 'event1');

      expect(logger.byLevel('info')).toHaveLength(2);
      expect(logger.byLevel('warn')).toHaveLength(1);
      expect(logger.byLevel('error')).toHaveLength(1);
      expect(logger.byLevel('traffic')).toHaveLength(1);
    });

    it('should filter by source with bySource()', () => {
      const logger = new BufferedLogger();
      logger.info('Server', 'msg1');
      logger.info('Server.Io', 'msg2');
      logger.info('Client.Io', 'msg3');
      logger.info('Client.Bs', 'msg4');

      expect(logger.bySource('Server')).toHaveLength(2);
      expect(logger.bySource('Client')).toHaveLength(2);
      expect(logger.bySource('Io')).toHaveLength(2);
    });

    it('should clear all entries with clear()', () => {
      const logger = new BufferedLogger();
      logger.info('A', 'msg1');
      logger.warn('B', 'msg2');
      expect(logger.entries).toHaveLength(2);

      logger.clear();
      expect(logger.entries).toHaveLength(0);
    });
  });

  // .........................................................................
  describe('FilteredLogger', () => {
    it('should filter by levels', () => {
      const inner = new BufferedLogger();
      const filtered = new FilteredLogger(inner, {
        levels: ['error', 'warn'],
      });

      filtered.info('A', 'info msg');
      filtered.warn('B', 'warn msg');
      filtered.error('C', 'error msg');
      filtered.traffic('in', 'D', 'event');

      expect(inner.entries).toHaveLength(2);
      expect(inner.entries[0]!.level).toBe('warn');
      expect(inner.entries[1]!.level).toBe('error');
    });

    it('should filter by sources', () => {
      const inner = new BufferedLogger();
      const filtered = new FilteredLogger(inner, {
        sources: ['Server'],
      });

      filtered.info('Server', 'msg1');
      filtered.info('Client', 'msg2');
      filtered.warn('Server.Io', 'msg3');
      filtered.error('Client.Bs', 'msg4');
      filtered.traffic('in', 'Server.Multicast', 'event1');

      expect(inner.entries).toHaveLength(3);
      expect(inner.entries.every((e) => e.source.includes('Server'))).toBe(
        true,
      );
    });

    it('should combine level and source filters', () => {
      const inner = new BufferedLogger();
      const filtered = new FilteredLogger(inner, {
        levels: ['error'],
        sources: ['Server'],
      });

      filtered.info('Server', 'info');
      filtered.error('Client', 'client error');
      filtered.error('Server', 'server error');
      filtered.error('Server.Io', 'server io error');

      expect(inner.entries).toHaveLength(2);
      expect(inner.entries[0]!.message).toBe('server error');
      expect(inner.entries[1]!.message).toBe('server io error');
    });

    it('should pass all when no filter is set', () => {
      const inner = new BufferedLogger();
      const filtered = new FilteredLogger(inner);

      filtered.info('A', 'msg');
      filtered.warn('B', 'msg');
      filtered.error('C', 'msg');
      filtered.traffic('in', 'D', 'event');

      expect(inner.entries).toHaveLength(4);
    });

    it('should filter out all levels when none match', () => {
      const inner = new BufferedLogger();
      const filtered = new FilteredLogger(inner, {
        levels: ['error'],
      });

      filtered.info('A', 'info msg');
      filtered.warn('B', 'warn msg');
      filtered.traffic('in', 'C', 'event');

      expect(inner.entries).toHaveLength(0);
    });
  });
});

// .............................................................................
describe('Logger integration', () => {
  // .........................................................................
  describe('Server with logger', () => {
    it('should log lifecycle events when logger is provided', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const route = Route.fromFlat('testLogRoute');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      // Check construction and init logs
      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Constructing server')).toBe(true);
      expect(infos.some((e) => e.message === 'Initializing server')).toBe(true);
      expect(
        infos.some((e) => e.message === 'Server initialized successfully'),
      ).toBe(true);

      // Verify route is in construction data
      const constructEntry = infos.find(
        (e) => e.message === 'Constructing server',
      );
      expect(constructEntry!.data!['route']).toBe('/testLogRoute');
    });

    it('should log addSocket lifecycle', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const route = Route.fromFlat('testAddSocket');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      logger.clear(); // Clear init logs

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Adding client socket')).toBe(
        true,
      );
      expect(
        infos.some((e) => e.message === 'Client socket added successfully'),
      ).toBe(true);
      expect(infos.some((e) => e.message === 'Creating Io peer')).toBe(true);
      expect(infos.some((e) => e.message === 'Creating Bs peer')).toBe(true);
      expect(infos.some((e) => e.message === 'Rebuilding multis')).toBe(true);
      expect(infos.some((e) => e.message === 'Refreshing servers')).toBe(true);
    });

    it('should expose logger via getter', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const server = new Server(Route.fromFlat('test'), io, bs, { logger });
      expect(server.logger).toBe(logger);
    });

    it('should use noopLogger by default', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();

      const server = new Server(Route.fromFlat('test'), io, bs);
      expect(server.logger).toBe(noopLogger);
    });
  });

  // .........................................................................
  describe('Client with logger', () => {
    it('should log lifecycle events when logger is provided', async () => {
      const logger = new BufferedLogger();

      const serverIo = new IoMem();
      await serverIo.init();
      const serverBs = new BsMem();
      const route = Route.fromFlat('testClientLog');

      const server = new Server(route, serverIo, serverBs);
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const clientIo = new IoMem();
      await clientIo.init();
      const clientBs = new BsMem();

      const client = new Client(socket, clientIo, clientBs, undefined, {
        logger,
      });
      await client.init();

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Constructing client')).toBe(true);
      expect(infos.some((e) => e.message === 'Initializing client')).toBe(true);
      expect(
        infos.some((e) => e.message === 'Client initialized successfully'),
      ).toBe(true);
      expect(infos.some((e) => e.message === 'Setting up Io multi')).toBe(true);
      expect(infos.some((e) => e.message === 'Setting up Bs multi')).toBe(true);
      expect(infos.some((e) => e.message === 'Io multi ready')).toBe(true);
      expect(infos.some((e) => e.message === 'Bs multi ready')).toBe(true);

      await client.tearDown();
    });

    it('should log Db/Connector setup when route is provided', async () => {
      const logger = new BufferedLogger();

      const serverIo = new IoMem();
      await serverIo.init();
      const serverBs = new BsMem();
      const route = Route.fromFlat('testRouteLog');

      const server = new Server(route, serverIo, serverBs);
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const clientIo = new IoMem();
      await clientIo.init();
      const clientBs = new BsMem();

      const client = new Client(socket, clientIo, clientBs, route, { logger });
      await client.init();

      const infos = logger.byLevel('info');
      expect(
        infos.some((e) => e.message === 'Setting up Db and Connector'),
      ).toBe(true);
      expect(infos.some((e) => e.message === 'Db and Connector created')).toBe(
        true,
      );

      await client.tearDown();
    });

    it('should log tearDown', async () => {
      const logger = new BufferedLogger();

      const serverIo = new IoMem();
      await serverIo.init();
      const serverBs = new BsMem();

      const server = new Server(
        Route.fromFlat('testTearDown'),
        serverIo,
        serverBs,
      );
      await server.init();

      const socket = new SocketMock();
      socket.connect();
      await server.addSocket(socket);

      const clientIo = new IoMem();
      await clientIo.init();
      const clientBs = new BsMem();

      const client = new Client(socket, clientIo, clientBs, undefined, {
        logger,
      });
      await client.init();

      logger.clear();
      await client.tearDown();

      const infos = logger.byLevel('info');
      expect(infos.some((e) => e.message === 'Tearing down client')).toBe(true);
      expect(
        infos.some((e) => e.message === 'Client torn down successfully'),
      ).toBe(true);
    });

    it('should expose logger via getter', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const socket = new SocketMock();
      socket.connect();

      const client = new Client(socket, io, bs, undefined, { logger });
      expect(client.logger).toBe(logger);
    });

    it('should use noopLogger by default', async () => {
      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const socket = new SocketMock();
      socket.connect();

      const client = new Client(socket, io, bs);
      expect(client.logger).toBe(noopLogger);
    });
  });

  // .........................................................................
  describe('Traffic logging during multicast', () => {
    it('should log traffic in/out when a client emits a ref', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('trafficTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();

      await server.addSocket(socketA);
      await server.addSocket(socketB);

      logger.clear();

      // Client A emits a ref → server should log inbound + outbound traffic
      socketA.emit(route.flat, { r: 'ref-traffic-1' });

      const traffic = logger.byLevel('traffic');
      expect(traffic.length).toBeGreaterThanOrEqual(2);

      // Inbound from client A
      const inbound = traffic.find(
        (e) => e.direction === 'in' && e.data?.['ref'] === 'ref-traffic-1',
      );
      expect(inbound).toBeDefined();
      expect(inbound!.source).toBe('Server.Multicast');
      expect(inbound!.event).toBe(route.flat);

      // Outbound to client B
      const outbound = traffic.find(
        (e) => e.direction === 'out' && e.data?.['ref'] === 'ref-traffic-1',
      );
      expect(outbound).toBeDefined();
      expect(outbound!.source).toBe('Server.Multicast');
      expect(outbound!.data?.['from']).toBeDefined();
      expect(outbound!.data?.['to']).toBeDefined();
      expect(outbound!.data?.['from']).not.toBe(outbound!.data?.['to']);
    });

    it('should log warning when duplicate ref is suppressed', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('dupRefTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();

      await server.addSocket(socketA);
      await server.addSocket(socketB);

      logger.clear();

      // Emit the same ref twice → second should be suppressed
      socketA.emit(route.flat, { r: 'dup-ref' });
      socketA.emit(route.flat, { r: 'dup-ref' });

      const warns = logger.byLevel('warn');
      const dupWarn = warns.find(
        (e) => e.message === 'Duplicate ref suppressed',
      );
      expect(dupWarn).toBeDefined();
      expect(dupWarn!.source).toBe('Server.Multicast');
      expect(dupWarn!.data?.['ref']).toBe('dup-ref');
    });

    it('re-multicasts a ref once a newer one has superseded it', async () => {
      // Refs are content hashes, so a tree returning to an earlier state
      // re-derives that state's exact ref. A client that creates a file and
      // then deletes it does exactly that, and permanent suppression meant its
      // deletion reached no peer at all.
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('supersededRefTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();
      await server.addSocket(socketA);
      await server.addSocket(socketB);

      const received: string[] = [];
      socketB.on(route.flat, (p: { r?: string }) => {
        if (p?.r) received.push(p.r);
      });

      socketA.emit(route.flat, { r: 'state-a' });
      socketA.emit(route.flat, { r: 'state-b' });
      // Returning to state-a: no longer the latest, so it is news again.
      socketA.emit(route.flat, { r: 'state-a' });

      expect(received).toEqual(['state-a', 'state-b', 'state-a']);

      logger.clear();
      // While a ref IS the latest, repeating it is still an echo.
      socketA.emit(route.flat, { r: 'state-a' });
      expect(
        logger.byLevel('warn').find(
          (e) => e.message === 'Duplicate ref suppressed',
        ),
      ).toBeDefined();
    });

    it('should log warning for loop prevention on payload with __origin', async () => {
      const logger = new BufferedLogger();

      const io = new IoMem();
      await io.init();
      const bs = new BsMem();
      const route = Route.fromFlat('loopTest');

      const server = new Server(route, io, bs, { logger });
      await server.init();

      const socketA = new SocketMock();
      const socketB = new SocketMock();
      socketA.connect();
      socketB.connect();

      await server.addSocket(socketA);
      await server.addSocket(socketB);

      logger.clear();

      // Emit a payload with __origin → should trigger loop prevention
      socketA.emit(route.flat, { r: 'loop-ref', __origin: 'external' });

      const warns = logger.byLevel('warn');
      const loopWarn = warns.find(
        (e) => e.message === 'Loop prevention: payload already has origin',
      );
      expect(loopWarn).toBeDefined();
      expect(loopWarn!.source).toBe('Server.Multicast');
      expect(loopWarn!.data?.['ref']).toBe('loop-ref');
      expect(loopWarn!.data?.['origin']).toBe('external');
    });
  });
});
