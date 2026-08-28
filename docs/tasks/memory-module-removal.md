# 当前记忆模块彻底剔除

> 状态：待用户确认<br>
> 当前检查点：M8：同基线验收与五面对抗已通过，等待用户验收<br>
> 完成度：8/8
> 职责：从知行当前产品与工程基线中完整移除现有记忆模块，同时保持历史对话持久化和全部非记忆能力不变。

## 一、任务目标

在同一最终代码基线上达成以下结果：

1. 现有记忆模块的生产实现、调用链、公开入口、协议合同、存储接管、测试夹具、构建出口和现行文档全部退场，不保留禁用分支、兼容壳、别名、影子入口或待以后复用的旧实现。
2. 删除记忆模块后，知行除“不再提供现有记忆能力”外没有功能回退；启动、对话、历史查看与恢复、上下文管理、工具执行、权限、任务、技能、工作模式、服务端、分布式运行时及打包交付继续成立。
3. 历史对话持久化完整保留。它不是本任务所称的记忆模块，任何工作包均不得把二者混删。
4. 为后续架构演进建立真实、干净的无记忆模块基线；本任务不决定、设计或接入未来记忆方案。

## 二、对象定义与硬边界

### 2.1 必须剔除的记忆模块

本任务中的“记忆模块”仅指把对话之外的信息长期保存并在后续工作中主动读写、检索或提炼的现有能力，包括：

- Profile、People、Journal 及其个人/工作场景逻辑记录、物理存储、规范身份、查询和变更合同；
- `memory` 内置工具、默认 Agent 工具配置、系统提示注入、CLI/TUI 展示和 server RPC；
- `MemoryFlusher`、段切换记忆提取、收养后记忆回放及其 owner 日志记录；
- distributed-runtime 中的 memory/people/journal 全局状态、提交、查询、唯一 owner、维护、接管和旧 Markdown 投影；
- 对外导出、构建入口、注册表、golden、示例、当前规格和仅为上述能力存在的测试与夹具。

### 2.2 必须保留的历史对话持久化

以下能力是对话连续性基础设施，不属于记忆模块，必须保持原合同和真实行为：

- `core/transcript` 的 run 原文、clear 边界、分片、保留与恢复；
- owner 提交日志中的会话权威事实、run 提交、transcript 投影、会话元数据和 owner 转移；
- session/conversation 的创建、切换、恢复、历史浏览、删除和崩溃重驱；
- attention window、上下文压缩、segment 边界、摘要和启动装填；其中只删除“从 segment 提炼长期记忆”的支路，不删除 segment 或上下文本身；
- RPC、CLI、server 和渠道对上述会话事实的投影与消费。

### 2.3 不以名称裁决边界

不得因为源码里出现 `memory` 一词就机械删除。进程内数据、缓存、内存占用、模型上下文、历史记录以及与记忆模块无关的通用 frontmatter 处理均按真实职责裁决。反过来，也不得通过改名隐藏仍在工作的长期记忆能力。

## 三、当前事实基线

现有记忆模块不是一个可直接删除的独立包，而是一条跨包纵向能力，当前至少覆盖：

- `packages/core/src/memory/` 及 `@zhixing/core` 根导出、`./memory` 子路径和独立构建入口；
- `packages/tools-builtin/src/memory.ts`、工具工厂、默认 profile、系统提示和工具呈现；
- orchestrator 的记忆端口、Memory Flush 与 segment hook 装配；
- server 的三项 memory RPC，CLI 的管理目录、setup delivery、post-adoption memory 和 mesh 装配；
- core 全局状态/提交/查询合同，owner-kernel 的 segment memory 输入与 post-adoption memory 日志合同，runtime-host 的 memory/people 工作模式工具；
- distributed-runtime 的全局状态 owner、能力资源、assignment 签发、旧状态接管、维护注册与结构门禁；
- 当前记忆规格、架构演进文档及其他仍把它描述为现行能力的文档。

已确认的关键交界及唯一裁决如下：

| 当前交界 | 裁决 |
| -------- | ---- |
| Skills、Rubrics 与暂存活的 memory 实现共同消费 core 根 `frontmatter.ts` | M2 已把通用原语迁至中性 owner 并保持合同；后续删除 memory 目录时保留该 owner，Skills、Rubrics 不属于记忆模块。 |
| `createAgentRuntime` 以显式 `worksceneIdentity` 决定技能分区、场景信任上下文和 lifecycle `sceneId`；`memoryScope` 只剩记忆职责 | M2 已解除错误耦合；后续删除记忆 scope 不得改变技能隔离、权限/信任语义和场景生命周期。 |
| owner 从已提交 transcript 重建 segment-memory 输入，post-adoption memory 又依赖收养/转移主链 | 只删除长期记忆派生输入、记录和回放；transcript、segment、收养/转移、post-adoption review 及恢复顺序保持不变。 |
| workscene 同时具有场景身份、对话目录和 `/me` 记忆目录，且公开 `workscene_memory_query` | 删除记忆目录 helper、清理端口和查询工具；保留场景注册、工作区、会话目录及其他工作模式工具。 |
| memory 工具使用通用 `app-state` 安全边界，部分通用协议/发布测试以 memory mutation 作样本 | 删除记忆注册和样本，不删除通用安全边界；通用测试改绑仍存活的真实域并保持原断言强度。 |

`Journal` 还用于 Authority/Run 等通用耐久日志，`memory` 也可表示进程内存或缓存；这些名称只有反绑第 2.1 节产品语义后才可删除。

`post-adoption-memory-*` 当前是会话 run 权威流中的严格内部记录，memory owner 也进入检查点、generation 与在途生命周期的精确集合。M1 已证明这些事实若进入兼容集合，删除其 decoder/参与者会与受保护恢复事实冲突；用户最终确认知行尚未正式发布、没有真实用户，首次正式发布前生成的 memory-bearing 开发数据不纳入兼容范围。首个正式版本因此以记忆剔除后的格式为兼容起点，不保留旧 memory reader/participant，也不建设发布前数据迁移；历史对话持久化仍按第 2.2 节完整保护。

本节只记录建任务时已确认的入口，不是允许遗漏的封闭文件清单。实施前必须从生产组合根正向追踪，再从仓库引用反向核对，建立最终可达闭包。

## 四、实施状态

每项 `[x]` 表示该项的生产实现、消费链、直接测试、必要文档和本轮证据已在当前基线上同时闭合；只改代码或只让测试变绿都不得勾选。

- [x] **M1　冻结真实闭包与兼容基线。** 从 CLI、server、orchestrator、runtime-host 和 distributed-runtime 生产组合根正向追踪，再按符号、协议、路径和文档引用反查，形成“删除 / 中性迁移 / 保护 / 历史保留”四类闭包；独立建立历史对话保护闭包，并核实记忆专属事实是否已进入本版本承诺兼容的会话日志、检查点、generation 或未完成操作。把稳定入口、消费方、裁决、发布/数据支持依据和代表性直接证据登记在本文 M1 执行记录中；未分类事实不得进入批量删除。完成证据是双向调用图与兼容基线同时闭合，不是文件清单或搜索命中数。
- [x] **M2　先解除错误耦合。** 迁移通用 frontmatter 原语并保持 Skills/Rubrics 合同；把技能 main/work 分区、scene 信任上下文和 lifecycle `sceneId` 改为只由既有 workscene/runtime 身份提供，不再借 `memoryScope` 决定。以对应单元测试和真实 RuntimeHost 装配证明行为等价；本项不删除记忆能力，也不新建通用框架。
- [x] **M3　删除 Agent 公开能力与产品表面。** 删除 `memory` 工具及导出/工厂/AgentRoleProfile 工具声明、系统提示、CLI/TUI 呈现、`/me`、`/journal`、`/people`、server memory RPC、管理 facade/directory、`workscene_memory_query`、帮助/README，以及尚无实现但保留旧能力语义的 `@memory:` typeahead 占位；默认与用户配置均不得再解析出旧工具。同步公开工具和命令 exact-set；保留 AgentRoleProfile 机制、文件/工具补全、其他工作场景工具及通用 `app-state` 权限边界，并以生产注册入口和直接测试证明无影子入口。
- [x] **M4　删除自动记忆与维护链。** 移除 orchestrator 记忆端口、Memory Flush、segment hook、post-adoption memory 输入/记录/回放、mesh 绑定、对应 provider 调用治理与 S7 注册，以及 journal maintenance 的 scheduler/system-handler/生命周期装配。保留 segment/摘要/窗口、transcript 提交、收养/转移、post-adoption review、scheduler 本体、transcript retention 和失败恢复主链；用真实组合根与失败/重启测试证明只断开派生支路。
- [x] **M5　删除分布式状态与 owner 协议面。** 移除 memory/people/journal 的 global query/result/mutation/commit domain、codec、invariant、唯一 owner、维护合同和 product-language；删除 `memory-domain:*` 资源类型、conversation/job assignment 签发、stager 验权、场景删除的 memory cleanup 以及 generation install/rebind/router/participant exact-set 中的 memory owner。保留其他全局域、assignment、AuthorityCapability、workscene 删除及对话清理语义；通用协议测试若以 memory 作样本，改绑仍存活域而不削弱断言。
- [x] **M6　删除存储、接管与 core 记忆域。** 在所有消费者退场后，删除 Anchor memory adapter、legacy Markdown import/projection、cutover/维护状态、Profile/People/Journal store、逻辑身份、`getMemoryDir`/`getWorkSceneMemoryDir`、`core/src/memory`、根导出、`./memory` 子路径和构建入口。保留 workscene 根与会话目录。以首次启动、升级、恢复、转移和维护入口证明旧目录零创建、零扫描、零读写、零迁移；既有用户数据保持原样且完全惰性。
- [x] **M7　收敛测试、结构门禁、制品与现行文档。** 删除只证明旧能力的测试、fixture、snapshot、golden 和示例；通用 owner、assignment、发布、安全测试中以 memory 作样本者改绑存活域并保持识别力。同步 contracts lint、S7 entry/registry、package exports、runtime baseline、server golden 和 tarball；删除现行记忆规格及其索引，把公开文档、distributed-runtime 三份核心文档和架构演进的当前结论改为无旧记忆模块基线。明确历史材料仍是历史；不得清洗归档、改写架构演进“原始构想”或让历史内容重新成为当前授权。
- [x] **M8　同基线验收与冷启动对抗。** 先完成失效闭包的直接验证，再冻结源码、测试、构建配置、现行产品/架构文档、构建产物和验收输入，执行最终门禁。随后抛开既有清单，从五个独立方向主动寻找反证：真实生产可达性；历史对话/上下文连续性；非记忆功能交界；旧数据与首次启动/升级/恢复/转移/维护副作用；公开协议、制品和现行文档。每一面登记攻击目标、实际动作、证据与结论；发现真实问题即恢复受影响 M 项和退出门为 `[ ]`，修复后整轮重做，直至同一未修改产品基线无未处置 P0/P1。

## 五、工作包与状态维护规则

1. 本文是本任务目标、状态和结束条件的唯一工作契约。调度者每轮先读取本文、执行记录和目标对话最新状态，核对当前工作区，再派发能够闭合一条生产责任链的最小完整工作包；不得依赖对话记忆补全边界。
2. 工作包必须写清：对应 M 项、当前基线与检查点、生产端和全部直接消费端、保护边界、明确不做、最窄直接证据、完成条件及安全交接点。不得把同一责任链拆成只删 producer 或只改 fixture 的半成品，也不得一次横跨多个无共同根因的 M 项。
3. 唯一依赖顺序为 M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8；直接测试与必要文档随 M2～M6 同步更新，M7 只收束跨项结构证据和残留。上一项未在可构建检查点闭合，不得启动下一项。
4. 状态只反映当前工作区事实：首个工作包开始时改为“执行中”；阻塞时写明已查清事实、唯一阻塞和可恢复检查点；M8 开始时改为“对抗复核中”；全部退出门成立后改为“待用户确认”。未经用户确认不得标记“已完成”。
5. `[x]` 只表示该 M 项全部生产端、消费端、保护回归、必要文档和当前基线直接证据同时成立。每次更新须登记 `HEAD + 本任务相关工作区差异标识`、执行命令/静态证据、结果、遗留问题和下一检查点；执行者自报或历史绿灯无效。
6. 后续任何源码、测试、现行产品/架构文档、构建配置、制品或验收输入变化，只要可能影响已勾选结论，立即把对应 M 项及受影响退出门恢复为 `[ ]`，作废旧证据并只重验失效闭包。本文中不改变目标、边界、M 项或退出门的纯状态/证据追加不属于产品基线变化；其他任务契约改动照常使相关证据失效。不得保留带条件的 `[x]`。
7. 目标对话只修改工作区，不执行 Git 暂存、取消暂存、提交、历史改写或推送；保留用户已有变更，尤其不得覆盖已暂存的架构演进文档。
8. 发现新入口时，只有同时证明它属于第 2.1 节定义且当前生产或现行合同可达，才补入对应 M 项；未来记忆、通用框架、顺手重构和无事实依据的增强不得扩入本任务。

## 六、实施约束

1. **只做删除，不做替代。** 不接入 OWNWARD，不设计新记忆，不新增面向未来的抽象层、适配层、feature flag 或扩展点；M2 为保住现有非记忆合同所需的最窄中性归属不在此禁令内。
2. **不保留兼容壳。** 旧接口、旧协议、旧目录 reader、禁用配置、deprecated export、空实现和只为兼容旧测试存在的路径均属于残留。
3. **不破坏用户数据。** “彻底剔除”指彻底移除产品能力和工程责任，不授权删除用户设备上已有的私人数据。最终程序必须对旧数据零读取、零写入、零扫描、零迁移；是否另行提供数据清理只能由用户单独决定。
4. **不改变非记忆合同。** 非记忆行为的变更只能是删除旧依赖所需且行为等价的最窄结构调整；不得借机改变对话、上下文、权限、工具、技能、任务、工作模式、调度、Authority/Run Journal 或 distributed-runtime 的产品语义。
5. **不抹除历史。** 现行文档必须反映无记忆模块基线；历史研究、决策和复盘中的事实记录不做无差别文字清洗，但必须与当前实现和未来授权清楚隔离。
6. **不以绿灯代替闭包。** 删除源码后编译通过，不等于公开入口、协议、数据访问、制品和文档已经退场；每项必须按生产调用图双向核对。

## 七、验证策略

执行任何验证前先读取 `research/design/workbench/verification-runbook.md`，遵守当前 Windows 低资源机器的串行、一次取证和失效闭包规则。

1. **渐进验证：** 每个工作包先跑最窄静态检查、直接测试和受影响包构建；上游变化先产出新 `dist` 再测下游。串行执行，只重跑失效闭包，不把旧产物或资源超时误判为功能失败。
2. **历史对话保护：** 直接覆盖 run 提交与重启重驱、transcript 分片/原文/clear、conversation/session 创建切换恢复删除与历史浏览、attention window/bootstrap/segment/摘要、owner 转移/收养，以及 RPC、CLI、server、渠道投影；必须证明删除的只是长期记忆派生支路。
3. **非记忆交界保护：** 直接覆盖 Skills/Rubrics frontmatter、技能场景分区、scene 信任/权限上下文、runtime lifecycle、其他 workscene 工具与删除流程、scheduler 与 transcript retention、通用 assignment/authority/app-state 安全链。把通用测试中的 memory fixture 改绑存活域时，断言数量不重要，原先要识别的语义必须仍可失败。
4. **删除性证明：** 从生产组合根、公开注册和打包后入口证明旧工具/命令/RPC/typeahead、自动链、全局协议、能力资源、owner/维护、存储接管均不可达；对搜索命中逐条归类。历史材料、Authority/Run Journal、进程内存等合法命中不要求清零。
5. **最终门禁：** M1～M7 完成后冻结同一基线，依次执行 `pnpm contracts:typecheck`、`pnpm contracts:lint`、`pnpm runtime:baseline`、`pnpm runtime:package-exports`、根级 `pnpm lint`、`pnpm test`、`pnpm build` 和 canonical `pnpm package:check`；复用本轮产物与证据，不并发运行重型命令，不重复全测。
6. **失败处理：** 先归因再修复；不得放宽业务断言、删除保护性测试、更新无识别力 snapshot、增加豁免或以 mock/源码入口代替生产组合根与 tarball 证明。

## 八、最终退出门

只有以下条件在同一未修改产品基线上全部成立，技术工作才算完成：

- [x] M1～M8 全部为 `[x]`，执行记录与当前工作区事实一致。
- [x] 生产调用图中不存在现有 Profile、People、memory Journal、`memory`、`workscene_memory_query`、Memory Flush、post-adoption memory 或其等价改名能力。
- [x] core/tools/orchestrator/owner-kernel/runtime-host/server/CLI/distributed-runtime 中不存在旧公开导出、AgentRoleProfile 记忆工具声明、提示/typeahead、命令/RPC、global query/mutation、`memory-domain:*` 能力资源、owner/维护、迁移、reader/writer 或组合入口。
- [x] 默认安装、首次启动、升级、恢复、会话转移和维护均不创建、扫描、读取、写入或迁移旧记忆位置；既有用户数据未被删除或改写。
- [x] 历史对话持久化及其所有产品投影通过直接回归，存储事实、对外合同、恢复能力和连续性无可观察变化。
- [x] Skills、Rubrics、权限/信任、任务、工作场景、scheduler、Authority/Run Journal、其他工具及全部受影响非记忆功能通过交界回归，行为变化仅为旧记忆能力消失。
- [x] package exports、runtime baseline、S7/registry/server golden、帮助和 tarball 不再暴露旧能力；现行记忆规格已退场，其他现行文档不再授权旧合同或把旧模块列为待迁移对象，历史事实仍清楚隔离。
- [x] contracts typecheck/lint、runtime baseline/exports、根级 lint/test/build 和 canonical package check 全部通过，证据来自当前同一基线且无未处置 P0/P1。
- [x] M8 五面对抗有实际动作和可核查记录；没有以历史绿灯、mock、自报、文件清单或单纯关键词搜索代替生产事实。

满足后将本文状态更新为“待用户确认”，保留全部勾选与证据并停止。用户确认前不得删除本文、开始未来记忆方案或进入架构迁移实施。

## 九、执行记录

| M 项 | 状态 | 当前基线与直接证据 | 遗留问题 | 下一检查点 |
| ---- | ---- | ------------------ | -------- | ---------- |
| M1 | 已完成 | `HEAD 2af063e8`；差异标识 `memory-removal-M1-compat-decided-20260827`。双向调用图、历史对话保护闭包和三层兼容事实均已闭合；用户确认知行尚未正式发布、没有真实用户，发布前 memory-bearing 开发数据不属于兼容承诺。 | 无。首个正式版本以记忆剔除后的格式为兼容起点；不得保留旧 decoder/participant、扫描或迁移发布前开发数据。 | M2：先迁出通用 frontmatter，再拆除非记忆 scene 语义对 `memoryScope` 的借用。 |
| M2 | 已完成 | `HEAD 2af063e8`；差异标识 `memory-removal-M2-neutral-frontmatter-workscene-identity-20260827`。frontmatter 唯一实现已迁至 core 中性文件 owner，包根只显式转导既有 `parseFrontmatter` / `stringifyFrontmatter` 函数；`worksceneIdentity` 独立驱动 work 技能、scene 信任/权限与 lifecycle，RuntimeHost 和 CLI executor 均从既有场景/对话身份显式传入。core/orchestrator/runtime-host 的 typecheck+build、CLI build 和 139 个直接测试通过。 | 无 M2 遗留。CLI 规范 typecheck 仍报告 HEAD 已存在且本包未触碰的 `mesh-runtime-assembly.ts:1803` 未使用参数；关闭该既有告警后同一 typecheck 通过，不影响本包类型与产物结论。 | M3：从默认 profile/工具工厂到 CLI/server/工作模式表面完整删除旧记忆公开能力。 |
| M3 | 已完成 | `HEAD 4ab15b91`；差异标识 `memory-removal-M3-public-surface-20260827`。builtin 工具、默认 profile/提示、CLI/TUI 三命令与呈现、server 三项 RPC、runtime-host 场景查询和 typeahead 占位已沿生产注册根及直接消费链删除；331 项 Vitest、21 项 canonical S7 Node exact-set 测试、受影响包静态验证与构建共同证明无影子入口且存活集合未漂移。协调反证暴露的角色正向旧工具断言与 typeahead 旧专门语义均已纠正。 | 无 M3 遗留。自动 flush/segment/post-adoption/journal maintenance、全局 memory 协议/owner/store 仍按 M4～M6 边界原样存活，不属于本项残留。CLI 规范 typecheck 仍只有 HEAD 既有的 `mesh-runtime-assembly.ts:1803` 未使用参数，关闭该 hygiene 检查后完整通过。 | M4：从 orchestrator/owner/CLI 组合根删除自动记忆、post-adoption memory 与 journal maintenance 派生支路。 |
| M4 | 已完成 | `HEAD 8bf34c44`；差异标识 `memory-removal-M4-auto-pipelines-20260827`。Segment→Memory Flush、post-adoption memory 和 journal maintenance 三条生产/耐久/恢复/治理链均已删除；826 项直接 Vitest、21 项 S7 mutation 测试、canonical `pnpm s7:lint`、受影响包构建与 CLI typecheck 通过，保护链仍成立。 | 无 M4 遗留。M5/M6 所属的 global memory 协议、owner/adapter authorization、generation/assignment、Profile/People/Journal store 与 legacy 接管仍原样存活，但已无 M4 producer/consumer。 | M5：删除分布式状态与 owner 协议面。 |
| M5 | 已完成 | `HEAD fce81f98`；差异标识 `memory-removal-M5-distributed-protocol-owner-20260828`。core 全局 query/result/staged mutation、严格 codec/invariant、共享 People DTO/store 转导与 `memory-domain:*` 资源均已退场；conversation/job 签发、stager、publish product-language、setup/router/generation participant 和恢复重绑不再承载 memory owner。273 项直接 Vitest、受影响包 typecheck/build、contract schema lint、canonical S7 21/21 与 registry golden 通过。 | 无 M5 遗留。M6 所属 adapter/store/legacy projection/cutover/path/core memory 子路径仍在源码中，但 adapter 已脱离 `GlobalStatePort` 与共享 discriminant，生产组合根、assignment、router、generation、participant 均不可达。 | M6：删除 adapter、legacy 接管、Profile/People/Journal store、路径、core memory 域及 package 子路径。 |
| M6 | 已完成 | `HEAD 5e2fce52`；差异标识 `memory-removal-M6-storage-core-domain-20260828`。`core/src/memory` 的 adapter/store/legacy/cutover/Profile/People/Journal 域、根转导、`./memory` 子路径、tsup 入口及两项旧路径 helper 已退场；131 项直接 Vitest、core/CLI typecheck+build、runtime package exports 与隔离 sentinel fs 拦截证明旧目录零访问，frontmatter、workscene registry/conversations 和会话清理不回退。 | 无 M6 遗留。现行/历史文档、跨包 fixture/golden、tarball 与最终结构总收敛按 M7 边界处理；S7 对旧 adapter 的负向禁止断言继续保留。 | M7：收敛跨包测试/门禁/制品和现行文档。 |
| M7 | 已完成 | `HEAD 8594806e`；差异标识 `memory-removal-M7-tests-gates-artifacts-docs-20260828-r2`。四处通用测试 fixture 与 S7 writable-owner 样本改绑存活域；现行规格、公开/架构授权和 distributed-runtime 旧合同退场。协调反证暴露的 16 处 workscene/安全边界/运行时当前旧语义已纠正；累计 94 项直接 Vitest、contracts 两项门禁、两轮 canonical S7 21/21 + registry golden、runtime baseline 与 177-entry core tarball 检查通过。 | 无 M7 遗留。DEPRECATED/HISTORICAL 正文、退役负向门禁、第三方事实及非产品同名按分类保留；M8 根级 lint/test/build、canonical package check 与五面对抗尚未运行。 | M8：冻结当前工作区，执行最终同基线门禁与五面对抗复核。 |
| M8 | 已完成 | `HEAD 231bd8ef`；差异标识 `memory-removal-M8-final-adversarial-20260828-r3`。八项 canonical 门禁在同一最终产品基线上通过；根级测试 602 文件、8647 项通过，五面对抗另取得 298 项代表性直接测试、真实 import/RPC/CLI 失败动作、隔离 sentinel 零访问和 Windows x64 tarball 干净安装证据。 | 无未处置 P0/P1。两项真实反证均已最窄修复并使旧轮证据作废：`protobufjs` 安装脚本审计版本漂移、历史规格仍列在当前索引。 | 等待用户验收；不得开始未来记忆方案或 AE-001 实施。 |

M1 的分类闭包和 M8 的五面对抗记录均追加在本节，不创建第二份任务或回归文档。

### M1 执行记录（2026-08-27）

#### 基线、方法与结论

- 基线为 `HEAD 2af063e81000a163c111c3a2ef8f320111d39f65`（`develop` 相对 `origin/develop` ahead 1）+ 本文未暂存差异 `memory-removal-M1-compat-decided-20260827`。进场前唯一其他工作区变化是已暂存的 `research/design/workbench/unit-development-workbench.md` 当前关注任务一行；本包未修改且不计入成果。
- 从 CLI/serve 的 authority、conversation 和 mesh 生产组合根正向追到 core，再从符号、协议 discriminant、资源类型、路径、package export、构建入口、注册表/golden、测试和现行文档反向核对。仓库没有独立的 `packages/distributed-runtime`，其生产责任实际分布在 CLI setup/serve、core protocol/adapter、owner-kernel、runtime-host 和 server，已按这些真实组合根闭合。当前可达记忆相关事实均已归入下表四类；合法的 `Journal`、进程内 memory 和历史材料另行隔离，没有以关键词命中代替归属。
- 四类闭包与历史对话保护闭包已经成立；用户最终确认知行尚未正式发布、没有真实用户，发布前 memory-bearing 开发数据不纳入兼容范围。兼容基线因此无条件闭合，M1 标记 `[x]` 并进入 M2。

#### 双向生产调用图与四类闭包

| 责任链 | 稳定入口 → producer → 直接 consumer → 最终行为 | 裁决与后续落点 |
| ------ | ----------------------------------------------- | ---------------- |
| Profile、People、memory Journal 存储与旧数据接管 | `setup-delivery` 在 anchor 启动创建 `AnchorMemoryGlobalStateAdapter`，对 personal/全部 workscene 执行 staged publishing 与 legacy takeover；adapter 消费 memory query/mutation，维护 canonical store、旧 Markdown projection/cutover，向工具、RPC、自动链和维护链提供长期状态 | **删除**：M5 先退 query/mutation/owner，M6 再退 adapter、store、路径、import/cutover 和旧投影；不得触碰用户已有文件。 |
| 显式 Agent/管理表面 | 默认 main profile 注册 builtin `memory`；orchestrator 的 assignment-bound port 把 save/update/delete stage 为全局变更，search/list 读取全局状态；server 注册三项 memory RPC，CLI 暴露 `/me`、`/journal`、`/people`；runtime-host 暴露 `workscene_memory_query` | **删除**：M3 同时关闭工具工厂、默认配置、提示、RPC/CLI/工作模式查询、exact-set/golden 和无实现的 `@memory:` typeahead 语义，防止影子入口。 |
| 自动提炼、收养后回放与维护 | segment summarize 后的 memory hook 调用 `MemoryFlusher` 并 stage Profile/People/Journal；conversation transfer 安装后及启动 catch-up 调用 post-adoption memory；journal maintenance 定时查询并 stage condense/delete | **删除**：M4 只断开长期记忆派生、回放和维护支路；保留 segment/摘要、transfer/adoption、post-adoption review、scheduler 与恢复主链。 |
| 全局协议、唯一 owner 与 generation | core 的 closed global query/result/staged-mutation union、`memory-domain:*` 能力资源和严格 codec 进入 assignment/stager；memory adapter 作为 `memory-global-state` participant 进入 router、generation rebind、projection/participant exact-set、checkpoint 与灾备 receipt | **删除**：M5；按最终兼容裁决直接删除 decoder/participant，不为发布前开发数据保留 reader 或迁移。 |
| core 公开/制品面 | `@zhixing/core` 根导出、`./memory` 子路径和 tsup 独立入口导出整个 memory 域；S7、distributed-runtime contracts、package exports、registry/server golden、测试与现行规格反向锁定上述入口 | **删除**：M6/M7 在消费方退场后同步删除 export/build/门禁/现行授权，tarball 必须不可达。 |
| 通用 frontmatter | M1 冻结时 Skills store 与 Rubrics document 直接复用 `core/memory/frontmatter.ts`；M2 已将唯一实现迁至 `core/frontmatter.ts`，memory/Skills/Rubrics 共同消费 | **中性迁移已完成**：后续删除 memory 目录时保留中性 owner 与 Skills/Rubrics 合同。 |
| `memoryScope` 承载的非记忆身份 | M1 冻结时 `createAgentRuntime` 同时用它决定 skill main/work 分区、scene trust context 和 lifecycle `sceneId`；M2 已改由 RuntimeHost/executor 显式传入 `worksceneIdentity` | **中性迁移已完成**：`memoryScope` 只剩记忆职责；技能隔离、信任/权限和生命周期不随其删除。 |
| 对话、authority 与通用安全基础设施 | transcript/run journal、Authority/Run/DeviceLifecycle/Evidence Journal、assignment/commit/app-state 安全边界、scheduler、workscene 身份/工作区/对话目录均被旧链复用或以 memory 作测试样本 | **保护**：机制和语义保留；仅移除 memory consumer/fixture，通用测试改绑存活域且保持原识别力。 |
| 非产品同名与历史事实 | `InMemory*` store、缓存/Map、RSS memory、模型上下文，以及 `research/source-analysis`、`research/insights`、旧任务/ledger/migration/draft 中的 memory/Journal | **保护 / 历史保留**：运行期非产品 memory 不删；历史原始事实不清洗。M7 只让现行规格、索引、README 和架构“当前结论”停止授权旧能力。 |

代表性直接证据：`packages/cli/src/setup-delivery.ts` 的 adapter 初始化、router/participant/rebind；`packages/core/src/memory/global-state-adapter.ts` 的 owner、cutover 与投影；`packages/tools-builtin/src/memory.ts`、`packages/orchestrator/src/runtime/create-agent-runtime.ts`、`packages/runtime-host/src/builtin-extra-tools.ts`、`packages/server/src/rpc/methods/memory.ts` 的生产消费；`packages/core/package.json` 与 `packages/core/tsup.config.ts` 的公开/构建入口；`scripts/s7-entry-coverage.mjs` 与 `scripts/lint-distributed-runtime-contracts.mjs` 的反向结构约束。

#### 历史对话持久化保护闭包

| 受保护事实 | 真实 owner / 投影 / 产品出口 | 与旧记忆链交界及唯一允许动作 | 后续保护证据 |
| ---------- | -------------------------- | ---------------------------- | ------------ |
| transcript 原文、committed run 与 clear | `ShardedTranscriptStore` 持久化 raw/committed run、clear、分片/索引；serve `access-surfaces` 提供 append/read/count/clear/delete | memory 只消费已提交内容；删除 memory 派生和 cleanup，不改写原文、clear 顺序、分片或 retention | M4～M6 的历史、clear、删除与重启直接回归必须继续读取同一事实。 |
| run/owner 提交、元数据和崩溃重驱 | `ConversationRunJournal` 以 `run:<conversationId>` 为权威流，提交 artifact closure、session metadata/lifecycle 与恢复投影 | `segmentMemoryFlushes()` 和 post-adoption memory 内部记录是派生支路；只能移除其 producer/consumer，不能放宽 journal/MutationBatch 严格校验 | committed/pending run、artifact closure、recovery projection 和 restart redrive 回归。 |
| conversation/session 生命周期与历史浏览 | `ConversationManager` + CLI conversation access surface 负责 create/load/switch/resume/list/history/rename/clear/delete | memory 管理/RPC 退出，不改变 conversation ID、元数据、历史分页、删除和恢复 | server `session.*`、CLI facade/controller 与 history/bootstrap 直接回归。 |
| attention window、bootstrap、segment 与摘要 | transcript/snapshot 构建 startup bootstrap；AttentionWindow/SegmentManager 压缩视图并记录 windowCompact/summary，原始 transcript 不被改写 | 只删除 `afterSummarize` memory hook、segment-memory candidate 和 provider 提炼；保留 compact/summary/预算/启动装填 | 无 memory hook 的 segment 切换、摘要、上下文预算、snapshot/bootstrap 回归。 |
| 收养/转移与恢复顺序 | transfer install 先建立 conversation authority；启动扫描 committed/tombstoned transfer 并恢复；post-adoption review 独立运行 | 删除 post-adoption **memory** flush/records/replay；保留 transfer/adoption、catch-up、review 和失败恢复顺序 | transfer/adoption/restart/review 组合测试，证明只少一个并行派生消费者。 |
| RPC、CLI、server 与渠道投影 | server `session.*`、RPC session wire/广播、CLI conversation facade/controller、channel conversation binding/Feishu adapter 统一消费 ConversationManager | 只移除 memory 命令/RPC/工具；不得改变会话事件、订阅、流式 turn、渠道绑定或历史产品行为 | 对真实 server/CLI/channel 组合根做发送、历史、clear/delete、恢复和事件投影回归。 |

代表性直接证据：`packages/core/src/transcript/shard/store.ts`、`packages/core/src/context/bootstrap/build-startup-bootstrap.ts`、`packages/core/src/context/segment/segment-manager.ts`、`packages/owner-kernel/src/conversation-assignment.ts`、`packages/cli/src/serve/access-surfaces.ts`、`packages/cli/src/serve/mesh-runtime-assembly.ts`、`packages/server/src/rpc/methods/session.ts`。这些主链均能在不依赖长期记忆输出的情况下成立；下述格式冲突仅记录兼容集合包含旧 memory 专属耐久事实时的反事实技术边界，最终产品裁决已将其排除。

#### 兼容三层基线、技术必然性与最终裁决

| 事实层 | 已证明 | 未证明 / 不得推导 | 直接证据 |
| ------ | ------ | ----------------- | -------- |
| 代码生产可达 | 当前生产组合会在 transfer commit 与启动 catch-up 后把 `post-adoption-memory-*` 写入 `run:<conversationId>`；builtin memory 与自动 flush 会把 `memory-append/delete` 写入 `MutationBatch v1`；memory adapter 是当前全局 mutation owner 和 generation participant。 | 生产入口存在不等于任何真实用户已经运行并形成数据。 | `post-adoption-memory.ts`、`mesh-runtime-assembly.ts`、`create-agent-runtime.ts`、`commit.ts`、`setup-delivery.ts`。 |
| 交付分支 / 制品候选 | 引入 post-adoption memory 的 `dd50eec8949f` 是 `origin/main` 的 `9e1d4d69` 祖先；根及 16 个公开包版本均为 `0.1.0`；closeout 在隔离 npm consumer/home 中完成 canonical tarball 验收并记录候选 SHA-256。 | 进入 main、版本号、README 安装说明、本地 pack 或 tarball smoke 都不是 npm 发布或真实使用 provenance。 | Git ancestry、`package.json`/版本投影、`distributed-runtime-closeout-task.md` 的最终 tarball/隔离验收记录。 |
| 必须兼容的既有用户数据 | 仓库内没有可靠证据证明上述 memory-bearing 候选已真实发布或被真实用户运行；用户进一步确认知行尚未正式发布且没有真实用户，并裁决发布前由源码、构建产物或候选 tarball 生成的数据不纳入兼容范围。 | main 祖先关系、版本号、README 和候选 tarball 仍只证明前两层，不能冒充真实发布；开发者本地是否曾生成数据不再改变产品兼容边界，也不授权访问或处理其目录。 | 用户 2026-08-27 最终裁决；`distributed-runtime-closeout-task.md` §四、§五和最终冻结记录；`release-and-maintenance-guide.md` 发布者合同；`publish-npm.mjs` 与 `npm-delivery-structure.test.mjs`；本地 Git/tag/archive/workflow 检查。 |

如果兼容集合包含 memory-bearing 数据，源码证明不存在同时满足“零 memory decoder/participant、零数据扫描改写、不放宽严格校验、历史对话及恢复不变”的方案：

1. **run 流没有可绕过的投影路径。** `ConversationRunJournal` 重建 run 与 submission-guard 投影时，对同一 `run:<conversationId>` 中每个带 `kind` 的记录调用 `assertConversationRunInternalRecord`；删除五种 post-adoption memory decoder 后会按 unknown internal record fail-closed，早于历史投影完成。保留这些 exact kind 的惰性分支仍是 memory 专属兼容 reader；改成忽略任意未知 kind 则放宽通用严格校验。
2. **MutationBatch 不能整体跳过或局部猜读。** `validateConversationBundleClosure`、artifact retention/依赖提取、committed/pending recovery 与 transfer 都调用 `validateMutationBatch`，后者逐条进入 closed global staged-mutation codec。批次可同时含 memory 与非记忆 mutation；跳过整个 artifact 会丢失非记忆提交和 closure，按未知 kind 过滤会改变 digest/严格合同，保留 memory discriminant 则是协议残余。已 granted 但待物化的 memory mutation 在移除 owner 后还会于 `GlobalMutationCommitCoordinator.apply` 以“no unique anchor owner”失败。
3. **generation/checkpoint 本身不是独立发布或阻塞证据。** 已完成的 disaster post-install receipt 只耐久保存 participant digest，读取时不按当前 participant exact-set 重新解释；未完成 install 会用当前代码的 participant 集合重新 rebind，因此不能仅凭旧列表推导失败。真正的条件性冲突是：checkpoint/transfer 恢复随后调用 conversation consumer；若恢复的共享 authority log 含上述 run 记录、MutationBatch 或待物化 memory mutation，仍必然回到第 1、2 条，移除 memory owner 后无法完成原义务。把 memory stream 或专属目录留作完全不可达的用户数据本身不需要 reader，但不能修复混入受保护 run/artifact 的事实。
4. **没有第三条无残留路线。** 改写/迁移既有日志或 mutation artifact 违反数据边界；保留旧 codec/owner 是兼容壳；跳过整段历史、切换到另一份 transcript 或忽略未知记录会破坏 owner 权威、混合 mutation、崩溃重驱或严格损坏检测。版本化旧 codec 即使不再生产，也仍是本任务明确禁止的 reader。

上述条件式技术冲突已由产品边界裁决解除：**发布前 memory-bearing 开发数据不进入兼容集合。** 首个正式版本直接以剔除完成后的严格格式为兼容起点；后续删除不得保留旧 memory decoder/participant、放宽未知记录校验、扫描或迁移开发者本地数据。这个裁决只取消旧记忆数据兼容义务，不改变 transcript、conversation、segment、摘要、恢复及其投影的正式产品基线。

M1 冻结点是 `HEAD 2af063e8` + 本文 `memory-removal-M1-compat-decided-20260827`：四类双向闭包、历史对话保护闭包和兼容基线均无条件成立，M1 可闭合并进入 M2；M1 取证期间未执行任何 Git 暂存区、历史、远程或 registry 写操作，也未访问用户 home、秘密或外部系统。

#### 实际取证命令

- 基线/差异：`git status --short --branch`、`git rev-parse HEAD`、`git diff --cached -- research/design/workbench/unit-development-workbench.md`、`git diff -- docs/tasks/memory-module-removal.md`。
- 双向闭包：`rg --files`；按 memory/Profile/People/Journal、协议 kind、资源类型、路径 helper、export/build、注册表/golden/test/doc 引用执行的 `rg -n`；对生产组合根和严格 codec 使用 `Get-Content` 分段核读。
- 发布/兼容：`git log --all --follow`、`git show`、`git merge-base --is-ancestor dd50eec8949f 9e1d4d69`、`git tag --list`、`git branch --contains`、`git ls-files` 的 archive/shrinkwrap 检查、`.github`/发布报告检查；核读 closeout 最终记录、release guide、`publish-npm.mjs`、零写结构测试及 production write/recovery 条件。全程离线，未访问 npm registry、用户 home、秘密或外部系统。
- 按 M1 边界未运行 lint、test、build 或 package check；未执行暂存、取消暂存、提交、历史改写或推送。

### M2 执行记录（2026-08-27）

#### 中性归属与生产装配闭包

- 基线为同一 `HEAD 2af063e81000a163c111c3a2ef8f320111d39f65` + 差异标识 `memory-removal-M2-neutral-frontmatter-workscene-identity-20260827`。`packages/core/src/frontmatter.ts` 现在是 Markdown frontmatter 的唯一中性文件 owner；原 `memory/frontmatter.ts` 已删除，直接测试迁至 `core/src/__tests__`。Skills、Rubrics 以及 M3～M6 前仍存活的 memory 实现全部直接消费该 owner，`./memory` 仅暂时转导同一绑定。`parseFrontmatter` / `stringifyFrontmatter` 迁移前已通过 memory 转导属于 core 根公共面；M2 保持两个函数的公共可达性，只为避免在“解除错误耦合”阶段顺手改变非记忆合同，不以当前未被证明存在的包外消费方为依据。最终公共面是否保留它们，由真实非记忆职责和 M7 package surface 统一裁决；实现文件的 `ParsedFrontmatter` 类型不加入包根公共合同。
- `CreateAgentRuntimeOptions.worksceneIdentity` 是最窄的非记忆装配输入。skill main/work 分区、`SecurityPipeline` 的 scene trust/permission context 和全部 lifecycle `sceneId` 只读取该身份；`memoryScope` 的生产引用只剩记忆 query/mutation/flush 的 scope。显式 workscene 身份在没有 `memoryScope` 时仍产生完整 work 语义，反向给出 workscene `memoryScope` 而不提供 runtime 身份时仍保持 main/global 语义。
- RuntimeHost 从 `WorksceneDto.id` 建立单一 `sceneId`，再向 `createAgentRuntime` 显式传入同值的 `worksceneIdentity` 与临时 memory scope；CLI executor 从已编码在 conversation ID 中的 `ConversationScope` 取得同一场景身份。普通 workspace、main 与无 workspace 路径均不从 profile、路径或 memory 类型回退推断 scene。M2 未修改 transcript、conversation、segment、摘要、恢复或投影代码，也未删除任何记忆能力。

#### 直接证据、命令与结果

- core 直接测试：在 `packages/core` 运行 `node node_modules/vitest/vitest.mjs run src/__tests__/frontmatter.test.ts src/skills/__tests__/store.test.ts src/skills/__tests__/store-write.test.ts src/rubrics/__tests__/document.test.ts src/rubrics/__tests__/store.test.ts`，5 文件 60 测试通过；特殊字符 roundtrip 同时覆盖 Skills/Rubrics 产品入口。
- orchestrator 直接测试：在 `packages/orchestrator` 运行 `node node_modules/vitest/vitest.mjs run src/runtime/__tests__/create-agent-runtime.test.ts`，1 文件 70 测试通过；新增正反例同时锁定技能分区、scene trust/context 和 lifecycle 身份与 `memoryScope` 正交。
- 生产组合根直接测试：在 `packages/cli` 运行 `node node_modules/vitest/vitest.mjs run src/runtime/__tests__/runtime-host.test.ts src/serve/__tests__/executor-role-job-runtime.test.ts`，2 文件 9 测试通过；RuntimeHost 与实际 executor 组合根均显式透传场景身份，main/workspace 路径无回退。
- 串行类型/构建：`pnpm --filter @zhixing/core exec tsc -p tsconfig.json --noEmit`、`pnpm --filter @zhixing/core build`、`pnpm --filter @zhixing/orchestrator exec tsc -p tsconfig.json --noEmit`、`pnpm --filter @zhixing/orchestrator build`、`pnpm --filter @zhixing/runtime-host exec tsc -p tsconfig.json --noEmit`、`pnpm --filter @zhixing/runtime-host build` 和 `pnpm --filter @zhixing/cli build` 全部通过。core build 仅输出既有 Rollup circular-chunk 警告。
- CLI 规范 typecheck `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit` 唯一失败为未改动的 `src/serve/mesh-runtime-assembly.ts(1803,30) TS6133`；`git diff` 与 `git show HEAD:` 证明该未使用参数来自当前 HEAD。追加 `--noUnusedParameters false` 后同一完整 CLI typecheck 通过，且 CLI 生产构建通过，因此没有被该既有 hygiene 告警遮蔽的 M2 类型错误。
- 静态反查：`rg` 已确认生产源码不存在 `memory/frontmatter` 引用；`create-agent-runtime.ts` 中 `options.memoryScope` 只初始化记忆 scope，所有非记忆 scene 消费均命中 `worksceneIdentity`。未运行根级 lint/test/build、package check 或 M3 验证；未执行任何 Git 暂存、取消暂存、提交、历史改写或推送。
- 公共出口纠正：协调复核发现实现类型 `ParsedFrontmatter` 没有既有根导出或外部消费依据，已从 `core/src/index.ts` 移除；包根只保留两个既有函数的中性转导。纠正后仅运行 `git diff --check`、`pnpm --filter @zhixing/core exec tsc -p tsconfig.json --noEmit` 和 `pnpm --filter @zhixing/core build`，三项通过；build 仍仅输出既有 Rollup circular-chunk 警告。未重复运行已经双方确认通过的 139 项直接测试。

M2 无未闭合责任，标记 `[x]`；下一检查点是 M3。当前已暂存的工作台动态任务行始终未修改索引或文件内容，不计入本包成果。

### M3 执行记录（2026-08-27）

#### 公开能力生产闭包

- 基线为 `HEAD 4ab15b91fc8e378ee6adf0c71a521d6d80e4f05d` + 差异标识 `memory-removal-M3-public-surface-20260827`；进场时工作区和索引均为空。本包从真实注册根正向追踪并按符号、注册表、golden、帮助和直接测试反查，不以 `memory` 关键词直接裁决。
- **Agent 工具与提示：** 默认 `AgentRoleProfile.enabledTools` 原经 `BUILTIN_TOOL_FACTORIES.memory` 实例化 `createMemoryTool`，再由 `createAgentRuntime` 向模型发布。本包删除工具实现、公共导出、工厂/capability、直接测试和默认声明，删除 system/runtime prompt 的显式记忆说明；默认 builtin exact-set 现为十项存活工具。自定义 profile 或 executor job 再声明 `memory` 时分别在 runtime 工厂校验和真实 executor capability admission 处稳定拒绝，无法实例化或激活旧工具。`AgentRoleProfile` 机制、其他工具及通用 `app-state` 权限链未变。
- **CLI/TUI 与 server：** `registerInfoCommands → dispatcher → RpcManagementFacade → memory.* RPC → ServerContext.memoryDirectory` 的三条 `/me`、`/journal`、`/people` 链已同时删除命令定义、facade、serve 组合、directory、handler/schema/registry 和直接测试；CLI README、工具卡、render strategy、typeahead 标题及离线提示不再宣告旧能力。CLI 本地 info exact-set 固定为 `help/status/stop/model/usage/context/tasks`；server 将三项 method 纳入 retired exact-set，所有真实 registry 组合均不再注册它们。
- **工作模式与 typeahead：** RuntimeHost 的 extra-tools 组合根不再导入或装配 `workscene_memory_query`，实现、描述、进入提示和直接测试均删除；main 存活集合固定为 `schedule/task_list/workmode_enter/workscene_change_approve/workscene_list`，workscene 的退出/变更/生命周期和 M2 场景身份保持不变。FileProvider 只为现有 `@tool:` provider 让出前缀，普通冒号 token 与既有文件补全合同不变；通用类型注释和直接测试不再保留旧记忆 provider 的名称或专门语义。
- **边界保护：** M3 未删除或改造 Memory Flush、segment hook、post-adoption memory、journal maintenance、scheduler、global memory query/mutation/owner、legacy adapter、Profile/People/Journal store 或 `core/src/memory`；这些生产命中分别归 M4～M6。未修改 transcript、conversation、run commit、attention window、segment/摘要、恢复、历史浏览和渠道投影。distributed behavior golden 的差异只删除三项 memory RPC 行，其他 server/RPC 行为保持 byte-for-byte 稳定。

#### 直接证据、命令与结果

- core：在 `packages/core` 运行 FileProvider 直接测试，1 文件 30 测试通过；`pnpm --filter @zhixing/core exec tsc -p tsconfig.json --noEmit` 与 `pnpm --filter @zhixing/core build` 通过。
- tools-builtin：工厂 exact-set 直接测试 1 文件 2 测试通过；canonical typecheck 与 build 通过。测试同时锁定十项存活名称、工厂键和 capability，不允许 `memory` 影子注册。
- orchestrator：默认 profiles、system prompt、真实 runtime 工厂 3 文件 148 测试通过；canonical typecheck 与 build 通过。直接负例证明默认集合不含旧工具，自定义 profile 声明 `memory` 会在装配前失败。
- runtime-host/server：`@zhixing/runtime-host` canonical typecheck 与 build 通过；CLI 中的 host/workmode 直接测试覆盖存活工具 exact-set。`@zhixing/server` canonical typecheck 与 build 通过；management methods 与当前 distributed behavior golden 共 2 文件 8 测试通过，另以 `ZHIXING_UPDATE_GOLDENS=1` 运行同一 3 项 golden 用例生成当前基线后再无更新变量复验。
- CLI/TUI：info commands、host/workmode、工作场景创建提示、工具卡/呈现、executor job capability、离线 conversation、journal maintenance 和 typeahead panel 共 10 文件 143 测试通过；`pnpm cli:build` 通过。规范 typecheck 只复现未改动的 HEAD 既有 `src/serve/mesh-runtime-assembly.ts(1803,30) TS6133`，追加 `--noUnusedParameters false` 后同一完整 typecheck 通过，因此没有被该 hygiene 告警遮蔽的 M3 类型错误。
- 结构与注册证据：首轮只执行 entry script 与 registry golden，遗漏了 `scripts/s7-entry-coverage.test.mjs` 中仍要求 `anchor-executor` / `executor-only` 包含旧 builtin 的反向断言；协调者用 canonical `pnpm s7:lint` 取得失败反证后，M3 立即退回未完成。纠正后 exact-set 测试对全部八种 role configuration 统一断言 `tool:builtin:memory` 不可出现，同时保留 anchor RPC、cleanup 差异及四组 surface 同构断言；完整 `pnpm s7:lint` 一次通过 production coverage、21/21 Node 测试和 registry golden。retired production token 仍覆盖旧工具实现/端口、管理 directory、三项 RPC 和 `workscene_memory_query`。
- 纠正失效闭包：core FileProvider 直接测试仍为 1 文件 30/30，canonical typecheck 与 build 通过；build 只输出既有 Rollup circular-chunk 警告。连同输入未变且不重复执行的其余 301 项 Vitest，当前直接测试数字为 331 项 Vitest + 21 项 canonical S7 Node 测试，共 352 项。
- 静态反查按旧工具符号、三项 RPC、三条 slash、工作场景查询和旧 typeahead token 对生产源码、S7 catalog、CLI/server/runtime-host/typeahead exact-set 复核；生产源码与 typeahead 注释/专门测试均无残留，剩余精确命中只用于全角色负断言、retired 门禁、M4～M6 尚需处理的内部链、core memory 路径或历史材料。未运行根级全测、根级 build、package check 或 M4 验证；未访问用户 `ZHIXING_HOME`，未执行任何 Git 暂存、取消暂存、提交、历史改写或推送。

协调反证、S7 全角色 exact-set 和 typeahead 残余语义已经在同一 M3 工作包内闭合；M3 恢复标记 `[x]`，下一检查点是 M4。

### M4 执行记录（2026-08-27）

#### 自动派生生产与耐久闭包

- 基线为 `HEAD 8bf34c446fd19f37c4cb79f54c1d75e60ed67360` + 差异标识 `memory-removal-M4-auto-pipelines-20260827`；进场时工作区和索引均为空。本包从 runtime/serve 组合根正向追到 durable mutation/record、consumer 与恢复重驱，再按类型、record discriminant、provider 治理、S7/registry 和直接测试反查，不按 `memory` / `journal` 名称批量删除。

| 支路 | 已删除闭包 | 同基线保护事实 |
| ---- | ---------- | -------------- |
| Segment → Memory Flush | core 的 `MemoryFlusher`、segment flush hook/专属 planner 与测试；orchestrator 的 assignment-bound `RuntimeMemoryPort`、`memoryScope`、读写/overlay/merge helper、`afterSummarize` 记忆 hook 和 staged mutation 生产；RuntimeHost/CLI 的记忆 scope 装配 | `SegmentManager`、通用 `afterSummarize` hook 合同、消息切分、摘要、attention window、手动 compact、light-model 其他调用与 lifecycle 顺序仍存活；真实 runtime 的 force-compact 只发生摘要调用，不再产生 memory mutation。 |
| Conversation adoption → post-adoption memory | CLI 的候选发现、模型提炼、计划/effect/completed 写入、operation/digest、启动 catch-up、transfer install 后 flush、mesh port/binding、失败重驱；owner 的输入/提炼类型、`discovery/attempt/plan/effect/completed` 五种内部 record decoder/union/投影以及 segment/conversation memory flush 派生读取；executor/CLI/S7 的专属 registry/ledger | 通用 run journal 对未知 record 仍 fail-closed；conversation transfer 的 prepare/install/commit、启动恢复、tombstone、artifact closure 和独立 post-adoption review 的装配、顺序与重驱仍存活。 |
| Journal maintenance | core 的 scan/condense/delete planner；CLI 的 scheduler/system-handler/turn-maintenance/access-surface/serve 生命周期、presenter、用户通知、provider 调用治理与测试；owner `SchedulerUserNotice` 的 maintenance plan/state/transition/projection；`__journal-gc` 注册 | scheduler 本体、普通用户任务、`__transcript-gc` retention、恢复备份/托管宿主/调度等其他 notices，以及 ConversationRunJournal、assignment journal 等权威日志均保持原合同。 |

- **治理与反向闭包：** provider-call governance 已移除两项自动记忆调用；S7 adoption 门禁改为对 owner/CLI 生产入口统一禁止 post-adoption memory record 与 binder，executor record exact-set 只覆盖存活内部事实。对生产源码、注册表和测试做反向检索后，M4 三条支路只剩 S7 retired/negative 证据；`global-state-adapter` 中 `memory-journal-maintenance` 的底层授权 principal 以及 global memory query/mutation/commit、owner/generation/assignment、store/legacy adapter 仍按 M5/M6 边界保留，但已无 timer、handler、notice、provider 或恢复 producer 调用。
- **边界保护：** 本包未修改 transcript 原文/clear、conversation/session、run commit 主合同、segment/摘要/attention window、transfer/adoption、post-adoption review、scheduler 普通任务、transcript retention 或渠道投影；未删除 M5 的 global memory 协议/owner/codec/资源/cleanup，也未删除 M6 的 adapter/store/core 记忆域和旧目录。

#### 直接证据、命令与结果

- 按上游顺序运行 `pnpm --filter @zhixing/core build`、`@zhixing/owner-kernel build`、`@zhixing/orchestrator build`、`@zhixing/executor build`、`@zhixing/runtime-host build`、`@zhixing/server build`、`@zhixing/providers build` 与 `@zhixing/cli build`，全部通过；core 只输出既有 Rollup circular-chunk 警告。最终注释清理后重新构建 core、providers、orchestrator 与 CLI，确保产物对应当前源码。
- core 的 segment/message-turn/agent-loop 3 文件 65 测试、orchestrator runtime/call-llm 2 文件 84 测试、owner conversation/transfer/scheduler/job 6 文件 181 测试、executor assignment-ledger 与 job-assignment 442 测试、CLI transfer/review/runtime/host/governance 47 测试、server system-handler 7 测试均通过，共 826 项直接 Vitest。测试分别识别无 memory hook 的摘要/compact、无 post-adoption memory record 的 transfer/restart/review，以及无 journal maintenance handler 的 scheduler/retention 存活集合。
- `node --import=tsx/esm --test scripts/s7-entry-coverage.test.mjs` 21/21 通过；最终完整 `pnpm s7:lint` 通过 production coverage、同一组 21 项 mutation 测试与 registry golden。未以单独 entry script 或 golden 更新替代 canonical 门禁。
- 协调者在同一未修改生产基线上独立复核 core SegmentManager 31/31、owner conversation transfer/run contracts/notices 69/69、CLI transfer mesh/post-adoption review/turn maintenance 10/10、server system handlers 7/7，共 117/117 项关键保护测试通过；canonical `pnpm s7:lint` 同样取得 21/21 + registry golden。其精确残余检索另发现 `call-llm.test.ts` 的空响应测试名称仍以已删除的 `MemoryFlush` / `parseExtractions` 解释合同；本轮只把名称收敛为存活的 `callText` 空响应合同，测试行为和生产输入均未改变，因此没有重复构建或测试。
- `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit` 通过。此前从仓库根运行 `pnpm exec tsc -p packages/cli/tsconfig.json --noEmit` 错用了根级旧 TypeScript，产生与当前编译器不兼容的解析噪声；改用包内规范命令后只暴露并清除了删除参数消费后留下的一个未使用私有参数。首次直接执行 Node 测试未加载 `tsx` 也属于命令环境错误，补上仓库规定 loader 后通过。
- 协调复核发现并清除上述失效测试名称后，重新运行 `git diff --check` 与两组 retired identifier/路径双向残余检索并通过；最终命中仅为 S7 的负向 mutation 门禁，以及归属 M5/M6 的 global memory 协议、`memory-journal-maintenance` 底层 owner 授权和 adapter/store。未运行根级全测、根级 build、package check 或无关昂贵回归，未访问用户 `ZHIXING_HOME`，未执行任何 Git 暂存、取消暂存、提交、历史改写或推送。

三条自动派生支路已在生产、耐久记录、恢复重驱、provider 治理、结构门禁和直接测试中同时闭合；M4 标记 `[x]`，下一检查点是 M5。

### M5 执行记录（2026-08-28）

#### 分布式协议、能力与 owner 闭包

- 基线为 `HEAD fce81f98237bcc7e631ca75806144ab5382feb05` + 差异标识 `memory-removal-M5-distributed-protocol-owner-20260828`；进场时工作区与索引均为空。本包从 core 严格解码入口、conversation/job assignment 签发、CLI stager 与 `setupAuthorityRuntime` / generation rebind 正向追到 owner/participant，再按 discriminant、资源 selector、共享导出、路由、S7 exact-set、测试样本和 workscene 删除反查。

| 责任链 | 已删除闭包 | 同基线保护事实 |
| ------ | ---------- | -------------- |
| 全局状态协议 | `GlobalQuery` / `GlobalReadResult` 的 `memory-search/list/stats`；global control/staged 的 `memory-append/delete/journal-condense`；对应 commit/query 严格 codec、memory invariant，以及 contracts foundation 中无其他消费方的 memory/people DTO/store 转导 | 存活的 trust、schedule、workscene、skill、config/asset query 与 schedule/skill/workscene/delivery mutation 保持封闭集合；退役 discriminant 与额外字段均继续 fail-closed，没有未知值忽略器或兼容 reader。 |
| 能力签发与发布 | `ResourceSelector` 的 `memory-domain:*`；conversation 按 conversation/workscene 派生 memory resource、主会话扫描全部场景扩签、job personal-memory 签发；stager 的 memory scope 专门验权；publish-result 的 memory 产品语言 | conversation capability 只签 `conversation:<id>`，job capability 只签 `task:<id>`；AuthorityCapability 结构、方法绑定、签名/摘要/激活/拒绝语义与 assignment ledger 保持不变。通用 ledger/presenter fixture 已改绑真实 `schedule-delete` 域。 |
| owner、generation 与恢复 | `setup-delivery` 对 `AnchorMemoryGlobalStateAdapter` 的创建、legacy 初始化、workscene scope 枚举；global router 的 memory query/mutation 分支；初始与 installed-generation rebind 的 `memory-global-state` owner、participant 与 staged mutation participant | 存活 generation participant exact-set 为 runtime epoch、delivery、control admission、resource governor、surface assets、workscene、skill、rubric；workscene 与 skill 两个 staged participant 同一 generation 原子重绑，scheduler 延迟安装、checkpoint receipt 和恢复顺序未变。 |
| M6 过渡边界 | 旧 adapter/store/legacy 源码和 `@zhixing/core/memory` 子路径按 M6 暂存活；adapter owner 已从 memory/root 公共转导移除，停止实现共享 `GlobalStatePort`，不再消费共享 query/mutation discriminant，也不再包含 `memory-domain:*` 或 `memory-journal-maintenance` principal 授权 | 不可达性不靠禁用开关：生产 setup、router、assignment、participant、恢复、公共 owner 出口与 S7 均无 adapter。M6 可直接删除该本地遗留域，不需要重新恢复 M5 协议或 owner。 |

- **Workscene 删除边界：** 真实删除链中没有另一条 memory mutation 或专属 cleanup port；M5 断开全局 memory owner 后只剩 workscene tombstone/registry、会话清理与通用场景文件清理。`workscene-storage-cleanup` 的失败重试、幂等和 conversation/file closure 由 6 项直接测试保持；`getWorkSceneMemoryDir` 与旧目录处理仍归 M6，不在本包提前删除或访问。
- **反向残余裁决：** 生产源码和共享 contracts/protocol 中对退役 query/mutation/resource/owner/principal 的命中已清零；保留命中只有 core memory adapter/store/legacy/path 的 M6 实现，以及 protocol/S7 中明确拒绝旧 discriminant/resource 的负向门禁。Authority/Run Journal、进程内 memory 和 workscene 通用文件清理均为合法非记忆职责。反查同时清除了 owner/orchestrator 注释中把已退役 journal condensation 写成当前 turn-maintenance/callText 用途的四处失效表述。

#### 直接证据、命令与结果

- core：`pnpm --filter @zhixing/core typecheck:contracts`、`pnpm --filter @zhixing/core lint:contract-schemas` 与完整 `pnpm --filter @zhixing/core build` 通过；build 只有既有 Rollup circular-chunk 警告。协议 query/commit/authority 与 M6 adapter 过渡测试 26/26 通过，直接证明存活 exact-set、旧 query/mutation/resource fail-closed 以及旧 adapter 仍可在脱离生产协议后独立构建。
- owner/executor：`@zhixing/owner-kernel build`、`@zhixing/executor build` 及两包最终 package-local TypeScript `--noEmit` 通过；conversation/job assignment 与 product-language 8/8、assignment ledger 200/200 通过。assignment issuer 直接断言 conversation 只签 `conversation:<id>`、job 只签 `task:<id>`；账本测试继续覆盖摘要、签名、分区、重放、publish/恢复和历史对话 owner 主链，只把退役 memory 样本改绑 `schedule-delete`。
- CLI：package-local TypeScript `--noEmit` 与 `pnpm --filter @zhixing/cli build` 通过；assignment stager、publish presenter、global-query mesh、workscene storage cleanup、setup/generation rebind 共 39/39 通过。`setup-delivery` 直接断言八个 installed-generation participant 和两个 staged participant，且 anchor+executor / anchor-only 两种角色均完成连续 generation 重绑。
- 结构门禁：最终 `pnpm s7:lint` 完整通过 production coverage、21/21 mutation tests 与 registry golden；没有用单独 entry script 或 golden 更新替代。`git diff --check` 与退役 discriminant/resource/owner/principal 双向检索通过。
- 实际验证中，第一次从 core 包错误使用 `../../node_modules/vitest/vitest.mjs` 因入口路径不存在失败，改用包内 `node_modules/vitest/vitest.mjs` 后通过；第一次 owner build 发生在长耗时 core DTS 尚未产出时，按运行手册等待完整 core build 后重跑即通过。两次均为命令/旧产物顺序问题，无业务断言失败；未据此放宽合同或重复已有效的 200 项账本证据。
- 未运行根级全测、根级 build、package check 或 M8 门禁；未访问、扫描、迁移或删除用户 `ZHIXING_HOME`，未执行 Git 暂存、取消暂存、提交、历史改写或推送。

分布式 memory/people/journal 语义已从共享协议、能力签发、assignment/stager、product-language、生产 owner/router、generation/recovery participant 和 workscene 删除责任链中同时退场；非记忆全局域、AuthorityCapability、assignment、generation 原子性、工作场景/会话清理与历史 owner 恢复证据成立。M5 标记 `[x]`，下一检查点是 M6。

### M6 执行记录（2026-08-28）

#### 存储域、路径与公开出口闭包

- 基线为 `HEAD 5e2fce52ea50a529171b74259a1143bf82b2590b` + 差异标识 `memory-removal-M6-storage-core-domain-20260828`；进场时工作区与索引均为空。先从 core 根/package export/tsup/path helper 反查，再按 adapter 公开类、legacy projection、canonical identity、Profile/People/Journal store 和路径符号反向核对：M5 后这些实现只在 `packages/core/src/memory/` 内部自循环，生产 setup、router、generation/rebind、assignment、transfer 和 maintenance 组合根均无消费者。
- 删除了整个 `packages/core/src/memory/` 及其专属测试，包括 Anchor adapter、legacy Markdown reader/projection、takeover/cutover/维护状态、Profile/People/Journal 物理与逻辑 store、canonical identity 和 reader/writer；未搬迁、改名或保留兼容壳。core 根不再转导该域，`packages/core/package.json` 不再公开 `./memory`，tsup 不再构建独立入口；package-export 检查新增退役子路径负向断言。
- `getMemoryDir`、`getWorkSceneMemoryDir` 及 workscene 布局中 `<scene>/me` 定义/导出已删除。`getWorkScenesRoot`、index/meta、`getWorkSceneDir`、`getWorkSceneConversationsRoot` 和 conversation repository 的 user/workscene 布局保持原值。中性 `frontmatter.ts` 及根级 `parseFrontmatter` / `stringifyFrontmatter` 保留，Skills/Rubrics 继续直接消费同一 owner。

#### 零副作用与保护证据

- 新增的 CLI 直接测试使用 `createTempDir` 生成显式隔离 home，事先写入 `<home>/me/sentinel.txt` 和 `<home>/workscenes/scene-a/me/sentinel.txt`，再对 `node:fs/promises` 的创建、枚举、打开、读写、改名和删除等路径操作安装 forbidden-root 拦截；`setupAuthorityRuntime` 首次启动与 shutdown cleanup、随后的 workscene conversation cleanup 全程零拦截命中。撤除拦截后两个 sentinel 内容与路径原样，而目标 conversation 目录正常删除；这不是仅以“最终内容相同”推测零扫描。测试没有读取用户真实 home。
- core 直接回归：frontmatter/Skills/Rubrics/workscene path 6 文件 61/61，conversation repository 创建、持久化、scope 隔离、恢复与删除 48/48，workscene registry/global adapter 的 CRUD、tombstone、删除重驱与幂等 7/7。CLI 直接回归：sentinel 1/1，conversation directory 与 workscene storage cleanup 14/14。合计 131/131，同时证明只删除旧记忆存储责任，会话和 workscene 主链未漂移。
- 串行运行 `pnpm --filter @zhixing/core exec tsc -p tsconfig.json --noEmit`、`pnpm --filter @zhixing/core build`、`pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`、`pnpm --filter @zhixing/cli build` 与 `pnpm runtime:package-exports`，全部通过；core build 只输出既有 Rollup circular-chunk 警告。新 core `dist` 不再含 memory 入口，根模块实际 import 也不包含退役符号。
- 窄化 Biome 检查、`git diff --check`、精确 retired symbol/路径双向检索与构建制品实际 import 检查通过。最终生产命中已无 reader/writer、adapter、store、legacy/cutover、路径 helper 或可重活同义实现；剩余精确命中只是 S7 对旧 adapter 的负向禁止、本包的退役出口/零访问证据，以及 M7 所属现行与历史文档。S7 生产输入未改变，因此本包未重复运行 canonical S7；未运行根级全测、根级 build、package check 或 M8 门禁，未执行 Git 暂存、取消暂存、提交、历史改写或推送。

M6 的生产实现、公开出口、路径、零副作用与非记忆保护闭包已同时成立；M6 标记 `[x]`，完成度为 6/8，下一检查点是 M7。

### M7 执行记录（2026-08-28）

> **协调反证与证据纠正**：首次完成记录以退役标识符检索为主，漏掉中文语义、接口注释和测试标题，因而“正向旧能力命中清零”及当时 M7 完成结论曾被作废。续做已按当前语义重新分类、修复并重验失效闭包；下文保留首次证据，同时以本段及新增纠正记录为最终裁决。

#### 测试、结构门禁与制品闭包

- 基线为 `HEAD 8594806e6651dfda129d45db883ff03a693ff405` + 差异标识 `memory-removal-M7-tests-gates-artifacts-docs-20260828`；进场时索引为空，工作区保留昨晚中断前的 18 个 M7 未暂存路径。本轮逐项复核并续做，最终成果为 37 个实现注释、测试、golden、门禁和现行文档路径，加本文 1 个状态/证据路径；没有 reset、覆盖或重做 M1～M6。
- 通用 fixture 分别从旧 memory 样本改绑 `load_skill`、`save_skill`、`write` 和 `web_fetch`，继续覆盖环境选择、app-state 分类、sub-agent profile 过滤与 conversation runtime readiness；S7 writable-owner mutation 从已删除的 `MemoryStore` 改绑真实 `SkillStore`，别名、转导和反向依赖识别力保持。生产注释与测试说明中残留的 segment `memory.save`、turn journal 凝练及 journal/people 管理表述同步清除，行为未变。
- canonical server registry golden 只删除已退场的 `memory-read` / `memory-write` landing row，`retiredMethods` 中三项旧 RPC 保持；distributed-runtime structure golden 只吸收 M1～M6 源码删除造成的既有拓扑引用计数下降。S7 对全部 role configuration 的旧工具统一负断言、退役 source token、post-adoption record、旧 global owner/resource、server RPC、`./memory` package export 和旧目录零访问门禁均继续存在。
- `pnpm pack` 对同一 core build 生成 `zhixing-core-0.1.0.tgz`：177 个条目、22 个公开 export，既无 memory 路径/`./memory`，也无 `MemoryFlush`、`MemoryScope`、旧 store/owner/resource 等退役符号；检查在显式隔离临时目录中完成，目录随后删除。`pnpm runtime:package-exports` 已作为最终 `pnpm runtime:baseline` 的子门禁通过，没有重复单跑。

#### 现行授权与历史边界

- 删除 `research/design/specifications/memory-system.md` 及规格索引入口；更新仍具当前授权力的 typeahead、工具/权限、skill、context、summarization、runtime lifecycle/work-mode 等直接引用，移除旧工具、Provider、Flush、scope/store/RPC/maintenance/path 和 helper 语义。整体早期 `persistent-service.md` 增加明确 historical 边界；已明确废弃的 context v1.2/v2 正文不改写。
- distributed-runtime 需求、总纲和执行规格不再把 memory/people/journal owner、global state、resource/mutation、generation participant、maintenance/cutover 或交付 landing row 作为当前合同；对话 owner、assignment、generation、恢复、调度、transcript retention 与其他全局域保持。AE-001 的“原始构想”段逐字未动；其后的当前事实、架构图、领域/所有权矩阵和迁移边界明确旧 Memory 已退场，未来接入 OWNWARD、另行重建或长期无记忆仍待独立产品决策，本文不预建抽象。
- 最终残余分类经语义反查成立：当前正向旧语义仅命中续做记录列出的 16 处，均已纠正；S7 retired token、server `retiredMethods`、旧 resource/工具拒绝、`./memory` export 禁止和 sentinel 零访问属于负向防回归；`MemorySecretStore`、测试内进程中 directory/store、RSS/heap、模型上下文、`AgentRoleProfile` 与 Authority/Run/Job Journal 属非产品同名；第三方能力对照、明确 DEPRECATED/HISTORICAL 正文及 draft/archive/decision/postmortem/source-analysis、旧 review/checklist/ledger 和任务执行记录保留当时事实，不构成当前授权。

#### 实际命令与结果

- 直接测试串行通过：core environment selection + classifier 41/41，orchestrator sub-agent factory 25/25，CLI conversation protocol runtime 25/25，合计 91/91。CLI 单文件测试耗时约 131 秒；首次取回包装在进程仍运行时提前结束，等待其退出后只重跑该失效证据，最终无业务失败。
- `pnpm contracts:typecheck`、`pnpm contracts:lint` 通过；先以 `pnpm s7:registry-golden` 确认两条 landing row 的预期漂移，生成并审查 golden 后，完整 `pnpm s7:lint` 通过 production coverage、21/21 mutation tests 与 registry golden，没有以单独 entry script 代替。
- `pnpm runtime:baseline` 首次在行为 golden 4/4 均通过后精确暴露 structure golden 漂移；用显式 `ZHIXING_UPDATE_GOLDENS=1` 只更新并检查该单项，确认仅为 M1～M6 拓扑引用计数下降，最终重新运行 canonical baseline 全部通过：十个受影响闭包 build、runtime package exports、server behavior 3/3、CLI lifecycle 1/1、server structure 1/1。core build 只输出既有 Rollup circular-chunk 警告。
- 最终 `git diff --check` 与精确 retired identifier、当前 README/帮助、现行规格、distributed-runtime/AE-001、package export/tarball 双向检索通过；索引保持为空。未运行 M8 的根级 `pnpm lint` / `pnpm test` / `pnpm build`、完整 canonical `pnpm package:check` 或五面对抗复核；未访问用户真实 `ZHIXING_HOME`，未执行 Git 暂存、取消暂存、提交、历史改写或推送。

#### 协调反证续做与失效闭包重验

- 协调者从非退役标识符的中文语义取得反证：core `WorkScene` 仍宣称“独立记忆域”，删除合同仍列出 `me/`；server directory、RuntimeHost 与 CLI 验收标题仍把场景删除/装配描述为绑定记忆域；security classifier/types 与通用 ToolDefinition 仍以 memory 数据/工具解释 app-state；同根复核又发现 REPL 退出注释保留“末窗记忆 flush”、sub-agent prompt 注释保留“用户记忆”、手动 compact 注释保留 assignment memory write，以及 access-surface 留有无所属属性的 journal maintenance 注释。根因是首次残余检索依赖退役符号，未覆盖中文职责语义和通用示例。
- 续做把上述 11 个文件中的 16 处表述改为真实存活职责：WorkScene 只含显式场景身份、meta 与 conversations；RuntimeHost 只装配本机授权工作区、`worksceneIdentity`、power role/profile；app-state 以存活的 schedule/skill 工具说明；场景退出、compact 与 sub-agent 注释只描述实际 lifecycle/context 行为。生产语句、类型与断言行为未变。
- 全仓语义反查覆盖 `packages/` 源码/测试、构建与注册脚本、公开 README、现行规格、distributed-runtime 三份核心文档和 AE-001，并同时搜索“记忆域/个人记忆/`me/`/journal/people”及中英文旧工具、RPC、owner/store/maintenance 表述。剩余命中均属于：S7/server/core 的退役负向门禁；进程内/RSS/模型窗口等非产品同名；OpenClaw/Hermes 等第三方事实；或顶部已明确 DEPRECATED/HISTORICAL 的 context v1.2/v2 与 persistent-service 正文。`context-architecture.md` 只移除已删除规格的失效链接，v2 正文未改；没有以历史命中冒充当前授权或批量清洗。
- 只重验失效闭包：CLI RuntimeHost 直接测试 3/3，通过；Biome 对 11 个续做源文件/测试静态检查通过；完整 `pnpm s7:lint` 再次通过 production coverage、21/21 mutation tests 与 registry golden；最终 `git diff --check` 和语义残余检索通过。本轮只改变注释与测试标题，runtime baseline、core tarball、contracts 门禁及此前 91 项直接测试所验证的可执行、类型与公开出口事实未改变，按协调要求不重复；M8 根级门禁仍未运行。

#### M8 冷启动反证触发的索引纠正

- M8 第五面首次冷启动抽查发现：`persistent-service.md` 文件头虽已明确标为 `HISTORICAL`，规格 README 却仍把它列在当前“规格索引”并标“待审阅”，会让其中旧 Memory / Journal maintenance 正文继续呈现为当前候选规格。该反证使 M7、M8 与当轮冻结证据立即失效；状态曾按规则退回 M7、6/8。
- 最窄纠正只把该入口从当前规格表移到“历史资料”，并显式反绑 distributed-runtime 现行合同；正文与其他历史材料未改。静态分段检查确认当前规格索引不再包含该入口，历史区恰一保留并标注 `HISTORICAL`；distributed-runtime 三份核心文档、AE-001 当前设计与规格索引的退役产品符号精确复核零命中，`git diff --check` 通过。M7 因而重新闭合；该现行索引变化使此前 M8 全部冻结证据作废，必须在新基线上从八项门禁与五面对抗完整重做。

M7 的测试样本、结构门禁、registry/golden、构建制品和现行文档已与无旧记忆模块的当前代码事实闭合；M7 标记 `[x]`，完成度为 7/8，下一检查点是 M8。

### M8 执行记录（2026-08-28）

#### 冻结基线、反证与重验规则

- 进场基线为 `HEAD 231bd8efc4f0c7f14025ea3900e1363e646abf6e`，工作区与索引为空。最终冻结基线为该 HEAD + `memory-removal-M8-final-adversarial-20260828-r3`：产品/验收输入差异只有 `scripts/npm-production-install-script-audit.json` 的真实安装版本同步和 `research/design/specifications/README.md` 的历史入口纠正；本文其余差异只记录状态与证据。最终门禁开始后没有再修改源码、测试、构建配置、产品文档或验收输入。
- 第一轮 canonical package check 从 Windows x64 tarball 的干净 npm 安装取得真实反证：依赖解析得到 `protobufjs@7.6.6`，审计清单仍固定 `7.6.5`。追踪公开 Feishu 包到 `@larksuiteoapi/node-sdk@1.60.0` 的 `protobufjs ^7.2.6` 后，分别隔离打包 7.6.5/7.6.6；两版 `postinstall` 内容与 SHA-256 均相同（`5AF8463B97EE8E309B4A2111F9479BACDF0C180DE0CA0155527679B1FC6D9E6C`），脚本只读包清单、没有网络/系统/home 写入。审计清单最窄更新到实际 7.6.6，旧轮冻结证据全部作废。
- 第二轮门禁通过后，第五面对抗又发现 `persistent-service.md` 虽已在文件头标为 `HISTORICAL`，仍被规格 README 列为当前“待审阅”规格。M7/M8 随即退回未完成；入口被移入“历史资料”并反绑现行 distributed-runtime 合同，旧 Memory/maintenance 正文未改写。第二轮证据再次全部作废，以下门禁与五面结论均来自修复后的第三轮同一冻结基线。

#### 八项最终门禁

| 顺序 | 实际命令 | 同基线结果 |
| ---- | -------- | ---------- |
| 1 | `pnpm contracts:typecheck` | 通过。 |
| 2 | `pnpm contracts:lint` | 通过。 |
| 3 | `pnpm runtime:baseline` | canonical baseline 完整执行至最后一项 server structure，受影响闭包 build、package exports、server behavior 3/3、CLI lifecycle 1/1 和 server structure 1/1 均无失败。 |
| 4 | `pnpm runtime:package-exports` | 通过；存活子路径可导入，`./memory` 保持不可导出。 |
| 5 | `pnpm lint` | 通过；含供应链脚本审计 4 个直接依赖/25 个已审查依赖、mesh TLS 16 个测试文件、secret boundary、canonical S7 21/21 + registry golden，以及 Biome 1540 个文件。 |
| 6 | `pnpm test` | 通过；14 个包、602 个测试文件、8647 项通过，只有 1 文件/3 项显式 provider integration 跳过。维护 hook 抛错与 test LLM dump 均为测试预期 stderr，没有功能失败或资源型补跑。 |
| 7 | `pnpm build` | 17 个 workspace 包全部通过；只有 core 既有 Rollup circular-chunk 警告。 |
| 8 | `pnpm package:check` | 通过；3/3 structure precheck、16 个公开包 Windows x64 tarball 干净安装/消费、安装脚本审计与实际 `protobufjs@7.6.6` 一致。实际制品 hash 为 `d56119a7c6a2386b7f911e211496161cd148b3264652bfdce4e569a3dfe9d988`，隔离安装新增 232 个包，卸载路径移除 51 个包。 |

八项命令严格串行且在最终冻结基线上各执行一次；没有通过重复全测收集日志或取得绿灯，也没有用单项脚本替代 canonical 门禁。

#### 五面对抗

| 面 | 试图推翻的结论与生产事实链 | 实际动作与观察 | 裁决 |
| -- | -------------------------- | -------------- | ---- |
| 真实生产可达性 | 从 `BUILTIN_TOOL_FACTORIES` / 默认 profile → `createAgentRuntime`、server `HandlerRegistry`、RuntimeHost extra tools、core 严格 global-state codec、setup-delivery owners 与 package exports 反查，尝试让旧工具、RPC、resource 或子路径经自定义配置和公开入口复活。 | built factories/names 的 exact-set 均只有 `read/write/edit/glob/grep/bash/load_skill/save_skill/admit_skill/web_fetch`；真实根 import `@zhixing/core/memory` 返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`；61-method server registry 对 `memory.profileGet`、`memory.peopleList`、`memory.journalStats` 均返回 `-32601`；built CLI help 无旧命令，执行 `memory` 以 unknown command 退出 1。tools factory、custom profile、retired authority resource 与 server golden 共 7/7 项直接测试通过；源码精确命中只剩 retired 负向门禁。 | 没有工具工厂、profile、RPC、global owner/resource、runtime-host、CLI 或 package export 旁路；失败均发生在真实公开/生产边界，未发现等价改名能力。 |
| 历史对话与上下文连续性 | 沿 transcript shard/repository → run commit/recovery → conversation/session → attention segment/summary → transfer/review → CLI/server projection，攻击最易因派生支路删除而断裂的损坏恢复、重复转移、clear/delete 原子性和响应丢失。 | core segment/repository/transcript/snapshot 103/103、owner transfer/run 65/65、CLI conversation/transfer/review 8/8、server clear/delete 原子性 3/3、CLI final-history/link 响应丢失 1/1，合计 180/180。覆盖原文自愈、segment/窗口、转移幂等与损坏拒绝、run 重驱、review、clear/delete 失败原子性和投影丢失恢复。 | 删除的只有长期记忆派生支路；存储事实、会话权威、恢复、上下文连续性和产品投影无可观察回退。 |
| 非记忆交界 | 攻击 M2～M6 的共用边界：frontmatter、Skills/Rubrics、scene identity/trust/permission/lifecycle、app-state、scheduler、device/Authority/Run/Job Journal 和 workscene CRUD/cleanup，寻找“可编译但语义漂移”。 | core 9 个交界文件 89/89、orchestrator scene identity/trust 5/5、owner scheduler notices/global state 7/7、CLI RuntimeHost/workscene cleanup 9/9，合计 110/110。测试直接命中 producer/consumer，而非只检查类型存在。 | 中性 owner、场景身份、权限、调度、耐久日志和工作场景行为仍成立，没有把非记忆职责随旧模块删除。 |
| 旧数据与副作用 | 在首次 authority 启停和真实 conversation cleanup 中，试图观察程序创建、枚举、打开、读取、写入、改名或删除旧 personal/workscene `me` 数据。 | `retired-memory-storage.test.ts` 在显式临时 home 预置两处 sentinel，并对 `node:fs/promises` 全部相关操作安装旧根拦截；1/1 通过，零 forbidden-root 命中、两处 sentinel 路径和内容原样，存活 conversation 目录按合同删除。临时 fixture 自动清理；未读取用户真实 home。 | 正式入口对旧位置零创建、零扫描、零读写、零迁移，且不会借会话/场景清理删除预置旧数据。 |
| 公开协议、制品与现行文档 | 从 canonical registry/help、server RPC、S7/golden、实际 tarball 安装、package exports 和现行规格入口反查，尝试 import/call/command 协商旧能力，并检查历史正文是否仍被索引为当前授权。 | canonical package check 完成实际 Windows x64 干净安装；旧 import/RPC/CLI 真实失败动作如上，server golden 3/3。distributed-runtime 三份核心文档、AE-001 当前设计和规格 README 的退役产品合同精确检查零命中；AE-001 明确旧模块退场且 OWNWARD/重建/长期无记忆仍未决。context v1.2/v2 标 `DEPRECATED`，persistent-service 现位于“历史资料”并标 `HISTORICAL`。 | 公开协议、help、registry、制品和现行授权均不可见旧能力；历史正文保留但不会恢复当前授权，未来方案未被预建或替用户决定。 |

五面对抗另取得 298 项代表性直接测试（7 + 180 + 110 + 1；server golden 已计入首面），与根级 8647 项测试和实际制品动作互为独立证据。关键词检索只用于在生产入口追踪后的反向核对，没有把“零命中”单独当作完成证明。

#### 清理、遗留与最终结论

- package-check、core pack 和 retired-memory-storage 使用的隔离临时目录均为零残留；进程核对未发现 package-check、pnpm/vitest/tsx/tsup/npm install helper 或子进程。最终 `git diff --check` 通过，索引为空；没有执行暂存、取消暂存、提交、历史改写、推送或发布。
- 全过程未访问、扫描、迁移或删除用户真实 `ZHIXING_HOME`。两项成立反证都已在任务硬边界内最窄修复，并在新冻结基线上从八项门禁和五面对抗完整重做；最终没有未处置 P0/P1，也没有待用户裁决的产品冲突。
- M1～M8、九项退出门、八项 canonical 门禁与五面对抗在最终同一基线上成立。任务完成度为 8/8，状态进入“待用户确认”；用户确认前停止，不开始未来记忆方案或 AE-001 架构迁移。

## 十、用户提示词

### 收敛记忆模块剔除任务

```text
目标：持续审查并收敛 `docs/tasks/memory-module-removal.md`，直到它成为一份真实、完整、无歧义且可直接接入知行持续协调自主开发体系的任务契约；协调者仅依据本文、仓库事实和有效证据持续派发工作包，完成全部任务后，就能客观证明现有记忆模块已经彻底剔除，历史对话持久化与全部非记忆功能没有受到影响。

以下三项是不可修改、不可弱化的产品要求：①历史对话持久化的存储事实、对外合同、恢复能力和连续性绝对不能被删除、降级或产生可观察变化；允许的只有拆除记忆依赖所必需且行为等价的最窄内部调整；②除现有记忆能力消失外，知行其他任何功能都不得回退；③现有记忆模块必须删除干净，不得留下生产实现、公开入口、协议、存储访问、迁移、兼容壳、禁用分支或可重新激活的残余。未来是否接入 OWNWARD、重新设计记忆模块或永久不再提供记忆能力尚未决定，均不得进入本任务。

本文中的任务目标、对象定义与硬边界以及上述三项要求是收敛依据；当前源码、测试、构建配置、公开文档、Git 历史和运行组合根只用于核实真实现状、依赖闭包与任务可执行性，不能反向降低目标。不得轻信单份文档、命名或关键词搜索；必须沿真实生产入口和消费链判断“什么属于现有记忆模块、什么属于历史对话持久化、什么只是被错误放在 memory 目录下的非记忆共用能力”。本文现有实施项和结论均待复核，不得因为已经写入文档而自证正确。

只允许修改 `docs/tasks/memory-module-removal.md`。不得修改代码、测试、其他文档、工作台提示词或 Git 状态，不得实施删除、运行正式构建或验收，也不得把任务状态或任何 M 项提前标记为完成。

每次开始、恢复或上下文压缩后，重新完整读取本文，检查仓库当前状态，并基于当前代码事实继续。持续执行以下循环：

1. 重新建立严格对象边界。正向枚举现有记忆能力实际提供的 Profile、People、Journal、显式记忆工具、自动提炼、全局状态和旧数据接管等产品语义，再反向追踪其 producer、consumer、组合根、公开出口、协议、存储、维护、迁移、测试和文档。任何删除项必须同时反绑记忆语义和当前可达事实；不能靠目录名、类型名或单份规格判断。
2. 独立建立历史对话持久化保护闭包。覆盖 transcript 原文和 clear 边界、owner 会话权威与 run 提交、session/conversation 创建切换恢复和历史浏览、attention window、上下文压缩、segment 与摘要、RPC/CLI/server/渠道投影及崩溃重驱。逐个交界证明任务只删除从这些事实派生长期记忆的支路，不删除、改写或降级对话事实本身。
3. 审查其他功能的保护是否完整。沿记忆模块与 core、tools、orchestrator、owner-kernel、runtime-host、server、CLI、distributed-runtime、skills、rubrics、权限、任务、工作模式和打包交付的直接交界，确认所有共用职责都有最窄的中性归属和保护性回归，删除不会形成断链、隐式行为变化或为了通过编译而误删消费方。任务不得用“模块理论上独立”替代实际证明。
4. 审查零残留闭包。任务必须覆盖旧实现、对外导出、默认配置、工具与 RPC、提示与界面、注册表和 golden、全局查询/变更/提交合同、owner 与维护、post-adoption/Memory Flush、旧目录 reader/writer、import/cutover、构建与 tarball、现行规格和未来架构中的旧迁移对象。禁止以改名、空实现、deprecated、feature flag、兼容别名、保留 reader 或“以后可能复用”为由留下可达残余；历史记录和用户既有私人数据按本文边界保留，但最终程序必须对旧数据零创建、零扫描、零读写、零迁移。
5. 审查实施顺序和任务颗粒度。每个 M 项都必须形成可由协调者继续拆分的完整责任链，写清前置条件、必须交付的生产端与消费端、边界、直接测试、文档和完成证据；依赖顺序必须避免长时间破坏构建或留下半条生产链。不得把文件清单冒充任务，也不得把同一根因拆成重复工作、把未来能力或顺手重构扩入范围。
6. 审查状态与证据规则。文档必须支持从同一检查点恢复，勾选只能代表当前基线上的完整事实，证据失效时能够精确回退；执行记录、阻塞、下一检查点、用户确认和 Git 边界必须足以让调度者独立判断整体进度，不能依赖执行者自报、历史绿灯或对话记忆。
7. 审查验证与效率。每项使用能够证明其合同的最窄直接证据，最终同一基线才运行必要的根级与制品门禁；严格复用 `research/design/workbench/verification-runbook.md` 已确认的 Windows 运行方式，避免并发重型验证、重复全测和旧 dist 伪失败。效率不得通过删除保护性测试、跳过生产调用图、缩小零残留范围或降低非记忆功能保障获得。
8. 极致删减。只保留会改变范围判断、任务执行、状态恢复、验证或完成裁决的信息；删除重复解释、作者心理、无法反绑事实的风险设想和不产生不同动作的描述。删减不得损失三项产品要求、真实依赖闭包或自主调度所需信息。

准备结束时，对同一份未修改任务文档执行五次相互独立的冷启动复审，不得复用前轮结论：

- **范围真实性**：每个删除事项是否确属当前记忆模块且真实可达，每个保留事项是否有清楚职责，是否存在漏项、错删或依赖单份文档的判断。
- **对话持久化保护**：仅按任务文档执行时，是否存在任何路径会破坏历史原文、会话权威、恢复、上下文、segment、摘要或历史浏览。
- **非记忆功能保护**：删除链的每个直接交界是否都有正确处置和可识别回归，是否可能出现“编译通过但其他功能语义已经变化”。
- **零残留**：生产、公开、协议、数据、迁移、制品和现行文档是否都具有可验证的退场条件，是否仍可能隐藏、重启或重新协商旧能力。
- **调度与结束有效性**：外部协调者是否能据本文持续选择最关键工作包、维护真实状态、只重验失效闭包，并在全部要求真正成立时客观结束，而不是仅完成一组文件修改。

任何一次复审发现真实问题，都直接修复本文，并从头重新执行全部五次复审。不得为了显得严格而加入没有源码事实或产品依据的问题。

只有三项产品要求拥有完整、准确且互不冲突的任务落点；现有记忆模块的真实可达闭包与历史对话保护闭包均已覆盖；所有非记忆交界、共用职责、数据安全和文档/制品处置都可直接执行并验证；M 项依赖、状态维护、工作包拆分、证据失效和最终退出门足以支撑持续协调自主开发；任务没有范围遗漏、误删风险、残余路径、重复工作、实现猜测或未处置反证，并通过全部独立复审时，回复“记忆模块剔除任务文档收敛完成”，简要说明最终判断和实际修改，立即停止；不得开始实施删除或修改协调提示词。
```
