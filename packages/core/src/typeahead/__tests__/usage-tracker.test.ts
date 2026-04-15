/**
 * UsageTracker 单元测试
 *
 * 覆盖面（input-typeahead.md §6.4 的所有数学性质 + 持久化边界）：
 *   - 纯函数 decayAndIncrement / currentScoreOf 的正确性
 *   - 有界性：MAX_SCORE=32 的稳态不变量（§6.4.3）
 *   - 行为曲线：30/60/90 天不用的衰减（§6.4.4）
 *   - GC 策略：score < 0.01 自动清除
 *   - Clock skew defense：now < lastUsedAt 不让 score 上升
 *   - 持久化：v2 load / v1 migration / 损坏文件 / atomic write / 纯内存模式
 *   - Debounce：0 立即 flush vs >0 延迟 flush
 *   - topN 降序
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentScoreOf,
  decayAndIncrement,
  GC_THRESHOLD,
  HALF_LIFE_HOURS,
  MAX_SCORE,
  UsageTracker,
} from "../usage-tracker.js";

// ─── 辅助 ───

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 构造一个临时目录（自动清理） */
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixing-usage-test-"));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ─── 纯函数测试 ───

describe("decayAndIncrement / currentScoreOf — 纯函数", () => {
  it("首次写入：prev 为 undefined → score = 1", () => {
    const entry = decayAndIncrement(undefined, 1000);
    expect(entry.score).toBe(1);
    expect(entry.lastUsedAt).toBe(1000);
  });

  it("同一毫秒内重复写：score 线性增长", () => {
    const t = 1000;
    let entry = decayAndIncrement(undefined, t);
    entry = decayAndIncrement(entry, t);
    entry = decayAndIncrement(entry, t);
    expect(entry.score).toBe(3);
  });

  it("MAX_SCORE 上限：无论写多少次都 ≤ 32", () => {
    const t = 1000;
    let entry: ReturnType<typeof decayAndIncrement> | undefined;
    for (let i = 0; i < 1000; i++) {
      entry = decayAndIncrement(entry, t);
    }
    expect(entry!.score).toBe(MAX_SCORE);
  });

  it("时间衰减：7 天（半衰期）后 score 减半", () => {
    const t0 = 1_000_000_000;
    let entry = decayAndIncrement(undefined, t0);
    entry = decayAndIncrement(entry, t0); // score = 2
    expect(entry.score).toBeCloseTo(2, 5);

    // 过 168 小时后再读 score：应约为 1
    const laterScore = currentScoreOf(
      entry,
      t0 + HALF_LIFE_HOURS * HOUR_MS,
    );
    expect(laterScore).toBeCloseTo(1, 4);
  });

  it("Clock skew defense: now < lastUsedAt 时视为 age=0，不上升", () => {
    const entry = decayAndIncrement(undefined, 1_000_000_000);
    expect(entry.score).toBe(1);
    // 让 now 比 lastUsedAt 早 1 小时
    const score = currentScoreOf(entry, 1_000_000_000 - HOUR_MS);
    expect(score).toBe(1); // 不应该 > 1
  });

  it("稳态数学：每天用一次的稳态 ~10.5（spec §6.4.3）", () => {
    // 稳态定义："刚完成一次 recordUsage 时" 的 score，不是"该次之后再过一整天"。
    // 因此读取时刻必须对齐最后一次 decayAndIncrement 的 lastUsedAt。
    const startT = 1_000_000_000;
    let entry: ReturnType<typeof decayAndIncrement> | undefined;
    const LAST_DAY = 199;
    for (let day = 0; day <= LAST_DAY; day++) {
      entry = decayAndIncrement(entry, startT + day * DAY_MS);
    }
    // 读取时刻 === 最后一次写入时刻：零衰减
    const finalScore = currentScoreOf(entry, startT + LAST_DAY * DAY_MS);
    // 解析解 s* = 1 / (1 − 2^(−24/168)) ≈ 10.604
    expect(finalScore).toBeGreaterThan(10);
    expect(finalScore).toBeLessThan(11);
  });

  it("行为曲线：满分 32 之后完全不用，30 天后 ~1.65（spec §6.4.4）", () => {
    // 先写到满分
    const t0 = 1_000_000_000;
    let entry: ReturnType<typeof decayAndIncrement> | undefined;
    for (let i = 0; i < 100; i++) {
      entry = decayAndIncrement(entry, t0);
    }
    expect(entry!.score).toBe(MAX_SCORE);
    // 30 天后
    const score30 = currentScoreOf(entry, t0 + 30 * DAY_MS);
    expect(score30).toBeGreaterThan(1.5);
    expect(score30).toBeLessThan(1.8);
  });

  it("行为曲线：满分 32 之后 90 天，score < GC_THRESHOLD", () => {
    const t0 = 1_000_000_000;
    let entry: ReturnType<typeof decayAndIncrement> | undefined;
    for (let i = 0; i < 100; i++) {
      entry = decayAndIncrement(entry, t0);
    }
    const score90 = currentScoreOf(entry, t0 + 90 * DAY_MS);
    expect(score90).toBeLessThan(GC_THRESHOLD);
  });
});

// ─── UsageTracker 集成测试 ───

describe("UsageTracker — 内存模式（rootDir=null）", () => {
  it("空 tracker：getScore 返回 0、topN 返回空", () => {
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => 1000,
    });
    expect(tracker.getScore("nothing")).toBe(0);
    expect(tracker.topN(10)).toEqual([]);
  });

  it("recordUsage 后 getScore 反映累积", () => {
    let now = 1000;
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => now,
    });
    tracker.recordUsage("a");
    tracker.recordUsage("a");
    tracker.recordUsage("a");
    expect(tracker.getScore("a")).toBeCloseTo(3, 4);
  });

  it("topN 按降序排列", () => {
    let now = 1000;
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => now,
    });
    tracker.recordUsage("low"); // 1
    tracker.recordUsage("high");
    tracker.recordUsage("high");
    tracker.recordUsage("high"); // 3
    tracker.recordUsage("mid");
    tracker.recordUsage("mid"); // 2

    const top = tracker.topN(5);
    expect(top.map((e) => e.commandId)).toEqual(["high", "mid", "low"]);
    expect(top[0]!.score).toBeCloseTo(3, 4);
  });

  it("topN(n) 截断到最多 n 条", () => {
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => 1000,
    });
    for (let i = 0; i < 10; i++) {
      tracker.recordUsage(`cmd${i}`);
    }
    const top3 = tracker.topN(3);
    expect(top3).toHaveLength(3);
  });

  it("topN(0) 返回空数组", () => {
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => 1000,
    });
    tracker.recordUsage("a");
    expect(tracker.topN(0)).toEqual([]);
  });

  it("GC：90 天后 recordUsage 时旧 entry 被自动清除", async () => {
    let now = 1_000_000_000;
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => now,
    });
    // 把 "old" 写到满分
    for (let i = 0; i < 100; i++) tracker.recordUsage("old");
    expect(tracker.getScore("old")).toBe(MAX_SCORE);

    // 时间推进 91 天
    now += 91 * DAY_MS;
    // 写一个别的命令触发 GC
    tracker.recordUsage("new");

    // old 应该被 GC 清除
    expect(tracker.getScore("old")).toBe(0);
    expect(tracker.getScore("new")).toBeCloseTo(1, 4);
  });

  it("prune() 返回被清除的数量", async () => {
    let now = 1_000_000_000;
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => now,
    });
    tracker.recordUsage("a");
    tracker.recordUsage("b");
    tracker.recordUsage("c");

    // 时间推进 90 天
    now += 90 * DAY_MS;
    const removed = await tracker.prune();
    expect(removed).toBe(3);
    expect(tracker.topN(10)).toEqual([]);
  });
});

// ─── 持久化 ───

describe("UsageTracker — 持久化", () => {
  it("debounceMs=0：recordUsage 立即 flush", async () => {
    const dir = makeTempDir();
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1_000_000_000,
      debounceMs: 0,
    });
    tracker.recordUsage("hello");
    // debounceMs=0 走立即 flush 路径；等一个微任务让 Promise 结算
    await new Promise((r) => setImmediate(r));

    const filePath = path.join(dir, "usage.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(2);
    expect(data.commands.hello).toBeDefined();
    expect(data.commands.hello.score).toBeCloseTo(1, 4);
    expect(data.commands.hello.lastUsedAt).toBe(1_000_000_000);
  });

  it("flush() 显式调用写盘", async () => {
    const dir = makeTempDir();
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1000,
      debounceMs: 10_000, // 长 debounce，依赖 flush()
    });
    tracker.recordUsage("a");
    await tracker.flush();

    const filePath = path.join(dir, "usage.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("load 现有 v2 文件", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "usage.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        commands: {
          elevated: { score: 18.3, lastUsedAt: 1_000_000_000 },
          model: { score: 8.2, lastUsedAt: 900_000_000 },
        },
      }),
    );
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1_000_000_000,
    });
    expect(tracker.getScore("elevated")).toBeCloseTo(18.3, 4);
    expect(tracker.getScore("model")).toBeLessThan(8.2); // 被衰减
  });

  it("v1 → v2 迁移：count 截断到 MAX_SCORE 作为初始 score", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "usage.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        commands: {
          abused: { count: 1000, lastUsedAt: 1_000_000_000 },
          modest: { count: 5, lastUsedAt: 1_000_000_000 },
        },
      }),
    );
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1_000_000_000,
    });
    expect(tracker.getScore("abused")).toBe(MAX_SCORE);
    expect(tracker.getScore("modest")).toBe(5);
  });

  it("损坏文件：load 时捕获错误，tracker 仍可用（空状态）", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "usage.json");
    fs.writeFileSync(filePath, "{ not valid json }");
    const onError = vi.fn();
    const tracker = new UsageTracker({
      rootDir: dir,
      onError,
      now: () => 1000,
    });
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0]![1]).toBe("load:parse");
    // 仍然可用
    tracker.recordUsage("a");
    expect(tracker.getScore("a")).toBeCloseTo(1, 4);
  });

  it("原子写：flush 过程使用 .tmp 文件", async () => {
    const dir = makeTempDir();
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1000,
      debounceMs: 0,
    });
    tracker.recordUsage("a");
    await new Promise((r) => setImmediate(r));

    // 完成后 .tmp 应已被 rename 清理
    expect(fs.existsSync(path.join(dir, "usage.json.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "usage.json"))).toBe(true);
  });

  it("文件不存在时 load 返回空状态不报错", () => {
    const dir = makeTempDir();
    // 不预先创建文件
    const tracker = new UsageTracker({
      rootDir: dir,
      now: () => 1000,
    });
    expect(tracker.getScore("anything")).toBe(0);
  });

  it("rootDir 目录不存在时 flush 自动 mkdir", async () => {
    const parent = makeTempDir();
    const nested = path.join(parent, "nested", "deeper");
    // nested 此时不存在
    const tracker = new UsageTracker({
      rootDir: nested,
      now: () => 1000,
      debounceMs: 0,
    });
    tracker.recordUsage("a");
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(path.join(nested, "usage.json"))).toBe(true);
  });

  it("rootDir=null：完全不写盘", async () => {
    const dir = makeTempDir();
    const tracker = new UsageTracker({
      rootDir: null,
      now: () => 1000,
      debounceMs: 0,
    });
    tracker.recordUsage("a");
    await tracker.flush();
    expect(fs.existsSync(path.join(dir, "usage.json"))).toBe(false);
  });

  it("重新构造的 tracker 能读到上次 recordUsage 的数据（端到端持久化）", async () => {
    const dir = makeTempDir();

    const tracker1 = new UsageTracker({
      rootDir: dir,
      now: () => 1_000_000_000,
      debounceMs: 0,
    });
    tracker1.recordUsage("persistent");
    tracker1.recordUsage("persistent");
    await new Promise((r) => setImmediate(r));
    await tracker1.flush();

    const tracker2 = new UsageTracker({
      rootDir: dir,
      now: () => 1_000_000_000,
    });
    expect(tracker2.getScore("persistent")).toBeCloseTo(2, 4);
  });
});
