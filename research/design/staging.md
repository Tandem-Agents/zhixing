# Staging — 架构设计与审核平台

> 介于 [`active-problem.md`](active-problem.md) 工作台与 [`specifications/`](specifications/) 设计权威之间的中转平台。承载**需求已明确、架构待设计与审核**的内容 —— 设计审核通过后进入实施。一次只承载一个 staging topic;实施完成后"当前 staging"区整段清空,等下次启用换 topic。

## 原则

本文档的维护规则。**原则稳定**;下方"当前 staging"区随 topic 生灭整段重写。

- **定位**:本文件承载"需求已明确、架构待设计与审核"的内容。与 [`active-problem.md`](active-problem.md) 区别 —— active-problem 是"产品方向对齐工作台"(要跟用户**对齐需求**,讨论"做什么、不做什么"),staging 是"架构设计与审核平台"(需求已明确,**设计与审核架构**,讨论"怎么做")。需求未明确不放本文件,回 active-problem 对齐
- **工作流是设计 → 审核 → 实施**:架构设计需要至少一轮顶级架构师视角审查通过后才进入实施。审查中发现的真问题在本文件迭代修复,**不是上来就执行**
- **单 topic 承载**:一次只一个 staging topic,与 active-problem 的"一次只一个问题"纪律同构。多个 staging 并存 → 拆到 `drafts/` 或独立 spec,不堆本文
- **顶部原则段**:本文档自身维护规则,永久稳定
- **内容区结构**:每个 staging topic 必须按"明确需求 → 架构设计"两段式组织
  - **明确需求**:**严格保留用户原话精确表达的产品决策**,不擅自扩展、不引入未确认的次要事实、不写"哪些不在范围"等推断内容。任何对此段的修改都必须经过产品方向重新对齐(走 active-problem 流程,而非直接改本段)
  - **架构设计**:实施层面的具体方案(目标 / 层次 / trade-offs / 清单 / 验收)。**本段是审查与迭代的主战场**,所有 grep 验证、调用链梳理、边界判断、范围确认都在本段做,审查发现的真问题在此段精确修复,直到审查通过才动手实施
- **重启规则**:上一个 staging 沉淀完毕,下一个启用前**整段重写**"当前 staging"——不要在旧内容上叠加
- **绝不留模糊问题**:已明确才放本文件,有疑问回 active-problem 重新对齐
- **绝不长期残留**:实施完成立即清理(整段清空回模板态),staging 不是"已完成内容博物馆",归档去 problems / specifications

---

## 当前 staging:摘要质量提升

### 明确需求

1. **摘要压缩的模型档位换成 main**(原 light → main),其他不动
2. **对话上下文压缩的 prompt 结构优化**:借鉴 opencode 取其精华
   - 自动触发压缩 + `/compact` 手动触发是同一套逻辑、同一份 prompt,只是调用点不同

### 架构设计

#### 事实层(grep 验证)

主对话压缩的代码路径:

- **统一装配点**:`createAgentRuntime` 在 [`create-agent-runtime.ts:675`](../../packages/orchestrator/src/runtime/create-agent-runtime.ts) 装配 `flushCallLLM = createCompactionFlush(roles, lightThinking)`。**main runtime 与 workscene/power runtime 共用同一函数装配**(都通过 `createAgentRuntime`),所以同一份代码同时服务"main 主对话压缩"和"workscene 主对话压缩",无需双份改造
- **`flushCallLLM` 同时驱动两个策略**(`create-agent-runtime.ts:681-690`):
  - `LLMSummarize` (priority 200, usage >= 0.9) —— **这是主对话压缩**(生成摘要替换早期消息)
  - `MemoryFlush` (priority 3, usage >= 0.75) —— 这是**记忆提取**(从即将压缩的消息中提取 profile / person / skill / journal 写盘到 memory store),**不属于"主对话压缩"语义**
- **`/compact` 用户主动**走 `forceCompact` → `engine.onTurnComplete` → 同一份 strategies,复用同一 `flushCallLLM`、同一 `MAIN_SESSION_PROMPT` —— 自动 + 手动同源已是事实,无需改造
- `LLMSummarize` 内部用 `getSummarizationPrompt("main-session")` 取 [`MAIN_SESSION_PROMPT`](../../packages/core/src/context/prompts.ts);校验走 `validateSummary` 检查必需章节存在
- `createCompactionFlush` 跨包消费验证:**仅在 `@zhixing/orchestrator` 包内 caller**,没有跨包 import,重命名/拆分无破坏性影响

#### 关键架构选择 — 拆解 createCompactionFlush 共享耦合

当前 `createCompactionFlush` 同时服务 LLMSummarize 与 MemoryFlush 两个策略,共享同一份内部 `roles.light.chat` 调用。这是历史耦合 —— 名字"compaction"暗示只服务压缩,实际两个 strategy 共用。

如果直接把 `createCompactionFlush` 内部从 `roles.light.chat` 改为 `roles.main.chat`,会同时把 MemoryFlush 升级到 main —— **违反用户需求边界**(用户需求是"摘要走 main、其他不动",MemoryFlush 是 JSON 提取写盘、不属于摘要)。

本次借机拆开:**主对话压缩走 main、MemoryFlush 继续 light**,两条独立 LLM 调用入口语义明确分工。这同时消除"compaction-llm.ts 文件名误导"这个历史债。

#### 设计目标

- **严格对齐用户需求边界**:只动主对话压缩(LLMSummarize),MemoryFlush 内部逻辑不动、只换调用源
- **拆解共享耦合**:`createCompactionFlush` 拆为两个语义独立的 helper,caller 一目了然 role 归属
- **Prompt 结构升级**:`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段;`validateSummary` 必需章节同步
- **零跨模块波及**:`createCompactionFlush` 跨包无消费、改造不溢出 orchestrator 包

#### 实施层次

##### Layer 1 · 拆解 compaction-llm.ts 共享耦合

[`packages/orchestrator/src/runtime/compaction-llm.ts`](../../packages/orchestrator/src/runtime/compaction-llm.ts) 重设:

- **删除** `createCompactionFlush(roles, lightThinking)`(命名误导 + 同时服务两个 strategy 是耦合)
- **新增 `createSummarizeCallLLM(roles, mainThinking)`** —— 内部走 `roles.main.chat`,专属 LLMSummarize 主对话压缩用
- **新增 `createMemoryFlushCallLLM(roles, lightThinking)`** —— 内部走 `roles.light.chat`,专属 MemoryFlush 记忆提取用
- 共享一个内部 `callLLMText(role, messages, opts, thinking)` 实现,避免代码重复
- 文件头注释重新组织:两个独立 helper 的职责分工 + 隔离价值描述("独立 ChatRequest 调用,不污染主对话")

##### Layer 2 · create-agent-runtime.ts 装配点拆分

[`packages/orchestrator/src/runtime/create-agent-runtime.ts:675-690`](../../packages/orchestrator/src/runtime/create-agent-runtime.ts) 改造:

```ts
// 改造前(单一 flush 同时给两个 strategy)
const flushCallLLM = createCompactionFlush(roles, lightThinking);
const strategies = [
  createMemoryFlushStrategy({ callLLM: flushCallLLM, store: memoryStore }),
  createMessageDropStrategy(),
  createLLMSummarizeStrategy({ callLLM: flushCallLLM, estimator, ... }),
];

// 改造后(两个独立 helper,语义分工)
const mainThinking = roleThinking.main;  // 新增一行别名,与现有 lightThinking 同款形态
const summarizeCallLLM = createSummarizeCallLLM(roles, mainThinking);
const memoryFlushCallLLM = createMemoryFlushCallLLM(roles, lightThinking);
const strategies = [
  createMemoryFlushStrategy({ callLLM: memoryFlushCallLLM, store: memoryStore }),
  createMessageDropStrategy(),
  createLLMSummarizeStrategy({ callLLM: summarizeCallLLM, estimator, ... }),
];
```

`roleThinking.main` 在装配期已通过 `resolveRoleThinking(roles.main, config.llm?.main?.thinking)` 解析(与 `roleThinking.light` / `roleThinking.power` 同点解析,复用现有装配逻辑),仅需新增一行 `const mainThinking = roleThinking.main` 别名;`lightThinking` 既有别名保留给 MemoryFlush 用。

##### Layer 3 · MAIN_SESSION_PROMPT 结构重写

[`packages/core/src/context/prompts.ts`](../../packages/core/src/context/prompts.ts) `MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段:

```text
你是一个精确的对话摘要助手。请根据以上对话历史,生成结构化摘要。

要求:
1. 用对话的主要语言写摘要正文
2. 保持以下 7 个章节标题不变,按顺序输出
3. 不翻译、不修改代码、文件路径、标识符、错误信息
4. 聚焦事实:讨论了什么、做了什么决策、当前状态
5. 最近的对话内容比更早的内容更重要
6. 「进度」章节的"进行中"必须包含压缩前最后在做的事情的具体细节
7. 「关键上下文」中所有标识符原样保留,不缩写

章节结构:

## 核心目标
[用户的明确请求、成功标准;标注优先级变化和关键修正]

## 约束与偏好
[用户明确表达的工作约束、技术栈偏好、沟通风格;若无显式表达则写"未观察到"]

## 进度
- [完成] 已收尾的事项(简洁列出)
- [进行中] 当前正在做但未完成的事项(必须含到哪一步、具体文件名/代码/步骤)
- [阻塞] 等待外部依赖或用户决策的事项及阻塞原因;若无则省略本子项

## 关键决策
[做了什么决策 + 理由 + 排除的其他选项;无决策则写"未观察到"]

## 下一步
[尚未开始的待办,标注 [ ] 待做 / [~] 进行中;按优先级排序]

## 关键上下文
[接口签名、关键代码片段、不变量、UUID/hash/路径/URL 等技术锚点,原样保留]

## 相关文件
[文件列表,标注 [读][改][建][删];最近修改的附简短代码片段]

重要:只输出摘要文本,不要调用任何工具,不要输出其他内容。
```

**新 7 段对照旧 7 段**:

| 旧章节 | 新章节 | 变化 |
|---|---|---|
| 核心目标 | 核心目标 | 保留 |
| 技术上下文 | 关键上下文 | 重命名 + 合并旧"关键标识符" |
| 文件与变更 | 相关文件 | 重命名,保留 `[读][改][建][删]` 标注 |
| 已解决与未解决 | 进度 [完成] [阻塞] 子项 | 三段合并为三态(吸取 opencode Progress) |
| 待办清单 | 下一步 | 重命名,语义保持 |
| 当前进度 | 进度 [进行中] 子项 | 整合入 Progress 三态 |
| 关键标识符 | 关键上下文(合并) | 合并入"关键上下文" |
| — | **约束与偏好**(新增) | 吸取 opencode 精华 |
| — | **关键决策**(新增) | 吸取 opencode 精华,带"为什么"理由 |

##### Layer 4 · validateSummary 必需章节同步

[`packages/core/src/context/validation.ts`](../../packages/core/src/context/validation.ts) `validateSummary` 函数的必需章节清单同步更新:

- 旧:核心目标 / 技术上下文 / 文件与变更 / 已解决与未解决 / 待办清单 / 当前进度 / 关键标识符
- 新:核心目标 / 约束与偏好 / 进度 / 关键决策 / 下一步 / 关键上下文 / 相关文件

校验逻辑(检查标题存在 + 缺失重试)不变,只改章节名清单。

##### Layer 5 · 测试同步

- [`compaction-llm.test.ts`](../../packages/orchestrator/src/runtime/__tests__/compaction-llm.test.ts) 路由契约测试重写:
  - **`createSummarizeCallLLM` 走 main**:反向 assert `roles.light.chat` 未被调用、`roles.main.chat` 被调用
  - **`createMemoryFlushCallLLM` 走 light**:反向 assert `roles.main.chat` 未被调用、`roles.light.chat` 被调用
  - 旧 `createCompactionFlush` 测试整组替换
- [`prompts-validation.test.ts`](../../packages/core/src/context/__tests__/prompts-validation.test.ts):`MAIN_SESSION_PROMPT` 章节断言改为新 7 段标题
- [`llm-summarize.test.ts`](../../packages/core/src/context/__tests__/llm-summarize.test.ts):如有测试 prompt 章节内容的断言,同步新章节
- [`abort.test.ts`](../../packages/core/src/context/__tests__/abort.test.ts):涉及 LLMSummarizeStrategy 的断言保持(abort 路径不变)

#### 关键 trade-offs(已决策)

| 决策点 | 选择 | 理由 |
|---|---|---|
| `createCompactionFlush` 命名 + 解耦 | **删除并拆为两个语义独立的 helper** | 现名"compaction"误导(实际服务两个 strategy);拆开同时消除耦合 + 严格对齐用户需求边界(只摘要走 main) |
| 通用 `createCallLLM(role, thinking)` vs 两个具名 helper | **两个具名 helper** | caller 一目了然 role 归属;通用 helper 容易错绑(测试断言也更弱) |
| Prompt 章节是否保留 7 段总数 | **保留 7 段,内部重组** | LLM 对固定段数稳定输出经长期实测验证;吸取精华 ≠ 堆段数 |
| `MAIN_SESSION_PROMPT` 改造范围 | **只动主对话压缩 prompt** | 用户原话"主对话压缩";`SUB_AGENT_PROMPT` / `MERGE_SUMMARIES_PROMPT` 不动 |

#### 不在范围

以下条目存在但本次不动:

- **段切换摘要**(`createSegmentSummarizeFn` in context-management v3):独立机制、独立 prompt、独立代码路径(走 `resilientCallLLM` 不走 `flushCallLLM`),不属于"主对话压缩"语义。本次不动
- **WebFetch distill**(`ctx.llm.light.chat`):信息提取/裁剪,不是摘要,继续走 light
- **`SUB_AGENT_PROMPT` 与 `MERGE_SUMMARIES_PROMPT`**:sub-agent 任务恢复 / 合并摘要,用户明确"和子 agent 没关系",不在本次范围
- **light 角色定义与 `secondary-llm-capability.md` 整体描述**:light 仍是合法 role,接口槽位、产品定位、其他 caller(如 WebFetch distill) 全部不动
- **`MemoryFlush` strategy 内部逻辑**:只换 LLM 调用源(从共享 `flushCallLLM` 到独立 `memoryFlushCallLLM`),strategy 内部算法、minBudgetRatio、提取写盘等都不动

#### 实施清单

按依赖顺序:

1. **Layer 1 + Layer 2**:重写 `compaction-llm.ts`(删 `createCompactionFlush`,新增两个 helper);`create-agent-runtime.ts` 装配点改为两个独立调用 + strategies 各自注入。`@zhixing/orchestrator` 包 build 通过
2. **Layer 5 (Part 1)**:`compaction-llm.test.ts` 路由契约测试重写;`pnpm -F @zhixing/orchestrator test` 通过 + 反向 assert 生效
3. **Layer 3 + Layer 4**:`prompts.ts` 的 `MAIN_SESSION_PROMPT` 重写;`validation.ts` 必需章节清单同步;`@zhixing/core` 包 build 通过
4. **Layer 5 (Part 2)**:`prompts-validation.test.ts` / `llm-summarize.test.ts` / 必要时 `abort.test.ts` 同步;`pnpm -F @zhixing/core test` 通过
5. **综合验证**:
   - core + cli + orchestrator + tools-builtin 全包测试零回归
   - 全仓库 grep `createCompactionFlush` 零残留
   - 全仓库 grep 旧章节名(`已解决与未解决` / `待办清单` / `当前进度` / `关键标识符`)在生产代码下零业务命中(仅测试 fixture 中可能保留向后兼容引用,均同步删/改)
   - 手动验证:对话堆到 90% 触发 LLMSummarize → 看是否调 `roles.main` + 输出符合新 7 段;`/compact` 用户主动触发 → 行为与自动触发完全一致

#### 验收

- 全仓库 `createCompactionFlush` 零残留(grep 验证)
- `createSummarizeCallLLM` 走 `roles.main.chat`(`compaction-llm.test.ts` 反向 assert `roles.light.chat` 未被调用)
- `createMemoryFlushCallLLM` 走 `roles.light.chat`(反向 assert `roles.main.chat` 未被调用)
- `MAIN_SESSION_PROMPT` 章节结构与新 7 段匹配(grep `约束与偏好` / `关键决策` / `相关文件` 命中)
- `validateSummary` 必需章节清单与新 7 段对齐
- LLMSummarize(自动) + `/compact`(手动) 触发产生同样结构的摘要(同 prompt + 同 model)
- main runtime + workscene/power runtime 都通过 `createAgentRuntime` 装配,改造一次同时覆盖
- 全包测试零回归

