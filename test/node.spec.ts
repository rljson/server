// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { createSocketPair } from '@rljson/io';
import { ConnectorPayload } from '@rljson/rljson';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HubRoutes } from '../src/hub-routes.ts';
import { BufferedLogger } from '../src/logger.ts';
import {
  Node,
  NodeConfig,
  NodeDeps,
  PortHandshake,
  PortTransport,
} from '../src/node.ts';
import {
  ClientRoute,
  RouteMember,
  RouteMemberContext,
} from '../src/route-member.ts';
import { SocketLike } from '../src/socket-bundle.ts';

import { FakeCloud, InProcessPorts } from './helpers/node-network.ts';

// .............................................................................
// Node: one port in every role, a hub service for every route, and route
// members that follow the elected hub. Ports in memory, the network manager
// real, discovery through a fake cloud that decides the hub.
// .............................................................................

/** A member doing what the test says, recording what it was given. */
class ScriptedMember implements RouteMember {
  readonly contexts: RouteMemberContext[] = [];
  readonly served: SocketLike[] = [];
  failStarts = 0;
  failStop = false;
  failClose = false;
  failServe = false;
  starts = 0;
  stops = 0;
  /** While set, a start waits for it. */
  hold?: Promise<void>;

  constructor(readonly treeKey = 'aTree') {}

  async start(context: RouteMemberContext) {
    this.starts++;
    this.contexts.push(context);
    await this.hold;
    if (this.failStarts > 0) {
      this.failStarts--;
      throw new Error('start failed');
    }
  }

  async stop() {
    this.stops++;
    if (this.failStop) throw new Error('stop failed');
  }

  async servePeer(socket: SocketLike) {
    if (this.failServe) throw new Error('serve failed');
    this.served.push(socket);
  }

  async close() {
    if (this.failClose) throw new Error('close failed');
  }
}

describe('Node', () => {
  let dir: string;
  let cloud: FakeCloud;
  let ports: InProcessPorts;
  let nodes: Node[];
  let nextPort = 4100;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'node-'));
    cloud = new FakeCloud();
    ports = new InProcessPorts();
    nodes = [];
  });

  afterEach(async () => {
    for (const node of nodes) await node.stop();
    await rm(dir, { recursive: true, force: true });
  });

  /** Creates a node on the shared ports and cloud. */
  const createNode = (
    config: Partial<NodeConfig> = {},
    deps: Partial<NodeDeps> = {},
  ) => {
    const port = nextPort++;
    const node = new Node(
      {
        domain: 'test',
        port,
        identityDir: join(dir, String(port)),
        network: FakeCloud.network(),
        hub: HubRoutes.example()['_options'],
        members: [ClientRoute.example({ treeKey: 'aTree' })],
        reconnectDelayMs: 10,
        retryMs: 50,
        driftCheckMs: 0,
        hubSelfCheckMs: 0,
        ...config,
      },
      {
        createPortTransport: ports.createPortTransport,
        connectHub: ports.connectHub,
        connectPeer: ports.connectPeer,
        networkManagerOptions: cloud.networkManagerOptions,
        ...deps,
      },
    );
    nodes.push(node);
    return node;
  };

  /** The address of a node's port. */
  const addressOf = (node: Node) => `127.0.0.1:${node['_config'].port}`;

  /** Makes a node the hub and waits until the given nodes follow. */
  const electHub = async (hub: Node, followers: Node[]) => {
    cloud.assignedHub = hub.nodeId!;
    await vi.waitFor(
      () => {
        expect(hub.role).toBe('hub');
        for (const node of followers) {
          expect(node.hubAddress).toBe(addressOf(hub));
        }
      },
      { timeout: 3000 },
    );
  };

  /** The member of a node, as a ClientRoute. */
  const member = (node: Node, treeKey = 'aTree') =>
    node.members.get(treeKey) as ClientRoute;

  // ...........................................................................
  describe('construction', () => {
    it('refuses two members of one route', () => {
      expect(() =>
        createNode({
          members: [new ScriptedMember('x'), new ScriptedMember('x')],
        }),
      ).toThrow('Two members for route x');
      nodes.pop();
    });

    it('has no identity, hub or role before it starts', () => {
      const node = createNode();
      expect(node.nodeId).toBeUndefined();
      expect(node.hubRoutes).toBeUndefined();
      expect(node.hubAddress).toBeUndefined();
      expect(node.role).toBe('unassigned');
      expect(node.isRunning).toBe(false);
      expect([...node.members.keys()]).toEqual(['aTree']);
      expect(node.topology.domain).toBe('test');
      expect(node.networkManager).toBeDefined();
    });

    it('runs without members and with the default network settings', async () => {
      const node = createNode({ members: undefined, network: undefined });
      await node.start();
      expect(node.members.size).toBe(0);
      expect(node.isRunning).toBe(true);
    });
  });

  // ...........................................................................
  describe('start and stop', () => {
    it('opens its port and hub service, and closes both when it stops', async () => {
      const node = createNode({ hub: { ...HubRoutes.example()['_options'], treeKeys: ['aTree'] } });
      const stopped = vi.fn();
      node.on('stopped', stopped);
      await node.start();
      await node.start();

      expect(node.isRunning).toBe(true);
      expect(node.nodeId).toMatch(/.+/);
      expect([...node.hubRoutes!.servers.keys()]).toEqual(['aTree']);
      await expect(
        ports.connectPeer(addressOf(node), {
          treeKey: 'aTree',
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();

      const hub = node.hubRoutes!;
      await node.stop();
      await node.stop();

      expect(stopped).toHaveBeenCalledTimes(1);
      expect(node.isRunning).toBe(false);
      expect(hub.isTornDown).toBe(true);
      await expect(
        ports.connectPeer(addressOf(node), {
          treeKey: 'aTree',
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('starts again after a stop, with the same identity', async () => {
      const node = createNode();
      await node.start();
      const id = node.nodeId;
      await node.stop();
      await node.start();
      expect(node.nodeId).toBe(id);
      expect(node.hubRoutes!.isTornDown).toBe(false);
    });

    it('fails to start when its port cannot open, and tears the hub service down', async () => {
      const node = createNode(
        {},
        {
          createPortTransport: async () => {
            throw new Error('EADDRINUSE');
          },
        },
      );
      await expect(node.start()).rejects.toThrow('EADDRINUSE');
      expect(node.isRunning).toBe(false);
    });

    it('runs with its default timings', async () => {
      const scripted = new ScriptedMember();
      scripted.failStarts = 1;
      const node = createNode({
        members: [scripted],
        reconnectDelayMs: undefined,
        retryMs: undefined,
        driftCheckMs: undefined,
        hubSelfCheckMs: undefined,
      });
      await node.start();
      cloud.assignedHub = node.nodeId!;

      await vi.waitFor(() => expect(scripted.starts).toBe(1), {
        timeout: 4000,
      });
      expect(node['_retryTimers'].size).toBe(1);
      expect(node['_selfCheckTimer']).toBeDefined();
      expect(node['_driftTimer']).toBeDefined();
    });

    it('starts even when its first move fails, logs it, and moves again later', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      // The default retry: 3 s.
      const node = createNode({ logger, members: [scripted], retryMs: undefined });
      cloud.assignedHub = 'set-below';
      const getTopology = node.networkManager.getTopology.bind(
        node.networkManager,
      );
      let failFirstMove = false;
      vi.spyOn(node.networkManager, 'getTopology').mockImplementation(() => {
        if (failFirstMove) {
          failFirstMove = false;
          throw new Error('topology unreadable');
        }
        return getTopology();
      });
      const startNetwork = node.networkManager.start.bind(node.networkManager);
      vi.spyOn(node.networkManager, 'start').mockImplementation(async () => {
        await startNetwork();
        failFirstMove = true;
      });

      await node.start();

      expect(node.isRunning).toBe(true);
      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Changing the members failed' }),
      );
      cloud.assignedHub = node.nodeId!;
      await vi.waitFor(() => expect(scripted.starts).toBeGreaterThan(0), {
        timeout: 5000,
      });
    });

    it('drops a move that was queued before it stopped', async () => {
      const scripted = new ScriptedMember();
      const node = createNode({ members: [scripted] });
      await node.start();
      cloud.assignedHub = node.nodeId!;
      await vi.waitFor(() => expect(scripted.starts).toBe(1));
      // A move would start the member again: the hub seems elsewhere.
      node['_hubAddress'] = 'elsewhere:1';
      let release: () => void = () => undefined;
      node['_reconciling'] = new Promise<void>((resolve) => (release = resolve));

      const queued = node['_queueReconcile']();
      const stopping = node.stop();
      release();
      await stopping;
      await queued;

      expect(scripted.starts).toBe(1);
    });

    it('closes its members when it stops, and logs a member that fails to close', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      scripted.failClose = true;
      const node = createNode({ logger, members: [scripted] });
      await node.start();

      await node.stop();

      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Member close failed' }),
      );
    });
  });

  // ...........................................................................
  describe('following the hub', () => {
    it('connects its members to itself over loopback when it is the hub', async () => {
      const a = createNode();
      const ready = vi.fn();
      const hubChanged = vi.fn();
      a.on('ready', ready);
      a.on('hub-changed', hubChanged);
      await a.start();

      await electHub(a, [a]);

      await vi.waitFor(() => expect(ready).toHaveBeenCalled());
      expect(hubChanged).toHaveBeenCalledWith({
        previous: undefined,
        current: addressOf(a),
      });
      expect(member(a).client).toBeDefined();
      expect(a.hubRoutes!.server('aTree')!.connectedNodes).toEqual([a.nodeId]);
    });

    it('moves the members of another node to the hub, and refs flow between them', async () => {
      const a = createNode();
      const b = createNode();
      await a.start();
      await b.start();

      await electHub(a, [a, b]);
      await vi.waitFor(() =>
        expect(a.hubRoutes!.server('aTree')!.connectedNodes.sort()).toEqual(
          [a.nodeId!, b.nodeId!].sort(),
        ),
      );

      const got: string[] = [];
      const bSocket = member(b)['_socket'] as unknown as {
        on: (e: string, l: (p: ConnectorPayload) => void) => void;
      };
      bSocket.on('/aTree', (p) => got.push(p.r));
      const aSocket = member(a)['_socket'] as unknown as {
        emit: (e: string, p: unknown) => void;
      };
      aSocket.emit('/aTree', { o: 'a', r: 'ref-1' });

      await vi.waitFor(() => expect(got).toEqual(['ref-1']));
    });

    it('moves every member when the hub moves, and tells the app about roles and hubs', async () => {
      const a = createNode();
      const b = createNode();
      const roles: string[] = [];
      const hubs: unknown[] = [];
      a.on('role-changed', (e) => roles.push(`a:${e.current}`));
      b.on('role-changed', (e) => roles.push(`b:${e.current}`));
      b.on('hub-changed', (e) => hubs.push(e));
      await a.start();
      await b.start();
      await electHub(a, [a, b]);

      await electHub(b, [a, b]);
      await vi.waitFor(() =>
        expect(b.hubRoutes!.server('aTree')!.connectedNodes.sort()).toEqual(
          [a.nodeId!, b.nodeId!].sort(),
        ),
      );

      expect(roles).toContain('a:hub');
      expect(roles).toContain('b:hub');
      expect(roles).toContain('a:client');
      // Before the cloud's choice arrives, a node may elect a hub of its own
      // for a moment: only the last moves are fixed.
      expect(hubs.at(-1)).toEqual({
        previous: addressOf(a),
        current: addressOf(b),
      });
      expect(hubs.at(0)).toEqual(
        expect.objectContaining({ previous: undefined }),
      );
    });

    it('leaves its members where they are while no hub is known', async () => {
      const scripted = new ScriptedMember();
      const node = createNode({ members: [scripted] });
      await node.start();
      cloud.assignedHub = 'a-node-nobody-knows';

      await vi.waitFor(() => expect(node.role).toBe('client'));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(node.hubAddress).toBeUndefined();
      expect(scripted.starts).toBe(0);
    });

    it('starts a member again whose start failed, while the hub stays', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      scripted.failStarts = 2;
      const ready = vi.fn();
      const node = createNode({ logger, members: [scripted] });
      node.on('ready', ready);
      await node.start();

      await electHub(node, [node]);

      await vi.waitFor(() => expect(scripted.starts).toBe(3));
      // Ready once the last missing member started, on its retry.
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(logger.byLevel('error')).toHaveLength(2);
      expect(logger.byLevel('info')).toContainEqual(
        expect.objectContaining({ message: 'Member started on retry' }),
      );
    });

    it('is ready only once every failed member started again', async () => {
      const first = new ScriptedMember('aTree');
      const second = new ScriptedMember('bTree');
      first.failStarts = 1;
      second.failStarts = 2;
      const ready = vi.fn();
      // Retries far apart, so the state between two of them can be seen.
      const node = createNode({ members: [first, second], retryMs: 400 });
      node.on('ready', ready);
      await node.start();

      await electHub(node, [node]);

      // The first runs on its retry; the second still does not.
      await vi.waitFor(() => expect(first.starts).toBe(2));
      await vi.waitFor(() => expect(second.starts).toBe(2));
      expect(ready).not.toHaveBeenCalled();

      // The second runs on its next retry: now the node is ready.
      await vi.waitFor(() => expect(second.starts).toBe(3));
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    });

    it('does not start a member again once the hub moved on', async () => {
      const scripted = new ScriptedMember();
      scripted.failStarts = 1;
      const node = createNode({ members: [scripted], retryMs: 200 });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() => expect(scripted.starts).toBe(1));

      node['_hubAddress'] = 'moved:1';
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(scripted.starts).toBe(1);
    });

    it('drops a retry that comes due after the node stopped', async () => {
      const scripted = new ScriptedMember();
      scripted.failStarts = 1;
      const node = createNode({ members: [scripted], retryMs: 100 });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() => expect(scripted.starts).toBe(1));
      const timer = [...node['_retryTimers'].values()][0];

      node['_running'] = false;
      // The timer fires as if stop() had not cleared it yet.
      (timer as unknown as { _onTimeout: () => void })._onTimeout();
      node['_running'] = true;
      await node['_reconciling'];

      expect(scripted.starts).toBe(1);
    });

    it('skips a queued retry when the hub moved before it ran', async () => {
      const scripted = new ScriptedMember();
      scripted.failStarts = 1;
      const node = createNode({ members: [scripted], retryMs: 50 });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() => expect(scripted.starts).toBe(1));

      // Hold the queue so the retry is queued behind something that moves
      // the hub.
      let release: () => void = () => undefined;
      node['_reconciling'] = new Promise<void>((resolve) => (release = resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
      node['_hubAddress'] = 'moved:1';
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(scripted.starts).toBe(1);
    });

    it('logs a member that fails to stop, and still moves it', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      scripted.failStop = true;
      const a = createNode({ logger, members: [scripted] });
      const b = createNode();
      await a.start();
      await b.start();
      await electHub(a, [a]);

      await electHub(b, [a]);

      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Member stop failed' }),
      );
      expect(scripted.contexts.at(-1)!.hubAddress).toBe(addressOf(b));
    });

    it('stops members still connecting to a hub that moved on, and follows the new one', async () => {
      const logger = new BufferedLogger();
      const a = createNode();
      const b = createNode();
      let stuckOn = '';
      const c = createNode(
        { logger },
        {
          connectHub: (address, options) =>
            address === stuckOn
              ? new Promise((_resolve, reject) =>
                  options.signal.addEventListener('abort', () =>
                    reject(new Error('aborted')),
                  ),
                )
              : ports.connectHub(address, options),
        },
      );
      await a.start();
      await b.start();
      await c.start();
      await electHub(b, [a, b, c]);
      // From now on, connecting to A never completes on its own.
      stuckOn = addressOf(a);
      await electHub(a, [a, b, c]);
      await vi.waitFor(() => expect(c['_movingTo']).toBe(addressOf(a)));

      await electHub(b, [a, b, c]);

      await vi.waitFor(() =>
        expect(b.hubRoutes!.server('aTree')!.connectedNodes).toContain(
          c.nodeId,
        ),
      );
      expect(logger.byLevel('info')).toContainEqual(
        expect.objectContaining({ message: 'The hub moved again during a move' }),
      );
    });

    it('moves again when the hub changed silently during a move', async () => {
      const other = createNode();
      await other.start();
      const scripted = new ScriptedMember();
      const node = createNode({ members: [scripted] });
      const realTopology = node.networkManager.getTopology.bind(
        node.networkManager,
      );
      let silentlyElsewhere = false;
      vi.spyOn(node.networkManager, 'getTopology').mockImplementation(() =>
        silentlyElsewhere
          ? {
              ...realTopology(),
              myRole: 'client',
              hubAddress: addressOf(other),
            }
          : realTopology(),
      );
      const start = scripted.start.bind(scripted);
      vi.spyOn(scripted, 'start').mockImplementation(async (context) => {
        await start(context);
        // The election settles elsewhere while the member starts — and no
        // event says so.
        silentlyElsewhere = true;
      });
      await node.start();
      cloud.assignedHub = node.nodeId!;

      await vi.waitFor(() =>
        expect(scripted.contexts.at(-1)?.hubAddress).toBe(addressOf(other)),
      );
    });

    it('moves again when the hub changed silently while a member was being added', async () => {
      const other = createNode();
      await other.start();
      const node = createNode({ members: [] });
      await node.start();
      await electHub(node, [node]);
      const realTopology = node.networkManager.getTopology.bind(
        node.networkManager,
      );
      let silentlyElsewhere = false;
      vi.spyOn(node.networkManager, 'getTopology').mockImplementation(() =>
        silentlyElsewhere
          ? { ...realTopology(), myRole: 'client', hubAddress: addressOf(other) }
          : realTopology(),
      );
      const added = new ScriptedMember('addedTree');
      const start = added.start.bind(added);
      vi.spyOn(added, 'start').mockImplementation(async (context) => {
        await start(context);
        silentlyElsewhere = true;
      });

      await node.addMember(added);

      await vi.waitFor(() =>
        expect(added.contexts.at(-1)?.hubAddress).toBe(addressOf(other)),
      );
    });

    it('moves members a missed event left behind, on its drift check', async () => {
      const logger = new BufferedLogger();
      const node = createNode({ logger, driftCheckMs: 30 });
      await node.start();
      await electHub(node, [node]);

      node['_hubAddress'] = 'stale:1';
      await vi.waitFor(() => expect(node.hubAddress).toBe(addressOf(node)));

      expect(logger.byLevel('warn')).toContainEqual(
        expect.objectContaining({ message: 'Members drifted from the hub' }),
      );
    });

    it('gives each member its route, identity, hub and logger', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember('bRoute');
      const node = createNode({ logger, members: [scripted] });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() =>
        expect(scripted.contexts.length).toBeGreaterThan(0),
      );

      const context = scripted.contexts.at(-1)!;
      expect(context.treeKey).toBe('bRoute');
      expect(context.route.flat).toBe('/bRoute');
      expect(context.nodeId).toBe(node.nodeId);
      expect(context.hubAddress).toBe(addressOf(node));
      expect(context.logger).toBe(logger);
      const socket = await context.connectHub(new AbortController().signal);
      expect(socket).toBeDefined();
      expect(ports.log.at(-1)!.handshake).toEqual({ treeKeys: ['bRoute'] });
    });

    it('refuses a hub connection on a node that opens none', async () => {
      // A member that dials its hub on its own needs no connectHub; one that
      // asks the node anyway gets a clear refusal.
      const scripted = new ScriptedMember('bRoute');
      const node = createNode(
        { members: [scripted] },
        { connectHub: undefined },
      );
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() =>
        expect(scripted.contexts.length).toBeGreaterThan(0),
      );

      await expect(
        scripted.contexts.at(-1)!.connectHub(new AbortController().signal),
      ).rejects.toThrow('This node opens no hub connections (connectHub)');
    });
  });

  // ...........................................................................
  describe('alone', () => {
    it('acts as its own hub when it knows no peer and no hub for aloneHubMs', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      const node = createNode({ logger, members: [scripted], aloneHubMs: 100 });
      await node.start();
      expect(node.role).not.toBe('hub');

      await vi.waitFor(() => expect(node.hubAddress).toBe(addressOf(node)), {
        timeout: 3000,
      });

      expect(node.role).toBe('hub');
      expect(scripted.contexts.at(-1)!.hubAddress).toBe(addressOf(node));
      expect(logger.byLevel('info')).toContainEqual(
        expect.objectContaining({
          message: 'No peer and no hub: acting as its own hub',
        }),
      );
      await expect(
        ports.connectHub(addressOf(node), {
          treeKey: 'aTree',
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();
    });

    it('stops acting as its own hub as soon as a peer appears', async () => {
      const a = createNode({ members: [], aloneHubMs: 100 });
      await a.start();
      await vi.waitFor(() => expect(a.role).toBe('hub'));

      const b = createNode({ members: [] });
      await b.start();

      await vi.waitFor(() => expect(a.role).not.toBe('hub'));
    });

    it('never acts alone while it knows a peer', async () => {
      const a = createNode({ members: [], aloneHubMs: 400 });
      const b = createNode({ members: [], aloneHubMs: 400 });
      await a.start();
      await b.start();
      await vi.waitFor(() =>
        expect(Object.keys(a.topology.nodes)).toHaveLength(2),
      );

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(a.role).not.toBe('hub');
      expect(a.hubAddress).toBeUndefined();
    });

    it('never acts alone with aloneHubMs 0', async () => {
      const node = createNode({ members: [], aloneHubMs: 0 });
      await node.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(node.role).not.toBe('hub');
    });
  });

  // ...........................................................................
  describe('closing and opening its port', () => {
    it('drops off the network and comes back, with a fresh hub service', async () => {
      const node = createNode();
      await node.start();
      const firstHub = node.hubRoutes!;
      const signal = new AbortController().signal;
      expect(node.isPortOpen).toBe(true);

      await node.closePort();
      await node.closePort();

      expect(node.isPortOpen).toBe(false);
      expect(firstHub.isTornDown).toBe(true);
      await expect(
        ports.connectPeer(addressOf(node), { treeKey: 'aTree', signal }),
      ).rejects.toThrow('ECONNREFUSED');

      await node.openPort();
      await node.openPort();

      expect(node.isPortOpen).toBe(true);
      expect(node.hubRoutes).not.toBe(firstHub);
      await expect(
        ports.connectPeer(addressOf(node), { treeKey: 'aTree', signal }),
      ).resolves.toBeDefined();
    });

    it('stops with its port closed', async () => {
      const node = createNode();
      await node.start();
      await node.closePort();

      await node.stop();

      expect(node.isRunning).toBe(false);
    });

    it('neither closes nor opens a port while it is not running', async () => {
      const node = createNode();
      await node.closePort();
      await node.openPort();
      expect(node.isPortOpen).toBe(false);
    });
  });

  // ...........................................................................
  describe('members added and removed at runtime', () => {
    it('starts a member added while it runs on the current hub', async () => {
      const node = createNode({ members: [] });
      await node.start();
      await electHub(node, [node]);
      const added = new ScriptedMember('lateTree');

      await node.addMember(added);

      expect(added.contexts.at(-1)!.hubAddress).toBe(addressOf(node));
      expect(node.members.get('lateTree')).toBe(added);
    });

    it('starts a member added before the node started with its first move', async () => {
      const node = createNode({ members: [] });
      const added = new ScriptedMember('earlyTree');
      await node.addMember(added);
      expect(added.starts).toBe(0);

      await node.start();
      await electHub(node, [node]);

      await vi.waitFor(() => expect(added.starts).toBe(1));
    });

    it('starts a member added during a move once — the move starts it', async () => {
      // An application adds its routes one after the other; a move that runs in
      // between starts the new one, and a second start only stopped it and
      // spawned it again.
      const primary = new ScriptedMember('primary');
      const node = createNode({ members: [primary] });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() => expect(primary.starts).toBe(1));

      // The next move is held in the primary's start ...
      let release!: () => void;
      primary.hold = new Promise<void>((resolve) => (release = resolve));
      const other = createNode({ members: [] });
      await other.start();
      await electHub(other, [other, node]);
      await vi.waitFor(() => expect(primary.starts).toBe(2));

      // ... when the next route is added.
      const added = new ScriptedMember('addedTree');
      const adding = node.addMember(added);
      release();
      await adding;

      expect(added.starts).toBe(1);
      expect(added.contexts[0].hubAddress).toBe(addressOf(other));
    });

    it('refuses a second member for a route', async () => {
      const node = createNode();
      await expect(node.addMember(new ScriptedMember('aTree'))).rejects.toThrow(
        'Two members for route aTree',
      );
    });

    it('closes a removed member and stops serving its route', async () => {
      const scripted = new ScriptedMember('bTree');
      const close = vi.spyOn(scripted, 'close');
      const node = createNode({ members: [scripted] });
      await node.start();

      expect(await node.removeMember('bTree')).toBe(true);
      expect(await node.removeMember('bTree')).toBe(false);

      expect(close).toHaveBeenCalledTimes(1);
      expect(node.members.has('bTree')).toBe(false);
      await expect(
        ports.connectPeer(addressOf(node), {
          treeKey: 'bTree',
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();
      expect(scripted.served).toEqual([]);
    });

    it('cancels the retry of a removed member, and logs a failing close', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      scripted.failStarts = 5;
      scripted.failClose = true;
      const node = createNode({ logger, members: [scripted], retryMs: 100 });
      await node.start();
      await electHub(node, [node]);
      await vi.waitFor(() => expect(scripted.starts).toBe(1));

      await node.removeMember('aTree');
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(scripted.starts).toBe(1);
      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Member close failed' }),
      );
    });

    it('keeps changing members after a change failed', async () => {
      const logger = new BufferedLogger();
      const node = createNode({ logger, members: [] });
      await node.start();

      await expect(
        node['_serializeMove'](async () => {
          throw new Error('broken change');
        }),
      ).rejects.toThrow('broken change');
      const added = new ScriptedMember('afterTree');
      await node.addMember(added);

      expect(node.members.has('afterTree')).toBe(true);
      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Changing the members failed' }),
      );
    });
  });

  // ...........................................................................
  describe('its port', () => {
    it('takes route clients only while it is hub, and peers in every role', async () => {
      const a = createNode();
      const b = createNode();
      await a.start();
      await b.start();
      await electHub(a, [a, b]);
      const signal = new AbortController().signal;

      await expect(
        ports.connectHub(addressOf(b), { treeKey: 'aTree', signal }),
      ).rejects.toThrow('refused');
      await expect(
        ports.connectPeer(addressOf(b), { treeKey: 'aTree', signal }),
      ).resolves.toBeDefined();
      await expect(
        ports.connectHub(addressOf(a), { treeKey: 'aTree', signal }),
      ).resolves.toBeDefined();
    });

    it('disconnects a route client a transport without a gate let through', async () => {
      let handler: (s: SocketLike, h: PortHandshake) => void = () => undefined;
      const transport: PortTransport = {
        accept: () => undefined,
        onConnection: (h) => (handler = h),
        close: async () => undefined,
      };
      const node = createNode({}, { createPortTransport: async () => transport });
      await node.start();
      const [serverSide] = createSocketPair();
      serverSide.connect();

      handler(serverSide, { treeKeys: ['aTree'] });

      expect(serverSide.connected).toBe(false);
    });

    it('hands a peer to the member of its route', async () => {
      const node = createNode();
      await node.start();

      await ports.connectPeer(addressOf(node), {
        treeKey: 'aTree',
        signal: new AbortController().signal,
      });

      await vi.waitFor(() =>
        expect(member(node).peerServer?.peerCount).toBe(1),
      );
    });

    it('disconnects a peer of a route it does not take part in, or that names none', async () => {
      let handler: (s: SocketLike, h: PortHandshake) => void = () => undefined;
      const node = createNode(
        {},
        {
          createPortTransport: async () => ({
            accept: () => undefined,
            onConnection: (h) => (handler = h),
            close: async () => undefined,
          }),
        },
      );
      await node.start();
      const [unknownRoute] = createSocketPair();
      const [noRoute] = createSocketPair();
      unknownRoute.connect();
      noRoute.connect();

      handler(unknownRoute, { treeKeys: ['otherTree'], peerRead: true });
      handler(noRoute, { peerRead: true });

      expect(unknownRoute.connected).toBe(false);
      expect(noRoute.connected).toBe(false);
    });

    it('disconnects a peer its member fails to serve, and logs it', async () => {
      const logger = new BufferedLogger();
      const scripted = new ScriptedMember();
      scripted.failServe = true;
      let handler: (s: SocketLike, h: PortHandshake) => void = () => undefined;
      const node = createNode(
        { logger, members: [scripted] },
        {
          createPortTransport: async () => ({
            accept: () => undefined,
            onConnection: (h) => (handler = h),
            close: async () => undefined,
          }),
        },
      );
      await node.start();
      const [serverSide] = createSocketPair();
      serverSide.connect();

      handler(serverSide, { treeKeys: ['aTree'], peerRead: true });

      await vi.waitFor(() => expect(serverSide.connected).toBe(false));
      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Serving a peer failed' }),
      );
    });

    it('disconnects a route client the hub fails to add, and logs it', async () => {
      const logger = new BufferedLogger();
      const node = createNode({
        logger,
        members: [],
        hub: {
          createStores: async () => {
            throw new Error('disk full');
          },
        },
      });
      await node.start();
      await electHub(node, []);

      await expect(
        ports.connectHub(addressOf(node), {
          treeKey: 'aTree',
          signal: new AbortController().signal,
        }),
      ).resolves.toBeDefined();

      await vi.waitFor(() =>
        expect(logger.byLevel('error')).toContainEqual(
          expect.objectContaining({ message: 'Adding a route client failed' }),
        ),
      );
    });
  });

  // ...........................................................................
  describe('peer reads', () => {
    it('lets members resolve sources through the network, never itself or the hub', async () => {
      const scripted = new ScriptedMember();
      const a = createNode({ peerReads: { timeoutMs: 100 } });
      const b = createNode({ peerReads: { timeoutMs: 100 } });
      const c = createNode({ members: [scripted], peerReads: { timeoutMs: 100 } });
      await a.start();
      await b.start();
      await c.start();
      await electHub(a, [a, b, c]);
      await vi.waitFor(() =>
        expect(scripted.contexts.length).toBeGreaterThan(0),
      );
      await vi.waitFor(() =>
        expect(c.networkManager.resolvePeerAddress(b.nodeId!)).not.toBeNull(),
      );
      const peerReads = scripted.contexts.at(-1)!.peerReads!;
      const signal = new AbortController().signal;

      expect(peerReads.bounds).toEqual({ timeoutMs: 100 });
      expect(peerReads.resolve(c.nodeId!)).toBeUndefined();
      expect(peerReads.resolve(a.nodeId!)).toBeUndefined();
      expect(peerReads.resolve('unknown')).toBeUndefined();
      expect(peerReads.resolve(b.nodeId!)).toBe(addressOf(b));
      expect(await peerReads.connect('unknown', signal)).toBeUndefined();
      expect(await peerReads.connect(b.nodeId!, signal)).toBeDefined();
      expect(ports.log.at(-1)!.handshake).toEqual({
        treeKeys: ['aTree'],
        peerRead: true,
      });
    });

    it('gives members no peer reads without bounds or without a way to reach peers', async () => {
      const noBounds = new ScriptedMember();
      const noConnect = new ScriptedMember();
      const a = createNode({ members: [noBounds] });
      const b = createNode(
        { members: [noConnect], peerReads: { timeoutMs: 100 } },
        { connectPeer: undefined },
      );
      await a.start();
      await b.start();
      await electHub(a, [a, b]);
      await vi.waitFor(() => {
        expect(noBounds.contexts.length).toBeGreaterThan(0);
        expect(noConnect.contexts.length).toBeGreaterThan(0);
      });

      expect(noBounds.contexts.at(-1)!.peerReads).toBeUndefined();
      expect(noConnect.contexts.at(-1)!.peerReads).toBeUndefined();
    });
  });

  // ...........................................................................
  describe('hub self-check', () => {
    it('stays hub while another node is connected', async () => {
      const a = createNode({ hubSelfCheckMs: 100 });
      const b = createNode();
      await a.start();
      await b.start();
      await electHub(a, [a, b]);

      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(a.role).toBe('hub');
      expect(a.networkManager.isExcludedFromElection(a.nodeId!)).toBe(false);
    });

    it('stays hub when it is alone', async () => {
      const a = createNode({ hubSelfCheckMs: 50 });
      await a.start();
      await electHub(a, [a]);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(a.role).toBe('hub');
    });

    it('steps down when no other node reached it, and hands the hub to a reachable peer', async () => {
      const logger = new BufferedLogger();
      const a = createNode({ logger, hubSelfCheckMs: 100 });
      const b = createNode(
        {},
        {
          connectHub: async () => {
            throw new Error('firewall');
          },
        },
      );
      await a.start();
      await b.start();
      cloud.assignedHub = a.nodeId!;
      await vi.waitFor(() => expect(a.role).toBe('hub'));
      await vi.waitFor(() =>
        expect(Object.keys(a.topology.nodes)).toHaveLength(2),
      );
      await a.networkManager.getProbeScheduler().runOnce();

      await vi.waitFor(
        () =>
          expect(logger.byLevel('info')).toContainEqual(
            expect.objectContaining({ message: 'Handing the hub on' }),
          ),
        { timeout: 2000 },
      );

      expect(a.networkManager.isExcludedFromElection(a.nodeId!)).toBe(true);
      expect(a.topology.hubNodeId).toBe(b.nodeId);
    });

    it('hands the hub to the longest-running of several reachable peers', async () => {
      const a = createNode({ hubSelfCheckMs: 150 });
      const unreachable = { connectHub: async () => Promise.reject(new Error('firewall')) };
      const b = createNode({}, unreachable);
      const c = createNode({}, unreachable);
      await a.start();
      await b.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await c.start();
      cloud.assignedHub = a.nodeId!;
      await vi.waitFor(() =>
        expect(Object.keys(a.topology.nodes)).toHaveLength(3),
      );
      await a.networkManager.getProbeScheduler().runOnce();

      await vi.waitFor(
        () => expect(a.topology.hubNodeId).not.toBe(a.nodeId),
        { timeout: 2000 },
      );

      const startedAt = (n: Node) => a.topology.nodes[n.nodeId!]!.startedAt;
      const earliest = [b, c].sort((x, y) => startedAt(x) - startedAt(y))[0];
      expect(a.topology.hubNodeId).toBe(earliest.nodeId);
    });

    it('steps down without a successor when no peer was reachable', async () => {
      const logger = new BufferedLogger();
      const a = createNode({ logger, hubSelfCheckMs: 100 });
      const b = createNode(
        {},
        {
          connectHub: async () => {
            throw new Error('firewall');
          },
        },
      );
      await a.start();
      await b.start();
      cloud.assignedHub = a.nodeId!;
      await vi.waitFor(() =>
        expect(Object.keys(a.topology.nodes)).toHaveLength(2),
      );

      await vi.waitFor(
        () =>
          expect(logger.byLevel('warn')).toContainEqual(
            expect.objectContaining({
              message: 'No reachable peer to hand the hub to',
            }),
          ),
        { timeout: 2000 },
      );
    });
  });

  // ...........................................................................
  describe('events', () => {
    it('stops calling a listener that was removed, and survives one that throws', async () => {
      const logger = new BufferedLogger();
      const node = createNode({ logger });
      const removed = vi.fn();
      node.on('stopped', removed);
      node.off('stopped', removed);
      node.off('ready', removed);
      node.on('stopped', () => {
        throw new Error('listener broke');
      });
      await node.start();

      await node.stop();

      expect(removed).not.toHaveBeenCalled();
      expect(logger.byLevel('error')).toContainEqual(
        expect.objectContaining({ message: 'Listener of stopped failed' }),
      );
    });
  });
});
