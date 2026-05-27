/**
 * createSecureExecuteTool 单元测试 —— broker 路径 + 回调通知 + 执行约束
 *
 * 端到端的 confirmation → PermissionRule 链路在 tool-permission-e2e.test.ts 覆盖;
 * 本文件聚焦单一职责:
 *   - 放行路径直接调用 originalExecute
 *   - block 路径(显式 deny 规则)触发 onBlocked + 抛 SecurityBlockError
 *   - confirm + broker 路径在用户 deny 时触发 onUserDenied + 抛错
 *   - confirm + broker 路径在 allow-once 时调用 originalExecute
 *   - turnContext 字段(turnId / turnOrigin / commitToUser)正确展开到 ToolExecutionContext
 *   - expired 决策按 confirmationFallback 分支处理
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  PermissionStore,
  SecurityPipeline,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import {
  SecurityBlockError,
  createSecureExecuteTool,
} from "../secure-executor.js";

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

function makeContext(cwd: string = "/tmp/ws"): ToolExecutionContext {
  return { workingDirectory: cwd };
}

function mockExecute(): {
  fn: (
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolResult>;
  callCount: () => number;
  lastContext: () => ToolExecutionContext | undefined;
} {
  let count = 0;
  let lastCtx: ToolExecutionContext | undefined;
  return {
    fn: async (_tool, _input, ctx) => {
      count++;
      lastCtx = ctx;
      return { content: "executed", isError: false };
    },
    callCount: () => count,
    lastContext: () => lastCtx,
  };
}

function makePipeline(): { pipeline: SecurityPipeline; store: PermissionStore } {
  const store = new PermissionStore({ rootDir: null });
  const pipeline = new SecurityPipeline({
    trustContext: { kind: "workspace", dir: "/tmp/ws" },
    permissionStore: store,
  });
  return { pipeline, store };
}

/**
 * 把 broker 配成自动 resolver:收到 request 后异步 resolve 给定 decision。
 * 必须 queueMicrotask 让 broker 完成入队/showHead 后再 resolve(避免重入)。
 */
function autoResolveBroker(
  broker: ConfirmationBroker,
  decision: ConfirmationDecision | ((req: ConfirmationRequest) => ConfirmationDecision),
): void {
  broker.onRequest((req) => {
    queueMicrotask(() => {
      const resolved = typeof decision === "function" ? decision(req) : decision;
      broker.resolve(req.id, resolved);
    });
  });
}

// ─── 测试 ───

describe("createSecureExecuteTool", () => {
  describe("放行路径", () => {
    it("read 工具默认放行,直接调用 originalExecute", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      const result = await wrapped(
        makeTool("read"),
        { path: "/tmp/foo" },
        makeContext(),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });
  });

  describe("block 路径(显式 deny 规则)", () => {
    it("匹配 deny 规则触发 onBlocked + 抛 SecurityBlockError,不调 originalExecute", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const onBlocked = vi.fn();
      const { pipeline, store } = makePipeline();

      // 显式注册 deny 规则:`bash` 工具的 `dangerous *` 命令
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "dangerous *" },
          decision: "deny",
          scope: "global",
        }),
      );

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        onBlocked,
      });

      await expect(
        wrapped(makeTool("bash"), { command: "dangerous attack" }, makeContext()),
      ).rejects.toThrow(SecurityBlockError);

      expect(onBlocked).toHaveBeenCalledTimes(1);
      expect(exec.callCount()).toBe(0);
    });

    it("不传 onBlocked 时静默(仍然抛错)", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline, store } = makePipeline();

      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "dangerous *" },
          decision: "deny",
          scope: "global",
        }),
      );

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      await expect(
        wrapped(makeTool("bash"), { command: "dangerous attack" }, makeContext()),
      ).rejects.toThrow(SecurityBlockError);

      expect(exec.callCount()).toBe(0);
    });
  });

  describe("confirm + broker 路径", () => {
    // 用 curl https://...(network medium 风险)触发 confirm,与 e2e 测试约定一致
    const CONFIRM_TOOL_INPUT = { command: "curl https://example.com/foo" };

    it("用户选 deny 触发 onUserDenied + 抛 SecurityBlockError", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const onUserDenied = vi.fn();
      const { pipeline } = makePipeline();
      autoResolveBroker(broker, { kind: "deny", reason: "请用更小的范围" });

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        onUserDenied,
      });

      await expect(
        wrapped(makeTool("bash"), CONFIRM_TOOL_INPUT, makeContext()),
      ).rejects.toThrow(SecurityBlockError);

      expect(onUserDenied).toHaveBeenCalledWith(
        "bash",
        CONFIRM_TOOL_INPUT,
        "请用更小的范围",
      );
      expect(exec.callCount()).toBe(0);
    });

    it("用户选 allow-once 后调用 originalExecute", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      autoResolveBroker(broker, { kind: "allow-once" });

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      const result = await wrapped(
        makeTool("bash"),
        CONFIRM_TOOL_INPUT,
        makeContext(),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });

    it("expired + 默认 fallback (deny) 抛错", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      autoResolveBroker(broker, { kind: "expired" });

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      await expect(
        wrapped(makeTool("bash"), CONFIRM_TOOL_INPUT, makeContext()),
      ).rejects.toThrow(SecurityBlockError);
      expect(exec.callCount()).toBe(0);
    });

    it("expired + auto-approve-safe 在 external 类(curl)仍然拒绝", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      autoResolveBroker(broker, { kind: "expired" });

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        confirmationFallback: "auto-approve-safe",
      });

      // bash + curl 走 external/critical 分支,即使 auto-approve-safe 仍然拒绝
      await expect(
        wrapped(makeTool("bash"), CONFIRM_TOOL_INPUT, makeContext()),
      ).rejects.toThrow(SecurityBlockError);
    });
  });

  describe("turnContext 透传", () => {
    it("turnId / turnOrigin / commitToUser 展开到 ToolExecutionContext", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const commitFn = vi.fn(async () => ({ success: true } as never));
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        turnContext: {
          turnId: "turn_abc_123",
          turnOrigin: { channel: "feishu", triggeredBy: "u-1" },
          commitToUser: commitFn,
        },
      });

      await wrapped(
        makeTool("read"),
        { path: "/tmp/x" },
        makeContext(),
      );

      const ctx = exec.lastContext();
      expect(ctx?.turnId).toBe("turn_abc_123");
      expect(ctx?.turnOrigin).toEqual({ channel: "feishu", triggeredBy: "u-1" });
      // commitToUser 被包装了一层(自动注入 toolName),不直接 ===
      expect(ctx?.commitToUser).toBeDefined();
    });
  });
});
