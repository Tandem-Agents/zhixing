# CLI 文本粘贴架构

文本粘贴把用户交付的一段文字作为完整输入事件处理：长内容在输入区折叠降噪，发送时还原原文。占位符是临时 UI 表示，不是消息内容或持久附件；它不能泄漏到 Agent 正文或已发送的历史区。

## 产品边界与取舍

- 首次长粘贴显示紧凑占位符；输入中已有文本粘贴占位符时，再次粘贴替换旧占位符并显示新原文，保留周围普通文字。这不是把两次粘贴拼接，也不是把旧占位符展开后再追加。
- 同一次粘贴的传输分片必须先合成完整事件，不能被当作用户再次粘贴而丢掉前半段。
- 提交前的输入历史（↑／↓ 可恢复草稿）可以保留占位符；提交后终端 scrollback 中的用户消息必须显示原文。两者不是同一个“历史”。原生 scrollback 无法可靠事后重绘，不能把等待展开的引用先写进去。
- 正文首尾空白、缩进和末尾换行须保真；trim 只用于空输入判断和命令控制流。UI 折叠不主动截断内容，也不替模型决定删减哪些文字。
- 图片、文件等结构化材料输入是相邻职责，不等于文本折叠。本文只说明共享输入交界，不定义材料采集、读取授权、模型能力或存储协议；也不提供磁盘粘贴库、语法高亮或预建多模态能力。

## 责任链

`终端按键 → 完整粘贴事件 → 输入态折叠／原子编辑 → 提交时展开 → 正文准备与接收 → 提交历史及回显`

| 责任 | 当前归属 |
|---|---|
| 识别粘贴边界 | `paste-detector.ts`，向调用方输出单键或一次完整 paste，不决定业务呈现 |
| 折叠与编辑协调 | `typeahead-input.ts`，组装 detector、registry、buffer 和补全 Broker |
| 临时原文与格式 | `paste-registry.ts`，维护 id、原文、行数、字节数及同内容复用 |
| 展开及引用保活 | `paste-expand.ts`，倒序替换占位符；`PasteReferenceIndex` 索引可恢复草稿 |
| 原子操作与布局 | `paste-atomic.ts`、`input-handle-tokens.ts` 和 TUI 原子布局原语，统一处理输入 handle |
| 普通草稿和输入历史 | `InputBuffer`，提供字符编辑与可恢复槽位，不依赖粘贴 registry |
| 正文交付 | REPL、`user-turn-input.ts` 与对话调用链；CLI 临时 token 不成为核心的文本协议 |

这条链留在接入面。core 的补全匹配只接受注入的 `wordTerminators`，不知道 CLI 占位符含义，不形成 core 对 CLI 的反向依赖。

## 完整粘贴事件

REPL 启用 bracketed paste mode，退出时复位。detector 在 keypress 层识别 `paste-start`／`paste-end`，跨批次累积并在结束时一次性交付；换行事件还原为 `\n`，不是触发提交的 Enter。

没有协议标记时，同一批多个同步 keypress 作为粘贴片段，再以 15ms idle 窗口合并相邻片段；单键沿 microtask 路径及时交付。该 fallback 是兼容性启发式，不能保证任意间隔的分片都能正确分组。旧设计“标记只抑制警告、纯 microtask 足够、无需计时合并”已被替代。

detector 不决定所有消费者都丢弃或都接受 paste：正文输入处理完整文本，选择面板的输入层接受字符、选择层不把 paste 当动作，具体合同见[选择模块](selection.md)。停止订阅时调用 `release()`，结束批处理与计时器，未完成粘贴不在退出后继续写入输入区。

## 输入态：折叠、格式与编辑

非材料粘贴达到 **4 行或 200 UTF-8 字节**时可折叠；统计行数时不计末尾空行，但原文仍完整保存。短内容直接铺开。当前 `finalizePaste` 先处理材料识别交界，再移除已有文本 paste token：只有本次没有移除旧 token、且达到阈值时才折叠；“干净”不是要求整个草稿为空。

占位符格式为 `[Pasted #N +M lines · size]`；size 使用 ASCII 的 B／KB／MB，不内嵌长预览。显示格式和解析 pattern 由 registry 同源定义，调用方不各写一套正则。相同原文可复用 id，hash 命中还须比较原文，不以 hash 独自判断内容相等。

左右移动整段跨过 handle，Backspace／物理 Delete 整段删除；没有命中 handle 时回到普通字符编辑。Ctrl+D 仍属于候选删除，不充当文本 Delete。原子操作在输入层完成，不把字符 buffer 改造成粘贴专用状态机。

文本 token 与材料 chip 共用原子识别和布局入口，但再次文本粘贴只清理文本 paste token，不静默删掉材料 chip。硬换行与软换行统一使用续行缩进；原子区域不在普通换行边界随意切碎。屏幕宽度及输入区呈现由[输入区视觉](input-visual.md)与[屏幕渲染](screen-rendering.md)负责，不在此重复定义。

CLI 向补全 Broker 注入统一 handle patterns 作为额外 word 边界，避免占位符字面值污染候选 query。原子操作、正文准备和候选匹配是不同职责，不能用一个 token 正则替代整条交付链。

## 临时存储与输入历史

`PasteRegistry` 由 REPL 创建并注入常驻输入控制器，跨轮共享；随 REPL scope 释放，不为恢复终端 scrollback 而持久化。

保活集合包括当前草稿、输入历史条目和浏览历史前暂存的草稿。`InputBuffer.getRestorableDraftSlots()` 只暴露这些通用槽位；`PasteReferenceIndex` 缓存每个槽位的引用，只重新解析新增或变化的文本；registry 按汇总 id 清理。

因此提交清空当前框不会误删历史里的引用，↑ 恢复后仍可折叠显示并再次发送原文，↓ 回到未提交草稿也不失活。历史淘汰且其他槽位不再引用时才回收；既不每次扫描全部历史大文本，也不让 registry 整个会话永不清理。只按当前草稿回收、或仅特别保留刚提交 token，都会遗漏正常恢复路径。

## 提交：临时表示转为正文

1. 从 `rawDraft` 展开文本 token 得到 `canonicalDraft`，倒序替换保持多个匹配的偏移正确。
2. 用 raw 草稿决定是否进入命令语言；trim 后的控制文本只用于空输入、slash 命令和别名判断。折叠原文即使以 `/` 或 `、` 开头，也不因展开而自动变成命令。
3. 普通正文传递未裁剪的 canonical 文本；`prepareUserTurnInput` 保留正文空白，显式 `@file:` 等引用按既有输入协议解析，不把 UI token 当成核心消息。
4. 当前 REPL 配置 deferred 正文提交：输入控制器返回 `pending-text`，输入准备失败时保留草稿，不写提交回显。准备通过后，`onAccepted` 回调或 `beginUserTurn` 正常返回都会触发幂等 commit；正常返回后的 commit 先于结果分支判断，因此等待准则确认、合同失败或取消也可能已提交输入，不能概括为“只有接收成功才提交”或“失败一律保留草稿”。材料处理本身不属于本文。
5. commit 保存 raw 输入历史，清空当前草稿、同步 Broker，再以 canonical 文本写 scrollback。命令及非 deferred 调用有各自直接提交路径，不应概括为所有输入都等宿主接收。

纯空白输入只清理输入态，不作为正文消息或输入历史条目。`expandPastes` 遇到 registry 中不存在的 id 仍保留字面文本，这是当前容错行为，不是“有效 token 允许失活”；系统自己产生且仍可恢复的引用必须由保活链保证完整。

## 范围与验证边界

当前没有 `/paste #N` 预览能力。文本折叠不处理图片／文件内容读取，也不将“路径形态”视为读取授权；采集与提交见[CLI 材料输入](material-input.md)，共同输入合同见[会话材料输入](../conversation/material-input.md)。

维护时须验证整条交互链而不只测纯函数：协议与 fallback 拆批、首次折叠／再次替换、普通文本与中文阈值、原子编辑、提交原文与空白保真、命令隔离、↑ 再提交、saved draft 恢复、历史淘汰回收，以及失败保留输入。终端启用序列和单测通过不等于所有终端兼容性已实测。

直接实现入口：[输入控制器](../../../packages/cli/src/typeahead-input.ts)、[粘贴检测](../../../packages/cli/src/paste-detector.ts)、[临时存储](../../../packages/cli/src/paste-registry.ts)、[展开与保活](../../../packages/cli/src/paste-expand.ts)、[正文准备](../../../packages/cli/src/user-turn-input.ts)。
