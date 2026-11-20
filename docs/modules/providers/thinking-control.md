# 模型思考控制

思考控制按用途默认或本会话覆盖独立保存，由模型原生能力决定合法控件形态；绝不把不同厂商的开关、离散 effort 与 token 预算强行等价映射。未配置就不发送显式覆盖参数，避免系统替用户臆造参数。

## 职责与传输

`llm.<role>.params.thinking / SessionModelSelection.params.thinking → 宿主校验与 roleThinking → 主循环 / 单发 / 摘要请求 → ChatRequest.thinking → 四协议适配器方言参数`

- 用途默认按 `main / light / power` 分别保存；普通主对话跟随 `main`、工作场景跟随 `power`（缺省沿用 `main`）；`light` 与自动/手动段摘要统一消费 `resolvedLight` 的独立绑定与思考设置，不随主会话覆盖错发端点。
- 单一策展目录（及用户 `modelOverrides`）经 `ThinkingControl` 声明 `none`、`toggle`、`effort`（保留原值枚举与默认档）或 `budget`（可选区间），共同驱动 `/config`、交互 `/model` 原位调参与宿主 `validateThinkingConfig`。
- 适配器不读配置文件，按连接解析后的 `thinkingDialect` 与协议适配将已校验的 `ChatRequest.thinking` 转换为原生请求字段。

## 当前四协议与方言发送形态

| 协议 / 方言 | 当前实现 |
|---|---|
| `openai-compatible` · DeepSeek | `off/on` 写 `thinking.type`；`effort` 额外写 `reasoning_effort` 原值 |
| `openai-compatible` · Qwen | `off/on` 写 `enable_thinking`；`budget` 额外写 `thinking_budget` |
| `openai-compatible` · GLM / Kimi | `off/on` 写 `thinking.type`；不支持的形态不臆造发送 |
| `anthropic-messages` · Anthropic | 按模型声明支持 `effort`（Claude 4.7 自适应/强度）与 `budget`（`enabled + budget_tokens`）及 `off`；带签名历史按来源隔离保真重传，见 [Anthropic 适配](anthropic-adapter.md) |
| `openai-responses` | `reasoning.effort` + `reasoning.encrypted_content`（同来源同协议窄发送视图前缀保真，跨连接/改址不转发） |
| `google-interactions` | `thinking_level` / `thinking_budget` 与无状态 `thought` step（同来源重传，跨源隔离） |
| `none` 或不匹配形态 | 不生成思考参数 |

## 终端配置、原位调参与换模重建

- **原位调参（`/model`）**：直接从当前生效项进入已注册 `ThinkingControl` 控件（支持关闭、开启默认、合法强度档位或区间内自定义预算），并显式选择生效作用域（**仅本会话**或**写入 `main / light / power` 用途默认**）。
- **换模重算（`/model` 与 `/config` 共用 `isThinkingCompatible`）**：切换到新型号时，若旧思考参数与新型号合法形态或范围不兼容，明示不兼容原因、清除旧值并按新型号重建合法控件，杜绝旧档位跨型号残留。
- `supportsThinking` 仅作能力信号，不代替 `ThinkingControl` 合法控件；流式 `thinking` 事件的接收与透传不依赖该粗标。

## 实现入口

- [类型与校验](../../../packages/core/src/types/llm.ts)、[单一策展目录](../../../packages/providers/src/catalog/builtin-catalog.ts)、[方言转换](../../../packages/providers/src/adapters/thinking-params.ts)
- [四协议适配](../../../packages/providers/src/create-provider.ts)、[Kernel 宿主装配](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)
- [交互 `/model` 原位调参](../../../packages/cli/src/terminal/model-command.ts)、[`/config` 思考面板](../../../packages/cli/src/config-editor/model/list.ts)
