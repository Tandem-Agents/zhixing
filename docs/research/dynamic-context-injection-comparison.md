# 动态上下文注入：三方架构对比

> 本文比较动态上下文的注入位置、更新时机与缓存取舍，供架构选型参考；知行的现行实现见末节。
>
> 外部实现属于原研究材料，材料未锁定版本、commit 或完整来源链，不代表外部项目最新版。下文图示与行号保留为研究线索，不承诺精确复现或当前适用；尤其 Claude Code 不同材料的版本不能混作同一份源码。`per-turn` 沿用各材料术语，不直接等同于知行的一次用户 Run 或每次模型调用。

---

## 核心发现

三种方案采用 **“静态 system prompt + 动态 per-turn 注入”** 的分层思路，区别在于动态内容的注入位置：既可以追加到 system 的动态区，也可以通过消息注入。

| 项目 | System Prompt | Per-Turn 动态注入点 | Cache 策略 |
|------|-------------|---------------------|-----------|
| **OpenClaw** | stable prefix + dynamic suffix（cache boundary 分隔） | system prompt 动态区 + plugin hook + context engine | 原研究描述显式缓存控制优先覆盖稳定区；不代表后缀绝不缓存或跨用户共享 |
| **Hermes** | 原稿描述 session 级 `_cached_system_prompt` 复用 | user message 注入（memory prefetch / plugin context） | 应用侧复用 system 文本，动态内容另入消息；不等于服务端必然命中 |
| **Claude Code** | 原稿描述静态前缀 + section registry，内部机制待来源复核 | 原稿描述 `<system-reminder>` 包装用户上下文与附件 | 原稿的 global / org / null 为材料中的范围标记，不能直接当作服务端共享或缓存保证 |

**让高频变化内容避开稳定前缀，减少缓存失效。** 应用侧的提示文本／段落计算缓存与模型服务端的 prompt cache 是不同层次；动态 system 后缀仍是可选注入位置，缓存命中取决于具体协议与请求。

---

## OpenClaw：Cache Boundary + Plugin Hook

### 架构（原研究示意）

```
System Prompt:
  ┌─────────────────────────────┐
  │  静态区域（缓存友好）         │  ← 工具定义、身份、指南
  │  <!-- CACHE_BOUNDARY -->     │
  │  动态区域（per-turn）         │  ← context engine 注入、plugin 注入
  └─────────────────────────────┘

Per-Turn 注入:
  1. context engine → assembled.systemPromptAddition → prepend 到 system prompt 动态区
  2. plugin before_prompt_build hook → prependSystemContext / appendSystemContext / prependContext
  3. prependContext → 注入到 user prompt 前面（非 system prompt）
```

### 关键设计

- **`SYSTEM_PROMPT_CACHE_BOUNDARY`** 标记将 system prompt 分为稳定区与动态区；标记本身不是模型服务端缓存开关，需由传输层解释
- **Context Engine** 每轮 `assemble()` 返回 `systemPromptAddition`，注入到 system prompt 尾部
- **Plugin Hook** 提供三个注入点：system prompt 前/后 + user prompt 前
- **时间信息的粒度需复核**：原稿称当前时刻冻结于 Runtime 段，但相邻 OpenClaw 提示词研究描述的是稳定时区信息、具体时刻由工具取得。两稿口径冲突，不能据此把启动时刻写成确定实现；仍应区分时区、会话起始时间和实时钟

### 定时任务状态

- 原稿未记录活跃 cron 状态自动注入 system prompt 的链路。
- 未记录自动注入，不等于模型无法通过工具查询或其他输入获知任务；本材料不足以断言产品不存在该能力。

### 关键文件

| 文件 | 内容 |
|------|------|
| `src/agents/system-prompt.ts:196-765` | 主 system prompt 构建器 |
| `src/agents/pi-embedded-runner/run/attempt.ts:1186-1509` | Per-turn context assembly + plugin hook |
| `src/agents/system-prompt-cache-boundary.ts` | Cache boundary 处理 |
| `src/agents/system-prompt-params.ts:35-60` | Runtime 参数（时间、时区） |
| `src/context-engine/types.ts:178-188` | Context engine 返回 systemPromptAddition |

---

## Hermes：静态 System Prompt + User Message 注入

### 架构（原研究示意）

```
System Prompt（原稿所述 session 级文本缓存）:
  ┌─────────────────────────────┐
  │  身份 + 记忆 + 技能指南       │
  │  工具指南 + 上下文文件         │
  │  时间戳 + 平台提示            │  ← frozen at build time
  └─────────────────────────────┘

原稿列出的 Per-Turn 注入（user message）:
  ┌─────────────────────────────┐
  │  [原始 user message]         │
  │  + <memory-context>          │  ← 外部记忆 prefetch
  │  + [plugin pre_llm_call]     │  ← 插件动态上下文
  └─────────────────────────────┘
```

### 关键设计

- **System prompt 文本复用**：原稿所述 `_cached_system_prompt` 在 session 首轮构建或从 SQLite 恢复；这是所分析路径，不据此断言所有入口和版本永不重建
- **动态内容注入到 user message**：memory prefetch + plugin context append 到当前轮 user message 末尾
- **明确的设计原则**：
  > "per-turn changing information is NEVER in the system prompt"
  > "User identity in shared threads doesn't go in system prompt — it changes per-turn and would bust the prompt cache"
- **Ephemeral system prompt**：一次性 override，不是 per-turn 的
- **Todo state**：在 context compression 时注入为合成 user message，不在 system prompt 里
- **当前时间**：baked into system prompt（`Conversation started: ...`），session 级冻结

### 定时任务状态

- 原稿描述 Scheduler 独立运行，但这不等于 agent 无法查询任务状态
- 定时任务结果通过 gateway 投递到配置的通道
- 原稿未记录活跃调度任务的逐轮自动注入；应与前述压缩时注入 Todo 状态分开判断

### 关键文件

| 文件 | 内容 |
|------|------|
| `run_agent.py:2694-2853` | `_build_system_prompt()` 静态构建 |
| `run_agent.py:7496-7577` | Per-turn message 构建 + user message 注入 |
| `run_agent.py:7375-7408` | Plugin `pre_llm_call` hook |
| `gateway/session.py:187-325` | Gateway 动态 session 上下文 |
| `agent/memory_manager.py:146-184` | Memory prefetch + `<memory-context>` 包装 |

---

## Claude Code：Section Registry + System-Reminder 标签

原稿给出了符号和行号，但没有能将这些内部机制绑定到同一版本的来源链。[现存架构研究](../../research/source-analysis/claude-code/architecture-overview.md)也指出本地逆向、早期重写源码和后期索引不是同一版本。以下保留为原稿描述的设计参照，内部注册、刷新与缓存范围均待独立核实，不作为已证实的客户端合同。

### 架构（原稿描述，内部机制待核实）

```
System Prompt（section registry 管理）:
  ┌─────────────────────────────────┐
  │  静态指令（global cache scope）   │
  │  __DYNAMIC_BOUNDARY__            │
  │  动态 sections（org/null scope） │  ← session_guidance, memory, env_info, mcp_instructions...
  └─────────────────────────────────┘
  
  Section Registry:
    systemPromptSection('name', compute)                     → 缓存到 /clear
    DANGEROUS_uncachedSystemPromptSection('name', compute)   → 每轮重算

Per-Turn 注入（<system-reminder> 标签）:
  ┌─────────────────────────────────┐
  │  <system-reminder>               │
  │    # claudeMd                    │  ← CLAUDE.md 内容
  │    # currentDate                 │  ← 当前日期
  │    # userEmail                   │
  │  </system-reminder>              │
  │  [user message]                  │
  └─────────────────────────────────┘

  Attachments（per-turn 异步注入）:
    - edited_text_file   → 文件变更追踪
    - pendingMemoryPrefetch → 记忆检索
    - skillPrefetch      → 技能发现
    - queued commands     → 任务通知
```

### 关键设计

- **Section Registry 模式**：每个 system prompt 段注册为 cached 或 uncached，`resolveSystemPromptSections()` 并行解析
- **`<system-reminder>` 标签**：动态上下文注入到 user message 体内，不在 system prompt 里
  - `prependUserContext()` 在首条 user message 前注入 CLAUDE.md + currentDate
  - `wrapInSystemReminder()` 包装各种附件
- **缓存范围标记**：原稿解释 `global` / `org` / `null` 为不同范围；这不能证明模型服务端跨组织共享缓存，`ephemeral` 也不能直接解释为“不缓存”
- **当前日期**：原稿示例为 `Today's date is 2026-04-20.`；示例证明材料包含日期，不能单独证明每轮刷新，刷新时机需结合调用链核实
- **Attachment 异步 prefetch**：memory / skill / file-change 在 turn 中异步加载注入

### Todo/任务状态

- `TodoWrite` 工具管理待办列表
- Todo 状态通过 `<system-reminder>` 注入：`"your todo list is currently empty"` 或当前任务列表
- 这里的 Todo 是会话待办，不是 cron 调度任务；不能与另两节的调度状态混比后推出“唯一支持任务状态注入”

### 关键文件

| 文件 | 内容 |
|------|------|
| `src/constants/prompts.ts:491-558` | `getSystemPrompt()` + section registry |
| `src/constants/systemPromptSections.ts` | Section 注册 + 缓存策略 |
| `src/utils/api.ts:449-474` | `prependUserContext()` system-reminder 注入 |
| `src/query.ts:660` | Per-turn message 构建入口 |
| `src/utils/attachments.ts:2937` | Attachment 异步注入 |

---

## 对知行的研究价值与当前实现

### 1. 注入位置：保护稳定前缀，而非固定标签或唯一通道

把高频状态放在当前用户消息前部，可以保护稳定提示前缀；各入口共用注入逻辑，可以避免状态口径分裂。这两项取舍不依赖特定标签。

- Hermes 材料侧重 system 文本复用、动态信息入消息。
- Claude Code 材料描述分段计算与 reminder／附件两条路径，内部实现仍受上文证据边界约束。
- OpenClaw 材料提供 system 动态区与 user prompt 多种注入点，体现可选择的位置与缓存代价。

### 2. 状态种类与感知方式必须分别比较

- 调度任务、会话 Todo、任务完成通知是不同职责；自动注入、按需查询、压缩时回填也是不同机制。
- 知行需要及时感知当前时间、活跃调度及近期结果，才能基于当前状态回答和行动；竞品是否提供这一能力不决定它对知行的价值。

### 3. Prompt Cache 友好

稳定文本复用、分区和消息注入都是减少无关前缀变化的手段。把动态内容放到边界之后或消息中，只保护其前面的稳定部分；实际命中仍取决于 provider 的缓存协议、请求前缀、模型、有效期等条件。应用侧 `_cached_system_prompt`、段落计算缓存和服务端 prompt cache 应分别说明。

### 4. 原推荐示意与已实现的知行路径

以下保留旧 16d 的内容示意，展示时间与调度状态如何位于用户输入前；不是当前标签、格式或完整字段合同：

```
<system-reminder>
[当前时间] 2026-04-20 15:50:54 (Asia/Shanghai)

[定时任务状态]
- ✓ "5秒后提醒" — 已完成 (15:45:30)
- ✓ "查看桌面" — 已完成 (15:40:12)  
- ○ "每日早报" — 下次执行 08:00
</system-reminder>

{用户原始消息}
```

知行已通过 [TurnContextInjector](../../packages/core/src/context/turn-context.ts) 组合 `<turn-context>`，在[模型循环构建发送视图](../../packages/core/src/loop/agent-loop.ts)时注入最新 user 消息的首个文本块前部，而非仅在用户 Run 开始时拼接一次。它保留原始消息，动态状态不写进 system prompt。

当前来源包括运行体装配的时间 Provider，以及[宿主统一贡献](../../packages/cli/src/runtime/turn-context-providers.ts)的调度和会话任务列表 Provider。状态读取与业务写权分离，各运行入口复用同一装配方式；这已承接旧稿“及时感知、前缀稳定、入口一致”的意图，不再是待实施方案。调度状态感知不等于主动通知，也不保证来源无延迟或全请求缓存命中。

具体合同、跳过行为和实现边界由[逐轮上下文注入](../modules/context/turn-context-injection.md)统一说明，本研究不重复定义。
