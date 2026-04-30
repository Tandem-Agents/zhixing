# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成阶段折叠为状态行，细节见 git history。

## 原则

本文档的维护规则。**原则稳定**，大多数修改只动下方"当前计划"；**内容动态**，随实现推进持续重写。

- **定位**：聚焦**当前正在推进的实现计划**。已完成项折叠为单行状态；历史细节归 git history，不在本文保留。
- **内容只写当前**：主线一次展开 1–3 个 Step 的里程碑进度。已设计但未排期的条目放到"延后方向"单行索引，不在此展开。
- **顺序**：当前计划 → 延后方向 → 技术债务。未实现项永远排在已计划项之后。
- **不写**（否则膨胀且易腐）：
  - 版本演化 / 修订记录 / "20xx-xx-xx 更新" 片段 —— 原地改，不追加历史段。
  - 已完成里程碑的 M1–Mn 全量清单 —— execution 规格 + git log 已是权威。
  - 架构决策 / 代码结构 / 设计推演 —— 属于 `specifications/*.md` 和 ADR。
- **条目格式**：状态 + 执行规格链接 + 一句话摘要 + 依赖。具体细节一律走规格文件。
- **技术债务**单独简表（问题 · 影响 · 计划时机）。修完即删行，不保留已修复条目。

---

## 主线脉络

```
S1–S3.6 ✅ + Step 17 ✅ + Step 20 ✅ + Phase 5 ✅ + Step 21A ✅ + Step 21B ✅ + 远程打断 ✅ 全部已落地
  → Step 21  子 agent 底座 + Task 工具    ← 当前
    → Step 22  BackgroundAgent（spawn + 完成通知 + Delivery）
      → Step 23  Ctrl+B 推后台（REPL UX，adoptGenerator）
        → S3.5   Monitor + TaskGraph
```

**规格引用：** [persistent-service.md](specifications/persistent-service.md) · [tool-permission-execution.md](specifications/tool-permission-execution.md) · [server-gateway.md](specifications/server-gateway.md) · [confirmation-ux.md](specifications/confirmation-ux.md) · [message-outbox.md](specifications/message-outbox.md) · [conversation-model.md](specifications/conversation-model.md) · [subagent-execution.md](specifications/subagent-execution.md)

---

## 已完成阶段

| 阶段 | 状态 |
|------|------|
| S1 Scheduler | ✅ |
| S2 Server 前台模式 | ✅ |
| S2.7 对话模型统一 | ✅ |
| S5 Channel Adapter（飞书 E2E） | ✅ |
| S3 Delivery Pipeline（含自动路由） | ✅ |
| S3.5 Serve 健壮性 | ✅ |
| S3.6 Message Outbox（顺序 + 忠实送达 + 生命周期收敛） | ✅ |
| Step 17 Daemon Level 1（spawn / stop / status / logs） | ✅ E2E 已验收 |
| Step 20 远程权限确认（通道无关纯文本协议） | ✅ E2E 已验收 |
| Phase 5 Transcript 治理（commitTurn 原子截断 + 单向数据流） | ✅ |
| Step 21A 工具权限/边界基础设施补齐（M1+M2+M3+M4+§五.7） | ✅ |
| Step 21B WebFetch 工具（M0 二级 LLM 能力 + M1 @zhixing/network + M2 web_fetch + M3 spec 提升） | ✅ |
| 远程打断 + Cancel Intent（[remote-interruption-execution](specifications/remote-interruption-execution.md)：RPC abort / scheduler shutdown / IntentClassifier 语义二分 / 飞书 cancel 入口） | ✅ E2E 已验收 |

---

## 当前计划

### P0：Step 21 — 子 agent 底座 + Task 工具

**状态**：🔄 M0 ✅ + M1 ✅ + M2.1 ✅ + M2.2 ✅ + M2.3 ✅ + M2.4 ✅ + M2.5 ✅ 已完成；M2.6 token / budget 软上限 当前焦点（详见 [subagent-execution.md §15](specifications/subagent-execution.md) 子里程碑表）
**顶层定位**：[persistent-service.md §3.6](specifications/persistent-service.md)（AgentOrchestrator 层最基础原语）
**依赖**：Step 21A ✅ + Step 21B ✅ + 远程打断 ✅（子 agent 复用 abort 级联机制）

**产品本质**：Task 的核心价值是"上下文隔离的研究型子任务"——调研中间产物的 token 不污染主对话上下文，而非"并发"。所有内部决策应优先保护这一价值。

**为什么先做**：
- `tools-builtin/` 现有 9 个工具，缺 **Task 委托**这一基础能力。业界参考（Claude Code / OpenClaw / Cursor）均有子 agent。
- 子 agent 是 Step 22 / 23 的**底层原语**:背景能力 = 子 agent 底座 + 异步壳 + 通知。先打底座，后续是增量。
- CLI 模式下即可使用，不依赖 daemon。

**为什么内部拆 M0/M1/M2**：单 Step 同时背基础设施重构（`createAgentRuntime` 当前在 cli，跨包搬家）+ 新模块（orchestrator）+ AI-facing 业务（Task 工具）+ 12 个决策——回归面积过大。拆分让重构、底座、业务可独立 commit / 独立审查。

#### M0 — 调研 + spec + 重构准备（不写业务代码）

- 产出 `research/design/drafts/subagent-research.md`：业界（claudecode / openclaw / hermes 的 Task 工具源码级要点）+ 本仓 hooks 盘点（`createAgentRuntime` / `ConfirmationBroker` / EventBus / interrupt 现状）
- 产出 `research/design/specifications/subagent-execution.md` 草稿：12 个关键决策的初步答案
- 锁定决策 5（Orchestrator 模块归属：core / 独立 `@zhixing/orchestrator` 包），给出 `createAgentRuntime` 跨包重构方案
- 审查锚点：1–2 轮架构审查聚焦决策合理性

#### M1 — 基础设施重构（不写子 agent 业务）

- 把 `createAgentRuntime` 从 `packages/cli/src/run-agent.ts:206` 搬到 M0 决策的目标位置
- 让 cli / server / 未来 orchestrator 共用同一 runtime 入口
- 现有功能零回归（cli / serve / RPC 测试全绿）
- 独立可 commit，与子 agent 业务解耦——失败可单独回滚不带走子 agent 工作
- 审查锚点：1 轮，焦点"现有功能不破"

#### M2 — 子 agent 底座 + Task 工具（业务交付）

子里程碑 M2.1–M2.7 拆解与已完成情况详见 [subagent-execution.md §15 M2](specifications/subagent-execution.md)（spec 是真相源）。当前已完成 M2.1 ✅ runChildAgent 骨架 + M2.2 ✅ child broker audit + M2.3 ✅ Task 工具 / 主路径 ALS / sub-agent-delegation segment + M2.4 ✅ CLI 状态条 + 单一事实源策略表 + 四处生产入口启用 Task + M2.5 ✅ tool-executor 并发改造（Promise.allSettled 真并发，N≥2 全 isParallelSafe → 并发，否则回退串行；3 Task 总耗时 ≈ max 而非 sum）；M2.6 token / budget 软上限为当前焦点。

审查锚点：每子里程碑 1 轮小审查 + 终审 1 轮 = 7 轮（与 M0 / M1 累计 9–10 轮）。

#### spec 阶段必须锁定的关键架构决策（防返工，详见 `subagent-execution.md`）

| # | 决策 | 影响维度 |
|---|------|---------|
| 1 | state 边界矩阵：provider / securityPipeline / memoryStore 共享 / 独立切分 | 内部架构 |
| 2 | 子 agent 的 ConfirmationBroker：继承父 broker / 独立 broker | UX + 审计 |
| 3 | 工具子集契约：白名单 / 黑名单 / 默认全集 | 安全 |
| 4 | 资源预算：max-turns / timeout / token budget 独立 / 共享 | 成本 + 失控防御 |
| 5 | Orchestrator 模块归属：core / 独立 `@zhixing/orchestrator` 包 | 跨包重构 |
| 6 | 流式可见性：子 agent yield 事件冒泡父 EventBus（全冒 / 过滤 / 不冒） | 内部架构 |
| 7 | 错误传播语义：tool_result error / 抛异常给主 / 透明降级 | UX + 智能体行为 |
| 8 | 递归层级限制：子 agent 能否再起子 agent，深度上限 | 失控防御 |
| 9 | 审计与 transcript：子 transcript 是否持久化、主会话是否含子步骤、daemon 重启恢复 | UX + 持久化 |
| 10 | abort 双向传播：父 → 子立即 / graceful；子 fail → 是否反向 abort 主 | 中断协议 |
| 11 | token / 成本归属：归主会话 / 独立计、CLI / 飞书呈现 | 计费透明 |
| 12 | CLI / 飞书 / RPC 三方 UX 差异：流式 / 折叠 / 静默 / 浮标 | 产品 UX |

### P1：Step 22 — BackgroundAgent（spawn + 完成通知）

**状态**：🔜 设计待启动（Step 21 完成后）
**顶层定位**：[persistent-service.md §3.6.2](specifications/persistent-service.md)
**依赖**：Step 21 ✅

**范围**（Step 21 完成后展开细节）：
- 在子 agent 底座上套 "fire-and-forget + 完成通知" 薄壳：`spawnBackground` / `onBackgroundComplete`
- `tools-builtin/background.ts`（AI 可调用派生 / 列出 / 中止）
- Delivery 挂钩：背景完成可选推通道通知（飞书 / REPL）
- 背景 agent 的事件冒泡 / 隔离策略（继承 Step 21 的流式可见性决策）

### P2：Step 23 — Ctrl+B 推后台（REPL UX）

**状态**：🔜 设计待启动（Step 22 完成后，可后置）
**顶层定位**：[persistent-service.md §3.6.2](specifications/persistent-service.md) + Phase S2.5 Ctrl+B 章节
**依赖**：Step 22 ✅

**为什么独立**：跟 spawnBackground 实现共享 < 20%，机制完全不同——处理"已经在跑的主 generator 转移"，涉及 stdin raw 捕获、Win/Unix 平台差异、agent phase 状态机、确认 pending / 流式中的边界。捆在 Step 22 会让 spec 设计失焦。

**范围**（Step 22 完成后展开细节）：
- REPL stdin raw mode 捕获 `\x02`（复用现有 `stdin-ownership.ts`）
- `adoptGenerator(gen, currentState)`：把 await 中的主 generator 挪入背景集合
- 边界：确认 pending / 工具执行中 / streaming 流式中的 Ctrl+B 行为定义
- 跨平台：Windows / Unix stdin 差异处理

---

## 延后方向

| 方向 | 规格来源 | 状态 |
|------|---------|------|
| Step 18 Active Hours（免打扰） | [active-hours-execution.md](specifications/active-hours-execution.md) | 设计完成，暂缓实现（用户行为可替代，UX 优化非硬需求） |
| S3.5 Monitor + TaskGraph | persistent-service.md §3.6.3–4 | 已调研（依赖 Step 22 / 23 落地） |
| 飞书流式卡片 | — | **待调研** |
| 第二社交通道（钉钉 / 企微） | server-gateway.md §8.1 | **待调研**（前置修 TD#4） |
| OpenAI 兼容端点 | server-gateway.md §9 | 已调研 |
| Web UI | — | **待设计** |

---

## 技术债务

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 4 | Channel credentials 无 `env:` / `helper:` 解析（`channels.ts` 直接透传 `entry.credentials`） | **中** | 第二通道接入前 |
| 5 | KL-1 / KL-3：并发 `queue.save()` rename race（`queue.ts` 注释标注为独立工单） | **低** | 独立工单（queue.ts 加 singleflight） |
| 6 | KL-2：start/stop 并发导致 flushTimer 泄漏（setInterval 回调已加 state 防御；setInterval 前缺 re-check + timer 未 unref） | **低** | 独立工单 |
| 7 | Outbox pending 无上限（坏 adapter + 高速生产者可致 OOM） | **低** | 实际出现再说 |
| 8 | Outbox 无 cancel 语义（用户超时 / 取消后仍投递） | **低** | 出现实际问题再修 |

### 延后 / 可选（CLI 清理类，不阻塞主线）

| 名称 | 说明 |
|------|------|
| /delete 命令 | REPL 卫生 |
| 移除 -c/-r 启动参数 | CLI 清理 |
