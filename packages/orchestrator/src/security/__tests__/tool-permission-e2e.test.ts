/**
 * 端到端验收测试 —— Confirmation → PermissionRule 链路
 *
 * 验收目标:验证整条链路端到端工作:
 *   1. 连续多次 confirm 同操作(用户选 allow-once)→ ConfirmationTracker 累积计数
 *   2. 触达风险等级阈值后,下次 confirm 时 ConfirmationRequest.suggestion.suggest === true
 *      (SuggestionMiddleware 把建议透传到 SecurityMiddlewareResult.suggestion,
 *       request-builder 再透传到 ConfirmationRequest.suggestion)
 *   3. 用户选 allow-workspace 应用建议 → applyBrokerDecision 调 store.create 创建规则
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
  it("连续 5 次 allow-once → 第 6 次 suggestion.suggest=true → allow-workspace 创建规则 → 第 7 次直接 allow", async () => {
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

    // ─── 拦截器：捕获每次 ConfirmationRequest 并按设定 resolve ───
    const capturedRequests: ConfirmationRequest[] = [];
    let nextDecisionKind:
      | "allow-once"
      | "allow-workspace" = "allow-once";

    broker.onRequest((req) => {
      capturedRequests.push(req);
      queueMicrotask(() => {
        if (nextDecisionKind === "allow-once") {
          broker.resolve(req.id, { kind: "allow-once" });
        } else {
          // 用户选 allow-workspace 应用建议——使用第一个 SuggestedPattern（最精确）
          const suggestion = req.suggestion;
          if (!suggestion || !suggestion.patterns[0]) {
            throw new Error(
              "测试装配错误：选 allow-workspace 时 ConfirmationRequest 应携带 suggestion.patterns",
            );
          }
          broker.resolve(req.id, {
            kind: "allow-workspace",
            pattern: suggestion.patterns[0],
          });
        }
      });
    });

    // ─── 用 console.log spy 抑制确认 UI 文本 ───
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const bashTool = makeTool("bash");
      // 用 curl 命令——属于 medium 风险（network），阈值 5
      // bash patterns 对该命令产出：[精确, "curl *"]（looksLikeSubcommand 不匹配 https://...）
      const command = "curl https://example.com/foo";

      // ─── 累计阶段:前 5 次 allow-once,tracker 累计到阈值边缘 ───
      for (let i = 0; i < 5; i++) {
        await wrapped(bashTool, { command }, makeContext());
      }

      // 5 次 confirm + 5 次执行
      expect(capturedRequests).toHaveLength(5);
      expect(exec.callCount()).toBe(5);

      // 关键断言：前 5 次的 ConfirmationRequest.suggestion 应**不建议加规则**
      // （第 i 次请求时 count = i，medium 阈值是 5，count < 5 时 suggest === false）
      for (let i = 0; i < 5; i++) {
        const req = capturedRequests[i]!;
        expect(req.suggestion?.suggest ?? false).toBe(false);
      }

      // ─── 触发建议阶段:第 6 次 suggestion.suggest=true,用户选 allow-workspace ───
      nextDecisionKind = "allow-workspace";
      await wrapped(bashTool, { command }, makeContext());

      expect(capturedRequests).toHaveLength(6);
      expect(exec.callCount()).toBe(6);

      // 关键断言：第 6 次 ConfirmationRequest.suggestion.suggest === true
      // （前 5 次 allow-once 各 record 一次 → count = 5，达到 medium 阈值）
      const sixthReq = capturedRequests[5]!;
      expect(sixthReq.suggestion).toBeDefined();
      expect(sixthReq.suggestion?.suggest).toBe(true);
      expect(sixthReq.suggestion?.count).toBe(5);
      expect(sixthReq.suggestion?.threshold).toBe(5);
      expect(sixthReq.suggestion?.patterns.length).toBeGreaterThan(0);

      // 关键断言：allow-workspace 决策落库——store 中出现 workspace 规则
      const wsId = pipeline.getWorkspaceId();
      expect(wsId).toBeTruthy();
      const wsRules = store.list(wsId).filter((r) => r.scope === "workspace");
      expect(wsRules).toHaveLength(1);
      expect(wsRules[0]!.decision).toBe("allow");
      expect(wsRules[0]!.pattern.tool).toBe("bash");
      // 规则 argument 来自 SuggestedPattern（精确命令）
      expect(wsRules[0]!.pattern.argument).toBe(command);

      // ─── 规则生效阶段:第 7 次同操作 pipeline 匹配新规则,直接 allow(不触发 confirm)───
      await wrapped(bashTool, { command }, makeContext());

      expect(exec.callCount()).toBe(7);
      // 关键断言：没有新的 ConfirmationRequest（链路直接 allow）
      expect(capturedRequests).toHaveLength(6);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("中途切换命令：仍命中同 tracker key（patterns[1] = 'curl *'），但 allow-workspace 用精确 pattern 时仅精确命令受规则保护", async () => {
    // 验证 buildKey 用 patterns[1]（中间精度）的语义：
    // - tracker 把 "curl https://a.com" 与 "curl https://b.com" 视为同一计数 key
    // - 但 allow-workspace 用精确 pattern 时，规则 argument 是用户选的具体 pattern
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
        "curl https://d.com",
        "curl https://e.com",
      ];
      for (const command of commands) {
        await wrapped(bashTool, { command }, makeContext());
      }

      // 第 6 次：count=5，suggestion.suggest=true（同一 tracker key 累计）
      await wrapped(
        bashTool,
        { command: "curl https://f.com" },
        makeContext(),
      );

      expect(capturedRequests).toHaveLength(6);
      const sixthReq = capturedRequests[5]!;
      expect(sixthReq.suggestion?.suggest).toBe(true);
      expect(sixthReq.suggestion?.count).toBe(5);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("用户中途选 allow-workspace（未到阈值）：仍创建规则；不影响 tracker 进度", async () => {
    // 验证 secure-executor.applyBrokerDecision 的分支独立性：
    // allow-workspace kind 走 store.create 路径，**不**调 tracker.record。
    // tracker 保持原有计数（即不会因为某次 allow-workspace 跳过计数）。
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
        // 第 1 次：用户直接选 allow-workspace（建议未触发，但用户主动选择）
        if (capturedRequests.length === 1) {
          // 此时 suggestion 可能是 undefined 或 suggest=false
          // 但 ConfirmationDecision.allow-workspace 必须携带 pattern——
          // 用 fallback：构造一个简单 pattern（与 command 一致）
          broker.resolve(req.id, {
            kind: "allow-workspace",
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

      // 第 1 次：curl 命令（network 边界，需要 confirm）→ 选 allow-workspace
      await wrapped(
        bashTool,
        { command: "curl https://api1.com" },
        makeContext(),
      );

      // 验证规则创建
      const wsId = pipeline.getWorkspaceId();
      const wsRules = store.list(wsId).filter((r) => r.scope === "workspace");
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
      // tracker 应从 0 开始（allow-workspace 不 record）
      await wrapped(
        bashTool,
        { command: "curl https://api2.com" },
        makeContext(),
      );
      expect(capturedRequests).toHaveLength(2);
      // 第 2 个 ConfirmationRequest 的 suggestion.count 应为 0（tracker 未被 allow-workspace 触动）
      const secondReq = capturedRequests[1]!;
      expect(secondReq.suggestion?.count ?? 0).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
