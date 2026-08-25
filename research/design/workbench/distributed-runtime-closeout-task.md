# 分布式运行时最终收尾任务（临时）

> **状态：待用户确认。** 本文只承载 distributed-runtime 的最后一次严格限界收尾；不是需求、架构或执行规格，不产生新产品范围。执行状态只允许按 `待执行 → 执行中 → 对抗复核中 → 待用户确认` 推进；任何完成结论失效都必须退回 `执行中`。全部完成后保留本文的最终勾选与对抗复核记录，等待用户确认；未经用户后续明确要求不得删除。
>
> **唯一判断标准：** 需求文档、架构总纲与执行规格。当前生产源码和直接验证只用于确认“现状是否满足标准”，不能反向创造需求。此前模块回归记录已经完成一次性审计并删除；本文只吸收其中经三份核心文档与当前实现双向核实的事实，不继承其候选状态、历史绿灯或执行策略，并作为本模块唯一收尾任务源。

## 一、目标

不再扩展 distributed-runtime 的功能或架构，只清除当前已经能够直接证明、且会阻断三份核心文档验收的缺口，使模块同时满足：

1. 当前权威范围内的生产能力与异常终态真实可用；
2. 执行规格要求的仓库门禁、18 条不变量、故障/安全矩阵与双拓扑验收可信；
3. 用户入口符合总纲规定的“值班设备 / 干活的电脑”语言和零拓扑认知体验；
4. Windows x64 正式 tarball 与四时刻产品旅程取得必要且成比例的直接证据；
5. P0/P1 清零，不遗留已知的合同破坏、结构债务或平行产品路径。

达到以上条件后，distributed-runtime 告一段落；不得以“顺便完善”为由继续扩面。

## 二、已确认的起点事实

- S1–S10 对应的生产包、协议、角色装配和公开控制入口已经存在；这只证明本单元的工作性质是收口，不预先证明所有验收已经完成。
- `pnpm build` 当前成功；`pnpm package:check -- --skip-build` 当前成功，16 个公开包及 Windows helper 可由隔离 npm consumer 消费。
- 安全供应链、mesh 测试时钟、秘密边界和 S7 入口覆盖门当前通过。
- `pnpm lint` 当前失败：17 个错误位于 9 个测试文件，均为直接使用 `mkdtemp` / `tmpdir`，绕过 `@zhixing/test-utils` 的统一临时目录边界。
- 定向复跑当前稳定得到 6 个失败：`storage-maintenance.test.ts` 的 owner exact-set 断言漏掉 3 个已进入生产调用图的 owner；`workspace-probe.test.ts` 的 5 个用例全部在 5 秒处超时。执行规格 §3.4b 的早期 `StorageMaintenanceKind` / owner 枚举也未同步后续已经冻结的维护职责：生产有限集现有 18 个 kind、14 个唯一 owner，后续 checkpoint、托管服务与设备生命周期条款明确要求新增三类维护 owner 经同一 storage governor；这是规格内部一致性与直接验收需要共同闭合的问题，不能由生产代码反向创造新类别。
- 当前 `acquireFileLock()` 在每次未显式注入时新建 `ProcessIdentityResolver`；resolver 只在自身实例内缓存当前进程身份，而 Windows 身份读取同步启动 PowerShell。该链条与此前跨 core、secrets、mesh、owner-kernel、executor、server、CLI 观测到的 lock identity、busy 和 5/15/120 秒超时家族一致，是必须优先复验的具体根因线索，但仍须由本轮同基线直接证据决定最终修复。
- provider governance registry 当前定向复跑稳定报告 5 项失配：`command`、`turn-maintenance` 计数漂移，`journal-maintenance`、`post-adoption-memory` 未登记，credential rotation 直接调用 `provider.chat`。前四项是派生注册表落后；最后一项是已由源码和总纲“全部入口共用同一治理面”共同证明的生产旁路。
- 旧 v1 恢复包定向旅程当前稳定在 `decodeRecoveryPackage()` 以 unsupported format 拒绝；实现只接受 `zxrp2`，而总纲 §9 与执行规格明确要求旧 secret+trust-only checkpoint 在两个 root-activation 入口经既有 `RecoveryActivationCoordinator` 幂等重放且不得产生 `fullBackupReady`。这是已证实的兼容合同缺口。
- 此前模块回归还记录了 MemoryStore 陈旧 fixture、结构 golden、S7 ledger、CLI lint allow-list、入口轻量依赖和 RPC/profile/recovery fixture 等稳定失败。它们只作为本轮重取的有限线索，不继承旧候选的通过/失败状态；只有在当前基线重现且能反绑三份核心文档时才处理。
- 此前全量测试还直接观测到多组耐久文件测试超时与 `ENOTEMPTY` 清理失败，须在本单元重取完整失败清单并闭合。
- core 声明构建当前报告 9 条 type-only 跨 chunk 警告，但构建、contracts 独立 typecheck、生成后声明文件 typecheck 和 tarball import 均通过；当前没有直接证据证明它们破坏执行规格 §1.3 或公开消费合同，三份核心文档也没有“工具告警为零”门禁。因此它们不构成本收尾单元的强制任务；以后只有出现可达合同失败时才按该失败重新判定。
- 生产 `zz pair --help` 当前公开“高熵”、`listen/advertise`、盲中继和 `executor` 等内部概念；默认出码又只打印可复制文本，没有提供同一邀请内容的可扫码表示，恢复包与完成/失败信息仍有大量英文和内部术语，配对后也没有把设备配置、ready 与值班选择收束成同一条用户引导。
- `zz --help` 已公开 `pair/device/duty/backup/workspace`，CLI README 的“当前用户可见命令”却没有记录这些入口；现有注册事实与公开文档不一致，但命令是否应长期公开仍须由三份核心文档中的产品旅程和明确入口决定，不能由代码现状反推。

以上只是起点证据；任何源码或测试修改都会使对应绿灯失效，最终必须在同一代码基线上重取全部证据。

## 三、唯一工作范围（按顺序执行）

### 执行状态

- [x] C1　恢复测试临时目录边界
- [x] C2　闭合存储维护枚举、owner 与生产事实
- [x] C3　解决 Windows 耐久测试超时与清理失败
- [x] C4　闭合两项已证实的生产合同偏离
- [x] C5　清除已知派生回归债务
- [x] C6　闭合配对的第二开箱旅程
- [x] C7　同步公开命令与直接用户文档
- [x] C8　按合同分层完成最终验收

每个 C 项只有在其生产实现、消费链、异常终态、直接测试、必要文档和本项验收全部闭合后才可标为 `[x]`；输入变化或出现反证时必须恢复为 `[ ]`。最终退出门中的“C1–C8 全部完成”只能由上述八项全部为 `[x]` 推导，不能独立提前勾选。

### C1　恢复测试临时目录边界

**权威来源：** 需求文档要求跨平台测试的文件副作用落在每例唯一宿主临时目录；执行规格要求 S10 最终仓库级 `pnpm lint` 通过。

- 处理 lint 当前点名的 9 个测试文件：迁到 `@zhixing/test-utils` 的 `createTempDir` / `createDescribeTempDir`，删除已被统一清理替代的手写目录创建与清理；不增加 lint 豁免，不复制新的临时目录 helper。
- 保留每个测试原有隔离语义，包括需要两个独立目录、symlink 外部目标或真实文件系统行为的用例，不把它们合并到共享目录。
- 验收：`pnpm lint` 不再报告这些路径，相关定向测试通过且无临时目录残留。

### C2　闭合存储维护枚举、owner 与生产事实

**权威来源：** 总纲不变量 18、执行规格 §3.4b 及其后续 checkpoint、托管服务和设备生命周期条款要求全部 maintenance kind 经唯一设备容量裁决器、具有规范任务 owner，且零 permit 旁路。

- 先按执行规格后续已经冻结的维护职责，把 §3.4b 的早期有限 kind/owner 枚举同步为完整的 18 个 kind、14 个唯一 owner；只修正规格内部前后不一致，不改变产品范围，不从生产映射反推任何新类别。
- 对 `workspace-probe-retirement`、`ticket-retirement`、`stream-spool-reclaim`、`conversation-transfer`、`authority-checkpoint`、`managed-service-reconcile`、`device-lifecycle-cleanup` 分别核对规范职责、canonical kind→owner 映射、真实生产调用点和适用直接测试，确认它们确实经 storage governor / 唯一 arbiter 进入维护路径。
- 权威枚举、生产映射与调用点全等时，更新已经落后的 owner exact-set 断言；若发现无调用点、重复所有权或旁路，则修正生产接线。不得只为变绿机械追加字符串，也不得新增第二份 owner 清单。
- 验收：规格枚举、18-kind 映射、14-owner exact-set 双向全等；storage maintenance、maintenance exclusion、workspace probe/ticket/spool retirement、conversation transfer、checkpoint、managed service 和 device lifecycle 的直接测试通过，并继续证明零容量旁路。

### C3　解决 Windows 耐久测试超时与清理失败

**权威来源：** 当前正式交付目标是 Windows x64；执行规格要求故障矩阵、耐久恢复、全量测试以及安全停机/资源释放真实成立，但没有授权以统一放宽 timeout 代替定位。

- 先独立测量默认 FileLock acquisition 的当前进程身份读取次数与耗时，并稳定重现受影响闭包；若确认默认 resolver 的实例级缓存因每次 acquisition 重建而失效，则只把默认 resolver 提升为 FileLock 模块内共享实例。显式注入行为、其他 PID 实时读取、unknown fail-closed、PID reuse 与 token/reclaim 语义全部保持不变；用默认 factory 的计数替身证明多次无竞争 acquisition 只读取一次成功的 self birth，失败结果不得缓存。
- 随后稳定重现并记录本轮完整失败清单；优先独立闭合当前 5/5 超时的 `workspace-probe`，再按共同根因处理全量测试中实际复现的 timeout / lock busy / lock identity / `ENOTEMPTY` 家族，不把旧失败数量当成永久清单。
- 用现有输出或最小的一次性局部计时确定阻塞发生在 fixture、append/fsync、projection reopen、资源关闭还是目录删除；定位后删除临时观测代码，不建设诊断设施。
- 只有在证明生产路径存在死锁、无界等待、资源未释放或违反已冻结期限时才修改生产实现；若合同正确而测试期限确实小于 Windows 上已测得的正常耐久边界，则只修正测试装配或给出有测量依据的测试期限。
- 对真实 child process 的固定端口 owner 用例，只有在确认外层默认 5 秒预算小于已测启动成本、而内部 15 秒 outcome/exit 边界及 OS owner 断言均未失败时，才把外层测试期限对齐既有 120 秒耐久测试预算；不得放宽内部失败边界或改成 mock。
- `setup-delivery` 的 executor-only 组合根用例必须在断言后通过该 runtime 的统一 startup cleanup 停止 workspace probe / storage maintenance；生产 maintenance stop 必须等待正在执行的任务完成，不能只发出 abort 后立即返回。修复后的完整文件已 24/24 通过且未再出现 `ENOTEMPTY`；修复前留下的 4 个精确临时目录已在本轮最终残留清理中删除。不得以延迟删除或忽略告警掩盖句柄泄漏。
- `assignment-ledger` 的真实耐久 fixture 同样必须在每例目录清理前等待 authority log maintenance 停止。实测代表性用例约 5～8 秒；原有逐用例 15/20 秒覆盖会压过 describe 级预算并在整套串行 I/O 竞争下产生误报，现已统一到文件既有的 30 秒 `DURABLE_IO_TEST_TIMEOUT_MS`，且只覆盖真实耐久协议 describe，不覆盖行为矩阵、其他包或内部协议期限。完整文件已经 200/200 通过（测试体 704.81 秒），本轮未出现 `ENOTEMPTY` 或新增临时目录。
- planned-anchor 角色切换必须先撤销服务、再等待旧 target 的候选与 transfer journal maintenance 全部停止，不能 fire-and-forget `close()`；其真实测试 fixture 也必须在 `createTempDir` 删除 source/target/peer 与 staging 目录前关闭所有 target 和 bootstrap-store maintenance。两个失败用例隔离实测分别约 4.59 秒和 4.57 秒，确认默认 5 秒在 Windows 并行包负载下没有余量，故只把该真实耐久 describe 对齐文件中既有的 10 秒预算，原有 120 秒重路径保持不变；完整文件 20/20、与 mesh runtime bootstrap 的联合闭包 27/27 通过，均未再产生 `ENOTEMPTY` 或新残留。
- executor 全包并发基线进一步重现 6 个失败：`job-assignment` 三个外层默认 5 秒超时、一个 2 秒恢复轮询未收敛，以及 `resource-governor` 两个外层默认 5 秒超时；其中两个超时用例已直接伴随 authority 目录 `ENOTEMPTY`。两文件都创建真实 `FileAuthorityCommitLog` 却未在 `createTempDir` 清理前统一等待 maintenance，且 `job-assignment` 已有 30 秒耐久预算但只覆盖少数同类用例。须先补全每例全部 primary/reopen 日志的关闭链，再隔离测量六项；外层耐久预算只能作用于对应真实协议 describe，2 秒生产恢复语义/测试轮询不得因包负载直接放宽，必须单独确认恢复循环是否真实完成。
- 上述六项闭合后，executor 全包重跑 505/506 通过，唯一新增反证是 `assignment-stream-spool` 的 40 个耐久 assignment 分页用例在同包磁盘竞争下超过文件既有 30 秒预算，并因 fixture 未关闭 spool index maintenance 产生 `ENOTEMPTY`。现已统一跟踪并在目录删除前关闭 primary/restart/raw spool 日志和 assignment scan，保持 40 条准备数据、32 条页上限与 42 个物理步骤断言不变；该重用例隔离实测 15.98 秒，故只给它 60 秒预算。完整 spool 文件已 28/28 通过且无新增清理告警，仍须由 executor 全包复跑确认并发基线。
- 再次全包重跑仍为 505/506，唯一失败移至 `job abort ticket authorization` 的 256 项超限 mirror batch 拒绝用例：隔离测试体 2.10 秒、语义正确、无清理告警，但在同包磁盘负载下超过默认 5 秒。只给该真实 durable record-limit 用例 10 秒外层测试预算；不改 256 项边界、validator、生产期限、整个 describe 或静态矩阵，并须再次取得 executor 506/506 的同包证据。
- 下一轮全包仍为 505/506，唯一失败再次移至 `job cancel proof durable replay` 的另一个默认 5 秒 describe，并因超时中断清理。源码核对确认 `job-assignment.test.ts` 除 `job record execution-point behavior matrix` 外的各协议/state-machine describe 都通过 `createUserHarness` / `createSystemHarness` 运行真实 `FileAuthorityCommitLog`；继续逐用例追加会遗漏同类边界。故把这些真实持久化 describe 统一绑定文件既有 30 秒耐久预算，明确保留 execution-point 行为矩阵的默认预算；所有生产退避、validator、记录上限和显式更窄/更长的重路径预算不变。随后 executor 全包已 7/7 文件、506/506 测试通过（445.00 秒），且未再出现 `ENOTEMPTY` 或新增临时目录。
- 根级 `pnpm test` 在同一基线继续取得 core 的完整失败清单：178 个文件中 171 个通过，2656 个测试中 2647 个通过，9 项失败全部是外层测试时限，没有功能断言失败。失败精确落在 `workspace-probe` 1 项、`workspace-binding-catalog` 1 项、memory global-state takeover 1 项、workscene global-state 2 项、authority storage 2 项、delivery authority 1 项和真实 child-process FileLock 1 项；其中 workspace probe、binding catalog 与 workscene 还直接伴随 `ENOTEMPTY`。须按本项既定规则先补齐 fixture 的 maintenance/日志关闭链，再隔离测量对应耐久用例；authority/delivery 只能在确认既有真实耐久组预算漏绑且断言边界未失败后对齐该组预算，child-process 用例只能按上文的专门条件处理。根级全量结果在修复后必须重取，不能由定向结果替代。
- 上述 9 项隔离实测分别落在约 1.56～4.70 秒，真实 child process 为 3.40 秒；在 7 个文件联合负载下 106/106 通过且无清理告警，证明协议断言与内部期限成立，根级并发只击穿外层测试预算。已给 workspace binding/probe、memory 与 workscene 的真实耐久组使用 10 秒局部预算，authority storage 的两个用例复用文件既有 120 秒耐久预算，delivery 单个重用例使用 30 秒预算，真实 child process 单例按专门规则对齐 120 秒；生产期限、fsync、记录规模和断言均未改变。首轮 core 全包由 9 项失败收敛到仅 `workspace-bindings` 1 项默认 5 秒超时，并新暴露该 binding log 与 workscene fixture 的清理顺序反证；核对 Vitest 实际完成回调顺序后，所有本轮跟踪器改为在临时目录注册之后登记资源关闭，确保反向执行时 maintenance 先停、目录后删，同时把 `workspace-bindings` 纳入相同 10 秒耐久组并跟踪所有 service/raw log。五个直接文件随后 33/33 通过且无清理告警；仍须由下一次根级完整测试重取最终基线。
- 当前代码基线的 core 全包复跑进一步得到 2643/2656：13 项全部是耐久 I/O 外层时限，零功能断言失败；5/10 秒组分别只越界到约 5.1～10.3 秒，`artifact-lifecycle-index` 的 120 秒项越界到 120.17 秒，超时提前触发清理后伴随 8 个精确 `ENOTEMPTY`。13 项逐个放入无其他验证进程的新 Vitest 进程后全部通过，测试体约 1.4～10 秒且无新增清理告警，证明生产断言、内部期限和正常关闭链成立。因而只把本轮实际命中的真实耐久协议 describe 统一到 30 秒测试预算，把四个 authority 重 I/O 文件的既有 120 秒组级预算真正覆盖完整对应 describe；唯一在包级实测击穿 120 秒的 artifact lifecycle 文件使用两倍 240 秒有界预算。生产 timeout、fsync、数据规模、恢复轮询和断言全部保持不变；修改后仍须重取受影响直接闭包及根级完整测试。
- 根级 `pnpm test` 的下一轮同基线通过 Vitest 本轮缓存收敛到 3 个 core 文件失败，其余已执行文件均通过：delivery authority、durable projection index 与 workscene global-state adapter 的文件耗时分别约 175、252、53 秒。三者随后在无其他验证进程的新进程中分别 42/42（52.92 秒）、21/21（63.07 秒）、5/5（24.95 秒）通过，零功能断言失败；根级耗时精确击穿其 15/120/30 秒外层预算。故只把 delivery 两个真实耐久协议 describe 绑定 60 秒局部预算、durable projection 使用两倍 240 秒档、workscene 耐久 describe 使用 60 秒档；生产期限、fsync、记录规模、内部轮询和所有断言不变。该测试输入变化使此前根级 lint/test 证据失效，必须重新取得直接闭包、lint 与根级完整测试。
- 调整后三文件联合闭包 3/3、68/68 通过；下一轮根级 `pnpm test` 将 core 收敛到 178 个文件中 177 个通过、2657 项中 2656 项通过，唯一失败是 WAL roundtrip 的 versioned 持久化用例在根级负载下耗时 5.13 秒、击穿默认 5 秒，且超时触发的提前目录清理留下精确 `ENOTEMPTY`；同轮 workscene 重启只读 adapter 未登记 stop，也产生一处精确清理告警。WAL 三项均使用真实 `FileAuthorityCommitLog`，现统一在临时目录清理前等待 storage maintenance 停止，只给该三项真实持久化 describe 10 秒外层预算；workscene 补齐 restarted adapter 的 stop。生产期限、WAL 格式、断言和数据规模不变，必须重取两个直接文件、lint 与根级完整测试。
- WAL/workscene 直接闭包 2/2 文件、8/8 通过且零清理告警后，下一轮根级 `pnpm test` 再次收敛到 core 177/178 文件、2656/2657 项：唯一失败是 `assignment artifact closure` 首项的真实 artifact store fixture 在根级负载下耗时 5.317 秒、击穿默认 5 秒；同文件其余 14 项通过，现只把两个真实文件 I/O describe 绑定既有 30 秒耐久预算。该轮仍复现 workscene 清理告警；沿生产生命周期继续定位到 activity projection 的 `peek()` 会启动不受 adapter maintenance runner 管理的异步 read-behind，`stop()` 因未等待它而可在刷新仍触碰 authority projection 时返回。现由 activity projection 停止接收新刷新并等待已启动刷新，adapter stop 也等待当前 recovery；新增可控反例直接证明 stop 在 refresh 释放前不完成、完成后不再启动新工作。必须重取相关直接闭包、lint 与根级完整测试。
- 生产生命周期修复与 assignment artifacts 的直接闭包 2/2 文件、21/21 通过且零清理告警；下一轮根级 `pnpm test` 中 workscene 6/6 通过且 `ENOTEMPTY` 不再出现，唯一失败移至 workspace probe local adapter：10.176 秒击穿旧 10 秒耐久组预算。机械复查 C3 本轮修改过的 core 真实持久化组，确认 workspace probe 与 workspace binding catalog 仍遗留早期 10 秒档，而本项后续已经统一同类组为 30 秒；两者现一并对齐 30 秒，WAL roundtrip 保留其单独测得的 10 秒小闭包。生产 probe/binding 期限、重试、fsync、签名与断言全部不变，必须重取两文件、lint 与根级完整测试。
- CLI 首轮全包在 259 个文件、2957 项中得到 40 项失败和 7 个异步错误；逐项隔离后，除本项同类的耐久 describe 预算漏绑与 fixture 未关闭 maintenance 外，稳定复现的断言偏离均归入 C5/C6 最窄修复。`anchor-executor` 组合根还独立复现 `lifecycle-reconcile` 叶步骤暂时背压直接终结 committed 对账：`ArtifactLifecycleIndex` 作为规格指定的唯一义务 owner，现只在退出自身串行区且调用方未持更外层互斥时按同一义务有界重驱；外层互斥仍立即上抛给最外 owner，未放宽容量、锁或生产期限。直接反例证明旧失败可恢复且外层锁内零等待，owner 三拓扑 3/3 通过；修复后 CLI 全包 259/259 文件、2958/2958 项通过，零 `ENOTEMPTY` 与未处理异步错误。C3 仍须等待根级完整测试和全部精确历史残留清理后才能勾选。
- owner-kernel 隔离包级基线稳定复现 14 项默认 5 秒外层超时，全部发生在真实 `FileAuthorityCommitLog` 用例且零功能断言失败；其中 8 项伴随 `ENOTEMPTY`。机械反查发现包内 10 个耐久测试文件的 27 个日志实例均未登记 storage-maintenance 关闭。现以单一测试辅助函数在每个日志创建后登记关闭，使其按 Vitest 反向清理顺序先停日志、后删目录，并只把对应真实耐久 describe 绑定 30 秒局部预算；纯规划 describe、生产 timeout、fsync、锁等待与断言均未改变。十文件直接闭包除一次编辑时遗漏 `vi` 导入导致的 2 项即时 `ReferenceError` 外为 96/98，通过恢复原导入后该文件 6/6 通过，合并为 98/98，且全程未再出现 `ENOTEMPTY`。
- owner-kernel 全包复跑将 14 项超时收敛到 279/280；唯一反证是 scheduler job publish 的后台有限重驱在包内 I/O 负载下只完成 2/3 次即击穿 `vi.waitFor` 隐含的 1 秒观察窗口，功能路径继续运行且没有内部协议失败。该用例已保持生产 5 毫秒测试注入重试、真实 fsync、三次尝试与公平性断言不变，只把测试观察窗口显式绑定同一 30 秒耐久预算，并用 `finally` 保证断言失败时也先停止 participant；须重取该文件与 owner-kernel 全包证据。
- 根级递归脚本此前以默认 workspace concurrency 同时启动多个重型包，直接违反本机验证手册的“包级全测逐包串行”已验证运行方式，并在同轮制造 secrets 的进程身份/DPAPI 不可用与 owner-kernel 额外资源超时；secrets 随后的独立全包 24/24 直接通过。根脚本现固定 `--workspace-concurrency=1`，只改变仓库测试装配，不改变任何产品期限或协议；仍须以精确 `pnpm test` 重取完整同基线证据。
- 首轮精确串行 `pnpm test` 已完整通过 network、test-utils、core 178/178 文件及 2658/2658 项、channel-feishu、MCP、mesh 124/124、owner-kernel 280/280、providers 与 secrets；随后 tools-builtin 的 291 项中仅 Turndown HTML 转换单例耗时 8.507 秒、击穿默认 5 秒，零功能断言或清理失败，同一单例在无并发新进程中 0.162 秒直接通过。该冷加载用例现只将自身外层测试预算设为 15 秒，转换输入与断言、网络和生产期限均未改变；须重取该文件、tools-builtin 全包、lint 与精确根级全测。
- 后续串行根级运行在 mesh 的 `full-authority-checkpoint.test.ts` 暴露新的 `checkpoint-authority-*` 清理告警：公共 `authorityFixture()` 在 `createTempDir` 后创建 `ArtifactLifecycleIndex`，却未在自动删除目录前等待其 storage maintenance 停止。现按反向清理顺序登记 `lifecycle.stopStorageMaintenance()`；修改后完整文件 16/16 通过（65.54 秒），零 `ENOTEMPTY`。当前无验证进程时，已验证全部目标都直接位于系统临时根后，删除历史积累的 1615 个 `zhixing-test-*` 目录，失败 0、复查残留 0。C3 的仓库全量验收只在 C8 冻结基线统一重取，不再于修复循环重复运行。
- C8 首次冻结根级 `pnpm test` 已保存完整结果：network、test-utils、core、channel-feishu、mcp、mesh、owner-kernel、providers、secrets、tools-builtin、orchestrator、server、executor 全部通过，随后 CLI 为 252/259 文件、2932/2959 项通过，27 项失败及 3 个异步错误集中于同一设备容量链。当前默认 arbiter 把进程级 CPU 采样高于 95% 解释为所有 class 零进展，`blockedBy:slots` 在尚无 permit 时也会立即返回；同时 `FileDurableProjectionIndex.initialize()` 在 manifest 串行区内收到一次暂时背压后直接终结 committed scrub。这与总纲 §7、执行规格 §10.1“CPU 只作设备级压力信号、由公平队列/槽位/检查点治理”“七类满载不永久饥饿”“committed 义务失败后耐久重试”直接冲突。现把实时压力从永久 `capacity-gap` 判据移回 `backpressured`，CPU 饱和时只保留策略范围内两个前进槽位（不继续放大并发，也不把交互 workload 与其相邻 storage 步骤压成单槽死锁），并让投影初始化只在退出自身 manifestQueue、且外层无其他互斥时按既有 5 秒边界重试；容量与投影直接合同 3 文件、49/49 通过。原 7 个 CLI 失败文件首次同跑由 27 项收敛到 3 项、其余 5 文件 91 项全部通过；补齐初始化重试与双前进槽后，剩余 `setup-delivery`、`mesh-pair-command` 两文件 31/31 通过，零异步错误。C3 仍按约定只等待新冻结基线的根级完整测试及最终残留复查。
- 第二次冻结根级 `pnpm test` 证明上述“CPU 饱和时压成两个槽位”仍不是最终正确方案：core 2660/2660 通过，但 CLI 在真实并行负载下仍以 25 项失败、3 个异步错误复现同根 `backpressured:slots`，并级联为配对、迁居和恢复超时。重新反绑执行规格 §10.1 后确认：进程级 CPU 采样只能进入设备压力诊断，不能动态改写版本化 slot 容量或冒充任务实际用量；现恢复策略 slot 上界，仅由七类公平队列、真实 permit 占用和有界检查点治理。进一步的失败闭包证明两个缺失的最外责任边界：SurfaceAssetCoordinator 的请求路径在进入业务 task 前遇到恢复背压时，必须退出自身串行区后有界重驱，且不得重放已开始的 task；checkpoint 文件步骤本身不持 authority/projection/ArtifactStore 锁，配对与恢复前台调用应有界等待 5 秒，而非以 pre-commit 零等待把瞬时竞争升级成失败。容量/投影直接合同 49/49、surface 恢复反例整文件 48/48、配对整文件 7/7 通过；最终将 owner 三拓扑、local owner 生命周期、planned-anchor 与配对置于同一 4 文件负载闭包后 43/43 通过，两个旧 10 秒超时分别在 4.329/3.330 秒完成，零异步错误。此前 conversation 恢复断言也在同基线闭包中通过；剩余判定只由下一轮冻结根级测试与残留复查给出。
- 每例在删除目录前显式关闭其真实日志、句柄、listener、helper 与子进程。禁止未定位即统一抬高 timeout、关闭 fsync、跳过清理或改用 mock。
- 验收：FileLock 默认路径及安全负例、相关定向测试、受影响包测试、随后仓库全量测试通过；无 `ENOTEMPTY`、遗留句柄、listener、子进程或临时目录。

### C4　闭合两项已证实的生产合同偏离

**权威来源：** 总纲 §7 要求 provider 调用全部共用同一治理面；总纲 §9 与执行规格 S9 备份合同要求旧 v1 trust-only 恢复包只在两个 root-activation 入口安全兼容。

#### C4.1　Provider 调用治理

- 按当前真实调用图同步既有 provider governance registry：修正 `command`、`turn-maintenance` 的派生计数并登记已经受治理的 `journal-maintenance`、`post-adoption-memory`；注册表只能描述生产调用图，不能为迁就旧计数改生产行为。
- 由现有组合根把 authority governor 注入 credential rotation，复用现有 `governControlProvider`，将凭据服务验证归入 `interactive/environment-control` control 工作；保持单次调用、`maxTokens: 1`、15 秒期限与真实服务核验语义，不新增治理层。
- 验收：全部 production provider call site 恰一分类；准入失败零 provider 调用；流式成功、错误和提前中断均按同一 lease 完成 reserve/consume、settle/release，且 registry、源码扫描与 CLI 定向测试通过。

#### C4.2　旧 v1 恢复包兼容

- 在既有 recovery-package 边界实现严格 v1/v2 判别联合：decoder 只接受规范 base64/JSON、exact fields、恢复秘密与根身份全等以及合法 checkpoint 结构；当前 v2 生成与回读流程不变。
- 只有 `mesh-pair-command.activateInitialRecoveryRoot` 与 `backup-command.establishInitialRoot` 两个 root-activation 入口可消费 v1；入口必须按各自 current trust、issuer、target、recipient、链头、`scope:["trust"]` 与 root-activation plan 验签反绑，再把内嵌 checkpoint 原样交给既有 `RecoveryActivationCoordinator`。rotate、灾难恢复及其他入口继续拒绝 v1。
- 两入口的真实受限连接链若重放已经耐久接受的 endpoint publication，只允许 canonical 全等的同 revision 请求幂等返回；同 revision 的冲突内容与更旧 revision 仍按既有安全边界拒绝。active paired receiver 必须在同一生产入口同时承接当前 recipient 的普通 full checkpoint 与严格反绑的 root-lifecycle/exact replay，不能让恢复激活或首份 full checkpoint 被连接级重放、平行 receiver 或互斥模式错误阻断。
- v1 激活事实不得产生 `fullBackupReady`；后续首份 full checkpoint 仍按现行合同完成。验收覆盖两入口 v1/v2 正常路径、响应丢失幂等重放、非规范编码、未知字段、篡改及错 scope/issuer/root/recipient/chain。

### C5　清除已知派生回归债务

**权威来源：** 执行规格第 25～29、38 单元及对应严格合同。测试、golden、lint 和 fixture 都只是派生证据；只有与三份核心文档双向对账后才能更新，禁止为变绿放宽生产合同。

- 在当前基线逐项重取以下已知线索；未复现即不改，复现后按最窄责任修复：
  - tools-builtin 的 memory CRUD 与 orchestrator system-prompt 使用可观测的当前 `MemoryToolPort`，不得恢复已删除的 `MemoryStore`；CLI legacy takeover 则用仍受支持的旧 Markdown 写面制造真实迁移输入，再经 production cutover 与 `GlobalStatePort` 回读。
  - distributed-runtime structure golden 只在生产结构稳定后重新生成，并逐项人工反绑当前组合根、依赖方向与入口唯一性；不得用 snapshot 更新掩盖未知新边或旧入口残留。
  - S7 ledger 的职责 exact-set 与损坏 deletion-confirmation 负例按当前规格重对账：已删除的 legacy owner 不得复活，损坏记录必须在真实首个效果前拒绝并保持日志零新增。
  - `no-direct-console` 只对确属独立、无常驻 chrome、命令结束即退出的管理命令增加精确 allow-list；其公开输出仍须通过 C6/C7 的用户语言审计，不能用豁免隐藏产品问题。
  - CLI entry import graph 只允许当前 npm 入口真实需要的 `node:fs`、`node:path`、`node:url` 轻量内建依赖，继续拒绝业务包和重型静态导入。
  - RPC durable requestId、`session.new {}`、personal profile identity 与 recovery bootstrap-store fake 按当前 strict contract 更新 fixture，不放宽 validator、不恢复旧 wire/存储合同。
  - C6 生产启动链复核发现 `credentials.json` 已失去执行规格第 38 单元要求的启动迁移消费方。保持 `loadCredentialSnapshot` 为唯一公开读取入口，在其现有协调器内私有完成 exact legacy source 的 schema 校验、SecretStore 原子替换与回读、冲突拒绝、源身份复核和明文清理；不得恢复旧迁移/反向导出 API。畸形源与既有活跃凭据冲突均 fail closed 且保留原文件，成功后明文路径与精确旧临时文件为零。
- 每项先跑最窄定向测试，再跑所属包；全部修复完成后仍必须进入 C8 的仓库级同基线全量验收，历史部分绿灯不得替代。
- 当前基线已分别取得 tools-builtin 291/291、orchestrator 454/454、providers 210/210（另 3 项按原条件跳过）、server 820/820、executor 506/506、mesh 124/124 与 CLI 2958/2958 的完整所属包证据；structure golden 的唯一新边已人工反查到 canonical CLI serve→runtime 动态入口，凭据旧明文迁移的成功、损坏、冲突与清理边界均由真实启动消费链覆盖。首次根级 lint 进一步证明秘密边界门把 `credentials-loader.ts` 中唯一受控的启动迁移消费方仍判作“引用已退役明文文件”；门禁现已精确断言只有这一私有启动迁移 owner 可引用 exact legacy source、迁移函数不可导出，其他生产引用继续全拒绝。S7 结构门中 joiner 托管触发、值班候选在线计划和 root-activation 连接变量的三个旧语法匹配也已重新反绑真实生产路径；21 个 mutation/结构攻击、registry golden 与完整根级 lint 均通过，因此本项重新闭合。

### C6　闭合配对的第二开箱旅程

**权威来源：** 需求文档、总纲 §11 与执行规格 §11/§15 共同要求“配对 → 恢复包 → ready → 指定值班”为一次手势级、零拓扑术语引导；当前公开产品只允许扫码或复制同一份高熵一次性邀请内容。

- 出码设备必须从同一份高熵、single-use 邀请内容生成两种等价表示：可直接扫描的二维码和可复制的文本；新设备扫描或粘贴后进入同一个 join 流，不能把“内部方法名含 qr”冒充已经提供扫码产品入口。
- 首次启用网格时，默认 `zz pair` 沿一条无分叉引导完成：配对 → 用中文提示独立保存恢复码并真回读 → 按缺失项补齐目标设备配置直至 ready → 用“哪台设备长期开机？让它值班”完成值班选择。自动上线选择只使用“干活的电脑”语言。
- 审计全部默认可见输出和错误，而不只是 `--help`：用户不得看到或被要求输入 home/device id、地址、端口、中继、内部角色、bootstrap、recovery root 或密码学强度。`listen/advertise/relay/relay-only/executor-auto-start` 若仍为测试或受控运维所必需，只能保留为非默认隐藏入口，不能成为正常配对或故障恢复的用户行动。
- 默认寻址或会合失败时只给一个产品化安全行动，不能回退为“请提供 host:port”；取消、重试、无可路由地址和恢复包回读失败均保持单一路径和诚实状态。
- 保持安全边界：不启用低熵短码，不降低 single-use、恢复包真回读与 ready 门禁。
- 验收：二维码与复制文本解码为同一邀请；默认帮助、完整引导、取消、重试、会合失败、恢复包失败和目标未 ready 路径通过零认知走查；用户不需要查架构文档即可完成。
- 当前基线的同内容二维码/复制文本、无分叉 join→恢复码真回读→配置/ready→值班链、隐藏技术网络参数、产品化失败行动及配对后托管职责迁移均已由 5 个直接文件 44/44、mesh bootstrap 12/12、mesh 全包 124/124、S6 真实生产组合 8/8 和 CLI 全包 2958/2958 共同闭合；默认帮助只保留“第二台设备 / 干活的电脑 / 值班设备”产品语言。公开命令表与 tarball 帮助的一致性仍由 C7/C8 独立验收。

### C7　同步公开命令与直接用户文档

**权威来源：** 执行规格第 29 单元要求命令入口逐一命中唯一落点并同步公开契约；三份核心文档冻结了产品旅程和少数明确命令，但没有把当前全部 Commander 命令名一概冻结为长期产品合同。

- 逐项分类当前顶层注册：三份核心文档明确点名的公开入口、承载冻结核心旅程且当前没有其他完整产品入口的管理命令、内部/诊断/冗余入口。代码已经注册或 README 已经漏记都不能单独决定分类。
- `pair/device/duty/backup/workspace` 中，凡属某项冻结核心旅程当前唯一完整入口者，应保持公开并写入 CLI README；只有已证明不承载核心旅程，或已有同等完整且已经可用的产品入口承接时，才可隐藏。不得为整理命令表新增替代界面或改变产品范围。
- 使 Commander 注册、`zz --help`、CLI README 与 package smoke 对公开命令 exact-set、隐藏入口和长运行语义的分类一致；package smoke 从本轮 tarball 读取真实帮助，不另抄一份无法追溯的命令事实源。
- `serve`、诊断参数及 C6 的技术网络覆盖参数继续遵守隐藏边界；本项只修正文档和验证漂移，不增加新命令。
- 验收：真实 registry、默认帮助、CLI README、入口覆盖 lint 与 tarball smoke 全等，用户文档不再把已公开的核心旅程写成不存在。
- 当前真实顶层公开 exact-set 为 `zz`、`help`、`status`、`stop`、`doctor`、`app`、`pair`、`device`、`duty`、`backup`、`workspace`；其中后五项分别承接已冻结的配对、永久设备移除、值班迁移、恢复备份/灾难恢复与本地工作区旅程，当前没有同等完整的其他产品入口，故保持公开。`serve` 及技术网络/诊断覆盖继续隐藏。CLI README 已用标记区与真实 Commander registry 建立单源 exact-set 反查，并补齐七条设备级旅程，公开旅程不再使用 `ready` 等内部状态词；最终 `root-help.test.ts` 5/5、`pnpm s7:lint` 21/21、registry golden 及本轮 tarball package smoke 全部通过，tarball 默认帮助与安装后真实 Commander registry 全等。

### C8　按合同分层完成最终验收

**权威来源：** 执行规格第 38 单元要求全部不变量、故障、安全、双拓扑、四时刻产品旅程、`package:check` 与 Windows x64 tarball smoke；总纲要求验证必要且成比例，而不是建设只为验收形式服务的新设施。

- **仓库层：** 复用现有生产装配和自动化套件，逐项闭合 18 条不变量、故障/安全矩阵和双拓扑；缺少直接证据时只补最窄测试，不另建通用验收框架。
- **执行纪律：** 修复阶段可用定向测试与受影响包缩短反馈，但最终必须在同一新代码基线完整运行根级 `pnpm lint / pnpm test / pnpm build`；不得以逐包结果之和、旧候选指纹、未执行完的包或历史部分绿灯替代。
- **交付物层：** 从同一源码运行 canonical `pnpm package:check`，在隔离 npm consumer 与隔离 `ZHIXING_HOME` 中以本轮 tarball 真实启动 CLI、公共 runtime subpath 和 Windows helper；不得以 workspace 源码、历史 `dist` 或 mock 自报替代。
- **产品层：** 分别走查开箱、扩展、日常、异常四个时刻：配对→恢复包→ready→指定值班，任务就地/远端执行，离线排队与恢复，离线继续工作与收编，uncertain，撤销/外部轮换，备份恢复，维护、应用停用与永久设备移除。每条旅程使用离其生产入口最近的直接证据，不强行串成一个脆弱的超大 E2E。
- 真实进程测试使用当前 Windows x64、隔离 home、loopback 与真实 child process；仅 tarball smoke 必须全程来自安装产物，不能把“第二台物理设备”升级为门禁。
- 验收后清理隔离 home、临时 tarball、listener 和子进程；不得触碰用户真实 `ZHIXING_HOME`，不得写 npm registry。

## 四、明确排除项

本收尾单元不得加入或重开：

- 新业务能力、通用框架、遥测、benchmark 或诊断平台；
- 仅为消除未证明会破坏合同的工具告警而改包边界、type 引用或打包配置；
- macOS/Linux 发布承诺或第二台物理设备门禁；
- 低熵短码及其密码学实现；
- 原生安装器、私有 Node、自有更新源、自动更新或降级链；
- 真实 npm 发布、CI、签名、公证或任何外部系统写入；
- 对三份核心文档的无关重写，以及继续维护第二份模块状态/回归任务文档；
- 为消除测试失败而降低 fsync、权限、恢复、一致性或资源治理合同。

若发现问题只能通过改变上述产品范围、用户体验或权威架构才能解决，停止本单元并把事实与唯一决策点交给用户；不得自行扩面。

## 五、最终退出门

以下条件必须在同一代码基线全部成立：

- [x] C1–C8 全部完成，生产实现、异常终态、直接测试和必要用户文档同步闭合；
- [x] `pnpm lint` 通过；
- [x] `pnpm test` 完整运行并通过，不中断、不以局部测试代替；
- [x] `pnpm build` 通过；
- [x] canonical `pnpm package:check` 通过，且消费本轮构建与 tarball；
- [x] 18 条不变量、故障/安全矩阵、双拓扑与四时刻产品旅程均有可追溯的直接证据；
- [x] Windows x64 tarball smoke 通过；
- [x] 同一未修改基线完成冷启动对抗复核，逐项主动构造的反例均已证伪或修复，且没有未处置问题；
- [x] 无 P0/P1、无测试临时目录或进程残留、无新增范围外能力。

全部满足后：把本文状态更新为“待用户确认”，保留全部勾选与对抗复核记录，报告 distributed-runtime 已达到告一段落的技术条件并等待用户验收；不得自行删除本文或继续完善本模块。真实 npm 发布仍需用户另行明确授权，不是本文完成条件。

## 六、用户提示词

### 6.1　目标模式：完成 distributed-runtime 最终收尾

```text
目标：完整执行《分布式运行时最终收尾任务（临时）》中的 C1～C8，把 distributed-runtime 在三份核心文档已经冻结的当前范围内彻底收口。生产实现、消费链、异常终态、直接测试、公开文档、仓库门禁、Windows x64 tarball 和四时刻产品旅程必须在同一代码基线上真实成立，P0/P1 清零；不得扩展功能、重开已排除事项、恢复第二份回归文档或把 distributed-runtime 提升为知行的产品核心。完成全部开发与验证不等于任务结束；唯一结束边界是本文“最终退出门”全部成立，并且最后一次冷启动对抗复核真正主动寻找问题后确认没有未处置反证。达到后保留本文供用户验收，把状态更新为“待用户确认”并停止。

首个动作：完整读取本文，以及 `research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md` 三份核心文档；核对当前工作区、暂存区、生产调用图、失败基线、文档状态及全部勾选项。状态为“待执行”时更新为“执行中”；其他状态必须按本文状态规则继续，不得盲目覆盖或降级。完整读取 `research/design/workbench/verification-runbook.md` 后再执行任何验证。每次续跑或历史压缩后的首个动作：重新读取本文当前状态及正在处理的 C 项，复核其直接权威条款和当前工作区事实后继续；上下文已无法可靠保留整体边界、出现反证或将进入最终复核时，重新完整读取三份核心文档。只以需求文档、架构总纲和执行规格判断产品与架构是否正确；源码和测试只用于证明现状，历史绿灯、摘要和已删除的回归文档均无授权力。保留用户既有变更，不得改写暂存区，不得暂存、提交、推送或执行真实 npm 发布。

验证效率（硬约束）：`research/design/workbench/verification-runbook.md` 是本任务测试调度、环境归因和证据复用的运行手册。每次运行测试、lint、build 或 package check 前，先按手册确定验证层级、已被修改失效的最窄闭包、可继续复用的直接证据和当前是否存在重叠进程；重型包逐包串行，测试、构建和类型检查不得重叠。首次昂贵运行就保存 verbose 日志和机器可读结果，不得为了找失败名称、恢复被截断输出、观察是否漂移、汇报进度或获得心理确认而重跑。遇到手册已经确认的资源型超时或环境失败，保留首次结果，只定向复跑失败项，并按手册用“原范围其余结果 + 定向结果”完成判定；修改后只重跑失效闭包。

根级 `pnpm lint`、`pnpm test`、`pnpm build` 和 canonical `pnpm package:check` 是 C8 冻结基线的最终门禁，不是修复阶段的调试循环。C3 所要求的仓库全量测试与 C8 合并为同一次最终根级运行：C3 的生产修复、直接测试和受影响闭包已经闭合后，继续完成 C7，但在 C8 的根级测试真实通过前仍不得勾选 C3。只有全部已知问题均已通过最窄闭包、C7 已完成且源码与验收输入冻结后，才启动这一轮完整根级验证。若最终门禁发现真实反证，保存现有结果并作废受影响结论，禁止立即盲目重跑；先定向归因、修复并穷尽同根及受影响闭包，全部直接证据重新成立后再冻结新基线并执行下一轮完整最终门禁。最终门禁因交付物修改而必须重取，不等于允许每修一个点就重跑根集。

进度反馈：首次读取后报告一次距离最终退出门的整体进度；此后只在完成一个实质阶段、进入等待或暂停以及用户询问时，以百分比报告整体进度，并用一句话说明已完成、当前和剩余。不得以单个 C 项、单条测试或一次构建的进度冒充总体进度，不得为汇报而中断工作或重复验证。

持续执行：

1. 按 C1 → C8 顺序推进。动手前先用当前基线复现对应事实并反绑权威条款；C3 的根因线索和 C5 的历史失败只作有限入口，未复现或不能反绑三份核心文档的事项不得修改。一个 C 项的全部实现与本项验收闭合后立即更新“执行状态”中的对应勾选，不得等到最后凭记忆补写。发现同根遗漏时，先把事实、权威依据和最窄工作补入原 C 项再实现，不另建回归文档或重复任务；发现范围外事项按本文排除规则停止扩面。
2. 每项都必须同时闭合真实生产责任边界、调用与消费链、正常和异常终态、直接测试及必要用户文档。方案以锁定范围内最简单、完整、可维护且不留已知结构债务为准；不得用放宽 timeout、更新 snapshot、修改旧计数、增加豁免、mock 自报或恢复旧接口让测试机械变绿。需要改变产品范围、用户体验或权威架构且三份核心文档不能唯一裁决时才暂停，并带着已查明事实与唯一决策点交给用户。
3. 状态和勾选只记录当前代码基线上的事实：`[ ]` 表示尚未完成或当前证据已失效，`[x]` 表示该行全部条件已经由本轮直接证据满足。C1～C8 必须逐项更新；只有八项全部为 `[x]`，才可勾选最终退出门中的“C1–C8 全部完成”。根级 lint/test/build、package check、十八条不变量与矩阵、Windows tarball smoke、最终对抗复核及残留清理必须分别在其实际完成后勾选，不得用历史结果或局部结果预先勾选。开始最终复核时把文档状态改为“对抗复核中”；复核发现真实问题时立即退回“执行中”。任何源码、测试、文档、构建产物或验收输入变化，只要可能影响某个已勾选结论，立即把对应 C 项、最终退出门项目或二者同时恢复为 `[ ]`、作废旧证据并重取；不得保留带条件的 `[x]`，不得在对抗复核完成前进入“待用户确认”。
4. 渐进验证并始终先查验证手册：修复阶段先跑最窄直接测试和受影响包，失败先归因，只重跑失效闭包；源码修改后按项目规则完成必要构建。进入 C8 后冻结同一源码与验收输入，完整运行根级 `pnpm lint`、`pnpm test`、`pnpm build`、canonical `pnpm package:check` 和 Windows x64 tarball smoke，并逐项取得十八条不变量、故障/安全矩阵、双拓扑及四时刻产品旅程的可追溯直接证据。不得以逐包结果之和、workspace 源码、历史 `dist`、mock、自报标签、第二台物理设备或真实外部系统代替合同要求。
5. 验证与清理贯穿全过程：使用隔离临时目录、隔离 `ZHIXING_HOME`、loopback 和真实 child process；每轮关闭日志、句柄、listener、helper 与子进程，确认无 `ENOTEMPTY` 和临时残留。不得触碰用户真实 home、秘密、外部账号或 registry，不得为验收建设通用诊断、benchmark、遥测或新框架。
6. 所有开发与初步验收完成后，把状态更新为“对抗复核中”，冻结当前源码、构建产物、tarball 和验收输入，在本文追加本轮“最终对抗复核记录”，至少登记冻结基线、每个 C 项及其独立子合同/验收条款的最强反例、实际检查或执行证据、发现的问题及处置、最终结论。复核不是重读清单、复述测试结果或证明自己做对了，而是从“不相信现有实现与绿灯”的冷启动立场重新寻找能够推翻完成结论的事实；必须重新阅读生产源码、沿真实入口追踪责任链，并对能够执行的反例运行最窄直接验证。没有实际攻击动作和证据记录，不得判定复核通过。
7. 对同一未修改基线完整执行四个相互独立的对抗面：①**权威覆盖攻击**——抛开 C1～C8 的自我描述，从三份核心文档重新枚举全部适用要求，逐条反查生产入口、唯一 owner、消费方、异常终态和直接证据，主动寻找漏项、错绑、平行事实源与规格前后不一致；②**逐任务反例攻击**——对 C1～C7 的每个独立子合同和验收条款至少构造一个最可能推翻完成结论的反例，覆盖真实生产调用而非仅测试夹具，重点攻击失败、取消、超时、响应丢失、重启重放、并发、资源不足、安全拒绝与清理边界中适用的有限组合；③**交界与证据攻击**——检查各项修改之间及其与既有双拓扑、持久化、资源治理、用户入口和打包产物的直接交界，主动证明测试是否可能只命中 mock、旧 `dist`、workspace 源码、错误组合根或不具识别力的 snapshot，并核验 C8 所有绿灯确属本轮同一基线；④**产品与范围攻击**——以不了解架构的用户身份实际走查配对第二开箱、日常本机/远端、离线/uncertain、撤销恢复、维护、应用停用和永久设备移除，寻找内部术语、虚假完成、无唯一行动、能力回退，同时反查是否借收尾新增了权威文档未要求的范围。每个对抗面都必须给出“尝试推翻什么、如何检查、看到什么、为何成立或不成立”，不得以“测试全绿”作为唯一结论。
8. 任一疑点只有同时反绑三份核心文档和当前生产事实后才登记为真实问题，避免为了对抗而硬找；一旦成立，立即把“最终对抗复核”、对应 C 项及所有受影响的最终退出门项目恢复为 `[ ]`，状态退回“执行中”，把同根问题补回对应 C 项，重新进入根因修复、直接验证和 C8 同基线全量验收。任何交付物修改都会使本轮冻结基线与整轮对抗复核失效；修复完成后必须从第 6 步重新执行完整四面对抗，不能只验证新问题或复用其余三面的旧结论。持续循环，直到一轮完整复核主动攻击了全部规定审查面、所有真实问题都已修复，并且同一未修改基线上没有未处置反证。无事实依据的设想、范围外增强和已明确排除事项不得借对抗复核重新进入任务。

完成条件：完成 C1～C8 及全部开发验证只是必要条件，不是结束条件；还必须在同一未修改基线上完成第 6～8 步的完整冷启动对抗复核，留下可核查记录，并确认没有未处置问题。“执行状态”的 C1～C8 与“最终退出门”的全部项目均为 `[x]`，生产能力和异常终态真实可用，根级 lint/test/build、canonical package check、Windows x64 tarball smoke、十八条不变量、故障/安全矩阵、双拓扑与四时刻旅程全部成立，无 P0/P1、临时残留、平行入口或新增范围外能力。满足后把文档状态更新为“待用户确认”，明确报告“distributed-runtime 最终收尾已达到技术完成条件，等待用户确认”，保留本文全部任务状态、证据和复核记录并立即停止；未经用户后续明确要求不得删除本文、继续完善本模块、暂存、提交、推送、发布或进入其他模块工作。
```

## 七、最终对抗复核记录

### 7.1　最终冻结基线与门禁

- 最终产品/测试输入基线：`HEAD 93678f5bf9c8e8fe376c14d8f25739c698ac3601`，排除本文这一证据账本后的未暂存交付差异指纹 `bb8f69a046a66727b3cf9d752c09bf2141fc093b`、暂存交付差异指纹 `80f2f49aaf6595a8fc442e875d5ece9830ee2106`。本文后续只写状态、勾选和本记录，不属于产品、测试、构建或 tarball 输入。全程未改写用户暂存区，未暂存、提交、推送、发布或访问真实 npm registry。
- 最终 tarball 集合 SHA-256：`59b90a52e93b2e1f445ac4570a37e2dd435a10455887a38cc9829b5fa4c81677`。
- `pnpm lint`：`.tmp/distributed-runtime-closeout/root-lint-final-4.log`，安全供应链、TLS 测试边界、秘密边界、S7 的 21 项结构攻击、registry golden 与 Biome 1567 文件全部通过。
- `pnpm test`：`.tmp/distributed-runtime-closeout/root-test-final-4.log` 完整串行执行 17 个工作区包并全部通过，CLI 为 259/259 文件、2959/2959 项；其后唯一交付变化是设备移除异常行动文案及其同文件测试。当前基线的 `.tmp/distributed-runtime-closeout/root-test-final-5.log` 在 core 的 178 个文件中取得 177 文件、2660/2661 项通过，唯一失败是无关的 delivery 耐久用例在 15.179 秒击穿外层 15 秒，零功能断言失败；按验证手册“core 全包仅资源时限失败”的既定规则，在无其他验证进程的新进程中定向重取为 1/1、1.403 秒通过（`.tmp/distributed-runtime-closeout/root-test-final-5-isolated-authority-pipeline.log`），禁止为取得形式绿灯重跑原范围。未变化的其余包继续复用完整根集结果，变化的 CLI 最窄闭包在当前基线重新取得 5 文件、23/23 通过（`.tmp/distributed-runtime-closeout/adversarial-cli-final.log`）；因此以“完整根集的未失效结果 + 当前基线原范围其余结果 + 独立超时单例 + 变化闭包”完成同一当前输入的全量判定。
- `pnpm build`：`.tmp/distributed-runtime-closeout/root-build-final-2.log`，17 个工作区包全部构建成功；core 既有 type-only Rollup 警告未产生声明、导入或消费合同失败，仍按本文排除规则不扩面。
- canonical `pnpm package:check`：`.tmp/distributed-runtime-closeout/package-check-final-2.log`。脚本从当前源码重新构建、打出 16 个公开包，在隔离 npm consumer、空 userconfig/cache 与隔离 `ZHIXING_HOME` 中验证 exact registry 依赖闭包、公共入口、真实安装后 CLI/帮助、维护与应用停用行动、Windows x64 helper 真实开关及 npm 卸载数据保留，随后自动清理临时根。
- 18 条不变量、故障/安全矩阵与双拓扑：三份核心文档的十八条口径重新逐项映射到 authority/assignment/delivery/transfer、capability/lease/resource、mesh/security、S7 结构门和组合根直接证据；当前基线 core 原范围 2660 项与独立单例全部成立，真实 S6 生产组合 8/8（`.tmp/distributed-runtime-closeout/adversarial-s6-conformance.log`）覆盖第一方/渠道、本机/远端 conversation 与 job、无合法 responder 和跨域 callback 拒绝。最后一次产品文案修改不进入上述生产组合根，复核时重新确认调用图与输入未变。

### 7.2　C1～C7 最强反例复核

| C 项 | 尝试推翻什么 | 实际攻击与证据 | 结论 |
| ---- | ------------ | ------------ | ---- |
| C1 | 仍有测试绕过统一临时目录，或绿灯后遗留目录 | 重新扫描测试/脚本中的原生 `mkdtemp/tmpdir`，反查 C1 九个 lint 目标与统一 helper；最终 lint 无豁免通过。首次冻结失败和对抗测试积累的 19 个精确 `zhixing-test-*` 历史残留已在确认均为系统临时根直属子目录后删除，最终复查为 0 | 未发现旁路；清理闭合 |
| C2 | 18 kind/14 owner 只是改断言，存在缺 owner、双 owner 或 permit 旁路 | 抛开 C2 自述，从规格后续职责重新枚举七个补充 kind，逐一追到 workspace probe、executor ticket/spool、owner-kernel transfer、mesh/CLI checkpoint、managed service 与 device lifecycle 的生产调用点；反查 canonical 映射、single-flight、pre-commit 取消、committed 义务与叶步骤 permit | 规格、映射、调用点及异常终态全等；无平行 owner |
| C3 | timeout 被机械放宽、CPU 诊断改写容量、committed 背压被吞、stop 仍泄漏资源 | 重读 FileLock 默认 resolver、设备容量、projection/surface/checkpoint 和真实组合根生命周期；当前根级 core 只有一个已按手册证伪的外层资源超时，功能断言 2661/2661 合并成立。CPU 只留诊断，slot 为版本化策略；投影/资产恢复在退出互斥后有界重驱且不重放已开始任务；临时目录、package-check 根和相关 Node/helper 进程最终均为 0 | 生产期限、fsync、断言与公平性未降级；无 `ENOTEMPTY` 或生命周期反证 |
| C4 | credential rotation 仍旁路 governor，或 v1 恢复包被错误入口/篡改载荷接受 | 重新扫描全部生产 `provider.chat` 与组合根注入；当前 governance registry 2/2 证明每个生产文本调用恰一预算分类。重读严格 v1/v2 decoder 与全部 consumer，当前 consumer-boundary 1/1 证明 v1 只达两个初始 root-activation 入口，rotate/灾难恢复等入口不接受 | 两项生产合同均闭合，安全拒绝未放宽 |
| C5 | fixture/golden 绿灯来自恢复旧接口、自报或明文迁移外泄 | 重新扫描生产 `MemoryStore`、旧 delivery 入口、`credentials.json` 和迁移函数导出；确认生产无 MemoryStore，唯一明文引用仍是 `loadCredentialSnapshot` 内私有 exact legacy 消费方，秘密门和 S7 的 21 项 mutation/结构攻击通过；structure golden 仍反绑真实动态入口 | 没有复活旧 API、平行事实源或测试自报 |
| C6 | 二维码/文本不是同一邀请，失败后伪 ready，网络术语重新泄漏，响应丢失导致第二次准入 | 当前基线重新运行真实 mesh pairing 7/7：offer 先耐久、恢复包回读失败保持 mesh 关闭、直连/盲中继、直连优先及响应丢失续做均通过；最终实际 `pair --help` 只显示“另一台设备/邀请内容”，技术参数全部隐藏。S6 的本机/远端真实组合继续成立 | 第二开箱正常与异常链均诚实、可恢复、零拓扑认知 |
| C7 | registry、默认帮助、README 和 tarball 各自维护不同命令表，或隐藏入口泄漏 | 当前基线 `root-help.test.ts` 5/5 从真实 Commander registry 反查 README 标记区；实际构建产物的 root/pair/device help 再走查无内部拓扑词；canonical package check 从安装后的 tarball 读取真实 registry 与帮助，验证公开/隐藏分类 | 四方 exact-set 全等，无第二份手抄事实源 |

### 7.3　四面对抗复核

1. **权威覆盖攻击**——尝试推翻“C1～C8 已覆盖全部冻结义务”。做法是重新完整阅读需求、总纲和执行规格，不以任务清单为目录，重新枚举单产品/双拓扑、唯一 owner、双平面、耐久权威与 uncertain、统一资源治理、离线本地域与收编、迁居/备份、服务生命周期、Windows npm 交付和四时刻旅程，再反查生产入口、唯一 owner、消费方、异常终态与直接证据。看到的结果是所有适用要求均落入既有 C 项或明确排除项；18 kind/14 owner 与规格后续职责全等，没有遗漏、错绑、平行入口或新的规格自相矛盾。因此覆盖结论成立。
2. **逐任务反例攻击**——尝试用失败、取消、超时、响应丢失、重启重放、并发、资源不足、安全拒绝和清理边界推翻 C1～C7。做法包括生产调用图复查、FileLock/容量/投影/资产/checkpoint 源码重读，恢复包与 provider consumer 扫描，以及当前基线 core、CLI 23/23、S6 8/8 的最窄可执行反例。发现两项真实问题：19 个历史测试临时目录尚未清除；设备移除状态查询失败时给出不可执行的裸 `device status`，pending 分支也没有完整继续行动。前者已精确清理至 0；后者已改为带 `zz`、子命令、设备名占位与本次设备名的唯一行动，并由直接测试 8/8、lint、build 和当前 tarball 重验。交付物修改后本节四面对抗从冻结基线重新执行；没有复用修改前的完成结论。
3. **交界与证据攻击**——尝试证明绿灯只命中 mock、旧 `dist`、workspace 源码、错误组合根或不具识别力的 snapshot。做法是检查 S6 测试装配的真实 `setupAuthorityRuntime`、真实日志/资产、in-process/mesh adapter 与 distinct remote executor；检查 package-check 的 `pnpm pack → file:tarball 安装 → installed node_modules import/CLI/helper` 链及 exact dependency/asset 校验；重取最终 HEAD、交付差异与 tarball 指纹，并检查日志、进程和临时根。看到 S6 八条均走生产组合，package-check 不消费 workspace 源码或历史 dist，最终构建和 tarball 来自相同交付输入；最后一次根测的单一 15 秒超时在独立新进程 1.403 秒通过，符合验证手册已有资源失败模式而非功能反证。因此证据具有识别力。
4. **产品与范围攻击**——尝试从不了解架构的用户视角寻找内部术语、虚假完成、无唯一行动、能力回退或借收尾扩面。实际走查构建产物的 root/pair/device 帮助、配对出码/加入/回读/配置/值班链、值班设备离线行动、日常本机/远端 conversation/job、uncertain 与 publish 失败呈现、维护 stop、应用停用、灾难恢复和永久设备移除。设备移除异常行动问题已按上项修复；其余入口只使用“值班设备/干活的电脑”等产品语言，完成态均来自权威终态，维护、应用停用和永久设备移除保持三条不同且可执行的路径。本轮没有新增业务能力、通用框架、诊断/benchmark、平台承诺或发布路径，distributed-runtime 仍只是服务知行愿景的基础能力，不构成产品核心。

### 7.4　最终结论

第二轮完整四面对抗已在上述未修改交付基线上完成。两项成立的问题都已处置并使旧复核结论失效，修复后重新取得变化闭包、lint、build、canonical package check、Windows x64 tarball、帮助与残留证据；唯一根测超时已按验证手册用独立单例证伪，没有修改测试预算或生产合同。当前没有未处置反证、P0/P1、临时目录/进程、平行产品入口或新增范围外能力。distributed-runtime 最终收尾已达到技术完成条件，等待用户确认。
