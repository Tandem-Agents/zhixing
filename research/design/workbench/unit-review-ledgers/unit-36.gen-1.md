# 单元登记:第 36 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:36
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-11
- **登记来源**:用户要求将第 36 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:第 36 单元已封版。13 项正式问题均为“已验证”，P0/P1 与非阻断问题列表为空；同一全量冻结指纹已完成两轮零新增冻结终审、独立功能审查和单元提交验证
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是（第 36 单元完整交付已冻结；任何非工作台功能文件变化都会使两轮终审、独立功能审查与单元提交验证结论失效）
- **交付物文件集**:以第 35 单元封版代码提交 `b6323cb8` 为基线，当前 Unit 36 功能交付为 61 个非工作台路径：CLI 36、core 4、mesh 2、owner-kernel 2、secrets 4、server 8、架构/规格 3、S7 2；工作台文件与同期 Unit 35 归档不参与功能指纹
- **当前交付物指纹**:`sha256:28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7`（算法：相对路径排序后连接 `path<TAB>SHA256(file-bytes)<LF>`，再对 UTF-8 记录流取 SHA-256）
- **架构来源**:`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md`、`research/design/modules/distributed-runtime/s2-security-supply-chain-review.md`，以及已定稿开发清单 D36-01～D36-09

## 固定边界

- **功能范围**:S10 托管服务与角色自恢复；只把既有单一 `serve` 组合根接入当前用户的跨平台 OS supervisor，使 current anchor 自恢复、用户选择的 executor 自动上线，并保持纯 surface 与按需单机零额外常驻
- **架构不变量**:current signed trust/current issuer、严格角色配置与 SecretStore backend binding 是 launch plan 唯一输入；托管服务不成为第二 authority，三种进程形态只进入同一 `runServeCommand`/runtime 组合根；未启用角色零进程、零模块、零监听；公开状态必须诚实、有限且零秘密
- **验收条件**:跨平台安装/启动/关闭、崩溃与登录/开机拉起、角色与 current-authority 变化收敛、executor 上线续驱、纯 surface 合法消费、CLI/server 同源状态及必要直接证据闭合；P0/P1 清零后按工作台完成冻结与提交验证
- **必要上下游**:上游只读复用第 33～35 单元已封版的 checkpoint/recovery、planned/disaster installation、installed-generation/current-owner、pending/outbox、capacity 与 credential readiness；下游第 37～38 单元能力不进入本单元
- **明确不属于本单元**:第 37 单元三路径停机、设备移除/卸载和 authority/identity/cache 清理；第 38 单元升级、兼容、原子替换、自动回滚和发布矩阵；自动 failover、全局/持续同步、恢复应用、多 active anchor、通用 lifecycle/IPC/router/registry、监控、诊断、benchmark、信息采集和新 runner

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| ------------------------ | ------------------------- | ---------------- | ---- |
| CLI 托管入口、runtime、supervisor/reconciler、surface 与直接测试（36） | CLI dist、launch/config/turnover、三平台定义与状态、启动恢复、surface relay、公开状态及全部直接消费者 | 历轮同输入直接证据均有效；最后变化的 4 个直接测试文件 47/47，CLI 类型检查仅复现 8 个未改 credentials `version` 基线错误，当前 CLI build 成功 | 通过 |
| core/mesh/owner-kernel/secrets/server 生产、合同与直接测试（20） | launch/role/capability、scheduler wake、SecretStore binding、server drain/status/DTO 与跨包导出 | 对应输入自最近 workspace build 后未变化；已登记 manifest/scheduler/secrets/server 直接证据与一次 workspace build 均有效 | 通过 |
| distributed-runtime 总纲、需求、规格（3） | Unit 36 全部托管、自恢复、surface、状态与资源合同，以及 Unit37～38 排除 | 与 D36-01～D36-09、F36-01～F36-15、13 项正式问题、EX36-01～EX36-05 和 IR36-01～IR36-35 双向对账 | 通过 |
| 既有 S7 descriptor 与测试（2） | managed-host/profile/trigger/future-only/current-stop/surface-lifetime exact-set 与 registry golden | production gate、mutation 19/19 与 registry golden 在当前 S7 输入上通过；无新 runner、依赖或 lockfile | 通过 |
| package/lockfile/schema/其他派生资产 | 本单元未修改 package manifest、lockfile 或独立 schema；`dist` 为忽略的构建产物 | 基线差异与 61 路径闭包核对，无需同步 lockfile/schema | 不适用:无对应交付变化 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| F36-01 · Windows definition bytes | `ManagedServiceSpec` 派生的 canonical UTF-16LE+BOM bytes，身份绑定 `serviceId + digest(bytes)` | 私有临时文件 fsync→rename→目录 fsync；`schtasks /Create` 后有限语义 query/read-back 全等 | 写入前后、rename 前后、`/Create` 效果/响应窗口、系统规范化、重启 | renderer/writer/adapter/reconciler；Windows Task Scheduler | 单份 bounded definition；本地同 bytes exact replay，系统异 principal/trigger/command fail-closed | 通过 |
| F36-02 · definition durable/manager identity | 落盘原始 bytes 与 supervisor 查询的同一 `serviceId` | 落盘 byte-for-byte read-back 与 manager definition match 同时成立 | 转义路径、首次/重复安装、stored/manager 单边存在 | 三平台 adapter、managed preflight/status | 零扫描；每次固定有限 query/read-back | 通过 |
| F36-03 · future-enabled/current-running | supervisor 对同一 platform domain/serviceId 的 enabled 与 running 两个独立事实；Windows 两个 enabled 位必须一致 | reconciler 只收束 future launch；current instance 只由既有 graceful completion 或 exact stale endpoint/lock 事实终结 | enabled 冲突、两步任一效果/响应丢失、安全 blocker、连续重启 | adapter/reconciler/current host/router/listener/status | 固定命令序列；冲突 fail-closed，不卸载、不强杀，安全点前零 supervisor current stop | 通过 |
| F36-04 · bound master-key existing-only | canonical home 的 backend binding 与绑定 backend 原 backing key | existing-only 读取/验真成功；既有 binding 打开零写 | binding/backing/vault 有无与歧义、backend 锁定/不可用、重启 | bound provider、四 backend、vault/managed preflight | 单 key；无新上下文，missing/ambiguous 零写 | 通过 |
| F36-05 · first foreground/legacy binding | vault/key 既有性与一次原子 backend binding | legacy existing-only 成功后写 binding；全新空 store 首次 foreground 创建后写 binding | legacy 回填效果/响应丢失、managed/foreground 并发 | provider factory、serialized provider、startup | 初始化锁单飞；managed 永不创建 | 通过 |
| F36-06 · supervisor query classification | 平台命令的 documented exit/output 归一为 found/not-found/permission/manager-unavailable | 只有确定 not-found 产生 absent；其他类在 definition 写前终止 | command missing、权限、session/manager 不可达、输出歧义 | runner/adapter/reconciler/status mapper | 固定四类；不保存/公开 raw stderr | 通过 |
| F36-07 · managed status snapshot | 同一次 current load 派生的 plan/spec + 真实 inspect + process/readiness | 末尾复验 plan/spec identity；一致后形成只读 snapshot | definition drift、旧实例、配置关闭、读取中换代、manager 错误 | CLI/server snapshot builder与唯一 mapper | 最多一次有界重读；零持久状态 | 通过 |
| F36-08 · public status projection | `ManagedHostStatusSnapshot` 的有限字段 | CLI/server 对同 snapshot 输出 exact DTO | managed/on-demand/none × process/readiness/service/error | CLI human、server `/api/status` | exact keys；无路径/service/device/role/raw error | 通过 |
| F36-09 · canonical-home reconcile worker | canonical resolved home + 每轮重读的 current plan/spec；trigger 仅是 wake provenance | 同 home worker 一轮完成且 dirty=false；三类 non-managed/error/drift 分支只调用 future-only adapter | 六 trigger、binding 前后、同/异 home、并发 wake/响应丢失 | pairing/config/trust/preflight/host-missing、窄 adapter view | 同 home恰一 worker；后继 wake 有界重驱；类型与运行时均无 full-stop 能力 | 通过 |
| F36-10 · listener admission | 启动时冻结的 current plan/spec/trust identity 与运行中同一 `ManagedHostAdmissionSnapshot` | `runServer` 前全等复验；trust/role 同 mode 换代也先拒新并 graceful restart | managed/foreground/on-demand、trust/config/role 变化、listener 窗口 | topology/command/router refusal/shutdown | 单份 immutable identity；不新增 generation coordinator | 通过 |
| F36-11 · surface current-authority link | current signed trust 的 issuer deviceId + 认证 surface principal/generation | canonical relay method dispatch 到 current anchor；本机副作用始终为空 | surface/empty、remote ready/offline、错误 owner、首次/重连 | `CoreHostConnection`、认证 mesh、finite client | canonical exact-set；零 spawn/module/listener | 通过 |
| F36-12 · owner change/notification/dispose | control plane 的 current signed trust 全量 identity；surface client 的 exact `ActivePoll` token/controller 是唯一连接 owner | trust watcher 或 close 只释放同代 token 并 abort；每次 poll attempt 只借 stop signal | 海量成功、transient/BUSY、fatal、同 owner 换代、异 owner、离线、响应丢失 | surface link、mesh control plane、FirstParty client、connection-lifetime helper | 单连接一个 callback/controller；attempt listener finally 释放，离线不回退旧 owner | 通过 |
| F36-13 · definition/disable 交界 | 同一 serviceId 的 canonical bytes、immutable definition exact-set 与一致的 dynamic enabled/running 投影 | 只对匹配 definition 的实例改变 future state，false/false exact replay；冲突投影 fail-closed | drift+降级、效果丢失、re-enable、manager 错误 | U36-01/U36-02/U36-10 共享 adapter | 固定 read→future effect→read；零删除，dynamic state 不改 identity | 通过 |
| F36-14 · reconcile/status/error 交界 | current plan/spec、窄 adapter view 与有限错误分类 | plan error、post-install drift、final non-managed 只消费同一 future-only 能力；snapshot 消费诚实 inspection | 六 trigger、dirty wake、旧实例、不可判定 manager、状态查询换代 | U36-04/U36-06/U36-10 全消费者 | 有界重读；零第二事实源、零 serviceId current-stop | 通过 |
| F36-15 · 产品与后续单元边界 | Unit 36 固定范围与 EX36-01～EX36-04 | 三项直接合同闭合即停止 | 卸载/升级/回滚/诊断/runner 扩张诱因 | 正式问题、规格与审查清单 | 不新增第37～38能力、通用框架或信息采集 | 通过 |

## 审查结论复用表

> 每行一个可独立失效的完整功能或合同事实链，生产端、事实源、消费者、异常终态和测试不得拆开；无法独立指纹、独立失效或需重读多数其他项时合并。整表须覆盖固定边界、全部交付文件、关键原语和九类核查面。
>
> 常设一项跨项组合推演。其他项均已取得或复用本轮结论后，再审查组合项；组合项按编号汇总各项当前输入指纹与结论。任一其他项新增，或其边界、输入指纹、结论变化时连带失效。
>
> 只有覆盖全部登记输入且该项结论无问题的问题盘点或冻结终审可计次，每轮每项至多一次，证据列须引用审查轮及证据；某项发现问题只清零该项，同一输入达到 2/2 后才可持续复用。状态只允许“待审”“审查中”“通过”“失效”“有问题:编号”，独立深审只允许“0/2”“1/2”“2/2”。

| 编号 | 审查目标与核查面 | 登记输入（关键实现、全部生产点、消费路径、测试） | 最近通过的输入指纹（算法 + 值） | 重审条件 | 当前状态 | 有效独立深审 | 本轮结论与证据 |
| ---- | ---------------- | ------------------------------------------------ | ------------------------------- | -------- | -------- | ------------ | -------------- |
| R36-01 | launch plan、角色/profile、自动上线选择与稳定服务身份 | core identity/manifest；mesh bootstrap；CLI config/pairing/self-exec/managed spec 与全部直接测试；IR36-01～IR36-05、IR36-24 | 61 路径规范化 SHA-256 `28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7` | role/boot config、plan truth table、service/spec identity、pairing/config producer 或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15独立重造 config/trust 并发、重复/越权 role、pairing/commit 丢响应与连续重启，三态与稳定 identity 始终由 current durable 输入唯一派生。 |
| R36-02 | 三平台 definition bytes、supervisor 动态状态、有限错误与幂等 read-back | managed-service renderer/writer/adapter、runner/classifier、Windows COM projector、guest fixture；IR36-05、IR36-07～IR36-11、IR36-25、IR36-30、IR36-33 | 同上 | definition/spec、OS command/query/decoder、dynamic/immutable matcher、fixture 或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15逐个攻击 write/rename/create/disable/start/query 响应窗口、enabled冲突、locale/SID/typed drift、permission/manager/spawn 与重启，均 fail-closed 或 exact replay。 |
| R36-03 | SecretStore binding、existing-only/activation 与启动 admission identity | secrets provider/binding/vault；managed-service-runtime、command/topology/self-exec、mesh device key；IR36-06、IR36-17、IR36-28、IR36-33 | 同上 | binding/backend/key、inspect/activate intent、admission snapshot、startup gate 或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15重造四 backend 的 binding/backing/vault 缺失/歧义、legacy回填丢响应、managed fresh 与 startup 换代，inspect 零写且错误 identity 不越过 admission。 |
| R36-04 | canonical-home reconcile、配置 drain/turnover、future/current 双事实与单实例安全 | reconciler、config command/repl、CoreHostConnection、server shutdown/context、topology 与直接测试；IR36-04、IR36-12～IR36-16、IR36-20～IR36-21、IR36-29～IR36-30、IR36-34 | 同上 | trigger exact-set、worker/successor、adapter capability、accepted-work drain、endpoint/lock 或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15反向枚举六 trigger、同/异 home/进程、load/manager/apply失败、四类accepted work、drain超时与old/new endpoint，future-only与current safe-point权限不交叉。 |
| R36-05 | managed runtime 恢复、authority consumer/pending/outbox 与连续重启 | command/runtime assembly、scheduler、mesh control plane、installed generation 与 server gate；IR36-17～IR36-23、IR36-27、IR36-30、IR36-34 | 同上 | bootstrap/rollback、consumer/pending exact-set、authority/current-owner、scheduler/delivery 或恢复测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15从每个 startup/consumer 效果切点、旧 epoch/owner、listener 窗口、响应丢失和连续重启重建，gate 前恢复与 rollback 保持唯一终态。 |
| R36-06 | pure-surface current-anchor relay、owner 换代、poll/notification 与资源上界 | surface-core-host-link、first-party mesh、connection-lifetime helper、mesh registry/control plane；IR36-14～IR36-15、IR36-26～IR36-30、IR36-32、IR36-34 | 同上 | relay exact-set、owner identity、poll controller/backoff、notification/history、close/dispose 或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15重造海量成功、三类transient/BUSY、fatal、owner换代、同步close/dispose与stale completion，exact token 不误删且 callback/listener/controller 恒 O(1)。 |
| R36-07 | CLI/server 同源公开状态、用户旅程、隐私与可行动错误 | status snapshot/mapper/routes/types、config/pairing/host-missing 用户链及测试；IR36-24～IR36-26、IR36-28、IR36-30、IR36-32～IR36-34 | 同上 | snapshot/mapper/DTO、manager/readiness mapping、CLI/server consumer、产品旅程或测试变化 | 通过 | 2/2 | V36-14正向闭合；V36-15攻击读取中换代、disabled+running、drift、旧实例、credentials lock、manager不可判定与远端离线，单 snapshot 只输出有限真实且可行动状态。 |
| R36-08 | 资源/取消、分层兼容、S7/golden、交付证据与后继边界 | storage maintenance/scheduler wake、全部 exports/contracts、S7 runner/test、三份权威文档、61 路径闭包；IR36-27～IR36-31、IR36-33～IR36-35 | 同上 | resource kind/budget、package/export、descriptor/registry、权威来源、文件集或 Unit37～38 边界变化 | 通过 | 2/2 | V36-14正向闭合；V36-15逐项核对取消/permit/队列上界、package/export、S7 mutation/golden、EX36重开条件与61路径，未发现越界、遗漏或范围外门禁。 |
| R36-X | 跨项组合：plan/secret × supervisor/reconcile × runtime/authority × surface/status/resource | R36-01～R36-08 当前输入与结论、13 项正式问题、EX36-01～EX36-05、L36-01～L36-04 | 按 R36-01～R36-08 编号、指纹与结论排序汇总；当前功能指纹同上 | 任一 R36 项边界、输入、状态或结论变化，或出现新生产事实/迟发现教训 | 通过 | 2/2 | V36-14正向组合通过；V36-15交叉重造 locked secret+plan change+manager loss+accepted work+owner swap+poll failure+restart，无误停、双 owner、秘密写入、公开半态或资源泄漏。 |

## 问题列表

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U36-01 | **P0/小，同根重开。** 真实 Windows `schtasks /Create /XML` 已证明原 canonical UTF-8 文件即使 XML 声明改为 UTF-8 仍被 Task Scheduler 拒绝；带 BOM、声明为 UTF-16 的 UTF-16LE 文件可成功注册。稳定身份是 `serviceId + canonical definition bytes`，耐久点是临时文件 fsync 后 rename/目录 fsync，OS 生效点是 `/Create` 成功及 query read-back。**价值裁决记录**：原方案错误假定 Task Scheduler 接受 UTF-8；C36-C31 是当前受支持 Windows 主路径的直接生产反证，满足原记录重开条件。新决定仍为 P0/小，只把 Windows 单一字节格式改为 UTF-16LE+BOM；macOS/Linux 保持原格式，不新增通用编码层。用户体验达标、架构达标。 | renderer 字符串、durable bytes、definition identity 与真实 Task Scheduler 消费格式未共享一个被系统接受的最终字节合同；测试只验证通用 XML parser，未穿过真实 `/Create`。 | **生产端**：Windows definition render/write、`schtasks /Create` 与 inspect。**类型组合**：空格/引号/XML 转义路径、UTF-16LE+BOM、首次/重复安装、写入/创建效果前后失败、响应丢失与重启。**消费者**：adapter、reconciler、current anchor/executor 启动链。**异常终态**：创建前稳定失败或重放永不收敛；系统 query 对账户/SID/default fields 的规范化不得误报 drift；其他平台格式不受影响。**测试/审查项**：最终 bytes 解码/解析、真实创建与语义 read-back；IR36-07、IR36-11、IR36-30、IR36-32～IR36-35。 | Windows renderer 声明 UTF-16，`managedServiceDefinitionBytes()` 唯一生成 BOM+UTF-16LE；durable writer、definition digest/比较和 `/Create` 共用该 bytes并原始回读全等。系统 query 只按冻结 spec 对 principal/trigger/Action、command/arguments 与 restart 设置作有限语义验真，容许 SID/域名/default field 规范化。验收覆盖转义、首次/exact replay、各响应窗口及真实 adapter 创建/read-back；同一 `serviceId` 不接受语义漂移。**实施证据**：真实 production adapter 已注册 UTF-16LE 任务并由系统 COM 回读同一 principal/trigger，测试 finally 清除任务。 | 已验证 |
| U36-02 | **P1/中。** Windows `disableManager()` 只执行 `/Change /DISABLE`，macOS 只执行 `launchctl disable`，但 `disable()` 随后要求 `running=false`；两条 supervisor 命令只禁止未来拉起，不终止当前实例，测试 fake 却同步改写 enabled/running。稳定身份是同一 `serviceId` 及其 platform domain，future-enabled 与 current-running 是两个独立 OS 事实；完成线性化点是二者分别回读为 disabled 与 not-running。**价值裁决记录**：保持现状或放宽 read-back 会留下旧 role/listener；现有 `/End`、`bootout` 足够，无需第 37 单元卸载或新 lifecycle。用户体验达标、架构达标。最终结论：保留 P1/中。 | adapter 把“禁止未来自动拉起”和“停止当前实例”误作一个 supervisor 状态转换，fake 又掩盖了真实双事实/双效果边界。 | **生产端**：Windows/macOS disable 与 Linux 既有 `disable --now`。**类型组合**：managed→on-demand/none、role/选择撤销、running/stopped/manager-absent、两步任一效果/响应丢失及连续重启。**消费者**：reconciler、current host、router/listener gate、公开状态。**异常终态**：旧 host 继续服务，或已经停止却因回读混合事实无法 exact replay。**测试/审查项**：真实 supervisor 双事实、幂等重放；IR36-07～IR36-08、IR36-11、IR36-20、IR36-30、IR36-32～IR36-34。 | 当前实例内的 trust/config 变化先关闭 gate，并只请求既有 graceful shutdown；响应丢失由 endpoint turnover/read-back 吸收。旧实例到安全点退出后，由配置重连或 supervisor 新实例的 managed preflight 调用同一 adapter：Windows `/Change /DISABLE`→必要 `/End`，macOS `disable`→必要 `bootout`，Linux `disable --now`，分别回读 future-enabled/current-running；已停/not-found exact replay，permission/unavailable fail-closed。验收覆盖两种降级目标、安全 blocker、同 mode 角色换代、各响应窗口和连续重启，零卸载/强杀。 | 已验证 |
| U36-03 | **P1/中。** `BoundPlatformMasterKeyProvider` 读到既有 backend binding 后仍调用 delegate 的 `loadOrCreate()`；DPAPI 与 machine-bound 在 backing file/seed 缺失时会写新值，Keychain/Secret Service 在 vault 不存在时也会创建，只有已有非空 vault 时才先行拒绝。稳定身份是 canonical home 的 durable backend binding 与该 backend 原 backing key；首次创建线性化点是 backing key 成功后原子写 binding，既有 binding 的打开不得产生写。**价值裁决记录**：原“可继续写入第二秘密上下文”被既有非空 vault 的认证门禁证伪，不恢复；但 bound existing-open 仍有可达创建副作用并把 missing/locked 混成 unavailable。用户体验达标、架构达标。最终结论：改写事实，保留 P1/中；仅新证据证明旧 vault 可被新 key 越过时重开原主张。 | provider 只有 create-capable 契约，未按“已有 binding/既有 store”与“无 binding 的首次 foreground 初始化”分离读取权限。 | **生产端**：`BoundPlatformMasterKeyProvider`、DPAPI/Keychain/Secret Service/machine-bound delegate 与 vault unlock。**类型组合**：binding 有/无、backing key 有/缺/歧义、vault 空/非空、managed/foreground、legacy binding 回填与重启。**消费者**：SecretStore、managed preflight、launch spec、公开 credentials 状态。**异常终态**：既有 binding 打开先改变 backing 事实再失败，或把可行动 locked 状态误报为普通不可用。**测试/审查项**：三平台 backend 与 machine-bound 的 existing-only 零写矩阵；IR36-06、IR36-28、IR36-32～IR36-33。 | 在现有 master-key provider 增加窄 `loadExisting()`：有 binding 时 foreground/managed 均只按绑定 backend 读取并验真原 key，missing/ambiguous 稳定映射 `credentials-locked` 且零创建/覆盖；无 binding 时，legacy store 只能 existing-only 成功后回填，只有确认 vault/key 均未初始化的首次 foreground 才可复用 `loadOrCreate()` 并原子写 binding，managed 永不创建。验收覆盖各 backend、空/非空 vault、legacy 回填、重启及写调用 exact-set，不新增第二 SecretStore 上下文或 lifecycle。 | 已验证 |
| U36-04 | **P2/小，同根重开（来源 P36-01）。** 原 U36-04 已验证 canonical-home single-worker dirty-loop、六类触发、三运行形态 gate 与 listener 前 plan/spec 复验；修复前源码证明，同 home 后继 caller 在旧 worker 运行中只置 dirty 并返回同一 promise，若旧迭代在 load/manager/apply 处拒绝，finally 删除 map 时该后继语义随旧 rejection 一并丢失。生产入口均使用不可取消 signal，失败可见且仍有 host-missing、managed preflight 或人工重试等既有重驱，故当前损失只是一次收敛延迟，不恢复旧 P0/P1、安全 gate 或专用 coordinator 主张。**价值裁决记录**：原结论为 P1/中并拟建立 worker generation/独立 waiter；生产事实排除了独立取消与无提示静默失效，新决定为 P2/小、一次有界 successor。重开条件：生产开始传入独立可取消 signal，或一次被吞 wake 可在无既有重驱时让失效角色继续公开服务。 | canonical home 是稳定 identity，map 中 worker/promise 是唯一共享并发事实；修复前实现只为成功循环保留 dirty，未规定“加入失败 worker 的 caller”在共享失败后的 successor 终态。首发 caller、加入者与新触发没有各自持久状态，问题不能用 generation/waiter 修补。 | **生产端**：pairing issuer/joiner、config、verified trust、managed preflight、host-missing 六类 trigger 与三运行形态。**直接变体**：首轮成功；load/manager/apply 失败；一个或多个后继 wake；同/异 home；持续失败；效果已发生但响应失败；进程重启。**消费者/终态**：原 caller 诚实收到原失败；加入旧 promise 的 caller 最多发起一次 current-input successor；同 home fallback 仍单飞、异 home 独立；第二轮仍失败则终止，不递归重试；gate/listener 既有零公开副作用边界不变。**测试/审查项**：IR36-12～IR36-13、IR36-20、IR36-29、IR36-30、IR36-34；C36-C06、F36-16～F36-18。 | 保留现有 map 与 single worker，把内部 join/start 增加一次性 retry budget：仅“加入既有 promise”的 caller 在共享 rejection 后，以自己的 current loader/adapter/signal 再进入一次且把 budget 置零；原 owner 直接返回原失败，多个 fallback 由 map 合并为恰一 successor，successor 失败不得再次 fallback。直接测试覆盖首轮三类失败+后继 trigger、多 joiner、持续失败、异 home、效果/响应丢失与重启，证明一轮 successor 上界、零并发第二效果且现有 gate/listener 不变；不新增 generation、waiter 或 lifecycle。 | 已验证 |
| U36-05 | **P2/小，第二次同根重开（来源 P36-09；原 P1 poll 断线恢复已验证）。** 稳定身份是 `{FirstPartyConversationMeshClient 实例、current-owner identity、connection.id、surface principal/generation、ActivePoll token}`；`active.set(connection.id, token)` 是连接代际所有权生效点，只有 map 仍指向同一 token 的 fatal/close/dispose/owner 换代才能移除。当前每个成功 poll attempt 都重新调用 `fulfillConnectionLifetimeObligation()`，helper 又向同一未决 `active.connectionClosed` 注册不可摘除的 `.then(abortFromConnection)`；attempt 返回后 reaction 仍捕获内部 controller，直到整条连接关闭，故驻留确定为 O(成功响应数)。**价值裁决记录**：原独立结论为 P2/小；反向裁决确认长期 pure-surface 是当前受支持场景且驻留无界，但没有消息错误或短期不可用证据，故不恢复原 P1。保持现状违反有限资源合同，新增通知 ack/outbox 或通用重连框架超过价值；仅当任意成功次数下连接级 callback/controller 为常数且既有断线恢复不退化时关闭。用户体验达标：长期在线不持续增压；架构达标：一个 active controller 独占连接生命周期，attempt 只拥有本次请求。 | 先前修复闭合了 active slot 的 exact controller、transient/fatal/close/换代终态，却同时保留了 `ActivePoll.connectionClosed` promise 与 controller 两个连接生命周期 owner；逐 attempt helper 订阅前者，形成无法在 attempt 完成时释放的第二所有权链。 | **生产端/事实源**：`FirstPartyConversationMeshClient.#poll()`、`ActivePoll` map/token、唯一 `connection.onClose` callback、`fulfillConnectionLifetimeObligation()`。**类型组合**：单次/海量成功、三个 transient mesh code或 `RpcAppError(BUSY)`→成功、fatal、owner 换代、close/dispose、notification drain 与历史补读。**零副作用/终态**：成功 attempt 只移除自己的 `stopSignal` listener并开始下一次 fresh helper；close/换代只 abort exact token，stale completion 不删新代；fatal 结束当前代且不新增通知协议，已丢 committed final/status仍由 last-seen revision/history 补读。**测试/审查项**：IR36-29；P36-09 资源反例。 | 删除 `ActivePoll` 的 `connectionClosed/resolveClosed` 第二事实，只保留 exact abort controller；已有唯一 `connection.onClose` callback 调用同代 release 并 abort controller。把 helper 的 `connectionClosed` 输入收窄为可选，pure-surface poll 只传该 controller 的 `stopSignal`，其他一次性连接调用者保持原语义。直接测试用可观测 onClose 集合证明单次/海量成功与 transient→success 始终恰一连接 callback、每次 attempt listener 在 `finally` 移除，fatal/close/换代后归零且 stale completion 不误删新代；既有 backoff、notification drain 与历史补读不变。**实施证据**：`ActivePoll` 只保留 exact abort controller，唯一 onClose 回调释放同代 token；helper 的 `connectionClosed` 已收窄为可选且两个一次性生产调用者仍原样传入。128 次连续成功与 transient→success 证明连接级回调恒为 1、关闭后为 0，直接闭包 12/12 与 S7 mutation 通过。 | 已验证 |
| U36-06 | **P1/中。** CLI 会读取 durable plan 与真实 adapter inspect，但 server 只按 `processMode` 推 desired 并硬编码 enabled/running/matches；共享 mapper 又不检查 `service.matches`，并在 desired 为 none 时先返回 not-needed，能遮蔽仍运行的旧 managed instance。因此同一 home 在 definition drift、配置关闭、旧实例仍活、manager 不可判定等场景会生成两套公开结论。稳定 snapshot identity 必须绑定同一次 current plan/spec 读取及对应 supervisor inspect/runtime readiness；它只是无副作用读模型，不能成为第二 durable 状态。**价值裁决记录**：保持现状会把不可持续恢复的实例明确误报为“可以使用”或“不需要后台运行”；现有 plan、inspect、process/readiness 足够，不需要状态框架。用户体验达标、架构达标。最终结论：保留 P1/中。 | CLI 与 server 各自拼装 desired/service/process/readiness，缺少一个从现有权威事实构成且拒绝混代的 managed-status snapshot 生产者；mapper 的 desired 快路又越过真实旧实例。 | **生产端**：launch plan/spec loader、adapter inspect、PID/health 与 runtime readiness、CLI/server status composition。**类型组合**：managed/on-demand/none、match/drift、配置关闭、旧实例、running/stopped/stale、ready/recovering/degraded/stopping/failed、manager permission/unavailable及读取中换代。**消费者**：同一个 public mapper、CLI human 输出和 server DTO。**异常终态**：入口分叉、混合代际或伪 ready/not-needed；公开面仍不得泄漏路径、service/device/role/raw error。**测试/审查项**：有限组合表与 CLI/server exact DTO；IR36-25～IR36-26、IR36-30、IR36-32、IR36-34～IR36-35。 | 抽取唯一无副作用 `ManagedHostStatusSnapshot` builder：从同一 current load 派生 plan/spec，读取真实 inspect 与现有 process/readiness，结束前复验 plan/spec identity，漂移则有界重读或返回非 ready，绝不拼混；CLI/server 只把该 snapshot 交给同一 mapper，server 删除硬编码事实。mapper 仅在 desired none/on-demand 且没有不应存在的 managed instance/关闭中进程时返回 not-needed，`matches=false` 与 U36-10 不可判定错误映射有限稳定 action。验收为两入口 exact keys/value 全等，覆盖关闭/漂移/旧实例/manager/readiness/换代且零新持久状态、零 raw 信息。 | 已验证 |
| U36-10 | **P0/小，同根重开（来源 P36-03、C36-C30）。** 原 U36-10 已闭合 start 对既有有限 classifier 的旁路；真实中文 Windows 进一步证明所有 `schtasks` 调用的本地化 stderr 被 UTF-8 解码为乱码，首次 inspect 无法识别 documented not-found，因而在 `/Create` 前稳定失败。`schtasks /HRESULT` 提供不依赖消息语言的数值退出码 `0x80070002/0x80070005`。**价值裁决记录**：原 P2/小只覆盖 start 行动；C36-C30 满足“分类错误使受支持启动路径不可恢复”的正式重开条件，当前损失升级为 Windows 首次安装阻断，故改写为 P0/小。最小方案仍只复用现有 classifier，不改 status DTO 或引入平台错误框架；用户体验达标、架构达标。 | 稳定 identity 是 platform domain/serviceId 与单次 manager command result；Windows classifier 依赖错误文本而 runner 固定按 UTF-8 解码本地代码页，导致同一 OS 错误事实在非英文 locale 下不可判定。 | **生产端**：Windows query/create/change/end/run 全命令及三平台既有 start/inspect 分类。**直接变体**：HRESULT not-found/permission、manager/session unavailable、其他非零、spawn、效果/响应丢失与 post-inspect。**消费者/终态**：只有 `0x80070002` 授权 absent，`0x80070005`→permission-required，其余不可判定→manager-unavailable；start documented not-found 仍为 command-failed；raw stderr 不外泄。失败不写 definition、不改 snapshot/DTO，效果丢响应由后继 inspect 收敛。**测试/审查项**：IR36-07、IR36-11、IR36-30、IR36-33；C36-C04/C36-C30、F36-22～F36-23。 | 所有 Windows Task Scheduler command 只经现有窄 helper追加 `/HRESULT`，classifier 优先按 unsigned numeric HRESULT 判 `0x80070002/0x80070005`，保留既有三平台文本/exit fallback；start 仍复用 `requireCommand()` 并独立 post-inspect。验收覆盖乱码 stderr、两 HRESULT、其他非零/spawn、首次 install、各效果窗口，证明只有确定 not-found 授权 absent且零额外副作用。**实施证据**：production runner 已取得数值 HRESULT，真实首次 adapter inspect→create→query 通过，相关四条 Windows 直接测试通过。 | 已验证 |
| U36-11 | **P1/小。** `ManagedServiceSpec` 已持有稳定 `osUser`，`serviceId` 也绑定该值，但 Windows canonical definition 只输出 `<LogonType>InteractiveToken</LogonType>`，principal 与当前用户 `LogonTrigger` 均缺 `<UserId>`，Action 仅按 principal id 间接引用一个未绑定用户的上下文；Task Scheduler 的 principal 合同要求 `UserId` 与 `LogonType` 共同确定运行身份，trigger 的 `UserId` 才把登录唤醒限定到同一用户。**价值裁决记录**：原结论为 P0/小；官方合同足以证明当前 definition 没有完整绑定稳定用户，但缺少真实 `/Create` 证据证明所有受支持 Windows 环境必然失败，P0 举证不足。新决定为 P1/小、降级；保持现状会留下明确的注册或错误 principal 风险，复用现有 renderer 是最小完整修复，用户体验达标、架构达标。重开 P0 条件：真实 Task Scheduler 注册/read-back 证明主路径必然失败或落到错误 principal。 | `ManagedServiceSpec.osUser`→canonical definition bytes 的唯一投影遗漏 principal/trigger 用户字段，使 service identity、Task Scheduler principal、登录 trigger 与 Action context 没有共享同一稳定 OS 用户身份。 | **生产端**：`buildManagedServiceSpec()`、Windows renderer、durable writer、definition digest、`schtasks /Create` 与 inspect/read-back。**类型组合**：普通及 XML 需转义用户名，principal/trigger 同值或错值/缺值，首次与 exact replay，`/Create` 效果/响应丢失、系统规范化回读与重启。**消费者**：reconciler、managed current anchor/executor 的当前用户登录拉起。**异常终态**：任务注册被拒、任意用户登录触发，或不能证明 Action 以冻结用户运行；macOS/Linux 不受影响。**测试/审查项**：IR36-05、IR36-07、IR36-11、IR36-28、IR36-30、IR36-32～IR36-35。 | 仅改现有 Windows renderer：对同一 `spec.osUser` XML-escape 一次，分别写入 `Principal/UserId` 与 `LogonTrigger/UserId`，`Actions Context` 继续引用该 Principal；definition identity、writer、比较和 `/Create` 只消费同一 canonical UTF-16LE+BOM bytes。直接测试从最终 bytes strict parse 后断言 principal/trigger/UserId、LogonType 与 Action context 全等，覆盖转义、首次、exact replay、效果/响应丢失和错误/缺失 UserId；真实 Windows adapter 注册后按系统语义回读同一 principal/trigger 即完成，不新增 renderer、账户解析或平台框架。**实施证据**：renderer 已把同一 `spec.osUser` 写入两处 `UserId`；最终 bytes 转义/系统 XML parse 与 production adapter 真注册、COM read-back 均通过。 | 已验证 |
| U36-12 | **P1/小。** 配置已耐久提交后，`config-command.ts` 先等待 active turn，再在同一 `try` 中 `await requestHostReload()`，随后才在 `launchSelectionChanged` 时触发 `local-role-config-committed` reconcile；reload 在发送前失败或效果后丢响应都会直接进入 catch，因此独立的 supervisor 收敛义务未执行。**价值裁决记录**：原结论为 P1/小；对立复核排除了保持现状和修正规则，因为 reload 失败不保证旧实例退出或新 preflight 必然发生，新增框架又无比例性。新决定为保留 P1/小；复用现有 reconcile 并修正控制流即可同时满足用户体验和架构。删除条件：生产 reload API 获得“失败也保证旧实例退出且新 preflight 必然 reconcile”的原子合同。 | 配置提交后的“重载当前 host”与“按最新 launch selection 收敛 supervisor”是两个有序但独立终结的义务，实现却用前者成功作为后者的控制流前置条件。 | **生产端**：本机角色/executor 自动上线配置耐久提交、active-turn 边界、host reload 与 `local-role-config-committed` reconcile。**类型组合**：选择未变/变化；reload 发送前失败、效果后丢响应、成功；reconcile 成功/失败及四种组合；连续重启。**消费者**：current host、supervisor、role gate、executor 自动上线/下线与配置反馈。**异常终态**：耐久配置已变但旧实例/supervisor 按旧选择运行，或任一失败被另一结果遮蔽，直到不确定的后继 trigger。**测试/审查项**：IR36-04、IR36-12、IR36-20、IR36-24、IR36-30、IR36-32、IR36-34～IR36-35。 | 保留“配置已落盘→等待 active turn→reload→reconcile”的次序，在本命令内抽取窄的提交后效果收束点：独立捕获 reload outcome；仅当 launch selection 变化时，无论 reload outcome 如何都恰好调用一次现有 reconcile；再统一投影两项 outcome，任一失败不得输出“已重启”成功，选择未变不得触发 reconcile。通过可注入的两生产调用直接测试 reload 三窗口×reconcile 成败、active-turn 顺序与连续调用；不新增触发、耐久状态或 lifecycle 框架即完成。**实施证据**：提交后窄收束点已按 reload→reconcile 顺序分别捕获 outcome；selection 变化时四种成功/失败组合均执行一次 reconcile，selection 未变零 reconcile，7 条直接测试、S7 顺序门禁与同指纹四路对抗通过。 | 已验证 |
| U36-13 | **P1/中。** `loadCurrentManagedServiceState()` 同时承担 status inspect 与启动/reconcile activation：它先冻结 binding，再用当前进程形态创建 store 并调用 `unlockState()`；fresh empty home 的 foreground status 会经 `loadOrCreate()` 写 backing key/binding，legacy store existing-only 成功回填 binding 后局部快照仍是 `undefined`，managed expected-backend 又会在允许的回填前拒绝。**价值裁决记录**：原结论为 P1/中；“status 创建文件”单独只支持 P2，但同根还使受支持 legacy 用户首次登录/开机恢复稳定失败，因此 P1 必要。保持现状或只改文案无法恢复首启，复用 existing-only 与同次重读是最小完整修复，无需第二 SecretStore 框架。新决定为保留 P1/中，用户体验达标、架构达标。降级/删除条件：legacy 无 binding 明确退出支持范围，且 status 被明确改为允许副作用的产品命令。 | 一个 loader 混合了只读 inspect/projection 与可创建、可回填的 activation intent；binding 是唯一耐久事实却在 activation 改变后未重读，导致 spec/trust/admission 使用跨代快照。 | **生产端**：current-state loader、`BoundPlatformMasterKeyProvider`、foreground/managed SecretStore、legacy binding 回填与纯 launch-plan projection。**类型组合**：fresh/legacy/bound；四 backend 的 binding/backing/vault 有无、锁定与歧义；managed/foreground、expected backend、回填前后、效果/响应丢失和重启。**消费者 exact-set**：inspect 仅 `buildManagedHostStatusSnapshot()`（CLI/server 同源）；activation 为 reconcile、managed preflight/wait、admission capture/verify 与 trust transition。**异常终态**：状态查询暗中初始化秘密；legacy 首次 managed 启动在同次得不到 spec；公开状态与准入混用不同 binding generation。**测试/审查项**：IR36-06、IR36-17、IR36-25～IR36-26、IR36-28、IR36-30、IR36-32～IR36-35。 | 给现有 loader 增加必填 `inspect|activate` 意图并共用一个只接受最终 `{config,binding,key,trust}` 的纯 projection。status snapshot 固定用 inspect：无 binding 不打开 store并稳定返回既有 credentials 行动，有 binding 只 existing-only，缺 backing/歧义均零写。其余 exact-set 固定用 activate：既有错误 binding 先拒；无 binding 时仅复用现有 legacy/首次-foreground 许可，managed fresh empty 仍零写；unlock 成功后重读 binding、再校验 expected backend并同次构造 spec/trust/admission。真实临时 home 覆盖 fresh inspect 零文件、四 backend bound existing-only、legacy inspect 零回填、managed/foreground activation 回填与响应丢失、错误 backend和重启；不新增第二事实源、SecretStore API/lifecycle 或状态 DTO。**实施证据**：loader 已强制区分 `inspect|activate`，status 唯一走 inspect，其余 reconcile/preflight/admission/trust exact-set 走 activate；真实临时 home 证明 fresh inspect 零 SecretStore 写、legacy 只在 activation 同次回填并重投影、错误 backend 零改写，10 条直接测试、25/25 消费闭包、S7 exact-set 与同指纹四路对抗通过。 | 已验证 |
| U36-14 | **P1/小，同根重开（来源 P36-07；原 locale/numeric state/current SID/typed exact-set 已验证）。** 冻结安装身份是 `ManagedServiceSpec + definitionPath` 原始 bytes及 COM 回读的 task name/path、principal、typed trigger/action、command/arguments 与除 enabled 外的 restart settings；`RegisteredTask.Enabled` 与 `TaskDefinition.Settings.Enabled` 是同一任务的可变 future-enabled 投影。当前 `inspectManager()` 同时读取两者，`windowsTaskDefinitionMatches()` 却固定要求后者为 true；同一 adapter 的 `/Change /DISABLE` 会把二者置 false，本机只读抽样的 5 个 disabled task也均回读 `Definition.Settings.Enabled=false`，而测试伪造 `enabled=false/settings.enabled=true`。future-disable 的生效点是 `/Change /DISABLE` 后二者一致为 false，re-enable 的生效点是 `/Create /F` 后二者一致为 true；任一效果都只由后继 COM read-back 确认。**价值裁决记录**：原独立结论为 P1/小；首次安装仍可用，故不升级 P0，但保持现状会破坏受支持的关闭后再启用，删除 re-enable 或放宽全部 matcher 又分别牺牲体验/身份安全。新决定保持 P1/小并同根重开 U36-14；仅当 Windows 支持范围移除，或动态 enabled 已与 immutable identity 分离且真实 disabled replay/re-enable 通过时关闭。用户体验达标：关闭、状态显示和再次启用均诚实；架构达标：一份 strict COM projection 内明确分离动态状态与冻结身份。 | strict decoder 虽已闭合 locale、numeric state、current identity 与 typed collection，matcher 仍把 supervisor 命令可改变的 enabled 位当成“是否属于本安装”的不可变谓词；测试没有维持真实系统的 `Task.Enabled === Settings.Enabled` 不变量，因而掩盖动态/immutable 分层错误。 | **生产端**：Windows COM inspection decoder/projector、definition matcher、`disableFuture()` 与 `install()`/`start()`。**类型组合**：true/true、false/false、两种冲突组合、future-disable 与 `/Create /F` 各效果/响应窗口、none/on-demand→managed、其余 immutable field drift、running while disabled 与连续重启。**消费者**：adapter、六入口 reconciler、managed preflight、status snapshot、CLI/server mapper。**零副作用/终态**：enabled 两字段冲突必须 `read-back-failed` 且零 manager/write 效果；false/false 仍 `matches=true,state=disabled`，disable exact replay不重发，install 可重启用；其余 identity drift 仍 `matches=false`。**测试/审查项**：IR36-04～IR36-05、IR36-07、IR36-11、IR36-24～IR36-25、IR36-30、IR36-32～IR36-35。 | 保留现有 fixed COM query与 strict DTO，在 `inspectManager()` 的单一动态状态投影点要求 `projection.enabled === projection.settings.enabled`，冲突抛 `read-back-failed`，一致值唯一派生 `state`；从 `windowsTaskDefinitionMatches()` 删除 enabled 常量，其他 frozen exact-set 一字不放宽。直接测试用生产形态 payload 覆盖 true/true、false/false、冲突 fail-closed、disable 效果丢响应、disabled→install/re-enable、running+disabled、immutable drift 与 CLI/server 状态；现有 S7 只增加“dynamic enabled 不得进入 immutable matcher”的有限负门禁。完成判据是同一 canonical task 在 enabled 换代中始终保持身份，错/歧义投影零副作用。**实施证据**：唯一 COM projector 先比较两个 enabled 位，冲突抛 `read-back-failed`；matcher 仅移除动态 enabled 常量，其他 strict exact-set 不变。false/false、两种冲突、disable 效果丢响应 exact replay 与 `/Create /F` re-enable 直接测试 20/20 通过，S7 mutation 可拒绝重新混入动态状态。 | 已验证 |
| U36-15 | **P1/中，同根重开（来源 P36-08；EX36-04 保持已重开）。** durable current plan/spec 只授权 future-enabled，current-running 的安全终止只由两类既有 exact 事实授权：运行 host 已完成 refuse-new→accepted-work drain→shutdown，或 `CoreHostConnection` 持有 stale endpoint tuple/`expectedLock` 并完成 exact turnover。六类 trigger 只是 wake provenance。当前 `reconcileCurrent()` 有三处越权 full-stop：plan resolution catch 中除 config 外调用 `disable()`、安装后 latest plan 非 managed/spec drift 调用 `disable()`、最终 non-managed 分支中除 config 外调用 `disable()`；它们只反绑 serviceId，不消费 endpoint/lock/drain，同 home worker 还只保留首个 caller 的 trigger，跨进程更无共享 map。**价值裁决记录**：原独立结论为 P1/中；反向裁决排除降级：六 trigger 与三处分支均可达，`/End`/`bootout`/`disable --now` 不证明 accepted work 已安全完成，可截断当前核心任务。保持现状、只改 trigger 名或移入 Unit37 均不成立；新决定保持 P1/中并同根重开 U36-15。仅当 reconciler 在类型与运行时均不能产生无 exact 安全事实的 current-stop，或产品删除运行中角色/选择换代时关闭。用户体验达标：后台竞争不截断已接受工作；架构达标：trigger 只唤醒，事实才授权效果。 | 上轮只修复配置提交主链的偏序，没有把 reconciler 全入口纳入同一权限边界；其 adapter 依赖仍暴露 full `disable()`，再以 trigger 字符串选择破坏性效果，使多执行点合同分叉并绕过 exact endpoint 生命周期。 | **生产端/唯一事实**：六类 reconcile trigger（pairing issuer/joiner、local config、current trust、managed preflight、host missing）、上述三处分支、canonical-home dirty-loop 与三平台 adapter；future state由 plan/spec + adapter read-back确认，current-stop只认 host graceful receipt或 stale endpoint/`expectedLock`。**类型组合**：plan load成功/失败、安装后 drift，单/异 trigger、同 home/跨进程，remote/channel/scheduler/delivery 四类 accepted work，future-enabled/current-running四组合，old/new endpoint，效果/响应丢失与连续重驱。**零副作用/终态**：non-managed或不可判定 plan只 future-disable并read-back；没有 exact stop事实时保持 disabled+running/stopping且后继 wake 可重驱，不得按 serviceId终止；managed install/start不变。**测试/审查项**：IR36-04、IR36-12～IR36-14、IR36-16、IR36-20～IR36-21、IR36-28～IR36-32、IR36-34～IR36-35。 | 给 reconciler 注入不含 `disable()` 的窄 adapter view，在类型边界上只暴露 inspect/install/start/`disableFuture()`；三处 non-managed/error/post-install drift 分支统一只收束 future launch，trigger 不再参与效果选择。current stop继续只走既有运行 host graceful路径或 `CoreHostConnection` exact stale endpoint turnover/`expectedLock`，不把安全许可带入 reconciler。参数化直接测试覆盖六 trigger×三处分支、异 trigger/跨进程、四类 accepted work、old/new endpoint与响应丢失；有限S7只冻结六 trigger并禁止 reconciler 出现 full-stop调用，不新增 journal、coordinator、通用 lifecycle或 Unit37能力。完成判据是任一 wake 最多改变 future-enabled，current instance只有既有 exact安全事实才能终结。**实施证据**：reconciler 依赖已收窄为不含 `disable()` 的四方法 view，plan catch、post-install drift 与最终 non-managed 三处均只调用 `disableFuture()`；六 trigger 参数化测试逐一穿过三处分支并保留 running=true，15/15 通过。S7 同时冻结窄类型、三次 future-only 与零 full-stop，现有 graceful/`expectedLock` 路径未改。 | 已验证 |
| U36-16 | **P2/小，来源 P36-06。** `managed-service.test.ts` 的 `platformSpec()` 对 macOS/Linux 使用固定 `/zhixing-unit-36-managed-service/...`，fake runner 用例把 guest-platform definition 语义路径交给当前宿主文件系统；同一测试文件重复运行时，两条“manager 错误前零 definition 写”断言读到旧 Buffer，形成 76/78。反向裁决确认它不造成生产用户失败，不能升级为阻断；但它已使直接验收不可重复并污染宿主，删除断言、手工清根目录或建立新 runner 都不如复用既有 temp fixture。保留 P2/小，用户体验无损、测试架构达标。 | 测试将 guest-platform spec 的语义字段与 fake runner 的宿主物理落点混为一个 `definitionPath`，fixture 未把所有文件副作用绑定本例唯一、可清理的 temp identity。 | **生产端**：无生产变化。**测试端**：macOS/Linux fake-runner 的 absent/install/start/disable/manager-error/definition read-back。**类型组合**：干净/残留宿主路径、两 guest platform、单次/连续/并发运行与真实平台系统用例。**异常终态**：旧 definition 使零写断言失败、宿主根污染并遮蔽 manager 分类回归。**审查项**：IR36-33；F36-43～F36-44。 | 保留 guest-platform 的 definition 内容与命令语义；统一让 fake-runner `platformSpec(platform, tempDir)` 在构造 canonical spec 后，只把 `definitionPath` 覆盖为该例 temp fixture 下的唯一宿主原生路径，所有读写和清理共用该值。只有 `runIf(real platform)` 的真实系统用例保留真实 OS 路径。验收要求同文件连续两次、两 guest platform 并发各自全通过，固定 `/zhixing-unit-36-managed-service` 与工作区零残留；不手工清共享根、不改生产代码、不新增 runner/test framework。**实施证据**：fake-runner `definitionPath` 已逐例绑定 host-native temp fixture，guest command/definition 语义保持；adapter 同文件重复运行仍为 19/19，固定宿主根与工作区无残留。 | 已验证 |

## U36-14～U36-16 根因收敛固定矩阵

> 本节已在冻结产品指纹 `sha256:4bc0b2627feeda6eaa6962eff9ff82c4204130d9e3a7057873e531dbdcc00c51` 上逐格复核；只代表三项专项功能判断，不代表独立审查、全单元终审或单元提交验证。

| 编号 | 稳定身份与唯一事实源 | 变体、线性化点与零副作用终态 | 直接验收与结论 |
| ---- | -------------------- | ---------------------------- | ---------------- |
| F36-37 | Windows `serviceId + current process token SID/name + RegisteredTask` 是唯一系统读身份；human-readable `schtasks` 文本不是事实源 | 英文/非英文系统；numeric 0～4 与越界值；enabled 独立于 current execution。strict DTO 成功解码并反绑同 task 后才形成 inspection | unknown/越界/缺字段 fail-closed；queued 与 running 都为 `running=true`，ready/disabled 为 false；locale 文本不进入判断。U36-14 命中 read projection 根因 |
| F36-38 | `RegisteredTask.Definition` 的 Principal、Triggers、Actions、Settings collection 是唯一 definition 语义投影；冻结 spec 仍是期望身份 | current/wrong/missing principal；current token full name/冻结用户名/SID三种允许的系统精确形式；缺失、重复、额外任意 typed trigger/action；Actions context、Exec、command/arguments/settings drift | principal与trigger UserId均只接受current SID/current full name/spec.osUser的case-insensitive exact-set，`Principal.Id=Actions.Context=CurrentUser`；恰一enabled type=9与恰一type=0，任何额外项均`matches=false`，禁止后缀匹配、翻译或解析任意账户 |
| F36-39 | 固定 PowerShell/COM query 只读，异常中的 numeric HRESULT 复用既有 finite classifier；所有消费者只读同一 `ManagedServiceInspection` | found/not-found/permission/manager unavailable、query 效果/响应丢失、连续重读和重启；install/start/disable/reconcile/preflight/status 共享结果 | 只有 documented not-found→absent；其余异常零状态猜测、零 definition 写；同系统事实 exact replay，写 bytes/UserId 与其他平台不变 |
| F36-40 | 耐久配置是 selection 唯一输入；旧 endpoint 的 PID/port/startTime identity 与 `waitForEndpointTurnover()` 是旧 serving instance 完成事实；send、turnover、reconnect/refresh outcome分别保留 | reload 发送前失败、效果后丢响应、accepted ack、drain 完成、turnover 成功/超时、旧 turnover 后新 endpoint 建立与重启；active-turn 只覆盖本 CLI，不冒充全局 safe point | ack只表示受理；exact turnover只终结旧 endpoint，不能授权按 serviceId 停后继代。效果丢响应但turnover成功可前滚并诚实报send失败；未turnover零current-stop。U36-15命中偏序与代际权限根因 |
| F36-41 | 同一 platform domain/serviceId 的 future-enabled 与 current-running 是两个独立 supervisor 事实；新 endpoint 是独立 generation | desired managed/non-managed；Windows `/DISABLE`、macOS `disable`、Linux `disable`；enabled/running 四组合、各效果/响应窗口、new on-demand/managed endpoint | managed保持future enabled；non-managed在等待old turnover/reconnect前取得future-disabled read-back。旧代只经graceful drain→turnover结束，配置路径不携带`/End`、`bootout`、`stop`跨代许可；未满足时保留诚实失败终态，禁止`--now`或强杀旁路 |
| F36-42 | 既有 role/current-owner/inbound/scheduler admission、accepted work、delivery flush 与 exact old endpoint turnover 共同定义配置换代安全点 | remote conversation、channel accepted message、scheduler run、delivery；空/单/多；drain/turnover 超时、后继同 trigger、new endpoint与连续重启 | drain 先拒新，再收束已接受工作；超时/失败不得触发 shutdown。non-managed future可先禁，old current只由drain/turnover终结；后继重读不得重复future效果，旧完成事实零误停新代，不恢复EX36-04旧排除 |
| F36-43 | guest platform 决定 definition/command 语义；当前测试例 temp directory 决定 fake runner 的宿主物理 `definitionPath` | macOS/Linux、干净/残留固定根、manager found/error、install/start/disable/read-back；生产 spec 不变 | 每个 fake 用例先构造 canonical guest spec，再仅覆盖 host path；零写断言和 read-back 只访问该 temp identity。U36-16 命中 fixture 根因 |
| F36-44 | `createTempDir()` 的每例唯一目录与 fixture cleanup 是唯一宿主文件生命周期 | 同文件连续两次、两个 guest 实例并发、失败中止、真实平台系统用例 | 连续/并发均无交叉可见，固定宿主根与工作区零残留；只有真实平台测试使用真实 OS path，不新增 runner 或 framework |
| F36-45 | 三项与其余 U36/EX36-01～EX36-04/第33～35及第37～38边界 | U36-14↔U36-15 的 running/safe-stop，U36-14↔U36-16 的 production read/fake evidence，U36-15↔U36-16 的双事实测试；历史写入、分类、reload/reconcile 独立义务不重开 | 保持 P1/中、P1/中、P2/小；不新增账户解析、通用系统管理/lifecycle、状态 DTO、runner、诊断、卸载或升级能力 |

### U36-14～U36-16 同根反证账

| 编号 | 主动反例 | 耐久处置 |
| ---- | -------- | -------- |
| C36-C32 | 改为匹配更多语言的 `Running` 文本，仍会遗漏未知 locale 与 numeric queued | 同根合并 U36-14；人类展示完全退出事实链，只 strict decode Task Scheduler numeric state |
| C36-C33 | queued 映射 `running=false` 会让 disable 跳过仍待执行的当前实例 | 同根合并 U36-14；queued 与 running 均保守映射当前执行义务，unknown fail-closed |
| C36-C34 | principal 是 current SID，但额外 BootTrigger 或第二 ExecAction 仍可被“存在目标节点”放过 | 同根合并 U36-14；完整 trigger/action collection type+count exact-set拒绝任意额外项 |
| C36-C35 | 为兼容域账号任意翻译 SID 会新增账户解析能力并可把错误同名账户合法化 | 当前架构证伪；只读取 current token SID/name 与冻结 `spec.osUser`，principal/trigger 均只接受同一 current identity 的有限 exact-set，不解析账户 |
| C36-C36 | `server.shutdown` accepted ack 被当作 safe point，随后 `/End`/`bootout` 仍可截断 accepted work | 同根合并 U36-15；ack 永不授权，drain 完整收束后才允许旧 endpoint turnover；turnover只终结旧 serving instance，不产生 manager-stop permit |
| C36-C37 | reload 失败便跳过整个 reconcile，会保留与耐久 selection 冲突的 future launch | 同根合并 U36-15；future step 无论 reload outcome 都恰一执行，current step 单独受 permit 门禁 |
| C36-C38 | 复用会升级 SIGKILL/taskkill 的通用 stop 作为 blocker completion，会以“已停止”掩盖不安全强杀 | 当前范围证伪；配置链禁止强杀 fallback，只接受 explicit drain 后 exact turnover，超时保持 disabled+running/stopping并报失败 |
| C36-C39 | 测试开始前删除固定 `/zhixing-unit-36-managed-service` 可暂时变绿，但并发仍互删且越权污染宿主 | 同根合并 U36-16；每例唯一 temp host path，从根上隔离而不清共享根 |
| C36-C40 | 为三项引入通用 Task Scheduler wrapper、lifecycle 状态机、公开 status DTO 或新跨平台 runner | 当前价值与边界证伪；现有 runner/reconnect/reconciler/adapter/temp fixture 的窄修正已完整覆盖当前损失 |
| C36-C41 | `reconnect()`确认旧 endpoint turnover 后会按新配置建立后继 endpoint；若把旧 turnover 当作按 serviceId 的 stop permit，managed→on-demand 可误停新代或切断其新 accepted work | 同根合并 U36-15；non-managed future-disable/read-back前移到等待old turnover与`getClientNow()`之前，old current只由drain→turnover终结，旧事实不得跨代调用manager stop |
| C36-C42 | 真实 Task Scheduler COM 会把已注册 Principal.UserId 规范化为当前账户短名，并不总是回读 SID；坚持 principal SID-only 会把 canonical current-user 任务误报 drift | 同根合并 U36-14；principal与trigger共用current SID/current full name/spec.osUser有限exact-set，真实注册/read-back通过；禁止suffix/account resolution，错误身份仍fail-closed |

### U36-14～U36-16 四路冷启动对抗复审

> 基线：同一份仅含本节与三项问题行的未修改记录。各角色抛开前轮评级和方案，从权威合同、当前源码与 F36-37～F36-45 主动重造反例；本轮不运行构建或测试、不修改生产交付物。

| 隔离角色 | 冷启动重造范围 | 独立结论与交界 |
| -------- | -------------- | -------------- |
| Windows numeric state/current SID/typed exact-set | 从 Task Scheduler numeric enum、current process token、完整 COM collections 重造 locale、queued、unknown、wrong/missing SID、任意额外 trigger/action、query error/replay | C36-C32～C36-C35 全部被 strict finite projection闭合；U36-14 根因是唯一读投影缺失而非 renderer/HRESULT 残留，P1/中与方案比例成立；`U36-14↔U36-15` 要求 queued 保守进入 current-stop门禁 |
| 配置换代 accepted-work 与 supervisor 双事实 | 从 durable selection→explicit drain→non-managed future-disable→exact old endpoint turnover→按新plan reconnect 重造四类work、发送/效果丢失、超时、四种OS状态、新endpoint与连续重驱 | C36-C36～C36-C38、C36-C41证明ack、跳过future收敛、强杀和旧事实跨代消费均不可接受；future义务独立终结，old current只由drain/turnover结束，兼顾用户工作、耐久配置与新代安全，EX36-04只在已登记事实上重开，P1/中成立 |
| 跨平台测试路径与重复证据 | 从 guest spec、host filesystem、固定根残留、连续/并发执行及真实平台边界重造零写/read-back证据 | C36-C39 闭合；生产路径零变化，P2/小不升级；`U36-14↔U36-16` 与 `U36-15↔U36-16` 的直接测试必须共用 temp host identity但不能用 fake 自报 production state/safe point |
| 产品体验/范围价值与历史裁决 | 反向对账其余 U36、EX36-01～EX36-04、第33～35既有合同、第37～38排除和 C36-C40，并主动检查旧完成事实能否跨代授权 | C36-C41已并回U36-15且未新增根因；三项方案分别复用现有runner、turnover/reconciler/adapter、temp fixture，达到当前范围最优体验与架构；未恢复写bytes/UserId/HRESULT、reload/reconcile独立义务、通用系统管理/lifecycle、状态DTO、新runner或后继单元能力 |

### U36-14～U36-16 修复后同冻结指纹四路冷启动对抗

> 基线：`sha256:4bc0b2627feeda6eaa6962eff9ff82c4204130d9e3a7057873e531dbdcc00c51`，覆盖 20 个产品/规格/直接测试/S7 文件。四路在产品文件不再修改后重新从当前源码与直接证据推导；修复验证不计独立审查或全单元终审。

| 隔离角色 | 主动重造范围 | 同指纹独立结论 |
| -------- | ------------ | -------------- |
| Windows system read projection | 从 fixed PowerShell/COM strict DTO 重造 numeric unknown/disabled/queued/ready/running、current SID/full name/spec user、wrong/missing identity、extra typed set、HRESULT 与真实系统规范化 | strict decode、numeric state、两处 current-identity exact-set 和 typed collection count 共同 fail-closed；真实 Task Scheduler 回读触发 C36-C42 后以有限 exact-set闭合，未引入账户解析。U36-14 修复后复核通过 |
| accepted-work 与 supervisor 双事实 | 从 config durable commit→explicit drain→future-only disable→exact stale endpoint turnover→successor 重造四类 accepted work、send/ack/效果丢失、超时、四种 enabled/running 组合与新 generation | shutdown 只在 beginDrain/drainAcceptedWork/既有 active+delivery 完成后触发；non-managed future 先禁，旧 endpoint 只由自身 turnover 终结，零按 serviceId 跨代 stop。U36-15 修复后复核通过 |
| guest-platform fixture | 从 canonical guest spec、host-native temp definitionPath、固定根残留、重复/并行 fake runner 与 real-platform system test 边界重造 | fake filesystem identity逐例隔离且不改变 guest command/definition 语义；同文件重复 19/19，固定根与工作区零残留。U36-16 修复后复核通过 |
| 产品体验、范围价值与历史边界 | 反向对账 F36-37～F36-45、C36-C32～C36-C42、其余 U36、EX36-01～EX36-04、第33～35和第37～38边界 | 三项只复用既有 runner/adapter/reconnect/reconciler/server drain/temp fixture；未恢复账户解析、通用系统管理/lifecycle、状态 DTO、新 runner、诊断或后继单元能力。评级与工作量不重开，零新增同根反证 |

## U36-05、U36-14、U36-15 再次同根收敛固定矩阵

> 本节只收敛最新独立审查同根重开的三项事实、直接变体、交界和执行合同；产品交付物未修改，不代表修复验证、独立审查、全单元终审或单元提交验证。

| 编号 | 稳定身份与唯一事实源 | 变体、线性化点与零副作用终态 | 直接验收与结论 |
| ---- | -------------------- | ---------------------------- | ---------------- |
| F36-46 | Windows task 的 immutable identity 是冻结 spec 与 COM definition 中除 enabled 外的 principal/typed trigger/action/command/arguments/restart exact-set；future-enabled 只由同次 `RegisteredTask.Enabled` 与 `Definition.Settings.Enabled` 一致值投影 | true/true、false/false、true/false、false/true、其余 definition drift；strict decode并确认两个 enabled 位一致后才形成 inspection | 冲突组合一律 `read-back-failed` 且零写；false/false 仍 `matches=true,state=disabled`，其余 immutable drift 仍 `matches=false`。U36-14 命中动态状态混入冻结 matcher 的根因 |
| F36-47 | `/Change /DISABLE` 与 `/Create /F` 的后继 COM read-back 是 future-disable/re-enable 唯一效果确认点；同一 canonical definition identity 不随 enabled 改变 | disable/create 各效果前失败、效果后丢响应、exact replay、none/on-demand→managed、running+disabled与连续重启 | disable重放不再因 drift失败，re-enable可达；preflight、六入口reconciler、status与CLI/server只消费同一诚实 inspection，测试 payload维持两个 enabled 位的真实一致性 |
| F36-48 | durable current plan/spec只授权 future-enabled；current-running 的终止授权仅来自运行 host 的 graceful completion或 `CoreHostConnection` exact stale endpoint tuple/`expectedLock` | 六 trigger、plan成功/失败、安装前后 latest plan/spec drift、同/异 trigger、同home/跨进程 | trigger仅唤醒，不能成为current-stop permit；没有exact安全事实时最多得到disabled+running/stopping，零serviceId full-stop。U36-15命中权限边界根因 |
| F36-49 | reconciler依赖边界是current-stop能力的唯一装配门禁；当前三处分支分别为plan catch、post-install drift和final non-managed | 每处分支×六trigger、manager/load/apply与效果/响应丢失、continuous wake | 给reconciler的窄adapter view不暴露`disable()`，三处分支统一`disableFuture()`；managed install/start不变，有限S7禁止full-stop调用，避免逐trigger补丁 |
| F36-50 | accepted work安全终态属于既有host drain/turnover路径；old/new endpoint identity不得由serviceId折叠 | remote/channel/scheduler/delivery空/单/多，future-enabled/current-running四组合，old/new endpoint、turnover超时与后继重驱 | future-disable可幂等重放；current只由自身graceful或exact turnover终结，旧事实零误停新代，Unit37强停/卸载不进入方案 |
| F36-51 | pure-surface poll的稳定身份是client实例、current-owner identity、connection.id、surface principal/generation与`ActivePoll` token；active map中的exact token是唯一代际所有权 | dispatch前后断线、fatal、owner换代、close/dispose、stale completion | 唯一`connection.onClose` callback驱动同代release并abort controller；map不再指向旧token时任何completion零清理新代。U36-05命中双生命周期owner根因 |
| F36-52 | 一次poll request+notification drain是attempt；attempt只借用`ActivePoll.abort.signal`，连接生命周期只由controller拥有 | 单次/海量成功、三个transient mesh code或RPC busy→success、notification drain、无新dispatch的连续poll | 每次helper只添加可在`finally`移除的signal listener；成功开始fresh helper但连接级callback/controller恒为O(1)，既有250ms→30s退避、fatal分类与history补读不变 |
| F36-53 | `fulfillConnectionLifetimeObligation()`仍服务于其他一次性连接调用者，只有pure-surface重复attempt无需第二个`connectionClosed`输入 | helper输入存在/省略、signal已abort、同步close、attempt成功/失败 | `connectionClosed`仅收窄为可选，其他调用点语义不变；surface调用点只传stopSignal，不新增EventEmitter、waiter、通用reconnect或通知协议 |
| F36-54 | 三项与其余U36、EX36-01～EX36-05、第33～35及第37～38边界 | `U36-14↔U36-15` 的disabled/matches与future-only，`U36-15↔U36-05` 的pure-surface零本机current-stop与owner换代，`U36-14↔U36-05` 无共享状态 | 保持U36-14 P1/小、U36-15 P1/中、U36-05 P2/小；不恢复已验证locale/SID/断线恢复/config主链，也不新增通用lifecycle/reconnect、DTO、runner或后继单元能力 |

### U36-05、U36-14、U36-15 再次同根反证账

| 编号 | 主动反例 | 耐久处置 |
| ---- | -------- | -------- |
| C36-C43 | 直接从matcher删除`Settings.Enabled`而不核对两个系统enabled位，可在COM投影自相矛盾时任意选一边并对外发布错误状态 | 同根合并U36-14；先在唯一动态投影点要求两位一致，冲突fail-closed，再把一致值排除出immutable matcher |
| C36-C44 | 保留enabled常量，只在`disableFuture()`内特殊放过false，可让该命令重放通过，但status、preflight与disabled→managed仍把同一任务判drift | 同根合并U36-14；身份/状态分层必须位于共享inspect projector，不做逐消费者例外 |
| C36-C45 | 为兼容系统差异接受true/false或false/true，会建立两个future-enabled事实并使后续命令无法确定真实终态 | 当前安全合同证伪；冲突只能`read-back-failed`且零副作用，不能靠优先级猜测 |
| C36-C46 | 只把final non-managed分支改为future-only，plan catch或post-install drift仍能被任一trigger走到并按serviceId停机 | 同根合并U36-15；三处分支一次收束，且以窄adapter类型边界禁止遗漏新的full-stop分支 |
| C36-C47 | plan不可判定时为“安全”立即full disable，会把未知计划解释成已授权current-stop并截断accepted work | 同根合并U36-15；不可判定只允许future-disable，current保持running/stopping并报告原失败供后继重驱 |
| C36-C48 | 把`expectedLock`或旧turnover结果携入reconciler可允许其安全停机，但会制造可跨trigger/进程/代际传播的第二stop permit | 当前架构证伪；exact stop事实留在既有host/connection生命周期，reconciler类型上不拥有current-stop能力 |
| C36-C49 | 每次成功attempt主动resolve共享`connectionClosed`可释放reaction，但会把正常成功误作连接关闭并停止后继poll | 同根合并U36-05；成功只结束本次attempt，连接关闭由唯一ActivePoll controller决定 |
| C36-C50 | 为每个attempt新建promise/EventEmitter可避免复用旧promise，却仍会引入第二生命周期owner及额外注册/清理竞争 | 当前架构证伪；surface重复调用只借用同一个stopSignal，helper不再订阅连接级promise |
| C36-C51 | 全局删除helper的`connectionClosed`会改变mesh runtime/control-plane一次性连接调用者的关闭语义 | 范围收窄；参数变为可选且只由pure-surface调用点省略，其他调用者保持现状与直接测试 |
| C36-C52 | 借三项修复新增Task Scheduler wrapper、跨进程stop coordinator、通用reconnect/lifecycle或公开资源指标 | 当前价值与边界证伪；现有projector、窄adapter、ActivePoll/helper的局部合同已完整覆盖当前损失 |

### U36-05、U36-14、U36-15 四路冷启动对抗复审

> 基线：同一份完成上述集中修正后未再修改的问题列表。四路均抛开历史修复结论，从权威合同、当前源码与 F36-46～F36-54 主动重造反例；本轮不运行构建或测试、不修改生产交付物。

| 隔离角色 | 冷启动重造范围 | 独立结论与交界 |
| -------- | -------------- | -------------- |
| Windows dynamic/immutable state交界 | 重造true/true、false/false、两种冲突、disable/create效果与响应丢失、running+disabled、immutable drift、连续重启及全部inspection消费者 | C36-C43～C36-C45闭合：一致性在共享projector线性化，enabled不再参与身份，false/false可重放且冲突零副作用；U36-14 P1/小和方案比例成立，`U36-14↔U36-15`要求所有trigger复用同一future状态 |
| reconciler全入口current-stop权限与accepted-work | 重造三处分支×六trigger、同home首caller/异trigger、跨进程、四类accepted work、old/new endpoint、四种supervisor组合及效果丢失 | C36-C46～C36-C48闭合：窄adapter使任一wake最多future-disable，current只认既有graceful或exact turnover；无需携permit或扩建lifecycle，U36-15 P1/中成立 |
| surface poll/controller资源上界与换代终态 | 重造一次与海量成功、transient/BUSY→success、fatal、同步close、owner换代、stale completion、notification drain与history补读 | C36-C49～C36-C51闭合：exact ActivePoll controller是唯一连接owner，attempt listener可释放且连接级资源恒O(1)；既有断线恢复不重开，U36-05保持P2/小 |
| 生产体验、范围价值与历史裁决边界 | 反向对账三项交界、其余U36、EX36-01～EX36-05、第33～35合同、第37～38排除及C36-C52 | 三项分别只复用共享projector、reconciler窄能力面与ActivePoll/helper；达到当前范围最优体验和架构，未恢复已验证主张、通用框架或后继能力，同一未修改列表四路通过 |

### U36-05、U36-14、U36-15 修复后专项事实链

> 基线：13 个非工作台产品文件冻结为 `sha256:85711ea794479640654928c85f6bf2dd6bf8fcaf1b7cdd1d0438aac75b08044d`。本节只记录修复验证与只读专项判断，不计独立审查或全单元终审。

| 固定矩阵 | 同指纹事实链 | 直接证据与结论 |
| -------- | ------------ | -------------- |
| F36-46～F36-47 | Windows strict COM projector 先要求两个 enabled 位一致，再以一致值派生动态 state；immutable matcher 不再消费 enabled，其他 principal/typed trigger/action/command/arguments/restart exact-set 不变 | `managed-service.test.ts` 20/20：false/false 保持 `matches=true`，两种冲突 fail-closed，disable 效果丢响应可 exact replay，随后 `/Create /F` 可重启用；S7 mutation 拒绝一致性缺失或 enabled 回流 matcher。U36-14 通过 |
| F36-48～F36-50 | reconciler 的输入类型只暴露 inspect/install/start/disableFuture，三类 non-managed/error/drift 分支与六类 trigger 均无 full-stop 能力；current stop 仍只存在于未修改的 graceful host 与 exact stale endpoint/`expectedLock` 链 | `managed-service-reconciler.test.ts` 15/15，六 trigger 逐一穿过三处分支只得到 future-disabled 且 running 保留；源码/S7 均为 3 次 future-only、0 次 full-stop。U36-15 通过 |
| F36-51～F36-53 | `ActivePoll` exact abort controller 与唯一 onClose callback 是连接生命周期事实；poll attempt 只借 stop signal，helper 的可选 connectionClosed 仅由其他一次性调用者继续使用 | surface 与 helper 直接测试 12/12：128 次成功始终一个 close callback，每次 stop listener 在 finally 等量移除；transient/BUSY、fatal、close、换代与 stale completion 保持既有终态。U36-05 通过 |
| F36-54 | 三项只改共享 projector、reconciler 窄能力面、ActivePoll/helper、直接测试、三份合同与现有 S7 | CLI 类型检查只复现既有 8 条 credentials 基线；四文件 47/47、S7 19/19、registry golden、一次 `pnpm cli:build` 与 diff-check 通过；无通用 lifecycle/reconnect/stop coordinator、DTO、runner、通知协议或第37～38能力 |

### U36-05、U36-14、U36-15 修复后同冻结指纹四路冷启动对抗

| 隔离角色 | 主动重造范围 | 同指纹独立结论与反证处置 |
| -------- | ------------ | ------------------------ |
| Windows dynamic/immutable state 交界 | 抛开修复结论重造 true/true、false/false、两种冲突、disable/create 各效果与响应窗口、running+disabled、immutable drift、连续重启及全部 inspection 消费者 | 一致性检查是唯一动态投影线性化点，matcher 删除 enabled 不放宽其他身份；C36-C43～C36-C45 分别以修复后复核通过、同根合并、当前源码证伪关闭，未发现新反证 |
| reconciler 全入口 current-stop 权限与 accepted-work | 重造三处分支×六 trigger、同/异 trigger、同 home/跨进程、四类 accepted work、old/new endpoint、四种 supervisor 组合、效果丢响应与连续重驱 | 窄 adapter 在类型与运行时都没有 current-stop，wake 只收束 future；current 仍只认既有 graceful/exact endpoint 事实。C36-C46～C36-C48 全部修复后复核或当前源码证伪，无误停 accepted work 或新代路径 |
| surface poll/controller 资源上界与换代终态 | 重造单次/海量成功、三个 transient、RPC BUSY、fatal、同步 close、owner 换代、dispose、stale completion、notification drain 与 history 补读 | active controller 是唯一连接 owner，attempt listener 有界释放，其他一次性 helper 调用者保留 connectionClosed。C36-C49～C36-C51 全部修复后复核或范围收窄，连接级 callback/controller 恒 O(1) |
| 生产体验、范围价值与历史边界 | 反向对账 F36-46～F36-54、其余 U36、EX36-01～EX36-05、第33～35既有合同与第37～38排除 | P1/小、P1/中、P2/小仍与当前损失及方案比例一致；C36-C52 被当前 diff 证伪，三项未恢复历史主张或引入范围外能力，同一冻结指纹四路通过 |

## U36-11～U36-13 根因收敛固定矩阵

> 本节只收敛三项正式问题的事实、直接变体、交界和执行合同；交付物未修改，不代表修复验证、全单元终审或单元提交验证。

| 编号 | 稳定身份与唯一事实源 | 变体、线性化点与零副作用终态 | 直接验收与结论 |
| ---- | -------------------- | ---------------------------- | ---------------- |
| F36-25 | `serviceId + canonical UTF-16LE+BOM definition bytes`；OS 用户唯一来自已冻结的 `ManagedServiceSpec.osUser` | 普通/需转义用户名；principal、LogonTrigger、Action context 必须同源；renderer 只投影，不解析或猜测账户 | final bytes strict parse 后两处 `UserId` 全等 `osUser`，Action 只引用该 Principal；缺/错任一字段直接失败。U36-11 根因命中投影缺口，C36-C31 反绑真实系统字节格式 |
| F36-26 | Task Scheduler 对同一 task name 的系统 definition/read-back | 首次、exact replay、`/Create` 效果前失败/效果后丢响应、系统将 principal 变为 SID、trigger 变为域限定账户并补默认字段、重启；OS 生效点为创建后有限语义身份全等 | 本地 canonical bytes exact replay，系统 read-back 逐项反绑冻结 spec并拒绝异 principal/trigger/command；macOS/Linux 零变化，不引入 SID/账户解析能力 |
| F36-27 | 配置文件耐久提交是输入事实；reload outcome 与 `local-role-config-committed` reconcile outcome 是两个独立完成事实 | launch selection 未变只有 reload；变化时先 reload 后 reconcile，reload 成败均不得跳过 reconcile | 生产收束点逐项返回 outcome；四种组合均可判定，任一失败零虚假成功。U36-12 根因命中控制流依赖 |
| F36-28 | active-turn promise 是两项提交后效果的共同准入边界 | active turn 成功/失败均先完成原处理，再开始 reload；发送前失败、效果后丢响应、reconcile 失败和连续调用 | active turn 前零 reload/reconcile；选择变化后每次提交恰一 reconcile，无新耐久 trigger、队列或重试框架 |
| F36-29 | backend binding/backing key/trust 是耐久事实；loader intent 只决定是否获准激活，不成为事实源 | inspect/activate × fresh/legacy/bound × foreground/managed；纯 projection 只消费本次最终快照 | loader 必填 intent；status 唯一使用 inspect，其余生产 exact-set 使用 activate。U36-13 根因命中意图混合与跨代快照 |
| F36-30 | inspect 的最终 binding 只能来自调用开始时的 read-only binding；有 binding 时既有 provider 已保证 existing-only | 四 backend 的 binding/backing/vault 有/缺/锁定/歧义；CLI/server status、重复查询、响应丢失与重启 | 无 binding 不打开 store；有 binding 只读取既有 key。所有失败零 key、binding、vault、trust、definition 写入，CLI/server 仍消费同一 snapshot/mapper |
| F36-31 | activate 的最终 binding 以 unlock 后同次重读为准 | legacy no-binding existing store、回填前/效果后丢响应、首次 foreground、managed fresh empty、expected backend 同/异 | legacy 同次回填并产出全等 spec/trust/admission；fresh foreground只走既有许可，managed fresh和错 backend零写/fail-closed |
| F36-32 | launch spec/trust/admission identity 必须由同一最终 `{config,binding,key,trust}` projection 产生 | binding 回填、backing missing、重启、读取中换代；旧局部 binding 不得进入 `buildManagedServiceSpec()` | 回填后必须重读并重新投影；无法取得单代快照时拒绝，不返回混代 plan/spec |
| F36-33 | U36-11↔U36-12：selection 变化只通过同一 current spec 生成 definition | reload 任一窗口后 reconcile 仍以最新配置和稳定 `osUser` 建同一 Windows bytes | 不出现“新选择+旧 principal”组合；renderer 无配置提交副作用 |
| F36-34 | U36-12↔U36-13：reconcile 是 activation 消费者 | reload 失败、legacy 回填和 reconcile 失败组合；回填写入不代替 reconcile 完成 | 两义务独立可见；activation 同次最终 binding 驱动 supervisor，不依赖未知后继 trigger |
| F36-35 | U36-11↔U36-13：`osUser` 与最终 binding 共同进入纯 spec projection | inspect 不产 definition；activate/已绑定 inspect 产生相同 spec identity | 同输入 definition bytes 全等；SecretStore 意图不改变 OS 用户，Windows renderer 不触碰 SecretStore |
| F36-36 | Unit36 固定范围与既有裁决 | 对账其余 U36、EX36-01～EX36-04、第33～35与第37～38边界 | 保持 P1/小、P1/小、P1/中；不恢复 P0、status-alone P1、三平台 lifecycle 拆分、专用 coordinator、第二 SecretStore 事实源或 DTO 扩面 |

### U36-11～U36-13 同根反证账

| 编号 | 主动反例 | 耐久处置 |
| ---- | -------- | -------- |
| C36-C20 | 只给 Principal 写 `UserId`，LogonTrigger 仍对任意用户触发 | 同根合并 U36-11；两处必须投影同一 `spec.osUser` |
| C36-C21 | 两处 UserId 文本相同但未 XML escape，或 Action 指向另一 Principal | 同根合并 U36-11；final bytes strict parse 与引用全等验收共同拒绝 |
| C36-C22 | `/Create` 已生效但响应丢失后重复注册被误判冲突 | 同根合并 U36-11；同 task name + canonical bytes 的系统 read-back 决定 exact replay |
| C36-C23 | reload 发送前失败使 reconcile 永不执行 | 同根合并 U36-12；独立 outcome 收束点保证 selection 变化时仍执行一次 |
| C36-C24 | reload 成功而 reconcile 失败被“已重启”文案遮蔽，或两者失败只保留一个事实 | 同根合并 U36-12；统一投影两项 outcome，任一失败零虚假成功 |
| C36-C25 | 用 `finally` 无条件 reconcile 导致 selection 未变也触发 supervisor 副作用 | 同根合并 U36-12；reconcile 仍以 `launchSelectionChanged` 为唯一条件 |
| C36-C26 | fresh status 调 `unlockState()` 创建 backing key/binding | 同根合并 U36-13；inspect 无 binding 时不打开 store，零写 |
| C36-C27 | legacy inspect 为“更准确”而回填 binding | 当前范围证伪；status 是只读投影，legacy 回填只属于 activation |
| C36-C28 | managed activation 在 `binding===undefined` 时先做 expected-backend 拒绝，或回填后继续使用旧 binding | 同根合并 U36-13；先按既有许可激活，成功后重读再校验和投影 |
| C36-C29 | 为 inspect 新建第二 SecretStore 探测事实源或公开 status DTO 字段 | 当前架构与价值裁决证伪；复用 binding/provider和既有 error mapper即可闭合 |
| C36-C30 | 中文 Windows 上 production async runner 把 `schtasks` 的本地代码页错误输出按 UTF-8 解码为乱码，documented not-found 因而被分类为 manager-unavailable，真实 adapter 在 `/Create` 前终止 | 直接反证自动重开 U36-10；所有 Task Scheduler 命令统一 `/HRESULT`，classifier 以数值码判 not-found/permission，真实首次 adapter inspect→create→query 通过。修复后复核通过 |
| C36-C31 | 绕过 C36-C30 后，以原 canonical UTF-8 bytes 执行真实 `schtasks /Create /XML`，系统返回 malformed XML；带 BOM UTF-16LE 输入可注册且系统规范化回读 principal/trigger | 直接反证自动重开 U36-01；唯一 Windows bytes 改为 UTF-16LE+BOM并以有限语义 read-back拒绝 drift，真实 production adapter 注册/回读通过。修复后复核通过 |

### U36-11～U36-13 四路冷启动对抗复审

> 基线为当前未修改交付物与上述三行问题记录。四个角色抛开前轮结论，从权威合同和当前生产调用图重新构造 F36-25～F36-36；本节只证明问题记录可执行，不证明实现已修复。

| 隔离角色 | 主动重造的反例与直接交界 | 独立结论与耐久处置 |
| -------- | ------------------------ | -------------------- |
| Windows principal/trigger/action 稳定身份与最终 bytes | 普通/转义用户、缺/错两处 UserId、错误 Action context、首次/exact replay、`/Create` 效果/响应丢失及系统回读；核查 U36-11↔U36-12/U36-13 | 唯一最优解是把同一 `spec.osUser` 投影进两处 UserId并保留 Action 对该 Principal 的引用；C36-C20～C36-C22 同根合并，F36-25/F36-26/F36-33/F36-35 通过，无 SID/账户解析扩面 |
| 配置提交后 reload/reconcile 独立终态 | selection 未变/变化、active-turn、reload 三窗口、reconcile 成败四组合与连续调用；核查 U36-12↔U36-13 | 两义务有序但独立终结，selection 未变零 reconcile；C36-C23～C36-C25 同根合并，F36-27/F36-28/F36-34 通过，无 trigger/lifecycle 框架 |
| current-state inspect/activation 与 legacy 同次恢复 | fresh/legacy/bound、四 backend、binding/backing/vault 有无/歧义、managed/foreground、expected backend、回填窗口、CLI/server status、preflight与重启 | 必填 intent + 最终快照纯 projection 唯一同时满足零写 status 和 legacy 首次恢复；C36-C26/C36-C28 同根合并，C36-C27/C36-C29 当前架构证伪，F36-29～F36-32 通过 |
| 生产证据/产品体验/范围价值及历史裁决 | 反向核对两生产根、调用者 exact-set、其余 U36、EX36-01～EX36-04、第33～35与第37～38边界 | 三项评级/工作量与当前损失相称；直接测试均可由现有 production seam/真实临时 home完成。F36-36 通过，未恢复已降级/删除主张，零新增反证 |

### U36-11～U36-13 修复后同冻结指纹四路冷启动对抗

> 基线：`sha256:ca2748bccba0df9276d96416f2718bb5ed0a878895a7f629f9d244ecf67eeb9e`，覆盖 12 个非工作台产品/规格/测试/S7 文件。以下四路在产品文件不再修改后重新从源码与直接证据推导；C36-C30/C36-C31 按直接反证规则自动重开并闭合 U36-10/U36-01，不进入全单元终审。

| 隔离角色 | 主动重造的反例与直接交界 | 当前事实链、零副作用边界与结论 |
| -------- | ------------------------ | -------------------------------- |
| Windows principal/trigger/Action 与最终 bytes | 普通/转义用户、缺/错两处 UserId、错误 Action context、UTF-8/无 BOM、首次/exact replay、中文 not-found/permission、`/Create` 效果/响应丢失、SID/域账户/default fields 规范化；核查 U36-01↔U36-10↔U36-11 | renderer 只从 `spec.osUser` 生成两处 UserId和同一 Action context；唯一 bytes 为 UTF-16LE+BOM且声明 UTF-16，所有 Task Scheduler 命令只经 `/HRESULT` helper。真实 production adapter 完成 absent→create→query，系统 COM 回读证明 principal/trigger 为同一当前用户；有限 matcher 反绑 command/arguments/restart，错误语义不判 matches。相关 4/4 直接用例与 S7 bytes/HRESULT/UserId mutation 通过；C36-C20～C36-C22、C36-C30～C36-C31 修复后复核通过，未新增 SID/账户解析能力。 |
| 配置提交后 reload/reconcile 独立终态 | selection 未变/变化、active-turn、reload 发送前失败/效果后丢响应/成功、reconcile 成功/失败四组合、连续调用；核查 U36-12↔U36-13 | 配置落盘是输入事实，active-turn 后先捕获 reload，再仅对 changed selection 恰一捕获现有 reconcile；两 outcome 都保留，任一失败只给可行动 warning，selection 未变零 reconcile。7/7 直接测试与 S7 顺序/exact-set 通过；C36-C23～C36-C25 修复后复核通过，无 journal、trigger 或 lifecycle 扩面。 |
| current-state inspect/activate 与 SecretStore 单代投影 | fresh/legacy/bound、四 backend binding/backing/vault 缺失/歧义、managed/foreground、expected backend、回填前后、CLI/server status、preflight/admission/trust、响应丢失与重启；核查 U36-12↔U36-13 | loader 强制 intent；inspect 无 binding 在创建 provider 前拒绝，有 binding 只复用 existing-only。activate 按既有许可 unlock，随后重读并两次复验 binding，再由纯 projector一次构造 spec/trust/admission；错 backend/混代均零结果。10/10 intent 测试、既有四 backend 19/19 与 consumer closure 25/25 通过；C36-C26/C36-C28 修复后复核，C36-C27/C36-C29 当前源码证伪。 |
| 生产证据、产品体验、范围价值与历史边界 | 反向对账 F36-25～F36-36、其余 U36、EX36-01～EX36-04、第33～35和第37～38；重造 account framework、第二 SecretStore、状态 DTO、通用 lifecycle/runner 扩面诱因 | 当前方案只修改既有 renderer/adapter、配置收束点、loader intent及有限 S7 descriptor；真实 Windows证据、S7 19/19+golden、受影响闭包、最终 CLI build与diff-check绑定同一产品指纹。CLI typecheck仅复现8个既有credentials `version`基线错误，未命中本轮文件；diagnostic整文件16/18中的darwin/linux固定物理路径隔离失败在本轮前已存在且不触及受影响断言。三项评级/工作量不重开，EX36-01～EX36-04与第37～38边界不变，零新增同根反证。 |

### C36-C20～C36-C31 差异审计

| 编号范围 | 历轮反证 | 唯一关闭方式 |
| -------- | -------- | ------------ |
| C36-C20～C36-C22 | Windows UserId/Action/exact replay 及系统规范化 | 修复后复核通过：同源 renderer、UTF-16LE真实注册、有限语义read-back与S7共同拒绝漂移 |
| C36-C23～C36-C25 | reload失败跳过reconcile、失败事实遮蔽、selection未变误触发 | 修复后复核通过：两 outcome 有序独立捕获，7/7直接测试覆盖全部组合 |
| C36-C26、C36-C28 | fresh status写秘密、activation回填后继续使用旧binding | 修复后复核通过：inspect零创建，activate同次重读并单代投影 |
| C36-C27、C36-C29 | legacy inspect回填、第二SecretStore/状态DTO扩面 | 当前源码证伪：status只读且全部生产消费者复用既有binding/provider与mapper |
| C36-C30 | 本地化stderr乱码使Windows not-found不可分类 | 修复后复核通过：统一`/HRESULT`并按无符号数值码分类，真实production首次安装通过 |
| C36-C31 | UTF-8 definition被真实Task Scheduler拒绝 | 修复后复核通过：唯一BOM+UTF-16LE字节合同、真实注册和系统身份回读通过 |

## U36-04/U36-05/U36-10 同根重开固定矩阵

> 本矩阵约束三项同根修复的固定执行合同；当前实现、直接证据与同指纹对抗均以相同编号完成，不改变其余 U36、EX36-01～EX36-03 或第 37～38 单元边界。

| 编号 | 直接变体 | 稳定 identity 与唯一事实 | 线性化点与零副作用边界 | 消费终态与直接验收 |
| ---- | -------- | ------------------------ | -------------------------- | -------------------- |
| F36-16 | U36-04 首轮成功/失败与单个后继 wake | canonical home；map 中 exact worker/promise | 成功由 dirty-loop 清空 dirty 后退出；加入旧 worker 的 caller 只在共享 rejection 后拥有一次 retry budget | 原 owner 返回原结果；加入者以 current input 启动至多一个 successor；load/manager/apply 三类失败均直测 |
| F36-17 | U36-04 多 joiner、持续失败、同/异 home | 同 home 共用 map 槽，异 home identity 独立 | 多 fallback 在旧槽删除后仍经同一 map 合并；budget=0 的 successor 失败即终止 | 同 home 恰一 successor、无递归热循环；异 home 可并行；持续失败全部诚实可见 |
| F36-18 | U36-04 外部效果/响应丢失与连续重启 | current loader/adapter 的真实 supervisor 状态 | successor 不保存第二状态，重读 current plan/spec 与 inspect 后幂等收敛 | 零并发第二实例/秘密副作用；重启清空进程内 map，下一既有 trigger 正常新建 worker；gate/listener 不放宽 |
| F36-19 | U36-05 dispatch 前后断线、无新 dispatch 重连 | surface principal + connectionId + surfaceGeneration + current owner；active exact controller token | 单次 poll 用 `fulfillConnectionLifetimeObligation()` 重试，动态 registry 重连后同 token 继续；成功响应开启 fresh helper并重置退避 | `connection-closed`/`service-unavailable`/`request-timeout`/`RpcAppError(BUSY)` 按既有 250ms→30s 上界重试，target 未 drain 队列在无新 dispatch 下交付，始终单 poll |
| F36-20 | U36-05 连续 transient、fatal、close/dispose、owner 换代 | map 当前值与 controller token 的对象全等；helper 只承载既有 connection-lifetime 退避 | 自身 abort 正常退出；fatal 或生命周期终止只在同 token 时清 slot/hook，stale completion 零写 | 既有 capped backoff 无热循环；协议/认证及其他非 transient 错误上报且不重试；旧 owner 不回退、不删除新 owner poll |
| F36-21 | U36-05 notification 耐久边界 | live poll queue 与 committed final/status 的 last-seen revision/history 是既有两个合同 | 本修复只恢复 active poll liveness，不把 poll response 变成 durable ack/outbox | 响应已丢的 committed final/status由既有历史补读；不承诺 live hint 的新一次性交付语义，不新增通用重连/同步能力 |
| F36-22 | U36-10 三平台 start exit/spawn 分类 | platform domain/serviceId + start command result；`requireCommand()` 是唯一 classifier | runner 完成后先分类；只有成功结果进入独立 post-inspect | permission→permission-required；manager/session/未知→manager-unavailable；documented not-found→command-failed；raw error 不外泄 |
| F36-23 | U36-10 start 效果/响应丢失与 post-inspect | 同 serviceId 的真实 running inspect | 成功命令后以独立 inspect 线性化启动完成；失败不授权 absent、不写 definition | post-inspect 未 running→read-back-failed；效果已发生但响应失败时下一 reconcile 读到 running，不重复启动；snapshot/DTO 不变 |
| F36-24 | 三项与历史/后续边界 | 其余 U36 已验证事实、EX36-01～EX36-03 及第 33～35 合同 | 三项只修改各自现有 map/client/adapter，不改变 S7 runner、准入、routing exact-set 或 status source | 不新增 coordinator、generation/waiter、通用 reconnect/lifecycle、状态 DTO、诊断或 Unit 37～38 能力 |

> 阶段证据（2026-08-11）：U36-04 生产 reconciler 已将原 owner 与 joiner 分流，只有 joiner 在共享 rejection 后携带一次性 budget 进入同一 canonical-home map；load/manager/apply、多 joiner、持续失败、异 home 及效果已发生但响应丢失的 11 个直接测试通过。U36-05 active slot 已绑定 exact controller token并复用既有 connection-lifetime helper；真实动态 registry/relay queue、三个 mesh transient、BUSY、fatal 与再次建 poll 的 8 个直接测试通过。U36-10 `start()` 已统一复用 `requireCommand()` 并保留独立 post-inspect；三平台 permission/manager/not-found/未知非零/两类 spawn 与 read-back 的 17 个直接测试通过。直接交界 `surface-core-host-link` 与 connection-lifetime helper 4/4 通过；三项生产文件窄类型检查通过，CLI 全量类型检查只报告既有、与本轮无关的 credentials `version` 基线错误；S7 19/19 与 registry golden 通过；`pnpm cli:build` 成功且同输入未重复构建。状态：三项实现、最小必要验证和冻结前派生资产已完成。

### 同根反证账

| 编号 | 主动反证 | 裁决与耐久处置 | 状态 |
| ---- | -------- | -------------- | ---- |
| C36-C13 | 让所有 caller 在共享失败后再次调用公开 reconciler，会使加入 successor 的 caller 继续递归 fallback，持续故障下无上界 | 一次性 budget 只授予加入旧 promise 的 caller，原 owner 和 budget=0 successor 均不再重试；11/11 直接用例证明多 joiner 恰一 successor且持续失败有界 | 修复后复核通过 |
| C36-C14 | 为 U36-04 新增 worker generation/waiter 可记录每个 caller，但生产没有独立取消语义，且损失仅一次延迟 | 当前源码只保留 canonical-home map、single worker 与私有布尔 budget，没有 generation/waiter/API；同 home 单飞和用户可见失败由直接用例闭合 | 当前源码证伪 |
| C36-C15 | 在 `FirstPartyConversationMeshClient` 另造私有 delay/backoff 会重复已有 connection-lifetime 原语并留下参数分叉 | 当前源码唯一复用 `fulfillConnectionLifetimeObligation()` 的 abort/connection-close 与 250ms→30s backoff，未出现第二 delay/backoff | 当前源码证伪 |
| C36-C16 | 对所有 Mesh/RPC 错误重试会把认证、协议、签名和资源错误变成永久热循环 | 三个 transient mesh code 与 RPC BUSY 是唯一重试集合，其余 fatal；8/8 直接用例证明无热循环且 fatal 可新建同 surface controller | 修复后复核通过 |
| C36-C17 | 为 poll response loss 新增 sequence/ack/outbox 可提供更强通知语义 | 当前实现与规格只恢复 live poll liveness；未新增 sequence/ack/outbox，committed final/status 继续走 last-seen revision/history | 当前源码证伪 |
| C36-C18 | U36-10 直接调用 `throwManagerFailure()` 看似复用 classifier，但默认会把 documented not-found 归为 manager-unavailable | 当前 `start()` 只调用完整 `requireCommand()`；17/17 直接用例证明 documented not-found 保持 command-failed，未旁路 classifier | 当前源码证伪 |
| C36-C19 | 将 start 错误并入 status snapshot 或用 not-found 授权安装会恢复已否定的 DTO/inspect 主张 | 当前 diff 未修改 status snapshot/DTO/mapper；start 失败不授权 absent、不写 definition，后继真实 inspect 单独收敛 | 当前源码证伪 |

### 四路冷启动对抗复审

> 复审基线为上列三项问题、F36-16～F36-24 与 C36-C13～C36-C19 的同一份未修改记录；仅重建事实与范围，不执行实现、构建或测试。

| 隔离角色 | 主动重造的反例与交界 | 独立结论 | 耐久处置 |
| -------- | -------------------- | -------- | -------- |
| dirty-loop 失败 successor / canonical-home 单飞 | 从六 trigger 反向注入 load、manager、apply 首轮失败，多 joiner、异 home、持续失败、效果丢响应与重启；核查 U36-04↔U36-10 及 listener/gate | 根因是 joiner 的一次 successor 语义而非 worker 代际；一次 retry budget 可覆盖全部当前变体且有严格上界 | F36-16～F36-18 通过；C36-C13 修复后复核通过，C36-C14 当前源码证伪 |
| surface poll controller / 断线换代 | 从真实 active slot、动态 registry、relay queue 构造 dispatch 前后断线、无新 dispatch 恢复、BUSY、连续 transient、fatal、close/dispose 与 owner 换代；核查 U36-04↔U36-05 | exact controller token + 既有 connection-lifetime helper 的单次 poll 适配是唯一必要修复；stale completion 同代 guard 完整，历史补读边界不要求新 ack/outbox | F36-19～F36-21 通过；C36-C15/C36-C17 当前源码证伪，C36-C16 修复后复核通过 |
| supervisor start 分类 / inspect-status 边界 | 逐平台重造 permission、manager/session unavailable、not-found、其他非零、spawn、效果丢响应和 post-inspect；核查 U36-04↔U36-10、U36-05↔U36-10 | `requireCommand()` 已是完整复用点；直接调用 classifier 会错分 not-found，start 与 snapshot 必须继续隔离 | F36-22～F36-23 通过；C36-C18/C36-C19 当前源码证伪 |
| 生产证据 / 产品体验 / 历史裁决与范围 | 反向对账 Unit36 可执行合同、其余 U36、EX36-01～EX36-03、第33～35既有合同和第37～38排除 | P1/小、P2/小、P2/小均与当前损失和方案比例相符；无恢复旧 gate/routing/status 主张，无后续单元能力或通用框架 | F36-24 通过；三项影响面、验收和停止条件闭合，零新增反证 |

### 修复后同冻结指纹四路冷启动对抗

> 基线：`sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0`。本轮抛开上表方案结论，只从当前源码、权威合同与真实直接证据重新构造 F36-16～F36-24；交付物全程未修改，未进入全单元终审。

| 隔离角色 | 主动重造的反例与直接交界 | 当前事实链与零副作用边界 | 独立结论与耐久处置 |
| -------- | ------------------------ | ------------------------ | -------------------- |
| dirty-loop 失败 successor / canonical-home 单飞 | load、manager、apply 首轮失败；单/多 joiner；持续失败；同/异 home；外部效果成功但响应丢失；后继 trigger 与进程重启；核查 `U36-04↔U36-10` 及既有 gate/listener | 原 owner 只等待自己创建的 worker；joiner 的私有 budget 仅允许共享 rejection 后一次 `reconcileOrJoin(..., false)`，旧槽释放后所有 fallback 仍经同一 canonical-home map；successor 再失败直接上抛。11/11 直接用例证明同 home 恰一 successor、异 home 独立、read-back 不重复效果；进程内 map 不成为耐久事实 | F36-16～F36-18 全部通过；C36-C13 修复后复核通过，C36-C14 被当前源码证伪；未恢复 generation/waiter、专用 coordinator、gate 或 listener 扩面 |
| surface poll controller / 断线换代恢复 | dispatch 前/后断线；无新 dispatch 重连；三个 transient mesh code、RPC BUSY、连续失败、成功后退避重置；fatal、close/dispose、owner 换代、stale completion、notification queue 与历史补读边界；核查 `U36-04↔U36-05` | `#active` 保存对象全等的私有 controller token；一次 poll request+drain 是一个 connection-lifetime attempt，只有固定四类 transient 重试，成功以 fresh helper 重置退避；fatal/close/换代只在 map 仍指向同 token 时移除。真实动态 registry/认证 channel/relay queue 与 production helper 的 8/8+4/4 证据证明单 poll 恢复；committed final/status 仍由 last-seen revision/history 补读 | F36-19～F36-21 全部通过；C36-C15/C36-C17 当前源码证伪，C36-C16 修复后复核通过；未新增 ack/outbox、公开 generation、通用 reconnect 或通知协议 |
| supervisor start 分类 / inspect-status 边界 | Windows/macOS/Linux 的 permission、manager/session unavailable、documented not-found、其他非零、EACCES/EPERM 与其他 spawn、效果/响应丢失、code=0 后 running/non-running；核查 `U36-04↔U36-10`、`U36-05↔U36-10` | `start()` 只复用 `requireCommand(startCommand(...))`，成功后仍以独立 `inspect()` 线性化；17/17 直接用例证明分类稳定、raw error 隔离、失败零 definition/absent/status 副作用，效果已发生但响应丢失由后继 reconcile 的真实 inspect 收敛 | F36-22～F36-23 全部通过；C36-C18/C36-C19 被当前源码证伪；未修改 snapshot、DTO、mapper 或 install/inspect 已验证分类 |
| 生产证据 / 产品体验 / 历史裁决与范围 | 反向对账 30 文件闭包、三项用户旅程、现有 S7、其余 U36、EX36-01～EX36-03、第33～35既有合同及第37～38排除 | 三项生产类型闭包、40 个直接用例、4 个交界用例、S7 19/19+golden、CLI build 与 diff-check 绑定同一指纹；架构/规格仅冻结有界 successor、finite poll 与 start classifier，不新增第二事实源、runner、诊断、pairing 事务或后继单元能力 | F36-24 通过；评级/工作量与价值裁决不重开，EX36-01～EX36-03 仍排除；该历史专项当轮零新增反证，后续 C36-C20～C36-C29 属 U36-11～U36-13 新问题收敛 |

### C36-C13～C36-C19 差异审计

| 编号 | 历轮主张与本轮差异 | 唯一关闭方式 |
| ---- | ------------------ | ------------ |
| C36-C13 | 递归 fallback 风险由私有一次性 budget 和 11/11 直接用例闭合 | 修复后复核通过 |
| C36-C14 | generation/waiter 扩面在当前源码、范围与用户损失下均无必要 | 当前源码证伪 |
| C36-C15 | 私有退避分叉未出现，生产只复用既有 connection-lifetime helper | 当前源码证伪 |
| C36-C16 | 无界重试风险由有限四类 transient、fatal 终态及 8/8 证据闭合 | 修复后复核通过 |
| C36-C17 | 新 ack/outbox 主张不属于本轮，当前实现继续复用 final/status history | 当前源码证伪 |
| C36-C18 | start 直接 classifier 分叉已删除，统一 `requireCommand()` 并由 17/17 证据反绑 | 当前源码证伪 |
| C36-C19 | status DTO/absent 扩面未发生，start 与只读 snapshot 仍隔离 | 当前源码证伪 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX36-01 | **原主张（U36-07）**：S7 门禁 30/60 秒超时且语义覆盖不足，应按 P1/中修脚本并扩 mutation。**已验证事实**：超时只证明本轮未取得结果，不能证明 runner 不终结；S7 负责生产装配 exact-set，不替代 XML、OS supervisor、并发与状态投影的直接行为测试。 | 已确认的真实缺陷已各自归入 U36-01～U36-06，其验收包含相应直接证据；单独扩张 S7 没有额外当前用户价值，也不形成未来义务。适用边界是现有 S7 仍按项目规定方式可执行，且生产装配漂移能由既有 descriptor 与直接测试拒绝。 | 第 36 单元功能提交 `cb71a3ef`；独立审查清单 IR36-35 与本轮 U36-01～U36-06 根因归并/价值裁决。 | 现有 S7 在项目规定运行方式与上限内被事实证明不能终结；或 U36-01～U36-06 修复后仍有无法由直接测试及既有 descriptor 拒绝的生产装配漂移。 | 已排除 |
| EX36-02 | **原主张（U36-08）**：pairing 成功前持久化自动上线选择，surface-only 也会被询问，应按 P2/小调整事务/体验。**已验证事实**：用户已明确作出选择；失败重试复用本地偏好不会产生授权、role、OS 注册或秘密副作用，`executorAutoStart` 对无 executor role 不生效，且现有配置入口可修改。 | 没有证据证明重复询问改善当前核心体验；强制与 trust 原子化会无价值地扩大 pairing 事务边界。该主张无当前问题且无确定未来交付义务。 | 第 36 单元功能提交 `cb71a3ef`；独立审查对 pairing/config/role/SecretStore 生产链的价值裁决。 | 新生产事实证明残留偏好会在未获 executor 授权时触发注册/运行；或用户无法通过现有入口修改已保存选择。 | 已排除 |
| EX36-03 | **原主张（U36-09）**：Windows/macOS managed stdout/stderr 未显式进入私有应用日志，应按 P2/中补跨平台重定向。**已验证事实**：当前合同只要求定义、环境与日志零秘密，不要求新增应用级日志设施；平台运维可见性不决定核心服务正确性，公开状态修复后已有用户可行动反馈。 | 为早期输出引入跨平台重定向属于本单元明确排除的诊断增强，不能作为提交门禁，也不是确定未来义务。适用边界是现有平台启动不依赖显式应用日志路径，且 stdout/stderr 不泄密、不落入非私有位置。 | 第 36 单元功能提交 `cb71a3ef`；Unit36 固定边界的诊断/信息采集排除项与独立审查价值裁决。 | 新事实证明缺少显式日志路径会阻止平台服务启动；或 stdout/stderr 实际泄漏秘密、进入非私有位置。 | 已排除 |
| EX36-04 | **原主张（R36-02）**：外部 reconcile 的合并式 disable 会绕过 gate/safe-point，应按 P1/中拆分三平台 future/current stop。**原已验证事实**：配置入口先等待 active turn 并请求宿主 graceful reload；进程内 trust 变化先 `refuseNewMessages()`，`runServer.shutdown()` 等待 CleanupRegistry；managed preflight 尚未开放 listener；pairing target 尚无既有 serving role；有 endpoint 但不响应的旧 host 走 `runStopCommand(respectBlockers)`。**触发重开事实**：当前 `requestHostReload()` 未指定 strategy，实际走 `immediate` 且吞掉 RPC 失败；shutdown RPC 只返回 accepted ack，`coreHost.reconnect()` 失败后 reconcile 仍可进入 `adapter.disable()`；本地 active-turn 又不覆盖 remote/channel/scheduler/delivery accepted work。 | 原排除只在全部受支持入口都经过 active-turn、graceful 或 blocker 事实时成立；新生产调用链证明配置入口可在没有全局 accepted-work 安全点时调用 supervisor current-stop，已满足原重开条件。重开仍只要求 future-enabled 与 current-running 按现有安全事实分序，不恢复通用 lifecycle 或 Unit37 能力。 | 第 36 单元当前全量独立重审；产品指纹 `sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0`；`repl.ts`、shutdown RPC、`config-command.ts`、reconciler 与 IR36-04/12～13/20～21/30/32/34 生产入口对账。 | 新生产事实证明某个受支持入口能在同一 serving instance 存在 accepted/in-flight work，且未经过 active-turn、graceful 或 blocker 事实时调用 `adapter.disable()`；本条件现已满足。 | 已重开→U36-15 |
| EX36-05 | **原主张（P36-10）**：权威规格中的 `StorageMaintenanceKind` 手写枚举漏列生产 `managed-service-reconcile`，应按 P2/小同步规格并增加门禁。**已验证事实**：生产 `STORAGE_MAINTENANCE_KINDS`、类型、owner、budget、writer 与 S7 当前内部全等，编译和受支持运行路径均不消费该手写 union。 | 当前没有可达用户失败、安全/耐久损失或实现歧义；原主张只能证明文字差异，并把未来生成器或后续审查的可能风险当作当前价值，没有确定未来交付义务。适用边界是该手写枚举不参与代码生成、兼容校验或运行时 owner/budget 选择。 | 当前 Unit36 冻结产品指纹 `sha256:4bc0b2627feeda6eaa6962eff9ff82c4204130d9e3a7057873e531dbdcc00c51`；本轮独立审查对生产常量、类型、owner、budget、writer 与 S7 的双向对账。 | 该规格枚举成为代码生成/兼容校验输入，或新生产事实证明差异已导致当前实现分叉、验收歧义或资源 owner/budget 错配。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |
| L36-01 | U36-14；U36-01/U36-10/U36-11 专项与先前 Windows 适配器证据曾通过 | 正向真实注册只证明 canonical 输入可工作；后续 strict read 又只攻击 locale/SID/typed set，没有把 supervisor 可变状态与 immutable definition identity 的交界列为独立反例，测试因此构造了 `enabled=false`、`Settings.Enabled=true` 的非生产组合。 | 每次 Windows definition/inspect 变化都分别核对 immutable identity 与 dynamic supervisor state；通过 production inspect 注入非英文/numeric state、wrong SID、缺失/重复/额外 typed set，并强制覆盖 enabled→disabled→re-enable、效果丢响应与公开状态，证明动态状态不进入 immutable matcher。 | 首轮独立重审发现原 U36-14；本轮全量独立重审：IR36-04～05/07/11/24～25/30/32～35 执行 dynamic/immutable 交界，P36-07 同根重开 U36-14。 |
| L36-02 | U36-15；U36-02/U36-12 与 EX36-04 先前结论曾通过 | 先前只沿配置 trigger 验证 reload、accepted-work、future-disable 与 exact turnover 偏序，没有反向枚举同一 reconciler 的其他五个 trigger、plan-error/drift 分支及跨进程入口；局部安全主链因此掩盖 serviceId full-stop fallback。 | 每次 reconcile trigger 或 disable 顺序变化，都枚举完整生产入口 exact-set并穿过真实 post-commit/shutdown/reconnect/reconcile 链；分别注入四类 accepted work、异 trigger/跨进程、发送/响应丢失与 turnover 超时，证明 trigger 只唤醒，缺少 exact endpoint 安全事实时所有入口均零 current-stop。 | 首轮独立重审使 EX36-04 重开为 U36-15；本轮全量独立重审：IR36-04/12～14/16/20～21/28～32/34～35 执行完整入口对账，P36-08 再次同根重开 U36-15。 |
| L36-03 | U36-16；IR36-33 的三平台直接证据先前曾通过 | guest-platform 语义路径同时被当作当前宿主物理路径，单次干净环境掩盖了重复/并行执行的残留污染。 | 所有跨平台 fake-runner 文件副作用测试必须把宿主路径绑定唯一 temp fixture；直接测试至少连续运行两次并核对固定宿主根零残留，真实平台用例才允许使用真实 OS 路径。 | 本轮定向验证：同文件重复运行得到 76/78，两个 manager-error 零写断言以残留 Buffer 失败，登记 U36-16。 |
| L36-04 | U36-05；U36-05 断线恢复专项及 IR36-29 先前结论曾通过 | 只验证 poll 的功能终态与 controller 单飞，没有对成功循环的连接级订阅/闭包数量建立资源上界；逐 attempt 向同一未决 promise 注册监听因此未被观测。 | 每次长循环、重连或 lifetime helper 变化，都在成功、transient→success、fatal、换代与 close 路径统计 listener/controller/closure 数量；循环次数增长时连接级长期驻留必须保持 O(1)，且旧代 completion 不得保留或清理新代资源。 | 本轮全量独立重审：IR36-29 执行成功 poll 资源上界检查，P36-09 同根重开 U36-05。 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| C36-C01 | UTF-16 声明、BOM+UTF-16LE 最终 bytes、转义与 `/Create`/语义 read-back 必须闭合 | Windows definition/adapter 直接合同 | renderer/writer/adapter/tests | 本轮重开修复后 / 小 / 直接4项+真实OS | production原始bytes、系统XML parse、真实Task Scheduler注册/COM身份回读与exact replay通过；测试清理同一task | `product:ca2748bc; win:4/4+real` | 有效 |
| C36-C02 | managed→none/on-demand 必须先关 gate/到安全点，再独立收束 future-enabled/current-running | 三平台 disable、config/reconnect/server drain/reconciler 与 blocker 直接场景 | adapter/reconciler/runtime/server/tests | 修复后 / 中 / 直接闭包 | explicit drain 在拒新后收束 accepted inbound/scheduler/delivery，non-managed future-only disable 位于 exact old endpoint turnover/reconnect 前；发送失败、效果丢响应、超时和后继 generation 均不产生跨代 current-stop | `product:4bc0b262; server:32/32; config:10/10; core:31/31; reconciler:11/11; adapter:19/19` | 有效 |
| C36-C03 | 既有 binding 在四 backend、vault 空/非空与 legacy 回填下必须 existing-only 零写 | secrets existing-only 矩阵与类型检查 | provider/vault/tests | 修复后 / 中 / 6.6s | 四 backend existing-only/managed/legacy 19/19，secrets typecheck 通过 | `product:397ef1dd; secrets:19/19` | 有效 |
| C36-C04 | permission/manager unavailable 不得折为 absent 或先写 definition | 三平台 finite classification/零副作用 | runner/adapter/tests | 本轮修复补证 / 小 / 19项+真实Windows | production classifier 保持；guest fake runner 的 definitionPath 已逐例绑定 temp fixture，三平台零写/read-back证据可重复，真实 Windows 注册/strict COM read-back通过 | `product:4bc0b262; adapter:19/19+real` | 有效 |
| C36-C05 | drift、旧实例、desired 降级及读取中换代不得被 ready/not-needed 快路遮蔽 | strict Windows inspect、snapshot/mapper/CLI/server exact DTO | cli/server/adapter tests | 修复后 / 中 / 直接闭包 | Windows status 只消费 strict numeric/current-identity/typed exact-set `ManagedServiceInspection`；queued/running、错误identity、额外typed项及查询失败均不再向 snapshot 输入猜测事实 | `product:4bc0b262; adapter:19/19; server:32/32` | 有效 |
| C36-C06 | binding 前后并发 wake 必须同 canonical home 单 worker，后继 wake 不丢 | reconciler dirty-loop 与同/异 home 场景 | reconciler/tests | 修复后 / 小 / 11 个直接测试 | load/manager/apply 首轮失败后的一个或多个 joiner 只形成同 home 恰一 successor；持续失败有界终止，异 home 独立，效果丢响应以 read-back 收敛 | `product:ecc94ed5; reconciler:11/11` | 有效 |
| C36-C07 | 三进程形态在 listener 窗口及同 mode trust/role 换代时必须拒旧 identity | admission snapshot、trust callback、runServer gate | runtime/command/tests | 修复后 / 中 / 7.48s增量 | 启动前复验与运行中 full identity 复验 7/7；旧代先 refuse 再 graceful shutdown | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C08 | surface/empty 本机零 spawn/listen，canonical method 只命中 current anchor | CoreHostConnection、surface relay、mesh direct tests | connection/mesh/tests | 修复后 / 中 / CLI 定向总集内 | core-host 31、surface 2、mesh 5 用例均通过；local/unknown 方法稳定拒绝 | `product:397ef1dd; surface:38/38` | 有效 |
| C36-C09 | owner/trust 换代、离线与 dispose 后旧 relay/poll 必须收束且不回退 | surface generation/notification 场景 | surface link/tests | 修复后 / 小 / 8+4 个直接测试 | exact controller token 穿过真实动态 registry/relay queue，在三个 mesh transient 与 BUSY 后无新 dispatch 恢复；fatal、close、换代和 stale completion 不误删新代，既有 surface/helper 交界 4/4 | `product:ecc94ed5; relay:8/8; edge:4/4` | 有效 |
| C36-C10 | EX36-01～EX36-04 与第37～38边界不得因修复被恢复或扩张 | 冻结 diff、规格、S7 与排除记录对账 | 20 文件交付闭包 | 冻结后 / 小 / 只读 | 20 文件产品闭包未新增账户解析、runner、诊断、通用 lifecycle、状态 DTO 或 Unit37～38 生产能力；EX36-01～EX36-03 重开条件未满足，EX36-04 仅由 U36-15 的窄偏序修复闭合 | `product:4bc0b262; s7:19/19` | 有效 |
| C36-C11 | 冷启动对抗发现：trust/role generation 改变但 launch mode 仍为 managed 时，旧实现只比较 mode，会保留旧角色装配 | U36-04 同根修复：启动冻结 `ManagedHostAdmissionSnapshot`，运行中按 full current identity 复验，不同代际先关 gate 再 graceful shutdown | runtime/command/test | 对抗发现后 / 小 / 7.48s | 修复后同 mode trustEpoch/chainHead/roles 变化直接用例与三形态门禁 7/7 通过；重新执行 S7/build 并冻结新指纹 | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C12 | 最终源码必须由同一输入成功构建且差异卫生无异常 | workspace build、S7/golden、`git diff --check` | 20 文件本轮产品输入 | 冻结前 / 中 / workspace build 205s | 同输入 workspace build 一次通过；S7 19/19+golden与diff-check通过。CLI typecheck仅复现8个既有credentials `version`基线错误，未命中本轮文件 | `product:4bc0b262; workspace-build:success; s7:19/19` | 有效 |
| V36-13 | 全单元冻结准备：61 路径闭包、派生产物、问题/排除/教训与精确提交验证计划 | 基线 `b6323cb8`→当前工作树非工作台路径正反向归类、规范化指纹复算、既有证据输入核对 | 61 个非工作台功能路径；工作台排除 | 冻结准备 / 只读低成本 | 61 路径全部归入派生闭包；lockfile/schema无变化；全量指纹 `28043bce…70f7`，最后变化仅 CLI/文档/S7 且对应直接证据、CLI build、S7均有效 | `28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7` | 有效 |
| V36-14 | 第一轮冻结终审：权威要求、完整功能链、装配、状态与产品旅程 | 四份权威来源→R36-01～R36-08→61路径/35项独立清单双向对账；执行L36-01～L36-04；最后推演R36-X | 同一61路径冻结输入、13项正式问题及既有直接证据 | 冻结终审第一轮 / 只读深审 | 矩阵完整，0个新增问题；R36-01～R36-X均取得第1次独立深审，四条迟发现检测动作无新反证 | 同上 | 有效 |
| V36-15 | 第二轮冻结终审：并发、崩溃、安全、资源上界、异常终态与测试盲区 | 不复用第一轮判断，按每个耐久写/外部效果/owner切点重造 supervisor、reconcile、secret、runtime、surface/status 反例；再次执行L36-01～L36-04并推演R36-X | 同一61路径冻结输入、机械事实与直接证据 | 冻结终审第二轮 / 只读深审 | 矩阵完整，0个新增问题；R36-01～R36-X均达到2/2，四条迟发现检测动作再次执行无反证 | 同上 | 有效 |
| V36-16 | 独立功能审查：按失效机制覆盖全部来源、功能链、交付路径、异常与范围边界 | `unit-submit-review.md` IR36-01～IR36-35及两类问题表；按IF36-01～IF36-X归并且不复用终审判断 | 同一61路径冻结输入；工作台证据不参与功能指纹 | 独立功能审查 / 只读 | 35/35 `[x]`，0 `[ ]/[!]/[~]`；P0/P1、非阻断与已删除待转记录均为空，七个独立风险区及跨区组合全部已覆盖 | 同上 | 有效 |
| V36-17 | 单元提交验证：复用直接证据/S7，补最终 workspace build、差异卫生、交付闭包与指纹一致性 | 仅执行一次 `pnpm build`；复用最终 47/47 直接测试、S7 19/19+golden、其余未变输入直接证据与类型归因；补 `git diff --check`、状态门禁、61路径/指纹核对 | 当前61个非工作台源码/合同/直接测试/S7及workspace构建图；工作台排除 | 单元提交验证 / 187.3秒构建 + 只读低成本结算 | workspace build 17/18 projects scope 一次通过；35/35独立项、13/13正式问题、9/9复用项2/2、8/8风险区均全等。产品工作区与暂存输入无漂移，diff hygiene、61路径闭包及指纹 `28043bce…70f7` 一致；未重复包测、S7或构建 | `28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7` | 有效 |

> 本轮 U36-14～U36-16 修复使 C36-C02、C36-C04、C36-C05 重新有效；当前三项结论以 F36-37～F36-45、C36-C32～C36-C42、修复后四路矩阵及 `product:4bc0b262` 证据为准。旧轮次与旧指纹只保留历史。

## U36-01～U36-06、U36-10 专项收口矩阵

> 本节只记录用户锁定七项在同一产品指纹上的专项事实链与冷启动对抗，不代表全单元终审或单元提交验证。

| 只读轮次/角色 | 主动重造的反例与直接交界 | 结论 | 耐久处置 |
| ------------- | ------------------------ | ---- | -------- |
| 专项功能事实链 | 逐格重建 F36-01～F36-15，覆盖 bytes/manager、binding/vault、双 OS 事实、dirty wake、listener、surface owner、snapshot/error 及交叉边界 | 首轮发现 C36-C11；修复后重新冻结并逐格通过 | 同根合并 U36-04；C36-C01～C36-C12 全部有效 |
| 冷启动角色一：definition/SecretStore | 历史转义和 UTF-8 bytes、写序/响应丢失、四 backend binding/backing/vault、legacy 与 managed/foreground | 后续真实 Windows 验收以 C36-C31 推翻该行的 UTF-8 前提并重开 U36-01；其余 SecretStore 结论仍有效 | 当前 definition 结论改由 F36-25～F36-26、C36-C31 及本轮同指纹对抗替代；U36-03、EX36-03 未重开 |
| 冷启动角色二：supervisor/reconcile | 三平台 future/current 双事实、安全 blocker、六 trigger、同/异 home、dirty wake、同 mode trust/role 换代、listener 窗口与重启 | C36-C11 修复后零残留 | U36-02/U36-04 同根闭合；`U36-01↔U36-02`、`U36-02↔U36-04` 通过 |
| 冷启动角色三：surface/status/error | surface/empty、local/unknown、ready/offline、同/异 owner generation、notification/dispose、drift/旧实例/manager 分类及 CLI/server | 零新增反证 | U36-05/U36-06/U36-10 修复后复核通过；`U36-04↔U36-05`、`U36-04↔U36-06↔U36-10` 通过 |
| 冷启动角色四：证据/体验/范围 | 28 文件闭包、S7 mutation/golden、产品旅程、EX36-01～EX36-03、第33～35与第37～38直接交界 | 零新增反证；范围裁决不重开 | 无 coordinator/第二秘密上下文/new runner/诊断/pairing扩面；无 Unit37～38 生产能力 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 七项专项冻结事实链（非全单元终审）：F36-01～F36-15逐格重建 | 是 | 1项同根反证C36-C11，已修复并重新冻结 | `sha256:397ef1dd665a4ae32baa359665af8f8764b7c591e0488866e4b2979fa19ce647` | 七项专项通过；未进入全单元终审 |
| 第二轮 | 七项专项四路冷启动对抗（非全单元终审）：字节/秘密、supervisor、surface/status、范围价值 | 是 | 0 | `sha256:397ef1dd665a4ae32baa359665af8f8764b7c591e0488866e4b2979fa19ce647` | 七项专项通过；未进入全单元终审 |
| 第三轮 | 三项同根修复专项功能审查（非全单元终审）：F36-16～F36-24逐格重建、40 个直接用例、4 个交界用例、类型/S7/build | 是 | 0 | `sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0` | U36-04/U36-05/U36-10 专项通过；未进入全单元终审 |
| 第四轮 | 三项同指纹四路冷启动对抗（非全单元终审）：successor、poll、start、范围价值 | 是 | 0 | `sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0` | 三项专项通过；C36-C13～C36-C19 全部耐久关闭；未进入单元提交验证 |
| 第五轮 | U36-11～U36-13及自动重开前提专项事实链（非全单元终审）：F36-25～F36-36、真实Windows、配置两义务、SecretStore intent | 是 | 0 | `sha256:ca2748bccba0df9276d96416f2718bb5ed0a878895a7f629f9d244ecf67eeb9e` | 五项实现与最小必要验证通过；C36-C30～C36-C31 已闭合；未进入全单元终审 |
| 第六轮 | 同指纹四路冷启动对抗（非全单元终审）：Windows身份/bytes、reload/reconcile、inspect/activate、范围价值 | 是 | 0 | `sha256:ca2748bccba0df9276d96416f2718bb5ed0a878895a7f629f9d244ecf67eeb9e` | U36-01/U36-10/U36-11～U36-13 均已验证；C36-C20～C36-C31 全部耐久关闭；未进入独立审查或单元提交验证 |
| 第七轮 | U36-14～U36-16 修复后专项事实链（非全单元终审）：F36-37～F36-45、真实Windows system read、accepted-work turnover、guest fixture | 是 | 1项同根反证C36-C42，已按有限current-identity exact-set闭合 | `sha256:4bc0b2627feeda6eaa6962eff9ff82c4204130d9e3a7057873e531dbdcc00c51` | 三项实现、最小必要验证、S7与唯一workspace build通过；未进入独立审查或单元提交验证 |
| 第八轮 | 同指纹四路冷启动对抗（非全单元终审）：Windows严格读、accepted-work/supervisor双事实、guest路径、范围价值 | 是 | 0 | `sha256:4bc0b2627feeda6eaa6962eff9ff82c4204130d9e3a7057873e531dbdcc00c51` | U36-14～U36-16 均已验证；C36-C32～C36-C42 全部耐久关闭；受影响独立审查节点须另行重审 |
| 第九轮 | U36-05/U36-14/U36-15 修复后专项事实链（非全单元终审）：F36-46～F36-54、dynamic enabled、future-only reconcile、poll O(1) | 是 | 0 | `sha256:85711ea794479640654928c85f6bf2dd6bf8fcaf1b7cdd1d0438aac75b08044d` | 四个直接测试文件 47/47、S7 19/19+golden、CLI build 通过；类型检查仅既有 8 条基线；未进入独立审查或单元提交验证 |
| 第十轮 | 同指纹四路冷启动对抗（非全单元终审）：dynamic/immutable、current-stop权限、poll资源、范围价值 | 是 | 0 | `sha256:85711ea794479640654928c85f6bf2dd6bf8fcaf1b7cdd1d0438aac75b08044d` | U36-05/U36-14/U36-15 均已验证；C36-C43～C36-C52 全部耐久关闭；受影响独立审查节点已改为 `[~]`，未进入单元提交验证 |
| 第十一轮 | 全单元冻结终审一：权威要求、完整功能链、装配、状态、产品旅程与四条迟发现教训 | 是 | 0 | `sha256:28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7` | 通过；V36-14，R36-01～R36-X均1/2 |
| 第十二轮 | 全单元冻结终审二：并发、崩溃、安全、资源上界、异常终态、测试盲区与跨项对抗 | 是 | 0 | `sha256:28043bce47fdaa2ae78b18f8eb268b160f9fdb9b7a43d22ff2a6bc94c0de70f7` | 通过；V36-15，R36-01～R36-X均2/2 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |
| IF36-01 | OS definition 表示、系统读取、dynamic/immutable 混淆与有限错误失效 | IR36-05、IR36-07～IR36-11、IR36-25、IR36-30、IR36-33、IR36-35；三平台 renderer/writer/runner、Windows COM projector、guest fixture；`28043bce…70f7` | 已覆盖 | V36-16：最终 bytes、current user、typed exact-set、两个 enabled 位、numeric state、effect/read-back 与错误分类逐项二元落定；disabled exact replay/re-enable 且 drift 不被放宽。 | definition/spec、OS query/decoder/classifier、dynamic matcher、guest fixture或直接证据变化。 |
| IF36-02 | stale authority、SecretStore 意外创建与 listener 前身份绕过失效 | IR36-02～IR36-06、IR36-17、IR36-20、IR36-28；launch plan、binding/backend/key、admission snapshot 与三形态组合根；`28043bce…70f7` | 已覆盖 | V36-16：非法/旧 trust、inactive role、fresh/legacy/bound 四 backend、inspect/activate 与启动换代均在副作用前 fail-closed；公开准入只接受同一 current identity。 | trust/role/plan、binding/provider、activation intent、admission或listener gate变化。 |
| IF36-03 | reconcile 丢 wake、无界重试、trigger 越权与 current-stop 截断 accepted work 失效 | IR36-04、IR36-12～IR36-16、IR36-20～IR36-21、IR36-24、IR36-29～IR36-30、IR36-34～IR36-35；六trigger、dirty worker、config drain、future/current与exact endpoint；`28043bce…70f7` | 已覆盖 | V36-16：首轮成功/三类失败、多joiner、异home、四类accepted work、效果丢响应和连续重驱均形成有界 successor；所有 reconcile 入口只收束 future，current 仅认 graceful/exact lock。 | trigger/worker、adapter能力面、shutdown/drain、endpoint/lock、config producer或测试变化。 |
| IF36-04 | managed 启动恢复不完整、consumer/pending 半态与连续重启失效 | IR36-17～IR36-23、IR36-27、IR36-30、IR36-34；runtime assembly、installed generation、scheduler/conversation/delivery、六类pending/outbox与rollback；`28043bce…70f7` | 已覆盖 | V36-16：managed/foreground/on-demand 各切点、旧 owner/epoch、effect/response loss 与连续重启均在 gate 前恢复同一 durable 状态；失败逆序清理，无第二 authority 或公开半态。 | bootstrap/rollback、generation、consumer/pending exact-set、scheduler/delivery或恢复入口变化。 |
| IF36-05 | pure-surface 本机副作用、错误 owner 路由、poll 失活与连接级资源增长失效 | IR36-14～IR36-15、IR36-26～IR36-30、IR36-32、IR36-34～IR36-35；surface link、canonical relay、registry、poll/controller/helper；`28043bce…70f7` | 已覆盖 | V36-16：local/unknown/错误owner、离线、无新dispatch重连、海量成功、transient/BUSY/fatal/换代/close 均只走有限认证 current-anchor；本机零常驻，连接级资源恒 O(1)。 | relay exact-set、owner resolver/registry、poll/backoff、notification/history、close/helper变化。 |
| IF36-06 | 公开状态谎报、隐私泄漏、不可行动体验与 CLI/server 分叉失效 | IR36-24～IR36-26、IR36-28、IR36-30、IR36-32～IR36-34；status snapshot/mapper/DTO、pairing/config/host-missing旅程；`28043bce…70f7` | 已覆盖 | V36-16：managed/on-demand/none、disabled/running/drift/旧实例/readiness/manager错误及远端离线均从同一只读 snapshot 投影；零secret/path/raw ID/error，用户结果有限且可行动。 | snapshot identity/mapper/DTO、CLI/server consumer、公开文案或产品旅程变化。 |
| IF36-07 | 资源/分层/派生资产/证据漂移与 Unit37～38 越界失效 | IR36-01、IR36-27～IR36-31、IR36-33～IR36-35；resource kind/budget、exports、S7/golden、三份权威合同与61路径；`28043bce…70f7` | 已覆盖 | V36-16：资源/取消上界、生产kind/type/owner/budget/writer、profile/trigger/负能力、直接证据与范围排除双向对账；EX36-01～EX36-05重开条件均未满足。 | resource/package/export、descriptor/registry、文件集、权威来源、排除前提或后继边界变化。 |
| IF36-X | 跨区组合：locked secret × plan换代 × manager故障 × accepted work × owner/poll恢复 | IF36-01～IF36-07当前输入与结论、R36-01～R36-X、L36-01～L36-04；`28043bce…70f7` | 已覆盖 | V36-16：按正常、边界、故障、恢复和对抗路径组合复核，无未授权secret写、旧实例/新代误停、双owner、公开半态、丢wake或资源泄漏。 | 任一风险区失效、新生产事实、适用迟发现教训、问题状态或单元边界变化。 |

<!-- registration-complete: unit-36.gen-1 -->
