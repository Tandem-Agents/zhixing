# 运行体生命周期钩子

本文说明运行体在窗口与 Run 边界如何接入准备、输入贡献和收尾工作。术语以[生命周期概念定义](../../architecture/lifecycle-concepts.md)为准；上下文重构算法由[上下文管理架构](../context/architecture.md)负责，钩子不另建会话、持久化或提交机制。

## 一、职责与装配

事件总线负责运行观测，生命周期钩子负责在明确边界等待订阅者完成工作；两者互补，不能用“事件已发出”代替准备或清理已完成。

`RuntimeHost` 接收已裁决的产品投影，统一装配 conversation 与 ephemeral 运行体；后者用于一次性任务等执行。订阅集合在装配时确定、实例存续期间不变，每个边界按注册顺序串行等待，不开放运行后的二次注册，也不假定订阅者之间存在逆序释放依赖。宿主贡献与会话专属贡献在同一装配点合并。

装配期固定订阅集合，是为了让每个订阅者都能参与首窗准备；运行后才注册会错过这一边界，留下生命周期语义缺口。

运行体持有窗口级提示与钩子状态，不能跨不同对话共享这些可变状态。实例的使用方负责结束与释放，`RuntimeHost` 不代替会话 owner 或执行器管理产品生命周期。Task 派生子 Agent 直接走子执行循环，不经 `createAgentRuntime`，不携带本钩子；不能据此把所有非交互运行体都排除在外。

## 二、四个边界

| 钩子 | 触发点 | 允许承担的职责 |
|---|---|---|
| `onWindowOpen` | 装配首窗；切段、有效压缩、clear、resume 后的新窗 | 贡献窗口级提示段和消息前缀，为新窗口准备稳定材料 |
| `onBeforeRun` | 本次 Run 进入模型循环前 | 读取本次输入，异步准备，经 `injectUserContext` 贡献本次用户消息上下文 |
| `onAfterRun` | Kernel 正常返回本次 completion 后、Run 资源清理前 | 观测执行结果、总结经验与收尾；这是接入能力，不代表内置自动学习或 owner 已接受、提交 |
| `onWindowClose` | 换窗前关闭旧窗；实例退场关闭末窗 | 收束旧窗口及实例资源 |

换窗先对全部订阅者执行 close，再执行 open；Run 入口本身不是换窗。循环内的段切换由 `runTurnBegin`／`runTurnEnd` 在重构边界调用 `windowLifecycle.onChange`，保证下次模型调用使用新窗口；Run 外的 clear、resume、手动 compact 经运行体适配层调用 `onAttentionWindowChange`。

`onBeforeRun` 可按每次 Run、入口窗口的首个 Run（`isWindowFirstRun`），或订阅者自行维护的会话条件介入，不另开重复入口。历史装填归 owner 的窗口恢复路径，不借这个钩子加载历史，避免把窗口恢复绑到首条新输入的成败上。

`onAfterRun` 与 `onBeforeRun` 不强配对：Run 自身抛错时没有 after 回调。因此不能只靠 before 分配、after 释放保证资源安全。实例 `dispose(reason)` 幂等；会话结束、assignment 结束、替换与装配回滚均须由持有实例的一方等待释放，不以丢弃引用代替末窗收尾。`assignment-dispose` 是执行实例退场，不等于删除持久会话。

## 三、贡献内容，运行体统一拼装

订阅者不直接改写输入或替换整串 system prompt，避免多个消费者争夺拼装权。

- **窗口提示段：**`updateSystemPromptSegment` 只接受数据驱动段，当前为 `skill-index`；传 `null` 清空，不提交则延续。identity 等 profile 段及工具集合由装配确定，不经窗口钩子热改。
- **窗口消息前缀：**`contributeMessagePrefix` 接收通用消息序列，运行体按订阅者隔离贡献、校验并复制，按注册顺序拼装。显式清空、非法贡献或换窗时 `onWindowOpen` 失败会清除相应前缀；`onWindowClose` 失败本身不清除前缀。
- **Run 输入贡献：**`injectUserContext` 收集非空文本，统一拼成 `<context>` 块加到当前 Run 的用户消息。它只影响执行输入，不替换持久化的用户原文。

逐次模型调用的时间、任务状态等动态材料由[逐轮上下文注入](../context/turn-context-injection.md)负责；窗口前缀、Run 输入贡献与逐轮动态材料具有不同生效尺度，不能互相替代或形成重复注入。

## 四、窗口稳定与并发隔离

保持的是窗口内稳定前缀，不是冻结全部消息；对话仍会追加，逐轮动态材料仍会变化。只有窗口边界才重建窗口材料，相同内容保持字节一致，不为“刷新”无条件改变缓存前缀。工具集变化属于重新装配，不属于换窗。

实现分为实例保存的最新提示与每个 Run 的局部快照：

1. Run 起步取得实例当前提示及消息前缀；窗口延续时复用相同内容。
2. Run 中途换窗，只重建自己的局部提示和前缀；模型循环通过 getter 在实际消费时取当前局部值，不在循环启动时永久捕获旧值。
3. 窗口代次和投影 revision 控制实例最新值的更新，迟到的旧结果不能回退较新的投影。其他正在执行的 Run 不读取被改写的实例值，避免一个 Run 换窗破坏另一个 Run 的稳定前缀。

实例最新值仅用于后续 Run，不是会话或全局数据的权威存储。

### 产品材料与 Kernel 的边界

技能目录的领域读取和内容生成归产品侧 `skill-catalog-window-projection`；Kernel 通过 `windowPrompt` 端口取得内容及 revision，只管理消费时序和局部隔离。构造期没有 assignment 查询上下文时使用 builtin 投影；新窗口首个 Run 在提示消费前、以及 Run 内换窗时，使用该 assignment 的查询能力刷新。不得为通用订阅者额外开放构造期全局读取权限，也不在窗口内每轮扫描目录。

`ZHIXING.md` 项目约定由产品侧 guidance 订阅者在 `onWindowOpen` 加载，通过窗口消息前缀贡献；ephemeral 运行体跳过该贡献。Kernel 不解析项目约定、不决定文件层级。

## 五、失败与诊断

| 边界 | 失败处理 |
|---|---|
| 首窗 open | 装配失败，不发布未就绪实例 |
| Run 内 before／after、换窗 close／open | 单个订阅者异常报告 `lifecycle:hook_failed`，其余订阅者与运行继续；after 失败不替换已产生的 completion |
| Run 外换窗、实例 dispose | 逐个收集失败，完成其余回调后抛出聚合错误；持有方应报告并继续必要清理 |

订阅者也可主动报告软降级告警。Run 内经本次事件通道投递，Run 外由运行体收集诊断、交宿主消费；呈现归产品表面。告警接入必须有真实消费者，不能仅写入被静默的日志或无人订阅的事件。前缀失败后的清空规则见第三节；不能把所有失败概括成“无条件沿用旧内容”。

当前实现差异：[会话 owner](../../../packages/owner-kernel/src/conversation-manager.ts) 的 clear、compact 路径吞掉换窗聚合异常，尚未满足该异常的可见报告要求；这与订阅者主动报告的软告警是不同通道，不能以软告警已接入证明聚合异常已报告。

## 六、执行结束不是权威提交

钩子拥有的是介入时机，不是会话或全局状态的写权限。提示贡献与本地资源清理保持自身时点；持久状态变更必须走既有 correctness 端口与 owner 提交链。

运行中产生的 segment 等变更先进入 assignment 暂存；失败、取消不能泄漏为已提交事实，uncertain 等待 owner 裁决。提交后由既有日志义务驱动幂等发布与恢复，不从 `onAfterRun` 另写文件、另建日志或提前物化。Run 外的 clear、compact、retention 等操作仍由各自控制／维护 owner 负责，不能伪造 assignment 或借钩子绕过权限。

## 七、实现定位与核查重点

- [钩子合同](../../../packages/orchestrator/src/runtime/lifecycle.ts)、[运行体实现](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)：四边界、贡献隔离、窗口快照及失败语义。
- [RuntimeHost](../../../packages/runtime-host/src/runtime-host.ts)、[适配层](../../../packages/runtime-host/src/session-adapter.ts)：装配输入、窗口通知、等待实例销毁。
- [循环窗口边界](../../../packages/core/src/loop/turn-end.ts)：重构后、下次请求前完成换窗。
- [技能窗口投影](../../../packages/cli/src/runtime/skill-catalog-window-projection.ts)、[项目约定订阅者](../../../packages/cli/src/serve/zhixing-guidance-lifecycle.ts)：领域读取留在产品侧，不进入 Kernel。

核查应覆盖首末窗、装配回滚、Run 内外换窗、before／after 非强配对、并发前缀隔离、过期 revision、异常诊断与原文不受注入污染；事件出现或钩子被调用，均不能单独证明权威提交和清理完成。
