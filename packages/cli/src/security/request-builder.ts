/**
 * ConfirmationRequest 构造器
 *
 * 把 SecurityPipeline 的评估结果 + 工具元信息组装成一个 ConfirmationRequest，
 * 供 ConfirmationBroker 分发给渲染器。
 *
 * 职责：
 *   1. 生成稳定的 request id（UUID）
 *   2. 把 tool.name + input 翻译成 DisplayBody（判别式联合）
 *   3. 从 suggestPatterns 推导 ConfirmationOption 列表
 *   4. 填充过期时间、元数据、session/workspace 上下文
 *
 * 关键设计:
 *   - `commandPreview` 独立于原始 `command`：所有渲染器只读 preview，
 *     preview 已经剥掉 ANSI 控制字符，防显示欺骗（学 OpenClaw）
 *   - 选项是按 "从精确到宽泛" 的 SuggestedPattern 多级生成——用户可以选不同
 *     的泛化级别
 *   - placeholder 使用 `getAgentIdentity().displayName`——默认 "知行"，可配
 */

import {
  generateRequestId,
  getAgentIdentity,
  suggestPatterns,
  type ConfirmationOption,
  type ConfirmationRequest,
  type DisplayBody,
  type OperationClass,
  type SecurityDecision,
  type SecurityMiddlewareResult,
  type SecurityRequest,
  type SessionType,
  type SuggestedPattern,
} from "@zhixing/core";

// ─── 默认超时 ───

/**
 * 确认请求默认 30 分钟超时。
 * 与 OpenClaw 的 DEFAULT_EXEC_APPROVAL_TIMEOUT_MS 对齐，
 * 给用户足够的时间切到其它终端处理事情再回来。
 */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

// ─── ANSI 剥离（独立于 tui 层，避免跨目录依赖） ───

const ANSI_CSI_RE = /\x1b\[[0-9;?=<>]*[A-Za-z]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * 把命令文本 sanitize 为"显示安全"版本：
 *   - 剥 ANSI CSI 转义序列（防显示欺骗）
 *   - 剥除非换行/空格的控制字符
 *   - 保留 TAB / LF 便于多行命令显示
 */
export function sanitizeCommandPreview(text: string): string {
  return text.replace(ANSI_CSI_RE, "").replace(CONTROL_CHARS_RE, "");
}

// ─── DisplayBody 构造 ───

/**
 * 根据工具名 + 输入参数构造 DisplayBody。
 * 不认识的工具走 generic 兜底。
 */
export function buildDisplayBody(
  toolName: string,
  input: Record<string, unknown>,
): DisplayBody {
  const name = toolName.toLowerCase();

  if (name === "bash" || name === "shell") {
    const command = asString(input["command"]);
    return {
      kind: "bash",
      command,
      commandPreview: sanitizeCommandPreview(command),
    };
  }

  if (name === "write") {
    const path = asString(input["path"] ?? input["file_path"] ?? input["target"]);
    const content = input["content"];
    const preview = typeof content === "string" ? content.slice(0, 200) : undefined;
    return { kind: "file-write", path, preview };
  }

  if (name === "edit" || name === "str_replace" || name === "str_replace_editor") {
    const path = asString(input["path"] ?? input["file_path"] ?? input["target"]);
    return { kind: "file-edit", path };
  }

  if (name === "read" || name === "view") {
    const path = asString(input["path"] ?? input["file_path"] ?? input["target"]);
    return { kind: "file-read", path };
  }

  // Fallback 通用格式
  const summary = `${toolName} ${summarizeArgs(input)}`;
  return { kind: "generic", summary };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function summarizeArgs(input: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(input);
    if (!json) return "";
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "[unserializable]";
  }
}

/**
 * 面板标题——按工具类型给出友好名。
 */
export function buildPanelTitle(toolName: string): string {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell") return "Bash 命令";
  if (name === "write") return "写入文件";
  if (name === "edit" || name === "str_replace") return "编辑文件";
  if (name === "read") return "读取文件";
  return toolName;
}

// ─── ConfirmationOption 构造 ───

/**
 * 从 SecurityRequest + 匹配规则结果生成用户可选的 ConfirmationOption 列表。
 *
 * 策略：
 *   - 先 allow-once 作为默认焦点（低摩擦）
 *   - allow-with-note 让用户 "批准并补充"（匹配 CC 的 `"Yes, and..."` 模式）
 *   - 基于 suggestPatterns 产生多级粒度的 always-allow 选项
 *   - 最后 deny-with-reason 让用户 "拒绝并说明"（核心差异化——回流到模型）
 *
 * 粒度选择:
 *   - allow-workspace 用"中等精度"模式（第二个候选）——最常用的默认
 *   - allow-global 用同一个"中等精度"模式
 *   - allow-session 用"最宽泛"模式（最后一个候选）——临时放行多个相关命令
 */
export function buildConfirmationOptions(
  toolName: string,
  input: Record<string, unknown>,
  workspaceId: string | null,
  sessionType: SessionType,
): ConfirmationOption[] {
  const { displayName } = getAgentIdentity();

  const patterns = suggestPatterns({
    tool: toolName,
    arguments: input,
    context: { cwd: "", workspace: null, sessionType },
  });

  // 中间精度：索引 1 或 0（不多于 3 时回退）
  const mid = patterns.length >= 3 ? patterns[1]! : patterns[0];
  // 最宽泛：最后一个
  const broad = patterns.length > 0 ? patterns[patterns.length - 1]! : undefined;

  const options: ConfirmationOption[] = [];

  // 1. 允许这一次（默认聚焦）
  options.push({ kind: "allow-once", label: "允许这一次", hotkey: "y" });

  // 2. 允许并补充——inline input
  options.push({
    kind: "allow-with-note",
    label: "允许并补充指示...",
    placeholder: `告诉${displayName}接下来该做什么`,
  });

  // 3. 始终允许（工作区）
  if (workspaceId && mid) {
    options.push({
      kind: "allow-workspace",
      label: `始终允许 "${mid.pattern.argument}"（本工作区）`,
      pattern: mid,
      hotkey: "a",
    });
  }

  // 4. 始终允许（全局）
  if (mid) {
    options.push({
      kind: "allow-global",
      label: `始终允许 "${mid.pattern.argument}"（全局）`,
      pattern: mid,
      hotkey: "g",
    });
  }

  // 5. 会话内允许（最宽泛）
  if (broad) {
    options.push({
      kind: "allow-session",
      label: `本次会话内允许 "${broad.pattern.argument}"`,
      pattern: broad,
      hotkey: "s",
    });
  }

  // 6. 拒绝并说明原因——核心差异化，note 回流到模型
  options.push({
    kind: "deny-with-reason",
    label: "拒绝并说明原因...",
    placeholder: `告诉${displayName}哪里错了`,
    hotkey: "n",
  });

  return options;
}

// ─── 主构造器 ───

export interface BuildConfirmationRequestParams {
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory: string;
  result: SecurityMiddlewareResult;
  workspaceId: string | null;
  sessionType: SessionType;
  /** 可选覆盖 id（测试用） */
  id?: string;
  /** 当前时间戳——便于 fake clock 测试 */
  now?: number;
  /** 超时毫秒数，默认 30min */
  timeoutMs?: number;
}

/**
 * 把 SecurityPipeline 的评估结果组装成一个 ConfirmationRequest。
 */
export function buildConfirmationRequest(
  params: BuildConfirmationRequestParams,
): ConfirmationRequest {
  const {
    toolName,
    input,
    workingDirectory,
    result,
    workspaceId,
    sessionType,
  } = params;

  const now = params.now ?? Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const id = params.id ?? generateRequestId();

  const body = buildDisplayBody(toolName, input);
  const title = buildPanelTitle(toolName);

  const options = buildConfirmationOptions(
    toolName,
    input,
    workspaceId,
    sessionType,
  );

  return {
    id,
    tool: toolName,
    toolInput: input,
    workingDirectory,
    decision: result.decision,
    operationClass: result.operationClass,
    matchedPermissionRule: result.matchedPermissionRule,
    suggestion: result.suggestion,
    display: {
      title,
      body,
      commandPreview:
        body.kind === "bash" ? body.commandPreview : undefined,
      commandFull: body.kind === "bash" ? body.command : undefined,
      resolvedPaths: result.resolvedPaths,
      cwd: workingDirectory,
    },
    options,
    sessionType,
    workspaceId,
    createdAt: now,
    expiresAt: now + timeoutMs,
  };
}

// ─── 未导出但便于复用 ───

export type {
  ConfirmationRequest,
  SecurityDecision,
  SecurityMiddlewareResult,
  SecurityRequest,
  SessionType,
  OperationClass,
  SuggestedPattern,
};
