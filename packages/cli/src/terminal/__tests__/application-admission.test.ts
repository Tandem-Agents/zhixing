import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_LIMITS } from '../../../../terminal-ui/src/protocol.js';
import { TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';

const file = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
const methods = ['#beginApplication', '#bounded', '#live', '#resume'].map(name => {
  const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  if (!method) throw Error(`Production method missing: ${name}`);
  return method.getText(file);
}).join('\n');
const code = ts.transpile(`class Fixture {
  #abort = new AbortController(); #sealed = false; #roleIntents = {}; #applicationAdmitted; #applicationReady = false;
  #applicationStartupTimer; #firstFramePhase; #assets;
  instance = 'fixture'; options = { entry: 'fixture-entry', home: 'fixture-home', args: [] };
  constructor(ports) { this.ports = ports; this.#assets = { intent: ports.intent, bind: ports.bind }; }
  async #phase(name, work) { this.ports.phases.push(name); try { return await work(); } catch(error) { this.ports.failures.push({name, code:error.code}); throw error; } }
  #spawn() { return this.ports.application; }
  #processIdentity() { return Promise.resolve({pid:42,birth:'fixture',spawnId:'fixture'}); }
  #close(code, reason) { this.#sealed = true; this.#abort.abort(); clearTimeout(this.#applicationStartupTimer); this.ports.closed(code,reason); }
  start() { this.#beginApplication('fixture'); return this.#applicationAdmitted; }
  cancel() { this.#close(0,'user-exit'); }
  get ready() { return this.#applicationReady; }
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 });
const Fixture = new Function('randomUUID', 'TERMINAL_LIMITS', 'TerminalChannelRetiredError', 'process', code)(randomUUID, TERMINAL_LIMITS, TerminalChannelRetiredError, { execPath: 'node', env: {} });
function fixture(intent: () => Promise<void> = async () => {}) {
  const listening = Promise.withResolvers<void>();
  const ports = { intent, bind: vi.fn(async () => {}), closed: vi.fn(), phases: [] as string[], failures: [] as unknown[],
    application: { role: 'application', child: { resume: vi.fn() }, channel: { send: vi.fn(async () => {}) }, listening: listening.promise },
  };
  const target = new Fixture(ports) as { start(): Promise<void>; cancel(): void; ready: boolean };
  const task = target.start(); void task.catch(() => {});
  return { ports, target, task, listening, flush: () => vi.advanceTimersByTimeAsync(0) };
}
describe('cold application admission', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('accepts a seven-second dependency load without expiring a five-second message receipt', async () => {
    const f = fixture(); await f.flush(); await vi.advanceTimersByTimeAsync(7000);
    expect(f.ports.closed).not.toHaveBeenCalled(); expect(f.ports.application.channel.send).not.toHaveBeenCalled();
    f.listening.resolve(); await f.task;
    expect(f.target.ready).toBe(true); expect(f.ports.application.channel.send).toHaveBeenCalledExactlyOnceWith({type:'hello',role:'application'});
    await vi.advanceTimersByTimeAsync(30_000); expect(f.ports.closed).not.toHaveBeenCalled();
  });
  it('bounds a stuck load and does not reopen for a late listener', async () => {
    const f = fixture(); await f.flush(); await vi.advanceTimersByTimeAsync(30_000); await f.task;
    expect(f.ports.closed).toHaveBeenCalledWith(78,'terminal-application-startup-timeout');
    expect(f.ports.failures).toContainEqual({name:'application-listener',code:'ETIMEDOUT'});
    f.listening.resolve(); await f.flush(); expect(f.target.ready).toBe(false);
    expect(f.ports.application.channel.send).not.toHaveBeenCalled();
  });
  it('includes a blocked durable intent in the same absolute preparation deadline', async () => {
    const intent = Promise.withResolvers<void>(); const f = fixture(() => intent.promise);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.ports.closed).toHaveBeenCalledWith(78,'terminal-application-startup-timeout');
    intent.resolve(); await f.task; expect(f.ports.application.child.resume).not.toHaveBeenCalled();
  });
  it('cancels a slow load immediately and ignores late readiness', async () => {
    const f = fixture(); await f.flush(); f.target.cancel(); await f.task;
    f.listening.resolve(); await f.flush(); expect(f.target.ready).toBe(false);
    expect(f.ports.application.channel.send).not.toHaveBeenCalled();
    expect(f.ports.closed).toHaveBeenCalledExactlyOnceWith(0,'user-exit');
  });
});
