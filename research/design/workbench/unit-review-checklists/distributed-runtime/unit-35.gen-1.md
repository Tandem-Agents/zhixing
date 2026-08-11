## 审查清单

### 当前状态

- **当前单元**：第 35 单元 · generation 1
- **单元身份**：S9 人工灾难恢复与安全域换代；只支持值班设备永久丢失后，由另一台 active anchor-role 设备基于用户明确选择的完整 checkpoint 副本和无回显恢复包，执行 source-less 恢复、旧安全域撤销、恢复根生命周期与逐设备重新加入。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D35-01～D35-09。上游只消费第 33 单元完整可恢复 checkpoint、恢复根激活与 retention 合同，以及第 34 单元 composite authority、installed-generation/current-owner、target-wide candidate、私有 staging、storage governor 和 post-install closure；下游第 36～38 单元能力不进入本清单。
- **交付基线**：以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 完整交付为 67 个变更路径：core 10、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2、当前单元工作台 2。其中 65 个非工作台功能路径形成 U35-07～U35-08 修复后专项冻结指纹 `a20589ca2d358f80e5f51f47b5d6589a5cb86dc77429ee7c9bf3338039e91c35`；同期 Unit 34 历史归档 2 路径及审查与修复状态 2 路径不属于 Unit 35 功能交付，仍在下方路径对账中明确排除。审查必须覆盖完整生产调用图与 67 条 Unit 35 路径，不得仅审新增文件或默认命令路径。
- **生产装配关系**：`zz backup recover/recover-finish` 与 `zz backup root rotate/invalidate/approve-reset/reset` 是用户入口；checkpoint directory/paired inventory 提供候选，strict disaster command、target-wide candidate journal、per-transfer journal、私有 `FileArtifactStore` 与本地 `AuthorityCommitLog` 形成目标恢复链；`MeshRuntimeBootstrap` 与 `MeshRuntimeAssembly` 在 anchor+executor、anchor-only 两个 current-anchor profile 中消费 disaster installation，先完成 installed-generation/runtime/consumer 重绑再开放 current-owner surface。Credential exposure authority 同时接入 capability publication、provider/channel/MCP/webhook/rendezvous 秘密读取与 pairing/bootstrap 路由。
- **目标提交边界**：交付 source-less checkpoint inventory、恢复根真解封与现场验证、no-rollback baseline、私有完整导入、root-signed commit/abort、原子 composite authority 安装、旧 issuer/epoch/route/binding fencing、旧设备隔离后 tombstone、恢复根 rotate/invalidate/domain-reset-establish、pending-reenroll/fresh pairing、公开零术语旅程、两生产根 exact-set/S7 与必要直接证据。
- **明确排除**：自动 failover、quorum/witness、自动升主、持续或全局同步、恢复应用、业务数据恢复向导、多目标/云备份、通用 transfer/registry/lifecycle/事务/outbox/事件总线；第 36 单元托管服务与角色自恢复、第 37 单元停机/移除/卸载、第 38 单元升级发布；单设备原地重置、issuer 与恢复包同时丢失后的绕过；监控、诊断、benchmark 与信息采集。
- **架构空洞判定**：总纲 §9、规格 §6.3/§6.4/§7/§8/§15 与 D35-01～D35-09 已唯一确定本单元产品、状态、安全、拓扑和交付边界；当前没有需以实现假设补齐的真实需求空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：0 项 `[ ]`、38 项 `[x]`、0 项 `[!]`、0 项 `[~]`；IR35-05、IR35-10、IR35-14～IR35-15、IR35-29、IR35-31～IR35-33、IR35-36 已在当前输入上复审通过，其余 29 项原 `[x]` 结论直接复用。全部适用来源、功能链与交付路径均已覆盖；两类问题表为空，独立审查通过。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线值班设备、真实本机执行与灾后恢复核心目标归入 IR35-01、IR35-24、IR35-33。 |
| 需求文档 §二 | 不适用 | 外部回答汇总是需求形成材料，不独立产生 Unit 35 规范。 |
| 需求文档 §三 | 不适用 | 历史实现核验不替代当前灾难恢复合同。 |
| 需求文档 §四 | 不适用 | 历史架构审核过程不产生当前字段、状态或验收门禁。 |
| 需求文档 §五 | 不适用 | 历史现状归纳不产生本单元义务。 |
| 需求文档 §六 | 适用 | 值班设备可替换、用户拥有恢复控制权和真实设备环境不迁移归入 IR35-01、IR35-08、IR35-24。 |
| 需求文档 §七 | 适用 | 最小完整产品、正确性/安全性/体验优先级归入 IR35-01、IR35-33、IR35-37。 |
| 需求文档 §八 | 不适用（直接） | 本章描述 planned migration 的目标列表与迁居阶段；Unit 35 仅继承“设备名、可行动状态、零内部术语”的通用体验，由总纲 §11 和 IR35-33 承载，不把 planned source 流程并入 DR。 |
| s2-security-supply-chain-review.md「范围说明」 | 适用（兼容边界） | 当前交付修改 `@zhixing/mesh` trust/checkpoint/native bridge；只核对既有受管依赖边界，不宣称仓库级供应链结论，归入 IR35-35。 |
| S2 评审「裁决」 | 适用（兼容边界） | 三项生产依赖与 PAKE 开发依赖用途不得因恢复入口漂移，归入 IR35-06、IR35-29、IR35-35。 |
| S2 评审「强制门禁」 | 适用（兼容边界） | 精确锁版、owner、PAKE 非生产隔离与 package import/export/build 门禁归入 IR35-35～IR35-36。 |
| S2 评审「接受依据」 | 适用（兼容边界） | 恢复不新增密码依赖，不改变 TLS/证书/PAKE 边界，归入 IR35-06、IR35-29、IR35-35。 |
| distributed-runtime-charter.md「当前版本交付原则」 | 适用 | 最小完整范围、架构优先和禁止未来框架预建归入 IR35-01、IR35-37～IR35-38。 |
| 总纲「一、架构概况」「二、凝练需求」 | 适用 | 单一产品、唯一 current anchor、恢复控制权和“值班/干活”语言归入 IR35-01、IR35-24、IR35-33。 |
| 总纲 §1 架构结论 | 适用 | 唯一权威、同一协议内核、source-less 恢复后单 current owner 归入 IR35-12～IR35-18、IR35-24。 |
| 总纲 §2 角色模型 | 适用 | eligible anchor target、current issuer、paired receiver、pending-reenroll 与未启用角色 exact-set 归入 IR35-03、IR35-24、IR35-34。 |
| 总纲 §3 包与依赖边界 | 适用 | core/mesh/providers/server/CLI 分层、组合根职责与无环依赖归入 IR35-35～IR35-38。 |
| 总纲 §4 设备网格与安全协议 | 适用 | 恢复根、trust event/record、签名、设备撤销、issuer/epoch 换代归入 IR35-04、IR35-13～IR35-16、IR35-25～IR35-29。 |
| 总纲 §5 权威矩阵与执行清单 | 适用 | 全局/会话/内容/执行资产恢复，环境/秘密/缓存排除归入 IR35-08～IR35-12、IR35-19。 |
| 总纲 §6 run 派发协议 | 适用（消费闭包） | 不改 run 协议；只审 installation 后既有 assignment/final/interaction 等义务归新代际且旧 epoch 拒绝，归入 IR35-17～IR35-18。 |
| 总纲 §7 环境模型与路由 | 适用（负边界） | 环境事实、workspace 路径和设备缓存不得进入 checkpoint/catalog/import，归入 IR35-08、IR35-29。 |
| 总纲 §8 双平面通信 | 适用（传输边界） | directory/paired target 与认证 mesh 只传输同一冻结恢复身份，不成为事实源，归入 IR35-03、IR35-05～IR35-07、IR35-22。 |
| 总纲 §9 离线本地会话、收编与迁居 | 适用（最高直接依据） | 人工 DR 的 inventory、真解封、baseline、私有导入、原子 commit、generation closure、credential exposure、tombstone、root lifecycle、pending-reenroll 逐项归入 IR35-02～IR35-28。planned/conversation 分支只作严格模式隔离。 |
| 总纲 §10 凭据与服务生命周期 | 适用（Unit 35 部分） | compromised/rotated exposure 与逐 binding 路由阻断直接适用；托管服务/卸载属 Unit 36～38，归入 IR35-19～IR35-21、IR35-37。 |
| 总纲 §11 产品体验设计 | 适用 | 用户明确选备份、无回显回读、旧设备隔离确认、恢复码管理及零术语错误归入 IR35-02、IR35-23、IR35-33。 |
| 总纲 §12 故障矩阵 | 适用 | 旧锚点丢失、伪 verification、网络/磁盘/响应丢失、重启、错身份、旧根与凭据泄露归入 IR35-04～IR35-32、IR35-36。 |
| 总纲 §12.1 S9 恢复根与备份状态边界 | 适用（上游合同） | 只消费 current verified full checkpoint、真解封与 root-activation；不得改写 Unit 33 retention/readiness，归入 IR35-03～IR35-08、IR35-35。 |
| 总纲 §13 不变量清单 | 适用 | 唯一权威、旧 epoch 永拒、原子事实、秘密隔离、资源治理、零未启用 owner 等归入 IR35-09～IR35-32、IR35-34～IR35-36。 |
| 总纲 §14 实施序列 | 适用（Unit 35） | S9 Unit 35 全部适用；Unit 36～38 不适用，归入 IR35-01、IR35-37。 |
| 总纲 §15 验收纲 | 适用 | 正常、边界、故障、恢复、对抗、双拓扑与零认知恢复演练归入 IR35-32～IR35-36。 |
| specification.md §1.1 | 适用 | request/transfer/checkpoint/target/root identity、anchor/trust epoch、时间与幂等归入 IR35-02～IR35-05、IR35-13、IR35-30。 |
| 规格 §1.2 | 适用 | JCS、schema/version、digest/signature/ref 与 checkpoint/trust/commit 摘要域归入 IR35-04～IR35-16、IR35-29～IR35-30。 |
| 规格 §1.3、§1.3b | 适用（兼容边界） | 新合同从 core 权威导出，既有冻结符号不复制；S1 符号清单本身不新增 Unit 35 义务，归入 IR35-35。 |
| 规格 §1.4 | 适用 | DisasterRecoveryCommand/Result、AnchorTransferCommit、HomeTrustRecord 等总纲名与实现名全等，归入 IR35-04、IR35-13～IR35-15。 |
| 规格 §1.5 | 适用 | unauthorized/conflict/unavailable/not-ready 等稳定内部分类映射为安全公开错误，归入 IR35-04、IR35-30、IR35-33。 |
| 规格 §2.1 | 适用 | recovery-root establish/rotate/invalidate、domain-reset、issuer-transition、DR commit、HomeTrustRecord 严格合同归入 IR35-13～IR35-16、IR35-25～IR35-28。 |
| 规格 §2.2 | 适用（换代边界） | 旧 capability/lease/ticket 不得恢复写权；新代际按既有激活事实重建，归入 IR35-17～IR35-18、IR35-29。 |
| 规格 §2.3 | 适用 | 恢复主秘密、issuer key 与第三方秘密只进 SecretStore、锁定时 fail-closed，归入 IR35-02、IR35-06、IR35-19～IR35-21、IR35-29。 |
| 规格 §2.4 | 适用（直接） | active/compromised/rotated exposure、latest projection、设备撤销清单与 binding route guard 归入 IR35-19～IR35-21。 |
| 规格 §2.5 | 适用（复用边界） | pairing/reenroll、认证 mesh、strict receiver、rendezvous guard 与连接重放归入 IR35-22、IR35-28～IR35-29、IR35-34。 |
| 规格 §3.1、§3.2、§3.2b | 适用（恢复覆盖） | SessionState/GlobalState/DeferredIntent 已提交事实和待办须由 composite authority 与 post-install consumer 完整恢复，归入 IR35-09～IR35-12、IR35-17。 |
| 规格 §3.3 | 适用（负边界） | EnvironmentPort 与原始设备路径不恢复、不迁移，归入 IR35-08、IR35-29。 |
| 规格 §3.4、§3.4b | 适用 | 业务租约按新 epoch 恢复/拒绝；inventory/unseal/import/cleanup 使用唯一 storage governor、可取消且 permit 不跨网络/锁，归入 IR35-17、IR35-22、IR35-31。 |
| 规格 §3.5～§3.8 | 适用（消费与安全边界） | completion、dispatch/submission/mirror/control guard 的既有 pending/终态只由当前 owner 恢复，归入 IR35-17～IR35-18、IR35-29。 |
| 规格 §4.1 | 适用 | 唯一 `AuthorityCommitLog`、原 envelope 解码、composite base、单 envelope/单 sync 原子发布与投影重建归入 IR35-07、IR35-09～IR35-18。 |
| 规格 §4.2 | 适用 | artifact 先耐久后引用、private store、retained exact-set、共享 CAS 提升和缺件拒绝归入 IR35-05～IR35-11。 |
| 规格 §4.3 | 适用 | DR transfer、trust、checkpoint、exposure、installation、pending 记录严格单调可重放，归入 IR35-04、IR35-12～IR35-22、IR35-25～IR35-28。 |
| 规格 §4.3 delivery 生命周期 | 适用（消费闭包） | 不改十五行 delivery 状态机；只核对其未终态义务随 installed generation 归新 owner，归入 IR35-17～IR35-18。 |
| 规格 §4.4 | 适用（兼容边界） | 恢复不得重判 staged/publish 事实，只恢复已提交 authority/pending，归入 IR35-09、IR35-17。 |
| 规格 §4.5 | 适用 | private staging abort 清理、共享 ref 保留、tombstone 与 exposure 历史不可误删，归入 IR35-11、IR35-16、IR35-21～IR35-22。 |
| 规格 §5.1～§5.7 | 适用（入口/消费/终态边界） | 控制、派发、提交、status/final/stream/evidence 均不得绕过 current-owner 与新 generation；不改既有 wire，归入 IR35-17～IR35-18、IR35-24、IR35-29。 |
| 规格 §6.1、§6.2、§6.2b | 适用（安装后消费边界） | 不重审各行业务状态机；逐行确认六类未终态 obligation 在 post-install 有唯一恢复 owner，旧 epoch 不可继续，归入 IR35-17～IR35-18、IR35-32。 |
| 规格 §6.3 | 适用（直接枚举行） | DR 行 0b、2、3b、5b、6、7、8 分别归入 IR35-04～IR35-16；planned/conversation 行只用于模式隔离与共用 primitive 边界，归入 IR35-04、IR35-35。 |
| 规格 §6.4 | 适用（逐行） | 行 1～5 是目标 active/ready 前置；行 6～9 是撤销/旧设备安全域换代；行 10～11 是 domain-reset→pending-reenroll→fresh reenroll，归入 IR35-03、IR35-16、IR35-19、IR35-25～IR35-28、IR35-32。 |
| 规格 §7 | 适用（六类逐行） | 全局、会话、会话资产、环境/秘密、执行资产、非权威缓存六类分别决定恢复/禁止恢复/重建与完整 checkpoint coverage，归入 IR35-08～IR35-11、IR35-29。 |
| 规格 §8 | 适用（入口 exact-set） | `disaster-recovery`、`recovery-root-lifecycle` 直接适用；`recovery-backup`/`device-trust` 为上游与 reenroll；其余 registry 行用于反向核对 post-install/current-owner 消费面，归入 IR35-02、IR35-17～IR35-18、IR35-23～IR35-28、IR35-34。 |
| 规格 §9 | 适用（拓扑兼容） | anchor/current-owner 恢复后能力矩阵不扩权；executor-only/local-domain/纯 surface 不得成为 DR owner，归入 IR35-18、IR35-24、IR35-29、IR35-34。 |
| 规格 §10 | 适用（既有资源终态边界） | 恢复后的业务 lease 只按原状态机处理，不伪造重放授权，归入 IR35-17～IR35-18、IR35-31。 |
| 规格 §10.1 | 适用（直接资源边界） | inventory、unseal、import、CAS、native I/O、cleanup 的容量、取消、stop、锁序与物理步骤上界归入 IR35-05～IR35-07、IR35-22、IR35-31。 |
| 规格 §11 | 适用 | 恢复/撤销/换密钥/双重灾难文案与用户选择归入 IR35-02、IR35-19、IR35-23、IR35-25～IR35-28、IR35-33。 |
| 规格 §12 | 适用 | 相关不变量、6.3/6.4 逐边、签名篡改、崩溃点、双拓扑与零副作用证据归入 IR35-29～IR35-36。 |
| 规格 §13 | 不适用（独立新增文档） | 模块文档影响清单没有 Unit 35 独立条目；当前总纲/规格同步由 D35-09 与 IR35-35 判定，不据此扩写其他模块文档。 |
| 规格 §14 | 不适用 | S1 开工清单已完成且不属于 Unit 35。 |
| 规格 §15 | 适用（Unit 35） | 通用提交纪律、第 35 项及 33→35 前置顺序全部适用；第 36～38 项不适用，归入 IR35-01、IR35-35～IR35-37。 |
| unit-development-workbench.md 静态规则、§一～§三 | 适用（身份/范围/流程来源） | 确认当前 Unit 35、最小完整边界、架构空洞裁决与已完成开发状态；不产生独立运行时合同，归入 IR35-01、IR35-37～IR35-38。 |
| 开发清单 D35-01 | 适用 | strict DR mode、command/result、状态、identity、commit/abort 归入 IR35-04、IR35-13～IR35-16、IR35-30。 |
| 开发清单 D35-02 | 适用 | source-less inventory、公开投影与用户选择归入 IR35-02～IR35-03、IR35-23、IR35-33。 |
| 开发清单 D35-03 | 适用 | candidate claim、真解封、现场 verification、baseline 与异常归入 IR35-03～IR35-07、IR35-30～IR35-32。 |
| 开发清单 D35-04 | 适用 | ReadyProof、catalog、private import、retained closure 与 CAS 归入 IR35-08～IR35-11、IR35-22。 |
| 开发清单 D35-05 | 适用 | root-signed commit、atomic install、old issuer revoke、exposure compromised 归入 IR35-12～IR35-16、IR35-19。 |
| 开发清单 D35-06 | 适用 | installed generation、consumer closure、current-owner 路由、tombstone 归入 IR35-16～IR35-18、IR35-23～IR35-24。 |
| 开发清单 D35-07 | 适用 | rotate/invalidate/domain-reset-establish/pending-reenroll 归入 IR35-25～IR35-28。 |
| 开发清单 D35-08 | 适用 | exposure lifecycle、per-binding guard、第三方 rotation readiness 归入 IR35-19～IR35-21。 |
| 开发清单 D35-09 | 适用 | CLI UX、topology/S7 exact-set、架构同步与必要证据归入 IR35-23、IR35-33～IR35-38。 |
| 当前完整交付物 65 路径 | 适用（反向闭包） | core 8、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2、当前单元工作台 2 均须归入 IR35-01～IR35-37；63 个非工作台功能路径绑定专项冻结指纹，路径新增、遗漏、重复或越界由 IR35-38 单独判定。 |

### 交付路径反向覆盖

| 路径组 | 数量 | 当前路径（每条只出现一次） | 归入审查项 |
| ------ | ---- | -------------------------- | ------------ |
| CLI 公开入口与用户旅程 | 6 | `packages/cli/src/index.ts`、`packages/cli/src/serve/backup-command.ts`、`packages/cli/src/serve/backup-command.test.ts`、`packages/cli/src/serve/recovery-public-errors.test.ts`、`packages/cli/src/setup-delivery.ts`、`packages/cli/src/__tests__/setup-delivery.test.ts` | IR35-02、IR35-16、IR35-23、IR35-25～IR35-28、IR35-30、IR35-33～IR35-36 |
| CLI disaster authority、candidate、inventory 与 target | 11 | `packages/cli/src/serve/disaster-recovery-authority.ts`、`packages/cli/src/serve/disaster-recovery-candidate.ts`、`packages/cli/src/serve/disaster-recovery-command.ts`、`packages/cli/src/serve/disaster-recovery-installation.ts`、`packages/cli/src/serve/disaster-recovery-installation.test.ts`、`packages/cli/src/serve/disaster-recovery-inventory.ts`、`packages/cli/src/serve/disaster-recovery-inventory.test.ts`、`packages/cli/src/serve/disaster-recovery-target.ts`、`packages/cli/src/serve/disaster-recovery-target.test.ts`、`packages/cli/src/serve/disaster-recovery-trust-evidence.ts`、`packages/cli/src/serve/disaster-recovery-trust-evidence.test.ts` | IR35-03～IR35-18、IR35-22、IR35-24、IR35-29～IR35-36 |
| CLI trust、pairing 与 root lifecycle | 8 | `packages/cli/src/serve/mesh-bootstrap-store.ts`、`packages/cli/src/serve/mesh-control-plane.ts`、`packages/cli/src/serve/mesh-pair-command.ts`、`packages/cli/src/serve/mesh-pair-command.test.ts`、`packages/cli/src/serve/paired-checkpoint-runtime.ts`、`packages/cli/src/serve/recovery-root-activation.ts`、`packages/cli/src/serve/recovery-root-establishment-runtime.ts`、`packages/cli/src/serve/recovery-root-lifecycle.ts` | IR35-06～IR35-07、IR35-15、IR35-18、IR35-24～IR35-31、IR35-34～IR35-36 |
| CLI runtime、installed generation 与 exposure 装配 | 13 | `packages/cli/src/serve/access-surface.ts`、`packages/cli/src/serve/access-surfaces.ts`、`packages/cli/src/serve/command.ts`、`packages/cli/src/serve/credential-exposure-authority.ts`、`packages/cli/src/serve/credential-exposure-authority.test.ts`、`packages/cli/src/serve/credential-rotation-publication.ts`、`packages/cli/src/serve/credential-rotation-publication.test.ts`、`packages/cli/src/serve/mesh-runtime-assembly.ts`、`packages/cli/src/serve/mesh-runtime-bootstrap.ts`、`packages/cli/src/serve/planned-anchor-transfer.ts`、`packages/cli/src/serve/planned-anchor-transfer.test.ts`、`packages/cli/src/serve/target-wide-anchor-candidate.ts`、`packages/cli/src/startup.ts` | IR35-05、IR35-14、IR35-17～IR35-24、IR35-29～IR35-36 |
| core authority、严格合同与 reducer | 10 | `packages/core/src/authority/__tests__/authority-storage.test.ts`、`packages/core/src/authority/artifact-retention.ts`、`packages/core/src/authority/commit-log.ts`、`packages/core/src/authority/index.ts`、`packages/core/src/contracts/identity.ts`、`packages/core/src/contracts/records.ts`、`packages/core/src/contracts/schema.ts`、`packages/core/src/protocol/anchor-transfer.ts`、`packages/core/src/protocol/anchor-transfer.test.ts`、`packages/core/src/protocol/index.ts` | IR35-04～IR35-16、IR35-19、IR35-29～IR35-33、IR35-35～IR35-36 |
| mesh 冻结物理根与 child bridge | 3 | `packages/mesh/native/checkpoint_child_bridge.cc`、`packages/mesh/native/checkpoint_child_bridge.cs`、`packages/mesh/src/checkpoint-child-bridge.ts` | IR35-03、IR35-10～IR35-11、IR35-22、IR35-29、IR35-31、IR35-35～IR35-36 |
| mesh checkpoint capture、inventory 与 paired target | 6 | `packages/mesh/src/__tests__/anchor-transfer-ready.test.ts`、`packages/mesh/src/__tests__/full-authority-checkpoint.test.ts`、`packages/mesh/src/anchor-transfer-ready.ts`、`packages/mesh/src/checkpoint-target.ts`、`packages/mesh/src/checkpoint.ts`、`packages/mesh/src/paired-checkpoint-target.ts` | IR35-03、IR35-06、IR35-08、IR35-10～IR35-13、IR35-22、IR35-29～IR35-32、IR35-35～IR35-36 |
| mesh trust 与 credential exposure | 2 | `packages/mesh/src/credential-exposure.ts`、`packages/mesh/src/trust-chain.ts` | IR35-07、IR35-19～IR35-21、IR35-25～IR35-30、IR35-35～IR35-36 |
| provider credential 读取守卫 | 1 | `packages/providers/src/credentials-loader.ts` | IR35-20～IR35-21、IR35-29、IR35-35 |
| server canonical registry golden | 1 | `packages/server/src/__tests__/__goldens__/canonical-registry.golden.json` | IR35-23、IR35-33～IR35-34、IR35-36 |
| 既有 S7 descriptor/validator 与变异证据 | 2 | `scripts/s7-entry-coverage.mjs`、`scripts/s7-entry-coverage.test.mjs` | IR35-24、IR35-29～IR35-30、IR35-34～IR35-36 |
| 权威架构与可执行规格 | 2 | `research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md` | 由上方逐章来源表归入 IR35-01～IR35-38 |
| 当前单元工作台 | 2 | `research/design/workbench/unit-development-workbench.md`、`research/design/workbench/unit-submit-review.md` | 前者归入 IR35-01、IR35-37～IR35-38；后者只承载本清单与 IR35-38 的路径闭包，不作为运行时事实证据 |
| 上一单元收口记录（明确排除） | 2 | `research/design/workbench/unit-review-checklists/distributed-runtime/unit-34.gen-1.md`、`research/design/workbench/unit-review-ledgers/unit-34.gen-1.md` | 已分别归档 Unit 34 清单与记录 Unit 34 封版事实；不属于 Unit 35 功能、测试或验收义务，不计入上方 65 条，只有文件身份或内容越界进入 Unit 35 时才重开范围判定 |
| 审查与修复状态（流程记录，明确排除） | 2 | `research/design/workbench/unit-review-workbench.md`、`research/design/workbench/unit-review-ledgers/unit-35.gen-1.md` | 前者维护静态协议/当前指针，后者保存 Unit 35 正式问题与专项证据；两者不属于产品交付、功能指纹或独立审查运行时事实，内容越界修改架构/产品合同才重开范围判定 |

### 审查项

| 编号 | 状态 | 审查主题 | 独立判定对象、停止条件与证据 |
| ---- | ---- | -------- | ---------------------------- |
| IR35-01 | [x] | 单元身份、架构与范围 | 复核总纲 S9 人工灾难恢复边界、规格第 35 项、D35-01～D35-09 与 65 条交付路径：当前实现只服务手动 source-less authority 恢复、恢复根/凭据安全闭环及直接验收；未引入自动 failover、持续同步、恢复应用或 Unit 36～38 能力，也不存在会改变边界的需求空洞。证据：来源逐章表、开发清单、交付路径反向分类及生产入口扫描。 |
| IR35-02 | [x] | 恢复包与公开入口前置 | CLI 仅以显式 `backup recover/recover-finish` 与 root 子命令进入；恢复包没有 argv 选项，生产路径统一调用 `readRecoveryPackageFromTty`，其要求双端 TTY、独占 stdin、raw-mode 无回显、16 MiB 上限并在 `finally` 清零/恢复。取消、空/错 v1/v2 包、非 TTY 与重复 finish 均在副作用前拒绝或进入既有耐久重放。证据：`index.ts`、`recovery-package-input.ts`/测试、command/codec 测试。 |
| IR35-03 | [x] | source-less inventory 与候选选择 | directory inventory 只从冻结物理根读取已发布目录，重验 manifest/envelope/chunk exact-set 并过滤非 full authority；paired inventory 严格反绑 request/target/recipient 并拒绝重复 checkpoint。候选按时间、target、checkpoint 稳定排序，唯一项自动选中，多项必须给合法序号；公开投影仅含序号、位置、备份时间和待验证状态。证据：`checkpoint-target.ts`、`paired-checkpoint-target.ts`、`disaster-recovery-inventory.ts` 及其直接测试。 |
| IR35-04 | [x] | strict DR command/result 与状态联合 | core 将 DR command/result/state 建模为独立判别联合，逐 op/status 校验 exact keys、v1 schema、恢复根/目标 issuer 签名及 originating request/transfer；reducer 同时反绑 mode、prepare/import/commit/abort/tombstone 身份并拒绝跨 planned/conversation 混型、终态逆转和字段污染。证据：`anchor-transfer.ts`、contracts/schema 导出及逐字段污染/reducer 测试。 |
| IR35-05 | [x] | target-wide candidate 单飞 | `claim()`、verified/install-decided 与 candidate terminal 仍通过同一 `FileAuthorityCommitLog.transactProjection()` 同时投影 per-transfer 与 target-wide 状态；verified/decision 只把无界正文换成先 fsync 的 content-addressed ref，事务内仍只追加恰一 phase，same-transfer exact replay、异 transfer busy、abort/decision 互斥及 terminal 后释放语义未分叉。artifact put 后、phase append 前失败只留下无权威引用的普通对象，由既有 GC 处理；append 效果/响应丢失按同 ref 重放。证据：`disaster-recovery-candidate.ts:122-360,368-435`、target-wide reducer、`disaster-recovery-target.test.ts:35-58,169-360` 与 V35-12/V35-14。未发现 P0/P1。 |
| IR35-06 | [x] | 恢复根真解封与现场验证 | `verifyStoredFullAuthorityCheckpoint` 先验 envelope exact shape、recipient、issuer 签名和 digest，再以 X25519/HKDF/AES-GCM 逐 seq 解封固定块并反绑 AAD、nonce、manifest/payload/coverage；声明内容逐 ref/size/digest 写入私有 sink，截断、额外、重排、错 key/target/verification 均在 authority/trust 发布前失败，明文与密钥材料在 `finally` 清零。证据：`checkpoint.ts`、`disaster-recovery-authority.ts` 及篡改/现场 verification 测试。 |
| IR35-07 | [x] | authority/trust 前缀重放与 no-rollback baseline | 生产命令在首个 claim 前启动认证 evidence mesh，冻结本机与当次已认证连接组成的 cut；collector 对 cut 内 peer 使用严格 request/result、signed current record 与 exact suffix，任一请求失败由 `Promise.all` 使整次 attempt 在零 claim/key/import 前失败。selector 对 checkpoint、本机与 peer 链逐祖先比较，取最长兼容链并复验 current root、issuer、epoch 与目标 active anchor 资格；cut/evidence digest 随 candidate 持久化。证据：`disaster-recovery-command.ts`、`disaster-recovery-trust-evidence.ts`、`selectRecoveryBaseline()` 与真实认证 mesh 直接场景。 |
| IR35-08 | [x] | 六类 checkpoint 覆盖与禁止内容 | full payload 仍只接受冻结的 authority/asset coverage；record pages 与 `ArtifactLifecycleIndex` retention exact-set 形成 catalog 六类恢复闭包。payload/header/catalog 均 strict exact keys，递归 checkpoint、缺/多 ref、目录漂移、秘密、环境、物理路径与缓存不能进入有效 full envelope，内容或 digest 不全即在 import 前拒绝。证据：`checkpoint.ts` full validator、Unit 33 capture/retention 生产链与 `buildDisasterRecoveryCatalog()`。 |
| IR35-09 | [x] | 无秘密 AuthorityCatalog 与 pending exact-set | catalog 由已验原 commit pages 顺序重放，逐 LSN 重算 prefix、stream ranges 与 `PendingObligationTracker`，固定六类 coverage、authority record ref、retained refs、baseline trust/current issuer 后再经 `prepareAuthorityCatalog` 规范排序与摘要；其 strict DTO 不含 secret、物理路径或 cache。少/多/乱序 page/ref/record 均在 catalog 发布前失败。证据：`buildDisasterRecoveryCatalog()`、core catalog validator 与真实 log/index 测试。 |
| IR35-10 | [x] | transfer 私有完整导入 | existing verified 由 candidate ref 先经 `FileArtifactStore.get()` 校验 bytes/digest、canonical JSON 与 strict candidate validator，再读取 transfer 私有 authority/catalog；catalog、source head、record pages 与 retained exact-set 逐项全等且 `has()` 同时验 digest/length。任一 payload/root/嵌套 ref 缺失、损坏或错绑均在新 ReadyProof/import/decision/authority 副作用前失败；仅 candidate 已 committed 时允许从共享 CAS 回读。prepared→imported 只追加一次，已有 imported/committed/tombstoned 返回原 imported bytes/refs，不重做 verified。证据：`disaster-recovery-candidate.ts:380-413,643-897`、`disaster-recovery-target.ts:234-493`、`artifact-store.ts:106-108,228-238,462-485`、超限/篡改/verified replay 场景与 V35-11/V35-12。未发现 P0/P1。 |
| IR35-11 | [x] | 共享 CAS 提升与 cleanup 边界 | promotion 只处理已验 authority/catalog/page/retained refs；共享命中复用，缺失对象从 transfer 私有 store 固定块提升，`withPresentReferences` 在安装事务期间保护 retained refs。abort/cleanup 只删除 `stagingRoot/transfers/<transferId>`，不删除共享 CAS；terminal 前 claim 仍占有，当前修改未形成共享误删或未验发布。 |
| IR35-12 | [x] | immutable/composite authority base | `installPlannedAnchorPrefix()` 在同一 log 锁中重放冻结 source envelopes、校验 source LSN/prefix 与 retained refs，写临时 WAL、fsync、原子 rename并重置投影；installation entries 与 immutable source prefix 在一个 envelope 可见。当前 U35-03 只把安装输入冻结到 decision，没有拆分或旁路 composite base 的单一发布点。 |
| IR35-13 | [x] | DR commit 身份与签名 | ReadyProof 仍严格绑定 request/transfer/candidate、baseline evidence、目标身份与 production readiness snapshot；existing verified 必须读取并全等校验已耐久 transfer key，错绑/缺失 fail-closed，commit 在 decision 前再次 reserve/validate expiry 与 revision。commit、installation 与 recovery-root signature 的 identity 校验未发现旁路。 |
| IR35-14 | [x] | 单 envelope 原子安全域发布 | decision artifact 经 digest/canonical/strict/identity 验真后冻结完整 installation entries、installation 与 candidate ref exact-set；commit 在 CAS 提升和最终 ReadyProof reservation 复验后才耐久 install-decided。其后只以冻结 decision 调用既有 `installPlannedAnchorPrefix()`，由同一 authority envelope 原子发布 trust transition、旧 issuer revoke、signed trust/current owner、exposure、commit 与 installed base；exact read-back、active key 与 private committed 成立后才写 candidate terminal。安装效果丢响应由 decision 前滚，历史 committed 只返回冻结结果，不重新安装旧 authority。证据：`disaster-recovery-target.ts:495-688,796-903`、`disaster-recovery-candidate.ts:237-360,777-970`、`disaster-recovery-installation.ts:99-150`、安装响应丢失/超限 decision/篡改 decision 场景与 V35-12。未发现 P0/P1。 |
| IR35-15 | [x] | 双端 phase、abort 与 forward-only | target candidate claim、verified、install-decided、committed/aborted terminal 与 target-wide claim 在同一 log projection 中恢复；install-decided 与 signed abort 事务互斥。abort 先校验 root/prepare/current-installation，再耐久 candidate+target-wide terminal，随后补 per-transfer aborted、compare-delete exact transfer key、删私有 staging并释放 reservation；任一 cleanup 效果丢响应可幂等续驱。commit 决定后只用冻结 decision 前滚，authority exact read-back、private committed和active-key read-back前不写 terminal/释放 claim；startup可补齐同一顺序。证据：`disaster-recovery-candidate.ts:292-360,445-537`、`disaster-recovery-target.ts:495-903,1011-1105`、target-wide reducer、故障切点/claim-only abort/install response loss 场景与 V35-12/V35-14。未发现 P0/P1。 |
| IR35-16 | [x] | 旧设备隔离确认与 tombstone | `recover-finish` 必须收到显式 `--confirm-old-device-isolated`，随后只接受 current disaster installation 的 exact transfer 与已 committed 私有 journal；未确认、错 transfer、未提交均拒绝，重复 tombstone 返回原终态。tombstone 只追加私有 terminal，不修改新 trust/current owner，旧 issuer/epoch 已在 commit 原子 envelope 永久 revoke。证据：CLI finish、`DisasterRecoveryTarget.tombstone()` 与 replay 测试。 |
| IR35-17 | [x] | installed-generation 与 post-install 消费闭包 | live/startup 都在角色装配前调用 `completeDisasterRecoveryInstallationBeforeBootstrap()`；它先补 active key、private committed 与 candidate terminal，再返回 installed generation/pending obligations。三组 consumer、六类 obligation read-back 与 durable post-install receipt 后才 cleanup/open/respond。receipt 后虽删除 transfer artifacts，per-transfer journal、candidate journal、active key 与 authority catalog仍可供后续启动校验，未发现 current-owner gate 早开。 |
| IR35-18 | [x] | current-owner 路由与旧代际 fencing | canonical registry/S7、current-authority/current-conversation router、direct append 与 credential guard 继续共享 signed current trust；live/cold completion 在 gate 关闭期间先重绑 runtime generation/projection/cursor，再恢复三组 consumer和六类 pending，完成 receipt 前所有 current-owner 入口稳定拒绝。旧 issuer 已在安装 envelope revoke，旧 epoch/route/surface 不再被公开准入。证据：assembly transition gate、installed-generation participant receipt、current-owner router exact-set 与 S7。 |
| IR35-19 | [x] | exposure compromised 原子投影 | decision 冻结的 exposure entries仅允许旧 issuer device 的 `compromised` 记录，完整 installation 与 source exposure projection全等校验；它们与 new issuer/current owner/trust/commit 同一 authority envelope 发布。错设备、非 compromised 或变形记录在 candidate decoder/installation validation 前置拒绝，未发现 exposure 单独可见或旧 binding 重新 active。 |
| IR35-20 | [x] | 每条秘密读取路径的 binding guard | provider/channel/MCP 在 generation secret 读取前经 startup guard 映射稳定 logical binding；rendezvous 在 mesh 外联和 pairing 的 guarded store 校验；webhook 当前无启用生产发送器且保留 strict SecretRef/transport 边界。guard 只接受有限种类并排除 device-key，未知 kind fail-closed；compromised 只阻断同 binding，不影响其他 binding。证据：`startup.ts`、mesh control/pairing guarded store、`CredentialExposureAuthority.assertRoute()`、providers loader 与 S7 exact-set。 |
| IR35-21 | [x] | 第三方凭据轮换闭环 | 生产 command 在 authority runtime、MCP 与 channel 接入面就绪后唯一调用 `publishRequiredCredentialRotations()`；它只处理当前 compromised exact-set，按 provider/channel/MCP 分别取得 service-verified principal/readiness，要求 SecretStore 同值回读，并以稳定 request/revision 调用现有 `publishRotation()`，在单 envelope 发布新 active 与旧 rotated。失败保持旧 compromised，其他 binding 隔离。证据：`command.ts:762-780`、`credential-rotation-publication.ts`、`CredentialExposureAuthority.publishRotation()` 与三类直接测试。 |
| IR35-22 | [x] | 资源、物理 I/O、取消与 stop | 命令持有唯一 scoped signal，并贯穿 evidence discovery、inventory open/read、paired wait、prepare/import、promotion 与 commit；directory/paired、unseal、private receiver、CAS promotion 和日志物理步骤复用同一设备 storage governor，固定块/header 有界且网络等待不持 permit。pre-commit 异常在同 catch 生成 root-signed abort，先耐久 candidate terminal 再清理；已安装 commit 只前滚。证据：`runDisasterRecoveryCommand()`、target signal 形参、storage maintenance steps、paired target 与 S7 signal exact-set。 |
| IR35-23 | [x] | 用户恢复旅程与公开 DTO | recover 只显示稳定序号、清洗后的目录 basename/设备名、备份时间与行动阶段；request/transfer/checkpoint/target/root/digest/epoch 均不回显，异常统一映射为无 raw cause/path 的可行动错误。CLI 仅在 durable post-install receipt 后报告旧设备失权，再逐项提示第三方凭据和隔离确认；finish 必须显式确认且 terminal replay 不重走恢复副作用。证据：`disaster-recovery-command.ts`、public error mapper、CLI/server registry golden。 |
| IR35-24 | [x] | topology 与 owner/receiver exact-set | DR owner 仅由显式 CLI recover 在本机为 active anchor 且非 current issuer 时构造；directory/paired adapter 只暴露 checkpoint inventory/read，不注册通用 authority 服务。anchor+executor 与 anchor-only 共用有限入口，executor-only、surface、disabled、旧 issuer、非 anchor、未选 candidate 在 claim 前拒绝；live runtime 仅消费本机已安装 generation。证据：`openRecoveryContext()`、inventory adapters、canonical CLI registry 与 S7 disaster descriptor。 |
| IR35-25 | [x] | 恢复根 rotate 原子计划 | CLI 先确认用户动作、无回显验 current package，再生成并回读 candidate root；root event 同时受旧恢复根授权并携新根 proof。新 full checkpoint 经既有 activation coordinator 写入独立 target、回读验证后才由 current issuer 提交 rotate/verified/superseded 计划，checkpointId 与计划 digest 驱动崩溃重放。任一前置失败不改变本地 current root。证据：`backup-command.ts`、`RecoveryRootLifecycleService.rotate()`、activation coordinator 测试。 |
| IR35-26 | [x] | 恢复根 invalidate | 公开命令要求显式确认、current issuer context 与当前恢复包；root-signed invalidate 经 trust reducer 验 current epoch/root 后同 authority envelope 清除 root/backup key 与 activation digest，后续 backup/DR readiness 如实不可用。旧/错包与重复 event 被链序/reducer 拒绝；恢复只能由 current issuer 重新走现有 full checkpoint establish，不自动开启替代能力。证据：CLI command、lifecycle service、trust-chain reducer。 |
| IR35-27 | [x] | domain-reset + establish 原子计划 | reset/establish reducer、双签校验与 checkpoint activation plan 保持原子；approve-reset 使用独立只读 context，仅从 SecretStore 精确加载唯一既有本机 device key，读取并核对 current signed trust/projection，要求本机 distinct active 且非 issuer，不检查 anchor role、不创建或加载 issuer key、零 authority 写。issuer 端仍经严格 context 汇合 approval 并执行 reset+establish。证据：`backup-command.ts:224-320`、trust reducer、真实 SecretStore/trust 场景与 S7 最小权限 gate。 |
| IR35-28 | [x] | pending-reenroll 与 fresh pairing | domain-reset reducer 将除 issuer 外的全部 active member 原子推进为 `pending-reenroll`；运行中 control plane 每秒重读耐久 trust，`reconcileTrust()` 会断开非 active peer、删除其 rendezvous secret并撤销 surface，冷启动也只装配 active exact-set。pairing 仅对 identity 全等的 pending member生成带 fresh transcript digest 的 `reenroll`，其他已有设备不能走 enroll 绕过；distinct active approval 不可得时 reset fail-closed，不提供单设备原地重建。证据：`trust-chain.ts:145-152,245-277`、`mesh-control-plane.ts:137-203`、`mesh-pair-command.ts:795-838`。 |
| IR35-29 | [x] | 安全、最小权限与数据隔离 | authenticated abort 先由 recovery-root 签名和 originating prepare 全字段反绑，再经 candidate transaction 耐久胜出；仅此后访问 `anchorIssuerKeyRef(transferId)` 并以读得的 deviceId 执行 compare-delete/read-back。fresh creator持本次返回 key identity，在 terminal 竞争前后和失败路径复核并补偿删除；异 identity在 terminal 前拒绝。transfer slot按 transferId隔离，active issuer使用独立ref，install-decided与current installation均禁止abort，故取消不能触及已决定或active key；staging/ReadyProof cleanup同样只限本transfer。证据：`disaster-recovery-target.ts:234-332,691-763`、`device-key-store.ts:59-170`、生产 vault 串行/文件锁语义、verified-before-import/late-creator/claim-only abort场景及 V35-12/V35-14。未发现 P0/P1。 |
| IR35-30 | [x] | 并发、重放、错误关联与 fail-closed | wrong request/transfer/checkpoint/target/root/digest/epoch与异载荷冲突均在副作用前拒绝；verified/imported/decision/terminal同identity exact replay，abort/decision竞争同事务恰一胜出，历史terminal零authority写。32KiB缺口属于可达容量表示错误而非关联或竞争分叉，另由IR35-05/10/14/15承载。 |
| IR35-31 | [x] | lifecycle、启动、停机与连续恢复 | candidate payload 先 content-addressed put、后 phase append；append前故障无权威状态且孤立对象归既有GC，append效果/响应丢失按同ref hydrate。registered roots来自持久 candidate records，terminal不削除payload或嵌套闭包；重启后projection只持ref并在锁外重建完整状态。verified/imported、install-decided/authority/private/terminal各切点均从candidate、per-transfer journal与current installation前滚；startup在candidate terminal前补active key/private committed。abort terminal后key delete、staging删除与reservation release均幂等，晚到creator复核同terminal补偿。证据：candidate/target/installation生产链、`artifact-retention.ts:67-132,245-291`、真实terminal GC/reopen与install response loss/late creator测试、V35-11/V35-12。未发现 P0/P1。 |
| IR35-32 | [x] | 状态机枚举行与必要故障证据 | claimed/verified/imported/install-decided/authority-installed/private-committed/terminal及aborted枚举行均由candidate、per-transfer和installation reducer交叉约束；第二prepared、无decision committed、decision后abort和terminal逆转均拒。直接证据覆盖普通与超限verified/decision、变化时钟的verified/imported replay、真实registered-root GC/reopen、payload篡改、安装效果丢响应、verified未imported abort、abort查空后晚到creator及claim-only abort；authority-storage另机械验证32 KiB边界、present-reference guard和GC竞态。S7 mutation拒绝inline回退、漏registered root、retention版本回退、锁内hydration、缺creator复核和terminal提前。证据：target 9个场景、authority-storage registered-root单例、S7相关有限gate及V35-11～V35-14。未发现 P0/P1。 |
| IR35-33 | [x] | 产品体验与范围价值 | artifact-backed candidate 对用户完全透明，合法长期 home 的完整 authority/catalog 不再因内部32 KiB记录上限失败；公开流程仍只展示清洗后的备份位置、时间、待验证/恢复/接管阶段和可行动统一错误，不回显request/transfer/checkpoint/target/root/ref/digest、路径或raw cause。authenticated cancel先落耐久终态并同步收束无消费者transfer key，不增加提示、二次操作或误报成功；commit仅在post-install receipt后报告旧设备失权。实现只复用现有artifact/GC/SecretStore helper，未引入自动failover、同步、恢复应用或Unit36～38能力。证据：`disaster-recovery-command.ts:80-272`、candidate/target内部链、公开错误/registry既有结论及超限/取消直接场景。未发现 P0/P1。 |
| IR35-34 | [x] | S7、registry、descriptor 与生产 exact-set | S7已冻结verified-first、禁止第二prepared、install-decided存在、authority/private/active-key read-back前零terminal及两生产根装配；mutation可拒绝顺序回退。32KiB是数据表示边界，最小完整验收应复用既有直接测试与FileArtifactStore，不需要扩建S7或新runner，本项无独立P0/P1。 |
| IR35-35 | [x] | 分层、上游兼容与供应链 | 变更仍由core authority/protocol、mesh ReadyProof与CLI组合分层承担；无package/lockfile、新依赖、反向引用或PAKE生产变化。P0最优修复可在现有candidate journal旁复用`FileArtifactStore`保存canonical payload并只记ArtifactRef，无需第二journal或通用事务/存储框架。 |
| IR35-36 | [x] | 成比例的直接验收闭包 | 当前功能输入仍为专项指纹 `a20589ca2d358f80e5f51f47b5d6589a5cb86dc77429ee7c9bf3338039e91c35` 对应的65个非工作台路径，HEAD `b6323cb8`仅含该修复闭包；本轮只修改审查工作台。V35-11以真实authority log/artifactStore/GC验证registered roots与嵌套闭包，V35-12以真实candidate/per-transfer/SecretStore/authority链9/9覆盖超限、篡改、response loss和late creator，V35-14的18/18 S7及registry golden拒绝结构回退，V35-15 workspace build成功；V35-13仅诊断到闭包外既有类型错误且本轮文件零新增。证据输入与当前源码一致，无需重复执行同输入验证，也不存在应用包全测或模块回归的必要性。未发现 P0/P1。 |
| IR35-37 | [x] | 后继能力与非目标边界 | 当前实现与修复建议均限制在手动source-less恢复的candidate payload、既有private staging/FileArtifactStore和transfer key cleanup；未引入自动failover、持续/全局同步、恢复应用、托管服务、卸载、云、多目标或通用基础设施，第36～38单元边界未变化。 |
| IR35-38 | [x] | 来源、D35义务与交付路径反向闭包 | 四份权威来源、D35-01～D35-09、67条Unit35交付路径和65条非工作台功能路径均已归项；新增的artifact-retention生产文件与authority-storage直接测试已纳入core反向覆盖，未改变单元边界。 |

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
