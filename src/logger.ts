// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * Logger interface for monitoring Client/Server lifecycle, errors,
 * and network traffic. Implementations can be injected via options.
 *
 * Use `NoopLogger` (default) in production for zero overhead.
 * Use `ConsoleLogger` or `BufferedLogger` for development/testing.
 */
export interface ServerLogger {
  /**
   * Informational messages (lifecycle events, state changes).
   * @param source - Component identifier (e.g., 'Server', 'Client.Io')
   * @param message - Human-readable message
   * @param data - Optional structured context
   */
  info(source: string, message: string, data?: Record<string, unknown>): void;

  /**
   * Warning messages (suppressed duplicates, loop prevention).
   * @param source - Component identifier
   * @param message - Human-readable message
   * @param data - Optional structured context
   */
  warn(source: string, message: string, data?: Record<string, unknown>): void;

  /**
   * Error messages (failures during init, multicast, peer creation).
   * @param source - Component identifier
   * @param message - Human-readable message
   * @param error - The caught error or unknown value
   * @param data - Optional structured context
   */
  error(
    source: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void;

  /**
   * Network traffic messages (socket emit/on events).
   * @param direction - 'in' for received, 'out' for sent
   * @param source - Component identifier
   * @param event - Socket event name
   * @param data - Optional structured context (ref, clientId, etc.)
   */
  traffic(
    direction: 'in' | 'out',
    source: string,
    event: string,
    data?: Record<string, unknown>,
  ): void;
}

// .............................................................................
/**
 * No-op logger. All methods are empty. Zero overhead in production.
 * This is the default logger when none is provided.
 */
export class NoopLogger implements ServerLogger {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  info(..._args: Parameters<ServerLogger['info']>): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  warn(..._args: Parameters<ServerLogger['warn']>): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error(..._args: Parameters<ServerLogger['error']>): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  traffic(..._args: Parameters<ServerLogger['traffic']>): void {}
}

// .............................................................................
/**
 * Logs all events to console. Useful for development and debugging.
 */
export class ConsoleLogger implements ServerLogger {
  info(source: string, message: string, data?: Record<string, unknown>): void {
    console.log(`[INFO] [${source}] ${message}`, data ?? '');
  }

  warn(source: string, message: string, data?: Record<string, unknown>): void {
    console.warn(`[WARN] [${source}] ${message}`, data ?? '');
  }

  error(
    source: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    console.error(`[ERROR] [${source}] ${message}`, error ?? '', data ?? '');
  }

  traffic(
    direction: 'in' | 'out',
    source: string,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const arrow = direction === 'in' ? '⬅' : '➡';
    console.log(`[TRAFFIC] ${arrow} [${source}] ${event}`, data ?? '');
  }
}

// .............................................................................
/**
 * Log entry stored by BufferedLogger.
 */
export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'traffic';
  source: string;
  message: string;
  error?: unknown;
  data?: Record<string, unknown>;
  direction?: 'in' | 'out';
  event?: string;
  timestamp: number;
}

/**
 * Stores log entries in memory. Useful for test assertions.
 */
export class BufferedLogger implements ServerLogger {
  readonly entries: LogEntry[] = [];

  info(source: string, message: string, data?: Record<string, unknown>): void {
    this.entries.push({
      level: 'info',
      source,
      message,
      data,
      timestamp: Date.now(),
    });
  }

  warn(source: string, message: string, data?: Record<string, unknown>): void {
    this.entries.push({
      level: 'warn',
      source,
      message,
      data,
      timestamp: Date.now(),
    });
  }

  error(
    source: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    this.entries.push({
      level: 'error',
      source,
      message,
      error,
      data,
      timestamp: Date.now(),
    });
  }

  traffic(
    direction: 'in' | 'out',
    source: string,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    this.entries.push({
      level: 'traffic',
      source,
      message: event,
      direction,
      event,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Returns entries filtered by level.
   * @param level - The log level to filter by
   */
  byLevel(level: LogEntry['level']): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }

  /**
   * Returns entries filtered by source (substring match).
   * @param source - The source substring to match
   */
  bySource(source: string): LogEntry[] {
    return this.entries.filter((e) => e.source.includes(source));
  }

  /**
   * Clears all stored entries.
   */
  clear(): void {
    this.entries.length = 0;
  }
}

// .............................................................................
/**
 * Wraps another logger and filters entries by level and/or source.
 */
export class FilteredLogger implements ServerLogger {
  constructor(
    private _inner: ServerLogger,
    private _filter: {
      levels?: Array<'info' | 'warn' | 'error' | 'traffic'>;
      sources?: string[];
    } = {},
  ) {}

  private _shouldLog(
    level: 'info' | 'warn' | 'error' | 'traffic',
    source: string,
  ): boolean {
    if (this._filter.levels && !this._filter.levels.includes(level)) {
      return false;
    }
    if (
      this._filter.sources &&
      !this._filter.sources.some((s) => source.includes(s))
    ) {
      return false;
    }
    return true;
  }

  info(source: string, message: string, data?: Record<string, unknown>): void {
    if (this._shouldLog('info', source)) {
      this._inner.info(source, message, data);
    }
  }

  warn(source: string, message: string, data?: Record<string, unknown>): void {
    if (this._shouldLog('warn', source)) {
      this._inner.warn(source, message, data);
    }
  }

  error(
    source: string,
    message: string,
    error?: unknown,
    data?: Record<string, unknown>,
  ): void {
    if (this._shouldLog('error', source)) {
      this._inner.error(source, message, error, data);
    }
  }

  traffic(
    direction: 'in' | 'out',
    source: string,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    if (this._shouldLog('traffic', source)) {
      this._inner.traffic(direction, source, event, data);
    }
  }
}

/** Shared no-op instance to avoid repeated allocations. */
export const noopLogger: ServerLogger = new NoopLogger();
