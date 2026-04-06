/**
 * 工具系统类型定义
 *
 * 设计原则：
 * - 自描述：每个工具声明自己的能力和安全约束
 * - Fail-closed 默认值：未声明的属性取保守值（有副作用、不可并行、需要权限）
 * - JSON Schema 作为参数描述格式：这是 LLM API 的通用标准
 *
 * 对比 Claude Code：它用 buildTool() 工厂 + 多个布尔属性。
 * 我们的设计类似但更显式 — 安全属性直接在接口上，不需要工厂函数。
 */

// ─── JSON Schema ───

/**
 * JSON Schema 属性描述。
 * 这是发送给 LLM 的格式，LLM 根据此 schema 构造工具调用参数。
 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  [key: string]: unknown;
}

/**
 * 工具输入参数的 JSON Schema（顶层必须是 object）。
 */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

// ─── 工具执行 ───

/**
 * 工具执行上下文 — 传递给工具 call 函数的运行时信息。
 * 随着系统演进会逐步扩展（如权限信息、会话 ID 等）。
 */
export interface ToolExecutionContext {
  /** 当前工作目录 */
  workingDirectory: string;
  /** 中止信号，用于取消长时间运行的工具 */
  abortSignal?: AbortSignal;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

// ─── 工具定义 ───

/**
 * 工具定义 — 工具向系统声明自己的全部信息。
 *
 * 安全属性采用 fail-closed 设计（借鉴 Claude Code）：
 * - isReadOnly 默认 false → 假设有副作用
 * - isParallelSafe 默认 false → 假设不能并发
 * - needsPermission 默认 true → 假设需要用户确认
 *
 * 这意味着新工具如果忘了声明这些属性，系统会采取最保守的策略，
 * 而不是意外地允许危险操作。
 */
export interface ToolDefinition {
  /** 工具名称，全局唯一标识符 */
  name: string;
  /** 工具描述，发送给 LLM 指导工具选择 */
  description: string;
  /** 输入参数的 JSON Schema */
  inputSchema: JsonSchema;

  /** 此工具是否只读（不修改文件系统或外部状态）。默认 false */
  isReadOnly?: boolean;
  /** 此工具是否可以与其他工具并行执行。默认 false */
  isParallelSafe?: boolean;
  /** 此工具是否需要用户权限确认。默认 true */
  needsPermission?: boolean;
  /** 结果的最大字符数，超出时自动截断。不设置则不限制 */
  maxResultChars?: number;

  /**
   * 执行工具
   * @param input - 经过 schema 验证的输入参数
   * @param context - 运行时上下文（工作目录、中止信号等）
   */
  call(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

/**
 * 发送给 LLM 的工具声明（不包含实现细节）。
 * Provider 层使用此类型构造 API 请求。
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** 从 ToolDefinition 提取 ToolSpec（去掉实现细节，只留 LLM 需要的信息） */
export function toToolSpec(tool: ToolDefinition): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
