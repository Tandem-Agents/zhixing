# OpenClaw — Provider / Transport 层深度分析

> **分析状态**: ✅ 已分析（2026-04-08）

## 模块定位

OpenClaw 的 LLM 接入层：从协议选择到流式响应处理的完整链路。
重点分析 Anthropic Messages 传输（`anthropic-transport-stream.ts`，862 行）。

## 架构总览

```
Provider 配置 → Api 枚举 → Transport 工厂 → SDK Client → 流式事件
```

### 传输选择链路

```
resolveEmbeddedAgentStreamFn()
  ├── providerStreamFn?         → 插件/Provider 注入的自定义传输
  ├── shouldUseWebSocketTransport? → OpenAI WebSocket 传输
  ├── model.provider === "anthropic-vertex"? → Vertex 专用传输
  ├── createBoundaryAwareStreamFnForModel()
  │     └── 按 model.api 分发:
  │         ├── "anthropic-messages" → createAnthropicMessagesTransportStreamFn()
  │         ├── "openai-responses"   → createOpenAIResponsesTransportStreamFn()
  │         ├── "openai-completions" → createOpenAICompletionsTransportStreamFn()
  │         └── "google-generative-ai" → createGoogleGenerativeAiTransportStreamFn()
  └── streamSimple (pi-ai 内置 fallback)
```

关键设计：`Api` 枚举（如 `anthropic-messages`、`openai-responses`）决定用哪个 Transport，而不是 Provider ID。

## Anthropic Messages 传输 — 核心实现

### 1. Client 构建（三种认证模式）

| 模式 | 识别方式 | 特殊行为 |
|------|---------|---------|
| **普通 API Key** | 非 `sk-ant-oat` 开头 | 标准 `apiKey` 认证 |
| **OAuth Token** | `sk-ant-oat` 开头 | `authToken` 认证 + Claude Code 身份伪装 |
| **GitHub Copilot** | `model.provider === "github-copilot"` | Copilot 动态头 + IDE 版本注入 |

OAuth 模式下的特殊请求头：

```
anthropic-beta: claude-code-20250219,oauth-2025-04-20,...
user-agent: claude-cli/2.1.75
x-app: cli
```

还注入了伪 system prompt：`"You are Claude Code, Anthropic's official CLI for Claude."`

### 2. Extended Thinking 处理

**两条路径**（基于模型是否支持 Adaptive Thinking）：

| 模型类型 | thinking 参数 | 额外参数 |
|---------|--------------|---------|
| Adaptive（4.6 系列） | `{ type: "adaptive" }` | `output_config: { effort }` |
| 传统（4.0/3.5） | `{ type: "enabled", budget_tokens }` | `max_tokens` 需含 thinking 预算 |

**Thinking Budget 计算**（传统模型）：

```
budget = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }
maxTokens = min(baseMaxTokens + thinkingBudget, modelMaxTokens)
if (maxTokens <= thinkingBudget) thinkingBudget = max(0, maxTokens - 1024)
```

**Interleaved Thinking**：非 Adaptive 模型启用 `interleaved-thinking-2025-05-14` beta。

**历史消息中的 Thinking 处理**（`transport-message-transform.ts`）：
- 跨模型时：thinking 无签名 → 降级为纯文本块
- 同模型时：保留完整 thinking + signature
- `redacted_thinking`：仅同模型时保留，跨模型时丢弃

### 3. Prompt Cache 系统

**核心文件**：`anthropic-payload-policy.ts`（242 行）

**缓存策略解析**：
```
resolveAnthropicPayloadPolicy({
  provider, api, baseUrl,
  cacheRetention,         // "short" | "long" | "none"
  enableCacheControl: true
})
→ AnthropicPayloadPolicy {
    cacheControl: { type: "ephemeral", ttl?: "1h" },
    allowsServiceTier, serviceTier
  }
```

**缓存断点放置**（两个位置）：

1. **System Prompt**：
   - 通过 `OPENCLAW_CACHE_BOUNDARY` 标记将 system prompt 拆为稳定前缀 + 动态后缀
   - 稳定前缀加 `cache_control: { type: "ephemeral" }`
   - 动态后缀不加缓存标记
   - `ttl: "1h"` 仅在 `cacheRetention === "long"` 且 baseUrl 含 `api.anthropic.com` 时

2. **最后一条 User 消息**：
   - `applyAnthropicCacheControlToMessages` 在最后一条 user 消息的最后一个 content block 上打 `cache_control`

**Usage 追踪**：
- `message_start` 事件读取 `cache_read_input_tokens` 和 `cache_creation_input_tokens`
- `message_delta` 事件更新（Anthropic 会在结束时给出最终值）
- 通过 `calculateCost(model, usage)` 基于缓存命中计算实际费用

### 4. 工具名映射

**仅在 OAuth 模式下**激活：

```typescript
const CLAUDE_CODE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "AskUserQuestion", "Task", "TodoWrite", "WebFetch", "WebSearch", ...
];

// 出站：小写→PascalCase
toClaudeCodeName("read") → "Read"

// 入站：PascalCase→匹配 context.tools 中的真实名
fromClaudeCodeName("Read", tools) → "read"
```

推测意图：Anthropic 对 Claude Code 工具名有内部微调优化。

### 5. 流式事件处理

事件映射（Anthropic SSE → 内部事件流）：

| Anthropic 事件 | 行为 |
|---------------|------|
| `message_start` | 初始化 usage（input/output/cacheRead/cacheWrite） |
| `content_block_start` | 按 `type`（text/thinking/redacted_thinking/tool_use）创建块 |
| `content_block_delta` | text_delta/thinking_delta/input_json_delta/signature_delta 增量追加 |
| `content_block_stop` | 最终化块：text→text_end, thinking→thinking_end, toolCall→解析 partialJson→toolcall_end |
| `message_delta` | 更新 stopReason 和 usage 最终值 |

**工具参数解析**：流式 JSON 拼接（`partialJson += delta`），完成时一次性 `parseStreamingJson`。不做中间部分解析（避免 O(n²) 性能问题）。

### 6. 辅助层

| 文件 | 职责 |
|------|------|
| `transport-stream-shared.ts` | 通用工具：sanitize 文本（移除孤立代理对）、合并 headers、创建事件流 |
| `transport-message-transform.ts` | 跨模型消息规范化：thinking 降级、toolCallId 规范化、孤立 tool_use 补充错误 tool_result |
| `provider-transport-fetch.ts` | 注入受保护的 fetch（TLS/代理支持） |
| `anthropic-payload-policy.ts` | 缓存策略解析与应用 |
| `system-prompt-cache-boundary.ts` | 缓存边界标记的拆分与剥离 |

## 与 Claude Code API 层的对比

| 维度 | OpenClaw | Claude Code |
|------|---------|------------|
| SDK 使用 | `client.messages.stream()` | 原始 `Stream<RawMessageStreamEvent>` |
| JSON 解析 | `parseStreamingJson` 部分解析 | 累积原始字符串、完成时一次解析 |
| Thinking | 两路径（adaptive vs budget） | 类似但有 thinking downgrade 降级策略 |
| Cache | payload policy + boundary marker | 5 个 sticky latch + 2^N 防护 + 工具排序 |
| 错误恢复 | 外层循环负责（非传输层） | `withRetry()` generator 在传输层内 |
| 空闲检测 | 无 | 90 秒空闲看门狗 |
| 非流式回退 | 无 | 有（流式失败时降级为同步调用） |

## 对知行的启示

| 维度 | 结论 |
|------|------|
| **SDK 选择** | 使用 `@anthropic-ai/sdk`，但用原始 `Stream` 而非高级包装（Claude Code 的理由成立） |
| **Thinking 处理** | 必须支持 adaptive 和 budget 两种路径 |
| **Cache 策略** | MVP 可简化——在 system prompt 和最后一条 user 消息上打 ephemeral 即可 |
| **流式 JSON** | 累积字符串 + 完成时一次解析，避免部分解析的 O(n²) 问题 |
| **空闲看门狗** | 值得实现——TCP 死连接是实际问题 |
| **消息规范化** | 必须处理孤立 tool_use/tool_result 和 thinking 降级 |
| **工具名映射** | 保留能力但默认不启用（需实验验证效果） |

## 引用此分析的认知问题

- [q03-Provider 架构](../../_private/questions/q03-provider-architecture.md)
