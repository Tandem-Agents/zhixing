/**
 * Task 工具 —— 主 agent 显式委派子 agent 的"研究型"工具。
 *
 * 产品定位:
 *   - 主 LLM 调用 `Task({ description, prompt })`,得到一个 `tool_result`
 *     (子 agent 的 final assistant text + usage trailer)
 *   - 子 agent 中间步骤 / 工具调用 / 多轮 LLM 都发生在本工具 call() 内部,
 *     **不**写独立 Turn 记录入 transcript;父 turn 的 toolCalls 数组记录这次调用
 *
 * 架构契约:
 *   - 工具放 orchestrator(本包)而非 tools-builtin —— 依赖 runChildAgent,反向不行,
 *     依赖图严格 acyclic
 *   - 防递归"子 agent 不能再派子 agent" —— 由 sub-agent profile.enabledTools
 *     不含 "Task" 保证
 *   - `interruptBehavior: "cancel"` —— ctx.abortSignal 抛 AbortError,父 abort 自动级联
 *     给子(runChildAgent 内部 createInterruptController 派生 child controller)
 *   - `isParallelSafe: true` —— LLM I/O bound,主 agent 单 turn 可并发派多个 Task
 *
 * 双通道注入(env vs ALS):
 *   - env(closure)持装配期已知的服务:provider / pipeline / broker / parentTools 等
 *   - ALS(`runContextStorage`)持 per-run 上下文:eventBus / lineage —— 这俩是
 *     `runtime.run()` 入口才创建的,closure 在 createAgentRuntime 装配期 capture 不到
 *
 * 三态结果折叠:
 *   - `runChildAgent` 永不抛,返 ChildAgentResult { status: completed/failed/aborted }
 *   - `formatChildResultAsToolResult` 折成 ToolResult { content, isError } 给主 LLM
 *   - 三态结果都保留结构化 <usage> trailer，让主 LLM 和用量视图读取同一协议
 */

import {
  type BoundaryCrossing,
  type IConfirmationBroker,
  type JsonSchema,
  type LLMProvider,
  type LLMRoles,
  type ResolvedRoleThinking,
  type SubAgentResultPresentationArtifact,
  type SecurityPipeline,
  type ThinkingConfig,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import { runChildAgent, type ChildAgentResult } from "../subagent/factory.js";
import { formatAbortReasonForLLM } from "../subagent/abort-format.js";
import { runContextStorage, type RunContext } from "../runtime/run-context.js";

export const TASK_TOOL_CAPABILITY_DESCRIPTOR = {
  name: "Task",
  authorityWrite: true,
} as const;

// ─── env / 工具元信息 ───

/**
 * Task closure 持有的"父级共享服务"。
 *
 * 设计取舍:不持 `AgentRuntime` 整体引用 —— 在 `createAgentRuntime` 函数体内
 * `createTaskTool` 调用时,return 对象尚未构造;直接 capture 装配期局部变量
 * 避免 forward reference / 循环依赖,且更精确表达"Task 需要哪些服务"。
 *
 * 字段对齐 `RunChildAgentOptions` 的"shared" 子集(剔除 task / parentBus /
 * parentLineage / parentSignal —— 这些走 ALS / ctx),`call()` 内可
 * 直接 `runChildAgent({ ...env, parentBus, parentLineage, parentSignal, task })`。
 */
export interface TaskToolEnv {
  /** 父 LLMProvider 实例 —— 子复用,共享连接池 / 限速 / 缓存 */
  provider: LLMProvider;
  /** 父 model id —— 子复用父 primaryRole 模型,不支持单独 override */
  model: string;
  /**
   * 子 agent 自身 loop 的思考控制 —— 与 model 配对（= 父 primaryRole 的
   * 生效思考解析）。role-agnostic：子 loop 跑哪个 role 的 model 由装配期决定，
   * 这里只收解析后的值，loop-runner 不需知角色。
   */
  loopThinking?: ThinkingConfig;
  /**
   * 各角色生效思考控制（真实 per-role 映射）—— 子工具在 I/O 边界调
   * ctx.llm.<role> 时按所用角色取，不跟随 primaryRole。
   */
  roleThinking?: ResolvedRoleThinking;
  /** 父 LLMRoles —— 子工具调 light/power 角色时透传 */
  llmRoles: LLMRoles;
  /** 父 SecurityPipeline —— 权限规则 / boundary registry 跨 agent 共用 */
  securityPipeline: SecurityPipeline;
  /** 工作区路径(null 表示无工作区) */
  workspace: string | null;
  /** 工作区来源标识(runtime / global-config / cwd-fallback / none) */
  workspaceSource?: string;
  /** 全局配置文件路径(可选,用于 environment 段渲染) */
  globalConfigPath?: string;
  /**
   * 父 ConfirmationBroker —— 子 broker 透传 parentBroker.id 作审计血缘元信息;
   * 子 broker 不读父实际状态(无 listener 透传 / 无 pending 共享),仅引用其 id。
   */
  parentBroker: IConfirmationBroker;
  /** 父工具集 —— 子工具按 sub-agent profile.enabledTools 过滤后从此派生 */
  parentTools: readonly ToolDefinition[];
  /** 子 agent 实际可用工具名，用于生成 byte-stable 的 Task 描述。 */
  childToolNames: readonly string[];
  /**
   * 单次 input tokens 注意力风险阈值 —— 从 ModelCapability.riskMaxTokens 解析。
   *
   * sub-task prompt 累积超阈说明任务过大,继续执行会触发 attention 稀释致 LLM
   * 响应质量下降。loop-runner 在每次 llm:request_end 后检查 usage.inputTokens,
   * 超阈则 graceful 中止,主 LLM 收到 sub_agent_context_overflow 信号自主决策切片。
   */
  riskMaxTokens: number;
}

export const TASK_DESCRIPTION_MAX_CHARS = 160;
export const TASK_ERROR_REASON_MAX_CHARS = 2_000;
export const TASK_RESULT_TEXT_MAX_CHARS = 20_000;

/**
 * Task 工具的 input schema —— 严格两字段,LLM 学习成本最低。
 *
 * 不加 `subagent_type`:v1 单一子 role,无 researcher/critic 等具体角色,
 * 让 LLM 不必学习这字段;v2+ 引入 RoleTask 时再扩(`oneOf` 拆字段或 enum 加白名单)。
 *
 * 不加 `model` / `run_in_background` / `isolation` / `cwd`:
 *   - model:子复用父 model
 *   - run_in_background:走独立 background 工具(后续 step 引入)
 *   - isolation:不做 worktree / remote
 *   - cwd:子共享父工作目录
 */
export const TASK_INPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "A short (3-5 word) summary of the task, shown in status bar.",
      maxLength: TASK_DESCRIPTION_MAX_CHARS,
    },
    prompt: {
      type: "string",
      description:
        "Detailed task for the sub-agent. This is the only place the task is described — do not repeat it in any other field.",
    },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};

/**
 * Task 工具的 SecurityPipeline 边界声明 —— 让 BoundaryImpactClassifier
 * 把 Task 分类为 internal(进程内副作用)而非 critical(默认 fail-closed)。
 *
 * 语义解释:派 Task = 派生子 agent 在同进程内跑 LLM + 工具,本身不直接触发
 * 外部副作用(子 agent 内部具体工具的 boundary 由子工具自己声明并被
 * SecurityPipeline 独立评估)。
 *
 * 不声明的代价:工具未声明 boundaries 会被分类为 critical → 每次 Task 调用
 * 都触发 confirmation,UX 极差(还会被子 agent 的 fail-to-deny resolver 直接拒)。
 */
export const TASK_TOOL_BOUNDARIES: readonly BoundaryCrossing[] = [
  // dynamic: false —— Task 每次调用都派生子 agent,边界确定性触发,
  // 不需要运行时解析(对比 BashTool 的 filesystem.write 需要解析命令才知道)
  { boundaryType: "process", access: "exec", dynamic: false },
];

/**
 * Task 工具给 LLM 的描述文本。
 *
 * 写作哲学:
 *   - When to use / When NOT to use 对称给出,让 LLM 学习决策边界
 *   - 显式声明并发上限(3)与递归禁令(子不能再派子)
 *   - 失败处理强制约定 —— LLM 必须在 final response 中暴露 Task 失败,不可静默吞掉
 *   - 输出协议:tool_result.content 是 sub final text,主 agent 需自己综合形成对用户的回答
 */
const LOCAL_CHILD_TOOL_DISPLAY = {
  read: "Read",
  glob: "Glob",
  grep: "Grep",
} as const;

function localChildToolNames(childToolNames: readonly string[]): Array<keyof typeof LOCAL_CHILD_TOOL_DISPLAY> {
  return childToolNames.filter((name): name is keyof typeof LOCAL_CHILD_TOOL_DISPLAY =>
    Object.prototype.hasOwnProperty.call(LOCAL_CHILD_TOOL_DISPLAY, name),
  );
}

function formatToolList(names: readonly (keyof typeof LOCAL_CHILD_TOOL_DISPLAY)[]): string {
  return names.map((name) => LOCAL_CHILD_TOOL_DISPLAY[name]).join("/");
}

export function buildTaskToolPrompt(childToolNames: readonly string[]): string {
  const availableTools = childToolNames.length > 0
    ? childToolNames.join(", ")
    : "none";
  const localTools = localChildToolNames(childToolNames);
  const hasLocalTools = localTools.length > 0;
  const hasWebFetch = childToolNames.includes("web_fetch");
  const localLabel = hasLocalTools ? formatToolList(localTools) : "";
  const whenToUse = [
    hasLocalTools
      ? `- Researching project content across multiple ${localLabel} rounds — intermediate results stay in the sub-agent's context.`
      : null,
    hasWebFetch
      ? `- Fetching and reading a URL or known web page${hasLocalTools ? ", combined with local reading" : ""}.`
      : null,
    "- Comparing alternatives (A vs B vs C) — dispatch parallel Tasks, then synthesize.",
    "- Multi-perspective analysis (e.g. security / performance / readability review) — dispatch parallel Tasks with different prompts.",
  ].filter((line): line is string => line !== null);
  const whenNotToUse = [
    hasLocalTools
      ? `- Single-file ${localLabel} — use those tools directly. Task is overhead.`
      : null,
    "- Simple yes/no factual questions — answer directly.",
    "- When the user asked something that needs your direct response — sub-agent output is internal, you must still synthesize and respond.",
  ].filter((line): line is string => line !== null);

  return `Launch a sub-agent to perform a research-style sub-task with isolated context.

Available sub-agent tools: ${availableTools}.

When to use:
${whenToUse.join("\n")}

When NOT to use:
${whenNotToUse.join("\n")}

Concurrency: You may launch up to 3 Tasks in a single turn. They run in parallel.

Recursion: Sub-agents do not have access to the Task tool — they cannot dispatch further sub-agents.

Failure handling: If a Task fails, you will receive a tool_result with \`is_error: true\`. You MUST acknowledge the failure in your final response (e.g. "Task#X failed; the following is based on other sources") — do not pretend it succeeded or omit it silently.

Output format: The sub-agent's final response is returned as the tool_result content. Use it to inform your synthesis. The user does not see the sub-agent's intermediate steps.

Each Task is stateless — you cannot send follow-up messages to a running Task.`;
}

export const TASK_TOOL_PROMPT = buildTaskToolPrompt(["read", "glob", "grep", "web_fetch"]);

const TASK_MAX_CALLS_PER_TURN = 3;

// ─── 三态格式化(纯函数) ───

/**
 * 把 ChildAgentResult 折成给主 LLM 的 ToolResult。
 *
 * 三态映射:
 *   - completed: content = finalText + <usage> trailer; isError 省略(默认 false)
 *   - failed:    content = "[Task \"<desc>\" failed: <msg>]" + (partial?) + <usage>; isError = true
 *   - aborted:   content = "[Task \"<desc>\" aborted: <reason>]" + (partial?) + <usage>; isError = true
 *
 * 设计取舍:
 *   - <usage> trailer 用 XML-like 标签而非 JSON —— LLM 解析 inline 标签更稳,
 *     且对 token 预算更友好(JSON 引号 / braces 都是 token)
 *   - sub_id 截断到前 6 字符(完整 UUID 36 字符占用过多 token,前缀已足够审计追溯)
 *   - partial 仅在 failed/aborted 才拼接 —— completed 时 finalText 即完整答案,
 *     重复出现的"中段输出"反而污染上下文
 *   - failed/aborted 文本保持稳定英文前缀，便于主 LLM 理解失败边界
 */
export function formatChildResultAsToolResult(
  result: ChildAgentResult,
  description: string,
  toolCallId = "unknown",
): ToolResult {
  const usageTag = formatUsageTag(result);
  const boundedDescription = boundTaskDescription(description);
  const errorOrAbortReason = resultErrorOrAbortReason(result);
  const presentation = buildSubAgentPresentation(
    result,
    boundedDescription,
    toolCallId,
    errorOrAbortReason,
  );

  switch (result.status) {
    case "completed":
      return {
        content: `${truncateTaskText(result.finalAssistantText)}\n\n${usageTag}`,
        isError: false,
        presentation,
      };

    case "failed": {
      const errMsg = errorOrAbortReason ?? "unknown error";
      // type tag 让主 LLM 拿到结构化 error 分类(SubAgentErrorType),据此自主决策:
      //   provider_error / rate_limit → 重试 / 等待
      //   context_overflow / sub_agent_context_overflow → 切片子任务
      //   max_turns_exceeded → 调高 budget 或拆任务
      //   auth → 提示用户检查配置
      // 比文本前缀("failed:")更可解析,且避免主 LLM 对 message 做 substring 匹配。
      // 缺失场景理论不可达(deriveErrorMeta 总返 type),保留兜底兼容历史结果。
      const typeTag = result.error?.type ? ` (${result.error.type})` : "";
      const safeDescription = formatDescriptionForPrefix(boundedDescription);
      const partialBlock = result.partial
        ? `Partial output:\n${truncateTaskText(result.partial)}\n\n`
        : "";
      return {
        content: `[Task "${safeDescription}" failed${typeTag}: ${errMsg}]\n\n${partialBlock}${usageTag}`,
        isError: true,
        presentation,
      };
    }

    case "aborted": {
      const reasonStr = errorOrAbortReason ?? "unknown abort reason";
      const safeDescription = formatDescriptionForPrefix(boundedDescription);
      const partialBlock = result.partial
        ? `Partial output:\n${truncateTaskText(result.partial)}\n\n`
        : "";
      return {
        content: `[Task "${safeDescription}" aborted: ${reasonStr}]\n\n${partialBlock}${usageTag}`,
        isError: true,
        presentation,
      };
    }
  }
}

/**
 * 拼接 <usage> 标签 —— 把子 agent 的资源消耗以紧凑可解析格式暴露给主 LLM。
 *
 * 三态共用同一 helper 保证字段顺序 / 命名一致,主 LLM 学习成本一次性。
 * 三态都携带 tool_uses / duration_ms，失败和中止同样可审计成本。
 *
 * tokens 字段语义 —— 取 input + output 之和:
 *   - 这是"主 LLM 决策需要的总成本视角"的单值,避免主 LLM 在 tool_result 文本里
 *     自己做加法或被 4 个分项字段名混淆
 *   - 不含 cacheReadTokens / cacheWriteTokens 是有意为之:
 *       cacheRead 是父之前已花的钱(子复用),不算子本次额外消耗;
 *       cacheWrite 在 Anthropic 计费里独立维度(贵 1.25x),要细分需要独立列字段,
 *       但单 LLM 决策维度不该被这种细节噪声占用
 *   - 需要 cache 维度细分的场景(成本审计 / token budget 软上限)走 EventBus 的
 *     llm:end 事件原始 TokenUsage,由独立的 token 可观察性模块呈现,不通过工具
 *     描述层重复 —— 单一真相源原则
 */
function formatUsageTag(result: ChildAgentResult): string {
  const totalTokens = result.usage.inputTokens + result.usage.outputTokens;
  const status = result.status === "completed" ? "succeeded" : result.status;
  const fields: string[] = [`status: ${status}`, `tokens: ${totalTokens}`];
  fields.push(`tool_uses: ${result.toolUses}`);
  fields.push(`duration_ms: ${result.durationMs}`);
  fields.push(`sub_id: ${result.subAgentId.slice(0, 6)}`);
  return `<usage>${fields.join(", ")}</usage>`;
}

function buildSubAgentPresentation(
  result: ChildAgentResult,
  description: string,
  toolCallId: string,
  errorOrAbortReason: string | undefined,
): SubAgentResultPresentationArtifact {
  const status = result.status === "completed" ? "succeeded" : result.status;
  return {
    kind: "sub-agent-result",
    toolCallId,
    subAgentId: result.subAgentId,
    description,
    status,
    durationMs: result.durationMs,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    toolUses: result.toolUses,
    ...(errorOrAbortReason !== undefined && { errorOrAbortReason }),
  };
}

function truncateTaskText(text: string): string {
  return truncateBoundedText(
    text,
    TASK_RESULT_TEXT_MAX_CHARS,
    "\n\n[truncated]",
  );
}

function formatDescriptionForPrefix(description: string): string {
  return truncateBoundedText(
    description.replace(/"/g, "'"),
    TASK_DESCRIPTION_MAX_CHARS,
    "…",
  );
}

function resultErrorOrAbortReason(result: ChildAgentResult): string | undefined {
  if (result.status === "failed") {
    return truncateBoundedText(
      result.error?.message ?? "unknown error",
      TASK_ERROR_REASON_MAX_CHARS,
      "\n[truncated]",
    );
  }
  if (result.status === "aborted") {
    const reason = result.abortReason
      ? formatAbortReasonForLLM(result.abortReason)
      : "unknown abort reason";
    return truncateBoundedText(
      reason,
      TASK_ERROR_REASON_MAX_CHARS,
      "\n[truncated]",
    );
  }
  return undefined;
}

function boundTaskDescription(description: string): string {
  const normalized = description
    .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateBoundedText(
    normalized || "(unnamed)",
    TASK_DESCRIPTION_MAX_CHARS,
    "…",
  );
}

function truncateBoundedText(
  text: string,
  maxChars: number,
  truncationSuffix: string,
): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const suffix = Array.from(truncationSuffix);
  if (suffix.length >= maxChars) return suffix.slice(0, maxChars).join("");
  return `${chars.slice(0, maxChars - suffix.length).join("")}${truncationSuffix}`;
}

// ─── 前置契约校验 ───

/**
 * Task call() 入口的契约校验集中点 —— fail-fast 而非 fallback。
 *
 * 失败语义取舍:任一契约不满足 → throw,主 agent 看到 tool_result.isError 触发
 * LLM 自我修正(改输入重派 / 放弃);避免用残缺输入派一个"无任务"子 agent
 * 浪费 token + 产出无意义 tool_result。所有错误消息以 "Task tool" 前缀,
 * 让主 LLM 在 tool_result 文本中能直接定位错误源(对比泛型错误"Invalid input")。
 *
 * 校验项与实现解耦:
 *   - runCtx:ALS 包裹缺失 → runtime.run() 没正确建上下文(基础设施 bug,非用户错)
 *   - abortSignal:tool-executor 契约保证非空,但 Task 直接 testing path 可能漏
 *     传 —— 显式 throw 比 ! 非空断言更早暴露(类型层 optional 是 ToolExecutionContext
 *     的历史接口形状,不是 Task 工具的契约让步)
 *   - description / prompt:schema 已声明 required,但 client-side schema 校验
 *     依赖 LLM 提供商执行,部分 provider 不严格 —— 重复一道运行期校验是
 *     defense-in-depth,且 trim() 防纯空白输入
 *
 * 返回 ValidatedCall,后续 call body 直接解构使用,杜绝运行期再次 narrow / 断言。
 */
interface ValidatedCall {
  runCtx: RunContext;
  abortSignal: AbortSignal;
  description: string;
  prompt: string;
}

type ParseTaskInputResult =
  | { ok: true; description: string; prompt: string }
  | { ok: false; message: string };

function parseTaskInput(input: Record<string, unknown>): ParseTaskInputResult {
  const allowed = new Set(["description", "prompt"]);
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    return {
      ok: false,
      message: `Task tool input error: unsupported field(s): ${extra.join(", ")}`,
    };
  }

  if (typeof input.description !== "string") {
    return {
      ok: false,
      message: "Task tool input error: 'description' must be a string.",
    };
  }
  if (typeof input.prompt !== "string") {
    return {
      ok: false,
      message: "Task tool input error: 'prompt' must be a string.",
    };
  }

  const rawDescription = input.description.trim();
  if (!rawDescription) {
    return {
      ok: false,
      message: "Task tool input error: 'description' must be a non-empty string.",
    };
  }
  if (Array.from(rawDescription).length > TASK_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      message: `Task tool input error: 'description' must contain at most ${TASK_DESCRIPTION_MAX_CHARS} characters.`,
    };
  }
  const description = boundTaskDescription(rawDescription);
  const prompt = input.prompt.trim();
  if (!prompt) {
    return {
      ok: false,
      message: "Task tool input error: 'prompt' must be a non-empty string.",
    };
  }

  return { ok: true, description, prompt };
}

function assertRunContract(
  parsed: Extract<ParseTaskInputResult, { ok: true }>,
  ctx: ToolExecutionContext,
): ValidatedCall {
  const runCtx = runContextStorage.getStore();
  if (!runCtx) {
    throw new Error(
      "Task tool called outside an agent run context — must be invoked within `runContextStorage.run({ bus, lineage }, ...)` (set by runtime.run() entry).",
    );
  }
  if (!ctx.abortSignal) {
    throw new Error(
      "Task tool requires ctx.abortSignal — tool-executor must propagate the per-call AbortSignal so the sub-agent loop can be cancelled together with the parent run.",
    );
  }
  return {
    runCtx,
    abortSignal: ctx.abortSignal,
    description: parsed.description,
    prompt: parsed.prompt,
  };
}

// ─── 工具工厂 ───

/**
 * 创建 Task 工具实例 —— 由 `createAgentRuntime` 在装配主 runtime 时调用,
 * **不**通过 attachTool 后置注入(env 字段需在装配期完整可见,后置注入会破坏依赖完整性)。
 *
 * call() 调用流程:
 *   1. parseTaskInput 严格校验 LLM 入参，assertRunContract 校验运行上下文
 *   2. 调 runChildAgent —— 永不抛,返 ChildAgentResult 三态
 *   3. formatChildResultAsToolResult 折成 ToolResult 给主 LLM
 *
 * description 字段的处理:父侧用于状态栏、ToolResult 错误标签与摘要展示；子侧
 * 通过专用 task message 读取同一结构，不进入 system prompt。
 *
 * 可观察性:子 agent 的事件通过 createEventBus({ parent: parentBus, ... })
 * 自动冒泡到父 bus,父订阅方按 lineage 过滤可看到全部子事件。
 */
export function createTaskTool(env: TaskToolEnv): ToolDefinition {
  return {
    name: TASK_TOOL_CAPABILITY_DESCRIPTOR.name,
    description: buildTaskToolPrompt(env.childToolNames),
    inputSchema: TASK_INPUT_SCHEMA,
    isReadOnly: false,
    isParallelSafe: true,
    maxCallsPerTurn: TASK_MAX_CALLS_PER_TURN,
    needsPermission: false,
    interruptBehavior: "cancel",
    boundaries: [...TASK_TOOL_BOUNDARIES],
    call: async (input, ctx): Promise<ToolResult> => {
      const parsed = parseTaskInput(input);
      if (!parsed.ok) return { content: parsed.message, isError: true };

      const { runCtx, abortSignal } = assertRunContract(parsed, ctx);
      const { description, prompt } = parsed;

      const result = await runChildAgent({
        provider: env.provider,
        model: env.model,
        loopThinking: env.loopThinking,
        roleThinking: env.roleThinking,
        llmRoles: env.llmRoles,
        securityPipeline: env.securityPipeline,
        workspace: env.workspace,
        workspaceSource: env.workspaceSource,
        globalConfigPath: env.globalConfigPath,
        parentBus: runCtx.bus,
        parentLineage: runCtx.lineage,
        parentBroker: env.parentBroker,
        parentTools: env.parentTools,
        parentSignal: abortSignal,
        task: prompt,
        taskDescription: description,
        parentToolCallId: ctx.toolCallId,
        childOperationId: ctx.toolCallId,
        riskMaxTokens: env.riskMaxTokens,
        // 顶层用户意图沿子 agent 链路透传，让子 agent 工具调用时 AI 安全管家
        // 仍按顶层意图研判（子 agent 不能借助 task 文本伪装意图绕过管家）
        userIntent: ctx.userIntent,
        authorizeToolExecution: runCtx.authorizeToolExecution,
      });

      return formatChildResultAsToolResult(result, description, ctx.toolCallId);
    },
  };
}
