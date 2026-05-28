/**
 * /trust 面板交互测试
 *
 * 覆盖 handleTrustCommand 面板循环的全部分支：
 *   - 空列表 → 显示 Tip + 立即退出
 *   - 列表渲染含核心列（编号 / 生效范围 / contributors / 工具 / pattern）
 *   - builtin 规则被过滤（不进 /trust，归 /security）
 *   - 输入编号 → 显示详情（含 contributors 完整时间线）
 *   - d<编号> + y → 撤销成功
 *   - d<编号> + N（默认拒）→ 不撤销
 *   - 非法编号 / 非法输入 → 提示后继续循环
 *   - Enter 空输入 → 退出
 */

import { describe, expect, it } from "vitest";
import {
  PermissionStore,
  SecurityPipeline,
  type PermissionRule,
} from "@zhixing/core";
import type { CliWriter } from "../../screen/index.js";
import type * as readline from "node:readline/promises";
import { handleTrustCommand } from "../commands.js";

// ─── ANSI 剥离（避免 chalk 色彩污染断言） ───

function stripAnsi(s: string): string {
  // 剥 ANSI CSI 序列（chalk 用的色彩转义）
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Mock writer：收集行 ───

class CollectWriter implements CliWriter {
  readonly lines: string[] = [];
  line(text: string): void {
    this.lines.push(stripAnsi(text));
  }
  appendInline(text: string): void {
    this.lines.push(stripAnsi(text));
  }
  notify(text: string): void {
    this.lines.push(stripAnsi(text));
  }
  ensureSegmentBreak(): void {}
  joined(): string {
    return this.lines.join("\n");
  }
}

// ─── Mock readline：按预设序列回答 question ───

function makeFakeRl(answers: string[]): readline.Interface {
  const queue = [...answers];
  return {
    question: (_prompt: string) => Promise.resolve(queue.shift() ?? ""),
    close: () => {},
  } as unknown as readline.Interface;
}

// ─── 装配 helper：真实 PermissionStore + SecurityPipeline ───

function makePipeline(opts?: {
  trustKind?: "global" | "workspace";
  workspace?: string;
}): { pipeline: SecurityPipeline; store: PermissionStore } {
  const store = new PermissionStore({ rootDir: null });
  const trustContext =
    opts?.trustKind === "workspace" && opts.workspace
      ? ({ kind: "workspace", dir: opts.workspace } as const)
      : ({ kind: "global" } as const);
  const pipeline = new SecurityPipeline({
    trustContext,
    permissionStore: store,
  });
  return { pipeline, store };
}

function seedContextRule(
  store: PermissionStore,
  contextId: string,
  overrides: Partial<PermissionRule> & {
    pattern: PermissionRule["pattern"];
  },
): PermissionRule {
  const rule = PermissionStore.createRule({
    pattern: overrides.pattern,
    decision: overrides.decision ?? "allow",
    scope: "context",
    contextId,
    contextPath: overrides.contextPath,
    contributors: overrides.contributors ?? [
      { origin: "user", timestamp: 1_700_000_000_000 },
    ],
  });
  store.create(contextId, rule);
  return rule;
}

// ─── 测试 ───

describe("handleTrustCommand /trust 面板", () => {
  it("空列表 → 显示 Tip 后立即退出（不等待 question）", async () => {
    const { pipeline } = makePipeline();
    const writer = new CollectWriter();
    const rl = makeFakeRl([]);

    await handleTrustCommand("", { pipeline, rl, writer });

    const text = writer.joined();
    expect(text).toContain("已建立的信任规则");
    expect(text).toContain("都没有建立信任规则");
    expect(text).toContain("Tip:");
  });

  it("列表渲染含核心列：编号 / 生效范围 / contributors / 工具 / pattern", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "npm install *" },
      contributors: [
        { origin: "user", timestamp: 1_700_000_000_000 },
        { origin: "user", timestamp: 1_700_000_001_000 },
        { origin: "steward", timestamp: 1_700_000_002_000 },
      ],
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl([""]); // Enter 直接退出

    await handleTrustCommand("", { pipeline, rl, writer });

    const text = writer.joined();
    expect(text).toContain("[ 1]"); // 编号
    expect(text).toContain("主模式"); // 生效范围（contextId="main"）
    expect(text).toContain("[你 你 助理]"); // contributors token
    expect(text).toContain("bash"); // 工具
    expect(text).toContain("npm install *"); // pattern
  });

  it("工作场景上下文 → 生效范围显示「当前工作场景」", async () => {
    const wsDir = "/tmp/ws-trust-test";
    const contextId = PermissionStore.contextIdFromPath(wsDir);
    const { pipeline, store } = makePipeline({
      trustKind: "workspace",
      workspace: wsDir,
    });
    seedContextRule(store, contextId, {
      pattern: { tool: "bash", argument: "git push *" },
      contextPath: wsDir,
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl([""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    const text = writer.joined();
    expect(text).toContain("当前工作场景");
    expect(text).not.toContain("主模式");
  });

  it("global 规则 → 生效范围显示「全局」、无 contextId/contextPath", async () => {
    const { pipeline, store } = makePipeline();
    const rule = PermissionStore.createRule({
      pattern: { tool: "*", argument: "*" },
      decision: "allow",
      scope: "global",
      contributors: [{ origin: "user", timestamp: 1_700_000_000_000 }],
    });
    store.create("main", rule);
    const writer = new CollectWriter();
    const rl = makeFakeRl([""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(writer.joined()).toContain("全局");
    expect(rule.contextId).toBeUndefined();
    expect(rule.contextPath).toBeUndefined();
  });

  it("builtin 规则被过滤 —— 不进 /trust 面板", async () => {
    const { pipeline, store } = makePipeline();
    // 用户的 context 规则（应该显示）
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "ls" },
    });
    // 注入一条 builtin 规则（不应显示）
    store.registerBuiltinRules("test-ns", [
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "secret-tool" },
        decision: "allow",
        scope: "builtin",
      }),
    ]);
    const writer = new CollectWriter();
    const rl = makeFakeRl([""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    const text = writer.joined();
    expect(text).toMatch(/bash\s+ls/);
    expect(text).not.toContain("secret-tool");
  });

  it("输入有效编号 → 显示详情区（操作 / 范围 / 累计允许记录）", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "npm install *" },
      contributors: [
        { origin: "user", timestamp: 1_700_000_000_000 },
        { origin: "steward", timestamp: 1_700_000_001_000 },
      ],
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl(["1", ""]); // 输入 1 看详情，再 Enter 退出

    await handleTrustCommand("", { pipeline, rl, writer });

    const text = writer.joined();
    expect(text).toContain("详情");
    expect(text).toContain("操作：");
    expect(text).toContain("生效范围：");
    expect(text).toContain("累计放行记录");
    expect(text).toContain("[你]");
    expect(text).toContain("[安全助理]");
  });

  it("d<编号> + y → 撤销成功、列表少一条", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "npm install *" },
    });
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "git status" },
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl(["d1", "y", ""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(writer.joined()).toContain("已撤销");
    // 撤销后剩 1 条
    expect(store.list("main").filter((r) => r.scope === "context")).toHaveLength(1);
  });

  it("d<编号> + N（默认拒）→ 不撤销、保留规则", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "npm install *" },
    });
    const writer = new CollectWriter();
    // 第 1 轮：d1 + N（不撤销）；第 2 轮 Enter 退出
    const rl = makeFakeRl(["d1", "N", ""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(writer.joined()).toContain("已取消");
    expect(store.list("main").filter((r) => r.scope === "context")).toHaveLength(1);
  });

  it("非法编号（超出范围）→ 提示并继续循环", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "ls" },
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl(["99", ""]); // 99 越界、Enter 退出

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(writer.joined()).toContain("无效输入");
  });

  it("非法 d 编号 → 提示并继续循环（不影响规则）", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "ls" },
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl(["dabc", ""]); // d 后非数字、Enter 退出

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(writer.joined()).toContain("无效编号");
    expect(store.list("main").filter((r) => r.scope === "context")).toHaveLength(1);
  });

  it("Enter 空输入 → 立即退出，不抛错", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "ls" },
    });
    const writer = new CollectWriter();
    const rl = makeFakeRl([""]);

    await expect(
      handleTrustCommand("", { pipeline, rl, writer }),
    ).resolves.toBeUndefined();
  });

  it("撤销后列表实时刷新 —— 再撤一次仍正常", async () => {
    const { pipeline, store } = makePipeline();
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "a" },
    });
    seedContextRule(store, "main", {
      pattern: { tool: "bash", argument: "b" },
    });
    const writer = new CollectWriter();
    // 撤 1 → y → 再撤 1（此时原 [2] 变成 [1]）→ y → Enter 退出
    const rl = makeFakeRl(["d1", "y", "d1", "y", ""]);

    await handleTrustCommand("", { pipeline, rl, writer });

    expect(store.list("main").filter((r) => r.scope === "context")).toHaveLength(0);
  });
});
