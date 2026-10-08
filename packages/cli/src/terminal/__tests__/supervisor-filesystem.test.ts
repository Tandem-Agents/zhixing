import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalWindowsWriterAdmission } from '../host-launch.js';
import { terminalWriterDeadline } from '../close-budget.js';

// Exercise the actual supervisor methods with finite in-memory process/pipe
// ports. No native process or TTY is started; this does not replace the seeded
// entry journey's real close and restoration receipts.
const file = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
const names = ['#acceptCreation', '#bindCreationOwner', '#settleWriter', '#newCreationOwner', '#trackHelper', '#live', '#helperLive', '#remaining'];
const methods = names.map(name => {
  const matches = declaration?.members.filter(node => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  if (matches?.length !== 1) throw Error(`Missing unique production method: ${name}`);
  return matches[0]!.getText(file);
}).join('\n');
const emitted = ts.transpileModule(`
  class FixtureSupervisor {
    #sealed = false; #executionSealed = false; #abort = new AbortController(); #deadline = 0;
    #creationConnections = new Set(); #creationOwners = new Map();
    #privateHelpers = new Map(); #channelHandoffs = new Map(); #hosts = new Map();
    #writerSettlements = new Set(); #helpers = [];
    #creationEndpoint = { address: 'fixture-control' }; #processes; #assets;
    failures = [];
    constructor(ports) {
      this.#processes = ports.processes; this.#assets = ports.assets;
      this.#creationOwners.set(ports.owner, { role: 'application', child: ports.parent });
      this.#bindCreationOwner(ports.owner, ports.parent);
      this.#acceptCreation(ports.socket);
    }
    seal() { this.#sealed = true; this.#abort.abort(); }
    get retained() { return this.#privateHelpers.size; }
    #acceptOwnerChannel() { throw Error('Unexpected POSIX port'); }
    #close(code, reason) { this.failures.push({ code, reason }); }
    ${methods}
  }
  exports.FixtureSupervisor = FixtureSupervisor;
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

class ProcessPort extends EventEmitter {
  readonly pid = 1001;
  readonly created = Promise.resolve();
  exited = false;
  cancelled = false;
  readonly kill = vi.fn(() => { this.cancelled = true; return true; });
  readonly resume = vi.fn();
  readonly verifyTarget = vi.fn((pid: number, birth: string) => ({ pid, birth }));
  readonly send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => callback(null));
  finish(code = 0) { this.exited = true; this.emit('exit', code); this.emit('close'); }
}
class SocketPort extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly messages: Record<string, unknown>[] = [];
  write(value: string) { this.messages.push(JSON.parse(value)); return true; }
  end(value?: string) { if (value) this.write(value); this.destroy(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
interface SupervisorPort { seal(): void; readonly retained: number; readonly failures: unknown[] }
const loaded: { FixtureSupervisor?: new (ports: unknown) => SupervisorPort } = {};
new Function('exports', 'process', 'randomUUID', 'isTerminalPrivateEndpoint', 'TerminalWindowsWriterAdmission', 'terminalWriterDeadline', emitted)(
  loaded, { platform: 'win32', execPath: 'fixture-node', env: {} }, randomUUID, () => true, TerminalWindowsWriterAdmission, terminalWriterDeadline,
);

function fixture(bind: () => Promise<void> = async () => {}, deadlineMs = 5000) {
  const gate = new ProcessPort(), parent = new ProcessPort(), socket = new SocketPort();
  const owner = randomUUID(), id = randomUUID(), identity = { pid: 2002, birth: '123456789' };
  const assets = { writerIntent: vi.fn(async () => {}), bindWriter: vi.fn(bind), settleWriter: vi.fn(async () => {}) };
  const processes = { children: new Set(), artifact: 'fixture-native', gate: 'fixture-gate', create: vi.fn(() => gate) };
  const supervisor = new loaded.FixtureSupervisor!({ assets, processes, owner, parent, socket });
  const deadline = Date.now() + deadlineMs;
  socket.emit('data', Buffer.from(JSON.stringify({ v: 1, owner, id, role: 'filesystem', endpoint: 'fixture-private', token: randomUUID(), deadline }) + '\n'));
  const frame = (type: string) => gate.emit('message', { type, id, ...identity });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { gate, parent, socket, assets, processes, supervisor, frame, flush, id, identity,
    async ready() {
      await flush(); frame('target'); await flush();
      expect(gate.send).toHaveBeenCalledExactlyOnceWith({ type: 'permit', id, ...identity }, expect.any(Function));
      expect(socket.messages.filter(value => value.event === 'created')).toHaveLength(0);
      frame('resumed'); await flush();
      expect(socket.messages.filter(value => value.event === 'created')).toEqual([expect.objectContaining(identity)]);
    },
    async dispose() { gate.finish(); socket.destroy(); await flush(); },
  };
}

describe('supervisor established filesystem lifetime', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([5001, 5003, 60_000])('caps a peer deadline %i ms ahead at the local creation budget', async deadlineMs => {
    const now = Date.now(), f = fixture(async () => {}, deadlineMs);
    try {
      await f.flush();
      expect(f.socket.destroyed).toBe(false);
      expect(f.processes.create).toHaveBeenCalledOnce();
      expect(f.processes.create).toHaveBeenCalledWith('fixture-gate',
        [expect.any(String), expect.any(String), String(now + 5000), f.id],
        expect.any(Object), false, false, expect.any(Object));
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.gate.kill).toHaveBeenCalled();
    } finally { await f.dispose(); }
  });

  it.each([0, -1])('rejects an expired creation deadline (%i ms)', async deadlineMs => {
    const f = fixture(async () => {}, deadlineMs);
    expect(f.socket.destroyed).toBe(true);
    expect(f.processes.create).not.toHaveBeenCalled();
    await f.dispose();
  });

  it('keeps the ready writer alive through seal and settles only its actual close', async () => {
    const f = fixture();
    try {
      await f.ready();
      f.supervisor.seal(); await vi.advanceTimersByTimeAsync(5001);
      expect(f.gate.kill).not.toHaveBeenCalled();
      expect(f.supervisor.retained).toBe(1); expect(f.assets.settleWriter).not.toHaveBeenCalled();
      f.gate.finish(); await f.flush();
      expect(f.assets.settleWriter).toHaveBeenCalledExactlyOnceWith(f.id, { ...f.identity, spawnId: f.id }, expect.any(AbortSignal));
      expect(f.supervisor.retained).toBe(0); expect(f.supervisor.failures).toEqual([]);
    } finally { await f.dispose(); }
  });

  it('cancels a pending durable bind and waits its completion before exit settlement', async () => {
    let publish!: () => void;
    const f = fixture(() => new Promise<void>(resolve => { publish = resolve; }));
    try {
      await f.flush(); f.frame('target'); await f.flush();
      expect(f.assets.bindWriter).toHaveBeenCalledTimes(1);
      f.supervisor.seal(); expect(f.gate.kill).toHaveBeenCalled();
      f.gate.finish(); await f.flush();
      expect(f.assets.settleWriter).not.toHaveBeenCalled(); expect(f.gate.send).not.toHaveBeenCalled();
      publish(); await f.flush(); f.frame('resumed'); await f.flush();
      expect(f.gate.send).not.toHaveBeenCalled();
      expect(f.socket.messages.some(value => value.event === 'created')).toBe(false);
      expect(f.assets.settleWriter).toHaveBeenCalledExactlyOnceWith(f.id, { ...f.identity, spawnId: f.id }, expect.any(AbortSignal));
    } finally { publish?.(); await f.dispose(); }
  });

  it.each(['seal', 'deadline'] as const)('keeps %s effective after permit but before successful resume', async action => {
    const f = fixture();
    try {
      await f.flush(); f.frame('target'); await f.flush();
      expect(f.gate.send).toHaveBeenCalledTimes(1);
      if (action === 'seal') f.supervisor.seal();
      else await vi.advanceTimersByTimeAsync(5000);
      f.frame('resumed'); await f.flush();
      expect(f.gate.kill).toHaveBeenCalled(); expect(f.gate.send).toHaveBeenCalledTimes(1);
      expect(f.socket.messages.some(value => value.event === 'created')).toBe(false);
      expect(f.assets.settleWriter).not.toHaveBeenCalled(); expect(f.supervisor.retained).toBe(1);
    } finally { await f.dispose(); }
  });

  it.each(['owner-exit', 'control-close', 'gate-disconnect', 'explicit-signal'] as const)('retains %s termination after successful ready', async action => {
    const f = fixture();
    try {
      await f.ready(); f.supervisor.seal();
      expect(f.gate.kill).not.toHaveBeenCalled();
      if (action === 'owner-exit') f.parent.finish();
      else if (action === 'control-close') f.socket.destroy();
      else if (action === 'gate-disconnect') f.gate.emit('disconnect');
      else f.socket.emit('data', Buffer.from(JSON.stringify({ type: 'signal', signal: 'SIGKILL' }) + '\n'));
      expect(f.gate.kill).toHaveBeenCalled();
      expect(f.assets.settleWriter).not.toHaveBeenCalled(); expect(f.supervisor.retained).toBe(1);
    } finally { await f.dispose(); }
  });
});
