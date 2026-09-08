# 会话任务列表

任务列表是用户与智能体共同维护的会话计划，不是定时调度、后台作业或长期记忆。它让用户看到当前工作与进度，也让模型在上下文换段后继续同一计划。

## 状态与用户行为

每项包含稳定 id、内容与 `pending / in_progress / completed` 状态；列表按 conversationId 隔离。模型通过 `task_list.set` 整体替换计划，需保留仍有意义的历史项；用户通过命令追加或标记完成。段切换只读取进行中状态，不修改任务列表。

| 入口 | 行为 |
|---|---|
| `/tasklist` | 显示当前会话完整列表 |
| `/task new <内容>`、`/task <内容>` | 追加待办 |
| `/task done <序号或 id>` | 按一基序号或 id 前缀定位并完成任务，歧义或不存在由应用层处理 |
| `task_list.set` | 模型提交完整替换，缺失条目 id 时由耐久工具调用身份与条目内容派生 |

无持久化对话身份的一次性运行不提供用户任务列表操作；不能退化为写入全局共享列表。用户 `/clear` 通过会话清理流程处理列表；状态服务的 `clear()` 本身仅驱逐缓存并通知，不等于删除全部持久数据。

## 唯一业务责任与提交

会话应用层定义校验、定位、变更与结果；CLI 和 RPC 负责输入输出适配，不各自实现一套业务。

```text
用户命令 → session.taskListUpdate → 会话应用 → owner 维护边界 → 保存与发布
模型工具 → 会话工具应用 → assignment 暂存 task-list-op → 权威接受 → 已提交投影
已提交状态 → TaskListService／session.changed → CLI 只读缓存 → 任务摘要与详情
```

模型写入需要 conversationId 和耐久 toolCallId，operationId 与工具调用绑定；执行端暂存写入不等于最终提交，不可提前另写会话文件。提交后的 `acceptCommitted` 只更新缓存与通知，不再进行第二次存储写入。段切换决策可通过 assignment overlay 读取本次暂存任务状态，其后才回退到已提交缓存。

TaskListService 按会话缓存状态，`set` 先保存再更新缓存与发布事件，保存失败不推进缓存；订阅者异常相互隔离。它不是用户命令的并发仲裁器，生产读改写由 owner 的维护边界串行保护，不能把底层单次 save 原子性误写为任意多步变更都无竞争。当前 `prime` 读取失败会缓存为空列表，不代表磁盘任务已被删除。

CLI 通过宿主状态同步维护 TaskListViewCache，仅提供视图；命令写入走 RPC。切换或恢复会话时刷新对应视图，不携带上个会话的任务。模型输入侧由 TaskListProvider 按当前身份读取，详见[逐轮上下文注入](../context/turn-context-injection.md)。

## 展示取舍

常驻区只显示当前任务和“已完成／总数”，完整列表按需展开；没有任务或全部完成时隐藏常驻摘要，避免为偶尔使用的功能持续占据屏幕。

TaskTail 只订阅状态并生成任务文本；屏幕控制器负责位置、分隔符、宽度和重绘。任务段使用独立稳定 id，与其他状态段共存，不反向修改状态栏业务。无进行中任务时显示待办数量；多个进行中项显示首项与其余数量。详情以序号和状态区分条目，与完成命令的选择方式一致。

用户命令显示简短成功或失败反馈，不伪造完成；模型工具已有结果反馈，不另叠加一份命令回声。窄终端允许摘要截断，完整信息仍由详情查看。

## 实现与验证入口

- [会话应用](../../../packages/core/src/conversation/application.ts)、[状态服务](../../../packages/core/src/conversation/task-list-state.ts)、[Anchor 适配](../../../packages/cli/src/serve/conversation-task-list-application.ts)：业务、保存失败、维护互斥与耐久暂存边界。
- [用户命令](../../../packages/cli/src/commands/task-commands.ts)、[只读缓存](../../../packages/cli/src/runtime/task-list-view.ts)、[任务摘要](../../../packages/cli/src/task-tail/task-tail.ts)：RPC 写入、会话隔离与显示生命周期。
- [状态测试](../../../packages/core/src/conversation/__tests__/task-list-state.test.ts)、[生产适配测试](../../../packages/cli/src/serve/__tests__/conversation-task-list-application.test.ts)、[命令测试](../../../packages/cli/src/commands/__tests__/task-commands.test.ts)、[显示测试](../../../packages/cli/src/task-tail/__tests__)分别保护状态、消费链与体验，不以单张快照替代提交与恢复验证。
