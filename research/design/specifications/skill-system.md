# 技能（Skill）系统 — 架构设计规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **本文是执行规格(execution spec),不是修订日志。**
> **只写**:当前生效的架构与方案、决策的"为什么"、与真实代码的对接点(精确到文件:符号)。
> **不写**(协作者修订时一并清理):版本号 / 修订日期 / "最后更新";"vX vs vY" 对比;"改了什么 / 废案"叙事。
> **演化方式**:设计变化时**原地修改**,不追加修订段。历史留给 `git log`。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **需求依据**:[drafts/skill-module.md](../drafts/skill-module.md)（需求已定稿）。本文是其**架构实现规格**,不重述需求论证。
> **相关规格**:[prompt-system.md](./prompt-system.md)、[lightweight-tool-loop.md](./lightweight-tool-loop.md);[ADR-004 工具系统](../architecture/decisions/004-tool-system-architecture.md)。
> **事实依据**:对接点均对已落地代码核实,标注 `文件:行/符号`。

## 〇、定位与范围

skill = 可复用的「做某类事的方法」（程序性知识）,按需调取;核心机制 = **渐进披露**（廉价索引常驻稳定前缀、命中再加载全文）。本质与价值见需求文档,本文不复述。

- **本文范围**:**v1 地基**的完整可执行架构 + **v2 自进化**的插座预留。
- **v1 = 静态 + 手动 + 模式分区的技能库**:用户手写 / 接入、按 main·work 分发、渐进披露注入、主动 top-N 控量、审查 + 目录边界约束保安全、可见可管。
- **v2(本文只留插座、不实现)**:技能管家（Skill Steward）产生 / 治理 / 淘汰。
- **不在范围**:与记忆模块的耦合;多来源作用域分层。

## 一、模块分解

五层,职责单一、依赖单向收敛到 **Store**(无环):

| 层 | 职责 | 归属 |
|---|---|---|
| **Store** | 唯一真相源 + **唯一磁盘访问点**;发现 / 解析 / 读写;目录边界约束;两条写通道(结构性元数据 / 度量旁路);写隔离 + fork | `core/src/skills/` |
| **Index** | Store 的**纯投影**:模式过滤 → top-N → 序列化 → 缓存 | 产生逻辑 `core`;接入 system prompt `orchestrator` |
| **Loader** | 固定 `load_skill` 工具:取全文 + 度量采集 | 工具体 `core`;注册 `orchestrator` |
| **Admission** | 接入口一次性内容闸门:规则扫描 + AI 语义 + 分级 | 规则 `core`;AI 编排 `orchestrator`/`cli` |
| **Control** | 控制面 + `/<name>` 动态指令 | `cli` |

**依赖图**:`Control → {Store, Admission, Loader, 指令系统}`、`Admission → Store`、`Index → Store`、`Loader → Store`。全部指向 Store,无环。

**五条边界判断**:
1. **单一真相源 + 单一磁盘访问点** —— 存在性以磁盘目录为唯一真相(`index.json` 退化为状态旁路、不与目录成双重真相),文件访问全经 Store;目录边界约束因此一处强制、无死角;并发亦在 Store 一处收口。
2. **Index 是纯投影** —— 不持有真相,失效即从 Store 重建;这是稳定前缀缓存友好与（v2）边界重建安全的根因。
3. **skill 是订阅者 / 注册者,不侵入上层** —— 索引段、`load_skill`、`/<name>` 都经上层既有扩展点接入。
4. **`load_skill` 是度量唯一门** —— 故必须专用工具、经 Store 取文件。
5. **度量与结构性元数据分通道** —— 度量高频且不触发索引刷新,是缓存稳定的前提。

## 二、磁盘数据模型

**两层物理分离**(同构于 `config.jsonc` 决策层 / `credentials.json` 内容层、`me/` 记忆层各自独立的既有哲学):

- **内容层** = `SKILL.md`(YAML frontmatter + 正文)+ 同目录附属文件,**与 Agent Skills 生态逐字节兼容**。接入技能原样落盘,**绝不回写其 `SKILL.md`**。
- **状态层 / 度量层** = zhixing 私有、会变,集中到库根旁路;`SKILL.md` frontmatter **零私有字段**。

**目录布局**(根 `~/.zhixing/skills/`,新建 `core/src/skills/paths.ts` 集中路径,仿 `core/workscene/paths.ts`):

```
~/.zhixing/skills/
├── index.json          状态旁路表（mode/pinned/disabled；存在性由目录扫描决定、非此表）
├── own/<id>/           本地区：本地产生/编辑（用户手写、让 AI 写、fork、v2 技能管家自产）
│   ├── SKILL.md        frontmatter + 正文（生态标准）
│   └── <附属文件>
├── linked/<id>/        接入区：从外部源接入（社区 / 官方）；原样保存、链接上游、对技能管家只读
│   └── SKILL.md ...
├── archived/<id>/      归档区：删=归档可逆
└── usage/<id>.json     度量旁路：高频写、与内容和结构性状态都分通道
```

**发现与存在性**:技能存在性由 **Store 扫 `own/` + `linked/` 目录**决定（生态惯例 —— OpenClaw / Hermes / Claude 三家皆扫目录、标准技能目录放进来即被发现,契合「格式统一 / 外部接入」）。`index.json` **不决定存在、只存状态**:对扫到的每个技能配 `mode/pinned/disabled`;**首次扫到(无记录)即持久化登记**默认状态（`mode` 默认 `main`、可由用户 / 接入时改）+ `createdAt = now`（`createdAt` 必须持久化、之后不变,否则每次扫描都"刚创建"会破坏排序）。来源不配字段 —— `own`/`linked` 目录即来源。**`id = skillNameToId(frontmatter.name)`（锚定 SKILL.md 的 name、非目录名）**;扫描时建 `id → 实际目录路径` 映射供定位 —— **目录名仅物理位置**:Store 产生的（接入 / v2）目录名 = id,用户手写的目录名随意也不断（id 锚 frontmatter.name、经映射定位）。index 损坏不致命 —— 技能仍在、状态重置;磁盘目录是存在性单一真相源。

**`index.json`（状态旁路）** —— 每条:

```jsonc
{
  "id": "<safe-id>",                 // = skillNameToId(frontmatter.name)（见 §五.1）；撞名扫描时 own 优先遮蔽 linked
  "mode": "main|work",               // 模式分区；权威在此（frontmatter 不含），初值由创建/接入上下文定、之后用户可改
  "pinned": false,                   // top-N 强制进 + 不被技能管家淘汰
  "disabled": false,                 // 临时禁用：不进索引、保留技能
  "createdAt": "<iso>"               // 首次扫到/接入/创建时持久化写一次；top-N 对无 usage 新技能的 lastHitAt fallback（防冷启动）
}
```

**来源不入 index**:技能从哪来由目录直接决定 —— `own/` = **本地产生 / 编辑**(你手写、让 AI 写、fork、v2 技能管家自产)、`linked/` = **从外部源接入**(社区 / 官方);与 `location` 同理(目录能定的不存字段)。来源的唯一消费者是 v2 的来源边界,它要的是「技能管家自产 vs 其它一切」的**二分**;仅 v2 需在 `own/` 内区分"技能管家自产 vs 用户手写"(目录分不出),届时加一个 `stewardCreated` 布尔标记激活来源边界。v1 无此需求、不设来源字段。

结构性变更(增删 / 改 mode / pin / disable)= **结构性写通道** → 标记索引 dirty。

**`usage/<id>.json`** —— `{ lastHitAt, hitCount }`,极简。`load_skill` 命中时写,**不标 dirty**(频次只被动影响下次产生,不主动触发刷新);每技能独立小文件、低竞争。消费者:top-N 排序(v1)+ 淘汰判断(v2)。

**写隔离与 fork-on-edit**:
- 区即能力边界:技能管家(v2)写 API 只能落 `own/`、够不到 `linked/`(能力层兜住「只动自己产生的」)。**用户始终可改任何技能。**
- 用户改 `linked/` 技能 → copy 到 `own/<id>`、改副本;原 `linked/` 不动、可继续同步上游;**扫描时 own 同名遮蔽 linked**,改后版本生效(它现在落在 `own/`(本地区),来源随目录自然转换)。
- **v2 决断点**(不影响 v1):是否把 `own/` 再物理细分出技能管家自产子区(使其对用户手写技能从「逻辑保护」升级为「物理只读」)。v1 只需保证 `linked` 物理只读;来源标记(`stewardCreated`)是 v2 才加的字段。

**`SkillStore` 接口与注入**(对标 `MemoryStore`):核心 API —— `listAll()`(全量、剔 `disabled`,`/<name>` 补全用)、`queryTopN(mode, n)`(top-N 过滤视图,索引产生用);二者**共享 `disabled`/mode 过滤、仅末步 limit 不同**(`listAll` ≡ `queryTopN(n=∞)`)—— 单一过滤点,防两视图分叉、为日后可见性 / 权限控制留扩展位。另有 `loadText(name)`(经目录边界约束读全文 + 写 usage)、`admit(stagingDir)`、`setState(id, patch)`、`archive(id)`、`fork(id)`。

构造与注入:`SkillStore` 在 `create-agent-runtime.ts:507` 入口构造(仿 `memoryStore`:504 —— 无状态、每次 runtime 装配 `new`、路径由 `getZhixingHome()` 定),注入 `builtinCtx`;`BuiltinToolContext`(`tools-builtin/factories.ts:30`)增 `skillStore?` 字段,`load_skill` 工厂检测缺失即 fail-fast(仿 `memory` 工具,`factories.test.ts:14`)。Control(cli)另 `new` 一个 Store —— 各自独立、共享同一磁盘目录。

**复用的 core 设施**(均在 core,Store 无需上层依赖):
- 原子写 `writeAtomic`(`core/transcript/serializer.ts:54`,含 Windows fallback)—— **不用** `providers/internal/io.ts:writeJsonAtomic`(在 providers 包,core 不可反向依赖)。
- per-id 锁(`Map<id,Promise>` 尾链 GC)+ 单 index 锁,范式仿 `core/workscene/registry.ts`。
- `getZhixingHome`(`core/paths.ts:19`)、`parseFrontmatter` / `stringifyFrontmatter`(`core/memory/frontmatter.ts:34`/:58 —— 只支持扁平 key:value + 简单数组、**不支持嵌套对象**;读写 `name` / `description` 等扁平字段够用、`linked` 原样保存不受影响)。
- **`name→id` 变换不用 `toSafePathSegment`** —— 它只替换 `:→--`、不处理空格 / 大小写(`core/paths.ts:47`,是 conversation/workscene 的通用件,对带空格的技能名会断链)。skill 用自己的 `skillNameToId`(§五.1)。

## 三、索引与系统提示词

### 3.1 注意力窗口生命周期(认知前提)

现有死线「`systemPrompt` 装配后 byte-equal、不重建」(`create-agent-runtime.ts:632` 唯一构造点 + `system-prompt.ts:163` 调用契约)的本意是:**在一次注意力窗口生命周期内,cache 优先、不动稳定前缀**。其完整形态:

> 稳定前缀在**单个注意力窗口生命周期内** byte-equal 不动;**跨窗口生命周期边界**(压缩 / 模式切换 / resume)才允许重建,且重建是「检查 → 变了才换、没变 byte-equal 不动」。

### 3.2 v1 落地:索引作装配期条件段 + 预留可重建插座

**索引段进 system prompt 稳定区,装配期构造、绑 runtime 生命周期。** 在 `system-prompt.ts` 的 `SystemPromptSegment` 枚举新增 `"skill-index"`、`renderSegment` 加分支、列入 `MAIN_AGENT_SEGMENTS`（条件段:无可见技能则返 `null` 跳过,仿 `working-mode` 段）。索引文本由 §3.4 管线在 `create-agent-runtime.ts:637` 唯一构造点按当前 mode 渲染一次（mode 来源:`createAgentRuntime` options 新增 `skillMode?: "main"|"work"`,`session.ts` `createAgent()` 按 `isWorkscene` 传 `"work"`/`"main"`,缺省 `"main"`）。

**模式切换天然换索引,不需要运行时重建机制。** 模式切换 = 换 runtime(已核实接入:`repl.ts` `applyModeSwitch:1240` + 主回路 turn 边界消费 :2127、`session.ts` `enterWorkMode:515`/`exitWorkMode:535`),新 runtime 在 `create-agent-runtime` 装配时构造对应 mode 的 system prompt —— 本就是重建。

**v1 运行中不重建索引。** 用户 / 接入新增技能不即时进当前 runtime 索引;靠 `/<name>` 手动唤醒立刻可用(不依赖索引)+ 下个会话 / 模式切换自然纳入。v1 没有「运行中频繁刷新索引」的使用者,故不实现边界重建机制。

**预留插座(v1 不引入无用 mutability)**:v1 `systemPrompt` **保持闭包 `const`**(零 mutability、无意外破 cache 风险);真正的"插座"是 `buildSystemPrompt` 本就是**可随时重调的纯函数**(重渲染无副作用)。v2 做边界重建时再把 `const systemPrompt` 改为 `const holder = { value: ... }`、`run()` 透传 `holder.value`(`anthropic-messages.ts:71` 每轮从 `request.systemPrompt` 现取,无脏引用)—— 这是一行重构,v2 的真正工作是"边界重建检查"逻辑、与 holder 无关。

### 3.3 v2 激活:边界重建检查(本文只描述插座如何被接)

v2 技能管家在运行中产生 / 淘汰技能,需让模型当会话即见。届时在「注意力窗口生命周期边界」触发"重建检查":Index 比对当前 mode 的产出与上次(技能集结构 hash + top-N 结果),**变了才重渲染索引段、替换 holder;没变 byte-equal 不动、cache 不破**。可挂载点:压缩有 `context:compact_end` 事件(`engine.ts onTurnComplete:134`,该流程**只动 messages、不碰 systemPrompt**,故重建是新增动作而非改其行为)。此「窗口生命周期边界」宜抽象为 prompt / 上下文层的注册式订阅点,skill 索引为首个订阅者;**不属 skill 模块**。

### 3.4 索引产生管线

扫 `own/` + `linked/` 目录得技能集、配 `index.json` 状态 → 剔 `disabled` + 按当前 mode 过滤 → **排序**:`pinned` 优先;其余按 **`(usage.lastHitAt ?? index.createdAt)` 降序**(新近度敏感 —— 最近用的最可能再用;**无 usage 的新技能 fallback 到 `createdAt`、视为"刚加入"靠前,获得曝光、防"没用过→不显示→用不到"冷启动**),`hitCount` 作 tiebreaker(同新近度则用得多的在前)→ 取 **top-N**(事前限定 N + 每条仅 `id`(= `skillNameToId` 结果)+ `description`,不含路径 —— 模型靠 `id` 调 `load_skill`,无需路径)→ 渲染为索引段。总量有确定上界、恒在预算内(无降级兜底;真超了是 N / 单条上限设错的 bug)。

**索引段文本格式**(由 `renderSkillIndex` 生成,仿 `buildToolUsage`):

```
## Available Skills
To use a skill, call the `load_skill` tool with the id shown below. Descriptions are brief — load one for full instructions.
- **<id>**: <description>
- ★ **<id>**: <description>          (★ = pinned)
```

无可见技能 → 返 `null`(段跳过、不破 byte-equal)。

## 四、加载(`load_skill` 工具)

`load_skill` = 固定的主 agent `ToolDefinition`(`core/types/tools.ts`),注册进 `BUILTIN_TOOL_FACTORIES`(`create-agent-runtime.ts:518` 按 `profile.enabledTools` 实例化)、列入 main 与 work profile 的 `enabledTools`。**技能再增删,工具集恒只此一个加载工具** → 契合「工具集装配期 freeze」,索引变化不动工具集。

- **安全属性(对标 `memory` 工具 —— 同属"只读写应用内部数据、无外部副作用"的内部工具)**:**关键 —— 注册进 `createDefaultClassifier` 的 `internalClassifier`**(`classifier.ts:411-414`,与 `memory`/`schedule` 同列),`classify → "internal"`,不被 `OperationClassifierMiddleware` 升级为确认(`security-pipeline.ts:135` 仅 `external`/`critical` 才确认)。**否则**:`load_skill` 进 `baseTools`、无专属 classifier、无 boundaries → `BoundaryImpactClassifier` 判 `critical`(`classifier.ts:313`)→ 每次加载弹确认。其余:`needsPermission: false`、`isReadOnly: false`(写 `usage`)、`isParallelSafe: true`(per-id 锁护 usage 写);不声明 `boundaries`(走 internalClassifier、不经 BoundaryImpactClassifier)。
- **不设 `maxResultChars`**(`tools.ts:277` 不设 = 不限制;否则全文被 `applyMaxResultChars` 截断,`tool-executor.ts:208`)。技能全文须完整入上下文。
- **统一用 `id`**:索引显示、`/<name>`、`load_skill` 参数、目录名**全是 `id = skillNameToId(name)`**(§五.1)—— 单一变换、无断链;原始 `name` 仅供显示(`SKILL.md` frontmatter + `CommandDef.aliases`)。`skillNameToId` 幂等,Store 对入参再过一次也安全。
- 流程:模型扫索引命中 → `load_skill(id)` → Store 按 `id` 经扫描映射定位到实际目录的 `SKILL.md`（目录名不必 = id,见 §二「发现与存在性」）→ 经 Store 文件访问(realpath **目录边界约束**)读全文 → 作 `tool_result` 进上下文(随注意力窗口自然管理,skill 不单独管其生命周期)→ 写 `usage/<id>.json`(不标 dirty)。**度量唯一采集门**。

## 五、手动唤醒与控制面

### 5.1 `/<name>` 动态指令 —— 走 `execution: "agent"`,无需 handler

`SkillCommandSource implements DynamicCommandSource`(`core/typeahead/types.ts:323`):`list()` 读 **`SkillStore.listAll()`**(`index` 只有状态、无 `name`/`description`;`listAll` 从 `SKILL.md` 解析出 `name`+`description`)→ 每个技能映射为 `CommandDef`(`category:"plugin"`、`execution:"agent"`)。在 `repl.ts:1507` 的 `DefaultCommandRegistry` 上 `registerDynamicSource` 注册一次;技能集变更触发 `registry.refresh()` + `onChange` 重建补全候选。

`execution:"agent"`(`types.ts:101`)语义 = accept 后整条作 user message 发给 agent loop;**`execution=agent` 不调 handler**(`command-dispatcher.ts:116`)→ **动态技能指令无需注册任何 handler**,`SkillCommandSource` 只产 `CommandDef` 即可。手动唤醒由此与模型自动命中**统一走「agent loop 调 `load_skill`」一条路**,无旁路。**`skillNameToId`（全局唯一的 `name→id` 变换 —— 目录名 / 索引显示 / `/<name>` / `load_skill` 查找**全部共用同一函数**,这是不断链的关键）**:`name.toLowerCase()` → 空白 `→ -` → **仅移除文件名非法字符** `<>:"/\|?*` + 控制符 → 合并连续 `-`、去首尾 `-`。**保留 Unicode**（"代码审查" → "代码审查",中文名照常可用;**不可**像普通 sanitize 那样移除非 ASCII,否则中文名变空）。理由:dispatch 按空白切第一个 token 作命令名（`command-dispatcher.ts:92`），含空格的原始名必匹配失败;且目录名 / slash 名 / `load_skill` 查找若用不同变换则断链。`CommandDef.name = skillNameToId(name)`、`id = "skill:<同值>"`、`aliases` 保留原名供显示;与现有命令撞名 → registry 既有冲突策略（`registry.ts:152-161` 保守跳过 + 记错）兜底（不注册为 slash 命令,仍可经控制面手动唤醒）。

### 5.2 控制面(cli)

列表 = 扫目录得技能集 + 配 `index` 状态(活跃 / 禁用 / 归档视图);`pin` / `禁用` / `改 mode` = 改 `index` 字段(结构性写 → 标 dirty);`删` = 物理移到 `archived/`(可逆、不物理删 —— 扫 `own`/`linked` 不再见、归档视图扫 `archived/`);`编辑` = `own` 直改 / `linked` 触发 fork-on-edit。交互复用 config-editor modal 与 resume 既有流程。

## 六、接入与审查(Admission)

接入(本地路径 / URL / 仓库)→ 落候选暂存目录 `~/.zhixing/skills/.staging/<tmp>/` → Admission:
1. **静态规则扫描**:prompt 注入 / 信息外泄 / 窃凭证模式 + 候选目录内 realpath 不越界(目录边界约束)。
2. **AI 语义识别**:复用轻量工具循环(`core/tool-loop`)+ `AgentRuntime.callText`,判模糊可疑。
3. **分级裁决**:确凿恶意挡死 / 模糊可疑交用户决定 / 干净放行 —— 不靠系统阈值静默放行。

放行 → Store 把暂存内文件**逐个 `writeAtomic` copy** 到 `linked/<id>/`(**不靠目录 rename** —— Windows 跨卷不原子;每文件原子写、全部成功后再清暂存),即被扫到 = 发现 = 接入来源;`index` 补该 id 状态(`mode` 接入时选定);未过审则清理暂存。装前审查展示复用 config-editor modal(MCP 接入那套交互)。

## 七、模式分发

Index 产生时按 `index.mode` 过滤:标 `main` 进 main runtime 索引、标 `work` 进 work runtime 索引。模式切换 = 换 runtime(§3.2,已核实接入)= 天然换对应 mode 索引。全集始终可 `/<name>` 手动唤醒 —— 索引只是「按 mode + top-N 的视图」。现阶段 `work` 全进所有工作场景;架构预留「未来 work 细化绑定具体工作场景」,现阶段不做。

## 八、归属与对接点(汇总)

| 包 | 内容 | 关键对接 |
|---|---|---|
| `core/src/skills/` | Store、索引产生、Admission 规则扫描、`load_skill` 执行 | `core/paths.ts`、`transcript/serializer.ts:54`、`memory/frontmatter.ts:34`、`workscene/registry.ts`(锁范式)、`classifier.ts`(`load_skill` 入 `internalClassifier`) |
| `orchestrator` | Store 构造 + `builtinCtx` 注入;`load_skill` 注册;skill 索引段接入 system prompt | `create-agent-runtime.ts:507/518/637`、`system-prompt.ts`(`SystemPromptSegment`/`renderSegment`/`MAIN_AGENT_SEGMENTS`) |
| `cli` | `SkillCommandSource`、控制面、接入交互 | `repl.ts:1507`(registry)、`core/typeahead/types.ts:323`、config-editor |

「注意力窗口生命周期边界」事件属 prompt / 上下文层,非 skill 模块;v1 `systemPrompt` 保持 `const`(`buildSystemPrompt` 本就可重调),v2 边界重建时再改 holder。

## 九、v1 → v2 跨版插座

第二版往这些预留点插入、不推倒重来:
- **度量信号** —— `usage/` 旁路,v1 已用于 top-N 排序;v2 加「淘汰判断」第二消费者。
- **来源标记** —— v1 来源全由目录定(`own` 本地产生 / `linked` 外部接入)、不设字段;v2 在 `own/` 内加 `stewardCreated` 布尔标记激活来源边界(技能管家只动自产)。插座 = `index.json` 是 per-id 可扩展状态对象,v2 加字段即纯增量。
- **`load_skill`(度量采集点)** —— v1 建好,v2 直接接。**`systemPrompt` 可重建插座** —— v1 保持 `const`(`buildSystemPrompt` 本就是可重调纯函数),v2 改 holder(一行)+ 加边界重建检查(§3.3)。
- **写隔离** —— v1 `linked` 物理只读;v2 决断 `own` 是否再物理细分(§二)。

## 十、测试拓扑

- **Store**:扫目录发现技能、无 index 记录用默认状态(来源由 own/linked 目录定、不存字段);解析坏 `SKILL.md` 不污染全局(隔离该技能);目录边界约束拒绝 realpath 越界;fork-on-edit copy 后扫描 own 遮蔽 linked;两写通道(度量写不标 dirty)。
- **Index**:模式过滤 + pinned 优先 + top-N(超 N 取够、每条限尺寸);序列化 byte-equal 可断言。
- **Loader**:`load_skill` 未设 `maxResultChars` → 长全文不截;`needsPermission:false` 不触发确认;命中写 usage;越界路径被拒。
- **Admission**:规则命中确凿恶意挡死、模糊交用户、干净放行;回滚候选目录。
- **Control / 指令**:`SkillCommandSource.list()` 产 `execution:"agent"` 的 `CommandDef`;`refresh()` 后补全更新;`/<name>` 不需 handler 即可分派为 agent message。
- 纯逻辑注入 mock(fs / LLM / registry),无真网真 LLM。
