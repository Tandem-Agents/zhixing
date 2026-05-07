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

## 当前问题：AI 输出区视觉系统缺失

> 触发于 2026-05-06：紧接[多行粘贴附件化](problems/multiline-paste-attachment.md)落地后，转向项目内**占终端视觉最大的区域**——AI 回复输出区。该区域早期 `chalk` 流式渲染未跟随 [cli-ui-design-language.md](specifications/cli-ui-design-language.md) 七条原则，与已落地的输入区 / 工具卡片 / 子 agent 状态条形成视觉断裂。

### 现象

- AI 输出占整屏视觉约 60%+，但视觉系统是项目里最薄弱的一块
- 用户消息（bg 历史）/ AI 输出（裸文本）/ 工具卡片（⟡）/ 子 agent（⌬）四类内容**视觉等级平铺**，长会话回看缺"谁在说话"的语法
- AI 长文本撞终端列宽硬换行，无 hangingIndent；markdown / 代码块 / thinking 块全裸字符；段间无气息

### 关键事实

- 渲染入口：`packages/cli/src/render.ts` 的 `createRenderer()`——约 80 行 `process.stdout.write` + chalk，无 chrome / 锚 / 缩进 / wrap
- 已落地视觉锚：用户 `❯` cyan + 提交后 `historyEcho` bg / 工具 `  ⟡` cyan / 子 agent `  ⌬` cyan ——**AI 输出唯一缺锚**
- 设计宪法约束（P2）："chrome 只用于容器边界" + "避免 box 套 box 嵌套" → **AI 输出区不能加框**，必须用"字符前缀 + 缩进 + 留白"
- 设计宪法约束（P1）："安静而非热闹" + "拒绝 emoji/卡通" → 拒绝 Claude Desktop 风的角色头像 / 高饱和卡片

### 根因

设计宪法的"输入区视觉容器"已完成（[input-zone-visual.md](specifications/input-zone-visual.md)），但"输出区视觉系统"未对齐——AI 输出渲染从早期裸 chalk 一路保留至今，不在任何 spec 之内。

### 影响

- 视觉断裂：用户区精致 chrome / AI 区裸文本，整体气质拉低
- 信息无层级：长 turn 内 AI 文字 + 工具调用 + thinking 视觉等价，看不出"AI 说话 → 决定调工具"的层次
- 不符合 P1 安静原则：密度过高、段间无气息
- 长 AI 输出宽度失控（撞终端列宽由终端硬换行）

---

### 协作模式：分阶段渐进对齐

按本文档"一次只一个 Phase"原则推进。当前为 **Phase 1 · 产品方向**。

#### Phase 1 · 产品方向（当前阶段）

3 个待对齐问题，每条附助理倾向，等用户回复后综合提炼为"对齐结果"再进 Phase 2。

**Q1 · AI 起首锚字符**

- A：`✦` cyan（已是 `icon.brand`，与 `❯ / ⟡ / ⌬` 形成"四个 cyan 单字符锚"统一语法）
- B：`▎` dim（左竖条 accent，opencode 风，更克制）
- C：无字符锚，仅靠缩进 + 段间空行（最安静，对称性弱）
- **助理倾向：A** —— 与已落地的"用户 ❯ / 工具 ⟡ / 子 agent ⌬"三个锚同构，四种说话人都是"cyan 单字符 + 文本"统一语法，零新视觉负担
- 留给用户：

用a吧，然后需要有状态；普通回复就用白色就行；比如claudecode的这个：● 收到。将 AI 输出区视觉系统对齐进 active-problem.md 工作台。

然后如果是一次操作的话，进行中，是白色闪烁，完成 是绿色，比如claudecode的这个：

● Update(research\design\active-problem.md)
  ⎿  Added 74 lines, removed 2 lines

然后格式这个就可以，用它的就行，操作类型（操作目标文件），然后下一行是结果信息

**助理跟进**：综合你的回答 + Claude Code 样例引用，整理对齐为——

- **锚字符**：用 `●`（中黑圆点）。注意：你的回答字面"用 a 吧"指向 Q1 的 A 选项字符 `✦`，但样例引用的是 `●`；助理判断你真实意图是 `●`，理由：状态色（白/闪/绿）落在 `✦` 上会让品牌主色失焦（`✦` 已是 welcome chrome 的品牌锚），`●` 中性可承载状态色不冲突。如此解读不对请直接修
- **状态映射**：默认（白） / 操作进行中（白闪烁） / 操作完成（绿）
- **行格式**：
  - AI 文字回复：`● <text>`
  - 工具/操作类：`● <Action>(<target>)` + 续行 `  ⎿ <result>`
- **与"四个 cyan 锚"统一论的协调**：原 Phase 1 提案的"四锚同 cyan"已被你的状态化要求打破。助理重新分组：
  - 用户 `❯`：品牌 voice（永远 cyan）
  - AI `●`：状态体（白/闪/绿）
  - 工具 `⟡` / 子 agent `⌬`：品牌动作（仍 cyan）
  - 即"voice / state / action"三类色分工——比"四锚同 cyan"信息量更大，且符合 P3"状态可识别不依赖颜色"的延伸（状态本就该有色）

---

**【再修正：用户拒绝直接 ●，要独立产品风格设计】**

候选评估：

- ✗ `●` 圆点：用户明否（不要 Claude Code 同款）
- ✗ `✦` 六芒星：与已落地的"浮灵 / Drift"品牌锚（顶边 `╲` + body `▌●●▐` 三行）调性差异——星形 vs 几何系列；AI 锚选菱形与品牌锚几何协调更好（注：`style.ts` 中 `icon.brand = "✦"` 是 deprecated 残留常量，知行品牌锚已迁移到浮灵 / Drift，✦ 实际未在任何 chrome 中使用，建议 Phase 3 落地时清理）
- ✗ `★ / ☆` 五角星：卡通感（违反 P1）
- ✗ `■ / □` 方块：机械感
- ✗ `▶ / ▸` 三角：与 cursor `▸` 冲突
- ✗ `◐ / ◑` 半圆：旋转动画过活泼
- ✓ **`◇ / ◆` 菱形配对**（U+25C7 / U+25C6）：独占几何形、终端兼容、空/实心配对状态化清晰

**选定方案 `◇ / ◆` 状态映射**：

| 场景                | 锚     | 颜色                           | 形态机制                     |
| ------------------- | ------ | ------------------------------ | ---------------------------- |
| AI 文字回复（默认） | `◇` | brand cyan                     | 空心 = 在说                  |
| 操作进行中          | `◇` | 白色闪烁（80ms 同 spinner 档） | 形态不变 + 颜色 + 闪烁双通道 |
| 操作完成（成功）    | `◆` | 绿                             | 实心 = 完成                  |
| 操作失败            | `◆` | 红                             | 实心 + 红                    |

**P3 双通道**：形态（空 / 实）独立编码进度；颜色独立编码成败。色弱用户仍能识别"是否完成"。

**单字符锚（角色起首）**：

- 用户 `❯` cyan（箭头 · voice）
- AI `◇/◆` 状态色（菱形 · 状态体）
- 工具 `⟡` cyan（四芒星 · 动作）
- 子 agent `⌬` cyan（六边形 · 动作）
- 章节 `▎` cyan（竖条 · 结构）

**多行品牌锚**（welcome chrome / 初次配置 chrome）：

- 浮灵 Drift —— 顶边 `╲` + body 三行（` ▄▄▄` 天线 / `▌●●▐` 心脏 / `▀▀` 脚），brand cyan bold —— 产品身份签名

每个角色独占独有几何形，单字符锚（角色起首）与多行品牌锚（产品身份）按场景分工，视觉无冲突。

**行格式**（沿用前次对齐）：

- AI 文字回复：`◇ <text>`
- 操作类：进行中 `◇ <Action>(<target>)` → 完成 `◆ <Action>(<target>)\n  ⎿ <result>`

留给你拍：是否认可 `◇/◆` 菱形 + 上述状态映射 + 四角色家族

**Q2 · markdown 渲染深度**

- A：最小集——加粗 / 斜体 / 行内  ` / 代码块（带浅缩进 + dim 左边）
- B：A + 标题（`# / ##`）
- C：A + B + 表格 / 列表 markers
- **助理倾向：A** —— P1 安静原则下，标题 / 表格在 80 列终端拥挤；先做最小集观察反馈再决定是否扩
- 留给用户：

markdown渲染这个事儿有没有标准解决方案，是自己建议处理md格式显示，还是说用标准库处理，还是自己实现复杂md处理模块，claudecode、hermes、openclaw是什么方案，可以先调研再决定；

**助理跟进**：调研已回。

**三家方案对比**：

| 维度       | Claude Code                            | Hermes Agent                                                                     | OpenClaw                                    |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| 渲染方案   | `marked` + `cli-highlight` + chalk | Python `rich.markdown`                                                         | 自研 IR +`markdown-it` + `pi-tui`       |
| 元素覆盖   | 完整 GFM（含 GFM 语法）                | Rich 全套（含表格 / 引用）                                                       | bold/italic/code/code_block/link/blockquote |
| 流式策略   | 边到边增量渲染（Ink/React 重渲染）     | 流阶段 strip 不渲染；turn 末按需重渲染（三档 `render`/`strip`/`raw` 可配） | TUI `setText` 累积整段重排                |
| 代码块高亮 | 是（highlight.js ~190 语言 lazy load） | 是（Rich 内置 Pygments）                                                         | 否（pi-tui 单色 code 块，重结构）           |
| 终端策略   | 多色（蓝/青/绿/灰各司其职）+ chalk     | Rich 主题 + Panel 边框 + 4 空格缩进                                              | 主色青 + OSC 8 终端超链接（最接近知行风）   |

**助理推荐**（综合调研 + 知行设计宪法）：

采"**中度集 + 第三方解析 + 自实现 renderer**"路线——

- **流阶段裸输出，turn 末完整渲染**：关键 P1 安静原则——拒绝"打字机重排闪烁"，等模型停下再渲染单次替换即定格
- **不引 syntax highlighting**：highlight.js 数百语言的色谱与 P5 "单一品牌主色"严重冲突；code 块用 dim 单色文字 + 左侧 `▎` cyan accent 取代边框（避免 P2 "box 套 box"）
- **支持元素最小集**：标题（仅粗体 + 起首留白，不染色避免与品牌 cyan 混）/ 粗体 / 斜体 / inline code（dim 灰底）/ code block（`▎` accent + dim 文字）/ 列表（`-` → `·` 中点，比 `•` 大圆点更克制 / 中文友好）/ 链接（**OSC 8 超链接**——协议级，不靠染色，借鉴 OpenClaw）
- **不支持表格**：80 列 + CJK 等宽渲染不优雅，LLM 输出表格 fallback 为 plain text（marked 解析为 AST 后 renderer 跳过 table 节点输出原文）
- **三档可配**（借鉴 Hermes）：`render`（默认 TTY） / `strip`（CI / pipe 自动降级） / `raw`（调试）

**与 agent 报告的两处微调**：

1. ❌ agent 提"code block 单一 dim 边框" → ✓ 改用左侧 `▎` cyan accent（与章节头 `▎` 同语法，符合 P2 不堆 chrome）
2. ✓ agent 提"`-` → `·`" 同意（中点比 `•` 大圆点克制）

**【修正：用户的反驳让助理重新审视】**

用户问"三家没感觉到这种体验" —— 精准击中助理误判。三家**实际都是边到边渲染、都不闪**，因为都有"区域级最小 diff 重渲染"基础设施（Claude Code 用 Ink/React reconciler 算最小字符 diff；Hermes 用 Rich Live 12.5 FPS 区域 redraw；OpenClaw 类 React TUI）。

**助理原推的"turn 末替换"反而是真闪烁** —— 先看 `**bold**` raw → turn 末突然变 **bold**，单次大切换必闪。

修正：知行渲染入口是命令式 `process.stdout.write`，**无 React/Live 重渲染基础设施**——下面 Q2.1 替换原方向。

**Q2.1（再修正版）· 渲染基础设施**

用户采纳 B（命令式 + 自实现）但担心 bug 频出，强调"md 解析必须稳定可靠"。助理修正实现策略——**解析层与流式输出层分离**，把易出 bug 的解析全交给业界事实标准，自实现只做确定性 diff。

| 层         | 实现                            | 复杂度         | bug 风险                                         |
| ---------- | ------------------------------- | -------------- | ------------------------------------------------ |
| 解析层     | `marked` 严格 CommonMark 解析 | 第三方         | 极低（marked 数百万下载量，所有 edge case 覆盖） |
| 流式输出层 | 自实现 token diff               | 100–200 行 TS | 低（确定性 diff 算法）                           |

**机制**：

- 每 chunk → 累积 buffer → `marked.lexer(buffer)` parse 当前已知文本 → 比较新 token 列表 vs 上一帧
- 新增 + 已闭合的 token → 输出 chalk-formatted 版
- 未闭合（如 `**bold` 没 `**` 收尾）→ 保留 buffer，下一帧 retry

**测试驱动**：流式 chunk 序列 → 期望输出 的黑盒用例，CI 覆盖标题 / 加粗 / 嵌套 / 代码块 / 列表 / 不闭合 inline / 跨 chunk 边界等场景。

**修订后选项**：

- A：引 Ink TUI 框架 + 第三方 `marked`——重写整个 cli 渲染体系（typeahead-input / chrome / config-editor 等全受波及）
- B：命令式 stdout + `marked` 严格解析 + 自实现 token diff 流式输出层（**解析稳定性靠 marked 兜底**）
- **助理倾向：B** —— 保持命令式体系一致；md 解析的边缘 case 不自己写（外包 marked）；自实现只是 token diff，可测可靠；不引 Ink 重构整个 cli
- 留给你拍：

**Q3 · 长 turn 内 AI 文字与工具调用的视觉分组**

- A：扁平——AI 文字 + 工具卡片各自占行同列同进，turn 末摘要 `─` 收束
- B：A + 文字与工具卡片之间留 1 空行（轻分组）
- C：工具卡片缩进比 AI 文字深 2 列，形成视觉嵌套
- **助理倾向：B** —— A 太挤；C 引入"嵌套层"违反 P2 "避免 box 套 box"思路
- 留给用户：

第一个问题是不是回答了；

**助理跟进**：✓ 已被 Q1 答案覆盖。Q1 中"`● <Action>(<target>)` + `  ⎿ <result>`"的操作行格式天然就是"AI 文字 vs 工具调用"的视觉分组语法——用同一锚字符 `●` 起首，用"是否带括号 `()` 操作目标 + 第二行 `⎿` 续行"自然区分两类。Q3 的 A/B/C 选项均不再适用，**Q3 拍板：** 采用 Q1 派生的"操作行格式"，无独立分组规则。

补充信息：

ai回复这里分多个场景都要考虑：正常回复、调用工具+结果、子agent任务、定时和调度任务、打断后ui、各种状态反馈比如“low”什么东西，就是说 流式内容慢的提示，还有重试的提示，这都是ui；

我们可以一个一个来

现在还有个思考中的状态，以以顶级ui设计师、顶级ux设计师、顶级产品经理的身份分析这个如何优化“⠧ 思考中... · esc 中断”

现在消息第一行总是：[llm] 请求 model=Pro/MiniMaxAI/MiniMax-M2.5 msgs=59 tools=read,write,edit,glob,grep,bash,memory,web_fetch,schedule,Task；是否还需要，要的话如何优化，保留哪些信息，去掉哪些信息，ui如何设计

---

### Phase 1 · 对齐结果

经过若干轮迭代（用户两次精准反驳——"turn 末替换会不会闪"、"品牌锚是否 ✦"——纠正了助理的盲点），Phase 1 对齐到以下产品方向：

**1. AI 起首锚（Q1）**

`◇/◆` 菱形配对作单字符锚，状态化映射：

| 场景                | 锚          | 颜色                           |
| ------------------- | ----------- | ------------------------------ |
| AI 文字回复 | `◆` 实心 | 白色（已说完即完成态） |
| 工具/操作进行中 | `◇` 空心 | 白色闪烁（500ms 周期，2Hz） |
| 工具/操作完成（成功） | `◆` 实心 | 绿 |
| 工具/操作失败 | `◆` 实心 | 红 |

**用户 Phase 2 关键修正**：AI 普通文字回复**没有"进行中"状态**——边到边 chunk 输出每段即完成；"进行中"语义**仅工具/操作类专属**。

**P3 双通道**：形态（`◇` 空心 / `◆` 实心）独立编码"是否完成"——空 = 进行中，实 = 完成；颜色（白 / 绿 / 红）独立编码"成败"——白 = 默认，绿 = 成功，红 = 失败。

与已落地角色锚的几何协调：

- **单字符锚家族**（角色起首）：`❯` 用户 / `◇◆` AI / `⟡` 工具 / `⌬` 子 agent / `▎` 章节 —— 各占独有几何形
- **多行品牌锚**（welcome chrome / 初次配置 chrome）：浮灵 Drift（顶边 `╲` + body `▄▄▄` / `▌●●▐` / `▀▀`）—— 产品身份签名

**2. 行格式（Q1 派生 / Q3）**

- AI 文字回复：`◆ <text>`（实心白）
- 工具/操作类：进行中 `◇ <Action>(<target>)`（空心白闪 500ms 周期）→ 完成 `◆ <Action>(<target>)\n  ⎿ <result>`（实心绿/红）
- 视觉分组通过此格式天然实现，无独立分组规则（Q3 closed）

**3. Markdown 渲染（Q2 + Q2.1）**

- **渲染基础设施**：保持命令式 stdout，**不引 Ink 框架**
- **解析层**：`marked` 严格 CommonMark（业界事实标准，所有 edge case 由 marked 兜底，bug 风险极低）
- **流式输出层**：自实现 token diff（每 chunk 累积 buffer + `marked.lexer` parse + diff 出新闭合 token + 输出 chalk-formatted）
- **测试驱动**：流式 chunk 序列 → 期望输出 的黑盒用例 CI 覆盖
- **元素覆盖（最小集）**：
  - 标题（粗体 + 起首留白，不染色）
  - 粗体 / 斜体
  - inline code（dim 灰底）
  - code block（左 `▎` cyan accent + dim 文字，**无 syntax highlight**）
  - 列表（`-` → `·` 中点，比 `•` 更克制 / CJK 友好）
  - 链接（**OSC 8 终端超链接**，不靠染色）
- **不支持表格**（80 列 + CJK 等宽不优雅，fallback 为 plain text）
- **三档可配**（render / strip / raw），CI / pipe 默认 strip

**4. 顺手清理**

- `style.ts` 中 `icon.brand = "✦"` 是 deprecated 残留常量（知行品牌锚已迁移到浮灵 Drift），Phase 3 落地时清理
- `cli-ui-design-language.md` 中"4.5 章节"段写 `◆`，但实际代码用 `▎`（spec 与代码不一致），Phase 3 同步对齐

**5. 范围边界**

本 Phase 仅覆盖"AI 文字回复 + 工具/操作类"两个场景。其他场景（思考中状态、LLM 请求行、子 agent / 定时调度 / 中断 / 流式慢 / 重试）按"一个一个来"原则进后续 Phase。

### 决策状态

- ✓ Phase 1 已对齐
- ✓ Phase 2 已对齐
- ✓ Phase 3 已对齐（A/A/A：渐进 + 落地驱动 spec + 先落地后排序剩余场景）
- ✓ **Step 1 已落地提交**（output/ 子目录骨架 + AI ◆ 锚 + 列 2 + hanging 4 + 列 logger hook 静默 cli 模式 [llm] 噪声）
- ✓ **Phase 4 已全部落地**（4.1–4.5 完成：ScreenController / InputController / writer 协调 / StatusBar 状态机 + 数据填充；详见文末决策状态）
- ✓ **Step 4 工具行已落地**（◆ Action(target) + ⎿ result 双行卡片，由 Phase 4 派生）
- ✓ **Step 5 闪烁动画已落地**（status-bar spinner 500ms tick 单一动画源）
- ✓ **Step 2.A markdown 流式已落地**（marked 接入 + token-range diff + 三档 mode）—— 实际范围见下方"Step 2.A 实际落地范围"
- ▶ **Step 2.B 待启动**（行级流式 + inline 元素：恢复 heading/list/blockquote/hr ANSI 视觉 + paragraph 内 strong/em/codespan/link OSC 8）

### Step 2.A 实际落地范围（与 Phase 2 对齐结果的偏差）

落地中发现：marked 解析时末尾结构 block（heading / list / blockquote / hr）必须等闭合
（\n\n 段落分隔）才能确定 token 类型，期间严格 hold 会导致 LLM 输出长 list / 引用 /
setext heading 时用户**屏幕卡住、token 仍在涨**——严重破坏 streaming 体验。

策略调整为"只对 code block hold + 其他末尾结构字面 forward"。视觉影响：

| Block 类型 | Phase 2 规范 | Step 2.A 实际 |
|---|---|---|
| paragraph | ◆ 锚 + wrap hanging | ✓ 一致 |
| code block | dim 文字 + 列 2 + 起首空行 | ✓ 一致 |
| heading | brand cyan bold + 起首空行 | **字面 `# 标题`**（待 Step 2.B 行级流式恢复） |
| list | `·` 中点 + dim marker | **字面 `- item`**（待 Step 2.B） |
| blockquote | dim 文字 + 列 2 起 | **字面 `> quote`**（待 Step 2.B） |
| hr | dim 横线 | **字面 `---`**（待 Step 2.B） |
| inline 元素（粗体/斜体/inline code/链接） | ANSI + OSC 8 | **字面 `**bold**`**（待 Step 2.B） |

block-renderer 模块保留这 4 类 ANSI 渲染纯函数 + 单元测试作为 Step 2.B 接入预留——
彼时只需调整 markdown-stream 策略（单 item 闭合即 emit），renderer 函数无需重写。

---

## Phase 2 · 视觉细节（当前阶段）

基于 Phase 1 对齐的产品方向，本 Phase 收敛具体视觉数值——缩进 / 留白 / 颜色 / 闪烁频率 / fallback。

### 整体视觉总览（助理提案 mock-up）

```
❯ 帮我看下 src/foo.ts 是干嘛的

  ◆ 这是个工具入口模块，主要负责：

     1. 解析用户输入
     2. 派发到对应的 handler
     3. 返回结果

     关键函数 `parseInput()` 的核心逻辑是 `tokenize` 后 `dispatch`：

  function parseInput(text: string) {
    const tokens = tokenize(text)
    return dispatch(tokens)
  }

     不过有一处可疑——`tokenize` 没处理 null 输入。

  ◇ Read(src/foo.ts)         ← 进行中（◇ 空心白闪 500ms 周期）
    ⎿ 进行中                 ← dim 文字（单一动画源）
  ◆ Read(src/foo.ts)         ← 完成（◆ 实心绿）
    ⎿ 245 lines

  ◆ 看完了。建议在 line 23 加 `if (!text) return []`。

─ 1.4s · 上下文 32%

❯
```

视觉契约示意：

- 用户消息（含 historyEcho bg）：列 0 起
- AI 输出（含 `◆/◇` AI 锚 / `⟡` 工具 / `⌬` 子 agent）：列 2 起，与现有"`  ⟡` 工具 / `  ⌬` 子 agent"缩进一致
- AI text wrap 续行：hanging 4（= 2 列缩进 + 1 锚字符 + 1 空格）
- code block：**列 2 起 + dim 文字 + 前后 1 空行 + 无装饰字符**（Q5 修订——便于复制）
- 工具/操作类：进行中行 `  ◇ Action(target)` 空心白闪（500ms 周期）+ 续行 `    ⎿ 进行中` dim；完成行 `  ◆ Action(target)` 实心绿/红 + `    ⎿ <result>`
- 段间留白：自然段 1 空行，turn 末 `─ Xs · 上下文 N%` 收束（已落地）

### 4 个待对齐问题

**Q4 · 缩进 / wrap 基线**

- A：AI 锚位列 2 起（`  ◇ <text>`），wrap hanging 4（与现有 `  ⟡` 工具 / `  ⌬` 子 agent 缩进契约一致）
- B：AI 锚位列 0 起（`◇ <text>`），与用户 `❯` 同列
- C：AI 锚位列 2 起，wrap 回退列 0（无 hanging 缩进）
- **助理倾向：A** —— "用户列 0 / AI 输出列 2"是已落地契约，AI 锚加入此契约，wrap hanging 4 让长段视觉锚连续
- 留给你拍：

就a吧

**助理跟进**：✓ Q4 拍板 A —— AI 锚位列 2 起 + wrap hanging 4，与现有 `  ⟡` 工具 / `  ⌬` 子 agent 缩进契约一致。


**Q5 · 代码块视觉**

- A：左 `▎` cyan accent + 内容 dim 灰文字（次要信息——AI 是主体，code 是辅助）
- B：左 `▎` dim cyan accent + 内容默认色
- C：左 `▎` brand cyan + 内容默认色
- **助理倾向：A** —— `▎` 与章节头同款（已落地 `style.ts` icon.section），内容 dim 不抢戏符合 P1 安静；用户主要看 AI 解释，code 是辅助信息
- 留给你拍：

这个不是文件修改的代码部分是吧，是直接输出的代码块？那不要左侧的东西，复制很麻烦，重新设计；

**助理跟进**：你的复制 UX 诉求合理，重新设计——

| 元素 | 原方案 | 修订方案 |
| --- | --- | --- |
| 左 accent | `▎` cyan | **去掉** |
| 文字色 | dim 灰 | dim 灰（保留——次要信息） |
| 缩进 | 列 5 起 | **列 2 起**（与 AI 锚同基线） |
| 视觉断裂 | accent 字符 | **前后 1 空行** |

**复制行为**：用户选中代码块 → 复制得纯代码 + 2 空格前导 padding（dim 是 ANSI 不复制；缩进是真字符可手动 trim 或 IDE 自动 trim）。无装饰字符污染。

**重要**：本决策只针对 **AI 文字回复内嵌的代码块**（用户阅读用）。"文件修改的代码部分"（Edit/Write 工具的 diff 显示）是另一形态，留 Phase 后续单独覆盖（属于工具结果渲染场景）。



**Q6 · inline 元素视觉**

| 元素            | 助理提案                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------ |
| inline code     | `bgAnsi256(236)` 灰底 + 默认色文字（与 historyEcho 同 bg 但 inline 有 padding 自然可辨） |
| 加粗            | `chalk.bold` 默认色（不染色）                                                            |
| 斜体            | `chalk.italic`（终端常退化为 dim）                                                       |
| 一级标题 `#`  | brand cyan bold                                                                            |
| 二级标题 `##` | default bold                                                                               |
| 三级及以下      | default 不加粗（80 列终端三级以上罕见，密度不堆）                                          |
| 列表 marker     | `-` → `·` 中点 dim                                                                   |

- **助理倾向：上述方案** —— 与 P5 单一品牌主色对齐（仅一级标题用 brand cyan，其余靠粗细 / 留白）；状态色（绿/红/黄）不混入 markdown 元素
- 留给你拍：

这个是细节，不应该作为对其内容，我们对其的是产品方向，这个相关内容采用行业标准；

**助理跟进**：✓ Q6 拍板——inline 元素视觉细节属于实现层，**采用行业标准**（marked 默认 / chalk 默认 / GFM 通行约定），不在 active-problem.md 产品方向对齐范围。Phase 3 落地时按行业惯例直接实现，遇歧义再回工作台。



**Q7 · 闪烁动画 + OSC 8 fallback**

- **闪烁动画**：单字符 `◇` 颜色 cyan ↔ 白色交替，**80ms 周期**（与 spinner 同档动画，符合 P1"动画克制"）
- **闪烁实现细节**：仅锚字符位置闪（`⎿` 行用 dim 静态文字，不再加 spinner）—— **单一动画源**，避免动画堆叠违反 P1
- **OSC 8 fallback**（终端不支持 OSC 8 时）：`<text> (<url>)` plain 形式，url dim 副位
- **助理倾向：上述方案**
- 留给你拍：

以顶级ui设计师、顶级ux设计师、顶级产品经理的身份设计和决策；

**助理顶级决策**：

**1. 闪烁动画——节奏 / 颜色 / 语感**

- **频率：500ms 周期（2Hz）**——比 spinner 80ms 慢一个数量级。spinner 是"在动"语感（持续旋转），闪烁是"在等"语感（注意但不焦虑）。两个动效频率拉开档次，避免叠用时频率混淆
- **颜色：`chalk.white` ↔ `chalk.dim.white` 亮度震荡**（不切换色相，仅亮 / 暗交替）
  - 比 cyan ↔ white 双色切换更克制——色相切换会"抢戏"，违反 P1 安静
  - 亮度震荡 = "心跳"语义，恰到好处地表达"AI 在等"
- **触发条件**：仅工具/操作进行中（`◇` 空心阶段）；AI 普通文字回复（`◆` 实心白）**不闪**

**2. 单一动画源**

- 锚字符位置闪烁是唯一动画
- `⎿` 续行用 **dim 静态文字**（如"进行中" / "读取中"），**不再加 spinner**
- 避免锚闪烁 + ⎿ spinner 双帧叠加——一个工具调用同屏只有一个动画源，符合 P1"动画克制"

**3. OSC 8 终端超链接——fallback 策略**

- **永远输出 OSC 8 escape sequence**，不做主动检测 / fallback
- 理由：
  - 不支持 OSC 8 的终端**会自动忽略 escape sequence 显示纯文本**（OS / 终端级 fallback），cli 层无需检测
  - 主流终端（iTerm2 / Windows Terminal / Alacritty / kitty / WSL / VS Code Terminal / GNOME Terminal）都支持，覆盖率 95%+
  - 主动检测 OSC 8 无可靠协议（终端不主动 reply），over-engineer
- **降级路径**（如未来用户反馈）：通过 Phase 1 已对齐的"三档可配"中的 `strip` 档处理——`strip` 模式输出 `<text> (<url>)` plain 形式，url dim 副位

**4. spinner 复用建议**（衍生）

知行已落地的 spinner（`⠋ 思考中... · esc 中断`）属于"等 LLM 首 token"场景，与本 Q7 的"工具进行中"场景**不同**：

| 场景 | 视觉 | 频率 | 触发 |
| --- | --- | --- | --- |
| 等 LLM 首 token | spinner 帧 + 文字（`⠋ 思考中... · esc 中断`） | 80ms | turn 启动 → 首个 chunk 到达 |
| 工具进行中 | `◇` 锚字符闪烁 + ⎿ dim 文字 | 500ms 周期 | tool_start → tool_end |

两个场景视觉等级 + 频率拉开 —— 用户清楚区分"模型在思考" vs "工具在跑"。Phase 1 待办里"思考中状态优化"未来在新 Phase 单独处理，与 Q7 决策不冲突。

---

### Phase 2 · 对齐结果

经过用户对状态映射的精准修正（AI 普通回复无"进行中"态、闪烁仅工具类）+ 代码块复制 UX 反驳 + Q6 / Q7 顶级决策授权，Phase 2 收敛到以下视觉规范：

**1. 状态映射（Q1 修订版）**

| 场景 | 锚 | 颜色 |
| --- | --- | --- |
| AI 文字回复 | `◆` 实心 | 白色 |
| 工具/操作进行中 | `◇` 空心 | 白色亮暗震荡（500ms 周期，2Hz） |
| 工具/操作完成（成功） | `◆` 实心 | 绿 |
| 工具/操作失败 | `◆` 实心 | 红 |

形态（空 / 实）独立编码"是否完成"；颜色（白 / 绿 / 红）独立编码"成败"。AI 普通回复**无"进行中"态**——边到边输出每段即完成。

**2. 缩进 / wrap 基线（Q4）**

- 用户消息：列 0 起
- AI 输出（含 `◆/◇` AI 锚 / `⟡` 工具 / `⌬` 子 agent）：列 2 起
- AI text wrap 续行：hanging 4（= 2 列缩进 + 1 锚字符 + 1 空格）
- 工具/操作类续行 `⎿`：列 4 起（与 hanging 同基线）

**3. 代码块视觉（Q5）**

针对 **AI 文字回复内嵌的代码块**：
- 列 2 起 + dim 灰文字 + 前后 1 空行
- **无左侧装饰字符**（避免污染复制）
- 复制时用户得纯代码 + 2 空格前导 padding（IDE 自动 trim）

文件修改的代码部分（Edit/Write 工具的 diff）属于工具结果渲染，不在本 Phase 覆盖。

**4. inline 元素视觉（Q6）**

属于实现层，**采用行业标准**（marked / chalk / GFM 通行约定），不在产品方向对齐范围。Phase 3 落地时按行业惯例直接实现。

**5. 闪烁动画 / 单一动画源 / OSC 8（Q7）**

- **闪烁**：仅工具进行中，`◇` 锚字符位置 `chalk.white` ↔ `chalk.dim.white` 亮度震荡，500ms 周期（2Hz）
- **单一动画源**：⎿ 续行用 dim 静态文字（"进行中"），不再加 spinner——避免双动画叠加违反 P1
- **OSC 8 链接**：永远输出 escape sequence，不做主动 fallback；不支持终端自动忽略 escape 显示纯文本（OS 级 fallback）；如未来用户反馈，通过 Phase 1 已对齐的"三档可配"中的 `strip` 档降级处理
- **与 spinner 区隔**：等 LLM 首 token 用 80ms spinner（"在动"语感）；工具进行中用 500ms 闪烁（"在等"语感）——频率拉开数量级，用户视觉清楚区分两类等待

**Phase 2 范围边界**

本 Phase 仅收敛"AI 文字回复 + 工具/操作类"两个场景的视觉规范。未覆盖（按"一个一个来"原则，Phase 3 后各开新 Phase）：
- 工具结果渲染（Edit/Write diff / Read 文件内容呈现）
- 子 agent 任务（`⌬ [Task#N: desc]` 状态条与 `◆/◇` 语法对齐）
- 定时调度任务通知
- 中断后 UI / 流式慢提示 / 重试提示
- 思考中状态（spinner + esc 中断行）
- LLM 请求行（`[llm] 请求 model=... msgs=N tools=...`）

---

## Phase 3 · 落地节奏（当前阶段）

Phase 1 + Phase 2 已对齐到完整产品方向 + 视觉规范，本 Phase 收敛**怎么落地**——3 个待对齐问题。

**Q8 · 落地路径**

- A：**渐进式 + 验收锚点**——分小步落地，每步独立可提交可验收
  - Step 1：AI 锚字符 `◆/◇` + 列 2 缩进 + wrap hanging 4（视觉骨架）
  - Step 2：markdown 流式渲染（marked + token diff 输出层 + 最小元素集）
  - Step 3：代码块视觉（列 2 dim + 前后空行 + 无装饰）
  - Step 4：工具调用 `◆/◇ Action(target)` + `⎿ result` 行格式
  - Step 5：闪烁动画（500ms 亮暗震荡）+ 单一动画源
  - 每步用户验收实物再进下一步
- B：big-bang——一次重构 `render.ts`，所有视觉规范一起上
- C：双轨——保留现 `createRenderer`，新建 `createRendererV2` 渐进迁移
- **助理倾向：A** —— 与 [cli-ui-visual-foundation](problems/cli-ui-visual-foundation.md) 的"渐进式 + 验收锚点"一致；视觉方向有"看实物才知对不对"特性，big-bang 错了改两遍成本远大于多停几次；双轨引入维护两套渲染负担
- 留给你拍：

**Q9 · spec 起草节奏**

- A：**落地驱动 spec**——按 Phase 1 + 2 对齐结果分步实施，每 Step 落地 + 验收后回写 spec `output-zone-visual.md`，最终归档 `problems/output-zone-visual.md`
- B：spec 驱动落地——先完整起草 spec，再实施
- C：同步推进——spec 与落地并行迭代
- **助理倾向：A** —— 视觉规范的细枝末节（具体 chalk 调用 / dim 灰度 / 闪烁定时器实现等）需要看实物定，**spec 在落地后写更准确**；先按对齐结果实施一段 → 验收 → 沉淀 spec → 持续校准
- 留给你拍：

**Q10 · 未覆盖场景的优先级排序**

Phase 1 + 2 已覆盖"AI 文字回复 + 工具/操作类"两个场景。剩余场景 8 个，按价值 / 紧迫度排序选项：

- A：**先落地 Phase 1+2 已对齐的两个场景，验收后用户拍**剩余 8 个场景的优先级
- B：助理排序——AI 文字 / 工具调用 → 工具结果（Edit/Write diff）→ 子 agent → 思考中 → LLM 请求行 → 中断 / 流式慢 / 重试 / 调度
- C：用户现在直接拍优先顺序
- **助理倾向：A** —— Phase 1+2 落地后用户能看到"知行新 AI 输出区"实物，对剩余场景的判断更精准；现在凭空排序容易判断失真
- 留给你拍：

### 待办

**Phase 推进**：

- [X] ~~Q3 拍板~~（被 Q1 派生的"操作行格式"覆盖）
- [ ] Q1 助理跟进解读对齐（锚字符 `●` 而非 `✦` / 三类色分组 voice/state/action）
- [ ] Q2 markdown 调研结果回收 → 拍板渲染深度
- [ ] Phase 1 全部拍板 → 综合提炼"对齐结果"
- [ ] Phase 2 视觉细节
- [ ] Phase 3 落地节奏

**多场景待覆盖**（按用户"一个一个来"原则，Phase 1 拍板后逐个进新 Phase；当前阶段只列不展开）：

- [ ] 正常 AI 文字回复（Phase 1 收敛中）
- [ ] 调用工具 + 结果（Phase 1 已派生 `● Action()` + `⎿ result` 格式，待 Phase 2 细化）
- [ ] 子 agent 任务（已落地 `⌬ [Task#N: desc]` 状态条，待 Phase 2 检视是否需对齐 `●` 语法）
- [ ] 定时和调度任务（已落地 `✓ 任务完成` / `✗ 任务失败` / `⊘ 任务已停用`，待对齐）
- [ ] 中断后 UI（已落地 `[interrupted]` dim，待对齐）
- [ ] 流式慢提示（已落地 `⚠ stream slow, will auto-cancel in Ns...`，待对齐）
- [ ] 重试提示（已落地 `⚠ 速率限制 (429)，第 N/M 次重试，等待 Xs...`，待对齐）
- [ ] **思考中状态** `⠧ 思考中... · esc 中断`：当前用 Braille spinner + dim 文字，待优化
- [ ] **LLM 请求行** `[llm] 请求 model=... msgs=N tools=...`：是否要、如何精简、UI 形态

**沉淀路径**：

- [ ] 成熟后建 spec `output-zone-visual.md`
- [ ] 归档 `problems/output-zone-visual.md`

---

## Phase 4 · 持久输入区 + 状态条（当前阶段）

Step 1 落地后用户提出范式问题：AI 思考/回复期间输入区消失（per-turn lifecycle 模型局限），且需新增类 Claude Code 的状态条（思考/回复/工具/完成等动态状态）。本 Phase 升级会话循环范式，从 per-turn 阻塞 readInputLine 改为 session-level 持久 InputController + 三区屏幕模型。

### 问题诊断

- 输入区"消失"不是渲染 bug——是 per-turn input lifecycle 范式问题。`repl.ts` 主循环 `await readInputLine()` 每轮独立创建 / 卸载输入区，AI turn 期间用户无视觉锚
- 状态条贴在输入区上方，依赖输入区先有持久位置；两者一体规划
- 不解决输入区持久化，原 Step 2-5（markdown / 代码块 / 工具行 / 闪烁）所有的 stdout 直写实现都将在范式升级时回炉——**架构债务**

### 范式升级

`per-turn input lifecycle` → `session-level interaction controller`。

三区布局：

```
┌──────────────────────────────────────┐
│  Scroll Region（向上累积，保留 scrollback）│
│  ❯ <用户消息 history bg>              │
│    ◆ <AI 文字>                       │
│    ◇ <Tool(args)> ⎿ <result>         │
├──────────────────────────────────────┤
│  Status Bar（动态，仅活跃 turn 显示）  │
│  ✽ 思考中 (3m 45s · ↓ 14.3k · 深度思考) │
│    ⎿ 提示: /btw 旁路提问不打断当前任务 │
├──────────────────────────────────────┤
│  Input Pane（持久 chrome）            │
│  ───────────────────────────────     │
│  ❯ <buffer>                          │
│  ───────────────────────────────     │
└──────────────────────────────────────┘
```

光标永远在输入区；输出永远向上累积；状态条仅 turn 活跃期间显示。

### Q11 · 持久输入区实现路径（已对齐 A）

- A：**ANSI 区域控制 + 重画机制**——保持命令式 stdout 体系一致，新建 ScreenController 协调三区
- B：alt-screen 全屏分屏（**致命缺陷**：失去 scrollback；与"长会话陪伴 personal AI"定位根本冲突）
- C：Ink TUI 框架重写（重写整个 cli 渲染体系换一个特性，ROI 不匹配；Ink CJK 短板与 P4 冲突）
- **拍板：A** —— 与现 chrome / typeahead-input / paste 系列同栈；scrollback 自然保留；CJK 用现 line-width.ts 成熟方案；演进空间保留（未来需要可上 C 兜底）

### Q12 · 输入功能层语义（后置）

视觉持久化（Q11 A）落地后再决定：是预输入 staged（Claude Code 风）/ 仅 idle 活跃 / 自动 submit 排队。等真实视觉效果出来后能更准确判断 UX。

**Step 4.2 暂行规则**：busy 时输入区 chrome 可见但禁键（按键被丢弃）。Phase 4 完成后单独对齐 Q12 拍板正式规则。

### Q13 · 与原 Step 2-5 次序（已对齐 A）

- A：**先 Phase 4，再回原 Step 2-5**——架构正向，Step 2-5 直接基于 ScreenController 写入契约，无返工
- 原 Step 2-5（markdown 流式 / 代码块 / 工具行 / 闪烁）推迟到 Phase 4 完成后

### 协议清单（5 项硬约束）

Phase 4 范式升级要求若干跨模块协议——必须在 ScreenController 模块文档里明确约束，避免实施期间散落处理形成债务。

**1. keypress handler 所有权协议**

- raw-mode lease 模型（`tui/_internal/raw-mode.ts`）现有引用计数已支持多并发 lease + 长生命周期，**不需改造**：InputController 持 1 个 lease，select-with-input 启动时 `acquire()` 第二个 lease（refcount + 1，stdin 保持 raw），关闭时 `release()`（refcount - 1，仍 ≥ 1 → stdin 仍 raw）
- 真正要协调的是 **keypress handler 所有权**：多消费者同时监听 stdin 会冲突。沿用现有 `tui/_internal/stdin-ownership.ts` 的 `acquireStdinOwnership` 机制（typeahead-input 已用）
- InputController 暴露 `suspend()` / `resume()`：select-with-input / config-editor / 其他独占 keypress 的面板启动前调 `input.suspend()`（释放 stdin-ownership、擦输入区 chrome），结束后调 `input.resume()`（重 acquire、重画）

**2. typeahead panel 归属**

- typeahead panel（`/` 命令、`@file` 补全等）作为 InputController **内部视觉组件**，与 prompt 行 + chrome 边框一起视为"输入区单元"由 ScreenController 管理
- panel 显隐时输入区单元高度变化，screen 重画位置
- 现 typeahead-renderer.ts 渲染逻辑保留，仅写入位置由 InputController 协调（不再流式 append）

**3. stdout / stderr 写入契约**

所有写到屏幕的逻辑必须经 ScreenController 协调，绝无直写 stdout / stderr：

| 写入源 | Phase 4 处理 |
|---|---|
| output-renderer（AI 文字 / 工具行 / 闪烁） | `screen.withScrollWrite` |
| createRenderSubscribers 内 retry / compact / budget 渲染 | `screen.withScrollWrite` |
| repl 内 scheduler 任务通知（`✓ 任务完成` 等） | `screen.withScrollWrite` |
| setupInterruptRendering 写 stderr（`⚠ stream slow ...` 倒计时） | screen 监听 stderr 路径 + 重画输入区 |
| logDiagnostic 默认 sink（cli 模式已 noop / serve 模式 console.log） | **不改**——保持 Step 1 已落地决策（cli REPL 静默；serve 模式 console.log 走非屏幕区，无需 screen 协调） |

立硬约束：**任何模块直写 stdout / stderr 视为 bug**。新写入入口必须接入 screen。

**4. sub-agent-status 整合进 StatusBar**

- 现 `setupSubAgentStatus`（`\r` 单行刷新主 Task 工具调用进度）与 StatusBar 的 `tool_running` 状态职责重叠——同屏两个动态条不合理
- StatusBar 状态机扩展支持嵌套显示：

```
✽ 子任务 #2 (3m 45s · ↓ 14.3k)
  ⎿ 调用 Read src/foo.ts
```

外层是 Task 主调用计时 + token，内层是当前子工具——单一状态条承载嵌套
- **`setupSubAgentStatus` 模块整体废弃**，逻辑迁入 StatusBar；`tool-render-strategy` 表保留（仍区分 default vs sub-agent-status，但接管者改为 StatusBar）

**5. ScreenController 写入 serialize**

- 多写入源异步触发（output / scheduler / interrupt warn / status-bar update / ...）若并发写 stdout，ANSI 序列穿插会破坏屏幕状态
- ScreenController 内部 **FIFO 队列 + 同步 flush**，所有 `withScrollWrite` / `setStatusBar` / `paintInputRegion` 串行执行，绝不交错

### 模块拆分

```
packages/cli/src/
├── screen/                      ◀── 新模块：屏幕协调层
│   ├── screen-controller.ts    三区位置管理 + 写入 serialize（FIFO）+ stderr 监听
│   ├── region-painter.ts       ANSI 区域擦除 / 绘制 / 光标 save/restore 原语
│   └── __tests__/
├── status-bar/                  ◀── 新模块：状态条（吸收原 sub-agent-status 职责）
│   ├── status-bar.ts           主入口 + 状态机 + 计时 + token 累计 + EventBus 订阅
│   ├── verbs.ts                中文状态词库
│   └── __tests__/
├── output/                      ◀── 已有：改造写入路径
│   └── output-renderer.ts      stdout.write 改走 screen.withScrollWrite
├── tui/_internal/raw-mode.ts    ◀── 不改：现引用计数模型已支持多并发 lease
├── tui/_internal/stdin-ownership.ts ◀── 不改：keypress handler 所有权机制已就绪
├── typeahead-input.ts           ◀── 改造：Promise → InputController 长生命周期 + suspend/resume（基于现有 stdin-ownership）
├── render.ts                    ◀── 改造：retry / compact / interrupt 渲染走 screen.withScrollWrite
├── sub-agent-status.ts          ◀── 删除：职责整合进 status-bar
└── repl.ts                      ◀── 改造：主循环事件驱动（onSubmit 回调）+ scheduler 通知走 screen
```

status-bar/ 文件粒度从 5 减为 2——状态机 / 计时 / token 累加都是简单逻辑（< 100 行）合并到主入口；verbs 文案常量独立。

### 状态条文案（知行调性化）

| 阶段 | 主行 | 括号 dim |
|---|---|---|
| 等首 token | `✽ 思考中` | `(3m 45s)` |
| 流式输出 | `✽ 回复中` | `(3m 45s · ↓ 14.3k)` |
| 工具进行中 | `✽ 调用 Read` | `(3m 45s · ↑ 1.2k · 等待结果)` |
| 压缩中 | `✽ 整理上下文` | `(3m 45s · 50%)` |
| 重试中 | `✽ 重试中` | `(3m 45s · 第 2/3 次)` |
| 完成 | `✻ 完成于 7m 9s` | `(↑ 1.2k · ↓ 14.3k)` |

`✽` 旋转动画 80ms（与 spinner 同档）；`✻` 静态完成态；中文动词；括号 dim 严格 `时间 · ↑↓token · 状态文字`，缺项省略。可选 tip 行 `⎿ 提示: ...` 按需出现。

### Phase 4 子 Step 切分

| Step | 范围 | 协议落实 | 验收 |
|---|---|---|---|
| 4.1 | ScreenController + region-painter 骨架（ANSI 区域擦除 / 光标 save / restore + FIFO 串行 + stderr 监听） | 协议 5（serialize） | 单元测试覆盖区域定位 / 重画 / 异步并发 serialize |
| 4.2 | InputController 改造（Promise → 长生命周期 + 基于现有 stdin-ownership 的 suspend / resume）；repl 主循环事件驱动；select-with-input / config-editor / typeahead panel 归属切换 | 协议 1（keypress 所有权）+ 协议 2（panel 归属） | AI 输出期间输入区 chrome 持续可见；busy 时禁键；select / config-editor 启动 / 退出无残影 |
| 4.3 | 全 stdout / stderr 写入路径迁入 screen 协调（output-renderer / render.ts retry-compact-interrupt / scheduler 通知 / logDiagnostic cli sink） | 协议 3（写入契约） | 任何写入路径不破坏输入区 chrome；grep `process\.stdout\.write\|process\.stderr\.write` 仅在 screen 模块内 |
| 4.4 | StatusBar 状态机 + EventBus 订阅 + 渲染骨架 + 嵌套显示（吸收 sub-agent-status）；删除 sub-agent-status.ts | 协议 4（sub-agent 整合） | thinking / streaming / tool / done / nested-task 各阶段状态条切换；setupSubAgentStatus 调用点全部清理 |
| 4.5 | StatusBar 数据填充（计时 / token 累计 / 中文 verbs） | — | `3m 45s · ↓ 14.3k` 真数据；turn 末显示 `✻ 完成于 7m 9s` |

每 Step typecheck + 单元测试 + 手测验收。Step 4.3 是最关键的硬约束落地点——之后所有新写入路径都受协议 3 拘束。

### 决策状态

- ✓ Q11 已对齐 A（ANSI 区域控制）
- ✓ Q13 已对齐 A（先 Phase 4 再回 Step 2-5）
- ⏳ Q12 后置（Phase 4 视觉持久化落地后再拍）
- ✓ 4.1–4.5 全部已落地提交（ScreenController / InputController / writer 协调 / StatusBar 状态机 + 数据填充；后续 Step 4 工具行 + Step 5 闪烁动画也已派生落地）
