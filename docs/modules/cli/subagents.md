# CLI 子任务展示

## 体验合同

用户关注的是委派是否在推进、哪些失败及总体成本，不需要阅读完整子推理或每次内部工具输出。成功项聚合，失败/中止明确可见；主 Agent 应在综合答案中披露失败，不把部分来源冒充全部成功。

这里说明 Task 的呈现，不把文件化编排和多视角的进度混入同一状态机。执行与结果语义以[子 Agent 架构](../subagents/architecture.md)为准。

## 状态与布局

本地状态栏按父 toolCallId 维护 Task registry，记录 child 是否启动、lineage、状态、焦点及内部工具。计数从 registry 派生，不另设累加真相。child_end 幂等更新子终态，call_end 收口父调用；无 child lifecycle 的前置失败由父调用收口，不能重复计数或凭调用顺序串槽。

正常底部是稳定状态栏、输入区和输入下方提示行。Task 活跃时只在状态栏上方增加一条临时详情行：

```text
⌬ 3 个子任务 · 2 运行 1 完成 · #3 核查状态 · grep
◈ 子任务中 · 耗时与用量 │ 长期任务进度 │ 上下文
输入区
输入提示行
```

详情承载总数、运行/完成/失败/中止计数及焦点；原状态栏保持紧邻输入区的锚点，长期任务 tail 仍附在锚点，不移到详情行。子 usage 可参与成本呈现，但不应改变主阶段或主上下文水位；一般主事件按根 lineage 过滤，orchestration 事件仍按自身身份消费。

详情随批次出现与消失，不为每个成功子任务增删行。screen controller 只认识通用详情行和锚点，不理解 Task。终端使用主缓冲区，已提交 scrollback 不回头重绘；非 TTY 或不支持 Chrome 时只输出追加式结果，不输出动态中间帧。

宽度不足时优先保状态、数量及焦点编号，再分配描述，先省略内部工具。禁止把整行从右侧盲裁导致失败消失；状态行不得软折，极窄宽度只能在明确布局预算内降级。该要求需以实际 renderer 验证，不能由存在格式化函数推断所有终端都已达标。

## 结束摘要与成本

批次结束追加一次总计，成功项不逐条刷屏；失败和中止项各追加带编号、短身份及诊断的告警。保留成本和状态后再分配描述宽度，不回写已提交历史。

Task 的展示 artifact 与 usage trailer 分工不同：artifact 服务即时呈现，不进入 transcript；trailer 经运行层解析为结构化查询结果，CLI 不自行猜测私有文本状态。`/usage` 的拆分与宽度规则统一见[用量展示](usage-display.md)。

## 当前接入边界

状态栏已有 child_start/end 消费与 registry，结果呈现也有本地实现；但常规远端会话的 RPC 事件白名单没有 child_start/end，默认 session delta 又剥离 renderer-only presentation。因此不能将本地渲染能力写成常规 RPC REPL 已完整显示上述动态详情及终态告警；保留 lineage 并不等于转发了全部事件。

非流式渠道主要消费主答案，不承诺展示子内部过程；失败披露仍是产品要求，不能仅靠主模型提示证明一定可见。后续接入应复用相同子身份、结果与产品语义，不通过终端 ANSI 或第二套猜测状态补通道。

维护入口：[状态栏](../../../packages/cli/src/status-bar/status-bar.ts)、[摘要格式](../../../packages/cli/src/subtasks/presentation.ts)、[RPC 白名单](../../../packages/rpc/src/session-events.ts)。核对混合工具批次关联、child_end/call_end 去重、根/子事件隔离、批次高度、窄屏 CJK、非 TTY 降级及真实 RPC 消费；不能只测本地 EventBus 后宣称用户链完整。
