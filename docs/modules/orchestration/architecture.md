# 文件化可编排基础设施

## 第一部分 · 需求区

### 文件化可编排基础设施

- **本质需求**：为知行提供基于文件 / 文档 / 配置的内部编排定义基础设施，用有限规则表达多步骤、单节点执行、顺序执行和单轮多节点并发；它是多视角发散收敛等上层能力的基础设施，不绑定具体业务模块。
- **核心边界**：基础设施只负责协议、规则、校验和执行约束；由谁编写定义（产品预设 / Agent 生成 / 用户手写）不是本需求核心；角色、收敛、具体工作方法等属于上层业务，不写入底层抽象。
- **稳定性要求**：定义必须有限、可解析、可验证，应用前强制检查；拒绝无终点、失控循环、无界并发、非法引用、缺失输出契约等会导致不稳定执行的结构。
- **安全要求**：默认保守，工具、资源、并发、预算、超时和权限都必须有边界；规则检查通过前不得应用，避免 Agent 自由生成不可控流程。
- **演进方向**：第一版从多视角发散收敛这个真实消费者长出来，只覆盖它需要的有限编排与单轮并发；多轮对话、更多并发形态等更大边界作为未来延伸，等新的真实拓扑出现后再增量扩展。

## 架构与职责

定义描述有限节点、依赖、输入输出与执行约束；确定性程序决定下一步，模型只负责节点内部判断。文件格式不是架构中心，不能用“让模型读文件后自由调用 Task”代替校验与调度。

[多视角评议](../conversation/perspectives.md)是现有产品消费者。视角、交叉吸收、收敛属于消费者；通用层只承载定义、模板展开、模型角色、上下文与执行规则。新增通用机制必须由真实消费者证明必要，不预建万能流程平台。

| 层 | 当前归属与责任 |
|---|---|
| 定义内核 | `core/orchestration`：JSONC 解析、校验、归一化、拓扑计划与可信模板实例化，不运行 Agent |
| 上下文资产 | 持有会话窗口的调用方捕获只读快照；runner 不依赖活窗口 |
| 执行适配 | `orchestrator/orchestration`：DAG 调度、节点执行、输出检查、终态与事件；agent 节点复用 `runChildAgent`，不经过 Task 工具 |
| 产品应用 | 会话多视角应用选择内置模板、准备参数并消费最终输出，不在通用层写业务特判 |
| 正确性边界 | 父运行提供权限、计量及资源上下文，执行器不成为独立提交权威；产品结果由所属领域提交 |

## 定义到可执行计划

`可信模板 + 有界参数 → 实例化 → load（解析、校验、归一化、计划）→ executable → runner`

- `sourceMode: trusted` 表示受控来源，不表示免检；目前没有对用户或模型开放自由生成任意定义并直接执行的产品入口。
- `OrchestrationExecutableV1` 固化归一化定义、计划与 caps；上限改变应重新装载，不在执行入口再传另一份相互竞争的上限。
- 定义只允许有限 DAG 与 agent 节点；依赖不存在、自依赖、环、非法节点标识、缺失输出、越界策略必须拒绝。计划是确定性派生索引，不是第二份可修改定义。
- 输入与输出支持受限 text/JSON 合同；不满足长度或 schema 的结果失败，不让模型猜测修补。预期校验失败返回含路径、代码、说明的 issues。
- 参数实例化支持有界数组、`expandForEach`、`groupId` 与组依赖展开；展开后仍走完整校验和 maxNodes 上限，不是运行期间动态改变 DAG。
- 节点 `policy.modelRole` 支持按角色选择模型；未声明时使用执行器默认模型。模型角色是通用执行策略，不能出现“视角档位”特判。

## 边界与默认值

并发、运行时长、节点时长/轮数/token、指令/输入/输出长度、快照 token 与工具集合均受系统 caps 约束。定义不能放大调用方授权；节点工具只能取全局允许工具子集，省略时为空集，执行前还检查实际工具可用性。

`dependsOn` 决定先后；上下文只能来自 run input、显式窗口快照及声明依赖的输出，不能任意引用全局状态或无依赖节点。输出合同必填；节点数量以实际定义为准，不增加另一份作者填写的数量真相。

当前只接受 `fail_fast`，省略时归一化为该值。循环、动态分支、脚本节点、任意外部资源声明、无界并发/重试、人类裁决节点、后台长任务、跨轮挂起及编排自身的跨重启恢复均不在本合同内。不能因父运行支持耐久恢复而宣称 DAG 节点可断点续跑。

## 上下文隔离

快照由调用方在稳定会话边界捕获一次；所有声明使用它的节点共享同一份不可变消息资产。它与问题输入、instruction、system prompt 分开：

- `full_or_fail`：整窗超过预算即失败，不偷偷截断。
- `tail`：显式选取有界尾部并携带策略标记，不冒充完整上下文。
- runner 在启动前检查必需输入和快照、策略及预算；不过检不启动节点。
- 节点通过 `backgroundMessages` 注入背景，变量上下文不拼进 system prompt，保持缓存前缀稳定；节点不能将自身输出写回主窗口。

## 执行与终态

runner 按依赖完成状态启动 ready 节点，受 maxParallel 约束；节点输出通过合同检查后才可被下游消费。节点状态为 pending/running/completed/failed/aborted/skipped，运行返回 completed/failed/aborted，并携带已完成输出、错误与 usage。

父 abort 向编排及节点级联；fail-fast 只中止本次编排，不反向终止父运行。失败时跳过未开始节点并中止在跑节点，不启动后继；运行超时与用户中止分别表达，不把部分产物当成功。

节点身份使用 `definitionId:runId:nodeId:1` 作为 child operation identity。存在父资源预留上下文时，子执行派生 child lease；模型计量、工具授权沿父调用上下文进入，结果返回父产品链，不建立第二提交源。

终态要求：所有终态都应先结算、释放子资源，再允许父节点终态推进。当前 `runChildAgent` 在子执行清理后结算、释放租约，并将结算或释放异常转为失败结果；但 runner 通过 `Promise.race` 可在中止或超时时提前返回，`drainRunning` 等待的也是该包装结果，而非底层执行清理完成。因此当前编排返回不能保证子资源已释放，也不能保证随后发生的清理失败进入编排结果；这是实现与终态要求的差异，不是放宽要求。

本机工具执行的容量包装使用 `workload-orchestration`，不是整段等待时间占用设备许可；模型调用与工具执行各自受已有治理约束。资源细节沿子 Agent 实现维护，本层不另建租约或容量系统。

## 事件与维护依据

复用 `AgentEventMap` / EventBus：validation_failed、run_start、node_start、node_end、run_end；run/definition/node 标识与 lineage 区分并发实例。子 Agent 事件仍走 child bus，不另起私有事件系统。上层只投影有产品意义的进度，不默认记录完整敏感 prompt。

- [定义入口](../../../packages/core/src/orchestration/index.ts)、[装载](../../../packages/core/src/orchestration/loader.ts)、[模板](../../../packages/core/src/orchestration/template.ts)、[校验](../../../packages/core/src/orchestration/validation.ts)。
- [runner](../../../packages/orchestrator/src/orchestration/runner.ts)、[agent 节点适配](../../../packages/orchestrator/src/orchestration/agent-node-executor.ts)、[子执行](../../../packages/orchestrator/src/subagent/factory.ts)、[工具容量接入](../../../packages/orchestrator/src/subagent/loop-runner.ts)。

维护时核对：非法定义零节点启动、快照策略与缓存隔离、串行/并发与依赖、权限子集、输出违约、fail-fast 不伤父运行、abort/超时及资源终态。直接测试为定义内核、runner、agent-node-executor 及真实消费者测试；模板可信或测试通过不能替代生产调用链验证。
