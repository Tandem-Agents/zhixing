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
  #applicationStartupTimer; #firstFramePhase; #assets; #application; #applicationSpawn = 'fixture-spawn'; #applicationIntentRecorded = false;
  instance = 'fixture'; options = { entry: 'fixture-entry', home: 'fixture-home', args: [] };
  constructor(ports) { this.ports = ports; this.#application = ports.application;
    this.#assets = { intent: ports.intent, bind: ports.bind, instanceIdentity: 'fixture-identity' }; }
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
    application: { role: 'application', child: { resume: vi.fn(), transportReady: Promise.resolve(),
      send: vi.fn((_packet: unknown, done: (error?: Error | null) => void) => done()) },
      channel: { send: vi.fn(async () => {}) }, listening: listening.promise },
  };
  const target = new Fixture(ports) as { start(): Promise<void>; cancel(): void; ready: boolean };
  const task = target.start(); void task.catch(() => {});
  return { ports, target, task, listening, flush: () => vi.advanceTimersByTimeAsync(0) };
}
const preloadMethods = ['#preloadApplication', '#resume', '#live'].map(name => {
  const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(file) === name);
  if (!method) throw Error(`Production method missing: ${name}`);
  return method.getText(file);
}).join('\n');
const PreloadFixture = new Function('randomUUID', 'process', 'TerminalChannelRetiredError', ts.transpile(`class PreloadFixture {
  #abort = new AbortController(); #sealed = false; #roleIntents = {}; #applicationSpawn; #firstFramePhase;
  instance = 'fixture'; options = { entry: 'fixture-entry', home: 'fixture-home', args: [] };
  constructor(ports) { this.ports = ports; }
  #spawn(role, executable, args, stdio, env, spawnId) { this.ports.spawned.push({ role, env, spawnId }); return this.ports.application; }
  #close(code, reason) { this.#sealed = true; this.ports.closed(code, reason); }
  seal() { this.#sealed = true; }
  start() { this.#preloadApplication(); }
  ${preloadMethods}
} return PreloadFixture;`, { target: ts.ScriptTarget.ES2022 }))(randomUUID, { execPath: 'node', env: {} }, TerminalChannelRetiredError);
function preloadFixture() {
  const created = Promise.withResolvers<void>();
  let nativeCreated = false;
  void created.promise.then(() => { nativeCreated = true; });
  const resume = vi.fn(() => { if (!nativeCreated) throw Error('terminal-process-resume-closed'); });
  const ports = { spawned: [] as { role: string; env: Record<string, string>; spawnId: string }[], closed: vi.fn(),
    application: { role: 'application', resumed: false, child: { created: created.promise, resume } } };
  const target = new PreloadFixture(ports) as { start(): void; seal(): void };
  return { ports, target, created, resume };
}
describe('managed application preload', () => {
  it('creates N in preload mode without instance storage and resumes it only after native creation', async () => {
    const f = preloadFixture(); f.target.start();
    expect(f.ports.spawned).toHaveLength(1);
    expect(f.ports.spawned[0]!.env).toMatchObject({ ZHIXING_TERMINAL_ROLE: 'application', ZHIXING_TERMINAL_PRELOAD: '1' });
    expect(f.ports.spawned[0]!.env).not.toHaveProperty('ZHIXING_TERMINAL_DIRECTORY');
    expect(f.ports.spawned[0]!.env).not.toHaveProperty('ZHIXING_TERMINAL_DIRECTORY_ID');
    await Promise.resolve();
    expect(f.resume).not.toHaveBeenCalled();
    f.created.resolve(); await f.created.promise; await Promise.resolve();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.ports.closed).not.toHaveBeenCalled();
  });
  it('does not resume a preload created after the supervisor sealed', async () => {
    const f = preloadFixture(); f.target.start(); f.target.seal();
    f.created.resolve(); await f.created.promise; await Promise.resolve();
    expect(f.resume).not.toHaveBeenCalled();
  });
});
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
    intent.resolve(); await f.task; expect(f.ports.application.child.send).not.toHaveBeenCalled();
  });
  it('releases the preloaded application only after durable intent and identity binding, before waiting for its listener', async () => {
    const f = fixture(); await f.flush();
    expect(f.ports.phases).toEqual(['application-intent', 'application-identity', 'application-bind', 'application-release', 'application-listener']);
    expect(f.ports.application.child.send).toHaveBeenCalledExactlyOnceWith({ type: 'terminal-preload-release', instance: 'fixture',
      directory: 'fixture', directoryId: 'fixture-identity' }, expect.any(Function));
    expect(f.ports.bind.mock.invocationCallOrder[0]).toBeLessThan(f.ports.application.child.send.mock.invocationCallOrder[0]!);
    expect(f.ports.application.child.resume).not.toHaveBeenCalled();
    f.listening.resolve(); await f.task;
    expect(f.ports.phases.at(-1)).toBe('application-hello');
  });
  it('never releases when binding fails', async () => {
    const f = fixture(); f.ports.bind.mockRejectedValueOnce(Object.assign(Error('terminal-role-bind-order'), { code: 'EBIND' }));
    await f.flush(); await f.task.catch(() => {});
    expect(f.ports.application.child.send).not.toHaveBeenCalled();
    expect(f.ports.failures).toContainEqual({ name: 'application-bind', code: 'EBIND' });
  });
  it('cancels a slow load immediately and ignores late readiness', async () => {
    const f = fixture(); await f.flush(); f.target.cancel(); await f.task;
    f.listening.resolve(); await f.flush(); expect(f.target.ready).toBe(false);
    expect(f.ports.application.channel.send).not.toHaveBeenCalled();
    expect(f.ports.closed).toHaveBeenCalledExactlyOnceWith(0,'user-exit');
  });
});
