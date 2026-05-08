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

## 当前问题：上下文管理产品方向重设

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

第一性原理识别业界共有盲点（"messages 历史 = LLM 的记忆"假设错位）：LLM 是 stateless 函数，messages 是喂给它的认知输入流而非内置记忆，真正需求是"让 LLM 看到对当前认知决策最有用的内容"。**本方案延续业界主流"分层记忆 + 滑动窗口 + agent 自维护"思路（参考 ReAct / MemGPT 范式），属常规优良设计而非颠覆突破**。

- **三层结构**：Working Memory（最近 N 轮完整 turn）/ Task Log（LLM 自维护任务进展，新工具）/ Persistent Knowledge（跨会话事实，复用现有 `memory`）
- **用户屏幕 ↔ LLM 视图解耦**：屏幕保留完整 transcript，LLM 看 cli 编排的精简视图（与 Q1.A/B 同哲学）
- **task_log 工具最小动作集**：`update(state)` / `note(content)` / `archive(summary, persistent_facts?)`，content 全部自由文本
- **任务边界识别**：LLM 自主判断 + 用户 `/task new` 显式覆盖（cli 启发式不可靠）
- **与 LLMSummarizeStrategy 协同**：主动 task_log 为常态，被动摘要作兜底（task_log 缺失且接近窗口限制时触发）
- **N = 7 轮**与 Q1.A LRU 同节拍，硬编码不可配；滑出 turn 用 marker 占位（`--- 此前对话已归档 ---`，不引入摘要避免幻觉）
- **用户透明性**：`/tasklog` 命令可查看当前任务日志（v1 只读；v1.1 可能补 `/pin` 编辑）

完整设计待沉淀至 [`specifications/conversation-memory.md`](specifications/)（普通设计区——本方案延续主流范式，不进 [`innovations/`](../innovations/)）。

---

### 决策状态

- ✓ **Q1.A 已敲定**（Capability Compiler；沉淀至 [`innovations/capability-compiler.md`](../innovations/capability-compiler.md)）
- ✓ **Q1.B 已敲定**（Tool Result Anchor；沉淀至 [`innovations/tool-result-anchor.md`](../innovations/tool-result-anchor.md)）
- ✓ **Q2 已敲定**（三层记忆架构；待沉淀至 [`specifications/conversation-memory.md`](specifications/)，普通设计区）
- ⏸ Phase 2+ 在 Phase 1 全部拍板后展开（具体阈值数字 / 实施路线）

### 待办

- [ ] Q2 沉淀至 [`specifications/conversation-memory.md`](specifications/)（普通设计区——延续主流范式，不进 innovations）
- [ ] Phase 1 全部完成后归档 `problems/context-management-redesign.md`
