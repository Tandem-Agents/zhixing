# 输入区多行粘贴附件化 — Paste 折叠为占位符附件

> 触发于 2026-05-06：单行自动 wrap (`layoutInputBuffer`) 落地后，用户在 Windows Terminal 粘贴多行内容时，终端弹出"粘贴多行警告"，确认后内容里的 `\n` 被 keypress decoder 解析为 `return`，第一行内容立刻 submit、AI 抢跑回复。本质问题是：**输入区把"用户粘贴"和"用户敲键"按同一通道处理**，缺乏"附件化折叠"语义。

## 问题描述

**现象**：
1. 终端粘贴多行 → \n 被识别为 Enter → 第一行被 submit → AI 抢跑
2. 即使禁用第一行 submit（让 \n 被普通插入），30 行内容会铺成 30 行 input box，用户视觉被淹没、无法在多个粘贴间继续打字
3. Windows Terminal/iTerm2 等终端默认弹"多行粘贴警告"是因为它们检测到 clipboard 多行而 stdout 没启用 bracketed paste mode

**直接原因**：`typeahead-input.ts` 的 `onKeypress` 把每个字符当独立按键处理。`\n` 走 `key.name === "return"` 分支立刻 submit；其余字符走 `insertText`。粘贴的语义在 keypress 流里**消失**。

**本质**：缺少"粘贴 = 附件"语义。粘贴是一个**单元**（具有 source / lineCount / byteSize 等元属性），而不是 N 个独立按键。把它当按键流处理 → 必然在某个 \n 上触发 submit + 视觉淹没用户。

---

## 现状参考与同类项目调研

| 维度 | Claude Code | hermes-agent | openclaw | 知行（当前） |
|---|---|---|---|---|
| 检测 | bracketed paste + 1024 字符阈值 + 100ms 合并 | bracketed paste + 50ms 间隔 fallback | 纯 50ms 间隔合并（仅 macOS Terminal/Git Bash） | 无 |
| 数据模型 | 占位符 + `Record<id, content>` 分离 | 占位符 + `pasteSnips[]` 分离 + 后端落盘 | 直接合并塞 buffer | buffer 单层字符串 |
| 占位符 | `[Pasted text #N +M lines]` | `[[ 首16字 .. [N lines] .. 尾28字 ]]`(嵌入预览) | 无 | 无 |
| 截断 | 10000 字符 + 头/尾 500 字符保留 | 8000 字符或 80 行 | 不截断 | — |
| 提交还原 | `expandPastedTextRefs` 倒序替换 | `expandSnips` regex 替换 | 无需 | — |
| Orphan 回收 | 删占位符同步删 store | 同 | — | — |
| TUI 框架 | React-based PromptInput | ink (React TUI) | pi-tui Editor | 命令式光标 ANSI 协议 |

**精华提炼**：
- bracketed paste mode (ESC[200~ ... ESC[201~) 是协议级最可靠的检测
- 占位符 + 独立存储分离是必要的（不分离 → 无法折叠）
- orphan 实时回收（buffer 改了 → registry 同步删）比"显式 delete API"更鲁棒
- 提交时倒序替换保 offset 有效（多个占位符场景）

**不照搬**：
- Claude Code 的"提交后清空 pastedContents"——React 上下文与命令式 ANSI 不同，照搬会导致 history 浏览占位符成死链（详见架构方案）
- hermes 的占位符内嵌预览——视觉重量大、占用列宽
- 后端落盘——hermes 为 multi-session 找回，知行 in-memory 简单足够

---

## 解决方向（一句话）

把"粘贴"识别为单元事件 → 短内容直接展开为字符、长内容折叠为 `[Pasted #N +M lines · KB]` 占位符 + REPL session 级 registry 存储 → 提交时占位符 expand 回原文喂给 agent，**echo 与浏览历史保持占位符形态**保证视觉一致。

---

## 架构方案

### 五层结构

```
┌─────────────────────────────────────────────────────────┐
│  Submit Pipeline                                         │
│  expand 仅作用于送 agent 的 text，echo / history 保留占位符 │
└─────────────────────────────────────────────────────────┘
                           ↑
┌─────────────────────────────────────────────────────────┐
│  PasteRegistry  ←──── REPL session 级，caller 注入        │
│  Map<id, { content, lineCount, byteSize, hash }>        │
│  生命周期 = REPL session（不是 readInputLine）            │
└─────────────────────────────────────────────────────────┘
                           ↑ register / lookup / cleanup / clearAll
┌─────────────────────────────────────────────────────────┐
│  finalizePaste  ←──── typeahead-input 内部函数（不污染 buffer）│
│  short → buffer.insertText 字符级插入                       │
│  long  → registry.register + buffer.insertText(token)      │
│  short / long 含 \n 由 Step 2 扩展的 layoutInputBuffer 承接 │
└─────────────────────────────────────────────────────────┘
                           ↑
┌─────────────────────────────────────────────────────────┐
│  Paste Detector  ←──── stdin "data" 字节级状态机           │
│  双层协作：data listener 维护 inPasteMode；所有 raw mode    │
│  组件的 onKeypress 顶层 inPasteMode 时短路 ignore           │
│  （typeahead-input / select-with-input / typeahead-panel    │
│   等所有 keypress 消费者，全局约定）                        │
│  ESC[200~ → 进 paste 模式 + 累积 pasteBuffer               │
│  ESC[201~ → 调 activePasteHandler；无 handler 默认丢弃     │
│  保护：buffer > 10MB / 静默 > 500ms 强制结束 + 提示         │
└─────────────────────────────────────────────────────────┘
                           ↑
┌─────────────────────────────────────────────────────────┐
│  Terminal Setup  ←──── CLI 启动入口启用 bracketed paste    │
│  process 启动：stdout.write("\x1b[?2004h")               │
│  process 退出：stdout.write("\x1b[?2004l")  必须 reset    │
│  全局一次启用，不耦合 raw mode lease                       │
└─────────────────────────────────────────────────────────┘
```

### 关键设计

#### PasteRegistry 生命周期 = REPL session

- **caller 注入**：REPL 主循环创建 `new PasteRegistry()`，作为参数传给 `readInputLine`，在多轮 readInputLine 之间共享
- **不在 submit 后清空**：commit 后 buffer.draft 含占位符进 history ring buffer；用户按 ↑ 浏览历史时占位符仍可 expand
- **session 退出时 `clearAll()`**：用户 /exit 或 Ctrl+C 退 REPL 时一次性清空
- **同 hash 复用 id**（hermes 做法）：用户重复粘贴同段内容时 registry 不爆，长 session 内存可控

#### bracketed paste mode 启用位置 = CLI 程序启动入口

- 不放 `raw-mode.ts`：raw-mode 被 `select-with-input` / `typeahead-panel` / `config-editor` 共用，paste 启用全局即可，不依赖 lease 引用计数
- 放 `packages/cli/src/index.ts`（或 REPL 入口）：进入 REPL 前 `stdout.write("\x1b[?2004h")`，注册 process exit handler / SIGINT reset
- 安全性：未识别 paste markers 的组件天然忽略 ESC 开头 sequence（参考 typeahead-input.ts 已有 `!str.startsWith("\x1b")` 守卫）

#### finalizePaste 在 typeahead-input.ts 完成（不污染 InputBuffer）

InputBuffer 当前注释明确 "本类只持有 in-memory ring buffer"——保持纯粹。Registry 处理放在 typeahead-input.ts 层：

```
finalizePaste(content):
  if shouldFold(content):     # ≥ 4 行 OR ≥ 200 字符
    id = registry.register(content)
    buffer.insertText(registry.format(id))
  else:
    buffer.insertText(content)
  syncBroker()
```

InputBuffer 完全不变。

#### layoutInputBuffer / wrapToWidth 扩展 — 原子区域 + 硬换行

当前行布局原语**两个能力同时缺失**，paste 落地时必须一起补齐：

1. **原子区域不可切碎**：占位符跨行边界时被字符级切碎（如 `...[Pas` + `ted #1 ...]`）→ 视觉损坏
2. **不识别 `\n` 硬换行**：当前依赖 typeahead-input.ts 的 keypress filter 过滤 `\r/\n` 维持 "buffer.draft 不含 `\n`" 隐性约定。但 paste 引入了 `\n`——短粘贴（< 4 行）走 `buffer.insertText(content)` 后 buffer.draft 含 `\n`，layoutInputBuffer 把 `\n` 当 0 宽字符塞进 bodyLine，stdout 写到终端遇 `\n` 真换行 → **chrome 右边框被推到下行、box 断裂**

**解决**：

- `layoutInputBuffer` 加 `atomicRegions?: RegExp` 参数：wrap 前先按 `\n` split 成段（硬换行），每段独立做 atomic-aware wrap；atomic 区域整体测量宽度，不放下当前行整体换行
- `wrapToWidth`（teardownVisuals 用于 historyEcho 染色的同链路工具）同等扩展（atomic + `\n`）—— echo 路径 rawDraft 也含 `\n` + 占位符，否则 bg 染色断裂
- **续行 prefix 统一规则**：所有续行（wrap 出的、`\n` 段间的）统一用 `hangingIndent`（与 promptPrefix 等宽空格）——视觉上多行被锚定为"同一个输入气泡"，无论分行来源是软 wrap 还是硬换行

这是 input-layout.ts / line-width.ts 的合理扩展（设计语言层增强），未来其他原子单元（如 URL 不切断）也能复用，不是为 paste 专属。

#### 折叠阈值
- **行 ≥ 4** OR **字符 ≥ 200** 才折叠为占位符；否则直接 insertText
- 短粘贴（2-3 行小代码片段）保持铺开，符合用户视觉直觉
- Claude Code 的 1024 字符门槛偏高（半屏代码也不折叠）；阈值过低又导致小段也被折叠产生认知摩擦

#### 占位符格式
```
[Pasted #N +M lines · KB]
```
- N = registry 编号（同 hash 复用）
- M = 行数（不含末尾空行）
- KB = byteSize 量化（KB / MB / B）

比 Claude Code 多 byteSize（用户判断"是不是粘错了大文件"）；比 hermes 紧凑（不嵌入预览，预览走独立通道）。

#### 提交时 expand 仅作用于 agent 路径

```
submit():
  rawDraft = buffer.draft               # 含占位符
  expanded = expandPastes(rawDraft)     # 还原原文
  text = expanded.trim()
  teardownVisuals(rawDraft)             # echo 保留占位符形态（视觉一致）
  finish({ kind: "text", text })        # text 是 expanded，传给 dispatcher / agent
```

**关键**：echo 用 rawDraft（占位符形态），expand 仅作用于送给 agent 的 text。否则 echo 把 30 行展开 → bg 灰底 30 行，等于没折叠，破坏折叠 UI 一致性。

`expandPastes` 遇到 unknown id（如用户字面输入 `[Pasted #999 ...]`）保留字面字符串作字面 fallback，避免崩溃。

#### Orphan 回收机制（不污染 InputBuffer）

在 typeahead-input.ts 的 `syncBroker` 函数顶部同步调：

```
syncBroker():
  registry.cleanup(extractAliveIds(buffer.draft))
  options.broker.updateInput(...)
```

`extractAliveIds(draft)` 用 regex 抽出仍 match 的占位符 id 集合。registry 中不在 alive set 的 id → 删除。

InputBuffer 不抛事件、不知道 registry——保持其纯粹性。

#### history 浏览策略

- history ring buffer 保留**含占位符的 draft 字符串**（节省内存，不存全文）
- registry 在 readInputLine 之间共享 → 浏览历史时占位符仍可 expand
- session 退出时 registry 与 history 一起被 GC

#### paste 与 typeahead trigger 的交互边界

用户在 typeahead session active 时（如输入 `/file ` 后）paste 内容 → broker 的 trigger matcher 看到 `/file [Pasted #1 ...]` 作 query → 永远 no matches → 用户困惑。

**约定**：占位符 token 在 trigger matcher 中视作 **word 终止符** —— 与空格 / `\n` 同等地位作 query 边界。trigger query 仅取占位符前的 token 段；broker 看到的 query string 不含占位符字面值。

**架构落点（跨包边界）**：trigger matcher 在 `@zhixing/core`，`PasteRegistry` 在 `@zhixing/cli`。core 不依赖 cli（依赖方向锁定）。改造路径：

- core 的 broker / trigger matcher 加可扩展参数 `wordTerminators?: readonly RegExp[]`（语义：识别为 word 边界的额外 pattern，与原生空格 / `\n` 同等）
- cli 创建 broker 时通过此参数注入 `[PASTE_TOKEN_PATTERN]`（由 `PasteRegistry` 模块导出）
- core 仍不知占位符语义，只知"这些 pattern 是 word 边界"——保持核心包纯粹，扩展点对未来其他原子 token（`@mention` / 嵌入引用等）同样开放

效果：
- 用户在 `/file ` 后 paste 长路径 → 占位符进 buffer，trigger query 段为空 → 自然退出 typeahead，与"用户切换思路"语义一致
- 用户继续输入参数 → 新 token 触发新 typeahead
- 短粘贴含 `\n` 同样按 word 终止符处理（`\n` 本来就是 trigger 边界），行为一致

#### 预览通道

独立命令 `/paste #N` → 弹独立 chrome 显示完整内容（按 Esc 退出），与 config-editor 共用渲染原语。不嵌入占位符（避免 hermes 的视觉重量），不 hover 自动预览（增加状态复杂度）。

按需展开 = 用户主动操作 = 视觉默认安静。

#### 不做字符阈值 fallback

设计上**只支持现代终端**（Windows Terminal / iTerm2 / VS Code Terminal / WSL / kitty / Alacritty 等支持 bracketed paste 的终端）。老旧终端（Windows ConHost）不响应 ESC[?2004h → 多行粘贴按 \n 拆成多次 keypress 提交，行为与当前一致（即抢跑 bug 仍在）—— 由用户切换到现代终端解决，不为兜底引入计时器状态。

边界明确，简单清晰。

#### 格式契约 — 单一真相源

占位符 token 的格式在三处出现：`PasteRegistry.format(id)` 输出、`expandPastes` 解析、`extractAliveIds` 抽取。三者**绑定同一格式定义**避免漂移：

- **byteSize 量化**锁定 ASCII 三档：`123B` / `1.2KB` / `1.5MB`，不本地化、不带千分位、不带空格分隔
- **token regex** 由 `PasteRegistry` 模块导出（如 `PASTE_TOKEN_PATTERN: RegExp`），`expandPastes` / `extractAliveIds` / typeahead trigger word 边界等所有 caller 复用同一来源，不在多处独立定义
- **hash 算法** deterministic、内部独立（FNV-1a 32-bit 截断或类似），不引外部依赖；用于同内容复用 id 的相等性判断，不参与 token 字面渲染（token 里只有 `#N` 数值 id）

避免 "format 与解析分两处定义" 的隐性耦合 bug；未来调整 byteSize 显示精度只动一处。

---

## 实施步骤

每 Step 独立可验证、独立可提交。

### Step 1：PasteRegistry + expandPastes 纯函数
- 新建 `packages/cli/src/paste-registry.ts`：
  - `class PasteRegistry`：`register(content) → id`（含 hash 复用） / `get(id)` / `cleanup(aliveIds)` / `format(id) → token` / `clearAll()`
  - 元数据：`lineCount` / `byteSize` / `hash`
- 新建 `packages/cli/src/paste-expand.ts`：
  - `expandPastes(draft, registry) → string` 倒序替换；unknown id 保留字面字符串
  - `extractAliveIds(draft) → Set<number>` 用 regex 抽 alive id 集合
- 单测覆盖：阈值上下、CJK byteSize、hash 复用、倒序替换 offset 安全、unknown id fallback、orphan 检测

### Step 2：layoutInputBuffer 与 wrapToWidth 扩展 — 原子区域 + 硬换行
- `packages/cli/src/input-layout.ts` 加可选参数 `atomicRegions?: RegExp`：
  - wrap 前先按 `\n` split draft 成段（硬换行）；每段独立做 atomic-aware wrap
  - atomic 区域整体测量宽度——若不放下当前行整体换到下行，不切碎
  - cursor 位置仍按字符 offset 落地（cursor 在 atomic 内部时落到 region 起始或末尾，按 InputBuffer 字符 offset 处理）
  - 不传 atomicRegions / 不含 `\n` 时行为字面不变（向后兼容）
- `packages/cli/src/tui/line-width.ts` 的 `wrapToWidth` 同等扩展（atomic + `\n`），供 teardownVisuals 的 historyEcho 染色路径使用
- 单测覆盖：atomic region 跨行整体换行、`\n` 硬换行边界、混合（含 `\n` + 含 atomic）、向后兼容

### Step 3：bracketed paste mode 启用 + 字节级 paste detector
- `packages/cli/src/index.ts` 进 REPL 前启用 `\x1b[?2004h`，注册 process exit handler / SIGINT reset
- 新建 `packages/cli/src/paste-detector.ts` 全局单例（CLI 启动时初始化一次）：
  - 注册 `stdin.on("data", ...)` listener（**注册时机早于 readline 启用 keypress**，保证同步广播时本 listener 先于 readline 的 data 处理执行）
  - 跨 chunk 维护字节级状态机：扫描 `\x1b[200~` → 进入 paste 模式 + 累积 `pasteBuffer`；扫描 `\x1b[201~` → 离开 paste 模式 + 调 `activePasteHandler(pasteBuffer)`
  - 暴露 `setActivePasteHandler(handler | null)` API：活跃组件 setup 时注册自己的 finalizePaste，cleanup 时清空；ESC[201~ 时若 handler 为 null（如 select-with-input / config-editor 期间）默认**丢弃 pasteBuffer + 状态重置**
  - 暴露 `inPasteMode` 只读属性供消费方查询
- 双层协作（不是字节截断 stream）—— **全局 raw mode 约定**：所有 keypress 消费者的 `onKeypress` 顶层都加 `if (pasteDetector.inPasteMode) return` 短路。paste 期间 readline 仍同步 emit keypress（含 paste 内容里的 `\n` → return key、`\x1b` → 误解析 escape sequence、字符 → 各 keypress），全部被消费方忽略，避免 paste 字符流污染选择 / 选项 / 字段。改动入口：`typeahead-input.ts` / `tui/select-with-input.ts` / `tui/typeahead-panel.ts`；未来新增 raw mode 组件遵循此约定
- 状态机保护：`pasteBuffer.length > 10MB` 或 paste 模式下 500ms 静默 → 强制 finalize + 控制台 dim 提示（防终端异常导致 hang）
- 验证：手测 Windows Terminal / VS Code Terminal / iTerm2 三档；含 `\x1b` 字符的粘贴内容（如 ANSI 着色文本）原始字节正确保留；select-with-input / config-editor 期间 paste 自然丢弃不卡死

### Step 4：finalizePaste + submit expand + historyEcho 保持占位符
- `typeahead-input.ts` 接 `registry: PasteRegistry` 作 `TypeaheadInputOptions` 字段（caller 注入）
- 实现 `finalizePaste(content)` 在 typeahead-input 内部：阈值判断 + register + buffer.insertText(token)；短粘贴含 `\n` 由 Step 2 扩展的 layoutInputBuffer 自然处理硬换行
- typeahead trigger matcher 加占位符 pattern 作 word 终止符：broker query 段不含占位符字面值（详见架构方案"paste 与 typeahead 交互边界"段）
- 修改 `submit`：
  - `rawDraft = buffer.draft`
  - `text = expandPastes(rawDraft, registry).trim()`
  - `teardownVisuals(rawDraft)` ← 保留占位符形态做 echo（wrapToWidth 已 Step 2 扩展支持 `\n` + atomic）
  - `finish({ kind: "text", text })` ← expanded 给上层
- 手测：粘贴 30 行 → 占位符显示 → 提交看到 expanded 传给 caller、scrollback 看到占位符形态 echo；短粘贴 3 行 → bodyLines 自然多行铺开，box 不断裂

### Step 5：orphan 回收
- `typeahead-input.ts` 的 `syncBroker` 顶部加 `registry.cleanup(extractAliveIds(buffer.draft))`
- InputBuffer **不动**
- 手测：用户编辑破坏占位符字符串 → 下次按键触发 syncBroker → registry 同步清理

### Step 6：REPL session 级 registry 注入 + clearAll
- REPL 主循环创建 `new PasteRegistry()`，传给 `readInputLine` 各次
- 用户 /exit 或 Ctrl+C 退 REPL 时调 `registry.clearAll()`
- 手测：粘贴 → submit → ↑ 浏览历史 → 占位符仍可 expand

### Step 7（可选）：预览命令
- `/paste #N` 命令：弹 chrome 显示完整内容（按 Esc 退出）
- 与 config-editor 的 chrome 共用渲染原语
- 留给后续阶段，不阻塞 paste 主流程

---

## 不在本方案

- **后端落盘** (`~/.zhixing/pastes/`) — hermes 落盘是为多 session/重启找回；知行 in-memory + REPL session 级 registry 简单足够，未来需求出现再加
- **atomic placeholder 在 cursor / backspace 层强制原子**（占位符在 cursor 移动 / backspace 时作单字符）— 需要把 `chars: string[]` 改成 `segments: Segment[]`，InputBuffer 内部模型改写复杂度过高；当前简化版（破坏后 orphan 回收）满足 95% 场景。**注意**：占位符 wrap 不被切碎是必须保证的（Step 2 解决），但 cursor / backspace 的字符级行为是用户主动编辑——用户对自己的破坏行为有感知，结果可解释
- **hover 预览**（光标停在占位符上自动展开 panel）— 增加状态复杂度且占视觉空间；用按需展开命令替代
- **粘贴图片/二进制附件** — 知行当前定位 text-based agent，图片粘贴是独立的多模态特性，不耦合到本方案
- **超大粘贴主动截断** — Claude 200K context ≈ 600KB 文本，常规粘贴远低于此；layoutInputBuffer 处理 ≤ 1MB 字符串 microsecond 级不卡 UI；不主动截断、不为 token 节省做手脚，让 LLM 自己处理超长输入
- **老旧终端字符阈值 fallback** — 设计明确只支持现代终端；Windows ConHost 等不响应 ESC[?2004h 的终端体验降级为当前行为（按 \n 拆 submit），由用户切换到现代终端解决
- **粘贴内容 syntax highlighting / 代码块识别** — 占位符是纯展示标记，不做语义识别；agent 拿到 expanded text 自行处理

---

## 设计落地引用

- 现有渲染：[`packages/cli/src/typeahead-input.ts`](../../../packages/cli/src/typeahead-input.ts)
- 现有 buffer：[`packages/cli/src/input-buffer.ts`](../../../packages/cli/src/input-buffer.ts)
- 现有行布局（多行 wrap）：[`packages/cli/src/input-layout.ts`](../../../packages/cli/src/input-layout.ts)（Step 2 扩展点）
- 现有行宽 / wrap 工具：[`packages/cli/src/tui/line-width.ts`](../../../packages/cli/src/tui/line-width.ts)（Step 2 同步扩展点）
- 现有 raw mode 管理：[`packages/cli/src/tui/_internal/raw-mode.ts`](../../../packages/cli/src/tui/_internal/raw-mode.ts)（不动）
- CLI 启动入口：[`packages/cli/src/index.ts`](../../../packages/cli/src/index.ts)（Step 3 启用 bracketed paste）
- 现有 chrome 紧凑形态：[`packages/cli/src/tui/chrome.ts`](../../../packages/cli/src/tui/chrome.ts)
- 同类参考：Claude Code `usePasteHandler.ts` / hermes `useComposerState.ts` + `text.ts` / openclaw `tui-submit.ts:75`
