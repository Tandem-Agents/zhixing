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
- **v1 = 静态 + 手动 + 模式分区的技能库**:用户手写 / 接入、按 main·work 分发、渐进披露注入、主动 top-N 控量、接入期审查 + 运行期 realpath 目录边界约束保安全、可见可管。
- **v2(本文只留插座、不实现)**:技能管家（Skill Steward）产生 / 治理 / 淘汰。
- **不在范围**:与记忆模块的耦合;多来源作用域分层。

## 一、模块分解

五层,职责单一、依赖单向收敛到 **Store**(无环):

| 层 | 职责 | 归属 |
|---|---|---|
| **Store** | 唯一真相源 + **唯一磁盘访问点**;发现 / 解析 / 读写;**realpath 目录边界约束**(一处强制);两条写通道(结构性元数据 / 度量旁路);写隔离 + fork | `core/src/skills/` |
| **Index** | Store 的**纯投影**:模式过滤 → top-N → 序列化 → 缓存 | 产生逻辑 `core`;接入 system prompt `orchestrator` |
| **Loader** | 固定 `load_skill` 工具:取全文 + 度量采集 | 工具体 `core`;注册 `orchestrator` |
| **Admission** | 接入口一次性内容闸门:静态内容审查(技能自建——内置规则无文本内容扫描)+ 复用 core realpath 目录边界 + AI 语义 + 分级裁决;入口 = 对话流 `admit_skill` 工具(§六) | 内容审查 / 目录边界 / 工具体 `core`;AI 裁判通道经 `orchestrator` runtime 装配注入;cli 不承载接入编排(仅 `/skills` 策展与 `/<name>` 唤醒) |
| **Control** | 技能管理器(alt-screen)+ `/<name>` 唤醒指令 | `cli` |

**依赖图**:`Control → {Store, 指令系统}`(接入退出 cli 后,管理器与唤醒不再触达 Admission)、`admit_skill 工具 → Admission → Store`、`Index → Store`、`Loader → Store`。全部指向 Store,无环。

**五条边界判断**:
1. **单一真相源 + 单一磁盘访问点(单一解析点)** —— 存在性按来源分治、各域单一真相(用户与外部技能 = 磁盘目录,builtin = 包内注册集,§二;`index.json` 退化为状态旁路、不与目录成双重真相),文件访问全经 Store;**目录边界约束因此一处强制、无死角 —— 但「无死角」靠的是 realpath 边界,不是朴素 `path.startsWith`**:Store 进出口对「被检查路径」与「库根 / staging 边界」**两边都先 realpath 再比前缀**,复用权限模块沉淀的 `PathGuard.resolve`(`path-guard.ts:28`,realpath + 路径不存在时逐级回退到最近存在祖先做 realpath 再拼剩余段,父目录 symlink 也被解析)与对称判定 `PathGuard.isWithinWorkspace`(`path-guard.ts:65`,target / 边界两边走同一 resolve),**不另起一套路径边界实现**。这是权限模块最高优先债务 S1 的教训 —— 决策前必须 realpath、且在单一解析点做一次(权限管线即 `PathResolveMiddleware` order=-5 把 realpath 后路径回写 `resolvedAccess.paths` 供全下游消费,`path-resolve.ts:1-13`),否则「先用未解析路径比边界、realpath 发生在之后」留 symlink 逃逸洞。Store 把 realpath 收敛到磁盘进出口一处,即对应此「单一解析点」范式;并发亦在 Store 一处收口。
2. **Index 是纯投影** —— 不持有真相,失效即从 Store 重建;这是稳定前缀缓存友好与（v2）边界重建安全的根因。
3. **skill 是订阅者 / 注册者,不侵入上层** —— 索引段、`load_skill`、`/<name>`、`/skills` 管理器都经上层既有扩展点接入(系统提示词段 / 工具注册 / 命令注册 / 共享 alt-screen 屏基础),不改其框架。
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

**builtin 来源区（包资源,第三来源 —— 能力内化机制的承载,需求见 [capability-internalization.md](../drafts/capability-internalization.md)）**:系统内置能力的方法（首个:「提炼技能的方法」,skill-authoring.md §二）以标准 SKILL.md 形态作**包内资源**随代码版本分发,**不落 `~/.zhixing/skills/`**——升级即更新、用户目录零污染、无旧版本残留。Store 发现源 = `own/` + `linked/` 目录扫描 + builtin 注册集。**注册集实现形态 = 代码内 TS 模块**(类型化条目:name / description / body 字符串常量 + 适用模式 + 关联工具引用)——全仓 prompt 均为 TS 字符串常量、构建(tsup)不打包非 JS 资源,代码内注册集是与现状契合的唯一形态(零 fs 读取、零路径问题、天然随版本);**可与能力工具注册表(§4.2)合一为单一能力登记处**,条目同时携方法与工具、两个消费者(Store 发现 / runtime 工具装配)各取投影——能力作者登记一次。边界（与用户资产硬隔离）:**只读**、不可删、不被 v2 技能管家碰、**不进 `/skills` 管理器列表**（`listForManagement` 不含 builtin —— 机制内部件、非用户资产）、不占用户技能 top-N 预算（§3.4 分池）。用户定制走既有 copy-on-write:fork 到 `own/` 即成用户资产（进列表、占用户预算、随用户规则管理）,原件继续随版本演进;扫描时 own 同名遮蔽 builtin（与遮蔽 linked 同规则）。**builtin 零状态记录**:builtin **不进 `index.json`**(状态旁路属用户资产域)——无 `pinned` / `disabled`(用户管不了机制内部件,定制走 fork-to-own)、**适用模式由包内注册集声明**(每份方法自带,缺省**全模式**——「提炼技能的方法」在 main 与工作场景都必须可见:工作场景正是沉淀做法最高频的地方;若 builtin 走用户 mode 状态过滤,方法在 work 索引被滤掉、能力在工作场景失效)。**builtin 的读视图规则（单点定义,各 API 不另行发挥）**:索引产生**含**（独立分池,§3.4）、`loadText` **可读**（模型经 `load_skill` 加载方法全文）、`listAll` **不含**——`listAll` 服务 `/<name>` slash 补全,builtin 进入即把系统能力变相恢复成用户命令入口,直接违背"不暴露专门功能点";builtin 的唤醒只有两路:模型自主（索引命中）+ 用户自然语言（模型理解意图后 `load_skill`）——`listForManagement` **不含**（前述,非用户资产）。

**发现与存在性（双口径,按来源分治）**:**用户与外部技能**的存在性由 **Store 扫 `own/` + `linked/` 目录**决定（生态惯例 —— OpenClaw / Hermes / Claude 三家皆扫目录、标准技能目录放进来即被发现,契合「格式统一 / 外部接入」）;**builtin** 的存在性由**包内注册集**决定（随代码版本,非用户磁盘,见上节）,Store 在发现层合并两类来源、下游 API 按上节读视图规则取用。`index.json` **不决定存在、只存状态**:对扫到的每个技能配 `mode/pinned/disabled`;**首次扫到(无记录)即持久化登记**默认状态（`mode` 默认 `main`、可由用户 / 接入时改）+ `createdAt = now`（`createdAt` 必须持久化、之后不变,否则每次扫描都"刚创建"会破坏排序）。来源不配字段 —— `own`/`linked` 目录即来源。**`id = skillNameToId(frontmatter.name)`（锚定 SKILL.md 的 name、非目录名）**;扫描时建 `id → 实际目录路径` 映射供定位 —— **目录名仅物理位置**:Store 产生的（接入 / v2）目录名 = id,用户手写的目录名随意也不断（id 锚 frontmatter.name、经映射定位）。index 损坏不致命 —— 技能仍在、状态重置;**用户与外部技能**的存在性单一真相源是磁盘目录（builtin 的是包内注册集,两者各为其域的单一真相源、互不重叠）。

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

**`SkillStore` 接口与注入**(对标 `MemoryStore`):核心 API —— `listAll()`(全量、剔 `disabled`,`/<name>` 补全用)、`queryTopN(mode, n)`(top-N 过滤视图,索引产生用);**仅就用户与外部技能而言**二者**共享 `disabled`/mode 过滤、仅末步 limit 不同**(`listAll` ≡ `queryTopN(n=∞)`)—— 单一过滤点,防两视图分叉、为日后可见性 / 权限控制留扩展位。**builtin 不经此过滤点**(零状态、按注册集取,§二读视图规则):索引产生 = 用户池(`queryTopN`)+ builtin 池(注册集声明)**末端拼装**,`listAll` 不拼 —— 恒等式与"索引含 builtin、slash 不含"由此并存不悖。另有 `loadText(name)`(**按来源分支**,§4.1:own / linked 经库根 realpath 边界读全文 + 写 usage;builtin 注册集直取、不写 usage)、`admit(stagingDir)`、`setState(id, patch)`、`archive(id)`、`fork(id)`,以及**面向管理的全集读** `listForManagement()`(`/skills` 管理器浏览用:返回全集**含 `disabled`** + 每条 usage,记录类型 `ManagedSkillRecord` = `SkillRecord` + `usage` —— 与剔 `disabled` 的 `listAll`/`queryTopN` 区分,因管理器要显示 ⊘ 并就地重启用)。它返回全集、无过滤,故**不经** `listAll`/`queryTopN` 的过滤点,直接 `discoverWithState`(全集发现、本含 disabled)+ `rankWithUsage`(三者排序共用的唯一 usage 旁路读点,把 usage 一并带回 —— `listAll`/`queryTopN` 取其结果当 `SkillRecord[]`、usage 类型上收敛掉,无重复读)。**目录边界约束复用权限模块既有设施、不自建第二套**(原理见 §一边界判断#1):用 `PathGuard.resolve`(`path-guard.ts:28`)+ `PathGuard.isWithinWorkspace`(`path-guard.ts:65`,既有调用方 `trust-classifier.ts:48`)两边对称 realpath 后判前缀;**`workspace` 入参传 skill 库根 / staging、非项目工作区**(API 是通用前缀判断、语义可复用,不沿用 workspace 信任边界)。Store 作为**唯一磁盘访问点**,把路径进出恒收口到这同一对解析 / 边界函数,realpath 边界一处强制、无绕过点。

构造与注入:`SkillStore` 在 `create-agent-runtime.ts` 的 builtin 装配入口构造(仿 `memoryStore` —— 无状态、每次 runtime 装配 `new`、路径由 `getZhixingHome()` 定),注入 `builtinCtx`;`BuiltinToolContext`(`tools-builtin/factories.ts:30`)增 `skillStore?` 字段,`load_skill` 工厂检测缺失即 fail-fast(仿 `memory` 工具,`factories.test.ts:14`)。Control(cli)另 `new` 一个 Store —— 各自独立、共享同一磁盘目录。

**复用的 core 设施**(均在 core,Store 无需上层依赖):
- 原子写 `writeAtomic`(`core/transcript/serializer.ts:54`,含 Windows fallback)—— **不用** `providers/internal/io.ts:writeJsonAtomic`(在 providers 包,core 不可反向依赖)。
- per-id 锁(`Map<id,Promise>` 尾链 GC)+ 单 index 锁,范式仿 `core/workscene/registry.ts`。
- `getZhixingHome`(`core/paths.ts:19`)、`parseFrontmatter` / `stringifyFrontmatter`(`core/memory/frontmatter.ts:34`/:58 —— 只支持扁平 key:value + 简单数组、**不支持嵌套对象**;读写 `name` / `description` 等扁平字段够用、`linked` 原样保存不受影响)。
- **`name→id` 变换不用 `toSafePathSegment`** —— 它只替换 `:→--`、不处理空格 / 大小写(`core/paths.ts:47`,是 conversation/workscene 的通用件,对带空格的技能名会断链)。skill 用自己的 `skillNameToId`(§五.1)。

## 三、索引与系统提示词

### 3.1 注意力窗口生命周期(认知前提)

现有死线「`systemPrompt` 装配后 byte-equal、不重建」(`create-agent-runtime.ts` 的 `buildSystemPrompt` 唯一构造点 + `system-prompt.ts:buildSystemPrompt` 调用契约)的本意是:**在一次注意力窗口生命周期内,cache 优先、不动稳定前缀**。其完整形态:

> 稳定前缀在**单个注意力窗口生命周期内** byte-equal 不动;**跨窗口生命周期边界**(压缩 / 模式切换 / resume)才允许重建,且重建是「检查 → 变了才换、没变 byte-equal 不动」。

### 3.2 落地形态:窗口生命周期订阅者(已实现)

**索引段的唯一来源是生命周期订阅者 `makeSkillIndexLifecycle`(`create-agent-runtime.ts:164`),装配期不硬编码注入**:`onWindowOpen` 时比对 `skillStore.version(mode)` 与上次构建版本——**变了才** `queryTopN` 重渲染、经公共 `updateSystemPromptSegment("skill-index", next)` 贡献索引段;没变零 IO、零重算、不调接口(byte-equal 不动、cache 不破)。首窗 `onWindowOpen` 首次构建;技能集变更(创建 / 接入 / 状态写)在**下一个注意力窗口换代**时自然生效——窗口内 systemPrompt byte-equal 铁律不破。`mode` 来源:`createAgentRuntime` options 的 `skillMode`(`cli/runtime/session.ts` 按 `isWorkscene` 传)。

**builtin 池拼装挂同一订阅者**:重渲染时 = 用户池(`queryTopN`)+ builtin 池(注册集,§二)末端拼装(§3.4);builtin 随版本恒定、不影响版本比对的零开销路径。

### 3.3 v2 增量:运行中变更的即时性

重建机制已就位(§3.2),v2 技能管家运行中产生 / 淘汰技能**无需新机制**——管家写库使 `skillStore.version` 递增,下一次 `onWindowOpen` 自然重渲染。若 v2 需要"当前窗口内即见"(不等换代),才考虑追加窗口内重建点;在产品证明该需求前不做(窗口换代频度已足够)。

### 3.4 索引产生管线

扫 `own/` + `linked/` 目录得技能集、配 `index.json` 状态 → 剔 `disabled` + 按当前 mode 过滤 → **排序**:`pinned` 优先;其余按 **`(usage.lastHitAt ?? index.createdAt)` 降序**(新近度敏感 —— 最近用的最可能再用;**无 usage 的新技能 fallback 到 `createdAt`、视为"刚加入"靠前,获得曝光、防"没用过→不显示→用不到"冷启动**),`hitCount` 作 tiebreaker(同新近度则用得多的在前)→ 取 **top-N**(事前限定 N + 每条仅 `id`(= `skillNameToId` 结果)+ `description`,不含路径 —— 模型靠 `id` 调 `load_skill`,无需路径)→ 渲染为索引段。总量有确定上界、恒在预算内(无降级兜底;真超了是 N / 单条上限设错的 bug)。

**builtin 分池**:builtin 来源区条目（§二）**不参与**用户技能 top-N 竞争、**不走用户 mode 状态过滤**（按注册集声明的适用模式取,缺省全模式,§二）,占独立固定小额度(条数与单条上限独立设定,同"事前限定、恒在预算内"纪律),在索引段内与用户技能并列渲染——系统能力的可见性不随用户技能增多被挤出,用户技能的曝光额度也不被系统能力占用。

**索引段文本格式**(由 `renderSkillIndex` 生成,仿 `buildToolUsage`):

```
## Available Skills
To use a skill, call the `load_skill` tool with the id shown below. Descriptions are brief — load one for full instructions.
- **<id>**: <description>
- ★ **<id>**: <description>          (★ = pinned)
```

无可见技能 → 返 `null`(段跳过、不破 byte-equal)。

## 四、加载与能力工具暴露

### 4.1 加载(`load_skill` 工具)

`load_skill` = 固定的主 agent `ToolDefinition`(`core/types/tools.ts`),注册进 `BUILTIN_TOOL_FACTORIES`(`create-agent-runtime.ts`,按 `profile.enabledTools` 实例化)、列入 main 与 work profile 的 `enabledTools`。**技能再增删,工具集恒只此一个加载工具** → 契合「工具集装配期 freeze」,索引变化不动工具集。

- **安全属性(与 `memory`/`schedule` 同属 `app-state` 边界声明者 —— "写 `~/.zhixing` 下本地应用状态、无外部副作用"的内部工具)**:**关键 —— 在 `ToolDefinition` 上声明 `boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }]`**(对标 `memory.ts:88` / `schedule.ts:143`,`access: "write"` 因写 `usage`)。装配期 `BoundaryRegistry.fromTools(baseTools)` snapshot 此声明(`create-agent-runtime.ts:553`),运行期 `BoundaryImpactClassifier` 读 registry、经 `BOUNDARY_WRITE_IMPACT["app-state"] = "internal"` 判 `internal`(`classifier.ts:239` 映射 + `:242-256` 分类),`OperationClassifierMiddleware` 对 `observe`/`internal` 不改决策、放行(`security-pipeline.ts:130` 仅 `external`/`critical` 才升级为确认)。`app-state` 边界已是类型预期的一等设施 —— `BoundaryType` 注释与 `BOUNDARY_WRITE_IMPACT` 注释均已显式纳入 "skill 数据"(`types.ts:66-67`、`classifier.ts:237-239`),非临时挂靠。**否则**:`load_skill` 无专属 context classifier、若**不声明** `boundaries` → `BoundaryImpactClassifier` 对空 crossings fail-to-confirm 判 `critical`(`classifier.ts:249`)→ 每次加载弹确认。即"是否弹确认"由 `OperationClass` 的影响分类(`app-state` 写 → `internal`)决定,与 `needsPermission` 字段正交。其余:`needsPermission: false`、`isReadOnly: false`(写 `usage`)、`isParallelSafe: true`(per-id 锁护 usage 写)。
- **不设 `maxResultChars`**(`ToolDefinition.maxResultChars`,`core/types/tools.ts`;不设 = 不限制;否则全文被 `applyMaxResultChars` 截断,`loop/tool-executor.ts:applyMaxResultChars`)。技能全文须完整入上下文。
- **统一用 `id`**:索引显示、`/<name>`、`load_skill` 参数、目录名**全是 `id = skillNameToId(name)`**(§五.1)—— 单一变换、无断链;原始 `name` 仅供显示(`SKILL.md` frontmatter + `CommandDef.aliases`)。`skillNameToId` 幂等,Store 对入参再过一次也安全。
- 流程:模型扫索引命中 → `load_skill(id)` → **Store 按来源分支**:**builtin** → 包内注册集直取内容(资源由注册集枚举、不走目录映射与库根边界——包资源不在用户库根内,其边界 = 只读注册集列出的资源、无路径遍历面;**不写 usage**,零状态记录的延伸:度量属用户域且 builtin 无度量消费者);**own / linked** → 按 `id` 经扫描映射定位到实际目录的 `SKILL.md`（目录名不必 = id,见 §二「发现与存在性」）→ **读文件前先做边界检查**:复用 `PathGuard.resolve` + `PathGuard.isWithinWorkspace`(`path-guard.ts:28`/`:65`,`workspace` 参传 skill 库根、非项目 workspace)把目标路径与库根两边对称 realpath、越界即拒(resolve-before-decide、单一解析点范式见 §一边界判断#1) → 读全文 → 作 `tool_result` 进上下文(随注意力窗口自然管理,skill 不单独管其生命周期)→ 写 `usage/<id>.json`(不标 dirty)。**这道库根边界是 `load_skill` 运行期文件读的唯一边界**:`load_skill` 入参只有 `id`、不携任何路径参数,而权限管线的路径规则只作用于声明了标准路径参数的工具调用(`PathResolveMiddleware.PATH_ARG_KEYS` = `path`/`file_path`/`target`/`destination`,`path-resolve.ts:23`;middleware 把它们 realpath 后回写 `resolvedAccess.paths`,供 `PolicyEngine` 路径规则与 `bypassImmune` 禁区规则匹配),`id` 不在其中 → `load_skill` 不落入任何路径规则,运行期边界完全由 Store 这一处 realpath 收口承担。**度量唯一采集门**。

### 4.2 能力工具注册表（内化能力的工具暴露,机制级承重件）

每个内化能力（builtin 来源区方法的配套落地工具:「提炼技能」→ `save_skill`(skill-authoring.md §三)、「接入技能」→ `admit_skill`(§六)）的工具**经注册表登记**——登记项 = 能力 → 工具 + schema + 不变量钩子。注册表**只管工具**（方法 / 索引 / 加载全走上述 skill 管线,不归它管——否则就长出与 skill 平行的第二套渐进披露层,正是机制自举要消灭的形态）。

**暴露形态两段式（注册表恒定,暴露端可演化）**:

- **v1（当前）**:登记的工具直接进 `tools[]`（与 `load_skill` 同走 `BUILTIN_TOOL_FACTORIES` 装配）。红线:**每能力 ≤ 1 工具、优先零工具**——方法能指导模型用既有工具完成的,不开新工具;只有不变量需要焊接时才开。
- **切换条件（显式参数,非死值）**:内化能力数 > `CAPABILITY_GATEWAY_THRESHOLD`（初始 3）**或**登记工具的 schema 序列化字节总量超 `CAPABILITY_TOOLS_BYTE_BUDGET`——测量口径 = 各工具 `ToolSpec` JSON 序列化字节求和,在装配期可测、有断言位。
- **v2 形态（达阈切换,接口今日不设障碍）**:`tools[]` 收敛为单一常驻执行网关(`invoke_capability(name, args)`),各能力工具 schema 不再常驻——随方法文档经 `load_skill` 按需进入对话流,模型照文档构造调用,网关按注册表 schema **硬校验**后执行。`tools[]` 从此恒定:窗口内 byte-equal 永不破、内化任意多能力不膨胀、校验不因 schema 离开 `tools[]` 而变软。

**预留的是注册表数据结构,不是网关本身**——v1 不为一个工具套间接层;切换那天改的是暴露端,已登记能力零返工。

## 五、手动唤醒与控制面

### 5.1 `/<name>` 动态指令 —— 走 `execution: "agent"`,无需 handler

`SkillCommandSource implements DynamicCommandSource`(`core/typeahead/types.ts:345`):`list()` 读 **`SkillStore.listAll()`**(`index` 只有状态、无 `name`/`description`;`listAll` 从 `SKILL.md` 解析出 `name`+`description`)→ 每个技能映射为 `CommandDef`(`category:"plugin"`、`execution:"agent"`)。在 `repl.ts` 的 `DefaultCommandRegistry` 上 `registerDynamicSource` 注册一次;技能集变更触发 `registry.refresh()` + `onChange` 重建补全候选。

`execution:"agent"`(`types.ts:101`)语义 = accept 后整条作 user message 发给 agent loop;**`execution=agent` 不调 handler**(`command-dispatcher.ts:116`)→ **动态技能指令无需注册任何 handler**,`SkillCommandSource` 只产 `CommandDef` 即可。手动唤醒由此与模型自动命中**统一走「agent loop 调 `load_skill`」一条路**,无旁路。**`skillNameToId`（全局唯一的 `name→id` 变换 —— 目录名 / 索引显示 / `/<name>` / `load_skill` 查找**全部共用同一函数**,这是不断链的关键）**:`name.toLowerCase()` → 空白 `→ -` → **仅移除文件名非法字符** `<>:"/\|?*` + 控制符 → 合并连续 `-`、去首尾 `-`。**保留 Unicode**（"代码审查" → "代码审查",中文名照常可用;**不可**像普通 sanitize 那样移除非 ASCII,否则中文名变空）。理由:dispatch 解析时按空白切第一个 token 作命令名(`parseCommandDraft`,`command-dispatcher.ts:172`),含空格的原始名必匹配失败;且目录名 / slash 名 / `load_skill` 查找若用不同变换则断链。`CommandDef.name = skillNameToId(name)`、`id = "skill:<同值>"`、`aliases` 保留原名供显示。技能 `id` 与某个非技能命令重名时,`SkillCommandSource.list()` 经 `findExisting`(= `registry.findByName`)探测命中、跳过该技能不注册为 slash 命令(核心命令优先)—— 技能命令 `id` 命名空间化为 `skill:<id>`,与 builtin 的 `<name>:builtin` 不撞 registry id,故 registry 自身的 id 冲突跳过(`registry.ts` `applySourceCommands`)对技能并不触发,跳过由 source 自己承担。被跳过的技能仍可被 agent 经索引 / `load_skill` 加载,或在管理器里改名取得 slash 名。

### 5.2 控制面(cli)—— 技能管理器(alt-screen)

技能管理是「看全库 + 多动作状态调整 + 编正文」的持续策展,本质是**经营一组带状态与正文的资源**。按产品惯例 —— 调用进命令面板、管理进独立视图(`/config` 同理)—— 它属于一个**独立全屏管理器**,不属对话框下转瞬即逝的 typeahead 下拉;`/<name>` 唤醒(§5.1)是 pick-and-fire、留在 typeahead,管理迁出。

**为什么不是 typeahead 二级面板**:候选行的就地操作是**写死的三种**(`delete` / `rename` / `create`,`InlineActionSupport`,`types.ts:172`),且下拉里用户在**打字筛选**、每个操作只能占稀缺的 Ctrl/Alt 组合键 —— 撑不起 `pin` / `禁用` / `改 mode` / `归档` 多动作,更放不下正文编辑。强行扩通用框架 = 用技能域语义污染通用面板,是债务。故管理走 alt-screen,typeahead 框架保持只做唤醒与通用列表操作。

**`/skills` 打开技能管理器** —— 一个 `/config`·`/mcp` 那样的 alt-screen,建在中性 `tui/` 共享屏原语上(`tui/render.ts` / `tui/input.ts` / `tui/key-event.ts` + `screen/screen-controller.ts`);开屏走 `/config` 同款 REPL 层接线(让出 stdin、进 / 退 alternate screen buffer 由终端原子保存 / 恢复主对话历史)。管理器只管**结构性策展**;内容创作不在屏内(走对话流能力内化,skill-authoring.md)。

管理器内含:
- **浏览** —— 列**全部**技能(own + linked,**含 disabled** —— 否则无法显示 ⊘ 并就地重启用)+ 状态徽标(`mode` / `★pinned` / `⊘disabled` / `own`·`linked` 来源 / usage),↑↓ 导航。数据**不用 `listAll()`**(它剔 `disabled`、服务 `/<name>` 补全)——用 §二 的**面向管理的全集读**(含 `disabled` + usage)+ 排序投影。管理是策展(看 / 调 / 编),**不在此唤醒技能** —— 唤醒走 `/<name>`(§5.1,就在对话里、更顺)。
- **状态操作**(不打字筛选 → 裸键直达):`pin` / `禁用` / `改 mode` = 结构性写 `SkillStore.setState`;`归档` = `SkillStore.archive`(物理移 `archived/`、可逆、不物理删 —— 扫 `own`/`linked` 不再见)。写经注入 writer 落 Store、即时重读重画。
- **创建 / 打磨正文** —— **不在管理器内**:走对话流能力内化(详见 skill-authoring.md)——用户对话里说一句,模型起草、来回改、经 `save_skill`(upsert)落盘;管理器只管结构性状态(策展),内容创作归对话。
- **外部接入不在管理器内** —— 走对话流内化能力 `admit_skill`(§六);管理器只做结构性策展,不开任何接入入口(与代码现状一致:manager 仅 pin / 禁用 / 改 mode / 归档)。

落盘后立即可 `/<name>` 唤醒,下个会话 / 模式切换由索引产生管线自然纳入(§三,运行中不强制即时重建索引)。

## 六、接入与审查(Admission)

接入源 → 落候选暂存目录(`Store.prepareStaging` 建 `<root>/.staging/<候选>/`)→ Admission 审查 → 过审则 `Store.admit` copy 到 `linked/<id>/` 并清暂存,未过审清暂存。审查管线对所有源一致;**接入源 v1 = 本地路径**,URL / 仓库由 `acquireToStaging` 的 `SkillImportSource`(`admission.ts`,switch kind)按 kind 增量(各带 SSRF / git 依赖、获取器后续接入;与 `types.ts:SkillSource`「own / linked 进库分区」不是一回事)。Admission:
1. **静态内容扫描 + 目录边界**,两层不同机制,不混为一谈:
   - **内容扫描(自建,非复用内置规则)**:`scanSkillContent`(`content-scan.ts`)对暂存文本做高置信模式审查(prompt 注入 / 信息外泄 / 窃凭证),命中记一条威胁信号,类别对齐 `ThreatCategory` 的 `prompt_injection` / `data_exfiltration`。`BUILTIN_RULES` 全是 path / command / env_var / interpreter 匹配、**无文本内容扫描规则**,故这层自建。它是**信号收集、不单独终判**:正则锚定恶意结构(动词 + 目标)、宁可多给信号,语义复核交 AI、避免静态误判挡死正常技能。
   - **realpath 目录边界**:由 `Store.admit` 的 copy 一处收口 —— `copyTreeContent` 逐文件原子写并**拒符号链接**(防越界、保内容副本)、`assertWithinRoot` 校验目标在库根内(复用 `PathGuard`)。`acquireToStaging` 用 `fs.cp` 默认保留 symlink、不 deref,把软链留给 admit 拒绝、不在获取期绕过。

   **接入期扫描只是一次性内容闸门、不替代运行期边界**:文件 copy 进 `linked/` 后,运行期 `load_skill` 读 `linked/` 文件的边界由 Store 自身的 realpath 库根边界承担(见 §四加载流程)——接入期扫过一遍不等于运行期可放掉归属判定,避免生效面落后于声明面。
2. **AI 语义研判**:`reviewAdmission`(`admission.ts`)仿编排层 `AISecuritySteward.review`(`ai-steward.ts`)的「一次性独立裁判」范式 —— 注入窄 LLM 接口(绑 `main` 档 `callText`)、拼"安全裁判" system 角色 + 技能内容 + 静态扫描信号 → 单发 → 解析 `safe / needs-confirm / escalate` 三态。**fail-safe**:LLM 不可用 / 输出无法解析 → `needs-confirm`,绝不误放。它研判的是**接入期技能产物内容**(prompt 注入 / 信息外泄),与运行期 steward 研判的 external 操作(`StewardOperation`,`secure-executor.consultSteward` 触发)输入形态不同,故是**同范式的姊妹应用**、非直接调 `consultSteward`;运行期 `load_skill` 读文件边界仍由 Store realpath 承担(§四)。`assessSkill` 把扫描 + 研判组合成一次评估。
3. **分级裁决与接入(`admit_skill` 工具,对话流能力内化 —— 第二个内化能力,需求见 [capability-internalization.md](../drafts/capability-internalization.md)「接入技能」组)**:无专门入口,用户自然语言触发("把 ~/xx 这个技能装进来"),模型经索引命中 builtin 方法「接入技能」后调本工具。研判降级一律落 `needs-confirm`、绝不静默放行(不变)。

   **`admit_skill` 契约(二段协议,artifact 绑定)**——输入 `{ path?, mode?, admissionToken? }`:首调必须有 `path`(接入源,v1 本地路径);确认重调只需 `admissionToken`(path 忽略——内容已在 staging)。`mode` 缺省按当前场景。

   **安全自描述(命令内化成工具的新事实)**:旧 `/skill-add` 的路径读取由用户敲命令授权;工具化后授权方是模型,路径必须进安全管线。故 schema 用**顶层 `path`**(而非嵌套 `{source:{path}}`)——`PathResolveMiddleware` 只解析顶层 `PATH_ARG_KEYS`(`path-resolve.ts:23` = path/file_path/target/destination),嵌套结构不被 realpath、禁区规则与路径策略看不到接入源(读 credentials 等可绕过)。声明 `filesystem/read`(读源)+ `app-state/write`(写库)双边界 + `permissionArgumentKey: "path"`(同 `write.ts:42`)。core 的 `SkillImportSource` 联合保留(`acquireToStaging` 仍来源无关),工具层把 `path` 映射为 `{kind:"local-path", path}`;**未来 URL / Git 扩 kind 时给对应顶层参数 + 对应来源边界(network/egress 等),绝不用一个嵌套 source 抹平不同来源的安全边界**。

   - **首调**(无 token):`prepareStaging` → `acquireToStaging` → 读暂存 SKILL.md → `assessSkill`(静态扫描 + 独立裁判)→ 按三态:
     - `safe` → `Store.admit`(落 linked)→ 清暂存 → 返回接入成功 + id + 唤起提示 —— safe 自动接入是既有定稿;
     - `escalate` → `discardStaging` → 返回拒绝 + 裁判 reason,明示不可商量 —— **escalate 不发 token,确认重调结构上无从指向它**(沿"--force 也不越"语义,且连绕行参数都不存在);
     - `needs-confirm` → **保留 staging**,生成 `admissionToken`(随机 id),登记 `{stagingDir, digest, verdict, threats, mode, expiresAt}` 于**工具实例内存**,返回威胁报告(裁判 reason + 威胁清单)+ token,**不落库**。
   - **确认重调**(带 token,在模型原样转述报告、用户明确同意之后):校验登记存在且未过期 → **重算 staging digest 与登记一致**(防暂存目录被外部改写——用户确认的必须是审查过的那一份,TOCTOU 窗口焊死)→ `Store.admit`(用登记的 mode)→ 清登记。任何校验失败 → `discardStaging` + 清登记 + 返回"已失效,需重新审查"。
   - **digest 口径**:暂存目录树聚合 —— 相对路径升序,逐文件 sha256,再对 `路径 + 文件哈希` 序列整体 sha256;装配期可测、测试可断言。
   - **TTL 与清扫(两层:内存登记 + 磁盘孤儿)**:`expiresAt = 登记时刻 + ADMISSION_TOKEN_TTL_MS`(显式参数,初始 10 分钟)。① **内存登记**:重调遇过期惰性清;首调顺扫登记表清全部过期项及其 staging。② **磁盘孤儿(跨进程)**:token 不持久化,needs-confirm 后进程退出 / reload 会留下无主 `.staging/candidate*`、新实例无登记表无从识别——故首调前调 `Store.sweepStaleStaging(ADMISSION_TOKEN_TTL_MS)` 按目录 mtime 删超期 candidate(归 Store —— 唯一磁盘访问点;mtime 此处可用:刚建的 in-flight 候选在 TTL 窗内不被扫,误删早期 pending 的后果是"重新审查"= 安全方向)。token 仍不持久化:跨进程确认失败 → 重新审查(安全方向的失败)。无后台定时器,残留窗口 ≤ 下次使用同会话或下次任意首调。
   - **作用域**:登记表在工具实例闭包(per-runtime)——确认重调须发生在同一会话;跨会话 token 自然失效 → 重新审查(安全方向的失败)。
   - **暂存清理责任表**(`Store.admit` 不自清,清理恒归工具——store.ts:336 既有契约):首调 safe 入库后清;escalate 清;needs-confirm **保留**;首调中途异常清;确认重调成功(admit 后)清 + 清登记;重调任何校验失败清 + 清登记。六条路径全覆盖,无残留窗口(过期项由 TTL 清扫兜底)。
   - **安全归属**:声明 `filesystem/read` + `app-state/write` 双边界(后者 internal 放行)+ `permissionArgumentKey:"path"`——路径经管线 realpath、禁区规则生效(见上「安全自描述」);用户复核**完全由二段协议承载**(token + digest 绑定内容本身),不叠通用确认面板:安全管线确认在工具执行前、只见入参,威胁报告产生于执行中,面板接不到(时序错位);且 safe 自动接入为既有定稿,外层面板徒增三重交互。与 `save_skill` 不声明边界的不对称有可陈述理由:save 的内容用户看着起草(面板确认行为即可),admit 的内容来自外部,确认必须绑定内容本身,面板给不了这个保证。
   - **裁判注入(红线:运动员 / 裁判分离)**:`AdmissionLlm` 经装配期注入(`BuiltinToolContext` 增 `admissionLlm`,绑 main 档单发通道——roles 于装配早期(create-agent-runtime.ts:549)就绪,把单发通道构造前移至 builtinCtx 之前即可**直接注入、零 lazy 间接层**;工厂缺失 fail-fast)——独立调用、不带对话上下文:外部技能可能含 prompt 注入,主模型读过其内容后自身可能被操纵,裁判必须隔离。`reviewAdmission` 的 fail-safe(LLM 不可用 / 解析失败 → needs-confirm)原样保留。

   **builtin 方法「接入技能」内容要求**(第二份内置方法,登记处纯增量;全模式可见):① 何时用(用户给出外部技能来源、表达接入意图);② **原样引用**裁判 reason 与威胁清单,不得改写弱化;③ needs-confirm 时等用户明确说"装"再带 token 重调,意图不明就问;④ escalate 如实告知"已挡死、不可绕过",不替用户想办法绕;⑤ 接入成功后如实交代(id / `/<id>` 唤起 / 落在接入区、可在 `/skills` 管理)。

放行 → `Store.admit` 把暂存内文件**逐个 `writeAtomic` copy** 到 `linked/<id>/`(**不靠目录 rename** —— Windows 跨卷不原子;全部成功后由 `finally` 调 `discardStaging` 清暂存),即被扫到 = 发现 = 接入来源;`index` 补该 id 状态(`mode` 接入时选定、默认 `main`)。copy 经 Store 库根 realpath 一处收口、暂存内 symlink 即被拒。Store 这步是宿主侧内部写(同 `MemoryStore` 在 `~/.zhixing` 下落盘),不经安全管线(`pipeline.evaluate` 只拦 agent loop 的 AI 工具调用),故 `linked/` 虽落在 `.zhixing/` 段内也**不触发**写确认规则 `bi-zhixing-config-write`(只对 AI 工具调用写 `.zhixing/` 生效)。

## 七、模式分发

Index 产生时按 `index.mode` 过滤:标 `main` 进 main runtime 索引、标 `work` 进 work runtime 索引。模式切换 = 换 runtime(§3.2,已核实接入)= 天然换对应 mode 索引。全集始终可 `/<name>` 手动唤醒 —— 索引只是「按 mode + top-N 的视图」。现阶段 `work` 全进所有工作场景;架构预留「未来 work 细化绑定具体工作场景」,现阶段不做。

## 八、归属与对接点(汇总)

| 包 | 内容 | 关键对接 |
|---|---|---|
| `core/src/skills/` | Store(含 builtin 来源区发现)、索引产生(含 builtin 分池)、Admission(内容扫描 + AI 研判 + 暂存管理)、`load_skill` 执行、**`SkillSavePipeline`(不变量焊点)+ `save_skill` 工具包装 + `admit_skill` 二段协议工具(§六)+ 能力工具注册表**(§4.2,skill-authoring §三) | `core/paths.ts`、`transcript/serializer.ts:54`、`memory/frontmatter.ts:34`、`workscene/registry.ts`(锁范式);**权限**(机制见 §四 安全属性 / §一边界判断#1)—— `load_skill` 声明 `app-state` 边界(同 `memory.ts:88`/`schedule.ts:143`)、`save_skill` 按副作用工具走确认管线(**不**声明 app-state 放行,skill-authoring.md §三)、`BoundaryRegistry.fromTools`(`boundary-registry.ts:56`)装配于 `create-agent-runtime.ts:553`、`BoundaryImpactClassifier`+`BOUNDARY_WRITE_IMPACT`(`classifier.ts:239`)、`OperationClassifierMiddleware`(`security-pipeline.ts:130`)、`PathGuard.isWithinWorkspace`(`path-guard.ts:65`);**Admission** —— `content-scan.ts`(`scanSkillContent`)、`admission.ts`(`reviewAdmission`/`assessSkill`/`acquireToStaging`/`SkillImportSource`)、`Store.prepareStaging`/`discardStaging`/`admit`/`sweepStaleStaging`(孤儿暂存按 mtime 清) |
| `orchestrator` | Store 构造 + `builtinCtx` 注入;`load_skill` / `save_skill` / `admit_skill` 注册(经能力工具注册表;admit 的 `admissionLlm` 绑 main 档单发、装配期直接注入(单发通道构造前移,工厂缺失 fail-fast));skill 索引段(含 builtin 条目)接入 system prompt | `create-agent-runtime.ts`(`memoryStore`/`builtinCtx` 注入、`BUILTIN_TOOL_FACTORIES` 实例化、`buildSystemPrompt` 构造点)、`system-prompt.ts`(`SystemPromptSegment`/`renderSegment`/`MAIN_AGENT_SEGMENTS`) |
| `cli` | `SkillCommandSource`(唤醒)、`/skills` 技能管理器(alt-screen,仅结构性策展)、**创建 / 打磨与接入均无 cli 专属件**(对话流能力内化:创建见 skill-authoring.md,接入见 §六) | `repl.ts`(`DefaultCommandRegistry`/`registerDynamicSource`)、`DynamicCommandSource`(`core/typeahead/types.ts:345`);管理器复用中性 `tui/` 共享 alt-screen 原语(`tui/render.ts`、`tui/input.ts`、`tui/key-event.ts`、`screen/screen-controller.ts`),浏览 = 面向管理的全集读(含 `disabled` + usage,§二;**非 `listAll`** —— 后者剔 disabled、补全用;**不含 builtin**)、状态操作 = `setState`/`archive`;原 `admission-command.ts`(单键 / `--force` 裁决交互)随接入内化退役 |

「注意力窗口生命周期边界」即 runtime 生命周期钩子(`AgentRuntimeLifecycle.onWindowOpen`),属 runtime 层、非 skill 模块;索引段经 `updateSystemPromptSegment` 公共接口贡献(已实现,§3.2),无需任何 holder 改造。

## 九、v1 → v2 跨版插座

第二版(技能管家)完整架构见 [skill-evolution.md](./skill-evolution.md);本节只列 v1 侧预留点 —— 第二版往这些点插入、不推倒重来:
- **度量信号** —— `usage/` 旁路,v1 已用于 top-N 排序;v2 加「淘汰判断」第二消费者。
- **来源标记** —— v1 来源全由目录定(`own` 本地产生 / `linked` 外部接入)、不设字段;v2 在 `own/` 内加 `stewardCreated` 布尔标记激活来源边界(技能管家只动自产)。插座 = `index.json` 是 per-id 可扩展状态对象,v2 加字段即纯增量。
- **`load_skill`(度量采集点)** —— v1 建好,v2 直接接。**`systemPrompt` 可重建插座** —— ✅ 已落地（[agent-runtime-lifecycle.md](./agent-runtime-lifecycle.md)）:实际落地为双层 holder（非预想的一行）+ onWindowOpen 注册式订阅 + `SkillStore.version(mode)` 门控的边界重建检查（§3.2/§3.3）。
- **写隔离** —— v1 `linked` 物理只读;v2 决断 `own` 是否再物理细分(§二)。

## 十、测试拓扑

- **Store**:扫目录发现技能、无 index 记录用默认状态(来源由 own/linked 目录定、不存字段);解析坏 `SKILL.md` 不污染全局(隔离该技能);目录边界约束拒绝 symlink 逃逸——库根内指向库根外的软链,以库根作 `workspace` 经 `PathGuard.isWithinWorkspace`(`path-guard.ts:65`)判 false 被拒(对标 `path-guard.test.ts:84`「库内 symlink 指向库外 → false」;复用权限设施、不自建 `path.startsWith`,原理见 §一边界判断#1);fork-on-edit copy 后扫描 own 遮蔽 linked;两写通道(度量写不标 dirty)。
- **builtin 边界(负向断言为主——失守即把系统能力重新暴露成用户入口,§二读视图规则逐条钉死)**:`queryTopN` 产出 + 索引段**含** builtin 条目(按注册集适用模式,不走用户 mode 状态过滤);**`listAll` 不含** builtin(slash 补全零暴露);**`listForManagement` 不含** builtin(管理列表零暴露);**`SkillCommandSource.list()` 不产** builtin 的 slash `CommandDef`;`loadText(builtin-id)` 可读全文且**不写 usage**(usage 目录断言无该 id 文件);own 同名技能**遮蔽** builtin(fork-to-own 生效、索引出 own 版);builtin 分池**不挤占**用户 top-N(用户技能满 N 时全员仍在、builtin 另列);builtin **不进 `index.json`**(登记后状态表无其记录);`SkillSavePipeline` 对 builtin id 落 `own/`(非改写注册集)。
- **Index**:模式过滤 + pinned 优先 + top-N(超 N 取够、每条限尺寸);序列化 byte-equal 可断言;用户池 + builtin 池末端拼装(两池预算互不挪用)。
- **Loader**:`load_skill` 未设 `maxResultChars` → 长全文不截;声明 `app-state` 边界 → `BOUNDARY_WRITE_IMPACT['app-state']=internal`(`classifier.ts:239`)经 `BoundaryImpactClassifier` 判 `internal` → `OperationClassifierMiddleware` 不升级为确认(`security-pipeline.ts:130` 仅 `external`/`critical` 升级);命中写 usage;越界路径被 `PathGuard.isWithinWorkspace`(`path-guard.ts:65`)拒。
- **Admission**:分级裁决三态对标安全助理三态 `StewardVerdict`(`ai-steward.ts:34` `safe`/`needs-confirm`/`escalate`)——确凿恶意挡死、模糊可疑交用户、干净放行;**fail-safe 默认须有断言**:研判 LLM 不可用 / 超时 / 输出无 JSON / 解析失败 / 裁决值非法这五类「无法研判」一律回退 `needs-confirm`、绝不静默放行(对标 `ai-steward.ts:failSafe`,触发点 `:77`/`:100`/`:109`/`:117`),用例须断言此回退默认而非仅断三态 happy-path(「信息不足」是 LLM 依 system prompt 给出的常规保守 `needs-confirm`,非 `failSafe` 路径,二者分开断言)。这是**接入期内容审查**的裁决,与运行期权限管线的安全助理研判(事件 `security:steward_review`,仅研判灰色 external 操作)三态同构但生效面不同——接入期审查技能文本,不替代运行期边界;`load_skill` 读文件的运行期边界由 Store 自身的 realpath 库根边界收口(见 §四)。未过审 → 回滚清理候选暂存目录。
- **`admit_skill` 二段协议**:首调三态(safe 入库且清暂存 / escalate 拒且清、**断言无 token 返回** / needs-confirm 留暂存 + 返回 token 与报告);确认重调(token 命中 + digest 一致 → admit 落 linked 用登记 mode、清登记清暂存);**TOCTOU 防御**(重调前改写暂存内容 → digest 不一致 → 拒、清暂存);TTL 过期(重调遇过期 → 拒;首调顺扫清过期项);**跨进程孤儿清理**(内存登记丢失但 staging 目录超 TTL → `sweepStaleStaging` 删除;未超 TTL 的不误删);跨实例失效(新工具实例对旧 token 返回重新审查);**schema 安全自描述**(顶层 `path` 进 `resolvedAccess.paths`、声明双边界 + permissionArgumentKey,断言路径被管线可见);暂存 SKILL.md 缺 name → 失败且清;清理责任表六路径逐条断言无残留。
- **Control / 指令**:`SkillCommandSource.list()` 产 `execution:"agent"` 的 `CommandDef`;`refresh()` 后补全更新;`/<name>` 不需 handler 即可分派为 agent message。`/skills` 技能管理器走 alt-screen(断言进 / 退 alternate screen buffer、不碰主对话历史);浏览渲染 = 面向管理的全集读(含 `disabled` + usage,**非 `listAll`**)投影,断言 disabled 技能可见可重启用;状态操作裸键 → `setState`(pin / 禁用 / 改 mode)/ `archive`(归档)落 Store、即时重读重画。
- 纯逻辑注入 mock(fs / LLM / registry),无真网真 LLM。
