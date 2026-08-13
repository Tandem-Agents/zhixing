## 审查清单

### 当前状态

- **当前单元**：第 37 单元 · generation 1
- **单元身份**：S10 三路径停机、设备移除与值班设备永久卸载；只交付临时停机、executor 移除、current anchor 安全永久卸载三条互斥且可重放的生命周期路径。
- **权威来源**：always-online-and-local-execution-requirements.md、distributed-runtime-charter.md、specification.md、s2-security-supply-chain-review.md，已定稿 D37-01～D37-09，以及第 30～36 单元已封版的 AuthorityTransfer、current-owner/trust、checkpoint、SecretStore、accepted-work、资源治理、managed supervisor 与 exact endpoint 合同。
- **交付基线**：当前工作树中的 Unit37 完整生产实现、直接测试、字段级规格回填、S7 descriptor 与 registry golden；历史问题、开发过程和既有通过记录不得替代本轮独立判断。
- **生产装配关系**：同一 device-lifecycle 判别协议写入承担路径的既有物理 AuthorityCommitLog；server.shutdown 经本机 lifecycle adapter 进入 HostStopCoordinator，device.list/remove/status/continue 经 current-anchor 管理面进入 current issuer 与 target 两根 removal runtime，server.uninstall.* 固定 loopback 进入 AnchorUninstallCoordinator。普通启动在公开准入前读取 authority/executor 两根 lifecycle journal，恢复未终态 gate，并拒绝 removed/retired 身份复活；cleanup 复用 existing storage governor、managed-service exact unregister、SecretStore exact delete 与既有安全停机链。
- **目标提交边界**：strict lifecycle DTO/codec/reducer/journal；stop 三策略及 exact host generation；executor 本地域 authority transfer 或显式销毁、accepted-work 收束、撤销/暴露/清退；失控设备诚实远端撤销；anchor migration 或双次真实 recovery checkpoint 安全卸载；启动恢复、产品入口、隐私文案、S7/registry 与直接证据。
- **明确排除**：Unit38 升级、schema/protocol 兼容门、包下载/替换、健康门禁、自动回滚、发布矩阵、支持包与仓库级最终 CI；自动 failover、quorum/witness、多 active anchor、全局/持续同步、灾难恢复应用、远程擦除、外部安装器删除 executable/package、通用 lifecycle/迁移/存储/事务/事件总线/registry、新 runner、监控、诊断、benchmark 或信息采集。
- **架构空洞判定**：总纲 §10～§15、规格 §1～§12 与 §15 第 37 行/字段级协议、D37-01～D37-09 已唯一确定产品行为、稳定身份、阶段顺序、取消边界、恢复终态、体验和后继隔离；无须以实现假设补齐且会改变产品结果的真实架构空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1；[~] 输入变化须重审。

> **清单状态**：0 项 `[ ]`、40 项 `[x]`、0 项 `[!]`、0 项 `[~]`；12个生产实现受影响节点已完成独立重审及反向价值裁决，封版时又对shutdown直接测试合同影响的IR37-33/IR37-36/IR37-37/IR37-40独立复审。上一轮把内部`ServeOptions.host/port`测试接缝误当作用户可达配置；真实产品入口只传`managed`，两根均使用固定loopback host与按home确定的非零端口，故P37-21已删除且不构成当前阻断。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| --- | --- | --- |
| requirements §一 | 适用 | 持续在线与真实本机执行归入 IR37-01、IR37-07～IR37-12、IR37-13～IR37-34。 |
| requirements §二 | 不适用 | 外部产品回复整理不产生知行字段、状态或门禁。 |
| requirements §三 | 不适用 | 外部事实核验不替代当前生命周期合同。 |
| requirements §四 | 不适用 | 架构审核过程的最终裁决已进入总纲与规格。 |
| requirements §五 | 不适用 | 外部现状归纳不形成当前实现义务。 |
| requirements §六 | 适用 | 单机/多设备平权、真实环境留在设备、隐藏拓扑归入 IR37-01、IR37-13、IR37-26～IR37-34。 |
| requirements §七 | 适用 | 最小完整产品、单机零额外代价、后台停止真实性归入IR37-01、IR37-07～IR37-12、IR37-35、IR37-39。 |
| requirements §八 | 适用（前置） | planned migration readiness、唯一设备名、取消/只前滚和零术语归入 IR37-27～IR37-34。 |
| charter 当前版本交付原则 | 适用 | 最小完整范围、架构优先和禁止预建归入 IR37-01、IR37-36～IR37-40。 |
| charter 一 | 适用 | 单一产品、单机/分布式平权与current anchor归入IR37-01、IR37-33～IR37-35。 |
| charter 二 | 适用 | 持久在线、完整本机执行与拓扑隐藏需求归入IR37-07～IR37-12、IR37-13～IR37-34。 |
| charter 三 | 适用 | 角色、owner、包依赖、协议与产品基线由§1～§15逐节判定如下。 |
| charter §1 | 适用 | 唯一 current anchor、同一 owner/端口归入 IR37-01、IR37-03～IR37-05、IR37-34。 |
| charter §2 | 适用 | anchor/executor/surface 角色与 lifecycle 主体归入 IR37-03、IR37-13、IR37-25～IR37-34。 |
| charter §3 | 适用 | core/server/CLI 单向依赖与无第二组合根归入 IR37-02、IR37-05、IR37-35、IR37-39～IR37-40。 |
| charter §4 | 适用 | 认证身份、issuer、revoke、pairwise secret、失控边界归入 IR37-13、IR37-19～IR37-26、IR37-37。 |
| charter §5 | 适用 | 本地域/锚点域 owner 与六类 authority 处置归入 IR37-15～IR37-22、IR37-28～IR37-31。 |
| charter §6 | 适用 | accepted work、assignment/lease/outbox 收束归入 IR37-09～IR37-10、IR37-20、IR37-36。 |
| charter §7 | 适用 | 本机环境 authority、清退与路由阻断归入 IR37-16～IR37-25。 |
| charter §8 | 适用 | final/delivery/outbox 最终性与断线重放归入 IR37-09～IR37-10、IR37-20～IR37-23、IR37-36。 |
| charter §9 | 适用 | 本地域 conversation exact-set transfer/delete 归入 IR37-15～IR37-19。 |
| charter §10 | 适用（核心） | 三条 lifecycle 路径、撤销/暴露、SecretStore 与服务清退全部规范性条款归入 F37-01～F37-08、IR37-02～IR37-34。 |
| charter §11 | 适用 | 零术语、唯一设备名、可行动状态与诚实告知归入 IR37-13、IR37-26～IR37-34。 |
| charter §12 | 适用 | AuthorityTransfer中断、设备撤销、磁盘满、响应丢失、旧owner/endpoint与重启的适用行归入F37-06、IR37-12、IR37-19、IR37-23、IR37-26、IR37-31、IR37-36；其他前置故障行只作IR37-39兼容。 |
| charter §12.1 | 适用 | 真解封、完整 checkpoint、独立目标、final checkpoint 归入 IR37-27、IR37-29～IR37-31。 |
| charter §13 | 适用 | 唯一权威、terminal、秘密、资源和准入不变量归入 IR37-02～IR37-06、IR37-35～IR37-40。 |
| charter §14 | 适用 | 36～38 顺序与不得提前发布升级归入 IR37-01、IR37-39。 |
| charter §15 | 适用 | 三路径验收、结构不变量和有限故障证据归入 F37-01～F37-08、IR37-35～IR37-40；性能观测不作门禁。 |
| specification §1.1 | 适用 | operation/request/home/device/epoch、时间与重放身份归入IR37-02～IR37-04、IR37-36。 |
| specification §1.2 | 适用 | canonical bytes、digest、签名域与引用绑定归入IR37-02、IR37-06、IR37-21、IR37-37。 |
| specification §1.3、§1.3b | 适用（兼容） | 所有外部符号仍来自权威包，新增lifecycle符号只有一个正式导出，归入IR37-02、IR37-39。 |
| specification §1.4 | 适用（兼容） | 总纲构件名与代码落点必须一一对应，归入IR37-01、IR37-35、IR37-39。 |
| specification §1.5 | 适用 | stable code/action、无raw error与公开错误形态归入IR37-12、IR37-33～IR37-34。 |
| specification §2.1 | 适用 | current issuer、trust ancestor/member generation、revoke与后继身份归入IR37-14、IR37-19～IR37-23、IR37-26～IR37-28、IR37-30、IR37-32、IR37-37。 |
| specification §2.2 | 适用（收束） | capability/lease/票据的现有激活与撤销合同归入IR37-08～IR37-10、IR37-20、IR37-22、IR37-37～IR37-38。 |
| specification §2.3 | 适用 | SecretStore existing-only、exact delete与秘密不迁移归入IR37-24～IR37-25、IR37-31～IR37-32、IR37-37。 |
| specification §2.4 | 适用（核心） | active exposure→compromised、外部账号行动与atomic publication归入IR37-21、IR37-26、IR37-30～IR37-31。 |
| specification §2.5 | 适用 | 认证mesh、current-owner与有限target/issuer服务归入IR37-14～IR37-15、IR37-20、IR37-22～IR37-23、IR37-33、IR37-35、IR37-37。 |
| specification §3.1 | 适用 | conversation owner/freeze/delete/transfer归入IR37-08～IR37-10、IR37-16～IR37-19。 |
| specification §3.2 | 适用（边界） | global authority只由current anchor处置，归入IR37-21、IR37-28～IR37-31、IR37-35。 |
| specification §3.2b | 适用 | DeferredGlobalIntent随本地conversation冻结、转移或删除，归入IR37-09、IR37-16～IR37-18。 |
| specification §3.3 | 适用 | 环境事实只在本地清退且永不转移/备份，归入IR37-24、IR37-29～IR37-31、IR37-37。 |
| specification §3.4 | 适用 | lease/permit收束与停止准入归入IR37-09～IR37-10、IR37-20、IR37-38。 |
| specification §3.4b | 适用 | storage governor/arbiter的cleanup与stop边界归入IR37-06、IR37-10、IR37-24、IR37-38。 |
| specification §3.5 | 适用（收束） | completion/reviewer既有accepted work归入IR37-09、IR37-20、IR37-36。 |
| specification §3.6 | 适用（收束） | executor在途工作与安全停止归入IR37-09～IR37-11、IR37-20、IR37-36。 |
| specification §3.7 | 适用（收束） | submission/usage/final的accepted终态归入IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §3.8 | 适用 | host/current-anchor/surface principal 与逐方法 guard 归入 IR37-07、IR37-13、IR37-27、IR37-33、IR37-37。 |
| specification §4.1 | 适用（核心） | 唯一 AuthorityCommitLog、stream transaction/replay 归入 IR37-03～IR37-05、IR37-21、IR37-30。 |
| specification §4.2 | 适用 | ArtifactStore 与 evidence roots 归入 IR37-06、IR37-16～IR37-18、IR37-29～IR37-31。 |
| specification §4.3 | 适用 | session/assignment/intent/final/outbox/exposure/trust/checkpoint 流归入 IR37-09～IR37-10、IR37-15～IR37-24、IR37-29～IR37-31。 |
| specification §4.4 | 适用 | revoke+exposure+lifecycle 与 retirement 原子 envelope 归入 IR37-05、IR37-21、IR37-30。 |
| specification §4.5 | 适用 | lifecycle ArtifactRef retention/GC 归入 IR37-06、IR37-24、IR37-31。 |
| specification §5.1 | 适用 | shutdown/device/uninstall控制请求的认证、幂等与错误形态归入IR37-07、IR37-13～IR37-15、IR37-27、IR37-33。 |
| specification §5.2 | 适用（收束） | fresh dispatch关闭与既有assignment收束归入IR37-08～IR37-10、IR37-14、IR37-22、IR37-36。 |
| specification §5.3 | 适用（收束） | capability/version匹配、撤销与旧peer拒绝归入IR37-22、IR37-37、IR37-39。 |
| specification §5.4 | 适用（核心） | transfer/delete/revoke/retirement/checkpoint提交的CAS与原子性归入IR37-17～IR37-21、IR37-28～IR37-31、IR37-36。 |
| specification §5.5 | 适用（收束） | final/outbox/terminal重放归入IR37-09～IR37-10、IR37-20～IR37-23、IR37-36。 |
| specification §5.6 | 适用（收束） | run stream的accepted work安全点归入IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §5.7 | 适用 | cancel、abort、设备失控与止损归入IR37-19～IR37-26、IR37-37。 |
| specification §6.1、§6.2、§6.2b | 适用（收束） | conversation/job/system accepted-work 停止与取消归入 IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §6.3 | 适用（核心） | AuthorityTransfer freeze/import/commit/abort/terminal 归入 IR37-15、IR37-17、IR37-19、IR37-28。 |
| specification §6.4 | 适用（核心） | device active/revoked、uncertain、terminal replay 归入 IR37-19～IR37-26。 |
| specification §7 | 适用（核心） | 六类 authority 的 transfer/delete/preserve/backup 六个枚举行逐项归入 F37-04～F37-05、IR37-16～IR37-18、IR37-28～IR37-31。 |
| specification §8 | 适用 | device 四入口、shutdown、uninstall 五入口及 target/issuer 两服务的唯一落点归入 F37-02、IR37-07、IR37-13～IR37-15、IR37-27、IR37-33～IR37-35。 |
| specification §9 | 适用（边界） | anchor/local capability 不因 lifecycle 绕过归入 IR37-15～IR37-22、IR37-35、IR37-37。 |
| specification §10、§10.1 | 适用 | governor/storage maintenance/permit/锁序归入 IR37-10、IR37-20、IR37-24、IR37-38。 |
| specification §11 | 适用 | stop/removal/lost/uninstall 产品旅程归入 IR37-12、IR37-13、IR37-26～IR37-34。 |
| specification §12 | 适用 | 不变量到机械验收映射归入 IR37-02～IR37-06、IR37-35～IR37-40。 |
| specification §13 | 适用 | core/server/cli/resources/scripts 文档影响归入 IR37-35、IR37-39～IR37-40。 |
| specification §14 | 不适用（新增功能） | S1开工清单已封版；仅在IR37-39检查兼容。 |
| specification §15 第1～36、38行 | 不适用（新增功能） | 已封版前置或Unit38；只作为IR37-39兼容/越界边界。 |
| specification §15 第 37 行及字段级 DeviceLifecycleRecord | 适用（核心） | 三路径 identity/phase/abort、八类 evidence、two-root 与入口 ownership 枚举行逐项归入 F37-01～F37-07、IR37-02～IR37-36。 |
| S2 范围说明与裁决 | 适用（兼容） | 不新增依赖，不改变证书/PAKE用途，归入 IR37-37、IR37-39～IR37-40。 |
| S2 强制门禁 | 适用（兼容） | 精确锁版、owner、PAKE 非生产隔离、package import/export 归入 IR37-37、IR37-39～IR37-40。 |
| S2 接受依据 | 适用（兼容） | TLS/证书/PAKE与秘密暴露面不得扩张，归入 IR37-22、IR37-26、IR37-37。 |
| verification-runbook.md | 不适用（功能范围） | 仅约束后续验证命令和运行方式；当次测试/构建结果只作各审查项证据，不建立独立功能项。 |
| development workbench 静态规则 | 不适用（功能范围） | 只约束开发清单维护与架构空洞裁决；Unit37 功能边界由 D37-01～D37-09 承载。 |
| D37-01 | 适用 | protocol/journal/identity/phase/abort/retention 归入 IR37-02～IR37-06。 |
| D37-02 | 适用 | stop 三策略与 exact host 归入 IR37-07～IR37-12。 |
| D37-03 | 适用 | effect-free preflight、issuer accepted、target gate、冻结 exact-set、漂移重显与 decision 归入 IR37-13～IR37-16、IR37-19～IR37-20。 |
| D37-04 | 适用 | transfer/destroy/abort/settlement 归入 IR37-16～IR37-18。 |
| D37-05 | 适用 | issuer selector/authority-change guard、signed ready、原子 revoke/exposure、窄历史终态重放、route/secret 归入 IR37-14、IR37-20～IR37-23。 |
| D37-06 | 适用 | target terminal、cleanup、supervisor、key-last 与删除注册前后恢复归入 IR37-23～IR37-25、IR37-32。 |
| D37-07 | 适用 | 同 operation 的 reachable→lost 选择、远端撤销与诚实未知归入 IR37-26。 |
| D37-08 | 适用 | anchor preflight、migration 后旧设备移除、两次真实 checkpoint、retirement/final exact-set 归入 IR37-27～IR37-31。 |
| D37-09 | 适用 | pre-runtime recovery、入口所有权、S7 exact-set 与各项直接证据归入 IR37-32～IR37-40。 |
| Unit36 正式账本与归档清单 | 不适用（新增功能） | 仅证明上游 supervisor 封版；交界兼容归入 IR37-11、IR37-25、IR37-39。 |

### 当前交付物与审查落点

| 交付分组 | 当前文件 | 审查落点 |
| --- | --- | --- |
| lifecycle protocol/codec | core/protocol/device-lifecycle.ts、device-lifecycle.test.ts 及 barrel | IR37-02～IR37-04、IR37-19、IR37-21、IR37-36～IR37-37 |
| lifecycle journal/stream/retention | core/authority/device-lifecycle-journal.ts、对应测试、commit-log.ts 及 barrel | IR37-03～IR37-06、IR37-21、IR37-30～IR37-32、IR37-36 |
| stop production chain/evidence | cli/serve/host-stop-lifecycle.ts、stop.ts、command.ts；server context/lifecycle/server RPC；三组直接测试 | IR37-07～IR37-12、IR37-32～IR37-36 |
| removal issuer/target/mesh | device-removal.ts、device-removal-mesh.ts、mesh-runtime-assembly.ts、executor-role-runtime.ts 及直接测试 | IR37-13～IR37-23、IR37-26、IR37-35～IR37-38 |
| local authority freeze | local-conversation-owner.ts 及 lifecycle 测试 | IR37-15～IR37-20、IR37-36～IR37-38 |
| local cleanup/supervisor/resources | device-removal-cleanup.ts、managed-service.ts、storage-maintenance.ts 及测试 | IR37-23～IR37-25、IR37-31～IR37-32、IR37-38～IR37-39 |
| removal CLI/RPC | runtime/device-removal-command.ts、facade、CLI index、server registry/methods 及测试 | IR37-13、IR37-26、IR37-33～IR37-35、IR37-40 |
| anchor uninstall production/evidence | cli/serve/anchor-uninstall.ts、command.ts；runtime command/facade；CLI/server 入口及直接测试 | IR37-27～IR37-36、IR37-38～IR37-40 |
| pre-runtime recovery | mesh-runtime-bootstrap.ts 及测试 | IR37-23～IR37-25、IR37-31～IR37-36、IR37-39 |
| registry/S7 | canonical-registry golden、s7-entry-coverage.mjs 及测试 | IR37-33、IR37-35、IR37-39～IR37-40 |
| specification/development checklist | specification.md、unit-development-workbench.md | 来源覆盖、IR37-01～IR37-40 |
| Unit36 archive | unit-review-checklists/distributed-runtime/unit-36.gen-1.md | 仅保存上单元原动态区，不作为 Unit37 功能证据 |

### 固定范围矩阵

| 编号 | 有限闭包 | 固定内容 |
| --- | --- | --- |
| F37-01 | 三路径状态机 | stop：accepted→gate-closed→work-settled→flushed→ready-to-stop→terminal；removal：accepted→gate-frozen→authority-decided→authority-settled→revocation-ready→revoked→cleanup-complete→terminal；uninstall migration：accepted→gate-frozen→transfer-committed→cleanup-complete→terminal；uninstall backup：accepted→gate-frozen→checkpoint-verified→retirement-decided→gate-closed→work-settled→flushed→final-checkpoint-verified→cleanup-complete→terminal。stop 不可 abort；removal 在 authority-settled 前、uninstall 在 transfer-committed/retirement-decided 前可 authenticated abort。 |
| F37-02 | 公开/远端入口 exact-set | current-anchor：device.list/remove/status/continue；本机：OS signal、CLI stop/uninstall 与 loopback server.shutdown、server.uninstall.preflight/begin/continue/cancel/status；有限认证 mesh：device.removal.target 的 accept/decide/status/abort 与 device.removal.issuer 的 accept-self/ready/terminal。 |
| F37-03 | 生产根与形态 | stop：managed/on-demand/foreground；removal issuer：current anchor 恰一；removal target：anchor+executor 与 executor-only 两根；uninstall：current anchor 的 migration/backup 两路；surface/empty/disabled 不装配 lifecycle owner。 |
| F37-04 | accepted-work 与本地 owner exact-set | current/frozen/importing conversation；active run/interaction；pending final/assignment；DeferredGlobalIntent；RunFinalOutbox/delivery outbox；remote/channel/scheduler/delivery obligation；lease、permit 与 managed instance。 |
| F37-05 | authority/cleanup exact-set | 权威六类：全局状态与期望配置、会话状态、会话内容资产、环境事实与本地秘密、执行资产、非权威缓存；cleanup 仅限 frozen home 的 provider/channel/MCP/rendezvous/transfer candidate/device secret、workspace/environment binding、projection/staging/reservation/artifact/cache，排除用户 workspace、其他 home、独立 checkpoint target 与最小非秘密 terminal/tombstone。 |
| F37-06 | 故障与竞态切点 | accept 前/后；F37-01 每次 phase sync 前/后；transfer/delete/revoke/retirement/checkpoint/supervisor unregister/key delete/stop 的效果前、效果后响应前；同/异 identity 并发；cancel 与首个不可逆事实竞争；坏尾、缺/坏 ref、网络/manager/磁盘/容量失败；连续两次重启与迟到旧 owner/endpoint 请求。 |
| F37-07 | lifecycle evidence kind exact-set | accepted-work、authority-transfer、authority-deletion、trust-event、credential-exposure、checkpoint、supervisor、cleanup；含 ArtifactRef 的证据在 terminal transaction 继续声明 candidate reference。 |
| F37-08 | 可复核直接证据分组 | codec/reducer/journal/retention；stop coordinator/CLI/RPC/supervisor；local owner/removal issuer-target/mesh/cleanup；uninstall migration/backup/CLI/RPC；pre-runtime non-resurrection；canonical registry 与 S7 结构 exact-set。每个功能项只使用对应现有测试和结构证据，不另设 build/test 结果项。 |

### 审查项

> U37-01修复改变的12个节点已全部独立重审并完成价值裁决：同一生产endpoint上的早期bind、closed recovery、逐phase前滚与同对象activate成立；非默认host竞争只可由内部函数参数/测试构造，当前CLI、managed definition与权威配置均无该用户入口。12项无P0/P1，统一标为`[x]`；其余28项继续复用。

| 编号 | 状态 | 审查对象 | 独立通过条件与可复核证据 |
| --- | --- | --- | --- |
| IR37-01 | [x] | 单元身份与有限边界 | 本轮独立重审：当前差异只补第37单元既有stop operation逐phase successor恢复和`server.shutdown`方法级错误投影；实现复用既有journal、artifact、owner ports、`RpcAppError`与生产根，未引入独立恢复计划、通用错误框架或Unit38能力。来源补充与实现边界一致，无P0/P1范围问题。 |
| IR37-02 | [x] | strict lifecycle DTO/codec | `device-lifecycle` identity/record/decision/evidence 继续 exact-key、version、phase 与签名严格解码；新增 backup `gate-closed→work-settled→flushed` 顺序已进入 reducer，delivery `lifecycleBinding` 亦在 replay 前 strict decode owner/id/revision exact-set。未发现非规范输入可越过 codec。 |
| IR37-03 | [x] | stable identity 与 subject 单飞 | stop identity现必含`localDeviceId`，reducer在`home+host`外同时占用`home+device`；removal/uninstall占同一本机device subject，三路径durable accept恰一。`DeviceLifecycleJournal.active()`对双subject去重，settle/seal/release只消费调用参数中的exact operationId，已删除进程级可变owner。 |
| IR37-04 | [x] | phase/abort/terminal reducer | stop、removal、migration 与 recovery-backup 的合法相邻 phase、不可逆点、abort/terminal 幂等和冲突拒绝均由同一 reducer 固定；新 backup closure phase 顺序与规格一致，未发现跳 phase 或 terminal 回退。 |
| IR37-05 | [x] | 唯一物理日志与 transaction | 本轮独立重审：stop identity、phase、artifact与terminal仍只来自同一本机`AuthorityCommitLog`；`startupLifecycle`、`alreadySettled`及delivery admission均由该耐久事实派生，root-local release只消费exact operation且进程重启会重新投影，不形成第二耐久事实源。未发现无日志决定或跨日志提交，结论无P0/P1。 |
| IR37-06 | [x] | evidence retention/GC | stop accepted-work artifact由 `gate-closed` evidence 保留；backup retirement transaction 同 envelope 写 artifact evidence 并声明 candidate reference，后继 phase/terminal candidateReferences 继续保留。缺失、错 digest、非 canonical 或歧义 artifact 均在 settlement/checkpoint/cleanup 前拒绝，普通无引用 artifact 仍按现有 GC。 |
| IR37-07 | [x] | stop 入口与本机授权 | 价值裁决后重审：公开`serve`入口只传`managed`，不接受host/port；anchor/executor生产根均使用`DEFAULT_SERVER_CONFIG.host`与同一`homeToPort(home)`，因此同home竞争实际落在同一endpoint，早期inactive bind的EADDRINUSE loser在owner效果前退出。内部参数构造异host不属于受支持产品入口，无P0/P1。 |
| IR37-08 | [x] | stop gate | 价值裁决后重审：受支持生产endpoint只有一个OS winner；winner内`recoverAcceptedWork=false`已覆盖local readiness/lifecycle projection及mesh/worker恢复，旧host proof前零accepted-work owner效果。上一轮双host前提不可由产品入口到达，故closed gate合同通过。 |
| IR37-09 | [x] | stop 三策略 accepted-work | 价值裁决后重审：同一生产endpoint单飞成立，三策略按同一frozen `id/revision`逐owner settle/read-back；`accepted/gate-closed/work-settled/flushed/ready-to-stop`仅补各自未完成步骤，响应丢失重放不重复已耐久效果。无P0/P1。 |
| IR37-10 | [x] | flush 与资源安全点 | 价值裁决后重审：唯一生产winner下coordinator由durable phase保证`work-settled`只补flush、`flushed`只补physical，journal前外部效果由各port exact read-back吸收；异host双执行者不是受支持场景，未发现独立flush/资源阻断。 |
| IR37-11 | [x] | exact host stop/future preservation | 价值裁决后重审：当前产品本机lifecycle endpoint的host固定为loopback，port按home确定，故`StopEndpointLock`的port与bound handle足以判别当前受支持endpoint；PID/startTime/startedAt区分generation，managed链另验definition/manager。为内部不可达host参数扩充耐久DTO没有当前价值，无P0/P1。 |
| IR37-12 | [x] | stop 故障恢复 | 价值裁决后重审：真实非零固定endpoint竞争、inactive HTTP/WS、同对象activate、winner崩溃后OS释放及五phase恢复已有直接证据；异host同port虽可由OS建立，但CLI/managed产品入口不能生成该组合，不能据此判定当前恢复失败。 |
| IR37-13 | [x] | removal effect-free preflight 与名称体验 | current issuer 先耐久 accepted/selector guard，reachable target 随后只读 local owner 与 external owner 投影并外置 preflight；此时尚未关闭本地域 gate、未 transfer/delete/revoke。用户决定前返回冻结名称/数量；离线路径明确投影 local data unknown，不伪造空集已清理。 |
| IR37-14 | [x] | issuer accepted 与 lifecycle guard | issuer accepted identity 冻结 target member public key/device-key generation、issuer 与 trust ancestor；同 subject 单飞及 current-authority guard 在 target 效果前生效，成员换代、竞争 operation、非 current issuer 与错误名称均零后续副作用。 |
| IR37-15 | [x] | target 两根 accepted/gate | target lifecycle与启动扫描都使用`bootstrapStore.authorityLog()`；两种生产装配均先恢复local active operation，再以closed参数启动mesh/local conversation/job/channel/delivery。decision前关闭local+external gate并重采完整ownerItems，artifact未形成时保持全部producer关闭，形成后只恢复同operation exact work。 |
| IR37-16 | [x] | local authority/work exact-set 与决策复验 | effect-free preflight与关gate后的snapshot作digest全等复验，变化则释放gate并重显；decision artifact耐久完整十owner `id/revision`。delivery source映射保留`local:`/`relay:` namespace，conversation/final/scheduler各消费自身稳定revision，authority逐项exact核验而不代填，same-id successor零append。 |
| IR37-17 | [x] | removal transfer | transfer只消费decision中的conversation及十owner exact-set：复用既有AuthorityTransfer提交/tombstone，随后local owner与external ports逐项settle/read-back；delivery先安装冻结source、恢复causal work、seal并drain至terminal，全部归零后才写`authority-settled/revocation-ready`。响应丢失重放原decision与原transfer身份。 |
| IR37-18 | [x] | irreversible destroy | destroy决定与冻结snapshot artifact同一operation耐久后才执行；local owner按同一conversation exact-set收束run/intent/final并写删除/tombstone，external及delivery继续按同一ownerItems settlement。首个不可逆点后只能重放原mode/target，未全量read-back不得进入ready。 |
| IR37-19 | [x] | cancel/irreversible race | signed abort与`authority-decided`由同一journal恰一胜出；durable aborted先授权同operation gate释放，absent幂等、异operation拒绝，再hydrate原`target-aborted` receipt；ready胜出保持原ready，连续重启不回退。 |
| IR37-20 | [x] | target work/resource ready | local owner、remote/channel/scheduler/delivery与lease/permit均来自同一decision ownerItems；每个port校验operation及frozen `id/revision`，完成settle后独立read-back，delivery包含迟到causal item且drain至terminal，governor在写ready前完成安全协调。任一缺项、换代、未终结或响应不明均保持gate与原phase。 |
| IR37-21 | [x] | revoke/exposure/lifecycle atomicity | issuer 在同一 `AuthorityCommitLog.transactProjection()` 内重验 accepted trust ancestor与 target generation，并原子追加 revoke trust event、全部 active exposure→compromised 及 lifecycle `revoked`；无关 trust 前进保留祖先身份，竞争换代 fail-closed。 |
| IR37-22 | [x] | route/capability/secret closure | revoke transaction 可见后 current trust 立即使 resolver/inventory/capability/fresh dispatch拒绝目标并断开普通服务；issuer rendezvous ref按 exact target删除，删除失败在同 revoked operation 重放，后继 member generation 由 accepted guard隔离。 |
| IR37-23 | [x] | narrow historical terminal replay | revoked peer只经独立terminal-only registry进入ready/cleanup-ready/target-aborted/terminal四方法；每个方法先做exact-key/version与accepted target身份反绑，普通service admission不放宽。aborted重放先完成exact gate release，再复用同一签名receipt。 |
| IR37-24 | [x] | local cleanup exact-set | cleanup roots为代码内冻结的 current-home 子路径并逐项 `assertOwnedPath`；walker每个 governor step最多处理128个dirent，secret按稳定顺序每128项删除/read-back，排除用户workspace、其他home、checkpoint target、device key与最小 lifecycle log。 |
| IR37-25 | [x] | supervisor/key-last/process exit | target先完成文件/非device-key secret清理与 exact supervisor unregister，再耐久 cleanup-ready；issuer terminal返回后才 compare-delete冻结 device-key，随后写本机terminal并走安全自退出。错slot拒绝删除，pre-runtime resumer在角色/key/listener前续做未终结本机清退。 |
| IR37-26 | [x] | reachable/offline lost同一终态 | lost是issuer日志中的显式不可逆选择：只提交本端 revoke/exposure与 `localData=unknown` cleanup/terminal，不生成 target ready/cleanup 事实；迟到设备仍是 revoked 且只能进入 terminal-only 通道，公开结果持续说明本地数据不可达。 |
| IR37-27 | [x] | uninstall preflight/local-only | 五个 `server.uninstall.*` 方法均经 loopback guard；preflight只读 active lifecycle、ready migration target 与真实 checkpoint status，缺少安全路径时零 accepted/零 gate，begin 才冻结 home/current device/epoch/trust 与选定 target generation。 |
| IR37-28 | [x] | migration uninstall | migration在`accepted`后关闭公开及十owner producer gate，冻结canonical accepted-work artifact并安装exact delivery admission；逐owner以drain语义settle/read-back、刷稳日志与物理步骤后才调用既有planned transfer并全等验证新owner，随后进入`transfer-committed→cleanup`。重启按artifact/phase恢复原admission与sealed，零新source窗口。 |
| IR37-29 | [x] | first recovery checkpoint | `force(pre-retirement)`后 coordinator 直接调用同一 checkpoint service 的 `verify(checkpointId,recoveryRoot)`；service从冻结 target read package、用用户 recovery root真解封，严格核验issuer/home/root/manifest/catalog/retained闭包并写耐久 verification，非 status 自报。 |
| IR37-30 | [x] | retirement/final checkpoint | recovery-backup先真解封验证pre-checkpoint；确认时在同一transaction反绑十owner artifact与retirement decision。逐项immediate安全settlement/read-back后写`flushed`，从该lifecycle record真实LSN取水位，final checkpoint用同root真解封且要求`upToLsn>=flushedLsn`；startup按phase恢复sealed，未通过不得cleanup。 |
| IR37-31 | [x] | uninstall cleanup/terminal | migration与backup均先完成各自accepted-work闭包再进入cleanup。cleanup只遍历冻结current-home roots，walker与SecretStore按128固定批次、governor前滚；随后exact supervisor unregister、非device-key秘密、cleanup-complete/ready、issuer terminal、exact device-key compare-delete、本机terminal与安全退出，错slot/错home零误删。 |
| IR37-32 | [x] | pre-runtime recovery/non-resurrection | 价值裁决后重审：两根均先scan/strict hydrate再争用同一生产endpoint，只有winner可恢复原phase；terminal/exact release后才激活，崩溃后继重新读耐久事实。内部异host参数不是启动入口，当前non-resurrection无P0/P1。 |
| IR37-33 | [x] | RPC/CLI/mesh ownership与隐私 | 封版独立复审：生产实现、方法级测试与真实dispatcher测试对同一`INTERNAL_ERROR/安全停机未完成/{action:retry-same-request}`全等，内部`delivery flush failed`不再被直接测试当作公共合同；失败零trigger。router认证、loopback/strict params、既有`RpcAppError`和其他RPC/mesh授权未变，零raw内部身份泄漏，无P0/P1。 |
| IR37-34 | [x] | complete product journeys | 价值裁决后重审：用户可达停机、自动/显式重启均使用同一loopback home endpoint；恢复期间稳定503，terminal/release后原对象激活并发布ready，连续接替唯一前滚。异host双入口不是产品旅程，无P0/P1。 |
| IR37-35 | [x] | production roots/profile exact-set | 价值裁决后重审：anchor/executor及managed/on-demand/foreground均接收同一公开options集合；实际入口不提供host/port，故两根固定为loopback+home派生端口，并共享早期bind/后期activate结构。内部类型接缝不扩大生产profile exact-set。 |
| IR37-36 | [x] | fixed fault/recovery matrix | 封版独立复审：F37-64～F37-69仍由同一非零loopback home endpoint覆盖；shutdown普通异常的直接测试现已验证固定wire投影及零trigger，不再期待raw错误。两个既有环境基线均在当前单元断言前失败且有独立归因，必要证据与当前范围成比例。 |
| IR37-37 | [x] | security/secrets/isolation | 封版独立复审：shutdown普通异常在方法边界被替换为固定错误，修正后的直接测试明确拒绝原message泄漏；stack、operation/device/path均不进入wire，既有`RpcAppError`仅保留已支持公开行动。stop successor未新增secret读取、跨home路径、远端授权或公开拓扑字段，无P0/P1安全或隔离问题。 |
| IR37-38 | [x] | resource/cancel/lock order | 价值裁决后重审：受支持生产endpoint上同一handle贯穿bind/activate/close，anchor rollback与executor finally均关闭handle，失主由OS释放；三策略/cancel锁序不变。不存在用户可达的跨host双handle，资源与锁序无P0/P1。 |
| IR37-39 | [x] | layering/compat/Unit38 boundary | 本轮独立重审：依赖方向仍是core lifecycle/delivery原语→CLI生产装配与server公开投影，未新增跨包反向依赖、通用恢复/错误框架、新runner、升级/替换/回滚或发布能力；第30～36单元既有owner、delivery、supervisor接口只被组合使用。当前阻断是Unit37内部启动仲裁缺口，不是分层或Unit38越界，故本项无P0/P1。 |
| IR37-40 | [x] | registry/S7 与证据充分性 | 封版独立复审：30个Vitest入口取得355项Unit37相关通过证据，S7 20/20与golden沿未变输入复用；shutdown陈旧断言已修正并定向3/3，两个既有环境基线分别有历史归属和失败点证据，不以其冒充当前通过或阻断。真实双进程端点证据、两根顺序合同与当前范围仍充分。 |

---

## P0/P1 阻断问题列表

> 本表只保留尚未转入正式问题清单的待解决问题；表为空仅表示尚无已审发现。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- | --- |

### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| --- | --- | --- | --- |
| P37-21 | P0/中：把不同host同port可并行listen视为受支持stop successor，并要求扩充`StopEndpointLock`与两根owner谓词。 | OS反例本身成立，但举证前提不成立：公开`zhixing serve`只接受`managed/managed-home/managed-secret-backend`，调用`runServeCommand()`时仅传`managed`；权威配置没有本机lifecycle server host/port项，两根生产根因此始终使用固定`127.0.0.1`和同一`homeToPort(home)`。`ServeOptions.host/port`仅是未暴露的内部/测试接缝，generic server的可配置host也不装配Unit37 stop lifecycle。上一轮以F37-70验收文字和内部类型存在性代替了当前用户可达性。保持现状的用户损失为零；扩耐久DTO和故障矩阵只会增加无价值复杂度。 | 删除，无确定未来交付义务；同步把12项恢复为`[x]`并将F37-70理解收窄为“生产根使用同一已解析非零endpoint，受控测试覆盖不得改变产品范围”。仅当公开CLI、managed definition或权威配置新增本机lifecycle host/port，或生产调用图实际向两根传入不同host时重开。用户体验达标：当前本机loopback单飞、恢复与安全停机不受影响。架构达标：复用现有OS endpoint owner，不为不可达组合扩充协议或新锁。 |

## 非阻断级问题列表

> 本表只保留尚未转入正式问题清单的问题。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |

> **独立审查结论**：通过。当前40项全部为`[x]`，零`[!]`/`[~]`/`[ ]`；封版测试合同变化影响的4项已在新冻结输入上独立复审，P0/P1与非阻断级问题列表均为空。P37-21经反向价值裁决删除并进入“已删除问题的价值裁决记录”，其重开条件当前未满足；本轮没有待转存的当前问题。
