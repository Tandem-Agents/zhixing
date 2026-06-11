# 技能（Skill）创建与打磨 — 能力内化规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文是执行规格(execution spec),不是修订日志。**
> **只写**:当前生效的架构与方案、决策的"为什么"、与真实代码的对接点(精确到文件:符号)。
> **不写**(协作者修订时一并清理):版本号 / 修订日期 / "最后更新";"vX vs vY" 对比;"改了什么 / 废案"叙事。
> **演化方式**:设计变化时**原地修改**,不追加修订段。历史留给 `git log`。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **需求依据**:[drafts/capability-internalization.md](../drafts/capability-internalization.md)（已定稿:能力内化机制 + 全部裁决）、[drafts/skill-module.md](../drafts/skill-module.md) §2.3 / §3。
> **父规格**:[skill-system.md](./skill-system.md)（Store / 索引 / `load_skill` / builtin 来源区 / 能力工具注册表）。本文详化**创建与打磨这一个内化能力**,不重述机制层。
> **事实依据**:对接点均对已落地代码核实,标注 `文件:符号`;未落地件标注归属计划。

## 〇、定位与范围

本文回答 **v1 用户怎么创建 / 打磨一个技能**。形态 = **能力内化**:用户面前没有"新建技能"这个功能（无专门入口、无屏）,在对话里说一句"把这套存下来",助手当场拟草稿、来回改、存好、继续。创建技能是通用能力内化机制（父规格 builtin 来源区 + 能力工具注册表）的**首个承载**。

- **本文范围**:内置方法的内容要求、`save_skill` 工具契约、对话流协议、提议边界、创建路径退役清单。
- **不在范围**:索引 / 加载 / 唤醒机制（父规格 §三~§五）、外部接入审查（父规格 §六 Admission,`/skill-add` 路径不动）、`/skills` 管理器（独立路径,本次不动）、v2 自主产生（[skill-evolution.md](./skill-evolution.md)）。
- **v1 边界**:提议有边界（§四）、保存必须用户明确接受（§三）;自动产生 / 迭代是 v2 技能管家在同一管线上加的自主触发。

## 一、核心模型:起草是模型行为,护栏在保存工具

**判据**（需求文档定稿）:要不要委派 / 切屏,看这件事用户需不需要全程参与。创建技能是创作打磨,需要用户全程在场、紧凑来回——所以内化进主 agent、当面做,不外包子 agent、不开编辑屏。

形态拆解,各居其位:

- **方法**（教"怎么提炼"）= builtin 来源区的一份 SKILL.md（父规格 builtin 节）,索引常驻稳定前缀（独立小额预算池）、命中或用户意图触发时经 `load_skill` 按需加载——与用户技能同走渐进披露管线,零新机制。
- **起草**（写草稿）= **模型行为,无工具**。草稿就是对话里的一段话,markdown 渲染落对话流（scrollback 原生滚动）;没有起草工具、没有 JSON 中间格式、不花单发 LLM 调用——那是编辑屏时代"表单需要结构化字段"的遗产。修改 = 用户说话、模型改了再贴。**显式权衡**:草稿驻留对话上下文（多轮打磨即多版草稿进窗口）,这是内化形态的已知代价、非缺陷——创作本就是对话的内容;缓解 = 方法要求按改动幅度只贴变化部分（§二.4）+ 段切换自然压缩。
- **保存**（落盘）= `save_skill` 工具,四不变量的唯一焊接点（§三）。判断全交模型,护栏全在工具——通用 `Write` 给不出这些保证,这正是不开"直接不管"口子的原因。

## 二、内置方法(「提炼技能的方法」)的内容要求

方法是这个能力的产品灵魂——代码量最小、价值最大。承载形态:builtin SKILL.md（包资源、随版本分发、只读;用户定制走 fork-to-own,父规格 builtin 节）。内容必须覆盖,且**只**以方法文字承载（不进代码）:

1. **何时提议**（§四边界的 prompt 层落地）:仅两种时机——用户显式要求;或一套做法刚被验证走通且置信足够高。只提议、绝不自动保存,被拒不就同一件事重提。
2. **收自语境**:起草前先一句说清"收的是哪件事"（对话里的哪段 / 用户哪句意图）——猜错用户一句话就能纠;这是旧 UX 评审"收自:X"知情原则的对话流形态。
3. **瘦版判据**（skill-module §1 定稿形态）:只留用户的特定约定 + 这次的坑 / 最优路径,主动丢通用步骤;`description` 以"什么时候该用"为导向（直接决定日后检索命中）;`mode` 默认按当前场景（工作场景 → `work`,否则 `main`）、用户可改。
4. **打磨协议**:草稿贴在对话里,邀请用户用大白话指哪改哪;改后只贴变化部分或重贴全文（按改动幅度判断）。
5. **保存前明确同意**:必须拿到用户明确接受（"存吧 / 就这样 / 保存"）;意图不明就问一句。这是产品层护栏,与 §三系统层护栏双层焊死。
6. **保存后诚实交代**:按 `save_skill` 返回如实说——存好了、`/<name>` 随时唤起、聊到相关话题会被检索命中（说具体场景,不说"自动想起"——那是 v2 能力,v1 承诺了会失信）;若返回脱敏计数 > 0,告知"已自动抹掉 N 处密钥,不会写进技能"。
7. **同名即更新**:用户说"把那个技能补一条"时按 upsert 走（§三）,改前确认目标技能、改后同样要明确接受。

## 三、`save_skill` 工具契约（= SkillSavePipeline + 确认护栏的工具包装）

**两层正交分解,不混为一谈**:**`SkillSavePipeline`**（核心管线）焊死四不变量,**无触发语义**——谁来的、要不要确认,它不知道也不该知道;**`save_skill`**（唯一新工具,经父规格能力工具注册表登记,v1 直进 `tools[]`,红线:每能力 ≤ 1 工具）= Pipeline + 用户确认护栏的 v1 包装,服务对话流路径。v2 技能管家走 `StewardWriter → SkillSavePipeline` 后台路径（自主落盘 + `stewardCreated` 来源标记,skill-evolution）——复用的是**管线**,不背上工具的确认语义;"用户确认"是产品护栏、"落盘不变量"是系统资产,两者分层、互不污染。

**输入**:`{ name, description, body, mode? }`——模型从对话里的定稿草稿组装;`mode` 缺省按当前场景。

**upsert 语义**:`id = skillNameToId(name)`（父规格 §5.1）。own 区无此 id → 创建（`SkillStore.create`）;已有 → 更新（`SkillStore.update`,linked 同名时沿用其 fork-on-edit 与撞名校验语义）。创建与打磨是同一能力、同一工具、同一焊接点;v2 技能管家迭代走同一管线。

**四不变量焊接**（`SkillSavePipeline` 本体,执行顺序即管线顺序）:

1. **凭证脱敏**:`scrubSecrets`（`core/src/security/secret-scrubber.ts`,已落地）对 name / description / body 全量过滤,返回命中计数——草稿源自对话、对话里可能粘过 secret,技能会反复进上下文且可分享,绝不固化。
2. **来源落位**:恒写 `own/<id>/SKILL.md`（本地区,目录即来源,父规格 §二）;builtin / linked 不可写。
3. **格式与分区**:标准 SKILL.md + YAML frontmatter（`stringifyFrontmatter`,`core/memory/frontmatter.ts`）、`mode` 写 `index.json`、原子写（`writeAtomic`）——全部经 Store 既有写 API,不绕过唯一磁盘访问点。
4. **索引一致性**:落盘后触发索引产生管线标记重建;生效时机沿既有纪律——`/<name>` 唤醒立即可用（`listAll` 实时扫描）,系统提示词索引在下一个注意力窗口换代时进入稳定前缀（窗口内 systemPrompt byte-equal 不破,父规格 §3.2/3.3）。

**返回**:`{ id, outcome: "created" | "updated", scrubbedCount, hint }`——`hint` 携 `/<id>` 唤起事实,方法据此向用户诚实交代;`scrubbedCount > 0` 驱动脱敏可见。

**安全归属（系统层护栏,属 `save_skill` 包装层、不属 Pipeline）**:`save_skill` 是持久化副作用工具,按既有安全管线走（副作用工具的边界声明 + 确认策略,✎ 副作用锚渲染）,**不声明 `app-state` 自动放行**——读工具 `load_skill` 的 internal 放行语义（父规格 §四）不适用于写持久资产;用户说"存"后若管线要求确认就确认一次,信任规则沉淀后自然免。静默落盘在机制上不可能（产品层 §二.5 + 系统层双重护栏）。

## 四、提议边界与 v2 关系

提议时机与禁止项写进内置方法（§二.1）,不进代码——模型判断、方法约束。v2 技能管家的"自主复盘产生 / 迭代"是**后台路径**:经 `StewardWriter` 走同一 `SkillSavePipeline`（不经 save_skill 工具包装、不背确认语义）+ 来源标记（`stewardCreated`,父规格 §九）+ 自己的门槛,与对话内提议互不替代。v1 不实现任何自动产生。

## 五、对话流协议与 UX 原则落点

| 旧 UX 评审原则 | 内化形态落点 |
|---|---|
| 收自:X 语境知情 | 方法 §二.2——起草前模型口头说明 |
| 脱敏可见 | `save_skill` 返回 `scrubbedCount` → 方法 §二.6 告知（真抹了才说,不无中生有） |
| 诚实承诺 | 方法 §二.6——只说 v1 真有的（`/<name>` 唤起 + description 检索命中） |
| 放弃 / 覆盖护栏 | 保存前明确同意（双层焊死,§二.5 + §三）;upsert 改前确认目标 |

草稿渲染走各端既有 markdown 投影（cli 的 markdown 渲染 / 渠道卡片）,无任何专属 UI 代码——这是"全接入面可用"验收项的实现方式:能力装配在 runtime 层（方法经 builtin 索引、工具经注册表进 `createAgentRuntime` 装配）,cli / serve / 飞书 / ephemeral 同一管线。

## 六、创建路径退役清单

随本规格生效退役（三条路径相互独立,`/skills` 管理器与 `/skill-add` admission 不动;config-editor 等其他模块零波及）:

- `cli/src/skills/authoring-command.ts` —— `/skill-new` 命令注册撤（typeahead 注册与 dispatcher handler 一并）
- `cli/src/skills/editor-screen.ts`、`cli/src/skills/editor-controller.ts` —— alt-screen 编辑屏与阶段机
- `cli/src/skills/editor-resolve.ts` —— 外部编辑器解析链（其唯一消费者是编辑屏 Ctrl+E;"长内容编辑还给用户编辑器"是远期方向,届时另议承载）
- `core/src/skills/drafting.ts` —— `draftSkill` / `reviseSkill` 起草引擎（起草无工具;其提炼判据融入内置方法 §二.3,不保留代码形态）;`core/src/skills/index.ts` barrel 的 drafting 导出一并摘除
- `tui/key-event.ts` 的 `ctrl-e`、`composeViewport` 等公共原语**保留**（中性 tui 件,非 skill 专属）

保留不动:`scrubSecrets`（系统层,save_skill 复用）、`SkillStore` 全部写 API（save_skill 的落盘后端）、admission 全链、manager 全链。

## 七、测试拓扑

- **save_skill 工具**:upsert 双路（无 id 创建 / 有 id 更新）;对话内 secret 不落盘（脱敏断言 + scrubbedCount 返回）;恒落 own 区、builtin / linked 拒写;mode 缺省与显式;返回字段完整;撞名校验沿 Store 语义。
- **内置方法注册**:builtin 来源区被发现、索引含其条目、`load_skill` 可加载全文;**负向边界验收在父规格 §十「builtin 边界」逐条钉死**(listAll / listForManagement / slash 零暴露、不写 usage、不进 index.json、分池不挤占、own 遮蔽)——实现本能力时该组用例必须随 builtin 落地一并交付,不得后补。
- **退役清理**:命令注册表无 `/skill-new`;skills 目录无 editor-* / drafting 残留引用（grep 级断言归 lint / 评审）。
- **对话流端到端**（实测,非单测）:按"TUI 必须自跑视觉"规约 `pnpm cli` 走一轮——提议 → 草稿 → 改一轮 → 存 → `/<name>` 唤起。
