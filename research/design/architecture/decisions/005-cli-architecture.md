# ADR-005: CLI 架构

> **状态**: 接受 | **日期**: 2026-04-07

## 背景

CLI 是用户接触知行的第一个界面。调研了 OpenClaw 和 Claude Code 的 CLI 架构后（见 [q06-CLI 架构](../../../_private/questions/q06-cli-architecture.md)），发现两者分别走了截然不同的路线：

- **OpenClaw**：客户端-网关分离，TUI 是 Gateway 的 WebSocket 客户端，CLI 层轻量但依赖 Gateway 运行
- **Claude Code**：单体 CLI，所有逻辑在进程内，深度 Fork Ink 做极致渲染性能

两者的终端 UI 方案都存在可用性问题——OpenClaw 依赖闭源的 `@mariozechner/pi-tui`，Claude Code 深度 Fork Ink 的工程量令人望而却步。

## 决策

### 决策 1：渐进式 CLI 架构——从 readline 到 Ink 的三阶段演进

不一步到位，按需求驱动渐进演进：

```
Phase 1（MVP）：Node.js readline + chalk + 流式输出
  → 验证核心循环端到端可用

Phase 2：引入 Ink（npm 原版）
  → 支持复杂布局：工具执行面板、权限对话框、状态栏

Phase 3：性能优化（如需）
  → 按 Claude Code 思路对渲染热路径做针对性优化
```

**Phase 1 的目标不是酷炫的 UI，而是可用的智能体。** readline 足以支撑 REPL 交互、流式输出、工具调用显示。

### 决策 2：单体 CLI + 预留 Gateway 接口

采用 Claude Code 的单体模式作为起点：

- 零依赖启动——`npx zhixing` 即可运行
- 不需要先启动 Gateway
- 本地化会话——隐私更好，离线可用

同时在架构上预留分离点：

- Agent Loop 通过 EventBus 对外通信（不与 CLI 层耦合）
- 未来添加 Gateway 时，EventBus 事件可直接桥接到 WebSocket
- CLI 层只依赖 `@zhixing/core` 的公共 API，不直接访问内部实现

### 决策 3：Commander.js 作为命令框架

两个顶级产品都选了 Commander.js，它就是这个领域的标准答案。不需要差异化。

使用 `commander`（不用 `@commander-js/extra-typings`），TypeScript 类型安全通过我们自己的类型定义保证。

### 决策 4：MVP 终端渲染方案

**不引入 React/Ink/任何终端 UI 框架。** 用最简单的方案做到可用：

| 需求 | MVP 方案 |
|------|---------|
| 流式文本输出 | `process.stdout.write()` 直接写入 |
| ANSI 颜色/样式 | `chalk`（两个产品都用） |
| Markdown 渲染 | `marked` + `marked-terminal`（轻量，够用） |
| 代码高亮 | `cli-highlight`（OpenClaw 也用） |
| Spinner/加载状态 | `ora`（成熟、轻量） |
| 用户输入 | Node.js `readline/promises`（标准库，零依赖） |
| 工具执行显示 | chalk 着色的结构化文本 |

### 决策 5：系统提示工程策略

借鉴 Claude Code 的 static/dynamic 分离策略：

```
System Prompt（静态，可缓存）：
  → 角色定义（你是知行，一个 coding agent）
  → 行为规范（工具使用原则、输出格式）
  → 安全约束

消息注入（动态，每次重建）：
  → 工作目录上下文（项目结构、关键文件）
  → AGENTS.md / RULES 文件内容
  → 用户偏好设置
```

这样设计的原因：
- 静态部分放 system prompt，最大化 prompt cache 命中（借鉴 Claude Code）
- 动态部分放消息数组，不影响缓存
- MVP 只实现静态 system prompt，动态注入留给后续 Phase

### 决策 6：会话管理策略

> ⚠️ **本决策已被后续演进取代（2026-05-21 标注）** —— 持久化路径与启动参数均已变更,以当前实现为准。ADR 主体保留作为 2026-04-07 时点的决策快照,不再代表现状:
> - 路径 `~/.zhixing/sessions/<project-hash>/...` 已收敛到 `~/.zhixing/conversations/<id>/` 用户域 / `~/.zhixing/workscenes/<sceneId>/conversations/<id>/` 工作场景域(项目级隔离整段废除,见 [conversation-scope-flattening.md](../../specifications/conversation-scope-flattening.md))
> - 启动参数 `zhixing --continue` / `zhixing --resume <id>` **已删除**,启动期统一 auto-resume `convRepo.findLatest()`;对话查看/切换/创建/命名走 REPL 内 `/resume` / `/new` / `/name`(见 [conversation-model.md §11.2](../../specifications/conversation-model.md))
> - 数据模型权威见 [conversation-model.md](../../specifications/conversation-model.md)

**本地 JSONL 持久化**（同 Claude Code）：

```
~/.zhixing/sessions/
  └── <project-hash>/
      ├── <session-id>.jsonl     ← 对话消息记录
      └── metadata.json          ← 会话元数据
```

支持的恢复模式：
- `zhixing --continue` — 继续上次会话
- `zhixing --resume <id>` — 恢复指定会话

**MVP 不实现持久化**，但 Agent Loop 的消息格式（Message[]）天然可序列化为 JSONL。Phase 2 添加持久化时无需修改核心。

### 决策 7：命令体系设计

**MVP 极简命令集（3 个模式）：**

```bash
zhixing                     # 交互模式（REPL）
zhixing -p "prompt"         # 单次模式（--print / -p）
zhixing config              # 配置管理
```

**REPL 斜杠命令（MVP 6 个）：**
```
/help    — 显示帮助
/clear   — 清空对话历史
/model   — 切换模型
/status  — 显示当前状态（模型、token 用量等）
/config  — 显示配置信息
/exit    — 退出
```

渐进扩展：后续 Phase 按需添加 `/compact`、`/resume`、`/tools`、`/memory` 等。

### 决策 8：差异化创新——实时可观测仪表盘

这是我们超越 OpenClaw 和 Claude Code 的创新点之一。

两个产品都没有给用户提供**运行时可观测性**。我们利用 EventBus 的一等公民地位，在 CLI 中提供实时状态面板：

```
┌─ 知行 ──────────────────────────────────────────┐
│ Model: deepseek-chat | Tokens: 1,234 in / 567 out │
│ Turn: 3/100 | Duration: 12.3s                      │
└─────────────────────────────────────────────────────┘
```

MVP 中这只是一行状态文本。Phase 2 可以演进为 Ink 驱动的实时仪表盘。

核心实现方式：`eventBus.onAny()` 监听所有事件，实时更新状态行。这是 EventBus 设计的自然回报——零额外代码即可获得全局可观测性。

## 理由

### 为什么从 readline 开始而不是直接用 Ink

1. **MVP 验证不需要花哨 UI**：第一个目标是证明"知行能完成真实任务"，不是"知行的 UI 很酷"
2. **Ink 引入的复杂度不成比例**：React 组件模型、Yoga 布局、reconciler——对 MVP 来说过重
3. **渐进引入无迁移成本**：readline 的输出（process.stdout.write）和 Ink 不冲突。从 readline 升级到 Ink 只需要替换渲染层，不影响 Agent Loop 和事件系统
4. **Claude Code 的经验**：即使是 Anthropic 级别的团队，也需要深度 Fork Ink 才能满足性能需求。这说明 Ink 原版够用但可能需要优化——这种优化应该由需求驱动，不应该在 MVP 阶段

### 为什么单体而不是客户端-网关

1. **零依赖启动**：`npx zhixing "hello"` 应该立刻可用，不需要先 `zhixing gateway start`
2. **个人助手场景优先**：知行 MVP 是个人编码助手，不是多用户平台
3. **架构预留**：EventBus 事件天然可桥接到 WebSocket。添加 Gateway 是未来的增量工作，不需要重构

### 为什么不照搬 Claude Code 的整个 CLI 架构

1. **工程量不匹配**：Claude Code CLI 层估计有 15,000+ 行代码，我们 MVP 目标是 500 行以内
2. **技术栈差异**：Claude Code 用 Bun 构建 + 深度 Fork Ink，我们用 tsup 构建 + 标准 npm 依赖
3. **阶段不同**：Claude Code 是成熟产品的极致优化，我们是从零开始的渐进式构建

## 替代方案

### A: 直接用 Ink（原版）

- 优势：声明式 UI，组件复用
- 劣势：MVP 不需要复杂布局；引入 React 作为 CLI 的依赖偏重
- 未采用原因：Phase 2 再引入，需求驱动

### B: 复刻 OpenClaw 的客户端-网关模式

- 优势：CLI 层最轻量
- 劣势：需要先实现 Gateway；增加部署复杂度
- 未采用原因：MVP 阶段不适合，但架构上预留了未来桥接的可能

### C: 用 blessed/blessed-contrib 做 TUI

- 优势：丰富的 TUI 组件
- 劣势：已停止维护；不支持 ESM；与流式输出集成困难
- 未采用原因：技术风险太高

### D: 用 @clack/prompts 做交互

- 优势：漂亮的交互式提示
- 劣势：设计为一次性表单，不适合持续对话的 REPL 场景
- 未采用原因：适合 setup wizard，不适合核心 REPL

## 影响

### Phase 1 实现范围

```
packages/cli/
├── src/
│   ├── index.ts          # 入口，Commander 命令注册
│   ├── repl.ts           # REPL 交互循环
│   ├── render.ts         # 流式输出渲染（chalk + marked-terminal）
│   ├── commands/         # 斜杠命令处理
│   │   ├── index.ts
│   │   └── ...
│   └── prompt/           # 系统提示组装
│       └── system.ts
├── package.json
└── tsconfig.json
```

**预估行数**：300-500 行（不含系统提示模板文本）

### 新增依赖

| 依赖 | 用途 | 大小 |
|------|------|------|
| commander | 命令解析 | ~50KB |
| chalk | ANSI 着色 | ~12KB |
| ora | Spinner | ~15KB |
| marked + marked-terminal | Markdown 渲染 | ~80KB |
| cli-highlight | 代码高亮 | ~200KB |

### 不影响已有模块

- `@zhixing/core` 不需要任何修改
- `@zhixing/providers` 不需要任何修改
- `@zhixing/tools-builtin` 不需要任何修改
- CLI 通过 `runAgentLoop()` + `createProviderFromConfig()` + `createXxxTool()` 组装

## 引用

- [q06-CLI 架构](../../../_private/questions/q06-cli-architecture.md)
- OpenClaw: `src/cli/`、`src/tui/`、`openclaw.mjs`
- Claude Code: `entrypoints/cli.tsx`、`main.tsx`、REPL.tsx、query.ts
- [claude-code-from-source.com](https://claude-code-from-source.com)
