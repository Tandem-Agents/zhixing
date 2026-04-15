# Slash Command 输入补全 — Hermes Agent 源码解析

> **所属系统**: Hermes Agent | **分析状态**: 已完成
> **信息来源**（路径相对 `E:/Dev/longxia/_refs/hermes-agent-main/`）:
> - `hermes_cli/commands.py` L1-50（模块说明）、L37-50（`CommandDef` dataclass）、L56-230（`COMMAND_REGISTRY` literal 入库）、L240-274（`COMMANDS / SUBCOMMANDS / _PIPE_SUBS_RE` 派生结构）、L642-971（`SlashCommandCompleter`）、L978-1033（`SlashCommandAutoSuggest`）
> - `cli.py` L581（import）、L8155-8173（`SlashCommandCompleter + SlashCommandAutoSuggest + TextArea` 装配）
> - 关联：Telegram / Slack / Discord 的 gateway 分派也读同一份 `COMMAND_REGISTRY`（见 `slack_subcommand_map` / `GATEWAY_KNOWN_COMMANDS`）

## 模块定位

Hermes 的输入补全建立在 **prompt_toolkit** 之上，走的是"标准 `Completer` + `AutoSuggest` 子类化"的路径。整个交互模块的精神是：**一个中央 `COMMAND_REGISTRY` 喂全渠道**（CLI 自身补全、CLI help、Telegram BotCommand 注册、Slack `/hermes <sub>` 分派、Discord native slash command，全是同一份数据），补全逻辑只做 prefix 匹配 + prompt_toolkit 默认菜单渲染，几乎没有自定义 UI。整个补全实现不到 400 行。

## 目录结构 / 关键文件

```
hermes_cli/
├── commands.py                     # 1048 行：注册表 + Completer + AutoSuggest（本分析核心）
├── model_normalize.py              # 被 _model_completions 间接调用
└── model_switch.py                 # DIRECT_ALIASES / MODEL_ALIASES，给 /model 做动态补全
cli.py                              # 9268 行的主 CLI，L8155 装配 completer
```

所有补全相关代码**集中在 `hermes_cli/commands.py` 一个文件**，没有子模块。

## 核心数据结构

### `CommandDef` dataclass（`commands.py:37`）

```python
@dataclass(frozen=True)
class CommandDef:
    name: str                                  # "background"
    description: str                           # "Run a prompt in the background"
    category: str                              # "Session" | "Configuration" | ...
    aliases: tuple[str, ...] = ()              # ("bg",)
    args_hint: str = ""                        # "<prompt>" | "[normal|fast|status]"
    subcommands: tuple[str, ...] = ()          # ("normal", "fast", "status")
    cli_only: bool = False                     # 只在 CLI 里可用
    gateway_only: bool = False                 # 只在 gateway / messaging 里可用
    gateway_config_gate: str | None = None     # 配置 dotpath；true 时覆盖 cli_only
```

### 派生结构（`commands.py:240-274`）

从 `COMMAND_REGISTRY` 这一个 literal list 派生出多个"向后兼容"的查表结构：

```python
COMMANDS: dict[str, str] = {}              # "/background" -> "Run a prompt in the background (usage: /background <prompt>)"
COMMANDS_BY_CATEGORY: dict[str, dict[str, str]] = {}  # "Session" -> {"/background": "...", ...}
SUBCOMMANDS: dict[str, list[str]] = {}     # "/voice" -> ["on", "off", "tts", "status"]
GATEWAY_KNOWN_COMMANDS: frozenset[str]     # 所有 gateway 可见命令名 + 别名
```

**有意思的派生**：`SUBCOMMANDS` 有两种填充方式：

1. 显式 `CommandDef.subcommands` 字段（优先）
2. 从 `args_hint` 里**正则抽取** pipe-separated 列表（fallback）：

```python
_PIPE_SUBS_RE = re.compile(r"[a-z]+(?:\|[a-z]+)+")
for _cmd in COMMAND_REGISTRY:
    key = f"/{_cmd.name}"
    if key in SUBCOMMANDS or not _cmd.args_hint:
        continue
    m = _PIPE_SUBS_RE.search(_cmd.args_hint)
    if m:
        SUBCOMMANDS[key] = m.group(0).split("|")
```

这意味着 `args_hint="[on|off|tts|status]"` 会**自动**获得 tab 补全，无需再写一份 `subcommands=("on","off","tts","status")`。类型安全 vs. 代码重复的务实妥协。

### prompt_toolkit 原生类型

- `Completer` / `Completion` / `Suggestion` / `AutoSuggest` —— 来自 prompt_toolkit，Hermes 只做 subclass
- `Completion(text, start_position, display, display_meta)`：
  - `text` —— 实际替换到 buffer 的字符串
  - `start_position=-len(word)` —— 相对 cursor 的负 offset，告诉 prompt_toolkit 从哪里开始替换
  - `display` —— 菜单里看到的（和 `text` 可以不一样）
  - `display_meta` —— 右侧的描述列（通常放 command description）

## 触发与状态机

**Hermes 没有自己实现状态机**，完全依赖 prompt_toolkit 的 `PromptSession` + `TextArea(complete_while_typing=True)` 的内建补全生命周期：

```
  每次 buffer.text 变化（或 Tab 键触发）
       │
       ▼
  prompt_toolkit 调 completer.get_completions(document, complete_event)
       │
       ▼
  Hermes 的 SlashCommandCompleter.get_completions 根据 document.text_before_cursor 分派到：
       │
       ├── text.startswith("/") → slash 命令补全路径
       │       │
       │       ├── 有 space 或 trailing space → 子命令补全
       │       │       ├── base_cmd == "/model" → _model_completions (动态)
       │       │       └── 其他 → SUBCOMMANDS[base_cmd] (静态)
       │       └── 无 space → 命令名补全（COMMANDS + skill commands）
       │
       ├── _extract_context_word(text) 返回 @token → _context_completions
       │       （@ 静态引用 / @file: / @folder: / 裸 @ 路径）
       │
       └── _extract_path_word(text) 返回 path-like token → _path_completions
               （./、../、~/、/、包含 / 的词）
```

**没有显式状态机**：Hermes 每次 `get_completions` 都是**无状态分派**，不记录"当前在什么模式"。每个按键都重新根据 `document.text_before_cursor` 算一遍 trigger 类型。

**触发检测**是纯字符串前缀判断：

```python
# slash：必须整体以 "/" 开头
if not text.startswith("/"):
    # 试 @ 和 path
    ctx_word = self._extract_context_word(text)
    ...
```

`_extract_context_word` 和 `_extract_path_word` 都是"从 cursor 前最后一个空格往后"抽取 word，然后判 prefix：

```python
@staticmethod
def _extract_path_word(text: str) -> str | None:
    i = len(text) - 1
    while i >= 0 and text[i] != " ":
        i -= 1
    word = text[i + 1:]
    if not word:
        return None
    if word.startswith(("./", "../", "~/", "/")) or "/" in word:
        return word
    return None
```

这种"往后走到空格"的 token 抽取是 prompt_toolkit completer 的标准模式，和 Claude Code 的正则 match 思路等价，但更朴素。

## 候选来源与注册机制

### 四种候选源合并

1. **内建命令** `COMMANDS` dict（从 `COMMAND_REGISTRY` 派生）—— 单源真相，~80 个命令
2. **Skill commands** `_iter_skill_commands()` 回调 —— 运行时动态注入，构造时通过 `skill_commands_provider=lambda: _skill_commands` 传入
3. **Model aliases**（仅 `/model` 的参数补全）—— 从 `hermes_cli.model_switch.DIRECT_ALIASES` + `MODEL_ALIASES` 动态读
4. **静态 `@` context refs**：`@diff`、`@staged`、`@file:`、`@folder:`、`@git:`、`@url:` —— 硬编码在 `_context_completions` 里

### `command_filter` 运行时过滤

```python
def __init__(self, skill_commands_provider=..., command_filter=...):
    self._command_filter = command_filter
```

构造时注入一个 `command_filter: Callable[[str], bool]`，在 `get_completions` 里对每个候选调 `_command_allowed(cmd)` —— 允许 CLI 侧动态决定"此命令此刻是否可用"。例如：

- `cli_only` 的命令在 gateway 模式下被过滤
- 配置 gate 命中的命令在 CLI 里显示，反之隐藏
- 会话繁忙时某些命令被过滤（通过 `cli_ref._command_available` 判断）

**过滤是运行时的、每次 keystroke 都跑**，不是构建期一锤子。

### Skill commands 的动态注入

`skill_commands_provider` 是 lambda 闭包 `lambda: _skill_commands`，每次调用都读**当前**的 skill registry。这让 skill 热加载可以即时反映在补全里 —— 构造 Completer 时不需要 pin 一份快照。

Skill 命令在菜单里的视觉区分：`display_meta=f"⚡ {short_desc}"` —— 用闪电 emoji 和内建命令区分。描述截断到 50 字符。

## 过滤与排序算法

**纯 prefix 匹配**，大小写不敏感，**无排序**（迭代顺序即显示顺序）：

```python
word = text[1:]
for cmd, desc in COMMANDS.items():
    if not self._command_allowed(cmd):
        continue
    cmd_name = cmd[1:]
    if cmd_name.startswith(word):          # ← 唯一的过滤条件
        yield Completion(...)
```

**没有 fuzzy**（没有用 `prompt_toolkit` 的 `FuzzyCompleter` wrapper，没有 RapidFuzz/Levenshtein），**没有 description 搜索**，**没有 MRU / 频度排序**，**没有类别分组排序**。

迭代顺序是 `COMMANDS` dict 的插入顺序（Python 3.7+ dict 保序），也就是 `COMMAND_REGISTRY` literal 里的源顺序，约等于"按类别手写的声明顺序"。

排序哲学：**保持注册顺序**。category 分组靠声明时的物理相邻性实现，不在补全里 re-sort。

### 特殊情形：`_completion_text` 的 trailing space 补丁

```python
@staticmethod
def _completion_text(cmd_name: str, word: str) -> str:
    """...When the user has already typed the full command exactly (`/help`),
    returning `help` would be a no-op and prompt_toolkit suppresses the
    menu. Appending a trailing space keeps the dropdown visible and makes
    backspacing retrigger it naturally."""
    return f"{cmd_name} " if cmd_name == word else cmd_name
```

这是对 prompt_toolkit 的一个 workaround：当用户输入的词**恰好**和命令名相同，prompt_toolkit 会判断"替换后内容没变"然后**关闭菜单**。Hermes 通过追加一个空格让"替换"变成真替换，菜单保持可见。这个小 hack 揭示了 **prompt_toolkit 的 completion 管线有"如果 text 不变就压缩掉"的隐式行为** —— 知行如果未来模仿 prompt_toolkit 思路要小心这个坑。

### Path 补全的排序

`_path_completions` 有 `sorted(entries)` —— 按文件名字母排序。和 command 补全不同，这里显式排了。

## 渲染层：prompt_toolkit 的用法

### 在 `cli.py:8159` 装配

```python
input_area = TextArea(
    height=Dimension(min=1, max=8, preferred=1),
    prompt=get_prompt,                               # 动态 prompt（根据 agent 状态）
    style='class:input-area',
    multiline=True,                                  # shift+enter 换行
    wrap_lines=True,
    read_only=Condition(lambda: bool(cli_ref._command_running)),
    history=FileHistory(str(self._history_file)),
    completer=_completer,                            # ← SlashCommandCompleter
    complete_while_typing=True,                      # ← 实时（而非只在 Tab 触发）
    auto_suggest=SlashCommandAutoSuggest(
        history_suggest=AutoSuggestFromHistory(),
        completer=_completer,
    ),
)
```

**零自定义 UI**：补全菜单的位置、宽度、颜色、选择高亮、滚动条 —— 全部用 prompt_toolkit 默认。Hermes **没有**定义 `style = Style.from_dict({...})` 的补全相关 class，也没有 `CompletionsMenu` widget 定制。

**没有 `FloatContainer` 定制**：prompt_toolkit 的补全菜单是自动浮在 input 下方的，Hermes 不干预布局。

**`complete_while_typing=True`**：每次文本变化就触发补全（比 Tab-only 的 lazy 模式 UX 更好）。

### `SlashCommandAutoSuggest` 的 ghost text

这是 Hermes 补全里**除 dropdown 之外**的第二种反馈形态 —— inline ghost text。

```python
class SlashCommandAutoSuggest(AutoSuggest):
    def __init__(self, history_suggest=None, completer=None):
        self._history = history_suggest
        self._completer = completer

    def get_suggestion(self, buffer, document):
        text = document.text_before_cursor
        if not text.startswith("/"):
            # fallback: 用 history 里的前缀匹配
            if self._history:
                return self._history.get_suggestion(buffer, document)
            return None

        parts = text.split(maxsplit=1)
        base_cmd = parts[0].lower()

        if len(parts) == 1 and not text.endswith(" "):
            # /upd → Suggestion("ate")
            word = text[1:].lower()
            for cmd in COMMANDS:
                if not self._completer._command_allowed(cmd):
                    continue
                cmd_name = cmd[1:]
                if cmd_name.startswith(word) and cmd_name != word:
                    return Suggestion(cmd_name[len(word):])
            return None

        # 命令完整后 → 建议 subcommand
        sub_text = parts[1] if len(parts) > 1 else ""
        if base_cmd in SUBCOMMANDS and SUBCOMMANDS[base_cmd]:
            if " " not in sub_text:
                for sub in SUBCOMMANDS[base_cmd]:
                    if sub.startswith(sub_text.lower()) and sub != sub_text.lower():
                        return Suggestion(sub[len(sub_text):])

        # 最后 fallback 到历史
        if self._history:
            return self._history.get_suggestion(buffer, document)
```

**关键设计**：
- **prefix-only**：`Suggestion` 只返回剩余后缀，不做 fuzzy。和 Claude Code 的 `getBestCommandMatch` 同理 —— ghost text 必须无歧义。
- **history fallback 级联**：非 slash 文本的 ghost text 会走 `AutoSuggestFromHistory` —— 这是 prompt_toolkit 的内建类，从 `FileHistory` 里找前缀匹配的历史条目。
- **两级 suggestion**：先建议命令名，再建议 subcommand，分界是"已输入空格后"。

### 键盘交互：100% prompt_toolkit 默认

Hermes **不覆盖**补全相关的 key bindings：

- **Tab**：接受当前项（prompt_toolkit 默认）
- **↑ / ↓**：菜单导航（prompt_toolkit 默认，需要菜单打开中）
- **Enter**：提交 buffer；菜单打开时如果有选中项 prompt_toolkit 会先 accept selection —— 具体行为取决于 `complete_while_typing` 和选中状态的组合
- **Esc**：关闭菜单（prompt_toolkit 默认）
- **→ (right arrow)**：接受 auto_suggest 的 ghost text（prompt_toolkit 默认）

Hermes 的 paste collapsing、bracketed paste 等键位定制都**避开**了补全菜单相关的键，不干扰 prompt_toolkit 的补全 UX。

## 与 prompt_toolkit 生态的耦合度

**深度耦合**：`Completer.get_completions`、`AutoSuggest.get_suggestion`、`Completion`、`Suggestion`、`TextArea`、`Float`、`CompletionsMenu` —— 这套 API 全都来自 prompt_toolkit。`SlashCommandCompleter` subclass 模式天然假定了宿主是 prompt_toolkit 的 `PromptSession`/`TextArea`。

**但数据层完全独立**：`COMMAND_REGISTRY` 和 `CommandDef` 没碰任何 prompt_toolkit 类型。这让：

1. **gateway 侧（Telegram/Slack/Discord）** 能直接读 `COMMAND_REGISTRY` 做命令分派，不需要装 prompt_toolkit
2. **测试**可以纯数据地验证命令集
3. **如果要换 UI 框架**（比如 textual 或自研 TUI），需要重写的只是 `SlashCommandCompleter` + `SlashCommandAutoSuggest` 两个 class（~400 行），`COMMAND_REGISTRY` 原封不动

`commands.py:19-30` 还特地做了**惰性 import**：

```python
try:
    from prompt_toolkit.auto_suggest import AutoSuggest, Suggestion
    from prompt_toolkit.completion import Completer, Completion
except ImportError:  # pragma: no cover
    AutoSuggest = object  # type: ignore[assignment,misc]
    Completer = object
    Suggestion = None
    Completion = None
```

"gateway 和测试环境如果没装 prompt_toolkit，仍然能 import 这个模块去用 `resolve_command / gateway_help_lines / COMMAND_REGISTRY`"。补全类被降级成 object subclass（实际不会被实例化）。这是非常克制的一种兼容设计。

## 值得偷的设计

1. **单一中央 `COMMAND_REGISTRY` 喂多个前端**：Hermes 做到了知行在 confirmation-ux 架构里想要的"数据渲染分离"—— CLI 补全、gateway 分派、Slack 子命令映射、Telegram BotCommand 列表全部 derive 自同一份数据。知行的 `CommandRegistry` 应该直接抄这个模式，命令定义放在 `packages/core`，然后 CLI / future Web / gateway 分别 derive 自己的 view。
2. **`args_hint` 字符串双用**：既是 UI 显示的参数 placeholder（`"[normal|fast|status]"`），又是 tab 补全的**隐式子命令来源**（正则抽取 pipe 列表）。一个字段两个用途，避免"subcommands 写一遍 + args_hint 再写一遍"的冗余。知行可以照抄，甚至做得更明确 —— 直接在 CommandDef 上声明"args_hint 是 UI 的"+"subcommands 是 completion 的"的关系。
3. **`command_filter` 运行时过滤回调**：Completer 构造时注入 `lambda cmd: session_state.command_available(cmd)`，每次按键都跑。这让"会话繁忙时隐藏某些命令"、"feature flag 关闭命令"、"权限门控命令"都是一条 lambda 就搞定。知行的 `SuggestionProvider` 应该接受这种运行时过滤器。
4. **`skill_commands_provider` lambda 闭包**：把"skill registry 当前状态"作为 lambda 绑定进 Completer，补全时每次读最新值 —— 不需要"skill 加载时重建 Completer"的事件总线。知行的命令源如果有动态部分（plugin 热加载），用同样模式。
5. **惰性 prompt_toolkit import + 降级到 object**：让 registry 模块可以在无 UI 环境里 import，避免"想用命令元数据必须装 GUI 库"的坑。知行的 core/commands 模块应该对 TUI 零依赖。
6. **`gateway_config_gate` 的"条件归属"**：某命令默认 cli_only，但当配置 gate 路径为 true 时自动出现在 gateway 里。知行未来的"企业策略 / 用户配置开启某命令" 就是这个模式 —— 命令归属是条件表达式而不是硬编码。
7. **`_completion_text` trailing space 补丁**：深坑级别的知识。知行即使自研 TUI 也可能撞到类似的"替换后内容无变化就压缩菜单"的 state machine bug。记在心里。
8. **Ghost text 两级 fallback**：slash 命令级联 → subcommand 级联 → history 级联。三个层次的 hint 源统一在一个 `AutoSuggest` 里。知行的 ghost text 逻辑可以学这个层次化。
9. **`_extract_context_word` 和 `_extract_path_word` 的非正则实现**：纯循环回退到空格的 token 抽取比正则更好 debug、更快，而且对 Unicode 天然友好（只判 `text[i] != " "`）。知行的自研 trigger detection 可以用这个模式。
10. **静态 `@` context refs + 动态 `@file:` / `@folder:` / `@git:`**：有限的 context 类型（`@diff`、`@staged`、`@url:`）枚举出来，无限的（文件/文件夹）走 fs 读。枚举 + open-ended 混合模型。知行做 `@memory:` `@tool:` 等动态引用时可以参考。

## 值得警惕的坑

1. **完全没有 fuzzy**：用户打 `/cmmt` 找不到 `/commit`，打 `/bg` 只能靠显式 alias。对 ~80 命令的系统还撑得住，命令多了用户会迷路。知行如果未来命令数 > 50 必须上 fuzzy（参考 Claude Code 的 Fuse 方案）。
2. **没有排序**：按 `COMMAND_REGISTRY` 源顺序。这意味着常用的 `/new` 和罕用的 `/rollback` 同级出现，没有 MRU 提升常用项。对新用户看 dropdown 有帮助（按类别分组），对熟练用户无帮助。
3. **没有 description 搜索**：OpenClaw Web 侧做了 `description.includes(lower)` 的 fallback，Hermes 完全不管描述。用户记不住名字只记得"那个关于网络的命令"时找不到。
4. **菜单完全是 prompt_toolkit 默认样式**：没有类别分隔、没有 icon、没有 tag。和 Claude Code 的 workflow tag、OpenClaw Web 的 icon 对比明显简陋。对"高端公开仓库"的 UX 雄心是短板 —— 但这是 prompt_toolkit API 的限制，定制菜单 item 的渲染需要自己写 `MenuContainer`，工程量不小。
5. **`get_completions` 每次 keystroke 重建迭代器**：没有索引缓存（Claude Code 的 Fuse cache 策略），每次从头遍历 `COMMANDS.items()`。~80 命令无所谓，上千就会卡。
6. **gateway vs cli 的可见性耦合了注册表**：`gateway_only` / `cli_only` / `gateway_config_gate` 三个 bool 字段让 `CommandDef` 越来越像 feature flag 容器。加一种新环境（比如 "Web UI only"）就要再加字段。知行应该用**数组 / set** 表达可见性（`visibleIn: ["cli", "gateway"]`），而不是多个 bool。
7. **`_PIPE_SUBS_RE = /[a-z]+(?:\|[a-z]+)+/`** 只认小写字母：`args_hint="[On|Off]"` 不会被抽到 subcommands。这个正则对大写 / 数字 / `-` 都不工作。不影响现有 80 命令（都是小写），但未来 Locale / i18n 一来就坏。
8. **`_iter_skill_commands` 的 try/except 把所有异常都吞掉**：skill 注册表出问题会**静默**失败 —— 用户看不到 skill 命令补全但不知道为什么。至少应该 log。
9. **`_completion_text` 的 trailing space workaround 是运行时迷惑**：如果有人好奇"我明明选了 `/help`，为什么 buffer 变成 `/help ` 后面多了空格"，会花时间找 bug。源注释清楚但运行时观察会误导。
10. **prompt_toolkit 自己的坑会传染**：Hermes 依赖 prompt_toolkit 默认的键位绑定、Float 定位、rendering loop。升级 prompt_toolkit 版本时如果对方改了默认行为（比如 Escape 语义），Hermes 的 UX 会莫名其妙变化。这是**选择重依赖第三方 UI 框架的固有税**，和 OpenClaw 用 pi-tui 一个性质。
11. **TextArea 的 `read_only` 通过 `Condition(lambda)` 在命令运行时被锁**：意味着命令执行时整个输入区（包括补全）冻结。知行应该允许"命令运行时用户可以继续打字下一条命令"（queue 模式），而不是 Hermes 的"锁输入"。

## 和知行当前状态的对比

**知行目前的状况**：同前两份分析 —— 完全没有补全。

**可以直接套的**：

- **`COMMAND_REGISTRY` + `CommandDef` 的单源真相模式**：知行的 `packages/core/src/commands/registry.ts` 应该是一份 literal list，每个 entry 是 `CommandDef`。CLI / Web / gateway / MCP 自己 derive 视图。这是 Hermes 最成熟的一点。
- **`command_filter` 运行时过滤**：知行的 `CommandRegistry` 应该接受一个 `isAvailable: (cmd: CommandDef, ctx: RuntimeContext) => boolean` 函数，UI 层在每次 suggestion query 时调用。
- **动态 provider（skill/plugin/mcp）通过 lambda 闭包**：知行的命令数据源应该是 "static registry + dynamic providers[]" 的合并，dynamic provider 实现一个 `list(): Promise<CommandDef[]>`，运行时调用。
- **Ghost text 级联**：slash ghost → subcommand ghost → history ghost 的三级 fallback 值得抄。知行把 `SuggestionProvider` 接口设计成可级联的。
- **`args_hint` 字段**：既做 UI 提示又隐式生成 subcommand 补全。知行可以做得更明确一点：`argSchema: { name, type, choices? }` + 一个 `derivedSubcommands()` 静态派生方法。
- **惰性 UI 库依赖**：知行的 `@zhixing/core` 已经决定无 TTY 依赖。这点 Hermes 的 `try/except ImportError` 模式是用 Python 特有语法实现的等价目标 —— TS 的等价做法是把 TUI 类型放在 `@zhixing/cli` 而不是 core。

**需要重新设计的 / 不能照抄的**：

- **渲染层不走 prompt_toolkit 等价物**：知行已经决定自研 raw-mode TUI（见 spec §6），不用 Ink / prompt_toolkit 任何一个。`SuggestionRenderer` 需要自己实现菜单位置、高亮、滚动窗口 —— 但可以复用 `SelectWithInput` 已经证明可行的 raw-mode ANSI 重绘 + §6.4 的 cursor 不变量 + 陷阱 3 的 stdin 独占护栏。
- **过滤算法上 fuzzy**：Hermes 的 prefix-only 对小命令集够用，知行要支持 plugin / skill 动态注入，命令数会破百，必须上 Fuse.js 风格的加权 fuzzy（参考 Claude Code 分析）。
- **按 MRU + category 排序**：抄 Claude Code 的 skill usage score + category priority，而不是 Hermes 的"源顺序即显示顺序"。
- **菜单样式定制**：自研 TUI 让知行有空间做 category 分组、icon、tag（workflow / plugin / mcp），不用被 prompt_toolkit 默认菜单绑死。
- **避免"多个 bool 字段表达 visibility"的坑**：知行用 `visibility: Set<"cli" | "gateway" | "web">` 一个字段搞定。
- **State machine 改成**"Cursor-aware dispatcher with priority-ordered providers"（Claude Code 风格 + 显式 priority 字段），而不是 Hermes 的"每次按键无状态重算"。Hermes 的无状态是 prompt_toolkit 模型的限制，知行自研可以做得更好。
- **Enter 行为**：知行要守住 Claude Code 的 "有 suggestions 时 Enter 被吞掉" guard，Hermes 依赖 prompt_toolkit 的默认行为（Enter 在菜单打开时行为有隐式状态），不够干净。
- **Command filter 的 error handling 不吞异常**：Hermes 是 `try: ...; except Exception: return True`，知行应该 log 错误并继续（宁可命令过多显示，也不要 silently 过滤掉正确的命令）。
