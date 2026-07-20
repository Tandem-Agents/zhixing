# 单元登记:第 16 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:16
- **generation**:1
- **登记时间**:2026-07-19
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 16 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、分片账本、九类核查面行、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成；最新指纹两轮独立终审零新增，最终构建、串行包测与全部门禁通过
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是；冻结指纹 `971fbe25f6cc48c81776e9935a55b947735b5568b95b5d7964177e9ed9a1224a`，47 文件
- **交付物文件集**:`packages/core/src/{contracts/{foundation.ts,protocol.ts},protocol/{assignment.ts,canonical.ts,index.ts,manifest.ts,manifest.test.ts,permission-snapshot.ts,stream.ts,validation.ts,values.ts},security/{index.ts,types.ts},types/{index.ts,runtime-execution-profile.ts}}`；`packages/owner-kernel/src/{conversation-transition-authority.ts,__tests__/conversation-transition-authority.test.ts,job-assignment.ts,types.ts}`；`packages/executor/src/{assignment-ledger.ts,__tests__/assignment-ledger.test.ts,__tests__/job-assignment.test.ts}`；`packages/cli/src/{executor-snapshot-version-store.ts,setup-delivery.ts,startup.ts,__tests__/{executor-snapshot-version-store.test.ts,setup-authority-delivery.test.ts,setup-delivery.test.ts,startup-secret-store.test.ts},runtime/__tests__/runtime-host.test.ts,serve/{access-surface.ts,access-surfaces.ts,command.ts,conversation-protocol-runtime.ts,__tests__/conversation-protocol-runtime.test.ts,__tests__/conversation-surface.test.ts}}`；`packages/providers/src/{credentials-loader.ts,__tests__/credentials-loader.test.ts}`；`packages/orchestrator/src/runtime/{create-agent-runtime.ts,__tests__/create-agent-runtime.test.ts}`；`packages/runtime-host/src/{runtime-host.ts,session-adapter.ts}`；`packages/server/src/{perspectives/{controller.ts,__tests__/controller.test.ts},__tests__/__goldens__/distributed-runtime-structure.golden.json}`；`packages/mesh/src/protocol-version.ts`；`research/design/modules/distributed-runtime/specification.md`
- **当前交付物指纹**:`971fbe25f6cc48c81776e9935a55b947735b5568b95b5d7964177e9ed9a1224a`（47 文件；`SHA256(UTF8(sorted(path<TAB>SHA256(file-bytes)<LF>)))`）
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的 S4 边界与 `research/design/modules/distributed-runtime/specification.md` 第 16 单元、能力版本匹配合同

## 固定边界

- **功能范围**:落地 ExecutionManifest、CapabilityDescriptor、ExecutorVersionInventory、CredentialBindingDescriptor、EnvironmentRequirement 的完整运行时合同；提供 owner/executor 共用的 `matchManifest`；建立配置、资产与权限快照的最小版本发布和同步接缝
- **架构不变量**:匹配谓词单源且确定性；descriptor 与 inventory 身份、revision、签名及关联版本 fail-closed；秘密和真实路径不上 wire；版本或能力失配只返回稳定分类并保持 queued/拒收，绝不产生 assignment 候选或执行副作用
- **验收条件**:版本与能力失配矩阵、同机/跨机 matcher conformance、秘密扫描、快照版本回退与序列约束通过；既有 conversation/job 生产行为不变
- **必要上下游**:core contracts/protocol/schema、EnvironmentPort、owner 派发预判接缝、executor received 前复验接缝、配置/资产/权限快照提供端与同步端
- **明确不属于本单元**:第 17 单元的 AuthorityCapability/PermissionSnapshotLease 激活与 principal×方法 guard；第 18 单元的 ResourceGovernor 与资源租约；第 19～20 单元的 mesh 传输和跨机生产启用；第 25 单元的远程环境探测产品接入

## 审查分片

- **是否启用**:否
- **决定依据**:本单元以纯合同、确定性 matcher 和有界版本同步为主，完整闭包可由参数化矩阵机械审查；分片不会降低主要上下文成本
- **完整单元与跨切片必审项**:不适用；完整审查统一覆盖合同、生产/消费接缝、版本回退、安全边界与派生资产

> 不启用时账本留空。本轮进度用于跨窗口续跑,收敛状态用于跨审查轮复用;状态与流转规则见工作台静态区。

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |

### 完整单元横向审查记录

> 启用分片时每轮必填;默认消费封版信息包,有疑问可下钻细节,确认问题或结论失效时重开切片。

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core contracts/protocol/security/runtime profile | 新 wire、验证器、权限规则投影、运行体精确依赖和出口必须同源；合同 schema 与包出口在最终门禁复核 | core 类型检查通过；manifest 50/50；可移植权限正反例与运行体 profile 类型出口通过 | 通过 |
| core stream 摘要链 | 协议摘要必须复用 `byteDigest`，固定向量不得变化 | stream 固定向量已通过；`git diff --check` 无错误 | 通过 |
| owner transition issuer、types 与测试 | matcher 必须位于候选、凭证与 artifact 构造前；SessionRuntime 暴露精确安全/执行快照 | owner 类型检查通过；transition issuer 5/5；生产签发调用点仅一处 | 通过 |
| owner job assignment | job 必须先匹配再惰性物化；历史重放走显式 replay 接口 | `matchManifest` 位于 `plan.materialize()` 前；无生产 `JobJournal` 旁路 | 通过 |
| executor ledger 与双域测试 | 已耐久重放优先；新 assignment 在 received 前复验能力、运行体绑定与权限资产三分终态 | executor 类型检查通过；assignment 167/167、job 201/201；唯一生产构造注入完整 provider/guard | 通过 |
| CLI version/directory/snapshot stores 与测试 | 单调版本、能力目录、权限快照目录必须原子替换、目录 fsync、重启 fail-closed | store 直接测试及 setup 组合测试通过；文件闭包均已归类 | 通过 |
| CLI authority setup/readiness 与测试 | 设备能力高水位与 assignment 精确运行体/权限引用分层；自动 alias 设备隔离 | CLI 六个直接文件 44/44；双会话交错、历史权限引用、动态 readiness 与空投影旁路均覆盖 | 通过 |
| CLI access/runtime/startup 接线与测试 | 唯一生产装配注入同一能力目录、权限快照 provider 与运行体 guard；恢复路径 fail-closed | 两个 production ledger 构造均注入完整；startup generation 与本地/恢复 runtime binding 已覆盖 | 通过 |
| CLI runtime-host 装配测试 | RuntimeHost 的最小测试桩必须实现生产装配读取的 MCP catalog 合同 | runtime-host 与 protocol runtime 隔离 2/2 文件、25/25 项通过 | 通过 |
| providers credential loader 与测试 | SecretStore generation 只参与本机版本输入，不上协议表面 | providers 类型检查及 24/24 通过；协议字段搜索无 generation 泄漏 | 通过 |
| orchestrator runtime 与测试 | 实际装配完成后冻结 tools/MCP/resolved provider IDs，并返回隔离副本 | orchestrator 类型检查与 create-agent-runtime 64/64 通过；精确 profile 防变异测试通过 | 通过 |
| runtime-host capability catalog/session adapter | readiness 汇总可用能力，单次 runtime profile 只报告实际装配依赖并透传到 SessionRuntime | runtime-host 类型检查通过；唯一 `capabilityCatalog()` 生产调用进入 readiness | 通过 |
| server perspectives controller 与测试 | durable synthetic runtime 必须转发真实 managed runtime 的安全与执行快照 | server 类型检查与 controller 12/12 通过；缺快照 fail-closed、精确转发有断言 | 通过 |
| mesh protocol version | mesh 复用 core 协议版本验证，不保留第二份规则 | mesh 类型检查及 protocol-version 3/3 通过；结构边为既有声明依赖 | 通过 |
| specification | 两层版本、权限资产三分终态、PortableTrustRule 与实际运行体绑定必须与实现一致 | 第 16 单元合同逐条对照；冻结 DTO、生产链与负向分类一致 | 通过 |
| structure golden | Unit16 新增 CLI/executor/mesh→core 引用须同步结构基线，且不得新增非法包边或环 | 显式更新后差异仅引用计数/既有依赖边；正常结构门禁 1/1 通过 | 通过 |
| lockfile/行为 golden/其他生成资产 | 无依赖声明、RPC 行为或 schema 生成器变化 | 47 文件清单无 lockfile、行为 golden 或生成 schema；结构 golden 已单独落账 | 不适用:无对应派生变化 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| manifest 匹配 | manifest 自摘要 + executor 当前已验签快照 | owner 凭证构造前预判；executor 首次 received 前复验 | 失配不签发/耐久拒收；已 received 重投复用原结果 | transition issuer、job journal、assignment ledger、未来 mesh adapter | 纯函数；封闭字段与规范排序集合；稳定错误分类 | 通过 |
| capability/version 快照 | 同一设备签名的 descriptor + inventory 二元组 | 耐久目录 CAS accept；信任变更立即失效 | 同版本语义重放；改写、回退、换设备、撤销、身份或 revision 分叉拒绝 | executor 就绪发布端、owner/executor snapshotFor、信任目录 | 每 executor 一份耐久状态与 binding 高水位/墓碑；读取隔离副本 | 通过 |
| 设备代际与权限高水位同步 | 非秘密配置/可执行能力摘要 + 独立权限快照目录 | 文件锁内分别推进 deviceRevision、inventoryRevision 与 permission high-water；目录提交后发布 inventory | 权限变化不抬设备代际；设备变化不重签权限；rename 后目录 fsync，崩溃可重入 | CLI 发布端、版本源、能力/权限目录、matcher | 常数设备状态 + 按 digest 全保留历史权限快照；wire 无内容、路径或秘密 | 通过 |
| assignment 精确权限引用 | 实际 runtime PermissionStore 的语境规则经 PortableTrustRule 规范投影形成签名快照 | 签发时 publishRules；executor received 前按 lease digest/version 验签命中 | 同内容幂等复用；缺资产可恢复拒收；错身份/坏签名不可重试硬拒 | runtime securitySnapshot、CLI catalog、manifest/lease、executor 双域账本、owner rejection 消费链 | 快照按内容寻址且历史全保留；排序、可选字段省略、路径/遥测排除 | 通过 |
| assignment 精确运行体绑定 | 实际 runtime 冻结的 tools/MCP/resolved provider IDs + 签发时 deviceDigest | owner assignment 签发冻结；executor received 前 runtimeBindingGuard 复验 | 签发后 readiness 变化或恢复缺 binding 均耐久拒收；durable received 重放不回查在线态 | orchestrator runtime、runtime-host、CLI durable runtime、server perspectives、executor ledger | 每在途 assignment 一条内存 binding，派发结束删除；崩溃后 fail-closed 并新 assignment 重派 | 通过 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 架构 | 第 16 单元 | 状态 | descriptor/inventory/snapshot revision | 通过:版本身份一致、重放/前进/改写/七域回退矩阵 | 通过:设备代际、权限高水位、精确历史引用与目录高水位逐字段闭合 | 通过:独立复核 CAS、重启、回退、换代、双主体交错与历史引用闭包 |
| 架构 | 第 16 单元 | 入口与生产端 | snapshot providers/manifest builder | 通过:CLI 设备签名发布；manifest 单一构造器；全部 LLM 角色依赖闭合 | 通过:真实 readiness、运行体 profile 与权限权威进入唯一签发链 | 通过:签发前后就绪漂移、互斥运行体与权限语境无旁路 |
| 架构 | 第 16 单元 | 消费端与继承面 | owner/executor matcher | 通过:同一 matchManifest/二元组谓词；同机与 JSON adapter 结果一致 | 通过:owner 预选、executor received 前复验及运行体绑定无旁路 | 通过:validator、matcher、序列化适配与双域账本合同同源 |
| 架构 | 第 16 单元 | 生命周期 | 发布、同步、回退与替换 | 通过:目录只接受语义重放或 revision 前进，撤销即时失效 | 通过:初始化、重启、历史权限引用、换设备与撤销链闭合 | 通过:各写入崩溃窗可重入，已建立状态丢失 fail-closed |
| 架构 | 第 16 单元 | 并发与崩溃点 | 快照更新和复验竞态 | 通过:耐久 CAS 与目录 fsync；executor 决定在 ledger 串行事务内 | 通过:签发后 readiness 漂移、目录 CAS 与账本线性化点一致 | 通过:双发布实例、双会话交错、文件锁、目录 CAS 与 received 决定闭合 |
| 架构 | 第 16 单元 | 异常路径与终态 | revision-conflict/capability-gap | 通过:owner 保持 queued 且零候选；executor 产生 dispatch-rejected | 通过:缺资产可恢复，错身份与坏完整性硬拒，均在 received 前终结 | 通过:缺资产、错身份、坏签名三分稳定且零执行副作用 |
| 架构 | 第 16 单元 | 安全边界 | 签名、秘密、路径与身份绑定 | 通过:设备签名、封闭 schema、自动 alias 设备隔离、秘密不上 wire | 通过:可移植权限投影、设备签名、binding 身份及秘密边界闭合 | 通过:未知字段、跨设备别名、路径/遥测与秘密协议面复核通过 |
| 架构 | 第 16 单元 | 模块边界 | 16/17/18/19/20/25 | 通过:仅版本能力与权限快照资产接缝；未激活后续权限、资源、mesh 产品逻辑 | 通过:本单元只提供冻结合同与最小同步接缝，未越界激活后续机制 | 通过:后续权限激活、资源治理、mesh 传输与环境探测责任未侵入 |
| 架构 | 第 16 单元 | 测试与验收 | 参数化矩阵、conformance、扫描 | 通过:直接矩阵覆盖当前修复族；最终包级证据待冻结终审后执行 | 通过:需求、生产端、消费者与正交负例均有同指纹直接证据 | 通过:迟发现教训 L16-01～07 全部重放，未发现覆盖空洞 |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U16-01 | 初版以摘要前缀转数字作为 revision，内容变化不保证单调，回到历史内容还会复用旧值 | 内容摘要不是有序版本权威 | CLI 发布端、目录回退守卫、重启与配置回退测试 | 使用文件锁、原子替换的耐久单调版本源；同摘要重放、任一变化含回退都递增 | 已验证 |
| U16-02 | 初版本机快照只覆盖调用方配置，未把可执行版本纳入生产组合 | 最小资产版本源不完整 | access surface、CLI publisher、七类 inventory 字段、配置/版本变化测试 | 生产装配以非秘密配置与 CLI 版本共同形成聚合摘要，规范冻结最小生产口径 | 已验证 |
| U16-03 | 初版 matcher 未校验 descriptor.protocolVersion | 版本矩阵漏掉协议版本正交维度 | owner/executor 共用 matcher、同机/序列化 adapter、失配分类测试 | 在单一 matcher 中纳入协议版本并补稳定 capability-gap 负例 | 已验证 |
| U16-04 | 主线 `StreamDigestChain` 绕过 `byteDigest`，导致合同门禁失败 | 同一 B(bytes) 合同存在第二份摘要实现 | core stream 生产/验证、固定摘要向量、contracts lint | 复用 `byteDigest` 且保持逐字节链算法；固定向量 2/2 不变、门禁恢复 | 已验证 |
| U16-05 | device requirement 初版与 executorId 比较，且双记录未强制同签名设备 | 设备身份与可独立命名的执行器身份混同 | manifest 环境选择、快照验证、CLI 本机稳定 executorId、未来多执行器路由 | device 绑定设备签名 keyId；descriptor/inventory 强制同签名设备；保留 executor 独立身份 | 已验证 |
| U16-06 | `ExecutionManifest` 无法声明所需 tools、MCP 与独立协议版本；matcher 不检查 tools/MCP，并以 manifest schema `v` 代替协议版本；本机 descriptor 固定发布空 tools/MCP/credentialBindings，但实际 runtime 已装配工具、MCP 与 provider/MCP 凭据，conversation manifest 也固定为空 credentialBindings；修复反查又确认只冻结 main provider 会遗漏运行期实际使用的 light/power 角色凭据 | manifest requirement projection 与生产就绪发布没有覆盖实际执行依赖，协议版本又与 schema 版本错误耦合 | core wire/schema/builder/matcher、CLI executor 就绪发布、全部 LLM 角色及 MCP 凭据的非秘密 binding 投影、conversation/job 生产端、executor 复验、同机/mesh conformance | 在 manifest 中冻结独立 protocolVersion、所需 tools/MCP 与实际使用的凭据 binding revision；matcher 单源逐项验证；由 executor 就绪端发布不含秘密的真实 ready catalog，全部配置角色与有凭据 MCP 进入 requirement，owner 不合成执行侧事实；job instruction tools 必为冻结需求子集；补缺失、漂移、凭据更换、重放和序列化矩阵 | 已验证 |
| U16-07 | job owner 的 `assign` 直接签名、写 artifact 并耐久 assigned，没有在候选与凭证构造前调用 `matchManifest` | owner 预选只接入 conversation issuer，job 同构生产端遗漏 | job candidate/issuer、JobJournal、未来 scheduler 接入、executor 事后拒收与 owner 排队、双域测试 | 建立 job 唯一签发接缝并在任何凭证、候选和 artifact 产生前执行同一 matcher；失配保持 queued、零候选、零签名、零 artifact；补 conversation/job 双域 owner 负例 | 已验证 |
| U16-08 | 快照目录只比较 incoming 中仍存在的 credential binding；删除后以低 revision 重建可绕过回退检查，同 revision 下 principal/tenant/resource/scopes 改写也未被阻止 | 稳定 bindingId 没有跨快照的语义不变性与 revision 高水位 | descriptor/inventory 同步、凭据撤销与重建、manifest 旧引用、跨机目录及身份安全测试 | 冻结 binding revision 的完整语义身份；同 revision 异语义拒绝；删除后保留可验证高水位/墓碑并禁止重建回退；覆盖删除重加、同版身份替换和目录重放 | 已验证 |
| U16-09 | 本机单调版本文件只 fsync 临时文件，rename 后未同步父目录，也未复用项目耐久目录原语 | 把原子替换误当成崩溃耐久，目录项提交未闭合 | CLI version store、首次建目录、rename 崩溃点、重启 revision、后续远端回退守卫 | 复用 `ensureDurableDirectory`，rename 后 `syncDirectory(parent)`，保持锁内线性化；补首次创建、替换后崩溃和重启不回退验证 | 已验证 |
| U16-10 | EnvironmentRequirement 的 credential/evidence 集合只验唯一、不验规范排序，同义顺序会产生不同 manifest digest；workspace revision 允许 0，但 descriptor 只允许正整数 | 自摘要对象中的无序集合未规范化，生产端与消费端 revision 值域不一致 | environment validator、manifest digest/幂等重投、owner/executor conformance、workspace 匹配 | 对两个集合冻结唯一排序规则并在 validator 强制；workspace revision 统一为正整数；补乱序、排列同义与 0 边界测试 | 已验证 |
| U16-11 | `manifest.requires.permissionSnapshotVersion` 与 `permissionLease.snapshotVersion` 来自两个独立配置且双域 dispatch validator 不互绑；实测可签发 manifest=2、lease=1 的信封。CLI 又以 `{deviceId,configurationDigest}` 计算 `TrustRuleSnapshot` 摘要，但仓内没有对应规则快照对象、validator 或资产，故该 digest 不可能引用规范冻结的 `TrustRuleSnapshot` | 权限就绪版本、租约和规则快照内容未由同一不可变快照事实派生，引用闭包只验字段形状未验目标对象 | CLI 权限快照提供端、inventory/manifest 生产、conversation/job dispatch binding、executor received、历史重放及第 17 单元权限 guard | 建立真实签名 `TrustRuleSnapshot` 的生成、验证与就绪存储；inventory 版本、manifest requirement、lease version/digest 全部从同一快照引用派生；双域 validator 在落盘前核对版本与目标摘要；覆盖错版本、错摘要、缺资产和重放 | 已验证 |
| U16-12 | `ExecutorCapabilityDirectory` 仅以进程内 `Map<executorId,snapshot>` 保存状态；更新只比较 executorId，语义重放又剔除 signature。实测另一受信设备可用相同 executorId/版本被接受为 replay 并替换原设备；重启后的空目录也会把旧有效快照当首次版本接受；`snapshotFor` 不复核当前 trust 状态且目录无失效入口，设备接收后被撤销仍可继续参与选机 | executor 的设备归属、快照语义、当前信任资格和 revision 高水位没有形成同一耐久身份事实，防换绑、防回退与撤销生效依赖进程内偶然状态 | capability directory、owner 选机、executor 复验、设备角色变更/撤销、重启恢复、未来 mesh 同步及全部版本/墓碑高水位 | 以耐久目录状态绑定 home 内稳定 executorId 与获授权设备谱系；接收网络快照前恢复当前语义、高水位和墓碑并原子推进；trust transition 同步失效不再具 executor 资格的快照，查询也 fail-closed；状态缺失/损坏 fail-closed；覆盖同进程换 key、重启旧版本、撤销后查询、角色移除、换代和墓碑恢复 | 已验证 |
| U16-13 | `validateExecutorCapabilitySnapshot` 强制 descriptor/inventory 同签名设备且凭据 binding 集合、revision 完全一致，但 owner/executor 共用的 `matchManifest` 只核对 executorId、capability revision 和 manifest 实际引用的 binding；不同设备签名或额外 binding 集合分叉的拼接快照可被 matcher 判为兼容 | 同一能力快照二元组合同在目录 validator 与公共 matcher 两处独立实现并发生分叉 | owner 选机、executor received 前复验、未来 mesh adapter、descriptor/inventory 快照完整性及 conformance 测试 | 抽取 descriptor/inventory 二元组的单源结构谓词，由快照 validator 与 matcher 共同调用；统一核对 executorId、revision、签名设备及完整 binding 集合/revision；补换签名设备、缺失/额外/错 revision binding 的 matcher 与序列化 adapter 负例 | 已验证 |
| U16-14 | 本机发布器以 `credential-provider-<配置名>` / `credential-mcp-<配置名>` 直接发布 `user-alias` bindingId；不同设备使用同名配置时会得到相同 bindingId，后续 matcher 可在无用户确认的情况下把两份不可核验凭据视为等价 | 未把“用户别名只在确认域内成立”投影到最小发布器的身份模型 | CLI readiness 生产端、descriptor/inventory、conversation manifest、未来跨机选机、同名多设备测试 | 本机发布器将 `user-alias` bindingId 绑定设备签名身份，service-verified 身份保持全局语义；required binding 同步映射；补两设备同逻辑名不等价测试，并在 spec 冻结跨设备等价必须显式确认 | 已验证 |
| U16-15 | 最终验证并发运行两个重型包时 core 出现 7 项锁/超时失败，隔离包测 2347/2347 通过；CLI 单包全测仍复现两个新增耐久 IO 用例的默认 5 秒超时，并把两个运行时投影错误隐藏成后续空结果/等待失败 | 最终验证把并发槽上限误作并发义务；新增耐久测试未声明与真实 IO 成本匹配的预算，运行时测试又未在投影返回点暴露原始错误 | 最终验证调度、CLI 快照/权限发布测试、conversation durable runtime 测试、失败归因与包级门禁 | 最终构建单独运行，包级全测逐包串行，不人为启动跨包并发；为耐久 IO 测试声明 30 秒预算，为交互收敛声明 15 秒内部预算；所有相关 `projectSessionTurn` 结果立即断言并透出原始错误；直接测试 31/31、CLI 单包全测 161/161 文件及 2362/2362 项通过 | 已验证 |
| U16-16 | 唯一生产装配调用 `setupAuthorityRuntime` 时未传 `permissionRules`，发布器将缺省值规范化为空数组并签发；因此生产 `TrustRuleSnapshot`、manifest requirement 与 `PermissionSnapshotLease` 始终引用空规则资产，而真实规则由惰性创建的各 runtime `PermissionStore` 按 main/workspace/scene/session 语境持有；管理目录又每次新建 store，明确看不到 session 规则，现有组合根没有能在签发时读到执行会话真实规则的权威端口 | 权限快照发布端脱离真实的 assignment 语境权限权威，且规则所有权被分裂在启动发布器、管理目录与会话运行体三处 | CLI authority surface、权限管理目录、runtime `PermissionStore`、权限快照版本源与目录、conversation issuer、executor received 前资产校验、第 17 单元 guard 及上下文/规则变更测试 | 在组合根建立被管理目录、runtime 与 assignment 签发器共用的唯一语境权限权威；签发时从该权威投影当次可移植规则，耐久发布后使 inventory/manifest/lease 从同一不可变快照派生，禁止空数组缺省进入生产；覆盖创建/撤销、session/context/global 隔离、活跃会话与重启历史引用 | 已验证 |
| U16-17 | `capabilityCatalog()` 将 main、有/无 workdir 的 workscene profile 及互斥 workmode 工具组求并集，并在启动时一次性固化到所有 conversation manifest；实际 runtime 按会话语境只装其中一组。MCP `catalog()` 只反映当前 connected 连接，断线/重连后已发布 descriptor/inventory 与 issuer 内部固定 policy 不更新。LLM 凭据又按原始 `config.llm` 与凭据对象键名发布和强制就绪，显式 light/power 缺凭据时会在既有“回退 main、不得阻断”前抛错，空凭据项还会被误报可用。下游 `RuntimeFactory.create()` 又只接收 sessionId，`ConversationProtocolRuntime` 在 assignment 通过 matcher 后直接运行既有 `input.runtime`，既不传入 manifest 也不核对就绪代际；因此即使元数据匹配通过，真实执行工具/MCP/角色仍可与冻结 manifest 不同 | 把静态配置与设备级能力并集当作已解析运行事实及每次 execution 精确需求，并只验证“manifest↔目录”而没有闭合“目录↔本次实际运行体” | runtime-host profile/extra-tools/MCP 生命周期、LLM 角色降级与凭据解析、CLI readiness 发布、descriptor/inventory、conversation issuer/manifest、executor role/runtime factory、durable protocol runtime、owner 预选、executor received 复验、既有可选角色回退及未来 mesh 执行 | 分离 executor 当前可用能力与 assignment 精确需求：readiness 从已解析角色、真实可用凭据和实时 MCP 状态派生，变化时单调重发 descriptor/inventory；issuer 在签发时原子取同一就绪代际并按本次 main/workscene 真实依赖冻结 manifest；运行体创建/启动必须绑定该 manifest 及代际，在通过 matcher 后到开跑前变化则拒绝或按冻结依赖装配；覆盖互斥工具组、无 workdir、MCP 断线/恢复、可选角色缺凭据回退、空凭据、快照后运行体变化及旧 assignment 重放 | 已验证 |
| U16-18 | `normalizeTrustRulesForSnapshot()` 只移除 `contextPath` 后即执行严格 canonical clone；但官方 `PermissionStore.createRule()` 与磁盘恢复对象都会保留值为 `undefined` 的 `contextId`/`contributors` 自有字段，合法 global/session/main-context 规则会直接触发 `Canonical JSON rejects undefined field`。快照还把运行时命中会修改的 `lastMatchedAt`/`matchCount` 纳入签名摘要，使同一授权策略的身份随使用统计漂移；现有测试只用手写无 `undefined` 的规则，未覆盖真实规则源 | 直接复用含本机可选字段与可变遥测的存储 DTO 作为可移植、稳定签名的协议规则，没有定义规范 wire 投影 | PermissionStore 创建/磁盘恢复/命中统计、权限快照规范化与版本分配、签名摘要、CLI 真实规则接入、历史引用与第 17 单元 guard | 冻结显式的可移植 TrustRule 投影：只保留授权判断及必要审计字段，缺省可选字段必须省略，排除 `contextPath` 与 `lastMatchedAt`/`matchCount`；类型、validator、spec 与生产端共用同一投影；以 `PermissionStore.createRule()`、磁盘恢复规则、各 scope 及命中前后摘要不变性覆盖验收 | 已验证 |
| U16-19 | §5.3 同时要求 manifest 的七类版本与当前 inventory 逐项相等、`inventory/manifest/lease` 的 permission version 来自同一快照，又要求 assignment 签发时冻结当次语境权限规则并耐久保留历史快照。不同会话拥有不同 session/context 规则时，单 executor 的唯一当前 `permissionSnapshotVersion` 无法同时匹配多个 assignment；当前聚合版本源还会在任一权限变化时同步提高其余六类版本，使已签发但未 received 的合法 assignment 在下一会话发布后必然 `revision-conflict` | 把设备级当前版本清单、assignment 精确权限资产和历史目录可用性压成一个“当前值相等”谓词，缺少多语境并发与历史引用的版本语义 | ExecutionManifest/ExecutorVersionInventory/PermissionSnapshotLease、`matchManifest`、本地聚合版本源、能力目录、权限快照目录、owner 预选、executor received/recovery、多个并发会话与未来 mesh 资产同步 | 按已冻结两层语义实现：inventory 以 `permissionSnapshotHighWater` 声明权限目录就绪高水位，manifest/lease 精确引用同一历史快照；六类设备代际继续等值匹配，权限仅校验 `version <= highWater`，executor 在 `received` 前按 digest 取回并验签。缺资产先耐久拒收，owner 关闭旧 assignment、保持同一权限引用排队，资产同步后用新 assignment 重派；权限变化只推进高水位与 inventoryRevision，不抬升设备代际版本；历史快照本单元全保留。覆盖双会话交错签发、旧 assignment 首收/恢复、缺资产、重派与回退 | 已验证 |
| U16-20 | executor 在 received 前校验权限引用资产时，把 digest/版本不符标成可重试 `revision-conflict`，把验签失败标成可重试 `capability-gap`；规范冻结两者均为完整性破坏硬拒 | 权限资产“尚未同步”和“已取得但身份/完整性损坏”共用同一可恢复错误分类 | executor 双域统一账本、dispatch-rejected 证明、owner 后续收束、未来 mesh 资产提供端及错误分类测试 | 仅资产缺失返回可重试 `capability-gap`；digest/版本不符或验签失败返回不可重试 `invalid`，均在 received 前耐久拒收且零执行副作用；参数化覆盖错身份与坏签名 | 已验证 |
| U16-21 | CLI 包级验证中 `runtime-host.test.ts` 六项稳定失败：生产装配已调用 `mcpHub.catalog()`，旧测试桩仍提供空对象 | 生产依赖接口扩展后，消费该接口的既有装配测试未纳入派生闭包 | runtime-host 装配测试桩、三条 runtime 创建路径、最终 CLI 包级验收 | 测试桩实现真实最小 `catalog(): []` 合同，不弱化生产校验；runtime-host 与 protocol runtime 隔离 2/2 文件、25/25 项通过，随后 CLI 单包全测通过 | 已验证 |
| U16-22 | 新增的运行体绑定耐久测试在 CLI 单包真实负载下稳定卡住 Vitest 默认 5 秒线；隔离单文件 18/18 通过但实际测试耗时 28.7 秒 | 新增真实文件 IO 场景未按既有测试纪律声明显式有界预算 | `conversation-protocol-runtime.test.ts` 新增运行体绑定场景、CLI 包级验收与失败归因 | 仅对该耐久场景声明 30 秒显式预算，保持原始错误立即失败；单文件 18/18 通过，CLI 单包全测必须稳定通过 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X16-01 | owner 包级并发运行时一个旧 IO 用例贴 5 秒超时；隔离 1/1 通过 | 失败发生于未改路径且隔离耗时 4.734 秒通过，仅为负载时限噪声 | 最终业务指纹；隔离用例结果 | 隔离复现失败或相关路径变化 | 已排除 |
| X16-02 | CLI 与 executor 并发全测时一个耐久会话重放用例返回 error；隔离 1/1 通过 | 并发负载下首轮耗时 67 秒；隔离 17.8 秒完成且重放 settled，Unit16 matcher 路径无失败 | 最终 CLI/核心业务指纹；隔离用例结果 | 单独包级运行仍失败或相关逻辑改变 | 已排除 |
| X16-03 | 本单元是否应直接接入完整 skills/rubrics/permissions 与远程 workspace 内容同步 | 第 16 单元只冻结最小版本发布和匹配接缝；权限激活、mesh 内容传输与环境产品接入分别属于后续单元 | specification 执行顺序与固定边界 | 后续单元发现当前 wire/目录/matcher 无法直接承接 | 已排除 |
| X16-04 | 本机权限快照目录当前保留全部历史快照，是否必须在本单元实现引用感知 GC | 本单元要求历史在途引用可重启补读，正式租约引用权威与跨机资产生命周期分别在第 17、19 单元接管；当前保守保留不丢资产，且不改变 wire/目录/matcher 合同 | `FileTrustRuleSnapshotCatalog`、spec 能力同步纪律与第 16～19 单元边界；冻结指纹 `27a85dac…` | 后续租约/资产接入无法在不改当前合同的情况下实现引用保留，或当前目录出现可证实的资源上界故障 | 已排除 |
| X16-05 | executor 与 mesh 包测并发时，mesh 两个未改 SPAKE2+ 用例在默认 5 秒线上超时 | mesh 密码学测试也是计算重负载；单独包测 10/10 文件、78/78 项通过，失败与第 16 单元改动无路径交集 | 重新冻结指纹；并发失败及 mesh 单包隔离结果 | mesh 单独包测失败，或第 16 单元改动触及 pairing/SPAKE2+ 路径 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L16-01 | U16-06～12；第一、二轮终审曾记录通过 | 只核对了 DTO 局部合法性与单次进程内匹配，没有把每个 requirement 沿真实资产、租约、目录身份和重启高水位走成端到端闭包 | 对能力/版本类单元逐字段建立“内容权威→签名发布→目录耐久状态→manifest/lease→owner/executor→重启/换设备/撤销”对账，并执行缺目标、错绑定、换 key、回退、撤销和删除重建组合 | 第三至五轮:按该链收齐并补全 U16-06～12 |
| L16-02 | U16-13～14；第六轮前已有多轮局部通过 | 复核聚焦单 executor 快照与显式 requirement，遗漏了同一合同在完整 validator/matcher 间的投影差异，以及不可核验别名跨设备的身份域 | 对所有选机元数据执行“完整快照 validator↔matcher↔序列化 adapter”差分矩阵，并以两个独立设备发布同名不可核验 binding，确认默认不等价 | 第七轮:共享二元组谓词与双设备别名隔离测试 |
| L16-03 | U16-15、U16-22；旧冻结指纹两轮终审均通过 | 终审只核对测试覆盖内容，未核对异步测试是否在错误产生点失败、耐久 IO 是否声明真实预算；最终验证又把两槽上限误作两个重型包的并发义务 | 对耐久/异步测试逐项检查显式有界预算、返回结果即时断言与原始错误透出；最终构建单独运行，包级全测逐包串行，不人为启动跨包并发；隔离通过不能替代单包全测 | 本轮重放:检索本单元新增测试，仅运行体绑定场景缺预算；声明 30 秒上界并保留原始错误立即失败 |
| L16-04 | U16-16～18；重新冻结终审一、二曾记录通过 | 把元数据发布与 matcher 通过误当成真实执行一致，未核对生产输入是否来自唯一权威、签发后是否绑定到实际运行体 | 对每个快照字段执行“真实权威→规范投影→动态发布→签发冻结→目录/matcher→实际运行体”闭包；使用官方存储对象、互斥语境、回退配置及签发到开跑间变更做对抗 | 补充独立终审与同根专项终审:收齐 U16-16～18 及运行体绑定影响面 |
| L16-05 | U16-19；U16-16/17 集中修复开始后发现 | 只沿单个 assignment 检查“同一快照派生”，未把 executor 唯一当前 inventory 与多个会话各自权限快照放进同一并发时间轴，导致互斥要求直到实现动态发布时才暴露 | 对所有“当前目录版本 + 历史不可变引用”合同执行双主体交错矩阵：A 签发→B 更新→A 首收/恢复，并逐字段区分设备高水位、精确内容引用和 GC 责任；无法同时成立即先裁决版本语义 | 本轮:以两个不同权限语境交错签发推导出 U16-19，沿 matcher、目录、版本源、历史快照与恢复消费者收齐影响面 |
| L16-06 | U16-20；U16-19 架构补全后首次实现复核 | 只核对了“按 digest 命中”这一正向闭包，未逐一对账资产不存在、身份不符和验签失败三种负向分类 | 对所有引用资产读取执行三分矩阵：缺资产、错身份、坏完整性；分别核对错误码、retryable、耐久终态与零副作用 | 本轮:沿权限快照 provider、双域账本与 rejection 消费链完成三分对账并补参数化测试 |
| L16-07 | U16-21；最终冻结终审一、二均通过 | 终审沿生产闭包核对了 MCP catalog，却未把接口扩展反向枚举到全部测试替身，包级验证才暴露陈旧桩 | 生产接口新增必需方法时，派生闭包必须搜索全部实现、适配器与测试替身，并对每个消费者执行最小合同验证 | 本轮:搜索 `McpHub` 装配消费点，补齐唯一陈旧测试桩；隔离 25/25 通过 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V16-01 | 旧 matcher 版本、能力与身份矩阵 | core 直接测试、合同门禁、包全测 | 旧 core contracts/protocol/matcher/tests | 历史 / 中 / 100s | manifest 35/35；core 2334 项；contracts lint 通过 | `8b9c0d9d…` | 失效 |
| V16-02 | 旧同机/序列化 conformance、快照回退与双端拒收 | owner/executor/CLI 直接及包级测试 | 旧 providers/sync/matcher consumers | 历史 / 高 / 约 6min | owner 5/5；executor 365 项；CLI snapshot/setup 5/5 | `8b9c0d9d…` | 失效 |
| V16-03 | 旧派生闭包、秘密边界与最终产物 | contract/export/secret/diff 门禁 + `pnpm build` | 旧 18 文件交付物与派生资产 | 历史 / 高 / 239s | 四项门禁与 17 包构建通过 | `8b9c0d9d…` | 失效 |
| V16-04 | U16-06～14 修复及同根风险闭合 | core manifest；owner issuer；executor ledger/job；CLI setup/runtime；providers/mesh 直接测试与各受影响包类型检查 | 当前 core/owner/executor/CLI/providers/runtime-host/mesh 直接相关源码与测试 | 集中修复 / 中高 / 已完成 | core 48/48、owner 5/5、executor 363/363、CLI 33/33、providers 24/24、mesh 3/3；受影响包类型检查通过，CLI 仅有未改旧路径的既知窄投影基线错误 | `27a85dac…` | 有效 |
| V16-05 | 35 文件派生闭包与结构基线 | `git diff --check`；结构 golden 显式更新、差异审阅及正常模式复跑 | 当前 35 文件与全仓导入拓扑 | 冻结准备 / 低 / 已完成 | diff 无错误；golden 仅 CLI/executor/mesh/core 相关引用计数及一项既存 server/core 计数同步，无新包边或环；结构门禁 1/1 | `27a85dac…` | 有效 |
| V16-06 | 旧冻结交付物的最终产物、包级回归与剩余门禁 | `pnpm build` 后执行受影响包全测与剩余门禁 | 旧冻结 35 文件、工作区依赖图、构建产物及测试输入 | 最终验证 / 高 / 已中止 | 构建与 core 单包通过；并发负载噪声和 CLI 单包稳定失败触发 U16-15，交付物随后变化 | `27a85dac…` | 失效 |
| V16-07 | U16-15 测试预算、错误可观测性及真实 CLI 包内负载 | 三份直接测试单 worker；CLI 单包全测 | 当前三个 CLI 测试文件及其生产依赖 | 集中修复 / 中 / 186.8s | 直接测试 3/3 文件、31/31 项；CLI 161/161 文件、2362/2362 项通过 | `d69b73e8…` | 有效 |
| V16-08 | 同一重新冻结交付物的最终产物、包级回归与剩余门禁 | `pnpm build`；受影响包全测；contracts、exports、security、结构 golden 与 diff 门禁。跨包并发曾产生资源噪声，相关包以单包复跑归因；本行仅记录历史，后续调度以静态区为准 | 重新冻结的 35 文件、工作区依赖图、构建产物及测试输入 | 最终验证 / 高 / 约 12min | 17 包构建通过；core 141/141 文件、2347/2347 项，owner 6/6、160/160，executor 3/3、368/368，CLI 161/161、2362/2362，providers 11/11 通过且 1 文件/3 项按既有条件跳过，mesh 10/10、78/78；contracts typecheck/lint、package exports、supply-chain、secrets、结构 golden 1/1、双 diff 检查全部通过；最终指纹复算一致 | `d69b73e8…` | 有效 |
| V16-09 | U16-16～20 的真实权限/运行体闭包、两层版本和三分拒收分类 | core manifest；CLI setup/runtime；orchestrator runtime；server perspectives；executor 双域直接文件与受影响包类型检查 | 当前 46 文件中 U16-16～20 生产链、合同与直接测试 | 集中修复 / 中高 / 已完成 | core 50/50；CLI 6 文件 44/44；orchestrator 64/64；server 12/12；executor assignment 167/167、job 201/201；core/orchestrator/runtime-host/owner/executor/server 类型检查通过，CLI 仅既知旧窄凭据投影基线错误 | `898acd7c…` | 有效 |
| V16-10 | 旧冻结交付物的最终产物、包级回归与全部剩余门禁 | `pnpm build` 单独执行；依次运行受影响包全测 | 冻结的 46 文件、工作区依赖图、构建产物、受影响包测试输入与结构基线 | 最终验证 / 高 / 已中止 | 构建、core、owner、executor 通过；CLI 包级验证暴露 U16-21，旧冻结失效 | `898acd7c…` | 失效 |
| V16-11 | U16-21 测试替身合同及真实运行时测试 | runtime-host 与 conversation protocol runtime 两文件单 worker 隔离测试 | `runtime-host.test.ts`、RuntimeHost MCP catalog 消费点及 protocol runtime | 集中修复 / 中 / 41.6s | 2/2 文件、25/25 项通过；生产代码未改变 | `72402dfb…` | 有效 |
| V16-12 | 旧冻结交付物的剩余最终包级回归与门禁 | CLI 单包全测 | 冻结的 47 文件及 CLI 测试输入 | 最终验证 / 高 / 已中止 | U16-21 已消失；唯一新增运行体绑定耐久测试在默认 5 秒线超时，触发 U16-22 | `72402dfb…` | 失效 |
| V16-13 | U16-22 显式预算不掩盖业务错误 | conversation protocol runtime 单文件单 worker 测试 | 新增运行体绑定测试、生产运行时及耐久 IO 依赖 | 集中修复 / 中 / 41.3s | 1/1 文件、18/18 项通过；实际测试 28.7 秒，30 秒上界与真实成本一致 | `971fbe25…` | 有效 |
| V16-14 | 最新冻结交付物的最终产物、串行包级回归与全部门禁 | `pnpm build` 单独执行；core、owner、executor、CLI、providers、orchestrator、server、mesh 逐包串行全测；contracts、exports、security、runtime baseline、diff 与指纹复核 | 冻结的 47 文件、工作区依赖图、构建产物、受影响包测试输入与结构基线 | 最终验证 / 高 / 已完成 | 17 包构建通过；core 141/141 文件、2349/2349 项，owner 6/6、160/160，executor 3/3、373/373，CLI 161/161、2365/2365，providers 11/11、229/229 且 1 文件/3 项按既有条件跳过，orchestrator 25/25、421/421，server 41/41、744/744，mesh 10/10、78/78；contracts typecheck/lint、package exports、supply-chain、mesh-test-clock、secrets、runtime baseline、diff 全通过；最终指纹复算一致 | `971fbe25…` | 有效 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、上下游调用点 | 是 | 无 | `8b9c0d9d…` | 通过 |
| 第二轮 | 并发、崩溃、安全、身份链、资源上界、异常终态、测试盲区 | 是 | 无 | `8b9c0d9d…` | 通过 |
| 第三轮 | requirement 投影、双域入口、binding 高水位、崩溃耐久与规范化 | 是 | U16-06～10 | `8b9c0d9d…` | 未通过 |
| 第四轮 | 权限快照引用闭包、executor 设备谱系与跨重启回退 | 是 | U16-11～12 | `8b9c0d9d…` | 未通过 |
| 第五轮 | 真实就绪生产链、目录信任撤销、后续单元边界排除 | 是 | 无新根因；补全 U16-06、U16-12 影响面 | `8b9c0d9d…` | 未通过 |
| 第六轮 | matcher 与目录快照 validator 的合同同源、协议版本及双文件恢复边界 | 是 | U16-13 | 当前工作区 | 未通过 |
| 第七轮 | U16-06～14 全影响面、真实生产装配、全部角色依赖与跨设备 alias | 是 | 无新根因；修复和直接验证闭合 | `27a85dac…` | 修复验证通过，待冻结终审 |
| 冻结终审一 | 需求、架构功能闭包、真实生产链、owner/executor 双端合同与身份引用 | 是 | 无 | `27a85dac…` | 通过（1/2） |
| 冻结终审二 | 并发、崩溃恢复、安全与秘密边界、身份换代、资源上界、派生资产和测试盲区 | 是 | 无 | `27a85dac…` | 通过（2/2） |
| 重新冻结终审一 | U16-15 增量、功能边界、测试预算是否掩盖业务错误及生产行为不变性 | 是 | 无 | `d69b73e8…` | 通过（1/2） |
| 重新冻结终审二 | 包内并发、错误可观测性、时限上界、测试隔离及最终调度资源竞争 | 是 | 无 | `d69b73e8…` | 通过（2/2） |
| 补充独立终审 | 真实权限规则 wire 投影、已解析 LLM 角色与凭据就绪、能力目录动态生命周期、签名身份和兼容链 | 是 | U16-18；补全 U16-17 同族影响面 | `d69b73e8…` | 未通过 |
| 同根专项终审 | 权限/能力真实权威→签名发布→assignment 冻结→实际运行体的端到端一致性 | 是 | 无新编号；补全 U16-16 所有权接缝与 U16-17 运行体绑定缺口 | `d69b73e8…` | 未通过 |
| 集中修复架构反查 | 多语境权限快照、单 executor 当前 inventory、历史引用与 received/recovery 交错时序 | 是 | U16-19 | 当前工作区 | 暂停：架构合同存在互斥语义，待裁决后继续 |
| 最终冻结终审一 | 需求、架构边界、真实权威到签发、owner/executor 与实际运行体的完整生产闭包 | 是 | 无 | `898acd7c…` | 通过（1/2） |
| 最终冻结终审二 | 并发、崩溃恢复、安全身份、资源上界、三分负向分类、派生闭包与测试盲区 | 是 | 无 | `898acd7c…` | 通过（2/2） |
| 最终验证回归归因 | 包级失败分类、生产 MCP catalog 接口与全部测试替身派生闭包 | 是 | U16-21 | `898acd7c…` | 未通过；修复后重新冻结 |
| U16-21 重新冻结终审一 | 47 文件全闭包；复用未变化 46 文件的终审事实，重点核对新增测试替身与生产 MCP catalog 接口一致性 | 是 | 无 | `72402dfb…` | 通过（1/2） |
| U16-21 重新冻结终审二 | 测试是否弱化生产校验、空 catalog 的语义边界、全部同类替身与包级负载重开条件 | 是 | 无 | `72402dfb…` | 通过（2/2） |
| U16-22 最终验证归因 | 本单元新增测试的显式预算、隔离与包级真实负载 | 是 | U16-22 | `72402dfb…` | 未通过；修复后重新冻结 |
| U16-22 重新冻结终审一 | 47 文件功能与架构闭包；生产代码不变，核对显式预算仅作用于真实耐久 IO 场景 | 是 | 无 | `971fbe25…` | 通过（1/2） |
| U16-22 重新冻结终审二 | 本单元新增测试逐项预算审计、原始错误立即失败、包级负载及测试替身完整性 | 是 | 无 | `971fbe25…` | 通过（2/2） |
| 最终交付验证 | 单独构建、全部受影响包串行全测、合同/安全/结构门禁、diff 与最终指纹 | 是 | 无 | `971fbe25…` | 全部通过；单元完成 |

<!-- registration-complete: unit-16.gen-1 -->
