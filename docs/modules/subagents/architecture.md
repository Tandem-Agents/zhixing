# 子 Agent 执行架构

## 需求与取舍

子 Agent 是受父运行约束的短命执行单元：隔离多轮处理的上下文，将有界结果交还调用方，不让中间过程挤占主对话。它不是独立用户身份、会话、后台常驻 Agent，也不是工作流平台。

执行机制与产品入口分离：调用方决定任务与组合方式，子执行负责装配、权限、预算、中断和结果。用户不必编写角色或流程配置；不能从“可组合”推导出必须预建任意组合、递归或更多工具入口。

| 当前消费者 | 决定什么 | 如何使用子执行 |
|---|---|---|
| 主 Agent 的 Task 工具 | 是否委派、任务文本、如何综合结果 | `createTaskTool → runChildAgent`，多轮只读调研、并行比较与上下文隔离 |
| 文件化编排的 agent 节点 | 已校验 DAG 的依赖、节点输入、模型角色、预算与输出合同 | `ChildAgentNodeExecutorV1 → runChildAgent`，不经过 Task；现有产品消费者是多视角评议 |

Task 适合需要多次读取、搜索或网页核查的独立子问题；单次工具就能解决的问题不必派生。顺序调用 Task 可以表达简单串行委派，但不等于确定性 DAG，也不能替代编排校验。Task 的每批调用上限和文本结果协议不是全部子执行的共同限制。

每次派生创建独立消息、角色、EventBus、ConfirmationBroker 和中断状态，不池化复用上下文。历史与预算属于当次任务，没有可跨任务复用的会话状态；按需装配轻量执行体，避免池化带来的重置责任与上下文串用。运行采用同进程异步执行，重叠模型与工具 I/O，无需为等待 I/O 引入 worker／进程通信与序列化；上下文隔离不是进程沙箱。

## 装配与所有权

当前 `orchestrator/subagent` 持有共享执行机制，`orchestrator/tools/task` 和 `orchestrator/orchestration` 分别适配两个消费者；core 提供通用 loop、工具批次、事件及正确性合同。CLI 只消费展示，不能成为子执行组合根。

Task 在 `createAgentRuntime` 中从父实际 `baseTools` 与 `SUB_AGENT_ENABLED_TOOLS` 的交集派生可用工具名称；主 profile 允许 Task 且交集非空时才装配入口。子工厂再次按 sub profile 白名单过滤父工具。当前白名单是 `read / glob / grep / web_fetch`，不含 Task、写文件或执行命令工具；编排节点还先按节点声明选择工具，不能扩大父授权。

白名单使父侧新增工具不会自动扩散到子执行；不装配 Task 从能力上阻止递归，而非仅靠提示词或运行深度计数约束。

Task 复用父主调用的模型与思考配置；编排节点按已解析的模型角色选择。共享工作目录、工具安全链和顶层用户意图，不等于共享子消息列表或允许子任务伪造授权。Task 的派生动作本身不要求确认，具体子工具仍逐项走安全及耐久授权链。

子 broker 继承父的生命周期观察者，记录父 broker 和子身份；共享安全规则由安全链判定，不能用审计血缘替代批准。当前无交互策略为 `inherit-or-deny`，没有处理者时拒绝，而非默认批准。

## 上下文与运行

`输入校验 → 装配角色/工具/消息 → 上下文预检 → 取得子租约 → 执行 → 清理 → 结算/释放 → 返回结果`

system prompt 只含稳定角色约束、真实工具与环境信息；任务通过 `sub_agent_task` user 消息携带 description 和 prompt，不拼进 system prompt。编排可另外传入声明的只读背景快照；Task 不自动复制主对话。数据封装用于区分任务和系统约束，不是抵御所有提示注入的保证。相同角色、工具和环境应保持静态前缀稳定，缓存收益不能成为牺牲边界的理由。

预检估算 system prompt、初始消息及工具规格，只拒绝明显超过注意力风险预算的任务；估算异常回落运行期检查。默认预算为 20 轮、累计 50,000 input/output tokens、60 秒模型流空闲超时及 10 分钟总时长；编排节点可以传入自身受约束的预算。

累计 token 和单次输入风险在模型请求结束事件检查；轮数由 loop 限制。总时长由计时器发出 abort，不能将所有预算统一描述为“仅在请求结束后触发”。预算原因使用 first-wins 分类，失败尽可能返回 partial；父中断单向级联，子失败不反向中断父。失败披露是主 Agent 的回答义务，不应把提示要求写成模型必然遵守的保证。

## 资源、持久化与终态

存在父资源预留时，以父 reservation 和稳定 operation ID 派生子身份、取得有界 child lease；Task 使用 toolCallId，编排使用 definition/run/node/attempt。模型调用在子租约上计量，子执行继承父 query、assignment mutations 与授权上下文，不建立独立业务提交权威。本机工具执行通过 `workload-orchestration` 容量包装，不让整个子任务的网络等待占住工具执行许可。

子中间消息不保存为独立对话，Task 的 tool_use/tool_result 随父对话提交；这不意味着资源、安全和父运行事实不耐久，也不提供子消息或 DAG 节点的跨重启续跑协议。与独立 sidechain 相比，这一选择减少恢复与双重历史管理，但不提供独立恢复子会话的能力。

所有终态应先收敛资源再交还父运行。子工厂负责调用 settle/release；[Executor governor](../../../packages/executor/src/resource-governor.ts)负责在既有日志事务中保守结算本子树尚未闭合的用量预留，按最深优先顺序结算并释放后代，再结算当前子租约，由后续 release 释放当前租约。不能只释放当前 child 而遗漏后代或未结用量。

父 assignment 的资源终结路径通过 `flushAssignment` / `finalizeLocalAssignment` 兜底：先收敛未结用量，再最深优先清理遗留后代，之后生成最终用量。响应不明时必须沿稳定操作身份与原租约重放，不能另建第二个 active child 或第二份 owner 日志；这恢复的是资源事实，不是子对话续跑。当前 governor 已有子树清理、重启后重复结算与释放的[直接测试](../../../packages/executor/src/__tests__/resource-governor.test.ts)。

当前工厂清理 bus/broker，loop 清理定时器及监听，再 settle/release 子租约；结算或释放异常转为 failed。该异常分支提前返回，未发送 child_end，故不能承诺所有启动事件都必有配对终态事件。编排外层中止/超时可能先返回包装结果，其等待不等于底层清理已完成，详见[编排终态边界](../orchestration/architecture.md)。

## Task 输入与结果合同

- 输入仅允许 trim 后非空的 `description`、`prompt` 字符串，description 长度由 schema 与运行期同源限制；错误输入不派生子实例。
- `maxCallsPerTurn = 3` 限制单次工具执行批次：前三个执行，超出的逐个返回错误，不跨多次模型调用累计。能否并行还服从通用工具批次安全规则，不代表整个 Run 只能有三个子任务。
- 描述由真实 `childToolNames` 生成，不向模型承诺未装配的本地或网络能力；公共工具执行器只识别通用批次上限、toolCallId 和并行属性，不识别 Task 业务。
- 共享结果为 completed/failed/aborted，包含子身份、文本、usage、工具次数、耗时及错误或中断原因；completed 空回答归类失败，失败可带 partial，工具次数包括失败工具。
- Task 将 completed 映射为非错误结果，failed/aborted 映射为错误结果；final/partial 各自最多 20,000 字符，错误、描述与展示字段另行有界。末尾追加以下固定 usage trailer，不由通用截断切掉。

```text
<usage>status: succeeded|failed|aborted, tokens: N, tool_uses: N, duration_ms: N, sub_id: abc123</usage>
```

解析只认末尾完整结构，不从正文或错误前缀猜状态。Task 同时产生 renderer-only `sub-agent-result`，带 toolCallId、subAgentId、description、状态、成本与诊断；不进入对话正文或主模型输入。编排节点消费共享结构化结果并检查节点输出合同，不使用 Task trailer 作为节点协议。

## 事件与维护边界

子事件沿父 EventBus 冒泡，lineage 属于 EventMeta，不写入业务 payload。Task 通过 parentToolCallId 关联 child_start/end 与父工具调用，不能靠事件先后来猜关联。一般主状态应排除子 lineage，编排域事件按 definition/run 身份消费，不把 Task 的过滤规则强加给编排。

[CLI 展示](../cli/subagents.md)负责进度和失败可见性；[用量展示](../cli/usage-display.md)负责用户查询。[文件化编排](../orchestration/architecture.md)与[多视角评议](../conversation/perspectives.md)分别定义组合及产品流程，本层不重复定义。

维护入口：[子工厂](../../../packages/orchestrator/src/subagent/factory.ts)、[loop](../../../packages/orchestrator/src/subagent/loop-runner.ts)、[预算](../../../packages/orchestrator/src/subagent/budget.ts)、[Task](../../../packages/orchestrator/src/tools/task.ts)、[节点适配](../../../packages/orchestrator/src/orchestration/agent-node-executor.ts)。核对两条真实消费者的工具交集、上下文隔离、模型选择、输入拒绝、并行限制、三态及有界结果、父 abort、租约异常和清理；不得以工厂单测替代父产品链验证。
