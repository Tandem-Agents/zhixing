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

- **当前单元**：第 32 单元 · generation 1
- **权威来源**：research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md、distributed-runtime-charter.md、specification.md；直接上游合同为 scheduler-architecture.md、task-advancement-rubric-architecture.md、rubric-protocol.md、transcript-persistence-and-attention-window-architecture.md 及其引用的 lifecycle-concepts.md；执行边界以已定稿开发清单 D32-01～D32-08 为准
- **交付基线**：父提交 4f843748 → 当前工作树；共 54 个变化路径，其中 50 个属于第 32 单元生产实现、直接测试、S7 门禁与当前架构/规格同步，4 个 research/design/workbench 路径只承载开发清单、第 31 单元台账/清单归档及当前审查清单，不参与功能通过判定
- **生产装配关系**：本地域 owner 提供唯一 transfer source，锚点提供唯一 target/coordinator；双方通过既有认证 mesh request channel、各自 AuthorityCommitLog 与设备 ArtifactStore 协调，ConversationTransferCommit 唯一切换 current owner；同一 current-owner verifier 前置于 local/mesh evidence 读取；提交恢复后才驱动公开 local session 路由、收编复核与锚点记忆蒸馏
- **目标提交边界**：只交付 conversation scope 的双端耐久收编、完整会话域与 conversation-owned intent 搬运、唯一 ownerEpoch 切换、旧 owner fencing、current-owner evidence 门禁，以及收编闭合后的第一方离线新建/查询/恢复、自动收编、复核与记忆补驱动
- **明确排除**：anchor scope planned/disaster transfer、AnchorTransferCommit、TrustTransition、ReadyProof、全量/周期 CheckpointEnvelope、恢复根与凭据轮换；第 36～38 单元服务生命周期、设备移除/卸载、升级与发布；锚点域既有会话离线写、非权威只读副本、秘密/环境事实/缓存迁移、全局预算追认；第二事实源、通用事务/同步/备份/registry/事件总线/调用图/测试 runner、监控、诊断、benchmark 与信息采集；干活电脑不新增渠道宿主
- **当前任务进度**：0%（0 / 40 项已审；40 项 [ ]，0 项 [x]，0 项 [!]，0 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：已定稿，待独立审查。同一份 40 项清单已通过来源条款、完整功能链、生产装配/交付路径和范围价值四路冷启动对抗复审；本轮只定稿范围与证据要求，未执行独立审查，40 项仍为 `[ ]`。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线与本机真实环境并存的产品目标归入 IR32-01、IR32-21～IR32-28、IR32-37。 |
| 需求文档 §二～§五 | 不适用 | 外部项目转述、事实核验与方案形成过程不是本单元规范性合同。 |
| 需求文档 §六～§七 | 适用 | 两种部署形态体验平权、失联时本机继续工作及重连后收编归入 IR32-21～IR32-28、IR32-31、IR32-37。 |
| distributed-runtime 目录的 s2-security-supply-chain-review.md 全文 | 不适用 | 本单元未新增、升级或改变 mesh 安全依赖及供应链装配；只复用既有认证 mesh，安全依赖门禁不得扩成当前功能审查。 |
| distributed-runtime-charter.md 当前版本交付原则、一、二 | 适用 | 最小完整产品、单一产品和当前用户价值归入 IR32-01、IR32-21～IR32-28、IR32-37～IR32-40。 |
| 总纲 §1 | 适用 | 单机是分布式退化形态、会话权威唯一及角色复用归入 IR32-01、IR32-15～IR32-18、IR32-31、IR32-37。 |
| 总纲 §2 | 适用 | anchor、executor、surface 角色与 source/target/公开接入边界归入 IR32-06～IR32-18、IR32-21～IR32-26、IR32-31。 |
| 总纲 §3 | 适用 | core→owner-kernel→rpc/cli 的无环依赖和组合根职责归入 IR32-02～IR32-04、IR32-31～IR32-34、IR32-37。 |
| 总纲 §4 | 适用（复用边界） | 设备身份、认证 mesh、签名、最小权限和 old-owner fencing 归入 IR32-02～IR32-05、IR32-11、IR32-17～IR32-20、IR32-33、IR32-35；不重审配对和信任链实现。 |
| 总纲 §5 | 适用 | 会话域完整权威、conversation-owned intent、全局 memory 与 schedule/rubric owner 分界归入 IR32-08、IR32-13～IR32-17、IR32-24～IR32-25、IR32-29～IR32-30。 |
| 总纲 §6 | 适用（交界） | freeze 前 active/queued/confirmation/finality 收束及旧能力拒绝归入 IR32-07、IR32-16～IR32-18、IR32-32；不扩写 run/job 协议。 |
| 总纲 §7 | 不适用（守边界） | 环境路由是既有 S7 能力；本单元只在 IR32-08、IR32-20、IR32-35 检查 workspace/环境事实不被迁移或越权读取。 |
| 总纲 §8 | 适用（交界） | mesh 无损请求、确认最终性和响应丢失恢复归入 IR32-10～IR32-14、IR32-18、IR32-23～IR32-26、IR32-33。 |
| 总纲 §9 | 适用 | conversation AuthorityTransfer、current-owner 切换、公开离线旅程、复核与 post-adoption memory 全量归入 IR32-02～IR32-33。 |
| 总纲 §10 | 适用（局部） | 启动恢复先于准入、停机拒绝新 transfer 并保留耐久事实归入 IR32-10、IR32-14、IR32-18、IR32-30、IR32-32；托管服务/移除/卸载属于后续单元。 |
| 总纲 §11 | 适用 | “值班设备/干活的电脑”语言、明确同意、可行动错误与待确认重浮现归入 IR32-21～IR32-28。 |
| 总纲 §12 | 适用（直接行） | transfer 任意步中断、网络/响应丢失、重启、旧 owner、坏尾、磁盘满、版本偏斜及确认重连归入 IR32-04～IR32-20、IR32-23～IR32-26、IR32-30～IR32-36。 |
| 总纲 §12 的灾难恢复、设备撤销和渠道投递专属行 | 不适用 | 分别属于第 33～38 单元或既有 S6/S7；本单元只验证未借收编提前启用。 |
| 总纲 §13 不变量 1、4～6、8、11～17及 2～3 的 freeze 交界 | 适用 | 唯一 owner、executor 零全局写、角色零装配、秘密不迁移、old-owner fencing、双拓扑、完成语义、包边界、staged 隔离、能力校验及在途 run 身份/栅栏兼容归入 IR32-02～IR32-20、IR32-31～IR32-37；job 专属部分不扩写。 |
| 总纲 §13 的 job、delivery 与完整资源治理专属部分 | 不适用 | 不属于 conversation 收编；只在 IR32-34、IR32-36 检查复用既有治理且不建旁路。 |
| 总纲 §14 S8 第 32 单元 | 适用 | 当前实施顺序与停止条件归入 IR32-01～IR32-40。 |
| 总纲 §14 既有上游与第 33～38 单元 | 不适用（边界） | 上游仅按现行端口消费；后继 transfer/backup/service 能力不得提前成为提交内容，归 IR32-38 守界。 |
| 总纲 §15 | 适用 | 双拓扑、故障、安全、零术语与成比例证据归入 IR32-02～IR32-40。 |
| specification.md §1.1 | 适用 | xfer/request/conversation/device identity、ownerEpoch、localDomainId 与规范时间归入 IR32-02、IR32-05、IR32-15～IR32-18、IR32-22～IR32-23、IR32-29。 |
| 规格 §1.2 | 适用 | JCS、严格未知字段、Digest/ArtifactRef、签名域与引用目标归入 IR32-02～IR32-05、IR32-09、IR32-12～IR32-14、IR32-33、IR32-35。 |
| 规格 §1.3、§1.3b | 适用 | conversation、SessionState、segment、Evidence、memory、schedule/rubric 外部符号与冻结字段归入 IR32-02、IR32-08、IR32-13、IR32-19、IR32-24～IR32-25、IR32-29。 |
| 规格 §1.4～§1.5 | 适用 | 构件名、AuthorityError 与公开稳定结果边界归入 IR32-04、IR32-20～IR32-28、IR32-38。 |
| 规格 §2.1 | 适用 | device/current owner、SourceFreezeProof、ConversationTransferCommit/Manifest/Abort 与 TransferRecord 身份归入 IR32-02～IR32-05、IR32-11～IR32-18。 |
| 规格 §2.2 | 适用（复用） | source/target 签名、受众、scope、expiry 和 replay 防护归入 IR32-03～IR32-05、IR32-11、IR32-17～IR32-20、IR32-33、IR32-35。 |
| 规格 §2.3～§2.4 | 不适用 | SecretStore 与 CredentialExposureRecord 不迁移、不修改；IR32-08、IR32-35 只审秘密零进入 transfer。 |
| 规格 §2.5 | 适用（既有接缝） | 两生产根复用已认证 mesh bootstrap、角色授权与连接恢复归入 IR32-11、IR32-18、IR32-31、IR32-33、IR32-37。 |
| 规格 §3.1 | 适用 | 完整 SessionState 重建、会话 mutation/current-owner guard 与本地域公开能力归入 IR32-08、IR32-13、IR32-15～IR32-17、IR32-21～IR32-22。 |
| 规格 §3.2 | 适用（消费） | 收编后 rubric/schedule review 与 MemoryFlush 只能走锚点既有 GlobalStatePort 归入 IR32-24～IR32-25、IR32-29～IR32-30；source/target 不得获得全局写能力。 |
| 规格 §3.8、§3.2b | 适用 | intent 随 conversation 搬运、current-owner 定位、收编后 internal review 与 authenticated confirmation 归入 IR32-08、IR32-13、IR32-16、IR32-23～IR32-26。 |
| 规格 §3.3～§3.4b | 适用（守边界） | 环境事实不迁移，transfer 拉取与 staging 复用设备容量/存储治理归入 IR32-08、IR32-12、IR32-34～IR32-36。 |
| 规格 §3.5 | 不适用 | ControlCompletionPort / AdvancementReviewerPort 是既有推进裁判端口；收编后 rubric/schedule 复核走 §3.2b internal review 与 ConfirmationHub，memory 走 GlobalStatePort，不得借本单元改写 §3.5。 |
| 规格 §3.6～§3.7 | 适用（交界） | freeze 前 run/assignment/finality 收束、commit 后旧 owner 能力拒绝归入 IR32-07、IR32-16～IR32-18；不新增派发协议。 |
| 规格 §4.1 | 适用 | 双端各自唯一 AuthorityCommitLog、transfer 逻辑流、投影重建、日志前缀与 commit 发布归入 IR32-04～IR32-18、IR32-30。 |
| 规格 §4.2 | 适用 | manifest/记录基底/内容资产进入既有 ArtifactStore、先资产后引用、共享 digest 保留归入 IR32-09、IR32-11～IR32-14、IR32-17、IR32-34。 |
| 规格 §4.3 | 适用 | transfer、conversation、intent、final、segment 与 activity 流的完整选择/导入归入 IR32-04、IR32-08、IR32-13～IR32-18、IR32-29。 |
| 规格 §4.4 | 适用 | commit 前准备全部派生 delta、一次权威切换与恢复一致性归入 IR32-14～IR32-18。 |
| 规格 §4.5 | 适用 | staging 清理、共享资产保留、tombstone 与 memory 水位恢复归入 IR32-10、IR32-14、IR32-17、IR32-29～IR32-30。 |
| 规格 §5.1 | 适用 | transfer command/result、公开 session/confirmation 请求的严格 envelope 与幂等归入 IR32-02、IR32-04、IR32-21～IR32-26、IR32-33。 |
| 规格 §5.2～§5.6 | 适用（交界） | source freeze 收束 assignment/interaction/final，公开重连补终态且不重复归入 IR32-07、IR32-17～IR32-18、IR32-23～IR32-26；不改现有派发/stream 合同。 |
| 规格 §5.7 | 适用 | current-owner EvidenceRequest verifier 必须先于 journal exact replay、workspace/path 和文件读取归入 IR32-19～IR32-20、IR32-31、IR32-34。 |
| 规格 §6.1 | 适用（交界） | active/queued/confirmation/finality 在 freeze 前达到可判定终态归入 IR32-07、IR32-10、IR32-18。 |
| 规格 §6.2、§6.2b | 不适用 | user/system job 不属于 conversation scope transfer。 |
| 规格 §6.3 | 适用 | prepared→frozen→imported→committed→tombstoned 与 pre-commit aborted 的逐边状态机归入 IR32-04～IR32-18、IR32-39。 |
| 规格 §6.4 | 不适用 | 设备状态与 UncertainResolution 没有被本单元扩写。 |
| 规格 §7 六类覆盖表 | 适用（conversation 行） | 会话状态与会话内容资产的转移/删除/保留分类、环境事实与秘密及非权威缓存不转移归入 IR32-08、IR32-13～IR32-17、IR32-35；全局状态与执行资产不由 conversation transfer 搬运。 |
| 规格 §7 CheckpointEnvelope 与 root activation 块 | 不适用 | 全量加密检查点、恢复根激活、复制回读和 TrustTransition 属第 33～35 单元；当前 manifest/wire/装配必须拒绝提前承载，归 IR32-38 守界。 |
| 规格 §8 | 适用（有限落点） | transfer/evidence/session/confirmation/memory 的生产入口与消费落点归入 IR32-19～IR32-33；其他 S7 入口只做兼容边界。 |
| 规格 §9 | 适用 | 锚点域/本地域会话能力矩阵、失联可用性与收编后能力归入 IR32-15～IR32-28、IR32-31、IR32-37。 |
| 规格 §10、§10.1 | 适用 | staging 拉取、ArtifactStore 写入、memory 消费及恢复不得绕过容量与锁顺序归入 IR32-12、IR32-29～IR32-30、IR32-34。 |
| 规格 §11 | 适用 | 离线新建/恢复、自动收编、冲突/暂态失败、待确认和内部术语净化归入 IR32-21～IR32-28。 |
| 规格 §12 对应总纲不变量 1、4～6、8、11～17及 2～3 的 freeze 交界 | 适用 | identity、幂等、唯一 owner、old-owner fence、strict wire、两根、角色零装配、完成语义、安全、恢复及在途 run 身份/栅栏兼容归入 IR32-02～IR32-39。 |
| 规格 §12 的 job/channel/anchor disaster 专属矩阵 | 不适用 | 不属于当前 conversation 收编；只检查未提前启用或误装配。 |
| 规格 §13 的 transcript、scheduler、rubric 行 | 适用 | segment MemoryFlush、schedule/rubric review 与 current evidence 边界归入 IR32-19、IR32-24～IR32-25、IR32-29～IR32-30、IR32-38。 |
| 规格 §13 的其他模块行 | 不适用 | 当前交付未改变对应模块合同。 |
| 规格 §14 | 不适用 | S1 历史开工清单不是第 32 单元现行合同。 |
| 规格 §15 第 30～32 项 | 适用 | 第 30/31 单元为前置，第 32 项是当前实现与验收，归入 IR32-01～IR32-40。 |
| 规格 §15 第 33～38 项及其专属枚举行 | 不适用 | 后继检查点、迁居、灾难恢复、服务生命周期和发布不得成为当前实现或门禁。 |
| scheduler-architecture.md 当前生产架构、§一及§三现行 schedule authority 合同 | 适用（上游） | 收编后的四类 schedule intent 只能经既有锚点 authority/CAS 和认证确认生效，归入 IR32-24～IR32-26、IR32-37。 |
| scheduler 文档 §二、历史推演与待根治项 | 不适用 | 旧实现分析和 scheduler 专项技术债不是本单元义务。 |
| task-advancement-rubric-architecture.md 页首取证边界、需求区、§0～§3 | 适用（上游） | canonical evidence、会话契约与本地域/锚点角色边界归入 IR32-19～IR32-20、IR32-24、IR32-37。 |
| rubric 文档 §4.1～§4.7 | 适用（搬运/恢复） | SessionState、confirmed snapshot、advancement 生命周期必须随会话完整重建且不成为第二事实源，归入 IR32-08、IR32-13、IR32-37。 |
| rubric 文档 §5.1～§5.6 | 适用（交界） | freeze 收束、resume 快照和 canonical evidence 归入 IR32-07、IR32-19～IR32-20、IR32-26、IR32-37。 |
| rubric 文档 §6～§7 | 适用（有限兼容） | imported awaiting/active/closed advancement 状态、恢复 owner 与退出边界必须保持现行语义，归入 IR32-07～IR32-08、IR32-13、IR32-37；不重做推进执行体或全局预算。 |
| rubric 文档 §8～§10 | 适用 | local-draft、ArtifactRef、intent review、confirmation 与产品显示归入 IR32-08、IR32-23～IR32-28、IR32-37。 |
| rubric 文档 §11～§14 | 适用（有限上游） | 包边界、生产测试拓扑和稳定不变量归入 IR32-31、IR32-37～IR32-39。 |
| rubric 文档 §15、C1～C18 | 不适用 | 历史提交/施工记录不是第 32 单元现行义务；当前接口仅按上游合同消费。 |
| rubric-protocol.md 〇～二 | 适用（上游） | rubric 的稳定资产身份、title/description/content 基础结构必须随 intent 资产完整搬运且不被收编层重解释，归入 IR32-08、IR32-13、IR32-24、IR32-37。 |
| rubric 协议 §三～§六 | 适用（上游） | 通过标准、证据要求、失败处理和运行契约只能由既有 anchor review 校验/消费，收编协调器不得绕过或改写，归入 IR32-24、IR32-37。 |
| rubric 协议 §七、§九 | 适用（上游） | ArtifactRef 闭包、稳定身份、保存态校验与既有资产管线归入 IR32-08、IR32-13～IR32-14、IR32-24、IR32-37。 |
| rubric 协议 §八 | 不适用 | 退出边界、优先级与版本信息是协议扩展点，本单元不得因收编预实现。 |
| rubric 协议 §十 | 适用（负边界） | 收编不得把 rubric 变成执行方案、权限规则或每轮重新确认的协议，归入 IR32-24、IR32-35、IR32-37。 |
| transcript-persistence-and-attention-window-architecture.md 页首 S7 写入边界、§3.1.2～§3.1.5 | 适用（上游） | transcript/run/segment 的权威表示、崩溃恢复、读取和保留边界归入 IR32-08、IR32-13～IR32-17、IR32-29～IR32-30。 |
| transcript 文档 §3.2.1～§3.2.2 | 适用（上游） | 收编会话 resume 必须从 imported transcript/segment 权威基底重建注意力窗口，不得把 source 的瞬态窗口当权威搬运，归入 IR32-13、IR32-22、IR32-28、IR32-37。 |
| transcript 文档 §3.2.3～§3.2.5、§3.3～§3.5 | 适用（直接交界） | segment flush hook、resume 与不变量归入 IR32-26、IR32-29～IR32-30、IR32-37。 |
| transcript 文档信息梳理、§一～§二、§3.0～§3.1.1、分布式 assignment 历史说明 | 不适用 | 形成过程、目录形态与既有 assignment 施工说明不由本单元修改。 |
| lifecycle-concepts.md 维护约定 | 不适用 | 文档维护规则不是第 32 单元产品、架构或验收义务。 |
| lifecycle-concepts.md §一 attention window 与 turn | 适用（术语边界） | imported transcript 只重建派生 attention window，freeze 收束对象不能把单个 turn 或窗口误当完整 run，归入 IR32-07、IR32-13、IR32-28、IR32-37。 |
| lifecycle-concepts.md run | 适用 | source drain 必须等待一次 runtime.run 的完整往返及其资源终态，而不是仅等待最后一次 LLM turn，归入 IR32-07、IR32-18、IR32-32。 |
| lifecycle-concepts.md §二需求与钩子 | 不适用 | 本单元不新增或改写 AgentRuntimeLifecycle 钩子；transfer/review/memory 只消费既有 owner/segment 接缝。 |
| unit-development-workbench.md 静态目标/边界与 D32-01～D32-08 | 适用 | 八项生产、消费、装配、异常/恢复和直接测试义务反向归入 IR32-01～IR32-40。 |
| 当前完整交付物 HEAD 4f843748 与工作树 54 个变化路径 | 事实来源 | 50 个第 32 单元功能路径逐一归入 IR32-01～IR32-40；开发工作台、第 31 单元台账/清单归档及当前审查清单 4 个流程路径明确排除，不参与功能通过判定。 |

### 审查项

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR32-01 | [ ] | 单元身份、边界与完整交付物 | 冻结父提交 4f843748 到当前工作树的 54 个变化路径并二元归属；50 个功能路径必须全部反绑 D32-01～D32-08，4 个流程路径不参与功能判定；不得含第 33～38 单元能力或无依据框架。本项在路径、来源与边界对账完成后停止。 | 待审 |
| IR32-02 | [ ] | transfer 严格判别联合与导出合同 | SourceFreezeProof、ConversationTransferCommit、ConversationTransferManifest、ConversationTransferAbort、TransferRecord、command/result 必须具备唯一 v1 字段集、封闭判别、稳定导出与递归严格 validator；未知/缺失/多余字段、错类型和跨分支组合在副作用前拒绝。 | 待审 |
| IR32-03 | [ ] | 规范摘要、签名与引用反绑 | JCS、schema/version 域、对象身份摘要、ArtifactRef 原始字节摘要、source/target 签名、freezeProofDigest/checkpointDigest/manifestDigest/commitDigest 必须按规格唯一计算并逐引用核对；重签、篡改、错 key/target/version 均 fail-closed。 | 待审 |
| IR32-04 | [ ] | transfer reducer 与状态边 | 双端 transfer:<transferId> 只允许 prepared→frozen→imported→committed→tombstoned 及 commit 前 aborted；prepared 后双端身份、conversation、epoch 和 payload 不漂移；同载荷重放幂等，异载荷、越级、回退、late abort、坏尾恢复零非法状态。 | 待审 |
| IR32-05 | [ ] | 稳定操作身份与请求重放 | requestId、xfer-ULID、source/target device、conversation、sourceOwnerEpoch/nextOwnerEpoch 必须在发起、wire、双日志、恢复和响应中全等；并发同请求、异载荷复用、效果后响应丢失和连续重启不得产生第二 transfer 或 epoch。 | 待审 |
| IR32-06 | [ ] | 源端资格、双方 prepared 与准入线性化 | 仅当前本地域 owner 可把设备前缀全等的 local conversation 收编到已认证当前锚点；双方 prepared 对账后，源日志同一顺序重验会话未删除/无在途 transfer 并耐久关闭 fresh admission；错 owner/目标/epoch/会话在首个副作用前拒绝。 | 待审 |
| IR32-07 | [ ] | freeze 前在途工作收束 | active/queued 的完整 runtime.run（不是单个 turn/attention window）、pending confirmation、interaction、final-outbox、advancement 与资源/finality 必须达到既有可判定终态或明确裁决后才冻结；drain 超时、取消竞态、final 暂态失败和并发新写不得产生假 frozen 或半终态。 | 待审 |
| IR32-08 | [ ] | 完整 conversation-owned 选择器 | manifest 必须覆盖 meta/transcript、run/control/publish/final-outbox、task-list/segment/advancement、session-activity、content-asset-index、intent 及 rubric 资产；共享流逐字段反绑会话，无法归属 fail-closed；GlobalState/job/trust/delivery、秘密、环境事实和缓存零进入。 | 待审 |
| IR32-09 | [ ] | checkpoint、manifest 与窄取件口 | 同一 AuthorityCommitLog 前缀生成 DurableLogCheckpoint、规范 manifest artifact、记录基底和 SourceFreezeProof；checkpointDigest 必须等于 manifest ArtifactRef digest；read port 只允许 proof 绑定目标按声明 ref/range 读取，越范围、任意路径和任意 ArtifactStore 访问均拒绝。 | 待审 |
| IR32-10 | [ ] | 源端 abort、冻结恢复与重入 | 仅 pre-commit 合法 abort 可恢复源端原 epoch 准入并要求目标 staging 隔离清理；frozen 后不得自行重开写，commit 后 abort 恒拒绝；崩溃、网络/响应丢失、重复发起、坏尾和连续重启只从源 transfer 流追平。 | 待审 |
| IR32-11 | [ ] | 目标资格与隔离 staging | target 仅存在于 anchor，且只接受 home 内 active source、正确 local conversation 前缀、source epoch 和无冲突目标/transfer；先落 target prepared，再建 transfer 私有 staging；imported/commit 前 session 目录、owner 查询、intent review 和业务写零可见。 | 待审 |
| IR32-12 | [ ] | 拉取、容量、背压与锁顺序 | target 只经认证 transfer mesh 按 manifest 顺序 probe/range 拉取，分块接收复用 putVerifiedStream、storage governor 与设备唯一 arbiter；容量等待、取消、磁盘满、backpressure 不持 authority/ArtifactStore 锁，不得绕过治理或误报成功。 | 待审 |
| IR32-13 | [ ] | 全量校验与会话读面重建 | imported 前必须全验双端身份、proof、manifest 规范字节、lastLsn、各流计数/摘要、记录基底、全部 ArtifactRef、reducer version 和 source checkpoint；导入记录保持源 envelope 分组、LSN/时间顺序和 exact replay 身份，与目标后继无碰撞、漏序或重复；ConversationRunJournal/SessionState/attention window 只由 manifest+commit 指向的权威记录重建，不产生第二事实源。 | 待审 |
| IR32-14 | [ ] | 部分导入、幂等追平与隔离清理 | 空/大资产、共享 digest、重复/乱序分块、部分导入、响应丢失和连续重启必须从同一 staging 追平；缺件、多列、损坏、错会话/epoch/digest/version 失败封闭；pre-commit abort 幂等清理私有 staging，不污染既有会话或共享资产。 | 待审 |
| IR32-15 | [ ] | 唯一 commit 与不可分可见性 | 仅 imported 全验后由目标签发 ConversationTransferCommit；同一 anchor AuthorityCommitLog 事务唯一切换目录可见性、current owner 与 nextOwnerEpoch，fsync 后投影和不可变历史基底零假阴性、零半套，重启可由 commit→manifest 确定恢复。 | 待审 |
| IR32-16 | [ ] | current-authority resolver 闭包 | conversation admission、run/assignment capability、control/session mutation、intent review、final/history、evidence 和公开 owner-aware route 必须读取同一窄 current-conversation-authority resolver；普通会话保持原 epoch，收编会话取 commit epoch，禁止 anchorEpoch/进程 local epoch 代替。 | 待审 |
| IR32-17 | [ ] | 旧 owner 永久 fencing 与 tombstone | 源端只接受身份/proof/checkpoint 全等的当前锚点 commit；随后 fresh write、exact replay、intent/evidence/control/assignment 能力全部按旧 epoch 拒绝并返回有限重定向；共享 artifact 不误删，释放源引用和 tombstone 可重驱，commit 后只允许更高 epoch 前滚。 | 待审 |
| IR32-18 | [ ] | 双日志 coordinator 与崩溃恢复 | source/target/coordinator 以同 transferId 在各自日志协调；任一 fsync/ACK/网络边界崩溃、双方交错重启、重复往返、tombstone 失败均不得双 owner、丢 owner、重复会话/intent/task revision、资产误删或 epoch 回滚。 | 待审 |
| IR32-19 | [ ] | current-owner evidence verifier 装配顺序 | local ExecutorEvidenceHandler 与 mesh evidence service 两生产根必须注入同一 verifier；每次请求在 EvidenceJournal exact replay、workspace binding/路径解析及任何文件读取前核对 current device、ownerEpoch、conversation 与静态签名绑定。 | 待审 |
| IR32-20 | [ ] | evidence replay、拒绝副作用与读取安全 | 旧 owner fresh 和历史 requestId 均零 journal/workspace/file 读取；current owner exact replay 返回原 bundle，异载荷冲突；错 device/conversation/workspace revision、过期或撤销均稳定拒绝，不泄漏物理路径、文件内容或内部 owner 事实。 | 待审 |
| IR32-21 | [ ] | 第一方 owner-aware 路由与用户同意 | 仅现有第一方 session.new/list/resume、/new、/resume、REPL facade 可进入 owner-aware route；值班设备可达保持原路径，不可达必须先明确说明“继续在这台电脑工作（新对话）”及能力限制并取得显式同意；未知动态方法、渠道或工具不得旁路。 | 待审 |
| IR32-22 | [ ] | local session 新建、查询与恢复 | 失联时只创建/列出/恢复本机 local-<device>-<ULID> 会话；锚点既有会话仍不可写，收编提交后原会话退出 local 可写/候选集合并只按 current owner 路由；错域/未知/已删除/冲突/忙碌具有确定终态；多接入面、响应丢失、重启和 resume 指针切换不得重复会话、双列或串 owner。 | 待审 |
| IR32-23 | [ ] | 自动收编候选与重连恢复 | 唯一 adoption coordinator 只选择当前设备未收编且用户明确同意的 local conversation，稳定复用原 transfer 身份；重连、并发触发、效果后响应丢失和连续重启不得漏收、重复收编或把失败/未完成显示为完成。 | 待审 |
| IR32-24 | [ ] | 收编后 rubric 复核 | commit/安装恢复完成后才调用第 31 单元 internal review；收编层不得自行解析、改写或绕过 rubric-protocol 的保存态校验与运行契约；无冲突 rubric 可由有限 host 自动落定，资产缺失/协议无效/CAS/暂态失败保持可重试且不改 active snapshot；不得开放公开 intent RPC、第二 review 事实源或提前读取 staging。 | 待审 |
| IR32-25 | [ ] | schedule 再确认与权威终态 | 四类 time-sensitive schedule intent 必须绑定当前 authenticated surface、原 intent/mutation/revision 并走现有 ConfirmationHub 和 anchor reducer；错 surface、过期、冲突、响应丢失、terminal replay 和物化失败不得重复 task revision或把 pending 显示完成。 | 待审 |
| IR32-26 | [ ] | observer、待确认重浮现与去重 | session.resume 必须先建立 observer/当前接入面身份再触发 adoption review；confirmation.list、live/history 与 RPC broker 复用同一 pending/decision 事实，连接切换、响应丢失和连续重启恰一次重浮现，不漏帧、不重复确认。 | 待审 |
| IR32-27 | [ ] | 公开结果联合与零术语产品语言 | not-found、busy、invalid、identity/version conflict、temporary failure、adoption/review pending/success 必须映射为稳定、可行动且一致的产品终态；不得泄漏 anchor/owner/epoch/intent/CAS/stream/staging 等内部术语，不得把 provisional/pending/失败说成完成。 | 待审 |
| IR32-28 | [ ] | CLI/REPL 会话旅程完整性 | session facade、controller、commands 和 REPL 的启动 auto-resume、/new、/resume、收编摘要、能力限制与 pending confirmation 必须消费同一公开合同；单机在线行为不退化，多连接目标切换与早到事件不丢失或串会话。 | 待审 |
| IR32-29 | [ ] | post-adoption memory 身份与触发边界 | 只在 ConversationTransferCommit 生效并安装权威 transcript/segment 后补驱动既有 MemoryFlush；operationId 由 conversationId+segment identity+原文/摘要 digest 稳定派生，transferId 不进幂等身份；staging/commit 前和源端生成的全局 memory 零消费。 | 待审 |
| IR32-30 | [ ] | memory 水位、失败与恢复 | 零/单/多 segment、已/未蒸馏混合、同 segment 跨 transfer、并行 intent review、LLM/GlobalState 效果前后失败、响应丢失和 anchor 连续重启必须保留可重建水位并最终追平，既有 segment 不重复 memory revision，后续 turn 沿同一水位继续。 | 待审 |
| IR32-31 | [ ] | 双生产根与角色 exact-set | anchor+executor 与 executor-only/远端 anchor 两根分别只能装配适用的 source、target、coordinator、evidence verifier、public router、review/memory consumer；同机复用正确日志/ArtifactStore/mesh，非 anchor 零 target/global consumer，八种 topology 的角色集合全等。 | 待审 |
| IR32-32 | [ ] | 启动、恢复与关闭顺序 | 启动必须先恢复 transfer 投影、committed authority/历史基底、post-adoption memory/review，再开放 mesh 与公开准入；关闭先拒绝新 transfer/公开写，停止后台但保留未终态耐久事实供重启重驱；不得遗留双 loop 或伪终态。 | 待审 |
| IR32-33 | [ ] | transfer mesh 与 RPC 注册边界 | conversation.transfer 仅通过既有认证 mesh request channel，command/result 严格校验且 receiver/role 有限；session/confirmation 注册表与 local router exact-set 清晰，未知方法、错角色、未认证 source、任意 artifact/path 请求均 fail-closed。 | 待审 |
| IR32-34 | [ ] | S7 结构门禁与真实变异 | 现有单一 S7 gate/golden 必须反绑两根 source/target/coordinator、恢复顺序、current-owner verifier、public session exact-set、post-adoption review/memory 与 future-unit denylist；删除、重复、错角色、错顺序、绕过或新增入口真实变异失败，合法装配零误杀。 | 待审 |
| IR32-35 | [ ] | 安全、最小权限与秘密/路径隔离 | 有限核对 transfer command/result/manifest/read-range、EvidenceRequest/Bundle、session adoption result 与 confirmation list/resolve：只含各自冻结身份和内容引用；秘密、环境事实、绝对路径、任意 workspace、raw repository/ArtifactStore 与 rubric 权限能力不迁移不逸出；签名受众、scope、epoch、deadline、capacity 与 path guard 在该链首次副作用前校验。 | 待审 |
| IR32-36 | [ ] | 资源、并发与容量失败 | 仅核对 transfer 拉取/staging、投影重建和 post-adoption memory 三类新增负载：必须复用既有 governor/arbiter，锁顺序无死锁、等待可取消、并发 single-flight/分页有界，磁盘满、容量不足和资源失败保留可恢复事实且不静默成功。 | 待审 |
| IR32-37 | [ ] | 有限上游与既有产品兼容 | 两种部署形态完成同一核心旅程；普通锚点/本地域会话、在线 session.new/list/resume、confirmation.list/resolve、advancement resume/evidence、segment MemoryFlush 与现有 mesh 请求是有限回归集合；schedule/rubric、transcript/segment、SessionState、ArtifactStore、EvidenceJournal、ConfirmationHub 和第 31 单元 intent seam 只按现行合同消费，不增加渠道宿主、公开 intent 或全局写能力。 | 待审 |
| IR32-38 | [ ] | 架构、规格、wire 与后继边界同步 | 总纲 §9/§14、规格 transfer DTO/TransferRecord/§3.2b/§6.3/§15、core exports、session wire 与生产调用图必须全等；历史段保持非现行，AnchorTransferCommit、CheckpointEnvelope、TrustTransition、ReadyProof、灾难恢复和服务生命周期均未被当前 wire/装配接受。 | 待审 |
| IR32-39 | [ ] | 成比例的直接验收证据 | 证据计划必须覆盖 strict codec/digest/签名与 §6.3 第 1～8 行、真实双日志 source/delete/write 竞争、target staging/容量/损坏/恢复、commit/fencing/evidence 读取 spy、两生产根公开开箱/失联继续/重连收编/异常恢复四时刻、review/confirmation/memory 故障和 S7 真实变异；八配置只验证 exact-set，不做配置×故障笛卡尔积。 | 待审 |
| IR32-40 | [ ] | 来源、D32 义务与路径反向闭包 | D32-01～D32-08、全部适用来源条款及 50 个功能路径必须按 core 合同/协议与 memory hook、owner-kernel transfer/assignment/manager、CLI transfer/assembly、current-owner evidence、server/RPC/session/confirmation、CLI 会话体验、架构规格同步、S7 门禁与直接测试九组逐一归入 IR32-01～IR32-39；每组有生产端、消费端、共享原语、装配、正常/异常/恢复和直接证据落点，每条实现有当前架构依据；不存在未判定来源、遗漏、重复、越界或以测试存在代替功能判断。 | 待审 |

> 本清单只定义第 32 单元独立审查范围和证据要求；40 项均为 [ ]，尚未执行任何审查，不代表当前交付已经通过。

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
