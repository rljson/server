// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';

import { describe, expect, it, vi } from 'vitest';

import {
  connectorDuplexSocket,
  normalizeSocketBundle,
} from '../src/socket-bundle.ts';

/** Builds a minimal spyable Socket for assertions. */
const makeSocket = (connected: boolean): Socket => ({
  connected,
  disconnected: !connected,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(function (this: Socket) {
    return this;
  }),
  emit: vi.fn().mockReturnValue(true),
  off: vi.fn(function (this: Socket) {
    return this;
  }),
  removeAllListeners: vi.fn(function (this: Socket) {
    return this;
  }),
});

describe('normalizeSocketBundle', () => {
  it('returns a pre-split bundle as-is', () => {
    const bundle = {
      ioUp: makeSocket(true),
      ioDown: makeSocket(true),
      bsUp: makeSocket(true),
      bsDown: makeSocket(true),
    };
    expect(normalizeSocketBundle(bundle)).toBe(bundle);
  });

  it('reuses a single socket for all four channels', () => {
    const single = makeSocket(true);
    const bundle = normalizeSocketBundle(single);
    expect(bundle.ioUp).toBe(single);
    expect(bundle.ioDown).toBe(single);
    expect(bundle.bsUp).toBe(single);
    expect(bundle.bsDown).toBe(single);
  });
});

describe('connectorDuplexSocket', () => {
  it('returns the socket unchanged when up and down are identical', () => {
    const single = makeSocket(true);
    expect(connectorDuplexSocket(single, single)).toBe(single);
  });

  describe('with split up/down channels', () => {
    it('emits upstream and returns the upstream result', () => {
      const up = makeSocket(true);
      const down = makeSocket(true);
      const duplex = connectorDuplexSocket(up, down);

      const result = duplex.emit('evt', { a: 1 });

      expect(up.emit).toHaveBeenCalledWith('evt', { a: 1 });
      expect(down.emit).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('listens downstream and returns the duplex', () => {
      const up = makeSocket(true);
      const down = makeSocket(true);
      const duplex = connectorDuplexSocket(up, down);
      const listener = vi.fn();

      const returned = duplex.on('evt', listener);

      expect(down.on).toHaveBeenCalledWith('evt', listener);
      expect(up.on).not.toHaveBeenCalled();
      expect(returned).toBe(duplex);
    });

    it('removes a single listener downstream and returns the duplex', () => {
      const up = makeSocket(true);
      const down = makeSocket(true);
      const duplex = connectorDuplexSocket(up, down);
      const listener = vi.fn();

      const returned = duplex.off('evt', listener);

      expect(down.off).toHaveBeenCalledWith('evt', listener);
      expect(up.off).not.toHaveBeenCalled();
      expect(returned).toBe(duplex);
    });

    it('removes all listeners downstream and returns the duplex', () => {
      const up = makeSocket(true);
      const down = makeSocket(true);
      const duplex = connectorDuplexSocket(up, down);

      const returned = duplex.removeAllListeners('evt');

      expect(down.removeAllListeners).toHaveBeenCalledWith('evt');
      expect(up.removeAllListeners).not.toHaveBeenCalled();
      expect(returned).toBe(duplex);
    });

    it('connects and disconnects upstream', () => {
      const up = makeSocket(true);
      const down = makeSocket(true);
      const duplex = connectorDuplexSocket(up, down);

      duplex.connect();
      duplex.disconnect();

      expect(up.connect).toHaveBeenCalledOnce();
      expect(up.disconnect).toHaveBeenCalledOnce();
      expect(down.connect).not.toHaveBeenCalled();
      expect(down.disconnect).not.toHaveBeenCalled();
    });

    it('reflects the upstream connection state', () => {
      const up = makeSocket(true);
      const down = makeSocket(false);
      const duplex = connectorDuplexSocket(up, down);

      expect(duplex.connected).toBe(true);
      expect(duplex.disconnected).toBe(false);
    });
  });
});
