# Claude Code — 关键设计模式

> **所属系统**: Claude Code | **分析状态**: ✅ 已分析（2026-04-07）

## 模块定位

从 Claude Code 泄露源码的社区分析中提取的关键设计模式和理念。

## 设计模式清单

| 模式 | 应用场景 | 评价 |
|------|---------|------|
| 单循环 + AsyncGenerator | Agent Loop | ✅ 背压、类型安全返回值、yield* 组合 |
| 不可变状态转换 | 循环状态管理 | ✅ 便于测试和推理 |
| 自描述工具 | 工具系统 | ✅ 并发安全、权限等在工具侧声明 |
| Fail-closed 默认值 | 安全模型 | ✅ 新工具默认串行、非只读、需权限 |
| 投机工具执行 | 性能优化 | ✅ 流式阶段提前跑安全工具 |
| 分层上下文压缩 | 上下文管理 | ✅ 轻量级优先 + 熔断保护 |
| 递归 Agent | 子任务 | ✅ Task = 再开一条 query() |
| 缓存优先 prompt 工程 | 成本优化 | ✅ 工具列表排序保护缓存前缀 |
| 14 步工具管线 | 工具执行 | ⚠️ 概念好但实现为单一大函数 |
| 结果预算控制 | 上下文管理 | ✅ 单工具 maxResultSizeChars + 超大结果落盘 |
| settings.json 层级 | 配置 | ✅ 企业→项目→用户的优先级链 |
| 单 Provider 绑定 | LLM 接入 | ❌ 只支持 Anthropic，不够开放 |

## 详细分析

### 1. AsyncGenerator 作为核心接口

**意图**：解决流式推理场景中的背压（backpressure）和终止语义问题。

**与其他方式对比**：
- EventEmitter（push）：无背压，消费者可能被淹没
- Promise（pull 但单值）：无法表达流式
- AsyncGenerator（pull + 多值 + 终止值）：消费者 `next()` 才推进，`return` 携带终止原因

**对知行的启示**：已采用。我们的 `runAgentLoop()` 返回 `AsyncGenerator<AgentYield, AgentResult>`。

### 2. 不可变状态转换

**意图**：每次循环迭代重建整个 State 对象，不在原对象上 mutate。

**好处**：
- 便于测试：断言"为何进入下一轮"只需比较两个 state
- 无副作用：前一轮的 state 不被后续修改影响
- 时间旅行调试：可以保存每轮 state 快照

**对知行的启示**：已采用。我们的 `LoopState` 每轮重建。

### 3. 自描述工具（Fail-closed 默认）

**意图**：工具自己声明安全特性，而不是由中央编排器判断。

```typescript
// 工具声明（概念性）
{
  isParallelSafe: false,    // 默认不可并行
  isReadOnly: false,        // 默认有副作用
  isConcurrencySafe: (input) => isReadOnlyCommand(input.command),
  maxResultSizeChars: 50000,
  needsPermission: true,    // 默认需要权限
}
```

**关键原则**：新工具如果未声明这些属性，系统采用**最保守的默认值**（串行、非只读、需权限）。这比"默认允许"安全得多。

**对知行的启示**：已在 `ToolDefinition` 中采用 `isReadOnly`、`isParallelSafe` 等字段。

### 4. 投机工具执行

**意图**：在模型仍在流式输出后续 tool_use 时，对已确认并发安全的工具提前启动执行。

**实现**：`StreamingToolExecutor` 在流式阶段检查工具的 `isConcurrencySafe(input)`，安全的立即执行，不安全的排队。

**权衡**：偶尔执行结果作废（模型后续取消了该工具调用），但整体延迟显著降低。

**对知行的启示**：预留了扩展点（`tool-executor.ts` 可替换实现），但 MVP 不实现。

### 5. 分层上下文压缩

**意图**：用最小代价保持上下文在窗口内，避免不必要的信息丢失。

**关键原则**：轻量级策略优先尝试，重度压缩作为最后手段，且有熔断保护（连续 3 次失败则放弃压缩）。

**对知行的启示**：预留了接入点，Phase 2 实现。借鉴其分层+熔断思路。

### 6. 缓存优先的 Prompt 工程

**意图**：利用 Anthropic 的 prompt cache 降低成本。

**实现**：
- 工具列表按 内置→MCP 排序
- 内置工具列表末尾放置 cache 断点
- MCP 工具变化不打碎缓存前缀
- 静态系统提示和动态部分分段

**对知行的启示**：未来优化方向。当前 MVP 不需要。

### 7. 单 Provider 绑定（反面参考）

**意图**：Claude Code 只面向 Anthropic 用户，不需要支持其他 Provider。

**问题**：
- 不支持 OpenAI 兼容端点（社区需求强烈）
- 非 Anthropic 模型需要外部网关翻译
- 社区通过 fork 和反向代理绕过

**对知行的启示**：这是 Claude Code 最大的局限。我们的 Provider 层必须支持多协议、多服务商。

## 引用此分析的认知问题

- [q01-核心智能框架](../../_private/questions/q01-core-intelligence-framework.md)
- [q02-Agent Loop 设计](../../_private/questions/q02-agent-loop-design.md)
- [q03-Provider 架构](../../_private/questions/q03-provider-architecture.md)
