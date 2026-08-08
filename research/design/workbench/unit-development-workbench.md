# 单元开发工作台

> **维护原则**
>
> - 以独占一行的“开发清单”标题为界：此前为静态区，保存长期规则与用户提示词，不随开发单元重置；该标题及其后为动态区，只保存当前单元的开发清单。分隔线仅用于视觉区隔，不承担区域边界语义。
> - 动态区只固定“当前单元”“开发事项”标题、状态说明及空表，不建立独立文档、不归档。
> - 重置步骤：仅当全部开发事项均为 `[x]` 且用户明确要求结束或切换单元时，才将模块、单元、来源、边界和排除项恢复为 `—`，清空全部开发事项并将进度恢复为 `0%`；存在 `[ ]` 或 `[!]` 时禁止重置，历史摘要不构成重置授权。只重置动态区，不得删除固定骨架或改动静态区。
> - 下一单元的来源、边界、开发事项及应交付的实现与测试必须重新生成，不得继承上一单元内容。
> - 提示词由用户维护；未经用户明确授权，不得新增、删除或修改提示词，规则变化也不得自动同步到提示词。

## 一、背景信息

知行分布式运行时（`distributed-runtime`）模块第 23 开发单元（surface 内容资产授权与生命周期治理）的实现约耗时 2 小时，后续审查与修复却耗时 4 天半。复盘表明，根因是进入审查时交付物仍不完整：审查阶段既在补做开发阶段本应完成的功能，又在处理大量遗留问题。

在审查阶段补开发，必须反复经历“发现问题—修复—构建验证—再次审查”，使原本一次可完成的实现工作额外叠加多轮审查与验证成本。本工作台用于把范围识别和实现完整性控制前移到开发阶段，确保进入审查时实现已经完整，审查只负责发现残余问题，而不是继续完成开发。

## 二、目标与边界

本工作台前移的是开发范围的识别与完整实现，不是把独立审查或单元提交验证搬到开发阶段。开发前必须依据架构、需求和上下游合同，明确本单元应完成的边界、功能链与异常场景；开发时一次性完成这些已知义务，不得把未考虑或未实现的功能留给审查阶段补做。

### 交付优先级与扩张门禁

开发清单只承载当前单元的**最小完整产品范围**：权威来源明确要求的核心功能，以及缺少就会阻断核心使用、破坏既定产品体验或违反冻结合同的直接依赖。范围内必须好用、完整并采用最优架构；“最优”不得被解释为增加功能、预建未来能力或扩大验证设施。

任何新增事项都必须写出权威来源和当前必要性。非核心增强、未来单元能力、通用化预留、纯观测/benchmark、诊断平台、推测性防御和非必要重构不得进入开发事项；可以作为未来建议，但不得阻塞当前单元。无法判断的是产品范围变化时才交由用户确认，不能用架构偏好自行扩面。

清单定稿和开发完成后立即进入下一阶段，不得因“还可以更完整”反复扩充已经闭合的范围。

开发阶段只执行支撑当前实现所必需的直接验证，不进行重复的全量审查与重型验证。审查阶段只负责发现完整实现后的残余缺陷；本单元的已知范围必须在进入审查前全部落实，不能等到审查时才识别或补做。

开发清单只定义“必须交付什么”：每项写清功能范围、边界、场景、应实现行为及直接相关的测试代码，不登记“测试通过”“连续审查无问题”“达到可提交状态”等质量状态。勾选只表示对应实现与测试已经编写，不代表审查或单元提交验证通过。

### 架构与需求空洞裁决

1. 现有架构总纲、规格和边界能够唯一推出清晰、可行且无明显副作用的最优方案：这只是文档细节不足，应自行补齐并继续开发，不应停工。
2. 产品目标、用户体验、功能边界和外部合同已经明确，只剩架构或实现路径需要选择：这不是需求空洞。架构者必须以整体最优、长期可维护、可扩展且不留债务为唯一标准，自主完成架构决策、补齐设计并继续开发，不得把架构选择上抛给用户。
3. 现有权威来源无法确定产品应提供什么行为、体验或边界，且不同选择会形成实质不同的产品结果：这才是需要用户确认的需求空洞。必须停止并说明缺失的需求事实及各选择的产品影响，等待用户裁决；不得用架构偏好替代产品决策。
4. 是否需要用户裁决只看产品需求是否缺失，不看架构方案是否多、实现是否复杂或工程成本是否较高。若最优方案需要改变既定产品范围或外部合同，应按需求边界变化处理并提交用户确认。

## 三、用户提示词

### 3.1 生成开发清单

```
先按本工作台维护原则处理动态区：当前单元为空时直接继续；仍登记上一单元且全部开发事项均为 `[x]` 时，先重置动态区并保留固定骨架，再生成下一单元清单；存在 `[ ]` 或 `[!]` 时立即停止，不得清空旧内容。

完整读取下一开发单元的架构总纲、可执行规格或执行计划、上下游合同与验收要求，确认单元身份和边界。存在架构总纲时以其为最高依据，开发范围与方案不得偏离架构设计；文档不足以确定边界时，明确指出架构空洞并停止定稿，不得用实现假设补齐。

按照本工作台“目标与边界”，把开发阶段必须完成的功能范围、生产端与消费端、状态与异常路径、边界条件、非默认场景及直接相关的测试代码，拆成有限、可执行的开发事项，写入动态区。明确不属于本单元的内容只写入“明确排除”字段，不得生成开发事项。每项只写清必须交付的实现与测试，不得写入审查轮次、验证结果或可提交状态；动态区不得沿用上一单元的分类或内容。

本任务只建立开发清单，完成后立即停止。
```

### 3.2 审查开发清单

```
不得沿用生成清单时的范围判断。重新完整读取当前单元的权威架构、可执行规格或执行计划、上下游合同与验收要求，审查动态区开发清单；目标是在清单定稿前收齐全部已知开发义务，避免后续审查才发现功能范围遗漏。

先从权威来源正向核对本单元全部适用要求是否已有开发事项，再沿每条功能链核对生产端、消费端、装配入口、状态与异常终态、直接相关的测试代码，以及适用的边界条件、非默认场景、并发、安全、资源和兼容性要求，最后反向确认每个事项都有架构依据且没有越出单元边界。

通过标准：本单元的全部已知开发义务均有明确落点；每项只描述必须交付的功能范围、边界、场景、行为和测试代码，内容有限、无重复、无歧义且可直接执行；不存在架构偏离、范围遗漏、范围越界或依赖实现猜测的事项。完成全部核对后，一次性向我报告所有问题和架构空洞，不得修改文档；没有问题时，明确回复开发清单通过。仅报告以下四类实质问题：偏离架构、遗漏开发内容、超出单元边界、开发事项无法执行。单纯润色措辞、设想没有事实依据的风险或增加非必要功能，不得作为问题。满足全部标准后立即停止。
```

```text
目标：通过多轮“独立审查—集中修正—受影响范围复审”，将当前单元开发清单定稿；一次收齐架构总纲、执行规格和单元边界已经确定的全部开发义务，确保后续审查只需寻找实现缺陷，不再补做已知功能。

首个动作及每次续跑或历史压缩后的首个动作：读取本工作台静态规则、当前开发清单及其已列权威来源，只依据文档中的当前状态继续；不得沿用生成清单时的范围判断，也不得重做已有事实未变化且已通过的局部复审。

进度反馈：首次读取后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，以百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮或单项进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 首轮从权威来源正向枚举全部适用义务，再沿每条完整功能链核对生产端、消费端、装配入口、状态与异常终态、边界与非默认场景及直接相关测试，最后反向确认每项都有架构依据且未越出单元边界。整轮完成后一次性归并同根问题，不得边发现边零散修补。
2. 只修改开发清单，按根因集中修正范围遗漏、架构偏离、范围越界和事项不可执行；不得修改实现或运行构建、测试。修正后只复审变化项及其直接交界，未受影响且事实未变化的结论继续复用；出现反证时扩大受影响范围，不得让历轮问题无依据消失。
3. 每个新增或扩写事项都必须同时反绑权威来源与当前单元必要性。无法证明“不做就会阻断当前核心使用、破坏明确产品体验或违反既定合同”的未来能力、通用化预留、纯观测或 benchmark、诊断设施、推测性防御和非必要增强，一律排除，不得以“更完整”推动清单无限扩张。
4. 持续循环至全部实质问题闭合。准备封版时，对同一份未修改清单执行一次冷启动对抗复审，不得复用前轮结论：分别从“权威要求是否全部有落点”“完整功能链是否存在断点”“事项是否越界或缺乏当前价值”三个对立视角重新推导应有范围，并与清单及明确排除项双向对账。发现真实缺口后必须修正并重新执行本步骤。

只有按本工作台“架构与需求空洞裁决”确属需要用户确认的需求空洞时才暂停；其余清单组织和架构选择自主按锁定范围内的最优方案收敛。

完成条件：同一份未修改清单通过冷启动对抗复审；当前单元全部已知开发义务均有有限、无重复、无歧义且可直接执行的实现与测试落点，明确排除项有事实依据，不存在架构偏离、范围遗漏、范围越界、实现猜测或未处置反证。满足后明确回复“开发清单通过”并立即停止，不得继续增加审查视角或扩充范围。
```

### 3.3 按清单开发

```
动手，完成本单元开发。

开始前：
1、完整读取 `research/design/workbench/unit-development-workbench.md` 的静态规则、当前单元已经定稿的开发清单及其引用的权威架构文档。
2、严格围绕架构总纲、可执行规格和单元边界开发，不得偏离架构设计。发现疑似架构空洞时，按照 “# 单元开发工作台”文档的“架构空洞裁决”规则判断并处理。发现架构设计不是最优，或不同选择会带来明显副作用时，停止开发并说明。

开发要求：
1、先以顶级架构师、顶级智能体专家的身份思考代码组织与设计，注意宏观视角看整体架构、要可维护、可扩展、可插拔，要最佳代码实践方案。
2、按开发清单逐项完成生产实现、消费链路、边界场景及直接相关测试代码；完成一项立即标为 `[x]`。勾选只表示实现与测试代码已经完成，不代表审查或单元提交验证通过。
3、开发中发现清单遗漏了本单元必须实现的内容时，先补入清单再实现；不得擅自扩展单元边界。
4、渐进式实现、分步验证。

原则：

我们的原则不是追求最小变更、修修补补、错上加错、妥协，而是避免架构债务，需要最优架构和方案设计。

验证纪律：
1、开发中只跑最小必要验证（类型检查 + 直接相关测试），修改边界只跑对应测试；源码修改后的必要构建按项目常驻规则执行并登记输入，同一构建输入在单元提交验证中直接复用。开发阶段不得运行受影响包全测、全模块回归或同输入重复构建；失败先归因，只重跑失效闭包。
2、执行构建、包测、全测或 CI 验证前，先按任务与运行条件查 `research/design/workbench/verification-runbook.md`，命中记录时必须采用其中已验证的运行方式；若本轮确认失败源于运行方式而非实现，并因此需要重跑，正确方式验证通过后当轮登记。
3、注意避免陷入“业务代码或测试代码导致无限循环、Bash 长时间无输出”的情况；出现风险时先停止并审查原因，不得持续等待。

注意：
1、不要留下注释债务，不引用 `Phase-N`、`M-N`、`INV-N`、`ADR §N`、`§X.Y` 等会变化的标识符，只保留解释当前代码所必需的稳定注释。
2、全部开发事项均为 `[x]` 时，报告本单元开发完成并立即停止；不得自行重置动态区。
```

### 3.4 专项循环审查补充开发清单

```
目标：把开发清单中的 D25-F08、D25-F09 补充完整，在开发前一次收齐两项功能的全部已知开发义务，避免实现完成后才由独立审查发现功能遗漏。单元边界、架构一致性和可执行性是必须遵守的限制条件，不得以它们代替功能完整性。

只读取 D25-F08、D25-F09，以及判断当前疑点所需的最小事实；不得重审其他开发事项，不得重新横扫整个单元或无关架构来源。只修改这两项清单内容，不实现代码、不运行构建或测试。

持续执行：

1. 审查 D25-F08 是否完整闭合：唯一生产组合根、本机受信入口、排他 bootstrap、唯一 owner/arbiter、稳定操作身份与重放、reset 展示—确认—恢复链，以及首装、并发、响应丢失、重启和路径保密场景。
2. 审查 D25-F09 是否完整闭合：两阶段恢复合同、真实 registry golden、逐分支结构账本，以及能够识别合同漂移、分支缺失和错绑的机械验收。
3. 整轮审查后一次收齐问题，按根因集中修正 D25-F08、D25-F09；收敛过程中只复审发生变化及受其影响的部分，未受影响的结论可临时复用，但不得据此直接判定封版。
4. 持续循环，直到两项的生产端、消费端、装配与所有权、正常与异常终态、重试恢复、边界场景及直接相关测试均有明确落点，同时不存在范围越界、架构偏离、重复、歧义或依赖实现猜测。
5. 准备封版时，对同一份未修改终稿执行一次冷启动对抗复审，不得复用前述结论：D25-F08 从 client prepare、host prepared/committed、权威结果、completed 回放、终态确认到 checkpoint 压缩，逐个核对 owner、线性化点、响应丢失、任意边界崩溃及重启收敛；D25-F09 从规格合同、production registry、runtime descriptor、scenario adapter、validator/reducer 到唯一 recovery owner 逐段核对，确认每个分支均由真实生产事实产生并能识别缺格、错绑和绕过。冷启动复审发现问题后必须修正并重新执行本步骤，任何修改都会使本次复审失效。

只有出现无法由现有产品目标确定的真实需求选择时才暂停；其余架构选择按整体最优且不留债务的标准自主决定。

完成条件：同一份未修改的 D25-F08、D25-F09 通过冷启动对抗复审；执行者仅凭两项内容就能一次性完整交付功能及直接相关测试，不需要自行补充范围或猜测关键方案；后续独立审查只需寻找实现缺陷，不应再补做已知功能。满足后明确回复“D25-F08、D25-F09 开发清单通过”并立即停止。
```

---

## 开发清单

### 当前单元

- 模块：分布式运行时（`distributed-runtime`）
- 单元：第 33 单元（S9）— 全量一致性检查点与周期备份
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（单机与分布式形态平权、值班设备持续在线）、`distributed-runtime-charter.md`（用户持有离线恢复根、周期备份到用户指定位置或配对设备、统一 `CheckpointEnvelope`、秘密永不入备份、S9 顺序与产品语言）、`specification.md`（规范身份/摘要/签名、`RecoveryActivationPlan`、`RecoveryCheckpointVerification`/`CheckpointStreamRecord`、`AuthorityCommitLog`/`ArtifactStore`、六类权威覆盖表、分块信封、每日/迁居前强制创建、readiness、27 天终态保留、设备容量治理及第 33 单元验收）；上游生产事实为 S2 已投产的 root-activation `CheckpointEnvelope`、`RecoveryActivationCoordinator`/`RecoveryCheckpointTarget`、恢复包真回读与 `FileMeshBootstrapStore`，以及当前值班设备唯一的 `AuthorityCommitLog`、`ArtifactStore`、ArtifactLifecycleIndex/storage governor；下游合同只冻结第 34 单元读取“当前根、已验证、全量”的检查点接缝和第 35 单元解封所需的载荷合同。
- 单元边界：在当前值班设备把 S2 同一种 `CheckpointEnvelope` 扩展为全量一致性检查点：固定一个已验证 `DurableLogCheckpoint`，导出该前缀的权威日志、按权威覆盖表仍应保留的资产闭包及必要恢复元数据，以当前或候选恢复备份公钥分块加密；周期目标只允许用户显式配置的物理独立目录或一台已配对设备。当前根存在时每日创建/复制，另提供迁居前强制创建接缝；创建、复制不接触恢复主秘密，只有第一方备份管理入口临时读取用户恢复包、从实际目标回读并完整解封后才写 verified。首次配对利用尚未开放业务能力的新设备作为 onboarding checkpoint target，首次单机加密备份使用用户选定目录，二者都复用现有 root-activation 原子激活；新版恢复包只承载可抄录的高熵主秘密，不内嵌全量密文。既有 S2 trust-only 激活包与 mesh-ready 继续兼容，但不能冒充全量备份 readiness；未显式启用备份的单机、非 current anchor 与 executor/surface 均零周期 owner。
- 明确排除：第 34 单元 `SourceFreezeProof(anchor)`、AuthorityCatalog 导入、TrustTransition、ReadyProof、planned `AnchorTransferCommit`、旧锚点 tombstone 与 current-anchor 切换；第 35 单元恢复应用、disaster-recovery commit、domain-reset/reenroll、凭据轮换及灾难恢复旅程；第 36～38 单元托管服务、移除/卸载、升级和发布；环境事实、设备秘密、SecretStore 内容、workspace 原始路径、本机执行缓存、非权威缓存及旧检查点包自身的递归资产闭包；未显式启用时给单机开箱新增恢复概念；多目标 quorum/云存储/连续同步，以及通用事务、outbox、事件总线、registry、扫描/备份框架、监控、诊断、benchmark 和信息采集设施。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`8/8（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D33-01 | 冻结全量载荷、覆盖身份与兼容合同 | 在现有 contracts/mesh 中定义唯一版本化 `FullAuthorityCheckpointPayload`，继续装入 `CheckpointEnvelope.v1` 的加密块而不新增信封：头部逐字段绑定 checkpointId、home/签发者、recipientKeyId、精确 `DurableLogCheckpoint(logId/lsn/frameEndOffset/prefixDigest)`、trust chain head、权威覆盖版本、规范记录页目录、保留资产目录及各自 count/bytes/digest。覆盖只含全局状态与期望配置、会话状态、会话内容索引+资产、锚点权威执行资产；环境事实/秘密/设备缓存/非权威缓存与旧检查点包资产不可表示。periodic 与 root-activation 共用该载荷，后者只额外绑定原 `RecoveryActivationPlan`；full payload 的 `checkpoint-created` 必带稳定 targetId 以恢复同目标写入，S2 旧 trust-only created 可缺省。把恢复包收敛为只含版本化高熵主秘密/根身份的可抄录格式；旧“秘密+trust-only checkpoint”包继续可解码、重放并维持 mesh-ready，但不得被新编码器生成或识别为 full payload。补 strict codec、未知字段、版本/少列/多列/乱序/重复、错 checkpoint/log/root/chain/coverage/target/ref/digest、禁止类别、新旧恢复包和旧激活包兼容测试。 |
| [x] | D33-02 | 从同一日志前缀导出完整且不自递归的权威快照 | 在 current anchor 的唯一 `AuthorityCommitLog` 先固定并复验一个 `DurableLogCheckpoint`，从 origin 以固定页读取恰至该 lsn，保留规范 `CommitEnvelope` 次序；把 ArtifactLifecycleIndex/现有引用验证追平到同一前缀，按冻结的六类覆盖判别收集当前仍应保留的外置记录、内容资产和传递 `ArtifactRef` 闭包，明确排除 checkpoint lifecycle 所引用的旧 envelope/chunks，禁止从投影文件、缓存或设备目录补事实。任何坏尾、错 log/prefix、越目标 lsn、覆盖判别缺口、必需 ref 缺失/损坏或读取后前缀复核失败都在 `checkpoint-created` 前 fail-closed；后继提交只进入下一代。日志页、资产页、明文块及临时空间逐步经现有 storage governor，等待 permit 时不持 authority/store/lifecycle 锁。补空日志、六类正反覆盖、并发追加/删除、外置 control、共享/嵌套/大资产、旧 checkpoint 防递归、坏尾/缺件、容量不足、取消和重取同前缀测试。 |
| [x] | D33-03 | 将 S2 加密实现收敛为 periodic/root-activation 共用流式内核 | 从 `createRootActivationCheckpoint/openRootActivationCheckpoint` 抽取唯一 create/open 内核，严格复用 X25519-HKDF-SHA256、AES-256-GCM、ephemeral enc、wrapped DEK、nonce/AAD、verificationNonce、envelope 自摘要与当前锚点签名；periodic 只允许 `{kind:"periodic"}`，root-activation 必须全等绑定完整 plan。按固定块上限流式加密 D33-01 payload，密文块先落当前 ArtifactStore 并验 `seq/bytes/digest` 后才持久化 envelope ref；open 先验严格信封、签发者/recipient、连续 exact-set 和每块字节，再解密并验完整 payload/前缀/资产目录。任一失败清零 DEK、共享秘密、nonce 与已解明文，零 verified/激活推进且不落持久明文。补跨 purpose、错 key/enc/wrappedDek/nonce/AAD/signature、块篡改/截断/重排/重复/超界、payload 错绑及既有激活崩溃矩阵回归。 |
| [x] | D33-04 | 实现单目标配置、两类物理独立 adapter 与真实回读 | 在现有第一方 CLI 增加 `zz backup setup`：用户一次只选独立目录或一台 active paired device；复用现有设备本地配置保存 targetId→目录/设备的版本化映射，原 target 仍有未清理 checkpoint 时不得丢失映射，日志/wire/targetId 只见不反推路径的稳定身份。目录 adapter 冻结 canonical volume/filesystem identity，拒绝与 authority root 同物理域、root link/reparse/替换及越根，按 checkpointId 私有临时目录写 envelope/chunks，逐文件 fsync→原子发布→目录 fsync 后才 durable；paired adapter 只经认证 mesh 提供受限 put/get/retire，绑定 home、source/target device、checkpointId、recipient、envelope/chunk exact-set，不暴露路径或通用 ArtifactStore。两类 target 都实现同载荷幂等、异载荷冲突、部分发布不可见、真实回读和仅对已 superseded id 的删除；每个物理步骤复用目标设备唯一 storage governor，网络等待不持 permit/authority/store 锁。补两类正例、配置切换/重启、同物理域、链接/替换、错成员/root/ref/range、部分/重复/乱序、共享 digest、磁盘满、取消/断连、响应丢失、续做与逐字节回读测试。 |
| [x] | D33-05 | 建立每日/迁居前强制创建与复制的唯一耐久 owner | 只在 trusted-home current anchor 组合根装配一个 checkpoint service；以 UTC 日历日派生稳定 daily due identity，并向第 34 单元暴露“查询当前 full verification / 必要时创建并复制一个 full checkpoint”的窄接缝，两入口先加入当前 root+target 的同一候选，创建后再以冻结 source-prefix 重放，不假装能在无恢复包时完成 verified。创建前工作可重算；一旦 `checkpoint-created` 耐久，checkpointId、source checkpoint、recipient、target 和 envelopeRef 即冻结，随后 durable target write、`checkpoint-replicated`、回读/验证均只重驱同一代，暂态失败、取消、响应丢失或停机不得另造候选。首次单机备份和后续 root establish/rotate 复用 D33-02/03 与现有 `RecoveryActivationCoordinator`；首次配对先完成受限认证 onboarding link/设备侧 target durable write，再真回读并原子激活根，根激活前不得发布业务 mesh 能力，响应丢失按同 checkpointId/配对 continuation 重放。链头变化使未激活候选失效重建，已提交激活 exact replay。无根/无独立目标/非 current anchor 时不建周期事实并返回稳定可行动状态。补同日并发、daily/forced 竞争、首次配对/单机启用、各 created/复制/激活边界崩溃、配置切换、根/链切换、取消/stop 与连续重启测试。 |
| [x] | D33-06 | 闭合恢复包真解封、双 readiness 与用户可行动状态 | 在 `zz backup verify/status` 提供真解封与读面；verify 必须通过保密交互临时读取恢复包（禁止 argv/env/配置/SecretStore/日志），从 created 绑定的真实目标回读同 checkpointId，调用 D33-03 完整解封并由当前恢复根签 `RecoveryCheckpointVerification`，再在同一 `AuthorityCommitLog` 事务逐字段核对 created+replicated+envelope+recipient+purpose+target+nonce 与 full payload 后幂等写 `checkpoint-verified`，异载荷/旧根/链变化零推进。扩展 `RecoveryReadinessProjection`：既有 `ready` 对旧 S2 home 保持兼容；另以 verified 记录、created envelope manifest 与 full payload coverage 派生 `fullBackupReady` 及最近 checkpoint/target/time/lsn，只有当前根、独立目标、真解封且全量覆盖才为真，复制存在、验证失败或旧 trust-only 包不得冒充；不得用“每日窗口/overdue”改变冻结 ready 谓词。`zz backup status` 与 `/status` 只用“恢复备份”语言给出未配置/待验证/可恢复及下一动作，不暴露 root、LSN、digest 等术语。补首次无根 setup、错包/key/nonce/target/digest、旧根/旧链重放、效果后响应丢失、terminal replay、状态投影重建与秘密扫描测试。 |
| [x] | D33-07 | 实现代际替换、27 天保留与零误删清理 | 只有新一代 current-root full checkpoint 已从独立目标真解封并 verified，才在同一 checkpoint 事务追加旧代 `checkpoint-superseded`；较新候选失败、仅 replicated 或非 full 时不替换，首次 `fullBackupReady` 成立后始终保留至少一个能维持它的代际。superseded 事实进入现有 27 天终态窗；到期后 checkpoint service 以 committed storage-maintenance single-flight 分别回收本地 envelope/chunks 和原 target 副本，目标不可达保留重试义务且不影响新代 ready；未发布临时目录可直接清，created/replicated 未替换候选必须可续做。root rotate 激活时旧根包立即不再计 ready、不 rewrap，只有新根 verified full 包成立后才允许清理旧代。全部本地 CAS 删除先经 ArtifactLifecycleIndex 复核引用，旧 checkpoint 自身从新 payload 闭包排除，零删除共享业务资产。补替换前后、唯一 verified、跨根、27 天边界、目标删除失败、共享 ref、孤儿、响应丢失和连续重启测试。 |
| [x] | D33-08 | 闭合生产装配、有限门禁、文档与 S9 直接证据 | 覆盖现有受支持拓扑：显式启用备份的 single-machine current anchor、anchor+executor、anchor-only/远端 executor 中只有 current anchor 恰一 service/capture/source target client；首次配对 onboarding target 与被选中的 active paired backup device 各按当前阶段恰一受限 receiver；executor-only、surface、非 current anchor 与未启用单机零周期 owner/权威读取。启动在开放 backup 管理和第 34 单元接缝前，从 trust/checkpoint 流恢复 created/replicated/verification/supersede/cleanup 义务与两类 readiness；关闭先拒绝新创建，在安全页边界停机并释放 permit。为 setup/verify/status、daily/forced trigger、paired put/get/retire 在规格落点矩阵增加有限行，并扩展现有 S7 entry/结构/golden 对账 onboarding/active receiver、owner/target/角色 exact-set，不建新 lint/发现框架；同步总纲、规格和直接模块合同。用真实 `FileAuthorityCommitLog`、`FileArtifactStore`、ArtifactLifecycleIndex、两类 target 与新旧恢复包跑 full capture、root-activation 兼容、分块篡改、复制/回读/清理中断、容量/停机、根/链变化、readiness/retention 及双生产拓扑场景；机械断言第 34/35 单元 transfer/import/restore/TrustTransition/ReadyProof 未启用。 |
