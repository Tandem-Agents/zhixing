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
目标：只收敛第 33 单元正式问题列表中同根重开的 U33-04 一个 P1，使其真正命中已有配对设备首次恢复根在 source 已激活、target 未提交且 trust chain 前进后，terminal replay 仍由最新事件启发式代替 originating checkpoint 耐久身份的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U33-05、U33-10、其余 U33 问题与 EX33-01 的既有结论直接复用，cleanup 启动门禁、O(total) 驻留、内部状态泄露及第 34～38 单元能力不得恢复或提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 33 单元正式文件中的 U33-04、EX33-01，只依据该问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 从权威架构、规格和当前生产调用图重建 U33-04 的事实链，核准 root-activation checkpoint、verified `activationDigest`/targetId、历史 `recovery-root(establish)` event、激活时 `HomeTrustRecord`、source/target trust store、finite/active receiver、`currentPairedRootActivation()` 与 S7/直接测试的唯一事实源、稳定身份、线性化点、消费者、异常终态、当前损失、受影响审查项、P1 评级和中工作量；明确区分“root event仍为最新时可 immediate replay”与“trust chain 前进后原 checkpoint 不可重放”。既有历史修复与价值裁决未被新生产事实触发时不得恢复原主张或扩面方案。
2. 穷尽直接变体：覆盖已有 active paired device 且无恢复根的 v1/v2，source 激活前/后失败、target 提交前断连、target 效果后响应丢失、source 追加合法非根 trust event、进程重启/重连、finite/active terminal replay、同/异 checkpoint、错 activationDigest/targetId/event/record，以及目录 setup 与新设备 onboarding 回归边界。每格必须指出 originating checkpoint 身份、耐久事实、双端线性化点、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：只在现有 `FileMeshBootstrapStore` 增加按已验证 root-activation checkpoint 的 `activationDigest`/targetId 定位并验真历史 event/record 的只读窄查询，让 `currentPairedRootActivation()` 复用该原始 tuple 与现有 `activateRoot`、target plan 校验和 finite/active exact replay；扩展现有 S7 与一条真实双端故障测试反绑该查询。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增 trust fact、pending 队列、通用同步/查询/路由/存储/事务/outbox/事件总线/registry、新 lint/test runner、监控、诊断、benchmark 和信息采集。发现缺口时直接修正 U33-04，使执行者无需实现猜测即可一次完成。
4. U33-04 看似闭合后，对同一份未修改记录执行四路冷启动对抗复审：originating checkpoint 与历史 trust tuple、source/target 双端 terminal replay 和连续恢复、finite/active topology 与 S7/真实证据、产品体验/范围价值及历史裁决边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 U33-04 与 EX33-01、第 34～38 单元及 U33-05/U33-10 既有结论的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改的 U33-04 记录通过四路冷启动对抗复审；全部受支持 v1/v2 root-activation、双端提交顺序、trust chain 前进、terminal replay、错误关联、响应丢失与连续恢复终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会因同根残留继续局部返工。满足后明确回复“U33-04 同根重开问题的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 33 单元同根重开的 U33-04 一个 P1，闭合已有配对设备首次恢复根在 source 已激活、target 未提交且 trust chain 前进后的 originating checkpoint 耐久重放及全部同根直接变体；不得扩展到其他问题或全单元流程。U33-05、U33-10、其余 U33 问题与 EX33-01 的既有结论直接复用，cleanup 启动门禁、O(total) 驻留、内部状态泄露及第 34～38 单元能力不得恢复或提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 33 单元正式文件中的 U33-04、EX33-01，只依据该问题最新的根因、价值裁决、F33-41～F33-49 固定矩阵、方案、验收条件、反证账和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F33-41～F33-49 固定矩阵。覆盖已有 active paired device 且 source/target 无恢复根的 v1/v2、source 原子激活前后失败、target 提交前断连、target 效果后响应丢失、source 追加合法非根 trust event、进程重启/重连、finite/active terminal replay、同/异 checkpoint、错 activationDigest/targetId/event/record、root 换代，以及目录 setup 与新设备 onboarding 回归边界。逐格绑定包内 identity、`recovery-activation-committed`、同 authority LSN 的 verified/event/record、双端线性化点、零副作用边界和直接证据，并持续核对历史裁决、EX33-01、U33-05/U33-10 与第 34～38 单元边界。
2. 一次完成：在现有 `FileMeshBootstrapStore` 增加唯一只读窄查询 `loadRecoveryRootActivationReplay({ activationDigest, targetId })`。选主只能来自 checkpoint 流中恰一 `recovery-activation-committed(checkpointId)`：plan 必须为 establish 且 digest 全等，verification 的 checkpointId/targetId 与其 checkpointRecords 中的 verified 证据全等；再按该提交 authority LSN 取得全等 root event 与同链头 `HomeTrustRecord`，重放至该 LSN 验签并确认该前缀仍为 current trust 祖先、current activationDigest 未换代。零匹配返回 undefined；多匹配、错 LSN、缺项、重复、错 event/record 或冲突一律 fail-closed，禁止从 verified 反向任选 latest。

   `currentPairedRootActivation()` 只委托该查询并返回原 checkpointId/event/record，删除对 `loadTrustEvents().at(-1)`、current chain head、latest `HomeTrustRecord` 和 reverse verified 的直接推断；随后原样复用现有 `activateRoot`、target staging plan 校验、finite fresh commit 与 active exact replay。扩展现有 S7 有限规则反绑 store 查询、helper 唯一委托和禁止 latest-head/current-record 回退，并补一条 v1/v2 参数化真实双端故障场景；不改 `BootstrapAuthorityPort`，不新增 trust fact、pending 队列、同步/查询/路由/存储/事务/outbox/事件总线/registry、新 lint/test runner、监控、诊断、benchmark 或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、backup setup/root activation 直接测试、现有 S7 lint 与必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过 source/target 两份真实 `FileMeshBootstrapStore`、paired transport/staging 与 target trust append：source 激活后在 target 提交前断连，追加合法非根 trust event并重启/重连；另覆盖 target 效果后响应丢失、finite/active、同/异 checkpoint、错 digest/target/event/record和root换代。不得以 mock 自报历史关联或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与 U33-04 验收无关的验证。失败先归因，实现问题直接修复并回到第 2 步。
4. 验证通过后冻结当前交付物指纹，整轮只读地逐格重建 U33-04 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：originating checkpoint 与历史 trust tuple、source/target 双端 terminal replay 和连续恢复、finite/active topology 与 S7/真实证据、产品体验/范围价值及历史裁决边界。各角色须抛开既有结论，主动重造第 1 步全部适用反例，并核查 U33-04 与 EX33-01、第 34～38 单元及 U33-05/U33-10 既有结论的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第 2 步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U33-04 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C33-C50～C33-C51 及新增同根反证全部有耐久处置，证明 originating activation commit 是唯一 replay 身份，同 LSN 历史 event/record 在 current trust 合法前进后仍可验真重放；source 提交前失败零 tuple，source 已提交且 target 未提交可连续恢复，target 已提交只 exact replay；错误、歧义、换代输入零 trust 副作用，finite/active、v1/v2 与目录/onboarding 边界零漂移，latest-head 实现会被现有 S7 和真实故障场景共同拒绝。历史裁决重开条件仍不成立，EX33-01、U33-05/U33-10 与第 34～38 单元边界未改变，U33-04 已更新为“已验证”。满足后明确报告“U33-04 同根重开问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 33 单元 · generation 1
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D33-01～D33-08；上游只按现行 S2 root-activation `CheckpointEnvelope`、`RecoveryActivationCoordinator` / `RecoveryCheckpointTarget`、`FileMeshBootstrapStore`、当前 anchor 唯一 `AuthorityCommitLog` / `ArtifactStore` / ArtifactLifecycleIndex / storage governor 合同消费，下游只冻结第 34 单元取得“当前根、已验证、全量”检查点的窄接缝与第 35 单元解封载荷合同
- **交付基线**：当前 `HEAD 67af121f…` 加工作区 U33-04 专项交付，`dd50eec8` 至当前工作区共 61 个非工作台功能/架构/测试路径，内容指纹 `027fb83d24912a5d7885af61abd7d5029d5505f024107641d31298d6994868be`；`research/design/workbench/` 6 个流程路径不参与功能指纹。此前 `0c9c6d20…`、`92953a6e…`、`16a896e8…`、`1004b849…`、`8156307a…`、`c66cd68d…` 仅作历史输入
- **生产装配关系**：trusted-home current anchor 或显式启用备份的单机 current anchor 复用同一 authority log、artifact store、storage governor 与 root-activation 加密内核，装配恰一 `AuthorityCheckpointOwner` / `AuthorityCheckpointService`；已有配对设备且无恢复根时只启动 current-issuer 的有限 strict checkpoint topology，激活前普通业务关闭；owner 捕获冻结日志前缀及保留资产闭包并复制到单目标 adapter，current-generation 耐久 readiness 独立于 target/runtime availability 投影给 CLI/server；三个 paired client 共用设备 storage governor
- **目标提交边界**：只交付同一 `CheckpointEnvelope.v1` 下的全量 authority payload、每日与迁居前强制创建/复制接缝、单目标目录/配对设备 adapter、恢复包真解封、`fullBackupReady`、新代替换与 27 天回收，以及两生产根的唯一 owner、生命周期、管理入口、S7 门禁和直接证据
- **明确排除**：第 34 单元 `SourceFreezeProof(anchor)`、AuthorityCatalog 导入、`TrustTransition`、`ReadyProof`、planned `AnchorTransferCommit`、旧锚点 tombstone 与 current-anchor 切换；第 35 单元恢复应用、disaster-recovery commit、domain-reset/reenroll、凭据轮换与灾难恢复旅程；第 36～38 单元；环境事实、设备秘密、SecretStore 内容、workspace 原始路径、本机执行缓存、非权威缓存与旧 checkpoint 自身递归闭包；未显式启用单机备份时新增恢复概念；多目标 quorum、云存储、连续同步及通用事务/outbox/事件总线/registry/扫描/备份框架、监控、诊断、benchmark 和信息采集
- **当前任务进度**：U33-04 专项冻结指纹 `1b2df67629a3e9269b40a275a6784a3dc63708c5` 的 9 个受影响项已完成独立复审；当前为 0 项 `[ ]`、36 项 `[x]`、0 项 `[!]`、0 项 `[~]`。P0/P1 与非阻断问题列表均为空，独立审查通过
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：独立审查通过。原 27 项 `[x]` 依据事实未变化直接复用；9 个受 U33-04 历史 tuple 查询、backup helper、S7、架构规格与直接证据变化影响的项目已在当前完整交付物上重新独立判定为 `[x]`。36 项全部完成，P0/P1 与非阻断问题列表均为空。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线值班设备与本机真实工作环境并存的核心问题归入 IR33-01、IR33-17、IR33-27、IR33-34。 |
| 需求文档 §二 | 不适用 | 对外部回复的原始信息整理是需求形成材料，不是第 33 单元规范性合同。 |
| 需求文档 §三 | 不适用 | 对既有执行事实的阶段性核验不是 S9 字段、状态或验收合同。 |
| 需求文档 §四 | 不适用 | 架构者历史审核过程不独立产生当前实现义务，现行义务以总纲和规格为准。 |
| 需求文档 §五 | 不适用 | 对历史现状的归纳不是本单元交付合同。 |
| 需求文档 §六 | 适用 | “持续在线值班设备 + 本机真实工作环境”的目标及用户自持恢复能力归入 IR33-17、IR33-21～IR33-23、IR33-27、IR33-34。 |
| 需求文档 §七 | 适用 | 两种形态的当前价值、范围收敛与不牺牲用户体验归入 IR33-01、IR33-23、IR33-27、IR33-34～IR33-36。 |
| s2-security-supply-chain-review.md「裁决」 | 适用（兼容边界） | 当前交付修改 `@zhixing/mesh` manifest/exports 并复用 Node crypto；须确认既有三个生产依赖和一个受控开发依赖的用途边界、精确版本与生产隔离未被改变，归入 IR33-34。 |
| S2 供应链评审「强制门禁」 | 适用（兼容边界） | `packages/mesh/package.json` 与构建子入口变化不得改变受管依赖 owner、精确锁版或把 PAKE 适配器带入生产 export/build；复用既有 supply-chain gate，不新增门禁，归入 IR33-30、IR33-34。 |
| S2 供应链评审「接受依据」 | 适用（兼容边界） | S9 不新增密码依赖、不改证书/PAKE 实时边界，full checkpoint 仅复用既有 Node crypto 和已审 mesh 通道，归入 IR33-09、IR33-34。 |
| distributed-runtime-charter.md「当前版本交付原则」 | 适用 | 最小完整产品、锁定范围内最优架构及不得预建未来框架归入 IR33-01、IR33-35～IR33-36。 |
| 总纲「一、架构概况」 | 适用 | 单一产品、单机/分布式同构与用户持有恢复能力归入 IR33-01、IR33-17、IR33-27、IR33-34。 |
| 总纲「二、凝练后的需求点」 | 适用 | 值班设备持续在线、设备扩展和可恢复性的当前产品目标归入 IR33-17、IR33-21～IR33-23、IR33-27、IR33-34。 |
| 总纲 §1 | 适用 | 单机是分布式退化形态、current anchor 唯一权威与角色复用归入 IR33-01、IR33-17、IR33-27、IR33-34。 |
| 总纲 §2 | 适用 | anchor/executor/surface 角色、issuer/paired target 与组合根边界归入 IR33-11～IR33-17、IR33-27～IR33-30。 |
| 总纲 §3 | 适用 | core→mesh→cli/server 的无环依赖、共享原语和组合根职责归入 IR33-02～IR33-10、IR33-27、IR33-30、IR33-34。 |
| 总纲 §4 | 适用（复用边界） | 恢复根、设备身份、签名、认证 mesh、最小权限与秘密隔离归入 IR33-02～IR33-04、IR33-09～IR33-16、IR33-20～IR33-22、IR33-31、IR33-34；不重审既有配对密码学。 |
| 总纲 §5 | 适用 | 六类权威所有权、完整 authority scope 与禁止类别归入 IR33-02、IR33-05～IR33-07、IR33-31。 |
| 总纲 §6 | 不适用（守边界） | run/job 派发、提交与 finality 不是全量备份的新能力；S9 只保存其已提交权威记录，不审 run 协议行为。 |
| 总纲 §7 | 适用（负边界） | 环境事实、workspace 原始路径和设备本地缓存永不入备份，归入 IR33-07、IR33-31；环境选择与路由行为不重审。 |
| 总纲 §8 | 适用（有限交界） | paired target 只复用认证 mesh 的有限 request/response、响应丢失与重连语义，归入 IR33-14～IR33-16、IR33-28、IR33-31。 |
| 总纲 §9 | 适用（当前 S9 块） | 全量检查点、单目标、真回读、恢复包、双 readiness、替换与保留全量归入 IR33-02～IR33-26。planned/disaster transfer 与恢复应用不适用，归 IR33-35 守界。 |
| 总纲 §10 | 适用（当前生命周期交界） | 启动先恢复 checkpoint 义务、关闭拒绝新创建并释放资源归入 IR33-17～IR33-19、IR33-27～IR33-29；托管服务、移除与卸载属于后继单元。 |
| 总纲 §11 | 适用 | “恢复备份”的用户语言、明确配置、待验证/可恢复和下一动作归入 IR33-21～IR33-23。 |
| 总纲 §12 的 checkpoint 直接故障与共同边界 | 适用 | owner/进程崩溃、日志坏尾、磁盘满、paired 传输中断/重连/响应丢失、active target 撤销或角色失效、版本偏斜和 anchor 时钟偏斜逐项归入 IR33-03～IR33-05、IR33-10～IR33-18、IR33-20、IR33-23、IR33-28、IR33-32～IR33-34。 |
| 总纲 §12 的 run/assignment/final、S8 本地域/收编、planned transfer/旧锚点、灾难恢复、外部凭据清退与渠道专属故障 | 不适用 | 分别是既有能力或第 34～38 单元义务；S9 仅在 IR33-34～IR33-35 检查共同装配不回归、后继能力未提前启用。 |
| 总纲 §13 不变量 5、6、11～14、18 | 适用 | 角色零装配、秘密零入备份、双生产形态同构、用户完成语义、依赖边界与设备容量治理逐条归入 IR33-06～IR33-10、IR33-17、IR33-21～IR33-23、IR33-27、IR33-30～IR33-34。 |
| 总纲 §13 不变量 1～4、7～10、15～17 | 不适用（守边界） | conversation/run/job/transfer/capability/control 专属断言不由 S9 修改；共同装配点只做 IR33-34 的有限兼容核对。 |
| 总纲 §14 S9 第 33 单元 | 适用 | 当前实施顺序、前置能力、下游接缝与停止条件归入 IR33-01～IR33-36。 |
| 总纲 §14 其他单元 | 不适用（边界） | 上游仅消费现行合同；第 34～38 单元能力不得进入当前装配、wire 或验收门禁，归 IR33-35。 |
| 总纲 §15 | 适用 | 双生产形态、故障/安全矩阵、用户语言和成比例证据归入 IR33-27～IR33-36。 |
| specification.md §1.1 | 适用 | checkpoint/home/device/key/target/log/LSN/ref 的规范身份与时间归入 IR33-02～IR33-05、IR33-11、IR33-17～IR33-20。 |
| 规格 §1.2 | 适用 | JCS、严格未知字段、Digest/ArtifactRef、自摘要、签名域和 exact-set 归入 IR33-02～IR33-04、IR33-06、IR33-09～IR33-16、IR33-20。 |
| 规格 §1.3 | 适用（引用边界） | 既有 conversation/global/execution 符号只按权威模块身份被 checkpoint 覆盖判别消费，归入 IR33-02、IR33-05～IR33-07；不复制或改写上游类型。 |
| 规格 §1.3b | 适用（覆盖边界） | 与检查点保留闭包相关的权威记录/资产身份必须保持冻结字段语义，非权威派生状态不得入载荷，归入 IR33-02、IR33-06～IR33-07。 |
| 规格 §1.4 | 适用 | 总纲与规格构件名必须与 checkpoint/target/readiness 代码合同一一对应，归入 IR33-02～IR33-04、IR33-17、IR33-35。 |
| 规格 §1.5 | 适用 | backup 管理、target/codec 与耐久重放错误必须结构化、稳定且不泄密，归入 IR33-04、IR33-11～IR33-16、IR33-20～IR33-23、IR33-31。 |
| 规格 §2.1 | 适用 | recovery root、activation plan、checkpoint envelope/verification 与 checkpoint stream 身份归入 IR33-02～IR33-04、IR33-09～IR33-10、IR33-18～IR33-21。 |
| 规格 §2.2 | 适用 | issuer/recipient、purpose、scope、签名、受众和 replay 防护归入 IR33-02～IR33-04、IR33-09～IR33-16、IR33-20、IR33-31。 |
| 规格 §2.3 | 适用（负边界） | 恢复主秘密不得进入现有 SecretStore/credentials 迁移、配置、argv/env 或日志；创建/复制端不持主秘密，归入 IR33-03、IR33-21、IR33-31。 |
| 规格 §2.4 | 不适用（守边界） | CredentialExposureRecord 与第三方凭据撤销不由 S9 修改；设备秘密零入备份由 §2.3/§7 承载。 |
| 规格 §2.5 | 适用（复用） | paired target 与首次 onboarding 复用既有认证 mesh、成员状态和角色授权，归入 IR33-14～IR33-16、IR33-27、IR33-31、IR33-34。 |
| 规格 §3.1 | 不适用（数据只经日志覆盖） | SessionStatePort 行为不由 S9 调用或改写；已提交会话事实是否入备份由 §4/§7 和 IR33-05～IR33-07 审查。 |
| 规格 §3.2 | 不适用（数据只经日志覆盖） | GlobalStatePort 行为不由 S9 调用或改写；已提交全局事实是否入备份由 §4/§7 判定。 |
| 规格 §3.8 | 不适用 | mutation principal/guard 表不是 checkpoint 管理入口；S9 不新增业务 mutation。 |
| 规格 §3.2b | 不适用（数据只经日志覆盖） | DeferredGlobalIntentPort 不由 S9 执行；已提交 intent 仅作为 conversation authority 记录随冻结前缀覆盖。 |
| 规格 §3.3 | 适用（负边界） | EnvironmentPort 的路径、环境事实与设备域状态不可进入 payload/wire，归入 IR33-07、IR33-31；不审环境路由行为。 |
| 规格 §3.4 | 不适用 | ResourceReservationPort 是用户工作负载授权；checkpoint 物理工作只用设备本地 storage governor。 |
| 规格 §3.4b | 适用 | capture、目标写/读、paired staging 与 retention 复用设备唯一 storage governor，归入 IR33-08、IR33-12～IR33-16、IR33-25、IR33-28、IR33-32。 |
| 规格 §3.5 | 不适用 | ControlCompletion/AdvancementReviewer 不参与 checkpoint。 |
| 规格 §3.6 | 不适用 | RunExecutorPort 不参与 checkpoint 创建、复制或验证。 |
| 规格 §3.7 | 不适用 | RunSubmissionPort 不参与 checkpoint 创建、复制或验证。 |
| 规格 §4.1 | 适用 | 当前 anchor 唯一 AuthorityCommitLog、冻结 `DurableLogCheckpoint`、checkpoint 流和投影恢复归入 IR33-05、IR33-17～IR33-20、IR33-24～IR33-29。 |
| 规格 §4.2 | 适用 | ArtifactStore、内容寻址、先资产后引用、保留闭包与共享 ref 安全归入 IR33-06～IR33-10、IR33-13～IR33-15、IR33-25。 |
| 规格 §4.3 的 checkpoint 逻辑流与信封块 | 适用 | `CheckpointEnvelope`、full payload、created→replicated→verified→superseded、readiness 和 root activation 原子边界归入 IR33-02～IR33-26。 |
| 规格 §4.3 的 control/run/job/assignment/publish/final/delivery 等其他逻辑流 | 不适用（覆盖边界） | S9 只备份这些流中已提交且按 §7 应保留的记录，不执行或改写各自生命周期；其完整纳入由 IR33-05～IR33-07 判定。 |
| 规格 §4.4 | 不适用 | 业务 mutation 提交模型不由备份修改；checkpoint service 只追加自身权威记录。 |
| 规格 §4.5 | 适用 | checkpoint 终态保留、ArtifactLifecycleIndex 复核、远端回收失败重试归入 IR33-06～IR33-07、IR33-24～IR33-26。 |
| 规格 §5.1 | 不适用 | 本节是既有 ControlEnvelope 控制请求，不是 paired checkpoint 协议；backup CLI 为本机管理入口，paired finite wire 由 §1.2/§7/§8 承载。 |
| 规格 §5.2 | 不适用 | conversation/job 派发协议不由 S9 修改。 |
| 规格 §5.3 | 不适用 | 既有 capability/版本匹配不由 S9 修改；paired receiver 只复用认证成员/角色边界。 |
| 规格 §5.4 | 不适用 | run/job 提交 CAS 不由 S9 修改。 |
| 规格 §5.5 | 不适用 | run/job/delivery 终态与状态投递不由 S9 修改。 |
| 规格 §5.6 | 不适用 | run stream 不由 S9 修改。 |
| 规格 §5.7 | 不适用 | EvidenceRequest/止损不由 S9 修改。 |
| 规格 §6.1 | 不适用 | conversation run 状态机不是 checkpoint 状态机。 |
| 规格 §6.2 | 不适用 | user job 状态机不是 checkpoint 状态机。 |
| 规格 §6.2b | 不适用 | system job 状态机不是 checkpoint 状态机。 |
| 规格 §6.3 | 不适用（守边界） | AuthorityTransfer 属第 32/34 单元；IR33-29、IR33-35 只检查 forced 接缝不提前执行迁居。 |
| 规格 §6.4 | 不适用 | 设备状态与 UncertainResolution 不由 S9 修改。 |
| 规格 §7 六类权威覆盖表 | 适用 | 完整 authority scope、保留资产、禁止秘密/环境/缓存类别及旧 checkpoint 防递归归入 IR33-02、IR33-05～IR33-07。 |
| 规格 §7 CheckpointEnvelope 与全量备份块 | 适用 | 单一信封、全量 payload、目标绑定、分块、真回读、双 readiness、新旧恢复包和 27 天保留归入 IR33-02～IR33-26。 |
| 规格 §8 `recovery-backup` 行 | 适用 | setup/verify/status、daily/forced 接缝、current anchor owner 与 paired receiver 的生产落点归入 IR33-17、IR33-21～IR33-23、IR33-27～IR33-30。 |
| 规格 §8 `status-read` 行 | 适用（共同消费端） | server.info、`/status` 与 `zz status` 对双 readiness 的同一只读聚合和兼容归入 IR33-22～IR33-23、IR33-30、IR33-34。 |
| 规格 §8 `device-trust` 行 | 适用（首次 pairing 交界） | 只审 `zz pair` 首次 onboarding 在 full checkpoint 真回读后才开放业务 mesh，归入 IR33-16、IR33-19、IR33-30、IR33-34；迁居/撤销能力不在本单元。 |
| 规格 §8 `shutdown` 行 | 适用（共同生命周期入口） | 只审既有 serve stop/shutdown 能拒绝新 checkpoint、等待安全边界并释放 owner/receiver/permit，归入 IR33-28、IR33-30、IR33-34；不实现 S10 三路径协议。 |
| 规格 §8 其余落点 exact-set | 不适用（兼容边界） | `session-send`、`environment-select`、`run-cancel`、`uncertain-resolution`、`confirmation-resolve`、`confirmation-read`、`session-observer`、`global-list-read`、`permission-persist`、`trust-manage`、`conversation-manage`、`conversation-window`、`conversation-metadata`、`conversation-read`、`task-list`、`advancement`、`workscene-manage`、`workscene-switch`、`schedule-manage`、`schedule-run`、`schedule-timer`、`memory-write`、`memory-read`、`skill-manage`、`skill-usage`、`segment-transition`、`workspace-binding`、`runtime-lifecycle`、`advancement-evidence`、`orchestration-child`、`channel-inbound`、`channel-delivery`、`light-inference`、`runtime-config` 不因 S9 新增能力；只在 IR33-30、IR33-34 检查现有映射未被备份入口误接入或绕过。 |
| 规格 §9 | 不适用 | 会话域能力矩阵不是备份管理面合同；本单元只保存已提交权威事实，不新增会话能力。 |
| 规格 §10 | 适用（通用上界） | checkpoint 明文/密文/目录/网络工作必须保持有界、可取消、无锁序反转，归入 IR33-08、IR33-10、IR33-12～IR33-16、IR33-28、IR33-32。 |
| 规格 §10.1 | 适用 | capture、目标写/读、paired staging 与 retention 作为 `authority-checkpoint` maintenance kind 复用唯一 storage governor，归入 IR33-08、IR33-13～IR33-16、IR33-25、IR33-28、IR33-32。 |
| 规格 §11 | 适用（当前相关行） | 开箱零恢复概念及首次 pairing 的恢复包展示、回读验证后才继续归入 IR33-16、IR33-21、IR33-23、IR33-34；后续 `zz backup` 文案以总纲 §11 和规格 §7 为依据。 |
| 规格 §12 不变量 5、6、11～14、18 | 适用 | 角色零装配、秘密零入 wire/backup、双拓扑同构、用户完成语义、依赖边界与设备容量治理归入 IR33-08、IR33-17、IR33-21～IR33-23、IR33-27、IR33-30～IR33-34。 |
| 规格 §12 不变量 1～4、7～10、15～17 | 不适用（守边界） | conversation/run/job/transfer/capability/control 专属断言不由 S9 修改；共同装配点只做 IR33-34 的有限兼容核对。 |
| 规格 §13 | 不适用 | 模块文档影响表没有 S9 目标行；当前仅同步本模块总纲/规格，不得据此横扫 scheduler、transcript、delivery 等其他模块文档。 |
| 规格 §14 | 不适用 | S1 历史开工清单不是第 33 单元现行合同。 |
| 规格 §15 第 33 单元 | 适用 | 当前实现范围、顺序与验收枚举行归入 IR33-01～IR33-36。 |
| 规格 §15 第 34～38 单元 | 不适用（边界） | AuthorityCatalog/import/restore/TrustTransition/ReadyProof/current-anchor 切换与服务发布不得提前实施，归 IR33-29、IR33-35。 |
| S2 root-activation 生产合同：checkpoint.ts、bootstrap-authority.ts、mesh-bootstrap-store.ts、mesh-pair-command.ts | 适用（上游） | periodic/full 与 root-activation 共用信封、密码内核、真回读、原子 root activation 和旧 trust-only 兼容归入 IR33-03～IR33-04、IR33-09～IR33-10、IR33-16、IR33-19、IR33-21、IR33-34。 |
| 当前 authority/storage 生产合同：AuthorityCommitLog、ArtifactStore、ArtifactLifecycleIndex、storage governor | 适用（上游） | 唯一事实源、前缀、资产闭包、引用安全、容量和回收归入 IR33-05～IR33-08、IR33-13、IR33-18～IR33-20、IR33-24～IR33-25、IR33-32。 |
| 第 34/35 单元下游接缝 | 适用（仅冻结接口） | 第 34 单元只能查询/必要时创建当前根的 verified full checkpoint，第 35 单元只能消费既有 full payload 解封合同；不得在当前单元实现 import/restore/transfer，归 IR33-29、IR33-35。 |
| unit-development-workbench.md 静态目标/边界 | 适用 | 第 33 单元身份、单元边界、明确排除与清单状态约定归入 IR33-01、IR33-35～IR33-36。 |
| D33-01 | 适用 | full payload、唯一信封、targetId、恢复包与 strict codec 归入 IR33-02～IR33-04、IR33-07、IR33-18。 |
| D33-02 | 适用 | 同一日志前缀、六类覆盖、保留资产闭包、防递归与捕获资源治理归入 IR33-05～IR33-08。 |
| D33-03 | 适用 | periodic/root-activation 共用密码内核、分块落盘、篡改拒绝、清零与 S2 回归归入 IR33-09～IR33-10、IR33-34。 |
| D33-04 | 适用 | 单目标配置、目录/paired adapter、物理独立、原子发布、续传/回读及 target 资源治理归入 IR33-11～IR33-16、IR33-32。 |
| D33-05 | 适用 | 唯一 daily/forced owner、耐久候选、首次单机/配对 root activation、重放与两根装配归入 IR33-16～IR33-19、IR33-27～IR33-29。 |
| D33-06 | 适用 | 真解封 verification、恢复主秘密边界、双 readiness 与用户可行动状态归入 IR33-20～IR33-23。 |
| D33-07 | 适用 | verified 后替换、27 天保留、跨根/目标代际与共享 ref 零误删归入 IR33-24～IR33-26。 |
| D33-08 | 适用 | 生产拓扑/lifecycle、S7 落点、文档同步、直接证据和后继能力 denylist 归入 IR33-27～IR33-36。 |
| 当前完整交付物 `dd50eec8`→当前 `HEAD 67af121f` 的 67 个变化路径 | 事实来源 | 61 个功能/架构/测试路径逐一归入 IR33-01～IR33-36；6 个 workbench 流程路径明确排除，不参与功能通过判定。 |

### 交付路径反向覆盖

| 路径组 | 当前功能交付路径 exact-set | 归入审查项 |
| ------ | -------------------------- | ---------- |
| core 合同、日志、保留与容量 | `packages/core/src/authority/__tests__/authority-storage.test.ts`、`packages/core/src/authority/artifact-lifecycle-index.ts`、`packages/core/src/authority/artifact-retention.ts`、`packages/core/src/authority/commit-log.ts`、`packages/core/src/authority/index.ts`、`packages/core/src/contracts/identity.ts`、`packages/core/src/contracts/schema.ts`、`packages/core/src/resources/storage-maintenance.ts` | IR33-02～IR33-08、IR33-18、IR33-24～IR33-25、IR33-31～IR33-35 |
| mesh capture、密码、owner/service/target、物理 child bridge 与恢复包 | `packages/mesh/binding.gyp`、`packages/mesh/native/checkpoint_child_bridge.cc`、`packages/mesh/native/checkpoint_child_bridge.cs`、`packages/mesh/package.json`、`packages/mesh/scripts/build-checkpoint-child-bridge.mjs`、`packages/mesh/src/bootstrap-authority.ts`、`packages/mesh/src/checkpoint-child-bridge.ts`、`packages/mesh/src/checkpoint-owner.ts`、`packages/mesh/src/checkpoint-service.ts`、`packages/mesh/src/checkpoint-target.ts`、`packages/mesh/src/checkpoint.ts`、`packages/mesh/src/full-checkpoint.ts`、`packages/mesh/src/index.ts`、`packages/mesh/src/paired-checkpoint-target.ts`、`packages/mesh/src/recovery-package.ts`、`packages/mesh/tsup.config.ts` | IR33-02～IR33-16、IR33-18～IR33-20、IR33-24～IR33-35 |
| CLI 管理、配置、配对、有限恢复拓扑、装配与生命周期 | `packages/cli/src/commands/__tests__/info-commands.test.ts`、`packages/cli/src/commands/info-commands.ts`、`packages/cli/src/index.ts`、`packages/cli/src/runtime/rpc-management-facade.ts`、`packages/cli/src/serve/access-surface.ts`、`packages/cli/src/serve/backup-command.test.ts`、`packages/cli/src/serve/backup-command.ts`、`packages/cli/src/serve/backup-runtime-owner.test.ts`、`packages/cli/src/serve/backup-runtime-owner.ts`、`packages/cli/src/serve/backup-target-config.ts`、`packages/cli/src/serve/command.ts`、`packages/cli/src/serve/mesh-bootstrap-store.ts`、`packages/cli/src/serve/mesh-control-plane.ts`、`packages/cli/src/serve/mesh-pair-command.test.ts`、`packages/cli/src/serve/mesh-pair-command.ts`、`packages/cli/src/serve/mesh-runtime-assembly.ts`、`packages/cli/src/serve/mesh-runtime-bootstrap.test.ts`、`packages/cli/src/serve/mesh-runtime-bootstrap.ts`、`packages/cli/src/serve/paired-checkpoint-runtime.ts`、`packages/cli/src/serve/recovery-package-input.test.ts`、`packages/cli/src/serve/recovery-package-input.ts`、`packages/cli/src/serve/recovery-root-activation.ts`、`packages/cli/src/serve/recovery-root-establishment-runtime.test.ts`、`packages/cli/src/serve/recovery-root-establishment-runtime.ts`、`packages/cli/src/serve/surface-asset-authority.ts`、`packages/cli/src/serve/topology-command.ts`、`packages/cli/src/setup-delivery.ts` | IR33-03～IR33-04、IR33-11～IR33-23、IR33-27～IR33-35 |
| server readiness/status 消费链 | `packages/server/src/__tests__/__goldens__/canonical-registry.golden.json`、`packages/server/src/context.ts`、`packages/server/src/rpc/methods/__tests__/server.test.ts`、`packages/server/src/rpc/methods/server.ts` | IR33-22～IR33-23、IR33-30、IR33-34～IR33-35 |
| 当前架构与可执行规格 | `research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md` | IR33-01～IR33-36 |
| S7 入口、结构与 golden 门禁 | `scripts/s7-entry-coverage.mjs`、`scripts/s7-entry-coverage.test.mjs` | IR33-27、IR33-30、IR33-33～IR33-35 |
| full checkpoint 直接证据 | `packages/mesh/src/__tests__/full-authority-checkpoint.test.ts`、`packages/mesh/src/__tests__/pairing-trust-checkpoint.test.ts` | IR33-02～IR33-26、IR33-32～IR33-34 |
| 流程文档（明确排除） | `research/design/workbench/unit-development-workbench.md`、`research/design/workbench/unit-review-checklists/distributed-runtime/unit-32.gen-1.md`、`research/design/workbench/unit-review-ledgers/unit-32.gen-1.md`、`research/design/workbench/unit-review-ledgers/unit-33.gen-1.md`、`research/design/workbench/unit-review-workbench.md`、`research/design/workbench/unit-submit-review.md` | 只承载开发清单、上一单元归档/台账、当前单元台账和当前审查清单；不参与第 33 单元功能通过判定。 |

### 审查项

> **本轮审查说明**：原 27 项结论因事实未变化直接复用；IR33-16、19、23、27、28、30、33、34、35 已在当前完整交付指纹 `027fb83d…86be` 上重新独立判定。36 项现均为 `[x]`，未发现待登记问题。

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR33-01 | [x] | 单元身份、边界与完整交付物 | 冻结 HEAD `dd50eec8` 到当前工作区的全部变化路径并二元归属；功能/架构/测试路径必须全部反绑 D33-01～D33-08，workbench 路径不参与功能判定；不得混入第 34～38 单元、通用备份/同步框架或未配置单机的新恢复概念。 | 当前冻结 HEAD `67af121f…`；`git diff --name-only dd50eec8..HEAD` 为 67 路径：27 CLI、8 core、18 mesh、4 server、2 架构、2 S7 共 61 个功能/架构/测试路径，另 6 个 workbench 流程路径。各组已逐路径反绑 IR33-02～IR33-35，零未归属路径；交付物只新增已有配对无根时的有限 strict checkpoint transport，未引入第 34～38 单元、通用备份/同步框架或未配置单机恢复概念。未发现 P0/P1。 |
| IR33-02 | [x] | full payload 身份、覆盖与唯一信封 | `FullAuthorityCheckpointPayload.v1` 必须逐字段绑定 checkpoint/home/issuer/recipient/purpose、精确 `DurableLogCheckpoint`、trust chain head、四类 coverage、records 与 retainedArtifacts 目录；periodic/root-activation 共用唯一 `CheckpointEnvelope.v1`，少列、多列、乱序、重复、错 root/log/target/coverage 均 fail-closed。 | 当前 `checkpoint.ts` 严格解码 full payload、record/artifact 目录与唯一 `CheckpointEnvelope.v1`，校验 canonical 顺序、重复、exact keys、source checkpoint、root/chain/target/coverage；create/open 共用同一信封和密码内核，错 purpose/受众/引用在生命周期推进前失败。六类内容真实性由 IR33-06 独立判定；未发现 P0/P1。 |
| IR33-03 | [x] | 恢复包版本与旧 S2 兼容 | 新编码只含版本化高熵恢复主秘密与根身份，不内嵌全量密文；旧 secret+trust-only package 仍可严格解码和完成既有 mesh-ready 重放，但不能由新编码器生成、不能被识别为 full payload 或令 `fullBackupReady` 为真；未知版本/字段/非规范编码拒绝。 | 独立复核 `recovery-package`、CLI prepare/readback 与 v1/v2 双设备路径：setup 现已在连接目标前严格读回并冻结包内 root/recipient；v1 仅进入既有 trust-only/S2 replay，v2 才编码新根，二者均不把包体当 full payload或直接产生 `fullBackupReady`。未知版本、字段和非规范编码在 target I/O 前拒绝。后续 target activation 终态重放缺口属于 IR33-16/19，不是 codec/版本分叉；未发现本项 P0/P1。 |
| IR33-04 | [x] | checkpoint/verification strict codec 与关联 | envelope、full payload、stream record、verification、paired command/result 必须是严格判别联合并逐字段反绑 originating checkpoint/purpose/issuer/recipient/target/ref/digest/nonce/seq；异载荷 exact replay、错关联与未知字段在任何耐久推进或 I/O 前拒绝。 | 独立复核唯一 paired-result decoder、client 各命令分类前关联检查及 receiver strict command：begin/progress/append/commit/get/range/retire/activate-root 的 checkpoint、seq、offset、ref、chainHead 均反绑 originating command；checkpoint/full/verification codec exact keys，未知字段、错关联和异载荷 replay 在耐久推进前拒绝。未发现 P0/P1。 |
| IR33-05 | [x] | 唯一 authority 前缀冻结与复验 | capture 只能从 current anchor 唯一 `AuthorityCommitLog` 固定一个 logId/lsn/frameEndOffset/prefixDigest，按规范页读取恰至该前缀并在返回前复验；并发追加进入下一代，坏尾、错 log/prefix、越 LSN、读中漂移在 `checkpoint-created` 前零事实、零目标写。 | `full-checkpoint.ts` 两遍都绑定 retention snapshot 的同一 `DurableLogCheckpoint`，按页读至冻结 LSN，并在目录形成、正文重读及返回前复核 logId/lsn/frameEndOffset/prefixDigest；漂移触发整轮重冻，created/目标写均在捕获成功后。未发现 P0/P1。 |
| IR33-06 | [x] | 六类权威覆盖与保留资产闭包 | 逐行核对 §7 六类：四类应入内容完整、环境/秘密与非权威缓存零进入；ArtifactLifecycleIndex 必须追平并绑定 IR33-05 的同一 log checkpoint 后再生成当前保留记录及传递 `ArtifactRef` 闭包。共享/嵌套/外置/大资产去重且完整，缺 ref、错 bytes/digest、索引落后/损坏或覆盖缺口均 fail-closed，不从投影文件或缓存补事实。 | capture 仅经注册型 retention classifier/root 形成闭包，使用同一 source-head 的 `ArtifactLifecycleIndex` snapshot 复核；index 越头/变化整轮重冻，缺失、bytes/digest 错或不可分类 ref 在 created 前失败。真实 log/store/index 场景覆盖删除、共享/嵌套/外置和大资产；未从投影或缓存补事实，未发现 P0/P1。 |
| IR33-07 | [x] | 禁止类别与 checkpoint 防递归 | 环境事实、SecretStore/设备秘密、workspace 原始路径、设备/执行缓存、非权威缓存和旧 checkpoint envelope/chunks 不可表示；checkpoint lifecycle 的旧引用不得递归进入新载荷，但当前候选本地 envelope/chunks 仍由生命周期索引正确保留。 | authority prefix 与注册型 root 之外无补事实入口；环境、SecretStore、原始路径、设备/执行缓存无 retention schema，checkpoint stream 明确排除于新 capture，候选自身 envelope/chunks 由生命周期索引独立保留。未发现 P0/P1。 |
| IR33-08 | [x] | 捕获与本地资产资源治理 | 日志页、资产页、明文块、临时空间和 ArtifactStore I/O 必须逐步使用现有 `authority-checkpoint` storage governor；permit 不跨 authority/store/lifecycle 锁，等待可取消，容量不足/磁盘满/stop 保持零伪成功和可重驱事实。 | 两遍 capture、`readRange` 大资产、1 MiB chunk source/sink、local CAS、target/staging 均逐块受同一 owner signal/governor 约束，完成值不携整包 chunks。生产 `PairedRecoveryCheckpointTarget` 恰有 backup command/runtime owner/首次 pairing 三处，分别注入现有 device governor；range 先完成网络请求，再仅在固定 256 KiB 解码/消费 step 持 permit，未跨网络或 authority/store/lifecycle 锁。拒绝、取消和 stop 不伪造终态；未发现 P0/P1。 |
| IR33-09 | [x] | periodic/root-activation 共用密码内核 | 两种 purpose 必须复用唯一 X25519-HKDF-SHA256、AES-256-GCM create/open 内核及 ephemeral enc、wrapped DEK、nonce/AAD、verificationNonce、自摘要和 issuer 签名；periodic 不接受 plan，root-activation 必须全等绑定完整 plan，跨 purpose replay 拒绝。 | periodic/full 与 root-activation 继续共用 `checkpoint.ts` 的 X25519-HKDF-SHA256、AES-256-GCM、AAD、wrapped DEK、自摘要和签名实现；purpose-specific payload/plan 约束在解封与推进前拒绝跨 purpose replay。未发现 P0/P1。 |
| IR33-10 | [x] | 分块落盘顺序、exact-set、篡改拒绝与清零 | 固定上限的 plaintext/ciphertext chunk 必须连续 exact-set、逐块 bytes/digest/nonce/AAD 全等；每块先写入并回验 current ArtifactStore，envelope 最后耐久，`checkpoint-created` 只能引用已在场的 envelope/chunks，部分本地写仅形成可回收孤儿。截断、重排、重复、超界、错 key/enc/wrappedDek/signature/payload 任一失败零 verified/激活推进，DEK、共享秘密、nonce 与已解明文在成功/失败路径均清零且不落持久明文。 | 固定 1 MiB 连续 chunk、exact-set、逐块 digest/nonce/AAD、local CAS 先写回验和 envelope 最后耐久均成立；open/activation 对截断、重排、重复、超界与密码/payload 篡改在终态前拒绝，敏感 buffer 在成功/失败路径清零。未发现 P0/P1。 |
| IR33-11 | [x] | 单目标配置与稳定 target identity | `zz backup setup` 一次只允许独立目录或一台 active paired device；版本化 targetId→binding 严格解析、稳定持久化，targetId 不泄漏/反推路径；切换配置不丢仍有 created/replicated/superseded 未清理代际的旧映射，异身份/异载荷重放拒绝。 | 版本化 binding map 保留 current 与历史 target；setup 严格目录/active paired 二选一，verification candidate 先从 checkpoint stream 冻结 `{checkpointId,targetId}` 再解析 binding，verify/recover/cleanup 全程使用 created.targetId。首次 paired staging 还耐久绑定 home/source/target/checkpoint/recipient，同键 replay 与异键冲突二元落定；未发现 P0/P1。 |
| IR33-12 | [x] | 目录目标物理独立与路径安全 | configured root 必须冻结 lexical/canonical path 与 filesystem identity，拒绝与 authority root 同物理域、root 自身 link/reparse、非目录、越根及绑定/遍历/打开/读后替换；最终文件 no-follow、handle identity 与 frozen containment 全程一致，非法路径零根外读写。 | `checkpoint-child-bridge` 从 filesystem/drive root 逐组件建立并冻结 configured root，POSIX 以 dirfd/*at/openat2、Windows 以 RootDirectory handle-relative 操作 child；两平台均复核 no-follow、volume/file identity/reparse，adapter 不再用 root/child 路径副作用。越根或替换在首次根外 I/O 前拒绝，未发现 P0/P1。 |
| IR33-13 | [x] | 目录目标原子耐久发布与真回读 | 每个 checkpoint 使用私有临时目录，逐文件写入/fsync、manifest/envelope/chunk exact-set 校验、原子 rename 与目录 fsync 后才可见；同载荷幂等、异载荷冲突、部分/崩溃发布不可见，read 必须逐字节回读同包，retire 只删除指定 superseded 代际。 | 私有 staging、逐文件 handle fsync、manifest/envelope/chunk exact-set、handle-relative rename 与目录 fsync 后发布成立；同载荷重放、异载荷冲突、部分不可见、逐块真回读及指定代际 retire 均锚定同一 frozen parent。额外文件按已裁决边界 fail-closed 而不扩成当前删除义务；未发现 P0/P1。 |
| IR33-14 | [x] | paired 有限协议与认证边界 | paired service 只暴露 begin/progress/append/commit/get/range/retire/activate-root 有限命令，严格绑定 home、source/target active device、recipient、checkpoint/ref/range/seq、签名 root event/record 与结果类型；无根阶段仅 current issuer 可用 strict checkpoint service，active receiver 的 activate-root 只允许本地 trust exact terminal replay；未知命令、错成员/身份或越界在业务 I/O 前拒绝。 | receiver descriptor 与实际分支均为 begin/progress/append/commit/get/range/retire/activate-root；认证 service 先校验 home/source/target，有限无根 topology 只授权 current issuer，staging 再绑定 checkpoint/recipient，activate-root 反绑已发布 root-activation plan。active receiver 仅调用本地 exact replay；未知命令、错身份、range/seq/ref 越界均在对应业务副作用前拒绝。IR33-16 的缺口是 source 缺少可持续重放的终态载荷，不是 receiver 越权；未发现本项 P0/P1。 |
| IR33-15 | [x] | paired 断点续传、staging 与真实回读 | 传输按有界 part 续做，receiver 只写 target 私有 staging，exact-set 完整验真后才原子提升目标；断连、乱序、重复、部分 append/commit、响应丢失和连续重启复用同 checkpoint 身份且不重复/串包；get/range 必须从已发布目标逐字节回读，retire 不误删共享内容。 | part/seq/offset/progress 与 root-establishment binding 均耐久使用同 checkpoint identity；receiver 逐块写私有 staging，完整 exact-set 验真后才发布，get/range 从已发布目标回读，retire 只命中指定 checkpoint。三个生产 client 均已注入同一设备 governor，range 网络返回后才持 permit 解码；断连和效果后 replay 不串包。未发现 P0/P1。 |
| IR33-16 | [x] | 首次配对 onboarding 顺序 | 新设备在业务成员/mesh 能力开放前只运行受限认证 onboarding receiver；issuer 以同 checkpointId 写入、真回读、解封验证并原子激活恢复根后才发布业务信任，恢复包读回失败、链变化、断连或响应丢失不得出现 mesh-ready 但无已验证 full backup 的窗口。 | 独立复审确认新设备仍由 pairing socket 的受限 checkpoint receiver 完成同 checkpoint 写入、回读、验证和 source 原子激活，随后才生成 enroll 与业务 challenge；已有 paired 无根分支独立使用 current-issuer finite receiver，`currentPairedRootActivation()` 只委托 originating commit 历史 tuple 查询。U33-04 未改变 onboarding 顺序或开放普通 mesh/business service；未发现 P0/P1。 |
| IR33-17 | [x] | 周期 owner exact-set 与 stable due identity | trusted-home current anchor 或显式启用备份的单机 current anchor 恰一 owner；UTC 日历日/forced request 与当前 root+target 共同确定唯一候选，同根同目标的同日并发与 daily/forced single-flight，墙钟回拨及 root/target 切换不得另造或误重放候选；无根、无目标、非 current anchor、executor-only、surface、target 已撤销和未启用单机零周期事实并返回稳定可行动状态。 | candidateKey 绑定 root/recipient/chain/target 与 daily/forced request，checkpointId 再绑定冻结 source prefix；同键加入、异键稳定 busy，完成/失败只清当前 key。生产 slot/descriptor 限 current anchor 恰一 owner，executor/surface/未启用/无根无目标零周期事实。未发现 P0/P1。 |
| IR33-18 | [x] | created→replicated 耐久生命周期与重放 | 创建前捕获可重算；`checkpoint-created` 后 checkpoint/source/recipient/target/envelopeRef 全冻结，复制只重驱同一代，目标 durable 后才写 `checkpoint-replicated`；效果前后失败、取消、响应丢失、配置切换、停机与连续重启不另造候选或伪造复制。 | created 冻结 generation/request/source/recipient/target/envelopeRef；target durable 后才追加 replicated。`recoverPending` 按 created 的历史 binding 重驱，slot `start()` await reload/recover 后 serve 才继续，stop 保留未终态事实；效果前后失败和丢响应由 exact replay 收敛。未发现 P0/P1。 |
| IR33-19 | [x] | root/chain 变化与 activation 原子性 | 首次单机目录 setup、首次配对 onboarding 及已有配对设备无根 setup 均复用现有 coordinator；后者必须在 source 原子激活后把与已存 checkpoint plan 全等的签名 root event/record 耐久提交 target，双端效果后重放全等；target 根可见前普通业务关闭，提交后有限 topology 退役并进入正常 topology。 | 独立复审确认 source 的 activation commit、verified、root event 与 `HomeTrustRecord` 同一 authority envelope 原子耐久；历史查询以恰一 commit 和同 LSN tuple 为键，重放该前缀验签并要求 current activation digest 未换代。target staging 继续校验 checkpoint plan，finite fresh commit 与 active exact replay共用原 tuple；零匹配不写，错 target/LSN/event/record、歧义或换代均在 target trust 追加前失败。目录 setup/onboarding 原 coordinator 未改；未发现 P0/P1。 |
| IR33-20 | [x] | 真实目标回读、真解封与 verified 事务 | verify 只能按 created 绑定的真实 target/checkpoint 回读，完整打开 envelope/payload 并核对 root、chain、scope、source、target、recipient、nonce/digests；随后同一 `AuthorityCommitLog` 事务幂等写全等 verification，错包/旧根/旧链/效果后丢响应零错误推进。 | verification candidate 与 `verify()` 全程使用 created.targetId/recipient/generation，resolver 打开冻结的历史或当前 target；逐块 open 校验 envelope/payload/root/chain/source/scope/nonce/digest，随后同一日志事务幂等写同 target verification/supersede。错包、旧根/链及效果后响应丢失均不能错误推进。IR33-19 发生在已完成真验证后的双端 trust 提交，不改变本项结论；未发现 P0/P1。 |
| IR33-21 | [x] | 恢复主秘密输入与零持久化 | 第一方 verify/setup 只经保密交互临时读取/生成恢复包；主秘密不得进入 argv、env、配置、SecretStore、日志、status、RPC 或错误文本，使用后清零；创建/复制/日常 owner 不接触主秘密，只有真解封路径能取得 verificationNonce。 | verify/setup/onboarding 共用有界无回显 reader，独占 TTY raw input、支持取消并在 finally 恢复终端和清零字符/解码 buffer；主秘密不进入 argv/env/config/SecretStore/log/status/RPC/错误，日常 owner 不持秘密，verificationNonce 仅真解封产生。IR33-19 只缺耐久签名 trust projection 重放载荷，不需要也不得保留恢复主秘密；未发现 P0/P1。 |
| IR33-22 | [x] | 双 readiness 投影 | 既有 S2 `ready` 继续只表示 mesh/root activation；`fullBackupReady` 必须由当前 root、独立 target、全量 scope 的 created+replicated+真解封 verified 全等派生，并给出有限 checkpoint/target/time/lsn 内部投影；旧 trust-only、仅复制、验证失败、旧根/链或每日过期不得冒充或改变冻结 ready 谓词。 | `projectDurableRecoveryBackupStatus` 仅从 current trust generation、同 target created、匹配 verification 与本地 full envelope 派生；service 和 unavailable slot 共用该 projector。target/runtime 离线仅把 availability 置为 unavailable，并保留耐久 `fullBackupReady`；旧 trust-only、仅复制、失败、错 root/chain/target 均为 false。S2 ready 与 full ready 仍分层；未发现 P0/P1。 |
| IR33-23 | [x] | backup CLI、/status 与产品语言 | `zz backup setup/verify/status`、server.info 与 `/status` 必须消费同一 readiness/status 合同，稳定显示未配置/待验证/可恢复和下一动作；错包、目标不可达、容量/暂态失败可行动且不把 pending/失败说成完成，不暴露 root、LSN、digest、CAS、target 内部路径等实现术语。 | 独立复审确认重复 paired setup 在 source trust 前进后仍可从原 checkpoint续驱 target；source/target 任一未终态或 transport 失败继续抛错，不会输出 setup 完成。既有只读 readiness projector、CLI 的未配置/待验证/可恢复与下一动作文本、server 公开 exact-key DTO均未改，历史 tuple、LSN、digest、内部路径不进入公开结果；未发现 P0/P1。 |
| IR33-24 | [x] | verified 后替换与最少一代可恢复 | 只有同 current root 的新 full checkpoint 从独立目标真解封并 verified，才能在同一 checkpoint 事务把旧代标记 superseded；较新候选失败、仅 replicated、旧根或非 full 不替换，首次 ready 后始终保留至少一个维持 `fullBackupReady` 的代际。 | 只有真实 target 全包解封验证成功后，verified 与同 current recovery key 的旧代 superseded 才在同一 CommitEnvelope 落定；replicated/失败/旧根/非 full 不替换，响应丢失 exact replay 收敛。IR33-22 的统一耐久 projector 在目标离线时仍保留该最新 verified 代的 ready；未发现 P0/P1。 |
| IR33-25 | [x] | 27 天 retention 与本地/远端清理 | superseded 满 27 天后才以 storage-maintenance single-flight 回收本地 envelope/chunks 与原 target 副本；远端不可达/删除失败保留重试义务且不影响新代 ready，未发布临时目录可清，created/replicated 未替换候选可续做；ArtifactLifecycleIndex 复核保证共享业务 ref 零误删。 | 当前合同已分层：`checkpoint-superseded` 是 source-local cache release fact并由通用 24h GC消费；独立 target 自 superseded 起保留 27 天，仅 `target-retired` 终结。离线/删除失败保留重试，shared ref 仍由 lifecycle index 复核；历史 `local-released` 仅 strict decode 为 no-op，不分叉当前语义。未发现 P0/P1。 |
| IR33-26 | [x] | 跨根、跨目标与代际恢复 | root rotate 后旧根包立即不计 ready且不 rewrap；新根 full verified 前不得清唯一旧代物理副本，目标切换仍能按耐久 targetId 找回/清理旧代；并发 verify/supersede/cleanup、响应丢失和连续重启必须收敛到单调代际，无 ready 回滚或跨 target 误删。 | root/chain generation 使旧代不计 current ready且不 rewrap；verification candidate、recoverPending、verify 与 cleanup 都按 created.targetId 解析历史 binding，新根 verified 前旧独立 target 不被清。并发/丢响应靠同日志 exact facts 单调收敛，统一 readiness projector 只认 current generation；未发现 P0/P1。 |
| IR33-27 | [x] | 两生产根、角色与 receiver exact-set | 显式启用单机 current anchor、anchor+executor、anchor-only/远端 executor 中只有 current anchor 恰一 service/capture/target client；receiver 分 onboarding、无根 current-issuer finite、active 三阶段各恰一，finite 只含 endpoint+strict checkpoint，激活应答后退役并重载 active，executor-only、surface、非 current anchor 和未启用单机零 owner/权威读取。 | 独立复审确认历史 replay 查询只加入既有 source store，不新增 owner、listener或 receiver。current anchor 的两生产组合根仍各恰一 checkpoint owner；无根非 issuer target 的 finite runtime 仅注册 `mesh.endpoint` 与 `recovery.checkpoint` 并只授权 current issuer，root 耐久后退役、重载 normal topology；active receiver只对原 tuple exact replay。onboarding socket、新旧 target角色及零装配集合未漂移；未发现 P0/P1。 |
| IR33-28 | [x] | 启动恢复、公开准入与关闭 | 启动在 backup 管理入口和第 34 单元接缝前恢复 created/replicated/verified/superseded/cleanup 与 target binding/readiness；关闭先拒绝新创建，在安全页/块边界取消并等待 active work、停 timer/receiver、释放 permit，未终态耐久事实留给重启重驱，不遗留双 owner/loop 或伪终态。 | 独立复审确认 source 重启由同一 authority log 快照重建 originating tuple，target 私有 staging与 finite receiver保留未终态；target root提交/响应丢失后 active receiver只作 exact replay。`runServeCommand` 在 target无根时先完成 finite topology，重新读取耐久 trust 后才取得 workspace并进入 normal serve；查询本身无 loop、permit或可写资源，既有 stop/owner cleanup顺序未改。连续重启不会伪造完成或形成双 receiver；未发现 P0/P1。 |
| IR33-29 | [x] | 迁居前 forced 窄接缝 | 下游只能查询当前 root 的 verified full checkpoint或以稳定 request 请求当前 owner 创建/复制同一候选；无 recovery package 时不得假装 verified，失败保留可重试状态；接缝不得读取/导入 catalog、冻结 source、提交 transfer、切换 current anchor 或执行 restore。 | forced 与 daily 共用 keyed single-flight 和 created lifecycle，稳定 request 只重放自身 candidate；无恢复主秘密只能达到 replicated/pending，不能伪造 verified。公开窄接缝只消费统一耐久 readiness，未读取/import catalog、提交 transfer、切 current anchor 或执行 restore；未发现 P0/P1。 |
| IR33-30 | [x] | S7 入口、装配与角色门禁 | 现有单一 S7 gate/golden 必须逐项反绑规格 recovery-backup 行的 setup/verify/status、daily/forced trigger、paired begin/progress/append/commit/get/range/retire/activate-root，及生产 owner create/start/stop、current-anchor guard、onboarding/finite/active receiver 顺序、有限 service set、target trust commit、active terminal replay 与三 client governor exact-set；真实变异 fail-closed且合法两根零误杀，不建新 lint/发现框架。 | 独立复审确认单一 S7 gate仍覆盖既有 owner、三 receiver阶段、service/command exact-set、三 client governor与 target trust commit；新增有限规则切片检查 helper只委托历史查询，查询必须含 activation commit、plan digest、同 LSN 历史前缀、record验签和 current digest，并禁止 trust/checkpoint latest/current loader回退。直接变异分别替换 helper、历史 record与原 event均命中同一失败项，架构/golden集合未扩张；未发现 P0/P1。 |
| IR33-31 | [x] | 安全、最小权限与 wire/path 隔离 | 有限核对 full payload、envelope、recovery package、directory manifest、paired command/result、status/RPC：只含冻结身份和内容引用；秘密、环境事实、绝对路径、raw store/log 与通用读取/删除能力不逸出，签名/受众/role/root/target/ref/range/path guard 均在该链首次副作用前验证。 | full payload/envelope/package/paired result 均为 strict schema；签名、受众、role、root/target/ref/range 及 frozen handle path guard 在首次对应副作用前验证。公开 status/error 不含 checkpoint/target/path/raw error，秘密只经无回显临时边界；raw store/log、通用路径与普通 mesh service 未向有限 root-establishment surface 逸出。IR33-19 需要保存/重建的是公开签名 trust projection，不改变秘密边界；未发现 P0/P1。 |
| IR33-32 | [x] | 资源、并发与故障终态 | 空/大资产、并发 capture/verify/cleanup、容量饱和、磁盘满、取消、stop、网络等待和锁序必须有界；网络不持 permit，permit 不跨 authority/store/lifecycle 锁，single-flight/分页/chunk 有上限；每个失败要么零耐久副作用，要么留下可恢复的唯一 checkpoint 事实且不静默成功。 | 两遍 capture、1 MiB source/sink、256 KiB paired range、分页、keyed single-flight、owner abort、handle-relative target 与 startup recovery 构成固定上界；三个 paired client 均使用 device governor，网络等待不持 permit，permit 不跨 authority/store/lifecycle 锁。容量拒绝、磁盘满、取消与 stop 要么发生在事实前，要么保留唯一 checkpoint/staging 进度。IR33-19 是缺少可重驱的双端 activation 事实，不是资源旁路；未发现本项独立 P0/P1。 |
| IR33-33 | [x] | 成比例的直接验收证据 | 证据计划必须覆盖 strict codec/恢复包、真实 AuthorityCommitLog/FileArtifactStore/ArtifactLifecycleIndex、双端无根 v1/v2 setup、target trust 提交与 active terminal replay、容量/governor、离线 readiness、两生产根与 S7 真实变异；配置只做角色 exact-set，不做配置×故障笛卡尔积。 | 独立复审核实新增 v1/v2 参数化场景使用两份真实 `FileMeshBootstrapStore`、生产 control plane/paired staging与 target trust append，直接注入 source提交后 target提交前失败，再推进合法非根 trust、重启 finite receiver并以 active receiver exact replay；另验证错 target与重复 commit歧义零 target变化。既有真解封、效果后响应丢失、两根与资源证据继续复用，S7对 helper/event/record latest回退有直接变异；未建配置×故障笛卡尔积，未发现 P0/P1。 |
| IR33-34 | [x] | 上游 S2 与共同装配点兼容 | 有限核对既有 trust-only package、source coordinator、target bootstrap trust store、mesh-ready、首次配对、已有配对无根 serve 的 finite→active 切换、canonical registry 与 server.info；不得改旧签名语义、放宽普通业务或把后继 transfer/restore/sync 并入 S9。 | 独立复审确认 v1 legacy checkpoint与v2恢复包仍进入既有 `RecoveryActivationCoordinator`，source/target签名、链重放和 root activation commit合同未改；新方法仅是 `FileMeshBootstrapStore` 内部只读历史关联查询，未修改 `BootstrapAuthorityPort`、wire、canonical registry或 server.info。首次配对、目录 setup和 finite前普通业务 gate不经过该查询；未并入 restore/transfer/trust sync，未发现 P0/P1。 |
| IR33-35 | [x] | 架构/规格同步与后继能力守界 | 总纲 S9、规格 full payload/§7/§8/§15、core exports、mesh/CLI/server 合同和生产调用图必须全等；第 34/35 单元只见冻结窄接缝/载荷，`SourceFreezeProof(anchor)`、AuthorityCatalog import、TrustTransition、ReadyProof、AnchorTransferCommit、restore/domain-reset/reenroll/credential rotation 未进入当前 wire、CLI 或装配。 | 独立复审确认总纲 §12.1 与规格恢复备份段共同规定 originating activation commit、同 authority LSN 历史 tuple、current祖先/activation digest校验及禁止 latest/current替代；`FileMeshBootstrapStore` 查询与 backup helper逐条对应，未改变 core/mesh wire、公开 DTO或后继接缝。当前差异未引入 planned/disaster transfer、restore、通用 trust sync、domain reset/reenroll或第34～38单元装配；未发现 P0/P1。 |
| IR33-36 | [x] | 来源、D33 义务与路径反向闭包 | D33-01～D33-08、全部适用来源条款及当前功能路径 exact-set 必须按 core 合同/retention/governor、mesh full capture/crypto/service/target/owner、paired/onboarding/root activation、CLI config/commands/assembly、server/status、架构规格、S7 与直接测试八组逐一归入 IR33-01～IR33-35；新增 helper、协议字段、生产入口和测试均须有完整链路落点。 | 当前 `dd50eec8..67af121f` 加工作区 U33-04 专项共 61 个非工作台路径，按 core 8、mesh 18、CLI 27、server 4、架构 2、S7 2 逐项反向对账，功能指纹 `027fb83d24912a5d7885af61abd7d5029d5505f024107641d31298d6994868be`；全部落入 IR33-01～IR33-35，零未归属。最新 originating-checkpoint 历史查询、helper、真实双端故障测试与 S7 变异均归 IR33-16/19/27/30/33/34；路径闭包无独立 P0/P1。 |

> 本轮独立审查状态：36 项 `[x]`，零 `[!]`/`[~]`/`[ ]`。9 个变化项已完成新的功能判断，原 27 项继续复用；统一根因分析未发现 P0/P1 或 P2/P3，两个问题列表保持清空，独立审查通过。

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
