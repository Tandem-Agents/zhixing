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

## 当前 staging:新对话自动命名

### 明确需求

1. **触发时机**:在一个**新对话**的**第一轮沟通结束后**,用 light 档模型给对话起一个名字,直接落到对话名上
2. **一次性**:此功能**永远只触发一次**——新对话第一轮 turn 结束的瞬间。触发完此功能结束,与后续任何流程无关。后续重命名(如用户手动 `/name <name>`)是独立机制,跟本功能不冲突
3. **触发前置判断**:创建时已经有名字的对话,直接不触发(name 不为空就不命名)
4. **作用域**:main 模式和 work 模式一致行为

### 前置 bug 修复(确认需要)

work 模式当前实现 [repl.ts:1432](../../packages/cli/src/repl.ts#L1432)(`applyModeSwitch` enter 分支步骤 ②)`worksceneRepo.create({ name: scene.name })` 把 `scene.name` 直接作为新建 conversation 的 name。意味着每次 `/enter <scene>` 都新建一个 name=场景名 的对话,**N 次进入同一场景产生 N 个同名对话,无法区分**。

此 bug 在自动命名机制落地前必须修复,否则:
- work 模式对话进入瞬间 name 已不为空(等于 scene.name),自动命名机制按"已有名字不触发"规则会跳过 → work 模式永远拿不到自动命名 → 与"main/work 一致"需求冲突
- 即便不做自动命名,N 个同名对话本身就是产品缺陷(未来 workscene 历史对话访问能力一接入就爆炸)

修复方向:`applyModeSwitch` enter 分支创建对话时**不传 name**(让 `convRepo.create` 走默认 `name = autoChatId() = id` 的 sentinel,与 main 模式 `/new` 无参一致),让自动命名机制统一接管。

### 架构设计

#### 事实层(grep 验证)

1. **`Conversation.name` 是 `string` 不是 `string | null`** ([core/conversation/types.ts:15](../../packages/core/src/conversation/types.ts#L15))。`ConversationRepository.create({})` 不传 name 时,[repository.ts:122-127](../../packages/core/src/conversation/repository.ts#L122) `id = autoChatId()` + `name: opts.name ?? id` —— **未命名 conversation 的 name 默认等于 id**(如 `chat-20260521-a3f1`),不是 null。这是 sentinel value。
2. **"未命名"判定 sentinel** = `conversation.name === conversation.id`。
3. **`ConversationRepository.rename(id, name)`** ([repository.ts:141](../../packages/core/src/conversation/repository.ts#L141)) 现成,原子写 meta.json。
4. **turn 完成主路径钩子位置** = [repl.ts:2001-2007](../../packages/cli/src/repl.ts#L2001) `commitTurn` 返回 canonical 之后、`turnCounter++` 处。此处是 turn 边界、状态全闭合、`state.conv` 全字段可用。
5. **light LLM 调用通道** = `session.runtime.callText(prompt)` ([orchestrator/runtime L180](../../packages/orchestrator/src/runtime/create-agent-runtime.ts#L180)),内部走 `roles.light.chat`(见 `createMemoryFlushCallLLM` ADR-SLLM-009)。无需新加 helper。
6. **work 模式 conversation 创建点** = [repl.ts:1432](../../packages/cli/src/repl.ts#L1432) `applyModeSwitch` enter 分支的 `worksceneRepo.create({ name: scene.name })`。这是要修的 Phase 0 改动点。
7. **typeahead 候选 label 已经处理 fallback** ([repl.ts:1635](../../packages/cli/src/repl.ts#L1635)) `label: c.name || c.id` —— 但 `c.name || c.id` 在 c.name 是 id 时仍显示 id,体验降级。这正是本次自动命名要解决的问题。
8. **REPL prompt 不显示对话名字** ([typeahead-input.ts:181](../../packages/cli/src/typeahead-input.ts#L181)) `❯ ` 是固定 prompt。对话名字的真实显示点只有两处:
   - 启动 welcome chrome row3 一次性渲染 ([workbench/welcome.ts:67](../../packages/cli/src/workbench/welcome.ts#L67),闭包局部变量 `resumedConversationName`,启动后不再刷新)
   - `/switch` typeahead 候选 label(实时读 `convRepo.list()`,每次弹列表都取最新 meta)
9. **`ConversationRuntimeState`(`state.conv` 类型)无 name 字段** ([repl.ts:112-126](../../packages/cli/src/repl.ts#L112))。字段仅:`messages / store / convRepo / conversationId / turnCounter / lastToolEndCount / hasProposedSkill / journalCondenseDone`。**conversation.name 用磁盘 meta 单源**(`convRepo.get(id).name`),不缓存到内存。
10. **`/name` handler 也是磁盘单源行为** ([repl.ts:582](../../packages/cli/src/repl.ts#L582)) 仅调 `convRepo.rename()` 写盘,不触发 `onConversationChanged`,不更新任何 UI 缓存。自动命名应遵循同款简洁模式。
11. **`Turn` 类型字段** ([transcript/types.ts:34-39](../../packages/core/src/transcript/types.ts#L34)) `userMessage: Message` + `assistantMessage: Message` 等。`runResult.turn.userMessage` 是 turn 完成钩子位置可直接取到的精确数据源。
12. **`extractText(message: Message): string`** 现成工具 ([types/messages.ts:112](../../packages/core/src/types/messages.ts#L112)),从 `@zhixing/core` 导出。已被 [repl.ts](../../packages/cli/src/repl.ts) 多处使用(如 [workscene 纪要 prompt 构造](../../packages/cli/src/repl.ts#L186))。**直接复用,不引入新 message→text 工具**。

#### 核心抽象

**`InferConversationName` 类型**(放在 [core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 新文件):
```ts
/**
 * 推断对话名字 —— 基于第一 turn 的 user message 生成简短主题字符串。
 * 失败 / 异常 / 内容不合格 → 返回 null(caller 静默不更新)。
 * 成功 → 返回经 sanitize 的短名字。
 *
 * 接单条 Message(userMessage)而非 Turn:命名的稳定信号源是用户首句的 intent,
 * assistant 回复 / toolCalls / usage 与命名无关。接口收窄到 Message:
 *   - 模块依赖更短(conversation → types/messages,不引入 transcript/Turn 依赖)
 *   - 防未来误用 turn 其他字段(toolCalls 等做命名 → 噪音)
 *   - 与 sanitize / extractText 同款"基础类型为输入"的约定一致
 */
export type InferConversationName = (
  userMessage: Message,
) => Promise<string | null>;
```

**`maybeAutoNameFirstTurn` helper**(同文件,纯函数 + 二次门控):
```ts
/**
 * 一次性自动命名机制:新对话第一轮 turn 完成后触发一次,永远只触发一次。
 *
 * 主路径瞬时 short-circuit:turnCounter !== 1 直接 return,主路径零额外 IO。
 * 异步分支(turnCounter === 1 时)才做磁盘读 + LLM 调用:
 *   1. 读 conv.meta 检查 name === id (未命名 sentinel)
 *   2. inferName(userMessage) 生成短名字
 *   3. 二次门控:重读 conv.meta 确认 name 仍 === id (防 inflight 期间用户 `/name`)
 *   4. convRepo.rename 写磁盘
 *
 * 返回 `Promise<void>`(供测试 `await` 等待异步完成);调用方主路径用 `void` 不 await,
 * 实现 fire-and-forget 语义不阻塞 turn 完成。失败:全部静默(catch swallow),不阻塞主路径。
 * 不维护 UI 缓存:与 `/name` handler 同款,写盘单源 — `/switch` typeahead 下次自然取新值。
 */
export function maybeAutoNameFirstTurn(opts: {
  conversationId: string;
  turnCounter: number;        // commitTurn 后 ++ 的值,刚 === 1 表示第一 turn 完成
  userMessage: Message;        // 调用方传 `runResult.turn.userMessage`(命名的稳定信号源)
  inferName: InferConversationName;
  convRepo: IConversationRepository;
}): Promise<void> {
  // 主路径瞬时 short-circuit:turnCounter !== 1 直接 resolved
  if (opts.turnCounter !== 1) return Promise.resolve();

  // 返回 Promise(供测试 await);调用方主路径 fire-and-forget 用 `void` 不 await。
  return (async () => {
    try {
      const conv = await opts.convRepo.get(opts.conversationId);
      if (!conv || conv.name !== conv.id) return;  // 对话不存在 / 已命名
      const inferred = await opts.inferName(opts.userMessage);
      if (!inferred) return;
      // 二次门控
      const latest = await opts.convRepo.get(opts.conversationId);
      if (!latest || latest.name !== latest.id) return;
      await opts.convRepo.rename(opts.conversationId, inferred);
    } catch {
      // 静默 —— best-effort,失败不影响用户主路径
    }
  })();
}
```

**sanitize 函数**(同文件,导出供测试):
```ts
/**
 * 把 LLM 返回的原始字符串处理为合法对话名字。
 * 规则:trim → 去首尾引号 → 去内联换行 → 截长度上限。
 * 处理后为空 → 返回 null。
 */
export function sanitizeConversationName(raw: string, maxLength = 20): string | null { ... }
```

**LLM-based inferer 装配**(cli 装配期内联,无需独立 factory):
```ts
const inferName: InferConversationName = async (userMessage) => {
  const userText = extractText(userMessage);
  if (!userText) return null;
  const prompt = buildConversationNamerPrompt(userText);
  // ⚠️ 必须在调用时动态访问 `session.runtime` getter —— 不可预捕获
  // `const callText = session.runtime.callText` 之类的写法。`session.runtime`
  // 在工作模式 enter/exit 时切换 active runtime(main ↔ power overlay),
  // 自动命名要跟随当前 active runtime 的 light 通道(work 模式下走 power
  // 的 light,main 模式下走 main 的 light)。
  const raw = await session.runtime.callText(prompt);
  return sanitizeConversationName(raw);
};
```

**`buildConversationNamerPrompt`**(放在 [core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 或 [core/conversation/prompts.ts](../../packages/core/src/conversation/prompts.ts)):
```text
基于以下用户首次提问,用 5-15 个字概括这次对话的核心主题,作为对话名字。

要求:
- 用对话的主要语言(中文提问用中文)
- 5-15 个字符,不超过此范围
- 不带任何标点、引号、编号、表情或说明
- 只输出主题字符串本身,不要任何前后缀

用户提问:
<user-message>

主题:
```

#### Phase 0:work 模式 conversation.name 默认 bug 修复

[repl.ts:1432](../../packages/cli/src/repl.ts#L1432) `applyModeSwitch` enter 分支:

```diff
- const wConv = await worksceneRepo.create({ name: scene.name });
+ // workscene 内对话与 main 同款 — 创建时 name 默认等于 id(autoChatId),让自动
+ // 命名机制统一在第一轮 turn 后接管。scene.name 是工作场景级语义,不应直接占
+ // conversation.name 槽位(N 次进入同 scene 会产生 N 个同名对话,无法区分)。
+ const wConv = await worksceneRepo.create({});
```

**关联验证点**:
- REPL prompt 本身不显示对话名(固定 `❯ `),Phase 0 修改无可见性影响
- 启动 welcome chrome row3 渲染 `resumedConversationName`(work 模式 enter 不重渲染 welcome chrome,只在 cli 启动时渲染一次),不受 Phase 0 影响
- `/switch` typeahead 候选 label = `c.name || c.id`:Phase 0 修复前 N 次进同 scene 显示 N 个 "OAuth 重构项目";修复后显示 N 个不同的 `chat-xxx` id(可区分),自动命名落地后变为各自精确的对话主题名
- `/exit` 退出生成纪要的逻辑 [repl.ts:1500-1525](../../packages/cli/src/repl.ts#L1500) 不依赖 conversation.name,不受影响

#### Phase 1:自动命名机制实施

**改动点 1: 新增 [core/src/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts)**
- `InferConversationName` 类型(接 `userMessage: Message`)
- `maybeAutoNameFirstTurn` helper(接 `conversationId / turnCounter / userMessage`)
- `sanitizeConversationName` 工具
- `buildConversationNamerPrompt` prompt 工厂(接 user text string)
- (无需新增 message → text 工具,直接复用现有 `extractText` —— 见事实层第 12 条)
- 单元测试:触发条件 × 二次门控 × sanitize 边界 × prompt 校验

**改动点 2: 导出**
- [core/src/conversation/index.ts](../../packages/core/src/conversation/index.ts) re-export `InferConversationName / maybeAutoNameFirstTurn / sanitizeConversationName`

**改动点 3: cli 装配期注入 + 钩子调用**

[repl.ts](../../packages/cli/src/repl.ts) 内:
1. `startRepl` 顶层装配 `inferName` —— 内部**动态访问** `session.runtime.callText`,跟随 active runtime(见核心抽象段的 inferer 装配注释)
2. 钩子调用位置 = [repl.ts:2001-2007](../../packages/cli/src/repl.ts#L2001) **try 块内**,`state.conv.turnCounter++` 之后(commit 成功路径)。调用形态:`void maybeAutoNameFirstTurn({ conversationId: state.conv.conversationId, turnCounter: state.conv.turnCounter, userMessage: runResult.turn.userMessage, inferName, convRepo: state.conv.convRepo });`
   - 用 `void` 不 await(主路径 fire-and-forget,不阻塞下一轮)
   - **commit 失败时不触发**:catch 路径 turnCounter 未 ++,自然走不到此调用;即便误调,helper 内 `turnCounter !== 1` short-circuit 也会兜底
3. **无 UI 刷新动作** —— 与 [`/name` handler](../../packages/cli/src/repl.ts#L582) 同款简洁模式:`convRepo.rename()` 写盘即完,不维护内存 name 缓存,不触发 `onConversationChanged`。落盘后所有"看名字"入口下次自然取新值(`/switch` typeahead 实时读 convRepo.list / 下次启动 welcome chrome 重新渲染)

**改动点 4:测试**
- 单元(core):helper 行为(turnCounter !== 1 short-circuit / name !== id short-circuit / 二次门控用户已命名时跳过 / inferer 失败静默 / sanitize 边界)
- 集成(cli):mock `session.runtime.callText` 跑一个 turn → 检查 `convRepo.get(id).name` 已从 id 变为推断名;再跑一个 turn → name 不变(只触发一次);用户在 inflight 期间 `/name <X>` → 自动命名跳过覆盖
- 端到端手动:`/new` → 发一句话 → 等 LLM 命名落地 → `/switch` typeahead 看到精确主题名

#### 关键 trade-offs(已决策)

| 决策点 | 选择 | 理由 |
|---|---|---|
| "未命名"sentinel | `name === id` | 现有 create 的默认行为就是 name=id;不引入 nullable 字段避免 schema 变更 |
| 触发判定 | `turnCounter === 1`(主路径 short-circuit) + `name === id`(异步分支内) | turnCounter 是 commitTurn 后 ++ 的内存值,无需磁盘读;name 检查在异步分支才做;一次性语义天然蕴含在 sentinel 中(命名后 name≠id 永不再触发),无需额外 flag |
| LLM 通道 | 复用 `session.runtime.callText`(走 light) | task shape "首句 → 短字符串" 是典型 light 场景;无需新 helper |
| 异步策略 | helper 返回 `Promise<void>`,主路径 `void` 不 await(fire-and-forget),测试可 await | 不阻塞 turn 完成 + 失败静默(best-effort);**测试可 await 异步分支验证 name 落盘**,避免 polling/sleep 这种 fragile 测试 |
| 钩子调用位置 | [repl.ts:2001-2007](../../packages/cli/src/repl.ts#L2001) **try 块内**,`turnCounter++` 之后 | commit 成功路径才触发;catch 路径 turnCounter 未 ++,即便误调也被 helper 内 short-circuit 兜底 |
| `session.runtime` 访问方式 | inferer 闭包内**动态访问 getter**,不预捕获 | `session.runtime` 在工作模式 enter/exit 时切换 active runtime(main ↔ power overlay);自动命名要跟随当前 active runtime 的 light 通道 |
| LLM 调用失败处理 | catch swallow + 同对话同 turn 周期不重试 | "永远只触发一次"按 `turnCounter === 1` 严格守门 — LLM 失败后该 turn 周期不再尝试(turnCounter 已 ++),用户需手动 `/name <name>` 或继续聊后 `/clear` 重置。补充语义:`/clear` 走 [repl.ts:380](../../packages/cli/src/repl.ts#L380) `state.conv.turnCounter = 0` 重置,若此时 name 仍 === id(从未成功命名),下次 turn 完成会再次进入触发判定 —— 这是合理恢复机制,符合"尊重已命名 + 给未命名机会"的深层意图,不与"永远只触发一次"字面冲突(name 已 !== id 的对话被 sentinel 永久阻断) |
| 竞态防御 | inferer 完成后二次读 meta 门控(best-effort) | 防住主要 race 顺序:用户 `/name` 在 inferer LLM 调用 inflight 期间 → 二次 get 命中 `name !== id` → 跳过覆盖。承认极小 TOCTOU 窗口:若用户 `/name` 精确落在自动命名"二次 get 通过"与"调 rename"之间(promise microtask 级,几十 ms 内),会覆盖用户操作。**接受此 best-effort 语义**,不引入 `compareAndSwap` 这类新 API 强化原子性(代价不匹配真实场景概率) |
| 输入材料 | helper 接 `userMessage: Message`(调用方传 `runResult.turn.userMessage`);inferer 内部 `extractText` 取 text | 命名稳定信号源是 user intent — assistant 回复可能很长(代码/列表/啰嗦)+ 易跑偏,toolCalls 是噪音;接口收窄到 Message 不接整个 Turn,模块依赖更短(conversation → types/messages,不引 transcript/Turn)+ 防未来误用 |
| 长度上限 | 20 字符(prompt 引导 5-15,sanitize 截 20 兜底) | typeahead label 行宽约束,过长会折行影响候选列表渲染 |
| UI 刷新策略 | 不刷新,写盘即完 | 现有架构 `/name` handler 同款行为(rename 后不动 UI 缓存);REPL prompt 不显示对话名,welcome chrome 只启动时渲染一次,`/switch` typeahead 候选实时读 convRepo.list — 自动命名落盘后所有"看名字"入口下次自然取新值,无需引入新 UI 同步通路 |
| 钩子归属包 | core/conversation/auto-name.ts(helper 主体)+ cli 装配(注入) | helper 纯函数无 LLM 依赖,可测;LLM 调用在 cli 装配期注入 |
| work 模式行为 | Phase 0 修复后与 main 完全一致 | "main/work 一样"产品原则 + 解决 N 次进入同名 bug |
| server 模式 | **本次不接入** | server 端 `runManagedTurn` 是 RPC 路径,与 REPL 用户面解耦;若 IDE / Web UI 需自动命名,作为独立议题 |

#### 不在范围(本次不动)

- `Conversation.name` schema 是否改为 `string | null` — 当前 sentinel `name===id` 已足够,改 schema 引发跨包数据迁移,代价不匹配
- workscene 历史对话访问能力(`/workscene history` 或 work 内 `/switch` 解禁) — 用户之前提出但是独立议题
- server 模式 RPC `session.send` 自动命名 — 独立议题
- prompt cache 优化 — 本次单发短 prompt 不依赖 cache,无优化空间

#### 实施清单(按依赖顺序)

1. **Phase 0**:[repl.ts:1432](../../packages/cli/src/repl.ts#L1432) work 模式 `create({ name: scene.name })` → `create({})`;`pnpm -F @zhixing/cli test` 通过 + 手动验证 enter 多次同 scene → id 不同 / name 不同。
2. **Phase 1 · core helper**:新增 [core/src/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 完整内容 + index 导出 + 单元测试。`pnpm -F @zhixing/core test` 通过。
3. **Phase 1 · cli 装配**:[repl.ts](../../packages/cli/src/repl.ts) 装配 `inferName` 闭包 + commitTurn 后调 `maybeAutoNameFirstTurn`(传 conversationId / turnCounter / runResult.turn.userMessage / inferName / convRepo)。`pnpm -F @zhixing/cli test` 通过。
4. **综合验证**:全包 build + test 零回归 + 手动 e2e(main 模式 `/new` 发一句话 → 名字落盘;work 模式 `/enter` 发一句话 → 名字落盘且与 scene.name 解耦;两次进同 scene → 两个对话名字不同)。

#### 验收

- [Phase 0] work 模式 N 次进同 scene → N 个对话各自有不同 id(create 默认 autoChatId),name 默认 = id;不再出现"N 个同名对话"
- [Phase 1] main 模式 `/new` 不带 name → 发一句话 → 名字自动从 id 变为 LLM 生成的短主题
- [Phase 1] work 模式 `/enter <scene>` → 发一句话 → 名字自动从 id 变为短主题(与 main 一致)
- 第二轮 turn 后名字不变(只触发一次)
- 用户 `/new <name>` 或 `/name <name>` 显式命名的对话第一轮后不被自动命名覆盖
- LLM 调用失败 → 名字保持 id(降级)+ 不报错给用户
- 全包测试零回归

---

> 最近一次沉淀:
>
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/switch` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/switch` 作为查看+切换对话唯一入口
> - **摘要质量升级**(2026-05-20 完成):主对话压缩(LLMSummarize)模型档位从 light 升级到 main;`compaction-llm.ts` 拆为 `createSummarizeCallLLM` + `createMemoryFlushCallLLM` 两个独立 helper;`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段(约束与偏好 / 关键决策 / 进度三态)。沉淀去向:
>   - [secondary-llm-capability.md ADR-SLLM-009](specifications/secondary-llm-capability.md) — 角色分流决策权威
>   - [llm-summarization.md](specifications/llm-summarization.md) — 7 段结构 / prompt / 校验同步更新到代码现状
>   - [thinking-control.md](specifications/thinking-control.md) / [work-mode.md](specifications/work-mode.md) / [subagent-execution.md](specifications/subagent-execution.md) — 引用同步

