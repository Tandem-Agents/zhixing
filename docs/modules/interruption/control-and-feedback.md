# 取消控制与反馈

本文定义接入面的取消语义、当前产品调用链与反馈归属；执行信号、部分结果和工具清理由[中断执行架构](architecture.md)定义。取消当前工作不销毁对话；下一条正常输入仍可开始新运行。它也不撤销已完成效果，不提供暂停／原地续跑。

## 控制与授权不是同一件事

入站在 owner／通道有效且接入开放后，按 `control → confirmation → agent-input` 处理，命中控制立即返回，不能再当工具拒绝或普通消息入队。

| 意图 | 作用范围 | 后续 |
|---|---|---|
| CANCEL：“停”“取消”“stop” | 请求取消工作；渠道批量覆盖决定时的活动与排队候选 | 等待权威终态，不替用户清空对话 |
| DENY：“不”“拒绝”“no” | 拒绝当前确认事项，典型为一次工具调用 | Agent 可改用其他方案继续；不是整个 Run 的取消 |
| APPROVE：“好”“同意”“yes” | 回答当前确认事项 | 仍受确认身份与有效性校验，不能绕过授权 |
| 无待确认的普通否定／其他文本 | 普通对话输入 | 不凭否定词取消工作 |

控制采用确定性的保守精确匹配，不把识别权交给模型，也不做 substring 匹配。误触会中断用户期望的执行且不自动撤销效果；漏掉长尾表达可通过明确控制词重试，因此不追求扩大词集覆盖率。

当前默认取消词：`/cancel`、`/stop`、`/abort`、`stop`、`cancel`、`停`、`停止`、`停下`、`停一下`、`中止`、`中断`、`终止`、`取消`、`打住`。分类器去首尾空白和末尾标点，再 NFKC 归一化、转小写，整条消息精确比较。

“我想中止订阅”不能命中“中止”；“够了／好了／行了”有歧义不纳入；“暂停”不等于取消。确认词集由 [confirmation match](../../../packages/server/src/confirmation/match.ts)维护，取消词须与批准／拒绝集合互斥，不在这里复制第二份完整确认词权威。

Host 把全局配置的 `intent.cancelKeywords` 追加到默认词，并注入确认词集做启动期冲突校验。当前配置是全局 `config.jsonc`，**没有旧稿所述全局＋项目两层 append**。默认 InboundRouter 同样注入确认词；直接调用 classifier 工厂而未传确认集合时不会校验冲突，自定义注入者必须履行该合同。

## 入口与权威链

```text
CLI 键盘 → ConversationController → RPC session.abort ─┐
其他 RPC 客户端 → session.abort ───────────────────────┤
渠道文本 → IntentClassifier → Channel Product binding ─┤
                                                     ↓
                  Product API → ConversationApplication
                                                     ↓
               控制准入 → ConversationRunJournal 取消决定
                                                     ↓
                    assignment 取消推进＋本地执行止损
                                                     ↓
                         权威终态 → 投递／接入面投影
```

`ConversationApplication.abort` 验证 caller、conversationId 与控制身份后委托 runControl。耐久 RPC 取消需要稳定 requestId 和 runId；缺少身份是输入错误，不能退回裸进程内 abort。CLI 等收到 runId 后再提交此前的取消请求，避免接受交界取消错对象。

渠道 binding 由 channelId＋messageId 派生稳定 operationId，携带调用者 principal 和 replyTarget；无 runId 的渠道取消走 `cancel-batch`。owner 在应用决定时冻结候选：queued 与当前 dispatched／running／cancel-requested 的运行；重放复用原批次，不能重新枚举并取消之后新来的消息。

排队项可以形成 cancelled；已分配执行先进入取消推进，依靠 assignment 的取消证明与权威裁决结束。本地 `applyDurableCancellation` 负责已决定运行的止损和队列处理，不能用其 boolean 代替耐久终态。身份、权限、epoch 与无效控制可拒绝，旧稿“取消永不抛错”不是当前公共合同。

批量取消不按原输入 sender 过滤，但控制提交仍携带当前 sender 的 surface principal 并经过准入，不能把旧“群里任何人都能叫停”理解为跳过权限。其授权边界由控制准入决定，本模块不另建鉴权规则。

取消决定之后新接受的消息不属于原批次；由会话串行规则推进，不丢弃、不借取消抢占新工作。已终止／空批次的反馈和重放由权威结果决定，而非再次猜测本地 busy 标记。

`schedule.abortRun` 属于 Scheduler 应用与锚点 JobJournal：通过 assignment fence、取消证明和 uncertain 裁决推进，不能恢复旧进程内 RunRegistry 为 job 取消或恢复权威。子 Agent 的父取消传播见[子 Agent 架构](../subagents/architecture.md)，不另造全局 InterruptManager 收集所有 controller。

## CLI、断线与关停

常规 REPL 每次执行装载 KeyboardSource 与 SignalSource，但本地 signal 触发的是 `ConversationController.abort()`，**不是把该 controller 直接传给本地 Agent Loop**。Esc／首次 Ctrl+C 请求取消；800ms 内再次 Ctrl+C 记录退出意图，等待 outcome、detach 后再关闭输入，避免先断掉终态接收。当前桥不传本地 typed reason，因此不能保证宿主最终原因保留 esc／ctrl-c 区别。

KeyboardSource 复用 stdin ownership：临时 cooked 输入前 pause，释放键盘所有权并切 cooked；结束后 resume 重新获取；detach 依次卸监听、恢复原 raw 状态、归还所有权。raw 模式 Ctrl+C 不产生 OS SIGINT，须监听 keypress；非 TTY／cooked 由 SignalSource 兜底。闲时按键和关闭局部 UI 不由运行中断源接管。

生产耐久 RPC 连接只拥有在线观察能力，**断线不取消运行**；显式取消走 session.abort。源码中的非耐久兼容分支仍以 connection-close 触发 external 原因，不能把它写成生产耐久运行规则。

Host 停止不是用户取消的别名：当前 HostStopLifecycle 关闭准入、冻结已接受工作，按 cancel／drain／immediate 策略处理，再刷耐久状态、完成物理停止准备。不得用一个全局 abort 同时杀业务执行与恢复尝试，也不能把旧 LIFO 注册片段当完整关停权威。InboundRouter 拒新时尝试反馈“服务暂时不可用，请稍后重新发送”，不再进入分类／确认／Agent；发送失败记录错误，并非送达保证。

## 反馈单源与呈现

| 情况 | 当前责任 |
|---|---|
| 非空渠道 cancel-batch | 逐 run 的权威 cancelled／aborted 投递项负责反馈；router 不追加一条直接“已停止” |
| 空渠道 cancel-batch | 同一控制决定产生 DeliveryAuthority 回执 item；runtime 只唤醒投递 |
| InboundRouter 的非权威 pending／none 返回分支 | 仍有直接发送队列计数／无任务文案的兼容代码；不是当前耐久渠道主链 |
| 模型闲置等执行中断 | 保留 typed reason；接入面按自身投影与文案展示，不伪装用户取消 |

取消请求受理、执行停止、权威终态、消息送达是不同事实。取消反馈必须来自相应事实，不能提前回“成功”后丢弃 cleanup。完整消息日志与投递耐久性不由 formatter 保证。

reason 语义保持一致，格式留在表面：主动取消表示用户控制；idle-timeout 表示流无新 chunk；parent-abort 展示可追溯根因；external 按已知 origin 解释、未知兜底。中文渠道 formatter 与英文 serializer 各自负责形式，不为少量分支构建通用国际化框架。serializer 的 message 可按根因解释，detail 保留原始嵌套结构。

当前 [RPC 事件投影](../../../packages/rpc/src/session-events.ts)通过 `session.event` 转发 `interrupt:warn`／`interrupt:fired`；REPL 经 [RpcEventBus](../../../packages/cli/src/runtime/rpc-event-bus.ts)还原事件并挂接[渲染订阅](../../../packages/cli/src/render.ts)。主运行预警显示一次提示，中断触发显示 `[interrupted]` 标记。有 screen 时另挂[状态条](../../../packages/cli/src/status-bar/status-bar.ts)：运行中收到预警显示剩余倒计时，收到新的流事件恢复正常展示，收到 `interrupt:fired` 保存原因，在 `agent:run_end` 展示中断终态。无 screen 时不装载动态状态条，不能承诺倒计时展示。

非流式渠道的取消回执不等于完整展示 partial；其他 RPC 客户端虽能接收事件，其展示由各自消费实现决定，不保证具有 CLI 的提示和倒计时。未来按钮、暂停恢复或其他控制类型不作为已实现能力。

## 核对入口

- [入站分类与反馈](../../../packages/server/src/channels/inbound-router.ts)、[分类器](../../../packages/server/src/intent/intent-classifier.ts)、[Host 词集装配](../../../packages/cli/src/serve/channels.ts)。
- [渠道 binding](../../../packages/cli/src/serve/channel-conversation-product-binding.ts)、[Conversation 应用](../../../packages/core/src/conversation/application.ts)、[取消协议 runtime](../../../packages/cli/src/serve/conversation-protocol-runtime.ts)、[owner 决定](../../../packages/owner-kernel/src/conversation-assignment.ts)。
- [RPC 入口](../../../packages/server/src/rpc/methods/session.ts)、[CLI 控制器](../../../packages/cli/src/runtime/conversation-controller.ts)、[REPL](../../../packages/cli/src/repl.ts)、[Host 停止生命周期](../../../packages/cli/src/serve/host-stop-lifecycle.ts)。

直接回归边界：pending confirmation 下取消只走控制；否定词不误取消；相同请求重放不扩大候选；新消息不被旧批次吞掉；取消证明与反馈单源；断线仍可恢复观察；关停先闭准入后处理已接受工作；取消后新输入可继续。测试和旧验收记录是核对入口，不单独证明生产链成立。
