<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Peer reads move blocks, and keep none of them

## Motivation

- `@rljson/bs` now stores and moves every blob as content-defined blocks.
  A client reads a blob's block list and then its blocks, and a peer that
  already holds a block can serve it, whichever blob it came with.
- Peer reads still asked a peer for a blob in 4 MB ranges, so a read could
  not go on from the hub where a peer broke off at a block, and a peer that
  held only some blocks of a new version could not help at all.
- And a peer read held on to what it read: every read raced the link's
  "ended" promise, which lives as long as the link. A node receiving a
  400 MB file held 447 MB of ArrayBuffers until the idle link closed a
  minute later. A 4 GB file would have held 4 GB.

## Strategy

- Ask peers for block lists and blocks, never for ranges.
- Read block by block in `PeerFirstBs`: each block from a peer that holds
  it, otherwise from the hub.
- Listen for the end of a link only while a read waits on it.

## Block reads from peers

- `PeerReads` asks the sources for `getBlobBlocks`, `getBlock` and
  `blockExists`; `getBlob`, `blobSource` and `PeerBlobSource` are gone.
  `blobTimeoutMs` bounds one block.
- `PeerFirstBs` builds `getBlob`, ranges and `getBlobStream` from the block
  calls, so a stream goes on from the hub where a peer broke off, and only
  the blocks a reader lacks are asked for at all.
- `PeerReadServer` serves the block reads, counts them in `blobReads`, and
  refuses `setBlock` and `setBlobBlocks` like every other write.

## A read keeps nothing

- A link no longer offers a promise to race. It offers `onEnd(listener)`,
  which returns how to stop listening, and calls a listener added after the
  end at once.
- `_untilEnded` listens while the read is open and stops when it settles.
- A test reads three blocks over a link that stays open, collects garbage
  and checks through `WeakRef`s that none of them is held. It fails with
  the old race and passes with the listener.

## Dependency updates

- `@rljson/bs` with blocks: `BsPeer`, `BsServer`, `BsPeerBridge` and
  `BsMulti` move one block per message; `readBlocks` and `streamBlocks`
  assemble blobs. Streams ask for up to four blocks ahead.

## Result

- The hub relays blocks; no message carries more than one block of a blob,
  and the hub keeps the blocks it relays.
- A node receiving a 400 MB file stays at 144 MB, where it reached 717 MB.
- 794 tests, 100 % coverage.

## Open Points

- Both ends of a link need this version: an older peer neither asks for
  nor answers blocks.
