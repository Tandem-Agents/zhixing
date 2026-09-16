import type { ToolDefinition } from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  validateConversationCommunicationRequest,
  type ConversationCommunicationRequest,
} from "@zhixing/core/conversation/application";
import { runContextStorage } from "@zhixing/orchestrator/runtime";

/** 工具只绑定真实运行身份；不持有目标状态，也不编排协作。 */
export interface ConversationCommunicationTransport {
  invoke(sourceConversationId: string, request: ConversationCommunicationRequest): Promise<unknown>;
}

export function createConversationTool(
  transport: ConversationCommunicationTransport,
): ToolDefinition {
  return {
    name: "conversation",
    description:
      "发现、读取其他对话，发送消息或查询接纳与处理状态。使用前可加载“对话通信”技能；发送不会切换当前对话，回信仍用发送。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["discover", "read", "send", "observe"] },
        conversationId: { type: "string", description: "目标对话标识；读取时省略表示当前对话" },
        input: { type: "string", description: "发送的消息正文" },
        messageId: { type: "string", description: "观察时使用发送回执中的消息标识" },
        limit: { type: "integer", description: "历史页大小，1 到 200" },
        before: {
          type: "object",
          properties: { shardId: { type: "string" }, runIndex: { type: "integer" } },
          required: ["shardId", "runIndex"],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
    async call(input, context) {
      const run = runContextStorage.getStore();
      if (!run?.conversationId)
        return { content: "当前运行没有对话身份，无法使用对话通信。", isError: true };
      try {
        if (
          Object.keys(input).some(
            (key) =>
              !["action", "conversationId", "input", "messageId", "limit", "before"].includes(key),
          )
        )
          throw new Error("对话通信不接受额外参数或自报身份");
        // 发送身份来自本轮工具调用，模型不能自行填写来源或重试标识。
        const { action, ...parameters } = input;
        if (action === "send" && (!context.toolCallId || !context.turnId))
          throw new Error("发送缺少稳定的运行与工具调用身份");
        const request = validateConversationCommunicationRequest({
          action,
          ...parameters,
          ...(action === "read" && parameters.conversationId === undefined
            ? { conversationId: run.conversationId }
            : {}),
          ...(action === "send"
            ? {
                operationId: protocolDigest("ConversationTool", 1, {
                  turnId: context.turnId,
                  lineage: run.lineage,
                  toolCallId: context.toolCallId,
                }),
              }
            : {}),
        });
        const result = await transport.invoke(run.conversationId, request);
        return { content: JSON.stringify(result ?? null), isError: false };
      } catch (error) {
        return { content: error instanceof Error ? error.message : "对话通信失败", isError: true };
      }
    },
  };
}

/** 只在启动时连接一次；运行期直接使用已绑定的有限通信端口。 */
export function createConversationCommunicationAssemblyHandle() {
  let target: ConversationCommunicationTransport | undefined;
  return {
    port: Object.freeze({
      invoke: (source: string, request: ConversationCommunicationRequest) => {
        if (!target) throw new Error("对话通信尚未就绪");
        return target.invoke(source, request);
      },
    }),
    bind(value: ConversationCommunicationTransport) {
      if (target) throw new Error("对话通信不能重复装配");
      target = value;
    },
  };
}
