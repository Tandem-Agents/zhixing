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
- 单元：第 36 单元（S10）— 托管服务与角色自恢复
- 架构与规格来源：`always-online-and-local-execution-requirements.md`（值班设备持续在线、干活电脑开机后自动上线、离线任务排队并在恢复后回到原请求位置）、`distributed-runtime-charter.md`（单一安装包与单一组合根、按启用角色注册跨平台托管服务、anchor 崩溃/重启自恢复、executor 由用户选择自动上线、纯 surface/按需单机零额外常驻、SecretStore 服务上下文与 ready 条件、零技术术语产品语言及 S10 验收边界）、`specification.md`（SecretStore、signed trust/current role authority、`MeshRoleBootConfig`、无 trust chain 的单机缺省、设备级唯一 composition root、executor owner lock、`recovering/ready/degraded`、本机 transport/启动回滚、离线队列唤醒与原 `turnOrigin` 通知、未启用角色零加载/零监听及第 36 单元执行计划）、`s2-security-supply-chain-review.md`（不得因托管服务引入未审安全依赖或扩大秘密暴露面）；上游冻结复用第 33～35 单元已封版的 current trust/current owner、角色解析、SecretStore、installed-generation 恢复、pending obligation/outbox、inventory/capability 与凭据 readiness，不另建权威或恢复事实源；下游仅向第 37 单元交付可查询、可安全请求关闭的托管实例，向第 38 单元交付稳定的服务规格/入口边界，不提前实现停机移除或升级发布。
- 单元边界：只把现有 `serve` 生产组合根接入操作系统托管并闭合角色驱动的自恢复。唯一 host launch plan 由 current signed trust/current-authority、严格本机 `enabledRoles` 与 executor 自动上线选择共同派生并明确区分 `managed/on-demand/none`：只有本机同时是 current anchor 且启用 anchor 时才因值班职责强制托管；非 current-anchor 且启用 executor 的设备（可同时含 surface）由用户选择 `managed` 或 `on-demand`；无 trust chain 的单机缺省保持 `on-demand`；纯 surface/空角色为 `none`；非 current 设备仍启用 anchor 属配置矛盾，必须拒绝而非启动旧值班角色。current anchor 与 executor 同机仍由一个 host 按完整有效角色集装配。托管入口必须复用现有 `runServeCommand`、拓扑解析、SecretStore、设备 owner lock、startup rollback 和 current-owner gate；只有 trust/角色/密钥可解锁、必要安装恢复及本机设施全部 ready 后才公开。OS supervisor 负责安装后启动、登录/开机拉起与崩溃重启，anchor 恢复既有 authority/consumer/outbox，executor 恢复认证连接并用既有 inventory/capability 唤醒排队任务；安装/配对完成、本机配置提交、已验证 trust/current-authority 变化和每次 managed 启动都必须重算同一 plan，任何失败不得形成第二 runtime、伪 ready 或错误角色监听。角色/选择变化只协调未来自动启动与当前实例的既有安全关闭，不撤销身份、不删除数据、不改变 current authority。
- 明确排除：第 37 单元的“只停本次”、长期关闭值班、移除普通设备、卸载时 authority/identity/cache/export 清理及三路径阻断；第 38 单元的包升级、兼容检查、原子替换、健康门禁、自动回滚、发布矩阵、支持包和最终全量 CI；网络分区自动 failover、quorum/witness、多 active anchor、全局或持续同步、灾难恢复应用、通用进程编排/生命周期/IPC/路由/registry、第二角色或服务事实源；为每个角色安装独立进程/服务、让 surface 常驻、强制按需单机后台化、把 executor 自动上线选择变成角色授权；除本机 OS 定义启动当前安装所必需的 canonical `zhixingHome`、CLI/Node 入口及安全日志位置外，在服务定义、命令行、环境、日志或公开状态中写入 SecretStore 内容、恢复材料、token、workspace 原始路径、raw device identity 或其他秘密，且上述必要本机路径也不得进入公开状态；新监控、诊断、benchmark、信息采集、lint/test runner 及非必要第三方依赖。

### 开发事项

状态：`[ ]` 未完成；`[x]` 已完成；`[!]` 阻塞。进度：`9/9（100%）`。

| 状态 | 编号 | 开发事项 | 必须交付的实现与直接相关测试代码 |
|---|---|---|---|
| [x] | D36-01 | 冻结 host launch plan 与角色选择合同 | 依据总纲“一个产品/一个包/一个组合根”、signed trust/current-authority角色权威及第36单元角色矩阵，在现有严格`MeshRoleBootConfig`增加`executorAutoStart?: boolean`（只决定自动上线，缺省`false`），并建立无副作用`resolveHostLaunchPlan()`判别联合`managed | on-demand | none`。输入必须是同一home的已验证current signed trust/current issuer、已经过subset校验的完整`enabledRoles`、本机active member/device identity和该选择：本机是current anchor且启用anchor时为`managed`；非current-anchor但启用executor（无论是否同时含surface）按选择为`managed`或`on-demand`；current anchor+executor仍为`managed`且由单host加载完整有效角色集；无genesis单机缺省为`on-demand`；surface-only或空角色为`none`。本机不是current anchor却仍启用anchor、未知字段、链/配置越权、current-authority矛盾或identity不唯一必须返回稳定错误，不能降为`none`、裁剪anchor或仅启动executor。plan只决定OS/按需启动形态，不改变trust授权或runtime role set，也不是第二事实源。补current/旧anchor、anchor+executor/anchor-only/executor/executor+surface/surface/disabled、选择开关、首次配对前后、planned/disaster换代、role revoke/reenroll及无trust chain测试；若缺失会让旧值班角色重启，或让纯surface与按需宿主误走同一分支。 |
| [x] | D36-02 | 建立跨平台、同秘密上下文的窄托管适配器 | 依据“单一安装包注册跨平台服务”、SecretStore服务上下文及设备资源不变量，在CLI包内建立唯一`ManagedServiceSpec`/`ManagedServiceAdapter`合同与win32/darwin/linux实现，范围仅含`inspect/install/disable/start`和稳定read-back，全部操作接受`AbortSignal`与有界命令超时。Windows使用当前用户登录触发托管任务和失败重启策略，macOS使用当前用户`LaunchAgent`的`RunAtLoad/KeepAlive`，Linux桌面使用`systemd --user`，无头anchor仅在同一用户的machine-bound SecretStore可回读时启用linger实现开机拉起；桌面平台的最早自动恢复点是能够解锁系统凭据库的用户登录，无头平台是开机。先收紧现有`PlatformSecretStore`：首次创建时沿用现有私有原子写与初始化锁，在受保护本地元数据中固定不含秘密的backend binding，后续前台/managed只能打开同一backend；既有store缺binding时只能在成功解锁后按确定性平台与既有`secret-vault.key`/vault事实一次回填，歧义或managed环境首次打开均不得猜测或创建新key。Linux不得因managed环境缺少`DISPLAY/WAYLAND`而从既有Secret Service vault改选machine-bound、生成第二key或覆盖binding，当前上下文不能解锁时只返回`unavailable`并等待正确会话。每份服务定义绑定current OS user、canonical`zhixingHome`、已固定backend、当前安装唯一CLI/Node入口和`serve` managed模式，service identity由user+home稳定派生；定义、参数、环境和日志不得含key/token/恢复材料，环境只允许启动与既有backend连接所需的最小白名单。仅服务定义的创建/替换新增既有storage governor窄`managed-service-reconcile` maintenance kind：持本地permit完成临时文件fsync→原子替换→目录fsync后立即释放，OS manager enable/start、等待和重试不持permit或authority/store/lifecycle锁；随后必须read-back，同规格exact replay。平台不支持、权限不足、定义冲突、容量/磁盘、取消、命令挂起、部分效果或read-back不全均稳定失败且不得退化为另一detached resident。补三平台定义golden、既有store确定/歧义回填、前台创建→managed重开、Linux桌面环境缺失/恢复、headless开机、空格/转义路径、同/异home、重复安装、各写序切点、容量/取消/超时、权限失败、未知平台与秘密零落盘测试；不引入第三方daemon或secret lifecycle框架。 |
| [x] | D36-03 | 让注册协调覆盖全部真实变更入口并保持单实例 | 依据设备级唯一composition root、现有owner锁与“安装/角色关闭”验收，建立窄`reconcileManagedService()`，每次自行读取并重算D36-01 plan，不接受调用方自报plan。生产触发exact-set为：issuer/joiner双方完整pairing/bootstrap成功、受支持本机配置入口提交`executorAutoStart`或`enabledRoles`、已验证trust/current-authority事件在本机应用、每次managed入口preflight，以及现有`CoreHostConnection`发现本机host缺失时的生命周期恢复分支。host缺失时，`managed`修复注册/启动并连接，`on-demand`才复用原`spawnDaemon`，`none`不得创建本机host并只走该surface既有远端入口；健康host或纯读投影不得反复写OS。配对中间态不得注册，无genesis单机只能按需，既有定义的版本替换留给第38单元。`managed`按D36-02做inspect→install/enable read-back→start，`on-demand|none`均disable并read-back已有自动拉起定义但仅前者允许显式拉起；同plan、并发、效果/响应丢失和重启幂等，异home互不覆盖，定义被篡改或指向其他安装版本时fail-closed并留给第38单元替换。managed与现有按需/foreground宿主竞争时复用PID marker、health、端口和workspace owner：已有健康同home宿主继续服务，managed进程只能作为零角色副作用的preflight waiter等待其退出，再重新读取plan、service spec和PID事实后进入同一`runServeCommand`；不得把“发现健康宿主后成功退出”当作已托管。未ready宿主不得被第二套设施替代，stale marker清理后仍只允许一个winner。补五类触发exact-set、三类plan分支、服务安装失败→下次host缺失恢复、首次配对各切点、current-anchor换代、双reconcile、managed/on-demand/foreground三方竞争、长期健康daemon→退出→plan变化/managed接管、stale marker、两个home、定义漂移与连续重启测试；surface-only和无genesis单机均不得触发OS注册。 |
| [x] | D36-04 | 复用唯一 serve 组合根并闭合托管启动门禁 | 依据单一组合根与`recovering→ready/degraded`合同，把现有布尔daemon child收紧为`foreground | on-demand | managed`三态进程形态；managed入口在D36-03 preflight后仍只进入现有`runServeCommand`、`MeshRuntimeBootstrap`、`planServeTopology`和`runConfiguredServeTopology`，与on-demand共用日志/health设施但不装配idle reaper，也不新增第二套server/executor。managed启动强制非交互，不运行配置向导、不打印token/path/监听地址横幅；先按既有顺序完成config、SecretStore解锁、trust/current-authority/role解析、disaster/planned installation completion、storage capacity、executor owner、本机transport及角色设施，plan已变`none`时先幂等disable自身再退出，plan无效或秘密暂不可用则零监听失败交给supervisor重试。readiness marker与公开listener只能在全部required gate成功后出现；任一错角色、key锁定、trust/root/member矛盾、owner busy、端口/设施失败必须执行existing reverse rollback，零残留listener/secret/published state并以稳定失败退出，可选外部binding故障仍只按既有readiness降级。补三进程形态、managed自禁用、ready前各失败切点、rollback逆序、idle/no-client、owner竞争、错误role/config/SecretStore及真实子进程health测试。 |
| [x] | D36-05 | 闭合 anchor 崩溃、登录/重启后的权威自恢复 | 依据“anchor 崩溃/设备重启自恢复”和上游 current-owner/installed-generation 合同，托管 anchor 每次拉起必须从真实 `AuthorityCommitLog`、trust/current installation、AuthorityCatalog 与现有 consumer receipt 恢复，而不是建立 service 专属 journal；在公开准入前重驱 planned/disaster post-install、generation rebind、scheduler/conversation/interaction/confirmation/final/delivery 与六类 pending obligation，并恢复原 request/task/effect identity、cursor和 durable outbox。进程崩溃、OS 登录/开机启动、效果前后失败与连续重启都只由既有 reducer/owner 决定 exact replay，旧 epoch/issuer不得重新服务；OS supervisor只负责有界失败重启，不得把反复 fail-closed 冒充 ready或创建第二 authority。补两个 current-anchor profile、空/非空六类 pending、cursor已推进、崩溃前后每个 receipt、旧 epoch输入、端口占用、SecretStore暂不可用后恢复及连续拉起测试；证明自恢复不依赖人工执行 `serve`，也不提前建设通用生命周期或监控系统。 |
| [x] | D36-06 | 闭合 executor 选择、自动上线与排队任务续驱 | 依据“干活电脑按用户选择在开机/登录后上线”和规格离线队列行，非current-anchor且启用executor（可同时含surface）的加入设备必须在pairing/onboarding用“让这台电脑开机后自动上线并继续任务”收集明确选择，并与`enabledRoles`同次耐久写入D36-01配置；TTY可交互选择，非TTY必须显式给值，issuer侧重复出码必须保留既有`executorAutoStart`，joiner侧不得从roles猜值或被后续bootstrap配置覆盖。current anchor+executor因值班职责必然运行完整角色集，不展示一个无法兑现的executor关闭选择。选择开启后托管host复用现有认证control connection、reconnect owner、capability/inventory publication和workspace owner；只有设施ready后才宣告online，anchor看到同device/generation ready transition后按既有retry owner唤醒该设备排队任务，完成/失败只通知原`turnOrigin`且同一终态幂等一次，不跨渠道广播。选择关闭、纯on-demand或role被撤销时零自动进程/监听，但用户显式运行本机命令仍复用同一host链；离线、网络挂起、anchor不可达、workspace owner busy、capability变化、响应丢失及重连只能保持queued/retryable，不得重复认领或伪online。补executor/executor+surface的选择开/关、TTY/非TTY、issuer保留/joiner提交、首次/重复pairing、登录重启、断网重连、inventory变化、任务完成/失败、原位置通知与anchor+executor完整装配测试。 |
| [x] | D36-07 | 安全协调 current-authority/角色关闭与选择变化 | 依据第36单元“角色关闭、未启用零进程/零监听”验收，把D36-03 reconcile接到现有受验证trust watcher/current-authority resolver：本机失去current anchor、成员不再active、角色被移除或executor自动上线关闭时，先让current-owner/role gate即时拒绝对应新准入与新listener，再禁用未来OS拉起并read-back，最后经现有本机认证控制面请求当前managed host等待既有安全关闭链到终态或耐久安全点并释放listener/owner/secret。重算仍为`managed`（例如current anchor+executor仅关闭executor选择）时不得停止或裁剪单host；只有`managed→on-demand|none`才关闭managed实例，之后`on-demand`仅允许用户显式拉起。非current却仍启用anchor等安全型plan错误也必须先关gate、disable并停止，不能因配置报错保留旧值班服务自动重启。远端事件到达后断连、离线期间变更后下次managed preflight、并发角色变化、关闭期间崩溃、disable效果丢响应与进程已退出都必须收敛到“定义不再启用、失效角色零准入/零监听、无managed host”；若existing stop blocker未安全收束，维持gate关闭并公开“正在结束当前工作”，禁止force kill、删除authority/identity/cache或伪造已关闭。补current→旧anchor、executor managed→on-demand、revoke/surface变化、选择开关、最后角色关闭、安全型plan错误、在线/离线trust变化、blocker空/非空、关闭/崩溃竞争、OS disable失败、连续重启和关闭后显式按需启动测试；第37单元三路径协议不提前实现。 |
| [x] | D36-08 | 提供零术语的托管状态与可行动错误 | 依据总纲零技术术语和“用户无需理解常驻进程”，扩展现有 status/配对结果的有限公开投影，只从D36-01 desired plan、D36-02 OS read-back、现有PID health与runtime readiness组合出`不需要后台运行/等待开机上线/正在启动/可以使用/正在结束/需要处理`等稳定用户态；同一状态在CLI与server共用mapper。状态不得泄露raw PID、service/task/unit名称、home/可执行路径、device ID、role名、trust epoch、SecretStore backend或原始OS错误；需要处理时只给“重新登录系统/解锁本机凭据/重新运行配对设置/检查本机权限”等由已知错误码支持的动作，不把可选target或外部binding离线误报为host失败。唯一设备名可展示，重名继续用既有明确选择而不暴露内部ID。补desired×registered×process×runtime有限映射、CLI/server exact keys、TTY/非TTY、重名、坏配置、SecretStore锁定、可选binding离线及raw error/path/ID隔离测试；不新增诊断、遥测或支持包。 |
| [x] | D36-09 | 冻结生产装配 exact-set 与第36单元直接验收证据 | 依据角色装配不变量与第36单元执行计划，扩展现有有限descriptor/validator和直接场景测试，机械反绑：两个current-anchor profile各最多一个home级managed host且只有current anchor可因anchor角色注册，非current却启用anchor必须拒绝；executor与executor+surface按选择分别进入managed/on-demand；anchor+executor仍走同一serve topology；surface-only/disabled为none，无genesis单机为on-demand，后二者在OS adapter均零注册且surface-only在本机角色模块/进程/listener为零；managed入口只委托既有composition root，配置写、trust/current-authority应用、host缺失恢复和managed preflight生产触发与descriptor exact-set全等，SecretStore在同用户/机器上下文解锁。用可控三平台adapter加真实CLI子进程覆盖首次安装、同规格重放、登录/开机模拟、崩溃拉起、managed/on-demand长重叠后接管、等待期间plan变化、current-anchor换代/role关闭、坏定义/权限/容量/取消/秘密上下文、anchor pending恢复、executor离线队列续驱和原`turnOrigin`通知；断言服务文件写入命中现有governor、网络/OS等待零permit、所有用户态无技术字段、既有security dependency gate仍通过，并机械证明第37单元删除/卸载、第38单元升级/回滚/发布、自动failover与持续同步均未装配。不得新建lint/test runner或运行与本单元无关的全量矩阵。 |
