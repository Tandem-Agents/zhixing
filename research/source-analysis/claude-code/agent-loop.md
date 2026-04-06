# Claude Code — Agent Loop 深度分析

> **分析状态**: ✅ 已分析（2026-04-06）
>
> **分析范围**: 核心循环 `query()` 的结构、状态管理、工具执行、上下文压缩、错误恢复

## 模块定位

Claude Code 的整个智能体逻辑收敛在一个 `query()` 异步生成器中（~1,730 行）。本文基于社区对 2026.3.31 泄露源码的逆向分析，提取架构细节。

## 信息来源

| 来源 | 类型 | 可信度 |
|------|------|--------|
| [Claude Code from Source](https://claude-code-from-source.com) Ch5-Ch8 | 章节化架构拆解 | ★★★★☆ |
| [thtskaran/claude-code-analysis](https://github.com/thtskaran/claude-code-analysis) | 82 份分析文档 + 16 张架构图 | ★★★★☆ |
| [Karan Prasad](https://www.karanprasad.com/blog/how-claude-code-actually-works-reverse-engineering-512k-lines) | 逆向工程深度分析 | ★★★★☆ |
| [Decode Claude — Compaction](https://decodeclaude.com/compaction-deep-dive/) | 压缩机制专题 | ★★★★☆ |

> 以上均基于泄露的 v2.1.88 源码（~512K 行 TypeScript），经社区作者转述。

## 一、核心循环结构

### 1.1 为什么是 AsyncGenerator

```typescript
async function* query(params: LoopParams): AsyncGenerator<Message | Event, TerminalReason>
```

三个核心优势：

| 优势 | 说明 |
|------|------|
| **背压** | 消费者 `.next()` 才推进，UI 渲染忙时生成器自然暂停 |
| **返回值语义** | 返回类型 `Terminal` 是判别联合，精确编码停止原因 |
| **可组合性** | `yield*` 委托子生成器（如 Stop Hooks），无回调/事件转发样板 |

额外：`function*` 延迟执行，重型初始化只在消费者开始拉取时才发生。

### 1.2 循环主体

`while(true)` 从第 307 行到第 1728 行（1,421 行产品代码），包含 9 个 `continue` 点。

早期版本使用递归（query 调用自身），但在数百次工具调用的长对话中调用栈溢出，改为 while(true) + state 对象。

### 1.3 状态对象（不可变转换）

```typescript
type LoopState = {
  messages: Message[]                          // 对话历史
  toolUseContext: ToolUseContext                // 工具、中止控制器、代理状态
  autoCompactTracking: AutoCompactTrackingState // 压缩状态追踪
  maxOutputTokensRecoveryCount: number          // 输出限制恢复次数（最大 3）
  hasAttemptedReactiveCompact: boolean          // 一次性守卫
  turnCount: number                             // 轮次计数
  transition: { reason: string } | undefined    // 继续原因
}
```

**每个 `continue` 点都构造全新 State 对象**（不是修改字段）：

```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  turnCount: nextTurnCount,
  transition: { reason: 'next_turn' },
  // ...
}
state = next
```

## 二、每次迭代的 10 个步骤

```
① 上下文压缩（4 层）
② Token 预算检查
③ 调用模型 API（流式）
④ 流式工具投机执行（StreamingToolExecutor）
⑤ 错误恢复（升级阶梯）
⑥ Stop Hooks
⑦ Token 预算检查 #2
⑧ 工具执行（14 步管线）
⑨ 附件注入（记忆、技能、排队命令）
⑩ 组装消息 → 回到 ①
```

### 步骤 ③ Withholding 模式

可恢复错误（如 413 prompt_too_long）被**扣留**，不 yield 给消费者。只有所有恢复路径都失败后才暴露。原因：SDK 消费者收到 error 消息会断开连接，如果后续恢复成功，消费者已经不在了。

### 步骤 ④ StreamingToolExecutor（投机执行）

LLM 还在流式生成第 2 个工具调用时，第 1 个已经开始执行。典型场景节省 ~40% 时间。

工具经历 4 个状态：`queued → executing → completed → yielded`

**关键规则**：结果按提交顺序 yield（非完成顺序），保持对话一致性。

### 步骤 ⑧ 14 步工具执行管线

| 阶段 | 步骤 |
|------|------|
| 验证 | 工具查找 → 中止检查 → Zod 验证 → 语义验证 |
| 准备 | 投机分类器启动 → 输入回填（路径展开等） |
| 权限 | PreToolUse Hooks → 6 阶段权限解析 → 拒绝处理 |
| 执行 | 实际执行 → 结果预算 → PostToolUse Hooks → 消息追加 → 错误分类 |

## 三、上下文压缩（4 层 + 1 层应急）

从轻到重，轻量优先执行：

| 层级 | 名称 | 机制 | 成本 |
|------|------|------|------|
| Layer 0 | ToolResultBudget | 每条工具结果强制大小上限 | 最轻 |
| Layer 1 | Snip Compact | 物理移除旧消息 | 轻 |
| Layer 2 | Micro Compact | 按 tool_use_id 移除过期结果 | 中 |
| Layer 3 | Context Collapse | 用摘要替换对话片段 | 重 |
| Layer 4 | Auto Compact | Fork 子对话做全文摘要 | 最重 |
| 应急 | Reactive Compact | API 413 后紧急压缩（每种错误仅 1 次） | 最重 |

**Auto-Compact 阈值**：`effectiveWindow = contextWindow - min(maxOutput, 20000)`；触发点在 `effectiveWindow - 13,000`。

**断路器**：Auto-compact 连续 3 次失败后停止。这防止了生产中的噩梦场景——会话在无限 compact-fail-retry 循环中每天烧掉 250,000 次 API 调用。

## 四、终止与继续条件

### 终止原因（10 种）

| 原因 | 触发 |
|------|------|
| `completed` | 正常完成（无工具使用 / 预算耗尽） |
| `max_turns` | 达到 maxTurns 限制 |
| `aborted_streaming` | 用户在流式输出期间中止 |
| `aborted_tools` | 用户在工具执行期间中止 |
| `blocking_limit` | Token 达到硬限制 |
| `prompt_too_long` | 所有恢复策略耗尽 |
| `model_error` | 不可恢复的 API 错误 |
| `image_error` | 不可恢复的媒体错误 |
| `stop_hook_prevented` | Stop hook 阻止继续 |
| `hook_stopped` | PreToolUse hook 停止执行 |

### 继续原因（7 种）

| 原因 | 触发 |
|------|------|
| `next_turn` | 正常工具使用继续 |
| `stop_hook_blocking` | Stop hook 返回阻塞错误 |
| `reactive_compact_retry` | 反应式压缩成功后重试 |
| `collapse_drain_retry` | Context collapse 排空后重试 |
| `max_output_tokens_escalate` | 8K→64K 输出限制升级 |
| `max_output_tokens_recovery` | 64K 仍命中，多轮恢复 |
| `token_budget_continuation` | Token 预算未耗尽 |

## 五、错误恢复升级阶梯

```
Context Collapse Drain → Reactive Compact → Max Output Escalation → Model Fallback
轻量恢复 ────────────────────────────────────────────────→ 重量级恢复
```

**死循环守卫（每个都源于生产事故）**：

| 守卫 | 机制 |
|------|------|
| `hasAttemptedReactiveCompact` | 每种错误仅触发一次反应式压缩 |
| `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` | 输出恢复的硬上限 |
| Auto-compact 断路器 | 连续 3 次失败后完全停止 |
| 错误响应不运行 Stop Hooks | 防止 "error → hook → retry → error" 循环 |

## 六、子代理（Task Tool）

**确实是递归调用 `query()`**。子代理通过 `runAgent()` 生成，调用同一个 `query()` 函数运行独立对话循环。

递归限制：子代理不能创建子子代理（`Agent` 工具在 `disallowedTools` 列表中）。

上下文隔离：同步代理共享父状态的部分字段（如 appState），异步代理完全隔离。

## 七、依赖注入

```typescript
type QueryDeps = {
  callModel: typeof callModel        // 模型调用
  compact: typeof compact            // 压缩器
  microcompact: typeof microcompact  // 微压缩器
  uuid: typeof uuid                  // UUID 生成器
}
```

默认 `productionDeps()`，测试通过此替换假模型调用和确定性 UUID。

## 八、评价

### 优点

- **AsyncGenerator 接口**：背压 + 返回值语义 + 可组合性，优于 push 模式
- **不可变状态转换**：每个 continue 点重建完整状态，可预测、可测试
- **显式终止原因**：10 种 Terminal 枚举，穷尽匹配
- **分层压缩**：轻量优先，避免过度摘要
- **断路器**：每个恢复机制都有硬限制，防死循环
- **依赖注入**：核心循环可测试
- **投机执行**：显著减少工具执行延迟

### 缺点

- **1,730 行单函数**：严重违反单一职责原则
- **9 个 continue 点**：控制流极难追踪
- **扩展需改核心**：添加新功能必须修改 query.ts
- **无 Hook 系统**：不像 Pi-Agent-Core 那样可以通过配置注入行为
- **硬编码 14 步管线**：工具执行步骤写在一个大函数里

## 引用此分析的认知问题

- [q01-核心智能框架](../../_private/questions/q01-core-intelligence-framework.md)
- [q02-Agent Loop 设计决策](../../_private/questions/q02-agent-loop-design.md)
