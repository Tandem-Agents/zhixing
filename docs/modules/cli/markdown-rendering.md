# Markdown 流式渲染

本文负责模型文本到终端内容的流式转换、模式差异与段生命周期；屏幕几何和回卷合同见[屏幕渲染](screen-rendering.md)，符号及视觉基准见[视觉设计语言](visual-language.md)。目标是流式内容可读、不重复、不回填错位，同时保持正文完整。

## 架构与理由

生产链为 `OutputRenderer → MarkdownStream → block／inline renderer → ReplaceableSegmentHandle → ScreenController／ScrollRegion`。输出渲染器决定文本段边界；一次 turn 可被思考或工具展示分成多段，不能把“一段一个 segment”写成“一次 turn 一个 segment”。

旧实现同时推进已输出 token 计数、段落追加及 list／code 独立段：未关闭段时写出后续标题会错用旧位置；嵌套列表的 token 在后续 chunk 中重新合并，又会重复输出已提交内容。**解析器当前 token 边界不能作为不可改变的提交边界。**

| 方案 | 本模块取舍 |
|---|---|
| 修补旧分支或用列表特征猜稳定边界 | 无法可靠解决非增量解析下的边界变化；render 主路径不继续维护多条提前提交路径 |
| 全部等到结束再渲染 | 降低流式可读性，不作为主路径；局部未闭合语法仍可暂缓呈现 |
| 已稳定区＋活动尾区 | 需要可信的稳定边界与匹配的输出粒度；当前 marked 重解析和块级 renderer 不能靠增加一个区域就获得这些保证，不宣称该方案本身不可行 |
| 整段重解析＋单活动段 | 当前 render 路径采用，统一替换出口，降低段间协调；代价是重复解析／绘制成本，以及回卷后前缀不可改写 |

性能优化应基于实际瓶颈。当前没有 content-hash LRU；流式段增长会重复处理累积内容，已经闭合的代码块也可能再次高亮。

### 选型参考：解析与提交策略

2026-05-15 的研究比较了以下五种实现，用于判断流式解析、历史提交与活动段的责任边界。材料未锁定版本；Claude Code 来自第三方逆向，其他条目也不代表产品最新版，不能据此作性能排名。

| 参考对象 | 研究记录的机制 | 对本模块选择的启示 | 材料定位 |
|---|---|---|---|
| Claude Code | content-hash LRU、流式宽容解析、结束时严格解析及按行提交 | 缓存与提交边界是独立机制，不能仅增加缓存就解决错位 | [第三方逆向 Ch13](https://claude-code-from-source.com/ch13-terminal-ui/) |
| Codex CLI | stable／tail 双区，按换行提交，TableHoldbackScanner 暂缓表格，pulldown-cmark 全文解析 | 全文解析可与分区提交共存，但必须有匹配的输出粒度和暂缓规则 | [markdown_stream.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/markdown_stream.rs) |
| Gemini CLI | 每个 chunk 重解析，Ink Static 避免重绘历史消息 | 消息级历史固化与当前消息的解析方式不是同一件事 | `MarkdownDisplay.tsx`；研究未记录完整路径 |
| Aider | rich.live 全文重渲，保留末尾 6 行为活动窗口，前缀直接输出 | 限制重绘范围需要明确前缀何时可固化；窗口大小不是通用稳定性证明 | [mdstream.py](https://github.com/Aider-AI/aider/blob/main/aider/mdstream.py) |
| simonw/llm | rich.live.Live 配合 Markdown(accumulated) 重解析累积文本 | 累积重解析提供直接的流式模型，仍有重复解析与重绘成本 | [PR #571](https://github.com/simonw/llm/pull/571/files) |

这些方案都在输出过程中渲染，而不是一律等到结束；差异在历史何时固化、活动内容如何更新。知行采用整段重解析与单活动段，是因为 marked 的临时 token 边界不可靠，而现有 renderer 输出块级 ANSI；不能直接照搬按行提交，也不需要为此预建缓存或双区框架。

## 三种模式

| 模式 | 当前机制与边界 |
|---|---|
| render | 累积 buffer，重新解析并生成 ANSI，由单活动段 replace；结束时提交最终渲染。必须提供段工厂，否则抛错 |
| strip | 独立的增量追加路径，保留块结构、去掉染色；用已输出位置避免常规重复，不具备整段撤回能力 |
| raw | 直接转发原始 chunk，不解析；非空内容结束时补换行 |

生产调用方在没有段工厂时把 render 转为 strip，不是 `MarkdownStream` 自行无条件退化。strip 仍使用 token／位置增量状态，因此 render 路径的边界修正不能作为 strip 已解决所有同类问题的证明。

render 的核心状态是 buffer、segment 和前次 ANSI。`feedRender` 遇渲染行数减少时沿用前次 ANSI，直到新结果行数足够再更新；这意味着部分新内容可能暂缓显示，不能保证只延迟一个 chunk。

`end()` 按 EOF 重新渲染并直接 commit，没有复用上述行数兜底。底层要求最终行数不少于已固化行数；这是需要维持的合同，不能以流式阶段的保护宣告所有结束场景已获保证。即使行数未减少，已进入回卷的前缀变化也不能回写。此处说明实现边界，不把“不重复、不丢内容”的目标降为可选项。

## 可见内容与生命周期

| 内容 | 流式行为 |
|---|---|
| 段落 | 末尾未完成 inline 暂缓，已可见部分呈现；EOF 完整处理 |
| 围栏代码 | 未闭合时暗色正文占位，闭合后按块渲染／高亮 |
| 列表 | 在活动段内整体渲染，后续 chunk 重新替换，不按暂时 token 边界提前拆段 |
| 末位标题、引用、横线、表格 | 暂缓，闭合或 EOF 后呈现 |
| 空白 | 不直接累加 space token 输出，段落／块自身组织分隔 |

◆ 位于每段第一个可见段落起首，一段至多一个；只含代码或列表的段不强求出现。首个带标记段落续行对齐标记后的正文；后续无标记段落回到内容基准列。

begin／replace／commit／close 由屏幕层承担位置与句柄有效性，Markdown 不复制几何状态。结束后清理 buffer 和增量状态；调用方切换输出种类时须结束当前 Markdown 段，避免其他内容写在仍会替换的段之后。

列宽在 `MarkdownStream` 创建时捕获，不随屏幕 resize 自动刷新；不能把屏幕重建等同于现存 Markdown 实例按新宽度重排。完整换行与样式规则由块／inline renderer 实现，并服从屏幕行宽合同。

**缩放后的连续输出要求尚有实现差异：** 未结束的流式段应在缩放后继续输出，不能因重建丢失后续内容。当前 REPL 的 resize 回调直接调用 `rebuildAfterResize`，底层 `ScrollRegion.establishLayout` 清空 `activeHandle`；`ScreenController` 的段包装仍持有旧句柄且未重新绑定，后续 replace／commit 会被底层以“句柄不再活跃”拒绝。因此问题不止是列宽未刷新，不能宣称现存活动段已能在重建后自动续绘；这也不等于宿主执行或持久化记录随之丢失。

## 核查入口

- [输出装配与模式选择](../../../packages/cli/src/output/output-renderer.ts)、[流式状态机](../../../packages/cli/src/output/markdown/markdown-stream.ts)。
- [块渲染](../../../packages/cli/src/output/markdown/block-renderer.ts)、[inline 渲染](../../../packages/cli/src/output/markdown/inline-renderer.ts)。
- [流式测试](../../../packages/cli/src/output/markdown/__tests__/markdown-stream.test.ts)：重点覆盖跨 chunk 语法、嵌套列表、最终内容、段事件顺序、三种模式和行数变化；这些单元测试不能代替长段进入回卷后的端到端验证。
