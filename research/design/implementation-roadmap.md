# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成阶段折叠为状态行，细节见 git history。

## 主线脉络

```
S1-S3.6 ✅ 全部完成（Scheduler → Server → 对话模型 → Channel → Delivery → Outbox）
  → Step 17 🔜 Daemon Level 1 (always-on)              ← 当前
    → Step 18  Active Hours (免打扰)
      → Step 20  远程权限确认 (飞书交互卡片)
        → S2.5  AgentOrchestrator (背景 Agent + 协调)
```

**规格引用：** [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md) · [confirmation-ux.md](specifications/confirmation-ux.md) · [message-outbox.md](specifications/message-outbox.md) · [conversation-model.md](specifications/conversation-model.md)

---

## 已完成阶段

| 阶段 | 包含 Step | 状态 |
|------|---------|------|
| S1 Scheduler | — | ✅ |
| S2 Server 前台模式 | — | ✅ |
| S2.7 对话模型统一 | 0-8a | ✅ |
| S5 Channel Adapter | 9-11 | ✅ 飞书 E2E |
| S3 Delivery Pipeline | 12-15 | ✅ 含自动路由 |
| S3.5 Serve 健壮性 | 16a-h | ✅ |
| S3.6 Message Outbox | 16.9 (P1-P3 + M31-M34) | ✅ 顺序 + 忠实送达 + 生命周期收敛 |

---

## 当前计划

### P1：Step 17 — Daemon Level 1（always-on）

**状态**：已调研
**设计**：[persistent-service.md §7](specifications/persistent-service.md)
**依赖**：S3.6 ✅

**范围**：
- `zhixing serve --daemon`：fork + detach + PID 文件 + 端口文件 + 日志文件
- `zhixing serve stop`：读 PID → SIGTERM → 优雅停机
- `zhixing serve status`：检查进程 + 端口健康
- CLI 自动检测：启动时检查 PID → Server 运行中则连接 WebSocket
- 顺带修复 TD#1（channel-not-found retryable:false → Daemon 长时运行必现）

### P2：Step 18 — Active Hours（免打扰）

**状态**：已调研（方案需适配——Pipeline filter 链已在 M32 移除）
**设计**：[persistent-service.md §4.6](specifications/persistent-service.md)
**依赖**：Step 17

**范围**：
- `ActiveHoursConfig`（start / end / timezone）
- Scheduler 层判定：免打扰时段推迟非 urgent 任务到活跃时段开始
- urgent 穿透：priority = "urgent" 无视免打扰
- 实现方式：Scheduler 层直接判定（非 Pipeline filter——filter 链已随 Faithful Delivery 契约移除）

### P3：Step 20 — 远程权限确认

**状态**：待调研
**设计**：[confirmation-ux.md](specifications/confirmation-ux.md) 有 Broker 架构，缺远程实现方案
**依赖**：Step 17 + 飞书交互卡片 API

**问题**：serve 模式无交互式渲染器，任何触发确认的工具调用（bash / write 等）被永久拒绝。schedule / memory 已标记 internal 不触发确认，但定时任务执行高风险工具时仍受限。Daemon 上线后变紧迫。

**调研清单**：
1. 飞书交互卡片 API：按钮回调、卡片更新、回调路由
2. 异步确认流：broker `waitForDecision()` 如何挂起 agent-turn 等待远程决策
3. 超时策略：用户未响应时的降级行为
4. 安全边界：远程确认是否需要二次验证

---

## 延后方向

| 方向 | 规格来源 | 设计 |
|------|---------|------|
| S2.5 AgentOrchestrator | persistent-service.md §3.6 | 已调研 |
| 飞书流式卡片 | — | **待调研** |
| 第二社交通道（钉钉 / 企微） | server-gateway.md §8.1 | **待调研** |
| OpenAI 兼容端点 | server-gateway.md §9 | 已调研 |
| Web UI | — | **待设计** |

---

## 技术债务

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | `setup-delivery` channel-not-found 返回 `retryable:false`，长时运行通道重连期间投递被静默丢弃 | **中** | **Step 17 顺带修** |
| 2 | session.abort 不中断当前 turn（AgentRuntime.run 不接受 AbortSignal） | **中** | Provider 层支持时 |
| 3 | 长对话历史下模型跳过工具调用（context rot） | **中** | 历史剪枝 + tool-call guard |
| 4 | Channel credentials 无 `env:` / `helper:` 解析 | **中** | 第二通道接入前 |
| 5 | KL-1 / KL-3：并发 `queue.save()` rename race | **低** | 独立工单（queue.ts 加 singleflight） |
| 6 | KL-2：start/stop 并发导致 flushTimer 泄漏 | **低** | 独立工单（setInterval 前 re-check state） |
| 7 | Outbox pending 无上限（坏 adapter + 高速生产者可致 OOM） | **低** | 实际出现再说 |
| 8 | Outbox 无 cancel 语义（用户超时 / 取消后仍投递） | **低** | Step 20 远程确认超时场景 |

### 延后 / 可选

| 名称 | 说明 |
|------|------|
| Transcript 段轮转 | 内部优化，文件膨胀时再做 |
| /delete 命令 | REPL 卫生，不阻塞主线 |
| 移除 -c/-r 启动参数 | CLI 清理，不阻塞主线 |
