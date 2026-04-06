# OpenClaw — Agent Loop 深度分析

> **分析状态**: ✅ 已分析（2026-04-06）
>
> **分析范围**: 内层循环（Pi-Agent-Core `agent-loop.ts`）+ 外层编排（`run.ts`）

## 模块定位

OpenClaw 的智能体循环分为两层：内层 Pi-Agent-Core 负责 LLM↔工具的推理循环，外层 `runEmbeddedPiAgent` 负责容错编排。本文分析两层的完整实现。

## 信息来源

| 来源 | 路径 | 可信度 |
|------|------|--------|
| Pi-Agent-Core 开源仓库 | [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts) | ★★★★★（源码直读）|
| OpenClaw 本地源码 | `E:\Dev\longxia\openclaw-main\src\agents\pi-embedded-runner\` | ★★★★★（源码直读）|

## 一、内层循环：Pi-Agent-Core

### 1.1 入口与接口

Pi-Agent-Core（`@mariozechner/pi-agent-core` v0.65.0）提供三个入口：

| 函数 | 用途 |
|------|------|
| `agentLoop(prompts, context, config)` | 新对话：添加 prompt 到上下文并开始循环 |
| `agentLoopContinue(context, config)` | 续接：从已有上下文继续（用于重试） |
| `runAgentLoop()` / `runAgentLoopContinue()` | 上述两者的 async 实现 |

返回类型为 `EventStream<AgentEvent, AgentMessage[]>`——push 模式的事件流。

### 1.2 核心循环结构

`runLoop()` 是实际的循环函数，结构为**双层 while 循环**：

```typescript
async function runLoop(context, newMessages, config, signal, emit, streamFn) {
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  // 外层循环：处理 follow-up 消息
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环：LLM ↔ 工具执行
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // 1. 注入 pending 消息（steering messages）
      if (pendingMessages.length > 0) { /* push to context + emit */ }

      // 2. 流式调用 LLM
      const message = await streamAssistantResponse(context, config, signal, emit, streamFn);

      // 3. 错误/中止 → 直接退出
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // 4. 检查工具调用
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;

      // 5. 执行工具
      if (hasMoreToolCalls) {
        const results = await executeToolCalls(context, message, config, signal, emit);
        for (const result of results) {
          context.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 内层结束 → 检查 follow-up 消息
    const followUp = (await config.getFollowUpMessages?.()) || [];
    if (followUp.length > 0) {
      pendingMessages = followUp;
      continue;
    }

    break;  // 真正结束
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

### 1.3 消息流转

消息在三个阶段转换：

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
```

- `AgentMessage` 是 Pi 的内部格式，比 LLM API 的 Message 更丰富
- `transformContext` 是 hook，可用于裁剪/修改上下文
- `convertToLlm` 将 AgentMessage 转为 LLM API 能理解的 `user`/`assistant`/`toolResult` 消息

### 1.4 流式 LLM 调用

`streamAssistantResponse()` 的关键行为：

1. 通过 `config.transformContext` 和 `config.convertToLlm` 准备 LLM 上下文
2. 调用 `streamFn(model, llmContext, options)` 获得流式响应
3. 流式事件类型：`start` → `text_delta` / `thinking_delta` / `toolcall_delta` → `done` / `error`
4. 在流式过程中实时更新 `context.messages` 中的 partial message
5. 流结束后调用 `response.result()` 获得最终消息

### 1.5 工具执行

支持两种模式，通过 `config.toolExecution` 配置：

| 模式 | 行为 |
|------|------|
| `"parallel"`（默认） | 所有工具调用并行执行，`Promise.all` 收集结果 |
| `"sequential"` | 逐个顺序执行 |

工具执行的三阶段：

1. **准备**（`prepareToolCall`）：查找工具定义 → 参数预处理 → Schema 验证 → `beforeToolCall` hook
2. **执行**（`executePreparedToolCall`）：调用 `tool.execute()` 并收集进度更新
3. **收尾**（`finalizeExecutedToolCall`）：`afterToolCall` hook → 格式化结果

### 1.6 Hook 系统

通过 `AgentLoopConfig` 注入，核心循环不硬编码任何扩展逻辑：

| Hook | 时机 | 用途 |
|------|------|------|
| `transformContext` | 每次 LLM 调用前 | 裁剪/修改消息上下文 |
| `convertToLlm` | transformContext 之后 | AgentMessage → LLM Message 转换 |
| `beforeToolCall` | 工具执行前 | 权限检查、输入修改、阻止执行 |
| `afterToolCall` | 工具执行后 | 修改结果、标记错误 |
| `getSteeringMessages` | 每轮结束后 | 注入外部消息（用户中途输入） |
| `getFollowUpMessages` | 所有工具完成后 | 注入后续任务消息 |

### 1.7 事件序列

完整的一次运行事件流：

```
agent_start
  turn_start
    message_start (user prompt)
    message_end   (user prompt)
    message_start (assistant response)
    message_update × N (streaming)
    message_end   (assistant response)
    tool_execution_start × N
    tool_execution_update × N
    tool_execution_end × N
    message_start (tool result) × N
    message_end   (tool result) × N
  turn_end
  turn_start          ← 如果有更多工具调用
    ...
  turn_end
agent_end
```

### 1.8 状态管理

- **可变**：`context.messages` 数组被直接 push
- 流式过程中 partial message 在数组中原地替换
- `newMessages` 收集本次运行新增的所有消息

### 1.9 停止条件

| 条件 | 行为 |
|------|------|
| `stopReason === "error"` | 立即退出 |
| `stopReason === "aborted"` | 立即退出 |
| 无工具调用 + 无 pending 消息 + 无 follow-up | 正常结束 |
| 有 follow-up 消息 | 继续外层循环 |

---

## 二、外层循环：runEmbeddedPiAgent

### 2.1 职责

外层循环不参与推理，只负责**容错编排**。它包裹内层 `session.prompt()` 调用，处理各种运行时故障。

位置：`src/agents/pi-embedded-runner/run.ts`（~1400 行）

### 2.2 核心结构

```typescript
while (true) {
  if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
    return handleRetryLimitExhaustion({ ... });
  }
  runLoopIterations += 1;

  const attempt = await runEmbeddedAttempt({ ... });
  // 根据 attempt 结果决定：成功返回 / 重试 / Failover
}
```

### 2.3 处理的故障类型

| 故障 | 恢复策略 |
|------|---------|
| API 认证失效 | 轮换 auth profile (`advanceAuthProfile`) |
| 速率限制 (429) | 退避等待 + 轮换 profile（有上限） |
| 模型不可用 | `throw FailoverError` → 切换备选模型 |
| 上下文溢出 | `contextEngine.compact` + 截断过大工具结果 |
| LLM 超时 | 如果 prompt token 占比 > 65%，触发压缩后重试 |
| 过载 (overloaded) | `sleepWithAbort` 退避 |
| Thinking 降级 | `pickFallbackThinkingLevel` 降低 thinking level |

### 2.4 Compaction 触发点

1. **Attempt 内部**：由 pi-agent-core 的 auto-compaction 机制触发
2. **外层超时路径**：prompt token 占比 > 0.65 且 LLM 超时 → 强制压缩（最多 2 次）
3. **外层溢出路径**：检测到 overflow 错误 → 压缩或截断工具结果

### 2.5 stopReason 映射

Anthropic API 的 stop_reason 在传输层被映射：

| Anthropic | Pi 内部 | 含义 |
|-----------|---------|------|
| `end_turn` | `stop` | 正常结束 |
| `tool_use` | `toolUse` | 需要执行工具 |
| `max_tokens` | `length` | 达到输出上限 |
| `stop_sequence` | `stop` | 命中停止序列 |

### 2.6 工具名映射（Claude Code 兼容）

使用 OAuth token (`sk-ant-oat`) 时，工具名被映射为 Claude Code 格式：

```typescript
const CLAUDE_CODE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "AskUserQuestion", "Task", "TodoWrite", "WebFetch", "WebSearch", ...
];

// 出站：read → Read（toClaudeCodeName）
// 入站：Read → read（fromClaudeCodeName）
```

可能是为了获得 Anthropic 对 Claude Code 工具的内部优化支持。

---

## 三、评价

### 优点

- **内层循环精简**：~350 行，职责清晰
- **Hook 驱动**：核心循环不硬编码扩展逻辑，通过 config 注入
- **并行工具执行**：内置支持
- **事件序列规范**：清晰的 start/update/end 生命周期
- **关注点分离**：推理循环和容错编排彻底分开

### 缺点

- **可变状态**：`context.messages.push()` 直接修改，不利于测试和调试
- **Push 模式事件流**：`EventStream` 不支持背压
- **外层循环过于复杂**：~1400 行的单函数，容错逻辑高度耦合
- **闭源依赖**：Pi-Agent-Core 是 npm 包，OpenClaw 无法修改其内部行为
- **无投机执行**：必须等 LLM 完整输出后才开始执行工具
- **停止条件隐式**：通过 `hasMoreToolCalls` 布尔值控制，无类型化的终止原因枚举

## 引用此分析的认知问题

- [q01-核心智能框架](../../_private/questions/q01-core-intelligence-framework.md)
- [q02-Agent Loop 设计决策](../../_private/questions/q02-agent-loop-design.md)
