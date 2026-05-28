/**
 * Typeahead 输入补全 — 类型定义
 *
 * 设计原则（见 research/design/specifications/input-typeahead.md §5）：
 *   - Core 不认识 TTY / Ink / chalk / readline / prompt_toolkit
 *   - CommandDef 是命令的单一真相源，CLI / Web / gateway 各自 derive 视图
 *   - ArgSchema 是结构化的参数定义（判别式联合），不是 Hermes 的字符串 args_hint
 *   - Visibility 用 targets 数组 + predicate 回调，不是 Hermes 的多个 bool 字段
 *
 * 这一轮（Step 2）只定义类型 + 注册表 + usage tracker。Provider / Broker /
 * Renderer 在后续 Step 里陆续加入，都复用这里的基础类型。
 */

// ─── 运行时上下文 ───

/**
 * 运行时上下文 —— 传给 CommandDef.visibility.predicate 的环境信息。
 *
 * 我们有意让 RuntimeContext 的字段**最小且稳定**：只放每次 typeahead query
 * 都可能用到的、独立于具体 feature flag 和配置实现的信息。更多上下文应该
 * 通过 predicate 捕获闭包的方式传入，而不是膨胀这个接口。
 */
export interface RuntimeContext {
  /** 当前会话是否忙（agent 正在跑、工具正在执行） */
  readonly sessionBusy: boolean;

  /** 当前 workspace id —— 可能为 null（还未打开项目） */
  readonly workspaceId: string | null;

  /** 当前工作目录（绝对路径） */
  readonly cwd: string;

  /** 渲染目标 —— 未来可能是 "cli" / "gateway" / "web" / "wechat" / "dingtalk" */
  readonly target: RendererTarget;

  /**
   * 用户 feature flags。保持为 `Record<string, boolean>` 的开放形状，
   * 不 pin 到某个 feature flag 枚举 —— 不同 feature flag 实现可以 cast。
   */
  readonly features: Readonly<Record<string, boolean>>;

  /** 时钟：typeahead 内部用（例如 MRU 计分），测试可注入 */
  readonly now: number;
}

/**
 * 渲染目标枚举。
 * Phase 1 只实现 "cli"，其他值是未来扩展占位。
 */
export type RendererTarget = "cli" | "gateway" | "web" | "wechat" | "dingtalk";

// ─── 命令类别与可见性 ───

/**
 * 命令类别 —— 用于空 query 时的分组排序。
 * 顺序即默认显示顺序（见 spec §6.3）。
 */
export type CommandCategory =
  | "session" // /new /reset /history /save /resume
  | "config" // /model /elevated /verbose /fast
  | "info" // /status /help /profile
  | "tools" // /work /mcp
  | "debug" // /debug /logs
  | "plugin" // 动态注册的插件命令
  | "hidden"; // 不显示在分类头，但存在（escape hatch 见 spec §6.4.1）

/**
 * 命令的可见性规则 —— 控制"此命令何时出现在补全菜单里"。
 *
 * 设计 vs Hermes：Hermes 用 cli_only / gateway_only / gateway_config_gate
 * 三个 bool 字段表达可见性，加一种新环境（比如 Web）就要再加一个字段。
 * 知行用数组 targets + 运行时 predicate，扩展性更好。
 */
export interface CommandVisibility {
  /**
   * 可见于哪些渲染目标。
   * - 缺省：所有目标可见
   * - 空数组：所有目标都不可见（相当于 hidden，但保留能按名字召唤的能力）
   */
  readonly targets?: readonly RendererTarget[];

  /**
   * 运行时 predicate —— 返回 false 时补全不展示此命令。
   * 每次 query 都会调用，可用于"会话忙时禁用 /new"、"feature flag 关闭时隐藏"。
   *
   * 异常处理：predicate 抛异常时，broker 视为 false（保守地隐藏）并记日志。
   */
  readonly predicate?: (ctx: RuntimeContext) => boolean;
}

// ─── 命令执行归属 ───

/**
 * 命令执行归属（spec §9.2）。
 *
 * - `local`：纯本地动作，不产生 agent turn，不消耗 token（如 /exit /clear /help）
 * - `agent`：整条 draft 作为 user message 发送给 agent loop（如 /background /btw）
 * - `hybrid`：先本地副作用，再把结构化 system message 发给 agent（如 /new /model）
 *   agent 永远看到 "已发生" 的事实，不是 "即将发生" 的意图（spec §12.2 锁定决策 #4）
 */
export type CommandExecution = "local" | "agent" | "hybrid";

/**
 * 命令 handler 的执行结果 —— hybrid 命令用它来描述给 agent 的 system message。
 */
export interface CommandHandlerResult {
  /** hybrid 命令返回给 agent 的 system message（"用户刚刚做了 X"） */
  readonly systemMessage?: string;
  /** 供 telemetry / 日志的命令执行摘要 */
  readonly summary?: string;
}

/**
 * 命令 handler —— 纯数据接口。实际的 handler 实现在 CLI 层（REPL 整合时）。
 *
 * Phase 1 Step 2 的 builtin commands 不填 handler，留给 Step 5（REPL 接入）
 * 时再按命令逐一注册 handler 函数。保持这个接口让类型系统为 Step 5 做准备。
 */
export interface CommandHandlerContext {
  /** 从 draft 解析出的参数值 */
  readonly args: Readonly<Record<string, unknown>>;
  /** 原始 draft 文本（含 slash 和参数） */
  readonly rawInput: string;
  /** 运行时上下文 */
  readonly runtime: RuntimeContext;
}

export type CommandHandler = (
  ctx: CommandHandlerContext,
) => Promise<CommandHandlerResult> | CommandHandlerResult;

// ─── 参数 Schema（结构化判别式联合） ───

/**
 * 参数枚举的候选项。
 * - 字符串：value === label
 * - 对象：可以带 description 和 tag，渲染器可展示附加信息
 */
export type ArgChoice =
  | string
  | {
      readonly value: string;
      readonly label: string;
      readonly description?: string;
      readonly tag?: string;
    };

/**
 * 参数枚举查询上下文 —— 传给 AsyncEnumArg.provider.list 的参数。
 */
export interface ArgQueryContext {
  /** 当前已输入的前缀（用于过滤） */
  readonly query: string;
  /** 所属命令 */
  readonly command: CommandDef;
  /** 当前是第几个参数（0-based） */
  readonly argIndex: number;
  /** 运行时上下文 */
  readonly runtime: RuntimeContext;
}

/**
 * 候选列表支持的 inline 操作能力集 —— provider 静态声明"这个候选列表支持
 * 哪些就地操作",驱动 typeahead Panel 的快捷键提示行与 InputController 的按键
 * 拦截。声明与执行分离:这里只声明能力(纯数据),物理操作 + 业务编排由 cli
 * 层 callback 承担(delete 走 onCandidateDelete,rename / create 走主循环消费
 * inline 编辑请求)。
 *
 *   - delete / rename:作用于选中候选,依赖 selectedIndex >= 0
 *   - create:新建一条,作用于整个列表,不依赖选中
 */
export interface InlineActionSupport {
  readonly delete?: boolean;
  readonly rename?: boolean;
  readonly create?: boolean;
}

/**
 * 面板语义模式 —— provider 必填，决定 typeahead 框架对该候选列表的 Enter / footer /
 * 按键 dispatch 行为。两种模式语义彻底分离，避免"列表面板"抽象被多种语义隐式重载：
 *
 *   - `picker`：选择器。用户从候选挑一个值给业务用（典型：/work 切场景、/resume
 *     切对话）。Enter accept 候选触发业务动作；footer 显「↑↓ · Enter · Esc」；
 *     inlineActions（delete/rename/create）是辅助操作。
 *   - `management`：管理面板。用户对资源做就地操作（典型：/trust 撤销规则）。
 *     "选中"只是导航位置，无 accept 业务语义；Enter 在面板内 no-op；footer 显
 *     「↑↓ · {inline 操作} · Esc」不含 Enter；inlineActions 是主操作。
 *
 * 未来扩新模式（multi-select / read-only 等）仅需追加 union 成员 + 各层 switch
 * exhaustive 分支，TypeScript 强制把所有 caller highlight 出来。
 */
export type PanelMode = "picker" | "management";

/**
 * 异步参数候选提供者。
 * 实现者返回一个 Promise，**必须**在 signal abort 时尽快 reject 或返回部分结果。
 */
export interface ArgChoiceProvider {
  list(ctx: ArgQueryContext, signal: AbortSignal): Promise<readonly ArgChoice[]>;
  /**
   * **必填**：面板语义模式（picker / management）。决定 Enter / footer / 按键
   * dispatch 行为。type system 强制 caller 显式表态，杜绝"所有候选列表都是
   * picker"的隐式假设。详见 PanelMode 注释。
   */
  readonly mode: PanelMode;
  /**
   * 可选:静态声明此 provider 的候选列表支持哪些 inline 操作。仅声明能力 ——
   * Panel 据此渲染快捷键提示、InputController 据此拦截按键;实际的物理操作与
   * 业务编排在 cli 层 callback 完成。
   */
  readonly inlineActions?: InlineActionSupport;
  /**
   * 可选:候选为空时面板显示的引导文案,替代技术占位（"未找到匹配项" / 参数
   * hint）。如 workscene 的"暂无工作场景，Ctrl+N 新建一个"。
   */
  readonly emptyHint?: string;
}

interface ArgBase {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** 捕获剩余所有 token 作为单个 value（例如 "/background <prompt...>"） */
  readonly captureRemaining?: boolean;
}

/** 固定枚举 —— 在定义时就知道所有可能的值 */
export interface StaticEnumArg extends ArgBase {
  readonly kind: "enum";
  readonly choices: readonly ArgChoice[];
}

/** 动态枚举 —— 运行时查询（如 /model 的模型列表） */
export interface AsyncEnumArg extends ArgBase {
  readonly kind: "async-enum";
  readonly provider: ArgChoiceProvider;
}

/** 自由文本 —— 不做 dropdown，只显示 placeholder 到 argumentHint */
export interface FreeTextArg extends ArgBase {
  readonly kind: "text";
  readonly placeholder?: string;
}

/** 路径 —— trigger filesystem 补全 */
export interface PathArg extends ArgBase {
  readonly kind: "path";
  readonly onlyDirectories?: boolean;
  readonly relativeTo?: "cwd" | "workspace";
}

/** 布尔开关 —— 常用于 /toggle 类命令 */
export interface BooleanArg extends ArgBase {
  readonly kind: "boolean";
}

/** 数字 —— 带范围提示 */
export interface NumberArg extends ArgBase {
  readonly kind: "number";
  readonly min?: number;
  readonly max?: number;
}

/**
 * ArgSchema 判别式联合 —— 根据 kind 分派。
 * 新增参数类型只加一个 variant，不改 core。
 */
export type ArgSchema =
  | StaticEnumArg
  | AsyncEnumArg
  | FreeTextArg
  | PathArg
  | BooleanArg
  | NumberArg;

// ─── 命令定义 ───

/**
 * 命令定义 —— Typeahead 系统的单一真相源。
 *
 * CLI / 未来的 Web / gateway 都从这里 derive 自己的视图。不存在"CLI 有一份、
 * Web 又有一份平行投影"的双重维护问题（见 OpenClaw 的教训）。
 */
export interface CommandDef {
  // ── 标识 ──
  /** 规范名，无前导斜杠，建议 kebab-case（如 "elevated" / "add-dir"） */
  readonly name: string;

  /** 可选别名（如 ["elev"] 是 "elevated" 的别名） */
  readonly aliases?: readonly string[];

  /**
   * 稳定的命令 id —— plugin 消歧义和 MRU tracking 依赖它。
   *
   * 约定格式：`${name}:${source}`，例如 "elevated:builtin"、"greet:user"、
   * "custom:plugin:github.com/foo/bar"。由 registry 在注册时计算或由注册方显式提供。
   */
  readonly id: string;

  // ── 人读元数据 ──
  readonly description: string;
  readonly category: CommandCategory;
  /** 单字符或 emoji，渲染器选用 */
  readonly icon?: string;
  /** 右上角小标签 */
  readonly tag?: "workflow" | "builtin" | "plugin" | "project" | "user";

  // ── 参数 schema ──
  readonly args?: readonly ArgSchema[];

  // ── 行为 ──
  readonly execution: CommandExecution;

  readonly visibility?: CommandVisibility;

  /**
   * 隐藏：补全菜单不列出，但打精确名仍能召唤（spec §6.4 hidden escape hatch）。
   * 和 visibility.targets=[] 的区别：hidden 永远隐藏，visibility 是条件隐藏。
   */
  readonly hidden?: boolean;

  /**
   * 本地执行 handler。execution = "local" 或 "hybrid" 时**应该**填写；
   * execution = "agent" 时必须留空。
   *
   * Phase 1 Step 2（核心类型落地）不填 handler，Step 5（REPL 接入）负责
   * 为每个 builtin 命令注册真正的 handler。此时留空允许类型通过编译。
   */
  readonly handler?: CommandHandler;
}

// ─── 动态命令源 ───

/**
 * 动态命令源 —— 运行时产生命令列表的提供者。
 *
 * 典型用途：
 *   - Filesystem 扫描 `.zhixing/commands/*.md`
 *   - Plugin 注册的动态命令
 *   - MCP server 暴露的 resources-as-commands
 *
 * 每次 `registry.refresh()` 都会调用 `list()`。实现者可以内部缓存以避免重复
 * 计算 —— registry 不做跨刷新的缓存。
 */
export interface DynamicCommandSource {
  readonly id: string;
  list(): Promise<readonly CommandDef[]>;
}

// ─── Registry 接口 ───

/**
 * 注册的取消句柄（reg vs unreg 对称）。
 * 注：订阅取消句柄 Unsubscribe 复用 core/events/types.js 里的同名定义，
 * 避免跨模块的同形类型重复声明。
 */
export type Unregister = () => void;

// 重新导出 events 的 Unsubscribe —— 本模块接口里需要它做 listener 类型
import type { Unsubscribe } from "../events/types.js";
export type { Unsubscribe };

/**
 * 命令注册表接口。
 *
 * 三条语义：
 *   1. 静态注册：`register(cmd)` 立即可见
 *   2. 动态源：`registerDynamicSource(source)` 注册后需要 `refresh()` 才加载
 *   3. 可见性：`list(ctx)` 按 ctx 过滤 visibility，不 mutate registry
 *
 * 所有查询（list / find / findByName）都是同步的 —— 动态源的数据在
 * refresh() 时被拉到内存缓存，后续查询都是纯内存操作。
 */
export interface ICommandRegistry {
  /**
   * 注册一个静态命令。id 必须唯一，重复 id 将抛 Error。
   */
  register(cmd: CommandDef): void;

  /**
   * 取消注册。找不到 id 时静默返回 false。
   */
  unregister(id: string): boolean;

  /**
   * 注册一个动态命令源。返回 Unregister，调用即移除此源及其缓存的命令。
   */
  registerDynamicSource(source: DynamicCommandSource): Unregister;

  /**
   * 同步列出所有命令（静态 + 动态源的缓存），按 visibility 过滤。
   *
   * **不包括 `hidden: true` 的命令** —— 那些只能通过 `findByName` 精确查询。
   */
  list(ctx: RuntimeContext): readonly CommandDef[];

  /**
   * 异步刷新所有动态源。调用每个源的 `list()` 并更新缓存。
   * 部分失败：单个源抛异常不影响其他源，失败的源保持旧缓存 + 触发日志 hook。
   */
  refresh(): Promise<void>;

  /** 按 id 精确查询。找不到返回 null。包括 hidden 和 invisible 命令。 */
  find(id: string): CommandDef | null;

  /**
   * 按 name 或 alias 查询（大小写不敏感）。
   * **包括 hidden 命令** —— 这是 escape hatch：隐藏命令能通过名字被召唤。
   * 不包括 visibility 过滤 —— 执行路径自己判断能不能跑。
   */
  findByName(name: string): CommandDef | null;

  /**
   * 订阅 registry 变化事件（register / unregister / refresh 完成 / 动态源增减）。
   */
  onChange(listener: () => void): Unsubscribe;
}

// ─── Usage Tracker（MRU scoring） ───

/**
 * Usage tracker 持久化的单条记录。
 * 对应 input-typeahead.md §6.4.5 的数据格式 v2。
 */
export interface UsageEntry {
  /** 已应用衰减后的 score，∈ [0, MAX_SCORE] */
  readonly score: number;
  /** 上次衰减计算的时间戳（epoch ms） */
  readonly lastUsedAt: number;
}

/**
 * MRU 评分跟踪器。
 *
 * 实现 input-typeahead.md §6.4 的 bounded frecency 模型：
 *   - score 本身有界（≤ MAX_SCORE=32）
 *   - 7 天半衰期
 *   - 30 天不用衰减到 ~5%
 *   - 90 天不用被自动 GC（< GC_THRESHOLD=0.01）
 *
 * 所有读操作（getScore / topN）应用懒衰减，不修改磁盘。
 * 写操作（recordUsage）更新内存 + debounced 刷盘。
 */
export interface IUsageTracker {
  /**
   * 写入一次使用事件。内部自动：
   *   1. 懒衰减旧 score
   *   2. +1（卡 MAX_SCORE 上限）
   *   3. 顺路 GC 所有 score < GC_THRESHOLD 的 entry
   *   4. 标记 dirty，等 debounced flush（或立即 flush，取决于配置）
   */
  recordUsage(commandId: string): void;

  /** 读取当前有效 score（已应用懒衰减，不修改磁盘） */
  getScore(commandId: string): number;

  /**
   * 取 top N，按 getScore 降序。
   * N 超过实际非零条目时返回的数组长度 ≤ N。
   */
  topN(n: number): ReadonlyArray<{ commandId: string; score: number }>;

  /**
   * 手动触发 GC + flush。通常 recordUsage 时自动跑，此方法用于测试、
   * 程序退出时的确定性写盘、或显式请求压缩。
   * 返回被清除的 entry 数量。
   */
  prune(): Promise<number>;

  /**
   * 立即刷盘（绕过 debounce）。测试和退出路径使用。
   */
  flush(): Promise<void>;
}

// ─── Trigger 上下文与匹配 ───

/**
 * 输入模式 —— provider 的 matchTrigger 需要区分 prompt / bash。
 * bash 模式下 `/` 是 Unix 路径分隔符，slash command 不应触发。
 */
export type TypeaheadMode = "prompt" | "bash";

/**
 * Trigger 检测的输入上下文。
 *
 * 传给每个 SuggestionProvider 的 `matchTrigger(ctx)`。Provider 决定是否
 * 命中当前上下文 —— 通常查 `draft.substring(0, cursor)` 并跑触发正则。
 */
export interface TriggerContext {
  readonly draft: string;
  /** 光标的**字符**位置（不是字节）。CJK 和 emoji 不会撕裂 */
  readonly cursor: number;
  readonly mode: TypeaheadMode;
  readonly runtime: RuntimeContext;
  /**
   * 额外的 word 终止符 pattern——这些 pattern match 范围内的字符视作 word 边界，
   * 与空白同等地位。caller（如 cli）通过 broker options 注入；broker 在调
   * provider.matchTrigger 前包装到此字段。Provider 自行将其传递给 findTriggerToken。
   *
   * 用例：粘贴占位符 token（cli 注入 PASTE_TOKEN_PATTERN），让 trigger 反向扫不
   * 跨过占位符（避免 `/file [Pasted #1 ...]` 整段被当 trigger query）。
   */
  readonly wordTerminators?: readonly RegExp[];
}

/**
 * Trigger 命中后返回的数据 —— provider 内部状态的 snapshot，
 * broker 会把它一字不差地传回给 `provider.query(match, signal)`。
 */
export interface TriggerMatch {
  /** 命中的 provider.id */
  readonly providerId: string;
  /** Token 在 draft 里的字符起始位置 */
  readonly tokenStart: number;
  /** Token 在 draft 里的字符终止位置（exclusive） */
  readonly tokenEnd: number;
  /** Token 的完整字符串（含触发字符如 `/` 或 `@`） */
  readonly token: string;
  /** 用于过滤的 query 部分（通常去掉触发字符） */
  readonly query: string;
  /**
   * 捕获 matchTrigger 发生那一刻的 runtime context。
   *
   * 为什么把它放在 TriggerMatch 里：`query(match, signal)` 需要知道 runtime
   * 才能应用 visibility 过滤、读 MRU、拿 workspace id 等。我们**不**让 provider
   * 自己缓存上次看到的 runtime（那是隐式状态 + 测试噩梦），而是把 runtime 显式
   * 锁进 TriggerMatch —— broker 保证 matchTrigger → query 是紧邻的，此 runtime
   * 就是触发时的最新值，不存在 staleness。
   */
  readonly runtime: RuntimeContext;
  /** Provider 特有的额外上下文（command arg index、mcp server id 等） */
  readonly providerData?: unknown;
}

// ─── Suggestion Item 与 Accept ───

/**
 * 主题色 key —— renderer 决定具体颜色，core 只声明语义。
 */
export type ThemeColorKey = "suggestion" | "accent" | "muted" | "warning";

/**
 * Accept 后对 draft / cursor / 执行归属的指令。
 */
export interface AcceptPayload {
  /** 替换当前 trigger token 的文本（含前导的 `/` 或 `@`） */
  readonly replacement: string;
  /**
   * Accept 后光标应落在 replacement 里的哪个 offset（0-based 字符）。
   * 未指定时 broker 把光标放到 replacement 尾。
   */
  readonly cursorOffset?: number;
  /** 选中后是否立即提交 */
  readonly execute: boolean;
  /** 提交时附带的结构化 metadata，传给 agent loop */
  readonly metadata?: Record<string, unknown>;
  /**
   * 执行归属的硬性 hint —— 覆盖 provider 默认判断。CLI 分派层会读。
   */
  readonly executionHint?: CommandExecution;
}

/**
 * 渲染器无关的候选数据。
 *
 * 同一份 SuggestionItem 可以被 TTY / Web / 微信渲染器消费 ——
 * 各渲染器按自己的 capabilities 裁剪字段（比如 TTY 不支持 color 就忽略）。
 */
export interface SuggestionItem {
  /** 稳定 id —— 重渲染时用来保持选中项不跳 */
  readonly id: string;
  /** 产出此 item 的 provider id */
  readonly providerId: string;

  // ── 显示 ──
  readonly displayText: string;
  readonly description?: string;
  /** 单字符或 emoji */
  readonly icon?: string;
  /** 右上角小标签（如 "workflow"） */
  readonly tag?: string;
  /** 语义色 key */
  readonly color?: ThemeColorKey;

  // ── 行为 ──
  readonly acceptPayload: AcceptPayload;

  /** 加载中占位 —— async provider 的 pending 条目 */
  readonly loading?: boolean;
}

// ─── Provider 接口 ───

/**
 * Suggestion Provider 接口 —— 插件式 typeahead 触发处理。
 *
 * 一个 provider 对应一类触发（`/command` / `@file` / `@memory` / ...）。
 * Broker 按 priority 升序依次调 `matchTrigger(ctx)`，首个返回非 null 的命中。
 *
 * Provider 是**无状态**的 —— 所有 per-session 状态在 broker 里。每次 query
 * 重新传完整 context，provider 内部不持有"当前选了啥"之类的记忆。
 */
export interface SuggestionProvider {
  /** 唯一 id */
  readonly id: string;
  /**
   * 显式优先级 —— 数字越小越优先。spec §8.1 约定：
   *   - 内建 providers: 1-399
   *   - Plugin providers: 400-999
   *   - 同 priority 按注册顺序 tiebreak
   */
  readonly priority: number;

  /**
   * 检查当前输入是否应触发本 provider。**cursor-aware**（查 substring(0, cursor)）。
   * 返回 null 表示不命中；返回 TriggerMatch 表示命中且应该 query。
   */
  matchTrigger(ctx: TriggerContext): TriggerMatch | null;

  /**
   * 查询候选。可以是同步（立即返回数组）或异步（返回 Promise）。
   * `signal` 用于取消过期查询；provider 实现应尽快响应 abort。
   *
   * 抛异常 / Promise reject：broker 捕获并降级到空 suggestions，不传染到 renderer。
   */
  query(
    match: TriggerMatch,
    signal: AbortSignal,
  ): SuggestionItem[] | Promise<SuggestionItem[]>;

  /** 声明此 provider 是否能返回 ghost text —— broker 会据此决定是否计算 */
  readonly supportsGhostText?: boolean;

  /**
   * 计算 ghost text（inline 补全提示）。仅在 `supportsGhostText=true` 时被 broker 调用。
   *
   * Ghost text 是 prefix-based 的"不用 fuzzy"的精确补全：`/up` → dim `date`。
   * 与 dropdown（fuzzy）并行存在，不冲突。
   *
   * 返回 null 表示：当前 query 没有 unambiguous 的 prefix match（多个候选或零个），
   * broker 会设 `state.ghostText = null`。
   */
  computeGhostText?(match: TriggerMatch): GhostText | null;

  /**
   * 计算当前参数的 progressive hint。仅 ArgumentProvider 实现。
   * broker 在 query 完成后调用（和 computeGhostText 同模式）。
   */
  computeArgumentHint?(match: TriggerMatch): ArgumentHint | null;

  /**
   * 计算当前 trigger 的候选列表支持哪些 inline 操作。broker 在 query 完成后
   * 调用,结果写入 `TypeaheadSessionState.inlineActions`。仅 provider 内部
   * 知道自己当前 match 的下层 schema / provider 声明了哪些能力 —— broker 不
   * 跨层访问 provider 内部数据结构,通过本 hook 让 provider 自决。
   *
   * 默认 `{}`(未实现 = 无 inline 操作)。ArgumentProvider 实现为读取
   * async-enum schema 的 `provider.inlineActions`。
   */
  computeInlineActions?(match: TriggerMatch): InlineActionSupport;

  /**
   * 计算当前 trigger 的面板语义模式。broker 在 query 完成后调用，结果写入
   * `TypeaheadSessionState.panelMode`。仅 provider 内部知道自己当前 match 的
   * 下层 schema / provider 的 mode 声明 —— broker 不跨层访问，通过本 hook 让
   * provider 自决。
   *
   * 未实现 = 默认 `"picker"`（命令选择面板永远是 picker，CommandProvider 不实现）。
   * ArgumentProvider 实现为读取 async-enum schema 的 `provider.mode`。
   */
  computePanelMode?(match: TriggerMatch): PanelMode;

  /** 声明此 provider 是否支持 accept 后继续同 provider 的链式 query（比如两段式 /cmd → args） */
  readonly supportsChaining?: boolean;
}

// ─── Session 状态 ───

/**
 * Ghost text —— inline 补全，dim 色追加在光标后。
 */
export interface GhostText {
  /** 追加到 draft 光标后的文本 */
  readonly suffix: string;
  /** 完整的命令/文件名（接受后替换的目标） */
  readonly fullValue: string;
}

/**
 * 参数提示 —— 命令选中后显示下一个参数的 schema。
 */
export interface ArgumentHint {
  /** 当前正在输入第几个参数（0-based） */
  readonly argIndex: number;
  /** 渲染用的完整 hint 字符串，如 "[level: on|off|ask|full]" */
  readonly renderedHint: string;
  /** 当前参数的 schema（用于类型分派） */
  readonly currentArg: ArgSchema;
  /** 候选为空时的引导文案 —— 来自 async-enum 的 provider.emptyHint。 */
  readonly emptyHint?: string;
}

/**
 * 当前激活 provider 的 UI-facing 投影 —— 仅暴露 caller 真实需要的字段，
 * 不携带 provider 的内部方法（matchTrigger / query）和实现细节。
 *
 * 设计动机：
 *   1. 封装边界 —— renderer 是被动观察者，不应有调 provider.query 等的能力
 *   2. 可序列化 —— 类型仅含 plain data，未来跨进程 / Web 推送 session state 时
 *      天然可走 JSON 序列化，不需要再做投影/裁剪
 *   3. 类型签名 = 真实意图 —— 与 broker.accept 改 state-纯同性质架构对齐：
 *      签名暴露的能力 = caller 真实需要的能力，杜绝隐式扩权
 *
 * 未来若 renderer 需要 provider 的更多 UI 元数据（display name / icon 等），
 * 在本接口加字段即可，由 broker 在 setSessionState 时按需投影注入。
 */
export interface ActiveProviderInfo {
  readonly id: string;
}

/**
 * 一次输入会话的派生状态 —— 由 broker 维护，发给 renderer。
 *
 * **零键执行不变量**（spec §6.5）：
 *   `suggestions.length > 0 ⇒ selectedIndex >= 0`（默认 0，用户导航后 ∈ [0, len)）
 */
export interface TypeaheadSessionState {
  readonly sessionId: string;

  /** 当前激活的 provider（仅 UI-facing 信息）；null 表示无 trigger 命中 */
  readonly activeProvider: ActiveProviderInfo | null;

  /** 当前触发信息；null 表示无 trigger */
  readonly trigger: TriggerMatch | null;

  /** 当前候选列表 */
  readonly suggestions: readonly SuggestionItem[];

  /** 选中索引。suggestions 非空时 >= 0；为空时 === -1 */
  readonly selectedIndex: number;

  /** 是否在 async 查询中（显示 loading） */
  readonly loading: boolean;

  /** Ghost text，null 表示无（可与 suggestions 同时存在） */
  readonly ghostText: GhostText | null;

  /** 参数提示，null 表示无 */
  readonly argumentHint: ArgumentHint | null;

  /**
   * 当前 trigger 的候选列表支持的 inline 操作集。由
   * `SuggestionProvider.computeInlineActions` hook 在 query 完成后推导写入,
   * 未实现 hook = `{}`。typeahead Panel 据此渲染快捷键提示行,InputController
   * 据此决定 Ctrl+D / Ctrl+R / Ctrl+N 是否生效。
   */
  readonly inlineActions: InlineActionSupport;

  /**
   * 当前 trigger 的面板语义模式。由 `SuggestionProvider.computePanelMode` hook
   * 在 query 完成后推导写入，未实现 hook = `"picker"`（CommandProvider 默认）。
   * typeahead Panel 据此决定 footer navKeys 是否含 Enter；InputController 据此
   * 决定 Enter 键是 accept 还是 no-op。
   */
  readonly panelMode: PanelMode;

  /**
   * 当前准备删的 `SuggestionItem.id`(typeahead 现有唯一标识),null 表示无
   * 准备态。**字段单源不变量**:`markDeletePending` 是该字段的**唯一**变更
   * 入口;其他所有 mutate session 的路径(走 `setSessionState`)自动 reset
   * 为 null —— 实现"任何其他按键取消准备态"由 broker 单源保证。
   */
  readonly deletePending: string | null;
}

/**
 * accept 产生的结果 —— 上层根据此更新 inputBuffer 并决定是否 submit。
 */
export interface AcceptResult {
  readonly newDraft: string;
  readonly newCursor: number;
  readonly execute: boolean;
  readonly executionHint?: CommandExecution;
  readonly metadata?: Record<string, unknown>;
}

// ─── Broker 接口 ───

/**
 * Session handle —— beginSession 返回的引用。
 */
export interface TypeaheadSessionHandle {
  readonly id: string;
}

/**
 * Typeahead Broker 状态快照（诊断 + 测试用）。
 * 命名特意加 "Typeahead" 前缀避免与 confirmation/types.ts 的 BrokerSnapshot 冲突。
 */
export interface TypeaheadBrokerSnapshot {
  readonly activeSessions: number;
  readonly providerCount: number;
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly priority: number;
  }>;
}

/**
 * Typeahead Broker 接口。
 *
 * 职责（spec §5.5 合约）：
 *   1. Provider 注册 + 按 priority 分派
 *   2. Session 生命周期管理
 *   3. Abort 过期异步 query
 *   4. 维护 selectedIndex 的「零键执行」不变量（spec §6.5）
 *   5. Provider 异常降级到空 suggestions，不传染
 *   6. 发射 typeahead:* 事件到 EventBus
 */
export interface ITypeaheadBroker {
  // ── Provider 管理 ──
  register(provider: SuggestionProvider): Unregister;
  listProviders(): readonly SuggestionProvider[];

  // ── Session 生命周期 ──
  beginSession(initial: TriggerContext): TypeaheadSessionHandle;
  updateInput(sessionId: string, ctx: TriggerContext): void;
  accept(sessionId: string, item: SuggestionItem): AcceptResult | null;
  /**
   * 接受当前 ghost text，替换 trigger token 为 `ghostText.fullValue`。
   * 无 ghost text / 无 trigger / session 不存在时返回 null。
   *
   * Tab 按键的首选路径 —— 有 ghost 时 Tab 走这里，不走 dropdown accept。
   */
  acceptGhostText(sessionId: string): AcceptResult | null;
  moveSelection(sessionId: string, delta: number): void;
  cancelSession(sessionId: string): void;

  /**
   * 标记或清除"准备删除"态。InputController 在 Ctrl+D 第一次按时调
   * `markDeletePending(sessionId, selected.id)` 进入准备态;后续任何走
   * `setSessionState` 的 session mutate 路径(`updateInput` / `moveSelection`
   * 等)会自动清空,InputController 无需在每个按键路径显式取消。
   */
  markDeletePending(sessionId: string, suggestionId: string | null): void;

  /**
   * 强制重新 query 当前 trigger —— canonical(suggestions / selectedIndex /
   * ghostText / argumentHint / inlineActions)重置为初始 loading 态,query resolve
   * 后看到新候选。InputController 在 `onCandidateDelete` 完成后调用,触发
   * 候选列表刷新(避免删后视觉残留 + selectedIndex 指向已不存在候选)。
   * 当前 trigger 已 gone(用户改 query 全删 trigger 字符)时退化为清空 state。
   */
  refresh(sessionId: string): void;

  // ── 状态查询 ──
  getState(sessionId: string): TypeaheadSessionState | null;
  onSessionChange(
    sessionId: string,
    listener: (state: TypeaheadSessionState) => void,
  ): Unsubscribe;

  snapshot(): TypeaheadBrokerSnapshot;
}

// ─── Renderer 接口（spec §5.6） ───

/**
 * 渲染器能力声明 —— broker 在构造 SuggestionItem 时可据此裁剪字段，
 * 避免渲染器不支持的特性被计算出来后浪费。
 *
 * 类比 confirmation-ux.md 的 `RendererCapabilities` —— 同一份设计套路。
 */
export interface TypeaheadRendererCapabilities {
  /** 支持 ghost text 显示（inline，不在 dropdown 里） */
  readonly supportsGhostText: boolean;
  /** 支持 dropdown 菜单 */
  readonly supportsDropdown: boolean;
  /** 支持独立的 argument hint 行 */
  readonly supportsArgumentHint: boolean;
  /** 支持 loading 状态显示（spinner） */
  readonly supportsLoadingState: boolean;
  /** 支持 icon / tag / color 视觉元素 */
  readonly supportsRichItem: boolean;
  /** 支持多列布局（displayText + description 分列） */
  readonly supportsMultiColumn: boolean;
  /** 最大可见条目数 */
  readonly maxVisibleItems: number;
}

/**
 * Typeahead 渲染器接口。任何渲染器（CLI/TTY、Web、微信等）实现此接口
 * 绑定到 broker session 即可消费 state 变化。
 *
 * **职责边界**：渲染器只读 state，不写。所有 state 变更都通过 broker 的
 * 公开方法（updateInput/moveSelection/accept/cancelSession）进行。
 */
export interface TypeaheadRenderer {
  readonly name: string;
  readonly capabilities: TypeaheadRendererCapabilities;

  /**
   * 绑定到 broker 的某个 session，开始订阅并渲染。
   * 返回的 Unsubscribe 提供细粒度解绑；渲染器自己也应该内部记录状态便于
   * 后续 `detach()` 兜底清理。
   */
  attach(sessionId: string): Unsubscribe;

  /** 手动解绑（会话结束、程序退出） */
  detach(): void;
}
