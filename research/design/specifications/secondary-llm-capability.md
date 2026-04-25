# 二级 LLM 能力 · 执行规格

> 在会话级（ToolExecutionContext / SessionRuntime）暴露独立的"二级 LLM 角色"，让 I/O 边界净化（上下文压缩 / WebFetch distill / 工具结果摘要 / 子 agent 返回压缩 / 通道入站分类等）不消耗主上下文与主模型成本。本能力**不绑定具体工具**——是会话级共享基础设施。

**实施位置**：Step 21B M0（先于 WebFetch 实施）
**前置依赖**：Phase 5 + Step 21A
**消费者**：上下文压缩（已存在的 `flushCallLLM` callback）+ WebFetch distill（Step 21B M2 新增）+ 未来 WebSearch / MCP 大结果摘要 / 子 agent 返回压缩 / 通道入站分类 / 记忆语义压缩

---

## 〇、概念

### 〇.1 为什么需要"二级"角色

agent 系统中信息进入主上下文之前需要净化：网页正文、工具结果、子 agent 输出、上下文压缩源 message 等通常 50K-200K，但 task-relevant 信号通常 < 5%。直接灌入主上下文会导致：

- token 浪费：主模型按"输入 token"计费整段
- context 污染：噪音留在历史里直到 compaction 截断
- coherence 下降：注意力被无关内容稀释
- 多次 I/O 不可叠加：3 次 fetch + 5 个 MCP 结果迅速吞噬窗口

**二级角色的设计意图：在 I/O 边界做信息净化**。主模型只看 5% 的高密度信号，95% 噪音由二级在边界处压缩剥离。这是 agent 信息流的标准范式（Claude Code WebFetch yaml 描述明示用 small fast model；hermes 用 auxiliary client 处理 task-specific 子任务）。

"便宜"是该角色的**典型属性**而非定义——典型情况选 cost/quality 偏 cost 端的（haiku / gemini-flash），但角色定义与具体模型 ID 解耦：用户也可配 secondary 为强模型用于专业子任务。

### 〇.2 为什么是会话级 capability，不是工具内依赖

把 LLM 注入绑死到工具（如 `createWebFetchTool({ cheapProvider })`）有 3 个问题：
1. **多 consumer 重复**：每个工具自注入 → 配置散落 + 代码重复
2. **配置耦合**：用户改 secondary 模型 ID 要改每个工具的工厂参数
3. **资源浪费**：N 个工具创建 N 个 LLMProvider 实例，连接池 / 限速 / cache 全部独立

升格为**会话级 capability**——`ToolExecutionContext.llm` 注入，所有工具共享同一对实例。这与 21A `BoundaryRegistry` 路径完全对称：自描述工具 + 会话级 capability 注入。

---

## 一、数据模型

### 1.1 配置层（`packages/providers/src/types.ts`）

```typescript
/**
 * 单个 LLM 角色的 provider+model 选择。
 * - provider: 必须是 ZhixingConfig.providers 表中的 key
 * - model: 该 provider 可识别的模型 ID
 */
export interface LLMRoleConfig {
  provider: string;
  model: string;
}

export interface ZhixingConfig {
  /**
   * LLM 角色配置：main 必填，secondary 可缺省走 §二.2 解析链。
   */
  llm: {
    main: LLMRoleConfig;
    secondary?: LLMRoleConfig;
  };

  providers?: Record<string, ProviderConfig>;
  // 其它已有字段（channels / agent / workspace）
}
```

#### `defaultModel` 字段位置区分（M0 实施时按字段所在类型区分处置）

代码中 `defaultModel` 是同名多字段——分布在 4 个不同类型上。本能力**只**替换最顶层的 `ZhixingConfig.defaultProvider` / `ZhixingConfig.defaultModel`；其余 3 个 `defaultModel` 是各自抽象层的合理组件，与本能力正交：

| 字段 | 类型路径 | 处置 | 后续生命 |
|------|---------|------|---------|
| `ZhixingConfig.defaultProvider?` | `providers/types.ts:169` | **删除** | 由 `config.llm.main.provider` 取代 |
| `ZhixingConfig.defaultModel?` | `providers/types.ts:171` | **删除** | 由 `config.llm.main.model` 取代 |
| `ProviderConfig.defaultModel?` | `providers/types.ts:98` | 保留 | 用户对单 provider 的模型覆盖（resolve.ts:79 消费） |
| `ProviderPreset.defaultModel?` | `providers/types.ts:66` | 保留 | preset 默认模型（resolve.ts:79 消费） |
| `ResolvedProvider.defaultModel?` | `providers/types.ts:197` | 保留 | adapter 内部 fallback（adapters/anthropic-messages.ts:40 / openai-compatible.ts:39-40 消费） |

### 1.2 运行时层（`packages/core/src/types/llm.ts`）

```typescript
/**
 * 单个 LLM 角色实例：Provider 实例 + 绑定的 model + 便捷调用方法。
 * caller 也可绕过 chat() 直接调 provider.chat({ ..., model })，但推荐用本接口
 * 减少跨 consumer 的"忘传 model"错误。
 */
export interface LLMRole {
  readonly provider: LLMProvider;
  readonly model: string;
  chat(request: Omit<ChatRequest, "model">): AsyncGenerator<StreamEvent, void, undefined>;
  countTokens?(messages: Message[]): Promise<number>;
}

/**
 * 会话级可用的 LLM 角色集合。
 *
 * 不变量：
 * 1. LLMRoles 一旦构造，roles.main 与 roles.secondary 都必定可调用——secondary
 *    解析失败的所有路径都被 §二.2 step 3 的"降级到 main"覆盖。
 * 2. roles.main.{provider,model} 反映会话**实际使用的** effective state——包含
 *    任何 CLI override（如 --provider / --model）。consumer 读到的就是 runtime
 *    实际跑的 provider+model，不存在 ctx.llm.main 与运行时 split brain 的可能。
 * 3. ToolExecutionContext.llm 字段是 optional——入口正常注入，单测 / 自动化路径
 *    可能不注入。consumer 必须显式分支处理 !ctx.llm（见 §三.3）。
 *
 * Provider 实例复用：当 secondary 与 main 用同一 provider key 时共享 LLMProvider
 * 实例（连接池 / 限速 / cache 共用）。这是优化不是契约——consumer 不应用
 * === 比较 provider 实例。
 */
export interface LLMRoles {
  main: LLMRole;
  secondary: LLMRole;
}
```

### 1.3 ToolExecutionContext 扩展（`packages/core/src/types/tools.ts:128`）

```typescript
export interface ToolExecutionContext {
  // 已有字段（workingDirectory / abortSignal / turnId / emissionTarget /
  //          commitToUser / turnOrigin）

  /**
   * 当前会话可用的 LLM 角色实例。入口（cli/run-agent / serve session-adapter）
   * 通过 createProviderRoles 创建并注入。
   *
   * consumer 必须显式分支处理 ctx.llm === undefined：推荐 graceful degrade
   * （如 WebFetch 退回 raw markdown），强依赖 LLM 的工具应在
   * ToolDefinition.description 标注依赖并返回明确 isError ToolResult。
   * 见 §三.3 与 ADR-SLLM-006。
   */
  llm?: LLMRoles;
}
```

---

## 二、解析链路

### 2.1 main 角色解析

**基础（必填）**：`config.llm.main` 提供 provider 与 model。缺失 → 抛 `ProviderConfigError`（fatal，session 不应启动）。

**CLI override**：

| 来源 | 作用 |
|------|------|
| `options.providerOverride`（CLI `--provider`） | 替换 main role 的 provider；model 自动跟随新 provider 的预设默认（除非也提供了 `--model`） |
| `options.modelOverride`（CLI `--model`） | 替换 main role 的 model（最高优先） |

**解析顺序**：

```
finalProvider = options.providerOverride ?? config.llm.main.provider
resolved      = resolveProvider(finalProvider, config.providers?.[finalProvider] ?? {}, env)

if options.modelOverride:          // 最高：显式 --model
  finalModel = options.modelOverride
elif options.providerOverride:     // 中段：--provider 单独 → 跟随新 provider 预设默认
  finalModel = resolved.defaultModel
               ?? throw ProviderConfigError(
                    `--provider "${finalProvider}" requires --model: provider has no ` +
                    `default model in preset or providers.${finalProvider}.defaultModel`)
else:                              // 默认：config 原值
  finalModel = config.llm.main.model

→ roles.main = { provider: createFromResolved(resolved), model: finalModel, chat, countTokens? }
```

设计要点：
- `--provider X` 单独使用时 model 跟随 X 的预设默认——保持现有 CLI 人体工学（如 `--provider deepseek` 直接拿 deepseek 默认模型，不必再加 `--model`）
- `--model` 最高优先——用户显式指定永远生效
- 三段优先级互不干涉：`--provider X --model Y` = X+Y 组合（语义错配的组合留给 runtime 检测）

`secondary` 总是按 §二.2 解析链，不受 main override 影响——`--provider X` 临时换主模型不会牵动 secondary 的 cost/quality 选择。`createProviderRoles({ providerOverride?, modelOverride? })` 是 main 解析的入口。

### 2.2 secondary 角色解析

```
1. config.llm.secondary 显式设置
   → resolveProvider(secondary.provider, providers[secondary.provider] ?? {}, env)
     成功 → 使用
     任意错误 → 抛 ProviderConfigError（用户显式配置必须 fail-fast，不允许"显式
                配错也帮你降级"的隐晦语义）
2. config.llm.secondary 缺省 → 尝试内置默认 SECONDARY_DEFAULT
   → SECONDARY_DEFAULT = { provider: "anthropic", model: "claude-haiku-4-5-20251001" }
   → try { resolveProvider("anthropic", providers["anthropic"] ?? {}, env) }
     成功 → 使用 SECONDARY_DEFAULT（providers map 缺 anthropic 条目时回退到 {} 后
            依赖 anthropic preset 的 baseUrl/protocol/envKey 解析；ANTHROPIC_API_KEY
            环境变量存在或 providers.anthropic.apiKey 配置可解析即成功）
     任意错误（apiKey 不可解析 / 自定义 protocol 或 baseUrl 非法）→ 落入 step 3
3. 内置默认不可达 → secondary 角色降级使用 main 实例 + main.model
   → 启动时一次 INFO 日志：
     "Secondary LLM role degraded to main; configure llm.secondary to enable
      I/O boundary distillation"
```

step 2 用 try/catch 而非"providers map 有 anthropic 条目"的字段存在性检查——避免 user 配 `apiKey: "env:WRONG_VAR"` 但 WRONG_VAR 缺失这种 false positive，让可恢复的"降级"问题不被伪装成 fail-fast 错误。

### 2.3 Provider 实例复用

```
mainProvider = createFromResolved(resolveProvider(main.provider, ...))

if secondary 走 step 1/2 解析:
  if secondary.provider === main.provider:
    secondary.provider = mainProvider 实例（共享）
    secondary.model = secondary.model
  else:
    secondary.provider = createFromResolved(resolveProvider(secondary.provider, ...))

if secondary 走 step 3 降级:
  secondary.provider = mainProvider（同一实例）
  secondary.model = mainModel
```

---

## 三、注入与消费

### 3.1 入口工厂

`packages/providers/src/create-provider.ts` 新增：

```typescript
export function createProviderRoles(
  options: {
    /** CLI override：替换 main role 的 provider（来自 --provider flag）。secondary 不受影响。 */
    providerOverride?: string;
    /** CLI override：替换 main role 的 model（来自 --model flag）。secondary 不受影响。 */
    modelOverride?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
  } = {},
): { roles: LLMRoles; config: ZhixingConfig };
```

设计要点：CLI override 直接在工厂内吸收，让 `roles.main.{provider,model}` 始终反映会话实际使用的 effective state——任何 ctx.llm.main consumer 读到的就是 runtime 跑的同一对值，不存在 capability 与 runtime 脱节的可能。返回值同时含 config，便于 caller 继续使用其它 config 字段（providers / channels / agent / workspace）。

### 3.2 cli 入口装配（`packages/cli/src/run-agent.ts`）

入口共 6 个站点（1 entry + 4 main role 消费点 + 1 ctx 注入）。`createProviderRoles` 在 entry 处吸收 CLI override（`options.provider` → `providerOverride`；`options.model` → `modelOverride`），下游所有站点统一从 `roles.main.*` 读取——不再保留 `const model = options.model ?? defaultModel` 这条本地变量。

| # | 位置 | M0 形态 | 角色 |
|---|------|---------|------|
| 0 | `run-agent.ts:199` | `const { roles, config } = createProviderRoles({ providerOverride: options.provider, modelOverride: options.model })` | entry |
| 1 | `run-agent.ts:289-294` | `resolveModelInfo({ providerId: roles.main.provider.id, model: roles.main.model, providerModels: roles.main.provider.models, overrides: config.providers?.[roles.main.provider.id]?.modelOverrides })` | main |
| 2 | `run-agent.ts:305-321` | `flushCallLLM` 闭包改用 `roles.secondary.chat({ messages, tools: [], abortSignal })`；同步删除 `run-agent.ts:329` 的 `// 未来可通过 ZhixingConfig 配置 compactionModels 拆分` 注释 | **secondary** |
| 3 | `run-agent.ts:343-346` | AgentRuntime 返回对象同时含 `providerId: roles.main.provider.id` 与 `model: roles.main.model`——两字段都反映 effective state（含 CLI override） | main |
| 4 | `run-agent.ts:599-613` | `runAgentLoop({ provider: roles.main.provider, model: roles.main.model, ... })` | main |
| 5 | ToolExecutionContext 工厂 | 创建 ctx 时注入 `llm: roles` | both |

> 站点 2 是关键的语义变化——上下文压缩（MemoryFlush 与 LLMSummarize 两个策略的 callback）从 main 切换到 secondary：
>
> ```typescript
> const flushCallLLM = async (
>   msgs: Message[],
>   opts?: { abortSignal?: AbortSignal },
> ): Promise<string> => {
>   const chunks: string[] = [];
>   for await (const event of roles.secondary.chat({
>     messages: msgs,
>     tools: [],
>     abortSignal: opts?.abortSignal,
>   })) {
>     if (event.type === "text_delta") chunks.push(event.text);
>   }
>   return chunks.join("") || "[]";
> };
> ```

间接受益（无需直接修改）：
- `packages/cli/src/serve/command.ts`：通过 `createAgentRuntime` 工厂调用，自动传导
- `packages/cli/src/serve/session-adapter.ts`：通过工厂注入消费

### 3.3 工具消费的 `!ctx.llm` 处理契约

工具调 `ctx.llm` 时**必须显式分支处理** `!ctx.llm`：

```typescript
// WebFetch 工具内部
async call(input, ctx) {
  const fetched = await safeFetch(input.url, ...);
  const sanitized = sanitizeUntrustedText(...);

  // ctx.llm 缺失 OR input.prompt 缺失 → 返回 raw markdown
  if (!ctx.llm || !input.prompt) {
    return { content: `Source: ${input.url}\n\n${sanitized}`, isError: false };
  }

  // 主路径：secondary 蒸馏
  const chunks: string[] = [];
  for await (const event of ctx.llm.secondary.chat({
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: buildDistillPrompt(input.url, sanitized, input.prompt),
    }],
    abortSignal: ctx.abortSignal,
  })) {
    if (event.type === "text_delta") chunks.push(event.text);
  }
  return { content: `Source: ${input.url}\n\n${chunks.join("")}`, isError: false };
}
```

策略由工具自定，但**必须显式表态**：

- **graceful degrade**（推荐默认）：如 WebFetch 退到 raw markdown / 未来 WebSearch 退到 raw snippets
- **明确 error**：当工具核心价值就是 LLM 调用（假设的 `translate_text` / `classify_intent` 等强依赖 LLM 的工具），返回 `{ isError: true, content: "<reason>" }`，并在 `ToolDefinition.description` 标注 LLM 依赖

**禁止模式**：
- silent return（看似成功实则啥也没干）—— 隐藏故障
- 抛 throw 给 secure-executor 通用 catch —— 失去 cause 信息

---

## 四、Consumer

| Consumer | Role | 实施时机 | 触发条件 / 备注 |
|----------|------|---------|----------------|
| 上下文压缩（MemoryFlush + LLMSummarize 策略的 flushCallLLM 路径） | secondary | M0 站点 2 | `MemoryFlushStrategy` priority 3 / `LLMSummarizeStrategy` priority 200，由 ContextEngine 调度 |
| WebFetch distill | secondary | Step 21B M2 | 用户传 `input.prompt` 时触发；`!ctx.llm` 时退到 raw markdown |
| WebSearch 后处理 | secondary | Step 21B 之后 | search snippet 合并 + 提炼 |
| MCP 大结果摘要 | secondary | MCP step | tool result > N tokens 时自动 distill |
| 子 agent 返回压缩 | secondary | Step 21 子 agent 底座 | sub-agent 完成后 summarize 给父 agent |
| 通道入站分类 | secondary | Step 22 路由 | 入站消息选择 agent 时的轻量分类 |
| **不在 secondary 范围**| - | - | 主对话循环 / complex reasoning / 用户面对的最终输出（一律 main） |

---

## 五、与已落地组件的关系

**接口与类型层**：

| 组件 | 关系 |
|------|------|
| `LLMProvider` 接口（`core/types/llm.ts:170`） | 不修改；secondary 仍是 LLMProvider 实例 |
| `LLMRole` / `LLMRoles`（`core/types/llm.ts`） | 新增（§一.2） |
| `ToolExecutionContext`（`core/types/tools.ts:128`） | 加 `llm?: LLMRoles` 字段 |
| `ZhixingConfig`（`providers/types.ts:167`） | 删顶层 `defaultProvider` / `defaultModel`；新增 `llm: { main, secondary? }` 子块 |
| `LLMRoleConfig`（`providers/types.ts`） | 新增（§一.1） |
| `ProviderConfig.defaultModel?` / `ProviderPreset.defaultModel?` / `ResolvedProvider.defaultModel?` | 不变（不属于本能力 scope，详见 §一.1 字段位置区分表） |

**工厂层**：

| 函数 | 状态 | 说明 |
|------|------|------|
| `createProviderRoles(options)` | 新增 | §三.1 |
| `createProvider(config, providerId?, env?)` | 自身代码不修改 | 内部仅调 `resolveFromConfig`，行为随后者迁移自动传导 |
| `createProviderDirect(providerId, ProviderConfig?, env?)` | 不变 | 不接受 ZhixingConfig，与本能力正交 |
| `createProviderFromConfig(options)` | 删除 | 被 `createProviderRoles` 完全替代 |

**解析层**：

| 函数 | 修改 |
|------|------|
| `resolveProvider(...)` | 不变 |
| `resolveFromConfig(config, providerId?, env?)` | 内部 2 处：(1) line 92 `id = providerId ?? config.defaultProvider` → `id = providerId ?? config.llm.main.provider`，错误信息文案同步更新（见 §七 M0.2 错误文案）；(2) 删除 line 103-104 的 `if (!resolved.defaultModel && config.defaultModel) { ... }` 整段 |
| `resolveLLMRoles(config, options, env)` | **新增**——纯配置层；实现 §二.1（main 三段优先级）+ §二.2（secondary 解析链），返回 `{ main: { resolved: ResolvedProvider, model }, secondary: { resolved: ResolvedProvider, model } }`。**不创建 LLMProvider 实例**——保持既有 `resolve.ts` ↔ 配置层、`create-provider.ts` ↔ 实例层的单向依赖。§二.3 实例共享判断由 `createProviderRoles` 在实例层处理 |

**消费层**：

| 组件 | 关系 |
|------|------|
| `flushCallLLM` 闭包（`cli/run-agent.ts:305`） | 改用 `roles.secondary.chat()`；删除 line 329 的 `// 未来可通过 ZhixingConfig 配置 compactionModels 拆分` 注释 |
| `runAgentLoop` / `resolveModelInfo` / AgentRuntime.{providerId, model} | 入参改读 `roles.main.*`（详见 §三.2 站点 1/3/4） |
| 21A SecurityPipeline / PermissionStore / BoundaryRegistry | 完全无关 |
| `provider-layer-evolution.md` | 该 spec 是 *Provider 抽象演进*；本规格是 *Provider 角色化使用*——正交 |

---

## 六、ADR

### ADR-SLLM-001：命名 `secondary` 而非 `cheap` / `auxiliary` / `light`

`secondary` 描述架构角色（与 main 对偶的层次），不预设具体属性（cost / size / speed）。即使二级模型选了昂贵的（如用 sonnet 做精细子任务），角色定义不变。`auxiliary` 太模糊；`cheap` / `light` 是属性化命名，不抽象。

### ADR-SLLM-002：Capability 形态用 `LLMRoles` 包装而非裸 `LLMProvider`

- `LLMRole` 绑定 model 到 provider，consumer 不需要每次传 model，减少跨 consumer 的不一致
- `LLMRoles` 让 main 也对工具可见——少数场景（multi-step 推理工具）可能需要主模型
- 未来加 tertiary / vision / embedding 角色时只需扩展 LLMRoles 字段，不改 ToolExecutionContext shape

### ADR-SLLM-003：Config nesting + hard cut

- 嵌套 `llm.{main,secondary}` 而非 flat `mainProvider` / `secondaryProvider`：让 LLM 相关配置语义聚合，与 `agent` / `workspace` / `channels` 等顶层域并列；未来加角色不污染顶层
- hard cut 删除顶层 `defaultProvider` / `defaultModel`，不留 fallback / shim / deprecated 标记：zhixing 是 internal-only 项目，没有 released-user 需要 BC；保留 fallback 是给"假想用户"妥协，违反"避免架构债务"原则；双 schema 解析分支是典型架构债（每次 resolver 改动都要权衡两条路径）

### ADR-SLLM-004：默认值策略

secondary 缺省时尝试 SECONDARY_DEFAULT（haiku-4-5 via anthropic）；不可达时降级 main：
- Anthropic 用户开箱即用——配 main 即免配 secondary
- 非 Anthropic 用户若不显式配 secondary 也能正常运行——secondary === main 的退化行为不破任何能力，只失去成本/性能优势
- 启动 INFO 日志告知 degrade 发生，不阻塞启动

### ADR-SLLM-005：Provider 实例复用（同 provider 共享）

secondary.provider === main.provider 时共享 LLMProvider 实例：连接池 / 限速 / cache 共用，资源开销最小；LLMProvider 接口无 stateful per-call 字段，共享安全；model 是 chat request per-call 参数，共享实例同时跑多模型不冲突。**是优化不是契约**——consumer 不应用 === 比较 provider 实例。

### ADR-SLLM-006：Optional ctx.llm + 显式分支表态

- `ToolExecutionContext.llm` 是 optional 字段——测试 / serve 自动化 / 极简部署可能不注入；强制必填会让"工具的核心能力依赖 LLM"成为不可分隔的耦合
- consumer 必须显式分支处理 `!ctx.llm`，但**具体策略由工具自定**——graceful degrade（推荐）或返回明确 isError ToolResult（强依赖 LLM 时）
- 不强制所有工具 graceful degrade——未来工具（假设的 `translate_text` 等）可能合理强依赖 LLM；硬性要求会逼工具写一个"啥也没干但成功了"的 stub
- 禁止 silent return / 抛 throw：silent succeed 会隐藏故障；throw 给 secure-executor 通用 catch 失去 cause 信息

### ADR-SLLM-007：不抽 LLMService

consumer 直接调 `secondary.chat()`（工具消费走 `ctx.llm.secondary`，runtime 闭包消费走 `roles.secondary`），不抽象 `LLMService.summarize() / classify() / extract()`：
- 当前 2 个 consumer（compaction / WebFetch distill）task 形态完全不同（消息列表→摘要 vs raw markdown+prompt→task-relevant 摘要）
- 未来 WebSearch / MCP digest / 子 agent return 各自有特殊 prompt + temperature + max_tokens
- 抽象层会让"统一接口"成为最小公约数 → 任何 consumer 想自定义参数都要绕开抽象 → 抽象层无价值
- 阈值：3+ consumer 共享同一 task 形态时再抽

---

## 七、实施验收（Step 21B M0）

### M0.1 数据模型重构

类型层（按 §一.1 字段位置区分表执行）：
- 新增 `LLMRoleConfig` / `LLMRole` / `LLMRoles` / `ToolExecutionContext.llm?`
- 新增 `ZhixingConfig.llm: { main, secondary? }`
- 删除 `ZhixingConfig.defaultProvider?` / `ZhixingConfig.defaultModel?`
- 不动 `ProviderConfig.defaultModel?` / `ProviderPreset.defaultModel?` / `ResolvedProvider.defaultModel?`

调用站迁移（按 §五 关系表执行）：
- `packages/providers/src/{resolve,create-provider,config-loader}.ts`
- `packages/providers/__tests__/*` 测试 fixtures
- `packages/cli/src/run-agent.ts` 6 个站点（详见 §三.2 表）
- `packages/cli/README.md` 配置示例
- 不动 `packages/providers/{adapters/*, presets.ts}` —— 消费 ProviderConfig/Preset/ResolvedProvider 字段，与 hard cut 无关

配置文件层：
- 一次性手工迁移 `~/.zhixing/config.json` 与 `<workspace>/zhixing.config.json` 改用 `llm.main`

### M0.2 解析与工厂

实现（按 resolve.ts ↔ 配置层、create-provider.ts ↔ 实例层的单向依赖切分）：

- `resolve.ts`：
  - 新增 `resolveLLMRoles(config, options, env)`——纯配置层，签名与既有 `resolveFromConfig(config, providerId, env)` 的"配置 + 命令行覆盖 + 环境"三段式风格一致；`options: { providerOverride?: string; modelOverride?: string }` 是 `createProviderRoles` options 的 override 子集；返回 `{ main: { resolved: ResolvedProvider, model: string }, secondary: { resolved: ResolvedProvider, model: string } }`，**不**创建 LLMProvider 实例
  - 修改 `resolveFromConfig` 内部 2 处（§五 解析层表）
- `create-provider.ts`：
  - 新增 `createProviderRoles(options)`：内部流程 `loadConfig` → `resolveLLMRoles(config, options, env)` → `createFromResolved` 实例化两个 ResolvedProvider（应用 §二.3 实例共享判断：同 `provider` key 复用同一 `LLMProvider` 实例）→ 包装成 `LLMRoles` 返回
  - 删除 `createProviderFromConfig`
- 不动 `resolveProvider` / `createProvider` / `createProviderDirect` 自身代码

错误信息文案（`resolveLLMRoles` 在不同失败模式下的产出，每条都需可操作）：

**A. 缺 `llm.main`**：
```
ZhixingConfig.llm.main is required.

If migrating from older config that uses top-level defaultProvider/defaultModel,
replace:
  { "defaultProvider": "<id>", "defaultModel": "<model-id>", "providers": {...} }
with:
  { "llm": { "main": { "provider": "<id>", "model": "<model-id>" } }, "providers": {...} }

See research/design/specifications/secondary-llm-capability.md §一.1.
```

**B. `--provider` 单独使用 + 新 provider 无预设默认 model**：
```
--provider "<id>" requires --model: provider has no default model in preset
or providers.<id>.defaultModel. Pass --model <model-id> explicitly.
```

**C. 显式 `llm.secondary` 配置但 resolveProvider 失败**（apiKey 不可解析等）：
直接透传 `resolveProvider` 抛出的 `ProviderConfigError` 原样信息（不做包装，让用户看到底层错误的精确位置）。

单测覆盖：
- main 解析：
  - 显式 `llm.main` ✓
  - `providerOverride` 单独 + 新 provider 有 default → `roles.main.model` = 新 provider default ✓
  - `providerOverride` 单独 + 新 provider 无 default → throw（含 B 文案断言）✓
  - `modelOverride` 单独 → `roles.main` = (config provider, override model) ✓
  - 两个 override 同时 → `roles.main` = (override provider, override model) ✓
  - 缺 `llm.main` → throw（含 A 文案断言）✓
- secondary 解析：
  - 显式 ✓
  - 内置默认（anthropic 可达）✓
  - 内置默认 try/catch 失败 → degrade ✓
  - 显式配错 → throw（透传 C）✓
  - main 任一 override 不影响 secondary ✓
- 实例复用断言：同 provider 共享 instance / 不同 provider 各自 instance / degrade 时同一 instance
- effective state 断言：`roles.main.{provider.id, model}` 等于解析顺序计算后的最终值（含 CLI override 与 `--provider` 跟随的预设默认）

### M0.3 入口注入

cli/run-agent.ts 的 6 个站点全部按 §三.2 表更新；server-side 通过 `createAgentRuntime` 工厂注入间接受益。

### M0.4 验收测试

- consumer mock test：mock 工具调 `ctx.llm.secondary.chat()` 能 stream 出预期事件
- "ctx.llm undefined" test：mock 工具按"显式分支表态"契约 fail（不 silent / 不 throw）
- 实例复用 test：相同 provider 时 `roles.main.provider === roles.secondary.provider` 严格相等（仅作内部不变断言，非外部契约）
- 降级 test：无 anthropic 凭证 + 无 `llm.secondary` 配置 → roles.secondary === roles.main；启动 INFO 日志被产出
- 配错 fail-fast test：显式 `llm.secondary` 配置但 anthropic apiKey="env:NONEXISTENT" → resolveProvider throw → session 启动失败
- 上下文压缩链路 test：mock LLM 跑 LLMSummarizeStrategy 一轮 → secondary path 被调用，main provider 调用计数器在压缩期间不增长

---

## 八、未来工作

| 项 | 触发条件 |
|---|---------|
| LLMService 抽象（`summarize()` / `classify()` / `extract()`） | 3+ consumer 共享同一 task 形态 |
| 角色扩展（tertiary / vision / embedding） | 出现真实需求（多模态 / 嵌入计算等） |
| Per-task auxiliary（hermes 风格） | secondary 需要按工具差异化 |
| Smart routing（hermes 风格 < 160 字符走 secondary） | 主对话延迟成 user-facing 痛点 |
| Provider 实例 health check / 自动 fallback | secondary 长期不可用现象出现 |
| `ToolDefinition.requiresCtxFields?: ("llm" \| "commitToUser")[]` | 强 LLM 依赖工具 ≥ 2 个时（runtime 直接拒绝调用，避免每个工具自己写 error 分支） |

---

## 附录：与三个参考实现的对比

| 维度 | claudecode | hermes | openclaw | zhixing |
|------|-----------|--------|----------|---------|
| 二级模型存在 | ✅（写死 Haiku） | ✅（按 task auxiliary） | ❌ | ✅（main + secondary） |
| 配置粒度 | 全局单例 | per-task | per-feature override | 全局单 secondary |
| 默认值 | 平台决定 | provider 决定 | n/a | Anthropic Haiku 4.5 |
| WebFetch distill | ✅ Haiku | ✅（带并行分块） | ❌（raw 返回） | ✅ secondary |
| 上下文压缩 | Haiku | auxiliary | 主模型 | secondary |
| 抽象层 | API client 内部分支 | LLMService（call_llm by task） | 配置驱动 | LLMRole.chat()（无抽象层） |

zhixing 选择最贴近 claudecode 的全局单 secondary 模式：比 hermes 简单（不引入 per-task complexity）；比 openclaw 准确（明确"成本维度的二级"语义）；比 claudecode 配置层更显式（claudecode 写死，zhixing 可配）。
