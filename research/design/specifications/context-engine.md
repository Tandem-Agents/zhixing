# 知行上下文引擎设计方案

> **状态**: 📐 方案设计（2026-04-08）
> **前置**: Step 1（容错引擎）已完成
> **信息来源**: OpenClaw 源码分析 + Claude Code 社区逆向分析

## 一、总体目标

让知行能在有限的上下文窗口中稳定运行长对话。具体标志：

1. 能准确知道"当前用了多少 token"
2. 对话接近窗口上限时自动预警
3. 自动压缩上下文，不等 413 才反应
4. 压缩过程有熔断保护，不会失控

## 二、竞品方案对比与知行策略

### 2.1 Token 估算

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 基础算法 | `estimateTokens`（闭源包） | `tokenCountWithEstimation` | **双轨估算器**，完全自研 |
| 精度来源 | chars/4 + 20% 安全余量 | API `usage` 权威值 + 保守增量 | **API 校准 + 自适应比率** |
| CJK 处理 | 辅助路径，不在主线 | 未明确 | **主线一等公民**，CJK/emoji 独立加权 |
| tiktoken | 不用 | 不用 | **不用**（三个产品都验证了不需要） |
| 自适应 | 固定 20% 余量 | 固定保守系数 | **追踪估算误差，动态调整比率** |

**知行超越点：**
- **CJK 一等公民**：对中文用户至关重要，一个中文字约 1-2 token，但 chars/4 会严重低估。我们在核心估算路径直接处理，不是辅助函数
- **自适应校准**：每次 API 返回真实 usage 时，用滑动平均更新 chars-to-token 比率，越用越准
- **不依赖闭源包**：完全自研，100% 可控

### 2.2 上下文预算

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 有效窗口 | min(配置, 模型窗口) | CW - min(maxOut, 20K) | **CW - min(maxOut, 20K)**（采用 Claude Code 公式） |
| 预警阈值 | 无（只检查模型窗口最低值） | 不明确 | **75% 有效窗口** → yield warning 事件 |
| 压缩阈值 | overflow 后被动触发 | effectiveWindow - 13K | **85% 有效窗口** → 自动压缩 |
| 硬挡 | 无 | effectiveWindow - 3K | **95% 有效窗口** → 强制压缩/阻断 |

**知行超越点：**
- **百分比阈值替代绝对值**：Claude Code 用固定 13K/3K，在 32K 窗口的小模型上几乎占了一半空间。百分比方式自适应不同窗口大小
- **预警事件**：通过 EventBus 发射 `context:budget_warning`，CLI 可实时展示"当前 78% / 200K"
- **三级阈值**：预警（75%）→ 自动压缩（85%）→ 硬挡（95%），比 Claude Code 的两级更平滑

### 2.3 压缩策略

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 层数 | 1 层（委托闭源包） + Safeguard 可选 | 5 层递进 | **3 层**（Phase 2），可扩展 |
| 复杂度 | 中等（Safeguard 模式复杂） | 极高（5 层 + 缓存感知） | **低→中**（渐进增加） |
| 触发 | 被动（overflow/timeout） | 主动（阈值监控） | **主动**（每轮检查预算） |
| 熔断 | 次数上限（2/3 次） | 连续 3 次失败停止 | **通用 CircuitBreaker**（已实现） |
| 可插拔 | Context Engine 接口好但实现空 | 硬编码 | **策略模式**，register 自定义策略 |

**知行 3 层策略设计：**

```
L1: ToolResult 截断（免费，每轮自动执行）
  ├ 超过 N 轮前的 tool_result，截断为前 maxChars 字符 + "[已截断]"
  ├ 对当前轮和前一轮的 tool_result 不截断（LLM 可能还在引用）
  └ 触发：每次 turn_complete 时自动检查

L2: 早期消息丢弃（免费，阈值触发）
  ├ 保留第一条 user 消息（原始意图）+ 最近 N 轮
  ├ 中间的消息直接丢弃，注入一条 "[前 X 轮对话已省略]" 提示
  └ 触发：估算 token ≥ 85% 有效窗口

L3: LLM 摘要压缩（昂贵，最终手段）
  ├ Fork 子对话，用简化版摘要模板请求 LLM 总结
  ├ 摘要替换被丢弃的消息，保留关键上下文
  ├ 熔断器：3 次连续失败则停止（复用已有 CircuitBreaker）
  └ 触发：L2 后估算 token 仍 ≥ 90% 有效窗口
```

**知行超越点：**
- **3 层而非 5 层**：Claude Code 的 5 层中，Snip 和 Microcompact 本质上都是"丢弃早期内容"的不同粒度。我们合并为一个 L2，降低实现复杂度
- **策略可插拔**：用户可以 `contextEngine.registerStrategy()` 添加自定义压缩策略（如项目特定的上下文保留规则）
- **复用 CircuitBreaker**：不像 OpenClaw 在各处硬编码次数上限，也不像 Claude Code 用 `consecutiveFailures` 计数器——直接复用已经实现的通用熔断器
- **每轮主动检查**：不等 413 才反应（OpenClaw 的做法），也不用复杂的 cache 对齐逻辑（Claude Code 的做法）

## 三、核心类型设计

### 3.1 Token 估算器

```typescript
interface TokenEstimator {
  /** 估算单条消息的 token 数 */
  estimateMessage(message: Message): number;

  /** 估算消息列表的总 token 数 */
  estimateMessages(messages: Message[]): number;

  /** 用 API 返回的真实值校准估算比率 */
  calibrate(estimatedTokens: number, actualTokens: number): void;

  /** 当前的 chars-to-token 比率（用于诊断） */
  readonly charsPerToken: number;
}
```

### 3.2 估算算法

```typescript
function estimateTokensForText(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (isCJK(char) || isEmoji(char)) {
      tokens += CJK_TOKEN_WEIGHT;     // 约 1.5
    } else {
      tokens += LATIN_TOKEN_WEIGHT;    // 约 0.25 (= 1/4)
    }
  }
  return Math.ceil(tokens);
}
```

每次 API 返回 `usage` 时：

```typescript
function calibrate(estimated: number, actual: number): void {
  const ratio = actual / estimated;
  // 滑动平均，平滑调整（不会因单次偏差剧烈波动）
  this.calibrationFactor = this.calibrationFactor * 0.8 + ratio * 0.2;
}
```

### 3.3 上下文预算

```typescript
interface ContextBudget {
  /** 模型的上下文窗口大小 */
  contextWindow: number;
  /** 有效窗口 = contextWindow - min(maxOutput, 20_000) */
  effectiveWindow: number;
  /** 当前估算的 token 使用量 */
  currentTokens: number;
  /** 使用比例 */
  usageRatio: number;
  /** 预算状态 */
  status: 'normal' | 'warning' | 'compact' | 'critical';
}

// 状态判定
function getBudgetStatus(ratio: number): BudgetStatus {
  if (ratio >= 0.95) return 'critical';   // 硬挡
  if (ratio >= 0.85) return 'compact';    // 自动压缩
  if (ratio >= 0.75) return 'warning';    // 预警
  return 'normal';
}
```

### 3.4 压缩策略接口

```typescript
interface CompactionStrategy {
  /** 策略名称 */
  readonly name: string;
  /** 优先级（越小越先执行） */
  readonly priority: number;
  /** 是否需要调用 LLM（影响成本判断） */
  readonly requiresLLM: boolean;

  /** 判断当前状态是否适合执行此策略 */
  canApply(context: CompactionContext): boolean;

  /** 执行压缩 */
  apply(context: CompactionContext): Promise<CompactionResult>;
}

interface CompactionContext {
  messages: Message[];
  budget: ContextBudget;
  estimator: TokenEstimator;
  /** 当前轮次，用于判断哪些 tool_result 可以截断 */
  currentTurn: number;
}

interface CompactionResult {
  /** 压缩后的消息 */
  messages: Message[];
  /** 压缩前的估算 token 数 */
  tokensBefore: number;
  /** 压缩后的估算 token 数 */
  tokensAfter: number;
  /** 是否成功压缩 */
  compacted: boolean;
}
```

### 3.5 上下文引擎

```typescript
interface ContextEngine {
  /** Token 估算器 */
  readonly estimator: TokenEstimator;

  /** 注册压缩策略 */
  registerStrategy(strategy: CompactionStrategy): void;

  /** 检查预算并在需要时执行压缩 */
  checkAndCompact(params: {
    messages: Message[];
    currentTurn: number;
    modelInfo: { contextWindow: number; maxOutputTokens: number };
  }): Promise<{
    messages: Message[];
    budget: ContextBudget;
    compacted: boolean;
    strategyUsed?: string;
  }>;

  /** 用 API 返回的 usage 校准估算器 */
  reportActualUsage(usage: TokenUsage): void;
}
```

## 四、与 Agent Loop 的集成

### 4.1 集成点

```
Agent Loop 每轮流程：
  1. LLM 调用 → 收到 usage → 校准估算器
  2. 工具执行 → 收到结果
  3. Turn complete → 检查预算
     - normal → 继续
     - warning → yield context_warning 事件
     - compact → 执行 L1→L2 压缩
     - critical → 执行 L1→L2→L3 压缩，仍超 → yield error
  4. 状态重建（压缩后的消息替换原消息）
```

### 4.2 不修改 agent-loop.ts 的方案

与 Step 1（容错引擎）相同的策略——通过外部包装注入，而非修改核心循环。

**方案 A：Context-aware deps.callLLM（推荐）**

在 `run-agent.ts` 中，用一个包装函数在 LLM 调用前后执行预算检查：

```typescript
function withContextManagement(
  callLLM: CallLLMFn,
  contextEngine: ContextEngine,
  options: ContextOptions,
): CallLLMFn {
  return async function* (request) {
    // LLM 调用前：检查并压缩消息
    // LLM 调用后：校准估算器
    // 这需要能修改 request.messages
  };
}
```

**问题**：`callLLM` 签名中 `request.messages` 是只读的，压缩需要修改消息列表。

**方案 B：Agent Loop 预留 hook（最小改动）**

在 `agent-loop.ts` 的 `while(true)` 中，在 LLM 调用前后各加一个可选 hook：

```typescript
// agent-loop.ts — 在现有 guard 之后、LLM 调用之前
if (params.beforeLLMCall) {
  state = await params.beforeLLMCall(state);
}

// LLM 调用后，收到 usage 时
if (params.afterLLMCall) {
  params.afterLLMCall(llmResult.usage);
}
```

**方案 C：Turn-level 后处理（最简，推荐 Phase 2）**

不改 agent-loop.ts，在 `run-agent.ts` 的消费循环中拦截 `turn_complete` 事件，
在下一轮开始前修改外部维护的 messages：

```typescript
// run-agent.ts
case "turn_complete":
  const budget = contextEngine.checkBudget(state.messages, modelInfo);
  if (budget.status !== 'normal') {
    const result = await contextEngine.compact(state.messages, budget);
    if (result.compacted) {
      state.messages = result.messages;  // 需要 messages 可外部修改
    }
  }
  break;
```

**问题**：当前 Agent Loop 内部维护 messages，外部无法修改。

### 4.3 推荐方案

**Phase 2 采用方案 B**（最小改动）：

1. 给 `AgentLoopParams` 加一个可选的 `contextManager` 参数
2. 在 turn_complete 后、下一轮 LLM 调用前，调用 `contextManager.onTurnComplete(state)`
3. contextManager 返回可能修改过的 messages
4. 这比方案 A 干净（不需要 hack callLLM），比方案 C 可行（可以修改内部状态）

改动范围：`agent-loop.ts` 增加约 10 行代码（调用可选的 contextManager hook）。

## 五、事件系统集成

新增的 AgentEventMap 事件（需更新 `types/agent-events.ts`）：

```typescript
// 上下文预算
"context:budget_check": {
  currentTokens: number;
  effectiveWindow: number;
  usageRatio: number;
  status: 'normal' | 'warning' | 'compact' | 'critical';
};

// 压缩执行
"context:compact_start": {
  strategy: string;
  tokensBefore: number;
};

"context:compact_end": {
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  success: boolean;
};

// 估算器校准
"context:calibrate": {
  estimated: number;
  actual: number;
  newRatio: number;
};
```

## 六、渐进实现路线

每一步独立可验证，不依赖后续步骤。

### Step 2A — Token 估算器

```
位置: packages/core/src/context/token-estimator.ts
内容:
  - estimateMessage(message): number
  - estimateMessages(messages): number
  - CJK/emoji 独立加权
  - calibrate() 自适应校准
验证:
  - 单元测试：纯英文/纯中文/混合文本的估算
  - 对比 API 返回的真实 token 数，误差 < 25%
  - calibrate 后误差进一步降低
交付: token-estimator.ts + token-estimator.test.ts
```

### Step 2B — 上下文预算

```
位置: packages/core/src/context/budget.ts
内容:
  - calculateBudget(modelInfo, currentTokens): ContextBudget
  - getBudgetStatus(ratio): BudgetStatus
  - 配置：阈值百分比可自定义
验证:
  - 单元测试：不同窗口大小 × 不同使用量 → 正确状态
  - 边界条件：0 token、超过窗口、窗口极小
交付: budget.ts + budget.test.ts
```

### Step 2C — L1 策略：ToolResult 截断

```
位置: packages/core/src/context/strategies/tool-result-trim.ts
内容:
  - 对超过 staleTurnThreshold 轮的 tool_result 截断
  - 保留前 N 字符 + "[已截断，共 X 字符]"
验证:
  - 单元测试：新旧 tool_result 混合 → 只截断旧的
  - Token 估算在截断后下降
交付: tool-result-trim.ts + test
```

### Step 2D — Agent Loop 集成（预算检查）

```
位置: packages/core/src/loop/agent-loop.ts（~10 行改动）
内容:
  - AgentLoopParams 新增 contextManager?: ContextManager
  - turn_complete 后调用 contextManager.onTurnComplete()
  - yield context_warning / context_budget_check 事件
验证:
  - 现有测试不受影响（contextManager 可选）
  - 新增测试：注入 mock contextManager → 收到正确的回调
交付: 修改 agent-loop.ts + types.ts，新增测试
```

### Step 2E — L2 策略：早期消息丢弃

```
位置: packages/core/src/context/strategies/message-drop.ts
内容:
  - 保留第一条 user + 最近 N 轮
  - 插入 "[前 X 轮已省略]" 占位消息
验证:
  - 50 轮 mock 对话 → 丢弃后消息数减少
  - 丢弃后 token 估算低于阈值
交付: message-drop.ts + test
```

### Step 2F — CLI 集成

```
位置: packages/cli/src/render.ts + run-agent.ts
内容:
  - 监听 context:budget_check 事件
  - 在终端底部显示 "[78% · 156K/200K tokens]"
  - budget_warning 时变黄色，compact 时变红色
验证:
  - REPL 模式下可见预算状态
  - 超过阈值时自动压缩，终端显示压缩过程
交付: 修改 render.ts + run-agent.ts
```

### Step 2G — L3 策略：LLM 摘要压缩（后续阶段）

```
位置: packages/core/src/context/strategies/llm-summarize.ts
内容:
  - Fork 子对话，用简化版摘要模板
  - 摘要替换被丢弃的消息
  - 复用 CircuitBreaker（3 次连续失败停止）
验证:
  - 压缩后 token 显著下降
  - 对话可继续且上下文一致
  - 连续失败触发熔断
交付: llm-summarize.ts + test
依赖: 需要 Provider 层已可用（已完成）
```

## 七、文件结构规划

```
packages/core/src/
  context/
    index.ts                          ← Step 2A
    token-estimator.ts                ← Step 2A
    budget.ts                         ← Step 2B
    engine.ts                         ← Step 2D
    types.ts                          ← Step 2A/2B
    strategies/
      tool-result-trim.ts             ← Step 2C
      message-drop.ts                 ← Step 2E
      llm-summarize.ts                ← Step 2G
    __tests__/
      token-estimator.test.ts         ← Step 2A
      budget.test.ts                  ← Step 2B
      tool-result-trim.test.ts        ← Step 2C
      message-drop.test.ts            ← Step 2E
      integration.test.ts             ← Step 2D
```

## 八、设计原则

1. **主动监控，不等出事**：每轮检查预算，不等 413 才反应（OpenClaw 的教训）
2. **成本优先级联**：先做免费操作（L1/L2），最后才调 LLM（L3）
3. **CJK 一等公民**：核心估算路径直接处理多字节字符，不是辅助函数
4. **自适应精度**：追踪估算误差，每次 API 调用后自动校准
5. **复用已有原语**：CircuitBreaker（容错引擎）、EventBus（可观测性）都已实现
6. **百分比阈值**：自适应不同窗口大小，不硬编码绝对值
7. **可插拔策略**：`registerStrategy()` 允许自定义压缩逻辑
8. **渐进实现**：每步独立可验证，从 Token 估算到 LLM 摘要逐步构建
