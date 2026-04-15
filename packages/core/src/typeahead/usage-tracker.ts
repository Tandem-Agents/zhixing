/**
 * UsageTracker — bounded frecency MRU 评分器
 *
 * 实现 input-typeahead.md §6.4 的所有约束：
 *   - score 有界 ≤ MAX_SCORE=32（稳态不超上限）
 *   - 7 天半衰期的 EMA 衰减
 *   - 30 天不用衰减到 ~5%，90 天衰减到 <GC_THRESHOLD 被自动 GC
 *   - 避免 naive count × decay 的三个陷阱（历史明星霸榜 / 无界增长 / 新旧权重失衡）
 *
 * 数学形式：
 *   onUse(prev):  score = min(prev.score * β^age_hours + 1, MAX_SCORE)
 *   getScore:     currentScore = entry.score * β^age_hours
 *   β = 2^(-1/168)，age_hours = (now - lastUsedAt) / 3600_000
 *
 * 持久化：
 *   - ~/.zhixing/usage.json（版本 2）
 *   - 原子写：tmp + rename
 *   - debounced flush（默认 5 秒）
 *   - 构造时同步 load
 *
 * 测试钩子：
 *   - `rootDir: null` 禁用所有磁盘操作
 *   - `now: () => number` 注入时钟
 *   - `debounceMs: 0` 每次 recordUsage 立即 flush（跳过 debounce）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { IUsageTracker, UsageEntry } from "./types.js";

// ─── 常量 ───

/** 半衰期 —— 每 168 小时 score 衰减到 1/2 */
export const HALF_LIFE_HOURS = 168;

/** 饱和上限 —— 稳态 score 永远 ≤ 32 */
export const MAX_SCORE = 32;

/** GC 阈值 —— 写入时 score < 0.01 的 entry 被清除 */
export const GC_THRESHOLD = 0.01;

/** 每小时的毫秒数（纯常量，避免每次重算） */
const MS_PER_HOUR = 3_600_000;

/** 每天衰减因子用到：Math.LN2 / HALF_LIFE_HOURS */
const DECAY_COEFF = Math.LN2 / HALF_LIFE_HOURS;

/** 默认 debounced flush 间隔 */
const DEFAULT_DEBOUNCE_MS = 5000;

const DEFAULT_SUBDIR = ".zhixing";
const DEFAULT_FILE_NAME = "usage.json";
const FILE_VERSION = 2;

// ─── 选项 ───

export interface UsageTrackerOptions {
  /**
   * 持久化目录。
   * - 未提供：`~/.zhixing/`
   * - 显式 null：禁用所有磁盘操作（纯内存，测试用）
   * - 具体路径：用该目录
   */
  readonly rootDir?: string | null;

  /** 文件名覆盖，默认 "usage.json" */
  readonly fileName?: string;

  /** 时钟注入 */
  readonly now?: () => number;

  /**
   * Debounce 窗口（ms）。
   * - >0：recordUsage 后延迟 ms 刷盘
   * - 0：每次 recordUsage 立即 flush（测试用，避免 fake timer 复杂度）
   */
  readonly debounceMs?: number;

  /** 持久化 / 加载失败的日志 hook */
  readonly onError?: (error: Error, context: string) => void;
}

// ─── 磁盘格式 ───

/** 磁盘上的 v2 格式 */
interface UsageFileV2 {
  version: 2;
  commands: Record<string, UsageEntry>;
}

/** 兼容 v1 格式的只读接口（从不会写出） */
interface UsageFileV1 {
  version: 1;
  commands: Record<string, { count: number; lastUsedAt: number }>;
}

// ─── 内部纯函数 ───

/**
 * 纯函数：根据前一条记录 + 当前时间，计算写入新一次使用后的 entry。
 * 完全符合 input-typeahead.md §6.4.2 的伪代码。
 */
export function decayAndIncrement(
  prev: UsageEntry | undefined,
  now: number,
): UsageEntry {
  const prevEntry: UsageEntry = prev ?? { score: 0, lastUsedAt: now };
  // Clock skew defense：age 永远非负
  const ageHours = Math.max(0, (now - prevEntry.lastUsedAt) / MS_PER_HOUR);
  const decayed = prevEntry.score * Math.exp(-ageHours * DECAY_COEFF);
  const nextScore = Math.min(decayed + 1, MAX_SCORE);
  return { score: nextScore, lastUsedAt: now };
}

/**
 * 纯函数：读取一条记录在 now 时刻的有效 score（应用懒衰减，不修改 entry）。
 */
export function currentScoreOf(
  entry: UsageEntry | undefined,
  now: number,
): number {
  if (!entry) return 0;
  const ageHours = Math.max(0, (now - entry.lastUsedAt) / MS_PER_HOUR);
  return entry.score * Math.exp(-ageHours * DECAY_COEFF);
}

// ─── 实现 ───

export class UsageTracker implements IUsageTracker {
  private readonly entries = new Map<string, UsageEntry>();

  private readonly filePath: string | null;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly onError: (error: Error, context: string) => void;

  /** debounce 定时器句柄 */
  private flushTimer: NodeJS.Timeout | null = null;

  /** 内存是否比磁盘新 */
  private dirty = false;

  constructor(options: UsageTrackerOptions = {}) {
    const { rootDir, fileName, now, debounceMs, onError } = options;

    if (rootDir === null) {
      this.filePath = null;
    } else if (rootDir !== undefined) {
      this.filePath = path.join(rootDir, fileName ?? DEFAULT_FILE_NAME);
    } else {
      this.filePath = path.join(
        os.homedir(),
        DEFAULT_SUBDIR,
        fileName ?? DEFAULT_FILE_NAME,
      );
    }

    this.now = now ?? (() => Date.now());
    this.debounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.onError = onError ?? (() => {});

    this.load();
  }

  // ── 公共 API ──

  recordUsage(commandId: string): void {
    const prev = this.entries.get(commandId);
    const next = decayAndIncrement(prev, this.now());
    this.entries.set(commandId, next);

    // 顺路做 GC：每次写都遍历一遍，复杂度 O(N)；N 一般 ≤ 100 可忽略
    this.collectGarbageInline();

    this.dirty = true;
    this.scheduleFlush();
  }

  getScore(commandId: string): number {
    return currentScoreOf(this.entries.get(commandId), this.now());
  }

  topN(n: number): ReadonlyArray<{ commandId: string; score: number }> {
    if (n <= 0) return [];
    const now = this.now();
    const scored: Array<{ commandId: string; score: number }> = [];
    for (const [commandId, entry] of this.entries) {
      const score = currentScoreOf(entry, now);
      if (score <= 0) continue;
      scored.push({ commandId, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }

  async prune(): Promise<number> {
    const removed = this.collectGarbageInline();
    if (removed > 0) this.dirty = true;
    await this.flush();
    return removed;
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    if (this.filePath === null) {
      // 纯内存模式，清 dirty 标志即可
      this.dirty = false;
      return;
    }
    try {
      await this.writeToDisk();
      this.dirty = false;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError(error, "flush");
      // 保留 dirty=true，下次 recordUsage 会再次尝试
    }
  }

  // ── GC ──

  /**
   * 同步遍历 entries，清除 currentScore < GC_THRESHOLD 的条目。
   * 返回被清除的数量。
   */
  private collectGarbageInline(): number {
    const now = this.now();
    let removed = 0;
    for (const [commandId, entry] of this.entries) {
      const score = currentScoreOf(entry, now);
      if (score < GC_THRESHOLD) {
        this.entries.delete(commandId);
        removed++;
      }
    }
    return removed;
  }

  // ── 持久化 ──

  private load(): void {
    if (this.filePath === null) return;
    if (!fs.existsSync(this.filePath)) return;

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError(error, "load:read");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError(error, "load:parse");
      // 损坏文件：保留空内存状态，下次 flush 时覆盖
      this.dirty = true;
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.onError(
        new Error("usage file is not an object"),
        "load:shape",
      );
      this.dirty = true;
      return;
    }

    const obj = parsed as { version?: unknown; commands?: unknown };
    if (obj.version === FILE_VERSION) {
      this.applyV2(obj as unknown as UsageFileV2);
    } else if (obj.version === 1) {
      // v1 → v2 的防御性迁移（v1 从未上线，保留代码是为了保险）
      this.applyV1(obj as unknown as UsageFileV1);
      this.dirty = true; // 下次 flush 写成 v2
    } else {
      this.onError(
        new Error(`unknown usage file version: ${String(obj.version)}`),
        "load:version",
      );
      this.dirty = true;
    }
  }

  private applyV2(data: UsageFileV2): void {
    if (!data.commands || typeof data.commands !== "object") return;
    for (const [commandId, entry] of Object.entries(data.commands)) {
      if (
        entry &&
        typeof entry.score === "number" &&
        typeof entry.lastUsedAt === "number" &&
        Number.isFinite(entry.score) &&
        Number.isFinite(entry.lastUsedAt)
      ) {
        this.entries.set(commandId, {
          score: Math.min(Math.max(0, entry.score), MAX_SCORE),
          lastUsedAt: entry.lastUsedAt,
        });
      }
    }
  }

  private applyV1(data: UsageFileV1): void {
    if (!data.commands || typeof data.commands !== "object") return;
    for (const [commandId, old] of Object.entries(data.commands)) {
      if (
        old &&
        typeof old.count === "number" &&
        typeof old.lastUsedAt === "number"
      ) {
        // v1 的 raw count 截断到 MAX_SCORE 作为初始 score
        this.entries.set(commandId, {
          score: Math.min(Math.max(0, old.count), MAX_SCORE),
          lastUsedAt: old.lastUsedAt,
        });
      }
    }
  }

  private async writeToDisk(): Promise<void> {
    if (this.filePath === null) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: UsageFileV2 = {
      version: FILE_VERSION,
      commands: Object.fromEntries(this.entries),
    };
    const tmp = `${this.filePath}.tmp`;
    // 同步写 + rename：避免 async 期间被 ctrl+c 中断造成损坏。
    // 文件很小（< 10 KB），同步 I/O 的阻塞可忽略。
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  private scheduleFlush(): void {
    if (this.filePath === null) {
      // 纯内存模式：不刷盘也就不需要 debounce；清 dirty 标志即可
      this.dirty = false;
      return;
    }
    if (this.debounceMs === 0) {
      // 立即 flush 模式（测试 / 确定性写盘）
      void this.flush();
      return;
    }
    if (this.flushTimer !== null) return; // 已有 timer 在跑，不重复设
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
    // 不要阻塞事件循环退出
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }
}
