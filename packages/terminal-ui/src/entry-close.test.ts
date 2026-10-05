import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { TerminalChannel } from './channel.js';
import type { TerminalEnvelope } from './protocol.js';

const source = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
const begin = source.indexOf('function close('), end = source.indexOf("\ntransport.on('message'", begin);
if (begin < 0 || end < begin) throw Error('Production UI close function missing');
const closeCode = ts.transpile(source.slice(begin, end), { target: ts.ScriptTarget.ES2022 });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const ticks = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function harness(options: { holdAck?: boolean; failExit?: boolean; dispose?: () => Promise<void> } = {}) {
  let transportClosed = false, closeUi!: (reason: string, code: number, notify?: boolean) => Promise<void>;
  const toS: TerminalEnvelope[] = [], toU: TerminalEnvelope[] = [], acknowledgements: ((error?: Error) => void)[] = [];
  const failures: string[] = [], sent: TerminalEnvelope[] = [];
  const processPort = { exitCode: undefined as number | undefined, stdin: { pause() {}, unref() {} } };
  const dispose = vi.fn(options.dispose ?? (() => Promise.resolve()));
  const instance = '11111111-1111-4111-8111-111111111111';
  const ui = new TerminalChannel(instance, (packet, done) => {
    if (transportClosed || (options.failExit && packet.payload.type === 'exit')) { done(Error('synthetic closed pipe')); return; }
    sent.push(packet); toS.push(packet);
    if (options.holdAck && packet.payload.type === 'ack') acknowledgements.push(error => done(error)); else done();
  }, message => { if (message.type === 'close') void closeUi('supervisor-close', 0, false); }, reason => failures.push('U:' + reason));
  const supervisor = new TerminalChannel(instance, (packet, done) => {
    if (transportClosed) { done(Error('synthetic closed pipe')); return; }
    toU.push(packet); done();
  }, message => {
    if (message.type === 'exit') void supervisor.send({ type: 'close', deadline: Date.now() + 2000 }).catch(() => {});
  }, reason => failures.push('S:' + reason));
  const transport = { get connected() { return !transportClosed; }, close() { transportClosed = true; } };
  // Execute the production function with two real bounded channels; only the
  // process, renderer and pipe endpoints are controlled in this finite test.
  closeUi = new Function('channel', 'transport', 'process', 'rootValue', `
    let closing, phase = 'active', initializing;
    let root = rootValue;
    const abort = new AbortController(), input = { cancel() {} }, pending = new Map();
    const rejectAdmission = () => {};
    ${closeCode}
    return close;
  `)(ui, transport, processPort, { dispose });
  cleanup.push(() => { for (const done of acknowledgements.splice(0)) done(); ui.close(); supervisor.close(); });
  return { closeUi, dispose, failures, sent, processPort, transport,
    releaseFirstAcknowledgement() { const done = acknowledgements.shift(); if (!done) throw Error('Missing held ACK'); done(); },
    releaseAcknowledgements(error?: Error) { for (const done of acknowledgements.splice(0)) done(error); },
    async pump() {
      for (let index = 0; index < 12; index++) {
        await ticks();
        const count = toS.length + toU.length;
        for (const packet of toS.splice(0)) supervisor.accept(packet);
        for (const packet of toU.splice(0)) ui.accept(packet);
        if (!count) { await ticks(); if (!toS.length && !toU.length) return; }
      }
      throw Error('Bounded close pump did not settle');
    },
    closeFromSupervisor() { return supervisor.send({ type: 'close', deadline: Date.now() + 2000 }); },
    replyFromSupervisor() { return supervisor.send({ type: 'reply', id: 1, value: { accepted: true } }); },
  };
}

describe('UI close retains its control receipts', () => {
  it('keeps the exit transport until S accepts exit and its close ACK is written', async () => {
    const h = harness({ holdAck: true });
    const closing = h.closeUi('user-exit', 0);
    await ticks();
    expect(h.dispose).toHaveBeenCalledOnce(); expect(h.transport.connected).toBe(true);
    await h.pump();
    expect(h.sent.some(packet => packet.payload.type === 'ack')).toBe(true);
    expect(h.transport.connected).toBe(true);
    h.releaseAcknowledgements(); await closing;
    expect(h.transport.connected).toBe(false); expect(h.processPort.exitCode).toBe(0); expect(h.failures).toEqual([]);
  });

  it('acknowledges a supervisor close before releasing that transport', async () => {
    const h = harness({ holdAck: true });
    const notified = h.closeFromSupervisor();
    await h.pump(); await notified;
    expect(h.transport.connected).toBe(true);
    h.releaseAcknowledgements(); await h.closeUi('supervisor-close', 0, false);
    expect(h.processPort.exitCode).toBe(0); expect(h.failures).toEqual([]);
  });

  it('waits for the actual body disposal after the control handshake', async () => {
    let release!: () => void;
    const disposed = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
    const h = harness({ dispose: () => disposed });
    const closing = h.closeUi('user-exit', 0);
    await h.pump(); expect(h.transport.connected).toBe(true);
    release(); await closing;
    expect(h.processPort.exitCode).toBe(0); expect(h.failures).toEqual([]);
  });

  it('preserves an actual notification failure while still disposing the UI', async () => {
    const h = harness({ failExit: true });
    await h.closeUi('user-exit', 0);
    expect(h.dispose).toHaveBeenCalledOnce(); expect(h.transport.connected).toBe(false);
    expect(h.processPort.exitCode).toBe(71); expect(h.failures).toEqual(['U:terminal-send-failed']);
  });

  it('retains an ACK write failure that finishes while body disposal is still pending', async () => {
    let release!: () => void;
    const disposed = new Promise<void>(resolve => { release = resolve; }); cleanup.push(() => release());
    const h = harness({ holdAck: true, dispose: () => disposed });
    const notified = h.closeFromSupervisor();
    await h.pump(); await notified;
    h.releaseAcknowledgements(Error('synthetic ACK write failure')); await ticks();
    expect(h.transport.connected).toBe(true);
    release(); await h.closeUi('supervisor-close', 0, false);
    expect(h.processPort.exitCode).toBe(71); expect(h.failures).toEqual(['U:terminal-ack-failed']);
  });

  it.each([false, true])('retains a reply accepted during drain, including its later failure=%s', async fail => {
    const h = harness({ holdAck: true });
    const notified = h.closeFromSupervisor();
    await h.pump(); await notified;
    const late = h.replyFromSupervisor();
    await h.pump(); await late;
    h.releaseFirstAcknowledgement(); await ticks();
    expect(h.transport.connected).toBe(true); expect(h.processPort.exitCode).toBeUndefined();
    h.releaseAcknowledgements(fail ? Error('synthetic late reply ACK failure') : undefined);
    await h.closeUi('supervisor-close', 0, false);
    expect(h.transport.connected).toBe(false); expect(h.processPort.exitCode).toBe(fail ? 71 : 0);
    expect(h.failures).toEqual(fail ? ['U:terminal-ack-failed'] : []);
  });
});
