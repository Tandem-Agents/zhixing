# 屏幕渲染架构 — Chrome 永驻 + Scrollback 历史的 DECSTBM 实现

> 触发于 2026-05-09：LLM 流式输出长 list 期间，屏幕物理顶行（启动 welcome 块的顶边框）被反复推到 scrollback 累积 250+ 副本。本质问题是：当前 `ScreenController` 用"tailBuffer 全帧重画"实现 chrome 永驻，这套机制建立在**逻辑行号模型**上，与终端的**物理 wrap 行为**根本错位——单维行号模型与终端二维（行+列+wrap 规则）模型不匹配；物理 wrap 让 frame 物理高度 > viewport 时，paintFrame 主体的 `\n` 在 viewport 底部触发硬件滚动，每次 paint 都把 viewport 顶行推到 scrollback。

## 问题描述

**现象**：
1. LLM 流式输出包含长 list（list item 内容含 ASCII + CJK 拼接，单行宽度超过终端列宽）期间，屏幕物理顶行的内容被反复 push 到 scrollback，单一内容累积数百副本
2. 不限于 welcome 块——任何位于屏幕物理顶行的内容都会被推走（用户原话："任何在屏幕上边界位置的内容都会重复"）
3. 偶现，需满足"frame 逻辑行 ≤ maxRows 但物理行 > viewport"的临界条件

**直接原因**：[`screen-controller.ts:freezeOverflowToScrollback`](../../../packages/cli/src/screen/screen-controller.ts) 算 `tailBuffer.length`（数组长度，逻辑行数），不算每行物理 wrap 占的屏幕行：
```ts
const totalRows = this.tailBuffer.length + this.statusLines.length + inputLines;
const maxRows = this.getMaxFrameRows();
if (totalRows <= maxRows) return "";  // 逻辑行数 ≤ maxRows 时不 freeze
```
frame 逻辑行 ≤ maxRows 时不触发 freeze，但**物理行可能 > viewport**。`paintFrame` 主体写 `\n × (totalRows-1)`，cursor 走到 viewport 底部后剩余的 `\n` 在硬件层触发滚动 → 屏幕物理顶行进 scrollback。

**本质**：当前 `ScreenController` 用**单维行号模型**（`cursorRow` / `renderedRows` / `tailBuffer.length` / `segmentStartRow` / `segmentFrozenLineCount`）维护屏幕状态，但终端是**字符设备 + wrap 规则**——任何"逻辑 = 物理"的假设在物理 wrap 触发时必然失效。

设计意图与实现的明文错位（[`screen-controller.ts:27`](../../../packages/cli/src/screen/screen-controller.ts) 注释）：
> "保证 paintFrame 的 cursor up 永远在 viewport 内，**不触发滚动**"

承诺是物理高度约束，实现是逻辑行数约束。承诺无法兑现。

物理 wrap 在三种内容下高频出现：
- **list item 内容**：[`block-renderer.ts`](../../../packages/cli/src/output/markdown/block-renderer.ts) 不做行宽截断
- **长 URL / 长 ASCII token**：单 token 无空格，wrap 算法插不进硬换行
- **中英文混排接近终端宽度**：`stringWidth` 估算与终端实际 wrap 边界差 1-2 列即触发

---

## 现状架构（被替换的）

[`screen-controller.ts:4-13`](../../../packages/cli/src/screen/screen-controller.ts) 注释定义的三层模型：

```
┌──────────────────────────────────┐
│  Scrollback（已固化，不可重画）  │
├──────────────────────────────────┤  ← frame 起点（cursor up 上限）
│  Tail Buffer（每次 paint 重画）  │
│  ─ welcome / 用户消息 / 历史    │
│  ─ active segment 流式内容     │
│  ─ 已闭合段（line / commit）    │
├──────────────────────────────────┤
│  Status Bar (0..N 行)           │
├──────────────────────────────────┤
│  Input Region (含 panel)        │
└──────────────────────────────────┘
```

**全帧重画**：每次更新 = `cursor up cursorRow → \r → 逐行 \x1b[2K + 新内容 → \n`，单次 `stdout.write` 给 TTY。chrome 永驻靠"画在 tailBuffer 之后"。

**核心设计哲学**（[`screen-controller.ts:20-22`](../../../packages/cli/src/screen/screen-controller.ts) 明文记录）：
> "旧设计 exclusive 擦 chrome 让 chunk 直写——chrome 在流式期间消失（用户期望 chrome 永驻）。新设计让 chunk 在 tailBuffer 末尾行内累积，chrome 每次 paint 重画在 tailBuffer 之后——视觉上 chrome 始终跟随 scroll 末尾，永驻。"

chrome 永驻是不可放弃的 UX 承诺。tailBuffer 重画是为了实现这个承诺而引入的间接层。

**被替换的根因**：

| # | 根因 | 表现 |
|---|---|---|
| 1 | tailBuffer 全帧重画 | 已确定段（welcome / 历史 / 闭合段）每次都参与重画，性能浪费 + 滚动失控放大面 |
| 2 | cursor up cursorRow 假设逻辑行 = 物理行 | 物理 wrap 时光标错位，无法回到真正的 frame 起点 |
| 3 | paintFrame 主体的 `\n` 假设不触发滚动 | 物理 wrap 让 frame 物理 > viewport 时必然触发 |
| 4 | freeze 算逻辑行不算物理行 | 设计意图（frame 物理 ≤ viewport）兑现不了 |

四个根因同源——**单维行号模型与终端物理模型错位**。任何在此模型基础上的修补（freeze 算物理行、增大 safety margin、隔离已确定段）都是概率性兜底，不是消除。

新架构通过两个机制根除该错位：
1. **DECSTBM 区域隔离**：chrome 永驻不再依赖软件层全帧重画，由终端原生分区保证
2. **显式 viewport 行追踪 + 行宽硬合约**：segment 显式追踪 `segmentTopRow / segmentBottomRow`、滚动数 = `\n` 计数（精确）；caller 端 `wrapAnsiLine` 软折让逻辑行 = 物理行，估算彻底退出关键路径

---

## 同类项目与参考机制

| 模式 | 实现 | 是否适合 zhixing |
|---|---|---|
| Ink / React-TUI（Claude Code）| 声明式 React + 整屏管理 | 另一个架构方向；与本方案命令式 ANSI 协议正交 |
| alt screen buffer（vim / less / htop / tmux）| 整屏接管，scrollback 不可见 | ✗ 与产品定位冲突（chrome 永驻 + 长对话 scrollback 历史） |
| 直接 print（Aider）| 无 chrome 永驻 | ✗ 失去当前 UX |
| **DECSTBM scroll region**（xterm 原生）| 终端原生分区，区域内自滚 + 区域外不动 | ✓ 与混合模式天然契合 |

**关键洞察**：zhixing 选择"chrome 永驻 + scrollback 历史保留"混合模式，在传统 cli 工具中没有现成的"教科书"实现。当前 tailBuffer 重画是软件层模拟，DECSTBM 是终端原生分区——后者在物理上就是为这种混合模式设计的。

参考 spec：
- `xterm` / `xterm.js` 控制序列规范（DECSTBM 行为定义、cursor positioning 语义）
- `tmux` `status-bar` 永驻实现（alt screen + 自管 scrollback；zhixing 不取这条路）

---

## 解决方向（一句话）

用终端原生的 **DECSTBM** (`\x1b[<top>;<bottom>r`) 设定滚动区域：chrome 永驻靠终端原生（区域外不参与 region 滚动）；流式内容写入直接进 scroll region（区域内 `\n` 自然滚动到 scrollback）；已确定段直接进 scrollback；不再依赖软件层"全帧重画"模拟。

---

## 架构方案

### 三区独立模型（DECSTBM-based）

```
┌──────────────────────────────────┐
│  Scrollback（committed）        │
│  ─ 独立段、闭合段、welcome、历史 │
│  ─ 通过 region 顶部滚动自然进入  │
│  ─ 一旦进入永不 touch            │
├──────────────────────────────────┤
│  Scroll Region (DECSTBM)        │  ← \x1b[1;<scrollBottom>r
│  ┌────────────────────────────┐ │
│  │ Active Segment (流式中)    │ │   终端原生滚动
│  │ ─ markdown list / code     │ │   底部 \n 自动滚动
│  │   block 流式期 dim 字面     │ │   推到 scrollback
│  └────────────────────────────┘ │
├──────────────────────────────────┤  ← scrollBottom（DECSTBM 边界）
│  Chrome 区域                    │
│  ─ Status Bar (0..N 行)         │
│  ─ Input box + Panel            │
│  ─ 区域外，不参与 region 滚动   │
└──────────────────────────────────┘
```

**视觉契约**：
- chrome 永驻 viewport 底部 N 行（N = 动态 chrome 高度）
- scroll region = viewport 第 1 行到 chrome 上方
- 用户向上滚动 → 看到 scrollback 中的所有历史（包括已 push 的 welcome / 闭合段 / 早期流式内容）
- chrome 高度变化 → 重设 DECSTBM 边界

### 状态字段（与现有 ScreenController 对照）

新 `ScreenController` 不再维护：
- ❌ `tailBuffer` —— 流式内容直接写 stdout，没有"暂存"概念
- ❌ `cursorRow` / `renderedRows` —— 由 (scrollBottom, regionTailCol) 锚定 region 末位 + cursor positioning 绝对寻址
- ❌ `segmentStartRow` / `segmentFrozenLineCount` —— 由 `segmentRemainingRows`（持有逻辑行数）+ `committedLogicalRows`（已固化逻辑行数）取代

新维护：

| 字段 | 类型 | 含义 | 更新触发点 |
|---|---|---|---|
| `viewportRows / viewportCols` | int | 终端尺寸 | 启动期探测、resize |
| `scrollBottom` | int | DECSTBM 当前下边界（1-based viewport 行号） | chrome 高度变化、resize |
| `chromeHeight` | int | chrome 当前总高度（statusLines + input.renderLines() 行数） | setStatusBar、requestInputRepaint、attachInput、detachInput |
| `regionTailRow` | int | region 内 cursor 当前行号（1-based，1 ≤ row ≤ scrollBottom）；下一次 region 写入的起点行 | 写入路径推进；region 滚动时若 < scrollBottom 则不变（cursor 已在 scrollBottom）、若 = scrollBottom 则保持（滚动让 cursor 留在 scrollBottom） |
| `regionTailCol` | int | region 内 cursor 当前列号（1-based）；下一次 region 写入的起点列。`= 1` 表示上次写入以 `\n` 结尾、cursor 在新行行首 | 同 regionTailRow |
| `regionFilledRows` | int | region 中已被写入内容（非空白）的逻辑行数；`0 ≤ regionFilledRows ≤ scrollBottom`。chrome 高度协议场景区分用 | 写入路径增加；region 滚动减少（被推 scrollback 的填充行数）；suspend / detachInput 重置为 0 |
| `segmentTopRow` | int \| null | active segment 顶行的 viewport 行号；null = 无 active segment。replace 时用于定位 erase 起点 | beginReplaceableSegment（= regionTailRow，等待首次 replace 占行）、segment.replace（按写入起点更新）、region 滚动（同步递减；< 1 时 clamp 到 1，溢出累入 committedLogicalRows）、close |
| `segmentBottomRow` | int \| null | active segment 底行的 viewport 行号；null = 无 active segment。replace 时用于定位 erase 终点 | 同 segmentTopRow |
| `segmentRemainingRows` | int \| null | active segment 持有的逻辑行数（恒等于 `segmentBottomRow - segmentTopRow + 1`，便于直接读取） | 同 segmentTopRow |
| `committedLogicalRows` | int | active segment 已被滚动推进 scrollback 的逻辑行数累计；replace 时用于 newText.split('\n') 切片跳过 | region 滚动中 segmentTopRow 触到 1 后继续溢出累入；begin 归零 |

**关于 viewport 行追踪**：spec 早期版本曾试图用"逻辑行数反推"避开 viewport 行号——这是错误的简化。任何 region-based 架构都必须显式知道"内容在 viewport 哪些行"才能定位 erase / cursor positioning。**行宽硬合约保证逻辑行 = 物理行后，viewport 追踪是精确的**（每个 `\n` = 1 次滚动 = 所有 viewport 行号 -1）；估算才是漂移源，viewport 追踪本身不是。

**字段去冗余说明**：`segmentRemainingRows` 与 `segmentBottomRow - segmentTopRow + 1` 等价，保留是为了 chrome 协议 / partial commit 计算时直接可读，不增加更新点。

### 数据流重构

**前提硬合约**：所有 region 写入路径已通过"Region 写入合约（行宽硬约束）"保证 caller 送入文本"按 `\n` 切分后每段 ≤ columns - 1"。该合约让 **逻辑行 = 物理行**——`\n` 计数 = 物理换行 = region 滚动数（cursor 在 scrollBottom 时），所有 viewport 位置追踪精确无估算。

**模型**：top-anchored 自然流——cursor 顺内容向下走，到 scrollBottom 后 `\n` 才触发 region 滚动。所有 region 写入起点为 `(regionTailRow, regionTailCol)`，**不**强制跳到 `scrollBottom`。

```
┌─────────────────────────────────────────────────┐
│ 独立段（writeScrollLine / cliWriter.line）       │
│ ─ cursor 跳 (regionTailRow, regionTailCol)       │
│ ─ 若 regionTailCol > 1 → write '\n'              │
│   （独立段保证起新行起手；推进 1 行——若           │
│    regionTailRow = scrollBottom 则触发 1 次滚动）  │
│ ─ stdout.write(text + '\n')                     │
│ ─ 总写入 \n 数 = (text 中 \n 数) + 1              │
│   + (前置切行 0/1)                               │
│ ─ 滚动数 N = max(0, 总 \n 数 -                   │
│              (scrollBottom - regionTailRow_pre)) │
│ ─ 写入末态：regionTailRow = min(scrollBottom,    │
│   regionTailRow_pre + 总 \n 数 - N)              │
│   regionTailCol = 1（末尾 \n 让 cursor 在新行首）│
│ ─ 同步更新 regionFilledRows、segmentTopRow /     │
│   segmentBottomRow（详见"Region 滚动事件清单"）  │
├─────────────────────────────────────────────────┤
│ 流式 chunk（withScrollWrite / appendInline）     │
│ ─ cursor 跳 (regionTailRow, regionTailCol)       │
│ ─ stdout.write(chunk)                           │
│ ─ 滚动 / regionTailRow 更新逻辑同上              │
│   （按 chunk 中 \n 总数）                         │
│ ─ regionTailCol 写入末态：                        │
│   · 若 chunk 含 \n：regionTailCol =               │
│     visibleWidth(chunk 最后 \n 之后部分) + 1      │
│     （chunk 末尾恰好 \n → regionTailCol = 1）     │
│   · 若 chunk 无 \n（典型：LLM token 流单 token）： │
│     regionTailCol = regionTailCol_pre +           │
│     visibleWidth(chunk)                          │
│     （cursor 顺写顺前进，mid-line 续写无错位）    │
├─────────────────────────────────────────────────┤
│ Active segment.replace(newText)                 │
│ ─ M = newText.split('\n').length（合约保证 =     │
│   物理行数）                                      │
│ ─ M' = M - committedLogicalRows（仍持有部分）    │
│ ─ 决定 writeStartRow（与 K / partial 无关，仅依  │
│   赖 segmentTopRow 是否为 null；两路径同决策）：  │
│   · 有旧 segment（segmentTopRow !== null）：      │
│     writeStartRow = segmentTopRow                │
│     （新 segment 起点对齐旧 segment 顶——避免视   │
│      觉跳跃；M' 增大时向下扩展）                  │
│   · 首次 replace（无旧 segment）：                │
│     writeStartRow = regionTailRow                │
│     （首次 segment 紧贴当前内容尾，无视觉断层）   │
│ ─ K = scrollBottom - writeStartRow + 1           │
│   （从 writeStartRow 到 region 末的可用空间）     │
│ ─ 若 M' > K：partial commit 路径（详见下文）      │
│   ——会有 overflow = M' - K 行 \n 在 scrollBottom │
│   触发硬件滚动                                    │
│ ─ 否则（M' ≤ K，常规路径）：                      │
│   ─ writeBottomRow = writeStartRow + M' - 1      │
│   ─ erase 范围 = writeStartRow ..                 │
│     max(segmentBottomRow ?? 0, writeBottomRow)    │
│     · 既覆盖旧 segment 区域，也覆盖新 segment 向  │
│       下扩展将占用的区域——避免新 segment 单行短  │
│       于下方既存内容时按字符部分覆盖留下视觉碎片  │
│       （典型场景：notify interleave 后 segment   │
│        增长越过 notify，参见"interleave 语义"段） │
│     · 跳 (writeStartRow, 1) → 逐行 \x1b[2K +     │
│       cursor positioning 切下一行，循环到 erase  │
│       末行（不用 \x1b[J，会擦 chrome）            │
│   ─ 跳 (writeStartRow, 1)                       │
│   ─ write newText.split('\n')                    │
│     .slice(committedLogicalRows)                 │
│     .join('\n')（M' 段，行间 \n，无末尾 \n）      │
│   ─ 写完更新：                                   │
│     segmentTopRow = writeStartRow                │
│     segmentBottomRow = writeBottomRow            │
│     segmentRemainingRows = M'                    │
│     regionTailRow = segmentBottomRow             │
│     regionTailCol = 末行字符数 + 1                │
│     regionFilledRows: 走 Region 滚动事件清单的    │
│       通用更新公式（统一收口，本节不重复）         │
├─────────────────────────────────────────────────┤
│ Active segment.commit(newText)                  │
│ ─ 与 replace 同流程写入最终 newText              │
│ ─ commit 完不主动 \n——内容已落地在 region 中     │
│ ─ 清 segmentTopRow / segmentBottomRow /          │
│   segmentRemainingRows = null                    │
│ ─ committedLogicalRows = 0                       │
│ ─ 后续 appendInline / writeScrollLine 自然续写   │
│   到 (regionTailRow, regionTailCol) = 紧贴       │
│   commit 后内容尾，无视觉跳跃                    │
├─────────────────────────────────────────────────┤
│ Chrome 维护                                      │
│ ─ 进入前：(regionTailRow, regionTailCol) 已记录  │
│   作为 chrome 重画结束后的返回点                  │
│ ─ 跳 chrome 起点（绝对行号 = scrollBottom + 1）   │
│ ─ 逐行 \x1b[2K + 内容（cursor positioning 切行， │
│   不发 \n——chrome 在 DECSTBM region 之外，\n 会  │
│   触发整屏滚动破坏 chrome 永驻）                  │
│ ─ cursor 回 (regionTailRow, regionTailCol)       │
│   （top-anchored 不变量：cursor 始终在内容尾，    │
│    不强制贴 scrollBottom——避免 region 未填满时   │
│    出现 welcome 与流式内容间的视觉断层）           │
└─────────────────────────────────────────────────┘
```

### Segment 显式 viewport 行追踪

**架构关键决策**：segment 显式维护 `segmentTopRow / segmentBottomRow`（viewport 行号），而非依赖任何反推公式。行宽硬合约保证逻辑行 = 物理行后，所有 region 滚动事件中 viewport 位置可被精确同步——viewport 追踪是精确的、无漂移的。

**为什么必须显式追踪 viewport 行**（而非 spec 早期版本的"反推"方案）：
- `appendInline / writeScrollLine` 会插入 region 写入路径，cursor 自然顺内容下行；segment 不一定贴底
- `cliWriter.notify`（scheduler 任务通知）在 LLM 流式期间会触发——`repl.ts:1153-1158` 注释明文承诺。notify 走 writeScrollLine，写在 segment 之后会把 segment 推上去 N 行；segment 不在 region 底部
- "segment 在底部"的反推假设在上述场景下失效——必须显式追踪 segment 在 viewport 的真实位置

**核心规则**：
- `begin` 时：
  - **fresh-line 显式合约**：若 `regionTailCol > 1`（cursor mid-line），先 write `\n` 推进到下一行起首（regionTailRow += 1 或触发 1 次滚动；regionTailCol = 1）。该步骤保证 segment 起首必在 fresh line，**不依赖 caller 之前是否调过 closeParagraphStream / 是否补过 \n**——合约层强制
  - 清 `segmentTopRow / segmentBottomRow / segmentRemainingRows = null`、`committedLogicalRows = 0`；handle 创建但未占行
- `replace(newText)` / `commit(newText)`（M' ≤ K 路径）：
  - `M = newText.split('\n').length`
  - `M' = M - committedLogicalRows`
  - 决定 writeStartRow：
    - 有旧 segment：`writeStartRow = segmentTopRow`（新内容对齐旧顶，向下扩展 / 收缩）
    - 首次 replace：`writeStartRow = regionTailRow`（紧贴当前内容尾，无视觉断层）
  - `K = scrollBottom - writeStartRow + 1`（从 writeStartRow 到 region 末的可用空间——**不是 scrollBottom 全长**）
  - 若 `M' > K` → 走 partial commit 路径（避免新 segment 末尾溢出到 chrome 区域）
  - `writeBottomRow = writeStartRow + M' - 1`（≤ scrollBottom，因 M' ≤ K）
  - erase 范围 = `writeStartRow .. max(segmentBottomRow ?? 0, writeBottomRow)`：覆盖旧 segment + 新 segment 将占用的扩展区，避免覆写下方非 segment 内容（如 interleave notify）时按字符部分覆盖留下视觉碎片
  - 跳 (writeStartRow, 1)，write `newText.split('\n').slice(committedLogicalRows).join('\n')`
  - 写完更新：`segmentTopRow = writeStartRow`、`segmentBottomRow = writeBottomRow`、`segmentRemainingRows = M'`、`regionTailRow = segmentBottomRow`、`regionTailCol = 末行字符数 + 1`；regionFilledRows 走 Region 滚动事件清单的通用更新公式
- region 滚动事件中（其他写入路径或 chrome 协议触发 N 次滚动）：
  - 同步递减 `segmentTopRow -= N`、`segmentBottomRow -= N`
  - 若 `segmentTopRow < 1`：clamp 到 1；溢出 `1 - (segmentTopRow_pre - N)` 累入 `committedLogicalRows`；同步 `segmentRemainingRows = segmentBottomRow - segmentTopRow + 1`
  - 若 `segmentBottomRow < 1`：segment 已完全被推 scrollback；清三字段为 null（caller 角度仍可调 replace；下次 replace 走 "首次" 路径在新位置重起）
- `commit / close`：清 `segmentTopRow / segmentBottomRow / segmentRemainingRows = null`、`committedLogicalRows = 0`

**举例**（scrollBottom = 20，无 interleave 情况）：

| 调用 | M | M' | 旧 segment 范围（top..bot）| writeStartRow | 写后 segment 范围 | 写后 committedLogicalRows |
|---|---|---|---|---|---|---|
| begin（前序写入让 regionTailRow = 12）| - | - | null | - | null | 0 |
| 第 1 次 replace（5 行）| 5 | 5 | null（首次）| 12 | 12..16 | 0 |
| 第 2 次 replace（15 行）| 15 | 15 | 12..16（5 行）| 12 | 12..26？ → 超 K=9（= 20 - 12 + 1）→ partial commit | - |

partial commit 触发（K = scrollBottom - writeStartRow + 1 = 20 - 12 + 1 = 9，M' = 15 > K = 9）：
- erase 12..16（旧 segment 范围；新 writeBottomRow = 12 + 15 - 1 = 26 越过 scrollBottom，partial commit 路径不延伸 erase 到 26 ——溢出部分由滚动天然推走，无需 erase）
- 跳 (12, 1)、写 newText 全 15 行
- 写到第 9 行末尾时 cursor 到 row 20；之后每行 \n 触发滚动 1 次
- 总滚动数 overflow = M' - K = 15 - 9 = 6（每次滚动推走 region 顶 1 行）
- 滚动消化 region 顶 6 行——这部分是 segment **之上** 的 history（前序 paragraph 等，原占 rows 1..11 中最早的 6 行进 scrollback）；segment 自己 15 行**全部仍在 region 中**
- 写后：
  - segmentTopRow = max(1, writeStartRow - overflow) = max(1, 12 - 6) = 6
  - segmentBottomRow = scrollBottom = 20
  - segmentRemainingRows = 20 - 6 + 1 = 15（= M'，segment 全保留）
  - committedLogicalRows += M' - segmentRemainingRows = 15 - 15 = 0（segment 自己未被推走任何行）
- 唯一进 scrollback 的是 segment 之上的 history。仅当 writeStartRow - overflow < 1 时（即 segment 自己饱和占满 region 仍不够），committedLogicalRows 才开始累加

**举例（含 notify interleave）**：
1. begin → regionTailRow = 12（前序 paragraph 内容尾）
2. replace 5 行 → segment 12..16、regionTailRow = 16
3. notify 触发（writeScrollLine 写 2 行 "✓ 任务完成 ..."）→ 写 2 个 \n + 2 行内容 + 末尾 \n = 3 个 \n。从 row 16 起 cursor 走到 row 20 后还剩 \n 触发滚动。**关键**：滚动同步递减 segmentTopRow / segmentBottomRow
4. replace 10 行（M' = 10）：用更新后的 segmentTopRow / segmentBottomRow 精确定位 erase + writeStart——不会误擦 notify 内容（若 notify 在 segment 之上、segment 以下方向扩展则不冲突）

### Interleave 语义（segment 增长覆盖下方非 segment 内容）

**场景**：active segment 期间触发 cliWriter.notify（典型：scheduler 任务完成通知）。notify 走 writeScrollLine 写在 segment 之后；下次 segment.replace 若 M' 增长越过 notify 行，新 segment 内容**覆盖** notify 内容。

```
状态序列：
  T0: segment 4..8, regionTailRow = 8
  T1: notify writeScrollLine 写 2 行 → notify 在 rows 9..10, regionTailRow = 11
  T2: segment.replace M'=10 →
      writeBottomRow = 4 + 10 - 1 = 13
      erase 范围 = 4..max(8, 13) = 4..13（覆盖旧 segment + notify + 扩展区）
      写新 segment 4..13 → notify 内容被覆盖
```

**erase 范围扩展的作用**：保证 erase 区域 ≥ write 区域。若不扩展、仅 erase 旧 segment 4..8，则新 segment 第 6-10 行直接覆写 notify 行 9-10 的字符；新行短于 notify 时残留 notify 末尾几字符 → 视觉碎片（如 "abc✓ne"）。扩展后 erase 4..13 先清屏再写，无视觉碎片。

**数据持久语义**：notify 内容**已丢失**，被覆盖后无法恢复（DECSTBM 无 buffer 架构的固有 trade-off）。这与当前架构 `applySegmentContent` 的 `tailBuffer.length = segStart` 截断行为一致——当前架构同样在 segment 之后 enqueue 的 notify 在下次 replace 时被丢弃；视觉上当前架构因全帧重画呈现干净最终态，新架构通过扩展 erase 范围达到同等清洁。

**caller 侧规避**：若 notify 内容关键（不可丢失），caller 应在 segment 已 commit 后再发 notify——commit 后 segment 不再 replace，notify 在其后写入，最终随 region 自然滚动落入 scrollback 永久保留。

### Region 滚动事件清单

**前提**：所有 region 写入路径已通过"行宽硬合约"保证逻辑行 = 物理行，故"滚动行数 = `\n` 在 scrollBottom 行时触发的次数"——不存在隐式 wrap 滚动，零估算。

**滚动数计算公式**（适用任意写入路径）：

```
N_scrolls = max(0, totalNewlinesWritten - (scrollBottom - regionTailRow_pre))
```

| 写入事件 | totalNewlinesWritten |
|---|---|
| `writeScrollLine(text)` | (text 中 \n 数) + 1 末尾 + (前置切行 0/1，regionTailCol > 1 时为 1) |
| `withScrollWrite(chunks)` / `appendInline(chunk)` | chunk 拼接后 `\n` 总数 |
| `segment.replace(newText)` / `commit(newText)` | M' - 1（newText.slice(committedLogicalRows).join('\n') 的 \n 数）|
| chrome 高度增大（场景区分）| 见下文 |
| chrome 高度减小 | 0（新空间扩展 region 底部，无滚动）|

**通用 viewport 位置同步更新**（任何 region 写入 / 滚动事件后统一收口；单一公式覆盖所有路径）：

```ts
// 输入：
//   N            = 本次写入触发的滚动数（≥ 0）
//   regionTailRow_post = 写入后 cursor 行号（写入路径事先计算好）
//   regionFilledRows_pre, segmentTopRow_pre, segmentBottomRow_pre, segmentRemainingRows_pre
//   committedLogicalRows_pre

// 1. segmentTopRow / segmentBottomRow / segmentRemainingRows / committedLogicalRows:
//    仅当 N > 0 且 segment 活跃时同步递减
if (N > 0 && segmentTopRow !== null) {
  segmentTopRow -= N;
  segmentBottomRow -= N;
  if (segmentBottomRow < 1) {
    // segment 完全被推 scrollback，caller 下次 replace 走 "首次" 路径
    committedLogicalRows += segmentRemainingRows;
    segmentTopRow = segmentBottomRow = segmentRemainingRows = null;
  } else if (segmentTopRow < 1) {
    // segment 顶被推走但仍持有部分
    const overflow = 1 - segmentTopRow;
    committedLogicalRows += overflow;
    segmentTopRow = 1;
    segmentRemainingRows = segmentBottomRow - segmentTopRow + 1;
  }
}

// 2. regionFilledRows（统一公式，不再分散在各写入路径）：
//    写入让内容尾扩到 regionTailRow_post；滚动消化老内容；二者取大兼顾
//    "shrink 但下方仍有内容" 等边缘场景；最终 clamp 到 scrollBottom
const consumedFilled = Math.min(N, regionFilledRows);
regionFilledRows = Math.min(
  scrollBottom,
  Math.max(regionFilledRows - consumedFilled, regionTailRow_post),
);

// 3. regionTailRow:
//    无滚动场景下由写入路径直接推进（regionTailRow_pre + 写入 \n 数）；
//    有滚动场景下 cursor 已被终端固定在 scrollBottom——
//    写入路径已设 regionTailRow_post = scrollBottom，本步无需额外动作
```

**调用约定**：每个写入路径（writeScrollLine / withScrollWrite / segment.replace / segment.commit / chrome 高度协议主动 \n × N）在写入完成后，**统一调用此公式**进行 viewport 状态同步——不在路径内部分散维护 regionFilledRows / segment 字段。这是消除"各路径维护不一致"的工程纪律。

**chrome 高度增大场景区分**：协议不盲推——必须区分"region 是否有需推内容"：

```ts
const surplusRows = scrollBottom_old - regionFilledRows;  // region 顶部空闲行数

if (surplusRows >= N) {
  // 空间够：直接缩 DECSTBM，不推 scrollback；regionFilledRows 不变
  setDECSTBM(1, scrollBottom_new);
} else {
  // 不够：仅推必须推的部分
  const pushRows = N - surplusRows;
  cursor 跳 (scrollBottom_old, 1);
  write '\n' × pushRows;
  // 同步执行通用 viewport 位置更新（N = pushRows）
  setDECSTBM(1, scrollBottom_new);
}
// 后续：cursor 跳 (regionTailRow, regionTailCol)（top-anchored 不变量：
// 不跳到 scrollBottom_new，避免 region 未填满时 welcome 与流式内容间视觉断层）
// regionTailRow 此时若 > scrollBottom_new，clamp 到 scrollBottom_new
regionTailRow = min(regionTailRow, scrollBottom_new);
```

启动期 attachInput（chrome 0 → N、scrollBottom_old = viewportRows、welcome 占顶部 K 行、`regionFilledRows = K`、surplusRows = viewportRows - K）通常 surplusRows ≥ N → 走快路径，welcome 顶不会被推 scrollback。

### Partial Commit（M' 超过容量 K）

当 `segment.replace(newText)` 的 M' = `newText 总行 - committedLogicalRows` 超过容量 `K = scrollBottom - writeStartRow + 1`（writeStartRow 决策见数据流图）时，走 partial commit 路径。

**注意 K 的定义**：K 是从 `writeStartRow` 到 `scrollBottom` 的可用空间，**不是 scrollBottom 全长**。当 writeStartRow > 1（典型场景：首次 replace 紧贴前序内容尾、或旧 segment 顶在 region 中部），K 远小于 scrollBottom。漏算这一点会让"M' ≤ scrollBottom 但 M' > K" 的中间区间走错路径，erase 末行越过 scrollBottom 误擦 chrome。

```
1. erase 旧 segment 范围（若 segmentTopRow !== null）：
   跳 (segmentTopRow, 1) → 逐行 \x1b[2K + cursor positioning 切下一行
   循环到 segmentBottomRow（不用 \x1b[J，避免擦 chrome）
2. 跳 (writeStartRow, 1)
3. write newText.split('\n').slice(committedLogicalRows).join('\n')
   - 前 K 行：从 writeStartRow 起填到 scrollBottom
   - 第 K 行末尾的 \n → cursor 想下移但已在 scrollBottom → 滚动 1 次
   - 后续每一行追加都触发 region 底部滚动 1 次
   - 总写入 \n 数 = M' - 1
   - 滚动数 overflow = max(0, (M' - 1) - (scrollBottom - writeStartRow))
                    = M' - K（M' > K 时）
4. 写后 viewport 位置（直接结合 erase 扩展 + 通用更新公式）：
   - erase 范围扩展：partial commit 总是写到 scrollBottom，erase 等价覆盖 writeStartRow..scrollBottom，自动满足"erase 范围 ≥ write 区域"的扩展要求
   - 写完后 segmentTopRow = max(1, writeStartRow - overflow)
   - segmentBottomRow = scrollBottom
   - segmentRemainingRows = segmentBottomRow - segmentTopRow + 1
   - committedLogicalRows += (M' - segmentRemainingRows)（写出但被推 scrollback 的行数）
   - regionTailRow_post = scrollBottom；regionTailCol = 末行字符数 + 1
   - **调用通用更新公式**（输入 N = overflow、regionTailRow_post = scrollBottom）完成 regionFilledRows 同步——写后必为 scrollBottom（filled 已饱和）
5. 下次 replace 时 newText.split('\n').slice(committedLogicalRows) 自动跳过已固化早期行
```

**关键**：partial commit 不是独立动作，**是 `\n` 在 scrollBottom 行自然滚动的副产品**。代码不主动 `stdout.write 到 scrollback`——一切固化通过"在 region 底部触发滚动"统一发生。

**滚动消化顺序**：滚动从 region 顶部开始消化。partial commit 时步骤 1 已 erase 了 segmentTopRow..segmentBottomRow 的旧 segment；步骤 2-3 从 writeStartRow（= 旧 segmentTopRow）写新内容。新内容向下扩展到 scrollBottom 后，剩余 `\n` 推走的是 region rows 1..(writeStartRow - 1)——若 writeStartRow > 1，这部分是 segment 之上的历史段；若 writeStartRow = 1（旧 segment 已饱和），推走的是新 segment 自己的早期行。两种情况都符合 caller 预期。

### Region 写入合约（行宽硬约束）

新架构对所有进入 scroll region 的写入路径强制以下合约：

> **caller 负责在送入 `withScrollWrite / writeScrollLine / segment.replace / segment.commit` 之前完成软折行——把超宽语义内容用 `wrapAnsiLine`（ANSI 染色）/ `wrapToWidth`（纯文本）拆成多条窄行、用 `\n` 连接（续行加视觉缩进保持对齐）。送入 ScreenController 的字符串，按 `\n` 切分后每段显示宽度 ≤ `columns - 1`。**

**关键认知**：ScreenController 视角下的"逻辑行"= `\n` 切分单元，**不是** caller 的"语义行"。caller 的 1 条 list item 在 ScreenController 看来可以是 N 条逻辑行（首行 + 续行各算一条）。这与 `text-stream.ts` 对 paragraph 的处理方式一致——`◆` 锚 + hanging-4 续行也是 `\n` 切多段。

**为什么是硬合约不是软建议**：
- segment 追踪用 `newText.split('\n').length` 作为 region 物理行数（合约让逻辑 = 物理）
- 滚动事件计数用 `\n` 个数 = 物理滚动次数（合约让逻辑 = 物理）
- 若合约违反 → 终端隐式 wrap → 物理行数 > 逻辑行数 → segment 位置漂移、滚动数低估
- 这就是当前架构 bug 的等价形态——**合约违反 = bug 直接复现**

**配套基础设施 — `wrapAnsiLine`（必要前置）**：

block-renderer 的输出含 ANSI 染色（chalk / cli-highlight），不能直接喂给 `wrapToWidth`——后者明文声明"不识别 ANSI 转义码，序列会被切碎"。需要新增一个 ANSI-aware wrap 工具：

```ts
// tui/line-width.ts 新增
export function wrapAnsiLine(
  text: string,
  maxVisibleWidth: number,
  continuationPrefix?: string,
): string;
```

行为契约：
- 逐字符扫描，用 `charWidth` 累计可见宽度（CJK 2 列、ASCII 1 列、控制符 0 列）
- 识别 ANSI CSI / OSC 序列：SGR 累积到 active SGR 状态、序列本身宽度 0 不参与折行决策
- 累计宽度 + 当前字符 > `maxVisibleWidth` 时：emit `SGR_RESET + \n + (continuationPrefix ?? '') + activeSgr` 续行，宽度计数从 0 重新累计（`continuationPrefix` 是 caller 自定的视觉缩进字串、其内宽度 caller 自负）
- 返回**单字符串**，已含 `\n` 续行；caller 直接 emit 不需再处理
- 实现来源：从 `text-stream.ts` 内部 wrap 逻辑（追踪 `activeSgr` + emit `continuationPrefix`）萃取解耦；`text-stream.ts` 重构为调用此函数，消除重复

**为何必须新增**：没有 ANSI-aware wrap 工具，合约在 ANSI 染色内容上**无法落地**——直接用 `wrapToWidth` 会切断 SGR 序列，颜色泄露/断裂，bug 比当前架构更糟。

**API 选择决策**：

| 函数 | 输入 | 行为 | 适用场景 |
|---|---|---|---|
| `wrapAnsiLine(text, maxWidth, contPrefix?)` | 含 ANSI 染色单逻辑行 | 软折行多段；保 SGR 自平衡；续行自动加 contPrefix | **block-renderer / 任何 ANSI 染色 caller —— region 合约的主要落地工具** |
| `wrapToWidth(text, maxWidth)` | 纯文本 | 软折行多段；不识别 ANSI | 纯文本 caller（罕见） |
| `clampLine(text, maxWidth)` | 含 ANSI 单行 | **截断**；超宽部分丢失 + `…`；不折行 | "放不下就放弃显示"场景（typeahead-panel hint）；**绝对不要**用于 region 合约 |

**违反合约的责任分布**：

| Caller | 当前是否合规 | 修补 |
|---|---|---|
| `text-stream.ts`（paragraph 路径）| ✓ 已自带 ANSI-aware wrap + hanging 4 续行 | 重构内部实现为调用 `wrapAnsiLine`（消除与新工具的重复），行为不变 |
| `block-renderer.ts:renderList / renderListItem` | ✗ 不做行宽 wrap | 对每个 inline ANSI 行用 `wrapAnsiLine(line, columns - 1 - listIndent, continuationIndent)` 切多段（continuationIndent 对齐 marker 之后），结果含 `\n` 直接 emit |
| `block-renderer.ts:renderCode` | ✗ fenced code 行可超 columns（长字符串、长 import 路径） | 每行 `wrapAnsiLine(line, columns - 1 - codeIndent, codeIndent)`；语法高亮 SGR 由 wrapAnsiLine 自动平衡，跨续行无颜色泄露 |
| `block-renderer.ts:renderHeading / renderBlockquote` | 短行常态、偶有长 quote 子段 | 加 `wrapAnsiLine` 防御，零额外成本 |
| `block-renderer.ts:renderHr` | 固定 40 字符 dim 横线 | 不需 wrap |
| `security-event-renderer.ts` 等独立段 caller | 多数行较短，卡片 / table 类可能超宽 | 加 `wrapAnsiLine` 防御；卡片若用边框，wrap 范围限定边框内 content |

**合约的工程落地**：
- `screen-controller.ts` 写入路径**不验证**合约——验证成本高且让 caller 感知不到违反点
- 测试基础设施在 `screen/__tests__/` 加合约断言：mock stdout 的写入序列按 `\n` 切分后，每段先经 ANSI strip 再用 `stringWidth` 测量 ≤ `columns - 1`；任何 caller 改动违反合约 → 测试失败
- 工程意识：所有新增进入 region 的写入路径在 PR 中标记"已 wrapAnsiLine / wrapToWidth 到 columns"

**为何 stringWidth 估算彻底退出关键路径**：合约保证后，caller 送入的每段已经过 `stringWidth` 测量并 wrap 到 ≤ columns - 1，ScreenController 直接用 `\n` 计数就是物理行数。估算唯一可能用途（partial commit 时机预判）也不需要——partial commit 是 `\n` 在 scrollBottom 自然滚动的副产品，事后追踪即可。

### Chrome 高度动态协议

input box / panel / status 高度随用户行为级事件变化（按键、paste、`/` 触发面板、status 状态切换）。chrome 高度变化的检测入口：

| 入口 | 触发场景 | 检测方式 |
|---|---|---|
| `setStatusBar(lines)` | status 内容变化（spinner / phase） | 比较 `lines.length` 与上次 |
| `requestInputRepaint()` | input buffer / panel 状态变化 | 调 `input.renderLines().length` 比较 |
| `attachInput(region)` | input 挂载 | chromeHeight 0 → 新值 |
| `detachInput()` | input 卸载 | chromeHeight 旧值 → 0 |

每次入口触发时（**整个流程必须在单个 enqueue task 内原子执行**，避免与 segment.replace / appendInline 等其他写入交错）：

```
1. 计算新 chromeHeight
2. 若 chromeHeight 不变 → 仅重画 chrome 内容（cursor positioning + \x1b[2K + 写 + cursor 回 (regionTailRow, regionTailCol)，top-anchored 不变量）
3. 若 chromeHeight 变化：
   a. scrollBottom_new = viewportRows - chromeHeight_new
   b. chrome 变高（scrollBottom 减小 N = chromeHeight_new - chromeHeight_old）：
      - 走"Region 滚动事件清单"中的 chrome 高度增大场景区分逻辑
        （surplusRows ≥ N 时不推；surplusRows < N 时推 pushRows = N - surplusRows）
      - 重设 DECSTBM: \x1b[1;<scrollBottom_new>r
   c. chrome 变矮（scrollBottom 增大 N）：
      - 重设 DECSTBM: \x1b[1;<scrollBottom_new>r
      - 原 chrome 顶部 N 行（现属 region 但显示残留 chrome 内容）需清空：
        cursor positioning + \x1b[2K 逐行清
      - regionFilledRows 不变（清空的是显示残留，不是逻辑内容）
   d. cursor 跳 (regionTailRow, regionTailCol) 作为后续 region 写入起点
      （regionTailRow 已在通用更新公式中按 pushRows 滚动数同步过；
       若仍 > scrollBottom_new 则 clamp 到 scrollBottom_new）
   e. 重画 chrome 内容到 viewport 底部 chromeHeight_new 行
```

**原子性约束**：步骤 a-e 必须在同一个 stdout.write 序列内完成（单次 buffer 拼接 + flush），中途不允许 chrome 重画 / segment.replace / appendInline 等其他写入插入。`enqueue` 队列序列化保证不会与其他 task 并发；同 task 内必须不发起新的 enqueue。

变化频率是用户行为级（不是 250ms tick 级）。status-bar 250ms tick **通常不改变高度**（active phase 渲染固定 1 行），仅内容刷新——走步骤 2 的"仅重画内容"快路径。**唯一改变高度的 tick 场景**：phase 从 idle 切到 active（statusLines 0 → 1）或反向；这是 turn 边界事件，频率低。

### Suspend / Resume 协议（alt UI 嵌入）

> （2026-05-16 更新：本节描述的"suspend = 擦 chrome + 撤 DECSTBM 的 destructive
> clear；调用方自己 emit `\x1b[?1049h`"协议**已被取代**。commit 26fab39 把
> suspend/resume 改为由 `ScreenController` 自身切 alternate screen buffer——
> destructive DECSTBM clear 路径是 home 页 modal 后历史丢失 bug 的根因，已废弃。
> 当前实现见 `packages/cli/src/screen/screen-controller.ts` 的 `suspend()/resume()`
> 与 `scroll-region.ts` 的 `suspend()/resume()`，下方为修正后的现状描述。)

confirmation panel 等 modal alt UI 进入 / 退出协议：

```
ScreenController.suspend()：
  1. emit `\x1b[?1049h` 切到 alternate screen buffer
     —— 终端**原子保存** main buffer 整体（viewport 内容含 region 可视区
        对话历史 + scrollback + cursor + DECSTBM 状态由终端保管）
  2. emit `\x1b[1;1H` home cursor（alt buffer 入口 cursor 位置 implementation-
     defined，显式 home 让 alt UI 起手位置确定）
  3. scrollRegion.suspend()：**纯 flag 切换、不做任何 destructive emit**
     （内部状态字段 regionTailRow / segmentTopRow 等天然保留——内容由终端
      alt-screen 原子保管，不需 reset；contract: suspend 期间不持有活跃 segment）
  4. 标记 suspendedFlag，状态变更广播给订阅者

ScreenController.resume()：
  1. emit `\x1b[?1049l` 切回 main buffer
     —— 终端**原子恢复** viewport 内容 / scrollback / cursor / 到 suspend 前
  2. scrollRegion.resume()：emit 防御性 `\x1b[1;<scrollBottom>r`
     （DECSTBM 跨 alt-screen 是 implementation-defined 是否保存，re-emit 兜底）
  3. refreshChrome()：用最新状态重画 chrome（idempotent 或反映 suspend
     期间累积的 setStatusBar / setStatusTail 变化）
  4. emit hideCursor 重新断言 chrome 模式硬件光标隐藏不变量
  5. 标记 unsuspended，flush 消费 suspend 期间累积的暂存任务
```

config-editor 等 caller 自管的 alt-screen 切换与本 suspend 协议**正交**——
main buffer 模式下 caller 自管 alt screen 不影响 zhixing 主体视图（main buffer
不动）。两层不共享状态。

### Resize 处理

> （2026-05-16 更新：本节描述的"每个 `on('resize')` 事件逐帧重设 DECSTBM +
> 重画 chrome"协议**已被取代**。commit b95e236 把 resize 改为"逐帧不重画
> （ScreenController 对 stdout 零写入，输入区交终端 reflow）+ resize-end
> 防抖后整屏重建"——逐帧重画会在拖拽窗口时制造碎 box 残留。下方为修正后的
> 现状描述。当前实现见 `screen-controller.ts` 的 `attachResizeListener` /
> `scheduleResizeEnd` / `onResizeEnd` / `rebuildAfterResize` 与 `scroll-region.ts`
> 的 `setViewport` / `establishLayout` / `rebuild`；已删除 `ScrollRegion.handleResize`
> / `anchorRegionAfterReflow`。)

```
on('resize')（逐帧，internal-only，对 stdout 零写入）：
  1. 重读 stdout.rows / stdout.columns
  2. 同步 ScreenController.viewportRows/Cols（纯内存）
  3. scrollRegion.setViewport(rows, cols)：仅更新内部 viewportRows/Cols 认知，
     **不动 DECSTBM / 不重画 chrome / 不写屏**——输入区与欢迎块同等待遇，
     交终端自身 reflow，不制造程序碎 box 残留
  4. scheduleResizeEnd()：重置 RESIZE_END_DEBOUNCE_MS（200ms）防抖 timer

resize-end（防抖静默期满后单次触发，与逐帧路径正交）：
  → 通知 onResizeEnd 订阅者最终稳定尺寸
  → caller 调 rebuildAfterResize(regionContent)，单 enqueue task 内：
     1. 全清（复用 ANSI_FIRSTATTACH_SEQUENCE = \x1b[2J\x1b[3J\x1b[1;1H，
        含 \x1b[3J 清终端 scrollback——清掉 resize 期间终端 reflow 堆积的
        欢迎块/旧输入区残片；磁盘 transcript 不受影响）+ hideCursor
     2. 按最新尺寸 computeChromeHeight + buildChromeBytes
     3. scrollRegion.rebuild（经 establishLayout 复位 region 几何 + 重设
        DECSTBM + 重画 chrome，与 firstAttach 同序列、同 establishLayout）
     4. 经 caller 的 regionContent() 回调重写 region 初始内容（欢迎块/告警，
        延迟到重建时才生成，用最新 session 状态）
     5. cursor 复位
```

**为什么逐帧不重画**：拖拽窗口时 stdout `resize` 高频连续触发，逐帧重设
DECSTBM + 重画 chrome 会与终端自身的 reflow 竞争，产生碎 box 残留累积。改为
"逐帧交终端 reflow + resize-end 防抖稳定后整屏重建"——多段拖拽（拖-停-拖-停）
每段各触发一次 resize-end，互不混淆。

**active segment 语义**：resize 不强制 commit segment——caller（markdown-stream）
持有 ReplaceableSegmentHandle 跨多个 chunk，强制 commit 后 handle 闭合会让本 turn
剩余 list / code 内容渲染丢失。整屏重建从 region 顶重写，下一个 chunk 到达即按
新尺寸自动恢复正确显示。resize 期间已写出的 scrollback 内容 reflow 由终端处理。

### detachInput 行为

```
detachInput()：
  1. 撤 DECSTBM: \x1b[r （恢复全屏 scroll region）
  2. cursor 跳 viewport 底
  3. erase 到屏幕底（擦 chrome）
  4. 清状态：input = null, chromeHeight = 0, scrollBottom = viewportRows,
     segmentTopRow = segmentBottomRow = segmentRemainingRows = null,
     committedLogicalRows = 0,
     regionTailRow = 1, regionTailCol = 1, regionFilledRows = 0
  5. 不接受新写入直到 attachInput
```

`detachInput` 是 chrome 完全消失语义；之后 ScreenController 进入"无 chrome"状态，类似启动期。

### 异常退出清理

```
process.on('exit') / SIGINT / SIGTERM:
  撤 DECSTBM: \x1b[r
  cursor 重定位到 viewport 底
```

确保 zhixing 退出后 shell 的 `\n` 行为恢复正常（不再受 region 限制）。

### 启动序列

```
1. 探测终端能力（DECSTBM 兼容性 + viewport 行列 + cooked TTY 模式校验）
2. attachInput 调用：caller 提供 InputRegion；此时尚未画任何内容
   a. 计算 chromeHeight = input.renderLines().length + statusLines.length（初始 0）
   b. scrollBottom = viewportRows - chromeHeight
   c. 设置 DECSTBM: \x1b[1;<scrollBottom>r
   d. cursor 跳 (1, 1) 作为 region 顶起点
   e. 画 chrome 内容到 rows scrollBottom+1..viewportRows
   f. cursor 回 (1, 1)
   g. 状态：regionTailRow = 1, regionTailCol = 1, regionFilledRows = 0,
      segmentTopRow = segmentBottomRow = segmentRemainingRows = null,
      committedLogicalRows = 0
3. welcome 写入：
   - cliWriter.line(welcomeAnsi) 走 writeScrollLine 路径
   - cursor 跳 (regionTailRow=1, regionTailCol=1) → 写 welcome（含末尾 \n）
   - 内容自然填充 region rows 1..K（K = welcome 逻辑行数，caller 用 wrapAnsiLine 保证每段 ≤ columns - 1，K ≤ scrollBottom）
   - 写入末态：regionTailRow = K + 1（若 K + 1 ≤ scrollBottom）或 scrollBottom（若饱和触发滚动）；regionTailCol = 1；regionFilledRows = K
4. 后续写入：第一次 appendInline / writeScrollLine 时 cursor 跳 (regionTailRow, regionTailCol)——紧贴 welcome 末尾自然下行，无视觉断层
```

**top-anchored 自然流不变量**：cursor 顺内容下行；regionTailRow ∈ [1, scrollBottom]；当 regionTailRow = scrollBottom 时下一个 `\n` 才触发 region 滚动。welcome 在 region 顶、流式内容紧贴 welcome 之后——视觉上和 Claude Code / aider 等成熟 cli 行为一致。

**welcome 永驻**：welcome 在 region 顶（rows 1..K），后续 LLM 输出从 regionTailRow 起手自然下行；region 填满后 `\n` 触发滚动、welcome 顶被推 scrollback——这是预期 UX（与 git log / less 等行为一致）。这与"chrome 0 → N 协议盲推"不同——后者是协议 bug，已在 Region 滚动事件清单中区分场景修复。

---

## 关键设计

### 终端兼容性 — 启动期检测 + fail-fast

**最低终端要求**（与 zhixing 当前 ANSI 颜色 / cursor 控制依赖范围一致）：
- Windows Terminal（Win11 默认）
- conhost.exe（Windows 10 build 17134 / 1803+，cmd.exe / PowerShell 默认宿主，ConPTY 稳定基线）
- macOS Terminal.app / iTerm2
- Linux 主流终端（GNOME / Konsole / xterm / alacritty）
- VS Code / Cursor 集成终端（xterm.js）
- 主流 ssh 客户端

**不支持**：
- Windows 10 1803 之前的 conhost.exe（ConPTY 在 1709 起支持但 1803 才稳定，早期版本部分 ANSI 序列被当字面字符显示）
- PowerShell ISE（已停更）
- 极端嵌入式终端

**启动期检测**（一次性，fail-fast）：
- `process.stdout.isTTY` 必须为 true
- 平台 + 版本检测（Windows kernel build ≥ 17134（10 1803，ConPTY 稳定基线）、`TERM` env 非 dumb）
- **cooked TTY 模式校验**：所有 region 写入路径用 `\n` 而非 `\r\n`，依赖终端 ONLCR 把 `\n` 翻为 `\r\n`（cooked TTY 默认行为）。stdin 可走 raw mode（readline 输入处理需要），但 stdout 必须保持 cooked。检测方式：`process.stdout` 不应被 caller 调用 `setRawMode(true)`；项目内部全局约束
- 可选：发一次 `\x1b[6n` cursor query + 同步 stdin 等待 reply（超时 200ms）→ 验证终端响应能力

**运行期不依赖 cursor query**——所有 segment / region 状态（`regionTailRow / regionTailCol / regionFilledRows / segmentTopRow / segmentBottomRow / segmentRemainingRows / committedLogicalRows`）由 ScreenController 内部基于已知事件精确追踪，零物理估算。运行期的双向通信（query + 等 reply）会与 readline / raw mode 的 stdin 协议冲突，避开。

**不维护 fallback 路径**——双路径会重新引入架构债；检测失败时 fail-fast 报错指引用户升级终端。

### Chrome 写入永不 \n 边界外

chrome 区域在 scroll region 之外。在 chrome 区域写 `\n` 可能跳出 viewport 触发整屏滚动（DECSTBM 不保护 region 外的 `\n`）。

**纪律**：chrome 写入路径**永不发 `\n`**：
- 用 cursor positioning（`\x1b[<r>;<c>H`）切行
- 用 `\x1b[2K` 清行
- 直接写内容
- 切下一行用 cursor positioning，不用 `\n`

由 ScreenController 内部保证，调用方（chrome 渲染函数）拿到字符串数组后由 ScreenController 转为正确序列。

### Runtime 模式划分

`@zhixing/cli` 有两条写屏路径，新架构仅影响第一条：

| 路径 | Writer | ScreenController | 是否受新架构影响 |
|---|---|---|---|
| cli REPL（chrome 模式） | `createScreenWriter` | 持有 | ✓ 完全重写 |
| runOnce / 非交互 / 测试 | `createStdoutWriter`（[`cli-writer.ts:108-143`](../../../packages/cli/src/screen/cli-writer.ts)） | 不持有 | ✗ 直接 stdout，零影响 |

`createStdoutWriter` 路径不经 ScreenController，DECSTBM 不启用，`\n` 走终端默认行为。这条路径的 caller 已经显式选择"无 chrome"，与新架构正交。

### API 表层兼容性

新 ScreenController 内部状态完全替换，但 API 表层（[`screen-controller.ts:133-234`](../../../packages/cli/src/screen/screen-controller.ts) 接口）保持兼容：

| API | 新实现要点 |
|---|---|
| `attachInput(region)` | 计算 chromeHeight + 重设 DECSTBM + 画 chrome |
| `detachInput()` | 见上文 detachInput 行为 |
| `setStatusBar(lines)` | 走 chrome 高度动态协议 |
| `withScrollWrite(fn)` | enqueue 单 task：收集所有 chunks 拼接 → cursor 跳 (regionTailRow, regionTailCol) → 单次 stdout.write → 更新 regionTailRow / regionTailCol / regionFilledRows / segment viewport 位置（按 Region 滚动事件清单的通用更新公式）。**单 task 内不允许中途插入其他写入** |
| `writeScrollLine(text)` | enqueue 单 task：cursor 跳 (regionTailRow, regionTailCol) → 若 regionTailCol > 1 则前置 `\n`（独立段保证起新行）→ write text + `\n` → regionTailCol = 1 → 更新 regionTailRow / regionFilledRows / segment viewport 位置 |
| `requestInputRepaint()` | 走 chrome 高度动态协议（input.renderLines() 比较）|
| `beginReplaceableSegment()` | enqueue 单 task：若 `regionTailCol > 1`（cursor 处于行内接续位）→ 跳 (regionTailRow, regionTailCol) → write `\n`（推进 regionTailRow 1 行；若已在 scrollBottom 则按通用更新公式触发 1 次滚动同步），regionTailCol = 1，让 segment 起首必在 fresh line 起手；清 segmentTopRow / segmentBottomRow / segmentRemainingRows = null、committedLogicalRows = 0；返回 handle（首次 replace 直接走"无旧 segment、writeStartRow = regionTailRow"路径） |
| `suspend()` / `resume()` | 见上文 |
| `onSuspendChange(listener)` | 不变 |
| `dispose()` | 撤 DECSTBM + 擦 chrome + 关闭 |

调用方（cli-writer / markdown-stream / typeahead-input / status-bar / output-renderer / repl）零改动。

---

## 不在本方案

- **保留对极老终端兼容**——维护双路径（DECSTBM + 当前 freeze 物理行修复版）会重新引入架构债。声明最低终端要求是产品决策，与 zhixing 当前 ANSI 依赖范围一致
- **alt screen buffer 接管 zhixing 主体视图**——失去 scrollback 历史可见性，与产品定位（chrome 永驻 + 长对话历史）冲突。（2026-05-16 更新：仅指"zhixing 主对话流常驻 alt buffer"这条不取；commit 26fab39 起 modal alt UI 的 suspend/resume **已改为局部切 alt buffer**，main buffer 由终端原子保管 + 原子恢复，zhixing 主体仍在 main buffer，与本条不矛盾）
- **Ink / React-based 重写**——把命令式 ANSI 协议替换为声明式 React 模型是另一个架构方向，工程量超出本问题域；本方案保持命令式 ANSI 协议
- **运行期 cursor query 双向通信**——`\x1b[6n` 等 query 依赖终端即时回 reply 通过 stdin，与 readline / raw mode 协议交互复杂；启动期一次性检测可用 query（同步等待 + 超时 fail-fast），运行期改用基于已知状态追踪 + 关键事件锚定

---

## 设计落地引用

落地后的模块清单：

新增模块：
- `packages/cli/src/screen/scroll-region.ts` — 单一聚合模块，包含：
  - DECSTBM 控制 + cursor positioning + erase 原语
  - chrome 重画 + 高度动态化协议（含场景区分）
  - segment logical-row 追踪 + partial commit 协议
  - regionFilledRows / regionTailCol 等不变量维护
  - 三者强耦合（chrome 缩放联动 segment 滚动累计），合一文件减少跨文件状态协调成本
- `packages/cli/src/screen/terminal-capability.ts` — 启动期能力探测 + fail-fast（含 tmux 检测，详见风险表）

重写：
- `packages/cli/src/screen/screen-controller.ts` — API 表层保持兼容（cliWriter / segment / suspend / resume / setStatusBar / attachInput / detachInput），内部状态 + 实现完全替换；移除 tailBuffer / cursorRow / renderedRows / segmentStartRow / segmentFrozenLineCount / freezeOverflowToScrollback / paintFrame
- `packages/cli/src/screen/region-painter.ts` — 用 cursor positioning + erase 原语替代当前的 cursor up + erase line 原语
- `packages/cli/src/tui/line-width.ts` — 新增 `wrapAnsiLine(text, maxVisibleWidth, continuationPrefix?)` 工具函数；从 `text-stream.ts` 内部 ANSI-aware wrap 逻辑萃取解耦，是行宽合约能在 ANSI 染色内容上落地的必要前置
- `packages/cli/src/output/text-stream.ts` — 内部 wrap 逻辑重构为调用 `wrapAnsiLine`，消除与新工具的重复，行为不变
- `packages/cli/src/output/markdown/block-renderer.ts` — `renderList / renderListItem / renderCode / renderHeading / renderBlockquote` 加 `wrapAnsiLine`，把超宽 ANSI 染色行软折成多条窄行用 `\n` 连接，保证输出按 `\n` 切分后每段 ≤ columns - 1（"Region 写入合约"硬合约要求）。**注意**：用 `wrapAnsiLine`（ANSI 染色内容、保 SGR 自平衡）而非 `wrapToWidth`（仅纯文本，会切碎 ANSI）或 `clampLine`（截断丢内容）

调用方零改动（API 保持一致）：
- `packages/cli/src/screen/cli-writer.ts`
- `packages/cli/src/output/markdown/markdown-stream.ts`
- `packages/cli/src/output/output-renderer.ts`
- `packages/cli/src/repl.ts`
- `packages/cli/src/typeahead-input.ts`
- `packages/cli/src/status-bar/status-bar.ts`
- `packages/cli/src/security/security-event-renderer.ts`

测试基础设施：
- `packages/cli/src/screen/__tests__/` — 全部重写
- mock stdout 支持 DECSTBM + cursor positioning + erase 序列断言
- 必须覆盖：物理 wrap 行（长 list item / 长 URL / CJK 混排）、chrome 高度动态变化（input 多行 paste / panel 弹出 / status 切换）、resize、suspend/resume、alt-screen 协同、异常退出清理、segment partial commit 时的 anchor / committedRows 追踪

---

## 关键风险评估

| 风险 | 性质 | 缓解 |
|---|---|---|
| 终端不支持 DECSTBM | 产品决策 | 启动期探测 + fail-fast；最低要求覆盖目标用户群 |
| DECSTBM 区域顶行被 scroll 时推送 scrollback 是终端实现行为而非控制序列规范 | 产品决策 | 主流终端实测全部支持（xterm / xterm.js / Windows Terminal / conhost / Terminal.app / iTerm2 / tmux 非 alt-screen）；嵌入式 / 老旧终端可能不推送（scroll 出区域内容直接消失），按 fail-fast 处理（2026-05-16 更新：末句"由 suspend 协议在切 alt-screen 前撤 DECSTBM 规避"已过时——modal 期间的 alt-screen 切换由 `suspend()` 自身 emit `\x1b[?1049h`，main buffer 由终端原子保管而非撤 DECSTBM，见上文 Suspend/Resume 协议节修正） |
| tmux 嵌套时 DECSTBM 行为差异 | 产品决策 | 启动期检测 `TMUX` env；tmux 把 DECSTBM 转译给宿主终端但有少量边缘行为差异（cursor 跨 region 边界、resize 重设时机），文档化已知差异 + tmux 用户报告 bug 时按 "tmux 路径" 单独诊断 |
| notify interleave + segment 增长越过 notify | 设计约束 | erase 范围扩展（writeStartRow..max(segmentBottomRow, writeBottomRow)）保视觉清洁；notify 数据**会丢失**（与当前架构截断行为一致）——caller 若需 notify 持久应在 segment commit 后再发 |
| caller 违反"Region 写入合约"行宽硬约束 | 设计约束 | 测试基础设施加合约断言（`screen/__tests__/`）；任何 caller 输出超 columns-1 的逻辑行 → 测试失败；block-renderer / 卡片渲染等 caller 在 PR 中标注 "已 wrapAnsiLine" |
| segment 内容超 region 容量 | 设计约束 | partial commit 协议（基于 \n 在 scrollBottom 自然滚动） |
| dim / highlight 撕裂视觉债（极长 block 在 scrollback "上 dim + 下 highlight"）| 已知妥协（继承自当前架构）| 不在本方案修复范围；与 "scrollback 不可改 + segment 双态" 的根本约束相关，待后续单独议题 |
| chrome 高度动态变化时 cursor 跳跃 bug | 工程层 | 协议明确（场景区分 + 原子性） + 测试覆盖（input 多行 paste / panel 弹出 / status 切换） |
| alt-screen 切换时 DECSTBM 状态丢失 | 工程层 | （2026-05-16 更新：现状为 `suspend()` 自身 emit `\x1b[?1049h` 进 alt buffer、`resume()` emit `\x1b[?1049l` 出；`scroll-region.ts:resume()` 防御性 re-emit `\x1b[1;<scrollBottom>r` 兜底 DECSTBM 跨 buffer implementation-defined） |
| resize 时 segment 持有数据语义 | 工程层 | 不强制 commit，segment handle 保持活性；下次 replace 自然按新 scrollBottom 重写 |
| 异常退出 DECSTBM 残留影响 shell | 工程层 | process.on('exit') + 异常处理路径清理 |
| status-bar 250ms tick 触发频繁 chrome 重画 | 工程层 | 高度不变时仅刷内容，不重设 DECSTBM；重画范围限定 chrome 区域（极小） |

**架构层风险**：极低。DECSTBM 是 xterm spec 标准，主流终端实现一致；与终端物理模型对齐是消除根因，不是引入新风险。逻辑行追踪 + 行宽硬合约的组合让 segment 状态零估算依赖。

**工程层风险**：都是已知项，可系统性测试 + 消除。
