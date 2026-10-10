// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { RefStamp } from '@rljson/rljson';

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REF_STAMPER_MEMORY, RefStamper } from '../src/ref-stamper';

const stateFile = (content?: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'ref-stamper-')), 'stamp.json');
  if (content !== undefined) writeFileSync(file, content, 'utf-8');
  return file;
};

const persisted = (file: string): unknown =>
  JSON.parse(readFileSync(file, 'utf-8'));

describe('RefStamper', () => {
  it('stamps new refs in order, in epoch 1 when nothing came before', () => {
    const stamper = new RefStamper({ domain: 'office', hub: 'hub-a' });
    expect(stamper.stampFor('r1')).toEqual({
      domain: 'office',
      epoch: 1,
      hub: 'hub-a',
      n: 1,
    });
    expect(stamper.stampFor('r2').n).toBe(2);
  });

  it('gives a ref relayed again the stamp it already got', () => {
    const stamper = new RefStamper({ domain: 'office', hub: 'hub-a' });
    const first = stamper.stampFor('r1');
    stamper.stampFor('r2');
    expect(stamper.stampFor('r1')).toEqual(first);
    expect(stamper.stampOf('r1')).toEqual(first);
    expect(stamper.stampOf('unknown')).toBeUndefined();
  });

  it('keeps a carried stamp and never replaces it', () => {
    const stamper = new RefStamper({ domain: 'office', hub: 'hub-b' });
    const carried: RefStamp = { domain: 'office', epoch: 0, hub: 'hub-a', n: 9 };
    expect(stamper.stampFor('r1', carried)).toEqual(carried);
    expect(stamper.stampFor('r1')).toEqual(carried);
    expect(stamper.stampFor('r2').n).toBe(1);
  });

  it('mints its own stamp when the carried one is malformed', () => {
    const stamper = new RefStamper({ domain: 'office', hub: 'hub-a' });
    expect(stamper.stampFor('r1', { domain: 'office' }).hub).toBe('hub-a');
  });

  it('forgets the oldest ref beyond its memory', () => {
    const stamper = new RefStamper({ domain: 'office', hub: 'hub-a' });
    for (let i = 0; i <= REF_STAMPER_MEMORY; i++) stamper.stampFor(`r${i}`);
    expect(stamper.stampOf('r0')).toBeUndefined();
    expect(stamper.stampOf('r1')?.n).toBe(2);
  });

  describe('the epoch', () => {
    it('continues above minEpoch', () => {
      const stamper = new RefStamper({
        domain: 'office',
        hub: 'hub-a',
        minEpoch: 4,
      });
      expect(stamper.epoch).toBe(5);
    });

    it('takes the next epoch after a restart, from the state file', () => {
      const file = stateFile();
      expect(new RefStamper({ domain: 'd', hub: 'h', stateFile: file }).epoch).toBe(1);
      expect(persisted(file)).toEqual({ epoch: 1 });
      const restarted = new RefStamper({ domain: 'd', hub: 'h', stateFile: file });
      expect(restarted.epoch).toBe(2);
      expect(persisted(file)).toEqual({ epoch: 2 });
    });

    it('takes the higher of the state file and minEpoch', () => {
      const file = stateFile(JSON.stringify({ epoch: 7 }));
      expect(
        new RefStamper({ domain: 'd', hub: 'h', stateFile: file, minEpoch: 3 })
          .epoch,
      ).toBe(8);
      expect(
        new RefStamper({ domain: 'd', hub: 'h', stateFile: file, minEpoch: 20 })
          .epoch,
      ).toBe(21);
    });

    it('reads an unreadable or malformed state file as no epoch', () => {
      for (const content of ['not json', '{"epoch":-2}', '{"epoch":"3"}', '{}']) {
        const file = stateFile(content);
        expect(new RefStamper({ domain: 'd', hub: 'h', stateFile: file }).epoch).toBe(1);
      }
    });

    it('fails loudly when the state file cannot be written', () => {
      const file = join(tmpdir(), 'no-such-dir-for-ref-stamper', 'x', 'stamp.json');
      expect(() => new RefStamper({ domain: 'd', hub: 'h', stateFile: file })).toThrow();
    });

    it('moves above a carried stamp of its domain from a later epoch', () => {
      const file = stateFile();
      const stamper = new RefStamper({ domain: 'office', hub: 'hub-b', stateFile: file });
      stamper.stampFor('mine');
      stamper.stampFor('r1', { domain: 'office', epoch: 6, hub: 'hub-a', n: 3 });

      expect(stamper.epoch).toBe(7);
      expect(stamper.stampFor('r2')).toEqual({
        domain: 'office',
        epoch: 7,
        hub: 'hub-b',
        n: 1,
      });
      expect(persisted(file)).toEqual({ epoch: 7 });
    });

    it('stays where it is for an older epoch or another domain', () => {
      const stamper = new RefStamper({ domain: 'office', hub: 'hub-b', minEpoch: 4 });
      stamper.stampFor('r1', { domain: 'office', epoch: 2, hub: 'hub-a', n: 1 });
      stamper.stampFor('r2', { domain: 'zoo', epoch: 99, hub: 'hub-z', n: 1 });
      expect(stamper.epoch).toBe(5);
    });
  });
});
