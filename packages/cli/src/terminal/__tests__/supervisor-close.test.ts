import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannel } from '../../../../terminal-ui/src/channel.js';
import type { TerminalEnvelope, TerminalMessage } from '../../../../terminal-ui/src/protocol.js';
import { terminalWriterDeadline } from '../close-budget.js';

// Load the production owner unchanged, adding only fixture access to its
// existing spawn/close ports. Native process and endpoint ports are in memory;
// the real channel framing/ACK and supervisor shutdown methods execute here.
const source = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
if (!owner) throw Error('Production supervisor missing');
const declaration = owner.getText(source);
const emitted = ts.transpileModule(declaration.slice(0, -1) + `
  fixtureOpen(processes, admitted) {
    this.#processes = processes; this.#uiReady = true;
    this.#applicationAdmitted = admitted;
    this.#spawn('application', 'fixture-node', [], [], {});
    this.#spawn('ui', 'fixture-ui', [], [], {});
    return this.#completion;
  }
  fixtureClose() { return this.#close(0, 'user-exit'); }
  get fixtureResult() { return this.#result; }
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

interface SupervisorPort {
  readonly instance: string;
  fixtureOpen(processes: unknown, admitted: Promise<void>): Promise<number>;
  fixtureClose(): Promise<void>;
  readonly fixtureResult: number;
}
class ProcessPort extends EventEmitter {
  readonly created = Promise.resolve();
  readonly birth = '123456789';
  readonly pid: number;
  exited = false;
  connected = true;
  cancelled = false;
  sendError?: Error;
  readonly received: TerminalMessage[] = [];
  peer!: TerminalChannel;
  readonly kill = vi.fn(() => { this.cancelled = true; return true; });
  readonly resume = vi.fn();
  constructor(pid: number) { super(); this.pid = pid; }
  send(packet: TerminalEnvelope, done: (error?: Error | null) => void) {
    queueMicrotask(() => {
      if (this.sendError || !this.connected) { done(this.sendError ?? Error('fixture-peer-disconnected')); return; }
      this.peer.accept(packet); done();
    });
  }
  finish(code = 0) {
    if (this.exited) return;
    this.exited = true; this.connected = false; this.peer.close();
    this.emit('disconnect'); this.emit('exit', code); this.emit('close');
  }
}
function fixture(admitted = Promise.resolve()) {
  const timeoutExit = vi.fn(), peerFailures: string[] = [], children: ProcessPort[] = [];
  const processPort = { platform: 'win32', off: vi.fn(), exit: timeoutExit };
  const Owner = new Function('process', 'randomUUID', 'TerminalPrivateEndpoint', 'TerminalChannel', 'terminalWriterDeadline', emitted + '\nreturn TerminalSupervisor;')(
    processPort, randomUUID, class { address = 'fixture-control'; async close() {} }, TerminalChannel, terminalWriterDeadline,
  ) as new (options: unknown) => SupervisorPort;
  const supervisor = new Owner({});
  const processes = {
    children: new Set<ProcessPort>(), seal: vi.fn(), terminateExecution: vi.fn(), finish: vi.fn(),
    executionState: () => ({ active: 0, creating: 0 }),
    create: () => {
      const child = new ProcessPort(children.length + 1); children.push(child); processes.children.add(child);
      child.once('close', () => processes.children.delete(child));
      child.peer = new TerminalChannel(supervisor.instance, (packet, done) => {
        queueMicrotask(() => { child.emit('message', packet); done(); });
      }, message => { child.received.push(message); }, reason => { peerFailures.push(reason); });
      return child;
    },
  };
  const completion = supervisor.fixtureOpen(processes, admitted), application = children[0]!, ui = children[1]!;
  for (const child of children) child.emit('spawn');
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { supervisor, application, ui, processes, completion, flush, peerFailures, timeoutExit,
    async finish() { for (const child of children) child.finish(); await flush(); return completion; },
  };
}

describe('supervisor cooperative role close', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['ui', 'application'] as const)('acknowledges %s exit without sending that owner a redundant close', async role => {
    const f = fixture(), exiting = f[role], other = role === 'ui' ? f.application : f.ui;
    const acknowledged = exiting.peer.send({ type: 'exit', code: 0, reason: 'user-exit' });
    await f.flush(); await acknowledged;
    expect(exiting.received).toEqual([]);
    expect(other.received).toEqual([expect.objectContaining({ type: 'close' })]);
    let completed = false; void f.completion.then(() => { completed = true; });
    exiting.finish(); await f.flush(); expect(completed).toBe(false);
    expect(await f.finish()).toBe(0);
    expect(f.peerFailures).toEqual([]); expect(f.timeoutExit).not.toHaveBeenCalled();
  });

  it('sends supervisor-initiated close to both owners and waits their actual exits', async () => {
    const f = fixture(); void f.supervisor.fixtureClose(); await f.flush();
    for (const child of [f.application, f.ui]) expect(child.received).toEqual([expect.objectContaining({ type: 'close' })]);
    let completed = false; void f.completion.then(() => { completed = true; });
    await f.flush(); expect(completed).toBe(false);
    expect(await f.finish()).toBe(0);
  });

  it('does not forward a request whose application admission finishes after seal', async () => {
    let admit!: () => void;
    const f = fixture(new Promise<void>(resolve => { admit = resolve; }));
    const request = f.ui.peer.send({ type: 'request', id: 1, action: { kind: 'status' } });
    await f.flush();
    const exit = f.ui.peer.send({ type: 'exit', code: 0, reason: 'user-exit' });
    await f.flush(); await exit; admit(); await f.flush(); await request;
    expect(f.application.received.some(message => message.type === 'request')).toBe(false);
    expect(f.supervisor.fixtureResult).toBe(0); expect(await f.finish()).toBe(0);
    expect(f.peerFailures).toEqual([]);
  });

  it.each(['invalid-envelope', 'send-error'] as const)('preserves a real %s failure after close starts', async failure => {
    const f = fixture();
    if (failure === 'send-error') f.ui.sendError = Error('fixture-real-write-failure');
    void f.supervisor.fixtureClose(); await f.flush();
    if (failure === 'invalid-envelope') f.ui.emit('message', { invalid: true });
    await f.flush(); expect(f.supervisor.fixtureResult).toBe(70);
    expect(await f.finish()).toBe(70);
  });

  it('preserves a nonzero actual writer exit during otherwise cooperative close', async () => {
    const f = fixture(); void f.supervisor.fixtureClose(); await f.flush();
    f.ui.finish(71); f.application.finish(); await f.flush();
    expect(await f.completion).toBe(74);
  });

  it('preserves a nonzero exit request received during close', async () => {
    const f = fixture(); void f.supervisor.fixtureClose(); await f.flush();
    const exit = f.ui.peer.send({ type: 'exit', code: 71, reason: 'terminal-uncaught' });
    await f.flush(); await exit;
    expect(await f.finish()).toBe(71);
  });
});
