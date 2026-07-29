# 单元开发工作台

> **维护原则**
>
> - 以独占一行的“开发清单”标题为界：此前为静态区，保存长期规则与用户提示词，不随开发单元重置；该标题及其后为动态区，只保存当前单元的开发清单。分隔线仅用于视觉区隔，不承担区域边界语义。
> - 动态区只固定“当前单元”“开发事项”标题、状态说明及空表，不建立独立文档、不归档。
> - 重置步骤：仅当全部开发事项均为 `[x]` 且用户明确要求结束或切换单元时，才将模块、单元、来源、边界和排除项恢复为 `—`，清空全部开发事项并将进度恢复为 `0%`；存在 `[ ]` 或 `[!]` 时禁止重置，历史摘要不构成重置授权。只重置动态区，不得删除固定骨架或改动静态区。
> - 下一单元的来源、边界、开发事项及应交付的实现与测试必须重新生成，不得继承上一单元内容。
> - 提示词由用户维护；未经用户明确授权，不得新增、删除或修改提示词，规则变化也不得自动同步到提示词。

## 一、背景信息

知行分布式运行时（`distributed-runtime`）模块第 23 开发单元（surface 内容资产授权与生命周期治理）的实现约耗时 2 小时，后续审查与修复却耗时 4 天半。复盘表明，根因是进入审查时交付物仍不完整：审查阶段既在补做开发阶段本应完成的功能，又在处理大量遗留问题。

在审查阶段补开发，必须反复经历“发现问题—修复—构建验证—再次审查”，使原本一次可完成的实现工作额外叠加多轮审查与验证成本。本工作台用于把范围识别和实现完整性控制前移到开发阶段，确保进入审查时实现已经完整，审查只负责发现残余问题，而不是继续完成开发。

## 二、目标与边界

本工作台前移的是开发范围的识别与完整实现，不是把独立审查或最终验证搬到开发阶段。开发前必须依据架构、需求和上下游合同，明确本单元应完成的边界、功能链与异常场景；开发时一次性完成这些已知义务，不得把未考虑或未实现的功能留给审查阶段补做。

开发阶段只执行支撑当前实现所必需的直接验证，不进行重复的全量审查与重型验证。审查阶段只负责发现完整实现后的残余缺陷；本单元的已知范围必须在进入审查前全部落实，不能等到审查时才识别或补做。

开发清单只定义“必须交付什么”：每项写清功能范围、边界、场景、应实现行为及直接相关的测试代码，不登记“测试通过”“连续审查无问题”“达到可提交状态”等质量状态。勾选只表示对应实现与测试已经编写，不代表审查或最终验证通过。

### 架构空洞裁决

1. 现有架构总纲、规格和边界能够唯一推出清晰、可行且无明显副作用的最优方案：这只是文档细节不足，应自行补齐并继续开发，不应停工。
2. 存在多个合理方案，选择会显著影响架构、功能、用户体验、成本或单元范围：这才是真正的架构空洞，必须停止并说明取舍，等待裁决。

## 三、用户提示词

### 3.1 生成开发清单

```
完整读取下一开发单元的架构总纲、可执行规格或执行计划、上下游合同与验收要求，确认单元身份和边界。存在架构总纲时以其为最高依据，开发范围与方案不得偏离架构设计；文档不足以确定边界时，明确指出架构空洞并停止定稿，不得用实现假设补齐。

按照本工作台“目标与边界”，把开发阶段必须完成的功能范围、生产端与消费端、状态与异常路径、边界条件、非默认场景及直接相关的测试代码，拆成有限、可执行的开发事项，写入动态区。明确不属于本单元的内容只写入“明确排除”字段，不得生成开发事项。每项只写清必须交付的实现与测试，不得写入审查轮次、验证结果或可提交状态；动态区不得沿用上一单元的分类或内容。

本任务只建立开发清单，完成后立即停止。
```

### 3.2 审查开发清单

```
不得沿用生成清单时的范围判断。重新完整读取当前单元的权威架构、可执行规格或执行计划、上下游合同与验收要求，审查动态区开发清单；目标是在清单定稿前收齐全部已知开发义务，避免后续审查才发现功能范围遗漏。

先从权威来源正向核对本单元全部适用要求是否已有开发事项，再沿每条功能链核对生产端、消费端、装配入口、状态与异常终态、直接相关的测试代码，以及适用的边界条件、非默认场景、并发、安全、资源和兼容性要求，最后反向确认每个事项都有架构依据且没有越出单元边界。

通过标准：本单元的全部已知开发义务均有明确落点；每项只描述必须交付的功能范围、边界、场景、行为和测试代码，内容有限、无重复、无歧义且可直接执行；不存在架构偏离、范围遗漏、范围越界或依赖实现猜测的事项。完成全部核对后，一次性向我报告所有问题和架构空洞，不得修改文档；没有问题时，明确回复开发清单通过。仅报告以下四类实质问题：偏离架构、遗漏开发内容、超出单元边界、开发事项无法执行。单纯润色措辞、设想没有事实依据的风险或增加非必要功能，不得作为问题。满足全部标准后立即停止。
```

### 3.3 按清单开发

```
动手，完成本单元开发。

开始前：
1、完整读取 `research/design/workbench/unit-development-workbench.md` 的静态规则、当前单元已经定稿的开发清单及其引用的权威架构文档。
2、严格围绕架构总纲、可执行规格和单元边界开发，不得偏离架构设计。发现疑似架构空洞时，按照 “# 单元开发工作台”文档的“架构空洞裁决”规则判断并处理。发现架构设计不是最优，或不同选择会带来明显副作用时，停止开发并说明。

开发要求：
1、先以顶级架构师、顶级智能体专家的身份思考代码组织与设计，注意宏观视角看整体架构、要可维护、可扩展、可插拔，要最佳代码实践方案。
2、按开发清单逐项完成生产实现、消费链路、边界场景及直接相关测试代码；完成一项立即标为 `[x]`。勾选只表示实现与测试代码已经完成，不代表审查或最终验证通过。
3、开发中发现清单遗漏了本单元必须实现的内容时，先补入清单再实现；不得擅自扩展单元边界。
4、渐进式实现、分步验证。

原则：

我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计。

验证纪律：
1、开发中只跑最小必要验证（类型检查 + 直接相关测试），修改边界只跑对应测试；单元收尾再跑一次受影响包全量测试，最终交付前再跑必要构建。禁止无新增价值的重复全量验证，禁止并行运行会互相清理或干扰产物的命令；失败先归因再重跑。目标是用最少的时间完成同等质量的完整验证任务，尽一切可能实现目标。
2、执行构建、包测、全测或 CI 验证前，先按任务与运行条件查 `research/design/workbench/verification-runbook.md`，命中记录时必须采用其中已验证的运行方式；若本轮确认失败源于运行方式而非实现，并因此需要重跑，正确方式验证通过后当轮登记。
3、注意避免陷入“业务代码或测试代码导致无限循环、Bash 长时间无输出”的情况；出现风险时先停止并审查原因，不得持续等待。

注意：
1、不要留下注释债务，不引用 `Phase-N`、`M-N`、`INV-N`、`ADR §N`、`§X.Y` 等会变化的标识符，只保留解释当前代码所必需的稳定注释。
2、全部开发事项均为 `[x]` 时，报告本单元开发完成并立即停止；不得自行重置动态区。
```

---

## 开发清单

### 当前单元

- **模块**：知行分布式运行时（`distributed-runtime`）
- **单元**：第 24 单元（S6）——中继、渠道确认与最终性整合
- **架构与规格来源**：`distributed-runtime-charter.md`；`specification.md` §1.1、§1.2、§2.2、§2.5、§3.4b、§3.7、§4.1、§4.3～§4.5、§5.1、§5.5～§5.6、§6.2、§7～§10.1、§12、§13、§15 第 24 项；`always-online-and-local-execution-requirements.md`；既有 `scheduler-architecture.md`、`server-gateway.md`、`unified-core-and-access-surfaces.md`、`persistent-service.md`、`message-outbox.md`、`confirmation-ux.md` 的上下游合同；第 23 单元边界与排除记录
- **单元边界**：复用第 21～23 单元已落地的 stream/spool、数据面票据和 surface 资产原语，补齐 job owner-relay、conversation/job 渠道 challenge、token/grant、状态与终态合并、直连失败后的路径降级及生产装配；全部权威仍归 conversation owner、job owner 或 executor assignment 流，仅在本单元全部链路闭合后启用 S6 无损数据面。
- **明确排除**：不重做第 21～23 单元已经冻结的 stream、票据、资产与容量治理合同；不实现第 25 单元 Environment/workscene、第 26 单元 scheduler CRUD/定时触发产品闭环及旧 DeliveryPipeline/queue 退役、第 27～29 单元其他模块接入、第 30 单元及之后的本地域 owner、收编、迁居、备份、服务生命周期与发布能力；不新增通道、确认、提交、投递或资源治理的第二套语义。
- **当前进度**：20 / 20（100%；原开发事项 10 / 10，Job 交互与取消的耐久收敛补充事项 10 / 10）
- **状态约定**：`[ ]` 未完成；`[x]` 已完成；`[!]` 存在阻塞

### 开发事项

| 编号   | 状态 | 开发事项                                          | 功能范围、边界与场景                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 必须交付的实现与测试                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D24-01 | [x]  | 冻结并实现渠道凭证与中继记录的单一协议原语        | 覆盖 conversation/job challenge token、job-only grant、prepared/delivered/closed、job relay cursor/granted 记录及其摘要、签名、严格 wire 校验和耐久 reducer；conversation token 不得进入 grant，relay 记录不得成为 pending/finished 的第二权威。                                                                                                                                                                                                                                                                  | 在 contracts/core 提供唯一构造、签名、验签、逐字段反绑与错误分类原语，在 owner-kernel 的 run/job journal 接入封闭记录联合、唯一键和状态约束；补未知字段、错域、错 ref/assignment/interaction/challenge/route/responder/displayDigest/expiry/decision、重签与重放测试。                                                                                                                                                                                                          |
| D24-02 | [x]  | 建立统一的数据面连接选择与路径降级                | 第一方 surface 安全可直连 executor 时必须直连；不可达或连接中断时才经 owner/anchor 中继。切换只改变传输路径，沿用同一 assignment、consumer 身份、seq、摘要链与 ACK 水位，不改变控制面准入、确认权威或终态语义。                                                                                                                                                                                                                                                                                                   | 实现可插拔的 direct/relay 数据面连接器及有界重连、旧 streamEpoch fencing、按已 ACK seq 续订和终态对账降级；单机使用同一合同的进程内 adapter。补直连成功、直连失败回退、中途切换、反向恢复、重连竞态、旧连接迟到帧及跨路径零丢零重测试。                                                                                                                                                                                                                                         |
| D24-03 | [x]  | 实现 job owner-relay 耐久续流与水位所有权         | 定时 job 无 surface ticket，由当前 job owner 以有效 owner-control principal/ControlLease 订阅；逻辑水位固定为`(assignmentId, authority)`，不得随连接或 lease 轮换重置。任一帧必须先由 job 流耐久接管再 ACK，禁止跳过未 ACK seq；finished 帧必须在同一 CommitEnvelope 写 closed+cursor 后再 ACK。                                                                                                                                                                                                                | 在 owner-kernel/CLI 组合根接入 job relay consumer、cursor 投影、重连 ACK 重发和`afterSeq=upToSeq` 续订（服务端从下一帧返回）；cursor 同时耐久完整流校验 checkpoint，executor 继续以现有 spool guard 验 authority/lease。补错 owner/epoch/lease、cursor 回退/越界、ACK 丢失、lease 轮换、owner 重启，以及 requested/finished 接管与 cursor fsync 各崩溃点测试。                                                                                                                                                                          |
| D24-04 | [x]  | 建立 conversation/job 共用的耐久 challenge outbox | `prepared` fsync 后才可 ACK 数据帧并发送渠道消息；平台发送回执只进入 delivered 审计，不授予应答权；finished 投影为 closed。重启只按 prepared−closed 重驱同一 challenge/token，发送失败、响应丢失和重复 callback 不得产生第二个 challenge、grant 或 pending 权威。                                                                                                                                                                                                                                              | 实现以 challengeId 为幂等身份的 outbox 驱动、启动恢复、有限重试、过期/取消关闭和渠道发送适配；conversation/job 共享生命周期内核、保留各域字段约束。补 prepared、ACK、send、delivered、closed 各崩溃点及异载荷同键、重复回调、渠道不可达、过期重启测试。                                                                                                                                                                                                                         |
| D24-05 | [x]  | 闭合 conversation 渠道确认链                      | 渠道 turn 的规范 surfacePrincipal 是锚点渠道宿主；owner 向该宿主签 interact/abort 票据。interaction display 必须由共享 preparation 原语一次确定 inline-or-ref 形态，并由 assignment、StreamFrame、prepared 与摘要链复用；token 只绑定该对象的 displayDigest。宿主收到 requested 帧后先落含 frameSeq 与原 display 对象的 prepared、再 ACK、再发送只含 conversation token 的互动消息；callback 必须由平台认证身份派生 responder，并以原票据提交 allow-once，票据绝不下发渠道。                                      | 接通渠道宿主、run journal、数据面订阅、token 渲染/回传和 executor confirmation.resolve；ref 由同一 StreamConsumerAuth 经既有 probe/read 原语读取并校验，prepared/outbox 保留原 ref，禁止重新内联或重算。验证 responder 与 ingress、共享 display 对象、displayDigest、token 时效/签名及 pending 状态，重复 callback 回放原结果。补 inline/ref 两形态、ref 错 assignment/缺件/篡改/重驱、第一方/渠道同请求等价、旁观者不可代答、取消/过期/finished 竞态、进程内与 mesh 路径测试。 |
| D24-06 | [x]  | 闭合定时 job 渠道 grant 链                        | 定时 job 不签数据面票据；owner 接管 requested 帧时先验证`expiresAt=issuedAt+ttlMs`、换算本地单调期限并确保 token 不晚于该期限，再在同一 CommitEnvelope 写原 display 对象的 prepared+cursor 后 ACK，token 只绑定 displayDigest。验证平台 callback 后先耐久写唯一 signed grant，再以 host principal 转交 executor；executor 必须分别验 grant 与内嵌 job token，并以 `(assignmentId, interactionRequestId)` 单次完成交互。                                                                                       | 实现 token/grant 签发、callback 身份派生、grant 耐久回放、mesh/进程内转交和 executor 安全消费；ref 由 owner-relay 身份经同一 stream ref 读取合同解析，禁止重新内联或重算。origin、interactionResponder 缺失、渠道不可达、凭证过期或任一校验失败时统一`auto-resolved(no-interactive-surface)`。补 inline/ref、时限等式/偏差/上界、伪签、跨域、字段错配、decision 篡改、重复 callback/grant、转交丢失与 fail-closed 测试。                                                      |
| D24-07 | [x]  | 合并 provisional stream、状态通知与权威终态       | conversation 按 runId 的 statusRevision/commitRevision 合并实时流与历史补读：provisional-final 仍标“待确认”，仅匹配 SealedBundle digest/finalSeq 的 FinalFrame 转正。job 按 ExecutionRef/statusRevision 补读状态，committed 结果只经冻结 delivery plan 的 DeliveryOutbox 投递，不产生 FinalFrame；delivery 按稳定 itemId/statusRevision 补读。三域 revision 独立，uncertain 打开/关闭与裁决动作不得被终态覆盖或重复呈现。渠道只接收原来源白名单状态与结果，turn-slot 仅在权威 item 耐久接管或明确空终态后关闭。 | 在 owner/RPC/CLI/channel 投影层按 conversation/job/delivery 主体分别实现 revision 去重、乱序缓冲、断线补读、状态/结果合并和冻结文案映射；保持 DeliveryAuthority 为渠道投递唯一事实源。补三域实时/补读等价、conversation final 前后、job 结果投递、delivery 状态、status/结果交错乱序、重复通知、uncertain 打开/关闭、渠道白名单/非白名单、空终态、slot 顺序及跨渠道零广播测试。                                                                                                 |
| D24-08 | [x]  | 收束 spool 消费者回收、背压与长期失联降级         | spool 只有在 assignment 终态、全部有效 surface consumer 已 ACK 或失效、owner-relay 已 ACK finalSeq 后才进入 24h 回收窗；ControlLease 轮换或短暂过期不得丢 relay 水位。慢 observer 不得拖停 run；owner 长期失联只能在无 pending interaction 且保留窗届满后关闭 relay，并可由 ledger/mirror 恢复终态。                                                                                                                                                                                                              | 将路径管理器、ticket registry、relay cursor 和 spool retirement 接成单一回收判据；实现慢 observer 停止续票并降级 owner 终态对账、背压与恢复触发。补多 consumer 水位、final ACK 丢失、票据撤销/自然失效、relay 短断/长断、pending interaction 保留及重启回收测试。                                                                                                                                                                                                               |
| D24-09 | [x]  | 完成生产装配并原子启用 S6 无损数据面              | 在单一产品组合根中装配 executor stream 服务、owner relay/challenge、surface direct/relay、渠道 callback、status/final 消费与现有票据/资产服务；single-machine 与 distributed 只替换 adapter，不分叉业务状态机。任一必需组件初始化失败必须回滚，能力闭环前不得出现半启用生产路径。                                                                                                                                                                                                                                 | 补齐包导出、服务注册、接入面 setup/cleanup、角色/profile 门控和 S6 单一启用栅栏；移除被新链整体替代的生产旁路，但保留第 26 单元明确负责的旧 scheduler 投递路径。补角色未启用零加载/零监听、启动失败回滚、单机/分布式装配同构及开关前后生产路径唯一性测试。                                                                                                                                                                                                                      |
| D24-10 | [x]  | 建立第 24 单元跨链验收套件                        | 以当前完整交付物覆盖不变量 7、13、16：直连/中继、conversation/job、第一方/渠道、三域 status 与 conversation final/job result、凭证安全和崩溃恢复必须在同一套验收模型中交叉组合，不能由各组件 happy path 代替。                                                                                                                                                                                                                                                                                                    | 提供进程内与 mesh adapter 共用的 conformance 套件、渠道与第一方确认等价套件、prepared/cursor/closed/ACK/send 故障注入矩阵及 token/grant 对抗矩阵；覆盖规范 display 单源复用、时限换算、seq/cursor 单调、零丢零重、pending 权威唯一、conversation/job/delivery 通知可补读、审计可独立验签，并验证 S6 启用后既有单机对话、渠道回复和第 21～23 单元能力不回归。                                                                                                                    |

### Job 交互与取消的耐久收敛闭包

- **来源**：第 24 单元正式问题 `U24-07` 的未完成开发范围
- **功能边界**：从 executor assignment 日志中的 interaction 终态开始，闭合 owner mirror、stream 投影、取消清理、proof 前置义务、owner-fence 重驱、audit-only 收敛与崩溃恢复，并补齐所有启用 job execution 的生产拓扑中必然存在的执行与恢复 owner；不重做已经完成的执行域路由、grant outbox 和渠道生命周期矩阵。
- **明确排除**：不处理 `U24-09` 的验证状态，不扩展 scheduler CRUD、定时触发产品闭环、旧投递退役或后续单元能力。
- **当前进度**：10 / 10（100%）

| 编号   | 状态 | 开发事项                              | 功能范围、边界与场景                                                                                                                                                                                                                                                         | 必须交付的实现与测试                                                                                                                                                                                                                                                        |
| ------ | ---- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D24-11 | [x]  | 冻结 stream 投影完成的唯一耐久事实    | 保留现有 `mirrored` 作为 owner mirror 完成事实；stream 完成只由 executor assignment 记录 `interaction-stream-projected` 证明，二者共同决定退休，禁止再造聚合型完成事实。记录绑定 `assignmentId`、`upToRecordSeq`、`lastStreamSeq` 与既有规范 `streamDigest` checkpoint；不得另造 `frameDigest` 摘要域，也不得用内存游标、spool 现状或派生索引推断完成。 | 同步更新规格 §4.3、AssignmentRecord 封闭联合、validator、reducer 与重放 guard，并严格复用 §1.2/§5.6 既有 stream 摘要域；写入前以 spool 返回的耐久 checkpoint 验证 assignment、连续 sourceId 前缀、seq 与摘要全等。同水位全等幂等、异载荷拒绝，错 assignment、超前水位、有孔前缀和摘要错配均零追加。 |
| D24-12 | [x]  | 让 stream projector 生产耐久投影水位  | `AssignmentInteractionProjector` 是 `interaction:<recordSeq>` stream 副作用及其完成回执的唯一生产者；每次按 recordSeq 顺序完成全部幂等 spool append 后，立即把本批最后水位写回 assignment 日志。该写入口只在 executor 进程内暴露，不得新增 mesh/AuthorityPort 方法；conversation 复用 payload 投影原语但不得写 job 完成事实。 | 为该投影链提供返回 `{sourceId,frame,checkpoint}` 的显式窄接口，禁止从通用 appender 的 `unknown` 返回值断言类型；投影器按真实耐久收据调用 ledger 的唯一 `markInteractionStreamProjected`。删除仅靠进程内 `projectedRecordSeq` 判完成的语义，内存值只作优化。补同批多事件、重复/异载荷 sourceId、append 前后崩溃、水位响应丢失、错域调用与重放测试。 |
| D24-13 | [x]  | 使欠账索引分别追踪 mirror 与 stream   | `job-interaction-obligation` 仍只是 assignment 日志的可重建派生索引；分别维护 `maxFinishedSeq`、`mirroredUpTo`、`streamProjectedUpTo` 与格式切换水位。存在 pending interaction，或适用新合同的任一完成水位落后时必须保留；只有 mirror 与 stream 两条权威事实均覆盖终态前缀后才能退休。 | 提升 reducerVersion 并补旧索引重建；索引只消费 assignment 日志中的终态、`mirrored`、格式切换和 `interaction-stream-projected` 记录，不得读取 spool 建立第二事实。增量批次先应用再推进绑定日志身份的 checkpoint；覆盖日志/索引/checkpoint 三步崩溃、落后/超前/损坏、全量重建等价及十万历史 assignment 的分页追尾。 |
| D24-14 | [x]  | 将恢复与取消归并到唯一 assignment owner | `JobAssignmentWorker.recover()` 不得让 cancellation 认领压过 interaction recovery。取消前缀耐久后先中止 runtime；同一个 assignment reconciler 统一决策，但 mirror 与 stream 是相互独立的单调分支，任一暂时失败不得阻止另一分支及其他本地可完成清理。两条欠账均清零前不得生成或提交 cancel proof；reconciler 不得合并既有 owner-fence dispatcher 与 abort-ticket worker 两类 proof owner。 | 用每 assignment 单飞状态机替代 `claimed` 排除和互斥调度；正常答复、重放、run-end、取消与启动恢复只唤醒该 owner。恢复入口按页送入设备级有界队列，复用原 workload 身份与容量等级；每个本地执行批次重新取得物理 permit，等待远端 mirror 时不持 permit、锁或串行权。暂时失败封顶退避且义务无尝试上限，停机只中止本轮；覆盖两条分支先后顺序、取消竞争、并发 request、资源背压、重复恢复及 started 零业务重执行。 |
| D24-15 | [x]  | 统一所有终结路径的收敛门禁            | `bundle_sealed`、`execution-failed`、`halted`、stream final 与 cancel proof 都不得越过适用新合同但未完成的 interaction mirror/stream 义务。usage report/final、stream 等本地可独立完成的证据必须在远端 mirror 不可用时继续推进；最终 proof 只在全部前置义务闭合后生成。暂时失败保留可重驱义务；稳定合同冲突 fail-stop 并保留诊断，禁止以第二终态或伪造成功收敛。 | 收敛各调用入口到同一 `prepareInteractionConvergence`/等价谓词，删除直接 flush、只 drain stream、固定 mirror→stream 顺序或按分支短路的旁路。设备级恢复调度保持有界、公平和可诊断，禁止为每个欠账无界创建后台任务。参数化对账所有生产执行点，覆盖两条投影及 usage 在各自前置条件满足后的全部合法交错、远端不可用、容量不足、取消竞争、终态重入和迟到合法结果。 |
| D24-16 | [x]  | 建立耐久收敛的结构性测试闭包          | 新记录、新水位和唯一 reconciler 必须具备真实生产、消费、恢复和破坏性反例；测试范围只覆盖本补充功能及直接受影响的现有链路，并须证明恢复产生的 requested/finished 帧仍被既有 owner relay 耐久接管、推进 cursor 后 ACK。 | 将格式切换和 `interaction-stream-projected` 纳入 executor assignment-record schema/行为矩阵与 corruption vector；覆盖 terminal 耐久后 mirror/stream 两种先后顺序，每个耐久边界前后崩溃、取消认领、索引重建、proof 门禁、资源饱和与重复恢复；增加“恢复补投→owner relay→closed/cursor→ACK”的端到端用例。所有故障注入必须证明实际命中。 |
| D24-17 | [x]  | 闭合格式演进、旧状态与共享合同边界    | 新记录必须升级 `AssignmentRecord` 顶层 schema 版本，禁止把新判别分支写入 v1。新合同以 v2 `interaction-stream-projection-enabled(legacyUpToRecordSeq)` 为唯一切换事实；`legacyUpToRecordSeq` 固定为该切换记录前一条 assignment 记录的 seq：此前前缀仍按旧合同解释，不伪造 stream 完成；此后产生的 `interaction-finished` 必须取得独立的 `mirrored` 与 v2 `interaction-stream-projected` 才能退休。新 assignment 在首个 interaction 前启用；旧 pending interaction 若在切换后终结同样适用新合同。JobJournal 中无版本字段的既有 `interaction-settlement-fence/completed` 明确定义为 legacy v1，只能对应未启用新合同的目标前缀；新合同一律写带顶层 `v:2` 和 stream 绑定的 settlement 记录，禁止缺字段兼容或新旧语义混用。 | 采用两步兼容桥：第一步发布同时严格读取 AssignmentRecord v1/v2，并把无版本 settlement 只按冻结的 legacy v1 读取；该版本对已经启用的 v2 assignment 与 settlement 必须完整读写，但不得主动创建切换事实。第二步才原子写入一次切换事实，并仅为新合同写 v2 水位与 v2 settlement；回滚只允许回到第一步兼容版本。重复启用须全等幂等，切换水位、版本或身份冲突须拒绝；旧 v1 前缀、legacy settlement 和已回收 spool 保持旧合同。逐一对账并更新规格、wire/schema、full/guard reducer、ledger evidence、conversation/job worker、local/mesh adapter、索引和回收消费者；覆盖两类日志双读、各版本写入约束、桥接前后、切换各崩溃点、旧 pending、legacy settlement 在途恢复、重复启用/推进、回滚边界、conversation 零变化及有界恢复。 |
| D24-18 | [x]  | 补齐 job 执行与恢复 owner 的生产装配 | 每个宣告 job execution 能力的 executor-only、single-machine、anchor+executor 生产拓扑都必须由必然创建的 executor role 组合根持有唯一 `JobRuntimePort`、`JobAssignmentWorker`、assignment reconciler 与恢复生命周期；mesh、channel 和 access-surface 只能注册 adapter，不得成为唯一 owner。尚未形成完整闭环的拓扑不得注册能力，incoming job 必须在耐久 accept 前类型化拒绝。 | 将 job runtime、worker 和恢复 owner 接入稳定组合根，并统一其 start、recover、stop-accepting、drain、close 顺序；可选组件关闭不得使 owner 消失或重复创建。补三类生产拓扑及可选 mesh/channel/surface 关闭形态的装配测试，证明实例唯一、启动恢复必达、能力宣告与实际可用性一致，装配失败可逆序回滚且零后台泄漏。 |
| D24-19 | [x]  | 建立 owner-fence 的耐久重驱闭环      | JobJournal 中未完成的 `(assignmentId,fence)` 是 owner cancellation dispatcher 的唯一耐久 outbox。dispatcher 按同键单飞、封顶退避，持续执行同 fence 的 executor cancel、读取或提交已生成 proof、owner accept；每轮重读 journal，直至 proof 被接受或另一合法 owner 终态关闭义务。任意次数暂时失败、响应丢失与 owner 重启均不得丢失欠账；Job worker 不得轮询或提交 owner-fence，abort-ticket 仍由其独占。 | 实现由 owner 生命周期必然启动和恢复的 pending-fence dispatcher，复用原 fence 且不制造第二 proof owner；停止只中止当前尝试，不退休耐久义务。覆盖 mirror/stream 延迟超过任意固定尝试次数、cancel/proof/accept 请求与响应各侧丢失、owner/executor 重启、重复唤醒、合法竞态终态及 abort-ticket 并发，证明最终只接受一个合法 proof、零永久等待、零碰运气重试。 |
| D24-20 | [x]  | 让 audit-only settlement 同时证明 mirror 与 stream | v2 `interaction-settlement-fence` 必须绑定 assignment、executor、ticket、已验 ledger 前缀的 `{sourceLastSeq,sourceChainDigest}`、owner mirror 目标、目标 `interaction-finished` recordSeq 及其适用的 stream 合同。v2 `interaction-settlement-completed` 只有在 mirror 全等且 executor 已证明同一 assignment 日志中存在覆盖该目标的 `interaction-stream-projected` 后才能写入。legacy v1 fence 只按旧合同等待 mirror，不得升级、补造或借用 v2 证据。该义务跨用户裁决、assignment 替换和重启保留，但只开放绑定范围内的审计投影。 | 为 `RunSubmissionPort` 增加唯一 `completeInteractionSettlement` 入口，并定义 executor 签名、可由 assignment 日志确定性重建的版本化 `InteractionSettlementStreamProof`：固定绑定 fence 身份、assignment/executor、`sourceLastSeq/sourceChainDigest`、投影记录的 recordSeq、`upToRecordSeq`、`lastStreamSeq`、`streamDigest` 及该记录后的 ledger chainDigest。executor 只有在当前日志仍包含 fence 所绑前缀且投影记录覆盖目标时才能签发；该 proof 只是耐久日志的可验证证明，不成为第二事实源。owner 依次验证 DTO/version/未知字段、executor 签名、fence 与源前缀、日志链和 stream checkpoint，再与 mirror 同一事务写 v2 completed。进程内与 mesh adapter 共用 DTO、validator、guard 和幂等键；全等重放返回原结果，缺证、错版本/目标/前缀/水位/摘要、日志分叉或 legacy/v2 混用均零写入。覆盖投影早于/晚于 fence、mirror-only、stream-only、两种先后顺序、proof 生成与请求/响应及 fsync 各崩溃点、用户裁决前后、旧 assignment 替换和重启重放，证明双闭合前义务不退休且永不恢复 runtime、session、bundle、resource 或其他活动写权。 |
