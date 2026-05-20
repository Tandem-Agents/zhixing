# 上下文管理范式重设（v1.2 → v2 → v3） — 问题对齐记录

> 触发于 2026-05-08 弱模型长上下文实测，演进至 2026-05-11 cache 物理依据发现。本文件是"对齐过程的脱过程版"——保留问题描述、关键决策、范式跨代演进逻辑，去掉对话原文。最终架构以下列文档为权威：
>
> - [context-management-v3-redesign.md](../specifications/context-management-v3-redesign.md) —— v3 设计权威
> - [_draft-prompt-cache-claude-code.md](../../insights/_draft-prompt-cache-claude-code.md) §7 —— v3 物理依据（cache 经济 120 倍 + attention 真实边界 32K-128K）
>
> 已 DEPRECATED 的中间产物（决策痕迹保留、不作为实施依据）：
>
> - [context-management-v2-redesign.md](../specifications/context-management-v2-redesign.md)
> - [capability-compiler.md](../../innovations/capability-compiler.md)
> - [tool-result-anchor.md](../../innovations/tool-result-anchor.md)

## 问题描述

**现象**：用户实测 dump 发现已恢复对话 `chat-20260504-41b4` 累积 481 条 messages（240+ 轮 turn × user+assistant），usageRatio 仅 ~10-15% 远低于 compact 阈值 85% —— 上下文系统视为"正常"，但弱模型（MiniMax-M2.5）在长上下文下输出"混乱回答"（作长诗时穿插随机文件名/项目名/网络字符）。

**直接原因**：v1.2 上下文管理的核心假设是"强模型 + 单一对话形态"——

- compact 阈值 85% / critical 95%，多数会话期间从不触发
- messages append-only 全量发 LLM，无主动管理机制
- tools schema 每次 LLM 调用强制满载（10 个工具完整 schema 占短对话 96% payload）
- tool_result 现有 trim 策略触发条件保守

而产品定位是"个人 AI 助手 + agent 双形态"，同时承载短对话 + 长 agent 任务、用户可能使用弱模型。注意力被低价值历史稀释、长任务 tool_result 堆积、短对话强占 tools schema —— 都不是"超阈值才管"能解决的。

**本质**：上下文管理的范式假设与产品定位错位。需要范式级重设，不是参数调优。

## 解决方向（一句话）

从"超阈值后被动压缩"范式 → 演化为"每次 LLM call 前主动编排 + Anthropic prompt cache 物理边界约束"范式。**完整经历了两次范式跨代**：v2 引入"视图层编排"，v3 在 v2 基础上由 cache 物理依据再次重设。

---

## 三方调研对照（2026-05-08，立 v2 时）

| 维度          | Claude Code                                    | OpenClaw                                     | Hermes                                                        | 知行 v1.2                      |
| ------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| 触发阈值      | 92-93%（窗口 -13K）                            | 50% + 4 路由                                 | 50% + 防颤振（<10% 收益跳过）                                 | 85% / 95%                      |
| 压缩方式      | LLM 摘要 + 文件/技能恢复                       | LLM 摘要 + 工具结果规则裁剪                  | LLM **结构化摘要**（14 字段固定模板）                         | LLM 摘要（仅自动）             |
| 工具结果裁剪  | microcompact（7 工具）                         | head+tail 截断 + 16K 上限 + ≤30% 占比        | **工具专用摘要**（terminal → "cmd, exit 0, 47 lines"）        | 现有 trim 策略保守             |
| Tools schema  | 每次满载 ~44KB YAML                            | **动态过滤**（user/policy/agent 多维）       | 静态满载                                                      | 静态满载                       |
| 短 vs 长      | Task 工具间接区分                              | CLI 100-msg 硬限制                           | 无                                                            | 无                             |

业界没有任何项目同时覆盖"动态 schema + tool_result 价值衰减建模 + 历史窗口主动管理 + 弱模型友好"四件事——这意味着 v2 不能简单照搬，需要原创设计。

---

## Phase 1（v2 设计 · 2026-05-08 敲定）

### Q1.A · Tools schema 动态适配 → Capability Compiler

业界三个候选方案（user/policy/agent 多维过滤 / Mode-based 编译 / 关键词触发）共享一个隐含假设："工具是预先注册的全集，每次只决定送哪些"。重新审视后另寻路径：

- **四层结构**：Always（永久注入）/ Hot（最近 LRU N=7 轮）/ Discoverable（元工具揭示）/ Cold（系统不提，需要时 LLM 调元工具）
- **LLM ↔ 程序双向契约**：自动升级（弱模型友好，cli 静默处理）+ 元工具批量预热（强模型主动优化）
- 窗口 N = 7 轮硬编码，不开放配置

完整设计：[capability-compiler.md](../../innovations/capability-compiler.md)（v2 沉淀，v3 deprecated）。

### Q1.B · Tool result 瘦身 → Tool Result Anchor

候选三方案（按 age / 按 size / 按 turn 距离）共同盲点：未识别 tool_result 价值衰减的真正轴是**消化状态**，不是 size、不是 age。LLM 看完 result 后产出 assistant 回应即"消化完毕"，此后该 raw result 价值急剧下降。

- **两态机制**：Focus（最近一次 tool_use 的 result，完整 raw）/ Anchor（其他历史 result，事实锚替代 raw）
- **事实锚**：程序自动生成的结构化占位（如 `[read src/foo.ts, 1235 lines]`），100% 准确、零幻觉风险
- LLM 需要原内容时**重调工具**（v1 不提供 recall 元工具）

完整设计：[tool-result-anchor.md](../../innovations/tool-result-anchor.md)（v2 沉淀，v3 deprecated）。

### Q2 · 对话历史管理 → 三层记忆架构

业界"messages 历史 = LLM 的记忆"是错位假设：LLM 是 stateless 函数，messages 是喂给它的认知输入流而非内置记忆。真正的需求是"让 LLM 看到对当前认知决策最有用的内容"。

- **核心定位**：v2 做三件事 ——
  1. 保留 v1.2 数据层真路径（onTurnComplete + 5 压缩策略 + manageWindow + TierCompressor + system-prompt.ts + AgentRoleProfile）
  2. 加视图层 ContextCompiler，在 streamLLMCall 之前处理 Q1.A schema 编排 / Q1.B tool_result 锚化 / Active Task List 注入
  3. 清理 v1.2 死代码（含与业务路径不兼容/价值不足的设计稿）
- **不按模型能力区分**：所有 Stage 默认全启用，避免"模型能力切换时设计成阻碍"
- **三层注入**：Working Memory（v1.2 数据层）/ Active Task List（system-prompt.ts segment）/ Persistent Knowledge（v2 不自动注入，LLM 后续主动 `memory.search`）
- **task_list 工具单一动作**：`set(items)`，每项含 status: pending / in_progress / completed
- **invariant 三条**：磁盘 transcript 永远完整 / state.messages 是工作集（数据层可压缩，合法）/ ContextCompiler 是纯函数不修改输入
- **死代码砍除**：TurnDigest 模块（意图被 task_list 替代）+ 场景化整套（LayerAssembler / ScenarioEvaluator / ContextProfile）—— 4 层语义与业务真路径 segment 体系不兼容；正则关键词分类对中文+复杂语义不可靠

### Q3 · 滑窗 + 任务纪要 → MessageWindowStage

Q2 现方案的盲点："加段做 attention 锚 ≠ 减噪音"——弱模型 attention 滤波能力不足时，光加结构化信号盖不过 raw history 噪音，必须在 user/assistant text 那一层做主动选取。

- **核心机制**：每次 LLM call 之前把 raw `state.messages` 编排为"滑窗最近 N 轮 + 任务纪要段 + 一次性历史摘要段"
- **滑窗单位与默认窗口**：单位"轮"（user+assistant 配对）；默认 N=12；**例外** —— 当前 `in_progress` 任务的全部 raw turns 不参与驱逐（沿用 v1.2 manageWindow 的 Pin 概念，语义改为"in_progress 任务驱动"），任务标 done 后一次性收编为纪要
- **任务边界来源**：① LLM 通过 `task_list` 工具标 done ② 用户 `/task done` 命令 ③ 长闲置自动触发（>30 min 无消息）。不引入 LLM 自然语言声明（太软，判断成本高）
- **闲聊滑窗外消息处理**：drop 出 LLM 视图（不可见）；磁盘 transcript 由 v1.2 持久化层独立管理（非永久，受其阈值压缩约束）；`recall_history` 按当前磁盘状态取回
- **任务纪要容量管理**：硬上限 N_briefs = 21，超出直接丢弃（不落 conversation meta、不留二级账本）。重要事实由 LLM 主动调 `memory.save` 长期保留兜底

完整 v2 设计沉淀至 [context-management-v2-redesign.md](../specifications/context-management-v2-redesign.md)（**已 DEPRECATED**）。

---

## Phase 2（v3 重设 · 2026-05-11 触发）

### 触发事件

调研 Anthropic prompt cache 文档时发现两条物理约束：

1. **cache 经济**：cached 输入 token 比未 cached 便宜 ~120 倍。在长会话/agent 任务中，cache 命中率决定成本 + 延迟的数量级差异
2. **prompt cache 元规则①**：前缀任何位置变化让其后内容缓存失效。即 cache 是按 prefix-position 严格匹配的

### v2 与物理边界的冲突

v2 的 **ContextCompiler 视图层范式**与元规则①根本性冲突：

- v2 ContextCompiler 每次 LLM call 前**重新编排** messages（Q1.A 动态裁剪 tools / Q1.B tool_result 锚化 / Q3 滑窗收编）
- 任何编排动作都改变 prefix 内容
- → **cache 永不命中**，每次都按未 cached 价格付费

v2 的初衷是"让 LLM 看到对当前认知决策最有用的内容"——但这个"主动编排"动作本身在 cache 经济下成本不可承受。v2 设计在 attention 维度对了，但在 cache 经济维度错了。

### attention 真实边界的二次澄清

同时 [_draft-prompt-cache-claude-code.md §7](../../insights/_draft-prompt-cache-claude-code.md) 调研显示：

- 现代 LLM 标称窗口 200K+ 但**有效 attention 在 32K-128K 之间**（依模型/任务而异）
- 远低于"靠堆 token 解决"的直觉
- 这是物理上限，不是软指标

### v3 范式重设

**双约束并存**：cache 经济 + attention 真实边界——必须同时满足。

**v3 设计四原则**：

1. **cache 第一优先**：prefix 稳定不动是默认；任何"编排"动作要么不改 prefix，要么明确切段（段切换是 cache miss 但可控、可观测）
2. **优质注意力窗口**：保证送 LLM 的内容在 32K-128K 有效 attention 范围内，且每条内容是高价值的
3. **段式管理**：用户/任务自然边界切段，段内 byte-equal 严格 cache 命中、段间允许 cache miss
4. **tools 满载稳定**：tools schema 不再动态裁剪（v2 Q1.A 思路弃用）——满载但 cache 命中后边际成本接近零；动态裁剪反而破坏 cache、得不偿失

### v2 决策的 v3 处理

| v2 决策 | v3 处置 | 原因 |
|---|---|---|
| Q1.A Capability Compiler（tools 动态编排） | DEPRECATED | 与 cache 经济根本冲突；tools 满载 + cache 命中是最优解 |
| Q1.B Tool Result Anchor（result 锚化） | DEPRECATED | 同上，编排动作破坏 cache prefix |
| Q2 三层记忆（Working / Task List / Persistent） | 部分保留 | task_list 工具 + 用户可见命令保留；自动锚化注入因 cache 冲突弃用 |
| Q3 MessageWindowStage（滑窗 + 任务纪要） | 重塑为段切换 | 滑窗思路转为"段边界主动切"，段内不重组；in_progress 任务驱动的 Pin 语义在 SegmentManager 内复用 |
| TurnDigest 死代码砍除 | 沿用 | 与 cache 范式无关，独立正确决策 |
| recall_history 真实化 | 沿用 | 兑现"信息可恢复"承诺 |

### v3 关键机制（仅承上启下，详见 spec）

- **SegmentManager**：单一段切换决策点 + 段切换事件 emit + Hook interface（三 phase 接入 + 错误分级）
- **estimator calibration**：段切换路径 LLM call 的真实 usage 反馈给 token 估算器，让阈值判断逐步逼近物理真实
- **sub-agent context overflow 检测**：四类软上限统一建模（三成本 + 一质量），复用既有 BudgetExceededKind 机制
- **task_list cli 命令 + UI**：用户可见层保留，是 v2 Q2 留下的唯一向用户暴露的部分

完整 v3 设计：[context-management-v3-redesign.md](../specifications/context-management-v3-redesign.md)。

---

## 设计落地

v3 Phase 1 实施已全部合主线（截至 2026-05-20）：

- Wave 1：A1/A2/A3/A4 v1.2 死代码砍除 + B1/B2/B3/B4 基础设施
- Wave 2：C1 task_list 工具 + state；C2 task_list cli 命令 + UI
- Wave 3：D1 SegmentManager 核心（含 Hook interface + 段切换事件 emit）
- Wave 4：D2 sub-agent risk 检测；D3 段切换路径 estimator calibration

实施权威以 spec 为准，本文不重复实施清单。

---

## 跨代教训

1. **设计假设必须经物理依据校验**：v2 设计在 attention 维度对了，但漏了 cache 经济这一物理约束。调研物理依据（不只是业界做法）应该是设计阶段的强制环节
2. **业界共识不一定正确**：v2 时三方调研对照表显示"动态 schema + tool_result 摘要"是业界部分先进做法，但其中相当一部分（包括知行 v2）在 prompt cache 时代是负优化。新物理约束 → 业界共识可能集体过时
3. **范式跨代时旧设计保留为决策痕迹**：v2 的 capability-compiler / tool-result-anchor / v2-redesign.md 三份文档显式 DEPRECATED 而非删除——保留"为什么不选某个看似合理方案"的演进证据，让未来设计者不重复同一弯路
