# 单元登记:第 29 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:29
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-06
- **登记来源**:用户要求将第 29 单元独立审查的当前问题转入正式问题列表并继续收敛

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U29-01～U29-03 均已验证；U29-01 专项冻结与对抗收口完成，未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（U29-01 专项指纹；尚未进入全单元冻结）
- **交付物文件集**:U29-01 本轮 27 个实现、测试、脚本与 golden 文件；工作台状态文档不计入交付指纹
- **当前交付物指纹**:`sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef`
- **架构来源**:`distributed-runtime-charter.md`、`specification.md`、第 29 单元定稿开发清单、当前生产入口与装配源码、第 29 单元独立审查清单

## 固定边界

- **功能范围**:S7 入口覆盖 lint、结构依赖门禁、已退役入口防复活，以及 §十三截至 S7 已到期模块文档与当前公开合同同步
- **架构不变量**:每个受支持生产入口恰有一个有效落点或有依据的显式排除；角色依赖与写权限不得绕过既定 owner；已退役入口不可复活；当前架构段与生产事实一致
- **验收条件**:U29-01～U29-03 均按正式验收条件完成并更新为已验证，随后按工作台门禁完成受影响范围复审与单元提交验证
- **必要上下游**:S1～S7 已冻结合同、第 25～28 单元生产装配、RPC/CLI/技能/渠道/lifecycle/segment/cleanup/写工具注册源、现有 lint 链与相关模块文档
- **明确不属于本单元**:S8 及后续单元能力、第二套提交或投递语义、通用运行时注册中心或依赖图框架、监控、诊断、benchmark、信息采集及无当前义务的历史文档改写

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| `role-topology`、anchor/executor host、command/shutdown/access、server lifecycle/registry | topology plan、cleanup owner 与真实条件装配必须共源 | F29-01～F29-06；server 18/18、CLI 24/24、workspace build | 通过 |
| `CoreHostConnection`、presenter/event bus、RPC facade/broker | notification-only 与 raw-RPC capability 必须保持有限边界 | F29-07～F29-10；CLI facade 2/2、S7 13/13 | 通过 |
| S7 capture/test/golden 生成器 | 八种角色配置、cleanup owner、RPC capability 与 canonical registry 必须同步 | `pnpm s7:lint`、golden check、C29-19～C29-22 | 通过 |
| canonical registry golden | 只由当前生产 descriptor 与 topology plan 派生 | write 后人工差异核对及同输入 check | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| host/cleanup 适用集合 | `ServeTopologyPlan.activeCleanupOwners` | host loader 前完成计划，registry 构造时冻结 owner 集 | 条件资源出现时 descriptor 注册反绑；错 owner 立即失败 | role loader、CleanupRegistry、S7 capture/golden | 三个有限 owner；八个有限配置；无队列或恢复状态 | 通过 |
| cleanup 稳定身份 | `owner:role:id` descriptor | `registerCleanup` 写入 registry | 新增、删除、重复、未知/错 owner、helper 绕过 | 全部生产 cleanup 与 S7 exact-set | 有限 descriptor 集；LIFO 语义未变 | 通过 |
| CLI raw-RPC capability | `CoreHostRpcLink` + canonical RPC registry | 有限 owner 取得 raw client 时 | wrapper/re-export/返回/动态 method 在 lint 阶段拒绝 | core connection、facade/broker、stop 与 S7 lint | 仅有限生产文件；mesh receiver 排除；无运行时扫描 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。
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
| U29-01 | **P1｜工作量中｜来源 P29-01，同根重开 P29-04。** 先前 row 重数、Commander action、注册源、phase、writer 等分支已由 C29-01～C29-08、C29-13～C29-16 修复；同根残留集中在两个生产边界。① `planServeTopology` 的真实调用图为：有 anchor 时加载 `anchor-role→command`，仅 executor 时加载 `executor-role→executor-role-runtime`，无二者时不加载 host；executor-only 自有 `try/finally` 清理、不创建 CleanupRegistry，CLI 的 `runServer` 恒注入外部 registry，故 server 独立 registry 的 `releaseLock/scheduler.stop` 也不属于产品角色链。当前 `entryAppliesToRoles` 却按 category/cleanup role 猜测，导致 executor-only 固化 27 个不存在的 cleanup，anchor-only 也混入只可能由同机 executor 产生的 cleanup。② 当前公开 RPC 原始能力只由 `core-host-connection.ts`、现有 `rpc-*` facade/broker 与 `serve/stop.ts` 取得；`rpcGuarded` 却按文件名或直接 import 猜测 receiver，经本地 wrapper/re-export 取得 `CoreHostLink`/`RpcClient` 后，未知字面量或动态 method 可零 violation。当前运行拓扑和现有 RPC 字面量合法，损失是本单元门禁及 golden 已给出不真实或不完整的 exact-set 结论。**价值裁决记录：**原 U29-01 裁决为 P1/中，否定“当前运行时已损坏”并在既定捕获边界修复后标记已验证；P29-04 以当前错误角色目录和可复现的间接 RPC 假绿触发重开。冷启动事实继续否定运行时事故、全仓调用图及运行时 registry 扩面，但证实 D29-02、D29-03、D29-07 的核心提交门禁未闭合；新决定为同根重开 U29-01，保留 P1、中工作量，只闭合角色 cleanup owner 与公开 raw-client capability 两个有限边界。修复后仅在 topology/host、CleanupRegistry owner、canonical RPC registry 或 CLI raw-client 能力边界发生生产变化时重开。**本轮实施证据：**C29-19～C29-22 已落地：八种配置由同一 topology plan 生成 active owner/entryKeys，descriptor 与 registry 运行时反绑；notification-only 消费者不再持 raw client，CLI 全生产文件的取得、返回、转发与 re-export 进入同一门禁，mesh receiver 明确排除。S7 直接测试 13/13、server 定向 18/18、CLI 定向 26/26、完整 S7 lint、同输入 workspace build 与四路冻结复审均通过；差异审计零未处置反证。 | role category 和文件路径只是 lint 观察到的表象，不是“哪个 host/能力实际拥有入口”的生产事实；同一 owner/capability 判定没有同时驱动 host 装配、cleanup 注册、公开 client 暴露与覆盖捕获，因而 lint 可在生产边界之外自行形成第二套适用语义。 | **生产端：**`planServeTopology/runConfiguredServeTopology`、anchor/executor host loader、`CleanupRegistry/registerCleanup` 及全部调用点、`runServer` 注入模式、`CoreHostConnection/CoreHostLink`、RPC facade/broker、`serve stop`。**类型组合：**四类角色行为（anchor+executor、anchor 无 executor、executor host、disabled；surface 有无不改变所属类）×cleanup owner/可选资源，公开 raw-client 取得/逸出×字面/动态 method×canonical registry，mesh receiver 明确排除。**消费者：**`captureS7EntryCoverage`、canonical golden、`s7:lint` 与仓库 lint/CI。**异常终态：**不存在或错属的 cleanup 被固化；真实 cleanup 增删/错 owner 或 wrapper/re-export 后的未知/动态公开 RPC 绿色通过。**测试：**须直接变异 topology owner、注入/独立 registry、条件 cleanup、raw-client 取得/逸出和公开 method，并证明角色等价类、合法 RPC 与 mesh request 零误杀。受影响审查项 IR29-01、IR29-03、IR29-17～IR29-19、IR29-26～IR29-28、IR29-31～IR29-32、IR29-35～IR29-37。 | **角色/cleanup：**在现有 role-topology 中把 topology 字符串扩为同一纯装配计划，明确 active cleanup owner 集：anchor host 恒含 `anchor-host`，同机 executor 再含 `anchor-local-executor`；executor-host 与 disabled 均不含 CleanupRegistry owner；server 自建 registry 分支使用 `standalone-server`、不进入产品角色集。`CleanupRegistrationDescriptor` 增加该有限 owner，anchor host 以同一计划构造 registry，`registerCleanup` 对 owner 做运行时反绑，S7 capture 直接用同一计划和 descriptor 生成 entryKeys；角色条件只改变 owner 集，surface 有无的等价配置必须全等。**公开 RPC：**保留一个具体 `CoreHostConnection`，把消费者类型收窄为 notification-only link 与 raw-RPC link；presenter/event bus 只持前者，只有现有 `rpc-*` facade/broker 和 core connection 持后者，`serve stop` 是唯一直接 client owner。S7 对全部 CLI 生产文件检查 `getClient/getConnectedClient`、`createRpcClient/RpcClient` 的取得、转发、返回与 re-export，边界外一律失败；只在上述有限 owner 内检查 `request/requestWithReconnect`，动态 forwarder 仅当全部调用点均为 canonical method 时允许，mesh client 按类型/owner 排除。不得建设自动发现、通用数据流/调用图、运行时 registry 或第二 RPC 框架。**验收矩阵：**anchor±surface、anchor+executor±surface、executor±surface、空/surface-only 分别与真实 host/owner 全等；standalone server 分支不混入；cleanup 新增、删除、错 owner、条件漂移及 disabled 装配均 fail-closed。现有 facade/core/stop 合法方法通过；wrapper/re-export、raw client 逸出、未知字面量、未受 canonical 联合约束的动态方法失败；mesh request 零误杀。更新并审阅 golden 后，S7 直接测试与 lint 对同一输入通过。 | 已验证 |
| U29-02 | **P1｜工作量小｜来源 P29-02。** `inspectProductionSource` 当前只识别具名 `ImportDeclaration` 的局部名称与字符串 module specifier：`MemoryStore as Alias` 取 alias 后不再命中，re-export、namespace、dynamic `import()`、`require()`、`import = require` 与 package manifest 均未进入同一判定；server 动态取得 executor、executor 动态取得 server，以及经 workspace re-export 转导全局可写 owner 都可绿色通过，非字面动态加载还能完全逃离包边识别。当前 `server`/`executor` manifests 与生产源码未发现真实反向边，受保护包也未发现已发生的 Store owner 旁路。**价值裁决记录：**原结论为 P1/中且影响描述易被理解为当前运行图已违规；当前生产事实推翻该表述，损失收窄为本单元结构门禁对常见违规候选变更假通过；新决定为保留 P1、工作量小，修复后只在受保护包、禁止 owner 集或允许依赖边变化时重开。 | 有限结构规则按局部标识符和单一 import 语法判定，没有先规范化静态/动态依赖形态、沿 workspace export 恢复原始 owner 定义并把 manifest 的生产边纳入同一受保护边集合。 | **生产端：**executor、runtime-host、orchestrator、tools-builtin、server 的生产源码、其可达 workspace export/re-export 边及五包 manifest。**类型组合：**named/aliased/default/namespace import、re-export、dynamic import、require/import-equals、字面/非字面 specifier、生产依赖字段、原始/局部符号名；纯 devDependency 不单独构成生产违规。**消费者：**`validateS7Structure` 与仓库 lint/CI。**异常终态：**server↔executor 反向依赖或 MemoryStore/SkillStore/AnchorWorksceneRegistry 的导入、转导、动态取得绕过门禁。**测试：**当前仅覆盖普通 named/bare import，缺各有限语法、转导和 manifest 负例；受影响审查项 IR29-20～IR29-21、IR29-27、IR29-35～IR29-37。 | 只扩展现有 AST/manifest 门禁：把 ImportDeclaration、ExportDeclaration、ImportEqualsDeclaration、dynamic `import()`、`require()` 与五个 package manifest 的 dependencies/optionalDependencies/peerDependencies 规范化成 module edge，受保护源码中的非字面动态加载 fail-closed，devDependencies 仅在生产源码实际引用时随源码边判定；named alias 按 `propertyName ?? name` 恢复原名，并沿当前 workspace 的有限 export/re-export 边解析到禁止 owner 定义，namespace/default 对暴露禁止 owner 的模块 fail-closed，再以现有受保护根、禁止 owner 集和 server↔executor 禁止边统一判定。补每种语法、转导、manifest、合法端口 import 和当前生产图直接测试，错误报告真实包边及原始符号；不建设通用依赖图或新 lint 框架。验收为当前合法图通过，alias/re-export/namespace/dynamic/require/import-equals/manifest 的全部有限绕过及非字面动态加载确定失败，合法类型/端口导入及纯测试依赖不误杀。 **实施证据：**C29-09～C29-11、C29-17～C29-18 与 A29-03 修复后复核通过；五包生产图、有限 AST/manifest/workspace 转导门禁通过。 | 已验证 |
| U29-03 | **P2｜工作量小｜来源 NB29-01。** `scheduler-architecture.md` 的“当前生产架构”仍称旧 DeliveryPipeline/queue/store“只允许一次性排空迁移，排空后删除”，而执行规格的现行合同、S7 第 26 项、公开符号表及源码均表明旧链已整体退役、无生产装配和公开入口；现存 `AuthorityDeliveryPipeline/AuthorityDeliveryQueue` 是新权威链，不能被旧名称误伤。现有 `validateDueDocuments` 对该文档只检查任意位置出现 `JobJournal`，无法阻止当前段重新出现迁移期陈述。 | 旧链退役后只同步了规格、代码和 denylist，当前架构段及其文档门禁没有共同绑定“已整体退役”的现行事实，导致弱 token 检查可在正文自相矛盾时仍通过。 | **生产端：**无，旧链已退役；现行 AuthorityDelivery 链必须保留。**类型组合：**当前生产架构段、非现行历史段、旧/新同名 delivery 概念。**消费者：**维护者、实现审查及 `validateDueDocuments`。**异常终态：**把旧链误认成仍允许的迁移入口，或错误删除现行 AuthorityDelivery 组件。**测试：**当前/历史段语义及 existing due-document lint；受影响审查项为 §十三 scheduler 文档同步、IR29-36～IR29-37。 | 把当前段改为“旧 DeliveryPipeline/queue/store 已整体退役，生产装配与公开入口均不存在；新 AuthorityDelivery 日志/outbox/状态目录是唯一链”，历史段继续明确非现行；同时把现有 scheduler due-document 规则收紧为只检查当前生产架构段的必要退役事实并拒绝“仍可排空迁移”等现行措辞，保留 AuthorityDelivery 白名单。验收为文档、规格、源码与 denylist 一致，旧链复活或当前段退回迁移期措辞会使现有 `s7:lint` 失败，历史推演无需改写。 **实施证据：**C29-12 与 A29-04 修复后复核通过；scheduler 当前段、现行 AuthorityDelivery 白名单和 due-document 门禁一致。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |
| L29-01 | U29-01；A29-01/A29-02 曾记录 exact-set 与角色适用集合闭合，后由 P29-04 重开 | 把“已扫描到生产 descriptor”误当成“适用集合来自生产 owner”，又只在预设文件内检查 RPC method，没有先核对 raw-client 能力从哪里取得和逸出；因此 lint 自有 role/path 启发式与自身 golden 可以循环自证。 | 每次 S7 exact-set 审查先从 `planServeTopology` 与 host loader 枚举四类角色行为，逐类对账实际 CleanupRegistry owner、注入模式和零 registry host；再扫描全部 CLI 生产文件的 raw-client 取得/转发/返回/re-export，最后才检查 owner 内 method，并以 mesh receiver 作反向零误杀。适用于角色装配、cleanup descriptor、CoreHostLink/RpcClient 或 RPC facade 边界变化。 | U29-01 本轮收敛：已对 anchor±executor±surface、executor±surface、disabled、runServer 注入/独立分支，以及 CoreHostLink 全部生产消费者和 CLI mesh/public request 边界执行该检测；反证已并入 U29-01。 |

## U29-01 专项固定矩阵

| 矩阵编号 | 输入与直接变体 | 唯一 owner / 稳定身份 | 线性化与确定终态 | 冻结指纹上的事实与反例结论 |
| -------- | -------------- | --------------------- | ------------------ | -------------------------- |
| F29-01 | anchor+executor，surface 有/无 | `anchor-host` + `anchor-local-executor` | `planServeTopology` 同时决定 host、executor loader 与 active owners | 两个 surface 等价配置的 topology、owner、entryKeys 全等；C29-19 修复后通过 |
| F29-02 | anchor 无 executor，surface 有/无 | 仅 `anchor-host` | 同上；local-executor descriptor 在注册时被拒绝 | 两个配置全等且不含 executor cleanup；错 owner 运行时零注册；C29-20 通过 |
| F29-03 | executor host，surface 有/无 | 无 CleanupRegistry owner | executor host 自有 `try/finally`，不进入 cleanup registry | 两个配置 entryKeys 全等且 cleanup 为空；未虚构 anchor/server cleanup |
| F29-04 | empty 与 surface-only | disabled，无 owner | host/loader 均不启动 | 两个配置 entryKeys 全等且 cleanup 为空 |
| F29-05 | server 独立启动与 anchor 注入 | 分别为 `standalone-server` / `anchor-host` | registry 构造时冻结 active owners，descriptor 注册反绑 | 独立 server 不进入产品角色集；注入/独立 owner 不混用 |
| F29-06 | cleanup 新增、删除、条件漂移、未知 owner、绕过 helper | descriptor 的 `owner:role:id` | 生产 AST capture 与运行时 registry 共用 descriptor | 重复、缺失、未知/错 owner、直接 `register` 均 fail-closed |
| F29-07 | core connection、现有 facade/broker、`serve stop` | `CoreHostConnection`、`CoreHostRpcLink`、canonical RPC method | raw capability 仅在有限 owner 取得；method 对账 canonical registry | 当前合法 owner 和全部字面 method 通过 |
| F29-08 | presenter/event bus、wrapper/re-export、返回/转发、raw client 逸出 | presenter 只持 `CoreHostNotificationLink` | CLI 全生产文件扫描 raw capability 的取得与出口 | notification-only 零 raw client；wrapper/re-export/推导返回失败；C29-21 通过 |
| F29-09 | 未知字面量、动态 method、受约束 private forwarder | canonical RPC registry | owner 内调用逐项判定；动态仅在所有调用点为 canonical 时闭合 | 未知及未闭合动态调用失败，当前有限 forwarder 通过 |
| F29-10 | assignment/data-plane/evidence/global-query 等 mesh request | mesh client receiver | receiver 类型与 owner 不进入 public RPC 门禁 | 真实 mesh adapter 全文件零误杀；C29-22 通过 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| M29-01 | 固定矩阵：§八 row/mapping、Commander/slash/skill/channel/lifecycle/cleanup/tool/RPC 与全部八种角色配置的生产 exact-set | `pnpm s7:lint`；server/CLI 五个直接测试文件 | §八、全部生产注册源、topology/cleanup/RPC capability、S7 capture/test 与 golden | 修复直接验证 / 中 / S7 74.1s，定向 43.3s | S7 13/13、server 18/18、CLI 26/26；C29-19～C29-22 直接变异通过，生产 lint 与 golden 同输入通过 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| M29-02 | 五个受保护包的有限依赖语法、workspace 转导、manifest 边与合法端口 | 同 M29-01 的结构变异集；真实生产 S7 结构门禁 | 五包生产源码/manifest、workspace exports 与结构检查 | 修复直接验证 / 小 / 共用 21.0s | C29-09～C29-11、C29-17～C29-18 通过：server owner、alias/re-export/local 转出、dynamic/require/import-equals 与 manifest 绕过均拒绝 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-03 | scheduler 当前段只陈述旧链整体退役并保留新 AuthorityDelivery，历史保持非现行 | 同 M29-01 的 scheduler 当前段变异；真实 due-document 门禁 | scheduler 当前段、规格、delivery 导出、denylist | 修复直接验证 / 小 / 共用 21.0s | C29-12 通过：当前段退回迁移期措辞确定失败，现行 AuthorityDelivery 白名单保留 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-X | 三项直接交界、派生 golden 与当前源码构建闭包 | `pnpm build`；server/CLI 串行类型检查；Biome 变更文件检查 | 27 个 U29-01 交付文件、golden 与 workspace 构建输入 | 收口验证 / 中 / build 328.2s，类型检查 55.0s，Biome 9.6s | workspace build、server 类型检查与 23 个格式输入通过；CLI 仍仅有账本既存的 9 个非变更文件基线错误 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| A29-01 | 冷启动对抗：生产注册源与入口 exact-set | 只读重建 RPC/Commander/slash/skill/channel/lifecycle/cleanup/tool 与四种有效角色集合 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-13 缺 anchor-only、C29-14 exclusion reason/schema 漂移、C29-15 cleanup alias 直写、C29-16 aliased client/公开动态 RPC 转发均修复；复审零未处置反证 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-02 | 冷启动对抗：重数/action/phase/角色适用集合 | 独立构造重复 row/tuple、actionless、phase 漂移、writer 与角色缺失 | 当前冻结指纹 | 对抗复审 / 小 / — | tuple 重数在物化前拒绝，真实 action、双向 phase、assembly 与四角色集合均闭合 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-03 | 冷启动对抗：依赖 AST/manifest/workspace 转导 | 独立构造 server owner、别名、先导入后本地转出、dynamic/require/import-equals、公开动态 RPC | 当前冻结指纹 | 对抗复审 / 小 / — | C29-17 server 漏入 owner 禁边、C29-18 workspace 先导入再本地转出均修复；有限绕过 fail-closed，合法端口与精确包边零误杀 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-04 | 冷启动对抗：退役事实、当前文档与范围价值 | 当前段/历史段、denylist、新 AuthorityDelivery 与禁止扩面双向对账 | 当前冻结指纹 | 对抗复审 / 小 / — | 旧链仅在当前段陈述整体退役，历史与新链边界清晰；未新增 runtime registry、通用依赖图或诊断设施 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-05 | 冷启动对抗：真实 host topology 与角色适用集合 | F29-01～F29-05，抛开旧 golden 从 host loader 反推 | 当前冻结指纹 | 对抗复审 / 小 / — | 四类行为、八种配置与 surface 等价关系全等；executor/disabled/standalone 边界无虚构入口 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| A29-06 | 冷启动对抗：cleanup owner 与条件装配 exact-set | F29-01～F29-06，逐项核对 descriptor、active owner 与注册条件 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-19/C29-20 修复后复核通过；新增、删除、错 owner、条件漂移与绕过 helper 均确定失败 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| A29-07 | 冷启动对抗：CLI raw-client/receiver 与 canonical RPC 闭包 | F29-07～F29-10，逐文件反推能力取得、出口与 receiver | 当前冻结指纹 | 对抗复审 / 小 / — | C29-21/C29-22 修复后复核通过；合法 facade/core/stop 与 mesh 零误杀，逸出、未知与未闭合动态调用失败 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| A29-08 | 冷启动对抗：用户体验与范围价值 | 用户运行链、提交门禁、有限 owner/capability 与禁止扩面双向对账 | 当前冻结指纹 | 对抗复审 / 小 / — | 运行时正常入口语义不变；提交门禁不再假绿；只增加有限计划、owner 和 capability 边界，未新增 registry/RPC/调用图框架 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| D29 | 差异审计：历轮反证、专项审查与四路记录机械并集 | C29-01～C29-22、M29-01～M29-X、A29-01～A29-08 | 当前冻结指纹 | 差异审计 / 小 / — | C29-01～C29-18 既有处置复用；C29-19～C29-22 同根合并并修复后复核通过；P29-04 已闭合，零消失或未处置发现 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-29.gen-1 -->
