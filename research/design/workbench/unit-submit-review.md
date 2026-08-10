# 单元独立审查工作台

> **维护原则**
>
> - 以文件中唯一且独占一行的 `## 审查清单` 为界：此前为静态区，保存长期稳定的规则；该标题及其后为动态区，保存当前开发单元的独立审查内容。定位时必须整行全等匹配；匹配数不是 `1` 时立即停止。
> - 动态区只固定“当前状态”“来源覆盖”“审查项”“P0/P1 阻断问题列表”“非阻断级问题列表”及其空表。来源分类、审查分区和审查项均须按当前单元重新生成，不得继承上一单元。
> - 历史动态区统一归档到 `research/design/workbench/unit-review-checklists/<module-id>/unit-<N>.gen-<G>.md`，避免跨模块同号单元冲突。
> - 重置步骤：从独占一行的“审查清单”标题起，将当前动态区原样写入同路径的 `.pending` 文件，完整校验单元身份、全部数据行及两类问题列表（包括空表）后原子改名为正式归档；正式归档已存在时，内容一致则复用，不一致则停止。归档完成后，才将当前状态改为下一单元，删除全部来源分类、审查分区和数据行，只保留固定空表，并将进度恢复为 `0%`。
> - 提示词由用户维护；未经用户明确授权，不得新增、删除或修改提示词，规则变化也不得自动同步到提示词。

## 一、定位、范围与质量责任

本工作台用于开发单元完成后的独立审查。审查清单是本单元必做审查动作的有限集合，不是所有可能风险的全集；它同时依据权威架构、单元边界和当前完整交付物生成。在其他交付门禁均已满足的前提下，只有清单覆盖完整且每项通过，才能判定单元可以提交。

独立审查服从当前版本的**最小完整产品范围**：范围内的核心功能和产品体验必须完整、优秀，正确性、安全性与耐久性不得降低；范围外的非核心增强、未来能力、通用框架、纯观测/benchmark、诊断设施、推测风险和非必要重构不得进入清单或成为提交门禁。“覆盖完整”只指权威来源和锁定单元边界的有限闭包，不是穷尽所有可能改进。

每个新增审查项和问题都必须能够反绑权威要求，或证明当前可达失败会阻断核心使用、破坏既定产品体验或违反冻结合同。不能证明者判为不适用或非必要增强；P2/P3 只登记、不阻塞。满足定稿或通过条件后立即停止，不得用更换视角、追加证据设施或追求无限完美延长单元。

审查清单必须从架构目标、单元边界和当前完整交付物推导，覆盖范围包括但不限于全部生产端与消费端、生产装配与拓扑、状态生命周期、异常与恢复、并发、安全、资源上界、非默认配置、边界条件、兼容性、验收条件及其验证证据。模块目录内文档及其声明为规范依据的项目文档必须全部进入来源判定；每份来源逐章判定，适用章内的规范性条款和枚举行还须逐条归入审查项，不适用则写明事实依据。不得只枚举已知适用章节，或以“已有映射”替代映射充分性核查。不得只围绕已知问题、最新改动或容易观察的路径制定；任何未判定来源、章节、条款、枚举行或未纳入清单的功能链和风险面都属于范围缺失。

每个审查项必须限定对象、边界和停止条件，能够在有限成本内独立判定并给出可复核证据；“系统横扫”“全部覆盖”“至少组合”等开放表述必须改写为有限闭包或明确清单。无法判定的适用要求必须拆分或改写，只有事实证明不适用或重复时才能删除。

审查项只描述功能、架构、风险与稳定的通过条件。构建或测试的当次结果、命令状态、任务进度、当前指纹及 Git 工作区或暂存区状态只作流程状态或证据，不得建立为独立功能审查项。

每轮独立审查必须逐项执行完整清单并记录结论。发现问题只登记，不得提前结束；整轮完成后一次性汇总全部真实问题。清单未走完、存在未判定项，或发现交付边界尚未进入清单时，不得给出通过结论。

## 定稿与重定稿条件

清单同时满足以下条件即定稿，停止继续补充：

1. 本单元适用的规范性要求与交付物的全部功能链均有承载项；不适用项均有事实依据；没有超出本单元边界的条目。
2. 每个审查项范围有限、可独立判定并能给出可复核证据。
3. 已知失败模式、排除项重开条件和迟发现教训的适用检测动作均有落点。

定稿审查只接受范围遗漏、范围越界或条目不可判定三类问题；仅更换审查视角、假设未知风险、改善措辞或提出非必要增强，不得推动清单继续扩张。三类问题清零后，清单审查结束，不得重复发起。

### 清单重定稿

已定稿清单只对生成时的完整交付物有效。独立审查发现的问题被认定为开发阶段功能遗漏，并在开发工作台补充实现，导致功能链、合同、规范来源或交付闭包发生实质变化时，旧清单自动失去定稿效力。此时允许在存在旧 `[!]` 的情况下进入清单重定稿：先把两类问题列表完整转入当前单元正式文件，再将已变化的旧 `[!]` 和受影响的 `[x]` 改为 `[~]`，新增审查项标为 `[ ]`，只保留能够证明未受影响的 `[x]`；旧证据明确标为失效，不得继续代表当前结论。重新满足“审查清单定稿条件”后，方可执行独立审查。

## 问题等级与通过标准

| 等级    | 含义                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------ |
| P0 阻断 | 导致受支持的核心路径无法正常运行，或造成权限失守、数据丢失、耐久性破坏、不可恢复停摆；提交前必须解决。 |
| P1 严重 | 在明确但受限的场景造成重要功能失败或高风险架构债务；核心路径仍可运行，但提交前必须解决。               |
| P2 一般 | 局部影响健壮性、性能、资源回收或可维护性，不破坏核心正确性、安全性和耐久性。                           |
| P3 轻微 | 仅影响低价值体验、诊断或代码质量，不影响功能正确性。                                                   |

审查项完成且无 P0/P1 时标为通过；发现 P0/P1 时标为有问题并登记。P2/P3 只进入非阻断问题列表，不改变审查项的通过状态。全部审查项完成且 P0/P1 列表为空，即判定独立审查通过。

登记任何等级的问题时都必须给出工作量评估，说明解决该问题所需的预计投入；不得因问题具有阻断性而省略。

### 验收设施问题的升级门禁

发现测试、runner、golden、账本、见证或证据链缺口时，先裁定问题属于哪一层：

1. **生产功能错误**：当前可达功能、产品体验或冻结合同本身错误，按实际影响评级。
2. **必要证据缺失**：核心正确性、安全性或耐久性没有任何成比例的直接证据，导致无法安全提交；只有这种情况才可能因证据缺口评为 P0/P1。
3. **验收要求过度**：真实行为已有直接测试或结构证据，只是自报标签、重复元数据或验收措辞宣称了无法证明且非必要的更强结论；应删除或简化该要求，不得据此建设新的见证、采集或变异框架，也不得评为 P0/P1。

把验收设施问题评为 P0/P1 或“工作量：大”前，登记内容必须同时写明：不处理会出现的当前可达产品失败、违反的必要合同、现有直接证据为何不足，以及删除/降级错误要求或复用既有证据为何不能解决。任一项无法证明，升级无效；规格中的验收文字也必须先接受最小完整产品与成本收益裁决，不能仅因已写入文档就自动转化为实现义务。

## 二、独立审查清单提示词

### 2.1 生成独立审查清单

```
完整读取当前单元的架构总纲、可执行规格或执行计划、上下游合同、验收要求及当前完整交付物，确认单元身份、边界和生产装配关系。存在架构总纲时以其为最高依据，审查范围不得偏离或弱化架构设计。

按照本工作台“定位、范围与质量责任”，为当前完整交付物生成独立审查清单并写入动态区。该清单全部通过即表示本单元可以提交，因此必须覆盖整个单元，不能只围绕现有实现、最新改动、默认路径或已知问题；交付物缺少架构要求的实现，也必须形成审查项，不得借现状缩小范围。

先枚举全部规范来源，并逐章判定“适用”或“不适用”；适用章内的规范性条款和枚举行逐条归入审查项，不适用项写明事实依据。再沿当前交付物的完整功能链核对生产端、消费端、共享原语、装配与拓扑、状态生命周期、异常恢复，以及适用的边界条件、非默认场景、并发、安全、资源、兼容性和验收证据，拆成范围有限、可独立判定并能记录证据的审查项。

存在未判定来源、章节、条款、枚举行或功能链，存在范围遗漏、越界、重复、含糊或无法独立判定的条目，或架构不足以确定审查边界时，清单不得定稿；架构空洞必须明确登记，不得用实现假设补齐。本任务只生成并定稿审查清单，不执行审查，不修改实现；完成后立即停止。
```

### 2.2 目标模式：审查并定稿“独立审查清单”

```text
目标：通过多轮“独立审查—集中修正—受影响范围复审”，将当前单元的独立审查清单定稿；确保清单全部通过即可提交，既不遗漏锁定范围内的真实问题，也不把范围外增强变成提交门禁。

首个动作及每次续跑或历史压缩后的首个动作：读取本工作台静态规则、当前独立审查清单及其已列权威来源，并核对当前完整交付物；只依据文档中的当前状态继续，不得沿用生成清单时的范围判断，也不得重复审查事实未变化且已确认无问题的局部范围。

进度反馈：首次读取后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，以百分比报告距离完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮或单项进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 首轮从权威来源正向核对全部来源、章节、规范性条款和枚举行，再沿完整功能链核对生产端、消费端、装配与拓扑、状态与恢复、边界场景及必要证据，最后把当前交付路径反向归入审查项；整轮完成后一次性归并问题。
2. 只修改清单的来源判定、审查项和范围说明，集中修正范围遗漏、范围越界和条目不可判定；不得执行独立审查、修改实现或运行构建与测试。修正后只复审变化项及其直接交界，未受影响的结论继续复用，历轮问题不得无依据消失。
3. 每个新增或扩写的审查项必须反绑权威来源和当前单元必要性，并具有有限对象、明确停止条件和可复核证据。未来能力、通用预留、纯观测或 benchmark、诊断设施、推测风险和非必要增强一律排除，不得以“更完整”推动清单无限扩张。
4. 准备封版时，对同一份未修改清单执行一次冷启动对抗复审，不得复用前轮结论：分别从“来源条款是否全部有落点”“完整功能链是否存在断点”“生产装配与交付路径是否全部归项”“条目是否越界或缺乏当前价值”四个对立视角重新推导应有范围，并与清单及不适用依据双向对账。发现真实缺口后必须修正并重新执行本步骤。

只有出现无法由权威来源确定、且会改变产品需求、用户体验或单元边界的真实需求空洞时才暂停；其余架构与清单组织选择按锁定范围内的最优方案自主收敛。

完成条件：同一份未修改清单通过冷启动对抗复审；全部适用来源、章节、条款、枚举行、功能链和交付路径均已判定，所有审查项有限、无重复、可独立判定且能记录证据，不存在范围遗漏、范围越界、条目不可判定或未处置反证。满足后明确回复“独立审查清单通过”并立即停止；不得继续增加视角、扩充范围或开始执行独立审查。
```

#### 审查“独立审查清单”

```
审查“独立审查清单”中的审查点，范围是否满足“全部通过就可提交”的要求，坚决不能出现全部通过，但是还有遗漏问题的情况。
同时范围不能超过本单元边界；有问题统一告诉我；
满足“审查清单定稿条件”立即停止；
```

### 2.3 执行独立审查

```
完整读取当前单元的权威架构、单元边界、当前完整交付物及已定稿的“独立审查清单”，以清单当前状态确定本轮范围。开始时若仍存在 `[!]`，说明阻断问题尚未完成转存、修复或状态更新，立即停止并报告；否则审查全部 `[ ]` 和 `[~]` 项，直接复用 `[x]` 项，禁止重复审查。

问题判断以本单元完整交付后用户实际使用的受支持场景为准，覆盖适用的正常、边界、故障、恢复与对抗路径；不得以功能尚未交付、尚未观察到事故、正常 producer 当前返回合法数据或默认路径可用作为“无问题”依据。每个疑点必须二元落定：完整实现投入使用后存在可达失败，或违反当前必要的正确性、安全、耐久性及产品体验合同，即登记为当前问题；不存在可达失败且不违反必要合同，即明确排除。禁止登记“未来可能需要”“暂时没问题”或“看情况处理”的模糊事项；不属本单元但已确定未来必须交付的义务只进入全局计划更新全局文档，无确定交付义务的直接排除，均不得进入本单元两类问题列表。

逐项完成本轮应审内容，不得跳项、合并或因发现问题提前结束；只报告基于事实的真实问题，审查期间不得修改实现。每完成一项，立即更新状态、证据和当前进度：存在 P0/P1 时标为 `[!]`；不存在 P0/P1 时标为 `[x]`，P2/P3 不改变该项通过状态。

审查期间不登记问题列表。全部应审项完成后，统一分析本轮发现的问题，将同一根因及其上下游影响合并为一个问题，避免重复登记表象。P0/P1 写入“P0/P1 阻断问题列表”；P2/P3 写入“非阻断级问题列表”，并写明问题、影响、最优解决方案、工作量和评级。全部审查项为 `[x]` 且 P0/P1 为空时，判定独立审查通过。
```

#### 对抗复核问题价值

```
站在与上一轮审查结论对立的位置，对本轮发现的每个问题重新进行价值裁决。不得沿用原问题的评级、方案或“既然发现就必须解决”的前提；举证责任在主张当前处理该问题的一方。

逐项从当前产品目标、单元边界和生产事实独立判断：问题是否真实且命中根因；不处理会在哪个受支持场景造成什么具体后果；该后果是否阻断当前最小完整产品、破坏核心体验或违反必要合同；现在解决能获得什么实际价值；是否属于当前单元。未来可能、理论不完美、单纯增加完整性或已有文字要求，均不能单独证明当前处理的必要性。

按“保持现状或后置 → 修正规则或要求 → 复用现有机制 → 最小完整修复 → 新增能力或基础设施”的顺序比较方案。选择成本更高的方案前，必须用事实排除前面的选项；方案不得以解决问题为名扩张产品范围或制造超过问题价值的复杂度。

裁决唯一标准：最终方案必须同时达到当前范围内的最优用户体验和最优架构。低成本不能牺牲体验或留下结构债务，架构完整不能保留无用户价值的复杂度。每项须分别明确两者是否达标，任一为否即禁止缩减。

重新核定评级、工作量和方案。P0/P1 或大工作量只有在当前具体损失、处理必要性和方案比例性全部成立时才能保留。对每个问题固定输出：事实与根因、当前损失、不做的后果、处理价值、范围归属、最小完整方案、评级与工作量、最终结论（保留／降级／后置／改写／删除）。随后合并同根问题并同步修正本轮两类问题列表。

凡裁决导致问题事实、根因、影响、范围、评级、工作量、方案或处置结论发生变化，必须在问题描述中追加“价值裁决记录”，写明原结论、推翻或收窄它的事实、新决定及重开条件。裁决为删除且没有确定未来交付义务的，从两类问题列表移出并登记为“已删除问题的价值裁决记录”，供转存到正式单元的“已排除问题”；已确定未来必须交付但不属本单元的，更新到全局文档，不得留在本单元问题或排除记录中。禁止保留“后置”“可能需要”或“看情况”的模糊事项。不得修改实现；全部问题完成价值裁决后立即停止。
```

#### 复核范围收敛是否误伤产品体验

```
我有一个担心：我们进行这次审查，是为了控制范围，避免无限扩张导致规模失控；根本目标仍然是围绕架构总纲，向用户提供具有优秀产品体验的功能。可以砍掉越界、低价值或过度实现，但不能砍掉用户体验。请重新判断当前最新版本是否同时满足这两个目标；有问题统一说明，没有问题直接简要回复。
```

### 2.4 将审查问题转入问题列表

```
先读取《单元审查与修复工作台》的静态规则。若本单元尚未登记，按其中“单元状态与登记协议”完成登记并更新当前单元指针；随后读取本单元文件中“问题列表”的维护规则、字段与状态约定。

将本轮独立审查登记在《单元独立审查工作台》“P0/P1 阻断问题列表”和“非阻断级问题列表”中的全部当前问题，转入《单元审查与修复工作台》当前单元正式文件的“问题列表”；将“已删除问题的价值裁决记录”转入正式文件的“已排除问题”。写入前，先读取目标“问题列表”的维护规则、字段与状态约定，并严格按其格式登记。

每个根因只保留一行；与已有问题同根时更新原记录，不得重复新增。每行必须写齐事实与证据、根本原因、完整影响面、受影响审查项、最优解决方案与验收条件、状态，并保留问题等级和工作量判断。

源问题包含“价值裁决记录”时，必须将其完整转入，并以裁决后的事实、评级、工作量、方案和结论更新目标记录；不得让目标中的旧记录覆盖裁决结果，也不得恢复裁决已经否定的主张、评级或方案。只有源记录写明的重开条件已被新生产事实或范围变化满足时才可恢复，并须同时写入触发重开的事实与证据。

已排除问题必须写齐原主张、排除事实与依据、重开条件；已确定未来必须交付但不属本单元的事项不得转入单元文档，只核对其已进入全局文档。遇到“后置”“可能需要”或“看情况”等未落定事项，停止转移并报告情况。

最优解决方案必须面向执行者，用最少的文字说清改什么、怎么改、关键边界以及做到什么算完成；不得长篇大论，也不得省略他人直接执行所需的具体步骤。

确认当前问题、已排除问题及全局未来义务均已正确分流后，删除独立审查工作台中的对应原记录，禁止重复维护。不得修改实现；完成转移与一致性核对后立即停止。

停止转移工作后，把“目标模式：审查并收敛问题列表”提示词内容改成本次的问题，格式、规则不变；
```

### 2.5 审查问题列表

#### 普通模式：审查问题列表

```
审查一下本单元登记文档的问题列表，挨个核查每一个问题，判断：
1、这个问题是否真正找到了根本原因，还是说只是一个问题表象，如果是表象的话，修复完之后会导致这个问题没有被彻底解决，带来低效率的重复修复工作
2、以"首席产品官 +乔布斯直觉判断这个问题的解决方案是否符合最优架构设计和最优方案的标准？

首次审查时，逐项核查全部问题；审查时，只复审上一轮发现问题且已经修改的条目。已经明确通过且内容、依据与影响面未变化的条目直接复用结论，不得重复审查；

有问题统一告诉我，没有问题直接简要回复；
```

#### 目标模式：审查并收敛问题列表

```
目标：只收敛第 35 单元正式问题列表中的 U35-01、U35-02、U35-04 三个 P0 和 U35-03、U35-05、U35-06 三个 P1，使六项真正命中 reachable-peer no-rollback baseline、真实 target readiness、pre-commit cancel/claim-only authenticated terminal、running target live handoff、credential rotation publication 与 distinct active co-signer 权限隔离的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；第 33～34 单元的 checkpoint/planned/current-owner 既有结论直接复用，价值裁决已经合并、降级或收窄的主张不得恢复，自动 failover、全局同步、恢复应用及第 36～38 单元能力不得提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-01～U35-06，只依据六项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U35-01 → U35-02 → U35-03 → U35-04 → U35-05 → U35-06` 从权威架构、规格和当前生产调用图重建事实链，核准 local/peer trust evidence、RecoveryBaseline、真实 readiness snapshot/ReadyProof、command AbortSignal、target-wide candidate/per-transfer journal、disaster installation/completion receipt、credential exposure transaction 与 reset approval context 的唯一事实源、稳定身份、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中根因还是局部表象。同根内容必须合并，独立根因不得互相遮蔽；P35-06 已并入 U35-03，既有价值裁决未被新生产事实触发时不得恢复旧评级、拆分或扩面。
2. 穷尽直接变体：U35-01 覆盖本机 current/落后链、可达 peer 同代/前进/冲突/丢响应、旧 root/issuer/epoch 与重启；U35-02 覆盖真实角色、配置、协议/资产/服务/credential revision、SecretStore 与 issuer key 缺失/换代及 commit 窗口漂移；U35-03 覆盖 inventory/read/prepare/import/commit 各 pre-commit 切点、claim-only/prepared、取消/stop、容量与网络挂起、abort/prepare竞争、响应丢失和连续重启；U35-04 覆盖两 current-anchor profile 的 live/startup、installation/participant/consumer/六类 pending 切点与完成回执；U35-05 覆盖 provider/channel/MCP binding、验证/回读/readiness失败与 exact replay；U35-06 覆盖 distinct active/issuer/pending/revoked、旧 chain/epoch 与错签名。每格必须指出稳定 identity、耐久事实、唯一线性化点、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：U35-01 只复用认证 mesh evidence 与现有 baseline selector；U35-02 只复用 production readiness snapshot builder/coordinator；U35-03 只统一现有 scoped signal、storage governor、root-signed abort 与 candidate transaction；U35-04 只复用 disaster installation loader、trust watcher、current-owner gate、installed-generation coordinator与既有 consumer receipt；U35-05 只在现有 credential editor/save 建 rotationRequired 窄分支并调用 `publishRotation()`；U35-06 只拆出读取 current signed trust 与本机 device key 的 approval context。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二事实源、通用同步/readiness/lifecycle/IPC/验证框架、迁移/路由/存储/事务/outbox/事件总线/registry、新 lint/test runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 六项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：no-rollback evidence 与真实 readiness、pre-commit lifecycle/authenticated terminal 与资源 stop、live/startup installed-generation 消费闭包与 credential publication、reset co-signer/生产证据/产品体验及第 36～38 单元边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 `U35-01↔U35-02`、`U35-02↔U35-04`、`U35-03↔U35-04`、`U35-04↔U35-05`、`U35-01↔U35-06` 以及六项与第 33～34 单元既有合同、第 36～38 单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U35-01～U35-06 的全部受支持 trust/readiness、pre-commit取消与candidate终态、live/startup接管、credential rotation、distinct co-signer及故障/响应丢失/连续重启终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会因同根残留继续局部返工。满足后明确回复“U35-01～U35-06 的根因与最优方案已闭合”并立即停止。

完成任务之后，根据最新的问题情况，把“目标模式：解决问题并完成多角色对抗收口”提示词内容改成本次的问题，格式、规则不变；
```

### 2.6 识别开发阶段遗漏

```
我们在之前一个单元吃过亏，当时发现了一个阻塞问题，我忘了是 P0 还是 P1。当时这个问题的工作量评估是大，连续审查修复了很多次，搞不好都有七八次快十次了，每次审查都能发现新问题。
结果后来我过程中我问，这个问题他为什么需要审这么多次？结果你告诉我说，这个问题其实它不是呃，它不是一个传统的问题，而是说它其实是开发阶段的遗漏，相当于有个功能压根就没做。
而每一次审查都是在补充这个功能的其中一部分，所以审查了非常多次，导致效率很低。所以我们现在也需要对已有的这个问题，就审查清单已经发现出来的问题、已经登记的问题，需要过一下，尤其是评估工作量为大的这些问题，看看它们是真正的问题，还是属于开发阶段的功能遗漏。
```

### 2.7 目标模式：审查补充功能的独立审查清单

```
目标：把 D25-F08、D25-F09 开发完成后新增和受影响的独立审查点一次收齐并定稿，确保这些审查点全部通过时，两项补充功能不存在未被审查的生产义务，也没有越出第 25 单元边界。

只审查 D25-F08、D25-F09 对应的来源映射、IR25-01～04、12～20、22～24、26～33，以及判断清单缺口所需的最小架构与交付事实；不得重新审查无关清单项，不执行独立审查，不修改实现，不运行构建或测试，也不得把 `[ ]`、`[~]` 提前改为 `[x]` 或 `[!]`。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 核对 D25-F08 的清单闭包：唯一管理组合根、本机受信 transport、排他 bootstrap、唯一 owner/arbiter、prepare→commit、稳定操作身份、committed 重驱、completed 回放、连续前缀因果确认、checkpoint 压缩、reset preview→confirm→恢复，以及首装、并发、响应丢失、任意边界崩溃、重启、关停和路径保密，均有范围有限、可独立判定的通过条件。
2. 核对 D25-F09 的清单闭包：规格—TypeScript 合同漂移、canonical production registry golden、生产 descriptor 与可执行 scenario exact-set、真实 producer/validator/reducer/recovery owner，均有能够识别缺格、错绑、绕过和陈旧资产的机械判据。
3. 核对两项补充功能与既有合同的交界：来源覆盖表必须逐项归入；共享的安全、治理、兼容、conformance、回归和结构验收不得被新增专项隐含替代；IR25-26 必须能把新增生产文件、测试、golden、脚本、根配置和派生资产逐项反向对账，且各项之间无遗漏、重复或矛盾。
4. 每轮完整核对后一次性收齐问题，按共同根因修改清单，再只复审发生变化及受其影响的部分；持续循环，直到不存在范围遗漏、范围越界、条目不可判定、重复、矛盾或依赖实现猜测。
5. 准备封版时，对同一份未修改清单执行一次冷启动对抗复审，不得复用前述结论：分别从 D25-F08 的跨进程 owner 与耐久操作状态机、D25-F09 的生产合同与真实验收链重新推导应有审查义务，再与来源覆盖、专项项、交叉项和 IR25-26 逐一双向对账。发现任何真实缺口后必须修改并重新执行本步骤。

只有出现无法由现有产品目标确定的真实需求选择时才暂停；其余架构与清单组织选择按整体最优且不留债务的标准自主决定。

完成条件：同一份未修改清单通过冷启动对抗复审；D25-F08、D25-F09 的全部已知生产义务及与既有合同的交界都有有限、可执行、可记录证据的审查落点；即使所有相关审查项通过，也不会遗漏两项补充功能的真实问题。满足后明确回复“D25-F08、D25-F09 独立审查清单通过”并立即停止。
```

### 2.8 修复后更新独立审查清单状态

```
这一批问题修复工作结束，查看“独立审查清单”，理解状态约定。
根据问题修复的变更文件影响范围更新问题清单中的状态，看哪些审查点受到影响需要改为重审，没有受影响且通过的节点状态不变；
```

### 2.9 目标模式：解决问题并完成多角色对抗收口

```text
目标：彻底解决第 35 单元 U35-01、U35-02、U35-04 三个 P0 和 U35-03、U35-05、U35-06 三个 P1，闭合 reachable-peer no-rollback baseline、真实 target readiness、pre-commit cancel/claim-only authenticated terminal、running target live handoff、credential rotation publication 与 distinct active co-signer 权限隔离的全部同根直接变体；不得扩展到其他问题或全单元流程。第 33～34 单元 checkpoint/planned/current-owner/candidate/installed-generation 的既有结论直接复用，价值裁决已经合并、降级或收窄的主张不得恢复；自动 failover、全局或持续同步、恢复应用及第 36～38 单元能力不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-01～U35-06，只依据六项问题最新的根因、价值裁决、F35-01～F35-12 固定矩阵、C35-C01～C35-C17 反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F35-01～F35-12 固定矩阵。U35-01 覆盖 local current/落后、认证 known-peer cut、peer 同代/前进/新增 member/冲突/丢响应、旧 root/issuer/epoch 与连续重启；U35-02 覆盖真实 roles/config/protocol/assets/services/credential/SecretStore、candidate 私有 issuer key、各 revision 漂移、proof expiry、响应丢失与重启；U35-03 覆盖 inventory/read/prepare/import/commit 各 pre-commit 切点、no-claim/claim-only/prepared、cancel/stop、容量/网络挂起、prepare/abort竞争与连续重启；U35-04 覆盖两 current-anchor profile、live/startup、trust watcher首个await、generation/三组consumer/六类pending/read-back/receipt/cleanup各切点；U35-05 覆盖 provider/channel/MCP、SecretStore回读、service-verified principal/readiness、publication效果前后失败与exact replay；U35-06 覆盖distinct active/issuer/pending/revoked、旧chain/epoch、错签名、重复生成与输出丢失。逐格绑定cut/baseline/proof/candidate/phase/installation/generation/binding/approval identity、唯一耐久事实、线性化点、零副作用边界和直接证据，并持续核对第33～34与第36～38单元边界。
2. 按 `U35-01 → U35-02 → U35-03 → U35-04 → U35-05 → U35-06` 一次完成。先复用认证 mesh known-peer inventory冻结 reachability cut，让每个cut内peer返回signed `HomeTrustRecord`与从本地已知祖先到其head的exact trust suffix；现有reconciliation验home/设备/成员/签名/祖先/current issuer，cut内缺失或冲突fail-closed。现有baseline selector选择唯一no-rollback baseline，并在candidate verified transaction冻结cut/evidence/baseline digest。

   candidate claim后幂等加载或创建私有transfer issuer key；planned/disaster共用唯一production readiness snapshot builder，ReadyProof全等反绑home/request/transfer/baseline/evidence、exact key、roles/config/protocol/assets/services/credential revision、SecretStore unlock/read-back。所有有限revision producer走现有coordinator串行化，reservation保持到install或authenticated terminal，commit前exact revalidate。命令用一个scoped signal贯穿全部pre-commit和governor；network零permit，stop只拒新forward。no-claim取消零效果；claim后生成root-signed abort并复用第34单元target-wide prepared/aborted排序，先耐久terminal再cleanup，committed只前滚。

   running target复用trust watcher、current-owner gate、disaster installation loader与installed-generation coordinator：新trust可见时在回调第一个await前同步关gate，live/startup调用同一completion，完成generation rebind、三组consumer、六类pending与read-back后，在同一`AuthorityCommitLog` installation progress写`disaster-post-install-completed` receipt，才cleanup/open并让CLI报成功。credential editor/save只增加`rotationRequired`窄分支：按binding identity冻结requestId/next revision，写入并回读同一SecretStore，当前provider/channel/MCP有限适配取得service-verified principal/readiness后调用现有`publishRotation()`，active+rotated同一authority transaction。approve-reset拆出只读context，只加载唯一既有本机device key与current signed trust，要求distinct active，不加载/创建issuer key或写authority。同步直接相关架构、规格、S7与测试；同根残留并入原问题，禁止新增第二事实源、通用同步/readiness/lifecycle/IPC/验证框架、迁移/路由/存储/事务/outbox/事件总线/registry、新lint/test runner、监控、诊断、benchmark或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、baseline/peer evidence、真实 readiness/reservation、candidate cancel/abort/governor、live/startup generation/consumer receipt、credential rotation、reset approval直接合同与场景测试，现有S7 lint及必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过真实认证mesh、local/peer `FileMeshBootstrapStore`、`AuthorityCommitLog`、candidate/per-transfer journal、SecretStore、storage governor、两current-anchor profile与真实provider/channel/MCP验证边界，直接注入stale local/newer peer、cut丢响应、revision漂移、no-claim/claim-only/prepared、stop/网络挂起、watcher/consumer切点、rotation失败、co-signer状态和连续重启；不得以mock自报baseline/readiness/terminal/generation/principal或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与六项验收无关的验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读逐格重建 U35-01～U35-06 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：no-rollback evidence与真实readiness、pre-commit lifecycle/authenticated terminal与资源stop、live/startup installed-generation消费闭包与credential publication、reset co-signer/生产证据/产品体验及范围价值。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查 `U35-01↔U35-02`、`U35-02↔U35-04`、`U35-03↔U35-04`、`U35-04↔U35-05`、`U35-01↔U35-06` 以及六项与第33～34、第36～38单元边界的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第2步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U35-01～U35-06 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C35-C01～C35-C17及新增同根反证全部有耐久处置，证明认证known-peer evidence与本机/checkpoint只选择并冻结唯一no-rollback baseline；真实ReadyProof绑定同candidate/baseline/key且所有revision受reservation保护；任一pre-commit取消/stop只产生零效果、可续做或恰一authenticated terminal；running target与cold startup在同一receipt前完成generation/consumer/pending闭包；credential rotation只有service-verified新binding与旧compromised在单事务发布；distinct active co-signer零issuer权限且无不必要approval outbox。第33～34单元结论不变，第36～38单元能力未提前实施，六项均已更新为“已验证”。满足后明确报告“U35-01～U35-06 六项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 35 单元 · generation 1
- **单元身份**：S9 人工灾难恢复与安全域换代；只支持值班设备永久丢失后，由另一台 active anchor-role 设备基于用户明确选择的完整 checkpoint 副本和无回显恢复包，执行 source-less 恢复、旧安全域撤销、恢复根生命周期与逐设备重新加入。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D35-01～D35-09。上游只消费第 33 单元完整可恢复 checkpoint、恢复根激活与 retention 合同，以及第 34 单元 composite authority、installed-generation/current-owner、target-wide candidate、私有 staging、storage governor 和 post-install closure；下游第 36～38 单元能力不进入本清单。
- **交付基线**：以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 完整交付为 65 个变更路径：core 8、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2、当前单元工作台 2。其中 63 个非工作台功能路径形成问题专项冻结指纹 `30056a12eeeedfb4d22f5dca6757199e2755f78dad0fdafb245a1038e799c5c0`；同期 Unit 34 历史归档 2 路径及审查与修复状态 2 路径不属于 Unit 35 功能交付，仍在下方路径对账中明确排除。审查必须覆盖完整生产调用图与 65 条 Unit 35 路径，不得仅审新增文件或默认命令路径。
- **生产装配关系**：`zz backup recover/recover-finish` 与 `zz backup root rotate/invalidate/approve-reset/reset` 是用户入口；checkpoint directory/paired inventory 提供候选，strict disaster command、target-wide candidate journal、per-transfer journal、私有 `FileArtifactStore` 与本地 `AuthorityCommitLog` 形成目标恢复链；`MeshRuntimeBootstrap` 与 `MeshRuntimeAssembly` 在 anchor+executor、anchor-only 两个 current-anchor profile 中消费 disaster installation，先完成 installed-generation/runtime/consumer 重绑再开放 current-owner surface。Credential exposure authority 同时接入 capability publication、provider/channel/MCP/webhook/rendezvous 秘密读取与 pairing/bootstrap 路由。
- **目标提交边界**：交付 source-less checkpoint inventory、恢复根真解封与现场验证、no-rollback baseline、私有完整导入、root-signed commit/abort、原子 composite authority 安装、旧 issuer/epoch/route/binding fencing、旧设备隔离后 tombstone、恢复根 rotate/invalidate/domain-reset-establish、pending-reenroll/fresh pairing、公开零术语旅程、两生产根 exact-set/S7 与必要直接证据。
- **明确排除**：自动 failover、quorum/witness、自动升主、持续或全局同步、恢复应用、业务数据恢复向导、多目标/云备份、通用 transfer/registry/lifecycle/事务/outbox/事件总线；第 36 单元托管服务与角色自恢复、第 37 单元停机/移除/卸载、第 38 单元升级发布；单设备原地重置、issuer 与恢复包同时丢失后的绕过；监控、诊断、benchmark 与信息采集。
- **架构空洞判定**：总纲 §9、规格 §6.3/§6.4/§7/§8/§15 与 D35-01～D35-09 已唯一确定本单元产品、状态、安全、拓扑和交付边界；当前没有需以实现假设补齐的真实需求空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：0 项 `[ ]`、10 项 `[x]`、0 项 `[!]`、28 项 `[~]`；U35-01～U35-06 已在正式问题列表完成修复与专项验证，问题表保持为空。受实现、共享合同、生产装配、S7 与交付路径变化影响的 28 项已按规则失效，须由下一轮独立审查重新判定；其余 10 项输入未变，继续复用原 `[x]` 结论。

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
| core authority、严格合同与 reducer | 8 | `packages/core/src/authority/commit-log.ts`、`packages/core/src/authority/index.ts`、`packages/core/src/contracts/identity.ts`、`packages/core/src/contracts/records.ts`、`packages/core/src/contracts/schema.ts`、`packages/core/src/protocol/anchor-transfer.ts`、`packages/core/src/protocol/anchor-transfer.test.ts`、`packages/core/src/protocol/index.ts` | IR35-04、IR35-07～IR35-16、IR35-19、IR35-30、IR35-32、IR35-35～IR35-36 |
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
| IR35-01 | [~] | 单元身份、架构与范围 | 复核总纲 S9、规格第 35 项、D35-01～D35-09 与 65 条交付路径：生产范围均服务 source-less 手动灾后恢复、恢复根/凭据安全闭环及直接验收；Unit 36～38、自动 failover、持续同步和通用框架仍明确排除，未发现身份冲突、越界实现或需求空洞。证据：四份来源逐章表、开发清单、路径反向分类。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-02 | [x] | 恢复包与公开入口前置 | CLI 仅以显式 `backup recover/recover-finish` 与 root 子命令进入；恢复包没有 argv 选项，生产路径统一调用 `readRecoveryPackageFromTty`，其要求双端 TTY、独占 stdin、raw-mode 无回显、16 MiB 上限并在 `finally` 清零/恢复。取消、空/错 v1/v2 包、非 TTY 与重复 finish 均在副作用前拒绝或进入既有耐久重放。证据：`index.ts`、`recovery-package-input.ts`/测试、command/codec 测试。 |
| IR35-03 | [x] | source-less inventory 与候选选择 | directory inventory 只从冻结物理根读取已发布目录，重验 manifest/envelope/chunk exact-set 并过滤非 full authority；paired inventory 严格反绑 request/target/recipient 并拒绝重复 checkpoint。候选按时间、target、checkpoint 稳定排序，唯一项自动选中，多项必须给合法序号；公开投影仅含序号、位置、备份时间和待验证状态。证据：`checkpoint-target.ts`、`paired-checkpoint-target.ts`、`disaster-recovery-inventory.ts` 及其直接测试。 |
| IR35-04 | [x] | strict DR command/result 与状态联合 | core 将 DR command/result/state 建模为独立判别联合，逐 op/status 校验 exact keys、v1 schema、恢复根/目标 issuer 签名及 originating request/transfer；reducer 同时反绑 mode、prepare/import/commit/abort/tombstone 身份并拒绝跨 planned/conversation 混型、终态逆转和字段污染。证据：`anchor-transfer.ts`、contracts/schema 导出及逐字段污染/reducer 测试。 |
| IR35-05 | [~] | target-wide candidate 单飞 | planned/disaster 共用 `transfer:anchor-candidate` 投影并在同一 target-wide `FileAuthorityCommitLog` 事务中 claim；DR 调用顺序为 claim 后才创建 per-transfer root/journal、key 与 readiness reservation。同 transfer 全等重放复用原 claim，异 transfer/mode/identity 在 home 级稳定冲突，terminal 与 claim 同 envelope 收口并可重建。证据：`target-wide-anchor-candidate.ts`、`disaster-recovery-candidate.ts`、`disaster-recovery-target.ts` 并发/重放测试。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-06 | [x] | 恢复根真解封与现场验证 | `verifyStoredFullAuthorityCheckpoint` 先验 envelope exact shape、recipient、issuer 签名和 digest，再以 X25519/HKDF/AES-GCM 逐 seq 解封固定块并反绑 AAD、nonce、manifest/payload/coverage；声明内容逐 ref/size/digest 写入私有 sink，截断、额外、重排、错 key/target/verification 均在 authority/trust 发布前失败，明文与密钥材料在 `finally` 清零。证据：`checkpoint.ts`、`disaster-recovery-authority.ts` 及篡改/现场 verification 测试。 |
| IR35-07 | [~] | authority/trust 前缀重放与 no-rollback baseline | record page 的原 envelope/LSN/prefix digest 与候选链兼容性会严格复算；但生产 `runDisasterRecoveryCommand` 只向 selector 传入本机 `loadTrustEvents()`，从未向已认证且可达的 active peer 获取 signed trust/current-authority evidence。目标本机链落后于在线 peer 时，selector 仍把旧 root/issuer/epoch 当 current baseline，违反 D35-03 的 no-rollback 合同并可用已轮换/停用的旧恢复根接管安全域。证据：`disaster-recovery-command.ts:135-140`、`selectRecoveryBaseline()` 与 D35-03。结论：存在阻断级生产缺口，待整轮后统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-08 | [~] | 六类 checkpoint 覆盖与禁止内容 | full payload 只允许冻结的四类 authority/asset coverage，record pages 与 `ArtifactLifecycleIndex` retention exact-set 共同承载 catalog 六类恢复覆盖；payload/header 采用 exact keys，递归 checkpoint、缺/多 ref、目录漂移、秘密/环境/路径/缓存均无法进入有效 full envelope，内容不全或 digest 不符即拒绝 import。证据：`checkpoint.ts` full payload validator、Unit 33 full-capture/retention 生产链、DR catalog builder。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-09 | [x] | 无秘密 AuthorityCatalog 与 pending exact-set | catalog 由已验原 commit pages 顺序重放，逐 LSN 重算 prefix、stream ranges 与 `PendingObligationTracker`，固定六类 coverage、authority record ref、retained refs、baseline trust/current issuer 后再经 `prepareAuthorityCatalog` 规范排序与摘要；其 strict DTO 不含 secret、物理路径或 cache。少/多/乱序 page/ref/record 均在 catalog 发布前失败。证据：`buildDisasterRecoveryCatalog()`、core catalog validator 与真实 log/index 测试。 |
| IR35-10 | [~] | transfer 私有完整导入 | claim 后按 transferId 创建独立 `transfers/<id>/artifacts`、partials 与 per-transfer journal；record pages/retained artifacts 由 resumable receiver 按 offset、size、digest 逐块验真，完整 payload/catalog/imported 事实成立前不写共享 authority pointer。部分写、重复块、容量/磁盘错误和重启均从私有进度重驱。证据：`DisasterRecoveryTarget.#context`、`verifyAndStageDisasterRecoveryAuthority`、receiver 故障测试。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-11 | [~] | 共享 CAS 提升与 cleanup 边界 | promotion 只枚举已验 authority/catalog/pages/retained exact-set，先按 digest 命中共享 CAS，缺失对象才经独立 promotion partial 逐块写入；abort 仅删除 `stagingRoot/transfers/<transferId>`，不删除共享 CAS，tombstone 只推进私有 journal。已有/新/共享 digest 均保持内容寻址幂等和业务引用有效。证据：`#promote()`、abort/tombstone 路径及共享 ref 场景测试。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-12 | [x] | immutable/composite authority base | `installPlannedAnchorPrefix` 在独占 log 锁内把已解码的原 source envelopes 逐 LSN 复算 source prefix，同时以目标 logId 重建物理 frame chain；安装 entries 仅追加在 sourceHead+1，临时 WAL 完整 fsync 后原子替换并重置全部 durable projection。pointer/安装前旧 WAL 保持不变，替换后 snapshot/tail/stream 共读同一完整 WAL。证据：`commit-log.ts:306-428`、DR record-set/replay 校验。 |
| IR35-13 | [~] | DR commit 身份与签名 | commit 的 strict 身份、恢复根签名及 tuple 反绑完整；但生产 `recoveryReadiness()` 用空 providers/MCP/channels 和仅由 enabledRoles 派生的同一 synthetic digest 填充 protocol/asset/service revision，未读取目标实际角色、配置、协议、资产、服务或 SecretStore 提交代际。ReadyProof 因而可在目标不能承担值班职责时通过并授权不可回滚 commit。证据：`disaster-recovery-command.ts:347-362`、D35-04 与 target reserve/revalidate。结论：签名可信但 readiness 事实不真实，待整轮后统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-14 | [~] | 单 envelope 原子安全域发布 | DR 在单次 `installPlannedAnchorPrefix` WAL replacement 中发布缺失 baseline trust、root-signed transition、新 issuer revoke、signed trust/current owner、全部 compromised exposure、DR committed record 与 durable installation/generation；candidate refs 在锁内保持可达，临时 WAL sync→rename→目录 sync 后才可见。后续 key/journal completion 仅幂等追赶已定决策，不能改变 current owner。证据：`DisasterRecoveryTarget.commit()`、`FileAuthorityCommitLog.installPlannedAnchorPrefix()` 崩溃/重放测试。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-15 | [~] | 双端 phase、abort 与 forward-only | imported/committed/tombstoned 的 reducer、root-signed abort、late-abort fencing 与 terminal replay均严格；但 crash 可发生在 target-wide claim 已耐久（`candidate.claim`）而 per-transfer `anchor-prepared` 尚未追加之间。此时 `abort()` 先创建空 per-transfer journal并追加 `anchor-aborted`，core reducer 会因缺 `prepared` 拒绝，导致 candidate 永久非终态并阻塞同 home 后续 planned/DR recovery。证据：`prepareAndImport():228-242`、`abort():481-495` 与 reducer 首边约束。结论：claim-only 故障窗口没有耐久 signed-abort 终态，待整轮后统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-16 | [x] | 旧设备隔离确认与 tombstone | `recover-finish` 必须收到显式 `--confirm-old-device-isolated`，随后只接受 current disaster installation 的 exact transfer 与已 committed 私有 journal；未确认、错 transfer、未提交均拒绝，重复 tombstone 返回原终态。tombstone 只追加私有 terminal，不修改新 trust/current owner，旧 issuer/epoch 已在 commit 原子 envelope 永久 revoke。证据：CLI finish、`DisasterRecoveryTarget.tombstone()` 与 replay 测试。 |
| IR35-17 | [~] | installed-generation 与 post-install 消费闭包 | startup 能从 durable disaster installation 在 role gate 前激活 exact issuer key，并由 assembly 重绑九个 participant、三组 consumer、六类 pending 后才开放；但生产 DR 只有独立 CLI 构造 `DisasterRecoveryTarget`，commit 后直接回执，没有向已运行的 `MeshRuntimeAssembly` 交付 installation，也没有 live post-install coordinator 调用。目标 `serve` 已运行时，磁盘 current owner 已换代而内存 epoch/projection/cursor/consumer 仍停在旧代际。证据：`disaster-recovery-command.ts:119-159`、全仓仅两个生产构造点均在该文件、bootstrap/assembly 仅消费启动 descriptor。结论：live 接管闭包缺失，待统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-18 | [~] | current-owner 路由与旧代际 fencing | canonical registry/S7、current-authority/current-conversation router 及 direct append/credential guard 的静态 exact-set完整，冷启动后会消费新 signed owner；但 IR35-17 的 live 缺口使已运行目标仍持旧 resolver、surface generation 和 route projection，commit 回执后九组入口并未在副作用前统一切到新 owner，亦不能保证旧 epoch 写面已关闭。证据：routing exact-set 与 DR CLI/assembly 之间不存在 live handoff。结论：与 IR35-17 同根，待统一合并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-19 | [~] | exposure compromised 原子投影 | commit 从 restored source exposure latest projection 仅选旧 issuer device 的 active records，以同 identity/revision 在安装 envelope 中推进 compromised；projector 按 device/binding/service/principal/tenant/scopes identity、时间与 revision 单调重建并拒绝同时间歧义。公开 rotationRequired 只含非秘密服务/租户/scopes/hint。证据：`projectDeviceCredentialRevocation()`、commit installation entries、exposure projection 测试。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-20 | [~] | 每条秘密读取路径的 binding guard | provider/channel/MCP 由 startup credential read guard 在 generation secret 读取前映射稳定 binding；rendezvous 在 mesh control 外联及 pairing 的 guarded store 中校验；webhook 当前仅有 strict SecretRef/transport 合同、无启用的生产发送器，启用时受同 descriptor 约束。guard 只接受五类并明确排除 device-key，未知 kind fail-closed；compromised 命中 binding 阻断而其他 binding 不受影响。证据：startup、mesh control/pairing、credential descriptor/S7 与入口扫描。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-21 | [~] | 第三方凭据轮换闭环 | `CredentialExposureAuthority.publishRotation()` 本身具备 service-verified principal、revision 前进、写后回读/readiness 及 active+rotated 单 envelope；但全仓除测试外没有任何生产调用。正常 credential editor/startup 只调用 `publishActiveBindings()`，而 compromised 同 binding 会被 read guard 先阻断且该方法明确跳过 compromised/rotated identity，因此用户按恢复提示更换凭据后也无法产生 rotated 终态或恢复该 binding 路由。证据：生产调用 exact-set、`startup.ts`、`setup-delivery.ts:827-835`、authority route guard。结论：支持的恢复后账号处理旅程不可完成，待统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-22 | [~] | 资源、物理 I/O、取消与 stop | directory/paired inventory、unseal、private receiver、promotion 与原子日志写均复用同一 storage governor，chunk/header 有界且网络读取不持 permit；但生产 `runDisasterRecoveryCommand` 没有 lifecycle signal/AbortController，也未把 signal 传给 inventory `read`、`prepareAndImport` 或 `commit`，CLI 在恢复包输入后没有 pre-commit cancel/abort入口。网络挂起、容量等待或 stop 只能硬终止进程，不能先耐久 root-signed abort、等待安全点并保证 stop 后零新 I/O。证据：command 全路径调用均省略 signal、target/adapter 已有 signal 形参。结论：资源上界成立，取消/stop 合同未闭合，待统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-23 | [~] | 用户恢复旅程与公开 DTO | recover 输出只显示稳定序号、清洗后的目录 basename/设备名、备份时间与待验证/阶段文案；strict request/transfer/checkpoint/target/root/digest/epoch 均不回显，异常统一映射为不含 raw cause/path 的可行动错误。commit 后明确提示旧设备失权、逐账号处理及隔离确认，finish 需显式确认。证据：`disaster-recovery-command.ts`、public error mapper、CLI/server golden。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-24 | [~] | topology 与 owner/receiver exact-set | DR owner 只由显式 CLI 恢复命令在本机 trust 中 active+anchor 且非 current issuer 时构造；directory/paired adapter 仅提供 checkpoint-owned inventory/read，未注册通用 authority 服务。anchor+executor/anchor-only 共享该有限入口，executor-only、surface、disabled、旧 issuer、非 anchor 与未选 candidate 在首个 claim 前拒绝；S7 descriptor 反绑构造 exact-set。证据：`openRecoveryContext()`、inventory adapters、CLI registry/S7。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-25 | [x] | 恢复根 rotate 原子计划 | CLI 先确认用户动作、无回显验 current package，再生成并回读 candidate root；root event 同时受旧恢复根授权并携新根 proof。新 full checkpoint 经既有 activation coordinator 写入独立 target、回读验证后才由 current issuer 提交 rotate/verified/superseded 计划，checkpointId 与计划 digest 驱动崩溃重放。任一前置失败不改变本地 current root。证据：`backup-command.ts`、`RecoveryRootLifecycleService.rotate()`、activation coordinator 测试。 |
| IR35-26 | [x] | 恢复根 invalidate | 公开命令要求显式确认、current issuer context 与当前恢复包；root-signed invalidate 经 trust reducer 验 current epoch/root 后同 authority envelope 清除 root/backup key 与 activation digest，后续 backup/DR readiness 如实不可用。旧/错包与重复 event 被链序/reducer 拒绝；恢复只能由 current issuer 重新走现有 full checkpoint establish，不自动开启替代能力。证据：CLI command、lifecycle service、trust-chain reducer。 |
| IR35-27 | [~] | domain-reset + establish 原子计划 | reset/establish reducer、双签校验与 checkpoint activation plan 本身严格且原子；但公开 `runRecoveryRootApproveResetCommand()` 复用 issuer-oriented `openContext(false, false)`，该上下文仍要求本机启用 anchor role，并必须从本机 SecretStore 取得 current issuer 私钥。合法的 distinct active 非 issuer 设备既不应持有该私钥，也不必承担 anchor 角色，因此无法生成第二签名，恢复包永久丢失后的受支持重置旅程不可达。证据：`backup-command.ts:223-235,343-397`、`createDomainResetApproval()` 与 D35-07。结论：approval 入口错误复用了 issuer 管理上下文，存在阻断级生产缺口，待整轮后统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-28 | [x] | pending-reenroll 与 fresh pairing | domain-reset reducer 将除 issuer 外的全部 active member 原子推进为 `pending-reenroll`；运行中 control plane 每秒重读耐久 trust，`reconcileTrust()` 会断开非 active peer、删除其 rendezvous secret并撤销 surface，冷启动也只装配 active exact-set。pairing 仅对 identity 全等的 pending member生成带 fresh transcript digest 的 `reenroll`，其他已有设备不能走 enroll 绕过；distinct active approval 不可得时 reset fail-closed，不提供单设备原地重建。证据：`trust-chain.ts:145-152,245-277`、`mesh-control-plane.ts:137-203`、`mesh-pair-command.ts:795-838`。 |
| IR35-29 | [~] | 安全、最小权限与数据隔离 | strict wire/catalog/error、SecretRef、物理路径与容量 guard 均保持必要字段和零秘密外逸；但安全准入仍被三项已确认根因破坏：IR35-07 未取得可达 active peer 的签名基线即可接受旧 root/issuer，IR35-13 用合成 readiness 授权不可回滚 commit，IR35-27 的 co-signer 入口反而要求非 issuer 取得 current issuer 私钥并承担 anchor 配置。前两项可导致旧安全域回滚或不可服务目标接管，后一项违反最小权限且使合法重置不可达。证据：对应生产调用图、strict DTO/SecretRef 扫描与三项源码证据。结论：数据隔离成立，但必要安全与最小权限合同未闭合，待统一归并到既有根因。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-30 | [~] | 并发、重放、错误关联与 fail-closed | strict codec/reducer 对错 request/transfer/checkpoint/target/root/event/record/digest/epoch、终态逆转、字段污染和异载荷冲突均 fail-closed，正常 terminal replay 保持全等；但 IR35-15 的 claim→per-transfer prepared 崩溃窗使合法 root-signed abort 无法形成终态，IR35-17 的 live install 没有运行时消费重驱，IR35-21 的 rotated 终态无生产入口。故效果/响应丢失与连续重启矩阵仍存在永久非终态或已提交未生效路径。证据：candidate/per-transfer journal、DR CLI/assembly、exposure 调用 exact-set。结论：错误关联边界成立，并发与重放闭包未完成，待统一归并到既有根因。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-31 | [~] | lifecycle、启动、停机与连续恢复 | cold startup 对 trust、candidate/per-transfer、installation/generation、consumer 与 exposure 的恢复顺序完整，坏尾/缺件/缺 key 均 fail-closed；但 IR35-17 缺少 running target 的 live installation handoff，IR35-22 的公开 DR 命令不持 lifecycle signal且 stop 无法取消/等待在途 I/O，IR35-15 的 claim-only 状态也无法由启动恢复成 authenticated terminal。故 live、stop 与连续重启仍有不可重驱义务，不能以进程退出或下次冷启动冒充完成。证据：bootstrap/assembly、DR command/target signal 形参与 candidate journal。结论：启动主序成立，完整 lifecycle 合同未闭合，待统一归并。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-32 | [~] | 状态机枚举行与必要故障证据 | strict DR 五成功态/rejected、root lifecycle reducer 与 exposure 三状态均有基础转移证据，现有测试也穿过真实 log/store/staging 的主要正常与篡改路径；但已确认反例没有被必要故障证据拒绝：local-only no-rollback、合成 readiness、claim-only abort、running-target post-install、无生产 rotation、无 lifecycle cancel及 distinct co-signer 入口均可由当前生产图直接到达。故 §6.3/§6.4 与安全/耐久矩阵尚不能闭合。证据：IR35-07/13/15/17/21/22/27 的生产反例及对应测试空缺。结论：必要证据不足是既有根因的验收缺口，不另立表象问题。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-33 | [~] | 产品体验与范围价值 | 公开候选、TTY 无回显、错误映射、旧设备隔离确认及无内部术语文案符合目标；但当前核心旅程并不完整：运行中的目标 commit 后会回执成功却尚未接管，用户按提示轮换第三方凭据后没有生产路径恢复 binding，恢复包丢失时合法第二设备无法生成 approval，且恢复开始后没有安全取消/stop。上述均是本单元明确支持场景的可达停点或误导性成功，不是范围外增强。证据：IR35-17/21/22/27 与公开 CLI 调用图。结论：核心产品体验未闭合，待统一归并到既有根因。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-34 | [~] | S7、registry、descriptor 与生产 exact-set | 现有 S7 已冻结 disaster owner/四 phase、root lifecycle 三操作、pairing reenroll、credential read guard、cold-bootstrap completion、CLI 命令及 canonical registry，并对结构变异 fail-closed；但它只计数两个 standalone `DisasterRecoveryTarget` 构造和 exposure guard，没有反绑 active-peer baseline producer、真实 readiness producer、live runtime handoff、`publishRotation()` 生产调用、DR lifecycle signal或 distinct co-signer context，因而当前全部已确认生产绕过仍可通过 gate。证据：`s7-entry-coverage.mjs:1174-1289` 与生产调用 exact-set。结论：既有 runner 可复用，但 Unit 35 必要生产 exact-set/gate 不完整，待并入对应根因的验收方案。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-35 | [~] | 分层、上游兼容与供应链 | core 只承载 strict contracts/reducer，mesh 承载 trust/crypto/checkpoint/native I/O，providers 仅消费 credential guard，CLI 负责组合，server 只维护 canonical golden；未新增反向包依赖、package manifest/lockfile 变更、密码依赖或 PAKE 生产引用。Unit 33 full checkpoint/retention 与 Unit 34 planned/current-owner 仍由原接口复用，已发现问题均位于 Unit 35 组合闭包而非上游语义退化。证据：基线 package/lock diff 为空、生产 import 扫描、路径分层表。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-36 | [~] | 成比例的直接验收闭包 | strict codec/reducer、inventory/unseal/private import/atomic install、cold-start 两 profile、credential guard、root reducer与既有 S7 变异均有直接证据；但没有穿过生产入口证明 reachable-peer no-rollback、真实 readiness、claim-only signed abort、running-target live handoff、credential rotation completion、DR stop/cancel与合法 distinct co-signer。构建或现有单测通过不能反证这些源码可达失败。证据：直接测试/生产入口双向命中表与 IR35-07/13/15/17/21/22/27。结论：验收闭包未达到可提交状态，待各根因方案补齐最小直接证据。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-37 | [~] | 后继能力与非目标边界 | 65 条交付路径只实现手动 source-less authority 恢复、恢复根/凭据安全闭环及直接 gate/test；未出现自动 failover、quorum/witness、continuous sync、恢复应用、多目标/云、Unit 36～38 服务/卸载/发布、通用 transfer/registry/lifecycle/事务/outbox/事件总线或观测设施。单设备及 issuer+恢复包双失仍 fail-closed并要求重建 home。证据：交付路径、production entry/import 扫描与明确排除双向对账。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |
| IR35-38 | [~] | 来源、D35义务与交付路径反向闭包 | 四份权威文档全部章节、规格规范枚举行与 D35-01～D35-09 均已双向归入 IR35-01～IR35-37；基线 diff 实测 69 条，其中 Unit 34 收口记录 2 条、审查与修复状态 2 条已明确排除，剩余 65 条 Unit 35 路径与表中 core 8、mesh 11、CLI 38、providers 1、server 1、S7 2、架构 2、当前单元工作台 2 完全相符且各出现一次。未发现未判定来源、重复路径、架构空洞或范围漂移。证据：来源表、路径表与 `git diff --name-only 972f363e` 反向对账。<br>**修复后失效说明：**U35-01～U35-06 的实现、共享合同、生产装配、S7 或交付路径变化命中本项登记输入；旧证据不代表当前结论，待下一轮独立审查重新判定。 |

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
