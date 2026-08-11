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
目标：只收敛第 35 单元正式问题列表中的 U35-07 一个 P0/中和 U35-08 一个 P2/小，使两项真正命中 disaster candidate 超限 verified/decision 未复用既有 artifact 引用合同，以及 pre-import authenticated abort 未收束 exact transfer key 的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U35-01～U35-06 的既有结论直接复用，已经闭合的 verified/imported/decision 状态顺序、target-wide claim 单飞、cancel/stop、signed abort、governor 与资源边界不得恢复或扩面，价值裁决否定的第二 journal、第二 prepared 事实和新存储/secret lifecycle 框架不得重新引入，自动 failover、全局同步、恢复应用及第 36～38 单元能力不得提前并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-07、U35-08，只依据两项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U35-07 → U35-08` 从权威架构、规格和当前生产调用图重建事实链，核准 candidate `FileAuthorityCommitLog`/`artifactStore`、verified/decision payload 与 ref retention，以及 transfer key、signed abort、install decision/current installation guard 的唯一事实源、稳定 identity、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中根因还是表象，并持续核对 U35-01～U35-06 的已验证边界。
2. 穷尽直接变体：U35-07 覆盖 verified/decision 在 32 KiB 上下界、空/非空及多 stream/retained/pending catalog、大 baseline/peer evidence/installation entries、claimed/imported/install-decided/terminal、ref 缺失/损坏/篡改、GC、响应丢失与连续重启；U35-08 覆盖 key 创建前后、verified 前后未 imported、imported、install-decided/current installed、同/异 identity、abort 效果/响应丢失与连续重启。每格必须指出唯一耐久事实、ref/key 身份、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：U35-07 只复用 candidate 现有 `FileAuthorityCommitLog.artifactStore`、`ArtifactRef`、`candidateReferences` 与 retention，把 canonical verified/decision payload 外置并在任何新副作用前加载、验 digest、strict decode 和反绑 identity；U35-08 只在 signed abort 耐久后复用现有 exact key delete，并保留 install-decided/current-installation 防误删门禁。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二 journal、第二 prepared 事实、通用存储/secret lifecycle/事务/同步/路由/outbox/事件总线/registry、新 lint/test runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 两项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：超限 candidate payload 与 artifact 生命周期、verified/decision/terminal exact replay 与连续恢复、pre-import key cleanup 与 active-key 隔离、生产证据/产品体验/范围价值及历史裁决边界。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 `U35-07↔U35-08`、两项与 U35-01～U35-06、第 33～34 单元既有合同及第 36～38 单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U35-07、U35-08 的全部受支持 payload/ref、candidate phase、abort/key 生命周期及故障/响应丢失/连续重启终态均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会恢复重复状态事实或因逐 payload/key 切点补丁继续返工。满足后明确回复“U35-07、U35-08 的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 35 单元 U35-07 一个 P0/中和 U35-08 一个 P2/小，闭合 disaster candidate 超限 verified/decision 的 artifact root、嵌套引用 retention 与严格 hydration，以及 pre-import authenticated abort 对 exact transfer key（含并发晚到 creator）的耐久收束及全部同根直接变体；不得扩展到其他问题或全单元流程。U35-01～U35-06 的既有结论直接复用，已经闭合的 verified/imported/install-decided 状态顺序、target-wide claim 单飞、cancel/stop、signed abort、governor 与资源边界不得恢复或扩面，价值裁决否定的第二 journal、第二 prepared 事实和新 storage/secret lifecycle 框架不得重新引入；自动 failover、全局或持续同步、恢复应用及第 36～38 单元能力不得提前实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 35 单元正式文件中的 U35-07、U35-08，只依据两项问题最新的根因、价值裁决、F35-21～F35-30 固定矩阵、C35-C31～C35-C40 反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建 F35-21～F35-30 固定矩阵。U35-07覆盖verified/decision在32 KiB上下界、空/非空及多stream/retained/pending、大baseline/peer evidence/installation entries、claimed/imported/install-decided/terminal、payload及嵌套refs、GC、错/缺/篡改ref、效果/响应丢失和连续重启；U35-08覆盖key创建前后与abort并发、verified前后未imported、imported、install-decided/current installed/active、同/异identity、slot替换、删除效果/响应丢失和连续重启。逐格绑定candidate payload/ref、phase/transfer/key identity、唯一耐久事实、线性化点、零副作用终态和直接证据，并持续核对U35-01～U35-06、第33～34与第36～38单元边界。
2. 按 `U35-07 → U35-08` 一次完成。先把`FileDisasterRecoveryCandidateJournal`的verified与decision canonical bytes写入其现有`FileAuthorityCommitLog.artifactStore`：内部同步projection/reducer只保存prepare、phase、transferId与payload `ArtifactRef`，`state()`/`states()`在日志锁外按verified→decision加载，验artifact digest/length、canonical JSON与strict DTO，并逐级反绑prepare、verified、recovery root及installation identity。`recordVerified()`/`decideInstall()`先在锁外规范化和put，再由同一candidate transaction只比较/追加compact ref；`candidateReferences`保护新payload ref，decision同时保护其冻结引用exact-set，同输入复用同ref、冲突输入拒绝。

   在现有registered artifact root exact-set中只增加这两个candidate record tag，解引用payload并按既有缺省规则无条件保留其中全部`ArtifactRef`；不得新建registry，也不得在projection reducer或日志锁内做artifact I/O。任何缺ref、digest/bytes/canonical/strict decode/identity错误都必须在import、decision、authority、terminal新副作用前fail-closed；terminal历史重放只hydrate同一冻结ref，普通未引用payload仍由现有GC处理。

   随后让authenticated abort收束exact transfer key：`candidate.terminal(...,"aborted")`以完整identity耐久胜出且既有install-decision/current-installation门禁通过后，无论是否imported，都加载transfer专属slot的当前key，以其deviceId调用现有`deleteAnchorIssuerKey()`完成compare-delete/read-back，再清staging、release reservation并返回。fresh creator必须保留`loadOrCreateAnchorIssuerKey()`返回的exact identity，在`recordVerified()`前后复核candidate；若同identity abort已胜出或recordVerified因该terminal拒绝，用返回identity补偿删除，slot被替换则稳定拒绝。同步直接相关架构、规格、现有S7与直接测试；同根残留并入U35-07/U35-08，禁止新增第二journal、第二prepared、通用storage/secret lifecycle/事务/同步/路由/outbox/事件总线/registry、新lint/test runner、监控、诊断、benchmark或信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、authority registered-root retention、candidate reducer/codec/hydration、disaster target prepare/import/commit/abort与SecretStore exact-key cleanup直接合同和场景测试，现有S7 lint及必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过真实candidate/target-wide `FileAuthorityCommitLog`、其`FileArtifactStore`与retained-reference projection、per-transfer journal、SecretStore和目标authority log，直接注入32 KiB上下界、大catalog/evidence/entries、GC、错/缺/篡改ref、key create/abort竞争、slot替换、install门禁、效果/响应丢失和连续重启；不得以mock自报retention/hydration/cleanup或只验证返回值，不得运行包全测、模块回归、配置×故障笛卡尔积或与两项验收无关的验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读逐格重建 U35-07、U35-08 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：超限candidate payload与artifact生命周期、verified/decision/terminal exact replay与连续恢复、pre-import key cleanup与active-key隔离、生产证据/产品体验/范围价值及历史裁决边界。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查`U35-07↔U35-08`、两项与U35-01～U35-06、第33～34单元既有合同及第36～38单元边界的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第2步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U35-07、U35-08 方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C35-C31～C35-C40及新增同根反证全部有耐久处置，证明任意合法verified/decision payload不受32 KiB内联上限阻断，candidate日志只耐久唯一ref，payload与嵌套refs在GC、terminal、错ref、响应丢失和连续重启下严格验真并exact replay；pre-import authenticated abort在key创建前后及creator竞争下都先耐久terminal再收束exact transfer slot，错identity/slot替换零误删，install-decided/current active key永久保留。U35-01～U35-06与第33～34单元结论不变，第36～38单元能力未提前实施，两项均已更新为“已验证”。满足后明确报告“U35-07、U35-08 两项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 36 单元 · generation 1
- **单元身份**：S10 托管服务与角色自恢复；只把现有单一 `serve` 生产组合根接入当前用户的跨平台 OS supervisor，使 current anchor 可自恢复、用户选择的 executor 可在登录/开机后上线，并保持纯 surface 与按需单机零额外常驻。
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`distributed-runtime-charter.md`、`specification.md`、`s2-security-supply-chain-review.md`，以及已定稿开发清单 D36-01～D36-09。上游只消费第 33～35 单元已封版的 current trust/current owner、角色解析、SecretStore、installed-generation 恢复、pending obligation/outbox、inventory/capability 与 credential readiness；下游第 37～38 单元能力不进入本清单。
- **交付基线**：以第 35 单元功能封版提交 `b6323cb8` 为代码基线；当前工作树共有 47 条变更路径，其中 43 条构成第 36 单元生产/测试/S7 功能交付；`unit-development-workbench.md`、Unit 35 的清单归档与正式账本、当前 `unit-submit-review.md` 共 4 条只属流程维护，不作为 Unit 36 功能证据。
- **生产装配关系**：`zz pair` 与受支持本机配置提交写入 `MeshRoleBootConfig`；`resolveHostLaunchPlan()`以 current signed trust/current issuer、本机 active member、严格 `enabledRoles`和 `executorAutoStart`派生 `managed | on-demand | none`。`reconcileManagedService()`经 Windows Task Scheduler、macOS LaunchAgent 或 Linux systemd user/linger 安装、禁用、启动并回读；managed child 仍唯一委托 `runServeCommand`/`MeshRuntimeBootstrap`/现有角色拓扑，anchor 恢复既有 authority/consumer/outbox，executor 的已接受 capability/inventory 变化唤醒原排队任务；CLI 与 server 共用有限公开状态投影。
- **目标提交边界**：冻结 launch plan 与配置合同、同 SecretStore backend 的跨平台服务定义、全部生产 reconcile 触发、单实例托管启动、ready/rollback、自恢复 authority closure、executor 自动上线与原 `turnOrigin`续驱、角色变化安全关停、公开零术语状态、S7/registry exact-set 与成比例直接证据。
- **明确排除**：第 37 单元的只停本次、长期关闭值班、设备移除/卸载、authority/identity/cache/export 清理和三路径停机协议；第 38 单元升级、兼容、原子替换、健康门禁、自动回滚、发布矩阵、支持包与仓库级最终 CI；自动 failover、quorum/witness、多 active anchor、全局/持续同步、恢复应用、第二事实源、多进程分角色、通用进程/生命周期/IPC/路由/registry；surface 常驻、强制按需单机后台化、监控、诊断、benchmark、信息采集、新 runner 或非必要依赖。
- **架构空洞判定**：总纲 §10/§11/§12/§13/§14/§15、规格 §2.3/§2.5/§3.4b/§6.4/§8/§10.1/§11/§12/§15 第 36 行与 D36-01～D36-09 已唯一确定产品、角色、秘密、资源、恢复、体验和交付边界；当前没有需要以实现假设补齐、且会改变产品需求或单元边界的真实架构空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论。

> **清单状态**：35 项 `[ ]`、0 项 `[x]`、0 项 `[!]`、0 项 `[~]`；本清单已按权威来源、完整功能链和当前交付路径重新定稿，尚未执行独立审查。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| always-online-and-local-execution-requirements.md §一 | 适用 | 持续在线值班设备与真实本机执行的核心问题归入 IR36-01、IR36-22～IR36-24、IR36-32。 |
| 需求文档 §二 | 不适用 | 对方回复汇总属于需求形成材料，不独立产生 Unit 36 字段、状态或门禁。 |
| 需求文档 §三 | 不适用 | 外部产品核验是历史事实来源，不替代当前知行托管服务合同。 |
| 需求文档 §四 | 不适用 | 架构审核过程不新增当前实现义务；最终裁决已进入总纲与规格。 |
| 需求文档 §五 | 不适用 | 外部现状归纳不产生 Unit 36 生产或验收门禁。 |
| 需求文档 §六 | 适用 | 单机与多设备形态平权、工作环境留在真实设备归入 IR36-03、IR36-15、IR36-22、IR36-32。 |
| 需求文档 §七 | 适用 | 电脑离线任务不丢、上线续跑、单机用户零分布式成本归入 IR36-03、IR36-22～IR36-24、IR36-27、IR36-32。 |
| 需求文档 §八 | 不适用（直接） | 章节冻结 planned 值班迁居产品要求；Unit 36 只继承设备名与零术语体验，不重开迁居状态机，分别由 IR36-26、IR36-31 承载边界。 |
| s2-security-supply-chain-review.md「范围说明」 | 适用（兼容边界） | 当前修改 mesh 与 SecretStore；只核对既有安全依赖边界且不宣称仓库级供应链结论，归入 IR36-28、IR36-31、IR36-35。 |
| S2 评审「裁决」 | 适用（兼容边界） | 三项生产依赖与 PAKE 开发依赖用途不得因托管入口漂移，归入 IR36-28、IR36-31。 |
| S2 评审「强制门禁」 | 适用（兼容边界） | 精确锁版、owner、PAKE 非生产隔离及 package import/export/build 门禁归入 IR36-31、IR36-35。 |
| S2 评审「接受依据」 | 适用（兼容边界） | 不新增密码依赖、不改变 TLS/证书/PAKE边界及秘密暴露面，归入 IR36-06、IR36-28、IR36-31。 |
| distributed-runtime-charter.md「当前版本交付原则」 | 适用 | 最小完整范围、架构优先与禁止为后继单元预建框架归入 IR36-01、IR36-31～IR36-35。 |
| 总纲「一、架构概况」「二、凝练需求」「三、架构基线设计」 | 适用 | 单一产品、值班设备持续在线、工作电脑本机执行、同一协议与单一组合根归入 IR36-01、IR36-03、IR36-15、IR36-27、IR36-32。 |
| 总纲 §1 架构结论 | 适用 | current anchor 唯一、同一内核/端口、服务不得成为第二权威归入 IR36-02～IR36-03、IR36-15、IR36-18～IR36-20。 |
| 总纲 §2 角色模型 | 适用（直接） | anchor/executor/surface 角色授权与未启用角色零加载归入 IR36-02～IR36-04、IR36-20、IR36-27。 |
| 总纲 §3 包与依赖边界 | 适用 | core/mesh/secrets/server/CLI 分层、组合根职责与无环依赖归入 IR36-15、IR36-27、IR36-31、IR36-35。 |
| 总纲 §4 设备网格与安全协议 | 适用（权威输入） | signed trust、current issuer、成员状态、撤销/换代与认证 mesh 是 plan/reconcile 唯一输入，归入 IR36-02～IR36-03、IR36-12、IR36-20、IR36-28。 |
| 总纲 §5 权威矩阵与执行清单 | 适用（恢复闭包） | anchor authority、executor本地域与环境/秘密边界必须由同一 runtime 恢复，归入 IR36-17～IR36-19、IR36-22、IR36-27。 |
| 总纲 §6 run 派发协议 | 适用（消费闭包） | restart/reconnect 后 assignment、队列、提交、final 与原请求身份不得改变，归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-30。 |
| 总纲 §7 环境模型与路由 | 适用（负边界） | 托管定义/状态不得携 workspace 原始路径，executor 仍只消费既有环境引用，归入 IR36-05、IR36-22、IR36-26、IR36-28。 |
| 总纲 §8 双平面通信 | 适用 | executor重连、control ready、数据面不降级与原 `turnOrigin`通知归入 IR36-22～IR36-23、IR36-30。 |
| 总纲 §9 离线本地会话、收编与迁居 | 适用（冻结上游） | planned/disaster installation、installed-generation/current-owner与pending closure仅作为启动恢复输入，不重开 transfer 能力，归入 IR36-17～IR36-20、IR36-31。 |
| 总纲 §10 凭据与服务生命周期 | 适用（最高直接依据） | SecretStore可解锁、跨平台托管、anchor自恢复、executor可选自动上线、纯surface/按需零常驻与未启用零监听归入 IR36-03～IR36-22、IR36-27～IR36-30；三路径停机/卸载/升级段不适用并由 IR36-21、IR36-31 守边界。 |
| 总纲 §11 产品体验设计 | 适用 | 开箱零概念、配对引导、日常状态、离线排队与原位置通知归入 IR36-04、IR36-23～IR36-26、IR36-32。 |
| 总纲 §12 故障矩阵全部枚举行 | 适用（所属切片） | executor/owner崩溃、ack/final/响应丢失、网络分区、旧epoch、日志/磁盘、撤销、重投、版本/时钟等固定场景逐项归入 IR36-11、IR36-17～IR36-23、IR36-29～IR36-30、IR36-33～IR36-35；不属于Unit36的业务状态转移只核对恢复不回归。 |
| 总纲 §12 安全对抗矩阵全部枚举行 | 适用（兼容边界） | trust、签名、吊销、权限、租约与秘密边界不得因managed入口绕过，归入 IR36-17、IR36-20、IR36-28～IR36-31、IR36-35。 |
| 总纲 §12.1 S9 恢复根与备份状态边界 | 适用（冻结上游） | managed启动须消费同一current trust/root/readiness，不能把可选目标离线变成host失败或重开checkpoint服务，归入 IR36-17～IR36-20、IR36-26、IR36-31。 |
| 总纲 §13 行1 | 适用 | 每对话唯一owner及当前owner准入在anchor恢复后保持，归入 IR36-18～IR36-20。 |
| 总纲 §13 行2 | 适用 | run/job唯一身份与重复提交幂等在崩溃拉起后保持，归入 IR36-18～IR36-19、IR36-23。 |
| 总纲 §13 行3 | 适用 | 完整commit fence不得被自恢复旁路，归入 IR36-18～IR36-19、IR36-23。 |
| 总纲 §13 行4 | 适用 | 仅current anchor进程装配全局写，归入 IR36-03、IR36-18、IR36-27。 |
| 总纲 §13 行5 | 适用（直接） | 未启用角色零进程/零模块/零监听归入 IR36-03、IR36-20、IR36-27、IR36-34～IR36-35。 |
| 总纲 §13 行6 | 适用（直接） | 服务定义、参数、环境、日志、状态和wire零秘密归入 IR36-05～IR36-06、IR36-26、IR36-28。 |
| 总纲 §13 行7 | 适用 | 重连只改路径不减功能，归入 IR36-22～IR36-23、IR36-30。 |
| 总纲 §13 行8 | 适用 | installed/current-owner换代后旧owner拒写，归入 IR36-18～IR36-20。 |
| 总纲 §13 行9 | 适用（恢复兼容） | uncertain不因进程重启自动重执行，归入 IR36-18～IR36-19、IR36-23。 |
| 总纲 §13 行10 | 适用（直接） | capability/inventory失配零执行且恢复后才唤醒，归入 IR36-22～IR36-23。 |
| 总纲 §13 行11 | 适用（直接） | executor与单机版使用同一运行装配，归入 IR36-15、IR36-22、IR36-27。 |
| 总纲 §13 行12 | 适用（直接） | 单机是同一分布式代码的同进程特例，归入 IR36-03、IR36-15、IR36-27、IR36-32。 |
| 总纲 §13 行13 | 适用 | 用户可见完成仍为耐久终态，归入 IR36-19、IR36-23、IR36-25。 |
| 总纲 §13 行14 | 适用（直接） | server/executor包依赖无环，归入 IR36-31、IR36-35。 |
| 总纲 §13 行15 | 适用 | 托管恢复不得公开半提交业务状态，归入 IR36-17～IR36-19。 |
| 总纲 §13 行16 | 适用 | 进程内/跨机 authority guard保持同一，归入 IR36-17、IR36-20、IR36-22、IR36-28。 |
| 总纲 §13 行17 | 适用 | 重连/重投保持原入口幂等与原请求身份，归入 IR36-19、IR36-23、IR36-30。 |
| 总纲 §13 行18 | 适用（直接） | executor工作与managed定义写入均复用设备容量治理且无旁路，归入 IR36-10、IR36-22、IR36-29、IR36-33～IR36-35。 |
| 总纲 §14 实施序列 | 适用（Unit 36） | S10中的Unit36全适用；Unit37～38及S1～S9实现不重开，归入 IR36-01、IR36-31。 |
| 总纲 §15 验收纲 | 适用 | 体验、结构、故障、安全与产品语言按Unit36受影响闭包归入 IR36-32～IR36-35。 |
| specification.md §1.1 | 适用 | home/device/generation/epoch/时间与幂等身份归入 IR36-02～IR36-05、IR36-12～IR36-13、IR36-29。 |
| 规格 §1.2 | 适用 | canonical配置、definition、service identity与digest稳定归入 IR36-02、IR36-05、IR36-10～IR36-13。 |
| 规格 §1.3、§1.3b | 适用（兼容边界） | 新合同从权威包导出且不复制冻结符号，归入 IR36-02、IR36-31、IR36-35。 |
| 规格 §1.4 | 适用 | 总纲角色、trust、SecretStore与实现构件名保持同义全等，归入 IR36-02、IR36-06、IR36-31。 |
| 规格 §1.5 | 适用 | invalid/unauthorized/conflict/unavailable/not-ready等内部分类稳定映射而不泄漏原错，归入 IR36-11、IR36-17、IR36-25～IR36-26。 |
| 规格 §2.1 | 适用（直接） | `MeshRoleBootConfig`、active member、current issuer、role-change/revoke/reenroll逐项归入 IR36-02～IR36-04、IR36-12、IR36-20。 |
| 规格 §2.2 | 适用（恢复兼容） | capability/lease不得因host重启绕过或复活，归入 IR36-18～IR36-19、IR36-22～IR36-23。 |
| 规格 §2.3 | 适用（直接） | SecretStore后端、解锁、managed/foreground同binding与秘密零外泄归入 IR36-06、IR36-17、IR36-28。 |
| 规格 §2.4 | 适用（readiness边界） | 可选provider/channel/MCP binding故障只按既有readiness降级，不伪装host失败，归入 IR36-17、IR36-25～IR36-26。 |
| 规格 §2.5 | 适用（直接） | 角色授权、单机缺省、control重连和唯一拨号owner归入 IR36-02～IR36-04、IR36-17、IR36-22、IR36-27。 |
| 规格 §3.1、§3.2、§3.2b | 适用（恢复闭包） | SessionState/GlobalState/DeferredGlobalIntent端口与pending状态随anchor恢复，归入 IR36-18～IR36-19。 |
| 规格 §3.3 | 适用（负边界） | EnvironmentPort只在executor本机，workspace路径不进service/status/wire，归入 IR36-05、IR36-22、IR36-26、IR36-28。 |
| 规格 §3.4、§3.4b | 适用 | workload lease与设备capacity/storage maintenance分离但共用arbiter，归入 IR36-10、IR36-22、IR36-29。 |
| 规格 §3.5～§3.8 | 适用（恢复/守卫边界） | completion、executor/submission及mutation guard在重启与重连后继续使用既有身份与权限，归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-28。 |
| 规格 §4.1 | 适用（直接恢复） | managed anchor只重放同一 `AuthorityCommitLog`与投影，不建service journal，归入 IR36-17～IR36-19。 |
| 规格 §4.2 | 适用（恢复兼容） | ArtifactStore在场/retention事实不因托管启动改变，归入 IR36-18～IR36-19、IR36-31。 |
| 规格 §4.3 全部逻辑流记录 | 适用（恢复闭包） | conversation/job/control/assignment/final/transfer/installation/pending等固定流逐类保持原reducer和owner，归入 IR36-18～IR36-20、IR36-22～IR36-23。 |
| 规格 §4.3 delivery生命周期15行 | 适用（逐行恢复） | 十五行每一当前态在崩溃/登录拉起后由原outbox/consumer前滚，不复制、不丢失、不跨渠道，归入 IR36-18～IR36-19、IR36-23。 |
| 规格 §4.4 | 适用（兼容边界） | managed恢复不得重判staged/publish事实或公开半提交状态，归入 IR36-17～IR36-19。 |
| 规格 §4.5 | 适用（兼容边界） | 角色停启不删除authority/artifact/lifecycle事实，归入 IR36-20～IR36-21、IR36-31。 |
| 规格 §5.1 控制请求 | 适用（恢复） | host重启与重投继续按原入口幂等，归入 IR36-18～IR36-19、IR36-23。 |
| 规格 §5.2 派发 | 适用（直接executor链） | executor上线只唤醒原queued assignment/job，不改dispatch身份，归入 IR36-22～IR36-23。 |
| 规格 §5.3 能力、版本与匹配 | 适用（直接） | 已接受并耐久可见的capability/inventory变化才触发重试，归入 IR36-22～IR36-23、IR36-31。 |
| 规格 §5.4 提交 | 适用（恢复） | restart/reconnect不改变fence、digest与提交唯一性，归入 IR36-18～IR36-19、IR36-23。 |
| 规格 §5.5 终态与状态投递 | 适用（直接体验） | 完成/失败只回原 `turnOrigin`且幂等一次，归入 IR36-19、IR36-23、IR36-26。 |
| 规格 §5.6 run stream | 适用（兼容边界） | managed重连不建第二stream或破坏cursor，归入 IR36-22～IR36-23、IR36-30。 |
| 规格 §5.7 取证与止损 | 适用（恢复边界） | stop/restart不绕过existing evidence/abort守卫，归入 IR36-18～IR36-21、IR36-28。 |
| 规格 §6.1 conversation run 36行 | 适用（逐行恢复） | 固定36行在owner崩溃/恢复、重投和旧epoch下仍由原状态机判定，归入 IR36-18～IR36-19、IR36-23、IR36-30。 |
| 规格 §6.2 job run 38行 | 适用（逐行恢复） | 固定38行含offline queued上线唤醒与终态投递，归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-30。 |
| 规格 §6.2b system job 6行 | 适用（逐行恢复） | 固定6行仅由current anchor恢复，不因managed启动重复执行，归入 IR36-18～IR36-19。 |
| 规格 §6.3 AuthorityTransfer 全部枚举行 | 适用（冻结上游） | Unit34/35 installation只作启动恢复输入，managed服务不得新建transfer或回滚，归入 IR36-17～IR36-20、IR36-31。 |
| 规格 §6.4 设备状态11行 | 适用（直接） | paired/configured/ready/degraded/revoked/pending-reenroll每行均影响plan、ready、disable或reconcile终态，归入 IR36-02～IR36-04、IR36-12、IR36-17、IR36-20、IR36-25。 |
| 规格 §7 权威覆盖表六行 | 适用（逐行恢复） | 全局/会话/会话资产/环境与秘密/执行资产/非权威缓存逐类按既有恢复或禁止恢复语义归入 IR36-18～IR36-19、IR36-22、IR36-28。 |
| 规格 §8 直接入口行 | 适用（入口exact-set） | `status-read`、`shutdown`、`runtime-config`、`device-trust`四行逐行归入 IR36-12、IR36-20～IR36-26、IR36-35。 |
| 规格 §8 既有业务入口行 | 适用（冻结消费闭包） | `session-send`、`environment-select`、`run-cancel`、`uncertain-resolution`、`confirmation-resolve`、`confirmation-read`、`session-observer`、`global-list-read`、`permission-persist`、`trust-manage`、`conversation-manage`、`conversation-window`、`conversation-metadata`、`conversation-read`、`task-list`、`advancement`、`workscene-manage`、`workscene-switch`、`schedule-manage`、`schedule-run`、`schedule-timer`、`memory-write`、`memory-read`、`skill-manage`、`skill-usage`、`segment-transition`、`workspace-binding`、`runtime-lifecycle`、`advancement-evidence`、`orchestration-child`、`channel-inbound`、`channel-delivery`、`light-inference`三十四行逐行只核对owner/guard及恢复路由不因managed入口漂移，归入 IR36-17～IR36-19、IR36-22～IR36-23、IR36-26、IR36-31。 |
| 规格 §8 S9管理入口行 | 适用（冻结上游） | `recovery-backup`、`disaster-recovery`、`recovery-root-lifecycle`三行逐行只作为managed启动恢复输入，不允许重开其生产能力，归入 IR36-17～IR36-20、IR36-26、IR36-31。 |
| 规格 §9 能力矩阵全部行 | 适用（拓扑兼容） | current-anchor、executor本地域、纯surface和单机路径保持原能力与禁产边界，归入 IR36-03、IR36-15、IR36-18、IR36-22、IR36-27。 |
| 规格 §10 资源治理及终结表 | 适用（executor恢复） | queued工作重启/上线重新准入、原lease/usage终结不伪造，归入 IR36-22～IR36-23、IR36-29～IR36-30。 |
| 规格 §10.1 六项设备存储治理条款 | 适用（直接） | 单容量真相、装配、atomic上界、分类、恢复、锁序/stop/验收逐条归入 IR36-10～IR36-11、IR36-17、IR36-22、IR36-29、IR36-33～IR36-35。 |
| 规格 §11 四条产品旅程 | 适用（Unit36切片） | 开箱、扩展、日常中的自动上线/排队/状态/通知直接归入 IR36-04、IR36-22～IR36-26、IR36-32；设备丢失流程不重开。 |
| 规格 §12 十八条不变量测试口径 | 适用（逐条受影响闭包） | 与总纲§13行1～18同一映射，归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-27～IR36-31、IR36-33～IR36-35。 |
| 规格 §13 模块文档影响清单 | 不适用（直接） | 本章列举S1～S7文档同步及S10三路径停机回填，后者属于Unit37；Unit36没有另行修改模块文档的规范义务。 |
| 规格 §14 S1开工清单 | 不适用（直接） | 该章是已完成S1的历史执行顺序；Unit36只把其单一组合根和golden当冻结上游，由IR36-15、IR36-31、IR36-35检查兼容。 |
| 规格 §15 行1 | 不适用（直接） | 规格冻结是已完成的历史规划动作；当前只消费其定稿结果，不把重新封版规格列为Unit36提交门禁。 |
| 规格 §15 行2 | 适用（冻结前置） | contracts单源与新增字段边界归入 IR36-02、IR36-31。 |
| 规格 §15 行3 | 适用（冻结前置） | authority数据流与现有恢复事实不得被托管入口复制，归入 IR36-18～IR36-19、IR36-31。 |
| 规格 §15 行4 | 适用（冻结前置） | runtime/owner正式端口与唯一组合根归入 IR36-15、IR36-18、IR36-31。 |
| 规格 §15 行5 | 适用（冻结前置） | 角色组合、双拓扑与未启用零装配归入 IR36-15、IR36-27、IR36-35。 |
| 规格 §15 行6 | 适用（冻结前置） | 认证mesh、版本与未授权连接边界归入 IR36-02、IR36-17、IR36-22、IR36-28、IR36-31。 |
| 规格 §15 行7 | 适用（冻结前置） | 配对、信任链、root activation与撤销事实只作plan/启动权威输入，归入 IR36-02、IR36-12、IR36-17、IR36-20、IR36-28。 |
| 规格 §15 行8 | 适用（冻结前置） | SecretStore、ready/degraded与暴露记录的既有合同归入 IR36-06、IR36-17、IR36-25、IR36-28。 |
| 规格 §15 行9 | 适用（冻结前置） | 唯一AuthorityCommitLog/ArtifactStore及投影重放归入 IR36-18～IR36-19、IR36-31。 |
| 规格 §15 行10 | 适用（冻结前置） | 控制请求准入与原结果回放在重启后保持，归入 IR36-18～IR36-19。 |
| 规格 §15 行11 | 适用（冻结前置） | assignment与执行账本身份不因executor重连改变，归入 IR36-18～IR36-19、IR36-22～IR36-23。 |
| 规格 §15 行12 | 适用（冻结前置） | conversation提交、staged发布与最终性恢复归入 IR36-18～IR36-19。 |
| 规格 §15 行13 | 适用（冻结前置） | cancel、重派和uncertain只能由既有状态机收束，归入 IR36-18～IR36-21、IR36-30。 |
| 规格 §15 行14 | 适用（冻结前置） | user/system job耐久协议与queued恢复归入 IR36-18～IR36-19、IR36-22～IR36-23。 |
| 规格 §15 行15A | 适用（冻结前置） | delivery权威流与十五行生命周期归入 IR36-18～IR36-19、IR36-23。 |
| 规格 §15 行15B | 适用（冻结前置） | conversation生产切换、恢复链与唯一生产路径归入 IR36-18～IR36-19、IR36-23、IR36-27、IR36-35。 |
| 规格 §15 行16 | 适用（冻结前置） | manifest/capability/inventory匹配与变化唤醒归入 IR36-02、IR36-22～IR36-23、IR36-27、IR36-31。 |
| 规格 §15 行17 | 适用（冻结前置） | capability/permission激活、吊销与guard归入 IR36-17、IR36-20、IR36-22、IR36-28。 |
| 规格 §15 行18 | 适用（冻结前置） | 唯一资源治理与重启重新准入归入 IR36-10、IR36-22、IR36-29。 |
| 规格 §15 行19 | 适用（冻结前置） | assignment资产传输不因host形态旁路，归入 IR36-22、IR36-28～IR36-29、IR36-31。 |
| 规格 §15 行20 | 适用（冻结前置） | 认证控制面、拨号owner与重连归入 IR36-17、IR36-22、IR36-28、IR36-31。 |
| 规格 §15 行21 | 适用（冻结前置） | stream/spool/cursor在managed重连后不分叉，归入 IR36-22～IR36-23、IR36-26、IR36-31。 |
| 规格 §15 行22 | 适用（冻结前置） | 票据、确认、止损及role关闭边界归入 IR36-20～IR36-23、IR36-28。 |
| 规格 §15 行23 | 适用（冻结前置） | 内容资产与设备容量事实随anchor恢复且不被复制，归入 IR36-10、IR36-18～IR36-19、IR36-22、IR36-29。 |
| 规格 §15 行24 | 适用（冻结前置） | relay、渠道确认和最终性保持原cursor与来源，归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-26。 |
| 规格 §15 行25 | 适用（冻结前置） | environment/workscene仅按原owner恢复，路径不进入托管面，归入 IR36-18～IR36-19、IR36-22、IR36-27、IR36-31。 |
| 规格 §15 行26 | 适用（冻结前置） | scheduler/job产品闭环、队列唤醒与原位置通知归入 IR36-18～IR36-19、IR36-22～IR36-23、IR36-26。 |
| 规格 §15 行27 | 适用（冻结前置） | advancement与取证只由既有owner恢复，归入 IR36-18～IR36-19。 |
| 规格 §15 行28 | 适用（冻结前置） | 编排、memory、技能与生命周期写仍走既有权威落点，归入 IR36-18～IR36-19、IR36-22。 |
| 规格 §15 行29 | 适用（冻结前置） | 入口覆盖lint与模块边界归入 IR36-27、IR36-31、IR36-35。 |
| 规格 §15 行30 | 适用（冻结前置） | 本地域owner与单机/分布式同构归入 IR36-15、IR36-18～IR36-19、IR36-22、IR36-27。 |
| 规格 §15 行31 | 适用（冻结前置） | DeferredGlobalIntent及其pending只由current owner恢复，归入 IR36-18～IR36-19。 |
| 规格 §15 行32 | 适用（冻结前置） | conversation收编后的current-owner与有限consumer恢复归入 IR36-17～IR36-20、IR36-27、IR36-31。 |
| 规格 §15 行33 | 适用（冻结前置） | checkpoint/root/readiness仅作启动输入，归入 IR36-17～IR36-19、IR36-26、IR36-31。 |
| 规格 §15 行34 | 适用（冻结前置） | planned installation/current-owner事实只读恢复，归入 IR36-17～IR36-20、IR36-31。 |
| 规格 §15 行35 | 适用（冻结前置） | disaster installation/installed-generation事实只读恢复，归入 IR36-17～IR36-20、IR36-31。 |
| 规格 §15 行36（Unit36） | 适用（最高直接执行行） | 跨平台安装、重启/崩溃拉起、角色关闭、未启用零进程/监听和单机零概念逐项归入 IR36-03～IR36-35。 |
| 规格 §15 行37～38 | 不适用 | 停机移除卸载和升级发布属于后继单元，归入 IR36-21、IR36-31 的禁止提前装配边界。 |
| 规格 §15 依赖顺序与验证条款 | 适用 | Unit36只能消费已闭环S1～S9；当前提交只要求受影响定向测试与构建，S10仓库级lint/test/build留Unit38，归入 IR36-31、IR36-33～IR36-35。 |
| 开发清单 D36-01 | 适用（直接） | launch plan、严格角色/选择合同及其边界归入 IR36-01～IR36-04、IR36-12～IR36-13、IR36-20、IR36-27、IR36-32～IR36-33。 |
| 开发清单 D36-02 | 适用（直接） | 同SecretStore backend、三平台adapter、service spec、容量与失败终态归入 IR36-05～IR36-11、IR36-17、IR36-28～IR36-29、IR36-33。 |
| 开发清单 D36-03 | 适用（直接） | 六个生产trigger、reconcile single-flight、host-missing与单实例交接归入 IR36-12～IR36-16、IR36-20～IR36-21、IR36-24、IR36-27、IR36-34～IR36-35。 |
| 开发清单 D36-04 | 适用（直接） | 唯一serve组合根、managed ready/rollback与三进程形态归入 IR36-14～IR36-18、IR36-27～IR36-29、IR36-34～IR36-35。 |
| 开发清单 D36-05 | 适用（直接） | anchor自恢复、installed-generation、consumer/pending/outbox闭包归入 IR36-17～IR36-21、IR36-30、IR36-34～IR36-35。 |
| 开发清单 D36-06 | 适用（直接） | executor选择、配对提交、认证重连、队列唤醒与原位置通知归入 IR36-04、IR36-12、IR36-17、IR36-22～IR36-24、IR36-26、IR36-29～IR36-30、IR36-32、IR36-34～IR36-35。 |
| 开发清单 D36-07 | 适用（直接） | current-authority/role/选择变化、安全关闭及Unit37边界归入 IR36-12～IR36-13、IR36-17、IR36-20～IR36-21、IR36-27、IR36-29～IR36-30、IR36-34～IR36-35。 |
| 开发清单 D36-08 | 适用（直接） | 六态公开投影、CLI/server同源、设备名与隐私边界归入 IR36-24～IR36-26、IR36-28、IR36-32、IR36-34。 |
| 开发清单 D36-09 | 适用（直接） | role/profile/trigger/serve exact-set、直接证据及后继负能力归入 IR36-01、IR36-27～IR36-35。 |

### 交付路径反向覆盖

| 分类 | 数量 | 路径 exact-set | 归入审查项 |
| ---- | ---- | ------------- | ---------- |
| CLI入口与选项 | 1 | `packages/cli/src/index.ts` | IR36-04、IR36-15、IR36-17、IR36-24～IR36-25、IR36-32、IR36-34 |
| 本机配置提交 | 1 | `packages/cli/src/runtime/config-command.ts` | IR36-04、IR36-12～IR36-13、IR36-20、IR36-24、IR36-34 |
| host缺失恢复 | 1 | `packages/cli/src/runtime/core-host-connection.ts` | IR36-12～IR36-14、IR36-16、IR36-34 |
| 进程形态测试 | 1 | `packages/cli/src/serve/__tests__/self-exec.test.ts` | IR36-15、IR36-34 |
| CLI状态测试 | 1 | `packages/cli/src/serve/__tests__/status.test.ts` | IR36-25～IR36-26、IR36-34 |
| access surface上下文 | 1 | `packages/cli/src/serve/access-surface.ts` | IR36-17、IR36-25～IR36-27、IR36-34 |
| access surface装配 | 1 | `packages/cli/src/serve/access-surfaces.ts` | IR36-17、IR36-25～IR36-27、IR36-34 |
| scheduler runtime唤醒 | 1 | `packages/cli/src/serve/anchor-scheduler-runtime.ts` | IR36-18～IR36-19、IR36-22～IR36-23、IR36-34 |
| serve生产组合根 | 1 | `packages/cli/src/serve/command.ts` | IR36-15～IR36-23、IR36-25～IR36-30、IR36-34～IR36-35 |
| reconcile直接测试 | 1 | `packages/cli/src/serve/managed-service-reconciler.test.ts` | IR36-12～IR36-13、IR36-30、IR36-34 |
| reconcile生产实现 | 1 | `packages/cli/src/serve/managed-service-reconciler.ts` | IR36-12～IR36-13、IR36-20、IR36-30、IR36-34～IR36-35 |
| trust变化直接测试 | 1 | `packages/cli/src/serve/managed-service-runtime.test.ts` | IR36-17、IR36-20、IR36-30、IR36-34 |
| current state与trust协调 | 1 | `packages/cli/src/serve/managed-service-runtime.ts` | IR36-02、IR36-12、IR36-17、IR36-20、IR36-28、IR36-30、IR36-34～IR36-35 |
| 三平台adapter测试 | 1 | `packages/cli/src/serve/managed-service.test.ts` | IR36-05～IR36-11、IR36-28～IR36-30、IR36-33 |
| 三平台adapter实现 | 1 | `packages/cli/src/serve/managed-service.ts` | IR36-05～IR36-11、IR36-28～IR36-30、IR36-33、IR36-35 |
| 公开状态mapper测试 | 1 | `packages/cli/src/serve/managed-status.test.ts` | IR36-25～IR36-26、IR36-34 |
| managed既有设备key读取 | 1 | `packages/cli/src/serve/mesh-device-key.ts` | IR36-06、IR36-17、IR36-28、IR36-34 |
| pairing选择与reconcile入口 | 1 | `packages/cli/src/serve/mesh-pair-command.ts` | IR36-04、IR36-12、IR36-24、IR36-28、IR36-34～IR36-35 |
| pairing选择测试 | 1 | `packages/cli/src/serve/mesh-pair-selection.test.ts` | IR36-04、IR36-24、IR36-34 |
| mesh runtime装配 | 1 | `packages/cli/src/serve/mesh-runtime-assembly.ts` | IR36-17～IR36-19、IR36-27、IR36-34～IR36-35 |
| managed启动上下文 | 1 | `packages/cli/src/serve/self-exec.ts` | IR36-05、IR36-15、IR36-17、IR36-28、IR36-34 |
| CLI状态生产投影 | 1 | `packages/cli/src/serve/status.ts` | IR36-25～IR36-26、IR36-34 |
| 单实例交接测试 | 1 | `packages/cli/src/serve/topology-command.test.ts` | IR36-14～IR36-16、IR36-30、IR36-34 |
| serve preflight与交接 | 1 | `packages/cli/src/serve/topology-command.ts` | IR36-14～IR36-17、IR36-20、IR36-27、IR36-30、IR36-34～IR36-35 |
| boot config合同 | 1 | `packages/core/src/contracts/identity.ts` | IR36-02、IR36-04、IR36-31、IR36-33 |
| capability唤醒测试 | 1 | `packages/core/src/protocol/manifest.test.ts` | IR36-22～IR36-23、IR36-34 |
| capability目录生产实现 | 1 | `packages/core/src/protocol/manifest.ts` | IR36-22～IR36-23、IR36-34～IR36-35 |
| storage maintenance kind | 1 | `packages/core/src/resources/storage-maintenance.ts` | IR36-10、IR36-29、IR36-33～IR36-35 |
| launch plan测试 | 1 | `packages/mesh/src/__tests__/bootstrap.test.ts` | IR36-02～IR36-03、IR36-12、IR36-20、IR36-27、IR36-33～IR36-35 |
| launch plan生产实现 | 1 | `packages/mesh/src/bootstrap.ts` | IR36-02～IR36-03、IR36-12、IR36-20、IR36-27、IR36-31、IR36-35 |
| scheduler wake测试 | 1 | `packages/owner-kernel/src/__tests__/scheduler-authority.test.ts` | IR36-22～IR36-23、IR36-34 |
| scheduler wake生产实现 | 1 | `packages/owner-kernel/src/scheduler-authority.ts` | IR36-22～IR36-23、IR36-30、IR36-34～IR36-35 |
| SecretStore binding测试 | 1 | `packages/secrets/src/__tests__/vault-secret-store.test.ts` | IR36-06、IR36-33 |
| SecretStore导出 | 1 | `packages/secrets/src/index.ts` | IR36-06、IR36-31 |
| SecretStore binding实现 | 1 | `packages/secrets/src/platform-secret-store.ts` | IR36-06、IR36-17、IR36-28、IR36-31、IR36-33 |
| server状态测试 | 1 | `packages/server/src/__tests__/server.test.ts` | IR36-25～IR36-26、IR36-34 |
| server状态依赖注入 | 1 | `packages/server/src/context.ts` | IR36-25～IR36-26、IR36-31 |
| server公开导出 | 1 | `packages/server/src/index.ts` | IR36-25～IR36-26、IR36-31 |
| server状态mapper | 1 | `packages/server/src/managed-host-status.ts` | IR36-25～IR36-26、IR36-32、IR36-34～IR36-35 |
| server状态路由 | 1 | `packages/server/src/routes.ts` | IR36-25～IR36-26、IR36-31、IR36-34 |
| server状态DTO | 1 | `packages/server/src/types.ts` | IR36-25～IR36-26、IR36-31、IR36-34～IR36-35 |
| S7生产结构门禁 | 1 | `scripts/s7-entry-coverage.mjs` | IR36-12、IR36-15、IR36-27、IR36-31、IR36-35 |
| S7结构门禁测试 | 1 | `scripts/s7-entry-coverage.test.mjs` | IR36-35 |
| 当前单元开发工作台 | 1 | `research/design/workbench/unit-development-workbench.md` | D36-01～D36-09及排除项已逐项进入来源覆盖并归入 IR36-01～IR36-35；不作为运行时行为证据 |
| 上一单元收口记录（明确排除） | 2 | `research/design/workbench/unit-review-ledgers/unit-35.gen-1.md`、`research/design/workbench/unit-review-checklists/distributed-runtime/unit-35.gen-1.md` | 只记录Unit35封版与本工作台归档，不属于Unit36功能、测试或验收义务 |
| 当前独立审查工作台 | 1 | `research/design/workbench/unit-submit-review.md` | 只承载本清单、来源/路径对账与后续审查状态，不建立功能审查项，也不作为功能通过证据 |

### 审查项

| 编号 | 状态 | 审查对象 | 独立通过条件与可复核证据 |
| ---- | ---- | -------- | ------------------------ |
| IR36-01 | [ ] | 单元目标、身份与有限边界 | 逐条对账总纲§10/§14、规格§15行36与D36-01～D36-09：交付仅解决托管服务和角色自恢复，所有必要生产/消费链均有落点；Unit37停机移除、Unit38升级发布、failover/同步/通用框架等排除项在生产构造、命令、wire、状态和测试中均未提前出现。证据为来源条款、D36清单、43条功能路径和S7 forbidden exact-set。 |
| IR36-02 | [ ] | launch plan 权威输入与严格配置合同 | `MeshRoleBootConfig`只新增可选布尔`executorAutoStart`且strict exact keys；trust存在时`enabledRoles`必须是本机active member授权role的完整subset，current issuer、本机device identity和成员唯一。未知字段、inactive/revoked/pending-reenroll、错home/issuer/identity、越权role在OS或role副作用前稳定拒绝，不能裁剪或猜测。证据为core DTO/validator、mesh resolver及相应直接测试。 |
| IR36-03 | [ ] | `managed \| on-demand \| none`判别矩阵 | 固定核对current anchor+anchor、anchor+executor、非current executor、executor+surface、surface-only、空role、无genesis单机及非current仍启用anchor：输出分别符合D36矩阵，完整有效role set不因launch形态改变；选择只控制自动上线，不成为授权或第二事实源。每一分支及错误分支均有可复核单测。 |
| IR36-04 | [ ] | executor自动上线选择与配置提交 | fresh joiner TTY只问一次、非TTY必须显式yes/no、重复配对保留耐久选择、issuer出码不覆盖既有值、joiner bootstrap不会按roles猜测；current anchor+executor不展示不可兑现的关闭选择。选择与`enabledRoles`同次耐久提交，配置变更只在确实改变两字段时触发reconcile；效果/响应丢失和重启重放不分叉。证据为CLI option、pairing两端写序、config editor与参数化测试。 |
| IR36-05 | [ ] | ManagedServiceSpec稳定身份、日志与秘密最小化 | service identity仅由当前OS user+canonical home稳定派生；command/entry/home/userHome为当前安装绝对规范路径，三平台definition与转义确定，参数只进入同一`serve --managed`入口，环境仅含启动和已固定backend所需白名单。supervisor stdout/stderr只进入由该service identity确定、当前用户私有且可创建/read-back的本机日志目标或等价平台日志域；definition/参数/环境/日志不含key、token、恢复材料、workspace/raw device id，必要本机路径不进入公开状态。证据为spec builder、三平台golden、日志目标/权限、空格/引号/异home测试和秘密扫描。 |
| IR36-06 | [ ] | SecretStore backend binding与managed上下文 | foreground首次创建沿用私有原子写/初始化锁并耐久固定无秘密backend binding；既有store仅在成功解锁且vault/key事实唯一时一次回填，歧义/坏binding/managed首次打开/当前上下文不可解锁均fail-closed且不生成或覆盖key。Linux桌面binding在无DISPLAY/WAYLAND的managed会话中不得漂移到machine-bound；无头boot只允许可回读machine-bound。证据为platform store生产实现及binding、迁移、重开、歧义、临时文件测试。 |
| IR36-07 | [ ] | Windows托管适配器 | 定义使用当前用户LogonTrigger、最小权限、IgnoreNew与失败重启；`inspect/install/disable/start`通过schtasks稳定read-back state/running/matches，同规格幂等、异安装definition drift拒绝、登录前不声称ready。命令/路径转义及部分效果、权限失败、取消、超时均有确定终态且不退化为detached进程。证据为Windows definition golden、可控adapter命令序列与故障测试。 |
| IR36-08 | [ ] | macOS托管适配器 | 仅当前用户LaunchAgent，ProgramArguments/EnvironmentVariables canonical，`RunAtLoad/KeepAlive`且gui uid域正确；bootstrap/enable/kickstart/disable与print/read-back的效果前后失败、重复安装和取消只收敛同一service identity，不创建第二host。证据为plist golden、命令序列/read-back与异常测试。 |
| IR36-09 | [ ] | Linux桌面与无头托管适配器 | 桌面只用systemd user登录启动；无头仅在machine-bound SecretStore可回读时启用同用户linger实现boot。unit definition canonical且secret-free，daemon-reload/enable/start/disable/read-back幂等；无会话、无权限、坏定义、取消/超时不改backend、不伪ready。证据为两种Linux definition、backend场景和adapter故障测试。 |
| IR36-10 | [ ] | 服务定义物理写入与容量准入 | 只有当前spec首次发布所需的definition物理写链进入既有`managed-service-reconcile` maintenance kind：临时文件私有写→fsync→对目标名原子rename→目录fsync，permit覆盖有限物理步骤并立即释放；同规格已发布时零重写。这里的“替换”仅指临时文件的原子发布，不允许覆盖definition drift或其他安装版本，后者必须按IR36-11拒绝并留Unit38。OS manager命令、等待、重试及authority/store/lifecycle锁外零permit；容量不足、磁盘满、取消、写序崩溃、临时残留、同键并发和重启均零半定义/越home副作用并可重驱。证据为storage kind/budget、adapter写链及可控governor场景。 |
| IR36-11 | [ ] | 适配器错误、read-back与幂等终态 | `absent/disabled/enabled`×running×matches有限状态均可独立判定；unsupported、definition drift、permission、command timeout/failure、read-back不全和AbortSignal稳定分类。效果前失败可重试，效果后响应丢失以inspect/read-back吸收，同规格exact replay，冲突定义不自动替换（留Unit38），无无界等待或静默降级。 |
| IR36-12 | [ ] | reconcile生产触发exact-set | 唯一descriptor与生产调用图全等包含issuer/joiner配对完成、本机role/选择配置提交、已验证trust/current-authority应用、managed preflight、CoreHostConnection host-missing；中间配对态、纯读status/health和普通可选binding变化不得写OS。每个触发都只调用会自行重读当前事实的reconciler，调用方不能传预计算plan。证据为descriptor、各生产入口、S7与mutation gate。 |
| IR36-13 | [ ] | reconcile状态机、single-flight与计划复验 | 同home/serviceId并发合并，异home隔离；managed走inspect→必要install/enable→重读plan/spec→start，on-demand/none只disable已有自动拉起；健康同规格不反复写OS。start前plan/spec变化会disable旧定义，安全型plan错误也先disable已匹配定义再fail-closed；效果/响应丢失和连续重启唯一收敛且无第二runtime。证据为reconciler实现和并发、plan变化、同/异home、漂移、重启测试。 |
| IR36-14 | [ ] | host-missing三分支消费 | CoreHostConnection发现host缺失时：managed只修复注册/启动并等待同一host，on-demand才复用既有`spawnDaemon`，none不创建本机host且仅保留该surface合法远端入口。reconcile错误提供稳定可行动失败，不能因managed未立即ready而再拉一套daemon。证据为default deps、discover/retry行为和三分支直接测试。 |
| IR36-15 | [ ] | foreground/on-demand/managed唯一serve组合根 | 三种进程形态最终只进入`runServeCommand`、`MeshRuntimeBootstrap`、`planServeTopology`和同一role assembly；managed/on-demand只改变stdio/log/state/idle形态，不复制server、executor、router或authority。managed不装idle reaper，current anchor+executor在一个host装完整roles；依赖方向与单机同进程路径保持不变。 |
| IR36-16 | [ ] | 单实例owner与existing host交接 | PID marker、health、port和workspace owner仍是唯一竞争事实：已有健康同home foreground/on-demand host时managed child只做零role副作用waiter；退出后必须重读plan/spec/PID再竞争同一composition root。等待中plan变化会reconcile并退出，stale marker只允许一个winner；异home互不阻塞，未ready host不得被第二设施替代。证据为preflight/wait实现、真实子进程和竞争场景。 |
| IR36-17 | [ ] | managed启动ready门禁与逆序rollback | managed强制非交互、零配置向导/秘密/路径/监听横幅；依次完成config、同backend SecretStore解锁、trust/current-authority/role、planned/disaster completion、capacity、executor owner、transport与role facilities后才出现readiness marker/公开listener。plan变none先disable再退出；错误role/config/key/trust/root/member/owner/port/facility均走existing reverse rollback，零残留listener/secret/published state；可选外部binding只按既有degraded语义。 |
| IR36-18 | [ ] | anchor崩溃、登录/开机与连续重启恢复 | 两个current-anchor profile每次托管拉起只从真实AuthorityCommitLog、trust/current installation、AuthorityCatalog和consumer receipt恢复；planned/disaster installed-generation先重绑runtime epoch/projection/cursor，旧issuer/epoch不可重新服务。OS supervisor只做有界重启，不写第二journal、不把反复fail-closed冒充ready。证据覆盖空/非空authority、首次/再次换代、端口与SecretStore暂不可用及连续拉起。 |
| IR36-19 | [ ] | authority consumer、pending与outbox完整闭包 | 公开准入前，scheduler、conversation、interaction、confirmation、final、delivery三组consumer和六类pending obligation按现有receipt逐项恢复；原request/task/effect/cursor/outbox identity保持，效果前后崩溃与响应丢失exact replay。conversation/job/system-job、delivery15行和各流终态均不得因进程形态丢失、重复或重判；read-back未齐时gate保持关闭。 |
| IR36-20 | [ ] | trust/current-authority/role/选择变化安全协调 | verified watcher应用后先即时关闭失效current-owner/role新准入与listener，再disable OS未来拉起并read-back，最后请求当前managed host走既有安全关闭；managed仍成立（如current anchor+executor只关executor选择）不得停host或裁roles。managed→on-demand/none、revoke/pending-reenroll/旧anchor与安全型plan错误在在线、离线、并发、崩溃和disable响应丢失下收敛到零失效准入/监听/managed host。 |
| IR36-21 | [ ] | 当前安全关闭与Unit37边界 | Unit36只复用现有本机认证shutdown和blocker安全点：blocker未收束时保持gate关闭并公开“正在结束当前工作”，禁止force kill、身份/authority/cache删除、权威转移、永久卸载或三路径协议。进程已退出、disable失败与supervisor重启竞态不误报完成；所有Unit37符号/命令/持久状态在生产exact-set为零。 |
| IR36-22 | [ ] | executor上线、认证重连与capability/inventory | 选择managed的非current executor（含surface）只在SecretStore、认证control connection、reconnect owner、workspace owner和role设施ready后发布online；`ExecutorCapabilityDirectory.accept`先耐久接受再异步通知，scheduler订阅只唤醒既有queued user jobs并在stop释放。选择关闭/role撤销/纯on-demand/anchor不可达/owner busy/网络挂起/capability漂移保持queued/retryable且零伪online。 |
| IR36-23 | [ ] | 排队任务续驱、唯一认领与原位置通知 | capability/inventory ready transition只触发有界合并wake；tick运行中再唤醒不会丢失也不并发重入。每个queued job保留原task/jobRun/attempt/assignment与guard，完成/失败只通过原`turnOrigin`幂等投递一次，禁止跨渠道广播；重连、重复snapshot、响应丢失和anchor/executor连续重启零重复认领/终态。 |
| IR36-24 | [ ] | 配对后自动上线完整用户链 | issuer/joiner都必须在完整bootstrap成功后触发reconcile，中间态零注册；executor/executor+surface选择开关、首次/重复配对、登录/开机、断网重连、inventory变化、完成/失败和anchor+executor强制完整装配形成有限场景矩阵。所有提示只表达“开机后自动上线并继续任务”，不把选择误作授权或要求用户理解服务/role。 |
| IR36-25 | [ ] | 托管公开状态有限联合 | `desired×service×process×readiness×errorCode`只映射为“不需要后台运行/等待开机上线/正在启动/可以使用/正在结束/需要处理”六态，以及`login-required`、`credentials-locked`、`pairing-required`、`permission-required`、`configuration-invalid`五个有限动作；failed不能被running-unhealthy遮蔽，managed未注册、on-demand停止、none、stale、recovering/degraded/stopping均有唯一结果。投影无I/O、无副作用、exact keys并可独立表驱动验证。 |
| IR36-26 | [ ] | CLI/server同源状态与隐私边界 | CLI human与server `/api/status`共用同一mapper；公开DTO不得含PID、port、host、service/task/unit、home/exec/log/workspace路径、device id、roles、epoch、backend、raw OS error/cause。唯一设备名可展示，重名沿既有选择不泄漏raw id；可选target/binding离线不误报host失败，坏config/locked credentials/permission给有限可行动提示。 |
| IR36-27 | [ ] | role/profile/topology生产exact-set | 两个current-anchor profile各最多一个home managed host；executor-only与executor+surface按选择managed/on-demand；anchor+executor同host；surface-only/empty为none且零本机role module/process/listener；无genesis单机on-demand。未启用GlobalState/delivery/mesh listener不被import/construct，生产descriptor、role topology和S7双向全等。 |
| IR36-28 | [ ] | 安全、最小权限与数据隔离 | OS服务绑定当前user/home/backend和当前安装入口，定义文件权限私有；managed隐藏参数必须成对且backend枚举严格。SecretStore值、device key、token、恢复材料、外部凭据、workspace/raw identity不进argv/env/definition/log/status/wire；trust/capability/authority guard在managed入口前置，未知平台/字段/role/identity fail-closed，无新依赖或权限扩大。 |
| IR36-29 | [ ] | 资源、取消、锁序与stop | service definition写、bootstrap/storage恢复和executor工作继续复用设备唯一arbiter/governor；每个有界步骤持对应permit，OS/网络等待及authority/store/lifecycle锁外零permit。AbortSignal贯穿adapter/reconcile/command并有界终止；stop拒新申请、在途到安全点、重启重新准入，容量gap/backpressure/磁盘满不产生半效果且自动类不饿死交互类。 |
| IR36-30 | [ ] | 六类固定故障矩阵的共同终态 | 仅对六类当前新增或被改写的边界——adapter `install/start/disable`、reconcile、managed/on-demand/foreground宿主交接、trust驱动关闭、capability wake、anchor consumer恢复——分别判定效果前失败、效果后响应丢失、取消/进程崩溃、连续重启四个固定切点。每格必须给出稳定identity、可重驱事实、零副作用边界与唯一终态；同载荷exact replay、异载荷冲突拒绝，重试只由已有reconciler/consumer或OS supervisor拥有且无busy spin/无限等待。已在IR36-07～IR36-23证明的局部事实可作为本矩阵证据，不重复扩展场景。 |
| IR36-31 | [ ] | 分层、兼容、上游复用与后继隔离 | 变更只在core合同/容量、mesh plan、secrets backend、CLI组合与server投影分层落位；不改变既有wire/schema/trust/transfer/recovery/authority语义，不新增package/lockfile/第三方依赖或反向import。Unit33～35事实只读复用；Unit37删除卸载、Unit38升级回滚、failover/同步/通用lifecycle/registry生产符号与状态为零。 |
| IR36-32 | [ ] | 产品旅程与最小完整价值 | 单机`zz`仍即用、无genesis不后台化；扩展设备用同一包/同一pairing流选择是否自动上线；日常状态和排队/上线/完成提示零拓扑术语且行动明确；current anchor重启无需人工`serve`。必须证明范围收敛未牺牲上述体验，也没有用监控、诊断或未来能力抬高提交门禁。 |
| IR36-33 | [ ] | launch plan、SecretStore与三平台adapter直接证据 | 有限直接测试必须覆盖D36-01/02要求的角色真值表、错误identity/role、backend首次/回填/歧义/managed重开、Windows/macOS/Linux desktop/headless definition、路径转义、同异home、install/disable/start/read-back、写序/容量/取消/超时/权限/未知平台和秘密零落盘；缺失的必要场景形成实现/测试缺口，重复矩阵不要求新runner。 |
| IR36-34 | [ ] | reconcile、serve、anchor/executor与状态场景证据 | 直接合同/场景测试有限覆盖六个生产trigger、三plan分支、双/异home并发、host竞争与plan变化、managed ready前失败/rollback、anchor两profile/pending/outbox恢复、executor pairing选择/重连/queue wake/turnOrigin、角色关闭和CLI/server状态exact keys；真实子进程证据只用于单实例/health/崩溃拉起的不可替代边界。 |
| IR36-35 | [ ] | S7 descriptor、registry与负能力机械门禁 | 现有S7冻结owner、plan modes、六trigger、profiles、唯一composition委托、同SecretStore、status mapper、queue wake与43条功能路径的生产装配；mutation能拒绝漏trigger、第二runtime、surface常驻、secret泄漏、downstream shutdown/upgrade/failover/sync符号。canonical registry/golden保持既有入口exact-set，不新建lint/test runner；所需类型、直接场景和派生资产证据只按IR36-33～IR36-35的稳定通过条件记录，当次命令、构建结果、工作区状态与流程对账不另立审查项。 |

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
