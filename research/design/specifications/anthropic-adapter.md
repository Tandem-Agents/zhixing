# 规格说明：Anthropic Messages 适配器

> **状态**: 待审阅 | **日期**: 2026-04-08  
> **前置分析**: [OpenClaw Transport 分析](../../source-analysis/openclaw/provider-transport.md) | [Claude Code API 层分析](../../source-analysis/claude-code/api-layer.md)  
> **关联 ADR**: [ADR-002 Provider 层架构](../architecture/decisions/002-provider-architecture.md)

## 目标

为 `@zhixing/providers` 实现 `anthropic-messages` 协议适配器，使知行能接入 Claude 系列模型。这是当前最关键的 Provider 能力缺口。

## 竞品实现总结

### OpenClaw 方案（862 行）

- 使用 `@anthropic-ai/sdk` 的 `client.messages.stream()`
- 支持三种认证模式（API Key / OAuth / Copilot）
- Thinking 双路径（adaptive vs budget）
- Cache 策略通过 payload policy 系统注入
- 工具名映射到 Claude Code 格式（OAuth 模式）
- 过度工程：为 GitHub Copilot、OAuth 伪装等场景写了大量只有 OpenClaw 需要的代码

### Claude Code 方案

- 使用原始 `Stream<RawMessageStreamEvent>` 而非 SDK 高级抽象
- 原因：避免 `BetaMessageStream` 的 `partialParse()` 导致的 O(n²)
- 90 秒空闲看门狗
- 非流式回退
- 极致的 prompt cache 系统（5 sticky latch、边界标记、工具排序）
- 输出 token 预算：默认 8K，按需升级 64K

## 我们的设计

### 设计原则

1. **只做我们需要的**——不照搬 OpenClaw 的 OAuth/Copilot 逻辑
2. **吸收两家精华**——Claude Code 的原始 Stream + OpenClaw 的 thinking 双路径
3. **与现有架构一致**——实现 `LLMProvider` 接口，输出 `StreamEvent` 判别联合
4. **预留但不过早实现**——cache 断点、空闲看门狗等在扩展点预留

### 架构位置

```
packages/providers/
├── src/
│   ├── adapters/
│   │   ├── openai-compatible.ts       # 已实现（282 行）
│   │   └── anthropic-messages.ts      # ← 新增
│   ├── create-provider.ts             # 修改：添加 anthropic-messages 分支
│   └── presets.ts                     # 已含 anthropic 预设
```

### 接口适配

输入（知行 `ChatRequest`）→ 输出（知行 `StreamEvent`）：

```typescript
// ChatRequest → Anthropic API 格式
{
  model, systemPrompt, messages, tools, maxTokens,
  temperature, abortSignal
}
→
{
  model, system: [...], messages: [...],
  max_tokens, tools: [...], stream: true,
  thinking?: { type, budget_tokens? }
}

// Anthropic SSE → StreamEvent
message_start           → StreamMessageStart
content_block_start     → （内部状态更新）
text_delta              → StreamTextDelta
thinking_delta          → StreamThinkingDelta
input_json_delta        → （累积到 partialJson）
signature_delta         → （累积到 signature）
content_block_stop      → StreamToolCallStart + StreamToolCallEnd
message_delta           → （更新 stopReason、usage）
（流结束）               → StreamMessageEnd
```

### 消息格式转换

| 知行格式 | Anthropic API 格式 |
|---------|-------------------|
| `{ role: "user", content: [TextBlock] }` | `{ role: "user", content: "..." }` 或 `{ role: "user", content: [{type:"text",...}] }` |
| `{ role: "assistant", content: [TextBlock, ToolUseBlock] }` | `{ role: "assistant", content: [{type:"text",...}, {type:"tool_use",...}] }` |
| `{ role: "user", content: [ToolResultBlock] }` | `{ role: "user", content: [{type:"tool_result", tool_use_id,...}] }` |
| `ThinkingBlock` | `{ type: "thinking", thinking, signature }` |
| `ImageBlock` | `{ type: "image", source: {type:"base64",...} }` |

**关键差异**（vs OpenAI-compatible 适配器）：
- Anthropic 的 `tool_result` 放在 `user` 消息的 `content` 数组中，不需要独立的 `{ role: "tool" }` 消息
- 这与知行的内部格式天然一致（我们的格式就是按 Anthropic 模型设计的）
- `system` 在 Anthropic API 中是顶层参数，不是消息

### Extended Thinking 支持

> **2026-05-15 更新**：本节描述的 ProviderQuirks 双路径（adaptive/budget）**当前未接入实现**。
> 现状（提交 `76bc0ef` 后）：`anthropic-messages.ts` 仅在**协议事件层**正确发射
> `thinking_block_start / thinking_delta / thinking_block_end`（与 `tool_call_*` 对称），
> 但**请求侧不传 `thinking` 参数**、出站不写 thinking block + signature。
> `presets.anthropic.quirks.supportsThinking` 保持 `false`（诚实声明，不谎报未接入能力）。
> 协议事件层的 `thinking` 块处理仅服务两个场景：① SDK 默认行为或未来接入时自动激活；
> ② 跨 provider 续聊时来自 OpenAI 兼容路径（DeepSeek/Qwen-QwQ 等）的 `ThinkingBlock`
> 在 `convertContentBlock` 降级为 text 兜底。下文 ProviderQuirks 双路径是**未来设计稿**，
> 非当前实现。

通过 `ProviderQuirks` 扩展（**未实现，未来设计**）：

```typescript
// 扩展 ProviderQuirks
interface ProviderQuirks {
  // ...existing fields...
  supportsThinking: boolean;
  /** adaptive thinking（4.6+ 模型）vs budget thinking */
  thinkingMode?: "adaptive" | "budget";
  /** thinking budget 预算（budget 模式下） */
  thinkingBudgetTokens?: number;
}
```

**双路径实现**：

```typescript
// Adaptive（4.6 模型）
{ thinking: { type: "adaptive" } }

// Budget（传统模型）
{
  thinking: { type: "enabled", budget_tokens: 8192 },
  max_tokens: baseMaxTokens + thinkingBudget
}
```

**历史消息中的 Thinking**：
- 保留 `thinking` block 和 `signature` 原样发送
- 不做跨模型 thinking 降级（MVP 阶段只有一个 Anthropic 模型）

### Prompt Cache 支持

**MVP 策略**（简化版，不做 OpenClaw 的完整 payload policy）：

```typescript
// 在 system prompt 数组最后一个 block 上加 cache_control
system: [
  {
    type: "text",
    text: systemPrompt,
    cache_control: { type: "ephemeral" }
  }
]

// 在最后一条 user 消息的最后一个 content block 上加 cache_control
// （使增量对话命中前缀缓存）
```

**后续迭代**：
- 系统提示拆分为稳定前缀 + 动态后缀
- 工具列表排序优化（内置在前、按名称排序）
- 扩展 TTL（`ttl: "1h"` 仅限官方端点）

### 流式 JSON 解析策略

**采用 Claude Code 的方案**：不做中间部分解析

```typescript
// 流式工具调用参数处理
const pendingToolCalls = new Map<number, {
  id: string;
  name: string;
  argsJson: string;  // 累积原始 JSON 字符串
}>();

// content_block_delta: input_json_delta
pending.argsJson += delta.partial_json;
// 不在此处 parse

// content_block_stop 时一次性解析
const args = JSON.parse(pending.argsJson);
```

### Token Usage 映射

> **2026-05-15 更新（提交 `fd1a60f`）**：实现已引入 `totalInputTokens` 规范全量口径。
> Anthropic 的 `input_tokens` 语义上**仅是"未命中的新输入"**，cache 命中/写入单列在
> `cache_read_input_tokens` / `cache_creation_input_tokens`，**不含**在 `input_tokens` 内——
> 直接把它当全量输入会系统性低估。因此 `extractUsage`（导出供 `usage-conformance.test.ts`
> 契约校验）的实际映射为：

```typescript
// Anthropic usage → 知行 TokenUsage（extractUsage 实际实现）
{
  inputTokens:      usage.input_tokens,           // vendor 原值，anchor/estimator 校准锚定，刻意不动
  totalInputTokens: usage.input_tokens
                    + (cache_read_input_tokens ?? 0)
                    + (cache_creation_input_tokens ?? 0),  // 规范全量口径，消费方经 getTotalInputTokens 读取
  outputTokens:     usage.output_tokens,
  cacheReadTokens:  cache_read_input_tokens,   // 仅 >0 才填（与 mergeUsage truthy 语义一致）
  cacheWriteTokens: cache_creation_input_tokens, // 仅 >0 才填
}
```

Anthropic 是**唯一**需要显式设 `totalInputTokens` 的 adapter——OpenAI 兼容族
`prompt_tokens` 本就是全量，由 `getTotalInputTokens` 的 `?? inputTokens` fallback 自然得到
（详见 `core/src/types/llm.ts` 的 `getTotalInputTokens` / `mergeUsage` 注释）。

`message_start` 和 `message_delta` 都可能返回 usage，以 `message_delta`（最终值）为准。

### 错误处理

| Anthropic 错误 | 映射行为 |
|---------------|---------|
| 401 | 包装为 `StreamError`，`recoverable: false` |
| 429 (rate limit) | 包装为 `StreamError`，`recoverable: true` |
| 529 (overloaded) | 包装为 `StreamError`，`recoverable: true` |
| 413 (context overflow) | 包装为 `StreamError`，`recoverable: true` |
| 网络错误 | 包装为 `StreamError`，`recoverable: true` |
| 流式中途断开 | 包装为 `StreamError`，`recoverable: true` |

**不在适配器内做重试**——这是编排层（Resilience Engine）的职责。

### 预留扩展点

| 扩展点 | 当前 | 未来 |
|--------|------|------|
| 空闲看门狗 | 不实现 | Phase 2：90 秒超时 |
| 非流式回退 | 不实现 | Phase 2：流式失败后降级 |
| Bedrock/Vertex | 不实现 | 需要时添加供应商子类 |
| 工具名映射 | 不实现 | 实验验证后决定 |
| 输出 token 策略 | 固定值 | Phase 2：8K 默认 + 按需 64K |
| Cache TTL | ephemeral 默认 | 按订阅状态配置 |

## 实现清单

### Phase 1（MVP，独立可验证）

1. **`adapters/anthropic-messages.ts`**
   - `createAnthropicProvider(resolved: ResolvedProvider): LLMProvider`
   - 消息格式转换（内部 Message → Anthropic 格式）
   - 工具格式转换（ToolSpec → Anthropic tool 格式）
   - 流式事件消费 + StreamEvent 发射
   - Token usage 映射（含 cache 字段）
   - 错误包装

2. **`create-provider.ts` 修改**
   - `case "anthropic-messages"` 分支调用新适配器

3. **`package.json` 依赖**
   - 添加 `@anthropic-ai/sdk`

4. **测试**
   - Mock SDK 的单元测试
   - 消息转换正确性测试
   - 流式事件映射测试
   - 错误处理测试

### Phase 2（增强）

5. Extended thinking 支持（adaptive + budget）
6. Prompt cache 优化（system prompt 拆分、工具排序）
7. 空闲看门狗
8. Token 计数 API（`countTokens` 方法）

## 验证标准

```bash
# Phase 1 验证
zhixing -p "你好，用一句话介绍自己" --provider anthropic
# 预期：流式输出文本回复

zhixing -p "读取当前目录的 package.json" --provider anthropic
# 预期：调用 read 工具，返回文件内容

# Phase 2 验证
zhixing -p "这个项目的架构是什么" --provider anthropic
# 预期：extended thinking 输出 + 多轮工具调用
```

## 代码量估算

| 文件 | 估算行数 |
|------|---------|
| `anthropic-messages.ts` | ~250-300 行 |
| `create-provider.ts` 修改 | ~5 行 |
| 测试文件 | ~300 行 |

总计约 600 行代码。对比：OpenClaw 862 行（含 OAuth/Copilot 我们不需要的逻辑）。
