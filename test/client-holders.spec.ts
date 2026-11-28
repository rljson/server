// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { Db, stateBeaconEvent } from '@rljson/db';
import { hip } from '@rljson/hash';
import { createSocketPair, DirectionalSocketMock, IoMem } from '@rljson/io';
import { Json } from '@rljson/json';
import { exampleTableCfg, Route, syncEvents } from '@rljson/rljson';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client, ClientOptions } from '../src/client.ts';
import { peerReadEvents } from '../src/peer-reads.ts';

// .............................................................................
// The client's part of the holders: it takes the holders the hub names on
// what it sends, and tells the hub when its node holds a ref it received.
// .............................................................................

const route = Route.fromFlat('clientHolders');
const events = syncEvents(route.flat);
const TABLE = 'notes';

describe('Client and the holders of its route', () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.tearDown();
    client = undefined;
  });

  /** A client whose hub side is a bare socket the test drives. */
  const createClient = async (options: ClientOptions = {}) => {
    const [hubSide, clientSide] = createSocketPair();
    hubSide.connect();
    const held: unknown[] = [];
    const hellos: unknown[] = [];
    hubSide.on(events.held, (payload: unknown) => held.push(payload));
    hubSide.on(peerReadEvents.hello, (payload: unknown) => hellos.push(payload));
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const core = new Db(io).core;
    await core.createTable(exampleTableCfg({ key: TABLE }));
    client = new Client(clientSide, io, new BsMem(), route, {
      peerReads: { nodeId: 'node-me', connect: async () => undefined },
      heldRecheckMs: [20, 20, 20],
      ...options,
    });
    await client.init();

    /** Writes a row into the client's local store and returns its hash. */
    const writeRow = async (a: string): Promise<string> => {
      const row = hip({ a, b: 1, _hash: '' } as unknown as Json) as {
        _hash: string;
      };
      await core.import(
        { [TABLE]: { _type: 'components', _data: [row] } } as never,
        { validate: false },
      );
      return row._hash;
    };

    /** The hash a row would have, without writing it. */
    const hashOf = (a: string): string =>
      (hip({ a, b: 1, _hash: '' } as unknown as Json) as { _hash: string })._hash;

    return { hubSide, clientSide, held, hellos, client, writeRow, hashOf };
  };

  const relay = (hubSide: DirectionalSocketMock, payload: unknown) =>
    hubSide.emit(route.flat, payload);

  describe('holders', () => {
    it('come with a relayed ref', async () => {
      const { hubSide, client } = await createClient();

      relay(hubSide, { o: 'o', r: 'ref-1', holders: { 'node-a': 'ref-1' } });

      expect(client.peerReads!.holders).toEqual({ 'node-a': 'ref-1' });
    });

    it('come with a bootstrap', async () => {
      const { hubSide, client } = await createClient();

      hubSide.emit(events.bootstrap, {
        o: 'o',
        r: 'ref-1',
        holders: { 'node-a': 'ref-1', 'node-b': 'ref-0' },
      });

      expect(client.peerReads!.holders).toEqual({
        'node-a': 'ref-1',
        'node-b': 'ref-0',
      });
    });

    it('come with the state beacon', async () => {
      const { hubSide, client } = await createClient();

      hubSide.emit(stateBeaconEvent(route.flat), {
        o: 'o',
        r: 'ref-1',
        holders: { 'node-a': 'ref-1' },
      });

      expect(client.peerReads!.holders).toEqual({ 'node-a': 'ref-1' });
    });

    it('are ignored when they are no object, or the payload names no ref', async () => {
      const { hubSide, client } = await createClient();

      relay(hubSide, { o: 'o', r: 'ref-1', holders: 'node-a' });
      relay(hubSide, { o: 'o', r: 'ref-1', holders: null });
      relay(hubSide, { o: 'o', holders: { 'node-a': 'ref-1' } });
      relay(hubSide, { o: 'o', r: '', holders: { 'node-a': 'ref-1' } });

      expect(client.peerReads!.holders).toEqual({});
    });
  });

  describe('held', () => {
    it('is told for a received ref the local store holds', async () => {
      const { hubSide, held, writeRow } = await createClient();
      const ref = await writeRow('x');

      relay(hubSide, { o: 'o', r: ref });

      await vi.waitFor(() => expect(held).toEqual([{ r: ref }]));
    });

    it('is told once the local store holds a ref that arrived before its data', async () => {
      const { hubSide, held, writeRow, hashOf } = await createClient();
      const ref = hashOf('later');

      hubSide.emit(events.bootstrap, { o: 'o', r: ref });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(held).toEqual([]);

      await writeRow('later');
      await vi.waitFor(() => expect(held).toEqual([{ r: ref }]));
    });

    it('is told again after a reconnect: the hub forgot the node', async () => {
      const { hubSide, clientSide, held, hellos, writeRow } = await createClient();
      const ref = await writeRow('x');
      hubSide.emit(stateBeaconEvent(route.flat), { o: 'o', r: ref });
      await vi.waitFor(() => expect(held).toHaveLength(1));

      clientSide.disconnect();
      clientSide.connect();

      expect(hellos).toHaveLength(2);
      expect(held).toEqual([{ r: ref }, { r: ref }]);
    });

    it('is told with peer reads off when the client has a node id', async () => {
      const { hubSide, held, writeRow } = await createClient({
        peerReads: undefined,
        nodeId: 'node-me',
      });
      const ref = await writeRow('x');

      relay(hubSide, { o: 'o', r: ref, holders: { 'node-a': ref } });

      await vi.waitFor(() => expect(held).toEqual([{ r: ref }]));
    });

    it('is never told without a node id', async () => {
      const { hubSide, held, hellos, writeRow } = await createClient({
        peerReads: undefined,
      });
      const ref = await writeRow('x');

      relay(hubSide, { o: 'o', r: ref });
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(hellos).toEqual([]);
      expect(held).toEqual([]);
    });

    it('stops with the tear down', async () => {
      const { hubSide, held, writeRow, hashOf } = await createClient();
      relay(hubSide, { o: 'o', r: hashOf('late') });
      await client!.tearDown();
      client = undefined;

      await writeRow('late');
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(held).toEqual([]);
    });
  });
});
