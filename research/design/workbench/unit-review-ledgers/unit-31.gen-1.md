# 单元登记:第 31 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:31
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-07
- **登记来源**:用户要求将第 31 单元独立审查及价值裁决后的当前问题与已删除问题转入正式账本

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成（第 31 单元已封版）
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是（第 31 单元完整功能闭包；工作台状态文件不计入指纹）
- **交付物文件集**:`6410de0a` 至当前工作树共 41 个变化路径；其中 34 个功能路径为 28 个生产/直接测试文件、2 个 S7 文件、4 个现行架构/规格文件，另 7 个 workbench 路径仅为流程状态
- **当前交付物指纹**:`sha256:9edbf987c57f5f5a10353806860d9e486e213c535fc067e49b6922723621e32e`
- **架构来源**:`distributed-runtime-charter.md`、`specification.md`、scheduler/rubric 当前架构、第 31 单元定稿开发清单、当前生产调用图与第 31 单元独立审查清单

## 固定边界

- **功能范围**:随本地域 conversation owner 落 schedule/rubric `DeferredGlobalIntent` 耐久流，收编前查询/撤销，锚点 internal review 与原子确认归宿
- **架构不变量**:intent 随 conversation owner；fresh 写只属于既有 current owner；全局效果、control applied 与 confirmed 原子；派生 schedule 可由耐久 pending 幂等追平；本单元不开放公开离线入口
- **验收条件**:U31-01～U31-02 按正式验收条件修复并更新为已验证；EX31-01 不触发重开；随后完成受影响范围复审、两轮冻结终审、独立功能审查与单元提交验证
- **必要上下游**:第 30 单元本地域 owner、同一 executor AuthorityCommitLog/会话目录、ArtifactStore、ControlAdmissionJournal、schedule authority pending/materializer、anchor+executor 与 executor-only 两生产根
- **明确不属于本单元**:第 32 单元 AuthorityTransfer、current-owner 切换与公开 CLI/RPC/渠道离线旅程；公开复核错误码、可行动说明及术语净化；通用 intent/事务/outbox/事件总线/registry/调用图、监控、诊断、benchmark 与信息采集

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| core intent 严格联合、durable projection、rubric authority adapter | core 导出、codec/validator、manifest/checkpoint、ArtifactStore 引用闭包 | core 合同测试与既有 build 证据；当前 diff 无 schema/golden 生成物 | 通过 |
| owner-kernel intent/journal/control/review/coordinator | owner-kernel 导出、同一 AuthorityCommitLog 的 identity/intent/schedule pending 投影 | owner-kernel build；repository/review 定向测试 13/13 | 通过 |
| owner-services schedule/rubric producer 与 CLI 消费 | producer 合同、advancement 文案、两生产根装配与 lifecycle | producer 5/5、两生产根 2/2、conversation consumer 定向证据 | 通过 |
| S7 门禁与变异测试 | canonical registry golden、local/anchor mode/epoch/authority/public-zero 边界 | `pnpm s7:lint` 15/15，golden 无漂移 | 通过 |
| charter/specification/scheduler/rubric 当前段 | 当前实现、EX31-01 与第 32 单元边界 | 四文档双向对账；历史段未升级，Unit32 禁止项未进入实现 diff | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| conversation-owned intent 写 | executor AuthorityCommitLog 中 control `session-create` 派生 identity、按 `(conversationId, ownerEpoch)` 重建的 `ConversationRunJournal` identity/delete 与 `intent:<conversationId>` 投影 | `ConversationRunJournal.transactDeferredIntent` 在同一日志锁/read prefix 联合读取两投影并固定 exact replay→fresh identity/delete/epoch guard→append | delete/intent 双序竞争、控制身份效果后响应丢失、exact/terminal replay | local schedule/rubric producer、list/discard、anchor internal review、后续收编 | intent 投影有界分页；匹配 replay越过后续删除稳定返回，fresh 写只命中当前耐久 owner | 通过 |
| confirmed schedule 派生物化 | schedule authority task revision 与同投影的 durable pending | 全局事实、control applied 与 confirmed 原子提交；首次与 terminal same-decision 统一调用 materializer，create=1、其余=`taskRevision+1` | refresh 效果前/后失败、materialized 响应丢失、较新 pending、进程持续运行与重启 | anchor review、GlobalMutationCommitCoordinator、scheduler consumer | 较新 pending 只可覆盖旧目标；旧 replay 不清除它，失败保留 pending 且未追平不返回完成 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |
| R31-01 | intent 合同、身份、会话生命周期与 repository 线性化；覆盖状态、并发、崩溃、安全 | core intent codec/reducer；control identity、ConversationRunJournal、repository；local/anchor record/list/decide；repository/协议测试 | 路径+内容 SHA-256 `e3b606697f94467e3d7fdbcebb4f3f122176b65be515de882c242b1371d48935` | 任一合同、identity/delete、ownerEpoch、replay、投影或直接测试变化 | 通过 | 2/2 | 终审二从反例重建：伪 identity、错 epoch、delete 先/后、相同/异载荷、终态后删除及部分投影恢复均不能形成第二合法 append；matching replay 唯一且不依赖快照目录，零新问题。 |
| R31-02 | schedule/rubric producer、ArtifactStore 与产品终态；覆盖消费者、恢复、异常语言 | 两 producer、rubric adapter、advancement/controller、CLI consumer、相关测试与 rubric 当前文档 | 路径+内容 SHA-256 `5afc488e3bbe4751c5ffffce9997ba85c1bfe755395765286d858f1b895ab279` | producer、资产引用、采用/沉淀顺序、消费文案或测试变化 | 通过 | 2/2 | 终审二从失败消费反推：缺/坏/旧 rubric asset、prepare/record 失败、schedule 不完整写、publication 响应丢失均不会回滚 local-draft 或声称全局生效；无内部术语公开，零新问题。 |
| R31-03 | anchor 原子复核、CAS 与 schedule pending 物化；覆盖权威、并发、响应丢失与恢复 | anchor runtime、review、control admission/coordinator 直接边界、故障测试、scheduler 当前文档 | 路径+内容 SHA-256 `529d084b09f1fc75772b2b4dbcbce0c3de3574d0ac8ce2060c8ea2d3bc4f9960` | review/atomic plan、target revision、pending/materialized reducer、启动恢复或测试变化 | 通过 | 2/2 | 终审二主动构造 CAS 冲突、refresh 效果前/后抛错、materialized 响应丢失、旧/新 pending 交错与连续重启：权威事实不重复，未追平不返回完成，新目标不被旧 replay 清除。 |
| R31-04 | 双生产根、能力隔离、公开零入口、包/文档/S7 闭包；覆盖入口、生命周期、结构与验收 | CLI local/protocol/anchor 装配、conformance、DurableProjectionIndex、S7、charter/spec | 路径+内容 SHA-256 `f0af444057cffed898dc645bb0a862ac971b1224df81540783c1945c7c42b926` | 生产装配、公开 registry、包依赖、S7、文档边界或派生资产变化 | 通过 | 2/2 | 终审二从装配漂移反推：重复/错 mode/错 authority/错 epoch、公开 token、禁用全局能力及 Unit32 提前注册均被现有有限 S7 或生产图拒绝；两根合法路径与文档合同一致。 |
| R31-05 | 跨项组合：record→review→global commit→materialize、delete/replay、rubric asset 与 Unit32 接缝 | R31-01～R31-04 的当前输入、问题/排除记录、34 路径总闭包 | 总路径+内容 SHA-256 `9edbf987c57f5f5a10353806860d9e486e213c535fc067e49b6922723621e32e` | 任一 R31-01～R31-04 输入、状态或结论变化，或出现新反证 | 通过 | 2/2 | 终审二以跨域故障序列重建 record→delete/replay→review→commit→materialize 与 rubric asset 链：每步唯一事实源和失败终态可组合，生命周期/恢复无空窗；EX31-01 与 Unit32 边界均未触发。 |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U31-01 | **P1｜工作量中｜来源 P31-01；同根反证 C31-R01。** 原缺陷为 repository 在事务外以 `sessionExists` 快照裁决 fresh record/discard，delete 可先提交后仍追加 intent。实施中 C31-R01 证明普通会话的耐久 identity 来自 control `session-create` applied，而非 run journal 首记录；仅读 journal 会把真实 `ensureSession` 会话误判为未知。当前以同一 AuthorityCommitLog 的 `conversation-identities-v1` 派生投影恢复该既有事实，并与 journal identity/delete、intent 投影在一个锁定前缀联合读取；它不是第二事实源。**价值裁决记录（2026-08-07）：**否定 rubric 未引用内容寻址资产的跨存储事务扩面，保留会话身份与 intent append 的 P1/中根因；C31-R01 同根合并，不恢复 ArtifactStore 或第 32 单元方案。 | Repository 未经当前 owner 的 per-conversation journal 在同一日志锁/read prefix 联合读取普通 control identity、journal identity/delete 与 intent replay；因此 delete/fresh intent 无唯一顺序，且初版 journal-only guard遗漏普通会话身份。 | **生产端：**两 local root 的六种 mutation、local/anchor repository、普通/工作场景 conversation delete。**组合：**既有/未知/已删除、delete/intent 双序、fresh/exact/conflict/terminal replay、响应丢失。**消费者：**list/discard、anchor review、后续收编输入。**异常终态：**删除后新增 intent，或合法普通会话被拒；匹配 replay不得因后续删除失效。**直接证据：**同一真实日志竞争、六 mutation、两生产根 `ensureSession→record/list/discard/replay`、S7 反绑。**受影响审查项：**IR31-06、IR31-09、IR31-29、IR31-33。 | `ConversationRunJournal.transactDeferredIntent` 统一锁内读取 control identity 投影、run journal identity/delete 与 intent 投影；顺序固定 exact replay→fresh identity/delete/ownerEpoch guard→同 envelope append。protocol 只暴露窄适配器，local/anchor 显式注入；control identity 仅由全等 `session-create received→applied ok` 产生。验收为删除胜出零追加、intent 胜出完整提交、普通/工作场景身份均可用、匹配 record/discard replay 越过后续删除全等、两根及 S7 全绿；ArtifactStore、transfer 与公开合同不变。 | 已验证 |
| U31-02 | **P1｜工作量中｜来源 P31-03。** 原缺陷为 schedule 权威 confirmed 后 refresh/materialization 失败留下 durable pending，而 terminal same-decision fast-path 直接返回，进程不重启便无法追平。四种 mutation 的原 request/task/target 均可由冻结 intent 唯一重建。**价值裁决记录（2026-08-07）：**删除属于第 32 单元的公开 confirmed/conflicted/retryable 结果联合，只保留现有 pending/materializer 的 P1/中修复。 | 把“intent 已 confirmed”误作“scheduler 已消费目标 revision”，terminal replay 绕过既有 materializer，使启动恢复成为唯一重驱入口。 | **生产端：**anchor review、ControlAdmission、schedule reducer/coordinator/startup recovery。**组合：**四 mutation、首次/并发/terminal replay、refresh 效果前后失败、响应丢失、较新 pending、连续重启。**异常终态：**confirmed 但 scheduler 低于目标，或旧 replay 清除新 pending/重复 revision。**直接证据：**真实 pending/materializer 故障测试与 task/materialized 记录计数。**受影响审查项：**IR31-20、IR31-30、IR31-33。 | 抽取唯一 confirmed schedule materialization 路径，以 `intentId+mutationDigest` 重建 control requestId，复用既有 taskId，target 固定 create=1、其余=`taskRevision+1`；首次与 terminal same-decision 返回前均调用现有 materializer。refresh/验证/清 pending 任一失败即拒绝并保留 pending；只清除不晚于旧目标的 pending，较新目标保留，启动恢复继续兜底。验收为效果前后失败可同进程追平、四 mutation/响应丢失/并发/重启零重复 revision、未物化绝不返回完成，且不新增公开结果/队列/通知。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX31-01 | 原主张 P31-04：缺少一张同时覆盖两生产根、anchor imported-intent、两 mutation 族、资产、CAS、响应丢失及全部故障的共享 conformance 小表，构成 P1／中阻断。已验证：两份 local production profile 已穿过真实 assembly；anchor repository/review、rubric/资产/CAS 与恢复有直接生产服务测试；S7 独立反绑装配和角色 exact-set。IR31-20 暴露的是 schedule 同进程物化重驱缺少直接回归，不是全部生产证据无效。 | 适用于当前两 local profile、直接 repository/review/producer 测试与 S7 共同覆盖生产交界的证据结构。复制全部组件场景会增加维护与提交耗时，但不会发现独立于 U31-01/U31-02 的当前用户失败；对应同进程反例已并入 U31-02，D31-06 已修正为成比例证据闭包。 | 第 31 单元独立审查证据：local production conformance 3/3、owner-kernel repository/review 6/6、owner-services producer 5/5、S7 lint 15/15 与 golden；2026-08-07 价值裁决及当前 D31-06。 | 出现无法由直接生产测试与 S7 捕获、且在支持的两生产根之间可达的独立装配语义差异；或现有 profile/直接测试/S7 不再覆盖其声明边界。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V31-01 | owner-kernel 类型与导出可构建 | `pnpm --filter @zhixing/owner-kernel build` | owner-kernel U31 生产实现与依赖声明 | 修复直接验证 / 低 / 27.8s | ESM+DTS 成功 | `sha256:b6ad14d0…0a6f` | 有效 |
| V31-02 | intent/delete 线性化与 schedule pending 故障闭包 | 包内 Vitest 定向运行两个 deferred-intent 文件 | repository、journal/control identity、review/coordinator、两直接测试 | 修复直接验证 / 低 / 20.0s | 2 文件、13/13 通过 | `sha256:b6ad14d0…0a6f` | 有效 |
| V31-03 | 普通 control identity 与两生产根装配全等 | CLI 包内 Vitest 定向 `owner-domain-conformance` 的 production assembly contract | owner-kernel dist、CLI protocol/local/anchor 两 profile | 修复直接验证 / 中 / 53.1s | anchor+executor、executor-only 2/2 通过 | `sha256:b6ad14d0…0a6f` | 有效 |
| V31-04 | 两根窄口、mode/epoch/authority adapter 与公开零扩面 | `pnpm s7:lint` | 两 S7 文件、CLI 三生产文件、registry golden | 派生资产预检 / 中 / 51.7s | 15/15 与 golden 通过 | `sha256:b6ad14d0…0a6f` | 有效 |
| V31-05 | CLI 类型影响诊断 | `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit` | 最终上游 dist 与 CLI 源码 | 诊断 / 低 / 19.4s | 仅复现 8 条既有 credentials 精确能力基线错误；U31 零新增 | `sha256:b6ad14d0…0a6f` | 诊断 |
| V31-06 | 最终源码与声明的 workspace 可消费性 | `pnpm build` | 最终 17 包工作区源码与 lockfile | 最终构建证据 / 中 / 219.4s | 17/17 成功 | `sha256:b6ad14d0…0a6f` | 有效 |
| A31-01 | 冷启动：conversation lifecycle/intent 线性化 | 只读重建 control identity、journal identity/delete、intent projection 与锁内排序 | U31-01 实现、C31-R01、同日志竞争测试 | 专项对抗 / 低 | 普通/工作场景 identity 均有耐久来源；delete/fresh 只有一个合法胜者，未知/删除后 fresh 零追加 | `sha256:b6ad14d0…0a6f` | 有效 |
| A31-02 | 冷启动：fresh/exact/terminal replay 与响应丢失 | 只读重造同载荷、异载荷、后续删除与 response-loss 反例 | repository reducer、journal adapter、直接测试 | 专项对抗 / 低 | exact/terminal 先于 fresh guard；异载荷/相反终态拒绝，匹配 replay 不依赖删除后的目录 | `sha256:b6ad14d0…0a6f` | 有效 |
| A31-03 | 冷启动：schedule pending/崩溃恢复 | 只读重造四 mutation、refresh 前后失败、较新 pending、连续重启 | review helper、coordinator pending reducer、故障测试 | 专项对抗 / 低 | 首次/terminal 共用原 target；旧 replay 不清新 pending，失败保留并可同进程/启动追平，revision 零重复 | `sha256:b6ad14d0…0a6f` | 有效 |
| A31-04 | 冷启动：产品价值与范围边界 | 实现 diff、三现行文档、EX31-01 与 Unit32 禁止项双向对账 | 14 文件冻结闭包 | 专项对抗 / 低 | 未新增公开入口、结果联合、transfer/current-owner 切换或广义 conformance；EX31-01 重开条件不成立 | `sha256:b6ad14d0…0a6f` | 有效 |
| A31-05 | 反证差异审计 | P31-01/P31-03、C31-R01、专项矩阵逐项归并 | 正式问题、测试与四路记录 | 收口 / 低 | P31-01/P31-03 修复后复核通过；C31-R01 同根合并并复核通过；零悬空反证 | `sha256:b6ad14d0…0a6f` | 有效 |
| V31-07 | 单元提交验证：复用同输入构建、直接测试和 S7，核对差异卫生、闭包与指纹一致性 | `git diff --cached --check`、`git diff --check`、41/34/7 路径二元归属、34 路径 SHA-256；V31-01～V31-06 与原开发证据逐项复用 | 完整 34 功能路径；7 个 workbench 状态路径排除 | 提交验证 / 低 / 6.1s | staged/worktree diff check 通过；41 个变化路径全等分为 34 个功能路径与 7 个状态路径；功能指纹全等，零未暂存功能路径、零未跟踪文件；未重复包测、模块回归或 build | `sha256:9edbf987…1e32e` | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 是           | 0       | `sha256:9edbf987…1e32e` | 通过；R31-01～R31-05 各 1/2 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是           | 0       | `sha256:9edbf987…1e32e` | 通过；R31-01～R31-05 各 2/2 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |
| IF31-01 | **高风险：权威身份与并发写。** conversation identity、ownerEpoch、delete、fresh/exact/terminal intent 的同日志排序 | identity/journal/repository 全链；`e3b60669…d48935` | 已覆盖 | 从失效机制重建错身份、错 epoch、双序竞争、响应丢失与投影重建；fresh 写只有一个合法线性化点，matching replay 不被后续删除破坏，零新增。 | identity 来源、journal 事务、replay 顺序或 owner 转移前提变化 |
| IF31-02 | **高风险：原子确认与派生最终性。** global/control/confirmed 原子提交、schedule pending/materialized 恢复 | review/coordinator 全链；`529d084b…f9960` | 已覆盖 | 对 CAS 冲突、四 mutation、refresh 前后失败、响应丢失、较新 pending 和连续重启逐项反推；权威不重复、未物化不报完成、旧目标不清新目标。 | atomic plan、target revision、pending reducer 或 scheduler consumer 变化 |
| IF31-03 | **一般风险：产品消费与资产闭包。** schedule/rubric producer、local-draft、ArtifactRef、有限文案 | producer/asset/consumer；`5afc488e…ab279` | 已覆盖 | 缺件、损坏、过期、prepare/record 失败和 replay 均落到诚实终态；本地采用不被全局沉淀失败回滚，公开文案无内部术语。 | producer 联合、资产引用、采用顺序或公开 consumer 变化 |
| IF31-04 | **高风险：生产装配与能力隔离。** 两生产根、internal-only、S7、包依赖与 Unit32 边界 | assembly/S7/docs；`f0af4440…2b926` | 已覆盖 | local/anchor owner 集合、mode/epoch/authority 绑定、禁用能力和公开 registry 双向对账；合法两根恰一装配，公开零入口，第 32 单元能力未提前。 | topology、composition root、公开 registry、S7 或模块合同变化 |
| IF31-05 | **高风险跨区组合。** record→delete/replay→anchor review→global commit→materialize 与 rubric asset/生命周期交界 | IF31-01～IF31-04、EX31-01、34 路径；`9edbf987…1e32e` | 已覆盖 | 跨区故障序列不存在第二事实源、半提交、错误成功或恢复空窗；证据按直接失效边界成比例，EX31-01 重开条件不成立，零未登记风险机制。 | 任一独立风险区输入/结论变化或出现生产交界反证 |

<!-- registration-complete: unit-31.gen-1 -->
