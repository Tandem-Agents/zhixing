# 上下文管理 · v3 重构方向 (Context Management v3 Redesign)

> **状态**: 📐 核心设计已敲定（2026-05-11），spec 阶段未启动
>
> **定位**: 知行上下文管理的目标架构——以 **cache 第一优先 + 优质注意力窗口 + 段式管理** 为核心范式。
>
> **关联**:
> - [context-architecture.md](./context-architecture.md) — v1.2 数据层权威
> - [../insights/_draft-prompt-cache-claude-code.md](../../insights/_draft-prompt-cache-claude-code.md) — Anthropic prompt cache 经验 + 经济视角 + attention 真实边界（v3 物理依据）
> - [llm-summarization.md](./llm-summarization.md) — LLM 摘要范式
> - [conversation-model.md](./conversation-model.md) — Conversation / Transcript 数据模型

---

## 一、核心理念

围绕两条 LLM 物理约束建系统：

1. **Cache prefix 必须稳定**——Anthropic 元规则①「前缀里任何位置的变化都会让其后所有内容的缓存失效」。Cache 命中是基础设施级别约束，不是优化项。
2. **LLM 注意力在远小于总窗口的 token 范围内最优**——RULER / NoLiMa 等业界 benchmark 共识，标称 1M 模型实际可靠 50-65%；32K 是 NoLiMa 50% 衰减阈值。

三条派生设计原则：

- **段内 append-only + tools[] byte-equal** → cache 完美命中
- **窗口按 token + 按模型驱动**（不按轮）→ 对齐 attention 物理特性
- **触顶整段切（事件式）** → 段切换走 Anthropic 经验 7「缓存安全分叉」，几乎免费

---

## 二、物理依据

### 2.1 Cache 经济（继续累积 vs 新开摘要）

边际成本相等临界点 N\* 公式：

```
N* = [(p_miss / p_hit) × (S + M) - S] / (u + a)
```

DeepSeek-V4-Pro 2.5 折下 `p_miss / p_hit = 120 倍`，典型场景 N\* ≈ 数百到数千轮。

**结论**：只要前缀稳定，继续累积永远比"新开+摘要"经济划算。**cache 不是要省的东西，是要保的东西**。

### 2.2 Attention 真实边界

| 模型 | 总窗口 | 注意力舒适区上限 | 警戒区 |
|---|---|---|---|
| DeepSeek-V4-Pro | 1M | ~128K | >128K |
| GLM-5.1 | 200K | ~16K | >32K |
| 业界基线（RULER / NoLiMa） | — | 标称 50-65% | NoLiMa 32K 50% 衰减 |

**结论**：attention 衰减是硬约束（远早于 cache 经济临界点）；段内累积要在 attention 阈值之前停下。

### 2.3 双约束并存的设计含义

- 段内：cache 满命中收益是确定的 120 倍 → 必须 append-only，不能动 prefix
- 触顶：在 attention 阈值前主动切段 → 一次性压缩，符合经验 7「缓存安全分叉」
- 段切换：复用上一段完整 cache 做压缩请求 → 边际成本仅压缩指令本身

---

## 三、ModelCapability：双档阈值与模型驱动

每个模型内置两个 attention 阈值。两档之间是优质注意力区间，超过 risk 阈值意味着注意力已进入下滑区。

### 3.1 配置接口

```typescript
interface ModelCapability {
  modelId: string;
  contextWindow: number;       // 总窗口（物理硬上限）
  optimalMaxTokens: number;    // 注意力最好阈值上限
  riskMaxTokens: number;       // 注意力风险阈值（开始下滑）
}
```

### 3.2 数据归属与覆盖路径

ModelCapability 是**知行代码内置的领域知识**（公开 benchmark 数据），不是用户配置。归属与已有 `packages/providers/src/presets.ts`（vendor baseUrl / quirks 等内置技术配置）同性质——随知行版本升级跟着代码走，调研到新模型/新数据就改这个常量。

```
┌─ 知行内置（代码层，新增）─────────────────────────────────┐
│  packages/providers/src/model-capability.ts              │
│  export const MODEL_CAPABILITIES: Record<modelId, ...>   │
│  export const UNKNOWN_MODEL_CAPABILITY: ModelCapability  │
└─────────────────────────────────────────────────────────┘
                ↓ 暴露 override 入口
┌─ 用户功能配置（已有 config.jsonc）─────────────────────┐
│  modelCapabilityOverrides: Record<modelId, Partial<…>> │
│  （罕见场景：用户实测发现某模型阈值不准时手动覆盖）       │
└──────────────────────────────────────────────────────┘
```

**优先级**：用户 override > 内置常量 > UNKNOWN 兜底。

**强制约束**：
- **不进 `credentials.json`**——credentials 是凭证唯一入口，领域知识属于功能配置，进 config.jsonc 才符合身份层不变量
- **不持久化到 conversation meta**——模型可换，阈值跟模型走
- **实现时窗口尺寸是传入参数**（不是函数内 hardcode）
- **按模型分**——不同服务商提供同一模型时共享同一阈值（如 DeepSeek 官方与硅基流动转发同型号 V4-Pro 阈值一致）

### 3.3 内置常量内容（渐进式收集）

第一版只覆盖知行明确使用的模型，其他模型按到再补：

| modelId | contextWindow | optimalMaxTokens | riskMaxTokens | 数据来源 |
|---|---|---|---|---|
| `deepseek-v4-pro` | 1,000,000 | **128,000** | **256,000** | 官方 MRCR 8-needle：≤128K accuracy >0.82 stable retrieval；256K 仍保持 >0.82；1M 降至 0.59 严重劣化 |
| `deepseek-v4-flash` | 1,000,000 | **32,000** | **64,000** | 官方未公开分阶段数据；按业界基线保守（NoLiMa 32K = 50% 衰减阈值）+ Flash 是较弱变体（Non-Think 1M MRCR 仅 37.5）；待实测调优 |
| `<unknown>` 兜底 | 由 provider 上报 | 16,000 | 32,000 | 保守默认，按业界基线 |

后续模型补入策略：
- 优先官方公开的长上下文分阶段 benchmark（MRCR / RULER / NoLiMa）
- 没有官方数据时，沿用业界 RULER / NoLiMa 基线
- 找不到任何信息时走 `<unknown>` 兜底，标注"无依据，按业界基线"

---

## 四、段切换：触发逻辑

### 4.1 评估时机

**仅在 turn 边界**（assistant 完成输出后）评估，绝不在 LLM 输出过程中切。

### 4.2 评估策略

```
当前 token = estimateText(systemPrompt) + estimateMessages(state.messages) + estimateTools(tools)
              ─────────────                  ─────────────────                 ──────────────
                现有 API                       现有 API                         待扩展（见 §10 1.B）

if (token < optimalMaxTokens):
    pass-through（无任何干预）
elif (optimalMaxTokens ≤ token < riskMaxTokens):
    if (无 in-progress 任务标识):
        触发段切换  // 找自然停顿
    else:
        延后到 risk 触发
elif (token ≥ riskMaxTokens):
    强制触发段切换  // 即使在任务中
```

`in-progress 任务标识`来源：`task_list` 工具中状态为 `in_progress` 的项（见 §8.1）。task_list 状态跨段保留（不被段切换清空，见 §5.4），所以"延后到 risk 触发"分支不会因段切换重置而失效。

### 4.3 估算器

沿用现有 `TokenEstimator`（CJK=1.5 / Latin=0.25 / Emoji=2.0 + per-message/block overhead + calibration）。段切换触发后用 LLM 实际 `input_tokens` 接入已有 calibration 路径，让 estimator 系数渐进收敛。CJK=1.5 偏保守是安全方向（宁可早切段不要晚）。

---

## 五、段切换流程：缓存安全分叉

段切换是**离散事件**，两步完成。

### 5.1 Step 1 — 压缩请求（最小化总结成本）

走「缓存安全分叉」格式，压缩请求只在末尾追加压缩指令，前面所有 prefix 与上一轮完全相同：

```
POST /chat
  system:   [完全同上一轮，byte-equal]
  tools:    [完全同上一轮，byte-equal]
  messages: [上一段完整 raw 历史]
    ← cache 完美命中
  + 末尾追加 user message: <summarize-instruction>...</summarize-instruction>
    ← 仅此段是新 token，几乎免费
```

**压缩指令模板**（要求 LLM 输出三部分 XML 结构）：

```
<summarize-instruction>
请把以上对话压缩为简洁摘要。输出严格按以下三段 XML 结构：

<facts>讨论过的事实、事件、决策——结论性陈述，不展开过程</facts>
<state>当前进行中的任务、未完成事项、用户当前期望——让协作者知道现在该接着做什么。
       重要：如果当前对话中 task_list 工具有标记为 in_progress 的项，必须逐项总结进展，
       让新段 LLM 能继续工作；task_list 状态本身跨段保留不变（不被段切换清空）。</state>
<active>后续协作必须知道的具体信息：文件路径、变量名、技术决策、用户偏好等——保留协作锚点</active>

约束：
- 总长度不超过 500 字
- 输出语言与对话主体语言一致
- 不复述过程细节，只保留协作必需的结论
- 不要在结构外添加任何解释或问候
</summarize-instruction>
```

**调用模型**：现阶段走 main role（即主对话当前使用的模型与 provider）。代码层保留接口给未来的"增强模型 + 主模型兜底"扩展形态（例如 `SegmentSummarizer` 接口可接受不同 LLM 路由策略），第一版固定 main。**关键约束**：摘要 LLM 必须与主对话同 provider/账号，避免破坏 cache 经验 4「不切模型」。

### 5.2 Step 2 — 新段首条 user message

```
新段 messages = [
  {
    role: "user",
    content: [
      <previous-segment-summary>
        <facts>...</facts>
        <state>...</state>
        <active>...</active>
      </previous-segment-summary>
      <recent-turns>
        ...上一段最后 2 轮对话 raw（user + assistant 配对，含所有 block 类型）...
      </recent-turns>
      [用户实际新消息]
    ]
  }
]
```

**system prompt 不变**——LLM 通过 `<previous-segment-summary>` 标签自己理解段切换情况，不修改 system prompt 段（保 cache）。

### 5.3 缓冲带（最近 2 轮 raw）

- **作用**：避免硬切断、保任务连续性、给 LLM 平滑过渡的上下文锚
- **形态**：上一段最后 2 轮 `user + assistant` 配对完整 raw（含 tool_use / tool_result 等所有 block）
- **轮数**：固定 2 轮（v3 第一版；未来若实测发现不够可调）

### 5.4 段标记（持久化）

- 段是**同一 conversation 内的离散段标记**，不是新建 conversation
- transcript 中段切换**复用 `CompactMarker` 类型**（已有持久化路径与 ack 配对协议），扩展两个选填字段以承载段切换语义：

```typescript
interface CompactMarker {
  type: "compact";
  timestamp: string;
  summary: string;                // 平文本摘要（必填，兼容数据层兜底路径）
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;

  // v3 段切换扩展（选填）：
  segmentId?: string;             // 段切换产生的 marker 必填；标识段边界
  structuredSummary?: {           // 段切换产生的 marker 必填；结构化摘要三段
    facts: string;
    state: string;
    active: string;
  };
}
```

**填法契约（避免字段半填半空的不一致）**：
- **段切换路径（v3 主路径）**：必填 `segmentId` + `structuredSummary`；`summary` 由 `structuredSummary` 三段拼接成的平文本副本（保兼容形态）
- **数据层兜底路径**（v3 段切换失败 + budget critical 时由 `LLMSummarize` 直接摘 raw）：只填 `summary` 平文本，`segmentId` / `structuredSummary` 缺省
- **SegmentManager 读 marker 重建新段 `<previous-segment-summary>` 块时**：优先用 `structuredSummary` 还原三段 XML；不存在时降级用 `summary` 包成单个 `<facts>` 段

**transcript marker 与 conversation meta 的职责分离（关键架构边界）**：

- **transcript 中的 CompactMarker 仍是单 frontier**——沿用 v1.2 `normalize()` 语义，每次段切换覆盖前一个 marker，不引入 marker 数组化（不破坏 `RawTranscript.compactBefore: CompactMarker | null` 现有 schema 约束）
- **不需要保留多个历史 marker**——marker.structuredSummary 在新段开始时立即被 SegmentManager 消费（拼装为 `<previous-segment-summary>` 注入新段 user message），消费后这部分信息已经流入新段对话流；下次段切换时新 marker 的 structuredSummary 自然包含"前段已注入内容 + 新段新增"的整合摘要——单 frontier 不会丢失信息
- **段历史元数据走另一条数据流**：每段的 ID / 切换时间 / token 数 / 段间关系，累积在 `conversation.segmentMetadata.segments[]` 数组中（见 §10 1.B），用于可观测性 / SegmentTransitionHook 扩展 / 未来段历史浏览 UI

- 用户感知一致：conversation 历史在 cli/UI 中连续显示，前端从磁盘读完整 transcript，不受 LLM 视图限制
- conversation.id / name / scope / preferences 完全不变
- **`task_list` 状态跨段保留不变**——段切换不清空、不修改 task_list；LLM 通过摘要中的 `<state>` 部分理解段切换前后的任务延续性，task_list 状态本身只受 LLM 主动调用 `task_list.set` 或用户 `/task done` 改变（避免段切换机制越权改 LLM 自有工具状态）
- `/clear` 完整重置仍可用（同步清空 transcript + state + task_list + 全部段切换状态）

### 5.5 段切换失败兜底

- 压缩 LLM call 失败：重试 3 次（指数退避），仍失败 → emit `segment:transition_failed` → **降级为不切**（继续累积；若达到 risk 阈值时仍失败，由 v1.2 数据层 budget 兜底）
- v3 第一版不做摘要质量校验（YAGNI），prompt 设计是主要质量保障

---

## 六、SegmentTransitionHook：扩展点

段切换是**可观测、可扩展的离散事件**。代码组织必须保留扩展接口。

### 6.1 接口

```typescript
interface SegmentTransitionHook {
  beforeSummarize?(ctx: SegmentContext): Promise<void>;
  afterSummarize?(ctx: SegmentContext, summary: string): Promise<void>;
  beforeNewSegmentStart?(ctx: SegmentContext): Promise<void>;
}
```

### 6.2 v3 第一版的实现规则

- **仅接口预留**，不实现任何 hook 内容
- 未来扩展候选（不在 v3 范围）：自动 `memory.save` 引导 / 任务边界推断 / 用户通知 / 段统计上报 / 摘要质量评估

---

## 七、Tools 设计：满载稳定 + Profile 子集

### 7.1 核心规则

- 会话期间 **tools[] byte-equal 不变**
- 工具集在 **session 创建时一次性决定**，之后任何机制都不能动 tools[] 数组
- 不引入任何"工具按需进出" / "LRU 演化" / "动态过滤" 机制
- 与 Anthropic 经验 5「工具集自始至终不动」完全对齐

### 7.2 Profile 子集

Profile 是 `AgentRoleProfile` 概念的延伸——同一对话场景下 LLM 视角的固定配置。知行当前仅有两个 profile：

| Profile | enabledTools | 场景 |
|---|---|---|
| `main` | 全 8 工具 + memory + task_list | 主对话（默认） |
| `sub-agent` | read + glob + grep | Task 工具派出的子任务（探索） |

具体工具集合在 spec 阶段最终定稿（含 sub-agent 是否再加更多工具如 web_fetch）。**v3 第一版不引入新 profile**（不做 chat / research / coding 等场景化拆分，YAGNI）。

```typescript
interface AgentRoleProfile {
  id: "main" | "sub-agent";
  enabledTools: string[];      // 该 profile 启用的工具名列表
  systemPromptSegments: ...;   // 该 profile 的 system prompt 拼装
}
```

session 创建时根据 profile 一次性 freeze tools[]，会话期间 byte-equal。

**与现状的 gap**：当前 `AgentRoleProfile`（`packages/orchestrator/src/profile/agent-role-profile.ts:11-40`）**无 `enabledTools` 字段**，tools[] 在 `create-agent-runtime.ts:511-544` 处硬编码装配（`baseTools + Task`）不经 profile。v3 实施时必须：(a) 新增 `enabledTools` 字段；(b) 重构 tools[] 装配路径从硬编码改为 profile 驱动；(c) main / sub-agent 两个 profile 实例显式声明 `enabledTools`。这是 Phase 1 必做的**新增工作**，不是回退。

### 7.3 与段切换的关系

段切换**只重置 messages 部分**，不重置 tools[]——tools[] 必须跨段稳定。新段开始时 tools[] 与上一段 byte-equal，cache 在 system + tools 部分仍命中。

---

## 八、配套机制

### 8.1 task_list 工具

- **当前 codebase 未实现**——Phase 1 必须新增（与 SegmentManager 同 Phase 内置，作为 §4.2 评估策略的前置依赖）
- LLM 自我组织工具（普通工具，main profile 内置）
- 单一动作 `task_list.set(items)`，每项含 `content` + `status: pending | in_progress | completed`
- `in_progress` 状态作为 §4.2「无 in-progress 任务标识」的判定来源
- **状态跨段保留**——段切换不清空、不修改 task_list（只受 LLM 主动 `set` 或用户 `/task done` 改变）；摘要 prompt 显式要求 LLM 在 `<state>` 部分总结 in_progress 项进展（见 §5.1）
- cli 渲染当前任务列表 + `/tasklist` / `/task` / `/task new` / `/task done` 命令
- 持久化到 conversation meta（**快照式**：每次 `set` 完整替换 `taskListState` 字段，非追加；历史 `set` 调用以 tool_use 事件留存于 `transcript.jsonl`——两文件互补：meta 表达"当前状态"、transcript 表达"历史事件"）

### 8.2 SegmentManager 模块位置

SegmentManager 是**独立模块**，不引入 ContextCompiler 抽象层（v3 没有视图层 Stage 渲染需求，留空抽象层是预备性架构债务）。

```
建议位置：packages/core/src/context/segment/segment-manager.ts
```

调用点：在 agent-loop 的 turn 边界（assistant 完成输出后）直接调用 `segmentManager.evaluate(...)`，无中间抽象层。如果未来真出现视图层 Stage 渲染需求，再独立设计——不为想象中的需求预留空抽象。

### 8.3 TurnContextInjector

- 保留 per-LLM-call inject
- time / scheduler 等 provider 的动态信息每轮刷新到最末 user message 的 `<turn-context>` 块
- **段切换的压缩请求中不 inject `<turn-context>`**（避免破坏「缓存安全分叉」的"末尾仅追加压缩指令"形态）
- 历史 user message 中残留的旧 `<turn-context>` 块不主动清理（保 prefix 字节稳定）

### 8.4 Sub-agent 路径

- sub-agent **不启用** SegmentManager（短命任务，保 byte-equal-across-spawns 缓存优化）
- sub-agent 若超过自身 profile 的 risk 阈值 → 硬失败返回 main agent（由 main agent 重新切片任务），不在 sub-agent 内段切换
- **risk 检测接线**：复用 agent-loop 内已有的 `totalUsage.inputTokens` 累积值，在每次 LLM call 前（pre-flight）比对 `riskMaxTokens`；超出则 throw 特定错误类型（spec 阶段定具体 error class 与 main agent 接收逻辑）

### 8.5 可观测性事件（底层先实现，用户展示后置）

底层事件流（v3 第一版即实现）：

| 事件 | 时机 | 携带数据 |
|---|---|---|
| `segment:evaluation` | 每轮 turn 边界评估 | currentTokens / threshold / decision |
| `segment:transition_start` | 段切换触发 | reason (optimal / risk) / currentTokens |
| `segment:summarize_complete` | 压缩 LLM call 完成 | summaryTokens / latencyMs |
| `segment:new_started` | 新段首条 user message 已组装 | segmentId / bufferTurns |
| `segment:transition_failed` | 压缩失败（重试 3 次后）| error / fallback |
| `cache:metrics` | 每次 LLM call 完成 | cacheReadTokens / inputTokens / hitRate |

段切换元数据持久化到 conversation meta（段 ID、切换时间、压缩前后 token 数、摘要内容），供产品观测和未来 hook 扩展。

**用户展示后置**：告警阈值、UI 渲染、命中率监控面板等留到底层稳定后再做（不在 v3 第一版范围）。

### 8.6 与 v1.2 数据层关系

| v1.2 数据层组件 | v3 处理 |
|---|---|
| `onTurnComplete` 主路径 | 保留（v3 段切换是更高层事件，独立于数据层）|
| `MessageDrop` / `LLMSummarize` 策略 | **保留为异常路径兜底**——v3 段切换失败且 budget critical 时由 `LLMSummarize` 直接摘 raw（不再依赖 tier-compressor 预压缩）；`MessageDrop` 移除当前的 `isPinned` 消费（v3 不用 Pin）|
| `MemoryFlush`（`packages/core/src/memory/flush-engine.ts`） | **保留为独立机制**——提炼 user message 中的关键事实到 memory store，是 memory 系统的功能，**与上下文管理解耦**，不参与段切换兜底链 |
| `manageWindow`（含 Pin + eviction + applyTierCompression） | **🔴 整体砍除** —— (a) `applyTierCompression` 修改老 tool_result 字节违反 invariant 1；(b) Pin 砍除后 eviction 单独存在价值不大；(c) ContextEngine 直接做 budget check + 调用 MessageDrop / LLMSummarize，无需 manageWindow 这层抽象 |

---

## 九、关键 Invariants

1. **cache prefix 稳定**：段内 system prompt + tools[] + messages 历史全程 byte-equal；段切换之外任何机制不得动 prefix
2. **段切换走经验 7 缓存安全分叉**：压缩请求形态必须保证除"末尾追加压缩指令"外，其余前缀与上一轮完全相同
3. **段评估仅在 turn 边界**：绝不在 LLM 输出过程中切段
4. **tools[] 在 session 创建后冻结**：任何机制不得在会话期间增减或修改 tools[] 内容
5. **段标记是同一 conversation 内的 protocol marker**：不新建 conversation
6. **缓冲带固定 2 轮**：v3 第一版不可配
7. **段切换的扩展通过 SegmentTransitionHook 接口**：禁止在主流程内嵌入业务逻辑
8. **段切换失败可降级**：压缩失败不阻塞 LLM call；最终由 v1.2 budget 兜底
9. **摘要 LLM 必须与主对话同 provider/账号**：保 cache 经验 4「不切模型」
10. **task_list 状态跨段保留**：段切换不清空/不修改 task_list；只受 LLM 主动 `set` 或用户 `/task done` 改变。避免"段切换清 task_list → in_progress 判定永远成立 / 永远不成立"的循环依赖

---

## 十、实施路线（Phase 1–2）

> **关键约束 - Phase 1 是原子上线**：Phase 1 是一次性整体替换，不能分批发布。砍除清单（1.A）与新机制（1.B / 1.C / 1.D）之间存在功能耦合——只砍不上新机制会让上下文管理失去能力（无视图层、无 capability 管理、无段切换），直接 regression；只上新机制不砍旧机制会与 v3 invariants 冲突。**1.A–1.D 必须同 PR 合并发布**。Phase 2 是产品化后置，与 Phase 1 解耦。

### Phase 1 · 全量替换（原子上线）

**1.A 与 v3 invariants 冲突的代码砍除**：

| 模块 | 处理 | 原因 |
|---|---|---|
| `tier-compressor.ts`（`applyTierCompression` + `determineTier` + 全部 generator）| 砍除 | 修改老 tool_result 字节，违反 invariant 1 |
| `TierThresholds` 类型 + `ContextEngine` 配置 `tierThresholds` 入参 | 砍除 | 跟随 tier-compressor |
| `manageWindow`（整体砍除）| 砍除 | Pin 不再需要 + 砍掉 tier-compressor 后此层抽象只剩 eviction，价值不足；ContextEngine 直接 budget check + 调用策略 |
| `MessageDrop` 中的 `isPinned` 消费（`message-drop.ts:74,100`）| 砍除 | v3 不用 Pin（注：另两个策略 `MemoryFlush` / `LLMSummarize` 当前未接 isPinned，无需清理）|
| `ContextCompiler` 主框架（含 types / runner / 测试）| 砍除 | YAGNI——v3 无视图层 Stage 需求 |
| `ToolResultAnchorStage` + 全部 anchor generator（read/bash/grep/glob/edit/write/web_fetch）| 砍除 | 锚化改写历史 tool_result，违反 invariant 1 |
| `recall_history` 工具 + 注入点（`create-agent-runtime.ts:444-455`）| 砍除 | v3 决议不做 |
| `capabilityState` 全套（state / types / rebuild / promote 闭包桥接）| 砍除 | tool 方向锁满载稳定 |
| `ToolSchemaCompilerStage` | 砍除 | 跟随 capabilityState |
| `request_capabilities` 工具 + 注入点（`create-agent-runtime.ts:415-427`）| 砍除 | 跟随 capabilityState |
| 自动升级中间件（`agent-loop.ts:404-413` 内联 10 行 + `recordToolUse` 调用）| 砍除 | 跟随 capabilityState |
| `rebuildCapabilityFromHistory` + 3 处调用（`cli/repl.ts:385`/`914`、`serve/session-adapter.ts:227`）| 砍除 | 跟随 capabilityState |
| `onTurnComplete` 中的 `advanceTurn` 调用（`orchestrator runtime:988`）| 砍除 | 跟随 capabilityState |
| `compiler.ts:586` ContextCompiler 实例化 + `agent-loop.ts:263` `compiler.compile()` 调用 | 砍除 | 跟随 ContextCompiler |

**1.B 基础设施重构（保留 + 扩展）**：

保留与 v3 invariants 一致的现有基础设施：
- 死代码砍除（TurnDigest / LayerAssembler / ScenarioEvaluator / ContextProfile / ScenarioHint / ToolResultTrim）—— 不动
- `SYSTEM_META_PROMPT_SECTION` transplant 到 live `system-prompt.ts` —— 不动
- `ConversationRepository.writeMeta` atomic + per-id lock —— 不动
- `/clear` 完整重置语义 —— 扩展为同步清空 task_list state + 段切换 metadata
- `TurnContextInjector` per-LLM-call inject —— 加"段切换压缩请求中不 inject"分支
- estimator calibration —— 接入段切换路径（compress LLM call 完成后用真实 inputTokens 校准）
- `ContextEngine` 配置接口 `budgetThresholds` 入参 —— 不动

新增字段与机制：
- `ModelCapability` 接口 + 内置常量 `MODEL_CAPABILITIES`（`packages/providers/src/model-capability.ts`）
- `config.jsonc` 暴露 `modelCapabilityOverrides` 字段
- **`AgentRoleProfile.enabledTools` 字段新增** + tools[] 装配路径重构（从 `create-agent-runtime.ts:511-544` 硬编码 → profile 驱动 + session 创建时一次 freeze）
- main / sub-agent 两个 profile 实例显式声明 `enabledTools`
- **`TokenEstimator` 扩展 `estimateTools(tools: ToolSpec[]): number` 方法** —— 当前公开 API 只有 `estimateText` / `estimateMessage` / `estimateMessages`（`packages/core/src/context/token-estimator.ts:187-201`），§4.2 段切换评估需要专属 tools token 估算接口（实现复用 `estimateTextTokensRaw(JSON.stringify(tool))` 逐工具累加，含 schema 结构性 overhead）
- **`CompactMarker` 扩展两个选填字段**：`segmentId?: string` + `structuredSummary?: { facts; state; active }`（§5.4 填法契约）
- **`Conversation` type 扩展两个选填字段**：
  - `taskListState?: { items: TaskItem[] }` —— task_list 工具状态持久化
  - `segmentMetadata?: { currentSegmentId: string; segments: SegmentMeta[] }` —— 段切换历史 + 当前段标识（SegmentMeta 含段 ID / 切换时间 / 压缩前后 token 数 / 关联 marker 引用）。**段历史累积只走这一条数据流**——transcript 中的 CompactMarker 仍为单 frontier（每次段切换覆盖前 marker，沿用 v1.2 normalize 语义；不数组化）

**1.C task_list 工具**（SegmentManager 评估策略的前置依赖）：

- 工具实现：state 模型 + `task_list.set(items)` 动作 + 持久化到 conversation meta
- LLM 视角接口：作为 main profile 内置工具
- 段切换评估侧接口：`getInProgressTasks(): TaskItem[]` 暴露给 SegmentManager 读
- cli UI：实时渲染任务列表
- 用户命令：`/tasklist` / `/task <desc>` / `/task new` / `/task done <id>`
- **状态跨段保留**（不被段切换清空，见 §5.4 / §8.1）

**1.D SegmentManager 核心**：

- 段切换触发判断（§四：双档阈值 + turn 边界 + in-progress 延后逻辑）。**精确挂点**：在 `agent-loop.ts` 中 `turn_complete` 事件 yield 之后、contextManager 预算检查之后、state 重建之内（即 `contextManager` 调用之后、`totalUsage` 写回新 state 之前），使 SegmentManager 能读到本轮工具执行完成后的最新 messages 与 usage
- 段切换压缩流程（§5.1：缓存安全分叉格式 + 压缩指令模板）
- 新段首条 user message 拼接（§5.2：摘要 + 缓冲带 2 轮 + 用户新输入）
- 段标记（§5.4：复用 `CompactMarker` + 扩展字段 + 填法契约）
- `SegmentTransitionHook` 接口（仅接口，无实现）
- 段切换失败兜底（§5.5）
- sub-agent 路径 risk 检测（§8.4：复用 `totalUsage.inputTokens` + pre-flight 比对 + 特定 error throw）
- 可观测性事件埋点（§8.5）

**1.E 失效文档清理**：

- `research/design/specifications/context-management-v2-redesign.md` 标记 deprecated（在文件顶部加状态横幅，指向 v3）
- `research/innovations/capability-compiler.md` 标记 deprecated（capability 机制已砍）
- 不删除，保留为决策痕迹

### Phase 2 · 产品化与监控（后置）

- cli 段切换轻提示渲染
- cache 命中率监控面板与告警
- 用户层可见的 conversation 段历史浏览

---

## 十一、状态

| 字段 | 值 |
|---|---|
| 状态 | 核心设计已敲定 |
| 下一步 | 进入 spec 阶段细化 + 启动 Phase 0 |
| 实施完成后 | 内容并入 [context-architecture.md](./context-architecture.md) v3.0 |
