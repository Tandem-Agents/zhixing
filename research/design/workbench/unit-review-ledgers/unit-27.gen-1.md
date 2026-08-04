# 单元登记:第 27 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:27
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-03
- **登记来源**:用户要求将第 27 单元独立审查及价值裁决后的问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U27-01～U27-09 专项闭合，待全单元后续流程
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是；当前专项基线冻结，任何交付物修改均使专项矩阵与四路对抗结论失效
- **交付物文件集**:第 27 单元起点 `d4cce198` 至当前完整工作区的 85 个非工作台路径，删除 0；CLI 22、core 23、orchestrator 11、owner-kernel 9、owner-services 9、rpc 1、server 8、架构与规格 2
- **当前交付物指纹**:`git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144`；路径集 SHA-256 `5673c4238b492011e353aa6bfc8678bf79cdffc1e3086c0d36b3830af6ddf2f3`
- **架构来源**:分布式运行时总纲与可执行规格；任务推进闭环架构与 Rubric 协议；运行体生命周期、对话/接入面、确认交互、注意力窗口与 workscene 直接上下游合同；持续在线/本地执行与 S2 安全供应链约束；第 14、15A、15B、18、20、23、25、26 单元冻结合同、适用排除项与迟发现教训；第 27 单元定稿开发清单

## 固定边界

- **功能范围**:第 27 单元（S7）advancement 与独立取证的生产实现、直接相关测试，以及同步修订的推进架构与分布式运行时规格
- **架构不变量**:conversation owner 是推进状态唯一 owner；确认版 Rubric 不可变；accepted run 按连续顺序验收；证据独立、签名并与 request/run/review/workspace 反绑；local/mesh 只换 transport 不换语义；一级取证只读、路径隔离且不泄漏工作区外数据
- **验收条件**:第 27 单元定稿开发清单与独立审查清单 IR27-01～IR27-45；当前 P0/P1 清零后完成规定的冻结终审、独立功能审查和必要验证
- **必要上下游**:core 协议与 SessionStatePort、owner-kernel 权威日志与恢复、owner-services reviewer/evidence、orchestrator host lifecycle、executor handler/journal、server/RPC/CLI 产品入口与投影
- **明确不属于本单元**:第 28～38 单元能力；二级取证；本地域 owner、AuthorityTransfer 与多 owner 拓扑；通用 DeferredGlobalIntent 基础设施；无当前损失依据的 benchmark、性能采集、通用诊断和未来扩展

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
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、状态或结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U27-01 | **P1，工作量：小；来源 P27-02。** LLM 生成/修订把显式 id 经小写、标点折叠与 48 字符截断后直接收下，库 Rubric 又从证据文本/失败场景派生 id；两条生产路径都未检查各自集合唯一性，`confirmDraft` 仍原样固化。**价值裁决记录：**原结论曾误把 passCriteria 语义重复列为 P1，后收窄为显式 id 碰撞；本轮源码复核进一步证明 matched-library 也是当前可达同根入口，故只扩充同一根因的生产面，评级与“小”工作量不变；passCriteria 仍按 `pc-N` 机械编号，不做语义去重。 | `RubricContractContentSnapshot` 在进入不可变确认版前没有一个由生成、修订、库匹配和直接确认共同复用的 id 唯一性谓词，导致 requirement 映射和 failureHandling 查找可被同键多义污染。 | 生产端：LLM 生成/修订、matched Rubric 投影、确认固化；类型组合：evidence requirement/failureHandling 的派生或规范化 id 与确认快照，passCriteria 不在此根因；消费者：requirement 映射、canonical evidence、策略选择、closure 与 reviewer；异常终态：重复、空白回退、折叠/截断碰撞或库内同文本/同场景进入确认版后串线；测试：四个入口的同键负例和合法 passCriteria 回归。受影响审查项：IR27-03、IR27-41。 | 在 advancement 领域建立一个 `RubricContractContentSnapshot` id 守卫：evidence requirement 与 failureHandling 分组校验非空且唯一；LLM 规范化后、matched asset 转换后及 `sealContractContent` 前全部调用，任一碰撞 fail-closed，不改变 passCriteria。验收：生成、修订、库匹配和直接确认均拒绝同键，合法 Rubric 与 `pc-N` 行为不变。 | 已验证 |
| U27-02 | **P1，工作量：中；来源 P27-03。** `confirmRubric` 先写 active，RPC 随后才准入原任务；普通异常会取消，但两步之间崩溃时恢复只处理 accepted run/proxy。进一步核实：耐久准入的 exact key 是 `conversationId + surfacePrincipal + turnId`，当前 advancement 状态只保存 task 与 `originalTurnId`，没有保存确认时的稳定 surface principal 和完整准入命令，恢复即使发现欠账也无法无猜测重放。专项审查又确认：控制器虽已写入 intent，但 `rubric_confirmed` 事件与两个 store 接口仍允许省略它，另一合法写入口仍可形成 active 且无恢复义务的状态。**价值裁决记录：**原结论曾把控制回放、原任务恢复和全局保存合为 P1、大；现只保留 confirm→admit 的当前阻断窗并补齐其真实重入输入，仍为 P1、中；U27-08 独立处理可选保存反馈。 | “契约已确认”与“原任务已耐久准入”之间缺少强制的窄域耐久 outbox：确认事实若可省略完整准入身份，active 恢复 owner 就无法确定性重驱。 | 生产端：Rubric confirm 权威写、两个 store 写入口、RPC admission 与恢复；类型组合：conversationId、originalTurnId、originalUserTask、invocation/turnOrigin、surfacePrincipal、active 下的 admission pending/admitted/cancelled 义务与 runId；消费者：conversation owner、恢复扫描、任务执行与用户投影；异常终态：无 intent 确认、确认后崩溃、admit 后响应丢失、结清前崩溃、重复恢复、确定拒绝、暂态失败与结果不明；文档：推进架构的确认—准入与恢复状态表；测试：每个插点、错误分类及 queued/in-flight/accepted exact replay。受影响审查项：IR27-07、IR27-12、IR27-32、IR27-33、IR27-36、IR27-37。 | 将 admission intent 设为 `rubric_confirmed` 与两个 store 确认入口的必填事实，并在同一权威提交中耐久保存：以 session 已有 `originalUserTask` 为唯一任务内容，另存稳定 turnId、invocation/turnOrigin、surfacePrincipal 及必需选项并反绑内容摘要，在 active 投影下形成 pending 义务；恢复 owner 用原载荷调用既有 `admitDurableTurn`，取得/回放 runId 后写结清事实；仅 conversation 不存在、异载荷冲突等可确定拒绝写既有取消终态，暂态或结果不明保持 pending 并重驱。不得复制任务事实、新增会话主状态或新建通用 operation 协议。验收：任何确认零无 intent active 状态；confirm 前后、admit 前后、结清前后任意崩溃最终恰一 run 或有事实依据的取消，暂态/不明结果不误取消，异 principal/异载荷重试拒绝，结清事实保留原 runId，U27-08 保存成败不阻断准入。 | 已验证 |
| U27-03 | **P1，工作量：中；来源 P27-04。** `reviewAcceptedTurn` 无论 earlier-run catch-up 返回 `review-deferred/failed` 还是抛错都会继续审当前 run；恢复又用 `max(session.runs.runIndex)` 当水位，因此一个当前可达的 transient reviewer 失败即可永久跳过较早 accepted run。专项审查进一步确认：turn-commit 传入当前 `beforeRunIndex` 时，扫描先跳过记录再核 admission `runId` 下界，原任务首次 run 会被自身上界遮蔽；若已有同 `runIndex` 但非全等 `runRecordRef` 的 review，扫描仍判定欠账、controller 却以索引短路，恢复循环会反复命中同一 run。 | accepted-run 顺序没有以“耐久 accepted 集合减去全等 `run_reviewed` 集合的最早缺口”为唯一连续前缀谓词，调用方把最大索引、一次 catch-up 返回或未证明进展的 controller 短路误当成无欠账证明。 | 生产端：turn-commit maintenance、accepted-run 恢复枚举与 review 写；类型组合：U27-02 结清的 original runId、runIndex/runRecordRef、accepted、durable reviewed、deferred/failed 与 session terminal；消费者：reviewer、proxy 续推、收场与恢复；异常终态：早期 deferred/failed、后续 turn、重启、乱序历史 review、缺失/错绑 ref 造成的无进展循环；文档：推进架构 accepted-run 恢复判据；测试：oldest-first 缺口、catch-up 失败阻断当前、恢复续做、连续无缺口及无进展 fail-closed。受影响审查项：IR27-09、IR27-12、IR27-32、IR27-33、IR27-45。 | 以 U27-02 admission 结清的 original runId 作为本推进会话的耐久验收下界，从该 run 起按权威日志 oldest-first 找首个没有全等 `run_reviewed` 的 accepted run；catch-up 只有明确返回“此前无缺口且会话仍 active”时才允许审当前 run，deferred/failed/异常一律保留当前未审；每次补审返回后必须从最新权威投影证明该 `runRecordRef` 已有全等 review，否则立即 fail-closed，禁止空转或用时间戳、最大索引猜边界。验收：会话前历史不混入，较早欠账始终先完成，乱序 review 不抬高水位，任一 transient 失败后重启可续做且不产生后序 review，错绑/缺失 ref 不形成恢复循环。 | 已验证 |
| U27-04 | **P1，工作量：中；来源 P27-06。** pending evidence 恢复复用 reviewId，而 review 根恒为 `attempt:1`；一次 review finally 已把根 release 后，恢复会尝试复活同根，child/requestId 又只按 `reviewId+attempt` 派生，可能让同键绑定另一 lease 并撞上 executor journal 的异载荷拒绝。专项审查又确认：generation 投影只保留代际、不保留该代最后 attempt；typed-stale 先结清并移除 pending 后，同代 attempt+1 会因门禁找不到前一 pending 而被自身拒绝。 | owner 权威状态没有为被审 run/review 同时保存严格前进的 evidence generation 与 generation 内最后 attempt；root、child、dispatch requestId 和 pending/result/settled 因而不能共享可恢复的完整代际序列。 | 生产端：review/evidence 创建、pending 恢复、stale 重试、root/child lease 与 executor journal；类型组合：run/reviewId、generation、generation 内 lastAttempt、root/child leaseId、requestId、pending/result/settled；消费者：governor、evidence handler/journal、reviewer 与恢复；异常终态：旧根 released、同键异载荷、stale 结清后续试被拒、重启重复 dispatch、终态 bundle 已有但 review 未落；测试：同代重发、stale 结清后的严格 attempt+1、换代、旧代结清、terminal bundle 复用。受影响审查项：IR27-13、IR27-17、IR27-33、IR27-36、IR27-44。 | 在 advancement 权威事件派生投影中为每个被审 run 耐久折叠单调 `evidenceGeneration + lastAttempt`；该代际同时进入 root workload 身份、child 身份和 requestId，同代新请求必须严格等于 `lastAttempt+1`，不依赖仍存活的 pending。未过期同代只重发原请求；旧代无法继续时先写 deferred/结清再推进 generation；已耐久 terminal bundle 只按原请求验真消费，无须新租约。验收：released 根不复活、不同 lease 零 requestId 复用、stale 结清后同代下一 attempt 可推进且跳号/回退被拒、同代/跨代重启幂等、结果落盘后崩溃可直接完成 review。 | 已验证 |
| U27-05 | **P1，工作量：中；来源 P27-08。** log/artifact 先用 PathGuard realpath 判界，再按原相对路径 `readFile`；校验与打开之间替换 symlink 可把工作区外内容读入摘要。多文件又以无 path/存在性/长度分帧的 `Buffer.concat` 计算单一摘要，可由不同逐文件状态得到同 digest。专项审查确认实现已绑定句柄与二次路径身份，但现有“mid-read”用例只在两次完整采样之间改写内容，未命中单次打开后发生 ABA 替换的 `fstat + realpath/stat` 防线。 | 路径授权与读取没有绑定同一已打开文件身份，聚合 observation 也没有以每个文件的规范身份和内容状态形成无歧义承诺；对应验收若只测两次采样差异，无法证明句柄/路径绑定真正生效。 | 生产端：log/artifact provider 的路径解析、打开、读取、摘要与 observation 指纹；类型组合：canonical relative path、handle identity/stat、存在性、长度、单文件 digest 与聚合 digest；消费者：EvidenceBundle、canonical evidence、摘要与 reviewer；异常终态：symlink TOCTOU、ABA 替换、文件间字节迁移、读取中变化与 stale；测试：越界替换、句柄/路径身份错位、framing 碰撞、读取中变化。受影响审查项：IR27-21、IR27-22、IR27-23、IR27-33、IR27-34。 | 对每个声明路径先取 canonical path 并判界，再打开该 canonical path；从句柄读取前后比较 `fstat`，读取后重新 `realpath/stat`，要求仍在 canonical workspace 且与句柄的 `dev/ino/size/mtime` 全等，否则丢弃 bytes 并返回 typed-stale。同步规格：多文件 item 先为每个声明路径生成 `{relativePath,state:"missing"}` 或 `{relativePath,state:"present",length,contentDigest}`，按请求顺序组成数组，以 `UTF8(JCS(array))` 作为该 item 的规范原始字节并计算 `B(bytes)`，不再摘要裸字节拼接；用单次文件读取内的确定性 ABA 故障注入证明句柄/路径错位只产生 stale。验收：工作区外或替换后的未授权字节绝不进入摘要/包，不同逐文件状态零 digest 碰撞，采集中变化稳定为 stale，合法单/多文件仍只读可用。 | 已验证 |
| U27-06 | **P2，工作量：小；来源 NB27-01。** evidence 子租约在 `acquireChild` 成功后、`#dispatch` 的既有 finally 接管前，若请求构造或 `evidence_requested` 权威写失败，只能等待到期回收；不改变业务事实，但会无谓占用当前容量。 | 子租约签发者与 dispatch 终结者之间缺少一个明确、无重叠的局部所有权交接点。 | 生产端：child 签发、请求构造、权威 request 写与 dispatch；类型组合：parent/child lease、pending event 与接管标记；消费者：governor、evidence coordinator；异常终态：构造/写入抛错、dispatch 前取消、清理失败与父结算；测试：各前置异常插点、接管前后和子先父后。受影响审查项：IR27-14、IR27-18、IR27-33、IR27-35。 | 从 child 返回起由 coordinator 局部 scope 持有；只有进入 `#dispatch` 时才把终结责任交给其既有 finally。交接前异常调用现有 `finishLease`（settle→release，失败才 reclaim），交接后外层零清理。验收：所有 dispatch 前异常即时释放，dispatch 后恰一终结，重复清理幂等且始终子先父后。 | 已验证 |
| U27-07 | **P2，工作量：中；来源 NB27-03（原 P27-01）。** `isAdvancementControlEvent` 对 draft/window/exit 仅验 object，对 review/proxy 仅验 attribution object；领域 guard 对 evidence 三类事件只验 active，未核 requestId/reviewId/requestDigest/映射边界及结果、结算所指 pending。当前事件只由同进程 typed producer 生成且已核合法，因此尚无当前业务故障。专项审查进一步确认 proxy 门禁只反绑 `proxyMessageId`，未反绑失败 review 的 reviewId、failureHandling 与 attribution，reviewId 本身未做会话内唯一性检查；确认事件门禁也只校验 requirement/failure id，允许调用方构造或受损重放携带重复 criterion id，裁判的集合覆盖会把两个标准压成一个。**价值裁决记录：**原结论按“畸形事件可进入生产”评为 P1、大；生产调用图推翻外部可达性，改为 P2、中；本轮只把实际缺失谓词列成有限闭包，不恢复开放式全排列。 | 权威事件 codec 与领域 guard 没有复用完整嵌套领域 validator，也未在 reducer 前封住当前 reducer 与裁判实际依赖的有限身份/跨事件绑定；这是内部 producer 回归/受损 replay 的防御纵深缺口。 | 生产端：advancement typed producers、权威写与 replay；类型组合：draft、confirmedRubric、review、window、proxy、exit、evidence attempt/result/settlement；消费者：guard、reducer、裁判、投影与恢复；异常终态：未知字段/错类型、确认 criterion id 重复、重复 review id/run 身份、proxy-review/failureHandling/attribution 错绑、evidence request/digest/index/pending 错绑；测试：上述有限字段与绑定负例，不做开放全排列。受影响审查项：IR27-02、IR27-04、IR27-05、IR27-11、IR27-15、IR27-41、IR27-42。 | 让 codec 复用各嵌套领域 validator；guard 只补当前消费者实际依赖的有限绑定：确认版 criterion/requirement/failure id 分组唯一，review id 与 run 身份唯一，proxy 的 reviewId、failureHandling 与 attribution 全等对应同一 failed review，evidence attempt 的 requestId/reviewId/digest/索引全等且结果与结算只指向当前 pending，terminal 与同批 review 决定一致。验收：当前合法 producers 全通过，列明的非法形状/错绑在 reducer 前 fail-closed，外部仍无 raw-event 入口且不建设全排列设施。 | 已验证 |
| U27-08 | **P2，工作量：小；来源 NB27-04（由 P27-03 拆分）。** 全局 publication 已有稳定 `draftId+persistence` requestId 与 CAS，但 controller 只返回预估 `acceptanceOutcome`，随后 fire-and-forget 并吞错；用户看到“正在保存”后永远收不到真实 saved/deferred/failed。专项审查进一步确认：当前把 `failed` 留作裸 Promise rejection，RPC 完成原任务准入后才附加处理器；准入跨越 I/O 时 rejection 可先成为未处理拒绝。**价值裁决记录：**原结论与 confirm 恢复合为 P1、大，现因失败不回滚本任务而独立为 P2、小；本轮对抗复核否定了“confirm 返回前先等待保存”的旧方案，因为权威 D27-09 明确本任务采用/准入不得等待全局写。 | 可选 publication 的异步完成结果没有在产生处立即收敛为窄域显式终态；同时其正确修复必须守住“本地契约采用与原任务准入优先、全局保存独立”的产品边界。 | 生产端：confirm controller、RPC admission 与 GlobalRubricPublication；类型组合：稳定 requestId、CAS、publication task 及 saved/deferred/failed；消费者：RPC/CLI 反馈与 Rubric 库；异常终态：保存失败/超时、失败先于准入完成、准入与保存交错、响应丢失和重复 publish；测试：任务先准入、三种真实结果、失败不形成未处理拒绝、不取消 active/run、同键幂等。受影响审查项：IR27-27、IR27-32、IR27-40。 | controller 启动窄域 publication task，并在产生处立即把 rejection 收敛为显式 `failed` 结果；RPC 先完成 U27-02 的耐久原任务 admission，再消费该 task，将 `saved/deferred/failed` 映射为真实人话反馈。publication 失败不得取消 active/run，继续复用稳定 requestId，不新增 DeferredGlobalIntent 或通用通知设施。验收：原任务准入零等待全局写，失败先于准入完成也不产生未处理拒绝，返回文案与真实结果一致，保存失败仍继续任务，重复调用不重复落库。 | 已验证 |
| U27-09 | **P2，工作量：小；来源 NB27-06（原 P27-09）。** 启动恢复顺序扫描目录；`loadActiveSession` 异常已在单会话内转为 failed，但 `findUnreviewedAcceptedRun` 的 run 读取异常会让 `recoverConversation` reject，继而结束 `recoverAllOpenSessions` 的剩余扫描。组合根会捕获，server 仍启动，用户 resume 还能定向恢复健康会话。**价值裁决记录：**原结论为 P1、中并要求耐久分页 cursor；当前无启动阻断或规模损失，故保持 P2、小。 | 全局启动枚举没有把单 conversation 的恢复失败隔离成一项结果，导致一个坏项截断后续健康项的主动恢复；这与 U27-03 的会话内连续前缀无关。 | 生产端：启动目录枚举、`recoverAllOpenSessions` 与 `recoverConversation`；类型组合：conversation entry、run-read success/failure 与 recovery result；消费者：启动组合根、server readiness、后续健康会话；异常终态：单坏项、其后健康项、全局扫描与 resume；测试：坏项隔离继续、服务启动、健康项主动及定向恢复。受影响审查项：IR27-12、IR27-31、IR27-33、IR27-35。 | 在 `recoverAllOpenSessions` 的逐 conversation 边界捕获 reject，转成带 conversationId 的 failed 结果并继续；复用现有目录与 `recoverConversation`，不加 cursor。验收：坏项不截断后续项或 server 启动，U27-03 在坏会话内仍 fail-closed，健康项可主动/定向恢复；仅重开条件成立才评估分页。 | 已验证 |

## U27-01～U27-09 专项固定核查矩阵

| 问题 | 生产入口与唯一 owner | 耐久事实、线性化点与消费终态 | 重试 / 崩溃恢复与生产装配 | 直接交界 | 状态 |
| ---- | -------------------- | ---------------------------- | -------------------------- | -------- | ---- |
| U27-01 | `RubricContractBuilder` 的生成、修订、库匹配与确认固化；契约内容守卫是唯一确认门 | `rubric_confirmed` 前的不可变 content snapshot；消费者为 requirement 映射、failureHandling 与 reviewer | 所有入口复用同一守卫；碰撞零写入，合法内容保持原语义 | 为 U27-02 提供唯一可准入的确认快照 | 专项与四路冷启动对抗通过 |
| U27-02 | 当前 conversation owner 的 confirm→durable admission | `rubric_confirmed` 必填且同提交的 admission intent；`admitDurableTurn` exact replay 后的 runId 结清事实 | 暂态/结果不明保持 pending，确定拒绝才取消；重启按原 principal、turnId 与载荷重驱 | U27-08 保存不得阻断准入；结清 runId 是 U27-03 下界 | 专项与四路冷启动对抗通过 |
| U27-08 | confirm controller 启动窄域 publication task，RPC 编排真实反馈 | 全局库既有 requestId/CAS；task 在产生处把 rejection 收敛为显式 failed，三种终态只影响保存反馈，不改变 active/run | 先完成 U27-02 准入再等待保存结果；响应丢失不改变已提交结果，重发 publish 复用稳定 requestId | 与 U27-02 共享确认 RPC，但所有权和终态独立 | 专项与四路冷启动对抗通过 |
| U27-03 | turn-commit maintenance 与 recovery owner | 从 U27-02 原 runId 起，accepted 集合减全等 reviewed 集合的最早缺口是唯一前缀 | oldest-first；deferred/failed/异常不允许后序 review；每次补审须证明全等 ref 已耐久，否则 fail-closed 而非空转 | U27-09 只隔离不同 conversation，不放宽单会话 fail-closed | 专项与四路冷启动对抗通过 |
| U27-09 | 启动恢复枚举器 | 每个 conversation 的 recovery result；坏项不得截断后续健康项 | 逐项捕获 reject 并继续，定向 resume 复用同一恢复入口 | 与 U27-03 的会话内连续性边界正交 | 专项与四路冷启动对抗通过 |
| U27-04 | advancement owner 的 review/evidence generation | 单调 generation 与代内 lastAttempt 同时绑定 root、child、requestId 与 pending/result/settled | 同代只回放原请求或严格推进 lastAttempt+1；旧代先结清再换代；terminal bundle 无新租约消费 | U27-06 负责 child 从签发到 dispatch 的局部交接 | 专项与四路冷启动对抗通过 |
| U27-06 | evidence coordinator 的 child lease 局部 scope | dispatch 调用是唯一责任交接点；前由 caller、后由 dispatch finally 终结 | 交接前异常即时 finish，交接后外层零清理；子先父后 | 不改变 U27-04 generation 与耐久 pending 语义 | 专项与四路冷启动对抗通过 |
| U27-05 | executor log/artifact provider | 已打开句柄身份与路径复核共同授权 bytes；多文件 JCS 帧的 `B(bytes)` 是无歧义承诺 | symlink/ABA/读取中变化均丢弃 bytes 并 typed-stale | U27-07 保证结果进入 reducer 前的形状与绑定合法 | 专项与四路冷启动对抗通过 |
| U27-07 | advancement event codec 与 batch guard | codec 严格形状 + guard 当前消费者依赖的有限身份与跨事件绑定，含确认版三组 id 唯一性 | 写入和受损 replay 共用谓词；非法事件在 reducer/裁判前 fail-closed | 覆盖 U27-01～U27-06 新事件字段及 U27-05 结果边界 | 专项与四路冷启动对抗通过 |

## U27-01～U27-09 专项反证账

| 编号 | 反证 | 归属 | 当前处置 |
| ---- | ---- | ---- | -------- |
| C27-01 | matched-library Rubric 也可产生 requirement/failure id 碰撞 | U27-01 | 修复后复核通过：生成、修订、库匹配与 seal 共用同一 content 守卫，A27-01 零旁路 |
| C27-02 | confirm→admit 的 exact replay 缺 stable surface principal 与完整原载荷 | U27-02 | 修复后复核通过：必填 admission intent 耐久保存原身份与摘要，在线/恢复共用 exact replay |
| C27-03 | 暂态或结果不明若沿用“任意失败即取消”仍会误杀可恢复任务 | U27-02 | 修复后复核通过：仅确定拒绝取消，暂态/不明保持 pending 并由恢复重驱 |
| C27-04 | 最大 reviewed index 会跨过早期 deferred/failed accepted run | U27-03 | 修复后复核通过：原 runId 下界与 oldest-first 全等缺口取代最大索引水位 |
| C27-05 | released review 根被同 reviewId/attempt 复活并让 requestId 绑定新 lease | U27-04 | 修复后复核通过：generation 进入 root、child、requestId 与耐久事件，旧身份零复活 |
| C27-06 | child 签发后、dispatch 接管前异常只能等过期 | U27-06 | 修复后复核通过：dispatch 是唯一交接点，交接前异常即时 finish，交接后零双清理 |
| C27-07 | PathGuard 校验后按原路径打开存在 symlink/ABA 窗口，多文件裸拼接可碰撞 | U27-05 | 修复后复核通过：canonical 句柄身份复核与 JCS 分帧分别封住越界和碰撞 |
| C27-08 | typed producer 合法不等于受损 replay 与未来回归可绕过 reducer 前有限绑定 | U27-07 | 修复后复核通过：写入与 replay 共用严格 codec/guard，有限消费者绑定在 reducer 前拒绝 |
| C27-09 | 等待全局保存后再准入会违背原任务立即执行合同 | U27-08 | 当前源码证伪旧方案：RPC 固定先准入、后消费保存 task，保存失败不回滚 active/run |
| C27-10 | 一个 conversation 的 run 读取异常会截断后续健康会话启动恢复 | U27-09 | 修复后复核通过：逐 conversation 捕获为 failed 并继续，单会话内部仍 fail-closed |
| C27-11 | stale attempt 结清会移除 pending，而 generation 投影未保留 lastAttempt，导致同代下一 attempt 被门禁自身拒绝 | U27-04 | 修复后复核通过：投影保留 lastAttempt，同代只接受严格下一 attempt，不依赖 pending 存活 |
| C27-12 | proxy 只按 proxyMessageId 找失败 review，未反绑 reviewId、failureHandling、attribution，reviewId 也未会话内去重 | U27-07 | 修复后复核通过：review 身份唯一且 proxy 三域全等反绑 failed review |
| C27-13 | `rubric_confirmed` 与 store 确认入口仍允许省略 admission intent，可生成 active 且无法恢复原任务准入的状态 | U27-02 | 修复后复核通过：事件类型、codec、两个 store 入口和 guard 均强制 intent |
| C27-14 | turn-commit 以当前 `runIndex` 作为补审上界时，恢复扫描先跳过该 run、再核 admission `runId` 下界；原任务首次 run 因而无法证明此前连续且不会进入当轮验收 | U27-03 | 修复后复核通过：下界身份先于上界过滤；恢复定向 27/27 与 A27-02 事实链通过 |
| C27-15 | accepted 扫描按全等 `runRecordRef` 判欠账，但 controller 会对同 `runIndex` 的非全等 review 返回 `already-reviewed`；恢复若不验证耐久进展会无限重扫同一 run | U27-03 | 修复后复核通过：补审后强制从最新投影验证全等 ref，未进展立即 failed |
| C27-16 | 既有“mid-read”测试只在 pre/post 两次完整采样之间改写文件，未覆盖单次打开句柄后路径被 ABA 替换的身份错位防线 | U27-05 | 修复后复核通过：确定性 handle-open 后 ABA 用例证明替换字节被丢弃，orchestrator 10/10 |
| C27-17 | publication 失败仍以裸 rejection 跨越原任务准入等待，失败先发生时可形成未处理拒绝，且没有文档已冻结的显式 `failed` 终态 | U27-08 | 修复后复核通过：task 产生处把 rejection 收敛为 failed；owner-services 构建与 server 2/2 通过 |
| C27-18 | 确认事件只校验 requirement/failure id，重复 criterion id 可进入权威日志并让裁判覆盖集合把两条标准压成一条 | U27-07 | 修复后复核通过：确认版三组 id 共用唯一谓词，core codec/guard 11/11、类型与构建通过 |

## U27-01～U27-09 专项与冷启动对抗记录

> 专项行按固定矩阵逐项从当前源码重建；四路冷启动行仅在九项专项全部完成后填写。当前共同冻结基线为 `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144`；每行事实、主动反例与结论均绑定该指纹。

| 编号 | 核查对象 | 当前源码事实与主动反例 | 结论 |
| ---- | -------- | ---------------------- | ---- |
| S27-01 | U27-01 确认内容守卫 | 生成规范化、matched asset 转换与最终 seal 均调用同一 id 唯一性谓词；重复、空白、折叠/截断碰撞在确认事实前拒绝，`pc-N` 仍按原顺序生成。 | 专项通过；绑定当前冻结指纹 |
| S27-02 | U27-02 确认—准入耐久义务 | `rubric_confirmed`、两类 store 入口与 codec 均强制完整 admission intent；guard 反绑任务摘要与 surface，在线及恢复按原身份调用既有耐久准入，只有确定拒绝取消，暂态/结果不明保留 pending。确认后、准入响应丢失及结清前崩溃均可 exact replay。 | 专项通过；绑定当前冻结指纹 |
| S27-08 | U27-08 独立保存反馈 | publication 使用既有稳定键/CAS；task 在产生处把 rejection 收敛为显式 failed，RPC 先完成原任务准入再消费 saved/deferred/failed。保存失败、先完成或响应丢失均不取消 active/run，也未新增通用 outbox。 | C27-17 修复后专项通过；绑定当前冻结指纹 |
| S27-03 | U27-03 accepted-run 连续前缀 | 恢复从 admission 结清 runId 向后分页扫描，按全等 `runRecordRef` 取最早缺口；下界判定先于当轮上界过滤，deferred/failed/异常阻断后序，补审后必须从最新权威投影证明全等 review 已落盘。乱序 review、首 run 被上界遮蔽及同索引错 ref 空转均 fail-closed。 | C27-14、C27-15 修复后专项通过；绑定当前冻结指纹 |
| S27-09 | U27-09 启动恢复隔离 | `recoverAllOpenSessions` 在逐 conversation 边界把任意 reject 转成 failed 结果并继续；会话内部仍由 U27-03 fail-closed，生产组合根在接入监听前装配并执行同一恢复入口。坏日志、坏投影或定向 resume 均不改变其他会话所有权。 | 专项通过；绑定当前冻结指纹 |
| S27-04 | U27-04 evidence generation 与租约代际 | 权威投影按 run 保留 `generation+lastAttempt`；requestId、root/child workload、pending/result/settled 共享完整代际，同代仅严格 `lastAttempt+1`，新代必须先无旧 pending。旧 terminal outcome 可按原 request 消费，released 根不会被同身份复活。 | C27-11 修复后专项通过；绑定当前冻结指纹 |
| S27-06 | U27-06 child 租约交接 | `acquireChild` 后由 coordinator 局部 scope 持有，构造或权威 request 写失败立即复用 `finishLease`；调用 `#dispatch` 是唯一交接点，进入后只由其 finally 子先父后终结，外层不双清理。 | 专项通过；绑定当前冻结指纹 |
| S27-05 | U27-05 真实取证路径与规范承诺 | 每个声明路径先 canonical 判界，再打开 canonical 文件；单次读取用句柄前后 fstat 与读取后 realpath/stat 反绑，身份或内容快照变化丢弃 bytes 并 typed-stale。多文件按请求顺序 JCS 编码 path/state/length/digest，缺失与字节迁移无碰撞。 | C27-16 修复后专项通过；绑定当前冻结指纹 |
| S27-07 | U27-07 codec 与领域门禁 | 文件写入和容错重放共用严格 codec + batch guard；确认版三组 id、review/run 身份、proxy 全绑定、evidence 请求/结果/结算及复合终态均在 reducer/裁判前校验。主动构造未知字段、错类型、重复 criterion/review、错绑 proxy/evidence 均拒绝。 | C27-12、C27-18 修复后专项通过；绑定当前冻结指纹 |
| A27-01 | 冷启动角色一：Rubric 草案与确认—准入恢复 | 从“第一次 run 前一次确认、确认快照不可变、原任务立即耐久准入”重新反推：生成、修订、库匹配及 seal 共用确认内容守卫；确认提交原子携带完整 admission intent，任务正文仍只有会话原事实。重复/折叠碰撞零确认，异 principal、异载荷和错摘要零准入；确认后、准入响应丢失、结清前崩溃均以原 turnId/surface/origin exact replay，暂态或结果不明不误取消；断线与停机无需在线 surface，生产启动在 ingress 前装配 recovery 与 original-task port。全局保存 task 在产生处收敛 saved/deferred/failed，准入优先且保存失败不回滚。 | 对抗通过；无新增反证 |
| A27-02 | 冷启动角色二：accepted-run 连续验收与 evidence generation/租约收敛 | 从“原任务 admitted runId 是下界、accepted 减全等 reviewed 的最早缺口”重建：较早 deferred/failed、错 ref、同索引异 review 与下界不可见均阻断后序；补审没有耐久进展立即 fail-closed，坏 conversation 只产生该项 failed 并继续健康项。取证按 run 耐久保留 generation+lastAttempt，root/child/requestId/pending/result/settled 同域绑定；同代重放、typed-stale 严格下一 attempt、跨代与 terminal bundle 重启均无身份复活或重复副作用。child 在 dispatch 前由 coordinator 持有，交接后只由 dispatch finally 终结；暂态、停机和崩溃保留可重驱欠账。 | 对抗通过；无新增反证 |
| A27-03 | 冷启动角色三：取证路径真实性与事件防御边界 | 从“只读一级取证只能承诺实际授权句柄所见事实”重建：请求先验签并反绑 executor/workspace/revision/lease，journal 同 requestId 全等回放、异载荷拒绝；当前单 owner 边界内 exact replay 合法，AuthorityTransfer 前提仍由 X27-03 排除。log/artifact 的 canonical 判界、打开句柄前后 fstat 与读后 realpath/stat 共同封住 symlink、ABA、读取中替换；JCS path/state/length/digest 帧消除缺失与字节迁移碰撞。codec/guard 在 reducer 前拒绝未知字段、重复 contract/review 身份、错绑 proxy、request/digest/index、result/settlement 及终态不一致；能力缺失诚实返回 gap/stale，不把执行侧自述升级为独立证据。 | 对抗通过；无新增反证 |
| A27-04 | 冷启动角色四：子租约清理、保存反馈与启动恢复 | 从资源与恢复 owner 反推：child 签发到 `#dispatch` 调用是唯一责任交接，request 构造/权威写失败即时 finish，dispatch 后 reserve/consume/settle/release 只执行一套且子先父后；重复清理由既有资源原语幂等。Rubric 保存沿既有稳定 draft/persistence requestId 与 CAS，失败在 task 产生处转显式终态，RPC 先准入再返回真实反馈；保存的半提交、响应丢失或重复 publish 不改变本任务 active/run，也不要求通用 outbox。启动恢复在监听前装配，逐 conversation 隔离坏日志/坏投影并继续；awaiting 状态只由 resume 重建确认面，不属于主动恢复扫描。 | 对抗通过；无新增反证 |
| D27-01 | 历轮反证差异审计 | 机械取 S27-01～S27-09、A27-01～A27-04 与 C27-01～C27-18 并集逐条核对：C27-01～08、10～18 均保留原归属并由当前源码和对应矩阵证明修复后通过；C27-09 由“先准入、后反馈”的当前生产顺序证伪旧方案。四个角色没有让任何历轮发现因后轮数量更少而消失，九项直接交界均已双向覆盖。 | 通过；零未处置反证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| X27-01 | 原 P27-05 把 `evidenceCapabilities` 解释为“当前 workspace/Git 一定可用”，据此评为 P1、中并要求新建 runtime capability snapshot producer；权威合同与生产实现证明字段只声明 executor 稳定 provider kind，具体 Git、workspace 与 locator 前提均在 EvidenceRequest 处理时核对，失败以 `capability-gap` 诚实退出。 | selector 按签名 provider kind 选择而非某次 Git 状态；不存在“虚假能力”根因或当前用户损失。该裁决仅适用于当前稳定 provider-kind + 请求级前提模型；新增 snapshot producer会制造第二语义和无必要基础设施。 | 第 27 单元独立审查价值裁决；当前交付指纹 `git-delivery-manifest-v1:b4ee0dc42c08770608a6270c6f62e3eb517e9ccc6a8b1fb3cb82f82f1b01a176`；IR27-06、IR27-16、IR27-29、IR27-43。 | 生产 descriptor 宣告实际未装配的 provider kind；handler 对前提缺失伪造成功；或 selector 对同一 capability-gap 形成无界重选。 | 已排除 |
| X27-02 | 原 NB27-02 把 `GlobalRubricCatalog.listForMatching` 加载索引内全部 Rubric 正文视为当前性能问题，并建议扩展 index metadata。已核实当前小库功能正确，没有真实规模、延迟、I/O 压力或用户体验损失证据；理论线性增长不能单独成立为缺陷或未来开发任务。 | 第 27 单元及当前最小完整产品不实施 catalog metadata、惰性候选加载、benchmark 或通用缓存设施；本记录只排除无生产损失依据的推测性优化，不替代未来基于真实故障的新裁决。 | 第 27 单元独立审查价值裁决；当前交付指纹 `git-delivery-manifest-v1:b4ee0dc42c08770608a6270c6f62e3eb517e9ccc6a8b1fb3cb82f82f1b01a176`；IR27-26、IR27-35。 | 受支持的真实 Rubric 库规模产生可复现的准入延迟或 I/O 压力，并达到破坏既定交互体验的事实阈值；触发后按当时实现与数据重新登记问题，不复用原评级或方案。 | 已排除 |
| X27-03 | 原 NB27-05 认为 EvidenceRequest handler 在 exact replay 后才调用可选 `authorizeOwner`、且 local / mesh 生产组合根未注入 verifier，会让旧 owner 当前越权回放。已核实第 27 单元只有 owner lock 约束的单锚点 owner，mesh 只接受已配对锚点设备，没有同一 conversation 的第二 current owner 可达，当前失败前提不成立。 | 第 27 单元不提前建设尚不存在的 current-owner authority 投影。AuthorityTransfer 启用后的确定义务已写入全局 `specification.md` §5.7 和第 32 单元执行计划：届时 verifier 必须在 journal exact replay 前执行，local / mesh 零旁路。该未来义务不依赖本单元文件提醒。 | 当前生产调用图、owner lock 与 mesh 配对边界；当前交付指纹 `git-delivery-manifest-v1:b4ee0dc42c08770608a6270c6f62e3eb517e9ccc6a8b1fb3cb82f82f1b01a176`；全局 `specification.md` §5.7、第 32 单元计划；IR27-18、IR27-30、IR27-42、IR27-43。 | 第 32 单元之前出现同一 conversation 的旧/新 owner、任意同 deviceId 并行 owner 或其他第二 current-owner 可达路径时，在发生变化的当前单元重开；按计划进入第 32 单元时直接执行全局规格，不重开第 27 单元。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V27-01 | U27-01、U27-02、U27-03、U27-07 的 core 契约、事件、领域门禁、文件日志写入与重放成立 | core advancement 目录 Vitest；最近变化的 codec/guard 定向 Vitest；core `tsc --noEmit`；core build | core advancement 的 23 个当前交付路径及直接构建产物 | 受影响验证 / 低 | 原目录 8 文件 72/72；C27-18 后 codec/guard 2 文件 11/11；当前类型与构建通过。写入与重放共用严格谓词，确认三组 id 与有限跨事件绑定均在 reducer 前拒绝 | `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144` | 有效 |
| V27-02 | U27-04～U27-06 的 generation、租约交接、句柄绑定及直接消费者回归成立 | owner-services evidence、orchestrator executor-evidence、owner-kernel session adapter 定向 Vitest；相关包类型/构建 | owner-services、orchestrator、owner-kernel 的 evidence/controller/session-store 当前输入 | 受影响验证 / 低 | owner-services 6/6、orchestrator 10/10、owner-kernel 9/9；相关类型通过，C27-17 后 owner-services 构建通过。terminal bundle 复用、pre-dispatch 清理与 handle-open 后 ABA 均有直接证据 | `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144` | 有效 |
| V27-03 | U27-02、U27-03、U27-08、U27-09 的 RPC、恢复枚举、真实保存反馈与坏会话隔离成立 | server advancement/recovery 与 session RPC Vitest；CLI advancement maintenance 定向 Vitest；owner-services build | server advancement/RPC、CLI recovery/production assembly 的当前输入及 core、owner-services 最新构建产物 | 受影响验证 / 低 | server advancement 原 50/50，C27-15 后 recovery 27/27，C27-17 后保存 deferred/failed 2/2；session RPC 原 76/76、CLI advancement/运行时 35/35，owner-services 当前构建通过。server/CLI 类型仅保留验证手册既有基线 | `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144` | 有效 |
| V27-04 | 当前冻结交付物的格式、补丁卫生与可重复范围指纹成立 | Biome 当前变更 TS；`git diff --check HEAD`；`unit-delivery-manifest.mjs --base d4cce198` | 37 个变更 TS 与 85 路径完整交付闭包 | 冻结准备 / 低 | Biome 37 文件零问题；diff-check 通过；85 路径、零删除，分组和为 85，路径集 SHA-256 `5673c4238b492011e353aa6bfc8678bf79cdffc1e3086c0d36b3830af6ddf2f3` | `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144` | 有效 |
| V27-05 | 九项专项功能审查、四路冷启动对抗与历轮反证差异审计闭合 | S27-01～S27-09；A27-01～A27-04；D27-01 | U27-01～U27-09 全部固定矩阵、C27-01～C27-18 及四组直接交界 | 专项收口 / 低 | 九项逐项从权威合同与当前源码重建；四角色覆盖重复、错绑、半提交、暂态/不明、断线/停机、崩溃恢复、路径替换、代际竞争和装配缺失；C27-01～18 全部有当前处置，零未处置反证 | `git-delivery-manifest-v1:9df97c419e0898708bbc81252d8791c90e9b91a0c72ee5c683983a8e8e373144` | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-27.gen-1 -->
