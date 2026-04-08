# Claude Code — API / LLM 调用层深度分析

> **所属系统**: Claude Code | **分析状态**: ✅ 已分析（2026-04-08）

## 模块定位

Claude Code 的 LLM 调用层：从客户端构建到流式响应处理、Token 预算管理、Prompt Cache 优化的完整链路。

## 信息来源

| 来源 | 章节 |
|------|------|
| [claude-code-from-source.com](https://claude-code-from-source.com) | Ch.4 API Layer, Ch.5 Agent Loop, Ch.17 Performance |
| [Karan Prasad 分析](https://www.karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines) | 全文 |
| [MindStudio Token Budget 分析](https://www.mindstudio.ai/blog/ai-agent-token-budget-management-claude-code/) | Token 管理 |

## 架构总览

```
getAnthropicClient()     → 多供应商统一 SDK 客户端
    ↓
queryModel()             → API 调用编排器（~700 行 async generator）
    ↓
withRetry()              → 重试 + 错误恢复（529, OAuth, thinking downgrade）
    ↓
raw Stream processing    → SSE 事件消费（非 SDK 高级抽象）
    ↓
query()                  → Agent Loop 消费流式事件
```

## 1. 客户端工厂

### 多供应商统一接口

`getAnthropicClient()` 是所有模型通信的唯一工厂：

| 供应商 | SDK | 环境变量 |
|--------|-----|---------|
| Direct API | `Anthropic` | `ANTHROPIC_API_KEY` |
| AWS Bedrock | `AnthropicBedrock` | `ANTHROPIC_BEDROCK_BASE_URL` |
| Azure Foundry | `AnthropicFoundry` | Azure 凭据 |
| GCP Vertex | `AnthropicVertex` | GCP 凭据 |

**关键设计**：所有供应商 SDK 通过 `as unknown as Anthropic` 类型擦除。消费者看到统一接口，不按供应商分支。源码注释："we have always been lying about the return type"。

每个供应商 SDK 通过**动态 `import()`** 加载，未使用的供应商不加载依赖树。

### buildFetch 包装器

所有出站 fetch 注入 `x-client-request-id` 头（每请求 UUID）。当请求超时时，无服务端分配的 ID，此客户端 ID 是关联超时与服务端日志的唯一手段。仅发送给第一方 Anthropic 端点。

### API 预连接

`apiPreconnect.ts` 在初始化期间发 `HEAD` 请求预热 TCP+TLS 握手（100-200ms）。交互模式下，用户打字时连接已就绪。

## 2. 流式响应处理

### 为什么不用 SDK 高级抽象

Claude Code 使用原始 `Stream<RawMessageStreamEvent>` 而非 `BetaMessageStream`。原因：

> `BetaMessageStream` 在每个 `input_json_delta` 事件上调用 `partialParse()`。对于大型 JSON 输入的工具调用（数百行文件编辑），在每个 chunk 上从头重解析——O(n²) 行为。

Claude Code 累积原始字符串，仅在 block 完成时**解析一次**。

### 空闲看门狗

TCP 连接可能无通知死亡。SDK 请求超时只覆盖初始 fetch——HTTP 200 到达后超时即满足，流式 body 停止无人捕获。

```
setTimeout 看门狗：
- 每个 chunk 重置计时器
- 90 秒无 chunk → 中止流
- 45 秒标记处发警告
- 触发时记录 client request ID
- 可通过 CLAUDE_STREAM_IDLE_TIMEOUT_MS 配置
```

### 非流式回退

流式中途失败时（网络错误、停滞、截断），回退到同步 `messages.create()`。处理：代理返回 HTTP 200 但 body 非 SSE，或中途截断 SSE 流。流式工具执行活跃时可禁用回退（避免重复执行工具）。

## 3. Extended Thinking 处理

### 三条不可违反的规则

1. 含 thinking block 的消息必须是 `max_thinking_length > 0` 的查询的一部分
2. thinking block **不能是消息中最后一个 block**
3. thinking block 必须在 assistant trajectory 期间**保持完整**

违反任何一条都产生不透明的 API 错误。

### 具体处理

| 场景 | 策略 |
|------|------|
| Model fallback | 剥离 thinking signatures（模型绑定，跨模型重放会 400） |
| Compaction | 保留受保护的尾部 |
| Microcompact | 不触碰 thinking blocks |
| 上下文溢出 | Thinking downgrade：降低 thinking budget |

## 4. Prompt Cache — 最精妙的系统

### 三层缓存体系

| 层级 | 范围 | TTL | 条件 |
|------|------|-----|------|
| Ephemeral | 每会话 | ~5 分钟 | 默认 |
| Extended | 每会话 | 1 小时 | 订阅状态（通过 sticky latch 锁定） |
| Global | 跨会话/跨用户 | — | 系统提示静态部分；有 MCP 工具时禁用 |

### Dynamic Boundary Marker

System prompt 构建为段数组，分界线之前/之后：
- **之前**：所有会话/用户/组织相同 → 最高级别服务端缓存
- **之后**：用户特定内容 → 每会话缓存

命名约定：
- `systemPromptSection(name, compute)` — 安全，被缓存
- `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` — 破坏缓存，需理由

### 2^N 问题

条件段必须在边界之后：每个运行时条件是一个 bit，会使前缀哈希变体乘以 2^N。静态段无条件。编译时 feature flags 可在边界前；运行时检查必须在后。

### 五个 Sticky Latch

| Latch | 防止 |
|-------|------|
| `promptCache1hEligible` | 会话中途配额翻转改变缓存 TTL |
| `afkModeHeaderLatched` | Tab 切换破坏缓存 |
| `fastModeHeaderLatched` | 冷却模式切换双重破坏 |
| `cacheEditingHeaderLatched` | 会话中途配置切换 |
| `thinkingClearLatched` | 确认缓存未命中后翻转 thinking 模式 |

### 工具列表排序

`assembleToolPool()` 组装：内置工具在前（按名称排序），MCP 工具在后（按名称排序）。内置列表末尾放缓存断点。MCP 工具增删不影响内置工具位置，保护缓存前缀。

### Deferred Tools

`shouldDefer: true` 的工具以 `defer_loading: true` 发送——只有名称和描述，无完整 schema。模型需先调 `ToolSearchTool` 加载 schema。减少初始 prompt 大小，改善缓存命中率。

## 5. Token 预算管理

### 输出 Token 上限策略

**最有影响的单一优化**：默认输出槽 **8,000 token**（非典型的 32K-64K）。

生产数据：p99 输出 4,911 token。标准限制过度预留 8-16 倍。达到上限（<1% 请求）时，用 64K 做干净重试。对 200K 窗口，这是 12-28% 的可用上下文改进。

### Token 计数

`tokenCountWithEstimation` 结合：
- 权威 API 报告 token 数（最近响应的 `usage`）
- 对新消息的粗略估算（偏保守）

使 auto-compact 稍早触发而非偏晚。考虑 prompt 缓存积分、thinking tokens、服务端转换。

### 工具结果预算

| 限制 | 值 |
|------|-----|
| 每工具字符 | 50,000 |
| 每工具 token | 100,000 |
| 每消息聚合 | 200,000 字符 |

## 6. API 级错误恢复

### queryModel 重试策略

`withRetry()` 是 async generator，yield `SystemAPIErrorMessage` 使 UI 显示重试状态：

| 错误类型 | 策略 |
|----------|------|
| 529 (overloaded) | 等待退避 + 重试，可选降级 fast mode |
| Model fallback | 主模型失败 → 备选（如 Opus→Sonnet），剥离 thinking signatures |
| Thinking downgrade | 上下文溢出 → 降低 thinking budget |
| OAuth 401 | 刷新 token + 重试一次 |

### 升级阶梯

1. **Withholding**：可恢复错误从 yield 流中抑制（SDK 消费者在 error 消息上断开）
2. **Reactive compact**：413 后按需压缩（one-shot guard）
3. **Max output escalation**：8K→64K，最多 3 次多轮恢复
4. **Model fallback**：`FallbackTriggeredError` 触发模型切换
5. **Circuit breaker**：auto-compact 连续 3 次失败后完全停止

### 死亡螺旋防护

- `hasAttemptedReactiveCompact`：one-shot 标志
- `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`：硬上限
- Auto-compact 熔断器：3 次连续失败后停止
- 错误响应上不运行 stop hooks

## 7. 与 OpenClaw 的对比

| 维度 | Claude Code | OpenClaw |
|------|------------|---------|
| 多供应商 | 4 个 Anthropic 供应商统一为一 | 3 种协议 × 多供应商 |
| SDK 使用 | 原始 Stream（避免 O(n²)） | `client.messages.stream()` |
| 缓存系统 | 极致（5 latch + 边界 + 排序 + deferred） | 基础（ephemeral + boundary） |
| 错误恢复 | 传输层内 `withRetry()` generator | 传输层外的编排循环 |
| 空闲检测 | 90 秒看门狗 | 无 |
| 输出预算 | 8K 默认 + 按需 64K | 固定 32K |
| Token 计数 | 权威 + 保守估算 | 委托 pi-ai |
| 非流式回退 | 有 | 无 |

## 对知行的启示

| 洞察 | 我们的策略 |
|------|----------|
| **原始 Stream 更高效** | 使用 `@anthropic-ai/sdk` 但消费原始 SSE 事件流 |
| **空闲看门狗是必需品** | 实现 90 秒超时的空闲检测 |
| **8K/64K 输出策略** | 默认 8K，遇 max_tokens 时重试 64K |
| **缓存断点** | MVP 先在 system prompt 和最后 user 消息上打 ephemeral |
| **工具排序** | 内置工具在前，排序稳定，保护缓存前缀 |
| **错误恢复在传输层** | `withRetry` 模式比外层循环检查更内聚 |
| **Thinking 规则严格** | 必须正确处理三条不可违反规则 |
| **Token 估算偏保守** | 宁可早压缩，不可晚崩溃 |

## 引用此分析的认知问题

- [q03-Provider 架构](../../_private/questions/q03-provider-architecture.md)
