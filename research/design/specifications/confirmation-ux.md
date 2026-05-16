# 知行安全确认交互设计方案 v1.0

> **状态**: 📐 方案设计（2026-04-13）
> **前置**: [security-system.md](./security-system.md) Phase 1–2 已落地
> **信息来源**:
> - [research/source-analysis/openclaw/confirmation-ux.md](../../source-analysis/openclaw/confirmation-ux.md)
> - [research/source-analysis/hermes-agent/confirmation-ux.md](../../source-analysis/hermes-agent/confirmation-ux.md)
> - [research/source-analysis/claude-code/confirmation-ux.md](../../source-analysis/claude-code/confirmation-ux.md)

---

## 一、问题陈述

当前知行的安全确认交互是 [packages/cli/src/security/confirmation-ui.ts](../../../packages/cli/src/security/confirmation-ui.ts) 里的 `showConfirmationDialog`：

```
╭─ 安全确认 ────────────────────────────
│ 智能体想要执行:
│   $ npm install express
│ 影响范围: external   风险等级: medium
│ ...
│ [y] 允许这一次
│ [a] 始终允许 "npm install *"（本工作区）
│ [g] 始终允许 "npm install *"（全局）
│ [s] 会话内允许 "npm install *"
│ [n] 拒绝
╰────────────────────────────────────────
选择 [y/a/g/s/n]: _
```

**痛点**：
1. **打字选择**——用户需要记忆并输入字母。三系统调研显示这是最低档的交互。
2. **没有默认聚焦**——不知道"推荐选什么"，也不能回车快选。
3. **拒绝就是拒绝**——没有办法把"为什么拒绝"回送给模型，模型下次还会这么干。
4. **不能批准+补充**——批准时没法追加说明（例如"批准但用 -i 参数"）。
5. **候选模式只生成一条**——用户不能选不同粒度（`npm install *` vs `npm *`）。
6. **没有模态优先级**——如果未来还有 clarify/sudo 等交互，全都挤在同一个 readline 上打架。
7. **非交互模式就 block 掉所有 confirm**——没有预审批 / 批量审批 / 信任列表机制。
8. **完全是 CLI 专用**——未来要接 Web / 微信 / 钉钉就得从头重写。

**不是痛点但容易误判**：
- 当前 readline 实现**不阻塞 Ink**——知行还没上 Ink，这不是问题。
- 当前实现**没有 TTY raw mode**——对 readline 够用，但要升级到箭头导航必须引入 raw mode。

---

## 二、调研要点（一句话版）

| 维度 | OpenClaw | Hermes | Claude Code | **知行（当前）** |
|------|----------|--------|-------------|-----------|
| 交互方式 | readline `(y/N)` | prompt_toolkit 箭头键 + Enter | Ink + rawMode 箭头键 + Enter | readline y/a/g/s/n |
| 命令长度自适应 | ❌ | ✅ 长命令加 "view" | ❌ | ❌ |
| 批准 + 补充说明 | ❌ | ❌ | ✅ Select 项内嵌 input | ❌ |
| **拒绝 + 回送原因** | ❌ | ❌ | ✅ **核心差异化** | ❌ |
| 多 pending 队列视图 | ✅ Web 侧 | ❌ | ❌ | ❌ |
| 选项按威胁类型裁剪 | ❌ | ✅ tirith 时隐藏 always | ⚠️ 按工具类动态文本 | ❌ |
| 多通道路由预备 | ✅ turnSource 四元组 | ⚠️ 进程内队列 | ❌ | ❌ |
| 两阶段注册防竞态 | ✅ | ❌ | ❌（单进程） | ❌ |
| LLM 辅助分诊 | ❌ | ✅ mode=smart | ✅ Auto / yoloClassifier | ❌ |
| 命令 sanitize（防 ANSI 注入） | ✅ commandPreview | ❌ | ⚠️ | ❌ |
| PreToolUse Hook + updatedInput | ❌ | ❌ | ✅ | ❌ |
| Shift+Tab 切权限档位 | ❌ | ❌ | ✅ | ❌ |
| Ctrl+C = deny（确定性） | ⚠️ | ✅ | ✅ | ⚠️（空输入 = deny） |
| 并发审批串行化 | ✅（RPC 天然） | ✅ `_approval_lock` | ⚠️（单线程） | ❌ |
| 非交互兜底 | `askFallback` 策略 | ❌ fail-open | non-TTY block | block |

---

## 三、设计目标（按优先级）

1. **让用户用**。终端里的审批应该像 GUI 一样：上下箭头 + Enter，不用打字。
2. **让用户沟通**。拒绝必须能带原因，批准必须能带补充——审批是一次对话，不是一次开关。
3. **让未来扩展**。Core 不应假设渲染层在哪里。CLI 是第一个渲染器，Web / 微信 / 钉钉是未来的渲染器。Core 只负责"有一个审批要做决定"，不负责"怎么显示"。
4. **让并发安全**。并行子 agent 同时触发审批时串行弹出，不乱序不吞掉。
5. **让它可被测试**。核心逻辑完全不依赖终端。
6. **让可观测**。所有决策都进 EventBus，有完整审计链。
7. **让降级优雅**。非交互时有策略而不是崩溃；通道失联时有 fallback 而不是挂死。
8. **让每一步能独立落地**。每个 Phase 都可以单独上线、单独测试、单独回滚。

---

## 四、架构总览

### 4.1 三层分离

```
┌────────────────────────────────────────────────────────────────┐
│  @zhixing/core  ─ Confirmation Core                            │
│  ─────────────────────────────────────                         │
│  ConfirmationRequest              (类型：纯数据 payload)       │
│  ConfirmationBroker               (核心：注册/等待/解决)       │
│  ConfirmationQueue                (FIFO + 串行锁)              │
│  ConfirmationDecision             (所有可能的决定 + metadata)  │
│  ConfirmationRenderer             (接口：任何渲染器实现)       │
│  NonInteractiveStrategy           (非交互兜底决策器)           │
└─────────────┬──────────────────────────────────────────────────┘
              │
              │  ConfirmationRenderer 接口
              │
    ┌─────────┼─────────┬─────────────┬──────────────┐
    ▼         ▼         ▼             ▼              ▼
┌────────┐┌────────┐┌────────┐  ┌───────────┐  ┌──────────┐
│  TTY   ││  Web   ││  测试  │  │  微信     │  │  钉钉    │
│  键盘  ││  modal ││  mock  │  │  按钮     │  │  卡片    │
└────────┘└────────┘└────────┘  └───────────┘  └──────────┘
  Phase 1   未来      Phase 1      未来          未来
```

**核心解耦原则**：
- Core 不认识 TTY、Ink、chalk、readline、prompt_toolkit
- Core 暴露 `ConfirmationBroker.register(request) → Promise<decision>`——渲染器通过 `onRequest` 事件订阅新请求并在某处显示它
- 渲染器唯一的义务是调用 `broker.resolve(requestId, decision)`

### 4.2 洋葱模型里的位置

当前 `SecurityPipeline` 在 `authorize` 阶段返回 `requiresConfirmation=true` 时，上层 `secure-executor` 调用 `showConfirmationDialog`。这个调用点保持不变，但内部换成 `broker.requestConfirmation(request)`：

```
                authorize
                    │
       decision = confirm + suggestion + patterns
                    │
                    ▼
         ┌─────────────────────┐
         │ ConfirmationBroker  │
         │  .requestConfirma   │
         │     tion(request)   │
         └──────────┬──────────┘
                    │
          broker 把请求排队 + 广播 onRequest
                    │
         某个 renderer 接手，显示 UI，
         用户选完后 renderer 调 resolve
                    │
                    ▼
           Promise<Decision> 返回
                    │
                    ▼
       apply side effects (PermissionStore / Tracker)
                    │
                    ▼
       execution with constraints
```

---

## 五、核心接口

### 5.1 `ConfirmationRequest` — 纯数据 payload

```typescript
interface ConfirmationRequest {
  id: string;                    // UUID 或调用方提供的 stable id

  // ── 被请求的操作 ──
  tool: string;                  // 工具名
  toolInput: Record<string, unknown>;
  workingDirectory: string;

  // ── 已沉淀的安全决策（来自 SecurityPipeline）──
  decision: SecurityDecision;    // action: "confirm", reason, matchedRules, riskLevel
  operationClass: OperationClass;
  matchedPermissionRule?: PermissionRule | null;
  suggestion?: SuggestionStatus;
  resolvedAccess?: ResolvedAccess;

  // ── 命令显示优化（学习 OpenClaw commandPreview）──
  display: {
    title: string;               // 如 "Bash command" / "Edit file"
    body: DisplayBody;           // 富结构，让渲染器决定如何呈现
    // sanitized 过的命令文本——防 ANSI 注入、控制字符
    commandPreview?: string;
    // 命令完整版（用于 "展开" 操作）
    commandFull?: string;
    // envKeys 列表（不含 value，UI 能看见变量名但不泄露秘密）
    envKeys?: string[];
    // 被影响的文件/路径列表（已 realpath 解析）
    resolvedPaths?: string[];
    // 执行位置
    cwd: string;
    // 会被修改的文件的当前 sha256（防 TOCTOU）
    mutableFileSnapshots?: Array<{ path: string; sha256: string }>;
  };

  // ── 用户可选的决定 ──
  options: ConfirmationOption[];

  // ── 会话上下文 ──
  sessionType: SessionType;
  workspaceId: string | null;

  // ── 时间约束 ──
  createdAt: number;
  expiresAt: number;             // 默认 30 分钟；非交互模式下降为 0
}

type DisplayBody =
  | { kind: "bash"; command: string; commandPreview: string }
  | { kind: "file-edit"; path: string; diff?: string }
  | { kind: "file-write"; path: string; preview?: string }
  | { kind: "file-read"; path: string }
  | { kind: "network"; host: string; direction: "inbound" | "outbound" }
  | { kind: "messaging"; recipient: string; content: string }
  | { kind: "calendar"; title: string; invitees: string[] }
  | { kind: "generic"; summary: string; details?: Record<string, string> };
```

**设计要点**：
- `DisplayBody` 是判别式联合类型——渲染器按 `kind` 分派到不同的渲染函数。新增业务领域（如财务/智能家居）时只加一个 variant，不改核心。
- `commandPreview` 独立于 `command`（学习 OpenClaw）。原始命令用来执行，preview 用来显示。所有渲染器都应只展示 `commandPreview`。
- `mutableFileSnapshots` 是对"执行计划"的签字（学习 OpenClaw systemRunBinding）。决策在 T₀，执行在 T₁，如果 T₁ 时文件变了就应该拒绝。

### 5.2 `ConfirmationOption` — 选项定义

```typescript
type ConfirmationOption =
  // 简单选项
  | { kind: "allow-once"; label: string; hotkey?: string }
  | { kind: "allow-session"; label: string; pattern: SuggestedPattern; hotkey?: string }
  | { kind: "allow-workspace"; label: string; pattern: SuggestedPattern; hotkey?: string }
  | { kind: "allow-global"; label: string; pattern: SuggestedPattern; hotkey?: string }
  | { kind: "deny"; label: string; hotkey?: string }

  // 带内嵌输入的选项（学习 Claude Code）
  | { kind: "allow-with-note"; label: string; placeholder: string }   // "Yes, and ..."
  | { kind: "deny-with-reason"; label: string; placeholder: string }  // "No, and tell Claude..."

  // 高级选项（Phase 2+）
  | { kind: "edit-then-allow"; label: string }  // 编辑 toolInput 后再批准
  | { kind: "show-full"; label: string }        // 展开被截断的命令（view）
  | { kind: "always-ask"; label: string; pattern: SuggestedPattern };  // 升级到 alwaysAsk
```

`hotkey` 是**可选**的字母快捷键（如 "y"、"n"）——即便有箭头导航，熟练用户仍可以一键直达。

### 5.3 `ConfirmationDecision` — 用户决定

```typescript
type ConfirmationDecision =
  | { kind: "allow-once"; note?: string }
  | { kind: "allow-session"; pattern: SuggestedPattern; note?: string }
  | { kind: "allow-workspace"; pattern: SuggestedPattern; note?: string }
  | { kind: "allow-global"; pattern: SuggestedPattern; note?: string }
  | { kind: "always-ask"; pattern: SuggestedPattern }
  | { kind: "edit-then-allow"; modifiedInput: Record<string, unknown>; note?: string }
  | { kind: "deny"; reason?: string }
  | { kind: "expired" }             // 超时兜底
  | { kind: "cancelled"; cause: "user-ctrl-c" | "session-end" | "renderer-detached" };
```

**核心创新**：
- `note` / `reason` 字段是**自由文本**。批准时追加的 note、拒绝时的 reason，都会回流到 `SecurityBlockError` 的 message 字段 → 包装成 tool_result 回到模型。
- `edit-then-allow.modifiedInput` 让用户在审批时修改工具参数。例如把 `rm -rf dir` 改成 `rm -ri dir`。这一条对齐 Claude Code PreToolUse Hook 的 `updatedInput` 能力。

### 5.4 `ConfirmationBroker` — 核心调度器

```typescript
interface ConfirmationBroker {
  // 注册一个审批请求，返回 Promise<decision>
  requestConfirmation(request: ConfirmationRequest): Promise<ConfirmationDecision>;

  // 渲染器订阅新请求
  onRequest(listener: (request: ConfirmationRequest) => void): Unsubscribe;

  // 渲染器上报用户的决定
  resolve(requestId: string, decision: ConfirmationDecision): boolean;

  // 查询当前所有 pending 请求（用于"队列视图"）
  listPending(): ConfirmationRequest[];

  // 取消某个请求（用于"会话结束时清场"）
  cancel(requestId: string, cause: CancelCause): boolean;

  // 查询 broker 状态
  snapshot(): BrokerSnapshot;
}

interface BrokerSnapshot {
  pending: ConfirmationRequest[];
  resolvedRecently: Array<{ id: string; decision: ConfirmationDecision; resolvedAt: number }>;
  hasRenderer: boolean;          // 有没有渲染器订阅？
  nonInteractiveStrategy: string;
}
```

**行为合约**：
1. **串行 by default**：同一时刻只有一个请求处于"展示中"状态。多个 pending 请求排队 FIFO（学习 Hermes `_approval_lock`）。可以配置成并行，但默认串行。
2. **无渲染器时走 `NonInteractiveStrategy`**：自动决定（默认拒绝）并发射 `confirmation:auto-resolved` 事件。
3. **已解决的请求保留 15 秒 grace period**（学习 OpenClaw grace period）——让迟到的 resolve 调用能幂等。
4. **`resolve` 对同 id 重复调用**：第一次生效，第二次返回 false。
5. **`cancel` 的 decision 总是 `{ kind: "cancelled", cause }`**——不会变成 allow 或 deny。

### 5.5 `ConfirmationRenderer` — 渲染器接口

```typescript
interface ConfirmationRenderer {
  readonly name: string;                        // "terminal" | "web" | "wechat" | ...
  readonly capabilities: RendererCapabilities;

  attach(broker: ConfirmationBroker): Unsubscribe;
  detach(): void;
}

interface RendererCapabilities {
  // 支持哪些 option.kind
  supportedOptions: ConfirmationOption["kind"][];
  // 是否支持批准时追加 note
  supportsAllowNote: boolean;
  // 是否支持拒绝时追加 reason
  supportsDenyReason: boolean;
  // 是否支持 edit-then-allow
  supportsEdit: boolean;
  // 是否能同时显示多个 pending（有队列视图）
  supportsQueue: boolean;
  // 是否有内联 input 组件（select + input 混合）
  supportsInlineInput: boolean;
}
```

**Broker 构造 `options` 时会查 renderer.capabilities**，剔除不支持的选项——例如 TTY 渲染器不支持 inline input 时，不会生成 `allow-with-note` 选项，只保留普通 allow-once。这样**同一个 `ConfirmationRequest` 在不同渲染器上的选项集会不同**，但 core 逻辑和决策类型完全复用。

### 5.6 `NonInteractiveStrategy` — 非交互兜底

```typescript
type NonInteractiveStrategy =
  | "fail-to-deny"              // 默认：拒绝所有未匹配规则的操作（知行默认）
  | "fail-to-expired"           // 超时后返回 expired，上层决定怎么处理
  | "delegate-to-presentence"   // 预审批 API：查询 pre-approval 列表
  | "delegate-to-llm";          // 走 Smart LLM 分诊（Phase 3）
```

**关键决定**：知行**非交互模式默认 `fail-to-deny`**，而不是 Hermes 的 fail-open。这是**反 Hermes 的最重要的一条**。

---

## 六、TTY 渲染器设计

### 6.1 技术选型对比

| 方案 | 优点 | 缺点 | 判断 |
|---|---|---|---|
| **`@inquirer/prompts` select** | 成熟、维护活跃、支持 arrow+enter | 不支持 "select 内嵌 input"，对齐 Claude Code 需要两次交互 | ⚠️ 可用但受限 |
| **`@clack/prompts`** | 更好看、样式可定制 | 同样不原生支持 inline input | ⚠️ 可用但受限 |
| **Ink (React-for-CLI)** | 最强大，能实现任何布局；Claude Code 已证明 | 依赖重 (React)、学习成本 | ❌ 避免 |
| **手写 raw-mode + ANSI** | 最轻量、完全可控、无依赖 | 每一个组件都得自己写 | ✅ **推荐并已证明可行** |
| **`prompt_toolkit` 的 Node 等价物** | — | Node 生态里没有完全等价的库 | ❌ 不存在 |

### 6.1.1 可行性调研结论（2026-04-13）

> （2026-05-16 更新：本节及 §6.3 / §6.4 / 第九章 Step 2-3 描述的 **`packages/cli/src/tui/select-with-input.ts` 独立 alt-screen 组件已被取代并删除**。commit 6baa41e 用 chrome 内联的 `SelectOperationRegion` 替换 `selectWithInput`——权限面板不再切独立屏 / 不再"擦 N 行原地重绘"，而是作为 chrome 底部"操作区"（实现 `InputRegion`，经 `ScreenController.attachInput` 接入，与 typeahead InputController 同协议），scrollback 始终可见。当前实现见 [packages/cli/src/security/select-operation-region.ts](../../../packages/cli/src/security/select-operation-region.ts) + [packages/cli/src/security/terminal-renderer.ts](../../../packages/cli/src/security/terminal-renderer.ts)；状态机纯 reducer 见 `packages/cli/src/tui/_internal/select-state.ts`。下文"自研纯 Node + ANSI 原地重绘可行"的核心结论仍成立，但 §6.4 的 rerender cursor 不变量 / `\r\n` 分隔 / "擦 N 行"循环等细节是 alt-screen 原地重绘形态的历史教训，**不再对应现状**——chrome 内联形态的渲染由 ScreenController 协调，无独立组件自管原地重绘。)

> 原方案预留了风险："自研组件工程量可能被低估"。已做专项调研并**证明风险消除**。
> 调研产物（已删，见上方更新）+ 47 条测试；原型目录 `.tmp-tui-probe/` 完成使命后已删除。
>
> **验证路径**：8 个自动化场景全绿 → 真实 Windows Terminal 手动验收 → 一次 cursor off-by-one bug 暴露 → 修复后再次验收通过。bug 的根因与规避已回写到 §6.4。

**已验证的能力**：

1. **Node 原生 `readline.emitKeypressEvents`** 能可靠提取：
   - 箭头键：`{ name: "up" | "down", sequence: "\x1b[A" | "\x1b[B" }`
   - Enter：`{ name: "return", sequence: "\r" }`
   - Ctrl+C：`{ name: "c", ctrl: true }` — 单独触发，干净
   - Ctrl+D：`{ name: "d", ctrl: true }`
   - Backspace：`{ name: "backspace" }`
   - 可打印 ASCII：通过 `str` 字段传递
   - **UTF-8 多字节（中文）**：也通过 `str` 字段传递，多字节正确编码
2. **ANSI 游标控制**（`\x1b[2K` / `\x1b[NA` / `\x1b[?25l` 等）在 Windows 11 + Node 22 + xterm-256color 环境全部有效，面板可原地重绘不滚屏。
3. **~200 行代码的完整原型**跑通 8 个端到端场景：

```
✅  allow-once (enter on first option)
✅  allow-session (two downs + enter)
✅  ctrl-c (any time)
✅  deny with reason (down×3, enter, type, enter)  ← 核心差异化验证
✅  deny empty (down×3, enter, enter)
✅  backspace in input
✅  allow with note (down, enter, type, enter)
✅  utf8 chinese input (down×3, enter, 中文, enter) ← 中文输入验证
```

4. **两条测试路径都可用**：
   - `child_process.spawn` + 脚本化 stdin 写入（端到端集成测试）
   - `node:stream.PassThrough` + in-process 调用（Vitest 单元测试）

5. **零外部依赖**：不需要 `@inquirer/prompts`、`@clack/prompts`、Ink、React 中任何一个。只用 Node 内建 `readline` + ANSI 转义码。

**代码量下调**：

| 原估 | 新估 |
|---|---|
| Step 2: `@inquirer/prompts` 过渡实现 ~300 行 | 删除此步 |
| Step 4: 替换为自研 ~400 行 | Step 4: 直接自研 ~500 行（含生产级 edge case） |
| **合计**: ~700 行 | **合计**: ~500 行 |

节省 ~200 行代码 + 一个运行时依赖 + 一次"先用库再替换"的重构成本。

**已识别的次要风险**（全部可在 Step 4 生产化时解决，不影响核心可行性）：

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 面板行超过 `stdout.columns` 被终端自动换行，导致 "clear N lines" 漏清 | 🟡 | 写入前 truncate 到 `columns - 2`（Ink / prompt_toolkit 都这么做） |
| 终端宽度 < 40 列时布局错乱 | 🟢 | `stdout.columns` 自适应 clamp，最小宽度回退到单列布局 |
| `resize` 事件未自动触发重绘 | 🟢 | 监听 `process.stdout.on("resize", () => rerender())` |
| Windows legacy cmd.exe 对 ANSI 支持差 | 🟢 | 用户环境是 Windows Terminal（Win11 默认）；legacy cmd.exe 检测后降级到无游标模式 |
| 脚本化测试无法覆盖"单独按 Escape"（Node parser 会合并 ESC + 后续字节） | 🟢 | 实际交互 TTY 里键盘按键天然有时间间隔，Escape 会正常触发；测试用 Ctrl+G 等替代键 |

**最终决定**：Step 2 改为"直接自研 select-with-input 核心组件"，**跳过 `@inquirer/prompts` 过渡阶段**。Phase 1 就能一步到位交付"箭头导航 + 拒绝带原因 + 批准带补充"完整差异化。

### 6.2 TTY 渲染器状态机

```
           broker.onRequest(req)
                    │
                    ▼
          ┌──────────────────┐
          │   enter raw mode │
          │  (refcount +1)   │
          └────────┬─────────┘
                   │
                   ▼
          ┌──────────────────┐       ◀── up/down: move selected
          │  renderPanel()   │       ◀── 0-9: hotkey select
          │  (Ink-less       │       ◀── enter: confirm
          │   manual ANSI)   │       ◀── ctrl+c: cancel → deny
          └────────┬─────────┘       ◀── ctrl+d: cancel → cancelled
                   │
                   ▼
          ┌──────────────────┐
          │ selected option  │
          │ .kind = ?        │
          └───┬────────┬─────┘
              │        │
     inline   │        │ simple
      input   ▼        ▼
       ┌──────────┐  ┌──────────┐
       │ switch   │  │ resolve  │
       │ to input │  │ (broker) │
       │ mode,    │  └──────────┘
       │ buffer   │
       │ text     │
       └────┬─────┘
            │ enter
            ▼
       ┌──────────┐
       │ resolve  │
       │ with note│
       └──────────┘
```

**关键点**：
- **raw mode 引用计数**（学习 Claude Code 的 `rawModeEnabledCount`）：多个模态并存时不互相关闭 TTY。
- **Ctrl+C = deny**（学习 Hermes）：不抛异常，直接 resolve deny，干净。
- **Ctrl+D = cancelled**：区分"我拒绝这个操作"和"我退出程序"——前者走 deny+rejection 逻辑，后者走 cancelled+session-end 逻辑。
- **hotkey 与箭头导航并存**：初级用户箭头键，熟练用户按 `n` 直接拒绝。

### 6.3 面板布局（示例：bash 命令）

```
╭─ 安全确认 · #1 of 1 pending ─────────────────────────────╮
│                                                           │
│  Bash 命令                                                │
│                                                           │
│    $ npm install express                                  │
│                                                           │
│  ── 元数据 ──────────────────────                         │
│  cwd:           /home/user/projects/my-app                │
│  resolved path: /usr/local/bin/npm                        │
│  env vars:      PATH, HOME, NODE_ENV                      │
│  影响范围:      external                                  │
│  风险等级:      medium                                    │
│  匹配策略规则:  cf-network-tools (确认网络操作)           │
│                                                           │
│  💡 已经批准过 3 次相似操作                                │
│                                                           │
│  ❯ 允许这一次                                             │
│    允许并告诉我接下来怎么办... (y)                        │
│    始终允许 "npm install *" 在本工作区 (a)                │
│    始终允许 "npm install *" 全局 (g)                      │
│    本次会话内允许 "npm install *" (s)                     │
│    编辑命令后再允许 (e)                                   │
│    拒绝并告诉知行原因... (n/Esc)                      │
│                                                           │
│  ↑↓ 选择 · Enter 确认 · Esc 拒绝 · ? 帮助                 │
│                                                           │
╰───────────────────────────────────────────────────────────╯
```

**细节设计**：
- **标题行显示队列位置**：`#1 of 3 pending`——让用户知道后面还有。
- **元数据表格**：cwd / resolved path / env keys / 影响范围 / 风险等级 / 匹配规则。学习 OpenClaw Web 面板的元数据透明度。
- **智能建议内联**：如果同模式已被手动批准 ≥ 阈值，显示"已经批准过 N 次相似操作"提示。
- **hotkey 以小括号形式附在选项尾部**：既不抢占视觉又可供熟练用户使用。
- **底部快捷键条**：Claude Code 风格的操作提示。
- **"编辑命令后再允许"只在支持 edit 的工具上显示**（例如 bash / edit / write），对 read 不显示。
- **默认聚焦**按**风险等级反向**：low/medium 默认第一项（allow-once），high/critical 默认倒数第二项（deny-with-reason）。

### 6.4 原地重绘的 cursor 不变量 ⚠️ 实施者必读

> 本节由 2026-04-13 的实地调试沉淀——第一版原型在自动化测试里 8/8 全绿，但在真实 Windows Terminal 里按一次方向键就堆一行头部边框。根因是**把"擦除 N 行"写成了"移动 N-1 次"的 off-by-one**。实施 Step 2 时如果不守住下面的不变量，会再次撞到完全相同的 bug。

#### 不变量

**每次 `render()` 调用结束时，终端 cursor 必须位于 `(startRow + N, col 0)`**，其中 `N = lastRenderHeight`（本次渲染的行数），`startRow` = 首行所在终端行。

下次 `rerender()` 依赖这个位置成立：先上移 `N` 行回到 `startRow`，再逐行覆盖。

#### 正确的擦除 + 重绘

```typescript
function rerender() {
  // 前置条件：cursor 在 (startRow + lastRenderHeight, 0)
  if (lastRenderHeight > 0) {
    // 一次性上移 N 行；CSI nA 里 n 必须等于 lastRenderHeight，不是 N-1
    stdout.write(`\x1b[${lastRenderHeight}A\r`);
    // 现在 cursor 在 (startRow, 0)
  }
  const lines = render();
  for (const line of lines) {
    stdout.write("\r");            // col 0（防御式）
    stdout.write("\x1b[2K");       // 清整行
    stdout.write(line);            // 写新内容
    stdout.write("\r\n");          // 下一行，col 0（**必须用 \r\n 而非 \n**）
  }
  lastRenderHeight = lines.length;
  // 后置条件：cursor 回到 (startRow + N, 0) ✓
}
```

#### 三个致命陷阱

**陷阱 1：`\n` vs `\r\n`**

在 POSIX 的 xterm-compatible 终端里，LF (`\n`) 只下移一行、不重置列。raw mode 下尤其如此。不同终端对 LF 的处理参差不齐：
- Windows Terminal (VT 模式)：LF 通常会重置列
- iTerm2：LF 不重置列
- tmux/screen：依赖 cooked/raw 模式

**结论：分隔符永远写 `\r\n`，不要赌 `\n` 的行为。**

**陷阱 2：擦除循环的 off-by-one**

原型第一版的错误写法：

```typescript
for (let i = 0; i < lastRenderHeight; i++) {
  stdout.write("\r\x1b[2K");                  // clear 当前行
  if (i < lastRenderHeight - 1)
    stdout.write("\x1b[1A");                  // 只在非最后一次迭代上移
}
```

这段清了 N 行但只上移了 **N-1 次**，cursor 停在 `(startRow + 1, 0)`，**最顶行从来没被清过**。每次 rerender 都在已有的第一行下方重新渲染一遍完整面板 → 旧的第一行累积，看到的就是头部边框堆成山。

**规避**：永远不要用"边清边移"的循环。用"一次到位上移 + 从头逐行覆盖"的模式（见上面"正确的擦除 + 重绘"）。

**陷阱 3：`rl.pause()` 不解绑 readline 的 keypress 监听器**

> 2026-04-15 真实复现。测试用 `ping -c 4 google.com` 走 confirmation，在"允许并补充"input 模式下打中文，发现每个字符除了出现在 input 行，**同时被重复 echo 到面板下方**，混乱叠字。

根因：REPL 的 `readline.createInterface({ terminal: true })` 在内部订阅了 stdin 的 `'keypress'` 事件，每次 keypress 通过 `_ttyWrite` 把可打印字符 echo 到 stdout 的"当前 cursor 列位置"用于行编辑。

常见误解：调用方通过 `rl.pause()` 暂停 readline 消费就够了。实际上：

- `rl.pause()` 只翻 readline 的 `paused` 标志位，让它停止处理 line 事件；**它不 detach 任何监听器**（Node.js 也没有公开 detach API）。
- SelectWithInput 紧接着 `stdin.resume()` 让数据流恢复 flowing，此时 readline 预挂的 `'keypress'` 监听器照常收到事件。
- readline 的 `_ttyWrite` 不看 `paused` 标志，照常 echo 字符。

**select 模式下看不出来**，因为方向键 / Enter 不触发 printable echo；**一进 input 模式开始打字就炸**。

**规避**：组件自己保证"独占 stdin"，而不是依赖调用方。进入时 snapshot 现有 `'keypress'` 监听器并全部摘下（保守地只动这一个事件 —— `'data'` 是 `readline.emitKeypressEvents` 的 decoder 所在，不能动），退出时按原顺序恢复。同时用 per-call snapshot 保存 `stdin.isRaw` 原值，退出时恢复到该值而不是无脑 `false`（否则会破坏调用方 `readline.question()` 期望的 raw 状态）。

参考实现：[packages/cli/src/tui/select-with-input.ts](../../../packages/cli/src/tui/select-with-input.ts) 的 `finish()` + 初始化段；回归护栏见测试场景 #17。

#### Step 2 测试的最低门槛

仅靠"全绿 8 个端到端场景"**不够**——这 8 个场景都只断言最终 decision，不触及视觉输出。Step 2 的测试套件里**必须**有两类断言作为护栏：

1. **渲染次数 + 清行次数的恒等式**：一次渲染产生 `N` 次 clearLine (`\x1b[2K`)、`N-1` 次行分隔，`K` 次 rerender 总共应产生 `K * N` 次 clearLine、`K * (N-1)` 次分隔。用正则匹配捕获的 stdout 做计数断言。
2. **至少一条"渲染帧 diff"断言**：把连续两次 rerender 的输出拆成帧（按 `\x1b[NA\r` 切），断言两帧内容相等（因为我们重渲染的是同一面板）——这能抓住"漏清一行"类 bug。

没有这两类断言的测试**永远不会暴露这次的 off-by-one**。

#### 参考实现

> （2026-05-16 更新：原"生产实现见 `packages/cli/src/tui/select-with-input.ts`"已过时——该独立 alt-screen 组件被 commit 6baa41e 删除并由 chrome 内联 `SelectOperationRegion` 取代，详见 §6.1.1 节首更新说明。下列落地清单是 alt-screen 形态的历史记录，chrome 内联形态见 [select-operation-region.ts](../../../packages/cli/src/security/select-operation-region.ts)。)

历史落地版本（已删）在 ~200 行原型基础上补齐了：

- 加入 `stdout.columns` 自适应 + wcwidth CJK 宽度计算
- 加入 `process.stdout.on("resize", rerender)`
- 加入 raw mode 引用计数
- 补全 Step 2 §9.2 列的 15 条测试，**尤其是上面两类护栏断言**
- 接 `ConfirmationRenderer` 接口把它变成 broker 的订阅者

---

## 七、多 pending 并发处理

### 7.1 为什么会有多 pending

场景举例：
- 模型一次性要 `npm install A && npm install B && npm install C`——如果这些是独立 tool_use，并发发起三个审批请求
- 两个 subagent 并行跑，一个要 bash，一个要写文件
- 用户批准了第一个审批后第二个才到——第一个在显示，第二个在排队

### 7.2 队列模型

```
               requestConfirmation()
                       │
                       ▼
              ┌─────────────────┐
              │   queue (FIFO)  │
              │  [r1, r2, r3]   │
              └────────┬────────┘
                       │
                       │ head
                       ▼
              ┌─────────────────┐
              │  showing = r1   │
              │  renderer 正在  │
              │  显示并等待     │
              └────────┬────────┘
                       │
              resolve(r1, decision)
                       │
                       ▼
              ┌─────────────────┐
              │ queue = [r2,r3] │
              │ showing = r2    │
              └─────────────────┘
```

**行为合约**：
- **默认串行**：一次只显示一个
- **面板里显示"#N of M pending"**：用户知道后面还有
- **队列满时（>10）返回 `BackpressureError`**：防止模型失控生成 100 个请求淹没 UI
- **每个请求独立超时**：队列中的请求也在倒计时，超时时单独 expire 掉
- **取消会话时全部 `cancel(cause: "session-end")`**

### 7.3 批量操作

Phase 2+ 支持"把接下来所有同模式的请求一次性批准"：

```
智能体在一个 turn 里依次请求:
  1. npm install express     → 用户看到审批
  2. npm install cors        → 队列中
  3. npm install helmet      → 队列中

审批界面显示:
  "还有 2 个相似请求排队: npm install *"
  [B] 批量批准所有 "npm install *" 请求
```

选 `[B]` 时 broker 把队列中所有匹配模式的请求一次性 `resolve(allow-once)`。

---

## 八、与 SecurityPipeline 集成

### 8.1 调用点改造

**当前**（[packages/cli/src/security/secure-executor.ts](../../../packages/cli/src/security/secure-executor.ts) L99-122）：

```typescript
if (result.requiresConfirmation) {
  if (!prompt) throw new SecurityBlockError(...);
  const choice = await showConfirmationDialog({
    toolName, toolInput, result, prompt,
  });
  if (choice.kind === "deny") throw new SecurityBlockError(...);
  await applyUserChoice({ choice, pipeline, ... });
}
```

**目标**：

```typescript
if (result.requiresConfirmation) {
  const request = buildConfirmationRequest(tool, input, context, result);
  const decision = await broker.requestConfirmation(request);

  switch (decision.kind) {
    case "deny":
      throw new SecurityBlockError(
        `用户拒绝了操作${decision.reason ? "：" + decision.reason : ""}`,
        tool.name,
        decision.reason ?? "user declined",
      );

    case "cancelled":
      throw new SecurityBlockError(
        `审批被取消 (${decision.cause})`, tool.name, decision.cause,
      );

    case "expired":
      throw new SecurityBlockError(
        `审批超时 — 按 ${strategy} 策略默认拒绝`, tool.name, "expired",
      );

    case "edit-then-allow":
      // 用户改了 toolInput — 用修改后的版本继续执行
      input = decision.modifiedInput;
      break;

    case "allow-once":
    case "allow-session":
    case "allow-workspace":
    case "allow-global":
      await applyDecision(decision, pipeline, toolName, input, context);
      break;

    case "always-ask":
      await applyAlwaysAsk(decision.pattern, pipeline, workspaceId);
      // 继续执行这一次（always-ask 的 ask 规则从下一次生效）
      break;
  }
}
```

**关键变化**：
- 不再把 `prompt` 函数注入到 secure-executor——secure-executor 只看到 broker 接口
- `decision.kind = "deny"` 时，`reason` 字段（用户的拒绝原因）会进入 `SecurityBlockError.message`，进而成为 tool_result 文本回送到模型
- `edit-then-allow` 直接替换 `input` 变量，后续执行用新 input

### 8.2 拒绝理由回流到模型的完整路径

```
用户选 deny-with-reason: "不要用 rm，改用 rm -i"
      │
      ▼
broker.resolve(id, { kind: "deny", reason: "不要用 rm，改用 rm -i" })
      │
      ▼
secure-executor 抛 SecurityBlockError(
  message: "用户拒绝了操作：不要用 rm，改用 rm -i",
  toolName: "bash",
  reason: "不要用 rm，改用 rm -i"
)
      │
      ▼
agent-loop 捕获异常，把 message 包装成 tool_result
      │
      ▼
{
  role: "user",
  content: [{
    type: "tool_result",
    tool_use_id: "...",
    content: "用户拒绝了操作：不要用 rm，改用 rm -i",
    is_error: true
  }]
}
      │
      ▼
模型下一轮看到这条消息，调整行为
```

**这是差异化的核心一条**——要在 Phase 2 完整打通。

### 8.3 EventBus 事件

新增 `confirmation:*` 事件（不是 `security:*`，因为 confirmation 是更上层的交互概念）：

```typescript
type ConfirmationEventType =
  | "confirmation:requested"       // 请求入队
  | "confirmation:shown"           // 渲染器开始显示
  | "confirmation:resolved"        // 用户做出决定
  | "confirmation:cancelled"       // 被取消
  | "confirmation:expired"         // 超时
  | "confirmation:auto-resolved"   // 非交互策略自动决定
  | "confirmation:queue-shifted";  // 队列前进

interface ConfirmationEvent {
  type: ConfirmationEventType;
  requestId: string;
  tool: string;
  operationClass: OperationClass;
  riskLevel: RiskLevel;
  decision?: ConfirmationDecision;
  queueDepth: number;
  renderer?: string;
  timestamp: number;
}
```

---

## 九、渐进实现计划

### 9.1 原则

每一步必须：
- **独立**：能单独上线，不依赖后续步骤
- **可验证**：有具体的单元测试或手动验收标准
- **可回滚**：用 feature flag 或接口兼容性能随时切回旧路径
- **不破 823 测试**：现有测试不回归

### 9.2 步骤清单

#### Step 1 — ConfirmationBroker 核心类型与骨架（Core only）

**目标**：在 `@zhixing/core` 下新增 `confirmation/` 模块，实现 `ConfirmationBroker` 接口和默认实现 `DefaultConfirmationBroker`，但**不接入 SecurityPipeline**。

**交付物**：
- `packages/core/src/confirmation/types.ts` — `ConfirmationRequest` / `ConfirmationDecision` / `ConfirmationOption` / `ConfirmationRenderer`
- `packages/core/src/confirmation/broker.ts` — `DefaultConfirmationBroker` 实现（FIFO 队列 + 串行锁 + grace period）
- `packages/core/src/confirmation/non-interactive.ts` — 策略实现
- `packages/core/src/confirmation/__tests__/broker.test.ts` — 至少 20 个测试

**验收**：
- 测试覆盖队列 FIFO、串行串行、grace period、超时、取消、并发 resolve 的幂等性
- 完全不依赖任何 CLI/TTY 代码
- 新增测试全绿 + 已有 823 测试无回归

**代码量估计**：~500 行

---

#### Step 2 — 自研 `SelectWithInput` 核心组件（Core 或 CLI 内部库）

**目标**：基于可行性调研（见 §6.1.1），**一步到位**实现包含 inline input 能力的纯 Node 组件。不走 `@inquirer/prompts` 过渡。

> （2026-05-16 更新：本 Step 与 Step 3 的 `select-with-input.ts` 独立 alt-screen 组件**已被 chrome 内联 `SelectOperationRegion` 取代并删除**，详见 §6.1.1 节首更新。下方为历史规划，现状实现见 [select-operation-region.ts](../../../packages/cli/src/security/select-operation-region.ts) + [terminal-renderer.ts](../../../packages/cli/src/security/terminal-renderer.ts)。）

**交付物**（历史规划，已删）：
- `packages/cli/src/tui/select-with-input.ts` — 核心组件，纯函数接口：
  ```typescript
  export interface SelectWithInputOptions {
    title: string;
    body: string | string[];     // 支持多行 body
    options: SelectOption[];
    stdin?: NodeJS.ReadStream;    // 默认 process.stdin
    stdout?: NodeJS.WriteStream;  // 默认 process.stdout
    theme?: SelectTheme;          // 颜色 / 边框字符自定义
    signal?: AbortSignal;         // 外部取消
  }
  export function selectWithInput(opts): Promise<SelectDecision>;
  ```
- `packages/cli/src/tui/ansi.ts` — ANSI 转义码常量集（clearLine / moveUp / hideCursor / color 等）
- `packages/cli/src/tui/line-width.ts` — 根据 `stdout.columns` 做行截断（含 wcwidth 对 CJK 全角字符的处理）
- `packages/cli/src/tui/__tests__/select-with-input.test.ts` — vitest 用 `PassThrough` 驱动的测试，至少覆盖：
  1. 首项 Enter → value
  2. 多次 down + Enter → value
  3. Ctrl+C → cancelled cause="ctrl-c"
  4. Ctrl+D → cancelled cause="ctrl-d"
  5. Enter 进入 input 模式，typing → buffer 累积
  6. Backspace 在 input 模式
  7. Enter 提交（allowEmptySubmit=true）→ 带 note
  8. Enter 提交（allowEmptySubmit=false）+ 空 buffer → 不提交
  9. Esc 在 input 模式 → 返回 select 模式
  10. UTF-8 多字节输入（中文）
  11. **渲染帧数恒等式**：K 次 rerender → K·N 次 `\x1b[2K`、K·(N-1) 次 `\r\n`（护栏，见 §6.4）
  12. **连续两次 rerender 输出同一面板时帧内容完全相等**（护栏，见 §6.4）
  13. resize 事件触发 rerender 且不产生堆叠
  14. 窄终端（columns < 40）的回退布局
  15. 长命令 body 的 truncate 行为
  16. 外部 signal.abort() → cancelled cause="aborted"
  17. **stdin 独占护栏**：调用前预挂一个 keypress listener；selectWithInput 生命周期内该 listener 收到 0 次事件；finish 后重新写字符到 stdin，listener 恢复收到（护栏，见 §6.4 陷阱 3）

> ⚠️ **历史教训 §6.4**。原型第一版在上面这些断言的前 10 条都 PASS，但因为缺少 #11 #12 两条护栏，cursor off-by-one bug 一直到真实 TTY 手动验收才暴露。后续 Phase 1 集成到 REPL 后又在真实终端暴露了陷阱 3（双消费者 echo），由场景 #17 作为回归护栏。生产版本 [packages/cli/src/tui/select-with-input.ts](../../../packages/cli/src/tui/select-with-input.ts) 已含全部修复；后续改动前请读 §6.4 的"致命陷阱"避免回归。

**行为保证**：
- ✅ 上/下箭头导航
- ✅ Enter 确认（进入 input 或直接 resolve）
- ✅ Ctrl+C → `{ kind: "cancelled", cause: "ctrl-c" }`
- ✅ Ctrl+D → `{ kind: "cancelled", cause: "ctrl-d" }`
- ✅ Esc 在 input 模式退出回 select 模式
- ✅ Esc 在 select 模式直达"deny"（如果有 deny 选项）
- ✅ Printable 字符通过 `str` 字段写入 buffer（支持 UTF-8）
- ✅ Backspace 删一字符
- ✅ 面板原地重绘，无滚屏
- ✅ 宽度自适应 + CJK 全角字符宽度正确计算
- ✅ 终端 resize 自动 rerender

**验收**：
- 上述 15 个 Vitest 场景全绿
- 手动在 Windows Terminal 里跑 `manual-tty-test.mjs` 等价物：箭头 / Enter / 输入中文 / Ctrl+C 全部可用
- `chalk` 的颜色在支持的终端正确显示，`NO_COLOR=1` 时自动降级

**代码量估计**：~500 行（component 核心 ~280 + ansi helper ~40 + line-width ~80 + 测试 ~100）

---

#### Step 3 — `TerminalConfirmationRenderer`：把 SelectWithInput 接到 Broker

**目标**：让 `secure-executor` 走 broker 路径而不是直接调 `showConfirmationDialog`。旧的 `showConfirmationDialog` 继续存在作为"legacy fallback"，用 feature flag `ZHIXING_CONFIRMATION_RENDERER` 控制走哪条。

**交付物**：
- 改 `packages/cli/src/security/secure-executor.ts` 支持两条路径
- 改 `packages/cli/src/repl.ts` 组装 broker 并挂载 terminal renderer
- `packages/cli/src/__tests__/secure-executor.test.ts` 增加 broker 路径测试

**验收**：
- 默认走 broker 路径
- 设 `ZHIXING_CONFIRMATION_RENDERER=legacy` 时走老路径
- `secure-executor.test.ts` 两条路径都测
- 手动在 REPL 里验证两条路径都工作

**代码量估计**：~200 行

---

#### Step 4 — 拒绝理由回流模型的完整打通

**目标**：让拒绝理由真正影响模型行为。

**交付物**：
- `SecurityBlockError.message` 保持含理由
- agent-loop 捕获异常后生成 `tool_result` 时使用 message
- 端到端集成测试：mock provider 里的第一轮模型调用要 `rm -rf /`，secure-executor 拦下；测试代码模拟用户拒绝并输入"改用 rm -i"；验证第二轮模型看到的 tool_result 包含这句话

**验收**：
- 端到端测试绿
- 文档更新：描述这个反馈回路

**代码量估计**：~150 行

---

#### Step 5 — 多 pending 队列视图

**目标**：当队列深度 ≥ 2 时，面板显示"#N of M pending"；添加 `[B] 批量批准所有相似` 选项。

**交付物**：
- `ConfirmationBroker.onQueueChange` 事件
- Terminal renderer 订阅队列变化并在标题行更新
- 批量批准逻辑

**验收**：
- 集成测试：同一 turn 里触发 3 个相似请求，验证队列深度提示正确显示
- 批量批准后，后续两个请求自动 allow-once
- 代码量估计：~200 行

---

#### Step 6 — NonInteractiveStrategy 与预审批 API

**目标**：非交互模式（CI / 消息网关）下不是硬拒绝，而是查询**预审批列表**。

**交付物**：
- `NonInteractiveStrategy = "fail-to-deny" | "delegate-to-preapproval"`
- 配置项 `zhixing.config.json.security.preapproval.rules[]`
- 查询逻辑：非交互模式下遇到 confirm 请求时，先查预审批规则，命中则放行，否则按 strategy 决定

**验收**：
- CI 模式下预审批规则命中 → 放行
- CI 模式下不命中 → 拒绝
- 配置热加载（不需要重启 REPL）
- 代码量估计：~250 行

---

#### Step 7 — `alwaysAsk` 规则类型

**目标**：把 Claude Code 的 `alwaysAsk` 引入 PermissionStore。

**交付物**：
- `PermissionRule.decision` 增加 `"ask"` 变体
- PermissionMatcher 遇到 ask 规则时返回 `requiresConfirmation=true` 即使是 observe/internal 分类
- Confirmation 选项增加 `always-ask`
- `/trust list` 显示 ask 规则

**验收**：
- 单元测试：创建 ask 规则后，相关操作每次都弹审批
- 代码量估计：~200 行

---

#### Step 8 — Edit-then-allow（编辑后再批准）

**目标**：Claude Code 的 `updatedInput` 能力在用户手里。

**交付物**：
- 选项 `edit-then-allow` 在 bash/edit/write 工具上启用
- 选中后进入**多行编辑模式**（基于 JSON 结构化编辑或自由文本命令编辑）
- 编辑完成后重跑一次 SecurityPipeline.evaluate（因为参数变了可能命中不同规则）
- 第二次评估仍然 confirm 时**不再弹 edit 选项**（避免死循环）

**验收**：
- 手动验收：编辑命令后能继续执行修改后的版本
- 代码量估计：~400 行

---

#### Step 9 — 首次项目信任对话框

**目标**：学习 Claude Code，首次在某项目启动时弹一次"你信任这个项目的 .zhixing/ 配置吗"。

**交付物**：
- 首次启动检测：检查 `~/.zhixing/trusted-projects.json` 是否包含当前工作区
- 弹一次特殊的信任对话框（标题不是"安全确认"而是"项目信任"）
- 用户选"信任"后写入 trusted-projects 并继续正常加载项目级规则

**验收**：
- 首次启动弹对话框
- 同意后下次不弹
- 代码量估计：~250 行

---

#### Step 10 — Smart LLM 分诊（可选，Phase 3）

**目标**：仿照 Hermes / Claude Code Auto 模式，可选地引入 LLM 辅助分诊作为 broker 前置过滤器。

**交付物**：
- `SmartTriagePreprocessor implements ConfirmationPreprocessor`
- 三态输出：approve / deny / escalate-to-user
- 配置：`security.confirmation.smartTriage = { enabled, model, maxTokens }`
- 熔断机制：连续 3 次或累计 20 次被用户否决 → 自动禁用

**验收**：
- 单元测试 + 集成测试
- 代码量估计：~350 行

---

#### Step 11 — Web Renderer（远期）

**目标**：把同一个 broker 接入 Web UI（如果未来有）。

不在本 spec 范围内——列在这里只是证明 Phase 1-10 的架构确实支持。

---

### 9.3 里程碑总结

| Phase | Steps | 增量代码 | 里程碑 |
|---|---|---|---|
| **Phase 1: 解耦 + 自研 TTY + 反馈回路** | 1-4 | ~1350 行 | broker 架构就位、箭头+输入 TTY 可用、拒绝/补充理由打通回流模型 |
| **Phase 2: 队列 + 预审批 + ask 规则** | 5-7 | ~650 行 | 并发场景和 CI 场景都优雅 |
| **Phase 3: 编辑 + 信任 + 智能** | 8-10 | ~1000 行 | 高级能力补齐 |

总代码量预估：**~3000 行**（含测试）。作为对比：Claude Code 权限系统 52K+、OpenClaw ~3000、Hermes ~2000、知行现有 confirmation-ui ~220。

> **Phase 1 的里程碑对比旧版规划有升级**：旧版需要 Phase 1 + Phase 2 两段（Steps 1-5）才打通"拒绝带原因"；可行性调研后确认可以合并 `@inquirer/prompts` 过渡和自研替换为一步，Phase 1 就能交付完整差异化。

---

## 十、与竞品的最终对比

| 维度 | OpenClaw | Hermes | Claude Code | **知行（设计后）** |
|---|---|---|---|---|
| 交互方式 | readline y/N | prompt_toolkit ↑↓ | Ink ↑↓ | **raw-mode ↑↓ + hotkey** |
| 批准+补充说明 | ❌ | ❌ | ✅ | ✅ |
| **拒绝+回送原因** | ❌ | ❌ | ✅ | ✅ |
| 编辑后再批准 | ❌ | ❌ | ⚠️ 仅 hook | ✅ **用户侧** |
| 首次项目信任 | ⚠️ | ❌ | ✅ | ✅ |
| 命令 sanitize | ✅ | ❌ | ⚠️ | ✅ |
| sha256 执行计划绑定 | ✅ | ❌ | ❌ | ✅ |
| 多 pending 队列视图 | ⚠️ 仅 Web | ❌ | ❌ | ✅ **CLI 也有** |
| 按威胁类型动态选项 | ❌ | ✅ | ⚠️ | ✅ |
| LLM 分诊 | ❌ | ✅ | ✅ | ✅ **可选** |
| alwaysAsk 规则 | ❌ | ❌ | ✅ | ✅ |
| Ctrl+C = deny | ⚠️ | ✅ | ✅ | ✅ |
| 并发串行锁 | ✅ RPC 天然 | ✅ | ⚠️ | ✅ |
| 多通道可扩展 | ✅ 最前瞻 | ⚠️ 进程内 | ❌ 紧耦合 Ink | ✅ **Renderer 接口** |
| 非交互兜底 | askFallback | fail-open ⚠️ | 非 TTY block | **fail-to-deny** 默认 |
| 预审批 API | ✅ allowlist | ⚠️ allowlist | ⚠️ settings.json | ✅ **策略化** |
| 可测试性 | ⚠️ 强耦合 RPC | ⚠️ 全局状态 | ⚠️ Ink 难测 | ✅ **Broker 纯逻辑** |

**知行在 12 个维度中 11 个并列/领先，唯一没超过的是 OpenClaw 的"多通道路由成熟度"**——但这一项知行在 Phase 1 架构上已经预留，只是没做 Web/微信 renderer。

---

## 十一、风险与待决项

### 11.1 风险

1. ~~**自研 select-with-input 组件的工程量被低估**~~ **[已消除 2026-04-13]**：做了专项可行性调研，~200 行原型跑通 8 个端到端场景（含 Ctrl+C / UTF-8 中文 / backspace / empty-submit 等），证明纯 Node 原生 API + ANSI 已经足够。详见 §6.1.1。
2. **broker grace period 与 session 隔离**：多个 REPL 会话共享 broker 时，某个会话结束但 grace period 未过，会不会污染下一个会话？**答：broker 按 session 维度隔离，会话结束时 `broker.cancelAll({cause:"session-end"})`**。
3. **非交互模式 fail-to-deny 可能让 CI 体验变差**：需要预审批 API（Step 6）同步上线。Step 6 可以和 Step 3 并行做，不必等 Step 5。
4. **edit-then-allow 的二次评估可能陷入循环**：用户改命令后，改完的命令可能又触发 confirm。需要限制"一个请求最多 edit 一次"，第二次 confirm 时去掉 edit 选项。
5. **Windows legacy cmd.exe 的 ANSI 支持不完整**：Win11 默认是 Windows Terminal 所以无影响，但如果有用户显式用 cmd.exe 跑 zhixing 就会看到乱码。缓解：TTY 启动时探测 ANSI 能力，降级到无游标 + 纯文本列表模式（足够可用）。

### 11.2 待与用户确认

1. ~~**`@inquirer/prompts` 作为 Phase 1 过渡是否可接受**~~ **[已决定 2026-04-13]**：可行性调研证明自研组件零依赖 ~500 行即可，跳过过渡阶段。
2. **"批准并追加 note" 这个选项的 note 用在哪里**？
   - 设计 A：和拒绝原因对称，note 回流到 tool_result 让模型看到
   - 设计 B：note 只是本地日志，不回送模型
   - **推荐 A**——对称设计更一致
3. **是否做批量审批（Step 5）**？
   - 知行的 session 自动批准机制已经部分解决这个问题（第一次选"会话允许"后续自动过）
   - **推荐做**，和 session 机制互补
4. **`alwaysAsk` 规则的存在是否会让用户困惑**？（"为什么我有规则但还是问我"）
   - **推荐做**，UI 上清楚标注"此规则要求每次确认"就没问题

---

## 十二、附录：术语表

| 术语 | 定义 |
|---|---|
| **Broker** | 审批调度器，负责 request 入队、serialization、decision 派发 |
| **Renderer** | 审批渲染器，把 request 变成用户能看到的 UI 并收集决定 |
| **NonInteractiveStrategy** | 无渲染器或非交互模式下的兜底决策器 |
| **grace period** | 请求 resolve 后仍保留在 broker 里的时间窗，用于处理迟到的 resolve 调用 |
| **inline input** | select list 中某一项本身是文本输入框的组件形态 |
| **edit-then-allow** | 用户在审批时修改工具参数后再批准 |
| **alwaysAsk** | 一种规则类型，匹配的操作每次都弹审批而不是允许或拒绝 |
| **预审批 (preapproval)** | 非交互模式下预先配置的"允许此模式"规则列表 |
| **TOCTOU** | Time-Of-Check-To-Time-Of-Use 竞态——审批时文件/环境 X，执行时 Y |
| **raw mode** | 终端模式，按键立即传到程序（而不是按回车后才传整行） |
