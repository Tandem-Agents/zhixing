# Workflow 架构设计

## 一、灵感来源

### 1. Claude Code 的 /workflows

> 客观记录其工作过程与原理,作为参照系;知行自身的取舍留待后续章节。

**本质**:把"多 agent 编排"从主 agent 每一步即兴判断,改成一段**确定性脚本**。面对复杂任务,主 agent 自己写出一段 JavaScript 编排脚本,脚本在后台运行,用确定性控制流(循环 / 条件 / fan-out)调度一批**子 agent**协作完成;主 agent 提交后不阻塞,完成时收结构化结果继续。

**工作过程**(主 agent 视角):

1. **判定**——任务值得编排才动用:可分解并行覆盖、需独立视角对抗验证、或规模超出单个上下文窗口;否则单 agent 直接做。
2. **写脚本**——以 `export const meta = {…}`(name / description / phases,纯字面量)声明元信息,脚本体用编排原语组织子 agent。
3. **后台执行**——提交即返回 task id,异步运行、完成时通知,期间主循环可做别的事。
4. **回收**——脚本 `return` 结构化结果,主 agent 据此决策,可串接下一个 workflow。

**核心原语**:

- `agent(prompt, opts?)` —— 派生一个**上下文隔离**的子 agent,返回其最终文本;带 `schema` 时强制结构化输出(校验在工具调用层,不匹配自动重试),免去解析。最小执行单元。
- `pipeline(items, …stages)` —— 每个 item 独立流过所有 stage,**阶段间无屏障**(item A 已进 stage 3 时,item B 仍可在 stage 1)。多阶段工作的默认形态;墙钟 ≈ 最慢的单条链,而非"各阶段最慢之和"。
- `parallel(thunks)` —— 一组任务并发执行的**屏障**:等全部完成才返回。仅当确需所有结果聚齐(跨项去重 / 合并 / 全零早退)时才用。
- `phase(title)` / `log(msg)` —— 进度分组与进度播报。

最小骨架(分维度审查 + 逐条对抗验证):

```js
export const meta = {
  name: 'review-changes',
  description: '分维度审查变更并逐条对抗验证',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS }),       // 各维度并发产出发现
  review => parallel(review.findings.map(f => () =>                  // 每条发现一出来就立即验证
    agent(`对抗验证: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)
return results.flat().filter(f => f.verdict?.isReal)
```

**核心原理**:

- **确定性控制流负责"结构",子 agent 负责"每一步的智能"**。该不该并行、要不要对抗验证、如何综合——编排骨架被写成代码、一次性固化;每个子 agent 只在隔离上下文里自治完成被分配的那一步。等于把 LLM 不擅长的"长流程即兴编排"(走偏 / 漏步 / 自循环)交给确定性 JS,把它擅长的"单步判断"留给子 agent。
- **编排者是 AI 自己,不是用户**。骨架由主 agent 按当前任务现写,而非让用户面对一个可视化编排器拖拽配置——这是它与 Zapier / n8n 类工具的根本分野。
- **上下文隔离 + 结构化回收**。主编排不被子 agent 的中间过程污染,只收每个经 schema 校验的结论;由此"几十个子 agent fan-out 做穷尽覆盖 / 多视角对抗"才成立,能承载单个上下文装不下的工作(大规模迁移、审计、广覆盖)。

### 2. 我的心得体会

我在真实协作中已经形成了一类编程工作流:让多个模型在关键节点并行、独立地产生判断,再通过汇总、对抗验证和人类把关收敛到单一执行路径。

这个流程不是让 AI 一路自动跑到底,而是把复杂任务拆成几个性质不同的节点:

1. **设计节点**:架构设计、UI 设计、头脑风暴等开放性问题,适合多个模型并行独立思考。它们不互相污染上下文,各自给出方案。
2. **方案评判与优化节点**:每个设计节点拿到其他设计节点的多个方案后,比较优劣,选择更强方向,再开启一轮并行独立优化。
3. **汇总节点**:由一个独立节点吸收所有方案、取长补短,整理成最终设计或执行方案。
4. **执行节点**:把已经收敛的方案交给执行力强的模型单线推进,避免多人并行写代码造成冲突。
5. **审查节点**:实现完成后,再次让多个模型并行审查,尽可能发现问题。
6. **真实性验证节点**:把审查发现汇总后,独立验证问题是否真实有效,过滤猜测和误报,只保留真实问题列表。
7. **修复节点**:再交给执行力强的模型单线修复,随后重复审查与验证流程,直到质量达标。

这个工作流现阶段的关键不是"全自动",而是**人类仍然在节点之间把关**。每个阶段结束后,人类确认方向、范围和取舍;AI 负责扩展视角、执行细节和反复验证。这样既利用多模型并行带来的覆盖度,又保留人类对产品本质、架构方向和最终判断的控制权。

但从架构和产品演进趋势看,这里不应该把"人类参与"硬编码成唯一形态。更合理的抽象是:工作流中存在若干**裁决节点 / 把关节点**。当前这些节点由人类承担,未来可以替换为更高阶的独立 agent、评审模型、规则引擎或它们的组合。也就是说,人类不是流程结构本身,而是当前阶段裁决节点的一种实现。

因此,Workflow 架构应支持两种模式:

- **Human-in-the-loop**:当前产品形态。关键阶段暂停,把多模型结果、冲突点、推荐方案交给人类确认。
- **Autonomous workflow**:未来产品形态。裁决节点由独立智能体或策略模块承担,在满足置信度、风险等级和权限约束时自动推进全流程。

短期不需要实现全自动,但架构必须为它留出位置:节点之间的输入输出要结构化,裁决动作要可插拔,每次裁决要有可追溯记录。这样未来从"人类把关"演进到"自动裁决"时,不是重写 workflow 系统,而是替换裁决节点的执行者。

### 3. 头脑风暴a

Workflow 不应该只是"把多个 agent 串起来",也不应该变成让用户配置复杂流程的低代码面板。它的产品本质是:把一套高质量、可复用、可审计的工作方法,变成知行能够稳定执行的生产系统。

用户真正要的不是 workflow 本身,而是在复杂任务里获得更可靠的结果:设计不跑偏、执行不漏步、审查能发现真实问题、修复能闭环、关键取舍有人或更高阶节点把关。因此 Workflow 的体验应该是"我交代目标,知行组织过程",而不是"我手动搭流程"。

架构上,Workflow 应把几类东西分开:

1. **意图**:用户要达成什么结果,以及约束是什么。
2. **过程**:任务如何被拆成节点,哪些节点可并行,哪些节点必须等待裁决。
3. **执行**:每个节点由谁执行,是主 agent、子 agent、工具、规则模块,还是未来的独立裁决节点。
4. **证据**:每一步产生了什么输入、输出、判断依据和可复查记录。
5. **裁决**:何时继续、暂停、重试、分叉、收敛或停止。

这个拆分很关键。只要过程、执行者、证据和裁决解耦,Workflow 就不会被某一种模型、某一种交互面、某一种人类参与方式绑死。今天它可以是"人类在关键节点确认",明天可以是"独立评审 agent 在低风险场景自动确认";今天是 CLI 发起,未来也可以从飞书、定时任务、系统事件发起。

从产品上看,好的 Workflow 应该默认克制:不是所有任务都进入工作流,只有当任务需要长流程、并行视角、审查闭环、可暂停恢复、可追溯证据时才启动。普通聊天和小任务仍然应该直接完成,否则 Workflow 会从能力升级变成体验负担。

从架构上看,好的 Workflow 应该像一个长期运行的任务系统:有状态、有事件、有产物、有权限边界、有取消和恢复能力。它不是一次 prompt 技巧,而是知行从"会做事"走向"能稳定组织复杂工作"的基础设施。

### 4. 头脑风暴b

换个起点。前几节默认了"我们在做一个 Workflow 系统",我想先退一步,从知行作为个人智能体的本质重问一遍:为什么需要它、它对用户究竟意味着什么、什么样的架构十年后回头看仍然成立。以下是思路,不是结论。

**本质 —— 从"聪明的个体"到"有方法论的组织"。** 知行今天是个聪明但不稳定的个体:单次交互的质量靠模型当场发挥,任务越复杂越重要,这种"赌一把"的代价越高。人类解决复杂工作可靠性的办法从来不是"找个一次做对的天才",而是流程与制度——分工、评审、交叉验证、质量门、留痕;一个组织能稳定产出,靠的是好的工作方法被固化成流程,而非人人天才。Workflow 真正在卖的不是"多 agent",是"可靠":**把可靠性从"依赖单次模型发挥"转为"依赖流程结构保障"**,完成从手工作坊到现代生产体系的跃迁。

**红线 —— 它必须是隐形的内功,不是用户面对的功能。** 这是我最坚持、也最容易失守的一条。一旦开始谈"节点、编排、引擎",产品就有强大引力滑向企业级工作流平台(n8n / Temporal 那一脉)——那是工程师的高潮,不是个人助手的样子。乔布斯式的判断:用户心智里没有"workflow"这个词,他要的是"把这件复杂的事做对",不是"搭一条流水线"。所以用户永远不该创建、配置、管理任何流程,他只说目标,要不要走、走哪套工作方法,知行自己定。**成功的标志是用户完全感觉不到它存在,只感觉到"知行做复杂的事变可靠了"。** 一旦用户需要理解、管理 workflow,产品就从个人助手退化成了开发者平台——连"Workflow"这个名字都只配活在我们内部。

**形态 —— 不是新引擎,是 agent loop 的一种运行模态。** 最该警惕的是另起炉灶。知行刚在 unified-core 那轮消灭了"两套会话执行面"的债,Workflow 绝不能又造一套"第二执行系统"。它要的底座大多已在:子 agent 体系是执行单元,scheduler 是可恢复的长任务承载,事件系统是可观测性,confirmation / trust 是裁决与权限,ConversationManager 是状态权威。**真正的增量很薄:一份"编排描述" + 一组"裁决点",接到既有地基上。** 若最后做出的是几千行的独立引擎,基本可判方向错了;若是复用底座的薄编排层,才对。建在已验证地基上的东西,才经得起时间。

**关键岔路 —— 编排描述该是可恢复的声明式结构,不是一段连续执行的代码脚本。** 这是我和第 1 节(Claude Code 脚本形态)最大的分野。让 AI 写 JS 脚本图灵完备、极灵活,但那是开发工具的选择;知行的身份是"核心宿主恒在、跨端可续、可恢复"。一个复杂 workflow 必然跨越很长时间、很可能跨 daemon 重启、必然要在裁决点长时间挂起等人——**连续执行的脚本和这三件事天生不合**:执行态在内存,重启即丢;节点边界暂停等裁决要把代码劈成 continuation;中间态难审计。而"AI 生成一份可持久化的声明式编排(节点 + 依赖 + 裁决点),由常驻宿主解释执行、逐节点落盘状态"天然可恢复、可在任意裁决点挂起、可逐节点留证。代价要诚实说:声明式表达力不如脚本,动态循环 / 条件 fan-out 得靠引擎逐步加算子。但知行要的不是最大表达力,是可靠、可恢复、可裁决、可审计——表达力能事后加,"可恢复 + 可裁决"是地基,事后补不上。

**灵魂 —— 围绕裁决点组织,而不是围绕自动化组织。** 普通自动化的心智是"设好就跑完"。但高价值复杂工作最关键的,恰是那些要判断、取舍、担责的节点——把它们也无人化才是真灾难(不是模型不会执行,是高风险裁决不能无人负责)。所以视角要翻转:**Workflow 不是"自动流水线偶尔停下问人",而是"一串由裁决点分隔的可靠执行段";裁决点是一等公民,执行段是它们之间的填充。** 由此自然推出两点:其一,从 human-in-the-loop 到 autonomous,本质只是"裁决者"这个角色的替换(人 → 高阶 agent → 规则),流程结构不变——裁决者可插拔,裁决结构不可拔。其二,自动裁决不是新机制,它就是知行既有 confirmation / trust 的升维:今天确认一条 bash 命令,明天裁决一个"审查阶段是否通过",同一套信任分级、持久授权、可追溯。这个连接让架构既省又稳。

**判准 —— 用"可靠性是否值其代价"决定要不要它,而这个判断本身是知行的智能。** 默认克制大家都同意,但判准不该是"任务大小"。本质判准是:**这件事做错的代价,是否大于多 agent 并行 + 验证 + 裁决所花的时间、成本与打扰。** 聊天、简单查询错了重来即可,不值;一次重要重构、一份要发出的方案、一个不可逆操作,错的代价高,才值。谁来判断?知行自己——它得有"元判断能力",像资深员工知道什么事该走流程、什么事直接做。这份判断力本身就是产品智能,也是 Workflow 不沦为重型负担的总闸。

**时间检验 —— 引擎与工作流分离,且赌"责任原则"而非"模型能力"。** 两点。其一,机制与策略分离:**引擎(节点调度、状态机、裁决、持久化、证据链)是稳定机制;具体工作流(编程审查流、研究流、写作流)是策略,是数据,可增删而不动引擎**——这就是 subagent 研究里"底座 vs surface"落到 workflow 层。模板的三个来源由同一引擎容纳:产品预设、主 agent 临场组装、未来用户 / 社区沉淀,只是"预定义输入"与"动态生成输入"之分,不是两套系统;workflow 自身还应可嵌套(一个节点就是另一个 workflow)。其二,真正让架构十年不倒的:随模型变强,越来越多裁决会从人转给 autonomous,但有一类永远不该自动化——涉及用户价值观、不可逆的真实后果、责任归属的裁决。架构要能永久区分"可委托的裁决"和"必须由人来担的裁决"。这条不赌"模型会不会更强"(那是会变的),赌"责任不可委托"(那不随技术变)——**赌不变量的架构,才经得起时间。**

**收敛一句。** Workflow 不是给知行加一个工作流引擎,而是让它学会像一个有方法论的组织那样工作:可靠性来自流程结构而非单次发挥,但这一切对用户隐形——用户只说目标,知行在背后组织一套可恢复、可裁决、可审计的执行,并在真正需要判断的节点把决定权交给人;未来在风险与责任允许时,才交给更高阶的裁决者。

---

## 现状梳理

### 现状

已有 subagent 地基方向是正确的:它把子 agent 设计成短生命周期、上下文隔离、可观测、可中断、可安全约束的执行单元。当前实现位于 `@zhixing/orchestrator`,由 Task 工具作为唯一 LLM-facing 委派 surface 使用;子 agent 不写独立 Turn,中间过程不污染主对话,结果以 tool result 回到主 agent。

这个地基已经具备几项重要能力:

1. **独立上下文**:子 agent 有独立 profile、独立 system prompt、独立消息窗口。
2. **事件血缘**:子 EventBus 通过 lineage 冒泡到父 bus,上层可以按来源观察进度。
3. **中断级联**:父 turn 取消时,子 agent 跟随中止;子失败不反向杀父。
4. **安全边界**:子 agent 默认无 Task 工具,工具集由 profile.enabledTools 控制;confirmation 默认 fail-to-deny。
5. **结果回写**:子 agent 最终输出与 usage trailer 回到父 tool result,主 agent 再综合。

但当前落地点仍然偏 Task 场景,不是完整的 Workflow 节点执行原语。事实是:

1. `runChildAgent` 内部固定使用 `subAgentProfile`;该 profile 声明 `read` / `glob` / `grep`,实际子工具集取父工具集与该声明的交集。
2. 组合能力主要由主 agent 在同一 turn 内多次调用 Task 实现,没有独立的 workflow runner / node runner。
3. 子 agent 不持久化自身中间过程;这对 Task 正确,但 Workflow 的暂停、恢复、裁决、审计必须由 workflow 层自己持久化。进一步说,从调用方与持久化视角看,`runChildAgent` 是一次 async dispatch:调用方 await 最终 `ChildAgentResult`,中间只有事件流可观察,没有可恢复的中间态。因此 Workflow 的恢复粒度只能到节点边界:单个节点中途崩溃只能整节点重跑,无法从节点内部断点续传。
4. `AgentRoleProfile.capabilities` 当前只是预留元数据,还没有被调度或角色选择逻辑消费。

### 结论

现有 subagent 地基适合作为 Workflow 的底层执行能力复用,但不能直接把 Task surface 当成 Workflow 架构本身。

如果目标是短任务并行调研,现有 Task + subagent 实现已经足够干净;如果目标是长期可恢复、可裁决、可审计的 Workflow,需要在它之上抽象出更通用的节点执行层:复用现有子 agent 的 abort、event、broker、budget、安全能力,但让 Workflow 节点能够显式声明 profile、工具策略、输入输出契约和裁决策略。

因此,本模块后续设计应坚持:不推倒 subagent 地基,也不把 Workflow 绑死在 Task 工具上;Workflow 应使用更通用的 agent 节点执行原语,Task 继续保留为主 agent 的轻量委派 surface。

---



## 二、需求碎片梳理

> 本节只罗列 Workflow 相关需求碎片与方向,暂不做拼接、取舍和裁决;冲突或未定内容先并列保留,留给后续架构设计章节统一收敛。

### 产品体验碎片

1. Workflow 应该是知行内部的可靠工作方法,不是用户要学习和管理的功能面板。
2. 用户表达目标、约束和偏好;知行判断是否需要进入 Workflow,以及采用什么工作方法。
3. 普通聊天、小任务、低风险任务不应该被 Workflow 包裹;只有复杂度、风险、成本或质量要求足够高时才值得启动。
4. Workflow 的过程应可解释、可暂停、可恢复,但默认不把内部节点噪声暴露给用户。
5. 关键裁决点必须能交给人类确认;未来可替换为独立裁决 agent 或规则模块,但责任边界不能消失。
6. 需要区分"可委托的判断"和"必须由用户承担的判断":价值观、不可逆后果、责任归属类裁决不能被静默自动化。

### 执行结构碎片

1. Workflow 应有自己的运行实例,不能只是主 agent 连续多次即兴调用 Task。
2. Workflow 实例应记录目标、输入、节点状态、节点输出、裁决记录、错误与最终结果。
3. 节点是 Workflow 的基本执行单位;节点之间通过依赖、输入输出和裁决点连接。
4. 节点可以由 agent、工具、规则模块、人类确认或未来的独立裁决者执行;不应把节点等同于 subagent。
5. 节点输出应尽量结构化,供下游节点稳定消费;自由文本适合展示,不适合作为唯一机器契约。
6. Workflow 的恢复粒度至少应到节点边界;节点完成后结果落盘,后续恢复不重复已完成节点。节点内部是否支持断点续传由节点执行器能力决定,不作为首版硬要求。
7. Workflow 应支持暂停、继续、取消、失败重试和人工裁决后的分支推进。
8. Workflow 应支持可复用模板与组合:同一引擎可承载预设工作流、临场生成工作流,并为工作流组合与复用留下扩展空间。

### Agent 地基碎片

1. 现有 subagent 地基应复用,避免另造第二套 agent 执行体系。
2. Workflow 需要一个不绑定 Task surface 的通用 agent 节点执行能力,节点可声明 profile、工具策略、预算、输入输出契约。
3. 子 agent 的事件、abort、confirmation、budget、安全执行能力应被 Workflow 节点复用。
4. 并行是 Workflow 的一种执行形态,不是 Workflow 的全部;串行、并行、漏斗、收敛、裁决、重试都应由同一底座表达。
5. 并行数量应受产品体验、成本和综合质量约束,不能把"能 fan-out"等同于"应该 fan-out"。

### 裁决与质量机制碎片

1. 裁决点是一等公民,不是异常暂停;高质量工作流本质上由若干可靠执行段和裁决点组成。
2. Workflow 应支持多视角独立产出、汇总、去重、验证和收敛这类质量拓扑,但具体步骤属于工作流模板,不能焊进引擎。
3. Workflow 应支持反馈闭环:某类节点产出被验证、修正后,可以回到前序或后续节点继续推进,而不是只能线性跑完。
4. 每次裁决应留下依据和结果,便于用户复盘,也便于未来把人类裁决替换为自动裁决。

### 种子工作流碎片

1. 代码审查闭环是核心种子工作流之一:多视角审查 → 真实性验证 → 修复 → 再审查。
2. 研究型工作流是重要种子场景:多源调研 → 观点比较 → 综合判断 → 产出报告。
3. 写作型工作流是重要种子场景:发散 → 结构收敛 → 起草 → 风格/事实审校 → 定稿。
4. 种子工作流用于验证引擎表达力,不代表首版交付范围,也不能反向污染 Workflow 通用机制。

### 安全与接入碎片

1. Workflow 必须复用现有 confirmation、trust、permission、abort 体系,不能绕开安全管线。
2. 高风险节点必须可暂停等待确认;低风险节点可在策略允许时自动推进。
3. Workflow 不应绑定 CLI;入口应通过统一接入面模型扩展,执行事实归宿在统一核心。
4. 接入面只负责发起、展示进度、接收裁决或通知结果;不拥有 Workflow 状态。
5. 主动通知必须有明确目标;Workflow 完成、失败或等待裁决时,通知谁应由发起来源、用户指定范围或配置策略决定。

## 三、架构设计

### 1. 核心判断

Workflow 不是新的聊天入口,不是可视化低代码面板,也不是 Task 工具的升级版。它是知行内部的**可靠工作方法运行时**:把复杂任务拆成可持久化、可观察、可裁决、可恢复的节点网络,由统一核心负责推进。

用户不需要管理 workflow。用户只表达目标、约束和偏好;知行判断是否值得进入 Workflow,选择预设工作方法或临场生成工作方法,在关键裁决点向用户要判断,其余过程由系统内部推进。

首版不是完整 workflow 产品形态,而是 Workflow 地基加一个真实可用的种子工作流。地基要先把定义校验、实例持久化、节点调度、裁决、恢复、事件、安全和执行器边界做正确;用户自定义工作流、可视化编辑、多模型策略配置、更多领域模板都属于地基稳定后的扩展。

架构上必须守住三条边界:

1. **机制与模板分离**:Workflow 引擎只表达节点、依赖、状态、裁决、恢复、事件;代码审查流、研究流、写作流是模板,不能焊进引擎。
2. **执行与接入分离**:Workflow 状态归统一核心所有;CLI、飞书、未来接入面只负责发起、展示、接收裁决和通知结果。
3. **agent 与节点分离**:agent 是智能执行单元,但节点不等于 agent;节点也可以是工具、规则、汇总、裁决、等待外部输入。

依赖方向必须保持现有宿主分层:

1. `@zhixing/core` 承载 workflow 的纯契约、定义校验、状态、事件和执行器接口。
2. `@zhixing/server` 承载实例状态、恢复、RPC 与运行协调,通过装配注入校验器和执行器注册表,不直接依赖具体 agent 实现。
3. `@zhixing/orchestrator` 承载具体执行能力,例如 agent 节点执行器、模板选择和临场定义归一化。

server 不能为了 workflow 反向绑定 orchestrator。WorkflowManager 是宿主协调者,不是具体执行层;具体执行能力必须通过接口注入。

### 2. 顶层对象

#### WorkflowDefinition

WorkflowDefinition 是可复用的工作方法描述,可以来自产品预设,也可以由主 agent 临场生成后通过校验。

Definition 必须是受限声明式图结构,不能是脚本、代码、任意表达式或可执行字符串。临场生成的 definition 也只能生成同一套 JSON graph,并经过 validator 校验后才能启动。

核心字段:

- `id`:定义 id。
- `name`:内部名称,不要求用户理解。
- `description`:工作方法说明,供主 agent 选择和审计。
- `inputContract`:启动所需输入。
- `outputContract`:最终交付物契约。
- `nodes`:节点定义列表。
- `edges`:节点之间的调度依赖与受控流转关系。
- `policies`:并发、重试、裁决、风险、通知、反馈循环的全局默认值与上限。

Definition 是机制输入,不是运行状态。它可以被多个实例复用。

`edges` 是调度依赖和受控流转的唯一真相源。节点本身不再重复声明 `dependsOn`;节点的 `inputFrom` 只表达数据读取来源,不表达调度顺序。DefinitionValidator 可以从 edges 派生每个节点的上游依赖,但派生结果不反向成为第二套定义。

Edge 至少表达:

- `from`:上游节点。
- `to`:下游节点。
- `kind`:normal / conditional / feedback。
- `condition`:可选的受控条件引用。
- `loopPolicy`:仅 feedback edge 可携带,用于约束反馈循环。

Definition 校验原则:

1. `node.kind`、`executor`、`policy` 必须来自 allowlist。
2. `edges` 必须形成可调度图;默认不允许任意环。
3. 节点输入只能引用明确上游产物、实例输入或常量,不能引用运行时全局隐式状态。
4. 节点输出必须满足 outputContract,否则该节点失败。
5. 风险策略、通知目标、自动裁决策略必须显式声明或走安全默认值。
6. 校验失败的 definition 不创建 WorkflowInstance。

受控反馈是唯一允许的非线性流转形态。它必须通过 feedback edge 的 `loopPolicy` 显式声明,至少包含 stop condition、maxIterations、失败出口和必要裁决点;全局 policies 只能提供默认值和硬上限。不能通过任意环伪装成流程能力。每次反馈迭代都应形成可审计的 NodeRun 记录,这样既能表达"复审未通过回到修复",也不会牺牲可恢复与可追溯。

这条边界是 Workflow 可恢复、可审计、可安全执行的前提。表达力以后可以通过新增受控 node kind / executor / policy 扩展,不能通过开放任意脚本换取短期灵活。

#### WorkflowInstance

WorkflowInstance 是一次真实运行。它绑定 conversation,但不写进普通 transcript 作为聊天内容。

核心字段:

- `instanceId`:运行实例 id。
- `conversationId`:所属对话。
- `origin`:发起来源,用于默认通知和裁决回到哪里。
- `goal`:用户目标与约束。
- `definitionId` 或 `adHocDefinition`:使用的预设或临场定义。
- `status`:运行状态。
- `nodeRuns`:节点执行发生记录。
- `decisions`:裁决记录。
- `artifacts`:节点产物与最终产物。
- `errors`:失败与重试记录。
- `createdAt` / `updatedAt`:可恢复与审计时间锚。

Instance 是 Workflow 的状态权威。重启后恢复从 Instance 读取,而不是从接入面或 agent 上下文推断。

#### WorkflowNode

WorkflowNode 是工作流的基本执行单位。

节点不等于 subagent。节点类型至少包含:

- `agent`:由 agent 执行智能任务。
- `tool`:调用确定性工具或已有能力。
- `gate`:等待裁决。
- `join`:汇总多个上游结果。
- `transform`:做确定性格式转换、筛选、打包。
- `notify`:发出明确目标的通知。

节点核心字段:

- `nodeId`:节点 id。
- `kind`:节点类型。
- `inputFrom`:输入来源。
- `executor`:执行器引用。
- `inputContract` / `outputContract`:节点输入输出契约。
- `retryPolicy`:失败重试策略。
- `riskPolicy`:是否需要裁决或确认。

#### NodeRun

NodeRun 是节点的一次真实执行发生,不是 WorkflowNode 的当前状态。`nodeId` 表示 definition 里的节点,`nodeRunId` 表示该节点在某次迭代或重试中的一次执行。

NodeRun 必须在调度计划落地时创建并持久化,而不是等节点完成后再写入。执行过程中只更新同一个 NodeRun 的状态和产物引用;需要重试、反馈或分支重入时,创建新的 NodeRun。

核心字段:

- `nodeRunId`:执行发生 id。
- `nodeId`:对应的 WorkflowNode。
- `iteration`:受控反馈迭代序号,无反馈时为 0。
- `attempt`:同一 iteration 内的重试序号。
- `triggeredByEdgeId`:触发本次执行的 edge;首轮入口可为空或使用 start edge。
- `status`:本次执行状态。
- `inputArtifactRefs`:本次执行读取的输入产物。
- `outputArtifactRefs`:本次执行写出的输出产物。

核心状态:

- `ready`:依赖满足,可调度。
- `running`:执行中。
- `waiting_decision`:等待裁决。
- `succeeded`:完成且产物落盘。
- `failed`:失败,可重试或终止。
- `canceled`:被取消。
- `skipped`:因裁决或条件跳过。

未满足依赖的节点不创建 NodeRun。`pending` 只是 Scheduler 从 definition edges 和现有 NodeRun 派生出的调度视图,不是持久化执行状态。

恢复边界以 NodeRun 为准:已完成节点不重复执行;运行中节点在宿主重启后按策略整节点重跑或转 failed 等待处理。

同一个 `nodeId` 可以有多个 NodeRun。受控反馈、失败重试、分支重入都必须创建新的 NodeRun,不能覆盖历史运行记录。这样产物、裁决、错误和恢复都能精确绑定到一次执行发生。

#### DecisionRecord

DecisionRecord 是裁决点的事实记录,不是 UI 状态。

核心字段:

- `decisionId`:裁决 id。
- `nodeRunId`:所属 gate NodeRun。
- `nodeId`:所属 gate 节点,用于快速索引和展示。
- `question`:要裁决的问题。
- `options`:可选项。
- `recommendedOption`:系统推荐项。
- `actor`:裁决者,可以是 human、agent、rule。
- `result`:最终选择。
- `rationale`:裁决依据。
- `createdAt` / `resolvedAt`:时间锚。

人类裁决和未来自动裁决使用同一记录形态,区别只是 actor 不同。

DecisionRecord 必须绑定 `nodeRunId`,避免同一个 gate 节点在多轮反馈或重试中产生的裁决互相覆盖。

### 3. 运行时组件

#### WorkflowManager

WorkflowManager 是统一核心里的运行协调者。

职责:

1. 调用注入的 DefinitionValidator 校验并归一化 WorkflowDefinition。
2. 基于校验后的 definition snapshot 创建 WorkflowInstance。
3. 推进节点状态机。
4. 调用 WorkflowScheduler 获取调度计划,并驱动对应 NodeExecutor 执行。
5. 处理节点成功、失败、重试、取消。
6. 管理裁决生命周期:创建并持久化 DecisionRecord、进入等待状态、接收裁决结果并恢复调度。
7. 通过 EventBus 发出进度事件。
8. 将状态写入 WorkflowStore。

WorkflowManager 不渲染 UI,不直接读终端,不拥有接入面逻辑。

WorkflowManager 不直接依赖 orchestrator。它只依赖 core 中的 workflow 契约,并通过宿主装配拿到 DefinitionValidator、NodeExecutorRegistry 和必要的 runtime factory。

WorkflowManager 不维护第二套 definition 校验规则。校验规则归 `DefinitionValidator` 所有;Manager 只消费校验结果并创建实例。

#### DefinitionValidator

DefinitionValidator 是 WorkflowDefinition 的唯一校验入口,位于 core 层。

职责:

1. 校验声明式图结构是否合法。
2. 校验 node kind / executor / policy 是否在 allowlist 中。
3. 校验输入输出契约引用是否可解析。
4. 校验风险策略、通知策略、自动裁决策略是否符合安全默认值。
5. 输出标准化后的 definition snapshot,供 WorkflowManager 创建实例。

server 侧 WorkflowManager 只消费注入的 DefinitionValidator,不复制校验逻辑;这样预设模板、临场生成模板、未来导入模板都走同一条规则,同时不破坏 server 与 orchestrator 的依赖边界。

#### WorkflowStore

WorkflowStore 持久化 WorkflowInstance。它应归统一核心管理,与 conversation 关联,但独立于普通聊天 transcript。

职责:

1. 保存 definition snapshot 和 instance state。
2. 保存 NodeRun、DecisionRecord、artifact、error。
3. 支持按 conversation 查询运行中 workflow。
4. 支持宿主重启后恢复未完成实例。
5. 保证关键状态转换的原子性:创建 NodeRun 与进入 running、节点成功与产物落盘、进入 waiting_decision 与 DecisionRecord 创建不能分裂。

Artifact、DecisionRecord、error 都必须能追溯到 `nodeRunId`;需要展示定义节点时再通过 `nodeId` 反查。Store 不把同一个 nodeId 的多次执行合并成一个状态槽。

#### WorkflowScheduler

WorkflowScheduler 负责节点调度,不是通用任务系统替代品。

职责:

1. 基于 definition edges、NodeRun 状态和 workflow policy 派生 pending 视图并计算 ready 节点。
2. 产出调度计划,包含可执行节点、并发限制、重试选择和受控反馈流转。
3. 保证同一 `nodeId + iteration + attempt` 只允许一个 active NodeRun。
4. 对失败节点应用 retryPolicy,对反馈边应用 loopPolicy。
5. 在 gate 节点处停下,等待已有 DecisionRecord 被解决。

WorkflowScheduler 不写入 WorkflowStore,也不直接执行节点。它只做调度决策;状态变更、事件发出和执行器调用由 WorkflowManager 统一推进。

并发是受控能力,不是越多越好。默认并发应保守,由 workflow policy 明确提高。

#### NodeExecutorRegistry

NodeExecutorRegistry 负责把 node.kind / executor 引用映射到具体执行器。

NodeExecutor 接口与 Registry 契约位于 core;具体执行器由 orchestrator 或未来扩展包实现,再在宿主装配时注册给 server 侧 WorkflowManager。

首批执行器:

- `AgentNodeExecutor`
- `ToolNodeExecutor`
- `GateNodeExecutor`
- `JoinNodeExecutor`
- `TransformNodeExecutor`
- `NotifyNodeExecutor`

执行器是可插拔边界。新增节点能力应通过新增 executor,不要改 WorkflowManager 主流程。

### 4. Agent 节点执行

Workflow 需要一个不绑定 Task surface 的通用 agent 节点执行能力。

它复用现有 subagent 地基,但不复用 Task 工具作为架构入口。原因:

- Task 是 LLM-facing 委派 surface,适合主 agent 在单 turn 中派短任务。
- Workflow agent 节点是 host-managed NodeRun,需要受 WorkflowStore、WorkflowManager、DecisionRecord 管理。
- 两者都能使用同一套底层 agent 执行能力,但不能互相伪装。

AgentNodeExecutor 输入:

- `profile`:节点 agent 身份与指令。
- `toolsPolicy`:允许工具集。
- `budget`:turn、token、wall-clock 等预算。
- `input`:结构化输入。
- `outputContract`:期望输出。
- `parentSignal`:workflow / node 级取消信号。
- `lineage`:workflow/node 血缘路径。

AgentNodeExecutor 输出:

- `status`:succeeded / failed / canceled。
- `output`:结构化输出或文本输出。
- `usage`:资源使用。
- `events`:已通过 EventBus 实时发出,store 只保存必要事实。
- `error`:结构化失败信息。

关键取舍:

1. agent 节点内部不要求断点续传。
2. agent 节点完成后结果必须落盘。
3. agent 节点失败后由 workflow 按节点策略整节点重试、跳过、等待裁决或终止。
4. AgentNodeExecutor 复用现有 EventBus lineage、abort、confirmation、budget、安全执行能力。

### 5. 裁决机制

裁决点是一等节点。它不是异常处理,而是 Workflow 的核心结构。

GateNodeExecutor 的职责:

1. 读取上游节点产物。
2. 生成裁决问题、候选项、推荐项和依据。
3. 返回裁决请求内容和目标建议给 WorkflowManager。

GateNodeExecutor 不拥有裁决生命周期,不直接写入 instance 状态。WorkflowManager / WorkflowStore 负责:

1. 创建并持久化 DecisionRecord。
2. 将对应 NodeRun 与 WorkflowInstance 转入 `waiting_decision`。
3. 通过统一事件或 RPC 边界把裁决请求交给接入面。
4. 接收裁决结果并恢复调度。

裁决者类型:

- `human`:用户明确选择。
- `agent`:独立裁决 agent 在策略允许时自动选择。
- `rule`:规则或信任策略自动选择。

裁决策略:

- 涉及价值观、不可逆后果、责任归属的裁决必须交给 human。
- 低风险、可回滚、规则明确的裁决可以自动化。
- 自动裁决必须留下依据,并能被用户复盘。

这样未来从 human-in-the-loop 演进到 autonomous workflow 时,替换的是 actor,不是 workflow 结构。

### 6. 状态流

一次 Workflow 的标准流:

1. 用户提出复杂目标。
2. 主 agent 判断进入 Workflow,选择预设定义或生成临场定义。
3. WorkflowManager 调用注入的 DefinitionValidator 校验并获得标准化 definition snapshot;校验失败不创建 instance。
4. WorkflowManager 基于 snapshot 创建 instance。
5. WorkflowScheduler 基于当前状态返回调度计划。
6. WorkflowManager 按计划创建并持久化 NodeRun,将其置为 ready / running。
7. WorkflowManager 调用 NodeExecutor 执行节点,事件实时冒泡。
8. 节点成功后写入绑定该 `nodeRunId` 的 artifact,并将 NodeRun 更新为 succeeded。
9. 遇到 gate 节点时,GateNodeExecutor 生成裁决请求内容。
10. WorkflowManager 创建绑定当前 `nodeRunId` 的 DecisionRecord,并将对应 NodeRun 更新为 waiting_decision。
11. 用户或自动裁决者给出 decision。
12. WorkflowManager 根据 decision 和 Scheduler 产出的计划继续、分支、重试、受控反馈、跳过或终止。
13. 所有终态节点完成后产出最终结果。
14. 结果回到 conversation,必要时按明确目标通知发起来源。

宿主重启后的恢复:

1. WorkflowManager 启动时扫描未完成 instance。
2. `succeeded` NodeRun 保持完成。
3. `running` NodeRun 按策略转为 `failed` 或创建新 attempt 重新执行。
4. `waiting_decision` NodeRun 继续等待绑定的 DecisionRecord。
5. 接入面重新连接后只读取状态,不重建状态。

### 7. 事件与展示

Workflow 事件走统一 EventBus,由接入面自行渲染。

核心事件:

- `workflow:started`
- `workflow:node_started`
- `workflow:node_progress`
- `workflow:node_succeeded`
- `workflow:node_failed`
- `workflow:decision_requested`
- `workflow:decision_resolved`
- `workflow:completed`
- `workflow:canceled`

事件只负责观察,不作为状态真相源。状态真相源是 WorkflowStore。

CLI 展示原则:

- 默认展示高层进度,例如"正在进行架构设计 / 等待你确认方向 / 正在修复真实问题"。
- 不刷屏展示所有子节点内部细节。
- 用户需要时可以查看 workflow 摘要、节点产物和裁决记录。

其他接入面展示原则:

- 只显示适合该通道的信息。
- 等待裁决时把裁决问题送到明确目标。
- 不把 CLI 内部执行日志同步到飞书等外部通道。

### 8. 安全与权限

Workflow 必须复用现有安全体系:

- 工具执行走 SecurityPipeline。
- 高风险动作走 confirmation。
- 信任策略走 trust / permission。
- 取消走 abort。
- 接入面不绕过统一核心。

每个节点都应有 riskPolicy。riskPolicy 决定:

- 是否自动执行。
- 是否进入 gate。
- 是否需要用户确认。
- 失败后能否自动重试。
- 是否允许通知外部接入面。

安全原则:

1. Workflow 不因"是内部流程"而降低权限要求。
2. 自动化只减少重复操作,不转移用户责任。
3. 所有高风险裁决必须可追溯。

### 9. 首个可执行切片

首个可执行切片应服务于当前最真实、最高价值的场景:复杂编程任务质量流。

它不是把代码审查流焊进引擎,而是用一个种子模板验证引擎能力。

这个切片的验收重点是地基是否成立:复杂任务能被声明式 definition 表达,能被校验后创建实例,能按节点推进、等待裁决、恢复、重试、反馈循环并交付结果。它不承担完整工作流产品的全部能力,也不要求用户直接编辑 workflow。

模板形态:

1. **目标理解节点**:提取用户目标、约束、成功标准。
2. **多方案设计节点**:多个 agent 独立给出设计方向。
3. **方案收敛节点**:汇总差异、取舍、推荐路径。
4. **裁决节点**:必要时让用户确认方向。
5. **执行节点**:单一执行 agent 按方案实现。
6. **多视角审查节点**:多个 agent 从正确性、集成性、覆盖性、产品设计等维度审查。
7. **真实性验证节点**:过滤不真实问题,输出真实问题列表。
8. **修复节点**:执行 agent 修复真实问题。
9. **复审节点**:通过受控反馈回到修复或进入新的裁决点,直到满足 stop condition 或触发失败出口。
10. **交付节点**:汇总变更、验证结果、剩余风险。

首个切片必须验证这些引擎能力:

- workflow instance 持久化。
- 节点依赖调度。
- agent 节点执行。
- gate 裁决。
- 节点边界恢复。
- 多节点并行。
- 失败重试。
- 受控反馈循环。
- 最终产物归档。

### 10. 不做什么

首版明确不做:

1. 不做用户可视化流程编辑器。
2. 不开放用户手写任意脚本工作流。
3. 不要求 agent 节点内部断点续传。
4. 不把研究流、写作流、代码审查流全部作为首版交付范围。
5. 不新增绕过现有安全体系的执行通道。
6. 不让接入面拥有 workflow 状态。
7. 不把 Workflow 设计成另一个独立 agent runtime。

### 11. 可执行落点

建议代码落点:

- `@zhixing/core`:Workflow 类型、事件类型、状态枚举、DefinitionValidator、NodeExecutor 接口、NodeExecutorRegistry 契约。
- `@zhixing/orchestrator`:AgentNodeExecutor、ToolNodeExecutor、模板选择与临场定义标准化,以及基于现有 subagent 地基的具体执行实现。
- `@zhixing/server`:WorkflowManager、WorkflowStore、实例恢复、RPC 方法;通过宿主装配接收 validator、executor registry 和 runtime factory。
- `@zhixing/cli`:高层进度渲染、裁决交互、状态查看入口。
- channel 包:仅接收裁决请求、通知结果和展示摘要,不拥有状态。

最小内部 API:

```ts
interface WorkflowManager {
  start(input: StartWorkflowInput): Promise<WorkflowInstanceSnapshot>;
  get(instanceId: string): Promise<WorkflowInstanceSnapshot | null>;
  decide(input: ResolveDecisionInput): Promise<WorkflowInstanceSnapshot>;
  cancel(instanceId: string, reason: string): Promise<void>;
  resume(instanceId: string): Promise<void>;
}
```

最小执行器接口:

```ts
interface NodeExecutor<TInput = unknown, TOutput = unknown> {
  run(ctx: NodeExecutionContext<TInput>): Promise<NodeExecutionResult<TOutput>>;
}
```

这两层足够把 Workflow 做成统一核心能力,同时保留未来扩展空间。

### 12. 实施拆分

Workflow 是跨 core、server、orchestrator、cli 的地基能力,不应一次性整体实现。拆分标准不是文件数量本身,而是独立架构层、可独立验证、可独立提交。两三个文件的碎改不构成独立提交单元;单个单元如果边界过大,需要继续细分。

建议拆分:

1. **Core Workflow 内核**:落地 WorkflowDefinition、WorkflowInstance、NodeRun、DecisionRecord、DefinitionValidator、WorkflowScheduler、NodeExecutor 契约。验证重点是图校验、受控反馈、依赖调度、重复 nodeId 的多 NodeRun。
2. **Server Workflow 状态与协调**:落地 WorkflowStore、WorkflowManager、实例创建/取消/恢复、原子状态推进、RPC 内部接口,先用测试 executor 验证。验证重点是重启恢复、waiting_decision、失败重试、状态不从事件推断。
3. **Orchestrator 执行器接入**:落地 AgentNodeExecutor、ToolNodeExecutor,复用现有 subagent、EventBus、confirmation、SecurityPipeline、abort、budget。验证重点是不走 Task surface、不污染主对话、节点结果落盘、失败三态清晰。
4. **种子工作流闭环**:落地复杂编程质量流预设,并接入 WorkflowManager 与执行器注册表。验证重点是不用打磨 UI 也能跑通设计、裁决、执行、审查、真实性验证、修复、复审、交付的最小闭环。
5. **CLI 与接入面体验**:落地 CLI 高层进度展示、裁决交互、状态查看入口、最终交付摘要,并让其他接入面只展示适合通道的信息。验证重点是用户不需要理解 workflow 细节,也能完成裁决、观察进度和接收结果。

实施时先做 Core Workflow 内核。只有当某个单元本身仍然过大时,再按同一原则继续拆分,避免为了拆分而制造不可提交的小碎片。
