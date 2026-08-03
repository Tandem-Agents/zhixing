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

### 2.2 审查“独立审查清单”

```
审查“独立审查清单”中的审查点，范围是否满足“全部通过就可提交”的要求，坚决不能出现全部通过，但是还有遗漏问题的情况。
同时范围不能超过本单元边界；有问题统一告诉我；
满足“审查清单定稿条件”立即停止；
```

#### 目标模式：审查并定稿“独立审查清单”

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

### 2.3 执行独立审查

```
完整读取当前单元的权威架构、单元边界、当前完整交付物及已定稿的“独立审查清单”，以清单当前状态确定本轮范围。开始时若仍存在 `[!]`，说明阻断问题尚未完成转存、修复或状态更新，立即停止并报告；否则审查全部 `[ ]` 和 `[~]` 项，直接复用 `[x]` 项，禁止重复审查。

逐项完成本轮应审内容，不得跳项、合并或因发现问题提前结束；只报告基于事实的真实问题，审查期间不得修改实现。每完成一项，立即更新状态、证据和当前进度：存在 P0/P1 时标为 `[!]`；不存在 P0/P1 时标为 `[x]`，P2/P3 不改变该项通过状态。

审查期间不登记问题列表。全部应审项完成后，统一分析本轮发现的问题，将同一根因及其上下游影响合并为一个问题，避免重复登记表象。P0/P1 写入“P0/P1 阻断问题列表”；P2/P3 写入“非阻断级问题列表”，并写明问题、影响、最优解决方案、工作量和评级。全部审查项为 `[x]` 且 P0/P1 为空时，判定独立审查通过。
```

#### 对抗复核问题价值

```
站在与上一轮审查结论对立的位置，对本轮发现的每个问题重新进行价值裁决。不得沿用原问题的评级、方案或“既然发现就必须解决”的前提；举证责任在主张当前处理该问题的一方。

逐项从当前产品目标、单元边界和生产事实独立判断：问题是否真实且命中根因；不处理会在哪个受支持场景造成什么具体后果；该后果是否阻断当前最小完整产品、破坏核心体验或违反必要合同；现在解决能获得什么实际价值；是否属于当前单元。未来可能、理论不完美、单纯增加完整性或已有文字要求，均不能单独证明当前处理的必要性。

按“保持现状或后置 → 修正规则或要求 → 复用现有机制 → 最小完整修复 → 新增能力或基础设施”的顺序比较方案。选择成本更高的方案前，必须用事实排除前面的选项；方案不得以解决问题为名扩张产品范围或制造超过问题价值的复杂度。

重新核定评级、工作量和方案。P0/P1 或大工作量只有在当前具体损失、处理必要性和方案比例性全部成立时才能保留。对每个问题固定输出：事实与根因、当前损失、不做的后果、处理价值、范围归属、最小完整方案、评级与工作量、最终结论（保留／降级／后置／改写／删除）。随后合并同根问题并同步修正本轮两类问题列表。

凡裁决导致问题事实、根因、影响、范围、评级、工作量、方案或处置结论发生变化，必须在问题描述中追加“价值裁决记录”，写明原结论、推翻或收窄它的事实、新决定及重开条件。不得修改实现；全部问题完成价值裁决后立即停止。
```

#### 复核范围收敛是否误伤产品体验

```
我有一个担心：我们进行这次审查，是为了控制范围，避免无限扩张导致规模失控；根本目标仍然是围绕架构总纲，向用户提供具有优秀产品体验的功能。可以砍掉越界、低价值或过度实现，但不能砍掉用户体验。请重新判断当前最新版本是否同时满足这两个目标；有问题统一说明，没有问题直接简要回复。
```

### 2.4 将审查问题转入问题列表

```
先读取《单元审查与修复工作台》的静态规则。若本单元尚未登记，按其中“单元状态与登记协议”完成登记并更新当前单元指针；随后读取本单元文件中“问题列表”的维护规则、字段与状态约定。

将本轮独立审查登记在《单元独立审查工作台》“P0/P1 阻断问题列表”和“非阻断级问题列表”中的全部问题，转入《单元审查与修复工作台》当前单元正式文件的“问题列表”。写入前，先读取目标“问题列表”的维护规则、字段与状态约定，并严格按其格式登记。

每个根因只保留一行；与已有问题同根时更新原记录，不得重复新增。每行必须写齐事实与证据、根本原因、完整影响面、受影响审查项、最优解决方案与验收条件、状态，并保留问题等级和工作量判断。

源问题包含“价值裁决记录”时，必须将其完整转入，并以裁决后的事实、评级、工作量、方案和结论更新目标记录；不得让目标中的旧记录覆盖裁决结果，也不得恢复裁决已经否定的主张、评级或方案。只有源记录写明的重开条件已被新生产事实或范围变化满足时才可恢复，并须同时写入触发重开的事实与证据。

最优解决方案必须面向执行者，用最少的文字说清改什么、怎么改、关键边界以及做到什么算完成；不得长篇大论，也不得省略他人直接执行所需的具体步骤。

确认全部问题完整写入后，删除两个独立审查问题列表中的原记录，禁止两处重复维护。不得修改实现；完成转移与一致性核对后立即停止。
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
目标：只收敛第 26 单元正式问题列表中的 U26-07～U26-08 两个 P1 和 U26-09～U26-10 两个 P2，使每项都真正命中根因，并具备可由执行者直接实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 26 单元正式文件中的四项问题，只依据正式文件的耐久状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U26-07 → U26-08 → U26-09 → U26-10` 逐项重建事实链，判断当前描述是根本原因还是表象，并核准事实证据、完整影响面、受影响审查项、评级和工作量；同根内容必须合并，独立根因不得相互遮蔽。
2. 以“首席产品官 + 乔布斯”直觉和最优架构标准审查方案：从唯一所有权、单一事实源、线性化点、恢复机制和真实产品体验根治，不得逐点打补丁、制造第二语义或留下已知债务。
3. 每项方案必须用最少文字说清改什么、怎么改、关键边界及完成判据，让执行者无需实现猜测即可一次完成。发现缺口时直接修正原问题行，只复审变化项及受其影响的结论。
4. 四项均看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：手动 surface 恢复与唯一生命周期所有权、missed 汇总的启动并发与崩溃恢复、公开通知的产品语言与可行动性、终态事件驱动的资源释放与非阻断价值边界；同时核查 `U26-07↔U26-10` 和 `U26-08↔U26-09` 的直接交界。各路不得沿用前轮结论；发现反证则修正原问题并重新复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；四项事实均被根因完整解释，影响面无遗漏，最优方案和验收条件可直接执行，不会再因同根残留导致局部返工。满足后明确回复“四项问题的根因与最优方案已闭合”并立即停止。
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
目标：彻底解决第 26 单元 U26-07～U26-08 两个 P1 和 U26-09～U26-10 两个 P2，闭合其当前登记事实及同根残留；不得扩展到其他问题或全单元流程。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 26 单元正式文件中的 U26-07～U26-10，只依据正式文件的最新根因、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前先抛开现有问题描述和验收条件，从权威架构、规格与当前生产调用图反向推导四项必须闭合的完整功能链、状态组合和交界，形成固定核查矩阵；每项至少明确生产入口、唯一 owner、耐久事实与线性化点、消费终态、重试/崩溃恢复、生产装配和直接交界，并绑定当前源码事实。按依赖顺序 `U26-10 → U26-07 → U26-08 → U26-09` 完成内部生命周期信号与资源退役、手动 surface 恢复、missed 汇总必达和公开通知分层及直接相关测试。同根残留并入原问题，禁止新增表象问题或逐点打补丁；不得扩建通用事件总线、session registry、文案系统、监控或诊断设施。每项和每个阶段完成时立即更新正式文件的状态与证据，续跑只恢复未完成部分。
2. 按验证手册运行受影响包的必要测试；失败先归因，实现问题直接修复并回到第 1 步。不得新增或运行非必要 benchmark、信息采集或与四项验收无关的验证设施。
3. 记录并冻结当前交付物指纹，按第 1 步矩阵逐格从当前架构和源码重建事实链；矩阵必须覆盖四项完整功能链、各自全部验收条件，以及 `U26-07↔U26-10` 的 opening、job 终态、assignment 退役与资源释放，`U26-08↔U26-09` 的 missed 汇总、公开通知和补读投影。测试通过不得代替功能判断；整轮只读且不得因发现残留提前结束，矩阵全部完成后才统一归并。
4. 专项功能审查通过后，对该指纹执行四个相互隔离的冷启动对抗角色：手动 surface 恢复与唯一生命周期所有权、missed 汇总的启动并发与崩溃恢复、公开通知的产品语言与可行动性、终态事件驱动的资源释放与非阻断价值边界。每个角色都必须抛开已有问题描述、验收条件、实现说明、测试结果和其他角色结论，先独立从权威合同与当前源码推导应有闭包，再与固定矩阵双向对账，并完整覆盖四项及其交界；每项都须主动构造适用的重复、错绑、半提交、断线/停机、崩溃恢复、opening/closing 竞争和装配缺失反例，不适用者写明源码事实。每完成一格立即把事实链、反例和结论耐久写入正式文件后才能继续；未落盘、漏项、只审角色擅长分区、沿用既有范围或缺少事实证据的“无问题”均不计完成。
5. 所有发现首次出现时立即以稳定编号写入反证账，不得等整轮结束或依赖对话记忆。每轮机械取专项审查、四路记录及历轮反证的并集，并在收口前对各轮、各角色结果执行差异审计：任何曾出现而本轮未出现的发现，都必须逐条标明“同根合并”“当前源码证伪”或“修复后复核通过”及证据；不得因后一次发现更少、用户重发提示词或多数角色未发现而消失。发现真实反证时，先扩充固定矩阵并修正对应原问题的事实、根因、影响面、最优方案和验收条件，再将受影响项退回“待验证”并回到第 1 步；不得直接形成局部补丁。任何交付物修改都会使指纹、核查矩阵和四路对抗结论全部失效，必须在受影响包测试完成后重新执行。

结束条件：同一冻结指纹上的 U26-07～U26-10 四项方案全部落地，受影响包测试通过，专项功能审查和四路冷启动对抗角色均留下完整、可归并的核查矩阵；差异审计无未处置发现，累计反证全部有耐久记录并被当前源码事实证伪或修复后复核通过；四项均已更新为“已验证”。满足后明确报告“四项问题已彻底解决”并立即停止；不得进入全单元终审或最终验证。
```

## 审查清单

### 当前状态

- **当前单元**：第 27 单元 · generation 1
- **架构来源**：分布式运行时总纲与可执行规格；任务推进闭环架构与 Rubric 协议；运行体生命周期、对话/接入面、确认交互、注意力窗口与 workscene 直接上下游合同；持续在线/本地执行与 S2 安全供应链约束；第 14、15A、15B、18、20、23、25、26 单元冻结合同、适用排除项与迟发现教训；第 27 单元定稿开发清单
- **交付基线**：HEAD `d4cce198` 至当前完整工作区的 77 个非工作台路径，删除 0；CLI 20、core 21、orchestrator 11、owner-kernel 8、owner-services 8、rpc 1、server 6、架构与规格 2
- **交付指纹**：`git-delivery-manifest-v1:b4ee0dc42c08770608a6270c6f62e3eb517e9ccc6a8b1fb3cb82f82f1b01a176`；路径集 SHA-256 为 `f8a3841de3e162785c1cd046344f2073914155fe7a9ad80fb45bbe188c99a005`；指纹只作范围证据，不建立为审查项
- **目标提交边界**：第 27 单元（S7）advancement 与独立取证的生产实现、直接相关测试，以及同步修订的推进架构与分布式运行时规格
- **当前任务进度**：0%（0 / 45 项完成；45 项 [ ]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：第 27 单元独立审查清单已按当前 77 路径交付闭包完成来源、功能链、生产装配与交付路径、范围价值四路冷启动对抗复审并定稿；尚未执行独立审查，45 项均从 `[ ]` 开始，不复用开发验证结果。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| --- | --- | --- |
| distributed-runtime-charter.md 当前版本交付原则、背景 | 适用 | 最小完整产品、持续在线、本地真实执行、单机/分布式平权与优秀产品体验归入 IR27-01、IR27-28～IR27-32、IR27-35～IR27-40。 |
| distributed-runtime-charter.md §1～§3 | 适用 | 锚点与 conversation owner 权威、executor 完整运行体、owner-services/owner-kernel/orchestrator/CLI 包边界归入 IR27-04～IR27-05、IR27-08、IR27-28～IR27-30、IR27-37。 |
| distributed-runtime-charter.md §4 | 部分适用 | 设备身份、签名凭证、SecretStore 和短租约适用于取证信封与 mesh，归入 IR27-02、IR27-13～IR27-19、IR27-23、IR27-34；本单元不改变配对、信任链和密码学选型。 |
| distributed-runtime-charter.md §5～§6 | 适用 | advancement 会话状态随 conversation owner、Rubric 库归锚点、证据资产与控制/数据流单源归入 IR27-04～IR27-05、IR27-15～IR27-27、IR27-33～IR27-36。 |
| distributed-runtime-charter.md §7 | 适用 | EvidenceRequest/Bundle、ObservationToken、PathGuard、workspace revision、独立 provider 与 review 子租约全部归入 IR27-13～IR27-25、IR27-33～IR27-35。 |
| distributed-runtime-charter.md §8 | 部分适用 | owner 控制与 executor 只读取证、local/mesh 只换 transport 不换语义归入 IR27-15～IR27-25、IR27-30、IR27-34；run stream、渠道确认与 job relay 不因本单元重开。 |
| distributed-runtime-charter.md §9 | 部分适用 | local-draft 立即生效、全局 Rubric 沉淀延后合同适用，归入 IR27-26～IR27-27、IR27-32；本地域 owner、DeferredGlobalIntent 耐久流、收编与 AuthorityTransfer 由第 30～32 单元承载，IR27-01、IR27-36 防止提前启用。 |
| distributed-runtime-charter.md §10 | 部分适用 | owner/executor 角色启动、恢复、停机与未启用角色零副作用归入 IR27-28～IR27-31、IR27-33；托管、升级和发布由第 36～38 单元承载。 |
| distributed-runtime-charter.md §11 | 适用 | 用户只感知任务、确认、推进、缺口和收场，不暴露拓扑/租约/绑定术语，归入 IR27-06～IR27-12、IR27-26～IR27-27、IR27-32、IR27-38～IR27-40。 |
| distributed-runtime-charter.md §12 故障矩阵 | 部分适用 | owner/executor 崩溃、响应丢失、重复/迟到、旧 epoch、断网重连、日志坏尾、磁盘满、版本/能力漂移、停机竞争归入 IR27-04、IR27-09～IR27-25、IR27-30～IR27-35；AuthorityTransfer、锚点永久丢失与 S9 恢复行不适用。 |
| distributed-runtime-charter.md §12 安全对抗矩阵 | 部分适用 | 伪签、错 scope/audience/ownerEpoch/executor/workspace/review/run、过期、重放、PathGuard、权限/资源凭证不可替代及原始 surface 确认归入 IR27-05、IR27-07、IR27-13～IR27-25、IR27-32、IR27-34；配对短码、MITM 与渠道 token 不因本单元重开。 |
| distributed-runtime-charter.md §13 不变量 1～18 | 部分适用 | 1→IR27-04/05/28/41；2→IR27-09/36；3→IR27-18/30/34；4→IR27-26/27；5→IR27-28～30；6→IR27-23/34；7→IR27-16/18/20～23/34；8 由第 30～35 单元承载且归 IR27-01/36 排除；9→IR27-10/12/17/33；10→IR27-04/12/17/19/33/41；11→IR27-02/13～18/23/34；12→IR27-28～30/36；13→IR27-11/32/40；14→IR27-28～30/37；15→IR27-09/36；16→IR27-07/10/32/34/40；17→IR27-05/28/32/37～40；18→IR27-13/14/35。 |
| distributed-runtime-charter.md §14 | 适用 | S7 第 27 单元依赖顺序、前置冻结能力和后继不得提前开放归入 IR27-01、IR27-28～IR27-31、IR27-36～IR27-37。 |
| distributed-runtime-charter.md §15 | 部分适用 | 结构、适用故障/安全和推进产品体验验收归入 IR27-32～IR27-41；本单元没有量化 benchmark 或性能采集门禁，IR27-01、IR27-35、IR27-37 防止引入非必要设施。 |
| specification.md §1 | 适用 | EvidenceRequest/Bundle/ObservationToken、AdvancementAdmissionDecision/Draft/Review/Proxy/Attribution、AdvancementControlEvent/Snapshot、Rubric source、规范字节、摘要域、签名和错误形态归入 IR27-02～IR27-03、IR27-15、IR27-18～IR27-24、IR27-34、IR27-38～IR27-41。 |
| specification.md §2 | 部分适用 | owner/evidence principal、短租约、ResourceLease 与签名验证适用，归入 IR27-05、IR27-13～IR27-19、IR27-23、IR27-34；配对、SecretStore 迁移和 mesh bootstrap 不改。 |
| specification.md §3.1 | 适用 | SessionStatePort 的 readAdvancementState 与 advancement-event 写、AuthorityCallContext 和 host-only guard 归入 IR27-04～IR27-05、IR27-12、IR27-28、IR27-41。 |
| specification.md §3.2 | 部分适用 | Rubric asset index、rubric save/update、ArtifactRef 与 GlobalState guard 适用，归入 IR27-26～IR27-27、IR27-34；其他全局资产写不在本单元。 |
| specification.md §3.2b | 部分适用 | 本单元只消费 DeferredGlobalIntentPort 合同 fake 并验证离线提示，归入 IR27-27、IR27-32；intent 流、生产本地域装配、收编和重校验由第 30～32 单元实现。 |
| specification.md §3.3 | 适用 | EnvironmentPort、CapabilityDescriptor.evidenceCapabilities、workspace binding/revision 与无 workspace 语义归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-34。 |
| specification.md §3.4～§3.4b | 适用 | advancement control 根、evidence 子租约、UsageReport/intake 与 workload-advancement 物理 permit 归入 IR27-13～IR27-14、IR27-18～IR27-19、IR27-29、IR27-35。 |
| specification.md §3.5 | 适用 | ControlCompletionPort 与完整领域输入的 AdvancementReviewerPort、reviewer 不写权威状态归入 IR27-08、IR27-13、IR27-28。 |
| specification.md §3.6～§3.7 | 部分适用 | 被审 accepted run、run 所有权、资源水位与 existing submission 事实作为 review 输入归入 IR27-09、IR27-13～IR27-17、IR27-24、IR27-36；本单元不改变普通 run 派发/提交协议。 |
| specification.md §3.8 | 适用 | advancement-event 仅 host、rubric 全局写的 principal/revision 守卫归入 IR27-05、IR27-27、IR27-34。 |
| specification.md §4.1～§4.2 | 适用 | advancement 逻辑流、单一 AuthorityCommitLog、ArtifactStore 先内容后引用、可重建投影与内容可见性归入 IR27-04、IR27-12、IR27-17、IR27-19、IR27-26～IR27-27、IR27-33～IR27-35。 |
| specification.md §4.3 | 适用 | AdvancementStoreEvent 十三分支、evidence_requested/result/settled、被审 RunRecord 与会话删除分类归入 IR27-04～IR27-12、IR27-15、IR27-17、IR27-24、IR27-33、IR27-36、IR27-41。 |
| specification.md §4.4～§4.5 | 部分适用 | advancement 原子复合状态、投影恢复、归因随 review/proxy 耐久、证据 journal 终态保留和 pending 不回收归入 IR27-04、IR27-09～IR27-12、IR27-17、IR27-19、IR27-33、IR27-35、IR27-39、IR27-41；普通 staged publish 不改。 |
| specification.md §5.1 | 部分适用 | first-party 任务准入、advancement invocation、requestId/ingress、原 turn/draft 身份与取消交界归入 IR27-06～IR27-10、IR27-32、IR27-36、IR27-40；scheduler/job 控制入口不改。 |
| specification.md §5.2～§5.6 | 部分适用 | accepted run、每 run 验收条件瞬态注入、source/ingress 所有权、取消/terminal、stream/final 只作推进 review、proxy 和恢复输入，归入 IR27-09～IR27-12、IR27-24、IR27-33、IR27-36、IR27-38～IR27-40；assignment/job 数据面合同不重做。 |
| specification.md §5.7 | 适用 | EvidenceRequest/ObservationToken/EvidenceBundle 全字段、executor journal、stale≤2 与 capability-gap 归入 IR27-02、IR27-14～IR27-25、IR27-33～IR27-35。 |
| specification.md §6.1 | 部分适用 | conversation accepted/committed/cancelled/failed/expired 与响应丢失只作为推进触发、代理收束和恢复交界，归入 IR27-09～IR27-12、IR27-33、IR27-36；36 行状态机不被本单元重写。 |
| specification.md §6.2～§6.2b | 不适用 | user/system job 状态机由第 26 单元完成，本单元不让 advancement 或 evidence 复用 job/assignment 入口；IR27-18、IR27-29、IR27-36 证明隔离。 |
| specification.md §6.3 | 不适用 | AuthorityTransfer 的生产实现由第 32～35 单元承载；本单元只把 advancement 流登记为随会话转移分类，归入 IR27-04、IR27-36。 |
| specification.md §6.4 | 部分适用 | 结果不明不得自动重执行与 typed capability-gap 诚实呈现适用，归入 IR27-09～IR27-12、IR27-17、IR27-25、IR27-32；设备迁居裁决不适用。 |
| specification.md §7 | 适用 | 会话删除连带 advancement、advancement 随 owner、Rubric 全局权威、evidence executor 本地事实归入 IR27-04、IR27-12、IR27-16、IR27-26～IR27-27、IR27-36。 |
| specification.md §8 | 适用 | 推进确认/修订/取消/详情、owner Completion/Reviewer 与取证落点归入 IR27-06～IR27-12、IR27-15～IR27-32、IR27-38～IR27-40。 |
| specification.md §9 | 适用 | 锚点域/未来本地域 advancement 等价、local-draft 立即生效和全局沉淀延后归入 IR27-26～IR27-32、IR27-36；本单元不开放离线本地域生产。 |
| specification.md §10 | 适用 | advancement/control/evidence 的租约层级、公平准入、settle/release、intake 与设备 permit 归入 IR27-13～IR27-14、IR27-18～IR27-19、IR27-29、IR27-35。 |
| specification.md §11 | 部分适用 | 推进确认、进度、缺证据、目标离线、deferred、接管和收场产品语言归入 IR27-06～IR27-12、IR27-25～IR27-27、IR27-32、IR27-39～IR27-40；配对、迁居与恢复旅程不适用。 |
| specification.md §12 | 部分适用 | 十八条机械口径按 charter §13 映射；本单元新增 codec/record/provider/adapter/guard 的真实 producer、拒绝零副作用、reopen/recovery 和拓扑证据归入 IR27-02～IR27-05、IR27-13～IR27-25、IR27-28～IR27-41；无关 job/transfer 行不重跑。 |
| specification.md §13 | 适用 | task-advancement-rubric-architecture.md 与本规格的同步、公开合同和下游一致性归入 IR27-37。 |
| specification.md §14 | 不适用 | S1 开工基线已经完成，不形成第 27 单元新增义务；包边界回归由 IR27-28、IR27-37 承载。 |
| specification.md §15 | 部分适用 | 第 27 项全部目标/验收归入 IR27-01～IR27-45；第 15A、15B、18、20、23、25、26 项作前置回归，第 28～38 项明确排除。 |
| always-online-and-local-execution-requirements.md §1 | 适用 | “持续在线且进入真实工作环境”的核心问题是本模块产品目标，归入 IR27-01、IR27-16、IR27-28～IR27-32。 |
| always-online-and-local-execution-requirements.md §2 | 不适用 | 本章明示为未经核实的第三方回复整理，不构成项目事实、架构要求或提交门禁。 |
| always-online-and-local-execution-requirements.md §3 | 不适用 | OpenClaw 外部现状核验仅为调研事实，不规定知行第 27 单元交付；本单元不得据此增加竞品对齐事项。 |
| always-online-and-local-execution-requirements.md §4 | 不适用 | 架构者对竞品机制的复核用于否定外部推断，不是独立规范来源；知行的正式义务已由总纲与规格承载。 |
| always-online-and-local-execution-requirements.md §5 | 不适用 | 本章是竞品能力现状归纳，不产生第 27 单元实现或审查义务。 |
| always-online-and-local-execution-requirements.md §6 | 部分适用 | 单机与常驻锚点两种形态平权、本机接入不绕远端及既有业务需求保持不变，归入 IR27-28～IR27-32、IR27-36；未来桌面客户端不在本单元。 |
| always-online-and-local-execution-requirements.md §7 | 部分适用 | 智能体持续在线、环境任务诚实等待且恢复、单机用户不承担分布式代价归入 IR27-16～IR27-17、IR27-25、IR27-28～IR27-32；普通提醒/定时/通知能力不因本单元重开。 |
| s2-security-supply-chain-review.md 裁决、强制门禁、接受依据 | 部分适用 | 既有受管安全依赖、精确锁版与零旁路规则归入 IR27-34、IR27-37；当前 77 路径不含依赖或锁文件变化，不重开库选型与供应链建设。 |
| task-advancement-rubric-architecture.md 需求区、§0～§3 | 适用 | 任务/问题边界、球员/裁判隔离、一次确认、标准公开/程序私有/验证独立、结构化归因、独立窗口、owner 拓扑和范围归入 IR27-01、IR27-06～IR27-08、IR27-28、IR27-32、IR27-38～IR27-40。 |
| task-advancement-rubric-architecture.md §4.1～§4.7 | 适用 | admission/session/draft/confirmed/review/proxy/归因/权威事件模型逐项归入 IR27-02～IR27-12、IR27-24～IR27-27、IR27-39、IR27-41。 |
| task-advancement-rubric-architecture.md §5.1～§5.6 | 适用 | 用户输入、契约确认、run 瞬态契约注入、accepted 后 review、代理续推与中间态恢复逐项归入 IR27-06～IR27-12、IR27-15～IR27-17、IR27-24～IR27-25、IR27-31～IR27-33、IR27-38～IR27-40。 |
| task-advancement-rubric-architecture.md §6 | 适用 | 独立裁判、一级独立取证、canonical evidence、transient/结论性失败分流归入 IR27-08、IR27-15～IR27-25。二级执行测试/构建明确不适用，归 IR27-01、IR27-37。 |
| task-advancement-rubric-architecture.md §7 | 适用 | 完成、死胡同、风险/成本退出、用户接管、收场交付、逐条归因矩阵与契约再生归入 IR27-10～IR27-12、IR27-25、IR27-32、IR27-39～IR27-40。 |
| task-advancement-rubric-architecture.md §8 | 适用 | Rubric 全局资产、会话不可变快照、local-draft 与延后沉淀归入 IR27-03、IR27-26～IR27-27。 |
| task-advancement-rubric-architecture.md §9 | 适用 | 执行侧/推进侧窗口与 cache 隔离、run 注入不污染落盘原文/窗口/cache prefix、恢复折叠态不成为第二事实源归入 IR27-08～IR27-12、IR27-35～IR27-36、IR27-38。 |
| task-advancement-rubric-architecture.md §10 | 部分适用 | contract draft/confirmed/cancelled/failed→IR27-06～IR27-07/40；run reviewed/review deferred→IR27-09/25/40；proxy enqueued/recovered→IR27-10/12/39/40；completed/exited→IR27-11/39/40；recovery failed→IR27-12/31/40。确认重量与折叠层级、详情/归因、插话反馈、awaiting 恢复及零拓扑术语归 IR27-39～IR27-40；渠道里程碑批量是未来投影原则，本单元不实现、不形成门禁。 |
| task-advancement-rubric-architecture.md §11 | 适用 | core/orchestrator/owner-services/owner-kernel/server/CLI 唯一落点与禁止 ConversationManager 内嵌语义归入 IR27-28～IR27-30、IR27-37。 |
| task-advancement-rubric-architecture.md §12 | 部分适用 | 历史提交索引仅作现状溯源，不形成按提交号的验收；其揭示的现有功能由 IR27-06～IR27-12、IR27-32、IR27-36 回归。 |
| task-advancement-rubric-architecture.md §13 | 适用 | core/运行体/控制器/集成、事件结构闭包与产品旅程测试拓扑归入 IR27-02～IR27-12、IR27-15～IR27-32、IR27-37～IR27-41。 |
| task-advancement-rubric-architecture.md §14 不变量 1～17 | 适用 | 1→IR27-06/32/40；2→IR27-07/09/40；3→IR27-03/07/38；4→IR27-38/39；5→IR27-10/39/40；6→IR27-08/18/28；7→IR27-11/35/40；8→IR27-10/11/39；9→IR27-08/12/35/38；10→IR27-38；11→IR27-07/32/40；12→IR27-06/32；13→IR27-15～IR27-25；14→IR27-06/07/10/40；15→IR27-38；16→IR27-08/12/13/25/33；17→IR27-03/06/26/27。 |
| task-advancement-rubric-architecture.md §15、C1～C18 | 部分适用 | C1→IR27-02/03/26/27；C2→IR27-07/32/40；C3→IR27-02/04/05/09/39/41；C4→IR27-06/07/38/40；C5→IR27-07/32/40；C6→IR27-08/13～25/39；C7→IR27-09～11/39/41；C8→IR27-10/12/39/40；C9→IR27-12/31～35/40；C10→IR27-15～25/29/30/33～35；C11→IR27-11/32/39/40；C12 的准入/会话投影→IR27-06/28/32，历史延迟观测不形成当前 benchmark/采集门禁；C13→IR27-04/12/37/41；C14→IR27-02/03/08/25/38/39；C15→IR27-06/26；C16→IR27-08～12/33/39；C17→IR27-07/11/39/40；C18→IR27-06/26/40。提交号和已完成轮次只是历史，不能代替当前证据。 |
| rubric-protocol.md §0～§2 | 适用 | Rubric 定位、场景复用、id/title/description/content 严格结构归入 IR27-03、IR27-06～IR27-07、IR27-26。 |
| rubric-protocol.md §3～§5 | 适用 | 通过标准、required/optional 证据、failureHandling 与变量格式归入 IR27-03、IR27-08、IR27-15、IR27-24～IR27-25、IR27-38～IR27-39。 |
| rubric-protocol.md §6～§7 | 适用 | 用户确认后的不可变运行契约、执行侧公开面和全局库归属归入 IR27-03、IR27-07～IR27-12、IR27-26～IR27-27、IR27-38。 |
| rubric-protocol.md §8～§9 | 适用 | 扩展字段、严格校验、非法 schema 和运行期消费归入 IR27-02～IR27-03、IR27-06～IR27-08、IR27-25～IR27-27。 |
| rubric-protocol.md §10 | 适用 | 不把 Rubric 做成 Skill/Rule/工作流、不过度建模任务类型与执行策略归入 IR27-01、IR27-03、IR27-37。 |
| unified-core-and-access-surfaces.md §1～§3 | 部分适用 | 单一 core/单一 conversation owner、接入面平权且只作薄入口、会话 RPC 双通道与 CLI/server 共用权威归入 IR27-04～IR27-05、IR27-28、IR27-30～IR27-32、IR27-37、IR27-40；通道 screen 同步、热插拔与通用宿主控制未被本单元修改，不形成门禁。§4 是既有实施计划，不新增规范义务。 |
| agent-runtime-lifecycle.md §1～§8、§10～§11 | 部分适用 | 装配期注册、`onBeforeRun.injectUserContext` 唯一 run 前入口、贡献式发送视图拼装、system/tools/cache 边界、主/工作运行体一致性及失败隔离归入 IR27-28、IR27-31、IR27-33、IR27-35、IR27-38、IR27-40；其他 hook 未被本单元改变。§9 的 skill 消费者、§12～附录的历史实施/开放项不属于本单元。 |
| transcript-persistence-and-attention-window-architecture.md §3.1～§3.2、§3.5 | 部分适用 | accepted run 先耐久、窗口只经 accept/reset 前进，以及注入只进入当前 run 发送视图、持久化与窗口用户消息恒为原文、不产生第二事实源归入 IR27-09、IR27-12、IR27-33、IR27-35、IR27-38；分片、GC、bootstrap、compact 与历史迁移实现未被本单元重开。其余章节为由来、落点和既有实施序列，不产生新增门禁。 |
| context-architecture.md §2、§5、§12、§15 | 部分适用 | 默认路径不增加额外 LLM 调用、CLI/server 同构、静态 cache prefix 不因每 run 注入漂移、动态贡献不落秘密且只进入合法发送视图归入 IR27-28、IR27-32、IR27-34～IR27-35、IR27-38；旧窗口驱逐、budget/compact、场景分类和未来工具增强已由后续窗口架构接管或未被本单元修改，不形成门禁。其余章节为既有上下文实现与历史 ADR。 |
| conversation-model.md §2～§5、§7～§9、§11～§12 | 部分适用 | Conversation 唯一事实源、任一对话至多一个 Session、turn 接受/持久化、CLI/server 生命周期、transcript 原文、恢复可见性和鉴权 RPC 投影归入 IR27-04～IR27-12、IR27-28、IR27-31～IR27-33、IR27-38～IR27-40；通道实现、scheduler/background、管理 CRUD 和历史实施路线未被本单元重开。§1/§14～§15 为术语/决策索引，适用结论已由上述章节承载。 |
| server-gateway.md §5～§6、§10 | 部分适用 | 已认证 JSON-RPC、conversation send/event 关联、入站只经 Conversation owner、同一 Agent Loop 与网络安全边界归入 IR27-05～IR27-12、IR27-28、IR27-31～IR27-32、IR27-34、IR27-37、IR27-40；通道 adapter、跨通道投递、OpenAI API、平台适配和路线图未被本单元重开。§1～§3、§11～§14 为定位、对比、历史规划与类型汇总，不新增第 27 单元义务。 |
| confirmation-ux.md §3～§8 | 部分适用 | advancement 确认复用既有选择/渲染基础设施时，须保持数据与渲染分离、稳定 requestId、串行 pending、重复决定幂等、取消/失联有确定结果且产品文案可理解，归入 IR27-07、IR27-32、IR27-34、IR27-40；SecurityPipeline 权限确认语义不被 Rubric 确认替代。竞品调研、未来 Web/渠道 renderer、smart 分诊和实施路线不适用。 |
| remote-confirmation-execution.md §0～§10 | 部分适用（仅隔离回归） | 当前 77 路径未修改 `ConfirmationBroker`、ConfirmationHub/Bridge、InboundRouter、TextConfirmationRenderer 或 channel challenge/grant；advancement 的 Rubric 控制确认只经 `SelectionService` 与 owner advancement 事件，不得复用或改变权限确认往返语义。该隔离由 IR27-28、IR27-37、IR27-40 判定，不重做远程权限确认功能。 |
| remote-interruption-execution.md §0～§8 | 部分适用 | 当前变更触及 conversation controller、session RPC、advancement user takeover/cancel 与停机交界，既有 turn 级 `abortSignal`、`session.abort`、pending 清理、唯一反馈及 `control > confirmation > agent-input` 优先级不得回归，归入 IR27-10、IR27-12、IR27-31～IR27-34、IR27-40；飞书 IntentClassifier、scheduler RunRegistry、卡片按钮和通道渲染未被本单元修改，不形成新增门禁。 |
| workscene-management-architecture.md 需求区、§0～§3、§6、§8～§10 | 部分适用 | workscene 恢复/切换的用户可见性、设备域 workspace binding、无 workspace 语义、CLI/RPC 同一领域服务及确认边界归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-32、IR27-34、IR27-40；真实路径模型已由第 25 单元 device/binding 合同取代。管理 CRUD、quiesce、智能创建和工具权限未被本单元重开。 |
| 第 14 单元 EX14-01、LD14-01～LD14-08 与冻结合同 | 部分适用 | EX14-01 的旧无 ingress `ControlRecord` 重开条件未出现；LD14-01～LD14-08 适用于本单元新增事件族、wire validator、状态量词、恢复义务和结构门禁，归入 IR27-02、IR27-04～IR27-05、IR27-12、IR27-17～IR27-19、IR27-24、IR27-33～IR27-36、IR27-41。 |
| 第 15A 单元 U15-X1～U15-X5、U15-L1～U15-L26 与冻结合同 | 部分适用 | 新增 advancement/evidence 生产日志、事件族和 owner/executor 路径使重放保留、外部副作用线性化、时间/数值边界、恢复依赖、epoch、通知、全 reducer、错误分类、容量、golden/RPC、投影与 runtime validator 检测动作适用，归入 IR27-02、IR27-04～IR27-05、IR27-09～IR27-12、IR27-17～IR27-19、IR27-24、IR27-31～IR27-37、IR27-41；与旧 scheduler 投递、已退役配置和无当前消费者的排除项须由 IR27-36 按原重开条件判定，不自动重开。 |
| 第 15B 单元 U15B-X1～U15B-X9、U15B-L1～U15B-L35 与冻结合同 | 部分适用 | advancement surface、确认、proxy ingress、run/review 恢复、owner/readiness、幂等身份、客户端投影、会话删除和结构门禁直接相交，归入 IR27-04～IR27-12、IR27-28、IR27-31～IR27-37、IR27-39～IR27-41；与 job delivery、channel interaction 或已退役显示物化且未命中重开条件的条目由 IR27-36 逐项写明不适用事实。 |
| 第 18 单元 X18-01～X18-02、L18-01～L18-12 与冻结合同 | 部分适用 | advancement control/evidence 新增资源方法、身份、重放/在线活性、双 governor、provider 治理、协议枚举、恢复消费者和 runtime validator，使相应检测动作归入 IR27-02、IR27-13～IR27-19、IR27-29、IR27-33～IR27-35、IR27-42；CLI 既有类型基线和第 28 单元 orchestration-node 子租约是否重开，须由 IR27-42 按原条件判定。 |
| 第 20 单元 X20-01～X20-12、L20-01～L20-09 与冻结合同 | 部分适用 | 新增 advancement evidence mesh、目标 workspace/device 选宿、local/mesh adapter、角色装配、服务授权和启动/停机，使相应检测动作归入 IR27-15～IR27-18、IR27-28～IR27-35、IR27-43；job 产品入口、其它数据面、issuer 迁居和既有工具链疑点是否重开，须由 IR27-43 按原条件判定。 |
| 第 23 单元 X23-01～X23-20、L23-01～L23-53、L23-53b、L23-54～L23-59 与冻结合同 | 部分适用 | 新增 evidence journal、ArtifactStore 引用、recovery maintenance、设备 permit、物理 I/O、local/mesh conformance、严格合同与故障注入，相关检测动作归入 IR27-02、IR27-14、IR27-17～IR27-24、IR27-28～IR27-35、IR27-37、IR27-41、IR27-44；surface asset、旧 WAL/迁移、本地域 owner 等未直接相交条目仍须由 IR27-44 按各自原重开条件写明不适用事实。 |
| 第 25 单元冻结合同（X/L 表为空） | 适用 | EnvironmentPort、PathGuard、workspace binding/revision、能力发布、无 workspace 与唯一交付指纹算法归入 IR27-16、IR27-18、IR27-20～IR27-23、IR27-29、IR27-34、IR27-37、IR27-45。 |
| 第 26 单元 X26-01 与冻结合同 | 适用 | executor-role-runtime 已进入当前 77 路径，X26-01 重开条件满足；credential projection/秘密扫描必须按当前变更重新归因，归入 IR27-23、IR27-29、IR27-34、IR27-37、IR27-45。scheduler/job 只作 accepted run、资源和停机交界回归。 |
| 第 27 单元定稿开发清单 D27-01～D27-11 | 适用 | D27-01→IR27-02/03/34/37；D27-02→IR27-04/05/12/17/33/41；D27-03→IR27-06/08/09/13/25/28；D27-04→IR27-13/14/18/19/29/33/35；D27-05→IR27-15/16/17/24/25/33；D27-06→IR27-18～23/29/30/34/35；D27-07→IR27-20～24/34；D27-08→IR27-24/25/39；D27-09→IR27-03/26/27/32；D27-10→IR27-28～31/33/37；D27-11→IR27-01/32/37～40。开发清单限定范围，不替代总纲、规格和当前交付物反向核查。 |
| 当前完整交付闭包 | 适用 | 77 个路径逐一归项：CLI 20→IR27-06～IR27-12/15～17/26～32/34～41；core 21→IR27-02～05/15/23～27/34～39/41；orchestrator 11→IR27-08/18～23/29～31/34～39/41；owner-kernel 8→IR27-04～05/13～14/33～37/41；owner-services 8→IR27-05～17/24～28/31～39/41；rpc 1→IR27-32/34/36～37/40；server 6→IR27-04～12/28/31～32/36～41；文档 2→IR27-37。未归项路径或新增生产链无审查落点即为范围缺口。 |

### 审查项

| 编号 | 状态 | 审查分区 | 审查点与通过条件 | 证据 |
| --- | --- | --- | --- | --- |
| IR27-01 | [ ] | 产品目标与单元边界 | 核对总纲 S7 第 27 项与 D27-01～D27-11：只闭合 advancement owner 化、独立一级取证、资源治理、Rubric 会话采用/全局沉淀及必要产品链；范围内体验完整。第 28～38 单元、二级执行测试/构建取证、历史精确文件系统快照、通用取证/任务框架、benchmark、性能采集、通用诊断和非必要 UI 均未进入交付。 | 待审 |
| IR27-02 | [ ] | 协议合同、codec 与摘要 | 对 `EvidenceRequest`、`EvidenceBundle`、`ObservationToken`、evidence execution result、`AdvancementAdmissionDecision`、`RubricContractDraftSnapshot`、`ConfirmedRubricSnapshot`、`AdvancementRunReview`、`AdvancementProxyMessage`、`ReviewAttribution` 及 AdvancementSnapshot/Event 别名逐字段核对唯一导出、封闭判别、exact keys、v1/32 KiB 文档/4 KiB summary、非空且不重复 items、时间顺序、规范 JCS、对象身份/内容/观测指纹与重签身份不变；未知、多余、错 schema/version、错摘要及逐字段污染在进入状态机前拒绝。 | 待审 |
| IR27-03 | [ ] | Rubric 契约与严格校验 | Rubric 的 id/title/description/content、criteria 稳定 id、evidence required/optional、failureHandling/变量表严格符合协议；`ConfirmedRubricSnapshot.source` 只为 library 或 local-draft，快照确认后不可变且内容摘要全等。Rubric 不承担 Skill/Rule/工作流或执行策略职责。 | 待审 |
| IR27-04 | [ ] | advancement 唯一权威状态 | `SessionStatePort` 的 owner control 流是唯一生产事实源；十三类 AdvancementStoreEvent 及 evidence requested/result/settled 全由共享 codec/reducer 在线和重放消费，session/review/proxy/evidence/terminal 复合边界原子，pending 投影上界有限且可重建，独立文件 AdvancementStore 零生产写；会话删除级联、转移/检查点分类和损坏 fail-closed 成立。 | 待审 |
| IR27-05 | [ ] | 权威写守卫与绑定 | 每个 advancement-event 只由当前 conversation owner 的 host principal 经统一 guard 提交，并反绑 conversationId、advancement sessionId、ownerEpoch、session revision 与 event 顺序；旧 owner/epoch、surface/executor、自报状态、重复同键异载荷均在首个耐久副作用前拒绝，exact replay 只返回原结果。 | 待审 |
| IR27-06 | [ ] | 任务准入与草案生成 | first-party 输入只在任务语义成立时创建至多一个 awaiting advancement session；普通问题直通。Rubric catalog 命中或场景化生成、草案版本、候选近邻、原任务与用户意图保持；ControlCompletion 不可用时按冻结的保守路径处理，不伪造确认或 active。 | 待审 |
| IR27-07 | [ ] | 一次确认、修订与取消 | awaiting 阶段的确认、自然语言修订、重复确认、响应丢失和取消使用稳定请求身份与当前草案版本；只有用户确认的不可变快照进入 active，旧版本/异载荷拒绝。取消不启动原任务；确认后的本任务采用不依赖全局 Rubric 保存成功。 | 待审 |
| IR27-08 | [ ] | ControlCompletion 与 Reviewer 边界 | 准入、草案生成/修订和收场只经 owner 设备 `ControlCompletionPort`；review 只经 `AdvancementReviewerPort`，输入完整携被审 run、Rubric、既往 review、窗口、canonical evidence、lease/abort/deadline。owner-services 不暗取拓扑或 provider，contracts 不反向依赖 owner-services，reviewer 零权威写。 | 待审 |
| IR27-09 | [ ] | accepted run 验收线性化 | 只有 conversation owner 已耐久接受的 advancement run 才触发一次 review；runId、source、ingressId、run index、reviewId 与当前 session 全等。queued/running/uncertain/取消或未提交结果不得提前判定；accepted 响应丢失、重复回调、迟到终态只复用原 run/review，不创建第二次验收。 | 待审 |
| IR27-10 | [ ] | 代理续推与用户中断 | 未通过 review 只按确认版 failureHandling 生成至多一个 outstanding proxy；proxy ingress 由 conversation run journal 唯一认领，调度前按 `(source, ingressId)` 查询耐久所有权。用户真实输入、取消、目标变更、已 committed/closed run 与恢复竞争均不重复调度、不误收束 sibling，用户接管优先且有意义会话归 exited。既有 `session.abort`/外部取消仍经同一 turn 级 abortSignal 中断当前运行并清理 pending，反馈保持单源；advancement 不建立第二取消状态机。 | 待审 |
| IR27-11 | [ ] | 完成、退出与收场交付 | criteria/evidence 全部满足才 completed；死胡同、风险/成本底线、能力缺口和用户接管按冻结原因 exited/cancelled，终态不可逆。completed/exited 产生验收摘要、逐条标准证据链与可行动后续，不以裸事件或模型自述代替；收场模型失败、abort、响应丢失均不改写已成立权威终态。 | 待审 |
| IR27-12 | [ ] | 恢复状态全枚举 | 有限核对 awaiting 草案、active 无 review、review deferred、evidence requested 未结果、结果未 settled、review 已写 proxy 未入队、proxy outstanding 各种 run owner 状态、terminal 未呈现及 session delete 待级联；启动/持续恢复只凭 owner 日志和 run 所有权重驱原义务，瞬时 cache/window 不成第二事实源。 | 待审 |
| IR27-13 | [ ] | control/review 根租约 | 准入、裁判、收场各取得 advancement control 根；review 根是本次 provider 调用和全部 evidence 子租约唯一 parent。每次模型调用在外调前 reserve、以稳定 usageId consume，所有成功/失败/abort/deadline 路径 settle/release 恰一次；过期或终态 exact replay 只豁免在线活性，不豁免静态身份。 | 待审 |
| IR27-14 | [ ] | evidence 子租约与物理容量 | EvidenceRequest 的 lease 必须为 advancement admission、workload evidence/requestId、正确 parentId/digest、conversation/epoch 和目标 executor audience，预算/expiry 不越父。executor 批次另取唯一 workload-advancement permit；bundle、typed-stale、capability-gap、传输不明、abort 与 intake ack 均按子先父后有界终结，不长期占租约、不把 lease 当 permit。 | 待审 |
| IR27-15 | [ ] | 取证计划与耐久 requirement 映射 | owner 只从确认版 Rubric、被审 accepted run、ExecutionManifest 与既有触碰路径构造规范 items；顺序、locator、可用 digestHint 和 itemIndex→一或多个 requirementId 映射先耐久，wire 不增加内部 id、不临场猜路径。conversation-fact 与客观 evidence 的适用性明确且无重复计数。 | 待审 |
| IR27-16 | [ ] | 目标选择、能力与环境 | 目标固定为被审 run 冻结 workspace.deviceId；发送前验证已签 CapabilityDescriptor 的 executor、bindingRef/revision 和全部 evidenceCapabilities，禁止另选没有该 workspace 的设备。无 workspace、目标离线、能力变化、binding 改路/消失及动态 locator 不可达分别得到冻结的 deferred/capability-gap/unknown 语义，不暗取 cwd、不把动态前提塞进稳定 descriptor。 | 待审 |
| IR27-17 | [ ] | owner 耐久请求与有限重试 | 每 attempt 的稳定 requestId、完整签名请求、requestDigest、映射、租约与 attempt 先写 evidence_requested 再发送；同一未过期 attempt 只重发原请求。结果验真后先写 evidence_result，再经 review 写入/settled 关闭；stale 最多两次新 attempt，ownerEpoch/lease 变化只生成下一合法身份，旧结果零推进，离线等待释放本轮资源并由唯一恢复 owner 唤醒。 | 待审 |
| IR27-18 | [ ] | executor 入口守卫与零读取拒绝 | 独立 evidence handler 不创建 assignment、不复用 run dispatch。任何 journal/EnvironmentPort/文件/Git 读取前完成请求签名、信任、版本、requestDigest、expiry、ownerEpoch、executor、review/run/conversation、workspace、provider、子租约和容量守卫；错绑、伪签、过期、旧 owner、异 payload 均零文件访问、零状态追加。 | 待审 |
| IR27-19 | [ ] | executor 幂等 journal | journal 以 requestId 和规范请求身份线性化，同键全等并发/重启/过期后回放原 bundle 或 typed 结果且不再读取，异载荷拒绝；begin/complete 各崩溃点只形成一个终态。pending 不回收，终态 exact replay 索引按既有 27 天窗有界保留，投影落后/损坏可由权威日志重建或 fail-closed。 | 待审 |
| IR27-20 | [ ] | file-diff provider | file-diff 只读取目标 binding 解析出的 workspace 当前 Git 事实；有 locator 时精确限定路径，无 locator 时仅使用全工作区变更和该 run 的既有触碰路径投影，不越界扫描其他目录。无 Git、unborn、路径缺失、digestHint 不符和历史精确请求诚实返回 missing/capability-gap，不虚构历史快照。 | 待审 |
| IR27-21 | [ ] | log/artifact provider | log 与 artifact 只按契约显式 locator、PathGuard 和固定上界读取，禁止无 locator 全量扫描或从执行侧自报位置猜测；多路径顺序、missing、读取失败、symlink/大小写/绝对路径逃逸、采集中替换和 digestHint 错绑均有确定结果，真实原始字节是 contentDigest 唯一输入。 | 待审 |
| IR27-22 | [ ] | ObservationToken 一致性 | 整个请求 item 集按请求顺序在读取前后分别计算 `{kind,locator,state}` 指纹，missing 也进入状态；observedAt 只描述本次观测。前后任一内容、存在性或定位状态变化即 `consistent=false` 并返回 typed-stale，不得夹带可采信证据；一致观测的 item 与指纹逐项全等。 | 待审 |
| IR27-23 | [ ] | EvidenceBundle 真实性与隐私 | bundle 由目标 executor 签名并全等绑定 requestId/requestDigest/executorId、ObservationToken 和所请求 item；每项 source 固定 independent，summary 有界且只陈述证据事实。真实路径、bindingRef 的产品泄漏、秘密、凭据投影和执行侧自然语言自述不得进入 wire/prompt/log/错误；X26-01 的当前重开事实须以本轮源码与秘密扫描归因裁决。 | 待审 |
| IR27-24 | [ ] | owner 验真与 canonical evidence | owner 先验 bundle 签名、request/review/run/conversation/ownerEpoch/executor/workspace/attempt、item exact-set、locator/contentDigest/digestHint 和 consistent，再耐久结果；未请求/重复/missing/stale/错绑项不进 reviewer。canonical evidenceId 由耐久 requestId/itemIndex/requirementId 稳定派生，模型只能引用 id，不能改写事实字段。 | 待审 |
| IR27-25 | [ ] | 裁判采信与通过判据 | reviewer 强 schema 工具只接受 canonical evidenceId；criteria 无 unmet 且每个 required、当前可独立核验的证据要求有通过的 independent 证据才 passed。缺 required、自报替代、unknown id、stale 或能力外要求不得伪通过；transient/provider error 与 abort 不落 review、不推进水位，非法/无工具提交按冻结 fail-closed 终局，capability-gap 给用户诚实裁决。 | 待审 |
| IR27-26 | [ ] | Rubric catalog 与会话采用 | RubricContractBuilder 只消费注入的只读 catalog；锚点 adapter 经 GlobalStatePort asset index 和 ArtifactStore 读取，owner-services 零设备文件 Store。library 确认保存库身份；新草案先以稳定 local-draft snapshotId/contentDigest 随 advancement event 原子落 owner 并立即驱动任务，库缺件、缓存滞后和重复确认不漂移 active 快照。 | 待审 |
| IR27-27 | [ ] | 全局沉淀与延后意向 | 保存/修订是会话采用后的独立动作：在线先耐久规范 Rubric 内容和 dependency closure，再经 GlobalStatePort 以 revision CAS 写；响应丢失 exact replay，失败不回滚已采用契约。离线只经注入的 DeferredGlobalIntentPort contract fake 表达“已用于本任务，连接值班设备后保存”；端口缺失不伪成功，未来 link 只关联库身份、不改 active 内容；本单元零 intent 日志/收编生产实现。 | 待审 |
| IR27-28 | [ ] | owner 生产组合根 | anchor conversation owner 在交互 CLI、one-shot、daemon/anchor-only/anchor+executor 中恰一装配 SessionState adapter、ControlCompletion、Reviewer、资源与 evidence client；所有接入面共用单一 core/owner，ConversationManager 不持 advancement 领域引用，server/RPC/CLI 只作已鉴权薄入口和投影，不出现第二本地 runtime 或 surface 特权分支。非 anchor 或未启用 owner-services 的拓扑零 owner 实例、零监听、零权威写。 | 待审 |
| IR27-29 | [ ] | executor 生产组合根与能力发布 | executor 角色恰一装配 evidence handler、EnvironmentPort、PathGuard、journal、签名/验证、容量与 local/mesh service；非 executor 零实例。CapabilityDescriptor 只发布真实可生产的 file-diff/log/artifact provider kind，能力变化推进 descriptor revision；启动前角色/lease/config 校验，失败逆序回滚且无秘密或资源残留。 | 待审 |
| IR27-30 | [ ] | local/mesh adapter 等价 | 进程内与 mesh adapter 复用同一 codec、guard、状态机、错误分类和业务 handler；同一规范请求产生等价结果与摘要。mesh 只替换 transport，服务方向、认证 peer、预算、deadline、abort、断线重连、重复/乱序和未知错误均有单一分类；不得远程执行 owner reviewer，也不得 fallback 到直接本地 provider。 | 待审 |
| IR27-31 | [ ] | 启动、持续恢复与停机 | 启动先重建 advancement/evidence journal 并注册唯一有界 recovery maintenance，再接受 advancement 控制/取证；坏单项隔离且不截断后续。停机先拒新请求，停止调度新 review/attempt，把已耐久义务推进到终态或可重驱安全点，子/父租约与 permit 有界释放，最后释放 mesh/transport；正常、启动失败、重复 stop 和断线均幂等，不用全局 abort 伪造业务终态。 | 待审 |
| IR27-32 | [ ] | RPC/CLI 产品旅程可达性 | 普通问题直通；任务从草案命中/生成、一次确认/修订/取消、原任务执行、accepted review、独立证据、未通过续推、详情、deferred/缺口、用户接管、completed/exited 到重启恢复形成生产可达链。所有已鉴权 RPC、CLI 与 one-shot 入口均只经当前 conversation owner 投影权威状态，run/event 身份可关联且实时与历史结果同源，不因接入面不同改变状态机；离线沉淀、无 workspace 与能力缺口不伪成功。具体呈现、交互身份和恢复可见性由 IR27-40 独立判定。 | 待审 |
| IR27-33 | [ ] | 并发、半提交与崩溃矩阵 | 有限覆盖十二个边界：session 创建/草案/确认；accepted run→review；review 根 reserve→provider；evidence_requested→发送；executor begin→读取→complete；bundle 传回→owner result；stale→新 attempt；result→review→settled；review→proxy enqueue；proxy admitted→settled；completed/exited→呈现；session delete→advancement 级联。每格在重复、响应丢失、取消/停机、owner/executor 崩溃后只有一个耐久 winner、稳定重驱输入和确定完成判据。 | 待审 |
| IR27-34 | [ ] | 安全与零副作用 | 固定对抗伪签、重签、错 principal/service direction、request/review/run/conversation、ownerEpoch、executor、workspace binding/revision、lease parent/audience/budget/expiry、item/locator/digest、bundle source 及跨请求重放；每个拒绝证明发生在权威写、journal、文件/Git、ArtifactStore、provider 与 prompt 之前。路径/秘密扫描只针对当前 77 路径及其生产消费闭包，不建设新采集框架。 | 待审 |
| IR27-35 | [ ] | 资源、保留与复杂度 | advancement control、review、evidence、journal/recovery 和 Rubric asset I/O 均经既有唯一 governor/arbiter，permit 只包围无锁、无嵌套、无网络/用户等待的叶级本机批次。pending、attempt、items、summary、文档、retry、并发、恢复页和 timer 均有硬上界；空闲零忙等，启动/热路径不扫描完整历史，27 天内 exact replay 与子先父后结算不被压缩破坏。 | 待审 |
| IR27-36 | [ ] | 第 14/15 单元历史合同 | 逐项核对有限集合：EX14-01、LD14-01～LD14-08；U15-X1～U15-X5、U15-L1～U15-L26；U15B-X1～U15B-X9、U15B-L1～U15B-L35。每项记录适用/不适用事实及原重开条件是否命中，并证明新增事件/validator、owner/run/review/proxy、确认、恢复、客户端投影和结构门禁没有回归冻结合同。 | 待审 |
| IR27-37 | [ ] | 文档、结构与交付闭包 | 总纲/spec/task-advancement/rubric 与生命周期、对话/接入面、确认、窗口、workscene 直接上下游合同语义一致；旧独立文件 AdvancementStore、直接本地取证、owner-services 设备 Store、先入全局 Rubric 再生效、第二本地 runtime 及拓扑特权分支零生产可达。以唯一 manifest 算法复算并逐路径归入本清单：77 路径、0 删除、8 个分组、路径集与完整指纹均全等；新增生产文件有唯一消费者，测试/文档有明确对象。第 28～38 单元、二级取证、benchmark/性能采集/通用诊断与非必要增强为明确排除，最终无未判来源、条款、功能链或路径。 | 待审 |
| IR27-38 | [ ] | 执行侧公开契约瞬态注入 | active 会话的每个执行 run 都由宿主装配的 `onBeforeRun.injectUserContext` 把同一确认版 passCriteria 与 evidenceRequirements 完整注入当前 user 消息发送视图；terminal 后零注入。落盘用户原文、执行窗口、system/tools 与 cache prefix 字节不变，失败只影响本次瞬态贡献且不产生第二事实源；生命周期订阅者只在 CLI/RuntimeHost 组合根注册，ConversationManager 与非适用拓扑零 advancement 引用或副作用，failureHandling、Rubric 库索引与裁判过程始终不下发执行侧。 | 待审 |
| IR27-39 | [ ] | 归因权威与确定性续推 | 确认时按顺序生成稳定 criterionId；裁判工具恰覆盖每个 criterionId 一次，`ReviewAttribution` 随 review 权威耐久，`unmetCriteria` 只由 attribution 派生且全等。proxy 只用确认版 failureHandling 填充已声明事实变量，并确定性追加逐条 verdict、结论理由和独立证据摘录；不泄漏裁判思考或程序。review/proxy 写入、响应丢失、missing-proxy 恢复、重启重渲染和收场矩阵均复用同一 attribution，内容与标识字节等价，不产生第二归因源。 | 待审 |
| IR27-40 | [ ] | 产品呈现、交互身份与恢复可见性 | 确认面使用对齐语气，主体只突出 passCriteria/evidenceRequirements，failureHandling 收入标明用途的详情；matched 轻确认、generated 通读确认。CLI 只把控制面草案适配到既有 `SelectionService`，选择模块零 Rubric 依赖、专用面板或第二状态机；awaiting 的 originalTurnId 与当前 rubricDraftId 反绑，旧草案/并发修订拒绝；Esc/Ctrl+C 只收起 UI，永久取消走明确二次确认。代理消息实时/历史均明示“知行推进 · 自动续推”，归因默认紧凑折叠；插话、in-flight abort、unknown、保险丝、deferred/capability-gap、completed/exited 均以可行动人话呈现。resume/list/workscene 切换和启动恢复先建立目标可见性再投影，待确认与错过的收场主动可见，不暴露 owner/executor/bindingRef/lease/digest；未来渠道批量投影不进入本单元。 | 待审 |
| IR27-41 | [ ] | 事件状态机结构性闭包 | 以 `AdvancementStoreEvent` 十三类权威判别联合为闭包，逐类机械绑定真实 producer、共享 runtime codec、在线 reducer、full replay、guard、恢复/删除/转移消费者或有源码依据的 N/A，以及至少一个执行真实行为的直接测试；新增/缺格自动失败。逐项枚举 awaiting/active/completed/exited/cancelled 的合法前后态、复合批次、停止/settled 语义与全部候选生成器；类型判别在运行时逐字段强制。门禁测试必须证明故障注入实际命中、合法签名负例重签后到达目标业务分支、成功 helper 不吞异常，删除任一声称维度都能使门禁失败。 | 待审 |
| IR27-42 | [ ] | 第 18 单元历史合同 | 逐项核对 X18-01～X18-02、L18-01～L18-12，记录适用/不适用及重开事实；重点把资源方法×principal、身份字段×记录/索引、静态授权×在线活性、双 governor 生命周期、恢复消费者、判别联合生产者和 runtime validator 对账到当前 advancement/evidence 路径。 | 待审 |
| IR27-43 | [ ] | 第 20 单元历史合同 | 逐项核对 X20-01～X20-12、L20-01～L20-09，记录适用/不适用及重开事实；重点证明 evidence 只远端取证、不远端执行 owner 裁判，workspace/device 选宿、local/mesh 错误与摘要等价、角色求值、服务授权、ready 前零副作用及停机资源释放成立。 | 待审 |
| IR27-44 | [ ] | 第 23 单元历史合同 | 逐项核对 X23-01～X23-20、L23-01～L23-53、L23-53b、L23-54～L23-59，记录适用/不适用及重开事实；命中的日志/ArtifactRef、exact replay、恢复/周期 owner、容量两层、物理 I/O、conformance、合同消费者、故障注入、判别值生产者与可复现交付指纹检测动作须分别落到 IR27-02、IR27-14、IR27-17～IR27-24、IR27-28～IR27-35、IR27-37、IR27-41，不得用包测绿色代替。 | 待审 |
| IR27-45 | [ ] | 第 25/26 单元交界合同 | 第 25 单元 X/L 空表按冻结合同复核 EnvironmentPort、PathGuard、workspace binding/revision、能力发布和无 workspace；第 26 单元逐项重开 X26-01，因 `executor-role-runtime.ts` 已进入本交付，必须对当前 credential projection/秘密扫描给出源码归因，并证明 scheduler/job 的 accepted run、资源和停机交界未被 advancement/evidence 反向改写。 | 待审 |

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |
