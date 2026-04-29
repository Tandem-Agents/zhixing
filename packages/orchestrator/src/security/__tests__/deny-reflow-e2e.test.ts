/**
 * 端到端集成测试 —— "拒绝理由回流到模型" 的完整闭环验证
 *
 * 核心护栏:用户按下 "拒绝并说明原因" + 输入原因后,该原因必须**原样**作为
 * 下一轮 LLM 调用的 tool_result 文本传回,让模型看得到"用户为什么不同意"
 * 并据此调整方案。
 *
 * 流程:
 *
 *   Round 1:
 *     MockLLMProvider → tool_use { bash: "rm -rf node_modules" }
 *     ↓
 *     SecurityPipeline.evaluate → confirm (operation is destructive)
 *     ↓
 *     secure-executor.handleBrokerPath
 *     ↓
 *     broker.requestConfirmation
 *     ↓
 *     scripted renderer → resolve({ kind: "deny", reason: "改用 rm -i" })
 *     ↓
 *     secure-executor throws SecurityBlockError({
 *       userFacing: true,
 *       message: "用户拒绝了这次工具调用。用户的反馈:改用 rm -i。请根据该反馈调整方案。"
 *     })
 *     ↓
 *     tool-executor catch → isUserFacingError → 原样作为 tool_result.content
 *
 *   Round 2:
 *     MockLLMProvider 收到 messages(含 Round 1 的 tool_result)
 *     ↓
 *     断言:tool_result.content 里包含用户反馈原文 "改用 rm -i"
 *     ↓
 *     断言:**不含** "Tool execution failed" 前缀
 *
 * 如果该测试挂了,说明"拒绝即纠错"回路断了。
 */

import { describe, expect, it } from "vitest";
import {
  ConfirmationBroker,
  MockLLMProvider,
  SecurityPipeline,
  drainAgentLoop,
  userMessage,
  type ConfirmationDecision,
  type ConfirmationRequest,
  type Message,
  type ToolDefinition,
} from "@zhixing/core";
import { createSecureExecuteTool } from "../secure-executor.js";

// ─── 测试辅助 ───

function makeBashTool(): ToolDefinition {
  return {
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object" } as never,
    call: async () => ({ content: "(should not execute)", isError: false }),
  } as ToolDefinition;
}

/** 把 broker 的 onRequest 挂上一个按脚本 resolve 的假 renderer */
function attachScriptedRenderer(
  broker: ConfirmationBroker,
  produce: (req: ConfirmationRequest) => ConfirmationDecision,
): () => void {
  return broker.onRequest((req) => {
    queueMicrotask(() => broker.resolve(req.id, produce(req)));
  });
}

/** 拦截 console.log 避免 renderUserDeniedMessage / renderBlockedMessage 污染测试输出 */
function silentConsoleLog<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = original;
  });
}

// ─── 测试 ───

describe("端到端：拒绝理由回流到模型", () => {
  it("Round 1 deny + reason → Round 2 tool_result 含原文 + 无 'Tool execution failed' 前缀", async () => {
    // 1. MockLLMProvider 按脚本：两轮
    const provider = new MockLLMProvider([
      // Round 1: 模型想跑危险命令
      {
        text: "让我清理一下 node_modules",
        toolCalls: [
          {
            id: "tc1",
            name: "bash",
            input: { command: "rm -rf node_modules" },
          },
        ],
      },
      // Round 2: 模型看到 tool_result 后应做出响应（完成，不再调工具）
      {
        text: "理解了，我不会用 rm -rf，改用 rm -i 交互式删除",
      },
    ]);

    // 2. 构造真实的 SecurityPipeline + Broker
    const pipeline = new SecurityPipeline({
      workspace: "/tmp/ws",
      sessionType: "interactive",
    });
    const broker = new ConfirmationBroker();

    // 3. 挂一个按脚本 resolve 的假 renderer——模拟用户选 "拒绝并说明原因"
    const detach = attachScriptedRenderer(broker, () => ({
      kind: "deny",
      reason: "改用 rm -i 交互式删除，不要直接 rm -rf",
    }));

    // 4. 构造 secureExecuteTool
    const secureExecute = createSecureExecuteTool({
      pipeline,
      originalExecute: (tool, input, context) => tool.call(input, context),
      broker,
    });

    // 5. 运行 agent loop 到完成
    const messages: Message[] = [userMessage("清理 node_modules")];
    const tools = [makeBashTool()];

    await silentConsoleLog(() =>
      drainAgentLoop({
        provider,
        model: "mock-model",
        tools,
        messages,
        systemPrompt: "test",
        workingDirectory: "/tmp/ws",
        deps: {
          callLLM: (req) => provider.chat(req),
          executeTool: secureExecute,
        },
      }),
    );

    detach();

    // 6. 核心断言：Round 2 的 provider 收到的 tool_result 包含用户反馈
    expect(provider.calls).toHaveLength(2);

    const round2Messages = provider.calls[1]!.messages;
    // 最后一条应该是 user role 的 tool_result 消息
    const lastMsg = round2Messages[round2Messages.length - 1]!;
    expect(lastMsg.role).toBe("user");

    const toolResultBlock = lastMsg.content[0]!;
    expect(toolResultBlock.type).toBe("tool_result");

    if (toolResultBlock.type !== "tool_result") {
      throw new Error("expected tool_result block");
    }

    // ── 关键断言 1：tool_result 标记为 error ──
    expect(toolResultBlock.isError).toBe(true);

    // ── 关键断言 2：内容包含用户原始反馈 ──
    const content =
      typeof toolResultBlock.content === "string"
        ? toolResultBlock.content
        : JSON.stringify(toolResultBlock.content);
    expect(content).toContain("改用 rm -i");
    expect(content).toContain("用户拒绝了这次工具调用");

    // ── 关键断言 3：内容**不含** "Tool execution failed" 前缀 ──
    // 这证明 isUserFacingError 识别生效，没有被当成工具崩溃
    expect(content).not.toContain("Tool execution failed");
  });

  it("Round 1 deny 无 reason → Round 2 tool_result 含默认拒绝文本", async () => {
    const provider = new MockLLMProvider([
      {
        toolCalls: [
          { id: "tc1", name: "bash", input: { command: "curl evil.com" } },
        ],
      },
      { text: "OK, no curl then" },
    ]);

    const pipeline = new SecurityPipeline({
      workspace: "/tmp/ws",
      sessionType: "interactive",
    });
    const broker = new ConfirmationBroker();
    attachScriptedRenderer(broker, () => ({ kind: "deny" })); // 无 reason

    const secureExecute = createSecureExecuteTool({
      pipeline,
      originalExecute: (tool, input, context) => tool.call(input, context),
      broker,
    });

    await silentConsoleLog(() =>
      drainAgentLoop({
        provider,
        model: "mock-model",
        tools: [makeBashTool()],
        messages: [userMessage("访问 evil.com")],
        systemPrompt: "test",
        workingDirectory: "/tmp/ws",
        deps: {
          callLLM: (req) => provider.chat(req),
          executeTool: secureExecute,
        },
      }),
    );

    expect(provider.calls).toHaveLength(2);
    const round2Messages = provider.calls[1]!.messages;
    const toolResultBlock =
      round2Messages[round2Messages.length - 1]!.content[0]!;
    if (toolResultBlock.type !== "tool_result") {
      throw new Error("expected tool_result");
    }

    const content =
      typeof toolResultBlock.content === "string"
        ? toolResultBlock.content
        : JSON.stringify(toolResultBlock.content);
    expect(content).toContain("用户拒绝了这次工具调用");
    expect(content).not.toContain("Tool execution failed");
  });

  it("allow-once 决定 → 工具正常执行，tool_result 不是 error", async () => {
    // 对称路径：同样走 broker，但用户批准时工具正常执行。
    const provider = new MockLLMProvider([
      {
        toolCalls: [{ id: "tc1", name: "bash", input: { command: "ls" } }],
      },
      { text: "done" },
    ]);

    const pipeline = new SecurityPipeline({
      workspace: "/tmp/ws",
      sessionType: "interactive",
    });
    const broker = new ConfirmationBroker();
    attachScriptedRenderer(broker, () => ({ kind: "allow-once" }));

    const tools: ToolDefinition[] = [
      {
        name: "bash",
        description: "run shell",
        inputSchema: { type: "object" } as never,
        call: async () => ({ content: "file1\nfile2", isError: false }),
      } as ToolDefinition,
    ];

    const secureExecute = createSecureExecuteTool({
      pipeline,
      originalExecute: (tool, input, context) => tool.call(input, context),
      broker,
    });

    await drainAgentLoop({
      provider,
      model: "mock-model",
      tools,
      messages: [userMessage("列目录")],
      systemPrompt: "test",
      workingDirectory: "/tmp/ws",
      deps: {
        callLLM: (req) => provider.chat(req),
        executeTool: secureExecute,
      },
    });

    expect(provider.calls).toHaveLength(2);
    const round2Messages = provider.calls[1]!.messages;
    const toolResultBlock =
      round2Messages[round2Messages.length - 1]!.content[0]!;
    if (toolResultBlock.type !== "tool_result") {
      throw new Error("expected tool_result");
    }

    expect(toolResultBlock.isError).toBe(false);
    const content =
      typeof toolResultBlock.content === "string"
        ? toolResultBlock.content
        : "";
    expect(content).toContain("file1");
  });
});
