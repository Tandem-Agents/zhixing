# 单元登记:第 36 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:36
- **generation**:1(仅经用户显式授权递增;同单元的修复、复审、终审轮复位是本文件内的状态推进,不产生新登记)
- **登记时间**:2026-08-11
- **登记来源**:用户要求将第 36 单元独立审查及价值裁决后的全部当前问题转入正式问题列表

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、审查结论复用表、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:U36-11～U36-13 及被 C36-C30～C36-C31 自动重开的 U36-10/U36-01 已在同一专项产品指纹上完成实现、最小必要验证、固定矩阵与四路冷启动对抗；五项均已验证。独立审查清单仍保留 30 项 `[~]` 待后续独立重审，未进入全单元终审或单元提交验证
- **连续无新增问题轮数**:0 / 2（本轮只完成七项专项收口，不计全单元终审轮次）
- **交付物是否冻结**:是（本轮专项产品指纹 `sha256:ca2748bccba0df9276d96416f2718bb5ed0a878895a7f629f9d244ecf67eeb9e`；工作台状态/证据记录不属于产品指纹，任何产品文件变化均使本专项结论失效）
- **交付物文件集**:以第 35 单元封版提交 `b6323cb8`、第 36 单元功能提交 `cb71a3ef` 与既有修复提交 `b6d9baf2` 为基线；本轮 30 个产品文件分为 CLI 生产/直接测试 18、secrets 生产/直接测试 3、server 生产/直接测试 4、权威架构/规格 3、既有 S7 descriptor/test 2；新增纳入 current-anchor relay 生产/直接测试 2 文件，工作台与正式账本不计入产品指纹
- **当前交付物指纹**:`sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0`（算法：相对路径排序后连接 `path<TAB>SHA256(file-bytes)`，再对 UTF-8 记录流取 SHA-256）
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
| F36-01 · Windows definition bytes | `ManagedServiceSpec` 派生的 canonical UTF-16LE+BOM bytes，身份绑定 `serviceId + digest(bytes)` | 私有临时文件 fsync→rename→目录 fsync；`schtasks /Create` 后有限语义 query/read-back 全等 | 写入前后、rename 前后、`/Create` 效果/响应窗口、系统规范化、重启 | renderer/writer/adapter/reconciler；Windows Task Scheduler | 单份 bounded definition；本地同 bytes exact replay，系统异 principal/trigger/command fail-closed | 通过 |
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
| U36-01 | **P0/小，同根重开。** 真实 Windows `schtasks /Create /XML` 已证明原 canonical UTF-8 文件即使 XML 声明改为 UTF-8 仍被 Task Scheduler 拒绝；带 BOM、声明为 UTF-16 的 UTF-16LE 文件可成功注册。稳定身份是 `serviceId + canonical definition bytes`，耐久点是临时文件 fsync 后 rename/目录 fsync，OS 生效点是 `/Create` 成功及 query read-back。**价值裁决记录**：原方案错误假定 Task Scheduler 接受 UTF-8；C36-C31 是当前受支持 Windows 主路径的直接生产反证，满足原记录重开条件。新决定仍为 P0/小，只把 Windows 单一字节格式改为 UTF-16LE+BOM；macOS/Linux 保持原格式，不新增通用编码层。用户体验达标、架构达标。 | renderer 字符串、durable bytes、definition identity 与真实 Task Scheduler 消费格式未共享一个被系统接受的最终字节合同；测试只验证通用 XML parser，未穿过真实 `/Create`。 | **生产端**：Windows definition render/write、`schtasks /Create` 与 inspect。**类型组合**：空格/引号/XML 转义路径、UTF-16LE+BOM、首次/重复安装、写入/创建效果前后失败、响应丢失与重启。**消费者**：adapter、reconciler、current anchor/executor 启动链。**异常终态**：创建前稳定失败或重放永不收敛；系统 query 对账户/SID/default fields 的规范化不得误报 drift；其他平台格式不受影响。**测试/审查项**：最终 bytes 解码/解析、真实创建与语义 read-back；IR36-07、IR36-11、IR36-30、IR36-32～IR36-35。 | Windows renderer 声明 UTF-16，`managedServiceDefinitionBytes()` 唯一生成 BOM+UTF-16LE；durable writer、definition digest/比较和 `/Create` 共用该 bytes并原始回读全等。系统 query 只按冻结 spec 对 principal/trigger/Action、command/arguments 与 restart 设置作有限语义验真，容许 SID/域名/default field 规范化。验收覆盖转义、首次/exact replay、各响应窗口及真实 adapter 创建/read-back；同一 `serviceId` 不接受语义漂移。**实施证据**：真实 production adapter 已注册 UTF-16LE 任务并由系统 COM 回读同一 principal/trigger，测试 finally 清除任务。 | 已验证 |
| U36-02 | **P1/中。** Windows `disableManager()` 只执行 `/Change /DISABLE`，macOS 只执行 `launchctl disable`，但 `disable()` 随后要求 `running=false`；两条 supervisor 命令只禁止未来拉起，不终止当前实例，测试 fake 却同步改写 enabled/running。稳定身份是同一 `serviceId` 及其 platform domain，future-enabled 与 current-running 是两个独立 OS 事实；完成线性化点是二者分别回读为 disabled 与 not-running。**价值裁决记录**：保持现状或放宽 read-back 会留下旧 role/listener；现有 `/End`、`bootout` 足够，无需第 37 单元卸载或新 lifecycle。用户体验达标、架构达标。最终结论：保留 P1/中。 | adapter 把“禁止未来自动拉起”和“停止当前实例”误作一个 supervisor 状态转换，fake 又掩盖了真实双事实/双效果边界。 | **生产端**：Windows/macOS disable 与 Linux 既有 `disable --now`。**类型组合**：managed→on-demand/none、role/选择撤销、running/stopped/manager-absent、两步任一效果/响应丢失及连续重启。**消费者**：reconciler、current host、router/listener gate、公开状态。**异常终态**：旧 host 继续服务，或已经停止却因回读混合事实无法 exact replay。**测试/审查项**：真实 supervisor 双事实、幂等重放；IR36-07～IR36-08、IR36-11、IR36-20、IR36-30、IR36-32～IR36-34。 | 当前实例内的 trust/config 变化先关闭 gate，并只请求既有 graceful shutdown；响应丢失由 endpoint turnover/read-back 吸收。旧实例到安全点退出后，由配置重连或 supervisor 新实例的 managed preflight 调用同一 adapter：Windows `/Change /DISABLE`→必要 `/End`，macOS `disable`→必要 `bootout`，Linux `disable --now`，分别回读 future-enabled/current-running；已停/not-found exact replay，permission/unavailable fail-closed。验收覆盖两种降级目标、安全 blocker、同 mode 角色换代、各响应窗口和连续重启，零卸载/强杀。 | 已验证 |
| U36-03 | **P1/中。** `BoundPlatformMasterKeyProvider` 读到既有 backend binding 后仍调用 delegate 的 `loadOrCreate()`；DPAPI 与 machine-bound 在 backing file/seed 缺失时会写新值，Keychain/Secret Service 在 vault 不存在时也会创建，只有已有非空 vault 时才先行拒绝。稳定身份是 canonical home 的 durable backend binding 与该 backend 原 backing key；首次创建线性化点是 backing key 成功后原子写 binding，既有 binding 的打开不得产生写。**价值裁决记录**：原“可继续写入第二秘密上下文”被既有非空 vault 的认证门禁证伪，不恢复；但 bound existing-open 仍有可达创建副作用并把 missing/locked 混成 unavailable。用户体验达标、架构达标。最终结论：改写事实，保留 P1/中；仅新证据证明旧 vault 可被新 key 越过时重开原主张。 | provider 只有 create-capable 契约，未按“已有 binding/既有 store”与“无 binding 的首次 foreground 初始化”分离读取权限。 | **生产端**：`BoundPlatformMasterKeyProvider`、DPAPI/Keychain/Secret Service/machine-bound delegate 与 vault unlock。**类型组合**：binding 有/无、backing key 有/缺/歧义、vault 空/非空、managed/foreground、legacy binding 回填与重启。**消费者**：SecretStore、managed preflight、launch spec、公开 credentials 状态。**异常终态**：既有 binding 打开先改变 backing 事实再失败，或把可行动 locked 状态误报为普通不可用。**测试/审查项**：三平台 backend 与 machine-bound 的 existing-only 零写矩阵；IR36-06、IR36-28、IR36-32～IR36-33。 | 在现有 master-key provider 增加窄 `loadExisting()`：有 binding 时 foreground/managed 均只按绑定 backend 读取并验真原 key，missing/ambiguous 稳定映射 `credentials-locked` 且零创建/覆盖；无 binding 时，legacy store 只能 existing-only 成功后回填，只有确认 vault/key 均未初始化的首次 foreground 才可复用 `loadOrCreate()` 并原子写 binding，managed 永不创建。验收覆盖各 backend、空/非空 vault、legacy 回填、重启及写调用 exact-set，不新增第二 SecretStore 上下文或 lifecycle。 | 已验证 |
| U36-04 | **P2/小，同根重开（来源 P36-01）。** 原 U36-04 已验证 canonical-home single-worker dirty-loop、六类触发、三运行形态 gate 与 listener 前 plan/spec 复验；修复前源码证明，同 home 后继 caller 在旧 worker 运行中只置 dirty 并返回同一 promise，若旧迭代在 load/manager/apply 处拒绝，finally 删除 map 时该后继语义随旧 rejection 一并丢失。生产入口均使用不可取消 signal，失败可见且仍有 host-missing、managed preflight 或人工重试等既有重驱，故当前损失只是一次收敛延迟，不恢复旧 P0/P1、安全 gate 或专用 coordinator 主张。**价值裁决记录**：原结论为 P1/中并拟建立 worker generation/独立 waiter；生产事实排除了独立取消与无提示静默失效，新决定为 P2/小、一次有界 successor。重开条件：生产开始传入独立可取消 signal，或一次被吞 wake 可在无既有重驱时让失效角色继续公开服务。 | canonical home 是稳定 identity，map 中 worker/promise 是唯一共享并发事实；修复前实现只为成功循环保留 dirty，未规定“加入失败 worker 的 caller”在共享失败后的 successor 终态。首发 caller、加入者与新触发没有各自持久状态，问题不能用 generation/waiter 修补。 | **生产端**：pairing issuer/joiner、config、verified trust、managed preflight、host-missing 六类 trigger 与三运行形态。**直接变体**：首轮成功；load/manager/apply 失败；一个或多个后继 wake；同/异 home；持续失败；效果已发生但响应失败；进程重启。**消费者/终态**：原 caller 诚实收到原失败；加入旧 promise 的 caller 最多发起一次 current-input successor；同 home fallback 仍单飞、异 home 独立；第二轮仍失败则终止，不递归重试；gate/listener 既有零公开副作用边界不变。**测试/审查项**：IR36-12～IR36-13、IR36-20、IR36-29、IR36-30、IR36-34；C36-C06、F36-16～F36-18。 | 保留现有 map 与 single worker，把内部 join/start 增加一次性 retry budget：仅“加入既有 promise”的 caller 在共享 rejection 后，以自己的 current loader/adapter/signal 再进入一次且把 budget 置零；原 owner 直接返回原失败，多个 fallback 由 map 合并为恰一 successor，successor 失败不得再次 fallback。直接测试覆盖首轮三类失败+后继 trigger、多 joiner、持续失败、异 home、效果/响应丢失与重启，证明一轮 successor 上界、零并发第二效果且现有 gate/listener 不变；不新增 generation、waiter 或 lifecycle。 | 已验证 |
| U36-05 | **P1/小，同根重开（来源 P36-02）。** 原 U36-05 已验证 pure surface/empty 只经 current-anchor 认证有限 relay、设备本地/未知方法不代理且本机零 spawn/module/listener；修复前源码证明 `FirstPartyConversationMeshClient.#ensurePolling()` 把 connection id 映射到唯一 active controller，但 poll 拒绝后只上报错误，既不重试也不按 controller identity 清槽。动态 `MeshConnectionRegistry` 已允许同一 mesh client 在新 channel 上恢复，stale active 因而成为无新 dispatch 时永久停止通知的唯一根因。 | 稳定 identity 是 `{surface principal, connectionId, surfaceGeneration, current owner identity}`，`#active` 中 exact controller token 是唯一进程内事实；缺口是该 token 对 retryable transport/offline、fatal、close/dispose 与 owner 换代没有互斥终态。不得把它扩大成通用重连或新的 durable notification 协议。 | **生产端**：`CoreHostConnection` none 分支、`FirstPartyConversationMeshClient`、动态 mesh connection registry/current-authority resolver。**直接变体**：dispatch 前后断线、无新 dispatch 重连、连续 transient、current-owner 暂不可用、fatal 协议/认证错误、owner 换代、close/dispose、排队 notification。**消费者/终态**：`connection-closed`、`service-unavailable`、`request-timeout` 与 `RpcAppError(BUSY)` 保持同一 controller 并有界重试；自身 abort 正常退出；其他 mesh/RPC 错误为 fatal，同代原子清槽并上报；旧代完成不得清新代。target 尚未 drain 的队列在重连后继续交付；poll 响应已丢的 committed final/status 不另建 ack/outbox，继续由既有 last-seen revision/history 合同补读。**测试/审查项**：IR36-14、IR36-30、IR36-32、IR36-34～IR36-35；C36-C09、F36-19～F36-21。 | 让 active slot 保存私有 exact controller token，复用现有 `fulfillConnectionLifetimeObligation()`：把一次 poll request+notification drain 作为 attempt，`connectionClosed`/token abort 终止；仅上述四类 transient 由 helper 的 250ms→30s capped backoff 重试，每次成功响应后开始下一次 fresh helper 以重置退避。fatal 保存原错并只在 map 仍指向该 token 时移除 hook/slot和上报；close/dispose/owner 换代同样用 token guard，dispatch/重连不得启动第二 poll。直接测试穿过动态 registry attach/detach 与真实 relay queue，覆盖断线后无需新 dispatch 即恢复、连续 transient 无热循环、fatal、owner 换代、close/dispose及 stale completion；不新增公开 generation、通用重连框架或状态 DTO。 | 已验证 |
| U36-06 | **P1/中。** CLI 会读取 durable plan 与真实 adapter inspect，但 server 只按 `processMode` 推 desired 并硬编码 enabled/running/matches；共享 mapper 又不检查 `service.matches`，并在 desired 为 none 时先返回 not-needed，能遮蔽仍运行的旧 managed instance。因此同一 home 在 definition drift、配置关闭、旧实例仍活、manager 不可判定等场景会生成两套公开结论。稳定 snapshot identity 必须绑定同一次 current plan/spec 读取及对应 supervisor inspect/runtime readiness；它只是无副作用读模型，不能成为第二 durable 状态。**价值裁决记录**：保持现状会把不可持续恢复的实例明确误报为“可以使用”或“不需要后台运行”；现有 plan、inspect、process/readiness 足够，不需要状态框架。用户体验达标、架构达标。最终结论：保留 P1/中。 | CLI 与 server 各自拼装 desired/service/process/readiness，缺少一个从现有权威事实构成且拒绝混代的 managed-status snapshot 生产者；mapper 的 desired 快路又越过真实旧实例。 | **生产端**：launch plan/spec loader、adapter inspect、PID/health 与 runtime readiness、CLI/server status composition。**类型组合**：managed/on-demand/none、match/drift、配置关闭、旧实例、running/stopped/stale、ready/recovering/degraded/stopping/failed、manager permission/unavailable及读取中换代。**消费者**：同一个 public mapper、CLI human 输出和 server DTO。**异常终态**：入口分叉、混合代际或伪 ready/not-needed；公开面仍不得泄漏路径、service/device/role/raw error。**测试/审查项**：有限组合表与 CLI/server exact DTO；IR36-25～IR36-26、IR36-30、IR36-32、IR36-34～IR36-35。 | 抽取唯一无副作用 `ManagedHostStatusSnapshot` builder：从同一 current load 派生 plan/spec，读取真实 inspect 与现有 process/readiness，结束前复验 plan/spec identity，漂移则有界重读或返回非 ready，绝不拼混；CLI/server 只把该 snapshot 交给同一 mapper，server 删除硬编码事实。mapper 仅在 desired none/on-demand 且没有不应存在的 managed instance/关闭中进程时返回 not-needed，`matches=false` 与 U36-10 不可判定错误映射有限稳定 action。验收为两入口 exact keys/value 全等，覆盖关闭/漂移/旧实例/manager/readiness/换代且零新持久状态、零 raw 信息。 | 已验证 |
| U36-10 | **P0/小，同根重开（来源 P36-03、C36-C30）。** 原 U36-10 已闭合 start 对既有有限 classifier 的旁路；真实中文 Windows 进一步证明所有 `schtasks` 调用的本地化 stderr 被 UTF-8 解码为乱码，首次 inspect 无法识别 documented not-found，因而在 `/Create` 前稳定失败。`schtasks /HRESULT` 提供不依赖消息语言的数值退出码 `0x80070002/0x80070005`。**价值裁决记录**：原 P2/小只覆盖 start 行动；C36-C30 满足“分类错误使受支持启动路径不可恢复”的正式重开条件，当前损失升级为 Windows 首次安装阻断，故改写为 P0/小。最小方案仍只复用现有 classifier，不改 status DTO 或引入平台错误框架；用户体验达标、架构达标。 | 稳定 identity 是 platform domain/serviceId 与单次 manager command result；Windows classifier 依赖错误文本而 runner 固定按 UTF-8 解码本地代码页，导致同一 OS 错误事实在非英文 locale 下不可判定。 | **生产端**：Windows query/create/change/end/run 全命令及三平台既有 start/inspect 分类。**直接变体**：HRESULT not-found/permission、manager/session unavailable、其他非零、spawn、效果/响应丢失与 post-inspect。**消费者/终态**：只有 `0x80070002` 授权 absent，`0x80070005`→permission-required，其余不可判定→manager-unavailable；start documented not-found 仍为 command-failed；raw stderr 不外泄。失败不写 definition、不改 snapshot/DTO，效果丢响应由后继 inspect 收敛。**测试/审查项**：IR36-07、IR36-11、IR36-30、IR36-33；C36-C04/C36-C30、F36-22～F36-23。 | 所有 Windows Task Scheduler command 只经现有窄 helper追加 `/HRESULT`，classifier 优先按 unsigned numeric HRESULT 判 `0x80070002/0x80070005`，保留既有三平台文本/exit fallback；start 仍复用 `requireCommand()` 并独立 post-inspect。验收覆盖乱码 stderr、两 HRESULT、其他非零/spawn、首次 install、各效果窗口，证明只有确定 not-found 授权 absent且零额外副作用。**实施证据**：production runner 已取得数值 HRESULT，真实首次 adapter inspect→create→query 通过，相关四条 Windows 直接测试通过。 | 已验证 |
| U36-11 | **P1/小。** `ManagedServiceSpec` 已持有稳定 `osUser`，`serviceId` 也绑定该值，但 Windows canonical definition 只输出 `<LogonType>InteractiveToken</LogonType>`，principal 与当前用户 `LogonTrigger` 均缺 `<UserId>`，Action 仅按 principal id 间接引用一个未绑定用户的上下文；Task Scheduler 的 principal 合同要求 `UserId` 与 `LogonType` 共同确定运行身份，trigger 的 `UserId` 才把登录唤醒限定到同一用户。**价值裁决记录**：原结论为 P0/小；官方合同足以证明当前 definition 没有完整绑定稳定用户，但缺少真实 `/Create` 证据证明所有受支持 Windows 环境必然失败，P0 举证不足。新决定为 P1/小、降级；保持现状会留下明确的注册或错误 principal 风险，复用现有 renderer 是最小完整修复，用户体验达标、架构达标。重开 P0 条件：真实 Task Scheduler 注册/read-back 证明主路径必然失败或落到错误 principal。 | `ManagedServiceSpec.osUser`→canonical definition bytes 的唯一投影遗漏 principal/trigger 用户字段，使 service identity、Task Scheduler principal、登录 trigger 与 Action context 没有共享同一稳定 OS 用户身份。 | **生产端**：`buildManagedServiceSpec()`、Windows renderer、durable writer、definition digest、`schtasks /Create` 与 inspect/read-back。**类型组合**：普通及 XML 需转义用户名，principal/trigger 同值或错值/缺值，首次与 exact replay，`/Create` 效果/响应丢失、系统规范化回读与重启。**消费者**：reconciler、managed current anchor/executor 的当前用户登录拉起。**异常终态**：任务注册被拒、任意用户登录触发，或不能证明 Action 以冻结用户运行；macOS/Linux 不受影响。**测试/审查项**：IR36-05、IR36-07、IR36-11、IR36-28、IR36-30、IR36-32～IR36-35。 | 仅改现有 Windows renderer：对同一 `spec.osUser` XML-escape 一次，分别写入 `Principal/UserId` 与 `LogonTrigger/UserId`，`Actions Context` 继续引用该 Principal；definition identity、writer、比较和 `/Create` 只消费同一 canonical UTF-16LE+BOM bytes。直接测试从最终 bytes strict parse 后断言 principal/trigger/UserId、LogonType 与 Action context 全等，覆盖转义、首次、exact replay、效果/响应丢失和错误/缺失 UserId；真实 Windows adapter 注册后按系统语义回读同一 principal/trigger 即完成，不新增 renderer、账户解析或平台框架。**实施证据**：renderer 已把同一 `spec.osUser` 写入两处 `UserId`；最终 bytes 转义/系统 XML parse 与 production adapter 真注册、COM read-back 均通过。 | 已验证 |
| U36-12 | **P1/小。** 配置已耐久提交后，`config-command.ts` 先等待 active turn，再在同一 `try` 中 `await requestHostReload()`，随后才在 `launchSelectionChanged` 时触发 `local-role-config-committed` reconcile；reload 在发送前失败或效果后丢响应都会直接进入 catch，因此独立的 supervisor 收敛义务未执行。**价值裁决记录**：原结论为 P1/小；对立复核排除了保持现状和修正规则，因为 reload 失败不保证旧实例退出或新 preflight 必然发生，新增框架又无比例性。新决定为保留 P1/小；复用现有 reconcile 并修正控制流即可同时满足用户体验和架构。删除条件：生产 reload API 获得“失败也保证旧实例退出且新 preflight 必然 reconcile”的原子合同。 | 配置提交后的“重载当前 host”与“按最新 launch selection 收敛 supervisor”是两个有序但独立终结的义务，实现却用前者成功作为后者的控制流前置条件。 | **生产端**：本机角色/executor 自动上线配置耐久提交、active-turn 边界、host reload 与 `local-role-config-committed` reconcile。**类型组合**：选择未变/变化；reload 发送前失败、效果后丢响应、成功；reconcile 成功/失败及四种组合；连续重启。**消费者**：current host、supervisor、role gate、executor 自动上线/下线与配置反馈。**异常终态**：耐久配置已变但旧实例/supervisor 按旧选择运行，或任一失败被另一结果遮蔽，直到不确定的后继 trigger。**测试/审查项**：IR36-04、IR36-12、IR36-20、IR36-24、IR36-30、IR36-32、IR36-34～IR36-35。 | 保留“配置已落盘→等待 active turn→reload→reconcile”的次序，在本命令内抽取窄的提交后效果收束点：独立捕获 reload outcome；仅当 launch selection 变化时，无论 reload outcome 如何都恰好调用一次现有 reconcile；再统一投影两项 outcome，任一失败不得输出“已重启”成功，选择未变不得触发 reconcile。通过可注入的两生产调用直接测试 reload 三窗口×reconcile 成败、active-turn 顺序与连续调用；不新增触发、耐久状态或 lifecycle 框架即完成。**实施证据**：提交后窄收束点已按 reload→reconcile 顺序分别捕获 outcome；selection 变化时四种成功/失败组合均执行一次 reconcile，selection 未变零 reconcile，7 条直接测试、S7 顺序门禁与同指纹四路对抗通过。 | 已验证 |
| U36-13 | **P1/中。** `loadCurrentManagedServiceState()` 同时承担 status inspect 与启动/reconcile activation：它先冻结 binding，再用当前进程形态创建 store 并调用 `unlockState()`；fresh empty home 的 foreground status 会经 `loadOrCreate()` 写 backing key/binding，legacy store existing-only 成功回填 binding 后局部快照仍是 `undefined`，managed expected-backend 又会在允许的回填前拒绝。**价值裁决记录**：原结论为 P1/中；“status 创建文件”单独只支持 P2，但同根还使受支持 legacy 用户首次登录/开机恢复稳定失败，因此 P1 必要。保持现状或只改文案无法恢复首启，复用 existing-only 与同次重读是最小完整修复，无需第二 SecretStore 框架。新决定为保留 P1/中，用户体验达标、架构达标。降级/删除条件：legacy 无 binding 明确退出支持范围，且 status 被明确改为允许副作用的产品命令。 | 一个 loader 混合了只读 inspect/projection 与可创建、可回填的 activation intent；binding 是唯一耐久事实却在 activation 改变后未重读，导致 spec/trust/admission 使用跨代快照。 | **生产端**：current-state loader、`BoundPlatformMasterKeyProvider`、foreground/managed SecretStore、legacy binding 回填与纯 launch-plan projection。**类型组合**：fresh/legacy/bound；四 backend 的 binding/backing/vault 有无、锁定与歧义；managed/foreground、expected backend、回填前后、效果/响应丢失和重启。**消费者 exact-set**：inspect 仅 `buildManagedHostStatusSnapshot()`（CLI/server 同源）；activation 为 reconcile、managed preflight/wait、admission capture/verify 与 trust transition。**异常终态**：状态查询暗中初始化秘密；legacy 首次 managed 启动在同次得不到 spec；公开状态与准入混用不同 binding generation。**测试/审查项**：IR36-06、IR36-17、IR36-25～IR36-26、IR36-28、IR36-30、IR36-32～IR36-35。 | 给现有 loader 增加必填 `inspect|activate` 意图并共用一个只接受最终 `{config,binding,key,trust}` 的纯 projection。status snapshot 固定用 inspect：无 binding 不打开 store并稳定返回既有 credentials 行动，有 binding 只 existing-only，缺 backing/歧义均零写。其余 exact-set 固定用 activate：既有错误 binding 先拒；无 binding 时仅复用现有 legacy/首次-foreground 许可，managed fresh empty 仍零写；unlock 成功后重读 binding、再校验 expected backend并同次构造 spec/trust/admission。真实临时 home 覆盖 fresh inspect 零文件、四 backend bound existing-only、legacy inspect 零回填、managed/foreground activation 回填与响应丢失、错误 backend和重启；不新增第二事实源、SecretStore API/lifecycle 或状态 DTO。**实施证据**：loader 已强制区分 `inspect|activate`，status 唯一走 inspect，其余 reconcile/preflight/admission/trust exact-set 走 activate；真实临时 home 证明 fresh inspect 零 SecretStore 写、legacy 只在 activation 同次回填并重投影、错误 backend 零改写，10 条直接测试、25/25 消费闭包、S7 exact-set 与同指纹四路对抗通过。 | 已验证 |

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
| EX36-04 | **原主张（R36-02）**：外部 reconcile 的合并式 disable 会绕过 gate/safe-point，应按 P1/中拆分三平台 future/current stop。**已验证事实**：配置入口先等待 active turn 并请求宿主 graceful reload；进程内 trust 变化先 `refuseNewMessages()`，`runServer.shutdown()` 等待 CleanupRegistry；managed preflight 尚未开放 listener；pairing target 尚无既有 serving role；有 endpoint 但不响应的旧 host 走 `runStopCommand(respectBlockers)`。只有假设 serving host 正在工作但全部发现事实同时消失，host-missing 才会直接 disable，当前没有受支持生产路径可达该状态。 | adapter 合并 future/current 只是实现形态，不能单独证明 accepted/in-flight work 被绕过；当前支持入口均已有 active-turn、graceful、未开放 listener 或 blocker 边界。删除该问题，不建设三平台 lifecycle 拆分；没有确定未来交付义务。 | 第 36 单元全量独立重审及对立价值裁决；提交 `5b1802f7`，产品指纹 `sha256:ecc94ed506544667799d2dbe43322195ccdb2470e82ad0129ed2ce5472ac6ed0`；IR36-08、IR36-11、IR36-20、IR36-30 的生产入口对账。 | 新生产事实证明某个受支持入口能在同一 serving instance 存在 accepted/in-flight work，且未经过 active-turn、graceful 或 blocker 事实时调用 `adapter.disable()`。 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | ---------------------- | -------- | ---------------------------- | --------------------- |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| C36-C01 | UTF-16 声明、BOM+UTF-16LE 最终 bytes、转义与 `/Create`/语义 read-back 必须闭合 | Windows definition/adapter 直接合同 | renderer/writer/adapter/tests | 本轮重开修复后 / 小 / 直接4项+真实OS | production原始bytes、系统XML parse、真实Task Scheduler注册/COM身份回读与exact replay通过；测试清理同一task | `product:ca2748bc; win:4/4+real` | 有效 |
| C36-C02 | managed→none/on-demand 必须先关 gate/到安全点，再独立收束 future-enabled/current-running | 三平台 disable、runtime trust/config 与 blocker 直接场景 | adapter/reconciler/runtime/tests | 修复后 / 中 / CLI 定向总集内 | Windows `/End`、macOS `bootout`、Linux `disable --now` 及双 read-back/安全顺序通过 | `product:397ef1dd; cli:75/75` | 有效 |
| C36-C03 | 既有 binding 在四 backend、vault 空/非空与 legacy 回填下必须 existing-only 零写 | secrets existing-only 矩阵与类型检查 | provider/vault/tests | 修复后 / 中 / 6.6s | 四 backend existing-only/managed/legacy 19/19，secrets typecheck 通过 | `product:397ef1dd; secrets:19/19` | 有效 |
| C36-C04 | permission/manager unavailable 不得折为 absent 或先写 definition | 三平台 finite classification/零副作用 | runner/adapter/tests | 本轮重开补证 / 小 / 既有17项+Windows4项 | 三平台start仍共用classifier并独立inspect；Windows全部Task Scheduler命令追加`/HRESULT`，乱码stderr下仅数值not-found授权absent，真实首次安装通过且失败零definition/absent/status副作用 | `product:ca2748bc; adapter:17/17; win:4/4+real` | 有效 |
| C36-C05 | drift、旧实例、desired 降级及读取中换代不得被 ready/not-needed 快路遮蔽 | snapshot/mapper/CLI/server exact DTO | cli/server status/tests | 修复后 / 中 / 直接集 | CLI snapshot/mapper 10/10、server DTO 8/8，server typecheck 通过 | `product:397ef1dd; status:18/18` | 有效 |
| C36-C06 | binding 前后并发 wake 必须同 canonical home 单 worker，后继 wake 不丢 | reconciler dirty-loop 与同/异 home 场景 | reconciler/tests | 修复后 / 小 / 11 个直接测试 | load/manager/apply 首轮失败后的一个或多个 joiner 只形成同 home 恰一 successor；持续失败有界终止，异 home 独立，效果丢响应以 read-back 收敛 | `product:ecc94ed5; reconciler:11/11` | 有效 |
| C36-C07 | 三进程形态在 listener 窗口及同 mode trust/role 换代时必须拒旧 identity | admission snapshot、trust callback、runServer gate | runtime/command/tests | 修复后 / 中 / 7.48s增量 | 启动前复验与运行中 full identity 复验 7/7；旧代先 refuse 再 graceful shutdown | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C08 | surface/empty 本机零 spawn/listen，canonical method 只命中 current anchor | CoreHostConnection、surface relay、mesh direct tests | connection/mesh/tests | 修复后 / 中 / CLI 定向总集内 | core-host 31、surface 2、mesh 5 用例均通过；local/unknown 方法稳定拒绝 | `product:397ef1dd; surface:38/38` | 有效 |
| C36-C09 | owner/trust 换代、离线与 dispose 后旧 relay/poll 必须收束且不回退 | surface generation/notification 场景 | surface link/tests | 修复后 / 小 / 8+4 个直接测试 | exact controller token 穿过真实动态 registry/relay queue，在三个 mesh transient 与 BUSY 后无新 dispatch 恢复；fatal、close、换代和 stale completion 不误删新代，既有 surface/helper 交界 4/4 | `product:ecc94ed5; relay:8/8; edge:4/4` | 有效 |
| C36-C10 | EX36-01～EX36-03 与第37～38边界不得因修复被恢复 | 冻结 diff、规格、S7 与排除记录对账 | 28 文件交付闭包 | 冻结后 / 小 / 只读 | 30 文件产品闭包未新增 runner、诊断、pairing 事务、coordinator、公开 generation/waiter、状态 DTO 或 Unit37～38 生产能力；EX36-01～EX36-03 重开条件均未满足 | `product:ecc94ed5; s7:19/19` | 有效 |
| C36-C11 | 冷启动对抗发现：trust/role generation 改变但 launch mode 仍为 managed 时，旧实现只比较 mode，会保留旧角色装配 | U36-04 同根修复：启动冻结 `ManagedHostAdmissionSnapshot`，运行中按 full current identity 复验，不同代际先关 gate 再 graceful shutdown | runtime/command/test | 对抗发现后 / 小 / 7.48s | 修复后同 mode trustEpoch/chainHead/roles 变化直接用例与三形态门禁 7/7 通过；重新执行 S7/build 并冻结新指纹 | `product:397ef1dd; runtime:7/7` | 有效 |
| C36-C12 | 最终源码必须由同一输入成功构建且差异卫生无异常 | workspace build、S7/golden、`git diff --check` | 12 文件本轮产品输入 | 冻结前 / 中 / CLI build 1.1s | 最终CLI build成功；S7 19/19+golden、consumer closure 25/25与diff-check通过。CLI typecheck仅复现8个既有credentials `version`基线错误，未命中本轮文件 | `product:ca2748bc; cli-build:success; s7:19/19; closure:25/25` | 有效 |

> 最新独立审查曾使 C36-C04、C36-C06、C36-C09 失效；本轮同指纹修复与直接证据已使三行重新有效。下列七项专项矩阵只保留旧 `product:397ef1dd` 历史，三项当前结论以 F36-16～F36-24、修复后四路矩阵及 `product:ecc94ed5` 证据为准。

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

## 独立审查覆盖表

> 本表只记录独立审查覆盖进度，执行规则见工作台静态区“独立功能审查”。本表按失效机制划分，禁止照抄审查结论复用表；必须常设跨区组合核查行。状态只允许“待审”“审查中”“已覆盖”“失效”“有问题”。

| 编号 | 风险区与风险面 | 登记输入与指纹 | 独立覆盖状态 | 结论与证据 | 重开条件 |
| ---- | -------------- | -------------- | ------------ | ---------- | -------- |

<!-- registration-complete: unit-36.gen-1 -->
