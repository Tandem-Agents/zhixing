# 单元独立审查工作台

> **维护原则**
>
> - 以独占一行的“审查清单”标题为界：此前为静态区，保存长期稳定的规则；该标题及其后为动态区，保存当前开发单元的独立审查内容。
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

## 审查清单定稿条件

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
目标：只收敛第 31 单元正式问题列表中的 U31-01～U31-02 两个 P1，使两项真正命中 conversation identity 与 intent 写入未共用权威线性化点、confirmed schedule 的耐久 pending 未被同进程 exact replay 重驱的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；EX31-01 的既有排除结论直接复用，第 32 单元公开复核错误映射义务不得提前恢复为本单元方案。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 31 单元正式文件中的 U31-01～U31-02、EX31-01，只依据两项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U31-01 → U31-02` 从权威架构、规格和当前生产调用图重建事实链，核准 conversation/intent/schedule 的唯一事实源、稳定身份、线性化点、生产入口、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中根因还是表象。EX31-01 重开条件未被新生产事实触发时不得恢复广义 conformance 矩阵；第 32 单元公开结果合同不得并回当前 internal seam。
2. 穷尽直接变体：U31-01 覆盖 schedule 四分支、rubric save/update、record/discard 与 conversation delete 的两种线性化顺序、既有/未知/已删除会话、fresh/exact/terminal replay、响应丢失和两生产根；U31-02 覆盖四种 schedule mutation、首次确认、terminal exact replay、refresh 效果前/后失败、无重启重试、响应丢失、pending 清理、连续重启和 task revision 零重复。每格必须指出稳定 request/intent/task identity、耐久事实、拒绝副作用、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：U31-01 只复用同一 executor AuthorityCommitLog 的会话目录/删除投影与 intent 投影，按 exact replay→fresh identity guard→append 在同一锁内前缀线性化，不改 ArtifactStore 或新增跨存储事务；U31-02 只复用既有 schedule pending projection/materializer，让首次 confirmed 与 terminal replay 在返回前幂等重驱并核对 pending 已清，失败保留 pending 供同进程或启动恢复，不新增结果联合、队列或通知。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二事实源、通用事务/outbox/事件总线、公开离线入口、conformance runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 两项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：conversation 生命周期与 intent 权威线性化、fresh/exact replay 与响应丢失、schedule authority/pending 物化与崩溃恢复、产品体验/范围价值及 EX31-01/第 32 单元边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 U31-01↔U31-02 在 intent identity、terminal replay 与后续收编输入上的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U31-01～U31-02 的全部受支持 mutation、会话删除竞态、重放、物化失败与恢复终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会因同根残留继续局部返工。满足后明确回复“U31-01～U31-02 的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 31 单元 U31-01～U31-02 两个 P1，闭合 conversation identity 与 intent 写入的权威线性化、confirmed schedule 的同进程 pending 重驱及全部同根直接变体；不得扩展到其他问题或全单元流程。EX31-01 的既有排除结论直接复用，第 32 单元 AuthorityTransfer、current-owner 切换和公开复核错误映射义务不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 31 单元正式文件中的 U31-01～U31-02、EX31-01，只依据两项问题最新的根因、价值裁决、固定矩阵、方案、验收条件、反证账和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建两项固定矩阵。U31-01 覆盖 schedule 四分支、rubric save/update、record/discard 与 conversation delete 的双序竞争、既有/未知/已删除会话、同载荷 exact/异载荷冲突/terminal replay、效果后响应丢失及 anchor+executor、executor-only 两根；U31-02 覆盖四种 schedule mutation、首次 confirmed、并发/terminal replay、refresh 效果前失败与效果后抛错、materialized 响应丢失、较新 pending 覆盖、无重启重试和连续重启。逐格绑定 request/intent/task identity、ConversationRunJournal identity/delete、schedule task revision/pending、唯一线性化点、零副作用边界和直接证据，并持续核对 EX31-01 与第 32 单元边界。
2. 按 `U31-01 → U31-02` 一次完成。先在 `ConversationRunJournal` 与 protocol 间提供仅供 intent repository 的窄事务适配器，local 与 anchor repository 都按 conversationId 注入当前 journal；静态 domain/mode/principal/deadline 校验留在锁外，事务固定读取 `DEFERRED_INTENT_PROJECTION_ID`，锁内按 exact replay→fresh durable identity/未删除/current ownerEpoch guard→append 排序，discard 也在事务中重读并反绑 intent/conversation，ArtifactStore 合同不变。再抽取唯一 schedule-confirmed materialization 路径：稳定 control requestId 继续由 intentId+mutation digest 派生，taskId 复用现有函数，targetRevision 固定为 create=1、其余 `taskRevision+1`；首次 confirmed 和 terminal same-decision replay 返回前都调用现有 `applyDeferredScheduleIntent`，scheduler definition 达到目标后只清除不晚于该目标的 pending，较新 pending 不得被旧 replay 清除，失败保留 pending 供同进程或启动恢复。同步直接相关架构、规格、S7 反绑与测试。同根残留并入原问题，禁止修改 ArtifactStore、扩建跨存储/通用事务、第二事实源、结果联合、队列、通知、公开离线入口、transfer/conformance runner、监控、诊断、benchmark 和信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、repository/journal 竞争测试、anchor review/materializer 故障测试、两生产根直接装配测试、现有 S7 lint 与必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须在同一 AuthorityCommitLog 上直接竞争 intent 与 delete，并在真实 pending/materializer 边界注入效果前/后失败及响应丢失；不得以 mock 自报线性化或只验证返回值，不得运行包全测、模块回归或与两项验收无关的验证。失败先归因，实现问题直接修复并回到第 2 步。
4. 验证通过后冻结当前交付物指纹，整轮只读地逐格重建 U31-01～U31-02 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：conversation 生命周期与 intent 权威线性化、fresh/exact/terminal replay 与响应丢失、schedule authority/pending 物化与崩溃恢复、产品体验/范围价值及 EX31-01/第 32 单元边界。各角色须抛开既有结论，主动重造第 1 步全部适用反例，并核查 U31-01↔U31-02 在 intent identity、terminal replay 与后续收编输入上的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第 2 步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U31-01～U31-02 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；累计同根反证全部有耐久处置，证明 delete 与 fresh intent 写在同一 owner journal/log prefix 唯一排序，删除胜出零 intent append、intent 胜出完整提交，匹配 record/discard replay 在响应丢失及后续删除后仍全等；四种 confirmed schedule 在首次与 terminal replay 均可同进程追平原 target，效果前/后失败、较新 pending、响应丢失和连续重启不重复 task revision，未物化目标绝不返回完成；EX31-01 重开条件仍不成立且第 32 单元义务未提前实施，两项均已更新为“已验证”。满足后明确报告“U31-01～U31-02 两项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 31 单元 · generation 1
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`research/design/drafts/scheduler-architecture.md`、`task-advancement-rubric-architecture.md` 与当前定稿开发清单 D31-01～D31-06；其他模块文档不是本单元架构依据
- **交付基线**：父提交 `6410de0a` → 当前工作树；闭包共 41 个路径，其中 34 个属于第 31 单元生产实现、直接测试、结构门禁与当前合同同步，7 个 `research/design/workbench/` 路径仅承载工作台、归档、台账与验证规则状态，不参与功能通过判定
- **目标提交边界**：第 31 单元（S8）只交付随本地域 conversation owner 的 schedule/rubric `DeferredGlobalIntent` 耐久流、收编前查询/撤销、锚点 internal review 与原子确认归宿；不传输意向、不切换 current owner、不开放公开离线入口
- **明确排除**：第 32 单元 `AuthorityTransfer`、freeze/checkpoint/import/commit/tombstone、current-owner 切换与公开 CLI/RPC/渠道离线旅程；memory/workscene/skill/trust/config/delivery/rubric archive 意向；离线 schedule 读取、部分 patch、run/abort、直接全局写、job/delivery；第 33～38 单元；第二事实源、通用 intent/事务/outbox/事件总线/registry/调用图及监控、诊断、benchmark、信息采集
- **当前任务进度**：100%（33 / 33 项已通过；0 项 [ ]，33 项 [x]，0 项 [!]，0 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：独立审查通过。冻结修复指纹 `sha256:b6ad14d0…0a6f` 上的 21 个受影响项已逐项复审，12 个事实未变化项直接复用；33 项全部 `[x]`，两类问题列表均为空。证据闭包：owner-kernel 13/13、两生产根 2/2、S7 15/15+golden、workspace build 17/17，以及本轮对生产调用图、权威日志前缀、pending materializer、公开零入口和 Unit32 边界的只读对账。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| `always-online-and-local-execution-requirements.md` §一 | 适用 | 持续在线与本机真实环境并存的产品问题归入 IR31-01、IR31-30～IR31-31。 |
| 需求文档 §二～§五 | 不适用 | 外部项目转述、事实核验与方案形成过程不是本单元规范性合同。 |
| 需求文档 §六～§七 | 适用 | 两种部署形态体验平权、本机继续工作与全局能力诚实不可用归入 IR31-11～IR31-15、IR31-24、IR31-30。 |
| `distributed-runtime-charter.md` 当前交付原则、一、二 | 适用 | 最小完整产品、一个产品与本机连续工作归入 IR31-01、IR31-11～IR31-15、IR31-30～IR31-33。 |
| 总纲 §1 | 适用 | 单机退化形态与锚点/本地域权威分界归入 IR31-01、IR31-06、IR31-22～IR31-24。 |
| 总纲 §2 | 适用 | anchor、executor、surface 职责及意向 record/review 的角色边界归入 IR31-06、IR31-16～IR31-17、IR31-23～IR31-24。 |
| 总纲 §3 | 适用 | core→owner-kernel→owner-services→cli 的正式依赖方向及无环边界归入 IR31-22、IR31-25、IR31-32。 |
| 总纲 §4 的身份、权限、能力与最小权限 | 适用 | conversation/current-owner、principal×method、deadline 与 fail-closed 归入 IR31-02、IR31-06、IR31-09、IR31-16～IR31-17、IR31-29。 |
| 总纲 §4 的 mesh、配对、信任链、SecretStore 与迁居授权 | 不适用 | 属既有 S2/S5 或第 32 单元；本单元仅在 IR31-25～IR31-27 检查未越权开放。 |
| 总纲 §5 | 适用 | conversation-owned intent、全局 schedule/rubric owner 与正负能力矩阵归入 IR31-06～IR31-18、IR31-23～IR31-27。 |
| 总纲 §6 | 适用 | 本单元只复用 control admission、幂等、CAS 与确认终态，归入 IR31-16～IR31-21；run/job 派发状态机不扩写。 |
| 总纲 §7 | 不适用 | Environment 路由由第 30 单元既有 local owner 提供，本单元没有新环境选择或 workspace 义务。 |
| 总纲 §8 | 适用 | rubric ArtifactStore 依赖闭包与确认最终性归入 IR31-10、IR31-14、IR31-18～IR31-21。 |
| 总纲 §9 | 适用 | schedule/rubric 意向闭包、随 owner 迁移、锚点重校验、时效再确认、internal-only 与第 32 单元接缝归入 IR31-01、IR31-06～IR31-27、IR31-30。 |
| 总纲 §10 | 适用 | intent 投影恢复先于准入、写入受 lifecycle gate、关闭拒绝新写归入 IR31-22～IR31-24。 |
| 总纲 §11 | 适用 | “尚未生效/连接值班设备后确认或保存”的诚实产品语言与零公开入口归入 IR31-11、IR31-15、IR31-25、IR31-30。 |
| 总纲 §12 | 适用 | 响应丢失、冲突、日志/投影恢复、资产缺失、重启和停机归入 IR31-07～IR31-10、IR31-15、IR31-18～IR31-24、IR31-28。 |
| 总纲 §13 不变量 1～5、8、11～12、14～17 的直接部分 | 适用 | owner fencing、幂等、角色零加载、ID、双拓扑、结构、staged 零外泄、安全与恢复归入 IR31-02～IR31-29。 |
| 总纲 §13 的 job/channel/transfer/资源治理专属部分 | 不适用 | 不属于第 31 单元；本单元只验证没有建立相应能力旁路。 |
| 总纲 §14 第 31 单元 | 适用 | S8 `DeferredGlobalIntent` 实施顺序与 internal-only 停止条件归入 IR31-01～IR31-33。 |
| 总纲 §14 第 30、32～38 单元 | 不适用 | 第 30 单元仅作已完成前置条件，第 32 单元仅保留消费接缝；后继能力不得提前成为提交内容。 |
| 总纲 §15 | 适用 | 范围内双生产根、严格联合、恢复、冲突、原子性和产品文案证据归入 IR31-02～IR31-33。 |
| `specification.md` §1.1 | 适用 | `int-<Ulid>`、conversation/localDomain、requestId、LSN 与规范时间归入 IR31-02～IR31-03、IR31-07～IR31-09。 |
| 规格 §1.2 | 适用 | canonical digest、未知字段拒绝、引用闭包与 wire/log 一致性归入 IR31-02～IR31-05、IR31-07、IR31-10、IR31-29。 |
| 规格 §1.3、§1.3b | 适用 | `DeferredGlobalIntent`、`IntentStreamRecord`、schedule/rubric 联合与 control result 类型归入 IR31-02～IR31-05、IR31-18～IR31-21。 |
| 规格 §1.4～§1.5 | 适用 | 术语映射、内部 AuthorityError accepted-domain、拒绝终态与公开映射边界归入 IR31-11、IR31-15、IR31-18、IR31-29～IR31-31。 |
| 规格 §2.1～§2.2 | 适用 | host/surface/assignment 方法矩阵、current owner 与 authenticated surface 归入 IR31-06、IR31-09、IR31-16～IR31-17、IR31-25。 |
| 规格 §2.3～§2.5 | 不适用 | SecretStore、暴露记录与 mesh bootstrap 不由本单元修改或消费。 |
| 规格 §3.1 | 适用 | rubric local-draft 先进入既有 SessionState、发布失败不回滚采用归入 IR31-13、IR31-15。 |
| 规格 §3.2 | 适用 | 锚点 schedule/rubric 全局 validator、reducer、CAS 与 revision 归入 IR31-18～IR31-21。 |
| 规格 §3.8、§3.2b | 适用 | intent record/list/decide 闭合方法集、principal 守卫、local/anchor/current-owner 边界归入 IR31-06～IR31-09、IR31-16～IR31-17、IR31-25。 |
| 规格 §3.3～§3.7 | 不适用 | 环境、资源、advancement review、run executor/submission 端口是既有上游能力；本单元没有新增或改写其协议。 |
| 规格 §4.1 | 适用 | 每域唯一 AuthorityCommitLog、逻辑流、一次 fsync、耐久投影和日志锁内读取归入 IR31-04～IR31-10、IR31-18～IR31-23。 |
| 规格 §4.2 | 适用 | rubric 内容先落 ArtifactStore、候选引用闭包与缺件拒绝归入 IR31-10、IR31-14～IR31-15、IR31-18。 |
| 规格 §4.3 | 适用 | `intent:<conversationId>`、latest-wins 状态和 transfer 分类归入 IR31-04～IR31-09、IR31-20、IR31-27。 |
| 规格 §4.4 | 适用 | 全局 reducer 准备、同一事务 global effect+control applied+intent confirmed 归入 IR31-18～IR31-21。 |
| 规格 §4.5 | 适用 | intent、投影和 rubric 引用的保留/重建边界归入 IR31-08、IR31-10、IR31-20。 |
| 规格 §5.1 | 适用 | internal global-write control envelope、稳定 request binding 与回放归入 IR31-18～IR31-21。 |
| 规格 §5.2～§5.7 | 不适用 | 派发、能力匹配、run/job 提交、状态投递、stream 与取证不是本单元新增功能；禁止借意向重开这些路径。 |
| 规格 §6.1～§6.2b | 不适用 | conversation/job 状态机由既有 owner/runtime 承担，本单元不新增 run/job 状态。 |
| 规格 §6.3 | 适用（边界） | intent 必须被分类为 conversation-owned transfer 内容，但 freeze/import/current-owner 切换与收编事务属于第 32 单元；归入 IR31-27。 |
| 规格 §6.4 | 不适用 | 设备状态与 uncertain resolution 不由意向协议改变。 |
| 规格 §7 | 适用（局部） | conversation 域的 intent 随 owner 转移/保留分类归入 IR31-27；其他权威类别不进入本单元。 |
| 规格 §8 | 适用（局部） | schedule 四种完整写、rubric save-own/update-own 与 internal intent 落点归入 IR31-11～IR31-18、IR31-25；其他落点不扩写。 |
| 规格 §9 | 适用 | local/anchor 两域 schedule、rubric、intent、公开能力差异逐行归入 IR31-11～IR31-18、IR31-23～IR31-28。 |
| 规格 §10、§10.1 | 适用（交界） | 本单元不得新增资源/存储治理旁路；启动恢复和关闭在途追加边界归入 IR31-10、IR31-22～IR31-24。 |
| 规格 §11 | 适用 | 离线记录、尚未生效、时效再确认和重连后待复核的零术语文案归入 IR31-11、IR31-15、IR31-30。 |
| 规格 §12 的直接不变量 | 适用 | ID、幂等、栅栏、双拓扑、角色零加载、结构、安全、恢复与资产在场归入 IR31-02～IR31-29。 |
| 规格 §12 的 job/channel/mesh/transfer/存储维护专属矩阵 | 不适用 | 不属于第 31 单元，不得形成配置×故障笛卡尔积。 |
| 规格 §13 的 scheduler 与 rubric 行 | 适用 | 当前 schedule/rubric 文档与离线沉淀边界同步归入 IR31-31。 |
| 规格 §13 的其他模块行 | 不适用 | 当前交付没有修改相应模块合同。 |
| 规格 §14 | 不适用 | S1 历史开工说明不是第 31 单元现行合同。 |
| 规格 §15 第 30～32 项及依赖顺序 | 适用 | 第 30 单元同构 owner 是前置，第 31 项是当前实现/验收，第 32 项只作为可消费接缝；归入 IR31-01、IR31-22～IR31-28、IR31-33。 |
| 规格 §15 其他项 | 不适用 | 已完成上游仅按具体接口消费，后续 33～38 不得成为当前门禁。 |
| `scheduler-architecture.md` 当前生产架构、§一与§三中现行 authority mutation 合同 | 适用 | 四种完整 schedule 写、revision CAS、无 read/run/abort 与真实产品语义归入 IR31-11～IR31-12、IR31-18～IR31-20、IR31-30。 |
| scheduler 文档 §二、历史推演及“待根治项” | 不适用 | 历史割裂说明与另案技术债不是第 31 单元交付义务。 |
| `task-advancement-rubric-architecture.md` 需求区、§0～§3 | 适用（边界） | 用户价值、local-draft 与既有 advancement 拓扑作为上游边界归入 IR31-13～IR31-15、IR31-30。 |
| rubric 文档 §4.1～§4.3、§4.5～§4.7 | 适用（上游） | 既有 advancement 状态身份不得被沉淀意向改写，归入 IR31-13、IR31-15、IR31-32。 |
| rubric 文档 §4.4、§5.2 | 适用 | 快照采用与全局库沉淀分离、save/update 离线转意向归入 IR31-13～IR31-15。 |
| rubric 文档页首 S7 当前取证边界 | 适用（上游） | 本单元修改 S7 门禁与 advancement 发布接缝，不得恢复本地 `evidenceProvider`、fallback 或兼容开关；归入 IR31-26、IR31-32。 |
| rubric 文档 §5.1、§5.3～§7 的既有 run/review/recovery | 适用（交界） | 既有推进生命周期继续运行且不被发布失败回滚，归入 IR31-13、IR31-15、IR31-28、IR31-32。 |
| rubric 文档 §7 的全局预算待决项 | 不适用 | 文档明确为跨模块待决义务；第 31 单元不新增全局预算或局部限流。 |
| rubric 文档 §8 的当前全局资产/会话身份与 §9 cache 边界 | 适用 | ArtifactStore、只读 cache revision、active snapshot 不变归入 IR31-10、IR31-13～IR31-15、IR31-18、IR31-32。 |
| rubric 文档 §8 的冷启动预设与演化回路 | 不适用 | 文档分别明确进入 requirement backlog 和“留口不实现”；没有当前单元交付义务。 |
| rubric 文档 §10 | 适用（局部） | 仅 save/update 选择后的发布结果与“采用不等于已保存”反馈归入 IR31-13～IR31-15、IR31-30；既有事件、确认 UI、收场与未来渠道节奏不由本单元重审。 |
| rubric 文档 §11～§14 | 适用（上游） | 只取当前稳定角色边界、直接测试拓扑与不变量，归入 IR31-22、IR31-25、IR31-28、IR31-32～IR31-33；历史包名和已交付施工记录不形成新落点。 |
| rubric 文档 §15、C1～C17 | 不适用 | 已完成的提交/审查拆分与施工记录不是第 31 单元现行实施清单，只由 IR31-32 守有限上游兼容。 |
| rubric 文档 C18 当前持久化选择合同 | 适用 | `save-new`/`update-existing` 的用户选择、目标 identity/revision 与 active snapshot 不变直接归入 IR31-13～IR31-15。 |
| `unit-development-workbench.md` 静态目标/边界与 D31-01～D31-06 | 适用 | 六项生产、消费、异常、恢复和直接测试义务反向归入 IR31-01～IR31-33。 |
| 当前完整交付物 HEAD `6410de0a` 与工作区 36 个变化路径 | 事实来源 | 32 个第 31 单元生产、直接测试、S7 门禁与当前合同路径逐一归入 IR31-01～IR31-33；4 个工作台/上一单元归档与台账路径明确排除，不参与功能通过判定。 |

### 审查项

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR31-01 | [x] | 单元身份、边界与完整交付物 | 冻结当前 41 个变化路径并二元归属；34 个功能路径必须全属 D31-01～D31-06，7 个工作台/归档/台账路径不参与功能判定；不得含第 32～38 单元能力或无依据框架。本项在路径归属与边界对账完成后停止。 | 复审 `6410de0a` 至当前工作树的 41 路径：34 个功能路径全部反绑 D31-01～D31-06，7 个 workbench 路径仅为流程状态；U31-01～U31-02 修复增量只闭合会话身份/intent 同日志线性化、schedule pending 重驱及直接证据。未实现 transfer、current-owner 切换、公开离线入口、结果联合或通用框架，EX31-01 未触发。 |
| IR31-02 | [x] | 严格意向判别联合 | `DeferredGlobalIntent` 只接受 schedule-create/update/set-state/delete 与 rubric-save-own/update-own；各分支字段、revision、ArtifactRef、timeSensitive 分类、未知字段和跨族组合在副作用前严格校验。 | `deferred-global-intent.ts` 以六分支精确键集复用 schedule/rubric validator，并强制 schedule=true、rubric=false；`control-artifacts.ts` 的 global-write 同用该 validator。联合测试覆盖六正例、未知/缺字段、跨族、revision 与时效错配，均在日志调用前抛错。 |
| IR31-03 | [x] | identity、时间与 digest | intentId 必须为稳定 `int-<Ulid>`；localDomainId、conversationId、requestId、recordedAt/reviewedAt、mutation digest 与首次 envelope 时间全等反绑，重启、重放和收编不得漂移。 | 确定性 intentId、首次 envelope 时间与 mutation digest 合同未改；窄 journal 事务只移动线性化位置，不重算身份或时间。matching replay 先于 fresh guard 返回原 intentId/recordedAt，终态仍只由同一 reducer 固化 reviewedAt；异载荷与相反终态稳定拒绝。 |
| IR31-04 | [x] | intent 流与记录 codec | 记录只可进入 `intent:<conversationId>`，不得与 `intent:rubric-registry` 或异会话碰撞；wire/log codec、`IntentStreamRecord` 与流分类双向全等，错流零追加。 | `deferredIntentStream`/`isDeferredIntentStream` 明确排除 `intent:rubric-registry`；record、projection reducer 与 control reducer 均经 `validateIntentStreamRecord` 双向反绑 body conversationId 与流后缀。codec 测试覆盖异会话、rubric-registry 碰撞与畸形记录，失败前无 append。 |
| IR31-05 | [x] | latest-wins 状态机 | 每个 intent 仅允许 pending→confirmed 或 pending→discarded；pending 首记录、终态不可改写、相反决定拒绝、exact terminal replay 零追加，身份/正文/timeSensitive/recordedAt 不可变。 | reducer 仍只接受 pending 首记录及两个单向终态；record/discard 的 matching replay 均在 fresh identity/delete guard 前零追加返回，异载荷或相反终态拒绝。confirmed terminal replay 仅重驱既有派生 pending，不改写 intent 或全局权威记录。 |
| IR31-06 | [x] | repository owner 与准入 | record 仅当前本地域 owner 的既有 local conversation/host；anchor record、assignment、错域/错 owner/未知或已删除会话、过期 deadline 均在日志/资源副作用前拒绝；list/decide 仅当前 owner 允许 principal。 | 静态 mode/principal/domain/deadline 拒绝保持在事务前；fresh record/discard 改由当前 `ConversationRunJournal` 在同一 AuthorityCommitLog 锁内联合读取 control identity、journal identity/delete、ownerEpoch 与 intent 投影。delete 胜出时零 intent 追加，intent 胜出时完整提交；未知/已删除会话拒绝，matching replay 可越过后续删除全等返回。 |
| IR31-07 | [x] | record 幂等与并发线性化 | requestId+domain+conversation+规范 mutation/timeSensitive 形成稳定操作；exact replay 返回原 intentId/recordedAt 且零追加，异载荷复用冲突，并发、fsync 前后、响应丢失和连续重启无半记录或双 intent。 | 稳定 request/digest 身份不变；journal 窄事务把 intent 投影与会话 delete 放入同一日志前缀，先判 exact replay、再判 fresh identity 并 append。真实同日志竞争证明并发同请求与 delete 只有一个合法提交，响应丢失/重启仍返回原身份和首次时间，异载荷零追加拒绝。 |
| IR31-08 | [x] | 耐久投影、排序与重建 | request、locator、intent latest 与首次 LSN 顺序键均由同一日志投影；list 按首次 record 顺序稳定分页且不扫全历史，坏尾/索引丢失或损坏可重建并与日志全等。 | 单一 reducer 同步维护 intent latest、locator、request 摘要及 `order:<conversation>:<firstLsn>`；list 仅分页扫描该会话 order 前缀并点读 latest，不扫 AuthorityCommitLog。`recover/rebuild` 复用 DurableProjectionIndex 的 checkpoint/manifest 与坏尾恢复，repository 重开测试对账顺序与 latest 状态。 |
| IR31-09 | [x] | list、discard 与本地域终态 | list 返回当前会话 latest-wins 全集；discard 只把 pending 原子变为 discarded、重复幂等、相反终态拒绝、零全局副作用；本地域 confirmed 必须拒绝并引导锚点 review。 | list 继续读取 current-owner 的 latest-wins 投影；fresh discard 在 journal 同锁事务内重读 intent 与会话 delete，删除胜出零追加，discard 胜出形成唯一终态。重复 discard 先返回、相反终态与本地 confirmed 拒绝，未引入任何全局写副作用。 |
| IR31-10 | [x] | rubric 资产依赖闭包 | save/update 的内容必须先以规范正文进入既有 ArtifactStore，并在 intent 提交/确认时作为 candidate reference；缺失、损坏、metadata/content 不全等、写失败和 GC/重建边界不得产生可确认 intent 或悬空全局记录。 | journal 事务通过原 `candidateReferences` 把 rubric ArtifactRef 继续纳入同一提交闭包；anchor 确认仍重读并反绑 metadata/content，缺失或损坏不得确认。会话 guard 前已写但未引用的 CAS 内容不是可见业务事实，沿既有 GC 边界回收；未扩建跨存储事务，当前正确性与架构均闭合。 |
| IR31-11 | [x] | schedule 四种完整写 | 本地域 producer 只接收四种完整 `ScheduleWriteMutation`；create/update 携完整 spec，update/set-state/delete 携 taskId 与 CAS revision，全部 timeSensitive，成功只返回稳定 intentId 与“尚未生效、需确认”。 | `DeferredScheduleIntentProducer` 的输入即封闭 ScheduleWriteMutation；调用前再以 timeSensitive=true 严校验，随后只转交唯一 intent port。四分支测试核对完整 spec/taskId/revision、稳定 requestId、deferred intentId 与固定“尚未生效、需确认”文案。 |
| IR31-12 | [x] | schedule 负向能力闭包 | producer 不暴露 list/run/abort，不读取或合成全局任务、不触达 AnchorScheduler/GlobalState/job/delivery/staged publish；不完整 mutation、登记失败或无锚点不能显示已生效或成功。 | 类仅持 DeferredGlobalIntentPort，公开面只有 `record`，生产调用图无 scheduler/global/job/delivery/staged 依赖；本地域 port 也仅暴露 defer/list/discard。缺 revision/不完整 update 在 port 前拒绝，repository 失败向上传播，零“已生效”结果；生产 conformance 核对 task/job 流计数不变。 |
| IR31-13 | [x] | rubric 采用与沉淀分离 | local-draft 契约快照先独立进入 SessionState 并立即用于当前任务；仅 save-own/update-own 产生意向，沉淀失败不得回滚已采用快照，也不得把 adopted 冒充 globally saved。 | AdvancementController 先 await `store.confirmRubric` 形成 local-draft snapshot，再异步启动 publication task；publication 失败仅返回“任务已继续执行、暂未保存”，不回滚 SessionState。local 组合根只注入 DeferredRubricPublication，联合只可能构造 save-own/update-own。 |
| IR31-14 | [x] | rubric save/update 准备 | save-new 不依赖目录命中并生成完整 save-own；update-existing 必须反绑只读 cache 中 rubricId+expectedRevision，过期/缺失/错 identity 拒绝；archive 永不可构造。 | `prepareDeferredRubricMutation` 对 save-new 直接投影/解析并生成 save-own；update-existing 先从只读 execution catalog 加载目标、解析 revision，再要求投影 document id 全等目标后生成 update-own。缺/坏 revision、缺目标与身份变化均拒绝，类型与 validator 无 archive 分支；requestId 反绑 draft+choice+target。 |
| IR31-15 | [x] | rubric 发布恢复与产品终态 | 准备、资产或 intent 写失败不得伪装保存；exact replay/响应丢失/重启不重复意向；成功文案明确“已用于本任务，连接值班设备后保存”，不泄漏内部术语。 | publisher 的 prepare→asset→record 顺序与固定 deferred 文案未变；repository matching replay 现经同一 journal 事务返回原 intent，响应丢失/重启仍不重复。身份/delete guard 的新增拒绝只进入既有可行动失败分支，不回滚已采用快照，也不泄漏 intent/anchor/stream 等内部术语。 |
| IR31-16 | [x] | 锚点 locator 与 current owner | anchor review 必须先由耐久 locator 取得 conversation，再以 current-owner guard 通过后读取完整 intent/资产/全局状态；未知、错流、未导入、非当前 owner 零信息泄漏与零全局副作用。 | review/decide 均先点读耐久 locator，仅取得 conversationId，再调用注入的 current-owner predicate，成功后才 locate 完整 intent；locator 缺失、非当前 owner 测试均在 mutation/资产/global projection 读取前拒绝。第 32 单元可替换该 predicate，当前未实现 transfer。 |
| IR31-17 | [x] | review principal 与时效再确认 | schedule 恒只接受 authenticated surface 确认，host/伪 surface 不得代替；非时效 rubric 可由有限 host/surface review；discard 无需全局写且两族都遵循同一 owner fence。 | admission 先执行 principal×method；confirmed 分支再强制 timeSensitive 仅 surface，rubric 仅 host/surface，并由 context 生成不可带 ingress 的 TrustedControlSource。schedule host 反例、rubric host 正例已覆盖；discard 在全局 envelope 前走 repository，保持同一 owner fence 和零全局记录。 |
| IR31-18 | [x] | 全局重校验、CAS 与冲突 | 确认时必须从同一锁内权威前缀重新校验当前 intent、schedule/rubric validator、revision/CAS、资产与 global projection；冲突或暂态失败保持 pending 且零部分效果；本单元 internal-only seam 不承担公开产品错误合同。 | 同锁前缀重校验、CAS/资产拒绝与 pending/零部分效果成立。冻结的 `DeferredGlobalIntentPort.decide` 返回 `Promise<void>`，anchor review 也没有 CLI/RPC/channel consumer；现在新增产品结果联合会提前决定第 32 单元的公开收编体验。稳定产品码、可行动说明与内部术语净化已明确转入第 32 单元公开旅程，不作为第 31 单元门禁。 |
| IR31-19 | [x] | 原子 global+control+confirmed | 同一 AuthorityCommitLog 事务必须一次提交全局 schedule/rubric 记录、control applied 结果与 intent confirmed；禁止先 mutate 全局再补 intent，任何 fsync 边界均不得出现全局效果与 confirmed 分离。 | review service 只返回一个 AtomicControlApplicationPlan：authorityEntries 同含 prepared task/rubric records 与 confirmed intent，ControlAdmission 同批补 control applied；companion streams/readProjectionIds/candidateReferences 均声明于同一 `transactProjectionPrefix`。两族测试按同一 CommitEnvelope 查到三类记录，无先行 GlobalState mutate。 |
| IR31-20 | [x] | 决定重放与派生物化 | intentId+mutation digest 派生稳定 control request；同决定 exact replay 零追加，反向决定拒绝，响应丢失/连续重启不重复全局权威效果；schedule 派生 refresh 失败不得改变已提交事实且可重驱。 | 首次 confirmed 与 terminal same-decision 现统一调用 `#materializeConfirmedSchedule`，由冻结 intent 重建同一 requestId、taskId 与目标 revision（create=1，其余原 revision+1）。refresh 效果前/后失败均保留耐久 pending 并拒绝返回；同进程重试或启动恢复可追平。materialized 只清不晚于该目标的 pending，旧 replay 不清较新目标且不重复 task revision。 |
| IR31-21 | [x] | control admission 与全局 reducer 接缝 | `global-write` envelope/result 必须严格校验、无 ingress 伪造，async decide、companion streams 与 readProjectionIds 只放行声明闭包；schedule/rubric durable projection 和 request replay 与既有在线 GlobalState 语义一致。 | 复审 control codec、admission 与 coordinator：global-write 严格联合、无 ingress source、companion streams/readProjectionIds 和原子 authority entries 均未放宽。新增 conversation identity 投影只由同日志 `session-create received→applied ok` 派生并只读参与 intent guard；schedule 重驱复用既有 pending/materializer，未增加权威写面。 |
| IR31-22 | [x] | 本地域单一 repository 装配 | 每个 local assembly 恰一 repository，schedule producer、rubric publication、list/discard 共用同一实例和 executor log；启动先 recover 投影，两个生产根不得重复实例或建立第二事实源。 | LocalConversationOwnerAssembly 仍只构造一个 local repository，并新增同一 ownerEpoch 与 `protocol.deferredIntentAuthority` 显式反绑；schedule、rubric、list/discard 继续共用该实例和 executor log。启动顺序仍先恢复投影；两真实生产 profile 的 ensureSession→record/list/replay/discard 直接装配证据通过，未出现第二 repository。 |
| IR31-23 | [x] | 锚点单一 review 装配 | 每个 anchor-enabled 生产拓扑恰一 anchor-mode repository/review service，复用 control admission、global coordinator、rubric authority 和当前 protocol owner；anchor record 恒不可达，不适用角色零装配。 | AnchorSchedulerRuntime 仍恰一 anchor-mode repository/review，新增 anchorEpoch 与当前 protocol journal authority 的窄绑定；authorityLog、control admission、coordinator、rubric authority 均复用原实例。anchor record 仍由 mode 拒绝，非 anchor topology 无该 runtime；未引入 transfer 或公开 consumer。 |
| IR31-24 | [x] | topology 与角色 exact-set | 对 `planServeTopology` 八种配置及 anchor+executor、executor-only 两生产根核对 local repository、anchor review、shared producers 和 cleanup/lifecycle 的恰一/零集合；同机双角色不得串域。 | 既有八配置表精确判定 local owner 位于 access-surfaces、executor-role 或 none，并反绑 cleanup owner；S7 再证明每个 local assembly 单 repository/双 producer、每个 anchor runtime 单 review。anchor+executor 使用分离 authorityLog/executorLog，同机仅 local 端可 record；surface 等价配置不改变集合。 |
| IR31-25 | [x] | internal-only 端口与公开零入口 | local internal port 只暴露 defer/list/discard 窄能力并经统一 lifecycle gate；anchor review 只供第 32 单元注入，不得注册 CLI/RPC/channel/status/tool 或把 raw repository/GlobalState 暴露给 surface。 | 公开 port 形态未扩写：local 仍仅 defer/list/discard 且全部经过统一 lifecycle gate；新 authority 适配器冻结为 protocol 内部单方法事务能力，raw journal/repository/GlobalState 均不逸出。生产引用与 staged diff 未出现 CLI/RPC/channel/tool/status 注册，anchor review 仍为 internal seam。 |
| IR31-26 | [x] | S7 结构门禁与能力隔离 | 现有单一 S7 gate 必须机械证明 local/anchor 各一 repository、producer 共用实例、mode 正确、公开零暴露，并继续拒绝 GlobalState/global participant/delivery/其它 Store；真实变异应 fail-closed，合法两根零误杀。 | 现有单一 S7 gate 已扩展为核对 local/anchor repository 的 ownerEpoch、conversationAuthority 及 protocol 窄适配器，保留 mode、计数、共享 producer、公开零暴露和禁用能力检查。直接变异覆盖缺失/替换绑定与 adapter 漂移，15/15+golden 证明合法两根零误杀；未新增 lint 或通用调用图。 |
| IR31-27 | [x] | 第 32 单元 transfer 接缝 | intent 流必须被明确分类为 conversation-owned、locator/最新状态/资产可由收编直接消费，localDomainId 保留来源身份；本单元不得实现 transfer 流、freeze/import/current-owner 切换或公开 adopt。 | `intent:<conversationId>`、localDomainId、latest/locator/order 与 ArtifactRef 合同保持不变；新增 guard 只消费当前 journal ownerEpoch，不实现 epoch 切换。代码与文档 diff 均无 AuthorityTransfer、freeze/import/commit/tombstone、current-owner switch 或公开 adopt，anchor current-owner predicate 仍留作第 32 单元接缝。 |
| IR31-28 | [x] | 双生产根 conformance 与恢复 | 证据须按生产交界风险成比例：两 local profile 真实穿过 assembly 的 record/list/discard/replay/restart，anchor review、rubric/资产/CAS 与物化故障由直接生产服务测试覆盖；发现的生产交界缺陷必须并入对应根因验收，不复制组件矩阵或建设通用 fixture。 | 当前证据按失效边界闭合：两真实生产 profile 2/2 覆盖普通 control identity 与 local repository；owner-kernel 13/13 直接覆盖同日志 delete 竞争及四 schedule mutation 的 pending 故障；S7 15/15+golden 覆盖结构装配，workspace build 17/17 覆盖可消费性。没有只能由新共享 runner 发现的独立生产差异，EX31-01 重开条件不成立。 |
| IR31-29 | [x] | 安全、拒绝零副作用与并发 | 非法 identifier/date/revision/字段、错 principal/owner/stream、过期 deadline、并发 record/decide 与资产缺件均在首个权威日志或全局副作用前拒绝；对外结果不得回显 ArtifactStore 物理路径、内部 stream/projection 或权限身份。 | 静态 validator、principal/domain/deadline 与资产检查保持 fail-closed；动态 delete/record/discard 竞态现由同一 journal/log prefix 唯一排序，失败零 intent 追加。ownerEpoch/identity 投影仅为内部判定，不进入返回值；ArtifactStore 路径、stream/projection 与权限身份均无公开 consumer，Unit32 的产品错误映射未提前实现。 |
| IR31-30 | [x] | 有限产品输出与可行动反馈 | 本单元只核对 schedule producer 的 deferred 结果、既有 rubric publication 消费文案及 anchor internal review 的真实终态：响应丢失或重启后不改口，不得把尚未完成的派生效果报告为已完成。公开冲突语言和可行动选择归第 32 单元。 | schedule/rubric 的“已记录、尚未生效”文案未变；anchor internal decide 只有 materializer 已达到原 target 才返回 confirmed，效果前/后失败与响应丢失均拒绝并保留 pending，same-decision 重试继续追平。由此内部终态与 scheduler 实际效果一致；公开冲突语言仍明确留给第 32 单元。 |
| IR31-31 | [x] | 架构、规格与模块文档同步 | 总纲 §9/§14、规格 §3.2b/§15、scheduler 当前段与 rubric 采用/沉淀分界必须与现行类型和生产调用图一致；历史段保持非现行，第 32 单元能力不得被写成已交付。 | 总纲 §9/§14、规格 §3.2b/§15、scheduler 当前段和 rubric 采用/沉淀段已与实现全等：conversation journal 窄事务固定 replay→identity/delete/epoch→append，confirmed 首次/终态 replay 共用 pending materializer。历史段未升级，transfer/current-owner/公开复核仍归第 32 单元。 |
| IR31-32 | [x] | 有限上游兼容与包边界 | 只核对本轮直接触及的有限集合：在线 schedule/rubric authority mutate/replay、advancement active snapshot 与 C18 save/update 选择、S7 canonical-evidence-only 边界、SessionState、DurableProjectionIndex manifest/checkpoint 序列化及 S7 单一 lint 入口；新增 intent 不得使这些分叉或回退。包依赖保持无环，exports 只暴露冻结合同。 | 在线 schedule/rubric planner 与 authority reducer仍被直接复用，active snapshot/C18 save-update、SessionState、DurableProjectionIndex 与 canonical-evidence-only 均未分叉。新窄 authority 类型只沿 owner-kernel→cli 暴露，core→owner-kernel→owner-services→cli 依赖仍无环；S7 保持单一入口，17/17 workspace build 证明当前导出可消费。 |
| IR31-33 | [x] | 开发义务、条款与路径反向闭包 | D31-01～D31-06、全部适用来源条款、34 个功能路径与 IR31-01～IR31-32 必须双向全等：每项有生产端、消费端、装配、异常/恢复和直接证据落点，每条实现有当前架构依据；不得遗漏、重复或把测试存在当功能通过。 | D31-01～D31-06、适用条款、34 个功能路径及 IR31-01～IR31-32 已重新双向对账。U31-01 闭合 D31-02 的会话身份/delete 线性化，U31-02 闭合 D31-05 的同进程物化重驱；生产、消费、装配、异常/恢复和成比例证据均有落点。EX31-01 未重开，第 32 单元义务未提前，零未处置反证。 |

> 本清单只定义第 31 单元独立审查范围和证据要求；本轮 21 个输入变化项已全部复审通过，连同直接复用的 12 项，当前 33 项 `[x]`、零 `[ ]`、零 `[~]`、零 `[!]`。

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 工作量评估 | 问题评级 | 相关审查项 |
| ---- | -------- | ---------- | ---------- | -------- | ---------- |

### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| ------ | ------ | -------------- | ---------------- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| ---- | -------- | ---------- | ------------ | ---------- | -------- |
