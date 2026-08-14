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

只更新动态区中的单元数据；固定标题、顺序、状态协议、表头、问题列表空表及原有格式必须原样保留，不得重排、改名或重建骨架。

先枚举全部规范来源，并逐章判定“适用”或“不适用”；适用章内的规范性条款和枚举行逐条归入审查项，不适用项写明事实依据。再沿当前交付物的完整功能链核对生产端、消费端、共享原语、装配与拓扑、状态生命周期、异常恢复，以及适用的边界条件、非默认场景、并发、安全、资源、兼容性和验收证据，拆成范围有限、可独立判定并能记录证据的审查项。

存在未判定来源、章节、条款、枚举行或功能链，存在范围遗漏、越界、重复、含糊或无法独立判定的条目，或架构不足以确定审查边界时，清单不得定稿；架构空洞必须明确登记，不得用实现假设补齐。

完成后核对固定骨架与原格式，发现漂移恢复原样。

本任务只生成并定稿审查清单，不执行审查，不修改实现；完成后立即停止。
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
目标：只收敛第 38 单元正式问题列表中同根重开的 U38-01 一个 P0/大、U38-02 一个 P0/中、U38-04 与 U38-08 两个 P1/中、U38-07 一个 P2/小和新增的 U38-09 一个 P1/小，使六项真正命中 existing-install 安全切版与安装级反降级、ProgramStore/lifecycle achieved phase 与真实 health 终态、current-authority 更新可见性/离线回退、五目标 target-local 发布证据、SemVer 2.0 precedence 及 FileLock PID-reuse 活性根因，并具备可由执行者一次实施的最优方案与完整验收条件。不修改实现，不运行构建或测试，不审查其他问题；U38-03、U38-05、U38-06 与 EX38-01～EX38-02 的既有结论直接复用，既有五目标程序树、delivery admission/sealed、health snapshot identity、有限工件资源策略、workspace gate/固定 50 id 等已验证边界不得恢复或扩面；价值裁决否定的当前 v1 schema activation、任意 2 GiB 流式框架、installer 第二 lifecycle、通用事件/轮询、cryptographic attestation、通用 runner、租约服务、第二事实源及范围外发布能力不得并入本单元。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第 38 单元正式文件中的 U38-01、U38-02、U38-04、U38-07～U38-09、EX38-01～EX38-02，只依据六项最新事实、价值裁决、方案、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词完成条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 按 `U38-01 → U38-02 → U38-04 → U38-08 → U38-09 → U38-07` 从权威架构、规格和当前生产调用图重建事实链，核准 installer/current/receipt 与 upgrade lifecycle、stage/version/pointer/phase/health、receipt/current-authority/connection、target evidence/release gate、SemVer producer/consumer 及 FileLock token/PID/heartbeat 的唯一事实源、稳定 identity、线性化点、消费者、异常终态、当前损失、受影响审查项、评级和工作量；同根内容必须合并，历史修复与价值裁决未被新生产事实触发时不得恢复旧评级、旧方案或扩面。
2. 穷尽直接变体：U38-01 覆盖五 target 的 first/replay/existing update、无 home、旧 sequence、同 precedence 冲突、pointer/receipt 各响应窗口；U38-02 覆盖 stage/version/current/previous、两根三形态、activate/health/terminal 各窗口与连续重启；U38-04 覆盖后台变化、断线/换代、authority unavailable、离线 doctor、lock busy 和 success/action 消费；U38-08 覆盖五目标 OS/arch、候选 bytes、十二 smoke、摘要漂移与重放；U38-09 覆盖 SemVer core、prerelease、build metadata 和所有排序消费者；U38-07 覆盖 live/crashed owner、PID reuse、heartbeat fresh/stale 与 stale release。每格必须指出稳定 identity、唯一事实、效果排序、零副作用边界、消费终态和直接验收；无法解释即继续修正根因。
3. 以锁定范围内最优架构审查方案：U38-01 只把 existing update 送入既有 RPC/lifecycle 并以 verified current+receipt 高水位分类；U38-02 只让现有 phase 消费 exact achieved read-back 和激活后的真实 loopback health；U38-04 只增加 update 方法域窄通知、明确 unavailable 与 effect-free local fallback，busy 不写失败；U38-08 只给现有 release scripts 增加固定 target-local evidence producer；U38-09 只修正共享比较器的 SemVer 2.0 precedence；U38-07 只让现有跨进程活性谓词同时要求 PID 存活和 heartbeat 新鲜。方案必须用最少文字说清改什么、怎么改、关键边界及完成判据；不得新增第二事实源或前述已否定框架。发现缺口时直接修正对应原问题，使执行者无需实现猜测即可一次完成。
4. 六项看似闭合后，对同一份未修改问题列表执行四路冷启动对抗复审：installer/反降级与 phase/health 恢复，current-authority 可见性与锁终态，五目标证据与 SemVer 发布身份，生产体验/范围价值及历史裁决边界。各路必须抛开前轮结论主动构造第 2 步反例，并核查 `U38-01↔U38-02`、`U38-04↔U38-07`、`U38-08↔U38-09`、六项与 U38-03/U38-05/U38-06、EX38-01～EX38-02、第 30～37 单元合同及范围外发布能力的直接交界；发现真实反证则修正原记录并重新执行四路复审。

只有现有架构无法唯一推出方案，且选择会显著改变产品需求、用户体验、成本或单元边界时才暂停；其余架构选择按整体最优且不留债务自主收敛。

完成条件：同一份未修改问题列表通过四路冷启动对抗复审；六项的全部受支持安装更新、逐 phase 恢复、状态可见/离线消费、五目标真实证据、版本排序及锁接替变体均被根因完整解释，影响面无遗漏，评级与工作量有事实依据，方案和验收可直接执行，不恢复已验证边界或扩建通用框架。满足后明确回复“U38-01、U38-02、U38-04、U38-07～U38-09 的根因与最优方案已闭合”并立即停止。

完成任务之后，根据最新问题情况，把“目标模式：解决问题并完成多角色对抗收口”提示词内容改成本次的问题，格式、规则不变；
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
目标：彻底解决第 38 单元正式问题列表中同根重开的 U38-01 一个 P0/大、U38-02 一个 P0/中、U38-04 与 U38-08 两个 P1/中、U38-07 一个 P2/小和新增的 U38-09 一个 P1/小，闭合 existing-install 安全切版与安装级反降级、ProgramStore/lifecycle achieved phase 与真实 health 终态、current-authority 更新可见性/离线回退、五目标 target-local 发布证据、SemVer 2.0 precedence 及 FileLock PID-reuse 活性的全部同根直接变体；不得扩展到其他问题或全单元流程。U38-03、U38-05、U38-06、EX38-01～EX38-02与第30～37单元既有合同直接复用，既有五目标程序树、delivery admission/sealed、health snapshot identity、有限工件资源策略、workspace gate/固定50 id等已验证边界不得恢复或扩面；价值裁决否定的当前v1 schema activation、任意2GiB流式框架、installer第二lifecycle、通用事件/轮询、cryptographic attestation、通用runner、租约服务、第二事实源及范围外发布能力不得实施。

首个动作及每次续跑或历史压缩后的首个动作：读取《单元审查与修复工作台》及第38单元正式文件中的U38-01、U38-02、U38-04、U38-07～U38-09、EX38-01～EX38-02，只依据六项问题最新的根因、价值裁决、F38-09～F38-14固定矩阵、C38-C04～C38-C07反证账、最优方案执行合同、验收条件和状态继续。

进度反馈：首次读取状态后报告一次整体进度；此后每完成一个实质阶段、进入等待或暂停以及用户询问时，用百分比报告距离本提示词结束条件的整体进度，并用一句话说明已完成、当前和剩余。不得以单轮、单项或测试命令的进度冒充整体进度，不得为汇报而中断工作或重复检查。

持续执行：

1. 修复前从权威架构、规格与当前生产调用图重建F38-09～F38-14固定矩阵。U38-01覆盖五target的first/replay/existing update、无home、旧sequence、同precedence冲突、pointer/receipt各窗口；U38-02覆盖stage/version/current/previous、两根三形态、activate/health/terminal各窗口与连续重启；U38-04覆盖后台变化、断线/换代、authority unavailable、离线doctor、lock busy及success/action消费；U38-08覆盖五目标OS/arch、候选bytes、十二smoke、摘要漂移与重放；U38-09覆盖SemVer core、prerelease、build metadata和全部排序消费者；U38-07覆盖live/crashed owner、PID reuse、heartbeat fresh/stale与stale release。逐格绑定installer/current/receipt、operation/phase/pointer generation/health、current-authority/connection、target report/release gate、release identity与FileLock token/PID/heartbeat，唯一耐久事实、线性化点、资源上界、零副作用终态和直接证据，并持续核对U38-03/U38-05/U38-06、EX38-01～EX38-02、第30～37与范围外发布边界。
2. 按`U38-01 → U38-02 → U38-04 → U38-08 → U38-09 → U38-07`一次完成。先让正式installer写前同时验真current manifest/pointer与程序根外installation receipt：SemVer precedence与sequence仅同向严格递增才允许升级，全等identity才允许重放，其余相等/交叉/冲突均零程序写；first/exact replay保留既有直接安装，existing update只stage并经本机认证current-host连接或既有按需宿主调用`server.update.prepare`，禁止直接切pointer或覆盖运行中bootstrap。只有exact lifecycle upgraded terminal与current全等才提交receipt；pointer领先只能由同operation active/terminal历史补齐。

   随后让现有ProgramStore/DeviceLifecycleJournal每phase先消费exact achieved read-back；稳定launcher在child退出后只响应新的`current.json` generation并spawn该exact version。anchor/executor以gates closed装配，在同一bound server激活router但尚未ready/开放业务时做真实loopback health；target健康才terminal/release/ready，失败恢复exact previous pointer并退出，launcher接力previous且previous同样健康后才rolled-back terminal/release/ready。不得增加phase、协调器或installer第二lifecycle。

   current-authority方法域复用现有notification：`server.update.status`成功后登记authenticated exact connection，receipt或会改变投影的lifecycle durable变化只发无事实载荷`server.update.changed`，close/换代同代移除；surface初连、通知、换代后重读同一status。内部投影分available-empty/visible/unavailable；doctor仅在topology证明本机current authority时走同一effect-free本机builder，否则诚实unavailable；program-lock busy返回当前receipt且零失败写。

   在现有release-tooling固定十二行`scenarioId→正式入口/参数/终态谓词`，新增单一target-local evidence producer：从真实OS/arch推导target，在隔离program root/home穿过正式installer/launcher/update/doctor/app-remove/device-remove，读取最终signed manifest/artifact并仅由真实终态原子生成canonical report；producer/tooling/check脚本、release guide和ledger同入source fingerprint，`release:check`复验五目标、digest、外部签名/公证及执行前后输入。让release codec与`compareReleaseSemver()`共用窄SemVer parser，以十进制字符串比较任意长度数字、严格prerelease规则、build不参与precedence，raw version继续作exact identity。最后保留FileLock同进程token优先，跨进程active改为`PID live && heartbeat age<=staleMs`，stale仍须取得现有reclaim claim并全等重读token+age，release继续compare-token。同步直接相关架构、规格、发布指南、ledger、必要派生资产和直接测试；禁止第二事实源、通用事件/轮询/runner/租约/lifecycle/诊断框架及范围外发布能力。
3. 按验证手册运行受影响闭包的最小必要类型检查、五目标existing installer/反降级、ProgramStore逐phase与两根真实health、current-authority通知/离线doctor/busy终态、target-local十二smoke证据、SemVer规范向量及FileLock双进程直接合同和场景测试，核对必要派生资产；源码有变时按项目常驻规则取得一次同输入构建证据。真实反例必须穿过production installer/ProgramStore/lifecycle/稳定launcher、真实bound server/loopback、connection registry/mesh relay/topology、五目标release producer/check及core FileLock，直接注入pointer/receipt错位、各sync/响应丢失、坏target/previous、断线换代、错target/摘要漂移、超安全整数、PID reuse与连续重启；不得以mock自报installed/healthy/current-authority/passed/active或只验证返回值，不得运行包全测、模块回归、target×故障笛卡尔积或无关验证。失败先归因，实现问题直接修复并回到第2步。
4. 验证通过后冻结当前交付物指纹，整轮只读逐格重建六项事实链；测试通过不得代替功能判断，F38-09～F38-14全部完成后才统一归并。随后对同一指纹执行四个相互隔离的冷启动对抗角色：installer/反降级与phase/health恢复、current-authority可见性与锁终态、五目标证据与SemVer发布身份、生产体验/范围价值及历史裁决边界。各角色须抛开既有结论主动重造第1步全部适用反例，并核查`U38-01↔U38-02`、`U38-04↔U38-07`、`U38-08↔U38-09`、六项与U38-03/U38-05/U38-06、EX38-01～EX38-02、第30～37单元和范围外发布能力的直接交界。
5. 新发现首次出现即以C38-C08起的稳定编号写入正式问题证据与反证账；收口前对C38-C04～C38-C07、历轮反证、专项审查和四路记录做差异审计，每项只能以“同根合并”“当前源码证伪”或“修复后复核通过”关闭。发现真实反证时先修正对应问题的根因、方案、验收和F38矩阵，再回到第2步；任何交付物修改都会使冻结指纹与对抗结论失效。

结束条件：同一冻结指纹上的六项方案全部落地，受影响闭包的最小必要验证通过，专项功能审查与四路冷启动对抗均留下完整矩阵；C38-C04～C38-C07及新增同根反证全部有耐久处置，证明五目标existing update只经既有lifecycle安全切版且安装级高水位不倒退；stage/version/current/previous逐phase只补未达效果，target/previous均由稳定launcher接力并经真实health后才ready；current-authority状态变化在线可见、离线身份诚实、busy零失败写；五目标十二smoke由真实target-local运行生成且所有输入反绑；SemVer producer/consumer precedence唯一；FileLock在PID reuse后恰一接替且零误删。U38-03/U38-05/U38-06、EX38-01～EX38-02与第30～37单元结论不变，范围外发布能力未实施，六项均更新为“已验证”。满足后明确报告“U38-01、U38-02、U38-04、U38-07～U38-09 六项问题已彻底解决”并立即停止；不得进入全单元终审或单元提交验证。

完成任务之后，执行“修复后更新独立审查清单状态”：凡受本轮生产实现、公共合同或直接测试变更影响的 `[!]`、`[x]` 节点一律改为 `[~]` 并作废旧证据，未受影响的 `[x]` 保持不变；修复验证、问题“已验证”、专项功能审查或多角色对抗通过均不得直接产生 `[x]`。若本轮修改了生产文件却没有任何受影响节点变为 `[~]`，立即停止并报告状态映射错误。
```

## 审查清单

### 当前状态

- **当前单元**：第 38 单元 · generation 1
- **单元身份**：S10 升级兼容、稳定自动更新、五目标发布与模块最终验收；只交付当前 stable 通道、既有三种本机运行形态的安全更新与有限恢复、应用移除、离线诊断、旧路径退役和固定发布门禁。
- **权威来源**：distributed-runtime-charter.md、always-online-and-local-execution-requirements.md、specification.md、s2-security-supply-chain-review.md、release-and-maintenance-guide.md、已定稿 D38-01～D38-10，以及第 30～37 单元已封版的 owner、transfer、checkpoint、trust、exposure、supervisor、stop 与 removal 合同。
- **交付基线**：当前工作树中的 Unit38 完整生产实现、直接测试、发布脚本、生成资产、最终验收账与文档；历史问题、开发勾选、专项修复验证和多角色对抗不得替代本轮独立判断。
- **生产装配关系**：五目标 release index/manifest/artifact 经 installer、ProgramStore 与 update controller 进入 anchor/executor/foreground 三种本机 host；升级复用既有 device lifecycle、accepted-work/delivery、supervisor 与 bound server health，CLI/server/doctor/surface 只消费 ProgramUpdateReceipt 的 current-authority 投影；release:check 汇总固定五目标、smoke 与 50 行最终验收证据。
- **目标提交边界**：稳定发布身份与反降级、程序工件/指针耐久、异步自动更新、安全切换与有限恢复、两根 candidate health、公开状态与离线行动、应用移除保留数据、五目标真实工件和固定最终门禁。
- **明确排除**：自动 failover、quorum、多活、全局或持续同步、恢复应用；多发布通道、灰度和企业策略；独立 updater daemon；远程批量管理和应用商店分发；通用 updater、lifecycle、manifest、storage、secret、诊断或遥测框架；benchmark、内部诊断采集；真实私钥、商店账号和外部发布动作。以上事项均无当前单元必要性，不构成提交门禁。
- **架构空洞判定**：总纲、规格 Unit38 补充、release guide 与 D38-01～D38-10 已唯一确定当前产品行为、事实源、阶段顺序、恢复边界、用户可见性和发布门禁；本轮发现的是实现与证据未满足既定合同，不是需要用户补充产品选择的架构空洞。
- **状态约定**：[ ] 未审；[x] 已完成且无 P0/P1；[!] 存在 P0/P1；[~] 输入变化须重审。

> **清单状态**：0 项 `[ ]`、3 项 `[x]`、0 项 `[!]`、28 项 `[~]`；六项正式问题已完成修复，但生产实现、公共合同、直接测试及规范输入发生变化，受影响节点旧证据统一作废并等待下一轮独立重审；IR38-05、IR38-23、IR38-26 的登记输入未变，继续复用。

### 来源覆盖

| 来源 | 章节或枚举 | 适用性判定 | 审查项落点 |
|---|---|---|---|
| research/design/modules/distributed-runtime/distributed-runtime-charter.md | 当前版本交付原则、架构总览、需求浓缩、§1 | 适用；规定最小完整产品、S10 身份、稳定升级和本地优先总边界 | IR38-01、IR38-02、IR38-08、IR38-31 |
| 同上 | §2～§3 角色、包与依赖 | 适用到本单元装配交界；不重审冻结角色内部实现 | IR38-06、IR38-07、IR38-29、IR38-31 |
| 同上 | §4 mesh 与安全、§10 凭据和服务生命周期 | 适用；升级必须维持认证、SecretStore、supervisor 和生命周期合同 | IR38-06、IR38-12～IR38-15、IR38-18、IR38-21 |
| 同上 | §5～§9 权威、运行、环境、数据控制、离线与转移 | 仅冻结合同交界及最终验收适用；内部功能已由第 30～37 单元封版，本单元不得重做或扩面 | IR38-05、IR38-12～IR38-18、IR38-26～IR38-29 |
| 同上 | §11 产品体验、§12/§12.1 故障与恢复、§13 十八项不变量、§14～§15 顺序与验收 | 直接适用；全部规范性枚举必须进入最终提交判定 | IR38-08、IR38-11、IR38-16、IR38-19～IR38-30 |
| research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md | I～VI 问题、信息、事实、分析、总结与用户想法 | 作为已裁定的产品背景适用，不产生独立未来功能 | IR38-01、IR38-08、IR38-19～IR38-22、IR38-30 |
| 同上 | VII 价值结论 | 直接适用；自动更新可见、应用移除与永久设备移除分离、高熵配对为当前体验合同 | IR38-06、IR38-08、IR38-11、IR38-19～IR38-22、IR38-30 |
| 同上 | VIII 职责迁移要求 | 仅上游冻结合同交界适用；迁移和恢复应用本身不在本单元新增 | IR38-12、IR38-13、IR38-18、IR38-26～IR38-29 |
| research/design/modules/distributed-runtime/specification.md | §1.1～§1.5 时钟、规范字节、导入、符号、映射和公开错误 | 直接适用到发布身份、签名、严格解码、时间和公开行动 | IR38-02～IR38-05、IR38-11、IR38-19、IR38-20 |
| 同上 | §2.1～§2.5 身份、信任、SecretStore、暴露与 mesh | 适用到升级保留、安全供应链、协议兼容和移除边界；不新建第二事实源 | IR38-05、IR38-06、IR38-15、IR38-18、IR38-21、IR38-22、IR38-28 |
| 同上 | §3.1～§3.8 端口 | 上游端口语义不重新设计；本单元消费、装配、失败和恢复交界适用 | IR38-08、IR38-12～IR38-19、IR38-21、IR38-29、IR38-31 |
| 同上 | §4.1～§4.5 存储模型、提交日志、工件、流、批次与回收 | 直接适用到耐久 schema、升级 receipt、程序工件、指针、清理和最终不变量 | IR38-04、IR38-05、IR38-10～IR38-17、IR38-26 |
| 同上 | §5.1～§5.2、§5.4～§5.7 控制、提交、状态、流与证据 | 冻结生产合同交界及最终验收适用 | IR38-11～IR38-19、IR38-26～IR38-29 |
| 同上 | §5.3 版本与能力匹配 | 直接适用；current、candidate、previous 和远端 peer 的兼容判定是升级门禁 | IR38-02、IR38-05、IR38-15、IR38-16、IR38-18 |
| 同上 | §6.1～§6.4 状态表 | 上游状态机内部已冻结；本单元必须验证升级前后状态与生命周期交界不破坏终态 | IR38-12～IR38-18、IR38-26、IR38-27 |
| 同上 | §7 权威覆盖、§8 入口矩阵、§9 能力矩阵、§10/§10.1 治理与容量 | 直接适用到保留、入口退役、只读兼容、资源上界和发布验收 | IR38-05、IR38-07～IR38-10、IR38-17～IR38-19、IR38-23、IR38-27～IR38-31 |
| 同上 | §11 产品旅程、§12 十八项不变量、§13 文档矩阵 | 直接适用；每个枚举行均须在 ledger、交付物和证据间闭合 | IR38-26、IR38-29、IR38-30 |
| 同上 | §14 S1 固定计划 | 不适用；仅描述第 30 单元起始实现，不产生第 38 单元新义务 | 明确排除，不生成审查项 |
| 同上 | §15 总执行计划、第 36～38 单元补充 | 第 38 单元行和补充直接适用；第 36～37 补充仅作为 supervisor、stop、removal、checkpoint 的冻结上游合同 | IR38-01、IR38-08～IR38-31 |
| research/design/modules/distributed-runtime/s2-security-supply-chain-review.md | 全文及三项生产依赖、一项仅开发依赖枚举 | 直接适用；生产依赖必须锁定，PAKE 不得进入生产导出、构建或发布图 | IR38-06、IR38-24、IR38-25、IR38-28、IR38-31 |
| research/design/modules/distributed-runtime/release-and-maintenance-guide.md | 安装、更新、离线 doctor、应用移除、永久设备移除、发布 runbook | 全部直接适用；既是用户操作合同也是发布验收入口 | IR38-07～IR38-11、IR38-16、IR38-19～IR38-25、IR38-30 |
| research/design/modules/distributed-runtime/unit-38-final-acceptance-ledger.json | 18 invariant + 10 fault + 8 security + 2 topology + 12 journey，共 50 个固定 id | 全部直接适用；每个 id 必须独立判定，禁止只检查分类前缀、合并独立终态或用总测试结果代替逐行证据 | IR38-26～IR38-30 |
| research/design/workbench/unit-development-workbench.md | D38-01～D38-10 | 全部适用为已知交付义务和交付物索引；勾选状态不能作为审查通过证据 | IR38-02～IR38-31 |
| research/design/workbench/unit-review-ledgers/unit-30.gen-1.md ～ unit-37.gen-1.md | 已封版问题、已排除问题、重开条件与迟发现记录 | 仅本单元直接交界、重开条件和历史反证适用；不重复审查事实未变化的内部范围 | IR38-05、IR38-06、IR38-12～IR38-18、IR38-21～IR38-23、IR38-26～IR38-29 |
| research/design/workbench/unit-submit-review.md 静态区 | 定位、范围与质量责任、来源覆盖、状态和动态区协议 | 全部适用为本清单的维护与判定规则；不产生产品功能义务 | 全部 IR38 项及两类问题列表 |
| research/design/workbench/verification-runbook.md | 验证可行性门禁及全部已验证运行方式 | 适用于后续取得验收证据的方法，不改变产品范围，也不把环境噪声或 benchmark 变成独立审查项 | IR38-24～IR38-31 的证据执行 |

### 直接规范条款与枚举行落点

| 有限规范集合 | 必须逐项判定的内容 | 审查项 |
|---|---|---|
| 第 38 单元自动维护合同 | specification 2617、2668～2670：stable-only、三种本机运行形态、异步且不阻塞启动/首个输入/ready、无 daemon、同 candidate 合并、全部验证在 lifecycle accept 前完成 | IR38-02～IR38-10 |
| ProgramUpdateReceipt v1 | phase exact-set：idle/checking/downloading/staged/handed-off；notice exact-set：none/updated/failed-safe/restored/action-required；action exact-set：retry-update/restore-previous/contact-support；candidate、operationId、code/action 的条件字段规则 | IR38-11 |
| 安全切版与恢复 | specification 2674：已验 stage、固定 drain、安全空闲点、旧 exact host、禁止 wall-clock 强切、自动兼容恢复优先、zz update 只是显式重试 | IR38-12～IR38-17、IR38-20 |
| 两种删除语义 | specification 2676：zz app remove 与 zz device remove --permanent；仅删除 zz uninstall、zz update --rollback 两个旧别名 | IR38-21～IR38-23 |
| 五目标 exact-set | win32-x64、darwin-x64、darwin-arm64、linux-x64、linux-arm64 | IR38-02、IR38-07、IR38-24、IR38-25 |
| 十三项 durable schema exact-set | AssignmentAuthorityRecord、AuthorityCommitEnvelope、CheckpointAuthorityRecord、ConversationAuthorityRecord、CredentialExposureRecord、DeliveryAuthorityRecord、DeviceLifecycleRecord、FinalAuthorityRecord、GlobalStateRecord、HomeTrustRecord、IntentAuthorityRecord、ResourceLeaseRecord、SchedulerAuthorityRecord | IR38-05、IR38-15、IR38-18 |
| S2 供应链 exact-set | @peculiar/webcrypto 1.7.1、@peculiar/x509 2.0.0、reflect-metadata 0.2.2 三项生产依赖；@cipherman/pake-js 0.1.1 仅开发依赖；强制门禁七条逐条判定 | IR38-06、IR38-24、IR38-28、IR38-31 |
| release smoke exact-set | clean-install、first-run、same-version-replay、no-update-silent、automatic-update、visible-update-status、safe-point-install、automatic-restore、guided-restore、offline-doctor、app-remove-preserves-data、permanent-device-remove-confirms | IR38-25、IR38-30 |
| 七组首个公开基线清退 exact-set | credentials.json 迁移/旧公开凭据字段；filesystem workscene registry/cutover；legacy memory/journal Markdown import/projection；scheduler compatibility JSON store；recovery package legacyCheckpoint decoder；废弃 RPC/request/CLI alias 与 source-compatible 注入参数；shadow writer/旧 delivery queue/registry/producer/capability flag | IR38-23 |
| 开发事项 exact-set | D38-01～D38-10 每项的生产实现、消费链、边界场景和直接测试义务 | IR38-02～IR38-31 |

### 当前交付物与审查落点

| 交付链 | 已纳入的生产端、消费端与装配入口 | 审查项 |
|---|---|---|
| 发布协议与耐久模型 | packages/core/src/protocol/release.ts、durable-schema.ts、device-lifecycle.ts 及对应导出和消费者 | IR38-02～IR38-05、IR38-10～IR38-16 |
| 发布工件与供应链 | scripts/release-version.mjs、release-channel.mjs、release-tooling.mjs、build-release-artifact.mjs、release-check.mjs，根 package scripts、锁文件和生成资产 | IR38-02～IR38-07、IR38-24、IR38-25、IR38-31 |
| CLI 更新与维护 | packages/cli/src/update 下的 durable-file、program-store、release-channel、release-verifier、update-controller、upgrade-lifecycle、runtime、doctor、app-remove 及 packages/cli/src/index.ts | IR38-07～IR38-22、IR38-30、IR38-31 |
| 常驻服务与两根装配 | packages/cli/src/serve/command.ts、executor-role-runtime.ts、rpc-program-update-facade.ts，packages/server/src/context.ts 与 rpc/methods/server.ts | IR38-08、IR38-11～IR38-20、IR38-29、IR38-31 |
| 凭据与配对交界 | packages/providers 的 credentials/path/export、CLI secret boundary/config editor、mesh pairing/recovery/package 依赖；只允许当前 SecretStore 与高熵邀请生产链 | IR38-06、IR38-21、IR38-23、IR38-28、IR38-31 |
| 权威、scheduler、memory 与工具清退 | packages/core 的 memory/scheduler/workscene、packages/owner-kernel 的 scheduler authority、packages/tools-builtin 的 memory/schedule，以及 CLI 对应 facade/adapter | IR38-05、IR38-18、IR38-23、IR38-26～IR38-31 |
| 旧路径退役与兼容资产 | 七组 exact-set 的删除文件和残留 reader，S7 有限入口描述、server goldens、公开导出、package graph 与文档引用 | IR38-18、IR38-22、IR38-23、IR38-31 |
| 最终验收与用户文档 | final acceptance ledger、release guide、直接测试、五目标平台证据和 release report | IR38-24～IR38-31 |

### 固定范围矩阵

| 矩阵 | 必须穷尽的有限变体 |
|---|---|
| F38-01 身份 | stable version、release sequence、五目标 target、index、manifest、artifact、receipt、stage、pointer、lifecycle operation、host generation；有/无 home、应用移除后重装和手动恢复均不降低已验高水位 |
| F38-02 触发与拓扑 | foreground、on-demand、managed 三种本机 host：真实启动、显式 update、managed 周期；pure surface 只消费 current-authority 投影且本机零 updater/home/daemon；在线、离线、禁用 |
| F38-03 升级窗口 | check、download、resume、stage、handoff、gate、settle、flush、stop、switch、health、restore、cleanup 各效果前后及响应丢失 |
| F38-04 兼容 | current、candidate、previous；版本、release sequence、协议、上述十三项 durable schema；bridge 初始旧 writer、各日志首条新写与同 envelope activation、兼容恢复后单调 writer、远端 peer 只读/写入 exact-set |
| F38-05 安装与移除 | 五目标；干净安装、首次启动、同版本重放、Unicode/空格路径；无 home 时只走重复安装且零 host/lifecycle；有 home 时安全升级；应用移除、永久设备移除和误操作交界 |
| F38-06 故障与安全 | 离线、超时、断流、Range 不符、容量不足、错误 target、签名/摘要/规范字节错误、manager 不可判定、健康失败、原始错误泄漏 |
| F38-07 并发与资源 | 同 home 单飞、锁竞争、重复触发、重启、固定批次、下载和内存上界、无网络 permit、current/previous/active stage 保留 |
| F38-08 发布证据 | 五目标真实工件、平台签名/公证、上述 12 项 smoke exact-set、源码与包摘要、生成资产、final ledger、release report 和用户指南 |
| F38-09 最终验收 | ledger 的 50 个固定 id 按下表逐行闭合，不接受“至少一个分类前缀”或总测试结果 |
| F38-10 边界 | 第 30～37 单元冻结合同交界、上述七组旧路径 exact-set、明确排除项及第 38 单元之后能力不得倒灌 |

### 最终验收 50 行 exact-set

| 分类 | 固定 id | 独立审查项 |
|---|---|---|
| invariant（18） | invariant-01、invariant-02、invariant-03、invariant-04、invariant-05、invariant-06、invariant-07、invariant-08、invariant-09、invariant-10、invariant-11、invariant-12、invariant-13、invariant-14、invariant-15、invariant-16、invariant-17、invariant-18 | IR38-26 |
| fault（10） | fault-executor-crash、fault-owner-crash、fault-cancel-race、fault-path-partition、fault-transfer-interruption、fault-storage、fault-revocation、fault-retry、fault-version-clock、fault-update | IR38-27 |
| security（8） | security-pairing、security-certificate-ticket、security-permission-snapshot、security-revocation、security-blind-relay、security-confirmation、security-authority、security-resource | IR38-28 |
| topology（2） | topology-single-machine、topology-paired-devices | IR38-29 |
| journey（12） | journey-first-run、journey-pair-ready、journey-daily-local、journey-offline、journey-uncertain、journey-transfer-recovery、journey-stop-remove、journey-auto-update、journey-update-recovery、journey-app-remove、journey-offline-doctor、journey-release-matrix | IR38-30 |

### 审查项

> 本轮修复影响28项审查节点，全部改为`[~]`；仅IR38-05、IR38-23、IR38-26能够证明登记输入未变而继续`[x]`。
>
> 所有`[~]`行末列现存的旧“本轮证据”均已整体作废，仅保留为触发重审的历史反证，不得代表当前结论；下一轮须以当前生产源码、合同和直接测试重新填写证据。

| 编号 | 状态 | 审查对象 | 独立通过条件与可复核证据 |
| --- | --- | --- | --- |
| IR38-01 | [~] | 单元身份、范围和来源完整：S10 的交付物、五目标、稳定自动更新、发布与最终验收全部归项；明确排除未变成门禁，所有规范来源、章节和枚举行均有适用性结论。 | 权威依据：charter、specification §15、D38-01～D38-10。本轮证据：已逐项对账 charter、requirements、specification、S2 review、release guide、D38-01～D38-10、历史封版账与 50 行 ledger；31 项覆盖全部当前交付组，未发现未判定来源或范围外门禁。 |
| IR38-02 | [~] | 发布身份唯一：根 package.json 的 stable 0.1.0 是 workspace、CLI、构建和运行投影唯一版本源；release sequence、五个 target、index/manifest/artifact identity 全等。反降级高水位只来自已验安装 manifest 与同 home upgrade 记录；无 home、应用移除后重装和手动兼容恢复均不得降低，错误 target、旧序列及同 identity 异 bytes fail-closed。 | 权威依据：charter、specification §1/§5.3/§15、D38-01。本轮证据：`installProgramRelease()`仅以程序根外 receipt 判高水位，未把已验 current pointer 纳入比较；pointer 已换代、receipt 尚未提交的崩溃窗口可由旧安装器降回。`compareReleaseSemver()`又以字符串比较 prerelease/build metadata，不能实现 SemVer precedence。证据：`installation-receipt.ts`、`release.ts`。 |
| IR38-03 | [~] | StableReleaseIndex v1 与 ReleaseManifest v1 严格规范：各自 exact key-set、JCS UTF-8 规范字节、签名域、HTTPS URL、摘要/字节和 index→manifest→artifact 交叉绑定闭合；unknown、缺失、错类型、非规范编码、签名或摘要错误在任何持久效果前拒绝。 | 权威依据：specification §1、Unit38 补充、D38-01。本轮证据：`release.ts`、`canonical.ts`、`release-verifier.ts` 的 production decode→canonical bytes→Ed25519→binding 链在下载和 stage 写前完成；exact key-set、HTTPS、digest/bytes/target 反例均 fail-closed。 |
| IR38-04 | [~] | ProgramArtifact v1 合同完整：exact key-set、规范 UTF-8、文件 canonical 排序、路径、权限、单文件/总大小、base64url 与展开上界受限，禁止路径穿越、链接逃逸和额外根；下载字节、manifest 摘要、stage read-back 与执行字节全等。 | 权威依据：specification §4/§10.1/§15、release guide、D38-02。本轮证据：ProgramArtifact exact keys、canonical UTF-8/base64url、排序/path/mode/file/expanded/archive 上界及 ProgramStore 展开目录 exact-set/read-back 均在 stage/pointer 前成立；未发现当前 P0/P1。证据：`release.ts`、`program-store.ts`。 |
| IR38-05 | [x] | 兼容与耐久 schema：上述十三项 exact-set 由实际 codec/record descriptor 机械闭合并被 manifest、运行投影和 reader/writer policy 共用。bridge 初始写旧格式；每个真实 AuthorityCommitLog 首条新格式记录与该 schema activation 同 envelope，之后兼容恢复也只写已激活版本；无新写不虚构迁移，format/protocol/schema activation/epoch 均单调。current/candidate/previous 不得靠 reader fallback 隐式降级或写入不兼容状态。 | 权威依据：specification §1.4/§4/§5.3/§9/§15、D38-01/D38-06。本轮证据：当前首个公开基线的十三项 `readMin/readMax/writeVersion` 全为 1，candidate 与 previous 互读门禁会拒绝不同 writer；没有当前可达的 schema 提升或 bridge。activation 要求超前于当前产品事实，已转正式 EX38-01 并登记精确重开条件。 |
| IR38-06 | [~] | 供应链与凭据边界：三项批准生产依赖精确锁定，PAKE 仅开发依赖；四项只由 mesh 声明，门禁覆盖实际 workspace、锁文件完整性、运行闭包、许可证、安装脚本、官方审计事实和固定向量。生产导出、构建、包和运行时无 PAKE/短码路径，配对只用高熵邀请；工件不含开发依赖、source map、测试资产、源码秘密、私钥、SecretStore 或 home 数据。 | 权威依据：s2-security-supply-chain-review、specification §2、D38-02。本轮证据：程序树会剔除已知开发/秘密路径，但最终 platform、runtime 与 smoke 证据只是调用方可写的 `passed:true`+digest；release gate 未证明对应 OS/arch 真实执行，且发布脚本验签边界与运行时 Ed25519 严格 verifier 不同。证据：`build-program-tree.mjs`、`build-release-artifact.mjs`、`release-check.mjs`、`release-verifier.ts`。 |
| IR38-07 | [~] | 五目标安装与 launcher：五个 target 的用户级程序根、PATH 中稳定 zz/zhixing、不可变 versions 与原子 current 同一合同；首次/重复安装验证平台签名、内嵌 manifest 和最终 bytes，只写程序层与内置 stable URL。空格/Unicode 路径成立；无 home 时只复用重复安装路径，零 host、零配对/恢复概念、零 lifecycle 或 ZHIXING_HOME 写入。 | 权威依据：charter、release guide、specification §8/§15、D38-03。本轮证据：正式 installer 对任何不同 pointer 都直接 stage+activate，不检查 home、运行 host、compatibility、accepted-work lifecycle 或 candidate health；测试还把 1.0→1.1 直切视为成功。stable `bin/installer/runtime`只覆盖声明文件、不移除旧入口。证据：`program-installer-entry.ts`、`installation-receipt.ts`、`update-controller.test.ts`。 |
| IR38-08 | [~] | 自动维护触发正确：真实 foreground、on-demand、managed 三种本机 host 启动均异步检查，managed 按既定周期；current 启动、ready、首个输入和工作不等待网络。离线/禁用无破坏效果，无 updater daemon；pure surface 只消费 current-authority 更新投影，本机零 updater、home、module、listener。 | 权威依据：charter §11/§14～§15、requirements VII、release guide、D38-03。本轮证据：三形态 host 的检查确实在 ready 后异步启动且无 daemon，但 REPL 只在连接建立时请求一次 status；后台 check/managed 周期后没有同连接推送或有界刷新，用户运行中看不到下载、安全点、安装或失败变化。并发 trigger 锁忙还会把活动 receipt 暂时降成失败。证据：`runtime.ts`、`repl.ts`、`update-controller.ts`。 |
| IR38-09 | [~] | 获取与续传安全：检查、下载、Range 续传、超时、断流、重试和容量门禁只接受同一候选 identity；网络 permit、响应头、长度、摘要和最终字节均验证，失败可重放且不污染 current。 | 权威依据：specification §10.1/§15、release guide、D38-02/D38-03。本轮证据：Range、长度、digest、partial fsync、4 MiB chunk、容量预检和 current 零污染成立；但 FileLock 只以 PID 存活判 owner，PID 复用可长期阻断接替，锁忙的第二调用还可改写活动 receipt。该局部健壮性问题不破坏 current。证据：`update-controller.ts`、`durable-file.ts`、`file-lock.ts`。 |
| IR38-10 | [~] | ProgramStore 与指针耐久：stage、current、previous、active stage 的 identity、原子写、目录同步、read-back 和崩溃窗口闭合；任何响应丢失通过耐久事实前滚，不产生第二事实源。 | 权威依据：specification §4/§15、D38-01/D38-05。本轮证据：`activateStaged()`先把 stage rename 到 version，`old-host-stopped`恢复却只调用 `loadStagedManifest()`；rename 后、pointer/journal 前后的任一崩溃都会因 stage 缺失而无法前滚，虽 version bytes 已耐久。证据：`program-store.ts`、`upgrade-lifecycle.ts`。 |
| IR38-11 | [~] | ProgramUpdateReceipt 是唯一程序层更新事实：phase、notice、action 及条件字段必须逐项符合上表 exact-set，receipt 不复制 lifecycle、health、pointer 或兼容事实。它与 current/previous、已验 stage 和 active upgrade 形成唯一无副作用投影；CLI、server、status、doctor、输入区和第一方 surface 消费同一结果。固定文案可行动、零 raw，失败在成功、candidate 换代或用户明确收起前保持可见。 | 权威依据：charter §11、requirements VII、specification Unit38 补充、D38-01/D38-07。本轮证据：receipt codec、sticky action 与 compare-and-consume 成立，但公开 CLI 只做启动单次快照；后台状态不进入输入区持续可见，host 不可达又被折叠为 invisible，不能完整承载唯一公开事实。证据：`runtime.ts`、`repl.ts`、`rpc-program-update-facade.ts`。 |
| IR38-12 | [~] | 升级接纳与安全点：只有完整已验 stage 且当前工作到达安全空闲点才 accept；随后关闭十类 producer gate，冻结同 operation accepted-work/source/delivery artifact，并固定使用 drain 逐 owner settle/read-back、flush 和物理收束。anchor/executor/foreground 不丢已接纳工作、不早停、不并行第二 operation；stop/removal/uninstall 只在耐久 conflict 边界保留各自既有策略，不扩成升级三策略。 | 权威依据：charter §10～§13、specification §3/§6/§15、第37单元冻结合同、D38-04。本轮证据：自动/显式 update 主链会关闭十 owner、安装 lifecycle admission 并 drain exact snapshot；正式 installer 的版本更新却完全绕过该主链，形成同一受支持升级能力的第二切版入口。证据：`upgrade-lifecycle.ts`、`command.ts`、`program-installer-entry.ts`。 |
| IR38-13 | [~] | 生命周期冲突与恢复：升级、stop、target removal、migration、backup uninstall 对同一设备的耐久 conflict identity、phase、重放和 terminal 唯一；任一阶段重启只前滚原 operation，不能绕过已封闭准入。 | 权威依据：specification §6/§15、第37单元冻结合同、D38-04。本轮证据：DeviceLifecycle 冲突身份与 phase 存在，但 stage rename achieved、pointer switch achieved、恢复后 health/terminal/release 没有共同 read-back；崩溃重启不能保证只前滚原 operation。证据：`program-store.ts`、`upgrade-lifecycle.ts`。 |
| IR38-14 | [~] | 旧 host 与切换顺序：只有 exact host/endpoint/definition/manager 事实授权停止旧实例；old-host-stopped 后才切 current pointer，切换效果丢响应可由 read-back 判定，绝不误停 successor。 | 权威依据：charter §10/§12、specification Unit38 补充、第36～37单元冻结合同、D38-04/D38-05。本轮证据：exact old-host proof 先于切 pointer；但 stage rename 或 pointer write 效果成功、phase advance 前失联时，恢复只找 stage 而不会从 exact version/current 识别已实现效果，故响应丢失不收敛。证据：`upgrade-lifecycle.ts:old-host-stopped`、`program-store.ts:activateStaged`。 |
| IR38-15 | [~] | candidate 启动健康门禁：anchor 与 executor、managed/on-demand/foreground 都以同一 candidate/version/schema/trust/role/endpoint identity 完成 preflight、listener、ready 和 health；不健康或身份漂移不得发布 ready。 | 权威依据：specification §2/§5.3/§8/§15、D38-05/D38-06。本轮证据：两根都会构造同一 health DTO并核对实际 Node，但都在 `runServer()`激活 bound server/真实 router 之前调用 `completeHealthy()`并写 terminal；现有 loopback RPC helper 只在孤立测试使用，生产 candidate 可在随后激活失败后仍被标为已更新。证据：`command.ts`、`executor-role-runtime.ts`、`runtime.ts`。 |
| IR38-16 | [~] | 恢复语义有限而完整：健康失败自动恢复 previous；用户可在支持窗口执行 guided restore；恢复仍走同一安全生命周期和健康验证，current/previous 交换可重放，产品不暴露 rollback 术语或无限历史版本。 | 权威依据：charter §11～§12、release guide、specification Unit38 补充、D38-05。本轮证据：显式 restore 已进入同一 lifecycle；自动 health 失败路径却在 previous 尚未重启/真实 health 前 `restorePrevious()`、写 `health-verified`、terminal 与 restored receipt，然后抛出重启，且正常 exact release 只在 verify-target 成功分支执行。证据：`upgrade-lifecycle.ts:restoreCompatiblePrevious` 与两根调用点。 |
| IR38-17 | [~] | 清理和资源上界：仅清理非 current、非 previous、非 active stage 的程序版本，固定批次且 read-back；失败可重入，不触碰 home、SecretStore、checkpoint 或 lifecycle evidence，磁盘和内存增长有界。 | 权威依据：specification §4.5/§10.1/§15、D38-05。本轮证据：cleanup 仅处理 ProgramStore versions/stage，保留 current/previous/active stage，128 项删除批次且不触碰 home/SecretStore/checkpoint/lifecycle；未发现当前 P0/P1。证据：`program-store.ts:cleanup/removeChildrenInBatches`。 |
| IR38-18 | [~] | 协议不兼容与 mesh 行为：远端 peer 版本/能力/schema 不兼容时仍提供规定的只读诊断，写入和 activation fail-closed；兼容 peer 正常工作，旧 peer 不触发本地降级或第二同步路径。 | 权威依据：specification §2.5/§5.3/§9/§15、D38-06。本轮证据：冻结 mesh protocol/capability admission 继续 fail-closed；当前十三项 writer 均为 v1，升级互读检查拒绝版本漂移，不存在本单元可达的 schema activation。相关未来版本跃迁主张已转正式 EX38-01。 |
| IR38-19 | [~] | 离线诊断和 surface：doctor、status 与 pure surface 只读组合 release manifest、current/previous pointer、stage/receipt、active upgrade、protocol/schema、真实 managed snapshot、checkpoint configuration、SecretStore inspect 和 lifecycle blocker；host absent、离线、无候选、下载、待安全点、恢复及失败均收敛为一个 code/message/action。不得 activation、SecretStore 写、网络探测或 lifecycle 效果，不泄漏秘密、URL、路径、内部 identity、环境变量或 raw error。 | 权威依据：charter §11、release guide、specification Unit38 补充、D38-07。本轮证据：doctor 本地读取 effect-free，但 CLI 总是传 current-authority projector；该 helper 在 host absent 时返回 `{visible:false}`，doctor 因此丢弃本地 failed-safe/action-required receipt，可能对离线更新失败报告“知行状态正常”。证据：`doctor.ts`、`runtime.ts:readCurrentAuthorityProgramUpdateProjection`、`index.ts`。 |
| IR38-20 | [~] | 显式 update 与 server RPC：认证和 loopback、strict 输入、request identity、并发/重放、公开错误及生命周期 handoff 全部在首个效果前验证；CLI 与 RPC 只调用同一 controller/lifecycle，不产生旁路。 | 权威依据：specification §1.5/§8/§15、release guide、D38-03/D38-04。本轮证据：认证、loopback、strict request 与 CLI restore→controller→RPC handoff 均成立；但这些公开入口最终消费的 lifecycle 仍存在 IR38-10/13～16 的不可恢复/假健康终态，不能独立判为通过。证据：`server.ts`、`rpc-program-update-facade.ts`、`upgrade-lifecycle.ts`。 |
| IR38-21 | [~] | 应用移除：先复用现有安全 stop 收束 current/future launch，再只移除程序工件；用户 home、配置、信任、SecretStore、checkpoint 和可恢复数据保持，效果丢失可重放。 | 权威依据：charter §10～§12、requirements VII、release guide、D38-03。本轮证据：app remove 先 future-disable、再复用安全 stop、exact unregister，最后只把 program root 交给已安装 remover并显式 preserve-user-data；失败前不触碰 home，文案仅承诺“正在移除”。未发现 P0/P1。证据：`app-remove.ts`、`managed-service-runtime.ts`、`program-installer-entry.ts`。 |
| IR38-22 | [~] | 永久设备移除与误操作边界：与应用移除保持独立入口、强确认和不可逆语义；只将 zz uninstall 与 zz update --rollback 作为旧别名拒绝，不能误伤当前 zz device remove --permanent。文案、help、交互和非交互参数清楚区分“移除应用并保留数据”与“永久移除设备及本机数据”。 | 权威依据：requirements VII、release guide、specification §8/§15、D38-03/D38-08。本轮证据：`zz app remove`与`zz device remove --permanent`入口、确认与数据语义独立，旧 `uninstall/--rollback`无路由；未发现误伤当前永久移除路径。证据：`index.ts`、`device-removal-command.ts`、release guide。 |
| IR38-23 | [x] | 七组旧路径按上表 exact-set 完整退役：每组的 reader、writer、组合根、公开 export、迁移状态、别名/注入参数、golden 和文档引用均反向清点；只保留 durable schema inventory 明示且被 minimumRollbackVersion 实际消费、无隐藏开关的正式 reader。默认安装不扫描旧位置，生产图无双写、双读、旧 capability 或 shadow owner。 | 权威依据：specification §8/§13/§15、D38-08。本轮证据：七组 production reader/writer/route 扫描未发现双写、旧 capability 或 shadow owner；`StopDeps.killFn/taskkillFn`未调用字段和CLI README迁移文字没有生产消费或当前用户损失，价值裁决后已转正式 EX38-02。 |
| IR38-24 | [~] | 五目标发布工件构建：每个 target 从同一 source/package closure 形成自包含 Node 22 程序树，消解 workspace:*，只含运行资产；消费平台签名/公证后才冻结最终归档 bytes、manifest 和逐文件摘要。版本、target、权限、原生件、launcher read-back 全等，开发占位 channel、开发依赖、install script、source map、测试资产和秘密不得进入正式包。 | 权威依据：release guide、specification Unit38 补充、D38-02/D38-09。本轮证据：程序树构建、workspace deploy、Node runtime/launcher exact-set与 artifact bytes 已接通，但 Node/platform evidence均可用自报布尔文件满足，且没有可复核的真实目标命令/系统身份；故五目标“真实工件”仍无提交级证据。证据：三个 release build 脚本及 `release-tooling.test.mjs`。 |
| IR38-25 | [~] | release:check 是确定、受控输出且无外部发布副作用的发布门：先运行 lint/test/build，再验证同一 source/package 输入、五目标、上述 12 项 smoke、签名/公证、manifest/artifact、50 行 ledger 和文档版本；结束前复验输入未漂移，才原子写 release-report 与可选 candidate index。不依赖 Git 暂存/干净状态，不保管私钥、不调用外部发布；失败不得留下伪成功或半写正式输出。 | 权威依据：release guide、specification §15、D38-09。本轮证据：release:check 会跑 workspace gates、核对五 target/digest/50 ids并原子写报告；但 smoke/platform/ledger语义均只验 declaration 与文件存在，source fingerprint还不含这些 release 脚本，门禁可对未实际执行的目标矩阵生成 passed。证据：`release-check.mjs`、`release-tooling.mjs`。 |
| IR38-26 | [x] | invariant-01～invariant-18 逐行闭合：每行分别核对 source、真实 producer、consumer、composition root、terminal 与现存直接测试，且升级前后/恢复后仍成立；只有 18 行各自有结论和证据时本项通过。 | 权威依据：charter §13、specification §12、final acceptance ledger、D38-10。本轮证据：18 个固定 id、对应上游生产测试和第38单元交界均可定位；本轮发现的升级/发布问题分别由 fault/journey/交付项承载，没有证据表明其改变十八条冻结领域不变量本身。证据：final ledger 18 行、对应现存 production tests。 |
| IR38-27 | [~] | 上表 10 个 fault id 逐行闭合：每行分别覆盖其规范终态及适用的效果前失败、效果后响应丢失、重启和恢复；fault-update 还必须证明旧版安全可用或兼容恢复并给唯一用户行动。只有 10 行各自有结论和生产证据时通过。 | 权威依据：charter §12/§12.1、final acceptance ledger、D38-10。本轮证据：前九个 fault 行仍有冻结证据；`fault-update`没有覆盖 stage rename→pointer/journal、server activate、restore pre-health/terminal 等真实窗口，当前源码在这些窗口可停摆或伪成功。证据：final ledger、`upgrade-lifecycle.test.ts`仅 happy-path。 |
| IR38-28 | [~] | 上表 8 个 security id 逐行闭合，并在第 38 单元交界核对发布签名、规范字节、target/path、秘密和供应链；每个拒绝均在首个副作用前，公开结果无敏感原文。只有 8 行及本单元安全交界各自有结论时通过。 | 权威依据：charter §4/§12/§13、s2 review、final acceptance ledger、D38-10。本轮证据：八项上游 security 行仍闭合，release decode/path/signature负例也存在；但五目标 runtime/platform/smoke证据可自报，发布 verifier 与运行时 Ed25519 边界不全等，无法证明正式包的供应链交界。证据：S2 gate、release scripts、runtime verifier。 |
| IR38-29 | [~] | topology-single-machine 与 topology-paired-devices 分别闭合：anchor/executor 和 managed/on-demand/foreground 复用同一更新、lifecycle、health、兼容与诊断原语；pure surface 只走 current authority 的有限投影，本机零 updater/lifecycle/host。未启用角色零模块/监听，无漏装、双装或角色旁路。 | 权威依据：charter §2～§3/§14、specification §8、final acceptance ledger、D38-10。本轮证据：anchor/executor均装配 updater/lifecycle/health，pure surface自身不启 updater；但两根都在 server activation 前 terminal health，且REPL没有运行期投影刷新，双拓扑的更新 ready/可见性仍不等价。证据：两根 composition root、`repl.ts`。 |
| IR38-30 | [~] | 上表 12 个 journey id 必须逐行给出入口、用户语言、终态和直接证据；另将 12 项 release smoke exact-set 逐项映射到相关旅程。开箱、配对、日常、离线、uncertain、迁居/恢复、停机/永久移除与四个更新旅程均保持零拓扑术语、正常无噪声、失败一个下一步；只有 12 行和 12 项 smoke 各自有结论时通过。 | 权威依据：charter §11/§15、requirements VII、release guide、final acceptance ledger、D38-10。本轮证据：12 journey与12 smoke名称齐全；first/reinstall update绕 lifecycle、auto-update运行期不可见、health/recovery可伪成功、offline doctor可丢行动、release matrix可自报，故至少五条更新旅程没有穿过正确生产终态。证据：installer/runtime/doctor/release生产链。 |
| IR38-31 | [~] | 最终交付装配与证据充分：当前变更集中的 root/scripts、core、cli、mesh、owner-kernel、providers、server、tools-builtin、模块文档和 workbench 每组均反向归入 IR38-02～IR38-30；所有 production 文件有真实 producer、consumer、composition root 和公开出口，直接测试走生产路径。生成 version/channel、S7、golden、导出、ledger、guide、report 与代码一致，无孤立实现、测试专用生产旁路或范围外能力。 | 权威依据：charter §15、specification §13/§15、release guide、D38-01～D38-10。本轮证据：全部文件组已归项且无范围外 daemon/framework；但正式 installer、upgrade recovery/health、surface消费与五目标证据四个生产交界仍有阻断根因，当前完整交付物尚不能提交。证据：上述当前调用图与直接测试反证。 |

---
## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 | 相关审查项 |
| --- | --- | --- | --- | --- | --- | --- |


### 已删除问题的价值裁决记录（非待处理问题）

| 原编号 | 原结论 | 推翻或收窄事实 | 新决定与重开条件 |
| --- | --- | --- | --- |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此，并逐项填写工作量评估。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| --- | --- | --- | --- | --- | --- |


> **独立审查结论**：U38-01、U38-02、U38-04、U38-07～U38-09 已修复并在专项冻结指纹上验证；问题列表保持空表。受影响28项已按协议改为`[~]`且旧证据作废，3项未受影响结论继续复用；当前不得宣称独立审查通过，下一阶段只重审`[~]`项。
