# 单元登记:第 30 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:30
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-06
- **登记来源**:用户要求将第 30 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U30-02～U30-06 已验证；同一冻结指纹上的专项矩阵、四路冷启动对抗与差异审计均通过，EX30-01 排除前提持续成立
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅指 U30-02～U30-06 专项交付物；未进入全单元终审）
- **交付物文件集**:相对第 30 单元基线 `2526d6e8` 的 50 个生产、测试与合同路径；`.agents/skills/project-onboarding/SKILL.md` 属此前独立规则修正，工作台及流程规则文件不入本专项交付物
- **当前交付物指纹**:`sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5`（按排序后的 `路径\0文件 SHA-256` 聚合）
- **架构来源**:`distributed-runtime-charter.md`、`specification.md`、第 30 单元定稿开发清单、当前生产装配与源码、第 30 单元独立审查清单

## 固定边界

- **功能范围**:在每个 executor-enabled topology 内装配 internal-only 的设备本地域 conversation owner，复用同一 owner 内核、执行日志、ArtifactStore、data plane、设备容量与 owner-services，闭合 SessionState、run/cancel/confirmation、task/segment/advancement、content/finality 和恢复
- **架构不变量**:每台执行设备恰一 local owner；本地域与 anchor 域共享物理执行基础设施但逻辑流隔离；全局写、发布、投递与 transfer 构造期不可达；合法只读 skill/rubric/prompt cache 可消费；内部终态与恢复必须完整收敛
- **验收条件**:EX30-01 的排除前提持续成立且 U30-02～U30-06 按正式验收条件完成并更新为已验证；随后完成受影响范围复审、两轮冻结终审、独立功能审查与单元提交验证
- **必要上下游**:S1～S7 已冻结 owner/executor/SessionState/资源/advancement/ArtifactStore 合同，anchor+executor 与 executor-only 两条生产组合根，现有 S7 结构门禁和直接 conformance 设施
- **明确不属于本单元**:第 31～38 单元、公开离线创建/发现/迁居/接管、memory 读副本或全局写、全局 rubric 保存、channel/delivery/transfer、通用 registry/调用图/测试 runner、监控、诊断、benchmark 与信息采集

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U30-02 | **P1｜工作量中｜来源 P30-02。** local assembly 未注入 `onFinal`、status 或 confirmation answer 消费边界，internal port 只暴露 manager、完整 protocol 与 advancement；`publishPendingFinals` 在无 `onFinal` 时固定返回 0，已提交 final 永远留在恢复集合，运行中产生的 durable confirmation 也没有内部应答入口。 | 组合根把“尚无公开离线 surface”误作“无需任何消费端”，只装配 owner 生产侧而遗漏 internal-only 阶段仍必需的 interaction/finality 终端。 | **生产端：**`LocalConversationOwnerAssembly`、`ConversationProtocolRuntime`、`DurableConversationInteractionObserver`、assignment interaction ledger 与 final-outbox。**类型组合：**pending/read/allow-once/deny、取消与迟答、committed final、status、published/expired。**消费者：**窄内部 conformance port、history/status/final 补读、recovery discovery、start/stop。**异常终态：**确认无法 resolve，final 永久 pending，响应丢失和连续重启重复进入恢复但不收敛。**测试：**确认、取消竞态、提交、consumer 失败/响应丢失、重启与 stop。**受影响审查项：**IR30-11、IR30-18～IR30-21、IR30-29～IR30-30、IR30-33～IR30-34。 | 在 local 组合根复用现有 observer、ledger、status history 与 final-outbox，暴露一个窄 `LocalConversationConsumerPort`：只允许内部列读 pending interaction、凭既有 ticket resolve、按游标补读 status/history。local `onFinal` 只验证该 committed final 已可由同一 history 读取并返回，随后由现有 final-outbox 写唯一 published 回执；不建立第二耐久 sink，失败仍保留 pending 重驱，也不注册公开 RPC/CLI/channel。验收：确认、拒绝、取消与迟答、final 验证失败/效果后响应丢失、连续重启和 stop 均恰一终态，已发布 final 只从权威 history 补读且 recovery/outbox 最终为空。**实施证据：**C30-03 ledger 增加只读 pending request 选择，observer 只列当前 runtime-bound 且权威仍 pending 的请求；local port 新增 internal-only consumer，复用既有 ticket answer、status/final history。local `onFinal` 先对权威 final history 全等验真，原 final-outbox 仍独占 published 终态。executor 类型检查/构建通过，interaction、final recovery 与验真定向测试 9/9 通过。 | 已验证 |
| U30-03 | **P1｜工作量小｜来源 P30-03。** protocol 为普通 control mutation 把 `conversationExists` 固定为真；`ConversationSessionStateAdapter` 的 `advancement-event` 又绕过该回调直接写 journal，因此任意格式合法但未 create 或已 delete 的 local id 都能产生 session/lifecycle 权威事实。 | 会话身份 guard 没有成为 domain-neutral SessionState adapter 的统一 fresh-write 判据，create/ensure 不是所有新 session write 的唯一身份线性化点。 | **生产端：**SessionState adapter、protocol `writeSession`、directory create/ensure/delete 与 staged assignment。**类型组合：**task-list、advancement、session-meta、window clear/compact、delete、assignment task-list/segment；未知、已删除、并发 create/delete、exact replay。**消费者：**list/recovery/manager/advancement/projection。**异常终态：**孤儿 session stream、不可枚举状态或无来源 tombstone；既有 exact replay 不应被删除后身份检查破坏。**测试：**全 mutation 联合、未知/删除、并发、响应丢失与重启。**受影响审查项：**IR30-07、IR30-09～IR30-10、IR30-33～IR30-34。 | 给 adapter 注入同一 `sessionExists` 身份源，并让普通 control 与 `advancement-event` 在各自现有 journal 事务中遵循同一顺序：先按 requestId 返回已耐久全等结果，再仅对 fresh 请求以 journal durable identity 或 directory identity 判定可写，最后 append；staged mutation继续由 active assignment 反绑，只有 `ensureSession` 可建立目录身份。验收：全部 control/staged 变体对未知或已删除 id 稳定 not-found 且零追加，并发 create/delete、响应丢失、连续重启及删除后的合法 exact replay 均收敛。**实施证据：**C30-01 增加 advancement request 耐久查询与 adapter 身份源，普通 control 改用真实 `sessionExists`；unknown/deleted fresh write 在权威 append 前稳定 `not-found`，既有 request 在目录身份移除或删除后仍先全等回放。owner-kernel 直接测试 10/10、CLI 本地域生产场景定向测试 1/1 通过，staged 路径未改。 | 已验证 |
| U30-04 | **P1｜工作量大｜来源 P30-04。** `rubricScope:"local"` 同时移除 catalog 与 publication；local assignment 也因无 `GlobalStatePort` 不注入 `globalQuery`。现有 `ExecutorVersionInventory` 仅声明三类 revision，`FileExecutionSnapshotVersionStore` 只保存 inventory/device digest 与 revision，没有 skill/rubric/prompt index 内容引用或本地只读端口，故既有同步资产在 advancement、skill window 与 prompt 消费链均不可见。**根因收敛记录：**原记录只归因于 advancement 组合且评为中；生产图证明三类资产的冻结快照本身没有可消费 read model，现将根因上移到既有 S4 execution snapshot 的内容闭包并据跨合同、安装与三类消费者改为大；不恢复任何全局写或新通用同步设施。 | S4 执行快照只闭合了资产版本元数据，没有把同版本的内容寻址 index 作为可验真的非权威快照安装并暴露为窄只读能力；D30 因而既不能消费缓存，也不能在不取得 GlobalState 的前提下装配本地域消费者。 | **生产端：**execution snapshot/version installation、ArtifactStore、local advancement 与 assignment runtime。**类型组合：**skill/rubric/prompt index 的有/无/过期、revision/digest 错绑、正文缺失/损坏、local-draft 与全局保存拒绝。**消费者：**rubric contract builder、skill/window lookup、prompt asset lookup、restart。**异常终态：**合法缓存被忽略而重复生成草案；坏缓存不得成为权威或阻断 local-draft。**测试：**三类 index/content、双拓扑、重启、local-draft 即时生效、全局写零副作用。**受影响审查项：**IR30-21、IR30-23、IR30-33～IR30-34。 | 在既有 S4 execution snapshot 安装链中增加一份与 inventory 三类 revision 全等绑定、正文落现有 ArtifactStore 的签名内容寻址 index snapshot，并以窄只读 `ExecutionAssetCatalogPort` 暴露，不引入 GlobalState 或新同步 owner；local advancement、skill window 与 prompt consumer 只经该端口读取。缺失、过期、错绑或正文不可验时按无匹配继续 local-draft，绝不返回伪内容；global save/write 仍在副作用前拒绝。验收：三类缓存命中/缺失/过期/损坏、重启和两生产根结果全等，local-draft 立即生效且零全局写。**实施证据：**C30-02 新增签名 path-free `ExecutionAssetSnapshot/Bundle`、ArtifactStore 正文安装与窄 `ExecutionAssetCatalogPort`；inventory 三类 revision 反绑同一 snapshot，local rubric 与 runtime query 只读缓存，坏/缺缓存降为无匹配。core/owner-kernel 上游构建通过，execution asset 与 rubric 定向测试 5/5 通过，现行规格同步。 | 已验证 |
| U30-05 | **P1｜工作量中｜来源 P30-05。** 当前 `localConversationOwnerRuntime` 确实不构造 GlobalState/delivery/participant，`globalPublishing:false` 也会拒绝 global mutation；真实生产图尚未出现全局副作用。但 `LocalConversationOwnerPort` 公开完整 `ConversationProtocolRuntime`，现有 S7 只检查 `never/false` 声明与 owner 参数类型，不扫描 local 生产闭包的 import、构造、实例、binder 和调用，候选违规可绿色通过。**根因收敛记录：**原记录把共享 protocol 的运行时拒绝本身判成第二安全语义并要求重做 capability 判别；当前实例事实证伪该扩面，现收窄为内部端口过宽与结构门禁不覆盖真实构造边界，评级/工作量保持 P1/中。 | 构造隔离已在当前组合中成立，却没有由 local 专用暴露面和针对真实生产闭包的结构 gate 机械固定；类型声明检查无法阻止后续 import、装配或 binder 漂移。 | **生产端：**local runtime/assembly、两个生产组合根、shared protocol 的 local 使用面。**类型组合：**GlobalState、DeferredGlobalIntent、anchor governor、global publisher/delivery/store 与合法 session、ArtifactStore、只读 cache 能力。**消费者：**S7 lint/CI 与 internal conformance port。**异常终态：**违规构造或暴露可在门禁绿色时获得全局能力；当前合法 local 与 anchor 路径不得误杀。**测试：**真实 import/constructor/instance/binder/call/port exposure 变异及合法正例。**受影响审查项：**IR30-03、IR30-25、IR30-32～IR30-34。 | 将 `LocalConversationOwnerPort.protocol` 收窄为 local session/run/conformance 所需接口，省略 global binder 和全局 mutation 面；保留 shared protocol 内核及其 anchor 分支。扩展现有 S7 AST gate 到 `localConversationOwnerRuntime`、assembly 与两生产组合根的有限闭包，拒绝禁用端口/Store 的 import、构造、注入、binder/call 和向 local port 暴露，允许 SessionState、ArtifactStore、permission/execution cache 只读能力。验收：每类真实违规变异 fail-closed，合法 local/anchor 装配零误杀且当前运行语义不变。**实施证据：**C30-04 `LocalConversationProtocolPort` 冻结为六项 session/read 能力，完整 runtime 不再从 local port 逸出；现有 S7 gate 直接核对 local runtime、assembly 与两个生产构造点，拒绝禁用 capability、binder、错 owner、缺失/额外注入。实际 gate 通过，15 项 S7 直接测试含新增真实变异全部通过。 | 已验证 |
| U30-06 | **P1｜工作量大｜来源 P30-06。** 当前证据只有一次 local run/少量 SessionState smoke、一个 mock 组合根和声明形状 gate；没有同一 conformance 套件驱动 anchor/local，也未覆盖 local cancel/confirmation/uncertain/advancement/finality、两生产根、八 topology exact-set、失败回滚和连续恢复。U30-02～U30-05 的生产缺陷均落在这些空白。**价值裁决记录：**保留独立 P1/大证据根因；八配置只证明装配 exact-set，完整功能/故障矩阵只运行两条生产根，禁止将乘积扩大到所有配置。 | D30 的核心正确性、安全性和耐久性没有绑定当前实现的同一有限 conformance 证据；anchor 既有测试、local smoke 和声明自检都不能证明 local domain、消费端、缓存与能力差异。 | **生产端：**anchor/local owner-protocol、anchor+executor 与 executor-only 根、八 topology 装配。**类型组合：**create/list/session、run/cancel/confirmation/uncertain、advancement/evidence、content/final、资产缓存、workspace 两形态、global isolation。**消费者：**共享 conformance、S7 gate、单元提交门禁。**异常终态：**半提交、响应丢失、连续重启、启动回滚和 stop 可能绿色逃逸。**测试：**复用现有 owner/protocol 场景与 fault hooks，不建 runner。**受影响审查项：**IR30-22、IR30-27、IR30-29～IR30-30、IR30-33～IR30-34。 | 把现有 owner/protocol 场景参数化为 anchor/local 共用表，在真实 anchor+executor 与 executor-only 组合根运行完整但有限的功能/故障矩阵；八配置仅断言 local owner、cleanup、依赖与 internal port exact-set。矩阵必须直接覆盖 U30-02 的交互/final consumer、U30-03 的 identity guard、U30-04 的三类只读缓存、U30-05 的真实结构变异、EX30-01 的同一物理日志与 domain 私有 guard 边界，以及 workspace 有/无、响应丢失、崩溃恢复与 stop。验收：同一实现指纹上双域差异只含 identity/capability/cache，两生产根全部场景收敛，八配置装配全等，每个 U30-02～U30-05 反例都使对应既有验证入口失败且 EX30-01 的重开条件均不成立。**实施证据：**C30-05 新增 anchor、同机 local、executor-only 三配置共享 session/history 合同与八 topology exact-set；既有 U30-02～U30-05 直接场景按同一生产入口闭合 interaction/finality、缓存与能力反例。真实 mesh 组合测试发现并修复 anchor-only 对 executor log/resource getter 的提前求值，executor 专用 ledger 构造边界同时收紧为必需能力；双拓扑 conformance、共享合同 5/5、八配置 18/18、S7 门禁与 15 项结构变异均通过。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX30-01 | 原主张：anchor+executor 中两个 `ConversationAssignmentLedger` 对象构成两个设备账本 owner，会导致 local activation 对 data plane 不可见，并需合并为单实例。已验证：两对象不拥有独立文件、维护线程或终态事实，均经同一 executor `AuthorityCommitLog`、同名 durable projection 和日志锁读写；data-plane 绑定的 ledger 会从同一日志折叠 local activation。两 domain 的 runtime-binding guard 仅在各自 fresh dispatch 前校验其 protocol 私有 binding，不能安全合并成一个共享内存 registry。 | 适用于当前 anchor+executor 的两个无生命周期 facade 及 executor-only 的单 facade；唯一耐久 owner 是共享 executor log/projection，D30 要求的是同一物理账本与逻辑域隔离，不要求共享一个带 domain 私有 guard 的 JS 对象。删除 U30-01，禁止为“对象恰一”改造组合根。 | `local-conversation-owner.ts` 的显式 ledger 选择、`conversation-protocol-runtime.ts` 的 domain binding guard、`assignment-ledger.ts` 的 log-backed select/transact、`commit-log.ts` 的 projectionId 复用、`executor-data-plane-runtime.ts` 的同日志读路径；2026-08-06 当前生产图。 | 任一 facade 改为独立物理日志/投影、出现同一 assignment 的跨实例不可见或冲突耐久终态、对象新增独立后台/lifecycle owner，或 data plane 不再从共享日志重建 binding。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## U30-02～U30-06 专项固定矩阵

> 修复、直接验证、专项只读审查和四路冷启动对抗均以本矩阵为固定边界；发现真实反证时先扩充矩阵并退回实现阶段。EX30-01 只核对重开条件，不实施单 ledger 对象改造。

| 编号 | 问题与场景 | 唯一事实源 / 稳定身份 | 线性化、终态与零副作用边界 | 必须取得的直接证据 | 当前结论 |
| ---- | ---------- | --------------------- | ---------------------------- | -------------------- | -------- |
| F30-01 | U30-03 普通 control：九类 SessionState 写、未知/已删除会话、并发 create/delete、响应丢失与 exact replay | directory identity + journal durable identity；requestId | exact replay 先于 fresh identity guard；fresh unknown/deleted 在 append 前 not-found；delete 竞态由同一 journal 事务裁决 | 全 mutation 联合的 unknown/deleted/replay/竞态正反例 | C30-01：生产 callback 已改为真实 identity，定向正反例与冻结指纹专项复核通过 |
| F30-02 | U30-03 advancement journal 与 staged task-list/segment | advancement requestId；active assignment binding | advancement fresh write 复用同一 identity guard；exact replay 保持全等；staged 继续仅由 active assignment 反绑 | advancement unknown/deleted/replay/竞态及 staged 不回归 | C30-01：advance exact replay/unknown/delete 直接测试通过，staged 未改；冻结指纹专项复核通过 |
| F30-03 | U30-04 skill index/content：有、缺、过期、错 revision/digest、损坏、重启、local-draft | inventory `skillsRev` + 签名内容寻址 index + ArtifactStore digest | 安装时版本全等；读取只接受可验内容；坏/缺缓存按无匹配，不产生全局写且不阻断 local-draft | 双生产根 skill window/read 正反例 | C30-02：snapshot/bundle 安装与 skill catalog 正反例通过；冻结指纹双根专项复核通过 |
| F30-04 | U30-04 rubric index/content 与 advancement | inventory `rubricsRev` + 同一 execution asset snapshot | rubric 命中只读缓存；错绑/损坏降为无匹配；local draft 只入本地 session state，全局保存构造期不可达 | advancement contract/cache/draft/restart 正反例 | C30-02：local rubric catalog 与坏/缺正文降级测试通过；冻结指纹专项复核通过 |
| F30-05 | U30-04 prompt index/content | inventory `promptAssetsRev` + 同一 snapshot 与 ArtifactStore | prompt consumer 只读冻结版本；坏/缺内容不伪造命中、不阻断既有本地执行 | prompt 命中/缺失/损坏/重启及零全局写 | C30-02：同 snapshot/inventory 绑定及严格 bundle 校验已落地；冻结指纹生产 consumer 专项复核通过 |
| F30-06 | U30-02 pending interaction：read/allow-once/deny、ticket answer、取消/迟答、响应丢失与 stop | observer + assignment interaction ledger；assignmentId/requestId/ticket | 只列读权威 pending；既有 ticket 决定 resolve；取消/迟答由 ledger 终态裁决；stop 后零消费者任务 | internal-only port 的确认/拒绝/竞态/恢复证据 | C30-03：pending 只读选择与现有 durable ticket answer 接入 internal port，定向正反例与冻结指纹专项复核通过 |
| F30-07 | U30-02 status/history 补读 | conversation journal；commitRevision/游标 | 只读权威 history，游标单调；响应丢失重读不制造第二事实 | live/history 全等与连续补读 | C30-03：internal port 直接复用 protocol status/final history，无新状态；冻结指纹专项复核通过 |
| F30-08 | U30-02 committed final、final-outbox、验证失败、效果后响应丢失与连续恢复 | 同一 journal final history + final-outbox；conversationId/assignmentId/commitRevision | `onFinal` 先由 history 验真；现有 outbox 的 published 为唯一消费终态；失败保留 pending 重驱 | 恰一 published、无第二 sink、recovery/outbox 最终为空 | C30-03：local onFinal 权威 history 全等验真，既有 final-outbox 失败保留与恢复测试通过；冻结指纹专项复核通过 |
| F30-09 | U30-05 local runtime/assembly/anchor+executor/executor-only 的禁用能力 import、构造、注入与 port exposure | local 专用窄 port + 有限生产文件闭包 | GlobalState/DeferredIntent/global publisher/delivery/store 在构造期不可达；合法 SessionState、ArtifactStore、只读 execution cache 可达 | S7 真实源码变异与合法正例 | C30-04：有限生产闭包 AST gate 与两构造点 exact-set 已通过真实变异；冻结指纹专项复核通过 |
| F30-10 | U30-05 binder/call 与 shared protocol anchor 分支 | local port capability surface；shared protocol 仍由 anchor 组合使用 | local 不暴露 global binder/mutation；anchor 现有能力不误杀；运行时拒绝不是唯一安全边界 | binder/call/return/re-export 负例及 anchor 正例 | C30-04：local port 六项能力 exact-set，binder/delivery 负例 fail-closed，现有 anchor/S7 正例与冻结指纹专项复核通过 |
| F30-11 | U30-06 anchor 与 local 共用 owner/protocol 场景 | 同一有限 conformance case 表；domain identity 参数 | create/list/session/run/cancel/confirmation/uncertain/advancement/content/final 共享断言，差异仅限 identity/capability/cache | 双域同表直接合同/场景测试 | C30-05：anchor、同机 local、executor-only 共用身份/历史表 5/5；run/final、interaction、advancement 与 cache 复用各自直接生产场景；冻结指纹专项复核通过 |
| F30-12 | U30-06 anchor+executor 与 executor-only 两生产根的必要故障矩阵 | 真实生产组合根、共享 executor log/artifacts | 响应丢失、连续恢复、启动回滚与 stop 在两根收敛；不把完整故障矩阵乘到八配置 | 两生产根功能/故障场景 | C30-05：真实 in-process/mesh conformance 1/1，local owner rollback/final 与双域共享表通过；anchor-only 惰性能力反例修复后通过；冻结指纹专项复核通过 |
| F30-13 | U30-06 八 topology 与 workspace 有/无 | `planServeTopology` 与真实装配 descriptor exact-set | 只验证 local owner、cleanup、依赖与 internal port 适用集合；disabled 配置零装配 | 八配置参数化 exact-set | C30-05：八配置 local owner/cleanup exact-set 与 disabled 零装配共 18/18 通过；workspace 有/无由双根 conformance 直接覆盖；冻结指纹专项复核通过 |
| F30-14 | EX30-01 与 U30-02 直接交界 | 共享 executor `AuthorityCommitLog`/projection；domain 私有 runtime-binding guard | 两 facade 仍无独立生命周期/耐久事实，data plane 仍从共享日志重建；interaction/finality 修复不改变该边界 | 两生产根日志/投影/guard 装配事实核对 | C30-05：local wrapper 仍复用同一 `authority.executorLog`，anchor-only 只移除不可用 getter 求值；无新日志、投影或 facade 生命周期，EX30-01 未触发重开；冻结指纹专项复核通过 |
| F30-15 | U30-02↔U30-03、U30-04↔U30-05、U30-02～U30-05↔U30-06 组合 | 上述各行唯一事实源与端口 | identity guard 不破坏恢复 replay；只读缓存不扩张全局能力；conformance 直接覆盖四项反例 | 交界专项只读事实链与四路对抗 | C30-01～C30-05：exact replay、internal consumer、只读 cache、构造隔离与双根配置证据已同时落地；冻结指纹交界专项与四路对抗通过 |

## U30-02～U30-06 反证账

> 新发现首次出现即使用稳定编号登记；每项只允许以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。

| 编号 | 首次出现的反证与对应矩阵 | 处置 | 证据 | 状态 |
| ---- | ------------------------ | ---- | ---- | ---- |
| C30-R01 | F30-12：真实 mesh 组合根在 anchor-only `setupAuthorityRuntime` 上构造 owner runtime 时提前求值 executor log/resource getter，说明原 conformance 空白会使合法 anchor-only 装配失败。 | 同根并入 U30-06；将 owner runtime 的 executor 能力改为角色作用域可选，只有 local executor ledger 构造时才同时要求 log/resources，并增加不得求值禁用 getter 的直接反例。 | `s7-environment-conformance.test.ts` 真实 mesh 根、`conversation-owner-runtime.test.ts` anchor-only getter 反例、CLI 类型检查本次路径零新增错误。 | 修复后复核通过 |

## U30-02～U30-06 专项只读审查与四路冷启动对抗

> 基线为当前专项交付物指纹；四路分别从源码与现行合同重新推导，不复用其他路的结论。工作台证据写入不属于交付物，不改变该指纹。

| 角色 | 独立推导的 owner / 终态 | 主动构造的反例与事实裁决 | 覆盖矩阵 | 结论 |
| ---- | ----------------------- | ------------------------ | -------- | ---- |
| A30-01 device ledger/data-plane 单一所有权 | executor-enabled 根只构造一个 `executor-authority` 物理日志；anchor/local ledger facade、ticket registry 与 data plane 均注入该日志，facade 无独立维护线程或投影 owner。 | 独立日志、不同 projection、facade 新 lifecycle、data plane 改读另一事实源均会触发 EX30-01；当前源码只把 anchor-only 的禁用 getter 改为惰性，未新增日志/投影/lifecycle，反例不可达。 | F30-06～F30-08、F30-12、F30-14～F30-15 | 通过；EX30-01 重开条件不成立 |
| A30-02 本地域 interaction/finality 与 SessionState 生命周期 | directory/journal identity 是 fresh SessionState 写判据，requestId durable replay 先行；interaction 终态仍由 assignment ledger ticket 裁决；final 先由同一 history 验真，再由既有 final-outbox 记录唯一 published。 | 未知/已删除 fresh 写、删除后 exact replay、取消后迟答、非权威 final、consumer 效果后响应丢失、连续恢复与 stop 分别映射到 guard、ledger terminal 或 pending 重驱；没有第二 sink 或孤儿 session 写入口。 | F30-01～F30-02、F30-06～F30-08、F30-11～F30-12、F30-15 | 通过；U30-02、U30-03 无同根残留 |
| A30-03 advancement 只读缓存与构造期能力隔离 | inventory 三类 revision、签名 path-free snapshot 与 ArtifactStore digest 共同确定缓存版本；local consumer 只持窄 catalog/session port，global mutation、delivery、binder 与 writable Store 不在 local 构造闭包。 | 错 revision/digest、缺/坏正文、重启及 local-draft 均降为无匹配且不产生全局写；禁用 capability import/构造/注入/binder/port exposure 由现有 S7 有限 AST gate 拒绝，anchor 合法分支不误杀。 | F30-03～F30-05、F30-09～F30-10、F30-15 | 通过；U30-04、U30-05 无第二事实源或结构债务 |
| A30-04 双域/双拓扑 conformance 与范围价值 | 同一 owner/protocol 合同在 anchor、同机 local、executor-only 三配置运行；真实 in-process/mesh 根覆盖 workspace 有/无与 anchor-only；八配置仅核对装配 exact-set，故障矩阵不与配置做无价值笛卡尔积。 | disabled/anchor-only 误装配、禁用 getter 提前求值、两根结果漂移、响应丢失、重启、rollback/stop、S7 结构变异均有直接失败入口；C30-R01 已在本指纹修复，未新增 runner、公开离线 surface 或全局能力。 | F30-11～F30-15及 U30-02～U30-05 全部直接反例 | 通过；范围成比例且 U30-06 闭合 |

**差异审计：**C30-01～C30-05 均由当前源码与对应直接证据复核通过；C30-R01 为修复后复核通过；历轮无其他反证，四路结果并集无未处置或消失发现。

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V30-01 | U30-02～U30-05 直接功能与合同闭包 | owner-kernel SessionState、CLI interaction/final、execution asset/rubric、local owner 定向测试 | C30-01～C30-04 对应生产文件、合同与直接测试 | 修复直接验证 / 约 2 分钟 | SessionState 10/10、本地域 identity 1/1、interaction/final 9/9、asset/rubric 5/5；core、owner-kernel、executor 构建/类型证据有效 | 冻结前同一相关输入；后续未修改对应实现 | 有效 |
| V30-02 | U30-06 双域、两生产根与八配置 | 双域 shared conformance、真实 S7 in-process/mesh、owner runtime、role topology 定向测试 | owner-domain、S7 environment、owner runtime、topology 与生产装配 | 修复直接验证 / 约 1 分钟 | 当前输入 shared/双根/惰性边界 6/6；八配置所在 topology 18/18 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5` | 有效 |
| V30-03 | U30-05 结构隔离与派生资产 | `pnpm s7:lint` | S7 gate、真实变异测试、canonical registry golden 与相关生产源码 | 派生资产预检 / 103.7 秒 | 实际 gate 通过，15/15 变异测试通过，golden 一致 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5` | 有效 |
| V30-04 | 当前源码与导出可消费 | `pnpm build`（单次，450 秒硬截止） | 工作区 17 个可构建包与当前 lockfile | 最终构建证据 / 296.1 秒 | 17/17 成功；CLI 直接类型检查本次路径零新增错误，仍仅有既有 8 个配置编辑器基线错误 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5` | 有效 |
| V30-05 | 冻结一致性与差异卫生 | 聚合 50 文件 SHA-256；`git diff --check` / `git diff --cached --check` | 相对 `2526d6e8` 的专项交付物，排除工作台与此前独立 skill 修正 | 冻结准备 / <1 分钟 | 指纹已冻结，空白错误为 0；专项与四路审查期间未修改交付物 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5` | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-30.gen-1 -->
