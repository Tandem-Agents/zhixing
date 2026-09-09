# 中断执行架构

中断让用户或宿主停止当前执行，同时留下可理解、可继续使用的对话与执行事实。它不是清空会话、撤销已完成效果或暂停后原地续跑。入口、耐久取消与反馈见[控制与反馈](control-and-feedback.md)；Run／Turn 的层级见[生命周期概念](../../architecture/lifecycle-concepts.md)。

## 职责与设计取舍

执行内核负责响应信号、保留已取得的内容、补齐工具协议并返回终态；产品领域负责决定取消谁以及何时成立；接入面负责输入与展示。三者不能相互代替。

| 选择 | 不采用的方式 | 原因 |
|---|---|---|
| 原生 `AbortSignal` 跨边界，controller 由执行所有者持有 | 新建 controller 类或传递可写 controller 给所有下游 | 与 Provider、工具和平台 API 共用一套取消协议，不向下游泄露上游写权 |
| 每次 Loop 创建一个 controller，汇聚外部信号与 watchdog | 多份 aborted 标记、事件总线指挥退出 | 信号是执行内单一取消事实；耐久产品状态另由 owner 决定 |
| 中断竞争与闲置计时分离 | 只依赖 SDK 响应，或禁用超时就失去中断能力 | SDK 的 `iterator.next()` 可能挂起；关闭自动超时不能关闭用户控制 |
| chunk 到达重置闲置计时 | 固定总时长、只在外层轮次轮询 | 长回复不等于挂死，流中静默也不能无限等待 |
| cleanup 只产数据，Loop 统一组装事件 | 工具执行器、adapter 各造占位与终态 | 避免重复结果、事件乱序和外层抢先结束导致内容丢失 |
| 保留部分 text／thinking，丢弃流阶段全部 tool_use | 用 JSON 外观猜测参数是否完整 | 不完整调用不能执行；不引入脆弱的完整性启发式，代价是看不到该次未完成的工具意图 |
| 工具实现自己的取消／资源清理 | 给工具 Promise 做 race 就宣称效果停止 | 放弃等待不等于进程或外部效果已停止 |

这些选择承接既有研究中的信号汇聚、协作中断、双阈值与协议补齐思想；不依赖某个外部项目当前实现，也不引入投机执行、自然语言自动中断或后台任务框架。

## 信号与终态

`runAgentLoop` 用 `createInterruptController` 接收外部 signal，向模型、工具和上下文处理传递同一 signal。需要主动触发 watchdog 的 Loop 内部协作者可持有 controller；普通 Provider／工具只接收 signal。

`abortWithReason` 幂等，第一次原因胜出；不发事件。父 signal 已取消时创建子 controller 必须立即生效，不能只挂监听。`forkController` 单向传播为 `parent-abort`，子取消不反向取消父或兄弟；外部信号合并保留可识别的 typed reason，否则使用 external 兜底。

| reason | 语义与必要信息 |
|---|---|
| `user-cancel` | 主动取消；`source` 为 esc／ctrl-c／sigint／rpc，附 `pressedAt` |
| `idle-timeout` | 模型流闲置；附阈值、已收 chunk 数、距最后 chunk 时间 |
| `parent-abort` | 父取消传播；保留嵌套 `parentReason`，允许 null |
| `external` | 其他外部控制，可附 `origin` |

原因须保持 JSON 可序列化，不携带 Error、signal 或循环对象。`getAbortReason` 当前只检查对象的 kind 字符串，**不是完整运行时 schema 校验**；消费者不能把它当不可信输入验证器，须保留未知原因兜底。

`aborted` 与 `completed`、`max_turns`、`error` 分开；模型的 StopReason 也不承担执行取消语义。abort 与轮次上限同时满足时先处理 abort。上下文处理及结束钩子交界也必须保留原因，不能把取消转成普通成功或无关错误。启动前失败不伪造已经启动的 Loop 事件；消费者主动结束生成器由 Loop 的 finally 处理终止边界。

## 模型流与部分结果

`wrapStreamWithWatchdog` 组合 abort race 与可选 idle timer。默认策略为 60 秒闲置中断、50% 阈值预警；0 仅禁用 idle timer。工厂拒绝非法数值，预警比例必须在 (0,1)。一次新 chunk 会重置计时与预警状态，之后再次静默可再次预警。

`llm-call` 先消费到手事件、累积内容，再检查 abort，避免把同一交界已收到的最后片段丢掉。中断返回 partial 和已收到的 usage，由 Loop 调 `buildCleanup`：

- 有 text：追加 `[interrupted]` 标记；仅有 thinking：另加含该标记的 text block。
- 两者都空：不制造空 assistant 消息。
- 流阶段的 tool_use 全部不进入 partial，因此也不为这些被丢弃的调用制造孤立 tool_result。
- 普通 Provider 错误的安全部分消息不加中断标记，不能误称用户主动取消。

已获得的模型用量继续累计到轮次及最终结果，不能因中断置零；Provider 尚未报告的 usage 不能凭空精确恢复。Kernel 产出部分消息不等于所有接入面都展示，也不等于绕过 owner 已完成持久化提交；后者见[对话持久化](../conversation/persistence.md)。

## 工具阶段与效果边界

完整 assistant 的 tool_use 已进入执行阶段后，必须逐个有对应结果。执行器在批次入口／串行迭代前检查信号，工具完成后先保留有效结果再检查信号，避免下一轮误以为工具没做过而重复副作用。未执行或因 abort 抛出的调用交给 cleanup 生成 `isError` 取消占位，Loop 统一发 `tool_end` 与 `turn_complete`；普通工具错误保留普通错误结果。

并发批次等待 `allSettled` 收齐已启动工具；fulfilled 结果与中断占位可能分组输出，依赖 toolUseId 配对，不假设混合退出仍严格按原数组位置。已完成的文件修改、发送等效果不会因取消自动回滚，占位也不是“效果从未发生”的证明。

| 工具声明 | 责任 | 当前边界 |
|---|---|---|
| cancel | 响应 signal，尽快返回部分结果或抛 AbortError | 要由工具真正实现；只声明字段不能使不可取消操作停止 |
| grace | 先清理外部资源再返回 | Bash 使用 `gracefulKill`；MCP 的具体取消能力见 [MCP 架构](../mcp/architecture.md) |
| background | 类型中保留的后台语义 | 当前执行器不消费此行为，不代表已有后台转交能力 |

`interruptBehavior` 是自描述而非执行器的调度开关。POSIX `gracefulKill` 优先向进程组发 SIGTERM，默认等待 1000ms 后升 SIGKILL，失败退为直接 child；Windows 使用 `taskkill /T /F`，失败退为 `child.kill()`。helper 等待退出，发送 kill 失败不等于已停止；不可终止资源可能使等待超过 grace 时长，不能许诺所有工具都有固定硬上界。

## 生命周期、事件与质量边界

中断源只触发 signal。Loop 记录触发时间，在退出路径先发 `interrupt:fired` 再发 `agent:run_end`；预警由 watchdog 发出，用户取消不必先有预警。`interruptedTurnIndex` 是被中断轮次的零基序号，不是 `turn_complete.turnCount` 的完成数。

保留的性能目标是 Loop 框架延迟 P95 ≤200ms，以 `exitDelayMs - toolGraceMs` 区别工具自身等待；基础 iterator race 的响应目标为 ≤10ms。它们不是网络、耐久提交、工具清理与消息送达的总时延承诺，也不是本次文档迁移取得的实测结论。

timer、iterator race listener、键盘与进程监听必须随所属执行退出释放。**当前 controller helper 没有 dispose：parent／external 的 once listener 在上游始终不 abort 时不会因子运行结束自动摘除。** 长生命周期 signal 的重复复用仍有累积边界，不把“所有资源已无泄漏”写成现状。流包装的退出清理与底层外部操作停止也须分别验证。

维护本模块时直接保护：已取消输入、流挂起、thinking-only、部分工具参数、工具成功与 abort 竞态、并发混合结果、父子隔离、上下文／退出钩子交界、用量及事件顺序。模型重试与 watchdog 的交界由[容错架构](../resilience/architecture.md)说明；不以 mock 通过代替真实 Provider、进程清理和产品终态证据。

## 实现入口

- [信号与原因](../../../packages/core/src/interrupt/controller.ts)、[策略类型](../../../packages/core/src/interrupt/types.ts)、[流竞争](../../../packages/core/src/interrupt/stream-race.ts)、[watchdog](../../../packages/core/src/interrupt/watchdog.ts)。
- [Loop](../../../packages/core/src/loop/agent-loop.ts)、[模型调用](../../../packages/core/src/loop/llm-call.ts)、[工具执行](../../../packages/core/src/loop/tool-executor.ts)。
- [cleanup](../../../packages/core/src/interrupt/cleanup.ts)、[partial 组装](../../../packages/core/src/interrupt/assemble.ts)、[进程清理](../../../packages/core/src/interrupt/graceful-kill.ts)。
