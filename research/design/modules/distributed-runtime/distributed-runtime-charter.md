# 知行分布式运行时架构总纲

> 需求原话与信息核验见：[持续在线与本地执行：需求与信息核验](./always-online-and-local-execution-requirements.md)。字段级可执行规格由 S0 产出的正式 spec 承载，本文只承载方向、不变量与实施序列。

## 当前版本交付原则（所有实施单元的最高优先级）

本模块当前版本必须以最短时间交付**最小完整产品范围**：只完成本总纲、执行规格和当前单元明确要求的核心能力及其不可缺少的直接依赖；这些核心旅程必须真正可用且具有优秀产品体验，正确性、安全性、耐久性和诚实状态不得妥协。“最小”限制功能范围，不降低范围内质量。

“最优架构”只指锁定范围内最简单、完整、可维护且不留已知结构债务的实现，不得解释为功能最大化、无限防御或为后续单元预建通用设施。任何新增事项必须同时证明权威来源和当前必要性：不做会阻断当前核心旅程、明显破坏既定产品体验或违反已冻结合同。不能证明者——包括非核心增强、未来能力、纯观测/benchmark、诊断平台、推测风险和仅为验收形式服务的基础设施——一律排除或后置，不得成为开发、审查或提交门禁。

单元内发现真正缺失的产品需求时交由用户确认；锁定产品范围内的架构选择自主取最优解。核心范围完整、体验达标、P0/P1 清零并取得必要且成比例的验证后立即结束，禁止以“更完美”为由继续扩面。

## 一、架构概况

知行当前是"核心宿主单例 + 多接入面"架构：权威状态、完整 runtime 与真实执行环境共同位于同一台设备，各类接入面只连接核心宿主。

知行要演化为"常驻权威锚点 + 分布式完整执行宿主"——两者是**同一个知行在不同设备上承担的角色，不是两个产品或两个版本**；且两种使用形态平权：只在一台电脑上部署使用是一等需求，"随时在线 + 电脑无法常开"同样是一等需求——单机部署即两角色同机、分布式即角色分居，部署形态是配置，产品不分叉，单机用户不为分布式付任何代价。

交付形态（硬性产品原则，与本节架构不变量互为表里——"owner 是角色不是物理设备"在用户面前的投影就是"角色是配置不是版本"）：**单一产品、单一安装包、角色经配置与配对自动组合**。用户在任何通用计算设备（电脑 / 服务器 / 常开主机）上安装的都是同一个知行：只装一台即单机全能力；需要随时在线，则在常开设备再装同一个包、与工作电脑配对，内部自动分工——用户永远不面对"服务端版 / 节点版"的选择。三条派生纪律：① 产品入口唯一 ≠ 内部网络入口唯一——包内锚点、owner、执行宿主、双平面路径的边界照旧，未启用的角色不启动、不加载、不监听；② **配对是第二个开箱瞬间**——必须是一次手势级体验（一条命令 / 扫码级），配对流程若要求用户理解密钥、端口、角色概念，单一产品原则即告失败，此为验收级体验标准；③ **受限平台例外提前声明**——手机等不可自主部署的平台是接入面客户端（app），只连接、不承载锚点与执行宿主角色；"同一个包"仅适用于用户可自主部署的通用设备，防止原则被教条化。

角色与权威边界：**统一不变量——每个对话任一时刻恰有一个权威 owner，对话的输入准入与串行、权威状态、RunRecord 提交必经其当前 owner**。锚点是默认 owner，同时是记忆、全局任务与调度登记、耐久投递队列等全局域状态的唯一权威（全局域永无 owner 转移、无例外），自身不执行任务。执行宿主运行完整的知行 runtime，在对应真实环境中完成整个 run，并将结果交回该对话的 owner 提交（默认即锚点），不形成第二份权威状态；任务按环境依赖选择执行宿主，目标设备离线时可靠排队，上线后按定案②的语义续跑；锚点所在设备可同时运行一个普通执行宿主，承接不依赖特定环境的任务。

双平面拓扑（正式架构构件）：owner 垄断的是权威状态与提交权，不是字节路径。控制面——turn 准入与串行、RunRecord 提交、会话权威状态读写——必经该对话的当前 owner（默认即锚点）；全局任务与调度登记属全局域，恒经锚点；数据面——流式输出、工具事件、确认交互——就近传输：接入面与执行宿主同机或同网时直连执行宿主，owner 接收权威提交与事件镜像。不变量以路径性质表述：**存在安全直连路径时，数据面必须就近直连，不得强制绕锚点；无法直连（第三方通道、隔离网络中的远程接入面）时由锚点中继——中继只是传输兜底，控制面与权威语义不变**（不以"局域网毫秒级"这类乐观场景作论据，锚点可能位于 VPS；本机接入面与本机执行宿主恒可直连，单机体验目标由此结构性保证）。数据面直连使执行宿主成为接入面的第二个连接对象，其身份认证、绑定发现、断线语义属于核心架构，正式设计必须闭环，且认证信任必须复用交付原则中同一次设备配对所建立的信任，不另立第二套凭证体系。产品体验目标：用户坐在电脑前经终端（或未来桌面客户端）使用时，交互体感与单机版一致——流式回显、工具事件、确认往返不绕远端锚点，输入准入仍经该对话 owner 的一次轻量往返（定案④）；飞书等第三方通道经其服务器连锚点，结构本就如此，不受影响。

三条决定架构性质的边界：① 拆分对象是"权威态与执行体"，不是"大脑与工具"；② 跨机交接的机制粒度是完整 run（任务只是路由语义，见定案①），不是单次工具调用——执行侧必须是完整 runtime，不是命令代理；③ 权威与传输路径解耦——控制面经该对话的当前 owner；数据面可直连必直连、无法直连时锚点中继。锚点的部署位置（自有常开设备 / 自有 VPS）属于隐私与部署策略：默认本地优先，不在架构层定死。

**核心问题定案**（机制细化见第三部分，不再重开方向）：

① **交接粒度——机制单位是 run，任务是路由语义**：对话的当前 owner（默认即锚点）每次派发一个已准入的输入，执行宿主完整跑完一个 run 并向该 owner 提交；"任务"不做机制单位，它经环境依赖标签把自己的每个 run 路由到同一执行宿主——任务亲和是派生结果，不是机制承诺；任务级编排状态（如推进会话）随对话归其 owner，全局任务与调度登记恒在锚点。

② **续跑语义——重派必须区分"记录未发生"与"世界未发生"**：run 级原子性只约束会话记录，文件改动、外发消息、外部调用等真实副作用不可回滚，自动重派不得跨越这条线。机制：对话 owner 派发时分配稳定 runId，执行宿主本地持久记账（已接收 / 已开跑 / 已完成 / 已提交），完成的提交整包（RunRecord 及 owner 接受所需指令）留存至 owner 确认；续跑按账本三分——已完成未提交的只重新提交原结果（提交按 runId 幂等，绝不重执行）；可证实未开跑的才重新派发；结果不明的进入"执行结果不确定"态，如实呈现给用户、经核验或裁决后才继续，绝不盲目重跑。仍不存在 run 内断点续传。

③ **锚点不可达——权威不变量是"每个对话任一时刻恰有一个 owner"，锚点是默认 owner 而非一切对话的唯一可能 owner**：既有对话（owner = 锚点）在本机只读、不可写——这不是独立规则，是统一不变量的推论（写必经 owner，owner 不可达即不可写）；本机可新开"本地会话"，其 owner 即本机执行宿主，准入与提交就地经本机 owner——同一不变量、零特例；收编完成前本地会话仅在其出生设备可见可用，对话全局名录的权威在锚点。重连收编是一次正式的权威转移——原子交接、旧 owner 即刻失效，复用"任一 conversation 任一时刻只能有一个 owner"的既有硬约束。离线本地会话拥有完整的会话域（transcript、窗口及会话附属状态），但不拥有任何全局域；记忆、全局任务与调度登记等全局域状态的权威恒在锚点、离线期间禁产（全局动作显式不可用或留作待收编意向），收编后由锚点按正常路径补蒸馏 / 登记。单机形态锚点同机，此问题结构上不存在。

④ **本机输入路径——准入恒经该对话的当前 owner，高频流恒直连**：输入是控制面事件，恒先经对话 owner 完成准入与串行（默认 owner 即锚点，一次轻量小消息往返；离线本地会话的 owner 就在本机，同一规则、路径就地），owner 把 run 派给执行宿主；自此该 run 的流式输出、工具事件、确认往返在接入面与执行宿主之间直连，owner 只异步接收 RunRecord 提交与事件镜像。"不绕锚点"指高频数据流，不含准入——歧义就此关闭。

## 二、凝练后的需求点

1. 单机本地使用与“持续在线 + 工作电脑执行”是两种平等的一等需求：用户既可以只在一台电脑上完整部署和使用，也可以在工作电脑无法常开时让智能体持续在线，并在电脑在线时使用其真实工作环境完成任务。
2. 本机第一方接入面（当前终端、未来桌面客户端等）必须保持自然、高效的交互体验，不得因支持持续在线而产生不必要的远端往返或明显体验降级；飞书等第三方接入面则遵循其平台服务器不可避免的网络路径。
3. 为满足上述需求可以调整或重构架构，但现有各模块的业务需求与用户价值必须保持不变。
4. 用户在可自主部署的设备上始终安装同一个知行产品包；本地与云端的角色分工由系统通过配置和配对自动完成，不向用户提供“服务端版”“节点版”等产品分叉。

## 三、架构基线设计（S0 输入）

> 遵循第一部分全部定案与第二部分四条需求；基线为当前代码（unified-core 阶段 A/B 已是现状）。

### §1 架构结论

本设计是 unified-core 终态的推广：把"核心宿主"分化为**锚点（anchor）**与**执行宿主（executor）**两个角色，加一层**设备网格（mesh）**让角色跨设备分布。单机部署 = 两角色同进程装配（即今天的核心宿主），分布式 = 角色分居 + 网格互联；代码路径同一，无单机特判分支——单机是拓扑退化，不是产品分支。

### §2 角色模型

owner 通用规则（锚点域与本地域同样适用）：控制面智能（推进准入分类、裁判、收场合成）随对话 owner、以 owner 所在设备的本地凭据调 LLM，不算任务执行——调用经 contracts 的 `ControlCompletionPort`（实现由组合根注入，调用携带 reservation / abort / deadline），凭据只留 owner 设备 SecretStore。

- **anchor（锚点）**：owner 默认宿主 + 全局域权威 + 渠道与调度宿主 + 网格中继；锚点不执行用户 run。
- **executor（执行宿主）**：接收派发，以**完整知行 runtime**（工具面、权限管线、段切换、生命周期钩子与单机版同一装配）在本地环境跑完整个 run，经耐久账本提交；内含本地域 owner 实例（§9）。
- **surface（接入面）**：既有 cli / 渠道 / 未来桌面端与手机 app；控制连接恒连对话 owner，数据连接凭票据接执行宿主（§8）。

### §3 包与依赖边界（无环依赖图）

```
contracts（core 内新增模块：run / owner / executor 端口、SessionStatePort /
GlobalStatePort / EnvironmentPort / WorkspaceBindingAdminPort / WorkspaceBindingRecoveryPort / WorkspaceBindingMigrationPort / ResourceReservationPort / ControlCompletionPort、
协议 schema——纯类型）
   ↑                    ↑
rpc（新包，自 server 抽出：   mesh（新包：设备身份、配对、认证连接、
无业务传输原语）              地址簿、直连与中继——零业务语义）
   ↑                    ↑
owner-kernel（新包，自 server 抽出：ConversationManager、RunJournal、
准入串行、ExecutorSelector——经 RunExecutorPort 派发，不知执行体位置）
owner-services（新包，自 server 等价抽取：advancement 等会话域控制服务——只依赖
contracts 与 core 领域能力，经 SessionStatePort 访问会话、经 ControlCompletionPort /
AdvancementReviewerPort 调用控制智能，无部署语义；不 import cli / providers /
orchestrator / runtime-host——端口实现居 runtime-host / orchestrator adapter，
由两个组合根注入）
runtime-host（新包，自 cli 下沉：复用 orchestrator 完整装配，不持权威状态）
   ↑                    ↑
server = anchor 组合（owner-kernel + owner-services + mesh + 渠道 + 调度
                    + 资产同步服务端 + 中继）
executor = 新包组合（runtime-host + mesh + 执行账本 + 数据面服务端 + 资产同步
                    客户端 + 本地域 owner-kernel + owner-services 实例）
```

**server 与 executor 禁止互相 import**（依赖图 lint 验收）。cli 是唯一产品入口与 composition root，按角色记录动态加载；单机形态下进程内端口与跨机 mesh adapter 接入同一状态机与执行内核。

### §4 设备网格与安全协议

- **信任模型**：home 采用"用户持有的离线恢复根 + 可轮换的锚点签发权"；每设备持有自己的密钥对。配对：二维码携带高熵一次性秘密、短码走 PAKE——均限时、单次使用、防重放防爆破。配对是全系统唯一信任根：控制面、数据面、中继、资产同步的全部凭据由它派生。信任生命周期由耐久 `HomeTrustRecord`（homeId、trustEpoch、当前锚点签发者、恢复根授权链与吊销状态）承载：恢复根在首次启用网格能力（首次配对 / 加密备份 / 迁居）时于同一引导流中生成、强制保存并回读验证后才开放该能力——单机开箱不生成、不展示任何恢复概念；计划迁居由目标锚点生成新签发密钥、当前签发者写入单调可追溯的 `TrustTransition`，设备重放信任链后只接受新 trustEpoch、旧签发者永久失去签发资格，只有链不可验证时才重新配对；灾难恢复由恢复根签发同一 transition。恢复包轮换 / 丢失 / 泄露、旧签发者拒绝、离线设备追赶与迁居回滚纳入 S2 / S9 测试与零认知旅程。
- **传输**：全部跨设备连接 TLS 1.3 双向设备认证；非锚点设备维持出站隧道（不要求入站开孔）；局域网走认证直连，跨 NAT 走端到端加密的锚点盲中继（中继不可读内容）。版本握手沿 protocolVersion 先例：协议不兼容禁写、进只读降级。
- **票据**：owner 签发、可续连、可吊销，绑定 `runId / ownerEpoch / surfacePrincipal / executorId / scope / expiry`。
- **权限分发**：执行侧安全管线消费**签名、版本化、run 域短租约**的信任规则快照——快照本体经内容寻址资产同步分发，派发只携 run 域租约与摘要引用；快照过期或控制面断线即 fail-closed——仅已认证的原始接入面可逐次授权，否则拒绝；持久授权（allow-session / global）必须回锚点落定。**设备身份与"用户在场"的 surface 身份严格分离**：配对设备不自动等价于"有人在本机确认"。
- **权威能力票据**：派发时随 assignment 签发短租约 `AuthorityCapability`——绑定 executor、ExecutionScope（conversation / job）、允许的端口方法与资源范围、epoch、assignment、expiry；owner / anchor 在端口服务端逐次验权并审计，进程内 adapter 走同一 guard——设备认证证明"哪台设备"，能力票据证明"本次 assignment 可做什么"，跨会话访问与越权全局写由此结构性拒绝。
- **秘密纪律**：provider / 渠道 / MCP 凭据与设备私钥只经统一 `SecretStore` 端口存取、只存各自设备，永不进入网格消息、同步流、备份与迁移流。

### §5 权威矩阵与执行清单

六类归属；**"非秘密"不自动等于"锚点权威"**：

| 类别               | 权威                   | 内容                                                                                                                                                                |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局状态与期望配置 | 锚点                   | 记忆域、全局任务与调度登记、耐久投递队列、信任规则、技能库、Rubric 库、渠道注册、workscene 注册、设备与锚点记录、guidance、非秘密运行配置（模型档位、能力表、策略） |
| 会话状态           | 对话 owner             | transcript、run / control 权威记录、turn 序、conversation meta（含 task-list 状态、segment metadata）、advancement 控制日志、RunJournal 与派发状态、推进会话        |
| 会话内容资产       | 对话 owner             | run 产物与附件的权威索引、可用性与生命周期；内容按摘要进入 owner 治理的内容寻址存储，executor / surface 仅持暂存或可丢缓存                                          |
| 环境事实与本地秘密 | executor 设备          | workspace 真实路径与内容、本机凭据、本机能力事实                                                                                                                    |
| 执行资产           | 锚点权威、内容寻址同步 | 技能、Rubric、prompt 资产、规则与配置快照                                                                                                                           |
| 非权威缓存         | 各持有者               | 注意力窗口运行态与各类窗口快照、窗口热缓存、只读副本、资产缓存——可丢弃、可由权威事实重建                                                                          |

每类归属逐项写明 AuthorityTransfer、删除、保留与备份的覆盖方式（S0 冻结产物）。注意力窗口与窗口快照恒为 transcript 的派生视图（沿 transcript 架构既有裁决）：派发时冻结的窗口快照仅作不可变执行输入，不升级为长期权威，丢失可由权威事实重建或显式降级。

**权威服务端口**：contracts 冻结 `SessionStatePort`（会话域读写，达对话 owner）、`GlobalStatePort`（全局域读写，达锚点）、本地只读 `EnvironmentPort`（环境事实），以及仅目标设备受信管理面装配的 `WorkspaceBindingAdminPort` 与独立的 `WorkspaceBindingRecoveryPort`；后二者不经 mesh 暴露，恢复端口只处理已建档 binding 目录不可恢复的本机灾难恢复，不复用普通 CRUD 权限。单机接进程内 adapter、跨机接 mesh adapter——完整 runtime 内 memory、task-list、技能使用记录等一切权威访问经端口完成，"完整装配"与"executor 零全局写实例"由此同时成立。所有远程写绑定 `run / assignment / epoch / requestId` 并耐久幂等，run 内写经 assignment 域 staged overlay、随权威提交发布（§6），端口每次调用经 `AuthorityCapability` 验权（§4）；会话附属 lifecycle 由 owner、全局 lifecycle 由锚点在权威提交后触发；离线本地会话物理不装配 GlobalStatePort，对应能力明确不可用。

**ExecutionManifest**（随派发、不可变）：精确引用会话基线 `baseRevision`、模型与策略配置版本、全部资产版本与环境要求。**CapabilityDescriptor**（executor 发布、带 revision）：只声明 workspace、工具、MCP、协议与凭据**就绪状态**，不含任何秘密。凭据就绪经不含秘密的 `CredentialBindingDescriptor` 表达：稳定 binding id、服务 / 资源 id、可核验的 principal / tenant / scope 指纹与 revision——无法从服务核验时使用用户确认的别名，禁止自动视为跨设备等价；`EnvironmentRequirement / ExecutionManifest` 按 binding 匹配，秘密仅由 executor 本地映射；多 binding 且语义不足时询问用户，不按"ready"猜账号。开跑前原子匹配当前 revision——缺失、失配或能力变化一律拒绝执行，owner 重排或排队；executor 由此可机械证明自己与单机版能力等价。

### §6 run 派发协议：耐久事务与栅栏

**ExecutionScope = conversation | job**：对话 run 由对话 owner 治理；scheduler 的无对话 agent-turn 是 job——任务侧拆为版本化 `TaskDefinition` 与 append-only `JobOccurrence`，锚点持有 JobJournal，以 `(taskId, jobRunId)` 为唯一键；`JobManifest / JobCommitFence` 绑定 `taskId / jobRunId / scheduledFor / taskRevision / deliverySnapshot / anchorEpoch / assignmentId / executorId / digest`——任务更新只影响后续 occurrence，删除先禁未来触发并取消在途 job（取消结果不明进 uncertain），旧 occurrence 永不覆盖或复活任务定义。job 复用同一执行账本、manifest 与三分续跑，结果原子落入 scheduler 状态与投递队列，不伪造 conversation。下文以 conversation 域表述，job 域同构。

- **控制面入口幂等（run 之前的耐久边界）**：控制请求以**按目标权威分型**的 `ControlRequestEnvelope` 进入——输入、取消与会话写归对话 owner，全局写归锚点；run 域 allow-once 确认由 executor 的 `RunInteractionJournal` 以 `assignmentId / requestId` 治理并镜像 owner（镜像仅供审计与可见性，应答权威恒在 executor 侧 journal），持久授权仍回所属权威；配对与秘密录入走 mesh / 本地 SecretStore 专用流程，journal 只存摘要与不透明句柄。各权威持耐久 `ControlRequestJournal`，状态 `received → applied`——applied 与对应权威变更及响应 outbox **原子提交**；恢复只重驱未 applied 项、已 applied 项回放原结果，保留与 GC 规则随 S0 冻结。run 型输入以 `(surfacePrincipal, ingressId)` 在入队前原子映射到稳定 runId 与准入结果：第一方接入面持久复用 client id 直至确认，渠道使用平台 event / message id；非 run 管理写绑定 `requestId / authority epoch / 领域 revision / payload digest`。响应丢失、接入面重连、权威重启、渠道至少一次重投均不产生第二次准入或第二次生效。
- **owner 侧 RunJournal**（耐久，唯一事实源）：准入、assignment、提交先记日志、再经 outbox 发送；pending 队列随之持久化，锚点崩溃不丢排队任务。每次派发产生唯一 `assignmentId`；重派 = 新 assignment，旧 assignment 的迟到结果被栅栏拒绝。
- **executor 侧执行账本**（耐久，append-only）：`received / started` 先落盘、再产生任何真实副作用；同一 assignment 不得重入；`completed`（= `bundle_sealed`，RunCommitBundle 封存留存）→ `acked`。
- **提交对象是不可变 `RunCommitBundle`**：RunRecord + owner 接受协议所需的 `windowCompact`、内容资产引用、权威写集摘要与 provisional 流的终态 cursor / digest——诊断字段与仅供发起接入面的控制意图不进权威提交。RunRecord 以 `(conversationId, runId)` 原子唯一；提交是**栅栏 CAS**——绑定 `ownerEpoch / assignmentId / baseRevision / executorId / digest`，任一不符即拒绝（迟到结果、旧 owner、旧基线不可能成为权威事实）；owner 以同一栅栏幂等接受整包——CAS 原子提交的只有权威件：RunRecord、权威会话元数据、内容资产索引、权威写发布决定与 RunFinalOutbox；`windowCompact` 仅作幂等缓存更新指令，CAS 成功后应用于窗口 / 快照，失败即丢弃、下次派发前由 transcript 重建，不回滚已提交结果。接受前须确认 bundle 引用的内容资产已耐久可用；全局操作另绑 `anchorEpoch`。
- **状态机**：owner 侧 `queued → dispatched → running → committed | cancelled | failed | expired | uncertain`，另有**正式中间态 `cancel-requested`**——queued 由 owner 原子取消，dispatched / running 进入 cancel-requested 并耐久记录幂等取消栅栏。**assignment 级线性化**：执行账本与 RunInteractionJournal 置于同一 assignment 耐久事务域，统一排序取消栅栏、allow-once 确认接受、每次真实副作用起止与 `bundle_sealed`（封包）——封包先赢则照常提交；取消先赢则拒绝后续确认与一切新动作，以签名 `CancelProof` 收束；owner 取得"未启动或已收束"证明后落 `cancelled`，无法证明则落 `uncertain`。**owner 失联止损**：原始 surface 可持 owner 预签的 `abort` scope 票据直发 `ExecutionAbortRequest` 给 executor——只停止执行、不裁决权威终态，owner 恢复后据账本证明落定。续跑三分（定案②）：completed 未 acked → 只重提交；可证实未 started → 才重派；结果不明 → uncertain，裁决前该对话禁止正常续跑，绝不自动重执行。
- **run 内权威写的事务边界**：runtime 经端口的内部权威写（task-list、memory、schedule、技能使用记录等）落入 assignment 域的 `AuthorityMutationJournal`，以 staged overlay 生效——run 内读己之写、外界只见 provisional；写集摘要进入 RunCommitBundle，owner 在最终提交后协调会话域与锚点域幂等发布，失败 / 取消整体丢弃，uncertain 随裁决收束。锚点域 staged 决定必须在同一 AuthorityCommitLog 临界区内针对精确日志前缀规划并随单次 fsync 发布主读投影；fsync 成功即为不可回退的提交事实，此后不得执行可导致调用方收到失败的元数据 I/O。文件或 runtime refresh 等可失败派生只由权威记录与耐久 checkpoint 重驱，不得改变提交结果。旧 memory 文件只可在开放新权威写之前，由同一锚点日志以耐久 cutover 终态一次接管；接管后不得再参与读取或复活已删除数据。文件、外部 API 等不可事务化的真实副作用不进此机制，仍走执行账本与 uncertain 语义。
- **UncertainResolution（耐久裁决状态机，uncertain 的唯一出边）**：迟到的合法 bundle 到达 → 自动提交解析；事后可证实未 started → 自动重派解析；其余只允许已认证用户三选——"已核验副作用 / 放弃本次 / 明示风险后重试"，每次裁决记录不可变 resolution fact，绝不伪造 RunRecord。conversation 解析后解锁续跑；job 解析前暂停该任务的后续触发，期间用户任务到期只记 missed、不补跑，幂等系统维护任务至多合并一批。
- **最终性**：流式输出恒为 provisional；owner 将 CAS 提交与 `RunFinalOutbox` 原子落盘——RunJournal 保持最终事实源，outbox 只是"权威提交 → 实时通知"的**有界桥梁**：以 `(conversationId, runId, commitRevision, digest)` 向当前已认证的同会话 observer 幂等发布 committed final，不维护逐 surface 耐久确认；外部渠道按 `turnOrigin` 走 DeliveryOutbox，禁止跨渠道广播；断线重连与新 surface 以 last-seen revision 从 owner 历史对账补终态。用户看到的"完成"必须是权威事实；surface 合并流与终态两条通道，按 bundle 封存的终态 cursor 收敛（§8）。

### §7 环境模型与路由

- **两级端口**：owner 由随输入耐久化的显式环境选择、workscene、任务与会话生成结构化 `EnvironmentRequirement`；主模式与无 workscene 会话不得从进程目录或宿主配置暗取默认 workspace。显式选择只携已认证设备发布的 workspace 引用，真实路径必须先在目标设备本地受信入口转换，不能进入控制请求、日志或 mesh。`ExecutorSelector` 只按版本化 CapabilityDescriptor、在线状态与信任范围选宿主。无匹配 → 排队并向用户说明缺口；多匹配 → 稳定策略（显式绑定优先、近期亲和次之）；语义不明 → 询问用户——路由器不得猜测。
- **workscene**：使用设备域稳定 workspace 引用（设备 + 引用名）；真实路径只在目标 executor 的本地受信管理面建立、规范化与校验，远端只选择该设备发布的用户命名工作区，产品界面不得暴露 `bindingRef` 或传递真实路径。场景最近活动只由会话 owner 在实际推进或删除 `SessionMeta` 的同一耐久提交中产生增量活动事实，再派生为锚点侧可重建投影；不得另造 workscene touch 事实源，也不得在查询热路径扫描全部场景或会话。投影滞后只影响排序，不得阻断进出场景。
- **落点矩阵**：正式 spec 附"入口 / 操作 × owner / anchor / executor / surface"落点矩阵，覆盖会话命令、管理命令、compact、调度 ephemeral run、task-list、生命周期钩子、编排——每行一个明确落点，不留"经 dispatch 适配"的模糊表述。
- **advancement 取证**：独立 `EvidenceRequest / EvidenceBundle` 协议——EvidenceRequest 是**签名、短租约、幂等的只读工作信封**：绑定 request / review / 被审 `runId`、当前 ownerEpoch、目标 executor、workspace 引用与 `workspaceBindingRevision`（设备域稳定引用的版本，非文件内容版本）、证据类型与定位摘要、expiry；AdvancementStore 耐久请求状态，executor 以有界幂等 journal 回放同一结果，EvidenceBundle 由 executor 签名并绑定 request digest 与证据摘要。**证据时点由 `observationToken` 承载**：executor 对 locator 范围做一致性观测，bundle 携 observedAt、前后状态指纹与内容摘要——采集中发生变化返回 typed stale，有限重试后保持 deferred；无快照能力的文件系统只承诺"当前状态的可核验观测"，要求历史精确快照时判 unknown / capability-gap，不伪造全局 revision。严格执行 PathGuard 与 binding revision 校验——旧权威 / 过期拒绝，缺失证据不得判通过；由 executor 上受限只读 provider 产证，不复用 run dispatch，不采信执行侧自述。
- **资源治理**：两级 `ResourceGovernor`——锚点做跨来源（会话 / 推进 / 调度 / 编排）的公平准入、优先级与 provider / model / token / 成本预算，executor 做本机 workload 准入与耐久并发配额；实际本机执行批次再经设备唯一容量裁决器取得可丢物理 permit，`ResourceLease` 不占用或替代该 permit。瞬时容量经独立的短租约公告，不进 CapabilityDescriptor（保 manifest 匹配稳定）。治理身份经 contracts 的 `ResourceReservationPort`：顶层 run / job 持根 reservation，编排子节点用其有界子 reservation，推进准入 / 裁判 / 收场与环境管理 / 探测各用独立 control-class reservation，EvidenceRequest 用所属 review reservation 的 executor 侧子 reservation（不挂已结算 run）。**授权凭证是 ResourceGovernor 签发的可验证 `ResourceLease`**——绑定 reservationId、parentId、workload kind / id / attempt、受众（executor / provider / model）、预算上限、epoch、issuedAt / expiry 与 digest；provider 与 executor 以同一 guard 校验签名、层级额度与剩余额度，每笔消费以 `usageId` 幂等扣账、租约最终只结算一次；耐久 ledger 承载 settle / release / expire / reclaim，进程内 adapter 走同一验证——锚点账本、executor 守门与本地 adapter 分别留在各自组合包。**签发按权威域分域**：锚点域根租约由 anchor governor 签发；本地域根租约由设备本地耐久 governor 签发、绑定 `localDomainId / localOwnerEpoch`——只能消费本机 provider / executor 额度、不得授权全局预算，两域复用同一租约合同、层级扣账与 guard；收编不把本地消费追认为锚点预算；离线新 run / 控制调用 / 取证的双拓扑测试随 S4 / S8 验收。全部入口共用同一治理面；单会话保险丝保留。
- **设备本地存储维护治理**：flush、重建、scrub、compaction、迁移、生命周期对账与 GC 不属于用户 workload，不签发 `ResourceLease`、不进入跨机预算账本；独立的 storage governor 与 workload 执行批次必须共用设备唯一的本地容量裁决器，并发槽位、显式工作内存预留、磁盘 I/O 与临时空间只有一份准入真相。CPU 竞争由同一公平队列、并发槽位和有界检查点治理，不作无法可靠归因的任务级硬计量。每个不可分步骤先取得覆盖其资源操作的额度再执行，不能容纳与暂时背压分型；提交前可背压，已提交维护义务只能从 WAL、manifest、写意图、checkpoint 与生命周期记录恢复并续跑，治理队列不得成为第二事实源。

### §8 双平面通信：无损续流与最终性

直连与中继承载**同一逻辑 run stream**：帧携带 `runId / streamEpoch / seq`；executor 先写有界耐久 event spool、再发送；surface 以 cursor / ack 去重续流，路径切换从同一游标恢复，零丢帧零重帧；背压、配额与终态回收显式定义。控制命令均绑独立幂等 `requestId`，按 §6 分型治理——确认应答归 executor 的 `RunInteractionJournal` 并镜像 owner，取消经 owner 记账后下发。大对象（完整窗口、图片、工具产物）走 owner 治理的内容寻址存储（§5）——带摘要、授权、断点传输与生命周期治理，不进事件流。输出流式展示恒标 provisional，committed final 后转正；等待、失败、uncertain 状态对用户明确可见。

### §9 离线本地会话、收编与迁居（统一 AuthorityTransfer）

- **本地域**：executor 内以"本地域"配置实例化同一 owner-kernel——对话 id 空间与锚点域不相交，结构上无双写可能；本地域组合根只接收显式的本地域 owner 合同，物理不装配 GlobalStatePort、全局发布与外部投递能力（by-construction，非运行时检查），并与 executor 复用同一设备 AuthorityCommitLog、ArtifactStore、数据面和容量治理原语，靠独立逻辑流隔离权威事实。**owner 级服务组合可复用**（owner-services 包，§3）：SessionState 域模块（task-list、segment、advancement 会话状态与控制流程）随 owner 装配——本地域会话拥有与锚点域同等的会话域能力，锚点只额外承载 GlobalState 域服务；全局动作不得伪装成功——明确不可用，或经本地域唯一意向 repository 把 schedule 写与 rubric 沉淀记录为标注"尚未生效"的类型化 `DeferredGlobalIntent`，两类 producer 共用同一实例，意向随 conversation owner 迁移；锚点只装配内部 review/decide 接缝，收编后在同一权威事务重校验并提交全局事实与 confirmed，时效性 schedule 必须用户再确认。能力矩阵与 owner 服务双拓扑（锚点域 / 本地域）进测试。锚点域对话在锚点不可达时不可写；**只读副本是可选的非权威缓存，首版可不建**——无副本时明示"无法查看，需连接值班设备"，建则必须显示同步水位、过期与不可写语义。公开离线创建、查询和收编入口只在 transfer/intents 闭合后启用，本地域 owner 底座在此之前仅暴露内部组合与 conformance 端口。
- **收编与迁居统一为耐久 `AuthorityTransfer` 状态机**：双方记录 `transferId / sourceEpoch / targetEpoch / checkpoint / digest`，状态 `prepared → frozen → imported → committed → tombstoned`，另有幂等 `aborted` 终态——AnchorTransferCommit 之前可由当前权威记录耐久 `TransferAbort` 中止：源端保持原 epoch 恢复准入，目标 staging 永久隔离并幂等清理，不要求跨设备原子；commit 之后不可中止，只允许以更高 epoch 正向再迁居，epoch 永不回滚。源端先关闭准入、收束或裁决在途 run；目标幂等导入；只有签名权威记录原子提升 epoch 后目标才可写；旧端凭 fencing 永久拒写并重定向；任意中断按日志重入。
- **当前启用边界**：S8 只启用 conversation 收编分支。源端导出完整会话权威前缀、SessionState 可重建读面、内容资产与 conversation-owned intent；锚点目标按 `transferId` 写 authority-root 私有 staging，全闭包验真后才幂等提升既有共享 CAS，abort 只清私有目录。`ConversationTransferCommit` 与已验证 authority base 在目标同一 `AuthorityCommitLog` envelope 原子发布，sync 后无决定可服务性的发布 I/O；current-owner 准入、候选/用户列表、第一方 session 与会话绑定 confirmation 均逐次消费该耐久边界，跨设备仅经有限认证 relay，旧 owner 永久 fencing。两生产根向 transfer source/target 注入同一设备 storage governor 与 lifecycle abort，容量 permit 不跨网络或权威/store 锁。提交后记忆按 conversation run stream 在同一提交中冻结 discovery 与每个 operation 的规范输入/attempt，再耐久推进 plan/effect/completed；恢复只从该输入集合重驱未完成 operation，完成水位先于 transcript 加载生效。收编复核用同一 requestId 串行接管当前认证 surface，旧 surface 不再可答。transfer wire 结果是按 state 的严格联合，并在 client 分类前与 originating command 全量关联。取证在 journal 与 workspace 读取前复验 current owner；非 anchor 零 target，公开离线入口只接受明确用户确认的本机对话。
- **当前 S9 备份边界**：trusted-home 的 current anchor 或显式启用备份的单机 current anchor 恰一持有全量 checkpoint owner；它从同一 `AuthorityCommitLog` 与同一 `ArtifactLifecycleIndex` 冻结全等 source-head 前缀及仍受保留的注册型权威资产闭包，index 水位变化时整轮重冻，禁止以通用 JSON 扫描补闭包。每日义务与强制接缝用 `(rootKey, recipient, trust chain, target, request, source prefix)` 形成耐久 generation，created→replicated→verified 与同键 single-flight 共用该身份，旧 generation 永不冒充 current ready。唯一 `CheckpointEnvelope.v1` 分块加密到一个物理独立目录或一台 active paired device；当前与历史 target 由耐久 binding 解析，setup 自身形成首份耐久副本，verify 与 startup recovery 始终按 created 冻结的 target 代际重驱。`checkpoint-superseded` 是 source-local 副本的唯一释放事实并由通用 24 小时 GC 消费；独立 target 自该事实起保留 27 天，只以 `target-retired` 终结。configured root 的建立及两类 adapter 的全部 child create/read/write/rename/remove/fsync 必须从 filesystem/drive root 起逐组件锚定 no-follow 句柄并保持 handle-relative，路径替换不得改变冻结物理对象或产生根外副作用。capture 两遍绑定同一 source-head，首遍只形成受固定 header 上界约束的目录，第二遍以 checkpoint 专用 `ChunkSource/ChunkSink` 贯穿 crypto、local CAS、target、transport、verify 与 activation；总驻留只随固定并发 × header/chunk 上界增长。各有界 buffer 与物理步骤复用设备 storage governor 和 owner abort，容量 permit 不跨网络等待或外层权威锁。恢复包只含用户持有的恢复主秘密，输入经共享的无回显 TTY 边界；旧 v1 包只把 trust-only checkpoint 送回既有 S2 activation replay，绝不产生 `fullBackupReady`。公开状态只投影四态、ready 与可行动提示，不暴露内部 id、水位或原始错误；可选目标/config/runtime 故障不得阻断普通业务，home trust/root 身份矛盾仍 fail-stop。checkpoint owner 与 paired receiver 的实际 descriptor 反绑 daily/forced、begin/progress/append/commit/get/range/retire/activate-root exact-set；`activate-root` 只在首次无根有限通道提交或在 active receiver 上 exact replay 同一终态。首次配对仍须在受限认证 onboarding link 上写入、回读并验证首份全量 checkpoint，再激活恢复根和开放业务 mesh。
- **当前 S9 计划迁居边界**：current anchor 可把值班职责迁往另一台已配对、active 且启用 anchor 角色的设备。目标在本机生成并耐久绑定新 issuer key，以 `ReadyProof` 证明当前 trust generation、角色、配置、资产、协议、服务与本地秘密可用；ready 应答须在目标 lifecycle 内形成 transfer 私有、带 expiry 的耐久 reservation，相关 revision 在 source 提交前不得越过该 reservation 漂移。秘密、环境事实、workspace 原始路径和设备缓存永不进入迁移。源端先取得当前可恢复 full checkpoint，再在同一 `AuthorityCommitLog` 写序中安装耐久 fence：fresh 写零追加，fence 前已接受的工作必须按稳定 token 恰一收束为源端终态或 `AuthorityCatalog` 的 canonical pending obligation；closure cursor 与冻结 log head 全等后，同一 source prefix 才可形成 planned export 与 catalog。目标以 transfer 私有 journal/store 导入并全验 export、catalog 与 retained exact-set；共享 CAS 只接受验真后的幂等提升，abort 不得删除共享对象。原 source envelope/LSN 形成不可见 immutable base，当前 issuer 在源端同一 log envelope 写唯一 `AnchorTransferCommit`、prepared `issuer-transition` 与 next epochs；该 sync 后旧端永久 fencing。目标只可前向安装同一 commit，并在本地同一 `AuthorityCommitLog` envelope 原子发布 committed-base pointer、trust/current anchor/epochs/install；全部 authority consumer 只在 pointer 可见后读取同一 composite base。installation 独立投影出不可随私有 cleanup 消失的 installed generation；两个 current-anchor profile 在每次启动及 live install 时，都必须在公开准入前用它统一重绑 runtime epoch、外部 projection/cursor、固定 substrate 与后建 consumer，再逐项回读 pending obligation，禁止默认旧 epoch、仅 flush 或单 consumer reset 冒充完成。target-wide candidate journal 是 remote prepare 与 signed abort 的唯一排序点：完整 prepared payload 与完整 signed abort 互斥耐久；source 已 prepared 而 target 仍 claim-only 时，target 先耐久 authenticated aborted 再幂等清理，过期 proof 或已清 key 不得阻断同身份重放。post-install 与双端 phase 效果均 exact replay，全部完成后才开放服务。两端 chunk I/O 复用设备唯一 storage governor 与 lifecycle abort，网络等待零 permit，stop 栅栏后零新物理效果。current-authority/current-conversation resolver、全部第一方入口及认证 peer 重连消费同一 signed trust record；peer 只允许补齐本次迁居唯一缺失的 issuer transition，不建设持续同步。commit 前签名 abort 恢复原 epoch 与同一 accepted-work owner，commit 后禁止回滚；任意断连、响应丢失和重启按双端日志唯一收敛。生产装配只允许 current anchor 持 source/recovery owner、本次 anchor target 持有限 receiver/recovery owner，executor-only、surface、disabled 及其他非当前设备零迁居 owner。用户管理面只使用“值班设备”与设备名，列表由无 key/staging 副作用的 readiness 投影产生，重名不得猜测或泄漏内部 ID，并在切换前提供取消；灾难恢复、恢复应用、全局连续同步与后续服务生命周期仍未启用。
- **当前 S9 人工灾难恢复边界**：值班设备永久丢失时，只允许另一台 active anchor-role 设备在用户明确选择 directory/paired 完整副本并无回显回读恢复包后发起。目标以 checkpoint-owned inventory 冻结候选，在 target-wide journal 单飞；恢复根真解封并重放 authority/trust 前缀，结合本地及可达 active peer 的签名事实冻结不回滚 baseline，现场签发 verification。已认证 known-peer inventory 在 claim 前冻结 reachability cut；cut 内每个 peer 必须返回从本地已知祖先到其 signed current record 的可验签 exact suffix，任一缺失、冲突或丢响应使本次 attempt 在零 claim/key/import 前失败，cut 与 evidence digest 随 candidate 耐久重放。candidate 的 durable verified 是私有 import 的唯一验证起点；响应丢失或重启只可验真并续写一次 imported，禁止重做现场验证、另建 prepared 事实或更换 transfer issuer key。verified 与 `install-decided` 的 canonical payload 统一写入 candidate 既有 `AuthorityCommitLog.artifactStore`，candidate 日志只保存唯一 `ArtifactRef`；两类 record 是既有 retention 的注册 root，其 payload 与全部嵌套引用在 terminal 后仍无条件保留。同步 reducer 只投影 ref，公开 state 在日志锁外按 verified→decision 严格解引用、校验 digest/length/canonical DTO 并逐级反绑 candidate identity，任何缺失、损坏或错绑都必须先于 import、decision、authority 与 terminal 新效果 fail-closed。ReadyProof 只能来自 planned/disaster 共用的 production snapshot，且全等绑定 request、candidate/baseline evidence、实际私有 issuer key、角色、配置、协议、资产、服务、credential generation 与 SecretStore 回读；同一 reservation 保持到 install 或 authenticated terminal。records、retained exact-set、无秘密 catalog 与 immutable base 全验前只存在于 per-transfer 私有 store；最终 readiness 复验与共享 CAS 提升后，target-wide candidate transaction 在 signed abort 与完整 `install-decided` 之间唯一排序，后者冻结全部 installation entries、commit/installation 与 candidate reference exact-set，并持续占有单飞权。恢复根签名的 disaster commit 随后在目标同一 `AuthorityCommitLog` envelope 原子发布 composite base、next epochs、new issuer/current owner、旧 issuer revoke、旧设备 active exposure 的 compromised 事实及 installation；只有该安装全等回读且 transfer 私有 committed 已耐久，candidate/target-wide committed terminal 才可释放 claim。公开命令以同一 scoped signal 贯穿 inventory/read/prepare/import/commit 与 governor；commit 前取消先在 target-wide candidate transaction 耐久 root-signed aborted，再以 transfer slot 当前 key 的 exact identity compare-delete/read-back 后清私有状态；并发 key creator 必须保留本次 identity，在 recordVerified 前后发现同一 authenticated terminal 时补偿删除，slot 已替换则稳定拒绝。commit 后只前滚，`install-decided` 与 current installation 永久禁止该删除。startup/live 复用同一 installed-generation coordinator，在新 trust 可见后的首个异步等待前关闭 current-owner gate，并在公开准入前重绑固定 runtime owner、projection/cursor、三组 consumer 与六类 pending obligation；只有同一 authority log 中绑定 installation generation、participant 与逐项 read-back 的 durable completion receipt 成立，CLI 才可报告成功并开放服务，失败由 live/startup 重驱。旧 epoch、旧 issuer、旧路由及 compromised binding 永久拒绝。用户确认旧设备已隔离或擦除后才 tombstone。恢复后的 provider/channel/MCP 换密钥只允许 SecretStore 同值回读、有限生产适配的 service-verified principal/readiness 均成立后调用既有 rotation transaction，以稳定 request/revision 同时发布新 active 与旧 rotated；普通 compromised guard 不放宽。恢复码 rotate/invalidate 复用现有 root-activation；丢失只允许 current issuer 与另一台 distinct active device 共同签名的 `domain-reset + establish` 原子计划，co-signer 路径只读加载其唯一既有 device key 与 current signed trust，必须是 distinct active member，禁止创建 key、加载 issuer secret 或写 authority，并把非 issuer 设备置为 pending-reenroll，逐台复用 fresh pairing transcript 重入。单设备或 issuer 与恢复包同时丢失只能重建 home。全过程不做自动升主、持续同步或恢复应用。
- **迁居**：不复制任何设备本地秘密；目标必须先通过就绪预检（§10 ready）；在途 run、pending 队列、调度触发、渠道接管随 transfer 状态机收束或迁移，签发权经 `TrustTransition` 移交（§4）。AuthorityTransfer 与 TrustTransition 分别 prepare 后，由签名 `AnchorTransferCommit` 作为**唯一切换事实**一次提交、同时生效——绑定 `transferId`、checkpoint / 权威目录摘要、源 / 目标、next anchorEpoch、next trustEpoch、目标签发公钥与 ready 证明，由当前签发者（灾难恢复时为恢复根）签发；提交前可中止，提交后只可前滚，旧 `(anchorEpoch, trustEpoch)` 组合被机械拒绝。
- **锚点永久丢失 = 人工恢复根授权的安全域换代**：以用户恢复密钥加密的一致性检查点（周期性备份到用户指定位置或配对设备）恢复；换代包含签发新 anchorEpoch 与证书、重建设备信任、轮换旧锚点持有的全部外部凭据——epoch 只能拒绝迟到提交，隔离分区中仍在运行的旧锚点必须靠凭据轮换与信任换代完成；旧设备隔离或擦除后方可重入。无 quorum / witness 租约，禁止网络分区下自动升主；计划迁居仍走 AuthorityTransfer。

### §10 凭据与服务生命周期

- **秘密只经统一 `SecretStore` 端口存取、只存目标设备**，不经网格同步、备份与迁居。后端由产品按平台自动选择：桌面设备用系统凭据库，无头常驻设备（VPS / 系统服务）用平台服务可解锁的机器绑定 keystore / 加密 vault——`ready` 显式包含"秘密可解锁"状态，与服务自恢复兼容；既有 `credentials.json` 走一次性、可回滚、校验后清退的迁移流程。配对只建立信任；产品状态 `paired → configured → ready`：按目标角色预检 provider / MCP / channel 就绪状态，缺失项由同一 onboarding 流程在目标设备补齐；迁居仅在目标 ready 后切换。
- **撤销与外部凭据收束**：锚点从 CredentialBindingDescriptor 持久化非秘密 `CredentialExposureRecord`（设备 × 凭据实例 × 外部 principal / tenant / scope）。设备撤销时立即吊销网格身份、将其暴露实例标为 compromised 并阻断路由；设备可达则校验本地清退，设备失控则仅在另有可信管理授权且服务支持时自动吊销，否则逐项引导用户在第三方轮换；新 binding 经 revision 核验前不得恢复 ready。
- **托管服务**：单一安装包只为已启用的后台角色注册跨平台托管服务——anchor 崩溃 / 设备重启自恢复；executor 按用户选择在开机或登录后自动上线（"上线续跑"由此成立，不再是文案）；纯 surface 与按需单机形态不额外常驻。当前 launch plan 只由 current signed trust、本机角色选择与既有 SecretStore backend binding 派生；OS definition、future-enabled、current-running 与 readiness 是可独立核验的事实，公开状态只能由同一次 plan/spec 与真实 supervisor/runtime snapshot 投影。配置或信任换代先关闭当前准入，安全停机完成后才收束旧 supervisor instance；同一 canonical home 的全部唤醒进入单 worker dirty-loop，公开 listener 前必须再次全等复验 current plan/spec。纯 surface/空角色只经认证 mesh 把 canonical first-party exact-set 送到 current anchor，本机零宿主、零角色模块、零监听，owner 换代关闭旧 relay 且离线不回退。**停机收束协议分三路径**：临时停机 / 升级——关闭准入、收束在途 assignment、刷稳账本与 outbox 后停机，权威保留；executor 移除——先停止本地域新准入并枚举本地权威（未收编本地会话）：存在时必须先经 AuthorityTransfer 收编 / 迁往目标，或由用户明确确认销毁（加密导出仅作销毁前备份，不能替代 owner）；转移或销毁完成后再停发租约、账本收敛、撤销身份并注销；设备失控时只可如实告知本地数据不可达，不得伪造迁移；anchor 永久卸载——先完成 AuthorityTransfer，或生成并验证加密恢复导出、经用户明确确认。回滚仅允许兼容版本，schema / protocol / epoch 不得倒退；撤销、停用、卸载、诊断、升级与回滚逐阶段做崩溃恢复验收；未启用角色零加载、零监听。

### §11 产品体验设计

用户语言只有两个词：**值班设备**（锚点所在）与**干活的电脑**（执行宿主），不暴露锚点 / owner / 宿主术语。四个时刻（各做零认知验收）：**开箱**——单机安装即用，与今天完全一致，零新概念、零恢复概念；**扩展**——第二台设备装同一个包 → `zz pair` 一次手势 → 首次启用网格时同一引导流生成并保存恢复包（回读验证后开放能力）→ 按提示补齐该设备配置（ready）→ 指定值班设备；**日常**——人在电脑前任务就地执行、体感与单机一致，离线任务诚实排队提示 + 完成通知，`/status` 一句话呈现"知行在 NUC 值班；这台电脑在场，任务就地执行"；联系不上值班设备时提供"继续在这台电脑工作"——标明不可用能力与未生效意向，重连后集中复核；**异常**——结果不确定的工作明确呈现（"有一件工作结果待确认"），provisional 与已确认结果可分辨，绝不静默；设备丢失时提供"撤销该设备"引导流，逐项提示在第三方轮换外部账号。手机是未来的接入面 app，只连值班设备。

### §12 故障矩阵（全枚举，逐行随所属节点进测试）

派发后 executor 崩溃（started 无 completed → uncertain）；completed 未 acked（重提交幂等吸收）；派发 ack 丢失 / 重复派发（assignmentId 栅栏吸收）；owner 崩溃（RunJournal 重放，executor 重试提交，surface 重连）；owner 提交后崩溃 / final 未投递（RunFinalOutbox 幂等重放；离线 surface 重连以 last-seen revision 对账补终态，不滞留 provisional）；提交后、缓存应用前崩溃（窗口 / 快照由 transcript 重建，权威结果不回滚）；取消与迟到确认 / 封包竞态（同一 assignment 事务域统一排序，bundle_sealed 与取消栅栏为唯一胜负点；无收束证明保守判 uncertain）；owner 失联需止损（abort 票据直停执行，权威终态待 owner 恢复据证明落定）；数据面断、控制面在（中继续流，同游标零丢帧）；控制面断、数据面在（可经 abort 票据止损；否则 run 跑完、提交重试、权限 fail-closed）；网络分区（§9 本地域语义）；收编 / 迁居任意步中断（AuthorityTransfer 日志重入；迁居切点由 AnchorTransferCommit 单点生效，权威与签发权的割裂组合被机械拒绝）；旧锚点 / 旧 assignment 迟到提交（epoch / 栅栏拒绝）；锚点永久丢失（安全域换代：检查点恢复 + 凭据轮换 + 信任重建）；账本 / journal 损坏（截尾隔离 + 受影响 run 保守判 uncertain）；磁盘满（写失败 fail-stop，不静默丢）；设备撤销（吊销传播 + 连接终止 + 外部凭据暴露清单收束）；渠道重投 / 响应丢失 / 接入面重连（ControlRequestJournal 回放原结果，零第二次准入）；版本偏斜（握手禁写降级）；时钟偏斜（一切以 owner 时钟为准，envelope 带 owner 时间戳）。

**安全对抗矩阵**（绑定所属实施节点，全部以 fail-closed 自动化测试验收）：配对短码过期 / 重放 / 爆破 / MITM（S2）；证书与票据的签发者、受众、scope、expiry 校验与重放拒绝（S2 / S6）；权限快照版本回滚拒绝、过期 fail-closed、断线语义（S4）；吊销传播时限与连接终止（S2）；盲中继保密性（S2 / S6）；确认应答的原始接入面绑定、旁观面不可代答（S6）；权威端口越权——跨会话访问、越权全局写、AuthorityCapability 重放与吊销（S4 / S5）；ResourceLease 伪造 / 跨任务复用 / 父额度超卖 / 过期与崩溃回收 / 重复扣账（S4）。

### §12.1 S9 首次恢复根与备份状态边界

已有配对设备建立首个恢复根时，source 必须先完成恢复包的无回显回读与严格解码，再以包内 root、recipient 与 checkpoint 身份连接 target；无恢复根阶段只允许 current issuer 经既有认证控制面调用 strict checkpoint service，普通 mesh 与业务服务继续关闭。target 的首个 begin 在既有私有 staging 耐久绑定该身份，同载荷重放幂等、冲突稳定拒绝；checkpoint 回读与 source 原子激活完成后，同一 strict service 只提交与该 checkpoint plan 全等的签名 root event 和 trust record，target 耐久验真后有限通道退役，已激活 runtime 只接受同一终态重放。source 的 originating activation commit 是双端重放的唯一身份；target 尚未提交时，即使 source trust chain 已合法前进，也必须从该提交的同一 authority LSN 验真并重放原 checkpoint、root event 与 trust record，禁止用最新链头或当前 record 替代。恢复备份 readiness 只由 current root/chain/target generation 对应的耐久 created、replicated、verified 与本地 full envelope 投影，目标或 runtime 离线只降低 availability，不得改写 readiness。三个 paired checkpoint client 生产构造点必须注入同一设备 storage governor；网络等待不持 permit，固定 range 的解码与消费受准入并在交付后释放。

### §13 不变量清单（机械可验，进测试）

1. 每对话任一时刻恰一 owner；准入 / 提交必经当前 owner。
2. RunRecord 以 `(conversationId, runId)`、job 结果以 `(taskId, jobRunId)` 唯一；重复提交与迟到提交不产生第二条权威记录。
3. 提交必过所属域的完整栅栏 CAS——conversation 域验 ownerEpoch / assignmentId / baseRevision / executorId / digest，job 域验 JobCommitFence 全字段。
4. 全局域写只发生在锚点进程；executor 进程无全局域写实例（grep 级结构验收）。
5. 未启用角色零监听端口、零模块加载（进程级验证）。
6. 秘密永不出现在网格消息、同步流、备份流与迁移流中（wire 审计）。
7. 直连不可达只改路径不减功能；路径切换零丢帧零重帧（cursor 等价性测试）。
8. 本地域与锚点域对话 id 空间不相交；transfer committed 后旧 owner 拒写。
9. 结果不明的 run 绝不自动重执行；uncertain 未裁决该对话不正常续跑。
10. Manifest 与 CapabilityDescriptor 失配零执行。
11. 执行侧 runtime 与单机版同一装配（同一测试套双形态全绿——能力完整性验收）。
12. 单机路径 = 分布式代码的同进程特例，无单机特判分支（结构验收）。
13. 用户可见的"完成"必为已提交权威事实；provisional 恒有可分辨标注。
14. server 与 executor 包零互相 import（依赖图 lint 验收）。
15. run 内内部权威写经 staged overlay，权威提交前对外不可见；提交失败 / 取消零残留（半提交测试）。
16. 权威端口每次调用必验 AuthorityCapability（scope / 方法与资源范围 / expiry），进程内与跨机同一 guard（越权测试）。
17. 同一 `(surfacePrincipal, ingressId)` 至多产生一次准入与一个 runId；重复控制请求回放原结果，journal 的 applied 与权威变更原子（入口幂等与半生效测试）。
18. 一切用户工作负载必须持有效 `ResourceLease`，验签、层级额度、幂等扣账与单次结算不可绕过；每个实际本机 workload 批次与设备本地存储维护还必须进入同一设备容量裁决器，业务 lease 与可丢 permit 不得互相替代。重试不得重复占用，重启续做必须重新准入；提交前维护可背压，已提交义务必须可恢复并公平续跑。验收覆盖全部 workload 与 maintenance kind，自动任务不得饿死交互任务。

### §14 实施序列（唯一依赖 DAG；基线 = 当前代码；每节点是可独立构建、测试、回滚的终态子集，后继能力不提前开放）

S0 冻结权威矩阵、协议、状态机、包边界与产品旅程（spec 定稿，含 SecretStore、SessionStatePort / GlobalStatePort / EnvironmentPort / ResourceReservationPort / ControlCompletionPort 五端口、AuthorityCapability / ResourceLease 两凭证、RunInteractionJournal 键与镜像边界的契约冻结）→ **S1 同进程角色等价重构**（contracts / rpc / owner-kernel / owner-services / runtime-host 抽包、进程内端口；行为等价，验收 = 全量测试 + 行为快照零差异，不变量 12 / 14 自此成立）→ **S2 设备身份与安全传输**（mesh：配对、TLS 双向认证、出站隧道、盲中继、HomeTrustRecord / TrustTransition 信任链；SecretStore 后端与 `credentials.json` 迁移；不接业务）→ **S3 耐久 run 协议**（ControlRequestJournal 入口幂等、ExecutionScope = conversation | job、RunJournal / JobJournal、执行账本、RunInteractionJournal、RunCommitBundle 与栅栏 CAS、RunFinalOutbox、AuthorityMutationJournal、状态机与 UncertainResolution——先在进程内生效）→ **S4 ExecutionManifest / CapabilityDescriptor（含 CredentialBindingDescriptor）+ 最小资产与权限快照同步 + AuthorityCapability 端口验权 + ResourceGovernor 双半边（anchor 准入 / 预算 ledger + executor 硬容量与容量短租约）与 ResourceLease 签发 / 结算——跨机派发开放前准入与验权保护已就位** → **S5 跨机控制面**（派发上网格）→ **S6 无损数据面**（spool / cursor / 票据 / provisional-committed；surface 双通道合并与终态收敛；会话内容资产 CAS——上传先于提交、授权 / 续传 / 生命周期治理）→ **S7 模块接入**（environment 路由、workscene 设备域引用、scheduler / advancement / 编排接入既有 job 与治理协议、取证协议、落点矩阵兑现）→ **S8 离线本地会话与收编** → **S9 迁居与备份恢复** → **S10 服务生命周期、升级与发布**（含三路径停机收束协议与回滚兼容验收）。故障矩阵行与量化体验阈值随所属节点同时验收。

### §15 验收纲

体验：S1 后单机全量测试与行为快照零差异；"配对 → 恢复包 → ready → 指定值班"是一条零术语引导流，零认知走查通过；离线排队提示、完成通知、uncertain 呈现、离线继续工作与收编复核、设备撤销与外部轮换旅程零认知走查通过。结构：不变量 1–18 全部自动化验收。故障与安全：§12 故障矩阵与安全对抗矩阵逐行有测试。产品：全程只见"值班 / 干活"语言，不暴露拓扑术语。性能观测只用于按需诊断，不得替代功能验收，也不得成为开发单元的同步阻断门禁。
