# 工作场景管理能力统一、目录管理与智能创建架构

## 需求区

### 工作场景管理能力统一、目录管理与智能创建

- **触发**：当前工作场景管理存在模型工具与 `/work` 方法组两套能力面；创建后不能绑定或修改工作目录，`/work` 新建只能固定输入场景名。
- **需求**：
  - 统一工作场景管理能力底座，明确原子能力边界，避免模型工具与 `/work` 各自维护一套管理语义。
  - 管理权限按模式分层：主模式拥有全局工作场景管理权限，工作场景模式仅管理当前场景属性。
  - 补齐工作目录管理能力：创建时可选目录；创建后可为无目录场景绑定目录；已有目录可更换；删除场景不动用户目录。
  - 按“最优架构、不留债务”原则重新审视现有封装：不预设保留或推翻，清理不服务于统一能力底座与入口语义一致的冗余 / 无用能力。
  - 重做 `/work` 新建体验：不再用固定表单硬接 `create(name)`；Ctrl+N 应启动一次性、非持久化、职责单一的工作场景创建智能体，使用 Main 档位模型，只暴露创建所需上下文和管理工具，由它理解用户自然表达、必要时澄清，并自主调用工具完成创建，而不是做固定字段解析或硬匹配。
- **下一步**：围绕原子能力、模型工具封装、`/work` 智能创建流程、权限确认与目录校验启动架构设计。

## 用户需求起点

```text
1. **背景**

工作场景模块用于把一类持续性工作从主模式中分离出来：它有独立会话、独立记忆、独立运行态，并可绑定用户项目目录，让该场景成为一个可长期复用的工作上下文。
并且使用 power档位模型，用于更好的工作；

2. **与工作目录相关的需求场景**

- **系统目录**：每个工作场景都需要内部系统目录，用来保存场景元数据、场景记忆、场景会话等系统数据。
- **工作场景工作目录**：工作场景可关联一个用户项目目录，作为该场景中文件读写、搜索、命令执行的根目录。
- **主模式工作目录**：主模式也有自己的默认工作目录，用于主模式下的文件操作；它与具体工作场景的工作目录是不同概念。

3. **当前需求缺口**

已有能力：

- 主模式中，模型可调用 `workscene_change_approve` 创建工作场景；`add` 参数支持 `name` 和可选 `workdir`。因此用户可以在主模式用自然语言表达“创建工作场景 X，工作目录是 Y”，经确认后创建带目录场景。
- `workscene_change_approve` 实际是主模式模型用的场景注册表变更工具，支持 `add/remove/rename`：`add` 支持 `name/workdir`（`workdir` 仅 trim，未做绝对路径校验），`rename` 只支持改 `name`，`remove` 只按 `sceneId` 删除场景系统数据且不动用户 `workdir`，有活跃场景会话时拒绝删除；没有修改 `workdir` 的动作或字段。
- 核心 `workscene` 方法组有 `list/create/rename/delete/enter/exit`：`create` 支持 `name/workdir`（`workdir` 提供时必须是非空绝对路径），`rename` 只改名，`delete` 只删场景系统数据且有活跃场景会话时拒绝，`enter/exit` 只负责进出场景，不提供修改 `workdir` 的方法。
- CLI 终端有 `/work` 指令：用于列出、选择、进入工作场景；面板支持 Ctrl+N 新建、Ctrl+R 改名、Ctrl+D 删除。`/work` 只能在主模式使用；在工作场景内使用会提示先 `/exit`。Ctrl+N 只填写场景名，不支持指定 `workdir`；确认回车后不是让大模型调工具，而是 CLI 固定流程直接调用 `workscene.create(name)` 创建无目录场景。
- 工作场景管理相关工具中，工作场景 runtime 只暴露 `workmode_exit`，不暴露创建 / 修改 / 绑定工作目录的管理工具。

需求缺口：

- 创建后的工作场景缺少“设置或变更工作目录”的模块能力：无工作目录的场景不能补绑；已有工作目录的场景不能更换。
- 当前“指定目录”的唯一模型工具路径发生在主模式创建场景时；创建后没有对应能力。
- 这不是限定必须改 `/work`，而是工作场景模块缺少创建后的 `workdir` 管理能力，具体入口可以后续再设计。

能力面概况：

- 模型工具组：主模式模型使用 `workmode_enter`、`workscene_change_approve`、`workscene_memory_query`；工作场景管理相关工具中，工作场景模型只使用 `workmode_exit`。其中只有 `workscene_change_approve` 能改场景注册表。
- `workscene` 方法组：给 `/work` 等接入面调用，包含 `list/create/rename/delete/enter/exit`，是固定业务方法，不经过模型。
- 底层注册表 `WorkSceneRegistry`：真正落盘的底层 CRUD，包含 `list/get/add/remove/rename/touch`；不是用户入口，也不是模型工具，上面两套最终都会落到它，且同样没有 `setWorkdir/updateWorkdir`。

我现在呢，说一下我自己内心的想法：
我理解目前提供给业务侧使用的场景功能有两套。虽然前面提到能力面有三个部分，但我关注的是业务需求这一侧，系统内提供的功能确实是两套：

1. 给主模式工作场景用的工具
2. 给斜杠 work 指令用的方法组，即 work sense 方法组
从避免冗余的角度考虑，我们的标准只有一个：只要最优架构，不留任何债务。请判断是否还需要区分这两套。

目前看还不好说。首先，大模型用的工具肯定是需要的；但 /Work 本身有一些固定的方法（比如新增、进入等），所以这个方法组看起来也需要。

我的核心疑问是：有没有可能以“方法组”为地基？即它是最基础的、不与场景耦合的原子性方法。这套原子性的管理方法作为地基，提供给工作场景去使用，而不绑定具体场景——不管你是 /Work 指令，还是给大模型用的，都基于这一套原子性方法。
然后这个大模型使用的工具，对吧？那它就相当于是上一层的封装。它这个工具可以调用原子性的方法，去完成上层的工具封装。所以我这样的话，它是不是就复用了？就不需要再维护两套东西了。这是我的一个思路，具体是否为最优，是需要你来判断的。
然后那个 /work 指令唤起的面板，它也可以用原子性的方法，如果不满足的话也可以进行上层的封装对吧？但我的意思是，它其实是避免有两套东西存在，而是基于一套地基加上层的场景去做这个事儿，这是我的一个思路。
现在上面信息里这两套的能力边界，包括有哪些方法、方法能做什么，已经摸清楚了，你也认可了。

其实现在还需要梳理一下哪些是冗余的，也就是哪些其实是不会用到的。

举个例子，你先别管是谁用，光说“指定目录”这个事儿：无论是新增场景（此时正在新增），它可以指定目录，也可以不指定，这没问题。那么在有了目录以后，我对这个工作场景的工作目录进行修改，这是非常合理的一个需求，现在就是空缺的，所以这个能力需要补齐。这个补齐再结合我们刚才的想法，它就是在基础设施层面的补齐。
我现在有一个核心判断：斜杠 work 指令在 Ctrl+N 唤醒新增场景时，目前调用的是一个固定的工作组方法，参数固定为名字。我觉得这样非常不好，因为我们本身是智能系统，让用户输入内容后对接到固定方法入口，体验很差。

这里应该对接到临时大模型，并赋予工具，而不是死方法。用户可以用大白话描述工作场景名称或目录，交互方式与主模式模型类似，只是场景更小、临时且无需持久化。工具、提示词和职责都非常干净单一，由模型调用管理工具。用户说名称就提取名称，说目录就带上目录，让功能“做活”，而不是固定只能输入特定内容。你明白我意思吗？
总结一下刚才的想法，核心有三点需求：

第一点：检查现有两套提供给业务的功能是否冗余，看能否优化为一套基础设施，并在上层进行封装。
第二点：梳理已有能力的边界（包括方法组的方法和工具的能力边界），清理冗余和用不到的内容。补齐缺失的能力。补充时基于第一点中定义的原子性地基进行，确保上层可以方便地使用。
第三点，关于 `/work` 指令（Ctrl+N 新增工作场景）的需求：

不要采用固定的硬对接方式，否则用户只能输入固定内容，不够智能。

建议启动一个临时的、非持久化的大模型，使用 Main 档位，其职责和工具都非常清晰且精简：
1. 去除多余的提示词和工具，只保留满足职责所需的部分，让模型明确自身任务。
2. 通过调用工具实现功能灵活化，支持用户输入名称、目录等内容。

我认为这样做效果很好。


上面就是我描述的三点需求，我觉得已经说清楚了。关于各自能力边界、冗余等细节，你可以去详细查看。如果认为还有什么需要补充，或哪些需求方向需要明确，也可以告诉我。
但我们需要对接的是需求方向，而不是什么架构细节，这是完全不同的事情

主模式可以创建和删除工作场景，也就是说主模式拥有管理工作场景的所有权限。进入工作场景模式后，就是进入了一个具体的工作场景，它拥有的是管理当前工作场景的相关权限。这个逻辑很清晰。
```

## 架构内容

### 0. 架构结论

工作场景管理收敛为**一套原子能力底座 + 多入口薄适配**:

- **底座 = 宿主侧工作场景领域服务**(`WorksceneDirectory` 升格,不是 RPC 方法表,也不是注册表)。全部业务规则——workdir 校验、运行态守卫、进出语义——唯一居所在此;注册表退为它之下的纯持久化原语。
- **入口全部变薄适配**:RPC 方法(接入面 / 面板)、主模式模型工具、场景模式模型工具、智能创建体消费同一服务对象;接入面后置控制消费者只编排 turn 边界事务,不自带领域规则。`IWorkModeController` 退役。
- **workdir 管理进底座**:注册表补 `setWorkdir` 原语(含 null 解绑),服务层带守卫暴露;创建时可选、创建后可补绑、可更换、可解绑,删除不动用户目录。校验(绝对路径 / 非目录硬校验 + 规范化 + 存在性非阻塞提示;目录缺失时明示"下次进入将自动创建")随之下沉,关闭"模型工具路径绕过校验"的现存缺陷。
- **权限分层 by-construction**:主模式 runtime 物理持有全局管理工具组;场景 runtime 物理只持有"自身属性"工具(闭包捕获自身 sceneId),不靠运行时检查。
- **关系层动作强制逐次拍板**:workscene 管理与模式切换工具全族声明 `requiresExplicitConfirmation`(工具自描述标志,§4)——强制进 broker,三条免确认路径对其全部失效(AI 安全管家 safe 放行、已匹配 allow 规则放行、信任累计沉淀),确认选项仅 allow-once / deny。锚 vision 焊死不变量"关系层动作必须用户拍板、LLM 可提议不可单方面执行";顺带关闭现状两处既有违背(确认面可沉淀全工具 `*` 持久规则、管家可免拍板放行并累计沉淀)。
- **功能资源变更原子化(三层防线)**:服务层场景操作链(enter / setWorkdir / remove 同链串行)+ manager 级 **`quiescePrefix` 原子静默原语**(开闸拦"新会话 / 新 turn / observer 注册" → 前缀 in-use 并集检查(sessions / creating / pendingQueues / observers)→ await 释放全部驻留会话,任一步失败自动关闸报 BUSY,成功返回 disposer)——delete / setWorkdir 按"静默 → 落盘 → 关闸"推进,服务层零 manager 私有状态拼装,结构性消灭"变更已落盘、旧运行态 / 观察者还活着"的全部竞态窗口。rename 是展示身份变更,不改文件根 / 工具面 / 权限边界,不走释放重装配链。
- **接入面后置控制事务收敛到真实消费面**:模型工具只 emit `PostTurnControlIntent`,真正进 / 退场景、场景内改目录后的释放重进、当前会话指针切换,由发起接入面在 turn 结束后消费;本期只实现 CLI 消费。控制工具必须先过接入面能力门:工具声明 `postTurnControlKind` 且当前 turn 所属接入面声明 `postTurnControl` capability 时才可 emit;无 capability 时返回"当前接入面暂不支持该操作",不得 emit 无人消费的意图或向用户承诺"本轮后切换"。能力门不得按 channel 名硬编码白名单,新接入面必须通过声明式 capability + 实际 consumer 获得能力。channel/飞书的模式绑定、入站排队、重启恢复与 observer 同步属于 unified-core 多接入面演进的地基,本文只保留契约边界,不在工作场景管理需求内预建实现。
- **提示词契约随能力面同步**:`WORKING_MODE_TEXT` / powerProfile 身份段 / Environment 工作区文案与 byte-equal 测试基线纳入实施项(§4)——工具能力扩了 prompt 不跟 = 声明面分裂,模型不知有此能力。
- **Ctrl+N 智能创建 = 轻量工具循环的第二个消费者**:复用 `core/tool-loop` 的 `runToolLoop`(已落码)+ 宿主 `llmComplete("main")` 通道(MCP 接入识别同款先例),零新基础设施;创建动作过用户确认门,守住"关系层动作必须用户拍板"的既有不变量。

对需求区核心疑问("能否以方法组为地基、两套合一套")的直接回答:**能,但地基不是 RPC 方法表,而是方法表背后的领域服务**。RPC 方法组本身是传输层入口,与模型工具同级;把它们共同压到一个领域服务上,"两套"就变成"一套底座的两个投影",冗余从结构上消失。

### 1. 现状事实与债务清单(一手核实)

现有五个层面(全部实读源码):

| 层面                                 | 落点                                             | 现状能力                                                                                         | 业务规则                                                                           |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 注册表`FsWorkSceneRegistry`        | `core/src/workscene/registry.ts`               | list/get/add/remove/rename/touch;add 对 name slug 化 + 撞名`-2` 后缀;list 按 lastActiveAt 排序 | 零校验(workdir 原样落盘)                                                           |
| 目录实现`createWorksceneDirectory` | `cli/src/serve/workscene-directory.ts`         | 包注册表 + per-scene ConversationRepository;enterConversation 取最近对话无则建(per-scene 串行链) | create 直通`registry.add`,零校验零守卫                                           |
| RPC 方法`workscene.*`              | `server/src/rpc/methods/workscene.ts`          | list/create/rename/delete/enter/exit                                                             | create 校验 workdir`isAbsolute`;delete 内联活跃守卫(`manager.list()` 前缀匹配) |
| 模型工具                             | `cli/src/runtime/workmode-tools.ts`            | main:enter / change_approve(add/remove/rename) / memory_query;场景:exit                          | change_approve add 的 workdir**仅 trim**;remove 经 controller 守卫           |
| controller                           | serve 内联(`cli/src/serve/command.ts:385-397`) | registry 直通 + removeWorkScene 守卫                                                             | 守卫与 RPC delete**重复实现第二份**                                          |

债务(需求区"清理冗余"的对象):

- **D1 · 守卫双份**:同一"场景有活跃会话拒绝删除"逻辑,`workscene.ts:137-147` 与 `command.ts:387-396` 各写一遍。
- **D2 · 校验错层**:workdir 绝对路径校验只在 RPC 传输层;模型工具路径(`change_approve add` → `controller.registry.add`)完全绕过——相对路径 / 垃圾字符串可直接落盘,而 `scene.workdir` 是 power runtime 的文件操作根(`runtime-host.ts:createWorksceneRuntime`),这是安全相关的真实缺陷。
- **D3 · 宿主双管理面**:`WorksceneDirectory` 与 `IWorkModeController` 都在宿主进程包同一个注册表,各带一套语义——正是需求感知到的"两套"。且 controller 把裸 registry 暴露给工具,工具写路径不经任何领域规则。
- **D4 · 能力缺失**:`setWorkdir` 在注册表 / 目录 / RPC / 工具四层全部不存在。
- **D5 · 死表单**:Ctrl+N → repl 内联输入(`repl.ts:1377`)→ `RpcWorksceneFacade.create(name)` 固定流程,只能输入名字。

### 2. 目标分层:一套底座、多入口适配

```
┌ 入口适配层(零业务规则,只做形状校验与呈现)
│  ├ RPC 方法 workscene.*        —— 接入面 / /work 面板 / 未来 surface
│  ├ 主模式模型工具               —— enter / change_approve(+set_workdir/clear_workdir) / memory_query / list(只读元数据)
│  ├ 场景模式模型工具             —— exit / rename_current / set_workdir_current / clear_workdir_current(闭包限自身)
│  ├ 智能创建体(Ctrl+N)          —— tool-loop 场景层,工具最终也走 RPC 入口
│  └ 接入面后置控制事务消费者      —— 本期 CLI 在 turn 边界消费 PostTurnControlIntent;其它接入面留给 unified-core
├ 领域服务层(原子能力底座,业务规则唯一居所)
│  └ WorksceneDirectory(升格)   —— 校验 / 运行态守卫 / 进出语义 / 释放协调
└ 持久化原语层(零业务语义)
   └ IWorkSceneRegistry          —— 纯 CRUD + 锁 + 原子写
```

- 保留 `WorksceneDirectory` 名与"server 声明接口、装配方注入"模式——与 ConversationDirectory / TrustDirectory 同族,改名零语义收益、破坏族内一致性。
- 现有封装逐项处理(不预设保留或推翻):注册表**保留**(持久化原语职责纯净、锁模型成熟);目录**升格**(它已是注入 ServerContext 的正确接缝,规则收拢进来);`IWorkModeController` **退役**(D3 的一半,工具改依赖服务);RPC 内联守卫与校验**下沉**(D1/D2 关闭);面板固定创建流程**降级为 fallback**(见 §5)。

### 3. 领域服务契约

```typescript
// server/src/runtime/workscene-directory.ts —— 接口升格
export interface WorksceneDirectory {
  list(): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  create(opts: { name: string; workdir?: string }): Promise<WorksceneWriteResult>;
  /** 改名只写注册表身份;活窗口内的旧名称派生视图可自然滞后到下次窗口 / 重进。 */
  rename(id: string, name: string): Promise<WorkScene | null>;
  /** 补绑 / 更换 / 解绑(null)工作目录。不存在返回 null;场景运行态在用抛 WorksceneBusyError。 */
  setWorkdir(id: string, workdir: string | null): Promise<WorksceneWriteResult | null>;
  remove(id: string): Promise<boolean>;          // 在用抛 WorksceneBusyError
  touch(id: string): Promise<void>;
  /** enter 的原子执行体(场景操作链上):取 / 建场景对话 → 注册 observer → 默认 touch → 返回。不存在返回 null。 */
  enterScene(
    sceneId: string,
    observerId: string,
    opts?: { touch?: boolean },
  ): Promise<{ conversationId: string; scene: WorkScene } | null>;
}

interface WorksceneWriteResult {
  scene: WorkScene;
  /** 非阻塞提示(如"目录当前不存在,下次进入将自动创建"),入口层原样转述,不拦截。 */
  workdirWarning?: string;
}
```

**校验规则(全部住服务层)**:

- **名称校验**:`create` / `rename` 共用 `normalizeSceneName`——trim 后必须非空,落盘使用规范化后的名称;入口层不得各自维护"非空名"判断。注册表仍只负责 slug / 持久化,不接受业务层未校验名称。

**workdir 校验规则(create 与 setWorkdir 共用一个 `validateWorkdir`)**:

- 硬校验:非空字符串、绝对路径(`isAbsolute`)、**存在且非目录拒绝**(stat 命中文件等非目录项即拒——workdir 是运行时文件根,指向文件的根是必然故障态,不得落盘)。stat 谓词具名为 `probeWorkdir`,与 `normalizeWorkdir` 同居 core/workscene,返回结构化结果:`directory` / `missing` / `non_directory` / `inaccessible` / `error`。只有 `missing` 是软提示;`non_directory`、`inaccessible`(如 EACCES / EPERM)、`error`(如 ENOTDIR / ELOOP / EINVAL / 未知 stat 异常)全部硬拒绝——系统无法确认它是可用目录时,不得写成文件操作根。服务校验与 assist 本地预检**同源消费**,防两份 stat 逻辑漂移。校验失败抛结构化错误,入口层转述(RPC → invalidParams;工具 → isError 文本回灌,LLM 据此向用户澄清)。
- 规范化:单一纯函数 `normalizeWorkdir`(core/workscene,`path.normalize` 收敛分隔符与冗余段)——服务落盘、管线确认面、assist 确认门三处共用同一实现,**用户拍板的字符串就是持久化的字符串**。纯函数无 I/O,故确认构造时点(工具执行前)即可产出。
- 软校验:目录不存在**不阻塞**,以 `workdirWarning` 随结果带出(呼应需求"目录校验";阻塞会把"先建场景后建目录"的正常次序变成错误)。提示文案必须诚实说明:该目录当前不存在,但由于 runtime 显式 workspace 会走 `ensureWorkspaceDir`,**下次进入该场景时会自动创建该目录**。**提示落点三处**:RPC 结果字段 / 工具结果文本(模型向用户转述)/ assist 确认门(cli 与宿主同机,门前本地 stat 事实成立);管线确认面**不含**此提示——确认请求在工具执行前同步构造(`buildConfirmationRequest` 只拿 toolName + raw input),存在性是 I/O 事实、该时点产不出,不为便利提示给共享确认管线加异步富化协议(安全实质是规范化后的根路径,纯函数已保)。
- **解绑**:`setWorkdir(id, null)` 回到"无目录"态。workdir 是可选属性,状态机必须可达回退——否则唯一回退路径是删场景重建,以丢弃场景记忆与会话为代价回退一个属性,不可接受;解绑后下次装配自然回无目录形态(文件工具剔除,powerProfile 二分既有语义,零新机制)。这是由"创建时可选目录"推出的状态机完备性要求。
- RPC 层只留参数形状校验(`string | null`,string 时非空),`isAbsolute` 从 `workscene.ts:87-91` 迁出。

**运行态守卫(delete / setWorkdir 共用; rename 不守卫)**:

workdir 是功能资源: `createWorksceneRuntime(scene)` 把它焊进 workspace / PathGuard,活实例若继续使用旧 workdir 就会真实读写错目录。delete 是破坏性动作:它删除场景系统目录,活实例继续写会撞 ENOENT。二者必须先清空运行态再落盘。scene name 是展示身份 / prompt 派生文本:活窗口内旧名称滞后到下次窗口换代或重进是可接受的派生视图滞后,不产生功能事故,不得为了消灭无害称呼滞后而释放并重建整个工作上下文。未来若出现当前二分不覆盖的新属性(如影响工具面 / 权限面 / 装配资源但不是文件根),必须先扩展判据与分类,不得把未覆盖属性硬塞进当前二分。

delete / setWorkdir 的变更流程在**场景级准入闸**内原子完成(次序本质:先阻断并清空运行态,再落盘变更事实——绝不在"删除 / 变更事实已落盘"后才尝试收拾运行态):

0. **场景操作链(服务层前置)**:既有 per-scene `enterChains`(`workscene-directory.ts:22-26`,现只串行 enterConversation)升格为**场景操作链**——enter / setWorkdir / remove 同链串行。**enter 的链段边界 = 用户可见的语义单元,不是机制单元**:现状 RPC handler 在 `enterConversation` 返回后才做 touch / `addObserver(allowInactive)` / 返回(`workscene.ts:165-189`),链只护第一段时,remove 可在其后立刻进链——此刻 observer 尚未登记、in-use 检查扑空——删除完成后 enter handler 恢复执行,touch 异常被吞、addObserver 照常登记,**用户拿到"成功进入已删除场景"的 stale 结果**。设计:enter 执行体整体收进领域服务——`enterScene(sceneId, observerId, opts?)`,链段覆盖"取 / 建场景对话 → `manager.addObserver(allowInactive)` 登记 → 按 opts 决定是否 touch → 返回";服务已持 `conversations` 引用(守卫同源),零新依赖,RPC handler 变薄(只剩推进恢复与状态加载——留在链外是安全的:observer 已登记,其后任何 setWorkdir / remove 必被 in-use 拦成 BUSY)。默认真实进入 `touch !== false`;未来非 CLI 接入面恢复路由时可用 `touch:false`,只恢复 observer,不刷新最近使用时间。**并发不变量(验收级)**:enter 与 remove / setWorkdir 交错只允许两种结果——enter 先完成(observer 已登记)⇒ 变更 BUSY;变更先完成 ⇒ enter 等待后得 notFound / 新目录。**绝不返回已删除场景,也绝不返回旧 workdir 装配出的场景会话**。链的覆盖范围理由:enter 是唯一触碰注册表锁之外状态(对话目录 + observer 名册)的操作;setWorkdir / remove 需要与它互斥;rename 只经 registry per-id metaLock 线性化,list 的交错也由 registry per-id metaLock 覆盖,不上链。`session.subscribe` 直订路径不经此链,由下面的闸拦(subscribe 撞闸静默降级且**自愈**——下次 send 经 `admitTurnForSession:550` 自动重注册 observer,期间仅漏 run 外通知,接受的边缘)。
1. **静默**:`await manager.quiescePrefix('ws:<sceneId>:')`——manager 级**原子静默原语**(sessions / creating / pendingQueues / observers 四组 owner 私有态,前缀级枚举与判定必须内聚在 owner,**服务层不得拼装 manager 私有状态**;闸与 per-session 释放降为其内部实现件,不进公开面)。其内部依次:
   - **开闸**(不变量):闸持有期间,命中前缀的对话**不得新建 ManagedSession、不得接受新 turn、不得注册 observer**(含 `addObserver(allowInactive: true)`——`session.subscribe` 与 enter 的注册闸内返回 false / BUSY)。observer 拦截不可省:只靠释放失败兜底,挡不住"全部释放成功后、落盘前"滑入的 observer。检查点覆盖全部会话态产生入口:会话创建两入口 `getOrCreate`(`conversation-manager.ts:385`,**含命中既有会话的 fast-path 返回**)/ `getOrCreateExisting`(`:524`)、`admitTurn` 入口(`:505`,含其 `sessions.get` 快路径)、**公开 `enqueue`**(`:1433`——直接入队路径不经 `admitTurn`,漏拦即漏新 turn)、observer 注册(`:619`)。不得按"单一咽喉"实现漏一半;释放失败安全阀仍在(枚举外路径兜底)。
   - **前缀 in-use 检查**:对四组 owner 私有态按前缀取键并集——覆盖①在场 ManagedSession(busy / ConversationManager pending / observers)②**creating 在途会话**(`getOrCreate` 已开始 factory / loadHistory / runtime 装配,尚未进入 sessions;漏掉会让旧 workdir runtime 在 setWorkdir/remove 落盘后复活)与③**无会话但被观察的对话**(`addObserver(allowInactive)` 会为未激活对话登记 observer,`workscene.ts:174`;漏掉则 delete 会在"有人正看着场景(已 enter 未发言)"时放行)。四分量缺一不可:busy 是在跑的 turn;creating 是已启动但未登记的运行体创建;ConversationManager pending 是已准入待跑的排队输入(释放即丢);observers 是正盯着的接入面(grace/idle 释放前置恰是 `observers.size === 0 && !busy`,`:640/655`——释放带 observer 的会话是现有生命周期从不产生的新状态,不得引入)。
   - **await 释放**:逐个释放无主驻留会话并 **await 每个 dispose resolve**——`runtime.dispose()` 是异步末窗收尾(onWindowClose flush 可能向场景记忆域 / 快照写盘,`:1582-1589` delete 路径同款"await 让 flush 完成"),不等 resolve 即落盘会让 rm / 改根撞上在飞写入;dispose 异常记日志仍完成释放(`:1584-1588` 既有"失败不阻断"语义);释放前置与 grace 完全一致,零新生命周期状态,下次激活按新属性重装配(工厂装配时刻新鲜读注册表,`command.ts:420-426`)。
   - **收尾**:任一 in-use 命中或释放失败 → **自动关闸 + 抛 `WorksceneBusyError`**(RPC 映射 `RPC_ERROR_CODES.BUSY`,工具映射"场景正在使用中,请先退出或等待完成");全部成功 → 返回 disposer,**闸保持持有**。
2. **落盘变更**:`registry.setWorkdir` / `remove`。
3. **关闸**:disposer(finally 恒执行)。失败语义:落盘变更抛错时会话已释放但注册表未写——无害(下次装配仍读旧值,状态自洽);闸恒释放,不留死闸。闸持有时长受释放时长界定(跨越 await 的 dispose/flush,非恒毫秒级——correctness 优先,BUSY 窗口 = 释放时长,如实记录);单写者宿主进程内前缀谓词检查,无跨进程复杂度。

竞态由三层防线**结构性关闭**,各管一类交错:①没有闸时,"检查与释放之间滑入的 send"会让旧 workspace 实例转 busy、拒绝释放,该实例存活至 idle/退出——注册表新 workdir 而运行态旧文件根(静默 split-brain),delete 更会 ENOENT 风暴——**闸的 turn 准入拦截**关闭;②"释放成功后、落盘前滑入的 observer"会让 delete / setWorkdir 在有人观看时提交——**闸的 observer 注册拦截**关闭;③"enter 与 rm 交错复活孤儿目录"——**场景操作链**关闭;④"enterConversation 出链后、observer 登记前滑入的 remove"会让用户拿到已删除场景的 stale enter 成功——**enter 原子化**关闭,且原子边界必须画在用户可见的语义单元上,不是机制单元上。闸内新 send / 新订阅得到有界的 BUSY(窗口时长 = 释放 dispose/flush 时长,短暂但非恒毫秒级),enter 经操作链等待后得到正确终态,换来零残余竞态。

依赖注入:`createWorksceneDirectory` 增收 `conversations: () => ConversationManager | null`(serve 已有 `conversationsRef` 惰性引用,`command.ts:253` 同款)。`ConversationManager` 公开面只新增一个 owner 原语:`quiescePrefix(prefix): Promise<() => void>`。它内部持有闸、前缀 in-use 枚举、per-session 释放,不单独暴露 manager 私有 Map(公开面最小化;服务层只需要"能否安全静默并释放"这一语义)。防御性语义:同前缀已持闸时再调 → 直接抛 BUSY、不排队(排队会造隐式第二串行点;场景操作链已保证正常不发生,此为公开原语的自卫边界);creating 命中同样直接 BUSY,不得等待它完成后继续,否则静默窗口会跨过一个未受闸保护的旧属性 runtime。`enqueue` 的闸命中不抛错,返回值显式扩为 `"busy"`(`"immediate" | "queued" | "full" | "busy"`),调用方按 BUSY 告知"场景正在切换或目录变更,稍后重试",不得退化成队列满或会话创建失败;`getOrCreate` / `getOrCreateExisting` / `admitTurn` / observer 注册继续走 `WorksceneBusyError` 或既有 false/BUSY 形态,**所有接入面必须在这些入口统一映射 BUSY 文案**。`WorksceneBusyError` 单点定义在 server 包(与 `WorksceneDirectory` 接口、ConversationManager 同包——manager 抛、服务透传、RPC 层 instanceof 判,同包零跨包类同一性问题);`ManagedSession.observers` 现由 `getOrCreateObserverSet` 取 manager 级同一 Set,但守卫谓词仍一律以 manager 级 Map 为准,不依赖字段镜像假设。

此升级顺带修复现存体验缺陷:现状退出场景后 grace 60s 内删除被拒(`graceTimeoutMs` 默认 60_000,`conversation-manager.ts:59`);cli 退出场景时已对场景对话 unsubscribe(observer 归零),故"刚退出即删 / 即改目录"命中的正是无主 grace 驻留会话,新语义下立即可行。场景 delete 后该场景对话的推进控制日志(`~/.zhixing/advancement/`)成为孤儿,由既有 `__advancement-gc` 孤儿清扫兜底——delete 不新增清理职责。

**rename 轻量化**:服务层 `rename` 只做名称校验 + `registry.rename` 落盘,不存在返回 null。它不走 `quiescePrefix`,不释放 runtime,不触发重进。当前活窗口 / powerProfile / 横幅中的旧名称属于派生视图滞后,与 skill 索引等窗口内稳定前缀同类;下次 list / enter / 窗口换代自然看到新名。本需求不做即时显示刷新承诺,不得把 display refresh 上升为 runtime 生命周期事务。

**注册表补原语**:`IWorkSceneRegistry.setWorkdir(id: string, workdir: string | null): Promise<WorkScene>`(null = 删除 workdir 字段),`FsWorkSceneRegistry` 经既有 `mutateMeta` 实现(与 rename/touch 同款 per-id 锁 + 原子写),但写前必须验证 id 仍是 index 成员,不存在或已被 remove 摘出 index 则抛——语义翻译归服务层。路径规范化、目录探测与业务提示不进注册表;index 成员校验是持久化层成员权威的一部分,不与"业务规则唯一居于服务层"冲突。

**注册表 remove 锁语义修正**:现状 `remove` 在 index 锁内摘 id、**释放 index 锁后**才在 per-id metaLock 内 rm(`registry.ts:120-130`)——锁缝里同名 `add` 读到"id 已空闲"复用同一 slug,若其 `writeMeta` 先于 remove 的 rm 进入 per-id 锁链,**rm 会删掉新场景的目录**,留下"index 有条目、目录已删"的幽灵态——该结局不对应任何合法串行化,是真一致性破坏。修正:remove 在 **index 锁内同步把 rm 任务登记进 per-id 锁链**(登记不 await,出 index 锁后再 await 其完成)——任何后于本次摘除读 index 的 add,其 writeMeta 必然排在 rm 之后(per-id FIFO),新场景目录恒后于删除写入、恒存活。**此 FIFO 是写入阶段残窗兜底,不是分配阶段主规则**——同名冲突的分配由下文物理避让优先处理:remove 进行中物理目录尚在,同名 add 一律避让 `-2`、不复用 id,故"复用同 id 撞 rm"在物理避让下根本不发生;FIFO 仅覆盖"add 的 stat 与 rm 完成之间"的理论窄窗(即便此窗内复用了 id,writeMeta 也排在 rm 之后)。per-id FIFO 下"rename 成功后场景被删"等价于顺序 rename→remove 的合法串行化,无产品损害,不为它加锁。

**成员关系语义**:index 是**成员与分配**权威——list / 枚举 / id 分配(含下述物理占用避让)只认它;直接 id 操作(get / rename / touch / setWorkdir)也必须先验证 id 仍在 index 中,不允许因为 meta 物理残留而复活 orphan 场景。per-id FIFO 只负责同 id meta/rm 的写入线性化,不改变成员判定:先于 remove 摘 index 完成的直接 id 操作可成功,后于摘 index 的直接 id 操作统一得不存在。orphan meta/目录只可作为 slug 避让或未来清扫对象,不得成为可进入、可改名、可绑定目录的场景;此语义连同测试固化(§9)。

**id 分配须避让孤儿物理目录**:add 现只以 index 判占用;create / remove 中途崩溃可留下未注册的物理目录,同名新建会**继承旧 `me/` 与 `conversations/`**——旧场景的记忆与会话在"新"场景里复活,数据渗漏。修正:`uniqueId` 的占用集 = index ∪ `getWorkSceneDir(id)` 物理存在——物理占用即避让(slug `-2` 后缀),不清理不销毁(崩溃残骸罕见,避让即无害;残骸清扫留作未来维护 sweep,不预建)。**与 §remove 锁修正的 FIFO 分层**:物理避让是**分配阶段主规则**(决定新 id),FIFO 登记是**写入阶段残窗兜底**(保证即便复用也不撞 rm)——两者不冲突而是分属两阶段。单一测试口径:remove 进行中的同名 add → 得 `-2` 新 id、新场景不继承旧 `me/conversations`;remove 完成后的同名 add → 复用原 id(物理已删,正常回收)。

### 4. 权限分层与工具面(by-construction)

主模式 = 全局管理权限,场景模式 = 自身属性权限;隔离靠装配期注入哪组工具,不靠运行时检查(与 `assembleTools` 现有 spec.kind 二分同构,`builtin-extra-tools.ts:142-152`):

| 工具                                | 注入面     | 动作                                                                      | 确认                                                                                                                                |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `workmode_enter`                  | main       | emit 进入意图                                                             | boundaries`agent-context.switch` → confirm(boundaries 不变;叠加全族强制逐次拍板,见下)                                            |
| `workscene_change_approve`        | main       | add / remove / rename /**set_workdir / clear_workdir**(新增 action) | boundaries`filesystem.write` → confirm(boundaries 不变;叠加全族强制逐次拍板,见下)                                                |
| `workscene_memory_query`          | main       | 只读检索场景记忆                                                          | observe 自动放行(不变)                                                                                                              |
| `workscene_list`                  | main(新增) | 只读场景元数据(id / name / workdir / lastActiveAt),管理读模型             | observe 自动放行                                                                                                                    |
| `workmode_exit`                   | 场景       | emit 退出意图                                                             | boundaries`agent-context.switch` → confirm(boundaries 不变;叠加全族强制逐次拍板,见下)                                            |
| `workscene_rename_current`        | 场景(新增) | 改自身名称(确认后直接写注册表;不释放 / 不重进当前 runtime)                | boundaries`filesystem.write` → confirm(叠加全族强制逐次拍板,见下)                                                                |
| `workscene_set_workdir_current`   | 场景(新增) | 改自身工作目录(emit 意图,turn 边界编排生效,见下)                          | boundaries`agent-context.switch` + `filesystem.write`(既切上下文又改文件根边界,审计双声明)→ confirm(叠加全族强制逐次拍板,见下) |
| `workscene_clear_workdir_current` | 场景(新增) | 解绑自身工作目录(emit 意图 workdir:null,同上编排)                         | 同上双边界 → confirm(叠加全族强制逐次拍板,见下)                                                                                    |

- **工具声明单一真相源(必守)**:实现时定义 `WORKSCENE_MANAGEMENT_TOOLS` 描述表,以工具名为 key,值包含 `{ surface, actions, boundaries, requiresExplicitConfirmation, confirmationDisplay, postTurnControlKind? }`。工具装配、schema action 枚举、`buildWorksceneChangeSummary` 动作全集、`buildDisplayBody` 的 workscene 工具键集、`requiresExplicitConfirmation` 声明者集合、post-turn 能力门与测试枚举全部从该表派生。凡声明 `postTurnControlKind` 的工具(call 体最终会 emit `PostTurnControlIntent`,当前包括 enter / exit / set_workdir)统一走能力门:工具侧由 `postTurnControlKind` 表示需要 turn-boundary consumer,接入面侧由声明式 `postTurnControl` capability 表示当前 turn 有真实 consumer(实现形态为给 `TurnOrigin` 增可选 `surface.capabilities.postTurnControl === true`,本地 CLI 直驱由 CLI runner 注入等价本地 capability);两者同时满足才可 emit。无 capability 则返回暂不支持,不得 emit。不得在工具表 / 构造器 / DisplayBody / secure-executor 声明 / post-turn emit 点 / 测试里各自手写动作清单或 channel 白名单;新增动作只改一处,新增接入面只声明 capability 并实现 consumer,从结构上关闭"声明面领先 / 生效面漏改"债务。
- 工具依赖从 `IWorkModeController` 改为领域服务窄接口(list/get/create/rename/setWorkdir/remove)——所有写路径过服务规则,D2/D3 关闭。`work-mode-controller.ts` 与 serve 内联 controller 删除;`RuntimeHostOptions.workModeController` 更名为 `workscenes: () => WorksceneDirectory`。消费者全集已核(6 文件:runtime-host / workmode-tools / work-mode-controller / builtin-extra-tools + 两测试,均 cli 包内),退役无外溢。
- **确认面拍板质量(必守)**:`workscene_change_approve` 现落 `buildDisplayBody` 的 generic 兜底——`JSON.stringify(input)` 截断 120 字符(`core/src/confirmation/request-builder.ts:103,111-119`)。set_workdir 的拍板对象就是完整路径,截断裸 JSON 不合格。设计:`buildDisplayBody` 增 workscene 分支,但**复用 `kind:"generic"`、summary 由共享确认内容构造器产出**(§8)——不新增判别式 kind(新 kind 要本地 TTY / 远程文本 / RPC bridge 三投影渲染器全扇出,generic 零渲染器改动、三投影一致 by construction;实现时须核实各投影对 generic summary 无二次截断)。内容 = 动作友好名 + 稳定目标标识 + **涉及 workdir 时给出规范化后完整不截断的路径**(`normalizeWorkdir` 纯函数,确认构造时点可产出);**不含存在性提示**——确认请求在工具执行前同步构造,存在性提示按 §3 三落点走结果文本与 assist 门。**同步上下文即可,不引入异步确认富化协议**:`buildConfirmationRequest` 可增收 `displayContext?: ConfirmationDisplayContext`,只消费工具定义时已拥有的权威上下文。场景 runtime 生成 current 工具时写入 `{ workscene: { sceneId, sceneName } }`,其中 sceneName 来自闭包 scene,不是 LLM 输入;主模式 `workscene_change_approve` 对已有场景动作展示 sceneId 作为稳定锚,不信任 LLM 传入的 sceneName,也不为 nice-to-have 的 name 展示给确认管线加异步 resolver。目标不存在由工具执行阶段返回 not-found。`buildDisplayBody` 的 workscene 分支键集从 `WORKSCENE_MANAGEMENT_TOOLS` 中 `confirmationDisplay === "workscene"` 的工具派生,当前覆盖 `workscene_change_approve`、`workscene_rename_current`、`workscene_set_workdir_current`、`workscene_clear_workdir_current`;漏派生任一即回落 120 字符裸 JSON,测试必须捕获。
- **全族强制逐次拍板(关闭既有违背)**:vision 焊死不变量"关系层动作(接入 / 移除 / 进入)必须用户拍板,LLM 可提议但不可单方面执行"(set_workdir 最尖锐:workdir 是 PathGuard 边界,免拍板放行 = 安全边界不再受用户控制)。现状违背有两处、且互相加重:①确认面持久选项——suggestPatterns 对未知工具走通用回退 `{ tool, argument: "*" }`(`confirmation-tracker.ts:133-139`),change_approve / enter / exit 的持久选项是"始终允许**所有**该工具操作",一次 allow-global 放行全族动作(permissionArgumentKey 只参与规则匹配提取、不参与模式生成——粒度比"按 action"更粗);②AI 安全管家路径——灰色 external 判 `safe` 即跳过 broker 直接执行,且喂 `maybePersistTrust` 做信任累计、攒够阈值沉淀永久规则(`secure-executor.ts:246-282`),LLM 提议、LLM 放行;而已匹配 allow 规则的调用连管家都不经、直接执行(`consultSteward` 触发条件即"external + 无用户规则")。故仅收缩确认选项不够——免拍板路径共三条(管家 safe / 规则匹配 / 信任沉淀),必须全部封死。
- **机制:`ToolDefinition.requiresExplicitConfirmation?: true`**(与 needsPermission / permissionArgumentKey / boundaries 同属 21A 工具自描述家族;单一标志承载单一完整语义"每次都必须用户拍板",不拆成多个部分标志)。四个生效点:**E1** secure-executor 决策点——该标志强制走 broker 路径,已匹配 allow 规则与 classifier 放行均不得跳过(deny / block 仍然生效:规则只能收紧它、不能放宽它);**E2** 不进 `consultSteward`(管家对其无研判资格);**E3** 任何路径不喂 `maybePersistTrust`——调用点有**两处**、都要跳过:管家 safe 放行(`secure-executor.ts:264`,origin "steward")与 broker 路径的 allow-once(`:684`,origin "user","累计达阈值后自动沉淀放行规则")——只封管家侧,用户反复 allow-once 仍会攒出规则:E1 使其对执行无效,但 /trust 列表会出现"声明允许、实际无效"的说谎规则 + tracker 无意义累计;**E4** `buildConfirmationOptions` 仅生成 allow-once + deny-with-reason(与 bypassImmune 同一收缩分支)。通用机制,未来边界变更类工具复用。声明者集合从 `WORKSCENE_MANAGEMENT_TOOLS` 派生,覆盖:`workscene_change_approve`(全动作)、`workmode_enter`、`workmode_exit`、`workscene_rename_current`、`workscene_set_workdir_current`、`workscene_clear_workdir_current`。不为该族设计规则迁移 / 清理流程;开发机已有无效残留规则对该族无效,由开发者自行清理。
- `workscene_rename_current` 闭包捕获自身 sceneId:`ExtraToolsRuntimeContext.spec` 的 workscene 变体扩为 `{ kind: "workscene"; sceneId: string; sceneName: string }`,`RuntimeHost.createWorksceneRuntime(scene)` 传入(它持有 scene)。工具物理无法触达其他场景,并把同一 scene 上下文写入 `ToolDefinition.confirmationDisplayContext` 供确认面展示。
- **解绑走显式 `clear_workdir`,不用 set_workdir 缺参表达**——缺参应是错误而非语义,防模型漏参误解绑(解绑会连带下次装配剔除文件工具,必须是显式意图)。
- **管理读模型**:主模式模型此前只有 `workscene_memory_query`——它是记忆检索,headers 附带 name / id 但**不含 workdir**,模型无法回答"某场景现在绑哪个目录",管理动作的目标解析寄生在记忆工具上是职责错位。新增 `workscene_list` 只读元数据工具(id / name / workdir / lastActiveAt,薄壳直达服务 list,observe 自动放行)——管理读模型与记忆检索各归其位,`workmode_enter` 描述里"场景列表"的指涉自此有实体。
- **提示词契约同步(能力面的一部分,漏改即声明面分裂)**:①主模式 `WORKING_MODE_TEXT`(`system-prompt.ts:401-415`)现说 change_approve 只能 "create, rename, or remove"、把工作场景描述为 "with its own working directory"(必有目录)——与"五动作、workdir 可选 / 可解绑"直接冲突;该段是显式 prompt-text 契约(注释自述"宁可工具改名时同步本文本"),随本次能力扩展同步改写(动作枚举补全含 set_workdir / clear_workdir、新增 `workscene_list` 的指涉、workdir 改为可选属性表述)。②`powerProfile` 身份段补"当前场景内可经确认改名、更换或解除本场景工作目录绑定;改名立即写入登记信息,当前窗口内名称称呼可到下次窗口 / 重进自然更新;目录变更在本轮结束后按新配置重新进入"——该文案必须与场景专属工具同步落地,工具落地前不得进 prompt。③Environment 段 workspaceSource 文案核查——场景 workdir 属运行时装配的工作区,不适用"改 config 后重启"类提示,按 source 分支措辞。④以上全部纳入 system prompt byte-equal 测试基线更新(窗口内字节冻结纪律不破:文本变更 = 新窗口起点,基线随之更新)。
- **场景内改自身属性:rename 轻量写入,workdir turn 边界重装配**。设计依据:①主模式管理全局场景,场景模式管理当前场景属性;②workspace 变更会改变文件根 / PathGuard / 工具面,必须在 turn 边界释放并按新配置重进;③scene.name 变更只影响展示与 prompt 派生文本,活窗口旧称呼滞后可接受,不应为改名重启工作上下文。设计:场景工具 `workscene_rename_current({ name })`、`workscene_set_workdir_current({ workdir: string })` 与 `workscene_clear_workdir_current()`(set / clear 对称提供——与底座 null 解绑、主模式 clear_workdir 同一状态机完备性原理,场景对自身属性的管理权不做无原则截除;解绑仍走显式工具、不用缺参表达)。执行次序(按 SecurityPipeline 既定时序,确认恒先于 call 体):**全族强制逐次拍板确认 → call 体内校验(name 走 `normalizeSceneName`;workdir 走 `normalizeWorkdir` + 绝对路径 + `probeWorkdir`,失败 isError 回灌、模型修正后重试)**。rename 成功后直接调用服务层 `rename(sceneId,name)`,返回"已改名"并让模型正常收尾;不 emit 后置控制意图。set / clear workdir 成功校验后先过接入面能力门,确认当前 turn 所属接入面声明 `postTurnControl` capability,再 emit 后置控制意图 `{ kind: "set_workdir", sceneId, workdir: string | null }`;能力门不通过则返回 isError 文本"当前接入面暂不支持场景内更改工作目录,请在 CLI 中操作",不落盘、不 emit。`sceneId` 来自工具闭包,不进 LLM 可见 schema,用于接入面在消费时校验"意图锚点仍是当前场景"。**后置控制意图类型**:统一使用 `PostTurnControlIntent` / `pendingPostTurnControl` / `session.postTurnControlIntent`(事件名同步为 `post_turn_control:requested` 或等价命名),只承载 enter / exit / set_workdir 这类 turn-boundary 控制。`emitPostTurnControlIntent(intent): void` 是纯发射,工具 call 体拿不到"本 turn 已 emit 什么",故不得设计"emit 处拒绝异 kind"这类无落点机制;accumulator 保持既有 last-wins 生效语义,同时记录本 run 是否出现多种 `kind`(如 `hadConflictingKinds/kindsSeen`)并随 `pendingPostTurnControl`/控制通知带出。同 kind 重复 emit = last-wins 且不提示;异 kind 同 turn = **最后一次拍板的意图生效 + 接入面显式提示"本轮出现多个控制请求,已按最后一次确认执行 X"**,不再静默丢弃,也不凭空让工具侧拒绝。rename 不进该单槽,所以"改名 + 换目录"可自然同时成立:rename 立即写入,set_workdir 在 turn 边界重进。
- **CLI 接入面消费契约(本期唯一消费面)**:控制意图随 turn 边界只到达发起接入面。CLI 接入面声明 `postTurnControl` capability 并实现本期唯一 consumer;enter / exit 沿用 CLI 既有模式切换消费路径,字段与冲突语义统一进 `PostTurnControlIntent`;set_workdir 的 CLI 形态为①校验 intent.sceneId 仍等于当前场景 → unsubscribe 场景对话(observer 归零)→ ②调 `facade.setWorkdir(workdir|null)`(经 quiesce 释放 + 落盘)→ ③`workscene.enter` 重进(新实例按新目录装配)→ ④切指针,呈现"已按新目录重新进入"。失败矩阵:setWorkdir BUSY(他面在场或已有 pending)→ 重进旧场景 + 告知"场景正在使用,未修改";enter 失败(场景被并发删除)或 sceneId 锚点不匹配 → 走 exitScene 既有 fallback 链回 main。不引入 `pendingWorkdir` 这类延迟生效暂存态;变更即时经权威路径生效。channel/飞书消费、binding 持久化、入站重排队与重启恢复不在本文实现,归 unified-core 多接入面阶段;在它们实现 consumer 并声明 `postTurnControl` capability 前,`WORKSCENE_MANAGEMENT_TOOLS.postTurnControlKind` 驱动的能力门必须阻断相关工具,不得假承诺切换或目录重装配。

### 5. 智能创建(Ctrl+N → 轻量工具循环)

**放置方式:cli 侧跑循环,LLM 经宿主单发通道**。实现参照:MCP 接入识别在 cli 进程跑 `runToolLoop`(`core/src/tool-loop/`,已落码),`complete` 绑 `management.llmComplete(prompt, "main")`(`config-command.ts:259` 的 `inferLlm`;宿主侧 `ServerContext.llmComplete` → `ephemeralRuntime.callText`,`command.ts:692`)。智能创建体照此形态,是 tool-loop 的第二个消费者:循环状态活在面板交互期、随关闭丢弃(天然"一次性、非持久化"),LLM 用 Main 档(`role: "main"`,与需求锁定一致),工具经既有 `RpcWorksceneFacade` 走 RPC → 领域服务。零新 RPC 面、零宿主状态、零新基础设施。

**场景层规格**(新模块 `cli/src/runtime/workscene-create-assist.ts`):

- `goal`:任务定义(理解用户对新场景的自然表达,提取名称与可选工作目录;信息不足以创建时提问澄清,不编造)+ 现有场景名单快照(list 注入,供撞名感知与参照)+ 输出契约。场景很少,名单以文本注入 goal,不设 list 工具。
- `tools`:唯一工具 `workscene_create({ name, workdir? })`。其 `run` 分三步:⓪**本地预检**——复用共享校验件(`normalizeSceneName` + `normalizeWorkdir` + 绝对路径纯校验 + `probeWorkdir` 本机 stat;cli 与宿主同机,预检可完整)先行把关,**明显非法名称 / 路径不弹确认门**、直接以校验错误回灌让模型向用户澄清(不让用户拍板一个注定失败的动作;服务层保持最终权威、落盘前复检);①确认门——经 `SelectionService` 承载(与 `/stop`、Rubric 契约确认同一纪律:**不新造确认面板**;领域确认适配 SelectionService 的现成先例即 `advancement-contract-selection.ts`,照此模式写适配器),标题与正文由共享确认内容构造器产出(§8:规范化后的场景名 + `normalizeWorkdir` 规范化后的目录全路径 + 存在性提示——assist 门自己控制流程,且 cli 与宿主同机,门前本地 stat 事实成立,这是全链路唯一能在拍板前呈现存在性提示的面),选项[创建 / 取消];②确认后调 `facade.create` 并返回真实结果(含 `workdirWarning`),取消则返回"用户取消了本次创建"回灌。**确认门是"关系层动作必须用户拍板"不变量在此入口的落点**——模型自主调工具(需求原文),执行前用户拍板(不变量),与主模式 change_approve 的 confirm 姿态同构,授权口径全系统一致。服务层校验错误(相对路径等)作为工具错误回灌,LLM 据此向用户澄清——校验驱动澄清,零额外机制。
- 交互宿主:整个 assist 流(自由文本输入 / 进度行 / 澄清问答 / SelectionService 确认门)的 owner 是 repl 交互层——自由文本沿 `/work` 面板 inline 编辑的既有 suspend-typeahead 机制(`repl.ts:1377` 先例),确认门走 SelectionService。循环层(tool-loop 场景规格)与交互层解耦:`run` 收注入的 `confirm(proposal)` 回调,不直接触摸 TUI。
- **交互契约(状态机,防口味漂移)**:assist 期间 typeahead 面板 suspend,结束后恢复。Esc 三阶段语义——输入中 = 退出 assist 回面板;循环运行中 = abort 循环(signal,tool-loop 轮边界放弃)回输入态;确认门 = 取消(回灌模型,模型收尾后可继续对话或结束)。创建成功 → 面板刷新并**预选中新场景**(Enter 即进入);降级到固定输入流程时**预填用户首句**(已说的话不让用户重打),并给一行可见降级提示。
- `parseFinal` 三态 + 护栏:`{ kind: "created" }`(闭包校验本循环确实发生过成功的 create 工具调用,防编造"已创建")/ `{ kind: "ask", question }`(澄清,交面板展示并等待用户下一句,下一句连同既往交换重入新一轮循环)/ `{ kind: "cancelled" }`。`maxRounds` 初值 5(一轮决策 + 一次工具 + 收尾,余量给自愈)。
- **单次创建锁**:create 是副作用工具——场景层闭包在**首次成功创建后锁定结果**,同一 assist 会话内后续 create 调用不再弹门、不再执行,直接幂等回灌"已创建「X」";`parseFinal` 的 created 绑定该唯一结果。goal 注明本次会话只创建一个场景(Ctrl+N 语境即单场景;要建多个走主模式对话)。
- 进度:`onProgress` 翻译为面板状态行("正在理解…"/"正在创建…")。
- **降级路径**:`error`(llmComplete 不可用 / 抛错)或 `exhausted` → 回落到现有固定 name 输入流程(即现 Ctrl+N 行为),带一行可见提示——与推进准入"LLM 不可用即保守兜底、不阻塞用户"同一纪律。固定流程从主路径降为 fallback,不是第二套并存主路径。
- 延迟姿态:简单输入("写作")也走一轮 LLM(约一两秒,有进度反馈);创建是低频动作,不预建短输入快速通道,实测不可接受再校准。
- 创建成功后面板刷新并选中新场景,Enter 即可进入——创建到进入一步之遥。

### 6. RPC / facade / 面板变更清单

- RPC 新增 `workscene.setWorkdir { sceneId, workdir: string | null }`——**参数语义封死**:`workdir` 显式 `null` = 解绑、非空 string = 绑定 / 更换、**缺参 = invalidParams**(与工具层 clear_workdir 防误解绑同一逻辑,RPC 层同样不许缺参歧义);形状校验后直达服务。
- `workscene.create` 的 `isAbsolute` 校验移除(服务层已管);**响应形状变更**:create / setWorkdir 返回 `WorksceneWriteResult`(scene + `workdirWarning?`)——wire 类型(session-wire.ts)、facade 返回值、面板与工具消费随之调整,项目未发布无兼容义务,一次改齐。
- `workscene.delete` 内联守卫删除(服务层已管),BUSY 语义经 `WorksceneBusyError` 映射保持不变。
- `workscene.enter` handler 变薄:touch / addObserver 编排收进服务的 `enterScene`(原子链段,§3 步 0;真实进入默认 touch),handler 只剩调用服务 + 推进恢复 + 状态加载;wire 响应形状不变。**链外段 best-effort**:推进恢复 / 状态加载失败只记日志、不使 enter 失败——否则 enterScene 已登记的 observer 因 cli 不切指针而泄漏,场景被"幽灵 in-use"锁到连接断开;恢复本有三个触发点(启动扫描 / resume / 下次 turn),丢这一次无害。
- `RpcWorksceneFacade` 复用既有 `rename(sceneId, name)`,新增 `setWorkdir(sceneId, workdir: string | null)`——消费者 = CLI 接入面的场景内改目录编排与 `/work` / 主模式薄壳。注:`setWorkdir` 若无该消费者本不应加(cli 侧原无其它调用面,加了即死代码)——方法随真实消费者进入,YAGNI 论证留痕;channel/飞书不在本需求内消费该 facade 或 `PostTurnControlIntent`。
- **接入面后置控制线收窄**:RPC/CLI 沿用定向通知,wire 字段统一使用 `session.postTurnControlIntent`,payload 为 `{ intent, conflict? }`;CLI `ConversationController` 的 `TurnOutcome` 字段同步为 `postTurnControl?: { intent, conflict? }`,pending map 存完整 payload,不得只存 intent。该字段是未来其它接入面复用的协议边界,但本期只实现 CLI 消费;未声明 `postTurnControl` capability 的接入面必须被工具能力门挡在 emit 前。channel/飞书的 binding、队列、observer 与恢复语义整体留给 unified-core 多接入面阶段,不得在本模块预建半套地基。
- **面板不加 workdir 编辑表单(产品设计)**:创建后绑定 / 更换 / 解绑目录的用户入口 = 自然语言——主模式("把 X 场景目录换成 D:\...")→ `change_approve set_workdir/clear_workdir`,或**在该场景内**直接说 → `set_workdir_current/clear_workdir_current`(§4)。两条对话入口已覆盖全部管理动作;给面板加固定表单等于把刚从 Ctrl+N 拆掉的死表单换个位置重建,对话即知行的第一入口,面板是浏览与快捷动作面。Ctrl+R(改名)保留——机械性单字段动作,表单是恰当形态。

### 7. 冗余清理清单

- 删除:`cli/src/runtime/work-mode-controller.ts`(`IWorkModeController`)、serve 内联 controller 实现(`command.ts:385-397`)、RPC delete 内联守卫、RPC create 的 isAbsolute 业务校验、面板固定创建主路径(降为 fallback)。
- 全部现存能力核查过消费者:registry 六方法、目录七方法、RPC 六方法、四个模型工具均有活跃调用面,无"用不到"的死方法;不引入 `archived/setArchived` 等归档能力。

### 8. 安全与确认边界

| 入口                  | 授权姿态                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型工具(main / 场景) | boundaries 声明 → OperationClassifier → confirm,用户拍板后执行(现状不变,新 action / 新工具同姿态)                                                               |
| Ctrl+N 智能创建       | 用户主动唤起 + 创建动作过面板确认门(Enter 拍板);循环不经 SecurityPipeline——其唯一工具就是确认门包裹的 create,授权由门保证,与 /work 固定命令"用户意图即授权"同源 |
| RPC 方法              | 已认证连接;业务规则在服务层统一生效                                                                                                                               |

workdir 是 power runtime 的文件操作根与 PathGuard 边界——校验下沉的安全意义即 D2 关闭:任何入口(含模型路径)都无法再把未经校验的路径写成场景文件根。

**共享确认内容构造器(口径单源,防两套授权语义)**:core/workscene 提供纯函数 `buildWorksceneChangeSummary(change, opts?)`——动作全集从 `WORKSCENE_MANAGEMENT_TOOLS` 派生,覆盖 add / remove / rename / set_workdir / clear_workdir / rename_current / set_workdir_current / clear_workdir_current;产出动作友好名(含 clear_workdir / clear_workdir_current 的"解除目录绑定"文案)、稳定目标标识、**涉及目录时给出规范化后完整不截断的目录路径**(经同包 `normalizeWorkdir`),`opts` 可携带存在性提示。目标标识规则:创建动作展示规范化后的新名称;current 工具用闭包 scene 上下文展示当前 scene.name + sceneId;主模式 `workscene_change_approve` 对已有场景动作展示 sceneId 稳定锚,不信任 LLM 输入的 sceneName,也不引入异步 resolver 只为展示 name。两个确认面共同消费:`buildDisplayBody` 的 workscene 分支(SecurityPipeline 管线,generic summary,**不带存在性提示**——构造时点在执行前,§3/§4)与智能创建确认门(SelectionService,**带存在性提示**——门前本地 stat;若目录不存在,文案说明"下次进入将自动创建")。用户拍板的名称 / 目录展示值必须与最终落盘值同源规范化,不得确认 A、落盘 B。**选项姿态现已同族**:管线面经 `requiresExplicitConfirmation` 强制进 broker 且仅 allow-once + deny-with-reason(管家放行 / 规则匹配 / 信任沉淀三路径全封),assist 门仅[创建 / 取消]——两面都是单次拍板、零规则沉淀。取消语义对齐:管线 deny-with-reason 与 assist 取消文本都以结构化拒绝回灌模型,模型侧行为一致。

### 9. 测试与验收

- **core**:`setWorkdir` 持久化(含 null 删字段)/ 并发(per-id 锁)/ 不存在抛错;**index 成员权威**——`get / rename / touch / setWorkdir` 对 orphan meta 一律 not-found / throw,orphan 只参与 slug 避让;**remove×add 同 slug 并发**——remove 进行中同名 add 得 `-2` 且不继承旧 `me/conversations`,remove 完成后同名 add 复用原 id;另以人工构造残窗断言"若复用同 id,新 writeMeta 必排在 rm 后"兜住 FIFO 语义,无"index 有条目、目录已删"幽灵态;**孤儿目录避让**——物理存在即 slug 避让、新场景不继承旧 me/conversations;**线性化语义**——直接 id 操作先于 index 摘除成功 / 后于 index 摘除不存在;`normalizeSceneName` / `normalizeWorkdir` / `probeWorkdir` / `WORKSCENE_MANAGEMENT_TOOLS` / `buildWorksceneChangeSummary` 内容断言(空白名拒绝、`probeWorkdir` 五态分类与 ENOENT-only 软提示、缺失目录提示含"下次进入将自动创建"、确认面名称规范化、current 动作展示闭包 sceneName + sceneId、主模式已有场景动作展示 sceneId 稳定锚、单源表动作全集友好名齐、规范化路径不截断、带 / 不带存在性提示两形态);`requiresExplicitConfirmation` 命中时 `buildConfirmationOptions` 仅出 allow-once + deny(与 bypassImmune 收缩分支同断言族)。
- **server + serve**:服务层——名称 trim 后非空校验;workdir 硬校验(相对 / 空 / **存在但非目录 / 不可访问 / stat 异常**拒绝)、规范化(落盘与展示同形)、存在性 warning 非阻塞且文案说明下次进入自动创建、解绑回无目录态、not-found null/false;`rename` 直接名称校验 + 注册表写入,不走 quiesce、不释放 runtime、不触发重进;**quiescePrefix 原语(manager 单元)**——闸五点拦截(`getOrCreate` 含 fast-path / `getOrCreateExisting` / `admitTurn` 含快路径 / **公开 `enqueue`**(返回 `"busy"` 且接入面映射为 BUSY 提示,不得混成 full / 创建失败)/ observer 注册含 `addObserver(allowInactive)`:"全部释放成功后、落盘前 observer 不能滑入"专项,subscribe 闸内得 false/BUSY)、**同前缀并发 quiesce → 第二个直接 BUSY**(防御性语义,不排队——服务链已保证正常不发生)、前缀 in-use 并集(ManagedSession busy / creating / ConversationManager pending / observers 各自单独触发 BUSY;**无会话但被观察的对话同样阻断**)、**creating 专项**(mock 慢 factory / loadHistory / runtime 装配,断言 quiesce 直接 BUSY,不会在旧属性 runtime 创建在途时落盘)、**deferred dispose 专项**(mock 慢 dispose,断言 quiesce resolve 严格晚于全部 dispose resolve)、任一失败自动关闸 + BUSY、成功后闸持有至 disposer、disposer 后拦截解除;**服务层调用序**——setWorkdir/remove 为 quiesce → 落盘 → dispose(mock manager 断言;落盘失败路径"会话已释放 + 注册表未写"状态自洽),rename 为 registry 轻量写;**闸×链集成**(remove / setWorkdir 静默期间 enter 在链上等待、无死锁、闸在链段内恒释放);enter 链外段失败不泄漏 observer(恢复抛错 → enter 仍成功);**场景操作链**——enter 与 remove/setWorkdir 同链串行(enter 在变更期间等待、变更后得到 notFound / 新目录,`repo.create` 不落在 rm 之后);rename 不进运行态链,只依赖注册表 per-id 锁与 remove 形成合法线性化;**enter 原子性(并发不变量,验收级)**——enter 与 remove/setWorkdir 交错只允许两种结果:enter 先完成(observer 在链段内登记)⇒ 变更 BUSY;变更先完成 ⇒ enter 得 notFound / 新目录;**绝不返回已删除场景或旧 workdir 活实例**;RPC 方法薄壳(守卫 / 校验行为经服务生效,`workscene-methods.test.ts` 迁移断言位置;setWorkdir 缺参 invalidParams / null 解绑)。
- **cli 工具 / 接入面控制**:mock 服务断言五动作(含 set_workdir / clear_workdir)直达服务、缺参 set_workdir 报错不解绑、`workscene_list` 只读返回含 workdir 元数据(无确认)、`workscene_rename_current` 确认 + 直接调用服务 rename(闭包限自身 sceneId;只声明 `filesystem.write`,不 emit 后置控制意图)、`workscene_set_workdir_current` / `workscene_clear_workdir_current` 确认 + 能力门 + emit set_workdir(闭包限自身 sceneId、不直接改活 runtime;双边界 `agent-context.switch`+`filesystem.write` 声明)、**接入面能力门**(当前 turn 所属接入面声明 `postTurnControl` capability 且实现 consumer 才可 emit;channel/飞书或任何无 capability 的 turnOrigin 返回 isError"当前接入面暂不支持",不 emit、不落盘、不承诺本轮后切换;enter / exit / set_workdir 三类 `postTurnControlKind` 同源覆盖;不得以 channel 名硬编码白名单)、**意图收敛语义**(同 kind 重复 emit → last-wins;异 kind 同 turn → accumulator 记录 conflict、最后意图生效、接入面提示,不得设计 emit 处拒绝;rename 不进该单槽)、`PostTurnControlIntent` 命名替换完整且只覆盖 enter / exit / set_workdir、CLI `TurnOutcome.postTurnControl` 保留 `{ intent, conflict? }`、CLI 控制消费者覆盖 enter / exit / set_workdir、boundaries 声明不变、全族 `requiresExplicitConfirmation` 从 `WORKSCENE_MANAGEMENT_TOOLS` 派生、`confirmationDisplayContext` 让 current 工具确认面展示当前 sceneId/sceneName、`workscene_change_approve` 对已有场景动作展示 sceneId 稳定锚且不引入异步 resolver、校验错误转 isError 文本;workscene DisplayBody 走 generic + 共享构造器,三投影(本地 TTY / 远程文本 / RPC bridge)无二次截断各有断言(**含多行 / 长路径宽度**——TTY 面板受 chrome 行宽硬合约约束,长 Windows 路径单行必超宽,渲染须换行安全);解绑后下次装配无文件工具(powerProfile 二分)。
- **强制拍板(orchestrator)**:`requiresExplicitConfirmation` 四生效点各有断言——已匹配 allow 规则仍进 broker(E1)、`consultSteward` 不被调用(E2)、零 `maybePersistTrust` 且**两个调用点各自断言**(管家 safe 路径 :264 / broker allow-once 路径 :684——反复 allow-once 不产生规则、/trust 无新条目)(E3)、选项收缩(E4,core 侧已覆盖);deny / block 规则仍生效(只收紧不放宽)。
- **智能创建**:mock complete 驱动——澄清往返、**本地预检**(非法名称 / 路径不弹确认门、校验错误回灌澄清)、create 工具确认门(确认 / 取消两分支,门面含规范化名称与存在性提示)、**单次创建锁**(首次成功后再调 create 不执行不弹门、幂等回灌)、parseFinal 防编造 reject 自愈、error/exhausted 降级到固定流程(预填首句);Esc 三阶段语义、成功后面板预选中。
- **提示词契约**:`WORKING_MODE_TEXT` 新文案(主模式动作枚举、`workscene_list`、workdir 可选表述)/ Environment 分支措辞的 byte-equal 基线更新与工具面切换同步;powerProfile 场景内改名、改目录、解绑目录指引的 byte-equal 更新与场景专属工具同步;main 装配含 Working Mode 段、power / 子 agent / serve 无该段的既有渲染谓词不回归。
- **端到端(实施后 `pnpm build` 全量 + `pnpm cli` 自跑视觉)**:主模式自然语言创建带目录场景 → confirm → 进入验证文件根;创建后补绑 / 更换目录(含场景空闲时立即生效、场景忙碌时 BUSY 提示、目录不存在时提示下次进入自动创建并在进入后验证创建);**对话式解绑(clear_workdir)→ 下次进入无文件工具**;**场景内改名**(场景中让模型修改当前场景名称 → confirm → 直接写入登记信息,不退出 / 不重进当前 runtime;当前横幅可保持旧名,下次 list / enter / 窗口换代后的 profile 使用新名);**场景内改目录**(场景中让模型换目录 → confirm → turn 结束自动"退出并按新目录重进" → 新文件根生效;另一接入面在场 → BUSY 告知不换);**非 CLI 接入面能力门**(channel/飞书未声明 `postTurnControl` capability 前,发起场景切换或场景内改目录请求返回暂不支持,不出现"本轮后切换"假承诺);Ctrl+N 大白话创建(名称 + 目录、澄清、取消、降级);退出场景后立即删除成功(grace 窗口不再阻塞);主模式模型能主动提出并执行 set_workdir、能经 workscene_list 回答场景绑定目录(prompt 契约生效面验证)。

### 10. 暂不做与留口

- **实施注记(跨文档同步)**:tool-loop 的"可信、**通常只读**"契约必须补充副作用工具接入条件——**文档与源码两处声明面都要同步**:①`lightweight-tool-loop.md` 〇.1 原地补"副作用工具接入条件"(场景层必须提供:执行前用户确认、单次性 / 幂等锁、取消语义);②源码 `core/src/tool-loop/types.ts` 的 `ToolLoopTool` 注释("可信只读件"类表述)同步修订。两处同属声明面,漏改即声明面分裂。
- 目录存在性只做非阻塞提示,不做选择器等重交互;但当前 runtime 显式 workspace 会自动创建缺失目录,所以所有用户可见提示必须明示"下次进入该场景时会自动创建该目录"。
- 智能创建不设短输入快速通道、不做 token 级流式(tool-loop 留白项),实测驱动再议。
- `workscene.exit` 保持 touch-only(退出纪要挂点不动,归其自身演进)。
- 不做场景归档(archived)。
- **实施注记(跨文档同步)**:unified-core §3.4 的 enter 副作用说明需同步为:enter 原子段包含 observer 登记 + touch,语义仍无状态机、无 status。

### 11. 最终执行计划

拆分标准:先枚举架构不变量,提交边界不得切开任何不变量;一次提交必须形成可独立理解、构建、测试、回滚的终态子集,可以缺能力但不得存在半升级语义或需要靠后续提交修复的中间债务。

| 提交 | 边界                                | 目标                                                                                                                                                                                    | 验收                                                                                                                                 |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | core 持久化原语                     | 补`IWorkSceneRegistry.setWorkdir(null)`;index 成员权威;remove 锁语义;orphan / 物理目录避让;`normalizeSceneName`、`normalizeWorkdir`、`probeWorkdir`                             | core 单测覆盖 setWorkdir、并发、orphan、slug 避让、五态探测                                                                          |
| 2    | 强制逐次拍板机制                    | 新增通用`ToolDefinition.requiresExplicitConfirmation`;secure-executor 四生效点:强制 broker、跳过 steward、零沉淀、选项收缩                                                            | orchestrator / core 测试覆盖 allow 规则、steward 不调用、两处`maybePersistTrust` 不沉淀、选项收缩                                  |
| 3    | ConversationManager 原子静默        | 新增`quiescePrefix(prefix)`;覆盖 sessions / creating / pendingQueues / observers 四态;`enqueue` 扩 `"busy"`;先以 manager 单元完整验证                                             | manager 单测覆盖闸、creating、observer、pending、dispose、同前缀重入 BUSY                                                            |
| 4    | WorksceneDirectory 领域服务完整闭环 | 服务层一次性收拢`create / rename / setWorkdir / remove / enterScene`;`enter / setWorkdir / remove` 同链串行;set/remove 走 `quiescePrefix`;RPC create/delete/enter/setWorkdir 变薄 | server / serve / RPC 测试证明所有入口同一规则;enter/remove/setWorkdir 交错不返回已删除场景、不产生旧 workdir 活实例、不泄漏 observer |
| 5    | 工具声明单一真相源                  | 建`WORKSCENE_MANAGEMENT_TOOLS`,驱动动作集、boundaries、确认声明、DisplayBody 键集、summary 构造;覆盖 workscene 管理工具族                                                             | 表派生测试;确认面完整路径不截断;`requiresExplicitConfirmation` 声明者集合从表派生                                                  |
| 6    | 主模式管理工具扩展                  | `workscene_change_approve` 增 `set_workdir / clear_workdir`;新增 `workscene_list`;工具改依赖领域服务;删除 `IWorkModeController`;同步主模式 prompt                               | CLI 工具测试、prompt byte-equal、controller 无消费者、主模式可查 workdir 元数据                                                      |
| 7    | post-turn 控制契约与能力门          | `PostTurnControlIntent` 替换旧 mode switch 语义;enter/exit 走声明式 `postTurnControl` capability;CLI 为当前唯一 consumer;非 CLI 阻断                                                | CLI turn outcome 测试、能力门测试、channel/飞书无 capability 时不 emit、不假承诺                                                     |
| 8    | Ctrl+N 智能创建体                   | 新增`workscene-create-assist`;复用 `runToolLoop + llmComplete("main")`;本地预检、确认门、单次创建锁、降级 fallback;同步 tool-loop 副作用工具契约                                    | 智能创建单测 + 面板交互测试:澄清、确认、取消、降级、成功后预选                                                                       |
| 9    | 场景内属性工具与 CLI 重进           | 新增`rename_current / set_workdir_current / clear_workdir_current`;rename 轻量写;workdir 经 post-turn CLI 释放重进;同步 powerProfile;补端到端验收                                     | 场景内改名不重进;改目录 turn 后重进;解绑后无文件工具;非 CLI 能力门生效                                                               |

执行顺序不可重排为会产生中间债务的形态:`enter / setWorkdir / remove` 必须在同一领域服务闭环中进入同一场景操作链;`postTurnControlKind` 暴露场景内改目录能力之前必须已有声明式能力门与 CLI consumer;prompt 不得先于真实工具能力宣传不存在的动作。
