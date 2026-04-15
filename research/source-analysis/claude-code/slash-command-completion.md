# Slash Command 输入补全 — Claude Code 源码解析

> **所属系统**: Claude Code | **分析状态**: 已完成
> **信息来源**（行号基于 cleanroom deobfuscated 源码，路径相对 `E:/Dev/longxia/_refs/claude-code-analysis/`）:
> - 触发/过滤核心：`src/utils/suggestions/commandSuggestions.ts` L1-567 全文
> - 命令解析：`src/utils/slashCommandParsing.ts` L1-60 全文
> - Typeahead 状态机：`src/hooks/useTypeahead.tsx` L1-1384（重点 L353-884 的 `updateSuggestions` dispatcher；L944-1225 的 Tab/Enter 分派）
> - PromptInput 宿主：`src/components/PromptInput/PromptInput.tsx` L960-1140（suggestions state、useTypeahead 装配、onSubmit guard）
> - 建议渲染：`src/components/PromptInput/PromptInputFooterSuggestions.tsx` L9-292（`SuggestionItem`、`SuggestionType`、`OVERLAY_MAX_ITEMS=5`、虚拟滚动窗口）

## 模块定位

Claude Code 的输入补全是**单一 typeahead 状态机**，一个 React Hook (`useTypeahead`) 同时处理 7 种触发类型（command/file/directory/agent/shell/custom-title/slack-channel），通过一个 `suggestionType` enum 分派。渲染层在 Ink（React-for-CLI）的 `PromptInputFooterSuggestions` 组件里。整个子系统的精神是：**一个 cursor-aware 的调度器，七种 provider，异步优先**。

## 目录结构 / 关键文件

```
src/
├── utils/
│   ├── slashCommandParsing.ts                 # parseSlashCommand / isMcp
│   └── suggestions/
│       ├── commandSuggestions.ts              # Fuse 索引 + 过滤 + 排序 + 分类（核心）
│       ├── directoryCompletion.ts             # /add-dir 的路径补全
│       ├── shellHistoryCompletion.ts          # bash 模式历史补全
│       ├── slackChannelSuggestions.ts         # #channel
│       └── skillUsageTracking.ts              # MRU 评分
├── hooks/
│   ├── useTypeahead.tsx                       # 单一调度器（1384 行）
│   └── unifiedSuggestions.ts                  # @file / @mcp / @agent 合并
├── commands.ts                                 # Command 类型 + getCommand / getCommandName
└── components/
    └── PromptInput/
        ├── PromptInput.tsx                    # 宿主组件，Ink useInput 键盘分派
        └── PromptInputFooterSuggestions.tsx   # 渲染（Ink <Box>），虚拟滚动窗口
```

## 核心数据结构

### `Command`（`commands.ts`）

Claude Code 的命令不是单一 literal list，而是**多源合并**的：

```typescript
type Command =
  | { type: 'local'; name: string; ... }                    // 纯 JS 本地命令
  | { type: 'local-jsx'; name: string; component: ... }     // 本地命令带 JSX UI
  | {
      type: 'prompt';                                        // filesystem 加载的用户命令
      name: string;
      kind: 'command' | 'workflow';                          // workflow 带 tag 显示
      source:
        | 'userSettings'                                     // ~/.claude/commands/*.md
        | 'localSettings'                                    // 同上但 local
        | 'projectSettings'                                  // .claude/commands/*.md
        | 'policySettings'                                   // 企业策略注入
        | 'plugin';                                          // 插件
      pluginInfo?: { repository: string };
      description?: string;
      aliases?: string[];
      argNames?: string[];                                   // ← 决定参数提示
      argumentHint?: string;                                 // 静态 hint 字符串
      isHidden?: boolean;                                    // ← 支持 hidden 命令
    };
```

### `SuggestionItem`（`PromptInputFooterSuggestions.tsx:9`）

```typescript
export type SuggestionItem = {
  id: string;               // 唯一 id，冲突策略见下
  displayText: string;
  tag?: string;              // 如 "workflow"
  description?: string;
  metadata?: unknown;        // 对 command 来说是 Command 对象本身
  color?: keyof Theme;
};

export type SuggestionType =
  | 'command'      // slash commands
  | 'file'         // @file / @mcp:resource / @agent 统一
  | 'directory'    // /add-dir 的路径补全
  | 'agent'        // @team-member 直接消息
  | 'shell'        // bash 模式的 shell history
  | 'custom-title' // /resume 的自定义 title 搜索
  | 'slack-channel'// #channel（MCP）
  | 'none';

export const OVERLAY_MAX_ITEMS = 5;
```

`id` 生成规则（`commandSuggestions.ts:233`）：
- `prompt` 类型：`${name}:${source}`，plugin 还会附加 repository（`${name}:plugin:${repo}`），**同名不同 source 不去重**
- `local` / `local-jsx`：`${name}:${type}`

### Fuse 索引 `CommandSearchItem`（`commandSuggestions.ts:14`）

```typescript
type CommandSearchItem = {
  descriptionKey: string[];    // description 拆词，每个词 cleanWord() → 小写纯字母数字
  partKey: string[] | undefined; // commandName 按 [:_-] 切分后的词
  commandName: string;
  command: Command;
  aliasKey: string[] | undefined;
};
```

## 触发与状态机

### 单一调度器 `useTypeahead.updateSuggestions(value, cursorOffset)`

这个函数是整个补全的**唯一入口**（`useTypeahead.tsx:533`）。每次 `input` 变化触发（通过 effect at L907）。它按**优先级顺序**逐个尝试触发类型：

```
  input 变化 (void updateSuggestions(input))
        │
        ▼
  ┌─────────────────────────────────────────┐
  │ 1. suppressSuggestions? → clear return   │  历史搜索/索引 >0 时全局关闭
  ├─────────────────────────────────────────┤
  │ 2. mode=prompt + midInputSlashCommand    │  "help me /com" → ghost text
  │    命中 → ghost text（清 dropdown） return │
  ├─────────────────────────────────────────┤
  │ 3. mode=bash + shellHistoryCompletion    │  bash 历史 → ghost text
  │    命中 → ghost text return                │  + stale-input guard
  ├─────────────────────────────────────────┤
  │ 4. /(^|\s)@([\w-]*)$/                    │  @team-member / @agent
  │    命中 → suggestionType='agent' return  │  同步查 store
  ├─────────────────────────────────────────┤
  │ 5. mode=prompt + HASH_CHANNEL_RE         │  #channel
  │    命中且有 Slack MCP                    │  debouncedFetchSlackChannels
  │    → suggestionType='slack-channel' return│  （异步）
  ├─────────────────────────────────────────┤
  │ 6. mode=prompt + /add-dir <args>         │  命令参数里的路径补全
  │    → suggestionType='directory' return    │  await getDirectoryCompletions
  ├─────────────────────────────────────────┤
  │ 7. mode=prompt + /resume <title>          │  session title 搜索
  │    → suggestionType='custom-title' return │  await searchSessionsByCustomTitle
  ├─────────────────────────────────────────┤
  │ 8. mode=prompt + isCommandInput(value)   │  主 slash 命令路径
  │    + 光标位置合法 + 还没有"真正的参数"    │
  │    → commandArgumentHint OR               │
  │      generateCommandSuggestions(value)    │
  │      suggestionType='command' return      │
  ├─────────────────────────────────────────┤
  │ 9. HAS_AT_SYMBOL_RE                      │  @file / @mcp:resource / @agent
  │    命中 → debouncedFetchFileSuggestions   │  （异步、unified）
  │    → suggestionType='file' return         │
  └─────────────────────────────────────────┘
```

**关键点**：
- 所有优先级分支都查 `value.substring(0, effectiveCursorOffset)`，**不查整个 value**。这是"cursor-aware"的核心。
- Dispatcher 是 **async**，但尽量走同步分支（slash / @agent）；`#channel` 和 `@file` 走 debounced 异步分派。
- **Stale-input guard**：bash history 的 `latestBashInputRef.current !== value` 用于丢弃过期的异步结果（`useTypeahead.tsx:569`）。
- **抑制补全**：历史搜索模式下 `suppressSuggestions` 一关到底，用户翻历史时不被补全打扰。

### Mid-input slash 的特殊处理（`commandSuggestions.ts:114-154`）

Claude Code 支持**在一段文字中间**插入 `/command`，这是 vs. OpenClaw 最关键的 UX 差异。

```typescript
export function findMidInputSlashCommand(
  input: string,
  cursorOffset: number,
): MidInputSlashCommand | null {
  if (input.startsWith('/')) return null;    // 开头 slash 走另外的路径

  const beforeCursor = input.slice(0, cursorOffset);
  // 注意：刻意避开 lookbehind (?<=\s)，因为 JSC 的 YARR JIT 不支持
  const match = beforeCursor.match(/\s\/([a-zA-Z0-9_:-]*)$/);
  // ... 光标必须在 slash token 范围内才触发 ghost text
}
```

**性能注释**：源码里明确写了"Lookbehind `(?<=\s)` 会在 JavaScriptCore 里失活 YARR JIT，退回 O(n) 解释器" —— 所以改用 capture whitespace 再 `match.index + 1` 的算子风格。这是 Claude Code 为了 Safari / iOS / Node 原生 V8 里都快而做的微优化。

### 光标位置的精细判断（`useTypeahead.tsx:659`）

```typescript
const isAtEndWithWhitespace =
  effectiveCursorOffset === value.length &&
  effectiveCursorOffset > 0 &&
  value.length > 0 &&
  value[effectiveCursorOffset - 1] === ' ';
```

`isAtEndWithWhitespace` 用来判断 "刚敲完命令名按了个空格" → 此时应该显示参数 hint 而不是命令列表。这个状态和 "用户光标在中间" 是两回事，dispatcher 特地留了这个变量。

## 候选来源与注册机制

### 命令四源

1. **Built-in `local` / `local-jsx`**：直接写在代码里（`src/commands/*.tsx`）。`local-jsx` 带 React 组件用于更复杂的 UI（如 `/login`）。
2. **用户 filesystem**：`~/.claude/commands/*.md` → `source='userSettings'`。以 `.md` 文件名为命令名，frontmatter 提供 description / aliases / argNames / argumentHint / aliases / isHidden。
3. **项目 filesystem**：`<project>/.claude/commands/*.md` → `source='projectSettings'`。
4. **策略 / 插件**：`policySettings`（企业）、`plugin`（npm 包）。

加载后合并成 `Command[]`，memo 化后传入 `useTypeahead({ commands })`。

### Fuse 索引缓存（`commandSuggestions.ts:25-80`）

```typescript
let fuseCache: {
  commands: Command[];
  fuse: Fuse<CommandSearchItem>;
} | null = null;

function getCommandFuse(commands: Command[]): Fuse<CommandSearchItem> {
  if (fuseCache?.commands === commands) {    // 按引用身份缓存
    return fuseCache.fuse;
  }
  // ... 重建索引
  fuseCache = { commands, fuse };
  return fuse;
}
```

**关键**：按 `commands` **引用身份**而非内容缓存。这要求 REPL.tsx 侧 memo 化 commands 数组 —— 源码注释里明确说了"The commands array is stable (memoized in REPL.tsx), so we only rebuild when it changes rather than on every keystroke"。每次按键触发 re-render，但只要 commands 没变 Fuse 就不重建。

### Hidden 命令的 escape hatch（`commandSuggestions.ts:383-401`）

Fuse 索引过滤 `isHidden` 在**构建时**生效，意味着运行时把一个命令翻成 hidden，Fuse 索引还留着它。当用户**精确输入隐藏命令的名字**时，`generateCommandSuggestions` 手工 prepend 它到结果前面 —— 作为"用户已经知道这个命令存在，不应该被 UI 藏死"的逃生口。但如果**同名可见命令**存在，就**不** prepend（user override wins）。

## 过滤与排序算法

### Fuse 配置（`commandSuggestions.ts:53-76`）

```typescript
new Fuse(commandData, {
  includeScore: true,
  threshold: 0.3,        // 严格
  location: 0,           // 偏好开头匹配
  distance: 100,
  keys: [
    { name: 'commandName',   weight: 3 },   // 最高
    { name: 'partKey',       weight: 2 },   // 次高（commandName split [:_-]）
    { name: 'aliasKey',      weight: 2 },   // 同次高
    { name: 'descriptionKey',weight: 0.5 }, // 最低
  ],
});
```

### 空 query 的分类排序（`commandSuggestions.ts:309-380`）

输入只有 `/` 时不走 Fuse，而是手工分类：

```
recently used (top 5 by skill usage score)    ← MRU
  ↓
builtin (local / local-jsx)                    ← 按字母排序
  ↓
user commands (userSettings / localSettings)   ← 按字母排序
  ↓
project commands (projectSettings)             ← 按字母排序
  ↓
policy commands (policySettings)               ← 按字母排序
  ↓
other commands                                 ← 按字母排序
```

每组字母排序保证顺序稳定；recently used 是**跨所有 prompt 类命令**的 top 5。这意味着你频繁用 `/commit` 时 `/commit` 永远在最顶上，同时 `/help` `/status` 作为 builtin 仍然显示在前排。

### 非空 query 的自定义比较器（`commandSuggestions.ts:424-473`）

Fuse 返回后再 re-sort：

```
1. exact name match              → 最优
2. exact alias match
3. prefix name match             → 平局时**短名字优先**（更接近 exact）
4. prefix alias match            → 平局时**短别名优先**
5. fuse score
6. usage score                    → 相似 fuse score 的 tiebreaker
```

这个 resort 的意义：**Fuse 默认按 score 排，但 prefix/exact 匹配在 UX 上应该压过纯 fuzzy**。自定义比较器是对 Fuse 默认排序的修正。

### `getBestCommandMatch` 专供 ghost text（`commandSuggestions.ts:164`）

专门返回第一个"prefix name 匹配"的 suffix，用于 mid-input inline ghost text。不返回 fuzzy 匹配 —— ghost text 要求**毫不含糊**，用户打 `/com` 看到 ghost `mit`（直接补 `/commit`），不能看到 `/git-commit` 这种 fuzzy 结果。

## 渲染层

### 虚拟滚动窗口（`PromptInputFooterSuggestions.tsx:238`）

```typescript
const startIndex = Math.max(
  0,
  Math.min(
    selectedSuggestion - Math.floor(maxVisibleItems / 2),
    suggestions.length - maxVisibleItems,
  ),
);
const endIndex = Math.min(startIndex + maxVisibleItems, suggestions.length);
const visibleItems = suggestions.slice(startIndex, endIndex);
```

- `OVERLAY_MAX_ITEMS = 5`：一次最多显示 5 条（小屏也够用）
- **选中项居中**：startIndex 尝试让 selected 落在窗口中间
- 首尾 clamp：selected 在首 2 条时窗口靠上，在末 2 条时窗口靠下

### 渲染形态

- **Overlay 模式**：`overlay=true` 时是 `position=absolute` 浮层（Ink 把它当 layer）
- **Inline 模式**：`overlay=false` 时塞在 PromptInputFooter 里，跟 hint 条挤在一起
- **Icon dispatch**：`getIcon(itemId)` 按 id 前缀分配图标 —— `file-` 用 `+`，`mcp-resource-` 用 `◇`，`agent-` 用 `*`。这是 **"一个 SuggestionItem 数组里同时塞多种类型"** 的 unified 模式下的视觉区分。
- **截断策略**：
  - File id → `truncatePathMiddle` 保留首尾
  - MCP resource id → `truncateToWidth` 从尾截
  - 普通 → 不截
- **maxColumnWidth**：稳定宽度（`allCommandsMaxWidth` 来自全量命令的最长 displayText +5），避免过滤时列宽抖动

### SuggestionItemRow 的 memo 化

用了 React Compiler 生成的 `_c(36)` caching（`$[0]..$[35]` 手工 memo slot），避免大量 re-render。命令数组 30+ 时这个优化有意义。

## 键盘交互协议

键盘分派在 `useTypeahead.tsx` 的 Tab handler（L944 附近）和 Enter handler（L1140 附近），按 `suggestionType` 分支 —— 每个类型各自定义自己的 accept 行为。

| 按键 | command 模式 | file 模式 | directory 模式 |
|---|---|---|---|
| ↑ / ↓ | 移动 `selectedSuggestion`，索引 `clamp` | 同 | 同 |
| Tab | 填充 `/<name> `（`applyCommandSuggestion(shouldExecute=false)`） | 把 `@path` 替换为完整 path | 类似 |
| Enter | 填充 `/<name> ` + 若命令**无参数**则立即执行（`onSubmit(..., isSubmittingSlashCommand=true)`） | accept file | accept dir |
| Esc | 清空 suggestions | 同 | 同 |

**onSubmit 的 guard**（`PromptInput.tsx:1071-1077`）：

```typescript
const hasDirectorySuggestions = suggestions.every(s => s.description === 'directory');
if (suggestions.length > 0 && !isSubmittingSlashCommand && !hasDirectorySuggestions) {
  return; // Don't submit, user needs to clear suggestions first
}
```

**关键语义**：
- **有 suggestions 且不是 isSubmittingSlashCommand 时 Enter 被吞掉**，防止误触发。用户必须先按 Esc 或选一项。
- **directory suggestions 例外**：允许 Enter 提交（因为 Tab 是补全，Enter 是发送整条命令）
- **isSubmittingSlashCommand 标志**是 `applyCommandSuggestion` 选中**无参数命令**时专设，让自动提交绕过 guard

### Argument Hint（inline，非 dropdown）

命令选中后、开始输入参数时，dropdown 清空，改为显示 `commandArgumentHint` 字符串（`useTypeahead.tsx:730-770`）：

- **Priority 1**：命令定义了静态 `argumentHint`（仅在 "刚敲完空格" 那一瞬间显示）
- **Priority 2**：`prompt` 类型命令 + `argNames[]`，**progressive hint** —— 根据已输入的参数个数，渐进地显示下一个参数名（`generateProgressiveArgumentHint`）

这是 dropdown 之外的第二种补全反馈形态。

## 多触发前缀支持

**七种**触发都经过同一个 `updateSuggestions` dispatcher，共享 `suggestionsState` 和 `selectedSuggestion`：

| 触发 | trigger 正则 / 逻辑 | 候选源 | sync/async |
|---|---|---|---|
| `/command`（开头） | `isCommandInput(value)` | Fuse 索引 | sync |
| `/command`（mid-input） | `\s\/([a-zA-Z0-9_:-]*)$` | `getBestCommandMatch` → ghost text | sync |
| `@file` | `(^|\s)@([...])$` | `generateUnifiedSuggestions`（file + mcp + agent） | async（debounced fs 读） |
| `@team-member` | `(^|\s)@([\w-]*)$` | store.teamContext / agentNameRegistry | sync |
| `#channel` | `(^|\s)#([a-z0-9][...])$` | `debouncedFetchSlackChannels`（MCP RPC） | async（debounced） |
| `/add-dir <path>` | isCommandInput + 命令名 | `getDirectoryCompletions` | async（fs） |
| `/resume <title>` | isCommandInput + 命令名 | `searchSessionsByCustomTitle`（DB） | async |
| shell history（bash mode） | mode === 'bash' + value | `getShellHistoryCompletion` | async + stale guard |

**抽象共性**：
- 都叫 `SuggestionItem`，复用同一个 `PromptInputFooterSuggestions` 渲染
- 每个类型有独立的 Tab/Enter accept 函数（`applyTriggerSuggestion` / `applyFileSuggestion` / `applyDirectorySuggestion` / `applyCommandSuggestion` / ...）
- `suggestionType` state 告诉渲染器"这是一个什么类型的列表"，用于 icon 区分和 accept 分派

**没有抽象出来的部分**：
- 没有一个 `SuggestionProvider` 接口让外部插件注册新触发类型 —— 七种全部硬编码在 `updateSuggestions` 里
- 没有统一的 `trigger match` 函数 —— 每种用自己的正则，优先级靠**代码顺序**排

## 值得偷的设计

1. **Cursor-aware trigger 而非 draft-regex**：`value.substring(0, effectiveCursorOffset)` 作为 match 源。用户可以在"已经打了半句话"的中间位置插入 `/` `@` `#`，补全仍然正常工作。这是比 OpenClaw Web 的 `^\/(\S*)$` 高一个层级的 UX。知行应该**从一开始就是 cursor-aware**。
2. **单一 dispatcher 多 trigger**：一个 hook、一个 `SuggestionType` enum、一份 `selectedSuggestion` —— 而不是"每个触发一个独立组件"。这让"在同一个浮层里切换触发"变成可能（用户从 `/cmd` 切到 `/cmd @file`）。
3. **空 query 的分类+MRU**：仅打 `/` 时看到的不是 26 个命令按字母排序的墙，而是"最近用过的 5 个 → 内置 → 用户 → 项目 → 策略"。知行做之后要照抄这个 layered 视图。
4. **Fuse.js 按引用身份缓存 + REPL 层 memo 化**：按键重建索引是最大的性能陷阱。这个缓存策略把 index rebuild 降到"只在命令集真正变化时"（mid-session 加载新 plugin / 切换 project）。
5. **Fuse + 自定义 resort 两段式**：Fuse 做模糊命中，自定义比较器保证 "精确匹配 > prefix > fuzzy" 的优先级。两层叠加的好处：既能 fuzzy（打 `cmit` 找到 `commit`），又能保证用户打 `commit` 不会被 `pre-commit-hook` 之类的 fuzzy 结果挤下去。
6. **隐藏命令 escape hatch**：`isHidden` 不是"永远不可达"，用户打精确名字仍然能召唤出来。给了"一级用户 UX"和"超级用户能力"双重 affordance。
7. **Ghost text 只用 prefix 不用 fuzzy**：mid-input 的 inline 补全追求"毫不含糊"，和 dropdown 的容错模糊是完全不同的 UX 需求，分两个函数。知行做 ghost text 时一定要守住这条。
8. **Argument hint 独立于 dropdown**：`commandArgumentHint` 不占 dropdown 选择状态，是独立的 inline 提示字符串，两种还能 progressive 推进（`generateProgressiveArgumentHint`）。这是 OpenClaw 的 argOptions 做不到的 —— 知行可以组合两种：有 `argOptions` 走 dropdown（OpenClaw 风格），其他走 progressive hint（Claude Code 风格）。
9. **onSubmit 的 suggestions guard**：有候选项时 Enter 不触发提交，防止误操作。配合 `isSubmittingSlashCommand` 标志让 accept 路径可以穿透 guard。这是知行 `SelectWithInput` 未来并入 prompt 时必须抄的 guard。
10. **Stale-input guard**：异步分支必然有"结果回来时输入已经变了"的问题。`latestBashInputRef.current !== value` 是最小成本的解决方案 —— 比 AbortController 更直白，适用于纯 read 请求。
11. **`local` vs `local-jsx` 区分**：有些命令需要完整 UI（登录、设置），把它们标成 `local-jsx` 允许渲染 React 组件而不是只显示文本结果。知行如果以后命令要带 "选择器" "多步 wizard" 就需要这个区分。
12. **命令的 `kind` 分 workflow vs command**：`workflow` 类命令带 tag `workflow` 显示。暗示了"会串起多个 tool call"和"单次 action" 的 UX 区分。
13. **`@file` / `@mcp:resource` / `@agent` 统一触发（unified）**：三个概念一个 `@` 前缀，在同一个 dropdown 里按 id 前缀分配图标区分。简化用户心智模型（只有一个记号），同时保留了视觉区分。
14. **No-dedup across sources**：project 和 user 的同名 `/commit` 都显示 —— 用户有权知道"这个名字存在于两个源，我要选哪个"。避免了"默默被覆盖导致行为不一致"的陷阱。

## 值得警惕的坑

1. **`updateSuggestions` 是 1384 行单文件中最重的函数**：7 种 trigger 的优先级硬编码在顺序里，每加一种都得在 dispatcher 正确位置插入。**没有抽象 SuggestionProvider 接口**。这是 Claude Code 这一块最大的 tech debt —— 加第 8 个触发（比如知行的 `#memory`）会很痛苦。知行应该**从一开始**就抽 `SuggestionProvider` 接口，每个 provider 自己 declare priority + match。
2. **YARR JIT 的隐形陷阱**：`commandSuggestions.ts:131` 注释说了 lookbehind 会让 JSC 退回解释器、变成 O(n)。这是个底层知识，Node 的 V8 可能没这问题，但如果 Claude Code 未来跑在 Electron WebView（JSC）里就会变慢。知行如果以后跑在浏览器里（驭灵 Web），这个坑要知道。
3. **`getCommandFuse` 的 `fuseCache` 是模块级单例**：意味着多实例 REPL（未来的 subagent 面板）共享同一个缓存，若两个 commands 数组不同但结构相同会缓存击穿。知行如果有多实例，缓存要挂到 hook 的 ref 上而不是模块级。
4. **Fuse 把 `isHidden` 冻结在 build 时**：`isHidden` 运行时翻转时需要特殊处理（`hiddenExact` prepend 逻辑），否则会出现"我刚 unhide 的命令搜不到"的 bug。Claude Code 的 workaround 是个 patch 不是 fix —— 要么每次 isHidden 变化就 invalidate fuse cache，要么 runtime filter。知行更适合 runtime filter。
5. **触发优先级是隐式的代码顺序**：`updateSuggestions` 里 7 个 if/return 的顺序就是优先级 —— `#channel` 必须比 `@file` 靠前，`@team-member` 必须比 `@file` 靠前（"Must check before @ file symbol to prevent conflict" 的注释），但这都写在注释里而不是数据里。新增 trigger 很容易把顺序打乱。知行要**把 priority 做成 provider 的显式 numeric 字段**。
6. **`hasCommandArgs` 判断是 "包含空格且不以空格结尾"**：边界 case 是"`/cmd ` + 一个空格"被判为"正在开始输入参数，不显示建议"，但"`/cmd  ` + 两个空格" 也被判为"有参数"。这个微差异会让"`/cmd ` Tab 后又敲了个空格"的用户感到困惑。不严重，但要警惕。
7. **不同 source 同名命令都显示 = 列表长度可能爆炸**：如果一个用户在 user + project + plugin 三个地方都有 `/commit`，dropdown 里会有 3 条。OVERLAY_MAX_ITEMS=5 能装下，但再多就被截了。知行要考虑：到底是显示"只有最高优先级那条"还是"全都显示用户手动消歧义"。
8. **Mid-input slash 的正则不支持中文命令名**：`[a-zA-Z0-9_:-]` 只吃 ASCII。`/提交` 不工作。知行的国际化 UX 应该从一开始就用 `\p{L}\p{N}` Unicode 字符类（Claude Code 的 `@file` 用了，`/command` 没用，是历史遗留）。
9. **Ink / React Compiler 的 memo 复杂度**：`SuggestionItemRow` 用了 `_c(36)` 36 个 cache slot 的手工 memo。这是性能优化，但让代码可读性大幅下降，单元测试也更难。知行用自研 raw-mode TUI，不会有这个问题，但应该知道"为什么 Claude Code 要把组件写得这么丑" —— 是渲染频率（每次按键）和组件数（OVERLAY_MAX_ITEMS=5 每行多个子元素）的乘积太大。
10. **`suppressSuggestions` 由外部 prop 传入而非自治**：`isSearchingHistory || historyIndex > 0` 决定 —— 意味着补全 hook 无法自己判断"我应该抑制"，必须被宿主组件告知。这种"外部驱动抑制"的 coupling 是因为 Ink 的 useInput 有全局分发问题；知行的自研 TUI 可以让 provider 自治。

## 和知行当前状态的对比

**知行目前的状况**：
- `packages/cli/src/tui/select-with-input.ts` 已完成（Phase 1 Step 2），但是**一次性组件**（confirmation 用）—— 进入、收决定、退出
- REPL 的 prompt 输入还是纯 `readline.question`，**没有任何 typeahead**
- 没有命令注册表，slash commands 是零散的 if/else（如果有的话）

**可以直接套的**：
- **`SuggestionType` enum + 单一 `SuggestionItem` 数据类型**：知行应该从一开始就把 command / file / memory / agent 统一成一个 item 类型。
- **Cursor-aware match**（`value.substring(0, cursor)` + trigger regex）：知行的 SelectWithInput 已经有字符 buffer 和 cursor 概念，扩展成 "trigger detection" 不难。
- **按引用身份缓存命令索引**：知行用 Node 原生 Map/Trie 也行（zhixing 想自研 fuzzy 逻辑就更简单），但"按 commands 数组引用身份避免重建"这条必须抄。
- **空 query 分类+MRU**：知行需要一个 `SkillUsage` 跟踪模块，结构很简单（localStorage 式 JSON），直接抄过来。
- **Enter guard**：`hasSuggestions && !isSubmittingSlashCommand → ignore Enter`。配合 `SelectWithInput` 已有的 cancel/commit 分离语义，改造成 prompt 里的 typeahead 时必须带这条。
- **Argument hint 独立于 dropdown**：知行的渲染层分成"上方浮层"+"输入行"两层很自然，argument hint 就是输入行的 ghost。
- **Ghost text 用 prefix 不用 fuzzy**：两个独立 API，分清职责。

**需要重新设计的**：
- **`SuggestionProvider` 抽象**（Claude Code 没做，知行应该做）：

  ```typescript
  interface SuggestionProvider {
    readonly id: string;                 // "command" | "file" | "memory" | ...
    readonly priority: number;           // 数值越小越高优先级
    matchTrigger(ctx: InputContext): TriggerMatch | null;
    query(match: TriggerMatch): Promise<SuggestionItem[]>;
    accept(item: SuggestionItem, ctx: InputContext): AcceptResult;
    icon?: string;                        // 渲染用
  }

  interface InputContext {
    readonly draft: string;
    readonly cursor: number;
    readonly mode: "prompt" | "bash";
  }
  ```

  `Broker` 按 priority 顺序跑 `matchTrigger`，第一个非 null 胜出。避免 Claude Code "优先级=代码顺序"的隐式耦合。
- **异步 provider 的取消 / stale guard**：知行应该从一开始就用 `AbortController` 而不是 Claude Code 的 ref 比对 —— 更清晰、更通用（@file 的 fs 读可 abort）。
- **渲染分层适配驭灵**：Claude Code 的 Ink 组件和 CLI 紧耦合。知行要让 `PromptInputView` 接口抽象渲染（TTY / Web / 微信都能实现），和 confirmation-ux.md 的 renderer 分离原则对齐。TTY 版复用 `SelectWithInput` 的原地重绘 + cursor 不变量 + stdin 独占护栏（§6.4）。
- **Priority 显式化**：不要学 Claude Code "代码顺序即优先级"，而是每个 provider 显式声明 `priority: number`。未来加 `#memory`、`@tool` 就是新 provider，不碰旧代码。
- **Progressive argument hint**：Claude Code 的 `generateProgressiveArgumentHint` 是隐藏的 UX 亮点 —— 知行的 `CommandArgDefinition`（如果借鉴 OpenClaw 的 types）天然带 `name` 和 `required`，可以直接生成 hint。两家的设计正好互补。
- **命令源多源化 from day 1**：`local`/`prompt`/`plugin` 三源，配 source 字段。不要把命令写死成 literal 数组，否则未来加 filesystem 命令要大改。
- **Trigger 正则 Unicode**：`\p{L}\p{N}` 从一开始就用，避免 Claude Code `/command` 正则的中文支持遗憾。
