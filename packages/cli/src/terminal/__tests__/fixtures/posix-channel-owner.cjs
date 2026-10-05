// Owned native fixture. No pathname listener, user IO, or external service.
'use strict';
const net = require('node:net'), native = require(process.argv[2]);
const control = new net.Socket({ fd: 4, readable: true, writable: true });
const parent = new net.Socket({ fd: 3, readable: true, writable: true });
const bundles = new Map();
const timer = setTimeout(() => process.exit(124), 7000);
let buffer = '';
const send = value => control.write(JSON.stringify(value) + '\n');
function plan() {
  const program = 'process.stdin.once("data",data=>{process.stdout.end(Buffer.concat([Buffer.from("私有:"),data]));process.stderr.end("fixture-error")})';
  const strings = [process.execPath, process.cwd(), '-e', program];
  const length = 12 + strings.reduce((sum, text) => sum + 4 + Buffer.byteLength(text), 0);
  const bytes = Buffer.alloc(length + 4); bytes.writeUInt32BE(length); bytes.writeUInt32BE(1, 4); bytes.writeUInt32BE(2, 8); bytes.writeUInt32BE(0, 12);
  let offset = 16;
  for (const text of strings) { const size = Buffer.byteLength(text); bytes.writeUInt32BE(size, offset); offset += 4; bytes.write(text, offset); offset += size; }
  return bytes;
}
const poll = setInterval(() => {
  for (let count = 0; count < 32; count++) {
    const value = native.receiveChannels(); if (!value) break;
    if (bundles.has(value.ticket) || value.fds.length !== 4) process.exit(65);
    const sockets = value.fds.map(fd => new net.Socket({ fd, readable: true, writable: true }));
    for (const socket of sockets) socket.on('error', () => {});
    bundles.set(value.ticket, sockets); send({ event: 'received', ticket: value.ticket, generation: value.generation });
  }
}, 2);
control.on('data', data => {
  buffer += data; if (buffer.length > 4096) process.exit(65);
  for (;;) {
    const end = buffer.indexOf('\n'); if (end < 0) return;
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.type === 'close') {
      clearTimeout(timer); clearInterval(poll);
      for (const sockets of bundles.values()) for (const socket of sockets) socket.destroy();
      control.end(); parent.end(); require('node:fs').closeSync(5); return;
    }
    const sockets = bundles.get(message.ticket); if (!sockets) process.exit(65);
    if (message.type === 'discard') { for (const socket of sockets) socket.destroy(); bundles.delete(message.ticket); send({ event: 'discarded', ticket: message.ticket }); continue; }
    if (message.type !== 'deliver') process.exit(65);
    let output = Buffer.alloc(0), error = Buffer.alloc(0), ended = 0;
    const done = () => { if (++ended === 2) send({ event: 'result', ticket: message.ticket, output: output.toString(), error: error.toString() }); };
    sockets[2].on('data', data => { output = Buffer.concat([output, data]); if (output.length > 4096) process.exit(65); });
    sockets[3].on('data', data => { error = Buffer.concat([error, data]); if (error.length > 4096) process.exit(65); });
    sockets[2].once('end', done); sockets[3].once('end', done);
    sockets[0].end(plan()); sockets[1].end('input');
  }
});
control.on('error', () => process.exit(73)); control.once('close', () => { clearTimeout(timer); clearInterval(poll); });
send({ event: 'ready' });
