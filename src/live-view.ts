// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

/**
 * A stable object over a moving target.
 *
 * A `Server` replaces its multis whenever a client joins or leaves, so anything
 * that captured `server.io` holds a snapshot that is wrong from the next
 * connection onwards. Handing out a view instead means the holder keeps one
 * object forever and every call reaches whatever the server has NOW.
 *
 * Measured: a cloud bridge captured the hub's store at start-up and served the
 * cloud from the hub as it was before its own clients connected — answering
 * "no such row" for everything those clients held. A file that had crossed the
 * EventHub could not be fetched from the hub that announced it.
 *
 * Methods are bound to the current target, so the delegate's own private state
 * is reached correctly rather than being read off the proxy. Only `get` is
 * trapped: a store is used through its methods, and traps for `in` or
 * `instanceof` would be code no caller exercises.
 * @param current - Supplies the target for each access.
 * @returns A view that always delegates to `current()`.
 */
export const liveView = <T extends object>(current: () => T): T =>
  new Proxy({} as T, {
    get(_unused, property): unknown {
      const target = current();
      const value = (target as unknown as Record<string | symbol, unknown>)[
        property
      ];
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
