# 单元登记:第 22 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:22
- **generation**:1
- **登记时间**:2026-07-23
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 22 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、分片账本、九类核查面行、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成：同一 37 文件冻结交付物的两轮终审、全部验收与必要验证通过
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是
- **交付物文件集**:37 个非工作台交付文件：core 票据与 assignment 因果合同及 executor 逻辑流准入、owner conversation/job 耐久生命周期与共享幂等谓词、executor 票据注册/stream 资格/assignment 接线、CLI stream 与票据 mesh 适配、server 结构 golden、架构执行文档及对应测试；工作台文件按静态规则不计入交付物
- **当前交付物指纹**:`1fd89920f92163bfd35896d57ec692a8b1fabe4fa4e167f62e78134e43f5acfd`
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的确认权威、owner 失联止损与双平面数据面；`research/design/modules/distributed-runtime/specification.md` §2.2、§3.6、§4.3、§5.6 及第 22 单元

## 固定边界

- **功能范围**:落 run-observe/run-interact/abort 数据面票据的签发、续期、吊销与验证；把票据资格接入逐消费者 stream；接通第一方 allow-once 与 owner 失联 abort，保持旁观只读
- **架构不变量**:owner 唯一签发/续期/吊销；签发事实先耐久后下发；executor 只验权不续签；interact 仅原始 surface；observe 永远只读；abort 只停止执行、不裁决权威终态；pending/finished 权威唯一在 executor assignment 流
- **验收条件**:越权 observer、非原始 surface 应答、票据过期/吊销、交互取消竞态、断线重连、重复应答与 abort proof 全部机械拒绝或幂等收敛；本地与 mesh 同 guard
- **必要上下游**:第 20 单元跨机控制面与签名身份；第 21 单元 stream/spool/消费者资格；现有 conversation/job owner journal、executor assignment ledger 与交互投影
- **明确不属于本单元**:第 23 单元 surface 内容资产；第 24 单元渠道 challenge/outbox、owner-relay 最终整合、路径降级与无损数据面生产启用；持久授权与其他业务模块接入

## 审查分片

- **是否启用**:是
- **决定依据**:跨 owner/executor/mesh 三个信任域并包含签名合同、耐久生命周期、权限矩阵和取消竞态，纵向闭包适合独立收敛，但最终仍需完整横向对账
- **完整单元与跨切片必审项**:assigned/received→ticket-issued→下发/续期→executor 验权→interaction/abort→ticket-revoked 全链；签名对象、耐久事实、stream 资格与 assignment 终态必须一致

> 不启用时账本留空。本轮进度用于跨窗口续跑,收敛状态用于跨审查轮复用;状态与流转规则见工作台静态区。

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |
| S22-A 票据合同 | DataPlaneTicket 创建、摘要、运行时验证、时间/身份绑定 | 第 21 单元完成基线 | 第七次集中修复 | 历史身份、耐久前沿、单调资格与完整 abort 因果已验证 | 全局封版 | 在线资格只由 registry 单调 deadline 与显式退休决定；executor-bound 耐久前沿防回拨复活；assignment reducer 保存完整 abort ticket 身份。 |
| S22-B owner 生命周期 | issued/revoked 耐久事实、原始 surface/observer 资格与续期 | 第 21 单元完成基线 | 第七次集中修复 | 两域完整幂等身份与耐久同步前沿已验证 | 全局封版 | conversation/job 共用完整签发请求身份；同步前沿只增不减，replacement 与吊销同事务提交。 |
| S22-C executor 守卫 | observe/interact/abort 验权、assignment 交互与停止证明 | 第 21 单元完成基线 | 第七次集中修复 | history-first replay、retirement、防回拨与 spool 资格已验证 | 全局封版 | 新准入与历史重放分离；缓存回收不能抹掉退休身份；spool 不再用墙钟建立第二在线资格。 |
| S22-D 传输与装配 | stream/interaction/abort mesh 接线、本地等价与恢复 | 第 21 单元完成基线 | 冻结终审 | U22-10、U22-12、U22-14 已验证 | 全局封版 | ticket mesh 仅依赖 surface-operations 端口；stream consumer fence 复用 registry 冻结值；交互投影仅保留显式 meta/游标的纯原语，生产启用仍归第 24 单元。 |

### 完整单元横向审查记录

> 启用分片时每轮必填;默认消费封版信息包,有疑问可下钻细节,确认问题或结论失效时重开切片。

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |
| 开发收口 | 指纹 `ddbab254…7642` | issued→下发/恢复→executor 验权→stream/interact/abort→revoked 全链；conversation/job、full/guard、local/mesh 与测试记录矩阵横向对账 | U22-01～U22-03 均已验证，无待修复项 | 四切片封版，交付物冻结并等待独立终审 |
| 独立终审 | 指纹 `ddbab254…7642` | 票据同步、在线准入与恢复、跨时钟有效期、注册表生命周期、interaction→stream 全部生产端与消费端横向对账 | 重开 S22-A、S22-C、S22-D；新增 U22-04～U22-08 | 5 个真实问题等待按根因集中修复 |
| 独立复审 | 指纹 `ddbab254…7642` | 复用 X22-01～X22-03；按 L22-01 绕过已闭合验证噪声，横扫每个返回成功但尚未形成终态事实的耐久义务及其运行时、恢复和提交所有者 | U22-05 补齐签发身份绑定；新增 U22-09 | 新增 1 个根因问题，累计 6 个待修复问题；同类面已收齐 |
| 集中修复 | 指纹 `d425f555…0bf2` | 过期同步、owner/activation 单一准入、本地有效期、票据退休、交互投影和 ticket abort 生命周期按六项问题完整对账 | U22-04～U22-09 合并直接验证通过 | 四切片重新封版，进入冻结终审 |
| 冻结终审第一轮 | 指纹 `d425f555…0bf2` | 复用 X22-01～X22-03；执行 L22-01、L22-02，并沿 surface 操作、票据 churn/同步前沿、投影导出 seam、取消失效链横向对账 | 重开 S22-B～S22-D；新增 U22-10～U22-13 | 4 个真实根因已一次收齐，解冻进入集中修复 |
| 第二次集中修复 | 指纹 `aa3c8165…aefd` | surface answer/abort 单一协调、并发应答幂等、registry 投影与 spool 副作用串行化、owner 有限同步前沿、纯投影原语和两域取消吊销完整对账 | U22-10～U22-13 合并直接验证与同根竞争测试通过 | 29 文件重新冻结，进入两轮冻结终审 |
| 第二次冻结终审第一轮 | 指纹 `aa3c8165…aefd` | 复用 X22-01～X22-03；执行 L22-01～L22-05，按需求、架构、状态、入口、生产/消费链、生命周期与回归面完整横向对账 | 无重开项、无新增问题 | 第一轮零新增，进入第二轮独立裁决 |
| 第二次冻结终审第二轮 | 指纹 `aa3c8165…aefd` | 复用 X22-01～X22-03；执行 L22-01～L22-05，并按并发、崩溃、时钟、安全、异常终态与历史证明横向对账 | 重开 S22-B～S22-D；新增 U22-14、U22-15 | 2 个时间语义分叉根因已收齐，解冻进入集中修复 |
| 第三次集中修复 | 指纹 `2b297e22…e5f5` | 接收时冻结唯一稳定 consumer expiry；conversation/job 共用 owner-issued abort-ticket 历史证明谓词；在线当前有效性继续由 executor registry 独占 | U22-14、U22-15 合并直接验证通过 | 四切片重新封版，进入冻结准备 |
| 第三次冻结终审第一轮 | 指纹 `2b297e22…e5f5` | 复用 X22-01～X22-03；执行 L22-01～L22-06；对账需求、架构、状态、入口、生产/消费链与回归面 | U22-14、U22-15 未彻底封板：spec 残留旧时间/当前有效性表述，active recovery 缺直接证据 | 无新增实现问题；按原问题解冻集中补齐 |
| 第三次集中补齐 | 指纹 `607a8680…0658` | spec 明确冻结 consumer expiry 与使用后历史证明；active registry 恢复复用同一 expiry 的直接测试闭合 | U22-14、U22-15 重新完整验证 | 30 文件重新冻结，终审轮次归零 |
| 第四次冻结终审第一轮 | 指纹 `607a8680…0658` | 复用 X22-01～X22-03；执行 L22-01～L22-06；横扫短期凭证在线使用、后继吊销与历史证明的全部架构表述 | U22-15 尚有一处“当前有效 abort 票据”旧表述 | 无新增实现问题；按原问题解冻集中补齐 |
| 第四次集中补齐 | 指纹 `99d1bcf7…64e7` | 将最后一处 abort-ticket proof 旧表述改为历史签发证明，并全量搜索架构总纲与执行文档同类措辞 | U22-15 最后一处文档残留已闭合 | 30 文件重新冻结，终审轮次归零 |
| 第四次冻结终审第一轮 | 指纹 `99d1bcf7…64e7` | 复用 X22-01～X22-03；执行 L22-01～L22-06；按需求、架构、状态、入口、生产/消费链、生命周期与回归面完整横向对账 | 无重开项、无新增问题 | 第一轮零新增，进入第二轮独立裁决 |
| 第四次冻结终审第二轮 | 指纹 `99d1bcf7…64e7` | 复用 X22-01～X22-03；执行 L22-01～L22-06；按崩溃重放、安全、异常终态与在线/full/guard 等价性横向对账 | 重开 S22-B；新增 U22-16 | abort-ticket 历史签发谓词未进入两域全部重放执行点，解冻集中修复 |
| 第五次集中修复 | 指纹 `e5d563c5…ca21` | abort-ticket 历史签发结果成为共享 proof 绑定谓词的必需输入；conversation/job 分别由唯一状态感知入口计算，online/full/guard 全部消费同一结果，旧在线专用检查删除 | U22-16 合同测试、两域真实票据正向与伪造/未配置负向定向验证通过 | 31 文件重新冻结，进入两轮冻结终审 |
| 第五次冻结终审第一轮（失效） | 指纹 `e5d563c5…ca21` | 复用 X22-01～X22-03；执行 L22-01～L22-07；按需求、架构、状态、生产/消费链、生命周期、权限与回归面完整横向对账 | 无新增根因；下游定向验证随后暴露 U22-16 兼容错误语义未闭合 | 后续修复改变交付物，本轮不计入连续轮次 |
| 第五次集中修复补齐 | 指纹 `04c2aba6…c493` | legacy seam 的明确拒绝继续原样传播；共享谓词只把正常不匹配归一为 false；上游重建后唯一失败单例转绿，同根 5 项既有绿证据输入未变 | U22-16 最后兼容分支与 online/full/guard 单源合同完整闭合 | 31 文件重新冻结，终审轮次归零 |
| 第五次重冻结终审第一轮 | 指纹 `04c2aba6…c493` | 复用 X22-01～X22-03；执行 L22-01～L22-07；按需求、架构、状态、入口、生产/消费链、生命周期、权限与回归面完整横向对账 | 无重开项、无新增问题 | 第一轮零新增，进入第二轮独立裁决 |
| 第五次重冻结终审第二轮 | 指纹 `04c2aba6…c493` | 复用 X22-01～X22-03；执行 L22-01～L22-07；按并发、崩溃、时钟、安全、资源上界、异常终态与 online/full/guard 等价性横向对账 | 无重开项、无新增问题 | 第二轮零新增，进入最终验证 |
| 最终验证回退 | 指纹 `04c2aba6…c493` | 构建、core、owner-kernel 通过；executor 32 文件、453 项中 447 项通过，3 项默认 5 秒超时，另 3 项均由 job 重启夹具遗漏 legacy abort 授权器触发 | 新增 U22-17、U22-18；执行 L22-08、L22-09，横扫全部 `JobJournal` 构造器及 executor 耐久测试预算 | 解冻进入集中修复；六项均已定向归因，不重跑整包 |
| 第六次集中修复 | 指纹 `4cb21097…2012` | legacy abort 授权器收敛为在线与重启夹具共用的单一事实源；三项重 IO 用例统一复用 executor 30 秒组级预算；全部构造器与预算同类面横扫闭合 | U22-17、U22-18 的 6 个原失败用例定向通过；Biome、类型与 diff 门禁通过 | 31 文件重新冻结，进入两轮冻结终审；executor 全包证据按运行手册复用，不重跑 |
| 第六次重冻结终审第一轮 | 指纹 `4cb21097…2012` | 复用 X22-01～X22-03；筛选并执行适用的 L22-08、L22-09；按需求、架构、功能闭环、状态、入口、生产/消费链与回归面完整横向对账 | 生产交付相对前一冻结输入未变；测试恢复夹具与组级预算修复无第二分叉，无重开项、无新增问题 | 第一轮零新增，进入第二轮独立裁决 |
| 第六次重冻结终审第二轮 | 指纹 `4cb21097…2012` | 复用 X22-01～X22-03；再次独立执行 L22-08、L22-09；按并发、崩溃恢复、安全、资源上界、异常终态与测试装配等价性完整横向对账 | legacy 授权夹具严格校验 assignment/executor/ticket/surface，未放宽负例；预算仅改变等待上界、不吞断言；指纹一致，无重开项、无新增问题 | 第二轮零新增，进入最终验证收口 |
| 最终验证收口 | 指纹 `4cb21097…2012` | 按输入闭包复用构建、core、owner 结果；executor 复用 447 项全包结果并以当前输入 6 项定向结果闭合；CLI 单包串行运行并保留机器结果；最终复核 diff、文件集、指纹与进程/临时文件 | CLI 173/173 文件、2441/2441 项通过；无残留进程或诊断文件，指纹未变 | 全部完成条件满足，单元完成 |
| 第七次集中修复 | 指纹 `1fd89920…acfd` | 按耐久身份优先、不可回退时间前沿和完整因果身份统一修复 U22-04、U22-07、U22-14、U22-16、U22-19；横扫 conversation/job、online/full/guard、registry/spool 与冷重放 | 五项直接测试、三包类型检查、core 构建、结构 golden 预检、Biome 与 diff 门禁通过 | 37 文件冻结，进入两轮独立冻结终审 |
| 第七次冻结终审第一轮 | 指纹 `1fd89920…acfd` | 复用 X22-01～X22-03；执行 L22-01～L22-12，按需求、架构、功能闭环、状态、入口、生产/消费链、生命周期、权限与回归面完整横向对账 | owner 两域幂等/前沿、registry history-first/退休、spool 显式资格、interaction/abort 单一所有权及导出 seam 均闭合；无重开项、无新增问题 | 第一轮零新增，进入第二轮独立裁决 |
| 第七次冻结终审第二轮 | 指纹 `1fd89920…acfd` | 复用 X22-01～X22-04；执行 L22-01～L22-12，按并发、崩溃、时钟、安全、资源上界、异常终态及取消义务重驱完整横向对账 | 前跳/回拨、冷恢复、历史重放、online/full/guard、surface/abort 与提交失败分类均闭合；无重开项、无新增问题 | 第二轮零新增，进入最终验证 |
| 最终验证收口 | 指纹 `1fd89920…acfd` | 单独构建后按 core→owner-kernel→executor→CLI 串行包测；executor 两项默认时限失败按运行手册定向归因；复核结构、diff、文件集、指纹、进程与临时文件 | 17 包构建、四个受影响包行为证据与结构门禁全部通过；executor 未重跑整包，458 项全包结果与 2 项定向结果组成 460/460 | 指纹未变、无残留进程或临时文件，全部完成条件满足 |

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core 票据、assignment reducer、commit-log 与导出 | runtime export、完整 abort 因果身份、executor 逻辑流准入与直接测试 | V22-22；最终回归 V22-23 | 通过 |
| owner conversation/job 记录、reducer 与共享 lifecycle | full/guard 行为注册表、完整幂等身份、替换吊销、不可回退同步前沿与 owner 包回归 | V22-22；最终回归 V22-23 | 通过 |
| executor 注册表、stream spool、ledger 与包导出 | package exports、类型、history-first replay、executor-bound 退休前沿、单调资格与 executor 包回归 | V22-22；最终回归 V22-23 | 通过 |
| CLI stream/ticket mesh adapter | 请求/响应身份绑定、并发应答幂等、权限等价、耐久 IO 测试预算与 CLI 包回归 | V22-22；最终回归 V22-23 | 通过 |
| 架构执行文档 | abort 因果身份、接收端有效期、耐久退休/同步前沿与完整幂等身份 | 与实现逐项对账；V22-22 | 通过 |
| server 结构 golden | 包依赖与拓扑引用计数 | 显式更新后审阅差异仅为既有合法边计数增加；只读结构门禁 1/1 通过 | 通过 |
| lockfile / schema | 无依赖版本或生成 schema 变化 | `git diff HEAD --name-only` 无对应文件；V22-22 | 不适用:依据 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| DataPlaneTicket 身份与权限 | core 票据合同 + owner issued/revoked/sync-frontier 事实 | owner 事务提交 `ticket-issued`；replacement 吊销同事务；同步前沿提交后过滤 | 签发后未下发、同键异载荷、续期替换、同步前跳/回拨、重放畸形记录 | conversation/job owner → executor/CLI guard | TTL 最大 24h；完整请求身份参与幂等；同步前沿只增不减，历史证明不被后继状态改写 | 通过 |
| executor 票据注册与 stream 资格 | `DataPlaneTicketRegistry` 耐久 accepted/retired/frontier 日志 | 历史身份先判；首次准入和 retire/frontier 提交后更新投影与 spool 资格 | accept/retire 崩溃、未知吊销先到、前跳后回拨、外国 executor 前沿、重启恢复 | mesh synchronizer → ledger/spool/interaction/abort | executor-bound 前沿与退休身份防复活；在线时限只由单调 deadline 裁决，spool 仅消费显式资格 | 通过 |
| 第一方交互应答 | assignment ledger interaction 事实 | 原始 surface 的 allow-once/deny 被 ledger 接受时线性化 | 重复应答、observer 越权、取消/应答竞态、投影失败重驱 | original surface → executor ledger → interaction stream projector | 单 interaction 终态幂等；共享投影原语按 ledger seq 重驱并命中 source 去重 | 通过 |
| owner 失联 abort | executor assignment abort 事实 + ticket proof | 运行中 worker 停止，pending interaction 终结并镜像后重入形成 `halted` proof | 重复 abort、票据过期/吊销、运行时并发、镜像/提交前后崩溃、owner 恢复后收束 | surface → mesh/executor worker + ledger → owner abort proof | 只停止执行，不直接裁决 owner 权威终态；worker 对每个耐久前缀恢复重驱 | 通过 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 架构 | §2.2 / 第 22 单元 | 状态 | issued/renewed/revoked/expired 与 stream 资格 | 通过:owner full/guard 与 executor registry 共用 core validator；V22-01～V22-07 | 通过:签发、替换、吊销、自然过期、退休与 stream 资格状态闭合 | 通过:重放、竞态、过期、恢复与有界回收未形成第二状态事实 |
| 架构 | 第 22 单元 | 入口与生产端 | observer/original surface、签发与下发 | 通过:observer 只读、原始 surface interact、manual job/conversation 签发矩阵通过 | 通过:两域签发及 owner/surface mesh 入口身份边界闭合 | 通过:observer、原始 surface、owner 与 executor 的签发/使用权限无越权路径 |
| 架构 | §5.6 | 消费端与继承面 | observe/interact/abort 本地与 mesh | 通过:spool 资格、ledger 与 mesh adapter 同 guard；V22-03、V22-04 | 通过:registry、spool、worker、owner proof 与 mesh 消费链闭合 | 通过:本地与 mesh 共用 registry/worker guard，恢复与响应重放幂等 |
| 架构 | §2.2 | 生命周期 | 分配、续期、失权、终态吊销 | 通过:原子续期、abort 后不可续、终态批量吊销与重启恢复闭合 | 通过:全部失权入口同点吊销，历史证明只读既成签发事实 | 通过:失权、吊销、后继拒绝和使用后历史证明在各自线性化点闭合 |
| 架构 | §3.6 | 并发与崩溃点 | 应答/取消/封包、吊销/使用、owner 失联 | 通过:worker 单一拥有 ticket abort 的停止、镜像、proof 与提交重驱；V22-09 | 通过:surface 成功前缀均有唯一运行时、恢复与提交所有者 | 通过:answer/abort、封包/取消、吊销/使用竞态由同一事务域或唯一 worker 排序 |
| 架构 | §3.6 / §4.3 | 异常路径与终态 | 重复、过期、撤销、abort proof | 通过:过期同步 no-op、跨时钟只冻结接收端有效期、abort 前缀全部可恢复；V22-09 | 通过:重复、过期、吊销、竞态和伪造历史均 fail-closed 或幂等 | 通过:所有耐久前缀可重驱；冲突、伪造、过期和未知记录均 fail-closed |
| 总纲 | 权限分层 | 安全边界 | principal/scope/executor/ref/expiry/signature | 通过:当前 owner key、activation、surface、executor、ref 与本地有效期统一绑定；V22-09 | 通过:签发者、激活、surface、用途、引用、期限与 owner 历史逐项绑定 | 通过:在线使用与历史证明谓词分层，后继吊销不改写既成来源且不恢复在线权限 |
| 执行计划 | S6 边界 | 模块边界 | core/owner/executor/CLI 归属与 23/24 排除 | 通过:仅落合同、耐久 guard 与 adapter；内容资产/生产启用未越界 | 通过:X22-03 仍适用，未提前启用第 24 单元生产拓扑 | 通过:X22-03 未触发重开；第 23/24 单元职责未提前实现 |
| 执行计划 | 第 22 单元验收 | 测试与验收 | 权限矩阵、竞态、重连与证明 | 通过:V22-01～V22-08；受影响四包全测、Biome 与 17 包构建闭合 | 通过:V22-18 覆盖必需谓词输入、真实票据正向、伪造/未配置负向与兼容拒绝语义 | 通过:V22-20、V22-21 闭合新指纹直接证据、输入未变证据复用、CLI 全包与最终机械门禁 |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U22-01 | 初版在线签发使用共享 validator，但 conversation/job 的 full reducer 与 submission guard 重放 `ticket-issued` 时只信任 TypeScript 形状，合法 envelope 可携带畸形票据绕过恢复校验。 | 写入校验与耐久重放校验分叉，磁盘业务 body 未继续按 `unknown` 处理。 | conversation/job 两域、full/guard 两投影、issued/revoked 全记录、历史恢复、abort proof 与全部票据消费者。 | full reducer 与 guard 对每条 issued 复用 core `validateDataPlaneTicket`，revoked 运行时校验 ticketId；畸形重放 fail-closed，直接测试与 owner 全包通过。 | 已验证 |
| U22-02 | executor 行为注册表初版未登记 conversation/job 的 `ticket-issued`、`ticket-revoked`，包测记录矩阵因此失败。 | 新增耐久记录时只补了 reducer 与功能测试，没有同步全类型行为枚举。 | conversation/job 两套 ledger、重复/越权后继记录、完整行为矩阵及未来新增状态转移。 | 为两域增加真实签发/吊销场景并将两类记录纳入 full/guard 行为注册表；4 个新增矩阵用例与 executor 全包通过。 | 已验证 |
| U22-03 | CLI 首轮全包 2435/2436 通过；新增 stream mesh 耐久 IO 用例在包内负载下于 30.1 秒超时，定向运行 2.36 秒通过且无功能断言失败。 | 新测试自行采用 30 秒预算，没有复用 CLI 既有 120 秒耐久 IO 组级预算。 | 该文件两项真实文件系统测试、CLI 包内并发负载、最终包测证据与跨单元验证运行手册。 | 整组复用 120 秒有界预算，不全局放宽、不吞错；直接文件 5/5、CLI 全包 2436/2436 通过，并登记运行手册。 | 已验证 |
| U22-04 | 修复后的 owner 已限制同步前沿，但 registry `accept` 仍在查询耐久既有记录前要求当前 `dataPlaneBinding`；assignment 终态后，精确重放的已接受票据以及应按 inactive 收敛的过期事实都会先报“无激活”，阻断后继 active/revoked 同步。 | 新票据准入与历史精确重放共用当前激活守卫，耐久身份判定晚于易变业务状态。 | conversation/job 事实生产端、CLI synchronizer、registry accept/recover、assignment 终态、响应丢失重放、expired→active/revoked 顺序与重连恢复。 | registry 先按 ticketId 读取耐久身份：精确既有载荷只按原 accepted/retired 事实幂等收敛；仅首次新准入校验当前 activation、签发者与接收区间；异载荷稳定冲突。覆盖终态后精确重放、失活过期事实及其后 active/revoked 不受阻断。 | 已验证 |
| U22-05 | registry 在线 `accept` 会校验本机 executor 与 `dataPlaneBinding`，但耐久 reducer/recover 只验逻辑流后缀和票据自身签名，`authorizeSurface` 也未重新核对当前耐久 assignment 激活事实；此外 generic verifier 只证明签名来自可信设备，binding 不含当前 owner 签发身份，任一受信设备签出的同字段票据都可能被接收。 | “票据由当前 assignment owner 签发且仍绑定当前激活”的准入谓词没有成为在线、重放、恢复与授权的统一合同。 | owner 签发身份、registry 写入与重放、设备角色/身份变化、错签发者/错流/错 assignment 注入、重启恢复、stream/interact/abort 授权及畸形日志测试。 | 从耐久 received activation 冻结预期 owner 签发 key，并与本机身份、精确逻辑流、ref/executor 和当前激活组成单一谓词；在线、重放、恢复和每次 surface 授权全部复用，外国可信签发者、错流、错设备和失活 assignment 均 fail-closed。 | 已验证 |
| U22-06 | 协议声明远端 ISO 时间只作签发事实并须转换为接收端本地 deadline，但 abort、owner proof 与 registry 恢复仍直接比较不同设备的墙钟；registry 在本机时钟回拨时还会延长或复活票据。 | 远端签发区间与本地单调有效期没有在接收时冻结为唯一在线时间事实。 | ticket 创建/接收/恢复、conversation/job owner proof、interact/abort、允许时钟偏差、重启回拨与过期/吊销终态。 | executor 耐久接收区间与本地单调 deadline 成为唯一在线有效期；跨设备签名时间只做有界偏差验证，恢复对回拨 fail-closed 或封顶；覆盖正负允许偏差和重启回拨。 | 已验证 |
| U22-07 | retirement 已有保留窗，但 `compactTicketProjection` 直接按当前墙钟从带 cursor 的缓存投影删除墓碑；墙钟先前跳越过 `retainUntil` 再回拨后，同进程可重新接受旧签名票据，并追加一条冷重放时与原墓碑矛盾的 accepted 记录。conversation/job `dataPlaneTicketFacts()` 也按当前墙钟筛选，回拨会重新暴露已经退出同步前沿的历史 issued/revoked。 | 防复活墓碑的回收与跨端同步前沿共同依赖可回拨墙钟，且增量缓存删除后无法由已越过的 cursor 恢复原退休身份。 | accepted/retired 投影、owner 两域同步前沿、显式吊销与自然过期、长期进程时钟校正、同进程再接收、跨端重复同步、重启全量重放、spool 重新资格化与日志完整性。 | 以耐久不可回退高水位统一决定 owner 同步前沿与 executor 退休资格；缓存压缩不得让已退休 ticketId 再次成为可准入或可下发身份。覆盖前跳→压缩/同步→回拨→迟到旧票据及随后冷重放，两域持续 churn 前沿仍有界。 | 已验证 |
| U22-08 | CLI 在线 observer 与 executor `AssignmentInteractionStreamProjector` 都把同一 ledger interaction 投影到 stream，但前者使用 `interaction:${recordSeq}`、`binding.streamMeta` 和游标，后者使用 `interaction-ledger:${recordSeq}`、空 meta 且无游标；第 24 单元启用后重驱不会命中去重，重复 requested 会被 spool 判损坏。 | 同一投影合同存在两个独立执行点，source identity、meta 与重驱游标没有单一所有者。 | ledger interaction 生产端、CLI 在线投影、executor 导出 seam、第 24 单元消费者、spool source 去重/摘要/interaction reducer、恢复与交叉接线测试。 | 收敛为一个共享投影原语并由单一所有者驱动，冻结规范 sourceId、从 binding 单源派生 meta、统一耐久游标/幂等语义；用“在线已投影后再恢复重驱”交叉测试证明零重复、零摘要分叉。 | 已验证 |
| U22-09 | `data-plane-ticket-mesh` 的 abort handler 验票后仅调用 `ledger.abortWithTicket` 并立即返回；该调用只写 `abort-requested` 和 pending `interaction-finished`，有未镜像交互时不会生成 `halted` proof。服务没有 live worker、interaction mirror、proof submit 或恢复重驱端口，因此运行中的模型不会被停止，finished 无人镜像，也无人以同一原因重入生成并提交 proof；worker 随后的失败收束还会被已有 abort 前缀拒绝。 | 跨运行时副作用、耐久取消前缀、交互镜像、proof 形成和 owner 提交的同一取消义务没有唯一生命周期所有者。 | ticket mesh abort、ConversationAssignmentWorker、assignment ledger 全部合法前缀、pending interaction、owner 离线/重连、进程崩溃恢复、proof 提交与 owner uncertain 收束；现有测试只覆盖未启动且无 pending 的即时 proof。 | 建立 executor-owned abort coordinator：验权后先取得该 assignment 的唯一取消义务，停止 live worker，耐久写 abort/finished，按既有镜像 outbox 重驱至 owner 确认，再以同一 cause 重入形成唯一 proof 并有界重试提交；每个前缀均可由恢复扫描续跑。覆盖运行中+pending+owner 离线/重连，以及 abort、finished、mirrored、halted、submit 各崩溃点和重复请求。 | 已验证 |
| U22-10 | ticket mesh 的 answer 直接调用 ledger 写 `interaction-finished`，没有唤醒正在等待 `ConfirmationBroker` 的 runtime，也绕过 observer 的 finish-and-mirror；observer 又把所有 surface answer 的 authority 硬编码为 `ticket:${requestId}`。abort 路径在 sealed/terminal 竞态仍无条件停止 worker并安排无前缀的取消重驱，且响应丢失后的同请求会因 activation 已关闭而无法重放。 | surface 操作把“验票/耐久事实”和“在线运行时唤醒、镜像、取消重驱”拆给多个组件，缺少 executor-owned 单一协调者与显式幂等处置结果。 | mesh answer/abort、ledger、ConversationAssignmentWorker、ConfirmationBroker、durable observer、运行时等待、交互镜像、sealed/abort 竞态、响应丢失重放、崩溃恢复与直接测试。 | ticket mesh 只依赖一个 executor surface-operations 端口；worker 统一协调验票、真实 broker durable resolve、实际 ticket authority 落盘/镜像，以及 abort 的 accepted/terminal 判别。ledger 先重放匹配的 finished/abort 前缀，再做激活验权；仅 accepted 前缀触发停止和取消重驱。覆盖在线唤醒、真实 ticketId、相同/冲突重放、sealed-wins 无副作用和恢复重驱。 | 已验证 |
| U22-11 | registry 只在 authorize/recover 时把已接受票据转退休，长期签发但从未使用的过期票据永久留在 accepted；owner `dataPlaneTicketFacts()` 又返回全部历史 issued/revoked，重复同步会把已过保留窗的旧 tombstone 重新创建，在线内存和同步成本均随全历史增长。 | 退休上界只处理单个使用路径，没有为运行投影和跨端同步定义同一个有限时间前沿及维护所有者。 | executor accepted/retired/deadline/spool 资格、连续运行维护、conversation/job owner facts、CLI synchronizer、续期/吊销历史、重启与大规模 churn。 | registry 在串行操作内执行到期维护并提供显式 maintain，批量把到期 accepted 转退休并撤销消费者；owner 同步事实只暴露 `expiry + clockSkew` 尚未越过的有限前沿及其匹配吊销。覆盖无使用自然过期、连续 churn、时间推进后同步不复活 tombstone和两域等价。 | 已验证 |
| U22-12 | U22-08 修复后仍导出 `AssignmentInteractionStreamProjector`：它持有第二份内存游标，且 `synchronize`/共享原语的 meta 默认 `{}`；未来消费者可不传 binding meta，再次与在线投影产生摘要分叉。 | 声称谓词/投影单源化时只统一了底层函数，未删除带状态与宽松默认值的第二执行所有者。 | executor 导出 seam、CLI 在线投影、第 24 单元未来装配、turnOrigin meta、source 去重、恢复重驱与 projector 测试。 | 删除状态型 projector 导出，只保留纯投影原语；meta 改为必填且由调用者从 durable binding 明确传入，游标唯一归调用方所有。测试直接验证纯原语的显式游标与相同 meta 重驱。 | 已验证 |
| U22-13 | conversation/job 在 cancel-fence 与 `cancel-requested` 原子提交时未追加现有 `ticket-revoked`；签发入口也仅检查当前 acknowledged assignment，因而 cancel-requested 后仍可签发新 observe/interact/abort 票据，已有票据直到更晚终态才失效。 | owner 的取消状态机与票据生命周期没有在同一线性化点共用“assignment 失去数据面资格”谓词。 | conversation/job 两域、直接 cancel/control cancel/batch cancel、full/guard reducer、签发/续期、现有票据同步、cancel 竞态和恢复测试。 | 票据签发仅允许当前 `dispatched|running` 且无 cancel fence；每个取消入口在 cancel-fence 同一 envelope 追加该 assignment 全部未吊销票据的 `ticket-revoked`，并以两域 full/guard、直接/control/batch 与重放测试证明取消后零有效票据。 | 已验证 |
| U22-14 | registry 已冻结稳定 `expiresAt` 并以单调 deadline 授权，但 spool 的 qualify/beginConnection/subscribe/ack、retentionFloor 与 reclaim 仍把该值同当前墙钟比较；墙钟前跳时 registry 判有效、spool 却提前拒绝，后续操作还可能把仍有效 surface 当失效并裁剪未读帧。 | 稳定 consumer fence 仍被 spool 误用为第二套在线墙钟资格；“单调 deadline 唯一决定在线使用资格”未贯彻到全部消费者。 | registry authorize/maintain、spool 全部 surface consumer 操作、stream mesh subscribe/ack、背压与帧裁剪、终态回收、前跳/回拨/恢复测试。 | 在线资格只由 registry 单调 deadline 与显式 retirement/revoke 决定；spool 对实时操作不得用当前墙钟重新裁决，历史 reducer 仅按记录时刻验证耐久顺序。覆盖前跳期间 subscribe/ack/保留帧、单调到期后的显式撤销与冷重放。 | 已验证 |
| U22-15 | U22-13 在 cancel-fence 同一 envelope 吊销全部票据，但 conversation/job 的 abort proof 验证又要求对应 abort 票据当前未吊销；因此状态表明确允许的 `cancel-requested × CancelProof(abort-ticket)` 在真实 owner-issued ticket 路径必然拒绝，现有通过用例只走“零票据事实”的旧兼容 seam。 | 把 executor 使用时的“当前有效票据”谓词错误复用于 owner 对已发生耐久 abort 的历史来源证明，后继吊销反向抹掉了合法证据。 | conversation/job 两域、cancel-fence 与 ticket-revoked 原子包、abort-ticket not-started/halted proof、owner 恢复、真实票据与旧兼容测试。 | owner 验 proof 时只证明其摘要绑定本 assignment 曾由 owner 签发的 abort 票据、executor 与 surface；是否可用于发起新 abort 仍只由 executor registry 的当前有效性裁决。补两域“真实票据→owner cancel 吊销→abort proof 收束”及 revoked 后新使用拒绝测试。 | 已验证 |
| U22-16 | owner 的 online/full/guard 已统一验证历史签发票据，但 core 共享 assignment reducer 仍把 abort 前缀压成 `via + refId`：halted proof 只按 ticketDigest 命中，未核对 proof 与 `abort-requested.surfacePrincipal` 全等。错误证明可在 executor/full 证据重放通过，随后被 owner 拒绝并造成两端终态分叉。 | abort→halted 的共享因果身份不是完整判别对象；新增 surface 字段进入记录和 proof 后未进入增量验证状态。 | core 增量 reducer、executor 在线/冷重放、分页证据验证、abort-ticket not-started/halted、owner 两域证明消费、错 surface 签名证明与恢复收敛。 | 共享验证状态保存 abort-ticket 的完整 `{ticketDigest,surfacePrincipal}` 身份，并要求 halted proof 全字段命中唯一耐久前缀；executor、owner evidence/full/guard 共用同一推进器。补错 surface 正负测试及跨页重放。 | 已验证 |
| U22-17 | executor 最终包测中 job 行为矩阵的 3 项合法历史重放均报 `Rejected not-started proof is historical`；在线 `createUserHarness` 配置了 legacy abort 授权器，而共享 `reopenUserJournal` 工厂未配置，导致同一合法日志在重启夹具中被错误判腐坏。 | 测试基础设施把运行时安全依赖复制到多个构造器，重启工厂遗漏后形成在线/恢复装配分叉。 | job 全部合法 abort-ticket 历史重放、full/guard 行为矩阵、恢复消费者、明确未配置的 fail-closed 负例及其他 `JobJournal` 冷启动构造器。 | 把测试用 legacy abort 授权器收敛为单一夹具，并由在线与共享重启工厂共同注入；明确未配置负例保持独立。参数化矩阵的 recovery、`not-started-rejected`、`resolution` 三项恢复通过；横扫全部构造器证明无第二处遗漏。 | 已验证 |
| U22-18 | executor 最终包测另有 3 项只在默认 5 秒处超时、无功能断言失败；其中 2 项默认预算定向通过，剩余 1 项默认预算仍超时，但使用 20 秒有界诊断预算后 2.19 秒通过。三个用例均执行多次真实耐久日志/资产 IO，而同包既有耐久测试使用 30 秒预算。 | 重型耐久集成测试没有归入 executor 既有组级预算，依赖默认 5 秒导致包内负载下不稳定。 | conversation 两项 publish/bundle 耐久集成、job 一项交互结算后取消集成、executor 包内并发负载及失败取证。 | 三项统一复用 executor 的 30 秒有界耐久 IO 预算；断言错误仍立即失败，不全局放宽。六项原失败定向全部通过，并以“全包其余 447 项 + 定向 6 项”完成 executor 判定。 | 已验证 |
| U22-19 | conversation/job `issueDataPlaneTicket` 命中既有 ticketId 时只比较 assignment、surface 与 kind，忽略 `ttlMs`，也未完整核对 `replacesTicketId`；同 id 的异载荷会回放原票据，短 TTL 请求甚至可能取得先前更长寿命票据。 | ticketId 被用作幂等身份，但签发请求的完整语义没有耐久化并参与同键冲突判定。 | conversation/job 两域签发与续期、响应丢失重试、TTL 收缩、replacement 原子吊销、同 id 异载荷、full/guard 重放及调用方权限预期。 | 为签发请求冻结完整幂等身份（至少 assignment、surface、kind、ttlMs、replacement），同 ticketId 仅精确同载荷回放原结果，任何异载荷稳定冲突；conversation/job 复用同一谓词并覆盖 TTL 与 replacement 边界。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X22-01 | CLI `tsc --noEmit` 的 8 项 credential projection 错误是否由本单元引入。 | 错误均位于未改的 config-editor/startup 旧路径，与本单元文件和新增符号无交集；CLI 直接测试、全包测试和全量构建通过。 | CLI 类型诊断；V22-04、V22-07、V22-08；指纹 `ddbab254…7642` | 本单元文件出现类型错误，或 credential projection 进入本单元边界 | 已排除 |
| X22-02 | executor 仍保留旧 `surfaceAbort` 测试 seam，是否形成第二条生产授权路径。 | 非测试代码没有构造者注入或调用该 seam；生产 ticket mesh 只调用 `abortWithTicket`，owner 旧日志兼容又被“零票据事实”条件封闭。 | production caller 搜索、V22-03、V22-06；指纹 `ddbab254…7642` | 任一生产构造者注入旧 seam、生产调用 `abortFromSurface`，或兼容条件被放宽 | 已排除 |
| X22-03 | 新 ticket mesh adapter 尚未成为 surface/owner-relay 默认生产路径，是否遗漏第 22 单元功能。 | 第 22 单元负责票据合同、耐久 guard 与接线 seam；owner-relay 整合、路径降级和无损数据面最终启用字面属于第 24 单元，当前提前启用会形成半链路。 | specification 第 22/24 单元；固定边界；V22-04 | 第 24 单元仍未启用，或第 22 单元边界被正式改写 | 已排除 |
| X22-04 | 未知吊销 tombstone 在签发端时钟领先最大允许偏差时，`maxTicketTtl + maxClockSkew` 保留窗是否会早于票据最迟可接收时刻并造成复活。 | 最早吊销时刻可为 `issuedAt - skew`；现保留窗推进后前沿恰为 `issuedAt + maxTtl = expiry`，而准入以 `ticket.expiry <= retiredThrough` 直接拒绝，不使用额外偏差窗，因此迟到票据仍不可接收。 | `retentionDeadline`、`ticketPrecedesRetirementFrontier`、`acceptedRemoteIntervalStatus`；指纹 `1fd89920…acfd` | 保留窗公式、前沿比较字段或远端区间偏差语义任一改变 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L22-01 | U22-03；直接测试通过后 | 定向运行无法模拟 CLI 包内并发负载，且新增耐久 IO 测试没有先查包内既有预算。 | 新增真实文件系统/耐久 IO 测试前先查同包预算并按组复用；首次包测保存机器结果，超时只定向归因，确认预算问题后按失效闭包复核。 | 最终验证:机器结果定位 30.1 秒超时；修复后直接 5/5、CLI 全包 2436/2436；运行手册已登记。第三次冻结终审一:无新增 CLI 耐久 IO 测试，最终机器结果计划保持。第四次终审一:预算与机器结果计划未变化。第五次终审一:无新增耐久 IO 测试，机器结果与预算计划未变。第五次重冻结终审一:无新增耐久 IO 测试，最终验证保留机器结果与组级预算。第五次重冻结终审二:预算与机器结果计划复核不变 |
| L22-02 | U22-09；开发收口与首轮独立终审后 | 逐个验证了 ticket guard、ledger abort 和 proof，却没有把“成功返回但尚未形成终态事实”的跨组件义务沿运行时副作用、耐久前缀、恢复和下游提交串成单一所有权链。 | 对每个提前于终态返回成功的操作，枚举所有可耐久前缀，并证明恰有一个组件负责真实副作用、恢复重驱和最终提交；任一前缀无所有者即登记问题，并一次扫完同类入口。 | 独立复审:横扫 ticket abort、owner cancel 与旧 in-process submission，确认仅 ticket abort 缺失完整所有者，登记 U22-09；第二次冻结终审第一轮:surface answer/abort 成功前缀均有唯一运行时与恢复所有者，无新增。第三次冻结终审一:answer/abort 全前缀仍由 worker 唯一恢复重驱。第四次终审一:唯一所有权链仍闭合。第五次终审一:answer/abort 成功前缀所有者仍唯一。第五次重冻结终审一:answer/abort 成功前缀仍由 worker 唯一恢复重驱。第五次重冻结终审二:逐前缀复核无无主耐久义务 |
| L22-03 | U22-10、U22-13；U22-09 修复通过后 | 只证明了取消义务最终可重驱，没有验证远程 surface 成功是否同时驱动在线 runtime，也没有把每个 owner 失权状态与票据失效放在同一线性化点对账。 | 对每个 surface 成功入口同时追踪在线运行体、耐久事实、镜像/提交和响应丢失重放；对每个 assignment 失权状态枚举同 envelope 的票据吊销及后继签发拒绝。 | 冻结终审第一轮:answer/abort 全前缀与 conversation/job cancel 全入口对账，登记 U22-10、U22-13；第二次冻结终审第一轮:两域入口与 surface 操作再次对账，无遗漏。第三次冻结终审一:两域 cancel/supersede/terminal revocation 与后继签发拒绝完整。第四次终审一:在线运行体与两域失权链仍闭合。第五次终审一:两域失权同点吊销与后继拒绝仍闭合。第五次重冻结终审一:在线运行体、两域失权同点吊销与后继拒绝完整。第五次重冻结终审二:并发与崩溃插点复核仍同点闭合 |
| L22-04 | U22-11；U22-07 修复通过后 | 将“有界退休”只验证到已使用/重启路径，未用时间推进 + 持续 churn + 跨端重复同步证明在线投影与同步前沿都有限。 | 凡声称缓存/投影/墓碑有界，必须以时间推进和持续 churn 检查所有进入、自然到期、同步重放与回收路径，并给出有限前沿。 | 冻结终审第一轮:registry 与 owner facts 横向时间推进，登记 U22-11；第二次冻结终审第一轮:进入、自然到期、重复同步与退休回收前沿对账，无新增。第三次冻结终审一:maintain、retirement retention 与两域有限同步前沿仍闭合。第四次终审一:进入、到期、同步与回收前沿仍有限。第五次终审一:进入、过期、同步、退休与回收仍有界。第五次重冻结终审一:进入、过期、同步、退休和回收前沿仍有界。第五次重冻结终审二:持续运行与重启投影的有限前沿不变 |
| L22-05 | U22-12；U22-08 修复通过后 | 统一底层原语后未搜索仍导出的状态 wrapper、默认参数和未来 seam，第二执行所有者仍可重新制造合同分叉。 | 多执行点合同修复后搜索全部导出、构造者和默认参数；只允许一个状态所有者，纯原语必须要求显式传入会影响身份/摘要的上下文。 | 冻结终审第一轮:executor 导出与第 24 单元 seam 对账，登记 U22-12；第二次冻结终审第一轮:全仓导出/调用/default 搜索仅余纯原语与单一 owner，无新增。第三次冻结终审一:仅余纯 `projectAssignmentInteractionStream`，meta/游标显式。第四次终审一:全仓仍仅纯原语且上下文显式。第五次终审一:导出/调用搜索仍仅纯原语与单一状态所有者。第五次重冻结终审一:导出/调用搜索仍仅纯原语，meta 与游标显式。第五次重冻结终审二:无新增 wrapper、默认上下文或第二状态所有者 |
| L22-06 | U22-14、U22-15；第二次冻结终审第一轮零新增后 | 前轮分别核对了票据到期与取消吊销，却未检查同一凭证在“在线使用、耐久 consumer fence、后继历史证明”三个时点是否错误共享当前态谓词。 | 对每个短期凭证分别列出接收时冻结事实、每次在线使用谓词、下游耐久 fence 与使用后历史证明；用时钟推进/校时和“先使用、后吊销、再交证明”竞态验证后继状态不得改写既成事实。 | 第二次冻结终审第二轮:横扫 registry/spool expiry 与 conversation/job abort proof，登记 U22-14、U22-15；同类凭证消费者无第二处。第三次冻结终审一:实现谓词已单源，但 spec 仍含动态/当前有效性旧表述且 active recovery 缺直接证据，原问题重开。第四次冻结终审一:最后一处旧表述已补齐；新指纹轮再次对账时间/consumer fence/历史证明，无遗漏。第五次终审一:接收冻结、在线资格、consumer fence 与历史证明继续分层。第五次重冻结终审一:接收冻结、在线资格、consumer fence 与历史证明继续分层。第五次重冻结终审二:时钟回拨与先吊销后证明竞态未改变三层谓词边界 |
| L22-07 | U22-16；第四次冻结终审第一轮零新增后 | 已核对在线 abort proof 守卫与历史语义，却未逐个对账同一 proof 在 online、full reducer、submission guard 的谓词输入，导致状态依赖的 owner 历史签发条件只在线生效。 | 凡耐久记录由在线守卫产生，逐字段比较在线、full、guard 的接受谓词；含状态依赖条件时必须作为共享谓词的显式必需输入，并搜索该记录可嵌入的全部终态/containment 形态。 | 第四次终审二:对账两域全部 abort proof 消费点，确认 U22-16 覆盖 cancel accepted、两类 containment、not-started rejection 与 cancel-proof supersede，无第二同类凭证。第五次集中修复:两域 online/full/guard 仅余各自一个状态感知入口，共享谓词必需参数阻止调用点漏传历史签发结果。第五次终审一:两域所有嵌入形态再次逐项对账，无漏接。第五次重冻结终审一:两域所有 proof 嵌入形态只经各自状态感知入口，共享必需参数无漏传。第五次重冻结终审二:伪造历史、兼容 seam 与全嵌入重放复核无谓词分叉 |
| L22-08 | U22-17；第五次重冻结终审两轮零新增后 | 只审查了生产构造器与谓词调用点，未比较测试中在线、重启和负例构造器的必需安全依赖，最终包测才暴露共享重启工厂漏注入。 | 新增或强化构造器安全依赖后，枚举测试中全部在线/重启/恢复构造器并逐字段对账；合法恢复必须复用同一夹具，刻意缺失只允许存在于命名明确的 fail-closed 负例。 | 最终验证回退:横扫 job 文件全部 `JobJournal` 构造器；确认共享 `reopenUserJournal` 是唯一合法恢复遗漏，未配置负例明确保留，system/已终结冷构造器不消费 abort 历史。第六次集中修复:在线与重启工厂共用单一 `legacyAbortTickets` 夹具，4 项恢复路径通过。第六次终审一:再次枚举全部构造器，合法在线/恢复共用夹具，明确负例与不消费 abort 历史的冷构造器边界未变。第六次终审二:独立复核夹具四字段绑定与未配置 fail-closed 负例，未扩大接受面 |
| L22-09 | U22-18；第五次重冻结终审两轮零新增后 | 直接测试耗时未触发默认上限，审查也未把多次真实耐久 IO 的既有用例纳入组级预算；最终包内负载才暴露不稳定。 | 冻结前扫描变更包中执行多次真实文件/日志 IO 的集成测试；不得依赖默认时限，须复用同包既有组级有界预算。全包超时后只定向归因，仍命中默认时限则转测试预算问题而非继续归为噪声。 | 最终验证回退:三个默认 5 秒失败全部定向归因；两项默认通过，一项以 20 秒诊断预算 2.19 秒通过；同包既有耐久组预算为 30 秒。第六次集中修复:三项统一采用 30 秒组级预算，原失败项 3/3 通过。第六次终审一:两个 executor 耐久测试文件共用各自 30 秒组级常量，原失败三项无默认预算残留。第六次终审二:预算仅作为用例级上界，断言与异常传播未修改，无全局放宽 |
| L22-10 | U22-04、U22-19；第六次重冻结终审两轮零新增后 | 只验证了新请求在线准入，没有先按耐久身份区分精确重放与新事实，也没有把同键请求的全部行为字段纳入幂等判别。 | 对每个同键重试入口先比较完整耐久身份，再执行易变当前态守卫；参数化验证精确重放、每个字段异载荷、终态后重放与响应丢失。 | 独立功能终审:登记 U22-04、U22-19；第七次集中修复:registry history-first，owner 两域共用完整请求身份；直接矩阵通过。第七次终审一:两域签发与 registry 准入均先判完整耐久身份，再进入易变态守卫。第七次终审二:同键精确重放、异载荷和终态后重放仍由完整耐久身份先行裁决。 |
| L22-11 | U22-07、U22-14；第六次重冻结终审两轮零新增后 | 已分别检查到期、退休和 consumer fence，却未用前跳→压缩→回拨证明所有缓存、同步前沿及下游资格都不重新读取墙钟。 | 对含过期/压缩的耐久状态执行前跳、维护、回拨、迟到重放和冷恢复；在线资格只允许一个单调时钟所有者，下游只消费显式资格。 | 独立功能终审:登记 U22-07、U22-14；第七次集中修复:两域与 registry 使用耐久不可回退前沿，spool 删除墙钟再裁决；回拨与恢复矩阵通过。第七次终审一:前沿绑定 executor，spool 仅消费显式资格，回拨无第二资格入口。第七次终审二:前跳、维护、回拨、迟到重放与冷恢复未形成第二资格事实；X22-04 未触发重开。 |
| L22-12 | U22-16；第六次重冻结终审两轮零新增后 | 在线与 owner proof 已全字段绑定，但共享 reducer 的增量状态仍压缩了因果身份，未逐字段对账前缀与终态证明。 | 对所有“前缀→终态证明”状态机逐字段比较原始记录、增量状态和 proof；任何被压缩字段都必须证明不参与身份，否则纳入共享状态并补跨页重放反例。 | 独立功能终审:登记 U22-16；第七次集中修复:共享 reducer 保存完整 surfacePrincipal，错 surface proof 与记录矩阵通过。第七次终审一:abort 前缀、增量状态、halted proof 与 owner 历史验证逐字段一致。第七次终审二:在线、冷重放、分页状态及 owner proof 的完整因果身份继续一致。 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V22-01 | 共享票据创建、摘要、用途、绑定与时限合同 | core `data-plane-ticket.test.ts` | core 票据实现、导出与直接测试 | 开发 / 低 / 已完成 | 7/7 通过 | `ddbab254…7642` | 失效 |
| V22-02 | owner 两域签发、续期、吊销、原始 surface 与 abort proof | conversation/job 定向测试；owner-kernel 单包全测 | owner 两域实现、记录合同与 core 票据类型 | 开发与包级 / 中 / 已完成 | 定向矩阵通过；owner 17/17 文件、184/184 项通过 | `ddbab254…7642` | 失效 |
| V22-03 | executor 接受/吊销/恢复、stream 资格、交互投影与真实 ledger 权限 | registry/projector/assignment/job 定向测试 | executor 注册表、ledger、投影、导出与直接测试 | 开发 / 中 / 已完成 | registry/projector 2/2；记录矩阵 4/4；第一方交互、abort 与两域权限矩阵通过 | `ddbab254…7642` | 失效 |
| V22-04 | ticket/stream mesh 请求响应绑定与本地等价 | CLI data-plane ticket/stream mesh 定向测试 | CLI adapter、core 合同、executor 接口与直接测试 | 开发 / 低 / 已完成 | ticket mesh 7/7；stream mesh 5/5 通过 | `ddbab254…7642` | 失效 |
| V22-05 | core 与 owner 既有行为回归 | core、owner-kernel 单包全测，机器结果 | 对应包源码、测试与当前上游产物 | 包级 / 中 / 已完成 | core 716/716 文件、2418/2418 项；owner 17/17 文件、184/184 项通过 | `ddbab254…7642` | 失效 |
| V22-06 | executor 全记录状态机与既有行为回归 | executor `tsc --noEmit`；单包全测机器结果 | executor 源码、测试、core/owner 当前类型与产物 | 包级 / 高 / 已完成 | 类型通过；32/32 文件、447/447 项通过 | `ddbab254…7642` | 失效 |
| V22-07 | CLI adapter、入口与既有行为回归 | CLI 单包全测首次机器结果、失败定向归因、预算修正后包测 | CLI 源码、测试与当前上游产物 | 包级 / 高 / 已完成 | 首轮仅 U22-03 超时；定向 1/1、文件 5/5；最终 629/629 文件、2436/2436 项通过 | `ddbab254…7642` | 失效 |
| V22-08 | 格式、最终产物与交付机械闭包 | Biome 变更源码；`pnpm build`；`git diff --check`、注释债务扫描与指纹 | 21 个非工作台交付文件及完整工作区构建配置 | 最终 / 高 / 已完成 | Biome 20/20；17 个工作区包构建通过；机械检查无问题，指纹一致 | `ddbab254…7642` | 失效 |
| V22-09 | U22-04～U22-09 合并直接验证 | core authority/ticket 18/18；executor registry 2/2、ledger 2/2、interaction projector；CLI ticket mesh/worker/shared projection 16/16；executor build+DTS | 六项修复涉及的 core、owner、executor、CLI 直接合同及当前上游产物 | 集中修复 / 中 / 已完成 | 全部通过；CLI 旧夹具缺新端口的 3 项失败定向修正后 3/3 通过，未重跑已绿用例 | `d425f555…0bf2` | 失效 |
| V22-10 | 冻结前交付与派生产物机械闭包 | 28 文件枚举与内容指纹；`git diff HEAD --check`；派生资产与注释债务扫描；Biome 变更文件 | 28 个非工作台交付文件 | 冻结准备 / 低 / 已完成 | diff check、Biome 通过；无 lock/schema/golden 变化；指纹 `d425f555…0bf2` | `d425f555…0bf2` | 失效 |
| V22-11 | 旧冻结输入的最终构建与受影响包回归 | 先单独 `pnpm build`；成功后按 core→owner-kernel→executor→CLI 串行运行各包 Vitest 全测并保存机器结果 | 旧 28 文件闭包 | 最终 / 高 / 未执行 | U22-10～U22-13 导致旧冻结失效 | `d425f555…0bf2` | 失效 |
| V22-12 | U22-10～U22-13 合并直接验证与重新冻结 | owner-kernel build；executor 定向 7/7、registry 4/4、纯投影 1/1、类型检查；CLI worker/ticket mesh/observer 20/20；CLI 类型诊断；Biome 27 文件、diff/派生资产/注释扫描与 29 文件指纹 | 四项修复涉及的 owner、executor、CLI 合同、直接测试及 29 个非工作台交付文件 | 集中修复与冻结准备 / 中 / 已完成 | 全部新增与直接相关测试通过；CLI 仅 X22-01 的 8 项既有错误；无派生资产变化，指纹已冻结 | `aa3c8165…aefd` | 失效 |
| V22-13 | 旧冻结输入的最终构建与受影响包回归 | 先单独 `pnpm build`；成功后按 core→owner-kernel→executor→CLI 串行运行各包 Vitest 全测并保存机器结果 | 旧 29 文件闭包 | 最终 / 高 / 未执行 | U22-14、U22-15 修复导致旧冻结失效 | `aa3c8165…aefd` | 失效 |
| V22-14 | U22-14、U22-15 合并直接验证 | owner-kernel build；executor 稳定 expiry、conversation/job 吊销后 proof 与未配置 fail-closed 定向测试；executor `tsc --noEmit` | 旧 registry、spool 资格、owner 两域共享 proof 谓词与直接测试 | 集中修复 / 中 / 已完成 | 后续架构文字与 active-recovery 测试补齐使输入变化 | `2b297e22…e5f5` | 失效 |
| V22-15 | 旧交付物冻结与派生产物闭包 | 30 文件枚举及 path/blob-manifest SHA-256；Biome 7 个变化文件；`git diff HEAD --check`；派生资产与注释债务扫描 | 旧 30 文件闭包 | 冻结准备 / 低 / 已完成 | 后续补齐使旧指纹失效 | `2b297e22…e5f5` | 失效 |
| V22-16 | U22-14、U22-15 完整补齐与重新冻结 | registry active-recovery 稳定 expiry 单例；旧架构表述全仓搜索；Biome 变化测试；`git diff HEAD --check`；30 文件 path/blob-manifest SHA-256 | 旧 30 个非工作台交付文件 | 集中补齐与冻结准备 / 低 / 已完成 | U22-16 修复改变输入闭包 | `607a8680…0658` | 失效 |
| V22-17 | U22-15 最后一处架构文字补齐与重新冻结 | 总纲/执行文档同类措辞全量搜索；`git diff HEAD --check`；30 文件 path/blob-manifest SHA-256 | 旧 30 个非工作台交付文件 | 集中补齐与冻结准备 / 低 / 已完成 | U22-16 修复改变输入闭包 | `99d1bcf7…64e7` | 失效 |
| V22-18 | U22-16 合并直接验证与重新冻结 | owner-kernel 类型检查与构建；共享 proof 合同；上游构建后 conversation/job 真实票据正向及伪造/未配置负向定向；Biome；online/full/guard 调用点搜索；`git diff HEAD --check`；31 文件 path/blob-manifest SHA-256 | owner 两域共享 proof 谓词、全部调用点、直接测试及当前 31 个非工作台交付文件 | 集中修复与冻结准备 / 中 / 已完成 | owner 类型检查、构建与共享合同 53/53 通过；当前 owner 产物下两域 6 项定向闭合，其中首轮 5/6 暴露兼容错误语义，修正并重建后唯一失败单例通过；Biome、调用点、diff 与派生资产检查通过，31 文件重新冻结 | `04c2aba6…c493` | 有效 |
| V22-19 | 同一冻结输入的最终构建与受影响包回归 | 确认无同闭包验证进程；单独 `pnpm build`；成功后按 core→owner-kernel→executor→CLI 串行运行各包 Vitest 全测并保存机器结果；最后执行 diff、文件集与指纹机械检查 | 31 文件闭包、完整工作区构建配置、core/owner-kernel/executor/CLI 源码测试及依赖产物 | 最终 / 高 / 已中断 | 构建 17 包、core 716/716 文件 2418/2418 项、owner 17/17 文件 184/184 项通过；executor 32 文件 453 项中 447 项通过，3 项默认时限超时、3 项暴露 U22-17 | `04c2aba6…c493` | 诊断 |
| V22-20 | U22-17、U22-18 集中修复、定向归因与重新冻结 | legacy 授权夹具单源搜索；job recovery/record matrix 3 项；executor 三项时限失败在 30 秒组级预算下定向运行；Biome、diff、文件集与新指纹 | job 测试在线/重启构造器、6 项失败用例、当前非工作台交付闭包 | 集中修复与冻结准备 / 中 / 已完成 | job 定向 4/4、conversation 定向 2/2 通过；Biome 2 文件、executor 类型检查与 `git diff HEAD --check` 通过；31 文件重新冻结 | `4cb21097…2012` | 有效 |
| V22-21 | 新指纹最终验证与机械收口 | 复用输入闭包未变的构建/core/owner 结果；executor 按运行手册以全包其余 447 项 + 当前 6 项定向结果判定；CLI 单包 verbose+JSON；最终 diff、文件集、指纹、进程与临时文件检查 | 当前 31 文件闭包、完整构建配置及 core/owner/executor/CLI 各自输入闭包 | 最终 / 高 / 已完成 | 17 包构建、core 2418/2418、owner 184/184 证据有效；executor 类型与 453 项组合证据通过且未重跑整包；CLI 173/173 文件、2441/2441 项通过；diff 无错误，31 文件指纹一致，无残留进程/临时文件 | `4cb21097…2012` | 有效 |
| V22-22 | U22-04、U22-07、U22-14、U22-16、U22-19 合并直接验证与冻结准备 | core/owner/executor 类型检查；core 构建与 executor stream 准入单例；registry 历史/回拨/外国前沿、spool 单调资格、abort 完整因果、两域幂等身份定向测试；结构 golden 显式更新、差异审阅与只读复核；Biome、diff、文件集与指纹 | 五项修复涉及的 core、owner、executor、CLI 合同、直接测试、server 结构基线及 37 个非工作台交付文件 | 集中修复与冻结准备 / 中 / 已完成 | 三包类型、core 构建及全部直接场景通过；结构门禁 1/1、Biome 34 文件、diff check 通过；37 文件冻结 | `1fd89920…acfd` | 有效 |
| V22-23 | 同一冻结输入的最终构建与受影响包回归 | 确认无同闭包进程；单独 `pnpm build`；按运行手册逐包串行运行精确受影响包全测并保存机器结果；复核结构门禁、diff、文件集、指纹、进程与临时文件 | 当前 37 文件闭包、完整构建配置及受影响包源码/测试/依赖产物 | 最终 / 高 / 已完成 | 17 个工作区包构建通过；core 716/716 文件、2419/2419 项，owner 17/17 文件、186/186 项通过；executor 全包 458/460 项通过，2 项仅命中默认 5 秒且定向 2/2 通过，按运行手册组合为 460/460；CLI 173/173 文件、2441/2441 项与结构门禁 1/1 通过；diff 无错误，37 文件指纹一致，无残留验证进程或临时文件 | `1fd89920…acfd` | 有效 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | U22-04～U22-08 | `ddbab254…7642` | 5 个真实问题，未通过 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | U22-09；U22-05 补齐签发身份影响面 | `ddbab254…7642` | 累计 6 个待修复问题，同类面已收齐，未通过 |
| 冻结终审第一轮 | 在线/耐久所有权、时间空间上界、投影单源、取消失权链 | 是 | U22-10～U22-13 | `d425f555…0bf2` | 4 个真实根因，同类入口已收齐，未通过 |
| 第二次冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无 | `aa3c8165…aefd` | 零新增，第一轮通过 |
| 第二次冻结终审第二轮 | 并发、崩溃、时钟、安全、异常终态与历史证明 | 是 | U22-14、U22-15 | `aa3c8165…aefd` | 2 个真实根因，同类面已收齐，未通过 |
| 第三次冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无新增；U22-14、U22-15 未彻底封板 | `2b297e22…e5f5` | 实现无新增问题；架构文字与 active-recovery 证据待补，未通过 |
| 第四次冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无 | `99d1bcf7…64e7` | 零新增，第一轮通过 |
| 第四次冻结终审第二轮 | 并发、崩溃重放、安全、异常终态与 online/full/guard 等价性 | 是 | U22-16 | `99d1bcf7…64e7` | 1 个真实根因，同类重放面已收齐，未通过 |
| 第五次冻结终审第一轮（失效） | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无新增根因；U22-16 兼容错误语义未闭合 | `e5d563c5…ca21` | 后续修复改变交付物，本轮不计入连续轮次 |
| 第五次重冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无 | `04c2aba6…c493` | 零新增，第一轮通过 |
| 第五次重冻结终审第二轮 | 并发、崩溃、时钟、安全、资源上界、异常终态与 online/full/guard 等价性 | 是 | 无 | `04c2aba6…c493` | 零新增，第二轮通过 |
| 最终验证回退 | 包级机器结果、测试装配与失败归因 | 是 | U22-17 | `04c2aba6…c493` | 新问题成立，解冻集中修复 |
| 第六次重冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链与回归 | 是 | 无 | `4cb21097…2012` | 零新增，第一轮通过 |
| 第六次重冻结终审第二轮 | 并发、崩溃恢复、安全、资源上界、异常终态与测试装配等价性 | 是 | 无 | `4cb21097…2012` | 零新增，第二轮通过 |
| 独立功能终审 | 当前架构与完整生产/消费链重新核查：签发、同步、registry、spool、interaction、abort proof 与恢复 | 是 | U22-04、U22-07、U22-14、U22-16 重开；新增 U22-19 | `4cb21097…2012` | 5 个真实问题，解冻等待集中修复 |
| 第七次集中修复 | 耐久身份优先、不可回退时间前沿、完整幂等与因果身份 | 是 | 无新增；U22-04、U22-07、U22-14、U22-16、U22-19 已验证 | `1fd89920…acfd` | 修复与冻结准备完成，等待两轮独立冻结终审 |
| 第七次冻结终审第一轮 | 需求、架构、功能闭环、状态、入口、生产/消费链、生命周期、权限与回归 | 是 | 无 | `1fd89920…acfd` | 零新增，第一轮通过 |
| 第七次冻结终审第二轮 | 并发、崩溃、时钟、安全、资源上界、异常终态与耐久义务重驱 | 是 | 无 | `1fd89920…acfd` | 零新增，第二轮通过 |
| 最终验证收口 | 构建、受影响包回归、结构门禁及交付机械闭包 | 是 | 无 | `1fd89920…acfd` | 全部必要验证通过，单元完成 |

<!-- registration-complete: unit-22.gen-1 -->
