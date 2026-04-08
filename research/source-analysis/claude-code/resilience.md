# Claude Code — 容错与韧性架构分析

> **分析状态**: ✅ 已分析（2026-04-08）
>
> **分析范围**: 错误分类、重试机制、错误扣留模式、Failover、断路器、上下文恢复、流式错误处理

## 模块定位

Claude Code 的容错逻辑分布在两个核心文件中：`query.ts`（agent loop 内的恢复机制）和 `withRetry.ts`（HTTP 传输层重试）。两层各有独立的错误分类和恢复策略。

## 信息来源

| 来源 | 类型 | 可信度 |
|------|------|--------|
| [Claude Code from Source](https://claude-code-from-source.com) Ch5 | agent loop 错误恢复 | ★★★★☆ |
| [thtskaran/claude-code-analysis](https://github.com/thtskaran/claude-code-analysis) | 错误处理分析 | ★★★★☆ |
| [Karan Prasad 逆向工程分析](https://www.karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines) | withRetry 详解 | ★★★★☆ |

> 基于泄露的 v2.1.88 源码（~512K 行 TypeScript）的社区分析。

## 一、错误分类体系

### 1.1 终止原因（Terminal Reasons）— 10 种

query() 的返回值是一个判别联合，精确编码循环退出的原因：

| 终止原因 | 触发条件 |
|----------|---------|
| `completed` | 正常完成（无工具调用 / API 错误后兜底） |
| `max_turns` | 达到 maxTurns 限制 |
| `blocking_limit` | Token 达硬限制且 auto-compact 已关闭 |
| `model_error` | 不可恢复的 API/模型异常 |
| `prompt_too_long` | 413 错误，所有恢复路径耗尽 |
| `image_error` | 不可恢复的媒体错误 |
| `aborted_streaming` | 用户在流式传输期间中止 |
| `aborted_tools` | 用户在工具执行期间中止 |
| `stop_hook_prevented` | Stop hook 阻止继续 |
| `hook_stopped` | PreToolUse hook 停止执行 |

### 1.2 继续状态（Continue States）— 7 种

每个 `continue` 点都通过 `transition.reason` 自文档化：

| 继续原因 | 含义 |
|----------|------|
| `next_turn` | 正常的工具使用继续 |
| `collapse_drain_retry` | Context Collapse 排空后重试 |
| `reactive_compact_retry` | 反应式压缩成功后重试 |
| `max_output_tokens_escalate` | 8K→64K 输出限制静默升级 |
| `max_output_tokens_recovery` | 64K 仍命中，注入恢复消息多轮重试 |
| `stop_hook_blocking` | Stop hook 返回阻塞错误 |
| `token_budget_continuation` | Token 预算未耗尽，继续 |

## 二、HTTP 传输层重试（withRetry.ts）

### 2.1 核心常量

```
DEFAULT_MAX_RETRIES = 10
BASE_DELAY_MS = 500
maxDelayMs = 32000（32 秒上限）
OVERLOAD_FALLBACK_THRESHOLD = 3（过载降级阈值）
MAX_529_RETRIES = 3（过载最大重试）
```

### 2.2 重试策略分类

| 错误类型 | HTTP 状态 | 处理方式 |
|----------|-----------|---------|
| 速率限制 | 429 | 使用 `Retry-After` 头退避，无则指数退避 + 抖动 |
| 服务过载 | 529 | 最多 3 次重试，超限抛 `FallbackTriggeredError` 触发模型降级 |
| 认证失败 | 401/403 | 清除凭据缓存，重试一次 |
| 上下文溢出 | 400（特定消息） | 通过 `parseMaxTokensContextOverflowError` 减少 `maxTokens` 重试 |
| 连接错误 | 无状态码 | **未被重试**（已知缺陷 — #1 用户报告类别） |

### 2.3 指数退避实现

```
延迟 = min(BASE_DELAY_MS × 2^attempt × random(0.5, 1.5), maxDelayMs)
```

如果 API 返回 `Retry-After` 头，优先使用该值。

### 2.4 429 的 Fast Mode 处理

短等待（< 20 秒）：保持 "fast mode" 激活，避免破坏昂贵的 prompt cache。  
长等待：切换到标准速度，系统强制 10 分钟冷却期防止模式快速翻转。

### 2.5 已知缺陷：连接错误不重试

SDK 的 `maxRetries` 被设为 `0`（禁用内置重试），自定义重试逻辑**仅匹配 `APIError` 实例**。连接级错误（`ECONNRESET`、`EPIPE`、`ETIMEDOUT`）是原始 `Error` 对象，不被捕获。

## 三、错误扣留模式（Withhold Error）

这是 Claude Code **最巧妙的韧性模式**。

### 3.1 核心问题

SDK 消费者（桌面应用、Cowork 等）在收到**任何**带 `error` 字段的消息时会断开连接。如果先 yield 错误再恢复成功，消费者已经不在了。

### 3.2 解决方案

可恢复错误被**扣留**（不 yield 给消费者），静默尝试恢复。只有所有恢复路径失败后才释放错误。

```typescript
// query.ts 中的扣留逻辑（简化）
let withheld = false;
if (contextCollapse?.isWithheldPromptTooLong(message)) withheld = true;
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true;
if (isWithheldMaxOutputTokens(message)) withheld = true;
if (!withheld) yield yieldMessage;  // 只有不可恢复的才暴露
```

### 3.3 三类可扣留的错误

| 错误 | 门控条件 | 恢复策略 |
|------|---------|---------|
| prompt_too_long (413) | `CONTEXT_COLLAPSE` 或 `REACTIVE_COMPACT` feature flag | Collapse drain → Reactive compact → Surface |
| 媒体大小错误 | `REACTIVE_COMPACT` + mediaRecoveryEnabled | Reactive compact + 剥离重试 → Surface |
| max_output_tokens | 始终激活 | 静默升级到 64K → 多轮恢复（最多 3 次）→ Surface |

### 3.4 mediaRecoveryEnabled 提升

`mediaRecoveryEnabled` 在流循环**之前**就被计算（提升到循环外），而不是在循环内实时求值。原因：`getFeatureValue_CACHED_MAY_BE_STALE` 在 5-30 秒的流式传输窗口期间可能翻转，导致 withhold-without-recover 的不匹配会静默吞掉消息。

## 四、Max Output Recovery（输出上限恢复）

### 4.1 第一阶段：静默升级

如果 `tengu_otk_slot_v1` feature flag 开启且没有显式 `maxOutputTokensOverride`：

- 用 `ESCALATED_MAX_TOKENS`（64K）替代默认 8K 重试**同一请求**
- **不注入任何 meta message**——对模型完全不可见
- `transition.reason: 'max_output_tokens_escalate'`

### 4.2 第二阶段：多轮恢复

如果升级后仍命中限制（或未启用升级）：

- 注入恢复消息：`"Output token limit hit. Resume directly — no apology, no recap..."`
- 最多触发 `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`（3 次）
- `transition.reason: 'max_output_tokens_recovery'`

## 五、模型降级（Model Fallback）

### 5.1 触发路径

```
withRetry.ts: 529 重试达到 MAX_529_RETRIES
    ↓
抛出 FallbackTriggeredError（携带原始/降级模型名称）
    ↓
query.ts 第 ~894 行捕获
    ↓
currentModel 切换到 fallback（如 Opus → Sonnet）
    ↓
清除所有累积状态，重试整个请求
```

### 5.2 降级时的特殊处理

| 处理 | 原因 |
|------|------|
| **Strip thinking signatures** | Protected-thinking blocks 绑定模型，跨模型重放会 400 错误 |
| **Tombstoning** | 孤立的 assistant messages 被标记，UI 移除 |
| **StreamingToolExecutor 重建** | 丢弃旧 executor，防止孤立 tool_results 泄漏 |

### 5.3 Query Source 感知

| 来源 | 降级行为 |
|------|---------|
| 前台（REPL、SDK、agent 查询） | 3 次重试后正常降级 |
| 后台（compact、session_memory） | 跳过降级，避免维护操作期间的级联模型切换 |

## 六、断路器模式

Claude Code 有**多个显式断路器**，每个都源于生产事故：

| 断路器 | 阈值 | 保护内容 |
|--------|------|---------|
| `hasAttemptedReactiveCompact` | 1 次（布尔） | 防止无限 reactive compact 循环 |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT` | 3 次 | 限制输出恢复重试 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 次 | auto-compact 连续失败后停止 |
| 错误响应不运行 Stop Hooks | — | 防止 error → hook → retry → error 死循环 |
| ML 分类器断路器 | 3 次 | 连续拒绝后切换为询问用户 |

源码注释的原话：

> "重置为 false 导致了一个无限循环，烧掉了数千次 API 调用"
>
> "没有这个断路器，生产会话会每天烧掉 250K API 调用"

## 七、上下文溢出恢复

### 7.1 两阶段恢复

```
第一步：Context Collapse Drain
  ├ 提交所有暂存的折叠
  └ 有折叠被提交 → transition.reason: 'collapse_drain_retry'
      ↓ 无可排空内容
第二步：Reactive Compact
  ├ 完整摘要化压缩
  └ 成功 → transition.reason: 'reactive_compact_retry'
      ↓ 失败
第三步：Surface Error
  └ 释放扣留的错误，终止原因: 'prompt_too_long'
  └ 不运行 stop hooks（防死亡螺旋）
```

### 7.2 阈值

```
effectiveContextWindow = contextWindow - min(modelMaxOutput, 20000)
Auto-compact 触发:  effectiveWindow - 13,000 tokens
硬阻塞:           effectiveWindow - 3,000 tokens
```

## 八、流式错误处理

### 8.1 孤立 Tool Results 安全网

`yieldMissingToolResultBlocks` 在三个位置触发：

1. 外层错误处理器（模型崩溃）
2. 降级处理器（模型切换中途流）
3. 中止处理器（用户中断）

为每个未获得结果的 `tool_use` block 创建错误 `tool_result`，防止协议违规。

### 8.2 持续重试模式（Persistent Retry）

容器/CI 环境中，没有人类来重启。系统每 30 秒发送心跳防止 Kubernetes 杀进程，持续重试最长 5 分钟。

### 8.3 已知的 SSE 流静默中止

SSE 流可能静默断开（无错误事件），导致循环收到部分响应后错误地认为正常完成。目前**没有**流看门狗机制。

## 九、评价

### 优点

- **错误扣留模式**精妙：SDK 消费者不会因可恢复错误断开
- **10 种终止原因 + 7 种继续原因**：每个路径都有类型化的自文档标签
- **指数退避 + 抖动 + Retry-After**：HTTP 层重试是标准做法
- **Max Output 两阶段恢复**：静默升级 → 多轮恢复，用户无感知
- **每个断路器都有生产事故故事**：不是过度设计，是血的教训
- **Query Source 感知降级**：后台任务不触发降级，避免级联

### 缺点

- **连接错误不重试**：`ECONNRESET`/`EPIPE` 等直接失败，是最常见的用户报告问题
- **所有恢复逻辑在 1730 行 query.ts 中**：无法独立测试或复用
- **无通用断路器原语**：每个限制独立实现
- **SSE 流无看门狗**：静默断流无法检测
- **Feature flag 依赖**：多个恢复路径被 flag 门控，增加了状态组合爆炸

## 引用此分析的认知问题

- [Phase 2 设计方案](../../design/specifications/phase2-complete-agent.md)
