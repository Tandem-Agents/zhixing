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

- **当前单元**：第 26 单元 · generation 1
- **架构来源**：分布式运行时总纲、可执行规格与 S2 供应链约束；scheduler、常驻服务/daemon、消息 Outbox、工具/turn 因果、远程确认与远程中断现役合同；第 14、15A、15B、24、25 单元冻结合同；第 26 单元定稿开发清单
- **交付基线**：HEAD 4ec98cf 至当前完整工作区的 109 个非工作台路径；新增 23、修改 80、删除 6；CLI 27、core 26、executor 2、orchestrator 2、owner-kernel 18、rpc 1、runtime-host 5、server 20、tools-builtin 3、架构文档 5
- **交付指纹**：git-delivery-manifest-v1:41384467440834d8602392123351bfeeb2ed34e37ff841a5761f37650cdb8d08；路径集 SHA-256 为 72e81512c4b70c88b6f421cfea1fe8fa3335fb6eb0f9ee9b09410ed9d9d6a8fc；指纹只作证据，不建立为审查项
- **目标提交边界**：第 26 单元（S7）scheduler 与 job 产品闭环的生产实现、直接相关测试和五份被替代路径文档
- **当前任务进度**：100%（30 / 30 项完成；30 项 [x]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：本轮独立审查已完成；30 项全部为 [x]，P0/P1 与非阻断级临时问题表均为空。当前结论绑定 109 路径交付闭包及其下列指纹。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| --- | --- | --- |
| distributed-runtime-charter.md 当前版本交付原则、背景、一、二 | 适用 | 最小完整产品、持续在线、本地执行、单机与分布式平权及优秀产品体验归入 IR26-01、IR26-19～IR26-21、IR26-26、IR26-30。 |
| distributed-runtime-charter.md §1～§3 | 适用 | 锚点全局权威、executor 完整运行体、包边界与单机拓扑退化归入 IR26-01、IR26-07、IR26-16、IR26-27。 |
| distributed-runtime-charter.md §4 | 部分适用 | 设备身份、能力票据、SecretStore、手动 surface ticket 与定时 channel grant 适用，归入 IR26-02、IR26-07～IR26-08、IR26-24；本单元不改变配对和 mesh 信任根。 |
| distributed-runtime-charter.md §5～§8 | 适用 | 全局任务权威、job 派发、耐久事务、数据面确认与最终性归入 IR26-03～IR26-15、IR26-19～IR26-25。 |
| distributed-runtime-charter.md §9 | 不适用 | 本地域 owner、离线会话、收编与迁居由第 30～35 单元承载；IR26-30 防止提前实现。 |
| distributed-runtime-charter.md §10 | 部分适用 | anchor/executor 角色生命周期、恢复与停机顺序适用，归入 IR26-16～IR26-18；托管服务、卸载和升级由第 36～38 单元承载。 |
| distributed-runtime-charter.md §11 | 适用 | 用户只感知任务、排队、错过、失败和停止，不感知拓扑术语，归入 IR26-04、IR26-13、IR26-19～IR26-21、IR26-26。 |
| distributed-runtime-charter.md §12 故障矩阵 | 部分适用 | executor 崩溃、completed 未 ACK、派发 ACK 丢失/重复、owner 崩溃、提交后 final/投影未完成、取消与迟到确认/封包竞态、owner 失联、控制/数据面断连、旧 assignment/epoch、journal 损坏、磁盘满、设备撤销、渠道重投/响应丢失/重连、版本与时钟偏斜归入 IR26-06～IR26-08、IR26-11～IR26-14、IR26-17～IR26-25、IR26-27；§9 本地域分区、AuthorityTransfer 中断与锚点永久丢失由第 30～35 单元承载。 |
| distributed-runtime-charter.md §12 安全对抗矩阵 | 部分适用 | 票据/证书 scope、受众、expiry 与重放，权限快照，吊销/盲中继，原始接入面确认，权威端口越权及 ResourceLease 对抗归入 IR26-07～IR26-08、IR26-19～IR26-20、IR26-24～IR26-25、IR26-27；配对短码与 MITM 不因本单元重开。 |
| distributed-runtime-charter.md §13 不变量 1～18 | 部分适用 | 1→IR26-05/19/27；2→IR26-12/22/23/27；3→IR26-12/22/24/27；4→IR26-03/04/16/24；5→IR26-16；6→IR26-24；7→IR26-08/19/20/27；8 属第 30～35 单元并由 IR26-30 排除；9→IR26-11/13/22/23/27；10→IR26-07/24；11～12→IR26-07/16/19～21/27；13→IR26-12/13/26；14→IR26-16/27/29；15→IR26-05/22/23；16→IR26-04/07/08/24；17→IR26-04/05/22；18→IR26-07/10/25。 |
| distributed-runtime-charter.md §14 | 适用 | S7 第 26 单元依赖顺序、前置冻结合同和后继不得提前开放归入 IR26-01、IR26-27、IR26-30。 |
| distributed-runtime-charter.md §15 | 部分适用 | 结构验收按 §13 行的 18 条映射；适用故障与安全行按 §12 两行映射；排队、完成、uncertain 与低术语产品体验归入 IR26-13、IR26-19～IR26-21、IR26-26；配对、收编、撤销/恢复旅程由后续单元承载；性能观测不得成为本单元门禁，归入 IR26-01、IR26-30。 |
| specification.md §1 | 适用 | 严格字段、版本、JCS、摘要、JobCommitFence 与 deliveryPlanDigest 绑定归入 IR26-02、IR26-12、IR26-22～IR26-24、IR26-29。 |
| specification.md §2 | 部分适用 | Job 数据面票据、channel token/grant、SecretRef 与 authority capability 适用，归入 IR26-02、IR26-07～IR26-08、IR26-24；信任建立与 mesh bootstrap 不重开。 |
| specification.md §3.1～§3.2 | 部分适用 | GlobalStatePort 的 schedule-list、四类 schedule 写、system 隔离和结果语义适用，归入 IR26-03～IR26-05、IR26-24；SessionStatePort 仅作现有 conversation 提交回归。 |
| specification.md §3.2b | 不适用 | DeferredGlobalIntent 由第 31 单元启用；本单元离线全局写必须诚实拒绝，归入 IR26-04、IR26-30。 |
| specification.md §3.3～§3.4b | 部分适用 | Environment、资源租约、scheduler-class admission 与 storage governor 作为 job 派发和维护输入，归入 IR26-07、IR26-10、IR26-25；不改变 workspace binding 合同。 |
| specification.md §3.5 | 不适用 | Advancement 控制与独立取证由第 27 单元承载，归入 IR26-30。 |
| specification.md §3.6～§3.8 | 适用 | RunExecutor/RunSubmission、schedule mutation guard、job staged 类型隔离与提交入口归入 IR26-04～IR26-12、IR26-24。 |
| specification.md §4.1～§4.2 | 适用 | 单一 AuthorityCommitLog、逻辑流、ArtifactStore 引用在场与可重建投影归入 IR26-03、IR26-05～IR26-15、IR26-23、IR26-25。 |
| specification.md §4.3 | 适用 | TaskDefinition、JobOccurrence、assignment、interaction、status、delivery 与 system-job 全部记录族归入 IR26-02～IR26-15、IR26-29。 |
| specification.md §4.4～§4.5 | 适用 | MutationBatch、publish-decision、发布恢复、保留与 GC 归入 IR26-05、IR26-12～IR26-15、IR26-23、IR26-25。 |
| specification.md §5.1 | 适用 | schedule CRUD、job-run、job-cancel 的受信控制请求、稳定 requestId 与 ingress 归入 IR26-04～IR26-06、IR26-11、IR26-22。 |
| specification.md §5.2～§5.4 | 适用 | user job 派发、manifest、匹配、能力、资源、提交栅栏和幂等 CAS 归入 IR26-07、IR26-09、IR26-12、IR26-22～IR26-25。 |
| specification.md §5.5～§5.6 | 适用 | 状态 notice、delivery 状态、run stream、owner relay 与手动/定时交互分流归入 IR26-08、IR26-11～IR26-14、IR26-19～IR26-20。 |
| specification.md §5.7 | 不适用 | 独立证据请求、观察 token 与止损裁判由第 27 单元承载；既有取消证明只按 §5.2～§5.6 回归。 |
| specification.md §6.1 | 部分适用 | conversation 状态机不改，仅 schedule staged publish、投递和停机交界由 IR26-05、IR26-18、IR26-27 防回归。 |
| specification.md §6.2 | 适用 | user job 38 行状态机逐行归入 IR26-06～IR26-09、IR26-11～IR26-13、IR26-22～IR26-23、IR26-29。 |
| specification.md §6.2b | 适用 | system job 六行状态机、资源与 handler 重驱归入 IR26-10、IR26-21～IR26-23、IR26-25、IR26-29。 |
| specification.md §6.3 | 不适用 | AuthorityTransfer 与锚点迁居由第 32～35 单元承载；本单元只保持 anchorEpoch fencing，归入 IR26-24、IR26-30。 |
| specification.md §6.4 | 部分适用 | job uncertain 打开、暂停、三选裁决和关闭适用，归入 IR26-11、IR26-13、IR26-26；设备迁移状态不适用。 |
| specification.md §7～§10 | 部分适用 | TaskDefinition/JobJournal/Delivery 的权威、删除、保留、落点、能力矩阵和资源治理适用，归入 IR26-03～IR26-18、IR26-25、IR26-27；后续本地域与备份行不适用。 |
| specification.md §11 | 部分适用 | 手动任务、定时渠道任务、system 维护、排队/失败/uncertain 与低术语产品旅程归入 IR26-13、IR26-19～IR26-21、IR26-26；配对、离线本地会话、收编迁居与设备撤销旅程不在本单元。 |
| specification.md §12 | 部分适用 | 十八条机械口径沿总纲 §13 的编号映射归入对应 IR；本单元直接新增的 user job 38 行、system job 6 行、delivery 15 行及 record/schema 行为矩阵归入 IR26-09～IR26-10、IR26-14、IR26-29；conversation 36 行与 transfer/uncertain 非交界行只作 IR26-27 回归或由后续单元承载。 |
| specification.md §13 | 适用 | 五份本单元文档同步及下游合同一致性归入 IR26-30。 |
| specification.md §14 | 不适用 | S1 开工基线已经完成，不形成第 26 单元新增义务。 |
| specification.md §15 | 部分适用 | 第 26 项全部目标与验收归入 IR26-01～IR26-30；第 14、15A、15B、24、25 项只作冻结回归，第 27～38 项明确排除。 |
| always-online-and-local-execution-requirements.md 全文 | 部分适用 | 单机完整、持续在线、本地真实执行和诚实离线语义适用，归入 IR26-01、IR26-07、IR26-19～IR26-21、IR26-26；竞品事实不形成实现义务。 |
| s2-security-supply-chain-review.md 全文 | 部分适用 | 受管安全依赖只能由 mesh 声明、精确锁版且不得从其他包或生产入口旁路的既有门禁适用，归入 IR26-24、IR26-27、IR26-30；本单元未修改依赖、锁文件、mesh 或配对实现，不重开依赖选型与密码学审计。 |
| scheduler-architecture.md 当前生产架构、需求、要求与用户视角 | 适用 | scheduler 唯一权威、用户/system 任务、低开销、有界失败和产品闭环归入 IR26-03～IR26-21、IR26-25～IR26-26。 |
| scheduler-architecture.md 旧 Scheduler/RunRegistry 方案与待根治项 | 不适用 | 与当前生产章节冲突的旧进程内方案仅作历史；错误结构化专项债不阻断当前核心旅程，IR26-15、IR26-27、IR26-30 只核零旧生产回流。 |
| persistent-service.md §4.0、§5～§9 | 部分适用 | 当前 scheduler 合同、RPC、渠道、进程生命周期和事件桥适用，归入 IR26-04、IR26-13、IR26-16～IR26-21、IR26-27；竞品、历史 Phase 与旧 DeliveryPipeline 设计不适用。 |
| daemon-level-1-execution.md §0.3～§0.5、§3.3、§3.6、§3.8、§4 | 部分适用 | 前台/daemon 共用生产路径、ready 状态、CleanupRegistry 单一停机出口与 `server.shutdown` 立即回执适用，归入 IR26-16～IR26-18、IR26-27；daemon 安装、日志、status 命令与进程托管能力未改，不形成新增义务。 |
| message-outbox.md 当前生产边界、§2～§3、§5～§6、§9～§10 | 部分适用 | 权威 Delivery 投影进入 per-target Outbox、turn slot、单消费者、失败边界与非目标适用，归入 IR26-12～IR26-15、IR26-19～IR26-20、IR26-27；把旧 Pipeline 视为持续生产者的历史段落已被当前边界取代。 |
| ADR-007 Message Outbox | 部分适用 | 决策 3～6 的 `createdInTurn → afterSlot`、per-target、单机共用与 Outbox 零内部重试适用，归入 IR26-12、IR26-14、IR26-19～IR26-20、IR26-27；决策 1 的旧 Pipeline 持久层关系由 message-outbox 当前生产边界取代。 |
| ADR-004 工具系统架构决策 7 | 部分适用 | schedule 工具必须从可信 ToolExecutionContext 取得 `turnId` 并保留无 commit 通道退化语义，归入 IR26-04、IR26-12、IR26-19、IR26-27；其余工具体系决策未改。 |
| turn-context-injection.md §4、§5.2、§6.2 及当前更新说明 | 部分适用 | scheduler 状态经现有只读投影注入 turn context，完整列表仍经 schedule list，归入 IR26-04、IR26-19、IR26-26～IR26-27；直接持有旧 Scheduler 的历史接线与未来 provider 扩展不适用。 |
| remote-confirmation-execution.md §0、§2.3、§3、§7、§9 | 部分适用 | 手动 job 的原 surface ticket、定时 job 的 channel responder、Hub/renderer/bridge 与确认零 Outbox 绕行回归归入 IR26-08、IR26-19～IR26-20、IR26-24、IR26-27；竞品与历史里程碑不适用。 |
| remote-interruption-execution.md §0.5、§1～§4、§6～§7 | 部分适用 | job-cancel、远程取消路由、取消结果与接入面回执适用，归入 IR26-11、IR26-19～IR26-21、IR26-27；旧 RunRegistry scheduler 生产路径已被取代。 |
| interruptible-agent-loop-execution.md 现役 abort 合同 | 部分适用 | typed abort、可中断边界和不得用进程内 abort 伪造权威终态适用，归入 IR26-11、IR26-18、IR26-22、IR26-27；跨进程入口以 remote-interruption 当前合同为准。 |
| unified-core-and-access-surfaces.md 当前生产边界 | 部分适用 | 唯一核心宿主、接入面薄适配和 CLI/server 共用核心能力适用，归入 IR26-04、IR26-16、IR26-19～IR26-21、IR26-27；后续热挂载不适用。 |
| agent-runtime-lifecycle.md §3～§8、§10～§11 | 部分适用 | runtime 挂点、run 边界、失败隔离和生命周期所有权作为 job 执行回归输入，归入 IR26-07、IR26-16～IR26-18、IR26-27；skill 首个消费者和未来扩展不因本单元重开。 |
| server-gateway.md §4～§6、§10 | 部分适用 | Channel Adapter、RPC 鉴权、InboundRouter 与用户回程适用，归入 IR26-04、IR26-08、IR26-13～IR26-14、IR26-19～IR26-20、IR26-24、IR26-27；平台扩展与 OpenAI API 不适用。 |
| conversation-model.md §5～§10、§12 | 部分适用 | turn 身份、conversation 内 schedule staged 写、channel 回程、CLI/server 生命周期与 scheduler 交界适用，归入 IR26-05、IR26-12、IR26-16、IR26-19、IR26-27；其余会话模型不重开。 |
| workscene-management-architecture.md 当前设备域环境合同 | 部分适用 | 显式 workspace、无 workspace 与无宿主 cwd 的执行边界适用，归入 IR26-07、IR26-24、IR26-27；binding 管理、迁移和 reset 不重开。 |
| confirmation-ux.md §3～§8 | 部分适用 | 低术语确认、并发 pending、来源回程与 SecurityPipeline 边界适用，归入 IR26-08、IR26-19～IR26-20、IR26-24、IR26-26～IR26-27；渲染器扩展与历史实施计划不适用。 |
| active-hours-execution.md | 部分适用 | 只作为现有 once/interval/cron、priority 与 active-hours 行为的受影响回归输入，归入 IR26-06、IR26-27；不得借此新增配置、性能或未来能力。 |
| 第 14 单元 EX14-01、LD14-01～LD14-08 与冻结合同 | 适用 | user/system job 状态、停止锚、凭证/资源、恢复 ACK 与行为矩阵归入 IR26-07～IR26-12、IR26-22～IR26-24、IR26-27～IR26-29；EX14-01 只在真实旧 input ControlRecord 出现时重开。 |
| 第 15A 单元 U15-X1～U15-X5、U15-L1～U15-L26 与冻结合同 | 适用 | Delivery 状态机、生产切换、重放/恢复、通知、资源/保留、golden 和结构门禁归入 IR26-12～IR26-18、IR26-22～IR26-30；U15-X1 由本单元最终退役旧入口，U15-X3 因切入生产流量必须重查 27 天日志保留/压缩。 |
| 第 15B 单元 U15B-X1～U15B-X9、U15B-L1～U15B-L35 与冻结合同 | 部分适用 | 与 job/scheduler 直接相交的准入、凭证、交互、投递、恢复、生命周期、幂等身份、客户端与门禁检测动作归入 IR26-04～IR26-29；仅 advancement、conversation 删除等无交付路径交界的条目须逐项写明不适用事实。 |
| 第 24 单元 X24-01、L24-01～L24-05 与冻结合同 | 适用 | job run-interact 重开条件已由本单元触发；凭证互斥、稳定 owner、派生索引、记录矩阵、隐藏存储治理及派生资产检测归入 IR26-08、IR26-16～IR26-17、IR26-23、IR26-25、IR26-28～IR26-29。 |
| 第 25 单元冻结合同（X/L 表为空） | 部分适用 | 显式环境、无 workspace、组合根、治理与当前生产交付指纹算法作为回归输入，归入 IR26-07、IR26-16、IR26-24～IR26-27；本单元不重开 workspace 管理。 |
| 第 26 单元定稿开发清单 D26-01～D26-11 | 适用 | 十一项开发义务分别由 IR26-01～IR26-30 承载；清单限定范围，不替代总纲与规格。 |
| 当前完整交付闭包 | 适用 | 109 个生产、测试和文档路径逐路径反向归入 IR26-02～IR26-30；未归项路径、删除项仍可达或新增生产路径无审查落点即为范围缺口。 |

### 审查项

| 编号 | 状态 | 审查分区 | 审查点与通过条件 | 证据 |
| --- | --- | --- | --- | --- |
| IR26-01 | [x] | 产品目标与单元边界 | 核对第 26 项与 D26-01～D26-11：只闭合 scheduler/job 产品链及必要直接依赖；单机和分布式共用同一业务语义；第 27～38 单元、benchmark、性能采集、通用诊断和非必要增强均未进入交付。 | 复用原结论：当前修复仅闭合既有 scheduler/job 范围，未引入第 27～38 单元、benchmark、性能采集或通用基础设施。 |
| IR26-02 | [x] | 合同、codec 与摘要 | 逐对象核对 ScheduleTaskSpecDto、TaskDefinition、JobOccurrence、JobExecutionInstruction、JobCommitFence、Delivery plan、status notice、system handler、ticket/token/grant 的封闭联合、exact keys、版本、摘要、签名、引用目标和未知字段拒绝；外层 state 与 spec.enabled 必须一致。 | 当前合同、codec、摘要/签名绑定、exact-key 污染向量与封闭联合均有生产实现和直接测试落点，未发现阻断问题。 |
| IR26-03 | [x] | 任务与 job 唯一权威 | AnchorScheduler 拥有的 AuthorityCommitLog 与逐任务 JobJournal 是唯一事实源；TaskDefinition 目录可由日志重建，scheduler.json 仅是单向兼容投影。首次导入旧 user 任务保留身份与下一未来触发，system 行只由 host 注册；部分导入、重复启动、异载荷、损坏和投影重建均有确定终态。 | GlobalStatePort 与 AnchorScheduler 的唯一写面、日志权威、兼容投影及恢复边界已闭合，未发现第二事实源或直达写面。 |
| IR26-04 | [x] | CRUD、查询与受信入口 | schedule create/update/set-state/delete/list/run/abortRun、模型工具、RPC/facade、CLI、turn-context provider 及状态事件只达锚点权威或其只读投影；requestId、anchorEpoch、taskRevision、payloadDigest 与认证 ingress 全等；system 任务对所有用户入口不可见不可改；离线不伪生效。 | CRUD/list/run/abortRun 的受信入口、稳定 operationId、epoch/revision CAS 与 system 隔离已闭合，未发现阻断问题。 |
| IR26-05 | [x] | conversation/job 内暂存发布 | assignment 内 schedule 写只进入 staged overlay，create/update/delete 的结果身份稳定；只随所属 conversation/job 提交同 envelope 发布，失败、取消或未裁决 uncertain 零外泄；响应丢失回放原 receipt/applied 结果，不生成第二 task。 | 复用原结论：本轮未修改 assignment 内 staged overlay、MutationBatch 或 publish-decision 链，既有同 envelope 发布证据继续有效。 |
| IR26-06 | [x] | occurrence 与时钟语义 | 手动和 timer 均先原子写稳定 jobRunId、occurrence、queued 与 admitted；taskRevision、scheduledFor、deliveryPlan 反绑不可变 definition。每任务至多一个非终态 occurrence；在线拥塞不误判 missed，离线错过按 ready 锚点处理；once/interval/cron、回拨、退避、停用和单任务失败隔离均按冻结语义收敛。 | 已重审：lifecycle 事件只在 occurrence/state 权威提交后派生；missed 提示仅由耐久 missed occurrence 置命中标记并从日志重建，未改变 onlineSince、ready 锚点、jobRunId、冻结 plan 或下一触发事实。 |
| IR26-07 | [x] | user job 派发与环境 | queued occurrence 只生成去敏 instruction/manifest，经 selector、资源治理、local/mesh dispatcher、executor ledger 与 JobCommitFence；无 workspace 不暗取 cwd。match、binding、reserve、assigned 顺序原子；可恢复缺口保持 queued，确定硬缺口 failed；错域、版本、epoch、lease、fence 零执行。 | instruction/manifest、selector、environment、reserve/assigned 与 local/mesh dispatcher 共用受验合同，未发现绕过或 cwd 回流。 |
| IR26-08 | [x] | 手动 ticket 与定时 grant | 以 JobJournal 的 occurrence/admitted 与不可变 definition 来源为唯一 operations router：手动 job 只签发并接受原始 surface 的 run-interact/abort ticket；定时 job 零数据面票据，只接受冻结 origin/responder 的 channel grant。签发端、executor guard、恢复 owner 共用同一谓词；跨路径、缺来源或错绑在 interaction-finished 前拒绝且零追加。 | 已重审：恢复先由 interactionRoute 判别；surface-ticket 只按原 ingress principal 复用或换代 run-interact ticket，channel-grant 只装 owner relay，二者没有试探或降级路径；终态在打开前复查并关闭会话，既有 executor 反绑守卫保持。 |
| IR26-09 | [x] | user job 38 行状态机 | 对 specification §6.2 的 38 行逐行建立 current state、触发、追加记录、资源/票据动作和次态对账；full/guard/recovery 均接受合法边、拒绝全部 sibling 非法边；每行有真实 producer 和可判定终态。 | user job 38 行真实 producer/reducer/guard/recovery 矩阵完整，未发现非法边或无生产者记录。 |
| IR26-10 | [x] | system job 六行闭环 | ensureSystemTask 只注册封闭 SystemHandlerId；system job 仅锚点本地 runSystem，经 scheduler-class lease 与 SystemJobFence，六行状态机逐行闭合；无 assignment、manifest、票据、用户投递或 uncertain，用户入口零可达；重启同 jobRunId 重驱，错过至多合并一次。 | 已重审：system occurrence/state 仍只由本地 handler、SystemJobFence 与 scheduler-class 租约驱动；新增 lifecycle 仅在同 envelope 终态提交后唤醒 waiter/投影，不产生 assignment、票据、投递或 uncertain 分支。 |
| IR26-11 | [x] | 取消、删除、超时与 uncertain | queued 原子取消；dispatched/running 只经耐久 cancel-requested、唯一 dispatcher 与证明收束；超时不以进程 abort 伪终态。completed 只重提、可证未 started 才重派、结果不明进入 uncertain；禁用不取消在途，删除收束全部在途；打开 fact、迟到 bundle、三选裁决和恢复均唯一。 | 已重审：取消、超时、proof 与 uncertain 裁决仍由原 JobJournal 状态机提交；process-local lifecycle 不生成权威终态，只在耐久 terminal 后结束 waiter/surface，assignment-retired 仅在 recovery 与 bundle-ACK 欠账均清零后释放进程资源。 |
| IR26-12 | [x] | 结果与投递原子提交 | user job committed 时以 JobCommitFence 在同一 CommitEnvelope 写终态、publish-decision 和 delivery enqueued；fence.deliveryPlanDigest 与 occurrence 冻结 plan 全等。显式目标优先，否则保留 origin/channel/thread；none 不投递；source、priority、afterSlot 与 SecretRef 边界正确；transport 结果不回滚 job。 | 终态、publish-decision、delivery enqueue 与 fence 摘要同 envelope；显式目标、来源目标和 none 分支均闭合。 |
| IR26-13 | [x] | 状态、missed 与维护通知 | 每次状态转移按单调 statusRevision 至多生成一条可实时和补读 notice；committed 只走结果投递，渠道状态只收白名单非 committed 终态与 uncertain。missed 按稳定批次和 origin 聚合一次，能力/离线缺口只通知一次，裁决通知携完整 openFactDigest，断线补读零跳失。 | 已重审：公开 JobStatusNotice 仍按 statusRevision 且排除 committed；missed 成员、origin 分组和稳定 noticeId 由 AuthorityCommitLog 水位去重，命中失败可重驱、重启可重建；capability-gap 原始 reason 只留内部记录，live/history/server.info 均投影友好 reason/actions。 |
| IR26-14 | [x] | Delivery 与 Outbox | 权威 Delivery 十五行生命周期、唯一 key/index、claim/send/outcome/retry/uncertain/裁决与可重建状态目录保持；投影待办只送入 per-target Outbox，FIFO、turn slot、单消费者和失败边界不分叉；同 key 同 intent 回放，异 intent 冲突且来源 envelope 零写入。 | 现役 Delivery 十五行、六类 producer、per-target Outbox 与同 key 回放合同未被本轮修复破坏。 |
| IR26-15 | [x] | 旧投递排空与退役 | 所有新 producer 零调用公开 enqueue 后，唯一 legacy drainer 才可按旧 itemId、目标顺序、重试和幂等语义接管旧 queue；queued/retrying 与已接管 send 收敛前不得删文件。空 home 零实例零常驻；损坏 fail-closed；排空完成后旧公开 enqueue、Pipeline/queue/store 及其专属 stats/flush 与生产装配零可达，现役权威 Delivery 的查询/flush 不受此条误伤。 | legacy drainer 只在 ready 后激活，身份、响应丢失、损坏、排空与零新 enqueue 边界成立。 |
| IR26-16 | [x] | 生产组合根与唯一 owner | 含 anchor 的单机、anchor-only、anchor+executor 及可选 mesh/channel 关闭拓扑中恰有一个 scheduler/job owner；executor-only 或未启用 anchor 的拓扑零 owner。交互 CLI、one-shot 与 daemon 只经同一 core-host/facade，schedule profile 按需拉起；任务目录、timer、journal recovery、dispatcher、relay、status/delivery producer、system runner 和 legacy drainer 的创建、启动、失败回滚与关闭均归唯一组合根。 | 已重审：command 仍只在 anchor 角色创建一个 AnchorSchedulerRuntime；manual lifecycle 是该 runtime 的唯一成员，每个 task journal 只注册一个 lifecycle consumer；mesh/channel 仅提供 adapter，executor-only 与非 anchor 拓扑没有 scheduler、timer 或恢复 owner。 |
| IR26-17 | [x] | 启动恢复与 ready 门禁 | schedule profile 首次使用只拉起一个 owner；启动先打开权威日志并重建目录/投影，有限枚举并接管未完成 occurrence、dispatch、cancel、interaction、commit、delivery 和 legacy-drain 义务后才宣告 profile/server ready，真实执行与外部投递可在 ready 后由同一 owner 有界重驱，不得阻塞整体就绪。各义务按稳定身份分页、失败隔离并持续重驱；任何可重建派生索引具有日志/index/checkpoint 写序、落后/损坏自愈和重建期间 fail-closed。 | 已重审：prepare 先重建 TaskDefinition/occurrence/策略投影并注册 journal lifecycle，runServer 后才 activate timer 与固定并发恢复；每条 assignment 单独隔离，manual surface 先登记后在 RPC surface 可用时统一 resume；missed 从耐久 occurrence/notice 水位重建，失败保留命中供后续 tick 重驱。 |
| IR26-18 | [x] | quiesce 与停机 | 停机顺序固定为拒绝新 schedule 写/run 与 timer fire、停止新触发、推进已接管执行到安全终态或耐久恢复点、主动 drain 可立即完成的 delivery/outbox，最后释放 channel/transport；schedule profile 空闲退出与 daemon/前台 shutdown 共用该序列，不得用一个全局 abort 同时终止业务执行和恢复尝试。正常、启动失败、空闲退出、重复 stop 与 transport 失败均幂等。 | 已重审：scheduler.stop 先关闭 accepting/timer、释放等待者到耐久恢复语义并等待当前 tracker；随后 manual session、退役任务和 dispatcher recovery 依序停止，再注销 relay/listener 与释放映射；未以全局 abort 改写任何业务终态，重复 stop/close 均幂等。 |
| IR26-19 | [x] | 手动用户闭环 | 从受信用户入口 CRUD/list 到 job-run 稳定受理、派发、原 surface 交互/取消、提交、状态/结果投递与重试形成一条生产可达链；线程、来源、身份、断线与响应丢失均保持，用户只见任务语言和可行动状态。 | 已重审：稳定 first-party surfacePrincipal 随 admitted route 耐久，manual owner 只向该 principal 当前连接投帧；ready 前后与恢复注册汇入 assignmentId 单飞 opening，路径断开由同 session/游标重试，job 终态关闭而 bundle ACK 前仍保留恢复 owner。 |
| IR26-20 | [x] | 定时渠道闭环 | 从 timer occurrence 到派发、owner relay、challenge/token/grant、提交、线程内结果/状态、missed 汇总和渠道不可达降级形成一条生产可达链；无 ingress、缺 responder、回调重投、发送/ACK 丢失和过期均有确定终态且不试探 ticket 路径。 | 已重审：timer occurrence 仍只走 channel-grant relay，不存在 surface-ticket 试探；missed 仅由耐久 occurrence 触发，按 origin 稳定分组并与 Delivery 同事务去重，失败保留命中且启动从日志重建，渠道断线继续由既有 relay/Outbox 身份重驱。 |
| IR26-21 | [x] | system 维护闭环 | 从 host ensure、到期/catch-up、资源准入、handler、fence、终态、释放和重启恢复形成一条生产链；首次 seed 不补跑，system 不进入用户列表、事件、投递、确认或 uncertain；单个 handler 失败不阻断其他任务。 | 已重审：host ensure 仍只登记封闭 SystemHandlerId；到期 occurrence 只经本地 runSystem、scheduler-class lease 与 SystemJobFence 收束，单任务异常隔离。内部 lifecycle 只刷新投影和完成等待者，不创建 assignment、用户 notice、Delivery、确认或 uncertain。 |
| IR26-22 | [x] | 并发、幂等与线性化 | 固定覆盖 CRUD CAS、手动/timer 竞争、重复 tick、同任务并发、派发/取消/封包/投递竞争、同 request/operation 重放与响应丢失。每链只有一个耐久 winner、稳定身份、线性化点和完成判据；迟到输入只回放或拒绝，零第二 task/job/assignment/delivery/终态。 | 已重审：assignmentId 维度的 opening 与 retirement 均 singleflight；终态 waiter 先登记再读取权威状态，消除订阅窗口；missed 命中在提交后置位、失败重置并由稳定成员/noticeId 去重。新增进程内协调均以既有日志提交为线性化点，没有第二耐久 winner。 |
| IR26-23 | [x] | 崩溃、损坏与恢复 | 有限覆盖十一类半提交边界：task revision 已写而目录/投影未更新；staged mutation 已提交而 task revision/publish-decision 未完成；occurrence queued 而未派发；assigned 而未 started；cancel-requested 而 proof 未回；interaction prepared/granted 而 mirror/closed 未完成；bundle sealed/committed 而 ACK 未回；system reserve/fence 或 terminal/settle/release 未完整落定；job terminal 而 status/delivery 投影未完成；delivery enqueued/attempt-started 而 outcome 未回；legacy send 已开始/完成而队列文件未重写。重启只推进原义务；坏尾、未知记录及 index/checkpoint 落后、超前或损坏均隔离或由权威日志重建。 | 已重审：manual opening、terminal/retired 与 missed 命中均为可丢失的进程内唤醒，不充当事实；重启从 occurrence、assignment recovery、bundle-ACK outbox、status history 与 missed 成员/水位重建原义务。assignment 仅在 recovery 与 bundle ACK 欠账同时清零后退役，半提交不会提前释放 owner。 |
| IR26-24 | [x] | 安全、权限与秘密 | origin、interactionResponder、createdInTurn、system、id/revision/time/state 只由锚点派生；assignment、surface、host、owner-control、usage-reporter 五类 principal 的封闭方法子集及其 resource/epoch/assignment/lease 绑定逐项验权，owner-relay 还须验证当前 owner-control authority。Webhook endpoint 只以 SecretRef 耐久，解析只在发送边界；prompt、wire、日志、错误和诊断零秘密/真实路径；伪签、错绑、过期与跨域重放在副作用前拒绝。 | principal 方法集、epoch/resource/assignment/lease 绑定、SecretRef 解析边界与错绑拒绝均成立。 |
| IR26-25 | [x] | 资源、保留与复杂度 | user/system job、delivery、legacy drain、日志/投影恢复均经既有唯一 resource/storage governor；permit 只覆盖无嵌套、无锁内或外部等待的叶级步骤。timer/重试/队列/索引有硬上界，单任务失败隔离；首次生产接管后，TaskDefinition/JobJournal/Delivery 终态幂等索引与日志按 §4.5 的 27 天窗口保留并由既有有界压缩/GC 所有者收束，窗口内 exact replay 不变；启动和热路径不随完整历史无界扫描，空闲零忙等。 | 已重审：完成等待改为提交后 lifecycle 唤醒，长期 queued 不再 50ms 扫日志；manual 重开仅有一个可取消 retry timer，assignment 退役释放 dispatcher/relay/session 与映射；missed 只在启动或耐久命中时扫描且单任务失败隔离。27 天物理压缩仍按已裁决 U26-06 后置，当前无容量/启动损失且重开条件未触发，pending/uncertain 与窗口内 exact replay 均未被削弱。 |
| IR26-26 | [x] | 产品体验与诚实状态 | CRUD、运行、取消、错过、排队、不可用、失败、uncertain、停用和通知文案均低术语、可行动且不暴露 anchor/executor/lease/fence/bindingRef；手动受理立即给稳定身份，离线不伪成功，状态与实际权威事实一致；范围内体验优秀但不增加非必要能力。 | 已重审：手动任务仍以稳定 jobRunId 立即受理并回到原 surface；missed 汇总给出“查看任务状态/按需重新运行”，能力缺口公开层给出设备在线与能力检查动作，内部 executor/lease/fence 原因不进入 live/history/server.info；committed 只走结果投递，离线与 uncertain 均不伪成功。 |
| IR26-27 | [x] | 前置能力与兼容回归 | 第 14、15A、15B、24、25 单元的 assignment、job reducer、delivery、conversation staged publish、ticket/grant、resource、environment 和 shutdown 稳定合同不回归；现有 once/interval/cron、priority/active-hours、RPC event bridge 与 no-workspace 行为保持；删除旧 Scheduler/RunRegistry/Pipeline 不留下兼容调用。 | 已重审：新增 onLifecycle 是与公开 onStatus 分离的提交后内部接缝，未改变 JobJournal reducer、JobCommitFence、Delivery、资源或环境合同；manual route 仍以耐久 ingress 机械选择 surface-ticket，定时 route 仍只走 channel-grant，闭合 X24-01；once/interval/cron、active-hours、RPC bridge 与无 workspace 输入未被本轮文件修改。旧 IDeliveryPipeline/EnqueueParams 生产符号全仓为零，旧 Scheduler/RunRegistry 无生产实例。 |
| IR26-28 | [x] | 历史排除项与迟发现教训 | 逐项核对有限集合：EX14-01、LD14-01～LD14-08；U15-X1～U15-X5、U15-L1～U15-L26；U15B-X1～U15B-X9、U15B-L1～U15B-L35；X24-01、L24-01～L24-05。每项记录适用/不适用与事实；X24-01 必须重开并由 IR26-08 证明，U15-X3 必须由 IR26-25 证明生产接管后的保留/压缩，其他命中重开条件者不得沿用排除结论。 | 已重审有限集合：本轮实际命中的 X24-01 由耐久 interactionRoute、签发/执行同谓词与唯一 manual lifecycle owner闭合；L24-01～05 的唯一 owner、无第二事实、无新增记录族/存储设施和直接验证要求均有当前落点。U15-X3 的通用物理压缩仍依已登记价值裁决后置，重开事实不存在；其余排除项的主体、存储、合同或拓扑重开条件均未被本轮输入触发。 |
| IR26-29 | [x] | 记录、状态机与结构验收 | 对有限权威记录集建立机械闭包：task-revision/TaskDefinition 与 occurrence；user job 的 admitted、assigned/dispatch、cancel/supersede、ticket、interaction/relay、state、committed/ACK、resolution；system miss、fence/result；Delivery 六类 enqueue source 与十五行。每类均有真实 producer、full reducer、compact guard、恢复消费者或事实化 N/A、污染向量；38 行 user、6 行 system 与 15 行 delivery 逐行执行真实实现，不用共同 fake、自报标签或仅元数据断言伪造证据。旧队列的 read/send/retry/remove 另由 IR26-15、IR26-23 审查，不伪装成权威记录族。 | TaskDefinition、occurrence、user/system job 与 Delivery 的真实 producer/reducer/guard/recovery 结构闭包成立。 |
| IR26-30 | [x] | 文档、交付闭包与明确排除 | 五份被替代路径文档与总纲/spec 当前合同一致，旧内容明确标为历史；109 个交付路径逐个归入本清单，6 个删除项生产零可达，新增文件均有必要性和消费者。明确排除第 27～38 单元、诊断/benchmark/性能采集/通用迁移与非必要重构；最终不存在未判来源、条款、功能链或交付路径。 | 最终重审：唯一 manifest 生成器实算 109 路径、6 删除，分组为 CLI 27/core 26/executor 2/orchestrator 2/owner-kernel 18/rpc 1/runtime-host 5/server 20/tools-builtin 3/架构规格 5；路径集与完整指纹均和当前状态全等。最终验证补齐的 executor 行为矩阵及 server 身份夹具/golden 已归入既有审查项，不新增产品能力；23 个新增路径都有生产消费者或直接测试落点，删除的旧 pipeline/queue 生产符号零可达；未引入第 27～38 单元、benchmark、性能采集、通用诊断或迁移设施。 |

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |
