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
目标：只收敛第 35 单元正式问题列表中同根重开的 U35-03 一个 P0/中，使其真正命中 candidate 已有 verified 未被用作 prepare/import 耐久重放起点，以及 authority install 完成前 target-wide claim 被 committed terminal 提前释放的共同根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U35-01～U35-02、U35-04～U35-06 的既有结论直接复用，U35-03 已闭合的 cancel/stop、claim-only signed abort、governor 与资源边界不得恢复或扩面，价值裁决已经否定的第二个 prepared 事实不得重新引入，自动 failover、全局同步、恢复应用及第 36～38 单元能力不得提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-03，只依据该问题最新的事实、两次价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 从权威架构、规格和当前生产调用图重建 U35-03 的事实链，核准 target-wide candidate、per-transfer phase、private store/key、ReadyProof、authority installation 与 terminal replay 的唯一事实源、稳定 identity、耐久决定、线性化点、消费者、异常终态、当前损失、受影响审查项、P0 评级和中工作量；明确原 cancel/stop 与 claim-only abort 已闭合，当前残留是同一状态机没有覆盖正常 verified/imported 重放和 install/claim release。
2. 穷尽直接变体：覆盖 claimed/verified/imported/aborted/install-decided/committed，变化时钟、同/异 transfer、空/非空 retained、verified sync→imported sync、decision→authority install、install→private committed→terminal、prepare/abort与commit竞争、错误 identity、proof expiry、key 已清或错绑、效果/响应丢失和连续重启。每格必须指出复用的 verified/imported bytes、唯一 install owner、claim 释放边界、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：只复用现有 candidate、per-transfer journal、私有 store、ReadyProof 与 authority install primitive。prepare/import 重放必须先消费已有 aborted/imported/verified；verified 尚未 imported 时只能验真并续写一次 imported，不重算 verified。candidate transaction 只允许新增互斥的 `install-decided`，保存完整 canonical installation/commit replay object并在 authority install、private committed 与 terminal 补齐前持续占有 target-wide claim。不得新增第二 journal、第二 prepared 事实、通用事务/lifecycle、同步、路由、存储、outbox、事件总线、registry、新 lint/test runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正 U35-03，使执行者无需实现猜测即可一次完成。
4. U35-03 看似闭合后，对同一份未修改记录执行四路冷启动对抗复审：verified→imported 耐久重放、install decision 与 target-wide 单飞、abort/commit/identity/连续恢复、生产证据/产品体验/范围价值及历史裁决边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 U35-03 与 U35-01～U35-02、U35-04～U35-06、第 33～34 单元既有合同及第 36～38 单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改的 U35-03 记录通过四路冷启动对抗复审；全部受支持 verified/imported 重放、aborted replay、install decision、双 candidate、authority install、响应丢失和连续重启终态均被根因完整解释，影响面无遗漏，P0/中有事实依据，最优方案和验收条件可直接执行，不会恢复重复 prepared 事实或因早释 claim 继续局部返工。满足后明确回复“U35-03 同根重开问题的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 35 单元同根重开的 U35-03 一个 P0/中，闭合 candidate 已有 verified 的 prepare/import 耐久重放，以及 install-decided→authority install→private committed→target-wide terminal 的唯一前滚顺序及全部同根直接变体；不得扩展到其他问题或全单元流程。U35-01～U35-02、U35-04～U35-06 的既有结论直接复用，U35-03 已闭合的 cancel/stop、claim-only signed abort、governor 与资源边界不得恢复或扩面，两次价值裁决否定的第二 prepared 事实不得重新引入；自动 failover、全局或持续同步、恢复应用及第 36～38 单元能力不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-03，只依据该问题最新的根因、两次价值裁决、F35-13～F35-20 固定矩阵、C35-C22～C35-C30 反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F35-13～F35-20 固定矩阵。覆盖 claimed、verified、imported、aborted、install-decided、authority-installed、private-committed、terminal-committed；变化时钟、空/非空 retained、同/异 transfer、verified/imported/decision/installation/private/terminal 各 sync 与响应窗口、proof expiry、key缺失/错绑、prepare/abort与commit竞争、后继generation及连续重启。逐格绑定candidate/phase/install identity、唯一耐久事实、commit决定与authority可见性线性化点、claim释放边界、零副作用终态和直接证据，并持续核对U35其余五项、第33～34与第36～38单元边界。
2. 一次完成。先收紧现有 `FileDisasterRecoveryCandidateJournal`：保留 claimed/verified/aborted/committed，只新增与 signed abort 互斥的 `install-decided`；决定保存完整 canonical installation entries、`DisasterRecoveryInstallation`/commit 与 candidateReferences exact-set。projection/reducer、record decoder与candidate transaction必须拒绝第二prepared、冲突decision、无decision的committed terminal；install-decided保持target-wide claim，terminal committed只有在同decision的authority installation和private committed均可回读时才可写并原子释放claim。

   `prepareAndImport()` 在任何新key/staging/readiness效果前联合读取candidate和per-transfer state：aborted同identity重放原终态并续清理；imported/committed返回原imported bytes和refs；verified且未imported只验真原verified、catalog/retained exact-set、private refs与既有transfer专属key，恢复现有reservation后创建一次ReadyProof/import并追加imported，禁止重做现场验证、覆盖verified或在verified后load-or-create key。key缺失/损坏fail-closed并只允许既有authenticated abort收束。

   `commit()` 复用原imported与U35-02 readiness：完成CAS提升并在同一reservation内最终复验readiness/expiry后，才在candidate transaction写install-decided；该写是commit/abort唯一胜负点，决定后不得按重放时钟或current revision改判。随后只用冻结decision调用现有`installPlannedAnchorPrefix()`并read-back同generation，激活exact key、追加private committed，最后写candidate/target-wide committed terminal。authority未安装时由同一commit请求重放decision；authority已可见后由现有installation loader在live/startup补private committed与terminal。历史terminal只返回冻结结果，不重装旧authority。同步直接相关架构、规格、现有S7与直接测试；同根残留并入U35-03，禁止新增第二journal、第二prepared、通用事务/lifecycle/同步/路由/存储/outbox/事件总线/registry、新lint/test runner、监控、诊断、benchmark或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、candidate/per-transfer reducer与codec、disaster target prepare/import/commit/abort、authority install/private completion直接合同与场景测试，现有S7 lint及必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过真实candidate/target-wide `AuthorityCommitLog`、per-transfer journal、private `FileArtifactStore`、SecretStore、ReadyProof reservation和目标authority log，直接注入变化clock、空/非空retained、每个sync/响应窗口、双candidate、proof expiry、key缺失/错绑、prepare/abort竞争、安装效果丢响应、后继generation和连续重启；不得以mock自报verified/decision/install/terminal或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与U35-03验收无关的验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读逐格重建 U35-03 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：verified→imported耐久重放、install decision与target-wide单飞、abort/commit/identity与连续恢复、生产证据/产品体验/范围价值及历史裁决边界。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查U35-03与U35-01～U35-02、U35-04～U35-06、第33～34单元既有合同及第36～38单元边界的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第2步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U35-03 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C35-C22～C35-C30及新增同根反证全部有耐久处置，证明已有verified在变化时钟、空/非空retained与响应丢失下只续写一次imported，已有imported永远exact replay且不产生第二prepared；install-decided与signed abort恰一胜出，完整安装输入固定，authority install与private committed前claim不释放，双candidate、proof/key异常、效果丢失和连续重启唯一收敛；terminal历史重放零authority回滚。U35其余五项、第33～34单元结论不变，第36～38单元能力未提前实施，U35-03已更新为“已验证”。满足后明确报告“U35-03 同根重开问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 35 单元 · generation 1
- **单元身份**：S9 人工灾难恢复与安全域换代；只支持值班设备永久丢失后，由另一台 active anchor-role 设备基于用户明确选择的完整 checkpoint 副本和无回显恢复包，执行 source-less 恢复、旧安全域撤销、恢复根生命周期与逐设备重新加入。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D35-01～D35-09。上游只消费第 33 单元完整可恢复 checkpoint、恢复根激活与 retention 合同，以及第 34 单元 composite authority、installed-generation/current-owner、target-wide candidate、私有 staging、storage governor 和 post-install closure；下游第 36～38 单元能力不进入本清单。
- **交付基线**：以第 34 单元封版代码提交 `972f363e` 为基线，当前 Unit 35 完整交付为 65 个变更路径：core 8、mesh 11、CLI 38、providers 1、server golden 1、S7 2、架构 2、当前单元工作台 2。其中 63 个非工作台功能路径形成 U35-03 修复后专项冻结指纹 `8da1865c02bc6fe07c69f819cee7476345faec308d03d736c94cc17f58dc8f90`；同期 Unit 34 历史归档 2 路径及审查与修复状态 2 路径不属于 Unit 35 功能交付，仍在下方路径对账中明确排除。审查必须覆盖完整生产调用图与 65 条 Unit 35 路径，不得仅审新增文件或默认命令路径。
- **生产装配关系**：`zz backup recover/recover-finish` 与 `zz backup root rotate/invalidate/approve-reset/reset` 是用户入口；checkpoint directory/paired inventory 提供候选，strict disaster command、target-wide candidate journal、per-transfer journal、私有 `FileArtifactStore` 与本地 `AuthorityCommitLog` 形成目标恢复链；`MeshRuntimeBootstrap` 与 `MeshRuntimeAssembly` 在 anchor+executor、anchor-only 两个 current-anchor profile 中消费 disaster installation，先完成 installed-generation/runtime/consumer 重绑再开放 current-owner surface。Credential exposure authority 同时接入 capability publication、provider/channel/MCP/webhook/rendezvous 秘密读取与 pairing/bootstrap 路由。
- **目标提交边界**：交付 source-less checkpoint inventory、恢复根真解封与现场验证、no-rollback baseline、私有完整导入、root-signed commit/abort、原子 composite authority 安装、旧 issuer/epoch/route/binding fencing、旧设备隔离后 tombstone、恢复根 rotate/invalidate/domain-reset-establish、pending-reenroll/fresh pairing、公开零术语旅程、两生产根 exact-set/S7 与必要直接证据。
- **明确排除**：自动 failover、quorum/witness、自动升主、持续或全局同步、恢复应用、业务数据恢复向导、多目标/云备份、通用 transfer/registry/lifecycle/事务/outbox/事件总线；第 36 单元托管服务与角色自恢复、第 37 单元停机/移除/卸载、第 38 单元升级发布；单设备原地重置、issuer 与恢复包同时丢失后的绕过；监控、诊断、benchmark 与信息采集。
- **架构空洞判定**：总纲 §9、规格 §6.3/§6.4/§7/§8/§15 与 D35-01～D35-09 已唯一确定本单元产品、状态、安全、拓扑和交付边界；当前没有需以实现假设补齐的真实需求空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：0 项 `[ ]`、19 项 `[x]`、0 项 `[!]`、19 项 `[~]`；U35-03 修复、最小必要验证及同指纹专项复核已完成，因生产实现、直接测试、S7 与架构输入变化，19 个直接受影响项已标记为 `[~]`，旧证据不再代表当前结论；其余 19 项事实未变，继续复用 `[x]`。两类问题列表为空，本任务不执行独立审查。

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
| IR35-01 | [x] | 单元身份、架构与范围 | 复核总纲 S9 人工灾难恢复边界、规格第 35 项、D35-01～D35-09 与 65 条交付路径：当前实现只服务手动 source-less authority 恢复、恢复根/凭据安全闭环及直接验收；未引入自动 failover、持续同步、恢复应用或 Unit 36～38 能力，也不存在会改变边界的需求空洞。证据：来源逐章表、开发清单、交付路径反向分类及生产入口扫描。 |
| IR35-02 | [x] | 恢复包与公开入口前置 | CLI 仅以显式 `backup recover/recover-finish` 与 root 子命令进入；恢复包没有 argv 选项，生产路径统一调用 `readRecoveryPackageFromTty`，其要求双端 TTY、独占 stdin、raw-mode 无回显、16 MiB 上限并在 `finally` 清零/恢复。取消、空/错 v1/v2 包、非 TTY 与重复 finish 均在副作用前拒绝或进入既有耐久重放。证据：`index.ts`、`recovery-package-input.ts`/测试、command/codec 测试。 |
| IR35-03 | [x] | source-less inventory 与候选选择 | directory inventory 只从冻结物理根读取已发布目录，重验 manifest/envelope/chunk exact-set 并过滤非 full authority；paired inventory 严格反绑 request/target/recipient 并拒绝重复 checkpoint。候选按时间、target、checkpoint 稳定排序，唯一项自动选中，多项必须给合法序号；公开投影仅含序号、位置、备份时间和待验证状态。证据：`checkpoint-target.ts`、`paired-checkpoint-target.ts`、`disaster-recovery-inventory.ts` 及其直接测试。 |
| IR35-04 | [x] | strict DR command/result 与状态联合 | core 将 DR command/result/state 建模为独立判别联合，逐 op/status 校验 exact keys、v1 schema、恢复根/目标 issuer 签名及 originating request/transfer；reducer 同时反绑 mode、prepare/import/commit/abort/tombstone 身份并拒绝跨 planned/conversation 混型、终态逆转和字段污染。证据：`anchor-transfer.ts`、contracts/schema 导出及逐字段污染/reducer 测试。 |
| IR35-05 | [~] | target-wide candidate 单飞 | claim 本身在 target-wide `FileAuthorityCommitLog` 中单飞，但灾难 candidate 只有 `claimed → verified → terminal`，没有保存可 exact replay 的 prepared/import decision，也把 `committed` terminal 当成安装前决定。`prepareAndImport()` 每次重算带当前 `verifiedAt` 的 onsite verification；首次 `recordVerified()` 后至 per-transfer imported 追加前崩溃或响应丢失，重试会与已存 verified bytes 冲突。更严重的是 `commit()` 在 authority WAL install 前先写 candidate `committed`，target-wide reducer随即允许异 transfer claim；后者可在前一安装窗口并发并再次替换 authority WAL。已 aborted 的同 transfer 也会继续进入 private context/verification 后才冲突，terminal replay 非零副作用。证据：`disaster-recovery-candidate.ts:147-241`、`disaster-recovery-target.ts:230-352,493-521`、`target-wide-anchor-candidate.ts` 与 `verifiedAt: Date.now()`；现有四项 target 测试使用固定 clock 且未注入上述窗口。结论：存在 P0 阻断根因，待整轮统一登记。 |
| IR35-06 | [x] | 恢复根真解封与现场验证 | `verifyStoredFullAuthorityCheckpoint` 先验 envelope exact shape、recipient、issuer 签名和 digest，再以 X25519/HKDF/AES-GCM 逐 seq 解封固定块并反绑 AAD、nonce、manifest/payload/coverage；声明内容逐 ref/size/digest 写入私有 sink，截断、额外、重排、错 key/target/verification 均在 authority/trust 发布前失败，明文与密钥材料在 `finally` 清零。证据：`checkpoint.ts`、`disaster-recovery-authority.ts` 及篡改/现场 verification 测试。 |
| IR35-07 | [x] | authority/trust 前缀重放与 no-rollback baseline | 生产命令在首个 claim 前启动认证 evidence mesh，冻结本机与当次已认证连接组成的 cut；collector 对 cut 内 peer 使用严格 request/result、signed current record 与 exact suffix，任一请求失败由 `Promise.all` 使整次 attempt 在零 claim/key/import 前失败。selector 对 checkpoint、本机与 peer 链逐祖先比较，取最长兼容链并复验 current root、issuer、epoch 与目标 active anchor 资格；cut/evidence digest 随 candidate 持久化。证据：`disaster-recovery-command.ts`、`disaster-recovery-trust-evidence.ts`、`selectRecoveryBaseline()` 与真实认证 mesh 直接场景。 |
| IR35-08 | [x] | 六类 checkpoint 覆盖与禁止内容 | full payload 仍只接受冻结的 authority/asset coverage；record pages 与 `ArtifactLifecycleIndex` retention exact-set 形成 catalog 六类恢复闭包。payload/header/catalog 均 strict exact keys，递归 checkpoint、缺/多 ref、目录漂移、秘密、环境、物理路径与缓存不能进入有效 full envelope，内容或 digest 不全即在 import 前拒绝。证据：`checkpoint.ts` full validator、Unit 33 capture/retention 生产链与 `buildDisasterRecoveryCatalog()`。 |
| IR35-09 | [x] | 无秘密 AuthorityCatalog 与 pending exact-set | catalog 由已验原 commit pages 顺序重放，逐 LSN 重算 prefix、stream ranges 与 `PendingObligationTracker`，固定六类 coverage、authority record ref、retained refs、baseline trust/current issuer 后再经 `prepareAuthorityCatalog` 规范排序与摘要；其 strict DTO 不含 secret、物理路径或 cache。少/多/乱序 page/ref/record 均在 catalog 发布前失败。证据：`buildDisasterRecoveryCatalog()`、core catalog validator 与真实 log/index 测试。 |
| IR35-10 | [~] | transfer 私有完整导入 | 私有 root/receiver 的块级断点、digest/size 校验和零公开边界成立；但 candidate verified 与 per-transfer imported 分属两个日志且没有耐久 prepared replay object。崩溃在 candidate verified 已 sync、imported 尚未 sync 的窗口后，重启只能重新现场签发 verification/ReadyProof，时间字段改变导致 candidate exact replay 冲突，无法从现有私有块进度推进 imported 终态。该缺口使响应丢失与连续重启下完整导入永久卡住。证据：`prepareAndImport():243-352`、`recordVerified():147-181`、`createRecoveryCheckpointVerification(...verifiedAt...)`。结论：与 IR35-05 同根的 P0 阻断缺口。 |
| IR35-11 | [~] | 共享 CAS 提升与 cleanup 边界 | promotion 仅枚举已验 authority/catalog/pages/retained exact-set，已有 digest 直接复用，缺失对象才从私有 store 以独立 partial 逐块写入共享 CAS；abort 只递归删除 `stagingRoot/transfers/<transferId>` 并释放 reservation，不触碰共享 CAS，tombstone 只推进私有终态。已有、新增与共享 digest 均保持内容寻址幂等和现有业务引用有效。证据：`DisasterRecoveryTarget.#promote()`、`abort()`、`tombstone()` 与 candidate references 保护边界。 |
| IR35-12 | [~] | immutable/composite authority base | `installPlannedAnchorPrefix` 在独占 log 锁内把已解码的原 source envelopes 逐 LSN 复算 source prefix，同时以目标 logId 重建物理 frame chain；安装 entries 仅追加在 sourceHead+1，临时 WAL 完整 fsync 后原子替换并重置全部 durable projection。pointer/安装前旧 WAL 保持不变，替换后 snapshot/tail/stream 共读同一完整 WAL。证据：`commit-log.ts:306-428`、DR record-set/replay 校验。 |
| IR35-13 | [~] | DR commit 身份与签名 | strict commit/ReadyProof 完整反绑 request、transfer、candidate/baseline evidence、目标与实际私有 issuer key；生产 `productionRecoveryReadiness()` 复用 planned coordinator，逐次读取真实 anchor/executor 角色、完整配置与 CLI 版本、执行资产 digest、SecretStore credential generation/read-back 及 provider/MCP binding revision。proof 创建和 install 前均 reserve/revalidate 同一 snapshot，缺配置、锁定秘密、缺 key、expiry 或 revision 漂移均在公开安装前失败。证据：`disaster-recovery-command.ts:504-539`、`disaster-recovery-target.ts:274-325,383-408,473-493` 与 shared readiness 合同。 |
| IR35-14 | [~] | 单 envelope 原子安全域发布 | `installPlannedAnchorPrefix()` 对单次 source prefix、trust/current owner、exposure、committed record 与 installation 的 WAL replacement 本身原子；但调用方在线性化前已将 candidate/target-wide 状态写成 `committed` 并释放单飞。该 terminal 不是 authority 安装事实，崩溃时会留下“candidate committed、authority 未安装”，并允许另一个已认证 transfer 在首个安装完成前 claim；两次 install 均可在各自 log 锁中依次替换 WAL，后者覆盖前者。因而 candidate 决定与唯一安全域发布并非同一前向状态机。证据：`DisasterRecoveryTarget.commit():493-520`、`FileDisasterRecoveryCandidateJournal.terminal()`、`assertTargetWideAnchorCandidateAvailable()` 与 `installPlannedAnchorPrefix():322-419`。结论：与 IR35-05 同根的 P0 原子发布缺口。 |
| IR35-15 | [~] | 双端 phase、abort 与 forward-only | claim-only root-signed abort 已能在 candidate transaction 先耐久，per-transfer 无 phase 时返回合成 aborted 终态；但完整 phase 仍不闭合：candidate 没有互斥的 prepared/import payload 与 nonterminal commit-decision，`recordVerified` 与 imported 跨日志不可重放，`committed` 又在 authority install 前成为可释放 terminal。prepare/abort/commit 竞争可因此产生 terminal 后继续私有副作用、prepared replay 永久冲突，或 target-wide 放行后两个 install 前向竞争。证据：candidate state union、`prepareAndImport()`、`commit()`、`abort()` 与 target-wide reducer。结论：P0 阻断，和 IR35-05 同根。 |
| IR35-16 | [x] | 旧设备隔离确认与 tombstone | `recover-finish` 必须收到显式 `--confirm-old-device-isolated`，随后只接受 current disaster installation 的 exact transfer 与已 committed 私有 journal；未确认、错 transfer、未提交均拒绝，重复 tombstone 返回原终态。tombstone 只追加私有 terminal，不修改新 trust/current owner，旧 issuer/epoch 已在 commit 原子 envelope 永久 revoke。证据：CLI finish、`DisasterRecoveryTarget.tombstone()` 与 replay 测试。 |
| IR35-17 | [~] | installed-generation 与 post-install 消费闭包 | `MeshRuntimeBootstrap` 冷启动与运行中 trust watcher 均从同一 durable disaster installation 加载 descriptor；watcher 在首个 await 前置 `transition-pending`，随后复用 installed-generation coordinator，核对固定 participant、三组 consumer 与六类 pending read-back。只有同 authority log 的 durable completion receipt 成立后才清理、开放 surface/control；CLI 亦等待 exact receipt 才报告成功，响应丢失按 current installation 重放。证据：`mesh-runtime-bootstrap.ts`、`mesh-runtime-assembly.ts:758-776,1430-1532`、`disaster-recovery-installation.ts`、`disaster-recovery-command.ts:104-115,195-204`。 |
| IR35-18 | [x] | current-owner 路由与旧代际 fencing | canonical registry/S7、current-authority/current-conversation router、direct append 与 credential guard 继续共享 signed current trust；live/cold completion 在 gate 关闭期间先重绑 runtime generation/projection/cursor，再恢复三组 consumer和六类 pending，完成 receipt 前所有 current-owner 入口稳定拒绝。旧 issuer 已在安装 envelope revoke，旧 epoch/route/surface 不再被公开准入。证据：assembly transition gate、installed-generation participant receipt、current-owner router exact-set 与 S7。 |
| IR35-19 | [~] | exposure compromised 原子投影 | commit 从恢复前缀的 exposure latest projection 仅选旧 issuer device 的 active records，以原 identity/revision 在同一 installation envelope 推进 compromised；投影按 device/binding/service/principal/tenant/scopes、时间与 revision 单调重建并拒绝歧义。公开 `rotationRequired` 只含非秘密服务、租户、scopes 与行动提示。证据：`projectDeviceCredentialRevocation()`、`DisasterRecoveryTarget.commit()` installation entries 与 exposure projection 合同。 |
| IR35-20 | [x] | 每条秘密读取路径的 binding guard | provider/channel/MCP 在 generation secret 读取前经 startup guard 映射稳定 logical binding；rendezvous 在 mesh 外联和 pairing 的 guarded store 校验；webhook 当前无启用生产发送器且保留 strict SecretRef/transport 边界。guard 只接受有限种类并排除 device-key，未知 kind fail-closed；compromised 只阻断同 binding，不影响其他 binding。证据：`startup.ts`、mesh control/pairing guarded store、`CredentialExposureAuthority.assertRoute()`、providers loader 与 S7 exact-set。 |
| IR35-21 | [x] | 第三方凭据轮换闭环 | 生产 command 在 authority runtime、MCP 与 channel 接入面就绪后唯一调用 `publishRequiredCredentialRotations()`；它只处理当前 compromised exact-set，按 provider/channel/MCP 分别取得 service-verified principal/readiness，要求 SecretStore 同值回读，并以稳定 request/revision 调用现有 `publishRotation()`，在单 envelope 发布新 active 与旧 rotated。失败保持旧 compromised，其他 binding 隔离。证据：`command.ts:762-780`、`credential-rotation-publication.ts`、`CredentialExposureAuthority.publishRotation()` 与三类直接测试。 |
| IR35-22 | [x] | 资源、物理 I/O、取消与 stop | 命令持有唯一 scoped signal，并贯穿 evidence discovery、inventory open/read、paired wait、prepare/import、promotion 与 commit；directory/paired、unseal、private receiver、CAS promotion 和日志物理步骤复用同一设备 storage governor，固定块/header 有界且网络等待不持 permit。pre-commit 异常在同 catch 生成 root-signed abort，先耐久 candidate terminal 再清理；已安装 commit 只前滚。证据：`runDisasterRecoveryCommand()`、target signal 形参、storage maintenance steps、paired target 与 S7 signal exact-set。 |
| IR35-23 | [x] | 用户恢复旅程与公开 DTO | recover 只显示稳定序号、清洗后的目录 basename/设备名、备份时间与行动阶段；request/transfer/checkpoint/target/root/digest/epoch 均不回显，异常统一映射为无 raw cause/path 的可行动错误。CLI 仅在 durable post-install receipt 后报告旧设备失权，再逐项提示第三方凭据和隔离确认；finish 必须显式确认且 terminal replay 不重走恢复副作用。证据：`disaster-recovery-command.ts`、public error mapper、CLI/server registry golden。 |
| IR35-24 | [x] | topology 与 owner/receiver exact-set | DR owner 仅由显式 CLI recover 在本机为 active anchor 且非 current issuer 时构造；directory/paired adapter 只暴露 checkpoint inventory/read，不注册通用 authority 服务。anchor+executor 与 anchor-only 共用有限入口，executor-only、surface、disabled、旧 issuer、非 anchor、未选 candidate 在 claim 前拒绝；live runtime 仅消费本机已安装 generation。证据：`openRecoveryContext()`、inventory adapters、canonical CLI registry 与 S7 disaster descriptor。 |
| IR35-25 | [x] | 恢复根 rotate 原子计划 | CLI 先确认用户动作、无回显验 current package，再生成并回读 candidate root；root event 同时受旧恢复根授权并携新根 proof。新 full checkpoint 经既有 activation coordinator 写入独立 target、回读验证后才由 current issuer 提交 rotate/verified/superseded 计划，checkpointId 与计划 digest 驱动崩溃重放。任一前置失败不改变本地 current root。证据：`backup-command.ts`、`RecoveryRootLifecycleService.rotate()`、activation coordinator 测试。 |
| IR35-26 | [x] | 恢复根 invalidate | 公开命令要求显式确认、current issuer context 与当前恢复包；root-signed invalidate 经 trust reducer 验 current epoch/root 后同 authority envelope 清除 root/backup key 与 activation digest，后续 backup/DR readiness 如实不可用。旧/错包与重复 event 被链序/reducer 拒绝；恢复只能由 current issuer 重新走现有 full checkpoint establish，不自动开启替代能力。证据：CLI command、lifecycle service、trust-chain reducer。 |
| IR35-27 | [x] | domain-reset + establish 原子计划 | reset/establish reducer、双签校验与 checkpoint activation plan 保持原子；approve-reset 使用独立只读 context，仅从 SecretStore 精确加载唯一既有本机 device key，读取并核对 current signed trust/projection，要求本机 distinct active 且非 issuer，不检查 anchor role、不创建或加载 issuer key、零 authority 写。issuer 端仍经严格 context 汇合 approval 并执行 reset+establish。证据：`backup-command.ts:224-320`、trust reducer、真实 SecretStore/trust 场景与 S7 最小权限 gate。 |
| IR35-28 | [x] | pending-reenroll 与 fresh pairing | domain-reset reducer 将除 issuer 外的全部 active member 原子推进为 `pending-reenroll`；运行中 control plane 每秒重读耐久 trust，`reconcileTrust()` 会断开非 active peer、删除其 rendezvous secret并撤销 surface，冷启动也只装配 active exact-set。pairing 仅对 identity 全等的 pending member生成带 fresh transcript digest 的 `reenroll`，其他已有设备不能走 enroll 绕过；distinct active approval 不可得时 reset fail-closed，不提供单设备原地重建。证据：`trust-chain.ts:145-152,245-277`、`mesh-control-plane.ts:137-203`、`mesh-pair-command.ts:795-838`。 |
| IR35-29 | [~] | 安全、最小权限与数据隔离 | strict wire/catalog/error、SecretRef、物理路径、no-rollback evidence、真实 readiness、credential guard 与 distinct co-signer 最小权限均闭合；但 candidate `committed` 在 authority install 前释放 target-wide 单飞，允许两个同根认证恢复 transfer 依次替换同一 target authority WAL。该路径可覆盖刚安装的新 issuer/current owner，违反安全域换代唯一性；问题不涉及秘密外逸，而是当前必要的 authority 完整性。证据：IR35-05/14/15 的生产线性化链。结论：存在同根 P0 阻断。 |
| IR35-30 | [~] | 并发、重放、错误关联与 fail-closed | strict codec/reducer 对错 request/transfer/checkpoint/target/root/event/record/digest/epoch、字段污染与异载荷冲突仍 fail-closed；然而同 identity 的合法重放并不完整：onsite `verifiedAt`/ReadyProof 重算使 verified→imported 响应丢失后自冲突，aborted replay仍可先创建私有状态，commit terminal 与 authority install 的顺序允许异 transfer 抢占。错误关联边界成立，但合法并发/重放存在永久卡死和双安装。证据：IR35-05/10/14/15 与固定-clock测试空缺。结论：同根 P0 阻断。 |
| IR35-31 | [~] | lifecycle、启动、停机与连续恢复 | command scoped signal、governor stop、claim-only abort、live/startup installation completion、credential/root lifecycle 均可恢复；但 candidate verified/imported 与 commit/install 之间没有耐久中间决定。重启无法从 candidate log exact materialize 缺失的 per-transfer imported phase，且 candidate terminal 已 committed/authority 未 installed 的状态不会阻止异 transfer；连续恢复因此可能永久卡死或切换到另一 authority。证据：IR35-05/10/14/15。结论：同根 P0 lifecycle 阻断。 |
| IR35-32 | [~] | 状态机枚举行与必要故障证据 | strict DR/root/exposure 基础转移、no-rollback、真实 readiness、claim-only abort、live handoff、rotation 与 co-signer 已有必要证据；但 candidate 状态枚举缺少可重放 prepared/import 与不释放单飞的 commit-decision。现有 target 测试四项均使用固定 `now`，没有注入 `recordVerified→imported`、`candidate committed→WAL install`、aborted terminal replay 或异 transfer 抢占，S7 也只检查 abort-before-cleanup 字符串顺序。证据：测试场景表、fixture `now: () => NOW` 与 S7 `abortTerminal/abortCleanup` gate。结论：同根 P0 验收缺口。 |
| IR35-33 | [~] | 产品体验与范围价值 | 候选展示、TTY 无回显、错误映射、live receipt、凭据轮换、隔离确认、安全取消与 distinct approval 均符合目标；但受支持的恢复在正常响应丢失/重启下可能因重新签发 `verifiedAt` 而永久卡住，两个并发恢复还可能都越过已提前释放的 candidate 单飞。用户看到的是不可继续的“恢复未完成”或最终 authority 被后一次覆盖，均是当前核心旅程的具体损失。证据：IR35-05/10/14/15 的生产反例。结论：同根 P0 产品体验阻断。 |
| IR35-34 | [~] | S7、registry、descriptor 与生产 exact-set | S7 已反绑 evidence producer、真实 readiness、scoped signal、live/cold completion、rotation caller、co-signer context 与 canonical registry；但 candidate gate 只确认 `candidate.terminal(aborted)` 出现在 private cleanup 前，以及四个公开 target 方法/若干字符串 exact-set。它没有冻结 prepared replay object、commit-decision 非终态、authority install 前不得释放 target-wide claim，亦不拒绝 `candidate.terminal(committed)` 位于 install 之前，故当前 P0 绕过可通过 gate。证据：`scripts/s7-entry-coverage.mjs:1179-1256`。结论：同根验收缺口。 |
| IR35-35 | [~] | 分层、上游兼容与供应链 | core 仍只承载 strict contracts/reducer 与 commit-log 原语，mesh 承载 trust/crypto/checkpoint/native I/O，providers 仅消费 credential guard，CLI 负责组合，server 只维护 canonical golden；基线无 package manifest/lockfile、密码依赖或 PAKE 生产变化。Unit 33 checkpoint/retention 与 Unit 34 planned/current-owner 通过既有接口复用，当前残留位于 Unit 35 candidate 编排而非上游语义退化。证据：package/lock diff、生产 import 扫描与路径分层表。 |
| IR35-36 | [~] | 成比例的直接验收闭包 | reachable-peer evidence、真实 readiness、claim-only signed abort、live/startup handoff、credential rotation、stop/cancel 与 distinct co-signer 已有生产入口和直接证据；但验收未覆盖 candidate prepared/imported 与 commit/install 两个跨日志窗口。必须新增真实 candidate/per-transfer/authority log 故障测试：变化 clock 下 import 响应丢失/重启 exact replay、abort terminal 后零私有效果、commit-decision 后异 transfer stable busy、WAL install 前后崩溃及 terminal 补齐；同时扩展现有 S7 拒绝早释单飞。现有构建和四项 target 测试不能反证当前可达失败。结论：同根 P0 验收缺口。 |
| IR35-37 | [~] | 后继能力与非目标边界 | 65 条交付路径只实现手动 source-less authority 恢复、恢复根/凭据安全闭环及直接 gate/test；未出现自动 failover、quorum/witness、continuous/global sync、恢复应用、多目标/云、Unit 36～38 服务/卸载/发布、通用 transfer/registry/lifecycle/事务/outbox/事件总线或观测设施。单设备及 issuer+恢复包同时丢失继续 fail-closed并要求重建 home。证据：生产入口/import 扫描、路径表与明确排除双向对账。 |
| IR35-38 | [~] | 来源、D35义务与交付路径反向闭包 | 四份权威文档全部章节、规格规范枚举行与 D35-01～D35-09 均已双向归入 IR35-01～IR35-37；基线 `972f363e` 的 69 条 diff 中，Unit 34 归档 2 条与审查/修复状态 2 条继续明确排除，剩余 65 条 Unit 35 路径与 core 8、mesh 11、CLI 38、providers 1、server 1、S7 2、架构 2、当前单元工作台 2 完全相符且各出现一次。未发现未判定来源、重复路径、架构空洞或范围漂移。证据：来源表、路径表与 `git diff --name-only 972f363e` 反向对账。 |

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
