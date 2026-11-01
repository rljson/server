// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';

// #############################################################################
/**
 * A two-way message channel: a child process seen from its parent, `process`
 * inside a child, a worker thread's port, or {@link createChannelPair}.
 *
 * It must carry binary data — `Uint8Array` — as such: spawn a child process
 * with `serialization: 'advanced'`. With the default JSON serialization a
 * Buffer arrives as `{ type: 'Buffer', data: [...] }`.
 */
export interface MessageChannelLike {
  /**
   * Sends a message to the other side.
   * @param message - The message.
   */
  send(message: unknown): unknown;

  /**
   * Listens for messages from the other side.
   * @param event - Always `'message'`.
   * @param listener - Called with each message.
   */
  on(event: 'message', listener: (message: unknown) => void): unknown;

  /**
   * Stops listening.
   * @param event - Always `'message'`.
   * @param listener - The listener given to {@link on}.
   */
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

/** The mark of this class's messages, beside other traffic on the channel. */
const mark = '__rljsonSocket';

/** One message between the two ends of a {@link ChannelSocket}. */
interface Envelope {
  [mark]: string;
  kind: 'event' | 'ack' | 'close';
  event?: string;
  args?: unknown[];
  ack?: number;
}

type Listener = (...args: any[]) => void;

// #############################################################################
/**
 * An `@rljson/io` {@link Socket} over a message channel — the same
 * request/acknowledge protocol `IoPeer`/`IoServer` and `BsPeer`/`BsServer`
 * speak over Socket.IO, between two processes or threads instead.
 *
 * Both ends create a `ChannelSocket` with the same `tag` on their side of the
 * channel; the tag keeps several sockets — and any other traffic — apart on
 * one channel. An event emitted with a callback as its last argument is
 * acknowledged by the other side. `Uint8Array`s arrive as Buffers.
 *
 * `disconnect()` tells the other end, which then reports `disconnect` too.
 * When the other process dies no message can say so: whoever notices — the
 * parent, on the child's exit — calls `disconnect()` on its end.
 */
export class ChannelSocket implements Socket {
  /** Whether the socket is connected. */
  connected = false;

  /** Whether the socket is disconnected. */
  disconnected = true;

  private readonly _listeners = new Map<string | symbol, Listener[]>();
  private readonly _acks = new Map<number, Listener>();
  private _nextAck = 0;

  // ...........................................................................
  /**
   * Creates one end of a socket. Nothing is received before {@link connect}.
   * @param _channel - The channel to the other end.
   * @param _tag - The socket's name, the same on both ends.
   */
  constructor(
    private readonly _channel: MessageChannelLike,
    private readonly _tag: string,
  ) {}

  // ...........................................................................
  /** Starts receiving and reports `connect`. */
  connect(): void {
    if (this.connected) return;
    this._channel.on('message', this._receive);
    this.connected = true;
    this.disconnected = false;
    this._local('connect');
  }

  // ...........................................................................
  /**
   * Stops receiving, tells the other end, and reports `disconnect`.
   * Acknowledgements still outstanding are never called.
   */
  disconnect(): void {
    if (!this.connected) return;
    this._send({ kind: 'close' });
    this._close();
  }

  // ...........................................................................
  /**
   * Listens for an event from the other end, or `connect` / `disconnect`.
   * @param eventName - The event.
   * @param listener - The listener.
   * @returns This socket.
   */
  on(eventName: string | symbol, listener: Listener): this {
    const listeners = this._listeners.get(eventName) ?? [];
    listeners.push(listener);
    this._listeners.set(eventName, listeners);
    return this;
  }

  // ...........................................................................
  /**
   * Stops listening.
   * @param eventName - The event.
   * @param listener - The listener; omit to remove all of the event.
   * @returns This socket.
   */
  off(eventName: string | symbol, listener?: Listener): this {
    if (!listener) {
      this._listeners.delete(eventName);
      return this;
    }
    const listeners = this._listeners.get(eventName) ?? [];
    this._listeners.set(
      eventName,
      listeners.filter((l) => l !== listener),
    );
    return this;
  }

  // ...........................................................................
  /**
   * Removes the listeners of an event, or of all events.
   * @param eventName - The event; omit for all.
   * @returns This socket.
   */
  removeAllListeners(eventName?: string | symbol): this {
    if (eventName === undefined) this._listeners.clear();
    else this._listeners.delete(eventName);
    return this;
  }

  // ...........................................................................
  /**
   * Sends an event to the other end. A callback as last argument is called
   * with the other end's acknowledgement. Not sent while disconnected.
   * @param eventName - The event.
   * @param args - Its arguments.
   * @returns Whether it was sent.
   */
  emit(eventName: string | symbol, ...args: any[]): boolean {
    if (!this.connected) return false;
    let ack: number | undefined;
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      ack = this._nextAck++;
      this._acks.set(ack, last as Listener);
      args = args.slice(0, -1);
    }
    this._send({ kind: 'event', event: String(eventName), args, ack });
    return true;
  }

  // ######################
  // Private
  // ######################

  /**
   * Handles a message of the channel.
   * @param message - Any message; others than this socket's are ignored.
   */
  private readonly _receive = (message: unknown): void => {
    const envelope = message as Partial<Envelope> | null;
    if (envelope?.[mark] !== this._tag) return;

    if (envelope.kind === 'close') {
      this._close();
      return;
    }

    const args = ((envelope.args ?? []) as unknown[]).map(revive);

    if (envelope.kind === 'ack') {
      const callback = this._acks.get(envelope.ack as number);
      this._acks.delete(envelope.ack as number);
      callback?.(...args);
      return;
    }

    if (envelope.ack !== undefined) {
      const ack = envelope.ack;
      args.push((...answer: unknown[]) => {
        this._send({ kind: 'ack', ack, args: answer });
      });
    }
    this._local(envelope.event as string, ...args);
  };

  // ...........................................................................
  /**
   * Sends an envelope, if connected.
   * @param envelope - The envelope without its mark.
   */
  private _send(envelope: Omit<Envelope, typeof mark>): void {
    if (!this.connected) return;
    this._channel.send({ [mark]: this._tag, ...envelope });
  }

  // ...........................................................................
  /** Ends this end: no more messages, `disconnect` reported. */
  private _close(): void {
    this._channel.off('message', this._receive);
    this.connected = false;
    this.disconnected = true;
    this._acks.clear();
    this._local('disconnect');
  }

  // ...........................................................................
  /**
   * Calls this end's listeners of an event.
   * @param eventName - The event.
   * @param args - Its arguments.
   */
  private _local(eventName: string | symbol, ...args: unknown[]): void {
    for (const listener of [...(this._listeners.get(eventName) ?? [])]) {
      listener(...args);
    }
  }
}

// .............................................................................
/**
 * Turns `Uint8Array`s — what a Buffer becomes on the way through a process
 * channel — back into Buffers, in arrays and plain objects too.
 * @param value - A received value.
 * @returns The value with Buffers.
 */
const revive = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return value.map(revive);
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const revived: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      revived[key] = revive(item);
    }
    return revived;
  }
  return value;
};

// .............................................................................
/**
 * Two connected in-process channels, for tests and docs. Messages arrive
 * asynchronously and as structured clones — Buffers as `Uint8Array`s —
 * the way a process channel with `serialization: 'advanced'` delivers them.
 * @returns The two ends.
 */
export const createChannelPair = (): [MessageChannelLike, MessageChannelLike] => {
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()];
  const end = (mine: 0 | 1): MessageChannelLike => ({
    send: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => {
        for (const listener of [...listeners[1 - mine]]) listener(copy);
      });
      return true;
    },
    on: (_event, listener) => listeners[mine].add(listener),
    off: (_event, listener) => listeners[mine].delete(listener),
  });
  return [end(0), end(1)];
};
