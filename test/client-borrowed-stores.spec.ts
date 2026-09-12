// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { IoMem, SocketMock } from '@rljson/io';
import { describe, expect, it } from 'vitest';

import { Client } from '../src/client.ts';

// .............................................................................

/**
 * Who may close the local stores.
 *
 * Not a preference. A hub's cloud bridge hands its relay the SERVER's own Io,
 * so the bridge mirrors what the hub holds — and that Io goes on serving the
 * LAN after the bridge stops. A teardown that closed it took the node's store
 * away from the node: on the lab, an election burst restarted the bridge, the
 * stop closed the hub's Io, and both routes then refused to start with
 * `Local Io must be initialized and open`. Nothing reported a closed store,
 * because from the Io's side being closed is not an error.
 */
describe('Client — store ownership on tearDown', () => {
  it('closes the local Io by default, as every existing caller expects', async () => {
    const io = new IoMem();
    await io.init();
    const client = new Client(new SocketMock(), io, new BsMem());
    await client.init();

    await client.tearDown();

    expect(io.isOpen).toBe(false);
  });

  it('leaves a BORROWED local Io open', async () => {
    const io = new IoMem();
    await io.init();
    const client = new Client(new SocketMock(), io, new BsMem(), undefined, {
      ownsStores: false,
    });
    await client.init();

    await client.tearDown();

    // Still usable by its owner — which is the whole point.
    expect(io.isOpen).toBe(true);
    await expect(io.tableExists('anything')).resolves.toBe(false);
  });

  it('can be torn down twice without touching a borrowed store', async () => {
    // The bridge stops a relay on every transition it cannot prove is a no-op,
    // so a second teardown is ordinary rather than exceptional.
    const io = new IoMem();
    await io.init();
    const client = new Client(new SocketMock(), io, new BsMem(), undefined, {
      ownsStores: false,
    });
    await client.init();

    await client.tearDown();
    await client.tearDown();

    expect(io.isOpen).toBe(true);
  });
});
