# 技能（Skill）创建与编辑 — 交互与架构规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文是执行规格(execution spec),不是修订日志。**
> **只写**:当前生效的架构与方案、决策的"为什么"、与真实代码的对接点(精确到文件:符号)。
> **不写**(协作者修订时一并清理):版本号 / 修订日期 / "最后更新";"vX vs vY" 对比;"改了什么 / 废案"叙事。
> **演化方式**:设计变化时**原地修改**,不追加修订段。历史留给 `git log`。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **需求依据**:[drafts/skill-module.md](../drafts/skill-module.md) §2.3 / §3「看得见、管得了」（用户手动沉淀:一次写下、长期复用)。
> **父规格**:[skill-system.md](./skill-system.md)（Store / 索引 / `load_skill` / 控制面 §五）。本文**详化其「创建 / 编辑」交互面**,不重述 Store 与索引机制。
> **相关规格**:[input-typeahead.md](./input-typeahead.md)（命令面板）、[cli-ui-design-language.md](./cli-ui-design-language.md)。
> **事实依据**:对接点均对已落地代码核实,标注 `文件:行/符号`。

## 〇、定位与范围

本文回答**v1 用户怎么创建 / 编辑一个技能**。v1 = 静态 + 手动,技能管家(v2)尚未存在,**手动沉淀就是 v1 的英雄流程**——用户当天打开是空库,价值全靠"我把我这摊事的做法亲手收下来、之后一致复用"。

- **本文范围**:创建与编辑的**交互面 + 对接点**——两个创建入口、草稿生成、两路编辑交互(AI 编辑屏 / 外部编辑器)、保存与生效。
- **不在范围**:技能的发现 / 索引 / 加载 / 唤醒(skill-system.md §三~§五)、外部接入审查(§六 Admission)、自我进化(v2 技能管家)。
- **v1 边界**:**永远用户发起、必须用户确认才落盘**;不自动创建、不主动弹"要不要存成技能"——那些是 v2 在同一引擎上加的自主触发。

## 一、核心模型:创建即策展,不是手写

**创建一个技能的最优形态不是"写",是"收"**:用户脑子里是**意图**(「这个做法记下来」「description 再尖一点」「加一条坑」),不是 markdown 的行与语法;而刚刚把事做对的是 agent。所以——

> **agent 当编辑器,用户用自然语言描述,agent 落笔;用户只做策展(确认 / 微调)。** 用户全程不被要求在终端里手敲 markdown。

这同时解三层痛点:① 空白页 + YAML schema 的机械摩擦;② 用户写不好那条决定能否被检索命中的 `description`、也拿捏不好正文详略;③ 做法常常已发生在对话里,不该让用户跑去空白页复述。它也正是父规格 §1「skill 越来越由 agent 写下、瘦成指向特定性 + 沉淀教训」的落地形态。

**起草引擎是 v1/v2 共享插座**:"从上下文蒸馏出一个技能草稿"这个能力,v1 接到**用户触发 + 策展确认**,v2 技能管家接到**自主复盘触发 + 来源边界**——同一引擎、不同触发方。v1 把它造好,v2 即纯增量(对齐父规格 §九铁律)。

## 二、入口与草稿生成

**两个创建入口**(都是 agent 起草、用户策展;**都先开 AI 编辑屏、再在屏内起草**——立刻见屏,不在主屏干等几秒 LLM):

1. **从对话(主)** —— 做完某事后触发一个轻命令(可附一句指向,如「聚焦部署那段」)。它**照 `/config`·`/mcp` 的 REPL 层 handler 模式接线**(`config-command.ts:handleConfigCommand`/`runEditorCommand`):注入 `{ rl, state, session, renderer, writer, screen }` 这组 deps,`renderer.stop()` + `rl.pause()` 让出 stdin → **立刻开 AI 编辑屏**(§3.1)并把"最近对话上下文"(经 REPL state 的 `state.conv.messages` 取)传入 → 屏内调起草引擎(scoped `core/tool-loop`,**不进主 agent 回合**)起草(loading 态)→ 退出时 `rl.resume()` + `screen.reassertCursorHidden()`。**不能写成 `execution:local/hybrid` 的普通 `CommandDef`** —— 通用分发的 `CommandHandlerContext` 只有 `{ args, rawInput, runtime }`(`command-dispatcher.ts:128`),**拿不到 session / screen**(故 config-command 另立 `ConfigCommandDeps`,`config-command.ts:51`);也**不走 `execution:"agent"`**(那是父规格 §5.1 `/<name>` 唤醒用、整条发主 agent loop,既非独立会话、也无"开屏"路径)。
2. **从意图(冷启动)** —— 无现成对话时,从 `/skills` 技能管理器(父规格 §5.2 的 alt-screen)「新建」进**空白** AI 编辑屏视图;用户在屏内输入区说的第一句「我想要个什么技能」即意图,屏内据此起草骨架。管理器(浏览 / 状态操作)与 AI 编辑屏同属一个 alt-screen 工作区,「新建」是其内的视图切换;开屏走与 entry 1 同一套 REPL 层接线(注入 deps → 开屏)。

**草稿内容**(agent 替用户解决质量与安全,这正是用户做不好的部分):

- `name`
- `description` —— 以**「什么时候该用」**为导向(直接决定日后被模型检索命中)
- 正文 —— **瘦版**:只留用户的特定约定 + 这次的坑 / 最优路径,主动丢通用步骤(父规格 §1 形态)
- **凭证脱敏(待建依赖、安全关键)** —— 草稿源自对话、对话里可能粘过 secret,而技能会反复加载进上下文、且设计上可分享,危害被放大,**绝不固化进技能**。**但当前代码库没有通用 secret-scrubber**——只有领域专用件(`@zhixing/network` 出口脱敏、代理 URL 显示脱敏、`sanitizeConversationName`);故脱敏是**落地前必须先建立的依赖**:按父规格 §3「不自造」之意,建在**系统层**(供 skill 与未来其他模块共用,非 skill 专属),输入可借 `bi-zhixing-credentials-block`(`builtin-rules.ts:76`)已知的凭证字段 schema + 模式匹配。**不可假设"已可复用"。**
- `mode` 默认按**当前所处场景**(在工作场景里建 → `work`,否则 `main`),可在策展时由 AI 改(对齐父规格 §七「用户写的由用户定 mode」)

**起草引擎**:与 Admission「AI 语义识别」同构 —— 复用轻量工具循环(`core/tool-loop`)+ `AgentRuntime.callText`(父规格 §六.2),取 `main` 档(质量敏感的撰写任务),读上下文 / 意图产**结构化草稿**(name + description + body + mode)。**引擎在 AI 编辑屏内被调用**(首次起草 = 对话上下文或意图;后续 = 用户指令,即 §3.1 的 `editSkill`),产出落 WorkingState、不直接落盘。

## 三、编辑交互(两路,文件为唯一真相源)

两路编辑并存,**单一真相源 = 磁盘上的 SKILL.md 草稿;同一时刻只有一个编辑面在改它**——杜绝"两个编辑器抢一个文件"的竞态。

### 3.1 主路:AI 编辑屏(对话式)

一个**专门写的 alt-screen 交互屏**:顶部内容区(渲染 `name` / `description` / 路径 / 正文预览),底部输入区(用户的自然语言指令)。它**不复用** config-editor 的 `runEventLoop`(那是 panel-stack 表单导航器、不是对话式编辑器),**也不复用** `loading` action(其 `renderLoadingFrame` 会 `renderer.clear()` 盖成全屏"请稍候"spinner、把内容预览藏掉 —— `loading.ts:20`);而是复用更低层、合身的原语与模式:

- **底线 —— 必须走 alt-screen,禁用主 buffer 清屏路径。** 编辑屏进 alternate screen buffer(`\x1b[?1049h`),终端**原子保存** main buffer 整体(scrollback + viewport + chrome + 对话历史),退出(`\x1b[?1049l`)**原子恢复** —— 在 alt buffer 里随便重画都碰不到主对话历史,是**终端层物理隔离、不靠纪律**(`screen-controller.ts` suspend/resume 注释明述此为"不毁主历史"而选的路;DECSTBM 手工清屏那条曾是"历史消失"bug 源,**禁用**)。返回主回路调 `ScreenController.reassertCursorHidden()`(`screen/screen-controller.ts:reassertCursorHidden`)重申 chrome 光标不变量。
- **复用的原语**(均为中性 `tui/` 的独立件):`Renderer`(`tui/render.ts`,整帧渲染成串、一次 `flush` 的**双缓冲**)、`KeyEventStream`(`tui/input.ts`,`next(signal)` 可取消)、alt-screen 进退 + **三层退出防御**(`finally` + `process.once("exit")` emit `\x1b[?1049l`,`runner.ts:88-94`/`97`/`154`)、**事务草稿**模式(改完不即落盘、`Ctrl+C` 整体丢弃,对标 `WorkingState`,`types.ts:121`)、**注入式异步访问器**模式(面板不感知 LLM,对标 `mcpResolve`,`types.ts:183`)。
- **专门的事件循环**:`渲染整帧 → await 按键 / 等 editSkill(可取消) → 应用结果`;异步 AI 编辑期间**保留内容区、改完(或流式)就地重画内容**,而非 `loading` 的全屏 spinner 帧——这是与现成 `loading` 的关键区别。
- **避免耦合债**:上述原语已抽到中性 `tui/`(`tui/render.ts` / `tui/input.ts` / `tui/key-event.ts` / `tui/key-decoder.ts` + 既有 `screen/screen-controller.ts`)—— config-editor、`/skills` 技能管理器(浏览 / 状态操作,父规格 §5.2)与本编辑屏同建其上;skill 侧不反向依赖 config-editor 内部。

**核心交互**:用户在底部说需求 → 调注入的 `editSkill(draft, instruction, signal, report)`(内部走起草引擎 §二、按指令改草稿、过脱敏,返回新草稿)→ 内容区**就地重画**(alt buffer 自有、对主对话零影响)。**所有修改(name / description / `mode` / 正文)全经 AI,屏内不设手动可编辑字段** —— 独立编辑会话(AI 上下文 = 这一个技能 + 改动意图,与主对话隔离)。满意 → 确认 → 经注入 writer(对标 `ConfigEditorContext.writers`,`types.ts:321`/`346`)落 Store(§四)。

**实时同步可行性(已对 screen-controller 核实)**:成立,且稳、无副作用 —— 全部发生在我们独占的 alt buffer 内,主对话被终端冻结保存、碰不到。防闪靠 `Renderer` 的双缓冲(整帧渲染、一次 flush);流式则合并 chunk、约 10–20fps 节流重画。**唯一会破底线的写法是用主 buffer 清屏来画编辑屏 —— 架构上禁用。** 流畅度按"TUI 必须自跑视觉"规约,实现后 `pnpm cli` 实测确认。新建的只是:skill 草稿状态 + 内容 / 输入的渲染与事件循环 + `editSkill` 访问器。

### 3.2 逃生口:外部编辑器(用户自己的 GUI 编辑器)

提示"想自己改?按 X 用你的编辑器打开"。**打开是纯确定性问题、不放 AI**(见决策三)。

- **编辑器解析(确定性链)**:用户显式设置(类 git `core.editor` 的一个 skill 编辑器配置)→ `$VISUAL` → `$EDITOR` → `git config core.editor` → 在 PATH 上探测已知编辑器(code / cursor / subl / idea / nvim / vim / notepad++…)→ OS 兜底(Windows `notepad`、mac `open -t`、linux `nano`/`vi`)。都没命中 → 退 OS 默认 + 提示用户固定设一个。
- **无闪启动**(实测经验):配置命令常是 `.cmd`/`.bat` 包装(如 `code.cmd`),直接拉会闪一个临时控制台。故**优先解析到底层 GUI 可执行**(从 `code.cmd` 推同级上一层 `Code.exe`)直接拉 —— GUI 子系统不分配控制台、**零闪**、非阻塞、复用已开窗口;只能走 `.cmd` 包装时用**无窗口**方式启动(.NET `ProcessStartInfo.CreateNoWindow`)。
- **`--wait` 与否**:不需等(用户改完自己说一声)就拉起即返回;需要"等关掉标签再读回"才走 `--wait`(GUI 编辑器需此标志才阻塞)。
- **本地 TTY 专用**:此路要有真实终端 / 桌面挂载编辑器;远程 / daemon / 无头模式没有 → 这些场景只走 3.1 AI 编辑屏(对话式哪儿都能用,外部编辑器是本地逃生口)。

### 3.3 两路的衔接(决策四:文件单一真相源、一次一面)

**不做实时双向回灌**(两个编辑器同时活在一个文件 = 竞态 + fs.watch 边角,重且不稳)。改为:

- 从 AI 编辑屏按 X 跳外部编辑器 = **先把当前草稿落到文件 + 交接**;AI 编辑屏进入"外部编辑中"暂停态(不接受 AI 指令)。
- 用户在外部编辑器改完(GUI 编辑器在自己窗口,AI 编辑屏的 alt-screen 不受影响)。
- 回到屏内下一次交互时,比对 mtime、**变了就一次性重读**——非持续 watch、非双向同步。极轻、极稳,两路都保住、任何时刻只一面在写。

## 四、保存与生效

确认 → 经注入 writer 调 Store 写 `own/<id>/SKILL.md`(父规格 §二):`id = skillNameToId(name)`(父规格 §5.1,撞名校验:own 同名遮蔽 linked / 提示改名)、`mode` 写 `index.json`、原子写(`writeAtomic`)。**这是 Store 新增的"从草稿创建 / 更新 own 技能"写 API**,区别于接入 `linked/` 的 `admit`(父规格 §二 `SkillStore` 接口需补 `create(draft)` / `update(id, draft)`)。落盘后**立即可 `/<name>` 唤醒**,下个会话 / 模式切换由索引产生管线自然纳入(父规格 §三,本步不强制即时重建索引)。

## 五、安全归属

- **凭证脱敏**:起草与每次 `editSkill` 都必须过脱敏(§二);该通用 scrubber 是**待建依赖**(当前不存在),建在系统层、不自造 skill 专属件。
- **app-state 内部**:若起草 / 编辑经 agent 侧工具(写 `own/` 草稿)实现,该工具声明 `app-state` 边界、判 `internal` 自动放行(对标 `load_skill`,父规格 §四)。
- **外部编辑器 spawn 是宿主侧本地操作**:拉起的是用户自己的编辑器进程,非 agent 经工具调用的写入,不经 SecurityPipeline(同 Store 自身 fs 操作,父规格 §六放行落盘的宿主侧写语义);realpath 目录边界仍由 Store 在读写 `own/` 时一处收口(父规格 §一边界判断#1)。

## 六、归属与对接点(汇总)

| 包 | 内容 | 关键对接 |
|---|---|---|
| `core/src/skills/` | 起草引擎、Store `create`/`update` 写 API、脱敏接线 | `core/tool-loop`、`AgentRuntime.callText`(起草,同 Admission)、`skillNameToId`、`writeAtomic`;**通用 secret-scrubber(待建,系统层)**——输入借 `bi-zhixing-credentials-block`(`builtin-rules.ts:76`)凭证字段 schema |
| `orchestrator` | `editSkill` 访问器(起草引擎按指令改草稿 + 脱敏) | 注入进 AI 编辑屏,对标 `ConfigEditorRuntime.mcpResolve`(`config-editor/types.ts:183`) |
| `cli` | AI 编辑屏(**专门 alt-screen 循环,复用 tui 共享原语**)、外部编辑器解析 + 无闪 spawn、两入口 | `Renderer`(`tui/render.ts`)、`KeyEventStream`(`tui/input.ts`)、alt-screen + 三层退出防御模式(`runner.ts:88-94`/`97`/`154`)、`WorkingState`(`types.ts:121`)与 `writers`(`types.ts:321`)模式、`screen/screen-controller.ts:reassertCursorHidden`;两入口接线照 `config-command.ts:handleConfigCommand`/`runEditorCommand`(REPL 层注入 `{rl,state,session,renderer,writer,screen}`)、`/skills` 技能管理器「新建」/「编辑」入口(父规格 §5.2) |

## 七、v1 → v2 跨版插座

- **起草引擎**(§二) = v2 技能管家自主复盘新建 / 迭代的**同一引擎**;v1 接"用户触发 + 策展确认",v2 接"自主触发 + 来源边界",纯增量。
- **`editSkill` 访问器**与起草引擎同源:v2 的自主迭代复用它对已有技能改写。
- v1 的**用户确认闸门**是 v2「proactive offer(主动提议存成技能)」要替换 / 旁路的那一处,接口预留即可。

## 八、测试拓扑

- **起草引擎**:从对话 / 意图产结构化草稿(name + description + 瘦正文 + mode);**凭证脱敏断言**(对话内 secret 不进草稿 —— 依赖通用 scrubber,见 §二);注入 mock LLM,无真网真 LLM。
- **AI 编辑屏**:**必走 alt-screen**(断言进 / 退 alt buffer、禁用主 buffer 清屏路径)+ 三层退出防御(异常 / Ctrl+C 必切回 main buffer、主对话历史完好);事务草稿(取消丢弃、不半落盘);`editSkill` 异步可取消;**内容保留式重画**(`editSkill` 返回后内容区就地重画可断言,**非 spinner 帧**);返回主回路 `reassertCursorHidden`。
- **外部编辑器解析**:探测链分支(setting / env / git / PATH 探测 / OS 兜底);无闪启动(`.cmd` → GUI exe 解析、`CreateNoWindow`);本地 TTY 专用(远程 / 无头返回不可用、只走 AI 编辑屏)。
- **两路衔接**:同一时刻仅一面可写;外部改完回屏 mtime 比对 + 一次性重读;不存在持续 watch。
- **保存**:`create`/`update` 写 `own/<id>/SKILL.md`、`skillNameToId` 定 id + 撞名校验、`mode` 写 index、原子写;落盘后 `/<name>` 即可唤醒。
- 纯逻辑注入 mock(fs / LLM / stdin/stdout / editor spawn),无真编辑器真网真 LLM。
