// @license
// Copyright (c) 2025 Rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

// A child process speaking the ChannelSocket protocol by hand: it answers
// every acknowledged event with the arguments it got and a Buffer, and closes
// its end when asked to. Plain JavaScript, so it runs without a TypeScript
// loader — what it proves is the process channel, not the class.

const mark = '__rljsonSocket';

process.on('message', (message) => {
  if (message?.[mark] !== 'echo') return;
  // Exits without telling the parent, as a crashing worker does.
  if (message.kind === 'event' && message.event === 'die') {
    process.exit(1);
  }
  if (message.kind === 'event' && message.event === 'quit') {
    process.send({ [mark]: 'echo', kind: 'close' });
    process.exit(0);
  }
  if (message.kind === 'event' && message.ack !== undefined) {
    process.send({
      [mark]: 'echo',
      kind: 'ack',
      ack: message.ack,
      args: [
        { got: message.args, from: 'child' },
        Buffer.from('bytes from the child'),
      ],
    });
  }
});
