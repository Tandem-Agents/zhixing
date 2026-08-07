# 单元登记:第 30 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:30
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-06
- **登记来源**:用户要求将第 30 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U30-05～U30-07 已验证；U30-02～U30-04 与 EX30-01 既有结论继续复用；未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅冻结 U30-05～U30-07 专项交付输入；全单元终审尚未开始）
- **交付物文件集**:相对第 30 单元基线 `2526d6e8` 的 53 个生产、测试与合同路径；工作台、`AGENTS.md`、`agent-board.md` 与 `.agents/skills/project-onboarding/SKILL.md` 不入本专项交付物
- **当前交付物指纹**:`sha256:15b4e287ba13983e2cc2d56edf5623ac9067f6f754ec8fd6d0d49931ec3a89b3`（按排序后的 `路径\0文件 SHA-256` 聚合）
- **架构来源**:`distributed-runtime-charter.md`、`specification.md`、第 30 单元定稿开发清单、当前生产装配与源码、第 30 单元独立审查清单

## 固定边界

- **功能范围**:在每个 executor-enabled topology 内装配 internal-only 的设备本地域 conversation owner，复用同一 owner 内核、执行日志、ArtifactStore、data plane、设备容量与 owner-services，闭合 SessionState、run/cancel/confirmation、task/segment/advancement、content/finality 和恢复
- **架构不变量**:每台执行设备恰一 local owner；本地域与 anchor 域共享物理执行基础设施但逻辑流隔离；全局写、发布、投递与 transfer 构造期不可达；合法只读 skill/rubric/prompt cache 可消费；内部终态与恢复必须完整收敛
- **验收条件**:EX30-01 的排除前提持续成立且 U30-02～U30-07 按正式验收条件完成并更新为已验证；随后按独立流程完成受影响范围复审、两轮冻结终审、独立功能审查与单元提交验证
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
| U30-05 | **P1｜工作量小｜同根重开来源 P30-07（原 P30-05）。** `localConversationOwnerRuntime(authority: AuthorityRuntimeStack)` 的唯一参数仍是含 `globalState`、participant/delivery、publish coordinator 与其它 anchor 能力的完整组合根对象；`access-surfaces`、`executor-role-runtime` 两个生产点都把该对象原样传入，executor-only 还分别构造 ledger 与 assembly 的 local runtime。现有 `inspectLocalConversationOwnerIsolation` 只检查返回 contract 的 `never`、assembly options 与 `LocalConversationOwnerAssembly.create` 的外层键，未检查 runtime 工厂参数和两根传入工厂的依赖 exact-set，因此禁用能力已进入构造闭包且候选扩权可绿色通过。**价值裁决记录（2026-08-07）：**原结论为 P1/中并要求通用符号解析；对立复核把根因收窄为生产工厂已接收完整 authority，改为 P1/小。当前复核确认该收窄成立，不恢复通用调用图；用户输出尚未失真，但当前必要安全合同和最优架构均未达标。修复后仅在 local 工厂参数、两生产根对象键或返回 port 再次包含禁用能力时重开。 | 能力裁剪发生在 `localConversationOwnerRuntime` 的返回投影之后，而不是生产根向本地域 owner 交付依赖的构造边界；类型和 S7 门禁共同把“未读取禁用字段”误作“物理未注入”。 | **生产端：**`conversation-owner-runtime.ts`、`access-surfaces.ts`、`executor-role-runtime.ts`、local ledger/assembly 与现有 S7 gate。**类型组合：**合法 local domain/epoch、signer/verifier、executor log、ArtifactStore、local admission、executor capability/resource、只读 execution asset catalog、环境/manifest 校验及禁用 GlobalState/publish/delivery/participant/transfer；两生产根、合法 anchor 分支。**消费者：**local protocol/ledger/assembly、S7 lint/CI。**异常终态：**候选维护在门禁绿色时取得或夹带全局能力，或两次 local runtime 构造发生依赖漂移。**测试：**工厂参数和两根对象键的新增、删除、替换、spread/别名夹带、executor 根双构造漂移及合法 exact-set/anchor 正例。**受影响审查项：**IR30-03、IR30-25、IR30-32、IR30-34。 | 新建仅声明当前实际读取字段的 `LocalConversationOwnerRuntimeDependencies`，禁止以 `AuthorityRuntimeStack`、索引签名或 spread 作为运行值入参；两生产根各以显式对象字面量传入同一冻结键集，executor-only 先构造一个 local runtime 并同时交给 ledger 与 assembly。扩展现有 `inspectLocalConversationOwnerIsolation`：核对工厂参数名义合同、两生产调用的参数 object-literal exact-set、executor 根单实例复用，以及现有禁用 import/binder/port exposure；不追踪任意间接调用。验收：依赖键增删替换、spread/别名夹带、完整 authority 直传、双构造漂移和五类禁用能力均 fail-closed；两根合法 local 依赖、anchor runtime、SessionState/ArtifactStore/只读 cache 零误杀。**实施证据：**C30-06 新建 `LocalConversationOwnerRuntimeDependencies` 冻结 Pick 合同（19 键），工厂入参收窄为该名义类型；`access-surfaces` 与 `executor-role-runtime` 两根各以显式对象字面量传入同一键集，executor-only 先构造一次 `localOwnerRuntime` 并同时交 ledger 与 assembly；`inspectLocalConversationOwnerIsolation` 扩展为核对依赖合同键集、工厂参数名义类型、每根恰一次构造、字面量 exact-set（键增删/spread/简写/非字面量直传 fail-closed）、create `owner` 与 executor ledger `authority` 同引唯一构造，既有 never/禁用 import/binder/port 检查保留。CLI 类型检查本次路径零新增错误（既有 8 个配置编辑器基线错误不变）；`pnpm s7:lint` 全绿（结构门禁 + 15 项变异测试 + registry golden 一致）。冻结指纹只读复核确认两个生产根各恰一构造，executor-only 的 ledger/assembly 同引唯一 runtime，EX30-01 未触发。 | 已验证 |
| U30-06 | **P1｜工作量中｜同根重开来源 P30-09（原 P30-06）。** SessionState、interaction/finality、缓存和资源已有组件证据，八 topology 也已有装配 exact-set；但 `owner-domain-conformance` 仍直接创建 `ConversationProtocolRuntime`，anchor surface 测试 mock `LocalConversationOwnerAssembly.create`，S7 environment 不装配 local owner，executor-only 没有对应真实 assembly 行为入口。故旧 F30-11～F30-12 把“组件场景 + mock 生命周期 + topology 标签”误记成两生产根 conformance。**价值裁决记录（2026-08-07）：**原要求曾扩为两根重复完整故障矩阵；对立复核已收窄为只补组件证据不能证明的生产交界，P1/中。当前事实确认该收窄成立：用户体验与架构提交保障均未达标，但不重跑组件内部矩阵、不扩成八配置笛卡尔积。 | 证据没有把两生产根的精确依赖合同、真实 `LocalConversationOwnerAssembly` 行为、internal port 与 start/stop/recovery 连成同一可失败链；静态装配与组件语义各自为绿仍不能证明生产交界。 | **生产端：**anchor+executor、executor-only 两根，`LocalConversationOwnerAssembly.create`、现有 root/fixture/S7 gate。**类型组合：**run→interaction/final、advancement/cache、workspace 有/无、效果后响应丢失/重启、stop；八配置 exact-set 只复用。**消费者：**共享 conformance 表与单元提交门禁。**异常终态：**根调用存在但依赖漂移、port 不可消费、恢复或停机断裂，组件测试仍全绿。**测试：**两份精确生产依赖 profile 驱动同一真实 assembly 小表；根调用和 lifecycle 由现有有限结构门禁反绑，不复制组件内部故障矩阵。**受影响审查项：**IR30-22、IR30-33、IR30-34。 | 把现有 owner-domain fixture 改为以 anchor+executor、executor-only 两份精确生产依赖 profile 实际调用 `LocalConversationOwnerAssembly.create/start/port/close` 的共享小表；只覆盖一次 run→interaction/final、一次 advancement/cache、workspace 有/无、一次效果后响应丢失→重建恢复及 U30-07 stop。扩展同一 S7 有限规则，机械反绑两根的 builder 调用与 `create → start → stop/close` cleanup，不分析任意调用图；anchor surface 只保留 root glue 正例。U30-02～U30-05 的组件矩阵与八配置 topology 直接复用。验收：两 profile 的用户可见/耐久终态全等，差异只限 domain identity、workspace 与 cache；删除或错序任一根 lifecycle，或移除 interaction/finality、identity guard、cache、依赖 exact-set、shutdown drain 时，小表或现有 gate 至少一处稳定失败；不新增 runner。**实施证据：**共享 fixture 以 anchor+executor（真实 workspace）和 executor-only（无 workspace）两份 profile 构造真实 assembly；同一小表写入并读回 advancement state、耐久产生并以 internal no-surface consumer 终结 confirmation、等待 final、读取只读 rubric cache，随后 close 并以同 home 重建，证明 provider 零重跑且 final/history 全等。当前生产 profile 定向测试 2/2 通过；S7 继续机械反绑两根各一次 create/start/close，既有组件矩阵与八配置未复制。 | 已验证 |
| U30-07 | **P1｜工作量中｜来源 P30-08，同根反证 C30-R05。** `stopAccepting` 仅令 `createConversation` 拒绝，已取得 port 仍直接暴露可写 `ConversationManager`、`AdvancementController`、consumer answer 及含可写 `sessionState/ensureSession` 的 protocol；`close` 用两个布尔值把实例先标 closed，再先停 recovery loop、直接 `disposeAll`。后者明确不执行 abort/drain；现有 `abortAllAndWait` 到期不报告 drain 是否完成。C30-R05 进一步证明：owner 取消已耐久后，本地 run 终结路径仍可先将 executor ledger 写成 `failed`，使同一取消无法生成 `CancelProof`，owner 永久停在 `cancel-requested`。**价值裁决记录（2026-08-07）：**对立复核确认生产 shutdown 当前可达，保持现状、改规则或只插入一次 `abortAllAndWait` 均不能闭合；P1/中保留。用户体验和架构均未达标；修复后仅在栅栏旁路、关闭假成功、取消/失败交接再次楔住，或 active/confirmation/final/resource 欠账失去耐久重驱时重开。 | assembly 没有一个同时拥有全部可写 facade、在飞任务和恢复 owner 的生命周期状态机；共享 conversation 执行链又未把“owner 取消已线性化”作为 executor 失败/封包前的让位判据。准入栅栏、耐久取消、executor 终结、CancelProof、final/outbox、资源与 dispose 因而顺序脱节。 | **生产端：**local assembly/port、manager、protocol recovery、本地 conversation run、executor ledger、in-process dispatcher、advancement recovery、interaction/final-outbox、local resource owner 与两根 cleanup。**类型组合：**idle、active/queued turn、pending confirmation、owner cancel 与 provider aborted/failed 竞态、final 暂态失败、效果/响应丢失、并发/重复 stop、启动中 stop、连续重启及栅栏后每类 port 写。**消费者：**internal conformance port、CancelProof 提交、startup rollback、normal shutdown。**异常终态：**栅栏后新增权威写；owner 已 cancel 而 executor 先 failed，导致 `cancel-requested` 永不终结；close 假成功后仍有运行体/后台 promise/local active lease；pending final 被误报完成或丢失。**测试：**全写面栅栏、重复 close、active/queued/confirmation drain、取消栅栏与 run 返回的全部先后顺序、final/resource 暂态失败、响应丢失、连续重启恰一与 provider 零重跑。**受影响审查项：**IR30-30、IR30-34。 | 将 assembly 收敛为 `created → starting → ready → closing → closed` 状态机和单一 `#closing` promise；port 不再返回 raw manager/protocol/advancement/consumer 可写对象，冻结只读 view 与逐项命令 wrapper，所有 mutation/answer/admission 在副作用前共用 `requireReady`。`close` 先原子进入 closing 并等待 start，再以可判定 drain 结果收束 active/queued/confirmation；恢复 owner 保持存活，显式驱动 protocol 与 advancement 到稳定检查点，只核对本地域 assignment 的 manager、final/outbox 与 lease。复用现有 owner cancel fence、executor `hasPendingOwnerCancellation` 与 CancelProof 原语：取消耐久后立即驱动同一 fence 到 executor；本地 run 在 `failExecution`、封包或成功终结前检测该事实并让位给取消路径，禁止以 `failed` 覆盖已成立取消。只有零 active/queued、零 in-memory recovery、final/resource 已终态时才停 loop、dispose 并成功；期限内不能证明时停止已拥有后台、拒绝同一 closing promise，并保留原耐久 pending 供重启重驱。验收：栅栏后所有写零副作用；取消与 run 返回任意先后均最终产生并提交唯一 CancelProof，owner 到 `cancelled`、executor 不落竞争 `failed`、usage 恰一终结；idle/active/queued/confirmation、暂态 final、响应丢失、启动中/并发/重复 stop 均无假成功或后台遗留，成功关闭零本地域 active lease/outbox，失败关闭连续重启后最终恰一且 provider 不重跑。**实施证据：**assembly 已改为单一 lifecycle/closing promise、冻结读面和统一命令栅栏；close 保持 recovery 存活到 manager/final/assignment/recovery/local lease 检查点后才停 loop/dispose，失败保留耐久欠账。protocol 以终态串行队列和 shutdown scheduling fence 让 cancellation 先于 fail/seal/commit，并立即驱动 executor fence；observer 仅接受全等耐久终态或更强的 authority cancellation，其他冲突仍 fail-closed。lifecycle 全写面、start/idle/active/queued/confirmation/失败重启场景均已通过，pending-confirmation 当前单例 1/1、observer 竞态 6/6；C30-R05～R06 均复核闭合。 | 已验证 |

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

## U30-05～U30-07 收敛固定矩阵

> 本矩阵仅收敛当前重开的 U30-05、U30-06 与新增 U30-07；U30-02～U30-04 直接复用，EX30-01 只核对重开条件。每格均须由同一问题行的方案与验收唯一解释。

| 编号 | 场景与生产入口 | 稳定身份 / 耐久事实 | 线性化、拒绝与消费终态 | 直接验收 |
| ---- | -------------- | ------------------- | ------------------------ | -------- |
| F30-16 | U30-05：anchor+executor 的 `local-conversation-owner` assembly 与 executor-only 的 ledger + assembly | 一份 `LocalConversationOwnerRuntimeDependencies` exact-set；localDomainId/ownerEpoch/governorEpoch；executor-only 同一 local runtime 实例 | 两根在调用工厂前完成能力裁剪；显式对象字面量是构造边界，executor-only ledger/assembly 不得各取一份可漂移依赖 | 两根合法 exact-set；键新增、删除、替换、spread、完整 authority 直传和双构造均 fail-closed |
| F30-17 | U30-05：GlobalState、publish、delivery、participant、transfer 的直接或夹带注入；合法 anchor runtime 与 local SessionState/ArtifactStore/cache | S7 现有有限源码闭包和工厂参数名义合同 | 禁用能力在 local 工厂调用前不可达；返回 `never` 不是替代证据；合法 anchor 分支与只读 local 能力不得误杀 | 参数/对象键/禁用 import-binder-port 真实源码变异及 anchor/local 正例 |
| F30-18 | U30-07：idle、start 中 stop、并发/重复 stop 与栅栏后写入 | assembly lifecycle state + 唯一 starting/closing promise | 首次 stop 原子线性化为 closing；所有命令 wrapper 在副作用前拒绝；重复调用取得同一结果 | create、session mutation、turn、advancement、interaction answer/cancel 的栅栏负例；idle/start/重复 close 正例 |
| F30-19 | U30-07：active/queued turn、pending confirmation、owner cancel 与 provider aborted/failed 的全部先后顺序、drain 成功或期限耗尽 | durable run/assignmentId、owner cancel fence、executor pending-owner-cancellation、interaction requestId/ticket 与 CancelProof | closing 后不再准入；durable cancel 立即驱动同一 executor fence，本地 run 的失败/封包/成功终结必须先让位；成功须 owner `cancelled`、executor CancelProof、busy/pending 为零，期限耗尽不得伪装 closed-success 或丢失原耐久事实 | active/queued/confirmation 取消竞态、取消前后 run 返回、executor failure 让位、CancelProof/usage 恰一、drain outcome、零新写与连续恢复 |
| F30-20 | U30-07：final 暂态失败、效果/响应丢失、resource finalization、停机与重启 | conversation final history + final-outbox published；assignment/resource identity | recovery owner 在 drain 后仍存活并驱动到稳定检查点；成功关闭须 final/resource 终态，失败关闭保留 pending、停止已拥有后台并在重启恰一重驱，禁止 provider 重跑 | final 成功/一次暂态失败/效果后响应丢失、active lease、失败关闭→连续重启、零后台 |
| F30-21 | U30-06：anchor+executor 与 executor-only 两份生产 profile 穿过真实 `LocalConversationOwnerAssembly` | 两根精确依赖 profile；同一 conformance case identity | 相同 run→interaction/final、advancement/cache、workspace 有/无和恢复/stop 断言；差异只限 domain identity、workspace 与 cache | 同一小表实际 create/start/port/close；两 profile 终态全等 |
| F30-22 | U30-06：组件证据、根装配证据和八配置 exact-set 的比例边界 | U30-02～U30-04 直接证据；U30-05 S7 root binding；U30-07 lifecycle；既有 topology descriptors | 组件内部矩阵不重复；同一有限 S7 规则反绑两根 builder 与 create/start/stop/close，八配置只证明适用集合；任一生产交界缺失必须有一处直接失败 | 五项交界的 mutation-to-test 映射；无新 runner、无任意调用图、无配置×故障笛卡尔积 |
| F30-23 | U30-05↔U30-07↔U30-06 与 EX30-01 | 同一 executor AuthorityCommitLog/projection；domain 私有 guard；上述 exact-set/lifecycle/conformance 身份 | 构造收窄不合并 ledger facade；shutdown 不新增事实源；conformance 不恢复公开离线入口、GlobalState 或 transfer | 共享日志/投影/guard 只读核对，EX30-01 重开条件为假 |

## U30-05～U30-07 收敛反证账

> 新发现首次出现即使用稳定编号登记；后续实施与验证只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。

| 编号 | 首次出现的反证与对应矩阵 | 处置 | 当前证据 | 状态 |
| ---- | ------------------------ | ---- | -------- | ---- |
| C30-R02 | F30-16～F30-17：现有 S7 gate 检查 local 返回 contract 和 assembly 外层 options，却不检查 `localConversationOwnerRuntime` 参数仍是完整 `AuthorityRuntimeStack`，旧 C30-04 因而把绿色门禁误作构造隔离。 | 同根并入 U30-05；方案固定为工厂依赖 exact-set、两根显式传入及 executor-only 单实例复用，不扩为通用调用图。 | 冻结依赖合同、两根显式 exact-set、executor-only 单实例复用已落地；S7 对键增删替换、spread/别名夹带、完整 authority、双构造与禁用能力变异均 fail-closed，15/15 与 golden 通过。 | 修复后复核通过 |
| C30-R03 | F30-18～F30-20：仅“调用现有 `abortAllAndWait`”仍不充分；该方法到期后返回且不报告是否 idle，而当前 `close` 又先停 recovery 再 `disposeAll`，可形成关闭假成功。 | 同根并入 U30-07；增加可判定 drain outcome、稳定检查点和成功/失败关闭分流，失败保留耐久 pending 并禁止宣称成功。 | 单一 lifecycle/closing promise、全写面 gate、可判定 manager/protocol/resource 检查点和失败保留 pending 已落地；idle/start/active/queued/confirmation/暂态失败/重启直接场景通过。 | 修复后复核通过 |
| C30-R04 | F30-21～F30-22：旧 F30-11～F30-12 声称双根 conformance 已通过，但实际 `owner-domain-conformance` 直接建 protocol，surface 测试 mock assembly，environment 测试未装配 local owner。 | 同根并入 U30-06；改为两份精确生产 profile 运行真实 assembly 小表，结构 gate/root 测试只负责反绑生产调用与 lifecycle。 | 共享生产 fixture 已让 anchor+executor 与 executor-only 两 profile 穿过真实 assembly 的 advancement、interaction、final、cache、workspace、close 与重启链，当前定向测试 2/2；S7 反绑两根 lifecycle。 | 修复后复核通过 |
| C30-R05 | F30-19：drain 场景下在飞 run 被耐久取消后永不收敛。机制：本地域 in-process 路径中 owner 取消栅栏只写 owner 日志（`cancelAdmitted` 直调 `journal.cancelRun`），executor 账本的 begin/finish 取消只由恢复循环（5s）驱动；被中止的 run 返回 aborted 后本地 run 路径无 job worker 式 `hasPendingCancellation` 让位检查，`failExecution` 先把 executor 账本落 `failed`；此后 `#requestAbort` 因 `phase==="failed"` 拒产 CancelProof，owner 端停于 cancel-requested，恢复每轮重放 queued 输入并重复报错，close 的 recoveryBacklog 永不归零。anchor+executor 同机路径共享同一 run 路径，同样受影响。 | 同根并入 U30-07：这是 F30-19 已锁定的 active-run drain 直接反证，不新增正式问题。取消耐久后立即驱动同一 executor fence；本地 run 在失败、封包或成功终结前复用 pending-owner-cancellation 判据让位，由既有取消恢复生成并提交唯一 CancelProof。现有 `failAssignedRun` 守卫仅阻止 owner 终态被迟到失败覆盖，不能替代 executor 侧取消收敛。 | 已以 protocol 终态串行队列统一 owner cancel 与 fail/seal/commit，让 `cancelAdmitted` 立即复用现有 dispatcher 驱动 executor fence/CancelProof；shutdown scheduling fence 阻止已排队输入在取消之间被恢复重启。active+queued 生命周期反例已翻转为成功关闭，provider 仅执行 active 一次，二者均到取消终态。 | 修复后复核通过 |
| C30-R06 | F30-19：pending confirmation 关闭时，executor authority cancellation 已先写 `cancel-fence`，runtime broker 的本地 abort 随后仍尝试写竞争性的 `run-end` terminal；若 observer 只接受全等 replay，会把正确的权威胜者误报为冲突并阻断 close。 | 同根并入 U30-07：interaction 终态仍由同一 executor ledger 唯一裁决；observer 只在本地 cancel source 遇到已耐久 `cancel-fence`/`abort-ticket` 时承认更强权威终态，其他不全等冲突继续拒绝，不新增第二规则或事实源。 | `conversationInteractionOutcome` 只读权威结果；observer 直接竞态测试 6/6，真实 pending-confirmation close 当前单例 1/1，最终 pending interaction 为空且 provider 只执行一次。 | 修复后复核通过 |

## U30-05～U30-07 四路冷启动对抗复审

> 四路均从现行合同和当前源码独立推导，没有复用旧 F30-09～F30-15 或先前对抗结论；复审期间 U30-05～U30-07 问题行与 F30-16～F30-23 未修改。

| 角色 | 独立事实链与主动反例 | 双向对账 | 结论 |
| ---- | -------------------- | -------- | ---- |
| A30-R05 local 构造依赖与 S7 exact-set | 从总纲“显式本地域合同/by-construction”反推工厂入参，逐项枚举当前函数真实读取的 local identity、log/artifact、admission/capability/resource、cache 与环境校验依赖；再以完整 authority 直传、对象键增删替换、spread/别名夹带、executor 根 ledger/assembly 双构造及禁用能力 import/binder/port 重造绿色假通过。 | U30-05 与 F30-16～F30-17 唯一要求工厂参数 exact-set、两根显式 object literal、executor-only 单实例复用和现有有限 AST 反绑；不追踪任意调用图，合法 anchor/SessionState/ArtifactStore/cache 有明确正例。 | 通过；根因、P1/小和方案比例成立，无新增能力或遗漏变体。 |
| A30-R06 停机 gate/drain/finality/resource 顺序 | 从 D30-06 生命周期顺序与“零后台”反推 owner：先构造 start 中 stop、栅栏后 session/turn/advancement/answer 写、active/queued/confirmation、`abortAllAndWait` 到期假成功、final 一次暂态失败、效果后响应丢失、active lease、重复 close 和连续重启。 | U30-07 与 F30-18～F30-20 以单一状态机/closing promise 关闭全部 raw 写旁路；可判定 drain、恢复存活至稳定检查点、成功/失败关闭分流分别解释全部反例。失败不伪造 published/resource 终态，原耐久 pending 仍由下次 start 重驱。 | 通过；P1/中成立，保持现状或只插入一次 drain 均已被源码排除。 |
| A30-R07 两生产根 conformance 与证据比例 | 从 D30-07 重新核对 `owner-domain-conformance`、surface mock、environment test、两根 create/start/close 源码和现有 S7 root capture；主动删除每根 builder/lifecycle、错配依赖 profile，并分别移除 interaction/finality、identity guard、cache 和 shutdown drain。 | U30-06 与 F30-21～F30-22 把证明责任拆为：真实 assembly 的两 profile 小表证明行为，现有有限 S7 反绑两根 builder/lifecycle，组件矩阵和八配置 exact-set 直接复用；任一反例至少命中一个确定失败入口，不新增 runner 或故障笛卡尔积。 | 通过；P1/中及有限交界表足够且不越界，旧 F30-11～F30-12 的证据误记已由 C30-R04 耐久处置。 |
| A30-R08 产品体验、范围价值与 EX30-01 | 从最小完整产品、双形态平权、构造期安全和停机诚实状态独立判断：U30-05 防止本地域静默取得全局副作用能力，U30-07 防止停机假成功/丢终态，U30-06 只阻断真实组合根证据缺口；再尝试以单 ledger 对象、公开离线入口、transfer/global intent、通用调用图/runner/观测设施扩面。 | 三项均命中当前 D30 必要合同并同时达到范围内用户体验与架构要求；扩面候选均无当前价值且被方案明确排除。两 ledger facade 仍共用同一物理日志/投影且无独立 lifecycle，F30-23 证明 EX30-01 重开条件为假。 | 通过；三项均保留，范围成比例，无未来义务、模糊后置项或 EX30-01 误重开。 |

**当前冻结实证：**A30-R05 重新核对冻结依赖类型、两根 object-literal exact-set、executor-only 单实例及 15 项 S7 变异；A30-R06 重新沿 gate→durable cancel→executor fence→interaction terminal→final/resource checkpoint 检查 idle/start/active/queued/confirmation/失败重启；A30-R07 以两份生产 profile 实际运行 advancement、interaction、final、cache、workspace、close 与同 home 重建；A30-R08 反查禁用能力、公开入口和物理 ledger/log/projection，未发现扩面或 EX30-01 重开事实。四路均绑定 `sha256:15b4e287ba13983e2cc2d56edf5623ac9067f6f754ec8fd6d0d49931ec3a89b3`，结论通过。

**差异审计：**C30-R02～C30-R06 均已“修复后复核通过”；旧 C30-R01 保持“修复后复核通过”，C30-01～C30-05 的既有已验证事实未被本次改写恢复或否定。四路结果与 F30-16～F30-23 双向全等，没有未处置、无依据消失或越界发现。

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V30-01 | U30-02～U30-05 直接功能与合同闭包 | owner-kernel SessionState、CLI interaction/final、execution asset/rubric、local owner 定向测试 | C30-01～C30-04 对应生产文件、合同与直接测试 | 修复直接验证 / 约 2 分钟 | SessionState 10/10、本地域 identity 1/1、interaction/final 9/9、asset/rubric 5/5；core、owner-kernel、executor 构建/类型证据有效 | 冻结前同一相关输入；后续未修改对应实现；后续 U30-05～U30-07 输入变化，由 V30-06～V30-10 替代 | 失效 |
| V30-02 | U30-06 双域、两生产根与八配置 | 双域 shared conformance、真实 S7 in-process/mesh、owner runtime、role topology 定向测试 | owner-domain、S7 environment、owner runtime、topology 与生产装配 | 修复直接验证 / 约 1 分钟 | 当前输入 shared/双根/惰性边界 6/6；八配置所在 topology 18/18 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5`；后续 U30-05～U30-07 输入变化，由 V30-06～V30-10 替代 | 失效 |
| V30-03 | U30-05 结构隔离与派生资产 | `pnpm s7:lint` | S7 gate、真实变异测试、canonical registry golden 与相关生产源码 | 派生资产预检 / 103.7 秒 | 实际 gate 通过，15/15 变异测试通过，golden 一致 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5`；后续 U30-05～U30-07 输入变化，由 V30-06～V30-10 替代 | 失效 |
| V30-04 | 当前源码与导出可消费 | `pnpm build`（单次，450 秒硬截止） | 工作区 17 个可构建包与当前 lockfile | 最终构建证据 / 296.1 秒 | 17/17 成功；CLI 直接类型检查本次路径零新增错误，仍仅有既有 8 个配置编辑器基线错误 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5`；后续 U30-05～U30-07 输入变化，由 V30-06～V30-10 替代 | 失效 |
| V30-05 | 冻结一致性与差异卫生 | 聚合 50 文件 SHA-256；`git diff --check` / `git diff --cached --check` | 相对 `2526d6e8` 的专项交付物，排除工作台与此前独立 skill 修正 | 冻结准备 / <1 分钟 | 指纹已冻结，空白错误为 0；专项与四路审查期间未修改交付物 | `sha256:879456139aa589d6095896f8e5cfa312ec036a913d6e29c77874c401e9a8daf5`；后续 U30-05～U30-07 输入变化，由 V30-06～V30-10 替代 | 失效 |
| V30-06 | U30-05 构造依赖 exact-set 与结构闭包 | CLI 受影响类型检查、`pnpm s7:lint`、真实源码变异与 golden | local runtime 合同、两生产根、S7 gate/test/golden | 修复直接验证 + 派生资产预检 / 约 2 分钟 | 本次路径零新增类型错误（仅既有 8 个配置编辑器基线错误）；S7 结构门禁、15/15 变异与 golden 全绿 | 当前冻结生产/S7 输入 | 有效 |
| V30-07 | U30-07 lifecycle、cancellation、interaction terminal 与恢复 | local owner lifecycle、durable interaction、manager/ledger 直接测试 | assembly/manager/protocol/observer/executor ledger 与直接测试 | 修复直接验证 / 约 3 分钟 | 全写面及 idle/start/active/queued/失败重启场景通过；pending-confirmation 当前单例 1/1；observer 竞态 6/6；既有 manager/ledger 直接闭包有效 | 当前冻结相关输入 | 有效 |
| V30-08 | U30-06 两生产根真实 assembly 交界 | owner-domain production profiles 定向测试 | 两 profile fixture、真实 assembly、advancement/interaction/final/cache/workspace/restart | 修复直接验证 / 49.45 秒 | anchor+executor 与 executor-only 当前小表 2/2 通过；workspace 有/无、internal no-surface interaction、final、close 与零重执行全等 | 当前冻结相关输入 | 有效 |
| V30-09 | 当前生产源码与导出可消费 | `pnpm build`（单次，450 秒硬截止） | 工作区 17 个可构建包及 lockfile；构建后只修改直接测试与工作台 | 必要构建证据 / 299.3 秒 | 17/17 成功；后续无生产/导出源码变化，未重复构建 | 当前冻结生产构建输入 | 有效 |
| V30-10 | 专项冻结一致性与差异卫生 | 聚合 53 文件 SHA-256；`git diff --check` / `git diff --cached --check` | 相对 `2526d6e8` 的专项交付物，排除工作台、AGENTS/board 与独立 Skill 修正 | 冻结准备 / <1 分钟 | 空白错误 0；四路只读审查期间交付物未修改 | `sha256:15b4e287ba13983e2cc2d56edf5623ac9067f6f754ec8fd6d0d49931ec3a89b3` | 有效 |
| V30-11 | pending confirmation 等待预算归因 | lifecycle pending-confirmation 定向单例 | 真实 authority/ledger/broker/close 场景 | 诊断 / 首次 10 秒等待上限 | 首次只因 durable pending 在冷 I/O 下晚于 10 秒出现而超时；未见生产错误。仅该场景改用 30 秒有界预算后 1/1 通过，未放宽全局预算 | 当前冻结测试输入 | 诊断 |
| V30-12 | conformance interaction 路径归因 | 两 production profile 定向小表 | fixture internal consumer 与 data-plane ticket 边界 | 诊断 / 首次方案 | 首次选择 surface-ticket answer，因 fixture 明确未装配 ticket authorization 而 2/2 确定失败；改用本地域已支持的 internal no-surface fail-closed consumer 后 2/2 通过，无生产修改或能力扩张 | 当前冻结测试输入 | 诊断 |

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
