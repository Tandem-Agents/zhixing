# 模型元信息、三层合成与预算解析

模型能否请求、元信息是否已知、哪些限制不可突破、用户偏好如何保留，是四个独立问题。目录未收录不阻止请求，也不会伪造未知型号规格；覆盖不可突破硬约束；目录更新绝不抹除用户偏好。

## 单一资料源与隔离发现缓存

- **单一策展目录（`CuratedCatalogBundle`）**：内置 11 项预设、型号规格、思考控件、参考价格口径、生命周期状态、用途推荐与经验注意力阈值统一存放在单一策展源中，由 `ModelCatalogManager` 经受限 TUF 客户端验签后原子激活，并通过 `ModelCatalogPort` 供给后端、配置编辑器与 `/model`。`PROVIDER_PRESETS`、`ROLE_RECOMMENDATIONS`、`MODEL_CAPABILITIES` 与终端 `SUPPORTED_PROVIDERS` 均为同一源的派生视图，不再各自手工维护副本。
- **原生发现与隔离缓存（`ModelDiscoveryCache`）**：各预设按已核实原生发现模板执行只读模型发现（含 Ollama 本地推理与原生路径归一、自定义基路径保留、可选兼容探测），脱敏结构化结果独立存放在 `<ZHIXING_HOME>/cache/model-discovery-cache.json`，按 `connectionId + endpoint + adapter + credentialRevision` 分区隔离，绝不写入 `config.jsonc` 或 `SecretStore`。过期缓存仅标注“上次结果/待刷新”，不充当永久禁用权威；发现结果与可选自愿生成验证严格分态。

## 硬约束 / 资料 / 偏好三层合成

`synthesizeConnectionModels` 对每条连接执行统一三层合成，并为每个关键字段保留来源标注（`user-override` / `native-discovery` / `curated-catalog` / `builtin-baseline` / `unknown`）：

1. **硬约束层（不可突破）**：本地已实现协议与能力门控（`requiresUpgrade`）、已确认权威原生直连上限与否定能力。用户 `modelOverrides` 若试图突破权威硬约束，系统保留用户原输入以便查看与编辑，同时产出结构化 `overrideConflicts` 并在运行侧按硬约束钳制有效值。第三方聚合端（如 OpenRouter）或未核实改址连接的发现字段归入资料层，不作硬约束。
2. **资料层（按字段独立合成）**：顺序为 `connection.modelOverrides[model]` → 当连接原生发现 → 官方策展目录 → 随包基线 → 未知。缺省字段不抹除已有值，显式 `false` 保留否定语义；无法确认时明示“资料不足/未知”，不瞎编默认值。
3. **偏好层（不受目录刷新改写）**：
   - `customModels`：用户自建型号列表，支持在 `/config` 中增、重命名（同步迁移覆盖与用途引用）与删。
   - `modelOverrides`：按连接内精确 `modelId` 覆盖上下文窗口、最大输出、图片/工具/思考能力与思考控件；编辑页删除覆盖前，经 `previewModelOverrideRestore` 明示删除后每个字段将恢复的上游具体值与来源，绝不误删供应方型号条目。
   - `hiddenModels`：用户隐藏的供应方型号列表，目录/发现刷新绝不复活；连接详情页与 `/model` 末尾均提供“已隐藏型号（N）”折叠入口支持一键恢复显示。

## 结构化非对话过滤与生命周期

- 仅当存在明确结构化非对话断言（如 `purpose !== "chat"`、`outputModalities`、`nativeType/subType`、`supportedGenerationMethods`）时过滤非对话模型；严禁按模型名称关键字启发式误杀对话型号。
- 已弃用（`deprecated`）、已停供（`retired`）与需升级（`requiresUpgrade`）条目在列表中清晰标注；当前正在使用的不可用项在 `/model` 与 `/config` 均保留可见并说明原因与修正路径，不静默消失。

## 预算与不同能力的职责边界

`resolveModelInfo` 按以下顺序解析 `contextWindow / maxOutputTokens`：

1. 当前连接经三层合成后的 `modelOverrides` / 原生发现 / 策展目录精确匹配值（受硬约束钳制）。
2. 调用方注入的协议族兜底（`protocol-defaults.ts`）。
3. core 防御性默认（32,000 / 4,096，带 `USING_FALLBACK` 告警）。

| 数据 | 当前来源与含义 |
|---|---|
| 总窗口／最大输出 | 三层合成规格 → 协议默认 → core 防御默认；描述物理容量，不等于每次请求输出限额或长上下文质量 |
| 注意力阈值 | `llm.attentionPolicies`（及旧 `modelCapabilityOverrides`）→ 单一目录 `attentionThresholds` → `UNKNOWN` 兜底；按归一化模型键匹配，供上下文管理消费 |
| 图片输入能力 | 连接三层合成 `supportsImages`（含用户覆盖与权威否定硬约束）→ `false`；供发送与切模预检 |
| 思考控制 | 连接三层合成 `thinkingControl` 描述合法形态（`toggle` / `effort` / `budget`），用途默认或会话覆盖保存用户选择，适配器按方言发送；见[思考控制](thinking-control.md) |

## 实现入口

- [三层合成引擎](../../../packages/providers/src/catalog/synthesis.ts)、[单一策展目录读口](../../../packages/providers/src/catalog-port.ts)、[维护手册](catalog-maintenance-runbook.md)
- [原生发现与隔离缓存](../../../packages/providers/src/discovery/discovery-cache.ts)、[预算解析](../../../packages/core/src/context/model-info-resolver.ts)、[协议默认](../../../packages/providers/src/protocol-defaults.ts)
- [覆盖恢复预览与状态编辑](../../../packages/cli/src/config-editor/state.ts)、[宿主解析与注入](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)
