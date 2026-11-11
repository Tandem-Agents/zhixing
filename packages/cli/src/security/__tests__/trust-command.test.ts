/**
 * handleTrustCommand —— /trust 命令文本前端(执行体在宿主 trust.* RPC)。
 */

import { describe, expect, it, vi } from "vitest";
import type { PermissionRule, SecurityRule } from "@zhixing-ai/core/security";
import type { TrustAdministrationRule } from "@zhixing-ai/core/trust-administration";
import { handleSecurityCommand, handleTrustCommand } from "../commands.js";
import type { CliWriter } from "../../screen/index.js";

function makeWriter(): CliWriter & { text: () => string } {
  const lines: string[] = [];
  return {
    line: (t: string) => lines.push(t),
    text: () => lines.join("\n"),
  } as unknown as CliWriter & { text: () => string };
}

function makeRule(id: string): TrustAdministrationRule {
  return {
    id,
    pattern: { tool: "bash", argument: "ls" },
    decision: "allow",
    scope: "context",
    createdAt: 0,
    lastMatchedAt: 0,
    matchCount: 0,
    contextId: { kind: "main" },
  };
}

function policyRule(id: string, patch: Partial<SecurityRule> = {}): SecurityRule {
  return {
    id,
    name: `Policy ${id}`,
    description: "policy",
    enabled: true,
    match: { type: "tool", tools: ["bash"] },
    action: "confirm",
    bypassImmune: false,
    severity: "high",
    category: "code_injection",
    source: "builtin",
    message: "confirm",
    ...patch,
  } as SecurityRule;
}

describe("handleSecurityCommand", () => {
  it("无参：经宿主安全快照渲染概览", async () => {
    const writer = makeWriter();
    await handleSecurityCommand("", {
      status: async () => ({
        contextId: { kind: "main" },
        workspacePath: null,
        permissionRules: [makeRule("rule-a") as PermissionRule],
        builtinRules: [
          policyRule("safe-confirm"),
          policyRule("hard-block", {
            action: "block",
            bypassImmune: true,
            severity: "critical",
          }),
          // 不可覆盖但动作是确认：只算进不可覆盖一类
          policyRule("hard-confirm", { bypassImmune: true }),
        ],
        rateLimits: [{ key: "bash", used: 2, limit: 10 }],
        confirmations: [{ key: "bash::rm", count: 1, highestRisk: "critical" }],
      }),
      writer,
    });

    const text = writer.text();
    expect(text).toContain("安全状态");
    expect(text).toContain("主模式");
    // 按与信任规则的关系分档：block 直接拦截，不可覆盖的确认每次确认，其余可被放行；不把拦截说成确认
    expect(text).toContain("内置规则 3 条：直接拦截 1 · 每次确认 1 · 需要确认 1");
    expect(text).not.toMatch(/禁区/u);
    // 概览面向用户：不出现内部标识
    expect(text).not.toMatch(/contextId|bypassImmune/u);
    expect(text).toContain("本对话 0 · 当前范围 1 · 所有范围 0");
    expect(text).toContain("bash · rm  已允许 1 次 · 最高风险 极高");
    expect(text).toContain("bash  2 / 10");
    expect(text).toContain("主模式 · 本对话的默认范围");
  });

  it("有正在执行的运行时标出该运行的实际范围与冻结规则数", async () => {
    const writer = makeWriter();
    await handleSecurityCommand("", {
      status: async () => ({
        contextId: { kind: "main" },
        workspacePath: null,
        permissionRules: [],
        builtinRules: [],
        rateLimits: [],
        confirmations: [],
        scope: {
          kind: "run",
          runId: "run-1",
          contextId: { kind: "workspace", hash: "hash-a" },
          permissionRules: [makeRule("frozen-1") as PermissionRule],
        },
      }),
      writer,
    });
    const text = writer.text();
    expect(text).toContain("本次运行：工作区（标识 hash-a） · 使用开始时锁定的 1 条信任规则");
    expect(text).toContain("本对话的默认范围：主模式");
    // 下面的信任规则统计属于对话默认范围，不能读成运行正在用的那份
    expect(text).toContain("对话默认范围的信任规则 · 共 0 条");
  });

  it("rules：列出宿主返回的内置策略规则", async () => {
    const writer = makeWriter();
    await handleSecurityCommand("rules", {
      status: async () => ({
        contextId: { kind: "main" },
        workspacePath: null,
        permissionRules: [],
        builtinRules: [policyRule("safe-confirm")],
        rateLimits: [],
        confirmations: [],
      }),
      writer,
    });

    // 规则说明保留原列表的全部信息（名称、档位、风险、标识、不可覆盖）并附说明
    expect(writer.text()).toContain("规则说明");
    expect(writer.text()).toContain("内置规则 1 条：需要确认 1");
    expect(writer.text()).toMatch(/Policy safe-confirm {2}风险 \S+ · safe-confirm/u);
    expect(writer.text()).toContain("    policy");
  });

  it("宿主快照失败：可观测呈现而非抛出", async () => {
    const writer = makeWriter();
    await handleSecurityCommand("", {
      status: async () => {
        throw new Error("宿主不可用");
      },
      writer,
    });

    expect(writer.text()).toContain("安全状态不可用");
  });
});

describe("handleTrustCommand", () => {
  it("无参：列出宿主返回的用户规则", async () => {
    const writer = makeWriter();
    await handleTrustCommand("", {
      listRules: async () => [makeRule("rule-a")],
      revokeRule: vi.fn(),
      writer,
    });
    expect(writer.text()).toContain("rule-a");
    expect(writer.text()).toContain("信任规则 (1 条)");
  });

  it("无用户规则：提示暂无", async () => {
    const writer = makeWriter();
    await handleTrustCommand("", {
      listRules: async () => [],
      revokeRule: vi.fn(),
      writer,
    });
    expect(writer.text()).toContain("暂无信任规则");
  });

  it("revoke <id>：经宿主撤销并回执", async () => {
    const writer = makeWriter();
    const revokeRule = vi.fn(async () => true);
    await handleTrustCommand("revoke rule-a", {
      listRules: async () => [],
      revokeRule,
      writer,
    });
    expect(revokeRule).toHaveBeenCalledWith("rule-a");
    expect(writer.text()).toContain("已撤销");
  });

  it("revoke 不存在的 id：报不存在", async () => {
    const writer = makeWriter();
    await handleTrustCommand("revoke ghost", {
      listRules: async () => [],
      revokeRule: async () => false,
      writer,
    });
    expect(writer.text()).toContain("不存在");
  });

  it("listRules 失败:可观测呈现而非抛出", async () => {
    const writer = makeWriter();
    await handleTrustCommand("", {
      listRules: async () => {
        throw new Error("宿主不可用");
      },
      revokeRule: vi.fn(),
      writer,
    });
    expect(writer.text()).toContain("信任规则不可用");
  });

  it("groups other scopes after the current list and revokes a rule found in another scope", async () => {
    const writer = makeWriter();
    const staleContext = { kind: "workspace", hash: "hash-b" } as const;
    const listOtherScopes = vi.fn(async (after?: string) => after
      ? { groups: [] }
      : {
          groups: [{
            context: staleContext,
            label: "工作区「B」",
            effective: false,
            note: "目录已变更，这些规则不再生效，可撤销",
            rules: [{ ...makeRule("stale-rule"), contextId: { kind: "workspace" as const, hash: "hash-b", revision: 1 } }],
          }],
          next: "cursor-b",
        });
    const revokeRule = vi.fn(async () => false);
    const revokeRuleIn = vi.fn(async () => true);
    await handleTrustCommand("", { writer, listRules: async () => [makeRule("rule-1")], revokeRule, listOtherScopes, revokeRuleIn });
    const text = writer.text();
    expect(text).toContain("当前范围与全局 (1 条)");
    expect(text).toContain("其他范围");
    expect(text).toContain("工作区「B」");
    expect(text).toContain("不再生效");
    expect(text).toContain("/trust others cursor-b");

    await expect(handleTrustCommand("revoke stale-rule", { writer, listRules: async () => [], revokeRule, listOtherScopes, revokeRuleIn }))
      .resolves.toBe(true);
    expect(revokeRuleIn).toHaveBeenCalledWith("stale-rule", staleContext);

    const page = makeWriter();
    await handleTrustCommand("others cursor-b", { writer: page, listRules: async () => [], revokeRule, listOtherScopes, revokeRuleIn });
    expect(listOtherScopes).toHaveBeenLastCalledWith("cursor-b");
    expect(page.text()).toContain("没有其他范围的信任规则");
  });
});
