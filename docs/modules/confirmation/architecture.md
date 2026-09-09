# 确认交互架构

确认负责取得用户对待执行操作的决定，而非重新定义安全策略。审批应能表达拒绝理由，让模型调整方案；缺少交互能力或用户未响应不能默认放宽安全边界。具体入口见[确认接入与交互](surfaces.md)，工具侧政策与批准应用见[工具与权限集成](../tools/permission-integration.md)。

## 设计取舍

| 问题 | 当前取舍及理由 |
|---|---|
| 工具直接调用终端还是分离决定与展示 | 请求、决定和 Broker 不依赖终端；渲染器只负责展示与回传。同一授权语义供 CLI、RPC 和渠道使用，不复制安全裁决 |
| 拒绝是开关还是反馈 | `deny.reason` 回到工具错误结果，模型可以据此改方案；拒绝本次工具不等于取消整个工作 |
| 远程必须有按钮吗 | 文本往返是基础，不以平台按钮能力作为前提；富交互不能另造授权语义，也不能替代身份校验 |
| 等待用户期间如何处理内容排序 | 确认属于控制流，不等待当前 Run 的内容 Slot 填充，否则“工具等确认、确认等工具完成”会死锁 |
| 内存首次决定是否足够 | Broker 管本地等待；耐久执行还要提交 interaction 终态并镜像到权威日志，才能证明应答已落定与重试不重复生效 |
| 无渲染器如何处理 | 默认拒绝，只降便利不降安全；是否有订阅者不等于用户实际可达 |

## 职责与生产链

工具安全评估 → [secure-executor](../../../packages/orchestrator/src/security/secure-executor.ts) → [请求构造器](../../../packages/core/src/confirmation/request-builder.ts) → [ConfirmationBroker](../../../packages/core/src/confirmation/broker.ts) → 宿主确认 binding／渲染接入 → 用户决定 → 耐久提交 → 工具继续或拒绝。

- **安全与 Trust Administration**决定是否需要确认、可用授权范围以及规则应用；确认不是绕过禁区的第二授权入口。AI 安全助理属于前置研判，不是用户应答的替身。
- **请求**携带操作、展示摘要、上下文、选项、期限与回程来源；展示预览与真实执行输入分离。Bash 预览剥离 CSI 与控制字符，但不能据此宣称所有展示字段均已全面脱敏，或文件快照校验已经实现。
- **Broker**拥有本地排队与等待 Promise，不拥有跨设备的最终事实。子 Agent 使用派生 Broker，血缘用于追溯；每 Broker 串行不等于所有子任务共享一个全局展示锁，详见[子 Agent 架构](../subagents/architecture.md)。
- **[ConfirmationHub](../../../packages/owner-kernel/src/confirmation-hub.ts)**聚合请求、查询和应答，不取代 Broker 或权威日志；Server 经[有限 binding](../../../packages/cli/src/serve/server-product-bindings.ts)接入，不能从旧 ServerContext 直取业务所有者。
- **耐久交互**由宿主接线：对话见[durable-conversation-interactions](../../../packages/cli/src/serve/durable-conversation-interactions.ts)，Job 见[durable-job-interactions](../../../packages/cli/src/serve/durable-job-interactions.ts)。请求先登记 assignment interaction；终结经提交与镜像，再释放等待。对话归对话权威链，Job 归 JobJournal，不以无身份 ephemeral Broker 替代。
- **表面**只投影与提交决定。旁观可见不等于可应答，本机 RPC 与渠道应答分别校验自己的身份和执行绑定。

## 排队、终态与恢复

当前 Broker 默认最大 pending 深度 32；队满立即产生 `cancelled(backpressure)`，不是旧设计中的十条上限或 BackpressureError。队首展示，排队请求也从既定 `expiresAt` 计时；请求构造器默认期限为 30 分钟。已解决记录默认留存 15 秒，仅用于本地重复 ID 检查和查询，不是跨重启账本。

终态分为允许、拒绝、过期和取消。无监听器立即使用默认 `fail-to-deny` resolver；已有监听器但消息未送达时不能据此认定请求自动被拒绝，应由期限与生命周期收敛。关停须处理 queued、showing 及 resolving，不能只取消屏幕上正在显示的一条。

未接耐久 observer 时，Broker 的同步 `resolve` 完成本地决定；接入后其 `true` 只代表受理，不能作为耐久成功证明。生产 binding 使用 `resolveDurably`：相同在途决定等待同一提交，冲突决定不覆盖；提交失败可重新排队，取消／过期与在途用户决定的竞争也须走终结处理。释放 Promise、发已解决通知与继续执行不能早于相应耐久边界。

Hub 的 detach 按取消 pending、取消订阅、清索引处理；当前该方法同步返回，不等待异步耐久终结，因而不能保证这些终结通知仍经 Hub 送达，也不能把清理完成等同于提交完成。耐久完成与恢复须核对 assignment／owner／JobJournal，而非依赖 Hub 的内存索引或 15 秒缓存。

## 决定如何影响执行

- `deny` 抛含用户反馈的 `SecurityBlockError`，经工具错误结果回到模型；理由说明的是当前工具为何不应执行，不能解释为新的自动授权。
- `cancelled` 拒绝继续该工具；整个 Run 的取消另由[取消控制](../interruption/control-and-feedback.md)负责。
- `expired` 默认拒绝。secure-executor 另支持 `auto-approve-safe`，仅对 `observe/internal` 放行，`external/critical` 仍拒绝；这是实现选项，不代表默认启用或所有宿主都提供配置入口。
- 允许决定通过批准端口应用作用域与审计；逐次显式确认工具不能沉淀授权。禁区与信任规则的具体约束归安全／Trust Administration，不由渲染器自行放宽。

“批准时附说明”是旧设计的沟通目标，类型与渲染器支持 `note`，但当前常规请求不生成该选项，不能承诺与拒绝理由对称的完整产品入口及模型反馈。`edit-then-allow` 在执行侧明确拒绝为未实现，不能因为类型存在就认为可编辑后执行。

## 事件与维护边界

Broker 提供 requested、shown、resolved、cancelled、expired、auto-resolved 等事件及血缘；`onResolved` 是本地解决通知出口。事件用于反馈和诊断，不替代耐久日志。RPC 通知统一由 Bridge 投影，渠道发送由文本／渠道宿主负责，不能双发同一通知。

旧稿的批量审批、独立预审批 API、首次项目信任弹窗及未来 Web 界面不作为当前能力。当前信任研判已有自己的实现与文档，不能重复保留旧“Smart 分诊 Phase 3”实施计划。已退出的独立 alt-screen 原型、行数估算及竞品领先宣称不承担现行设计职责；保留的是分层、反馈、安全兜底和交互取舍。
