# 单元登记:第 29 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:29
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-06
- **登记来源**:用户要求将第 29 单元独立审查的当前问题转入正式问题列表并继续收敛

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U29-01～U29-03 已验证；本目标完成，未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否
- **交付物文件集**:本轮 15 个实现、脚本、golden 与架构同步文件；工作台状态文档不计入交付指纹
- **当前交付物指纹**:`sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d`
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

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |

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
| U29-01 | **P1｜工作量中｜来源 P29-01。** 规格 §八要求每个真实入口恰命中一个 rowId 或显式排除，但 `scripts/s7-entry-coverage.mjs` 先用正则抽 rowId、再用 `Object.fromEntries` 折叠 mapping；重复 rowId 和跨组双映射在校验前已丢失。生产捕获还存在七类绿色假通过：`captureCliCommandDescriptor` 以“叶节点”冒充 action；`slashSources`/`cleanupSources` 是固定文件表，动态 skill 与 InboundRouter 由 lint 自填；Agent/Segment phase 只做成员合法的单向类型约束；extra-tool capability 未反向约束 assembly 全集；CLI→RPC 只扫 `rpc-*` 与 `core-host-connection.ts`，遗漏 `serve/stop.ts` 等真实调用；全局 entryCoverage 未按 `planServeTopology` 核准角色适用集合。RPC registry、channel factory/Feishu event、builtin/Task descriptor 已与生产共源，可直接复用。**价值裁决记录：**原结论为 P1/中并笼统认定当前入口覆盖能力不成立；当前目录与生产图未发现已发生的实际漏绑或错绑，推翻并收窄为本单元核心交付的提交门禁会对上述常见候选变更绿色假通过；新决定为保留 P1/中并闭合全部同根捕获边界，修复后仅在权威入口类别、角色拓扑或生产注册事实变化时重开，不恢复运行时已损坏主张。 | 入口合同横跨“规格 row 集→生产 descriptor 集→映射声明→角色适用集合”，当前实现却在校验前丢失重数，并以固定扫描点、自报 descriptor 和单向约束替代部分生产事实，导致检查对象不是生产注册源的 exact-set。 | **生产端：**RPC、Commander/slash/动态技能、InboundRouter/channel、Agent/Segment lifecycle、四角色 CleanupRegistry、builtin/extra/Task 写工具及 CLI RPC 转发。**类型组合：**rowId×entry key×单一 target、action/phase、角色拓扑×适用入口。**消费者：**`captureS7EntryCoverage`、canonical registry golden、`s7:lint` 与仓库 lint/CI。**异常终态：**重复/双映射、actionless、漏注册源、phase 漂移、条件装配或写工具漂移、未知或未受约束的动态 RPC 仍绿色。**测试：**现有自报 validator 单测不足，须变异真实 capture/生产 descriptor。受影响审查项 IR29-02、IR29-03、IR29-05～IR29-09、IR29-11～IR29-12、IR29-17～IR29-18、IR29-27、IR29-35～IR29-37。 | 在现有 S7 capture 内一次闭合：①严格解析 §八表头/rowId，先验 schema、格式和唯一性；mapping 保留为只读 tuple 多重集，先拒绝同 key 重复/双目标再构造查询 Map。②Commander 的 `hasAction` 只取真实 action handler；六个 builtin registrar 由 REPL 实际调用图和真实 inline descriptor 捕获，`SkillCommandSource`、InboundRouter/channel event、四角色 cleanup 注册、Agent/Segment phase 与 extra-tool assembly 复用生产窄 descriptor 或实际调用事实；phase 加双向类型全等，extra-tool 按 main/workscene 实际 assembly 反向对账。③CLI 全生产源码中的 RPC request 字面量统一对账 canonical RPC registry，非字面方法除非先受同一 registry 判别联合约束否则 fail-closed；entry capture 按现有 `planServeTopology` 输出各角色配置的适用集合，映射语义只保留一份。④golden 与直接测试变异真实 row 表、mapping tuple、Commander/registrar/phase/cleanup/assembly/RPC/角色源，禁止仅给 validator 自报答案。验收为当前合法 catalog 及单机、anchor+executor 适用集合通过；重复 row/target、actionless、任一新增/删除/错绑入口、phase、cleanup、authority writer、未知/动态 RPC 或角色错装均在 `s7:lint` 确定失败并定位稳定 key/rowId；不得新增自动发现框架、运行时 registry 或通用基础设施。 **实施证据：**C29-01～C29-08、C29-13～C29-16 与 A29-01～A29-02 全部修复后复核通过；13/13 真实变异、生产 S7 门禁及 golden 当前输入通过。 | 已验证 |
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

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| M29-01 | 固定矩阵：§八 row/mapping、Commander/slash/skill/channel/lifecycle/cleanup/tool/RPC 与四种有效角色集合的生产 exact-set | `node --import tsx --test scripts/s7-entry-coverage.test.mjs`；真实生产 `s7-entry-coverage.mjs` | §八、全部生产注册源、S7 capture/test 与 golden | 修复直接验证 / 中 / 21.0s（最终直接测试） | 13/13 通过；C29-01～C29-08、C29-13～C29-16 均由真实输入变异证实修复，生产门禁通过 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-02 | 五个受保护包的有限依赖语法、workspace 转导、manifest 边与合法端口 | 同 M29-01 的结构变异集；真实生产 S7 结构门禁 | 五包生产源码/manifest、workspace exports 与结构检查 | 修复直接验证 / 小 / 共用 21.0s | C29-09～C29-11、C29-17～C29-18 通过：server owner、alias/re-export/local 转出、dynamic/require/import-equals 与 manifest 绕过均拒绝 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-03 | scheduler 当前段只陈述旧链整体退役并保留新 AuthorityDelivery，历史保持非现行 | 同 M29-01 的 scheduler 当前段变异；真实 due-document 门禁 | scheduler 当前段、规格、delivery 导出、denylist | 修复直接验证 / 小 / 共用 21.0s | C29-12 通过：当前段退回迁移期措辞确定失败，现行 AuthorityDelivery 白名单保留 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| M29-X | 三项直接交界、派生 golden 与当前源码构建闭包 | `pnpm s7:registry-golden`；复用 `pnpm build` 并在最终 CLI 源码变更后执行 `pnpm cli:build` | 15 个交付文件、golden 与 workspace 构建输入 | 收口验证 / 中 / build 316.4s，CLI rebuild 11.4s，golden 19.6s | golden 当前输入通过；workspace build 与最终 CLI rebuild 通过；core/orchestrator/server/runtime-host 类型检查通过，CLI 仅有 9 个既存且不在变更文件的基线错误 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-01 | 冷启动对抗：生产注册源与入口 exact-set | 只读重建 RPC/Commander/slash/skill/channel/lifecycle/cleanup/tool 与四种有效角色集合 | 当前冻结指纹 | 对抗复审 / 小 / — | C29-13 缺 anchor-only、C29-14 exclusion reason/schema 漂移、C29-15 cleanup alias 直写、C29-16 aliased client/公开动态 RPC 转发均修复；复审零未处置反证 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-02 | 冷启动对抗：重数/action/phase/角色适用集合 | 独立构造重复 row/tuple、actionless、phase 漂移、writer 与角色缺失 | 当前冻结指纹 | 对抗复审 / 小 / — | tuple 重数在物化前拒绝，真实 action、双向 phase、assembly 与四角色集合均闭合 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-03 | 冷启动对抗：依赖 AST/manifest/workspace 转导 | 独立构造 server owner、别名、先导入后本地转出、dynamic/require/import-equals、公开动态 RPC | 当前冻结指纹 | 对抗复审 / 小 / — | C29-17 server 漏入 owner 禁边、C29-18 workspace 先导入再本地转出均修复；有限绕过 fail-closed，合法端口与精确包边零误杀 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| A29-04 | 冷启动对抗：退役事实、当前文档与范围价值 | 当前段/历史段、denylist、新 AuthorityDelivery 与禁止扩面双向对账 | 当前冻结指纹 | 对抗复审 / 小 / — | 旧链仅在当前段陈述整体退役，历史与新链边界清晰；未新增 runtime registry、通用依赖图或诊断设施 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |
| D29 | 差异审计：历轮反证、专项审查与四路记录机械并集 | C29-01～C29-18、M29-01～M29-X、A29-01～A29-04 | 当前冻结指纹 | 差异审计 / 小 / — | C29-01～C29-12 修复后复核通过；C29-13～C29-18 同根合并并修复后复核通过；零消失或未处置发现 | sha256:f555b87b77d0a43592471c66b1636a53147d54d368ecbddc09fcbb9b830a8c2d | 有效 |

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
