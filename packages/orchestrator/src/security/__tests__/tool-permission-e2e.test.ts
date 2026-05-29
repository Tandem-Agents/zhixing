/**
 * 端到端验收测试 —— 信任沉淀(自动持久化)链路
 *
 * 验收目标:验证整条链路端到端工作:
 *   1. 连续多次放行(用户选 allow-once)→ ConfirmationTracker 累积计数
 *   2. 累计触达风险等级阈值 → 自动沉淀为持久 allow 规则(origin=user)
 *   3. 用户选 allow-context → applyBrokerDecision 调 store.create 创建规则
 *   4. 同操作再次执行 → pipeline.evaluate 匹配规则 → 直接 allow(不触发 confirm)
 *
 * 纯端到端验证 wiring。
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  PermissionStore,
  SecurityPipeline,
  type ConfirmationRequest,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import { createSecureExecuteTool } from "../secure-executor.js";

// ─── 测试辅助 ───

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    needsPermission: true,
    permissionArgumentKey: name === "bash" ? "command" : undefined,
    call: async () => ({ content: "ok", isError: false }),
  };
}

function makeContext(): ToolExecutionContext {
  return {
    workingDirectory: "/tmp/ws-e2e",
  };
}

function mockExecuteFactory() {
  let count = 0;
  return {
    fn: async (
      _tool: ToolDefinition,
      _input: Record<string, unknown>,
      _ctx: ToolExecutionContext,
    ): Promise<ToolResult> => {
      count += 1;
      return { content: "executed", isError: false };
    },
    callCount: () => count,
  };
}

// ─── 测试 ───

describe("Confirmation → PermissionRule 端到端链路", () => {
  it("连续 5 次 allow-once 累计达阈值 → 自动沉淀规则 → 后续直接 allow", async () => {
    // ─── 装配 ───
    // 真实 PermissionStore（in-memory）+ 真实 SecurityPipeline + 真实 broker。
    // SecurityPipeline 内部默认实例化 ConfirmationTracker（per-pipeline 生命周期）。
    const store = new PermissionStore({ rootDir: null });
    const pipeline = new SecurityPipeline({
      trustContext: { kind: "workspace", dir: "/tmp/ws-e2e" },
      permissionStore: store,
    });
    const broker = new ConfirmationBroker();
    const exec = mockExecuteFactory();
    const wrapped = createSecureExecuteTool({
      pipeline,
      originalExecute: exec.fn,
      broker,
    });

    // ─── 拦截器：捕获每次 ConfirmationRequest，统一 allow-once ───
    const capturedRequests: ConfirmationRequest[] = [];
    broker.onRequest((req) => {
      capturedRequests.push(req);
      queueMicrotask(() => broker.resolve(req.id, { kind: "allow-once" }));
    });

    // ─── 用 console.log spy 抑制确认 UI 文本 ───
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const bashTool = makeTool("bash");
      // 用 curl 命令——属于 medium 风险（network），阈值 5
      // bash patterns 对该命令产出：[精确, "curl *"]（looksLikeSubcommand 不匹配 https://...）
      const command = "curl https://example.com/foo";

      // ─── 前 3 次 allow-once：第 3 次 record 后累计达 medium 阈值（3）→ 自动沉淀 ───
      for (let i = 0; i < 3; i++) {
        await wrapped(bashTool, { command }, makeContext());
      }
      expect(capturedRequests).toHaveLength(3);
      expect(exec.callCount()).toBe(3);

      // 自动沉淀：中间精度 allow 规则（curl *），标记 origin=user
      const wsId = pipeline.getContextId();
      expect(wsId).toBeTruthy();
      const wsRules = store.list(wsId).filter((r) => r.scope === "context");
      expect(wsRules).toHaveLength(1);
      expect(wsRules[0]!.decision).toBe("allow");
      expect(wsRules[0]!.contributors?.map((c) => c.origin)).toContain("user");
      expect(wsRules[0]!.pattern.tool).toBe("bash");
      expect(wsRules[0]!.pattern.argument).toBe("curl *");

      // 第 4 次同操作 → 命中沉淀规则 → 直接 allow（无新 confirm）
      await wrapped(bashTool, { command }, makeContext());
      expect(exec.callCount()).toBe(4);
      expect(capturedRequests).toHaveLength(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("中途切换命令：累计同 tracker key（curl *）→ 自动沉淀中间精度规则 → 切换命令也命中", async () => {
    // 验证 buildKey 用 patterns[1]（中间精度）的语义：
    // - tracker 把 "curl https://a.com" 与 "curl https://b.com" 视为同一计数 key
    // - 但 allow-context 用精确 pattern 时，规则 argument 是用户选的具体 pattern
    const store = new PermissionStore({ rootDir: null });
    const pipeline = new SecurityPipeline({
      trustContext: { kind: "workspace", dir: "/tmp/ws-e2e" },
      permissionStore: store,
    });
    const broker = new ConfirmationBroker();
    const exec = mockExecuteFactory();
    const wrapped = createSecureExecuteTool({
      pipeline,
      originalExecute: exec.fn,
      broker,
    });

    const capturedRequests: ConfirmationRequest[] = [];
    broker.onRequest((req) => {
      capturedRequests.push(req);
      queueMicrotask(() => broker.resolve(req.id, { kind: "allow-once" }));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bashTool = makeTool("bash");
      // 5 次不同的 curl 命令——tracker 用 "curl *" 作为 key 累计
      const commands = [
        "curl https://a.com",
        "curl https://b.com",
        "curl https://c.com",
      ];
      for (const command of commands) {
        await wrapped(bashTool, { command }, makeContext());
      }
      expect(capturedRequests).toHaveLength(3);

      // 5 次不同 curl 累计到同一 key（curl *）→ 第 5 次自动沉淀中间精度规则
      const wsId = pipeline.getContextId();
      const wsRules = store.list(wsId).filter((r) => r.scope === "context");
      expect(wsRules).toHaveLength(1);
      expect(wsRules[0]!.pattern.argument).toBe("curl *");
      expect(wsRules[0]!.contributors?.map((c) => c.origin)).toContain("user");

      // 第 4 次切换命令（curl f）→ 命中 curl * → 直接 allow（中间精度覆盖切换命令）
      await wrapped(
        bashTool,
        { command: "curl https://f.com" },
        makeContext(),
      );
      expect(exec.callCount()).toBe(4);
      expect(capturedRequests).toHaveLength(3);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("用户中途选 allow-context（未到阈值）：仍创建规则；不影响 tracker 进度", async () => {
    // 验证 secure-executor.applyBrokerDecision 的分支独立性：
    // allow-context kind 走 store.create 路径，**不**调 tracker.record。
    // tracker 保持原有计数（即不会因为某次 allow-context 跳过计数）。
    const store = new PermissionStore({ rootDir: null });
    const pipeline = new SecurityPipeline({
      trustContext: { kind: "workspace", dir: "/tmp/ws-e2e" },
      permissionStore: store,
    });
    const broker = new ConfirmationBroker();
    const exec = mockExecuteFactory();
    const wrapped = createSecureExecuteTool({
      pipeline,
      originalExecute: exec.fn,
      broker,
    });

    const capturedRequests: ConfirmationRequest[] = [];
    broker.onRequest((req) => {
      capturedRequests.push(req);
      queueMicrotask(() => {
        // 第 1 次：用户直接选 allow-context（建议未触发，但用户主动选择）
        if (capturedRequests.length === 1) {
          // 此时 suggestion 可能是 undefined 或 suggest=false
          // 但 ConfirmationDecision.allow-context 必须携带 pattern——
          // 用 fallback：构造一个简单 pattern（与 command 一致）
          broker.resolve(req.id, {
            kind: "allow-context",
            pattern: {
              pattern: { tool: "bash", argument: "curl https://api1.com" },
              label: "curl https://api1.com",
            },
          });
        } else {
          broker.resolve(req.id, { kind: "allow-once" });
        }
      });
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bashTool = makeTool("bash");

      // 第 1 次：curl 命令（network 边界，需要 confirm）→ 选 allow-context
      await wrapped(
        bashTool,
        { command: "curl https://api1.com" },
        makeContext(),
      );

      // 验证规则创建
      const wsId = pipeline.getContextId();
      const wsRules = store.list(wsId).filter((r) => r.scope === "context");
      expect(wsRules).toHaveLength(1);
      expect(wsRules[0]!.pattern.argument).toBe("curl https://api1.com");

      // 第 2 次相同命令 → 直接 allow（不触发 confirm）
      await wrapped(
        bashTool,
        { command: "curl https://api1.com" },
        makeContext(),
      );
      expect(capturedRequests).toHaveLength(1); // 没新增 request
      expect(exec.callCount()).toBe(2);

      // 第 3 次不同命令（同工具但不命中规则）→ 仍触发 confirm；
      // tracker 应从 0 开始（allow-context 不 record）
      await wrapped(
        bashTool,
        { command: "curl https://api2.com" },
        makeContext(),
      );
      expect(capturedRequests).toHaveLength(2);
      // allow-context 不 record：tracker 对 curl 的累计只来自第 3 次 allow-once（count=1），
      // 不含第 1 次 allow-context（否则会是 2）
      const curlEntry = pipeline
        .getConfirmationTracker()
        .snapshot()
        .find((e) => e.key.includes("curl"));
      expect(curlEntry?.count).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  // 决策 6 核心安全 invariant：主模式自动沉淀**只**产生本上下文规则（scope=context +
  // contextId={kind:"main"}），**绝不**建 scope=global 规则。这从根本上消除"主模式
  // 不知不觉积出全局规则"的安全风险——global 规则只允许用户在 confirm 弹窗显式选
  // allow-global 时建立。任何让 maybePersistTrust 重新走 scope=global 分支的回归
  // （例如把 hard-coded `scope: "context"` 改回旧的三元 contextId-based 分支）都会
  // 在此处失败。
  it("主模式自动沉淀 → scope=context + contextId={kind:'main'}，不创建 global 规则", async () => {
    const store = new PermissionStore({ rootDir: null });
    const pipeline = new SecurityPipeline({
      trustContext: { kind: "global" },
      permissionStore: store,
    });
    const broker = new ConfirmationBroker();
    const exec = mockExecuteFactory();
    const wrapped = createSecureExecuteTool({
      pipeline,
      originalExecute: exec.fn,
      broker,
    });

    broker.onRequest((req) => {
      queueMicrotask(() => broker.resolve(req.id, { kind: "allow-once" }));
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const bashTool = makeTool("bash");
      const command = "curl https://example.com/foo";
      for (let i = 0; i < 3; i++) {
        await wrapped(bashTool, { command }, makeContext());
      }

      // 主模式 contextId = {kind:"main"} discriminated union
      expect(pipeline.getContextId()).toEqual({ kind: "main" });

      const all = store.list({ kind: "main" });
      const ctxRules = all.filter((r) => r.scope === "context");
      const globalRules = all.filter((r) => r.scope === "global");

      // 沉淀产 1 条 scope=context + contextId={kind:"main"} 的规则
      expect(ctxRules).toHaveLength(1);
      expect(ctxRules[0]!.contextId).toEqual({ kind: "main" });
      expect(ctxRules[0]!.pattern.argument).toBe("curl *");

      // 关键反向断言：绝不产生 global 规则
      expect(globalRules).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
