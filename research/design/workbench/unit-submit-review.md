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
目标：只收敛第 34 单元正式问题列表中同根重开的 U34-04 一个 P0/大和 U34-09 一个 P1/中，使两项真正命中 target installed-authority generation 未统一重绑 runtime projection/cursor/anchorEpoch，以及 source 已 prepared、target 仍 claim-only 时 signed abort 无耐久终态的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U34-01～U34-03、U34-05～U34-08 与 EX34-01 的既有结论直接复用，已闭合的conversation generation重发现、source delivery quiesce、candidate terminal/prepared事务、重启后迟到release、current-owner入口exact-set及价值裁决收窄不得恢复或扩面，第35～38单元source-less/disaster recovery、恢复应用、全局同步与通用生命周期能力不得提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第34单元正式文件中的 U34-04、U34-09、EX34-01，只依据两项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U34-04 → U34-09` 从权威架构、规格和当前生产调用图重建事实链，核准 planned installation、composite AuthorityCommitLog、runtime anchorEpoch、DeliveryAuthority projection/cursor、scheduler/global/control/conversation/delivery generation owner，以及source candidate/transfer journal、target-wide claim/ReadyProof/key/per-transfer phase与signed abort的唯一事实源、稳定身份、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中共同根因还是局部表象。同根内容必须合并，独立根因不得互相遮蔽；历史修复和价值裁决未被新生产事实触发时不得恢复旧方案或扩面。
2. 穷尽直接变体：U34-04覆盖两生产根、live/startup、install前cursor未建立/已推进、六类pending空/单/多、首次及再次迁居、`nextAnchorEpoch>1`、WAL替换/consumer效果前后失败、响应丢失、旧epoch写入和连续重启；逐一枚举所有固定捕获epoch或缓存log projection/cursor的生产owner exact-set。U34-09覆盖source claim/ready/prepared与target claim/key/prepared的全部可达双端组合，尤其source prepared已耐久而remote prepare未生效，叠加cancel、signed abort、同/异identity、效果/响应丢失、commit竞争和连续重启。每格必须指出稳定identity、耐久事实、唯一线性化点、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：U34-04只复用当前planned installation投影与既有authority-runtime构造/恢复边界，冻结generation-capturing owner exact-set，让验真的`nextAnchorEpoch`/trust generation在公开准入前统一重建或重置其epoch、projection与cursor，并要求post-install read-back证明六类obligation已归current generation；不得逐consumer打补丁或新增通用generation registry/lifecycle。U34-09只复用现有target-wide claim journal、per-transfer journal与signed abort，在完整identity guard后让无phase/install的claim-only状态先耐久aborted再清key/staging/reservation，已有phase继续走原reducer；不得回退unsigned release或改变本端decision先于远端效果的顺序。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二事实源、通用锁/registry/lifecycle、迁移/同步/路由/存储/事务/outbox/事件总线、新lint/test runner、监控、诊断、benchmark或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 两项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：installed authority与runtime projection/cursor换代、anchorEpoch生产exact-set与两根启动/再次迁居、双端phase与claim-only signed abort连续恢复、生产证据/产品体验/范围价值及EX34-01边界。各路必须抛开前轮结论，从当前合同和源码主动构造第2步反例，并核查`U34-04↔U34-09`以及两项与U34-01～U34-03、U34-05～U34-08、EX34-01、第35～38单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U34-04、U34-09的全部受支持installed generation、cursor/epoch owner、双端prepared/claim-only abort、故障/响应丢失/连续重启终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会继续以逐consumer或逐切点补丁造成同根返工。满足后明确回复“U34-04、U34-09 的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 34 单元同根重开的 U34-04 一个 P0/大和 U34-09 一个 P1/中，闭合 target installed-authority generation 对 runtime projection/cursor/anchorEpoch 的统一重绑，以及 source 已 prepared、target 仍 claim-only 时 signed abort 的耐久终态及全部同根直接变体；不得扩展到其他问题或全单元流程。U34-01～U34-03、U34-05～U34-08 与 EX34-01 的既有结论直接复用，已闭合的 conversation generation 重发现、source delivery quiesce、candidate terminal/prepared 事务、重启后迟到 release、current-owner 入口 exact-set 及价值裁决收窄不得恢复或扩面，第 35～38 单元 source-less/disaster recovery、恢复应用、全局同步与通用生命周期能力不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 34 单元正式文件中的 U34-04、U34-09、EX34-01，只依据两项问题最新的根因、价值裁决、F34-23～F34-30 固定矩阵、C34-C35～C34-C44 反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F34-23～F34-30 固定矩阵。U34-04 覆盖 anchor+executor/anchor-only 两个 current-anchor profile、live/startup、installation 存在而 private progress 已清、cursor 未建/已推进、WAL replacement、固定 substrate 与 late consumer exact-set、六类 pending 空/单/多、首次及再次迁居、`nextAnchorEpoch>1`、旧 epoch 写入、效果/响应丢失和连续重启；U34-09 覆盖 source claim/ready/prepared/terminal 与 target 无 claim、claim、ready+key+reservation、prepared decision、per-transfer phase、aborted/committed 的可达组合，prepare/abort并发、proof过期、key已清/错绑、commit竞争、效果/响应丢失和连续重启。逐格绑定 installed generation/candidate/phase identity、唯一耐久事实、线性化点、零副作用边界、消费终态和直接证据，并持续核对其余U34、EX34-01与第35～38单元边界。
2. 按 `U34-04 → U34-09` 一次完成。先从当前 `transfer:anchor-current` installation、signed commit/trust record和安装后log checkpoint派生不可变 `InstalledAuthorityGeneration`，与可清除的 `plannedAnchorPostInstall` progress分开；`MeshRuntimeBootstrap` 在两个current-anchor profile每次启动都把它交给 `setupAuthorityRuntime`，有installation时默认epoch不可达。初启与live `onInstalled` 共用一个planned-only、无动态注册API的显式generation coordinator：在既有planned/current-owner gate内等待串行安全点，对 immutable epoch owner按现有构造边界重建，对cursor/cache owner执行窄reset/rebind，固定substrate exact-set为 runtime epoch、DeliveryAuthority、ControlAdmission、AnchorResourceGovernor、surface assets及workscene/memory/skill/rubric global adapters；随后重建scheduler及其JobJournal/intent/global lazy children并复用conversation、delivery、post-adoption/current-owner恢复。所有named participant须回报同一generation，六类obligation逐项read-back后才cleanup/open/respond；失败保留installation、gate与未完成回执供live/startup重驱，禁止把flush、单consumer reset或进程重启冒充完成。

   再把 target-wide candidate journal收紧为 remote prepare与signed abort的唯一耐久排序点：prepared decision保存完整已验证 `anchor-prepared` 可重放对象，aborted decision保存完整 signed `AnchorTransferAbort`，二者在同一candidate transaction互斥。abort先验外层command与内层abort签名并全等反绑request/transfer/source/target/sourceEpoch、candidate home/trust与stored ReadyProof；该检查只验历史identity，不重跑expiry/current revision readiness。key仍存在时须与stored proof全等，已清视为幂等效果。abort先赢则先耐久terminal再清key/staging/reservation且late prepare零append；prepared先赢但phase未物化则先从原payload补写prepared再走既有reducer；已有phase继续原reducer。startup/replay同时扫描candidate terminal与per-transfer journal，claim-only exact replay直接返回原signed abort。同步直接相关架构、规格、S7与测试；同根残留并入原问题，禁止新增第二事实源、通用锁/registry/generation lifecycle、迁移/同步/路由/存储/事务/outbox/事件总线、新lint/test runner、监控、诊断、benchmark或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、installed-generation/bootstrap/runtime rebind、source/target claim/prepare/abort、六类obligation与两current-anchor profile直接合同/场景测试，现有S7 lint及必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过真实 `AuthorityCommitLog`、外部projection/cursor、target-wide candidate journal、per-transfer journal、SecretStore/private staging与AuthorityCatalog，直接注入预推进cursor、epoch 1→2→3、各participant/consumer切点、非空六类pending、source prepared/target claim-only、prepare/abort竞争、过期proof、已清/错绑key、响应丢失和连续重启；不得以mock自报generation/terminal或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与两项验收无关的验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读地逐格重建 U34-04、U34-09 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：installed authority与runtime projection/cursor换代、anchorEpoch生产exact-set与两根启动/再次迁居、双端phase与claim-only signed abort连续恢复、生产证据/产品体验/范围价值及EX34-01边界。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查 `U34-04↔U34-09` 以及两项与U34-01～U34-03、U34-05～U34-08、EX34-01、第35～38单元边界的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第 2 步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U34-04、U34-09 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C34-C35～C34-C44及新增同根反证全部有耐久处置，证明installed generation在private progress清除后仍由两current-anchor profile每次启动取得，live/startup及再次迁居中全部fixed epoch owner、外部projection/cursor、late consumer和六类obligation只归当前代际，旧cursor/旧epoch零写入且失败时gate不开放；source prepared/target claim-only与prepared decision竞态只产生一个authenticated terminal，signed abort在proof过期、key已清、响应丢失和连续重启下先耐久后cleanup，同载荷exact replay且错误identity零副作用。其余U34结论与EX34-01排除仍成立，第35～38单元能力未提前实施，两项均已更新为“已验证”。满足后明确报告“U34-04、U34-09 两项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 35 单元 · generation 1
- **单元身份**：S9 人工灾难恢复与安全域换代；只支持值班设备永久丢失后，由另一台 active anchor-role 设备基于用户明确选择的完整 checkpoint 副本和无回显恢复包，执行 source-less 恢复、旧安全域撤销、恢复根生命周期与逐设备重新加入。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D35-01～D35-09。上游只消费第 33 单元完整可恢复 checkpoint、恢复根激活与 retention 合同，以及第 34 单元 composite authority、installed-generation/current-owner、target-wide candidate、私有 staging、storage governor 和 post-install closure；下游第 36～38 单元能力不进入本清单。
- **交付基线**：以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 完整交付为 54 个变更路径：core 8、mesh 9、CLI 29、providers 1、server golden 1、S7 2、架构 2、工作台 2。同期变更的 Unit 34 历史归档与正式封版账本属于上一单元收口记录，不计入 Unit 35 功能交付；两者仍在下方路径对账中明确排除，不能无依据消失。审查必须覆盖完整生产调用图与 54 条 Unit 35 路径，不得仅审新增文件或默认命令路径。
- **生产装配关系**：`zz backup recover/recover-finish` 与 `zz backup root rotate/invalidate/approve-reset/reset` 是用户入口；checkpoint directory/paired inventory 提供候选，strict disaster command、target-wide candidate journal、per-transfer journal、私有 `FileArtifactStore` 与本地 `AuthorityCommitLog` 形成目标恢复链；`MeshRuntimeBootstrap` 与 `MeshRuntimeAssembly` 在 anchor+executor、anchor-only 两个 current-anchor profile 中消费 disaster installation，先完成 installed-generation/runtime/consumer 重绑再开放 current-owner surface。Credential exposure authority 同时接入 capability publication、provider/channel/MCP/webhook/rendezvous 秘密读取与 pairing/bootstrap 路由。
- **目标提交边界**：交付 source-less checkpoint inventory、恢复根真解封与现场验证、no-rollback baseline、私有完整导入、root-signed commit/abort、原子 composite authority 安装、旧 issuer/epoch/route/binding fencing、旧设备隔离后 tombstone、恢复根 rotate/invalidate/domain-reset-establish、pending-reenroll/fresh pairing、公开零术语旅程、两生产根 exact-set/S7 与必要直接证据。
- **明确排除**：自动 failover、quorum/witness、自动升主、持续或全局同步、恢复应用、业务数据恢复向导、多目标/云备份、通用 transfer/registry/lifecycle/事务/outbox/事件总线；第 36 单元托管服务与角色自恢复、第 37 单元停机/移除/卸载、第 38 单元升级发布；单设备原地重置、issuer 与恢复包同时丢失后的绕过；监控、诊断、benchmark 与信息采集。
- **架构空洞判定**：总纲 §9、规格 §6.3/§6.4/§7/§8/§15 与 D35-01～D35-09 已唯一确定本单元产品、状态、安全、拓扑和交付边界；当前没有需以实现假设补齐的真实需求空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：38 项 `[ ]`、0 项 `[x]`、0 项 `[!]`、0 项 `[~]`；清单已定稿、尚未执行独立审查。两类问题列表为空仅表示尚未审查，不表示单元已通过。

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
| 当前完整交付物 54 路径 | 适用（反向闭包） | core 8、mesh 9、CLI 29、providers 1、server golden 1、S7 2、架构 2、工作台 2 均须归入 IR35-01～IR35-37；路径新增、遗漏、重复或越界由 IR35-38 单独判定。 |

### 交付路径反向覆盖

| 路径组 | 数量 | 当前路径（每条只出现一次） | 归入审查项 |
| ------ | ---- | -------------------------- | ------------ |
| CLI 公开入口与用户旅程 | 6 | `packages/cli/src/index.ts`、`packages/cli/src/serve/backup-command.ts`、`packages/cli/src/serve/backup-command.test.ts`、`packages/cli/src/serve/recovery-public-errors.test.ts`、`packages/cli/src/setup-delivery.ts`、`packages/cli/src/__tests__/setup-delivery.test.ts` | IR35-02、IR35-16、IR35-23、IR35-25～IR35-28、IR35-30、IR35-33～IR35-36 |
| CLI disaster authority、candidate、inventory 与 target | 8 | `packages/cli/src/serve/disaster-recovery-authority.ts`、`packages/cli/src/serve/disaster-recovery-candidate.ts`、`packages/cli/src/serve/disaster-recovery-command.ts`、`packages/cli/src/serve/disaster-recovery-installation.ts`、`packages/cli/src/serve/disaster-recovery-inventory.ts`、`packages/cli/src/serve/disaster-recovery-inventory.test.ts`、`packages/cli/src/serve/disaster-recovery-target.ts`、`packages/cli/src/serve/disaster-recovery-target.test.ts` | IR35-03～IR35-16、IR35-22、IR35-24、IR35-29～IR35-32、IR35-35～IR35-36 |
| CLI trust、pairing 与 root lifecycle | 8 | `packages/cli/src/serve/mesh-bootstrap-store.ts`、`packages/cli/src/serve/mesh-control-plane.ts`、`packages/cli/src/serve/mesh-pair-command.ts`、`packages/cli/src/serve/mesh-pair-command.test.ts`、`packages/cli/src/serve/paired-checkpoint-runtime.ts`、`packages/cli/src/serve/recovery-root-activation.ts`、`packages/cli/src/serve/recovery-root-establishment-runtime.ts`、`packages/cli/src/serve/recovery-root-lifecycle.ts` | IR35-06～IR35-07、IR35-15、IR35-18、IR35-24～IR35-31、IR35-34～IR35-36 |
| CLI runtime、installed generation 与 exposure 装配 | 7 | `packages/cli/src/serve/credential-exposure-authority.ts`、`packages/cli/src/serve/credential-exposure-authority.test.ts`、`packages/cli/src/serve/mesh-runtime-assembly.ts`、`packages/cli/src/serve/mesh-runtime-bootstrap.ts`、`packages/cli/src/serve/planned-anchor-transfer.ts`、`packages/cli/src/serve/target-wide-anchor-candidate.ts`、`packages/cli/src/startup.ts` | IR35-05、IR35-14、IR35-17～IR35-22、IR35-24、IR35-29～IR35-31、IR35-34～IR35-36 |
| core authority、严格合同与 reducer | 8 | `packages/core/src/authority/commit-log.ts`、`packages/core/src/authority/index.ts`、`packages/core/src/contracts/identity.ts`、`packages/core/src/contracts/records.ts`、`packages/core/src/contracts/schema.ts`、`packages/core/src/protocol/anchor-transfer.ts`、`packages/core/src/protocol/anchor-transfer.test.ts`、`packages/core/src/protocol/index.ts` | IR35-04、IR35-07～IR35-16、IR35-19、IR35-30、IR35-32、IR35-35～IR35-36 |
| mesh 冻结物理根与 child bridge | 3 | `packages/mesh/native/checkpoint_child_bridge.cc`、`packages/mesh/native/checkpoint_child_bridge.cs`、`packages/mesh/src/checkpoint-child-bridge.ts` | IR35-03、IR35-10～IR35-11、IR35-22、IR35-29、IR35-31、IR35-35～IR35-36 |
| mesh checkpoint capture、inventory 与 paired target | 4 | `packages/mesh/src/__tests__/full-authority-checkpoint.test.ts`、`packages/mesh/src/checkpoint-target.ts`、`packages/mesh/src/checkpoint.ts`、`packages/mesh/src/paired-checkpoint-target.ts` | IR35-03、IR35-06、IR35-08、IR35-10～IR35-11、IR35-22、IR35-29～IR35-31、IR35-35～IR35-36 |
| mesh trust 与 credential exposure | 2 | `packages/mesh/src/credential-exposure.ts`、`packages/mesh/src/trust-chain.ts` | IR35-07、IR35-19～IR35-21、IR35-25～IR35-30、IR35-35～IR35-36 |
| provider credential 读取守卫 | 1 | `packages/providers/src/credentials-loader.ts` | IR35-20～IR35-21、IR35-29、IR35-35 |
| server canonical registry golden | 1 | `packages/server/src/__tests__/__goldens__/canonical-registry.golden.json` | IR35-23、IR35-33～IR35-34、IR35-36 |
| 既有 S7 descriptor/validator 与变异证据 | 2 | `scripts/s7-entry-coverage.mjs`、`scripts/s7-entry-coverage.test.mjs` | IR35-24、IR35-29～IR35-30、IR35-34～IR35-36 |
| 权威架构与可执行规格 | 2 | `research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md` | 由上方逐章来源表归入 IR35-01～IR35-38 |
| 当前单元工作台 | 2 | `research/design/workbench/unit-development-workbench.md`、`research/design/workbench/unit-submit-review.md` | 前者归入 IR35-01、IR35-37～IR35-38；后者只承载本清单与 IR35-38 的路径闭包，不作为运行时事实证据 |
| 上一单元收口记录（明确排除） | 2 | `research/design/workbench/unit-review-checklists/distributed-runtime/unit-34.gen-1.md`、`research/design/workbench/unit-review-ledgers/unit-34.gen-1.md` | 已分别归档 Unit 34 清单与记录 Unit 34 封版事实；不属于 Unit 35 功能、测试或验收义务，不计入上方 54 条，只有文件身份或内容越界进入 Unit 35 时才重开范围判定 |

### 审查项

| 编号 | 状态 | 审查主题 | 独立判定对象、停止条件与证据 |
| ---- | ---- | -------- | ---------------------------- |
| IR35-01 | [ ] | 单元身份、架构与范围 | 以总纲 §9 为最高依据，对账 Unit 35、D35-01～D35-09、规格第 35 项及明确排除；全部当前交付路径可反绑本单元必要性，未提前实现 Unit 36～38 或通用未来框架，且无需求空洞时通过。证据：来源条款、开发清单、路径分类。 |
| IR35-02 | [ ] | 恢复包与公开入口前置 | `backup recover/recover-finish` 及 root 四命令只在明确用户动作后运行；恢复包仅经共享无回显 TTY reader 读取，不入 argv/log/wire/错误；非 TTY、取消、空输入、错包、v1/v2 和重放均有明确终态时通过。证据：CLI registry、command、TTY/codec 测试。 |
| IR35-03 | [ ] | source-less inventory 与候选选择 | directory/paired 只枚举 durable、完整、full-authority checkpoint；冻结 location/time/order/action 与内部 checkpoint/target identity，唯一候选可确定选择、多候选须显式序号、空/损坏/越界/重复不被选中且公开不泄 raw id 时通过。证据：native handle inventory、target adapters、public projector/测试。 |
| IR35-04 | [ ] | strict DR command/result 与状态联合 | `prepare/import/commit/abort/tombstone/status`、`prepared/imported/committed/tombstoned/aborted/rejected` exact keys、schema/version、签名者、originating request/transfer 关联完整；planned/conversation/DR 不可混型，非法输入在任何副作用前拒绝时通过。证据：core types/codec/reducer/逐字段污染。 |
| IR35-05 | [ ] | target-wide candidate 单飞 | 同 home 同时只存在一个有效 planned 或 disaster candidate；DR claim 在 key、reservation、private root、journal 之前耐久，same identity exact replay，异 transfer/mode/identity 稳定冲突；取消/终态/响应丢失/重启释放不产生双 candidate 时通过。证据：target-wide journal、DR candidate journal、真实并发/重放。 |
| IR35-06 | [ ] | 恢复根真解封与现场验证 | 只有与冻结 recipient/root/checkpoint 全等的恢复根可逐块解封；manifest、scope、nonce、chunk、payload、issuer 签名和 RecoveryCheckpointVerification 全验，伪造/错 key/nonce/digest/target/verification、截断/重排均零 authority/trust 副作用时通过。证据：checkpoint crypto/sink、strict validators、篡改场景。 |
| IR35-07 | [ ] | authority/trust 前缀重放与 no-rollback baseline | 原 envelope bytes/LSN/digest 严格解码重放；本地及可达 active peer 的已签事实按唯一规则选择不回滚 baseline，chain/home/issuer/epoch/source-head 冲突或歧义 fail-closed，离线 peer 不得伪造更旧基线时通过。证据：baseline selector、commit-log decoder、trust replay/peer 场景。 |
| IR35-08 | [ ] | 六类 checkpoint 覆盖与禁止内容 | §7 六类逐行对账：全局、会话、会话资产、执行资产全量恢复；环境事实、本地秘密、设备缓存、非权威缓存不可表示；checkpoint recursion/缺 ref/多 ref/retention 漂移均拒绝发布 import 时通过。证据：payload/catalog/ArtifactLifecycleIndex/closure exact-set。 |
| IR35-09 | [ ] | 无秘密 AuthorityCatalog 与 pending exact-set | catalog 六类 coverage、records、retained refs、pending obligations、trust/current anchor 与冻结 baseline 全等且规范排序；少列/多列/乱序/重复/错 digest 失败，catalog 不含 secret/path/cache 时通过。证据：catalog builder/validator、真实 log/index。 |
| IR35-10 | [ ] | transfer 私有完整导入 | 每 transfer 独立 root/journal/FileArtifactStore 接收 record pages 与 retained artifacts，内容/size/digest/coverage 全验前对共享 CAS 和 authority consumer 零可见；部分写、磁盘满、重复 chunk、断连/重启可重驱时通过。证据：private sink/store/journal、故障注入。 |
| IR35-11 | [ ] | 共享 CAS 提升与 cleanup 边界 | 仅全验后的私有对象幂等提升；已有/新/共享 digest 均不误删、不覆盖；abort/tombstone/cleanup 只触及 transfer-owned 私有对象，业务共享 ref 与上游 retention owner 保持有效时通过。证据：ArtifactStore 引用、private/public root、cleanup 场景。 |
| IR35-12 | [ ] | immutable/composite authority base | source prefix 的原 bytes/LSN/digest 形成不可见 immutable base，target tail/install 不混入旧本地 authority；pointer 可见后所有 snapshot/tail/stream/projection 读取同一 composite base，pointer 前零 consumer 可见时通过。证据：base writer/reader、AuthorityCommitLog、安装前后读面。 |
| IR35-13 | [ ] | DR commit 身份与签名 | commit 仅由当前恢复根签发，逐字段绑定 transfer、checkpoint envelope、catalog、ReadyProof、issuer transition、target、next epochs 和 issuer public key；旧根、错 target/digest/proof/transition/epoch 均零提交时通过。证据：codec/verifier/reducer、签名篡改矩阵。 |
| IR35-14 | [ ] | 单 envelope 原子安全域发布 | target 同一 `AuthorityCommitLog` envelope/单次 sync 原子发布 committed base pointer、commit、trust/current owner、next epochs、old issuer revoke、active exposure compromised 与 installed generation；sync 前全无、sync 后全有，post-sync 决定性 I/O 为零时通过。证据：commit envelope 内容、崩溃点、重放。 |
| IR35-15 | [ ] | 双端 phase、abort 与 forward-only | 规格 §6.3 DR 行 0b/2/3b/5b/6/7/8 各有唯一终态；root-signed abort 先耐久再 cleanup，commit 后 late abort 永拒；效果前后失败、响应丢失、同/异载荷、连续重启只收敛到一个 authenticated terminal 时通过。证据：candidate/per-transfer reducer、strict result、逐边场景。 |
| IR35-16 | [ ] | 旧设备隔离确认与 tombstone | commit 只建立新权威并永久 fence 旧 issuer/epoch；只有用户明确确认旧设备已隔离/擦除后才 tombstone，未确认、重复、错 transfer/commit 或迟到请求零 tombstone，tombstone 不回滚新 authority 时通过。证据：recover-finish、tombstone guard、terminal replay。 |
| IR35-17 | [ ] | installed-generation 与 post-install 消费闭包 | startup/live 从 durable disaster installation 派生不可清除 generation，在 gate 内重绑 `runtime-epoch`、`delivery-authority`、`control-admission`、`resource-governor`、`surface-assets`、workscene/memory/skill/rubric global-state 九个固定 participant；再恢复 scheduler+intent+assignment、conversation+interaction+confirmation+final、delivery 三组及六类 pending。九个 participant 回执与逐 obligation read-back 均归当前代际后才 cleanup/open/respond 时通过。证据：bootstrap/assembly/coordinator、两 profile、九项 receipt 与非空 pending。 |
| IR35-18 | [ ] | current-owner 路由与旧代际 fencing | canonical registry/S7 冻结的 session、global、task、channel、confirmation、notification、management 七组入口，以及 registry 外的直接 log append 与 credential route 两个写面，均在副作用前解析 signed current owner；旧 source/issuer/epoch/route 永拒，target 离线不回退旧 source，未知/设备本地/local-domain 方法不误代理时通过。证据：canonical registry、resolver/router、九组入口的三设备/两 profile 路由表。 |
| IR35-19 | [ ] | exposure compromised 原子投影 | recovery commit 只把旧设备当前 active exposures 标为 compromised，latest projection 无歧义、无时间/revision 回退；设备/服务/binding/principal/tenant/scopes 身份不串线，撤销清单可行动且不暴露秘密时通过。证据：exposure authority/projection、commit envelope、设备撤销场景。 |
| IR35-20 | [ ] | 每条秘密读取路径的 binding guard | provider、channel、MCP、webhook、rendezvous 五类在 SecretRef 解引用或外调前共用 latest exposure guard；compromised 仅阻断命中 binding，其他 binding 与普通业务继续，device-key 明确排除且无旁路构造点时通过。证据：credentials loader、startup、mesh control/pairing、route descriptor/S7。 |
| IR35-21 | [ ] | 第三方凭据轮换闭环 | 只有 service-verified principal、严格前进 binding revision、SecretStore 写后回读和 readiness 全过，才以一个 authority envelope 同时写新设备 active 与旧 exposure rotated；效果/响应丢失 exact replay，错服务/identity/revision/secret 零恢复路由时通过。证据：CredentialExposureAuthority、capability publication、rotation 测试。 |
| IR35-22 | [ ] | 资源、物理 I/O、取消与 stop | inventory、unseal、private import、CAS、directory/paired range、cleanup 每个物理步骤经同一设备 storage governor/lifecycle abort；固定 chunk/header 上界，网络等待零 permit，容量等待不持 authority/store 锁，stop 后零新 I/O、未终态由耐久事实恢复时通过。证据：governor 注入 exact-set、native bridge、取消/容量/磁盘/网络场景。 |
| IR35-23 | [ ] | 用户恢复旅程与公开 DTO | CLI/server 只展示位置、备份时间、序号、待验证/可行动状态和“值班设备”；不展示 root key、raw device/checkpoint/target/transfer id、digest、epoch、路径或 raw error；恢复完成后诚实提示旧设备隔离与逐项轮换时通过。证据：命令输出、public error mapper、golden。 |
| IR35-24 | [ ] | topology 与 owner/receiver exact-set | 仅 eligible active anchor-role target 可持 disaster owner；directory/paired target 只提供 checkpoint-owned inventory/副本；anchor+executor、anchor-only 各恰一路径，executor-only、surface、disabled、旧 source、非 anchor、未选候选零 DR owner/listener/非终态状态时通过。证据：组合根、role transitions、descriptor/S7。 |
| IR35-25 | [ ] | 恢复根 rotate 原子计划 | rotate 由 current issuer/当前根授权，经新恢复包无回显回读、独立 checkpoint created→replicated→verified 后，同 envelope 激活新 root 并 supersede 旧 checkpoint；任一前置失败保持旧根有效，响应丢失按 checkpointId 重放时通过。证据：lifecycle service、activation coordinator、崩溃点。 |
| IR35-26 | [ ] | 恢复根 invalidate | 只有 current issuer 与当前 root、明确用户确认可停用；同 envelope 写合法 invalidate，随后 root/readiness/mesh 能力如实降级；错包/旧根/重复/响应丢失不产生分叉或提前开启替代能力时通过。证据：trust event/reducer、command/状态投影。 |
| IR35-27 | [ ] | domain-reset + establish 原子计划 | 恢复包丢失只接受 current issuer 与另一台 distinct active device 的签名 approval；reset 与新 establish 连续、同 checkpoint activation plan、同 envelope 原子生效，单事件提前落链、同设备共签、旧 chain approval、错 epoch/record 均拒绝时通过。证据：DomainResetApproval、trust verifier、root activation。 |
| IR35-28 | [ ] | pending-reenroll 与 fresh pairing | domain-reset 后除 issuer 外设备全部投影 pending-reenroll、连接终止、旧会话/凭证/路由不恢复；仅 fresh pairing transcript 可生成 reenroll 回 paired，再经既有 configured→ready；单设备或 issuer+恢复包双失只返回 rebuild-home，不存在原地绕过时通过。证据：trust reducer、pairing event、两设备/单设备场景。 |
| IR35-29 | [ ] | 安全、最小权限与数据隔离 | 恢复包、wire/log/catalog/error/ArtifactRef 仅含必要稳定字段；恢复主秘密、issuer/第三方秘密、环境、路径、缓存、raw store/log 不逸出；签名、principal、role、epoch、identity、ref、path/容量 guard 均先于首个副作用，拒绝零写时通过。证据：wire 扫描、SecretRef、negative tests。 |
| IR35-30 | [ ] | 并发、重放、错误关联与 fail-closed | prepare/import/commit/abort/tombstone/status/inventory/root lifecycle 的并发、错 request/transfer/checkpoint/target/root/event/record/digest/epoch、效果/响应丢失均二元落定；exact replay 返回原结果，异载荷稳定冲突，损坏/歧义 fail-closed且不泄内部错误时通过。证据：严格 codec/reducer/journal、对抗矩阵。 |
| IR35-31 | [ ] | lifecycle、启动、停机与连续恢复 | 启动在公开准入前恢复 candidate/per-transfer/install/generation/consumer/exposure/root lifecycle；stop 拒新工作、取消并等待在途安全点、释放 permit/handle/listener；坏尾、缺 artifact/key、offline target/peer、连续重启保留唯一可重驱义务，不伪造成功时通过。证据：startup/assembly/lifecycle、崩溃注入。 |
| IR35-32 | [ ] | 状态机枚举行与必要故障证据 | §6.3 DR 七条适用边、§6.4 十一行、root lifecycle 三操作、exposure 三状态、DR 五成功态+rejected 均有直接转移或拒绝证据；整个有限矩阵覆盖适用的正常、边界、故障、恢复与对抗路径，不要求为每一行机械建立五类场景笛卡尔积。核心安全与耐久结论须直接穿过真实 log/store/staging/trust/SecretStore/governor，不以 mock 自报事实时通过。证据：逐行场景表、共享反例映射与命中证明。 |
| IR35-33 | [ ] | 产品体验与范围价值 | 完整用户恢复演练无需理解 anchor/epoch/CAS/stream 等术语；每个停顿都有可行动下一步，取消/不可回滚/旧设备隔离/换密钥/双重灾难诚实；范围外增强未成为提交门禁时通过。证据：TTY/非TTY/CLI/server golden 与明确排除对账。 |
| IR35-34 | [ ] | S7、registry、descriptor 与生产 exact-set | 既有 S7 单源反绑 disaster owner/phase/order、root lifecycle、pairing reenroll、credential route、bootstrap-before-open、CLI 命令与 canonical registry；新增/删除/重复/换序/绕过变异失败，合法两生产根零误杀，不新建 runner 时通过。证据：descriptor、validator、mutation tests、server golden。 |
| IR35-35 | [ ] | 分层、上游兼容与供应链 | core strict合同、mesh crypto/trust/native、providers guard、CLI组合根、server golden、S7 依赖方向无环；Unit 33 checkpoint/retention与Unit 34 planned/current-owner语义不退化，`@zhixing/mesh` 受管依赖/PAKE隔离不漂移时通过。证据：exports/imports、兼容场景、供应链门禁。 |
| IR35-36 | [ ] | 成比例的直接验收闭包 | 必须具备 strict codec/reducer、完整 inventory/unseal/private import/atomic install、真实双端/两 profile、credential guard/rotation、root lifecycle/reenroll、崩溃/响应丢失/连续重启及 S7 变异证据；证据可复核且覆盖实际生产入口，不以构建通过代替功能判断时通过。证据：直接测试文件、生产入口命中表与既有 S7 变异表。 |
| IR35-37 | [ ] | 后继能力与非目标边界 | 逐路径确认未实现自动 failover、quorum/witness、continuous sync、恢复应用、多目标/云、Unit36～38服务/卸载/发布、通用 transfer/registry/lifecycle/事务/outbox/事件总线及观测设施；单设备/双失灾难只重建 home 时通过。证据：依赖/入口/路径扫描与明确排除。 |
| IR35-38 | [ ] | 来源、D35义务与交付路径反向闭包 | 四份权威文档全部章节、规格规范枚举行、D35-01～D35-09 和 54 条 Unit 35 路径逐一归入 IR35-01～IR35-37；两条 Unit 34 收口记录有明确排除依据。任何未判定来源/条款/枚举行/功能链/路径、重复条目、不可独立判定项或架构空洞均使本项失败。证据：双向追踪表与逐路径清单。 |

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
