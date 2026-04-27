/**
 * `gracefulKill` —— 跨平台子进程优雅停止 helper。
 *
 * POSIX 路径: 先尝试 `process.kill(-pid, SIGTERM)` 给进程组发 SIGTERM (含子进程
 * 自身 fork 的孙进程); child 不在自己的进程组时退化为 child.kill("SIGTERM")。
 * 等 graceMs 后, 若仍在跑则升级到 SIGKILL (同样优先进程组,降级到直接 child)。
 *
 * Windows 路径: SIGTERM 不可靠 —— ChildProcess.kill() 在 Windows 上等价于
 * TerminateProcess(强制结束),不走 grace 期。
 *
 * 资源回收: sleep 用 controller 控制, race 完成后立即清理 phantom setTimeout,
 * 不让定时器悬挂在 event loop 中(测试 vi.getTimerCount() === 0 可断言)。
 *
 * 错误处理: 永不 reject —— 所有 kill 路径用 try/catch 吞噬 ESRCH/EPERM 等
 * (子进程已退出 / 权限不足时 OS 错误对调用方无意义,等价于"已停止")。
 *
 * 强制使用约束: 所有 `interruptBehavior: "grace"` 的工具必须 import 此 helper,
 * 不允许自写 SIGTERM/SIGKILL 升级链 —— 跨平台分歧 + 进程组语义 + 测试可锚定
 * 都需要在一处实现。
 */

import type { ChildProcess } from "node:child_process";

export interface GracefulKillOptions {
  /**
   * SIGTERM 后等待 SIGKILL 的时间(ms)。默认 1000。
   * `<= 0` 时跳过 grace 期, 直接发 SIGKILL —— 调用方显式选择"不等清理"。
   */
  readonly graceMs?: number;
  /**
   * 平台读取函数。默认 `() => process.platform`,生产代码无需传入。
   * 单测注入 mock 锚定平台分支(避免 Windows 测试机误走 POSIX 真实系统调用,
   * 反之亦然)。
   */
  readonly getPlatform?: () => NodeJS.Platform;
}

const DEFAULT_GRACE_MS = 1000;

/**
 * 优雅停止子进程, 在 child 退出后 resolve(永不 reject)。
 *
 * - child 已退出 → 立即 resolve
 * - Windows → child.kill() (等价 TerminateProcess) → 等 exit
 * - POSIX → SIGTERM (优先进程组) → graceMs 等待 → 若仍在跑则 SIGKILL → 等 exit
 */
export async function gracefulKill(
  child: ChildProcess,
  opts: GracefulKillOptions = {},
): Promise<void> {
  if (hasExited(child)) return;

  const platform = (opts.getPlatform ?? (() => process.platform))();

  if (platform === "win32") {
    swallow(() => child.kill());
    await waitForExit(child);
    return;
  }

  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;

  sendSignal(child, "SIGTERM");

  if (graceMs > 0) {
    const exited = await raceExitWithGrace(child, graceMs);
    if (exited) return;
  }

  sendSignal(child, "SIGKILL");
  await waitForExit(child);
}

// ─── 内部 helper ───

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * race child exit 与 grace 计时。返回 true 表示 child 在 grace 期内退出。
 *
 * grace 计时用可清理的 setTimeout: race 完成后立即 clearTimeout, 不让 phantom
 * timer 悬挂在 event loop 中影响 vi.getTimerCount() 类资源回收断言。
 */
function raceExitWithGrace(child: ChildProcess, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolve(false);
    }, graceMs);
    child.once("exit", onExit);
  });
}

/**
 * 等 child 'exit' 事件; child 已退出时立即 resolve。
 * 不挂 timer, 仅注册一次性 listener, exit 后自动清理。
 */
function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
}

/**
 * 发信号给子进程 —— 优先进程组(若 child detached 则杀整个进程组含孙进程),
 * 失败时降级到直接 child.kill。所有错误吞噬 (ESRCH = 进程已退出 / 进程组不存在,
 * EPERM = 权限不足, 都对调用方无意义)。
 */
function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    const pid = child.pid;
    const groupSent = swallow(() => process.kill(-pid, signal));
    if (groupSent) return;
  }
  swallow(() => child.kill(signal));
}

/**
 * 执行可能抛错的同步操作, 吞噬异常。返回 true 表示无异常成功。
 * 用于"kill 信号到已退出的进程"等预期失败 —— OS 错误对调用方无可用语义。
 */
function swallow(fn: () => boolean | void): boolean {
  try {
    const ret = fn();
    return ret !== false;
  } catch {
    return false;
  }
}
