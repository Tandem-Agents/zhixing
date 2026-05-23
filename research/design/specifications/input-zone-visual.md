# 输入区视觉规范

> **状态**：📐 方案设计
> **前置**：[cli-ui-design-language.md](./cli-ui-design-language.md) P7 「输入区是独立视觉容器」
> **姊妹 spec**：[input-typeahead.md](./input-typeahead.md)（输入补全的数据/交互层）
> **适用范围**：REPL prompt 行 + config-editor 的 input / add-model 面板

---

## 一、问题陈述

设计语言 P7 明确"输入区是独立视觉容器——自适应宽度框 / 输入光标位置稳定 / 超长自动换行不横滚"。但 REPL 输入区当前实现是裸 `❯ ` + 文本：

```
❯ 输入消息或 / 查看命令
```

视觉上单行 prompt 没有"独立空间"边界——文本似乎"飘"在终端，与设计语言要求的 box chrome 不一致。这是 P7 **尚未落地的一条原则**，也是工作台 UI 优化的核心遗漏。

补完 P7 是本 spec 的核心。

### 用户场景与频次

| 场景 | 频次 | 当前痛点 |
|---|---|---|
| 单行短输入（"帮我写..."、"/help"） | 80% | 没有清晰的输入空间边界——文本飘在终端 |
| 多行长输入（粘错误日志 / 详细任务描述） | 15% | 续行无缩进对齐，与终端原生 wrap 混淆 |
| 命令辅助（`/`、`@file:`） | 5% | panel 已独立 chrome，无空间感问题 |

知行是 personal AI agent，参照系是 Claude Code / Cursor Chat 的 box 输入，**不是 zsh shell prompt**——产品定位决定走 box。

---

## 二、设计原则与三视角

### PM 视角

- **优先解决高频痛点**：80% 短输入场景的"独立空间感"是核心；多行长输入是次优先级
- **保持产品调性**：append-only 输出下每轮新 box 必然"冒出"——只要 box 视觉重量轻（细线 + 低饱和），跳变感就小
- **历史不累积视觉负担**：提交后回显降级单行，不留 box 形态进入 scrollback

### UX 视角

- **可达性**：启动看完 welcome chrome 后，用户期望同质感的"我在哪输入"提示——`❯` 单行视觉重量太轻
- **心流**：长输入按内容扩展，光标位置稳定不被状态文本挤
- **跳变克制**：活跃态有 box，提交后历史态降级单行——只让屏幕上"最新一个" box 有视觉重量

### UI 视角

- **复用品牌符号**：圆角字符 `╭╮╰╯` 已是品牌签名（welcome / config-editor 都用），输入 box 同源
- **主色不变**：`❯` brand bold（青绿）/ placeholder dim
- **typeahead panel 共生**：两个独立 chrome 各自圆角，不嵌套不共边

---

## 三、形态规范

### 形态 A：空 buffer（启动时 / 提交后）

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯ 输入消息或 / 查看命令                                                      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- `❯` brand 主色（青绿 bold）
- placeholder dim 灰
- 框宽 = 终端列数 - 2，左右各留 1 列余量
- 框高 = 3 行（顶 + 1 行 body + 底，**body 上下不加 padding 空行**——与 welcome chrome 的"展示区"形态区分）
- `indent = 1`（紧凑型）——输入区是"工作区"，紧凑感优于呼吸感；welcome chrome 用 `indent = 3` 因为它是"展示区"。两者功能不同 → indent 可以不同，不破坏 P4 对齐原则

### 形态 B：编辑中（buffer 非空）

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯ 帮我写个 hello world                                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- placeholder 消失
- 光标在文本末尾稳定闪烁
- 光标位置不被任何外部状态推动（与 P7 "光标位置稳定"对齐）

### 形态 C：多行（自动扩展）

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯ 帮我写一段非常长的代码，包含错误处理、重试逻辑、超时控制、详细注释、       │
│   日志、metrics 上报、单元测试和集成测试……                                   │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- 单行装不下 → 续行内缩对齐 `❯` 之后两列
- 框按需扩展高度，保留全部输入可见（P7 "绝不横向滚动"）

### 形态 D：Typeahead panel 共存

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯ /                                                                          │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands · 6 matches ───────────────────────────────────────────────────────╮
│ ▸ /help    ░░░░░░░░░░░░░░░░░░░░░░显示帮助░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│   /clear         清空对话历史                                                │
│   /status        显示会话状态                                                │
│   ...                                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- 两个独立 chrome，各自圆角，最简实现 + 最清晰边界
- panel 内**选中行复用 entry/list 行的点阵纹理高亮**（详见第四节）

### 形态 E：提交后回显（历史态）

```
（淡灰底整行）  帮我写个 hello world                                  （淡灰底）
[agent 输出]

（淡灰底整行）  然后呢                                                （淡灰底）
[agent 输出]
```

- **无 box**——单行回显进入 scrollback，box 形态崩塌为单行历史
- **整行 bg dim 灰染色**——用户消息在长 scrollback 里有持续视觉锚，与 agent
  输出（无 bg）形成对比；解决 Claude Code / Cursor Chat 等"用户历史消息和 agent
  输出混在一起不易回看"的共性痛点
- bg 色：`bgAnsi256(236)`（≈ #303030 中深灰）—— 深色终端略亮于 bg 明显但不刺眼，
  浅色终端深灰底 + 黑字对比偏低但仍可读，优先深色终端体验
- **不带 `❯` prompt 字符**——bg 灰底已充分标识"用户消息"，`❯` 是 active box
  "现在输入"信号，历史态里复用是错位双信号；删除 `❯` 也让用户复制历史消息时
  不带 prompt 前缀
- **前导 2 空格**让文字不贴 bg 左边缘视觉舒展；消息文本 default 颜色（可读优先）
- **padding 到终端宽度**让 bg 延伸到行末——否则 bg 只在文字下方染色，视觉锚断裂
- 取消路径（Ctrl+C / Ctrl+D / abort）finalEcho=null，不染色——只清屏 + 换行

### 历史态 vs 选中纹理 / section 头 / chrome 边框（无语义冲突）

历史态用 **bg color 整行染色**，与设计语言里所有既有视觉手段正交：

| 既有元素 | 视觉手段 | 历史态是否冲突 |
|---|---|---|
| 选中行（entry/list/typeahead） | dim `░` 字符纹理替换空白 | ✓ bg 不是字符纹理 |
| section 头 `▎ <title>` | 左侧竖线字符 | ✓ bg 不是竖线 |
| chrome 边框 `╭ │ ╰` | dim 圆角字符 | ✓ bg 不是字符 |
| brand bold `❯ ✦` | brand 主色字符 | ✓ bg 是 ANSI 48；不与 fg ANSI 38 冲突 |

bg color 是设计语言里**未被使用过**的视觉槽位，拿来标识"消息归属"是干净的新语义。

### 形态 F：底部信息行（普通交互模式）

普通交互模式下输入框整体上抬一行，框正下方、终端最底行留一行**信息提示行**（始终占位）：

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ❯ 帮我写个 hello world                                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
                                                                       esc 清空
```

- **横向分左 / 右两区**：左区内容左对齐、右区内容右对齐，各可并排多个具名块
- **内容动态、来源无关**：由来源无关容器 `BottomInfoModel` 承载——任何来源 `set(zone, id, content)` 推 / `set(..., null)` 清，渲染只读 `snapshot()`、不认来源；块的视觉顺序由 `BOTTOM_INFO_IDS` 声明序决定（非写入时序）
- **当前唯一来源 = 输入框自身**：buffer 非空时右区显示 dim `esc 清空`，空时清除该块（行仍占位）
- **始终占位**：普通模式该行恒在（空内容也占一行 → 框固定上抬一行、高度不抖）
- **生命周期跟随普通输入框**：与形态 D（typeahead panel 共存）互斥——召唤面板时面板自带底部提示行、本行让位不显示；inline 编辑态同理由其自身提示行接管。每种模式各管自己的底部行
- 权威实现：`packages/cli/src/bottom-info/`（容器 + 双区渲染纯函数）+ InputController（首个来源 + 渲染落点，在 buffer 内容变化时同步、`broker.updateInput` 之前以免落后一帧）

---

## 四、Typeahead 列表项的点阵纹理高亮

### 现状差距

config-editor 的 entry / list 行（`section.ts: renderEntryRow / renderListRow`）选中态采用**点阵纹理高亮**：

```
│ ▸ 列表项 A    ░░░░░░░░░░░░░░░░░░描述░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
│ › 列表项 B           另一描述                                               │
│ › 列表项 C           ...                                                    │
```

实现位置：`packages/cli/src/tui/section.ts: highlightDottedRow`——把行内 2+ 连续空格替换为 dim `░`（U+2591 LIGHT SHADE），尾部补齐到行宽。

**纯字符纹理，不依赖 bg ANSI 颜色码**。视觉是"印刷品 / 点阵屏"质感，与现代 SaaS 的 bg color 路线明显区分——是知行专属的视觉标识。

而 typeahead-panel（`tui/typeahead-panel.ts`）当前选中态只有 `selectedArrow + selectedName(brand bold)`，**没有纹理填充**——视觉重量不足，与 entry/list 行风格分裂。

并且 typeahead-panel 当前采用 **left-only L 形 chrome**（每行只有左 `│`，底边 `╰────` 无 `╯`）——与 welcome / config-editor 的双边框 chrome 视觉契约不统一。这是与本 spec 范围内 input box 共生的阻碍：input box 双边框 + panel L 形并排时视觉不齐。

### 前提：typeahead-panel 升级为双边框 chrome

本 spec 范围内将 typeahead-panel 升级为完整双边框 chrome（顶 `╭───╮` / body `│ ... │` / 底 `╰───╯`），与 input box / welcome 视觉契约统一。这是支撑下方"纹理高亮规范"的前置改造——纹理尾部补齐才有明确的右边框 `│` 作为终止边界。

### 规范

typeahead-panel 选中行（`isSelected === true`）必须使用与 entry/list 同源的点阵纹理高亮：

- 选中行的"空白带"（2+ 连续空格）→ dim `░` 同长度替换
- 单空格保留（避免内容粘连）
- 尾部补齐到 `frameWidth - 2`（左右各 1 列边框 `│`）

### 实现要求

`highlightDottedRow` 当前是 `section.ts` 内部函数，需要提升为 tui 内部跨文件可用的 helper（仍然不导出到 tui 公共 API，避免 caller 在 chrome 之外乱用）。提升路径：

- 选项 A：移到 `tui/_internal/highlight.ts`，section + typeahead-panel 都从 `_internal/` import
- 选项 B：在 typeahead-panel 内复制等价实现（轻代码重复，但避免 cross-file 依赖）

推荐 **选项 A**——单一来源，未来若再有第三个组件需要纹理高亮（如 footer 选中提示）零成本扩展。

---

## 五、决策表

| 决策 | 候选 | 选择 | 理由 |
|---|---|---|---|
| **整体形态** | A. 完整 box / B. 左侧 accent bar / C. 不加 box 保持现状 | **A** | P7 明确要 box；与 welcome chrome 视觉同源 |
| **宽度策略** | A. 全宽（列数 - 2）/ B. 内容自适应 / C. 固定 80 列 | **A 全宽** | 与 welcome chrome 一致；多行长输入有空间；固定 80 在宽终端浪费 |
| **高度策略** | A. 单行起 + 自动扩展 / B. 固定多行 | **A** | 空状态不浪费屏幕；长输入按需扩展，符合 P1 少即是多 |
| **提交回显** | A. 单行 `❯` / B. 也用 box / C. 缩进式 | **A 单行** | 已是现状；历史态降级避免视觉累积 |
| **panel 共存** | A. 两个独立 chrome / B. panel 与 box 共边 / C. 嵌入式一个大框 | **A 两框** | 实现最简；边界最清晰；panel 已是 chrome 风格无需重做 |
| **panel 选中行纹理** | A. 复用 entry/list 的点阵纹理 / B. 仅箭头 + bold（保持现状） | **A 点阵纹理** | 视觉同源；与 P3「不依赖颜色」一致——纹理在所有终端可见 |
| **typeahead-panel chrome 形态** | A. 保持 L 形（left-only）/ B. 升级为双边框完整 chrome | **B 双边框** | 与 input box / welcome 视觉契约统一；纹理高亮的尾部 `│` 边界明确；本 spec 范围内一并完成 |

---

## 六、实施分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **1（核心）** | `chrome.ts` 扩展 `bodyPadding?: boolean` 选项（默认 `true` 保 welcome 行为，input box 传 `false` 得紧凑 3 行高度）；input box 复用 `renderChrome` 原语 + `indent: 1`；`typeahead-input.ts` rerender 重写为多行布局；`teardownVisuals` 单行回显 + 整行 bg 染色（`tone.historyEcho` token，padding 到终端宽度）；取消路径不染色 | 启动看新视觉；输入字符 placeholder 消失；提交后历史塌缩为整行 bg 染色单行 |
| **2（panel 双边框 + 纹理同源）** | typeahead-panel 升级为双边框 chrome（与 input box / welcome 视觉契约统一）；`highlightDottedRow` 提升到 `tui/_internal/`；typeahead-panel 选中行接入点阵纹理 | 触发 `/` panel 后两侧均有 `│`，选中行纹理高亮与 config-editor 列表行视觉同源 |
| **3（多行扩展）** | buffer 超过单行时框高扩展；续行内缩对齐 `❯` 后位置；光标在多行内稳定 | 粘贴长文本不横滚；输入第二行有缩进 |
| **4（panel + box 联调）** | 验证 box + panel 共存视觉无冲突；光标契约在两 chrome 之间正确 | `/`、`@file:` 触发 panel 视觉对齐 |

### 实施风险参考（非规范）

> 本段是分阶段决策的参考输入，非视觉规范。具体实现细节由代码层判断。

`typeahead-input.ts` 的 rerender 当前是单行优化的（`\r` 回 col 0 + 单行重写）。改多行 box 涉及：

- 跨行光标管理（`moveUp` / `moveDown` 精确计算）
- 多行 ANSI 重绘的同步性（`syncBegin` / `syncEnd` 包裹整帧）
- 与 panel 相对位置的契约重写

阶段 1 已经触及这些复杂度，需要严肃实现 + 完整测试覆盖。

---

## 七、不在本 spec 范围

- **输入补全的数据/交互层**：触发条件、provider 注册、accept 行为、ghost text 计算等——见 [input-typeahead.md](./input-typeahead.md)
- **REPL 主循环结构**：会话恢复、agent loop、命令分派等——见 REPL 实现层
- **鼠标点击交互**：P7 不引入鼠标基础设施（性价比不匹配）

---

## 八、相关代码引用

- 设计语言：`research/design/specifications/cli-ui-design-language.md` P7
- 现 chrome 实现：`packages/cli/src/tui/chrome.ts`
- 点阵纹理高亮：`packages/cli/src/tui/section.ts: highlightDottedRow`
- 现 typeahead 输入层：`packages/cli/src/typeahead-input.ts`
- 现 typeahead panel 渲染：`packages/cli/src/tui/typeahead-panel.ts`
- 底部信息行：`packages/cli/src/bottom-info/`（`BottomInfoModel` 来源无关容器 + `renderBottomInfoLine` 双区布局纯函数）
