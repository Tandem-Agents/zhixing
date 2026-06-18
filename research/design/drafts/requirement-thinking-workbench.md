# 需求思考工作台

## 原则

### 回到需求本质

1. 如果一个产品设计想不明白，一定是脱离了需求本质。
2. 产品设计一定是为需求服务的。此时应该回来想清楚需求：需求不是“应该怎么设计”，而是用户需要什么。

### 判断产品有没有被设计好

1. 如果一个能力需要用户理解一堆新概念、记住一套新流程，它就还没有被设计好。
2. 技术架构必须服务体验，不应该因为已经建了某个底座，就反过来逼产品为它找理由。
3. 产品要有强烈取舍：不是把所有可能性都留下，而是砍到只剩不可避免的本质。
4. 真正伟大的产品，不是把复杂能力暴露给用户，而是把复杂性吞进去。
5. 用户不是来使用功能的，用户是来完成生活和工作的。

## 概念

### 1. 工作流

为了完成一个明确目标，把一组相关任务、参与者、输入输出、先后顺序、并行关系、分支条件、审批/判断点和交接规则组织起来的过程模型。

它描述的不是某个工具或系统能力，而是“事情应该如何从开始流转到完成”：谁在什么时候做什么，做完产生什么结果，结果如何决定下一步。

### 2. Claude Code 的 /workflow 指令

Claude Code 给主 agent 自己使用的一种编排能力。当主 agent 判断某个复杂任务值得多 agent 协作时，它临场写出一段 JavaScript 编排脚本，用确定性控制流调度一批上下文隔离的子 agent。

脚本在后台异步运行，主 agent 提交后不阻塞；完成时收回经 schema 校验的结构化结果，再据此决定下一步。

分工：

1. 确定性代码负责结构：该不该并行、要不要对抗验证、如何综合。
2. 子 agent 负责每一步的智能：各自在隔离上下文里完成被分配的一步。

本质界定：

1. 编排者是 AI 自己，不是用户。脚本由主 agent 按当下任务现写，而非用户在可视化面板拖拽配置。
2. 单个 workflow 是一整段编排，不只是一个并发节点。它可以包含多阶段流程，但不接管整个会话主控制流。
3. 它是 AI 的内功，不是面向用户的功能。用户通常不知道它存在，只感觉到“这次做得又快又好”。
4. 它活在一次任务里，跑完即弃。执行态在内存，不要求可恢复、不跨设备续、不在裁决点长时间挂起等人。

一句话定位：它是“工作流”的一种特定实现形态。它实现了任务编排、并行、分支和结果驱动流转，但不含跨时间持久、人工审批长挂起、可恢复这些维度。

## 思绪池：真实需求和痛点

这里记录的是我真实的工作过程和痛点。不是说下面所有需求一定要做成一个 workflow 能力；它们回归到本质，可能是不同功能。

### 需求 1：关键节点的多视角发散与收敛

真实场景：

在一个开发流程中，遇到设计节点，需要多个模型并发独立思考，然后获取彼此方案，判断谁更好；随后多个模型并发优化，再由一个模型汇总所有优化结果，给出最终设计结果。

后续实现完成后，也需要多个模型并行审查，再由一个模型汇总所有问题，最后交给一个执行力强的模型独立修复。

想法：

这个工作流程本身也像一种工作流。

说明：

1. 这是我实际的工作流程。我在不同 agent、不同模型之间切换，手动让多个模型一起工作。现在所有流程都是手动的，但未来不应该一直手动。
2. 如果要提供功能，绝对不能像“Workflow 架构设计”文档里的内置种子一样把流程写死。写死以后反倒失去价值，因为就算是我自己的流程也是动态的，每个人习惯和方式也不同。
3. Claude Code 的 /workflow 指令有点接近这个方向：现场编写、单次委外，在一次并发节点中使用，主工作流程仍然由用户控制。但我觉得性价比不高，也感觉不会是这个功能的最终形态。

### 需求 2：复杂开发任务的稳定质量节奏

真实场景：

我每次开发、审查时都有一套稳定流程：

1. 让 AI 开始干活。
2. 干完后，用稳定的审查提示词让 agent 审查。
3. 遇到问题，用稳定的修复提示词让 agent 解决。
4. 重复“审查 → 解决 → 审查”，直到审查没有发现真实问题。
5. 再次复核，真的没问题后提交。

我作为用户，其实是在处理中间关键节点：什么时候给哪个提示词、给什么提示词、什么时候推进下一步。这件事可以标准化。

想法：

1. 目前产品中比较贴近这个过程的是 Claude Code 和 Codex 的 /goal 指令，但我用了以后效果不符合预期，或者说和这个工作场景不够贴合。
2. 这个工作流程也像工作流。
3. 最近出现的 loop engineer 也和这个方向接近，或者说 /goal 是 loop engineer 的事件形式。

## 收敛判断

### 1. 两个需求不是同一种东西

需求 1 的本质是“瞬时质量增强”：

就某个问题，临时拉起多个独立视角并行产出，再汇总收敛成一个结论。它是一次性的、用完即弃的，发生在某个节点内部。这是 Claude Code /workflow 干的事情的内核。

需求 2 的本质是“稳定迭代工作方法”：

它是一套每次都在用的、收敛到质量达标的主控制流。它有长流程、有循环、有人在裁决点把关，是会话的主线，而不是一个后台节点。这是 /goal、loop engineer 那一脉。

### 2. 关键结构

这两者不是并列的两个 workflow。

更准确的关系是：

1. **能力 A：多视角发散 → 收敛**。这是原子内功。
2. **能力 B：复杂任务稳定工作方法**。这是用能力 A 编织出来的工作方法。

需求 2 里的“多模型并行审查”那一步，正好就是需求 1 的“多视角发散 → 收敛”。

它们的共同底座是 subagent。所以方向不是做一个 graph 引擎，而是建在 subagent 上的两层薄能力：A 是 B 的构件。

### 3. 当前 Workflow 模块不匹配

当前 Workflow 模块的方向是：声明式 definition + 校验 + 调度 + 持久化 + 写死的 coding-quality 种子。

它和这两个需求都不匹配：

1. 声明式引擎太重、要预定义，做不了需求 1 这种轻量、瞬时、用完即弃的内功。
2. 把流程焊成 graph，也不是需求 2 想要的“可微调的工作方法”。
3. coding-quality seed 把人的经验钉死成固定 DAG，正好违背“不能把流程写死”的真实需求。
4. 继续改进这个引擎，会变成因为已经建了底座，所以反过来为它找产品理由。

因此，重构第一步不是改进它，而是把声明式引擎和种子砍掉或封存，回到 subagent 地基。

### 4. 后续方向

#### 能力 A：多视角发散 → 收敛内功原语

把“多视角发散 → 收敛”做成知行的一个内功原语，而不是让 AI 临场写脚本。

它应该是一个参数化原语：主 agent 一次调用，就能围绕某个问题派出 N 个独立视角，再把结果收敛回来。

固定的是拓扑：

1. 多视角并行。
2. 独立产出。
3. 结构化回收。
4. 汇总收敛。

动态的是内容：

1. 视角数量。
2. 视角定义。
3. 每个子任务的提示词。
4. 收敛标准。

这样既不需要用户学习 workflow，也不需要 AI 每次现写脚本。它对用户完全隐形，由主 agent 判断什么时候该用。设计、审查、研究、重要决策都可以使用。

#### 能力 B：复杂任务内建工作方法论

把稳定开发流程做成知行内建的复杂任务工作方法，而不是让用户搭流程。

这里要区分“写死”和“稳定”：

1. 稳定的是方法骨架和节奏：开发 → 审查 → 修复 → 收敛 → 复核 → 交付。
2. 动态的是每步内容：审查什么、怎么审查、怎么修复、是否需要并发、是否需要对抗验证。
3. 可微调的是边缘：不同用户、不同场景、不同工作模式下的默认偏好。

正确形态不是“固定 graph + 固定节点内容”，而是：

1. 骨架内建。
2. 内容由 AI 临场生成。
3. 关键节点由用户裁决。
4. 审查可调用能力 A。
5. 真实性验证过滤误报。
6. 收敛有明确判据。

这样用户不再手动递模板。知行应该天然会用这套方法做复杂开发，用户只在真正需要担责的节点被问一句。

### 5. 元判断

停止追求“统一 workflow 引擎”这个抽象。

前面几轮一直在引擎形态上打转：声明式还是脚本、可恢复还是临场执行。但这其实是在为底座找理由。

回归本质，Workflow 模块的未来不是一个引擎，而是两个建在 subagent 上的薄能力：

1. **能力 A：多视角发散 → 收敛内功原语**。
2. **能力 B：复杂任务内建工作方法论**。

能力 B 使用能力 A。

这个方向甚至不该叫给用户看的“workflow”。用户不需要使用工作流，用户只需要知行更会组织复杂工作。

---

## 回退方案(当前阶段:只退不进)

> 「收敛判断 §3」已定调:重构第一步不是改进声明式引擎,而是砍掉它、回到 subagent 地基。本节把这一步落成可执行方案。**本阶段只退**——前进(能力 A / B)见「收敛判断 §4」,退干净后另立单元,本方案不含。

### 范围与边界

- 退的对象:仅声明式 Workflow 模块(core / server / orchestrator 的 workflow 目录 + 宿主装配 + RPC)。
- 不碰:`edit` / `write` 的 diff 渲染能力(独立 feature、已验收),以及 subagent / `runChildAgent`、EventBus lineage、confirmation / trust / permission、scheduler、conversation / runtime / tools 等地基。
- 资产保全:workflow 是一串干净的连续 commit,**git 历史本身就是封存**——删工作树不丢资产,将来真要可精确 cherry-pick;不建归档分支、不留搁置目录(半死代码 = 认知债)。
- 选型:采纳 `workflow-real-value-lab.md` 的**方案二(删到 subagent 零残留)**;方案一(core-only 保留纯内核)作废——声明式 graph kernel 不是中立资产,它本身就是方向押注。

### 一、裁撤范围核对清单

> 本节不是手工删除步骤,只用于核对 `git revert` 后声明式 Workflow 是否已退干净。执行权威见「五、执行方式」。

**应不再存在的目录 / 文件:**

- `packages/core/src/workflow/`(types / graph / scheduler / validator / executor / index + __tests__)
- `packages/server/src/workflow/`(manager / store / index + __tests__)
- `packages/orchestrator/src/workflow/`(agent / tool / gate / join / transform-node-executor / result / config / coding-quality-workflow / index + __tests__)
- `packages/server/src/rpc/methods/workflow.ts` + `__tests__/workflow.test.ts`

**应不再存在的运行时装配 / public API:**

- 顶层 re-export:`core/src/index.ts`、`server/src/index.ts`、`orchestrator/src/index.ts` 中不再导出 workflow。
- orchestrator runtime 中不再有 workflow import、`createWorkflowNodeExecutorRegistry`、`WorkflowNodeExecutorRegistryOptions`、`workflowBus` 或对应 re-export / 测试入口。
- server 中不再有 `WorkflowManager` import、`ServerContext.workflow`、`CreateContextOptions.workflow`、`workflow.*` RPC 注册、`recoverUnfinished` 启动恢复调用或相关测试断言。
- cli `serve/command.ts` 中不再装配 `JsonWorkflowStore` / `WorkflowManager` / `DefinitionValidator` / `workflowExecutors`,也不再向 context 注入 `workflow: workflowManager`。

**容易漏的非 workflow 路径也必须核对:**

- `packages/core/package.json`
- `packages/orchestrator/package.json`
- `packages/core/tsup.config.ts`
- `packages/orchestrator/tsup.config.ts`

这些文件不在 workflow 目录、部分文件名也不含 workflow,证明本回退不能靠手工清单执行。

**revert 后必须恢复保留的例外:**

- `packages/orchestrator/src/security/secure-executor.ts`:这是通用安全管线增强,让 confirmation broker 在等待用户确认时响应 `abortSignal`;它影响 bash / edit / write 等所有走 broker confirmation 的工具,不是 Workflow 专属能力,不能随 Workflow 回退。
- `research/design/drafts/workflow-architecture.md`:当前需要保留新的判断版,并补状态头说明该文档已降级为历史探索记录。

**不误伤:** `AgentEventMap` / `NodeExecutorRegistry` / `createEventBus` / `runChildAgent` 等通用件保留;已确认 `AgentNodeExecutor` 只消费 `runChildAgent`、未改子 agent,删 workflow 对 subagent / Task / unified-core / diff 渲染零影响。`diff` 库属 CLI diff 渲染 feature,必须保留。

### 二、架构文档改造

- `workflow-architecture.md`:顶部加状态头——"已裁撤;全文降级为声明式方向的历史探索记录,不再是当前有效方案",指向本工作台结论。**不逐段删、不删文件**(保留探索价值,失效由状态头声明)。
- `workflow-real-value-lab.md`:标注"已采纳方案二、执行回退",方案一作废。
- `CLAUDE.md` 模块索引未单列 workflow,无需改。

### 三、验证(收尾一次全量)

- 全量 `pnpm build`:core 的 `index.ts` 少了 workflow 导出 = 公共 d.ts 变化,必须全量重建下游,不能只 `cli:build`。
- clean 重建或显式清理旧产物,确保 `packages/core/dist/workflow` 和 `packages/orchestrator/dist/workflow` 不再残留。
- 全量测试绿;各包 `tsc --noEmit` 零错(接口 / 类型删除的残留引用靠 tsc 兜出)。
- `grep -ri workflow packages/*/src` 用于扫残留,最终判准不是字面零命中,而是**生产代码、运行时装配、public API 和测试入口无 Workflow 产品能力残留**;普通英文注释、历史说明、非运行路径如有必要可保留,但不能形成可启动、可导入、可调用的 workflow 概念。已知允许残留:`packages/core/src/typeahead/types.ts` 中 4 月已有的通用标签 `"workflow"` 示例,它不是本模块能力。
- serve 冒烟:RPC 方法表无 `workflow.*`、启动不再调 `recoverUnfinished`、subagent / Task / diff 渲染如常。
- 如曾运行过 Workflow 实例,清理 `~/.zhixing/workflow/instances.json` 这类孤儿运行数据;代码库不再拥有读取或恢复它的能力。

### 四、前进(占位,本阶段不做)

退干净后另立单元,按「收敛判断 §4」建:能力 A(多视角发散→收敛内功原语)+ 能力 B(复杂任务内建工作方法论,B 用 A),共同底座 subagent,对用户隐形、不叫 "workflow"。本方案不含前进实现。

### 五、执行方式:用 git revert,不要手工删 / reset

当前 Workflow 实现是一串连续提交,后面已经有独立且要保留的 CLI diff 成果。因此回退方式应是 **git revert Workflow 实现提交**,而不是手工逐文件删除,也不是 reset 回到 Workflow 前。

本节是唯一执行权威。「一、裁撤范围核对清单」只用于 revert 后核对,不能当手工删除步骤。

需要回退的 Workflow 提交:

1. `2cc3f90 feat(core/workflow): add workflow runtime kernel`
2. `04b04f8 feat(workflow): add server workflow state coordination`
3. `dede77f feat(orchestrator/workflow): add workflow node executors`
4. `e7aeffd feat(workflow): add coding quality seed workflow`
5. `0989ba0 feat(workflow): add CLI work surface`
6. `518014f fix(workflow): remove external work command surface`

必须保留的后续成果:

1. `8307da7 docs(cli): add edit diff rendering plan`
2. `f06da97 feat(cli/diff): render file edit diffs in CLI`

执行策略:

1. 先处理当前已暂存 / 未提交的文档变更,避免和 revert 混在一起。
2. 使用 `git revert --no-commit 2cc3f90^..518014f` 反向应用上述 Workflow 提交;该范围会按提交历史自动逆序应用,聚成一次回退变更。
3. 已核实 Workflow 回退范围与 CLI diff 成果零文件重叠,不会误伤 `8307da7` / `f06da97`。
4. revert 后恢复两个例外文件:`packages/orchestrator/src/security/secure-executor.ts` 和 `research/design/drafts/workflow-architecture.md`;前者保留通用 confirmation abort 能力,后者保留当前判断版并补状态头。
5. 按「一、裁撤范围核对清单」检查残留。
6. clean 重建或显式清理旧 dist workflow 产物;如本机存在旧 workflow 实例数据,清理孤儿数据。
7. 形成一个单独回退提交,表达为移除声明式 Workflow runtime,而不是开启新方向。

为什么不用 reset:

1. reset 到 Workflow 前会误伤后面的 CLI diff 文档和实现成果。
2. Workflow 的算法资产不需要留在工作树,git 历史本身就是封存。
3. revert 能保留决策历史,也能让代码库回到零残留状态。

为什么不用手工删:

1. Workflow 涉及 core / server / orchestrator / cli / RPC / runtime 装配 / 测试 / public export,手工删容易漏半截。
2. 已核实 Workflow 实现串实际影响 46 个文件,其中 package.json、tsup 配置等不在 workflow 目录、文件名也不含 workflow;手工清单天然容易漏。
3. 这串提交里还夹带了 `secure-executor.ts` 的通用安全增强,它必须保留;revert 后恢复例外文件比手工判断每个改动更可靠。
4. 这些能力来自连续提交,revert 能天然按提交边界撤销。
5. 手工删会把“撤销历史实现”和“补充新判断”混在一起,不利于审查。
