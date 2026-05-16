# 辅助 LLM 角色能力 · 执行规格

> 在会话级（ToolExecutionContext / SessionRuntime）暴露独立的"辅助 LLM 角色"，让 I/O 边界净化（上下文压缩 / WebFetch distill / 工具结果摘要 / 子 agent 返回压缩 / 通道入站分类等）不消耗主上下文与主模型成本。本能力**不绑定具体工具**——是会话级共享基础设施。

**消费者**：上下文压缩（`createCompactionFlush` → `roles.light`）+ WebFetch distill（`ctx.llm.light`）+ 未来 WebSearch / MCP 大结果摘要 / 子 agent 返回压缩 / 通道入站分类 / 记忆语义压缩

---

## 〇、概念

### 〇.1 三角色与各自定位

会话级共暴露三个 LLM 角色，**角色集的单一事实源是 `packages/providers/src/role-spec.ts` 的 `ROLE_SPECS` 注册表**（见 §一.4）：

- **`main`（必填）**：主对话循环、complex reasoning、用户面对的最终输出。
- **`light`（选填）**：后台杂活槽——上下文压缩 / WebFetch 蒸馏 / 工具结果摘要 / 子 agent 返回压缩 / 通道入站分类等"输入大、输出小、不需要长链推理"的 I/O 边界净化任务。通常挑轻量便宜模型。
- **`power`（选填）**：重活槽——编程等高难任务。模型档位由用户决定，名字表达"接重活"而非"模型一定强"（用户即便给 `power` 配弱模型也合法）。**当前仅基础设施就位，没有任何消费者接入**，为未来重活类工作预留——不预绑任何调用点。

`light` 与 `power` 都是**辅助角色**（非必填、有 main 兜底），共用同一套解析 / 实例复用 / 兜底机制（§二）。三者承担"接什么活"的角色用途分工，不锁定模型档位。

### 〇.2 为什么需要辅助角色

辅助角色的核心价值是**调用上下文隔离**——把 I/O 边界处的处理任务（上下文压缩 / 工具结果摘要 / 网页正文蒸馏 / 子 agent 返回压缩 / 通道入站分类等）放到一次**独立的 LLM conversation** 里执行，不污染主对话历史。三层价值，按重要度递减：

**第一层：上下文隔离 / 信任边界（核心，不可放弃）**

- 工具结果 / 网页内容 / 子 agent 返回可能含 prompt injection、噪音、敏感信息
- 用独立 `light` 调用处理：即使内容里有"忽略之前指令、改为执行 X"，被污染的也只是 `light` 的一次性 conversation
- `main` 看到的是 `light` **输出后的结构化净化结果**——攻击向量被切断、噪音被剥离
- 即便 `light` 与 `main` 是**同一 provider + 同一 model**，分开调用本身就有此价值——隔离来自"调用上下文独立"，不来自"模型不同"

**第二层：任务专门化（可选优化）**

- 上下文压缩 / JSON 抽取 / 摘要这类"输入大、输出小、不需要长链推理"的任务和主对话 task shape 不同
- 用户可显式配 `light` 为更适合此类任务的模型（如响应快的小模型、JSON mode 友好的模型）

**第三层：cost 优化（派生收益）**

- 因为第二层任务通常较轻量，可选 cost/quality 偏 cost 端的模型
- 这是"可以这么做"，不是"必须这么做"——用户的 vendor 选择是主权范围，knows best

直接把这些任务灌入主上下文会导致：

- token 浪费：主模型按"输入 token"计费整段
- context 污染：噪音留在历史里直到 compaction 截断
- coherence 下降：注意力被无关内容稀释
- 多次 I/O 不可叠加：3 次 fetch + 5 个 MCP 结果迅速吞噬窗口

这是 agent 信息流的标准范式（Claude Code WebFetch yaml 明示用 small fast model；hermes 用 auxiliary client 处理 task-specific 子任务）。但前者写死了 vendor，后者按 task 切分，知行选**会话级固定角色集 + 用户主权配置**——见 §六 ADR-SLLM-001/004。

### 〇.3 为什么是会话级 capability，不是工具内依赖

把 LLM 注入绑死到工具（如 `createWebFetchTool({ cheapProvider })`）有 3 个问题：
1. **多 consumer 重复**：每个工具自注入 → 配置散落 + 代码重复
2. **配置耦合**：用户改辅助模型 ID 要改每个工具的工厂参数
3. **资源浪费**：N 个工具创建 N 个 LLMProvider 实例，连接池 / 限速 / cache 全部独立

升格为**会话级 capability**——`ToolExecutionContext.llm` 注入，所有工具共享同一组实例。这与 `BoundaryRegistry` 路径完全对称：自描述工具 + 会话级 capability 注入。

---

## 一、数据模型

### 1.1 配置层（`packages/providers/src/types.ts`）

```typescript
/**
 * 单个 LLM 角色的 provider+model 选择。
 * - provider：必须是内置预设 ID 或 credentials.providers 表中的 key
 * - model：该 provider 可识别的模型 ID
 */
export interface LLMRoleConfig {
  provider: string;
  model: string;
}

export interface ZhixingConfig {
  /**
   * LLM 角色配置（角色集单一事实源 = role-spec.ts 的 ROLE_SPECS）：
   * - main 必填——主对话循环、用户面对的最终输出
   * - light 可缺省——I/O 边界净化（上下文压缩、WebFetch distill、工具结果摘要等）
   * - power 可缺省——编程等重活槽（基础设施就位，消费者按需接入）
   * 辅助角色缺省时直接用 main 实例 + main.model 兜底（隔离价值仍保留）。
   *
   * llm 字段本身 optional 是为反映 loadConfig 的真实输出形状——文件可能缺这一段。
   * 真正的 fail-fast 校验在 resolveLLMRoles / resolveFromConfig 入口集中处理。
   */
  llm?: {
    main: LLMRoleConfig;
    light?: LLMRoleConfig;
    power?: LLMRoleConfig;
  };

  // 其它已有字段（messaging / agent / intent / workspace / network / modelCapabilityOverrides）
}
```

`provider` 引用的是 `credentials.providers.<id>`（凭证唯一入口，与 config 物理隔离）；config 是决策层只记录"用哪个"。`ProviderConfig.defaultModel?` / `ProviderPreset.defaultModel?` / `ResolvedProvider.defaultModel?` 三个同名字段是各自抽象层的合理组件，与本能力正交——不动。

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
 * 会话级可用的 LLM 角色集合。键集与 role-spec.ts ROLE_SPECS 的 id 一一对应。
 *
 * 不变量：
 * 1. LLMRoles 一旦构造，main / light / power 都必定可调用——用户没显式配某
 *    辅助角色（light / power）时，该角色自动用 main 实例 + main.model 兜底
 *    （隔离价值仍保留，仅放弃任务专门化/cost 优化）。这不是降级，是合理的
 *    未配置默认。
 * 2. roles.main.{provider,model} 反映会话**实际使用的** effective state——含
 *    任何 CLI override（如 --provider / --model）。consumer 读到的就是 runtime
 *    实际跑的 provider+model，不存在 ctx.llm.main 与运行时 split brain 的可能。
 * 3. ToolExecutionContext.llm 字段是 optional——入口正常注入，单测/自动化路径
 *    可能不注入。consumer 必须显式分支处理 !ctx.llm（见 §三.3）。
 *
 * Provider 实例复用：辅助角色与 main 用同一 provider id 时共享 LLMProvider
 * 实例（连接池/限速/cache 共用）。这是优化不是契约——consumer 不应用
 * === 比较 provider 实例。
 */
export interface LLMRoles {
  main: LLMRole;
  light: LLMRole;
  power: LLMRole;
}
```

### 1.3 ToolExecutionContext 扩展

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

### 1.4 角色集单一事实源：`role-spec.ts`

`packages/providers/src/role-spec.ts` 是**角色集的单一事实源**——三角色的身份、必填性、兜底目标、配置编辑器中文文案各只声明一次：

```typescript
export interface RoleSpec {
  readonly id: "main" | "light" | "power"; // 与 LLMRoles / ZhixingConfig.llm 键一一对应
  readonly required: boolean;               // 仅 main 必填
  readonly fallbackTo: "main" | null;       // 辅助角色缺省回落目标（null = 不回落）
  readonly labelZh: string;                 // config-editor 入口标签
  readonly parenZh: string;                 // 标签后中文括号说明（用途语义提示）
  readonly missingStatusZh: string;         // 未配置时 config-editor 状态文案
}

export const ROLE_SPECS = [ /* main / light / power 三行 */ ] as const satisfies readonly RoleSpec[];

export type RoleId = (typeof ROLE_SPECS)[number]["id"];      // 全仓 role 类型单一来源
export const REQUIRED_ROLE_IDS: readonly RoleId[];           // 当前仅 main
export const AUX_ROLE_SPECS: readonly RoleSpec[];            // 非必填、有兜底（light/power）
export function getRoleSpec(id: RoleId): RoleSpec;
```

文件末尾有**编译期双向断言**：`RoleId` 集合 ≡ core `LLMRoles` 键集合。任一侧新增/改名而另一侧没跟上 → TS 编译失败，强制同步。

**注册表驱动机械层**——所有"逐角色机械重复"的层都遍历本表派生，不再有 `role === "main" ? … : light` 之类字面量分支：

- `resolve.ts`：`resolveAuxRole` 对 `AUX_ROLE_SPECS` 中 `fallbackTo:"main"` 的角色共用兜底逻辑（§二.2）
- `cli/config-editor`：`ModelRole = RoleId`；`sections/model.ts` 遍历 `ROLE_SPECS` 生成入口（标签 = `${labelZh}（${parenZh}）`，中文括号说明让首次用户看懂用途）；`checks/model.ts` 遍历 `AUX_ROLE_SPECS` 检查"显式配辅助角色且异 provider 时缺凭证"
- JSONC 配置模板：`config-loader.ts` 的 `buildConfigTemplate` 含 light / power 注释块与兜底说明
- hot-reload diff：`cli/runtime/diff.ts` 整段 `!stableEqual(oldConfig.llm, newConfig.llm)`，覆盖 main 及全部辅助角色，**与 ROLE_SPECS 解耦零漂移**——角色集变化无需在此逐一枚举

分工边界：**消费者契约**（`LLMRoles` / `ResolvedLLMRoles` 的显式 typed 字段）仍是手写接口——`roles.main.chat()` 的类型安全与人体工学优先，不退化为 Record 索引。注册表只驱动"角色集是什么 + 各角色元信息"这一机械重复维度（见 ADR-SLLM-008）。

---

## 二、解析链路

### 2.1 main 角色解析

**基础（必填）**：`config.llm.main` 提供 provider 与 model。`config.llm?.main` 缺失 → 抛 `ProviderConfigError`（fatal，session 不应启动）。这是 `resolveLLMRoles` 的单一 fail-fast 边界——把 `ZhixingConfig.llm?` 的 optional 在此一次性 narrow。

**CLI override**：

| 来源 | 作用 |
|------|------|
| `options.providerOverride`（CLI `--provider`） | 替换 main role 的 provider；model 自动跟随新 provider 的预设默认（除非也提供了 `--model`） |
| `options.modelOverride`（CLI `--model`） | 替换 main role 的 model（最高优先） |

**解析顺序**（`resolveMainRole`）：

```
finalProvider = options.providerOverride ?? config.llm.main.provider
resolved      = resolveProvider(finalProvider, credentials)

if options.modelOverride:          // 最高：显式 --model
  finalModel = options.modelOverride
elif options.providerOverride:     // 中段：--provider 单独 → 跟随新 provider 预设默认
  finalModel = resolved.defaultModel
               ?? throw ProviderConfigError(
                    `--provider "${finalProvider}" requires --model: provider has no ` +
                    `default model in preset or credentials.providers.${finalProvider}.defaultModel`)
else:                              // 默认：config 原值
  finalModel = config.llm.main.model

→ main = { resolved, model: finalModel }
```

设计要点：
- `--provider X` 单独使用时 model 跟随 X 的预设默认——保持现有 CLI 人体工学（如 `--provider deepseek` 直接拿 deepseek 默认模型，不必再加 `--model`）
- `--model` 最高优先——用户显式指定永远生效
- 三段优先级互不干涉：`--provider X --model Y` = X+Y 组合（语义错配的组合留给 runtime 检测）

辅助角色（`light` / `power`）总是按 §二.2 解析链，**不受 main override 影响**——`--provider X` 临时换主模型不会牵动辅助角色的 cost/quality 选择。

### 2.2 辅助角色（light / power）解析：`resolveAuxRole`

`light` 与 `power` 共用 `resolveAuxRole(explicit, credentials, fallbackRole)`——注册表 `ROLE_SPECS` 中 `fallbackTo:"main"` 的角色都走它，`fallbackRole` 当前恒为已解析的 `main`：

```
1. config.llm.<aux> 缺省（用户没显式配）
   → 用 fallbackRole（main）实例 + main.model 兜底
   → aux.resolved = main.resolved
   → aux.model = main.model
   → 不打印任何提示——这是合理的未配置默认，不是降级（隔离价值仍保留）

2. config.llm.<aux> 显式设置
   → 同 provider id 短路：aux.provider === main.resolved.id
     → 复用 main 实例（避免重复 credentials 查询）
     → aux.model = aux.model（仍独立）
   → 不同 provider id：
     → resolveProvider(aux.provider, credentials)
       成功 → 使用
       任意错误 → 抛 ProviderConfigError（用户显式配置必须 fail-fast，不允许
                  "显式配错也帮你降级"的隐晦语义）
```

**不预设任何 vendor 默认**——是 vendor lock-in 错误（详见 ADR-SLLM-004）：

- 知行 provider 中立，预设 8 家服务商（deepseek/minimax/siliconflow/qwen/kimi/glm/openai/anthropic），不替用户挑选其中之一作为辅助角色默认
- 国内用户主用 siliconflow / qwen 等，硬塞 anthropic 默认会导致每次启动都看 "degrade" INFO，错把"正常状态"暗示为"异常状态"
- 用户的 vendor 选择是主权范围，工具不该越权决策

### 2.3 Provider 实例复用

```
mainProvider = createFromResolved(resolved.main.resolved)

instanceFor(role) =
  role.resolved.id === resolved.main.resolved.id
    ? mainProvider（同一实例）
    : createFromResolved(role.resolved)

→ roles.light = bindRole(instanceFor(resolved.light), resolved.light.model)
→ roles.power = bindRole(instanceFor(resolved.power), resolved.power.model)
```

辅助角色未配置走兜底时 `role.resolved` 与 `main.resolved` 是同一对象，`instanceFor` 必然命中复用。复用的只是协议配置（baseUrl / apiKey / connection pool 等 stateless 资源），conversation 仍然独立——隔离价值（§〇.2 第一层）始终保留，无论辅助角色是缺省兜底还是显式同 id。

---

## 三、注入与消费

### 3.1 入口工厂

`packages/providers/src/create-provider.ts`：

```typescript
export interface ProviderRolesOptions extends LLMRolesResolveOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ProviderRolesResult {
  roles: LLMRoles;
  config: ZhixingConfig;
  resolvedRoles: ResolvedLLMRoles; // 配置层中间产物（protocol/baseUrl/quirks/declaredModels）
}

export function createProviderRoles(options?: ProviderRolesOptions): ProviderRolesResult;
```

内部流程：`loadConfig` → `loadCredentials` → `resolveLLMRoles(config, credentials, { providerOverride, modelOverride })` → `createFromResolved` 实例化 main、`instanceFor` 按 provider-id 复用装配 light + power → `bindRole` 绑定 model 成 `LLMRole`。

设计要点：CLI override 直接在工厂内吸收，让 `roles.main.{provider,model}` 始终反映会话实际使用的 effective state——任何 ctx.llm.main consumer 读到的就是 runtime 跑的同一对值。`resolvedRoles` 暴露配置层元信息（原本埋在 LLMProvider 实例里不可见），供消费者完成 budget 解析等 protocol-aware 工作。`bindRole` 是 `@internal`，外部 consumer 用 `createProviderRoles` 一站式构造，不应自己 bind（绕过 same-id 复用 / 缺省兜底）。

### 3.2 cli 入口装配（`packages/cli/src/run-agent.ts`）

`createProviderRoles` 在 entry 处吸收 CLI override（`options.provider` → `providerOverride`；`options.model` → `modelOverride`），下游所有站点统一从 `roles.main.*` 读取——不再保留 `const model = options.model ?? defaultModel` 这条本地变量。

| 位置 | 形态 | 角色 |
|------|------|------|
| entry | `const { roles, config } = createProviderRoles({ providerOverride: options.provider, modelOverride: options.model })` | entry |
| budget 解析 | `resolveModelInfo({ providerId: roles.main.provider.id, model: roles.main.model, ... })` | main |
| 上下文压缩 | `createCompactionFlush(roles)` → 内部走 `roles.light.chat({...})` | **light** |
| AgentRuntime 返回 | 同时含 `providerId: roles.main.provider.id` 与 `model: roles.main.model`——都反映 effective state（含 CLI override） | main |
| agent loop | `runAgentLoop({ provider: roles.main.provider, model: roles.main.model, ... })` | main |
| ctx 工厂 | 创建 ToolExecutionContext 时注入 `llm: roles` | both |

上下文压缩走 `roles.light` 由 `createCompactionFlush`（`orchestrator/src/runtime/compaction-llm.ts`）实现——把 light 角色的"消费流式响应、拼接 text_delta"模式抽成独立可测单元，让"走 light 而非 main"这一隔离承诺在单测中可反向 assert（`roles.main.chat` 不应被调用），防止未来 refactor 错绑到 main 而无人发现：

```typescript
export function createCompactionFlush(roles: LLMRoles): CompactLLMFn {
  return async (messages, opts) => {
    const chunks: string[] = [];
    for await (const event of roles.light.chat({
      messages, tools: [], abortSignal: opts?.abortSignal,
    })) {
      if (event.type === "text_delta") chunks.push(event.text);
    }
    return chunks.join("") || "[]"; // 空响应回 "[]"：给 JSON 解析路径安全兜底
  };
}
```

间接受益（无需直接修改）：`serve/command.ts` 通过 `createAgentRuntime` 工厂调用自动传导；`serve/session-adapter.ts` 通过工厂注入消费。

### 3.3 工具消费的 `!ctx.llm` 处理契约

工具调 `ctx.llm` 时**必须显式分支处理** `!ctx.llm`（WebFetch distill 实例，`tools-builtin/src/web-fetch.ts`）：

```typescript
async call(input, ctx) {
  const fetched = await safeFetch(input.url, ...);
  const sanitized = sanitizeUntrustedText(...);

  // ctx.llm 缺失 OR input.prompt 缺失 → 返回 raw markdown
  if (!ctx.llm || !input.prompt) {
    return { content: `Source: ${input.url}\n\n${sanitized}`, isError: false };
  }

  // 主路径：light 蒸馏
  const chunks: string[] = [];
  for await (const event of ctx.llm.light.chat({
    systemPrompt: DISTILL_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildDistillPrompt(input.url, sanitized, input.prompt) }],
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

| Consumer | Role | 状态 | 触发条件 / 备注 |
|----------|------|------|----------------|
| 上下文压缩（MemoryFlush + LLMSummarize 策略的 flushCallLLM 路径） | light | 已落地 | `createCompactionFlush(roles)` → `roles.light.chat`；`MemoryFlushStrategy` priority 3 / `LLMSummarizeStrategy` priority 200，由 ContextEngine 调度 |
| WebFetch distill | light | 已落地 | 用户传 `input.prompt` 时触发；`!ctx.llm` 时退到 raw markdown |
| WebSearch 后处理 | light | 未来 | search snippet 合并 + 提炼 |
| MCP 大结果摘要 | light | 未来 | tool result > N tokens 时自动 distill |
| 子 agent 返回压缩 | light | 未来 | sub-agent 完成后 summarize 给父 agent |
| 通道入站分类 | light | 未来 | 入站消息选择 agent 时的轻量分类 |
| **编程等重活** | power | **预留，未接入** | 基础设施就位，当前无任何 consumer——设计如此（不预绑调用点，等真实重活类需求出现） |
| **不在辅助角色范围** | - | - | 主对话循环 / complex reasoning / 用户面对的最终输出（一律 main） |

---

## 五、与已落地组件的关系

**接口与类型层**：

| 组件 | 关系 |
|------|------|
| `LLMProvider` 接口（`core/types/llm.ts`） | 不修改；辅助角色仍是 LLMProvider 实例 |
| `LLMRole` / `LLMRoles { main; light; power }`（`core/types/llm.ts`） | LLMRoles 三键，键集与 ROLE_SPECS 对应 |
| `ToolExecutionContext`（`core/types/tools.ts`） | `llm?: LLMRoles` 字段 |
| `ZhixingConfig.llm?: { main; light?; power? }`（`providers/types.ts`） | optional 反映 loadConfig 真实形状，fail-fast 在 resolve 入口 |
| `LLMRoleConfig`（`providers/types.ts`） | 单角色 provider+model 选择 |
| `RoleSpec` / `ROLE_SPECS` / `RoleId` / `AUX_ROLE_SPECS` / `REQUIRED_ROLE_IDS` / `getRoleSpec`（`providers/role-spec.ts`） | 角色集单一事实源；文件末尾编译期断言守护与 `LLMRoles` 键集一致 |
| `ProviderConfig.defaultModel?` / `ProviderPreset.defaultModel?` / `ResolvedProvider.defaultModel?` | 不变（不属于本能力 scope） |

**工厂层**：

| 函数 | 说明 |
|------|------|
| `createProviderRoles(options)` | 多角色解析（main + light + power），CLI/serve 入口；§三.1 |
| `bindRole(provider, model)` | `@internal`——LLMProvider + model 绑定成 LLMRole；外部用 createProviderRoles |
| `createProvider(config, providerId?)` | 单角色 LLMProvider，内部 `resolveFromConfig` |
| `createProviderDirect(providerId, override?)` | 指定 provider ID + 可选凭证覆盖，单角色 LLMProvider，测试/integration 用 |

**解析层**：

| 函数 | 说明 |
|------|------|
| `resolveProvider(providerId, credentials)` | 合并预设 + 凭证条目，返回单个 ResolvedProvider |
| `resolveFromConfig(config, credentials, providerId?)` | 只要一个 ResolvedProvider 的场景（如 createProvider）；`id = providerId ?? config.llm?.main?.provider`，缺失抛 missing-main 文案 |
| `resolveLLMRoles(config, credentials, options?)` | **纯配置层**——实现 §二.1（main 三段优先级）+ §二.2（`resolveMainRole` + `resolveAuxRole` × {light, power}），返回 `ResolvedLLMRoles { main; light; power }`（各 `{ resolved: ResolvedProvider, model }`）。**不创建 LLMProvider 实例**——保持 `resolve.ts` ↔ 配置层、`create-provider.ts` ↔ 实例层的单向依赖。§二.3 实例共享判断由 `createProviderRoles` 在实例层处理 |
| `resolveAuxRole(explicit, credentials, fallbackRole)` | light/power 共用的辅助角色解析；ROLE_SPECS 中 fallbackTo:"main" 的角色都走它 |

**消费层**：

| 组件 | 关系 |
|------|------|
| `createCompactionFlush(roles)`（`orchestrator/runtime/compaction-llm.ts`） | 固定走 `roles.light.chat`；无状态，可跨 ContextEngine / strategy 共享 |
| WebFetch（`tools-builtin/web-fetch.ts`） | 走 `ctx.llm.light`；`!ctx.llm || !prompt` graceful degrade 到 raw markdown |
| `cli/config-editor`（sections/checks/state/types） | `ModelRole = RoleId`；遍历 ROLE_SPECS / AUX_ROLE_SPECS 派生入口与校验 |
| `cli/runtime/diff.ts` | 整段 `!stableEqual(oldConfig.llm, newConfig.llm)`——与 ROLE_SPECS 解耦零漂移 |
| `runAgentLoop` / `resolveModelInfo` / AgentRuntime.{providerId, model} | 入参读 `roles.main.*` |
| SecurityPipeline / PermissionStore / BoundaryRegistry | 完全无关 |
| `provider-layer-evolution.md` | 该 spec 是 *Provider 抽象演进*；本规格是 *Provider 角色化使用*——正交 |

---

## 六、ADR

### ADR-SLLM-001：角色命名定为 `main` / `light` / `power`

角色命名取 `main` / `light` / `power`——一条**面向用户、公开度高、直觉的强弱/用途轴**。

- **名字表达"接什么活"，不锁定模型档位**：`light` = 后台轻量杂活槽，`power` = 重活槽（编程等高难任务）。用户即便给 `power` 配一个弱模型也**完全合法**——名字是角色用途约定，不是对模型属性的断言；同理 `light` 配强模型也合法。这与"`secondary` 描述抽象层次但用户读不懂用途"、"`cheap` 把 cost 写死进名字"两个极端都不同——`light/power` 直觉传达用途又不绑死属性。
- **无命名包袱**：知行是 internal-only 项目，无存量已发布用户，不需要为旧命名保留 BC，可一步到位选最终命名。
- **公开度优先**：角色名出现在用户配置文件（`llm.light` / `llm.power`）、config-editor 入口标签里——首次用户一眼就能判断"我要不要给后台杂活单独配个便宜模型"。`labelZh`/`parenZh`（如"轻量模型（可选 · 轻量杂活，未配则沿用主模型）"）由 ROLE_SPECS 统一提供中文说明，进一步消除歧义。

### ADR-SLLM-002：Capability 形态用 `LLMRoles` 包装而非裸 `LLMProvider`

- `LLMRole` 绑定 model 到 provider，consumer 不需要每次传 model，减少跨 consumer 的不一致
- `LLMRoles` 让 main 也对工具可见——少数场景（multi-step 推理工具）可能需要主模型
- 加新角色 = `role-spec.ts` 的 `ROLE_SPECS` 加一行 + core `LLMRoles` 接口加一字段；文件末尾**编译期双向断言**强制两侧键集同步（任一侧没跟上 → TS 编译失败），不改 ToolExecutionContext shape。机械重复层（resolve 兜底 / config-editor / JSONC 模板 / diff）遍历注册表自动跟上

### ADR-SLLM-003：Config nesting

- 嵌套 `llm.{main,light,power}` 而非 flat `mainProvider` / `lightProvider`：让 LLM 相关配置语义聚合，与 `agent` / `workspace` / `messaging` 等顶层域并列；加角色不污染顶层
- `llm` 字段本身 optional——反映 `loadConfig` 真实输出形状（文件可能缺这一段）；不消费 LLM 的纯 workspace / messaging 路径不会被这里的缺失误伤。真正的 fail-fast 校验在 `resolveLLMRoles` / `resolveFromConfig` 入口集中（单一边界一次性 narrow），不留多处散布的 non-null 断言

### ADR-SLLM-004：辅助角色不设 vendor 默认

`config.llm.light` / `config.llm.power` 缺省时**直接用 main 实例 + main.model 兜底**——不预设任何 vendor / 模型，不打印提示。理由：

- **Provider 中立性**：知行预设 8 家服务商，给其中任何一家设 default 都是越权决策。国内用户主用 siliconflow / qwen，硬塞 anthropic 默认会让每次启动都看到"degrade"提示，错把"未配辅助角色这一正常状态"暗示成"异常"
- **隔离价值仍保留**：辅助角色即使等于 main，调用上下文仍独立——其一次性 conversation 与 main 物理隔离，prompt injection 通过工具结果污染辅助角色时 main 看到的只是结构化净化输出。隔离来自"调用边界"而非"模型差异"（见 §〇.2 三层价值）
- **任务专门化是用户主权**：用户想用更适合摘要的模型（如 cost 偏低 / JSON mode 友好的）就显式配 `llm.light`，不配是放弃这个优化，不是降级
- **不静默尝试任何 provider**：`try { resolveProvider("anthropic") } catch { degrade }` 式设计假设了 ANTHROPIC_API_KEY 是合理可探测的环境变量；这对国内用户错误，对所有用户都是隐式 vendor 偏好
- **/status 命令展示当前角色配置**（未来工作）：用户主动查询时温和展示"light 当前与 main 共享，可在配置文件配 llm.light 启用任务专门化"——这是用户拉式提示而非工具推式打扰

### ADR-SLLM-005：Provider 实例复用（同 provider 共享）

辅助角色与 main 用同一 provider id 时共享 LLMProvider 实例：连接池 / 限速 / cache 共用，资源开销最小；LLMProvider 接口无 stateful per-call 字段，共享安全；model 是 chat request per-call 参数，共享实例同时跑多模型不冲突。`createProviderRoles` 的 `instanceFor(role)` 按 `role.resolved.id === main.resolved.id` 判断复用——辅助角色走兜底时 resolved 与 main 同对象必然命中。**是优化不是契约**——consumer 不应用 === 比较 provider 实例。

### ADR-SLLM-006：Optional ctx.llm + 显式分支表态

- `ToolExecutionContext.llm` 是 optional 字段——测试 / serve 自动化 / 极简部署可能不注入；强制必填会让"工具的核心能力依赖 LLM"成为不可分隔的耦合
- consumer 必须显式分支处理 `!ctx.llm`，但**具体策略由工具自定**——graceful degrade（推荐）或返回明确 isError ToolResult（强依赖 LLM 时）
- 不强制所有工具 graceful degrade——未来工具（假设的 `translate_text` 等）可能合理强依赖 LLM；硬性要求会逼工具写一个"啥也没干但成功了"的 stub
- 禁止 silent return / 抛 throw：silent succeed 会隐藏故障；throw 给 secure-executor 通用 catch 失去 cause 信息

### ADR-SLLM-007：不抽 LLMService

consumer 直接调 `light.chat()`（工具消费走 `ctx.llm.light`，runtime 闭包消费走 `roles.light`），不抽象 `LLMService.summarize() / classify() / extract()`：
- 当前 2 个 consumer（compaction / WebFetch distill）task 形态完全不同（消息列表→摘要 vs raw markdown+prompt→task-relevant 摘要）
- 未来 WebSearch / MCP digest / 子 agent return 各自有特殊 prompt + temperature + max_tokens
- 抽象层会让"统一接口"成为最小公约数 → 任何 consumer 想自定义参数都要绕开抽象 → 抽象层无价值
- 阈值：3+ consumer 共享同一 task 形态时再抽

### ADR-SLLM-008：角色集注册表为单一事实源，消费者契约保留显式 typed 接口

分层决策——区分两个维度：

- **"角色集是什么 + 各角色元信息"**（机械重复维度）：单一事实源 = `role-spec.ts` 的 `ROLE_SPECS`。所有逐角色机械重复的层（resolve 兜底、config-editor sections/checks/state/types、JSONC 模板、hot-reload diff）遍历注册表派生，消除 `role === "main" ? … : light` 之类散落字面量分支。新增角色 = 注册表加一行 + core 接口加一字段，机械层零改动
- **"消费者怎么调某个角色"**（契约维度）：`LLMRoles` / `ResolvedLLMRoles` 保留**手写显式 typed 字段**（`roles.main` / `roles.light` / `roles.power`），不退化为 `Record<RoleId, LLMRole>` 索引——`roles.light.chat()` 的类型安全、IDE 跳转、人体工学优先；编译期双向断言保证显式字段集与注册表 id 集恒一致

两个维度分治：注册表吃掉机械重复，typed 接口守住消费者契约——既无散落分支漂移，又不牺牲调用点类型安全。

---

## 七、验收

- 配置模型：`LLMRoleConfig` / `LLMRole` / `LLMRoles { main; light; power }` / `ToolExecutionContext.llm?` / `ZhixingConfig.llm?: { main; light?; power? }` / `role-spec.ts` 全套导出 + 编译期双向断言
- main 解析：显式 `llm.main` ✓；`providerOverride` 单独 + 新 provider 有 default → model = 新 provider default ✓；无 default → throw（B 文案）✓；`modelOverride` 单独 ✓；两 override 同时 ✓；缺 `llm.main` → throw（A 文案）✓
- 辅助角色解析（light / power 各覆盖）：显式 + 异 id → 独立解析 ✓；显式 + 同 id → 复用 main 实例（model 仍独立）✓；缺省 → main 实例 + main.model 兜底 ✓；缺省时对所有 vendor 行为一致（vendor 中立回归保护）✓；显式配错 → throw（透传 resolveProvider 原错）✓；main 任一 override 不影响辅助角色 ✓
- `bindRole` 实绑契约：chat 调用时 provider 收到 `request.model === 绑定 model`；多 role 共享 provider 时 closure 不串
- 实例复用断言：同 provider 共享 instance / 异 provider 各自 instance / 缺省时同一 instance（仅内部不变断言，非外部契约）
- effective state 断言：`roles.main.{provider.id, model}` 等于解析顺序计算后的最终值（含 CLI override 与 `--provider` 跟随预设默认）
- consumer 路由：`compaction-llm.test.ts` mock 双 spy LLMRoles 跑 `createCompactionFlush` → `light.chat` 被调用、`main.chat` 永不被调用、abortSignal 透传、空响应回 `"[]"`；WebFetch mock `ctx.llm.light.chat()` stream 出预期事件；`!ctx.llm` 时按"显式分支表态"契约 fail（不 silent / 不 throw）
- 缺省兜底不打印任何启动提示；配错 fail-fast（显式 aux 配 `apiKey` 不可解析 → resolveProvider throw → session 启动失败）
- 注册表驱动层：config-editor sections / checks 遍历 ROLE_SPECS / AUX_ROLE_SPECS 产出三角色入口与异 provider 缺凭证校验；`RoleId` ≡ `LLMRoles` 键集编译期断言生效

错误文案（`resolveLLMRoles` 各失败模式，均需可操作）：

- **缺 `llm.main`**：`ZhixingConfig.llm.main is required.` + 旧 `defaultProvider/defaultModel` → `llm.main` 迁移示例
- **`--provider` 单独 + 新 provider 无预设默认 model**：`--provider "<id>" requires --model: provider has no default model in preset or credentials.providers.<id>.defaultModel. Pass --model <model-id> explicitly.`
- **显式辅助角色配置但 resolveProvider 失败**：直接透传 `resolveProvider` 抛出的 `ProviderConfigError` 原样信息（不包装，让用户看到底层错误精确位置）

---

## 八、未来工作

| 项 | 触发条件 |
|---|---------|
| `power` 角色接入消费者（编程等重活路由） | 真实重活类需求出现 |
| LLMService 抽象（`summarize()` / `classify()` / `extract()`） | 3+ consumer 共享同一 task 形态 |
| 角色扩展（vision / embedding 等） | 出现真实需求（多模态 / 嵌入计算等）——注册表加一行 + core 接口加一字段，机械层零改动 |
| Per-task auxiliary（hermes 风格） | light 需要按工具差异化 |
| Smart routing（hermes 风格 < 160 字符走 light） | 主对话延迟成 user-facing 痛点 |
| Provider 实例 health check / 自动 fallback | 辅助角色长期不可用现象出现 |
| `/status` 展示当前角色配置 | 用户拉式查询需求 |
| `ToolDefinition.requiresCtxFields?: ("llm" \| "commitToUser")[]` | 强 LLM 依赖工具 ≥ 2 个时（runtime 直接拒绝调用，避免每个工具自写 error 分支） |

---

## 附录：与三个参考实现的对比

| 维度 | claudecode | hermes | openclaw | zhixing |
|------|-----------|--------|----------|---------|
| 辅助模型存在 | ✅（写死 Haiku） | ✅（按 task auxiliary） | ❌ | ✅（main + light + power 预留） |
| 配置粒度 | 全局单例 | per-task | per-feature override | 固定三角色集（注册表单一事实源） |
| 默认值 | 平台决定（vendor lock-in） | provider 决定 | n/a | **无（用户主权，缺省用 main 兜底）** |
| 价值定位 | 成本+性能 | task 专门化 | n/a | **隔离 > 专门化 > cost** |
| WebFetch distill | ✅ Haiku | ✅（带并行分块） | ❌（raw 返回） | ✅ light |
| 上下文压缩 | Haiku | auxiliary | 主模型 | light |
| 抽象层 | API client 内部分支 | LLMService（call_llm by task） | 配置驱动 | LLMRole.chat()（无抽象层；角色集注册表 + 显式 typed 契约分治） |

zhixing 选择固定角色集模式：比 hermes 简单（不引入 per-task complexity），比 claudecode vendor 中立（不写死任何 provider，保留用户主权），比 openclaw 准确（明确"调用上下文隔离"语义而非"成本维度"）；角色集由 `role-spec.ts` 注册表单一事实源驱动，新增角色机械层零改动。
