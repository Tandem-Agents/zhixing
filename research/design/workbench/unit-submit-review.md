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
目标：只收敛第 37 单元正式问题列表中同根重开的 U37-01 一个 P0/中，使其真正命中stop successor恢复的进程单飞线性化晚于owner效果、closed admission与exact执行owner混淆的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U37-02～U37-11与第30～36单元既有结论直接复用，U37-01已验证的耐久phase执行恢复、delivery admission/sealed、七类source exact revision、local/relay namespace、migration共同闭包、三策略owner安全点及exact-host stop不得恢复或扩面；价值裁决否定的耐久successor claim、第二journal、独立恢复计划、通用server lifecycle/coordinator、泛化S7、新runner及第38单元能力不得并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 37 单元正式文件中的 U37-01，只依据该问题最新的事实、价值裁决、最优方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 从权威架构、规格和当前生产调用图重建 U37-01 事实链，核准stop operation/artifact/strategy/phase、anchor/executor两根startup装配、local readiness/lifecycle projection、mesh/worker恢复、`resumeActive()`、`isHostStopped()`与`runServer()` OS端口owner的唯一事实源、稳定identity、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断当前描述命中跨进程执行owner根因还是局部启动顺序表象。同根内容必须合并，历史修复与价值裁决未被新生产事实触发时不得恢复旧评级、旧方案或扩面。
2. 穷尽直接变体：覆盖anchor/executor、managed/on-demand/foreground、三策略、`accepted/gate-closed/work-settled/flushed/ready-to-stop`、十owner空/非空、单/双successor、端口取得/竞争失败、owner取得后崩溃与接替、old/current PID、generic close、各sync/响应窗口和连续重启。每格必须指出operation/endpoint/进程owner稳定identity、唯一耐久事实、OS单飞线性化点、owner前零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：只复用既有真实server端口owner，把启动窄分为“scan+closed hydrate→inactive-ingress bind→旧host proof与原phase补步→terminal/exact release→激活既有router/ingress”；竞争失败者在任何owner/journal/manager效果前退出，current-successor判断反绑同一exact endpoint，owner崩溃后由OS释放且后继重读原耐久phase。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增耐久claim、第二journal/事实源、独立恢复计划、通用server lifecycle/coordinator、修改已验证delivery/source合同、S7 registry、新runner、监控、诊断、benchmark或信息采集。发现缺口时直接修正U37-01，使执行者无需实现猜测即可一次完成。
4. 问题看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：OS端口owner与首个owner效果排序、五phase/三策略/十owner的双successor隔离、owner崩溃接替与inactive-ingress边界、生产体验/范围价值及历史裁决边界。各路必须抛开前轮结论，从当前合同和源码主动构造第2步反例，并核查U37-01与U37-02～U37-11、第30～36单元既有合同及第38单元边界的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U37-01的全部双successor、五phase、三策略/三形态、十owner、端口竞争、old/current host、owner崩溃接替与连续重启变体均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会恢复耐久claim或已验证delivery/source边界，也不会因逐phase、逐入口或逐owner补丁继续返工。满足后明确回复“U37-01 的根因与最优方案已闭合”并立即停止。

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
这一批问题修复工作结束后，先读取“独立审查清单”的状态约定，再按本轮变更文件及其生产者、消费者、公共合同和直接测试的实际影响范围更新状态。
凡受影响的 `[!]`、`[x]` 节点一律改为 `[~]` 并清除或明确作废旧证据；未受影响的 `[x]` 保持不变。修复验证通过、正式问题更新为“已验证”、专项功能审查或多角色对抗通过，均不得直接把独立审查节点改为 `[x]`；只有随后单独执行独立审查，才能把 `[~]` 更新为 `[x]` 或 `[!]`。
本轮修改了生产文件却没有任何受影响节点变为 `[~]` 时，必须停止并报告状态映射错误，不得结束任务。
```

### 2.9 目标模式：解决问题并完成多角色对抗收口

```text
目标：彻底解决第 37 单元正式问题列表中同根重开的 U37-01 一个 P0/中，闭合 stop successor 恢复的进程单飞线性化晚于 owner 效果、closed admission 与 exact 执行 owner 混淆的全部同根直接变体；不得扩展到其他问题或全单元流程。U37-02～U37-11 与第30～36单元既有结论直接复用，U37-01已验证的耐久phase执行恢复、delivery admission/sealed、七类source exact revision、local/relay namespace、migration共同闭包、三策略owner安全点及exact-host stop不得恢复或扩面；价值裁决否定的耐久successor claim、第二journal、独立恢复计划、通用server lifecycle/coordinator、泛化S7、新runner及第38单元能力不得实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第37单元正式文件中的U37-01，只依据该问题最新的根因、价值裁决、F37-64～F37-71固定矩阵、C37-C25反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建F37-64～F37-71固定矩阵。覆盖anchor/executor，managed/on-demand/foreground，三策略，`accepted/gate-closed/work-settled/flushed/ready-to-stop`，十owner空/非空，单/双successor，端口取得/竞争失败，owner取得后各phase效果/响应丢失、崩溃接替，old/current PID、generic close与连续重启。逐格绑定operation/artifact/phase、resolved non-zero home endpoint、bound server handle与host generation，唯一耐久事实、OS线性化点、owner前零副作用边界和直接证据，并持续核对其余U37、第30～36与第38单元边界。
2. 只复用既有真实server端口owner完成窄两段启动。anchor在`setupAssemblyUnits()`前、executor在MCP/authority/workspace/data-plane/job/local owner启动前，先扫描active stop（存在时strict hydrate原operation/artifact/phase并形成closed投影），随后无论扫描有无active operation，所有production启动都必须让server包以最终同home非零`host+port`创建并listen同一种inactive server对象；否则terminal后、activate前到达且扫描为无active的进程仍会绕过早期单飞。HTTP稳定拒绝、WebSocket upgrade不进入router，PID/state/ready不得发布。`EADDRINUSE`失败者立即按原回滚退出，任何owner恢复、journal advance或manager效果计数必须为零。

   只有持有该exact bound handle的winner可装配closed owners；`recoverAcceptedWork=false`必须真正覆盖local readiness/lifecycle projection及mesh/worker恢复，使closed assembly保持零owner效果。随后`resumeActive()`先完成旧host proof，成功后才触发首个恢复效果并按原phase补步；current-successor判断同时反绑handle、current endpoint lock、旧endpoint、definition及manager投影。`accepted`只补gate/freeze，`gate-closed`只按原artifact/strategy settle，`work-settled`只flush，`flushed`只physical，`ready-to-stop`只terminal；terminal与同operation exact release后，`runServer()`必须消费同一handle并在原对象上激活既有REST/RPC/bridge，再写发现/ready投影，禁止第二次listen、close/rebind。异常回滚关闭同一handle；进程崩溃由OS释放，后继重读原耐久phase再竞争。同步直接相关架构、规格与直接测试；端口0的一次性server测试不得充当lifecycle owner证据。禁止新增耐久claim、第二journal/锁、独立恢复计划、通用server lifecycle/coordinator，禁止修改已验证delivery/source/三策略/exact-stop合同或增加S7 registry、新runner、监控、诊断、benchmark、信息采集。
3. 按验证手册运行受影响闭包的最小必要类型检查、server inactive-bind/同对象activate、anchor/executor真实双进程端口竞争、逐phase successor恢复与十owner零二次效果直接合同和场景测试，核对必要派生资产；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须让两个child process穿过两条production composition root并争用同一非零home endpoint，直接注入五phase、三策略、十owner、旧host live/dead/PID复用、manager不可判定、bind后崩溃、各sync/响应丢失、inactive HTTP/WS与连续接替；不得以mock自报owner/settled/stopped或两个`port=0`实例代替，不得运行包全测、模块回归、配置×故障笛卡尔积或无关验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读逐格重建U37-01事实链；测试通过不得代替功能判断，F37-64～F37-71全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：OS端口owner与首个owner效果排序、五phase/三策略/十owner双successor隔离、owner崩溃接替与inactive-ingress边界、生产体验/范围价值及历史裁决边界。各角色须抛开既有结论，主动重造第1步全部适用反例，并核查U37-01与U37-02～U37-11、第30～36单元既有合同及第38单元边界的直接交界。
5. 新发现首次出现即以C37-C26起的稳定编号写入正式问题证据与反证账；收口前对C37-C25、历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正U37-01的根因、方案、验收和矩阵，再回到第2步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的U37-01方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C37-C25及新增同根反证全部有耐久处置，证明anchor/executor在五phase、三策略/三形态、十owner、双successor、old/current host、端口竞争、owner崩溃接替、generic close、效果/响应丢失与连续重启下，失败者owner/journal/manager效果恒零，任一时刻仅exact bound handle持有者前滚原operation，inactive ingress零分派，`work-settled+`零二次效果，terminal/exact release后同一server对象才激活；失主后后继只重读原phase且不需要耐久claim。U37-02～U37-11与第30～36单元结论不变，第38单元能力未提前实施，U37-01已更新为“已验证”。满足后明确报告“U37-01 问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，执行“修复后更新独立审查清单状态”：凡受本轮生产实现、公共合同或直接测试变更影响的 `[!]`、`[x]` 节点一律改为 `[~]` 并作废旧证据，未受影响的 `[x]` 保持不变；修复验证、问题“已验证”、专项功能审查或多角色对抗通过均不得直接产生 `[x]`。若本轮修改了生产文件却没有任何受影响节点变为 `[~]`，立即停止并报告状态映射错误。
```

## 审查清单

### 当前状态

- **当前单元**：第 37 单元 · generation 1
- **单元身份**：S10 三路径停机、设备移除与值班设备永久卸载；只交付临时停机、executor 移除、current anchor 安全永久卸载三条互斥且可重放的生命周期路径。
- **权威来源**：always-online-and-local-execution-requirements.md、distributed-runtime-charter.md、specification.md、s2-security-supply-chain-review.md，已定稿 D37-01～D37-09，以及第 30～36 单元已封版的 AuthorityTransfer、current-owner/trust、checkpoint、SecretStore、accepted-work、资源治理、managed supervisor 与 exact endpoint 合同。
- **交付基线**：当前工作树中的 Unit37 完整生产实现、直接测试、字段级规格回填、S7 descriptor 与 registry golden；历史问题、开发过程和既有通过记录不得替代本轮独立判断。
- **生产装配关系**：同一 device-lifecycle 判别协议写入承担路径的既有物理 AuthorityCommitLog；server.shutdown 经本机 lifecycle adapter 进入 HostStopCoordinator，device.list/remove/status/continue 经 current-anchor 管理面进入 current issuer 与 target 两根 removal runtime，server.uninstall.* 固定 loopback 进入 AnchorUninstallCoordinator。普通启动在公开准入前读取 authority/executor 两根 lifecycle journal，恢复未终态 gate，并拒绝 removed/retired 身份复活；cleanup 复用 existing storage governor、managed-service exact unregister、SecretStore exact delete 与既有安全停机链。
- **目标提交边界**：strict lifecycle DTO/codec/reducer/journal；stop 三策略及 exact host generation；executor 本地域 authority transfer 或显式销毁、accepted-work 收束、撤销/暴露/清退；失控设备诚实远端撤销；anchor migration 或双次真实 recovery checkpoint 安全卸载；启动恢复、产品入口、隐私文案、S7/registry 与直接证据。
- **明确排除**：Unit38 升级、schema/protocol 兼容门、包下载/替换、健康门禁、自动回滚、发布矩阵、支持包与仓库级最终 CI；自动 failover、quorum/witness、多 active anchor、全局/持续同步、灾难恢复应用、远程擦除、外部安装器删除 executable/package、通用 lifecycle/迁移/存储/事务/事件总线/registry、新 runner、监控、诊断、benchmark 或信息采集。
- **架构空洞判定**：总纲 §10～§15、规格 §1～§12 与 §15 第 37 行/字段级协议、D37-01～D37-09 已唯一确定产品行为、稳定身份、阶段顺序、取消边界、恢复终态、体验和后继隔离；无须以实现假设补齐且会改变产品结果的真实架构空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1；[~] 输入变化须重审。

> **清单状态**：0 项 `[ ]`、40 项 `[x]`、0 项 `[!]`、0 项 `[~]`；12个生产实现受影响节点已完成独立重审及反向价值裁决，封版时又对shutdown直接测试合同影响的IR37-33/IR37-36/IR37-37/IR37-40独立复审。上一轮把内部`ServeOptions.host/port`测试接缝误当作用户可达配置；真实产品入口只传`managed`，两根均使用固定loopback host与按home确定的非零端口，故P37-21已删除且不构成当前阻断。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| --- | --- | --- |
| requirements §一 | 适用 | 持续在线与真实本机执行归入 IR37-01、IR37-07～IR37-12、IR37-13～IR37-34。 |
| requirements §二 | 不适用 | 外部产品回复整理不产生知行字段、状态或门禁。 |
| requirements §三 | 不适用 | 外部事实核验不替代当前生命周期合同。 |
| requirements §四 | 不适用 | 架构审核过程的最终裁决已进入总纲与规格。 |
| requirements §五 | 不适用 | 外部现状归纳不形成当前实现义务。 |
| requirements §六 | 适用 | 单机/多设备平权、真实环境留在设备、隐藏拓扑归入 IR37-01、IR37-13、IR37-26～IR37-34。 |
| requirements §七 | 适用 | 最小完整产品、单机零额外代价、后台停止真实性归入IR37-01、IR37-07～IR37-12、IR37-35、IR37-39。 |
| requirements §八 | 适用（前置） | planned migration readiness、唯一设备名、取消/只前滚和零术语归入 IR37-27～IR37-34。 |
| charter 当前版本交付原则 | 适用 | 最小完整范围、架构优先和禁止预建归入 IR37-01、IR37-36～IR37-40。 |
| charter 一 | 适用 | 单一产品、单机/分布式平权与current anchor归入IR37-01、IR37-33～IR37-35。 |
| charter 二 | 适用 | 持久在线、完整本机执行与拓扑隐藏需求归入IR37-07～IR37-12、IR37-13～IR37-34。 |
| charter 三 | 适用 | 角色、owner、包依赖、协议与产品基线由§1～§15逐节判定如下。 |
| charter §1 | 适用 | 唯一 current anchor、同一 owner/端口归入 IR37-01、IR37-03～IR37-05、IR37-34。 |
| charter §2 | 适用 | anchor/executor/surface 角色与 lifecycle 主体归入 IR37-03、IR37-13、IR37-25～IR37-34。 |
| charter §3 | 适用 | core/server/CLI 单向依赖与无第二组合根归入 IR37-02、IR37-05、IR37-35、IR37-39～IR37-40。 |
| charter §4 | 适用 | 认证身份、issuer、revoke、pairwise secret、失控边界归入 IR37-13、IR37-19～IR37-26、IR37-37。 |
| charter §5 | 适用 | 本地域/锚点域 owner 与六类 authority 处置归入 IR37-15～IR37-22、IR37-28～IR37-31。 |
| charter §6 | 适用 | accepted work、assignment/lease/outbox 收束归入 IR37-09～IR37-10、IR37-20、IR37-36。 |
| charter §7 | 适用 | 本机环境 authority、清退与路由阻断归入 IR37-16～IR37-25。 |
| charter §8 | 适用 | final/delivery/outbox 最终性与断线重放归入 IR37-09～IR37-10、IR37-20～IR37-23、IR37-36。 |
| charter §9 | 适用 | 本地域 conversation exact-set transfer/delete 归入 IR37-15～IR37-19。 |
| charter §10 | 适用（核心） | 三条 lifecycle 路径、撤销/暴露、SecretStore 与服务清退全部规范性条款归入 F37-01～F37-08、IR37-02～IR37-34。 |
| charter §11 | 适用 | 零术语、唯一设备名、可行动状态与诚实告知归入 IR37-13、IR37-26～IR37-34。 |
| charter §12 | 适用 | AuthorityTransfer中断、设备撤销、磁盘满、响应丢失、旧owner/endpoint与重启的适用行归入F37-06、IR37-12、IR37-19、IR37-23、IR37-26、IR37-31、IR37-36；其他前置故障行只作IR37-39兼容。 |
| charter §12.1 | 适用 | 真解封、完整 checkpoint、独立目标、final checkpoint 归入 IR37-27、IR37-29～IR37-31。 |
| charter §13 | 适用 | 唯一权威、terminal、秘密、资源和准入不变量归入 IR37-02～IR37-06、IR37-35～IR37-40。 |
| charter §14 | 适用 | 36～38 顺序与不得提前发布升级归入 IR37-01、IR37-39。 |
| charter §15 | 适用 | 三路径验收、结构不变量和有限故障证据归入 F37-01～F37-08、IR37-35～IR37-40；性能观测不作门禁。 |
| specification §1.1 | 适用 | operation/request/home/device/epoch、时间与重放身份归入IR37-02～IR37-04、IR37-36。 |
| specification §1.2 | 适用 | canonical bytes、digest、签名域与引用绑定归入IR37-02、IR37-06、IR37-21、IR37-37。 |
| specification §1.3、§1.3b | 适用（兼容） | 所有外部符号仍来自权威包，新增lifecycle符号只有一个正式导出，归入IR37-02、IR37-39。 |
| specification §1.4 | 适用（兼容） | 总纲构件名与代码落点必须一一对应，归入IR37-01、IR37-35、IR37-39。 |
| specification §1.5 | 适用 | stable code/action、无raw error与公开错误形态归入IR37-12、IR37-33～IR37-34。 |
| specification §2.1 | 适用 | current issuer、trust ancestor/member generation、revoke与后继身份归入IR37-14、IR37-19～IR37-23、IR37-26～IR37-28、IR37-30、IR37-32、IR37-37。 |
| specification §2.2 | 适用（收束） | capability/lease/票据的现有激活与撤销合同归入IR37-08～IR37-10、IR37-20、IR37-22、IR37-37～IR37-38。 |
| specification §2.3 | 适用 | SecretStore existing-only、exact delete与秘密不迁移归入IR37-24～IR37-25、IR37-31～IR37-32、IR37-37。 |
| specification §2.4 | 适用（核心） | active exposure→compromised、外部账号行动与atomic publication归入IR37-21、IR37-26、IR37-30～IR37-31。 |
| specification §2.5 | 适用 | 认证mesh、current-owner与有限target/issuer服务归入IR37-14～IR37-15、IR37-20、IR37-22～IR37-23、IR37-33、IR37-35、IR37-37。 |
| specification §3.1 | 适用 | conversation owner/freeze/delete/transfer归入IR37-08～IR37-10、IR37-16～IR37-19。 |
| specification §3.2 | 适用（边界） | global authority只由current anchor处置，归入IR37-21、IR37-28～IR37-31、IR37-35。 |
| specification §3.2b | 适用 | DeferredGlobalIntent随本地conversation冻结、转移或删除，归入IR37-09、IR37-16～IR37-18。 |
| specification §3.3 | 适用 | 环境事实只在本地清退且永不转移/备份，归入IR37-24、IR37-29～IR37-31、IR37-37。 |
| specification §3.4 | 适用 | lease/permit收束与停止准入归入IR37-09～IR37-10、IR37-20、IR37-38。 |
| specification §3.4b | 适用 | storage governor/arbiter的cleanup与stop边界归入IR37-06、IR37-10、IR37-24、IR37-38。 |
| specification §3.5 | 适用（收束） | completion/reviewer既有accepted work归入IR37-09、IR37-20、IR37-36。 |
| specification §3.6 | 适用（收束） | executor在途工作与安全停止归入IR37-09～IR37-11、IR37-20、IR37-36。 |
| specification §3.7 | 适用（收束） | submission/usage/final的accepted终态归入IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §3.8 | 适用 | host/current-anchor/surface principal 与逐方法 guard 归入 IR37-07、IR37-13、IR37-27、IR37-33、IR37-37。 |
| specification §4.1 | 适用（核心） | 唯一 AuthorityCommitLog、stream transaction/replay 归入 IR37-03～IR37-05、IR37-21、IR37-30。 |
| specification §4.2 | 适用 | ArtifactStore 与 evidence roots 归入 IR37-06、IR37-16～IR37-18、IR37-29～IR37-31。 |
| specification §4.3 | 适用 | session/assignment/intent/final/outbox/exposure/trust/checkpoint 流归入 IR37-09～IR37-10、IR37-15～IR37-24、IR37-29～IR37-31。 |
| specification §4.4 | 适用 | revoke+exposure+lifecycle 与 retirement 原子 envelope 归入 IR37-05、IR37-21、IR37-30。 |
| specification §4.5 | 适用 | lifecycle ArtifactRef retention/GC 归入 IR37-06、IR37-24、IR37-31。 |
| specification §5.1 | 适用 | shutdown/device/uninstall控制请求的认证、幂等与错误形态归入IR37-07、IR37-13～IR37-15、IR37-27、IR37-33。 |
| specification §5.2 | 适用（收束） | fresh dispatch关闭与既有assignment收束归入IR37-08～IR37-10、IR37-14、IR37-22、IR37-36。 |
| specification §5.3 | 适用（收束） | capability/version匹配、撤销与旧peer拒绝归入IR37-22、IR37-37、IR37-39。 |
| specification §5.4 | 适用（核心） | transfer/delete/revoke/retirement/checkpoint提交的CAS与原子性归入IR37-17～IR37-21、IR37-28～IR37-31、IR37-36。 |
| specification §5.5 | 适用（收束） | final/outbox/terminal重放归入IR37-09～IR37-10、IR37-20～IR37-23、IR37-36。 |
| specification §5.6 | 适用（收束） | run stream的accepted work安全点归入IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §5.7 | 适用 | cancel、abort、设备失控与止损归入IR37-19～IR37-26、IR37-37。 |
| specification §6.1、§6.2、§6.2b | 适用（收束） | conversation/job/system accepted-work 停止与取消归入 IR37-09～IR37-10、IR37-20、IR37-36。 |
| specification §6.3 | 适用（核心） | AuthorityTransfer freeze/import/commit/abort/terminal 归入 IR37-15、IR37-17、IR37-19、IR37-28。 |
| specification §6.4 | 适用（核心） | device active/revoked、uncertain、terminal replay 归入 IR37-19～IR37-26。 |
| specification §7 | 适用（核心） | 六类 authority 的 transfer/delete/preserve/backup 六个枚举行逐项归入 F37-04～F37-05、IR37-16～IR37-18、IR37-28～IR37-31。 |
| specification §8 | 适用 | device 四入口、shutdown、uninstall 五入口及 target/issuer 两服务的唯一落点归入 F37-02、IR37-07、IR37-13～IR37-15、IR37-27、IR37-33～IR37-35。 |
| specification §9 | 适用（边界） | anchor/local capability 不因 lifecycle 绕过归入 IR37-15～IR37-22、IR37-35、IR37-37。 |
| specification §10、§10.1 | 适用 | governor/storage maintenance/permit/锁序归入 IR37-10、IR37-20、IR37-24、IR37-38。 |
| specification §11 | 适用 | stop/removal/lost/uninstall 产品旅程归入 IR37-12、IR37-13、IR37-26～IR37-34。 |
| specification §12 | 适用 | 不变量到机械验收映射归入 IR37-02～IR37-06、IR37-35～IR37-40。 |
| specification §13 | 适用 | core/server/cli/resources/scripts 文档影响归入 IR37-35、IR37-39～IR37-40。 |
| specification §14 | 不适用（新增功能） | S1开工清单已封版；仅在IR37-39检查兼容。 |
| specification §15 第1～36、38行 | 不适用（新增功能） | 已封版前置或Unit38；只作为IR37-39兼容/越界边界。 |
| specification §15 第 37 行及字段级 DeviceLifecycleRecord | 适用（核心） | 三路径 identity/phase/abort、八类 evidence、two-root 与入口 ownership 枚举行逐项归入 F37-01～F37-07、IR37-02～IR37-36。 |
| S2 范围说明与裁决 | 适用（兼容） | 不新增依赖，不改变证书/PAKE用途，归入 IR37-37、IR37-39～IR37-40。 |
| S2 强制门禁 | 适用（兼容） | 精确锁版、owner、PAKE 非生产隔离、package import/export 归入 IR37-37、IR37-39～IR37-40。 |
| S2 接受依据 | 适用（兼容） | TLS/证书/PAKE与秘密暴露面不得扩张，归入 IR37-22、IR37-26、IR37-37。 |
| verification-runbook.md | 不适用（功能范围） | 仅约束后续验证命令和运行方式；当次测试/构建结果只作各审查项证据，不建立独立功能项。 |
| development workbench 静态规则 | 不适用（功能范围） | 只约束开发清单维护与架构空洞裁决；Unit37 功能边界由 D37-01～D37-09 承载。 |
| D37-01 | 适用 | protocol/journal/identity/phase/abort/retention 归入 IR37-02～IR37-06。 |
| D37-02 | 适用 | stop 三策略与 exact host 归入 IR37-07～IR37-12。 |
| D37-03 | 适用 | effect-free preflight、issuer accepted、target gate、冻结 exact-set、漂移重显与 decision 归入 IR37-13～IR37-16、IR37-19～IR37-20。 |
| D37-04 | 适用 | transfer/destroy/abort/settlement 归入 IR37-16～IR37-18。 |
| D37-05 | 适用 | issuer selector/authority-change guard、signed ready、原子 revoke/exposure、窄历史终态重放、route/secret 归入 IR37-14、IR37-20～IR37-23。 |
| D37-06 | 适用 | target terminal、cleanup、supervisor、key-last 与删除注册前后恢复归入 IR37-23～IR37-25、IR37-32。 |
| D37-07 | 适用 | 同 operation 的 reachable→lost 选择、远端撤销与诚实未知归入 IR37-26。 |
| D37-08 | 适用 | anchor preflight、migration 后旧设备移除、两次真实 checkpoint、retirement/final exact-set 归入 IR37-27～IR37-31。 |
| D37-09 | 适用 | pre-runtime recovery、入口所有权、S7 exact-set 与各项直接证据归入 IR37-32～IR37-40。 |
| Unit36 正式账本与归档清单 | 不适用（新增功能） | 仅证明上游 supervisor 封版；交界兼容归入 IR37-11、IR37-25、IR37-39。 |

### 当前交付物与审查落点

| 交付分组 | 当前文件 | 审查落点 |
| --- | --- | --- |
| lifecycle protocol/codec | core/protocol/device-lifecycle.ts、device-lifecycle.test.ts 及 barrel | IR37-02～IR37-04、IR37-19、IR37-21、IR37-36～IR37-37 |
| lifecycle journal/stream/retention | core/authority/device-lifecycle-journal.ts、对应测试、commit-log.ts 及 barrel | IR37-03～IR37-06、IR37-21、IR37-30～IR37-32、IR37-36 |
| stop production chain/evidence | cli/serve/host-stop-lifecycle.ts、stop.ts、command.ts；server context/lifecycle/server RPC；三组直接测试 | IR37-07～IR37-12、IR37-32～IR37-36 |
| removal issuer/target/mesh | device-removal.ts、device-removal-mesh.ts、mesh-runtime-assembly.ts、executor-role-runtime.ts 及直接测试 | IR37-13～IR37-23、IR37-26、IR37-35～IR37-38 |
| local authority freeze | local-conversation-owner.ts 及 lifecycle 测试 | IR37-15～IR37-20、IR37-36～IR37-38 |
| local cleanup/supervisor/resources | device-removal-cleanup.ts、managed-service.ts、storage-maintenance.ts 及测试 | IR37-23～IR37-25、IR37-31～IR37-32、IR37-38～IR37-39 |
| removal CLI/RPC | runtime/device-removal-command.ts、facade、CLI index、server registry/methods 及测试 | IR37-13、IR37-26、IR37-33～IR37-35、IR37-40 |
| anchor uninstall production/evidence | cli/serve/anchor-uninstall.ts、command.ts；runtime command/facade；CLI/server 入口及直接测试 | IR37-27～IR37-36、IR37-38～IR37-40 |
| pre-runtime recovery | mesh-runtime-bootstrap.ts 及测试 | IR37-23～IR37-25、IR37-31～IR37-36、IR37-39 |
| registry/S7 | canonical-registry golden、s7-entry-coverage.mjs 及测试 | IR37-33、IR37-35、IR37-39～IR37-40 |
| specification/development checklist | specification.md、unit-development-workbench.md | 来源覆盖、IR37-01～IR37-40 |
| Unit36 archive | unit-review-checklists/distributed-runtime/unit-36.gen-1.md | 仅保存上单元原动态区，不作为 Unit37 功能证据 |

### 固定范围矩阵

| 编号 | 有限闭包 | 固定内容 |
| --- | --- | --- |
| F37-01 | 三路径状态机 | stop：accepted→gate-closed→work-settled→flushed→ready-to-stop→terminal；removal：accepted→gate-frozen→authority-decided→authority-settled→revocation-ready→revoked→cleanup-complete→terminal；uninstall migration：accepted→gate-frozen→transfer-committed→cleanup-complete→terminal；uninstall backup：accepted→gate-frozen→checkpoint-verified→retirement-decided→gate-closed→work-settled→flushed→final-checkpoint-verified→cleanup-complete→terminal。stop 不可 abort；removal 在 authority-settled 前、uninstall 在 transfer-committed/retirement-decided 前可 authenticated abort。 |
| F37-02 | 公开/远端入口 exact-set | current-anchor：device.list/remove/status/continue；本机：OS signal、CLI stop/uninstall 与 loopback server.shutdown、server.uninstall.preflight/begin/continue/cancel/status；有限认证 mesh：device.removal.target 的 accept/decide/status/abort 与 device.removal.issuer 的 accept-self/ready/terminal。 |
| F37-03 | 生产根与形态 | stop：managed/on-demand/foreground；removal issuer：current anchor 恰一；removal target：anchor+executor 与 executor-only 两根；uninstall：current anchor 的 migration/backup 两路；surface/empty/disabled 不装配 lifecycle owner。 |
| F37-04 | accepted-work 与本地 owner exact-set | current/frozen/importing conversation；active run/interaction；pending final/assignment；DeferredGlobalIntent；RunFinalOutbox/delivery outbox；remote/channel/scheduler/delivery obligation；lease、permit 与 managed instance。 |
| F37-05 | authority/cleanup exact-set | 权威六类：全局状态与期望配置、会话状态、会话内容资产、环境事实与本地秘密、执行资产、非权威缓存；cleanup 仅限 frozen home 的 provider/channel/MCP/rendezvous/transfer candidate/device secret、workspace/environment binding、projection/staging/reservation/artifact/cache，排除用户 workspace、其他 home、独立 checkpoint target 与最小非秘密 terminal/tombstone。 |
| F37-06 | 故障与竞态切点 | accept 前/后；F37-01 每次 phase sync 前/后；transfer/delete/revoke/retirement/checkpoint/supervisor unregister/key delete/stop 的效果前、效果后响应前；同/异 identity 并发；cancel 与首个不可逆事实竞争；坏尾、缺/坏 ref、网络/manager/磁盘/容量失败；连续两次重启与迟到旧 owner/endpoint 请求。 |
| F37-07 | lifecycle evidence kind exact-set | accepted-work、authority-transfer、authority-deletion、trust-event、credential-exposure、checkpoint、supervisor、cleanup；含 ArtifactRef 的证据在 terminal transaction 继续声明 candidate reference。 |
| F37-08 | 可复核直接证据分组 | codec/reducer/journal/retention；stop coordinator/CLI/RPC/supervisor；local owner/removal issuer-target/mesh/cleanup；uninstall migration/backup/CLI/RPC；pre-runtime non-resurrection；canonical registry 与 S7 结构 exact-set。每个功能项只使用对应现有测试和结构证据，不另设 build/test 结果项。 |

### 审查项

> U37-01修复改变的12个节点已全部独立重审并完成价值裁决：同一生产endpoint上的早期bind、closed recovery、逐phase前滚与同对象activate成立；非默认host竞争只可由内部函数参数/测试构造，当前CLI、managed definition与权威配置均无该用户入口。12项无P0/P1，统一标为`[x]`；其余28项继续复用。

| 编号 | 状态 | 审查对象 | 独立通过条件与可复核证据 |
| --- | --- | --- | --- |
| IR37-01 | [x] | 单元身份与有限边界 | 本轮独立重审：当前差异只补第37单元既有stop operation逐phase successor恢复和`server.shutdown`方法级错误投影；实现复用既有journal、artifact、owner ports、`RpcAppError`与生产根，未引入独立恢复计划、通用错误框架或Unit38能力。来源补充与实现边界一致，无P0/P1范围问题。 |
| IR37-02 | [x] | strict lifecycle DTO/codec | `device-lifecycle` identity/record/decision/evidence 继续 exact-key、version、phase 与签名严格解码；新增 backup `gate-closed→work-settled→flushed` 顺序已进入 reducer，delivery `lifecycleBinding` 亦在 replay 前 strict decode owner/id/revision exact-set。未发现非规范输入可越过 codec。 |
| IR37-03 | [x] | stable identity 与 subject 单飞 | stop identity现必含`localDeviceId`，reducer在`home+host`外同时占用`home+device`；removal/uninstall占同一本机device subject，三路径durable accept恰一。`DeviceLifecycleJournal.active()`对双subject去重，settle/seal/release只消费调用参数中的exact operationId，已删除进程级可变owner。 |
| IR37-04 | [x] | phase/abort/terminal reducer | stop、removal、migration 与 recovery-backup 的合法相邻 phase、不可逆点、abort/terminal 幂等和冲突拒绝均由同一 reducer 固定；新 backup closure phase 顺序与规格一致，未发现跳 phase 或 terminal 回退。 |
| IR37-05 | [x] | 唯一物理日志与 transaction | 本轮独立重审：stop identity、phase、artifact与terminal仍只来自同一本机`AuthorityCommitLog`；`startupLifecycle`、`alreadySettled`及delivery admission均由该耐久事实派生，root-local release只消费exact operation且进程重启会重新投影，不形成第二耐久事实源。未发现无日志决定或跨日志提交，结论无P0/P1。 |
| IR37-06 | [x] | evidence retention/GC | stop accepted-work artifact由 `gate-closed` evidence 保留；backup retirement transaction 同 envelope 写 artifact evidence 并声明 candidate reference，后继 phase/terminal candidateReferences 继续保留。缺失、错 digest、非 canonical 或歧义 artifact 均在 settlement/checkpoint/cleanup 前拒绝，普通无引用 artifact 仍按现有 GC。 |
| IR37-07 | [x] | stop 入口与本机授权 | 价值裁决后重审：公开`serve`入口只传`managed`，不接受host/port；anchor/executor生产根均使用`DEFAULT_SERVER_CONFIG.host`与同一`homeToPort(home)`，因此同home竞争实际落在同一endpoint，早期inactive bind的EADDRINUSE loser在owner效果前退出。内部参数构造异host不属于受支持产品入口，无P0/P1。 |
| IR37-08 | [x] | stop gate | 价值裁决后重审：受支持生产endpoint只有一个OS winner；winner内`recoverAcceptedWork=false`已覆盖local readiness/lifecycle projection及mesh/worker恢复，旧host proof前零accepted-work owner效果。上一轮双host前提不可由产品入口到达，故closed gate合同通过。 |
| IR37-09 | [x] | stop 三策略 accepted-work | 价值裁决后重审：同一生产endpoint单飞成立，三策略按同一frozen `id/revision`逐owner settle/read-back；`accepted/gate-closed/work-settled/flushed/ready-to-stop`仅补各自未完成步骤，响应丢失重放不重复已耐久效果。无P0/P1。 |
| IR37-10 | [x] | flush 与资源安全点 | 价值裁决后重审：唯一生产winner下coordinator由durable phase保证`work-settled`只补flush、`flushed`只补physical，journal前外部效果由各port exact read-back吸收；异host双执行者不是受支持场景，未发现独立flush/资源阻断。 |
| IR37-11 | [x] | exact host stop/future preservation | 价值裁决后重审：当前产品本机lifecycle endpoint的host固定为loopback，port按home确定，故`StopEndpointLock`的port与bound handle足以判别当前受支持endpoint；PID/startTime/startedAt区分generation，managed链另验definition/manager。为内部不可达host参数扩充耐久DTO没有当前价值，无P0/P1。 |
| IR37-12 | [x] | stop 故障恢复 | 价值裁决后重审：真实非零固定endpoint竞争、inactive HTTP/WS、同对象activate、winner崩溃后OS释放及五phase恢复已有直接证据；异host同port虽可由OS建立，但CLI/managed产品入口不能生成该组合，不能据此判定当前恢复失败。 |
| IR37-13 | [x] | removal effect-free preflight 与名称体验 | current issuer 先耐久 accepted/selector guard，reachable target 随后只读 local owner 与 external owner 投影并外置 preflight；此时尚未关闭本地域 gate、未 transfer/delete/revoke。用户决定前返回冻结名称/数量；离线路径明确投影 local data unknown，不伪造空集已清理。 |
| IR37-14 | [x] | issuer accepted 与 lifecycle guard | issuer accepted identity 冻结 target member public key/device-key generation、issuer 与 trust ancestor；同 subject 单飞及 current-authority guard 在 target 效果前生效，成员换代、竞争 operation、非 current issuer 与错误名称均零后续副作用。 |
| IR37-15 | [x] | target 两根 accepted/gate | target lifecycle与启动扫描都使用`bootstrapStore.authorityLog()`；两种生产装配均先恢复local active operation，再以closed参数启动mesh/local conversation/job/channel/delivery。decision前关闭local+external gate并重采完整ownerItems，artifact未形成时保持全部producer关闭，形成后只恢复同operation exact work。 |
| IR37-16 | [x] | local authority/work exact-set 与决策复验 | effect-free preflight与关gate后的snapshot作digest全等复验，变化则释放gate并重显；decision artifact耐久完整十owner `id/revision`。delivery source映射保留`local:`/`relay:` namespace，conversation/final/scheduler各消费自身稳定revision，authority逐项exact核验而不代填，same-id successor零append。 |
| IR37-17 | [x] | removal transfer | transfer只消费decision中的conversation及十owner exact-set：复用既有AuthorityTransfer提交/tombstone，随后local owner与external ports逐项settle/read-back；delivery先安装冻结source、恢复causal work、seal并drain至terminal，全部归零后才写`authority-settled/revocation-ready`。响应丢失重放原decision与原transfer身份。 |
| IR37-18 | [x] | irreversible destroy | destroy决定与冻结snapshot artifact同一operation耐久后才执行；local owner按同一conversation exact-set收束run/intent/final并写删除/tombstone，external及delivery继续按同一ownerItems settlement。首个不可逆点后只能重放原mode/target，未全量read-back不得进入ready。 |
| IR37-19 | [x] | cancel/irreversible race | signed abort与`authority-decided`由同一journal恰一胜出；durable aborted先授权同operation gate释放，absent幂等、异operation拒绝，再hydrate原`target-aborted` receipt；ready胜出保持原ready，连续重启不回退。 |
| IR37-20 | [x] | target work/resource ready | local owner、remote/channel/scheduler/delivery与lease/permit均来自同一decision ownerItems；每个port校验operation及frozen `id/revision`，完成settle后独立read-back，delivery包含迟到causal item且drain至terminal，governor在写ready前完成安全协调。任一缺项、换代、未终结或响应不明均保持gate与原phase。 |
| IR37-21 | [x] | revoke/exposure/lifecycle atomicity | issuer 在同一 `AuthorityCommitLog.transactProjection()` 内重验 accepted trust ancestor与 target generation，并原子追加 revoke trust event、全部 active exposure→compromised 及 lifecycle `revoked`；无关 trust 前进保留祖先身份，竞争换代 fail-closed。 |
| IR37-22 | [x] | route/capability/secret closure | revoke transaction 可见后 current trust 立即使 resolver/inventory/capability/fresh dispatch拒绝目标并断开普通服务；issuer rendezvous ref按 exact target删除，删除失败在同 revoked operation 重放，后继 member generation 由 accepted guard隔离。 |
| IR37-23 | [x] | narrow historical terminal replay | revoked peer只经独立terminal-only registry进入ready/cleanup-ready/target-aborted/terminal四方法；每个方法先做exact-key/version与accepted target身份反绑，普通service admission不放宽。aborted重放先完成exact gate release，再复用同一签名receipt。 |
| IR37-24 | [x] | local cleanup exact-set | cleanup roots为代码内冻结的 current-home 子路径并逐项 `assertOwnedPath`；walker每个 governor step最多处理128个dirent，secret按稳定顺序每128项删除/read-back，排除用户workspace、其他home、checkpoint target、device key与最小 lifecycle log。 |
| IR37-25 | [x] | supervisor/key-last/process exit | target先完成文件/非device-key secret清理与 exact supervisor unregister，再耐久 cleanup-ready；issuer terminal返回后才 compare-delete冻结 device-key，随后写本机terminal并走安全自退出。错slot拒绝删除，pre-runtime resumer在角色/key/listener前续做未终结本机清退。 |
| IR37-26 | [x] | reachable/offline lost同一终态 | lost是issuer日志中的显式不可逆选择：只提交本端 revoke/exposure与 `localData=unknown` cleanup/terminal，不生成 target ready/cleanup 事实；迟到设备仍是 revoked 且只能进入 terminal-only 通道，公开结果持续说明本地数据不可达。 |
| IR37-27 | [x] | uninstall preflight/local-only | 五个 `server.uninstall.*` 方法均经 loopback guard；preflight只读 active lifecycle、ready migration target 与真实 checkpoint status，缺少安全路径时零 accepted/零 gate，begin 才冻结 home/current device/epoch/trust 与选定 target generation。 |
| IR37-28 | [x] | migration uninstall | migration在`accepted`后关闭公开及十owner producer gate，冻结canonical accepted-work artifact并安装exact delivery admission；逐owner以drain语义settle/read-back、刷稳日志与物理步骤后才调用既有planned transfer并全等验证新owner，随后进入`transfer-committed→cleanup`。重启按artifact/phase恢复原admission与sealed，零新source窗口。 |
| IR37-29 | [x] | first recovery checkpoint | `force(pre-retirement)`后 coordinator 直接调用同一 checkpoint service 的 `verify(checkpointId,recoveryRoot)`；service从冻结 target read package、用用户 recovery root真解封，严格核验issuer/home/root/manifest/catalog/retained闭包并写耐久 verification，非 status 自报。 |
| IR37-30 | [x] | retirement/final checkpoint | recovery-backup先真解封验证pre-checkpoint；确认时在同一transaction反绑十owner artifact与retirement decision。逐项immediate安全settlement/read-back后写`flushed`，从该lifecycle record真实LSN取水位，final checkpoint用同root真解封且要求`upToLsn>=flushedLsn`；startup按phase恢复sealed，未通过不得cleanup。 |
| IR37-31 | [x] | uninstall cleanup/terminal | migration与backup均先完成各自accepted-work闭包再进入cleanup。cleanup只遍历冻结current-home roots，walker与SecretStore按128固定批次、governor前滚；随后exact supervisor unregister、非device-key秘密、cleanup-complete/ready、issuer terminal、exact device-key compare-delete、本机terminal与安全退出，错slot/错home零误删。 |
| IR37-32 | [x] | pre-runtime recovery/non-resurrection | 价值裁决后重审：两根均先scan/strict hydrate再争用同一生产endpoint，只有winner可恢复原phase；terminal/exact release后才激活，崩溃后继重新读耐久事实。内部异host参数不是启动入口，当前non-resurrection无P0/P1。 |
| IR37-33 | [x] | RPC/CLI/mesh ownership与隐私 | 封版独立复审：生产实现、方法级测试与真实dispatcher测试对同一`INTERNAL_ERROR/安全停机未完成/{action:retry-same-request}`全等，内部`delivery flush failed`不再被直接测试当作公共合同；失败零trigger。router认证、loopback/strict params、既有`RpcAppError`和其他RPC/mesh授权未变，零raw内部身份泄漏，无P0/P1。 |
| IR37-34 | [x] | complete product journeys | 价值裁决后重审：用户可达停机、自动/显式重启均使用同一loopback home endpoint；恢复期间稳定503，terminal/release后原对象激活并发布ready，连续接替唯一前滚。异host双入口不是产品旅程，无P0/P1。 |
| IR37-35 | [x] | production roots/profile exact-set | 价值裁决后重审：anchor/executor及managed/on-demand/foreground均接收同一公开options集合；实际入口不提供host/port，故两根固定为loopback+home派生端口，并共享早期bind/后期activate结构。内部类型接缝不扩大生产profile exact-set。 |
| IR37-36 | [x] | fixed fault/recovery matrix | 封版独立复审：F37-64～F37-69仍由同一非零loopback home endpoint覆盖；shutdown普通异常的直接测试现已验证固定wire投影及零trigger，不再期待raw错误。两个既有环境基线均在当前单元断言前失败且有独立归因，必要证据与当前范围成比例。 |
| IR37-37 | [x] | security/secrets/isolation | 封版独立复审：shutdown普通异常在方法边界被替换为固定错误，修正后的直接测试明确拒绝原message泄漏；stack、operation/device/path均不进入wire，既有`RpcAppError`仅保留已支持公开行动。stop successor未新增secret读取、跨home路径、远端授权或公开拓扑字段，无P0/P1安全或隔离问题。 |
| IR37-38 | [x] | resource/cancel/lock order | 价值裁决后重审：受支持生产endpoint上同一handle贯穿bind/activate/close，anchor rollback与executor finally均关闭handle，失主由OS释放；三策略/cancel锁序不变。不存在用户可达的跨host双handle，资源与锁序无P0/P1。 |
| IR37-39 | [x] | layering/compat/Unit38 boundary | 本轮独立重审：依赖方向仍是core lifecycle/delivery原语→CLI生产装配与server公开投影，未新增跨包反向依赖、通用恢复/错误框架、新runner、升级/替换/回滚或发布能力；第30～36单元既有owner、delivery、supervisor接口只被组合使用。当前阻断是Unit37内部启动仲裁缺口，不是分层或Unit38越界，故本项无P0/P1。 |
| IR37-40 | [x] | registry/S7 与证据充分性 | 封版独立复审：30个Vitest入口取得355项Unit37相关通过证据，S7 20/20与golden沿未变输入复用；shutdown陈旧断言已修正并定向3/3，两个既有环境基线分别有历史归属和失败点证据，不以其冒充当前通过或阻断。真实双进程端点证据、两根顺序合同与当前范围仍充分。 |

---

## P0/P1 阻断问题列表

> 本表只保留尚未转入正式问题清单的待解决问题；表为空仅表示尚无已审发现。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- | --- |

### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| --- | --- | --- | --- |
| P37-21 | P0/中：把不同host同port可并行listen视为受支持stop successor，并要求扩充`StopEndpointLock`与两根owner谓词。 | OS反例本身成立，但举证前提不成立：公开`zhixing serve`只接受`managed/managed-home/managed-secret-backend`，调用`runServeCommand()`时仅传`managed`；权威配置没有本机lifecycle server host/port项，两根生产根因此始终使用固定`127.0.0.1`和同一`homeToPort(home)`。`ServeOptions.host/port`仅是未暴露的内部/测试接缝，generic server的可配置host也不装配Unit37 stop lifecycle。上一轮以F37-70验收文字和内部类型存在性代替了当前用户可达性。保持现状的用户损失为零；扩耐久DTO和故障矩阵只会增加无价值复杂度。 | 删除，无确定未来交付义务；同步把12项恢复为`[x]`并将F37-70理解收窄为“生产根使用同一已解析非零endpoint，受控测试覆盖不得改变产品范围”。仅当公开CLI、managed definition或权威配置新增本机lifecycle host/port，或生产调用图实际向两根传入不同host时重开。用户体验达标：当前本机loopback单飞、恢复与安全停机不受影响。架构达标：复用现有OS endpoint owner，不为不可达组合扩充协议或新锁。 |

## 非阻断级问题列表

> 本表只保留尚未转入正式问题清单的问题。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |

> **独立审查结论**：通过。当前40项全部为`[x]`，零`[!]`/`[~]`/`[ ]`；封版测试合同变化影响的4项已在新冻结输入上独立复审，P0/P1与非阻断级问题列表均为空。P37-21经反向价值裁决删除并进入“已删除问题的价值裁决记录”，其重开条件当前未满足；本轮没有待转存的当前问题。
