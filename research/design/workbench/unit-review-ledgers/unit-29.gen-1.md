# 单元登记:第 29 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:29
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-06
- **登记来源**:用户要求将第 29 单元独立审查的当前问题转入正式问题列表并继续收敛

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成并封版；U29-01～U29-03 全部已验证，37/37 独立审查项通过，同一冻结指纹上的两轮终审、独立功能审查与单元提交验证全部通过
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是（冻结后只读；任何非工作台交付文件变化均使终审、独立功能审查与提交验证失效）
- **交付物文件集**:相对基线 `4eaf3e2f` 的 65 个非工作台路径，按 G29-01～G29-07 完整归类，其中修改 61、增加 2、删除 2；工作台文件不入交付物
- **当前交付物指纹**:`delivery-manifest-v1:1716fba0015f801d05a10d8ac2da57219167a490aa669ad57d880c9865fd6701`（按路径排序，每行 `status<TAB>path<TAB>content-sha256|DELETED`，LF 分隔并保留末尾 LF，再取 SHA-256；工作台文件不入指纹）
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
| G29-01：8 个入口 descriptor 源（Feishu、CLI/skill/channel、Segment、InboundRouter） | S7 capture 的 RPC/命令/渠道/lifecycle entryKeys 与 §八 row mapping | 组指纹 `fc7f700116555235c20052e168754a9a2f646410d8a6d74f9a9682fd846e1578`；M29-04 当前输入 `s7:lint` 预检通过 | 通过 |
| G29-02：24 个 topology/cleanup/RPC 文件与直接测试 | topology plan、两处 registry 构造、cleanup descriptor、notification/raw receiver 与 canonical RPC | 组指纹 `1559551fc9c935572f2879760d44102b29f002b7108b3720771a1ba5971cbba3`；C29-23～C29-31 和独立清单 IR29-03、17、18、32 已核对当前生产边界 | 通过 |
| G29-03：7 个 authority tool/structure 文件 | builtin/extra/Task 权威写 descriptor、runtime lifecycle 与包依赖结构 | 组指纹 `89679cce59695491ee657ea7cfa52fb6fa984770a43759d3ae5d32ccc8f5f03b`；M29-02 与 IR29-10～11、20～21 当前有效 | 通过 |
| G29-04：11 个 delivery/advancement 退役路径（含 2 个删除） | 旧 delivery drainer/queue、advancement fallback 的生产引用、导出、夹具与 denylist | 组指纹 `75d28ade8073eb7b77444e91a1b1efe6fbe8b4896e953d7f3bc45aea07c9241b`；U29-01、IR29-22～24 与 M29-X 已核对有限退役且保留现行 AuthorityDelivery | 通过 |
| G29-05：10 份当前合同与到期模块文档 | §十三逐项现行语义、scheduler 当前段与公开合同；历史段保持非现行 | 组指纹 `87672f7b03ea91a9c863e0b82c65c9df00f563a04a4c7160613c7d7bdbd9db47`；M29-03、IR29-29～30 与 M29-04 due-document 预检通过 | 通过 |
| G29-06：canonical registry golden | 只由当前 production registry、descriptor 与 topology plan 派生，不得成为第二事实源 | 组指纹 `488d47f3ff382ca9ae62db3383242b9a23d9faef6c46a9f86310044318f56b78`；M29-04 只读 golden check 通过 | 通过 |
| G29-07：根 lint 脚本与 3 个 S7 capture/test/golden 文件 | 根 `lint → s7:lint` 单一消费链、有限 AST/manifest 门禁与生成资产对账 | 组指纹 `16cbf7d77b0f800069ab334457defa925aaaa655e2aaf3911c3708f337f87c64`；M29-01 与 M29-04 当前输入均通过，根 lint 消费链闭合 | 通过 |

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
| R29-01 | 入口 catalog、row mapping 与全部真实 producer exact-set；入口/生产端、异常终态 | G29-01、G29-06、G29-07；RPC registry、Commander/slash/skill/channel、Agent/Segment phase、工具 descriptor；S7 capture/test/golden | G29-01 `fc7f7001…` + G29-06 `488d47f3…` + G29-07 `16cbf7d7…` | 任一 registry/factory/descriptor、§八 row、mapping、capture 或 golden 输入变化 | 通过 | 2/2 | 第二轮独立重建：144 个 production entry、37 个 row、10 份 due document 与八配置均从当前源生成；空/重/漏/双/乱序在消费前 fail-closed，捕获无并发状态或恢复欠账，无新增问题 |
| R29-02 | topology、cleanup owner 与 CLI raw-RPC capability；生命周期、安全、非默认配置 | G29-02、G29-07；八配置、两处 registry 构造、全部 cleanup 注册、CoreHostConnection/link、facade/core/stop/composition/notification/mesh | G29-02 `1559551f…` + G29-07 `16cbf7d7…` | topology/host、CleanupRegistry/descriptor、raw symbol owner、canonical RPC 或相关测试变化；EX29-01 重开 | 通过 | 2/2 | 第二轮独立重建：仅两处生产 registry 构造，owner 在宿主启动前冻结；raw 请求能力按符号/owner 限定，公开逸出、动态加载与未知 method 拒绝，notification/mesh 只持窄面；再次执行 L29-01 证据核对，EX29-01 未重开 |
| R29-03 | 写权威工具和结构依赖门禁；owner、包边界、安全 | G29-03、G29-07；builtin/extra/Task 工具、runtime lifecycle、五包源码/manifest/workspace export 转导 | G29-03 `89679cce…` + G29-07 `16cbf7d7…` | 工具 factory/profile/assembly、禁止 owner、受保护包边、workspace export 或 manifest 变化 | 通过 | 2/2 | 第二轮独立重建：生产扫描限定 packages TypeScript 与五包 manifest，symlink 不下钻；静态/动态边、workspace 转导和禁止 owner 同一拒绝终态，无线上副作用、无秘密读取、无资源队列，无新增问题 |
| R29-04 | 旧入口有限退役与现行链保留；兼容、恢复、异常终态 | G29-04、G29-05、G29-07；delivery/advancement 生产调用、导出、denylist、迁移 reader 边界及直接测试 | G29-04 `75d28ade…` + G29-05 `87672f7b…` + G29-07 `16cbf7d7…` | 退役 token、AuthorityDelivery/canonical evidence、迁移义务、denylist 或调用图变化 | 通过 | 2/2 | 第二轮独立重建：退役入口在装配/导出/夹具闭包均不可达，现行 AuthorityDelivery 与 canonical evidence 正常、拒绝和恢复 owner 保留；denylist 有限，不触及当前迁移 reader，无新增问题 |
| R29-05 | §十三文档与当前公开合同一致性；消费者继承面、兼容 | G29-05、G29-07；十份到期文档、规格当前段、公开类型/导出与 due-document lint | G29-05 `87672f7b…` + G29-07 `16cbf7d7…` | 当前合同、公开类型/导出、到期状态或 due-document 判据变化 | 通过 | 2/2 | 第二轮独立重建：从当前公开符号与生产装配反向核对十份文档，新增内容均为已到期 S4/S7 现行边界；历史叙述不再承担入口合同，S10 未提前改写，无新增问题 |
| R29-06 | 验收链、生成资产、资源与交付卫生；测试与验收 | G29-06、G29-07、M29-01～M29-X；根 lint、直接负例、canonical golden、构建/类型/Biome 证据 | G29-06 `488d47f3…` + G29-07 `16cbf7d7…` | 生成器/golden/lint 链、验证输入或构建输入变化；出现派生漂移或无证据文件 | 通过 | 2/2 | 第二轮独立重建：check 模式只读，生成脚本仅 `--write` 可改 golden；golden 仅含公开稳定标识、无秘密/绝对路径，扫描有限且本次 88.9s 退出；14 项真实源码变异覆盖既有教训，未以包全测掩盖盲区，无新增问题 |
| R29-X | 跨项组合：入口→落点→owner/角色→结构→退役/文档→提交门禁 | R29-01～R29-06 的当前输入、结论和重开条件；65 路径完整 manifest | `delivery-manifest-v1:1716fba0015f801d05a10d8ac2da57219167a490aa669ad57d880c9865fd6701` | 任一 R29 项边界、输入、状态或结论变化 | 通过 | 2/2 | 第二轮：全部单项独立完成后，从故障/安全方向贯通入口错误、角色错装、owner 绕过、旧链复活与文档漂移；均在提交前确定失败，合法用户路径及现行恢复链不变，manifest 复算仍为 `1716fba0…` |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U29-01 | **P1｜工作量小｜来源 P29-01，同根重开 P29-04、P29-05。** 先前 row 重数、Commander action、注册源、phase、writer 等分支已由 C29-01～C29-18 修复；P29-04 的 topology/cleanup/RPC capability 修复已由 C29-19～C29-22 实施并曾标记已验证。**价值裁决记录：**原 U29-01 裁决为 P1/中，否定“当前运行时已损坏”并在既定捕获边界修复后标记已验证；P29-04 以错误角色目录和间接 RPC 假绿触发重开。冷启动事实继续否定运行时事故、全仓调用图及运行时 registry 扩面，但证实 D29-02、D29-03、D29-07 的核心提交门禁未闭合；新决定为同根重开 U29-01，保留 P1、中工作量，只闭合角色 cleanup owner 与公开 raw-client capability 两个有限边界。修复后仅在 topology/host、CleanupRegistry owner、canonical RPC registry 或 CLI raw-client 能力边界发生生产变化时重开。**P29-05 触发重开事实与证据：**当前运行装配正确：anchor+executor 为 `anchor-host + anchor-local-executor`，anchor-only/anchor+surface 仅 `anchor-host`，executor-only/disabled 不装配 CleanupRegistry；`command.ts` 消费 `plan.activeCleanupOwners`，standalone `lifecycle.ts` 固定 `standalone-server`；五个现行 facade/broker 持 `CoreHostRpcLink`，core connection/stop 分别持底层 client 能力，event bus 与四类 presenter 只持 notification link。但 `validateS7Structure` 不检查全部生产 `new CleanupRegistry` 的 owner 输入，且 `isRpcFacadeOwner` 以任意 `packages/cli/src/runtime/rpc-*` 路径授权 raw link。删除 anchor owner 注入、把 event bus 扩为 raw link或新增同前缀 raw owner均可得到零 violation，满足既定重开条件。**本轮方案收敛记录：**四路冷启动分别从真实 host loader、cleanup 构造与注册、CLI capability/receiver、用户体验与范围价值重建；共同确认运行时当前无事故，唯一当前损失是 S7 核心提交门禁假绿；全部反例均落入 F29-01～F29-10，无第二根因。P1 成立，因为本单元的主要交付物就是可阻止入口/权限漂移的机械门禁；剩余只改现有脚本与直接测试，工作量核准为小。 | 生产 owner/capability 已在运行装配中有限且明确，但 lint 没有消费这两个边界：cleanup 只采集 registration descriptor、不反绑全部生产 registry 构造及其 owner 输入；raw RPC 又按文件名前缀授权而非按当前有限 receiver 集授权。门禁因此形成第二套适用语义，能与真实装配同时漂移而自证绿色。 | **生产端：**`planServeTopology/runConfiguredServeTopology`、`command.ts`、server `lifecycle.ts`、`CleanupRegistry/registerCleanup`、`CoreHostConnection/CoreHostRpcLink`、五个 facade/broker、`serve stop`、repl/workspace composition owner、event bus 与四类 presenter。**类型组合：**八种角色配置；全部生产 registry 构造的缺失/重复/替换/新增与 descriptor 新增/删除/错 owner/条件装配；raw symbol 分组 owner、同前缀新文件、notification→raw、别名 wrapper/re-export、public/protected 实例成员或返回、未知字面量/动态 method；合法 canonical 调用、私有 DI 与 mesh receiver。**消费者：**`inspectProductionSource`、`validateS7Structure`、capture/golden、`s7:lint`、仓库 lint/CI。**异常终态：**owner 栅栏被移除或 raw receiver 扩张后门禁仍绿色，使角色 exact-set 与真实宿主脱节，或让非既定消费者获得任意 canonical RPC 能力。**受影响审查项：**IR29-03、IR29-17、IR29-18、IR29-27、IR29-32、IR29-35、IR29-36、IR29-37。 | 只扩展现有 S7 AST 门禁与直接测试。① 复用现有有限 export/re-export resolver 恢复 `CleanupRegistry` 原始符号，覆盖 named/namespace alias 与本地转导；扫描全部生产构造，仅允许 anchor 与 standalone 两点。anchor 的 `activeOwners` 必须取自 `ServeTopologyPlan` 参数的 `.activeCleanupOwners`，standalone 必须为唯一 `standalone-server`；缺失、重复、计算属性、替换或新增构造均拒绝。② 按 raw symbol 建有限精确 owner：`CoreHostRpcLink` 仅五个现行 facade/broker；`RpcClient/createRpcClient` 仅 core connection 与 stop；`CoreHostConnection` 仅 repl 与 workspace command。method owner 明确为“五个 facade/broker + core connection + stop”，repl/workspace 只可构造和注入 connection；删除所有 `rpc-*` 前缀授权。各 symbol 精确 owner 之外的取得/import 与任何 re-export 均拒绝；精确 facade/broker 可声明 DI 输入类型并私有持有，但不得以 public/protected 实例成员、getter/方法、变量导出或返回值泄漏 raw runtime value；core connection 是唯一能力提供模块。notification-only 与 mesh 按精确 receiver 放行。③ 直接变异生产源码覆盖两构造点、八配置、同前缀新 owner、event bus/presenter 扩权、精确 facade 公开 raw link、wrapper/re-export、未知/动态 method；正例覆盖现行 facade/core/stop/repl/workspace、standalone、私有 DI、notification-only 与 mesh。不得新增运行时 registry、通用调用图或第二 RPC 框架。**完成判据：**F29-01～F29-10 每格均有正反断言；上述负例全部确定失败，现行 capture、八配置、S7 lint 与 golden 同输入通过且无合法入口误杀。**实施证据：**C29-23 将 workspace symbol export/re-export 解析复用于全部生产 `CleanupRegistry` 构造，anchor/standalone 精确 owner 输入及新增、替换、别名、namespace、本地转导均由直接变异拒绝；C29-24 删除路径前缀授权并按三类 raw symbol 冻结精确 owner、method owner 与公开逸出边界；C29-25 在最终实现输入上直接测试 14/14、`pnpm s7:lint` 与 canonical golden 检查通过，生产装配、capture 和 golden 语义未变化；C29-26 在冻结指纹 `sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1` 上逐格重建 F29-01～F29-10，确认全部正反变体均有唯一 owner、有限判定输入和确定拒绝终态；C29-27～C29-30 四路冷启动对抗分别从 registry 构造/topology、cleanup exact-set、raw symbol/canonical RPC、用户价值与范围独立复核，零新增反证；C29-31 对 P29-05、C29-23～C29-30、M29-01 与 A29-05～A29-08 完成差异审计，P29-05 以“修复后复核通过”关闭。 | 已验证 |
| U29-02 | **P1｜工作量小｜来源 P29-02。** `inspectProductionSource` 当前只识别具名 `ImportDeclaration` 的局部名称与字符串 module specifier：`MemoryStore as Alias` 取 alias 后不再命中，re-export、namespace、dynamic `import()`、`require()`、`import = require` 与 package manifest 均未进入同一判定；server 动态取得 executor、executor 动态取得 server，以及经 workspace re-export 转导全局可写 owner 都可绿色通过，非字面动态加载还能完全逃离包边识别。当前 `server`/`executor` manifests 与生产源码未发现真实反向边，受保护包也未发现已发生的 Store owner 旁路。**价值裁决记录：**原结论为 P1/中且影响描述易被理解为当前运行图已违规；当前生产事实推翻该表述，损失收窄为本单元结构门禁对常见违规候选变更假通过；新决定为保留 P1、工作量小，修复后只在受保护包、禁止 owner 集或允许依赖边变化时重开。 | 有限结构规则按局部标识符和单一 import 语法判定，没有先规范化静态/动态依赖形态、沿 workspace export 恢复原始 owner 定义并把 manifest 的生产边纳入同一受保护边集合。 | **生产端：**executor、runtime-host、orchestrator、tools-builtin、server 的生产源码、其可达 workspace export/re-export 边及五包 manifest。**类型组合：**named/aliased/default/namespace import、re-export、dynamic import、require/import-equals、字面/非字面 specifier、生产依赖字段、原始/局部符号名；纯 devDependency 不单独构成生产违规。**消费者：**`validateS7Structure` 与仓库 lint/CI。**异常终态：**server↔executor 反向依赖或 MemoryStore/SkillStore/AnchorWorksceneRegistry 的导入、转导、动态取得绕过门禁。**测试：**当前仅覆盖普通 named/bare import，缺各有限语法、转导和 manifest 负例；受影响审查项 IR29-20～IR29-21、IR29-27、IR29-35～IR29-37。 | 只扩展现有 AST/manifest 门禁：把 ImportDeclaration、ExportDeclaration、ImportEqualsDeclaration、dynamic `import()`、`require()` 与五个 package manifest 的 dependencies/optionalDependencies/peerDependencies 规范化成 module edge，受保护源码中的非字面动态加载 fail-closed，devDependencies 仅在生产源码实际引用时随源码边判定；named alias 按 `propertyName ?? name` 恢复原名，并沿当前 workspace 的有限 export/re-export 边解析到禁止 owner 定义，namespace/default 对暴露禁止 owner 的模块 fail-closed，再以现有受保护根、禁止 owner 集和 server↔executor 禁止边统一判定。补每种语法、转导、manifest、合法端口 import 和当前生产图直接测试，错误报告真实包边及原始符号；不建设通用依赖图或新 lint 框架。验收为当前合法图通过，alias/re-export/namespace/dynamic/require/import-equals/manifest 的全部有限绕过及非字面动态加载确定失败，合法类型/端口导入及纯测试依赖不误杀。 **实施证据：**C29-09～C29-11、C29-17～C29-18 与 A29-03 修复后复核通过；五包生产图、有限 AST/manifest/workspace 转导门禁通过。 | 已验证 |
| U29-03 | **P2｜工作量小｜来源 NB29-01。** `scheduler-architecture.md` 的“当前生产架构”仍称旧 DeliveryPipeline/queue/store“只允许一次性排空迁移，排空后删除”，而执行规格的现行合同、S7 第 26 项、公开符号表及源码均表明旧链已整体退役、无生产装配和公开入口；现存 `AuthorityDeliveryPipeline/AuthorityDeliveryQueue` 是新权威链，不能被旧名称误伤。现有 `validateDueDocuments` 对该文档只检查任意位置出现 `JobJournal`，无法阻止当前段重新出现迁移期陈述。 | 旧链退役后只同步了规格、代码和 denylist，当前架构段及其文档门禁没有共同绑定“已整体退役”的现行事实，导致弱 token 检查可在正文自相矛盾时仍通过。 | **生产端：**无，旧链已退役；现行 AuthorityDelivery 链必须保留。**类型组合：**当前生产架构段、非现行历史段、旧/新同名 delivery 概念。**消费者：**维护者、实现审查及 `validateDueDocuments`。**异常终态：**把旧链误认成仍允许的迁移入口，或错误删除现行 AuthorityDelivery 组件。**测试：**当前/历史段语义及 existing due-document lint；受影响审查项为 §十三 scheduler 文档同步、IR29-36～IR29-37。 | 把当前段改为“旧 DeliveryPipeline/queue/store 已整体退役，生产装配与公开入口均不存在；新 AuthorityDelivery 日志/outbox/状态目录是唯一链”，历史段继续明确非现行；同时把现有 scheduler due-document 规则收紧为只检查当前生产架构段的必要退役事实并拒绝“仍可排空迁移”等现行措辞，保留 AuthorityDelivery 白名单。验收为文档、规格、源码与 denylist 一致，旧链复活或当前段退回迁移期措辞会使现有 `s7:lint` 失败，历史推演无需改写。 **实施证据：**C29-12 与 A29-04 修复后复核通过；scheduler 当前段、现行 AuthorityDelivery 白名单和 due-document 门禁一致。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX29-01 | 原 P29-06 主张 S7 owner/capability 门禁仍可被 topology 参数重绑、raw-RPC 类型 alias/heritage、调用包装或导出容器后置赋值绕过，应评 P1 并扩展 AST provenance/value-flow。当前生产 `planServeTopology → runServerProcess → CleanupRegistry` 的 owner 集全等，两处 registry 构造唯一；raw-RPC 只在有限 facade/core/stop/composition owner 可达，现行方法均反绑 canonical registry。 | 这些反例都要求未来新增参数重赋值或跨文件类型/值包装，当前交付物不存在可达调用链；第 29 单元冻结合同只要求当前生产入口 exact-set、漏/双映射失败、角色条件分支、依赖边和 canonical RPC 对账，不要求对任意 TypeScript 语义改写作完备分析。现有 topology 测试、生产 capture、直接负例、S7 lint 与 golden 已提供成比例证据；继续扩展会把有限提交门禁变成无当前用户价值的通用分析器。 | 价值裁决基线：65 路径当前交付物；独立审查 IR29-03、17、18、27、32、35～37 复审；生产构造/owner/import 扫描；M29-01 与 M29-X 有效证据。 | 生产源码实际出现 topology 参数或 owner 身份重写；raw capability 经 alias/heritage/调用包装/导出容器进入非 owner；或权威架构明确把这些有限形态加入当前合同。重开须同时给出可达调用链及现有直接证据不足之处。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |
| L29-01 | U29-01；A29-01/A29-02 曾由 P29-04 重开，A29-06/A29-07/A29-08 又由 P29-05 重开 | 把“已扫描到 descriptor/文件”误当成“有限生产 owner 已被门禁机械锁定”：未直接变异组合根的 owner 注入，还以任意 `rpc-*` 路径授权 raw client，导致 lint 自有规则与 golden 循环自证。 | 每次 S7 exact-set 审查必须直接删除/替换 anchor 与 standalone registry 的 owner 输入，并在现有可信文件和新建同前缀文件中扩大、公开或返回 raw link；门禁须拒绝这些变异，同时放行有限合法 owner 与 mesh receiver。适用于 topology、registry 构造、cleanup owner、CoreHostLink/RpcClient 或 RPC facade 边界变化。 | P29-04 轮曾完成按生产消费者扫描，但 P29-05 以 owner 注入删除、event bus 扩权和新 `rpc-*` owner 三个真实变异证明检测仍不充分；反证已并入 U29-01。P29-05 修复轮：C29-23～C29-25 已直接执行删除/替换 owner、event bus 扩权、同前缀新增 owner、公开逸出与合法 receiver 正例；C29-27～C29-30 在冻结指纹上独立复核，检测动作通过。第一轮冻结终审：重新读取真实构造/owner 与测试变异，anchor/standalone owner 删除替换、event bus 扩权、同前缀新增 owner、公开逸出均被当前门禁拒绝，合法 owner/notification/mesh 通过。第二轮冻结终审：从 raw symbol/receiver 与公开逸出边界重新推导，核对测试中删除 owner、错 standalone、alias/namespace/new constructor、同前缀 owner、event bus 扩权、public 返回及 mesh 正例，检测动作再次通过。 |

## U29-01 专项固定矩阵

| 矩阵编号 | 输入与直接变体 | 唯一 owner / 稳定身份 | 线性化与确定终态 | 冻结指纹上的事实与反例结论 |
| -------- | -------------- | --------------------- | ------------------ | -------------------------- |
| F29-01 | anchor+executor，surface 有/无 | `anchor-host` + `anchor-local-executor` | `planServeTopology` 同时决定 host、executor loader 与 active owners | C29-26：两个 surface 等价配置的 topology、owner、entryKeys 全等，local executor cleanup 存在且唯一 |
| F29-02 | anchor 无 executor，surface 有/无 | 仅 `anchor-host` | 同上；local-executor descriptor 在注册时被拒绝 | C29-26：两个配置全等且不含 executor cleanup；错 owner 运行时零注册 |
| F29-03 | executor host，surface 有/无 | 无 CleanupRegistry owner | executor host 自有 `try/finally`，不进入 cleanup registry | C29-26：两个配置 entryKeys 全等且 cleanup 为空；未虚构 anchor/server cleanup |
| F29-04 | empty 与 surface-only | disabled，无 owner | host/loader 均不启动 | C29-26：两个配置 entryKeys 全等且 cleanup 为空 |
| F29-05 | 全部生产 `CleanupRegistry` 构造：anchor 注入、standalone 默认及新增构造点 | anchor 为 `ServeTopologyPlan.activeCleanupOwners`；standalone 为 `standalone-server` | 复用现有有限 export/re-export resolver 恢复构造符号，覆盖 named/namespace alias；全量生产 AST 在构造点冻结 owner 输入 | C29-26/C29-27：生产构造恰为两点；删除、替换、缺失、重复、计算属性、spread、错 owner、alias/namespace/本地转导或新增构造均失败 |
| F29-06 | anchor+executor、anchor-only、surface 等价、executor-only、disabled；cleanup 新增、删除、错属与条件装配 | topology plan 的 active owner 集 + descriptor `owner:role:id` | owner 输入先于注册冻结；非 active owner 注册由 `CleanupRegistry` fail-closed | C29-26/C29-28：八配置 owner/entryKeys 与真实 host 全等；descriptor 与构造 owner 任一漂移均 fail-closed |
| F29-07 | 五个现行 facade/broker、core connection、`serve stop`、repl/workspace composition owner | 按 raw symbol 分组的有限精确文件集 | capability owner 分组判定；method owner 仅为五个 facade/broker + core connection + stop，repl/workspace 只可构造/注入 connection | C29-26/C29-29：路径前缀授权已删除；新增同前缀文件、错 owner、未知字面量和未闭合动态 method 均失败，composition owner 正常通过 |
| F29-08 | event bus/四类 presenter、wrapper/re-export、公开实例属性/参数属性、返回/转发与 raw client 逸出 | 非 owner 只持 `CoreHostNotificationLink`；精确 owner 可声明 DI 输入类型，但 raw runtime value 不得越出 | CLI 全生产文件检查 raw symbol 的取得、出口与导出实例 surface | C29-26/C29-29：notification→raw、public/protected 成员、getter/方法返回、export assignment、re-export 与嵌套 wrapper 失败；私有 DI/notification-only 通过 |
| F29-09 | 合法 canonical 字面方法、受约束 private forwarder、未知与动态 method | canonical RPC registry | 精确 owner 内调用逐项判定；动态仅在全部调用点闭合 | C29-26/C29-29：当前 facade/core/stop 通过；未知及未闭合动态调用失败 |
| F29-10 | assignment/data-plane/evidence/global-query 等 mesh request | mesh receiver，不持 CLI raw-host capability | receiver 类型与文件 owner 均不进入 public RPC 门禁 | C29-26/C29-29：真实 mesh adapter 零误杀；伪装成 CLI raw owner 时按精确集合拒绝 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| M29-01 | 固定矩阵：§八 row/mapping、Commander/slash/skill/channel/lifecycle/cleanup/tool/RPC 与全部八种角色配置的生产 exact-set | `node --import=tsx/esm --test scripts/s7-entry-coverage.test.mjs`；`pnpm s7:lint` | §八、全部生产注册源、topology/cleanup/RPC capability、S7 capture/test 与 golden | 修复直接验证 / 中 / 直接测试约 19s，S7 lint 约 65s | C29-25：直接测试 14/14 通过；S7 lint 与 canonical golden 检查通过；两处 registry 构造、owner 注入、同前缀新文件、event bus/presenter 扩权、公开逸出、未知/动态 method 与 mesh 正反例均闭合 | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |
| M29-02 | 五个受保护包的有限依赖语法、workspace 转导、manifest 边与合法端口 | 同 M29-01 的结构变异集；真实生产 S7 结构门禁 | 五包生产源码/manifest、workspace exports 与结构检查 | 修复直接验证 / 小 / 共用 21.0s | C29-09～C29-11、C29-17～C29-18 通过：server owner、alias/re-export/local 转出、dynamic/require/import-equals 与 manifest 绕过均拒绝 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-03 | scheduler 当前段只陈述旧链整体退役并保留新 AuthorityDelivery，历史保持非现行 | 同 M29-01 的 scheduler 当前段变异；真实 due-document 门禁 | scheduler 当前段、规格、delivery 导出、denylist | 修复直接验证 / 小 / 共用 21.0s | C29-12 通过：当前段退回迁移期措辞确定失败，现行 AuthorityDelivery 白名单保留 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-X | 三项直接交界、派生 golden 与当前源码构建闭包 | `pnpm build`；server/CLI 串行类型检查；Biome 变更文件检查 | 27 个 U29-01 交付文件、golden 与 workspace 构建输入 | 收口验证 / 中 / build 328.2s，类型检查 55.0s，Biome 9.6s | workspace build、server 类型检查与 23 个格式输入通过；CLI 仍仅有账本既存的 9 个非变更文件基线错误 | sha256:490c445950b767dccc42ef65ac53cebb6550485dda627306f7594189762fc4ef | 有效 |
| M29-04 | 冻结前派生资产预检与单元提交验证 | 冻结前一次 `pnpm s7:lint`；提交验证复用 M29-01～M29-X 与本行预检，仅执行 `git diff --check 4eaf3e2f`、65 路径 manifest 复算/对账及验证进程与临时产物检查 | 65 路径 `delivery-manifest-v1`；G29-01～G29-07；工作台文件排除；workspace build 输入由 M29-X 覆盖，后续实现输入未变 | 冻结准备 + 单元提交验证 / 小 / 预检 88.9s、终验 2.9s | `s7:lint` 14/14 与 canonical golden check 通过；复用 M29-01～M29-X 的直接、结构、文档、构建、类型和 Biome 证据；`git diff --check` 通过；交付闭包为 61 修改、2 新增、2 删除，复算指纹全等；无未跟踪文件、无残留验证进程。未重复构建、直接测试，未运行包全测或模块回归 | `delivery-manifest-v1:1716fba0015f801d05a10d8ac2da57219167a490aa669ad57d880c9865fd6701` | 有效 |
| A29-01 | 冷启动对抗：生产注册源与入口 exact-set | 只读重建 RPC/Commander/slash/skill/channel/lifecycle/cleanup/tool 与四种有效角色集合 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-13 缺 anchor-only、C29-14 exclusion reason/schema 漂移、C29-15 cleanup alias 直写、C29-16 aliased client/公开动态 RPC 转发均修复；复审零未处置反证 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-02 | 冷启动对抗：重数/action/phase/角色适用集合 | 独立构造重复 row/tuple、actionless、phase 漂移、writer 与角色缺失 | 当前冻结指纹 | 对抗复审 / 小 / — | tuple 重数在物化前拒绝，真实 action、双向 phase、assembly 与四角色集合均闭合 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-03 | 冷启动对抗：依赖 AST/manifest/workspace 转导 | 独立构造 server owner、别名、先导入后本地转出、dynamic/require/import-equals、公开动态 RPC | 当前冻结指纹 | 对抗复审 / 小 / — | C29-17 server 漏入 owner 禁边、C29-18 workspace 先导入再本地转出均修复；有限绕过 fail-closed，合法端口与精确包边零误杀 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-04 | 冷启动对抗：退役事实、当前文档与范围价值 | 当前段/历史段、denylist、新 AuthorityDelivery 与禁止扩面双向对账 | 当前冻结指纹 | 对抗复审 / 小 / — | 旧链仅在当前段陈述整体退役，历史与新链边界清晰；未新增 runtime registry、通用依赖图或诊断设施 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-05 | 冷启动对抗：全部 registry 构造与 topology owner 反绑 | F29-01～F29-05，抛开旧 golden 从 host loader 与生产构造反推 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-27：生产构造恰为 anchor/standalone 两点；八配置与 surface 等价关系全等；构造新增、替换、alias/re-export、owner 缺失或漂移均 fail-closed | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |
| A29-06 | 冷启动对抗：cleanup descriptor 与条件装配 exact-set | F29-01～F29-06，独立核对 descriptor、active owner、注册条件和 entryKeys | 当前冻结指纹 | 对抗复审 / 小 / — | C29-28：anchor/executor/disabled/standalone 的 owner 与 descriptor 双向全等；新增、删除、错 owner、条件装配漂移在 AST 或运行时 owner 栅栏确定失败 | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |
| A29-07 | 冷启动对抗：CLI raw symbol owner/receiver 与 canonical RPC 闭包 | F29-07～F29-10，逐文件反推三类能力取得、出口、method owner 与 receiver | 当前冻结指纹 | 对抗复审 / 小 / — | C29-29：精确 owner 外 import/取得及任意 re-export、public/protected/返回/嵌套 wrapper 逸出、未知/动态 method 均失败；合法 facade/core/stop/repl/workspace、私有 DI、notification-only 与 mesh 零误杀 | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |
| A29-08 | 冷启动对抗：用户体验与范围价值 | 用户运行链、提交门禁、有限 owner/capability 与禁止扩面双向对账 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-30：本轮仅改现有 lint 与直接测试，生产装配、用户能力、capture/golden 不变；实际价值是阻止权限/角色漂移的假绿提交，未引入运行时 registry、通用调用图或相邻功能 | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |
| D29 | 差异审计：历轮反证、专项审查与四路记录机械并集 | C29-01～C29-31、M29-01～M29-X、A29-01～A29-08、P29-05 | 当前冻结指纹 | 差异审计 / 小 / — | C29-31：历轮反证全部保留；P29-05 及其 owner 注入删除、event bus 扩权、同前缀新 owner 变体均“修复后复核通过”，无未处置或无依据消失的发现 | sha256:96570ce480ceea318ea521d48971ebb8e493ac042cb9dcd2a827b9d2dba21bf1 | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 是           | 0        | `delivery-manifest-v1:1716fba0015f801d05a10d8ac2da57219167a490aa669ad57d880c9865fd6701` | 通过：R29-01～R29-X 均 1/2，EX29-01 未重开 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是           | 0        | `delivery-manifest-v1:1716fba0015f801d05a10d8ac2da57219167a490aa669ad57d880c9865fd6701` | 通过：R29-01～R29-X 均 2/2，L29-01 再执行，EX29-01 未重开 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |
| I29-01 | **高风险｜入口事实漏捕或派生资产循环自证。** 真实 producer 新增、删除、条件装配或重数变化未进入 catalog，mapping/golden 与错误答案同步变绿 | 生产 registry/Commander/slash/skill/channel/lifecycle/cleanup/tool descriptor、§八 37 row、capture/test/golden；`delivery-manifest-v1:1716fba0…` | 已覆盖 | 从 producer 与 row 两端独立对账：144 entry 先保留重数，空/重/漏/双/stale/乱序确定失败；golden 由当前 capture 生成但 14 项源码变异独立约束其判据，M29-04 check 通过，零新增问题 | 任一生产注册源、row/mapping、capture 判据、直接变异或 golden 生成路径变化 |
| I29-02 | **高风险｜角色、cleanup owner 或 raw-RPC 能力漂移。** topology 与 registry/receiver 各自正确但组合后错属、越权或合法路径误杀 | host loader、八配置、两处 registry 构造、cleanup descriptor、CoreHostNotificationLink/CoreHostRpcLink/RpcClient/CoreHostConnection 与 canonical RPC；`delivery-manifest-v1:1716fba0…` | 已覆盖 | 从实际 host 副作用与能力取得点重建：owner 在启动前冻结并在注册时反绑；三类 raw symbol 只在有限 owner 可达，notification/mesh 不持请求能力。L29-01 的 owner 删除替换、同前缀扩权、公开逸出及合法正例均闭合，EX29-01 前提未发生 | topology/registry 构造或 owner 注入、cleanup descriptor、raw symbol owner/receiver、canonical method 或 EX29-01 前提变化 |
| I29-03 | **高风险｜结构依赖或旧入口绕过造成第二 owner/事实源。** alias/re-export/dynamic/manifest 绕过包边，或有限 denylist 误删现行链 | 五个受保护包生产源码/manifest/workspace exports，退役 delivery/advancement 路径，AuthorityDelivery/canonical evidence 与迁移 reader；`delivery-manifest-v1:1716fba0…` | 已覆盖 | 静态/动态依赖形态先规范化并恢复原始 owner，server↔executor 和可写 Store 禁边统一 fail-closed；生产/公开源无退役 token，现行 AuthorityDelivery 仍导出并装配，必要 reader 保留，零新增问题 | 受保护包、禁止 owner/依赖边、workspace export、manifest、退役清单或现行恢复链变化 |
| I29-04 | **一般风险｜当前合同与历史文字分叉。** 使用者按过期架构恢复旧入口或误删现行组件 | §十三十份到期文档、规格当前段、公开类型/导出、scheduler due-document 判据；`delivery-manifest-v1:1716fba0…` | 已覆盖 | 逐份变更只陈述已落地的 S4/S7 现行边界；scheduler 当前段明确旧链整体退役、AuthorityDelivery 唯一，历史段降级；S10 未提前改写，M29-04 会拒绝当前段退回迁移期措辞，零新增问题 | 当前生产合同/公开导出、到期状态、历史/当前段边界或 due-document 判据变化 |
| I29-05 | **一般风险｜lint 非确定、副作用或成本失控导致验证不可复用。** 捕获启动服务/联网/写状态，check 改 golden，或扫描无界 | S7 imports、CLI main guard、有限 packages/doc/manifest 扫描、golden check/write 分支、根 lint 链与 M29-01～M29-X；`delivery-manifest-v1:1716fba0…` | 已覆盖 | capture 导入均暴露纯 descriptor/plan 且 CLI main 有直接执行守卫；lint 只读固定根，symlink 不下钻，无网络/常驻 timer/运行态写；golden 仅 `--write` 写入，check 全等比较。本次 88.9s 正常退出，构建证据按同输入复用，零新增问题 | 导入模块顶层副作用、扫描根/文件类型、golden 模式、lint 消费链或构建输入变化 |
| I29-X | **高风险｜跨区组合。** 入口 catalog 正确但角色/结构/退役/文档或验收链在直接交界失配，产生假绿提交或用户能力回归 | I29-01～I29-05 全部输入与结论、G29-01～G29-07 的 65 路径闭包；`delivery-manifest-v1:1716fba0…` | 已覆盖 | 在其余风险面完成后串联“真实入口→唯一 row→适用角色/owner→包边→现行链/合同→单一 lint”；错误均在提交前 fail-closed，合法 RPC/CLI/channel/tool、AuthorityDelivery/canonical evidence 和用户能力保持可达，无未归类路径、无新增问题 | 任一 I29 风险面的边界、输入、状态或结论变化；新增交付文件或冻结指纹变化 |

<!-- registration-complete: unit-29.gen-1 -->
