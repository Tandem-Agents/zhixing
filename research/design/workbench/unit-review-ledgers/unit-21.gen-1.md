# 单元登记:第 21 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:21
- **generation**:1
- **登记时间**:2026-07-23
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 21 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、分片账本、九类核查面行、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成；同一交付物两轮冻结终审与全部必要验证通过
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是
- **交付物文件集**:31 个非工作台交付文件：core 流合同、executor 耐久 spool、orchestrator 异步生产背压、CLI worker/mesh adapter/统一耐久义务重试与 guidance 生命周期等待、owner 类型边界、结构 golden 与架构执行文档；工作台文件按静态规则不计入交付物
- **当前交付物指纹**:`sha256:9b73042d727f41f5d982a5f91ed51459b48b2ebbfd57761f506a30b366dc74b0`
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的双平面拓扑与 §8 数据面；`research/design/modules/distributed-runtime/specification.md` 第 21 单元与 §5.6 run stream

## 固定边界

- **功能范围**:落统一 StreamFrame、assignment 级连续 seq、streamEpoch fencing、数据帧摘要链、provisional-final、耐久 spool、逐消费方 ACK/回收与有界背压
- **架构不变量**:帧先耐久后发送；seq 跨连接与路径连续且唯一去重；streamEpoch 只栅栏旧连接；摘要只覆盖规范数据帧；收尾帧、bundle 与 ACK 水位一致；慢 observer 不拖停 run 或快消费者
- **验收条件**:直连/中继路径切换、空流、逐字段篡改、final 三值核对、ACK 丢失、慢 observer 隔离、崩溃续流均满足零丢零重与有界资源合同
- **必要上下游**:第 20 单元认证 mesh 控制面；executor assignment ledger；SealedBundle.streamFinal；既有 AgentYield、SessionEventProjection 与 interaction assignment 记录
- **明确不属于本单元**:第 22 单元数据面票据及确认/abort 权限；第 23 单元 surface 内容资产；第 24 单元 owner-relay、渠道确认、路径降级与无损数据面最终启用；任何后续业务模块接入

## 审查分片

- **是否启用**:是
- **决定依据**:本单元同时改变 wire 合同、耐久状态机、跨连接传输与生产者接线；任一闭包遗漏都会造成丢帧、重帧、摘要失配或无界阻塞
- **完整单元与跨切片必审项**:同一逻辑帧从生产、spool 先写、路径发送、重连重放、消费 ACK 到终态回收全链；seq/epoch/digest/final 四者一致；本地与 mesh 适配器同合同

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |
| S21-A 流合同与摘要 | StreamFrame 运行时验证、连续 seq、摘要链与 provisional-final 三值合同 | 第 20 单元完成基线 | 冻结终审 | 已完成 | 非局部封版 | 单一 prepare/validate/materialize 合同与摘要、外置边界反例均已闭合；交付物变化时重开。 |
| S21-B 耐久 spool | 帧先耐久后发送、恢复续算、逐消费者水位、背压、终态回收 | 第 20 单元完成基线 | 冻结终审 | 已完成 | 非局部封版 | 统一资产账本、可重驱清理、资格/回收及 `unknown` 重放校验已闭合；spool schema 或状态机变化时重开。 |
| S21-C 传输与消费 | streamEpoch、订阅/ACK、路径切换、慢 observer 隔离、本地/mesh 等价 | 第 20 单元完成基线 | 冻结终审 | 已完成 | 非局部封版 | 逐消费者 epoch、强制 ACK 栅栏、类型化降级和异步缓存自愈已闭合；wire 或连接所有权变化时重开。 |
| S21-D 生产与验收 | yield/event/interaction/final 生产接线及故障、篡改、恢复矩阵 | 第 20 单元完成基线 | 冻结终审 | 已完成 | 非局部封版 | 耐久 interaction 投影、run-end drain、统一 abort 与重试义务已闭合；生产入口或终结协议变化时重开。 |

### 完整单元横向审查记录

> 启用分片时每轮必填;默认消费封版信息包,有疑问可下钻细节,确认问题或结论失效时重开切片。

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |
| 开发收口 | 指纹 `9a964400…baccb` | 生产→先耐久→发送/重放→消费 ACK→终态回收；seq/epoch/digest/final、异常终态与第 24 单元启用边界 | U21-01～U21-06 均已验证，无待修复项 | 四个切片封版；完整交付物已冻结，进入独立终审 |
| 独立终审 | 指纹 `9a964400…baccb` | 逐生产执行点、耐久双写崩溃窗、多消费者独立连接、外置前后验证、票据资格与本地/mesh 错误等价 | 重开 S21-A～D；U21-03～U21-05 修复不完整，新增 U21-07；架构师发现的 rejected epoch promise 已合并 U21-04 | 4 个根因级问题待集中修复，当前不可提交 |
| 独立终审二 | 指纹 `9a964400…baccb` | 按 L21-01～L21-03 复扫所有入口与生产点；补查 artifact/帧文件的写入、GC、容量、裁剪和同进程故障恢复 | U21-05 补齐 backpressure、run-end 与中止链；新增 U21-08 | 5 个根因级问题待集中修复，当前不可提交 |
| 集中修复后横向复核 | 指纹 `8544ed0c…cdc84` | 按 L21-01～L21-05 复扫生产、重放、消费、资产生命周期与终结链；本单元新增耐久 reducer 全量枚举 | U21-03～U21-09 均已完成直接验证，无待修复根因 | 四切片重新封版，进入同一指纹冻结终审 |
| 再集中修复后横向复核 | 指纹 `5323abd6…dbd` | 沿本机与远端全部 run-end 路径复核耐久义务所有权；重放边界继续按 `unknown` 封闭验证 | U21-05 本机瞬时失败尾项已归入统一耐久义务重试；U21-09 畸形重放矩阵通过 | 四切片重新封版，进入同一指纹两轮冻结终审 |
| 冻结终审一问题盘点 | 指纹 `5323abd6…dbd` | 按 L21-01～L21-05 复扫正式 writer 接线、全部耐久记录转移与永久回收崩溃窗 | 新增 U21-10、U21-11；其余切片无新增根因 | 两个根因集中修复后重新冻结 |
| U21-10～U21-11 修复后横向复核 | 指纹 `7b5c8630…1cd5` | 正式 writer/worker 调用签名、final 元数据与信号；消费者时刻谓词、reclaimed 吸收终态、log→tombstone 失败窗及检查时刻→提交时刻 TOCTOU | 两个根因及同族时刻风险均完成合并直接验证，无待修复项 | 四切片重新封版，进入两轮冻结终审 |
| 冻结终审一问题盘点 | 指纹 `7b5c8630…1cd5` | 按 L21-01～L21-07 复扫生产调用点及消费者登记、裁剪、回收窗重连的排列组合 | 重开 U21-05；新增 U21-12 | 两组根因集中修复后重新冻结 |
| U21-05、U21-12 修复后横向复核 | 指纹 `e27f01fb…9ae` | 异步生命周期告警全部调用端等待；job surface/relay 先后登记、ACK、fallback 与重连组合 | 两组同族完成合并直接验证，无待修复项 | 四切片重新封版，进入同一指纹两轮冻结终审 |
| 重新冻结终审一 | 指纹 `e27f01fb…9ae` | 需求/架构/功能闭环、正式生产端口、全记录状态机、消费端等价、资源生命周期及 L21-01～L21-09 检测动作 | 无 | 完整横向审查零新增，终审一通过 |
| 重新冻结终审二 | 指纹 `e27f01fb…9ae` | 并发、崩溃、安全、资源上界、异常终态和测试盲区；复核 14 类耐久记录、永久回收、资产清理、多消费者连接与异步完成屏障 | 无 | 完整横向审查零新增，终审二通过 |
| 派生同步后冻结终审一 | 指纹 `8639e7ee…dc60` | 复用未变代码事实包并独立复核唯一交付变化：结构 golden 新增计数是否精确对应允许的 CLI→core 耐久义务导入 | 无 | 仅允许边计数 40→41，无新增包边或非法依赖；终审一通过 |
| 派生同步后冻结终审二 | 指纹 `8639e7ee…dc60` | 反向核对实际导入、包依赖、运行时导出与结构/行为/lifecycle golden，确认派生资产未掩盖实现变化 | 无 | 四项派生门禁通过，代码与功能事实包未变；终审二通过 |
| 测试预算收口后冻结终审一 | 指纹 `9b73042d…74b0` | 复用未变生产代码事实包，独立复核唯一测试变化的作用域、上界与失败可观测性 | 无 | 30 秒预算只作用于 spool 耐久 IO 测试组，断言与业务实现未变；终审一通过 |
| 测试预算收口后冻结终审二 | 指纹 `9b73042d…74b0` | 反向核对无全局放宽、无跳过、无吞错，失败单例仍执行原完整畸形重放矩阵 | 无 | 单例 1/1 通过，预算有界且错误仍立即失败；终审二通过 |

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core stream 合同、事件类型与导出 | contracts typecheck、runtime exports、摘要与 validator 直接测试 | V21-01、V21-02、V21-03 | 通过 |
| executor spool、导出与构建入口 | package exports、类型、直接测试、包级回归 | V21-01、V21-02、V21-05 | 通过 |
| orchestrator runtime 与 CLI worker/interaction 接线 | 异步错误传播、既有消费者兼容、受影响包回归 | V21-01、V21-06、V21-08 | 通过 |
| CLI stream mesh adapter | wire 绑定、epoch fencing、结构依赖基线 | V21-01、V21-03、V21-08 | 通过 |
| owner-kernel 类型边界 | owner-kernel 包级回归 | V21-07 | 通过 |
| server 结构 golden | 独立结构检查当场更新并复跑 | V21-03 | 通过 |
| specification.md | 实现与既有 §5.6 合同对账 | 开发收口横向审查 | 通过 |
| lockfile / schema 快照 | 无依赖版本或生成 schema 变化 | `git diff HEAD --name-only` 无对应文件 | 不适用:依据 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| StreamFrame 身份与摘要 | core `protocol/stream` | 数据帧 append 时分配绝对 seq 并推进链头；final 固化最后链头 | 字段篡改、断序、final 后写入、路径换代 | runtime/worker → spool/verifier | 单帧 512 KiB；内联 32 KiB；链恢复不重扫 | 通过 |
| 耐久 spool | executor `AssignmentStreamSpool` | commit-log 元数据与 ArtifactStore 帧均完成后才对订阅可见 | append、ACK、重启、回收与 artifact 缺失 | worker → local/mesh consumers | 每 assignment 64 MiB；背压可释放；终态 24h 回收窗 | 通过 |
| 消费水位与连接栅栏 | spool consumer state + mesh subscription | cumulative ACK 耐久提交；连接 epoch 只栅栏该连接响应/ACK | ACK 丢失、重连、旧路径迟到、lease 轮换 | surface/owner-relay → spool | 每消费方单一水位；重放从 ACK+1；慢 observer 有界降级 | 通过 |
| 生产背压与失败终结 | orchestrator EventBus + conversation worker | async consumer 完成后生产继续；durable consumer 错误反传 run | stream open/final、append 失败、runtime 创建失败 | agent runtime/interaction → stream writer | 串行 await，不建无界内存队列；失败进入 durable terminal | 通过 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 架构 | §5.6 | 状态 | seq/epoch/digest/final/spool/waterline | 通过:V21-10～V21-13；14 类记录闭合 | 通过:状态机、摘要与水位对账 | 通过:重放与终态反向复核 |
| 架构 | 第 21 单元 | 入口与生产端 | yield/event/interaction/final 生产 | 通过:V21-10～V21-13 | 通过:正式 writer 与全部生产点 | 通过:等待、失败传播与完成屏障 |
| 架构 | §5.6 | 消费端与继承面 | subscribe/replay/ack/consumer identity | 通过:逐消费者水位、资格与旧连接拒绝 | 通过:本地/mesh 等价 | 通过:surface/relay 混合顺序 |
| 架构 | §5.6 | 生命周期 | open/final/terminal/reclaim/recover | 通过:V21-10～V21-13 | 通过:恢复与可重驱清理 | 通过:永久回收吸收终态 |
| 架构 | 第 21 单元 | 并发与崩溃点 | append/send/ack/path switch/restart | 通过:ACK 丢失、双连接、双写恢复与资产三插点 | 通过:全链并发与崩溃窗 | 通过:混合消费者与异步完成屏障 |
| 架构 | §5.6 | 异常路径与终态 | overflow/old epoch/gap/tamper/ack loss | 通过:V21-10～V21-13 | 通过:类型化失败与幂等重驱 | 通过:资源上界和异常终态 |
| 总纲 | 双平面与信任 | 安全边界 | consumer guard/fencing/assignment binding | 通过:请求、响应、ACK、ref 与连接身份全绑定 | 通过:旧 epoch fail-closed | 通过:独立连接与越权状态转移复核 |
| 总纲 | §3 包边界 | 模块边界 | core/executor/mesh/cli 依赖 | 通过:V21-03，结构 golden 仅预期边变化 | 通过:无越界启用 | 通过:X21-01～X21-04 未触发重开 |
| 执行计划 | 第 21 单元验收 | 测试与验收 | 本地/mesh、恢复、资源与篡改矩阵 | 通过:V21-10～V21-17 | 通过:反例矩阵完整 | 通过:最终构建、包级行为与机械门禁闭合 |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U21-01 | 初版把 producer append/final 绑定到订阅连接 epoch，消费者重连会使仍在运行的生产者被误判为旧路径。 | 把逻辑流生产身份与可换代的运输连接身份混为同一栅栏。 | 全部数据帧、final、重连/路径切换、恢复续算及本地/mesh 消费。 | producer 只受 assignment 生命周期约束；epoch 仅绑定订阅响应、下行帧和 ACK。换路后 seq/digest 连续、旧连接 ACK 拒绝。 | 已验证 |
| U21-02 | 初版在 owner-relay 未 ACK 时永不启动 job fallback 回收，owner 长期不可达会永久保留终态 spool。 | 回收谓词没有区分“仍有 pending interaction”与“终态且全部 interaction 已闭合”。 | job owner-relay、终态 assignment、interaction、ACK 丢失与 24h 回收窗。 | interaction 全闭合后启动有界 fallback；新有效消费者订阅可撤销 pending reclaim。对应测试通过。 | 已验证 |
| U21-03 | 此前只为 `appendProduced` 增加大对象外置，但实现先外置、后仅验证 `{ref}`：非法超限 yield/event 可藏入 artifact；公开 `append` 又能绕过 32 KiB 外置，引用内容也没有语义物化校验。 | 语义验证、资源准备、外置与读取分散在不同入口和不同表示层，没有单一 prepare/materialize 合同。 | yield/event 全类型组合，直接与 producer append，ArtifactStore、摘要、wire、恢复、篡改与读取完整性；现有测试只覆盖合法大对象。 | 建立 core 单一 prepare/validate/materialize 原语：先验证原对象，再按阈值外置；全部 append 路径复用；消费引用时验证规范字节与语义。补非法超限对象、直接入口、引用篡改和边界值测试。 | 已验证 |
| U21-04 | 此前只绑定了 mesh 请求与连接 epoch，但 `beginConnection` 对 assignment 全局递增：第二个合法 observer/relay 会栅栏第一个；本地 `acknowledge` 可省略 epoch；`epochFor` 还会永久缓存 rejected promise，把一次瞬时失败放大为同连接永久失败。 | 连接栅栏的作用域与生命周期未由单一状态机拥有，assignment 状态、逻辑消费者、连接上下文和适配器缓存发生分叉。 | 多 surface、owner-relay 与 surface 并存、同消费者重连、旧连接迟到、ACK、瞬时 spool 失败、同连接退避重试及回收安全；现有测试只覆盖单消费者重连或多消费者共用同一 epoch。 | epoch 按逻辑消费者/路径绑定，只换代同一旧路径；订阅和 ACK 强制使用连接固有 epoch，禁止可选绕过；异步初始化失败清除缓存并可重试。补独立连接并存、旧路径拒绝及 beginConnection 瞬时失败自愈测试。 | 已验证 |
| U21-05 | 此前只修复“已 await 的 EventBus emit”错误反传；白名单内 `lifecycle:*`、`interrupt:warn` 仍有未 await/`emitSync` 生产点。interaction 先写 assignment ledger、后写 stream，崩溃后无游标重驱；backpressure 分支确定性只落 ledger 的 requested/finished、不产对应 stream 帧，失败/run-end 关闭的 pending 同样没有投影重驱。stream append 未接 worker 的 AbortSignal，spool 满时 abort/close 可永久等容量；后续又确认本机生产 runtime 的 run-end drain 只执行一次，瞬时失败会遗留 started assignment；本轮继续发现 `reportLifecycleWarning` 虽已改为异步，但 guidance 调用端仍按同步回调使用，告警投影可越过 hook 完成屏障。 | wire 必需投影仍附着于通用 EventBus 和手工双写，没有唯一耐久所有者、稳定来源身份、幂等重驱、final 前 drain 屏障与统一中止所有权；异步端口升级后也未对全部调用端执行等待语义对账。 | 全部白名单 agent event、yield、interaction requested/finished、backpressure/run-end、append 失败与阻塞、崩溃恢复、pending、final/digest、本机与远端 executor、worker abort/close、生命周期告警调用端及失败终结。 | 由单一耐久 stream 投影/outbox 承担生产；协议事件使用稳定来源身份，interaction 从耐久 ledger 按游标幂等投影；所有生产及异步告警等待接入完成屏障，先补齐投影并 drain，再 final；本机与远端路径复用同一耐久义务重试分类。补双写崩溃、backpressure、run-end、瞬时 drain 失败、满 spool 中止及 guidance 告警等待测试。 | 已验证 |
| U21-06 | `createStream` 或 `final` 失败发生在 started 之后时，初版可能跳出 worker 而不写 durable failed，assignment 留在运行态。 | stream 生命周期没有纳入 assignment 执行失败的统一终结所有权。 | worker startup、runtime 创建、append/final、usage final、恢复与 owner 超时判定。 | stream open 纳入执行 try；final 失败先以最终 usage 调 `failExecution` 再抛。stream-open 注入测试与 worker 包级回归通过。 | 已验证 |
| U21-07 | 消费者仅在首次成功 subscribe 时登记，已签发但未订阅的有效 surface ticket 对回收谓词不可见，零消费者时可提前启动 24h 回收；本地明确的 degraded/history-unavailable 又经 mesh 统一压成 `service-failed`，远端无法执行终态对账。 | 消费者资格、订阅水位、失效与降级没有形成同一耐久且类型化的生命周期合同，当前只存在局部订阅投影。 | 票据签发/续期/吊销、未订阅 observer、surface/relay 水位、终态回收、慢消费者降级、本地/mesh 等价与第 22/24 单元接线。 | 从票据签发/撤销登记耐久资格与 expiry，回收按资格集合裁决；为 degraded/history-unavailable 定义稳定 wire 结果及终态对账动作。补有效票据未订阅、零消费者、过期/吊销和 direct/mesh 等价测试。 | 已验证 |
| U21-08 | 外置 yield/event 写入 `sourceArtifacts` 后，spool 日志只保存非标准的 digest/bytes 字段，未把引用纳入同一次在场锁或 GC 保留集；64 MiB 与慢消费者阈值只累计小型帧文件字节，外置正文可绕过上界。帧文件又在日志提交前 `put`、在 `pruned` 提交后 `rm`：追加失败会遗留孤儿，删除失败后同进程没有待办事实可重驱，逻辑容量已释放而磁盘持续增长。 | 逻辑保留、物理资产、容量核算与清理义务分属两套存储和非原子步骤，没有统一耐久生命周期所有者。 | source artifact 与 frame artifact 的追加/GC 竞态、64 MiB 背压、慢 observer 判定、ACK/prune、崩溃与瞬时 IO 失败、同进程长期运行及重启清理。 | spool 对正文和帧拥有单一耐久保留账本：外置引用在提交时原子验在场并进入 GC root，容量/滞后累计完整保留字节；物理删除成为可重驱义务，成功后再闭合，追加失败的孤儿也由同一机制收敛。补 put→commit、GC 竞态、prune→delete 失败、无需重启自愈及外置正文容量测试。 | 已验证 |
| U21-09 | `SpoolRecord` 以 TypeScript 联合类型直接进入 reducer，但 commit-log 重放的磁盘 JSON 只校验 envelope，不校验业务 body；未知 consumer kind、字符串水位、非法 interaction 分支及多余字段可进入投影，部分状态转移也未在原 envelope 时间上复核。 | 把编译期类型误当作耐久重放边界的运行时合同，写入端约束没有在唯一 reducer 入口 fail-closed 重建。 | 全部 14 类 spool record、执行引用与 verifier checkpoint、consumer 资格/epoch/水位、interaction pending、prune/reclaim 终态及重启恢复；同类面已确认本单元仅此一个新增耐久 reducer。 | 在 reducer 单一入口对联合类型逐分支做 exact-key、字段、嵌套对象与判别值校验，并补齐初始 checkpoint、consumer kind 不变、保留水位与按 envelope 时间回收等状态不变量；以直接注入规范 envelope 的畸形 body 测试证明重放立即拒绝。 | 已验证 |
| U21-10 | CLI worker 自定义 `final(signal?)`，正式 `AssignmentStreamWriter` 实现却是 `final(meta?, signal?)`；第 24 单元直接接线时 worker 会把 `AbortSignal` 当作帧元数据，final 稳定失败，且收尾帧丢失 turn origin。 | 同一生产端口在 CLI 与 executor 重复声明，参数次序已发生合同分叉。 | 远端 conversation producer、正式 spool writer、provisional-final 元数据、中止、sealed bundle 与第 24 单元启用接线；现有测试只用了忽略参数的 mock。 | 在 core 单源声明完整 stream producer 端口，writer 与 worker 共用；worker 以 `(streamMeta, abortSignal)` 调 final。测试必须让 final 同时断言元数据与信号，并证明正式 writer 结构兼容。 | 已验证 |
| U21-11 | `reclaimed` 已落 commit-log、但 tombstone 写入或目录删除失败时，`#assertNotReclaimed` 只查 tombstone，snapshot/连接等入口仍可继续使用该流；reducer 也允许永久回收后追加部分 consumer 记录，并未按 envelope 时间复核 qualification/expiry/degraded 与 reclaim-disarm/reclaimed 的在线谓词。 | 在线入口与重放 reducer 各自只检查局部形状，没有共享“当前消费者可用”与“永久终态不可逆”的单一状态谓词。 | reclaim 记录到 tombstone 的崩溃窗、重启与同进程重试、qualification/connection/offer/ACK/degrade、回收撤销与最终删除；畸形合法 envelope 测试未覆盖终态后继记录。 | 单源化消费者时刻谓词并同时用于在线与 reducer；`reclaimed` 后所有后继记录 fail-closed，公开入口同时检查投影终态；disarm/reclaim 必须由同一 envelope 时刻的回收谓词证明。补无 tombstone 的已回收恢复、终态后继记录与过期消费者转移测试。 | 已验证 |
| U21-12 | job 的 `retentionFloor` 仅在“没有任何有效消费者”时保护尚未登记的 owner-relay；若 surface 先登记并 ACK，历史会在 relay 首次出现前被裁剪。回收窗内首次登记或重新订阅未完成 relay 时，在线路径又写 `reclaim-disarmed`，但 reducer 仍以允许 fallback 的 `canArmReclaim` 判其非法，合法重连会被自身日志拒绝。 | “正常逐消费者裁剪”“owner 失联 fallback”“活跃消费者使回收窗失效”共用了一个布尔谓词，没有按消费者角色与当前动作分别声明。 | job surface/owner-relay 的登记顺序、surface 先 ACK、relay 首次出现、回收窗内重连、历史续传、reducer 重放与 24h fallback；conversation 路径不受影响。 | job 在有效 owner-relay 登记前不得按 surface 水位裁剪；disarm 记录绑定触发它的有效且未追平消费者，reducer按该事实验证；relay 首次出现/重连须撤销旧回收窗，追平后可重新进入有界 fallback。补 surface→relay 顺序和回收窗内 relay 恢复测试。 | 已验证 |
| U21-13 | 末轮新增 CLI 耐久义务原语后，结构 golden 仍记录 `cli/serve → @zhixing/core` 导入计数 40，实际为 41；冻结后的独立派生预检因此失败。 | 交付物末轮变化后重算了源码指纹，却未重新执行与其输入闭包相关的独立派生检查，旧 golden 结论被错误沿用。 | server 结构 golden、CLI 对 core 的允许依赖边、冻结指纹与最终验证门禁；功能代码与包边集合不变。 | 显式更新结构 golden 并审阅完整差异；仅允许边计数 40→41、无新增包边后，正常模式复跑结构/行为/lifecycle golden 与运行时导出。交付变化后必须按派生闭包失效传播重新预检。 | 已验证 |
| U21-14 | executor 最终包测 437/438 项通过；`fails closed on every class of malformed durable spool record` 在 5.46 秒触发默认 5 秒超时，机器结果无功能断言失败，定向单例 2.52 秒通过。 | 真实文件系统耐久测试组未声明资源预算，测试可靠性错误依赖运行器默认值。 | executor spool 全部 24 个同类耐久 IO 测试、包内并发负载与最终包测证据；生产代码不受影响。 | 为整个 spool 耐久 IO 测试组统一设置 30 秒有界预算，不全局放宽、不逐例追涨、不吞断言；原失败单例通过，最终以全包机器结果与全部资源超时单例合并覆盖 438/438。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X21-01 | 第 21 单元未把新 stream writer 设为生产默认，是否遗漏功能。 | 执行计划明确本单元落合同、spool 与接线 seam，owner-relay、surface 消费及最终启用属于第 24 单元；当前强制启用会越界并产生半链路。 | specification 第 21/24 项；worker `createStream` 注入边界 | 第 24 单元仍无生产启用，或第 21 单元边界被正式改写 | 已排除 |
| X21-02 | CLI `tsc --noEmit` 的 8 项 credential projection 错误是否由本单元引入。 | 错误均在未改的 config-editor/startup 旧路径，与本单元文件和新增符号无交集；CLI 直接测试、全包测试和全量构建通过。 | V21-02、V21-08、V21-09；指纹 `9a964400…baccb` | 本单元文件出现类型错误，或 credential projection 进入本单元边界 | 已排除 |
| X21-03 | contracts lint 指向 `authority/artifact-store.ts` 的增量摘要实现，是否为本单元合同违规。 | 该文件不在交付集且 `git diff HEAD` 为空；报错来自既有 lint 基线，当前 stream artifact 只消费其公开端口。contracts typecheck 与运行时导出通过。 | V21-02、V21-03；指纹 `9a964400…baccb` | 本单元修改该文件、lint 新增指向本单元实现，或 artifact 摘要合同改变 | 已排除 |
| X21-04 | Unit 21 未新增 surface 侧远程 artifact 下载端点，是否导致外置 stream 内容当前不可读取。 | 第 23 单元字面负责 surface 内容资产数据面，第 24 单元才启用生产 stream 消费；本单元只需保证本地 spool 在此之前可耐久保留和读取引用内容。 | 执行计划第 21、23、24 项；`readRetainedArtifact` 本地端口 | 第 23 单元未提供票据绑定的读取端口，或第 24 单元在该端口前启用外置内容消费 | 已排除 |
| X21-05 | executor 最终全包的随机 5 秒超时是否为功能回归。 | 三次全包均为 437/438，分别超时于 spool、job、conversation 三个不同耐久 IO 用例；失败均为约 5 秒 `STACK_TRACE_ERROR`、无功能断言失败，三个用例定向复跑均通过；单 worker 仍漂移且无残留验证进程。 | V21-15、V21-16；指纹 `9b73042d…74b0` | 任一定向用例失败、出现功能断言失败、同一用例在显式预算内稳定失败，或运行器/机器条件变化 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L21-01 | U21-04；开发收口 | 多消费者测试复用了同一 epoch，只证明水位隔离，未建立独立连接；异步缓存也未注入首次 reject。 | 涉及连接栅栏时必须以至少两个独立连接并存测试，并注入一次初始化失败后在原连接重试。 | 独立终审:定位全局 epoch 与 rejected promise 缓存；重新冻结终审一:复核双连接与 reject 后清缓存；重新冻结终审二:独立连接与原连接重试复核 |
| L21-02 | U21-05；开发收口 | 只验证 EventBus listener 能 await，没有枚举每个生产调用点是否真正 await；也未在权威事实与 stream 投影之间插入崩溃。 | 协议事件接线逐生产点检查 await/emitSync；所有耐久投影双写必须在两次写之间做崩溃恢复验证；本机与远端生产路径分别注入一次瞬时失败。 | 独立终审:收齐 lifecycle/interrupt 与 interaction 双写；冻结终审一:重开本机 run-end drain并共享重试原语；重新冻结终审一:全部生产点与双写恢复复核；重新冻结终审二:全部生产点与失败传播复核 |
| L21-03 | U21-03、U21-07；开发收口 | 测试只覆盖主入口和已订阅消费者，未横扫公开旁路、表示转换前后及“有资格但未产生读取”的零动作主体。 | 资源/生命周期合同必须枚举全部公开入口，并分别验证转换前原值、转换后引用及已授权但未调用主体。 | 独立终审:定位 append 旁路、外置验证与未订阅票据；重新冻结终审一:公开入口/内联/外置/未订阅资格复核；重新冻结终审二:公开入口与零动作资格复核 |
| L21-04 | U21-08；独立终审 | 先前只验证重启时清理孤儿帧，并把小型 frame bytes 当作全部保留成本；未在 source artifact GC、日志提交和裁剪后删除之间注入竞态与瞬时失败。 | 涉及“artifact + 引用日志 + 物理删除”的耐久组件，必须逐点注入 put→commit、GC、commit→delete 失败，并验证同进程可重驱；容量必须累计传递闭包全部保留字节。 | 独立终审二:定位 GC 窗、外置容量绕过与同进程清理义务丢失；重新冻结终审一:资产三插点与完整容量复核；重新冻结终审二:容量与可重驱删除复核 |
| L21-05 | U21-09；冻结终审 | 先前只从公开 API 写入合法 record，TypeScript 联合类型掩盖了磁盘 JSON 在 reducer 入口仍是 `unknown`，未注入带合法 envelope 摘要的畸形业务 body。 | 每个新增耐久 reducer 必须把重放 body 当作 `unknown`，枚举全部判别分支做运行时封闭校验，并至少注入未知判别值、错误标量类型、非法嵌套对象和越权状态转移。 | 冻结终审:横扫 14 类 spool record；重新冻结终审一:14 类 record（含带 key 的 disarm）封闭复核；重新冻结终审二:14 类 validator/reducer/生产点对账 |
| L21-06 | U21-10；集中修复后横向复核 | 先前分别验证 mock producer 与正式 writer，却未把正式实现代入注入端口核对完整调用签名；可选参数错位被忽略参数的 mock 掩盖。 | 每个延后启用的注入 seam 必须用正式实现做结构对账，并让测试观测全部可选参数的位置与语义。 | 冻结终审一:定位 worker `final` 参数错位；重新冻结终审一:正式 writer 结构代入及参数断言复核；重新冻结终审二:正式端口调用签名复核 |
| L21-07 | U21-11；集中修复后横向复核 | 先前验证了 `reclaimed` 自身前置条件，却未把它作为吸收终态横扫所有后继记录，也未插入 reclaimed-log→tombstone 的失败。 | 耐久吸收终态必须枚举全部后继记录并拒绝；两阶段物理清理必须在“逻辑终态已落、物理标记未落”处重启并逐公开入口验证不可见。 | 冻结终审一:定位无 tombstone 的已回收投影；重新冻结终审一:吸收终态后继与公开入口复核；重新冻结终审二:永久回收与 tombstone 失败窗复核 |
| L21-08 | U21-05；U21-10～U21-11 修复后横向复核 | 把同步回调升级为 Promise 后只检查了声明与直接生产者；Promise 可被返回 `void` 的适配回调静默丢弃，类型检查没有暴露等待语义缺失。 | 任一回调从同步升级为异步时，枚举全部实现和调用端；对仍需同步签名的适配器建立显式 drain，并用延迟 Promise 证明宿主完成前必等待。 | 冻结终审一:定位 guidance 告警未等待；重新冻结终审一:全调用端枚举与延迟 Promise 反例通过；重新冻结终审二:调用端与 drain 屏障复核 |
| L21-09 | U21-12；U21-10～U21-11 修复后横向复核 | 回收测试分别覆盖 surface 与 relay 主路径，却未排列“surface 先 ACK、relay 后登记”和“fallback 已启动、relay 再出现”；角色混合顺序使单角色谓词失效。 | 多消费者裁剪/回收必须排列每种角色的先后登记、先后 ACK、失效与回收窗内重连；验证任何仍可能出现的必需角色均可从其水位续传。 | 冻结终审一:定位 relay 晚到与 disarm 自拒；重新冻结终审一:混合登记/ACK/fallback 重连排列通过；重新冻结终审二:角色顺序与重连复核 |
| L21-10 | U21-13；重新冻结终审二 | 末轮源码变化后只复算总指纹，未按输入闭包使结构 golden 预检失效，导致派生差异延迟到最终验证才暴露。 | 每次冻结后若交付物再变，按派生产物闭包逐行传播失效；存在独立检查的 golden/schema/结构基线必须在重冻结前正常模式复跑，不得只复算总指纹。 | 派生同步后冻结终审一:结构差异审阅并正常复跑；派生同步后冻结终审二:导入、包边、导出与三项 golden 反向对账 |
| L21-11 | U21-14；派生同步后冻结终审二 | 直接测试通过时未核对重 IO 测试在真实包内并发负载下是否拥有显式预算，默认 5 秒直到最终包测才暴露。 | 新增或扩展真实文件系统耐久测试时，按同类测试组声明有界预算；冻结前检查默认时限残留，最终包测失败先从机器结果按单例归因。 | 最终验证:机器结果定位 5.46 秒默认超时；测试预算收口后终审一/二:组级 30 秒上界与失败可观测性复核 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V21-01 | 流合同、spool、mesh、worker 与异步背压直接行为 | core stream、executor spool、CLI stream/worker、orchestrator 两项定向测试 | 对应实现与直接测试 | 开发 / 中 / 已完成 | core 11/11；executor 10/10；CLI 13/13；orchestrator 2/2 通过 | `9a964400…baccb` | 失效 |
| V21-02 | 改动源码类型边界与独立 contracts | core/executor/orchestrator source `tsc --noEmit`；CLI `tsc --noEmit`；contracts typecheck | 改动源码、上游类型与 contracts | 开发 / 中 / 已完成 | core、executor、orchestrator、contracts 通过；CLI 仅 X21-02 的既有 8 项 | `9a964400…baccb` | 失效 |
| V21-03 | 运行时导出、结构依赖与既有运行时 golden | runtime package exports；server structure/behavior golden；CLI lifecycle golden | package exports、CLI/executor/core 依赖与 golden | 冻结准备 / 低 / 已完成 | exports 通过；结构 1/1、server behavior 2/2、CLI lifecycle 1/1 通过；结构差异仅预期导入计数 | `9a964400…baccb` | 失效 |
| V21-04 | core 合同与既有回归 | core 单包全测 | core 源码与测试 | 包级 / 中 / 70.4s | 714/714 文件、2409/2409 项通过 | `9a964400…baccb` | 失效 |
| V21-05 | executor spool 与账本回归 | executor 单包全测 | executor 源码与 core 构建产物 | 包级 / 高 / 237.6s | 28/28 文件、424/424 项通过 | `9a964400…baccb` | 失效 |
| V21-06 | orchestrator 事件传播与既有 runtime | orchestrator 单包全测 | orchestrator 源码与上游构建产物 | 包级 / 中 / 30.6s | 120/120 文件、428/428 项通过 | `9a964400…baccb` | 失效 |
| V21-07 | owner 类型继承面 | owner-kernel 单包全测 | owner-kernel 源码与 core 构建产物 | 包级 / 低 / 23.1s | 17/17 文件、180/180 项通过 | `9a964400…baccb` | 失效 |
| V21-08 | CLI worker、mesh adapter 与完整既有入口 | CLI 单包全测，首轮机器结果留存后读取 | CLI 源码、测试及当前上游构建产物 | 包级 / 高 / 已完成 | 625/625 文件、2428/2428 项通过 | `9a964400…baccb` | 失效 |
| V21-09 | 最终产物与跨包编译闭包 | `pnpm build` | 完整工作区源码与构建配置 | 最终 / 高 / 已完成 | 17 个工作区包全量构建通过；测试未与构建并发 | `9a964400…baccb` | 失效 |
| V21-10 | U21-05 本机/远端耐久义务重驱与 U21-09 畸形重放 | worker 全文件、runtime 单例、executor spool 全文件 | 对应实现、共享重试原语与直接测试 | 集中修复 / 中 / 已完成 | CLI worker 11/11；runtime 1/1；executor spool 21/21 通过 | `5323abd6…dbd` | 有效 |
| V21-11 | 最新 CLI 类型边界与格式 | CLI `tsc --noEmit`；Biome 5 个末轮文件 | CLI 源码、上游类型与末轮文件 | 冻结准备 / 低 / 已完成 | CLI 仍仅 X21-02 的既有 8 项；Biome 5/5 通过 | `5323abd6…dbd` | 有效 |
| V21-12 | U21-10 producer 单源端口与 U21-11 永久回收/消费者时刻谓词 | core stream、executor spool、CLI worker/interaction 定向集；core/executor/CLI 类型；Biome；core 上游构建 | core producer 合同、executor writer/reducer、CLI 调用端与直接测试 | 集中修复 / 中 / 已完成 | core 12/12；executor 22/22；CLI 13/13；core/executor 类型通过；CLI 仅 X21-02 的既有 8 项；Biome 7/7、core build 通过；提交时刻同族复核后 executor 22/22 与类型再次通过 | `7b5c8630…1cd5` | 有效 |
| V21-13 | U21-05 异步告警调用端等待与 U21-12 job relay 混合顺序 | executor spool 全文件；CLI guidance 全文件；orchestrator 生命周期告警单例；相关类型与 Biome | 对应实现、调用端与直接测试 | 集中修复 / 中 / 已完成 | executor 24/24；CLI guidance 8/8；orchestrator 2/2；executor/orchestrator 类型通过；CLI 仅 X21-02 的既有 8 项；Biome 5/5 通过 | `e27f01fb…9ae` | 有效 |
| V21-14 | U21-13 派生资产同步与结构边界 | runtime package exports；server 结构/行为 golden；CLI lifecycle golden | 当前源码、包清单与三份 golden | 冻结准备 / 低 / 已完成 | exports 通过；结构 1/1、server behavior 2/2、CLI lifecycle 1/1 通过；唯一新增差异为允许边计数 40→41 | `8639e7ee…dc60` | 有效 |
| V21-15 | U21-14 测试预算与原断言保持 | Biome；executor spool 畸形重放单例 | spool 测试文件与实现 | 最终验证归因 / 低 / 已完成 | Biome 通过；原失败单例 1/1 通过（23 项跳过仅由定向过滤产生） | `9b73042d…74b0` | 有效 |
| V21-16 | executor 最终包级行为与资源型超时归因 | 三次 executor 全包机器结果；三个失败单例定向复跑 | executor 当前源码、测试与 core 构建产物 | 最终 / 高 / 已完成 | 三次全包各 437/438，失败点互异且均为默认 5 秒超时；三个失败单例各 1/1 通过，无功能断言失败，合并覆盖 438/438 | `9b73042d…74b0` | 有效 |
| V21-17 | 最终产物、受影响包行为与机械交付门禁 | 单独 `pnpm build`；core/orchestrator/owner-kernel/CLI 全包机器结果；executor 采用 V21-16；`git diff --check`、skip/only、注释债务、进程残留与最终指纹 | 31 个交付文件、工作区构建配置及当前上游产物 | 最终 / 高 / 已完成 | 17 包构建通过；core 714/714、2411/2411；orchestrator 120/120、428/428；owner 17/17、180/180；CLI 627/627、2434/2434；executor 合并 438/438；机械门禁通过，指纹一致 | `9b73042d…74b0` | 有效 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | U21-03、U21-04、U21-05、U21-07 | `9a964400…baccb` | 未通过，待集中修复 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | U21-08；补齐 U21-03、U21-05 同族面 | `9a964400…baccb` | 未通过，5 个根因级问题待集中修复 |
| 重新冻结第一轮 | 需求、架构、功能闭环、状态、生产/消费端与回归 | 是 | 无 | `e27f01fb…9ae` | 通过，连续零新增 1/2 |
| 重新冻结第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | 无 | `e27f01fb…9ae` | 通过，连续零新增 2/2 |
| 派生同步后第一轮 | 唯一变化的结构 golden 与允许依赖边 | 是 | 无 | `8639e7ee…dc60` | 通过，连续零新增 1/2 |
| 派生同步后第二轮 | 实际导入、包清单、导出和三项 golden 的反向一致性 | 是 | 无 | `8639e7ee…dc60` | 通过，连续零新增 2/2 |
| 测试预算收口后第一轮 | 测试作用域、预算上界与生产语义隔离 | 是 | 无 | `9b73042d…74b0` | 通过，连续零新增 1/2 |
| 测试预算收口后第二轮 | 失败可观测性、无跳过/吞错及同类测试一致性 | 是 | 无 | `9b73042d…74b0` | 通过，连续零新增 2/2 |

<!-- registration-complete: unit-21.gen-1 -->
