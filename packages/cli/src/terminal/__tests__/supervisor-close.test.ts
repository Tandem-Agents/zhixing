import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannel, TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';
import { TERMINAL_LIMITS, type TerminalEnvelope, type TerminalMessage } from '../../../../terminal-ui/src/protocol.js';
import { terminalWriterDeadline, terminalCloseDeadline } from '../close-budget.js';
import { checkpointFilesystemCompletion, retainCheckpointFilesystemCompletion } from '../../../../mesh/src/checkpoint-filesystem-completion.js';
import { beginLogPhase } from '@zhixing/core/logging';

// Load the production owner unchanged, adding only fixture access to its
// existing spawn/close ports. Native process and endpoint ports are in memory;
// the real channel framing/ACK and supervisor shutdown methods execute here.
const source = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
if (!owner) throw Error('Production supervisor missing');
const declaration = owner.getText(source);
const emitted = ts.transpileModule(declaration.slice(0, -1) + `
  fixtureOpen(processes, admitted) {
    this.#processes = processes; this.#uiReady = true; this.#applicationReady = true;
    this.#applicationAdmitted = admitted;
    Object.assign(this.#spawn('application', 'fixture-node', [], [], {}), {resumed:true,announced:true});
    Object.assign(this.#spawn('ui', 'fixture-ui', [], [], {}), {resumed:true,announced:true});
    return this.#completion;
  }
  fixtureClose(code = 0) { return this.#close(code, 'user-exit'); }
  fixtureWithoutProcesses() { this.#processes = undefined; }
  fixtureHelperLive(owner, role) { this.#helperLive(owner, role); }
  fixturePrivateHelper(child) { this.#privateHelpers.set('log-files-test', {owner:'supervisor-log-store',child}); child.once('close', () => this.#privateHelpers.delete('log-files-test')); }
  fixtureCapacity() { this.#capacity = { close() {} }; }
  fixtureAdmitLogging() { return this.#admitLogging(); }
  fixturePreparingFilesystem(close) { this.#filesystem = { close }; }
  fixtureFixedAssets(completion) { this.#fixedAssets = completion; }
  fixtureSuspend(role) { this.#owned.find(item => item.role === role).resumed = false; }
  fixtureWithoutListener(role) { this.#owned.find(item => item.role === role).announced = false; }
  fixturePreparingApplication() { this.#uiReady = false; this.#modeAdmission = true; this.#applicationReady = false; }
  fixtureApplicationAdmission(intent) {
    this.#assets = { intent, async settleRole() {}, async release() {}, async close() {} };
    this.#beginApplication('fixture-instance');
    return this.#applicationAdmitted;
  }
  get fixtureResult() { return this.#result; }
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

interface SupervisorPort {
  readonly instance: string;
  fixtureOpen(processes: unknown, admitted: Promise<void>): Promise<number>;
  fixtureClose(code?: number): Promise<void>;
  fixtureWithoutProcesses(): void;
  fixtureHelperLive(owner: string, role: string): void;
  fixturePrivateHelper(child: EventEmitter): void;
  fixtureCapacity(): void;
  fixtureAdmitLogging(): Promise<void>;
  fixturePreparingFilesystem(close: (remainingMs: number) => Promise<void>): void;
  fixtureFixedAssets(completion: Promise<void>): void;
  fixtureSuspend(role: 'application' | 'ui'): void;
  fixtureWithoutListener(role: 'application' | 'ui'): void;
  fixturePreparingApplication(): void;
  fixtureApplicationAdmission(intent: () => Promise<void>): Promise<void>;
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
  holdBusiness = false;
  readonly received: TerminalMessage[] = [];
  peer!: TerminalChannel;
  readonly kill = vi.fn(() => { this.cancelled = true; return true; });
  readonly resume = vi.fn();
  constructor(pid: number) { super(); this.pid = pid; }
  send(packet: TerminalEnvelope, done: (error?: Error | null) => void) {
    if (this.holdBusiness && packet.payload.type === 'view') return;
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
function fixture(admitted = Promise.resolve(), args: readonly string[] = [], drain?: () => Promise<void>, loggingAdmission?: () => Promise<void>) {
  const timeoutExit = vi.fn(), peerFailures: string[] = [], children: ProcessPort[] = [];
  const processPort = { platform: 'win32', off: vi.fn(), exit: timeoutExit };
  const Owner = new Function('beginLogPhase', 'process', 'randomUUID', 'TerminalPrivateEndpoint', 'TerminalChannel', 'TerminalChannelRetiredError', 'terminalWriterDeadline', 'checkpointFilesystemCompletion', 'TERMINAL_LIMITS', 'terminalCloseDeadline', emitted + '\nreturn TerminalSupervisor;')(
    beginLogPhase,
    processPort, randomUUID, class { address = 'fixture-control'; async close() {} }, TerminalChannel, TerminalChannelRetiredError, terminalWriterDeadline, checkpointFilesystemCompletion, TERMINAL_LIMITS, terminalCloseDeadline,
  ) as new (options: unknown) => SupervisorPort;
  const record = vi.fn();
  const supervisor = new Owner({ args, drain, admitted: loggingAdmission, records: { record } });
  const processes = {
    children: new Set<ProcessPort>(), seal: vi.fn(), terminateExecution: vi.fn(), finish: vi.fn(),
    executionState: () => ({ active: 0, creating: 0 }),
    create: () => {
      const child = new ProcessPort(children.length + 1); children.push(child); processes.children.add(child);
      child.once('close', () => processes.children.delete(child));
      child.peer = new TerminalChannel(supervisor.instance, (packet, done) => {
        queueMicrotask(() => { child.emit('message', packet); done(); });
      }, message => { child.received.push(message); if (message.type === 'close') child.peer.beginClose(); }, reason => { peerFailures.push(reason); });
      return child;
    },
  };
  const completion = supervisor.fixtureOpen(processes, admitted), application = children[0]!, ui = children[1]!;
  for (const child of children) child.emit('spawn');
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { supervisor, application, ui, processes, completion, flush, peerFailures, timeoutExit, record,
    async finish() { for (const child of children) child.finish(); await flush(); return completion; },
  };
}

describe('supervisor cooperative role close', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([400, 700])('waits for the logging owner before judging its %sms helper', async delay => {
    const child = new EventEmitter();
    const f = fixture(Promise.resolve(), [], () => new Promise<void>(resolve => setTimeout(() => { child.emit('close'); resolve(); }, delay)));
    f.supervisor.fixturePrivateHelper(child);
    void f.supervisor.fixtureClose(); await f.flush(); f.application.finish(); f.ui.finish();
    await vi.advanceTimersByTimeAsync(delay + 1);
    expect(await f.completion).toBe(0);
    expect(f.timeoutExit).not.toHaveBeenCalled();
  });

  it('accepts a peer deadline without renewing or borrowing the restoration reserve', async () => {
    const now = Date.now();
    expect(terminalCloseDeadline(0, now + 20_000, now)).toBe(now + 8000);
    expect(terminalCloseDeadline(now + 1000, now + 5000, now)).toBe(now + 1000);
    expect(terminalCloseDeadline(0, now + 700, now)).toBe(now + 700);
    expect(() => terminalCloseDeadline(0, NaN, now)).toThrow('terminal-close-deadline');
    const f = fixture();
    const sent = f.ui.peer.send({ type: 'exit', code: 0, reason: 'user-exit', deadline: now + 1000 });
    await f.flush(); await sent;
    expect(await f.finish()).toBe(0);
    expect(f.application.received).toContainEqual(expect.objectContaining({ type: 'close', deadline: now + 1000 }));
  });

  it.each(['application', 'ui'] as const)('cancels resumed %s before IPC exists without manufacturing a transport failure', async role => {
    const f = fixture(); f.supervisor.fixtureWithoutListener(role);
    f[role].sendError = Error('terminal-process-pipe-unavailable');
    void f.supervisor.fixtureClose(); await f.flush();
    expect(f[role].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(f[role].received).toEqual([]); expect(f.processes.finish).not.toHaveBeenCalled();
    f[role].finish(1); expect(await f.finish()).toBe(0); expect(f.peerFailures).toEqual([]);
  });

  it('retains bootstrap failure evidence before closing without requiring an application hello', async () => {
    const f = fixture(); f.supervisor.fixtureWithoutListener('application');
    const sent = f.application.peer.send({type:'exit',code:71,reason:'terminal-application-bootstrap-failed',
      bootstrapFailure:{stage:'module-load',durationMs:41,category:'system',code:'ERR_MODULE_NOT_FOUND'}});
    await f.flush(); await sent;
    expect(f.record).toHaveBeenCalledWith(expect.objectContaining({event:'failed',result:'failure',data:{
      reason:'terminal-application-bootstrap-failed',phase:'module-load',durationMs:41,failure:{category:'system',code:'ERR_MODULE_NOT_FOUND'},
    }}));
    expect(f.application.kill).not.toHaveBeenCalled(); expect(await f.finish()).toBe(71);
  });

  it.each(['application', 'ui'] as const)('cancels unexecuted %s immediately but waits its actual exit', async role => {
    const f = fixture(); f.supervisor.fixtureSuspend(role);
    void f.supervisor.fixtureClose(); await f.flush();
    expect(f[role].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(f[role].received).toEqual([]);
    expect(f.processes.finish).not.toHaveBeenCalled();
    f[role].emit('error', Error('terminal-process-create-cancelled'));
    f[role].finish(1); // Native termination, never an executed writer result.
    expect(await f.finish()).toBe(0);
  });

  it('closes preverification even when startup never constructed assets', async () => {
    const f = fixture(); let finish!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    f.supervisor.fixturePreparingFilesystem(close);
    void f.supervisor.fixtureClose(); await f.flush();
    f.application.finish(); f.ui.finish(); await f.flush();
    expect(close).toHaveBeenCalledWith(expect.any(Number)); expect(close.mock.calls).toHaveLength(1);
    expect(f.processes.finish).not.toHaveBeenCalled();
    finish(); await f.flush(); expect(await f.completion).toBe(0);
  });

  it.each([false, true])('retains fixed artifact read completion before releasing execution, failed=%s', async failed => {
    const f = fixture(); let settle!: () => void;
    const completion = new Promise<void>((resolve, reject) => { settle = () => failed ? reject(Error('file close failed')) : resolve(); });
    void completion.catch(() => {}); f.supervisor.fixtureFixedAssets(completion);
    void f.supervisor.fixtureClose(); await f.flush(); f.application.finish(); f.ui.finish(); await f.flush();
    expect(f.processes.finish).not.toHaveBeenCalled();
    settle(); await f.flush(); expect(await f.completion).toBe(failed ? 74 : 0);
  });

  it.each([false, true])('keeps the original close lifetime while a bounded filesystem rejection still owns preparation, processes=%s', async processes => {
    const f = fixture(); if (!processes) f.supervisor.fixtureWithoutProcesses();
    const completion = Promise.withResolvers<void>(); const failure = Error('bounded close');
    retainCheckpointFilesystemCompletion(failure, completion.promise);
    const close = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(failure), 1000)));
    f.supervisor.fixturePreparingFilesystem(close);
    let done = false; void f.supervisor.fixtureClose(71).then(() => { done = true; });
    f.application.finish(); f.ui.finish(); await f.flush();
    await vi.advanceTimersByTimeAsync(1200);
    expect(done).toBe(false); expect(f.processes.finish).not.toHaveBeenCalled();
    expect(f.timeoutExit).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    completion.resolve(); await f.flush();
    expect(await f.completion).toBe(71); expect(done).toBe(true);
  });

  it('does not remove the total deadline when preparation remains physically pending past the restore slice', async () => {
    const f = fixture(); f.supervisor.fixtureWithoutProcesses();
    const completion = Promise.withResolvers<void>(); const failure = Error('bounded prepare close');
    retainCheckpointFilesystemCompletion(failure, completion.promise);
    f.supervisor.fixturePreparingFilesystem(async () => { throw failure; });
    let done = false; void f.supervisor.fixtureClose(71).then(() => { done = true; });
    f.application.finish(); f.ui.finish(); await f.flush();
    await vi.advanceTimersByTimeAsync(7999);
    expect(done).toBe(false); expect(f.timeoutExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.timeoutExit).toHaveBeenCalledWith(71);
    completion.resolve(); await f.flush();
  });

  it.each([false, true])('attaches bootstrap logging once before close drain, prior admission=%s', async early => {
    const sequence: string[] = [];
    const f = fixture(Promise.resolve(), [], async () => { sequence.push('drain'); }, async () => { sequence.push('attach'); });
    f.supervisor.fixtureCapacity();
    if (early) await f.supervisor.fixtureAdmitLogging();
    void f.supervisor.fixtureClose(); await f.flush();
    expect(await f.finish()).toBe(0);
    expect(sequence).toEqual(['attach', 'drain']);
  });

  it.each([false, true])('uses actual late owner settlement within the total deadline, rejected=%s', async rejected => {
    const f = fixture(Promise.resolve(), [], () => new Promise<void>((resolve, reject) => {
      setTimeout(() => rejected ? reject(Error('real cleanup failure')) : resolve(), 1620);
    }));
    let completed = false; void f.completion.then(() => { completed = true; });
    void f.supervisor.fixtureClose(); await f.flush();
    f.application.finish(); f.ui.finish(); await f.flush();
    await vi.advanceTimersByTimeAsync(1601);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(await f.completion).toBe(rejected ? 74 : 0);
    expect(f.timeoutExit).not.toHaveBeenCalled();
  });

  it.each([false, true])('cancels pending N admission without granting requests, rejected=%s', async rejected => {
    const f = fixture();
    f.supervisor.fixturePreparingApplication();
    let settle!: () => void;
    const admitted = f.supervisor.fixtureApplicationAdmission(() => new Promise<void>((resolve, reject) => {
      settle = () => rejected ? reject(Error('admission cancelled')) : resolve();
    }));
    const ready = f.ui.peer.send({ type: 'ready', frameId: 1 });
    await f.flush(); await ready;
    expect(f.application.received).toEqual([]);
    void f.supervisor.fixtureClose(); settle(); await f.flush();
    await admitted;
    expect(f.ui.received.some(message => message.type === 'application-ready')).toBe(false);
    expect(f.application.received).toEqual([expect.objectContaining({ type: 'close' })]);
    expect(f.processes.children.size).toBe(2);
    expect(await f.finish()).toBe(0);
    expect(f.peerFailures).toEqual([]);
  });

  it('fails a rejected N admission while the surface is still open', async () => {
    const f = fixture();
    const rejected = expect(f.supervisor.fixtureApplicationAdmission(async () => { throw Error('durable intent rejected'); })).rejects.toThrow('durable intent rejected');
    await f.flush(); await rejected;
    expect(await f.finish()).toBe(71);
  });

  it.each([0, 71])('retires an in-flight two-hop display without hiding an actual owner exit %s', async code => {
    const f = fixture(); f.ui.holdBusiness = true;
    const pending = f.application.peer.send({ type: 'view', view: { generation: 1, kind: 'conversation', title: 'late' } }).catch(error => error);
    await f.flush();
    f.ui.peer.beginClose();
    const notified = f.ui.peer.send({ type: 'exit', code: 0, reason: 'user-exit' });
    await f.flush(); await notified;
    expect(await pending).toBeInstanceOf(TerminalChannelRetiredError);
    f.ui.finish(); f.application.finish(code); await f.flush();
    expect(await f.completion).toBe(code ? 74 : 0);
    expect(f.peerFailures).toEqual([]);
  });

  it('drains only the logging worker tree before sealing native creation', async () => {
    let drained!: () => void;
    const f = fixture(Promise.resolve(), [], () => new Promise<void>(resolve => { drained = resolve; }));
    void f.supervisor.fixtureClose(); await f.flush();
    for (const [owner, role] of [['supervisor', 'log-store'], ['application', 'log-store'], ['application', 'log-files'], ['application', 'writer-observer'], ['log-store', 'log-files'], ['log-files', 'filesystem'], ['log-store', 'writer-observer'], ['writer-observer', 'writer-observer']]) {
      expect(() => f.supervisor.fixtureHelperLive(owner!, role!)).not.toThrow();
    }
    for (const role of ['filesystem', 'credential', 'clipboard', 'mcp-probe', 'managed-service']) {
      expect(() => f.supervisor.fixtureHelperLive('application', role)).toThrow('terminal-admission-closed');
    }
    f.application.finish(); f.ui.finish(); await f.flush();
    expect(f.processes.seal).not.toHaveBeenCalled();
    drained(); await f.flush(); expect(await f.completion).toBe(0);
    expect(f.processes.seal).toHaveBeenCalledOnce();
    expect(() => f.supervisor.fixtureHelperLive('log-files', 'filesystem')).toThrow('terminal-admission-closed');
  });

  it('never extends the writer deadline for a late logging helper', async () => {
    const f = fixture(); void f.supervisor.fixtureClose(); await f.flush();
    await vi.advanceTimersByTimeAsync(7500);
    expect(() => f.supervisor.fixtureHelperLive('log-store', 'log-files')).toThrow('terminal-admission-closed');
    expect(await f.finish()).toBe(74);
  });

  it('preserves interruption when the UI closes an unfinished independent command', async () => {
    const f = fixture(Promise.resolve(), ['pair']);
    const sent = f.ui.peer.send({ type: 'exit', code: 0, reason: 'user-exit' });
    await f.flush(); await sent;
    expect(await f.finish()).toBe(130);
  });

  it.each([0, 1])('preserves application outcome %s after an independent result page is dismissed', async code => {
    const f = fixture(Promise.resolve(), ['backup', 'root', 'approve-reset']);
    const sent = f.application.peer.send({ type: 'exit', code, reason: 'command-completed' });
    await f.flush(); await sent;
    expect(await f.finish()).toBe(code);
  });

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

  it('forwards background task status without replacing an active confirmation page', async () => {
    const f = fixture();
    const confirmation: TerminalMessage = { type: 'view', view: { generation: 1, kind: 'confirmation', title: 'Confirm', requestId: 'confirmation-1', choices: [{ id: 'reject', label: 'Reject' }] } };
    const task: TerminalMessage = { type: 'task-status', status: { summary: { conversationId: 'conversation-1', state: 'ready', text: 'Task (0/1)' } } };
    const opening = f.application.peer.send(confirmation); await f.flush(); await opening;
    const background = f.application.peer.send(task); await f.flush(); await background;
    expect(f.ui.received).toEqual([confirmation, task]);
    expect(f.peerFailures).toEqual([]);
    void f.supervisor.fixtureClose(); await f.flush();
    expect(await f.finish()).toBe(0);
  });

  it('does not grant requests when application admission finishes after seal', async () => {
    let admit!: () => void;
    const f = fixture(new Promise<void>(resolve => { admit = resolve; }));
    f.supervisor.fixturePreparingApplication();
    const ready = f.ui.peer.send({ type: 'ready', frameId: 1 });
    await f.flush(); await ready;
    f.ui.peer.beginClose();
    const exit = f.ui.peer.send({ type: 'exit', code: 0, reason: 'user-exit' });
    await f.flush(); await exit; admit(); await f.flush();
    expect(f.ui.received.some(message => message.type === 'application-ready')).toBe(false);
    expect(f.application.received.some(message => message.type === 'request')).toBe(false);
    expect(f.supervisor.fixtureResult).toBe(0); expect(await f.finish()).toBe(0);
    expect(f.peerFailures).toEqual([]);
  });

  it('acknowledges the first frame while cold application preparation takes longer than a delivery window', async () => {
    let admit!: () => void;
    const f = fixture(new Promise<void>(resolve => { admit = resolve; }));
    f.supervisor.fixturePreparingApplication();
    const ready = f.ui.peer.send({ type: 'ready', frameId: 1 });
    await f.flush(); await ready;
    await vi.advanceTimersByTimeAsync(7000);
    expect(f.ui.received).toEqual([]); expect(f.peerFailures).toEqual([]);
    expect(f.supervisor.fixtureResult).toBe(0);
    admit(); await f.flush();
    expect(f.ui.received).toEqual([{ type: 'application-ready' }]);
    void f.supervisor.fixtureClose(); await f.flush(); expect(await f.finish()).toBe(0);
  });

  it.each(['application', 'ui'] as const)('treats an unrequested zero-code %s exit as failure', async role => {
    const f = fixture(); f[role].emit('exit', 0); await f.flush();
    expect(f.supervisor.fixtureResult).toBe(71);
    expect(await f.finish()).toBe(71);
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
