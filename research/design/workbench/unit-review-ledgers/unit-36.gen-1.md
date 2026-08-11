# 单元登记:第 36 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:36
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-11
- **登记来源**:用户要求将第 36 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U36-01～U36-06、U36-10 专项修复、最小验证、冻结事实链与四路冷启动对抗均已完成，七项已验证；EX36-01～EX36-03 继续排除；未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2（本轮只完成七项专项收口，不计全单元终审轮次）
- **交付物是否冻结**:是（仅 U36-01～U36-06、U36-10 专项产品交付物）
- **交付物文件集**:以第 35 单元封版代码提交 `b6323cb8` 与第 36 单元功能提交 `cb71a3ef` 为基线；本轮 28 个产品文件分为 CLI 生产/直接测试 16、secrets 生产/直接测试 3、server 生产/直接测试 4、权威架构/规格 3、既有 S7 descriptor/test 2；工作台与正式账本不计入产品指纹
- **当前交付物指纹**:`sha256:397ef1dd665a4ae32baa359665af8f8764b7c591e0488866e4b2979fa19ce647`
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
| CLI definition/reconcile/runtime/surface/status 生产文件与 8 个直接测试文件（16） | CLI dist、三平台命令合同、canonical relay exact-set、managed status DTO | CLI 直接集 75/75；增量 trust-generation 7/7；CLI typecheck 仅复现 8 个未改文件既有 `ZhixingCredentials` 基线错误；workspace build 17/17 | 通过 |
| secrets master-key/platform store 与 vault 直接测试（3） | `@zhixing/secrets` 类型导出与 vault/backing-key 兼容 | existing-only 19/19；secrets typecheck 通过；workspace build 通过 | 通过 |
| server status context/mapper/routes 与直接测试（4） | server DTO、async route 与 CLI snapshot 消费合同 | server direct 8/8；server typecheck 通过；workspace build 通过 | 通过 |
| distributed-runtime 总纲、需求、规格（3） | Unit36 边界、直接验收及 Unit37～38 排除同步 | 逐条与 F36-01～F36-15、EX36-01～EX36-03 双向对账 | 通过 |
| 既有 S7 descriptor 与测试（2） | registry golden、有限生产 exact-set；无新 runner/依赖/lockfile | `pnpm s7:lint` 19/19 + registry golden；产品 diff 无 lockfile/schema 变化 | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| F36-01 · Windows definition bytes | `ManagedServiceSpec` 派生的 canonical UTF-8 bytes，身份绑定 `serviceId + digest(bytes)` | 私有临时文件 fsync→rename→目录 fsync；`schtasks /Create` 后 query/read-back 全等 | 写入前后、rename 前后、`/Create` 效果/响应窗口、重启 | renderer/writer/adapter/reconciler；Windows Task Scheduler | 单份 bounded definition；同 bytes exact replay，异 bytes fail-closed | 通过 |
| F36-02 · definition durable/manager identity | 落盘原始 bytes 与 supervisor 查询的同一 `serviceId` | 落盘 byte-for-byte read-back 与 manager definition match 同时成立 | 转义路径、首次/重复安装、stored/manager 单边存在 | 三平台 adapter、managed preflight/status | 零扫描；每次固定有限 query/read-back | 通过 |
| F36-03 · future-enabled/current-running | supervisor 对同一 platform domain/serviceId 的 enabled 与 running 两个独立事实 | 先关闭当前准入并走 graceful shutdown 安全点；future launch/current instance 分别由平台命令与独立 read-back 收束 | 两步任一效果/响应丢失、安全 blocker、连续重启 | adapter/reconciler/current host/router/listener/status | 固定命令序列；幂等重放不卸载、不强杀，安全点前不执行 supervisor current stop | 通过 |
| F36-04 · bound master-key existing-only | canonical home 的 backend binding 与绑定 backend 原 backing key | existing-only 读取/验真成功；既有 binding 打开零写 | binding/backing/vault 有无与歧义、backend 锁定/不可用、重启 | bound provider、四 backend、vault/managed preflight | 单 key；无新上下文，missing/ambiguous 零写 | 通过 |
| F36-05 · first foreground/legacy binding | vault/key 既有性与一次原子 backend binding | legacy existing-only 成功后写 binding；全新空 store 首次 foreground 创建后写 binding | legacy 回填效果/响应丢失、managed/foreground 并发 | provider factory、serialized provider、startup | 初始化锁单飞；managed 永不创建 | 通过 |
| F36-06 · supervisor query classification | 平台命令的 documented exit/output 归一为 found/not-found/permission/manager-unavailable | 只有确定 not-found 产生 absent；其他类在 definition 写前终止 | command missing、权限、session/manager 不可达、输出歧义 | runner/adapter/reconciler/status mapper | 固定四类；不保存/公开 raw stderr | 通过 |
| F36-07 · managed status snapshot | 同一次 current load 派生的 plan/spec + 真实 inspect + process/readiness | 末尾复验 plan/spec identity；一致后形成只读 snapshot | definition drift、旧实例、配置关闭、读取中换代、manager 错误 | CLI/server snapshot builder与唯一 mapper | 最多一次有界重读；零持久状态 | 通过 |
| F36-08 · public status projection | `ManagedHostStatusSnapshot` 的有限字段 | CLI/server 对同 snapshot 输出 exact DTO | managed/on-demand/none × process/readiness/service/error | CLI human、server `/api/status` | exact keys；无路径/service/device/role/raw error | 通过 |
| F36-09 · canonical-home reconcile worker | canonical resolved home + 每轮重读的 current plan/spec | 同 home worker 一轮完成且 dirty=false；异 home 独立 | 六 trigger、binding 前后、同/异 home、并发 wake/响应丢失 | pairing/config/trust/preflight/host-missing、adapter | 同 home恰一 worker；后继 wake 有界重驱 | 通过 |
| F36-10 · listener admission | 启动时冻结的 current plan/spec/trust identity 与运行中同一 `ManagedHostAdmissionSnapshot` | `runServer` 前全等复验；trust/role 同 mode 换代也先拒新并 graceful restart | managed/foreground/on-demand、trust/config/role 变化、listener 窗口 | topology/command/router refusal/shutdown | 单份 immutable identity；不新增 generation coordinator | 通过 |
| F36-11 · surface current-authority link | current signed trust 的 issuer deviceId + 认证 surface principal/generation | canonical relay method dispatch 到 current anchor；本机副作用始终为空 | surface/empty、remote ready/offline、错误 owner、首次/重连 | `CoreHostConnection`、认证 mesh、finite client | canonical exact-set；零 spawn/module/listener | 通过 |
| F36-12 · owner change/notification/dispose | control plane 的 current signed trust 全量 identity；surface client 只缓存与该 identity 全等的 owner relay | trust watcher 发现 identity 变化即 close 旧 relay/poll；下一 dispatch 只按 current issuer 建链 | notification、同 owner 换代、异 owner、离线、响应丢失、连续重启 | surface link、mesh control plane、FirstParty client | 单 surface 单 poll；离线稳定 retryable、不回退旧 owner | 通过 |
| F36-13 · definition/disable 交界 | 同一 serviceId 的 canonical bytes、enabled/running 双事实 | 只对匹配 definition 的实例执行安全 disable | drift+降级、效果丢失、manager 错误 | U36-01/U36-02/U36-10 共享 adapter | 固定 read→disable→read；零删除 | 通过 |
| F36-14 · reconcile/status/error 交界 | current plan/spec 与有限 adapter 结果 | reconcile 副作用与 snapshot 只消费同一分类/identity | dirty wake、旧实例、不可判定 manager、状态查询换代 | U36-04/U36-06/U36-10 全消费者 | 有界重读；零第二事实源 | 通过 |
| F36-15 · 产品与后续单元边界 | Unit 36 固定范围与 EX36-01～EX36-03 | 七项直接合同闭合即停止 | 卸载/升级/回滚/诊断/runner 扩张诱因 | 正式问题、规格与审查清单 | 不新增第37～38能力、通用框架或信息采集 | 通过 |

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
| U36-01 | **P0/小。** Windows renderer 生成 `encoding="UTF-16"` 的 XML 文本，`writeDefinition()` 却把同一字符串编码成 UTF-8 无 BOM；真实 `/Create /XML` 消费的是落盘 bytes，而当前 golden 只比较字符串。稳定身份是 `serviceId + canonical definition bytes`，耐久点是临时文件 fsync 后 rename/目录 fsync，OS 生效点是 `/Create` 成功及 query read-back。**价值裁决记录**：保持现状会让 Windows 主路径确定不可安装，修正规则不能把非法 bytes 变成合法输入；复用现有 UTF-8 写链是最先可行且比例最小的方案。当前损失、处理必要性和单元归属均成立；用户体验达标、架构达标。最终结论：保留 P0/小及收窄方案。 | renderer、durable writer、definition identity 与直接证据没有共享同一个最终字节合同，字符串相等无法证明 OS 所见 bytes 合法。 | **生产端**：Windows definition render/write、`schtasks /Create` 与 inspect。**类型组合**：空格/引号/XML 转义路径、首次/重复安装、写入/创建效果前后失败、响应丢失与重启。**消费者**：adapter、reconciler、current anchor/executor 启动链。**异常终态**：创建前稳定失败或重放永不收敛；其他平台格式不受影响。**测试/审查项**：最终 bytes 解码/解析、真实创建与 read-back；IR36-07、IR36-11、IR36-30、IR36-32～IR36-35。 | 让 Windows renderer 只产出声明与正文一致的规范 UTF-8 bytes，durable writer、definition 比较和 `/Create` 共用该 bytes；写后回读原始文件并核对 byte-for-byte，再由 Windows 兼容 XML 解析链/真实 adapter 创建并回读。验收覆盖转义路径、首次与 exact replay、各写序/响应窗口和重启；同一 `serviceId` 只接受同一 bytes，不新增编码格式或解析依赖。 | 已验证 |
| U36-02 | **P1/中。** Windows `disableManager()` 只执行 `/Change /DISABLE`，macOS 只执行 `launchctl disable`，但 `disable()` 随后要求 `running=false`；两条 supervisor 命令只禁止未来拉起，不终止当前实例，测试 fake 却同步改写 enabled/running。稳定身份是同一 `serviceId` 及其 platform domain，future-enabled 与 current-running 是两个独立 OS 事实；完成线性化点是二者分别回读为 disabled 与 not-running。**价值裁决记录**：保持现状或放宽 read-back 会留下旧 role/listener；现有 `/End`、`bootout` 足够，无需第 37 单元卸载或新 lifecycle。用户体验达标、架构达标。最终结论：保留 P1/中。 | adapter 把“禁止未来自动拉起”和“停止当前实例”误作一个 supervisor 状态转换，fake 又掩盖了真实双事实/双效果边界。 | **生产端**：Windows/macOS disable 与 Linux 既有 `disable --now`。**类型组合**：managed→on-demand/none、role/选择撤销、running/stopped/manager-absent、两步任一效果/响应丢失及连续重启。**消费者**：reconciler、current host、router/listener gate、公开状态。**异常终态**：旧 host 继续服务，或已经停止却因回读混合事实无法 exact replay。**测试/审查项**：真实 supervisor 双事实、幂等重放；IR36-07～IR36-08、IR36-11、IR36-20、IR36-30、IR36-32～IR36-34。 | 当前实例内的 trust/config 变化先关闭 gate，并只请求既有 graceful shutdown；响应丢失由 endpoint turnover/read-back 吸收。旧实例到安全点退出后，由配置重连或 supervisor 新实例的 managed preflight 调用同一 adapter：Windows `/Change /DISABLE`→必要 `/End`，macOS `disable`→必要 `bootout`，Linux `disable --now`，分别回读 future-enabled/current-running；已停/not-found exact replay，permission/unavailable fail-closed。验收覆盖两种降级目标、安全 blocker、同 mode 角色换代、各响应窗口和连续重启，零卸载/强杀。 | 已验证 |
| U36-03 | **P1/中。** `BoundPlatformMasterKeyProvider` 读到既有 backend binding 后仍调用 delegate 的 `loadOrCreate()`；DPAPI 与 machine-bound 在 backing file/seed 缺失时会写新值，Keychain/Secret Service 在 vault 不存在时也会创建，只有已有非空 vault 时才先行拒绝。稳定身份是 canonical home 的 durable backend binding 与该 backend 原 backing key；首次创建线性化点是 backing key 成功后原子写 binding，既有 binding 的打开不得产生写。**价值裁决记录**：原“可继续写入第二秘密上下文”被既有非空 vault 的认证门禁证伪，不恢复；但 bound existing-open 仍有可达创建副作用并把 missing/locked 混成 unavailable。用户体验达标、架构达标。最终结论：改写事实，保留 P1/中；仅新证据证明旧 vault 可被新 key 越过时重开原主张。 | provider 只有 create-capable 契约，未按“已有 binding/既有 store”与“无 binding 的首次 foreground 初始化”分离读取权限。 | **生产端**：`BoundPlatformMasterKeyProvider`、DPAPI/Keychain/Secret Service/machine-bound delegate 与 vault unlock。**类型组合**：binding 有/无、backing key 有/缺/歧义、vault 空/非空、managed/foreground、legacy binding 回填与重启。**消费者**：SecretStore、managed preflight、launch spec、公开 credentials 状态。**异常终态**：既有 binding 打开先改变 backing 事实再失败，或把可行动 locked 状态误报为普通不可用。**测试/审查项**：三平台 backend 与 machine-bound 的 existing-only 零写矩阵；IR36-06、IR36-28、IR36-32～IR36-33。 | 在现有 master-key provider 增加窄 `loadExisting()`：有 binding 时 foreground/managed 均只按绑定 backend 读取并验真原 key，missing/ambiguous 稳定映射 `credentials-locked` 且零创建/覆盖；无 binding 时，legacy store 只能 existing-only 成功后回填，只有确认 vault/key 均未初始化的首次 foreground 才可复用 `loadOrCreate()` 并原子写 binding，managed 永不创建。验收覆盖各 backend、空/非空 vault、legacy 回填、重启及写调用 exact-set，不新增第二 SecretStore 上下文或 lifecycle。 | 已验证 |
| U36-04 | **P0/中（3～4 人日；由 P0/大收窄）。** 六个 trigger 名称与 pairing/config/host-missing/preflight 调用点已存在，配置入口也会调用 reconcile；真实残留是 `inFlight` 在首次 `loadCurrent()` 后才按 `serviceId` 或 `unregistered:deviceId` 选键，binding 建立前后可并行，同键后继 wake 只复用旧 Promise、没有 dirty 重驱。trust 回调只装入 managed 形态，且启动链从 managed preflight 到 `runServer` 公开 listener 之间没有对同一 current plan/spec 的最终复验。稳定 identity 应是 canonical home；耐久事实仍是 signed trust/config/backend binding 派生的 current plan/spec，不能另造 generation。**价值裁决记录**：原专用 generation coordinator/P0大方案已被现有 plan/spec、reconciler、router gate 与 shutdown 证伪并收窄；保持现状仍会吞掉 current-anchor/role 变化或让过期实例公开服务。用户体验达标、架构达标。最终结论：保留 P0/中；仅现有 plan/spec 无法稳定比较或驱动 gate 时重开 coordinator。**专项冷启动反证 C36-C11**：修复初版只比较 launch mode，同为 managed 的 trustEpoch/chainHead/roles 换代会保留旧角色装配；该事实同根并已纳入最终方案。 | 现有 reconciler 没有以 canonical home 闭合“全部触发 → 单飞重驱 → 运行中 gate → listener 前最终准入”，问题是协调闭包缺失而非缺少新 lifecycle 事实。 | **生产端**：两生产根的 pairing issuer/joiner、config、verified trust、managed preflight、host-missing 六类触发和三运行形态。**类型组合**：同/异 home、binding 前后、同/异计划并发 wake、current-anchor 晋升/撤销、role/选择变化、健康/退出 host、listener 窗口、效果/响应丢失与连续重启。**消费者**：OS adapter、foreground/on-demand/managed host、current-owner router、shutdown、listener/ready。**异常终态**：同 home 双 reconcile、最新 wake 被吞、晋升不自恢复、撤权后旧准入继续、过期 plan/spec 公开 listener。**测试/审查项**：六 trigger exact-set、dirty-loop、三形态 gate 与准入窗口；IR36-12～IR36-13、IR36-17、IR36-20、IR36-28、IR36-30、IR36-32、IR36-34～IR36-35。 | 所有入口先以 canonical home 进入现有 single-worker dirty-loop，每次 wake 只置 dirty并循环重读 current plan/spec；binding/spec 变化不换单飞 identity。启动时冻结 full `ManagedHostAdmissionSnapshot`，`runServer` 监听前全等复验；verified trust 回调覆盖三进程形态，同 mode 的 trust/role generation 变化也先拒新并只请求 graceful shutdown，待 endpoint turnover 或下一 managed preflight 再执行 supervisor reconcile，避免安全点前 current stop；未变化才按 `current-trust-applied` 重驱。验收覆盖六 trigger、同异 home、binding 前后、同异 mode/role/owner、listener 窗口、响应丢失和连续重启，不新增 coordinator/registry/lifecycle。 | 已验证 |
| U36-05 | **P1/中。** `CoreHostConnection` 本机发现失败后调用 reconcile；`none` 结果只返回“这台设备不需要后台运行”，没有消费已经存在的 `CurrentAnchorFirstPartyRpcRouter`、canonical relay exact-set 和认证 `FirstPartyConversationMeshClient`。这些原语当前只在有本地 runtime/mesh assembly 的 host 内装配，所以纯 surface/empty role 虽正确保持零本机 host，却没有产品请求出口。稳定 identity 是 current signed trust 的 current-anchor deviceId 加认证 surface principal/generation；远端 dispatch 是唯一消费点，本机 spawn/监听必须始终为零。**价值裁决记录**：总纲要求 surface 是同一产品的接入面，不能把零常驻修正规则解释为零可用；既有有限认证 relay 可复用，无需通用 RPC 代理。用户体验达标、架构达标。最终结论：保留 P1/中。 | `none` 只完成了本地 launch 决策的生产端，没有把 `CoreHostRpcLink` 的合法消费端切换到现有 current-authority 认证 surface 链。 | **生产端**：`CoreHostConnection` host-missing/none 分支、current-authority resolver、认证 mesh surface connector。**类型组合**：surface-only/empty、remote ready/offline、错误/换代 owner、首次/重连/通知/重启。**消费者**：canonical first-party method exact-set 与其 notifications。**异常终态**：本机零常驻但用户无法使用；或错误回退旧 owner/本地 spawn。**测试/审查项**：逐方法 remote-ready、offline/错误 owner、重连通知且本机零 spawn/module/listener；IR36-14、IR36-27、IR36-32、IR36-34～IR36-35。 | 在 `CoreHostConnection` 的 none 分支、且进入本地 RPC `auth/health/server.shutdown` 握手前，装配一个仅实现 canonical first-party exact-set 的远端 `CoreHostRpcLink`，直接复用 current-authority resolver、认证 mesh transport 和 `FirstPartyConversationMeshClient`；设备本地方法与未知方法不得代理。连接/重连前重读 current owner，错误 owner 关闭旧 relay并重解析，离线返回既有 retryable 行动；dispose/换代必须关闭旧 relay 与 poll。不得 fallback 旧 owner、spawn daemon、装角色模块或开 listener。验收覆盖 surface/empty、ready/offline/换代、逐方法与 notification 关联，证明请求恰一路由、后台 poll 可收束且本机副作用 exact-set 为空。 | 已验证 |
| U36-06 | **P1/中。** CLI 会读取 durable plan 与真实 adapter inspect，但 server 只按 `processMode` 推 desired 并硬编码 enabled/running/matches；共享 mapper 又不检查 `service.matches`，并在 desired 为 none 时先返回 not-needed，能遮蔽仍运行的旧 managed instance。因此同一 home 在 definition drift、配置关闭、旧实例仍活、manager 不可判定等场景会生成两套公开结论。稳定 snapshot identity 必须绑定同一次 current plan/spec 读取及对应 supervisor inspect/runtime readiness；它只是无副作用读模型，不能成为第二 durable 状态。**价值裁决记录**：保持现状会把不可持续恢复的实例明确误报为“可以使用”或“不需要后台运行”；现有 plan、inspect、process/readiness 足够，不需要状态框架。用户体验达标、架构达标。最终结论：保留 P1/中。 | CLI 与 server 各自拼装 desired/service/process/readiness，缺少一个从现有权威事实构成且拒绝混代的 managed-status snapshot 生产者；mapper 的 desired 快路又越过真实旧实例。 | **生产端**：launch plan/spec loader、adapter inspect、PID/health 与 runtime readiness、CLI/server status composition。**类型组合**：managed/on-demand/none、match/drift、配置关闭、旧实例、running/stopped/stale、ready/recovering/degraded/stopping/failed、manager permission/unavailable及读取中换代。**消费者**：同一个 public mapper、CLI human 输出和 server DTO。**异常终态**：入口分叉、混合代际或伪 ready/not-needed；公开面仍不得泄漏路径、service/device/role/raw error。**测试/审查项**：有限组合表与 CLI/server exact DTO；IR36-25～IR36-26、IR36-30、IR36-32、IR36-34～IR36-35。 | 抽取唯一无副作用 `ManagedHostStatusSnapshot` builder：从同一 current load 派生 plan/spec，读取真实 inspect 与现有 process/readiness，结束前复验 plan/spec identity，漂移则有界重读或返回非 ready，绝不拼混；CLI/server 只把该 snapshot 交给同一 mapper，server 删除硬编码事实。mapper 仅在 desired none/on-demand 且没有不应存在的 managed instance/关闭中进程时返回 not-needed，`matches=false` 与 U36-10 不可判定错误映射有限稳定 action。验收为两入口 exact keys/value 全等，覆盖关闭/漂移/旧实例/manager/readiness/换代且零新持久状态、零 raw 信息。 | 已验证 |
| U36-10 | **P2/小。** 三平台 `inspectManager()` 把 Windows/macOS 任意 query 非零、Linux 非 enabled/disabled 结果直接折为 absent；command spawn/权限/manager 会话不可用也没有有限 typed 分类。`install()` 因而可把“不可判定”当确定不存在并先写私有 definition。稳定判别只能是 found/not-found/permission/manager-unavailable 四类；只有平台可证明 not-found 才授权 absent 和后续 install。**价值裁决记录**：该路径不能越权成功或破坏 authority，P1 损失不成立；但会留下孤立 definition并给出错误行动，当前体验价值成立。只收窄现有 runner，用户体验达标、架构达标。最终结论：保留 P2/小。 | command runner/adapter 丢失 supervisor 查询的有限错误语义，错误地把未知事实作为 absent 的正面证据。 | **生产端**：Windows/Linux/macOS query runner、inspect 与 install 前置。**类型组合**：found、documented not-found、permission、manager/session unavailable、command missing、首次/重放与响应丢失。**消费者**：reconciler、U36-06 snapshot、CLI/server action。**异常终态**：permission/unavailable 被误导为 absent并发生不必要的 definition 写；不会越权注册或改变 authority。**测试/审查项**：各平台分类与写前零副作用；IR36-07～IR36-11、IR36-25～IR36-26。 | 在现有 runner/adapter 内建立平台有限分类并扩展现有 `ManagedServiceErrorCode`，不公开 raw stderr：只有确定 not-found 返回 absent；permission 与 manager/session unavailable 在任何 definition 写前 fail-closed，由 U36-06 映射既有稳定行动，其他非零归不可判定。验收逐平台覆盖四类、命令启动错误、首次/exact replay与响应丢失，断言 permission/unavailable 零 definition/manager 副作用且不新增错误框架。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | -------------- | -------- | -------- |
| EX36-01 | **原主张（U36-07）**：S7 门禁 30/60 秒超时且语义覆盖不足，应按 P1/中修脚本并扩 mutation。**已验证事实**：超时只证明本轮未取得结果，不能证明 runner 不终结；S7 负责生产装配 exact-set，不替代 XML、OS supervisor、并发与状态投影的直接行为测试。 | 已确认的真实缺陷已各自归入 U36-01～U36-06，其验收包含相应直接证据；单独扩张 S7 没有额外当前用户价值，也不形成未来义务。适用边界是现有 S7 仍按项目规定方式可执行，且生产装配漂移能由既有 descriptor 与直接测试拒绝。 | 第 36 单元功能提交 `cb71a3ef`；独立审查清单 IR36-35 与本轮 U36-01～U36-06 根因归并/价值裁决。 | 现有 S7 在项目规定运行方式与上限内被事实证明不能终结；或 U36-01～U36-06 修复后仍有无法由直接测试及既有 descriptor 拒绝的生产装配漂移。 | 已排除 |
| EX36-02 | **原主张（U36-08）**：pairing 成功前持久化自动上线选择，surface-only 也会被询问，应按 P2/小调整事务/体验。**已验证事实**：用户已明确作出选择；失败重试复用本地偏好不会产生授权、role、OS 注册或秘密副作用，`executorAutoStart` 对无 executor role 不生效，且现有配置入口可修改。 | 没有证据证明重复询问改善当前核心体验；强制与 trust 原子化会无价值地扩大 pairing 事务边界。该主张无当前问题且无确定未来交付义务。 | 第 36 单元功能提交 `cb71a3ef`；独立审查对 pairing/config/role/SecretStore 生产链的价值裁决。 | 新生产事实证明残留偏好会在未获 executor 授权时触发注册/运行；或用户无法通过现有入口修改已保存选择。 | 已排除 |
| EX36-03 | **原主张（U36-09）**：Windows/macOS managed stdout/stderr 未显式进入私有应用日志，应按 P2/中补跨平台重定向。**已验证事实**：当前合同只要求定义、环境与日志零秘密，不要求新增应用级日志设施；平台运维可见性不决定核心服务正确性，公开状态修复后已有用户可行动反馈。 | 为早期输出引入跨平台重定向属于本单元明确排除的诊断增强，不能作为提交门禁，也不是确定未来义务。适用边界是现有平台启动不依赖显式应用日志路径，且 stdout/stderr 不泄密、不落入非私有位置。 | 第 36 单元功能提交 `cb71a3ef`；Unit36 固定边界的诊断/信息采集排除项与独立审查价值裁决。 | 新事实证明缺少显式日志路径会阻止平台服务启动；或 stdout/stderr 实际泄漏秘密、进入非私有位置。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| C36-C01 | UTF-8 声明、最终 bytes、转义与 `/Create`/read-back 必须全等 | Windows definition/adapter 直接合同 | renderer/writer/adapter/tests | 修复后 / 小 / CLI 定向总集内 | production bytes、系统兼容 XML 解析、写后原始 bytes 及 exact replay 均通过 | `product:397ef1dd; cli:75/75` | 有效 |
| C36-C02 | managed→none/on-demand 必须先关 gate/到安全点，再独立收束 future-enabled/current-running | 三平台 disable、runtime trust/config 与 blocker 直接场景 | adapter/reconciler/runtime/tests | 修复后 / 中 / CLI 定向总集内 | Windows `/End`、macOS `bootout`、Linux `disable --now` 及双 read-back/安全顺序通过 | `product:397ef1dd; cli:75/75` | 有效 |
| C36-C03 | 既有 binding 在四 backend、vault 空/非空与 legacy 回填下必须 existing-only 零写 | secrets existing-only 矩阵与类型检查 | provider/vault/tests | 修复后 / 中 / 6.6s | 四 backend existing-only/managed/legacy 19/19，secrets typecheck 通过 | `product:397ef1dd; secrets:19/19` | 有效 |
| C36-C04 | permission/manager unavailable 不得折为 absent 或先写 definition | 三平台 finite classification/零副作用 | runner/adapter/tests | 修复后 / 小 / CLI 定向总集内 | documented not-found、permission、manager-unavailable 与 command spawn failure 全部稳定分类 | `product:397ef1dd; cli:75/75` | 有效 |
| C36-C05 | drift、旧实例、desired 降级及读取中换代不得被 ready/not-needed 快路遮蔽 | snapshot/mapper/CLI/server exact DTO | cli/server status/tests | 修复后 / 中 / 直接集 | CLI snapshot/mapper 10/10、server DTO 8/8，server typecheck 通过 | `product:397ef1dd; status:18/18` | 有效 |
| C36-C06 | binding 前后并发 wake 必须同 canonical home 单 worker，后继 wake 不丢 | reconciler dirty-loop 与同/异 home 场景 | reconciler/tests | 修复后 / 中 / CLI 定向总集内 | dirty-loop、same-home coalescing、later wake redrive、different-home isolation 通过 | `product:397ef1dd; cli:75/75` | 有效 |
| C36-C07 | 三进程形态在 listener 窗口及同 mode trust/role 换代时必须拒旧 identity | admission snapshot、trust callback、runServer gate | runtime/command/tests | 修复后 / 中 / 7.48s增量 | 启动前复验与运行中 full identity 复验 7/7；旧代先 refuse 再 graceful shutdown | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C08 | surface/empty 本机零 spawn/listen，canonical method 只命中 current anchor | CoreHostConnection、surface relay、mesh direct tests | connection/mesh/tests | 修复后 / 中 / CLI 定向总集内 | core-host 31、surface 2、mesh 5 用例均通过；local/unknown 方法稳定拒绝 | `product:397ef1dd; surface:38/38` | 有效 |
| C36-C09 | owner/trust 换代、离线与 dispose 后旧 relay/poll 必须收束且不回退 | surface generation/notification 场景 | surface link/tests | 修复后 / 中 / CLI 定向总集内 | full trust identity 变化关闭旧 relay，offline retryable，dispose 清 transport/storage | `product:397ef1dd; surface:2/2` | 有效 |
| C36-C10 | EX36-01～EX36-03 与第37～38边界不得因修复被恢复 | 冻结 diff、规格、S7 与排除记录对账 | 28 文件交付闭包 | 冻结后 / 小 / 只读 | 无新 runner/诊断/pairing事务/coordinator；无停机卸载/升级回滚/全局同步生产能力 | `product:397ef1dd; s7:19/19` | 有效 |
| C36-C11 | 冷启动对抗发现：trust/role generation 改变但 launch mode 仍为 managed 时，旧实现只比较 mode，会保留旧角色装配 | U36-04 同根修复：启动冻结 `ManagedHostAdmissionSnapshot`，运行中按 full current identity 复验，不同代际先关 gate 再 graceful shutdown | runtime/command/test | 对抗发现后 / 小 / 7.48s | 修复后同 mode trustEpoch/chainHead/roles 变化直接用例与三形态门禁 7/7 通过；重新执行 S7/build 并冻结新指纹 | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C12 | 最终源码必须由同一输入成功构建且差异卫生无异常 | workspace build、S7/golden、`git diff --check` | 28 文件产品输入 | 冻结前 / 中 / 179.5s build | workspace 17/17、S7 19/19+golden、diff-check 通过；无重复同输入构建 | `product:397ef1dd; build:17/17` | 有效 |

## U36-01～U36-06、U36-10 专项收口矩阵

> 本节只记录用户锁定七项在同一产品指纹上的专项事实链与冷启动对抗，不代表全单元终审或单元提交验证。

| 只读轮次/角色 | 主动重造的反例与直接交界 | 结论 | 耐久处置 |
| ------------- | ------------------------ | ---- | -------- |
| 专项功能事实链 | 逐格重建 F36-01～F36-15，覆盖 bytes/manager、binding/vault、双 OS 事实、dirty wake、listener、surface owner、snapshot/error 及交叉边界 | 首轮发现 C36-C11；修复后重新冻结并逐格通过 | 同根合并 U36-04；C36-C01～C36-C12 全部有效 |
| 冷启动角色一：definition/SecretStore | 转义和 UTF-8 bytes、写序/响应丢失、四 backend binding/backing/vault、legacy 与 managed/foreground | 零新增反证 | U36-01/U36-03 修复后复核通过；EX36-03 未重开 |
| 冷启动角色二：supervisor/reconcile | 三平台 future/current 双事实、安全 blocker、六 trigger、同/异 home、dirty wake、同 mode trust/role 换代、listener 窗口与重启 | C36-C11 修复后零残留 | U36-02/U36-04 同根闭合；`U36-01↔U36-02`、`U36-02↔U36-04` 通过 |
| 冷启动角色三：surface/status/error | surface/empty、local/unknown、ready/offline、同/异 owner generation、notification/dispose、drift/旧实例/manager 分类及 CLI/server | 零新增反证 | U36-05/U36-06/U36-10 修复后复核通过；`U36-04↔U36-05`、`U36-04↔U36-06↔U36-10` 通过 |
| 冷启动角色四：证据/体验/范围 | 28 文件闭包、S7 mutation/golden、产品旅程、EX36-01～EX36-03、第33～35与第37～38直接交界 | 零新增反证；范围裁决不重开 | 无 coordinator/第二秘密上下文/new runner/诊断/pairing扩面；无 Unit37～38 生产能力 |

## 终审记录

| 轮次   | 审查侧重                                       | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论   |
| ------ | ---------------------------------------------- | ------------ | -------- | ---------- | ------ |
| 第一轮 | 七项专项冻结事实链（非全单元终审）：F36-01～F36-15逐格重建 | 是 | 1项同根反证C36-C11，已修复并重新冻结 | `sha256:397ef1dd665a4ae32baa359665af8f8764b7c591e0488866e4b2979fa19ce647` | 七项专项通过；未进入全单元终审 |
| 第二轮 | 七项专项四路冷启动对抗（非全单元终审）：字节/秘密、supervisor、surface/status、范围价值 | 是 | 0 | `sha256:397ef1dd665a4ae32baa359665af8f8764b7c591e0488866e4b2979fa19ce647` | 七项专项通过；未进入全单元终审 |

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-36.gen-1 -->
