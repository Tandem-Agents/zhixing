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

**创建入口 `/skill-new`**(agent 起草、用户策展;**先开 AI 编辑屏、再在屏内起草**——立刻见屏,不在主屏干等几秒 LLM)。一个命令按对话上下文自适应,覆盖两种来法:

1. **从对话(做完某事后)** —— 带最近对话上下文(经 `state.conv.messages` 取、`extractText` 转写成「用户 / 助手: …」),进屏即从对话起草;可附一句指向(命令 rest)作首句意图。
2. **从意图(冷启动空库)** —— 无对话上下文时进**空白**编辑屏,用户在输入区说的第一句即意图、据此起草骨架。

接线**照 `/config`·`/mcp` 的 REPL 层 handler 模式**(`config-command.ts:handleConfigCommand`/`runEditorCommand`):`renderer.stop()` + `rl.pause()` 让出 stdin → 开 AI 编辑屏(§3.1)→ 退出时 `rl.resume()` + `screen.reassertCursorHidden()`,保存后刷新 `/<name>` 补全。注册走命令现代路径(直接挂 `tRegistry` + `CommandDispatcher`,同 `/skills`、task 命令);handler 经闭包注入窄能力(`callText("main")` / `store.create` / 取 messages / 取场景默认 mode),**不写成普通 `CommandDef`** —— 通用分发的 `CommandHandlerContext` 只有 `{ args, rawInput, runtime }`、拿不到这些会话能力(故照 config-command 在 REPL 层装配),也**不走 `execution:"agent"`**(那是父规格 §5.1 `/<name>` 唤醒用、整条发主 agent loop,既非独立会话、也无"开屏"路径)。起草引擎是**单发结构化生成、不进主 agent 回合**。

> 父规格 §5.2 设想的「管理器内『新建』视图切换」(管理器与编辑屏同 alt-screen 工作区内切换)v1 未做 —— `/skill-new` 已覆盖两种来法的功能(含冷启动空库),管理器内切换是后续的体验增量。

**草稿内容**(agent 替用户解决质量与安全,这正是用户做不好的部分):

- `name`
- `description` —— 以**「什么时候该用」**为导向(直接决定日后被模型检索命中)
- 正文 —— **瘦版**:只留用户的特定约定 + 这次的坑 / 最优路径,主动丢通用步骤(父规格 §1 形态)
- **凭证脱敏(安全关键)** —— 草稿源自对话、对话里可能粘过 secret,而技能会反复加载进上下文、且设计上可分享,危害被放大,**绝不固化进技能**。通用 secret 脱敏建在系统层(供 skill 与未来其他模块共用,非 skill 专属):`scrubSecrets`(`core/src/security/secret-scrubber.ts`)—— 只匹配**高置信**模式(已知服务商密钥前缀 / PEM 私钥块 / JWT / Bearer / 明确的「字段名=值」赋值),**不做高熵串猜测**以免把 git sha / base64 图片等正常长串误当 secret 毁掉正文,命中处替换成带类别占位符。`bi-zhixing-credentials-block`(`builtin-rules.ts:76`)只是挡 AI 读写 credentials.json 的 **path 规则、不含文本扫描模式**,故 scrubber 是自建件、非复用内置规则。
- `mode` 默认按**当前所处场景**(在工作场景里建 → `work`,否则 `main`),可在策展时由 AI 改(对齐父规格 §七「用户写的由用户定 mode」)

**起草引擎**(`core/src/skills/drafting.ts`):`draftSkill`(首次,从上下文 / 意图)+ `reviseSkill`(按指令改写),取 `main` 档(质量敏感的撰写任务)产**结构化草稿**(name + description + body + mode)。机制同 `AISecuritySteward`(`ai-steward.ts`)的「一次独立调用 + 解析结构化输出 + fail-safe」范式 —— 注入一个窄 LLM 接口 `(prompt) => Promise<string>`,拼 system 角色 + 上下文 → 单发 → 解析 JSON 草稿(无 JSON / 缺字段即抛:起草失败就是失败、不兜底半成品,与裁判的 fail-safe 不同)→ 过脱敏。**不是工具循环**:起草只是一次结构化生成、不需要工具(authoring 早期措辞写的 `tool-loop` 不准,以此为准)。引擎只收注入的 LLM 接口、不绑运行时,故 v1 在 cli 绑 `callText("main")`、v2 技能管家在 orchestrator 绑自己的通道,同一引擎纯增量(父规格 §九)。**在 AI 编辑屏内被调用**(首次起草 / 后续按指令改写,即 §3.1 的 `editSkill` 访问器),产出落事务草稿态、不直接落盘。

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

提示"想自己改?按 Ctrl+E 用你的编辑器打开"(底部是自由文本输入,故元命令走控制键 —— `tui/key-event.ts` 为此新增 `ctrl-e`)。**打开是纯确定性问题、不放 AI**(见决策三),实现在 `editor-resolve.ts`。

- **编辑器解析(确定性链)**:用户显式配置 → `$VISUAL` → `$EDITOR` → `git config core.editor` → 在 PATH 上探测已知编辑器(code / cursor / subl / idea / zed / nvim / vim)→ OS 兜底(Windows `notepad`、mac `open -t`、linux `nano`)。都没命中 → 退 OS 兜底 + caller 提示固定设一个。探测(which / where)与 spawn 都注入、可纯逻辑单测。`git config core.editor` 这环留了注入位(`gitEditor`)但 v1 REPL 暂未读取 —— env + PATH 探测 + OS 兜底已覆盖常见情形,后续补一次 `git config` 读取即接上。
- **无闪启动**:`.cmd`/`.bat` 包装(如 `code.cmd`)直接拉会闪一个临时控制台,故 spawn 走 **`windowsHide`**(等价 .NET `CreateNoWindow`)+ detached + `unref`,无窗口启动规避闪屏。(更细的「从 `code.cmd` 推同级 `Code.exe`」精确解析 v1 未做,`windowsHide` 已覆盖;若实测仍有闪再补,按"TUI 必须自跑视觉"规约由 `pnpm cli` 确认。)
- **不等关闭**:v1 拉起即返回、**不加 `--wait`** —— 用户在 GUI 窗口里改,回屏靠 §3.3 的 mtime 比对一次性重读,比阻塞等关闭轻且稳。
- **本地 TTY 专用**:`/skill-new` 注册在 typeahead(chrome 本地 cli)路径,故外部编辑器入口在此天然可用;远程 / daemon / 无头没有桌面编辑器 → 那些场景只走 3.1 AI 编辑屏(对话式哪儿都能用,外部编辑器是本地逃生口)。

### 3.3 两路的衔接(决策四:文件单一真相源、一次一面)

**不做实时双向回灌**(两个编辑器同时活在一个文件 = 竞态 + fs.watch 边角,重且不稳)。改为:

- 从 AI 编辑屏按 X 跳外部编辑器 = **先把当前草稿落到文件 + 交接**;AI 编辑屏进入"外部编辑中"暂停态(不接受 AI 指令)。
- 用户在外部编辑器改完(GUI 编辑器在自己窗口,AI 编辑屏的 alt-screen 不受影响)。
- 回到屏内下一次交互时,比对 mtime、**变了就一次性重读**——非持续 watch、非双向同步。极轻、极稳,两路都保住、任何时刻只一面在写。

## 四、保存与生效

确认 → 经注入 writer 调 Store 写 `own/<id>/SKILL.md`(父规格 §二):`id = skillNameToId(name)`(父规格 §5.1,撞名校验:own 同名遮蔽 linked / 提示改名)、`mode` 写 `index.json`、原子写(`writeAtomic`)。落盘走 **Store 已落地的 own 写 API**:`create(draft)`(新建)/ `update(id, draft)`(改写,linked-only 触发 fork-on-edit、改名时迁移 index 状态与 usage 到新 id + 撞名校验),区别于接入 `linked/` 的 `admit`。落盘后**立即可 `/<name>` 唤醒**,下个会话 / 模式切换由索引产生管线自然纳入(父规格 §三,本步不强制即时重建索引)。

## 五、安全归属

- **凭证脱敏**:起草与每次 `editSkill` 都过脱敏(`scrubSecrets`,§二);通用 scrubber 已建在系统层(`core/src/security/secret-scrubber.ts`),非 skill 专属件。
- **app-state 内部**:若起草 / 编辑经 agent 侧工具(写 `own/` 草稿)实现,该工具声明 `app-state` 边界、判 `internal` 自动放行(对标 `load_skill`,父规格 §四)。
- **外部编辑器 spawn 是宿主侧本地操作**:拉起的是用户自己的编辑器进程,非 agent 经工具调用的写入,不经 SecurityPipeline(同 Store 自身 fs 操作,父规格 §六放行落盘的宿主侧写语义);realpath 目录边界仍由 Store 在读写 `own/` 时一处收口(父规格 §一边界判断#1)。

## 六、归属与对接点(汇总)

| 包 | 内容 | 关键对接 |
|---|---|---|
| `core/src/skills/` | 起草引擎 `draftSkill` / `reviseSkill` | `drafting.ts`:注入窄 LLM 接口 `(prompt)=>Promise<string>` + 拼 system 角色单发 + 解析 JSON + 过脱敏(同 `ai-steward.ts` 范式,**非 tool-loop**);落盘用 Store 已落地的 `create` / `update`、`skillNameToId`、`writeAtomic` |
| `core/src/security/` | 通用 secret 脱敏(系统层,首个消费者是 skill) | `secret-scrubber.ts`:`scrubSecrets` 高置信模式(服务商密钥 / PEM / JWT / Bearer / 赋值)+ 带类别占位符;**不复用** `bi-zhixing-credentials-block`(那是 path 规则、无文本扫描) |
| `orchestrator` | 起草用的 main 档单发 LLM 能力 | `AgentRuntime.callText(_, "main")`(`create-agent-runtime.ts`)—— editSkill 访问器在 **cli** 绑它装配,对标 mcpResolve 的注入处(`config-command.ts`) |
| `cli` | AI 编辑屏(controller + render + key + alt-screen loop)、外部编辑器解析 + 无闪 spawn、editSkill 访问器装配、`/skill-new` 入口 | `editor-controller.ts` / `editor-screen.ts`(复用 `tui/` 的 `Renderer` / `KeyEventStream` + 三层退出防御,同 `/skills` 管理器、不反依赖 config-editor)、`editor-resolve.ts`(确定性解析链 + `windowsHide` 无闪 + mtime 重读)、`authoring-command.ts`(照 `config-command.ts` 开屏 + 绑 `callText("main")` + `store.create` + 取 `state.conv.messages`);`tui/key-event.ts` 新增 `ctrl-e`;`screen-controller.ts:reassertCursorHidden` |

## 七、v1 → v2 跨版插座

- **起草引擎**(§二) = v2 技能管家自主复盘新建 / 迭代的**同一引擎**;v1 接"用户触发 + 策展确认",v2 接"自主触发 + 来源边界",纯增量。
- **`editSkill` 访问器**与起草引擎同源:v2 的自主迭代复用它对已有技能改写。
- v1 的**用户确认闸门**是 v2「proactive offer(主动提议存成技能)」要替换 / 旁路的那一处,接口预留即可。

## 八、测试拓扑

落地单测全用 mock 注入(LLM / fs / stdin·stdout / editor spawn),无真编辑器真网真 LLM;alt-screen 的进退 / 流畅度 / 键感按"TUI 必须自跑视觉"由 `pnpm cli` 实测(同 `/skills` 管理器,loop 是 I/O、不单测)。

- **secret 脱敏**(`secret-scrubber.test.ts`):各类高置信模式命中 + 占位符替换;正常长串(git sha / base64)不误伤;赋值式保字段名换值;组合去重。
- **起草引擎**(`drafting.test.ts`):从上下文 / 意图产结构化草稿;mode 默认 / 覆盖;**对话内 secret 不进草稿**(脱敏断言);起草失败即抛(无 JSON / 缺字段)、不兜底;prompt 含上下文与意图。
- **编辑屏控制器**(`editor-controller.test.ts`):起草成功换草稿 / 失败记错留原草稿 / **放弃等待结果丢弃**;保存交 writer;外部编辑两路衔接(进暂停态、mtime 变了重读、未变保留)。
- **编辑屏视图 + 按键**(`editor-screen.test.ts`):各阶段渲染(空草稿引导 / 字段 + 正文 / **drafting 保留内容非全屏 spinner** / external 提示 / error);按键映射(输入缓冲 / 回车提交 / Ctrl+S 保存 / Ctrl+E 外部 / Ctrl+C·Esc 放弃 / external 态任意键读回)。
- **外部编辑器解析**(`editor-resolve.test.ts`):优先级链(configured / VISUAL / EDITOR / git / PATH 探测 / OS 兜底)、空串跳过、spawn 收到 命令 + [...参数, 文件]。
- **接线纯件**(`authoring-command.test.ts`):对话上下文转写 + 取最近 N 条;外部文件 round-trip(含 mode 保留 / 缺失回落)。
- **保存生效**:走 Store 已落地的 `create` / `update`(`own/<id>/SKILL.md`、`skillNameToId` 定 id + 撞名、`mode` 写 index、原子写),其测试在 Store 侧;落盘后 `/<name>` 即可唤醒。
