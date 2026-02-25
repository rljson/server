// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { FileLogger } from '../src/file-logger';

// .............................................................................
describe('FileLogger', () => {
  let testDir: string;
  let logFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `file-logger-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    logFile = join(testDir, 'test.log');
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ...........................................................................
  /** Read all lines from the log file as parsed JSON objects. */
  function readLines(): Record<string, unknown>[] {
    const content = readFileSync(logFile, 'utf-8').trim();
    return content.split('\n').map((line) => JSON.parse(line));
  }

  // ...........................................................................
  describe('constructor', () => {
    it('should create parent directories if they do not exist', () => {
      const nestedPath = join(testDir, 'a', 'b', 'c', 'deep.log');
      const logger = new FileLogger({ filePath: nestedPath });
      logger.info('Test', 'hello');
      expect(existsSync(nestedPath)).toBe(true);
    });

    it('should expose filePath and echo getters', () => {
      const logger = new FileLogger({ filePath: logFile, echo: true });
      expect(logger.filePath).toBe(logFile);
      expect(logger.echo).toBe(true);
    });

    it('should default echo to false', () => {
      const logger = new FileLogger({ filePath: logFile });
      expect(logger.echo).toBe(false);
    });
  });

  // ...........................................................................
  describe('info()', () => {
    it('should write a JSON line with level info', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.info('Server', 'initialized', { port: 3000 });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!['level']).toBe('info');
      expect(lines[0]!['source']).toBe('Server');
      expect(lines[0]!['message']).toBe('initialized');
      expect(lines[0]!['data']).toEqual({ port: 3000 });
      expect(lines[0]!['ts']).toBeDefined();
    });

    it('should write without data when not provided', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.info('Server', 'ready');

      const lines = readLines();
      expect(lines[0]!['data']).toBeUndefined();
    });

    it('should echo to console.log when echo is true', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      logger.info('Server', 'initialized', { port: 3000 });

      expect(spy).toHaveBeenCalledWith(
        '[INFO] [Server] initialized {"port":3000}',
      );
      spy.mockRestore();
    });

    it('should echo to console.log without data', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      logger.info('Server', 'ready');

      expect(spy).toHaveBeenCalledWith('[INFO] [Server] ready');
      spy.mockRestore();
    });

    it('should not echo to console when echo is false', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile });
      logger.info('Server', 'msg');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ...........................................................................
  describe('warn()', () => {
    it('should write a JSON line with level warn', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.warn('Client', 'duplicate ref', { ref: 'abc' });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!['level']).toBe('warn');
      expect(lines[0]!['source']).toBe('Client');
      expect(lines[0]!['message']).toBe('duplicate ref');
      expect(lines[0]!['data']).toEqual({ ref: 'abc' });
    });

    it('should write without data when not provided', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.warn('Client', 'something');

      const lines = readLines();
      expect(lines[0]!['data']).toBeUndefined();
    });

    it('should echo to console.warn when echo is true', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      logger.warn('Client', 'dup ref', { ref: 'x' });

      expect(spy).toHaveBeenCalledWith('[WARN] [Client] dup ref {"ref":"x"}');
      spy.mockRestore();
    });

    it('should echo to console.warn without data', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      logger.warn('Client', 'something');

      expect(spy).toHaveBeenCalledWith('[WARN] [Client] something');
      spy.mockRestore();
    });

    it('should not echo to console when echo is false', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile });
      logger.warn('Client', 'msg');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ...........................................................................
  describe('error()', () => {
    it('should write a JSON line with level error and error details', () => {
      const logger = new FileLogger({ filePath: logFile });
      const err = new Error('boom');
      logger.error('Server', 'crash', err, { step: 'io' });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!['level']).toBe('error');
      expect(lines[0]!['source']).toBe('Server');
      expect(lines[0]!['message']).toBe('crash');
      const errObj = lines[0]!['error'] as Record<string, unknown>;
      expect(errObj['name']).toBe('Error');
      expect(errObj['message']).toBe('boom');
      expect(errObj['stack']).toBeDefined();
      expect(lines[0]!['data']).toEqual({ step: 'io' });
    });

    it('should write without error or data when not provided', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.error('Server', 'fail');

      const lines = readLines();
      expect(lines[0]!['error']).toBeUndefined();
      expect(lines[0]!['data']).toBeUndefined();
    });

    it('should stringify non-Error error values', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.error('Server', 'fail', 'string-error');

      const lines = readLines();
      expect(lines[0]!['error']).toBe('string-error');
    });

    it('should echo to console.error when echo is true', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      const err = new Error('boom');
      logger.error('Server', 'crash', err, { step: 'io' });

      expect(spy).toHaveBeenCalledWith(
        `[ERROR] [Server] crash ${err} {"step":"io"}`,
      );
      spy.mockRestore();
    });

    it('should echo error without error or data', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });
      logger.error('Server', 'fail');

      expect(spy).toHaveBeenCalledWith('[ERROR] [Server] fail');
      spy.mockRestore();
    });

    it('should not echo to console when echo is false', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile });
      logger.error('Server', 'msg');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ...........................................................................
  describe('traffic()', () => {
    it('should write a JSON line with level traffic and direction', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.traffic('in', 'Server.Multicast', '/route', { ref: 'abc' });

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!['level']).toBe('traffic');
      expect(lines[0]!['direction']).toBe('in');
      expect(lines[0]!['source']).toBe('Server.Multicast');
      expect(lines[0]!['event']).toBe('/route');
      expect(lines[0]!['data']).toEqual({ ref: 'abc' });
    });

    it('should write without data when not provided', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.traffic('out', 'Client', '/route');

      const lines = readLines();
      expect(lines[0]!['data']).toBeUndefined();
    });

    it('should echo to console.log with direction arrow when echo is true', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile, echo: true });

      logger.traffic('in', 'Server', '/route', { ref: 'abc' });
      expect(spy).toHaveBeenCalledWith(
        '[TRAFFIC] ⬅ [Server] /route {"ref":"abc"}',
      );

      logger.traffic('out', 'Server', '/route');
      expect(spy).toHaveBeenCalledWith('[TRAFFIC] ➡ [Server] /route');

      spy.mockRestore();
    });

    it('should not echo to console when echo is false', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = new FileLogger({ filePath: logFile });
      logger.traffic('in', 'Server', '/route');

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // ...........................................................................
  describe('multiple entries', () => {
    it('should append multiple lines to the same file', () => {
      const logger = new FileLogger({ filePath: logFile });
      logger.info('A', 'one');
      logger.warn('B', 'two');
      logger.error('C', 'three');
      logger.traffic('in', 'D', 'four');

      const lines = readLines();
      expect(lines).toHaveLength(4);
      expect(lines[0]!['level']).toBe('info');
      expect(lines[1]!['level']).toBe('warn');
      expect(lines[2]!['level']).toBe('error');
      expect(lines[3]!['level']).toBe('traffic');
    });
  });

  // ...........................................................................
  describe('integration with FilteredLogger', () => {
    it('should work as inner logger for FilteredLogger', async () => {
      const { FilteredLogger } = await import('../src/logger');
      const fileLogger = new FileLogger({ filePath: logFile });
      const filtered = new FilteredLogger(fileLogger, {
        levels: ['error'],
      });

      filtered.info('A', 'skipped');
      filtered.error('B', 'kept');

      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]!['level']).toBe('error');
    });
  });
});
