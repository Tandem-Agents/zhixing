import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';

// Execute production admission against deferred storage/native ports so each
// prerequisite can fail or complete independently of the operating system.
const source = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
const methods = ['#admitUi', '#resume', '#live', '#uiEnvironment'].map(name => {
  const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw Error(`Missing production method ${name}`);
  return method.getText(source);
}).join('\n');
const emitted = ts.transpileModule(`class Fixture {
  instance = 'fixture-instance'; #assets; #native = { child: {pid: 42}, spawnId: 'recovery' }; #nativeBirth = 'born';
  #abort = new AbortController(); #sealed = false; #roleIntents = {}; #startupTimer; #ui;
  options = {}; #firstFramePhase;
  #phase(_name, work) { return work(); }
  constructor(ports) { this.ports = ports; this.#assets = ports.assets; }
  #spawn(...args) { this.ports.spawn(...args); return { child: this.ports.child, resumed: false }; }
  #processIdentity() { return this.ports.identity; }
  #close(code, reason) { this.#sealed = true; this.#abort.abort(); this.ports.closed(code, reason); if(this.#ui) this.#ui.child.kill(); }
  run(verified) { return this.#admitUi('distribution', verified); }
  cancel() { this.#close(130, 'fixture-cancel'); }
  ${methods}
} exports.Fixture = Fixture;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
interface FixturePort { run(verified: Promise<boolean>): Promise<{instancePath: string; startupDeadline: number}>; cancel(): void }
const loaded: { Fixture?: new (ports: unknown) => FixturePort } = {};
new Function('exports', 'process', 'path', 'randomUUID', 'TerminalChannelRetiredError', emitted)(loaded, { platform: 'win32', env: {} }, path, randomUUID, TerminalChannelRetiredError);
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const admission = deferred<string>(), bind = deferred<void>(), verification = deferred<boolean>();
  const root = path.resolve('fixture-root'), instancePath = path.join(root, 'instance-fixture-instance');
  const assets = { root, admit: vi.fn(() => admission.promise), intent: vi.fn(async () => {}), bind: vi.fn(() => bind.promise) };
  const child = { resume: vi.fn(), kill: vi.fn() }, spawn = vi.fn(), closed = vi.fn();
  const target = new loaded.Fixture!({ assets, child, spawn, closed, identity: Promise.resolve({pid: 99, birth: 'ui', spawnId: 'ui'}) });
  const task = target.run(verification.promise); void task.catch(() => {});
  const flush = () => vi.advanceTimersByTimeAsync(0);
  return { target, task, assets, child, spawn, closed, admission, bind, verification, instancePath, flush };
}
describe('supervisor UI execution admission', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  it('overlaps suspended creation with verification and storage, but requires all admission before execution', async () => {
    const f = fixture(); await f.flush();
    expect(f.assets.admit).toHaveBeenCalledOnce(); expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.child.resume).not.toHaveBeenCalled();
    f.verification.resolve(true); await f.flush();
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.assets.intent).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
    const env = f.spawn.mock.calls[0]![4];
    expect(env.TEMP).toBe(path.join(f.instancePath, 'runtime')); expect(env.HOME).toBe(env.TEMP);
    f.admission.resolve(f.instancePath); await f.flush();
    expect(f.assets.intent).toHaveBeenCalledOnce(); expect(f.assets.bind).toHaveBeenCalledOnce(); expect(f.child.resume).not.toHaveBeenCalled();
    f.bind.resolve(); expect((await f.task).instancePath).toBe(f.instancePath);
    expect(f.child.resume).toHaveBeenCalledOnce();
  });
  it('never executes U for an invalid fixed artifact', async () => {
    const f = fixture(); f.verification.resolve(false);
    await expect(f.task).rejects.toThrow('terminal-package-integrity');
    expect(f.spawn).toHaveBeenCalledOnce(); expect(f.child.resume).not.toHaveBeenCalled();
    // The production integrity failure closes the same owner; no late storage
    // receipt can authorize the already cancelled suspended process.
    f.target.cancel(); expect(f.child.kill).toHaveBeenCalledOnce();
    f.admission.resolve(f.instancePath);
  });
  it('does not execute when storage completes ahead of verification, or after late verification on close', async () => {
    const f = fixture(); f.admission.resolve(f.instancePath); f.bind.resolve(); await f.flush();
    expect(f.child.resume).not.toHaveBeenCalled(); expect(f.assets.intent).not.toHaveBeenCalled();
    f.target.cancel(); f.verification.resolve(true);
    await expect(f.task).rejects.toBeInstanceOf(TerminalChannelRetiredError);
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.child.resume).not.toHaveBeenCalled();
  });
  it('includes incomplete verification in the same creation deadline', async () => {
    const f = fixture(); f.admission.resolve(f.instancePath); f.bind.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.closed).toHaveBeenCalledWith(78, 'terminal-startup-timeout');
    f.verification.resolve(true); await expect(f.task).rejects.toBeInstanceOf(TerminalChannelRetiredError);
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.child.resume).not.toHaveBeenCalled();
  });
  it('seals a failed storage admission and never resumes the suspended child', async () => {
    const f = fixture(); f.verification.resolve(true); await f.flush();
    f.admission.reject(Error('quota exhausted')); await expect(f.task).rejects.toThrow('quota exhausted');
    expect(f.closed).toHaveBeenCalledWith(71, 'terminal-assets-admission-failed'); expect(f.child.kill).toHaveBeenCalledOnce(); expect(f.child.resume).not.toHaveBeenCalled();
  });
  it.each(['storage', 'bind'] as const)('ignores late %s completion after cancellation', async stage => {
    const f = fixture(); f.verification.resolve(true); await f.flush();
    if (stage === 'bind') { f.admission.resolve(f.instancePath); await f.flush(); }
    f.target.cancel(); f.admission.resolve(f.instancePath); f.bind.resolve();
    await expect(f.task).rejects.toBeInstanceOf(TerminalChannelRetiredError); expect(f.child.resume).not.toHaveBeenCalled();
  });
  it('does not execute against a different returned instance path', async () => {
    const f = fixture(); f.verification.resolve(true); f.admission.resolve('different');
    await expect(f.task).rejects.toThrow('terminal-instance-path'); expect(f.assets.intent).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
  });
  it('keeps the creation deadline across slow storage admission', async () => {
    const f = fixture(); f.verification.resolve(true); await f.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.closed).toHaveBeenCalledWith(78, 'terminal-startup-timeout');
    f.admission.resolve(f.instancePath); await expect(f.task).rejects.toBeInstanceOf(TerminalChannelRetiredError);
    expect(f.child.resume).not.toHaveBeenCalled();
  });
  it('rejects a late bind even before the deadline timer callback runs', async () => {
    const f = fixture(); f.verification.resolve(true); f.admission.resolve(f.instancePath); await f.flush();
    vi.setSystemTime(Date.now() + 5001); // Elapsed wall time without firing timers.
    f.bind.resolve(); await expect(f.task).rejects.toThrow('terminal-creation-deadline');
    expect(f.closed).not.toHaveBeenCalled(); expect(f.child.resume).not.toHaveBeenCalled();
  });
});
