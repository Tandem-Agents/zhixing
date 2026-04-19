# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成的 Step 只保留状态行，细节见 git history。

## 状态总览

| Step | 名称 | 状态 | 依赖 |
|------|------|------|------|
| 0 | 词汇对齐 | ✅ | 无 |
| 1 | ConversationRepository | ✅ | Step 0 |
| 2 | TranscriptStore 适配 | ✅ | Step 0, 1 |
| 3 | CLI 对接 Conversation | ✅ | Step 2 |
| 3b | Transcript 段轮转 | 🔲 待开始 | Step 3 |
| 4 | ScenarioEvaluator + ContextProfile | ✅ | Step 0 |
| 5 | LayerAssembler + TurnDigest | ✅ | Step 4 |
| 6 | WindowManager + Pinning | ✅ | Step 5 |
| 7 | ConversationManager + SessionRuntime | ✅ | Step 3, 6 |
| 7a | PendingQueue 并发互斥 | ✅ | Step 7 |
| 7b | TranscriptStore 集成 + AbortSignal | ✅ | Step 7a |
| 8a | Ephemeral + recordTurn + promote | ✅ | Step 7b |
| 8b | CLI -p 模式 + Server 单查询 ephemeral | 🔲 待开始 | Step 8a |
| 8c | /delete 命令 | 🔲 待开始 | Step 8a |
| 8d | 移除 -c/-r 启动参数 | 🔲 待开始 | Step 8a |

**规格引用：** [conversation-model.md](specifications/conversation-model.md) · [context-architecture.md](specifications/context-architecture.md) · [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md)

---

## 待实施

### Step 3b: Transcript 段轮转

**目标：** conversation-model.md §9.5 — 主对话 transcript.jsonl 无限膨胀时自动轮转归档段

**改动：** transcript/store.ts 内部优化，ITranscriptStore 接口不变

- appendCompact() 内部触发轮转：写 .new → rename 旧文件到 archive/ → rename .new
- load() 加崩溃恢复检查
- TranscriptHeader 新增 archivedTurnCount?: number

### Step 8b: CLI -p 模式 + Server 单查询 ephemeral

**目标：** conversation-model.md §6 — 一次性查询不落盘

| 场景 | 是否 ephemeral |
|------|---------------|
| Server 单次查询 | 是 |
| CLI `-p` 模式 | 是 |
| CLI REPL | 否 |

### Step 8c: /delete 命令

**目标：** REPL 内删除对话

```
改: packages/cli/src/repl.ts
  - /delete 复用 ConversationArgProvider
  - 二次确认 → convRepo.delete(id) → fallback 到最近对话
  - 不可删 default → 提示 /clear
```

### Step 8d: 移除 -c/-r 启动参数

**目标：** ADR-CM-016 落地，清理遗留代码

### auto-promote 触发条件（8b 实现时参考）

- 第 2 个 Turn 发生（8a 已实现 turnCount>=2 自动晋升）
- 使用了有副作用的工具 (write/edit/bash)
- ScenarioEvaluator 升级 hint
- 用户执行 `/keep` 命令

---

## 已知技术债务

### P1-计划中

| # | 问题 | 计划时机 |
|---|------|---------|
| 1 | TurnSource 参数缺失（scheduler/channel/interactive 区分） | Channel Adapter 阶段 |

### P2-计划中

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | session.abort 不中断当前 turn — 只影响下次 run() | **中** | Channel Adapter 阶段 |
| 2 | AgentRuntime.run() 不接受 AbortSignal — 底层 HTTP 继续执行 | **低** | Provider 层支持时 |
| 3 | promote() 并发 TOCTOU — 外部 promote 与 auto-promote 竞争 | **低** | 实现 /keep 时 |

---

## 后续路线

| 方向 | 规格来源 | 前置条件 |
|------|---------|---------|
| Channel Adapters (钉钉/飞书) | server-gateway.md §5 | Step 7 |
| Delivery Pipeline | persistent-service.md §4 | Step 7 |
| AgentOrchestrator | persistent-service.md §2 | Step 7 |
| OpenAI 兼容端点 | server-gateway.md §8 | Step 7 |
| Web UI | 待设计 | Step 7 |
