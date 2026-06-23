/**
 * Shutdown chain —— 把 command.ts 的 CleanupRegistry 注册序列抽成可测纯函数
 *
 * 设计意图：
 * 注册顺序 = 期望 LIFO 执行顺序的**倒序**（spec §3.6.1）。这是 daemon-level-1 的核心
 * 架构决策，放在 command.ts 里一长段胶水里容易被误改，且无法单元测试。
 *
 * 这里把注册序列拆成两个函数：
 *   - `registerTailCleanup`  在 runServer **之前**调（LIFO 最后执行）
 *   - `registerCoreCleanup`  在 runServer **之后**调（LIFO 最先执行）
 *
 * 这样：
 *   1. 可单元测试——注入 mock registry，断言 register 的 name 序列
 *   2. command.ts 只负责"拼装"，不写 LIFO 细节
 *   3. 未来加资源（例如 Step 18 Active Hours timer）只在 `registerCoreCleanup` 里加一行
 *   4. 可扩展——新资源加在哪一层由"何时 ready"决定（runServer 前还是后）
 */

import { readLock, releaseLock } from "@zhixing/server";
import type {
  CleanupRegistry,
  ServerStateFile,
  ProcessLockPaths,
  ExitReason,
} from "@zhixing/server";
import type { ChannelRegistry, Scheduler } from "@zhixing/core";
import type { McpHub } from "@zhixing/mcp";
import type { DeliveryStack } from "../setup-delivery.js";

/**
 * 资源引用包。使用 `{ current: ... }` 结构给 heartbeat timer 这种"注册时未存在，
 * 清理时需读最新值"的引用留窗口。
 *
 * **lockPaths 契约**：调用方必须在同一个 `lockPaths` 变量里决策（即传给 runServer 的
 * `lockPaths` 和这里的 `lockPaths` **必须是同一引用**），否则 acquire 与 release 路径
 * 不一致会导致 PID 锁孤儿化。默认 undefined 时两边都走默认路径，一致。
 */
export interface ShutdownChainResources {
  stateFile?: ServerStateFile;
  heartbeatTimerRef: { current: NodeJS.Timeout | null };
  scheduler?: Scheduler;
  channels?: ChannelRegistry;
  deliveryStack?: DeliveryStack;
  /** MCP 连接层 hub —— 关闭所有 MCP server 连接 / stdio 子进程。 */
  mcpHub?: McpHub;
  /** PID 锁路径。必须与 runServer 的 lockPaths 同一引用（见接口注释） */
  lockPaths?: ProcessLockPaths;
}

/**
 * 在 `runServer` **之前**调用，注册 LIFO 尾部清理（最后执行的那些）。
 *
 * 注册顺序（LIFO 执行由下到上）：
 *   1. releaseLock             （LIFO 执行顺序 ⑨ —— 最后删 PID 文件）
 *   2. stateFile.cleanup       （⑧ —— 删 state/ready 文件）
 *   3. stateFile.markStopped   （⑦ —— 写 stopped 到 state）
 *
 * 为什么这 3 项在 runServer **之前**就注册：
 * - 它们与 daemon child 的文件资源绑定，在调 runServer 之前就已知（path 常量）
 * - LIFO 需要它们最后执行，因此必须最先注册
 */
export function registerTailCleanup(
  registry: CleanupRegistry,
  resources: ShutdownChainResources,
): void {
  // releaseLock 只释放**本进程持有**的锁。
  //
  // 场景：并发启动两个 daemon，第二个的 acquireLock 失败，command.ts catch 分支会
  // 调 registry.runAll("startup-failure")。若这里无脑 releaseLock，会误删第一个
  // daemon 的 PID 文件——导致本地协议客户端找不到 server（PID 文件消失），
  // 但第一个 daemon 仍在运行的假死状态。
  //
  // 修复：读 PID 文件，只有 pid === process.pid 才 unlink。非本进程的锁 / 没有锁
  // 文件（acquire 根本没跑）时 no-op。
  registry.register("releaseLock", async () => {
    const current = await readLock(resources.lockPaths).catch(() => null);
    if (current?.pid === process.pid) {
      await releaseLock(resources.lockPaths);
    }
  });
  if (resources.stateFile) {
    registry.register("stateFile.cleanup", async () => {
      await resources.stateFile!.cleanup();
    });
    registry.register("stateFile.markStopped", async () => {
      await resources.stateFile!.markStopped();
    });
  }
}

/**
 * 在 `runServer` **之后**调用，注册 LIFO 核心资源清理（最先执行的那些）。
 *
 * 注册顺序（LIFO 执行由下到上）：
 *   1. heartbeat.clear          （LIFO 执行 ⑥ —— 停 heartbeat timer）
 *   2. deliveryStack.stop       （⑤ —— 关投递栈）
 *   3. channels.dispose         （④ —— 断通道）
 *   4. mcpHub.dispose           （③ —— 关 MCP 连接 / stdio 子进程）
 *   5. scheduler.stop           （② —— 停调度器）
 *   6. stateFile.markStopping   （① —— 最先执行：对外宣告停机）
 *
 * 为什么这些在 runServer **之后**注册：
 * - scheduler/channels/delivery 由 command.ts 顶层创建，runServer 之前已经启动，但
 *   要作为核心资源被 LIFO 最先清理——所以必须在 runServer 之后（即 server.close 注册之后）注册
 * - runServer 内部已注册 `server.close`（LIFO 执行 ⑥），本函数注册的项都排在 server.close 之前执行
 */
export function registerCoreCleanup(
  registry: CleanupRegistry,
  resources: ShutdownChainResources,
): void {
  registry.register("heartbeat.clear", () => {
    const t = resources.heartbeatTimerRef.current;
    if (t) clearInterval(t);
  });
  if (resources.deliveryStack) {
    registry.register("deliveryStack.stop", async () => {
      await resources.deliveryStack!.stop();
    });
  }
  if (resources.channels) {
    registry.register("channels.dispose", async () => {
      await resources.channels!.dispose();
    });
  }
  if (resources.mcpHub) {
    // LIFO 执行落在 scheduler.stop 之后、channels.dispose 之前：先停调度（不再有
    // 新 turn）→ 关 MCP 连接 / 子进程。in-flight turn 已由 graceful shutdown 等待
    // 完成，此刻关 hub 不会切断进行中的 MCP 调用。
    registry.register("mcpHub.dispose", async () => {
      await resources.mcpHub!.dispose();
    });
  }
  if (resources.scheduler) {
    registry.register("scheduler.stop", async () => {
      await resources.scheduler!.stop();
    });
  }
  if (resources.stateFile) {
    registry.register("stateFile.markStopping", async (reason) => {
      await resources.stateFile!.markStopping(mapReasonToExit(reason));
    });
  }
}

/** Shutdown reason 字符串映射到 ServerStateFile 的 exitReason 枚举 */
export function mapReasonToExit(reason: string): ExitReason {
  if (reason.startsWith("SIG")) return "signal";
  if (reason.toLowerCase().includes("uncaught")) return "crash";
  if (reason.toLowerCase().includes("error")) return "error";
  return "graceful";
}
