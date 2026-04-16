# 知行输入补全交互设计方案 v1.0

> **状态**: 📐 方案设计（2026-04-15）
> **前置**: [confirmation-ux.md](./confirmation-ux.md) Phase 1 已落地（`SelectWithInput` + raw-mode 基建 + §6.4 cursor/stdin 护栏已验证）
> **信息来源**:
> - [research/source-analysis/openclaw/slash-command-completion.md](../../source-analysis/openclaw/slash-command-completion.md)
> - [research/source-analysis/hermes-agent/slash-command-completion.md](../../source-analysis/hermes-agent/slash-command-completion.md)
> - [research/source-analysis/claude-code/slash-command-completion.md](../../source-analysis/claude-code/slash-command-completion.md)

---

## 一、问题陈述

当前知行 REPL 的输入层是直接使用 Node 的 `readline.question` —— 用户敲什么就原样送进 agent loop，**没有任何输入时补全**：

- 没有 `/` 触发的 slash command 提示
- 没有 `@file` 文件引用
- 没有 `@memory:` 记忆条目引用
- 没有 `@tool:` 工具引用
- 没有历史命令 ghost text
- 没有命令发现机制 —— 用户必须记住命令名

这让知行作为"顶级标准的公开仓库项目"的目标打了折扣：**新用户不知道 agent 能做什么**，**熟练用户打字累**。三家竞品（OpenClaw / Hermes / Claude Code）都做了输入补全 —— 但三家都有明显缺口，没有一家把这件事做到位（详见 `source-analysis/*/slash-command-completion.md`）。

### 核心痛点（按严重度排序）

1. **命令发现**：用户不知道能打 `/help`、`/model`、`/status`、`/new` 等，新手曲线陡。
2. **打字多**：`/elevated ask` 十个字符没补全，熟练用户痛苦。
3. **没有参数提示**：`/model` 后面接什么？需要先敲 `/help model` 查，然后回来继续打。
4. **没有文件引用**：想让 agent 读 `src/security/secure-executor.ts` 只能复制粘贴路径 —— agent 也看不出来你是在引用而不是在描述。
5. **没有记忆/工具引用**：知行有记忆系统和 tool registry，但用户无法在输入里精确定位 `@memory:confirmation-state`、`@tool:bash`。
6. **没有历史补全**：上一次打过 `/elevated ask session`，下次还得全部重打。
7. **模态耦合灾难预留**：未来要加 clarify、sudo、modal dialogs，如果现在在 `readline.question` 上硬叠 raw-mode 会冲突 —— 必须在架构级别把 input layer 抽出来。
8. **驭灵无感知**：驭灵未来要跨 Web / 微信 / 钉钉渲染，如果补全逻辑写死在 CLI 里，整个 input layer 就白做。

### 不是痛点但容易误判

- **补全逻辑能不能直接用第三方库**：能，但三家竞品都栽在这条路上 —— OpenClaw 交给 `@mariozechner/pi-tui` 变黑盒；Hermes 和 `prompt_toolkit` 深耦合；Claude Code 用 Ink + fuse.js 却给自己留了 1384 行单文件 dispatcher。知行已经决定自研 raw-mode TTY，这一选择已经挡住了第三方 UI 框架的诱惑，剩下的问题是**架构分层**而不是"要不要自研"。
- **是不是越多 provider 越好**：不是。多触发前缀是能力，不是目标。第一阶段只做 `/`，后续按用户请求加 `@file` / `@memory` / `@tool`，每加一个必须有明确的用户场景对应。
- **是不是该现在就做 Web renderer**：不。confirmation-ux.md 已经证明"Broker + Renderer 接口 + TTY 先行"的渐进模式能 work，Web renderer 是占位，证明架构 —— 不交付。

---

## 二、调研要点（一句话版）

| 维度 | OpenClaw (CLI) | OpenClaw (Web) | Hermes | Claude Code | **知行（设计后）** |
|---|---|---|---|---|---|
| 交互栈 | `@mariozechner/pi-tui` 黑盒 | Lit 手写 state | `prompt_toolkit` 子类 | Ink + React Compiler | **自研 raw-mode，复用 `SelectWithInput`** |
| 触发检测 | pi-tui 内部 | `^\/(\S*)$` 严格 | `startswith("/")` | **cursor-aware**（`value.substring(0, cursor)`） | **cursor-aware + Unicode** |
| Mid-input slash | ? | ❌ | ❌ | ✅ (`findMidInputSlashCommand`) | ⏸️ P2（空格后触发已支持，见 §12.2 #9） |
| 过滤算法 | pi-tui 内部（prefix?） | prefix + substring | **纯 prefix** | Fuse.js 加权 fuzzy + 自定义 resort | **Fuse.js + resort + 知行加权** |
| MRU / 频度排序 | ❌ | ❌ | ❌ | ✅ `skillUsageScore` | ✅ Phase 1 |
| 分类分组 | ❌ | 按 category | 按源顺序 | 最近用 → builtin → user → project → policy | **Phase 1 即到位** |
| 多触发前缀 | `/` + cwd(?) | 只 `/` | `/` + `@` + path | `/` / `@file/mcp/agent` / `#channel` / bash history / directory / custom-title | **`/` / `@file` / `@memory` / `@tool` / `@mcp` / `@agent` 统一** |
| Ghost text | ❌ | ❌ | ✅ 两级（命令 + sub） | ✅（prefix，非 fuzzy） | ✅ Phase 2 |
| 异步候选 | ❌ | ❌ | ❌ | ✅（stale-ref guard） | ✅（`AbortController`） |
| 参数提示（hint） | ❌ | 有 `argOptions` 两段式 | `args_hint` 字符串 | `argumentHint` + progressive `argNames` | **argSchema 结构化 + progressive** |
| 参数枚举补全 | CLI 有 `getArgumentCompletions` | `argOptions` 两段式 | `SUBCOMMANDS` 静态表 | `/add-dir` `/resume` 特事特办 | **通用 `ArgCompletionProvider`** |
| Enter with suggestions guard | ❌ | 有 | prompt_toolkit 默认 | ✅（`isSubmittingSlashCommand` 穿透） | **Phase 1 即到位** |
| 命令数据共享 | 共享 `buildBuiltinChatCommands` | 共享 | **单源 `COMMAND_REGISTRY`** | 四源合并（local/prompt/plugin/policy） | **`CommandRegistry` 单源 + 动态 provider** |
| 运行时过滤 | ❌ | ❌ | ✅ `command_filter` callable | ✅ `isHidden` + source | ✅ `visibility` + `command_filter` |
| Plugin / filesystem 命令 | gateway commands | UI only commands | skill commands lambda | `.claude/commands/*.md` 多源 | **`.zhixing/commands/*.md` + plugin API** |
| 核心/渲染分离 | ❌（pi-tui 绑死） | ❌（Lit 绑死） | ❌（prompt_toolkit 绑死） | ❌（Ink 绑死） | ✅ **`TypeaheadBroker` + `Renderer` 接口** |
| 驭灵就绪 | ❌ | ❌ | ❌ | ❌ | ✅ **Phase 1 架构即支持** |
| 可测性 | ⚠️ 黑盒 | ⚠️ Lit 难测 | ⚠️ prompt_toolkit 难测 | ⚠️ Ink 难测 + compiler memo slot | ✅ **Broker 纯逻辑 + `PassThrough` 测试** |

---

## 三、设计目标（按优先级）

1. **让输入不再打字**。`/` 触发就能看到所有能做的事；方向键选、Enter 执行。
2. **让输入表达意图**。`@file src/foo.ts` 让 agent 精确知道"我指的是这个文件"而不是字符串匹配。
3. **让核心与渲染分离**。和 [confirmation-ux.md](./confirmation-ux.md) 同构 —— Core 只知道"有一个 typeahead 请求等待用户决定"，不知道终端在哪。
4. **让 provider 可插拔**。`/command`、`@file`、`@memory`、`@tool` 都是 `SuggestionProvider` 的实现，显式 priority，新触发 = 新 provider，不改核心。
5. **让异步优先**。文件、记忆、MCP 资源都是 async 源，从一开始就用 `AbortController` 取消过期请求，不留同步阻塞 debt。
6. **让参数结构化**。命令参数不是"一个字符串 hint"而是 `ArgSchema[]`，能驱动 progressive 提示、枚举补全、类型校验。
7. **让测试覆盖**。核心逻辑纯函数 / 纯数据，broker + provider 用 Vitest + `PassThrough` 全覆盖，TTY 渲染器有护栏断言（§6.4 教训）。
8. **让降级优雅**。补全层失败不能影响输入 —— provider 异常时静默降级到"无补全"而不是卡死 REPL。
9. **让每一步能独立落地**。每个 Step 独立可上线 / 可测 / 可回滚 / 不破坏已有测试。
10. **让驭灵就绪**。Renderer 接口从 Phase 1 就抽象完成，未来接 Web / 微信 / 钉钉只加 renderer，不改核心。

---

## 四、架构总览

### 4.1 三层分离

```
┌───────────────────────────────────────────────────────────────┐
│  @zhixing/core — Typeahead Core                               │
│  ──────────────────────────────────────                        │
│  CommandRegistry          (命令的单一真相源)                   │
│  SuggestionProvider       (接口：任意触发类型的实现)           │
│  TypeaheadBroker          (核心：trigger 检测 + 分派 + 取消)   │
│  TypeaheadSession         (单次输入会话的状态机)               │
│  SuggestionItem           (渲染器无关的候选数据)               │
│  AcceptResult             (选中后的动作，渲染器无关)           │
│  TypeaheadRenderer        (接口：任何渲染器实现)               │
│  TriggerMatcher           (cursor-aware 触发检测工具)          │
│  FuzzyIndex               (Fuse.js 的 core 薄封装 + 缓存)      │
└───────────────┬───────────────────────────────────────────────┘
                │ TypeaheadRenderer 接口
                │
     ┌──────────┼──────────┬──────────┬──────────┐
     ▼          ▼          ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐  ┌────────┐  ┌────────┐
  │ TTY  │  │ Web  │  │ 测试 │  │ 微信    │  │ 钉钉    │
  │ raw  │  │ modal│  │ mock │  │ 按钮    │  │ 卡片    │
  └──────┘  └──────┘  └──────┘  └────────┘  └────────┘
   Phase 1   远期     Phase 1    驭灵         驭灵
```

**核心解耦原则**（完全对齐 confirmation-ux.md §4.1）：

- Core 不认识 TTY、Ink、chalk、readline、pi-tui、prompt_toolkit
- Core 暴露 `TypeaheadBroker.beginSession(input$) → SuggestionStream` —— 渲染器订阅流，自己显示并调用 `broker.accept(sessionId, item)` / `broker.cancel(sessionId)`
- 渲染器唯一义务是调用 broker 的 accept/cancel，不参与过滤 / 排序 / 触发检测

### 4.2 在洋葱模型里的位置

知行 REPL 的输入层目前是：

```
用户按键
   │
   ▼
readline.question  ──→  agent loop（整行送入）
```

改造后：

```
用户按键
   │
   ▼
TerminalTypeaheadRenderer  ◀── 订阅 broker.onSessionChange
   │                            (session = 当前输入的 typeahead 状态)
   │ raw-mode keypress
   ▼
InputBuffer (draft + cursor)
   │
   ▼
broker.updateInput({ draft, cursor, mode })
   │
   │  broker 按 priority 跑 providers.matchTrigger(ctx)
   │  第一个命中的 provider 启动 query（可能 async）
   │
   ▼
session.suggestions  ──→  renderer 重绘浮层
   │
   ▼
用户选中 / 按 Enter ──→ broker.accept(item)
   │                       ↓
   │              AcceptResult { newInput, cursor, execute }
   ▼
若 execute=true
   ──→ agent loop（或 local handler，见 §9.2）
```

**关键：输入缓冲区和补全会话是两个正交状态**。`InputBuffer` 永远是真相源；`TypeaheadSession` 是"当前这个输入位置有哪些 suggestions"的派生态。session 关了，input buffer 不受影响。

### 4.3 和 Confirmation 系统的同构优势

知行有意让 `Typeahead` 和 `Confirmation` 两个模块**结构同构**：

| 维度 | Confirmation | Typeahead |
|---|---|---|
| Core broker | `ConfirmationBroker` | `TypeaheadBroker` |
| 请求/会话 | `ConfirmationRequest` | `TypeaheadSession` |
| 决定/结果 | `ConfirmationDecision` | `AcceptResult` |
| 渲染器接口 | `ConfirmationRenderer` | `TypeaheadRenderer` |
| 渲染器能力协商 | `RendererCapabilities` | `TypeaheadRendererCapabilities` |
| 非交互兜底 | `NonInteractiveStrategy` | N/A（非交互模式就无补全，不是 fallback） |
| 事件 | `confirmation:*` | `typeahead:*` |
| TTY 实现 | `TerminalConfirmationRenderer` | `TerminalTypeaheadRenderer` |
| 原子组件 | `SelectWithInput` | `SelectWithInput`（复用） |

**为什么同构**：
1. **用户心智成本低** —— 开发者学会 confirmation 一次，typeahead 就"自然会用"。
2. **测试工具可复用** —— broker 的 FIFO、guard、事件发射的 test helper 可以共用抽象。
3. **未来统一** —— raw-mode 引用计数、renderer 生命周期管理、EventBus 都能合成一套基建。
4. **和"知行是顶级公开仓库"的目标一致** —— 架构一致性是开源项目最有价值的"看不见的文档"。

**关键不同**：
- Confirmation 是**一次性对话**（一个 request → 一个 decision → 结束），typeahead 是**持续会话**（draft 每次变化都可能更新 suggestions）。
- Confirmation 是**阻塞的**（secure-executor 等待用户决定），typeahead 是**非阻塞的**（用户不选也能继续打字、提交）。
- Confirmation 的 session 切换意味着不同的"待办事项"，typeahead 的 session 切换意味着"触发类型变了"（`/` → `@file`）。

---

## 五、核心接口

### 5.1 `CommandDef` — 命令的单一真相源

```typescript
interface CommandDef {
  // ── 标识 ──
  /** 规范名，无前导斜杠，kebab-case（如 "elevated" / "add-dir"） */
  readonly name: string;

  /** 可选别名，用户可以打任意一个（如 ["elev"]） */
  readonly aliases?: readonly string[];

  /** 稳定的命令 id，用于分析 / plugin 消歧义 */
  readonly id: string;

  // ── 人读元数据 ──
  readonly description: string;
  readonly category: CommandCategory;
  readonly icon?: string;  // 单字符或 emoji，渲染器选用
  readonly tag?: "workflow" | "builtin" | "plugin" | "project" | "user";

  // ── 参数 schema（结构化，非字符串 hint）──
  readonly args?: readonly ArgSchema[];

  // ── 行为 ──
  /** 执行归属：本地 CLI 动作 vs 发送给 agent 作为 system message */
  readonly execution: "local" | "agent" | "hybrid";

  /** 运行时可用性判断 —— 返回 false 时补全不显示 */
  readonly visibility?: CommandVisibility;

  /** 隐藏：补全不列出，但打精确名能召唤（Claude Code 风格的 escape hatch） */
  readonly hidden?: boolean;

  /** 本地执行函数（execution = "local" 或 "hybrid" 时必填） */
  readonly handler?: CommandHandler;
}

type CommandCategory =
  | "session"     // /new, /reset, /history
  | "config"      // /model, /elevated, /verbose
  | "info"        // /status, /help, /profile
  | "tools"       // /skill, /mcp
  | "session-mgmt" // /save, /branch, /resume
  | "debug"       // /debug, /logs
  | "plugin"      // plugin-registered
  | "hidden";     // 不显示在分类头，但存在

interface CommandVisibility {
  /** 在哪些渲染目标下可用 */
  readonly targets?: ReadonlyArray<"cli" | "gateway" | "web">;
  /** 运行时条件：由 broker 在 query 时调用 */
  readonly predicate?: (ctx: RuntimeContext) => boolean;
}

interface RuntimeContext {
  readonly sessionBusy: boolean;
  readonly workspaceId: string | null;
  /** 当前生效的工作区绝对路径（经过四级解析：CLI > 项目配置 > 全局配置 > cwd fallback） */
  readonly workspace: string;
  readonly cwd: string;
  readonly config: ZhixingConfig;
  readonly features: FeatureFlags;
}
```

**设计要点**：
- **`visibility.targets`** 是数组而不是 Hermes 的三个 bool 字段（`cli_only` / `gateway_only` / `gateway_config_gate`）—— 新增渲染目标只加枚举值。
- **`visibility.predicate`** 是运行时回调，知行的 "session busy 时禁用某些命令" 用这个实现 —— 抄 Hermes `command_filter` 模式但接口化。
- **`execution` 三态** 比 OpenClaw 的 `executeLocal: boolean` 多一档 `hybrid`：某些命令既有本地副作用（清屏 / 改配置）又要通知 agent（比如 `/new` 本地 reset session 同时 agent 也要知道 "用户开了新会话，历史被清"）。
- **`args` 是结构化 schema** —— Phase 2 的 progressive hint + Phase 3 的枚举补全都依赖这个。

### 5.2 `ArgSchema` — 结构化参数定义

```typescript
type ArgSchema =
  | StaticEnumArg        // 固定枚举：/fast <on|off|status>
  | AsyncEnumArg          // 动态枚举：/model <provider-model>
  | FreeTextArg           // 自由文本：/background <prompt>
  | PathArg               // 路径：/add-dir <path>
  | BooleanArg            // 布尔：/yolo
  | NumberArg;            // 数字：/rollback <number>

interface ArgBase {
  readonly name: string;         // "level"
  readonly description: string;  // 显示在 progressive hint 里
  readonly required: boolean;
  readonly captureRemaining?: boolean;  // 捕获剩余所有 token 为一个 value
}

interface StaticEnumArg extends ArgBase {
  readonly kind: "enum";
  readonly choices: readonly ArgChoice[];
}

interface AsyncEnumArg extends ArgBase {
  readonly kind: "async-enum";
  readonly provider: ArgChoiceProvider;  // 一个 SuggestionProvider-like 接口
}

interface FreeTextArg extends ArgBase {
  readonly kind: "text";
  readonly placeholder?: string;
}

interface PathArg extends ArgBase {
  readonly kind: "path";
  readonly onlyDirectories?: boolean;
  /** 相对路径基准。默认 "workspace"（当前生效的工作区根目录） */
  readonly relativeTo?: "workspace" | "cwd";
}

interface ArgChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly tag?: string;
}

interface ArgChoiceProvider {
  list(ctx: ArgQueryContext, signal: AbortSignal): Promise<ArgChoice[]>;
}
```

**为什么要结构化**：
- Hermes 的 `args_hint="[on|off|tts|status]"` 字符串加正则抽取是**双用但脆弱** —— 大写 / Unicode / 特殊字符就崩。
- Claude Code 的 `argNames: string[]` + `argumentHint: string` 分两个字段但**不够结构化** —— progressive hint 是特事特办。
- 知行的 `ArgSchema[]` 让 **progressive hint 自动生成**、**枚举补全统一处理**、**类型校验内建**、**测试可静态验证**。

### 5.3 `SuggestionItem` — 渲染器无关的候选

```typescript
interface SuggestionItem {
  // ── 标识 ──
  readonly id: string;                 // 稳定 id，重渲染时保持选中不跳
  readonly providerId: string;         // 来自哪个 provider

  // ── 显示 ──
  readonly displayText: string;        // 主文本，如 "/elevated"
  readonly description?: string;       // 副文本，右对齐显示
  readonly icon?: string;              // 单字符，provider 定义
  readonly tag?: string;               // 右上角小标签，如 "workflow"
  readonly color?: ThemeColorKey;      // 主题色键

  // ── 行为数据 ──
  readonly acceptPayload: AcceptPayload;

  // ── 可选：加载状态 ──
  readonly loading?: boolean;          // 显示 spinner 而非选中态
}

type ThemeColorKey = "suggestion" | "accent" | "muted" | "warning";

interface AcceptPayload {
  /** 替换当前 trigger token 的文本 */
  readonly replacement: string;
  /** 光标移到 replacement 的哪个 offset */
  readonly cursorOffset?: number;
  /** 选中后是否立即提交 */
  readonly execute: boolean;
  /** 提交时附带的 metadata（给 agent loop） */
  readonly metadata?: Record<string, unknown>;
}
```

**设计要点**：
- **`acceptPayload` 封装所有"选中后做什么"** —— renderer 拿到 item 后直接 `broker.accept(sessionId, item)`，不需要知道 item 是命令还是文件。
- **`execute` 是 per-item 的** —— `/help` 选中直接执行（execute=true），`/model ` 选中只填充（execute=false）等下个参数。
- **`metadata` 让 agent 端拿到结构化信息** —— `@file` 的 item 可以在 metadata 里放 `{ resolvedPath, sha256, size }`，agent loop 可以用。
- **`loading` 状态** —— async provider 在 query 期间可以先返回一条 `loading: true` 的 placeholder，避免空菜单闪烁。

### 5.4 `SuggestionProvider` — 插件式 provider 接口

```typescript
interface SuggestionProvider {
  // ── 标识 ──
  readonly id: string;                   // "command" | "file" | "memory" | ...
  readonly priority: number;             // 数字越小越高优先级（显式排序）

  // ── 触发检测 ──
  /**
   * 检查当前输入是否应该触发本 provider。
   * 基于 cursor 位置，不看整个 draft。
   */
  matchTrigger(ctx: TriggerContext): TriggerMatch | null;

  // ── 候选生成 ──
  /**
   * 查询候选。可能是同步（立即返回）或异步（Promise）。
   * signal 用于取消过期查询。
   */
  query(
    match: TriggerMatch,
    signal: AbortSignal,
  ): SuggestionItem[] | Promise<SuggestionItem[]>;

  // ── 可选：能力声明 ──
  /** 支持 ghost text 的 prefix unambiguous 查找 */
  readonly supportsGhostText?: boolean;

  /** 能力：接受一个 item 后是否可以继续同 provider 的新查询（用于二段 args） */
  readonly supportsChaining?: boolean;
}

interface TriggerContext {
  readonly draft: string;
  readonly cursor: number;              // 光标字符位置（不是字节）
  readonly mode: "prompt" | "bash";
  readonly runtime: RuntimeContext;
}

interface TriggerMatch {
  readonly providerId: string;
  /** trigger token 在 draft 里的起止（字符位置） */
  readonly tokenStart: number;
  readonly tokenEnd: number;
  /** token 本身 */
  readonly token: string;
  /** 用于过滤的 query 部分（通常去掉 trigger char） */
  readonly query: string;
  /** provider 特定的额外上下文 */
  readonly providerData?: unknown;
}
```

**设计要点 vs 三家**：
- **显式 `priority` 字段**：不是像 Claude Code 把优先级塞在 `updateSuggestions` 的代码顺序里。
- **`signal: AbortSignal`**：比 Claude Code 的 `latestBashInputRef.current !== value` 模式清晰、可组合（provider 可以把 signal 再传给 `fetch` / `fs.promises.*`）。
- **`TriggerContext.cursor`** 是字符位置不是字节：CJK 宽字符和 emoji 不会撕裂。
- **`supportsChaining`**：OpenClaw 的两段式 command → args 的通用化 —— provider 可以声明"我接 accept 后还要再起一次 query"。
- **无状态 provider**：每次 query 传入完整 context，provider 自己不持有 per-session 状态。session 状态在 broker 里。

### 5.5 `TypeaheadBroker` — 核心调度器

```typescript
interface TypeaheadBroker {
  // ── provider 注册 ──
  register(provider: SuggestionProvider): Unregister;
  listProviders(): readonly SuggestionProvider[];

  // ── 会话管理 ──
  /** REPL 每次开始新的一轮输入就开一个 session */
  beginSession(initial: TriggerContext): TypeaheadSessionHandle;

  /** 输入变化时调用，broker 重新检测 trigger + 查询 */
  updateInput(
    sessionId: string,
    ctx: TriggerContext,
  ): void;

  /** 用户选中一项 */
  accept(sessionId: string, item: SuggestionItem): AcceptResult;

  /** 用户按 Esc / 清空 */
  cancelSession(sessionId: string): void;

  /** 订阅 session 状态变化 */
  onSessionChange(
    sessionId: string,
    listener: (state: TypeaheadSessionState) => void,
  ): Unsubscribe;

  // ── 观察 ──
  snapshot(): BrokerSnapshot;
}

interface TypeaheadSessionHandle {
  readonly id: string;
  readonly handle: TypeaheadBroker;
}

interface TypeaheadSessionState {
  readonly sessionId: string;
  /** 当前命中的 provider，null 表示无 trigger */
  readonly activeProvider: SuggestionProvider | null;
  readonly trigger: TriggerMatch | null;
  /** 当前候选列表 */
  readonly suggestions: readonly SuggestionItem[];
  /**
   * 选中索引。
   * **不变量**：`suggestions.length > 0 ⇒ selectedIndex >= 0`（永远指向一个有效 item，默认 0）。
   * 仅当 `suggestions.length === 0` 时 `selectedIndex === -1`。
   * 这是「零键执行」原则（§6.5）的核心：用户看到菜单的第一眼就已经有一项被选中，Enter 可直接执行。
   */
  readonly selectedIndex: number;
  /** 是否在 async 查询中 */
  readonly loading: boolean;
  /** 查询是否被 abort（过期） */
  readonly stale: boolean;
  /** 可选：ghost text（prefix-unambiguous match） */
  readonly ghostText: GhostText | null;
  /** 可选：当前选中 item 的参数 hint */
  readonly argumentHint: ArgumentHint | null;
}

interface GhostText {
  /** 追加到 draft 光标后的文本 */
  readonly suffix: string;
  /** 完整的命令/文件名（接受后替换的目标） */
  readonly fullValue: string;
}

interface ArgumentHint {
  /** 当前正在输入的是第几个参数 */
  readonly argIndex: number;
  /** 整个参数列表的 hint 字符串 */
  readonly renderedHint: string;
  /** 当前参数的 schema */
  readonly currentArg: ArgSchema;
}

interface AcceptResult {
  readonly newDraft: string;
  readonly newCursor: number;
  readonly execute: boolean;
  readonly executionHint?: "local" | "agent" | "hybrid";
  readonly metadata?: Record<string, unknown>;
}
```

**行为合约**：

1. **每次 `updateInput` 触发 matchTrigger → query → 更新 session state**：broker 按 priority 升序遍历 providers，第一个 `matchTrigger` 返回非 null 的就命中，其他 providers 被跳过。
2. **Async 查询 abort**：如果一个 provider 的 query 还在跑，`updateInput` 又来了，broker abort 当前 signal 并开新 query。
3. **stale result drop**：query Promise 返回时，broker 检查"签到 token"是否还是当前 token，不是就丢弃结果。`AbortController` + 签到双重防护。
4. **`accept` 产生 `AcceptResult`**：broker 调 provider-specific accept 逻辑（通常就是 `item.acceptPayload`），返回新的 draft / cursor / execute。
5. **`cancelSession` 清空 suggestions + argumentHint + ghostText**，但**不动 draft**。
6. **provider 异常不传染**：query 抛异常 → broker 降级到空 suggestions + 发射 `typeahead:provider-error` 事件，不 throw 到 renderer。
7. **empty query 特殊处理**：trigger 命中但 query 为空（刚打完 `/`），走 `provider.query` 仍然能返回完整列表（每个 provider 自己处理"无 query 时该显示什么"）。

### 5.6 `TypeaheadRenderer` — 渲染器接口

```typescript
interface TypeaheadRenderer {
  readonly name: string;
  readonly capabilities: TypeaheadRendererCapabilities;

  /** 绑定到 broker，开始监听 session 变化 */
  attach(broker: TypeaheadBroker): Unsubscribe;

  /** 手动解绑（会话结束、程序退出） */
  detach(): void;
}

interface TypeaheadRendererCapabilities {
  /** 支持 ghost text 显示（inline，不在 dropdown 里） */
  readonly supportsGhostText: boolean;
  /** 支持 dropdown 菜单 */
  readonly supportsDropdown: boolean;
  /** 支持独立的 argument hint 行（不占 dropdown） */
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
```

**Capabilities 的用途**（和 confirmation-ux.md §5.5 同理）：broker 在构造 `SuggestionItem` 时查 renderer 能力 —— 如果 renderer 不支持 tag 就不设 tag 字段，不支持 ghost text 就不计算 ghostText，节省计算量同时避免渲染时的 feature detection。

### 5.7 `TriggerMatcher` — cursor-aware 触发检测工具

这是 providers 内部使用的 helper，不是 core 导出的接口，但规范化的触发检测模式：

```typescript
// packages/core/src/typeahead/trigger-matcher.ts

/**
 * 从 cursor 位置往前找一个 trigger token。
 *
 * @param draft 完整 draft
 * @param cursor 光标字符位置
 * @param triggerChar 触发字符（"/", "@", "#"...）
 * @param tokenCharClass token 允许的字符类（正则字符类，如 "\\p{L}\\p{N}_-"）
 * @param requireBoundary 是否要求 trigger 前必须是空白或开头
 */
export function findTriggerToken(
  draft: string,
  cursor: number,
  triggerChar: string,
  tokenCharClass: string,
  requireBoundary: boolean,
): TriggerTokenMatch | null;

export interface TriggerTokenMatch {
  readonly tokenStart: number;
  readonly tokenEnd: number;
  readonly token: string;      // 含 triggerChar
  readonly query: string;      // 去掉 triggerChar
}
```

**实现要点**：
- 从 `draft.slice(0, cursor)` 往前扫，**Unicode-safe**（按 grapheme cluster 或至少按 code point 分割）
- Token 字符类用 `\p{L}\p{N}` 而非 `[a-zA-Z0-9]` —— **支持中文命令**
- `requireBoundary` 控制是否允许 mid-input（Phase 1 的 slash 命令 `requireBoundary=true`，Phase 3 支持 false）
- 返回 character offset 不是 byte offset

### 5.8 `CommandRegistry` — 命令单源真相

```typescript
interface CommandRegistry {
  /** 注册一个静态命令（通常在 bootstrap 时调） */
  register(cmd: CommandDef): void;

  /** 注册一个动态命令源（每次 query 时调用，支持热加载） */
  registerDynamicSource(source: DynamicCommandSource): Unregister;

  /** 同步列出所有命令（静态 + 缓存的动态） */
  list(ctx: RuntimeContext): readonly CommandDef[];

  /** 异步刷新动态源（显式触发） */
  refresh(): Promise<void>;

  /** 按 id 查命令 */
  find(id: string): CommandDef | null;

  /** 按 name/alias 查命令（用于执行路径） */
  findByName(name: string): CommandDef | null;

  /** 订阅 registry 变化（命令加入/移除/刷新） */
  onChange(listener: () => void): Unsubscribe;
}

interface DynamicCommandSource {
  readonly id: string;  // "plugin-xxx" / "user-filesystem" / "project-filesystem"
  list(): Promise<readonly CommandDef[]>;
}
```

**设计要点**：
- **静态注册 + 动态源两类**：静态是代码 literal，动态是 plugin / filesystem / MCP —— 分开注册，各自生命周期。
- **`onChange` 事件**：broker 订阅后重建 FuzzyIndex 缓存。抄 Claude Code 的"按引用身份缓存"，但事件更显式。
- **`find` vs `findByName`**：`find` 按稳定 id（用于 accept 后查回 def），`findByName` 按 name/alias（用于执行路径的命名解析）。

**2026-04-16 refinement：静态命令的真正所有者是 REPL 不是 core**：

初版设计让 `@zhixing/core/typeahead/builtin-commands.ts` 持有一个"理想化的"内建命令清单（`/new /clear /help /status /model /elevated /fast /verbose /history /debug /exit`），REPL 调 `registerBuiltinCommands(registry)` 一次性注册全部。Phase 1 Step 5 实测暴露三个问题：

1. **幽灵命令**：core 清单里有 `/elevated /fast /verbose` 等尚未在 REPL 实现 handler 的命令，用户能在 panel 看到但执行时"未知命令"
2. **设计集与实际集的二元分裂**：core 的 builtin-commands.ts 和 REPL 的 `buildSlashCommands()` 不重合 —— core 里有 `/elevated` 但 REPL 没有，REPL 里有 `/skills /journal /trust` 但 core 没有
3. **handler 归属模糊**：命令在 core 里定义，handler 在 CLI 里实现，绑定关系靠"id 字符串精确匹配"维护，容易漂移

**新约定**：
- `@zhixing/core/typeahead/builtin-commands.ts` **降级为"命令目录范例"**，只供测试和设计参考使用，**不再作为 REPL 运行时的注册源**
- REPL 在 bootstrap 时持有一张**本地 `REPL_COMMANDS` 表**（见 `packages/cli/src/repl.ts`），每一行同时定义 `{ name, aliases, description, category, execution, legacyKey }`，循环注册到 registry 并绑定 handler
- 好处：zero 幽灵命令（每一条都有可执行 handler）、单一增删点（表里加一行就行）、CLI 独立演进不受 core 限制
- Plugin / 动态 source 不受影响，仍走 `registerDynamicSource` 路径 —— 这条设计没变

### 5.9 `TypeaheadEventBus` 事件

```typescript
type TypeaheadEventType =
  | "typeahead:session-started"
  | "typeahead:trigger-detected"
  | "typeahead:trigger-cleared"
  | "typeahead:query-started"
  | "typeahead:query-completed"
  | "typeahead:query-aborted"
  | "typeahead:provider-error"
  | "typeahead:suggestion-accepted"
  | "typeahead:session-ended";

interface TypeaheadEvent {
  readonly type: TypeaheadEventType;
  readonly sessionId: string;
  readonly providerId?: string;
  readonly triggerToken?: string;
  readonly queryMs?: number;
  readonly suggestionCount?: number;
  readonly selectedItem?: { id: string; providerId: string };
  readonly error?: { name: string; message: string };
  readonly timestamp: number;
}
```

和 confirmation-ux.md §8.3 同构 —— 所有决策都进 EventBus，用于：
- 审计（"用户今天用了哪些命令"）
- 性能分析（"哪个 provider query 慢"）
- UX 优化（"哪些命令被打开但没被选中" —— 名字可能误导）
- 未来的 Smart LLM 分诊（Phase 4+ 可以让 LLM 根据历史选项重排序）

---

## 六、过滤与排序算法

### 6.1 Fuzzy 引擎选型

**选择**：**Fuse.js**（沿用 Claude Code 的选择）。

**理由**：
1. 零 native 依赖，纯 JS，和知行无额外 build 负担
2. 加权多字段匹配 —— 比 RapidFuzz / Levenshtein 更适合"name + alias + description 混合匹配"的场景
3. 社区验证 —— Claude Code 用了多年
4. threshold / location / distance 三参数足够调教

**配置**（`packages/core/src/typeahead/fuzzy-index.ts`）：

```typescript
new Fuse(indexItems, {
  includeScore: true,
  threshold: 0.35,     // 比 Claude Code 的 0.3 稍宽，允许更多 fuzzy
  location: 0,
  distance: 100,
  keys: [
    { name: "name",        weight: 4 },   // 比 Claude Code 高一档
    { name: "aliases",     weight: 3 },
    { name: "nameParts",   weight: 2 },   // 按 [:_-] split 的词
    { name: "description", weight: 0.3 }, // 更低：知行的命令命名要自解释
  ],
});
```

**为什么比 Claude Code 严格一些**：知行的命令命名原则是"自解释" —— `new` 就叫 `new`，不叫 `start-new-session`。description 搜索的价值相对低，权重降到 0.3。

### 6.2 自定义 Resort（抄 Claude Code）

Fuse 返回后**必须 re-sort**，按以下优先级：

```
1. 精确 name match (highest)
2. 精确 alias match
3. Prefix name match        — 短名字优先（"new" > "new-project"）
4. Prefix alias match       — 短 alias 优先
5. Fuse score
6. MRU usage score (tiebreaker)
```

**实现位置**：`packages/core/src/typeahead/sort.ts`，**纯函数**，测试覆盖每一条规则。

### 6.3 空 query 的分类 + MRU

当用户刚按 `/`、query 为空时：

```
  [最近使用 top 5 — 跨所有类别，按 MRU 降序]
    ↓
  session (/new /reset /history /save)
    ↓
  config  (/model /elevated /verbose /fast)
    ↓
  info    (/status /help /profile)
    ↓
  tools   (/skill /mcp)
    ↓
  plugin  (动态注册的)
    ↓
  hidden  (不显示，除非精确名字打出来)
```

**每组内按 name 字母排序**（稳定）。**MRU 跨组** —— 你最近用 `/elevated` 三次，它就出现在最顶而不是 config 组里。

**去重**：MRU 里出现过的就不在下面的组里重复出现（和 Claude Code 一致）。

### 6.4 MRU 评分：有界 Frecency（bounded frecency）

知行的 usage tracking 放在 **`packages/core/src/typeahead/usage-tracker.ts`**，不在 CLI 里（Claude Code 的反例 —— 它把 skill usage 放在 React state 里，换 UI 就丢）。

**关键决策：不是"无限累加的 count × 时间衰减"，而是有界 frecency**。score 本身是有界的、自衰减的、幂等的；不存累加计数器。

#### 6.4.1 为什么不用 naive count

一个初版设计可能是 `{ count, lastUsedAt }` + 公式 `score = count × exp(-ageHours / 168)`。这看似合理，但有三个会在上线后才暴露的陷阱：

1. **历史明星霸榜**：用户脚本化调用 `/model` 1000 次做配置迁移之后，其 count=1000 的积累会让任何新命令**永远追不上**。即使 `/model` 已经很久没用，`1000 × 0.87 ≈ 870` 依然碾压新命令的个位数 score。
2. **无界增长**：一年后 `/new` 可能 count=5000。文件大小没问题（JS Number 到 2^53 都安全），但**概念上不干净** —— 系统"有记忆无遗忘"，用户永远摆脱不了刚上手时疯狂试用的命令。
3. **新旧权重失衡**：新命令要被用 100+ 次才能挑战老命令 —— 这不是 "Most Recently Used"，是 "cumulative popularity contest"。

时间衰减只能缓解 (1) 的极端情况，不能解决本质。真正的解法是**把 score 本身做成有界的**。

#### 6.4.2 EMA 形式的 bounded score

```typescript
const HALF_LIFE_HOURS = 168;    // 7 天半衰期
const MAX_SCORE = 32;           // 饱和上限
const GC_THRESHOLD = 0.01;      // 低于此值的 entry 写入时自动清除

interface UsageEntry {
  readonly score: number;       // 已应用衰减后的 score，∈ [0, MAX_SCORE]
  readonly lastUsedAt: number;  // 上次衰减计算的时间戳（epoch ms）
}

function onUse(prev: UsageEntry | undefined, now: number): UsageEntry {
  const current = prev ?? { score: 0, lastUsedAt: now };
  // 1. 先把旧 score 衰减到当前时间
  const ageHours = Math.max(0, (now - current.lastUsedAt) / 3600_000);  // clock skew defense
  const decayed = current.score * Math.exp(-ageHours * Math.LN2 / HALF_LIFE_HOURS);
  // 2. +1 代表这次使用
  // 3. 卡上限
  return {
    score: Math.min(decayed + 1, MAX_SCORE),
    lastUsedAt: now,
  };
}

function currentScore(entry: UsageEntry | undefined, now: number): number {
  if (!entry) return 0;
  // 懒衰减：读取时再应用一次时间衰减，不修改磁盘
  const ageHours = Math.max(0, (now - entry.lastUsedAt) / 3600_000);
  return entry.score * Math.exp(-ageHours * Math.LN2 / HALF_LIFE_HOURS);
}
```

**形式解读**：这是**指数加权移动平均**（EMA）的变体。每次使用 = "先把旧 score 按时间衰减，再 +1，再卡到上限"。读取时再做一次懒衰减。score 本身不是累加器，而是一个**自我稳态的滑动量**。

#### 6.4.3 有界性证明

稳态假设：每 T 小时使用一次，衰减因子 `β = 2^(-T / 168)`。稳态 score 满足不动点方程 `s* = β·s* + 1`，即 `s* = 1 / (1 - β)`。

| 使用频率 | 理论稳态 | 被 MAX_SCORE=32 卡住？ |
|---|---|---|
| 每 10 分钟一次 | ≈ 1454 | ✅ → 32 |
| 每小时一次 | ≈ 243 | ✅ → 32 |
| 每 3 小时一次 | ≈ 81 | ✅ → 32 |
| **每天一次** | **≈ 10.5** | ❌ 真实值 |
| 每 3 天一次 | ≈ 3.4 | ❌ 真实值 |
| 每周一次 | ≈ 2.0 | ❌ 真实值 |
| 每月一次 | ≈ 0.26 | ❌ 接近 GC |

**结论**：无论多频繁使用，score 的理论上限严格 ≤ 32。文件大小、排序稳定性、数值溢出都**被数学保证**。

#### 6.4.4 行为曲线（典型场景）

| 场景 | 当前 score | 30 天后 | 60 天后 | 90 天后 |
|---|---|---|---|---|
| 之前满分 32，之后完全不用 | 32 | ~1.65 | ~0.085 | **被 GC** |
| 每天用一次的稳态 | ~10.5 | ~10.5 | ~10.5 | ~10.5 |
| 每周用一次的稳态 | ~2.0 | ~2.0 | ~2.0 | ~2.0 |
| 今天开始用的新命令，每天一次 | 1.0 | ~9.3（爬升中） | ~10.4 | ~10.5（到稳态） |

**语义承诺**：
- **30 天不碰** → score 从满分跌到 1.65，基本退出 top 5，但还在列表里（有心的用户能找回来）
- **90 天不碰** → score < 0.01，被**自动 GC**，从 usage.json 里移除，节省文件空间
- **新命令每天用** → 3 周内追到 10.5 稳态，6 周内可以和老的 daily driver 持平
- **脚本化突发**：连续调用 1000 次 `/model`，score 从 0 爬到 32 就卡住，不会无限上升污染未来

这才是真正的 MRU，而不是 cumulative popularity。

#### 6.4.5 数据格式 v2（破坏性升级）

```json
{
  "version": 2,
  "commands": {
    "elevated:builtin":  { "score": 18.3,  "lastUsedAt": 1713138000000 },
    "model:builtin":     { "score": 8.2,   "lastUsedAt": 1713100000000 }
  }
}
```

**从 v1 迁移**（若曾经有 v1 部署）：读到 `{ count, lastUsedAt }` 形状时，`score = Math.min(count, MAX_SCORE)`，接着走正常的懒衰减路径。迁移是单向的 —— 旧的 raw count 信息会丢失，但 v1 从未真正上线（spec 更新在实现之前），实际上不会有存量数据。

#### 6.4.6 接口

```typescript
interface UsageTracker {
  /**
   * 写入一次使用事件。内部自动：
   *   1. 懒衰减旧 score
   *   2. +1
   *   3. 卡 MAX_SCORE 上限
   *   4. 顺路 GC 所有 score < GC_THRESHOLD 的 entry
   *   5. 标记 dirty，等 debounced flush
   */
  recordUsage(commandId: string): void;

  /** 读取当前有效 score（已应用懒衰减，不修改磁盘） */
  getScore(commandId: string): number;

  /** 取 top N，按 getScore 降序；N ≤ 实际有效 entry 数量 */
  topN(n: number): Array<{ commandId: string; score: number }>;

  /** 手动触发 GC + flush（通常 recordUsage 时自动跑，测试或程序退出时显式调） */
  prune(): number;  // 返回被清除的 entry 数
}
```

#### 6.4.7 边界条件

- **Clock skew**：`now < lastUsedAt` 时（系统时钟被改、NTP 回调）`age = max(0, ...)` 兜底，衰减因子 = 1，score 不会异常上升
- **首次使用**：无 entry → 新建，score = 1
- **同毫秒内连续 use**：ageHours=0，衰减因子=1，`decayed + 1 = prev.score + 1`，正常递增
- **文件损坏 / 格式错误**：日志 warning + 重置为空 usage.json，不让坏文件阻塞 REPL 启动
- **多进程并发写**（两个 REPL 同时开）：flush 用原子 `rename` 模式（先写 `.tmp` 后 `rename`），last-write-wins 可接受 —— usage 数据不是强一致要求，丢几次事件不影响可用性
- **版本号不认识**（未来 v3 spec 出来前用了旧 CLI 读）：降级到空文件 + warning，不 crash

#### 6.4.8 GC 策略

GC 发生在两个时机：

1. **`recordUsage` 的内联 GC**：每次写入都顺路遍历一次 commands 表，清除 `currentScore(entry) < GC_THRESHOLD` 的条目。O(N) per write，N ≤ 100 可忽略。
2. **显式 `prune()`**：测试 / 手动 / 程序退出时调用。返回清除数量用于日志。

**没有后台定时清理** —— 所有 GC 都是同步的、可预测的、可测试的。

#### 6.4.9 批量写盘

debounced 5 秒 flush，避免每次命令都同步写磁盘。程序退出时 flush 一次。内存里 score 实时更新，磁盘最多 5 秒滞后 —— 崩溃时丢 5 秒数据可接受（MRU 不是强一致性数据）。

#### 6.4.10 性能预算

| 操作 | 复杂度 | 实测预期 |
|---|---|---|
| `recordUsage` | O(N) GC + 内存写 | < 0.1ms |
| `getScore` | O(1) | < 0.01ms |
| `topN(5)` | O(N log N) | < 0.5ms，N ≤ 100 |
| JSON 磁盘读 | O(file_size) | ~1ms（~1 KB 文件）|
| JSON 磁盘写 | O(file_size) + atomic rename | ~5ms |

所有操作远低于 100ms 人类感知阈值，不会成为按键响应的瓶颈。

---

### 6.5 零键执行（Zero-keystroke-to-run）原则

这是知行补全系统的**最高 UX 指令**，贯穿所有 provider 和渲染器：**用户看到候选列表的第一眼，就已经有一项被选中，可以直接 Enter 执行**。不需要先按一次 ↓ 把光标从 "无选中" 移到第一项。

#### 6.5.1 两个典型场景

**场景 A：空 query，MRU 预测**

```
用户按 /                                 ← 仅一个斜杠
   ↓
CommandProvider.matchTrigger 命中（query="",  tokenStart=0, tokenEnd=1）
   ↓
CommandProvider.query 返回 MRU 排序的列表：
   [
     { id: "elevated:builtin",   ... },   ← 最近用过 42 次
     { id: "model:builtin",      ... },   ← 最近用过 15 次
     { id: "new:builtin",        ... },
     { id: "help:builtin",       ... },
     { id: "status:builtin",     ... },
     ... (分类组)
   ]
   ↓
broker 设 session.selectedIndex = 0      ← 关键不变量
   ↓
面板渲染：
   ┌─ Commands · 23 · MRU ────────────┐
   │  ❯  /elevated   Set elevated level│  ← 已选中
   │     /model      Set model          │
   │     /new        Start fresh session│
   │     ...                            │
   └────────────────────────────────────┘
   ↓
用户按 Enter                              ← 零次方向键
   ↓
broker.accept(items[0]) → /elevated 执行
```

**场景 B：部分 query，best match 置顶**

```
用户输入 /r                               ← "/r"
   ↓
CommandProvider.matchTrigger 命中（query="r"）
   ↓
CommandProvider.query 走 FuzzyIndex + §6.2 自定义 resort：
   [
     { id: "reset:builtin",    ... },     ← 精确 prefix "r"（"reset" 5 字符）
     { id: "retry:builtin",    ... },     ← 精确 prefix "r"（"retry" 5 字符，name 字母序 tiebreaker）
     { id: "resume:builtin",   ... },     ← 精确 prefix "r"（"resume" 6 字符）
     { id: "rollback:builtin", ... },     ← 精确 prefix "r"
     { id: "reasoning:builtin",... },     ← 精确 prefix "r"
     { id: "verbose:builtin",  ... },     ← fuzzy，含 "r" 但不是 prefix
   ]
   ↓
broker 设 session.selectedIndex = 0      ← 第一项就是最佳匹配
   ↓
面板渲染：
   ┌─ Commands · 6 matches ───────────┐
   │  ❯  /reset     Start a new session│  ← 已选中
   │     /retry     Retry last message │
   │     /resume    Resume a session   │
   │     ...                            │
   └────────────────────────────────────┘
   ↓
用户按 Enter                              ← 零次方向键
   ↓
broker.accept(items[0]) → /reset 执行
```

两个场景都符合同一个 UX 不变量：**最有可能是用户想要的那一项永远在 `selectedIndex === 0`**。

#### 6.5.2 不变量的三条落地约束

```
UX 不变量: suggestions.length > 0 ⇒ selectedIndex === 0  (初次渲染)
                                ⇒ selectedIndex ∈ [0, len)  (用户导航后)
```

落地到实现的三条硬约束：

1. **CommandProvider.query 保证输出顺序即推荐顺序**
   - 非空 query：§6.2 的自定义 resort 已经把"精确 > prefix > fuzzy > MRU tiebreaker"排好 → 索引 0 就是最佳匹配
   - 空 query：§6.3 的"MRU top 5 → 分类组"排好 → 索引 0 就是最常用
   - **Provider 内部绝对不返回未排序的结果**，把"谁排第一"的决策握在 provider 手里而不是 renderer 手里

2. **Broker 设置 `selectedIndex` 的时机**
   - 每次 `query` 返回新结果且 `suggestions.length > 0`：**无条件重置到 0**
   - 每次 `query` 返回空：设为 -1
   - 用户按 ↑↓ 导航：只改 selectedIndex，不重新 query
   - 用户继续打字 → `updateInput` 触发新 query → 新结果 → **再次无条件重置到 0**
   - 这条规则保证"用户打字时最佳匹配始终在顶"，即使他之前按过 ↓ 手动选了第 3 项

3. **Renderer 的 Enter 处理走统一路径**
   - `selectedIndex >= 0`：`broker.accept(items[selectedIndex])`（无论用户是否动过方向键）
   - `selectedIndex === -1`：按普通 draft 提交走 agent loop（没有 suggestions 就没有 guard）
   - **没有"未选状态"这个中间态**：要么有选中要么没 suggestions

4. **`moveSelection` 是 clamp 而非 circular**（2026-04-16 确立）

   `broker.moveSelection(sessionId, delta)` 用 `Math.max(0, Math.min(selectedIndex + delta, len - 1))` 计算新索引，**末尾 ↓ 和首项 ↑ 都是 no-op**，不触发 listener、不改 state。

   **Why**：循环导航会让窗口从 `[last-maxVisible, last]` 跳到 `[0, maxVisible]`，整个可见列表瞬间翻转 —— 用户按一次 ↓ 看到的不是"下一项"而是"完全不同的一个列表"，视觉上极其突兀。这条语义和 VSCode / Sublime / 主流 IDE 的 typeahead 一致，符合"滚到头就到头"的物理直觉。副作用是失去"末尾快速跳首项"的快捷键 —— 对 typeahead 而言可接受，用户可以 Esc + 重打 query 快速重定位。

   **真实 bug 来源**：Phase 1 Step 5 初版用了循环导航（`((idx + delta) % len + len) % len`），手动验收时用户反馈"滚到最后一条再按 ↓ 整个列表突然变了"—— 这是强信号表明循环语义不符合直觉。

#### 6.5.3 Enter 行为决策表

| 前置状态 | Enter 语义 | 依据 |
|---|---|---|
| 无 suggestions（`selectedIndex === -1`） | 普通提交 draft 到 agent loop | 没有 typeahead 参与 |
| 有 suggestions + 当前选中项 `execute === true` | 执行该项（accept 并 submit） | 场景 A / B |
| 有 suggestions + 当前选中项 `execute === false` | 填充 draft，`selectedIndex` 保留，不 submit | 等用户继续输入参数（§9.3） |
| 有 suggestions + 当前选中项是命令 + 命令有必填参数 | `execute=false` 路径，进入 argument 态 | `ArgumentProvider` 接管后续 |
| 有 suggestions + 但用户正在补 argument 的自由文本（非 enum） | Enter 提交整条 draft 到执行路径 | 不能被 dropdown 吞掉 |

**关键**：零键执行不是"所有 Enter 都执行"，而是"第一项总是被选中、用户不用按方向键"。执行 vs 填充 的分派由 `acceptPayload.execute` 决定，不由 Enter 决定。

#### 6.5.4 和三家竞品的对比

| 场景 | OpenClaw Web | Hermes | Claude Code | **知行** |
|---|---|---|---|---|
| 空 `/` 按 Enter | 光标在 index 0 但 handleKeyDown 的 Enter 走 `selectSlashCommand` | prompt_toolkit 默认可能需要先 Tab/↓ 激活菜单 | 已实现（selectedIndex 从 0 开始） | ✅ §6.5 |
| `/r` 按 Enter | 同上 | 同上，且无 fuzzy 所以"最佳"不一定在顶 | 已实现 + Fuse resort 保证 best 在顶 | ✅ §6.5 + Fuse resort + MRU tiebreaker |
| MRU 影响空 query 顺序 | ❌ | ❌ | ✅ skill usage score | ✅ core 持久化 |
| 打字时重置选中到 0 | ✅ | prompt_toolkit 默认 | ✅ | ✅ 显式不变量 |

---

## 七、TTY 渲染器设计

### 7.1 和 `SelectWithInput` 的关系

`SelectWithInput`（[packages/cli/src/tui/select-with-input.ts](../../../packages/cli/src/tui/select-with-input.ts)，579 行）在 Phase 1 of confirmation-ux 已经交付，含 §6.4 的 cursor 不变量 + stdin 独占护栏两个关键修复。

**但 `SelectWithInput` 是一次性组件** —— 进入 → 收决定 → 退出。Typeahead 不一样：**常驻在 REPL prompt 下方，跟随 draft 变化持续重绘**。

**复用策略**：**提取内核，不继承**。

```
packages/cli/src/tui/
├── select-with-input.ts          (已存在，confirmation 专用)
├── typeahead-panel.ts             (新增，常驻组件)
├── _internal/
│   ├── raw-mode.ts                (抽取：raw mode 引用计数)
│   ├── stdin-ownership.ts         (抽取：§6.4 陷阱 3 的 keypress snapshot/restore)
│   ├── cursor-invariants.ts       (抽取：§6.4 的 rerender cursor 不变量)
│   ├── panel-layout.ts            (抽取：宽度自适应 + wcwidth)
│   └── ansi.ts                    (已存在)
```

**先 extract，后 reuse**：Phase 1 Step 1 就做内核抽取，把 `SelectWithInput` 里这些共通片段挪到 `_internal/`，然后 `SelectWithInput` 和 `TypeaheadPanel` 都引用它们。这样 **§6.4 的两类护栏测试对两个组件都生效**。

### 7.2 `TypeaheadPanel` 生命周期

和 `SelectWithInput` 不同，`TypeaheadPanel` 的 lifecycle 是**被动跟随 REPL 输入**：

```
REPL 进入 prompt 模式
       │
       ▼
  TypeaheadPanel.attach(broker, inputBuffer)
       │
       │ 订阅 broker.onSessionChange(sessionId)
       │ 订阅 inputBuffer.onChange
       ▼
  ┌───────────────────────────────────────┐
  │  inactive state (无 trigger)           │  ◀── renderer 不占行，不重绘
  │                                       │
  │  user 打字                             │
  │  → inputBuffer.onChange                │
  │  → broker.updateInput(ctx)             │
  │  → trigger 检测                         │
  ├───────────────────────────────────────┤
  │  trigger 命中                          │
  │  → broker 开 query（可能 async）       │
  │  → renderer 进入 active state          │
  │  → render 面板（在 prompt 行下方）     │
  │                                       │
  │  user ↑↓ 导航                          │
  │  → renderer 更新 selectedIndex         │
  │  → broker 不重新 query                 │
  │                                       │
  │  user 继续打字                          │
  │  → inputBuffer.onChange                │
  │  → broker.updateInput(ctx)             │
  │  → query 更新                           │
  │  → renderer 重绘（§6.4 cursor 不变量）  │
  ├───────────────────────────────────────┤
  │  user Tab / Enter                      │
  │  → broker.accept(item)                 │
  │  → AcceptResult 回到 inputBuffer       │
  │  → 若 execute=true 触发 REPL submit    │
  │  → 否则 inactive state                 │
  ├───────────────────────────────────────┤
  │  user Esc                              │
  │  → broker.cancelSession                 │
  │  → inactive state                      │
  └───────────────────────────────────────┘
  REPL 退出 prompt 模式
       │
       ▼
  TypeaheadPanel.detach()
```

**关键细节**：
- **inactive 态不占行**：renderer 知道自己当前是否有 active session，没有就**完全不输出任何字符**（不 clear line、不移 cursor）
- **active → inactive 的 transition 要清干净**：之前渲染的 N 行必须被擦除，否则会有 ghost rows —— §6.4 cursor 不变量的 rerender 路径已处理
- **光标永远停在输入行**：即使 suggestions 面板在下方，光标必须回到 prompt 行的正确列。`TypeaheadPanel` 渲染完后走 `saveCursor / restoreCursor`（ANSI `\x1b[s` / `\x1b[u`）或显式算 row delta
- **Draft 是 buffer 拥有，不是 panel 拥有**：panel 只读 buffer，不写。Accept 时 panel 调 `broker.accept` 拿 `AcceptResult`，再调 `inputBuffer.applyResult(result)`。

### 7.3 面板布局（示例：slash command）

```
> /ele_                                                           ← prompt 行（光标在 _）
┌─ Commands · 3 matches ─────────────────────────────────┐
│  ❯  /elevated                    Set elevated level     │  ← 选中项
│     /elev                        Alias for /elevated    │
│     /element                     Show UI elements       │
│                                                          │
│  ↑↓ select · Enter run · Tab fill · Esc cancel          │
└──────────────────────────────────────────────────────────┘
```

**布局要素**：

1. **标题行**：`Commands · N matches` —— 显示 provider 类型 + 结果数。多 provider 候选混合时显示"Mixed · N matches"
2. **内容行**：
   - `❯` 选中标记（单字符，无选中时不占位）
   - `displayText` 左对齐
   - `description` 右对齐，截断到 `maxDescriptionWidth`
   - `tag`（如 `[workflow]`）在 description 左边
   - `icon` 在 displayText 左边
3. **滚动窗口**（2026-04-16 refined）：`maxVisibleItems = 12`（初版 8，手动验收后调大：内建 17 条命令大部分能一屏显示），选中项居中。**恒定高度原则**：当 `total > maxVisibleItems`（可滚动时），面板恒定预留 2 个指示行 slot（top + bottom），内容随位置变化但**行数不变**，消除面板高度抖动。
   - 可上滚时 top slot 显示 `↑ 上方还有 N 条`（量化剩余）；到顶时显示 `──── 顶部 ────`（边界标记）
   - 可下滚时 bottom slot 显示 `↓ 下方还有 N 条`；到底时显示 `──── 到底啦 ────`
   - 不可滚动时（`total ≤ maxVisibleItems`）完全不预留 slot（不浪费行）
   - 此设计源自 Phase 1 Step 4 手动验收的真实抖动 bug：初版"有则渲染、无则省略"导致选中项从顶部→中部→底部时面板总高在 `N+1 ↔ N+2` 之间跳变
4. **底部快捷键条**：根据当前 session 动态变化（有 suggestions 时显示完整；无时不显示）

### 7.4 Ghost Text 渲染

**Ghost text 是 inline 的，不占单独行**：

```
> /upd_ate                                                       ← _ate 是 dim color ghost
```

实现要点：
- Ghost text = `session.ghostText.suffix`，dim 色（ANSI `\x1b[2m`）
- 和 dropdown **同时存在**：用户打 `/upd` 时，ghost 显示 `ate`（来自首个 prefix match `/update`），同时 dropdown 可能列出 `/update`、`/update-all`、`/update-config` 等。Tab 接受 ghost（最近的），Enter 接受选中项（dropdown）
- **只对 prefix unambiguous 匹配显示**：如果前两个 suggestion 的 displayText 在 query 之后分叉，不显示 ghost（会误导）
- **Ghost 追加后光标移到 ghost 尾**，按任意非 Tab 键（backspace 除外）都会清掉 ghost

### 7.5 Argument Hint 渲染

**Argument hint 是独立于 dropdown 的一行**：

```
> /model claude_                                                  ← prompt 行
  [level: claude-sonnet-4-6 | claude-opus-4-6 | claude-haiku-4-5] ← hint 行（dim）
```

用于：
- 用户刚选完 `/model` 后，dropdown 关闭，hint 行亮起显示"该命令下一个参数是什么"
- 有 `async-enum` 参数时，hint 行显示"querying..."，同时下方 dropdown 可能打开（显示可选值）
- `free-text` 参数时，hint 行显示 placeholder

**Progressive hint**（抄 Claude Code）：多参数命令 `/add-dir <path> <depth>` 根据已输入的参数个数显示下一个：

```
> /add-dir src/ _
  [depth: number (optional, default: 3)]
```

### 7.6 和 Confirmation 的 Raw Mode 共存

问题：confirmation 弹出时（`secure-executor` 等审批），REPL 可能正处于 typeahead 的 active state。谁优先？

**解法**（参考 confirmation-ux.md §6.2 的 raw mode 引用计数）：

1. **Raw mode 是引用计数的**（`packages/cli/src/tui/_internal/raw-mode.ts`），多个消费者同时 hold 不互相关掉
2. **Stdin ownership 是栈式的**：
   - typeahead 进入 active state → push keypress interceptor
   - confirmation 弹出 → push keypress interceptor on top（typeahead 自动让出）
   - confirmation 结束 → pop → typeahead 恢复
3. **典型 flow**：
   - 用户打 `/elev` 进入 typeahead
   - Agent 正在跑 `bash` 工具，触发 confirmation
   - confirmation 面板弹出在 typeahead panel 下方（或覆盖，取决于布局策略）
   - 用户决定 confirmation 后，typeahead 面板状态保留（draft、cursor、suggestions 都还在），继续可用

这个 pattern 的前提是 **§6.4 的 stdin 独占护栏** —— `TypeaheadPanel.attach()` 时 snapshot keypress listeners，`detach()` 时按原序恢复。confirmation 同理。

---

## 八、多触发前缀的 Provider 系统

### 8.1 内建 providers 清单

| Provider | id | priority | trigger | 同步/异步 | Phase |
|---|---|---|---|---|---|
| CommandProvider | `command` | 100 | `/` 开头 | sync | 1 |
| ArgumentProvider | `argument` | 90 | 当前处于某命令的参数位置 | sync + async | 2 |
| FileProvider | `file` | 200 | `@file:path` 或裸 `@path` | async (fs) | 2 |
| FolderProvider | `folder` | 210 | `@folder:path` | async (fs) | 2 |
| MemoryProvider | `memory` | 300 | `@memory:key` | sync | 3 |
| ToolProvider | `tool` | 310 | `@tool:name` | sync | 3 |
| McpResourceProvider | `mcp` | 320 | `@mcp:server/resource` | async (rpc) | 3 |
| HistoryProvider | `history` | 500 | ghost text 回退 | sync | 2 |

**Priority 数值越小优先级越高** —— Argument 比 Command 高，因为"选完 /model 正在输入参数"应该优先 argument 逻辑。

### 8.2 Provider 注册与优先级

**静态注册**（bootstrap 时）：

```typescript
// packages/cli/src/repl-bootstrap.ts
const broker = new DefaultTypeaheadBroker({ commandRegistry, usageTracker });

broker.register(new CommandProvider({ registry: commandRegistry }));
broker.register(new ArgumentProvider({ registry: commandRegistry }));
// FileProvider 的搜索根基于「当前生效的工作区」，不是 process.cwd()。
// 工作区经过四级解析（CLI --workspace > 项目配置 > 全局配置 > cwd fallback），
// 由 resolveWorkspace() 决定，和安全系统的信任边界保持一致。
broker.register(new FileProvider({ root: agentSession.resolvedWorkspace.path ?? process.cwd() }));
// ...
```

**动态注册**（插件）：

```typescript
// packages/plugin-sdk/src/register.ts
export function registerTypeaheadProvider(provider: SuggestionProvider): Disposable {
  return broker.register(provider);
}
```

**Priority 冲突解决**：同 priority 时**按注册顺序**（先注册先检查）。插件 API 要求 provider 显式传 `priority`，不允许省略 —— 强制作者想清楚。

### 8.3 异步取消与 stale 结果

**AbortController 是 first-class**：

```typescript
class DefaultTypeaheadBroker {
  private currentAbort: AbortController | null = null;

  updateInput(sessionId: string, ctx: TriggerContext): void {
    // 1. Abort 前一次 query
    this.currentAbort?.abort();
    this.currentAbort = new AbortController();
    const abort = this.currentAbort;

    // 2. 检测 trigger
    const match = this.detectTrigger(ctx);
    if (!match) {
      this.emitSessionChange({ suggestions: [], loading: false, ... });
      return;
    }

    // 3. 启动 query
    this.emitSessionChange({ loading: true, trigger: match, ... });
    const queryPromise = Promise.resolve(match.provider.query(match, abort.signal));

    queryPromise.then(
      (items) => {
        // 4. Stale check：如果这个 abort 已经被换掉了，丢弃
        if (abort !== this.currentAbort) return;
        // 5. 更新 state
        this.emitSessionChange({ suggestions: items, loading: false, ... });
      },
      (err) => {
        if (abort.signal.aborted) return;  // 正常取消
        this.handleProviderError(err, match.provider);
      },
    );
  }
}
```

**为什么 AbortController + 双重检查**：
- `AbortController` 给 provider 一个清晰的取消钩子（`fetch(url, { signal })` / `fs.promises.stat(path, { signal })` 都接受 signal）
- `abort !== this.currentAbort` 检查解决"provider 不理 signal 也能保证不污染 state"的兜底 —— 即使 provider 是同步伪 async（比如返回一个 Promise 但内部不查 signal），broker 也能丢掉过期结果

### 8.4 Plugin Provider API

**约束**：
1. Plugin provider 必须有 `id`（唯一 namespace，建议 `plugin:xxx`）
2. `priority` 必须在 400-999 之间（保留 1-399 给内建）
3. `query` 超时 3 秒自动 abort（broker 强制）
4. 异常时 provider 被**自动禁用**直到下次 REPL 重启（熔断）

**熔断机制**：连续 3 次 query 抛异常 → broker 把 provider 移到 `_disabled` 列表 → EventBus 发 `typeahead:provider-disabled` 事件 → 面板显示"Provider X disabled due to errors"。

---

## 九、与现有系统集成

### 9.1 REPL 接入点

**当前**（推测，基于 confirmation-ux 里 `secure-executor` 的描述）：

```typescript
// packages/cli/src/repl.ts
const line = await readline.question("> ");
await agentLoop.processInput(line);
```

**目标**：

```typescript
// packages/cli/src/repl.ts
const inputBuffer = new InputBuffer();
const session = broker.beginSession(inputBuffer.getTriggerContext());

const panel = new TypeaheadPanel({ broker, inputBuffer });
panel.attach();

while (true) {
  const result = await inputBuffer.waitForSubmit();  // user pressed Enter

  if (result.kind === "typeahead-accepted") {
    // 已经通过 broker.accept() 路径走了，result.executionHint 指导分派
    await dispatchAccepted(result);
  } else {
    // 普通文本提交
    await agentLoop.processInput(result.text);
  }
}

panel.detach();
```

**InputBuffer** 是新的抽象：持有 draft + cursor + 历史 + submit 事件。内部调用 `broker.updateInput(ctx)` 每次 draft 变化。和 readline 平行。

### 9.2 Slash Command 执行：local / agent / hybrid

```typescript
async function dispatchAccepted(result: AcceptResult): Promise<void> {
  const execution = result.executionHint ?? "agent";

  switch (execution) {
    case "local": {
      // 纯本地：不产生 agent turn，不消耗 token
      const cmd = commandRegistry.findByName(parseCommandName(result.newDraft));
      await cmd.handler({ args: parseArgs(result.newDraft), repl, session });
      break;
    }

    case "agent": {
      // 纯 agent：整条 draft 作为 user message 送进 agent loop
      await agentLoop.processInput(result.newDraft);
      break;
    }

    case "hybrid": {
      // 先本地副作用，再通知 agent
      const cmd = commandRegistry.findByName(parseCommandName(result.newDraft));
      const localEffect = await cmd.handler({ args: parseArgs(result.newDraft), repl, session });
      // localEffect 包含要作为 system message 发给 agent 的说明
      await agentLoop.processSystemMessage(localEffect.systemMessage);
      break;
    }
  }
}
```

**典型归属**（2026-04-16 基于 Phase 1 Step 5 实测重新分类）：
- `local`：`/new`、`/clear`、`/exit`、`/help`、`/status`、`/me`、`/model`、`/usage`、`/context`、`/sessions`、`/skills`、`/journal`、`/people`、`/trust`、`/security`、`/compact`、`/name` —— 所有 info 查询 + 所有项目管理命令。**不产生 agent turn**。
- `agent`：`/background`、`/btw`、`/queue` —— 本质是 system prompt 的便捷入口
- `hybrid`：**暂无内建命令使用**。这一档为将来"真的需要 agent 知道本地副作用才能正确推理"的场景保留（如 `/switch-workspace` 切工作区，后续对话里 agent 必须知道新 cwd），不开放给 info 类或项目管理类命令。

**⚠️ 反模式警告（2026-04-16 实测教训）**：不要把 **info 查询命令** 设成 `hybrid`。初版 Phase 1 Step 5 里 `/model` 是 hybrid —— local handler 正确打印了 `Pro/MiniMaxAI/MiniMax-M2.5`，随后把 system message "用户查看了当前模型" 丢给 agent，**agent 完全不知道 runtime 模型是什么，凭训练记忆瞎编 "Claude 3.5 Sonnet"**。`/new` 同理：hybrid 的 system message 让 agent 生成了一段欢迎语，纯噪音。

**判断规则**：只有满足**全部**三条的命令才有资格做 hybrid：
1. 本地副作用改变了 agent 后续推理必须依赖的 runtime 状态（cwd / workspace / tool 能力范围等）
2. 这个状态**无法** agent 从对话历史里推断出来
3. 通知 agent 带来的增量价值 > 额外 token + 潜在幻觉风险

不满足任何一条就用 `local`。`/new` 清历史后 agent 从空白开始，天然知道"新会话"；`/model` 改配置但 agent 本身看不见 runtime，告诉它只会诱导幻觉 —— 两条都不该做 hybrid。

**这个分档比 OpenClaw 的 `executeLocal: boolean` 细**，比 Claude Code 的 `type: 'local' | 'local-jsx' | 'prompt'` 更贴场景。

### 9.3 Argument 渐进式输入

**场景**：用户选 `/model` → 需要输入 provider/model → 知行支持动态枚举。

```
用户按 /
→ dropdown: /new /model /elevated /help ...
→ 用户选 /model
→ broker.accept({ execute: false }) 因为 /model 还有必填 args
→ inputBuffer = "/model "  cursor 在尾
→ broker.updateInput 重新触发
→ ArgumentProvider.matchTrigger 命中（检测到 "/model " 有参数 slot）
→ query 返回 provider aliases 列表（动态枚举）
→ dropdown: claude-sonnet-4-6 / claude-opus-4-6 / claude-haiku-4-5 / gpt-4o ...
→ argumentHint 同时显示 "[provider/model]"
→ 用户选 claude-opus-4-6
→ broker.accept({ execute: true }) 因为这是最后一个参数
→ inputBuffer = "/model claude-opus-4-6"
→ 立即提交
```

**ArgumentProvider** 的实现（草图）：

```typescript
class ArgumentProvider implements SuggestionProvider {
  id = "argument";
  priority = 90;

  matchTrigger(ctx: TriggerContext): TriggerMatch | null {
    // 当前 draft 是 "/command [arg0] [arg1] |" 形态时命中
    const parsed = parseCommandDraft(ctx.draft, ctx.cursor);
    if (!parsed) return null;
    const cmd = this.registry.findByName(parsed.commandName);
    if (!cmd?.args) return null;

    const currentArgIndex = parsed.argIndex;
    const currentArgSchema = cmd.args[currentArgIndex];
    if (!currentArgSchema) return null;  // 超出参数数量

    return {
      providerId: this.id,
      tokenStart: parsed.currentTokenStart,
      tokenEnd: parsed.currentTokenEnd,
      token: parsed.currentToken,
      query: parsed.currentToken,
      providerData: { cmd, currentArgIndex, currentArgSchema },
    };
  }

  async query(match: TriggerMatch, signal: AbortSignal): Promise<SuggestionItem[]> {
    const { currentArgSchema, cmd, currentArgIndex } = match.providerData as ArgProviderData;

    switch (currentArgSchema.kind) {
      case "enum":
        return currentArgSchema.choices
          .filter((c) => c.value.startsWith(match.query))
          .map((c) => toItem(c, cmd, currentArgIndex));

      case "async-enum":
        const choices = await currentArgSchema.provider.list({ query: match.query }, signal);
        return choices.map((c) => toItem(c, cmd, currentArgIndex));

      case "path":
        return fileSystemSuggest(match.query, currentArgSchema, signal);

      case "text":
      case "number":
      case "boolean":
        return [];  // 这些类型不做 dropdown，只显示 argumentHint
    }
  }
}
```

### 9.4 EventBus 集成

`TypeaheadBroker` 把所有 `typeahead:*` 事件发到和 confirmation 共用的 `EventBus`。日志、telemetry、未来的 Smart Triage 全部读同一个总线。

---

## 十、渐进实现计划

### 10.1 原则

每一步必须：
- **独立**：能单独上线，不依赖后续步骤（后续步骤 enhance，不 require）
- **可验证**：有单元测试 / 集成测试 / 手动验收清单
- **可回滚**：用 feature flag 或 broker 的 `_disabled` 机制能关掉整条路径
- **不破已有测试**：confirmation-ux 的现有 823+ 测试 0 回归
- **§6.4 护栏必须有**：任何涉及 TTY 渲染的 step，必须带"渲染次数恒等式 + 帧 diff 相等"两类断言

### 10.2 步骤清单

#### Step 1 — TUI 内核抽取（预备）

**目标**：把 `SelectWithInput` 里的 raw-mode 引用计数、stdin 独占、cursor 不变量、line-width 计算、ansi 常量抽到 `packages/cli/src/tui/_internal/`，让后续的 `TypeaheadPanel` 能直接复用。

**交付物**：
- `packages/cli/src/tui/_internal/raw-mode.ts` —— 引用计数
- `packages/cli/src/tui/_internal/stdin-ownership.ts` —— keypress listener snapshot/restore（§6.4 陷阱 3 的护栏）
- `packages/cli/src/tui/_internal/cursor-invariants.ts` —— rerender 的 "上移 N + 逐行覆盖" 工具
- 重构 `select-with-input.ts` 使用这些内核，**不改外部接口**

**验收**：
- 现有 `select-with-input.test.ts` 的 17 条场景全绿
- 护栏断言（§6.4 的渲染恒等式 + 帧 diff）仍然成立
- 新增内核的单元测试 ≥ 15 条

**代码量估计**：~200 行（净增 = 内核抽取 + 测试 - `select-with-input.ts` 的代码减少）

---

#### Step 2 — `CommandRegistry` + `CommandDef` 类型（Core only）

**目标**：在 `@zhixing/core` 下新增 `typeahead/` 模块，实现 `CommandRegistry` 和 `CommandDef` / `ArgSchema` 类型，**定义**一组参考性 builtin 命令清单。**不接入 REPL**。

**交付物**：
- `packages/core/src/typeahead/types.ts` —— `CommandDef` / `ArgSchema` / `CommandVisibility` / `RuntimeContext`
- `packages/core/src/typeahead/registry.ts` —— `DefaultCommandRegistry`
- `packages/core/src/typeahead/builtin-commands.ts` —— **命令目录范例**（见 §5.8 refinement）：文件存在、测试和设计引用它，但**不作为 Step 5 REPL 的运行时注册源**
- `packages/core/src/typeahead/usage-tracker.ts` —— `UsageTracker` + 磁盘持久化
- `packages/core/src/typeahead/__tests__/registry.test.ts` —— ≥ 15 条
- `packages/core/src/typeahead/__tests__/usage-tracker.test.ts` —— ≥ 10 条

**验收**：
- 所有测试全绿
- 完全不依赖任何 CLI / TTY / UI 代码
- `builtin-commands.ts` 至少包含 10 个命令（`/new /reset /help /status /model /elevated /fast /verbose /exit /clear`）作为范例 —— 实际 REPL 里用哪些命令在 Step 5 决定
- 现有 823+ 测试无回归

**代码量估计**：~500 行

---

#### Step 3 — `TypeaheadBroker` + `CommandProvider`（Core only）

**目标**：实现 `TypeaheadBroker` 核心类（session 管理 + abort + provider 分派）和第一个 provider `CommandProvider`（Fuse.js + MRU + 分类）。**不接入 REPL**。

**交付物**：
- `packages/core/src/typeahead/broker.ts` —— `DefaultTypeaheadBroker`
- `packages/core/src/typeahead/session.ts` —— `TypeaheadSession` 状态机
- `packages/core/src/typeahead/providers/command-provider.ts` —— 首个 provider
- `packages/core/src/typeahead/fuzzy-index.ts` —— Fuse.js 薄封装 + 引用身份缓存
- `packages/core/src/typeahead/sort.ts` —— resort 纯函数
- `packages/core/src/typeahead/trigger-matcher.ts` —— `findTriggerToken` 工具
- `packages/core/src/typeahead/events.ts` —— `TypeaheadEvent` 类型
- `packages/core/src/typeahead/__tests__/broker.test.ts` —— ≥ 25 条
- `packages/core/src/typeahead/__tests__/command-provider.test.ts` —— ≥ 20 条
- `packages/core/src/typeahead/__tests__/sort.test.ts` —— ≥ 12 条（每个排序层级一条）

**关键测试场景**：
- 空 query 时返回 MRU + 分类
- 非空 query 走 Fuse + resort
- 精确 name 匹配排第一
- 精确 alias 匹配排第二
- 相同 prefix match 时短名字优先
- Fuse index 按 commands 引用身份缓存（改 commands 数组才重建）
- Abort 正确工作：async provider 的 query 过期时不污染 state
- Provider 抛异常时 broker 降级到空 suggestions + 发事件
- `findTriggerToken` 支持 Unicode（中文命令名）
- `findTriggerToken` 支持 cursor 中间位置（mid-input 预留）

**验收**：测试全绿 + 现有 823+ 测试无回归

**代码量估计**：~800 行

---

#### Step 4 — `TypeaheadPanel`（CLI 渲染器）

**目标**：实现常驻的 `TypeaheadPanel`，复用 Step 1 的内核，订阅 broker 的 session 变化，渲染 dropdown。**不接入 REPL**；通过一个独立的 playground 脚本驱动 manual 验收。

**交付物**：
- `packages/cli/src/tui/typeahead-panel.ts` —— 主组件
- `packages/cli/src/tui/typeahead-renderer.ts` —— 实现 `TypeaheadRenderer` 接口，包装 `TypeaheadPanel`
- `packages/cli/src/tui/__tests__/typeahead-panel.test.ts` —— ≥ 20 条，包含 §6.4 两类护栏断言
- `playground/typeahead-manual.mjs` —— 手动验收脚本（stdin 驱动 broker，观察面板）

**关键测试场景**：
- Active ↔ Inactive 态切换时清行正确（不留 ghost row）
- 上下箭头导航更新 selectedIndex，broker 不重新 query
- 选中项居中（窗口算法）
- Rerender 帧 diff 相等（同一 session state 重绘产生同一输出）
- CJK 宽字符正确截断
- 终端 resize 触发 rerender 不产生堆叠
- Async provider 的 loading 态渲染 spinner
- Provider 抛异常时面板显示错误提示不崩溃

**手动验收**：在 Windows Terminal 里运行 playground 脚本：
- 打 `/` 看到内建命令列表
- 打 `/e` 看到以 e 为 prefix 或 fuzzy 命中的命令
- ↑↓ 导航
- Tab 接受首个
- Enter 提交
- Esc 取消
- 退出 active 态时面板清干净

**代码量估计**：~600 行

---

#### Step 5 — REPL 接入 + `InputBuffer` + 执行分派

**目标**：把 `InputBuffer` / `TypeaheadPanel` / `broker.accept` 接入 REPL，处理 `local` / `agent` / `hybrid` 三档执行。feature flag `ZHIXING_INPUT_TYPEAHEAD` 控制（默认开，关掉回退到原 `readline.question`）。

**交付物**：
- `packages/cli/src/input-buffer.ts` —— 持有 draft/cursor/历史/submit 事件的类
- `packages/cli/src/typeahead-input.ts` —— `readInputLine()` 神经中枢（broker + panel + buffer + dispatcher 的整帧编排）
- `packages/cli/src/command-dispatcher.ts` —— 处理 `local`/`agent`/`hybrid`
- `packages/cli/src/repl.ts` —— 改造：在 REPL bootstrap 持有**本地 `REPL_COMMANDS` 表**（见 §5.8 refinement），循环注册到 tRegistry + dispatcher handler；feature flag 走 typeahead 路径，回退走 `rl.question`
- `packages/cli/src/__tests__/input-buffer.test.ts` + `command-dispatcher.test.ts` + `typeahead-input.test.ts` —— 合计 ≥ 50 条（Phase 1 实测落地 55 条）

**关键测试场景**：
- Feature flag off：旧路径正常
- Feature flag on + 无 trigger：draft 正常进 agent loop
- Feature flag on + `/new`：**local handler 跑，不产生 agent turn**（2026-04-16 refinement —— 见 §9.2 反模式警告）
- Feature flag on + `/unknown`：suggestions 空 + 提交后 agent loop 拿到 "unknown command" 错误
- 用户打 `/` 然后 Esc：draft 变回空（Esc 清 trigger token 还是清整个 draft 需要决定，默认清 trigger token）
- 提交时 typeahead 还有 suggestions → Enter 被吞掉（guard）

**REPL 命令表约定**（2026-04-16 Step 5 确立）：`packages/cli/src/repl.ts` 里的 `REPL_COMMANDS` 是本地 readonly 数组，每条 `{ name, aliases?, description, category, execution: "local", legacyKey }`。bootstrap 循环把每条 register 到 tRegistry + 用 legacy handler 绑定 dispatcher。新增命令只需要加一行。**不要**在 REPL 里调 `registerBuiltinCommands(tRegistry)`，避免注册了没 handler 的幽灵命令（见 §5.8 refinement）。

**手动验收**：`pnpm run repl` 进 REPL，打 `/` 看到菜单，选命令能执行。`/model` / `/new` 不产生 agent 回复。

**代码量估计**：~400 行（Phase 1 实测 ~1000 行含测试）

---

**Phase 1 里程碑**：Steps 1-5 完成，用户可以在 REPL 里打 `/` 触发内建命令补全，fuzzy + MRU + 分类 + Tab/Enter/Esc 全部可用。知行 **在这一步就已经比 Hermes 和 OpenClaw CLI 更强**（fuzzy + MRU + 分类全齐）。

---

#### Step 6 — `FileProvider`（@file 异步）

**目标**：引入第二个 provider，证明 broker 的多 provider + async + abort 机制。

**搜索根目录**：基于「当前生效的工作区」（`resolvedWorkspace.path`），**不是** `process.cwd()`。工作区经过四级解析（CLI `--workspace` > 项目配置 `zhixing.config.json` > 全局配置 `~/.zhixing/config.json` > 交互模式 cwd fallback），由 `resolveWorkspace()` 统一决定。这和安全系统的信任边界一致 —— 工作区内是 `internal`，工作区外是 `external`。

路径展开规则：
- `@src/foo.ts` → 相对于工作区根
- `@./foo.ts` → 相对于工作区根（显式写法）
- `@../foo.ts` → 工作区根的上级（注意：已越出信任边界）
- `@~/foo.ts` → 用户 home 目录
- `@/etc/hosts` → 绝对路径（工作区外，metadata 标记 `isOutsideWorkspace: true`）

**交付物**：
- `packages/core/src/typeahead/providers/file-provider.ts`
- 构造参数 `{ root: string }` —— 接收 `resolvedWorkspace.path`，不自己调 `process.cwd()`
- trigger 检测：`@file:` 显式前缀 + 裸 `@path` 启发式
- fs 读取用 `fs.promises.readdir(dir, { signal })`（原生支持 abort）
- `SuggestionItem.metadata` 携带 `{ resolvedPath, size, isDirectory, isOutsideWorkspace }`
- 超时控制：query > 1 秒 auto-abort + 显示 loading
- 隐藏文件（`.` 开头）只在显式前缀时显示
- 单元测试 ≥ 15 条

**验收**：
- 手动：打 `@src/` 看到目录列表，选中后 draft 变成 `@file:src/...`
- Stale test：快速连续打字，验证只有最后一次的结果被渲染
- 大目录（1000+ 文件）性能可接受（< 300ms）

**代码量估计**：~300 行

---

#### Step 7 — Ghost Text 渲染

**目标**：在 prompt 行上 inline 显示 ghost text（dim 色），Tab 接受。

**交付物**：
- `TypeaheadPanel` 新增 `renderGhostText(session)` 分支
- `CommandProvider` 实现 `getBestPrefixMatch(query)` 纯函数（专供 ghost，不用 fuzzy）
- `broker.computeGhostText(session)` 返回 `GhostText | null`
- Ghost 只在 prefix unambiguous 时生成（和 dropdown 协同）
- Tab 按键 handler：有 ghost 时 Tab 接受 ghost（不是接受 dropdown 选中项）
- 单元测试 ≥ 10 条（ghost 显示条件、Tab 行为、非 Tab 按键清 ghost）

**验收**：打 `/up` 看到 `dim date`（dim 色），Tab 后变成 `/update`。

**代码量估计**：~200 行

---

#### Step 8 — Progressive Argument Hint + `ArgumentProvider`

**目标**：命令选中后进入参数输入态，hint 行显示下一个参数的 schema；有 enum / async-enum 时 dropdown 同时打开。

**交付物**：
- `packages/core/src/typeahead/providers/argument-provider.ts`
- `packages/core/src/typeahead/parse-command-draft.ts` —— 解析 `/cmd arg0 arg1 |` 的 token 位置
- `packages/core/src/typeahead/progressive-hint.ts` —— 生成 hint 字符串（`[level: a|b|c]`, `[depth: number (default: 3)]` 等）
- `TypeaheadPanel` 新增 argumentHint 行渲染
- 内建命令开始补 `args: ArgSchema[]`（至少 `/model` `/elevated` `/fast` `/verbose` 四个）
- 单元测试 ≥ 20 条

**验收**：
- 打 `/model ` 看到 hint 行 + dropdown（provider/model 枚举）
- 打 `/fast ` 看到 hint + dropdown（`on|off|status`）
- 打 `/add-dir src/` 看到 path 参数的目录补全 + hint 显示下一个参数

**代码量估计**：~400 行

---

**Phase 2 里程碑**：Steps 6-8 完成。用户可以 `@file`、看到 ghost text、进入参数渐进式输入。功能上和 **Claude Code 基本对齐**，架构上更干净（显式 priority + provider 接口）。

---

#### Step 9 — Mid-input Trigger 支持 ⏸️ 降级为 P2，暂不实施

> **2026-04-16 决策**：经过 Phase 2 实际验证，`requireBoundary=true`（trigger 字符前必须是空白或行首）已覆盖 mid-input 的绝大多数有效场景。将 `requireBoundary=false` 降级为 P2 优先级，原因如下：
>
> **收益有限**：
> - `请帮我运行 /backup`（空格后触发）—— 当前已支持 ✅
> - `请查看 @src/foo.ts`（空格后触发）—— 当前已支持 ✅
> - 唯一增量场景是中文字符紧贴 trigger（如 `查看@src/`，无空格），在真实输入中极少见
>
> **风险显著**：
> - `给 @张三 发消息` → FileProvider 误触发，中文场景下高频
> - `比较 a/b 和 c/d` → `/` 被误认为 slash command trigger
> - 消歧义需要引入"负向前缀列表"或"意图推理"等复杂机制，投入产出比低
>
> **架构已预留**：`findTriggerToken` 的 `requireBoundary` 参数、provider 的 `matchTrigger` 签名已支持 `false`，技术上随时可启用。如果未来有明确的用户需求（如 IDE 插件场景中 inline `@file` 是刚需），只需改一个布尔值 + 加消歧义规则。
>
> **结论**：不做比做错好。当前 `requireBoundary=true` 是正确的默认值。

**原目标**（保留供未来参考）：允许 `/command` 和 `@file` 出现在 draft 中间，不是只在开头。

**原交付物**：
- `trigger-matcher.ts` 扩展：`requireBoundary=false` 时允许 cursor 前是空格或开头
- `CommandProvider.matchTrigger` 支持 mid-input
- `FileProvider.matchTrigger` 支持 mid-input（原本就是）
- 单元测试 ≥ 12 条（不同 cursor 位置、不同 boundary 字符）
- Regex 用 `\p{L}\p{N}` 而非 `[a-zA-Z0-9]`

**原代码量估计**：~150 行

---

#### Step 10 — `MemoryProvider` / `ToolProvider`（知行差异化）

**目标**：两个知行独有的 provider，把"记忆引用" "工具引用" 做成 first-class 输入概念。

**交付物**：
- `packages/core/src/typeahead/providers/memory-provider.ts`
  - trigger: `@memory:key`
  - 数据源：`~/.claude/projects/.../memory/*.md`（或知行的 memory registry）
  - `SuggestionItem.metadata` 携带 `{ memoryPath, loadSnippet }`
- `packages/core/src/typeahead/providers/tool-provider.ts`
  - trigger: `@tool:name`
  - 数据源：`packages/tools-builtin` 的 tool registry
  - `SuggestionItem.metadata` 携带 `{ toolName, schema }`
- Agent loop 扩展：解析 user message 里的 `@memory:` / `@tool:` 标记，把对应内容注入 context 或系统提示
- 单元测试 ≥ 15 条

**验收**：打 `@memory:confirm` 看到 `confirmation-state` 等记忆条目；选中后 draft 变成 `@memory:confirmation-state`；提交后 agent 看到记忆内容。

**代码量估计**：~450 行

---

#### Step 11 — Plugin API + Filesystem 命令（`.zhixing/commands/*.md`）

**目标**：让用户 / 项目能通过 markdown 文件定义新命令，plugin 能注册新 provider。

**交付物**：
- `packages/core/src/typeahead/sources/filesystem-command-source.ts` —— 扫描 `~/.zhixing/commands/` 和 `<workspace>/.zhixing/commands/`
- `.md` 文件的 frontmatter 解析（`name`, `description`, `args`, `visibility`）
- `CommandRegistry.registerDynamicSource` 接入
- `packages/plugin-sdk/src/typeahead-api.ts` —— `registerTypeaheadProvider` 导出
- 熔断：plugin provider 连续 3 次异常自动禁用
- 单元测试 ≥ 15 条

**验收**：
- 创建 `~/.zhixing/commands/greet.md`（frontmatter 定义命令），打 `/greet` 能看到
- 修改文件后 `CommandRegistry.refresh()` 能重新加载
- 制造一个故意抛异常的 plugin provider，验证熔断

**代码量估计**：~500 行

---

**Phase 3 里程碑**：Steps 9-11 完成。知行在所有竞品维度都领先或并列。

---

#### Step 12 — `WebTypeaheadRenderer` 架构验证（Phase 4，远期）

**目标**：在不真正实现 Web UI 的前提下，写一个 mock `WebTypeaheadRenderer`，通过 broker 接口订阅 session 变化，输出 JSON 快照 —— **证明 core 完全渲染无关**。

不交付真实 Web UI，只验证架构。

**交付物**：
- `packages/core/src/typeahead/renderers/__tests__/mock-web-renderer.test.ts`
- Mock renderer 订阅 broker，对每个 session state 变化输出 JSON diff，和 TTY renderer 的行为等价

**验收**：同一组 `broker.updateInput` 序列，TTY 和 Mock Web 产生相同的 session state stream。

**代码量估计**：~150 行

---

### 10.3 里程碑总结

| Phase | Steps | 增量代码 | 里程碑 |
|---|---|---|---|
| **Phase 1: `/` 端到端可用** | 1-5 | ~2500 行 | 内核抽取 + Broker + CommandProvider + TTY 渲染器 + REPL 接入。`/command` fuzzy + MRU + 分类 + 执行分派 |
| **Phase 2: 多触发 + Ghost + Args** | 6-8 | ~900 行 | `@file` 异步；ghost text inline；argumentHint + 参数枚举补全 |
| **Phase 3: 差异化 + 扩展** | 10-11 | ~950 行 | `@memory` `@tool`；plugin API + filesystem 命令（Step 9 mid-input 降级为 P2，见 §12.2 #9） |
| **Phase 4（远期）: 架构验证** | 12 | ~150 行 | Mock Web renderer 证明 core 渲染无关 |

**总代码量预估**：**~4650 行**（含测试）。对比：Claude Code 约 3500 行（命令补全 + PromptInput + FooterSuggestions），Hermes 约 400 行，OpenClaw 约 600 行。

> **Phase 1 的代码量显著大于 confirmation-ux 的 Phase 1（~1350 行）**，原因：(a) 内核抽取是一次性投资，为未来所有 TUI 组件服务；(b) CommandProvider 的 Fuse + resort + MRU 比 confirmation 的选项列表复杂；(c) REPL 接入涉及 InputBuffer 这一新抽象。

---

## 十一、和竞品的最终对比

| 维度 | OpenClaw CLI | OpenClaw Web | Hermes | Claude Code | **知行（设计后）** |
|---|---|---|---|---|---|
| 交互栈 | pi-tui 黑盒 | Lit 手写 | prompt_toolkit | Ink + React Compiler | **自研 raw-mode（复用 SelectWithInput 内核）** |
| 核心/渲染分离 | ❌ | ❌ | ❌ | ❌ | ✅ **Broker + Renderer 接口** |
| 驭灵就绪 | ❌ | ❌ | ❌ | ❌ | ✅ **Phase 1 即到位** |
| 触发检测 | ? | 严格正则 | startswith | cursor-aware | ✅ **cursor-aware + Unicode** |
| Mid-input 触发 | ? | ❌ | ❌ | ✅ | ⏸️ P2（`requireBoundary=true` 已覆盖空格后触发，见 §12.2 #9） |
| 过滤算法 | ? | prefix + substring | 纯 prefix | Fuse 加权 + resort | ✅ **Fuse 加权 + resort + 知行调参** |
| MRU 排序 | ❌ | ❌ | ❌ | ✅ | ✅ **core 持久化（非 UI state）** |
| 分类分组 | ❌ | category | 源顺序 | 多源分层 | ✅ Phase 1 |
| 多触发前缀 | 1 | 1 | 2 (`/` + `@`) | 7+ | ✅ **`/ @file @memory @tool @mcp @agent`** |
| Async providers | ❌ | ❌ | ❌ | ✅（ref check） | ✅ **AbortController + 双重检查** |
| Ghost text | ❌ | ❌ | ✅ | ✅ | ✅ Phase 2（prefix-only） |
| 参数 schema | `argOptions` 字符串数组 | 同 | `args_hint` 字符串 | `argNames` + `argumentHint` | ✅ **结构化 `ArgSchema[]`** |
| 参数枚举补全 | ✅ `getArgumentCompletions` | ✅ `argOptions` 两段式 | `SUBCOMMANDS` 静态 | 特事特办 | ✅ **通用 `ArgumentProvider`** |
| Progressive hint | ❌ | ❌ | ❌ | ✅ | ✅ Phase 2 |
| Enter-with-suggestions guard | ❌ | ✅ | prompt_toolkit 默认 | ✅ | ✅ Phase 1 |
| Plugin 命令 | gateway commands | — | skill lambda | MD 文件 + plugin | ✅ **MD 文件 + Plugin SDK + 熔断** |
| 运行时过滤 | ❌ | ❌ | ✅ | `isHidden` | ✅ **`visibility.predicate` + targets** |
| 本地 vs agent 执行分档 | ✅ `executeLocal` 二档 | ✅ | ❌ | ✅ 类型区分 | ✅ **`local/agent/hybrid` 三档** |
| 命令单源真相 | ⚠️ 双投影 | ⚠️ | ✅ | 多源合并 | ✅ **单源 + 动态 source** |
| EventBus 可观测 | ❌ | ❌ | ❌ | 部分 | ✅ **完整 `typeahead:*` 事件** |
| 可测试性 | ⚠️ 黑盒 | ⚠️ Lit 难测 | ⚠️ PTK 难测 | ⚠️ Ink + compiler memo | ✅ **纯逻辑 + `PassThrough` + 护栏** |

**知行在 22 个维度中，15 个严格领先，7 个并列 Claude Code —— 无维度落后**。

---

## 十二、风险与待决项

### 12.1 风险

1. **Phase 1 Step 1 的内核抽取可能引入 `SelectWithInput` 回归**：§6.4 的修复是血泪经验，重构时要**先让 select-with-input 的 17 条测试全绿**再往前推。**缓解**：内核抽取是纯重构，不改行为，新测试只加不删。抽取完成后跑一遍 Windows Terminal 手动验收（`playground/tui-manual.mjs`）。

2. **TypeaheadPanel 常驻重绘的性能**：每次按键触发 broker + re-render，命令数大 + provider 多时可能卡顿。**缓解**：(a) Fuse 索引按引用身份缓存（Step 3）；(b) provider 的 query 限制 3ms 预算，超过走 async 路径；(c) debounce 策略：50ms 内连续按键合并。

3. **`AbortController` 生态兼容性**：Node 18+ `fs.promises.readdir` 和 `fetch` 都接受 signal，但部分三方库不支持。**缓解**：核心只用原生 API；plugin provider 不支持 signal 时走 broker 的"双重 stale check" 兜底。

4. **`InputBuffer` 与现有 `readline` 历史文件冲突**：`readline` 有自己的 history file 格式，`InputBuffer` 要么复用要么独立。**缓解**：Step 5 决定用独立文件 `~/.zhixing/history.json` 记录 submit 历史；`readline` history 的旧数据一次性导入。

5. **Plugin provider 的安全边界**：任意代码运行在 broker 进程里，有能力偷读 draft 和 suggestions。**缓解**：暂时不考虑沙箱（plugin SDK 整体未落地）；Phase 3 Step 11 只支持 filesystem 命令（静态 markdown，无代码）+ trusted plugin API。真正的 sandboxing 留给未来的 `plugin-sdk` 专项 spec。

6. **Mid-input trigger 的视觉干扰**：用户写长段文字时中间打了 `/` 就突然弹菜单，可能打扰。**缓解**：Step 9 已降级为 P2（§12.2 #9）—— `requireBoundary=true` 是更安全的默认值，已覆盖空格后触发的主流场景。如果未来启用 `requireBoundary=false`，需同时引入 feature flag + 消歧义规则。

7. **Argument schema 的类型安全 vs 灵活性**：`ArgSchema` 用判别式联合很严格，但插件作者可能想要"任意对象"作为 arg。**缓解**：保持严格；插件作者用 `kind: "text"` + captureRemaining 自行解析。

8. **`usage.json` 磁盘污染**：频繁写可能在移动设备 / 网络盘上有问题。**缓解**：debounced 5 秒 flush + 程序退出 flush + 崩溃时丢 5 秒数据可接受。

9. **Command 分档 `local/agent/hybrid` 让命令 handler 写法复杂化**：每个 local/hybrid 命令的 handler 要返回结构化 `{ systemMessage? }`。**缓解**：提供 `defineLocalCommand({ name, handler })` helper 辅助书写；`hybrid` 只对系统性命令（`/new` `/model`）开放，大多数命令用 `local` 或 `agent`。

### 12.2 已定决策（2026-04-15 锁定）

以下 7 条在 v1.0 定稿时已与用户确认并锁定。后续如果要改，走 ADR。

1. **触发字符集**：仅 `/` 和 `@`。不引入 `:emoji` / `!bash`。有明确用户请求再加。
2. **空 `/` 默认聚焦**：MRU 最顶（详见 §6.5 零键执行原则）。不采用字母序。
3. **Feature flag `ZHIXING_INPUT_TYPEAHEAD`**：**默认 on**。Phase 1 交付即启用，`ZHIXING_INPUT_TYPEAHEAD=legacy` 回退到旧 `readline` 路径作应急兜底。
4. **`hybrid` 命令执行顺序**：**先 local 再 agent**（语义层面始终成立）。local 副作用完成后再把结构化的 system message 发给 agent。Agent 永远看到 "已发生" 的事实，不是 "即将发生" 的意图。**但**（2026-04-16 refinement）：`hybrid` 的准入门槛被收紧 —— 只有"agent 必须知道新 runtime 状态才能正确推理"的命令才能用 hybrid。Info 查询 / 项目管理类全部下沉到 `local`。理由：info 查询走 hybrid 会诱导 agent 对它无法感知的 runtime 状态产生幻觉（见 §9.2 反模式警告）。Phase 1 里程碑里所有 17 条内建命令都是 `local`，`hybrid` 这一档暂时没有占用者 —— 这是**合理的**，不是架构过度设计。
5. **`.zhixing/commands/*.md` frontmatter**：**纯声明**（YAML frontmatter + body 作 prompt 模板）。不支持 `handler:` 指向 JS 文件。JS handler 能力留给未来的 plugin SDK 专项 spec。
6. **Mid-input trigger 对 bash mode**：**关闭**。bash mode 里 `/` 是 Unix 路径分隔符，开 mid-input 会误判。Step 9 只对 prompt mode 启用。
7. **参数 schema 的 required 字段**：**支持**。`ArgumentProvider` 检测到必填参数未填时，Enter 不执行，面板显示 `<name> is required` 错误态。
8. **`@file` 搜索根目录**（2026-04-16 追加）：基于「当前生效的工作区」（`resolvedWorkspace.path`），**不是** `process.cwd()`。工作区经过四级解析（CLI `--workspace` > 项目配置 > 全局配置 > cwd fallback），由 `resolveWorkspace()` 统一决定。FileProvider 构造参数为 `{ root: string }`，不自己调 `process.cwd()`。这保证 `@file` 的搜索范围和安全系统的信任边界一致。
9. **Mid-input trigger 降级为 P2**（2026-04-16 追加）：`requireBoundary=true` 已覆盖"空格后触发"的主流 mid-input 场景（如 `请帮我运行 /backup`）。`requireBoundary=false` 的增量收益极小（仅覆盖中文紧贴 trigger 字符的罕见情况），但引入中文语境误触发风险（`给 @张三 发消息`、`比较 a/b`）。架构已预留 `requireBoundary` 参数，技术上随时可启用。**不做比做错好。**

---

## 十三、附录：术语表

| 术语 | 定义 |
|---|---|
| **Typeahead** | 输入时的实时补全建议系统的总称（和 "autocomplete" 同义） |
| **Broker** | 核心调度器，管理 session、dispatch provider、abort 过期 query |
| **Provider** | 一类补全候选的生成器（`/` / `@file` / `@memory` 各一个） |
| **Renderer** | 把 session state 变成用户能看到的 UI 并收集选择 |
| **Session** | 一次"REPL 等待用户输入"的生命周期，贯穿多次 trigger 变化 |
| **Trigger** | 触发 provider 激活的字符 + 上下文（如 `/` 开头，或 cursor 前是 `@`） |
| **Ghost Text** | 输入行内以暗色显示的 inline 补全，Tab 接受 |
| **Argument Hint** | 命令选中后显示的参数说明行，独立于 dropdown |
| **Progressive Hint** | 多参数命令的 hint 随已输入参数个数推进 |
| **MRU** | Most Recently Used，基于使用频度 + 时间衰减的评分 |
| **Stale Query** | 异步 provider 的 query 结果回来时，input 已经变了，应被丢弃 |
| **AcceptPayload** | Suggestion item 里封装的"选中后做什么"的数据 |
| **Execute Hint** | `local` / `agent` / `hybrid` 三档执行归属 |
| **Capabilities Negotiation** | Broker 查询 renderer 能力，裁剪不支持的 item 字段 |
| **Cursor Invariant** | §6.4 里定义的 rerender 时 cursor 必须回到的位置合约 |
| **Stdin Ownership** | §6.4 陷阱 3 里定义的"进入 raw mode 时 snapshot keypress listeners，退出时恢复"的独占协议 |
