# 项目存量文档清理与归位

> 类型：用户协作文档<br>
> 当前进度：已处理 65 份；工具体系文档组已迁移，待用户审查。

README 只承担入口、简要概览与导航，核心需求、架构设计和实现说明必须由职责明确的正文文档承载，不得以 README 代替。

## 一、目标

清理根级 `research/` 下的文档及配套资源：

- **有价值的归位：** 按文档职责放到正确位置，不整体搬进某个预定目录。
- **无价值的删除：** 空架子、无实质或独立保留价值的内容，经用户审核后清退；不能仅因早、旧、短或未使用就删除。
- **过时的更新：** 有价值的模块架构文档保留其职责和位置，保留原始构想、有效需求与核心架构思想，仅替换过时的设计和实现说明，不留下空占位。

## 二、核心依据

**目录归属以[项目文档体系维护技能](../../.agents/skills/maintain-project-docs/SKILL.md)为准。技能尚未定型，需要随实际需求迭代：找不到合适位置就暂停，报告目录缺口与扩展建议；用户确认后先更新技能，再按新规则提出迁移建议。不得硬塞或先搬后补规则。**

内容更新以有效需求、最新设计和真实生产实现共同核实。分布式运行时及后续架构迁移可能影响早期模块，但不能据此认定所有旧内容都失效；熟悉项目技能的模块索引只是线索，不是完整清单或现状依据。设计与实现有差异时明确说明，不擅自降低需求，也不把未实现的设计写成现状。

历史与研究材料按其保留价值判断，不强行改成当前实现说明；目标位置已有同职责文档时，提出合并建议，保留独有内容，不制造重复权威。

凝练不得损失有价值的比较关系、选型依据和设计理由；旧表格或图示若承担这些职责，应校准后保留或等效重构，不能仅因相关词句仍在就判定完整承接，迁移与复审均须核对。

## 三、逐份审核与处理

1. **确定审查单元。** 判定为独立文档或确定目标文档数量前，先核查正文引用、反向引用、同主题决策与迁移记录，必要时追查 Git 历史；没有 V2 文件不代表没有后续演进。不能只沿已知文件的链接找同组文档：须用模块中英文别名及核心子职责扫描全目录文件名与正文，纳入没有互链的专题；宣布该组处理完成前复扫剩余文件。独立文档逐份分析；同一模块的多版本、重设计或实施配套文档，列清各份职责、先后与替代关系，作为一组整体分析。区分本组正文、配套记录与相邻参考，不因引用关系扩展到全局架构或其他模块。
2. **提出方案并等待审核。** 完整阅读本单元文档，核对必要的源码和引用，说明各份的时效性、保留价值、删改与合并建议，以及最终文档数量、职责和目录位置。迁移结果按当前有效职责组织，不按历史版本组织；保留有效需求与核心思想，过时设计和实现说明按最新有效设计及生产事实校准，不以改名搬迁代替更新。单份或整组方案均经用户批准后执行；出现目录缺口先按上节完善技能。
3. **按批准执行。** 迁移、删除或更新，并同步相关链接、索引、附件及脚本中的路径引用。范围变化重新请求批准，不顺手修改产品功能。
4. **反馈结果。** 检查内容没有误删、引用没有断开，简要报告实际处理结果，接着分析下一个审查单元，等待用户批准后再操作。

只检查本次处理受影响的内容和路径，不为文档整理重复全量构建或测试。逐份处理不等于批量授权，不需要套用自主调度工作包、阶段门或多轮对抗流程。

## 四、处理记录

只登记已讨论的文件、用户决定和实际结果；下一次从未完成项继续，不重复审查已处理内容。

| 源文件 | 用户批准的处理方式与目标位置 | 处理结果 / 待确认事项 |
|---|---|---|
| `research/README.md` | 用户确认无保留价值，直接删除，不提炼或迁移 | 已删除，并移除 `docs/README.md` 中的导航链接 |
| `research/design/README.md` | 用户批准删除旧设计导航，不迁移 | 已删除，并移除 `docs/README.md` 中两处索引链接；保留历史任务记录 |
| `research/design/principles.md` | 用户确认保留顶层哲学职责；先补技能树，再迁至 `docs/philosophy.md` | 已迁移并同步规则索引引用；后经用户确认填入产品、架构与体验哲学，安全哲学待定 |
| `research/design/differentiators.md` | 用户批准删除无实质内容的策略框架 | 已删除，无需迁移，无 Markdown 引用待修复 |
| `research/design/implementation-roadmap.md` | 用户批准删除过时且无独立保留价值的路线图 | 已删除并清理活动链接；保留历史文字记录与具体规格文档 |
| `research/design/specifications/context-architecture.md`、`context-management-v2-redesign.md`、`context-management-v3-redesign.md` | 用户批准按上下文模块整体整合 | 有效需求与取舍、当前窗口／段切换／恢复边界收敛至 `docs/modules/context/architecture.md`；三份旧版本已删除 |
| `research/design/problems/context-management-redesign.md`、`research/innovations/capability-compiler.md`、`tool-result-anchor.md` | 同组整合，保留必要演进理由 | 必要取舍并入上下文架构；已退役方案与过程记录清退，三份旧文件已删除 |
| `research/design/implementation-v3-context-phase1.md` | 同组整合，保留有效设计而非旧计划 | 上下文思想并入总体架构，任务列表设计校准后归入 `docs/modules/conversation/task-list.md`；旧文件已删除 |
| `research/design/specifications/llm-summarization.md` | 同组整合，摘要职责按当前实现校准 | 有效摘要目标并入上下文架构；旧七段模板、策略链与计划清退，旧文件已删除 |
| `research/design/specifications/turn-context-injection.md` | 同组整合，保留独立动态注入职责 | 更新至 `docs/modules/context/turn-context-injection.md`；旧文件已删除，相关导航与链接同步更新 |
| `research/design/drafts/lifecycle-concepts.md` | 用户批准独立迁至 `docs/architecture/lifecycle-concepts.md` | 已保留三项概念与四个介入边界，校准窗口与 Run 的交错关系，清理草稿模板并同步引用；相关实现文档尚未迁移 |
| `research/design/specifications/agent-runtime-lifecycle.md` | 用户批准独立迁至 `docs/modules/conversation/runtime-lifecycle.md` | 已保留四钩子、窗口稳定与提交边界，按当前 Host／Kernel／产品投影校准实现，清理旧实施步骤并同步引用 |
| `research/design/drafts/transcript-schema-debt.md` | 用户批准删除已失效的债务备忘，不迁移 | 已删除并清理草稿索引引用；会话持久化主体文档仍待单独处理 |
| `research/design/specifications/session-persistence.md` | 用户批准删除已归并的旧索引，不迁移 | 已删除并清理导航链接；保留历史文字记录，持久化主体文档与功能未动 |
| `research/design/drafts/transcript-retention.md` | 用户批准删除已被替代的旧治理过程，不迁移 | 已删除并清理来源引用；后续持久化架构与对话模型文档保留待处理 |
| `research/design/drafts/transcript-persistence-and-attention-window-architecture.md` | 用户批准保留核心语义、校准后迁至 `docs/modules/conversation/persistence.md` | 已保留两层分离、连续性、接受、clear、快照与存储治理；更新权威日志／投影边界，登记装填与读取差异，同步《对话模型》持久化段落与引用；未修改功能 |
| `research/design/drafts/onboarding-connection-test.md` | 用户确认无独立保留价值，直接删除，不迁移 | 已删除并移除草稿索引条目；现有配置与就绪功能未改动 |
| `research/design/drafts-roadmap.md` | 用户确认删除旧流程与不完整索引，不迁移 | 已删除并清理两处导航文字；其他草稿与正文未删除 |
| `research/design/active-problem.md` | 用户确认删除空工作台，不迁移 | 已删除并清理旧流程引用与失效历史出处；关联设计正文保留 |
| `research/design/specifications/cli-ui-design-language.md`、`input-zone-visual.md`、`research/design/problems/cli-ui-visual-foundation.md` | 用户批准整合为 `docs/modules/cli/visual-language.md` 与 `input-visual.md` | 已保留有效视觉原则、输入形态与渲染边界，校准当前实现并清退旧稿；Staging 底部信息行的生命周期与刷新顺序已承接，其余记录未动 |
| `research/internals/screen-rendering/overview.md` | 用户批准单独迁至 `docs/modules/cli/screen-rendering.md` | 已复核并校准局部状态、缩放清回卷与失效实现引用；保留两种屏幕的取舍、能力边界与防错规则，同步引用；关联架构稿和复盘未迁移 |

| `research/design/specifications/input-typeahead.md`、`research/design/migrations/command-system-unification.md`、`research/design/architecture/decisions/009-command-system-unification.md` | 用户批准按文档组迁移至 `docs/modules/cli/input-completion.md` 与 `command-system.md` | 已承接有效设计与统一命令取舍，校准输入生命周期、候选动作与宿主调用链；明确常用计分未接入、通用参数校验及超时行为边界，未改功能。三份旧文件已删除，相关索引、链接与源码注释引用已同步；Staging 只处理相关输入记录，其他职责保留 |

### 待处理检查点

工具体系处理记录：用户批准将 `research/design/specifications/tools-builtin.md`、`tool-permission-execution.md` 与 `research/design/architecture/decisions/004-tool-system-architecture.md` 收敛为新建 `docs/modules/tools/architecture.md`、`permission-integration.md`、`web-fetch.md`，三份旧稿已删除。保留协议／实现分离、操作级安全、声明接入、用户规则优先和预置规则生命周期等取舍；按当前 Host／Kernel／Trust 校准装配、批准与换代，保留 WebFetch 模式对照并明确缓存、取消及异常边界。安全／信任／确认专题、外部研究和已有 grep／轻量循环正文未整体迁移；仅同步直接引用与索引，源码仅改文档引用。未改功能，未执行 Git 写操作，待用户审查。

Outbox 处理记录：用户批准将 `research/design/specifications/message-outbox.md` 与 `research/design/architecture/decisions/007-message-outbox.md` 合并至新建 `docs/modules/delivery/outbox.md`，两份旧稿已删除。保留因果需求、职责与方案对照、Slot 和 commitment 演进理由；按当前权威 Delivery／渠道效果／Host 校准。明确默认 TTL、发送失败及重启后内存 Slot 与强因果要求之间的差异，不把尝试排序写成送达保证。相邻文档仅同步直接引用与相关冲突说明，未迁移其主体，未改功能；待用户审查。

网络出口处理记录：用户批准将 `research/design/specifications/network-egress.md` 校准后迁至新建的 `docs/modules/network/architecture.md`，旧稿已删除。保留共享防护、DNS 与代理取舍、两张代理对照表、结构化错误和资源所有权；补齐两种 fetch 的合同与 WebFetch／MCP／Host 消费链，明确代理 DNS、取消／连接池及诊断脱敏的实际边界，不把设计要求写成已实现保证。入口、规格索引、WebFetch 相邻说明与两处源码注释链接同步；相邻模块未整体迁移，无功能修改，待用户审查。

MCP 处理记录：用户批准将 `research/design/specifications/mcp-host.md` 内的运行架构与后续接入演进整体收敛为 `docs/modules/mcp/architecture.md`、`onboarding-and-management.md`，旧稿已删除。保留连接／工具分离、统一安全、映射表、接入事实来源与两阶段搜索理由；按 Host 与执行设备生命周期、秘密投影和配置换代校准，明确工具筛选、命令解析、鉴权补录及来源校验的实际边界。同步入口、规格索引与轻量工具循环引用；外部 MCP 调研、通用轻量循环及相邻安全／配置文档各自保留，不改功能。迁移待用户审查。

轻量工具循环补正：迁移时将四种 LLM 使用形态的对比表压成概述，丢失横向比较与选型价值，首次复审未识别。经用户指出并批准，已按当前实现补回对比表与选择依据；保留原语与单发调用、主对话、Task 子 Agent 的关系，不恢复过时接线。此项应重新核对，不能沿用此前“完整承接”的结论。

轻量工具循环处理记录：用户批准将 `research/design/specifications/lightweight-tool-loop.md` 校准后迁至 `docs/modules/tools/lightweight-tool-loop.md`，旧稿已删除。保留程序发起的小任务、事实约束与模型判断分离、场景校验和副作用保护，校准当前输入校验、历史截断、异常与取消边界及 MCP／工作场景两条宿主接线；清退旧实施说明与未经证明的升级承诺。MCP 正文只同步原语引用，业务职责保留；文档入口与规格索引同步，历史检查表不改。不改功能，待用户审查。

容错处理记录：用户批准将 `research/design/specifications/resilience-engine.md` 校准后迁至新建的 `docs/modules/resilience/architecture.md`，旧稿已删除。`phase2-complete-agent.md` 的容错专节与 2B-1 旧步骤改为引用，其他职责保留。承接自动恢复、失败可见、故障隔离和策略分离思想，回填当前包装器、内容输出安全边界、取消／watchdog、事件及熔断生命周期，明确分类次数表不驱动重试、等待取消与冷却探测等现状限制，不把跨层规划写成现行能力。Provider 引用与文档入口同步；外部调研、中断执行、常驻服务及调度器不随本次迁移。不改功能，待用户审查。

Provider 处理记录：用户批准将 `research/design/architecture/decisions/002-provider-architecture.md`、`research/design/specifications/provider-layer-evolution.md`、`anthropic-adapter.md`、`secondary-llm-capability.md`、`role-recommendations.md`、`thinking-control.md` 与 `research/design/drafts/model-budget-resolution.md` 七份正文收敛为 `docs/modules/providers/architecture.md`、`model-metadata.md`、`model-roles.md`、`anthropic-adapter.md`、`thinking-control.md` 五份正文。旧稿已删除，相关引用同步；保留协议与角色分层、目录非白名单、预算优先级、调用隔离、原生思考参数和签名保真，按 Host binding、秘密投影及当前消费链校准。明确 SDK 重试与业务恢复区别、思考目录和方言接线限制、未知型号校验边界，不改功能。容错、秘密存储与首次引导、配置系统、轻量工具循环和外部调研各有独立职责，未随本组迁移；Staging 相关角色分流记录已归位，其他记录保留。下一候选为容错引擎，须先分析完整关联范围，再报用户批准。

用量展示处理记录：用户批准将 `research/design/specifications/usage-display.md` 迁至 `docs/modules/cli/usage-display.md`，旧稿已删除，导航同步。保留安静默认、按需详情与成本透明的意图，校准状态条、容量估算／API 消耗／缓存、会话查询与子任务拆分、整理反馈；明确费用、构成分析及旧显示配置未落地，展示标尺不等于自动切段阈值。模型预算解析、子 Agent 正文及 Staging 历史记录不随本次迁移，不改功能。

工作场景漏项补迁：用户批准将 `research/design/drafts/work-scene-workdir-binding.md` 的按需绑定与目录输入设计意图补入已有 `docs/modules/workscene/management.md`，旧稿已删除。明确自动引导及专用目录输入尚未形成完整实现，取消不等于默认目录授权，材料采集不等于绑定；清退旧接线、成本估算与未经当前验证的终端矩阵。整组四份旧正文收敛为两份现行正文，本次补迁待用户审查。`staging.md` 为共享配套记录；权限、对话作用域、ZHIXING.md 注入及全局架构材料各有独立职责，不随本组整篇迁移。漏查教训已补入上方审查单元规则。

工作场景处理记录：用户批准将 `research/design/agent-vision.md`、`specifications/work-mode.md`、`drafts/workscene-management-architecture.md` 三份整合为 `docs/modules/workscene/architecture.md` 与 `management.md`，旧稿已删除。承接有效产品思想、统一管理和智能创建需求，按领域应用、assignment 提交、设备工作空间及 owner 会话恢复校准；Staging 中本模块记录归并，其他记录保留。未修改产品功能，迁移质量待用户审查。

SSP 处理记录：用户批准将 `research/design/drafts/stepped-skill-protocol-adoption.md` 独立迁至 `docs/modules/skills/ssp-adoption.md`，旧稿已删除并更新导航。保留协议独立权威、采纳原则和分层集成方向；校准开发辅助技能与产品运行时的区别，以及正文入库不保留步骤附件、不能保证入口回退的现状。配套技能未改，未实现协议集成。

技能处理记录：用户批准将 `drafts/skill-module.md`、`capability-internalization.md`、`skill-new-ux-redesign.md` 与 `specifications/skill-system.md`、`skill-authoring.md`（均原属 `research/design/`）整合为 `docs/modules/skills/architecture.md` 与 `authoring-and-admission.md`，五份旧稿已删除。保留渐进披露、能力内化、创作与管理分责、来源保护及独立接入审查；按 Skill Catalog、assignment 与制品提交校准实现，明确附件保留、模式更新、归档恢复、禁用补全及成功反馈的设计／实现差异。随后经用户批准将 `specifications/skill-evolution.md` 独立迁至 `docs/modules/skills/evolution.md` 并删除旧稿：保留自主沉淀、来源保护、用户接管、治理与反馈设计，删除过时接线，区分未实现要求、当前基础与候选机制。SSP 采纳记录已另行迁移，见上条；外部调研和历史审查记录未迁移。未改功能。

编排与多视角处理记录：用户批准将 `file-based-orchestration-infrastructure.md` 与 `multi-perspective-divergence-convergence-architecture.md` 分别迁至 `docs/modules/orchestration/architecture.md`、`docs/modules/conversation/perspectives.md`，两份旧稿已删除。保留需求区与用户原话，校准通用模板能力、会话应用归属、耐久提交、资源和呈现；相邻子 Agent 规格及历史审查记录保留，不改功能。

grep 处理记录：用户批准将 `research/design/drafts/core-grep-search-architecture.md` 迁至新建的 `docs/modules/tools/grep.md`，旧稿已删除；吸收 `release-0.1-readiness-issues.md` 的相关实现取舍，并将该文档与 `phase2-complete-agent.md` 的 grep 专节改为引用，其余内容保留。新文档区分搜索合同与 ripgrep 预筛选、编码、预算及展示传输现状；未改代码。

编辑差异处理记录：用户批准将 `research/design/drafts/cli-edit-diff-rendering.md` 迁至新建的 `docs/modules/cli/edit-diff.md`，旧稿已删除。保留单次修改差异、展示隔离、静态 scrollback 与视觉取舍；回填现有生成器、统计和渲染上限，明确常规 REPL 的 RPC 剥离造成的展示接入缺口及极窄屏限制。相邻搜索、发布、任务推进文档保留，未修改代码。

文本粘贴处理记录：`research/design/problems/multiline-paste-attachment.md` 已迁至 `docs/modules/cli/text-paste.md` 并删除旧稿；原粘贴追踪文档第 1～4、6、7 项的有效内容已承接，相关故障复盘保留。正文按当前检测、保活和提交链校准，未改功能。

材料输入处理记录：用户批准将 `research/design/drafts/cli-multiline-paste-issues.md` 剩余第 5、8～15 项按共同输入与 CLI 采集两项职责迁移；已新建 `docs/modules/conversation/material-input.md` 和 `docs/modules/cli/material-input.md`，旧追踪文档删除。保留有效产品语义、路径意图与失败边界，校准当前 parts、能力检查及引用生命周期；明确统一材料存储未落地、字符串 handle 来源限制和提交回显与核心接受的差异。不改功能、不迁移故障复盘。

选择模块处理记录：`research/design/drafts/selection-module-architecture.md` 已按用户批准迁至 `docs/modules/cli/selection.md`，旧文件删除；吸收 `confirmation-ux.md` 的通用状态机与租约思想、任务推进 C2 的详情与按键升级，相关章节改为引用。保留业务文档及故障复盘，明确权限接入、实例互斥与异常清理等设计／实现差异，未修改功能。

- `research/design/staging.md` 暂缓删除，不作为现行设计权威，也不整体迁移。它混有 CLI 输入交互、对话、工作场景等历史设计；随对应模块迁移核对，只吸收仍有效、有价值且尚未承接的内容，直接写入新目录的模块正文，不先补旧文档再迁移。
- 输入补全、命令系统、选择模块、文本粘贴及材料输入已迁移；其余文档仍须核查谱系、提出方案并等待批准，不能将相邻材料默认视为单篇。
- Staging 的粘贴材料、差异展示、对话、工作场景等其余记录随后随所属职责核对。全部记录已承接或确认无需保留、引用已处理后，再提请用户确认删除 Staging；不能仅因当前 topic 为空就删除。

## 五、完成标准

`research/` 的内容已逐份经用户审核：有价值的已归位，过时部分已校准，无价值的已删除，配套资源与引用无遗漏。确认没有未处理内容后，经用户同意清理空目录；用户确认整体完成。本任务文档保留处理记录，不自动删除。

## 六、用户提示词：迁移质量审查

```markdown
审查刚才的文档迁移单元，判断迁移后的文档是否完整承接仍有价值的核心含义、准确反映当前有效设计与生产实现，并处于职责合适的位置。本轮只审查并报告，不修改文件、恢复旧文件、执行迁移或进行 Git 写操作。

先读取本任务文档、目录维护技能与用户批准的迁移方案，明确本轮源文件、目标文件和职责范围；同一模块的版本、重设计与实施配套文档必须整体核对。通过 Git 历史或尚可读取的迁移前版本核对旧内容，不以迁移者自报、文件名或新文档自证正确；无法取得必要旧版本时明确证据缺口，不宣告通过。

按以下标准审查：

1. 核心承接：旧文档中仍有效且有价值的需求、架构思想、关键取舍和职责边界，是否在新文档中得到准确承接。保留的是含义，不要求保留原措辞、篇幅或文件数量；不能因删掉旧方案而丢掉仍成立的设计理由。
2. 时效与价值：每项保留内容必须同时具备当前有效性与实际价值。已被替代的方案、错误现状、旧执行计划和无助于理解、设计、实现或维护的文字不得作为现行正文保留；历史取舍只保留对理解当前设计仍必要的原因，不整份堆存旧版本。实现与有效需求冲突时指出差异，不以源码为由擅自降低需求。
3. 必要回填：旧实现过时不等于文档职责失去价值。对仍需说明的职责，沿当前生产入口、责任归属、调用与消费链核实，补足其应有的最新核心设计与实现说明，不能删掉旧内容后留下空壳。分布式运行时和后续架构升级只用于核实对该模块的实际影响；不把全项目架构、源码细节或无关功能塞入模块文档。
4. 组织与归属：按目录维护技能检查位置和唯一权威，按当前职责而非历史版本划分文档；总体架构不能在拆分中消失，专题不能重复定义总体合同，README 只作入口与导航。找不到合适位置时报告技能树缺口，不硬塞、不自行扩树。
5. 迁移完整性：检查有效内容是否漏迁、相邻职责是否误删、旧版本是否仍冒充权威，以及链接、索引和配套资源是否指向正确位置。以实际内容与生产事实验证，不以文件已移动、命名整齐或链接检查通过代替质量判断。

完成标准：迁移后的文档必须完整、自足地说明本单元的核心需求、当前架构及关键实现思路；旧文档退出现行文档体系，Git 历史仅作迁移审查取证，不承担正文职责。有效且有价值的核心含义无遗漏，必要的新事实已补齐，无过时误导、低价值堆砌、重复权威或目录错位。

简要报告“通过”或“不通过”。发现问题时给出具体位置、旧文档或生产依据、影响和最窄修正建议，交用户审核后再修改；无真实问题直接通过，不硬找问题、不扩展功能、不启动代码整改或无关全量验证。修正后按受影响内容复核，未解决问题或关键证据缺口不得判为通过。
```
