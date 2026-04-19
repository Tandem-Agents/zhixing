# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。每完成一步更新状态，全部完成后可归档或删除。

## 状态总览

| Step | 名称 | 状态 | 依赖 |
|------|------|------|------|
| 0 | 词汇对齐 | ✅ 已完成 | 无 |
| 1 | ConversationRepository | ✅ 已完成 | Step 0 |
| 2 | TranscriptStore 适配 | ✅ 已完成 | Step 0, 1 |
| 3 | CLI 对接 Conversation | ✅ 已完成 | Step 2 |
| 3b | Transcript 段轮转 | 🔲 待开始 | Step 3 |
| 4 | ScenarioEvaluator + ContextProfile | ✅ 已完成 | Step 0 |
| 5 | LayerAssembler + TurnDigest | ✅ 已完成 | Step 4 |
| 6 | WindowManager + Pinning | ✅ 已完成 | Step 5 |
| 7 | ConversationManager + SessionRuntime | ✅ 已完成 | Step 3, 6 |
| 7a | PendingQueue 并发互斥 | ✅ 已完成 | Step 7 |
| 7b | TranscriptStore 集成 + AbortSignal | ✅ 已完成 | Step 7a |
| 8 | Ephemeral Conversation + auto-promote | 🔲 待开始 | Step 7b |

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
Step 3b (Transcript 段轮转)     │      │                    │
    ↓                           │      ↓                    │
    └───────────────────────────┴──────┘
                    ↓
            Step 7 (ConversationManager + SessionRuntime)
                    ↓
            Step 7a (PendingQueue 并发互斥)
                    ↓
            Step 7b (TranscriptStore 集成 + AbortSignal)
                    ↓
            Step 8 (Ephemeral + auto-promote + /delete)
```

> **Step 3b 并行说明：** 段轮转与 Step 4（ScenarioEvaluator）完全独立，可并行推进。Step 5（LayerAssembler）改造 load() 消费方式时受益于段轮转已完成，但不硬性依赖。

## 设计规格引用

本路线图的实现目标来源于以下设计规格：

| 规格 | 文档 | 覆盖 Steps |
|------|------|-----------|
| 对话模型 | [conversation-model.md](specifications/conversation-model.md) | 0, 1, 2, 3, 7, 7a, 7b, 8 |
| 上下文架构 | [context-architecture.md](specifications/context-architecture.md) | 4, 5, 6 |
| 智能体运行时 | [persistent-service.md](specifications/persistent-service.md) | 7, 7b, 8 |
| Server Gateway | [server-gateway.md](specifications/server-gateway.md) | 7, 7a |

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

- [x] 单元测试：create → get 一致 (2026-04-18)
- [x] 单元测试：getDefault 自动创建 (2026-04-18)
- [x] 单元测试：list 按 scope 隔离 (2026-04-18)
- [x] 单元测试：archive 后 list 不返回 (2026-04-18)
- [x] 单元测试：rename/delete 正常 (2026-04-18)

---

## Step 2: TranscriptStore 适配

**目标：** 将 Step 0 重命名后的 TranscriptStore 接口改为接受 `conversationId`，磁盘路径迁移到 conversation 目录下

**性质：** 接口微调 + 路径变更，JSONL 格式和原子写入逻辑零修改

**规格引用：** [conversation-model.md](specifications/conversation-model.md) §5 Turn + §9 Transcript 持久化

### 改动

```
改: packages/core/src/transcript/types.ts
  - TranscriptHeader: sessionId → conversationId (唯一 ID 字段，无双字段)
  - TranscriptInfo: sessionId → conversationId
  - CreateTranscriptOptions: sessionId → conversationId
  - ITranscriptStore: 所有参数名 sessionId → conversationId

改: packages/core/src/transcript/store.ts
  - 构造函数: TranscriptStore(cwd) → TranscriptStore(conversationsDir, projectPath)
  - 存储路径: sessions/<id>.jsonl → conversations/<id>/transcript.jsonl
  - conversationsDir 由调用方根据 scope 注入，Store 不感知 scope 逻辑

改: packages/core/src/transcript/serializer.ts
  - isTranscriptHeader 类型守卫：旧 JSONL 的 sessionId 在读取时迁移为 conversationId
  - 迁移发生在序列化边界，不污染类型系统
```

### 设计决策

- **无双字段：** `sessionId` 从类型系统中彻底移除，不保留 optional 兼容字段
- **无双路径：** 只有一种路径策略 `<conversationsDir>/<id>/transcript.jsonl`
- **旧格式兼容在序列化边界：** `isTranscriptHeader()` 类型守卫检测 `sessionId` 并自动映射为 `conversationId`，对上层完全透明

### 不做

- 不改 JSONL 行格式
- 不改原子写入逻辑
- 不改 CLI 调用方（Step 3 做）
- 不改 TranscriptStore 的方法集合（Step 3 做职责瘦身）

### 验证

- [x] 现有 transcript 测试全部通过（适配新接口） (2026-04-18)
- [x] 写入路径正确落在 `conversations/<id>/transcript.jsonl` (2026-04-18)
- [x] TranscriptHeader 只有 `conversationId`，无 `sessionId` 字段 (2026-04-18)
- [x] 旧格式 `sessionId` JSONL 解析后自动迁移为 `conversationId` (2026-04-18)

---

## Step 3: CLI 对接 Conversation

**目标：** 建立 ConversationRepository（身份）与 TranscriptStore（内容）的清晰职责边界，CLI 通过协调两者完成对话生命周期管理

**性质：** Core 层职责瘦身 + CLI 层接线 + 新斜杠命令

**规格引用：** [conversation-model.md](specifications/conversation-model.md) §7 CLI 模式生命周期, §9 Transcript 持久化

### 设计原则

**核心判断：TranscriptStore 是日志系统，不是 CRUD 系统。**

- 所有"对话是什么"的问题 → ConversationRepository（身份、命名、列表、生命周期）
- 所有"对话说了什么"的问题 → TranscriptStore（写入、读取、计数）
- CLI 是当前的协调者，Step 7 的 SessionRuntime 会接管这个角色

**职责切割：**

```
ConversationRepository              TranscriptStore
(身份 — meta.json)                  (内容 — transcript.jsonl, append-only)
──────────────────                  ──────────────────────────────────────
create()                            init(conversationId, opts)
get() / list()                      appendTurn(conversationId, turn)
rename()                            appendCompact(conversationId, compact)
archive() / delete()                load(conversationId) → LoadedTranscript
touch()                             countTurns(conversationId)
findLatest()                        exists(conversationId)
ensureDefault()
```

**CLI 协调流：**

```
创建:   convRepo.create()  → store.init(conversation.id, {model, provider})
列表:   convRepo.list()    → 可选 store.countTurns() 补充
恢复:   convRepo.findLatest() 或 convRepo.get() → store.load(id)
重命名: convRepo.rename()  （不碰 transcript — name 只在 meta.json）
Turn:   store.appendTurn() + convRepo.touch()
删除:   convRepo.delete()  （trash 整个目录，包含 transcript.jsonl）
```

### Phase A: Core 层职责瘦身

```
新建: packages/core/src/paths.ts
  - 提取 getZhixingHome() 和 getProjectId() 为共享基础设施
  - 消除 transcript/store.ts 和 conversation/repository.ts 的重复定义

改: packages/core/src/transcript/types.ts
  - ITranscriptStore: 移除 list(), rename(), delete()
  - ITranscriptStore: create() → init(), 增加 countTurns(), exists()
  - 删除 TranscriptInfo 类型（被 Conversation 取代）
  - CreateTranscriptOptions: 移除 name 字段（name 只存 meta.json）

改: packages/core/src/transcript/store.ts
  - TranscriptStore: 移除 list(), rename(), delete(), findLatest()
  - create() → init(): 语义明确——初始化日志文件，不是创建对话
  - 新增 countTurns() (委托 serializer), exists()
  - 导入 getZhixingHome / getProjectId 从 paths.ts

改: packages/core/src/conversation/types.ts
  - IConversationRepository: 增加 findLatest(), touch()

改: packages/core/src/conversation/repository.ts
  - 新增 findLatest(): list()[0].id
  - 导入 getZhixingHome 从 paths.ts（移除私有重复定义）

改: packages/core/src/transcript/index.ts
  - 移除 TranscriptInfo 导出
  - init 替代 create

改: packages/core/src/index.ts
  - 新增 paths.ts 导出
```

### Phase B: CLI 接线 ✅

```
改: packages/cli/src/repl.ts
  - 局部变量 transcriptId → conversationId
  - 初始化: 构造 ConversationRepository(scope) + TranscriptStore(convDir, cwd)
  - 新建对话: convRepo.create() → store.init(conversation.id)
  - 恢复对话: convRepo.findLatest() / convRepo.get() → store.load()
  - /sessions 内部实现: 调 convRepo.list() 而非 store.list()
  - /name: 调 convRepo.rename() 而非 store.rename()
  - Turn 完成后: store.appendTurn() + convRepo.touch()
  - interactiveSessionPicker → interactiveConversationPicker, 入参改为 convRepo
```

### Phase C: REPL 内对话管理 + 启动行为

**设计决策（ADR-CM-016）：** 对话选择不通过 CLI 启动参数，而是通过 REPL 内命令完成。

- REPL 默认自动恢复最近对话（`convRepo.findLatest()`），无历史则创建 default
- 自动化场景走 Server RPC，不走 CLI 启动参数
- `-c`/`-r` 遗留代码在 Step 8 清除

```
改: packages/cli/src/repl.ts
  - REPL 启动行为: 自动恢复最近对话，不再创建新 conversation
  - /switch 成为对话列表+切换的统一入口:
    - typeahead async-enum 参数补全: 用户选完 /switch 后 dropdown 自动展示对话列表
    - /switch <text>: 按 ID 精确匹配 + 按名称模糊匹配（legacy 模式兜底）
    - /switch（无参、legacy 模式）: 显示编号列表 + 提示语
  - /conversations → hidden 别名（保留向后兼容，不出现在 typeahead 菜单）
  - /new [name]: convRepo.create() + store.init() + 切换到新对话
  - 实现 ConversationArgProvider (ArgChoiceProvider): 查询 convRepo.list() 生成候选
  - REPL_COMMANDS 注册 /switch 时声明 args: [{ kind: "async-enum", required: true }]
```

---

## Step 3b: Transcript 段轮转

**目标：** 实现 [conversation-model.md](specifications/conversation-model.md) §9.5 段轮转，解决主对话场景下 transcript.jsonl 无限膨胀导致的 load 性能退化

**性质：** 纯内部优化，`ITranscriptStore` 接口不变，调用方无感知

**规格引用：** conversation-model.md §9.5 (段轮转) + ADR-CM-017

### 改动文件

```
改: packages/core/src/transcript/store.ts
  - appendCompact() 内部新增轮转逻辑:
    1. 读当前 header，计算 archivedTurnCount
    2. 写 transcript.jsonl.new（新 header + compact）
    3. rename 旧文件 → archive/segment-{epoch}.jsonl
    4. rename .new → transcript.jsonl
  - load() 开头加崩溃恢复检查（检测 .new 文件）
  - countTurns() 使用 header.archivedTurnCount + 活跃段 turn 数

改: packages/core/src/transcript/serializer.ts
  - readHeader() 支持解析 archivedTurnCount 字段（可选，undefined 视为 0）
  - countTurns() 优化：先读 header 取 archivedTurnCount，再计活跃段 turn 行数

改: packages/core/src/transcript/types.ts
  - TranscriptHeader 新增 archivedTurnCount?: number

改: packages/core/src/transcript/__tests__/store.test.ts
  - 新增段轮转测试用例
```

### 关键设计点

- **触发条件：** 每次 `appendCompact()` 自动触发，无阈值判断（compact 本身已经是低频事件）
- **接口不变：** `ITranscriptStore` 接口零改动，轮转是纯内部行为
- **向后兼容：** `archivedTurnCount` 为可选字段，旧文件 undefined 视为 0
- **归档段不可变：** 写入后不再修改，天然安全
- **崩溃安全：** temp file → rename 序列 + load 时恢复检查

### 不做

- 不新增 `loadFullHistory()` 方法（未来导出/搜索功能按需添加）
- 不做归档段清理策略（保留全部历史）
- 不做归档段 gzip 压缩
- 不改 `ITranscriptStore` 接口

### 验证

- [ ] 单元测试：appendCompact 后 archive/ 目录出现归档段文件
- [ ] 单元测试：轮转后 load() 返回的消息与轮转前一致（compact summary + 后续 turns）
- [ ] 单元测试：countTurns() 返回总轮数（archivedTurnCount + 活跃段）
- [ ] 单元测试：多次 compact 后多个归档段，load() 仍然正确
- [ ] 单元测试：崩溃恢复——手动创建 .new 文件 + 删除活跃段 → load() 自动恢复
- [ ] 单元测试：旧格式文件（无 archivedTurnCount）正常读取，countTurns 正确
- [ ] 集成测试：CLI 长对话触发 compact → 观察 archive/ 目录产生 + 下次启动恢复正常

---

### 不做

- 不改 agent loop
- 不改 context engine
- 不改渲染层
- 不改 security pipeline
- 不碰 RPC/typeahead/serve 中的 `sessionId`（那是不同语义的 session 概念）
- 不删 `-c`/`-r` 代码（Step 8 统一清除）

### 验证

**Phase A (Core):**

- [x] `pnpm --filter @zhixing/core test` 全量通过 (2026-04-18)
- [x] TranscriptStore 接口只有: init, appendTurn, appendCompact, load, countTurns, exists (2026-04-18)
- [x] ConversationRepository 接口包含: findLatest, touch (2026-04-18)
- [x] `getZhixingHome()` 和 `getProjectId()` 只在 paths.ts 定义一处 (2026-04-18)
- [x] 无 `TranscriptInfo` 类型残留 (2026-04-18)

**Phase B (CLI 接线):**

- [x] `pnpm --filter @zhixing/cli build` 零错误 (2026-04-18)
- [x] `/name 新名称` → meta.json 更新，transcript.jsonl 不变 (2026-04-18)
- [x] 多轮对话后 meta.json 的 lastActiveAt 持续更新 (2026-04-18)

**Phase C (REPL 对话管理):**

- [x] `pnpm cli` 启动 → 自动恢复最近对话（无历史则创建 default） (2026-04-18)
- [x] `/switch` 在 typeahead 中选中后 → dropdown 自动切换为对话列表（ArgumentProvider async-enum） (2026-04-18)
- [x] `/switch 测试` → 按名称模糊匹配并切换（legacy 模式和手动输入兜底） (2026-04-18)
- [x] `/new "测试"` → 创建并切换到新 conversation (2026-04-18)
- [x] `/conversations` 作为 hidden 别名仍可用，不出现在 typeahead 菜单 (2026-04-18)

---

## Step 4: ScenarioEvaluator + ContextProfile

**目标：** 实现 [context-architecture.md](specifications/context-architecture.md) §3.1 ScenarioEvaluator + §3.1.3 ContextProfile

**性质：** 纯新代码，不改现有 context 逻辑

### 新建/改动文件

```
新建: packages/core/src/context/context-profile.ts      — ScenarioHint + ToolCategory + ContextProfile + 3 内建 Profile + hintToProfile
新建: packages/core/src/context/scenario-evaluator.ts    — 关键词分类器 + resolveInitialHint + resolveCurrentHint + evaluateScenario
新建: packages/core/src/context/__tests__/scenario-evaluator.test.ts  — 40 个测试用例
改:   packages/core/src/conversation/types.ts            — Conversation 新增 currentHint?: ScenarioHint
改:   packages/core/src/context/index.ts                 — 导出新模块
```

### 实现要点

- **ContextProfile 完全参数化**：name / includeProfile / layer2Mode / toolCategories / budgetThresholds / tierThresholds / onExhausted
- **三个内建 Profile**：INTERACTIVE（social 复用，layer2Mode=enriched）/ AUTONOMOUS / LOOKUP
- **关键词分类器**：中英文双语 pattern 匹配，social 优先于 lookup，长消息/代码任务自动排除 lookup
- **hint 生命周期**：Turn 1 初始分类 → Sticky → 单调升级（lookup < interactive < social）
- **autonomous 运行时不可变**：由业务代码硬编码，resolveCurrentHint 直接 early return
- **evaluateScenario** 便捷入口：根据 turnCount 自动选择初始分类或当前解析

### 不做

- 不接入 ContextEngine（Step 5 做）
- 不接入 LayerAssembler（Step 5 做）

### 验证

- [x] 单元测试："今天天气怎么样" → lookup (2026-04-18)
- [x] 单元测试："帮我重构这个函数" → interactive (2026-04-18)
- [x] 单元测试："给张三发消息" → social (2026-04-18)
- [x] 单元测试：升级规则 lookup→interactive 可以，interactive→lookup 不可以 (2026-04-18)
- [x] 单元测试：ContextProfile 各场景输出参数正确 (2026-04-18)
- [x] 单元测试：autonomous 运行时不可变 (2026-04-18)
- [x] 全量 1198 测试通过，core + CLI 构建零错误 (2026-04-18)

---

## Step 5: LayerAssembler + TurnDigest

**目标：** 实现 [context-architecture.md](specifications/context-architecture.md) §3.2 LayerAssembler + §3.5 TurnDigest

**性质：** 新代码 + 重构 context/engine.ts 的 prompt 组装逻辑

**规格引用：** context-architecture.md §3.2 (四层组装) + §3.5 (Turn 摘要)

### 新建/改动文件

```
新建: packages/core/src/context/turn-digest.ts                      — TurnDigest 类型 + 机械提取 + 轨迹格式化
新建: packages/core/src/context/layer-assembler.ts                   — 四层 system prompt 组装 + 工具目录过滤
新建: packages/core/src/context/__tests__/turn-digest.test.ts        — 24 个测试
新建: packages/core/src/context/__tests__/layer-assembler.test.ts    — 26 个测试
改:   packages/core/src/context/engine.ts                            — ContextProfile 感知 + TurnDigest 存储 + buildSystemPrompt
改:   packages/core/src/context/index.ts                             — 导出新模块
```

### 实现要点

**TurnDigest（零 LLM 成本轨迹）：**
- `extractTurnDigest(turn: Turn)` — 从持久化 Turn 机械提取：消息前 80 字 + 工具调用 + 修改文件 + 成功/错误
- `formatDigestTrail(digests)` — 格式化为 `[轨迹]\nT1: "..." → tool×N` 面包屑文本
- 超过 MAX_DIGEST_COUNT(30) 时自动合并最早的批次为分组摘要

**LayerAssembler（四层纯函数组装）：**
- Layer 0: identity + 按 Profile.toolCategories 白名单过滤的工具目录
- Layer 1: `includeProfile=true` 时注入用户画像，否则跳过
- Layer 2: `layer2Mode=skip` 时跳过，否则包含调用方预取的场景内容
- Layer 3: 工作区 + 时间 + TurnDigest 轨迹 + 活跃任务提示
- `ToolDeclaration` 接口：每个工具声明 categories，由 assembler 过滤

**Engine 扩展（向后兼容）：**
- `ContextEngineConfig.profile?` — 可选，默认 INTERACTIVE_PROFILE
- Profile.budgetThresholds 作为 thresholds 的 fallback
- `addTurnDigest(digest)` / `getTurnDigests()` — 存储轨迹
- `buildSystemPrompt(opts)` — 委托 LayerAssembler，自动注入 Profile + 已存储的 digests

### 不做

- 不改压缩策略（TierCompressor 升级在 Step 6）
- 不改 TokenEstimator
- 不实现 MemoryRetriever（Layer 2 数据由调用方预取传入，检索器待 memory 系统完成后接入）

### 验证

- [x] 单元测试：LayerAssembler 在 lookup 场景跳过 Layer 1+2 (2026-04-18)
- [x] 单元测试：LayerAssembler 在 social 场景加载 enriched Layer 2 (2026-04-18)
- [x] 单元测试：TurnDigest 从 ToolCallRecord 正确提取文件列表 (2026-04-18)
- [x] 单元测试：TurnDigest 格式化支持分组合并（超 30 条自动 merge） (2026-04-18)
- [x] 单元测试：Engine.buildSystemPrompt 委托 LayerAssembler + 注入 digest (2026-04-18)
- [x] 全量 1257 测试通过，core + CLI 构建零错误 (2026-04-18)

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

- [x] 单元测试：pinned 消息在窗口缩小时不被淘汰 (2026-04-18)
- [x] 单元测试：20 turn 对话，老 turn 的 tool_result 按 distance 正确降级 (2026-04-18)
- [x] 单元测试：budget 接近 COMPACT 时窗口自动缩小 (2026-04-18)
- [x] 集成测试：长对话中首条用户消息始终存在 (2026-04-18)
- [x] 单元测试：TierCompressor 四级压缩 + 幂等性 + 骨架含 tool 名称 (2026-04-18)
- [x] 单元测试：自定义 isPinned 策略保护指定消息 (2026-04-18)
- [x] 单元测试：MIN_RETAIN_TURNS 保留最近 2 轮 (2026-04-18)
- [x] Engine 后向兼容：仅显式提供 profile.tierThresholds 时运行 WindowManager (2026-04-18)
- [x] 全量 1284 测试通过，core + CLI 构建零错误 (2026-04-18)

### 实现细节

**新建文件：**
- `packages/core/src/context/tier-compressor.ts` — 四级 tool_result 渐进压缩（Profile 参数化 T1/T2/T3 阈值）
- `packages/core/src/context/window-manager.ts` — Pin-aware turn 淘汰 + 级联编排
- `packages/core/src/context/__tests__/tier-compressor.test.ts` — 14 测试
- `packages/core/src/context/__tests__/window-manager.test.ts` — 13 测试

**改动文件：**
- `packages/core/src/context/engine.ts` — onTurnComplete 集成 manageWindow（Tier 压缩 + 淘汰在策略管线之前）
- `packages/core/src/context/index.ts` — 导出 TierCompressor + WindowManager 公开 API

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

- [x] `zhixing serve` 启动正常 — 编译通过，server 构建成功 (2026-04-18)
- [x] `zhixing rpc session.send "你好"` — session-rpc 集成测试覆盖 send + delta/complete 推送 (2026-04-18)
- [x] `zhixing rpc session.list` — list 返回 ManagedSessionInfo 含 observerCount (2026-04-18)
- [ ] transcript.jsonl 文件正确写入 — 需 TranscriptStore 集成到 runManagedTurn（见下方"待完成"）
- [x] 两个 observer 连接同一 conversation → observerCount=2 — 单元测试覆盖 (2026-04-18)
- [x] 所有 observer 断开 60s → SessionRuntime 自动释放 — grace period 单元测试覆盖 (2026-04-18)
- [x] 空闲 30 分钟自动释放 — idle timeout 单元测试覆盖 (2026-04-18)
- [x] setBusy(true) 阻止 grace timer 启动 — 交互测试覆盖 (2026-04-18)
- [x] onRelease 回调正确触发（grace/idle 两种原因）(2026-04-18)
- [x] WebSocket 断开时自动清理 observer — server.ts ws.on("close") 调用 removeObserverFromAll (2026-04-18)
- [x] server.close() 自动调用 conversations.disposeAll() — 资源回收 (2026-04-18)
- [x] ServerContext 单一字段：`conversations?: ConversationManager`，无双字段歧义 (2026-04-18)
- [x] RPC 方法直接使用 ConversationManager 类型，无 duck-typing 绕过 (2026-04-18)
- [x] CLI serve 命令已迁移至 ConversationManager (2026-04-18)
- [x] 全量 1431 测试通过（core 1284 + server 147），三个包构建零错误 (2026-04-18)

### 实现细节

**新建文件：**
- `packages/server/src/runtime/conversation-manager.ts` — ConversationManager 类：observer 跟踪、60s grace period、30min idle timeout、onRelease 回调
- `packages/server/src/runtime/__tests__/conversation-manager.test.ts` — 32 测试

**改动文件：**
- `packages/server/src/runtime/types.ts` — re-export ManagedSessionInfo
- `packages/server/src/runtime/index.ts` — export conversation-manager
- `packages/server/src/context.ts` — ServerContext 统一使用 `conversations?: ConversationManager`
- `packages/server/src/server.ts` — ws.on("close") 调用 removeObserverFromAll；close() 调用 disposeAll()
- `packages/server/src/rpc/methods/session.ts` — 直接使用 ConversationManager，移除 RuntimeRegistry 兼容路径
- `packages/server/src/rpc/methods/auth.ts` — capabilities 检测使用 conversations 字段
- `packages/cli/src/serve/command.ts` — RuntimeRegistry → ConversationManager

**待完成（属于 Step 7 范围，需 RuntimeFactory 接口扩展）：**
- TranscriptStore 集成：acquire() 从 transcript.jsonl 加载消息，runManagedTurn 完成后持久化 Turn
- session.list 合并 ConversationRepository.list() 数据
- session.history 从 TranscriptStore 加载（对非活跃 conversation）
- 上述依赖：RuntimeFactory.create() 需接受可选 initialMessages 参数

---

## Step 7a: PendingQueue 并发互斥

**目标：** 实现 [conversation-model.md](specifications/conversation-model.md) §4.5 PendingQueue，保证同一 conversation 的 turn 串行执行

**性质：** ConversationManager 补丁，修复并发安全缺陷

**为什么必须在 TranscriptStore 集成之前：**
- 当前并发 `session.send` 到同一 conversation 会同时调用 `runtime.run()`，消息历史交错污染
- 这在纯内存模式下是"重启即清除"的临时问题
- 一旦接入 TranscriptStore 持久化，交错的脏数据会写进 transcript.jsonl，**永久损坏对话记录**
- `setBusy` 的互斥语义依赖单一 turn 执行——并发直接破坏这个不变量

**规格引用：** conversation-model.md §4.5 (MAX_PENDING=5)

### 改动文件

```
改: packages/server/src/runtime/conversation-manager.ts
  - ManagedSession 新增 pendingQueue: PendingMessage[]
  - MAX_PENDING = 5：队列满时拒绝新请求（RPC 返回 BUSY 错误）
  - setBusy(false) 时自动 dequeue 下一条消息执行

改: packages/server/src/rpc/methods/session.ts
  - session.send: busy 时入队而非直接执行
  - 新增 BUSY 错误码处理（队列满）

改: packages/server/src/runtime/__tests__/conversation-manager.test.ts
  - 新增并发互斥测试
```

### 核心逻辑

```typescript
// ManagedSession 扩展
interface PendingMessage {
  text: string;
  connection: RpcConnection;
  resolve: (result: SessionSendResult) => void;
  reject: (error: Error) => void;
}

// 执行流程
session.send(text):
  if (!busy) → 直接执行 runManagedTurn
  else if (pendingQueue.length < MAX_PENDING) → 入队，返回 conversationId
  else → 拒绝（429 BUSY）

setBusy(false):
  if (pendingQueue.length > 0) → dequeue → runManagedTurn
  else → 启动 grace timer（已有逻辑）
```

### 不做

- 不实现优先级队列（所有请求 FIFO）
- 不实现队列持久化（内存队列，重启清空）
- 不改 RuntimeFactory 接口

### 实现细节

**ConversationManager 扩展：**
- `PendingTask { execute, cancel }` 泛型接口——ConversationManager 不感知 RPC 层
- `enqueue()` 返回三态 `"immediate" | "queued" | "full"`，调用方按返回值分支处理
- `setBusy(false)` 自动 dequeue → setBusy(true) → execute()，保证串行不变量
- `delete()` / `disposeAll()` 调用 `cancel()` 清理所有 pending
- `maxPending` 通过 config 注入，默认 5（spec §4.5）
- `ManagedSessionInfo` 新增 `pendingCount` 字段

**session.ts 改动：**
- `session.send` 通过 `enqueue()` 决定是直接执行还是入队
- 队列满时抛 `RPC_ERROR_CODES.BUSY (-32003)`
- `cancel()` 回调向连接推送 `session.complete` + error reason

**新增错误码：**
- `RPC_ERROR_CODES.BUSY = -32003`
- `RpcErrors.busy()` 便捷构造函数

### 验证

- [x] 单元测试：不忙时 enqueue 返回 "immediate"（2026-04-19）
- [x] 单元测试：忙时 enqueue 返回 "queued"（2026-04-19）
- [x] 单元测试：队列满返回 "full"（2026-04-19）
- [x] 单元测试：setBusy(false) 自动 dequeue 下一个任务（2026-04-19）
- [x] 单元测试：队列有任务时不启动 grace timer（2026-04-19）
- [x] 单元测试：队列排空后正常启动 grace timer（2026-04-19）
- [x] 单元测试：delete 时 cancel 所有 pending（2026-04-19）
- [x] 单元测试：disposeAll 时 cancel 所有 pending（2026-04-19）
- [x] 单元测试：list() 包含 pendingCount（2026-04-19）
- [x] 单元测试：未知 conversation 返回 "full"（2026-04-19）
- [x] 单元测试：abort 后 setBusy(false) 触发 dequeue（2026-04-19）
- [x] 集成测试：并发 send 到同一 conversation 串行执行，收到正确数量的 complete（2026-04-19）
- [x] 集成测试：队列满时返回 BUSY 错误码（2026-04-19）
- [x] 全量 160 测试通过（core 1284 + server 160），三个包构建零错误（2026-04-19）

---

## Step 7b: TranscriptStore 集成 + AbortSignal

**目标：** 完成 Step 7 的持久化闭环 + 连接断开时停止 LLM 消耗

**性质：** Server ↔ Core 持久层接线 + 资源回收

**为什么合并 AbortSignal：**
- TranscriptStore 集成后，废弃的 LLM turn 不仅浪费 token，还会被持久化为脏数据
- AbortSignal 是 TranscriptStore 写入的前置保护——中止的 turn 不应写入 transcript
- 两者改动集中在 `runManagedTurn` 同一函数，合并实现避免重复改动

**规格引用：** conversation-model.md §9 (Transcript 持久化) + §4 (SessionRuntime abort)

### 改动文件

```
改: packages/server/src/runtime/types.ts
  - RuntimeFactory.create() 新增可选参数 initialMessages?: Message[]
  - SessionRuntime.run() 新增可选参数 signal?: AbortSignal

改: packages/server/src/rpc/methods/session.ts
  - runManagedTurn: 创建 AbortController，传 signal 给 runtime.run()
  - runManagedTurn: turn 完成后调用 TranscriptStore.appendTurn()
  - runManagedTurn: connection.closed 时调用 abort()
  - 中止的 turn 不持久化

改: packages/server/src/runtime/conversation-manager.ts
  - getOrCreate(): 从 TranscriptStore.load() 恢复历史消息，传给 factory.create(id, messages)
  - 注入 TranscriptStore 依赖（构造函数或方法参数）

改: packages/server/src/rpc/methods/session.ts
  - session.list: 合并 ConversationRepository.list() 数据（活跃 + 非活跃）
  - session.history: 非活跃 conversation 从 TranscriptStore.load() 读取

改: packages/cli/src/serve/command.ts
  - 构造 ConversationManager 时注入 TranscriptStore 实例

新建: packages/server/src/runtime/__tests__/transcript-integration.test.ts
```

### 不做

- 不改 TranscriptStore 接口（Step 3 已定型）
- 不改 ConversationRepository 接口
- 不实现 Turn 压缩/清理（TranscriptStore 已有 appendCompact，由 ContextEngine 触发）

### 验证

- [x] 集成测试：completed turn 通过 mock TranscriptStore 正确持久化
- [x] 集成测试：error turn 不持久化到 TranscriptStore
- [x] 集成测试：loadHistory 恢复历史消息，新 turn 追加在已有历史之后
- [x] RuntimeFactory.create(id, initialMessages) 正确传播初始消息
- [x] CLI serve command 构造 TranscriptStore 并注入 loadHistory + transcript
- [x] AbortController 绑定 connection.onClose()，中止的 turn 跳过 error 通知
- [ ] 集成测试：session.list 合并非活跃 conversation（延迟至 Step 8）
- [ ] 集成测试：session.history 非活跃 conversation 回退 TranscriptStore（延迟至 Step 8）

---

## 已知技术债务

> 以下债务已评估复合风险，按影响程度排序。每项标注了计划处理时机。

### P1-已修复（Step 7 清理轮）

| 问题 | 修复 | 日期 |
|------|------|------|
| Idle reaper 遍历 Map 时删除（脆弱模式） | collect-then-delete | 2026-04-19 |
| 断开连接的 observer 残留（grace 永不触发） | runManagedTurn finally 检测 connection.closed | 2026-04-19 |
| RuntimeRegistry 死代码仍导出 | 从 index.ts 移除 re-export | 2026-04-19 |

### P1-已修复（Step 7b 修复轮）

| 问题 | 修复 | 日期 |
|------|------|------|
| Transcript 未 init — 新对话 appendTurn 必失败 | ConversationManager 新增 initTranscript 回调，doCreate 中 loadHistory 返回 undefined 时调用 | 2026-04-19 |
| AbortSignal 未传播到 adapter — 断开后 LLM 继续消耗 | session-adapter run() 接受 signal，abort 时停止 yield、回退 user message、守卫 .then() | 2026-04-19 |
| turnIndex 用 history.length/2 估算 — 多消息 turn 下不准确 | ManagedSession 新增 turnCount，从 loadHistory 初始化，appendTurn 成功后递增 | 2026-04-19 |

### P1-计划中

| # | 问题 | 复合风险 | 计划时机 |
|---|------|---------|---------|
| 1 | ~~PendingQueue 并发互斥~~ | ~~高~~ | ✅ Step 7a 已完成（2026-04-19） |
| 2 | ~~AbortSignal 未传播到 runtime.run()~~ | ~~中~~ | ✅ Step 7b 已完成（2026-04-19） |
| 3 | TurnSource 参数缺失（scheduler/channel/interactive 区分） | **低** — Channel Adapter 前才需要，Turn 类型扩展兼容 | Channel Adapter 阶段 |

### P2-计划中

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | session.abort RPC 不中断当前 turn — 只设置布尔标志影响下次 run()，当前 LLM 调用继续执行 | **中** — 用户调用 abort 后仍在消耗 token，直到 turn 自然结束。连接断开路径已通过 AbortSignal 修复，但 API 级主动取消未生效 | Channel Adapter 阶段（需要 API 级取消能力）。修复方案：ManagedSession 新增 `abortCurrentTurn?: () => void`，runManagedTurn 设置为 `() => abortController.abort()`，ConversationManager.abort() 调用之 |
| 2 | AgentRuntime.run() 不接受 AbortSignal — adapter 中止后底层 HTTP 请求仍执行至完成 | **低** — adapter 已立即断开服务端事件链，token 浪费仅限于当前请求剩余部分 | Provider 层 AbortSignal 支持时。需 RunParams 新增 signal 字段 + 各 provider SDK 支持请求取消 |

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
改: packages/cli/src/index.ts                       — 移除 -c/-r 启动参数（ADR-CM-016）
改: packages/cli/src/repl.ts                        — 清除 -c/-r 相关代码路径
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

### `/delete` 命令（随本 Step 一起实施）

**为何在此时机：** Ephemeral + auto-promote 确定后，对话分为 ephemeral / persistent / archived 三态，`/delete` 的语义才明确——仅作用于 persistent 和 archived 对话，ephemeral 无需手动删除。

```
改: packages/cli/src/repl.ts
  - 新增 /delete 命令，声明 args: [switchArgSchema]（复用 ConversationArgProvider）
  - handler: 二次确认 → convRepo.delete(id) → 自动 fallback 到最近对话或创建 default
  - 约束: 不可删 default 对话；删除当前对话时先 fallback 再删
```

边界条件：
- 删除当前活跃对话 → fallback 到 `convRepo.findLatest()` 或创建 default
- 删除最后一个对话 → 自动创建 default
- 不可删 default → 提示用户使用 `/clear` 清空内容

### 不做

- 不实现跨设备同步（S3 阶段）
- 不实现回收站（软删除）—— MVP 先做硬删除 + 确认，未来按需补充

### 验证

- [ ] `zhixing -p "1+1"` — 执行后无磁盘文件
- [ ] `zhixing -p "创建文件 test.txt"` — 触发副作用工具 → auto-promote → 磁盘可见
- [ ] REPL 模式 — 始终持久化，不受 ephemeral 影响
- [ ] Server 单次查询 — ephemeral，不写盘
- [ ] `/delete` 二次确认后删除目标对话，磁盘目录不存在
- [ ] `/delete` 删除当前对话 → 自动切换到最近对话
- [ ] `/delete` 对 default 对话 → 拒绝并提示

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
| 2026-04-18 | Step 3 Phase C 验证完成，标记 ✅ |
| 2026-04-18 | 新增 Step 3b（Transcript 段轮转）；Step 8 补充 /delete 命令 |
| 2026-04-18 | Step 0 词汇对齐完成；Step 1 ConversationRepository 完成 |
| 2026-04-18 | Step 2 TranscriptStore 适配完成：conversationId 统一、新路径结构、旧 sessionId 在序列化边界迁移 |
| 2026-04-18 | Step 3 Phase A+B 完成：core 职责瘦身 + CLI 接线。新增 Phase C：REPL 内对话管理 |
| 2026-04-18 | ADR-CM-016：移除 `-c`/`-r` 启动参数，REPL 默认自动恢复 + `/switch`/`/new` 管理对话。更新 conversation-model.md §7.1, §12.4 |
| 2026-04-18 | Step 4 完成：ScenarioEvaluator + ContextProfile（context-profile.ts, scenario-evaluator.ts, 40 测试） |
| 2026-04-18 | Step 5 完成：LayerAssembler + TurnDigest（turn-digest.ts, layer-assembler.ts, engine.ts 扩展, 50 新测试） |
| 2026-04-18 | Step 6 完成：WindowManager + TierCompressor（pin-aware 淘汰, 四级渐进压缩, 27 新测试） |
| 2026-04-19 | Step 7 完成：ConversationManager 替代 RuntimeRegistry（observer 跟踪, grace period, idle timeout, 32 新测试） |
| 2026-04-19 | Step 7 清理轮：修复 idle reaper 脆弱模式、dead observer 泄漏、移除 RuntimeRegistry 死代码导出 |
| 2026-04-19 | 新增 Step 7a（PendingQueue）+ Step 7b（TranscriptStore 集成 + AbortSignal）；新增"已知技术债务"章节；重新评估 P1 债务复合风险并调整执行顺序 |
| 2026-04-19 | Step 7a 完成：PendingQueue 并发互斥（enqueue 三态返回、自动 dequeue、BUSY 错误码、11 单元 + 2 集成测试） |
| 2026-04-19 | Step 7b 完成：TranscriptStore 集成 + AbortSignal（turn 持久化、loadHistory 恢复、CLI 接线、AbortController/onClose、3 新集成测试） |
