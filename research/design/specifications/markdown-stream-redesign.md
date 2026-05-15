# 规格说明：markdown-stream 流式渲染重设计

> **状态**: 待审阅 | **日期**: 2026-05-15
> **前置实证**: `packages/cli/scripts/replay-md-trace.test.ts` + `replay-md-nested.test.ts`（重放 trace 实证根因）
> **前置调研**: Claude Code / Codex / Gemini CLI / Aider / simonw-llm 五款主流 LLM CLI 的 markdown 流式渲染策略
> **关联文档**: [cli-ui-design-language](./cli-ui-design-language.md)、[screen-render-architecture](../problems/screen-render-architecture.md)
> **替换对象**: `packages/cli/src/output/markdown/markdown-stream.ts`（整体重写，状态机简化为 buffer + segment 二元）

## 目标

重设计 cli 的 markdown 流式渲染主入口 `MarkdownStream`，达到：

1. **消除"内容回填到上方"渲染错位** —— 实证现象：嵌套 list 流式期间，六章 list 内容被 replace 到五章 list 的屏幕位置；hr / heading line emit 越过未关闭的 segment 直接写出。
2. **消除可预见的同模式 bug** —— 不只是修当前两个具体 bug，要把"marked token 边界假设稳定"这个**结构性脆弱根因**整段移除。
3. **状态最少 / 不变量最强（render 主路径）** —— 把 render 模式的状态字段从 7 个降到 2 个（`buffer + segment`），emit 路径从 5 条降到 1 条（`segment.replace` / `segment.commit`）。**strip / raw 旁路**保留增量 emit 状态机（append-only sink 的本质约束决定，非妥协；详见"三档模式"段）。
4. **在 zhixing 当前 stack 约束下的最优架构** —— `marked` 是非增量 parser、`block-renderer` 输出整段 ANSI（非行级），这两个事实排除了 Codex stable/tail 双区模型在 zhixing 的可行性（详见"关键决策与权衡"）。在此约束内，"buffer + 单 segment + 整段 re-render + replace" 是状态最少、不变量最强、与平台单段约束（`ScreenController.hasActiveSegment`）天然对齐的方案。

---

## 现状与实证根因

### 当前架构的结构性债务

`MarkdownStream` 580 行实现包含 **7 个互不正交的状态字段**：

| 字段 | 语义 | 维护者 |
|---|---|---|
| `buffer` | 累积 chunk 字符 | feed |
| `paragraphForwardedTo` | 已 forward 字符末位 | emitInlineTokens / forwardBufferRange |
| `emittedBlockCount` | 已 emit 闭合 block 数 | feed 主循环 |
| `lastEmittedWasParagraph` | space token 分流用 | emitClosedBlock |
| `paragraphStream` | 当前 TextStream 实例 | forwardToParagraphStream / closeParagraphStream |
| `anchorEmittedThisStream` | ◆ 锚 turn 级语义 | forwardToParagraphStream |
| `listSegment` / `codeSegment` | 流式 segment 持有 | handleOpenList / emitClosedList 等 |

并且 **5 条 emit 路径** 互不收敛：`appendInline` / `line` / `paragraphStream.feed` / `segment.replace` / `segment.commit`。

**核心不变量假设**：
- `emittedBlockCount` 单调递增（一 block emit 一次）
- `marked.lexer(buffer)` 的 token 边界稳定（前 N-1 个 token 是 closed，末位是 open 候选）

**这两个假设被 marked 在嵌套 list 流式期的实际行为打破**。

### 实证 bug 链路

通过 `scripts/replay-md-nested.test.ts` 以 segment factory spy 重放 transcript 五/六章 fixture（chunkSize=10）得到的 GLOBAL EMIT SEQUENCE：

```
[14] seg#1 replace(122c) "…预授"        ← 五章 list segment 持有屏幕位置
[15] LINE(81c)  "╌╌╌…"                ← hr line emit
[16] LINE(17c)  "### 六、子代理并行调研"  ← 六章 heading line emit
[17] seg#1 replace(11c) "一次性派出"   ⚠ seg#1 未关，被 replace 写六章 list 内容
[18] seg#1 replace(20c) "一次性派出最多 3 个子代理"
[19] seg#1 COMMIT(30c) "…适用场景：\n"
[20] seg#2 BEGIN                        ← 六章嵌套 list 才开新段
```

**第 [17] 步即用户报告的"内容回填到上方"现象**——六章 list 内容被 replace 到五章 list 的屏幕位置。

#### Bug 1：`emitClosedBlock` heading/hr/blockquote 分支不关活跃 segment

`markdown-stream.ts:343`：

```ts
// heading / list / blockquote / hr 分支
this.closeParagraphStream();   // 只关 paragraph
const ansi = renderBlock(token, this.blockCtx);
if (ansi.length > 0) this.line(ansi);
```

没关 `listSegment` / `codeSegment` → 下一个 `handleOpenList` 看 `listSegment !== null` → 直接 replace 旧位置。

#### Bug 2：list 在 marked token 振荡下被错误"提前 commit"

chunk #6 → #7 的 token 收缩：

| chunk | buffer 末尾 | tokens | listSegment 命运 |
|---|---|---|---|
| #6 | `…\n  `（尾随缩进）| `…list(55c) + space(3c)` ← list **不再末尾** | emitClosedList → seg#0 commit |
| #7 | `…\n  - **不带 pro` | `…list(68c)` ← marked **重新合并**为同一 list | handleOpenList → seg#1 begin |

seg#0 commit 的内容（"带 prompt — 由辅助模型提取"）已固化到 scrollback；seg#1 重新渲染**含同一段 + 后续 nested item**——同一段 list **渲染两次**。

### 根本原因

`emittedBlockCount` 单调递增 + token 边界稳定 这两个假设，被 **marked 对嵌套 list 的非增量 token 化行为**打破。修一个分支不够——同模式（nested code、blockquote 嵌套、table 列重计）将来还会爆。

---

## 竞品实现总结

| 产品 | 策略 | 关键机制 | 证据 |
|---|---|---|---|
| **Claude Code** (Anthropic, 闭源) | (c) 混合 — 边流边渲 | content-hash LRU 缓存 + 流式宽容 parse → turn 末 strict 切换；按行 commit | [Ch13 逆向](https://claude-code-from-source.com/ch13-terminal-ui/) |
| **Codex CLI** (OpenAI, Rust 开源) | (c) 混合 — stable/tail 双区 | 按 newline commit + `TableHoldbackScanner` 整段 hold；pulldown-cmark 全文 parse | [`codex-rs/tui/src/markdown_stream.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/markdown_stream.rs) |
| **Gemini CLI** (Google, TS/Ink) | (a) 朴素全文 re-parse | 每 chunk re-parse；Ink `<Static>` 标记历史消息免重渲 | `MarkdownDisplay.tsx` |
| **Aider** (Python, rich) | (a) 全文重渲 + sliding window | `rich.live` + 末尾 6 行 unstable，前面 graduate 直接 print | [`aider/mdstream.py`](https://github.com/Aider-AI/aider/blob/main/aider/mdstream.py) |
| **simonw/llm** | (a) | `rich.live.Live` + `Markdown(accumulated)` 每 chunk 全文重 parse | [PR #571](https://github.com/simonw/llm/pull/571/files) |

**业界 takeaway**：
- **"边流式边渲染 markdown" 是绝对主流**
- **纯 buffer-until-end (b) 没有主流 CLI 采用** —— 我之前一度推 B（两阶段），错。
- **最常见模式 (a)**：全文 re-parse + 整段 emit，简单可靠（aider/Gemini/llm）
- **工业级 (c)**：在 (a) 基础上加 commit / holdback 控制（Codex/Claude Code），优化性能与视觉抖动

zhixing 当前架构是 **自创的 (c)**——分多个 segment + emittedBlockCount 推进——既没有 (a) 的简单可靠，也没有 (c) 工业实现的稳定边界控制。

---

## 我们的设计：buffer + 单 segment + 整段 re-render

### 总体思路

**一段 markdown 内一个 `ReplaceableSegment` 持有全部 ANSI**，feed 每 chunk 时把整段 buffer 用 `renderFullMarkdown` 重新渲染为 ANSI，然后 `segment.replace(ansi)` 整体替换。turn 闭合 `end()` 时 `segment.commit(finalAnsi)` 切到 immutable。

"一段 markdown" 的边界由 caller（`output-renderer`）控制：一个 turn 内可能存在多段 markdown 被 thinking / tool 卡片 / 子 agent 卡片中断，每段独立 begin / commit。本类不关心 turn 全局，只承担"一段 markdown 流式 → ANSI → segment.replace"的局部协议。

```
┌─────────────────────┐
│   chunk 流入        │
└──────────┬──────────┘
           │
       buffer += chunk
           │
           v
   renderFullMarkdown(buffer)  ← MarkdownStream 内部 private method
           │
           ├─ marked.lexer(buffer)           整段 re-parse
           ├─ 闭合 token → renderBlock        复用 block-renderer 纯函数
           ├─ 末位 token → 按类型双态分流      paragraph/code/list/heading/...
           └─ 第一个可见 paragraph 前嵌 ◆ 锚
           │
       segment.replace(ansi)
           │
           v
   ┌────────────────┐
   │ ScreenController│ 流式期 partial commit 由 ScrollRegion 自然处理
   └────────────────┘

       feed 重复 N 次

end() → segment.commit(renderFullMarkdown(buffer))
```

### 设计原则

1. **单不变量**：一段 markdown 一个 `ReplaceableSegment`，与平台 `ScreenController.hasActiveSegment` 单段约束天然对齐。不存在多 segment 切换错位（消除 Bug 1 整类）。
2. **状态最少**：`buffer` + `segment` 两个字段，无其他状态。
3. **emit 路径单一**：`segment.replace` 流式期 + `segment.commit` 闭合期。不存在 5 条路径互不收敛。
4. **与 marked 行为脱钩**：黑盒输入字符 → 输出 ANSI；不依赖 token 边界稳定（消除 Bug 2 整类）。
5. **现有 hold 契约保留**：`segment.replace` 是覆盖整段而非 append-only forward，所有末尾未闭合 token 的 hold 契约（heading / hr / blockquote / paragraph 末位 inline）**完整保留**——不引入"字面 markdown 标记暴露"的视觉退化。
6. **◆ 锚归属上提**：从 `TextStream firstLinePrefix` 上提到 `renderFullMarkdown` 内嵌定位，由 buffer 内容动态判定，无跨 chunk 状态字段。

### 架构位置

```
packages/cli/src/output/markdown/
├── markdown-stream.ts          # ← 重写：状态机简化为 buffer + segment 二元
├── block-renderer.ts           # 复用纯函数 renderBlock / formatStreamingCode
├── inline-renderer.ts          # 复用
└── types.ts                    # 复用
```

`renderFullMarkdown` 是 `MarkdownStream` 的 private method，**不**独立成文件 —— 它只是 "for token in tokens: ansi += renderBlock(token)" 的薄循环 + ◆ 锚 prefix + 末尾未闭合 token 的双态选择，单独成文件只增加模块边界债务。

### 接口契约

```typescript
import type { MarkdownMode } from "./types.js"; // "render" | "strip" | "raw"

export interface MarkdownStreamOptions {
  /** caller 注入的字面 forward 通道 —— strip / raw 模式使用（render 模式不经此
   *  路径）。本字段是 markdown-stream 作为 markdown 渲染**单一入口**的契约组件，
   *  让三档模式都从同一 API 进入，caller 不必感知模式差异。 */
  readonly appendInline: (chunk: string) => void;

  /** ReplaceableSegment 工厂。**render 模式必须注入** —— 整段一 segment 模型
   *  的核心依赖。strip / raw 模式可不注入（不进入 segment 路径）。 */
  readonly beginReplaceableSegment?: () => ReplaceableSegmentHandle;

  /** 终端列宽 —— 传给 block-renderer / inline-renderer wrap 计算。 */
  readonly columns: number;

  /** 三档模式。默认 render。 */
  readonly mode?: MarkdownMode;
}

export class MarkdownStream {
  constructor(options: MarkdownStreamOptions);

  /** 累积 chunk：
   *   - render: 整段 re-render → segment.replace（覆盖整段，append-only 不受约束）
   *   - strip:  走 block-renderer + inline-renderer 的 strip 路径（保留 block 结构、
   *             去除 ANSI 染色）+ **增量 appendInline forward**（append-only，不可
   *             整段重 emit，与 render 模型独立）
   *   - raw:    appendInline(chunk) 原文转发，不解析 */
  feed(chunk: string): void;

  /** 闭合：render 模式 segment.commit 最终 ANSI；strip / raw 模式 appendInline
   *  末尾 \n 收口。 */
  end(): void;
}
```

**三档模式（单一入口分发）**：MarkdownStream 是 markdown 渲染的**单一入口**。三档模式由本类内部分发，**早返回简单路径**，不耦合 render 主状态机：

- **render**（默认，TTY 完整渲染）：进入"buffer + 单 segment + 整段 re-render"主路径，要求注入 `beginReplaceableSegment`。状态字段简化为 `buffer + segment` 二态
- **strip**（CI / pipe / 日志）：**保留当前增量 emit 状态机**（`emittedBlockCount` / `paragraphForwardedTo` / `lastEmittedWasParagraph` 等），调 `renderBlock(token, ctx with mode=strip)` + `renderInline(token, strip)` 获得保留 block 结构（hashes / markers / 缩进 / wrap）但无 ANSI 染色的输出，经 `appendInline` 增量 forward。链接退化为 `text (url)`；不进入 segment。**与 render 模式状态机模型独立**——append-only 路径不可整段 re-render
- **raw**（调试）：`appendInline(chunk)` 原文转发，不解析

把三档保留在单一入口、不让 caller 分发，是单一职责的正确解读 —— **"markdown 渲染入口"是单一职责；三档是入口形态而非状态机分叉**。caller（`output-renderer`）只需透传 `markdownMode`，不感知实现细节。

**两套独立状态机的边界声明**：本类内部 render 主路径与 strip 旁路是两套状态机，**仅共享 `buffer` 累积** + `marked.lexer` 结果。render 用 `segment` 二态，strip 用 7 字段增量 emit 状态机；两者通过 `feed()` 入口的 `mode` 分流，**互不耦合**。架构简化（状态字段 7→2）承诺仅适用于 render 主路径——这是 segment.replace 覆盖整段 vs appendInline append-only 两种 sink 模型的本质差异决定的，**不是设计妥协**。

**与当前接口的差异**：
- 去掉 `line` callback —— render 模式闭合 block 不再走 `caller.line(ansi)` 独立段路径，全部经 `segment.replace` / `segment.commit`；strip / raw 模式仍走 `appendInline`
- 去掉 `paragraphStream` 抽象 —— ◆ 锚由 `renderFullMarkdown` 直接嵌入 ANSI 起首（详见"◆ 锚归属"）

### `renderFullMarkdown` 私有 method 契约

```typescript
class MarkdownStream {
  private renderFullMarkdown(buffer: string): string;
}
```

**职责**：纯函数（仅依赖 buffer + 构造时确定的 columns），相同 buffer → 相同 ANSI。

**算法**：
1. `tokens = marked.lexer(buffer)`
2. 遍历 tokens：
   - **paragraph token**（不论闭合或末位）：调 `renderParagraph(token, ctx, paragraphPrefix, isOpen)` —— `paragraphPrefix` 区分首行 prefix（含 ◆ 锚或 indent）与续行 hanging prefix；`isOpen` 在 paragraph 是末位 token 时传 `true`（renderParagraph 内部据此 hold 末位 inline），其他情况传 `false`（全部 inline 渲染）。详见下方"`renderParagraph` 签名扩展"
   - 其他闭合 token：调 `renderBlock(token, ctx)` 拼接 ANSI
   - 其他末位 token **按类型分流**（见下"末尾未闭合 token 处理"）
3. ◆ 锚位置由"第一个可见 paragraph"决定，通过给该 paragraph 的 `paragraphPrefix.firstLinePrefix` 注入 `${layout.contentPrefix}${aiTextAnchor()} `；后续 paragraph 的 `firstLinePrefix` 退化为 `TEXT_STREAM_HANGING_PREFIX`（4 空格，无 ◆，与续行视觉对齐）

### `renderParagraph` 签名扩展（block-renderer 唯一改动）

当前 `renderBlock(paragraph)` 走通用 `indentAndWrapLine` 路径，**起首 prefix 与续行 prefix 同为 `lineIndent(0) = PREFIX = "  "`（列 2）**——这与 paragraph 流的视觉契约不一致（paragraph 应当起首列 4 含 ◆ 锚或 indent，续行列 4 hanging，与 TextStream `text-stream.ts:32, 46` 锁定的契约对齐）。

扩展签名：

```typescript
export function renderParagraph(
  t: Tokens.Paragraph,
  ctx: RenderContext,
  paragraphPrefix: {
    /** 首行 prefix —— ◆ 锚段为 "  ◆ "（列 4），续段为 TEXT_STREAM_HANGING_PREFIX（4 空格） */
    readonly firstLinePrefix: string;
    /** 续行 prefix —— 恒为 TEXT_STREAM_HANGING_PREFIX（4 空格，与首行 prefix 同宽对齐） */
    readonly continuationPrefix: string;
  },
  /** 末位未闭合 paragraph 调用时为 true —— renderParagraph 内部循环 t.tokens 时
   *  跳过末位 inline 不渲染（保留当前 `emitInlineTokens(isOpen=true)` 的 hold 契约：
   *  `**bo` 期间末位 inline 不输出，闭合后才切到 ANSI bold）。inline-renderer 不
   *  改，hold 逻辑内嵌于 renderParagraph 自身循环。 */
  isOpen: boolean,
): string;
```

实现要点（替换当前 `indentAndWrapLine` 单 prefix 路径）：
- 内部循环 `t.tokens`：`isOpen` 时跳过末位 inline 不渲染（保留 hold 契约）；闭合时全部 inline 渲染
- 首行用 `firstLinePrefix` + `wrapAnsiLine(line, budget, { continuationPrefix })`，wrap budget 按续行 prefix 宽度算（最严格）
- 后续 softbreak / wrap 续行用 `continuationPrefix`
- SGR 跨续行状态延续由 `wrapAnsiLine` 现有逻辑保证（已实现 SGR reset + re-apply）
- inline 渲染调 `renderInline(token, mode)`（inline-renderer 不动），hold 逻辑在 renderParagraph 自身循环层处理

**与 TextStream 视觉契约完全对齐** —— TextStream 在重设计后不再被 markdown-stream 调用，但其视觉契约（4 列起首 / 4 列续行 / SGR 跨 wrap 状态保持）由扩展后的 `renderParagraph` 完整接管。

**回归屏障**：现有 `renderParagraph` 调用方仅 markdown-stream（含 list_item 嵌套 paragraph 通过 `renderListItem` 路径，但 list_item 自带 marker 续行系统，**不调 `renderParagraph` 而是直接处理 inline tokens**）。扩展签名为新参数对象，**不破坏 list_item 渲染**；block-renderer 自身测试矩阵需要补 paragraph hanging 视觉断言。

**末尾未闭合 token 处理**（关键 — 决定流式视觉契约）：

| 末位 token 类型 | 处理 | 视觉 |
|---|---|---|
| `paragraph` | 调 `renderParagraph(token, ctx, paragraphPrefix, isOpen=true)` —— renderParagraph 内部按 isOpen 在末位 inline 停止渲染（前 N-1 个闭合 inline 正常 ANSI emit，末位未闭合 inline hold 不输出） | 与当前 `emitInlineTokens(isOpen=true)` 契约一致。`**bo` 期间末位 inline hold 不出现字面 `**bo`，闭合后才切到 ANSI bold |
| `code` (fenced + lang) | 检测 `token.raw` 末位是否含闭合 ```` ``` ````；未闭合走 `formatStreamingCode(token.text)`（dim 字面占位），闭合走 `renderBlock`（cli-highlight 高亮） | 与当前 code block 双态契约一致 |
| `code` (无 lang / indented) | 走 `formatStreamingCode` dim 占位直到 EOF；end() 时根据闭合状态决定 | 与当前 hold 退化一致 |
| `list` | 调 `renderBlock(list, ctx)` 整段渲染 | 末尾 item 已被 marked 解析进 list.items；replace 模式覆盖整段无 forward 不可撤回问题 |
| `heading` / `blockquote` / `hr` | hold（不渲染） | 与当前 hold 契约一致。字面 markdown 标记（`#` / `>` / `---`）不暴露；下次 chunk 闭合后整段切 ANSI |
| `space` | 跳过 | 段间分隔由前后 block 的 envelope 提供 |

**关键不变量**：因为 `segment.replace(ansi)` 是覆盖整段，**任何末位 token 的"字面 → ANSI"切换都无残留** —— 不存在 append-only 模式下的"已 forward 不可撤回"约束。所有现有 hold 契约（heading / blockquote / hr / paragraph 末位 inline）都**保留**。

**硬不变量 — 行数单调性**（与 ScrollRegion 契约的承接面）：

`ScrollRegion.replaceSegment` 的硬约束（`scroll-region.ts:437-446`）：

```ts
if (M < this.committedLogicalRows) {
  throw new Error("newText has M rows, shorter than already-committed ...");
}
```

→ 长 markdown 段超 region capacity 触发 partial commit 后，**后续每次 `segment.replace(newText)` 的 newText 行数必须 ≥ 已固化行数**。违反则运行时抛错。

**`renderFullMarkdown` 必须保证**：对单调追加 buffer 序列（`buffer_{n+1} = buffer_n + chunk`），输出 ANSI 行数单调非减少（`countNewlines(ansi_{n+1}) ≥ countNewlines(ansi_n)`）。

**算法层面保证机制**：
- 已闭合 block 的渲染**永不缩**：`renderBlock` 是纯函数；marked 对已闭合 block 的 `token.raw` 边界稳定（lexer 重 parse 不改变前序闭合 block 的 raw 长度，振荡仅发生在末位 token）
- 末位 token "hold → 渲染" 行数单调：未闭合 paragraph / heading / hr / blockquote 输出 0 行 → 闭合后输出 ≥ 1 行；末位 code 流式期 `formatStreamingCode` 输出行数 = `token.text` 行数，闭合后 cli-highlight 不增减物理行数
- ANSI escape 不计显示列宽（`wrapAnsiLine` 已处理），inline 元素 ANSI 化不会让 wrap 边界变化导致行数减少
- `space` token 跳过不产出，前后 block envelope 提供分隔 —— 段间不产生瞬时空行抖动

**实施约束**：Phase 1 必须含**行数单调性专项测试矩阵**，覆盖典型负载 + 嵌套 list + token 振荡 fixture，断言每 chunk 边界 `ansi_n.split("\n").length` 单调非减。任何违反此不变量的边缘 case **必须在 `renderFullMarkdown` 内部消化**（如末位 token 渲染高度短暂下降时用前次 ANSI 兜底），不让违反 ANSI 传到 `segment.replace`。

### ◆ 锚归属

当前架构 ◆ 锚由 `TextStream firstLinePrefix` 注入，markdown-stream 实例内首次创建 paragraph stream 时 emit；同实例内后续 paragraph stream 重建（被 list / heading / code 中断后）传 hanging 4 空格无 ◆，实现"一段 markdown 至多一个 ◆"。

重设计后 ◆ 锚归属转移到 `renderFullMarkdown` 内嵌处理：

- 遍历 tokens 时，找到**第一个可见 paragraph 或 inline 段**的位置，在该位置 ANSI 起首前插入 `${layout.contentPrefix}${aiTextAnchor()} ` prefix
- 如果整 buffer 起首是 heading / code block / list / hr / blockquote 等独立 block 且**未出现 paragraph**，◆ 锚不出现；后续若出现 paragraph，◆ 锚在该 paragraph 起首插入
- 因为一段 markdown 一 segment 一次性 replace，◆ 锚位置随 buffer 内容动态判定 —— 不需要任何跨 chunk 状态字段

**一段 markdown 至多一个 ◆ 锚** —— 由 `renderFullMarkdown` 内嵌算法保证：单次 buffer 渲染最多产生一个 ◆。

**turn 维度的 ◆ 锚不变量**与当前架构一致：一个 turn 可能因 thinking / tool 卡片中断产生多段 markdown，每段独立持有一个 `MarkdownStream` 实例，**每段开头都有 ◆**。"一个 turn 一个 ◆" 不是 markdown-stream 的责任，未来若需 turn 级唯一性，应在 caller 层（`output-renderer`）维护 turn 状态注入 prefix override，不污染本类。

`aiTextAnchor()` 是无状态纯函数（`speaker-state.ts:37` 返回 `chalk.white("◆")`），多次调用结果一致。

### 视觉契约

| 场景 | 行为 |
|---|---|
| 流式期 | segment.replace 每 chunk 整段 ANSI；用户看到内容增量累积 |
| 长 turn 超 region capacity | ScrollRegion 自然 partial commit（已知行为，与当前 codeSegment / listSegment 长 block 同语义） |
| turn 闭合 | segment.commit(final ANSI) 切到 immutable，写入 scrollback |
| strip / raw 模式（或 render 模式但未注入 segment factory）| 走 `appendInline` 字面 forward 路径，不进入 segment 主路径；strip 模式经 `inline-renderer` strip 处理，raw 模式原文转发 |
| ◆ 锚 | 一段 buffer 至多一次，位置在第一个可见 paragraph / inline 段的起首 col 2 |
| paragraph 续行（softbreak / wrap）| **hanging 4 空格**（列 4，与 ◆ 锚之后内容对齐），由扩展的 `renderParagraph(token, ctx, { firstLinePrefix, continuationPrefix })` 接管 —— 与 `text-stream.ts:46` `TEXT_STREAM_HANGING_PREFIX` 视觉契约完全对齐 |
| 多段 paragraph 之间 | 中间 \\n\\n 段落分隔（视觉 1 空行）；后续 paragraph 的 `firstLinePrefix` 退化为 hanging 4（无 ◆），首行与续行同列对齐 |
| 末尾未闭合 paragraph inline | **hold 不渲染**（`**bo` 期间不显示）—— 闭合后整段 replace 切到 ANSI bold，视觉无字面暴露 |
| 末尾未闭合 heading / hr / blockquote | hold 不渲染 |
| 末尾未闭合 fenced code block | dim 字面占位（`formatStreamingCode`）—— 闭合后整段 replace 切到 cli-highlight |
| 末尾未闭合 list | 整段 `renderBlock(list)` 渲染（含末位 item） —— replace 覆盖整段，扩展时无错位 |

**关键事实**：`segment.replace` 是覆盖整段，**所有"字面 → ANSI"切换无残留** —— 不需要妥协任何现有 hold 契约。

**视觉刷新感知**：`ScrollRegion.replaceSegment` 内部实现是 "行级 erase + 整段重画"（`scroll-region.ts:466-494` `replaceSegmentNormal`），每 chunk 触发 segment 区域刷新。当前架构在 list / code 双态 segment 上已是此行为，用户接受；重设计后整段 markdown 一 segment，刷新区域比单 list 更大，**用户感知可能从"字符接续打字"转为"段级刷新"**。aider / Gemini CLI / simonw-llm 在生产环境长期运行此模式，业内可接受范围内。

---

## 关键决策与权衡

### 方案对照

| 方案 | 性质 | 评估 |
|---|---|---|
| A（修两 bug） | 局部 patch | 同模式 bug 未来还会爆（nested code / blockquote 嵌套 / table 等）；违背"避免架构债务"原则 |
| D（A + 启发式嵌套检测） | 启发式补丁 | "list 含 nested 退化 hold" 是脆弱启发式，新债务 |
| 方案 B（buffer-until-end 两阶段） | 撤销 | 行业 fact 调研显示主流 CLI **无人采用**；视觉代价大（流式期纯文本无样式） |
| 方案 F（Codex stable/tail 双区） | 行业工业级 | **见下方"为什么 zhixing 不走方案 F"** |
| **本设计（buffer + 单 segment + 整段 re-render）** | **重设计** | zhixing stack 约束下的最优；状态最少、不变量最强、当前 bug 整类消除 |

### 为什么 zhixing 不走方案 F（Codex stable/tail）

Codex stable/tail 在 Rust + pulldown-cmark 上是行业最优，但 **zhixing 当前 stack 直接套用并不能落地**，原因是 stack 层面的实际约束：

| 约束 | 现状 | 对 stable/tail 的影响 |
|---|---|---|
| **parser 性质** | `marked` 是非增量 parser，每次 `lexer(buffer)` 重 parse；嵌套 list 时 token 边界不稳（实证：chunk #6→#7 list 边界振荡） | stable/tail 需要"看到 newline 即可 commit 该行"的稳定性 —— marked 对 list / blockquote 内的换行不提供这种稳定边界 |
| **renderer 粒度** | `block-renderer.renderBlock` 输出**整段 ANSI**（含起首/末尾 envelope），非行级；list_item / blockquote 内部递归调 renderBlock 仍是块级 | stable region 需要"逐行 ANSI 可分"，与现有 block-renderer 输出形态不兼容；要切 stable/tail 必须重写 block-renderer 为行级 emitter |
| **保守稳定边界判定的退化** | 在 marked 限制下，"安全 stable 边界"实际只能在 token 完全脱离任何 list / code / blockquote / table 上下文时成立 | 含 list / code / blockquote / table 的整段 markdown（最常见的 LLM 回复形态）**全部进 tail**，stable region 几乎不被填充 —— stable/tail 退化为"单段 hold"，与本设计等价但多一层抽象 |

**结论**：方案 F 在 Rust + pulldown-cmark 上是最优，因为 pulldown-cmark 是 streaming-friendly + Codex 自己写的 line-level renderer。zhixing 用 marked + 块级 renderer，套用 stable/tail 仅能得到形似神不似的实现，**徒增复杂度而不能拿到 Codex 真正的好处**。

未来若 zhixing 切换到 streaming-friendly parser（pulldown-cmark WASM / `thetarnav/streaming-markdown` 等）+ 行级 renderer 重写，方案 F 才具备落地条件。本 spec **不预设此路径，但接口设计不阻碍未来升级**（`buffer + segment` 二元抽象向上扩展到 `stable + tail` 二区是一次性重构，不破坏 caller 协议）。

### 性能评估

`MarkdownStream` 每 chunk 做的工作：`marked.lexer(buffer)` 全文 re-parse + `renderFullMarkdown(buffer)` 全文 ANSI 渲染 + `segment.replace(ansi)`。

**性能风险点**：
- marked.lexer 本身快（~1000+ tokens/ms），不是瓶颈
- block-renderer 内部 `cli-highlight`（fenced code block 高亮）对 **未闭合 code block 的每 chunk 重复高亮**可能成为热点 —— 末位 code block 未闭合时走 `formatStreamingCode`（dim 纯字面）避开此问题，**只在闭合那一刻调一次 cli-highlight**
- inline-renderer 的 ANSI 染色对长 buffer 是线性成本

**phase 0 强制量化**：实施前用 50 行 prototype 跑典型负载（5000 字符 markdown × 200 chunks，基于 `pid 5728` dump 的真实 chunk 节奏），测累计 CPU。决策门槛：
- 累计 < 500ms → 本设计直接落地，**不引入缓存层**
- 累计 ≥ 500ms → 接口不变，落地时**内嵌 content-hash LRU 缓存**（Claude Code 模式）：相同 buffer 重 render 命中 cache 直接返 ANSI

LRU 缓存作为**实现细节内嵌于 `renderFullMarkdown`**，不暴露给接口；是否启用由 phase 0 实测决定，不预设排除也不预设启用。

### 视觉撕裂

ScrollRegion partial commit 已知行为：长 segment 超 region capacity 时前部被推到 scrollback。当前架构已有此行为（codeSegment / listSegment 同样）。本设计**不引入新撕裂**——反而比当前更一致，因为一段 markdown 一个 segment，撕裂点只可能出现在 region capacity 边界，不会在 block 切换处。

### 与 SegmentHandle 接口的关系

ReplaceableSegmentHandle 接口（`screen-controller.ts:155`）无需变更：
- `replace(newText)` — 流式期使用，行宽合约由 `renderFullMarkdown` 内部保证
- `commit(newText)` — turn 闭合切 immutable
- `close()` — reset / 异常路径

---

## 测试覆盖矩阵

### 保留并需重新通过（行为契约）

| 既有 describe | it 数 | 重设计后预期 |
|---|---|---|
| 段落字符流式 | 7 | 全 pass（含 ◆ 锚一段至多一次、段内多 paragraph 不重起 ◆） |
| 闭合 block 处理 | 5 | 全 pass（heading hash 前缀、code dim、list 中点、blockquote dim、hr 虚线） |
| 流式跨 chunk 边界 | 5 | 全 pass（code/heading/list/blockquote/paragraph hold case） |
| 三档模式 | 2 | 全 pass（strip / raw 走 `appendInline` 直接 forward 早返回分支；render 走 segment 主路径） |
| 边缘场景 | 3 | 全 pass |
| space token 塌缩归一化 | 5 | 全 pass（多空行塌缩为单空行）|
| 段落分隔对称性 | 15 | 全 pass |
| paragraph inline ANSI | 7 | 全 pass（bold / italic / codespan / link / del / mixed / 跨 chunk） |
| code block 双态 | ? | 全 pass：未闭合走 `formatStreamingCode` dim，闭合那一刻 segment.replace 切到 cli-highlight ANSI |
| list 流式（ReplaceableSegment 复用） | ? | **断言重写**：旧"list 用独立 segment + 多次 begin" 行为不再成立；重写为"单 segment 内 list 区段每 chunk 整段 re-render，replace 覆盖"。原 it 表达的视觉契约（长 list 流式期可见）保留 |
| table（hold 等闭合） | ? | 全 pass |

### 新增（重设计专属）

| 主题 | 关键 it |
|---|---|
| 单 segment 不变量 | `feed × N + end → 一段 markdown 内 begin 1 次、commit 1 次、replace N 次` |
| 末尾未闭合 inline hold（保留契约）| `feed("**bo") → segment.replace 的 ANSI **不含** "**bo" 字面；后续 feed("ld**") 闭合后 ANSI 含 chalk.bold("bold")` |
| 末尾未闭合 heading hold | `feed("## ti") → ANSI 不含 "## ti" 字面；闭合后整段切 ANSI |
| 末尾未闭合 code 双态 | 未闭合时 ANSI 含 dim 字面，闭合那一刻 ANSI 切 cli-highlight，整段 segment.replace |
| ◆ 锚定位 | buffer 起首 paragraph → ANSI 起首含 ◆；buffer 起首 heading → ANSI 起首不含 ◆；先 heading 再 paragraph → ◆ 出现在 paragraph 起首 |
| `renderFullMarkdown` 纯函数 | 相同 buffer 多次调用结果完全一致；同一 buffer 经 feed 分多次累积 vs 一次注入产生**相同最终 ANSI** |
| **行数单调性（P1 硬不变量）** | 给定单调追加 buffer 序列，每次 `renderFullMarkdown(buffer_n)` 输出 ANSI 行数 ≥ 上次。覆盖矩阵：典型 markdown（paragraph + heading + hr）/ 嵌套 list（chunk 振荡场景）/ paragraph 末位 inline 闭合切换 / code block 流式期 → 闭合切换 / 长 turn 触发 partial commit 后的后续 chunk |
| **paragraph 续行 hanging 4**（视觉契约）| `feed("a".repeat(200))` 在 columns=80 下触发 wrap → ANSI 含 `\n    `（4 空格 hanging）续行 prefix，不出现 `\n  `（列 2）续行；softbreak `feed("line1\\nline2")` → 续行也是 `\n    `；SGR 跨 wrap 续行 reset + re-apply 保持视觉染色（与 `text-stream.test.ts:252-270` 同契约）|
| **多段 paragraph 首行 prefix 退化**（视觉契约）| `feed("段1\\n\\n段2\\n\\n段3")` → 段 1 首行 `"  ◆ "`（含锚），段 2 / 段 3 首行 `"    "`（hanging 4 无锚）；三段共享 1 个 ◆；分隔行视觉单空行 |

### 必修 reproducer

| 现有 reproducer | 必须 pass |
|---|---|
| `REPRODUCER · 嵌套 list 触发乱序`（chunkSize 1/3/5/10/20/50/100） | 全 chunkSize pass |
| `scripts/replay-md-nested.test.ts` Phase 1 fixture | hold-path + segment-path 双路径都不再出现 missing |
| 真实 dump 重放（pid 5728 TURN 2 fixture）| 单 markdown 段内 ◆ 锚仅 1 次、所有 list / paragraph 完整无缺、segment 事件序列单调（begin 1 + replace N + commit 1） |

---

## 实施计划

每 phase 完成后跑 `pnpm --filter @zhixing/cli test` 全量回归，不通过不进下一 phase；每 phase 结束 commit 一次，PR 阶段按 phase 拆 commit 便于 review。

| Phase | 内容 | 决策门槛 |
|---|---|---|
| **0** | **性能量化 prototype** —— 50 行 standalone 脚本，按典型负载（5000 字符 markdown × 200 chunks，基于 `pid 5728` dump 的真实 chunk 节奏）实测 `marked.lexer + renderFullMarkdown` 累计 CPU 时间 | 累计 < 500ms → 进 phase 1（不加缓存）；累计 ≥ 500ms → 进 phase 1（`renderFullMarkdown` 内嵌 content-hash LRU 缓存） |
| 1 | `MarkdownStream` 重写：`buffer + segment` 二态 + `renderFullMarkdown` private method（含 7 种末尾 token 双态分流）+ ◆ 锚定位算法 | 类自身单元测试全 pass（含 phase 0 决定的缓存开关） |
| 2 | `output-renderer.ts` caller 接口收紧：**仅删除 `line` callback 注入**（render 模式闭合 block 不再走 `caller.line(ansi)` 独立段路径，全部经 `segment.replace` / `segment.commit`）；`appendInline` 仍注入（strip / raw 模式使用）；`mode` / `segFactory` / `columns` 透传不变。caller wire 改动 < 5 行 | output-renderer 既有测试 pass |
| 3 | 现有 95 个 markdown-stream 测试套件适配 + list 流式 describe 重写 | 全 95 个 it pass |
| 4 | `REPRODUCER · 嵌套 list 触发乱序` 全 chunkSize（1/3/5/10/20/50/100）pass + `scripts/replay-md-nested.test.ts` 双路径全 chunkSize 无 missing | reproducer 全 pass |
| 5 | rebuild dist + 真实 cli 实测（pid 5728 fixture 同形 markdown + 用户 5/12 截图同形 fixture + 别的常见形态如纯 paragraph / 纯 code / 长 list 等） | 实测无视觉错位、◆ 锚 turn 唯一、性能感知正常 |

---

## 不在 scope 内

- **不重设计 `ScrollRegion` partial commit** —— 与本 spec 独立，已知行为保留
- **`block-renderer.ts` / `inline-renderer.ts` 复用纯渲染 helper** —— 唯一例外：`renderParagraph` 扩展签名补 hanging 续行能力（详见下方"`renderParagraph` 签名扩展"），其他 renderer（heading / code / list / blockquote / hr / table）保持不变；`inline-renderer` 完全不动
- **不改 `ReplaceableSegmentHandle` 接口** —— 当前 begin/replace/commit/close 协议够用
- **不改 `TextStream`** —— ◆ 锚归属上移到 `renderFullMarkdown` 后，render 模式不再依赖 TextStream；strip / raw 模式直接 `appendInline` 字面 forward，也不依赖 TextStream。**TextStream 在本 spec 后实际成为孤儿模块**（除测试外无 import），独立清理评估由后续 PR 处理 —— 本 spec 内保留其代码不动，避免边界蔓延

**带条件 / 内嵌**（不是预设排除，由 phase 0 量化或未来 stack 升级触发）：

- content-hash LRU 缓存：由 phase 0 实测决定是否内嵌于 `renderFullMarkdown`，**不暴露给接口**
- Codex stable/tail 双区：当前 stack（marked + 块级 block-renderer）不适合落地（详见"为什么 zhixing 不走方案 F"）；未来 stack 升级到 streaming-friendly parser + 行级 renderer 后方可重构，本 spec 接口不阻碍此路径

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 全文 re-parse + ANSI 渲染性能不可接受 | Phase 0 强制量化决定是否内嵌 content-hash LRU 缓存；接口设计与缓存解耦，缓存为实现细节 |
| ◆ 锚定位算法在边缘 buffer 上出错（如首 token 是空 paragraph、混合 block 顺序异常） | Phase 1 含 ◆ 锚定位专项 it 矩阵覆盖（buffer 起首 6 种 token 类型 × 是否后续出现 paragraph） |
| 流式期视觉撕裂（长 segment 超 region capacity） | 已知 ScrollRegion partial commit 行为，与当前架构同等；单 segment 比当前多 segment 切换更一致 |
| caller 适配影响 | Phase 2 独立 commit；改动仅"删除 `line` callback 注入"一处；`mode` / `appendInline` / `segFactory` / `columns` 透传保持，caller wire 改动 < 5 行 |
| code block 闭合时 cli-highlight 大段同步调用阻塞 | 未闭合期走 `formatStreamingCode` dim 字面占位（无高亮成本），cli-highlight 只在闭合那一刻调用一次；与当前架构等价 |
| **P1：行数单调性违反触发 `ScrollRegion.replaceSegment` 抛错** | `renderFullMarkdown` 算法保证已闭合 block 永不缩 + 末位 token "hold → 渲染" 单调；Phase 1 强制添加行数单调性专项测试矩阵；任何边缘 case 必须在 `renderFullMarkdown` 内消化（如用前次 ANSI 兜底），不让违反 ANSI 传到 `segment.replace` |

---

## 沉淀引用

- 实证 trace 文件：`packages/cli/scripts/replay-md-trace.test.ts` / `replay-md-nested.test.ts`（重设计完成后可删除或转 spec 测试）
- 实证 trace 输出：`packages/cli/scripts/replay-trace-output.log` / `replay-nested-*.log`（同上）
- 真实 chunk dump：`~/.zhixing/logs/llm-raw/llm-raw-5728-2026-05-15T04-31-38-103Z.log`
- 行业调研结果：见上方"竞品实现总结"段引用链接

---

## 决策状态

- [x] 现状根因实证（Bug 1 + Bug 2 链路）
- [x] 行业 fact 调研（5 款产品）
- [x] zhixing stack 约束分析（marked 非增量 parser + 块级 block-renderer → 排除方案 F）
- [x] 方案对照与决策（本设计 vs A/D/B/F）
- [ ] **本 spec 审阅 + 拍板** ← 当前
- [ ] Phase 0 性能量化 prototype
- [ ] Phase 1 实施
