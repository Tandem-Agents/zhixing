# CLI 视觉设计语言对齐 — 问题对齐记录

> 触发于 2026-05-04，由配置编辑器视觉粗糙的反馈引发整体 CLI UI 设计语言对齐。本文件是"对齐过程的脱过程版"——保留问题描述、各阶段对齐结果、设计落地引用，去掉对话原文。最终设计语言以下列文档为权威：
>
> - [cli-ui-design-language.md](../specifications/cli-ui-design-language.md)

## 问题描述

**现象**：[配置编辑器抽离与凭证存储](../specifications/credentials-and-onboarding.md)落地后，配置编辑器（首次配置 + `/config`）的视觉表现被反馈为"粗糙的表单"——按钮、选项、状态在视觉上无明显差异；纯靠 chalk 颜色做层级，表达力不足；顶部分隔线宽度写死 60 字符不跟随终端；整体内容缩在左上角缺容器感。

**直接原因**（按截图对比）：

- `Renderer.separator()` 写死 `"─".repeat(60)`，不跟随终端宽度
- 无 box drawing chrome 容器——所有内容直接流式输出
- 按钮用 `[ 完成 ]` 文本方括号假装而非 box drawing 边框
- 状态文本与选项颜色都用黄色（`chalk.yellow`），视觉上混淆
- 章节平铺、无独立头标识——像 TSV 表格
- Welcome 区无视觉重量——文字行平铺
- Footer 提示像噪声——直接 dim 文字、无全宽分隔

**本质**：缺一套**视觉底盘**——只有颜色（chalk），没有**形状 / 容器 / 层级**。Claude Code、opencode 等参照产品的"高级感"不来自调色板，而来自 box drawing chrome、分组留白、形状化按钮、全宽 chrome 这套结构层。知行结构层缺位。

**关联面**：

- **配置编辑器**：首次配置 + `/config`，整屏 TUI + alt-screen
- **REPL（主对话流）**：日常使用面，目前用 `chalk + console.log` 直接拼，无统一视觉语言
- 两者**渲染范式独立**（一个全屏一个流式，无法合并），但**视觉语言应一致**——共享 design tokens 即可

## 解决方向（一句话）

引入 design tokens + box chrome + status pill + button frame 四件视觉底盘模块，先在 config-editor 落地验证视觉方向，REPL polish 阶段复用同一套 token 保证风格一致。

---

## Phase 1（产品方向：UI 优化的形态与落地节奏）

### 视觉风格定位

候选：照搬 Claude Code 风（圆角外框 + box 化按钮）/ 照搬 opencode 风（左侧 accent bar + 大留白）/ 混合自创。

**对齐结果**：选**混合自创**——以**用户体验为出发点**，由顶级 PM + UI 设计师视角导出知行专属设计语言；不照搬任何参照产品。理由：参照产品视觉对比直接指向 Claude Code 风，但 opencode 的大留白对中文 + 信息密度高的场景屏幕利用率偏低；两者均不完全契合知行调性。

### 落地顺序

候选：先 config-editor / 先 REPL / 并行。

**对齐结果**：选**先 config-editor**——视觉方向小范围验证后落地，再让 REPL polish 阶段复用同一套设计语言。共享底盘 token 在 config-editor 阶段建立，REPL 后续阶段直接复用，不会重复劳动。

### 前置共识

- **不引入鼠标点击交互**：性价比不匹配（OSC 8 + Ctrl+Click 已够；鼠标基础设施留待 REPL 投入回报显现后再评估）
- **共享底盘只在 design token 层**（颜色/图标/box 字符），不强行统一渲染层

---

## Phase 2（产品方向：知行 UI 设计语言）

从用户场景反推设计语言——核心场景与情绪锚点：

| 场景      | 情绪需求 |
| --------- | -------- |
| 首次配置  | 不慌     |
| 日常对话  | 专注     |
| 长会话    | 安心     |
| 错误/中断 | 可控     |

**对齐结果**：七条核心原则（详见 [cli-ui-design-language.md](../specifications/cli-ui-design-language.md) 三节）：

- **P1 · 安静而非热闹**：低饱和、不闪烁、动画克制；少即是多；拒绝 emoji/卡通
- **P2 · chrome 用于边界，留白用于层级**：圆角框只用于容器边界（Welcome/Header/Input），章节、入口、按钮的层级靠留白 + 字符前缀
- **P3 · 状态可识别不依赖颜色**：icon + 文本双通道
- **P4 · CJK 优先且永远对齐**：中文为第一语言，列宽严格按 CJK 全宽 = 2 列
- **P5 · 单一品牌主色（青绿系）**：选中、品牌标识、主操作统一；与 yellow/red/green 拉开层级
- **P6 · 按钮形状化**：box drawing 边框；主按钮绿色，次按钮 dim；选中态反白 + 粗体
- **P7 · 输入区是独立视觉容器**：自适应宽度框；同形态在 REPL prompt 行复用

**关键差异化**：P1（安静）+ P2（chrome 用于边界）+ P5（青绿单主色）—— 这三条决定知行不是 Claude Code 中文换皮、也不是 opencode 极简临摹。

---

## Phase 3（产品方向：落地节奏）

候选：渐进式（建底盘 → 主面板 → 各面板 → 输入区 → 微调）/ big-bang / 其他。

**对齐结果**：选**渐进式 + 验收锚点**。视觉方向有"看实物才知道对不对"的特性——纸面 mockup 与终端实际渲染存在感知差距；渐进推进让助理在每个里程碑停下让用户验收。big-bang 风险与 ROI 不匹配——重构面广，错了改两遍成本远大于多停几次。

实施过程中的细节决策（具体 API 形状、文件路径、box drawing 字符变体、padding 数值等）走代码层判断或 spec 文档，不再回工作台。

---

## 设计落地引用

- [cli-ui-design-language.md](../specifications/cli-ui-design-language.md)：设计语言权威规范（七条原则 + 视觉元素规范 + 适用范围）
- 实施代码：`packages/cli/src/tui/*`（后续提交分阶段落地）
