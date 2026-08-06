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
目标：只收敛第 30 单元正式问题列表中的 U30-02～U30-06 五个 P1 和 U30-01 一个 P2，使六项真正命中设备账本单一所有权、本地域 interaction/finality 消费、SessionState 会话身份、只读资产缓存、构造期全局能力隔离及必要 conformance 闭包的根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 30 单元正式文件中的 U30-01～U30-06，只依据六项问题最新的事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U30-01 → U30-02 → U30-03 → U30-04 → U30-05 → U30-06` 从权威架构、规格和当前生产调用图重建事实链，核准生产入口、唯一 owner/事实源、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；判断现有描述命中根因还是表象。U30-01 不得恢复已被共享日志、投影复用和读路径证伪的数据面漏读主张；U30-06 必须与 U30-02～U30-05 的生产根因分离，只承载独立的必要证据闭包。
2. 穷尽直接变体：U30-01 覆盖 anchor+executor、executor-only、两 domain assignment、binding guard、interaction/abort、响应丢失和重启；U30-02/03 覆盖确认、取消、final-outbox、未知/已删除会话、九类 SessionState 写、并发和连续恢复；U30-04/05 覆盖 skill/rubric/prompt cache 有无/过期、local-draft、全局保存拒绝及 global capability 的 import/构造/binder/call；U30-06 覆盖双域、两生产根、八配置 exact-set、workspace 两形态和必要故障。每格必须指出稳定身份、耐久事实、拒绝副作用、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内的最优架构审查方案：优先复用 executor 组合根与同一 ledger/log、现有 confirmation/interaction/final-outbox、SessionState directory guard、S4 只读 catalog/ArtifactStore、构造期 capability 判别、现有 S7 gate 和 owner/protocol conformance。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；八配置只验证装配 exact-set，完整故障矩阵只落在两生产根。不得新增第二事实源、公开离线 surface、全局写/保存能力、通用 registry/调用图、测试 runner、监控、诊断、benchmark 或信息采集。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 六项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：device ledger/data-plane 单一所有权、本地域 interaction/finality 与 SessionState 生命周期、advancement 只读缓存与构造期能力隔离、双域/双拓扑 conformance 及范围价值。各路必须抛开前轮结论，从当前合同和源码主动构造第 2 步反例，并核查 `U30-01↔U30-02`、`U30-02↔U30-03`、`U30-04↔U30-05`、`U30-02～U30-05↔U30-06` 的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；U30-01～U30-06 的全部受支持 topology、owner/身份、消费终态、缓存与能力边界、故障恢复和必要证据均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，最优方案和验收条件可直接执行，不会因同根残留继续局部返工。满足后明确回复“U30-01～U30-06 的根因与最优方案已闭合”并立即停止。

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
目标：彻底解决第 30 单元 U30-02～U30-06 五个 P1，闭合本地域 interaction/finality、SessionState 会话身份、S4 只读执行资产、构造期全局能力隔离和必要 conformance 的全部同根直接变体；不得扩展到其他问题或全单元流程。U30-01 已转为 EX30-01，重开条件未被新事实触发时禁止实施单 ledger 对象改造。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 30 单元正式文件中的 U30-02～U30-06、EX30-01，只依据五项问题最新的根因、价值裁决、固定矩阵、方案、验收条件、反证账和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产装配图重建五项固定矩阵。U30-02 覆盖 pending interaction、ticket answer、取消竞态、status/history、final-outbox、响应丢失与 stop；U30-03 覆盖全部 control/staged mutation、未知/已删除会话、并发 create/delete 与 exact replay；U30-04 覆盖 skill/rubric/prompt index/content 的版本、digest、缺失、过期、损坏、重启与 local-draft；U30-05 覆盖 local runtime/assembly/两组合根的禁用能力 import、构造、注入、binder、call 和 port exposure；U30-06 覆盖双域、两生产根、八配置 exact-set、workspace 两形态及必要故障。逐格绑定唯一事实源、稳定身份、线性化点、消费终态、零副作用边界和直接证据，并持续核对 EX30-01 的排除前提。
2. 按 `U30-03 → U30-04 → U30-02 → U30-05 → U30-06` 一次完成。给 SessionState 普通 control 与 advancement journal 事务单源化“exact replay 先于 fresh identity guard”的顺序，staged 继续反绑 active assignment；在既有 S4 execution snapshot 安装链补齐与 inventory revision 全等绑定、正文落现有 ArtifactStore 的签名三类 index snapshot，并以窄只读 catalog 接入 local rubric、skill window 与 prompt consumer，坏/缺缓存只按无匹配继续 local-draft；复用 observer、ledger、status/history 和 final-outbox 建立 internal-only interaction/finality port，final 只由同一权威 history 验真并由现有 outbox落唯一 published 回执；收窄 local port 的 protocol 暴露面，并扩展现有 S7 AST gate 到 local runtime/assembly/两生产根的真实禁用能力闭包；最后用现有 owner/protocol 场景形成共享 conformance 表与两生产根、八配置证据。同步直接相关架构、规格和测试。同根残留并入原问题，禁止合并 domain 私有 ledger facade、恢复公开离线入口、GlobalState/DeferredIntent/global save，或扩建第二事实源、通用同步/registry/调用图/测试 runner、监控、诊断、benchmark 和信息采集。每个实质阶段完成后立即更新正式状态与证据。
3. 按验证手册运行受影响闭包的最小必要类型检查、直接合同/场景测试、现有 S7 lint 与必要派生资产检查；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须直接覆盖 U30-02～U30-05 的生产边界，双域完整功能/故障矩阵只运行真实 anchor+executor 与 executor-only 根，八配置只验证装配 exact-set；不得运行包全测、模块回归或与五项验收无关的验证。失败先归因，实现问题直接修复并回到第 2 步。
4. 验证通过后冻结当前交付物指纹，整轮只读地逐格重建 U30-02～U30-06 事实链；测试通过不得代替功能判断，矩阵全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：device ledger/data-plane 单一所有权、本地域 interaction/finality 与 SessionState 生命周期、advancement 只读缓存与构造期能力隔离、双域/双拓扑 conformance 及范围价值。各角色须抛开既有结论，主动重造第 1 步全部适用反例，并核查 `EX30-01↔U30-02`、`U30-02↔U30-03`、`U30-04↔U30-05`、`U30-02～U30-05↔U30-06` 的直接交界。
5. 新发现首次出现即以稳定编号写入正式问题证据与反证账；收口前对历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和矩阵，再回到第 2 步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的 U30-02～U30-06 五项方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；累计反证全部有耐久处置，证明 internal confirmation/finality 在响应丢失与连续恢复后恰一终态，未知/已删除会话 fresh write 零追加且 exact replay 全等，三类只读缓存按冻结版本安全消费且 local-draft 不被坏/缺缓存阻断，local 构造闭包零全局写能力，双域两生产根和八配置取得成比例证据，EX30-01 重开条件仍不成立；五项均已更新为“已验证”。满足后明确报告“U30-02～U30-06 五项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，根据变更文件范围更新审查清单状态；
```

## 审查清单

### 当前状态

- **当前单元**：第 30 单元 · generation 1
- **权威来源**：`research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md`、`research/design/modules/distributed-runtime/distributed-runtime-charter.md`、`research/design/modules/distributed-runtime/specification.md` 与当前定稿开发清单 D30-01～D30-07；其他模块文档不是本单元架构依据
- **交付基线**：起点 `2526d6e8`；当前冻结输入共 56 个变化路径，其中 50 个属于第 30 单元生产实现、直接测试与合同同步，5 个为工作台/归档状态，`.agents/skills/project-onboarding/SKILL.md` 为用户另行授权的 Skill 规则修正；后 6 个路径均不属于第 30 单元功能交付物
- **目标提交边界**：第 30 单元（S8）本地域 owner 同构装配；每个 executor-enabled 生产拓扑恰有一个 device-local owner，复用 owner-kernel、owner-services、会话耐久协议、完整 SessionState、执行账本、数据面与设备容量，同时物理隔离 GlobalState/global publish/external delivery
- **明确排除**：第 31 单元 DeferredGlobalIntent；第 32 单元公开离线会话创建、查询、迁居与接管；第 33～38 单元；离线全局读副本或新缓存同步；本地全局写、渠道和全局 registry；第二套 kernel/protocol、空 global port、通用基础设施、监控、诊断与 benchmark
- **当前任务进度**：21%（7 / 34 项结论仍可直接复用；0 项 [ ]，7 项 [x]，0 项 [!]，27 项 [~]）
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1 阻断问题；[~] 输入变化，须重审，旧证据不代表当前结论

> **清单状态**：U30-02～U30-06 已在正式问题列表更新为“已验证”，EX30-01 重开条件未触发；按本次 50 个交付路径的影响闭包，27 项旧结论失效并改为 `[~]`，其余 7 项事实未变继续复用。当前无 `[!]`，下一轮只审 `[~]`。

### 来源覆盖

| 来源 | 判定 | 归入审查项或不适用依据 |
| ---- | ---- | ---------------------- |
| `always-online-and-local-execution-requirements.md` §一 | 适用 | 本机真实环境执行与持续在线并存的产品目标归入 IR30-01、IR30-27、IR30-33。 |
| 需求文档 §二～§五 | 不适用 | 外部项目调研、资料核验和方案形成过程不是规范性合同。 |
| 需求文档 §六～§七 | 适用 | 单机/常驻形态平权、本机优先、anchor 不可达时本机继续且全局能力诚实不可用，归入 IR30-01、IR30-23、IR30-25～IR30-27、IR30-31。 |
| `distributed-runtime-charter.md` 当前交付原则、一、二 | 适用 | 最小完整产品、一个产品、同构组合根与本地域连续执行归入 IR30-01～IR30-03、IR30-27、IR30-31、IR30-33～IR30-34。 |
| 总纲 §1～§3 | 适用 | 单机退化形态、角色职责、executor 内本地域 owner、正式包边界和无环依赖归入 IR30-02～IR30-03、IR30-27～IR30-28、IR30-33。 |
| 总纲 §4 的身份、权限、能力、秘密与最小权限 | 适用 | 本地域身份、签名权限快照、ControlLease、秘密边界和 fail-closed 归入 IR30-04、IR30-14、IR30-25。 |
| 总纲 §4 的配对、mesh、迁居授权与恢复码 | 不适用 | 属既有 mesh 或第 32 单元；当前只在 IR30-25～IR30-26 检查本地域 owner 未绕过。 |
| 总纲 §5 | 适用 | 会话、环境、资源、内容与执行资产的正向 owner，以及全局/传输能力的负向边界，归入 IR30-03、IR30-06、IR30-08～IR30-18、IR30-24～IR30-26。 |
| 总纲 §6 的 conversation run、确认、取消、重放与终态 | 适用 | 归入 IR30-07、IR30-12、IR30-17～IR30-20。 |
| 总纲 §6 的 job、global publish 与 delivery 正向流程 | 不适用 | 本单元无 job owner、GlobalState 或外部投递；物理不可达由 IR30-25 覆盖。 |
| 总纲 §7～§8 | 适用 | 环境、资源、路由、owner-services、数据面、artifact 与 finality 的直接交界归入 IR30-06、IR30-11、IR30-13、IR30-15～IR30-18、IR30-21～IR30-23。 |
| 总纲 §9 本地域 owner 当前段 | 适用 | 显式合同、共享物理基础设施、独立逻辑流、零 GlobalState/publish/delivery 和 internal-only 归入 IR30-02～IR30-06、IR30-24～IR30-31。 |
| 总纲 §9 的公开离线入口、AuthorityTransfer、迁居与灾备 | 不适用 | 属第 32～38 单元；当前仅检查零公开入口和 anchor 会话零接管。 |
| 总纲 §10 的 SecretStore 与 prepare/activate/stop 直接生命周期 | 适用 | 归入 IR30-14、IR30-29～IR30-30。 |
| 总纲 §10 的托管服务、三路径移除与迁移 | 不适用 | 属后续部署/迁移单元。 |
| 总纲 §11 当前能力诚实性与内部交付边界 | 适用 | 归入 IR30-23、IR30-25、IR30-31。 |
| 总纲 §11 的公开离线产品旅程 | 不适用 | 明确由第 32 单元交付。 |
| 总纲 §12 的 conversation owner/run/log/disk/权限/资源/停机故障 | 适用 | 归入 IR30-07、IR30-09～IR30-20、IR30-29～IR30-30。 |
| 总纲 §12 的迁居、信任、全局模块、channel 与 mesh 专属故障 | 不适用 | 当前不拥有这些能力；零可达归入 IR30-25～IR30-26。 |
| 总纲 §13 不变量 1～18 的本地域直接部分 | 适用 | 双 owner fencing、幂等提交、域栅栏、角色零加载、秘密、ID、conversation uncertain/dispatch、双拓扑、结构、staged 零外泄、安全、恢复与资源部分归入 IR30-02～IR30-33；job/channel/transfer/存储维护专属部分不进入当前门禁。 |
| 总纲 §14 第 30 单元 | 适用 | S8 local owner 顺序和 internal-only 停止条件归入 IR30-01、IR30-27、IR30-31、IR30-34。 |
| 总纲 §14 第 31～38 单元 | 不适用 | 后续单元，不得成为当前提交门禁。 |
| 总纲 §15 | 适用 | 本单元范围内的双拓扑结构、行为和故障证据分别内嵌于 IR30-27、IR30-29～IR30-34；不建立独立构建/测试结果审查项。 |
| `specification.md` §1.1 | 适用 | `local-<设备指纹载荷前 8 位>-<Ulid>`、localDomainId、ownerEpoch/localGovernorEpoch、operation/attempt 身份归入 IR30-04～IR30-05、IR30-12、IR30-18～IR30-20。 |
| 规格 §1.2 | 适用 | 本单元实际消费的签名、digest、wire 与严格解码归入 IR30-09、IR30-11、IR30-14、IR30-17。 |
| 规格 §1.3、§1.3b 的 SessionState/run/control/evidence/resource/local-owner 类型 | 适用 | 归入 IR30-02、IR30-08～IR30-24、IR30-33。 |
| 规格 §1.3、§1.3b 的 intent/transfer/channel/global-module 专属类型 | 不适用 | 属后续单元或本地域禁用能力；零装配归入 IR30-25、IR30-31。 |
| 规格 §1.4～§1.5 | 适用 | 标识映射、严格错误形态与稳定拒绝归入 IR30-04、IR30-09、IR30-14、IR30-20。 |
| 规格 §2.1 的 device identity/local domain | 适用 | 归入 IR30-04～IR30-05、IR30-26。 |
| 规格 §2.1 的 pairing/trust transition/迁居身份 | 不适用 | 本单元不改变设备信任或权威迁居。 |
| 规格 §2.2 的 PermissionLease、AuthorityCapability、Resource/DataPlane tickets | 适用 | 归入 IR30-14～IR30-17、IR30-25。 |
| 规格 §2.2 的 channel/transfer/recovery 票据 | 不适用 | 本地域 owner 不持这些能力。 |
| 规格 §2.3 的本机 SecretStore 消费 | 适用 | 归入 IR30-14。 |
| 规格 §2.3 的秘密迁移、§2.4 暴露面、§2.5 mesh bootstrap | 不适用 | 不迁移秘密，不新增 mesh/HTTP 暴露面。 |
| 规格 §3.1 SessionStatePort | 适用 | 全方法、mutation、guard、状态和恢复归入 IR30-08～IR30-10、IR30-24、IR30-33。 |
| 规格 §3.2 标题中的“本地域物理不装配” | 适用 | 构造、装配和调用的负向合同归入 IR30-03、IR30-25。 |
| 规格 §3.2 GlobalStatePort 正向方法、§3.2b DeferredGlobalIntentPort | 不适用 | 前者为 anchor 能力，后者是第 31 单元；当前不得持有端口、记录或入口。 |
| 规格 §3.3 | 适用 | EnvironmentPort、workspace binding 现行接缝与 readiness 归入 IR30-13。 |
| 规格 §3.4～§3.4b | 适用 | 本地域 root/child/usage/finalization 与同设备容量归入 IR30-06、IR30-15～IR30-16、IR30-20、IR30-22、IR30-27、IR30-30。 |
| 规格 §3.5 | 适用 | ControlCompletion/Reviewer、确认、evidence 和 advancement 归入 IR30-19、IR30-21～IR30-23。 |
| 规格 §3.6 conversation 分支 | 适用 | 本机 dispatch/abort/ledger/data plane 归入 IR30-17、IR30-19～IR30-20。 |
| 规格 §3.6 job 分支 | 不适用 | 不装配 job owner。 |
| 规格 §3.7 conversation/usage 分支 | 适用 | 准入、幂等、资源与终态归入 IR30-12、IR30-15、IR30-18～IR30-20。 |
| 规格 §3.7 job 分支 | 不适用 | 不属本地域 conversation owner。 |
| 规格 §3.8 | 适用 | session guard 与 global rejection 归入 IR30-04、IR30-09、IR30-24～IR30-25。 |
| 规格 §4.1 的 control/run/session-activity/publish/final-outbox | 适用 | 共享物理日志、独立逻辑流、原子性与重放归入 IR30-05～IR30-10、IR30-18～IR30-20。 |
| 规格 §4.1 的 intent/transfer 流 | 不适用 | 第 31～32 单元，当前不得创建。 |
| 规格 §4.2 | 适用 | ArtifactStore 内容寻址、所有权、恢复与 GC 归入 IR30-06、IR30-11、IR30-17。 |
| 规格 §4.3 的 session/control/run/governor/final 记录 | 适用 | 归入 IR30-07～IR30-20、IR30-22。 |
| 规格 §4.3 的 job/delivery/trust/intent/transfer 记录 | 不适用 | 当前不得生产；零可达归入 IR30-25、IR30-31。 |
| 规格 §4.4 的 session staged/commit 与零 global batch | 适用 | 归入 IR30-09、IR30-18、IR30-24～IR30-25。 |
| 规格 §4.4 的正向 global publish | 不适用 | 本地域 owner 无 GlobalState/global publisher。 |
| 规格 §4.5 | 适用 | 会话内容留存、引用、删除与重建归入 IR30-11。 |
| 规格 §5.1 conversation 请求 | 适用 | send/cancel/confirm/manage/window/metadata 归入 IR30-08～IR30-12、IR30-19。 |
| 规格 §5.1 job/global/transfer 请求 | 不适用 | 当前无对应入口。 |
| 规格 §5.2 conversation 派发 | 适用 | 归入 IR30-12、IR30-17、IR30-20。 |
| 规格 §5.2 job 派发 | 不适用 | 不装配 job owner。 |
| 规格 §5.3 | 适用 | manifest、capability、permission、environment 的执行前校验归入 IR30-13～IR30-17。 |
| 规格 §5.4 conversation 提交 | 适用 | CAS、ledger、usage、finality 与响应丢失归入 IR30-18～IR30-20。 |
| 规格 §5.4 job 提交 | 不适用 | 不装配 job owner。 |
| 规格 §5.5 conversation 状态/final | 适用 | 归入 IR30-07～IR30-10、IR30-18～IR30-20。 |
| 规格 §5.5 job/delivery 状态 | 不适用 | 本地域 owner 无 job/delivery。 |
| 规格 §5.6 data-plane/finality | 适用 | 同设备数据面、内容句柄、断线与恢复归入 IR30-06、IR30-11、IR30-17～IR30-18。 |
| 规格 §5.6 channel relay | 不适用 | 不装配渠道。 |
| 规格 §5.7 evidence 生成/消费 | 适用 | 归入 IR30-21～IR30-23。 |
| 规格 §5.7 current-owner transfer verifier | 不适用 | 第 32 单元生产启用。 |
| 规格 §6.1 conversation 状态机全部枚举行 | 适用 | 正常、确认、取消、重试、unknown、恢复与终态归入 IR30-07、IR30-12、IR30-18～IR30-20、IR30-33。 |
| 规格 §6.2、§6.2b job 状态机 | 不适用 | 不装配 job owner。 |
| 规格 §6.3 AuthorityTransfer 全部枚举行 | 不适用 | 第 32 单元；当前只由 IR30-25～IR30-26 验证 transfer 流/入口零可达。 |
| 规格 §6.4 UncertainResolution 句 | 适用 | conversation 的 `open → closed` 与 6.1 出边归入 IR30-18～IR30-20。 |
| 规格 §6.4 设备状态全部枚举行 | 不适用 | 属设备信任/角色配置，不由本单元改变。 |
| 规格 §7 的会话状态、会话内容、环境事实、执行资产、非权威缓存当前删除/保留边界 | 适用 | 只审本地域直接 owner、内容保留和只读缓存边界，归入 IR30-06、IR30-08～IR30-18、IR30-23～IR30-26。 |
| 规格 §7 的全局状态、AuthorityTransfer 与检查点备份列 | 不适用 | 属 anchor/第 32～35 单元；不得扩成当前迁移或备份门禁。 |
| 规格 §8 的 `session-send`、`environment-select`、`run-cancel`、conversation `uncertain-resolution`、`confirmation-*`、`conversation-*`、`task-list`、`advancement`、`workspace-binding` 接缝、`segment-transition`、`runtime-lifecycle`、`advancement-evidence`、`orchestration-child`、`light-inference` | 适用 | 当前内部生产/消费落点归入 IR30-07～IR30-24、IR30-29～IR30-33；workspace binding 只审既有端口接缝，不重审其 CRUD。 |
| 规格 §8 的 `session-observer` 公开入口 | 不适用 | 第 30 单元不开放公开本地 observer；内部 final/history 补读归入 IR30-08、IR30-18、IR30-31。 |
| 规格 §8 的 global/workscene/schedule/memory/skill/channel/status/runtime-config/device-trust 正向行 | 不适用 | 属 anchor、既有其他域或后续单元；本地域零入口/端口/副作用归入 IR30-25～IR30-26、IR30-31。 |
| 规格 §8 的 `shutdown` | 适用 | 仅 local owner 内部 stop/cleanup 归入 IR30-29～IR30-30；不新增公开 shutdown 入口。 |
| 规格 §9 的对话/run/取消/确认、task/segment/advancement 本地快照、只读 skill/rubric/prompt cache、内容资产、资源治理与 anchor 会话不可写行 | 适用 | 归入 IR30-14～IR30-26、IR30-33；cache 缺失按无匹配继续 local-draft。 |
| 规格 §9 的 memory 读副本、memory 写、schedule intent、全局 rubric 保存、workscene、channel/名录/迁居正向能力 | 不适用 | D30 明确排除 memory 副本与第 31/32 单元能力；当前只检查诚实不可用和零副作用。 |
| 规格 §10 本地域资源条款 | 适用 | root/child lease、usage、settle/release/reclaim、exact replay 与恢复归入 IR30-15～IR30-16、IR30-20、IR30-22。 |
| 规格 §10.1 共享 DeviceCapacityArbiter 直接接缝 | 适用 | 单一实例、并发与停机归入 IR30-06、IR30-16、IR30-27、IR30-30。 |
| 规格 §10.1 存储维护完整生命周期 | 不适用 | 上游既有能力，本单元不重审或扩建维护系统。 |
| 规格 §11 当前 internal-only 边界 | 适用 | 归入 IR30-31。 |
| 规格 §11 公开离线创建、发现、迁居与接管旅程 | 不适用 | 第 32 单元交付。 |
| 规格 §12 不变量 1～6、8～12、14～18 的本地域直接部分 | 适用 | owner fencing、幂等/栅栏、角色零加载、秘密、ID、conversation uncertain/dispatch、双拓扑、结构、staged 零外泄、安全、恢复和资源分别归入 IR30-02～IR30-33。 |
| 规格 §12 不变量 7、13 及其 channel/job/delivery 部分，8～10、16～18 的 transfer/job/channel/存储维护专属部分 | 不适用 | 不属于 D30；不得因枚举表扩建范围外能力。 |
| 规格 §13 | 不适用 | 到期表没有第 30 单元新增模块文档义务；本轮已改总纲/规格仍作为当前合同由 IR30-34 对账。 |
| 规格 §14 | 不适用 | 历史 S1 实施说明，不是当前合同。 |
| 规格 §15 第 2～5、9～13、15B～18、21～23、25、27～29 项的 D30 直接接缝 | 适用 | contracts、owner/runtime、日志/会话协议、权限/资源、数据面/内容、环境、advancement、session mutation 与 S7 门禁接缝归入 IR30-02、IR30-06～IR30-25、IR30-28、IR30-32～IR30-34；只审 D30 实际复用或改动部分。 |
| 规格 §15 第 1、6～8、14、15A、19～20、24、26 项及前行的非直接历史交付 | 不适用 | golden 基建、mesh/trust、job/delivery/channel 和跨机启用不由 D30 改变；其底层合同若被 D30 消费，已按 §1～§12 的具体条款归项，不重审历史单元。 |
| 规格 §15 第 30 项 | 适用 | 本地域 owner 实现、装配、隔离和验收归入 IR30-01～IR30-34。 |
| 规格 §15 第 31～38 项 | 不适用 | 后续单元，不得成为当前门禁。 |
| `unit-development-workbench.md` 静态目标/边界与 D30-01～D30-07 | 适用 | 七项生产、消费、边界和直接测试义务反向归入 IR30-01～IR30-34。 |
| 当前完整交付物 HEAD `b7d56ab8` 的 39 个路径 | 事实来源 | 36 个 D30 路径逐一归入 IR30-01～IR30-34；第 29 单元归档、本工作台和 `project-onboarding/SKILL.md` 三个流程/规则路径明确排除，不参与功能通过判定。 |

### 审查项

| 编号 | 状态 | 审查对象 | 有限审查范围与通过条件 | 证据记录 |
| ---- | ---- | -------- | ---------------------- | -------- |
| IR30-01 | [~] | 单元身份、边界与完整交付物 | 冻结当前 56 路径清单，确认其中 50 个是 D30 生产/测试/合同交付，5 个是工作台/归档状态，`project-onboarding/SKILL.md` 是单元外规则变更；D30 交付物不得含第 31～38 单元、公开离线产品能力或无依据框架。本项在路径归属二元落定后停止，义务映射留给 IR30-34。 | HEAD `b7d56ab8` 的 39 路径已逐项归属：36 个 D30 代码/测试/合同路径，unit-29 归档与本工作台为流程状态，project-onboarding 为用户明确授权的单元外 Skill 规则；未出现第 31～38 单元或公开离线入口。 |
| IR30-02 | [~] | domain-neutral owner 同构内核 | `ConversationOwnerRuntimeStack` 必须由 anchor/local 合同复用同一 owner-kernel、owner-services、协议、reducer、状态机和错误语义；差异只来自显式 authority/identity/capability 注入，不得复制内核或建立第二语义。 | `anchorConversationOwnerRuntime` / `localConversationOwnerRuntime` 共同注入 `ConversationProtocolRuntime`、`ConversationManager`、同一 SessionState adapter 与 owner-services；本地域差异集中在显式 domain、日志、资源与 capability 组合。 |
| IR30-03 | [~] | local owner 合同与物理隔离 | local 构造期只能持会话、环境、资源、内容与执行依赖；`GlobalStatePort`、DeferredGlobalIntent、global publisher、delivery、channel、transfer 均无字段、实例或可达调用，不能用空实现或运行时约定代替。 | P1 事实：local 类型虽把四项能力收窄为 `never`，共享 protocol 仍公开 `bindMutationPublisher`，并以 `globalPublishing` / `allowGlobal` 运行时分支关闭全局 mutation；现有 S7 只查接口声明，不能证明构造期物理不可达。 |
| IR30-04 | [x] | 本地域 canonical identity | conversationId 严格为 `local-<设备指纹载荷前 8 位>-<Ulid>`，localDomainId 为 `local:<deviceId>`；非法格式、跨设备、anchor id、路径/秘密混入及错域请求均在首个耐久/资源/I/O 副作用前拒绝。 | `scope-id.ts` 以唯一 Crockford ULID 判别和设备前缀构造/校验 local id，local runtime 在 journal 前执行设备反绑，anchor runtime 拒绝全部 local id；正反例覆盖 fingerprint、异设备和非法 ULID。 |
| IR30-05 | [x] | epoch、namespace 与逻辑流隔离 | ownerEpoch 与可恢复的 localGovernorEpoch 在正常重启中保持、只按各自合法重置前进；operation/attempt identity 及 control/run/session-activity/publish/final-outbox 流只属于本地域，anchor/local 不碰撞、不串流、不互相重放。 | 当前单元没有 domain reset 入口；正常重启由同一设备身份重建稳定 localDomainId/epoch，conversation id 与各会话流按 owner domain guard 过滤，anchor/local 不相互接纳或重放。 |
| IR30-06 | [~] | 共享设备基础设施与单一所有权 | local owner 复用 executor 已有的 AuthorityCommitLog、ArtifactStore、data plane、DeviceCapacityArbiter 与 shutdown 所有权，同时以逻辑流隔离事实；不得重复打开、重复治理或建立第二物理事实源。 | P2 事实：anchor+executor 根创建两个 `ConversationAssignmentLedger` 实例，违反单一 live owner；但两者复用同一 `FileAuthorityCommitLog`，同名 durable projection 被日志按 id 去重，读写经同一日志锁和流重放收敛，未证实此前所称的数据面漏读或耐久性失败。 |
| IR30-07 | [~] | 会话目录、创建与恢复 | internal create/list/lookup 的唯一耐久事实、线性化点、幂等键和投影闭合；空目录、重复创建、响应丢失、坏尾、恢复中崩溃与连续重启最终恰一会话，且恢复完成前不 accepting。 | P1 事实：SessionState control adapter 将 `conversationExists` 固定为 `true`；任意格式合法但未创建的 local id 可绕过目录存在性，在无 durable identity 时写入 session/lifecycle 权威记录，形成不经 create 线性化点的孤儿状态。 |
| IR30-08 | [x] | 完整 SessionState 读面 | meta、transcript/history、task-list、advancement、window、lifecycle、run/control/final 均从同一会话权威日志/投影读取；空值、分页、重放和重启全等，不降级为最小壳或 anchor 远程读。 | `ConversationSessionStateAdapter` 的 meta/transcript/task-list/advancement 与 mutation 读回均接同一 protocol journal；local history、directory 和 advancement consumer 复用该端口，分页与重启 smoke 读取同一 executor log。 |
| IR30-09 | [~] | SessionState mutation 与 guard | SessionStatePort 的 meta、window、task-list、segment、advancement、rename、compact、clear、delete 写分支共用 domain、ownerEpoch、revision、stream、principal 和严格 codec 守卫；错域、stale、畸形、重复与并发请求零副作用且终态确定。 | P1 事实：判别联合、principal/revision/stream guard 已复用，但 control mutation 的存在性回调恒真，使未知 local id 的 meta/window/task/segment/advancement/lifecycle 写可在首个 append 前绕过目录 guard。 |
| IR30-10 | [~] | 创建后会话生命周期线性化 | rename、compact、clear、delete 的状态组合、冲突排序、投影与恢复闭合；关闭/删除后不再准入或复活，效果后响应丢失和并发管理请求按稳定身份幂等收敛。创建与目录恢复只由 IR30-07 判定。 | P1 事实：已存在会话的 reducer/投影与幂等请求链可恢复，但未知 local id 的 clear/delete 同样因恒真存在性回调落下 lifecycle 事实或 tombstone，生命周期不再严格从目录 create 之后开始。 |
| IR30-11 | [~] | 内容资产、保留与 finality | transcript/artifact/evidence 由同一 ArtifactStore 与日志引用闭合；缺失、重复、引用回收、投影滞后、写后崩溃、读取校验和重建不产生假终态、悬空引用或跨域可见。 | P1 事实：local assembly 未注入 `onFinal`；`publishPendingFinals` 因此直接返回 0，已提交 revision 的 final-outbox 永不推进到 published/expired，内容终态在恢复判据中永久欠账。 |
| IR30-12 | [x] | ingress、准入与幂等 | internal send/admit/assign 反绑 local conversation、ownerEpoch、operation identity、环境与权限；重复、乱序、断线、响应丢失和恢复只产生一个 accepted run，错域请求零资源/执行副作用。 | local manager 通过同一 durable protocol 准入，run/assignment 身份由 conversation+attempt 稳定派生；设备 id guard、admission journal 与响应丢失重放先于资源派发，local smoke 证明一次执行和重启零第二 run。 |
| IR30-13 | [~] | 环境、workspace binding 与 readiness | 本地域环境选择与 manifest 只消费现行 EnvironmentPort/WorkspaceBinding 接缝；无 workspace、缺失/过期/冲突 binding、准备失败、重启和 stop 竞态均有确定终态，完整 runtime 未 ready 不得派发。 | `prepareLocalConversationAssignment` 将 workspace 限定出生设备并反绑 executor snapshot 的 binding revision，能力/凭据/manifest 全等后才返回；local owner 在 protocol/readiness/advancement recovery 后才 accepting。 |
| IR30-14 | [~] | 权限、ControlLease 与秘密 | local 会话只读最近有效的 anchor 签名权限/执行资产缓存并使用 local ControlLease；过期、错设备/scope、缺权限 cache、验签失败均 fail-closed，allow-once 只接受已认证原始 surface 且逐次线性化，秘密/路径不上 wire 或错误日志。 | 本地域只从签名快照目录取 latest，缺失或请求规则不全等即 capability-gap；签发的 PermissionSnapshotLease/ControlLease 反绑 local conversation、assignment、executor 与 expiry，executor 在 received 前按 digest/签名验权。 |
| IR30-15 | [x] | local root lease 与计量 | 每个 local run 的 root lease 绑定 localDomainId、ownerEpoch、可恢复 localGovernorEpoch；reserve/consume/settle/release/reclaim 由本地 governor 唯一拥有，不依赖 global budget、不产生 anchor usage debt，重放不重复计量。 | local runtime 把 root/usage/finalize 全部指向 executor governor，lease 反绑 localDomainId/localGovernorEpoch 与 conversation ownerEpoch；`finalizeLocalAssignment` 不经过 anchor governor，exact replay 与错域拒绝有直接 governor 证据。 |
| IR30-16 | [x] | child resource 与设备容量 | nested/并发 child 在父租约与共享 DeviceCapacityArbiter 下有界运行；provider 提前结束、abort、timeout、open usage、子先父后、崩溃与停机最终零 active child/root/permit。 | 本地域复用同一 executor governor 与设备容量 workload；现有 descendant deepest-first finalizer、open usage 对账、超深/超额拒绝、重启重建和 exact terminal replay 直接覆盖 local root 的共享协议。 |
| IR30-17 | [~] | 本机 dispatch、ledger 与数据面 | local run 只派到出生设备 executor，复用 execution ledger/data plane；manifest、permission、environment、lease 全通过后才执行，重复 dispatch、断线、executor 重启和 payload 缺失按同一 attempt 收敛。 | dispatch、ticket 与 data-plane 均使用同一 executor log；第二 ledger 的缓存游标通过 `transactProjection` 从共享日志补齐，未发现本地域 durable activation 对已绑定 ledger 不可见。双实例的 owner 分裂作为 P2 归入 P30-01。 |
| IR30-18 | [~] | run commit、CAS 与 finality | assistant output、usage、session mutation 与 run terminal 按现行线性化顺序提交；stale revision、半提交、响应丢失、exact replay、投影滞后和连续恢复最终恰一可见终态。 | P1 事实：run/session/usage 提交仍由共享 journal 原子化，但 local 没有 final consumer，pending final 无法进入终态；重启的 `discoverRecoveryConversations` 持续把该 commit 判为未收敛，不能形成恰一完整可见终态。 |
| IR30-19 | [~] | 取消、确认与竞态 | user/system cancel、confirmation request/read/resolve 反绑 local run/attempt/权限；重复、错绑、迟到确认与取消/provider 终态竞态有唯一胜者、零多余执行和可恢复终态。 | P1 事实：local port 只暴露 manager/protocol/advancement，assembly 未装 ConfirmationHub、status consumer 或 interaction answer 边界；protocol 自身没有公开 answer 方法，故本地域产生确认后没有当前 internal conformance 消费链可提交 resolve。 |
| IR30-20 | [~] | uncertain 与三方恢复 | owner、executor、ledger 对 assigned/running/committing/uncertain 的判定与重驱一致；已封包只重提交，可证未 started 才新派发，结果不明只写 open→closed resolution，任一点崩溃、坏尾、连续重启或 stop 不重复 provider、不泄漏资源。 | P1 事实：三分恢复代码由同一 protocol/ledger 复用，但 local committed run 因 final-outbox 永不终态会在每次启动重新进入恢复集合；ledger 双实例经共享日志可见，不再作为本项阻断事实。 |
| IR30-21 | [~] | owner-services 完整装配 | ConversationManager、ConversationProtocolRuntime、advancement controller、reviewer/evidence client 与 advancement recovery 均复用现行生产实现并取得真实依赖；不得以测试 stub、空 adapter 或跳过任一 consumer 形成表面可启动的残缺 owner。 | P1 事实：manager/protocol/advancement/reviewer/evidence/recovery 均为生产实现，但组合根跳过 mandatory local final/interaction consumer，并以 `rubricScope:"local"` 直接省略只读 rubric catalog，形成可启动但终态与缓存能力不完整的 owner。 |
| IR30-22 | [~] | advancement、review 与资源收敛 | advancement 在 local owner 下复用 canonical evidence、review attempt、local governor 与 SessionState；deferred/throw、typed stale、capability-gap、响应丢失、重复、崩溃和恢复不重复计量或遗留 root。 | P1 必要证据缺口：组合根虽注入真实 SessionState、local governor 与同机 evidence client，但没有任何本地域 advancement/review/evidence/lease 的直接执行与恢复测试；现有 anchor 单测不能证明 local domain、缓存与 consumer 差异下仍收敛。 |
| IR30-23 | [~] | local-draft 与只读缓存语义 | skill/rubric/prompt 缓存只读且按冻结版本消费；缓存缺失/过期/无匹配时 local-draft 仍继续并立即在会话生效，不能被误判为阻断；全局保存、刷新或假成功明确不可用，权限 cache 失败另由 IR30-14 fail-closed。 | P1 事实：local advancement 通过空配置同时移除 `GlobalRubricCatalog` 与 publication，却没有注入任何 S4 skill/rubric/prompt 只读 cache/ArtifactStore consumer；离线只能新生成 local-draft，合法同步资产在本地域完全不可见。 |
| IR30-24 | [~] | session-only mutation profile | task-list、segment、advancement、meta、window 五类执行侧写只进入当前 local SessionState；operation identity、read-own-writes、冲突和重放与 anchor 同构，不生成 Global MutationBatch 或 DeferredGlobalIntent。 | local protocol 使用同一 SessionState reducer/stager；`allowGlobal:false` 在 ledger append 前拒绝 global union，session 五类写保留 operation identity、overlay/read-own-writes 与 CAS 重放，直接负例证明全局写零 ledger 追加。 |
| IR30-25 | [~] | 全局能力负向闭包 | memory、skill/workscene/schedule 全局写、global registry/query/publish/delivery、permission persist、channel、DeferredGlobalIntent、transfer 的构造、端口、RPC/CLI/tool 入口均不可达；禁用发生在日志、资源与 I/O 副作用前。 | P1 事实：当前实例未注入 GlobalState/delivery/channel/transfer，公开注册源也为零；但 local 仍持有包含 global 分支的共享 protocol/mutation port，只靠布尔值在运行时拒绝，未满足冻结的 by-construction 安全合同。 |
| IR30-26 | [x] | anchor 会话与设备域隔离 | anchor 不可达时不得枚举、接管、写入或伪造 anchor 会话；本设备 local 会话不被其他设备或 anchor namespace 消费，列表、恢复与路由保持域隔离，且不建设可选离线副本。 | anchor runtime 明确拒绝 local id，local runtime 只接受出生设备前缀；目录/recovery 对共享 log 再按 `acceptsConversationId` 过滤，local 组合无 anchor directory、远端 execution 或离线副本入口。 |
| IR30-27 | [~] | 生产 topology 恰一装配 | 对 `planServeTopology` 的八种受支持配置核对两条生产根：anchor+executor（含 surface 等价配置）经 `access-surfaces.ts`、executor-only 经 `runExecutorRole` 各恰一 local owner；anchor-only/surface-only/disabled 为零，重复注册或缺依赖确定失败。 | P1 必要证据缺口：源码两根的条件分支可推出 executor-enabled 恰一 owner，但新增测试只覆盖一个 mock anchor+executor 与无 executor，不覆盖 executor-only、surface 等价、八配置、重复启动及缺依赖；无法安全证明真实拓扑 exact-set。 |
| IR30-28 | [~] | 包依赖与结构隔离 | 装配只沿 cli→owner-kernel/owner-services/executor/runtime-host/core 正式边；server 不反向依赖 executor，owner 层不取得 CLI/global Store，新增 exports 不暴露实现细节或形成环。 | 新增生产实现集中在 cli 组合根，owner-kernel/core/executor 仅扩展正式合同与原语；server 只提供既有 owner-services adapter，未反向导入 executor，package manifests 与 S7 结构边未出现新环或 CLI 下沉。 |
| IR30-29 | [~] | prepare/start 与失败回滚 | 两生产根均须先取得 executor log、ArtifactStore、local governor、完整 runtime/readiness、data plane/evidence 依赖，再依次恢复 session 目录、assignment、final-outbox 与 protocol readiness，完成 advancement recovery 后启动 recovery loop，最后 accepting；任一步失败、重复/并发 start 或 shutdown 介入均逆序回滚，无半活 owner。 | P1 事实：依赖检查、rollback 注册及 accepting 顺序存在，但 final consumer 缺失使启动恢复无法收完 final-outbox 仍进入 accepting；且没有任一生产根的部分失败/并发 start/连续恢复直接证据。 |
| IR30-30 | [~] | stop、cleanup 与后台归零 | stop 先拒绝新准入，再收束 run/confirmation/final-outbox/recovery loop，最后按依赖逆序 dispose；重复 stop、部分失败和进程关闭最终零 timer/listener/permit/root/可写入口。 | P1 事实：close 会先停 recovery loop 并 dispose manager，但不会终结 pending final-outbox，故“outbox 与执行义务归零后关闭”不成立；ledger 双实例只构成非阻断的所有权分裂。 |
| IR30-31 | [~] | internal-only 与产品边界 | 只暴露组合根内部/conformance port；不得注册公开 CLI/RPC/channel/status/session-observer、离线 create/list/adopt、产品术语或隐式 fallback，现有 anchor 用户路径和错误语言不改变。 | local owner 只挂在 cli 内部 assembly/context，port 未进入 canonical RPC、Commander、dynamic skill、channel、status 或 presenter 注册源；现有 anchor 用户入口与错误语言未增加离线 fallback。 |
| IR30-32 | [~] | S7 入口/结构门禁交界 | `localConversationOwner.close` cleanup descriptor 进入现有 capture/golden，local runtime/assembly 两个生产源由现有 S7 结构规则证明 global capabilities 不可达；不得新增第二 lint、改变入口映射语义或遗漏真实 cleanup owner。 | P1 事实：cleanup key 已进入 capture/golden；但 `inspectLocalConversationOwnerIsolation` 只检查两个 interface 的属性名/类型与 owner 参数名，不扫描实际 import、constructor、instance、binder 或调用，加入真实 GlobalState/DeferredIntent/global Store 仍可绿色通过。 |
| IR30-33 | [~] | 双域同构 conformance | 同一有限套件比较 anchor/local 的 create/list/meta/history/window/rename/compact/clear/delete、run/cancel/confirmation/uncertain、task-list/segment/advancement、content/final、replay/recovery/stop；允许差异仅为 authority/identity/capability/cache，无 workspace 与 workspace 两形态均覆盖。 | P1 必要证据缺口：交付物没有同一套件驱动 anchor/local；新增 local 测试仅覆盖一次 run、少量 SessionState 与重启，未覆盖 cancel/confirmation/uncertain/advancement/content-final/stop、workspace 双形态及故障矩阵，现有生产缺陷正位于这些空白。 |
| IR30-34 | [~] | 开发义务、合同与路径反向闭包 | D30-01～D30-07、总纲本地域当前段、规格当前条款和 50 个 D30 路径必须双向全等：每项有生产端、消费端、装配、异常/恢复和直接证据落点，每条实现路径有当前架构依据；不存在未归项义务、范围外实现或历史/未来文字冒充现行合同。 | P1 事实：36 个 D30 路径均有来源，但 terminal consumer、只读资产 cache、构造隔离及双域/拓扑/故障证据没有完整落点；单一 ledger 另构成 P2 所有权偏差。不存在范围外未来功能，缺口均属当前冻结义务。 |

> 本轮全部 `[~]` 行的原证据统一标为失效，只保留为历史事实；下一轮必须基于当前 50 个交付路径重新记录结论。`[x]` 行的登记输入与本轮修改无直接交界，原证据继续有效。

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
