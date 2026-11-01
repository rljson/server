// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, BsPeer } from '@rljson/bs';
import { IoMem, IoPeer } from '@rljson/io';
import { exampleTableCfg } from '@rljson/rljson';

import { fork } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelSocket,
  createChannelPair,
  MessageChannelLike,
} from '../src/channel-socket.ts';
import { PeerReadServer } from '../src/peer-read-server.ts';

// .............................................................................
// A Socket over a message channel: the request/acknowledge protocol of
// IoPeer/IoServer and BsPeer/BsServer between two processes.
// .............................................................................

/** Both ends of one socket over a fresh channel pair, connected. */
const socketPair = (tag = 'test') => {
  const [left, right] = createChannelPair();
  const a = new ChannelSocket(left, tag);
  const b = new ChannelSocket(right, tag);
  a.connect();
  b.connect();
  return { a, b, left, right };
};

/** Waits until queued channel messages are delivered. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('ChannelSocket', () => {
  // ...........................................................................
  describe('connecting', () => {
    it('reports connect, and disconnect on both ends when one end leaves', async () => {
      const [left, right] = createChannelPair();
      const a = new ChannelSocket(left, 't');
      const b = new ChannelSocket(right, 't');
      const events: string[] = [];
      a.on('connect', () => events.push('a connect'));
      a.on('disconnect', () => events.push('a disconnect'));
      b.on('disconnect', () => events.push('b disconnect'));

      expect(a.connected).toBe(false);
      a.connect();
      a.connect();
      b.connect();
      expect([a.connected, a.disconnected]).toEqual([true, false]);

      a.disconnect();
      a.disconnect();
      await settle();

      expect(events).toEqual(['a connect', 'a disconnect', 'b disconnect']);
      expect([b.connected, b.disconnected]).toEqual([false, true]);
    });

    it('sends nothing while disconnected', () => {
      const [left] = createChannelPair();
      const send = vi.spyOn(left, 'send');
      const a = new ChannelSocket(left, 't');

      expect(a.emit('anything', 1)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ...........................................................................
  describe('events', () => {
    it('delivers an event with its arguments', async () => {
      const { a, b } = socketPair();
      const got = vi.fn();
      b.on('hello', got);

      expect(a.emit('hello', 'world', { n: 1 })).toBe(true);
      await settle();

      expect(got).toHaveBeenCalledWith('world', { n: 1 });
    });

    it('acknowledges an event sent with a callback', async () => {
      const { a, b } = socketPair();
      b.on('double', (n: number, ack: (r: number) => void) => ack(n * 2));

      const answer = await new Promise((resolve) => a.emit('double', 21, resolve));

      expect(answer).toBe(42);
    });

    it('turns Uint8Arrays back into Buffers, nested ones too', async () => {
      const { a, b } = socketPair();
      b.on('blob', (ack: (...r: unknown[]) => void) =>
        ack(null, {
          content: Buffer.from('abc'),
          list: [new Uint8Array([1, 2])],
          when: new Date(0),
        }),
      );

      const [error, answer] = await new Promise<unknown[]>((resolve) =>
        a.emit('blob', (...r: unknown[]) => resolve(r)),
      );

      const { content, list, when } = answer as {
        content: Buffer;
        list: Buffer[];
        when: Date;
      };
      expect(error).toBeNull();
      expect(Buffer.isBuffer(content)).toBe(true);
      expect(content.toString()).toBe('abc');
      expect(Buffer.isBuffer(list[0])).toBe(true);
      expect([...list[0]]).toEqual([1, 2]);
      expect(when).toEqual(new Date(0));
    });

    it('takes an event without arguments from a hand-written end', async () => {
      const { a, right } = socketPair();
      const got = vi.fn();
      a.on('bare', got);

      right.send({ __rljsonSocket: 'test', kind: 'event', event: 'bare' });
      await settle();

      expect(got).toHaveBeenCalledWith();
    });

    it('sends no acknowledgement once it has disconnected', async () => {
      const { a, b, right } = socketPair();
      let ack: (answer: string) => void = () => undefined;
      b.on('later', (callback: (answer: string) => void) => (ack = callback));
      const answered = vi.fn();
      a.emit('later', answered);
      await settle();
      const send = vi.spyOn(right, 'send');

      b.disconnect();
      send.mockClear();
      ack('too late');
      await settle();

      expect(send).not.toHaveBeenCalled();
      expect(answered).not.toHaveBeenCalled();
    });

    it('keeps sockets with different tags apart on one channel', async () => {
      const [left, right] = createChannelPair();
      const a1 = new ChannelSocket(left, 'one');
      const a2 = new ChannelSocket(left, 'two');
      const b1 = new ChannelSocket(right, 'one');
      const b2 = new ChannelSocket(right, 'two');
      for (const s of [a1, a2, b1, b2]) s.connect();
      const one = vi.fn();
      const two = vi.fn();
      b1.on('ping', one);
      b2.on('ping', two);

      a1.emit('ping', 1);
      await settle();

      expect(one).toHaveBeenCalledWith(1);
      expect(two).not.toHaveBeenCalled();
    });

    it('ignores other traffic on the channel', async () => {
      const { a, right } = socketPair();
      const got = vi.fn();
      a.on('x', got);

      right.send(null);
      right.send('text');
      right.send({ verb: 'restore', id: 1 });
      right.send({ __rljsonSocket: 'test', kind: 'ack', ack: 99, args: [] });
      await settle();

      expect(got).not.toHaveBeenCalled();
    });

    it('stops listening with off, for one listener or all of an event', async () => {
      const { a, b } = socketPair();
      const first = vi.fn();
      const second = vi.fn();
      const other = vi.fn();
      b.on('e', first);
      b.on('e', second);
      b.on('o', other);

      b.off('e', first);
      a.emit('e');
      await settle();
      expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);

      b.off('e');
      b.off('never-registered', other);
      a.emit('e');
      await settle();
      expect(second).toHaveBeenCalledTimes(1);

      b.removeAllListeners('o');
      a.emit('o');
      b.on('p', other);
      b.removeAllListeners();
      a.emit('p');
      await settle();
      expect(other).not.toHaveBeenCalled();
    });
  });

  // ...........................................................................
  describe('carrying Io and Bs', () => {
    it('serves rows and blobs through a PeerReadServer on the other end', async () => {
      const io = new IoMem();
      await io.init();
      await io.createOrExtendTable({
        tableCfg: exampleTableCfg({ key: 'notes' }),
      });
      await io.write({
        data: { notes: { _data: [{ a: 'across', b: 1 }] } },
      } as never);
      const bs = new BsMem();
      const { blobId } = await bs.setBlob(Buffer.from('blob across'));
      const { a, b } = socketPair();
      const server = new PeerReadServer(io, bs);
      await server.addSocket(b);

      const ioPeer = new IoPeer(a);
      const bsPeer = new BsPeer(a);
      await ioPeer.init();
      await bsPeer.init();
      const rows = await ioPeer.readRows({ table: 'notes', where: {} });
      const blob = await bsPeer.getBlob(blobId);

      expect((rows.notes._data[0] as { a: string }).a).toBe('across');
      expect(Buffer.isBuffer(blob.content)).toBe(true);
      expect(blob.content.toString()).toBe('blob across');
      await expect(bsPeer.setBlob('no')).rejects.toBeDefined();
    });
  });

  // ...........................................................................
  describe('over a real child process', () => {
    let child: ReturnType<typeof fork> | undefined;

    afterEach(() => {
      if (child && child.exitCode === null) child.kill();
      child = undefined;
    });

    it('carries events, acknowledgements and Buffers, and the child closing its end', async () => {
      child = fork(join(__dirname, 'helpers', 'channel-echo-child.mjs'), {
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const socket = new ChannelSocket(child as MessageChannelLike, 'echo');
      socket.connect();
      const disconnected = new Promise<void>((resolve) =>
        socket.on('disconnect', () => resolve()),
      );

      const [echo, bytes] = await new Promise<unknown[]>((resolve) =>
        socket.emit('ask', 'q', Buffer.from('to the child'), (...r: unknown[]) =>
          resolve(r),
        ),
      );

      const { got, from } = echo as { got: [string, Buffer]; from: string };
      expect(from).toBe('child');
      expect(got[0]).toBe('q');
      expect(Buffer.isBuffer(got[1])).toBe(true);
      expect(got[1].toString()).toBe('to the child');
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect((bytes as Buffer).toString()).toBe('bytes from the child');

      socket.emit('quit');
      await disconnected;
      expect(socket.connected).toBe(false);
    });
  });
});
