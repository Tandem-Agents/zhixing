# 单元登记:第 13 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:13
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-07-14
- **登记来源**:压缩重放死循环根治方案(代际文件模型)落地时,由架构者按用户授权登记;承接此前被重置的第 13 单元审查状态与本轮架构者×执行者对抗审查的收敛结论

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、九类核查面行、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:问题裁决完成,集中修复中(U13-01~03 已修复并验证;U13-04~11 已裁决待修复)
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:否
- **交付物文件集**:`packages/core/src/protocol/assignment.ts`、`packages/core/src/protocol/index.ts`、`packages/executor/src/assignment-ledger.ts`、`packages/executor/src/__tests__/assignment-ledger.test.ts`、`packages/owner-kernel/src/conversation-assignment.ts`、`scripts/check-runtime-package-exports.mjs`、`research/design/modules/distributed-runtime/specification.md`(共 7 个文件;工作台及单元文件不计入交付物)
- **当前交付物指纹**:未冻结不计算
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的取消、三分续跑与不变量;`research/design/modules/distributed-runtime/specification.md` 的 §1.2、§3.6、§4.3、§5.1、§5.5、§6.1、§十二及执行计划第 13 项

## 固定边界

- **功能范围**:conversation 的 `cancel-requested`、owner-fence / abort-ticket 双取消源、SupersedeProof、DispatchConflictProof、containment、三分续跑与 UncertainResolution 用户三选
- **架构不变量**:封包先赢则合法提交;取消先赢才阻止新动作;仅可验证的未启动终结证明允许重派;结果不明必须进入 uncertain 并锁定对话;裁决、吊销与状态变化原子耐久且可重驱
- **验收条件**:§6.1 全 36 行逐边覆盖;owner-fence × abort-ticket × sealed 三方竞态、相关 fsync 崩溃点、未闭合副作用、无证明禁重派、迟到合法 bundle 自动提交及用户三选通过
- **必要上下游**:第 9 单元 AuthorityCommitLog / ArtifactStore、第 10 单元 ControlRequestJournal、第 11 单元 assignment 账本与 ActivationProof、第 12 单元 SealedBundle / CAS / FinalOutbox;冻结的 proof、control 与状态合同
- **明确不属于本单元**:job、delivery、资源治理实际结算、数据面票据签发、mesh adapter、生产总切换(uncertain 的超时触发策略可留外层,但账本证据判定与证明重取驱动属本单元恢复驱动闭环——见 U13-06 裁决)

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core 协议层(assignment.ts + index.ts) | 新协议函数的包导出与运行时导出门禁清单 | `scripts/check-runtime-package-exports.mjs` 已同步新增八个 sign/validate 导出 | 待核查(冻结前跑 `pnpm runtime:package-exports`) |
| spec §4.3 记录联合回填 | run 流 / job 流的 `supersede-requested`、`cancel-contained` 与 factDigest 公式须与实现语义一致 | U13-08 裁决后需按冻结三分语义复核 spec 注释与实现同步 | 待核查 |
| executor 账本 / owner journal / 测试 | 状态机行为与 §6.1 逐边测试的一致性 | 修复 U13-04~09 后定向测试与新增用例 | 待核查 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| assignment 取消、真实副作用与封包排序 | executor assignment 流(recordSeq 全序) | bundle_sealed 与 abort/halted 的账本先后 | seal 与 abort 同事务域竞争 | executor 产;owner 消费 proof/bundle | — | 有问题:U13-04 |
| owner 取消栅栏与终态收束 | owner run 流 cancel-fence + state | submitCancelProof 事务 | 恢复重放插点 | owner cancel/恢复器产;executor 消费 fence | — | 有问题:U13-05 |
| 未启动证明、supersede 与安全重派 | supersede-requested + AssignmentTerminationProof | assignment-superseded 同 envelope | fence 先到 tombstone;响应丢失重驱 | owner 产 fence;executor 产 proof | — | 通过(U13-01 修复后;重放矛盾归 U13-05) |
| dispatch conflict、账本证据与 containment | dispatch-conflict 记录 + received 前缀链 | 同 envelope conflict+uncertain+fence+revocations | conflict 响应丢失、双分支重启收敛 | executor 产 proof;owner 裁决 | — | 通过 |
| uncertain 打开事实、三分解析与用户三选 | resolution 记录(openFactDigest/factDigest) | resolution 与 state 同 envelope 原子 | 裁决重放、applied 半边 | owner 产;surface 裁决 | — | 有问题:U13-06、U13-07 |
| 迟到合法 bundle 自动提交 | conversation CAS + open conflict fence-rejected 守卫 | committed 同 envelope 关闭 resolution | uncertain 期 bundle 到达 | executor 提交;owner CAS | — | 通过 |
| 取消、重派与证明提交的恢复驱动 | InProcessConversationDispatcher 各 recover* | 各 pending 谓词 | owner 重启后各差集重驱 | owner 驱动 | — | 有问题:U13-06 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 总纲/状态机 | 取消、三分续跑、uncertain | 状态 | §6.1 全 36 行 | 有问题:U13-04、U13-05 | 待填 | 待填 |
| 执行计划 13 | 双取消源、重派与裁决生产端 | 入口与生产端 | owner cancel/supersede/conflict/resolve;executor abort/halt | 有问题:U13-06、U13-07 | 待填 | 待填 |
| 端口/导出 | proof、submission 与控制消费者 | 消费端与继承面 | protocol、owner/executor adapter、history/status | 有问题:U13-09 | 待填 | 待填 |
| 记录合同 | fence/proof/conflict/resolution 生命周期 | 生命周期 | request→proof→terminal/contained/resolved | 有问题:U13-01~02(已验证)、U13-08 | 待填 | 待填 |
| 故障矩阵 | 三方竞态与各 fsync 插点 | 并发与崩溃点 | owner-fence×abort-ticket×sealed、响应丢失与重启 | 有问题:U13-04、U13-05、U13-06 | 待填 | 待填 |
| 状态机/产品终态 | committed/cancelled/failed/queued/uncertain | 异常路径与终态 | 自动解析、用户三选、无证明禁重派 | 有问题:U13-05、U13-08 | 待填 | 待填 |
| 凭证/对抗矩阵 | proof 签名、epoch、fence 与账本链 | 安全边界 | 污染、重放、错 assignment/executor/owner | 有问题:U13-01(已验证)、U13-09 | 待填 | 待填 |
| 包结构/顺序 | core/owner/executor | 模块边界 | 进程内闭环,不启用 job/mesh/生产切换 | 通过:依赖方向核实(executor 组合含本地域 owner-kernel,测试跨包 import 合法);三包 tsc 零错(E1) | 待填 | 待填 |
| 执行计划验收 | 36 行与专项竞态/崩溃测试 | 测试与验收 | 逐边独立用例及直接回归 | 有问题:U13-10、U13-11 | 待填 | 待填 |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U13-01 | `createOpenResolutionFact` 曾以 `"UncertainResolutionOpenFact"` 计算 openFactDigest,spec 冻结为 `D("UncertainOpenFact",…)`;`resolution.factDigest` 曾三路径三种摘要来源,违反 §1.2 每 Digest 字段恰命中一类 | 摘要域字符串未从 spec 冻结值取用;factDigest 计算散在调用方 | resolution 记录、`uncertain-resolve` 绑定摘要、S5 跨机复算、重放验证、uncertain 全部测试 | openFactDigest 改回 `"UncertainOpenFact"`;factDigest 收敛单点 `resolutionFactDigest = D("UncertainResolutionDecision",1,{openFactDigest,kind,by,at})`,reduce 增复算与字段封闭守卫;spec 同步冻结公式 | 已验证 |
| U13-02 | owner 日志新增 `supersede-requested` / `cancel-contained` 为机制必需,但不在 spec §4.3 两联合 | spec 缺口:supersede fence 无耐久载体、非 conflict containment 无止损锚 | spec §4.3 run/job 两联合、单元 14 同构、S5 重驱、S8 收编导出 | 按封版流程回填 spec(run/job 双流 + fenceSeq=envelope lsn 语义),代码不动 | 已验证 |
| U13-03 | executor 默认 `usageFinal` 以自造 `"AssignmentUsageFinal"` 摘要占位,spec 注册目标是 `UsageReport.digest`(S4 落地) | 资源治理未落地前的结构占位,曾无边界标注 | 耐久 CancelProof.usageFinal、S4 对账、租约终结表 | 保留占位 + 源码注释显式标注 S4 边界与注入义务;S4 接入真 governor 时替换 | 已验证 |
| U13-04 | `#recordSealedBundle` 决定函数与 reducer `bundle_sealed` case 均只查 phase/aborts,未查未闭合 side effect;spec §4.3 明文“halted 与 bundle_sealed 之前全部 effect 必已闭合” | 同一句纪律只在 halted 半边落实 | executor 封包生产端、reducer 重放守卫、owner CAS 消费的 bundle 可信度、副作用不明的提交、封包测试 | 生产端与 reducer 双点补 open-effect 守卫(存在未闭合 effect 拒绝封包);补“开 effect 时 seal 被拒”用例 | 待修复 |
| U13-05 | 矛盾 not-started CancelProof 首次被 `contradictoryNotStarted` 拒绝转 uncertain(cause: cancel-unproven);恢复器重提交同一 proof 走 uncertain 分支,该分支无矛盾复查,直接 resolution+superseded+queued 自动重派 | 矛盾守卫只存在于非 uncertain 分支,uncertain 分支未消费 cancelOrigins/曾见 started | owner submitCancelProof、恢复驱动 recoverCancellationProofs、“已耐久见 started 不得自动重派”不变量、重放测试 | uncertain 分支对 not-started 终结复查同一矛盾谓词;矛盾则保持 uncertain 待用户裁决;补重放用例 | 待修复 |
| U13-06 | `markAssignmentUncertain` 生产零调用(仅测试);§6.1 行 19/30/33“账本见 abort-requested 无可接受 halted → uncertain”owner 侧无判定路径(LedgerSnapshot 无 abort 中间态,恢复器只认 cancelProof);“executor 崩溃后未闭合 effect → 如实上报 → owner 判 uncertain”整链无生产承载;uncertain 后 pendingSupersedes 停止重驱、证明重取无驱动 | uncertain 的生产与恢复链只建了一半;账本证据消费面缺失 | InProcessConversationDispatcher 恢复驱动、LedgerSnapshot/LedgerEvidencePage 消费、§6.1 行 10/14/19/21/30/33 生产闭环、恢复测试 | 恢复器补账本证据判定(经 evidence page 或扩 snapshot 暴露 abort/open-effect 态)驱动 markAssignmentUncertain;uncertain 后保留证明重取驱动;超时触发策略留外层并在边界注明 | 待修复 |
| U13-07 | control-admission 仅支持 `input/session-create`;§6.1 行 24 动作字面含“applied”而 `resolveUncertain` 无 control applied 半边;幂等以“decision 相等”近似替代“requestId 回放/已关闭 fact 拒绝”,与 §5.1/§5.5 合同有实义差 | cancel/uncertain-resolve 的控制面 wire 接线未建,幂等语义降级 | ControlRequestJournal、session.abort/uncertain-resolve 入口、三选裁决原子性、渠道重投场景、控制面测试 | 本单元补 wire 接线(received→applied 与 resolution/state 同 envelope),或按“归后续处理必须指出承载”在本表与固定边界显式登记承载单元——二者取一 | 待修复 |
| U13-08 | 实现对非 conflict not-started 也写 `cancel-contained`;冻结三分语义(§3.6 contained 属 conflict 专属段落、§6.1 行 23 仅 conflict 分支“另写 contained”)为:conflict not-started 写 `dispatch-conflict-contained`+resolution+superseded;非 conflict halted 只写 `cancel-contained`;非 conflict not-started 只写 resolution+superseded | 引用 spec 时未核对段落归属,实现语义超出合同 | owner submitCancelProof 两分支、reducer `cancel-contained` case(需拒收 not-started proof)、spec §4.3 注释、containment 测试 | 改实现对齐冻结三分语义(非 conflict not-started 去掉 containment;reducer 收紧仅接受 halted);spec §4.3 已回填注释与此一致,复核后不动 | 待修复 |
| U13-09 | `dispatchPending` 的 rejected-before-received 分支只消费 `outcome.proof`、丢弃 `outcome.error`,未按 §3.6“响应 error 必须与 proof.error 全等”校验;conflict 路径有对应校验,同构不齐 | 消费端合同校验漏了 rejection 半边 | owner 派发回执消费、DispatchRejectionProof 接受守卫、污染响应测试 | `acceptDispatchRejection` 入口补 response.error 与 proof.error 全等校验;补污染用例 | 待修复 |
| U13-10 | 两个 IO 重用例(interaction backlog、publish/final 恢复)单跑 3.8s+,贴 vitest 默认 5s 超时线;全套或负载下失败集漂移,隔离重跑全过 | 测试时限预算未显式声明,重 fsync 用例贴默认线 | CI 稳定性、每次偶发红的无谓归因成本、第 12 单元遗留 | 仅对这两个用例显式声明 timeout(证据只覆盖这两个);不砍测试内容 | 待修复 |
| U13-11 | §6.1 全 36 行逐边独立覆盖与相关崩溃点的验收证据未成套;交付物边界此前未含 spec 修订(实际 7 文件) | 单元验收流程未走完即中断(压缩重放死循环事故) | 冻结终审、最终验证、交付物指纹 | 集中修复完成后按执行闭环走冻结准备→两轮终审→最终验证;本文件已按 7 文件边界重新登记 | 待修复 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| E1 | U13-01~03 修复后三包类型闭合 | `pnpm --filter <pkg> exec tsc --noEmit`(core / owner-kernel / executor) | 当前 7 交付文件 + 各包源 | 直接 / 低 / ~70s | 三包零错 | 修复期证据,冻结时按输入闭包重算 | 有效 |
| E2 | U13-01 修复后行为回归与失败归因 | `pnpm --filter @zhixing/executor exec vitest run src/__tests__/assignment-ledger.test.ts` | 同上 | 直接 / 中 / ~57s | 67 用例:resolution 全路径及其余逻辑用例全过;两个 IO 重用例负载下超时、隔离重跑通过(U13-10 的直接证据) | 修复期证据,冻结时重算 | 诊断 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 否 | — | — | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否 | — | — | 待开始 |

<!-- registration-complete: unit-13.gen-1 -->
