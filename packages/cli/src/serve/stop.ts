/** `zhixing stop` only requests the host's durable lifecycle stop operation. */

import chalk from "chalk";
import { readFile, stat, unlink } from "node:fs/promises";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  createRpcClient,
  getDefaultReadyMarkerPath,
  getDefaultStatePath,
  getDefaultTokenPath,
  isProcessAlive,
  readLock,
  releaseLock,
  type PidFileContents,
} from "@zhixing/server";
import { loadCurrentManagedServiceState } from "./managed-service-runtime.js";
import {
  createManagedServiceAdapter,
  managedServiceDefinitionDigest,
} from "./managed-service.js";

export interface StopOptions {
  timeoutMs?: number;
  pollMs?: number;
  rpcTimeoutMs?: number;
  verbose?: boolean;
  expectedLock?: PidFileContents;
  respectBlockers?: boolean;
  deps?: StopDeps;
}

export interface StopDeps {
  readLockFn?: typeof readLock;
  isProcessAliveFn?: typeof isProcessAlive;
  releaseLockFn?: typeof releaseLock;
  /** Retained only so older injected fixtures remain source-compatible; never invoked. */
  killFn?: (pid: number, signal: NodeJS.Signals | 0) => void;
  rpcShutdownFn?: (
    lock: PidFileContents,
    timeoutMs: number,
    opts?: RpcShutdownOptions,
  ) => Promise<void>;
  /** Retained only so older injected fixtures remain source-compatible; never invoked. */
  taskkillFn?: (pid: number, force: boolean) => Promise<void>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  console?: Pick<Console, "log" | "warn" | "error">;
  platform?: NodeJS.Platform;
  statePath?: string;
  readyMarkerPath?: string;
  prepareManagedExactStopFn?: (
    expectedLock: PidFileContents,
  ) => Promise<() => Promise<void>>;
}

export type StopResult =
  | { status: "nothing-to-stop" }
  | { status: "stopped"; pid: number; tookMs: number; path: "rpc" }
  | { status: "refused"; pid: number; reason: string; blockers: string[] }
  | { status: "error"; pid: number; reason: string };

export class StopRefusedError extends Error {
  override readonly name = "StopRefusedError";

  constructor(
    message: string,
    readonly blockers: string[],
  ) {
    super(message);
  }
}

interface RpcShutdownOptions {
  respectBlockers: boolean;
}

export async function runStopCommand(opts: StopOptions = {}): Promise<StopResult> {
  const deps = opts.deps ?? {};
  const con = deps.console ?? console;
  const readLockFn = deps.readLockFn ?? readLock;
  const isAlive = deps.isProcessAliveFn ?? isProcessAlive;
  const releaseLockFn = deps.releaseLockFn ?? releaseLock;
  const verbose = opts.verbose ?? true;
  const lock = await readLockFn().catch(() => null);
  if (!lock) {
    if (verbose) con.log(chalk.dim("知行未运行"));
    return { status: "nothing-to-stop" };
  }
  if (opts.expectedLock && !isSameLock(lock, opts.expectedLock)) {
    if (verbose) con.log(chalk.dim("知行运行实例已变化，跳过停止"));
    return { status: "nothing-to-stop" };
  }
  if (!isAlive(lock.pid)) {
    if (verbose) con.log(chalk.dim("知行已经停止，正在清理旧运行标记"));
    await cleanupExitedInstance({
      releaseLockFn,
      readLockFn,
      statePath: deps.statePath ?? getDefaultStatePath(),
      readyMarkerPath: deps.readyMarkerPath ?? getDefaultReadyMarkerPath(),
      expectedLock: lock,
    });
    return { status: "nothing-to-stop" };
  }

  let stopManagedExact: (() => Promise<void>) | undefined;
  if (lock.kind === "managed") {
    try {
      stopManagedExact = await (
        deps.prepareManagedExactStopFn ??
        ((expectedLock) => prepareManagedExactStop(expectedLock, readLockFn))
      )(lock);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (verbose) con.warn(chalk.yellow(`无法确认托管实例的安全停止边界：${reason}`));
      return { status: "error", pid: lock.pid, reason };
    }
  }

  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = clock();
  if (verbose) con.log(chalk.dim("正在安全停止知行..."));
  try {
    await (deps.rpcShutdownFn ?? defaultRpcShutdown)(
      lock,
      opts.rpcTimeoutMs ?? 15_000,
      { respectBlockers: opts.respectBlockers ?? false },
    );
    await stopManagedExact?.();
  } catch (error) {
    if (error instanceof StopRefusedError) {
      if (verbose) {
        con.warn(chalk.yellow(`无法停止知行：${error.message}`));
        for (const blocker of error.blockers) con.warn(chalk.yellow(`  - ${blocker}`));
      }
      return {
        status: "refused",
        pid: lock.pid,
        reason: error.message,
        blockers: error.blockers,
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (verbose) con.warn(chalk.yellow(`停止请求未安全受理：${reason}`));
    return { status: "error", pid: lock.pid, reason };
  }

  const exited = await waitForExit({
    pid: lock.pid,
    deadline: clock() + (opts.timeoutMs ?? 30_000),
    pollMs: opts.pollMs ?? 300,
    clock,
    sleep,
    isAlive,
    readLockFn,
    expectedLock: lock,
  });
  if (!exited) {
    const reason = "知行仍在安全收束中；请处理阻塞项后用同一命令继续，系统不会强制结束进程";
    if (verbose) con.warn(chalk.yellow(reason));
    return { status: "error", pid: lock.pid, reason };
  }

  const tookMs = clock() - start;
  await cleanupExitedInstance({
    releaseLockFn,
    readLockFn,
    statePath: deps.statePath ?? getDefaultStatePath(),
    readyMarkerPath: deps.readyMarkerPath ?? getDefaultReadyMarkerPath(),
    expectedLock: lock,
  });
  if (verbose) con.log(chalk.green(`知行已停止，用时 ${(tookMs / 1000).toFixed(1)}s`));
  return { status: "stopped", pid: lock.pid, tookMs, path: "rpc" };
}

async function defaultRpcShutdown(
  lock: PidFileContents,
  timeoutMs: number,
  opts: RpcShutdownOptions = { respectBlockers: false },
): Promise<void> {
  const host = lock.host ?? "127.0.0.1";
  const token = (await readFile(getDefaultTokenPath(), "utf8")).trim();
  if (!token) throw new Error("token file missing or empty");
  const client = createRpcClient({ url: `ws://${host}:${lock.port}/ws`, timeout: timeoutMs });
  await client.connect();
  try {
    await client.authenticate(token);
    if (opts.respectBlockers) {
      const blockers = getStopBlockers(await client.request<ServerStopInfo>("server.info"));
      if (blockers.length > 0) {
        throw new StopRefusedError("当前还有接入面或工作在运行", blockers);
      }
    }
    await client.request("server.shutdown", {
      requestId: protocolDigest("HostStopRequest", 1, {
        pid: lock.pid,
        port: lock.port,
        startTime: lock.startTime,
        startedAt: lock.startedAt,
      }),
      reason: "serve-stop",
      timeoutMs,
      strategy: "cancel",
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

interface WaitForExitArgs {
  pid: number;
  deadline: number;
  pollMs: number;
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  readLockFn: typeof readLock;
  expectedLock: PidFileContents;
}

async function waitForExit(input: WaitForExitArgs): Promise<boolean> {
  while (input.clock() < input.deadline) {
    if (await exactHostExited(input)) return true;
    await input.sleep(input.pollMs);
  }
  return exactHostExited(input);
}

async function exactHostExited(input: WaitForExitArgs): Promise<boolean> {
  const current = await input.readLockFn().catch(() => null);
  if (!current || !isSameLock(current, input.expectedLock)) return true;
  return !input.isAlive(input.pid);
}

async function prepareManagedExactStop(
  expectedLock: PidFileContents,
  readLockFn: typeof readLock,
): Promise<() => Promise<void>> {
  const current = await loadCurrentManagedServiceState("inspect");
  if (!current.spec) throw new Error("托管服务定义不可用");
  const spec = current.spec;
  const adapter = createManagedServiceAdapter();
  const signal = new AbortController().signal;
  const expected = await adapter.inspect(spec, signal);
  if (!expected.matches || !expected.running) {
    throw new Error("托管服务当前实例与运行端点不一致");
  }
  const expectedDefinition = managedServiceDefinitionDigest(spec);

  return async () => {
    const latest = await loadCurrentManagedServiceState("inspect");
    if (
      !latest.spec ||
      latest.spec.serviceId !== spec.serviceId ||
      managedServiceDefinitionDigest(latest.spec) !== expectedDefinition
    ) {
      throw new Error("托管服务定义在安全停止前已换代");
    }
    const inspection = await adapter.inspect(spec, signal);
    if (!inspection.matches || inspection.state !== expected.state) {
      throw new Error("托管服务投影在安全停止前已换代");
    }
    if (!inspection.running) return;
    const endpoint = await readLockFn().catch(() => null);
    if (!endpoint || !isSameLock(endpoint, expectedLock)) {
      throw new Error("运行端点在安全停止前已换代");
    }
    await adapter.stopCurrentExact(spec, expected, signal);
  };
}

interface CleanupExitedInstanceOptions {
  releaseLockFn: typeof releaseLock;
  readLockFn: typeof readLock;
  statePath: string;
  readyMarkerPath: string;
  expectedLock?: PidFileContents;
}

async function cleanupExitedInstance(input: CleanupExitedInstanceOptions): Promise<void> {
  if (input.expectedLock) {
    const current = await input.readLockFn().catch(() => null);
    if (!current || !isSameLock(current, input.expectedLock)) return;
  }
  await input.releaseLockFn().catch(() => undefined);
  await safeUnlink(input.statePath);
  await safeUnlink(input.readyMarkerPath);
}

function isSameLock(a: PidFileContents, b: PidFileContents): boolean {
  return a.pid === b.pid && a.port === b.port && a.startTime === b.startTime && a.startedAt === b.startedAt;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await stat(filePath);
    await unlink(filePath);
  } catch {
    // Missing files and cleanup races are already represented by the exact lock read-back.
  }
}

interface ServerStopInfo {
  connectionCount?: number;
  channels?: Array<{ channelId: string; state: string }>;
  accessSurfaces?: {
    otherRpcConnections?: number;
    liveChannels?: Array<{ channelId: string; state: string }>;
  };
  activeWork?: { count?: number };
  keepAliveWork?: Array<{ label?: string; count?: number }>;
}

function getStopBlockers(info: ServerStopInfo): string[] {
  const blockers: string[] = [];
  const otherConnections = typeof info.accessSurfaces?.otherRpcConnections === "number"
    ? info.accessSurfaces.otherRpcConnections
    : Math.max(0, (info.connectionCount ?? 1) - 1);
  if (otherConnections > 0) blockers.push(`还有 ${otherConnections} 个终端连接`);
  const liveChannels = info.accessSurfaces?.liveChannels ??
    (info.channels ?? []).filter((item) => item.state === "connected" || item.state === "connecting");
  if (liveChannels.length > 0) {
    blockers.push(`还有接入面在线：${liveChannels.map((item) => item.channelId).join("、")}`);
  }
  const activeWork = Math.max(0, info.activeWork?.count ?? 0);
  if (activeWork > 0) blockers.push(`还有 ${activeWork} 项运行中的工作`);
  const keepAlive = (info.keepAliveWork ?? []).reduce(
    (sum, item) => sum + Math.max(0, item.count ?? 0),
    0,
  );
  if (keepAlive > 0) blockers.push(`还有 ${keepAlive} 个已启用定时任务`);
  return blockers;
}
