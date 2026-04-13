# Claude Code 确认交互 UX — 源码解析

> **所属系统**: Claude Code  
> **焦点**: CLI 内的工具审批对话框  
> **源码位置**: 本地已安装版本 `E:/studyapp/node/nodejs/node_global/node_modules/@anthropic-ai/claude-code/cli.js`（bundled，17040 行单文件）  
> **分析日期**: 2026-04-13  
> **核对方式**: 直接对 bundled `cli.js` 做字符串搜索与上下文提取，所有选项标签/类型名/行为都引用真实代码片段（bundled 代码变量名已混淆，但字符串字面量和选项 `type` 字段是稳定的）

## 核心洞察：三系统中 CLI 审批 UX 设计最成熟的一个

Claude Code 做了三件其它两家没做的事：

1. **真正的 TUI (Ink/React)** — 审批对话框是一个 Ink 组件，在对话流里**原地渲染**，不是覆盖层也不是独立屏幕。模型流输出到 `tool_use` 块时，流自然停住，Ink 在那一位置追加 `<PermissionPrompt>`，用户选完后 Ink 卸载组件，流继续。
2. **"拒绝并告诉 Claude 怎么改"反馈回路** — No 选项带一个**内嵌的文本输入**，用户输入的原因会作为 tool_result 回到模型。拒绝不是终点，是一次纠错对话。
3. **PreToolUse Hook 机制** — 审批之前还有一层用户定义的 hook，hook 可以 `allow` / `deny` / `ask`，并且可以 **`updatedInput` 修改工具参数**。这是"编辑后再批准"能力的编程接口版本。

## 权限模式（`permissionMode`，129 次引用）

```typescript
// 从 cli.js 里 permission 模式字符串字面量提取
type PermissionMode =
  | "default"            // 标准模式：写 / bash / MCP 需 ask
  | "acceptEdits"        // 文件编辑自动批准，bash 仍 ask
  | "bypassPermissions"  // --dangerously-skip-permissions
  | "plan";              // Plan 模式下工具受限
```

**4 种模式，通过**：
- `--permission-mode <mode>` CLI 标志
- `Shift+Tab` 快捷键在对话中切换（`P?"yes-accept-edits":"yes-accept-edits-keep-context"`）
- `initialPermissionMode` 配置项（会话启动时设定）

## 权限决定的数据模型

### 选项 `type` 字段（从 cli.js 直接提取）

每个选项都有一个 `option.type` 字段决定决策的持久化方式：

| `option.type` | 含义 | 持久化 |
|---|---|---|
| `"accept-once"` | 批准这一次 | 不持久 |
| `"accept-session"` | 批准本次会话 | session 内存 |
| `"reject"` | 拒绝 | 不持久（但理由文本回流到模型） |

Session 级还有 `scope` 子字段：

```javascript
// cli.js 附近 @ 12153710
{ label: "Yes, and allow Claude to edit its own settings for this session",
  value: "yes-claude-folder",
  option: { type: "accept-session", scope: J ? "global-claude-folder" : "claude-folder" }}
```

### 规则行为（`ruleBehavior`，32 次引用）

```typescript
type RuleBehavior = "allow" | "deny" | "ask";

// 内部三个规则桶（alwaysAllow 38x, alwaysDeny 8x, alwaysAsk 8x）
interface ToolPermissionRulesBySource {
  alwaysAllow: ...;
  alwaysDeny: ...;
  alwaysAsk: ...;     // "永远问我"——用户可把不确定的东西显式放进这里
}
```

`alwaysAsk` 的存在值得注意——不是简单的"允许/拒绝"，还有**"明知有规则但仍然每次问"**的中间态。这对高风险操作是合理的：用户不想自动放行，但也不想每次都重新建立规则。

## 审批对话框的实际外观

从 cli.js 提取的真实标签字符串（中文为推断翻译）：

```
╭──────────────────────────────────────────────────────╮
│                                                      │
│  Bash command                                        │
│  ┌────────────────────────────────────────────────┐  │
│  │ $ npm install express                          │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ❯ Yes                                               │
│    Yes, and don't ask again for "npm install"        │
│      commands in <project>                           │
│    Yes, and allow all edits during this session      │
│    No, and tell Claude what to do differently (esc)  │
│                                                      │
╰──────────────────────────────────────────────────────╯
```

**来自真实字符串字面量**：

- `"Yes"`（最简单的确认）
- `"Yes, during this session"`（只读工具的会话级允许）
- `"Yes, allow all edits during this session"`（编辑工具的会话级允许）
- `"Yes, and don't ask again for {X} commands in {project}"`（永久项目级白名单，bash 类）
- `"Yes, and always allow access to {tool} from this project"`（永久项目级白名单，工具级）
- `"Yes, and allow Claude to edit its own settings for this session"`（特殊子域：claude-folder）
- `"Yes, and remember this directory"`（首次项目信任对话框的选项）
- `"Deny, and tell Claude what to do differently (esc)"`（带 esc 快捷键提示）

**"No" 选项的内嵌输入**（从 cli.js @ 12154397 直接提取）：

```javascript
w.push({
  type: "input",                                 // 不是普通 select 项，是输入项
  label: "No",
  value: "no",
  placeholder: "and tell Claude what to do differently",
  onChange: z,
  allowEmptySubmitToCancel: true,                 // 直接回车 = 不提供理由的纯拒绝
  option: { type: "reject" }
});
```

**这是最精妙的设计**：select list 里的某一项本身是一个输入框。当用户上下箭头移动到 "No" 这一项时，光标进入输入框；敲字符就是在写拒绝理由；回车提交。`allowEmptySubmitToCancel: true` 意味着空输入直接回车也算合法的拒绝。

对应的 Yes 选项也可以带输入：

```javascript
// cli.js @ 12153371
{ label: "Yes",
  value: "yes",
  placeholder: "and tell Claude what to do next",   // 批准的同时追加指示
  onChange: Y,
  allowEmptySubmitToCancel: true,
  option: { type: "accept-once" } }
```

所以用户**既可以"批准+补充说明"**也可以**"拒绝+告诉原因"**——同一套 "input-in-select" 组件。

## Ink + rawMode TTY 集成

从 cli.js `rawMode` 上下文（共 8 次引用）：

```javascript
// @ 4044830 附近
setEncoding("utf8"),q){if(this.rawModeEnabledCount===0){
  if(lq6(), this.props.onRawModeEnter?.(), K.r...
  // ...
}
this.rawModeEnabledCount++;
```

- **引用计数式 rawMode 管理**：多个组件同时需要 raw mode 时不互相关掉。`rawModeEnabledCount > 0` 时保持开启。
- **`onRawModeEnter` / `onRawModeExit` 钩子**：允许上层在 TTY 模式切换时做清理（恢复光标等）
- **基于 Ink 原生 `useInput` + `useStdin`**（各 1 次引用）

## Tool Permission Context 的合并与类型锁定

从字符串字面量重建：

```typescript
// DeepImmutable 锁定权限上下文 — 任何地方都无法意外修改
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode;
  alwaysAllowRules: ToolPermissionRulesBySource;
  alwaysDenyRules: ToolPermissionRulesBySource;
  alwaysAskRules: ToolPermissionRulesBySource;
  // ...
}>;
```

多源合并优先级（8 个规则源合并）：
- Managed（团队管理）> Project local (`settings.local.json`) > Project > User (`~/.claude/settings.json`) > CLI flag > Session temporary > Internal default

其中 `settings.local` 出现 23 次——特指项目级的本地覆盖文件（不纳入 git）。

## PreToolUse Hook — 审批前的可编程层

从 cli.js @ 9559852 附近：

```javascript
yield {
  type: "hookPermissionResult",
  hookPermissionResult: {
    behavior: "deny",
    message: M,
    decisionReason: { type: "hook", hookName: `PreToolUse:${K.name}`, reason: M }
  }
};
// ...
// @ 9560527
if (X.permissionBehavior === "allow")
  yield { ...behavior: "allow", updatedInput: X.updatedInput, decisionReason: M };
else if (X.permissionBehavior === "ask")
  yield { ...behavior: "ask", updatedInput: X.updatedInput, message: X.hookPermissionDecisionR... };
```

**PreToolUse Hook 返回三种行为 + 可选的 updatedInput**：

| `behavior` | 含义 |
|---|---|
| `allow` | 完全放行，绕过常规审批 |
| `deny` | 强制拒绝，附 message |
| `ask` | 照常弹审批，但可以已经改了 `updatedInput` |

**`updatedInput` 是关键能力**：hook 可以**修改将要执行的工具参数**再进入审批。这就是"编辑后再批准"的程序化版本——不是用户手动编辑，但 hook 脚本可以做（例如"把任何 `rm` 自动加 `-i`"）。

这个能力知行还没有。规范里应该预留这个接口。

## Shift+Tab：在权限模式间切换（`cli.js @ 12179991`）

```javascript
if (o.shift && o.key === "tab") {
  o.preventDefault();
  X6(P ? "yes-accept-edits" : "yes-accept-edits-keep-context");
  return;
}
```

Shift+Tab 切换 "edit mode"：
- `yes-accept-edits` — 进入 acceptEdits 模式
- `yes-accept-edits-keep-context` — 同样切换但不重置上下文
- `yes-bypass-permissions` — 切到 bypass 模式
- `yes-resume-auto-mode` — 恢复 Auto 模式

这是**把权限模式切换折叠进审批对话框**的做法：不用退出去跑 `--permission-mode`，在审批这一瞬间就能升级模式。

## 首次项目信任对话框（`cli.js @ 12762685`）

```javascript
M6 = [
  { label: "Yes, I trust this folder", value: "enable_all" },
  { label: "No, exit", value: "exit" }
];
```

**正交的"配置信任"层**——和单次操作审批不是同一个流。首次在某项目里启动时，先问"你信任这个项目的 `.claude/settings.json` 吗"，这一关过了之后，项目自带的规则/hook/MCP 才生效。防止的是"克隆仓库里埋一份自动允许一切的 settings.local.json"。

## 值得借鉴的模式

| # | 模式 | 核心价值 |
|---|------|------|
| 1 | **Ink + rawMode 引用计数** | 多模态并存时 TTY 模式不互相打架 |
| 2 | **对话流内原地渲染审批** | 不是覆盖层，避免弹窗感 |
| 3 | **Select list 项自己是 input** | 同一个组件支持"批准+补充"和"拒绝+理由"，UX 无缝 |
| 4 | **"拒绝并告诉 Claude"反馈回路** | 拒绝不是终点，是一次纠错；这是三系统中 Claude Code 最强差异化 |
| 5 | **PreToolUse Hook + `updatedInput`** | 参数级改写能力的程序化入口 |
| 6 | **`alwaysAsk` 规则类（而非只有 allow/deny）** | 明确表达"不自动允许但也不拒绝" |
| 7 | **Shift+Tab 在审批里切模式** | 把"升级权限档位"折叠进同一交互 |
| 8 | **正交的项目信任层** | 配置信任 ≠ 操作信任 |
| 9 | **`DeepImmutable<ToolPermissionContext>`** | 权限上下文类型锁，防止代码任何处意外修改 |
| 10 | **选项标签按工具类型动态生成** | Bash 显示命令前缀，Read 显示路径，Edit 显示文件——而非统一模板 |

## 局限与坑

| # | 问题 |
|---|------|
| 1 | **Ink/React 依赖重** — 审批组件和 Ink 强耦合，难以在非 TTY（Web/移动）复用 |
| 2 | **一次只能处理一个 pending 审批** — 没有队列视图（相对 OpenClaw Web） |
| 3 | **拒绝理由必须打字** — 没有预置模板（"错目标"/"太危险"/"换个方法"） |
| 4 | **`alwaysAsk` 规则没有好 UX 入口** — 需要手动编辑 settings.json 才能添加 |
| 5 | **批量审批缺位** — 同一 turn 里 5 个相关调用仍然要点 5 次 |
| 6 | **依赖 Claude Code 自己的 yoloClassifier Auto 模式** — Auto 每次额外一次模型调用，延迟 + 成本 |
| 7 | **Hook 机制在 CLI 里调试困难** — 错了不好排查 |

## 可直接拿到知行的设计元素

- ✅ **Select-with-inline-input 组件** — 核心必做。知行当前的 readline y/a/g/s/n 打字交互直接被这个碾压。
- ✅ **"拒绝并告诉 Claude"反馈回路** — 回送拒绝理由到下一个 tool_result，让模型自我纠正。这是**知行差异化的关键一条**。
- ✅ **对话流内原地渲染**（非覆盖层模型）
- ✅ **PreToolUse Hook 接口 + `updatedInput`** — 设计里预留，可延后实现
- ✅ **`alwaysAsk` 第三档规则** — 知行的 `PermissionRule` 目前只有 allow/deny，应该加 ask
- ✅ **Shift+Tab 在审批里切权限模式** — UX 加分项
- ✅ **正交的项目信任层** — 首次项目启动的一次性"信任这个 .zhixing/"确认
- ✅ **按工具类型动态生成选项标签**（不是通用模板）
- ⚠️ **Ink / React** — 避免硬依赖。知行应该用**更轻的 TTY 库**（见 design spec 的技术选型）
