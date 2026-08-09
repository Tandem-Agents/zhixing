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
- 单元：第 34 单元（S9）— 计划迁移值班设备与原子权威切换
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（值班设备持续在线、受支持形态平权及本地秘密不迁移）、`distributed-runtime-charter.md`（唯一 current anchor、目标 `ready`、新 issuer key、`TrustTransition` 与 authority transfer 分离准备后由唯一签名提交原子切换、提交前可撤销/提交后只前进、旧 epoch 永久拒绝及产品语言）、`specification.md`（`AnchorTransferCommit`、`SourceFreezeProof(anchor)`、digest 引用、`AuthorityCommitLog`/`ArtifactStore`、权威覆盖表、`AuthorityTransfer` planned 全状态边、设备容量治理、S9 装配顺序与第 34 单元验收）；上游合同为 S2 的 home trust/issuer-transition 与设备信任、S3 的 `AuthorityCommitLog` 和幂等提交、S8 的 current-authority/current-owner 准入与路由，以及第 33 单元“查询当前 full verification / 必要时创建并复制全量恢复检查点”的窄接缝；下游仅向第 35 单元冻结新的 current anchor/trust generation 和已提交 planned transfer 事实，不提前提供灾难恢复应用能力。
- 单元边界：仅处理用户主动把当前值班设备迁往一台已配对、active 且已由本机配置证明 `ready` 的目标设备。迁居前先取得当前根下可真恢复的全量检查点保障；目标本地生成新 issuer key，当前 issuer 准备迁居 `TrustTransition`；源端关闭新准入、收束全部在途执行，在同一稳定日志前缀冻结 `SourceFreezeProof(anchor)`、无秘密 `AuthorityCatalog` 和迁居载荷，目标在私有 staging 完整导入校验。唯一签名 `AnchorTransferCommit` 同时反绑 checkpoint/catalog/freeze/ready/trust-transition 与下一 `anchorEpoch/trustEpoch`；目标本地一次耐久发布新 current anchor 与新 trust chain 后才开放服务，旧端立即永久 fencing，随后清理并 tombstone。prepared/frozen/imported 可安全 abort 并恢复源端同 epoch；committed 后禁止回滚，只能通过更高 epoch 的后续 planned 迁居继续前进。
- 明确排除：第 35 单元 recovery package 解封后的 disaster recovery、`domain-reset`/`establish`、pending-reenroll、凭据轮换、无源恢复与灾难旅程；第 36～38 单元服务托管、永久移除/卸载、升级回滚与发布；anchor/disaster 自动 failover、quorum/witness、多 active anchor、全局连续同步、多目标/云能力；迁移设备秘密、SecretStore 内容、环境事实、workspace 原始路径及设备缓存；改写第 33 单元恢复包/检查点语义；通用路由、存储、同步、事务、outbox、事件总线、registry、扫描/迁移框架、新 lint/test runner、监控、诊断、benchmark 和信息采集设施。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`8/8（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D34-01 | 冻结 planned transfer 的严格身份、命令与状态合同 | 依据总纲“AuthorityTransfer 与 TrustTransition 分离准备、`AnchorTransferCommit` 唯一切换”及规格 planned 全边，在现有 contracts/mesh 中补齐唯一版本化 `AuthorityCatalog`、`ReadyProof`、anchor/planned `TransferRecord`、pre-commit abort 和按状态判别的 command/result 分支，复用 `SourceFreezeProof.v1(scope:"anchor")` 与 `HomeTrustEvent(type:"issuer-transition")`。`AnchorTransferCommit` 逐字段反绑 transfer/source/target、五类 digest、下一 anchor/trust epoch、目标 issuer public key、当前 issuer 签名和时间；client 在分类前与 originating command 全字段关联。prepared/frozen/imported/committed/tombstoned/aborted 仅走规格边，committed 后 abort 永久拒绝；同 request/同载荷 exact replay，稳定身份相同而任一摘要、设备、epoch、模式或状态不同均冲突。补 strict codec、未知/少列/多列、跨 mode/state、错关联/摘要/签名/epoch/角色、重复及 terminal replay 测试；该项是后续双端实现零歧义且不会误接 disaster 分支的合同前提。 |
| [x] | D34-02 | 建立目标 ready、迁居新 issuer 与双端 prepared | 依据总纲 ready/秘密不迁移及规格设备 `ready` 守卫，第一方入口只允许 current active anchor 选择一台不同设备上的已配对 active anchor。目标在本地 SecretStore 生成并按 transferId 耐久绑定唯一新 issuer key，同 transfer exact replay 复用、异 transfer 不复用；经既有认证 mesh 返回有时效的规范 `ReadyProof`，冻结 active-anchor membership、当前 trust generation、issuer public key、目标角色实际启用的 provider/MCP/channel、协议/资产兼容、SecretStore 解锁和必需服务装配 revision，wire 只含证明与公钥，零秘密、路径和环境值。当前 issuer 对同一 target key 生成但不追加到生效 trust 链的 `issuer-transition`，其原对象/digest 随 source/target 同 transferId 的 prepared 事实耐久保存；prepared 不改变 current anchor/trust 投影、不开放目标业务。target 不 ready、已撤销/错角色、证明过期或篡改、配置/trust generation 漂移、同 subject 异迁居并发均在 source 关闭准入前稳定拒绝。补 ready 各维、旧 key/错 target、同/异 transfer key、效果后丢响应、同/异请求并发、重启和秘密扫描测试；缺此项会使目标在切换后无法独立服务或签发。 |
| [x] | D34-03 | 关闭源端准入并冻结唯一 source prefix | 依据第 33 单元迁居前强制备份接缝与规格 `SourceFreezeProof` 守卫，prepared 后先查询当前 root/chain/target generation 的 verified full recovery checkpoint，缺失时只调用既有 forced create+replicate+verify 接缝；该恢复保障不得充当 planned 导出 checkpoint。随后由 current anchor 唯一 migration owner 建立耐久 admission fence：拒绝新的全局/会话/control 写、调度触发、渠道接管和 fresh assignment，仅放行迁居 recovery/abort 与已接受义务的收束；在途 run/job 及其 pending interaction 必须达到终态或耐久裁决，不属于在途执行的 queued occurrence、delivery/final/outbox、intent 与独立 confirmation 等未执行义务保持原身份进入导出，不得被伪造为完成。全部在途闭合后冻结同一 `AuthorityCommitLog` 的内部 `DurableLogCheckpoint`/lastLsn/source epoch，冻结后业务写零追加；planned 导出 artifact、`checkpointDigest` 和签名 proof 由 D34-04 基于该前缀产生。commit 前取消按同一 abort 恢复原 epoch/准入且不丢已接受义务。补全部写面与 trigger 竞态、active/queued/pending 分类、恢复 checkpoint 不 ready、fence/前缀写前后崩溃、超时/取消、响应丢失和连续重启测试；该项消除迁居前后双写窗口。 |
| [x] | D34-04 | 生成 planned 导出 checkpoint/AuthorityCatalog 并完成私有导入 | 依据权威覆盖表、digest 引用合同和 planned `frozen→imported`，从 D34-03 的同一 source prefix 生成独立于第 33 单元 `CheckpointEnvelope` 的 planned export checkpoint `ArtifactRef`，并生成规范 `AuthorityCatalog`：精确列出全局状态/期望配置、全部会话权威与内容资产、锚点权威执行资产、trust/current-anchor 基线、各 stream/range/revision、待续驱义务与传递 ArtifactRef exact-set；SecretStore、环境事实、workspace 原始路径、设备缓存和非权威缓存在类型与构造中不可表示。先耐久写全 export artifact/catalog，再签发反绑 transfer/sourceEpoch/lastLsn/export `checkpointDigest` 的 `SourceFreezeProof(anchor)`，并把 proof、catalog digest 和 frozen 状态写入 transfer 流；禁止把 recovery checkpoint digest 混入。复用现有有界 chunk source/sink、ArtifactStore 与 storage governor，经认证 mesh 写 target-per-transfer 私有 staging，逐页/块核对 count/bytes/digest/source prefix/coverage 后写 imported；部分导入和目标 authority base 均不可服务，同载荷续做、异载荷冲突，abort 只删本 transfer staging，网络等待不持 permit 或 authority/store/lifecycle 锁。补空/全域、大资产、共享 ref、缺页/重排/篡改、额外/遗漏权威、禁止类别、两种 checkpoint 混绑、容量/磁盘、断连/取消、丢响应、重启和零共享 CAS 误删测试；缺此项无法证明目标取得完整且同代的锚点权威。 |
| [x] | D34-05 | 以 source 端唯一提交点发布 AnchorTransferCommit，并在 target 原子安装 | 依据总纲“唯一签名提交、提交前可撤销/提交后只前进”和单日志 fsync 纪律，imported 后重验 current issuer、source proof、export/catalog、未换代 trust prefix、prepared transition 与未过期 `ReadyProof`。当前 issuer 生成唯一 `AnchorTransferCommit`，source 在一个 `AuthorityCommitLog` envelope 中原子追加该 commit、使 prepared `issuer-transition`/next epochs 生效并进入永久 source fence；该 fsync 是 planned transfer 的唯一全局线性化点，成功后即使 target 未响应或离线也禁止 abort/恢复 source。target 只接受逐字段同一签名 commit，并把它、同一 transition、已验证 authority base/current anchor 与下一 epochs 在一个本地 envelope 原子安装；sync 前零 target 服务可见，sync 后不得再有决定可服务性的发布 I/O，安装成功才开放 target。签名/source fsync 前失败仍可 pre-commit abort；source 已提交而 target 未安装只前向重驱，target 效果后响应丢失只 exact replay。补每个核验字段、source/target 两次 sync 前后故障、提交响应丢失、双签竞争、same/different commit replay、旧链/ready 漂移和连续恢复测试；该顺序以短暂不可用换取零双主，不能让 target 响应不明回落为 abort。 |
| [x] | D34-06 | 接管第一方能力并永久 fencing 旧值班设备 | 依据总纲 pending/调度/渠道随迁居收束或迁移、离线设备追赶及旧 epoch 永久拒绝，target 在本地安装同一 commit 后，从 committed authority base 重建 catalog 所列 session/control/job/schedule/publish/final/delivery/confirmation/checkpoint 投影和全部待续驱义务，验证 current anchor、trust chain、catalog generation 全等后才开放 mesh、CLI/server、channel、scheduler 与签发入口；全部 current-authority/第一方路由只命中新 target，原 request/task/conversation/interaction/effect identity 与水位不变，queued/pending/响应丢失项 exact replay，已终态效果不重跑。在线与重连的已配对设备必须从签名 commit/transition 追到同一新 trust generation，只接受新 issuer；离线设备追赶同一链后连接 target，旧链或缺 transition 均禁写而不要求重新配对。source 自唯一提交点起拒绝旧 anchorEpoch/trustEpoch 的写、签发、分配、服务注册与迟到结果，仅向已认证调用者返回新值班设备指向；本地非权威资源/连接清理后幂等 tombstone，清理失败不得恢复权威。补全部生产入口、渠道/调度/confirmation 接管、pending 恢复、在线/离线成员追赶、旧 issuer/epoch/capability 对抗、迟到消息、重连、响应丢失、tombstone 清理失败和连续重启测试；缺此项会造成切换事实存在但用户仍命中旧端、成员无法追赶或耐久义务丢失。 |
| [x] | D34-07 | 闭合 abort、双端恢复与停机终态 | 依据 planned 状态表和“任意中断按日志重入”，source/target 各恰一 transfer recovery owner，均在公开准入前重放 transfer/trust/current-anchor 事实。source 尚无 committed 时，prepared/frozen/imported 的用户取消或不可恢复校验失败只能由 current authority 生成同一签名 abort：source 恢复原 epoch/准入，target 记录同 abort、隔离并幂等清理 staging，并只在 abort 耐久后销毁该 transfer 尚未激活的本地 issuer key；暂态网络/target unavailable 保持原状态与 key 重试，不伪造 abort。source 已 committed 而 target 未安装时，source 永久 fenced、target 保留同 key 并只重驱同 commit 安装；target 已安装或响应丢失时只回放同终态；任何“target committed 但无全等 source commit”、异 commit 或 late abort 均 fail-closed，target 暂时离线永不令 source 复权。关闭顺序为拒绝 fresh transfer 动作、完成当前耐久边界、在安全检查点停止传输/recovery loop 并释放 permits；不能证明终态时失败关闭并保留可重驱事实。补 planned 每条边、每一双端耐久写前后崩溃、状态不齐、断网/stop、重复 abort/commit、issuer key 清理/保留、source/target 分别失联和多次连续恢复测试；缺此项会把响应不明误判为可回滚或遗留无归属签发密钥。 |
| [x] | D34-08 | 闭合产品流程、生产 topology exact-set 与 planned 证据 | 依据总纲零术语迁居旅程、角色装配纪律及规格第 34 单元验收，在现有第一方 CLI/server 管理面提供“迁移值班设备”：列出合格目标，展示可行动的 ready 缺口及准备/收束/传输/接管进度，唯一提交前可取消，提交后明确只能再次迁移；文案不得出现 anchor/epoch/issuer/catalog 等内部词。冻结生产 topology：current anchor+executor 与 current anchor-only 根各恰一 migration/recovery owner；本次 ready target 的 anchor+executor 与 anchor-only 根只持有限 target receiver/recovery owner并在 commit 安装后切换角色；executor-only、surface、disabled、非 current anchor 且非本次 target 零 migration owner。复用现有 S7 descriptor/validator 与架构/golden 双向核对入口、owner/receiver、phase/order、删除/重复/绕过 exact-set，不建新 lint。同步总纲、规格、协议/能力矩阵和直接合同测试；以真实 `FileAuthorityCommitLog`、`FileArtifactStore`、trust store、第 33 单元 checkpoint seam、storage governor 和两设备 mesh 跑 planned 全边小表，覆盖准入 fence、在途与 pending 分流、私有导入、source 唯一提交、target 安装、旧 issuer/epoch 拒绝、pre-commit rollback 与 commit 后前滚，并机械断言第 35～38 单元、秘密迁移和自动 failover 未启用。该项只提供成比例的生产装配与核心故障证据，禁止复制既有组件矩阵或扩建 runner。 |
