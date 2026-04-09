# OpenClaw — 系统提示词与上下文组装

> **分析状态**: ✅ 已完成（2026-04-09）
> **源码版本**: openclaw-main 本地副本
> **关联**: `architecture-overview.md`、`context-management.md`

## 一、核心文件地图

| 职责 | 路径 |
|------|------|
| 系统提示词主拼装 | `src/agents/system-prompt.ts` → `buildAgentSystemPrompt()` |
| Embedded 入口适配 | `src/agents/pi-embedded-runner/system-prompt.ts` |
| 每轮 Prompt 构建管线 | `src/agents/pi-embedded-runner/run/attempt.ts` |
| 工作区 Bootstrap 文件 | `src/agents/workspace.ts`、`bootstrap-files.ts`、`bootstrap-cache.ts` |
| Bootstrap Hook | `src/hooks/bundled/bootstrap-extra-files/handler.ts` |
| 缓存分界 | `src/agents/system-prompt-cache-boundary.ts` |
| Anthropic 缓存策略 | `src/agents/anthropic-payload-policy.ts` |
| 提示词稳定性工具 | `src/agents/prompt-cache-stability.ts` |
| Skills 系统 | `src/agents/skills/workspace.ts` |
| Context Engine | `src/context-engine/` |
| 插件 Hook 类型 | `src/plugins/types.ts`、`src/plugins/hooks.ts` |

## 二、系统提示词结构

`buildAgentSystemPrompt()` 按固定顺序拼装，最终产物是一个大字符串：

```
┌─────────────────────────────────────────────────────┐
│  静态前缀（Stable Prefix） — 可缓存                  │
│                                                      │
│  1. 开场白："You are a personal assistant running     │
│     inside OpenClaw."                                │
│  2. ## Tooling — 工具列表与策略说明                   │
│  3. ## Tool Call Style — 审批/exec 行为规范           │
│  4. ## Safety — 安全规则                             │
│  5. ## OpenClaw CLI Quick Reference                  │
│  6. ## Skills (mandatory) — skillsPrompt             │
│  7. ## Memory — 记忆插件段落                         │
│  8. 条件块: Self-Update / Model Aliases / 时区       │
│  9. ## Workspace — 工作目录与沙箱说明                │
│ 10. ## Documentation — 文档路径                      │
│ 11. ## Sandbox — 沙箱配置                            │
│ 12. ## Authorized Senders                            │
│ 13. ## Current Date & Time — 仅时区，不含具体时刻     │
│ 14. # Project Context — Bootstrap 文件内容注入       │
│     ## <AGENTS.md 路径>                              │
│     ## <SOUL.md 路径>                                │
│     ## <TOOLS.md 路径>                               │
│     ... (按文件名固定顺序)                            │
│                                                      │
├── <!-- OPENCLAW_CACHE_BOUNDARY --> ─────────────────┤
│                                                      │
│  动态后缀（Dynamic Suffix） — 每轮可变              │
│                                                      │
│ 15. ## Group Chat Context / Subagent Context         │
│ 16. Heartbeat                                        │
│ 17. ## Runtime — 单行摘要（repoRoot、provider 等）   │
└─────────────────────────────────────────────────────┘
```

### 关键设计决策

1. **时间处理**：具体时刻不写入 system prompt（会破坏缓存），而是通过 `session_status` 工具查询
2. **条件块策略**：不影响缓存的条件块放在 stable prefix 中；频繁变化的放在 boundary 后
3. **Bootstrap 截断警告**：放在 user prompt（非 system），避免 system 变化

## 三、Bootstrap 文件系统

### 3.1 文件名白名单与加载顺序

`workspace.ts` 的 `loadWorkspaceBootstrapFiles()` 按固定顺序读取：

```
AGENTS.md → SOUL.md → TOOLS.md → IDENTITY.md → USER.md →
HEARTBEAT.md → BOOTSTRAP.md → MEMORY.md / memory.md
```

每个文件的内容注入到 system prompt 的 `# Project Context` 段落下，以 `## <文件绝对路径>` 为标题。

### 3.2 Bootstrap 预算管理

`buildBootstrapContextFiles()` 对所有文件的总字数设置预算上限。当超出预算时：
- 按优先级（文件顺序）分配
- 可做 head/tail 截断并写入占位说明
- 截断警告追加到 user prompt 而非 system prompt

### 3.3 Bootstrap 缓存

`getOrLoadBootstrapFiles()` 按 `sessionKey` 缓存"根目录读盘结果"：
- 同一会话内不重复读文件系统
- Session rollover 时通过 `clearBootstrapSnapshotOnSessionRollover` 清缓存

### 3.4 Bootstrap Hook 扩展

`bootstrap-extra-files` 内置 Hook 允许按 glob 模式额外加载文件，但文件名必须在白名单内（防止任意文件注入）。

### 3.5 子代理/Cron 场景

`filterBootstrapFilesForSession()` 收窄为精简白名单（`AGENTS`、`TOOLS`、`SOUL`、`IDENTITY`、`USER`），降低子任务的上下文开销。

## 四、Skills 系统

Skills 与 Context Engine 是独立的两套系统。

### 4.1 加载优先级（后者覆盖同名 Skill）

```
extra < bundled < managed < personal < project < workspace
```

### 4.2 预算与降级

`applySkillsPromptLimits()` 的处理流程：
1. 先限制数量（丢弃低优先级 skill）
2. 全量格式 vs 紧凑格式 之间降级
3. 仍超长则二分法砍掉部分 skill

### 4.3 会话级快照

首次解析后的 `skillsPrompt` 缓存在 session 中，后续 turn 直接复用。

## 五、Prompt 构建管线（每轮 attempt）

`runEmbeddedAttempt()` 中与 LLM 调用相关的完整顺序：

```
1. resolveSkillsPromptForRun()
   └ 优先用 session 快照，否则从 entries 现算

2. resolveBootstrapContextForRun()
   └ 读取 Bootstrap 文件 → Hook 扩展 → 预算截断 → 返回 contextFiles

3. buildEmbeddedSystemPrompt() → buildAgentSystemPrompt()
   └ 生成基础 systemPromptText → 写入 Pi session

4. 打开 session → Context Engine bootstrap（仅新会话）

5. contextEngine.assemble()
   └ 可替换 messages
   └ 可选 systemPromptAddition → prepend 到 cache boundary 之后

6. resolvePromptBuildHookResult()  ← 插件 before_prompt_build Hook
   │
   ├ prependContext      → 拼到 user prompt 前面（不动 system）
   ├ systemPrompt        → 整体覆盖 session system（首个非空胜出）
   ├ prependSystemContext → prepend 到 base system 前（利于缓存）
   └ appendSystemContext  → append 到 base system 后（利于缓存）

7. cache 观测 beginPromptCacheObservation()

8. effectivePrompt + messages → Pi session.prompt()
```

### Hook 合并语义

```typescript
// systemPrompt: 首个非空值胜出（高优先级插件覆盖）
systemPrompt: firstDefined(acc?.systemPrompt, next.systemPrompt)

// context 字段: 串联拼接
prependContext: concat(acc, next)
prependSystemContext: concat(acc, next)
appendSystemContext: concat(acc, next)
```

## 六、缓存优化策略

### 6.1 文本分界

`SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n"`

将 system prompt 分为 stable prefix 和 dynamic suffix。注释明确说明：
> "Keep large stable prompt context above this seam so Anthropic-family transports can reuse it across labs and turns."

### 6.2 Anthropic 传输层处理

`applyAnthropicPayloadPolicyToParams()` 在检测到分界标记时：
- 将 system 文本拆成两个 content block
- stable prefix block → 附加 `cache_control: { type: "ephemeral" }`
- dynamic suffix block → 不附加缓存控制
- 最后一条 user message 也单独附加 `cache_control`

### 6.3 稳定性保障

`normalizeStructuredPromptSection()` 统一换行与行尾空白，减少不必要的指纹/缓存键变化。`normalizePromptCapabilityIds()` 对 capability ID 排序，避免随机顺序差异破坏缓存。

### 6.4 Context Engine 追加的放置规则

`prependSystemPromptAdditionAfterCacheBoundary()` 在检测到分界标记时，将 addition 插入到 dynamic suffix 侧，保护 stable prefix 的缓存键。

## 七、Context Engine

### 7.1 接口设计

```typescript
interface ContextEngine {
  bootstrap?(params): Promise<BootstrapResult>;
  maintain?(params): Promise<void>;
  ingest?(params): Promise<void>;
  assemble(params): Promise<AssembleResult>;
  compact(params): Promise<CompactResult>;
  afterTurn?(params): Promise<void>;
}
```

### 7.2 Legacy 引擎

默认的 legacy 引擎行为简单：
- `assemble`: 透传消息不修改
- `compact`: 委托内置 compaction 逻辑

插件可注册替换引擎以改变上下文组装行为。

### 7.3 两种 "Bootstrap"

| 概念 | 含义 | 入口 |
|------|------|------|
| 工作区 Bootstrap | 从项目根目录加载 AGENTS.md 等文件 | `loadWorkspaceBootstrapFiles()` |
| Context Engine Bootstrap | 引擎初始化内部存储 | `contextEngine.bootstrap()` |

名称相近但职责不同。

## 八、核心洞察

1. **项目上下文通过文件名白名单加载**：固定文件名（AGENTS.md、SOUL.md 等），按固定顺序，有预算上限。简单但够用。

2. **缓存分界是一等概念**：整个 prompt 构建流程围绕 `OPENCLAW_CACHE_BOUNDARY` 组织，所有修改都必须考虑自己落在哪一侧。

3. **插件通过 Hook 注入而非替换**：`prependContext`（user 侧）和 `prependSystemContext`/`appendSystemContext`（system 侧）提供了不同的注入点，每种都有缓存影响的考量。

4. **Bootstrap 文件有预算**：不是无限制地加载，而是按优先级分配预算、超出截断。

5. **Skills 和 Bootstrap 是两套独立系统**：Skills 走 XML 格式进入 `## Skills` 章节；Bootstrap 走文件内容进入 `# Project Context` 章节。

6. **时间信息故意不放 system prompt**：具体时刻通过工具获取，时区信息放在 stable prefix。这是缓存友好的设计。
