// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ServerLogger } from './logger.ts';

// .............................................................................
/**
 * Options for creating a FileLogger.
 */
export interface FileLoggerOptions {
  /**
   * Absolute path to the log file.
   * Parent directories are created automatically if they don't exist.
   */
  filePath: string;

  /**
   * When `true`, log entries are also written to console
   * (info/traffic → console.log, warn → console.warn, error → console.error).
   * Defaults to `false`.
   */
  echo?: boolean;
}

// .............................................................................
/**
 * Appends log entries to a file. Optionally echoes to console.
 *
 * Each line is a self-contained JSON object for easy parsing:
 * ```
 * {"ts":"2026-02-25T12:00:00.000Z","level":"info","source":"Server","message":"initialized","data":{"port":3000}}
 * ```
 *
 * Parent directories are created on construction if they don't exist.
 * Uses synchronous writes (`appendFileSync`) to guarantee ordering
 * and avoid lost entries on crash.
 */
export class FileLogger implements ServerLogger {
  private readonly _filePath: string;
  private readonly _echo: boolean;

  constructor(options: FileLoggerOptions) {
    this._filePath = options.filePath;
    this._echo = options.echo ?? false;

    // Ensure parent directory exists
    const dir = dirname(this._filePath);
    /* v8 ignore if -- @preserve */
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** The file path this logger writes to. */
  get filePath(): string {
    return this._filePath;
  }

  /** Whether console echo is enabled. */
  get echo(): boolean {
    return this._echo;
  }

  info(source: string, message: string, data?: Record<string, unknown>): void {
    const entry = this._entry('info', source, message, data);
    this._write(entry);
    if (this._echo) {
      console.log(this._format('INFO', source, message, data));
    }
  }

  warn(source: string, message: string, data?: Record<string, unknown>): void {
    const entry = this._entry('warn', source, message, data);
    this._write(entry);
    if (this._echo) {
      console.warn(this._format('WARN', source, message, data));
    }
  }

  error(
    source: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: 'error',
      source,
      message,
    };
    if (error !== undefined) {
      entry['error'] =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error);
    }
    if (data !== undefined) {
      entry['data'] = data;
    }
    this._write(entry);
    if (this._echo) {
      const errStr = error ? ` ${error}` : '';
      const dataStr = data ? ' ' + JSON.stringify(data) : '';
      console.error(`[ERROR] [${source}] ${message}${errStr}${dataStr}`);
    }
  }

  traffic(
    direction: 'in' | 'out',
    source: string,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: 'traffic',
      direction,
      source,
      event,
    };
    if (data !== undefined) {
      entry['data'] = data;
    }
    this._write(entry);
    if (this._echo) {
      const arrow = direction === 'in' ? '⬅' : '➡';
      const dataStr = data ? ' ' + JSON.stringify(data) : '';
      console.log(`[TRAFFIC] ${arrow} [${source}] ${event}${dataStr}`);
    }
  }

  // ...........................................................................
  /**
   * Build a standard log entry object.
   * @param level - Log level string
   * @param source - Component identifier
   * @param message - Human-readable message
   * @param data - Optional structured context
   */
  private _entry(
    level: string,
    source: string,
    message: string,
    data?: Record<string, unknown>,
  ): Record<string, unknown> {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      source,
      message,
    };
    if (data !== undefined) {
      entry['data'] = data;
    }
    return entry;
  }

  /**
   * Append a JSON line to the log file.
   * @param entry - The log entry object to serialize
   */
  private _write(entry: Record<string, unknown>): void {
    appendFileSync(this._filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  /**
   * Format a human-readable console line.
   * @param level - Display level label (e.g. 'INFO')
   * @param source - Component identifier
   * @param message - Human-readable message
   * @param data - Optional structured context
   */
  private _format(
    level: string,
    source: string,
    message: string,
    data?: Record<string, unknown>,
  ): string {
    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    return `[${level}] [${source}] ${message}${dataStr}`;
  }
}
