# 模型 Budget 解析架构

## 一、问题

启动 CLI 时第一行打印的警告误导用户怀疑模型未加载：

```
[zhixing] Model "Pro/MiniMaxAI/MiniMax-M2.5" not found in provider "siliconflow";
          using first declared model "unknown" as fallback.
```

模型本身工作正常——LLM 实际请求用的是 `Pro/MiniMaxAI/MiniMax-M2.5`，文案里的 `"unknown"` 只是 ContextEngine budget 解析路径里的伪占位。但这条 warning 暴露了更深的架构问题。

## 二、根因（架构层）

`LLMProvider.models[]` 是**身份混淆**字段——同时承担三个相互冲突的角色：

| 期望角色 | 实际语义 | 矛盾点 |
|---|---|---|
| Provider 能力声明 | "我支持哪些 model" | 网关型 provider（OpenAI 兼容、聚合站、私有部署）一个实例承载海量 model，无法预先列举 |
| Budget 数据源 | "model X 的 contextWindow 多少" | 跟"能力声明"绑死后，必须造伪条目才能"非空" |
| 类型契约 `readonly ModelInfo[]` | 永远非空数组 | 强制 adapter 把 `defaultModel ?? "unknown"` 塞进去 |

模型 budget 信息（`contextWindow / maxOutputTokens`）的**所有权**没有清晰归属：
- 不是 provider 实例（一个实例服务多 model）
- 不是用户配置（`modelOverrides` 太苛刻——每个 model 都要配）
- 不是 model 自己（id 只是字符串，没有元数据载体）

→ 各方相互推诿，最终 adapter 只能伪造，文案只能误导。

## 三、设计目标

- **INV-A** 单职责清晰：每个字段只承担一个语义角色
- **INV-B** 网关型 provider 开箱即用，不强制每 model 写 modelOverrides
- **INV-C** 不出现伪占位（`"unknown"` 字符串污染）；缺失就是缺失
- **INV-D** 用户配置始终是最高优先级
- **INV-E** core 不反向依赖 providers 包（不知道 protocol 字符串）
- **INV-F** 扩展点清晰：未来加新 provider / 新 model / 远程 catalog 不重构

## 四、解决方案

### 4.1 把"catalog"和"budget 默认"显式拆成两个职责

`LLMProvider.models[]` 收紧为 **declared catalog**——provider 实例上元信息已知的 model 列表。语义不变量：

- **可以为空数组**：网关型 provider 自然 `[]`，绑定型 provider 列出已知 model
- **不得包含占位条目**：`id="unknown"` 这种伪条目违反契约
- **不是硬约束**：`chat({ model })` 接受任何字符串，catalog 之外的 model 也能正常请求 LLM
- **唯一用途**：给上下文工程的 budget 解析提供数据

新增 `PROTOCOL_BUDGET_DEFAULTS`（`packages/providers/src/protocol-defaults.ts`）作为协议族级 budget 兜底，独立于 catalog：

```typescript
export const PROTOCOL_BUDGET_DEFAULTS: Record<Protocol, ModelBudgetInfo> = {
  "openai-compatible":  { contextWindow: 128_000, maxOutputTokens: 4_096 },
  "anthropic-messages": { contextWindow: 200_000, maxOutputTokens: 8_192 },
};
```

数据所有权清晰：协议是 providers 包私有的概念；默认值是协议族级工程经验值，与具体 provider 无关。

### 4.2 Budget 数据源四层（高 → 低）

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 4 — Consumer (cli/run-agent.ts)                       │
│   resolveModelInfo({ ...4 个数据源 }) → ModelBudgetInfo      │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┬─────────────────────┐
        ▼                  ▼                  ▼                     ▼
   ① modelOverrides    ② declared catalog   ③ protocolDefaults   ④ CONSERVATIVE_FALLBACK
   (用户精确)          (preset 内置)         (协议族级别)          (32K/4K, defensive)
```

| # | 数据源 | 谁拥有 | 何时使用 |
|---|---|---|---|
| ① | `modelOverrides[modelId]` | 用户 `ZhixingConfig.providers.<id>.modelOverrides` | 用户为特定 model 精调 budget |
| ② | `provider.models.find(id===)` | preset.knownModels | catalog 命中 |
| ③ | `protocolDefaults[protocol]` | `PROTOCOL_BUDGET_DEFAULTS` | 网关型 provider catalog 未命中时的协议级兜底 |
| ④ | `CONSERVATIVE_FALLBACK` | core | 调用方未注入 protocolDefaults 时的 defensive 兜底，生产路径不应触达 |

关键变化：**删除**旧实现里"`providerModels[0]` 当 fallback"分支——这是误导文案的源头。catalog 不命中就走协议级默认或 defensive 兜底，不再用列表第一个伪占位。

### 4.3 catalog 内嵌策略：当前所有 preset 都不内嵌

`ProviderPreset.knownModels?` 字段保留为可选扩展点，但**当前所有 preset 都不内嵌 catalog**。

最初的设想是"绑定型 provider 适合补 catalog"（如 anthropic 的 claude-* 系列），但实际审视发现该论据有缺陷——**真正的边界不是"绑定 vs 网关"，而是"catalog budget 与 protocol-default 是否显著不同"**：

- Claude 4.x 全系都是 200K/8K，跟 `PROTOCOL_BUDGET_DEFAULTS["anthropic-messages"]` 一致
- catalog 命中和走 protocol-default 产出**完全相同**的 ModelBudgetInfo
- `supportsThinking / supportsTools / supportsImages` 等装饰字段在生产代码无消费者
- 内嵌 catalog 引入"model id 跟随版本变化"的维护债（旧 ID 失效、新 ID 漏补），却没换来运行时价值

所以 preset 回归"稳定连接元信息"（baseUrl/envKey/quirks）的纯净定位。所有 model 都走 `modelOverrides → protocol-default → fallback` 路径。

未来真有 model 的 budget 跟 protocol-default 显著不同（如 1M context 变体），届时**为该特定 model** 补 catalog 才有意义；用户的精调诉求由 `modelOverrides` 已经覆盖。

### 4.4 跨包数据流

```
preset.knownModels: readonly ModelInfo[]
    │
    ▼
resolveProvider(...)
    │
    ▼
ResolvedProvider.declaredModels: readonly ModelInfo[]
    │
    ├──→ adapter (createOpenAICompatibleProvider / createAnthropicProvider)
    │       └──→ LLMProvider.models = provider.declaredModels  (零 mapping)
    │
    └──→ resolveLLMRoles → ResolvedLLMRoles
            └──→ createProviderRoles 返回 resolvedRoles 字段
                    └──→ cli/run-agent.ts 读 resolvedRoles.main.resolved.protocol
                            └──→ PROTOCOL_BUDGET_DEFAULTS[protocol] → core/resolveModelInfo
```

`ModelInfo` 在三层（preset / ResolvedProvider / LLMProvider）共用同一个类型，无中间转换：

- `ModelInfo` 不含 `provider` 字段——provider 归属由结构隐含（model 嵌套在 LLMProvider.models[] 内），独立携带是反范式冗余
- adapter 工厂直接 `models: provider.declaredModels`，无 mapping 装饰代码
- model-level capability（`supports*` 等可选字段）跟 provider-level `quirks` 概念上不同维度，不互相 fallback

`createProviderRoles` 返回结构非破坏扩展：`{ roles, config }` → `{ roles, config, resolvedRoles }`。`resolvedRoles` 暴露配置层中间产物，让 CLI 能读 protocol——这些信息原本被埋在 LLMProvider 实例里不可见。

### 4.5 单向依赖保持

`core ← providers ← cli` 单向依赖不变：
- **core** 的 `resolveModelInfo` 接收 `protocolDefaults: ModelBudgetInfo`，不感知 protocol 字符串
- **providers** 拥有 `Protocol` 类型与 `PROTOCOL_BUDGET_DEFAULTS` 表
- **cli** 从 `resolvedRoles.main.resolved.protocol` 查表后注入给 core

## 五、修改范围

| 包 | 文件 | 改动 |
|---|---|---|
| core | `src/types/llm.ts` | 删除 `ModelInfo.provider` 反范式冗余字段；更新 `LLMProvider.models` 注释——明确为 declared catalog，可空，禁占位 |
| core | `src/context/model-info-resolver.ts` | 增 `protocolDefaults` 入参；新增 `protocol-default` source；删除 `providerModels[0]` 兜底分支；warning code 收敛为单一 `USING_FALLBACK` |
| core | `src/context/__tests__/model-info-resolver.test.ts` | 覆盖 declared / protocol-default / override 与各数据源组合 / fallback defensive 路径 |
| core | `src/loop/mock-provider.ts` / `src/__tests__/interrupt-stress.test.ts` | fixture 删 `provider` 字段同步 |
| providers | `src/types.ts` | `ProviderPreset.knownModels?: readonly ModelInfo[]`；`ResolvedProvider.declaredModels: readonly ModelInfo[]`（直接复用 core ModelInfo，不另起 KnownModelInfo 子类型） |
| providers | `src/protocol-defaults.ts` | **新建** `PROTOCOL_BUDGET_DEFAULTS` |
| providers | `src/presets.ts` | 不内嵌 catalog；`knownModels` 字段保留作扩展点 |
| providers | `src/resolve.ts` | `resolveProvider` 把 `preset.knownModels` 写入 `ResolvedProvider.declaredModels` |
| providers | `src/adapters/openai-compatible.ts` / `anthropic-messages.ts` | `models: provider.declaredModels` 直接复用，零 mapping |
| providers | `src/create-provider.ts` | `ProviderRolesResult` 新增 `resolvedRoles` 字段（非破坏扩展） |
| providers | `src/index.ts` | 导出 `PROTOCOL_BUDGET_DEFAULTS` / `ProviderRolesResult` |
| providers | `src/__tests__/openai-compatible.test.ts` / `anthropic-messages.test.ts` | 测网关型默认 `models=[]`；测 declaredModels 直接复用（`expect(models).toBe(declared)`） |
| providers | `src/__tests__/llm-roles.test.ts` | 测 `resolvedRoles` 暴露；测网关型 provider 的空 catalog 路径 |
| cli | `src/run-agent.ts` | 解构 `resolvedRoles`；调 `resolveModelInfo` 时注入 `PROTOCOL_BUDGET_DEFAULTS[protocol]` |

## 六、验证

### 6.1 用户报告场景（修复前 → 修复后）

用户配置（`~/.zhixing/config.json`）：

```json
{
  "llm": { "main": { "provider": "siliconflow", "model": "Pro/MiniMaxAI/MiniMax-M2.5" } },
  "providers": { "siliconflow": { "apiKey": "env:SILICONFLOW_API_KEY" } }
}
```

| 路径 | 修复前 | 修复后 |
|---|---|---|
| 启动 warning | `Model "..." not found in provider "..."; using first declared model "unknown" as fallback.` | 无 |
| `LLMProvider.models` | `[{id: "unknown", contextWindow: 128_000, ...}]`（伪占位） | `[]`（catalog 空，合法） |
| ContextEngine budget | 128K/4K（来自 adapter 硬编码，巧合可用） | 128K/4K（来自 `PROTOCOL_BUDGET_DEFAULTS["openai-compatible"]`，明确来源） |
| LLM 实际请求 | `Pro/MiniMaxAI/MiniMax-M2.5` 透传 | 同左，零变化 |

用户想精调到 MiniMax-M2.5 真实 245K 上下文，仍然走已有的 `modelOverrides`：

```json
"providers": {
  "siliconflow": {
    "apiKey": "env:SILICONFLOW_API_KEY",
    "modelOverrides": {
      "Pro/MiniMaxAI/MiniMax-M2.5": { "contextWindow": 245760, "maxOutputTokens": 8192 }
    }
  }
}
```

### 6.2 测试

- `core` 1832 通过（`model-info-resolver.test.ts` 12 个用例覆盖四层数据源）
- `providers` 84 通过（adapter 测试覆盖 catalog 空/非空两态；llm-roles 测试覆盖 resolvedRoles）
- `cli` 538 通过（无 mock 破坏）
- `server` 477 通过（不受影响）

## 七、不变量与回归保护

| 不变量 | 验证 |
|---|---|
| INV-A 单职责清晰 | `models[]` 仅 catalog；`PROTOCOL_BUDGET_DEFAULTS` 独立字段 |
| INV-B 网关型开箱即用 | siliconflow 用任意 model 走 protocol-default 128K，无 warning |
| INV-C 无伪占位 | adapter 不再造 `id="unknown"` 条目 |
| INV-D 用户最高优先级 | `modelOverrides` 仍是第一层，未动 |
| INV-E core 单向依赖 | core 只接收 `ModelBudgetInfo` 形状的 `protocolDefaults` |
| INV-F 扩展点清晰 | 加 preset / protocol / 远程 catalog 都非侵入 |
| 已有 modelOverrides 配置 | 完全兼容，未动 |
| `LLMProvider.models[]` 类型 | `readonly ModelInfo[]` 不变（仅放松"必非空"的隐式契约） |
| `chat()` 调用 | `request.model` 透传，零行为变化 |
| `createProviderRoles` 调用方 | 解构 `{ roles, config }` 仍工作（新字段 ignore） |

## 八、已知边界

- `CONSERVATIVE_FALLBACK` 在新架构下退化为 defensive 兜底——调用方正常注入 `protocolDefaults` 时永不命中。保留以承担调用方契约违约时的健壮性，文档明确其"生产路径不应触达"定位。
- 当前所有 preset 都不内嵌 catalog；`knownModels` 字段保留作扩展点。理由见 §4.3：当前 model budget 跟 protocol-default 一致时，内嵌 catalog 是负维护无价值。
- `ModelInfo.supportsThinking / supportsTools / supportsImages` 字段是 model-level capability schema，当前生产路径未消费——保留作扩展点（未来 model picker / capability 路由场景）。注意：与 `ProviderQuirks.supports*` 不同维度——quirks 是 provider-level 行为差异，capability 是 model 自身能力，**不互相 fallback**。

## 九、未来演进路径（不在本期）

- **provider-level budget default**：如果未来某 OpenAI 兼容 provider 默认 budget 显著低于 128K（如某代理只到 32K），可在 `ResolvedProvider` 加 `providerBudgetDefault?` 字段，插入到 `protocol-default` 之上一层
- **远程 catalog**：未来要从 LiteLLM / OpenRouter 等远程 catalog 拉 model 元信息，CLI 在调 `resolveModelInfo` 前把远程数据合并到 `declaredModels` 即可，无需重构 core resolver
- **可插拔 ModelCatalog**：把 model catalog 抽成 `interface ModelCatalog { lookup(...): ModelInfo | undefined }`，链式合成多个实现（builtin / config / http）。这是 systemic upgrade，等真有多源 catalog 需求时再做
