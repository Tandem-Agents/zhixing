# 架构审查问题收集

## 使用规则

- 本文骨架固定保留：`使用规则`、`维护原则`、`问题条目结构`、`排除问题条目结构`、`提示词文本块结构`、`来源`、`本轮审查问题`、`已排除问题`、`用户使用的提示词`。
- 清理时只清空动态内容，不删除骨架标题、说明和格式。
- `用户使用的提示词` 属于用户权限内容，不参与清理；除非用户明确要求，不得修改、清空或删除其中任何文本块。

## 维护原则

本文用于收集一轮架构审查中发现的问题，目标是在当前事实与认知下尽可能把这一轮能发现的问题收集完整，直到除本文已记录的问题之外，本轮已经无法再发现新的问题。

这不表示这些问题解决后未来不能再发现问题。问题修复本身可能暴露新的问题，或引入新的设计约束，这是正常且接受的事实。

这里的“本轮收集完成”只表示：除本文动态部分已经记录的问题外，当前这一轮审查暂时没有新的可发现问题，可以结束本轮审查。

新增问题必须满足两个条件：第一，问题必须基于事实真实成立；第二，不能与动态区已有问题重复、重合或冲突。若只是同一问题的不同表述，应合并到既有条目，而不是新增。

新增问题还必须区分“架构阶段必须定死的问题”和“实现阶段自然会处理的细节”；后者不进入问题列表，避免审查变成无限挑刺。

## 清理节奏

1. 来源：随当前模块更新而更新，修改频率低。
2. 本轮审查问题：按轮次更新；每轮审查找出所有问题，解决并清理后，该轮问题清零。
3. 已排除问题：仅在同一审查模块内跨轮次有效；来源切换到其他模块时，清除上一模块的排除项，再收集当前模块的排除结论。
4. 用户使用的提示词：不随轮次或模块清理，只有用户明确要求时才可改动。

## 问题条目结构

动态区每个问题条目固定包含三部分：

1. 编号标题：一句话指出问题本质。
2. 问题说明：说明真实事实、风险和为什么这是问题。
3. 解决方案：以 `解决方案：` 开头，写执行者认可的最优解决方案，要求精简、可执行。

## 排除问题条目结构

已排除问题使用列表维护，每项固定包含两部分：

1. 什么问题：说明被核查但排除的问题。
2. 为什么排除：说明排除依据，便于后续审查避免重复验证。

## 提示词文本块结构

底部「用户使用的提示词」使用独立文本块维护；每个文本块下方必须紧跟 `---` 分割线，空文本块也必须保留分割线。

## 来源

- 审查对象：`知行分布式运行时架构（完整架构设计）`
- 需求来源：`research/design/drafts/always-online-and-local-execution-requirements.md`
- 事实依据：
  - `research/design/drafts/distributed-runtime-architecture.md`
  - `research/design/drafts/transcript-persistence-and-attention-window-architecture.md`
  - `research/design/drafts/workscene-management-architecture.md`
  - `research/design/drafts/task-advancement-rubric-architecture.md`
  - `research/internals/screen-rendering/overview.md`
  - `research/design/drafts/unified-core-and-access-surfaces.md`
  - `packages/server/src/runtime/conversation-manager.ts`
  - `packages/server/src/runtime/types.ts`
  - `packages/server/src/runtime/run-turn.ts`
  - `packages/server/src/server.ts`
  - `packages/server/src/rpc/connection.ts`
  - `packages/core/src/transcript/shard/types.ts`
  - `packages/core/src/transcript/shard/store.ts`
  - `packages/core/src/workscene/types.ts`
  - `packages/core/src/scheduler/types.ts`
  - `packages/cli/src/runtime/runtime-host.ts`
  - `packages/cli/src/serve/command.ts`
  - `packages/providers/src/types.ts`

---

## 本轮审查问题

### 知行分布式运行时架构（第三轮）

1. job 缺少 occurrence 级权威与任务修订栅栏

   §6 让 job 复用 conversation 协议，但 `ExecutionManifest` 与不变量 3 仍只定义 `baseRevision / ownerEpoch`；job 没有任务定义、触发批次和投递配置的版本栅栏。任务在 job 运行中被更新、停用或删除时，旧结果可能写回新定义、按新目标投递，甚至把已删除任务重新写活。

   解决方案：把 scheduler 拆为版本化 `TaskDefinition` 与 append-only `JobOccurrence`；`JobManifest / JobCommitFence` 绑定 `taskId / jobRunId / scheduledFor / taskRevision / deliverySnapshot / anchorEpoch / assignmentId / executorId / digest`。更新只影响后续 occurrence；删除先禁未来触发并取消在途 job，取消结果不明则进入 uncertain，旧 occurrence 永不覆盖或复活任务定义。
2. uncertain 只有阻断与展示，没有可执行的裁决协议

   状态机进入 uncertain 后只规定“裁决前禁止继续”，产品面也只显示“结果待确认”，没有证据回补、用户动作、状态出边和审计事实。conversation 会永久卡死；job 还可能在上一批结果不明时继续产生后续触发。

   解决方案：冻结耐久 `UncertainResolution` 状态机：迟到的合法 bundle 自动提交，可证实未 started 才自动重派；其余只允许已认证用户选择“已核验副作用 / 放弃本次 / 明示风险后重试”，记录不可变 resolution fact、绝不伪造 RunRecord。conversation 解析后解锁；job 解析前暂停该任务，期间用户任务到期只记 missed、不补跑，幂等系统维护任务至多合并一批。
3. run 内部权威写没有与 RunCommitBundle 共享事务边界

   新增的 `SessionStatePort / GlobalStatePort` 允许 runtime 在 run 内写 task-list、memory、schedule、skill usage 等内部权威状态，而最终 CAS 只原子接受 RunCommitBundle。仅靠 `requestId` 幂等不能阻止 run 失败、取消或提交被拒后留下“有内部状态、无权威 run”的半提交，也没有说明这些自写是否推进并冲突 `baseRevision`。

   解决方案：增加 assignment-scoped `AuthorityMutationJournal` 与 staged overlay：run 内读己之写、外界只见 provisional；内部权威写集摘要进入 RunCommitBundle，由 owner 协调会话域与锚点域在最终提交后幂等发布，失败/取消丢弃，uncertain 随裁决收束。文件、外部 API 等不可事务化副作用继续走现有账本与 uncertain 语义。
4. 权威服务端口只有设备认证，没有最小权限授权

   §4 的权限快照由 executor 自己执行，§5 的权威端口只要求请求绑定 run/assignment/epoch/requestId；已配对或被攻陷的 executor 仍可绕过本地安全管线，直接调用其他 conversation 的 `SessionStatePort` 或任意 `GlobalStatePort` 方法。mTLS 证明“哪台设备”，不能证明“本次 assignment 可做什么”。

   解决方案：派发时签发独立的短租约 `AuthorityCapability`，绑定 executor、execution scope、conversation/job、允许的方法与资源范围、epoch、assignment、expiry；owner/anchor 在端口服务端逐次验权并审计，进程内 adapter 也走同一 guard。补跨会话访问、越权全局写、重放与吊销测试。
5. credential “ready”不能证明执行环境语义等价

   CapabilityDescriptor 只声明 provider/MCP 凭据已就绪；两台 executor 可能用同一配置 id 登录不同账号、tenant 或权限范围，路由器却会把它们视为等价。这样既无法兑现“机械证明与单机版能力等价”，也无法在多账号场景判断应选哪台设备。

   解决方案：增加不含秘密的 `CredentialBindingDescriptor`：稳定 binding id、服务/资源 id、可核验的 principal/tenant/scope 指纹与 revision；无法从服务核验时使用用户确认的别名并禁止自动视为跨设备等价。`EnvironmentRequirement / ExecutionManifest` 按 binding 匹配，秘密仅由 executor 本地映射；多 binding 且语义不足时询问用户，不按“ready”猜账号。
6. “系统密钥库”缺少无头常驻设备的后端与既有凭据迁移路径

   §4/§10 要求所有秘密只进系统密钥库，但当前权威规格和实现明确以明文 `credentials.json` 为唯一入口，并曾因 headless Linux 无 DBus/keyring 而拒绝 OS keychain。24×7 VPS/systemd 服务还必须在无人登录后自动重启；直接改用桌面 keyring 会让 `ready` 与自恢复互相冲突，实施 DAG 也没有迁移节点。

   解决方案：在 S2 前冻结统一 `SecretStore` 端口并由产品自动选后端：桌面设备用系统凭据库，无头托管服务用平台服务可解锁的机器绑定 keystore/加密 vault；`ready` 显式包含可解锁状态。提供 `credentials.json` 一次性、可回滚、校验后清退的迁移流程，秘密仍不进入网格、备份与迁居流。
7. §5 权威矩阵的表格结构、计数与顺序不一致

   §5 仍写“五类归属”，实际已有六类；“会话内容资产”又被空行隔成无表头的孤立 Markdown 行，并落在“非权威缓存”之后，渲染与语义分组都错误。S0 要冻结该矩阵，当前结构会污染后续 schema 与验收清单。

   解决方案：合并为一张合法的六类权威矩阵，把“会话内容资产”紧跟“会话状态”放置，并增加 Markdown 表格结构与权威类别计数检查。

8. §14 没有给新增核心构件明确的实施节点归属

   `RunCommitBundle`、`ExecutionScope=job`、会话内容资产存储和 `ResourceGovernor` 已成为正式架构构件，但 §14 仍沿用旧节点描述。实施序列是依赖与开放能力的承诺；构件无明确归属会导致重复追问、漏实现，或在保护机制落地前提前开放跨机能力。

   解决方案：S3 明确落 `ExecutionScope=conversation|job`、`RunCommitBundle`、Run/JobJournal、账本与栅栏状态机；S4 随 `CapabilityDescriptor` 落 `ResourceGovernor` 核心、executor 硬容量与容量短租约，保证 S5 跨机派发前已有准入保护；S6 落会话内容资产 CAS、上传先于提交、授权/续传/生命周期；S7 只负责 scheduler、advancement、编排等消费方接入既有 job 与治理协议。

---

## 已排除问题

- 什么问题：按 `_temporary-agent-dialogue-2026-07-09.md` 的临时说明立即删除历史对话文件。
  为什么排除：用户已明确要求该历史文件保留到其另行下令；删除也不属于本轮架构设计问题，文档自述不能覆盖用户当前明确指令。
- 什么问题：数据面直连 executor 会绕过 owner，形成第二权威。
  为什么排除：文档已把准入、会话写与最终提交固定在 owner，直连只承载持票据的 provisional 数据流；路径与权威已结构性解耦。
- 什么问题：离线本地会话天然造成双写和全局状态分叉。
  为什么排除：本地域与锚点域 ID 空间不相交，且本地域物理剔除全局写能力；重连只经 AuthorityTransfer 收编，不存在同一对话双 owner。
- 什么问题：真实副作用无法随 RunRecord 原子回滚，因此架构方向不可行。
  为什么排除：文档已明确区分“记录未发生”和“世界未发生”，以 executor 账本、uncertain 和禁止盲目重派诚实收敛，这是分布式 agent 可达到的正确语义。
- 什么问题：没有 run 内断点续传属于架构缺口。
  为什么排除：需求与架构已明确机制边界是完整 run；当前用耐久账本保证 run 间恢复，run 内断点会侵入模型与工具状态，首版不引入是合理边界。
- 什么问题：应立即设计多 executor 负载均衡策略。
  为什么排除：当前必须补的是容量保护与公平准入；多匹配时已有稳定选择顺序，负载均衡策略可在真实同质 executor 场景出现后替换，不应提前固化。
- 什么问题：凭据不随迁居自动同步会破坏单一产品体验。
  为什么排除：秘密不经网格迁移是正确安全边界；`paired → configured → ready` 的同一 onboarding 流程已把目标设备补齐凭据纳入产品闭环。
- 什么问题：现在就必须定死 ResourceGovernor 的具体队列算法和每个数值阈值。
  为什么排除：两级治理、统一入口、预算维度与瞬时容量独立公告已经确定架构边界；具体公平队列、权重和阈值应在 S0/S7 spec 用基准与压力测试标定，不构成新的架构方向问题。
- 什么问题：时钟偏斜使票据和短租约方案本身不可行。
  为什么排除：owner 时间权威已经定案；协议层用 owner `issuedAt + TTL` 在接收端换算本地单调时钟 deadline，并设最大可接受偏斜即可机械闭环，不需要改变架构。
- 什么问题：`pendingPostTurnControl` 不进入 RunCommitBundle 会丢失权威状态。
  为什么排除：它是只属于发起 surface 的导航/控制意图，不是会话事实；应作为耐久 run stream 的定向终态帧按 cursor 续传，放进权威 bundle 反而会造成错误归属。
- 什么问题：必须在架构文档中锁死具体密码算法、密码套件和第三方库。
  为什么排除：PAKE、TLS 1.3、双向认证、票据与 fail-closed 的安全性质已定；具体经审计算法与库属于 S2 协议规格和供应链评审，不应在总架构中固化实现。

---

## 用户使用的提示词

```
你作为架构者，现在来进行这个架构的自审。判断它是否是最优架构？是否是好的产品？用户是否好用？这个架构是否到了可执行阶段？：   

只审查，不动手修改；                                                                                                                                                                                                     
                                                                                                                                                                                                                    
以顶级产品经理、顶级架构师、顶级智能体专家的身份思考，以"首席产品官 +乔布斯直觉判断；想法是否能经得起时间的检验，在未来仍然是好的产品吗？是顶级产品和架构吗？                                                       
注意宏观视角看整体架构、要可维护、可扩展、可插拔，需要最佳代码实践方案                                                                                                                                              
我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计；                                                                                                                    
要回归到产品需求本质、要经得起时间的检验、在未来仍然是好的产品；                                                                                                                                                    
                                                                                                                                                                                                                    
注意：                                                                                                                                                                                                              
1、先穷尽枚举全部核查对象与路径(状态、入口、维度清单),再对整体——包括本轮自己刚改动的部分——做一次性全量审查与裁决:问题一次找尽、结论基于全量事实一次定死;                                                            
绝不按"最新改动点"做增量审查,绝不产出留给下一轮的问题或以后会翻的结论。                                                                                                                                             
2、回复风格为“言简意赅”，直接说重点，不要说低价值信息；
```

```
任务：完成一轮审查；

你作为执行者再次去理解并审查架构设计。只审查，不能直接修改架构； 
你的意见非常重要，因为最终执行是由你来完成的，所以你必须得理解和认可整个架构设计，判断它是否是最优架构？是否是好的产品？用户是否好用？这个架构是否到了可执行阶段？你是否还有执行的疑惑等等，你都需要给架构者说明白。

发现问题收集进入“架构审查问题收集”文档，这个问题必须真实，绝对不能和文档中已发现的问题重合，否则你审一辈子都审不完了。
排除的问题进入 “已排除问题”列表，避免下次再在这个问题上耽误时间；

一轮审查的结束条件：
直到除了收集文档中已有的问题，找不见新的问题，这轮审查结束，直接回复简要信息

审查标准： 

以顶级产品经理、顶级架构师、顶级智能体专家的身份思考，以"首席产品官 +乔布斯直觉判断；想法是否能经得起时间的检验，在未来仍然是好的产品吗？是顶级产品和架构吗？
注意宏观视角看整体架构、要可维护、可扩展、可插拔，需要最佳代码实践方案
我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计；
要回归到产品需求本质、要经得起时间的检验、在未来仍然是好的产品；

注意：
1、审查前先建立并逐项扫完固定核查矩阵：状态面、入口面、消费方、生命周期、异常路径、安全边界、模块边界、测试验收；问题先收集并去重，不得沿“最新发现的问题”做邻近扩散式增量审查。不允许发现问题就提前收口；直到矩阵全部扫完再统一裁决。
2、回复风格为“言简意赅”，直接说重点，不要说低价值信息；

执行纪律：看到“先建立并逐项扫完固定核查矩阵”“不允许发现问题就提前收口”“不得增量审查”，必须按硬流程执行，绝对不允许嘴上认可、行为上还是被单个问题牵着走。

严禁被单个问题牵着走；
```

---

```
请检查收集的问题文档中每个问题
1、问题你是否认可？
2、问题的解决方案，是否为你作为执行者认为的最优解。如果不是最优方案，请修改，但必须精简，不要长篇大论。
```

```
请检查收集的问题文档中每个问题
1、问题你是否认可？
2、问题的解决方案，是否为你作认为的最优解。如果不是最优方案，请修改，但必须精简，不要长篇大论。
```

```
请检查收集的问题文档中每个问题问题的解决方案，是否为你作为执行者认为的最优解。
如果不是最优方案，请修改，但必须精简，不要长篇大论。
```

---

```
执行者又发现了一些问题，都放在了这个文档中“架构审查问题收集”；
作为架构者，你看一下这些问题是否真实？你是否认可？
如果你认可的话，对每一个问题都给出你作为架构师的最优解决方案，
要足够精简，不要长篇大论，
用文本的形式直接回复我，不要修改。
你的这个方案是要给执行者说的。
```

---

```
这是架构者对所有问题的分析以及方案
你看一下是他的方案更好，还是你的方案更好？或者结合两个方案的优点给出更优的版本
如果得出更优的版本，把最新方案更新到问题收集列表中；不需要维护多版本记录，只关注最新方案：
```

---

```
执行者结合你给的信息，更新了收集的问题列表。你看一下最新的解决方案，是否认可？认可的话由他来执行。
```

---

```
行，那你把问题收集列表清空一下，我们准备开始下一轮问题搜集。
如果一整轮没有发现任何问题，那审查阶段彻底结束，准备开始动手实现；
```

---
