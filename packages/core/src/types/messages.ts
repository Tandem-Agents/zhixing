/**
 * 对话消息类型系统
 *
 * 设计原则：
 * - Provider 无关：内部表示不绑定任何 LLM 厂商格式，Provider 层负责互转
 * - 判别联合：ContentBlock 通过 type 字段区分，支持穷尽模式匹配
 * - 遵循 Anthropic Messages API 的消息模型（role + content blocks），
 *   因为它比 OpenAI 的扁平模型更具表达力，且 OpenAI 格式可无损转换到此格式
 */

// ─── 角色 ───

/**
 * 对话角色。
 * 不包含 'system' — 系统提示通过 ChatRequest.systemPrompt 独立传递，
 * 这是有意为之：系统提示的组装和消息历史是不同的关注点。
 */
export type Role = "user" | "assistant";

// ─── 内容块 ───

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export type ImageSource =
  | { type: "base64"; mediaType: string; data: string }
  | { type: "url"; url: string };

/**
 * 工具调用块 — LLM 请求执行某个工具。
 * 出现在 assistant 消息中。
 */
export interface ToolUseBlock {
  type: "tool_use";
  /** 唯一标识符，用于与后续 ToolResultBlock 配对 */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * 工具结果块 — 工具执行的返回值。
 * 出现在 user 消息中，紧跟包含 tool_use 的 assistant 消息之后。
 */
export interface ToolResultBlock {
  type: "tool_result";
  /** 对应的 ToolUseBlock.id */
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * 思考块 — LLM 的推理过程（如 Claude extended thinking）。
 * 出现在 assistant 消息中。
 *
 * signature：Anthropic extended thinking 的加密签名。Anthropic 协议要求
 * 多轮对话中把思考块**原样**回传（含 signature），服务端解密校验，缺失或被
 * 改写会 400。仅 Anthropic 原生思考块携带；OpenAI 兼容族（DeepSeek 等）的
 * reasoning trace 无此维度，字段留空。出站时有 signature → 原样回传，无 →
 * 降级为文本（跨 provider 续聊兜底，不破坏协议）。
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/**
 * 内容块联合类型。
 * 每种块通过 type 字段区分，TypeScript 会自动做类型收窄。
 */
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

// ─── 消息 ───

export interface Message {
  role: Role;
  content: ContentBlock[];
}

// ─── 消息构建辅助函数 ───

/** 创建包含单个文本块的 user 消息 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

/** 创建包含单个文本块的 assistant 消息 */
export function assistantMessage(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** 创建包含工具结果的 user 消息 */
export function toolResultMessage(results: ToolResultBlock[]): Message {
  return { role: "user", content: results };
}

/** 从消息的所有 TextBlock 中提取并拼接文本 */
export function extractText(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** 从 assistant 消息中提取所有工具调用 */
export function extractToolCalls(message: Message): ToolUseBlock[] {
  return message.content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  );
}

/** 判断消息是否包含工具调用 */
export function hasToolCalls(message: Message): boolean {
  return message.content.some((block) => block.type === "tool_use");
}
