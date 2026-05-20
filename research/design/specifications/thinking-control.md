# 模型思考控制 — 用户配置

> Provider 层 + config 层既有需求(一直未做),与 [work-mode.md](work-mode.md) **正交**(work-mode 的 primaryRole 决定"用哪个角色的模型",本 spec 决定"那个模型思考多深";二者在 power/light 角色上协同,互不依赖)。本文档只写目标设计与实施计划。

## 总览与原则

知行能**接收**模型思考输出(`reasoning_content` → 内部 ThinkingBlock),但**完全没有**思考控制的发送侧与用户配置。本 spec 补这个缺失维度。

三条原则(已基于事实拍定,非待议):

1. **还原各模型官方原生形态,不做统一抽象**。事实依据:四家思考控制是四个不同维度(见下),且同家跨版本档位会变(claude opus4.6/4.7 不同)。强行统一成 off/low/med/high/max → 必然对不支持的模型发无效值 → 效果不可控。配置项必须 1:1 还原官方参数与档位。
2. **没配就不发**(安全兜底)。不发 < 发错:未配置思考控制时,请求不带任何思考参数,服务端用其自身默认(deepseek 实证 = thinking enabled + effort high)。发错档位结果不可控,不发是确定安全的。
3. **能力元数据驱动**。模型的思考控制形态作为 preset per-model 元数据声明;config-editor 与 adapter 发送侧都由这份元数据驱动,不在代码里散落 per-provider 分支。

## 官方事实依据

四家官方思考控制形态(deepseek 经 WebFetch 官方确认,glm/qwen/kimi 经官方文档站确认;逐模型精确枚举待实施时按模型补查填 preset):

| Provider | 形态 | 官方参数 | 档位/取值 | 默认(不传) |
|---|---|---|---|---|
| **DeepSeek** | 开关 + 离散 effort | `thinking`(enabled/disabled)+ `reasoning_effort` | high / max(low,med→high;xhigh→max) | enabled + high |
| **GLM 智谱** | 纯开关(部分强制) | `thinking.type`(enabled) | 无强度档;GLM-5.1/5/5-Turbo/4.7 强制思考无开关、4.6/4.5 模型自判;4.7 支持轮级开关 | enabled |
| **Qwen 通义** | 开关 + 连续 token budget | `enable_thinking`(bool)+ `thinking_budget`(token 数) | budget 为数值非档位,约束 max_tokens > budget;仅阿里云 Model Studio 原生 | enable_thinking true |
| **Kimi Moonshot** | 开关(分两类模型) | `thinking.type`(enabled/disabled) | kimi-k2-thinking 专用思考模型强制开;kimi-k2.6 可开关 | enabled(可开关型) |

**结论**:四家分属 离散 effort / 纯开关(含强制)/ 连续数值 budget 三种不同维度,无公共可统一的"档位"语义。这是"不统一抽象"原则的事实根据。

## 现状缺口(代码实证)

- **配置 schema**:`providers/types.ts` `LLMRoleConfig = { provider, model }`(L272),`ZhixingConfig.llm = { main; light?; power? }`(L301)—— 无思考配置字段。
- **能力声明**:`ProviderQuirks.supportsThinking`(L67-85,provider 粗粒度 boolean)+ `ModelInfo.supportsThinking`(per-model boolean)—— 只表达"支不支持",不表达"支持哪种形态/哪些档位"。
- **adapter 发送侧**:`adapters/openai-compatible.ts` 仅接收侧透传 `reasoning_content` → ThinkingBlock(L41-64),请求构造无任何 thinking 参数发送;`anthropic-messages.ts` 注释明示"Claude thinking 当前未接入,请求路径未传 thinking 参数"。
- **配置入口**:`cli/src/config-editor/sections/model.ts` 配 `config.llm.<role>.{provider,model}`(onboarding 与未来 /config 共用此模块),无思考配置项。

## 设计

### 思考控制类型(还原官方,不抽象)

preset per-model 声明 `thinkingControl`,枚举四类(覆盖现有四家;新形态新增类型,不归一已有):

- `none` — 不支持思考,或强制思考且无任何可配项(如 kimi-k2-thinking、GLM 强制思考模型)。无配置项。
- `toggle` — 纯开关(GLM 可自判模型、kimi-k2.6)。配置项 = 开/关。
- `toggle+effort` — 开关 + 离散官方档(DeepSeek)。配置项 = 开/关 + 官方档枚举(deepseek: high/max)。**档位值是官方原值,不映射**。
- `toggle+budget` — 开关 + 数值预算(Qwen)。配置项 = 开/关 + token 数值(带官方约束提示 max_tokens > budget)。

元数据形态(挂 preset per-model,具体字段名实施定):类型 + 官方参数名 + 官方档位枚举/数值范围 + 服务端默认。`supportsThinking: boolean` 由 `thinkingControl: "none"` 等价表达,可保留 boolean 作 UI 粗标兼容、新增 `thinkingControl` 作权威。

### 配置位(per-role)

`LLMRoleConfig` 扩展可选思考配置:`{ provider, model, thinking? }`。`thinking` 形态随该 model 的 `thinkingControl` 类型而定(toggle: bool;toggle+effort: { enabled, effort };toggle+budget: { enabled, budget })。

**per-role 而非 per-model**:思考强度跟使用语境走 —— light 做记忆提取 / WebFetch 蒸馏 / 工具结果摘要等 I/O 边界净化应可关思考省钱省延迟,power 接重活应可拉满,main 用户自选(注:主对话压缩 LLMSummarize 走 main 不走 light,见 [secondary-llm-capability ADR-SLLM-009](secondary-llm-capability.md))。与 work-mode 的 primaryRole 正交互补(primaryRole 选角色,本字段定该角色思考深度)。`config.llm.{main,light,power}.thinking` 各自独立。

### config-editor 集成(section 入口不变,配置在 panel 步骤)

`sections/model.ts` 实证是 **per-role 入口聚合**(遍历 `ROLE_SPECS` 为 main/light/power 生成入口,`enterTarget` 指向 provider-list 面板),**不渲染配置控件** —— 配置交互在 **panels/ 层**(provider-list → 选 provider → 选 model)。思考配置作为 **model 选定后新增的 panel 步骤**,由该 model 的 `thinkingControl` 元数据驱动,**复用现有 panel 类型**:`toggle` / `toggle+effort` 用 list panel(开关 + 官方档枚举原值)、`toggle+budget` 用 input panel(数值 + 约束提示)、`none` 跳过该步骤。写入 `config.llm.<role>.thinking`。section 层与 `checks/model.ts` 校验单一源不变(均已对得上现状);onboarding 与 /config 共用 config-editor 模块,改 panel 流程两入口覆盖。

### thinking config 传输机制(config → adapter)

`core/types/llm.ts:149 ChatRequest` 实证**无 thinking 字段**,adapter `chat()` 唯一入参是 ChatRequest —— 必须定义传输管道,否则 adapter 拿不到配置(PR3 无法执行)。方案遵循现有 model/systemPrompt/tools 同模式,adapter 保持无状态:

- `ChatRequest` 加 `thinking?: ThinkingConfig`(`core/types/llm.ts`)。
- **统一规则:thinking 跟随该 LLM 调用点实际使用的 role**(不硬编码、不与 work-mode 段切换归正耦合)。装配期(`create-agent-runtime.ts` 内有 config)经各调用点**函数参数**注入对应 role 的 thinking —— 不在 adapter / 无状态函数内读 config。grep 实证 **三条独立 ChatRequest 构造路径**(非两条),须全覆盖:
  - **① 主对话**:`runAgentLoop`(L951)内部(`core/loop/llm-call.ts`)构造 ChatRequest —— runAgentLoop 增 thinking 入参,装配期传当前 active role 的 `config.llm.<role>.thinking`,内部构造时填。
  - **② compaction / callText / flush strategies**:压缩域拆为两条独立 helper（`compaction-llm.ts`),按 task 性质分流到不同 role(见 [secondary-llm-capability.md](secondary-llm-capability.md) ADR-SLLM-009):
    - **主对话压缩(LLMSummarize)**:`createSummarizeCallLLM(roles, mainThinking?: ThinkingConfig)` 走 `roles.main.chat`,装配期传 `config.llm.main?.thinking`(`roleThinking.main`)
    - **记忆提取(MemoryFlush)+ callText**:`createMemoryFlushCallLLM(roles, lightThinking?: ThinkingConfig)` 走 `roles.light.chat`,装配期传 `config.llm.light?.thinking`(`roleThinking.light`);RuntimeSession 的 `callText` 复用此 helper,保持原 light 通道行为
    - 两个 helper 共享内部 `callLLMText(role, thinking)`,各自 caller 一目了然 role 归属,单测可反向 assert 另一个 role 的 chat 未被调用
  - **③ 段切换摘要**:`segmentStreamFactory` / `createSegmentSummarizeFn`(L751,直接构造 ChatRequest 调 resilientCallLLM,实证无 thinking,独立于 ①②)—— 装配期按其实际 role(现状 roles.main、work-mode 段切换归正后 roles.light;本 spec 只跟随实际 role、不预设、不依赖 work-mode 时序)的 `config.llm.<role>.thinking` 注入该构造处。
- `bindRole` 现有 `chat:(request:Omit<ChatRequest,"model">)=>provider.chat({...request,model})` 链天然透传 thinking 字段,不改 bindRole。
- adapter 仅按 `ChatRequest.thinking` 组装,不读 config、不持状态。

### adapter 发送侧

adapter 按 `ChatRequest.thinking` + 该 model `thinkingControl` 元数据,组装**官方原生参数**(deepseek: `thinking` + `reasoning_effort` 原值;glm/kimi: `thinking.type`;qwen: `enable_thinking` + `thinking_budget`)。各 adapter 内按 provider 方言组装,不跨家归一。`ChatRequest.thinking` 缺省 → 不发任何思考参数(原则 2)。

### 兜底不变量

`config.llm.<role>.thinking` 缺省 → 请求不带思考参数 → 服务端默认。配了不被该 model 支持的形态(如 model 切换后旧配置残留)→ 校验层(`config-editor/checks/model.ts` 同款)拦截或装配期忽略并 warn,**绝不发送无效参数**。

## 实施计划

**PR 1 — 思考控制元数据 + model catalog 建设**:preset per-model 加 `thinkingControl`(类型 + 官方参数 + 档位/范围 + 默认)。**实质工作量须承认**:仅 deepseek / siliconflow 现有 `knownModels`;qwen / kimi / glm / openai / anthropic / minimax **六家无 knownModels,需从头建 model catalog** 再填 thinkingControl(非"给已有字段加属性")。逐模型精确枚举此 PR 内按模型 WebFetch 官方补全。`supportsThinking` boolean 保留兼容。验收:元数据单测;现有路径零回归。

**PR 2 — schema + 传输管道**:`LLMRoleConfig` 加 `thinking?`;`ChatRequest` 加 `thinking?: ThinkingConfig`(`core/types/llm.ts`);**多条** ChatRequest 构造路径各从对应 role 的 `config.llm.<role>.thinking` 装配期注入(bindRole 链天然透传):① runAgentLoop 主对话(增 thinking 入参,active role);② 压缩域两 helper:`createSummarizeCallLLM(roles, mainThinking)` 接 `config.llm.main?.thinking` + `createMemoryFlushCallLLM(roles, lightThinking)` 接 `config.llm.light?.thinking`(两者均按各自 role 的 thinking,见 secondary-llm-capability ADR-SLLM-009);③ segmentStreamFactory 段切换摘要(按其实际 role);config 校验按选中 model 的 `thinkingControl` 校验形态合法性(类型不匹配拦截/warn)。验收:schema + ChatRequest 透传单测;非法组合被拦;未配时 ChatRequest.thinking 为 undefined。

**PR 3 — adapter 发送侧(含 claude signature replay 强制子任务)**:openai-compatible / anthropic adapter 按 `ChatRequest.thinking` + model `thinkingControl` 组装官方原生参数;未配不发。**claude 分支强制伴生子任务**:接入 anthropic thinking 发送侧时,必须同 PR 实现 thinking block `signature` 的 multi-turn replay 原样回传(对标 `openai-compatible.ts:313-319` deepseek `reasoning_content` replay);`anthropic-messages.ts:160` 现状静默丢弃 `signature_delta`,须改为捕获 + 出站原样回传 —— 否则 Anthropic 多轮请求 400。此为协议正确性必要条件,非可选增强。验收:各 provider 桩测发送参数符官方;未配请求无思考参数;anthropic thinking 多轮 replay 带 signature 不被 400;现有接收侧零回归。

**PR 4 — config-editor panel 集成**:section 层(`sections/model.ts`)per-role 入口不变;model 选定后新增 panel 步骤,按 `thinkingControl` 复用 list/input panel 渲染,写 `config.llm.<role>.thinking`;`checks/model.ts` 校验单一源不变;onboarding + /config 两入口验证。验收:四类型 model 各渲染正确控件;`none` 跳过该步骤;端到端配后 adapter 正确发送。

## 开放问题(实施时按事实补,非架构决策)

1. **Claude / OpenAI 思考形态待补查**:本轮只查实 glm/deepseek/qwen/kimi。Claude extended thinking、OpenAI 系 reasoning_effort 形态,PR 1 实施时 WebFetch 官方补查后归入对应 thinkingControl 类型(以官方为准,不预设)。注:Claude thinking 的 `signature` multi-turn replay **已移出开放问题** —— 提为 PR 3 内 claude 分支的协议必要强制子任务(见 PR 3)。
2. **逐模型精确枚举**:GLM 各版本强制/自判边界、Qwen budget 推荐范围与 max_tokens 约束、Kimi 各型号专用思考 vs 可开关 —— PR 1 按模型 WebFetch 官方填 preset,属数据填充非设计。
3. **Qwen thinking_budget 兼容性**:官方注明 thinking_budget 仅阿里云 Model Studio API 原生(vLLM 等需框架支持)。preset 标注 model 来源端点,非该端点降级为 toggle。
4. **role thinking 默认策略**:是否给 light/power 一个出厂默认(light 倾向 off 省钱、power 倾向拉满)还是一律不发交服务端默认。倾向后者(原则 2 一致,最安全);出厂默认作为可选增强,PR 4 内定。
