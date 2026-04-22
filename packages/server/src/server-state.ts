/**
 * ServerStateFile — 生命周期状态机 + 状态文件 + ready marker
 *
 * 设计意图：
 * `.ready` marker 和 `server.state` JSON 不是两个独立概念，是**同一个生命周期状态机**
 * 的两种外化形式。统一到 ServerStateFile 抽象里，消除职责重叠。
 *
 * 状态转换：
 *   starting → ready       (markReady)       写 .ready marker + state(phase=ready)
 *   ready    → running     (markRunning)     紧随 markReady 同步调用，写 state(phase=running)
 *   running  → stopping    (markStopping)    SIGTERM / shutdown RPC 入口
 *   stopping → stopped     (markStopped)     cleanup 早期阶段
 *   任意     → unhealthy   (markUnhealthy)   不可恢复错误
 *
 * 职责边界：
 * - 不关心 PID 文件（那是 process-lock.ts 的职责）
 * - 不关心 channel / delivery 健康（子系统自己外化到 extensions 字段）
 * - 不关心 cleanup 顺序（由 CleanupRegistry 在 M4 编排）
 *
 * 并发保护：
 * - 内部串行化所有写操作，避免 tmp+rename race
 * - 原子写：写 .tmp → rename 到目标
 */

import { writeFile, rename, unlink, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { getDefaultStatePath, getDefaultReadyMarkerPath } from "./paths.js";

export type ServerPhase =
  | "starting"
  | "ready"
  | "running"
  | "stopping"
  | "stopped"
  | "unhealthy";

export type ExitReason = "graceful" | "error" | "crash" | "signal";

export interface ServerStateSnapshot {
  phase: ServerPhase;
  pid: number;
  startedAt: string;
  lastHeartbeat: string;
  port?: number;
  host?: string;
  exitReason?: ExitReason | null;
  /** 扩展字段，为 Step 18 Active Hours / 其他未来用途留空间 */
  extensions?: Record<string, unknown>;
}

export interface ServerStateFileOptions {
  statePath?: string;
  readyMarkerPath?: string;
  /** 测试用：注入时钟 */
  clock?: () => Date;
}

/** 合法转换表——尝试非法转换 → 抛 InvalidPhaseTransitionError */
const VALID_NEXT: Record<ServerPhase, readonly ServerPhase[]> = {
  starting: ["ready", "unhealthy"],
  ready: ["running", "stopping", "unhealthy"],
  running: ["stopping", "unhealthy"],
  stopping: ["stopped", "unhealthy"],
  stopped: [],
  unhealthy: [],
};

export class InvalidPhaseTransitionError extends Error {
  constructor(from: ServerPhase, to: ServerPhase) {
    super(`Invalid phase transition: ${from} → ${to}`);
    this.name = "InvalidPhaseTransitionError";
  }
}

/**
 * ServerStateFile 管理 daemon 子进程的生命周期状态外化。
 *
 * 实例单例：一个进程至多一个 ServerStateFile 实例，避免文件争用。
 * 前台模式通常不需要这个——只在 daemon child 启用。
 */
export class ServerStateFile {
  private readonly statePath: string;
  private readonly readyMarkerPath: string;
  private readonly clock: () => Date;

  private phase: ServerPhase = "starting";
  private snapshot: ServerStateSnapshot | null = null;

  /** 串行化 promise chain，保证写操作 FIFO，避免 tmp+rename race */
  private pending: Promise<void> = Promise.resolve();

  constructor(opts: ServerStateFileOptions = {}) {
    this.statePath = opts.statePath ?? getDefaultStatePath();
    this.readyMarkerPath = opts.readyMarkerPath ?? getDefaultReadyMarkerPath();
    this.clock = opts.clock ?? (() => new Date());
  }

  /**
   * starting → ready。写 .ready marker + state(phase=ready)。
   * 这是 state 文件首次创建的点。
   */
  markReady(base: Omit<ServerStateSnapshot, "phase" | "lastHeartbeat">): Promise<void> {
    return this.run(async () => {
      this.ensureTransition("ready");
      const now = this.clock().toISOString();
      this.snapshot = {
        ...base,
        phase: "ready",
        lastHeartbeat: now,
        exitReason: null,
      };
      await this.atomicWriteState();
      await this.writeReadyMarker();
      this.phase = "ready";
    });
  }

  /** ready → running。紧随 markReady 同步调用，不等 heartbeat。*/
  markRunning(): Promise<void> {
    return this.run(async () => {
      this.ensureTransition("running");
      this.snapshot = {
        ...this.mustHaveSnapshot("markRunning"),
        phase: "running",
      };
      await this.atomicWriteState();
      this.phase = "running";
    });
  }

  /**
   * ready/running → stopping。SIGTERM / server.shutdown RPC 入口。
   *
   * **白名单语义**：只在 `ready` 或 `running` 合法前置下转换。其他 phase（starting / stopping
   * / stopped / unhealthy）全部 no-op——覆盖 startup-failure、并发 shutdown、不可恢复错误
   * 后再停机等所有边界场景，不污染日志。
   */
  markStopping(reason: ExitReason = "graceful"): Promise<void> {
    return this.run(async () => {
      if (this.phase !== "ready" && this.phase !== "running") return;
      this.ensureTransition("stopping");
      this.snapshot = {
        ...this.mustHaveSnapshot("markStopping"),
        phase: "stopping",
        exitReason: reason,
        lastHeartbeat: this.clock().toISOString(),
      };
      await this.atomicWriteState();
      this.phase = "stopping";
    });
  }

  /**
   * stopping → stopped。cleanup 早期阶段。
   *
   * **白名单语义**：只在 `stopping` 合法前置下转换。其他 phase 全部 no-op。
   */
  markStopped(): Promise<void> {
    return this.run(async () => {
      if (this.phase !== "stopping") return;
      this.ensureTransition("stopped");
      this.snapshot = {
        ...this.mustHaveSnapshot("markStopped"),
        phase: "stopped",
        lastHeartbeat: this.clock().toISOString(),
      };
      await this.atomicWriteState();
      this.phase = "stopped";
    });
  }

  /** 任意 → unhealthy。不可恢复错误。保留 state 文件供诊断，不删 .ready。*/
  markUnhealthy(reason: string): Promise<void> {
    return this.run(async () => {
      if (this.phase === "unhealthy") return; // 幂等
      this.snapshot = {
        ...(this.snapshot ?? this.emptySnapshot()),
        phase: "unhealthy",
        exitReason: "error",
        lastHeartbeat: this.clock().toISOString(),
        extensions: { ...(this.snapshot?.extensions ?? {}), unhealthyReason: reason },
      };
      await this.atomicWriteState();
      this.phase = "unhealthy";
    });
  }

  /**
   * 周期性刷新 lastHeartbeat（仅时间戳，不改 phase）。
   * 外部调用方负责 setInterval——ServerStateFile 不持有 timer。
   *
   * 只在 phase === "running" 时刷新——stopping/stopped/unhealthy 的 heartbeat 无语义价值，
   * 且避免 LIFO 清理链里 markStopping 后、heartbeat.clear 前几毫秒窗口内再刷一次 stopping 态。
   */
  heartbeat(): Promise<void> {
    return this.run(async () => {
      if (!this.snapshot) return; // 还没 markReady 过
      if (this.phase !== "running") return; // 非稳态不刷新
      this.snapshot = {
        ...this.snapshot,
        lastHeartbeat: this.clock().toISOString(),
      };
      await this.atomicWriteState();
    });
  }

  /** 读当前 state 文件快照。失败返回 null，不抛。*/
  async read(): Promise<ServerStateSnapshot | null> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      return JSON.parse(raw) as ServerStateSnapshot;
    } catch {
      return null;
    }
  }

  /** 删 .ready marker + state 文件。cleanup 最后一步（PID 文件由 releaseLock 管）。*/
  cleanup(): Promise<void> {
    return this.run(async () => {
      await safeUnlink(this.readyMarkerPath);
      await safeUnlink(this.statePath);
    });
  }

  /** 当前内部 phase（便于测试 / 诊断）*/
  get currentPhase(): ServerPhase {
    return this.phase;
  }

  // ─── 内部 ───

  private ensureTransition(to: ServerPhase): void {
    const allowed = VALID_NEXT[this.phase];
    if (!allowed.includes(to)) {
      throw new InvalidPhaseTransitionError(this.phase, to);
    }
  }

  private mustHaveSnapshot(caller: string): ServerStateSnapshot {
    if (!this.snapshot) {
      throw new Error(`${caller} called before markReady()`);
    }
    return this.snapshot;
  }

  private emptySnapshot(): ServerStateSnapshot {
    return {
      phase: "starting",
      pid: process.pid,
      startedAt: this.clock().toISOString(),
      lastHeartbeat: this.clock().toISOString(),
    };
  }

  private async atomicWriteState(): Promise<void> {
    if (!this.snapshot) return;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmpPath = this.statePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(this.snapshot, null, 2), "utf-8");
    await rename(tmpPath, this.statePath);
  }

  private async writeReadyMarker(): Promise<void> {
    await mkdir(dirname(this.readyMarkerPath), { recursive: true });
    await writeFile(this.readyMarkerPath, "", "utf-8");
  }

  /** 串行化写操作，避免并发 rename race */
  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.pending.then(fn, fn); // 前置错误不阻断后续
    this.pending = next.catch(() => {}); // chain 本身不吞错
    return next;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // 其他错误吞掉——cleanup 不应阻塞 shutdown
  }
}
