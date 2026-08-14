# 单元登记:第 38 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:38
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-14
- **登记来源**:用户要求将第 38 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U38-01～U38-08 已在冻结指纹上完成实现、最小必要验证、专项功能审查与四路冷启动对抗，八项均已验证；未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2
- **交付物是否冻结**:是（仅用于本批八项专项收口）
- **交付物文件集**:第38单元当前完整交付物；集中修复后按发布协议、五目标产物、CLI更新、两根装配、生命周期、文档与验收资产重新登记精确闭包
- **当前交付物指纹**:`affe17418108f656ea85d6b867945031f82127b75c1ffcee7f1798cfe176e0d8`（36个生产/直接测试/脚本/golden文件，排除workbench状态文档）
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`、`research/design/modules/distributed-runtime/release-and-maintenance-guide.md`、`research/design/modules/distributed-runtime/unit-38-final-acceptance-ledger.json`及已定稿开发清单D38-01～D38-10

## 固定边界

- **功能范围**:S10升级兼容、五目标发布与最终验收；交付stable-only自动更新、ProgramStore安全切版与恢复、应用移除、离线诊断、旧路径退役、发布工具和最终验收闭包
- **架构不变量**:现有release identity、ProgramArtifact、ProgramStore、DeviceLifecycleJournal、DeliveryAuthority、current authority和bound inactive server是唯一事实与执行边界；更新不阻塞启动和首个输入，已接纳工作不丢失，坏candidate不公开ready，current始终可安全使用或恢复
- **验收条件**:五目标真实安装/更新/恢复/移除闭合；切版、迟到delivery、两根health、pure surface和故障重启唯一收敛；P0/P1清零后按既定冻结终审、独立功能审查和单元提交验证完成封版
- **必要上下游**:直接复用第30～37单元已封版的owner/transfer/checkpoint/trust/exposure/supervisor/stop/removal合同，不重做其内部实现
- **明确不属于本单元**:自动failover、quorum、多活、全局或持续同步、恢复应用；多发布通道、灰度和企业策略；独立updater daemon；远程批量管理和应用商店分发；通用updater/lifecycle/manifest/storage/secret/诊断/遥测框架；benchmark、内部诊断采集、真实私钥、商店账号和外部发布动作

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
| U38-01 | **P0/大。** `build-release-artifact.mjs`只封装外部目录；仓库没有自包含Node 22程序树、稳定launcher、installer/uninstaller或五目标正式产物，channel/trust未嵌入，app-remove测试伪造installer；sequence高水位只能由尚不存在的安装闭包持有。用户当前无法完成首次安装、自动更新、无home重放或保留数据的应用移除。**价值裁决记录（完整转入）：**原R38-01为P0/大、R38-05为独立P1/中；反向核验表明高水位没有独立可执行入口，只能与installer/program receipt同时建立，分拆会让执行者重复设计安装身份。新决定是维持R38-01的P0/大并吸收R38-05；若未来正式installer已存在独立耐久高水位而五目标装配仍缺失，才按新的生产事实拆分重开。最终结论：改写并保留；用户体验达标、架构达标。 | 发布构建只校验调用方准备的目录，没有由同一release identity生产、安装、重放、移除并保留反降级事实的程序层闭包。 | 生产端：五目标runtime tree、launcher、installer/remover、签名/公证后artifact/index及已验安装receipt。类型组合：五target、首次/同版本/旧sequence/同identity异bytes、有无home、Unicode/空格路径。消费者：`zz`/`zhixing`、自动更新、app remove、release:check和12项release smoke。异常终态：构建/安装/移除响应丢失、重装回退、错target或坏bytes必须零半安装、零用户数据删除并可重放。测试：五目标真实安装/启动/更新/移除、内容exact-set、反降级及正式release matrix。受影响审查项：IR38-02、IR38-06～IR38-08、IR38-21、IR38-24～IR38-25、IR38-28、IR38-30～IR38-31。 | 以现有release identity/ProgramArtifact为唯一合同，从workspace production allowlist生成五目标自包含Node 22程序树、固定`zz/zhixing` launcher及installer/remover；平台签名/公证后冻结最终bytes，嵌入同一stable URL/trust。installer在程序根之外维护唯一已验`target+keyId+releaseVersion+sequence+manifestDigest` receipt：首次安装仅在完整树和launcher全等回读后提交；同身份同bytes返回原效果，旧sequence或同身份异bytes在写程序前拒绝；app remove只删除launcher/version/stage并保留receipt与全部home。完成：五目标在无home、Unicode/空格路径和各效果/响应窗口下安装、启动、exact replay、升级与移除唯一收敛，release:check只消费这批最终产物，包内无home/secret/source/test/dev dependency。 | 已验证 |
| U38-02 | **P0/中。** stage rename、pointer switch、journal advance、terminal/receipt和previous swap分属多个效果；恢复用旧generation代替效果read-back，已存在version目录不复验，显式restore直接换pointer。响应丢失或崩溃后可永久卡住、执行未经复验目录或二次换回坏版本。最终结论：保留；用户体验达标、架构达标。 | ProgramStore外部效果与DeviceLifecycleJournal phase没有以exact achieved事实幂等对账，guided restore又绕开同一生命周期与health门禁。 | 生产端：stage/version/pointer/receipt及upgrade lifecycle。类型组合：stage→version、pointer前后、current/previous、正确/错误generation与manifest、自动/显式恢复。消费者：startup resumer、anchor/executor health、CLI update/status。异常终态：每个sync/rename/advance响应丢失及连续重启必须唯一前滚或fail-closed，不能执行坏目录或虚假恢复。测试：逐phase崩溃窗口、错目录/错generation、previous启动health和连续重启。受影响审查项：IR38-10、IR38-13～IR38-14、IR38-16、IR38-20、IR38-27、IR38-30～IR38-31。 | 只用现有ProgramStore与DeviceLifecycleJournal给每个phase定义exact achieved谓词：stage/version必须全等manifest、artifact和展开文件；pointer若仍是冻结source则切换一次，若已是同operation目标且generation/previous全等则只补journal，其他状态fail-closed；terminal已提交但receipt/cleanup响应丢失时由同operation历史和现有receipt身份补齐。自动与显式previous恢复均进入同一upgrade lifecycle和U38-05 health，恢复时只把冻结的已验source置为current，不得把失败candidate登记为可再次恢复的previous。完成：rename/pointer/advance/terminal/receipt各窗口与连续重启只前滚一次，坏目录、错generation和错previous零执行。 | 已验证 |
| U38-03 | **P0/中。** upgrade会close gate、freeze十owner并drain，却未复用既有`installLifecycleAdmission/onFrozen`；冻结source在gate→freeze后产生的delivery不保证进入settlement，已接纳结果可在耐久投递前被升级停止。最终结论：保留；用户体验达标、架构达标。 | 升级只收束owner快照，没有把frozen causal source与其迟到delivery绑定到同一operation并共同封闭。 | 生产端：ProgramUpgradeCoordinator、十owner freeze、七类source companion、DeliveryAuthority admission/sealed。类型组合：source空/非空、enqueue前后、late/fresh、三运行形态及重启。消费者：delivery pipeline、upgrade work-settled/ready与最终用户结果。异常终态：响应丢失、source终结、delivery重试/uncertain和连续重启下不得漏项、重复或早ready。测试：十owner×七source直接场景、barrier竞争与真实authority read-back。受影响审查项：IR38-12、IR38-26～IR38-27、IR38-31。 | 让ProgramUpgradeCoordinator在现有freeze回调处把artifact中的七类exact source与当前delivery安装进同operation的DeliveryAuthority admission；source owner仍按冻结`kind/id/revision`收束，delivery owner最后seal并read-back全部terminal后才允许`work-settled`。startup在任何producer恢复前按operation+artifact+phase恢复同一admission/sealed；fresh或冲突source在父提交前拒绝，迟到delivery恰一绑定原operation。完成：十owner、七source、enqueue前后、uncertain、响应丢失和连续重启下集合共同封闭且零早ready。 | 已验证 |
| U38-04 | **P1/中。** REPL/serve在角色解析前无条件启动本机updater，surface/empty读本机receipt；check会覆盖sticky action-required，updated/restored又无消费终态。pure surface会对错误设备产生更新副作用并展示错误状态。**价值裁决记录（完整转入）：**原方案还要求doctor/health接入“真实schema activation”；当前十三项writer均为v1，不存在可达activation，加入它会制造第二事实和无用户价值复杂度。新决定删除activation扩面，保留current-authority、sticky action与一次性成功消费；若任一durable writer版本实际提升，再按EX38-01的重开条件单独复审。最终结论：改写并保留；用户体验达标、架构达标。 | 更新trigger早于topology裁决，公开状态分别读取本机receipt而非current authority；receipt notice缺少稳定行动和一次消费的产品终态。 | 生产端：REPL/serve updater装配、ProgramUpdateReceipt与纯projection builder。类型组合：foreground/on-demand/managed、surface/empty、离线/失败/换代/重启。消费者：CLI/server/status/doctor/input area/第一方surface。异常终态：网络失败不得覆盖action-required，旧success不得重复提示，pure surface本机零updater/home/listener。测试：三形态与pure surface同输入同结果、current-anchor换代、sticky行动和成功恰一消费。受影响审查项：IR38-08、IR38-11、IR38-19、IR38-29～IR38-31。 | topology确定后仅真实本机host启动updater；surface/empty本机零updater/home/listener，只经既有current-authority认证有限入口读写当前锚点通知。抽取只消费receipt、pointer、已验stage、active lifecycle与U38-05 health的纯projection builder，CLI/server/status/doctor/input area共用；action-required在同candidate检查失败时不被checking覆盖，只由候选换代、成功或用户exact dismiss结束；updated/restored以同receipt通知token做compare-and-consume，响应丢失可重放、旧token不清新通知。完成：三形态、离线、换代和重启下同一current authority只显示固定文案与一个行动，成功恰一呈现，pure surface零本机副作用。 | 已验证 |
| U38-05 | **P1/中。** anchor在server监听后才做loopback health，executor仅核对pointer即`completeHealthy`；同一trust/home/role/endpoint身份未在公开ready前共同验证，错误candidate可先服务并永久标healthy。**价值裁决记录（完整转入）：**原结论把“实际schema activation”列为健康必要输入；当前版本只有v1静态writer合同，不能证明activation有当前价值。新决定收窄为现有发布、信任、角色和端点事实，评级与工作量不变；writer版本提升时再按明确版本跃迁事实重开schema健康项。最终结论：改写并保留；用户体验达标、架构达标。 | anchor/executor使用不同health判据且健康线性化晚于公开ready，没有共享同代纯snapshot。 | 生产端：anchor/executor candidate startup、bound inactive server、health snapshot与completeHealthy。类型组合：两根、三运行形态、正确/漂移的release/protocol/v1 schema/trust/home/role/endpoint。消费者：listener/ready、upgrade lifecycle、automatic previous recovery。异常终态：坏candidate零ready/零业务分派并进入U38-02恢复，success只能由同一snapshot授权。测试：两根同矩阵、ready窗口、identity漂移和恢复响应丢失。受影响审查项：IR38-15、IR38-27、IR38-29～IR38-31。 | 复用U37既有同home bound inactive server，在anchor/executor完成所选runtime装配但激活router/ingress和发布ready前调用同一纯builder；snapshot全等绑定target manifest、protocol、静态v1 schema、signed trust generation/digest、home、role plan与exact bound endpoint，不依赖尚未激活的loopback RPC。只有同snapshot写入upgrade health并read-back后才激活原server对象；任一漂移保持inactive并进入U38-02同operation previous恢复。完成：两根、三形态、ready各窗口与响应丢失下坏candidate零业务分派，healthy仅由同一snapshot授权。 | 已验证 |
| U38-06 | **P2/小。** decoder接受2GiB总工件，下载、JSON/base64解码和展开会产生多份内存占用且无磁盘预检；当前没有五目标正式工件，也无证据表明真实产品接近该上限，实际损失是异常包或低容量设备的一次安全失败。**价值裁决记录（完整转入）：**原结论把实现自设的2GiB上限当作必须支持的产品场景，并据此要求流式解码、分页清理等中型基础设施；没有真实正式包或用户需求支持该前提。新决定改为事实化包体上限与容量预检，删除通用流式/清理扩面；若正式最小包体本身超过目标设备可安全处理的上限，再以真实产物和设备容量重开。最终结论：由P1/中降级并改写；用户体验达标、架构达标。 | 协议资源上限由宽泛实现常量决定，未与实际五目标正式产物和设备临时空间约束共用。 | 生产端：ProgramArtifact decoder、download/stage与release:check。类型组合：五target真实最大包、超限包、容量充足/不足、断流续传。消费者：updater、ProgramStore和current host。异常终态：超限/不足须在stage/pointer前失败且current不污染。测试：真实最大产物、上限边界、空间不足和续传。受影响审查项：IR38-04、IR38-09、IR38-17。 | 用一个版本化ProgramArtifact有限策略记录五目标最终包实测最大archive/expanded bytes与固定headroom，protocol decoder、release:check和updater共用，删除2GiB宽泛常量。下载前在ProgramStore所在卷按partial+artifact+最坏展开+durable temp预检，artifact验签解码后再按文件总量精确复验，继续复用4MiB range续传；任一不足在stage/pointer/lifecycle accept前结束。完成：五目标最大正式包可安装，边界外包和容量不足零current污染，内存随有限正式包上界而非任意2GiB增长。 | 已验证 |
| U38-07 | **P2/小。** `withProgramLock`超过五分钟便删除锁，不验证存活owner；慢下载跨窗时两个update可互相破坏partial/stage/receipt，通常表现为本次更新失败，current pointer仍受校验保护。**价值裁决记录（完整转入）：**原结论把并发更新失败直接等同耐久身份破坏并评P1；生产顺序在下载/stage校验失败时仍保护current，当前损失主要是可重试失败。新决定降为P2并复用现有FileLock；若证明存活owner抢占可越过manifest/read-back改写current，再按该生产证据重开P1。最终结论：由P1/小降级；用户体验达标、架构达标。 | 更新路径重复实现了仅按mtime判断失主的锁，没有复用项目已有token、heartbeat和owner存活原语。 | 生产端：`withProgramLock`、download/stage/receipt writer。类型组合：长下载、双进程、owner存活/崩溃/PID复用、接替。消费者：自动和显式update。异常终态：存活owner不可被抢占，失主后恰一接替，current不污染。测试：真实双进程、heartbeat、crash takeover与响应丢失。受影响审查项：IR38-09～IR38-10、IR38-20。 | 让`withProgramLock`成为现有core `FileLock`的窄适配：固定program-root lock路径和resourceName，进入任务前取得token/heartbeat/live-owner事实，finally只compare-token release；等待超时只返回已有稳定“更新正在进行”，不删除存活owner。完成：慢下载、双进程、owner崩溃/PID复用和接替下恰一writer，stale释放不误删新锁，partial/stage/receipt/current不交叉污染。 | 已验证 |
| U38-08 | **P2/小。** `--skip-workspace-gates`可写`passed`，ledger只严格枚举18个invariant，其余分类只要求至少一行；channel/trust缺失属于U38-01，release report可确定性重建。**价值裁决记录（完整转入）：**原方案把channel/trust、五目标产物、report fsync/read-back和ledger exactness并成P1/中；前两者同根归U38-01，可重建report的响应丢失也不需要运行时耐久级别。新决定只保留旁路与50 id的小型门禁修正；若外部发布系统把report当不可重建的唯一发布授权，再基于该真实消费链重开耐久要求。最终结论：由P1/中降级并改写；用户体验达标、架构达标。 | 发布验收工具允许显式绕过workspace门禁，且固定ledger集合未在单一strict decoder中完整校验；原问题还混入了产物装配和过强耐久要求。 | 生产端：release:check参数、50行ledger decoder和passed report。类型组合：正常/跳过gate、50 id齐全/缺失/重复、可重建report响应丢失。消费者：发布维护者与候选验收流程。异常终态：跳过任一gate或固定id缺失不得生成新passed，正常输入可确定性重跑。测试：旁路负例、50 id exact-set与正常报告。受影响审查项：IR38-25～IR38-31。 | 删除`--skip-workspace-gates`及任何能在未完成workspace gate时生成passed/publish-index的分支；在release tooling定义固定50个acceptance id exact-set，decoder同时拒绝缺失、额外、重复和分类错位，并逐行核对非空producer/consumer/compositionRoot/terminal及存在的tests。channel/trust继续由U38-01最终产物反绑；report只做可重建原子替换。完成：任一gate或固定id异常零新passed/零publish，正常五目标证据可确定性重跑。 | 已验证 |

### U38-01～U38-08 固定事实矩阵

| 矩阵 | 覆盖变体 | 稳定身份与唯一事实 | 线性化点、零副作用终态与直接验收 |
| ---- | -------- | ------------------ | ---------------------------------- |
| F38-01 · 五目标安装与反降级 | 五target；首次、exact replay、更新、app remove；无home；Unicode/空格；旧sequence；同identity异bytes；各安装/移除响应窗口 | signed index/manifest/ProgramArtifact最终bytes；程序根外installer receipt的`target+keyId+releaseVersion+sequence+manifestDigest` | 完整树/launcher全等回读后提交receipt；旧/冲突输入在程序写前拒绝；remove只删程序层并保留receipt/home；五目标真实安装、启动、重放、更新、移除与12项smoke穿过正式installer |
| F38-02 · ProgramStore/lifecycle恢复 | stage/version/pointer/previous；各phase效果前后与连续重启；自动/显式恢复；terminal/receipt丢响应 | upgrade operation identity、accepted artifact、ProgramStore pointer generation及每phase achieved谓词 | exact read-back先于phase推进；已实现效果只补journal，未实现只执行一次，冲突fail-closed；恢复只回到冻结已验source且通过F38-05，坏candidate不成为previous；terminal receipt可由同operation历史补齐 |
| F38-03 · frozen source/delivery闭包 | 十owner、七source；enqueue前后；late/fresh；retry/uncertain；三形态；响应丢失与重启 | accepted-work artifact与DeliveryAuthority同operation admission/sealed | freeze后安装exact source/delivery，source逐项终结，delivery最后seal/read-back；startup在producer前恢复；fresh/冲突source零父提交，late delivery恰一进入原operation，集合全terminal后才`work-settled` |
| F38-04 · current-authority更新体验 | foreground/on-demand/managed；surface/empty；离线、失败、换代、重启；action-required、updated、restored | current authority上的receipt+pointer+stage+lifecycle+health纯投影；receipt notice token | topology后仅真实host启动updater；surface本机零副作用；失败不覆盖sticky行动，success/restore exact compare-and-consume；同一current anchor全部消费者固定文案、一个行动，旧token零误清 |
| F38-05 · 两根candidate health | anchor/executor；三形态；release/protocol/static-v1-schema/trust/home/role/endpoint正确或漂移；ready各窗口 | exact bound inactive server与两根共用的同代纯health snapshot | runtime装配完成、ingress激活前全等验证并耐久read-back；成功激活同一server对象，失败保持inactive并走F38-02；坏candidate零ready/零分派 |
| F38-06 · 工件资源上界 | 五目标最大正式包；archive/expanded边界；容量充足/不足；断流续传 | 版本化有限ProgramArtifact策略及实际artifact bytes/file sizes | 下载前按同卷最坏预算预检，验签解码后精确复验；超限/不足在stage/pointer/lifecycle前结束，current不污染；现有4MiB续传不变 |
| F38-07 · program lock单飞 | 慢下载、双进程、live/crashed owner、PID复用、接替、release响应丢失 | core FileLock token、heartbeat、owner liveness与compare-token release | lock取得是writer线性化点；live owner不可被mtime抢占，失主后恰一接替，旧owner/stale release不删新锁；真实双进程验证partial/stage/receipt/current零交叉污染 |
| F38-08 · release固定门禁 | workspace gate；50 id齐全/缺失/额外/重复/错分类；report响应丢失 | 固定50 id exact-set、五目标最终证据与当前source/package输入摘要 | 所有gate与逐id验证完成后才原子写passed/publish；任何旁路或异常零新passed；report可确定性重建且不升级为运行时耐久事实 |

### 同根反证账

| 编号 | 首次出现事实 | 归属 | 耐久处置 | 状态 |
| ---- | ------------ | ---- | -------- | ---- |
| C38-C01 | 冻结指纹冷审发现`ProgramStore.verifyExpanded()`只校验artifact列出的文件bytes，未枚举版本目录中的额外文件或符号链接；既有version可夹带未声明代码而通过stage/version achieved read-back。 | U38-02 | 在既有ProgramStore内对`program/`执行有限递归exact-set回读：实际文件与由artifact推导的目录集合必须全等，拒绝符号链接及其他entry；直接测试注入额外文件、目录和链接并证明pointer/lifecycle零推进。 | 修复后复核通过：真实ProgramStore额外目录/文件反例均fail-closed，pointer不推进 |
| C38-C02 | 冻结指纹冷审发现稳定`launch.js`/installer由旧bootstrap Node直接import candidate应用，且health不核对实际`process.versions.node`；Node 22 patch换代时会用旧runtime运行新版本并可能误标healthy。 | U38-01、U38-05 | 稳定loader只读取current pointer并spawn该version目录内已验runtime与固定entry；候选health把manifest Node版本与实际进程版本全等反绑，漂移保持inactive并进入既有恢复。 | 修复后复核通过：五target的app/installer loader均反绑version runtime，runtime漂移health拒绝 |
| C38-C03 | 冻结指纹冷审发现current-authority status只消费receipt，未对账pointer、已验stage、active lifecycle与candidate health；过期或伪造receipt可长期显示虚假安装/成功状态。 | U38-04 | 抽取同一纯projection builder；current-authority入口收集receipt、pointer、已验stage、lifecycle和health后一次投影，任一身份矛盾稳定转为action-required，所有公开消费者继续只读该入口。 | 修复后复核通过：真实ProgramStore一致事实显示success，伪receipt稳定转action-required |

### 冻结指纹专项功能审查与四路冷启动对抗

| 角色 | 冷启动重造反例与直接交界 | 冻结指纹结论 |
| ---- | ------------------------ | ------------ |
| 专项功能审查 | 逐格从当前生产调用图重建F38-01～F38-08，复验release/receipt、ProgramStore/lifecycle、DeliveryAuthority、current-authority projection、两根health、容量、FileLock、release门的稳定身份、唯一事实、线性化点、资源上界和零副作用终态；直接对账C38-C01～C38-C03。 | 八个矩阵格均能由冻结源码与V38-01～V38-05直接证据推出；测试结果未替代功能判断，三项新增反证均已穿过production helper/store/root修复并复核，无未处置格。 |
| 五目标安装发布/反降级与资源边界 | 重新从五target首次、exact replay、旧sequence、同identity异bytes、无home、Unicode/空格、app remove后重装、超archive/expanded/file、容量不足、断流续传及50-id/gate异常推导F38-01/F38-06/F38-08；核查U38-01↔U38-06↔U38-08。 | `affe174…e0d8`上release/index/manifest/artifact/外置receipt唯一绑定；stable app/installer loader启动pointer所指version runtime，旧/冲突输入零程序写；有限资源策略由decoder/store/release门共用，固定50 id与workspace gate无passed旁路。 |
| ProgramStore切版恢复与candidate health | 抛开既有结论重造stage/version/pointer/previous各效果与响应窗口、额外entry、五phase连续重启、两根三形态ready窗口、Node/runtime/trust/home/role/endpoint漂移；核查U38-02↔U38-05及EX38-01。 | exact文件/目录布局和manifest/artifact bytes共同构成achieved read-back；phase只补未达效果，previous仍走同lifecycle；anchor/executor均在同一bound inactive server激活前消费同一health builder，实际Node版本与signed manifest不等即零ready并进入既有恢复。 |
| frozen delivery/current-authority体验 | 重造十owner、七source、enqueue前后、late/fresh、retry/uncertain、seal响应丢失；再以surface/empty、current anchor换代、离线、sticky action、伪receipt、成功token响应丢失核对U38-03↔U38-04↔U38-05。 | upgrade沿既有DeliveryAuthority operation恢复admission/sealed，fresh source零父提交、late delivery恰一进入；surface本机零updater，公开status只经current authority并由receipt+pointer+stage+lifecycle+health纯投影，矛盾事实固定action-required，success token compare-and-consume。 |
| 发布证据/产品体验/范围价值与历史边界 | 重新质疑八项当前用户损失、方案比例、五目标交付路径与EX38-01～EX38-02；核查第30～37冻结owner/stop/removal/checkpoint合同及schema activation、2GiB、daemon、通用框架、外部发布边界。 | 五个P0/P1与三个P2均已由锁定范围内既有原语闭合且直接改善可安装、可恢复、诚实可见的用户体验；没有引入第二事实源、daemon或通用框架，v1 schema activation、任意2GiB、运行时report耐久化和范围外发布仍被排除，EX38-01～EX38-02未重开。 |

### 四路冷启动对抗复审记录

| 角色 | 主动反例与交界 | 结论 |
| ---- | -------------- | ---- |
| 五目标安装/反降级与资源边界 | 从app remove后重装旧sequence、同identity异bytes、无home、低容量、最大五目标包及`release:check`旁路反推；核对U38-01↔U38-06↔U38-08 | receipt必须在程序根外、资源策略必须同时约束archive/expanded/temp、passed必须无旁路；上述边界已写入F38-01/F38-06/F38-08，无需任意2GiB流式框架 |
| ProgramStore切版恢复与candidate health | 从rename/pointer/terminal响应丢失、坏candidate被previous再次选择、inactive server未激活、两根identity漂移反推；核对U38-02↔U38-05 | previous只表示已验兼容版本，health必须在同一bound server激活前由共享snapshot授权；逐phase achieved与terminal receipt修复已闭合全部窗口 |
| accepted-work delivery/current-authority体验 | 从freeze后迟到delivery、fresh source竞争、surface错误设备副作用、sticky行动被checking覆盖和旧success重复展示反推；核对U38-03↔U38-04↔U38-05 | 复用既有DeliveryAuthority admission/sealed即可共同封闭；公开体验只消费current authority同一纯投影与receipt token，不增加第二升级事实源 |
| 发布证据/产品价值/历史边界 | 独立重估八项当前损失、评级、工作量，反查EX38-01～EX38-02、第30～37冻结合同及范围外发布能力 | 五个P0/P1和三个P2均有当前可达损失且方案比例成立；schema activation、任意2GiB、daemon、通用框架、report运行时耐久化和外部发布仍被排除，EX38-01～EX38-02未触发重开 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX38-01 | 原R38-02（P0/大）主张十三项耐久schema只有静态inventory、无production activation/writer闭包，会让不可回滚writer被误接纳。已验证事实：首个公开基线十三项均为`readMin=readMax=writeVersion=1`；`assertCompatibleUpgrade`对current/candidate/previous执行双向writer可读检查，当前没有writer版本跃迁或bridge。 | 未找到候选被接纳后写出previous/peer不可读格式的当前可达producer；全部writer仍为v1时接入十三日志activation只会增加第二投影与无用户价值复杂度。适用边界：当前v1稳定基线及没有不同writer版本的发布范围。 | `packages/core/src/protocol/durable-schema.ts`的十三项v1 exact-set；`packages/cli/src/update/update-controller.ts`的双向protocol/schema兼容门禁；第38单元独立审查价值裁决。 | 任一durable schema的生产`writeVersion`首次高于当前基线，或发布范围出现需要bridge/minimumRollbackVersion支持的不同writer版本。 | 已排除 |
| EX38-02 | 原R38-N01（P2/小）主张`StopDeps.killFn/taskkillFn`未调用字段与CLI README旧`credentials.json`迁移文字会增加维护和误接线风险。已验证事实：字段没有production caller，README文字不是运行时consumer，生产凭据路径已经是SecretStore-only。 | 没有运行、数据、安全或核心体验损失；为内部类型整洁改动测试兼容字段的收益低于churn，推测性维护风险不能构成当前问题。适用边界：字段保持无生产消费且文档不作为用户可达迁移入口。 | `packages/cli/src/serve/stop.ts`字段及其测试仅断言永不调用；`packages/cli/README.md`文字；第38单元独立审查价值裁决。 | 任一字段进入生产组合根/效果路径，或该文档成为用户可达安装迁移入口并给出错误操作。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V38-01 | 当前源码可由全部工作区消费者构建，CLI新增合同类型闭合 | `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`；`pnpm build` | 冻结36文件及workspace依赖图 | 修复直接验证/最终构建；15秒+136秒 | CLI类型检查零错误；17/17 workspace项目构建成功 | `affe17418108f656ea85d6b867945031f82127b75c1ffcee7f1798cfe176e0d8` | 有效 |
| V38-02 | release/ProgramArtifact有限合同、DeliveryAuthority admission/sealed与FileLock直接行为 | core release、delivery authority/pipeline、file-lock四个定向文件 | 对应core生产文件与直接测试 | 修复直接验证；85项 | 85/85通过 | 同上 | 有效 |
| V38-03 | ProgramStore exact布局、安装receipt、projection/health、upgrade lifecycle、app remove与三形态更新装配 | CLI update直接测试闭包；追加`update-controller`10项、`runtime`5项、`upgrade-lifecycle`1项 | CLI update/两根装配及其直接测试 | 修复直接验证；原闭包65项+追加16项 | 全部通过；C38-C01～C38-C03真实反例闭合 | 同上 | 有效 |
| V38-04 | current-authority update health/status/consumeNotice的认证、loopback、strict wire合同 | server方法直接测试与canonical registry golden check | server context、RPC registry/dispatcher、golden | 修复直接验证；61项+golden | 61/61通过；golden与生产registry一致 | 同上 | 有效 |
| V38-05 | 五target程序树、stable app/installer loader、固定smoke/50-id与派生结构门禁 | `node --test scripts/release-tooling.test.mjs`；`pnpm s7:lint` | release scripts、S7 descriptor、registry golden | 修复直接验证；5项+20项 | 4通过/1宿主symlink能力跳过；S7 20/20及golden通过 | 同上 | 有效 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 需求、架构、功能闭环、状态、回归               | 否           | —       | —         | 待开始 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 否           | —       | —         | 待开始 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-38.gen-1 -->
