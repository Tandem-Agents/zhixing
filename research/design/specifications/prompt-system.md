# 系统提示词与上下文组装 — 设计方案

> **状态**: 📐 方案设计（2026-04-09）
> **依赖**: OpenClaw 源码分析 `prompt-system.md`、Claude Code 社区逆向分析 `prompt-system.md`
> **前置**: Phase 2 全部完成（Agent Loop + Provider + 工具 + CLI + 容错 + 上下文 + 会话）

## 一、竞品方案对比

### 1.1 系统提示词组装


| 维度   | OpenClaw                                                    | Claude Code                          | **知行策略**                                 |
| ---- | ----------------------------------------------------------- | ------------------------------------ | ---------------------------------------- |
| 组装方式 | 单函数 `buildAgentSystemPrompt()` 拼接大字符串                       | `getSystemPrompt()` + 6 层优先级         | **分段注册 + 管线组装**（见下文）                     |
| 段落数量 | ~17 个章节                                                     | 7 静态段 + 多个条件段                        | **核心 5 段 + 可扩展**                         |
| 身份定义 | 长段落（"You are a personal assistant running inside OpenClaw"） | 一句话极简                                | **一句话 + 个性段可选**（ZHIXING.md 覆盖）           |
| 动态内容 | 部分在 system，部分在 user prompt                                  | `<system-reminder>` 注入 user messages | `**<context>` 标签注入 user messages**（保护缓存） |
| 代码规模 | system-prompt.ts ~700 行                                     | prompts.ts ~900 行 + 多个辅助模块           | **目标 <200 行主文件**                         |


### 1.2 项目上下文加载


| 维度    | OpenClaw                            | Claude Code                               | **知行策略**                              |
| ----- | ----------------------------------- | ----------------------------------------- | ------------------------------------- |
| 文件名   | 白名单 8 个固定文件名                        | CLAUDE.md + 层级系统                          | **ZHIXING.md**（单文件，简洁）                |
| 放置位置  | system prompt 的 `# Project Context` | user messages 的 `<system-reminder>`       | **user messages 的 `<context>` 标签**    |
| 层级    | 单层（项目根目录）                           | 7 层（组织→用户→项目→子目录）                         | **3 层**（用户→项目→子目录）                    |
| Rules | 无独立 rules 系统                        | `.claude/rules/*.md` 支持 paths frontmatter | `**.zhixing/rules/*.md`**（Phase 3 后续） |
| 预算    | 有截断预算                               | 200 行/25KB                                | **按 token 百分比预算**（自适应模型窗口）            |


### 1.3 缓存策略


| 维度     | OpenClaw                           | Claude Code                          | **知行策略**                                      |
| ------ | ---------------------------------- | ------------------------------------ | --------------------------------------------- |
| 分界标记   | `<!-- OPENCLAW_CACHE_BOUNDARY -->` | `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` | `**__ZHIXING_CACHE_BOUNDARY__`**              |
| 实现复杂度  | 中（分界 + Anthropic payload policy）   | 极高（5 个 sticky latch、DANGEROUS 命名约定）  | **最小可用版**（分界 + 按 provider 条件附加 cache_control） |
| 动态内容处理 | 部分在 system 分界后                     | 全部走 `<system-reminder>`              | **全部走 `<context>` 注入 user messages**          |


### 1.4 工具描述


| 维度       | OpenClaw                                 | Claude Code                  | **知行策略**                                |
| -------- | ---------------------------------------- | ---------------------------- | --------------------------------------- |
| 描述位置     | system prompt `## Tooling` + JSON Schema | JSON Schema `description` 字段 | **JSON Schema 为主，system prompt 只放使用原则** |
| Token 开销 | 未知                                       | 14-17K tokens                | **目标 <5K tokens**（精简描述 + 按需加载）          |
| 使用指导     | 在 system prompt 中                        | 嵌入在每个工具的 description 中       | **双层**：通用原则在 system，具体用法在工具 description |


## 二、知行方案设计

### 2.1 设计原则

1. **缓存优先**：所有设计决策都考虑 prompt cache 影响。system prompt 的静态区应在所有会话间共享。
2. **关注点分离**：system prompt 管"角色与原则"，工具定义管"如何使用"，project context 管"当前环境"。三者物理分离。
3. **渐进增强**：从极简 prompt 开始，通过 ZHIXING.md 和 rules 扩展，不在核心代码中硬编码大段指令。
4. **可测量**：每个 prompt 段落可独立计算 token 数，可 A/B 测试不同版本。

### 2.2 整体架构

```
┌──────────────────────────────────────────────────────┐
│                  API 请求结构                         │
├──────────────────────────────────────────────────────┤
│                                                      │
│  tools: [                                            │
│    { name: "read", description: "...", ... },        │
│    { name: "write", ... },                           │
│    ... (内置工具按名称排序)                            │
│    ← cache_control: ephemeral                        │
│  ]                                                   │
│                                                      │
│  system: "                                           │
│    [Identity]        ← 1 句话                        │
│    [Principles]      ← 核心工作原则                   │
│    [Tool Usage]      ← 工具使用偏好                   │
│    [Tone & Style]    ← 输出风格                       │
│    [Safety]          ← 安全边界                       │
│    __ZHIXING_CACHE_BOUNDARY__                        │
│    [Environment]     ← 工作目录、平台、时间            │
│  "                                                   │
│                                                      │
│  messages: [                                         │
│    {                                                 │
│      role: "user",                                   │
│      content: "                                      │
│        <context>                                     │
│          [ZHIXING.md 内容]                            │
│          [当前日期]                                   │
│          [Git 状态]                                   │
│        </context>                                    │
│                                                      │
│        用户的实际输入                                 │
│      "                                               │
│    },                                                │
│    ...                                               │
│  ]                                                   │
└──────────────────────────────────────────────────────┘
```

### 2.3 System Prompt — 五段式结构

#### Segment 1: Identity（身份）

```
You are Zhixing (知行), a personal intelligent assistant.
Your name means "unity of knowledge and action" — you understand problems and take action to solve them.
```

极简，2 句话。如果用户在 ZHIXING.md 中定义了 `## Personality` 段落，将覆盖此处。

#### Segment 2: Principles（工作原则）

```
## Principles
- Respond in the same language the user uses
- Read before edit: always read a file before modifying it
- Search before act: use glob/grep to discover files before reading
- Edit over write: prefer targeted replacement over full overwrite
- When a task requires action, use tools immediately without asking
- If a command fails, analyze the error and try an alternative
- Show reasoning when making non-obvious decisions
```

这些是"智能体行为"层面的原则，不是工具使用说明。

#### Segment 3: Tool Usage（工具使用偏好）

```
## Tool Usage
- Use `read` to view files, not bash cat/head/tail
- Use `grep` to search content, not bash grep/rg
- Use `edit` for targeted changes, not bash sed/awk
- Use `glob` to find files, not bash find
- For multiple independent tool calls, prefer parallel execution
```

这些指导 LLM 在有选择时优先使用哪个工具。

#### Segment 4: Tone & Style（输出风格）

```
## Style
- Be warm, concise, and natural
- Do not use emojis unless the user does
- Use markdown for code blocks and structure
- Keep responses focused — answer what was asked
```

#### Segment 5: Safety（安全边界）

```
## Safety
- Never execute destructive commands without explicit user request
- Do not access files outside the working directory without clear intent
- Refuse requests that could compromise system security
```

#### 分界标记

```
__ZHIXING_CACHE_BOUNDARY__
```

#### 动态段: Environment（环境信息）

```
## Environment
- Working directory: /path/to/project
- Platform: darwin arm64
- Node.js: v22.x.x
- Shell: zsh
```

放在分界后面，每次会话可能不同。

### 2.4 ZHIXING.md — 项目上下文

#### 发现与加载

```
1. ~/.zhixing/ZHIXING.md          ← 用户级（所有项目通用偏好）
2. ./ZHIXING.md 或 ./.zhixing/ZHIXING.md  ← 项目级
3. ./subdir/ZHIXING.md            ← 子目录级（按需加载）
```

更具体的层级覆盖更宽泛的（同 Claude Code）。

#### 注入方式

**不放入 system prompt**（借鉴 Claude Code 的核心洞察）。通过 `<context>` 标签注入到首条 user message 前：

```xml
<context>
# Project Instructions (ZHIXING.md)
[ZHIXING.md 内容]

# Current Date
2026-04-09

# Git Status
On branch main, clean working tree
</context>

用户的实际输入
```

**为什么不用 `<system-reminder>`**：我们用自己的标签名 `<context>`，更语义化、更简洁。

#### 预算控制

ZHIXING.md 内容受 token 预算限制（默认为有效上下文窗口的 5%）。超出时截断并附加提示：

```
[ZHIXING.md 内容超出预算，已截断为前 N 个字符。建议精简内容或拆分为 rules。]
```

### 2.5 工具描述策略

#### 双层设计


| 层级   | 位置                         | 内容                                     | 缓存影响       |
| ---- | -------------------------- | -------------------------------------- | ---------- |
| 通用原则 | system prompt Segment 3    | "Use read to view files, not bash cat" | 缓存友好，全会话共享 |
| 具体用法 | 工具 JSON Schema description | 每个工具的参数说明和使用示例                         | 随工具列表缓存    |


#### 精简原则

参考 Claude Code 的教训（工具定义 14-17K tokens），我们要控制工具描述的 token 开销：

- description 聚焦"做什么"和"关键参数"
- 不在 description 中嵌入完整使用教程
- 复杂指导放 ZHIXING.md 或 rules

#### 工具排序与缓存

- 内置工具按名称字母排序，列表末尾放 `cache_control`
- 未来添加 MCP/插件工具时，放在内置工具之后
- 工具列表变化不影响内置工具的缓存前缀

### 2.6 动态生成工具段落

当前 `system-prompt.ts` 中硬编码了工具说明，应改为从注册的工具列表动态生成：

```typescript
function buildToolUsageSection(tools: ToolDefinition[]): string {
  const toolNames = tools.map(t => t.name);
  const lines = ["## Tool Usage"];

  // 通用原则
  lines.push("- When a task requires action, use tools immediately");

  // 按工具类型生成偏好提示
  if (toolNames.includes("read")) {
    lines.push("- Use `read` to view files, not bash cat/head/tail");
  }
  if (toolNames.includes("grep")) {
    lines.push("- Use `grep` to search content, not bash grep/rg");
  }
  if (toolNames.includes("edit")) {
    lines.push("- Use `edit` for targeted changes, not bash sed/awk");
    lines.push("- Always read a file before editing to get exact text");
  }
  if (toolNames.includes("glob")) {
    lines.push("- Use `glob` to find files, not bash find");
  }

  return lines.join("\n");
}
```

这样添加/移除工具时，system prompt 自动适应，不需要手动维护。

## 三、与竞品的差异化

### 3.1 我们更好在哪


| 维度    | OpenClaw 问题             | Claude Code 问题                      | 知行方案                             |
| ----- | ----------------------- | ----------------------------------- | -------------------------------- |
| 代码复杂度 | system-prompt.ts 700+ 行 | prompts.ts 900+ 行 + 多个辅助            | **目标 <200 行**，段落注册制              |
| 项目上下文 | 8 个固定文件名白名单             | 7 层 CLAUDE.md + rules + auto memory | **ZHIXING.md 单文件**，简洁够用          |
| 缓存策略  | 中等复杂度                   | 5 个 sticky latch，极复杂                | **最小可用版**，渐进增强                   |
| 工具描述  | 写在 system prompt        | 嵌入工具 description（14-17K）            | **双层分离**，通用原则在 prompt，细节在 schema |
| 可扩展性  | 靠修改主函数                  | 靠 feature flags                     | **段落注册 API**，插件可注册新段落            |


### 3.2 借鉴的最佳实践


| 来源          | 实践                         | 我们如何采用                                     |
| ----------- | -------------------------- | ------------------------------------------ |
| Claude Code | CLAUDE.md 不进 system prompt | ZHIXING.md 通过 `<context>` 注入 user messages |
| Claude Code | 身份定义极简                     | 2 句话身份，不过度约束                               |
| Claude Code | 缓存分界标记                     | `__ZHIXING_CACHE_BOUNDARY__`               |
| Claude Code | 工具排序保护缓存                   | 内置工具按名称排序 + 尾部 cache_control               |
| OpenClaw    | Bootstrap 文件有预算            | ZHIXING.md 有 token 预算上限                    |
| OpenClaw    | Skills 快照复用                | 首次解析的 prompt 段落缓存在 session 中               |
| 两者          | 时间信息不放 system              | 日期通过 `<context>` 注入                        |


### 3.3 故意不做的


| 功能                | 原因                    |
| ----------------- | --------------------- |
| 7 层记忆层级           | 过度设计，ZHIXING.md 3 层足够 |
| Auto Memory       | 需要长期运行数据积累，当前无必要      |
| Sticky Latch      | 我们还没有产品级缓存经济模型        |
| `DANGEROUS`_ 命名约定 | 等缓存优化成为实际瓶颈时再引入       |
| MCP 延迟加载          | 等 MCP 集成完成后再考虑        |
| Skills 系统         | 等插件架构完成后再考虑           |


## 四、渐进实现路线

每步独立可验证。

### Phase 3A-1: 重构 system-prompt.ts（分段式）

**做什么**：

- 将现有的硬编码字符串重构为分段注册模式
- 5 个核心段落各为独立函数
- 工具使用段从注册的工具列表动态生成
- 添加 `__ZHIXING_CACHE_BOUNDARY__` 分界标记

**验证**：

- 现有功能不变（回归测试）
- `buildSystemPrompt()` 输出包含分界标记
- 添加/移除工具后，工具使用段自动变化

**交付**：

- `packages/cli/src/system-prompt.ts` 重构

### Phase 3A-2: ZHIXING.md 加载

**做什么**：

- 从项目根目录加载 `ZHIXING.md` 或 `.zhixing/ZHIXING.md`
- 从用户目录加载 `~/.zhixing/ZHIXING.md`
- 项目级覆盖用户级
- 内容通过 `<context>` 标签注入到首条 user message

**验证**：

- 在项目根创建 `ZHIXING.md` 写入 "Always respond in English"
- 运行 `zhixing` 用中文提问，验证 LLM 用英文回复

**交付**：

- `packages/core/src/context/project-context.ts`（加载逻辑）
- `packages/cli/src/run-agent.ts`（注入逻辑）

### Phase 3A-3: 缓存友好的 Prompt 结构

**做什么**：

- Provider adapter 检测 `__ZHIXING_CACHE_BOUNDARY__` 标记
- Anthropic adapter: 拆分 system text block，stable prefix 附加 cache_control
- OpenAI adapter: 忽略标记（OpenAI 目前无 prompt cache API）

**验证**：

- 使用 Anthropic provider 时，API 请求中 system 被拆为两个 content block
- 观察 API 响应中 cache_read_input_tokens > 0（第二轮起）

**交付**：

- `packages/providers/src/adapters/anthropic-messages.ts`（cache_control 逻辑）

### Phase 3A-4: Token 校准接通

**做什么**：

- 从 Agent Loop 的 `AgentResult.usage` 取出真实 token 数
- 回调 `estimator.calibrate(estimated, actual)`
- 在 CLI 的 `/usage` 命令中显示校准因子

**验证**：

- 运行几轮对话后，`/usage` 显示的估算值偏差 <15%

**交付**：

- `packages/cli/src/run-agent.ts`（接通校准）

## 五、核心类型设计

```typescript
// ─── 系统提示词段落 ───

interface PromptSegment {
  /** 段落标识符 */
  id: string;
  /** 段落优先级（越小越靠前） */
  priority: number;
  /** 是否放在缓存分界前（静态区） */
  cacheable: boolean;
  /** 生成段落内容 */
  build(context: PromptBuildContext): string;
}

interface PromptBuildContext {
  /** 注册的工具列表 */
  tools: ToolDefinition[];
  /** 工作目录 */
  cwd: string;
  /** 平台信息 */
  platform: string;
  /** 模型 ID */
  model: string;
}

// ─── 项目上下文 ───

interface ProjectContext {
  /** ZHIXING.md 内容（合并后） */
  instructions: string | null;
  /** 当前日期 */
  date: string;
  /** Git 状态摘要 */
  gitStatus?: string;
}

// ─── 组装结果 ───

interface AssembledPrompt {
  /** 系统提示词（含缓存分界标记） */
  systemPrompt: string;
  /** 项目上下文（注入到首条 user message） */
  projectContext: ProjectContext | null;
}
```

## 六、决策记录

### ADR-006: 为什么 ZHIXING.md 不进 system prompt

**背景**：ZHIXING.md 是用户/项目特定的内容，每个项目不同。

**决策**：通过 `<context>` 标签注入到 user messages，不放入 system prompt。

**理由**：

- system prompt 的静态区应在所有会话间共享，最大化缓存命中
- CLAUDE.md → system prompt 会导致每个项目一个缓存实例，缓存价值归零
- Anthropic 的 prompt cache 是字节精确的前缀匹配，任何差异都会导致缓存未命中
- 放在 user messages 中不影响 LLM 对指令的遵循（Claude 对 `<system-reminder>` 类标签有特殊处理）

**风险**：放在 user messages 中的指令可能比 system prompt 中的优先级低。通过实际测试验证效果。

### ADR-007: 为什么只用 3 层而非 7 层

**背景**：Claude Code 有 7 层记忆（组织→用户→项目→rules→local→auto→子目录）。

**决策**：知行只实现 3 层（用户→项目→子目录），不做 rules、auto memory 和组织级。

**理由**：

- 7 层的复杂度与收益不成正比，大多数用户只用项目级 CLAUDE.md
- Auto Memory 需要长期运行数据和 dreaming 系统，实现成本极高
- 组织级需要部署基础设施，超出 CLI 工具范畴
- 渐进策略：先做最小集合，验证价值后再扩展

