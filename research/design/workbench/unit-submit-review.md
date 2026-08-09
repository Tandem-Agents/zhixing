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
目标：只收敛第 34 单元正式问题列表中同根重开的 U34-03、U34-04 和新增的 U34-09，使 U34-04 一个 P0、U34-03/U34-09 两个 P1 真正命中 target pre-bootstrap post-install 消费闭包、current-owner 第一方路由 exact-set 与 planned candidate 跨 transfer 耐久单飞的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U34-01～U34-02、U34-05～U34-08 与 EX34-01 的既有结论直接复用，价值裁决已经删除、降级或收窄的主张不得恢复，第 35～38 单元 source-less/disaster recovery、恢复应用、全局同步与生命周期能力不得提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 34 单元正式文件中的 U34-03、U34-04、U34-09、EX34-01，只依据三项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U34-09 → U34-04 → U34-03` 从权威架构、规格和当前生产调用图重建事实链，核准 candidate claim、source/target journal transaction、installed envelope、transfer key/private committed、bootstrap current-issuer gate、有限 runtime consumer、canonical entry ownership、mesh router 与 current-authority resolver 的唯一事实源、稳定身份、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中根因还是表象。同根内容必须合并，独立根因不得互相遮蔽；U34-03 的 P1/中边界、U34-04 收窄后的 pre-bootstrap/有限 consumer 方案及 EX34-01 的删除结论，未满足正式重开条件时不得恢复旧评级或扩面方案。
2. 穷尽直接变体：U34-09 覆盖四个认证管理入口、同/异 transfer、source/target 空竞争投影、首次 ready/prepare、target key/staging、取消、响应丢失、并发和连续重启；U34-04 覆盖 authority install 前后、key/private committed/`onInstalled` 每一切点、live/startup、source 在线/离线、scheduler/conversation/intent/confirmation/final/delivery 等有限 consumer、响应丢失、terminal replay 和连续重启；U34-03 覆盖 canonical entry ownership 的全部 current-anchor 方法、旧 source/new target/第三设备、target 在线/离线、未知方法、设备本地方法及通知/确认关联。每格必须指出稳定 identity、耐久事实、唯一线性化点、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：U34-09 只在现有 source `AuthorityCommitLog`/planned journal 与 target journal 事务内增加 claim-before-key/prepare；U34-04 只让 `transfer:anchor-current` installation 驱动 bootstrap current-issuer 检查前的窄 key/journal completion，并对持迁前 cursor/owner 的有限 exact-set 复用既有 recover/start；U34-03 只从 canonical registry/S7 entry ownership 冻结 current-anchor 有限 exact-set并复用认证 mesh router/current-authority resolver，设备本地与未知方法不得代理。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二事实源、通用锁或 registry、通用 lifecycle/RPC 代理、迁移/同步/路由/存储/事务/outbox/事件总线、新 lint/test runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 三项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：planned candidate 跨 transfer 单飞、target pre-bootstrap/post-install 与有限 consumer 恢复、current-owner 第一方入口 exact-set、生产证据/产品体验/范围价值及 EX34-01 边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 `U34-09↔U34-04`、`U34-04↔U34-03`、`U34-09↔U34-03` 以及三项与 U34-01～U34-02、U34-05～U34-08、EX34-01、第 35～38 单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U34-03、U34-04、U34-09 的全部受支持 candidate 并发/重放、install 后崩溃与 bootstrap/有限 consumer 恢复、current-anchor 方法 exact-set 和三设备路由终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会因同根残留继续局部返工。满足后明确回复“U34-03、U34-04、U34-09 的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 34 单元同根重开的 U34-03、U34-04 和新增的 U34-09，使 U34-04 一个 P0、U34-03/U34-09 两个 P1 闭合 target pre-bootstrap/post-install 消费闭包、current-owner 第一方路由 exact-set 与 planned candidate 跨 transfer 耐久单飞的全部同根直接变体；不得扩展到其他问题或全单元流程。U34-01～U34-02、U34-05～U34-08 与 EX34-01 的既有结论直接复用，价值裁决已经删除、降级或收窄的主张不得恢复，第 35～38 单元 source-less/disaster recovery、恢复应用、全局同步与生命周期能力不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 34 单元正式文件中的 U34-03、U34-04、U34-09、EX34-01，只依据三项问题最新的根因、价值裁决、F34-11～F34-16 固定矩阵、C34-C16～C34-C27 反证账、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F34-11～F34-16 固定矩阵。U34-09 覆盖四个认证管理入口、source/target 空竞争、同/异 transfer、首次 ready/prepare、claim→key→prepared、claim-only cancel、commit/abort、响应丢失、并发与连续重启；U34-04 覆盖 authority install→key/private committed/onInstalled/consumer/cleanup 每一切点、target→owner 角色翻转、live/startup、source 在线/离线、六种 pending kind、响应丢失和连续重启；U34-03 覆盖 canonical registry 全部 method、两生产根、旧 source/new target/第三设备、executor-local conversation、target 在线/离线、未知/设备本地方法及通知/确认 surface。逐格绑定 candidate/install/current-owner/surface identity、唯一耐久事实、线性化点、零副作用边界和直接证据，并持续核对 U34-01～U34-02、U34-05～U34-08、EX34-01 与第 35～38 单元边界。
2. 按 `U34-09 → U34-04 → U34-03` 一次完成。source planned journal 增加内部 `candidate-claimed` phase与同一 AuthorityCommitLog 全投影事务，claim identity冻结home/request/transfer/source/target/trust chain/anchor epoch，claim后才调用remote ready；target在稳定 staging root 增加一个复用现有 `FileAuthorityCommitLog`、同 governor/lifecycle 的 target-wide 窄 claim journal，claim前禁止context/key/reservation/staging。same-transfer exact replay复用同key；private commit/abort先耐久再终结claim，claim-only cancel以现有认证planned service投递窄签名release并可重驱，四个入口只有prepare可新建candidate。

   随后抽取 planned 专用两段 completion。先把现有 trusted-identities verifier 构造窄化复用；pre-bootstrap completion在current-issuer active-key检查与role composition前，只消费当前 `transfer:anchor-current` installation，验target/commit/trust/key/private journal全等，幂等激活exact key并补committed，live commit复用。authority consumers装配后、公开准入前运行固定post-install descriptor；live期间保持planned/current-owner gate unavailable，按 `scheduler+intent+assignment`、`conversation+interaction+confirmation+final`、`delivery` 三组调用既有recover/start，并把AuthorityCatalog六种pending kind全量反绑current owner；成功后才cleanup/open/respond，失败由startup/terminal replay继续。

   最后让canonical builtin registry成为relay exact-set唯一来源，仅排除设备本地 `auth`、`health`、`server.shutdown`；current router、mesh client/target与S7共用。anchor+executor直接用current-anchor router；executor-only用有限ownership composite：local session/confirmation（含`session.resolve`）只委托local router且其false直接回canonical，其余relay方法才查current-anchor resolver。target离线稳定retryable且不回退旧source，未知方法在canonical lookup拒绝，通知按surface principal/generation定向。同步直接相关架构、规格、S7与测试。同根残留并入原问题，禁止新增第二事实源、通用锁/registry/lifecycle/RPC代理、迁移/同步/路由/存储/事务/outbox/事件总线、新lint/test runner、监控、诊断、benchmark或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、source/target candidate claim、pre-bootstrap install completion、post-install consumer closure、双根 first-party exact-set直接合同/场景测试，现有S7 lint及必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过真实source/target `AuthorityCommitLog`、target-wide claim journal、SecretStore/private staging、AuthorityCatalog pending owners与认证mesh，直接注入异transfer并发、claim-only取消、claim/key/prepared与install/key/consumer切点、响应丢失、角色翻转、六种非空pending、三设备逐方法路由和连续重启；不得以mock自报single-flight/completion/current-owner或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与三项验收无关的验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读地逐格重建 U34-03、U34-04、U34-09 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：planned candidate跨transfer单飞、target pre-bootstrap/post-install与有限consumer恢复、current-owner第一方入口exact-set、生产证据/产品体验/范围价值及EX34-01边界。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查 `U34-09↔U34-04`、`U34-04↔U34-03`、`U34-09↔U34-03` 以及三项与 U34-01～U34-02、U34-05～U34-08、EX34-01、第35～38单元边界的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第 2 步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U34-03、U34-04、U34-09 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C34-C16～C34-C27及新增同根反证全部有耐久处置，证明source/target异candidate并发恰一claim且claim前零key/staging，claim-only cancel与terminal/响应丢失/连续重启唯一收敛；target install后任意切点都能在role gate前补exact key/private progress，并在公开准入前把三组consumer和六种pending全量归属new owner；canonical registry-minus-local exact-set在两生产根、旧source/newtarget/第三设备恰一路由，local/未知/设备本地零误代理，target离线不回退。U34-01～U34-02、U34-05～U34-08结论与EX34-01排除仍成立，第35～38单元能力未提前实施，三项均已更新为“已验证”。满足后明确报告“U34-03、U34-04、U34-09 三项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 34 单元 · generation 1
- **单元身份**：S9 planned anchor 迁居；只支持用户从 current anchor 主动迁往另一台已配对、active、启用 anchor 角色且 ReadyProof 就绪的设备。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D34-01～D34-08；上游只消费第 33 单元 current verified full recovery checkpoint、唯一 `AuthorityCommitLog` / `ArtifactStore` / storage governor、S2 trust/mesh/SecretStore 合同，下游只为第 35 单元保留已提交 authority/trust 基线，不提前实现灾难恢复。
- **交付基线**：当前 `HEAD 6415cc1fb0e23841d0c7093f8a1dbd3868ff39e9`；U34-03/U34-04/U34-09 修复影响 22 个非工作台生产/测试/S7 路径，按排序后的 `path<TAB>file-sha256` 清单冻结内容指纹 `52519474c5c8553cbda2b583a50d8e7504344319aae349f48e165751d8a6d1b2`。工作台文件不参与功能指纹；未受影响路径继续复用原结论。
- **生产装配关系**：anchor+executor 与 anchor-only/current-anchor 两个生产组合根复用同一 authority log、artifact store、device storage governor、trust/mesh 与 checkpoint owner，动态装配恰一 planned source/recovery owner；合格的 non-current active anchor 只可暴露有限 readiness/strict transfer receiver，首条 `prepared` 才把迁居耐久状态、私有 staging 与 recovery 义务绑定到唯一 target。executor-only、surface、disabled、非 anchor 设备及未被选中的候选零 source owner、零非终态迁居事实；目标提交成功后新 issuer/current anchor/authority base 同步生效，旧 source 永久 fenced。
- **目标提交边界**：交付 strict planned transfer 合同、ReadyProof 与 transfer-bound issuer key、source 准入关闭和在途收束、独立 planned export/AuthorityCatalog/SourceFreezeProof、target 私有导入、唯一 AnchorTransferCommit、双端恢复与 forward-only、CLI/server 值班设备迁居入口、两生产根 exact-set/S7 与成比例直接证据。
- **明确排除**：第 35 单元 source-less/disaster recovery、恢复应用、`domain-reset`、pending-reenroll、凭据轮换与恢复旅程；第 36～38 单元托管服务、移除/卸载、升级发布；anchor 自动故障转移、quorum/witness、多目标/云、连续全局同步；环境事实、SecretStore 内容、workspace 原始路径、设备缓存与非权威缓存；第二事实源、通用迁移/路由/存储/事务/outbox/事件总线/registry、监控、诊断、benchmark 或信息采集。
- **当前任务进度**：25/36（69%）。U34-03/U34-04/U34-09 已修复并在正式问题账标为“已验证”；按实际变更闭包将 11 个原 `[!]` 改为 `[~]` 且明确旧证据失效，25 个未受影响 `[x]` 直接复用，待下一轮独立审查只复审这 11 项。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：修复后待受影响范围复审；0 项 `[ ]`、25 项 `[x]`、0 项 `[!]`、11 项 `[~]`。正式问题 U34-03、U34-04、U34-09 已验证，EX34-01 继续排除；不得重复审查 25 个未受影响 `[x]`，下一轮只审 11 个 `[~]`。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线值班设备与本机真实工作设备并存的核心目标归入 IR34-01、IR34-23、IR34-31。 |
| 需求文档 §二 | 不适用 | 外部回复的信息整理是需求形成材料，不独立产生第 34 单元合同。 |
| 需求文档 §三 | 不适用 | 对历史实现的核验不是当前迁居字段、状态或验收要求。 |
| 需求文档 §四 | 不适用 | 历史架构审核过程不替代现行总纲与规格。 |
| 需求文档 §五 | 不适用 | 历史现状归纳不产生当前交付义务。 |
| 需求文档 §六 | 适用 | “值班设备可切换、干活设备保留真实环境”的用户目标归入 IR34-03、IR34-23、IR34-31。 |
| 需求文档 §七 | 适用 | 当前产品价值、最小完整范围与体验优先级归入 IR34-01、IR34-31、IR34-35。 |
| 需求文档 §八 | 适用 | 目标列表、可行动 readiness 缺口、准备/收束/传输/接管阶段、切换前取消、失败后继续及零内部术语逐条归入 IR34-03、IR34-20～IR34-21、IR34-31。 |
| s2-security-supply-chain-review.md 范围说明 | 适用（兼容边界） | 当前交付改动 `@zhixing/mesh` 的 package export/build；评审只约束其既有四项受管依赖，不得借本单元宣称仓库级供应链结论，归入 IR34-32。 |
| s2-security-supply-chain-review.md「裁决」 | 适用（兼容边界） | 当前交付修改 `@zhixing/mesh` export/build 并复用既有密码与连接面，须确认三项生产依赖和受控 PAKE 开发依赖用途边界不漂移，归入 IR34-30、IR34-32。 |
| S2 供应链评审「强制门禁」 | 适用（兼容边界） | 精确锁版、依赖 owner、PAKE 非生产隔离及既有 supply-chain gate 不得因新 mesh 子入口被绕过，归入 IR34-32～IR34-33。 |
| S2 供应链评审「接受依据」 | 适用（兼容边界） | planned transfer 不新增密码依赖、不改变 TLS/证书/PAKE 实时边界，归入 IR34-05、IR34-30、IR34-32。 |
| distributed-runtime-charter.md「当前版本交付原则」 | 适用 | 最小完整产品、锁定范围内最优架构与禁止未来框架预建归入 IR34-01、IR34-35～IR34-36。 |
| 总纲「一、架构概况」 | 适用 | 单一产品、唯一 current anchor、单机/分布式同构及恢复能力归入 IR34-01、IR34-23、IR34-28。 |
| 总纲「二、凝练后的需求点」 | 适用 | 值班/干活角色、跨机一致体验与可信迁居归入 IR34-03、IR34-23、IR34-31。 |
| 总纲 §1 架构结论 | 适用 | current anchor 唯一权威、设备间同一协议内核与不造第二路径归入 IR34-17～IR34-19、IR34-23。 |
| 总纲 §2 角色模型 | 适用 | anchor/executor/surface 角色与 enabled/disabled topology exact-set 归入 IR34-03、IR34-28。 |
| 总纲 §3 包与依赖边界 | 适用 | core/mesh/owner-kernel/server/cli 分层、无环依赖与组合根职责归入 IR34-28、IR34-32、IR34-36。 |
| 总纲 §4 设备网格与安全协议 | 适用 | trust generation、签发者、设备认证、签名和旧 issuer 拒绝归入 IR34-02～IR34-05、IR34-25、IR34-30。 |
| 总纲 §5 权威矩阵与执行清单 | 适用 | 全局域随 anchor 迁居、会话/执行/资产/义务完整覆盖归入 IR34-11～IR34-12、IR34-18、IR34-24。 |
| 总纲 §6 run 派发协议 | 适用（上游边界） | 不重审既有 run 协议；只审 fresh 准入关闭、已接受 run/job/interaction/final/delivery 的可证明终态和迁后重建，归入 IR34-08～IR34-09、IR34-24。 |
| 总纲 §7 环境模型与路由 | 适用（负边界） | 环境事实、workspace 原始路径和本机能力不得进入 catalog/wire，迁后只按目标本地配置重建，归入 IR34-11、IR34-30。 |
| 总纲 §8 双平面通信 | 适用（传输边界） | mesh 只换传输路径、不成为权威；断连/重连/重投保持同一 transfer 身份，归入 IR34-05、IR34-14、IR34-21、IR34-27。 |
| 总纲 §9 离线本地会话、收编与迁居 | 适用（直接） | planned AuthorityTransfer 全状态、ReadyProof、SourceFreezeProof、AuthorityCatalog、TrustTransition、唯一 commit、abort/forward-only 与 owner/receiver exact-set 归入 IR34-02～IR34-29。 |
| 总纲 §10 凭据与服务生命周期 | 适用（有限） | ReadyProof 的 SecretStore unlocked/服务 revision 和 transfer issuer key 生命周期直接适用；第 36～38 单元服务托管/卸载不适用，归入 IR34-03～IR34-04、IR34-19、IR34-35。 |
| 总纲 §11 产品体验设计 | 适用 | 用户只见“值班设备”、目标缺口、阶段、取消/继续和诚实终态，归入 IR34-31。 |
| 总纲 §12 故障矩阵 | 适用（逐个相关故障） | 迁居任意步中断、旧锚点/旧 epoch、磁盘满、网络分区、响应丢失、版本偏斜和时钟边界归入 IR34-09、IR34-13～IR34-29、IR34-34。 |
| 总纲 §12.1 S9 恢复根与备份状态边界 | 适用（上游窄接缝） | 迁居前只取得 current verified full checkpoint；不得改写 Unit 33 envelope/readiness/retention，归入 IR34-07、IR34-32、IR34-35。 |
| 总纲 §13 不变量清单 | 适用 | 唯一权威、旧 epoch 永拒、同 envelope 原子性、秘密隔离、资源治理、零未启用 owner 等相关不变量归入 IR34-08～IR34-30、IR34-34。 |
| 总纲 §14 实施序列 | 适用（Unit 34） | S9 Unit 34 全部适用；Unit 35 disaster recovery 与 Unit 36～38 明确不适用，归入 IR34-01、IR34-35。 |
| 总纲 §15 验收纲 | 适用 | 正常、边界、故障、恢复、对抗、双拓扑与零认知旅程的成比例证据归入 IR34-33～IR34-34。 |
| specification.md §1.1 | 适用 | requestId/transferId/deviceId、anchor/trust epoch 与时间有效期归入 IR34-02～IR34-03、IR34-27。 |
| 规格 §1.2 | 适用 | JCS、schema/version、digest/signature 域及 freeze/transition/ready/catalog/checkpoint 引用逐项归入 IR34-02、IR34-10～IR34-17、IR34-27。 |
| 规格 §1.3 | 适用（兼容边界） | 外部符号仍从权威包消费，禁止复制或改造上游合同，归入 IR34-32。 |
| 规格 §1.3b | 不适用 | S1 新建符号清单已交付，且本章没有 planned anchor transfer 新符号；现有符号兼容由规格 §1.3 与 IR34-32 承载，不从本章恢复字段设计。 |
| 规格 §1.4 | 适用 | `AnchorTransferCommit`、TrustTransition 等总纲名与字段级合同必须全等，归入 IR34-02、IR34-17～IR34-19。 |
| 规格 §1.5 | 适用 | stable/transient/conflict/unauthorized 等内部结果须在公开面映射为稳定可行动错误，归入 IR34-27、IR34-31。 |
| 规格 §2.1 | 适用 | `HomeTrustEvent/Record`、planned `AnchorTransferCommit` 与 `SourceFreezeProof` 的严格联合、签发者、epoch 和链头归入 IR34-02、IR34-04、IR34-16～IR34-19、IR34-25。 |
| 规格 §2.2 | 适用（上游边界） | 活跃 capability/lease/ticket 是待收束/迁移义务；不得由迁居伪造、放宽或另建凭证，归入 IR34-09、IR34-24、IR34-30。 |
| 规格 §2.3 | 适用 | transfer issuer 私钥只入 SecretStore，锁定/删除/激活/重放均不出 wire，归入 IR34-04、IR34-30。 |
| 规格 §2.4 | 不适用 | 凭据暴露记录属于设备撤销收束，不是 planned migration 交付；凭据轮换禁入本单元的依据来自总纲/规格 Unit 35 边界，由 IR34-35 承载。 |
| 规格 §2.5 | 适用（复用边界） | 只复用生产 mesh bootstrap、认证连接与 negotiated service；不新建连接/中继体系，归入 IR34-05、IR34-25、IR34-28、IR34-32。 |
| 规格 §3.1 | 适用（权威覆盖） | SessionState 写在 source fence 后不得 fresh append，既有会话权威事实须完整迁移并在 target 恢复，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.2 | 适用（权威覆盖） | GlobalState 写在 source fence 后不得 fresh append，既有全局权威事实须完整迁移并在 target 恢复，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.2b | 适用（权威覆盖） | DeferredIntent 的已接受/未终态事实须进入 catalog 并按原身份在 target 恢复，fresh intent 受 source fence，归入 IR34-08、IR34-11、IR34-18、IR34-24。 |
| 规格 §3.8 | 适用（安全边界） | 会话、全局状态及 control guard 必须在 fresh 写与迁后公开准入前维持身份、owner 与权限约束，归入 IR34-08、IR34-22、IR34-30。 |
| 规格 §3.3 | 适用（负边界） | EnvironmentPort 与原始本地路径不迁移，归入 IR34-11、IR34-30。 |
| 规格 §3.4 | 适用（上游终态边界） | 业务 ResourceLease 协议不改型；现有 active/queued/settled/reclaimed 身份只作为 accepted work 收束与迁后 pending 恢复输入，归入 IR34-09、IR34-24。 |
| 规格 §3.4b | 适用 | checkpoint/export/staging/import 每个物理步骤使用现有设备 storage governor，等待可取消且 permit 不跨网络/锁，归入 IR34-13、IR34-29。 |
| 规格 §3.5 | 适用（上游终态边界） | control/reviewer 的已接受 completion 只作为 drain 与可恢复 pending 输入，不新建迁居端口，归入 IR34-09、IR34-24。 |
| 规格 §3.6 | 适用（上游终态边界） | executor dispatch/commit/final 的已接受义务必须可判定收束或按原身份迁移，归入 IR34-09、IR34-24。 |
| 规格 §3.7 | 适用（上游终态边界） | submission/mirror 的已接受义务必须可判定收束或按原身份迁移，不改变既有协议，归入 IR34-09、IR34-24。 |
| 规格 §4.1 | 适用 | 唯一 `AuthorityCommitLog`、同 envelope/单次 sync、投影重建、source prefix 与 append fence 归入 IR34-06、IR34-10～IR34-12、IR34-17～IR34-19、IR34-26。 |
| 规格 §4.2 | 适用 | artifact 先耐久后引用、retained closure、私有 staging、共享 CAS 提升和缺件拒绝归入 IR34-11～IR34-15。 |
| 规格 §4.3 | 适用 | planned transfer records、trust/current-anchor/install/progress 事实必须 strict、单调、可重放，归入 IR34-02、IR34-06、IR34-14～IR34-27。 |
| 规格 §4.3 delivery 生命周期 | 适用（待办覆盖） | 不改 delivery 状态机；只核对所有未终态 delivery/final/outbox 均在 catalog 与迁后恢复中有落点，归入 IR34-09、IR34-24。 |
| 规格 §4.4 | 适用（兼容边界） | 迁居不得发布 staged mutation 或改变既有 CAS；仅迁移已提交/待办事实，归入 IR34-09、IR34-24、IR34-32。 |
| 规格 §4.5 | 适用（有限） | commit/abort 后 source/target staging、旧 source tombstone 与 artifact owner 必须按既有保留/GC 不误删共享 ref，归入 IR34-15、IR34-21、IR34-29。 |
| 规格 §5.1 | 适用（准入边界） | 既有控制请求入口全部受 source fence；迁居管理命令走独立 strict surface，归入 IR34-08、IR34-27、IR34-31。 |
| 规格 §5.2 | 适用（在途边界） | 既有派发协议不改型；已接受 dispatch 与未终态事实须可判定收束或迁移，归入 IR34-09、IR34-24。 |
| 规格 §5.3 | 适用（能力边界） | 既有 capability/lease/ticket 不扩权；活跃能力事实须作为 drain 或 pending 输入，归入 IR34-09、IR34-24、IR34-30。 |
| 规格 §5.4 | 适用（提交边界） | 既有 execution commit 不改型；效果前后失败、uncertain 与 exact replay 须在 drain/catalog 中闭合，归入 IR34-09、IR34-24、IR34-27。 |
| 规格 §5.5 | 适用（终态边界） | final/status/delivery 的已接受义务须可判定终态或按原身份迁移，归入 IR34-09、IR34-24。 |
| 规格 §5.6 | 适用（stream 边界） | 既有 stream 水位与重放语义不改；未消费终态须纳入迁后恢复，归入 IR34-09、IR34-24。 |
| 规格 §5.7 | 适用（取证/止损边界） | 已接受的 evidence/stop-loss 义务不得因 fence 丢失，须可收束或按原身份迁移，归入 IR34-09、IR34-11、IR34-24。 |
| 规格 §6.1 | 适用（conversation run 矩阵） | 36 行逐边判定见下表；fresh trigger 关闭，所有非终态/uncertain/待办不得简单丢弃，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.2 | 适用（user job 矩阵） | 38 行逐边判定见下表；fresh trigger 关闭，所有非终态/uncertain/delivery 义务完整，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.2b | 适用（system job 矩阵） | 6 行逐边判定见下表；fresh trigger 关闭，queued/running/fence/terminal/resource 事实完整，归入 IR34-08～IR34-09、IR34-24、IR34-34。 |
| 规格 §6.3 | 适用（直接） | planned 的 prepare→frozen→imported→committed→tombstoned、pre-commit abort、late abort 与断点重放逐边归入 IR34-06～IR34-27。conversation/disaster 分支只作类型隔离边界。 |
| 规格 §6.4 | 适用（逐行判定） | paired/configured/ready/degraded 的目标资格和 ReadyProof 适用；domain-reset/pending-reenroll 属第 35 单元且逐行判为不适用，归入 IR34-03、IR34-25、IR34-35。 |
| 规格 §7 | 适用 | 六类权威覆盖逐行决定 catalog 中应迁移、禁止迁移与重建内容，归入 IR34-11～IR34-12、IR34-18、IR34-24、IR34-30。CheckpointEnvelope 只作上游安全保障。 |
| 规格 §8 | 适用 | `device-trust` 的四个 RPC/CLI 与迁居 owner/receiver 直接适用；其余入口用于反向确认 source 写面和 pending obligation 无旁路，归入 IR34-08、IR34-23～IR34-24、IR34-28、IR34-31、IR34-36。 |
| 规格 §9 | 适用（兼容边界） | 本地域/锚点域能力矩阵不因 current anchor 切换扩权；executor-only 仍零全局写与 migration owner，归入 IR34-23、IR34-28、IR34-30。 |
| 规格 §10 | 适用 | workload/lease 终态表逐行约束 accepted work 的 drain 与迁后恢复，归入 IR34-09、IR34-24。 |
| 规格 §10.1 | 适用 | 设备 storage-maintenance 的容量、取消、stop、锁序和公平边界归入 IR34-13、IR34-29。 |
| 规格 §11 | 适用 | planned migration 产品旅程必须零内部术语且诚实表达可取消/不可取消与继续，归入 IR34-31。 |
| 规格 §12 | 适用 | 相关不变量、6.3 planned 逐边、签名篡改、崩溃点、双拓扑与零副作用对抗证据归入 IR34-27、IR34-33～IR34-34。 |
| 规格 §13 | 不适用 | 模块文档影响清单没有独立 S9 planned migration 条目；本单元不得据此扩写其他模块文档，当前总纲/规格/需求同步另由 D34-08 与 IR34-32 判定。 |
| 规格 §14 | 不适用 | S1 开工清单已完成且不属于第 34 单元。 |
| 规格 §15 | 适用（Unit 34） | 通用提交纪律和第 34 项全部适用；第 35～38 项不适用并受范围门禁，归入 IR34-01、IR34-33～IR34-35。 |
| unit-development-workbench.md 维护原则、§一 | 适用（流程/身份来源） | 用于确认当前动态区、Unit 34 身份与已定稿开发清单，不产生运行时合同，归入 IR34-01、IR34-36。 |
| 开发工作台 §二「目标与边界」「交付优先级与扩张门禁」 | 适用（范围来源） | 最小完整交付、架构优先、禁止未来能力扩面归入 IR34-01、IR34-35～IR34-36。 |
| 开发工作台 §二「架构与需求空洞裁决」 | 适用（边界来源） | 当前来源已唯一确定 planned migration 范围；如审查清单无法判定产品/单元边界才登记空洞，归入 IR34-01、IR34-36。 |
| 开发工作台 §三 | 不适用 | 生成/审查/开发提示词是过程模板，不新增 Unit 34 产品、架构或运行时验收合同。 |
| D34-01 | 适用 | strict transfer/ready/catalog/commit/abort/command/result/record 合同归入 IR34-02、IR34-27、IR34-32。 |
| D34-02 | 适用 | 目标资格、transfer issuer key、ReadyProof、prepared/staging 归入 IR34-03～IR34-06、IR34-14。 |
| D34-03 | 适用 | source checkpoint、准入 fence、drain、source prefix 与 freeze proof 归入 IR34-07～IR34-10。 |
| D34-04 | 适用 | AuthorityCatalog、planned export、private import、coverage exact-set 与资源边界归入 IR34-11～IR34-15。 |
| D34-05 | 适用 | source 唯一 commit、target authority base/install、TrustTransition/current anchor 原子发布归入 IR34-16～IR34-19。 |
| D34-06 | 适用 | takeover、pending 恢复、旧端 fencing、peer trust catch-up/tombstone 归入 IR34-21～IR34-25。 |
| D34-07 | 适用 | pre-commit abort、post-commit forward-only、启动恢复、并发/响应丢失、关闭归入 IR34-20～IR34-21、IR34-26～IR34-29。 |
| D34-08 | 适用 | CLI/server 产品旅程、两生产根 exact-set、S7/golden 与直接证据归入 IR34-28、IR34-31、IR34-33～IR34-34。 |
| 当前完整交付物 28 个非工作台路径 | 适用（生产事实） | core 5、CLI 16、server 2、架构 3、S7 2 个路径逐组反向归入 IR34-01～IR34-36；测试只作证据对象，不替代功能判断。 |

#### 适用枚举行逐条落点

| 枚举来源 | 逐条判定与审查项 |
| -------- | ---------------- |
| 规格 §6.1 conversation run 行 1～36 | 既有逐边语义不在本单元重审；每行产生或消费的 `queued/dispatched/running/cancel-requested/uncertain` 均是 IR34-09 的 drain 输入，terminal、outbox、interaction/effect 与 exact replay 是 IR34-24 的迁后义务，相关直接证据归 IR34-34。 |
| 规格 §6.2 user job 行 1～38 | 行 1～2 的 fresh trigger 受 IR34-08 fence；其余每行的非终态/terminal/uncertain/delivery 义务逐项归 IR34-09、IR34-24，既有状态语义不改，直接证据归 IR34-34。 |
| 规格 §6.2b system job 行 1～6 | 行 1 fresh trigger 受 IR34-08 fence；行 2～6 的 queued/running/fence/terminal/resource 事实逐项归 IR34-09、IR34-24，直接证据归 IR34-34。 |
| 规格 §6.3 AuthorityTransfer | planned 行 `0a/1/2/3a/4/5a/6/7/8` 分别归 IR34-06、IR34-08～IR34-10、IR34-14～IR34-21、IR34-27、IR34-34；disaster 行 `0b/3b/5b` 不适用，只作为 IR34-02/IR34-35 的 mode 隔离反例。 |
| 规格 §6.4 设备状态行 1～11 | 行 2～5 的 configured/ready/degraded 是 IR34-03/IR34-16 的直接 readiness 输入；行 1、6～9 只作为既有 paired/active/revoked trust 投影输入归 IR34-03/IR34-25，不在本单元新增转移；行 10～11 `domain-reset/pending-reenroll` 不适用并归 IR34-35 负边界。 |
| 规格 §7 六类覆盖行 | `全局状态与期望配置`→IR34-11/18/24；`会话状态`→IR34-11/18/24；`会话内容资产`→IR34-11/12/15/18；`环境事实与本地秘密`→IR34-11/30（禁止）；`执行资产`→IR34-11/12/18；`非权威缓存`→IR34-11/30（禁止/重建）。 |
| 规格 §8 `device-trust` | 直接 planned 产品入口及 owner/receiver 落点归 IR34-03、IR34-06、IR34-20～IR34-21、IR34-28、IR34-31。 |
| 规格 §8 权威写/待办行 | `session-send/run-cancel/uncertain-resolution/confirmation-resolve/permission-persist/trust-manage/conversation-manage/conversation-window/conversation-metadata/task-list/advancement/workscene-manage/workscene-switch/schedule-manage/schedule-run/schedule-timer/memory-write/skill-manage/skill-usage/segment-transition/orchestration-child/channel-inbound/channel-delivery` 逐行归 IR34-08、IR34-09、IR34-24；fence 后只允许已接受义务的有限收束。 |
| 规格 §8 只读/路由行 | `confirmation-read/session-observer/global-list-read/conversation-read/memory-read/status-read/light-inference` 逐行归 IR34-23～IR34-24；切换后只解析 current anchor，且不得借只读入口取得写能力。 |
| 规格 §8 本地/负边界行 | `environment-select/workspace-binding/runtime-lifecycle/advancement-evidence/runtime-config` 逐行归 IR34-09、IR34-24、IR34-30、IR34-35；仅迁移已接受的耐久义务，不迁环境、路径、秘密或本地配置。 |
| 规格 §8 `shutdown` / `recovery-backup` | `shutdown`→IR34-29；`recovery-backup` 仅作 Unit 33 current verified full checkpoint 上游接缝→IR34-07/IR34-32/IR34-35。 |
| 规格 §10 workload 终结表全部行 | run/job 的 committed、两类 cancelled、两类 failed/expired、uncertain→terminal、uncertain→queued、uncertain pending，以及 system job/control/evidence/orchestration-node 各行逐项归 IR34-09、IR34-24；本单元不改变既有 lease 终结语义。 |
| 规格 §12 不变量行 1～18 | `1/4/8`→IR34-17～IR34-23；`2/3/9/13/15/17`→IR34-08～IR34-09、IR34-18～IR34-24、IR34-27；`5/11/12/14`→IR34-28/32/33；`6/10/16`→IR34-03/16/22/30/32；`7`→IR34-05/21/27；`18`→IR34-09/13/29。全部只取 planned migration 的直接交界，不重审上游状态机。 |

### 交付路径反向覆盖

| 路径组 | 当前交付角色 | 归入审查项 |
| ------ | ------------ | ---------- |
| `packages/core` 5 路径 | `authority/{commit-log,index}.ts`、`contracts/identity.ts`、`protocol/{anchor-transfer,anchor-transfer.test}.ts`：strict identity/result、append fence、composite prefix install、exports 与协议证据各恰归一次。 | IR34-02、IR34-06、IR34-08～IR34-12、IR34-17～IR34-19、IR34-27、IR34-32～IR34-34 |
| `packages/cli` 16 路径 | `src/index.ts`；runtime duty command/facade及测试；serve 的 first-party router、两生产根、bootstrap store、planned owner/target/mesh/测试与 setup delivery。source/target、private import、phase、current-owner、lifecycle、CLI/DTO 与真实故障证据各恰归一次。 | IR34-03～IR34-34、IR34-36 |
| `packages/server` 2 路径 | `src/context.ts`、`src/rpc/methods/__tests__/server.test.ts`：management context、公开 DTO consumer 与直接证据。 | IR34-23、IR34-27、IR34-31、IR34-33～IR34-34 |
| 架构/需求/规格 3 路径 | `always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`：planned 边界、字段、状态机、landing row、用户旅程与验收。 | IR34-01～IR34-36 |
| S7 2 路径 | `scripts/s7-entry-coverage.mjs`、`scripts/s7-entry-coverage.test.mjs`：owner/receiver/role/order/RPC exact-set 与真实装配变异。 | IR34-28、IR34-33～IR34-36 |

### 审查项

> `[~]` 行的“证据记录”保留上一轮审查事实，仅供定位重审输入；因本轮合同、生产实现、装配或证据已经变化，它们不代表当前冻结交付物的通过/失败结论。后续独立审查必须基于当前指纹重新二元判定。

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR34-01 | [x] | 单元身份、边界与完整交付物 | 冻结当前 28 个非工作台路径并逐一反绑 D34-01～D34-08；只交付 planned current-anchor 迁居，不得混入 Unit 35 disaster/source-less recovery、Unit 36～38 生命周期或通用迁移/同步框架。 | 当前指纹 `6415cc1fb0e23841d0c7093f8a1dbd3868ff39e9` 工作区干净；HEAD 的 28 个非工作台路径与清单 core 5、CLI 16、server 2、架构 3、S7 2 分组全等。实现只开放 planned 迁居及既有 Unit 33 接缝，未发现后继恢复、连续同步或通用框架越界。 |
| IR34-02 | [x] | strict 合同、身份与摘要关联 | `ReadyProof`、`AuthorityCatalog`、planned `AnchorTransferCommit/Abort/Command/Result/TransferRecord` 与 `SourceFreezeProof` 必须是 exact-key 判别联合；request/transfer/source/target/epoch/ref/offset/commit/abort 逐字段反绑 originating command，JCS/digest/signature/schema/version 全等，planned/disaster/conversation 混型在副作用前拒绝。 | 复核 core strict decoder、mesh client/server 与 journal reducer：命令和结果先做 exact-key、schema/version、mode/state、签名、digest、originating request/transfer/device/epoch/ref/offset 全字段关联，再进入 I/O 或日志副作用；planned/disaster/conversation 混型稳定拒绝，未见 P0/P1。 |
| IR34-03 | [x] | 目标资格与 readiness | 候选/list/prepare 只接受另一台已配对、active、启用 anchor 角色的设备；ReadyProof 同时冻结 current home/trust generation、角色、配置能力、protocol/asset/service revision、SecretStore unlocked、有效期与目标身份，任一漂移/过期/离线给出稳定拒绝且零 prepared。 | 候选、summary、ready 与 prepare 均反绑另一 active anchor-role 成员、current home/trust chain、角色、配置能力、protocol/asset/service revision、SecretStore unlocked、期限和目标身份；漂移、过期、离线在 prepared 写前稳定拒绝。并发单飞缺口单列 IR34-04/06，不改变本项资格判定。 |
| IR34-04 | [~] | transfer issuer key 生命周期 | 目标 issuer key 必须在目标本机按 transfer 单飞生成、SecretStore 回读验真并以 possession proof 绑定 ReadyProof；prepare replay 同 key，pre-commit abort 只删该未激活 key，commit 原子激活后按 issuerKeyId 重载，私钥零 wire/log/status/error，设备 identity 与 issuer identity 不混同。 | **旧证据因 U34-09 修复失效，待复审。**target-wide durable claim 已置于 context/key/reservation/staging 前，同 transfer exact replay复用 key，异 transfer在首个私有副作用前拒绝；需按当前冻结指纹复核完整 key lifecycle。 |
| IR34-05 | [x] | 有限 mesh transport 与认证 | ready/transfer/source-range 只经现有认证 mesh 与 negotiated service；连接 peer、current source、prepared target、签名 keyId、phase exact-set 全等，未知/错方向/错设备/错命令在 target/source I/O 前拒绝，传输断连只重放同一 durable identity且不产生第二权威。 | ready/target/source-range 三个 negotiated service 均在 handler 前验证 authenticated peer、current source、prepared target、签名 keyId、phase 与 range allow-list；未知服务、错方向/设备/签名/命令零业务 I/O，传输不持第二权威，未见 P0/P1。 |
| IR34-06 | [~] | prepare、竞争与双端 durable identity | source/target `prepared` 必须共享稳定 requestId/transferId/source/target/sourceEpoch/nextEpoch/ready/transition；同载荷 exact replay，异载荷冲突；同一 home 同时至多一项非终态迁居，竞争在关闭准入或创建第二 issuer/staging 前拒绝。 | **旧证据因 U34-09 修复失效，待复审。**source authority transaction 与 target-wide claim transaction 已提供跨 transfer 线性化点，claim-before-effect、signed release与terminal replay已落地；需按当前冻结指纹复核双端 identity与全部竞争终态。 |
| IR34-07 | [x] | Unit 33 checkpoint 前置接缝 | source 只能消费 current root/current generation 的 verified full recovery checkpoint，或以 stable transfer request 复用既有 owner 强制取得；checkpoint envelope digest 仅作安全保障，不可替代 planned export/catalog/proof，未验证/旧 root/owner unavailable 不得进入 fence/commit。 | 已核对 `ensureRecoveryCheckpoint` 与 Unit 33 owner/status 接缝：仅复用 current generation 的 verified full checkpoint，缺失时以稳定 transfer request 调既有 force；返回的 envelope digest 只进入 prepared 安全前置，后续仍独立冻结/export/catalog/proof。未验证、旧代或 owner unavailable 不会进入 fence，未见 P0/P1。 |
| IR34-08 | [x] | source fresh admission 全写面栅栏 | 从 fence 线性化点起，第一方 RPC、channel input、session/global/task/intent、新 confirmation/interaction 生产、scheduler timer/manual trigger、新 delivery 生产及所有 `AuthorityCommitLog` 旁路均不得产生 fresh 权威事实；IR34-09 已耐久接受的 interaction/final/delivery 等只可走原身份有限收束，另只允许该 transfer 的 recovery/commit/abort 记录；abort 前无 durable fence 时可安全恢复。 | stopAccepting 先拒 channel ingress并暂停 scheduler，drain 后 append guard 在取得 source checkpoint 前串行安装；guard 只允许同 transfer、同 envelope closure 及 commit 的 trust/current entries，其余 RPC/global/task/intent/direct-log fresh append 均在日志锁内拒绝。durable abort 才清 guard并恢复原 owner/loops，未见 fresh 旁路。 |
| IR34-09 | [x] | accepted work drain 与终态诚实性 | fence 前已接受的 conversation/user job/system job、queued/active run、interaction/confirmation、staged publish、final/delivery/outbox/uncertain 必须逐类收束到可证明终态或作为明确 pending obligation 冻结；timeout/abortAll/flush/recovery-loop 失败不得伪造 drain 成功或丢弃义务。 | lifecycle 在 stopAccepting 后执行 conversation abort/drain并复核 `hasActiveWork()`、executor job drain、delivery flush，再停止 recovery loop；不可判定 active work 直接阻止 fence。剩余 assignment/interaction/final/delivery/intent/confirmation 从同一日志 checkpoint 投影为 pending，不伪造终态。 |
| IR34-10 | [x] | 唯一 source prefix 与 SourceFreezeProof | admission durable closed 且 IR34-09 完成后，source 只从同一 `AuthorityCommitLog` 取得一个 `{logId,lsn,frameEndOffset,prefixDigest}`；snapshot、export、catalog 与 `SourceFreezeProof(scope:"anchor")` 必须全等绑定同一 prefix，追加/坏尾/缺 ref/错 epoch 时 created/frozen/target import 零错误推进。 | guard 安装后取得唯一 DurableLogCheckpoint；分页 export、catalog.source、closure 与 signed `SourceFreezeProof(anchor)` 全等反绑 logId/lsn/frameEndOffset/prefixDigest/source epoch，target 再验证 canonical prefix与页尾。追加、坏尾、错 epoch/ref 均不能推进，未见 P0/P1。 |
| IR34-11 | [x] | AuthorityCatalog 六类覆盖 | 逐行核对规格 §7：global、conversation authority/content、execution assets、trust/current anchor 与全部 pending obligations 完整；环境事实、SecretStore、workspace raw path、设备/非权威缓存不可表示。streams、coverage、record/ref/count/digest canonical exact-set，少列、多列、重复、乱序、空置真实义务均 fail-closed。 | builder 从同一冻结前缀逐 envelope 统计 stream/count/digest、authority records、retained refs、trust/current 与六类 coverage；`PendingObligationTracker` 按 assignment/interaction/final/delivery/intent/confirmation 的生产记录和终态增删 exact-set。类型不表示环境、秘密、raw path或缓存；target 重算/反绑 catalog，未见少列或空置真实义务。 |
| IR34-12 | [x] | planned export 与 retained artifact 闭包 | 独立 planned export 只含 IR34-10 prefix 的 canonical commit envelopes，catalog 的 authorityRecords/retainedArtifacts 与真实引用闭包全等；artifact 先耐久后引用，共享/嵌套/大资产去重且 bytes/digest 全验，恢复 checkpoint 内容不得冒充 export，缺件不得 freeze/import/commit。 | source export 只序列化冻结前缀原 envelope并以 lifecycle index 枚举去重 retained exact-set；target freeze/import 在 transfer-private store逐 ref 拉取并验 bytes/digest/coverage，缺件或恢复 checkpoint 混绑不能写 imported。共享 CAS 仅在 commit 前从已验私有对象幂等提升，未见 P0/P1。 |
| IR34-13 | [x] | 容量治理与有界传输 | export、source range、target pull/private staging、promotion/install 每个物理步骤必须使用同一设备 `storageMaintenance` governor 与 lifecycle abort；buffer/part 固定上界，网络等待零 permit，permit 不跨 authority/store/lifecycle 锁；容量拒绝、磁盘满、取消/stop 要么零事实，要么保留唯一可重驱事实。 | export 以固定 commit page 落 ArtifactStore，manifest 受 header 上界；source range、target decode/write、promotion read/write 与 install 分别进入同一 governor。target 先完成网络 range 再持 permit 写本地，permit 不跨网络或外层锁；runtime AbortSignal/closing promise覆盖端口与恢复，失败保留 durable phase，未见 P0/P1。 |
| IR34-14 | [x] | target 私有 staging 与冻结验真 | target 只在该 transfer 私有 authority root/journal/ArtifactStore 接受 export/catalog/retained refs；range 连续且关联原 ref/offset/length，完整 bytes/digest/catalog/source-prefix/coverage exact-set 验真后才写 frozen/imported；部分、重复、重排、响应丢失和重启不串 transfer、不使共享 CAS/当前 authority 可见。 | `#context(transferId)` 固定独立 transfers/<id> 私有 root、ArtifactStore、partials/promotion-partials 与 journals/<id>；range 反绑 ref/offset/length并由 resumable receiver 校验连续性/digest。export/catalog/pages/retained exact-set 全验后才 imported，部分、重排、响应丢失和重启不进入共享 authority。竞争单飞缺口归 IR34-06。 |
| IR34-15 | [x] | import、共享 CAS 提升与清理边界 | imported 必须反绑 frozen export/catalog，promotion 对已有/共享 digest 幂等且不覆盖异 bytes；pre-commit abort 仅清私有 staging和未激活 key，绝不删共享业务 CAS；commit 后 retained refs 仍有唯一 owner，部分 base import/progress 可重驱且不形成可服务的半 authority。 | imported 反绑 frozen checkpoint/catalog/proof与完整 retained refs；promotion 先 `has(ref)`，否则由 digest-verifying receiver 幂等写共享 CAS，异 bytes 拒绝。abort terminal replay持续清私有 refs/key/root且不删共享 store；base 在 pointer sync 前不可见。post-install consumer缺口另归 IR34-19/21/24。 |
| IR34-16 | [x] | commit 前最终复验 | source 签 commit 前重新验证 current issuer/home/trust chain、ReadyProof 未过期且 capability/revision 未漂移、target/import/catalog/freeze/transition 全等、next epochs 单调；任一改变保持 source fenced 或可安全 abort，零 signed commit。 | existing-transfer `ready` 在目标 lifecycle 内重读完整 snapshot、secret/key并更新同 journal durable reservation；source commit前重调同 transfer ready，要求 proof digest/expiry/current snapshot全等，target commit再核对 reservation。trust/catalog/freeze/transition/epochs同步复验，revision change与 reservation互斥，未见响应窗口旁路。 |
| IR34-17 | [x] | source 唯一原子 commit 切点 | 当前 issuer 只能在 source 同一 `AuthorityCommitLog` envelope/一次 sync 原子追加唯一 signed planned commit，并使该 commit 所绑定的 prepared issuer-transition、next anchor/trust epochs 与 current-anchor 投影共同生效；不得另造第二切换事实。重复同决定零追加，异决定冲突；该 sync 后 append fence 永久 committed，旧 source 不因 target 未应答恢复。 | owner 在 journal 单次 transaction/envelope 同写 signed `anchor-committed`、prepared issuer-transition 与 `planned-anchor-source-committed` current projection；同决定回放零追加、异决定冲突。sync 后 committed fence永久保留且 `onSourceCommitted`先更新 resolver，target响应不明不恢复旧 source，未见第二切点。 |
| IR34-18 | [x] | authority base 导入与不可见性 | target 导入原 source commits 时必须保持 source LSN/envelope identity、stream exact-set和引用在场，可幂等断点续做；在最终安装 envelope sync 前，导入进度、records、投影和旧 current-owner 均不可被公开服务当作已接管 authority，冲突 progress fail-closed。 | target保留 source export 的原 envelope/LSN/digest并只从私有 artifacts提供 async source；`installPlannedAnchorPrefix` 在 log 锁内重建候选 WAL、逐封包验证原前缀，再以原子 rename+directory sync 一次发布 source base和installation envelope。sync 前 live reader/projection不可见候选，冲突/坏尾 fail-closed。 |
| IR34-19 | [~] | target 原子安装与服务开放 | target 逐字段验证同一 commit/transition/catalog/export/issuer key 后，在一个本地 `AuthorityCommitLog` envelope 原子发布 trust event/record、planned install、authority base/current anchor/next epochs；sync 后才激活 issuer、reconcile trust和开放服务，sync 后无决定性外部 I/O，效果后响应丢失只 exact replay。 | **旧证据因 U34-04 修复失效，待复审。**installation 已驱动角色无关 pre-bootstrap completion与固定 post-install consumer closure，readiness gate在三组consumer及六类pending完成前拒绝公开入口；需按当前冻结指纹复核原子发布至可服务终态。 |
| IR34-20 | [x] | pre-commit abort | prepared/fenced/frozen/imported 均只接受 current source 对同 request/transfer/sourceEpoch 的签名 abort；source 的 durable abort 是清 fence、以原 epoch 恢复准入/recovery/scheduler 的唯一线性化点，不等待跨设备物理清理。target 收到同一 abort 后先耐久隔离该 transfer 并拒绝任何后继 commit，再幂等清私有 staging、删除未激活 key；target 离线、清理失败、断连/丢响应/重启均保留同一投递/清理义务，异 abort 冲突。 | source 先在同一 journal 耐久写 signed abort，再立即清 append guard、恢复 recovery/scheduler/inbound，随后投递 target；启动和连接恢复会对同一 aborted state 重投。target 先写 terminal aborted，terminal replay继续删除私有 artifacts/key/root并释放 reservation；异 abort/late commit 冲突。跨设备清理失败不伪造 source 权威终态，未见独立 P0/P1。 |
| IR34-21 | [~] | post-commit forward-only 与 tombstone | source commit 后 late abort 永久拒绝；target 未提交、效果后丢响应、离线和连续重启只重发同 commit直至安装，source始终拒写；target已提交只 exact replay。旧 source cleanup/tombstone不得改变 authority或恢复 issuer，后续迁回只能新 transfer/更高 epoch。 | **旧证据因 U34-04 修复失效，待复审。**bootstrap会从已安装事实补exact key/private committed并重驱consumer，source仍永久fenced；需按当前冻结指纹复核每个post-commit切点、离线及连续重启。 |
| IR34-22 | [~] | 旧 source 全能力永久 fencing | commit 后逐项核对 control/session/global/job/delivery/confirmation/intent/assignment/signing/mesh receiver与直接 log append：旧 anchor、旧 issuer、旧 anchorEpoch/trustEpoch 全部 fail-closed，允许的重定向只基于已认证 current-anchor 事实且不得代理旧写。 | **旧证据因 U34-03 修复失效，待复审。**canonical registry-minus-device-local 已成为唯一relay exact-set，两生产根在首次副作用前解析current owner且离线不回退；需按当前冻结指纹复核旧source全部入口与永久fence。 |
| IR34-23 | [~] | current anchor 路由与第一方接管 | target 安装后 CLI/server/channel/scheduler/global state、会话列表/创建、确认/通知、任务及所有第一方管理入口只解析唯一 current anchor；source/target/其他设备对相同请求不会双写或显示两套值班事实，单机与分布式 surface 语义等价。 | **旧证据因 U34-03/U34-04 修复失效，待复审。**canonical finite relay、executor-only ownership composite、surface generation与post-install readiness gate已落地；需按当前冻结指纹逐方法复核三设备及local/current-anchor分流。 |
| IR34-24 | [~] | pending obligations 迁移与恢复 | AuthorityCatalog 必须从耐久事实枚举 assignment、interaction、final、delivery、intent、confirmation 等实际非终态 exact-set；target 接管后以原稳定 identity、水位和重试语义恢复，terminal replay不追加，源端无遗留 producer/loop，遗漏/多列/错 owner 在开放服务前失败。 | **旧证据因 U34-04 修复失效，待复审。**三组consumer按六种pending kind固定分区并复用既有recover/start，完成前current-owner gate保持关闭；需按当前冻结指纹复核identity、水位、重放与owner exact-set。 |
| IR34-25 | [x] | trust/peer 收敛与旧 issuer 拒绝 | issuer-transition 必须由旧 current issuer签名、指向 active anchor target的 transfer issuer public key并产生 next trust epoch；target `HomeTrustRecord` 可验签，在线/离线 peer重连后只接受新链头/issuer，旧签名和旧 epoch永久拒绝，合法既有 device-key transition兼容不漂移。 | source 在 target commit 回执验签后耐久 reconcile 同一 migration transition/record；target 安装同一 record。任一 active peer 重连时只可请求本地 chain head 后至多一个 signed migration issuer-transition，服务端验证祖先前缀，客户端用既有 `reconcileTrustSuffix` 验签/落盘；冲突链头、非 migration、多事件、旧 issuer均 fail-closed，未见独立 P0/P1。 |
| IR34-26 | [~] | 启动恢复顺序 | source 重启必须在任何公开 producer 前重装 durable fence并重驱 commit/abort；target重启从私有 journal/base progress恢复并在原子安装前保持服务关闭；双端事实不对称、坏尾、缺 artifact/key、冲突/歧义 fail-closed，连续重启最终唯一收敛且无双 owner。 | **旧证据因 U34-04 修复失效，待复审。**target在role/key gate前读取installation并补key/private progress，consumer closure在公开准入前继续重驱；需按当前冻结指纹复核live/startup顺序、坏尾和连续重启。 |
| IR34-27 | [~] | 并发、重放与严格结果终态 | prepare/fence/freeze/import/commit/abort/status/read-range 的并发、重复、异载荷、错 request/transfer/ref/offset/state和效果前后失败都二元落定；result先与 originating command关联再分类，stable conflict与retryable不混淆，任何拒绝在对应权威/存储副作用前发生。 | **旧证据因 U34-09/U34-04 修复失效，待复审。**跨transfer双端claim与install驱动terminal replay已闭合原两类切点；需按当前冻结指纹复核全部并发、异载荷、效果前后失败与strict correlation。 |
| IR34-28 | [x] | 两生产根与角色 exact-set | anchor+executor 与 anchor-only/current-anchor 各恰一 source/recovery owner，source range receiver 仅 current source；合格 non-current active anchor 可各有一个有限 readiness/strict receiver，但在首条 `prepared` 前零 transfer record/staging/recovery owner，prepared 后只有命中 targetId 的设备可持该非终态迁居。executor-only、surface、disabled、非 anchor 与未命中 target 的候选零迁居 owner/耐久状态；trust 换代时旧实例退役、新实例单次安装，零重复 listener/service。 | 两个生产组合根都只经 `MeshRuntimeAssembly` 动态安装当前 source owner或 active non-current anchor target；source/target negotiated services各唯一，角色变化先 dispose旧服务再安装新角色。executor-only、surface、disabled、非 anchor均无 planned owner；候选仅有有限 summary/ready入口。竞争线性化缺陷归 IR34-04/06，不是装配数量漂移，未见独立 P0/P1。 |
| IR34-29 | [x] | 生命周期、关闭与资源收束 | start 须先恢复 fence/transfer 再接公开流量；stop 先拒绝 fresh 管理/业务写，安全取消或等待当前物理 step，停止 owner/receiver/retry loop 并释放 permit/key handle/disposer；未终态事实留给重启。cleanup 失败不得伪造 abort/commit，也不得阻断已原子安装 target 或无迁居角色设备的普通业务；source 一旦 committed 仍永久 fenced，不得以“普通业务”名义复权。 | `PlannedAnchorTransferRuntimeLifecycle` 为全部 owner/receiver物理步骤提供单一 accepting gate、AbortSignal、in-flight集合与同一 closing promise；assembly.stop 先关闭该 runtime并等待全部在途 settled，之后才停 control/worker并 dispose服务。网络等待和 governor均消费同 signal，未终态 journal留待重启；source committed guard不会由 stop 清除，未见独立 P0/P1。 |
| IR34-30 | [x] | 安全、最小权限与数据隔离 | wire/log/catalog/export/RPC/错误只含必要稳定身份与ArtifactRef；秘密、恢复主秘密、SecretStore内容、环境、workspace绝对路径、设备缓存、raw store/log/通用读取删除能力零逸出；签名、peer、role、epoch、ref与path/容量guard均在首次对应副作用前验证。 | strict wire/records/catalog/RPC只携稳定 identity、签名对象和 ArtifactRef；issuer私钥只由 transfer-bound SecretStore helpers读写，raw log/store、环境和路径没有进入 public surface。认证 peer、role/epoch/ref/range与容量约束在对应 I/O 前验证，server/CLI映射稳定产品错误；并发单飞属于生命周期一致性而非秘密泄露，未见独立 P0/P1。 |
| IR34-31 | [x] | CLI/server 产品旅程 | `zz duty targets/migrate/continue/cancel` 与四个 authenticated `dutyMigration.*` 必须同源：列表稳定且 CLI/用户渲染只展示目标 `displayName`（opaque `targetDeviceId` 仅作内部选择关联，不直接展示），ready 缺口可行动，prepare 后明确仍可取消，commit 展示收束/传输/接管且结果不明可同编号继续，commit 后取消诚实拒绝；公开 exact keys/错误零 anchor/epoch/issuer/catalog/CAS/stream/secret/path/raw error 术语。 | 四个 RPC 与 CLI共用同一 management facade；target投影返回 displayName/ready，TTY按序号/设备名选择，非TTY只接受唯一名称，重名稳定拒绝，内部 deviceId仅在选中后传 strict prepare且不渲染。文案区分可取消、继续与 commit 后拒绝，公开错误不泄露内部术语，旧 P2 已修复，未见 P0/P1。 |
| IR34-32 | [x] | 分层、导出与上游兼容 | core strict合同、mesh trust/key/ready、owner-kernel drain、server投影、CLI组合根依赖方向无环且无复制事实源；Unit33 checkpoint/S2 trust/SecretStore/mesh/现有conversation transfer兼容，package export/build与供应链隔离不漂移。 | strict identity/protocol/commit-log留在 core，认证 mesh与key/readiness原语由既有层提供，server只定义/投影RPC，CLI持生产 owner、transport和组合根；没有反向依赖或复制权威事实源。Unit33 checkpoint、SecretStore、conversation transfer和S2受管依赖边界未改型，当前功能缺陷不要求破坏该分层，未见独立 P0/P1。 |
| IR34-33 | [~] | S7、registry 与 golden exact-set | 现有单一 S7 gate必须反绑两生产根issuer key注入、owner/target构造、service phase/role/order、recovery-before-admission、四CLI RPC与canonical server registry；新增/删除/重复/换序/绕过/错误root和动态未注册方法均fail-closed，合法拓扑/golden零误杀，不建新lint/发现框架。 | **旧证据因三项修复失效，待复审。**现有S7已扩展双端claim顺序/release、bootstrap/post-install completion、canonical registry与两生产根ownership composite，18/18及registry golden通过；需按当前冻结指纹独立复审全部变异。 |
| IR34-34 | [~] | 成比例的直接验收证据 | 必须有strict codec/reducer、ReadyProof/issuer transition、真实双端AuthorityCommitLog/FileArtifactStore/private staging、checkpoint接缝、source drain/fence、catalog/pending exact-set、双端commit/abort/response-loss/restart、旧epoch拒绝、两生产根与S7真实变异的直接证据；测试通过不得替代逐格功能判断，不做配置×故障笛卡尔积。 | **旧证据因三项修复失效，待复审。**当前新增真实异transfer并发、claim-only丢响应、install后key故障重启、六类pending、canonical exact-set/ownership及S7变异；需按冻结指纹逐格判断证据比例与功能终态。 |
| IR34-35 | [x] | 后继能力与非目标边界 | 逐路径确认未实现source-less/disaster recovery、restore/domain-reset/pending-reenroll/credential rotation、自动failover/quorum、continuous sync、服务托管/卸载/升级，也未改变Unit33 checkpoint语义或新增通用迁移/路由/事务/outbox/registry/监控诊断框架。 | 当前28路径只实现planned current-source迁居、Unit33 verified checkpoint窄接缝与有限管理/mesh面；未出现source-less/disaster、restore/reset/reenroll/rotation、自动failover/quorum/continuous sync或Unit36～38生命周期能力，也未建设通用框架，未见越界问题。 |
| IR34-36 | [x] | 来源、D34义务与路径反向闭包 | D34-01～D34-08、全部适用来源条款与28个非工作台路径必须按core合同、CLI source-target/assembly/management、server RPC、架构规格、S7和直接测试逐一归入IR34-01～IR34-35；零未判定来源/条款/枚举行/功能链/交付路径，零重复或无法独立判定条目。 | 已重读四份权威来源、定稿开发清单与当前交付；HEAD `6415cc1f…` 的非工作台路径实数为 core 5、CLI 16、server 2、架构 3、S7 2，共28项，与登记分组全等。所有适用章节、§6.1/6.2/6.2b/6.3/6.4枚举行、D34-01～08及生产路径均落入IR34-01～35；本轮反证已落在IR34-04/06/19/21～24/26～27/33～34，无未判定来源或路径。 |

> 正式问题 U34-01～U34-08 的既有修复结论未被无依据恢复；本轮对35项变化输入完成独立复审后发现3个新的或同根残留的阻断根因。11个 `[!]` 均已归入下表，其他25项没有独立 P0/P1；原 P34-12 已按价值裁决并入三项根因的必要验收证据。

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
