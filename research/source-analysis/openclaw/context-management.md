# OpenClaw — 上下文管理与 Token 估算

> **所属系统**: OpenClaw | **分析状态**: ✅ 已分析（2026-04-08）

## 模块定位

OpenClaw 的上下文管理分散在多个层次：pi-coding-agent 内部的 auto-compaction、OpenClaw 自研的 Context Engine 插件体系、以及外层编排循环中的 overflow/timeout 触发逻辑。

## 一、Token 估算机制

### 1.1 核心依赖：pi-coding-agent 的 `estimateTokens`

OpenClaw 的 Token 估算**完全委托给闭源依赖**：

```typescript
// src/agents/compaction.ts
import { estimateTokens } from "@mariozechner/pi-coding-agent";

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

`estimateTokens` 的内部实现不可见，但从代码注释和补偿逻辑可推断：

- **基础算法**：chars / 4 的启发式（character-to-token ratio）
- **不使用 tiktoken**：仓库依赖中无 tiktoken
- **已知不准**：OpenClaw 用 20% 安全余量补偿

### 1.2 安全余量补偿

```typescript
// src/agents/compaction.ts
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy

// 使用时：将 maxTokens 除以安全余量，确保估算偏低时不会溢出
const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
```

注释明确写道："chars/4 heuristic misses multi-byte chars, special tokens, code tokens, etc."

### 1.3 CJK 字符加权

```typescript
// src/utils/cjk-chars.ts
export function estimateStringChars(text: string): number {
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  const codePointLength = countCodePoints(text, nonLatinCount);
  // 非拉丁字符按 CHARS_PER_TOKEN_ESTIMATE 倍权重计算
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}
```

这是一个**辅助函数**，用于部分 UI/报告路径，不是主线 Token 估算的一部分。

### 1.4 API 返回值作为校准

```typescript
// src/agents/usage.ts
export function derivePromptTokens(usage?: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): number | undefined {
  const sum = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  return sum > 0 ? sum : undefined;
}
```

API 返回的 usage 被用于：
- **超时触发 compaction 的阈值判断**：prompt tokens / contextWindow > 65% 时触发
- **Compaction hooks 的 `observedTokenCount`**：优先使用 API 报告值，回退到估算值

### 1.5 关键评价

| 优点 | 缺点 |
|------|------|
| 简单（一个函数调用） | 闭源依赖，不可控 |
| 有安全余量补偿 | CJK 处理是辅助路径，不在主线 |
| 有 API 校准机制 | 20% 余量是经验值，非自适应 |

## 二、Context Window 解析

### 2.1 有效窗口计算

```typescript
// src/agents/context-window-guard.ts
export function resolveContextWindowInfo(params): ContextWindowInfo {
  // 优先级：models.providers 配置 > 模型对象字段 > 默认值
  // 然后用 agents.defaults.contextTokens 做上限 cap
}
```

与 Claude Code 不同，OpenClaw **不从 contextWindow 中减去 maxOutput**。有效窗口 = min(解析后的窗口, 用户配置的 cap)。

### 2.2 预警与阻断

```typescript
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;  // 警告线
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;      // 硬阻断 → FailoverError
```

这是对**模型 contextWindow 本身**的检查，不是对话占用的检查。用于阻止在窗口太小的模型上运行。

## 三、Compaction（压缩）机制

### 3.1 触发路径

OpenClaw 有三种 compaction 触发路径，全在外层编排循环 `run.ts` 中：

| 触发条件 | 阈值 | 最大尝试次数 |
|----------|------|------------|
| **超时 + 高占用** | prompt tokens / contextWindow > 65% | 2 次 |
| **上下文 overflow（413）** | 错误文本包含 overflow 关键词 | 3 次 |
| **pi-agent 内部 auto-compact** | 由 pi-coding-agent 内部控制（不可见） | — |

### 3.2 执行路径

压缩通过 `session.compact()` 委托给 pi-coding-agent，外包安全超时：

```typescript
// src/agents/pi-embedded-runner/compact.ts
const result = await compactWithSafetyTimeout(
  () => session.compact(customInstructions),
  compactionTimeoutMs,   // 默认 900秒
  {
    abortSignal: params.abortSignal,
    onCancel: () => session.abortCompaction(),
  },
);
```

### 3.3 Safeguard 模式（增强摘要）

当配置 `compaction.mode === "safeguard"` 时，通过 hook `session_before_compact` 介入：

1. **`pruneHistoryForContextShare`**：按比例裁剪历史
2. **`summarizeInStages`**：分块摘要 → 合并
3. **`qualityGuard`**：摘要质量检查，不合格则重试

摘要模板包含**固定章节标题**：

```typescript
// src/agents/pi-hooks/compaction-safeguard-quality.ts
const REQUIRED_SUMMARY_SECTIONS = [
  // 多个固定章节，如 "Primary Request", "Key Technical Concepts" 等
];
```

### 3.4 无正式熔断器

OpenClaw **没有**独立的 compaction 熔断器类，但通过多层上限实现类似效果：
- 超时 compaction 最多 2 次
- Overflow compaction 最多 3 次
- 安全超时 15 分钟
- 聚合重试超时 60 秒

### 3.5 Tool Result 处理

Compaction 前**剥离 `toolResult.details`**，避免不可信/冗长的载荷进入摘要 LLM 调用：

```typescript
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  // SECURITY: toolResult.details can contain untrusted/verbose payloads
  const safe = stripToolResultDetails(messages);
  return safe.reduce((sum, message) => sum + estimateTokens(message), 0);
}
```

## 四、Context Engine 插件体系

### 4.1 接口设计

`src/context-engine/types.ts` 定义了可插拔契约：

| 方法 | 职责 |
|------|------|
| `assemble` | 接收 messages + tokenBudget，返回处理后的 messages + estimatedTokens |
| `compact` | 执行压缩，支持 `force`、`compactionTarget`、`currentTokenCount` 等参数 |
| `afterTurn` | Turn 结束回调，可用于主动检查是否需要压缩 |
| `ingest` | 消息落盘 |

### 4.2 Legacy 引擎（当前默认）

```typescript
// src/context-engine/legacy.ts
async assemble() {
  return { messages: params.messages, estimatedTokens: 0 };
  // 注释：估算由 caller 处理
}

async compact() {
  return delegateCompactionToRuntime(...);
  // 注释：委托给运行时（pi-coding-agent）
}
```

Legacy 引擎本质上是 pass-through——真正的工作由 pi-coding-agent 内部完成。

## 五、关键设计模式总结

| 模式 | 描述 |
|------|------|
| **闭源估算 + 安全余量** | Token 估算委托闭源包，用 20% 余量兜底 |
| **API 校准** | 用 API 返回的 usage 校准估算值 |
| **被动触发为主** | 主要在 overflow/timeout 后才压缩，不主动监控预算 |
| **可插拔 Context Engine** | 接口设计好但当前实现是 pass-through |
| **安全超时保护** | 15 分钟超时防止 compaction 卡死 |
| **分块摘要** | Safeguard 模式：大量历史分块摘要再合并 |

## 引用

- `src/agents/compaction.ts`
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/run.ts` (L644-L805)
- `src/agents/context-window-guard.ts`
- `src/context-engine/types.ts`
- `src/context-engine/legacy.ts`
- `src/utils/cjk-chars.ts`
- `src/agents/usage.ts`
- `src/agents/pi-hooks/compaction-safeguard.ts`
- `src/agents/pi-hooks/compaction-safeguard-quality.ts`
