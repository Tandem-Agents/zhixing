import {
  isLocalConversationId,
  parseConversationId,
} from "@zhixing-ai/core/conversation";
import {
  classifyConversationDirectoryScope,
  PROGRAM_TURN_CHANNEL,
} from "@zhixing-ai/core/conversation/application";
import { isWorksceneSupportConversation } from "@zhixing-ai/core/workscene/application";
import type { RunContext } from "@zhixing-ai/orchestrator/runtime";

export type RuntimeSessionKind =
  | "main"
  | "workscene"
  | "channel"
  | "isolated"
  | "local"
  | "ephemeral"
  | "sub-agent"
  | "orchestration-node";

const FIRST_PARTY_ORIGIN_CHANNELS = new Set<string>([
  "rpc",
  "local",
  "cli",
  "tui",
  "direct",
  "scheduler",
  "program",
  "system",
  "workscene",
  "extension",
  PROGRAM_TURN_CHANNEL,
]);

/**
 * 外部受管通道并集门控（核心安全边界）：
 * 1) 固有通道会话 ID（classifyConversationDirectoryScope(id) === "channel"），覆盖经 program/RPC 触发的同会话轮次；
 * 2) 当轮 turnOrigin 属于外部受管通道（target.channelId、channel sourceKind 或非内建控制 channel 标识），覆盖共享映射到 "default" 的私聊轮次。
 */
export function isChannelRuntimeTurn(run: RunContext | undefined): boolean {
  if (!run) return false;
  if (
    run.conversationId &&
    classifyConversationDirectoryScope(run.conversationId) === "channel"
  ) {
    return true;
  }
  const origin = run.turnOrigin;
  if (!origin) return false;
  if (origin.messageIdentity?.source.kind === "channel") return true;
  if (typeof origin.target?.channelId === "string" && origin.target.channelId.length > 0) {
    return true;
  }
  if (
    typeof origin.channel === "string" &&
    origin.channel.length > 0 &&
    !FIRST_PARTY_ORIGIN_CHANNELS.has(origin.channel)
  ) {
    return true;
  }
  return false;
}

export function resolveRuntimeSessionKind(
  run: RunContext | undefined,
): RuntimeSessionKind {
  if (
    run?.runtimeKind === "orchestration-node" ||
    run?.lineage?.startsWith("orchestration:")
  ) {
    return "orchestration-node";
  }
  if (
    run?.runtimeKind === "sub-agent" ||
    (run?.lineage !== undefined && run.lineage !== "main")
  ) {
    return "sub-agent";
  }
  if (run?.runtimeKind === "ephemeral") {
    return "ephemeral";
  }
  if (isChannelRuntimeTurn(run)) {
    return "channel";
  }
  const conversationId = run?.conversationId;
  if (conversationId) {
    if (isWorksceneSupportConversation(conversationId)) return "isolated";
    if (isLocalConversationId(conversationId)) return "local";
    if (parseConversationId(conversationId).scope.kind === "workscene") {
      return "workscene";
    }
  }
  return "main";
}
