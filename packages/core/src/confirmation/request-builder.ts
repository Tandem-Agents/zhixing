/**
 * ConfirmationRequest 构造器
 *
 * 把 SecurityPipeline 的评估结果 + 工具元信息组装成一个 ConfirmationRequest,
 * 供 ConfirmationBroker 分发给渲染器。
 *
 * 职责:
 *   1. 生成稳定的 request id(UUID)
 *   2. 把 tool.name + input 翻译成 DisplayBody(判别式联合)
 *   3. 从 suggestPatterns 推导 ConfirmationOption 列表
 *   4. 填充过期时间、元数据、session/workspace 上下文
 *
 * 关键设计:
 *   - `commandPreview` 独立于原始 `command`:所有渲染器只读 preview,
 *     preview 已经剥掉 ANSI 控制字符,防显示欺骗(学 OpenClaw)
 *   - 选项是按 "从精确到宽泛" 的 SuggestedPattern 多级生成 —— 用户可以选不同
 *     的泛化级别
 *   - placeholder 使用 `getAgentIdentity().displayName` —— 默认 "知行",可配
 */

import { generateRequestId } from "./broker.js";
import type {
  ConfirmationOption,
  ConfirmationRequest,
  DisplayBody,
} from "./types.js";
import { getAgentIdentity } from "../identity/index.js";
import { suggestPatterns } from "../security/confirmation-tracker.js";
import type { SuggestedPattern } from "../security/confirmation-tracker.js";
import type {
  OperationClass,
  PermissionContextId,
  SecurityDecision,
  SecurityMiddlewareResult,
  SecurityRequest,
  SessionType,
} from "../security/types.js";
import type { TurnOrigin } from "../types/tools.js";

// ─── 默认超时 ───

/**
 * 确认请求默认 30 分钟超时。
 * 与 OpenClaw 的 DEFAULT_EXEC_APPROVAL_TIMEOUT_MS 对齐,
 * 给用户足够的时间切到其它终端处理事情再回来。
 */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

// ─── ANSI 剥离(独立于 tui 层,避免跨目录依赖) ───

const ANSI_CSI_RE = /\x1b\[[0-9;?=<>]*[A-Za-z]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * 把命令文本 sanitize 为"显示安全"版本:
 *   - 剥 ANSI CSI 转义序列(防显示欺骗)
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
 * 为"持久授权"挑选最合适的 pattern。
 *
 * 设计原则：永远不把"完整原始命令"作为永久授权的 pattern —— 那种 pattern 下次
 * 几乎一定不会再命中（参数会变），对用户毫无价值，只是把 confirmation 面板的
 * 视觉负担留在那里。
 *
 * 优先级（从最理想到最兜底）：
 *   1. **subcommand wildcard**：形如 `npm install *` / `git push *`。
 *      最常用的"持久允许"粒度 —— 把同类操作一并放行，但仍把 `npm uninstall` /
 *      `git push --force` 等危险变体留在 confirmation 之外。
 *   2. **executable wildcard**：形如 `echo *` / `ls *`。用于不存在子命令结构的
 *      命令（典型：`echo "..."` 这类带引号 / 复合表达式的命令），suggestPatterns
 *      不会生成 "echo something *" 那种二级模式。
 *   3. **最广义的兜底**：`patterns[length-1]`。覆盖 `write` 工具的 `dir/**` 等
 *      非命令行类 pattern，以及任何意外的边缘情况。
 *
 * 注意：对**危险命令**（`rm -rf /` 这类）走到这里本身就已经是异常情况 ——
 * SecurityPipeline 的 builtin-rules 应该在前置 classify/authorize 阶段把它们
 * 直接 BLOCK 掉，根本不该到 confirmation 面板。所以这里"取最广义"不会给危险
 * 命令开后门。
 *
 * allow-context 与 allow-global 共用同一 pattern 选择逻辑 —— 两者粒度都是
 * "持久授权"，只是作用域不同（本上下文 vs 跨所有上下文）。
 */
function pickPersistentPattern(
  patterns: SuggestedPattern[],
): SuggestedPattern | undefined {
  if (patterns.length === 0) return undefined;

  const subcommandWildcard = patterns.find((p) =>
    /^\S+\s+\S+\s+\*$/.test(p.pattern.argument),
  );
  if (subcommandWildcard) return subcommandWildcard;

  const executableWildcard = patterns.find((p) =>
    /^\S+\s+\*$/.test(p.pattern.argument),
  );
  if (executableWildcard) return executableWildcard;

  return patterns[patterns.length - 1];
}

/**
 * 生成用户可选的 ConfirmationOption 列表 —— 上下文平等三选 + 拒绝。
 *
 * **正常路径生成 4 个选项**：
 *   1. 允许这一次（allow-once）—— 默认焦点
 *   2. 始终允许（仅本上下文生效）（allow-context）—— 按 contextId 动态 label
 *   3. 始终允许（全局，所有场景生效）（allow-global）
 *   4. 拒绝并说明原因（deny-with-reason）—— 拒绝理由回流模型
 *
 * **bypassImmune 守卫（禁区操作）**：bypassImmune 命中的操作（凭证 / .git /
 * .ssh / .zhixing 等禁区）**只给 allow-once + deny-with-reason** —— 禁区永不
 * 沉淀、跨所有上下文都不能放宽。这从 UI 层断绝"用户多次 allow-context 把禁区
 * 操作攒成永久规则"的可能性。
 *
 * **allow-session 不生成**（产品决策）：个人助手用户感知不到"会话"概念，
 * 且实现是 in-memory，与对话 session 不挂钩。类型定义保留（type 系统支持），
 * 由 broker / renderer / secure-executor 兼容处理。
 *
 * **主模式 vs 工作场景的差异仅在 allow-context label 动态文案**——按 contextId.kind
 * switch exhaustive（不靠 substring 反推 kind，未来加新 kind 时 TypeScript 强制
 * 把这里 highlight 出来）：
 *   - `{kind:"main"}` → 「仅主模式生效」
 *   - `{kind:"workspace"|"scene"}` → 「本工作场景生效」
 */
export function buildConfirmationOptions(
  toolName: string,
  input: Record<string, unknown>,
  contextId: PermissionContextId,
  sessionType: SessionType,
  flags?: { bypassImmune?: boolean },
): ConfirmationOption[] {
  const { displayName } = getAgentIdentity();

  const patterns = suggestPatterns({
    tool: toolName,
    arguments: input,
    context: { cwd: "", trust: { kind: "global" }, sessionType },
  });

  const persistentPattern = pickPersistentPattern(patterns);

  const options: ConfirmationOption[] = [];

  // 1. 允许这一次（默认焦点）
  options.push({ kind: "allow-once", label: "允许这一次", hotkey: "y" });

  // 2-3. 持久授权选项（bypassImmune 时跳过 —— 禁区永不沉淀）
  if (persistentPattern && !flags?.bypassImmune) {
    const arg = persistentPattern.pattern.argument;
    const contextScopeLabel = formatContextScopeLabel(contextId);
    options.push({
      kind: "allow-context",
      label: `始终允许 "${arg}"（${contextScopeLabel}）`,
      pattern: persistentPattern,
      hotkey: "a",
    });
    options.push({
      kind: "allow-global",
      label: `始终允许 "${arg}"（全局，所有场景生效）`,
      pattern: persistentPattern,
      hotkey: "g",
    });
  }

  // 4. 拒绝并说明原因，reason 回流到模型
  options.push({
    kind: "deny-with-reason",
    label: "拒绝并说明原因...",
    placeholder: `告诉${displayName}哪里错了`,
    hotkey: "n",
  });

  return options;
}

/**
 * allow-context label 的"作用范围"文案 —— 按 contextId.kind exhaustive 分支。
 * 主模式标为「仅主模式生效」；workspace / scene 都属于"工作场景"，对用户呈现
 * 统一术语。未来若要 UX 上区分 workspace 与 scene，仅需在此处分两支。
 */
function formatContextScopeLabel(contextId: PermissionContextId): string {
  switch (contextId.kind) {
    case "main":
      return "仅主模式生效";
    case "workspace":
    case "scene":
      return "本工作场景生效";
  }
}

// ─── 主构造器 ───

export interface BuildConfirmationRequestParams {
  toolName: string;
  input: Record<string, unknown>;
  workingDirectory: string;
  result: SecurityMiddlewareResult;
  /** 当前上下文 ID（PermissionContextId discriminated union） */
  contextId: PermissionContextId;
  sessionType: SessionType;
  /** 可选覆盖 id（测试用） */
  id?: string;
  /** 当前时间戳 —— 便于 fake clock 测试 */
  now?: number;
  /** 超时毫秒数，默认 30min */
  timeoutMs?: number;
  /**
   * Turn 发起入口的元信息 —— 远程确认的回程地址。
   * 由 secure-executor 从 ToolExecutionContext.turnOrigin 透传；
   * Renderer / Hub / Bridge 读此字段决定把确认请求推回哪个通道 / RPC 连接。
   */
  turnOrigin?: TurnOrigin;
  /** AI 安全助理的研判理由 —— needs-confirm 经管家时透传，渲染给用户说明为何要确认 */
  stewardReason?: string;
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
    contextId,
    sessionType,
  } = params;

  const now = params.now ?? Date.now();
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const id = params.id ?? generateRequestId();

  const body = buildDisplayBody(toolName, input);
  const title = buildPanelTitle(toolName);

  const hasBypassImmune = result.decision?.matchedRules.some(
    (r) => r.bypassImmune,
  ) ?? false;

  const options = buildConfirmationOptions(
    toolName,
    input,
    contextId,
    sessionType,
    { bypassImmune: hasBypassImmune },
  );

  return {
    id,
    tool: toolName,
    toolInput: input,
    workingDirectory,
    decision: result.decision,
    operationClass: result.operationClass,
    matchedPermissionRule: result.matchedPermissionRule,
    display: {
      title,
      body,
      commandPreview:
        body.kind === "bash" ? body.commandPreview : undefined,
      commandFull: body.kind === "bash" ? body.command : undefined,
      resolvedPaths: result.resolvedPaths,
      cwd: workingDirectory,
      stewardReason: params.stewardReason,
    },
    options,
    sessionType,
    contextId,
    createdAt: now,
    expiresAt: now + timeoutMs,
    turnOrigin: params.turnOrigin,
  };
}

// ─── 重导出便于复用 ───

export type {
  ConfirmationRequest,
  SecurityDecision,
  SecurityMiddlewareResult,
  SecurityRequest,
  SessionType,
  OperationClass,
  SuggestedPattern,
};
