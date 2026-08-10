## 审查清单

### 当前状态

- **当前单元**：第 34 单元 · generation 1
- **单元身份**：S9 planned anchor 迁居；只支持用户从 current anchor 主动迁往另一台已配对、active、启用 anchor 角色且 ReadyProof 就绪的设备。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D34-01～D34-08；上游只消费第 33 单元 current verified full recovery checkpoint、唯一 `AuthorityCommitLog` / `ArtifactStore` / storage governor、S2 trust/mesh/SecretStore 合同，下游只为第 35 单元保留已提交 authority/trust 基线，不提前实现灾难恢复。
- **交付基线**：以第 33 单元封版提交 `735a3dcd4996f5f7dfd4902eb8cf7ea6115fe596` 为基线，第 34 单元当前完整交付为 74 个非工作台路径，按排序后的 `path<TAB>file-sha256` 清单冻结内容指纹 `daa82f4b2419ac172a6a464c7d7e3d61a3b36cb5ca8d61f87ffecc352b6ef9c0`；U34-04/U34-09 最新修复的 23 路径专项指纹 `7f9ba3badb9c1558d0b2d2b93ebb0f456d8b667d0b11aced53d9747f54d6269a` 是其受影响子集。工作台文件不参与功能指纹。
- **生产装配关系**：anchor+executor 与 anchor-only/current-anchor 两个生产组合根复用同一 authority log、artifact store、device storage governor、trust/mesh 与 checkpoint owner，动态装配恰一 planned source/recovery owner；合格的 non-current active anchor 只可暴露有限 readiness/strict transfer receiver，首条 `prepared` 才把迁居耐久状态、私有 staging 与 recovery 义务绑定到唯一 target。executor-only、surface、disabled、非 anchor 设备及未被选中的候选零 source owner、零非终态迁居事实；目标提交成功后新 issuer/current anchor/authority base 同步生效，旧 source 永久 fenced。
- **目标提交边界**：交付 strict planned transfer 合同、ReadyProof 与 transfer-bound issuer key、source 准入关闭和在途收束、独立 planned export/AuthorityCatalog/SourceFreezeProof、target 私有导入、唯一 AnchorTransferCommit、双端恢复与 forward-only、CLI/server 值班设备迁居入口、两生产根 exact-set/S7 与成比例直接证据。
- **明确排除**：第 35 单元 source-less/disaster recovery、恢复应用、`domain-reset`、pending-reenroll、凭据轮换与恢复旅程；第 36～38 单元托管服务、移除/卸载、升级发布；anchor 自动故障转移、quorum/witness、多目标/云、连续全局同步；环境事实、SecretStore 内容、workspace 原始路径、设备缓存与非权威缓存；第二事实源、通用迁移/路由/存储/事务/outbox/事件总线/registry、监控、诊断、benchmark 或信息采集。
- **当前任务进度**：本轮完成 19 项 `[~]` 受影响范围审查，17 项既有 `[x]` 直接复用且未重复审查；36 项现均为 `[x]`，两个问题列表为空。其后同一完整交付指纹已完成两轮零新增冻结终审、独立功能审查登记与单元提交验证，第 34 单元已封版。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：0 项 `[ ]`、36 项 `[x]`、0 项 `[!]`、0 项 `[~]`；P0/P1 阻断问题列表与非阻断级问题列表均为空，EX34-01 继续排除。当前完整交付指纹 `daa82f4b2419ac172a6a464c7d7e3d61a3b36cb5ca8d61f87ffecc352b6ef9c0` 上独立审查、两轮冻结终审与单元提交验证均通过，第 34 单元已封版。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线值班设备与本机真实工作设备并存的核心目标归入 IR34-01、IR34-23、IR34-31。 |
| 需求文档 §二 | 不适用 | 外部回复的信息整理是需求形成材料，不独立产生第 34 单元合同。 |
| 需求文档 §三 | 不适用 | 对历史实现的核验不是当前迁居字段、状态或验收要求。 |
| 需求文档 §四 | 不适用 | 历史架构审核过程不替代现行总纲与规格。 |
| 需求文档 §五 | 不适用 | 历史现状归纳不产生当前交付义务。 |
| 需求文档 §六 | 适用 | “值班设备可切换、干活设备保留真实环境”的用户目标归入 IR34-03、IR34-23、IR34-31。 |
| 需求文档 §七 | 适用 | 当前产品价值、最小完整范围与体验优先级归入 IR34-01、IR34-31、IR34-35。 |
| 需求文档 §八 | 适用 | 目标列表、可行动 readiness 缺口、准备/收束/传输/接管阶段、切换前取消、失败后继续及零内部术语逐条归入 IR34-03、IR34-20～IR34-21、IR34-31。 |
| s2-security-supply-chain-review.md 范围说明 | 适用（兼容边界） | 当前交付改动 `@zhixing/mesh` 的 package export/build；评审只约束其既有四项受管依赖，不得借本单元宣称仓库级供应链结论，归入 IR34-32。 |
| s2-security-supply-chain-review.md「裁决」 | 适用（兼容边界） | 当前交付修改 `@zhixing/mesh` export/build 并复用既有密码与连接面，须确认三项生产依赖和受控 PAKE 开发依赖用途边界不漂移，归入 IR34-30、IR34-32。 |
| S2 供应链评审「强制门禁」 | 适用（兼容边界） | 精确锁版、依赖 owner、PAKE 非生产隔离及既有 supply-chain gate 不得因新 mesh 子入口被绕过，归入 IR34-32～IR34-33。 |
| S2 供应链评审「接受依据」 | 适用（兼容边界） | planned transfer 不新增密码依赖、不改变 TLS/证书/PAKE 实时边界，归入 IR34-05、IR34-30、IR34-32。 |
| distributed-runtime-charter.md「当前版本交付原则」 | 适用 | 最小完整产品、锁定范围内最优架构与禁止未来框架预建归入 IR34-01、IR34-35～IR34-36。 |
| 总纲「一、架构概况」 | 适用 | 单一产品、唯一 current anchor、单机/分布式同构及恢复能力归入 IR34-01、IR34-23、IR34-28。 |
| 总纲「二、凝练后的需求点」 | 适用 | 值班/干活角色、跨机一致体验与可信迁居归入 IR34-03、IR34-23、IR34-31。 |
| 总纲 §1 架构结论 | 适用 | current anchor 唯一权威、设备间同一协议内核与不造第二路径归入 IR34-17～IR34-19、IR34-23。 |
| 总纲 §2 角色模型 | 适用 | anchor/executor/surface 角色与 enabled/disabled topology exact-set 归入 IR34-03、IR34-28。 |
| 总纲 §3 包与依赖边界 | 适用 | core/mesh/owner-kernel/server/cli 分层、无环依赖与组合根职责归入 IR34-28、IR34-32、IR34-36。 |
| 总纲 §4 设备网格与安全协议 | 适用 | trust generation、签发者、设备认证、签名和旧 issuer 拒绝归入 IR34-02～IR34-05、IR34-25、IR34-30。 |
| 总纲 §5 权威矩阵与执行清单 | 适用 | 全局域随 anchor 迁居、会话/执行/资产/义务完整覆盖归入 IR34-11～IR34-12、IR34-18、IR34-24。 |
| 总纲 §6 run 派发协议 | 适用（上游边界） | 不重审既有 run 协议；只审 fresh 准入关闭、已接受 run/job/interaction/final/delivery 的可证明终态和迁后重建，归入 IR34-08～IR34-09、IR34-24。 |
| 总纲 §7 环境模型与路由 | 适用（负边界） | 环境事实、workspace 原始路径和本机能力不得进入 catalog/wire，迁后只按目标本地配置重建，归入 IR34-11、IR34-30。 |
| 总纲 §8 双平面通信 | 适用（传输边界） | mesh 只换传输路径、不成为权威；断连/重连/重投保持同一 transfer 身份，归入 IR34-05、IR34-14、IR34-21、IR34-27。 |
| 总纲 §9 离线本地会话、收编与迁居 | 适用（直接） | planned AuthorityTransfer 全状态、ReadyProof、SourceFreezeProof、AuthorityCatalog、TrustTransition、唯一 commit、abort/forward-only 与 owner/receiver exact-set 归入 IR34-02～IR34-29。 |
| 总纲 §10 凭据与服务生命周期 | 适用（有限） | ReadyProof 的 SecretStore unlocked/服务 revision 和 transfer issuer key 生命周期直接适用；第 36～38 单元服务托管/卸载不适用，归入 IR34-03～IR34-04、IR34-19、IR34-35。 |
| 总纲 §11 产品体验设计 | 适用 | 用户只见“值班设备”、目标缺口、阶段、取消/继续和诚实终态，归入 IR34-31。 |
| 总纲 §12 故障矩阵 | 适用（逐个相关故障） | 迁居任意步中断、旧锚点/旧 epoch、磁盘满、网络分区、响应丢失、版本偏斜和时钟边界归入 IR34-09、IR34-13～IR34-29、IR34-34。 |
| 总纲 §12.1 S9 恢复根与备份状态边界 | 适用（上游窄接缝） | 迁居前只取得 current verified full checkpoint；不得改写 Unit 33 envelope/readiness/retention，归入 IR34-07、IR34-32、IR34-35。 |
| 总纲 §13 不变量清单 | 适用 | 唯一权威、旧 epoch 永拒、同 envelope 原子性、秘密隔离、资源治理、零未启用 owner 等相关不变量归入 IR34-08～IR34-30、IR34-34。 |
| 总纲 §14 实施序列 | 适用（Unit 34） | S9 Unit 34 全部适用；Unit 35 disaster recovery 与 Unit 36～38 明确不适用，归入 IR34-01、IR34-35。 |
| 总纲 §15 验收纲 | 适用 | 正常、边界、故障、恢复、对抗、双拓扑与零认知旅程的成比例证据归入 IR34-33～IR34-34。 |
| specification.md §1.1 | 适用 | requestId/transferId/deviceId、anchor/trust epoch 与时间有效期归入 IR34-02～IR34-03、IR34-27。 |
| 规格 §1.2 | 适用 | JCS、schema/version、digest/signature 域及 freeze/transition/ready/catalog/checkpoint 引用逐项归入 IR34-02、IR34-10～IR34-17、IR34-27。 |
| 规格 §1.3 | 适用（兼容边界） | 外部符号仍从权威包消费，禁止复制或改造上游合同，归入 IR34-32。 |
| 规格 §1.3b | 不适用 | S1 新建符号清单已交付，且本章没有 planned anchor transfer 新符号；现有符号兼容由规格 §1.3 与 IR34-32 承载，不从本章恢复字段设计。 |
| 规格 §1.4 | 适用 | `AnchorTransferCommit`、TrustTransition 等总纲名与字段级合同必须全等，归入 IR34-02、IR34-17～IR34-19。 |
| 规格 §1.5 | 适用 | stable/transient/conflict/unauthorized 等内部结果须在公开面映射为稳定可行动错误，归入 IR34-27、IR34-31。 |
| 规格 §2.1 | 适用 | `HomeTrustEvent/Record`、planned `AnchorTransferCommit` 与 `SourceFreezeProof` 的严格联合、签发者、epoch 和链头归入 IR34-02、IR34-04、IR34-16～IR34-19、IR34-25。 |
| 规格 §2.2 | 适用（上游边界） | 活跃 capability/lease/ticket 是待收束/迁移义务；不得由迁居伪造、放宽或另建凭证，归入 IR34-09、IR34-24、IR34-30。 |
| 规格 §2.3 | 适用 | transfer issuer 私钥只入 SecretStore，锁定/删除/激活/重放均不出 wire，归入 IR34-04、IR34-30。 |
| 规格 §2.4 | 不适用 | 凭据暴露记录属于设备撤销收束，不是 planned migration 交付；凭据轮换禁入本单元的依据来自总纲/规格 Unit 35 边界，由 IR34-35 承载。 |
| 规格 §2.5 | 适用（复用边界） | 只复用生产 mesh bootstrap、认证连接与 negotiated service；不新建连接/中继体系，归入 IR34-05、IR34-25、IR34-28、IR34-32。 |
| 规格 §3.1 | 适用（权威覆盖） | SessionState 写在 source fence 后不得 fresh append，既有会话权威事实须完整迁移并在 target 恢复，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.2 | 适用（权威覆盖） | GlobalState 写在 source fence 后不得 fresh append，既有全局权威事实须完整迁移并在 target 恢复，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.2b | 适用（权威覆盖） | DeferredIntent 的已接受/未终态事实须进入 catalog 并按原身份在 target 恢复，fresh intent 受 source fence，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.8 | 适用（安全边界） | 会话、全局状态及 control guard 必须在 fresh 写与迁后公开准入前维持身份、owner 与权限约束，归入 IR34-08、IR34-22、IR34-30。 |
| 规格 §3.3 | 适用（负边界） | EnvironmentPort 与原始本地路径不迁移，归入 IR34-11、IR34-30。 |
| 规格 §3.4 | 适用（上游终态边界） | 业务 ResourceLease 协议不改型；现有 active/queued/settled/reclaimed 身份只作为 accepted work 收束与迁后 pending 恢复输入，归入 IR34-09、IR34-24。 |
| 规格 §3.4b | 适用 | checkpoint/export/staging/import 每个物理步骤使用现有设备 storage governor，等待可取消且 permit 不跨网络/锁，归入 IR34-13、IR34-29。 |
| 规格 §3.5 | 适用（上游终态边界） | control/reviewer 的已接受 completion 只作为 drain 与可恢复 pending 输入，不新建迁居端口，归入 IR34-09、IR34-24。 |
| 规格 §3.6 | 适用（上游终态边界） | executor dispatch/commit/final 的已接受义务必须可判定收束或按原身份迁移，归入 IR34-09、IR34-24。 |
| 规格 §3.7 | 适用（上游终态边界） | submission/mirror 的已接受义务必须可判定收束或按原身份迁移，不改变既有协议，归入 IR34-09、IR34-24。 |
| 规格 §4.1 | 适用 | 唯一 `AuthorityCommitLog`、同 envelope/单次 sync、投影重建、source prefix 与 append fence 归入 IR34-06、IR34-10～IR34-12、IR34-17～IR34-19、IR34-26。 |
| 规格 §4.2 | 适用 | artifact 先耐久后引用、retained closure、私有 staging、共享 CAS 提升和缺件拒绝归入 IR34-11～IR34-15。 |
| 规格 §4.3 | 适用 | planned transfer records、trust/current-anchor/install/progress 事实必须 strict、单调、可重放，归入 IR34-02、IR34-06、IR34-14～IR34-27。 |
| 规格 §4.3 delivery 生命周期 | 适用（待办覆盖） | 不改 delivery 状态机；只核对所有未终态 delivery/final/outbox 均在 catalog 与迁后恢复中有落点，归入 IR34-09、IR34-24。 |
| 规格 §4.4 | 适用（兼容边界） | 迁居不得发布 staged mutation 或改变既有 CAS；仅迁移已提交/待办事实，归入 IR34-09、IR34-24、IR34-32。 |
| 规格 §4.5 | 适用（有限） | commit/abort 后 source/target staging、旧 source tombstone 与 artifact owner 必须按既有保留/GC 不误删共享 ref，归入 IR34-15、IR34-21、IR34-29。 |
| 规格 §5.1 | 适用（准入边界） | 既有控制请求入口全部受 source fence；迁居管理命令走独立 strict surface，归入 IR34-08、IR34-27、IR34-31。 |
| 规格 §5.2 | 适用（在途边界） | 既有派发协议不改型；已接受 dispatch 与未终态事实须可判定收束或迁移，归入 IR34-09、IR34-24。 |
| 规格 §5.3 | 适用（能力边界） | 既有 capability/lease/ticket 不扩权；活跃能力事实须作为 drain 或 pending 输入，归入 IR34-09、IR34-24、IR34-30。 |
| 规格 §5.4 | 适用（提交边界） | 既有 execution commit 不改型；效果前后失败、uncertain 与 exact replay 须在 drain/catalog 中闭合，归入 IR34-09、IR34-24、IR34-27。 |
| 规格 §5.5 | 适用（终态边界） | final/status/delivery 的已接受义务须可判定终态或按原身份迁移，归入 IR34-09、IR34-24。 |
| 规格 §5.6 | 适用（stream 边界） | 既有 stream 水位与重放语义不改；未消费终态须纳入迁后恢复，归入 IR34-09、IR34-24。 |
| 规格 §5.7 | 适用（取证/止损边界） | 已接受的 evidence/stop-loss 义务不得因 fence 丢失，须可收束或按原身份迁移，归入 IR34-09、IR34-11、IR34-24。 |
| 规格 §6.1 | 适用（conversation run 矩阵） | 36 行逐边判定见下表；fresh trigger 关闭，所有非终态/uncertain/待办不得简单丢弃，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.2 | 适用（user job 矩阵） | 38 行逐边判定见下表；fresh trigger 关闭，所有非终态/uncertain/delivery 义务完整，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.2b | 适用（system job 矩阵） | 6 行逐边判定见下表；fresh trigger 关闭，queued/running/fence/terminal/resource 事实完整，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.3 | 适用（直接） | planned 的 prepare→frozen→imported→committed→tombstoned、pre-commit abort、late abort 与断点重放逐边归入 IR34-06～IR34-27。conversation/disaster 分支只作类型隔离边界。 |
| 规格 §6.4 | 适用（逐行判定） | paired/configured/ready/degraded 的目标资格和 ReadyProof 适用；domain-reset/pending-reenroll 属第 35 单元且逐行判为不适用，归入 IR34-03、IR34-25、IR34-35。 |
| 规格 §7 | 适用 | 六类权威覆盖逐行决定 catalog 中应迁移、禁止迁移与重建内容，归入 IR34-11～IR34-12、IR34-18、IR34-24、IR34-30。CheckpointEnvelope 只作上游安全保障。 |
| 规格 §8 | 适用 | `device-trust` 的四个 RPC/CLI 与迁居 owner/receiver 直接适用；其余入口用于反向确认 source 写面和 pending obligation 无旁路，归入 IR34-08、IR34-23～IR34-24、IR34-28、IR34-31、IR34-36。 |
| 规格 §9 | 适用（兼容边界） | 本地域/锚点域能力矩阵不因 current anchor 切换扩权；executor-only 仍零全局写与 migration owner，归入 IR34-23、IR34-28、IR34-30。 |
| 规格 §10 | 适用 | workload/lease 终态表逐行约束 accepted work 的 drain 与迁后恢复，归入 IR34-09、IR34-24。 |
| 规格 §10.1 | 适用 | 设备 storage-maintenance 的容量、取消、stop、锁序和公平边界归入 IR34-13、IR34-29。 |
| 规格 §11 | 适用 | planned migration 产品旅程必须零内部术语且诚实表达可取消/不可取消与继续，归入 IR34-31。 |
| 规格 §12 | 适用 | 相关不变量、6.3 planned 逐边、签名篡改、崩溃点、双拓扑与零副作用对抗证据归入 IR34-27、IR34-33～IR34-34。 |
| 规格 §13 | 不适用 | 模块文档影响清单没有独立 S9 planned migration 条目；本单元不得据此扩写其他模块文档，当前总纲/规格/需求同步另由 D34-08 与 IR34-32 判定。 |
| 规格 §14 | 不适用 | S1 开工清单已完成且不属于第 34 单元。 |
| 规格 §15 | 适用（Unit 34） | 通用提交纪律和第 34 项全部适用；第 35～38 项不适用并受范围门禁，归入 IR34-01、IR34-33～IR34-35。 |
| unit-development-workbench.md 维护原则、§一 | 适用（流程/身份来源） | 用于确认当前动态区、Unit 34 身份与已定稿开发清单，不产生运行时合同，归入 IR34-01、IR34-36。 |
| 开发工作台 §二「目标与边界」「交付优先级与扩张门禁」 | 适用（范围来源） | 最小完整交付、架构优先、禁止未来能力扩面归入 IR34-01、IR34-35～IR34-36。 |
| 开发工作台 §二「架构与需求空洞裁决」 | 适用（边界来源） | 当前来源已唯一确定 planned migration 范围；如审查清单无法判定产品/单元边界才登记空洞，归入 IR34-01、IR34-36。 |
| 开发工作台 §三 | 不适用 | 生成/审查/开发提示词是过程模板，不新增 Unit 34 产品、架构或运行时验收合同。 |
| D34-01 | 适用 | strict transfer/ready/catalog/commit/abort/command/result/record 合同归入 IR34-02、IR34-27、IR34-32。 |
| D34-02 | 适用 | 目标资格、transfer issuer key、ReadyProof、prepared/staging 归入 IR34-03～IR34-06、IR34-14。 |
| D34-03 | 适用 | source checkpoint、准入 fence、drain、source prefix 与 freeze proof 归入 IR34-07～IR34-10。 |
| D34-04 | 适用 | AuthorityCatalog、planned export、private import、coverage exact-set 与资源边界归入 IR34-11～IR34-15。 |
| D34-05 | 适用 | source 唯一 commit、target authority base/install、TrustTransition/current anchor 原子发布归入 IR34-16～IR34-19。 |
| D34-06 | 适用 | takeover、pending 恢复、旧端 fencing、peer trust catch-up/tombstone 归入 IR34-21～IR34-25。 |
| D34-07 | 适用 | pre-commit abort、post-commit forward-only、启动恢复、并发/响应丢失、关闭归入 IR34-20～IR34-21、IR34-26～IR34-29。 |
| D34-08 | 适用 | CLI/server 产品旅程、两生产根 exact-set、S7/golden 与直接证据归入 IR34-28、IR34-31、IR34-33～IR34-34。 |
| 当前完整交付物 74 个非工作台路径 | 适用（生产事实） | core 15、mesh 9、owner-kernel 1、CLI 36、server 8、架构 3、S7 2 个路径逐组反向归入 IR34-01～IR34-36；完整指纹 `daa82f4b…b6ef9c0`，测试只作证据对象，不替代功能判断。 |

#### 适用枚举行逐条落点

| 枚举来源 | 逐条判定与审查项 |
| -------- | ---------------- |
| 规格 §6.1 conversation run 行 1～36 | 既有逐边语义不在本单元重审；每行产生或消费的 `queued/dispatched/running/cancel-requested/uncertain` 均是 IR34-09 的 drain 输入，terminal、outbox、interaction/effect 与 exact replay 是 IR34-24 的迁后义务，相关直接证据归 IR34-34。 |
| 规格 §6.2 user job 行 1～38 | 行 1～2 的 fresh trigger 受 IR34-08 fence；其余每行的非终态/terminal/uncertain/delivery 义务逐项归 IR34-09、IR34-24，既有状态语义不改，直接证据归 IR34-34。 |
| 规格 §6.2b system job 行 1～6 | 行 1 fresh trigger 受 IR34-08 fence；行 2～6 的 queued/running/fence/terminal/resource 事实逐项归 IR34-09、IR34-24，直接证据归 IR34-34。 |
| 规格 §6.3 AuthorityTransfer | planned 行 `0a/1/2/3a/4/5a/6/7/8` 分别归 IR34-06、IR34-08～IR34-10、IR34-14～IR34-21、IR34-27、IR34-34；disaster 行 `0b/3b/5b` 不适用，只作为 IR34-02/IR34-35 的 mode 隔离反例。 |
| 规格 §6.4 设备状态行 1～11 | 行 2～5 的 configured/ready/degraded 是 IR34-03/IR34-16 的直接 readiness 输入；行 1、6～9 只作为既有 paired/active/revoked trust 投影输入归 IR34-03/IR34-25，不在本单元新增转移；行 10～11 `domain-reset/pending-reenroll` 不适用并归 IR34-35 负边界。 |
| 规格 §7 六类覆盖行 | `全局状态与期望配置`→IR34-11/18/24；`会话状态`→IR34-11/18/24；`会话内容资产`→IR34-11/12/15/18；`环境事实与本地秘密`→IR34-11/30（禁止）；`执行资产`→IR34-11/12/18；`非权威缓存`→IR34-11/30（禁止/重建）。 |
| 规格 §8 `device-trust` | 直接 planned 产品入口及 owner/receiver 落点归 IR34-03、IR34-06、IR34-20～IR34-21、IR34-28、IR34-31。 |
| 规格 §8 权威写/待办行 | `session-send/run-cancel/uncertain-resolution/confirmation-resolve/permission-persist/trust-manage/conversation-manage/conversation-window/conversation-metadata/task-list/advancement/workscene-manage/workscene-switch/schedule-manage/schedule-run/schedule-timer/memory-write/skill-manage/skill-usage/segment-transition/orchestration-child/channel-inbound/channel-delivery` 逐行归 IR34-08、IR34-09、IR34-24；fence 后只允许已接受义务的有限收束。 |
| 规格 §8 只读/路由行 | `confirmation-read/session-observer/global-list-read/conversation-read/memory-read/status-read/light-inference` 逐行归 IR34-23～IR34-24；切换后只解析 current anchor，且不得借只读入口取得写能力。 |
| 规格 §8 本地/负边界行 | `environment-select/workspace-binding/runtime-lifecycle/advancement-evidence/runtime-config` 逐行归 IR34-09、IR34-24、IR34-30、IR34-35；仅迁移已接受的耐久义务，不迁环境、路径、秘密或本地配置。 |
| 规格 §8 `shutdown` / `recovery-backup` | `shutdown`→IR34-29；`recovery-backup` 仅作 Unit 33 current verified full checkpoint 上游接缝→IR34-07/IR34-32/IR34-35。 |
| 规格 §10 workload 终结表全部行 | run/job 的 committed、两类 cancelled、两类 failed/expired、uncertain→terminal、uncertain→queued、uncertain pending，以及 system job/control/evidence/orchestration-node 各行逐项归 IR34-09、IR34-24；本单元不改变既有 lease 终结语义。 |
| 规格 §12 不变量行 1～18 | `1/4/8`→IR34-17～IR34-23；`2/3/9/13/15/17`→IR34-08～IR34-09、IR34-18～IR34-24、IR34-27；`5/11/12/14`→IR34-28/32/33；`6/10/16`→IR34-03/16/22/30/32；`7`→IR34-05/21/27；`18`→IR34-09/13/29。全部只取 planned migration 的直接交界，不重审上游状态机。 |

### 交付路径反向覆盖

| 路径组 | 当前交付角色 | 归入审查项 |
| ------ | ------------ | ---------- |
| `packages/core` 5 路径 | `authority/{commit-log,index}.ts`、`contracts/identity.ts`、`protocol/{anchor-transfer,anchor-transfer.test}.ts`：strict identity/result、append fence、composite prefix install、exports 与协议证据各恰归一次。 | IR34-02、IR34-06、IR34-08～IR34-12、IR34-17～IR34-19、IR34-27、IR34-32～IR34-34 |
| `packages/cli` 16 路径 | `src/index.ts`；runtime duty command/facade及测试；serve 的 first-party router、两生产根、bootstrap store、planned owner/target/mesh/测试与 setup delivery。source/target、private import、phase、current-owner、lifecycle、CLI/DTO 与真实故障证据各恰归一次。 | IR34-03～IR34-34、IR34-36 |
| `packages/server` 2 路径 | `src/context.ts`、`src/rpc/methods/__tests__/server.test.ts`：management context、公开 DTO consumer 与直接证据。 | IR34-23、IR34-27、IR34-31、IR34-33～IR34-34 |
| 架构/需求/规格 3 路径 | `always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`：planned 边界、字段、状态机、landing row、用户旅程与验收。 | IR34-01～IR34-36 |
| S7 2 路径 | `scripts/s7-entry-coverage.mjs`、`scripts/s7-entry-coverage.test.mjs`：owner/receiver/role/order/RPC exact-set 与真实装配变异。 | IR34-28、IR34-33～IR34-36 |

### 审查项

> `[~]` 行的“证据记录”保留上一轮审查事实，仅供定位重审输入；因本轮合同、生产实现、装配或证据已经变化，它们不代表当前冻结交付物的通过/失败结论。后续独立审查必须基于当前指纹重新二元判定。

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR34-01 | [x] | 单元身份、边界与完整交付物 | 冻结当前 74 个非工作台路径并逐一反绑 D34-01～D34-08；只交付 planned current-anchor 迁居，不得混入 Unit 35 disaster/source-less recovery、Unit 36～38 生命周期或通用迁移/同步框架。 | 本项原 `[x]` 结论直接复用；本轮不重复审查其功能判断，只由 IR34-36 同步当前完整路径事实：以第33单元封版为基线共 core 15、mesh 9、owner-kernel 1、CLI 36、server 8、架构 3、S7 2，完整指纹 `daa82f4b…b6ef9c0`。实现仍只开放 planned 迁居及既有 Unit33 接缝，后继恢复、连续同步或通用框架排除结论未被新事实触发。 |
| IR34-02 | [x] | strict 合同、身份与摘要关联 | `ReadyProof`、`AuthorityCatalog`、planned `AnchorTransferCommit/Abort/Command/Result/TransferRecord` 与 `SourceFreezeProof` 必须是 exact-key 判别联合；request/transfer/source/target/epoch/ref/offset/commit/abort 逐字段反绑 originating command，JCS/digest/signature/schema/version 全等，planned/disaster/conversation 混型在副作用前拒绝。 | 复核 core strict decoder、mesh client/server 与 journal reducer：命令和结果先做 exact-key、schema/version、mode/state、签名、digest、originating request/transfer/device/epoch/ref/offset 全字段关联，再进入 I/O 或日志副作用；planned/disaster/conversation 混型稳定拒绝，未见 P0/P1。 |
| IR34-03 | [x] | 目标资格与 readiness | 候选/list/prepare 只接受另一台已配对、active、启用 anchor 角色的设备；ReadyProof 同时冻结 current home/trust generation、角色、配置能力、protocol/asset/service revision、SecretStore unlocked、有效期与目标身份，任一漂移/过期/离线给出稳定拒绝且零 prepared。 | 候选、summary、ready 与 prepare 均反绑另一 active anchor-role 成员、current home/trust chain、角色、配置能力、protocol/asset/service revision、SecretStore unlocked、期限和目标身份；漂移、过期、离线在 prepared 写前稳定拒绝。并发单飞缺口单列 IR34-04/06，不改变本项资格判定。 |
| IR34-04 | [x] | transfer issuer key 生命周期 | 目标 issuer key 必须在目标本机按 transfer 单飞生成、SecretStore 回读验真并以 possession proof 绑定 ReadyProof；prepare replay 同 key，pre-commit abort 只删该未激活 key，commit 原子激活后按 issuerKeyId 重载，私钥零 wire/log/status/error，设备 identity 与 issuer identity 不混同。 | target-wide candidate journal 先耐久 claim/ReadyProof，再生成并回读 transfer-bound issuer key；prepare 与 signed abort 在同一 candidate 事务互斥。claim-only abort 在校验外层命令、内层签名 abort、candidate/ReadyProof 与已存在 key 全等后先写 durable `aborted`，再幂等清 key、私有目录和 reservation；key 已清仍可 exact replay，错绑 key/identity 零清理。prepared 胜出时只物化原 prepared payload并进入既有 reducer；commit 后 abort 冲突。真实双端测试覆盖 proof 过期、key 已清/错绑、响应丢失、连续重启及后续 transfer，未见 P0/P1。 |
| IR34-05 | [x] | 有限 mesh transport 与认证 | ready/transfer/source-range 只经现有认证 mesh 与 negotiated service；连接 peer、current source、prepared target、签名 keyId、phase exact-set 全等，未知/错方向/错设备/错命令在 target/source I/O 前拒绝，传输断连只重放同一 durable identity且不产生第二权威。 | ready/target/source-range 三个 negotiated service 均在 handler 前验证 authenticated peer、current source、prepared target、签名 keyId、phase 与 range allow-list；未知服务、错方向/设备/签名/命令零业务 I/O，传输不持第二权威，未见 P0/P1。 |
| IR34-06 | [x] | prepare、竞争与双端 durable identity | source/target `prepared` 必须共享稳定 requestId/transferId/source/target/sourceEpoch/nextEpoch/ready/transition；同载荷 exact replay，异载荷冲突；同一 home 同时至多一项非终态迁居，竞争在关闭准入或创建第二 issuer/staging 前拒绝。 | source 侧 candidate claim 与首次完整 `anchor-prepared` 在同一 AuthorityCommitLog 投影事务排序；target 侧 target-wide journal 在创建 context/staging 前单飞 claim，并把完整 prepared 与完整 signed abort 作为同一事务内互斥决定。same-transfer 重放复用相同 identity/key，异 transfer 在 ready/key/staging 前稳定 busy；abort 先赢则 late prepare 零 append，prepared 先赢则只物化原 payload后进入 per-transfer reducer。并发、丢响应和连续重启均由两份耐久决定唯一收敛，未见 P0/P1。 |
| IR34-07 | [x] | Unit 33 checkpoint 前置接缝 | source 只能消费 current root/current generation 的 verified full recovery checkpoint，或以 stable transfer request 复用既有 owner 强制取得；checkpoint envelope digest 仅作安全保障，不可替代 planned export/catalog/proof，未验证/旧 root/owner unavailable 不得进入 fence/commit。 | 已核对 `ensureRecoveryCheckpoint` 与 Unit 33 owner/status 接缝：仅复用 current generation 的 verified full checkpoint，缺失时以稳定 transfer request 调既有 force；返回的 envelope digest 只进入 prepared 安全前置，后续仍独立冻结/export/catalog/proof。未验证、旧代或 owner unavailable 不会进入 fence，未见 P0/P1。 |
| IR34-08 | [x] | source fresh admission 全写面栅栏 | 从 fence 线性化点起，第一方 RPC、channel input、session/global/task/intent、新 confirmation/interaction 生产、scheduler timer/manual trigger、新 delivery 生产及所有 `AuthorityCommitLog` 旁路均不得产生 fresh 权威事实；IR34-09 已耐久接受的 interaction/final/delivery 等只可走原身份有限收束，另只允许该 transfer 的 recovery/commit/abort 记录；abort 前无 durable fence 时可安全恢复。 | stopAccepting 先拒 channel ingress并暂停 scheduler，drain 后 append guard 在取得 source checkpoint 前串行安装；guard 只允许同 transfer、同 envelope closure 及 commit 的 trust/current entries，其余 RPC/global/task/intent/direct-log fresh append 均在日志锁内拒绝。durable abort 才清 guard并恢复原 owner/loops，未见 fresh 旁路。 |
| IR34-09 | [x] | accepted work drain 与终态诚实性 | fence 前已接受的 conversation/user job/system job、queued/active run、interaction/confirmation、staged publish、final/delivery/outbox/uncertain 必须逐类收束到可证明终态或作为明确 pending obligation 冻结；timeout/abortAll/flush/recovery-loop 失败不得伪造 drain 成功或丢弃义务。 | lifecycle 在 stopAccepting 后执行 conversation abort/drain并复核 `hasActiveWork()`、executor job drain、delivery flush，再停止 recovery loop；不可判定 active work 直接阻止 fence。剩余 assignment/interaction/final/delivery/intent/confirmation 从同一日志 checkpoint 投影为 pending，不伪造终态。 |
| IR34-10 | [x] | 唯一 source prefix 与 SourceFreezeProof | admission durable closed 且 IR34-09 完成后，source 只从同一 `AuthorityCommitLog` 取得一个 `{logId,lsn,frameEndOffset,prefixDigest}`；snapshot、export、catalog 与 `SourceFreezeProof(scope:"anchor")` 必须全等绑定同一 prefix，追加/坏尾/缺 ref/错 epoch 时 created/frozen/target import 零错误推进。 | guard 安装后取得唯一 DurableLogCheckpoint；分页 export、catalog.source、closure 与 signed `SourceFreezeProof(anchor)` 全等反绑 logId/lsn/frameEndOffset/prefixDigest/source epoch，target 再验证 canonical prefix与页尾。追加、坏尾、错 epoch/ref 均不能推进，未见 P0/P1。 |
| IR34-11 | [x] | AuthorityCatalog 六类覆盖 | 逐行核对规格 §7：global、conversation authority/content、execution assets、trust/current anchor 与全部 pending obligations 完整；环境事实、SecretStore、workspace raw path、设备/非权威缓存不可表示。streams、coverage、record/ref/count/digest canonical exact-set，少列、多列、重复、乱序、空置真实义务均 fail-closed。 | builder 从同一冻结前缀逐 envelope 统计 stream/count/digest、authority records、retained refs、trust/current 与六类 coverage；`PendingObligationTracker` 按 assignment/interaction/final/delivery/intent/confirmation 的生产记录和终态增删 exact-set。类型不表示环境、秘密、raw path或缓存；target 重算/反绑 catalog，未见少列或空置真实义务。 |
| IR34-12 | [x] | planned export 与 retained artifact 闭包 | 独立 planned export 只含 IR34-10 prefix 的 canonical commit envelopes，catalog 的 authorityRecords/retainedArtifacts 与真实引用闭包全等；artifact 先耐久后引用，共享/嵌套/大资产去重且 bytes/digest 全验，恢复 checkpoint 内容不得冒充 export，缺件不得 freeze/import/commit。 | source export 只序列化冻结前缀原 envelope并以 lifecycle index 枚举去重 retained exact-set；target freeze/import 在 transfer-private store逐 ref 拉取并验 bytes/digest/coverage，缺件或恢复 checkpoint 混绑不能写 imported。共享 CAS 仅在 commit 前从已验私有对象幂等提升，未见 P0/P1。 |
| IR34-13 | [x] | 容量治理与有界传输 | export、source range、target pull/private staging、promotion/install 每个物理步骤必须使用同一设备 `storageMaintenance` governor 与 lifecycle abort；buffer/part 固定上界，网络等待零 permit，permit 不跨 authority/store/lifecycle 锁；容量拒绝、磁盘满、取消/stop 要么零事实，要么保留唯一可重驱事实。 | export 以固定 commit page 落 ArtifactStore，manifest 受 header 上界；source range、target decode/write、promotion read/write 与 install 分别进入同一 governor。target 先完成网络 range 再持 permit 写本地，permit 不跨网络或外层锁；runtime AbortSignal/closing promise覆盖端口与恢复，失败保留 durable phase，未见 P0/P1。 |
| IR34-14 | [x] | target 私有 staging 与冻结验真 | target 只在该 transfer 私有 authority root/journal/ArtifactStore 接受 export/catalog/retained refs；range 连续且关联原 ref/offset/length，完整 bytes/digest/catalog/source-prefix/coverage exact-set 验真后才写 frozen/imported；部分、重复、重排、响应丢失和重启不串 transfer、不使共享 CAS/当前 authority 可见。 | `#context(transferId)` 固定独立 transfers/<id> 私有 root、ArtifactStore、partials/promotion-partials 与 journals/<id>；range 反绑 ref/offset/length并由 resumable receiver 校验连续性/digest。export/catalog/pages/retained exact-set 全验后才 imported，部分、重排、响应丢失和重启不进入共享 authority。竞争单飞缺口归 IR34-06。 |
| IR34-15 | [x] | import、共享 CAS 提升与清理边界 | imported 必须反绑 frozen export/catalog，promotion 对已有/共享 digest 幂等且不覆盖异 bytes；pre-commit abort 仅清私有 staging和未激活 key，绝不删共享业务 CAS；commit 后 retained refs 仍有唯一 owner，部分 base import/progress 可重驱且不形成可服务的半 authority。 | imported 继续反绑 frozen checkpoint/catalog/proof 与完整 retained refs；共享 CAS promotion 先核对 existing digest/bytes，私有 receiver逐块验真，异 bytes拒绝。新增 claim-only abort 只删除 transfer 私有目录、未激活 issuer key 与 reservation，不触碰共享 ArtifactStore；已有 phase 的 abort/terminal replay仍走原 private cleanup，committed/installed状态拒绝回滚。installed generation 又与可清 private progress分离，半 authority 在pointer和consumer gate前不可服务，未见 P0/P1。 |
| IR34-16 | [x] | commit 前最终复验 | source 签 commit 前重新验证 current issuer/home/trust chain、ReadyProof 未过期且 capability/revision 未漂移、target/import/catalog/freeze/transition 全等、next epochs 单调；任一改变保持 source fenced 或可安全 abort，零 signed commit。 | existing-transfer `ready` 仍在 target lifecycle锁内重读完整snapshot、SecretStore/key并耐久更新同journal reservation；source签commit前重取同transfer proof并核对digest、expiry、current snapshot、target/import/catalog/freeze/transition与单调epoch，target commit再验证同reservation。最新candidate abort只对已经签出的历史abort做identity重放，未放宽commit readiness；revision漂移与commit/abort保持二元终态，未见P0/P1。 |
| IR34-17 | [x] | source 唯一原子 commit 切点 | 当前 issuer 只能在 source 同一 `AuthorityCommitLog` envelope/一次 sync 原子追加唯一 signed planned commit，并使该 commit 所绑定的 prepared issuer-transition、next anchor/trust epochs 与 current-anchor 投影共同生效；不得另造第二切换事实。重复同决定零追加，异决定冲突；该 sync 后 append fence 永久 committed，旧 source 不因 target 未应答恢复。 | owner 在 journal 单次 transaction/envelope 同写 signed `anchor-committed`、prepared issuer-transition 与 `planned-anchor-source-committed` current projection；同决定回放零追加、异决定冲突。sync 后 committed fence永久保留且 `onSourceCommitted`先更新 resolver，target响应不明不恢复旧 source，未见第二切点。 |
| IR34-18 | [x] | authority base 导入与不可见性 | target 导入原 source commits 时必须保持 source LSN/envelope identity、stream exact-set和引用在场，可幂等断点续做；在最终安装 envelope sync 前，导入进度、records、投影和旧 current-owner 均不可被公开服务当作已接管 authority，冲突 progress fail-closed。 | target保留 source export 的原 envelope/LSN/digest并只从私有 artifacts提供 async source；`installPlannedAnchorPrefix` 在 log 锁内重建候选 WAL、逐封包验证原前缀，再以原子 rename+directory sync 一次发布 source base和installation envelope。sync 前 live reader/projection不可见候选，冲突/坏尾 fail-closed。 |
| IR34-19 | [x] | target 原子安装与服务开放 | target 逐字段验证同一 commit/transition/catalog/export/issuer key 后，在一个本地 `AuthorityCommitLog` envelope 原子发布 trust event/record、planned install、authority base/current anchor/next epochs；sync 后才激活 issuer、reconcile trust和开放服务，sync 后无决定性外部 I/O，效果后响应丢失只 exact replay。 | planned installation仍在同一target AuthorityCommitLog envelope发布trust/current/base pointer；`completePlannedAnchorInstallationBeforeBootstrap()`每次从durable installation派生不可变InstalledAuthorityGeneration，且不依赖可清private progress。startup在role composition前按该epoch构造runtime；live install在current-owner gate内重绑runtime epoch、DeliveryAuthority、ControlAdmission、resource governor、stable surface assets及四类global adapter，再恢复scheduler/conversation/delivery并read-back六类obligation，最后才cleanup/open/respond。失败保留installation与gate供重启/terminal replay，效果后丢响应仅重放同generation，直接证据覆盖两profile、真实cursor与epoch 1→2→3，未见P0/P1。 |
| IR34-20 | [x] | pre-commit abort | prepared/fenced/frozen/imported 均只接受 current source 对同 request/transfer/sourceEpoch 的签名 abort；source 的 durable abort 是清 fence、以原 epoch 恢复准入/recovery/scheduler 的唯一线性化点，不等待跨设备物理清理。target 收到同一 abort 后先耐久隔离该 transfer并拒绝任何后继commit，再幂等清私有staging、删除未激活key；target离线、清理失败、断连/丢响应/重启均保留同一投递/清理义务，异abort冲突。 | source仍先在自身journal耐久signed abort，随后清fence并恢复原epoch生产面，再异步投递target。target对claim-only先在target-wide candidate transaction耐久完整authenticated abort，再清key/private/reservation；prepared已赢则从原prepared补写phase并由既有reducer落aborted，已有phase继续原路径。cleanup失败不改变terminal，startup扫描candidate与per-transfer journal继续清理；异identity、late prepare/commit和不同abort稳定冲突，离线target不阻塞source恢复，未见P0/P1。 |
| IR34-21 | [x] | post-commit forward-only 与 tombstone | source commit 后 late abort 永久拒绝；target 未提交、效果后丢响应、离线和连续重启只重发同 commit直至安装，source始终拒写；target已提交只 exact replay。旧 source cleanup/tombstone不得改变 authority或恢复 issuer，后续迁回只能新 transfer/更高 epoch。 | source committed guard与producer quiesce不因stop、重启或target离线解除；late abort在source/target committed或tombstoned状态稳定拒绝。target installation一旦存在，live/startup都从同一durable generation恢复key、runtime projection/cursor、consumer与pending owner；private progress已清仍可取得generation，响应丢失只重放同commit/installation。再次迁居只能产生新的transfer和更高anchor/trust epoch，旧source cleanup不恢复issuer或写权，forward-only已有正确终点，未见P0/P1。 |
| IR34-22 | [x] | 旧 source 全能力永久 fencing | commit 后逐项核对 control/session/global/job/delivery/confirmation/intent/assignment/signing/mesh receiver与直接 log append：旧 anchor、旧 issuer、旧 anchorEpoch/trustEpoch 全部 fail-closed，允许的重定向只基于已认证 current-anchor 事实且不得代理旧写。 | source在fence前停止channel/inbound、scheduler、conversation recovery与delivery producer，commit后append guard永久保留；current-owner路由与认证mesh拒绝旧issuer/epoch。target由InstalledAuthorityGeneration统一设置runtime epoch并重建DeliveryAuthority、control/resource、surface/global与后续scheduler/conversation/delivery owner，所有named participant回报同generation后才开放；两生产profile及epoch 1→2→3测试证明旧cursor/旧epoch不再写入。允许的转发只解析signed current owner且target离线不回退旧source，未见P0/P1。 |
| IR34-23 | [x] | current anchor 路由与第一方接管 | target 安装后 CLI/server/channel/scheduler/global state、会话列表/创建、确认/通知、任务及所有第一方管理入口只解析唯一 current anchor；source/target/其他设备对相同请求不会双写或显示两套值班事实，单机与分布式 surface 语义等价。 | canonical builtin registry 去除 `auth/health/server.shutdown` 后形成唯一 relay exact-set；anchor+executor逐方法委托 current-anchor router，executor-only先处理冻结 local session/confirmation集合再委托current anchor，未知/设备本地方法不代理。channel注册与连接分离，连接、`InboundRouter`副作用前及challenge最终动作均重读current owner/post-install gate；source先拒新并drain、target只在consumer完成后连接，三设备与离线分支未见旁路。 |
| IR34-24 | [x] | pending obligations 迁移与恢复 | AuthorityCatalog 必须从耐久事实枚举 assignment、interaction、final、delivery、intent、confirmation 等实际非终态 exact-set；target 接管后以原稳定 identity、水位和重试语义恢复，terminal replay不追加，源端无遗留 producer/loop，遗漏/多列/错 owner 在开放服务前失败。 | source closure从同一冻结log prefix枚举assignment、interaction、final、delivery、intent、confirmation六类durable exact-set并与accepted token全等；source producer在commit前quiesce。target先完成installed generation重绑，再按scheduler、conversation、delivery三组调用既有recover/start；scheduler重建JobJournal/intent/global lazy children，conversation重发现当前代际，delivery重建真实AuthorityDelivery pipeline/cursor。consumer receipt与log read-back逐项确认原obligation已归current owner或terminal后才清progress并开放，terminal replay不追加，未见P0/P1。 |
| IR34-25 | [x] | trust/peer 收敛与旧 issuer 拒绝 | issuer-transition 必须由旧 current issuer签名、指向 active anchor target的 transfer issuer public key并产生 next trust epoch；target `HomeTrustRecord` 可验签，在线/离线 peer重连后只接受新链头/issuer，旧签名和旧 epoch永久拒绝，合法既有 device-key transition兼容不漂移。 | source 在 target commit 回执验签后耐久 reconcile 同一 migration transition/record；target 安装同一 record。任一 active peer 重连时只可请求本地 chain head 后至多一个 signed migration issuer-transition，服务端验证祖先前缀，客户端用既有 `reconcileTrustSuffix` 验签/落盘；冲突链头、非 migration、多事件、旧 issuer均 fail-closed，未见独立 P0/P1。 |
| IR34-26 | [x] | 启动恢复顺序 | source 重启必须在任何公开 producer 前重装 durable fence并重驱commit/abort；target重启从私有journal/base progress恢复并在原子安装前保持服务关闭；双端事实不对称、坏尾、缺artifact/key、冲突/歧义fail-closed，连续重启最终唯一收敛且无双owner。 | assembly.start在control公开前先在同一planned lifecycle内恢复target candidates/per-transfer journal与source fence/driver；target candidate scan先处理claim-only terminal cleanup、prepared payload补写，再扫描phase journal。bootstrap每次从durable installation恢复issuer key与InstalledAuthorityGeneration，post-install未完成时保持current-owner/control gate关闭；坏尾、缺key/private state、重复installation或identity冲突均fail-closed。source prepared/target claim-only现在由同一signed abort耐久终结，连续重启不再永久busy，未见P0/P1。 |
| IR34-27 | [x] | 并发、重放与严格结果终态 | prepare/fence/freeze/import/commit/abort/status/read-range 的并发、重复、异载荷、错 request/transfer/ref/offset/state和效果前后失败都二元落定；result先与 originating command关联再分类，stable conflict与retryable不混淆，任何拒绝在对应权威/存储副作用前发生。 | source cancel与首次prepared由同一AuthorityCommitLog投影事务排序；target prepare与signed abort由同一candidate transaction排序，abort先赢则late prepare零append，prepared先赢则重放原prepared后进入原reducer。外层command、内层abort、candidate/ReadyProof/key及per-transfer identity在terminal或cleanup前全等校验；错request/transfer/source/target/epoch/key、异载荷与late commit均零副作用冲突。同载荷在效果/响应丢失及连续重启下复用原terminal/result，strict codec与originating-command关联未放宽，未见P0/P1。 |
| IR34-28 | [x] | 两生产根与角色 exact-set | anchor+executor 与 anchor-only/current-anchor 各恰一 source/recovery owner，source range receiver 仅 current source；合格 non-current active anchor 可各有一个有限 readiness/strict receiver，但在首条 `prepared` 前零 transfer record/staging/recovery owner，prepared 后只有命中 targetId 的设备可持该非终态迁居。executor-only、surface、disabled、非 anchor 与未命中 target 的候选零迁居 owner/耐久状态；trust 换代时旧实例退役、新实例单次安装，零重复 listener/service。 | 两个current-anchor profile都经同一AccessSurface→setupAuthorityRuntime→MeshRuntimeAssembly装配，InstalledAuthorityGeneration在两者每次启动均覆盖默认epoch；参数化直接测试验证anchor+executor与anchor-only的固定participant和epoch 1→2→3。assembly按signed current trust动态安装恰一source owner或non-current target receiver，role变化先dispose旧service；executor-only/surface/disabled/非anchor无planned owner。target-wide claim在key/staging前跨transfer单飞，只有命中targetId的candidate进入非终态，未见重复listener、owner或耐久状态。 |
| IR34-29 | [x] | 生命周期、关闭与资源收束 | start 须先恢复 fence/transfer 再接公开流量；stop 先拒绝 fresh 管理/业务写，安全取消或等待当前物理 step，停止 owner/receiver/retry loop并释放permit/key handle/disposer；未终态事实留给重启。cleanup失败不得伪造abort/commit，也不得阻断已原子安装target或无迁居角色设备的普通业务；source一旦committed仍永久fenced，不得以“普通业务”名义复权。 | PlannedAnchorTransferRuntimeLifecycle仍为owner/receiver/ready/range与recovery提供唯一accepting gate、AbortSignal、in-flight集合和closing promise；target-wide claim log及per-transfer log复用同storage governor，网络等待零permit，局部读写/fsync受既有准入。stop先关闭planned runtime并等待在途settled，再停control/worker和dispose service；未终态candidate/phase留待启动扫描。claim-only cleanup发生在durable terminal后且只处理有界私有元数据/key/reservation，失败可重驱；committed source guard与installed target不因stop/cleanup失败回退，未见P0/P1。 |
| IR34-30 | [x] | 安全、最小权限与数据隔离 | wire/log/catalog/export/RPC/错误只含必要稳定身份与ArtifactRef；秘密、恢复主秘密、SecretStore内容、环境、workspace绝对路径、设备缓存、raw store/log/通用读取删除能力零逸出；签名、peer、role、epoch、ref与path/容量guard均在首次对应副作用前验证。 | strict wire/records/catalog/RPC仍只携稳定identity、签名对象和ArtifactRef；InstalledAuthorityGeneration来自本地installation投影，不进入公开DTO，issuer私钥只经transfer-bound SecretStore helper读取/激活/删除。claim-only abort在candidate terminal前验证外层认证command、内层source签名、request/transfer/source/target/sourceEpoch、ReadyProof与已有key全等；不重跑已过期proof只用于历史decision replay，不放宽fresh readiness。raw log/store、路径、环境和内部错误未进入CLI/server surface，未见P0/P1。 |
| IR34-31 | [x] | CLI/server 产品旅程 | `zz duty targets/migrate/continue/cancel` 与四个 authenticated `dutyMigration.*` 必须同源：列表稳定且 CLI/用户渲染只展示目标 `displayName`（opaque `targetDeviceId` 仅作内部选择关联，不直接展示），ready 缺口可行动，prepare 后明确仍可取消，commit 展示收束/传输/接管且结果不明可同编号继续，commit 后取消诚实拒绝；公开 exact keys/错误零 anchor/epoch/issuer/catalog/CAS/stream/secret/path/raw error 术语。 | 四个 RPC 与 CLI共用同一 management facade；target投影返回 displayName/ready，TTY按序号/设备名选择，非TTY只接受唯一名称，重名稳定拒绝，内部 deviceId仅在选中后传 strict prepare且不渲染。文案区分可取消、继续与 commit 后拒绝，公开错误不泄露内部术语，旧 P2 已修复，未见 P0/P1。 |
| IR34-32 | [x] | 分层、导出与上游兼容 | core strict合同、mesh trust/key/ready、owner-kernel drain、server投影、CLI组合根依赖方向无环且无复制事实源；Unit33 checkpoint/S2 trust/SecretStore/mesh/现有conversation transfer兼容，package export/build与供应链隔离不漂移。 | candidate/transfer耐久排序仍复用CLI内既有FileAuthorityCommitLog与SecretStore/private staging；InstalledAuthorityGeneration只由planned installation投影产生，runtime coordinator位于组合根，无第二事实源或通用generation registry。稳定surface coordinator的窄rebind原语下沉core，CLI仅重建权威binding；strict protocol、mesh trust/key/ready、owner-kernel admission和server公开投影职责未倒置。Unit33 checkpoint、conversation transfer、SecretStore及S2受管依赖/PAKE隔离未改型，workspace 17包构建通过，未见P0/P1。 |
| IR34-33 | [x] | S7、registry 与 golden exact-set | 现有单一 S7 gate必须反绑两生产根issuer key注入、owner/target构造、service phase/role/order、recovery-before-admission、四CLI RPC与canonical server registry；新增/删除/重复/换序/绕过/错误root和动态未注册方法均fail-closed，合法拓扑/golden零误杀，不建新lint/发现框架。 | 现有S7现已冻结9项InstalledAuthorityGeneration participant exact-set，反绑bootstrap installation→epoch注入、stable surface rebind、generation先于scheduler/三组consumer/read-back，以及target candidate完整prepared/abort字段、`decideRemoteAbort`、claim-only cleanup、candidate-before-phase启动扫描与source/target recovery-before-admission。mutation tests会拒绝删participant、绕过bootstrap/rebind、替换abort decision或candidate scan；既有canonical registry、两根role/order、四RPC/golden规则继续有效。当前实现和有限gate共同覆盖本轮两个根因且未新建runner，未见P0/P1。 |
| IR34-34 | [x] | 成比例的直接验收证据 | 必须有strict codec/reducer、ReadyProof/issuer transition、真实双端AuthorityCommitLog/FileArtifactStore/private staging、checkpoint接缝、source drain/fence、catalog/pending exact-set、双端commit/abort/response-loss/restart、旧epoch拒绝、两生产根与S7真实变异的直接证据；测试通过不得替代逐格功能判断，不做配置×故障笛卡尔积。 | 当前冻结输入已有planned transfer 20/20真实双端测试，覆盖source prepared/target claim-only、prepare/abort竞争、proof过期、key已清/错绑、响应丢失、两次重启、exact replay和下一transfer；setup-delivery两profile 2/2在真实AuthorityCommitLog上先推进旧DeliveryAuthority cursor，再验证fixed owner重绑与epoch 1→2→3；core stable surface rebind 1/1，六类catalog exact-set、source fence/closure、private import/atomic install及现有strict codec场景继续有效。S7 18/18与registry golden、workspace build均通过；逐格源码判断与测试相互印证，未见P0/P1。 |
| IR34-35 | [x] | 后继能力与非目标边界 | 逐路径确认未实现source-less/disaster recovery、restore/domain-reset/pending-reenroll/credential rotation、自动failover/quorum、continuous sync、服务托管/卸载/升级，也未改变Unit33 checkpoint语义或新增通用迁移/路由/事务/outbox/registry/监控诊断框架。 | 当前74个非工作台路径仍只实现current source发起的planned迁居、Unit33 verified full checkpoint窄接缝与有限管理/认证mesh面。新增candidate terminal与installed generation coordinator均为planned内部固定事务/participant集合，无动态注册API；未出现source-less/disaster、restore/reset/reenroll/rotation、自动failover/quorum、continuous sync、Unit36～38生命周期、多目标/云或通用锁/路由/事务/outbox/事件总线/监控诊断设施，EX34-01重开条件不成立，未见越界问题。 |
| IR34-36 | [x] | 来源、D34义务与路径反向闭包 | D34-01～D34-08、全部适用来源条款与当前完整非工作台路径必须按core合同、mesh安全、owner-kernel准入、CLI source-target/assembly/management、server RPC、架构规格、S7和直接测试逐一归入IR34-01～IR34-35；零未判定来源/条款/枚举行/功能链/交付路径，零重复或无法独立判定条目。 | 以第33单元封版提交 `735a3dcd…` 为基线重算当前HEAD，完整交付为74个非工作台路径：core 15、mesh 9、owner-kernel 1、CLI 36、server 8、架构 3、S7 2；排序后的 `path<TAB>file-sha256` 全量指纹为 `daa82f4b2419ac172a6a464c7d7e3d61a3b36cb5ca8d61f87ffecc352b6ef9c0`。D34-01～D34-08、四份权威来源全部适用章节、规格枚举行、74条生产/直接测试/架构/S7路径均已反向归入IR34-01～IR34-35；最新23路径专项指纹 `7f9ba3ba…54d6269a` 是该完整闭包的受影响子集。未发现未判定来源、路径、重复条目或架构空洞，未见P0/P1。 |

> U34-04/U34-09 的 23 路径专项修复已在指纹 `7f9ba3badb9c1558d0b2d2b93ebb0f456d8b667d0b11aced53d9747f54d6269a` 完成；本轮又在第34单元 74 路径完整指纹 `daa82f4b2419ac172a6a464c7d7e3d61a3b36cb5ca8d61f87ffecc352b6ef9c0` 上完成 19 项受影响范围复审，全部二元判定为无 P0/P1。17 项既有 `[x]` 直接复用，EX34-01及第35～38单元边界未被新事实触发。

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 | 相关审查项 |
| ---- | -------- | ---------- | ------------ | ---------- | -------- | ---------- |

### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| ------ | ------ | -------------- | ---------------- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| ---- | -------- | ---------- | ------------ | ---------- | -------- |
