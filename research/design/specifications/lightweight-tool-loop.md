# 轻量工具循环（Tool Loop）执行规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文档是执行规格(execution spec),不是修订日志。**
>
> **只写**:
> - 当前生效的架构、方案、执行计划
> - 架构决策及其"为什么"(帮助理解当前设计)
> - 与真实代码的对接点(精确到文件路径 + 符号名)
>
> **不写**(协作者修订时一并清理,不要叠加):
> - 版本号、状态徽章、修订日期、"最后更新"行
> - `修订要点 / 修订历史 / vX.X vs vY.Y` 对比表
> - 决策演化标签、废案与新案对比、决策追溯叙事
>
> **演化方式**:设计变化时**原地修改**,不追加"v2.1 修订段"。历史留给 `git log`。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **文件作用**:本文档是知行**轻量工具循环**的权威执行规格。它是一个**来源无关的通用原语**——给定一组工具 + 一个目标,由**代码**发起,让 LLM 在有限轮内自主调度这些工具、达成目标、产出**结构化结果**。它服务"配置 / 引导 / 小处理"这类场景(首个使用者是 MCP server 接入识别,见 [mcp-host.md](./mcp-host.md) 十四),让这些场景不必各自手写一个 LLM 工具循环。
>
> **一句话定位**:`secondary-llm-capability` 给"单发隔离 LLM 调用",本原语在其上补"多轮 + 工具调度 + 结构化产出";与 `subagent`(主 LLM 自主派生的重型完整 loop)正交。

---

## 〇、概念与定位

### 〇.1 为什么需要这个原语

越来越多的小场景需要"让 LLM 拿着几个工具、围绕一个目标自主走几步,最后给个结构化答案":接入识别要"搜 npm → 判断 → 挑主流候选",将来的配置向导、诊断、小处理同理。这些场景的共性是:

- **由代码发起**(不是主对话里 LLM 自己起意),目标和工具集都由调用方给定;
- **工具是少数几个、可信、通常只读**(查询类),无文件写入 / 命令执行那类危险面;
- **要 LLM 的判断力**(换个查法、判断相关性、决定够不够了),但**事实只能来自工具的真实返回**;
- **产出结构化结果**给程序继续用,而非给用户的自由文本。

若每个场景各写一遍"拼 prompt → 调 LLM → 解析它要调的工具 → 执行 → 回灌 → 再问"的循环,就是一场景一循环的重复债务。本原语把这套循环抽成通用件,场景只提供"工具 + 目标 + 结果如何解析"。

### 〇.2 与现有三种 LLM 使用形态的边界(钉死,防概念重叠)

知行已有的 LLM 使用形态,与本原语的关系:

| 形态 | 谁发起 | 轮次 | 工具 | 重量 | 归属 |
|---|---|---|---|---|---|
| `callText`(辅助角色单发) | 代码 | 单发 | 无 | 轻 | `secondary-llm-capability` |
| 主对话 `runAgentLoop` | 用户 | 多轮 | 全工具集 | 重(权限/确认/transcript/压缩/中断) | `core/loop` |
| 子 agent(Task 工具) | **主 LLM** 自主派生 | 多轮 | 由 sub-agent `profile.enabledTools` 固定(当前只读子集、不含 Task 防递归) | 重(同主循环基础设施) | `subagent-execution` |
| **轻量工具循环(本原语)** | **代码** | **多轮** | **任意注入的小工具集** | **轻**(无权限/确认/transcript/压缩) | 本文 |

- **不是 `callText` 的重复**:`callText` 单发、无工具;本原语多轮且调度工具。本原语**建在 `callText` 之上**——每轮决策就是一次 `callText`(见 §三)。
- **不是 `subagent` 的重复**:子 agent 由主 LLM 通过 Task 工具派生,工具集由 sub-agent `profile.enabledTools` 固定(按它过滤父工具集派生,当前为只读子集且不含 Task 防递归),走完整 `runAgentLoop`(权限 / 确认 / transcript / 中断)。本原语由代码发起、工具集任意注入(因为工具是调用方给的可信件)、不碰那套重型基础设施。两者触发者、工具来源、重量都不同,正交。
- **为何不复用 `runAgentLoop`**:它的 params 要求装配 provider 流式、`EventBus`、`InterruptController`、`deps.executeTool`(权限包装)、以及 prompt-cache 死线的 `systemPrompt`——那是为完整对话造的基础设施。我们只读、可信、几个工具的小任务用不上其中任何一项;复用等于把主循环整套耦合进配置 / 引导场景,是高射炮打蚊子式的架构债务。

### 〇.3 核心哲学:事实焊死、判断信任

本原语的设计落实一条产品原则——**把 LLM 的"不稳定"和"智能"分开**:不稳定是"无信息时凭记忆编造",智能是"有真实信息和工具后的判断";后者随模型成长增强,应给予信任。落到机制:

- **事实只来自工具**:LLM 自己不产生任何事实,它要么 `call` 一个工具拿真实数据,要么基于历史里**已经被真实执行过的工具结果**给最终答案。框架保证"LLM 看到的工具结果都是代码真实执行得到的"。
- **判断交给 LLM**:搜什么、换不换查法、够不够了、最终挑哪些——全是它的决策。
- **业务护栏在场景层**:"最终结果里的每一项必须确实来自工具返回""最多 N 个""空了就如实说没有"这类语义校验,由场景层在 `parseFinal` 里强制(见 §二),框架不掺和业务。

---

## 一、核心抽象

四个类型 + 一个函数,全部 provider 无关、可纯 mock 单测。

### 1.1 工具:`ToolLoopTool`

刻意**不复用** `core/types/tools.ts` 的 `ToolDefinition`——后者带 `needsPermission` / `boundaries` / `ToolExecutionContext` 等为"主 agent 危险工具"设计的重型字段。本原语的工具是调用方注入的可信只读件,只需"给 LLM 的描述 + 代码执行":

```ts
interface ToolLoopTool<I = Record<string, unknown>, O = unknown> {
  /** 工具名(LLM 用它指名调用;场景内唯一)。 */
  name: string;
  /** 给 LLM 看的说明:这个工具做什么、何时该用。 */
  description: string;
  /** 给 LLM 看的入参结构(JSON Schema 子集)。 */
  inputSchema: JsonSchema;
  /** 代码执行,返回**真实结果**。signal 透传以支持取消。 */
  run(input: I, signal?: AbortSignal): Promise<O>;
}
```

### 1.2 任务规格:`ToolLoopSpec<R>`

```ts
interface ToolLoopSpec<R> {
  /**
   * 站 LLM 视角写的任务说明:它要达成什么(需求)、什么样算好(预期)、可以怎么做
   * (方法)、最终怎么交付(输出契约)。**不含设计者的反思内容**,只含 LLM 需要的指令。
   */
  goal: string;
  /** 本次可用的工具集(调用方注入)。 */
  tools: ToolLoopTool[];
  /** 轮数硬上限——防 LLM 无限兜圈;到顶仍无有效 final 则返回 exhausted。 */
  maxRounds: number;
  /**
   * 把 LLM 的 "final" 载荷解析 + 校验成结构化结果 R。**业务护栏在此落地**:
   *   - ok    → 收尾,返回 result
   *   - reject→ 把 reason 回灌给 LLM,让它修正后再来一轮(计入 maxRounds)
   * reject 让"违反护栏"能驱动 LLM 自愈(如它编了不存在的项 → 被拒 → 重挑)。
   */
  parseFinal(payload: unknown): { ok: true; result: R } | { ok: false; reason: string };
}
```

### 1.3 依赖注入:`ToolLoopDeps`

```ts
interface ToolLoopDeps {
  /**
   * `callText` 风格的纯文本完成,provider 无关。框架自管多轮 prompt 拼接与决策解析。
   * 生产由调用方绑 AgentRuntime.callText(通常 "main" 档,质量敏感);测试注 mock。
   * signal 为 best-effort:AgentRuntime.callText 当前签名不收 signal、不向底层 LLM
   * 透传,故 abort 不中断在途 LLM 调用,而靠循环框架在轮边界放弃(见 §1.6 step5)。
   */
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
  /**
   * 进度观察(可选)。框架在每轮"让 LLM 决策前""调工具前"同步回调,产出**通用结构化**
   * 进度(见下 `ToolLoopProgress`,零业务概念)。调用方据此翻译成给用户的人话步骤;
   * 不传则无进度。框架只报结构化事件、**不决定文案**(文案是场景层的事,见 §二),且会
   * 吞掉 `onProgress` 抛出的错误——进度是 best-effort 观察,不得因报告失败而坏主循环。
   */
  onProgress?(progress: ToolLoopProgress): void;
}

/** 通用进度事件——框架只报"第几轮、正在做什么",人话文案由场景层翻译。 */
interface ToolLoopProgress {
  /** 当前轮次(1-based)。 */
  round: number;
  /** deciding=正在让 LLM 决策下一步;calling=正在执行某工具。 */
  phase: "deciding" | "calling";
  /** phase=calling 时的工具名。 */
  tool?: string;
  /** phase=calling 时传给工具的入参(供场景翻译文案,如取其中的 query / pkg)。 */
  input?: unknown;
}
```

### 1.4 结果:`ToolLoopResult<R>`(三态)

```ts
type ToolLoopResult<R> =
  | { kind: "done"; result: R; rounds: number }   // parseFinal 通过
  | { kind: "exhausted"; rounds: number }          // 用尽 maxRounds 仍无有效 final
  | { kind: "error"; reason: string };             // complete(LLM 调用)抛错等框架级失败
```

三态不混淆:`done` 有结构化结果;`exhausted` 是"试了但没达成"(场景据此走"没找到 / 请手动");`error` 仅限**框架级失败**(`complete`/LLM 调用抛错、abort)——工具的业务错误(如搜索网络失败)**不进 `error`**,而是回灌让 LLM 应对(见 §1.6 step2)。

### 1.5 入口:`runToolLoop`

```ts
async function runToolLoop<R>(
  spec: ToolLoopSpec<R>,
  deps: ToolLoopDeps,
  signal?: AbortSignal,
): Promise<ToolLoopResult<R>>;
```

### 1.6 决策协议(框架内部,provider 无关)

每轮框架向 `deps.complete` 发一个 prompt,内容 = `spec.goal` + 工具清单(各 `name`/`description`/`inputSchema`) + 决策输出格式 + 到目前为止的历史(每轮 LLM 的决策 + 工具的**真实返回**,长度受控)。要求 LLM 只输出 JSON、二选一:

```jsonc
// 要调工具:
{ "call": { "tool": "<工具名>", "input": { /* 符合该工具 inputSchema */ } } }
// 或给最终结果(交给 spec.parseFinal):
{ "final": <任意结构,由场景 parseFinal 解释> }
```

框架处理:

1. **解析**:抠出 JSON(容错代码围栏 / 前后文字)。此 JSON 抽取作为 `core` 的通用 util 实现——cli 现有 `mcp-setup.ts` 的 `extractJsonObject` 收敛复用此件(消除重复实现)。解析失败 → 回灌"请只输出规定 JSON"并重来一轮(计入轮数)。
2. **`call`**:按 `tool` 名找工具 → `run(input, signal)` → 把真实结果追加进历史 → 下一轮。**工具相关错误一律回灌、不终止循环**:工具名不存在 / 入参非法 / `run` 执行抛错(如搜索网络失败)→ catch 后转成结果回灌历史,让 LLM 下一轮应对(重试 / 换策略 / 放弃)。这与主循环"工具错误作 observation 回灌"一致——一次工具失败不终止整个任务(由 LLM + `maxRounds` 兜底);只有 `complete`(LLM 调用)抛错才是无法继续的框架级失败 → `error`。
3. **`final`**:调 `spec.parseFinal(payload)`。ok → `done`;reject → 把 `reason` 追加进历史、继续下一轮。
4. **轮数**:每次向 LLM 发问算一轮;到 `maxRounds` 仍未 `done` → `exhausted`。
5. **abort**:保证落在**循环框架层**——每轮边界检查 `signal.aborted`,已 abort 则不再发起新调用、放弃在途结果、以 `error`(aborted)收尾(与现有 `mcpResolve` "面板取消即放弃等待、丢弃后台结果"语义一致)。`signal` 也传给 `tool.run`(走 `createSafeFetch` 的工具能真正中断)与 `complete`(best-effort:绑 `callText` 时当前不透传底层,见 §1.3)。
6. **进度**:每轮调 `complete` 前报 `{round, phase:"deciding"}`;解析出 `call`、`tool.run` 前报 `{round, phase:"calling", tool, input}`——经 `deps.onProgress`(若提供)。框架只报结构化进度,人话文案由场景层翻译。

> 历史长度控制:工具返回可能较大(如搜索结果列表),框架按"保留最近 + 截断超长单条"的朴素策略控制 prompt 体积。**当下**够用即可(见 §五 YAGNI),不引入摘要 LLM。

---

## 二、职责边界(铁律)

| 关注点 | 通用框架(本原语) | 场景层(调用方) |
|---|---|---|
| 循环控制 / 轮数上限 | ✅ | |
| 决策协议解析(call / final) | ✅ | |
| 按名字调度工具、回灌真实结果 | ✅ | |
| abort 透传、三态收尾 | ✅ | |
| 进度事件产出(结构化 `onProgress`) | ✅ | |
| 具体工具是什么、怎么执行 | | ✅ |
| 任务 goal 怎么写 | | ✅ |
| 结构化结果 schema 与**业务护栏** | | ✅(`parseFinal`) |
| 进度文案翻译(结构化进度 → 给用户的人话) | | ✅ |
| 结果怎么消费 | | ✅ |

**铁律:框架代码里不得出现任何具体业务概念**(不知道"MCP""npm""候选"为何物)。一旦出现,它就不再通用,是债务。

**业务护栏如何"焊死事实"而不进框架**:场景层提供的**工具**和 **`parseFinal`** 是同一作用域里的闭包,可共享状态。典型做法——工具 `run` 每次把真实返回**累积**进一个场景私有集合,`parseFinal` 校验"LLM 给的最终项是否都在这个真实集合里",不在就 reject。于是"不许编造"成了场景层闭包内的事实约束,框架只管把 reject 回灌、让 LLM 自愈。

---

## 三、LLM 注入与可升级性

- **当下**:`deps.complete` 是 `callText` 风格的纯文本完成。框架内部用"文本 + JSON 决策协议"模拟工具调用——LLM 不需要 provider 的原生 tool_use 能力。生产由调用方把 `AgentRuntime.callText`(见 `packages/orchestrator/src/runtime/create-agent-runtime.ts` 的 `callText`,通常传 `"main"` 档)绑成 `complete`。
- **升级路径(解耦边界已留好)**:将来若要用 provider **原生 tool_use**(标准 agentic 形态),只改本原语**内部**:`ToolLoopDeps` 换成"带 tools 的 chat"形态、决策解析从"读 JSON"换成"读 tool_use block"。`ToolLoopTool` / `ToolLoopSpec` / `ToolLoopResult` 接口与**所有场景层代码不动**。这是把"决策来源"与"工具执行 + 结果结构"解耦的回报。

---

## 四、YAGNI 边界(当下实现 vs 留白)

格局要打开(通用接口现在就立、来源无关、不漏任何业务概念),但实现不堆没人用的特性——**接口通用,实现只长出首个场景当下需要的最小能力**:

**当下实现**:串行(每轮至多一个工具调用)、文本-JSON 决策、固定 `maxRounds`、朴素历史长度控制、三态结果、**结构化步骤进度**(`onProgress`)。

**留白(接口已兼容,等第二个场景按需长,不预先做)**:并行多工具调用 / **LLM token 级流式输出**(注:步骤级进度已支持,这里指逐 token 流)/ provider 原生 tool_use(见 §三)/ 复杂终止策略(如置信度阈值)/ per-loop token 预算 / 历史的 LLM 摘要压缩。

---

## 五、归属与对接点

- **归属包**:`packages/core`(引擎底座,与主循环 `runAgentLoop` 同域、一重一轻)。依据**依赖事实**——本原语零上层依赖(`complete` / 工具都注入)、唯一类型依赖 `JsonSchema` 就在 `core/types/tools.ts`;放 core 则 cli / orchestrator / mcp / server 全可复用(均依赖 core),放更上层(如 orchestrator)会让 `@zhixing/mcp` 等**不依赖 orchestrator** 的包够不着它。建议落 `packages/core/src/tool-loop/`。
- **复用**:LLM 调用复用 `secondary-llm-capability` 角色体系——调用方(如 cli)用 `AgentRuntime.callText(prompt, role)` 绑 `complete`,不新建 LLM 通道。
- **不依赖**:同包的 `core/loop` 主循环、`subagent`、安全管线、transcript、`EventBus`——一概不碰;仅用 `core/types` 的 `JsonSchema`。决策协议的 JSON 抽取作为 `core` 通用 util 落地,`@zhixing/cli` 现有 `mcp-setup.ts:extractJsonObject` 收敛复用此件,不再各自实现(消除重复)。

---

## 六、测试拓扑

纯逻辑、注入 mock,无真网无真 LLM、无定时器:

- 多轮调度:mock `complete` 依次返回 `call`→`call`→`final`,断言工具被按序调用、历史正确回灌、`done` 携带 `parseFinal` 结果。
- 护栏自愈:`parseFinal` 先 reject 后 ok,断言 reason 回灌且最终 `done`。
- `exhausted`:`complete` 恒返回 `call`,断言到 `maxRounds` 收 `exhausted`。
- 解析容错:`complete` 返回带代码围栏 / 噪声的 JSON、非法 JSON,断言抠取成功 / 优雅重试。
- 工具异常 / LLM 异常 → `error`;abort → 立即 `error`(aborted)。
- 进度:注入 `onProgress` mock,断言每轮按序收到 `deciding` → `calling`(带 `tool`/`input`)事件,轮次递增。

---

## 七、首个使用者

MCP server 接入识别——把"输入精确包名"升级为"输入关键词 → 搜索引导 → ≤5 真实主流候选 → 选 → grounded 提取"。它注入 `searchMcpServers` + `fetchMcpServerSource` 两个工具、写接入 `goal`、在 `parseFinal` 里强制"候选 ⊆ 真实搜索集 + ≤5 + 空则没找到"。详见 [mcp-host.md](./mcp-host.md) 十四。
