// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSocketPair } from '@rljson/io';
import type { PeerProbe } from '@rljson/network';
import { Route } from '@rljson/rljson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentHandle,
  CreateClientTransport,
  CreateHubTransport,
  HubTransport,
  NodeConfig,
  NodeDeps,
  ReadyContext,
} from '../src/node.ts';
import { Node } from '../src/node.ts';
import type { SocketLike } from '../src/socket-bundle.ts';

// .............................................................................

const route = Route.fromFlat('/testTree');

/** Mock probe function — all probes succeed instantly. */
const mockProbe = async (
  _host: string,
  _port: number,
  fromNodeId: string,
  toNodeId: string,
): Promise<PeerProbe> => ({
  fromNodeId,
  toNodeId,
  reachable: true,
  latencyMs: 1,
  measuredAt: Date.now(),
});

/**
 * Create mock deps that track transport lifecycle.
 *
 * The hub transport captures the onConnection callback so tests can
 * simulate client connections. The client transport creates a real
 * DirectionalSocketMock pair and delivers the server-side socket
 * to the hub's onConnection callback automatically.
 */
function createMockDeps(): NodeDeps & {
  hubTransportClosed: boolean;
  capturedOnConnection: ((socket: SocketLike) => void) | undefined;
} {
  let onConnectionCb: ((socket: SocketLike) => void) | undefined;
  let hubTransportClosed = false;

  const createHubTransport: CreateHubTransport = async () => {
    hubTransportClosed = false;
    const transport: HubTransport = {
      onConnection: (cb) => {
        onConnectionCb = cb;
      },
      close: async () => {
        hubTransportClosed = true;
        onConnectionCb = undefined;
      },
    };
    return transport;
  };

  const createClientTransport: CreateClientTransport = async () => {
    const [serverSocket, clientSocket] = createSocketPair();
    serverSocket.connect();
    if (onConnectionCb) onConnectionCb(serverSocket);
    return clientSocket;
  };

  const result = {
    createHubTransport,
    createClientTransport,
    networkManagerOptions: { probeFn: mockProbe },
    hubTransportClosed: false,
    capturedOnConnection: undefined as
      | ((socket: SocketLike) => void)
      | undefined,
  };

  // Use getters so callers always see current state
  Object.defineProperty(result, 'hubTransportClosed', {
    get: () => hubTransportClosed,
  });
  Object.defineProperty(result, 'capturedOnConnection', {
    get: () => onConnectionCb,
  });

  return result;
}

/**
 * Create a shared transport that wires two nodes together.
 *
 * When the client node calls createClientTransport, it:
 * 1. Creates a DirectionalSocketMock pair
 * 2. Delivers the server-side socket to the hub node's onConnection cb
 * 3. Returns the client-side socket to the Client constructor
 *
 * This is how real nodes connect — just with mock sockets instead of TCP.
 */
function createTwoNodeTransport(): {
  hubDeps: NodeDeps;
  clientDeps: NodeDeps;
  hubTransportClosed: boolean;
} {
  let hubOnConnection: ((socket: SocketLike) => void) | undefined;
  let hubClosed = false;

  const hubDeps: NodeDeps = {
    createHubTransport: async () => ({
      onConnection: (cb) => {
        hubOnConnection = cb;
      },
      close: async () => {
        hubOnConnection = undefined;
        hubClosed = true;
      },
    }),
    createClientTransport: async () => {
      const [, clientSocket] = createSocketPair();
      return clientSocket;
    },
    networkManagerOptions: { probeFn: mockProbe },
  };

  const clientDeps: NodeDeps = {
    createHubTransport: async () => ({
      onConnection: () => {},
      close: async () => {},
    }),
    createClientTransport: async () => {
      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      if (hubOnConnection) hubOnConnection(serverSocket);
      return clientSocket;
    },
    networkManagerOptions: { probeFn: mockProbe },
  };

  const result = { hubDeps, clientDeps, hubTransportClosed: false };
  Object.defineProperty(result, 'hubTransportClosed', {
    get: () => hubClosed,
  });
  return result;
}

/** Helper to become hub by manual override and wait for role change. */
async function becomeHub(node: Node): Promise<void> {
  const nm = node.networkManager;
  nm.assignHub(nm.getIdentity().nodeId);
  await vi.waitFor(() => expect(node.role).toBe('hub'));
}

/** Create a NodeConfig with temp identity dir. */
function createConfig(
  port: number,
  identityDir: string,
  overrides?: Partial<NodeConfig>,
): NodeConfig {
  return {
    domain: 'test-domain',
    port,
    route,
    identityDir,
    network: {
      broadcast: { enabled: false, port: 41234 },
      cloud: { enabled: false, endpoint: '' },
      probing: { enabled: false },
    },
    ...overrides,
  };
}

// .............................................................................

describe('Node', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'node-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  describe('lifecycle', () => {
    it('should start and stop cleanly', async () => {
      const deps = createMockDeps();
      const config = createConfig(4000, join(tempDir, 'n1'));
      const node = new Node(config, deps);

      expect(node.isRunning).toBe(false);
      expect(node.role).toBe('unassigned');

      await node.start();
      expect(node.isRunning).toBe(true);

      await node.stop();
      expect(node.isRunning).toBe(false);
      expect(node.role).toBe('unassigned');
    });

    it('should be idempotent on double start', async () => {
      const deps = createMockDeps();
      const config = createConfig(4001, join(tempDir, 'n2'));
      const node = new Node(config, deps);

      await node.start();
      await node.start(); // no-op
      expect(node.isRunning).toBe(true);

      await node.stop();
    });

    it('should be idempotent on double stop', async () => {
      const deps = createMockDeps();
      const config = createConfig(4002, join(tempDir, 'n3'));
      const node = new Node(config, deps);

      await node.start();
      await node.stop();
      await node.stop(); // no-op
      expect(node.isRunning).toBe(false);
    });

    it('should emit stopped event on stop', async () => {
      const deps = createMockDeps();
      const config = createConfig(4003, join(tempDir, 'n4'));
      const node = new Node(config, deps);

      const stopped = vi.fn();
      node.on('stopped', stopped);

      await node.start();
      await node.stop();

      expect(stopped).toHaveBeenCalledOnce();
    });

    it('should expose socket as undefined when not a client', async () => {
      const deps = createMockDeps();
      const config = createConfig(4008, join(tempDir, 'n9'));
      const node = new Node(config, deps);

      expect(node.socket).toBeUndefined();

      await node.start();
      await becomeHub(node);
      expect(node.socket).toBeUndefined();

      await node.stop();
    });

    it('should not emit stopped if never started', async () => {
      const deps = createMockDeps();
      const config = createConfig(4004, join(tempDir, 'n5'));
      const node = new Node(config, deps);

      const stopped = vi.fn();
      node.on('stopped', stopped);

      await node.stop();
      expect(stopped).not.toHaveBeenCalled();
    });

    it('should have undefined io/bs/server/client when unassigned', () => {
      const deps = createMockDeps();
      const config = createConfig(4005, join(tempDir, 'n6'));
      const node = new Node(config, deps);

      expect(node.io).toBeUndefined();
      expect(node.bs).toBeUndefined();
      expect(node.server).toBeUndefined();
      expect(node.client).toBeUndefined();
    });

    it('should expose networkManager', () => {
      const deps = createMockDeps();
      const config = createConfig(4006, join(tempDir, 'n7'));
      const node = new Node(config, deps);

      expect(node.networkManager).toBeDefined();
    });

    it('should expose topology snapshot', async () => {
      const deps = createMockDeps();
      const config = createConfig(4007, join(tempDir, 'n8'));
      const node = new Node(config, deps);

      await node.start();
      const topology = node.topology;
      expect(topology.domain).toBe('test-domain');
      expect(topology.myRole).toBeDefined();
      await node.stop();
    });

    it('should allow restart after stop', async () => {
      const deps = createMockDeps();
      const config = createConfig(4013, join(tempDir, 'n11'));
      const node = new Node(config, deps);

      // First lifecycle
      await node.start();
      await becomeHub(node);
      await node.bs!.setBlob('first run');
      await node.stop();
      expect(node.isRunning).toBe(false);

      // Second lifecycle — fresh IoMem/BsMem
      await node.start();
      expect(node.isRunning).toBe(true);
      await becomeHub(node);

      const { blobId } = await node.bs!.setBlob('second run');
      const { content } = await node.bs!.getBlob(blobId);
      expect(content.toString()).toBe('second run');

      await node.stop();
    });
  });

  // =========================================================================
  // Becoming hub
  // =========================================================================

  describe('becoming hub', () => {
    it('should create a functioning Server with io/bs', async () => {
      const deps = createMockDeps();
      const config = createConfig(4010, join(tempDir, 'h1'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      // Server is created and functional
      expect(node.server).toBeDefined();
      expect(node.client).toBeUndefined();
      expect(node.io).toBeDefined();
      expect(node.bs).toBeDefined();

      // Can write a blob to the hub's bs
      const { blobId } = await node.bs!.setBlob('hub data');
      expect(blobId).toBeTruthy();

      // Can read it back
      const { content } = await node.bs!.getBlob(blobId);
      expect(content.toString()).toBe('hub data');

      await node.stop();
    });

    it('should create hub transport on the configured port', async () => {
      const createHubTransport = vi.fn<CreateHubTransport>().mockResolvedValue({
        onConnection: () => {},
        close: async () => {},
      });

      const deps: NodeDeps = {
        createHubTransport,
        createClientTransport: async () => {
          const [, clientSocket] = createSocketPair();
          return clientSocket;
        },
        networkManagerOptions: { probeFn: mockProbe },
      };

      const port = 4011;
      const config = createConfig(port, join(tempDir, 'h2'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      expect(createHubTransport).toHaveBeenCalledWith(port);

      await node.stop();
    });

    it('should wire incoming connections to the Server', async () => {
      const deps = createMockDeps();
      const config = createConfig(4012, join(tempDir, 'h3'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      // Simulate a client connecting — fires the onConnection callback
      const [serverSocket, clientSocket] = createSocketPair();
      serverSocket.connect();
      deps.capturedOnConnection!(serverSocket);

      // Wait for async addSocket to complete
      await vi.waitFor(() => expect(node.server!.clients.size).toBe(1));

      // Cleanup (clientSocket unused in this test, just needed for pair)
      void clientSocket;
      await node.stop();
    });
  });

  // =========================================================================
  // Becoming client
  // =========================================================================

  describe('becoming client', () => {
    it('should connect to hub using static layer address', async () => {
      const deps = createMockDeps();
      const config = createConfig(4020, join(tempDir, 'c1'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await vi.waitFor(() => expect(ready).toHaveBeenCalled());

      expect(node.role).toBe('client');
      expect(node.client).toBeDefined();
      expect(node.server).toBeUndefined();
      expect(node.io).toBeDefined();
      expect(node.bs).toBeDefined();

      await node.stop();
    });

    it('should warn and skip client creation when hub address is unknown', async () => {
      const warn = vi.fn();
      const logger = {
        info: vi.fn(),
        warn,
        error: vi.fn(),
        traffic: vi.fn(),
      };

      const deps = createMockDeps();
      const config = createConfig(4021, join(tempDir, 'c2'), { logger });
      const node = new Node(config, deps);

      await node.start();

      // Override hub to a nodeId that has no known address
      node.networkManager.assignHub('nonexistent-node-id');
      await vi.waitFor(() => expect(node.role).toBe('client'));

      // No client was created because there's no address to connect to
      expect(node.client).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'Node',
        expect.stringContaining('no hub address'),
      );

      await node.stop();
    });
  });

  // =========================================================================
  // Two-node integration — data flows through real Server↔Client wiring
  // =========================================================================

  describe('two-node integration', () => {
    it('should allow blob data to flow from hub to client', async () => {
      const transport = createTwoNodeTransport();
      const hubConfig = createConfig(5000, join(tempDir, 'hub'));
      const clientConfig = createConfig(5001, join(tempDir, 'client'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:5000' },
          probing: { enabled: false },
        },
      });

      const hubNode = new Node(hubConfig, transport.hubDeps);
      const clientNode = new Node(clientConfig, transport.clientDeps);

      // Start hub first, make it the hub
      await hubNode.start();
      await becomeHub(hubNode);

      // Start client — static layer connects it to the hub
      const clientReady = vi.fn();
      clientNode.on('ready', clientReady);
      await clientNode.start();
      await vi.waitFor(() => expect(clientReady).toHaveBeenCalled());

      // Wait for hub to register the client's socket
      await vi.waitFor(() => expect(hubNode.server!.clients.size).toBe(1));

      // Write a blob on the hub
      const { blobId } = await hubNode.bs!.setBlob('hello from hub');

      // Read it from the client — data flows over the socket pair
      const { content } = await clientNode.bs!.getBlob(blobId);
      expect(content.toString()).toBe('hello from hub');

      await clientNode.stop();
      await hubNode.stop();
    });

    it('should allow blob data to flow from client to hub', async () => {
      const transport = createTwoNodeTransport();
      const hubConfig = createConfig(5010, join(tempDir, 'hub2'));
      const clientConfig = createConfig(5011, join(tempDir, 'client2'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:5010' },
          probing: { enabled: false },
        },
      });

      const hubNode = new Node(hubConfig, transport.hubDeps);
      const clientNode = new Node(clientConfig, transport.clientDeps);

      await hubNode.start();
      await becomeHub(hubNode);

      const clientReady = vi.fn();
      clientNode.on('ready', clientReady);
      await clientNode.start();
      await vi.waitFor(() => expect(clientReady).toHaveBeenCalled());
      await vi.waitFor(() => expect(hubNode.server!.clients.size).toBe(1));

      // Write a blob on the client
      const { blobId } = await clientNode.bs!.setBlob('hello from client');

      // Read it from the hub — data flows in the opposite direction
      const { content } = await hubNode.bs!.getBlob(blobId);
      expect(content.toString()).toBe('hello from client');

      await clientNode.stop();
      await hubNode.stop();
    });
  });

  // =========================================================================
  // Role transitions
  // =========================================================================

  describe('role transitions', () => {
    it('should tear down server and close transport when hub→client', async () => {
      const deps = createMockDeps();
      const config = createConfig(4030, join(tempDir, 't1'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();

      // Override to hub (static would have made it client)
      await becomeHub(node);
      const oldServer = node.server!;
      expect(oldServer.isTornDown).toBe(false);
      expect(deps.hubTransportClosed).toBe(false);

      // Clear override — reverts to client via static layer
      node.networkManager.clearOverride();
      await vi.waitFor(() => expect(node.role).toBe('client'));

      // Old server is torn down, transport is closed
      expect(oldServer.isTornDown).toBe(true);
      expect(deps.hubTransportClosed).toBe(true);
      expect(node.server).toBeUndefined();
      expect(node.client).toBeDefined();

      await node.stop();
    });

    it('should tear down client when client→hub', async () => {
      const deps = createMockDeps();
      const config = createConfig(4031, join(tempDir, 't2'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();

      // Static layer makes this a client
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(node.role).toBe('client');
      expect(node.client).toBeDefined();

      // Now become hub
      await becomeHub(node);
      expect(ready).toHaveBeenCalledTimes(2);

      // Old client torn down, now has server
      expect(node.client).toBeUndefined();
      expect(node.server).toBeDefined();

      await node.stop();
    });

    it('should not re-transition when same hub is assigned again', async () => {
      const deps = createMockDeps();
      const config = createConfig(4032, join(tempDir, 't3'));
      const node = new Node(config, deps);

      const roleChanged = vi.fn();
      node.on('role-changed', roleChanged);

      await node.start();
      await becomeHub(node);

      const callCount = roleChanged.mock.calls.length;

      // Assign same hub again — NetworkManager deduplicates
      const nodeId = node.networkManager.getIdentity().nodeId;
      node.networkManager.assignHub(nodeId);

      // Brief pause to ensure no async event sneaks through
      await new Promise((r) => setTimeout(r, 50));
      expect(roleChanged.mock.calls.length).toBe(callCount);

      await node.stop();
    });

    it('should serialize rapid role transitions without races', async () => {
      const callOrder: string[] = [];
      let agentNum = 0;

      const createAgent = vi.fn(async (ctx: ReadyContext) => {
        const num = ++agentNum;
        callOrder.push(`create-${ctx.role}-${num}`);
        return {
          stop: async () => {
            callOrder.push(`stop-${num}`);
          },
        };
      });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(4033, join(tempDir, 't4'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();
      // Static → client, agent #1 created
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
      expect(node.role).toBe('client');

      const nm = node.networkManager;
      const myId = nm.getIdentity().nodeId;

      // Fire 3 rapid role changes synchronously:
      // assignHub → hub (queued as T1)
      // clearOverride → client (same as _role → skipped by _onRoleChanged)
      // assignHub → hub (queued as T2, stale when it runs)
      nm.assignHub(myId);
      nm.clearOverride();
      nm.assignHub(myId);

      // Wait for all queued transitions to complete
      await vi.waitFor(() => expect(node.role).toBe('hub'));

      // Only 2 agent creates: initial client + hub from T1
      // T2 was discarded as stale (role was already 'hub')
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(callOrder).toEqual([
        'create-client-1', // Initial via static
        'stop-1', // Teardown during T1
        'create-hub-2', // Setup in T1
        // T2 discarded — no more entries
      ]);

      await node.stop();
      expect(callOrder).toEqual([
        'create-client-1',
        'stop-1',
        'create-hub-2',
        'stop-2', // Agent #2 stopped on node.stop()
      ]);
    });
  });

  // =========================================================================
  // Events
  // =========================================================================

  describe('events', () => {
    it('should deliver role-changed and ready events', async () => {
      const deps = createMockDeps();
      const config = createConfig(4040, join(tempDir, 'e1'));
      const node = new Node(config, deps);

      const roleChanged = vi.fn();
      const ready = vi.fn<(ctx: ReadyContext) => void>();
      node.on('role-changed', roleChanged);
      node.on('ready', ready);

      await node.start();
      await becomeHub(node);

      expect(roleChanged).toHaveBeenCalledWith(
        expect.objectContaining({ current: 'hub' }),
      );
      expect(ready).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'hub' }),
      );

      // Ready context has server but no client for hub role
      const ctx = ready.mock.calls[0][0];
      expect(ctx.server).toBeDefined();
      expect(ctx.client).toBeUndefined();
      expect(ctx.socket).toBeUndefined();

      await node.stop();
    });

    it('should deliver ready context with client and socket for client role', async () => {
      const deps = createMockDeps();
      const config = createConfig(4045, join(tempDir, 'e6'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn<(ctx: ReadyContext) => void>();
      node.on('ready', ready);

      await node.start();
      await vi.waitFor(() => expect(ready).toHaveBeenCalled());

      expect(node.role).toBe('client');
      const ctx = ready.mock.calls[0][0];
      expect(ctx.role).toBe('client');
      expect(ctx.client).toBeDefined();
      expect(ctx.socket).toBeDefined();
      expect(ctx.server).toBeUndefined();

      // socket getter matches what was passed to ready
      expect(node.socket).toBe(ctx.socket);

      await node.stop();
    });

    it('should stop delivering events after off()', async () => {
      const deps = createMockDeps();
      const config = createConfig(4041, join(tempDir, 'e2'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const cb = vi.fn();
      node.on('role-changed', cb);

      await node.start();

      // Static makes this a client — cb fires
      await vi.waitFor(() => expect(node.role).toBe('client'));
      expect(cb).toHaveBeenCalledTimes(1);

      // Unsubscribe
      node.off('role-changed', cb);

      // Override to hub — triggers another role-changed
      await becomeHub(node);

      // cb was NOT called for the second transition
      expect(cb).toHaveBeenCalledTimes(1);

      await node.stop();
    });

    it('should support multiple listeners for the same event', async () => {
      const deps = createMockDeps();
      const config = createConfig(4042, join(tempDir, 'e3'));
      const node = new Node(config, deps);

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      node.on('ready', cb1);
      node.on('ready', cb2);

      await node.start();
      await becomeHub(node);

      await vi.waitFor(() => {
        expect(cb1).toHaveBeenCalled();
        expect(cb2).toHaveBeenCalled();
      });

      await node.stop();
    });

    it('should not throw when off() is called without prior on()', () => {
      const deps = createMockDeps();
      const config = createConfig(4043, join(tempDir, 'e4'));
      const node = new Node(config, deps);

      // off() for an event that was never subscribed — should not crash
      node.off('ready', () => {});
    });

    it('should not throw when events fire with zero listeners', async () => {
      const deps = createMockDeps();
      const config = createConfig(4044, join(tempDir, 'e5'));
      const node = new Node(config, deps);

      // No listeners subscribed at all
      await node.start();
      await becomeHub(node);

      // role-changed, ready, and stopped all fire with no listeners
      await node.stop();
    });
  });

  // =========================================================================
  // Hub migration — data survives role transitions
  // =========================================================================

  describe('hub migration', () => {
    it('should preserve blob data when transitioning hub→client', async () => {
      const deps = createMockDeps();
      const config = createConfig(6000, join(tempDir, 'hm1'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();

      // Override to hub
      await becomeHub(node);

      // Write data while hub
      const { blobId } = await node.bs!.setBlob('important data');
      const readBack = await node.bs!.getBlob(blobId);
      expect(readBack.content.toString()).toBe('important data');

      // Transition hub→client (clear override → static layer takes over)
      node.networkManager.clearOverride();
      await vi.waitFor(() => expect(node.role).toBe('client'));

      // Data written as hub is still accessible as client
      // (same BsMem instance is reused across transitions)
      const afterTransition = await node.bs!.getBlob(blobId);
      expect(afterTransition.content.toString()).toBe('important data');

      await node.stop();
    });

    it('should preserve blob data when transitioning client→hub', async () => {
      const deps = createMockDeps();
      const config = createConfig(6001, join(tempDir, 'hm2'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(node.role).toBe('client');

      // Write data while client
      const { blobId } = await node.bs!.setBlob('client-side data');

      // Transition client→hub
      await becomeHub(node);

      // Data written as client is still accessible as hub
      const afterTransition = await node.bs!.getBlob(blobId);
      expect(afterTransition.content.toString()).toBe('client-side data');

      await node.stop();
    });

    it('should preserve data across multiple role transitions', async () => {
      const deps = createMockDeps();
      const config = createConfig(6002, join(tempDir, 'hm3'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(node.role).toBe('client');

      // Write data as client
      const { blobId: blob1 } = await node.bs!.setBlob('round 1');

      // client → hub
      await becomeHub(node);
      const { blobId: blob2 } = await node.bs!.setBlob('round 2');

      // hub → client
      node.networkManager.clearOverride();
      await vi.waitFor(() => expect(node.role).toBe('client'));
      const { blobId: blob3 } = await node.bs!.setBlob('round 3');

      // client → hub again
      await becomeHub(node);

      // All three blobs survive all transitions
      expect((await node.bs!.getBlob(blob1)).content.toString()).toBe(
        'round 1',
      );
      expect((await node.bs!.getBlob(blob2)).content.toString()).toBe(
        'round 2',
      );
      expect((await node.bs!.getBlob(blob3)).content.toString()).toBe(
        'round 3',
      );

      await node.stop();
    });

    it('should allow a new client to read data from the new hub after migration', async () => {
      // Scenario: Node A is hub, writes data, then becomes client.
      // Node B becomes the new hub. A new client (Node C) connects to B
      // and should be able to read data that originated from A.
      //
      // We simulate this with two nodes: one transitions hub→client→hub,
      // then a fresh node connects and reads the preserved data.

      // Use a transport where the hub onConnection callback is updated
      // as nodes change roles.
      let currentHubOnConnection: ((socket: SocketLike) => void) | undefined;

      const nodeDeps: NodeDeps = {
        createHubTransport: async () => ({
          onConnection: (cb) => {
            currentHubOnConnection = cb;
          },
          close: async () => {
            currentHubOnConnection = undefined;
          },
        }),
        createClientTransport: async () => {
          const [serverSocket, clientSocket] = createSocketPair();
          serverSocket.connect();
          if (currentHubOnConnection) currentHubOnConnection(serverSocket);
          return clientSocket;
        },
        networkManagerOptions: { probeFn: mockProbe },
      };

      // Node A: starts as hub, writes data, transitions hub→client→hub
      const configA = createConfig(6010, join(tempDir, 'hmA'));
      const nodeA = new Node(configA, nodeDeps);

      await nodeA.start();
      await becomeHub(nodeA);

      // Write data as hub
      const { blobId } = await nodeA.bs!.setBlob('surviving data');

      // Transition: hub → client → hub (simulating a re-election cycle)
      const readyA = vi.fn();
      nodeA.on('ready', readyA);

      // Use static to force client role
      nodeA.networkManager.assignHub('some-other-node');
      await vi.waitFor(() => expect(nodeA.role).toBe('client'));

      // Back to hub (re-elected)
      await becomeHub(nodeA);

      // Now a fresh node connects as client
      const clientDeps: NodeDeps = {
        createHubTransport: async () => ({
          onConnection: () => {},
          close: async () => {},
        }),
        createClientTransport: async () => {
          const [serverSocket, clientSocket] = createSocketPair();
          serverSocket.connect();
          if (currentHubOnConnection) currentHubOnConnection(serverSocket);
          return clientSocket;
        },
        networkManagerOptions: { probeFn: mockProbe },
      };

      const configC = createConfig(6011, join(tempDir, 'hmC'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:6010' },
          probing: { enabled: false },
        },
      });
      const nodeC = new Node(configC, clientDeps);

      const readyC = vi.fn();
      nodeC.on('ready', readyC);
      await nodeC.start();
      await vi.waitFor(() => expect(readyC).toHaveBeenCalled());
      await vi.waitFor(() => expect(nodeA.server!.clients.size).toBe(1));

      // The client can read data that was written before the migration
      const result = await nodeC.bs!.getBlob(blobId);
      expect(result.content.toString()).toBe('surviving data');

      await nodeC.stop();
      await nodeA.stop();
    });
  });

  // =========================================================================
  // Agent lifecycle — createAgent factory wiring
  // =========================================================================

  describe('agent lifecycle', () => {
    it('should call createAgent on becoming hub', async () => {
      const agentStop = vi.fn();
      const createAgent = vi
        .fn<(ctx: ReadyContext) => Promise<AgentHandle>>()
        .mockResolvedValue({ stop: agentStop });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(7000, join(tempDir, 'a1'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      expect(createAgent).toHaveBeenCalledOnce();
      const ctx = createAgent.mock.calls[0][0];
      expect(ctx.role).toBe('hub');
      expect(ctx.server).toBeDefined();
      expect(ctx.client).toBeUndefined();

      await node.stop();
    });

    it('should call createAgent on becoming client', async () => {
      const agentStop = vi.fn();
      const createAgent = vi
        .fn<(ctx: ReadyContext) => Promise<AgentHandle>>()
        .mockResolvedValue({ stop: agentStop });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(7001, join(tempDir, 'a2'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalled());

      const ctx = createAgent.mock.calls[0][0];
      expect(ctx.role).toBe('client');
      expect(ctx.client).toBeDefined();
      expect(ctx.socket).toBeDefined();
      expect(ctx.server).toBeUndefined();

      await node.stop();
    });

    it('should stop previous agent before role transition', async () => {
      const callOrder: string[] = [];
      let agentCallCount = 0;

      const createAgent = vi.fn(async (ctx: ReadyContext) => {
        const agentNum = ++agentCallCount;
        callOrder.push(`create-${ctx.role}-${agentNum}`);
        return {
          stop: async () => {
            callOrder.push(`stop-${agentNum}`);
          },
        };
      });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(7002, join(tempDir, 'a3'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();
      // Static → client, agent #1 created
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));

      // Override to hub → agent #1 stopped, agent #2 created
      await becomeHub(node);
      expect(createAgent).toHaveBeenCalledTimes(2);

      // stop of agent #1 happened BEFORE create of agent #2
      expect(callOrder).toEqual(['create-client-1', 'stop-1', 'create-hub-2']);

      await node.stop();
    });

    it('should stop agent when node stops', async () => {
      const agentStop = vi.fn();
      const createAgent = vi
        .fn<(ctx: ReadyContext) => Promise<AgentHandle>>()
        .mockResolvedValue({ stop: agentStop });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(7003, join(tempDir, 'a4'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      expect(agentStop).not.toHaveBeenCalled();

      await node.stop();
      expect(agentStop).toHaveBeenCalledOnce();
    });

    it('should work without createAgent (optional)', async () => {
      const deps = createMockDeps();
      // No createAgent — should work fine
      const config = createConfig(7004, join(tempDir, 'a5'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);
      await node.stop();
      // No crash — the test IS that nothing throws
    });

    it('should create agents through multiple role transitions', async () => {
      const contexts: ReadyContext[] = [];
      const stopCalls: number[] = [];
      let agentNum = 0;

      const createAgent = vi.fn(async (ctx: ReadyContext) => {
        const num = ++agentNum;
        contexts.push(ctx);
        return {
          stop: async () => {
            stopCalls.push(num);
          },
        };
      });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(7005, join(tempDir, 'a6'), {
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();
      // → client via static (agent #1)
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));

      // → hub (stop #1, create #2)
      await becomeHub(node);

      // → client (stop #2, create #3)
      node.networkManager.clearOverride();
      await vi.waitFor(() => expect(node.role).toBe('client'));

      // → hub again (stop #3, create #4)
      await becomeHub(node);

      expect(createAgent).toHaveBeenCalledTimes(4);
      expect(contexts.map((c) => c.role)).toEqual([
        'client',
        'hub',
        'client',
        'hub',
      ]);
      // Each agent was stopped before the next was created
      expect(stopCalls).toEqual([1, 2, 3]);

      await node.stop();
      // Agent #4 stopped on node.stop()
      expect(stopCalls).toEqual([1, 2, 3, 4]);
    });

    it('should discard stale transition when node stops mid-queue', async () => {
      const deps = createMockDeps();
      const config = createConfig(7006, join(tempDir, 'a7'));
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await becomeHub(node);
      expect(ready).toHaveBeenCalledTimes(1);

      // Trigger a new role change AND call stop immediately.
      // The queued transition should not execute because _running is false.
      node.networkManager.assignHub('some-other-node');
      await node.stop();

      // Only one ready event (from becoming hub) — the queued client
      // transition was discarded because _running was set to false.
      expect(ready).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Error resilience — boundary errors must not crash the node
  // =========================================================================

  describe('error resilience', () => {
    it('should continue functioning when createAgent throws', async () => {
      const error = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        traffic: vi.fn(),
      };

      const createAgent = vi
        .fn()
        .mockRejectedValue(new Error('agent factory broke'));

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(8000, join(tempDir, 'er1'), { logger });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await becomeHub(node);

      // Ready event still fired despite agent factory throwing
      expect(ready).toHaveBeenCalledOnce();
      // Error was logged
      expect(error).toHaveBeenCalledWith(
        'Node',
        expect.stringContaining('createAgent failed'),
      );

      // Node is fully functional — can still read/write
      const { blobId } = await node.bs!.setBlob('still works');
      const { content } = await node.bs!.getBlob(blobId);
      expect(content.toString()).toBe('still works');

      await node.stop();
    });

    it('should complete transitions when agent.stop() throws', async () => {
      const error = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        traffic: vi.fn(),
      };

      let agentCallCount = 0;
      const createAgent = vi.fn(async () => {
        agentCallCount++;
        return {
          stop: async () => {
            if (agentCallCount === 1) {
              throw new Error('stop exploded');
            }
          },
        };
      });

      const deps: NodeDeps = {
        ...createMockDeps(),
        createAgent,
      };
      const config = createConfig(8001, join(tempDir, 'er2'), {
        logger,
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      await node.start();
      // Static → client, agent #1 created
      await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));

      // Transition to hub — agent #1 stop() throws, but transition continues
      await becomeHub(node);

      // Agent #2 was created despite agent #1's stop() throwing
      expect(createAgent).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        'Node',
        expect.stringContaining('Agent stop failed'),
      );

      // Node is fully functional with new server
      expect(node.server).toBeDefined();

      await node.stop();
    });

    it('should emit ready as degraded hub when transport factory throws', async () => {
      const error = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        traffic: vi.fn(),
      };

      const deps: NodeDeps = {
        createHubTransport: vi.fn().mockRejectedValue(new Error('port in use')),
        createClientTransport: async () => {
          const [, clientSocket] = createSocketPair();
          return clientSocket;
        },
        networkManagerOptions: { probeFn: mockProbe },
      };
      const config = createConfig(8002, join(tempDir, 'er3'), { logger });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await becomeHub(node);

      // Ready is still emitted — hub works locally, just can't accept connections
      expect(ready).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith(
        'Node',
        expect.stringContaining('Hub transport failed'),
      );

      // Server exists and works locally
      expect(node.server).toBeDefined();
      const { blobId } = await node.bs!.setBlob('local data');
      const { content } = await node.bs!.getBlob(blobId);
      expect(content.toString()).toBe('local data');

      await node.stop();
    });

    it('should skip client setup when transport factory throws', async () => {
      const error = vi.fn();
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        traffic: vi.fn(),
      };

      const deps: NodeDeps = {
        createHubTransport: async () => ({
          onConnection: () => {},
          close: async () => {},
        }),
        createClientTransport: vi
          .fn()
          .mockRejectedValue(new Error('connection refused')),
        networkManagerOptions: { probeFn: mockProbe },
      };
      const config = createConfig(8003, join(tempDir, 'er4'), {
        logger,
        network: {
          broadcast: { enabled: false, port: 41234 },
          cloud: { enabled: false, endpoint: '' },
          static: { hubAddress: '127.0.0.1:9999' },
          probing: { enabled: false },
        },
      });
      const node = new Node(config, deps);

      const ready = vi.fn();
      node.on('ready', ready);

      await node.start();
      await vi.waitFor(() => expect(node.role).toBe('client'));

      // No ready event — client was never created
      expect(ready).not.toHaveBeenCalled();
      expect(node.client).toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        'Node',
        expect.stringContaining('Client transport'),
      );

      // Can recover by assigning as hub
      await becomeHub(node);
      expect(ready).toHaveBeenCalledOnce();
      expect(node.server).toBeDefined();

      await node.stop();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle late connection arriving after hub teardown', async () => {
      // Use a custom transport that does NOT clear onConnection on close,
      // simulating a real transport where connections can arrive after close()
      let capturedOnConnection: ((socket: SocketLike) => void) | undefined;

      const deps: NodeDeps = {
        createHubTransport: async () => ({
          onConnection: (cb) => {
            capturedOnConnection = cb;
          },
          close: async () => {
            // Intentionally do NOT clear capturedOnConnection
            // to simulate a late connection race
          },
        }),
        createClientTransport: async () => {
          const [, clientSocket] = createSocketPair();
          return clientSocket;
        },
        networkManagerOptions: { probeFn: mockProbe },
      };

      const config = createConfig(4050, join(tempDir, 'ec1'));
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      // Capture the onConnection callback
      expect(capturedOnConnection).toBeDefined();
      const savedCb = capturedOnConnection!;

      // Stop the node — server is torn down, _server becomes undefined
      await node.stop();

      // Simulate a late connection arriving after teardown
      const [serverSocket] = createSocketPair();
      serverSocket.connect();

      // The guard `if (!this._server) return` protects against this
      await savedCb(serverSocket);
      // No crash, no assertion — the test IS that it doesn't throw
    });

    it('should use noopLogger when no logger is configured', async () => {
      const deps = createMockDeps();
      const config = createConfig(4051, join(tempDir, 'ec2'));
      // No logger — should use noopLogger silently
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      // If noopLogger wasn't used, logger calls would throw
      await node.stop();
    });

    it('should apply default network config when none provided', async () => {
      const deps = createMockDeps();
      const config: NodeConfig = {
        domain: 'test',
        port: 4052,
        route,
        identityDir: join(tempDir, 'ec3'),
        // No network config — defaults applied
      };

      const node = new Node(config, deps);
      await node.start();
      await node.stop();
    });
  });

  // =========================================================================
  // Logger
  // =========================================================================

  describe('logger', () => {
    it('should log meaningful messages during role transitions', async () => {
      const info = vi.fn();
      const logger = {
        info,
        warn: vi.fn(),
        error: vi.fn(),
        traffic: vi.fn(),
      };

      const deps = createMockDeps();
      const config = createConfig(4060, join(tempDir, 'l1'), { logger });
      const node = new Node(config, deps);

      await node.start();
      await becomeHub(node);

      // Logger should have recorded the role transition
      expect(info).toHaveBeenCalledWith('Node', expect.stringContaining('→'));
      expect(info).toHaveBeenCalledWith('Node', expect.stringContaining('hub'));

      await node.stop();
    });
  });
});
