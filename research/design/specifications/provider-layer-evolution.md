# 规格说明：Provider 层演进路线

> **状态**: 待审阅 | **日期**: 2026-04-08  
> **前置分析**: [OpenClaw Transport](../../source-analysis/openclaw/provider-transport.md) | [Claude Code API 层](../../source-analysis/claude-code/api-layer.md)  
> **关联 ADR**: [ADR-002](../architecture/decisions/002-provider-architecture.md)  
> **关联规格**: [Anthropic 适配器](anthropic-adapter.md)

## 目标

定义 Provider 层从 MVP 到产品级的完整演进路线。每个阶段独立可验证、可交付。

## 现状分析

### 已有能力

| 能力 | 状态 | 位置 |
|------|------|------|
| LLMProvider 接口 | ✅ | `@zhixing/core` types/llm.ts |
| StreamEvent 判别联合 | ✅ | 含 thinking_delta |
| OpenAI-compatible 适配器 | ✅ | 7 个预设服务商 |
| 配置级联加载 | ✅ | env → project → global |
| API Key 三格式 | ✅ | env: / helper: / 明文 |
| Quirks 差异系统 | ✅ | maxTokensField, supportsThinking 等 |
| TokenUsage 含缓存字段 | ✅ | cacheReadTokens, cacheWriteTokens |

### 缺口

| 缺口 | 影响 | 优先级 |
|------|------|--------|
| Anthropic 适配器 | 无法用最好的 Agent 模型 | P0 |
| 流式空闲检测 | TCP 死连接无法发现 | P1 |
| 错误分类 | 无法区分可恢复/不可恢复错误 | P1 |
| 重试策略 | API 故障直接终止会话 | P1 |
| Token 计数 | 无法管理上下文预算 | P2 |
| Prompt cache 优化 | 成本偏高 | P3 |

## 竞品方案对比

### OpenClaw 的 Provider 层

**架构**：Api 枚举 → Transport 工厂 → SDK 适配器

**优势**：
- 按协议（Api）组织 Transport，覆盖多服务商
- Cache 策略通过 payload policy 解耦
- 消息转换有独立的 transform 层（处理跨模型 thinking 降级）

**劣势**：
- Transport 层过于庞大（anthropic 862 行、openai 1375 行）
- 认证逻辑（OAuth/Copilot）与传输混在一起
- 缺少空闲检测和非流式回退

### Claude Code 的 API 层

**架构**：统一客户端工厂 → queryModel 编排器 → withRetry 生成器

**优势**：
- 原始 Stream 避免 O(n²) 部分解析
- 空闲看门狗处理 TCP 死连接
- 非流式回退处理代理/网络异常
- 输出 token 预算策略（8K/64K）
- 极致的 prompt cache 系统

**劣势**：
- 只支持 Anthropic
- queryModel ~700 行，职责过多
- 重试逻辑嵌入传输层，不够解耦

## 我们的设计：比两家都好在哪

### 核心差异化

| 维度 | OpenClaw | Claude Code | 知行 |
|------|---------|------------|------|
| **关注点分离** | Transport 混合认证逻辑 | queryModel 混合重试逻辑 | **纯传输 + 独立 Resilience 层** |
| **流式策略** | SDK 高级抽象 | 原始 Stream | **原始 Stream（性能最优）** |
| **多协议** | ✅ 3 种 | ❌ 仅 Anthropic | **✅ 2 种 + 可扩展** |
| **空闲检测** | ❌ | ✅ 硬编码 | **✅ 可配置 + 插件式** |
| **重试** | 外层循环 | 传输层内 | **独立 Resilience Engine** |
| **Cache** | payload policy | sticky latch + 排序 | **渐进式：MVP 简单 → 后续精细** |
| **可测试性** | 难（依赖 Pi SDK） | 难（700 行单函数） | **每个关注点独立可测** |

### 架构分层

```
┌──────────────────────────────────────────────┐
│              Resilience Layer                │
│  重试 / Failover / 空闲检测 / 熔断           │
│  （独立于 Provider，Agent Loop 外层）         │
├──────────────────────────────────────────────┤
│              Provider Layer                  │
│  LLMProvider 接口 + Protocol 适配器          │
│  ┌──────────────────┐ ┌──────────────────┐  │
│  │ openai-compatible │ │anthropic-messages│  │
│  │  （已实现 282 行） │ │  （待实现 ~280 行）│  │
│  └──────────────────┘ └──────────────────┘  │
│  配置解析 + 预设注册表 + Quirks 系统          │
├──────────────────────────────────────────────┤
│              SDK Layer                       │
│  openai + @anthropic-ai/sdk                  │
│  直连官方 SDK，不做额外封装                    │
└──────────────────────────────────────────────┘
```

**关键设计决策**：Provider 层是纯传输——不做重试、不做 Failover、不做空闲检测。这些属于 Resilience 层。

这与 OpenClaw（重试在外层循环）和 Claude Code（重试在传输层内）都不同。我们的 Resilience Engine 是一个独立的中间层，可以包裹任何 Provider，也可以不包裹（测试时直连）。

### Resilience Engine 设计（Provider 的增强包装）

```typescript
interface ResilienceConfig {
  /** 可恢复错误的最大重试次数 */
  maxRetries?: number;
  /** 退避策略 */
  backoff?: { initial: number; max: number; multiplier: number };
  /** 流式空闲超时（毫秒）。默认 90000（90 秒） */
  streamIdleTimeoutMs?: number;
  /** 模型 Failover 列表。主模型失败时依次尝试 */
  fallbackModels?: string[];
  /** 熔断器：连续失败 N 次后停止重试 */
  circuitBreakerThreshold?: number;
}

/**
 * 包裹 LLMProvider，添加容错能力。
 * 不修改 Provider 接口——消费者无感知。
 */
function withResilience(
  provider: LLMProvider,
  config: ResilienceConfig,
): LLMProvider {
  return {
    ...provider,
    async *chat(request) {
      // 重试 + 退避 + 空闲检测 + Failover
    }
  };
}
```

**为什么这样设计**：
- Provider 可以被 Resilience 包裹，也可以不包裹（测试/调试时直连）
- Resilience 逻辑集中在一处，不散布在循环中
- 与 Agent Loop 完全解耦——循环不需要知道重试的存在
- 可以对不同 Provider 配置不同的 Resilience 策略

## 演进路线

### Phase 1: Anthropic 适配器（MVP）

**交付物**：能用 Claude 模型跑通 Agent Loop

- `anthropic-messages.ts` 适配器（消息转换 + 流式处理）
- `create-provider.ts` 添加 anthropic-messages 分支
- 基础测试

**不做**：thinking、cache、空闲检测、重试

**验证**：`zhixing -p "读取 package.json" --provider anthropic`

### Phase 2: Extended Thinking

**交付物**：支持 Claude 的 thinking 能力

- Quirks 扩展：`thinkingMode`、`thinkingBudgetTokens`
- 适配器中的 thinking 双路径（adaptive vs budget）
- thinking_delta 流式传递
- 历史消息中 thinking block 的正确传递

**验证**：能看到思考过程 + 正常的工具调用

### Phase 3: Resilience Engine

**交付物**：API 故障自动恢复

- `withResilience()` 包装器
- 指数退避重试（429/529）
- 流式空闲看门狗（90 秒超时）
- 可恢复错误分类
- EventBus 事件：`resilience:retry`、`resilience:failover`

**验证**：模拟网络中断后自动恢复继续对话

### Phase 4: Prompt Cache 优化

**交付物**：降低 API 成本

- System prompt 拆分（稳定前缀 + 动态后缀）
- 工具列表排序稳定化（内置在前、按名称排序）
- cache_control 断点放置（system + 最后 user）
- TokenUsage 展示 cache 命中率

**验证**：cache_read_tokens > 0 的比例显著提升

### Phase 5: Token 预算管理

**交付物**：自动管理上下文窗口

- `countTokens` API
- 输出 token 策略（8K 默认 + 按需 64K）
- Token 计量：权威值 + 保守估算
- 上下文使用率事件：`context:usage`

**验证**：长对话中 token 计量准确、不超窗口

## 文件变更清单

### Phase 1 新增/修改

```
packages/providers/
├── src/
│   ├── adapters/
│   │   └── anthropic-messages.ts    # 新增 ~280 行
│   └── create-provider.ts           # 修改 +5 行
├── package.json                     # 依赖 @anthropic-ai/sdk
└── src/__tests__/
    └── anthropic-messages.test.ts   # 新增 ~300 行
```

### Phase 3 新增

```
packages/core/
└── src/
    └── resilience/
        ├── index.ts
        ├── with-resilience.ts       # ~150 行
        ├── idle-watchdog.ts         # ~60 行
        └── __tests__/
            └── resilience.test.ts   # ~200 行
```

## 关键设计约束

1. **Provider 接口不变**——所有增强通过组合（withResilience）而非修改
2. **每个 Phase 独立可交付**——Phase 1 完成后就能用 Anthropic
3. **不做跨 Provider 归一化**——每个 Provider 的模型名、参数保持原生
4. **Resilience 可选**——测试时可直连 Provider
5. **预设注册表零代码扩展**——新服务商只加一条预设
