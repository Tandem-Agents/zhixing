/**
 * SecurityAuditor —— run 级审计发射器单元测试
 *
 * 覆盖：
 *   - auditEvaluation 按 result 内容发射 evaluation / classified / permission_matched / blocked / path_resolved
 *   - auditStewardReview 发射 steward_review 三态裁决
 *   - 缺字段时不发对应事件（边界）
 */

import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import { SecurityAuditor } from "../security-auditor.js";
import type {
  PermissionRule,
  SecurityDecision,
  SecurityMiddlewareResult,
} from "../types.js";

// ─── 测试辅助 ───

function makeBus(): EventBus<AgentEventMap> {
  return new EventBus<AgentEventMap>();
}

function makeDecision(over: Partial<SecurityDecision> = {}): SecurityDecision {
  return {
    action: "allow",
    matchedRules: [],
    reason: "ok",
    riskLevel: "medium",
    ...over,
  };
}

function makeResult(
  over: Partial<SecurityMiddlewareResult> = {},
): SecurityMiddlewareResult {
  return {
    allowed: true,
    operationClass: "external",
    decision: makeDecision(),
    ...over,
  };
}

// ─── auditEvaluation ───

describe("SecurityAuditor.auditEvaluation", () => {
  it("有 decision 时发射 evaluation 事件", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:evaluation", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "bash",
      toolInput: { command: "ls" },
      result: makeResult({
        decision: makeDecision({ action: "allow", riskLevel: "low" }),
        operationClass: "observe",
      }),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 3,
    });

    expect(events).toHaveLength(1);
    const payload = events[0] as {
      tool: string;
      decision: string;
      riskLevel: string;
      operationClass?: string;
      duration: number;
    };
    expect(payload.tool).toBe("bash");
    expect(payload.decision).toBe("allow");
    expect(payload.riskLevel).toBe("low");
    expect(payload.operationClass).toBe("observe");
    expect(payload.duration).toBe(3);
  });

  it("operationClass 存在时发射 classified 事件", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:classified", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "write",
      toolInput: { path: "src/a.ts" },
      result: makeResult({ operationClass: "external" }),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 1,
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { operationClass: string }).operationClass).toBe(
      "external",
    );
  });

  it("matchedPermissionRule 存在时发射 permission_matched", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:permission_matched", (p) => events.push(p));

    const rule: PermissionRule = {
      id: "r-1",
      pattern: { tool: "bash", argument: "curl *" },
      decision: "allow",
      scope: "global",
      origin: "user",
    };
    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "bash",
      toolInput: { command: "curl https://example.com" },
      result: makeResult({ matchedPermissionRule: rule }),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 1,
    });

    expect(events).toHaveLength(1);
    const payload = events[0] as { ruleId: string; decision: string };
    expect(payload.ruleId).toBe("r-1");
    expect(payload.decision).toBe("allow");
  });

  it("block 决策发射 blocked 事件", async () => {
    const bus = makeBus();
    const blocked: unknown[] = [];
    bus.on("security:blocked", (p) => blocked.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "write",
      toolInput: { path: ".git/config" },
      result: makeResult({
        allowed: false,
        decision: makeDecision({
          action: "block",
          reason: "git protected",
          riskLevel: "high",
        }),
      }),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 1,
    });

    expect(blocked).toHaveLength(1);
    expect((blocked[0] as { reason: string }).reason).toBe("git protected");
  });

  it("allow 决策不发射 blocked", async () => {
    const bus = makeBus();
    const blocked: unknown[] = [];
    bus.on("security:blocked", (p) => blocked.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "read",
      toolInput: { path: "src/a.ts" },
      result: makeResult(),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 1,
    });

    expect(blocked).toHaveLength(0);
  });

  it("resolvedPaths 存在时为每个路径发射 path_resolved", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:path_resolved", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "write",
      toolInput: { path: "src/a.ts" },
      result: makeResult({
        resolvedPaths: ["/abs/src/a.ts", "/abs/src/b.ts"],
      }),
      trust: { kind: "workspace", dir: "/abs" },
      cwd: "/abs",
      durationMs: 1,
    });

    expect(events).toHaveLength(2);
    expect(
      (events[0] as { resolvedPath: string }).resolvedPath,
    ).toBe("/abs/src/a.ts");
  });

  it("无 resolvedPaths 时不发射 path_resolved", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:path_resolved", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditEvaluation({
      toolName: "bash",
      toolInput: { command: "ls" },
      result: makeResult(),
      trust: { kind: "global" },
      cwd: "/tmp",
      durationMs: 1,
    });

    expect(events).toHaveLength(0);
  });
});

// ─── auditStewardReview ───

describe("SecurityAuditor.auditStewardReview", () => {
  it("发射 steward_review 含三态裁决 + reason/confidence", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:steward_review", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    await auditor.auditStewardReview({
      toolName: "bash",
      toolInput: { command: "curl https://x.com" },
      decision: "needs-confirm",
      reason: "意图不明确",
      confidence: 0.4,
    });

    expect(events).toHaveLength(1);
    const payload = events[0] as {
      tool: string;
      decision: string;
      reason: string;
      confidence: number;
    };
    expect(payload.tool).toBe("bash");
    expect(payload.decision).toBe("needs-confirm");
    expect(payload.reason).toBe("意图不明确");
    expect(payload.confidence).toBe(0.4);
  });

  it("三态裁决（safe/needs-confirm/escalate）都能正确发射", async () => {
    const bus = makeBus();
    const events: Array<{ decision: string }> = [];
    bus.on("security:steward_review", (p) =>
      events.push(p as { decision: string }),
    );

    const auditor = new SecurityAuditor(bus);
    for (const decision of ["safe", "needs-confirm", "escalate"] as const) {
      await auditor.auditStewardReview({
        toolName: "bash",
        toolInput: { command: "x" },
        decision,
        reason: "r",
        confidence: 0.5,
      });
    }

    expect(events.map((e) => e.decision)).toEqual([
      "safe",
      "needs-confirm",
      "escalate",
    ]);
  });
});

// ─── auditRuleSedimented ───
//
// 锁住"自动沉淀达阈值时 emit security:rule_sedimented + payload 完整"的契约。
// CLI 渲染层订阅此事件展示"已记住 N 次同类操作"沉淀提示 —— 任何 refactor 把
// emit 调用删了 / 改错 payload 字段，沉淀提示会 silently 丢失 + 在此 fail。

describe("SecurityAuditor.auditRuleSedimented", () => {
  it("发射 rule_sedimented 含完整 payload（tool/operation/pattern/scope/contextId/ruleId/contributors）", async () => {
    const bus = makeBus();
    const events: unknown[] = [];
    bus.on("security:rule_sedimented", (p) => events.push(p));

    const auditor = new SecurityAuditor(bus);
    const contributors = [
      { origin: "user" as const, timestamp: 1_700_000_000_000 },
      { origin: "user" as const, timestamp: 1_700_000_001_000 },
      { origin: "steward" as const, timestamp: 1_700_000_002_000 },
    ];

    await auditor.auditRuleSedimented({
      toolName: "bash",
      toolInput: { command: "curl https://example.com" },
      pattern: { tool: "bash", argument: "curl *" },
      scope: "context",
      contextId: { kind: "main" },
      ruleId: "rule-abc-123",
      contributors,
    });

    expect(events).toHaveLength(1);
    const payload = events[0] as {
      tool: string;
      operation: string;
      pattern: { tool: string; argument: string };
      scope: string;
      contextId: { kind: string };
      ruleId: string;
      contributors: typeof contributors;
    };
    expect(payload.tool).toBe("bash");
    expect(payload.operation).toContain("curl https://example.com");
    expect(payload.pattern).toEqual({ tool: "bash", argument: "curl *" });
    expect(payload.scope).toBe("context");
    expect(payload.contextId).toEqual({ kind: "main" });
    expect(payload.ruleId).toBe("rule-abc-123");
    expect(payload.contributors).toEqual(contributors);
  });

  it("PermissionContextId 三种 kind 都能在 payload 中正确透传", async () => {
    const bus = makeBus();
    const events: Array<{ contextId: { kind: string } }> = [];
    bus.on("security:rule_sedimented", (p) =>
      events.push(p as { contextId: { kind: string } }),
    );

    const auditor = new SecurityAuditor(bus);
    const ids = [
      { kind: "main" as const },
      { kind: "workspace" as const, hash: "abc123" },
      { kind: "scene" as const, sceneId: "my-scene" },
    ];

    for (const contextId of ids) {
      await auditor.auditRuleSedimented({
        toolName: "bash",
        toolInput: { command: "ls" },
        pattern: { tool: "bash", argument: "*" },
        scope: "context",
        contextId,
        ruleId: `r-${contextId.kind}`,
        contributors: [{ origin: "user", timestamp: 0 }],
      });
    }

    expect(events.map((e) => e.contextId)).toEqual(ids);
  });
});
