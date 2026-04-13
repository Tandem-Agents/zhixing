# OpenClaw 确认交互 UX — 源码解析

> **所属系统**: OpenClaw | **焦点**: CLI/TUI 的审批请求交互  
> **源码位置**: `e:/Dev/longxia/openclaw-main/`  
> **分析日期**: 2026-04-13  
> **核对方式**: 直接阅读下列源文件并记录真实行号

## 架构总览：守护进程 + 通道路由 + 两阶段注册

OpenClaw 把审批**从本地 UI 彻底解耦**，做成一套**以 Gateway 为中心的分布式审批协议**：

```
┌──────────┐   1. register        ┌──────────────────┐
│  Agent   │─────────────────────▶│  Gateway Server  │
│ (bash    │                      │                  │
│  tool)   │◀─ 2. accepted (id) ──│  ExecApproval    │
│          │                      │  Manager         │
└──────────┘                      │   (in-mem Map)   │
      │                           └────────┬─────────┘
      │ 3. waitDecision(id)                │
      │                                    │ 4. broadcast "exec.approval.requested"
      ▼                                    ▼
┌──────────────────────────────┐     ┌──────────────────────────────┐
│ polling on gateway           │     │  approval clients            │
│ (agent thread blocked)       │     │  ─ Web Lit modal             │
│                              │     │  ─ Discord button forwarder  │
│                              │     │  ─ CLI readline (ACP)        │
│                              │     │  ─ Slack / iMessage / ...    │
└──────────────────────────────┘     └──────────────┬───────────────┘
      ▲                                             │ 5. exec.approval.resolve
      │                                             │
      └──── 6. decision returned ───────────────────┘
```

**核心特征**：
1. **注册 (synchronous) 与等待 (async) 分离** — 让调用方先收到 "accepted + id"，再另开一条 RPC 等决定
2. **Gateway 内存态 Map** 承载所有 pending 审批
3. **任何通道都可以应答** — 审批可以从微信按钮进来也可以从 Web 弹窗进来
4. **CLI 只是众多通道之一** — 它没有本地 UI 优势

## 核心数据结构

### 三种决定（`src/infra/exec-approvals.ts:116`）

```typescript
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
```

### 审批请求载荷（`src/infra/exec-approvals.ts:78-99`）

```typescript
export type ExecApprovalRequestPayload = {
  command: string;                // 原始命令文本
  commandPreview?: string | null; // 终端安全显示版（已 sanitize ANSI 等）
  commandArgv?: string[];
  envKeys?: string[];             // 环境变量 key 列表（不含值，UI 安全）
  systemRunBinding?: ... | null;  // 可执行文件路径/cwd/env 的 sha256 绑定
  systemRunPlan?: SystemRunApprovalPlan;  // 含 mutableFileOperand: {argvIndex,path,sha256}
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;       // "deny" | "allowlist" | "full"
  ask?: string | null;            // "off" | "on-miss" | "always"
  allowedDecisions?: readonly ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;   // 解析后的可执行文件绝对路径
  sessionKey?: string | null;
  // 调用源的通道回传信息——由谁触发就由谁回复
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};
```

**这个 payload 就是整个设计的基石**——它包含了足够多的元数据让任何通道渲染出一个像样的审批卡片。特别值得注意：

- **`commandPreview` 独立于 `command`** — sanitize 层把 ANSI/控制字符从显示版清理掉，但真正执行的还是原始 `command`，避免"审批看到的"与"实际跑的"不一致
- **`systemRunBinding`** 含 argv + cwd + env 的 sha256 哈希 — 审批是对**一份确定的执行计划**的签字，不能批准后被偷换
- **`mutableFileOperand.sha256`** — 如果命令会修改某个文件，**该文件当前内容的 sha256** 一并记录，防止 TOCTOU
- **`turnSource*` 四元组** — 完整记录了"这个审批请求是从哪个通道的哪个账号/群/线程触发的"，让决策可以回流到同一位置
- **`envKeys` 不含 value** — 只泄露环境变量的名字给 UI，不泄露秘密

### allowlist 持久化（`src/infra/exec-approvals.ts:123-146`）

```typescript
export type ExecAllowlistEntry = {
  id?: string;
  pattern: string;                        // glob，如 "~/Projects/**/bin/rg"
  source?: "allow-always";
  commandText?: string;                   // 原始命令文本（诊断用）
  argPattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: { path?: string; token?: string };  // 本地 daemon socket
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;  // 按 agent id 隔离
};
```

**持久化格式特点**：
- 存在 `~/.openclaw/exec-approvals.json`（JSON5 格式，允许注释）
- 同一个目录下有 `~/.openclaw/exec-approvals.sock` — **本地 daemon 用 Unix domain socket 做规则查询和修改**，不是简单的读写文件
- **按 agent id 维度隔离**：`agents["main"]`、`agents["coder"]`、`agents["*"]`（通配符）
- 每条规则带 `lastUsedAt` + `lastUsedCommand` — 可做"最近未用"的清理

## 关键代码路径

### 1. 两阶段注册（`src/agents/bash-tools.exec-approval-request.ts:88-111`）

```typescript
export async function registerExecApprovalRequest(
  params: RequestExecApprovalDecisionParams,
): Promise<ExecApprovalRegistration> {
  // Two-phase registration is critical: the ID must be registered server-side
  // before exec returns `approval-pending`, otherwise `/approve` can race and orphan.
  const registrationResult = await callGatewayTool<{
    id?: string;
    expiresAtMs?: number;
    decision?: string;
  }>(
    "exec.approval.request",
    { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
    buildExecApprovalRequestToolParams(params),
    { expectFinal: false },
  );
  const decision = parseDecision(registrationResult);
  const id = parseString(registrationResult?.id) ?? params.id;
  const expiresAtMs = parseExpiresAtMs(registrationResult?.expiresAtMs)
    ?? Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
  if (decision.present) {
    // 注册时服务端已经能直接给出决定（例如 allowlist 命中）
    return { id, expiresAtMs, finalDecision: decision.value };
  }
  return { id, expiresAtMs };
}
```

**`expectFinal: false` 就是两阶段的关键** — RPC 框架被告知 "这个请求会先返回一次 accepted，再返回一次 final"。对已命中 allowlist 的请求直接返回 final，否则只返 accepted + id。

### 2. Gateway 服务端处理（`src/gateway/server-methods/exec-approval.ts:169-254`）

```typescript
let decisionPromise;
try {
  decisionPromise = manager.register(record, timeoutMs);  // 同步入 Map
} catch (err) {
  respond(false, undefined, errorShape(...));
  return;
}
context.broadcast(                                        // 广播事件
  "exec.approval.requested",
  { id: record.id, request: record.request, createdAtMs, expiresAtMs },
  { dropIfSlow: true },                                  // 慢客户端不拖累
);
const hasExecApprovalClients = context.hasExecApprovalClients?.(client?.connId) ?? false;
const hasTurnSourceRoute = hasApprovalTurnSourceRoute({
  turnSourceChannel: record.request.turnSourceChannel,
  turnSourceAccountId: record.request.turnSourceAccountId,
});
let forwarded = false;
if (opts?.forwarder) {
  forwarded = await opts.forwarder.handleRequested({...});
}
if (!hasExecApprovalClients && !forwarded && !hasTurnSourceRoute) {
  // 无审批客户端、无转发器、无通道回传路径——直接过期
  manager.expire(record.id, "no-approval-route");
  respond(true, { id: record.id, decision: null, ... });
  return;
}
if (twoPhase) {
  respond(true, { status: "accepted", id: record.id, ... });  // 先发"已接收"
}
const decision = await decisionPromise;                        // 阻塞等决定
respond(true, { id: record.id, decision, ... });               // 发最终结果
```

### 3. ExecApprovalManager — 带 grace period 的内存态（`src/gateway/exec-approval-manager.ts`）

```typescript
const RESOLVED_ENTRY_GRACE_MS = 15_000;  // 已 resolve 后仍保留 15s

register(record, timeoutMs): Promise<ExecApprovalDecision | null> {
  const existing = this.pending.get(record.id);
  if (existing) {
    if (existing.record.resolvedAtMs === undefined) return existing.promise;
    throw new Error(`approval id '${record.id}' already resolved`);  // 幂等但不可重用
  }
  // ... 创建新 entry 加到 Map
  entry.timer = setTimeout(() => this.expire(record.id), timeoutMs);
  this.pending.set(record.id, entry);
  return promise;
}

consumeAllowOnce(recordId): boolean {
  // allow-once 必须被原子消费——防止 grace period 内被重放
  if (record.decision !== "allow-once") return false;
  record.decision = undefined;
  return true;
}

lookupPendingId(input): ExecApprovalIdLookupResult {
  // 前缀匹配——用户不用敲完整 UUID
  // 返回 "exact" | "prefix" | "ambiguous" | "none"
  ...
}
```

这里有**四个细节**值得注意：

1. **grace period (15s)** — resolved 后 Map 不立即删除，让迟到的 `awaitDecision` 还能找到答案。
2. **`consumeAllowOnce`** — `allow-once` 决定在 grace 期间**必须被原子消费**。避免同一个 runId 被重放。
3. **`lookupPendingId` 做前缀匹配** — 在 `/approve ab12` 之类的 CLI 交互里用户只要敲前几位。ambiguous 时返回前 3 个候选给错误消息。
4. **`register` 对同 id 幂等但已 resolved 的不可复用** — 再调用同 id 会抛错而不是静默覆盖。

### 4. CLI 侧 UX —— 两套兜底都很薄

**A. 通用 Y/N 提示**（`src/cli/prompt.ts`，21 行）：

```typescript
export async function promptYesNo(question: string, defaultYes = false): Promise<boolean> {
  if (isYes()) return true;  // --yes 全自动
  const rl = readline.createInterface({ input, output });
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
  rl.close();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}
```

这个函数**不服务于 exec 审批主流程**——它用于 CLI 内部的一般确认（如"确定要删除这条规则吗？"）。

**B. ACP 客户端适配层**（`src/acp/client.ts:72-160`）：

```typescript
function promptUserPermission(toolName?: string, toolTitle?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);  // 非 TTY 自动拒绝
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    // ...
    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);
    const label = toolTitle ? (toolName ? `${toolTitle} (${toolName})` : toolTitle) : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = answer.trim().toLowerCase() === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}
```

- **30 秒硬超时**，超时→拒绝
- **非 TTY → 立即拒绝**
- **prompt 写到 stderr**，不污染 stdout（便于 agent 输出管道化）
- **依然只有 y/N**，没有"允许会话"/"永久允许"的独立入口

### 5. 客户端侧分类器（`src/acp/approval-classifier.ts`，228 行）

OpenClaw 在 CLI 进程内先跑一层**轻量分类器**决定要不要触发 prompt：

```typescript
export type AcpApprovalClass =
  | "readonly_scoped"   // 读文件且路径在 cwd 内 → autoApprove
  | "readonly_search"   // search/web_search/memory_search → autoApprove
  | "mutating"          // 写入类 → 需要 prompt
  | "exec_capable"      // exec/spawn/shell/bash/process/code_execution → 需要 prompt
  | "control_plane"     // sessions_spawn/sessions_send/session_status → 需要 prompt
  | "interactive"
  | "other"
  | "unknown";          // 未知工具名 → 需要 prompt
```

对 `read` 工具还做了**路径作用域判断**：

```typescript
function isReadToolCallScopedToCwd(..., cwd): boolean {
  if (toolName !== "read") return false;
  const rawPath = resolveToolPathCandidate(...);
  if (!rawPath) return false;
  const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
  if (!absolutePath) return false;
  const root = path.resolve(cwd);
  const relative = path.relative(root, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
```

这是客户端 fast-path：**读 cwd 内的文件不弹 prompt**，但读工作区外的就要问。**这个判断和知行的 `FileSystemClassifier` 几乎一样**。

## 配置体系 — ExecSecurity × ExecAsk 二维

```typescript
type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";
```

| `security`  | `ask`      | 行为 |
|-------------|-----------|------|
| `deny`      | *         | 拒绝一切未允许命令 |
| `allowlist` | `off`     | 命中 allowlist 则执行，否则拒绝 — 从不弹 prompt |
| `allowlist` | `on-miss` | 命中则执行，否则弹 prompt |
| `full`      | `off`     | 完全放行 — "yolo" |
| `full`      | `always`  | 每次都弹 prompt（无论 allowlist） |

`DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1_800_000`（**30 分钟**，不是 30 秒——CLI prompt 的 30s 是更内层的兜底超时）。

此外 `askFallback: ExecSecurity`（当无审批路由时用哪个安全档位兜底）—— 这是**比简单"超时=拒绝"更有层次的兜底策略**。

## 值得借鉴的核心模式

| # | 模式 | 价值 |
|---|------|------|
| 1 | **两阶段 RPC 注册** | 彻底避免"审批 id 尚未落地就被 /approve" 的竞态 |
| 2 | **commandPreview 独立于 command** | 显示与执行分离，防 ANSI 注入显示欺骗 |
| 3 | **systemRunBinding + mutableFileOperand.sha256** | 对"执行计划"签字，防 TOCTOU |
| 4 | **turnSource 四元组回传路由** | 从哪个通道来回哪个通道，支持多通道异构协作 |
| 5 | **envKeys 只传 key 不传 value** | UI 能看见"要用哪些环境变量"但看不见秘密 |
| 6 | **grace period + consumeAllowOnce** | resolved 不立即清理 + 原子消费 = 防重放 |
| 7 | **前缀匹配 id 查找 + ambiguous 候选列表** | CLI 里不用打全 UUID |
| 8 | **ExecSecurity × ExecAsk 二维策略** | 比单维 deny/allow 表达力强，支持 allowlist-only + 弹 prompt-always 等 |
| 9 | **按 agent id 隔离的 allowlist** | 同主机多 agent 互不信任 |
| 10 | **客户端轻量分类器 (readonly_scoped / readonly_search 自动放行)** | 和知行 FileSystemClassifier 思路一致 |
| 11 | **askFallback 而非简单"超时拒绝"** | 降级时仍可按策略决定方向 |
| 12 | **socket-based 本地 daemon 规则查询** | 比反复读 JSON 文件高效，支持跨进程共享 |

## 局限与可改进点

1. **CLI 原生 UX 空洞**：通道优先架构的代价——孤立 CLI 没有通道订阅就原地挂起。ACP 适配层的 y/N readline 太薄。
2. **只有 y/N，没有多选项快捷键**：想在 CLI 里"选始终允许"需要跳到 `openclaw approvals allowlist add` 命令，不能在同一次审批里完成。
3. **无"编辑后再批准"**：所有决定都是二选一，无法修改将要执行的命令。
4. **无"拒绝并告诉 agent 原因"反馈回路**：拒绝就是单纯的拒绝，没有把拒绝文本回送到模型。
5. **allowlist 只能表达"命令前缀 + 路径 glob"**：无法表达"允许 `rm -i` 但不允许 `rm -f`"这类参数级语义。
6. **没有多 pending 审批的 CLI 视图**：Web 有队列 UI，CLI 没有。

## 可直接搬到知行的设计元素

- ✅ **两阶段注册模式**（核心抽象：`ConfirmationBroker`）
- ✅ **commandPreview / 执行快照分离**
- ✅ **envKeys 只传 key 的原则**
- ✅ **ExecSecurity × ExecAsk 二维策略**
- ✅ **客户端分类器 fast-path**（知行已经有 `FileSystemClassifier`，思路吻合）
- ✅ **Grace period + consumeAllowOnce**（防重放）
- ✅ **前缀匹配 id 查找**（对 CLI `/trust revoke` 已经在用）
- ⚠️ **turnSource 通道回传** — 远期多通道准备，短期只需预留接口
- ❌ **ACP 协议兼容** — 不做，知行走自己的管线更干净
- ❌ **单独 allowlist 文件 + 本地 daemon socket** — 知行已经有 `PermissionStore`，不重复造
