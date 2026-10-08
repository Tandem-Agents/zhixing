# 确认接入与交互

共同合同见[确认交互架构](architecture.md)。各表面复用决定语义，但能力与应答身份不同；不能把“能收到通知”解释为“有权批准”。

## 接入对照

| 接入 | 展示与回程 | 授权边界 |
|---|---|---|
| 本机 CLI | RPC 请求投影 → N 权限选择映射 → U 共同页面；决定经 RPC 回传 | 已认证本机发起面可提交完整受支持决定，不再直连业务 Broker |
| 其他 RPC 客户端 | `confirmation.list`、pending／resolved 通知；`confirmation.resolve` 应答 | 可观察与可应答分离；非本机受限决定仅 allow-once／deny |
| 渠道文本 | 发送操作摘要与回复提示，精确词集或拒绝理由回程 | 校验原始应答人及耐久 challenge／grant 绑定，不以群成员可见或文本匹配代替授权 |

## CLI 选项与显示

当前[请求构造器](../../../packages/core/src/confirmation/request-builder.ts)按作用范围生成选项，不让用户维护内部会话概念：

| 选项 | 含义 |
|---|---|
| 允许这一次 | `allow-once`，默认首项 |
| 始终允许，仅本上下文 | `allow-context`；main 显示“仅主模式生效”，workspace／scene 显示“本工作场景生效” |
| 始终允许，全局 | `allow-global`，跨上下文 |
| 拒绝并说明原因 | `deny-with-reason`，映射为 `deny.reason` |

持久选项只在有建议模式且未命中 `bypassImmune`、未要求逐次显式确认时生成；否则只保留本次允许与拒绝。模式优先选子命令通配，再选可执行命令通配，最后候选兜底；这是授权粒度，不保证通配模式本身排除了所有危险参数，安全底线仍须独立评估。`allow-session` 类型保留但常规面板不生成，因为其内存作用域不是用户感知的对话生命周期。

[权限适配](../../../packages/cli/src/terminal/confirmation.ts)从真实请求构造通用选择页，[U 根](../../../packages/terminal-ui/src/root.tsx)处理输入，N 关联请求与回执。选项只来自权威能力，持久授权增加后果说明与独立确认；拒绝项可补充理由。无法完整展示时禁用允许，不默认继续。

Esc／返回与 Ctrl+C 等用户取消须按真实动作保留语义：通用页面消失不是同意；拒绝与 cancelled 不得互换。当前适配将退出确认映射为 deny，将显式 cancelled 映射为 user-ctrl-c；Ctrl+D 与其他取消原因须有独立输入与回程证据，不能沿用退休 renderer 的结论。补充输入和二次确认的返回行为见[选择模块](../cli/selection.md)。

确认与主对话使用同一终端根，不再装配旧 TerminalConfirmationRenderer、SelectOperationRegion 或 ScreenController，不进行 beforeShow／afterShow 的 stdin 交接。共同输入与页面生命周期见[屏幕渲染](../cli/screen-rendering.md)。权限队列和授权事实仍由原 owner／RPC 责任链维护。

CLI 通过 [RpcConfirmationBroker](../../../packages/cli/src/runtime/rpc-confirmation-broker.ts)接收完整请求并去重；`refresh` 可补查漏通知。同步 `resolve=true` 仅表示本地发起，只有 RPC 返回 `ok:true` 才完成本次回程。`ok:false`、无效回执或异步失败均上报并尝试刷新真实 pending，不自动重发失败决定；连接关闭仍以同一原始决定重放。面板消失本身不是授权成功保证。该适配器也不自建全局审批队列，不能宣称已有“#N of M”视图或批量审批。

## RPC 可见性、应答与重放

[ConfirmationBridge](../../../packages/rpc/src/confirmation-bridge.ts)统一投影 pending／resolved；[方法层](../../../packages/server/src/rpc/methods/confirmation.ts)处理 list／resolve。会话列表按 observer 过滤，无会话请求的列表查询按发起身份匹配；通知另有边界：有会话时按 observer 推送，无会话时向宿主所有已认证、未关闭连接发送 pending 摘要和 resolved 通知。完整可执行请求仅附给已认证、loopback 且匹配发起身份的连接；不能把列表过滤等同于摘要通知隔离。

活跃请求只允许匹配原始 RPC 发起身份的连接应答：请求来源须为 rpc，且 `turnOrigin.triggeredBy` 等于当前连接 ID 或其 `surfacePrincipal`。仅有 observer 身份不可代答；若来源绑定的是稳定 `surfacePrincipal`，连接变化本身不撤销匹配资格。已认证且 loopback 的本机面支持 allow-once、deny、allow-session、allow-context、allow-global，以及仅限 user-ctrl-c／user-ctrl-d 原因的 cancelled；其他 RPC 面仅支持 allow-once／deny。本机用户取消保留取消原因，不转换成拒绝或允许；内部取消原因、expired 与 edit-then-allow 均不能通过该入口提交。持久决定还校验 pattern 结构。不能用“经 RPC 就禁止持久授权”概括当前信任模型。

耐久对话请求已出内存索引时，可携 conversationId、requestId 和同一完整决定重放：answered 记录摘要一致返回成功，不再次执行；不一致返回 decision-conflict；其他终态或无记录返回 already-resolved-or-not-found。此只读结果重放不要求原 connectionId，不等于新连接取得未解决请求的应答权。

## 渠道确认

文本协议只要求收发能力，不依赖特定平台按钮；这减少接入耦合，但不意味着接入一个 send 方法就自动具备完整身份与恢复能力。控制回复优先于确认匹配，确认先于普通输入；确认回复不进入正常模型任务队列，避免工具等人、人回复却排在工具之后。

[匹配器](../../../packages/server/src/confirmation/match.ts)执行 trim、去末尾标点、NFKC 和小写标准化后完全匹配：

| 输入 | 语义 |
|---|---|
| 好、可以、yes、1；好。／yes. | allow-once |
| 不行、拒绝、no、2 | deny，不带理由 |
| 不要删数据库，那是生产环境 | deny，保留原文理由 |
| stop、cancel、停、取消 | 整体取消意图，不属于 deny 词集，见[取消控制](../interruption/control-and-feedback.md) |
| 空白 | 调用方过滤，不作为确认决定 |

自由文本不模糊推断为同意；理由保留内部标点，超过 2000 字符截断并标注。完整词集以匹配器为准，不在正文复制第二份；确认与取消词集须互斥。

耐久对话渠道通过[ConversationChannelHost](../../../packages/cli/src/serve/conversation-channel-confirmation.ts)校验 run-interact ticket 与 assignment／执行引用／surfacePrincipal，接收并采纳 interaction 展示后推进确认链；回调凭 challenge 与 responder 验权，再交 resolver 提交。Job 的手动触发按已记录发起面，timer 按冻结的渠道 responder，结果由 JobJournal 负责，不能回退成任意 observer 或匿名 ephemeral 批准。

确认请求及回执不能等待内容 Outbox 的当前 Run Slot。已有 [TextConfirmationRenderer](../../../packages/server/src/confirmation/text-renderer.ts)经有限渠道端口发送，不维护渠道消息的 resolved 编辑；发送失败记日志而不在该类重试，无目标则跳过。不能把这一本地组件的“一次发送”推导成端到端恰好送达；耐久渠道的 challenge、回执和崩溃重驱属于对应执行权威链。

兼容 InboundRouter 的 pending 分支按发起者检查后匹配应答；无 pending 时不会统一生成“已超时”回执。因此不能承诺所有迟到文本都被识别为旧确认。群 target 上发送的内容可被其他群成员看见，应答鉴权不等于展示隐私隔离，也不能宣称自动转私聊。

## 反馈边界

允许／拒绝回执必须与提交结果一致；拒绝理由进入工具错误，而非自动改写工具参数。通知丢失、断线、过期、取消和应答竞争都不能导致另一次授权。
