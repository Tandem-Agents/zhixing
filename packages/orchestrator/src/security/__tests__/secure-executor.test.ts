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
  EventBus,
  PermissionStore,
  SecurityPipeline,
  type AgentEventMap,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type ToolDefinition,
  type LLMRoles,
  type StreamEvent,
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

/** 注入一个产出固定管家裁决的 ctx.llm（main/light/power 同一 mock role）。 */
function makeContextWithSteward(
  verdictJSON: string,
  cwd: string = "/tmp/ws",
): ToolExecutionContext {
  const chat = async function* () {
    yield { type: "text_delta", text: verdictJSON } as StreamEvent;
  };
  const role = { provider: {}, model: "mock", chat };
  const llm = { main: role, light: role, power: role } as unknown as LLMRoles;
  return { workingDirectory: cwd, llm };
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

  describe("AI 安全管家路径", () => {
    it("管家 safe → 放行，跳过 broker，调 originalExecute", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      const result = await wrapped(
        makeTool("bash"),
        { command: "echo hello" },
        makeContextWithSteward('{"decision":"safe","reason":"对齐","confidence":0.9}'),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });

    it("管家 escalate → onBlocked + 抛 SecurityBlockError，不执行", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const onBlocked = vi.fn();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        onBlocked,
      });

      await expect(
        wrapped(
          makeTool("bash"),
          { command: "echo danger" },
          makeContextWithSteward('{"decision":"escalate","reason":"高危","confidence":0.8}'),
        ),
      ).rejects.toThrow(SecurityBlockError);
      expect(onBlocked).toHaveBeenCalled();
      expect(exec.callCount()).toBe(0);
    });

    it("管家 needs-confirm → 走 broker（allow-once 后执行），研判理由透传到确认请求", async () => {
      const broker = new ConfirmationBroker();
      let capturedReq: ConfirmationRequest | undefined;
      broker.onRequest((req) => {
        capturedReq = req;
        queueMicrotask(() => broker.resolve(req.id, { kind: "allow-once" }));
      });
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      const result = await wrapped(
        makeTool("bash"),
        { command: "echo gray" },
        makeContextWithSteward('{"decision":"needs-confirm","reason":"不确定","confidence":0.4}'),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
      // 管家研判理由透传到确认请求的展示信息，供 UI 向用户说明为何要确认
      expect(capturedReq?.display.stewardReason).toBe("不确定");
    });

    it("无 ctx.llm → 不触发管家，走 broker", async () => {
      const broker = new ConfirmationBroker();
      autoResolveBroker(broker, { kind: "allow-once" });
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      const result = await wrapped(
        makeTool("bash"),
        { command: "echo gray" },
        makeContext(),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });

    it("管家连续 safe 达阈值 → 自动沉淀（origin=steward）", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline, store } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });
      const ctx = makeContextWithSteward(
        '{"decision":"safe","reason":"对齐","confidence":0.9}',
      );

      // echo 属 external/medium，阈值 3；第 3 次管家 safe 后累计达阈值自动沉淀
      for (let i = 0; i < 3; i++) {
        await wrapped(makeTool("bash"), { command: "echo hello" }, ctx);
      }
      expect(exec.callCount()).toBe(3);

      const wsId = pipeline.getContextId();
      const wsRules = store.list(wsId).filter((r) => r.scope === "context");
      expect(wsRules).toHaveLength(1);
      expect(wsRules[0]!.decision).toBe("allow");
      expect(wsRules[0]!.contributors?.map((c) => c.origin)).toContain("steward");
    });
  });

  describe("信任沉淀底线", () => {
    it("critical 操作多次 → 永不沉淀（阈值 -1）", async () => {
      const broker = new ConfirmationBroker();
      autoResolveBroker(broker, { kind: "allow-once" });
      const exec = mockExecute();
      const { pipeline, store } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      // rm -rf 属 critical（threshold -1）；即便被 bypassImmune 拦截也不沉淀
      for (let i = 0; i < 6; i++) {
        try {
          await wrapped(
            makeTool("bash"),
            { command: "rm -rf /tmp/junk" },
            makeContext(),
          );
        } catch {
          // block 路径抛 SecurityBlockError —— 同样不沉淀
        }
      }
      expect(store.list(pipeline.getContextId())).toHaveLength(0);
    });

    it("bypassImmune confirm（写 .zhixing/）多次 allow-once → 永不沉淀", async () => {
      const broker = new ConfirmationBroker();
      autoResolveBroker(broker, { kind: "allow-once" });
      const exec = mockExecute();
      const { pipeline, store } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      // 写 .zhixing/ 命中 bi-zhixing-config-write（bypassImmune + confirm）；
      // 即便 4 次（超 medium 阈值 3）也永不沉淀（maybePersistTrust bypassImmune 守卫）
      for (let i = 0; i < 4; i++) {
        await wrapped(
          makeTool("write"),
          { path: ".zhixing/config.json" },
          makeContext(),
        );
      }
      expect(store.list(pipeline.getContextId())).toHaveLength(0);
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

  // 验证 secure-executor 的 audit 接线：传入 eventBus 时确实发射事件、不传则不发（向后兼容）
  // SecurityAuditor 的发射内容由 security-auditor.test 单测覆盖，这里只验证调用链路
  describe("安全审计接线", () => {
    it("传入 eventBus → evaluate 后发射 security:evaluation 事件", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const eventBus = new EventBus<AgentEventMap>();
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("security:evaluation", (p) =>
        events.push(p as Record<string, unknown>),
      );

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        eventBus,
      });

      await wrapped(makeTool("read"), { path: "/tmp/a" }, makeContext());

      expect(events).toHaveLength(1);
      expect(events[0]!.tool).toBe("read");
      expect(events[0]!.decision).toBeDefined();
      expect(typeof events[0]!.duration).toBe("number");
    });

    it("传入 eventBus + 管家 needs-confirm → 发射 security:steward_review 事件", async () => {
      const broker = new ConfirmationBroker();
      autoResolveBroker(broker, { kind: "allow-once" });
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const eventBus = new EventBus<AgentEventMap>();
      const events: Array<Record<string, unknown>> = [];
      eventBus.on("security:steward_review", (p) =>
        events.push(p as Record<string, unknown>),
      );

      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        eventBus,
      });

      await wrapped(
        makeTool("bash"),
        { command: "curl https://example.com/gray" },
        makeContextWithSteward(
          '{"decision":"needs-confirm","reason":"灰色操作需用户确认","confidence":0.4}',
        ),
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.decision).toBe("needs-confirm");
      expect(events[0]!.reason).toBe("灰色操作需用户确认");
      expect(events[0]!.confidence).toBe(0.4);
    });

    it("不传 eventBus → 不发射事件、不影响放行（向后兼容）", async () => {
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
        { path: "/tmp/a" },
        makeContext(),
      );
      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });
  });

  // turnContext.userIntent 是子 agent 透传的入口字段——secure-executor 把它
  // 展开到 augmentedContext.userIntent，让子工具（Task）能从 ctx.userIntent 读取
  // 并沿 runChildAgent → loop-runner → 子 secure-executor 接力，使管家在
  // 整个子 agent 链路中仍按顶层用户意图研判。
  describe("userIntent 展开（管家研判与子 agent 透传的源头）", () => {
    it("turnContext.userIntent → augmentedContext.userIntent → 工具 ctx 可读", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
        turnContext: {
          userIntent: "调研 X 并整理笔记",
        },
      });

      await wrapped(makeTool("read"), { path: "/tmp/a" }, makeContext());

      const ctx = exec.lastContext();
      expect(ctx?.userIntent).toBe("调研 X 并整理笔记");
    });

    it("无 turnContext → ctx.userIntent 保持 undefined（不破坏既有行为）", async () => {
      const broker = new ConfirmationBroker();
      const exec = mockExecute();
      const { pipeline } = makePipeline();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        broker,
      });

      await wrapped(makeTool("read"), { path: "/tmp/a" }, makeContext());

      const ctx = exec.lastContext();
      expect(ctx?.userIntent).toBeUndefined();
    });
  });
});
