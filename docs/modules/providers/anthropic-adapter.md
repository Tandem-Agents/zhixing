# Anthropic Messages 适配

本适配器将知行消息和工具请求转换为 Anthropic Messages，并投影为共同 `StreamEvent`。保持协议必要语义，不承接产品角色、会话权威或业务恢复。

## 请求与内容

通过 `@anthropic-ai/sdk` 的 `messages.create({ stream: true })` 消费原始事件流，而不是依赖高级部分 JSON 解析。model 原样传递，system 是顶层字段；`max_tokens` 使用请求值，未给时为 8,192；温度、停止序列和工具按请求传递，abortSignal 交给 SDK。

工具结果保留在 user 内容块，以 `tool_use_id` 关联工具调用，不改写为 OpenAI 的独立 tool 消息。工具定义转换为 input_schema。文本、工具调用、工具结果和 base64 图片按对应内容块转换；当前 URL 图片被转换为文本描述，不能宣称适配器完整支持所有图片来源。

## 流事件与工具参数

- 请求开始发出内部 `message_start`；文本 delta 直接透传。
- 工具块开始发 `tool_call_start`，参数片段发 `tool_call_delta`，块结束发 `tool_call_end`。最终参数解析由下游完成，适配器不在每个 delta 反复解析 JSON，避免对不断增长的参数做重复工作。
- 思考块发 start/delta/end；signature 片段累积后随 end 交给消息组装。
- 正常结束发 `message_end`，携带 stopReason 和 usage；异常发 error 后返回，不再伪造成功结束。未知内容块当前没有对应投影，不能当作已支持。

## 思考与签名

请求侧已经接入 `ThinkingConfig`：当前仅 budget 形态生成 `{ type: enabled, budget_tokens }`，adaptive 尚未接入。仅有 on 而无预算不臆造数值，其他不适用形态不发送。

历史思考块带 signature 时，思考文字与签名原样回传，不能改写签名内容；缺 signature 的跨 Provider 思考块降为 text，保留信息而不伪造 Anthropic 原生块。接收思考事件、配置界面是否可选和请求是否启用是三个独立条件，参见[思考控制](thinking-control.md)。

## 缓存与用量

当前在 system 文本块及最后一条 user 消息的最后内容块放置 ephemeral cache_control，使后续增量对话有机会复用稳定前缀。标记表达缓存意图，不保证命中；自适应断点、扩展 TTL 与非流式回退尚未实现。

`extractUsage` 保留 `input_tokens` 为原始 `inputTokens`，并计算：

`totalInputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

全量输入消费者经 `getTotalInputTokens` 读取；缓存读写正值分别投影，缺失不伪造命中。`message_start` 建立用量，当前 `message_delta` 只更新输出 token，不能写成所有用量字段都由最后事件整体覆盖。

## 错误与保护边界

适配器输出原错误对象；可恢复性分类、重试与流看门狗由外围调用保护处理，不在这里维护一张自行决定恢复策略的 HTTP 错误表。当前没有适配器业务重试或 failover 循环，但 SDK 内部重试默认未在此显式关闭。所有调用点的保护与终态必须沿真实消费者分别判断。

## 实现入口

- [适配器与用量映射](../../../packages/providers/src/adapters/anthropic-messages.ts)
- [思考参数转换](../../../packages/providers/src/adapters/thinking-params.ts)
- [流消费者](../../../packages/core/src/loop/llm-call.ts)、[运行调用保护](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)
