# 知行容错引擎设计方案

> **状态**: 📐 方案设计（2026-04-08）
> **前置**: Phase 2A 全部完成（Agent Loop + Provider + 完整工具集 + CLI）
> **信息来源**: OpenClaw 容错分析 + Claude Code 韧性架构分析

## 零、产品定位与韧性需求

### 知行不是 CLI 工具，是独立部署的个人智能体

知行对接的是微信、钉钉等通讯软件。这从根本上决定了韧性需求与 Claude Code（CLI）截然不同：


| 维度   | CLI 工具（Claude Code） | 个人智能体（知行）              |
| ---- | ------------------- | ---------------------- |
| 运行模式 | 用户主动启动，用完退出         | **7×24 常驻运行**          |
| 用户交互 | 坐在终端前盯着             | **发消息后就走了，等回复**        |
| 失败处理 | 用户看到报错，手动重试         | **必须自己恢复，或主动告知用户**     |
| 连接管理 | 无（直接 stdio）         | **需要维持与微信/钉钉的长连接**     |
| 并发   | 单用户单会话              | **多通道、多会话并行**          |
| 消息丢失 | 不存在                 | **不可接受——用户发了就期望有回复**   |
| 静默失败 | 可接受（用户能看到）          | **不可接受——用户以为你收到了但不理他** |


### 四层韧性模型

知行的韧性需要覆盖从通道连接到 LLM 调用的每一层：

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 1: 通道韧性 (Channel Resilience)                         │
│  微信/钉钉连接断了？自动重连 + 消息缓冲                           │
│  复用: ExponentialBackoff + CircuitBreaker                     │
├────────────────────────────────────────────────────────────────┤
│  Layer 2: 消息处理韧性 (Message Processing Resilience)          │
│  收到消息但处理失败？入队持久化 + 重试 + 超时降级回复              │
│  复用: ExponentialBackoff + CircuitBreaker                     │
├────────────────────────────────────────────────────────────────┤
│  Layer 3: Agent 运行韧性 (Agent Runtime Resilience)             │
│  LLM 调用失败？指数退避 + 熔断 + 错误分类                         │
│  本文档核心设计内容                                              │
├────────────────────────────────────────────────────────────────┤
│  Layer 4: 服务韧性 (Service Resilience)                         │
│  进程崩溃？健康检查 + 优雅关闭 + 未完成消息恢复                    │
│  复用: CircuitBreaker                                          │
└────────────────────────────────────────────────────────────────┘
```

### 各层实现时机


| 层                      | 何时实现             | 触发条件                           |
| ---------------------- | ---------------- | ------------------------------ |
| **Layer 3** Agent 运行韧性 | **现在**（Phase 2B） | 无论 CLI 还是通道模式都需要               |
| **Layer 2** 消息处理韧性     | Phase 3（消息管线）    | 实现 Gateway 或 Channel Adapter 时 |
| **Layer 1** 通道韧性       | Phase 3（通道接入）    | 实现微信/钉钉适配器时                    |
| **Layer 4** 服务韧性       | Phase 4（生产部署）    | 实现 Server 和部署方案时               |


**关键设计约束：Layer 3 的原语（Backoff、CircuitBreaker）必须足够通用，供所有层复用。**

### 个人智能体特有的韧性要求

以下能力在 CLI 工具中不需要，但在个人智能体中**必须具备**：

**1. 消息不丢失（至少一次交付）**

```
用户 → 微信消息 → 知行收到 → 持久化到本地队列 → 处理
                                    ↓ 失败
                              退避后重试（复用 ExponentialBackoff）
                                    ↓ 超时
                              降级回复 "正在处理中，请稍候"
```

**2. 用户可见的降级回复**

CLI 场景：失败了 stderr 打印错误（用户看得到）。
通道场景：LLM 全部失败 → **通过微信回复 "抱歉，我暂时遇到了问题，稍后会再处理你的消息"**。

**3. 会话隔离**

同时和 A、B、C 三个人对话，A 的对话触发 LLM 错误不能影响 B 和 C。
每个会话有独立的 CircuitBreaker 状态。

**4. 通道连接管理**

微信长连接会断，需要：

- 心跳检测 + 自动重连（复用 ExponentialBackoff）
- 重连期间的消息缓冲
- 连续重连失败的熔断（复用 CircuitBreaker）→ 告警

---

## 一、竞品方案对比总表


| 维度           | OpenClaw                                    | Claude Code                                       | **知行策略**                                   |
| ------------ | ------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| **产品形态**     | 个人智能体（多通道）                                  | CLI 工具                                            | **个人智能体**，需求更接近 OpenClaw                   |
| **重试退避**     | 无通用退避（overloaded 有可选固定延迟，默认 0）              | 指数退避 + 抖动（withRetry.ts），但连接错误不重试                  | **指数退避 + 抖动 + Retry-After**，覆盖 API 错误和连接错误 |
| **错误分类**     | FailoverReason 扁平枚举 + 三层分类管线                | Terminal 联合 + HTTP 层分类                            | **结构化错误类型 + 恢复策略映射**                       |
| **Failover** | auth profile 轮换 → thinking 降级 → 模型 fallback | withRetry 内 3 次重试 → FallbackTriggeredError → 模型切换 | **Phase 1 不实现 Failover，预留接口**              |
| **熔断器**      | 各处硬编码限制（无统一抽象）                              | 各处硬编码限制（无统一抽象）                                    | **通用 CircuitBreaker 原语**，跨层复用              |
| **失败通知**     | 无（CLI 打印）                                   | 无（CLI 打印）                                         | **降级回复**：通过通道主动告知用户                        |
| **连接错误**     | 走通用路径                                       | 不重试（已知最大缺陷）                                       | **重试**，与 API 错误同等对待                        |
| **消息丢失**     | Gateway 排队保障                                | 不存在此问题                                            | **本地持久化队列**（Layer 2 实现）                    |
| **通道重连**     | 各 Channel 独立实现                              | 无                                                 | **通用重连原语**，复用 Backoff + CircuitBreaker     |
| **实现位置**     | 外层循环内（1400+ 行混合）                            | query.ts 内（1730 行混合）                              | **独立模块**，不污染 Agent Loop                    |
| **可观测性**     | 日志                                          | 内部遥测                                              | **EventBus 事件**，CLI/通道/管理面板都可消费            |


## 二、核心设计原则

### 2.1 分离：容错不侵入循环

OpenClaw 和 Claude Code 最大的问题是容错逻辑与 Agent Loop 深度耦合。
知行的容错逻辑**完全在 Agent Loop 外部**，通过 `deps.callLLM` 包装注入：

```
Agent Loop（纯净的推理循环）
    ↓ 调用
deps.callLLM（被 withRetry 包装）
    ↓ 包含
指数退避 + 错误分类 + 重试决策
```

Agent Loop 的 `agent-loop.ts` **零修改**。

### 2.2 可复用原语

不像 OpenClaw/Claude Code 到处硬编码限制，我们提取两个通用原语：

- **ExponentialBackoff**：计算退避延迟——LLM 重试、通道重连、消息重处理都用
- **CircuitBreaker**：追踪失败次数并在阈值后熔断——LLM 熔断、通道熔断、压缩熔断都用

### 2.3 可观测的每一步

每次重试、每次退避、每次熔断都通过 EventBus 发射事件。
CLI 实时展示；通道模式下可推送到管理面板或告警系统。

### 2.4 失败必须可见

个人智能体的核心约束：**用户发了消息，必须收到回复——即使是降级回复。**
静默失败是不可接受的。

## 三、错误分类设计

### 3.1 从 AgentErrorType 到恢复策略

知行已有 `AgentErrorType`（`@zhixing/core` types/errors.ts），定义了 10 种错误类型。
容错引擎为每种类型映射恢复策略：

```typescript
type RecoveryAction = "retry" | "abort" | "surface";

const RECOVERY_MAP: Record<AgentErrorType, {
  action: RecoveryAction;
  retryable: boolean;
  maxRetries: number;
  useBackoff: boolean;
}> = {
  rate_limit:       { action: "retry",   retryable: true,  maxRetries: 10, useBackoff: true },
  timeout:          { action: "retry",   retryable: true,  maxRetries: 3,  useBackoff: true },
  network:          { action: "retry",   retryable: true,  maxRetries: 5,  useBackoff: true },
  context_overflow: { action: "surface", retryable: false, maxRetries: 0,  useBackoff: false },
  auth:             { action: "retry",   retryable: true,  maxRetries: 1,  useBackoff: false },
  provider_error:   { action: "retry",   retryable: true,  maxRetries: 3,  useBackoff: true },
  invalid_request:  { action: "surface", retryable: false, maxRetries: 0,  useBackoff: false },
  tool_error:       { action: "surface", retryable: false, maxRetries: 0,  useBackoff: false },
  aborted:          { action: "abort",   retryable: false, maxRetries: 0,  useBackoff: false },
  unknown:          { action: "retry",   retryable: true,  maxRetries: 2,  useBackoff: true },
};
```

**"surface" 在不同模式下的含义不同：**

- CLI 模式：打印错误到 stderr
- 通道模式：通过微信/钉钉发送降级回复给用户

### 3.2 LLM Provider 错误 → AgentErrorType 映射

Provider 层已有的错误需要映射到 AgentErrorType。新增分类函数：

```typescript
function classifyProviderError(error: unknown): AgentErrorType {
  // 第 1 层：HTTP 状态码
  if (hasStatus(error, 429)) return "rate_limit";
  if (hasStatus(error, 529) || hasStatus(error, 503)) return "rate_limit";
  if (hasStatus(error, 401) || hasStatus(error, 403)) return "auth";
  if (hasStatus(error, 413)) return "context_overflow";
  if (hasStatus(error, 400) || hasStatus(error, 422)) return "invalid_request";
  if (hasStatus(error, 500) || hasStatus(error, 502)) return "provider_error";

  // 第 2 层：连接错误（Claude Code 的缺陷 — 我们修复它）
  if (isConnectionError(error)) return "network";

  // 第 3 层：超时
  if (isTimeoutError(error)) return "timeout";

  return "unknown";
}
```

### 3.3 超越点：连接错误覆盖

OpenClaw 走通用路径处理连接错误，Claude Code 完全不重试。我们将 `ECONNRESET`、`EPIPE`、`ETIMEDOUT`、`ECONNREFUSED`、`ENOTFOUND`、`ERR_SOCKET_CONNECTION_TIMEOUT` 全部归为 `network` 类型，最多重试 5 次。

## 四、指数退避设计

### 4.1 核心函数

```typescript
interface BackoffConfig {
  baseDelayMs: number;      // 默认 500
  maxDelayMs: number;        // 默认 30_000
  jitter: boolean;           // 默认 true
}

function computeBackoffDelay(attempt: number, config: BackoffConfig): number {
  const exponential = config.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);
  if (!config.jitter) return capped;
  return Math.floor(Math.random() * capped);
}
```

### 4.2 Retry-After 支持

如果 API 响应包含 `Retry-After` 头，优先使用该值（借鉴 Claude Code）：

```typescript
function resolveDelay(attempt: number, error: unknown, config: BackoffConfig): number {
  const retryAfter = extractRetryAfterMs(error);
  if (retryAfter !== undefined) return retryAfter;
  return computeBackoffDelay(attempt, config);
}
```

### 4.3 跨层复用

同一个 `computeBackoffDelay` 在不同层使用不同的配置：


| 层       | 场景         | baseDelayMs | maxDelayMs | 备注      |
| ------- | ---------- | ----------- | ---------- | ------- |
| Layer 3 | LLM 429 重试 | 500         | 30,000     | 快速恢复    |
| Layer 3 | LLM 连接错误   | 1,000       | 30,000     | 稍慢恢复    |
| Layer 2 | 消息重处理      | 5,000       | 120,000    | 更保守     |
| Layer 1 | 微信重连       | 2,000       | 300,000    | 最长 5 分钟 |


## 五、熔断器设计

### 5.1 通用 CircuitBreaker 原语

```typescript
interface CircuitBreakerConfig {
  maxFailures: number;       // 允许的最大连续失败次数
  resetAfterMs?: number;     // 可选：冷却期后重置（半开状态）
}

class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;

  get isOpen(): boolean {
    if (this.failures < this.config.maxFailures) return false;
    if (this.config.resetAfterMs) {
      return (Date.now() - this.lastFailureTime) < this.config.resetAfterMs;
    }
    return true;
  }

  recordFailure(): void { this.failures++; this.lastFailureTime = Date.now(); }
  recordSuccess(): void { this.failures = 0; }
  reset(): void { this.failures = 0; }
}
```

### 5.2 跨层复用


| 层       | 场景        | maxFailures | resetAfterMs   | 熔断后行为          |
| ------- | --------- | ----------- | -------------- | -------------- |
| Layer 3 | LLM 调用    | 10          | —              | 返回错误，上层决定降级回复  |
| Layer 3 | 上下文压缩     | 3           | —              | 停止压缩尝试         |
| Layer 2 | 同一消息重处理   | 3           | —              | 发送降级回复，移入死信    |
| Layer 1 | 微信连接      | 5           | 300,000 (5min) | 停止重连，5 分钟后半开尝试 |
| Layer 4 | LLM 服务可用性 | 10          | 60,000 (1min)  | 所有新消息直接降级回复    |


### 5.3 与 OpenClaw/Claude Code 的对比

两者都在各处硬编码 `if (attempts >= MAX_X)` 检查。我们用一个 CircuitBreaker 实例替代所有硬编码，并且支持**半开状态**（冷却期后自动尝试恢复），这两者都没有。

## 六、withRetry 包装器设计

### 6.1 核心接口

```typescript
interface RetryConfig {
  maxRetries: number;          // 默认 3
  baseDelayMs: number;         // 默认 500
  maxDelayMs: number;          // 默认 30_000
  jitter: boolean;             // 默认 true
  retryableTypes: AgentErrorType[];  // 默认 ['rate_limit', 'timeout', 'network', 'provider_error']
  abortSignal?: AbortSignal;
  eventBus?: IEventBus<AgentEventMap>;
}
```

### 6.2 实现策略

withRetry 包装 `provider.chat()` 的 AsyncGenerator。关键挑战是：流式生成器不能简单用 try/catch 包装。

```typescript
async function* withRetry(
  callFn: () => AsyncGenerator<StreamEvent>,
  config: RetryConfig,
): AsyncGenerator<StreamEvent> {
  let attempt = 0;
  const breaker = new CircuitBreaker({ maxFailures: config.maxRetries });

  while (true) {
    try {
      const stream = callFn();

      for await (const event of stream) {
        if (event.type === "error") {
          const errorType = classifyProviderError(event.error);
          if (shouldRetry(errorType, config, breaker)) {
            attempt++;
            const delay = resolveDelay(attempt, event.error, config);
            emitRetryEvent(config.eventBus, errorType, attempt, delay);
            await sleep(delay, config.abortSignal);
            break;
          }
          yield event;
          return;
        }
        yield event;
      }

      breaker.recordSuccess();
      return;

    } catch (error) {
      const errorType = classifyProviderError(error);
      if (shouldRetry(errorType, config, breaker)) {
        attempt++;
        breaker.recordFailure();
        const delay = resolveDelay(attempt, error, config);
        emitRetryEvent(config.eventBus, errorType, attempt, delay);
        await sleep(delay, config.abortSignal);
        continue;
      }
      yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
      return;
    }
  }
}
```

### 6.3 注入方式

不修改 `agent-loop.ts`——通过 `AgentLoopParams.deps.callLLM` 注入：

```typescript
const retryingCallLLM = (request: ChatRequest) =>
  withRetry(
    () => provider.chat(request),
    { maxRetries: 3, eventBus },
  );

const gen = runAgentLoop({
  provider, model, tools, messages,
  deps: { callLLM: retryingCallLLM },
  eventBus,
});
```

CLI 和通道模式都用同样的注入方式——消费者不同，注入的重试配置可以不同。

## 七、事件系统扩展

### 7.1 新增事件

```typescript
type AgentEventMap = {
  // ... 现有事件 ...

  "retry:attempt": {
    errorType: AgentErrorType;
    attempt: number;
    maxRetries: number;
    delayMs: number;
    willRetry: boolean;
  };

  "retry:exhausted": {
    errorType: AgentErrorType;
    totalAttempts: number;
    lastError: string;
  };

  "retry:success": {
    errorType: AgentErrorType;
    attemptsTaken: number;
    totalDelayMs: number;
  };
};
```

### 7.2 不同消费者的不同渲染

**CLI 模式**（直接展示）：

```
⟡ LLM 调用中...
  ⚠ 速率限制 (429)，第 1/3 次重试，等待 1.2s...
  ⚠ 速率限制 (429)，第 2/3 次重试，等待 2.8s...
  ✓ 重试成功（共耗时 4.0s）
```

**通道模式**（按策略决定是否通知用户）：

- 短暂重试（< 10s）：静默重试，用户无感知
- 长时间重试（> 30s）：发送"正在处理中"状态消息
- 完全失败：发送降级回复

这是 OpenClaw 和 Claude Code 都没有的**分场景可观测性**。

## 八、渐进实现路线

每步独立可验证。

### Step 1: 基础原语（零依赖，纯函数）

```
新增文件:
  packages/core/src/resilience/backoff.ts        — computeBackoffDelay + resolveDelay
  packages/core/src/resilience/circuit-breaker.ts — CircuitBreaker 类
  packages/core/src/resilience/classify.ts        — classifyProviderError
  packages/core/src/resilience/index.ts           — 导出

新增测试:
  packages/core/src/resilience/__tests__/backoff.test.ts
  packages/core/src/resilience/__tests__/circuit-breaker.test.ts
  packages/core/src/resilience/__tests__/classify.test.ts

验证: pnpm -r test 全部通过
```

### Step 2: withRetry 包装器

```
新增文件:
  packages/core/src/resilience/with-retry.ts      — 核心重试包装器

新增测试:
  packages/core/src/resilience/__tests__/with-retry.test.ts
    - mock 429 → 自动退避 → 最终成功
    - mock 连续失败 → 熔断 → 抛出错误
    - mock 连接错误 → 重试
    - mock AbortSignal → 中断重试

修改文件:
  packages/core/src/types/agent-events.ts  — 新增 retry:* 事件
  packages/core/src/index.ts               — 导出 resilience 模块

验证: 单元测试覆盖所有场景
```

### Step 3: CLI 集成

```
修改文件:
  packages/cli/src/run-agent.ts  — 用 withRetry 包装 provider.chat
  packages/cli/src/render.ts     — 渲染重试事件

验证:
  1. 手动断网 → 看到重试提示 → 恢复后继续
  2. 用 mock 模拟 429 → 看到退避等待 → 最终成功
```

### 后续 Steps（随对应模块实现）

```
Layer 2 — 消息处理管线（随 Gateway/Channel 实现）
  新增: packages/core/src/messaging/processor.ts
  功能: 消息入队 → 持久化 → 处理 → 降级回复
  复用: ExponentialBackoff + CircuitBreaker

Layer 1 — 通道连接管理（随具体 Channel Adapter 实现）
  新增: packages/channels/<channel>/reconnect.ts
  功能: 心跳检测 → 自动重连 → 消息缓冲
  复用: ExponentialBackoff + CircuitBreaker

Layer 4 — 服务韧性（随 Server 实现）
  新增: packages/server/src/health.ts
  功能: 健康检查 → 优雅关闭 → 未完成消息恢复
```

## 九、文件结构规划

```
packages/core/src/
  resilience/
    index.ts                — 导出
    backoff.ts              — 指数退避算法（跨层复用）
    circuit-breaker.ts      — 通用熔断器（跨层复用）
    classify.ts             — Provider 错误 → AgentErrorType 映射
    with-retry.ts           — AsyncGenerator 重试包装器
    types.ts                — RetryConfig、RecoveryAction 等
    __tests__/
      backoff.test.ts
      circuit-breaker.test.ts
      classify.test.ts
      with-retry.test.ts
```

## 十、设计原则

1. **不侵入 Agent Loop**：通过 deps.callLLM 注入，agent-loop.ts 零修改
2. **覆盖 Claude Code 的盲区**：连接错误（ECONNRESET 等）同样重试
3. **超越 OpenClaw 的缺失**：每次重试都有指数退避，不会快速耗尽重试次数
4. **跨层复用**：CircuitBreaker 和 ExponentialBackoff 不只用于 LLM 重试——通道重连、消息重处理、上下文压缩都复用同一套原语
5. **失败必须可见**：个人智能体不能静默失败——CLI 展示错误，通道模式发送降级回复
6. **一等公民可观测性**：每次重试、退避、熔断都是 EventBus 事件，CLI/通道/管理面板都可消费
7. **渐进增强**：Phase 2B 做 Layer 3（LLM 韧性），后续 Phase 通过同一套原语扩展到 Layer 1/2/4

