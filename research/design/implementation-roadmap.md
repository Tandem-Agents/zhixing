# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成阶段折叠为状态行，细节见 git history。

## 主线脉络

```
S1 ✅ Scheduler → S2 ✅ Server → S2.7 ✅ 对话模型统一
  → S5 ✅ Channel Adapter (飞书 E2E)
    → S3 ✅ Delivery Pipeline (核心 + 集成 + 路由 + 自动路由)
      → S3.5 ✅ Serve 健壮性 (Step 16a-h)
        → S3.6 🔜 Message Outbox (顺序 + commitment)       ← 当前
          → S4 Daemon Level 1 (always-on)
            → Active Hours + 飞书流式卡片
              → S2.5 AgentOrchestrator
```

**规格引用：** [conversation-model.md](specifications/conversation-model.md) · [context-architecture.md](specifications/context-architecture.md) · [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md) · [confirmation-ux.md](specifications/confirmation-ux.md) · [message-outbox.md](specifications/message-outbox.md)

---

## 已完成阶段（折叠）


| 阶段                   | 包含 Step | 状态                     |
| -------------------- | ------- | ---------------------- |
| S2.7 对话模型统一          | 0-8a    | ✅                      |
| S5 Channel Adapter   | 9-11    | ✅ 飞书 E2E 已验证           |
| S3 Delivery Pipeline | 12-15   | ✅ 含自动路由                |
| S3.5 Serve 健壮性       | 16a-h   | ✅ 飞书 E2E 无 conv_xxx 泄漏 |


---

## 当前：Step 16.9 — Message Outbox（顺序 + commitment）

**规格：** [message-outbox.md](specifications/message-outbox.md) · **决策：** [ADR-007](architecture/decisions/007-message-outbox.md)

**问题**：Step 16 飞书 E2E 暴露了多生产者顺序倒转——"5秒后提醒我"时，Scheduler 触发的"时间到了"先到，LLM 二轮推理的"已创建"后到。根因是系统缺失"用户时间轴所有者"这一架构层。Daemon（Step 17）上线后生产者激增，此问题非线性恶化。**必须在 Step 17 之前修复。**


| 阶段      | 范围                                                                                                                                        | 状态                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 16.9-P1 | Outbox 基础设施（per-target FIFO、registry、事件）+ DeliveryPipeline drain 目标改为 Outbox + InboundRouter 改为 Outbox。无行为变化，铺管道                          | ✅ 2026-04-21（1421 core + 195 server 测试绿；drain race 修复） |
| 16.9-P2 | Tool-authored commitment：`ToolExecutionContext.commitToUser` + `ToolResult.committedToUser` + schedule 工具改造 + 系统提示抑制叙述。**修掉常规 inversion** | 🔜 当前                                                  |
| 16.9-P3 | Turn Slot 因果锁：TurnId 引入 + ConversationManager 对接 openSlot/fillSlot + Scheduler 任务 `createdInTurn` + Outbox drain 因果阻塞。**结构保证顺序正确**        | 🔲 待实施                                                 |
| 16.9-P4 | inflight 重试 + Outbox 持久化                                                                                                                  | 延后，非必需                                                 |


**验收**（每阶段独立）：

- P1：所有回归测试绿；LLM 回复与 Scheduler 投递都产出 `entry:enqueued`/`entry:sent` 事件
- P2：飞书 E2E "5秒后提醒我"，commitment 在 task fire 之前（LLM 常规延迟下）
- P3：构造 LLM 10s 延迟 + 5s 任务的测试，task fire 仍在 LLM 回复后

**跨模块影响**：

- [conversation-model.md](specifications/conversation-model.md) §5.3 引入全局 TurnId ✅
- [ADR-004](architecture/decisions/004-tool-system-architecture.md) 增补决策 7（User-facing 输出通道）✅
- [persistent-service.md](specifications/persistent-service.md) §4.7 Delivery Pipeline 职责切分说明 ✅

### 历史记录：Step 16 — Serve 模式健壮性（✅ 已完成 2026-04-20）

E2E 测试驱动，飞书 + `zhixing serve` 测试 "5秒后提醒我" 暴露的系统性问题。


| 子步骤 | 问题                         | 方案                                                               | 状态  |
| --- | -------------------------- | ---------------------------------------------------------------- | --- |
| 16a | schedule 工具在 serve 被安全管道拒绝 | 注册 schedule/memory 为 `"internal"`                                | ✅   |
| 16b | AI 不知道当前时间                 | `buildEnvironment` 注入 `[当前时间]`                                   | ✅   |
| 16c | 定时任务结果 30s 延迟              | `enqueueDelivery` 后立即 `flush()`                                  | ✅   |
| 16d | AI 不知道定时任务状态               | 每轮注入 scheduler snapshot                                          | ✅   |
| 16e | 临时会话无限累积（conv_xxx）         | ephemeral 执行：绕过 ConversationManager，bare runtime → run → dispose | ✅   |
| 16f | 任务结果不记入对话历史                | 已被 delivery + TurnContext 覆盖                                     | ✅   |
| 16g | 结果无法回到来源用户                 | Origin capture 模式                                                | ✅   |
| 16h | interval 最小间隔无保护           | tool + scheduler 双层拒绝 `< 60s`                                    | ✅   |


**注**：Step 16 的多生产者顺序问题（16e ephemeral 上线后首次可观察）不属 Step 16 范围，由 Step 16.9 Outbox 专项解决。

---

## 后续路线


| Step | 名称               | 说明                                            | 设计                              | 依赖             |
| ---- | ---------------- | --------------------------------------------- | ------------------------------- | -------------- |
| 17   | Daemon Level 1   | `--daemon` + PID + 日志 + `zhixing stop/status` | 已调研（persistent-service.md §5）   | **Step 16.9**  |
| 18   | Active Hours 免打扰 | DeliveryFilter 实现 + 配置解析                      | 已调研（persistent-service.md §4.7） | Step 15 + 16.9 |
| 19   | 飞书流式卡片           | StreamableChannel trait + Feishu 实现           | **待调研**（飞书卡片流式更新 API）           | Step 16.9      |
| 20   | 远程权限确认           | 飞书卡片 Renderer + 异步等待流                         | **待调研**                         | Step 17 + 16.9 |


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


| 方向                | 规格来源                       | 设计      |
| ----------------- | -------------------------- | ------- |
| AgentOrchestrator | persistent-service.md §3.6 | 已调研     |
| 第二社交通道（钉钉/企微）     | server-gateway.md §8.1     | **待调研** |
| OpenAI 兼容端点       | server-gateway.md §9       | 已调研     |
| Web UI            | —                          | **待设计** |


---

## 技术债务


| #   | 问题                                                                         | 影响    | 计划时机                                                  |
| --- | -------------------------------------------------------------------------- | ----- | ----------------------------------------------------- |
| 1   | session.abort 不中断当前 turn                                                   | **中** | Provider 层支持时                                         |
| 2   | AgentRuntime.run() 不接受 AbortSignal                                         | **低** | Provider 层支持时                                         |
| 3   | promote() 并发 TOCTOU                                                        | **低** | 实现 /keep 时                                            |
| 4   | Channel credentials 无 `env:` / `helper:` 解析                                | **中** | 第二通道接入前                                               |
| 5   | loadConfig 在 serve 流程中重复加载                                                 | **低** | RuntimeFactory 重构时                                    |
| 6   | 同类型多实例通道配置硬崩溃                                                              | **低** | 多实例需求出现时                                              |
| 7   | ~~Scheduled task 共享默认会话（上下文串扰）~~                                           | —     | ✅ 16g origin capture 解决                               |
| 8   | 无 `defaultChannel` 配置（多通道 tiebreaker）                                      | **低** | 第二通道接入时                                               |
| 9   | 长对话历史下模型跳过工具调用（context rot）                                                | **中** | 历史剪枝 + tool-call guard                                |
| 10  | ~~定时任务临时会话无清理策略（conv_xxx 累积）~~                                             | —     | ✅ Step 16e ephemeral execution 解决                     |
| 11  | 多生产者顺序倒转（commitment vs action）                                             | **高** | Step 16.9 Outbox                                      |
| 12  | `setup-delivery` 里 channel-not-found 返回 `retryable:false`，热重载/重连期间投递会被静默丢弃 | **中** | Step 17 Daemon 前                                      |
| 13  | `DeliverySource.scheduler.taskName` → `EmissionSource` 映射时丢弃，日志只见 taskId   | **低** | Step 16.9 Phase 3 扩展 EmissionSource 时顺带               |
| 14  | `OutboxRegistry` 到 `Outbox` 的 init 顺序依赖（late-bind fragile）                 | **低** | Step 16.9 Phase 2 重排 command.ts 时上移 OutboxRegistry 构造 |
| 15  | `OutboxLogger` 接口与其他 core 模块不统一                                            | **低** | 见到第二个消费者时重构                                           |
| 16  | Outbox pending 无上限，坏 adapter + 高速生产者可致 OOM                                 | **低** | 实际出现再说                                                |
| 17  | Outbox 无 cancel 语义（用户超时/取消后仍投递）                                            | **低** | Step 20 远程确认超时场景                                      |


### 延后 / 可选


| 名称             | 说明            |
| -------------- | ------------- |
| Transcript 段轮转 | 内部优化，文件膨胀时再做  |
| /delete 命令     | REPL 卫生，不阻塞主线 |
| 移除 -c/-r 启动参数  | CLI 清理，不阻塞主线  |


