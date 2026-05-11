# 活跃问题工作台 (Active Problem)

> 当下集中处理的**单一**具体问题的工作台。一次只承载一个问题，解决后内容整段清空，等下次启用换问题。模块级设计走 `specifications/`；新功能草稿走 `drafts-roadmap.md`；已沉淀的问题对齐记录归档于 [`problems/`](problems/)。本文件承载**正在调查 / 待决策 / 阻塞实施**的具体问题。

## 原则

本文档的维护规则。**原则稳定**；下方"当前问题"区随问题生灭整段重写。

- **聚焦产品方向，不是实现细节**：本文件用于对齐"做什么 / 不做什么 / 什么形态 / 什么边界"等**产品决策**；schema、字段清单、文件名、模块归属、API 设计等**实现细节**一律不在本文里讨论，留到独立文档（spec / ADR）阶段。
- **适用范围**：当下卡手或待拍板的**单一具体问题**——bug、配置问题、跨系统行为不一致、阻塞实施的小决策。需要并行处理多个问题时，拆到草稿或 spec，**不堆本文**。
- **文档目的**：把**现象 / 事实 / 根因 / 影响 / 选项 / 决策状态 / 待办**集中一处，避免反复回忆和重新排查；同时让任何时刻进入对话的协作者能 30 秒内对齐。
- **协作模式：分批渐进对齐**（**一次只引导一个 Phase**）：助理（AI）每次**只列出一个 Phase 的待确定问题**——每条附助理倾向 + 留给用户描述的空间，让用户先理解清楚当前 Phase 再回复。**严禁一次性预列多个 Phase**（不把 Phase 1 / 2 / 3 同时摆出来）；后续 Phase **必须**在前一 Phase 拍板对齐后才动手列出。每个 Phase 的循环：**列问题 → 用户回复 → 助理综合提炼为"对齐结果"（聚焦产品方向、不展开实现细节）→ 才进下一 Phase**。用户原话保留在工作期文档（本文）中作为对话痕迹，沉淀阶段不带入归档。
- **生命周期**：
  1. **触发**：遇到问题第一时间登记到"当前问题"
  2. **诊断**：补事实清单 + 根因分析
  3. **决策**：列选项、与决策者对齐方向
  4. **执行**：按待办清单推进
  5. **沉淀**：解决后把**有长期价值**的部分按性质迁出：
     - 排错套路 / 运维约定 → 模块 README 或 `specifications/*` 的 Operations 段
     - 设计决策 → 模块级 spec 或新建 ADR
     - 用户/开发者文档 → 项目根 README / docs
     - **完整对齐过程的脱过程版**（问题描述 + 各阶段对齐结果 + 设计落地引用，**去对话痕迹与用户原话**）→ [`problems/<topic>.md`](problems/) 归档
  6. **重置**：将"当前问题"区整段清空（保留模板骨架），等下次启用
- **不放本文**（边界守卫）：
  - 多问题并排队列 → 这是"工作台"不是"队列"，一次只一个
  - 模块级架构推演 → `specifications/`
  - 已解决问题的复盘归档 → 沉淀到 [`problems/`](problems/) 或对应模块文档（spec / ADR）后，本文不再保留（不维护"已解决"列表，靠 git history + `problems/` 找）
  - 长期演化记录 → 原地改，不追加历史
- **重启规则**：上一个问题沉淀完毕，下一个启用前**整段重写**"当前问题"——不要在旧内容上叠加。
- **何时升级**：决策点 >5 个 / 影响多模块 / 需要 ADR 长期留档 → 转为 `drafts/` 草稿或 `specifications/` spec，再从本文移除。

---

## 当前问题：v3 上下文管理实施进行中

> 触发于 2026-05-11：原 v2 滑窗 + 任务纪要范式与 Anthropic prompt cache 元规则①（前缀任何位置变化让其后内容缓存失效）冲突，方案重设为 v3——**cache 第一优先 + 优质注意力窗口 + 段式管理 + tools 满载稳定**。v3 spec 已完成代码现状对齐、字段扩展契约、Phase 1 砍除/新增清单、原子上线约束声明，进入实施前置阶段。

### 当前方向

- v3 spec：[`specifications/context-management-v3-redesign.md`](specifications/context-management-v3-redesign.md)
- 物理依据：[`../insights/_draft-prompt-cache-claude-code.md`](../insights/_draft-prompt-cache-claude-code.md) §7（cache 经济 120 倍 + attention 真实边界 32K-128K + 双约束并存）
- 已 DEPRECATED 决策痕迹（不再作为实施依据）：
  - [`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md)
  - [`../innovations/capability-compiler.md`](../innovations/capability-compiler.md)
  - [`../innovations/tool-result-anchor.md`](../innovations/tool-result-anchor.md)

### 状态

| 阶段 | 状态 |
|---|---|
| 物理依据调研（cache 经济 + attention 真实边界 + 多模型对比）| ✓ 完成 |
| v3 spec 闭环（5 关键代码假设全部明示、字段扩展契约、Phase 1 清单含具体调用点）| ✓ 完成 |
| 失效文档 deprecated 标记 | ✓ 完成 |
| Phase 1 实施 | ⏳ 待启动 |

### Phase 1 实施约束

**原子上线**——v3 spec §10 中 1.A 砍除清单与 1.B / 1.C / 1.D 新机制存在功能耦合：只砍不上新会让上下文管理失去能力直接 regression；只上新机制不砍旧会与 v3 invariants 冲突。**1.A–1.D 必须同 release 合并发布**，PR 内部可分批 review。

### 协作模式

v3 spec 是实施权威。实施过程中浮现需要对齐的**具体决策**（如 prompt 措辞实测调优 / 阈值实测 / 边界场景处理 / cli UX 细节）按本工作台原则单独登记——一次只对齐一个问题，对齐完整段清空换下一个。

### 待办

- [ ] 启动 Phase 1 实施（参考 v3 spec §10 1.A–1.E 子任务）
- [ ] 归档 v2 决议过程到 `problems/context-management-redesign.md`（脱过程化版本，可后置）
- [ ] Phase 1 完成后归档 `problems/context-management-v3.md`

---

<!-- 以下为已被取代的 v2 决议过程（2026-05-08）。保留为历史决策痕迹，已不作为当前方向。Phase 1 实施完成后整段移除并归档到 problems/context-management-redesign.md。 -->

## 历史：上下文管理产品方向重设（v2，已被 v3 取代）

> 触发于 2026-05-08：用户实测 dump 日志发现 chat-20260504-41b4 单次 LLM 调用送 481 messages（已恢复对话累积），但因 budget 阈值 85% 远未触发，上下文系统视为"正常"——实质是**注意力被低价值历史稀释**。结合用户使用弱模型（MiniMax-M2.5）且产品同时承载"短对话 + 长 agent 任务"双形态，发现当前上下文管理的设计**默认假设强模型 + 单一对话形态**，与产品定位错位。

### 现象

- 已恢复对话 chat-20260504-41b4 累积 481 messages（240+ 轮 turn × user+assistant），usageRatio 仅 ~10-15% 远低于 compact 阈值 85%
- 481 messages 中大量 `text(2c)` `text(3c)` 短闲聊（"你好" / "OK" / "1"）—— 占 token 但对当前任务零价值
- 弱模型在长上下文下输出"混乱回答"（用户最初触发场景：作长诗时穿插随机文件名 / 项目名 / 网络字符）—— 注意力稀释症候
- dump 日志中即使 messages 仅 1 entry，tools schema 仍占 96% payload（每次 LLM 调用强制满载 10 个工具完整 schema）

### 关键事实

**当前知行的策略**：

- compact 阈值 85% / critical 95%，多数会话期间从不触发
- 自动 compact 走 `LLMSummarizeStrategy`（真 LLM 摘要，7 段必需章节）—— 触发了才有效
- `/compact` 用户主动 LLM 摘要、`/clear` 写 placeholder marker 抛弃历史（已分离）
- 工具结果（tool_result）：现有 `ToolResultTrim` strategy 但触发条件保守
- tools schema 每次 LLM 调用强制满载，无 mode / 关键词过滤
- messages 历史是 append-only 全量发 LLM，无主动管理机制（窗口 / 抽取 / 折叠等）

**三方调研对照**：

| 维度          | Claude Code                                    | OpenClaw                                     | Hermes                                                        | **知行 当前**            |
| ------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| 触发阈值      | 92-93%（窗口 -13K）                            | 50% + 4 路由                                 | 50% + 防颤振（<10% 收益跳过）                                 | 85% / 95%                      |
| 压缩方式      | LLM 摘要 + 文件/技能恢复                       | LLM 摘要 + 工具结果规则裁剪                  | LLM **结构化摘要**（14 字段固定模板）                         | LLM 摘要（仅自动）             |
| 工具结果裁剪  | microcompact（7 工具）                         | head+tail 截断 + 16K 上限 + ≤30% 占比        | **工具专用摘要**（terminal → "cmd, exit 0, 47 lines"）        | 现有 trim 策略保守             |
| Tools schema  | 每次满载 ~44KB YAML                            | **动态过滤**（user/policy/agent 多维）       | 静态满载                                                      | 静态满载                       |
| 短 vs 长      | Task 工具间接区分                              | CLI 100-msg 硬限制                           | 无                                                            | 无                             |

### 根因

当前知行的上下文管理**默认假设是"单一对话形态 + 强模型"**，与产品定位错位：

1. **未识别消息内容驱动的动态适配**：tools schema 静态满载，浪费短对话 96% payload
2. **messages 历史无主动管理**：累积所有 turn 全量发 LLM，弱模型注意力被稀释
3. **阈值按强模型默认**：85%/95% 在大窗口模型几乎永不触发，与"早压缩防胡话"对弱模型的真实需求不匹配

### 影响

- 弱模型注意力稀释 → 输出混乱（用户已实测）
- 短对话每次浪费 ~10K tokens 在不需要的 tools schema 上（成本 + 延迟）
- 长 agent 任务 tool_result 无瘦身，进展几轮就堆出几万字
- 用户对"AI 记得多少"无可控感（要么忍受累积、要么 /clear 全清）
- 与产品定位"个人 AI 助手 + agent 双形态"不匹配，长期陪伴场景下质量越用越差

---

### 协作模式：分阶段渐进对齐

按本文档"一次只一个 Phase"原则推进。当前为 **Phase 1 · 产品方向**。

---

### 已敲定 ✓

**Q1.A · Tools schema 动态适配机制 → Capability Compiler**（2026-05-08 敲定）

第一性原理重新拆解 A1/A2/A3 三方案共享的隐含假设（"工具是预先注册的全集，每次只决定送哪些"），重新审视后另寻路径。

- 四层结构：**Always / Hot / Discoverable / Cold**
- **LLM ↔ 程序双向契约**：自动升级（弱模型友好，cli 静默处理）+ 元工具批量预热（强模型优化）
- 保持窗口 N = **7 轮**（LRU），硬编码不开放配置

完整设计沉淀至独立文档：[`research/innovations/capability-compiler.md`](../innovations/capability-compiler.md)

---

**Q1.B · Tool result 瘦身机制 → Tool Result Anchor**（2026-05-08 敲定）

第一性原理重新拆解 B1/B2/B3 三方案共同盲点（未识别 tool_result 价值衰减的真正轴是**消化状态**，不是 size、不是 age）。

- 两态机制：**Focus**（最近一次 tool_use 的 result，完整 raw）/ **Anchor**（其他历史 result，事实锚替代 raw）
- **事实锚**：程序自动生成的结构化事实占位（如 `[read src/foo.ts, 1235 lines]`），100% 准确，零幻觉风险
- LLM 需要原内容时**重调工具**（v1 不提供 recall 元工具）
- 与 Capability Compiler 共享 MessageCompiler 哲学：cli 在每次 LLM call 前重新组装暴露给 LLM 的内容

完整设计沉淀至独立文档：[`research/innovations/tool-result-anchor.md`](../innovations/tool-result-anchor.md)

---

**Q2 · 对话历史管理机制 → 三层记忆架构**（2026-05-08 敲定）

第一性原理识别业界共有盲点（"messages 历史 = LLM 的记忆"假设错位）：LLM 是 stateless 函数，messages 是喂给它的认知输入流而非内置记忆，真正需求是"让 LLM 看到对当前认知决策最有用的内容"。本方案延续业界主流"分层记忆 + AI 主动维护任务列表"思路（参考 Claude Code TodoWrite 范式），属常规优良设计而非颠覆突破。

- **核心定位**：v2 做三件事——(1) **保留 v1.2 真实生效部分**：数据层（onTurnComplete + 5 压缩策略 + manageWindow + TierCompressor）+ 业务真路径（system-prompt.ts + AgentRoleProfile）；(2) **加视图层**：在 streamLLMCall 之前加 ContextCompiler 处理 v1.2 没设计的事（Q1.A schema 编排 / Q1.B 老 result 锚化 / Active Task List 注入）；(3) **清理 v1.2 死代码**（含与业务路径不兼容/价值不足的设计稿）
- **不按模型能力区分**：所有 Stage 默认全启用；模型能力会变（产品长期跑），任何"区分模型/profile"的设计在场景切换时会成阻碍
- **三层注入**：Working Memory（v1.2 数据层实现，v2 不动）/ Active Task List（system-prompt.ts 新增 segment + SystemPromptStage 注入）/ Persistent Knowledge（system-prompt.ts 新增 segment + SystemPromptStage 检索 memory 注入）
- **task_list 工具单一动作**：`set(items)`，每项含 status: pending / in_progress / completed
- **system prompt 单一权威路径**：业务调 `orchestrator/system-prompt.ts:buildSystemPrompt`；CACHE_BOUNDARY 之前永远 byte-equal 保 cache 命中；CACHE_BOUNDARY 之后由 SystemPromptStage 每轮注入动态段
- **graceful degradation**：单 Stage 抛错跳过 / 全 Stage 失败退化为透明层（messages 原样发，等同 v1.2）；任何情况下最坏退到 v1.2 行为
- **invariant**：磁盘 transcript 永远完整（recall_history 真可恢复）；state.messages 是工作集（v1.2 数据层可压缩，合法）；ContextCompiler 是纯函数不修改输入
- **recall_history 工具从零实现**：v1.2 是幽灵工具（仅在 tier-compressor 截断提示文本中字符串提及，工具不存在；LLM 调用得 unknown tool 错误）→ Phase 0 真实实现，兑现铁律 3"信息可恢复"承诺
- **死代码砍除**：TurnDigest 模块（意图被 task_list 替代）+ **场景化整套**（LayerAssembler / ScenarioEvaluator / ContextProfile）—— LayerAssembler 4 层语义与业务真路径 segment 体系不兼容；ScenarioEvaluator 关键词正则分类对中文+复杂语义不可靠（LLM 已能理解场景，程序硬分类反而阻碍）；ContextProfile 失去 ScenarioEvaluator 驱动后无独立价值。前置：把 `TierThresholds` 类型从 context-profile.ts 搬到 context/types.ts 或 window-manager.ts（v1.2 数据层 manageWindow 仍依赖此类型）
- **用户可见**：cli 实时渲染任务列表 + `/tasklist` / `/task` / `/task new` / `/task done` 命令

完整设计已沉淀至 [`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md)，含三大新设计 + 加视图层 + 死代码清理 + 与 v1.2 真实状态关系（含完整 grep 审计）+ 实施路线（Phase 0-3：清理债务 + 建框架 + recall_history → Q1.B Anchor → Q1.A Capability → Q2 SystemPrompt + Task List + system-prompt.ts 改造）。

---

**Q3 · 滑窗 + 任务纪要生成 → MessageWindowStage**（2026-05-08 敲定）

第一性原理拆解 Q2 现方案盲点（"加段做 attention 锚 ≠ 减噪音"）：弱模型 attention 滤波能力不足时，光加结构化信号盖不过 raw history 噪音，必须在 user/assistant text 那一层做主动选取。Q2 现方案"messages 历史无主动管理"留白由本 Stage 补齐。

- **核心机制**：每次 LLM call 之前，`MessageWindowStage` 把 raw `state.messages` 编排为"滑窗最近 N 轮 + 任务纪要段 + 一次性历史摘要段"
- **滑窗单位与默认窗口**：单位"轮"（user+assistant 配对）；默认 **N=12 轮**；**例外** — 当前 `in_progress` 任务的全部 raw turns 不参与驱逐（沿用 v1.2 manageWindow 的 Pin 概念，语义改为"in_progress 任务驱动"），等任务标 done 后一次性收编为任务纪要
- **任务边界来源**（多源并存）：① LLM 通过 `task_list` 工具标 done ② 用户 `/task done` 命令 ③ 长闲置自动触发（>30 min 无消息）；不引入 LLM 自然语言声明（太软，判断成本高且不稳）
- **闲聊滑窗外消息处理**：drop 出 LLM 视图（不可见）；磁盘 transcript 由 v1.2 持久化层独立管理（**非永久**，受其阈值压缩约束 — LLMSummarize 触发时旧 turns 被 CompactMarker 替代，v2 不改此机制）；`recall_history` 按当前磁盘状态取回；印象层由 Persistent Knowledge（Q2 已敲定）支撑——契合"AI 助手只记印象不记每句话"
- **已恢复对话（v1.2 era）历史前缀**：一次性 LLMSummarize 基于当前磁盘内容生成 1 条摘要纪要，惰性触发（首次需要时跑 + 缓存到 conversation meta），摘要寿命**时限失效** — v2 运行 K 轮（如 K=50）后自动 drop（K 具体值留 spec 阶段）
- **任务纪要容量管理**：硬上限 **N_briefs = 21**，超出**直接丢弃**（不落 conversation meta，不留二级账本）；任务纪要是给 LLM 看的内部工件，**不暴露用户命令**；重要事实由 LLM 主动调 `memory.save` 长期保留兜底（**v2 不做 Persistent Knowledge 自动注入**，LLM 后续需要时主动 `memory.search`；自动相关性检索注入留 v3）
- **graceful degradation**：Stage 失败 → 跳过本 Stage 不影响其他 Stage；messages 原样发；v1.2 数据层兜底独立运行
- **invariant**：磁盘 transcript 由 v1.2 持久化层管理（非永久，受 compact 阈值约束）；Pin（in_progress 任务期间）LLM 视图无信息缺失；ContextCompiler 输入分两类——state.messages + raw tools 只读，辅助状态（taskBriefState / capabilityState / migrationSummaryState）通过 StateDelta 输出由 caller 应用

完整设计已沉淀至 [`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md) v1.0（经架构审查发现 5 个真问题已全部修正：① tool_result 单一 owner — 砍 applyTierCompression + tier-compressor.ts + ToolResultTrim 策略，view-layer Q1.B 唯一处理；② system prompt builder 化提升为 Phase 0 关键改造；③ Persistent Knowledge 自动注入 v2 不做，留 v3；④ Phase 0 transplant SYSTEM_META_PROMPT_SECTION 到 live system-prompt；⑤ invariant 3 措辞精确化区分只读输入 vs 可演化辅助状态）。

---

### 决策状态

- ✓ **Q1.A 已敲定**（Capability Compiler；沉淀至 [`innovations/capability-compiler.md`](../innovations/capability-compiler.md)）
- ✓ **Q1.B 已敲定**（Tool Result Anchor；沉淀至 [`innovations/tool-result-anchor.md`](../innovations/tool-result-anchor.md)）
- ✓ **Q2 已敲定 + 已沉淀**（三层记忆架构 v3；[`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md)）
- ✓ **Q3 已敲定 + 已沉淀**（MessageWindowStage；[`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md) v0.8）
- ✓ **Phase 1 产品方向全部敲定**（Q1.A/B + Q2 + Q3）
- ⏭ 下一步：Phase 2 实施细节（具体阈值数字 / Stage 接口签名 / Phase 路线安排 / 一次性历史摘要 K 值），spec v0.8 §十二 已列未决问题

### 待办

- [ ] Phase 2 实施细节对齐（spec v0.8 §十二 未决问题清单）
- [ ] 进入实施 Phase 0（底层基建审计），按 [`specifications/context-management-v2-redesign.md`](specifications/context-management-v2-redesign.md) §十 路线推进
- [ ] **独立评估项（不绑特定 Phase）**：sub-agent 路径是否启用 ToolResultAnchorStage（Phase 0 现状不接，详见 spec §十二 #8）—— 长子 task 链对上下文控制有真实需求，但需与 byte-equal-across-spawns 缓存优化协调
- [ ] 全部 Phase 完成后归档 `problems/context-management-redesign.md`
