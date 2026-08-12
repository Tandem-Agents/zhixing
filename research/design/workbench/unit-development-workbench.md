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
- 单元：第 37 单元（S10）— 三路径停机、设备移除与值班设备永久卸载
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（值班设备持续在线、干活电脑离线/恢复及用户不理解内部拓扑的体验前提）、`distributed-runtime-charter.md`（临时停机、executor 移除、anchor 永久卸载三路径；本地权威先转移或显式销毁；设备撤销、外部凭据暴露收束、失控设备诚实告知、逐阶段崩溃恢复与零术语产品语言）、`specification.md`（`server.shutdown` 三策略、AuthorityTransfer、设备状态/revoke、CredentialExposureRecord、SecretStore、恢复检查点、权威覆盖表、资源停机语义、产品旅程及第 37 单元执行计划，并要求本单元回填字段级协议）、`s2-security-supply-chain-review.md`（复用既有锁定依赖，不扩大秘密、身份与恢复材料暴露面）；上游冻结复用第 30～32 单元本地域 owner/DeferredGlobalIntent/AuthorityTransfer，第 33～35 单元检查点、planned/disaster transfer、current-owner/trust、credential exposure 与资源治理，以及第 36 单元 managed/on-demand/none、future/current 双事实、graceful shutdown、exact endpoint 与 supervisor read-back。下游只向第 38 单元交付已安全停机或已完成本地清退的稳定边界，不提前实现升级、回滚或发布。
- 单元边界：只实现三条互斥、可重放的生命周期路径。临时停机先耐久接受请求并拒绝新准入，按 `immediate/drain/cancel` 收束已接受工作，刷稳权威日志、pending obligation/outbox 并让租约/permit 到安全检查点，再终止 exact 当前实例；保留 authority、trust、SecretStore、数据、服务定义及后续自动启动资格。可达 executor 移除先关闭本地域新准入并冻结本机仍属当前 owner 的会话 exact-set；非空时只能逐项复用 AuthorityTransfer 收编到 current anchor，或由用户对同一 exact-set 明确确认不可逆销毁，之后才收束 assignment/lease/journal/outbox。目标设备先证明本地权威与工作已收束，current issuer 再耐久撤销设备并把该设备 active credential exposure 标为 compromised；目标取得同一撤销终态后，才删除本 home 的环境绑定、秘密、缓存与 supervisor 定义。失控设备只做远端撤销、路由阻断和外部账号处置指引，绝不声称迁移或本地擦除。current anchor 永久卸载必须先完成 planned AuthorityTransfer，或先从独立目标真解封验证最新完整恢复导出、再经用户明确确认，并把不可逆 retirement 决定纳入最终完整导出再次验证；只有冻结 authority 已由新 owner 接管或可由最终导出恢复，才可执行同一安全停机和本地清退。本机 lifecycle 事实写承担该路径的既有物理 AuthorityCommitLog（executor/本地域路径写设备日志，anchor 卸载写当前 authority 日志），撤销/暴露继续写既有 trust/exposure 流；同一判别 operation identity 只引用各权威终态，不建立第二 authority。
- 明确排除：第 38 单元的版本/schema/protocol 兼容门、包下载、原子替换、升级健康门禁、自动回滚、发布矩阵、支持包和最终全量 CI；外部安装器实际删除 executable/package、任意版本替换或“升级停机”；网络分区自动 failover、quorum/witness、多 active anchor、全局或持续同步、灾难恢复应用、远程擦除失控设备、伪造本地迁移/清退成功、长期关闭 current anchor 却既不迁居也不保留可验证恢复导出；把加密导出当 owner、把 SecretStore/环境事实写入备份或迁移、为本地会话新增通用导出格式；通用 lifecycle/device-management/transaction/outbox/event-bus/router/registry、第二日志或第二 trust/exposure 事实源、强杀兜底、新监控、诊断、benchmark、信息采集、lint/test runner 及非必要第三方依赖。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`9/9（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D37-01 | 回填三路径字段级协议与唯一耐久状态机 | 依据总纲三路径及规格“本单元新增字段级协议”的明确义务，在`specification.md`补齐临时停机、executor移除、anchor永久卸载的判别联合、状态表、守卫、取消边界、终态和产品投影，并在承担该路径的既有物理`AuthorityCommitLog`增加窄`device-lifecycle`流与`DeviceLifecycleOperation` reducer/codec：stop身份绑定`requestId/operationId/homeId/strategy/exact host或service generation`且允许无trust的单机；removal绑定目标device及其member/device-key generation、接受时current issuer与trust head祖先；uninstall绑定current owner、迁居目标或checkpoint generation。同一`homeId+subject device`至多一个非终态operation，跨kind竞争在副作用前拒绝。lifecycle只记录gate、阶段决定及AuthorityTransfer/trust/exposure/checkpoint/supervisor终态引用，不复制业务事实；同载荷exact replay，异载荷/错home/错设备/错代际在副作用前拒绝，terminal不可回退。stop一经accepted只前滚；removal/uninstall仅在首个不可逆事实前允许写authenticated abort并恢复原gate，任一conversation transfer commit/权威删除、device revoke、planned transfer commit或anchor retirement决定出现后只可前滚。补strict DTO、三种身份正反例、跨kind竞争、祖先head/成员换代、错序/越级/冲突终态、日志坏尾、响应丢失与连续重启测试；不新增第二journal或通用lifecycle/transaction/outbox/event bus。 |
| [x] | D37-02 | 闭合临时停机与`server.shutdown`三策略的安全终态 | 依据“关闭准入→收束assignment→刷稳账本/outbox→停机且保留权威”，把`server.shutdown`、`zz stop`与OS signal接到同一stop operation。RPC以稳定requestId+strategy在副作用前耐久accepted并返回可重放的operation状态，不得先ack再异步吞错；随后关闭first-party/channel/scheduler/executor新准入并冻结exact当前host。`immediate`把已接受义务推进至下次可重放的耐久安全点，`drain`等待remote/channel/scheduler/delivery及本地conversation已接受义务终态，`cancel`用既有取消事实收束可取消工作并等待不可取消步骤；三者均刷稳AuthorityCommitLog、pending obligation/RunFinalOutbox/delivery outbox，拒绝新permit并等待在途物理步骤释放。`ready-to-stop`后给既有adapter增加窄`stopCurrentExact`：Windows`/End`、macOS`bootout`、Linux`stop`只终止全等当前实例且保留definition/future-enabled，on-demand/foreground自退出；外部协调者或下次启动按exact旧实例read-back追加terminal。超时、blocker、磁盘满或flush失败保持gate关闭并把稳定行动投影留在operation，禁止SIGKILL/taskkill强杀、清PID冒充成功或删除authority/trust/secret/data。补三形态×三策略、全部accepted来源、重复请求/响应丢失、各flush/permit切点、旧/新实例、manager效果丢失、崩溃后补terminal与后续正常启动测试。 |
| [x] | D37-03 | 冻结executor移除预检与本地权威二选一决策 | 依据“任何移除不得先撤身份、后发现本地权威”，在可达executor的本地域owner/transfer source上增加effect-free preflight；只有D37-05 current-issuer signed accepted receipt已全等验真并在本机lifecycle log耐久后，才拒绝新本地会话、turn、assignment与租约，再从`listConversationAuthorities()/transferCandidates()`及transfer journal冻结仍属本机current/frozen/importing的conversation exact-set，同时读取active work、pending final/assignment、DeferredGlobalIntent、outbox、lease/permit与managed instance。将exact-set、名称投影、选择、current anchor identity与摘要作为同一lifecycle决定耐久后才执行：空集直接进入收束；非空只允许“收编到当前值班设备”或对同一名称/数量明确确认“永久删除”。current anchor不可达/not ready时收编不可选，预检变化在首个不可逆效果前必须重新展示并决定；此前取消须让两端同identity耐久aborted并恢复原准入/selector，之后gate保证集合不再扩张并只前滚。加密导出只作销毁前备份，不能清除owner blocker。补空/单/多、active/frozen/importing/committed、并发新会话、anchor离线/换代、TTY/非TTY、取消/响应丢失与重启测试。 |
| [x] | D37-04 | 复用AuthorityTransfer收编或以权威删除语义销毁本地会话 | 对D37-03冻结的每个会话派生稳定transfer/request identity并按规范顺序执行。收编复用现有source fence、target private import、commit、source accept/tombstone与post-adoption consumer闭包；只有全部项可从current owner链全等回读committed/tombstoned且本机current-owner exact-set为空才前进。销毁在同一local-owner gate内先收束run/interaction/intent/final/lease，再复用session delete/tombstone、conversation directory与ArtifactLifecycleIndex删除权威及派生资产，禁止raw目录删除或留下可写孤儿owner。首个transfer commit或delete tombstone后operation不可取消、换模式或换target，逐项失败只重放原决定且部分成功不得冒充全部完成。补retained/non-retained artifact、DeferredGlobalIntent、pending final/confirmation、两模式各切点、双选竞争、target commit响应丢失、current-anchor换代、连续重启及旧owner永久拒写测试。 |
| [x] | D37-05 | 原子收束设备撤销、路由断开与外部凭据暴露 | 在current issuer的既有authority log与认证mesh上建立有限device-removal服务，只接受active且非current-anchor的目标。可达请求在任何target副作用前先以同一authority envelope耐久accepted：冻结目标member/device-key generation与当前trust head祖先，从selector/fresh dispatch移除目标，并以同一lifecycle guard拒绝该设备的竞争撤销及本operation终结前的current-authority迁居或retirement；目标仍可完成既有accepted work与本operation有限调用。signed receipt绑定上述身份并只授权该operation查询终态。target按D37-03/04完成本地权威/工作/资源收束后回送signed revocation-ready；issuer重读current trust，要求accepted head仍为祖先、目标仍是同generation active member，再从当前head构造revoke，并在一个authority envelope追加`HomeTrustEvent.revoke`、该device全部最新active exposure→compromised及removal terminal引用；无关trust前进不改operation，目标成员换代或竞争事实在任何新副作用前拒绝。commit立即使resolver/inventory/capability/routing拒绝目标，断开普通连接并删issuer侧pairwise secret。为revoke响应丢失，在普通trust admission之前仅保留该receipt授权的窄只读terminal replay：服务用历史device公钥验请求签名并全等反绑operation，只返回issuer签名终态，零普通mesh/写能力，终态确认后退役；target不得以accepted或ready代替revoke terminal。首个不可逆效果前的authenticated abort须同时恢复issuer selector/current-authority变更准入与target gate；lost-device确认直接形成accepted并走同一authority commit，但不生成本地ready/cleanup事实。错误issuer、current anchor、自身/同名错设备、非祖先head或异operation零副作用。compromised exposure只在另有可信授权且服务支持时复用既有rotation，否则逐项给第三方换密钥动作。补accepted/ready/revoke/terminal-query各响应窗口、无关trust前进/成员换代、selector与authority-change gate恢复、在线转离线、迟到旧请求、无/多exposure、连续重启及route/credential guard测试。 |
| [x] | D37-06 | 完成可达executor本机清退与三平台supervisor注销 | 仅当D37-04证明零本地owner、全部accepted work/ledger/outbox/lease/permit到安全点，且D37-05的signed revoke terminal已全等验真并本地耐久后，才进入不可取消cleanup；响应丢失通过窄terminal replay重取，期间gate关闭且不恢复普通准入。按冻结exact-set停止inventory/assignment与恢复循环，复用SecretStore`list/delete`、权威delete/tombstone、ArtifactLifecycleIndex及安全文件原语清除本home的provider/channel/MCP/rendezvous/transfer候选/device秘密、workspace/environment绑定、派生投影、artifact/cache；不得删除用户workspace内容、其他home或独立checkpoint target，既有AuthorityCommitLog保留最小非秘密removed terminal与权威tombstone而不作raw日志删除。所有分页/文件步骤经现有storage governor，网络与OS等待零permit。给ManagedServiceAdapter增加窄`unregisterFutureExact`：先read-back并冻结同service/home/definition与current instance，Windows删除任务，macOS先禁future launch再删plist，Linux`disable`后删unit并daemon-reload，均在当前gated进程仍可完成恢复记录时read-back registration absent；slot/definition替换拒绝误删。其余秘密清除后以exact slot compare-delete device key，追加本机cleanup terminal，再让当前进程走D37-02既有安全自退出；崩溃发生在registration删除前由supervisor重启续做，删除后由本机任何`zz`入口的pre-runtime resumer续做且绝不重建角色/key。补三平台、四SecretStore backend、大exact-set、terminal响应丢失、registration删除前后崩溃、部分删除、磁盘/权限、跨home/错slot、key最后删除与当前进程退出测试。 |
| [x] | D37-07 | 闭合失控设备撤销的诚实终态 | 依据总纲“设备失控不得伪造迁移”和产品旅程，在current anchor公开有限`撤销该设备`流程：只按名称唯一的active非current设备选择，展示该设备可能仍持有本地对话/文件且当前无法读取或擦除，非TTY必须显式传入名称与确认。确认后走D37-05的lost-device分支；若可达removal已accepted后设备失联，用户只能在同operation耐久选择“继续等待”或“按失控设备撤销”，不得另开竞争operation，已有不可逆本地权威结果仍如实保留、未证明项仍标未知。lost决定阻断trust/routing并列出受影响外部账号；不得生成本地cleanup receipt、把未知本地authority标为已收编、声称已删除数据，或因设备稍后重连恢复其active身份。若另有可信平台管理权限，只逐个复用已验证的外部撤销/rotation能力；否则保留明确待办指引。补设备在线转离线、始终离线、撤销竞争、同名、旧/新issuer、迟到连接与请求、无/有exposure、手工rotation完成及所有输出无raw deviceId/epoch/path/error测试。 |
| [x] | D37-08 | 闭合current anchor永久卸载的迁居/恢复导出双门禁 | 新增窄uninstall coordinator，先以现有readiness/backup status做零副作用路径预检：current authority不得有未终结device-removal，且必须由用户选定一个真实ready迁居目标，或存在可写且物理独立的checkpoint target；任一前提不满足时零accepted/零gate并给出下一步。路径确定后才耐久accepted、关闭current-owner公开准入。迁居分支只复用`dutyMigration/PlannedAnchorTransfer`：commit后全等回读新current owner/trust/installed-generation与consumer receipt，旧anchor fenced且pending/outbox归新代，再把旧设备按可达移除走D37-05/06。恢复导出分支用`AuthorityCheckpointOwner.force`生成当前full checkpoint并从冻结target真解封、全量回读验证，随后向用户展示“卸载后只能用该恢复备份重新接管”，确认必须反绑home/device及该checkpoint generation；确认在同一authority log写不可逆retirement决定与本设备exposure compromised，关闭所有fresh写，再强制生成并验证包含该决定、最新authority/trust/catalog/exposure/retained exact-set的最终full checkpoint。final checkpoint未验证时gate保持关闭并仅前滚，不得清退或撤销决定；验证后以该final checkpoint而非device-revoke terminal作为授权，复用D37-02安全停机及D37-06的清退执行器删除本地秘密/绑定/服务，并按D37-05同一exposure投影逐项给出外部账号轮换行动。不得self-revoke、把备份冒充live owner或自动选新anchor。补迁居各phase、未终结removal/无可行路径零副作用、backup旧/损坏/满盘、首次验证与确认顺序、retirement→final checkpoint各切点、无/多exposure、响应丢失、连续重启、迟到写与清退失败测试。 |
| [x] | D37-09 | 装配预运行恢复、公开入口与有限直接验收闭包 | 在`runServeCommand` role/listener/runtime admission之前装配窄lifecycle resumer：先只读打开本home现有log；未终结操作按需existing-only加载既有SecretStore binding/device key，绝不创建key。stop/removal/uninstall只重读D37-01及其AuthorityTransfer/trust/exposure/checkpoint/supervisor引用恢复原phase；removed device普通启动永久拒绝旧identity，只有显式重新配对可作为新identity加入active home；retired anchor home只允许既有恢复入口重新建立authority，普通启动/配对不得复活；current anchor同时重驱accepted device-revoke/exposure义务。公开所有权冻结为：`device list/remove/status/continue`是current-anchor canonical管理面；target只暴露认证、有限的preflight/ready/terminal replay服务；`stop`与`uninstall`是本机loopback-only，禁止经current-anchor relay到其他设备。TTY按唯一名称/序号与后果确认，非TTY要求稳定参数；状态只用“正在结束工作/需先处理本机对话/正在移除/已撤销但本机数据不可达/恢复备份已验证/可以卸载”等行动语言，零内部id/epoch/digest/secret/path/raw error。对不支持lifecycle协议的旧peer在本地gate或远端副作用前返回不可用，不实现第38单元通用兼容。扩展现有S7有限descriptor与直接场景测试，机械冻结入口owner、pre-runtime顺序、无force-kill/第二journal/秘密迁移/第38能力；真实测试穿过AuthorityCommitLog、local owner/transfer、SecretStore、checkpoint target、exposure、mesh与三平台adapter，覆盖每phase崩溃、双请求、取消边界、响应丢失和连续重启，不新建runner或范围外矩阵。 |
