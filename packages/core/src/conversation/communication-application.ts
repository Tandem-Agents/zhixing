import type { ConversationRunState } from "../contracts/index.js";
import { isProtocolIdentifier, protocolDigest } from "../protocol/index.js";
import type { Message, MessageInputIdentity } from "../types/messages.js";
import { normalizeUserTurnInput, isNonEmptyUserTurnInput, type UserTurnInput, type UserTurnInputLike } from "../types/user-input.js";
import type { TurnOrigin } from "../types/tools.js";
import { bindProductApiOperation, defineProductApiQuery, defineProductApiCommand, defineProductApiContribution, defineProductApiExactSet } from "../product-api/catalog.js";
import {
  ConversationApplicationError,
  type ConversationAgentTurnExecutionPort,
  type ConversationCommandCaller,
  type ConversationDirectoryApplication,
  type ConversationHistoryCursor,
} from "./application.js";

export interface ConversationMessageStatus {
  readonly runId: string;
  readonly state: ConversationRunState;
  /** 已交付给执行方的正式输入，不等同于模型已完成处理。 */
  readonly consumed: boolean;
  /** stopped：输入已关闭或 Run 已终止，消息未消费；不自动重入队，重试原操作也不重开运行。 */
  readonly disposition: "pending" | "consumed" | "stopped";
  readonly message: Message;
}

/** 查询接收方权威；不在发送方维护运行或消息账本。 */
export interface ConversationMessageProjectionPort {
  inspect(conversationId: string, messageId: string): Promise<ConversationMessageStatus | undefined>;
  /** 尚未进入正式历史的输入，包括运行中输入及终止后未处理的来信。 */
  inputsOutsideHistory(conversationId: string): Promise<{
    readonly inputs: readonly ConversationMessageStatus[];
    readonly truncated: boolean;
  }>;
}

export interface ConversationMessageExecutionRequest {
  readonly input: UserTurnInput;
  readonly turnId: string;
  readonly turnOrigin: TurnOrigin;
  readonly caller: Extract<ConversationCommandCaller, { kind: "surface" }>;
}

/** 表面与模型共用的通信合同；调用方身份由系统绑定，不来自消息正文。 */
export type ConversationCommunicationApplication = Pick<ConversationCommunicationApplicationService, "discover" | "read" | "send" | "observe">;
export type ConversationCommunicationHistory = Awaited<ReturnType<ConversationCommunicationApplication["read"]>>;
export type ConversationCommunicationRequest =
  | { readonly action: "discover" }
  | ({ readonly action: "read" } & Parameters<ConversationCommunicationApplication["read"]>[0])
  | ({ readonly action: "send" } & Parameters<ConversationCommunicationApplication["send"]>[0])
  | ({ readonly action: "observe" } & Parameters<ConversationCommunicationApplication["observe"]>[0]);

export function validateConversationCommunicationRequest(value: unknown): ConversationCommunicationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("需要对话通信参数");
  const input = value as Record<string, unknown>;
  const fields = input.action === "discover" ? ["action"] : input.action === "read" ? ["action", "conversationId", "limit", "before"]
    : input.action === "send" ? ["action", "conversationId", "operationId", "input"] : input.action === "observe" ? ["action", "conversationId", "messageId"] : [];
  if (!fields.length || Object.keys(input).some(key => !fields.includes(key))) throw new TypeError("对话通信参数无效");
  if (input.action !== "discover") assertId(input.conversationId as string);
  if (input.action === "send") {
    assertId(input.operationId as string);
    if (typeof input.input !== "string" || !input.input.trim()) throw new TypeError("消息内容不能为空");
  }
  if (input.action === "observe") assertId(input.messageId as string);
  if (input.action === "read") {
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 200)) throw new TypeError("读取数量须为 1 到 200");
    if (input.before !== undefined) {
      const cursor = input.before as ConversationHistoryCursor;
      if (!cursor || typeof cursor !== "object" || Object.keys(cursor).sort().join(",") !== "runIndex,shardId" || !isProtocolIdentifier(cursor.shardId) || !Number.isSafeInteger(cursor.runIndex) || cursor.runIndex < 0) throw new TypeError("历史游标无效");
    }
  }
  return input as ConversationCommunicationRequest;
}

export async function dispatchConversationCommunication(application: ConversationCommunicationApplication, request: ConversationCommunicationRequest): Promise<unknown> {
  switch (request.action) {
    case "discover": return application.discover();
    case "read": return application.read(request);
    case "send": return application.send(request);
    case "observe": return (await application.observe(request)) ?? null;
  }
}

export interface ConversationCommunicationInvocation {
  readonly sourceConversationId: string;
  readonly request: ConversationCommunicationRequest;
}
export const CONVERSATION_COMMUNICATION_QUERY = defineProductApiQuery<"conversation-communication.query.read", ConversationCommunicationInvocation, unknown>("conversation-communication.query.read");
export const CONVERSATION_COMMUNICATION_SEND = defineProductApiCommand<"conversation-communication.command.send", ConversationCommunicationInvocation, unknown, never>("conversation-communication.command.send", []);
export const CONVERSATION_COMMUNICATION_PRODUCT_API_EXACT_SET = defineProductApiExactSet({ operations: [CONVERSATION_COMMUNICATION_QUERY, CONVERSATION_COMMUNICATION_SEND], factEvents: [] });
export function createConversationCommunicationProductApiContribution(invoke: (sourceConversationId: string, request: ConversationCommunicationRequest) => Promise<unknown>) {
  return defineProductApiContribution({ operations: [
    bindProductApiOperation(CONVERSATION_COMMUNICATION_QUERY, async input => {
      assertId(input.sourceConversationId);
      validateConversationCommunicationRequest(input.request);
      if (input.request.action === "send") throw new TypeError("查询不能发送消息");
      return { result: await invoke(input.sourceConversationId, input.request), facts: [] };
    }),
    bindProductApiOperation(CONVERSATION_COMMUNICATION_SEND, async input => {
      assertId(input.sourceConversationId);
      validateConversationCommunicationRequest(input.request);
      if (input.request.action !== "send") throw new TypeError("发送命令需要消息");
      return { result: await invoke(input.sourceConversationId, input.request), facts: [] };
    }),
  ], factEvents: [] });
}

/** 来源由装配时的真实调用上下文绑定，发送参数只包含目标、内容和操作 ID。 */
export class ConversationCommunicationApplicationService {
  readonly #source: MessageInputIdentity["source"];
  constructor(private readonly ports: {
    readonly directory: ConversationDirectoryApplication;
    readonly messages: ConversationMessageProjectionPort;
    readonly caller: Extract<ConversationCommandCaller, { kind: "surface" }>;
    readonly source: MessageInputIdentity["source"];
    readonly execution: (request: ConversationMessageExecutionRequest) => ConversationAgentTurnExecutionPort;
  }) {
    if (ports.source.kind === "conversation") assertId(ports.source.conversationId);
    this.#source = Object.freeze(structuredClone(ports.source));
  }

  async discover() {
    const view = await this.ports.directory.queryList();
    return { ...view, conversations: await Promise.all(view.conversations.map(async (entry) => {
      const history = await this.ports.directory.queryHistory({ kind: "history", conversationId: entry.conversationId, limit: 1 });
      const messages = history.runs.at(-1)?.record.messages ?? [];
      const text = [...messages].reverse().flatMap((message) => message.content
        .filter((block) => block.type === "text").map((block) => block.text)).find((value) => value.trim());
      return { ...entry, summary: text?.slice(0, 240) ?? "", summaryTruncated: (text?.length ?? 0) > 240 };
    })) };
  }

  async read(input: { readonly conversationId: string; readonly limit?: number; readonly before?: ConversationHistoryCursor }) {
    await this.#assertExists(input.conversationId);
    const page = await this.ports.directory.queryHistory({ kind: "history", ...input });
    const oldest = page.runs.at(-1);
    const outsideHistory = input.before ? { inputs: [], truncated: false } : await this.ports.messages.inputsOutsideHistory(input.conversationId);
    return { ...page, inputsOutsideHistory: outsideHistory.inputs, inputsOutsideHistoryTruncated: outsideHistory.truncated,
      ...(page.hasMore && oldest ? { next: { shardId: oldest.shardId, runIndex: oldest.record.runIndex } } : {}) };
  }

  async send(input: { readonly conversationId: string; readonly operationId: string; readonly input: UserTurnInputLike }) {
    assertId(input.operationId);
    const content = structuredClone(normalizeUserTurnInput(input.input));
    if (!isNonEmptyUserTurnInput(content)) throw new ConversationApplicationError("invalid-input", "Conversation message requires non-empty input");
    await this.#assertExists(input.conversationId);
    const messageId = `message-${protocolDigest("ConversationMessage", 1, { source: this.#source, principal: this.ports.caller.surfacePrincipal, target: input.conversationId, operationId: input.operationId })}`;
    const identity: MessageInputIdentity = { id: messageId, source: this.#source };
    const turnOrigin: TurnOrigin = { channel: "rpc", messageIdentity: identity };
    const turnIdentity = this.ports.directory.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity", turnId: messageId, identitySource: "provided", caller: this.ports.caller,
    });
    const admitted = await this.ports.directory.admitAgentTurn({
      kind: "admit-agent-turn", conversationId: input.conversationId, input: content,
      observe: false,
      turnIdentity, turnOrigin, caller: this.ports.caller,
      execution: this.ports.execution({ input: content, turnId: messageId, turnOrigin, caller: this.ports.caller }),
    });
    if (!admitted.runId) throw new Error("Conversation communication requires durable admission");
    return { conversationId: admitted.conversationId, messageId, runId: admitted.runId, accepted: true as const };
  }

  async observe(input: { readonly conversationId: string; readonly messageId: string }) {
    assertId(input.messageId);
    await this.#assertExists(input.conversationId);
    return this.ports.messages.inspect(input.conversationId, input.messageId);
  }

  async #assertExists(conversationId: string) {
    assertId(conversationId);
    const result = await this.ports.directory.queryIdentityExists({ kind: "identity-exists", conversationId });
    if (!result.exists) throw new ConversationApplicationError("not-found", `Conversation not found: ${conversationId}`);
  }
}

function assertId(id: string): void {
  if (!isProtocolIdentifier(id)) throw new ConversationApplicationError("invalid-input", "Invalid conversation communication identity");
}
