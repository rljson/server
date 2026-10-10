// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { isRefStamp, RefStamp } from '@rljson/rljson';

import { readFileSync, writeFileSync } from 'node:fs';

// .............................................................................
/** How a {@link Server} stamps the refs it relays. */
export interface StampOptions {
  /** The network domain this hub serves. */
  domain: string;

  /** This hub's node id. Keeps two hubs in one epoch distinct and ordered. */
  hub: string;

  /**
   * Where the hub keeps the epoch it holds, so a restart takes the next one.
   *
   * Outside any store that is wiped at start. Without it, a restarted hub
   * begins again at `minEpoch + 1`.
   */
  stateFile?: string;

  /**
   * The highest epoch this node saw as a client. A node taking office as hub
   * continues above it, so its stamps order after every stamp it has heard.
   */
  minEpoch?: number;
}

/** How many refs a stamper remembers the stamp of. */
export const REF_STAMPER_MEMORY = 10_000;

// .............................................................................
/**
 * Gives each ref a hub relays its {@link RefStamp}, and only one.
 *
 * - A ref that arrives carrying a stamp keeps it: a stamp is set by the first
 *   hub that relays a ref, never replaced by a later one.
 * - A ref relayed again keeps the stamp it got, while it is remembered.
 * - A new ref gets `(domain, epoch, hub, n + 1)`.
 *
 * The epoch is taken on construction — one more than the higher of the
 * persisted epoch and `minEpoch` — and persisted. A carried stamp of this
 * domain from a later epoch moves this hub above it, so the stamps it gives
 * always order after every stamp it has relayed.
 */
export class RefStamper {
  private _epoch: number;
  private _n = 0;
  private readonly _known = new Map<string, RefStamp>();

  constructor(private readonly _options: StampOptions) {
    this._epoch =
      Math.max(this._persistedEpoch(), _options.minEpoch ?? 0) + 1;
    this._persist();
  }

  /** The epoch this hub stamps in. */
  get epoch(): number {
    return this._epoch;
  }

  // ...........................................................................
  /**
   * The stamp a relayed ref goes out with.
   * @param ref - The ref being relayed
   * @param carried - The stamp its payload carried, if any
   * @returns The carried stamp, the one the ref already got, or a new one
   */
  stampFor(ref: string, carried?: unknown): RefStamp {
    if (isRefStamp(carried)) {
      this._observe(carried);
      this._remember(ref, carried);
      return carried;
    }

    const known = this._known.get(ref);
    if (known) return known;

    const stamp: RefStamp = {
      domain: this._options.domain,
      epoch: this._epoch,
      hub: this._options.hub,
      n: ++this._n,
    };
    this._remember(ref, stamp);
    return stamp;
  }

  // ...........................................................................
  /**
   * The stamp a ref was relayed with, while it is remembered.
   * @param ref - The ref
   * @returns Its stamp, or `undefined`
   */
  stampOf(ref: string): RefStamp | undefined {
    return this._known.get(ref);
  }

  // ...........................................................................
  private _observe(stamp: RefStamp): void {
    if (stamp.domain !== this._options.domain) return;
    if (stamp.epoch < this._epoch) return;
    this._epoch = stamp.epoch + 1;
    this._n = 0;
    this._persist();
  }

  private _remember(ref: string, stamp: RefStamp): void {
    this._known.delete(ref);
    this._known.set(ref, stamp);
    if (this._known.size > REF_STAMPER_MEMORY) {
      this._known.delete(this._known.keys().next().value as string);
    }
  }

  private _persistedEpoch(): number {
    const file = this._options.stateFile;
    if (!file) return 0;
    try {
      const epoch = (JSON.parse(readFileSync(file, 'utf-8')) as { epoch?: unknown })
        .epoch;
      return Number.isSafeInteger(epoch) && (epoch as number) > 0
        ? (epoch as number)
        : 0;
    } catch {
      return 0;
    }
  }

  private _persist(): void {
    const file = this._options.stateFile;
    if (!file) return;
    writeFileSync(file, JSON.stringify({ epoch: this._epoch }), 'utf-8');
  }
}
