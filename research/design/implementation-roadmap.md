# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成阶段折叠为状态行，细节见 git history。

## 主线脉络

```
S1-S3.6 ✅ 全部完成（Scheduler → Server → 对话模型 → Channel → Delivery → Outbox）
  → Step 17 ✅ Daemon Level 1 (always-on)
    → Step 20 🔜 远程权限确认 (飞书交互卡片)     ← 当前（阻塞 daemon 实用性）
      → Step 18  Active Hours (免打扰·体验优化)
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

**状态**：✅ 代码实现完成（M1-M9），待 E2E 人工验收
**执行规格**：[daemon-level-1-execution.md](specifications/daemon-level-1-execution.md) ← 权威细节
**顶层定位**：[persistent-service.md §7](specifications/persistent-service.md)
**依赖**：S3.6 ✅

**范围**（概要，细节见 execution 文档）：
- `zhixing serve --daemon`：`spawn + detached + unref`，脱离终端常驻
- `zhixing serve stop` / `status` / `logs`：完整生命周期控制
- 顺带修复 TD#1（channel-not-found `retryable:true`，M9）

**里程碑交付**：
- M1 SelfExec + daemon 父进程 spawn + readiness handshake
- M2 PID 文件 schema v2 + 静默迁移 + startTime PID-reuse 检测
- M3 ServerStateFile（starting/ready/running/stopping/stopped/unhealthy 状态机）
- M4 CleanupRegistry 统一 shutdown 出口 + 跨包注入
- M5 `zhixing serve stop`（POSIX SIGTERM + 超时 SIGKILL）
- M6 `zhixing serve status`（四态 + `--json`）
- M7 `server.shutdown` RPC + Windows 降级链（RPC → taskkill /T → /F /T）
- M8 `zhixing serve logs`（默认尾部 N 行 + `--tail` 跨平台轮询）
- M9 TD#1 修复 + 回归守卫测试

**测试规模**：server 235 + cli 389 = 624 tests 全绿，零回归。

### P2：Step 20 — 远程权限确认

**状态**：待调研设计
**设计基础**：[confirmation-ux.md](specifications/confirmation-ux.md) 有 Broker 架构（Phase 1-3 覆盖 CLI 交互），缺远程/daemon 模式实现方案
**依赖**：Step 17 ✅ + 飞书交互卡片 API

**为什么提前**：Daemon 常驻后，serve 模式无交互式渲染器，任何触发确认的工具调用（bash / write 等）被永久拒绝。schedule / memory 已标记 internal 不触发确认，但定时任务执行高风险工具时仍受限。**这是 daemon 实用性的硬阻塞**——不解决远程确认，daemon 模式下只能跑"安全"工具，大幅削弱 Agent 能力。Active Hours 是体验优化，不阻塞使用。

**调研清单**：
1. 飞书交互卡片 API：按钮回调、卡片更新、回调路由
2. 异步确认流：broker `waitForDecision()` 如何挂起 agent-turn 等待远程决策
3. 超时策略：用户未响应时的降级行为
4. 安全边界：远程确认是否需要二次验证

### P3：Step 18 — Active Hours（免打扰）

**状态**：设计完成（9 轮审查通过 · v5），待实现（M1-M7）
**执行规格**：[active-hours-execution.md](specifications/active-hours-execution.md) ← 权威细节
**顶层定位**：[persistent-service.md §4.6](specifications/persistent-service.md)
**依赖**：Step 17 ✅

**范围**（概要，细节见 execution 文档）：
- `ActiveHoursConfig` 全局配置 + IANA 时区 + 跨午夜 + Jitter 窗口
- Scheduler 层单点过滤：urgent 穿透 / 非 urgent 推迟到活跃时段开始
- Jitter 错峰（借鉴 Claude Code CronJitterConfig）
- ScheduleTool 防 AI 滥用 urgent：**create + update 双路径防护**（A16）
- RPC 热更新 `schedule.activeHours.update` + **`~/.zhixing/config.override.json` 持久化**（A15 / A18）
- UX：中文友好文案（"免打扰中 (将于 08:00 恢复推送)"）

**里程碑**（7 个）：
- M1 ActiveHoursEvaluator 纯函数 + Jitter（1.5h）
- M2 ZhixingConfig 扩展 + ConfigOverrideWriter + **wiring 桥接**（1.5h）
- M3 Scheduler 集成 + **defer 两阶段** + event-bridge 订阅（2h）
- M4 ScheduleTool 防滥用（**单一 inputSchema 删 priority**）（0.5h）
- M5 RPC **`schedule.activeHours.*`** + override 持久化（1.5h）
- M6 UX 展示 + 中文文案（1h）
- M7 E2E + 文档（1h）

**预估**：~9 小时。

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
