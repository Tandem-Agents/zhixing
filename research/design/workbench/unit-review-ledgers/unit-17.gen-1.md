# 单元登记:第 17 单元 · generation 1

- **unitId**:17
- **generation**:1
- **登记时间**:2026-07-20
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 17 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。

## 当前状态

- **当前状态**:完成；同一最终指纹两轮终审与全部必要验证通过
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是；最终指纹 `beaa297b…`
- **交付物文件集**:`packages/cli/src/serve/{conversation-protocol-runtime.ts,__tests__/conversation-protocol-runtime.test.ts}`；`packages/core/src/contracts/{authorization.ts,protocol.ts,records.ts}`；`packages/core/src/protocol/{assignment.ts,authority.ts,authority.test.ts,index.ts,manifest.ts,manifest.test.ts,permission-snapshot.ts,signature.ts}`；`packages/core/src/security/{index.ts,permission-matcher.ts,permission-store.ts,security-pipeline.ts,types.ts,__tests__/builtin-scope.test.ts,__tests__/permission-matcher.test.ts}`；`packages/executor/src/{assignment-ledger.ts,__tests__/assignment-ledger.test.ts,__tests__/job-assignment.test.ts}`；`packages/orchestrator/src/{orchestration/agent-node-executor.ts,orchestration/__tests__/agent-node-executor.test.ts,runtime/create-agent-runtime.ts,runtime/run-context.ts,runtime/__tests__/create-agent-runtime.test.ts,security/secure-executor.ts,security/__tests__/secure-executor.test.ts,subagent/factory.ts,subagent/loop-runner.ts,tools/task.ts}`；`packages/owner-kernel/src/{conversation-assignment.ts,conversation-transition-authority.ts,job-assignment.ts,types.ts,__tests__/conversation-transition-authority.test.ts}`；`packages/runtime-host/src/session-adapter.ts`；`packages/server/src/{perspectives/controller.ts,perspectives/runtime-executor.ts,perspectives/types.ts,perspectives/__tests__/controller.test.ts,__tests__/__goldens__/distributed-runtime-structure.golden.json}`；`research/design/modules/distributed-runtime/specification.md`
- **当前交付物指纹**:`beaa297b8e8ce5fddc257d3077f4ba191aaa65efb9903a3cfa9c590cce2e67f2`（45 文件；`SHA256(UTF8(sorted(path<TAB>SHA256(file-bytes)<LF>)))`）
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的 S4 权威验权边界与 `research/design/modules/distributed-runtime/specification.md` 第 17 单元、principal×方法矩阵和双侧激活合同

## 固定边界

- **功能范围**:落地五类 principal×方法矩阵与统一 guard；激活 AuthorityCapability 和 PermissionSnapshotLease；owner 以 assigned/revoked、executor 以 received/fence 为耐久事实完成双侧验权、吊销与恢复重驱；权限租约失效时安全管线 fail-closed
- **架构不变量**:每次已接入权威端口调用均经共享合同谓词；签名候选不等于激活；错方法、资源、scope、epoch、assignment、executor、过期或吊销一律拒绝；owner/executor 只读各自耐久事实且重启后离线可验
- **验收条件**:全部方法×五类 principal 允许/拒绝矩阵；双域候选未激活、错绑定、替换租约、过期、吊销、恢复与响应丢失重放测试；权限守卫不得把新规则或失效租约静默放行
- **必要上下游**:core authorization/protocol、conversation/job owner journal、executor ledger、CLI 进程内 adapter、runtime 安全管线与第 16 单元权限快照目录
- **明确不属于本单元**:第 18 单元 ResourceGovernor 与资源租约治理；第 19～20 单元 mesh adapter 和跨机吊销传输；第 21～24 单元数据面票据；尚未生产接入的 Session/Global/Intent 端口业务实现

## 审查分片

- **是否启用**:是
- **决定依据**:同一验权合同分布于 core、owner 双域、executor 与 runtime 安全管线，且存在方法矩阵、激活、吊销、恢复四个正交维度
- **完整单元与跨切片必审项**:合同谓词单源；candidate→assigned→received→revoked/fenced 全生命周期；owner/executor 离线投影一致；权限租约与真实安全管线闭合

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |
| S17-A | core 方法矩阵、凭证/租约 validator 与共享谓词 | `beaa297b…` | 完成 | 完成 | 局部封版 | 方法矩阵双向完备；租约、时间、请求与派发控制身份谓词单源，core 全测与构建通过；交付物变化时重开 |
| S17-B | owner conversation/job assigned、revoked 与重放投影 | `beaa297b…` | 完成 | 完成 | 局部封版 | 完整 capability、ControlLease 与证据页均绑定耐久 assigned envelope；签发 TTL 在入口 fail-fast，owner 全测通过；相关投影变化时重开 |
| S17-C | executor received/fence 离线权限守卫与 runtime fail-closed | `beaa297b…` | 完成 | 完成 | 局部封版 | 控制身份预验、共享 reducer、单调时限、权限快照与派生工具链闭合；executor 389/389 通过；相关合同变化时重开 |
| S17-D | CLI 生产装配、恢复、全矩阵与跨切片对抗测试 | `beaa297b…` | 完成 | 完成 | 局部封版 | 生产 authorizer、稳定请求与恢复装配复用共享合同；server/CLI 全测与结构门禁通过；装配变化时重开 |

### 完整单元横向审查记录

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |
| 历史冻结终审一 | `4202e36e…` | 需求、方法矩阵、签发→assigned→received→执行生产闭包与单元边界 | 后续发现 U17-01～18 | 已失效 |
| 历史冻结终审二 | `4202e36e…` | 错绑定、过期/吊销、响应丢失、恢复离线验权、跨执行点合同分叉和测试盲区 | 后续发现 U17-01～18 | 已失效 |
| 历史冻结终审一 | `50087fd3…` | 需求、方法矩阵、全部签发端、assigned→control→received→工具执行生产闭包与 17/18/19 边界 | 最终验证发现 U17-20/21 | 已失效 |
| 历史冻结终审二 | `50087fd3…` | 错绑定、过期/吊销、终态续租、响应丢失、重启离线验权、公开投影与派生执行链 | 最终验证发现 U17-20/21 | 已失效 |
| 历史冻结终审一 | `5c16fc71…` | 生产合同与测试拒绝语义对账；共享 reducer 收紧后的同文件回归闭包 | 后续发现 U17-20 修复未覆盖参数分支、U17-22 | 已失效 |
| 历史冻结终审二 | `5c16fc71…` | 重复终态证据的序号、摘要与签名闭包；悬空夹具引用扫描 | 后续发现 U17-21 需显式 IO 预算 | 已失效 |
| 历史冻结终审一 | `9ed33105…` | 参数化 received/rejection 分支逐项对账；全部新增与受影响 IO 回放场景预算核查 | 最终验证发现 U17-23/24 | 已失效 |
| 历史冻结终审二 | `9ed33105…` | 重复终态证据序号/摘要闭包、夹具引用完整性与测试预算不掩盖错误 | 最终验证发现 U17-23/24 | 已失效 |
| 冻结终审一 | `beaa297b…` | 45 文件交付闭包、测试预算同族、结构 golden 精确差异与全部最终验证结果 | 无 | 通过（1/2） |
| 冻结终审二 | `beaa297b…` | 授权全生命周期、跨包消费者、终态/恢复、派生类型边与回归证据独立复核 | 无 | 通过（2/2） |

## 派生产物闭包

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core protocol/exports/tests | 方法注册表、principal 矩阵、签名类型、validator 与 assignment 复用必须单源 | core 142/142 文件、2361/2361 项与全量构建通过 | 闭包已核对 |
| core security | 冻结权限规则必须由显式快照评估，缺冻结 evaluator 时 fail-closed | 正反例与 core 全包回归通过 | 闭包已核对 |
| owner 双域与过渡签发器 | assigned/revoked 投影、提交四模式与签发方法集合必须共用 core 合同 | 双域恶意证据及 owner 6/6 文件、161/161 项通过 | 闭包已核对 |
| executor 双域账本 | received 激活、started、fence/abort/终态与 lease digest 必须共同决定工具执行权 | 直接对抗场景、类型检查及 executor 3/3 文件、389/389 项通过 | 闭包已核对 |
| orchestrator/runtime-host | 安全管线在策略前加载冻结规则，并在真实副作用前再次验权；适配器类型不允许静默 void | orchestrator 25/25 文件、425/425 项与全量构建通过 | 闭包已核对 |
| CLI 生产装配与恢复测试 | durable conversation runtime 必须注入 ledger 权限 guard，恢复后保持同一合同 | server 41/41 文件、745/745 项；CLI 161/161 文件、2365/2365 项通过 | 闭包已核对 |
| lockfile/golden/schema/spec | 无依赖或公开 RPC 变化；orchestrator runtime 新增从 core 导出共享授权类型，结构 golden 必须同步 | golden 仅新增 `orchestrator/runtime → @zhixing/core` 的 1 条 type-export；spec 已同步两级派发门禁 | 闭包已核对 |

## 关键原语核查

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| principal×方法授权 | core 封闭注册表与 component 白名单 | 每次端口调用进入 adapter/guard | 方法新增、适配器分叉 | 五类 principal、全部 26 个权威端口方法 | 常数矩阵；未知值 fail-closed | 通过 |
| capability 激活与吊销 | owner assigned/revoked | assigned 原子提交；revoked 记录 fsync | 候选签发、提交响应丢失、重启 | owner 双域、executor submission caller | 每 assignment 有界 cap 集；历史模式只读耐久事实 | 通过 |
| permission lease 激活 | executor received.activation | received fsync；每次真实工具副作用前重验 | received 前后、确认等待、租约过期、fence、恢复 | executor ledger、runtime 安全管线 | 每工具调用常数 guard；快照按 digest 读取，失效 fail-closed | 通过 |

## 覆盖与核查

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 架构 | 第 17 单元 | 状态 | candidate/assigned/received/revoked | 通过:签名候选无耐久激活即拒 | 通过:双域状态投影同源 | 通过:重启、吊销和终态不恢复执行写权 |
| 架构 | 第 17 单元 | 入口与生产端 | issuer、adapter、runtime | 通过:签发方法集合复用矩阵，CLI 只做静态认证 | 通过:全部生产签发端与 adapter 接线闭合 | 通过:未实现端口未伪造生产接入 |
| 架构 | 第 17 单元 | 消费端与继承面 | owner/executor/security pipeline | 通过:共享激活和 lease 谓词 | 通过:owner 双域、executor 双域与安全管线闭合 | 通过:无第二份弱化身份或租约校验 |
| 架构 | 第 17 单元 | 生命周期 | 激活、过期、吊销与恢复 | 通过:active 与历史收束模式边界分离 | 通过:assigned/control/received/revoked/fenced 全链 | 通过:终态仅保留精确恢复控制，不恢复执行权 |
| 架构 | 第 17 单元 | 并发与崩溃点 | fsync 前后与重驱 | 通过:只消费耐久投影 | 通过:耐久控制先于 received，候选不获写权 | 通过:冷启动从日志与本地时限基线 fail-closed |
| 架构 | 第 17 单元 | 异常路径与终态 | 错绑定、替换、历史重放 | 通过:方法/scope/resource/epoch/身份逐维拒绝 | 通过:错误派发身份零写入，深层拒收可稳定重放 | 通过:历史稳定结果不消费新载荷或恢复 fresh 写权 |
| 架构 | 第 17 单元 | 安全边界 | 签名、principal、资源和 epoch | 通过:封闭字段、签名与半开时间窗 | 通过:五类矩阵、签发上界和 host 白名单 | 通过:策略前及副作用前均重验冻结权限 |
| 架构 | 第 17 单元 | 模块边界 | 17/18/19/21 | 通过:未接入 governor、mesh 或数据面票据 | 通过:仅保留稳定后续端口 | 通过:未提前实现迁居、资源治理或 scheduler 生产链 |
| 架构 | 第 17 单元 | 测试与验收 | 矩阵、双域、离线恢复 | 通过:当前直接验证闭合 | 通过:直接正交矩阵与新增边界闭合 | 通过:最终构建、六个受影响包全测与结构门禁闭合 |

## 问题清单

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U17-01 | [P0] 完整 owner 投影只按 capId 验激活，可能接受同 id 扩权 capability | 轻量投影与完整 artifact 数据闭包混用 | conversation/job active、settlement、重放 | 完整投影对 assigned envelope 中 capability 规范全等；轻量 guard 只投影不可变身份；双域篡改拒绝 | 已解决 |
| U17-02 | [P0] pre-received 控制事实未绑定 authority，可用错 scope/epoch 永久阻断正确派发 | 控制权被简化为 assignmentId | dispatch/cancel/supersede/query、双域恢复 | 首个 control lease 耐久绑定 authority/owner/controlLeaseId，后续控制与 received 必须全等 | 已解决 |
| U17-03 | [P0] PermissionSnapshotLease 缺 ControlLease 存活锚 | 权限与控制生命周期只实现半边 | 工具副作用、失联、过期、恢复 | 签名 ControlLease、单调续期与耐久投影单源；权限租约绑定同 control lease，失效即 fail-closed | 已解决 |
| U17-04 | [P0] Task 与 perspectives 派生执行未继承工具授权回调 | 授权只接主 agent 热路径 | 全部子 agent 与 orchestration 工具副作用 | 授权上下文沿派生执行所有权链传递，并在策略前及副作用前复验 | 已解决 |
| U17-05 | [P1] 历史冻结快照未命中时回退当前 builtin rule | 冻结资产与实时配置混用 | PermissionStore、SecurityPipeline、重启恢复 | 签发冻结完整执行规则；执行只读冻结快照，实时策略只能收紧 | 已解决 |
| U17-06 | [P2] 方法注册表只有单向 `satisfies`，新增合同方法可遗漏 | 类型联合与运行时表双重声明 | 五类 principal、validator、矩阵测试 | 总表与子集增加反向完备性断言，矩阵从封闭注册表派生 | 已解决 |
| U17-07 | [P0] 跨设备 expiry 直接与本机墙钟比较 | 协议时间未换算本地单调 deadline | permission/control lease、调用 deadline、重启 | 共享有界 TTL/偏差谓词；接受时物化本地单调时限，进程内不再回读墙钟 | 已解决 |
| U17-08 | [P0] OwnerControlGrant 未绑定确切 fence/request body | 只认证调用者，未认证耐久请求身份 | cancel/supersede、响应丢失重驱、mesh 中继 | grant 签名绑定规范 requestDigest；requestId/fenceSeq 重试不变，逐字段篡改拒绝 | 已解决 |
| U17-09 | [P0] grant signer、caller、认证连接与派发 owner 未四者全等 | 逻辑 authority 与设备身份未闭合 | 四种 owner-control 方法、双域恢复 | 当前派发 owner key 耐久化，四者全等；可信非 owner 设备仍 unauthorized | 已解决 |
| U17-10 | [P1] 冻结规则匹配中 builtin 先于 user rule，改变既有“用户规则优先”语义 | 快照化时丢失规则优先级 | 当前与历史 assignment 的工具决策 | 共享 matcher 先匹配 user，再以 builtin 兜底；正反优先级测试通过 | 已解决 |
| U17-11 | [P0] ControlLease 在线、重放、终态恢复与本地 deadline 缓存各自实现，存在终态不可查询、回拨复活和缓存泄漏 | 同一控制生命周期多执行点合同分叉 | executor 全状态、owner 证据、重启与回收 | 共享 reducer/身份谓词；终态仅关闭执行权但保留精确恢复续租；缓存按错误/回收清理 | 已解决 |
| U17-12 | [P1] PermissionSnapshotLease 缺最大 TTL 与接受时刻稳定判定 | 只校验远端绝对时间 | received、重启、工具复验 | 冻结最大 TTL；接受时写本地基线，恢复只扣减剩余时长；边界与回拨测试通过 | 已解决 |
| U17-13 | [P2] 工具授权回调类型在多个包重复声明 | 跨包端口无唯一类型源 | orchestrator、runtime-host、server、CLI | `DurableToolExecutionAuthorizer` 单一公共类型并由全部派生端口复用 | 已解决 |
| U17-14 | [P2] submission 方法子集缺反向完备性 | 注册表新增可漏接 guard | assignment submission 全方法 | 为 `ASSIGNMENT_SUBMISSION_METHODS` 增加合同联合反向断言 | 已解决 |
| U17-15 | [P0] 共享 reducer 接受生产上不可能的无 control 前缀 received/rejection/fence | 重放状态机弱于在线生产端 | executor 重放与 owner 证据分页 | 共享 reducer 强制 control 前缀、authority/owner 身份与状态顺序；消费者全部复用 | 已解决 |
| U17-16 | [P1] 面向 UI 的 user-only `securitySnapshot` 被当作耐久执行权限全集 | 展示投影与执行权威投影耦合 | CLI/server/orchestrator 快照发布 | 保留 user-only 展示接口，新增内部完整 `executionPermissionRules`，生产装配显式使用后者 | 已解决 |
| U17-17 | [P0] owner 证据恢复只验 control 记录结构，未绑定 assigned envelope | 共享 reducer缺 owner artifact 投影适配 | conversation/job cancel/uncertain 恢复 | `controlLeaseBindsDispatchEnvelope` 单源绑定 assignment、authority、lease 与 owner key；双域恶意证据拒绝 | 已解决 |
| U17-18 | [P0] 首次 dispatch 在验 envelope/activation 前从未验证 activation 派生 authority 与 owner key并写 control，错误身份可抢占 assignment | 权威身份取自未经认证载荷 | 双域首次派发、耐久拒收、合法重试 | 两级门禁：`validateDispatchControlBinding` 先验 envelope/ControlLease/owner，activation 深验后仍可耐久拒收；ActivationProof signer 必须等于 envelope signer；7 个相关场景通过 | 已解决 |
| U17-19 | [P1] 过渡签发策略只要求 `credentialTtlMs > 0`，可签发超过协议 24h 上限的 PermissionSnapshotLease 并在后续 envelope 校验深处失败 | 配置入口未复用耐久凭证上界 | 过渡 issuer、conversation 首次派发与配置演进 | 策略入口以 `MAX_PERMISSION_LEASE_TTL_MS` fail-fast；24h 边界保留、边界+1 稳定拒绝 | 已解决 |
| U17-20 | [P2] abort 后迟到 received/rejection 共用一个参数化断言，但共享 reducer 对两类记录有不同稳定拒绝原因 | 合同收紧后把参数化矩阵误当作单一语义 | executor replay 诊断合同与回归资产 | 每个参数携带自身稳定错误合同，received 与 rejection 分支分别通过 | 已解决 |
| U17-21 | [P2] 重复 halted 终态回放用例引用已不存在的 `snapshot`，且耐久 IO 路径贴近默认 5 秒预算 | 测试重构遗留悬空引用且未显式声明真实 IO 预算 | executor 终态重放回归资产 | 以同一证据页的 `toSeq`/`chainDigest` 构造重复终态，并声明 15 秒上界；直接场景通过 | 已解决 |
| U17-22 | [P2] revoked submission 的终态、精确重放与 settlement 组合用例在包级负载下超过默认 5 秒 | 多组真实耐久 IO 组合缺少显式预算 | executor submission 授权回归资产与包级稳定性 | 保留全部断言并声明 15 秒上界；不放宽业务等待，直接场景通过 | 已解决 |
| U17-23 | [P2] 后继 attempt 再次进入 uncertain 的耐久组合在包级负载下超过默认 5 秒 | 多轮 journal fsync 与恢复投影组合缺少显式预算 | job uncertain 重试生命周期回归资产 | 保留完整跨 attempt 断言并声明 15 秒上界；不修改业务等待，直接及包级场景通过 | 已解决 |
| U17-24 | [P2] 派生产物闭包误判“无结构基线变化”，server golden 未包含 orchestrator runtime 对 core 共享授权类型的公开导出边 | 冻结前只核对运行时依赖，遗漏类型导出拓扑 | server 结构门禁与交付文件闭包 | 显式更新并审阅 golden；差异仅允许新增 1 条预期 type-export，结构测试通过 | 已解决 |

## 已排除问题

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X17-01 | 是否应以新 anchorEpoch 直接重开旧 JobJournal 验证历史 capability 稳定拒绝 | planned anchor 迁居与多 epoch 日志读取属于第 34 单元；本单元只验证错误 epoch 不得被当前 assigned 激活 | job submission 定向 2/2 与第 17/34 单元边界 | 第 34 单元落地迁居后审查旧 epoch 历史读取 | 已排除 |
| X17-02 | runtime-host 首次声明构建报告授权回调仍含 `void` | 源码合同已收紧，失败是 owner-kernel 旧 dist；按依赖顺序重建 owner 后 runtime-host 成功 | owner-kernel、orchestrator、runtime-host 顺序构建及最终全量构建 | 正确依赖顺序下再次失败 | 已排除 |
| X17-03 | job 是否缺生产 AuthorityCapability 签发器 | scheduler 尚未切换到 JobJournal，生产接管明确属于第 26 单元；本单元已落 job owner/executor guard 和测试接缝 | 第 17/26 单元边界、job 202 场景中的相关能力测试 | 第 26 单元无法复用当前 guard/issuer 接缝 | 已排除 |

## 迟发现教训

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L17-01 | U17-01/02/06；冻结终审一、二 | 把共享谓词被调用、类型联合有断言误当成各数据闭包和反向完备性均成立 | 对每个 guard 枚举轻量/完整/恢复数据闭包，并对运行时注册表做合同联合的双向类型差分；覆盖 owner、executor 与方法矩阵 | 问题盘点复开：已枚举完整候选、pre-received 与注册表缺口，收齐 U17-01/02/06 |
| L17-02 | U17-03/04/05；冻结终审一、二 | 只验证主执行热路径，没有沿控制存活锚、派生执行与冻结策略的继承链追到最终副作用 | 从每个授权入口沿全部派生执行、租约依赖和策略来源追到真实副作用；在等待、重启、规则变化和终结点插入失效事件 | 问题盘点复开：已覆盖 ControlLease、Task/orchestration 与 builtin 变化，收齐 U17-03/04/05 |
| L17-03 | U17-07/08/09；冻结终审一、二 | 安全审查停在签名有效、scope/epoch 相等，未独立核对跨设备时间、请求正文与派发 owner 身份 | 对每个跨设备授权逐项核对本地单调 deadline、规范请求摘要、签名 keyId、认证连接身份与耐久 owner 身份；双域逐字段替换 | 问题盘点复开：已扫描 owner-control 四方法、permission lease 与 received activation，收齐 U17-07/08/09 |
| L17-04 | U17-10～19；冻结终审一、二 | 只核对单个 guard 的成功路径，遗漏规则优先级、终态恢复、公开投影语义、证据适配器、签发上界及“先写权威事实、后验身份”的顺序 | 对共享授权合同枚举全部生产端/消费者/公开投影；逐项对账身份来源、前缀顺序、终态恢复、时间基线、配置上界和 UI/执行语义；任何耐久权威身份必须来自已认证载荷 | 集中修复：已覆盖 matcher、共享 reducer、owner 证据、派生装配、首次 dispatch 两级门禁与签发 TTL 上界，收齐 U17-10～19 |
| L17-05 | U17-20～22；`50087fd3…` 与 `5c16fc71…` 终审后的最终验证 | 生产合同变更只覆盖直接新场景，未逐参数核对旧回归语义，也未检查重型耐久用例预算与夹具引用 | reducer/夹具变更后逐参数对账错误合同，扫描悬空引用，并在受影响测试文件中核查真实 IO 组合的显式上界 | 最终验证归因：三项测试资产问题集中修复；相关 4/4、类型检查通过 |
| L17-06 | U17-23/24；`9ed33105…` 终审后的最终验证 | 冻结前未把跨文件类型导出映射到结构 golden，也未把 job 跨 attempt 耐久组合纳入重型预算扫描 | 冻结准备逐项把 import/type-export 映射到结构基线；同族 IO 预算扫描跨全部受影响测试文件而非只看首个失败文件 | 最终验证归因：job 场景预算补齐，golden 仅新增 1 条预期类型导出边；包级验证全绿 |

## 验证计划与证据账本

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V17-01 | 方法矩阵、共享 guard、双域激活与真实安全管线 | core authority、owner issuer、executor conversation/job、orchestrator security、CLI recovery 定向测试及受影响包类型检查 | S17-A～D 直接源码与测试 | 历史 | 旧交付物的直接验证 | `4202e36e…` | 已失效:交付物变化 |
| V17-02 | 共享合同对既有生产路径无回归 | core、owner、executor、orchestrator、CLI 逐包全测 | 旧 26 文件与各包完整测试输入 | 历史 | 旧交付物的包级回归 | `4202e36e…` | 已失效:交付物变化 |
| V17-03 | 最终声明产物、依赖顺序与交付闭包 | `pnpm build`；`git diff HEAD --check`；文件清单与指纹复算 | 旧 26 文件与构建输入 | 历史 | 旧交付物的最终验证 | `4202e36e…` | 已失效:交付物变化 |
| V17-04 | U17-10～24 根因修复、首次派发身份预验、签发上界与测试/派生产物闭包 | core/executor/owner 类型检查、core 构建、双域 owner 恶意证据、executor 身份/拒收、issuer 边界及回放测试 | 当前 45 文件及直接相关测试 | 冻结前 / 中 / 已完成 | 类型检查与直接测试全部通过；测试资产相关场景及结构 golden 定向验证通过 | `beaa297b…` | 有效 |
| V17-05 | 当前交付物包级回归与最终声明产物 | 单独全量构建；受影响包全测逐包串行；diff 与指纹复算 | 当前 45 文件、构建图及受影响包测试输入 | 最终 / 高 / 已完成 | 17 包全量构建成功；core 2361、owner 161、executor 389、orchestrator 425、server 745、CLI 2365 项全绿；双 diff check、45 文件闭包与指纹一致 | `beaa297b…` | 有效 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 历史冻结终审一 | 需求、架构边界、方法矩阵、签发到执行的生产闭包 | 是 | 后续发现 U17-01～18 | `4202e36e…` | 已失效 |
| 历史冻结终审二 | 错绑定、过期/吊销、并发恢复、安全边界、派生闭包与测试盲区 | 是 | 后续发现 U17-01～18 | `4202e36e…` | 已失效 |
| 历史冻结终审一 | 需求、架构边界、方法矩阵、签发到执行的生产闭包 | 是 | 最终验证发现 U17-20/21 | `50087fd3…` | 已失效 |
| 历史冻结终审二 | 错绑定、过期/吊销、并发恢复、安全边界、派生闭包与测试盲区 | 是 | 最终验证发现 U17-20/21 | `50087fd3…` | 已失效 |
| 历史冻结终审一 | 生产合同与测试拒绝语义、同文件回归闭包 | 是 | U17-20 修复未覆盖参数分支、U17-22 | `5c16fc71…` | 已失效 |
| 历史冻结终审二 | 重复终态证据序号/摘要闭包与夹具引用完整性 | 是 | U17-21 需显式 IO 预算 | `5c16fc71…` | 已失效 |
| 历史冻结终审一 | 参数化拒绝分支与受影响 IO 场景预算闭包 | 是 | U17-23/24 | `9ed33105…` | 已失效 |
| 历史冻结终审二 | 重复终态证据、夹具引用与预算安全性 | 是 | U17-23/24 | `9ed33105…` | 已失效 |
| 冻结终审一 | 45 文件闭包、预算同族、golden 差异与最终验证证据 | 是 | 无 | `beaa297b…` | 通过（1/2） |
| 冻结终审二 | 授权生命周期、跨包消费者、恢复与派生产物独立复核 | 是 | 无 | `beaa297b…` | 通过（2/2） |
| 历史最终交付验证 | 受影响包全测、正确依赖顺序全量构建、diff 与指纹 | 是 | U17-20/21 | `50087fd3…` | 已失效：测试资产变化 |
| 最终交付验证 | 受影响包全测、正确依赖顺序全量构建、diff 与指纹 | 是 | 无 | `beaa297b…` | 通过 |

<!-- registration-complete: unit-17.gen-1 -->
