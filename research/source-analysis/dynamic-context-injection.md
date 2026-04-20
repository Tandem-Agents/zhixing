# 动态上下文注入：三方架构对比

> 调研动机：知行的 system prompt 是静态的（session 级一次性构建），定时任务状态等 per-turn 动态信息无法注入。
> 本文对比 openclaw / hermes / claude-code 三个参考项目的方案，为知行的 16d（任务状态注入）及后续 Layer 3 接入提供架构依据。

---

## 核心发现

三个项目不约而同采用 **"静态 system prompt + 动态 per-turn 注入"** 的分层架构，但注入点不同：

| 项目 | System Prompt | Per-Turn 动态注入点 | Cache 策略 |
|------|-------------|---------------------|-----------|
| **OpenClaw** | 静态前缀 + 动态后缀（cache boundary 分隔） | system prompt 尾部 + plugin hook + context engine | 前缀全局缓存，后缀不缓存 |
| **Hermes** | 完全静态（session 级缓存，不 per-turn 重建） | user message 注入（memory prefetch / plugin context） | system prompt 永不变，动态内容在 user message 里 |
| **Claude Code** | 静态前缀 + 动态 section registry | `<system-reminder>` 标签注入 user message | global / org / ephemeral 三级缓存 |

**共识原则：per-turn 变化的内容不放 system prompt 前缀，避免打破 prompt cache。**

---

## OpenClaw：Cache Boundary + Plugin Hook

### 架构

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

- **`SYSTEM_PROMPT_CACHE_BOUNDARY`** 标记将 system prompt 分为缓存区和非缓存区
- **Context Engine** 每轮 `assemble()` 返回 `systemPromptAddition`，注入到 system prompt 尾部
- **Plugin Hook** 提供三个注入点：system prompt 前/后 + user prompt 前
- **当前时间**在 `buildSystemPromptParams()` 中构建，嵌入 system prompt Runtime 段（session 级，非 per-turn）

### 定时任务状态

- 有 cron 工具但 **不注入活跃任务状态到 system prompt**
- AI 知道 cron 工具的存在，但不知道当前有哪些定时任务

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

### 架构

```
System Prompt（完全静态，session 级构建一次，永不 per-turn 重建）:
  ┌─────────────────────────────┐
  │  身份 + 记忆 + 技能指南       │
  │  工具指南 + 上下文文件         │
  │  时间戳 + 平台提示            │  ← frozen at build time
  └─────────────────────────────┘

Per-Turn 注入（全部在 user message 里）:
  ┌─────────────────────────────┐
  │  [原始 user message]         │
  │  + <memory-context>          │  ← 外部记忆 prefetch
  │  + [plugin pre_llm_call]     │  ← 插件动态上下文
  └─────────────────────────────┘
```

### 关键设计

- **System prompt 永不 per-turn 重建**：`_cached_system_prompt` 只在 session 首轮构建或从 SQLite 恢复
- **动态内容注入到 user message**：memory prefetch + plugin context append 到当前轮 user message 末尾
- **明确的设计原则**：
  > "per-turn changing information is NEVER in the system prompt"
  > "User identity in shared threads doesn't go in system prompt — it changes per-turn and would bust the prompt cache"
- **Ephemeral system prompt**：一次性 override，不是 per-turn 的
- **Todo state**：在 context compression 时注入为合成 user message，不在 system prompt 里
- **当前时间**：baked into system prompt（`Conversation started: ...`），session 级冻结

### 定时任务状态

- Scheduler 独立运行，**agent 不知道当前有哪些定时任务**
- 定时任务结果通过 gateway 投递到配置的通道
- 无 per-turn 任务状态注入

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

### 架构

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
- **三级缓存**：`global`（跨 org）/ `org`（组织内）/ `null`（ephemeral，不缓存）
- **当前日期**：通过 `<system-reminder>` 每轮注入（`Today's date is 2026-04-20.`）
- **Attachment 异步 prefetch**：memory / skill / file-change 在 turn 中异步加载注入

### Todo/任务状态

- `TodoWrite` 工具管理待办列表
- Todo 状态通过 `<system-reminder>` 注入：`"your todo list is currently empty"` 或当前任务列表
- **这是三个项目中唯一将任务状态注入到 per-turn 上下文的**

### 关键文件

| 文件 | 内容 |
|------|------|
| `src/constants/prompts.ts:491-558` | `getSystemPrompt()` + section registry |
| `src/constants/systemPromptSections.ts` | Section 注册 + 缓存策略 |
| `src/utils/api.ts:449-474` | `prependUserContext()` system-reminder 注入 |
| `src/query.ts:660` | Per-turn message 构建入口 |
| `src/utils/attachments.ts:2937` | Attachment 异步注入 |

---

## 对知行的启示

### 1. 注入位置：user message 而非 system prompt

三个项目的共识：**per-turn 动态内容不放 system prompt 前缀**。

- Hermes 最激进：system prompt 完全静态，动态内容全在 user message
- Claude Code 折中：system prompt 有 section registry（部分段 per-turn 重算），但高频变化内容用 `<system-reminder>` 注入 user message
- OpenClaw 最灵活：system prompt 有 cache boundary 分区，但也支持 user prompt 注入

### 2. 任务状态注入：只有 Claude Code 做了

- OpenClaw 和 Hermes 的定时任务调度器都**不注入活跃任务状态**到 AI 上下文
- 只有 Claude Code 通过 `<system-reminder>` 注入 todo 状态
- 这意味着这是一个"高级特性"，不是标配——但对知行的定时任务场景是刚需

### 3. Prompt Cache 友好

所有项目都将 prompt cache 作为核心设计约束：
- System prompt 的稳定前缀必须 cache-friendly
- 动态内容放在 cache boundary 之后或 user message 里
- 知行目前的静态 system prompt 天然 cache-friendly，动态注入应保持这一优势

### 4. 推荐方案

基于三方调研，知行 16d 的推荐注入方式：

**采用 Claude Code 的 `<system-reminder>` 模式**：在当前轮 user message 前注入动态上下文，不修改 system prompt。

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

优点：
- 不打破 system prompt cache
- Per-turn 动态，每次 run 都是最新状态
- 与 Hermes/Claude Code 的成熟模式对齐
- 不需要重构 system prompt 构建链路
- REPL 和 serve 用同一个注入逻辑
