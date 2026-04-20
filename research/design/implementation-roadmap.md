# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成阶段折叠为状态行，细节见 git history。

## 主线脉络

```
S1 ✅ Scheduler → S2 ✅ Server → S2.7 ✅ 对话模型统一
  → S5 ✅ Channel Adapter (飞书 E2E)
    → S3 ✅ Delivery Pipeline (核心 + 集成 + 路由 + 自动路由)
      → S3.5 🔜 Serve 健壮性                              ← 当前
        → S4 Daemon Level 1 (always-on)
          → Active Hours + 飞书流式卡片
            → S2.5 AgentOrchestrator
```

**规格引用：** [conversation-model.md](specifications/conversation-model.md) · [context-architecture.md](specifications/context-architecture.md) · [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md) · [confirmation-ux.md](specifications/confirmation-ux.md)

---

## 已完成阶段（折叠）

| 阶段 | 包含 Step | 状态 |
|------|----------|------|
| S2.7 对话模型统一 | 0-8a | ✅ |
| S5 Channel Adapter | 9-11 | ✅ 飞书 E2E 已验证 |
| S3 Delivery Pipeline | 12-15 | ✅ 含自动路由 |

---

## 当前：Step 16 — Serve 模式健壮性

E2E 测试驱动：飞书 + `zhixing serve` 测试 "5秒后提醒我" 暴露的系统性问题。

| 子步骤 | 问题 | 方案 | 设计 | 状态 |
|--------|------|------|------|------|
| 16a | schedule 工具在 serve 被安全管道拒绝 | `createDefaultClassifier` 注册 schedule/memory 为 `"internal"` | 已调研 | ✅ |
| 16b | AI 不知道当前时间（幻觉时间） | `buildEnvironment` 注入 `[当前时间]` | 已调研（Layer 3） | ✅ |
| 16c | 定时任务结果 30s 延迟到达 | `enqueueDelivery` 后立即 `flush()` | 已调研 | ✅ |
| 16d | AI 不知道定时任务当前状态（混淆已完成/进行中） | 每轮注入 scheduler 任务状态摘要 | 已调研（`activeTaskHint`） | 🔜 |
| 16e | 定时任务在空白会话执行（无上下文） | 独立会话 + prompt 自包含 | **待短设计** | 🔲 |
| 16f | 任务结果不记入对话历史 | 依赖 16e，执行后 recordTurn 或推送摘要 | **待短设计** | 🔲 |

设计决策：
- 16d：LayerAssembler 预留的 `activeTaskHint` 参数，注入格式 `[定时任务] N 个活跃 / 最近完成: {name} {time}`
- 16e：定时任务是独立执行单元，不耦合用户对话。现有 `[系统]` context framing 已覆盖基本场景
- 16f：与 16e 关联——独立会话执行，结果通过 delivery 推送而非写入原始对话

---

## 后续路线

| Step | 名称 | 说明 | 设计 | 依赖 |
|------|------|------|------|------|
| 17 | Daemon Level 1 | `--daemon` + PID + 日志 + `zhixing stop/status` | 已调研（persistent-service.md §5） | Step 16 |
| 18 | Active Hours 免打扰 | DeliveryFilter 实现 + 配置解析 | 已调研（persistent-service.md §4.7） | Step 15 |
| 19 | 飞书流式卡片 | StreamableChannel trait + Feishu 实现 | **待调研**（飞书卡片流式更新 API） | 独立 |
| 20 | 远程权限确认 | 飞书卡片 Renderer + 异步等待流 | **待调研** | Step 17 |

### Step 20 调研清单

serve 模式无交互式渲染器，任何触发确认的工具调用被永久拒绝。confirmation-ux.md 有 Broker 架构但缺远程实现方案。

需调研：
1. 飞书交互卡片 API：按钮回调、卡片更新、回调路由
2. 异步确认流：broker `waitForDecision()` 如何挂起 agent-turn 等待远程决策
3. 超时策略：用户未响应时的降级行为
4. 安全边界：远程确认是否需要二次验证

优先级：中。schedule/memory 已分类为 internal 不触发确认，但定时任务执行 bash/write 时仍会被拒。Daemon 上线后变紧迫。

---

## 延后方向

| 方向 | 规格来源 | 设计 |
|------|---------|------|
| AgentOrchestrator | persistent-service.md §3.6 | 已调研 |
| 第二社交通道（钉钉/企微） | server-gateway.md §8.1 | **待调研** |
| OpenAI 兼容端点 | server-gateway.md §9 | 已调研 |
| Web UI | — | **待设计** |

---

## 技术债务

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | session.abort 不中断当前 turn | **中** | Provider 层支持时 |
| 2 | AgentRuntime.run() 不接受 AbortSignal | **低** | Provider 层支持时 |
| 3 | promote() 并发 TOCTOU | **低** | 实现 /keep 时 |
| 4 | Channel credentials 无 `env:` / `helper:` 解析 | **中** | 第二通道接入前 |
| 5 | loadConfig 在 serve 流程中重复加载 | **低** | RuntimeFactory 重构时 |
| 6 | 同类型多实例通道配置硬崩溃 | **低** | 多实例需求出现时 |
| 7 | Scheduled task 共享默认会话（上下文串扰） | **中** | Step 16e |
| 8 | 无 `defaultChannel` 配置（多通道 tiebreaker） | **低** | 第二通道接入时 |

### 延后 / 可选

| 名称 | 说明 |
|------|------|
| Transcript 段轮转 | 内部优化，文件膨胀时再做 |
| /delete 命令 | REPL 卫生，不阻塞主线 |
| 移除 -c/-r 启动参数 | CLI 清理，不阻塞主线 |
