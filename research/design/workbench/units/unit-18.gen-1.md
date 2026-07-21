# 单元登记:第 18 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:18
- **generation**:1
- **登记时间**:2026-07-20
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 18 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、分片账本、九类核查面行、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U18-22～24 三次修复闭合并重冻结（51 文件 `aa8fd95d…5e57`）；两轮冻结终审零新增，最终验证于同一未修改交付物全部通过——单元完成
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是
- **交付物文件集**:51 个业务与架构文件（含结构 golden；工作台文件不计入交付指纹）
- **当前交付物指纹**:`aa8fd95d7896b982aae3162e369cc92b2c09e083c380190cd96d234879175e57`（`SHA256(UTF8(sorted(path<TAB>SHA256(file-bytes)<LF>)))`）
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的 S4 资源治理边界与 `research/design/modules/distributed-runtime/specification.md` 第 18 单元、资源治理规格及不变量 18

## 固定边界

- **功能范围**:落地 anchor/executor 双半边 ResourceGovernor、根/子租约、WDRR、consume/settle/release/reclaim、delegation 与 UsageReport 连续水位；将当前全部工作入口接入治理；以同一签发端口替换过渡资源签发器
- **架构不变量**:签名候选不等于激活；预算逐维不超卖；父子租约层级、domain、audience 与 delegation 封闭；usageId 全域幂等且 usageSeq 按根连续；终结动作单次幂等；正常终态不依赖过期回收；所有 workload 经过同一治理合同；进程内与未来 mesh 复用同一 guard
- **验收条件**:不变量 18 对抗矩阵、全部 workload kind、重复 usageId、超额、越 delegation、无水位 reclaim、WDRR 满载公平性、双拓扑与崩溃恢复测试通过；过渡资源签发器零残留
- **必要上下游**:core contracts/protocol/authority/commit-log、owner conversation/job journal、executor ledger/runtime、orchestrator 派生 workload、CLI composition root、第 17 单元能力与权限守卫
- **明确不属于本单元**:第 19～20 单元 mesh adapter 与跨机业务控制面；第 21～24 单元数据面票据；第 25～29 单元尚未生产接入的环境、scheduler、advancement 与取证产品闭环；第 30 单元本地域 owner 产品装配

## 审查分片

- **是否启用**:是
- **决定依据**:资源合同横跨共享协议、anchor/executor 耐久账本、全部工作入口和恢复终结，且预算、层级、幂等、公平、跨域对账为正交正确性维度
- **完整单元与跨切片必审项**:候选→激活→消费→对账→终结全链；父子额度守恒；assignment/system-job 与 governor 同 envelope；所有工作入口不可绕过；恢复后 WDRR、usage 水位与终结状态不漂移

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |
| S18-A 共享资源合同 | ResourceLease/GovernorRecord/UsageReport 的封闭校验、预算运算、激活与层级谓词 | HEAD `5fea5a8` | 冻结终审 | 100% | 已封版 | 合同枚举、字段封闭、预算与层级谓词均单源；污染矩阵及最终验证通过。 |
| S18-B anchor governor | WDRR、根租约候选与激活、consume/终结、UsageReport intake、水位恢复 | S18-A | 冻结终审 | 100% | 已封版 | anchor 准入、排队、公平、计量、终结与恢复合同闭合；非法输入零副作用。 |
| S18-C executor governor | delegation 子租约、本机容量、扣账、防超卖、UsageReport 生成 | S18-A～B | 冻结终审 | 100% | 已封版 | executor 准入、容量、delegation、计量与失败终结合同闭合；双半边对账通过。 |
| S18-D 生产接入 | conversation/job/system 与当前 control/orchestration 入口；同端口替换过渡签发器 | S18-A～C | 冻结终审 | 100% | 已封版 | 当前模型及工作入口全部经治理面，meter 全链透传，过渡签发器零残留。 |
| S18-E 恢复与对抗验收 | 全 workload、双拓扑、崩溃、重放、公平性及过渡路径清零 | S18-A～D | 冻结终审 | 100% | 已封版 | 跨切片横向审查、两轮冻结终审及 V18-17 最终验证均通过；结论绑定 `aa8fd95d…5e57`。 |

### 完整单元横向审查记录

> 启用分片时每轮必填;默认消费封版信息包,有疑问可下钻细节,确认问题或结论失效时重开切片。

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |
| 1 | 当前 33 文件业务闭包 | 根/子租约、候选与激活、连续消费、终结、所有生产入口及恢复链 | 重开 S18-B～E：queued 终态缺精确 dequeue、历史 assignment 兼容与前置终态资源语义 | 问题集中修复并通过直接回归 |
| 2 | 修复后同一业务闭包 | 跨片身份链、同 envelope 伴随、失败终态、旧日志、组合根与测试观测 | 无新增；CLI 日志分离测试观测已校正 | 横向审查与最终构建通过，交付冻结 |
| 3 | 指纹 `2a2c37f6…73ea2` | 双半边失败/过期终结、响应丢失重放、跨设备租约时间 | 重开 S18-B～E：U18-07～09 | 独立终审未通过，待集中修复 |
| 4 | 同一指纹与完整 33 文件业务闭包 | 历史租约全部消费者、资源端口×方法注册表、workload attempt 跨代身份 | 重开 S18-A～E：U18-04、U18-10～11 | 补充独立审查未通过，新增问题已一次性登记 |
| 5 | 同一指纹与完整 33 文件业务闭包 | 本地域根租约变体、签发域与 delegation 深度边界 | 重开 S18-A、S18-C、S18-E：U18-12 | 补充独立审查未通过，新增问题已登记 |
| 6 | 指纹 `49e52595…d0df` 的 37 文件业务闭包 | 方法×端口×principal、身份字段×记录×索引、兼容判据×生产端×full/guard、失败终态全部消费者及耐久时间恢复 | U18-11 的 specification 类型示例仍丢失 attempt；已在同一问题内补齐 | 修复改变交付物，终审结论归零并重冻结 |
| 7 | 指纹 `a8a030b2…5f84` 的 37 文件业务闭包 | U18-11 实现、记录、索引、测试与 specification 的完整 attempt 身份 | 无；旧 `(kind,id)` 声明零残留 | 完整横向审查通过，重新进入冻结终审 |
| 8 | 同一指纹的时间与授权定向终审 | resource lease 与 assignment capability 的耐久接收时刻、进程内 deadline、重启和墙钟回拨 | U18-09 的 capability 资源守卫仍使用当前墙钟；已在同一问题内补齐 | 修复改变交付物，终审结论归零并重冻结 |
| 9 | 指纹 `343f1d6b…29df` 的 37 文件业务闭包 | 租约/capability 双 deadline、exact replay、失败终态、历史兼容及三张机械闭包 | 无；U18-04、U18-07～12 全部直接验证闭合 | 完整横向审查通过，重新进入冻结终审 |
| 10 | 指纹 `ca2145f1…dc6d` 的 37 文件业务闭包 | exact replay 静态授权、双半边过期恢复、运行时缓存与耐久投影生命周期、容量并发线性化 | 重开 S18-B～E：U18-07、U18-14～15；容量超卖疑点由 governor 串行协调器与事务内新鲜投影排除 | 补充独立终审未通过，真实问题已按根因一次登记 |
| 11 | U18-07、U18-14～15 修复后的当前业务闭包 | 双 governor 全方法的静态身份、耐久 acceptance、exact replay、在线活性、终态清退、启动/周期恢复及重放峰值空间 | 无新增问题；U18-14 补齐 preview 前授权和耐久 capId 接受事实，U18-15 将保留窗压缩前移到逐记录重放 | 根因闭包完成，进入冻结准备 |
| 12 | 指纹 `c45f5555…dbdf` 的安全与生命周期终审 | exact replay 保留窗、配置面与协议常量反向对账 | 重开 S18-B～C、S18-E：U18-15 允许任意缩短冻结的 27 天窗口 | 冻结终审未通过，按同一根因集中收口 |
| 13 | 指纹 `aae0661d…d336` 的提交前独立终审 | 候选公平准入的全部生产消费者、双 governor 耐久记录字段封闭 | 重开 S18-A～E：U18-16～17 | 独立终审未通过，待集中修复 |
| 14 | 指纹 `f8c8dfab…ae53` 的 U18-16～17 修复闭包 | 候选 pending 的端口等待、deadline 延期、queued 保留、system 恢复重驱；GovernorRecord 在线/preflight/双端重放字段封闭 | 无新增；两项根因均以共享原语收口并通过直接验证 | 集中修复完成，进入冻结准备 |
| 15 | 同一指纹的独立终审 | GovernorRecord 枚举值封闭、在线/preflight/双端重放与污染测试 | 重开 S18-A、S18-E：U18-18 | 独立终审未通过，待集中修复 |
| 16 | 同一指纹的补充独立终审 | 预算守恒、签发授权、原子伴随、过期终结所有权、双半边用量与业务恢复顺序 | 重开 S18-B、S18-D～E：U18-19；其余核查面无新增 | 补充独立终审未通过，过期回收与业务恢复的所有权冲突已一次登记 |
| 17 | 同一指纹的再次独立终审 | 根准入线性化、executor 硬容量竞争、专用租约变体、生产接线与测试盲区 | 重开 S18-A～E：U18-20～21；其余预算、计量、终结和当前生产接线无新增 | 再次独立终审未通过，根准入原子性与 system-job 签发合同已按同族闭合登记 |
| 18 | 指纹 `4f40ba8c…604b` 的 38 文件修复闭包 | 枚举/origin 封闭、业务根终结所有权、control 单事务准入与实际容量复验、system-job 专用变体及同类残留 | 无新增；U18-18～21 均由共享谓词、唯一线性化点和业务所有权边界根治 | 集中修复与横向核查完成，待独立终审 |
| 19 | 同一指纹的独立终审 | 当前全部模型调用入口、双 governor 准入前置条件与资源租约枚举单源 | 重开 S18-A～E：U18-22～24 | 独立终审未通过；三项均为 U18-02、U18-16/U18-20、U18-18 的未闭合影响面 |
| 20 | U18-22～24 修复后的当前业务闭包 | 全入口治理注册表、双半边前置验证与失败出队分类、枚举单源与污染矩阵、meter 全链透传（durable/recovered/allocation/编排/子 agent） | 无新增；背压保留 queued 由既有用例锁定 | 集中修复完成并通过合并直接验证，进入冻结准备 |
| 21（冻结终审一） | 指纹 `7073845f…5ea9` 的 48 文件闭包 | 需求逐条对照、治理注册表、双半边前置验证、charter"全入口共用治理面"、模块边界与 spec 计量合同 | 同轮收口三处：llmComplete 治理缺失时 fail-closed（禁静默直通）、contracts 值导出 RESOURCE_WORKLOAD_KINDS、recovered meter 与 executor 过期出队补断言 | 通过（1/2） |
| 22（冻结终审二） | 同一指纹独立复审 | 并发（独立 work/闭包 meter 无共享态）、崩溃（control 根 reclaim 兜底、usage-reserved 保守收束）、ALS 作用域嵌套恢复、注册表 allowlist 逐文件核透传性质、测试盲区 | 无新增 | 通过（2/2） |
| 23（最终指纹复核） | 指纹 `68051709…f9cf` 的 49 文件（结构 golden 终审后确定性派生同步入集） | golden 差异逐项审阅：仅既有包边引用计数增长，无新包边、无环、无拓扑变化；两轮终审全部裁决对象（代码语义）未变，结论保持 | 无新增 | 通过 |
| 24 | U18-22～23 二次修复闭包（指纹 `bc56d0ca…5451`） | advancement 全部外调（rubric 草案/修订、准入、收场、裁判、摘要）经 governed roles/provider 单点接治理（每次 chat=独立 advancement 类 control 工作，真流式、提前中断同样收束）；注册表扩至 createXxxCallLLM/provider.chat 真实形态重扫零漏网；完整请求 validator（字段封闭+身份+scope+budget+requestId）双 governor prepare/acquire 接入 | 无新增；治理粒度决策：每次外调一个 control 根（比每逻辑工作更细，预算/公平/终结语义等价，charter“各用独立 reservation”字面兼容） | 集中修复完成并通过合并直接验证，进入冻结终审 |
| 25（冻结终审一） | 指纹 `bc56d0ca…5451` 的 51 文件闭包 | U18-22/23 验收逐条对照：advancement 五类外调全经 governed roles 零旁路、注册表扩形态零漏网、完整 validator 字段封闭/身份/scope 对齐/requestId、生产 request 兼容（owner 180/executor 411） | 无新增；治理粒度（每外调一 control 根）与 charter 字面兼容并记录 | 通过（1/2） |
| 26（冻结终审二） | 同一指纹独立复审 | 流式提前中断收束、并发独立会话、lazy governor fail-closed、装配时序（惰性取值）、thinking/models 透传、白名单逐文件透传性质复核 | 无新增 | 通过（2/2） |
| 27（最终指纹复核） | 指纹 `0ff76261…7a68` 的 51 文件（结构 golden 终审后确定性派生同步入集） | golden 差异逐项审阅：仅三处既有包边引用计数、无新包边无环；两轮终审裁决对象（代码语义）未变，结论保持 | 无新增 | 通过 |
| 28 | U18-22/23 三次修复闭包（指纹 `aa8fd95d…5e57`，51 文件） | 注册表改行级计数预算制：每个含调用形态的文件登记命中数与治理性质，多/少双向失配即失败、未登记文件命中即失败——文件级豁免的旁路盲区封死；enqueueRoot（耐久写）与 prepare×2 补 requestId+deadlineAt 前置，双半边八处 context 验证统一先于一切副作用；非法 context 零日志用例双半边 | 无新增；计数制边界记录：静态扫描无法防御全新调用形态别名，治理标记存在性+计数双闸是机械可行最强 | 集中修复完成，进入冻结终审 |
| 29（冻结终审一） | 同指纹 51 文件闭包 | 计数预算表与实际命中逐文件对账（9 文件 22 命中）、八处 context 前置顺序、非法 context 零日志、生产 ctx 兼容（定向 19/20） | 无新增 | 通过（1/2） |
| 30（冻结终审二） | 同一指纹独立复审 | 计数制双向失配语义、验证性 deadline 调用零副作用、CALL_PATTERN_ALL 全局标志计数正确性、X18-01 基线边界复核（messaging/model.ts 同族） | 无新增 | 通过（2/2） |

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core 资源 contracts/protocol/authority 与测试 | 公共导出、判别联合、预算谓词和 specification 同步 | contracts 单源枚举与派生集合；等待器首查 deadline；core 定向 20/20 | 通过 |
| owner-kernel governor、conversation/job 接入与测试 | assignment authority 导出、伴随流、历史重放兼容 | 单源前置验证先于入队；非法零日志、过期精确出队；定向 19/19 | 通过 |
| executor governor、ledger 与测试 | 公共导出、assignment 资源投影和 UsageReport | 单源前置验证先于入队；非法零日志、过期精确出队；定向 19/19 | 通过 |
| orchestrator、runtime-host、CLI 生产装配与测试 | provider 调用、子 agent、组合根和日志观测 | meter 全链透传+control 治理边界+注册表机械证明；定向与组合根测试通过 | 通过 |
| specification | 候选、WDRR、预占、连续计量、终态和恢复合同 | 专用 origin、control 单事务激活与业务根单一终结权已同步实现 | 通过 |
| lockfile、依赖边、RPC schema 与结构 golden | 未新增依赖、包边或外部 RPC schema | diff 枚举；无对应变化 | 不适用:无派生变化 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| 根租约准入与激活 | 所属域 governor 流 + assignment/system fence | reserve 与归属事实同 CommitEnvelope；control 出队即原子 reserve | 排队、候选签发、响应丢失、deadline 延期、容量竞争、原子提交前后 | governor、owner journal、executor guard、恢复入口 | deadline 与完整请求校验先于一切准入副作用；常数校验、fail-closed | 通过 |
| 子租约与 delegation | executor 本地 governor 流 | child reserve fsync | 父校验、额度扣减、签发前后 | orchestrator、executor guard、usage reporter | 深度与额度有界；父剩余量守恒 | 通过 |
| 资源消费 | governor consume 记录 | usageId 首次追加 | 外部调用前后、重复上报、并发扣账 | runtime/provider/executor、anchor intake | 全部生产模型调用经 meter 预占/consume 或 control 治理边界，注册表机械锁定 | 通过 |
| 租约终结 | settle/release/reclaim/dequeue 记录 | 对应终态同 envelope 或 governor 单次事务 | queued/active 终态、响应丢失、过期、恢复 | owner/system/control/orchestration、governor | 子先父后与重复扫描幂等；业务归属根由业务恢复独占终结，通用扫描仅处理 control/孤儿资源 | 通过 |
| 公平准入 | governor queued/reserve 流 | WDRR dequeue + reserve | 多类同时入队、重启、取消 | 所有可信入口、anchor governor | 全部当前入口入队治理；过期首查出局、非法零副作用、失败精确出队、背压保留重试 | 通过 |
| GovernorRecord 重放 | governor 流原始正文 | 单一 `validateGovernorRecord` 后进入 reducer | 未知判别、字段增删、嵌套污染、双端冷启动 | 在线 preflight、anchor/executor full replay | 判别联合、枚举与字段集合封闭；合法记录确定性重放，污染记录 fail-closed | 通过 |
| UsageReport 对账 | executor governor 流与所属域 governor 水位 | 无缺口批次 intake fsync | 报告丢失、乱序、重复、重启 | executor reporter、usage-reporter guard、anchor intake | 按根连续且重复 usageId 零重记；业务恢复先收束双半边用量再终结根 | 通过 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 架构 | 第 18 单元 | 状态 | queued/reserved/consumed/settled/released/reclaimed | 通过:判别封闭、转移与伴随谓词已核对 | 通过:全状态、保留窗与迁移合同闭合 | 通过:重放状态与窗内/窗外语义无分叉 |
| 架构 | 第 18 单元 | 入口与生产端 | run/job/control/orchestration/evidence | 通过:当前生产入口统一治理 | 通过:当前入口、组合根及双半边恢复接线闭合 | 通过:治理注册表机械证明全部生产入口治理或显式后置 |
| 架构 | 第 18 单元 | 消费端与继承面 | owner/executor/provider/runtime | 通过:双半边与 provider 调用接缝闭合 | 通过:双 governor 与运行时消费者语义一致 | 通过:durable/recovered 双适配器透传 metering；control 调用经 acquireRoot 治理边界 |
| 架构 | 第 18 单元 | 生命周期 | root/child/usage/terminal | 通过:候选、激活、连续计量和终结闭合 | 通过:候选至终态、恢复及窗外清退闭合 | 通过:业务根终结所有权与 control 单事务准入闭合 |
| 架构 | 第 18 单元 | 并发与崩溃点 | WDRR、额度、提交与对账 | 通过:原子 envelope、幂等与水位测试 | 通过:线性化、响应丢失和保守收束复核通过 | 通过:等待器首次及每次 attempt 前检查单调 deadline |
| 架构 | 第 18 单元 | 异常路径与终态 | 超额、断线、无水位与回收 | 通过:fail-closed、flush 与精确墓碑 | 通过:失败、过期、迟到与重复恢复闭合 | 通过:单源前置验证先于入队，非法请求零日志零候选零队列项 |
| 架构 | 第 18 单元 | 安全边界 | domain/audience/delegation/签名 | 通过:域、受众、层级和签名封闭 | 通过:架构与实现安全边界一致 | 通过:contracts 单源枚举，私有副本零残留 |
| 架构 | 第 18 单元 | 模块边界 | 18/19/26/30 | 通过:仅落当前生产入口与预留端口 | 通过:未越界实现后续 mesh 或产品接入 | 通过:无后续单元实现或第二套治理路径 |
| 架构 | 第 18 单元 | 测试与验收 | 不变量 18 与双拓扑 | 通过:定向、包级与跨包证据闭合 | 通过:直接证据覆盖当前修复闭包 | 通过:注册表、过期首查、非法零副作用与枚举污染矩阵测试全部落地（V18-13） |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U18-01 | queued 候选在签发后崩溃、取消或响应丢失时会阻塞队首。 | 候选零权，但其耐久队列身份缺少完整生命周期。 | 所有根准入、WDRR 恢复、取消、重试与公平性。 | 冻结候选身份、有效期、撤回/过期和激活竞争；在线端与 reducer 共用谓词，exact replay 返回同一候选。相关对抗测试通过。 | 已验证 |
| U18-02 | provider 只在成功汇总时记账，错误、abort、重试和子 agent 可能漏计或先外调后超额。 | 连续资源治理未接到真实模型调用线性化点。 | 主/子 agent、重试、部分响应、异常终结、UsageReport。 | 统一运行时资源上下文；每次外调前 guard、响应后稳定 usageId consume，所有退出先 flush 再终结。直接与包级测试通过。 | 已验证 |
| U18-03 | queued assignment 进入取消、失败等终态时，部分生产路径未写精确 governor dequeue，且 job envelope 未允许 governor 伴随流。 | 终态墓碑合同只在 reducer 守卫，未枚举全部生产端与 envelope 流白名单。 | conversation/job/control 终态、重放、WDRR 队首与 executor guard。 | 单源生成并断言 queued terminal dequeue，接入全部生产端并允许 governor 伴随流；两域直接测试及 executor 全测通过。 | 已验证 |
| U18-04 | 第 18 单元前的租约使用 `reservation-…`，新租约使用 `reservation:…`；executor receipt 与 job 已按此前缀分类，但 conversation owner 的 usageFinal/terminal 生产与 full/guard 重放未分类，配置 governor 后会把既有 committed/cancelled 日志判坏；executor 取消还在分类前无条件调用 governor `usageFinal`，旧在途 assignment 无资源根而失败。 | 兼容判据只接入部分消费者，未沿历史 assignment 的生产、终结与两类重放端完整闭合。 | 历史 conversation 已终结日志、在途 conversation/job 的 abort/cancel/supersede、executor 恢复、滚动升级和后续 local-owner 装配。 | 单源化 `requiresFormalResourceCoordination`，conversation/job、owner/executor 的 usageFinal、terminal、full/guard reducer 全部先分类；旧租约保持原零用量/零 governor 伴随语义，新租约缺 coordinator/root 必须 fail-closed。覆盖旧 committed/cancelled 冷启动与旧在途四类终结。 | 已验证 |
| U18-05 | 未收到 assignment 的 not-started 终结及 capability/lease 截止时间组合曾按单一在线假设处理。 | assignment 资源生命周期前态与多个权威截止时间未统一。 | pre-received 终态、迟到消息、abort、capability 与 resource lease。 | 仅在 received 后要求正式租约；运行截止取权威 capability 与 lease 的最早值，终态保持幂等。相关矩阵通过。 | 已验证 |
| U18-06 | CLI 运行时测试在 executor ledger 分离后仍从 authority log 查 assignment 记录。 | 测试观测面未随权威日志所有权变化更新。 | conversation protocol runtime 测试，不影响生产实现。 | owner 事实读取 authority log，executor assignment 事实读取 executor log；目标用例通过，CLI 包级其余证据保持有效。 | 已验证 |
| U18-07 | executor 已有 `reclaimExpired()` 且由 CLI 恢复调用；锚点仅有单租约 `reclaim()`，生产恢复没有扫描锚点 governor。崩溃留下的锚点根/子租约会永久保持 active，`submitUsageReport` 还可继续接收其过期后的新用量。 | 失败终态虽已闭合，但过期恢复只实现 executor 半边；先前验收把“双半边启动与周期恢复”误判为已落地。 | conversation/user-job/system-job、锚点根/子租约、UsageReport intake、崩溃/重启、周期恢复与双 governor 对账。 | 由单一恢复所有者对双半边执行启动与周期扫描：保守消费未收束预占，子先于父关闭真正过期租约；锚点过期后拒绝新增用量、仅允许精确重放。覆盖崩溃重启、重复扫描、父子过期及迟到报告。 | 已验证 |
| U18-08 | `acquireChild/reserveUsage/consume/settle/release` 在识别既有耐久结果前先验 active 状态、租约期限和 capability；同请求跨过 expiry/terminal 会被拒绝，`settle→release→settle` 还会追加冗余记录。 | 新写授权与 durable replay 未分层，幂等键判断晚于瞬时状态判断。 | anchor/executor 两半边、全部资源操作、响应丢失、过期/吊销/终态后的 exact replay 与日志增长。 | 单源化资源调用分类：静态身份与耐久对象先验，exact replay 精确命中后零追加返回；仅 fresh 写要求 active lease/capability。以每个方法覆盖响应丢失跨 expiry、revocation、settle/release 和异载荷拒绝。 | 已验证 |
| U18-09 | executor 接收资源租约时只保存 owner 的 `issuedAt/expiry`，后续直接用本地墙钟校验；activation/receipt 未验证租约有效期，候选占用与等待也依赖可回拨墙钟。 | 资源租约未接入项目既有的“签发者时间换算本地单调 deadline”模型。 | anchor activation、executor receipt、assignment capability 资源守卫、候选 TTL、跨设备时钟偏差/回拨及未来 mesh。 | 接收时按签发者区间与允许偏差冻结本地剩余 TTL，以本地单调 deadline 驱动 resource/capability 守卫与候选占用；activation 在权威提交时拒绝无效租约，重放只验证耐久绑定。覆盖正负时钟偏差、墙钟回拨、延迟/过期 receipt 与重启。 | 已验证 |
| U18-10 | `ResourceReservationPort` 已公开 `reserveUsage`，但 specification、`AuthorityPortMethodId`、principal 方法矩阵和组合根 guard 均无对应方法，owner/executor 都借用 `reservation.consume` 授权；根候选必需的耐久 `enqueue/enqueueLocal` 又在端口与方法注册表之外，生产端只能依赖具体类并借用 prepare 权限。 | 实现新增资源写操作时没有同步冻结端口、精确方法身份和权限矩阵，导致声明面与生效面分叉。 | anchor/executor 两半边、conversation/system/local-root 准入、外调预占、审计与最小权限、未来 mesh adapter 及端口替换测试。 | 将根入队与 usage 预占作为显式端口操作，分别赋予唯一 `AuthorityPortMethodId`；spec、类型联合、principal 矩阵、guard 和两半边实现共用同一方法注册表，禁止借用 prepare/consume 身份。自动生成端口方法×principal×实现对账并覆盖拒绝矩阵。 | 已验证 |
| U18-11 | `RootResourceWorkload` 明含 `attempt`，但 dequeue 记录、`rootResourceWorkloadKey`、queued/dequeued 索引都只保留 kind+id；attempt 1 的 queued 终态会永久阻断 attempt 2，且 dequeue 的“active”扫描未过滤已 released/reclaimed 的旧 reservation，会拒绝后继 attempt 的合法终态。 | workload 身份投影丢失 attempt，并把历史终态 reservation 误作当前 active。 | conversation/user-job/system-job 重派、queued 终态墓碑、迟到 enqueue、WDRR 恢复和跨 attempt 竞争。 | dequeue 与全部 workload 索引使用 `(kind,id,attempt)` 完整身份；active 冲突仅检查同 attempt 且状态 active/settled 的当前 reservation，历史终态不阻断后继。覆盖 attempt1 dequeue→attempt2 准入、attempt1 released→attempt2 dequeue、迟到 attempt1 与 exact replay。 | 已验证 |
| U18-12 | executor 的 `prepareAssignmentRoot<E>` 对 `job` 也会签发 local-domain 根租约，但 `JobAssignmentLease` 与 validator 明确要求 job 根属于 anchor；同一实现给 local conversation 根写入 `delegation.maxDepth=1`，而 reducer 的 local 分支不检查该深度，故可继续签发孙级子租约。 | 本地域 governor 复用通用端口时，没有封闭“允许的根租约变体”并统一执行已签入 lease 的 delegation 约束。 | 本地域 conversation 根签发、错误 job 调用、子租约层级、双拓扑 contract conformance 与后续 local-owner 装配。 | 本地域签发入口在排队/签名前拒绝不支持的 job 变体；local 根若不需要 delegation 则不签该字段，若签入则与 anchor 同源执行 executor、maxDepth、maxBudget 全部约束。补 local conversation 合法根、local job 拒绝、边界深度/越界深度及重放测试。 | 已验证 |
| U18-13 | CLI 包级全测中，协议运行时用例分别因候选占用窗过期、固定历史 run 时间触发 idle 回收，以及真实耐久 IO 超出各自 30/90 秒预算而失败；同文件隔离运行 18/18 通过。 | 同一组真实耐久集成测试分散继承生产瞬时时限、伪造陈旧业务时间并各自手写运行预算，使结论受包级调度耗时而非被测语义控制。 | authority runtime 测试装配、conversation 候选激活、会话回放和 CLI 包级可靠性；生产默认策略不受影响。 | 测试装配显式注入协议允许范围内的候选 TTL，run 记录使用本轮真实时间，并为该组重 IO 用例单源声明有界预算；保持生产默认值不变。目标文件与 CLI 包级全测稳定通过。 | 已验证 |
| U18-14 | anchor 与 executor 的资源调用包装器在 `preview.kind === "return"` 时直接返回，跳过 principal×method guard、capability 签名及 assignment/scope/executor 绑定；现有 exact replay 测试均复用原合法 context。 | durable replay 与 fresh 写的授权分层过度：正确跳过在线激活、吊销和 deadline 时，也错误跳过了不可豁免的静态调用身份。 | anchor/executor 两半边的 `acquireChild/reserveUsage/consume/settle/release`、响应丢失重放、未来 mesh adapter 与最小权限矩阵；`acquireChild` 还会向错误调用身份返回既有签名子租约。 | 单源拆分静态身份校验与在线活性校验：所有调用先验证 principal×method、凭证签名及 scope/assignment/executor/耐久 lease 绑定；exact replay 精确命中后仅豁免在线激活、吊销和 deadline 并零追加，fresh 写再执行完整活性校验。双端五方法覆盖错误 principal、伪造/异 capability、终态后原身份重放及异载荷拒绝。 | 已验证 |
| U18-15 | 双 governor 的 `capabilityDeadlines` 只增不删；耐久投影永久保留所有 reservation、usage、usage reservation 与终态墓碑，并在冷启动重放每条记录时深拷贝整个累计投影。长期运行内存随 assignment/调用总量无界增长，冷启动重放退化为平方级；首轮修复又把冻结的 27 天窗口暴露为任意正数配置。 | 资源状态只设计了写入与幂等，没有为运行时缓存、热投影和 27 天耐久保留窗建立统一生命周期、复杂度上界与单一权威。 | anchor/executor 双半边、能力 deadline、全部终态 reservation/usage、冷启动重放、长期常驻服务、配置面与日志保留/GC 接缝。 | 统一资源状态保留策略：能力 deadline 随所属根终结清退且不得因墙钟回拨复活；热投影只保留 active 状态、水位与冻结保留窗内幂等索引，终态按该窗口逐记录压缩/清退；重放使用事务隔离的单份可变候选，禁止逐记录复制累计投影；生产配置不得缩短协议窗口。以大量终态 assignment 验证投影有界、重放近线性及保留窗内 exact replay。 | 已验证 |
| U18-16 | 同 admission class 已有候选或当前请求尚未轮到时，`prepareAssignmentRoot/prepareSystemJobRoot` 抛 `ResourceAdmissionPendingError`；仅 `acquireRoot` 等待重试，conversation 与 system job 生产端均单次调用并把正常排队传播为执行失败。 | 候选层定义了瞬时 pending，却没有在资源端口与生产调度器之间建立单一的等待、延期和截止合同。 | conversation assignment、system job、未来 local assignment、同类/跨类并发、调用截止、恢复重驱与 WDRR 有界公平性。 | 在资源准入边界单源定义有界等待/延期语义，所有 prepare 消费端复用且不得把 pending 当业务失败；保持候选零权、稳定身份和原子激活。覆盖 conversation/system 同类及跨类并发、截止、恢复与候选响应丢失。 | 已验证 |
| U18-17 | owner/executor 重放把 governor 流正文直接断言为 `GovernorRecord`；公共 reducer 未校验 plain object、合法判别值与各分支精确顶层字段，额外字段会被静默接受并改变投影。 | 类型联合被误当作运行时协议验证器，耐久记录缺少双端共用的字段封闭入口。 | queued/dequeue/reserve/usage-reserved/consume/terminal 全记录类型、owner/executor 完整重放、preflight、日志损坏与协议演进。 | 建立单一 `validateGovernorRecord`，按判别联合精确校验对象、必选/可选字段及嵌套类型，owner/executor 在线、preflight 与重放共同调用；全部记录逐字段增删污染、未知判别值和合法边界测试通过。 | 已验证 |
| U18-18 | `validateGovernorRecord` 以 `admissionClass in DEFAULT_ADMISSION_WEIGHTS` 校验 queued 记录；普通对象原型链使 `constructor`、`toString` 等非法值通过并被断言为 `GovernorRecord`，直到 reducer 访问不存在的队列才失败；现有污染测试未覆盖非法 admissionClass。 | 枚举校验误用原型链成员判断，公共 validator 的返回合同与 TypeScript 判别联合不一致。 | queued 记录的在线校验、preflight、anchor/executor 重放、未来直接消费 validator 的适配器及污染测试。 | 使用封闭枚举集合或 own-property 判断并与 `AdmissionClass` 单源；validator 必须在进入 reducer 前拒绝全部非四种合法值。补四个合法边界、普通非法值及 `constructor`/`toString` 原型链污染测试，双端重放保持 fail-closed。 | 已验证 |
| U18-19 | `ConversationProtocolRuntime.recover()` 先依次调用 anchor/executor `reclaimExpired()`，之后才恢复 pending/active assignment；扫描器会把所有已激活根直接 `reclaim`。待派发 assignment 随后被 executor 以过期 lease 拒绝，但 owner 的 `assignment-superseded` 必须伴随 `release`，该前态已被 reclaim 破坏；`SystemJobResourceCoordinator.recover()` 同样只允许从 active 旧根原子写 `reclaim+reserve`，提前扫描后直接拒绝。若 executor 还有未上报用量，anchor 又会在业务 flush 前关闭根并拒绝新增报告。 | 通用资源过期扫描与 assignment/system-job 业务恢复同时拥有同一根租约的终结权，且恢复顺序把资源回收放在用量收敛和业务终态之前。 | conversation 待派发/运行中 assignment、user-job 同构路径、system-job 换代恢复、anchor/executor 双半边、UsageReport 迟报、崩溃重启与周期扫描。 | 终结所有权单一化：带 assignment/system-job activation 的根只能由对应业务恢复在同一权威事务中先收敛可证明用量并写业务终态/换代与资源终结；通用扫描仅回收无业务归属的 control/孤儿子资源，或只产出待收束候选，不得抢先改写业务根。覆盖待派发 lease 过期、started 后崩溃且本地有未报用量、system-job 过期换代、扫描与业务恢复竞争及重复恢复。 | 已验证 |
| U18-20 | anchor/executor 的 `acquireRoot` 都先在一次串行任务内生成候选，返回后再用第二次任务写 `reserve`，与规格“control 出队即原子 reserve、无候选阶段”相反。executor 仅在候选生成时检查 `maxActiveRoots`，实际 reserve 不复查；两任务间若 assignment receipt 激活另一根，`maxActiveRoots=1` 可落成两个 active 根。候选也可能在排队等待第二次任务时过期，已获准调用被错误 dequeue。 | 将需要第二个业务归属事实的 prepare 候选流程复用于应当即时激活的 control 根，把公平选择、硬容量判定和耐久 reserve 拆成多个可插入的线性化点。 | 双 governor `acquireRoot`、executor 本机硬容量、control/advancement 调用、公平队列、deadline/候选 TTL、响应丢失与未来端口消费者。 | control 根在同一 governor 串行事务中完成队首选择、请求/身份复验、executor 硬容量判定、签发和 `reserve` 追加；未轮到则继续有界等待，deadline 才精确 dequeue，已 reserve 的 exact replay 返回同一租约。覆盖 `maxActiveRoots=1` 下 control 与 assignment receipt 确定性交错、队列等待跨 TTL、双 governor 超时和响应丢失。 | 已验证 |
| U18-21 | `prepareSystemJobRoot` 只校验 origin 的 entry/class 自洽，不要求 scheduler-class；合法传入 interactive/advancement/orchestration origin 时会签发并返回相应 admissionClass 的 `SystemJobResourceLease`，但公共 `validateSystemJobResourceLease` 随后明确拒绝非 scheduler，故专用签发口能返回违反自身返回合同的签名对象。当前生产协调器硬编码 scheduler，仅避免了现行调用触发，并未闭合端口合同。 | system-job 专用变体约束只存在于下游 validator 和当前调用者，未冻结到返回类型、签发前运行时守卫与对抗测试。 | anchor `prepareSystemJobRoot`、通用 `ResourceReservationPort`、错误装配/未来 mesh adapter、system-job 队列占用、激活 preflight 与类型消费者。 | 单源定义 scheduler 专用 origin；`SystemJobResourceLease.admissionClass` 在类型层收窄为 `"scheduler"`，签发端在产生候选前运行同一谓词并 fail-closed。覆盖合法 scheduler、其余三类 origin 拒绝且零候选/零额外日志，以及签发结果通过公共 validator。 | 已验证 |
| U18-22 | 普通 conversation 执行已注入 `modelCallResourceMeter`，但 durable/recovered perspectives 适配器未透传该选项；当前 `llm.complete`、首轮命名/日志凝练和既有 advancement 调用仍直接调用 runtime/provider，生产代码中 `acquireRoot()` 零调用。 | U18-02 只闭合了主 conversation 调用栈，未以当前生产模型调用全集验收“全部工作入口接入治理”。 | perspectives 正常与恢复执行、当前 control/maintenance/advancement 调用、provider 重试、失败/abort/结果未知、预占/consume 与 control 根终结；第 27/28 单元新增产品协议仍按既定边界后置。 | 建立单一运行时资源执行边界：assigned work 的全部适配器强制透传同一 meter；当前独立 control work 先 `acquireRoot`，每次外调走稳定 usageId 的预占/消费，finally 内 settle+release。以当前生产调用注册表机械证明每个 provider 调用恰有治理落点或明确后置依据，并以真实组合根覆盖正常、恢复、失败和 abort。 | 已验证 |
| U18-23 | 双 governor 的共享等待器先执行 `attempt()`，仅在 pending 后检查 deadline，故已过期但立即可选的请求仍可获得候选或激活租约；`acquireRoot` 又在解析完整 deadline、校验 budget/request 前先耐久入队，非法请求失败后不会 dequeue，可留下阻塞队首。 | U18-16/U18-20 只闭合了 pending 重试与选择→reserve 原子性，没有把“全部前置条件先于任何调度/耐久副作用”纳入同一准入线性化合同。 | anchor/executor 的 prepare/acquire、立即可选与排队两态、非法 deadline/budget/请求结构、候选占用、WDRR 队首、重启恢复和响应丢失。 | 单源预验证完整 request/origin/budget/context，必须在 enqueue、candidate、reserve 前 fail-closed；共享等待器在首次及每次 attempt 前检查单调 deadline。只有可重试 pending 可保留业务队列，control 超时精确 dequeue，非法请求零日志零候选。双 governor 参数化覆盖 selected/pending 的 deadline 边界、非法字段、重启和队首不污染。 | 已验证 |
| U18-24 | `contracts/authorization.ts` 已导出权威 `ADMISSION_CLASSES`，但 `protocol/resource-lease.ts` 仍私有重写四个 admission class；同文件也单独手写 workload kind 集合。协议枚举演进时 validator 可与类型、governor reducer 分叉。 | U18-18 只把 GovernorRecord 校验改为枚举单源，未沿 ResourceLease 的全部运行时消费者扫描同一合同。 | ResourceLease 签发、公共 validator、owner/executor 接收与重放、未来 mesh adapter、admission/workload 枚举扩展及污染测试。 | 在 contracts 层单源导出 admission/workload 判别集合并由其派生联合类型；所有运行时 validator、reducer 和签发端复用同一集合，删除私有枚举副本。加结构扫描与逐枚举合法/非法测试，确保新增或删除判别值只能修改一处。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X18-01 | CLI 类型检查仍有 credential projection 既有基线错误。 | 错误文件与第 18 单元资源治理交付闭包无交集，本单元未新增同类错误。 | CLI `tsc --noEmit` 差异归因；受影响源码直接测试和包测通过。 | 本单元文件出现新增类型错误或 credential projection 进入当前交付边界。 | 已排除 |
| X18-02 | 子 agent 当前未在 orchestrator 生产路径调用 `acquireChild()`，而是继承父 run 的 `modelCallMetering`。 | 第 18 单元已交付子租约协议、额度与 delegation 守卫；编排节点改用父 run 子租约的产品接入明确归第 28 单元，本单元边界排除该接入。当前继承父计量，不存在无治理模型调用。 | 架构执行计划第 28 项；`packages/orchestrator/src/subagent/factory.ts` 的父计量继承；executor `acquireChild()` 实现与定向测试。 | 第 28 单元接入后仍未使用并终结子租约，或此前改动使子 agent 不再继承父计量并形成真实治理绕过。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L18-01 | U18-03；直接测试初次失败 | 跨包测试读取旧 `dist`，把构建产物陈旧误作源码逻辑问题。 | 跨包行为与源码不一致时，先按依赖方向刷新上游构建，再做最小复现；禁止在旧产物上反复改代码。 | 收口轮:core→owner 构建后真实缺口收敛为 companion stream。 |
| L18-02 | U18-03；生产端初审后 | reducer 已有守卫，但终态生产端和 envelope 白名单未按同一合同全集枚举。 | 修改伴随记录时，机械核对生成器、全部生产入口、envelope 白名单、full reducer、guard 与测试。 | 横向审查轮:conversation/job/control 与 executor 全覆盖。 |
| L18-03 | U18-06；CLI 包级验证 | 权威日志拆分后测试仍读取旧所有者，局部测试未覆盖真实组合根。 | 所有权迁移必须核对生产装配和测试观测源；包级失败先验证读的是哪本权威账本。 | 最终验证轮:唯一失败定位为 authority/executor log 分离。 |
| L18-04 | U18-04、U18-10～11；两轮终审通过后 | 审查验证了代表性路径，却未把兼容判据逐消费者展开，也未将端口方法和 workload 身份字段反向对账到全部索引。 | 资源协议变更必须机械生成三张闭包：方法×端口×principal、身份字段×记录×索引、兼容判据×生产端×full/guard reducer；任一缺格不得封版。 | 补充独立审查:重开历史兼容并发现方法注册表、attempt 身份两类分叉。 |
| L18-05 | U18-13；冻结终审两轮通过后的最终 CLI 包测 | 被测语义与测试环境的候选 TTL、idle 时钟及分散手写的测试预算共用隐式时间边界，包级负载改变了结论。 | 含短租约、idle 回收或真实耐久 IO 的集成测试，必须显式声明各自拥有的时间边界；同类重 IO 用例共用一个有界测试预算，禁止逐例追涨。 | 最终验证归因:候选 TTL、run 时间与该组重 IO 用例预算均已显式化；CLI 161/161 文件、2365/2365 项通过。 |
| L18-06 | U18-07、U18-14～15；冻结终审两轮通过后 | 只验证了代表性成功重放与 executor 回收，未把不可豁免授权、双半边恢复及状态保留上界作为同一生命周期矩阵机械核对。 | 资源协议终审必须对双 governor 全方法执行“静态身份→耐久重放→在线活性→终态清退→启动/周期恢复→空间与重放复杂度”矩阵；任一半边或阶段缺失不得封版。 | 补充独立终审:重开锚点恢复并收齐静态授权、缓存与投影上界；收口轮:补齐 preview 前静态授权、耐久 cap 接受事实、双半边生产恢复及逐记录保留窗压缩。 |
| L18-07 | U18-16；最终冻结终审两轮通过后 | 只验证候选与 WDRR 内部状态，没有把瞬时 pending 沿全部生产消费者追到调用截止、业务结果和恢复重驱。 | 每个瞬时协议结果必须机械对账“端口等待/延期→生产调用者→耐久状态→恢复所有者”；任一消费者会把可恢复状态写成业务失败不得封版。 | 提交前独立终审:发现 conversation/system prepare 单次消费；收口轮:共享有界等待与 typed 延期、queued 保留和 system 恢复重驱已闭合。 |
| L18-08 | U18-17；最终冻结终审两轮通过后 | TypeScript 判别联合被当作耐久输入验证，审查只核 reducer 语义而未污染运行时边界。 | 每个耐久联合必须以未知输入逐分支验证 plain object、判别值、精确字段和嵌套结构，并机械对账在线、preflight 与全部 replay 入口。 | 提交前独立终审:GovernorRecord 额外字段可进入投影；收口轮:共享 validator 与全分支污染矩阵闭合。 |
| L18-09 | U18-20～21；多轮根准入审查通过后 | 只验证候选签发与最终 reserve 各自正确，未把一次端口调用内的多次串行任务视为可竞争边界；专用返回类型又依赖调用者传入正确 origin。 | 每个“准入并激活”端口必须机械标出从选择到权威写入的唯一线性化点，并在实际写入点重验容量与变体；专用签发器的返回约束同时冻结在类型、生产端和公共 validator。 | 再次独立终审:双端 `acquireRoot` 任务间隙与 system-job 异类 origin 已一次收齐。 |
| L18-10 | U18-22；U18-02 已验证后 | 以主 conversation 调用栈代表“全部工作入口”，未把当前生产模型调用逐一登记并追到正常、恢复与失败路径的治理落点。 | 资源治理接入必须生成“生产模型调用入口×正常/恢复适配器×meter/control root×终结路径”注册表；无治理落点或明确后置依据不得封版。 | 提交前独立终审:perspectives 与当前 control/maintenance/advancement 绕过路径已一次收齐。 |
| L18-11 | U18-23；U18-16/U18-20 已验证后 | 只闭合了 pending 等待与选择→reserve 原子性，未验证无效或已过期请求在立即可选路径上也必须零副作用失败。 | 每个准入端口都要覆盖“合法/非法/过期×立即可选/排队”矩阵，并断言校验先于 enqueue、candidate、reserve，拒绝结果零日志、零候选、零队首污染。 | 提交前独立终审:双 governor 的 deadline 顺序与非法请求队列污染已一次收齐。 |
| L18-12 | U18-24；U18-18 已验证后 | 只修正 GovernorRecord 的枚举判断，没有沿同一协议枚举扫描下游 lease validator 与私有集合副本。 | 协议枚举变更必须对账“权威常量×派生联合类型×签发端×validator×reducer”，并以结构扫描证明非权威副本清零。 | 提交前独立终审:admission/workload kind 的私有副本已一次收齐。 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V18-01 | 共享资源合同、额度与层级谓词 | core 类型检查 + resource governor 定向测试及全测 | S18-A 直接源码与测试 | 开发 / 低 / 已执行 | 旧指纹证据；当前交付已变化 | `2a2c37f6…73ea2` | 失效 |
| V18-02 | anchor/executor 双半边、入口接入与恢复 | 受影响包类型检查 + governor/owner/executor 定向测试及全测 | S18-A～D 直接源码与测试 | 开发 / 中 / 已执行 | 旧指纹证据；当前交付已变化 | `2a2c37f6…73ea2` | 失效 |
| V18-03 | 生产组合根与全入口回归 | orchestrator/runtime-host/CLI 包级验证 | S18-D～E 源码与测试 | 最终 / 高 / 已执行 | 旧指纹证据；当前交付已变化 | `2a2c37f6…73ea2` | 失效 |
| V18-04 | 最终交付物可构建且无意外差异 | 单独运行 `pnpm build`；diff check 与交付指纹 | 33 文件冻结业务闭包 | 最终 / 高 / 195 秒 | 旧指纹证据；当前交付已变化 | `2a2c37f6…73ea2` | 失效 |
| V18-05 | U18-04、U18-07～12 的根因闭包与直接回归 | core/owner/executor governor 定向测试；executor failure 定向测试；三包类型检查；三张机械对账 | 当前 37 文件中的直接源码与测试 | 收口 / 低 / 已执行 | 旧指纹证据；当前交付已变化 | `343f1d6b…29df` | 失效 |
| V18-06 | 两轮冻结终审 | 同指纹独立代码/spec/测试审查 | 37 文件完整冻结闭包 | 终审 / 中 / 已执行 | 旧指纹证据；当前交付已变化 | `ca2145f1…dc6d` | 失效 |
| V18-07 | 最终交付可构建且受影响包无回归 | 单独 `pnpm build`；随后受影响包逐包全测及其余必要门禁 | 37 文件完整冻结闭包及构建产物 | 最终 / 高 / 已执行 | 旧指纹证据；当前交付已变化 | `ca2145f1…dc6d` | 失效 |
| V18-08 | U18-07、U18-14～15 根因闭包与生产恢复接线 | core/owner/executor governor 定向测试；owner/executor 类型检查；CLI 双半边恢复目标用例 | 当前修复源码、规格与直接测试 | 收口 / 低 / 已执行 | 旧指纹证据；保留窗配置面已继续收口 | `c45f5555…dbdf` | 失效 |
| V18-09 | U18-07、U18-14～15 最终根因闭包与冻结保留窗 | core/owner/executor governor 定向测试；三包类型检查；CLI 双半边恢复目标用例；配置符号零残留检查 | 当前 37 文件冻结闭包 | 收口 / 低 / 已执行 | 旧指纹证据；当前交付已变化 | `aae0661d…d336` | 失效 |
| V18-10 | 同一冻结交付物最终可构建且受影响包无回归 | 单独 `pnpm build`；随后 core、owner-kernel、executor、orchestrator、CLI 逐包全测；最终 diff 与指纹复核 | 指纹 `aae0661d…d336` 的 37 文件完整闭包及构建产物 | 最终 / 高 / 已执行 | 旧指纹证据；当前交付已变化 | `aae0661d…d336` | 失效 |
| V18-11 | U18-16～17 的等待/延期/恢复与字段封闭根因闭包 | core/owner/executor 类型检查；三端 governor 定向测试；queued system 恢复目标用例；diff check | 当前 37 文件业务闭包 | 收口 / 低 / 已执行 | 旧指纹证据；当前交付已变化 | `f8c8dfab…ae53` | 失效 |
| V18-12 | U18-18～21 的枚举/专型封闭、终结所有权与原子准入闭包 | core/owner/executor 类型检查；三端 governor 定向测试；同类残留与 diff check | 当前 38 文件业务闭包 | 收口 / 低 / 已执行 | 三包类型检查通过；core 16、owner 17、executor 18 项通过；core 构建与 diff check 通过，无旧校验/双阶段激活残留 | `4f40ba8c…604b` | 有效 |
| V18-13 | U18-22～24 的全入口治理、准入前置条件与枚举单源闭包 | 生产模型调用注册表；core/owner/executor governor 定向测试；perspectives/control 组合根测试；类型检查与私有枚举零残留扫描 | U18-22～24 修复后的直接源码、规格与测试 | 收口 / 中 / 已执行 | core governor 20/20、owner 19/19、executor 19/19、CLI 治理与注册表 5/5、server perspectives 13/13、orchestrator runtime 66/66、CLI protocol runtime 19/19；六包类型检查通过（CLI 仅 X18-01 既有基线）；resource-lease 私有枚举零残留 | `7073845f…5ea9` | 有效 |
| V18-14 | 最终冻结交付物的产物、包级回归与剩余门禁 | 单独 `pnpm build`；core→owner→executor→orchestrator→runtime-host→server→CLI 逐包串行全测；结构 golden 显式更新与差异审阅；`git diff --check`；指纹复算 | 最终 49 文件、工作区依赖图、构建产物与测试输入 | 最终 / 高 / 已执行 | 17 包构建成功；core 143 文件 2381 项、owner 7/180、executor 4/411、orchestrator 25/426、server 41/745（golden 同步后 1/1 复跑通过）、CLI 163/2371 全部通过；runtime-host 无测试配置合规跳过；diff check 零错误；最终指纹复算一致 | `68051709…f9cf` | 有效 |
| V18-15 | U18-22～23 二次修复的治理闭包与前置验证闭包 | CLI 治理与注册表测试（扩形态重扫）；core/owner/executor governor 定向；owner/executor 单包全测（完整 validator 生产合规）；六包类型检查 | 二次修复后的直接源码、规格与测试 | 收口 / 中 / 已执行 | CLI 治理 7/7、注册表 2/2（advancement 入口捕获零漏网）；core 21/21、owner 19/19、executor 20/20 定向；owner 180/180、executor 411/411 全测；类型检查全绿（CLI 仅 X18-01 基线） | `bc56d0ca…5451` | 有效 |
| V18-16 | 二次修复后最终冻结交付物的产物、包级回归与剩余门禁 | 单独 `pnpm build`；core→owner→executor→orchestrator→server→CLI 逐包串行全测；结构 golden 显式更新（差异仅 3 处引用计数、无新包边或环）与正常复跑；`git diff --check`；指纹复算 | 最终 51 文件、依赖图、构建产物与测试输入 | 最终 / 高 / 已执行 | 17 包构建成功；core 143 文件 2382/2382（首轮 1 失败经两轮独立复跑归因为负载噪声）、owner 180/180、executor 411/411、orchestrator 426/426、server 41 文件 745/745（golden 同步后）、CLI 163 文件 2373/2373；diff 零错误；指纹复算一致 | `0ff76261…7a68` | 有效 |
| V18-17 | 三次修复后最终冻结交付物的产物、包级回归与门禁（同一未修改交付物） | 冻结前 golden 单文件预检（1/1 零同步）；单独 `pnpm build`；core→owner→executor→orchestrator→server→CLI 逐包串行全测（输出落盘取证）；`git diff --check`；指纹复算 | 最终 51 文件、依赖图、构建产物与测试输入 | 最终 / 高 / 已执行 | 17 包构建成功；core 2382/2382、owner 180/180、executor 411/411、orchestrator 426/426、server 745/745、CLI 2373/2373 全部一次通过；diff 零错误；指纹复算与冻结一致（零漂移） | `aa8fd95d…5e57` | 有效 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | U18-03～05，均已验证 | `2a2c37f6…73ea2` | 通过 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | U18-06，已验证 | `2a2c37f6…73ea2` | 通过 |
| 独立终审 | 失败/过期双半边终结、资源调用重放、跨设备时间 | 是 | U18-07～09，待修复 | `2a2c37f6…73ea2` | 未通过 |
| 补充独立审查 | 历史租约全部消费者、资源端口方法闭包、workload 跨 attempt 身份 | 是 | 重开 U18-04；新增 U18-10～11 | `2a2c37f6…73ea2` | 未通过 |
| 定向补充审查 | 本地域根租约变体、签发域与 delegation 深度边界 | 是 | 新增 U18-12 | `2a2c37f6…73ea2` | 未通过 |
| 冻结终审一 | 需求、架构、状态、入口、消费端、终态与规格闭包 | 是 | 无 | `343f1d6b…29df` | 通过 |
| 冻结终审二 | 授权、exact replay、并发、崩溃恢复、时间、模块边界与测试盲区 | 是 | 无 | `343f1d6b…29df` | 通过 |
| U18-13 后冻结终审一 | 测试时限所有权、生产默认值、双 governor 配置与活动时间语义 | 是 | 无 | `a78b6fc9…98ab` | 通过 |
| U18-13 后冻结终审二 | 完整架构、安全、重放、恢复、模块边界与既有问题闭包 | 是 | 无 | `a78b6fc9…98ab` | 通过 |
| 最终预算单源化后终审一 | 候选 TTL、活动时间、重 IO 预算所有权与生产默认值 | 是 | 无 | `ca2145f1…dc6d` | 通过 |
| 最终预算单源化后终审二 | 测试断言语义、完整架构边界、回归证据与交付闭包 | 是 | 无 | `ca2145f1…dc6d` | 通过 |
| 提交前独立终审 | 双端资源调用的静态授权、exact replay、生命周期、生产装配与验证闭包 | 是 | U18-14，待修复 | `ca2145f1…dc6d` | 未通过 |
| 补充独立终审 | 双半边过期恢复、缓存/投影空间上界、冷启动重放复杂度与容量并发线性化 | 是 | 重开 U18-07；新增 U18-15 | `ca2145f1…dc6d` | 未通过 |
| 收口后冻结终审一 | 需求、状态机、生产入口、预算守恒、生命周期、恢复与规格实现 | 是 | 无 | `c45f5555…dbdf` | 通过 |
| 收口后冻结终审二 | 授权、重放、保留窗、配置面、模块边界与测试盲区 | 是 | 重开 U18-15 | `c45f5555…dbdf` | 未通过 |
| 最终冻结终审一 | 需求、状态、入口、消费端、生命周期、恢复、保留窗与模块边界 | 是 | 无 | `aae0661d…d336` | 通过 |
| 最终冻结终审二 | 授权、exact replay、双半边恢复、状态保留、配置面、模块边界与测试盲区 | 是 | 无 | `aae0661d…d336` | 通过 |
| 提交前独立终审 | 候选公平准入生产消费者、GovernorRecord 字段封闭、上下游与测试覆盖 | 是 | U18-16～17，待修复 | `aae0661d…d336` | 未通过 |
| U18-16～17 集中修复闭包 | 共享等待/延期原语、生产恢复重驱、GovernorRecord 单一运行时 validator 与污染测试 | 是 | 无新增；U18-16～17 已验证 | `f8c8dfab…ae53` | 修复完成，待冻结终审 |
| 独立终审 | GovernorRecord 枚举封闭、生产/恢复/重放链与测试覆盖 | 是 | U18-18，待修复 | `f8c8dfab…ae53` | 未通过 |
| 补充独立终审 | 预算守恒、签发授权、原子伴随、过期终结所有权与恢复顺序 | 是 | U18-19，待修复 | `f8c8dfab…ae53` | 未通过 |
| 再次独立终审 | 根准入线性化、executor 硬容量竞争、专用租约变体、生产接线与测试盲区 | 是 | U18-20～21，待修复 | `f8c8dfab…ae53` | 未通过 |
| U18-18～21 集中修复闭包 | 枚举/origin 封闭、业务根终结所有权、control 单事务准入与实际容量复验、专用租约变体 | 是 | 无新增；U18-18～21 已验证 | `4f40ba8c…604b` | 修复完成，待独立终审 |
| 提交前独立终审 | 当前全部模型调用入口、双 governor 准入前置条件、资源租约枚举单源 | 是 | U18-22～24，待修复 | `4f40ba8c…604b` | 未通过 |
| U18-22～24 三次修复闭包 | 全入口治理、双半边前置验证、枚举单源、行级计数注册表与非法输入零副作用 | 是 | 无新增；U18-22～24 已验证 | `aa8fd95d…5e57` | 修复完成 |
| 冻结终审一 | 需求、架构、全入口治理、双半边状态与跨切片合同 | 是 | 无 | `aa8fd95d…5e57` | 通过 |
| 冻结终审二 | 并发、崩溃恢复、授权、资源边界、异常终态与测试盲区 | 是 | 无 | `aa8fd95d…5e57` | 通过 |

<!-- registration-complete: unit-18.gen-1 -->
