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

## 当前 staging:work 模式对话能力对齐 main

### 明确需求

1. **`/resume` 在 work 模式解禁**:work 模式内可用 `/resume` 切换对话。命令名 / 交互行为 / 显示格式与 main 模式完全一致(复用同一 handler 代码,不写第二份)。**scope 天然分隔**:main 模式只列 user scope 对话,work 模式只列**当前所在 workscene 内**的对话,跨 workscene 不可见
2. **`/new` 在 work 模式解禁**:同款"天然分隔"原则,work 内 `/new` 创建一个当前 workscene scope 的新对话
3. **进入工作场景按触发源分两种行为**:
   - **用户手动 `/enter <scene>`**:auto-resume 该 scene 最近活跃对话(与 main 启动 auto-resume 对齐) —— 用户手动进就是为回到最近对话继续;无 latest 则创建第一个 workscene 对话
   - **LLM 调 `workmode_enter` 工具触发**:始终新建对话(保留原行为) —— LLM 这样调用进去是为做新任务,新建对话立即就有触发句作为起始 message,第一轮 turn 后自动命名落地,不会出现空对话(孤儿对话)

### 架构设计

#### 事实层(grep 验证,2026-05-21)

1. **scope 天然分隔已存在**:[repl.ts:1419-1421](../../packages/cli/src/repl.ts#L1419) `wStore = new TranscriptStore(conversationsDir({ kind: "workscene", sceneId }))`;[repl.ts:1463-1472](../../packages/cli/src/repl.ts#L1463) `state.conv = { ..., convRepo: worksceneRepo, store: wStore, ... }`。work 模式下 `state.conv.convRepo` 已指向 workscene scope repo,`state.conv.store` 已指向 workscene transcript store,**磁盘隔离在 `~/.zhixing/workscenes/<sceneId>/conversations/<convId>/`**
2. **现有 handler 全部基于 active state**:[repl.ts:479/504/516](../../packages/cli/src/repl.ts#L479) `/resume` handler 用 `state.conv.convRepo.list() / .get() / .touch()`;[repl.ts:439-454](../../packages/cli/src/repl.ts#L439) `/new` handler 用 `state.conv.convRepo.create() / .store.init()`。**state 切换后 handler 自动跟随 scope,无需任何代码改动**
3. **当前 work mode guard 位置**:[repl.ts:471-476](../../packages/cli/src/repl.ts#L471) `/resume` 顶部 4 行 + [repl.ts:431-436](../../packages/cli/src/repl.ts#L431) `/new` 顶部 4 行
4. **typeahead conversation 选择器**([repl.ts:1630-1653](../../packages/cli/src/repl.ts#L1630)):provider `list()` 内 `state.conv.convRepo.list()` 同款基于 active state,scope 自动跟随
5. **`applyModeSwitch` enter 流程**([repl.ts:1432-1487](../../packages/cli/src/repl.ts#L1432)):原子事务,5 步事务步骤 + 逆序 undo 栈
   - ① 路由核 register(`routingRepo.setActive(worksceneRepo)`)+ 路由 unregister undo
   - ② `worksceneRepo.create({})` + delete undo —— **本次改造的核心点**(按触发源分支:LLM 创建新对话保持原行为 / 命令则 findLatest 优先)
   - ③ `taskListService.prime(wConv.id)` + clear undo
   - ④ `session.enterWorkMode(sceneId)`(装 power runtime + broker swap)+ exitWorkMode undo
   - ⑤ `wStore.init(...)` + 构造并切 active state(代码注释为 ⑤;init 与 state 赋值连成一段,无独立 undo —— state 赋值是纯赋值,无需 undo;init 若抛错由前面 4 步 undo 链回滚)
6. **触发源分类 + `startMessages` 定义位置**:[repl.ts:1429-1430](../../packages/cli/src/repl.ts#L1429) `const startMessages: Message[] = source === "llm" && triggerMsg ? [triggerMsg] : [];` —— **定义在 try 块之前**(因为当前不依赖 conversation 状态)。LLM 触发(`workmode_enter` 工具)带触发句、命令触发(`/enter`)空 messages
7. **`ConversationRepository.findLatest()`**:[repository.ts:199-202](../../packages/core/src/conversation/repository.ts#L199) 已实现,返回最近活跃 conversation id 或 null
8. **`TranscriptStore.load(id)`**:返回 `{ header, messages, turnCount }`,加载失败抛错(由 caller 决定降级)。main 启动 [repl.ts:1244-1248](../../packages/cli/src/repl.ts#L1244) auto-resume 路径:load 失败 → 降级 create default

#### 触发源 × 路径选择(产品语义决策)

**核心区分**:LLM 工具触发 = 进入 scene 做新任务;命令触发 = 用户回到 scene 继续。两种触发的产品意图不同,enter 流程的对话获取策略也不同。

| 触发源 | 对话获取策略 | startMessages 组装 |
|---|---|---|
| LLM `workmode_enter` 工具 | **始终 create 新对话**(保留原行为) | `[triggerMsg]` |
| 命令 `/enter` | **优先 auto-resume**(findLatest → load 成功用之 / 失败降级 create) | recovery 路径:`loaded.messages`;create 路径(无 latest 或 load 失败):`[]` |

**为什么 LLM 触发不 auto-resume**:LLM 触发是为做新任务进 scene,若 scene 有历史(可能上次是完全无关主题),`[...loaded.messages, triggerMsg]` 会让 power agent 上下文被无关历史污染,answer 跑偏。LLM 触发新建对话语义清晰、无污染、第一轮 turn 后自动命名落地,不产生孤儿对话。

#### 核心抽象

**`acquireWorksceneConversation` helper**(仅命令触发路径调用,封装"findLatest → get + load 成功用之 / 任一失败降级 create"的双路径;**纯函数 — 不依赖 cliWriter,通过 warning 字段返回提示**,由 caller 在成功路径输出避免"helper 内 IO + caller 失败回滚"的消息时序混乱):

```ts
type WorksceneConversation = {
  conversation: Conversation;
  loaded: LoadedTranscript | null;   // null = create 路径;非 null = recovery 路径
  warning?: string;                  // load 失败降级时携带,由 caller 在 enter 成功后输出
};

async function acquireWorksceneConversation(
  worksceneRepo: ConversationRepository,
  wStore: TranscriptStore,
): Promise<WorksceneConversation> {
  const latestId = await worksceneRepo.findLatest();

  // 路径 A:latest 不存在 —— 直接 create,无 warning(等同 main 首次启动创建 default)
  if (!latestId) {
    const conv = await worksceneRepo.create({});
    return { conversation: conv, loaded: null };
  }

  // 路径 B:latest 存在,尝试恢复
  let loadError: unknown;
  try {
    const loaded = await wStore.load(latestId);
    const conv = await worksceneRepo.get(latestId);
    if (conv) return { conversation: conv, loaded };
    // get 返 null(meta.json 缺失/损坏) → 落空走降级,与 load 抛错统一处理
  } catch (err) {
    loadError = err;
  }

  // 路径 C:latest 存在但加载失败(load 抛错 / get 返 null)→ 降级 create + warning
  const conv = await worksceneRepo.create({});
  return {
    conversation: conv,
    loaded: null,
    warning: loadError
      ? `该工作场景历史加载失败(${loadError instanceof Error ? loadError.message : String(loadError)}),已创建新对话`
      : `该工作场景历史元数据缺失,已创建新对话`,
  };
}
```

#### `applyModeSwitch` enter 改造点

| 步骤 | 当前 | 改造后 |
|---|---|---|
| `startMessages` 定义位置 | try 块前 [repl.ts:1429-1430](../../packages/cli/src/repl.ts#L1429) | **移入 try 块**(放在 ② 之后,因为 recovery 路径依赖 `loaded`) |
| ② conversation 获取 | `worksceneRepo.create({})` | **按 source 分支**:`source === "llm"` 走原 `create({})` 不变;`source === "command"` 走 `acquireWorksceneConversation(...)` |
| ② undo | `worksceneRepo.delete(wConv.id)` | LLM 触发 + 命令触发-create 路径:push delete undo;命令触发-recovery 路径(`loaded !== null`):**不 push**(用户历史对话不能因 enter 失败被删) |
| ⑤ transcript init | 无条件 `wStore.init(...)` | LLM 触发 + 命令触发-create 路径:调 init;命令触发-recovery 路径:**不 init**(transcript 已存在,init 会覆盖丢数据) |
| ⑤ state.conv 字段 | `messages: startMessages, turnCounter: 0` | `messages` 按上节"触发源 × 路径"二维表;`turnCounter: loaded?.turnCount ?? 0` |
| ⑤ 后 warning 输出 | 无 | enter 整体成功后(scene chrome 渲染附近),若 helper 返回了 `warning` 则 `cliWriter.line(chalk.dim(warning))`。**关键:warning 必须在 try 块成功完成后输出**,绝不能 helper 内即时输出(避免后续步骤回滚后用户看到"已创建新对话"+"已回退"双消息困惑) |

#### handler guard 删除

- 删 [repl.ts:471-476](../../packages/cli/src/repl.ts#L471) `/resume` work mode guard(4 行 if 块 + 提示文案)
- 删 [repl.ts:431-436](../../packages/cli/src/repl.ts#L431) `/new` work mode guard(4 行 if 块 + 提示文案)
- handler 其余代码不动 —— scope 天然分隔由 `state.conv.convRepo` 自动跟随保证

#### 待决策点

**决策 1 — `acquireWorksceneConversation` helper 放置位置**

- A. **repl.ts 内局部 helper**:applyModeSwitch 紧邻局部,简洁;未来若 server 端也走 enter workscene 流程不可复用
- B. **`cli/src/runtime/workscene-conversation.ts` 新模块**:独立可测;但 main auto-resume 路径也是同款语义,如果抽 helper 应该是更通用的 `acquireConversation(repo, store, options?)` 把 main + work 两路径一并统一
- **推荐 A**:本次只增量解决 work 命令触发路径,main 路径已稳定不动;A 是最小职责扩展,helper 行数不多;**若未来真有 server 端 enter workscene 需求或想统一 main/work auto-resume 路径,届时再升级到 B**(避免本次过度抽象)

**决策 2 — recovery 路径 wStore.load 失败的降级策略**

- A. **降级到 create**(与 main 启动 auto-resume 同款,见 [repl.ts:1244-1248](../../packages/cli/src/repl.ts#L1244) catch swallow → 创建 default)
- B. **抛错让 applyModeSwitch 整体回滚**,用户看到提示不进 scene
- **推荐 A**:行为对齐原则;main 已采用 A;transcript 损坏属于罕见事件,创建新对话让用户能继续工作好于阻塞;旧 transcript 文件不会被 create 覆盖(create 走 autoChatId,新文件路径)

**决策 3 — recovery 降级 create 后是否显式提示用户**

- A. 静默(与 main 启动 auto-resume 同款)
- B. cliWriter 提示"该工作场景历史加载失败,已创建新对话"
- **推荐 B**:main 启动 auto-resume 是启动期一次性逻辑,环境复杂(空环境也常见),静默有合理性;work `/enter` 是 REPL 内**用户显式动作**,有可视化反馈语境,提示让用户感知"历史出问题了"代价低且防止误以为历史丢失无声无息。**不算双标 —— 两个语境不同,各自最优**

#### 不在范围(本次不动)

- main 模式 `--switch` / `--resume` startup arg(已删,不重新加回)
- workscene 跨 scene 对话列表(scope 天然分隔决策,本次保持)
- workscene 对话 `/archive` / `/delete`(独立议题)
- workscene 列表展示策略简化(独立议题,flattening spec L192 提过)
- `workmode_enter` 工具协议本身(本次仅 enter 流程对触发源分支处理,工具签名 / 参数 / 调用方式不动)
- main 启动 auto-resume 路径与 work enter 的 helper 统一(决策 1 推荐 A 的暂缓项)
- **work conversation 创建对齐 main 传 `preferredModel/Provider`**:grep 验证 main create([repl.ts:1247-1250](../../packages/cli/src/repl.ts#L1247))传 `preferredModel: session.runtime.model / preferredProvider: session.runtime.providerId`;work create([repl.ts:1445](../../packages/cli/src/repl.ts#L1445))**不传**。本次 LLM 路径仍 `create({})` + command-create fallback 也 `create({})`,继承现状的不对称。与 R1/R2/R3 解禁需求无直接关系,顺手扩范围可能影响 power runtime 装配链路,作为独立议题
- **main 启动 auto-resume `catch swallow` 升级为显式提示**:本次决策 3B 让 work `/enter` 走显式提示,但 main 启动期([repl.ts:1240-1242](../../packages/cli/src/repl.ts#L1240))仍 catch swallow。两者实际可视化语境相似(main 启动也是用户主动行为 + welcome chrome 渲染 conversation name),main 同款升级是合理优化方向。**本次接受"work 提示 / main 静默"双标作为范围分割**(不扩大本次 staging 边界),main 同款升级作为独立议题

#### 实施清单(决策落定后启用,按依赖顺序)

> 以下基于决策 1A / 2A / 3B 起草 + P1 LLM 触发不 auto-resume。最终待用户审查后启用。

1. **handler guard 删除**(独立 + 最小改动,无依赖):
   - 删 [repl.ts:471-476](../../packages/cli/src/repl.ts#L471) `/resume` work mode guard
   - 删 [repl.ts:431-436](../../packages/cli/src/repl.ts#L431) `/new` work mode guard

2. **`acquireWorksceneConversation` helper 新增**(纯函数,不依赖 cliWriter):
   - 在 [repl.ts](../../packages/cli/src/repl.ts) 内 `startRepl` 函数前定义(或紧邻 `applyModeSwitch` 闭包内)
   - 类型:`WorksceneConversation = { conversation: Conversation; loaded: LoadedTranscript | null; warning?: string }`
   - 参数:`worksceneRepo / wStore`(**不传 cliWriter**,helper 是纯函数)
   - 三条路径(按 latest 是否存在 + 加载是否成功正交分支):
     - **路径 A**(latest 不存在):直接 create,返回 `{ conversation, loaded: null }` 无 warning(等同 main 首次启动创建 default 行为)
     - **路径 B**(latest 存在 + load + get 均成功):recovery,返回 `{ conversation, loaded: <非空> }` 无 warning
     - **路径 C**(latest 存在但加载失败 — 含 load 抛错 / get 返 null 两子情况):统一降级 create,返回 `{ conversation, loaded: null, warning: <非空> }`;warning 文案按子情况区分(load 抛错带 error message / get 返 null 标"元数据缺失")
   - **关键设计**:路径 C 将"load 抛错"与"get 返 null"合并为同一处置 — 两者都是"latest 存在但加载失败"语义同款,避免边界双标

3. **`applyModeSwitch` enter 改造**:
   - **移动** [repl.ts:1429-1430](../../packages/cli/src/repl.ts#L1429) `startMessages` 定义**从 try 块前移入 try 块**(放在 step ② 之后,因为 command 触发的 recovery 路径依赖 `loaded`)
   - step ② 按 source 分支:
     - `source === "llm"`:`const wConv = await worksceneRepo.create({}); const loaded = null; const warning = undefined;`(保持原行为)
     - `source === "command"`:`const { conversation: wConv, loaded, warning } = await acquireWorksceneConversation(worksceneRepo, wStore);`
   - step ② undo:`if (loaded === null) undos.push(() => worksceneRepo.delete(wConv.id).catch(() => {}));`(LLM 路径 + command-create 路径才 push;command-recovery 不 push)
   - step ⑤ `wStore.init` 仅在 `loaded === null` 时调用
   - step ⑤ state.conv 字段:
     - `messages`:按二维表组装(LLM:`[triggerMsg]`;command-recovery:`loaded.messages`;command-create:`[]`)
     - `turnCounter: loaded?.turnCount ?? 0`
   - **try 块成功完成后**(catch 之外、scene chrome 渲染附近):`if (warning) cliWriter.line(chalk.dim(\`  ${warning}\n\`));` — warning 输出必须在 try 成功后,绝不能在 helper 内即时输出

4. **测试**:
   - cli 单元/集成测试 `acquireWorksceneConversation` 三条路径:
     - **路径 A** latest 不存在 → 返回 `{ conversation: <新建>, loaded: null, warning: undefined }`
     - **路径 B** latest 存在 + load + get 均成功 → 返回 `{ conversation, loaded: <非空>, warning: undefined }`
     - **路径 C** latest 存在但加载失败 — 两子 case:
       - load 抛错 → 返回 `{ conversation: <新建>, loaded: null, warning: <含 error message> }`
       - get 返 null(load 成功但 meta 缺失)→ 返回 `{ conversation: <新建>, loaded: null, warning: <"元数据缺失"> }`
   - applyModeSwitch enter 路径:
     - LLM 触发 + scene 有历史:走 create + `[triggerMsg]`(不读历史)
     - LLM 触发 + scene 无历史:走 create + `[triggerMsg]`
     - command 触发 + scene 有历史:走 recovery + `loaded.messages` + `turnCount = loaded.turnCount`
     - command 触发 + scene 无历史:走 create + `[]`
     - command 触发 + load 失败:降级 create + cliWriter 提示
   - 手动 e2e:
     - work 模式 `/resume` 列出同 scene 历史对话(不含 main)
     - work 模式 `/new` 创建当前 scene 内新对话(meta 落 workscene 域)
     - 同 scene 二次 `/enter`(命令):auto-resume 上次对话(turnCount > 0,messages 恢复)
     - LLM 触发 `workmode_enter` + 该 scene 有历史:新建对话(不污染历史)

5. **综合验证**:全包 build + test 零回归

#### 验收(决策落定后启用)

- work 模式 `/resume` 与 `/new` 可正常调用,无 guard 阻塞
- `/resume` 在 work 模式列出**仅当前 workscene 内**对话(磁盘验证落在 `~/.zhixing/workscenes/<sceneId>/conversations/`)
- 命令触发 `/enter scene` 多次:第二次起 turnCounter > 0,messages 恢复历史
- LLM 触发 `workmode_enter sceneId: X, triggerMsg: ...`:始终新建对话,`state.conv.messages === [triggerMsg]`,无论 scene 是否有历史
- `acquireWorksceneConversation` load 失败:enter 成功后(scene chrome 渲染附近)输出"该工作场景历史加载失败,已创建新对话";enter 失败回滚时**不输出**此提示(避免用户看到"已创建"+"已回退"双消息困惑)
- enter 失败回滚:LLM 路径 + command-create 路径 conversation 被 delete;command-recovery 路径 conversation 保留
- 全包 build + test 零回归

---

> 最近一次沉淀:
>
> - **`/switch` → `/resume` 改名 + 删序号匹配**(2026-05-21 完成):REPL 切换对话命令名从 `/switch` 改为 `/resume`(对齐 Claude Code 用户预期),无 legacy alias 直接换;handler 内删除"按序号选择"匹配段 + 列表渲染去序号编号,保留 ID 精确 + 名称模糊两档解析(有 name fallback id,序号是冗余信号源);全仓代码 + 测试 + 15 个 spec/README/staging 沉淀的 `/switch` 字面同步,grep `/switch` 零命中。架构升级:`argsByName` 字典 key 同步 `switch → resume`(避免 cmd.name 改而 typeahead conversation 选择器查不到的隐性 bug);列表 label fallback 从 `(未命名)` 改为 `chalk.dim(c.id)`,与 typeahead `c.name || c.id` 一致
> - **transcript schema 历史一致性清理**(2026-05-21 完成):4 项审查识别的债务(`conversation-model.md §7.1` 旧架构描述残留 + `TranscriptHeader.projectPath` 死字段 + `writeHeader/readHeader` 生产零调用 + `session-persistence.md` 半完成归并)彻底处置。代码层:删 `projectPath` 字段 + TranscriptStore 构造签名变更 `(convDir, cwd, options?) → (convDir, options?)`(8 处 caller 同步)、删 `writeHeader/readHeader` 函数 + index re-export + 测试两类用途分别处理(测函数本身的 describe 整段删 / fixture 用法改 fs API)、清理 `normalize.test.ts` dead import。文档层:`conversation-model.md §7.1` 重写对齐 standalone cli 现实(RuntimeSession 替代 ConversationManager/SessionRuntime/CliChannel 旧描述)+ §7.3 表格修正 + §9.2 整段重写承接 session-persistence §2.3 JSONL 行格式细节 + §9.5 整合 §5.1 单向数据流意图;同款散落到 work-mode.md 目录树 + ConversationScope variant + TranscriptStore 签名描述、conversation-scope-flattening.md "后续评估项"标记为"已清理";引用方 context-architecture / usage-display 切到 conversation-model;session-persistence.md 删 §一-§八 正文留 18 行 stub(按维度索引指向当前权威)。沉淀去向:[conversation-model.md §九](specifications/conversation-model.md) 单一事实源;9 包 5174 tests 零回归
> - **新对话自动命名**(2026-05-21 完成):新对话第一轮 turn 完成后用 light LLM 生成短主题名,落 `conversation.meta.name`。[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 提供 `InferConversationName` 函数依赖注入 + `maybeAutoNameFirstTurn` 协议(主路径同步 short-circuit / 异步分支二次门控 / 全 catch swallow);cli 装配 inferer 闭包(动态访问 `session.runtime.callText` 跟随 work mode active runtime 切换),commitTurn 成功 + `turnCounter++` 之后 fire-and-forget 触发钩子;Phase 0 顺带修复 work 模式 `worksceneRepo.create({ name: scene.name })` → `create({})` 的"N 次进同 scene 产生 N 个同名对话"bug。沉淀去向:[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 顶部 docstring 为首位权威(设计原则 / 跨层职责 / 触发协议 / sanitize 规则均在);[conversation-model.md](specifications/conversation-model.md) 后续按需补"自动命名"节(独立 task,不阻塞本 staging)
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/resume` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/resume` 作为查看+切换对话唯一入口
> - **摘要质量升级**(2026-05-20 完成):主对话压缩(LLMSummarize)模型档位从 light 升级到 main;`compaction-llm.ts` 拆为 `createSummarizeCallLLM` + `createMemoryFlushCallLLM` 两个独立 helper;`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段(约束与偏好 / 关键决策 / 进度三态)。沉淀去向:
>   - [secondary-llm-capability.md ADR-SLLM-009](specifications/secondary-llm-capability.md) — 角色分流决策权威
>   - [llm-summarization.md](specifications/llm-summarization.md) — 7 段结构 / prompt / 校验同步更新到代码现状
>   - [thinking-control.md](specifications/thinking-control.md) / [work-mode.md](specifications/work-mode.md) / [subagent-execution.md](specifications/subagent-execution.md) — 引用同步
