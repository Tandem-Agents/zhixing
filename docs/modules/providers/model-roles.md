# 模型角色、会话覆盖与推荐

服务商连接解决“如何接入”，用途默认解决“默认用来做什么”，会话选择解决“当前对话临时用什么”。三层单向引用：会话覆盖 → 连接/型号，用途默认 → 连接/型号；连接层与资料目录不得反向改写用户已确认的用途默认或会话选择。

## 三用途分工与调用隔离

- `main` 必填，用于普通主对话及质量敏感的单发任务，也是未单独配置辅助用途时的回落基准。
- `light` 可选，用于段切换摘要、手动 `/compact`、WebFetch 蒸馏与轻推理辅助调用；未配时沿用 `main`。
- `power` 可选，用于工作场景主对话；未配时沿用 `main`。

关键不变量：

- **主循环与辅助用途严格隔离**：普通对话主循环默认跟随 `main`，工作场景主循环默认跟随 `power`（缺省沿用 `main`）；本会话覆盖（`SessionModelSelection`）仅作用于该会话的主循环及未显式指定角色的子执行继承。
- **`light` 绑定单源一致**：自动切段、手动 `/compact`（经 `makeSegmentStreamFactory`）与工具 `ctx.llm.light` 统一走 `resolvedLight` 的完整连接与模型绑定，不再因工作场景 `power` 或主循环本会话覆盖而错发至其他服务商端点。`main=A、power=B、light` 未配时，摘要与 `ctx.llm.light` 均走 `A`；`light` 显式配置出错时产生结构化告警并回落 `main`。
- **辅助调用隔离上下文**：辅助请求不把完整工具材料灌入主对话历史，降低主注意力窗口占用；其输出仍须遵守不可信材料安全边界。

## 会话级选模与持久化

`Session owner` 持久化当前会话的结构化 `SessionModelSelection`（`{ mode: "follow-default" }` 或 `{ mode: "override", connectionId, model, params? }`），通过 `session.getModelSelection` / `session.setModelSelection` 暴露，取代旧裸字符串 `mainModelOverride`：

- 切模前由宿主 `ModelRuntimePort` 执行预检（连接就绪、能力门控、已有图片材料兼容、未完工具往返强制签名冲突）；不兼容时诚实阻断并保留原选择与草稿。
- 交互 `/model` 的普通确认只更新本会话覆盖，不修改全局 `main / light / power` 默认；“设为用途默认”与“恢复跟随默认”均为独立显式动作，且在普通对话默认聚焦 `main`、工作场景默认聚焦 `power`。
- 不换模型原位调参时，按目标型号已注册的 `ThinkingControl` 重建合法控件，并要求用户明确选择“仅本会话”或“写入对应用途默认”；换型号遇旧参数不兼容时说明原因并按新型号重建控件。
- 跨会话或另一接入面修改会话选模后，经 `session.changed(modelSelection)` 同步刷新 `ReplLocalView`、状态栏、`/status` 与文本 `/model`。

## 首次引导与常规配置边界

- **首次引导（缺失 `main`）**：选预设/自定义/本地免密（如 Ollama）→ 补必要凭据（免密跳过密钥）→ 发现/选填型号 → 点击“完成”在同次保存中自动绑定为 `main` 默认。
- **常规 `/config` 新增或修改连接（已有 `main`）**：保存仅更新连接本身，**绝不覆盖既有 `main / light / power` 默认**；改绑默认始终是独立显式操作。

## 推荐属于单一策展目录的产品选择

用途推荐钉死一对 `(presetId, modelId)`，由单一策展目录（`CuratedCatalogBundle.recommendations`）经 `ModelCatalogPort.getRoleRecommendation` 与 `getCuratedRecommendations` 统一供给；`ROLE_RECOMMENDATIONS` 仅为其随包派生视图：

- 推荐用于 `/model` 置顶提示与首配引导，不构成可请求模型的白名单，也不得随目录刷新静默改写用户既有用途默认。
- 默认值显示、预览检查、完成写入与运行解析均消费同一规则源（`model-configuration-check.ts`、`model-display-projection.ts`、`resolve.ts`）。

## 实现入口

- [角色定义](../../../packages/providers/src/role-spec.ts)、[目录推荐读口](../../../packages/providers/src/catalog-port.ts)、[角色解析](../../../packages/providers/src/resolve.ts)、[实例工厂](../../../packages/providers/src/create-provider.ts)
- [Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[推进装配](../../../packages/cli/src/runtime/advancement-model-provider.ts)、[统一生效投影](../../../packages/cli/src/runtime/model-display-projection.ts)
- [交互 `/model`](../../../packages/cli/src/terminal/model-command.ts)、[运行体消费](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)
