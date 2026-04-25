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
S1–S3.6 ✅ + Step 17 ✅ + Step 20 ✅ + Phase 5 ✅ + Step 21A ✅ 全部已落地
  → Step 21B 🔜 WebFetch 工具（含 core/network + text-sanitizer）    ← 当前
    → Step 21  子 agent 底座 + Task 工具
      → Step 22  BackgroundAgent（spawn + 完成通知 + Delivery）
        → Step 23  Ctrl+B 推后台（REPL UX，adoptGenerator）
          → S3.5   Monitor + TaskGraph
```

**规格引用：** [persistent-service.md](specifications/persistent-service.md) · [tool-permission-execution.md](specifications/tool-permission-execution.md) · [server-gateway.md](specifications/server-gateway.md) · [confirmation-ux.md](specifications/confirmation-ux.md) · [message-outbox.md](specifications/message-outbox.md) · [conversation-model.md](specifications/conversation-model.md)

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

---

## 当前计划

### P0：Step 21B — WebFetch 工具（含 二级 LLM 能力 + `@zhixing/network` 新包）

**状态**：🔜 草稿评审完成，可实施（21A 已完成）
**草稿**：[drafts/web-fetch-tool.md](drafts/web-fetch-tool.md)
**关联 spec**：[secondary-llm-capability.md](specifications/secondary-llm-capability.md)（M0 主体在此）
**依赖**：Step 21A ✅

**范围**：4 个 milestone
- **M0** 二级 LLM 能力（按 `secondary-llm-capability.md` §七 实施）：ZhixingConfig **hard cut**（删 defaultProvider/defaultModel，新增 llm.{main,secondary}）/ LLMRoles 类型 / createProviderRoles 工厂 / ToolExecutionContext.llm 注入 / cli + serve 入口 4 处调用点更新 / **flushCallLLM 闭包同步迁移到 secondary**（清算 run-agent.ts:329 latent debt 注释）
- **M1** `@zhixing/network` 新包（url-guard + safe-fetcher + text-sanitizer），undici 依赖隔离在此
- **M2** WebFetch 工具：自描述 boundaries + permissionArgumentKey="url"（21A 路径） + preapproved hosts 通过 `registerBuiltinRules("web_fetch", ...)` namespace 注入（21A M4 路径） + ctx.llm.secondary distill + graceful degrade
- **M3** system-prompt 引导 + 入口 wiring + 草稿决策合并到正式 spec（network-egress.md / tools-builtin.md 新建）

**为什么独立于 21A**：21A 是权限/边界基建（影响所有现有工具）；21B 是新工具实现 + 配套 capability（二级 LLM）+ 网络出口原语包。三者解耦让基建可被多 consumer 复用（webhook 投递 / 第二通道 / MCP 出站等共用 `@zhixing/network`；WebSearch / MCP digest / 子 agent 返回压缩共用 `ctx.llm.secondary`）。

### P1：Step 21 — 子 agent 底座 + Task 工具

**状态**：🔜 待产出执行规格（`subagent-execution.md`）
**顶层定位**：[persistent-service.md §3.6](specifications/persistent-service.md)（原 AgentOrchestrator 层的最基础原语）
**依赖**：Step 21A ✅ + Step 21B ✅（子 agent 用 WebFetch 验证 NonInteractive 路径正确）

**为什么先做**：
- `tools-builtin/` 目前 8 个工具，缺 **Task 委托**这一基础能力。业界参考（Claude Code / OpenClaw / Cursor）均有子 agent。
- 子 agent 是 Step 22 / 23 的**底层原语**：背景能力 = 子 agent 底座 + 异步壳 + 通知。先打底座，后续是增量。
- CLI 模式下即可使用，不依赖 daemon。

**范围**（摘要，细节待 spec）：
- **子 agent 底座**（新模块 `packages/core/src/orchestrator/`）：`createChildSession` / `runChildLoop` / `bridgeEvents`
  - 共享：provider / security pipeline / memoryStore
  - 独立：eventBus / context / messages
  - 生命周期：父 AbortSignal 级联 + 资源回收
- **`tools-builtin/task.ts`**：AI 可调用的同步委托（主 agent `tool_use` → 子 agent 运行 → 结果作为 `tool_result` 回写）
- **子 agent 安全**：Broker 不 attach 渲染器 → 自动走 `NonInteractiveResolver`（现有能力，零改动）

**spec 阶段必须锁定的关键架构决策**（防返工，详见后续 `subagent-execution.md`）：
1. state 边界矩阵：provider / securityPipeline / memoryStore 的共享/独立切分
2. 子 agent 的 ConfirmationBroker：继承父 broker 还是独立 broker（影响 UX + 审计语义）
3. 工具子集契约：白名单 / 黑名单 / 默认全集
4. 资源预算：max-turns / timeout / token budget 是独立配额还是父子共享
5. Orchestrator 模块归属：core 还是 cli（涉及 `createAgentRuntime` 的归属重构）
6. 流式可见性：子 agent yield 事件冒泡父 EventBus 的策略（全冒 / 过滤 / 不冒）

**里程碑**：spec 定稿 + 9 轮架构审查后拆解。

### P2：Step 22 — BackgroundAgent（spawn + 完成通知）

**状态**：🔜 设计待启动（Step 21 完成后）
**顶层定位**：[persistent-service.md §3.6.2](specifications/persistent-service.md)
**依赖**：Step 21 ✅

**范围**（Step 21 完成后展开细节）：
- 在子 agent 底座上套 "fire-and-forget + 完成通知" 薄壳：`spawnBackground` / `onBackgroundComplete`
- `tools-builtin/background.ts`（AI 可调用派生 / 列出 / 中止）
- Delivery 挂钩：背景完成可选推通道通知（飞书 / REPL）
- 背景 agent 的事件冒泡 / 隔离策略（继承 Step 21 的流式可见性决策）

### P3：Step 23 — Ctrl+B 推后台（REPL UX）

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
