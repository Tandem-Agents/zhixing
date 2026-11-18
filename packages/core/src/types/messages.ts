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

/**
 * 文本块来自本地文件材料时的有界结构化描述：只供历史与观察表面渲染紧凑材料标记，
 * 不进入模型提示或 Provider 出站请求；旧记录缺省时按原文本诚实展示，不从 text 原文反推。
 */
export interface TextFileMaterial {
  readonly kind: "file";
  readonly name: string;
  readonly byteSize: number;
}

const MAX_TEXT_FILE_MATERIAL_NAME_UNITS = 256;
const INVALID_MATERIAL_NAME_RE =
  /[\p{Cc}\u2028\u2029\[\]]|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/u;
const LONE_SURROGATE_RE =
  /(?<![\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/gu;
const MATERIAL_NAME_STRIP_RE = /[\p{Cc}\u2028\u2029\[\]]+/gu;

/** 持久文本材料元数据的严格形状校验：只接受封闭字段与单行有界名称。 */
export function isTextFileMaterial(value: unknown): value is TextFileMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "byteSize,kind,name" &&
    record.kind === "file" &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    record.name.length <= MAX_TEXT_FILE_MATERIAL_NAME_UNITS &&
    !INVALID_MATERIAL_NAME_RE.test(record.name) &&
    typeof record.byteSize === "number" &&
    Number.isSafeInteger(record.byteSize) &&
    record.byteSize >= 0
  );
}

/** 同源构造有界文件材料描述：清洗控制字符、方括号与孤立代理项，截断时不切半个代理对。 */
export function createTextFileMaterial(
  rawName: string,
  byteSize: number,
): TextFileMaterial {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new TypeError("Text file material byteSize must be a non-negative safe integer");
  }
  const cleaned =
    rawName
      .replace(LONE_SURROGATE_RE, "\ufffd")
      .replace(MATERIAL_NAME_STRIP_RE, " ")
      .trim() || "unnamed";
  let name = cleaned;
  if (name.length > MAX_TEXT_FILE_MATERIAL_NAME_UNITS) {
    let end = MAX_TEXT_FILE_MATERIAL_NAME_UNITS;
    const last = name.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    name = name.slice(0, end).trimEnd() || "unnamed";
  }
  return { kind: "file", name, byteSize };
}

export interface TextBlock {
  type: "text";
  text: string;
  material?: TextFileMaterial;
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
  /**
   * 执行处置事实：只记录调用没有按常规执行的类型化原因，供恢复历史如实显示；不进模型、不进 provider 出站。
   * 缺省即常规执行（含旧记录），不从 content 原文推断。
   */
  disposition?: ToolResultDisposition;
}

/** 封闭联合：目前只有“同批选了独占控制调用，本调用未启动”。 */
export type ToolResultDisposition = {
  kind: "not-started";
  reason: "exclusive-control";
  /** 本批被选中执行的控制调用的工具名 */
  selectedTool: string;
};

/** 持久处置事实的严格形状校验：只接受封闭联合里的确切字段。 */
export function isToolResultDisposition(value: unknown): value is ToolResultDisposition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "kind,reason,selectedTool" &&
    record.kind === "not-started" && record.reason === "exclusive-control" &&
    typeof record.selectedTool === "string" && record.selectedTool.length > 0 && record.selectedTool.length <= 256;
}

/** 从调用结果的展示件导出要持久的处置事实；展示件本身不持久。 */
export function toolResultDisposition(
  presentation: { readonly kind: string; readonly reason?: unknown; readonly selectedTool?: unknown } | undefined,
): ToolResultDisposition | undefined {
  return presentation?.kind === "not-started" && presentation.reason === "exclusive-control" &&
    typeof presentation.selectedTool === "string"
    ? { kind: "not-started", reason: "exclusive-control", selectedTool: presentation.selectedTool }
    : undefined;
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
  /** 应用层的输入身份；不作为提示正文发送给模型。 */
  inputIdentity?: MessageInputIdentity;
  /**
   * 注意力窗口首部条目（启动装填、摘要或截断说明）的结构标记；不作为提示正文发送给模型。
   * 只由窗口为运行输入读取时写入，普通配对一律不带；运行体只在输入起始两条读取它，
   * 用来区分首部与已接受的配对，正文写什么都不影响判定。
   */
  windowHead?: WindowHeadKind;
}

/**
 * 首部承载的内容类别：context = 启动装填或真实摘要（移除即丢失更早的上下文内容）；
 * note = 截断说明（只说明此前已省略，本身不承载对话内容）。
 */
export type WindowHeadKind = "context" | "note";

export interface MessageInputIdentity {
  readonly id: string;
  readonly source:
    | { readonly kind: "user" }
    | { readonly kind: "conversation"; readonly conversationId: string };
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

/**
 * 面向模型/Provider 出站转换合并含文件材料的连续文本段：
 * 仅当一段连续的 TextBlock 中至少有一块携带 `material` 时，按原顺序无分隔拼接为一个纯 `TextBlock`（剥离 `material`），
 * 使独立成块的文件材料与相邻散文保持改前完全一致的出站文本与块结构，同时不改变不含 `material` 的普通多 TextBlock 语义。
 */
export function coalesceUserMaterialTextBlocks<T extends ContentBlock>(
  blocks: readonly T[],
): T[] {
  if (!blocks.some((block) => block.type === "text" && block.material !== undefined)) {
    return [...blocks];
  }
  const result: T[] = [];
  for (let i = 0; i < blocks.length; ) {
    const current = blocks[i]!;
    if (current.type !== "text") {
      result.push(current);
      i += 1;
      continue;
    }
    let end = i + 1;
    let hasMaterial = current.material !== undefined;
    while (end < blocks.length && blocks[end]!.type === "text") {
      if ((blocks[end] as TextBlock).material !== undefined) hasMaterial = true;
      end += 1;
    }
    if (!hasMaterial) {
      for (let k = i; k < end; k++) result.push(blocks[k]!);
    } else {
      let merged = "";
      for (let k = i; k < end; k++) merged += (blocks[k] as TextBlock).text;
      result.push({ type: "text", text: merged } as T);
    }
    i = end;
  }
  return result;
}

/** 提取消息中第一个 TextBlock 的文本（找不到返回空串） */
export function extractFirstText(message: Message): string {
  const textBlock = message.content.find(
    (block): block is TextBlock => block.type === "text",
  );
  return textBlock?.text ?? "";
}

/**
 * 替换消息中第一个 TextBlock 的文本，返回新消息（不改原对象）。
 * 消息没有 TextBlock 时，在 content 最前插入一个。
 */
export function replaceFirstText(message: Message, newText: string): Message {
  const hasText = message.content.some((block) => block.type === "text");

  if (!hasText) {
    return {
      ...message,
      content: [{ type: "text" as const, text: newText }, ...message.content],
    };
  }

  let replaced = false;
  const newContent = message.content.map((block) => {
    if (block.type === "text" && !replaced) {
      replaced = true;
      return { ...block, text: newText };
    }
    return block;
  });

  return { ...message, content: newContent };
}

/** 返回最后一条 user 消息的下标；没有则返回 -1 */
export function findLastUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

/**
 * 从消息序列尾部倒序找最后一条 assistant 消息；没有则返回 undefined。
 *
 * 典型用途：从一个 run 的协议消息序列（[user, assistant(tool_use),
 * tool_result_user, ..., assistant(总结)]）派生"最终回复"——工具链场景下
 * 中间有多条 assistant，最后一条才是面向用户的总结。
 */
export function findLastAssistantMessage(
  messages: readonly Message[],
): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") return messages[i];
  }
  return undefined;
}

/**
 * 空 assistant 兜底消息 —— run 在首次 LLM 完成前被中断 / 出错、序列里没有
 * 任何 assistant 时，用它补齐"用户-助手"配对。content=[] 是合法 Message：
 * 渲染时跳过、token 估算为 0；让消费方（持久化记录、窗口配对）的代码路径
 * 均一，无需对"无回复的 run"特判。
 *
 * 每次调用返回新对象——消息在系统内按不可变约定流转，共享单例会让任何
 * 一处意外变更扩散到所有持有者，工厂形态从根上消除该风险。
 */
export function emptyAssistantMessage(): Message {
  return { role: "assistant", content: [] };
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
