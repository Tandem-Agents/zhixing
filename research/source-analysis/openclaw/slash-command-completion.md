# Slash Command 输入补全 — OpenClaw 源码解析

> **所属系统**: OpenClaw | **分析状态**: 已完成
> **信息来源**:
> - CLI (TUI) 侧:
>   - `openclaw-main/src/tui/tui.ts` L1-50, L417-436（Editor 装配 + Provider 组合）
>   - `openclaw-main/src/tui/components/custom-editor.ts` 全文（键位扩展）
>   - `openclaw-main/src/tui/commands.ts` 全文（SlashCommand 数据组装）
>   - `openclaw-main/src/tui/commands.test.ts`、`src/tui/components/custom-editor.test.ts`（行为断言）
> - Web (lit) 侧:
>   - `openclaw-main/ui/src/ui/chat/slash-commands.ts` 全文（注册表 + 过滤函数）
>   - `openclaw-main/ui/src/ui/views/chat.ts` L28, L487-537（trigger + 状态机）、L539-608（选择/Tab/arg 转场）、L1040-1101（键盘分派）、L133-151（view state 形状）
> - 命令共享源:
>   - `openclaw-main/src/auto-reply/commands-registry.types.ts` L1-50（`ChatCommandDefinition` / `CommandArgDefinition`）
>   - `openclaw-main/src/auto-reply/commands-registry.shared.ts`（`buildBuiltinChatCommands()`，CLI + Web 共享）

## 模块定位

OpenClaw 是**双前端**应用（CLI `src/tui/` + Web `ui/src/ui/`），两个前端各自实现输入补全 UI，但**共享一份命令注册表**（`src/auto-reply/commands-registry.shared.ts`）。CLI 侧把渲染/状态机整体委托给第三方 TUI 框架 `@mariozechner/pi-tui`；Web 侧则自己用一个两段式状态机手搓，没有复用任何通用 dropdown 组件。

## 目录结构 / 关键文件

共享命令源（CLI + Web 都读）：
```
src/auto-reply/
├── commands-registry.shared.ts     # buildBuiltinChatCommands() 返回 ChatCommandDefinition[]
├── commands-registry.types.ts      # ChatCommandDefinition / CommandArgDefinition 类型
└── commands-registry.ts            # listChatCommands / listChatCommandsForConfig
```

CLI / TUI 侧：
```
src/tui/
├── tui.ts                          # L417 装配 CustomEditor；L425-436 setAutocompleteProvider
├── commands.ts                     # getSlashCommands(cfg, provider, model) → SlashCommand[]
└── components/
    └── custom-editor.ts            # 继承 pi-tui Editor，覆盖一层快捷键
```

Web 侧（Lit 框架）：
```
ui/src/ui/
├── chat/
│   ├── slash-commands.ts           # SLASH_COMMANDS 常量 + getSlashCommandCompletions(filter)
│   └── slash-command-executor.ts   # 执行选定命令（本地 RPC 或发送给 agent）
└── views/
    └── chat.ts                     # L487 updateSlashMenu + L1040 handleKeyDown
```

## 核心数据结构

### 共享层（`commands-registry.types.ts`）

```typescript
type ChatCommandDefinition = {
  key: string;                       // 唯一 id（英文 kebab）
  description: string;
  textAliases: string[];             // 以 "/" 开头的别名
  args?: CommandArgDefinition[];
  // ...
};

type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  choices?: CommandArgChoice[] | CommandArgChoicesProvider;
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};

type CommandArgChoice = string | { value: string; label: string };
```

### CLI 层（`commands.ts`）

把 `ChatCommandDefinition` 投影成 pi-tui 要求的 `SlashCommand` 形状：

```typescript
// 由 @mariozechner/pi-tui 定义
type SlashCommand = {
  name: string;
  description: string;
  getArgumentCompletions?: (prefix: string) => { value: string; label: string }[];
};
```

### Web 层（`slash-commands.ts`）

```typescript
type SlashCommandDef = {
  key: string;
  name: string;
  aliases?: string[];
  description: string;
  args?: string;                     // 人读提示如 "<on|off>"
  icon?: IconName;                   // 菜单里的图标
  category?: "session" | "model" | "agents" | "tools";
  executeLocal?: boolean;            // 选中即本地执行（非 RPC）
  argOptions?: string[];             // 固定取值枚举
  shortcut?: string;                 // 菜单里显示快捷键提示
};
```

### Web 层视图状态（`chat.ts` L133-151）

```typescript
vs.slashMenuOpen: boolean;
vs.slashMenuItems: SlashCommandDef[];
vs.slashMenuArgItems: string[];
vs.slashMenuCommand: SlashCommandDef | null;
vs.slashMenuIndex: number;
vs.slashMenuMode: "command" | "args";   // ← 两段式状态机
```

## 触发与状态机

### CLI 侧

**完全委托给 pi-tui 的 `Editor`**。OpenClaw 的 `CustomEditor` 只覆盖了**除补全之外**的快捷键（`Alt+Enter` 提交、`Ctrl+L/O/P/G/T`、`Esc`、`Ctrl+C/D`），并通过 `this.isShowingAutocomplete()` 判断当前是否处于补全态，**在补全态里 `Esc` 交还给父类**（`custom-editor.ts:49`）：

```typescript
if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
  this.onEscape();  // 只有非补全态才让 Esc 取消整个输入
  return;
}
```

换句话说：补全态的触发检测、候选下拉、键位（↑↓/Tab/Enter）都**不在 OpenClaw 代码里**，而是 `pi-tui` 库的 `Editor.setAutocompleteProvider()` 协议。

### Web 侧（手搓状态机）

入口是 `updateSlashMenu(value)`（`chat.ts:487`），每次 draft 变化触发：

```typescript
// chat.ts:522-535（简化）
const match = value.match(/^\/(\S*)$/);
if (match) {
  const items = getSlashCommandCompletions(match[1]);
  vs.slashMenuItems = items;
  vs.slashMenuOpen = items.length > 0;
  vs.slashMenuIndex = 0;
  vs.slashMenuMode = "command";
} else {
  vs.slashMenuOpen = false;
}
```

**Trigger 严格**：`^\/(\S*)$` —— 必须整个 draft 以 `/` 开头且**后面是连续非空白**，也就是"草稿只有一个 slash 表达式"时才弹菜单；一旦出现空格**有可能**进入下面的 arg 模式。

Arg 模式的进入条件（`chat.ts:499-515`）：草稿形如 `/<cmd> <argPrefix>` 且 `cmd.argOptions` 非空；这时切到 `slashMenuMode = "args"`，菜单内容变成 `cmd.argOptions.filter(startsWith(argPrefix))`。

整体状态机：

```
  draft 变化
      │
      ▼
  regex /^\/(\S*)$/
      │ 命中
      ▼
  command 模式  ◀──── 首次进入 / Esc / 无匹配
      │ 选中一个带 argOptions 的命令
      ▼
  args 模式  (先 /cmd <空格> 进入，再按 argOptions 过滤)
      │ 选中一个 arg
      ▼
  执行 or 填充 draft（视 execute 布尔）
```

## 候选来源与注册机制

三层合并：

1. **内建静态列表**
   - CLI `commands.ts:61-122` 是一个长 literal：`help / status / agent / agents / session / model / think / fast / verbose / reasoning / usage / elevated / activation / abort / new / reset / settings / exit / quit`
   - Web `slash-commands.ts` 通过 `buildBuiltinChatCommands()` 从共享 registry 生成，然后叠一层 `UI_ONLY_COMMANDS`、图标覆盖、类别覆盖、`executeLocal` 标注

2. **别名扩展**
   - CLI 的 `COMMAND_ALIASES` map（`commands.ts:24`）—— 如 `elev → elevated`
   - 共享 `textAliases: string[]` —— 如 `/c` 可能是 `/context` 的别名，被 `seen` 去重

3. **运行时动态注入（gateway commands）**
   - CLI：`getSlashCommands()` 末尾循环 `listChatCommandsForConfig(cfg)`，把配置里启用的 gateway 命令合并进来（`commands.ts:125-136`）
   - Web：`SLASH_COMMANDS` 是 module-level 常量，**构建期冻结**，没有运行时刷新

没有 filesystem 扫描（例如读 `.openclaw/commands/*.md`），没有 plugin 动态注册到 UI 这一层（plugin 命令走 gateway 合并路径）。

## 过滤与排序算法

### CLI 侧

**不可见**：完全由 `pi-tui` 决定。OpenClaw 只负责提供候选项，过滤算法是库内部实现。从测试行为（`commands.test.ts:19-25`）可以看到 arg 级补全用 prefix 匹配（`v.startsWith(prefix.toLowerCase())`），命令级补全估计也是 prefix。

### Web 侧（`slash-commands.ts:218-243`）

```typescript
export function getSlashCommandCompletions(filter: string): SlashCommandDef[] {
  const lower = filter.toLowerCase();
  const commands = lower
    ? SLASH_COMMANDS.filter(
        (cmd) =>
          cmd.name.startsWith(lower) ||
          cmd.aliases?.some((alias) => alias.toLowerCase().startsWith(lower)) ||
          cmd.description.toLowerCase().includes(lower),
      )
    : SLASH_COMMANDS;
  return commands.toSorted((a, b) => {
    // 先按 CATEGORY_ORDER: session → model → tools → agents
    // 再按 "exact prefix match" 优先（name startsWith）
  });
}
```

- **匹配三路**：`name` prefix、`alias` prefix、`description` substring —— 描述走 substring 是个有意的妥协，允许"搜描述关键词"
- **排序**：类别 → prefix 命中优先 → 原顺序（stable）
- **没有最近使用（MRU）排序、没有频度加权**
- **没有 fuzzy 评分**：OpenClaw 整个补全路径都是 prefix / substring，不引入编辑距离类算法

## 渲染层：CLI

**完全不在 OpenClaw 代码里**。`src/tui/tui.ts:425-436`：

```typescript
editor.setAutocompleteProvider(
  new CombinedAutocompleteProvider(
    getSlashCommands({ cfg: config, provider, model }),
    process.cwd(),
  ),
);
```

`CombinedAutocompleteProvider` 来自 pi-tui。从构造参数可以**逆向推测**它至少支持两类补全合并：

- `SlashCommand[]` —— 当文本以 `/` 触发时
- `cwd: string` —— 当触发 `@file` 路径补全时（推测）

pi-tui 自带 `Editor` widget，render 由它一并管理。OpenClaw 没有对补全弹层做任何视觉定制（没有 theme override、没有自定义 item renderer）。

## 渲染层：Web

**手搓**的 lit 模板，不是独立组件，就写在 `chat.ts` 的 template 里。关键特征：

- **两段式菜单**：`slashMenuMode === "command"` 时显示命令列表（按 category 分组、每项带 icon/description/args 提示）；切换到 `"args"` 模式时显示当前命令的参数选项列表
- **定位**：绝对定位浮层，锚在输入框上方
- **鼠标 + 键盘协同**：鼠标 hover / click 通过 `@click=${() => selectSlashCommand(...)}` 走同一个 select 函数
- **没有虚拟滚动**：命令总数很小（~25 个），直接全渲染

## CLI 与 Web 是否共享抽象

**只共享数据，不共享 UI 逻辑**。共享层止步于 `buildBuiltinChatCommands()` 返回的 `ChatCommandDefinition[]`。从那之后：

| 责任 | CLI | Web |
|---|---|---|
| 投影到本层数据结构 | `tui/commands.ts#getSlashCommands()` → `SlashCommand[]` | `ui/chat/slash-commands.ts#SLASH_COMMANDS` → `SlashCommandDef[]` |
| 触发检测 | pi-tui 内部 | `updateSlashMenu()` 正则 |
| 过滤算法 | pi-tui 内部 | `getSlashCommandCompletions()` |
| 菜单渲染 | pi-tui `Editor` widget | `chat.ts` lit template |
| 键盘分派 | pi-tui `Editor.handleInput` | `chat.ts#handleKeyDown` |
| 选中后行为 | pi-tui + `tui-submit-handler` | `selectSlashCommand` / `selectSlashArg` |

**两份独立实现，两份独立键盘状态机**。这是 OpenClaw 这一块最大的架构税 —— 新增一个交互（如"选中后 Tab 进入子菜单"），CLI 和 Web 两边都得改一遍。

## 键盘交互协议

### CLI 侧（pi-tui 默认 + OpenClaw 覆盖）

| 按键 | 行为 | 出处 |
|---|---|---|
| ↑ / ↓ | 菜单选择（pi-tui 默认） | pi-tui |
| Enter | 接受当前项（pi-tui 默认） | pi-tui |
| Tab | 推测是 select 而非 fill（pi-tui 默认） | pi-tui |
| Esc | **补全态内**：关闭补全（pi-tui）；**非补全态**：交给 `onEscape` 清空输入 | `custom-editor.ts:49` |
| Ctrl+C | 清空/退出（OpenClaw 覆盖） | `custom-editor.ts:53` |
| Ctrl+D | 空输入时退出，否则无效 | `custom-editor.ts:57` |
| Alt+Enter | 提交（换行 vs 发送的倒置） | `custom-editor.ts:17` |
| Alt+↑ | 出队（历史） | `custom-editor.ts:21` |
| Ctrl+L/O/P/G/T、Shift+Tab | 自定义应用快捷键 | `custom-editor.ts:25-48` |

### Web 侧（`chat.ts#handleKeyDown` L1040-1101）

| 按键 | command 模式 | args 模式 |
|---|---|---|
| ArrowDown | `index = (index+1) % len` | 同 |
| ArrowUp | `index = (index-1+len) % len` | 同 |
| Tab | `tabCompleteSlashCommand` —— 填充 draft 到 `/<name> ` 但**不执行**，若有 argOptions 则进入 args 模式 | `selectSlashArg(..., execute=false)` —— 填充 draft 不执行 |
| Enter | `selectSlashCommand` —— 若 `executeLocal && !args` 直接执行；否则填充 draft 到 `/<name> ` 等用户补参 | `selectSlashArg(..., execute=true)` —— 填充并**立刻执行** |
| Escape | 关菜单 + `resetSlashMenuState()` | 同 |

**关键语义差异**：
- **Tab 和 Enter 在 command 模式下语义不同** —— Tab 是"填充"，Enter 是"填充并（可能）执行"。对于 `executeLocal` 无参命令（如 `/help`、`/stop`），Enter 直接跑完；Tab 仅填充等你确认。
- **args 模式的 Enter 永远 execute**，Tab 永远只填充 —— 参数选完即视作想执行。
- **循环导航**而非 clamp（末尾下一个跳回首项），符合大多数桌面 menu 的习惯。

## 多触发前缀支持

- **CLI**：`CombinedAutocompleteProvider(slashCommands, cwd)` 的第二参数强烈暗示 pi-tui 支持某种 `@file` 路径补全（`cwd` 只有当你想 resolve 相对路径时才会传进来）—— 但具体触发前缀不在 OpenClaw 代码里，需要读 pi-tui 源码确认。
- **Web**：**只有 `/`**。整份代码没有 `@file`、`#memory`、`:emoji` 等其他前缀的任何处理。

这意味着：OpenClaw 的 Web 聊天框相比 Claude Code 的 Ink UI 在"触发前缀丰富度"上是落后的 —— 只有一个入口。

## 值得偷的设计

1. **共享命令数据源 + 各自渲染** —— 这是知行未来跨 TUI/Web/驭灵 的范式。命令定义（name、description、aliases、args spec、executeLocal 标志、icon、category）应该放在 `packages/core` 或独立的 `packages/commands-registry`，CLI 和未来的 Web/微信/钉钉 renderer 各自消费。
2. **两段式菜单（command → args）**：对于有 `argOptions` 的命令（比如 `/fast <status|on|off>`），选中命令后在**同一个浮层**里切换到参数选项而不是弹新窗口，UX 很连贯。知行可以直接套到 TerminalConfirmationRenderer 的浮层上（它已经有状态切换的能力）。
3. **Tab / Enter 的语义分离**：Tab 填充不执行、Enter 执行。这一条比 Claude Code 的"Tab==Enter"更符合熟练用户预期（很多人习惯 Tab 补全然后手动敲参数）。
4. **`executeLocal` 标志**：区分"本地立即跑完（/help、/stop）"和"发送给 agent（/focus、/skill）"。这是一个很朴素但常被忽略的设计 —— 本地命令不应该产生模型 turn，浪费 token。
5. **静态内建 + 动态注入的双层合并**：`seen` set 去重、别名展平 —— 未来 MCP / plugin 的命令注入路径可以直接套这个模式。
6. **类别排序 + prefix 优先的混合排序**：比纯 prefix 或纯 fuzzy 都更像人的心智模型 —— "按功能分类先归类，再按匹配质量排序"。

## 值得警惕的坑

1. **两份独立实现的复制成本**：CLI 的 `commands.ts:getSlashCommands` 和 Web 的 `slash-commands.ts:SLASH_COMMANDS` 是**两份平行投影**，同一条共享源被手动映射两次。新增命令要改两边。知行要设计通用 `CommandRegistry` 从 core 层单源生成，**不要复制这个教训**。
2. **构建期冻结 vs 运行时刷新**：CLI 的 `updateAutocompleteProvider()`（`tui.ts:425`）被包在一个箭头函数里是为了**支持 provider/model 切换时重建 provider**（因为 `/think` 的 levels 依赖当前 provider）。Web 的 `SLASH_COMMANDS` 是 module const，**改 provider 后不会刷新**。这是个静默 bug 源——知行应该要么全部动态，要么全部静态，不要不一致。
3. **Description substring 匹配的噪声**：`cmd.description.toLowerCase().includes(lower)` 在 filter 长度 >2 时还行，输入单字符时会把几乎所有命令都留下。Web 侧这个分支在 UX 上容易"感觉菜单没过滤"。知行要么加最短长度阈值，要么分两列（名字命中列 + 描述命中列）。
4. **Regex trigger 太严格**：`^\/(\S*)$` 要求整个草稿就是一个 slash 表达式 —— 用户写了几段文字后在中间输入 `/` **不会**弹菜单。这违背"我随时可以 `/` 插入命令"的直觉。（CLI 的 pi-tui 版本可能不同，不确定）
5. **CLI 把核心 UX 交给第三方库**：`@mariozechner/pi-tui` 的 `Editor` + `CombinedAutocompleteProvider` 是**黑盒**，theme、item renderer、排序策略全部不可定制。升级库版本时如果对方改了键位/外观 OpenClaw 就被动。知行已经决定自研 TUI，不会踩这个坑 —— 但要警惕**不要为了省事把补全做成"只接收 items 数组"的黑盒 widget**，至少要暴露 filter / sort / render item 三个 hook。
6. **别名 aliased -> description 的混淆**：别名在 CLI 侧是把 alias **当成独立命令条目**（`commands.ts:134` 的 `commands.push({name, description})`），导致菜单里 `/elev` 和 `/elevated` 是两行。Web 侧则是把 aliases 放在主条目里。两边行为不一致。

## 和知行当前状态的对比

**知行目前的状况**：完全没有 slash 补全，REPL 是纯行缓冲 readline。Phase 1 确认模块里新做的 `SelectWithInput`（raw-mode 自研）有方向键+内嵌 input 的能力，但那是一次性组件（进入→收决定→退出），不是常驻的 input-time suggestion。

**可以直接套的**：
- **共享 `CommandRegistry` 放在 `packages/core/src/commands/registry.ts`**：定义 `ChatCommandDefinition`（name、aliases、description、args spec、category、executeLocal）。CLI 消费后生成 `SuggestionProvider`，未来 Web renderer 直接复用。
- **两段式 command→args 状态机**：可以复用到知行 TUI 的 prompt 输入框，和现有 `SelectWithInput` 风格一致。
- **`executeLocal` 标志**：知行的 slash 命令（`/exit`、`/help`、`/model`）应该分清楚哪些是**纯 CLI 动作**（不产生 model turn），哪些是**发送 system message 给 agent**。
- **共享源 + 单源投影**原则（但要汲取 OpenClaw 的教训，避免双投影）。

**需要重新设计的**：
- **TUI 渲染层**：OpenClaw CLI 依赖 pi-tui 黑盒，知行 TUI 要自己实现 "prompt 输入框 + 下方浮层" 的合成。好在知行已经有 `SelectWithInput`（§6.4 cursor 不变量已验证），可以把"浮层 = SelectWithInput 的常驻变种"做出来：每次 `draft` 变化 → `suggestionProvider.query(draft)` → 重绘浮层。难点是**把现有的一次性组件改造成 lifecycle 受 trigger 控制的常驻组件**（进入 input 时挂载，trigger 失配时卸载，整个过程不能破坏 §6.4 的 cursor 不变量和陷阱 3 的 stdin 独占护栏）。
- **多触发前缀抽象**：知行从一开始就应该设计 `SuggestionProvider` 接口，`/`、`@file`、`#memory` 走同一个 dispatch，而不是像 OpenClaw Web 那样硬编码单个 `/` 正则。建议的接口：

  ```typescript
  interface SuggestionProvider {
    readonly triggerChar: string;
    match(draft: string, cursor: number): TriggerContext | null;
    query(ctx: TriggerContext): Promise<SuggestionItem[]>;   // async for @file
    accept(item: SuggestionItem, draft: string): { newDraft: string; execute: boolean };
  }
  ```

- **Regex trigger 重新设计**：OpenClaw 的 `^\/(\S*)$` 太严格，知行应该**基于光标位置**判断是否处于触发上下文（光标在开头 OR 光标前是空白 OR 光标紧跟 trigger char），这样允许"写了半句话中间插 `@file`"的场景。
- **Async 候选 + loading 状态**：`@file` 需要读文件系统，知行的 `SuggestionProvider.query` 必须是 async 的，浮层要能显示 loading 骨架 —— OpenClaw 两个前端都是纯同步候选源，没有这个模式可抄。
