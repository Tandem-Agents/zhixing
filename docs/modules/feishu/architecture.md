# 飞书通道架构与能力边界

本文说明 `@zhixing/channel-feishu` 的职责、有效体验目标及当前生产实现，不是新平台排期或 SDK 使用大全。平台选择见[IM 通道接入选型研究](../../research/channel-platforms.md)，确认合同见[确认接入与交互](../confirmation/surfaces.md)，可靠内容投递见[消息 Outbox](../delivery/outbox.md)。

## 目标与责任

飞书应是个人助手的交互入口，而非另建一套智能体：共享会话与执行能力，复用授权裁决和投递责任；适配器只处理平台连接、消息转换与卡片收发。长耗时执行不放在平台事件回调中，平台重推不能被理解为新的用户意图。

当前接入对象是企业自建应用机器人：以 `appId/appSecret` 建立 SDK 长连接接收消息，并调用应用消息 API 发送回复。选择它是为了双向交互及应用级能力；自定义群 Webhook 机器人用于向所在群推送，不能替代这条入站与回复链，配置群 Webhook 地址并不能接入本适配器。这里的群 Webhook 机器人也不同于下文应用机器人的 HTTP 确认回调。

体验目标是：及时反馈已接收与排队状态，展示必要的执行进展，逐步呈现回复，给出可理解的失败结果，并在同一入口完成安全确认。下表列出这些目标与当前实现的差异。

| 原目标或取舍 | 当前事实与边界 |
|---|---|
| 原设计要求流式卡片为默认且唯一的回复模式，每条回复从创建到完成全程流式，失败时更新为错误状态 | `capabilities.streaming=false`、`edit=false`；普通回复一次发送最终卡片，没有流式创建／更新／结束链。此项要求尚未实现 |
| 排队、思考、工具、生成及终态可见 | 卡片构建器有这些状态样式，但普通发送未传状态，默认 `done`；存在样式不代表已接入实时过程反馈 |
| 复用确认，不在平台另建审批权威 | 已采用签名 challenge 通路，不是旧稿的本地 Promise／ApprovalHandle 方案；卡片提供“允许一次／拒绝”，没有已处理状态编辑 |
| 任务结果与提醒可主动投递 | 适配器提供按目标发送；何时发送、目标选择、顺序与重试由宿主及投递责任处理，不是适配器自行调度 |
| 表情回执与流式反馈互补 | 当前未实现 reaction 回执；不得将旧 ReactableChannel 设想写成已提供能力 |
| 群聊访问控制与仅响应提及 | 当前支持文本私聊／群聊并去除已知机器人提及占位；规范化本身不执行群白名单或“必须 @”策略，旧配置字段不是现行能力 |

## 生产链路

[宿主渠道装配](../../../packages/cli/src/serve/channels.ts)创建并注册 `FeishuAdapter`，分别提供入站、投递与 challenge 端口；渠道凭据来自设备本地秘密存储，公开配置仅控制启用与选项。

入站：SDK `WSClient` → `im.message.receive_v1` → 内存去重 → 消息规范化 → `ChannelContext.onMessage` → 宿主渠道消费链与 [InboundRouter](../../../packages/server/src/channels/inbound-router.ts) → Conversation 产品端口接受执行。路由器通过 Delivery Outbox 管理回复位置和内容，不再直接调用旧 `runtime.run()` 循环。

出站：宿主投递端口 → `adapter.send` → Markdown 降级 → 回复卡片 → `client.im.message.create`。目标以 `oc_` 前缀区分 `chat_id`，其他按 `open_id`；不能据此推断任意平台标识都可发送。

`connect` 初始化客户端、去重缓存及事件订阅，`disconnect` 关闭连接、清缓存并移除 challenge 能力；取消信号也会关闭长连接。基础消息使用 WebSocket，而互动确认使用单独 HTTP 路由，不能把“消息接收免公网回调”扩展为整个确认链都不需要可达回调地址。

## 消息与失败处理

- [事件规范化](../../../packages/channels/feishu/src/events.ts)只接收有 `open_id` 的非机器人文本消息；非法 JSON、空文本、媒体消息不进入处理。私聊映射为 `dm`，群聊保留群 ID，根消息 ID 作为 threadId；保留 threadId 不等于已实现平台话题回复能力。
- [去重缓存](../../../packages/channels/feishu/src/dedup.ts)默认 24 小时、2048 条，按插入顺序淘汰而非访问刷新式 LRU；断开后清空，不持久化。它在向宿主转交前记入消息 ID，因此不等于耐久接受，也不能单独保证失败重投不丢失或跨重启恰好执行一次。
- [格式转换](../../../packages/channels/feishu/src/format.ts)保留闭合代码块中的表格文本，将匹配到的 Markdown 表格转换成逐行列表。普通回复默认超过 8000 个 UTF-16 代码单元时截断并加省略号，避免切开代理对；当前不分多张卡片，不保证截断后的 Markdown 结构完整。旧“分卡完整展示”方案尚未实现。
- [客户端](../../../packages/channels/feishu/src/client.ts)发送失败返回可重试分类，不自建重试循环。未连接返回可重试失败，特定平台错误码标记可重试，未知异常也按可重试返回；这不证明网络异常前平台未产生副作用，端到端重复投递边界由投递合同负责。
- 普通消息回调快速转交，不等待 Agent 完成；其捕获异常目前仅记日志。官方 SDK 文档说明事件超时会重推，不能以快速返回或日志存在代替业务耐久接受证明。

## 互动确认

[适配器](../../../packages/channels/feishu/src/adapter.ts)仅在 `verificationToken` 与 `encryptKey` 成对存在时挂载 `sendChallenge`，注册 `/channels/feishu/challenge`。两者都缺少时只关闭互动确认，基础消息保留；只提供一项则报配置错误。

卡片携带 challenge token 与决定，回调经过 SDK handler 及 `validateChannelChallengeCallback` 后，将平台应答人 `open_id`、tenant 与决定交给宿主。必须等待 `onChallengeAction` 完成才成功响应；异常上抛供重投，真正的授权、耐久裁决及幂等由宿主权威链负责，不能信任按钮可见性或适配器局部缓存。

卡片禁止转发并提供“允许一次／拒绝”。这些展示设置不替代身份校验。当前没有旧稿设想的四按钮模式或确认后卡片编辑；其余统一确认语义不在此重复定义。

## 配置与实现导航

[配置解析](../../../packages/channels/feishu/src/config.ts)要求 `appId`、`appSecret`；可选 `domain` 为 `feishu` 或 `lark`，另有 `botOpenId`、`dedupTtlMs`、`dedupMaxSize`。旧稿的 `connectionMode`、`webhookPath`、`dmPolicy`、`allowedUsers`、`groupPolicy`、`ackReaction` 等不是该解析器支持的选项；适配器也未把 `maxMessageLength` 暴露为配置选项。

平台 API 封装、事件规范化、卡片构建、格式转换、缓存和配置各自分离，具体实现位于[飞书源码目录](../../../packages/channels/feishu/src)。平台对消息大小、速率及权限的限制另按当前官方资料核实，本文的 8000 截断是本地策略，不是平台上限。
