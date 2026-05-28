/**
 * /trust 面板控制器集成测试。
 *
 * 用 mock stdin（EventEmitter + isTTY/isRaw/setRawMode 桩）发 keypress，
 * 真实 PermissionStore + SecurityPipeline 驱动 effect 路径，断言：
 * - 初始 load rules + 首屏渲染
 * - down → 重绘（选中变更反映在新一帧）
 * - d-d 双击 → store.revoke 调用 + rules 减少一条 + 重绘
 * - ESC → resolve（lifecycle 终止）
 * - non-TTY → 立即返回，不挂 keypress listener
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  PermissionStore,
  SecurityPipeline,
  type PermissionRule,
} from "@zhixing/core";
import { runTrustPanel } from "../controller.js";

// ─── mock stdin / stdout ───

interface MockStdin extends EventEmitter {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode(v: boolean): MockStdin;
  resume(): MockStdin;
  pause(): MockStdin;
}

function makeStdin(opts: { isTTY?: boolean } = {}): MockStdin {
  const e = new EventEmitter() as MockStdin;
  e.isTTY = opts.isTTY ?? true;
  e.isRaw = false;
  e.setRawMode = (v: boolean) => {
    e.isRaw = v;
    return e;
  };
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

interface MockStdout {
  buf: string[];
  write(s: string): boolean;
}

function makeStdout(): MockStdout {
  const buf: string[] = [];
  return {
    buf,
    write(s: string): boolean {
      buf.push(s);
      return true;
    },
  };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI, "");
const lastFrame = (stdout: MockStdout): string =>
  strip(stdout.buf.join("")).split(/\n/).filter(Boolean).join("\n");

// ─── 装配 ───

function makeRule(id: string, argument = "*"): PermissionRule {
  return {
    id,
    pattern: { tool: "bash", argument },
    decision: "allow",
    scope: "context",
    createdAt: 0,
    lastMatchedAt: 0,
    matchCount: 0,
    contextId: { kind: "main" },
    contributors: [{ origin: "user", timestamp: 0 }],
  };
}

function makePipelineWithRules(rules: PermissionRule[]): SecurityPipeline {
  const store = new PermissionStore({ rootDir: null });
  for (const r of rules) store.create({ kind: "main" }, r);
  return new SecurityPipeline({
    trustContext: { kind: "global" },
    permissionStore: store,
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, msg = "timeout"): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ─── 测试 ───

describe("runTrustPanel — 控制器集成", () => {
  it("non-TTY 直接返回不挂 listener", async () => {
    const pipeline = makePipelineWithRules([]);
    const stdin = makeStdin({ isTTY: false });
    const stdout = makeStdout();

    await runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });

    expect(stdout.buf.join("")).toContain("TTY");
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("启动时进 raw mode、退出后恢复", async () => {
    const pipeline = makePipelineWithRules([makeRule("a")]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();
    expect(stdin.isRaw).toBe(true);

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
    expect(stdin.isRaw).toBe(false);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("首屏渲染含规则列表 + 详情 + footer", async () => {
    const pipeline = makePipelineWithRules([makeRule("rule-aaa", "ls -la")]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    const frame = lastFrame(stdout);
    expect(frame).toContain("已沉淀信任规则");
    expect(frame).toContain("rule-aaa");
    expect(frame).toContain("ls -la");
    expect(frame).toContain("详情");
    expect(frame).toContain("ESC 退出");

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("down 后重绘，选中变更", async () => {
    const pipeline = makePipelineWithRules([makeRule("rule-1", "a"), makeRule("rule-2", "b")]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();
    const initialFrameCount = stdout.buf.length;

    stdin.emit("keypress", undefined, { name: "down" });
    await nextTick();
    expect(stdout.buf.length).toBeGreaterThan(initialFrameCount);

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("d-d 双击撤销选中规则、列表少一条", async () => {
    const pipeline = makePipelineWithRules([makeRule("rule-x", "x"), makeRule("rule-y", "y")]);
    const stdin = makeStdin();
    const stdout = makeStdout();
    const store = pipeline.getPermissionStore();
    expect(store.list({ kind: "main" }).filter((r) => r.scope === "context")).toHaveLength(2);

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    stdin.emit("keypress", undefined, { name: "d" });
    await nextTick();
    stdin.emit("keypress", undefined, { name: "d" });
    await nextTick();

    expect(store.list({ kind: "main" }).filter((r) => r.scope === "context")).toHaveLength(1);
    expect(store.list({ kind: "main" }).find((r) => r.id === "rule-x")).toBeUndefined();

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("单次 d 不撤销，切换选中后 d 重新计数", async () => {
    const pipeline = makePipelineWithRules([makeRule("rule-1", "a"), makeRule("rule-2", "b")]);
    const stdin = makeStdin();
    const stdout = makeStdout();
    const store = pipeline.getPermissionStore();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    stdin.emit("keypress", undefined, { name: "d" });   // 标 rule-1 pending
    await nextTick();
    stdin.emit("keypress", undefined, { name: "down" }); // 移动清 pending
    await nextTick();
    stdin.emit("keypress", undefined, { name: "d" });   // 标 rule-2 pending（不撤销）
    await nextTick();

    expect(store.list({ kind: "main" }).filter((r) => r.scope === "context")).toHaveLength(2);

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("空规则集 → 渲染空态文案", async () => {
    const pipeline = makePipelineWithRules([]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    const frame = lastFrame(stdout);
    expect(frame).toContain("没有建立信任规则");
    expect(frame).toContain("Tip:");

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("builtin 规则被过滤 —— 不进 /trust 面板（归 /security 查看）", async () => {
    const pipeline = makePipelineWithRules([makeRule("user-rule", "ls")]);
    const store = pipeline.getPermissionStore();
    // 注入一条 builtin 规则；UI 层应过滤掉
    store.registerBuiltinRules("test-ns", [
      {
        id: "builtin-secret",
        pattern: { tool: "bash", argument: "secret-tool" },
        decision: "allow",
        scope: "builtin",
        createdAt: 0,
        lastMatchedAt: 0,
        matchCount: 0,
      },
    ]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    const frame = lastFrame(stdout);
    // id 列只显示前 8 字符；用 "user-rul" 或 pattern "ls" 验证规则在
    expect(frame).toMatch(/user-rul|bash\s+ls/);
    expect(frame).not.toContain("secret-tool");
    expect(frame).not.toContain("builtin-secret");

    stdin.emit("keypress", undefined, { name: "escape" });
    await withTimeout(done, 1000);
  });

  it("Ctrl+C 等同 ESC 退出", async () => {
    const pipeline = makePipelineWithRules([makeRule("a")]);
    const stdin = makeStdin();
    const stdout = makeStdout();

    const done = runTrustPanel({ pipeline, stdin: stdin as any, stdout: stdout as any, agentDisplayName: "知行" });
    await nextTick();

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await withTimeout(done, 1000);
    expect(stdin.isRaw).toBe(false);
  });
});
