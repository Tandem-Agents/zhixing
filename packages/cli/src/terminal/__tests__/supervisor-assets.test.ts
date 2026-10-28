import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultDeviceCapacityPolicy, DefaultDeviceCapacityArbiter, DeviceCapacityAdmissionError, DeviceCapacityStepError } from '@zhixing/core/resources';
import { TerminalInstanceAssets, type TerminalIdentityResolver } from '../instance-assets.js';
import type { LogDraft, LogRecordPort } from '@zhixing/core/logging';
import { checkpointFilesystemCompletion } from '../../../../mesh/src/checkpoint-filesystem-completion.js';
import { TERMINAL_LIMITS } from '../../../../terminal-ui/src/protocol.js';
import { TerminalChannel } from '../../../../terminal-ui/src/channel.js';
import { recordTerminalFailure, TERMINAL_ASSET_FAILURE_CODES } from '../failure.js';
import { TerminalAssetClient } from '../asset-client.js';

// 执行生产的 S 资产请求处理：存储账户换成可控替身，期限常量由用例注入（生产值另行核对）
const source = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const helpers = ['capacityAdmission', 'retryableAssetDelayMs', 'assetFailureCode'].map(name => {
  const node = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw Error(`Missing production helper ${name}`);
  return node.getText(source);
}).join('\n');
const deadlineDeclaration = source.statements.find((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement) &&
  statement.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'ASSET_OPERATION_DEADLINE_MS'));
const productionDeadlineMs = Number(deadlineDeclaration?.declarationList.declarations[0]?.initializer?.getText(source).replaceAll('_', ''));
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === '#assetRequest');
if (!method) throw Error('Missing production method #assetRequest');
const emitted = ts.transpileModule(`${helpers}
class Fixture {
  #assets; #lastAssetRequest = 0; #abort = new AbortController(); #sealed = false; options;
  constructor(ports) { this.ports = ports; this.#assets = ports.assets; this.options = { records: ports.records }; }
  #live() { this.ports.live(); }
  #close(code, reason) { this.#sealed = true; this.ports.closed(code, reason); }
  request(item, message) { return this.#assetRequest(item, message); }
  stop() { this.#abort.abort(); }
  ${method.getText(source)}
} exports.Fixture = Fixture;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

interface AssetsPort { reserve(...args: unknown[]): Promise<string>; settle(...args: unknown[]): Promise<void>; released(...args: unknown[]): Promise<void> }
interface FixturePort { request(item: unknown, message: unknown): Promise<void>; stop(): void }
function fixture(assets: Partial<AssetsPort>, deadlineMs = 300) {
  const loaded: { Fixture?: new (ports: unknown) => FixturePort } = {};
  new Function('exports', 'TERMINAL_LIMITS', 'checkpointFilesystemCompletion', 'recordTerminalFailure', 'TERMINAL_ASSET_FAILURE_CODES', 'ASSET_OPERATION_DEADLINE_MS', emitted)(
    loaded, TERMINAL_LIMITS, checkpointFilesystemCompletion, recordTerminalFailure, TERMINAL_ASSET_FAILURE_CODES, deadlineMs);
  const entries: LogDraft[] = [];
  const records: LogRecordPort = { record: value => { entries.push(typeof value === 'function' ? value() : value); } };
  const send = vi.fn(async (_message: unknown) => {}), closed = vi.fn(), live = vi.fn();
  const target = new loaded.Fixture!({ assets: { reserve: vi.fn(), settle: vi.fn(), released: vi.fn(), ...assets }, records, closed, live });
  const item = { role: 'application', channel: { send } };
  let id = 0;
  const reserve = (bucket = 'display', bytes = 4096) => target.request(item, { type: 'assets', id: ++id, operation: { kind: 'reserve', bucket, bytes } });
  return { target, item, send, closed, live, entries, reserve, request: (operation: unknown) => target.request(item, { type: 'assets', id: ++id, operation }) };
}
const backpressured = (retryAfterMs = 10) => new DeviceCapacityAdmissionError({ kind: 'backpressured', blockedBy: 'slots', retryAfterMs });
const failures = (entries: LogDraft[]) => entries.filter(entry => entry.event === 'terminalFailure');

describe('S 的实例存储账户请求：可重试的背压期限内接续，其余如实回原因', () => {
  it('期限留在 N 的结果超时与通道投递超时之内', () => {
    expect(productionDeadlineMs).toBeGreaterThan(0);
    expect(productionDeadlineMs).toBeLessThanOrEqual(TERMINAL_LIMITS.deliveryTimeoutMs - 1000);
  });

  it('容量许可被背压时接续，随后授予即回结果，不记失败', async () => {
    const reserve = vi.fn().mockRejectedValueOnce(backpressured()).mockRejectedValueOnce(backpressured()).mockResolvedValue('token-1');
    const f = fixture({ reserve });
    await f.reserve();
    expect(reserve).toHaveBeenCalledTimes(3);
    for (const call of reserve.mock.calls) expect(call[2]).toBeInstanceOf(AbortSignal);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, token: 'token-1' });
    expect(failures(f.entries)).toHaveLength(0);
    expect(f.entries.filter(entry => entry.event === 'terminalAssetRetried')).toEqual([expect.objectContaining({ result: 'success', data: expect.objectContaining({
      asset: { operation: 'reserve', bucket: 'display', bytes: 4096, attempts: 3, retriedOn: 'terminal-assets-capacity-backpressured',
        capacity: { kind: 'backpressured', blockedBy: 'slots', retryAfterMs: 10 } } }) })]);
  });

  it('一次即完成的请求不留接续记录', async () => {
    const f = fixture({ reserve: vi.fn().mockResolvedValue('token-2') });
    await f.reserve();
    expect(f.entries).toHaveLength(0);
  });

  it('实例根的锁正忙与根目录在两次读之间变化同样接续', async () => {
    const settle = vi.fn().mockRejectedValueOnce(Error('terminal-root-busy')).mockRejectedValueOnce(Error('terminal-root-changing')).mockResolvedValue(undefined);
    const f = fixture({ settle });
    await f.request({ kind: 'settle', token: '6f2b1c9e-0d2f-4c39-9a51-2b7f8d0c1a33', bytes: 0 });
    expect(settle).toHaveBeenCalledTimes(3);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, token: undefined });
  });

  it('下一次接续会越过期限时不再等待，回背压原因并记录容量结论与尝试次数', async () => {
    const reserve = vi.fn().mockRejectedValue(backpressured(500));
    const f = fixture({ reserve }, 300);
    await f.reserve('input', 8192);
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true, reason: 'terminal-assets-capacity-backpressured' });
    expect(failures(f.entries)[0]?.data).toMatchObject({ reason: 'terminal-assets-operation-failed',
      failure: { category: 'terminal', code: 'terminal-assets-capacity-backpressured' },
      asset: { operation: 'reserve', bucket: 'input', bytes: 8192, attempts: 1, capacity: { kind: 'backpressured', blockedBy: 'slots', retryAfterMs: 500 } } });
  });

  it('期限到达时由截止信号结束正在等待的尝试，记期限原因与最后一次接续针对的原因', async () => {
    let calls = 0;
    const reserve = vi.fn((_bucket: unknown, _bytes: unknown, signal: AbortSignal) => {
      // 第一次立即背压；第二次像真实的许可申请一样一直等待，直到信号结束才以 cancelled 返回
      if (++calls === 1) return Promise.reject(backpressured());
      return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DeviceCapacityAdmissionError({ kind: 'cancelled' })), { once: true }));
    });
    const f = fixture({ reserve }, 120);
    const started = performance.now();
    await f.reserve();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true, reason: 'terminal-assets-deadline' });
    expect(failures(f.entries)[0]?.data).toMatchObject({ failure: { code: 'terminal-assets-deadline' },
      asset: { operation: 'reserve', attempts: 2, capacity: { kind: 'cancelled' }, retriedOn: 'terminal-assets-capacity-backpressured' } });
  });

  it('S 自身中止时不把结束算作期限到达', async () => {
    const reserve = vi.fn((_bucket: unknown, _bytes: unknown, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DeviceCapacityAdmissionError({ kind: 'cancelled' })), { once: true })));
    const f = fixture({ reserve }, 5000);
    const task = f.reserve();
    await vi.waitFor(() => expect(reserve).toHaveBeenCalledOnce());
    f.target.stop(); await task;
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true });
  });

  it.each(['terminal-disk-capacity', 'terminal-root-capacity', 'terminal-instance-display-capacity', 'terminal-storage-reservation-slots', 'terminal-storage-settlement'])
  ('%s 不接续，原因码原样到达 N 并记录', async code => {
    const reserve = vi.fn().mockRejectedValue(Error(code));
    const f = fixture({ reserve });
    await f.reserve('display', 65536);
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true, reason: code });
    expect(failures(f.entries)[0]?.data).toMatchObject({ failure: { code }, asset: { operation: 'reserve', bucket: 'display', bytes: 65536, attempts: 1 } });
  });

  it('策略装不下的容量缺口与许可步骤不足不接续，以派生原因码回', async () => {
    const gap = vi.fn().mockRejectedValue(new DeviceCapacityAdmissionError({ kind: 'capacity-gap', blockedBy: 'memoryReservationBytes', required: 2, available: 1 }));
    const a = fixture({ reserve: gap });
    await a.reserve();
    expect(gap).toHaveBeenCalledOnce();
    expect(a.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true, reason: 'terminal-assets-capacity-gap' });
    expect(failures(a.entries)[0]?.data).toMatchObject({ asset: { capacity: { kind: 'capacity-gap', blockedBy: 'memoryReservationBytes' } } });
    const step = vi.fn().mockRejectedValue(new DeviceCapacityStepError('Device capacity permit cannot cover the next atomic step'));
    const b = fixture({ reserve: step });
    await b.reserve();
    expect(step).toHaveBeenCalledOnce();
    expect(b.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true, reason: 'terminal-assets-capacity-step' });
  });

  it('未知错误不接续、不外传原文，只回失败', async () => {
    const reserve = vi.fn().mockRejectedValue(Error('C:/private-home/secret token value'));
    const f = fixture({ reserve });
    await f.reserve();
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, failed: true });
    expect(JSON.stringify(f.entries)).not.toMatch(/secret|private-home/u);
  });
});

describe('真实容量仲裁与实例根上的接续', () => {
  const homes: string[] = [];
  const owners: TerminalInstanceAssets[] = [];
  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.close();
    for (const home of homes.splice(0)) {
      const resolved = path.resolve(home), temporary = path.resolve(os.tmpdir()) + path.sep;
      if (!resolved.startsWith(temporary) || !path.basename(resolved).startsWith('zhixing-terminal-assets-')) throw Error('Unexpected cleanup boundary');
      await rm(resolved, { recursive: true, force: true });
    }
  });

  it('临时空间样本缺失 1.2 秒：直接预留在 1 秒许可等待后被背压拒绝，S 的请求经接续完成', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'zhixing-terminal-assets-')); homes.push(home);
    // 生产仲裁器与策略；只有压力探针可控：样本缺失期间不给临时空间余量（与磁盘样本过期时一致）
    let missingUntil = 0;
    const arbiter = new DefaultDeviceCapacityArbiter({ policy: createDefaultDeviceCapacityPolicy(), probe: () => ({
      cpuBusyRatio: 0, availableMemoryBytes: 8 * 1024 ** 3, processRssBytes: 0,
      ...(performance.now() < missingUntil ? {} : { temporaryBytesAvailable: 64 * 1024 ** 3 }),
    }) });
    const identity: TerminalIdentityResolver = { async read(pid) { return pid === process.pid ? { kind: 'present', birth: 'synthetic-self-birth' } : { kind: 'absent' }; } };
    const assets = new TerminalInstanceAssets(home, arbiter, identity); owners.push(assets);
    const signal = new AbortController().signal;
    await assets.admit(randomUUID(), { pid: process.pid, birth: 'synthetic-self-birth', spawnId: randomUUID() }, signal);

    missingUntil = performance.now() + 1200;
    const direct = performance.now();
    const error = await assets.reserve('input', 4096, signal).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(DeviceCapacityAdmissionError);
    // 样本缺失时这一维按未知处理，仲裁报“探测不可用”
    expect((error as DeviceCapacityAdmissionError).admission).toMatchObject({ kind: 'backpressured', blockedBy: 'probe-unavailable' });
    expect(performance.now() - direct).toBeGreaterThanOrEqual(950);

    missingUntil = performance.now() + 1200;
    const f = fixture({ reserve: (bucket, bytes, signal) => assets.reserve(bucket as 'input', bytes as number, signal as AbortSignal) }, productionDeadlineMs);
    await f.reserve('input', 4096);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ type: 'assets-result', id: 1, token: expect.stringMatching(/^[a-f0-9-]{36}$/u) });
    expect(failures(f.entries)).toHaveLength(0);
    expect(f.entries.find(entry => entry.event === 'terminalAssetRetried')?.data).toMatchObject({
      asset: { operation: 'reserve', bucket: 'input', bytes: 4096, attempts: 2, retriedOn: 'terminal-assets-capacity-backpressured',
        capacity: { kind: 'backpressured', blockedBy: 'probe-unavailable' } } });
  }, 15_000);
});

describe('N 以 S 给出的确定原因码拒绝资产请求', () => {
  function client() {
    const sent: { id: number }[] = [];
    const channel = { send: vi.fn(async (message: { id: number }) => { sent.push(message); }) } as unknown as TerminalChannel;
    const assets = new TerminalAssetClient(channel, new AbortController().signal);
    return { assets, sent };
  }
  it('有原因码时以它拒绝；没有或不是 terminal-* 字面量时为通用的不可用', async () => {
    const { assets, sent } = client();
    const first = assets.reserve('display', 4096); await vi.waitFor(() => expect(sent).toHaveLength(1));
    assets.receive({ type: 'assets-result', id: sent[0]!.id, failed: true, reason: 'terminal-disk-capacity' });
    await expect(first).rejects.toThrow(/^terminal-disk-capacity$/u);
    const second = assets.reserve('display', 4096); await vi.waitFor(() => expect(sent).toHaveLength(2));
    assets.receive({ type: 'assets-result', id: sent[1]!.id, failed: true, reason: 'C:/private secret' });
    await expect(second).rejects.toThrow(/^terminal-assets-unavailable$/u);
    const third = assets.reserve('input', 1); await vi.waitFor(() => expect(sent).toHaveLength(3));
    assets.receive({ type: 'assets-result', id: sent[2]!.id, failed: true });
    await expect(third).rejects.toThrow(/^terminal-assets-unavailable$/u);
  });
});
