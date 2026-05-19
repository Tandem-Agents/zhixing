# 档位推荐 (Role Recommendations) — 架构与执行规格

> 把"推荐用什么模型"从 provider 物理层提到档位抽象层。**推荐是档位的属性,不是 provider 的属性** ——
> 档位钉到一对具体 `(provider, model)`,与 provider-model 物理层解耦。

## 需求(已钉死,不再回改)

本节是整份 spec 的根基。以下六条经多轮对齐确认,作为不可回改的设计输入;后续概念、数据模型、架构决策全部由此推导。

- **R1 物理层定义**:物理层 = 服务商-模型(provider 连接信息 + 协议 + model 标识)。基础设施层,**不知道档位存在**,可被多个上层独立消费(档位推荐 / 未来 agent 直接绑定 `(provider, model)` 等)。
- **R2 档位层定义**:档位层 = `main` / `light` / `power` 三档,是 provider-model 物理层**之上**的语义抽象层。
- **R3 两层解耦**:档位层单向引用物理层;物理层不反向依赖档位层(物理层不得出现任何档位概念或对档位数据的依赖)。
- **R4 推荐语义与粒度**:推荐是档位层的语义。每个档位推荐一个,**直接钉死到 (一个服务商, 该服务商下的一个模型) 二元组**。不是推荐"一个模型"(同一模型可能多个服务商提供、且各服务商 model id 不同),而是钉死 provider+model 这一对,消除"用哪个服务商跑这个模型"的二次决策。
- **R5 物理层职责边界**:物理层只提供"可选项",**不提供"推荐"**。推荐的价值判断只属于档位层;provider 不得自我声明"推荐用我的某 model"。
- **R6 渐进范围**:当前只 `main` 档定义推荐;`light` / `power` 预留扩展位,结构不堵死,本期不替它们做产品决策。

## 〇、概念

### 〇.1 两层职责切分

```
┌─────────────────────────────────────────────────┐
│ 档位抽象层 (role tier)                          │
│   - main / light / power                        │
│   - 每档位 → 推荐 (provider, model) 一对钉点    │
│   - 单向引用 provider-model 物理层,反向不知     │
└──────────────────┬──────────────────────────────┘
                   │ references
                   ▼
┌──────────────────────────────────────────────────┐
│ provider-model 物理层                            │
│   - PROVIDER_PRESETS: name/baseUrl/protocol/quirks │
│   - knownModels: 物理层登记过元信息的 model 表    │
│     (单职责 = budget 数据源;id 客观上也是 UI     │
│      可选项之一。不是"该 provider 全部 model")    │
│   - 不含 defaultModel,不含任何"推荐"语义         │
│   - 不知道档位的存在                              │
└──────────────────────────────────────────────────┘
```

**knownModels 语义锚定(R3 关键 · 不可误读)**:`knownModels` 的**单一职责**由 [model-budget-resolution.md §4.1/4.3](../drafts/model-budget-resolution.md) 钉死 = "provider 实例上元信息已知的 model 列表,唯一用途给 budget 解析提供数据;catalog 之外的 model 也能正常请求 LLM"。本 spec **不改变、不扩展、不依赖**这个语义:
- 档位推荐(R4)钉死 `(provider, model)`,`model` 是 provider 范畴的透传字符串(代码事实:[resolve.ts:186](../../../packages/providers/src/resolve.ts) 正常路径 `finalModel = mainConfig.model` 本就是用户自由填的字符串)。**推荐合法性绝不依赖 model 是否在 knownModels** —— 那会把 budget 单职责字段劫持成"推荐边界",违反 R3 解耦、制造新债。
- model-list 面板把 `knownModels` 的 `id` 当"可选项之一"展示,是读"登记表的 id 列",与 budget 解析读"contextWindow 列"互不冲突,不构成身份混淆——合理保留。

**关键约束 — 物理层不知道档位(R1+R5)**:`ProviderPreset` 删除 `defaultModel`、不含任何"推荐"语义字段。物理层只回答"这家 provider 怎么连 + 登记过哪些 model 的元信息",**推荐用哪个由档位层决定**——也可被未来 agent 场景直接绑 `(provider, model)` 消费(R1)。

### 〇.2 推荐是钉点而非泛指

档位推荐是一对 `(provider, model)` 具体值,**不是抽象的 model 名**:

- ✅ `main 推荐 = (deepseek, deepseek-v4-pro)`
- ❌ `main 推荐 = "DeepSeek V4 Pro"`(同一 model 在不同 provider 的 id 不同;`deepseek-v4-pro` ↔ `deepseek-ai/DeepSeek-V4-Pro` ↔ 别家中转)

理由:同一 model 可能被多个 provider 提供(siliconflow 中转大陆其他家 model),且各 provider 上 id 不同。"推荐"必须精确到一对,不能让消费者再做"哪家 provider 跑这个 model"的二次决策。

## 一、当前架构债(为什么要做)

代码实证 [`packages/providers/src/presets.ts`](../../../packages/providers/src/presets.ts) `ProviderPreset.defaultModel` 字段:8 家预设中 7 家声明了 `defaultModel`(deepseek=`deepseek-v4-pro`、siliconflow=`deepseek-ai/DeepSeek-V4-Flash`、qwen=`qwen-plus`、kimi、glm、openai、anthropic;**minimax 未声明**——`defaultModel` 是 optional,这本身就是"provider 自荐与否随意、无统一契约"的债的侧写)。

**唯一根因 = 违反 R5:物理层在自我声明"推荐用我的某 model"。**

`preset.defaultModel` 的本质就是"该 provider 自荐一个 model"。这与 R5(推荐的价值判断只属于档位层,provider 不得自我声明推荐)直接冲突。所有表象问题都从这一个根因派生:

- **派生表象 1(R5)**:同一 model 多 provider、id 不同(R1 现状)。provider 各自荐一个,用户配 main 时进 siliconflow 看到"(默认) deepseek-ai/DeepSeek-V4-Flash",与他想要的 main 推荐(deepseek 直连 v4-pro)是不同二元组却视觉相似 → 认知冲突。根因是"推荐不该由 provider 给"。
- **派生表象 2(R3)**:`defaultModel` 横在物理层,未来 agent 场景直接绑 `(provider, model)`(R1)时,这个 provider 自荐字段对它无意义却永远在数据结构里 —— 物理层被一个上层语义(推荐)污染,违反 R3 解耦。

修复 = 按 R5 删除 `defaultModel`(provider 不再自荐),按 R2/R4 把推荐上提到档位层。**不是"消除 N 份事实源"那种表象叙事,根因只有一个:provider 不该持有推荐语义。**

## 二、数据模型

### 2.1 物理层(改造)

[`packages/providers/src/presets.ts`](../../../packages/providers/src/presets.ts):

```typescript
export interface ProviderPreset {
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  // 删除: defaultModel（R5：provider 不持有推荐语义）
  knownModels?: readonly ModelInfo[];  // 语义不变：budget 数据源（见 §〇.1 锚定）
  quirks: ProviderQuirks;
}

export const PROVIDER_PRESETS = {
  deepseek: {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-compatible",
    // knownModels 维持现状不动：deepseek-v4-pro/flash 因 1M context ≠ 协议
    // 默认 128K 才内嵌（model-budget-resolution.md §4.3）。本 spec 只删
    // defaultModel，knownModels 一字不改。
    knownModels: [ /* 维持现状 */ ],
    quirks: { ... },
  },
  // 其余 provider 维持现状（有无 knownModels 都不动）——本 spec 唯一改动
  // 是删除每个 preset 的 defaultModel 字段，不增删 knownModels。
} satisfies Record<string, ProviderPreset>;
```

### 2.2 档位抽象层(新增)

**新文件** `packages/providers/src/role-recommendations.ts`:

```typescript
import { PROVIDER_PRESETS } from "./presets.js";
import type { RoleId } from "./role-spec.js";

/**
 * 档位推荐 —— 把某档位钉死到一对具体的 (provider, model)（R4）。
 *
 * - provider: keyof typeof PROVIDER_PRESETS —— 编译期约束推荐的服务商必须
 *   是已注册 preset（连接前提:无 preset 就没有 baseUrl/protocol，根本连不上）。
 *   这是 R4 的唯一类型约束,也是唯一需要的校验。
 * - model: string —— provider 范畴的透传字符串(R1)。**不校验**它"在不在
 *   knownModels 里":knownModels 是 budget 数据源(§〇.1 锚定),不是该 provider
 *   的合法 model 全集(网关型 provider 根本无法列举,model-budget §二 已确认);
 *   model 正确性是定义这条推荐时的产品决策,运行时由 provider 透传。让推荐
 *   合法性依赖 knownModels 会违反 R3 解耦并劫持 budget 字段——明确不做。
 */
export interface RoleRecommendation {
  readonly provider: keyof typeof PROVIDER_PRESETS;
  readonly model: string;
}

/**
 * 三档推荐表(R2/R4/R6)。**显式标注 `: Partial<Record<RoleId, RoleRecommendation>>`,
 * 不用 `as const satisfies`** —— 这是 R6 的硬要求,经 TS 语义验证:
 *   - consumer 统一 `ROLE_RECOMMENDATIONS[role]`(role: RoleId)→ 类型恒为
 *     `RoleRecommendation | undefined`,显式分支处理 undefined(与 §三 一致)
 *   - 加一行 `light: {...}` → 类型不变,**零 consumer 代码改动**自动生效(R6)
 *   - provider 笔误仍被拦:赋值需满足 `RoleRecommendation.provider:
 *     keyof typeof PROVIDER_PRESETS`,写不存在的 id 编译报错(约束不丢)
 *   - 反例 `as const`:其字面类型保留对本表 consumer(buildConfigTemplate
 *     拼模板串 / UI 标签比对运行时值)零消费价值,却使 typeof 只含已写出的
 *     键 → consumer `[role]` / `.light` 访问未定义键是**编译错误而非 undefined**
 *     → 直接违反 R6 与"显式处理 undefined"。故明确弃用。
 */
export const ROLE_RECOMMENDATIONS: Partial<Record<RoleId, RoleRecommendation>> = {
  main: { provider: "deepseek", model: "deepseek-v4-pro" },
  light: { provider: "deepseek", model: "deepseek-v4-flash" },
  // power:未定义(R6 扩展位)——加一行即生效,无需改任何 consumer
};
```

**无运行时校验函数(刻意 · R3)**:不提供 `validateRoleRecommendations()`。`provider` 由**显式 `Partial<Record<RoleId, RoleRecommendation>>` 标注下的赋值类型检查** + `RoleRecommendation.provider: keyof typeof PROVIDER_PRESETS` 在**编译期**完全锁死(写不存在的 provider id → TS 直接报错,连不进构建);`model` 是透传字符串,无可校验的客观边界(R1:provider 范畴标识;model-budget §4.1:catalog 之外照常请求)。增设"model ∈ knownModels"校验 = 让档位层反向依赖物理层 budget 数据结构,违反 R3,且劫持 knownModels 单职责——这是上一版的架构错误,本版根除。

### 2.3 删除清单(R5 落地:清除物理层全部推荐语义)

| 字段 / 常量 | 文件 | 处理 |
|---|---|---|
| `ProviderPreset.defaultModel` | [types.ts:141](../../../packages/providers/src/types.ts) | 删除(R5:provider 不持推荐) |
| `ProviderCredentialEntry.defaultModel` | [types.ts:189](../../../packages/providers/src/types.ts) | 删除(凭证侧"覆盖 provider 自荐"同属 R5 违反语义,一并清除) |
| `ResolvedProvider.defaultModel` | [types.ts:441](../../../packages/providers/src/types.ts) | 删除([resolve.ts:84](../../../packages/providers/src/resolve.ts) 的 `entry?.defaultModel ?? preset?.defaultModel` 合并行随之删除) |
| `DEFAULT_MAIN_PROVIDER` 常量 | [presets.ts](../../../packages/providers/src/presets.ts) | 删除,由 `ROLE_RECOMMENDATIONS.main` 完整替代(`PROVIDER_PRESETS` 的 `satisfies` 改造**保留**——`RoleRecommendation.provider` 仍需 `keyof` 字面约束) |

**`knownModels` 不在删除清单**:它是 budget 数据源,与 R5 无关,本 spec 一字不改(§〇.1 锚定)。

**CLI `--provider`/`--model` override 全链路删除(本 spec scope 内 · 见 ADR-RR-006)**:删 `defaultModel`(R5)使 CLI override 唯一的 model 兜底来源消失,该功能无法自洽存在。按用户明确决策,本 spec 完整删除 REPL + serve 两条命令的 `--provider`/`--model` **跨 3 包(cli / orchestrator / providers)全链路**,`resolveMainRole` 简化为 `finalModel = mainConfig.model`。删字段与删功能是同一根因闭合,非 scope 蔓延。**完整删除点见 ADR-RR-006 表(已按 grep 实证逐点核对,含 create-provider.ts / orchestrator / runtime 层——非仅 cli 入口与 resolve.ts)**。

## 三、校验机制(仅编译期 · R3/R4)

### 3.1 编译期(唯一校验层)

`RoleRecommendation.provider: keyof typeof PROVIDER_PRESETS` + `ROLE_RECOMMENDATIONS` 的**显式 `: Partial<Record<RoleId, RoleRecommendation>>` 标注** —— 赋值时 provider 写错(指向不存在的 preset id)立即 TS 报错,连不进构建。`PROVIDER_PRESETS` 的 `satisfies Record<string, ProviderPreset>` 改造(已落地)保留具体 key 字面 union,使 `keyof` 约束生效。

这是**唯一且充分**的校验层:
- `provider` 必须真实可连接 —— 编译期 `keyof` 完全覆盖
- `model` 是 R1 透传字符串,**无客观校验边界**(网关型 provider 无法列举合法 model 全集,[model-budget-resolution.md §二](../drafts/model-budget-resolution.md) 已确认;catalog 之外照常请求)。其正确性是"定义这条推荐"时的产品决策,不是运行时可判定的不变量。

### 3.2 不设运行时校验(刻意决策 · R3)

明确**不提供** `validateRoleRecommendations()` 之类的启动期校验。理由按 R3/R4 推导,非省略:

- 强行加"`model ∈ knownModels`"校验 = 让档位层反向依赖物理层的 budget 数据结构(违反 R3),且把 `knownModels` 单职责劫持成"推荐合法性边界"(违反 §〇.1 锚定,制造新债)。这是上一版的架构错误,本版根除。
- `model` 没有别的"客观全集"可校验(R1)。任何运行时校验都是无依据的自造约束。
- 写错 `model` 的后果 = 该 provider 请求时报 model 不存在,错误清晰、定位直接,不需要前置校验兜底。

**净结论**:本 spec 不引入任何 `role-recommendations.ts` 内的运行时校验函数、不接入 loadConfig 校验钩子、不新增对应单测。校验面 = 编译期 provider 约束,仅此一层。

## 四、Consumer 影响(基于代码逐行核实的完整链路)

`defaultModel` 经全仓 grep 确认承担**三个职责**,删字段必须三个都迁移。按 R5,迁移目标统一:provider 不再兜底 model,推荐由档位层(`ROLE_RECOMMENDATIONS`)给,无推荐命中则要求用户显式选。

| Consumer(代码位置) | defaultModel 当前职责 | 迁移目标 |
|---|---|---|
| [config-loader.ts buildConfigTemplate](../../../packages/providers/src/config-loader.ts) | 模板 main 默认 = `DEFAULT_MAIN_PROVIDER + preset.defaultModel` 派生 | 改为从 `ROLE_RECOMMENDATIONS` 派生:每个有推荐的档位写成生效条目（main 必填恒在、有推荐的辅助档同 active），无推荐的档位（如本期 power）输出诚实 `<provider>/<model>` 注释占位、绝不硬编码 vendor —— 模板恒为推荐表的投影，加一行推荐即自动生效(R4) |
| [resolve.ts:84](../../../packages/providers/src/resolve.ts) | `ResolvedProvider.defaultModel = entry?.defaultModel ?? preset?.defaultModel` | 删除该合并行(`ResolvedProvider.defaultModel` 字段删) |
| [resolve.ts:164-189](../../../packages/providers/src/resolve.ts) `resolveMainRole` + `LLMRolesResolveOptions` | CLI override 解析(modelOverride / providerOverride 分支 + options 形参 + 接口) | **整段删除**(ADR-RR-006):接口删、`resolveLLMRoles`/`resolveMainRole` 去 options 形参、`resolveMainRole` 简化为 `resolved = resolveProvider(mainConfig.provider); finalModel = mainConfig.model`(即原 [:186](../../../packages/providers/src/resolve.ts) 正常路径,become 唯一路径) |
| [panels/list.ts:100-104](../../../packages/cli/src/config-editor/panels/list.ts) | `preset.defaultModel` 作为 model-list **独立 model 来源**(push 进 allModels 首位) | 删除这段;model-list 可选项来源 = `knownModels[*].id`(物理层登记的)+ 用户自定义 model。无 knownModels 的 provider → 仅"+ 添加自定义"(R5 正常推论,见下「行为变更」) |
| [panels/list.ts:128-129](../../../packages/cli/src/config-editor/panels/list.ts) | `=== preset.defaultModel → "预设默认"`;`knownIds → "预设可选"` | 标签整体改为**档位推荐感知**:`role` 来自 PanelDescriptor(已验证携带);`ROLE_RECOMMENDATIONS[role]?.provider === descriptor.providerId` 且 model 命中 → 该行标 `{role} 推荐`;其余无标签(§五) |
| [panels/entity.ts:122-123](../../../packages/cli/src/config-editor/panels/entity.ts) | `fallbackModel = preset.defaultModel`;`displayModel = userSelected ?? fallback` | `fallbackModel` 改为 `ROLE_RECOMMENDATIONS[role]?.provider===providerId ? .model : undefined`;无命中则 `displayModel = userSelected`(可为空) |
| [panels/entity.ts:156-163](../../../packages/cli/src/config-editor/panels/entity.ts) | preview 校验 `previewModel = userSelected ?? fallbackModel ?? ""` 喂 checkModel 决定"完成"按钮 | 同源替换 fallbackModel;无 userSelected 且无档位推荐命中 → previewModel 空 → checkModel 判 model 缺失 → "完成" disabled(R5:不再 vendor 兜底) |
| [panels/entity.ts:177-187](../../../packages/cli/src/config-editor/panels/entity.ts) | "完成"点击写入 `model = userSelected ?? preset.defaultModel` | 同源替换;无 userSelected 且无档位推荐命中 → 不允许完成,强制用户进 model-list 显式选(必填项的正常语义) |
| [cli/registries/providers.ts:12](../../../packages/cli/src/registries/providers.ts) | 注释提及"preset 有 defaultModel" | 注释更新(去掉 defaultModel 提法) |
| 各测试断言(grep 实证 8 文件) | 断言 `preset.defaultModel` / `resolved.defaultModel` 字面值、`DEFAULT_MAIN_PROVIDER`、override 形参 | 派生切到 `ROLE_RECOMMENDATIONS.main.*`;字段删除相关断言移除。涉及:`providers/__tests__/{resolve,config-loader,llm-roles,anthropic-messages,openai-compatible,credentials-loader}.test.ts` + `cli/config-editor/__tests__/{panels-render,state}.test.ts`(**`panels-render.test.ts` 含快照,删 defaultModel 后快照必 fail,需 `-u` 重生并人工核对差异符合 §五 新文案**) |

**行为变更(R5 的确定推论,须显式记录)**:删 `defaultModel` 后,provider 不再自带兜底 model。后果:
- 有 knownModels 的 provider(deepseek/siliconflow):model-list 仍有可选项,体验不变
- 无 knownModels 的 6 家(qwen/kimi/glm/openai/anthropic/minimax):model-list 仅"+ 添加自定义",用户配它们作任何档位都必须**手输 model id**
- 这不是 bug,是 R5 的正确结果(物理层不推荐、不兜底)。`knownModels` 是否补全属 [model-budget-resolution.md](../drafts/model-budget-resolution.md) 范畴,与本 spec **正交**,本 spec 不处理也不依赖

**CLI override 全链路删除(本 spec scope 内 · 跨 cli / orchestrator / providers 三包)**:`--provider`/`--model` 完整分布经全仓 grep 实证 = **cli 入口**:[index.ts:78-79](../../../packages/cli/src/index.ts)(REPL 声明)+ [:121-137](../../../packages/cli/src/index.ts)(REPL/`-p` 传值)+ [:204-205](../../../packages/cli/src/index.ts)(serve 声明)+ [:217-224](../../../packages/cli/src/index.ts)(serve 传值)+ [serve/command.ts:121-122](../../../packages/cli/src/serve/command.ts)(子进程透传)+ [run-agent.ts:51-52](../../../packages/cli/src/run-agent.ts)(`runOnce` 的 `RunOnceOptions.model/provider` → createAgentRuntime);**cli runtime 层**:[repl.ts:1143-1144](../../../packages/cli/src/repl.ts)(写 `cliModel`/`cliProvider`)+ [runtime/types.ts:30-31](../../../packages/cli/src/runtime/types.ts)(`RuntimeSessionOptions.cliModel?/cliProvider?` 字段)+ [runtime/session.ts:247-248](../../../packages/cli/src/runtime/session.ts)(`model: isWorkscene ? undefined : this.opts.cliModel` —— **已实现的 live 消费点**);**orchestrator 入口**:[create-agent-runtime.ts:305-306](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)(`CreateAgentRuntimeOptions.model/provider`)+ [:426-429](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)(`createProviderRoles({ providerOverride: options.provider, modelOverride: options.model })`);**providers 工厂+解析层**:[create-provider.ts:113](../../../packages/providers/src/create-provider.ts)(`ProviderRolesOptions extends LLMRolesResolveOptions` —— **直接 extends 被删接口**)+ [:151-154](../../../packages/providers/src/create-provider.ts)(override 透传)+ JSDoc 135-136 + [resolve.ts](../../../packages/providers/src/resolve.ts) `LLMRolesResolveOptions`/`resolveMainRole` override 分支 + [providers/src/index.ts:49](../../../packages/providers/src/index.ts)(去掉 `LLMRolesResolveOptions` 公共导出)。**全部删除**(REPL + serve,用户已裁决);连带 [secondary-llm-capability.md](secondary-llm-capability.md) §二.1 + [work-mode.md](work-mode.md) 中"workscene 与 cli override 正交"表述(work-mode 已实质实现,session.ts:247-248 即该表述的 live 代码,本 spec PR1 直接删,PR3 同步文档——见 ADR-RR-006)。

## 五、UI 文案设计(已定稿:显式 context 标签)

`preset.defaultModel` 删除后,model-list panel 原有的 "(预设默认)/(预设可选)" 标签**整体移除**(它表达的就是被删的 provider 自我推荐语义)。替代为**档位推荐感知的显式标签**:

- model-list panel 拿到当前 panel context 的 `role`(main/light/power)
- 若 `ROLE_RECOMMENDATIONS[role]` 存在,且其 `provider` 等于当前正在浏览的 provider,则 `ROLE_RECOMMENDATIONS[role].model` 那一行显示标签 **`{role} 推荐`**(如 `main 推荐`),其余 knownModels 平等无标签
- 光标默认停在该推荐行;若 role 无推荐(本期 power 未定义)或当前 provider 非推荐 provider → 无任何标签,光标停首行

**理由**:"main 推荐"四字明示这是**档位维度**的推荐,与 main panel 顶部"主模型"标题逻辑闭合。用户进入任意 provider 都不会再误解为"vendor 内部默认",siliconflow 浏览时不再出现"为啥显示的不是我刚选的 v4-pro"的认知冲突——因为 siliconflow 上没有 main 推荐指向,本就不显示任何推荐标签。

entity panel(provider-config)对应改造,与 §四 entity.ts 三处(122-123 显示 / 156-163 preview / 177-187 完成写入)一致:
- 未选 model 且无档位推荐命中 → "使用模型"行显示"待选"(级别 pending),preview checkModel 判缺失,"完成"按钮 disabled —— **强制用户进 model-list 显式选**(必填项正常语义,R5:provider 不兜底)
- role 有推荐且 provider 命中 → 显示 `(main 推荐) <model>` 作为引导,且 preview/完成以该推荐 model 作默认写入(等价于"档位层给的默认",非"provider 自荐")
- **三处必须同源同改**:只改显示不改 preview/完成 = 出现"看着可完成点了不行"或反之的撕裂(entity.ts 注释自己强调过渲染态与点击态共用同一 state)

## 六、实施计划

每个 PR 独立可验证,顺序基于依赖。

### PR 1 — 物理层 R5 清理 + 档位层抽象

1. 删除 `ProviderPreset.defaultModel`([types.ts:141](../../../packages/providers/src/types.ts))、`ProviderCredentialEntry.defaultModel`([:189](../../../packages/providers/src/types.ts))、`ResolvedProvider.defaultModel`([:441](../../../packages/providers/src/types.ts));[resolve.ts:84](../../../packages/providers/src/resolve.ts) 合并行随之删除
2. 新增 `packages/providers/src/role-recommendations.ts`:`RoleRecommendation` 类型 + `ROLE_RECOMMENDATIONS` 常量(仅 main,light/power 留扩展位)。**无校验函数**(§三.2)
3. 删除 `DEFAULT_MAIN_PROVIDER` 常量(`PROVIDER_PRESETS` 的 `satisfies` 改造保留——`RoleRecommendation.provider` 仍需 `keyof` 字面约束)
4. **CLI `--provider`/`--model` override 跨 3 包全链路删除**(REPL + serve,**完整删除点逐项见 ADR-RR-006 表,按 grep 实证,缺一即编译断裂**):cli 入口(`index.ts` 两命令声明+传值、`serve/command.ts:121-122`、`run-agent.ts:51-52`)+ cli runtime(`repl.ts:1143-1144`、`runtime/types.ts:30-31`、`runtime/session.ts:247-248`)+ orchestrator(`create-agent-runtime.ts:305-306` `CreateAgentRuntimeOptions.model/provider` + `:426-429` `createProviderRoles` override 实参)+ providers(`create-provider.ts:113` `extends LLMRolesResolveOptions` + `:151-154` 透传 + JSDoc、`resolve.ts` `LLMRolesResolveOptions` 接口 + `resolveLLMRoles`/`resolveMainRole` options 形参与 override 分支、`index.ts:49` 公共导出)全删;`resolveMainRole` 简化为 `resolved = resolveProvider(mainConfig.provider); finalModel = mainConfig.model`(同根因闭合:R5 删 defaultModel 使 CLI override 无 model 来源)。**删除须自下而上(providers→orchestrator→cli)单 PR 原子完成——`LLMRolesResolveOptions` 被 create-provider.ts:113 直接 `extends`,半链删除即跨包编译失败**
5. **`knownModels` 一字不动**(§〇.1 锚定)

**验收**:`RoleRecommendation.provider` 写错 → TS 报错(连不进构建);全仓 `defaultModel` 零引用;全仓 `cliModel`/`cliProvider`/`providerOverride`/`modelOverride`/`LLMRolesResolveOptions` 零引用(grep 跨 cli/orchestrator/providers 三包均为空);`zhixing --provider`/`--model` 在 REPL 与 serve 两命令均不存在,`resolveMainRole` 仅 `finalModel = mainConfig.model` 单一路径;`pnpm -r typecheck` 跨 3 包全绿(`create-provider.ts`/`create-agent-runtime.ts`/`runtime/session.ts` 不再引用任何被删符号);`git diff` 中 `knownModels` 改动为空、6 家无 knownModels 的 preset 改动为空;跨包测试零回归。

### PR 2 — Consumer 切换(§四 完整链路)

1. `config-loader.ts buildConfigTemplate` main 默认从 `ROLE_RECOMMENDATIONS.main` 派生
2. `panels/list.ts`:删除 [:100-104](../../../packages/cli/src/config-editor/panels/list.ts) `defaultModel` model 来源段(来源 = knownModels id + 用户自定义);[:128-129](../../../packages/cli/src/config-editor/panels/list.ts) 标签改档位推荐感知 `{role} 推荐`(§五)
3. `panels/entity.ts` **三处同源同改**(显示 122-123 / preview 156-163 / 完成 177-187):去 `defaultModel` 兜底 → 档位推荐命中则用之、否则强制显式选(§四「行为变更」)
4. `cli/registries/providers.ts:12` 注释更新(去 defaultModel 提法)
5. 测试断言派生切到 `ROLE_RECOMMENDATIONS.main.*`,字段删除相关断言移除——逐文件(§四表"各测试断言"行枚举的 8 个);`panels-render.test.ts` 快照 `-u` 重生后人工核对差异仅为 §五 新文案(`{role} 推荐` / 去"预设默认·可选"),无意外渲染回归

**验收**:onboarding main panel = `deepseek · deepseek-v4-pro`;deepseek model-list 中 `deepseek-v4-pro` 行标 `main 推荐`、其余无标签;无 knownModels 的 provider model-list 仅"+ 添加自定义"且 entity"完成"被 checkModel 卡(符合 R5 行为变更,非 bug);跨包测试零回归。

### PR 3 — 文档与索引

1. [secondary-llm-capability.md](secondary-llm-capability.md) §二.1 CLI override 解析章节 + 相关 ADR 删除(随 PR1 CLI 全链路删除同步,避免 spec 与代码漂移)
2. [work-mode.md](work-mode.md) 中"workscene 与 cli override 正交 / 不透传 `opts.cliProvider/cliModel`"表述删除——**该表述的 live 代码 `runtime/session.ts:247-248` 已在 PR1 删除**(work-mode 已实质实现,非未实现 spec),文档须同步,否则 spec↔代码漂移
3. 本 spec 标"已实施";`provider-layer-evolution.md` 如有引用同步
4. spec README 索引补一行(PR 落地时加,避免设计阶段漂移)

## 七、ADR

### ADR-RR-001:档位推荐独立抽象层(R2/R3)

新建 `role-recommendations.ts`,不挂 `ROLE_SPECS` 也不挂 `ProviderPreset`:

- 挂 `ROLE_SPECS`:它是角色集 stable 元数据(id/required/labelZh),不该随产品推荐决策频繁变动而膨胀
- 挂 `ProviderPreset`:本 spec 要消除的正是 provider 自带推荐语义(R5)
- 独立文件 = 产品决策(可变)/ 角色元数据(stable)/ 物理层(基础设施)三层按变化频率物理隔离,落地 R3 解耦

### ADR-RR-002:删除物理层全部推荐语义字段(R5)

`ProviderPreset.defaultModel` + `ProviderCredentialEntry.defaultModel` + `ResolvedProvider.defaultModel` 三者本质都是"provider 维度的自荐 model",违反 R5,一并删除。详见 §一 + §二.3。

### ADR-RR-003:推荐钉死 `(provider, model)` 二元组(R4)

不是推荐 model 名(同一 model 多 provider、id 不同,R1)。详见 §〇.2。

### ADR-RR-004:`ROLE_RECOMMENDATIONS` 用 Partial,未定义即扩展位(R6)

`main`/`light` 已定义,`power` 未定义(本期不做产品决策)。消费者统一显式处理 `undefined`:buildConfigTemplate 对有推荐的档位派生生效条目、对无推荐档位输出诚实占位;UI 无推荐则不显示推荐标签。未定义档位不预设兜底——"不发"安全,"发错"不可控(对齐 [secondary-llm-capability.md §〇.2](secondary-llm-capability.md) 原则 2)。给 `power` 加一行即所有 consumer 自动响应,零 consumer 代码改动(`light` 落地已实证此扩展性:仅改 `ROLE_RECOMMENDATIONS` 一处,无任何 consumer 改动)。

### ADR-RR-005:仅编译期校验 provider,model 不设任何运行时校验(R1/R3)

**关键架构决策。** `provider` 由 `keyof typeof PROVIDER_PRESETS` + `ROLE_RECOMMENDATIONS` 的显式 `Partial<Record<RoleId, RoleRecommendation>>` 标注,编译期完全锁死,这是唯一且充分的校验。`model` 是 R1 透传字符串,无客观全集可校验(网关型 provider 无法列举,[model-budget-resolution.md §二](../drafts/model-budget-resolution.md));任何"`model ∈ knownModels`"式校验都会让档位层反向依赖物理层 budget 数据结构(违反 R3)并劫持 `knownModels` 单职责(违反 §〇.1 锚定、制造新债)。**前一版的 `validateRoleRecommendations` 是此处的架构错误,本版彻底移除**:不设校验函数、不接 loadConfig 钩子、不加对应单测。详见 §三。

### ADR-RR-006:CLI `--provider`/`--model` override 全链路删除(已决策 · REPL + serve 均删)

**产品决策已明确(多次确认):系统不提供任何命令行覆盖 provider/model 的用法,配置驱动(`config.jsonc` 的 `llm.main`)是唯一 main 模型入口。** 本 spec 完整删除全链路,不留任何残代码:

删除点经全仓 grep 实证逐项核对(2026-05-19),跨 **cli / orchestrator / providers 三包**,缺一即跨包编译断裂——`LLMRolesResolveOptions` 被 `create-provider.ts:113` 直接 `extends`,半链删除连不进构建:

| 层 | 删除点 | 代码位置 |
|---|---|---|
| cli 入口 | REPL `-m,--model`/`--provider` 声明 + 传值 | [index.ts:78-79](../../../packages/cli/src/index.ts) + [:121-137](../../../packages/cli/src/index.ts) |
| cli 入口 | serve 声明 + 传值 + 子进程透传 | [index.ts:204-205](../../../packages/cli/src/index.ts) + [:217-224](../../../packages/cli/src/index.ts) + [serve/command.ts:121-122](../../../packages/cli/src/serve/command.ts) |
| cli 入口 | `-p` 单次模式 `RunOnceOptions.model/provider` → createAgentRuntime | [run-agent.ts:51-52](../../../packages/cli/src/run-agent.ts) |
| cli runtime | `cliModel`/`cliProvider` 写入 + 接口字段 + **已实现消费点** | [repl.ts:1143-1144](../../../packages/cli/src/repl.ts)(写入)+ [runtime/types.ts:30-31](../../../packages/cli/src/runtime/types.ts)(`RuntimeSessionOptions.cliModel?/cliProvider?`)+ [runtime/session.ts:247-248](../../../packages/cli/src/runtime/session.ts)(`model: isWorkscene ? undefined : this.opts.cliModel`) |
| orchestrator | `CreateAgentRuntimeOptions.model/provider` + `createProviderRoles` override 实参 | [create-agent-runtime.ts:305-306](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts) + [:426-429](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts) |
| providers 工厂 | `ProviderRolesOptions extends LLMRolesResolveOptions` + override 透传 + JSDoc | [create-provider.ts:113](../../../packages/providers/src/create-provider.ts) + [:151-154](../../../packages/providers/src/create-provider.ts) + JSDoc 135-136 |
| providers 解析 | `LLMRolesResolveOptions` 接口整体删除;`resolveLLMRoles`/`resolveMainRole` 去 `options` 形参;`resolveMainRole` 简化为 `finalModel = mainConfig.model`(正常路径本就如此,override 分支整段删) | [resolve.ts:128-190](../../../packages/providers/src/resolve.ts) |
| providers 导出 | 去掉 `LLMRolesResolveOptions` 公共 type 导出 | [providers/src/index.ts:49](../../../packages/providers/src/index.ts) |
| spec 同步 | §二.1 CLI override 章节 + 相关 ADR;work-mode.md 正交表述 | [secondary-llm-capability.md](secondary-llm-capability.md) + [work-mode.md](work-mode.md)(见下「连带影响」) |

删除顺序:**单 PR 原子完成,自下而上 providers → orchestrator → cli**(被删符号是下游依赖根,逆序删会中途断编译)。

serve 的 `--model`/`--provider` 与 REPL 同性质(命令行绕过 `config.jsonc` 指定模型),server 部署同样靠 `config.jsonc` 的 `llm.main`,一并删——经用户明确裁决。

理由:用户明确不要 + "不留无效代码"原则。**这不是 scope 蔓延**:CLI override 的 model 来源 `defaultModel` 被本 spec 按 R5 删除后,该功能已无法自洽存在(`--provider` 单独将永久无 model 来源),删字段与删功能是同一根因的完整闭合;留半残 `--provider`(单独即报错)反而是新债。

**连带影响(事实修正 · 须标注防实施漏)**:[work-mode.md](work-mode.md) 中"workscene 与 cli override 正交 / 工作场景 runtime 不透传 `opts.cliProvider/cliModel`"的表述,**其 live 代码 `runtime/session.ts:247-248`(`isWorkscene ? undefined : this.opts.cliModel`,注释原文"工作场景 runtime 不透传 cli override")已实现并在上线**(work-mode 已实质落地,见近期 commits `054d774`/`d3a22c1`/`f4c3192`/`c5c1561`/`fbe9049`——**非"未实现 spec",前一版按此误判延后是基于错误事实前提**)。该代码在本 spec **PR1 内直接删除**(不延后):删除不破坏 work-mode core——workscene 分支本就传 `undefined`,`primaryRole=power`/`memoryScope`/`profile` 与 cli override 无关,删后该 createAgentRuntime 入参直接移除即可。work-mode.md 文档侧"正交"表述同步失效,由 **PR3 一并校正**(不再有 cli override,"正交"无对象)。

### ADR-RR-007:UI 标签弃用 provider-内置推荐表述(R5)

"(预设默认)/(预设可选)" 表达的就是被删的 provider 自荐语义,整体移除,改档位推荐感知 `{role} 推荐` 标签。详见 §五。

## 八、验收

- **数据模型**:`ProviderPreset`/`ProviderCredentialEntry`/`ResolvedProvider` 三处 `defaultModel` 全删;`role-recommendations.ts` 仅 main 定义、无校验函数;`ROLE_RECOMMENDATIONS` 加 light/power 行后所有 consumer 无需改代码即响应(R6 验证)
- **编译期(唯一校验)**:`RoleRecommendation.provider` 写不存在 id → TS 报错连不进构建;全仓 `defaultModel` 零引用
- **R5 行为**:onboarding main panel = `deepseek · deepseek-v4-pro`(派生自 ROLE_RECOMMENDATIONS.main);deepseek model-list `deepseek-v4-pro` 行标 `main 推荐`、其余及其它 provider 无标签;无 knownModels 的 provider model-list 仅"+ 添加自定义"、entity"完成"被 checkModel 卡(R5 确定推论,非 bug)
- **R3 解耦**:`git diff` 不含任何 `knownModels` 改动、不含 6 家无 knownModels preset 改动;`role-recommendations.ts` 不 import 任何物理层 budget 结构、无 model 运行时校验
- **CLI override 跨 3 包全链路删除**:`zhixing --provider`/`--model` 在 REPL 与 serve 两命令均不存在;全仓 grep `cliModel`/`cliProvider`/`providerOverride`/`modelOverride`/`LLMRolesResolveOptions` 零命中(cli/orchestrator/providers 均空);`resolveMainRole` 仅 `finalModel = mainConfig.model` 单一路径;`pnpm -r typecheck` 三包全绿(`create-provider.ts:113`/`create-agent-runtime.ts:426`/`runtime/session.ts:247` 不再引用被删符号);`secondary-llm-capability.md` §二.1 已删;`work-mode.md` 正交表述已由 PR3 同步(其 live 代码 session.ts:247-248 已随 PR1 删除——非延后);跨包测试零回归(正常配置驱动路径本就是删除后唯一路径)

## 九、未来扩展

| 项 | 触发条件 | 改动 |
|---|---|---|
| power 档推荐定义 | 产品决策定下 power 用什么 | `ROLE_RECOMMENDATIONS` 加一行,所有 consumer 自动响应（`light` 已按此路径落地为先例：仅一处改动） |
| 推荐运行时可变(如季度切换主推荐) | 主推荐策略需动态调整 | 新增 `getRoleRecommendation(role): RoleRecommendation \| undefined`(常量降为其内部数据源);**消费者从属性访问 `ROLE_RECOMMENDATIONS[role]` 改为函数调用 `getRoleRecommendation(role)`** —— 是一次性显式签名迁移,不是零改动(返回类型仍 `RoleRecommendation \| undefined`,§三 的 undefined 分支逻辑不变,迁移面仅"访问形态") |
| agent 场景直接绑 `(provider, model)` | 用户/产品定义 agent 直接 pin model | agent config 引用 `{ provider: keyof typeof PROVIDER_PRESETS, model: string }` 同形式,与档位推荐复用 `RoleRecommendation` 类型;**与档位解耦,物理层职责清晰**(本 spec 的核心架构准备) |
| `modelExample`(registries/providers.ts)语义重审 | 出现 modelExample / knownModels 漂移 | 独立任务,本 spec 不动 —— modelExample 服务"自定义输入示例",与"推荐"互补不重叠 |
