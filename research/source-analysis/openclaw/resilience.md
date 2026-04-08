# OpenClaw — 容错与韧性架构分析

> **分析状态**: ✅ 已分析（2026-04-08）
>
> **分析范围**: 错误分类、重试机制、Failover 架构、熔断模式、上下文溢出恢复、超时处理

## 模块定位

OpenClaw 的容错能力分散在外层编排循环（`run.ts`）和多个辅助模块中。这是一个**有机演化的系统**——每种故障处理都是独立添加的，缺乏统一的韧性抽象。

## 信息来源

| 来源 | 路径 | 可信度 |
|------|------|--------|
| 外层循环 | `src/agents/pi-embedded-runner/run.ts` (~1400 行) | ★★★★★ |
| Failover 策略 | `src/agents/pi-embedded-runner/run/failover-policy.ts` | ★★★★★ |
| Assistant Failover | `src/agents/pi-embedded-runner/run/assistant-failover.ts` | ★★★★★ |
| Auth 控制器 | `src/agents/pi-embedded-runner/run/auth-controller.ts` | ★★★★★ |
| 错误分类 | `src/agents/pi-embedded-helpers/errors.ts` + `failover-matches.ts` | ★★★★★ |
| FailoverError | `src/agents/failover-error.ts` | ★★★★★ |
| Backoff 工具 | `src/infra/backoff.ts` | ★★★★★ |
| Thinking 降级 | `src/agents/pi-embedded-helpers/thinking.ts` | ★★★★★ |
| Idle 超时 | `src/agents/pi-embedded-runner/run/llm-idle-timeout.ts` | ★★★★★ |

## 一、错误分类体系

### 1.1 FailoverReason — 可恢复故障的"原因桶"

```typescript
// src/agents/pi-embedded-helpers/types.ts
type FailoverReason =
  | "auth"             // 认证失败 (401)
  | "auth_permanent"   // 永久认证失败 (403)
  | "format"           // 请求格式错误 (400/422)
  | "rate_limit"       // 速率限制 (429)
  | "overloaded"       // 服务过载 (529/503)
  | "billing"          // 计费问题 (402)
  | "timeout"          // 请求超时
  | "model_not_found"  // 模型不存在
  | "session_expired"  // 会话过期
  | "unknown";         // 未归类
```

### 1.2 Context Overflow — 独立分类

上下文溢出**不走** FailoverReason，单独处理。原因：溢出需要的是压缩/截断，而不是切换模型（切到更小窗口的模型会更糟）。

```typescript
// src/agents/pi-embedded-helpers/errors.ts
function isLikelyContextOverflowError(errorMessage?: string): boolean {
  // 排除 TPM 限制（Groq 用 413 做 TPM）、计费、速率限制
  if (hasRateLimitTpmHint(errorMessage)) return false;
  if (isBillingErrorMessage(errorMessage)) return false;
  if (isRateLimitErrorMessage(errorMessage)) return false;
  // 确认是真正的上下文溢出
  if (isContextOverflowError(errorMessage)) return true;
  return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}
```

### 1.3 分类管线

三层分类，从结构化到文本匹配逐层降级：

```
HTTP Status (429/503/401...) → Error Code (RESOURCE_EXHAUSTED) → 消息文本正则匹配
```

```typescript
// src/agents/pi-embedded-helpers/errors.ts
function classifyFailoverSignal(signal: FailoverSignal): FailoverClassification | null {
  // 第 1 层：HTTP 状态码
  const statusClassification = classifyFromHttpStatus(inferredStatus, signal.message);
  if (statusClassification) return statusClassification;
  // 第 2 层：错误代码
  const codeReason = classifyFromCode(signal.code);
  if (codeReason) return codeReason;
  // 第 3 层：消息文本匹配
  return classifyFromMessage(signal.message);
}
```

### 1.4 文本匹配模式库

```typescript
// src/agents/pi-embedded-helpers/failover-matches.ts
const ERROR_PATTERNS = {
  rateLimit: [
    /rate[_ ]limit|too many requests|429/,
    "model_cooldown", "resource_exhausted", "throttling", "tokens per day"
  ],
  overloaded: [
    /overloaded_error|"type"\s*:\s*"overloaded_error"/i,
    "overloaded", "high demand"
  ],
  // ...
};
```

## 二、重试机制

### 2.1 外层 while(true) 的重试上限

```typescript
// src/agents/pi-embedded-runner/run/helpers.ts
const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled = BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}
```

1 个 profile → 32 次上限；10 个 profiles → 104 次上限。

### 2.2 关键发现：没有通用指数退避

**OpenClaw 的外层循环没有对每次失败做指数退避。** `src/infra/backoff.ts` 中有 `computeBackoff` + `sleepWithAbort` 工具函数，但**仅用于**配置加载等外围场景，不用于主重试循环。

唯一的退避是 `overloaded` 故障的可选固定延迟：

```typescript
// src/agents/pi-embedded-runner/run.ts
const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
  if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) return;
  await sleepWithAbort(overloadFailoverBackoffMs, params.abortSignal);
};
```

默认 `overloadedBackoffMs = 0`（即不等待）。

## 三、Failover 架构

### 3.1 决策状态机

`failover-policy.ts` 实现了一个两阶段决策器：

```
prompt 侧错误                    assistant 侧错误
    ↓                                ↓
可 rotate_profile?  ──→ rotate    可 rotate_profile?  ──→ rotate
    ↓ 否                             ↓ 否
有 fallback 配置? ──→ fallback    有 fallback 配置? ──→ fallback
    ↓ 否                             ↓ 否
surface_error                     surface_error
```

### 3.2 Auth Profile 轮换

```typescript
// src/agents/pi-embedded-runner/run/auth-controller.ts
const advanceAuthProfile = async (): Promise<boolean> => {
  // 1. 锁定 profile 时不允许轮换
  if (params.lockedProfileId) return false;
  // 2. 按候选列表顺序尝试，跳过 cooldown 中的
  let nextIndex = params.getProfileIndex() + 1;
  while (nextIndex < params.profileCandidates.length) {
    const candidate = params.profileCandidates[nextIndex];
    if (isProfileInCooldown(params.authStore, candidate, undefined, params.getModelId())) {
      nextIndex += 1;
      continue;
    }
    // 3. 成功后重置 thinkLevel 和 attemptedThinking
    await applyApiKeyInfo(candidate);
    params.setProfileIndex(nextIndex);
    params.setThinkLevel(params.initialThinkLevel);
    params.attemptedThinking.clear();
    return true;
  }
  return false;
};
```

### 3.3 Thinking 降级

```typescript
// src/agents/pi-embedded-helpers/thinking.ts
function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  // 1. 从错误消息提取支持的 thinking levels
  const supported = extractSupportedValues(raw);
  // 2. 选择未尝试过的最高级别
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized || params.attempted.has(normalized)) continue;
    return normalized;
  }
  // 3. 兜底：如果明确不支持 thinking，降到 "off"
  if (/not supported/i.test(raw) && !params.attempted.has("off")) return "off";
  return undefined;
}
```

### 3.4 模型级 Fallback

`model-fallback.ts` 包裹整个 `runEmbeddedPiAgent`：

```typescript
// src/agents/model-fallback.ts
// 捕获 FailoverError → 切换到下一个 fallback 模型 → 重新运行
// 关键约束：上下文溢出不向 fallback 链传播
if (isLikelyContextOverflowError(errMessage)) {
  throw err;  // 不 fallback，直接抛出
}
```

## 四、熔断模式

OpenClaw 没有通用的断路器抽象，而是在各处硬编码了尝试上限：

| 机制 | 常量 | 值 | 效果 |
|------|------|----|------|
| 外层循环总迭代 | `MAX_RUN_LOOP_ITERATIONS` | 32-160 | 超限返回错误 |
| 超时压缩尝试 | `MAX_TIMEOUT_COMPACTION_ATTEMPTS` | 2 | 跳过压缩 |
| 溢出压缩尝试 | `MAX_OVERFLOW_COMPACTION_ATTEMPTS` | 3 | 表面化错误 |
| Rate limit profile 轮换 | `rateLimitProfileRotationLimit` | 1（配置可改） | 抛 FailoverError |
| Overload profile 轮换 | `overloadProfileRotationLimit` | 1（配置可改） | 抛 FailoverError |
| 工具循环全局断路器 | `globalCircuitBreakerThreshold` | 30 | 停止工具执行 |

## 五、上下文溢出恢复

三步级联：

```
1. SDK 内 compaction（attempt 内，Pi-Agent-Core 自动触发）
   ↓ 仍溢出
2. contextEngine.compact({ force: true, trigger: "overflow" })
   + runContextEngineMaintenance
   ↓ 仍溢出
3. truncateOversizedToolResultsInSession（截断过大工具结果）
   ↓ 仍溢出
表面化错误给用户
```

超时路径有独立的压缩触发：prompt token 占 context 的比例 > 0.65 时才压缩（避免浪费）。

## 六、超时处理

### 6.1 Run 级超时

`attempt.ts` 中 `scheduleAbortTimer(params.timeoutMs)` 控制整体超时。如果超时时正在做 compaction，会给一次 `compactionTimeoutMs` 的延长（grace period）。

### 6.2 LLM 流式 Idle 超时

默认 60 秒无 token → 触发 `idleTimeoutTrigger` → `abortRun`。

```typescript
// src/agents/pi-embedded-runner/run/llm-idle-timeout.ts
const DEFAULT_LLM_IDLE_TIMEOUT_MS = 60_000;
```

## 七、评价

### 优点

- **错误分类三层降级**很稳健：HTTP 状态 → 错误码 → 文本匹配
- **上下文溢出独立于 failover**：避免切到更小窗口模型
- **Thinking 降级**有创意：从错误消息自动推断支持的级别
- **Profile 轮换与 cooldown 配合**：避免重复打同一个限流的 profile

### 缺点

- **没有通用指数退避**：429 重试没有退避，可能快速耗尽 retry 上限
- **没有熔断器抽象**：每个限制独立硬编码，不可复用
- **overloaded 退避默认关闭**：`overloadedBackoffMs = 0`
- **外层循环 1400+ 行**：容错逻辑与编排逻辑深度耦合
- **连接级错误未专门处理**：ECONNRESET 等走通用路径

## 引用此分析的认知问题

- [Phase 2 设计方案](../../design/specifications/phase2-complete-agent.md)
