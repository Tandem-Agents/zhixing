# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。每完成一步更新状态，全部完成后可归档或删除。

## 状态总览

| Step | 名称 | 状态 | 依赖 |
|------|------|------|------|
| 0 | 词汇对齐 | ✅ 已完成 | 无 |
| 1 | ConversationRepository | 🔲 待开始 | Step 0 |
| 2 | TranscriptStore 适配 | 🔲 待开始 | Step 0, 1 |
| 3 | CLI 对接 Conversation | 🔲 待开始 | Step 2 |
| 4 | ScenarioEvaluator + ContextProfile | 🔲 待开始 | Step 0 |
| 5 | LayerAssembler + TurnDigest | 🔲 待开始 | Step 4 |
| 6 | WindowManager + Pinning | 🔲 待开始 | Step 5 |
| 7 | ConversationManager + SessionRuntime | 🔲 待开始 | Step 3, 6 |
| 8 | Ephemeral Conversation + auto-promote | 🔲 待开始 | Step 7 |

```
Step 0 (词汇对齐)
    ↓
    ├── 左线 ───────────────────┐  ├── 右线 ────────────────┐
    ↓                           │  ↓                        │
Step 1 (ConversationRepository) │  Step 4 (ScenarioEvaluator)│
    ↓                           │      ↓                    │
Step 2 (TranscriptStore 适配)   │  Step 5 (LayerAssembler)  │
    ↓                           │      ↓                    │
Step 3 (CLI 对接)               │  Step 6 (WindowManager)   │
    ↓                           │      ↓                    │
    └───────────────────────────┴──────┘
                    ↓
            Step 7 (ConversationManager + SessionRuntime)
                    ↓
            Step 8 (Ephemeral + auto-promote)
```

## 设计规格引用

本路线图的实现目标来源于以下设计规格：

| 规格 | 文档 | 覆盖 Steps |
|------|------|-----------|
| 对话模型 | [conversation-model.md](specifications/conversation-model.md) | 0, 1, 2, 3, 7, 8 |
| 上下文架构 | [context-architecture.md](specifications/context-architecture.md) | 4, 5, 6 |
| 智能体运行时 | [persistent-service.md](specifications/persistent-service.md) | 7, 8 |
| Server Gateway | [server-gateway.md](specifications/server-gateway.md) | 7 |

---

## Step 0: 词汇对齐 (Vocabulary Alignment)

**目标：** 将代码中的命名与 [conversation-model.md](specifications/conversation-model.md) §3-5 的三层概念模型对齐

**性质：** 纯机械重命名，零逻辑变更

**为什么先做这一步：**
- 消除"代码说 Session、脑中想 Conversation"的认知翻译成本
- 为后续所有 Step 建立统一词汇表，避免新旧命名混合
- v0.1.0 阶段无外部用户，重命名成本最低

### 重命名映射

#### `@zhixing/core`

| 当前名称 | 目标名称 | 文件变更 |
|----------|---------|---------|
| `SessionTurn` | `Turn` | `session/types.ts` → `transcript/types.ts` |
| `SessionHeader` | `TranscriptHeader` | 同上 |
| `SessionCompact` | `CompactMarker` | 同上 |
| `SessionRecord` | `TranscriptRecord` | 同上 |
| `SessionStore` | `TranscriptStore` | `session/store.ts` → `transcript/store.ts` |
| `session/` 目录 | `transcript/` 目录 | 目录移动 |

#### `@zhixing/server`

| 当前名称 | 目标名称 | 文件变更 |
|----------|---------|---------|
| `ServerSession` | `SessionRuntime` | `session/types.ts` → `runtime/types.ts` |
| `SessionFactory` | `RuntimeFactory` | 同上 |
| `SessionRegistry` | `RuntimeRegistry` | `session/registry.ts` → `runtime/registry.ts` |
| `session/` 目录 | `runtime/` 目录 | 目录移动 |

#### `@zhixing/cli`

| 当前名称 | 目标名称 | 范围 |
|----------|---------|------|
| 内部变量/类型中的 `session` 引用 | 按语义改为 `conversation` 或 `runtime` | 仅内部代码 |
| CLI 对外参数 (`-c`, `-r`) | **不改** (用户接口稳定性) | — |

### 不做

- 不改任何运行逻辑
- 不改 JSONL 格式或磁盘路径（路径迁移在 Step 2）
- 不改 CLI 对外命令名和参数名

### 验证

- [x] `pnpm test` 全量通过 (1737 tests, 0 failures — 2026-04-18)
- [ ] `pnpm cli` 启动正常，功能不退化
- [x] git diff 确认无逻辑变更（仅 rename + import 更新）

---

## Step 1: ConversationRepository

**目标：** 实现 [conversation-model.md](specifications/conversation-model.md) §3 Conversation 持久层 + §7 ConversationRepository 接口

**性质：** 纯新代码，不改任何现有文件

### 新建文件

```
packages/core/src/conversation/types.ts        — Conversation, ConversationMeta, ConversationScope
packages/core/src/conversation/repository.ts   — ConversationRepository (磁盘 CRUD)
packages/core/src/conversation/index.ts        — 公开导出
packages/core/src/__tests__/conversation-repository.test.ts
```

### 核心接口 (来自 spec §7)

```typescript
interface ConversationRepository {
  create(opts?: { name?: string; scope?: ConversationScope }): Promise<Conversation>;
  get(id: string): Promise<Conversation | null>;
  list(scope?: ConversationScope): Promise<ConversationMeta[]>;
  rename(id: string, name: string): Promise<void>;
  archive(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  getDefault(): Promise<Conversation>;  // 自动创建 default
}
```

### 磁盘结构

```
~/.zhixing/conversations/
  <conversationId>/
    meta.json           — ConversationMeta (name, scope, created, archived, hint...)
    transcript.jsonl    — Turn 记录 (Step 2 才接入)
```

### 关键行为

- `getDefault()` 首次调用自动创建 `id="default"` conversation
- scope: `user` 级存 `~/.zhixing/conversations/`，`project` 级存 `~/.zhixing/projects/<hash>/conversations/`
- `archive()` 设 `archived=true`，`list()` 默认不返回已归档

### 不做

- 不碰 TranscriptStore（Step 2 做）
- 不碰 CLI 或 Server
- 不实现 ephemeral 逻辑（Step 8 做）

### 验证

- [ ] 单元测试：create → get 一致
- [ ] 单元测试：getDefault 自动创建
- [ ] 单元测试：list 按 scope 隔离
- [ ] 单元测试：archive 后 list 不返回
- [ ] 单元测试：rename/delete 正常

---

## Step 2: TranscriptStore 适配

**目标：** 将 Step 0 重命名后的 TranscriptStore 接口改为接受 `conversationId`，磁盘路径迁移到 conversation 目录下

**性质：** 接口微调 + 路径变更，JSONL 格式和原子写入逻辑零修改

**规格引用：** [conversation-model.md](specifications/conversation-model.md) §5 Turn + §8 TranscriptStore

### 改动

```
改: packages/core/src/transcript/store.ts
  - 方法签名: appendTurn(sessionId, turn) → appendTurn(conversationId, turn)
  - 存储路径: sessions/<id>.jsonl → conversations/<id>/transcript.jsonl
  - 接受 ConversationRepository 注入 (获取 conversation 路径)
改: packages/core/src/transcript/types.ts
  - TranscriptHeader 增加 conversationId 字段
```

### 不做

- 不改 JSONL 行格式
- 不改原子写入逻辑
- 不改 CLI 调用方（Step 3 做）

### 验证

- [ ] 现有 transcript 测试全部通过（适配新接口）
- [ ] 写入路径正确落在 `conversations/<id>/transcript.jsonl`
- [ ] TranscriptHeader 包含 conversationId

---

## Step 3: CLI 对接 Conversation

**目标：** CLI 使用 ConversationRepository 管理对话身份，支持多会话

**性质：** 适配现有 CLI 代码

**规格引用：** [conversation-model.md](specifications/conversation-model.md) §9 CLI 集成, §11 用户命令

### 改动

```
改: packages/cli/src/run-agent.ts
  - 启动时 ConversationRepository.getDefault() 获取默认 conversation
  - -c 恢复上次 conversation (按 lastActiveAt 排序)
  - -r <id> 恢复指定 conversation

改: packages/cli/src/repl.ts
  - Turn 写入走 TranscriptStore(conversationId)
  - 提示符显示当前 conversation name

改: packages/cli/src/command-dispatcher.ts
  - 新增: /new [name]      — 创建新 conversation 并切换
  - 新增: /switch [id]     — 切换到指定 conversation（无参则列表选择）
  - 新增: /conversations   — 列出所有 conversations
  - 新增: /rename <name>   — 重命名当前 conversation
```

### 不做

- 不改 agent loop
- 不改 context engine
- 不改渲染层
- 不改 security pipeline

### 验证

- [ ] `pnpm cli` 启动 → 默认进入 default conversation
- [ ] `/new "测试"` → 创建并切换
- [ ] `/conversations` → 列表显示
- [ ] `/switch` → 切换回 default，历史完整
- [ ] 退出后 `-c` → 恢复上次 conversation
- [ ] 退出后 `-r` → 交互选择 conversation

---

## Step 4: ScenarioEvaluator + ContextProfile

**目标：** 实现 [context-architecture.md](specifications/context-architecture.md) §3.1 ScenarioEvaluator + §3.1.3 ContextProfile

**性质：** 纯新代码，不改现有 context 逻辑

### 新建文件

```
packages/core/src/context/scenario-evaluator.ts   — Turn 1 场景分类
packages/core/src/context/context-profile.ts      — 场景 → 参数映射
packages/core/src/__tests__/scenario-evaluator.test.ts
```

### 场景分类 (spec §3.1.1)

```
lookup       — 快速查询，最小上下文
interactive  — 常规交互，标准配置
social       — 涉及人际/关系，加载 people + relations
autonomous   — 后台任务，任务专用工具集
```

### 关键规则

- 仅 Turn 1 执行分类（基于首条用户消息的关键词/模式匹配，不调 LLM）
- Sticky：分类结果写入 `Conversation.currentHint`
- 单调升级：只能从低到高 (lookup → interactive → social → autonomous)

### ContextProfile 输出

```typescript
interface ContextProfile {
  loadProfile: boolean;        // 是否加载用户 profile
  layer2Strategy: 'skip' | 'basic' | 'enriched' | 'minimal';
  toolScope: 'query' | 'all' | 'task-specific';
  budgetThresholds: { warning: number; compact: number; critical: number };
}
```

### 不做

- 不接入 ContextEngine（Step 5 做）
- 不接入 LayerAssembler（Step 5 做）

### 验证

- [ ] 单元测试："今天天气怎么样" → lookup
- [ ] 单元测试："帮我重构这个函数" → interactive
- [ ] 单元测试："给张三发消息" → social
- [ ] 单元测试：升级规则 lookup→interactive 可以，interactive→lookup 不可以
- [ ] 单元测试：ContextProfile 各场景输出参数正确

---

## Step 5: LayerAssembler + TurnDigest

**目标：** 实现 [context-architecture.md](specifications/context-architecture.md) §3.2 LayerAssembler + §3.5 TurnDigest

**性质：** 新代码 + 重构 context/engine.ts 的 prompt 组装逻辑

**规格引用：** context-architecture.md §3.2 (四层组装) + §3.5 (Turn 摘要)

### 新建文件

```
packages/core/src/context/layer-assembler.ts   — 四层 system prompt 组装
packages/core/src/context/turn-digest.ts       — Turn 完成后自动提取摘要
packages/core/src/__tests__/layer-assembler.test.ts
packages/core/src/__tests__/turn-digest.test.ts
```

### 四层组装 (spec §3.2)

```
Layer 0 (Static)   — Agent 身份 + 工具目录（可缓存，所有场景相同）
Layer 1 (Profile)  — 用户 profile（ContextProfile.loadProfile 控制加载与否）
Layer 2 (Scene)    — 场景触发内容（skills/people/relations/journal，按 layer2Strategy）
Layer 3 (Dynamic)  — 工作区信息、时间、Turn Digest、任务提示
```

### TurnDigest (spec §3.5)

- 每个 Turn 完成后从元数据提取：用户消息前 80 字 + tool calls 列表 + 修改的文件
- 零 LLM 开销（纯字符串拼接）
- 注入 Layer 3，为被淘汰的老 Turn 保留线索

### 改动

```
改: packages/core/src/context/engine.ts
  - buildPrompt() 改为调用 LayerAssembler
  - Turn 完成后调用 TurnDigest.extract()
  - 接受 ContextProfile 参数
```

### 不做

- 不改压缩策略（TierCompressor 已存在）
- 不改 TokenEstimator

### 验证

- [ ] 单元测试：LayerAssembler 在 lookup 场景跳过 Layer 1+2
- [ ] 单元测试：LayerAssembler 在 social 场景加载 enriched Layer 2
- [ ] 单元测试：TurnDigest 从 tool_use 消息正确提取文件列表
- [ ] 集成测试：CLI 跑 3 轮对话，Layer 3 包含前几轮的 Digest

---

## Step 6: WindowManager + Pinning

**目标：** 实现 [context-architecture.md](specifications/context-architecture.md) §3.3 WindowManager + Pinning

**性质：** 新代码 + 接入 ContextEngine

**规格引用：** context-architecture.md §3.3 (Window + Pinning) + §3.4 (TierCompressor 集成)

### 新建文件

```
packages/core/src/context/window-manager.ts
packages/core/src/__tests__/window-manager.test.ts
```

### 核心逻辑

- **Pinned messages:** 首条用户消息、task ledger、plan — 标记后不被淘汰
- **Dynamic window:** 窗口大小 = f(剩余 budget)
- **TierCompressor 集成:** 按 turn distance 分级（已有实现，接入 WindowManager 的 distance 计算）
  - Tier 1 (≤2 turns): 完整保留
  - Tier 2: 截断至 2000 chars
  - Tier 3: 截断至 500 chars + 结构标记
  - Tier 4: 仅骨架
- **级联淘汰:** Tier 降级 → Turn 淘汰 → LLM 压缩 (仅 CRITICAL 触发)

### 改动

```
改: packages/core/src/context/engine.ts
  - 消息选择逻辑改为调用 WindowManager
  - 支持 pin/unpin 操作
```

### 不做

- 不改 LLM 压缩策略（已有，保持为 CRITICAL 兜底）
- 不新增压缩策略

### 验证

- [ ] 单元测试：pinned 消息在窗口缩小时不被淘汰
- [ ] 单元测试：20 turn 对话，老 turn 的 tool_result 按 distance 正确降级
- [ ] 单元测试：budget 接近 COMPACT 时窗口自动缩小
- [ ] 集成测试：长对话中首条用户消息始终存在

---

## Step 7: ConversationManager + SessionRuntime

**目标：** 实现 [conversation-model.md](specifications/conversation-model.md) §4 SessionRuntime + §8 ConversationManager，重构 Server 的运行时管理

**性质：** 重构 server 现有 RuntimeRegistry → ConversationManager

**规格引用：** conversation-model.md §4 (SessionRuntime), §8 (ConversationManager) + server-gateway.md §4 (RPC 对接)

### 新建/改动文件

```
新建: packages/server/src/runtime/session-runtime.ts   — 完整 SessionRuntime 实现
改:   packages/server/src/runtime/registry.ts → conversation-manager.ts
改:   packages/server/src/rpc/methods/session.ts       — 对接 ConversationManager
改:   packages/server/src/server.ts                    — 初始化 ConversationManager
```

### SessionRuntime (spec §4)

```typescript
interface SessionRuntime {
  conversationId: string;
  messages: Message[];
  busy: boolean;
  abortController: AbortController;
  observers: Set<Connection>;       // 当前连接的客户端
  pendingQueue: PendingMessage[];   // 最多 5 条

  run(text: string): AsyncGenerator<AgentYield, AgentResult>;
  abort(): void;
  addObserver(conn: Connection): void;
  removeObserver(conn: Connection): void;
}
```

### ConversationManager (spec §8)

```typescript
interface ConversationManager {
  acquire(conversationId: string): Promise<SessionRuntime>;
  release(conversationId: string): void;
  // 释放规则: observer=0 持续 60s OR idle ≥30min
}
```

### RPC 对接

- `session.send` → `manager.acquire(convId)` → `runtime.run(text)` → 结果持久化到 TranscriptStore
- `session.list` → `ConversationRepository.list()` + runtime 状态合并
- `session.history` → `TranscriptStore.load(convId)`

### 不做

- 不实现 Channel Adapter（后续路线图）
- 不实现 Delivery Pipeline（后续路线图）

### 验证

- [ ] `zhixing serve` 启动正常
- [ ] `zhixing rpc session.send "你好"` — 收到回复
- [ ] `zhixing rpc session.list` — 显示 conversation 列表含 runtime 状态
- [ ] transcript.jsonl 文件正确写入
- [ ] 两个 rpc client 连接同一 conversation → observers=2
- [ ] 所有 client 断开 60s → SessionRuntime 自动释放（日志可见）

---

## Step 8: Ephemeral Conversation + auto-promote

**目标：** 实现 [conversation-model.md](specifications/conversation-model.md) §6 临时对话

**性质：** 在 Step 7 基础上新增逻辑

**规格引用：** conversation-model.md §6 (Ephemeral)

### 改动

```
改: packages/core/src/conversation/repository.ts   — 支持 ephemeral 标记
改: packages/server/src/runtime/session-runtime.ts  — auto-promote 检测
改: packages/cli/src/run-agent.ts                   — -p 模式创建 ephemeral
```

### Ephemeral 规则 (spec §6)

| 场景 | 是否 ephemeral |
|------|---------------|
| Server 单次查询 | 是 |
| CLI `-p` 模式 | 是 |
| CLI REPL | 否（用户主动启动进程） |

### auto-promote 触发条件

- 第 2 个 Turn 发生
- 使用了有副作用的工具 (write/edit/bash)
- ScenarioEvaluator 升级 hint
- 用户执行 `/keep` 命令

### 不做

- 不实现跨设备同步（S3 阶段）

### 验证

- [ ] `zhixing -p "1+1"` — 执行后无磁盘文件
- [ ] `zhixing -p "创建文件 test.txt"` — 触发副作用工具 → auto-promote → 磁盘可见
- [ ] REPL 模式 — 始终持久化，不受 ephemeral 影响
- [ ] Server 单次查询 — ephemeral，不写盘

---

## 后续路线（本轮不实施，记录方向）

完成 Step 0-8 后，下一阶段的候选项：

| 方向 | 规格来源 | 前置条件 |
|------|---------|---------|
| Channel Adapters (钉钉/飞书) | [server-gateway.md](specifications/server-gateway.md) §5 | Step 7 |
| Delivery Pipeline | [persistent-service.md](specifications/persistent-service.md) §4 | Step 7 |
| AgentOrchestrator | [persistent-service.md](specifications/persistent-service.md) §2 | Step 7 |
| BackgroundAgent + Monitor | [persistent-service.md](specifications/persistent-service.md) §2.2-2.3 | AgentOrchestrator |
| OpenAI 兼容端点 | [server-gateway.md](specifications/server-gateway.md) §8 | Step 7 |
| Web UI | 待设计 | Step 7 |

---

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-04-18 | 初始版本：Step 0-8 计划制定 |
