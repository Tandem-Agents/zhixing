# CLI 命令系统

命令的声明、展示与执行必须对应同一个命令集合；补全只是入口增强，不能决定业务是否存在。本文说明 REPL slash 命令机制及其宿主接入，不定义全部产品 API 或启动命令，也不声称其他渠道已经接入同一 slash 命令层。

## 总体架构

```text
按域注册函数 ── 声明 → CommandRegistry ← 动态技能命令源
      └────── handler → CommandDispatcher
                           ↑
补全输入 / legacy 输入 ── 统一分派
                           ↓
            CLI 展示与接入编排 → 领域 client / RPC facade → 宿主产品能力

CommandRegistry.list(ctx) → /help 与命令补全
```

注册表、分派器和类型位于 `core/typeahead`，不依赖 readline、终端渲染或 CLI 包。CLI 负责装配自己的命令与交互依赖；UI 无关的机制不等于业务必须直接实现在 core 包，也不等于必须为未来渠道预建一套命令平台。

具体业务由当前宿主及所属领域负责。例如，任务列表更新经过 conversation facade，工作场景操作经过 workscene facade，信任撤销经过 management facade，技能命令来源于 Skill 领域 client。CLI 保留输入、展示与接入协调，不持有第二套业务写入权威。

## 唯一声明与统一执行

- 每次 REPL 装配一个 `DefaultCommandRegistry` 与一个 `CommandDispatcher`。命令层无条件构建；只有候选与终端输入增强受终端能力和补全开关影响。无补全时仍经过同一 dispatcher。
- info、session、mode、config、task、skills 等注册函数在同一处登记定义并绑定需要的 handler，避免静态清单和执行字典分散维护。`agent` 类命令不需要本地 handler。这里的“成对注册”是组织约束，不是两个 API 调用具有事务回滚保证。
- `CommandDef` 保存名称、稳定 ID、别名、类别、参数与可见性等声明；执行闭包独立保存在 dispatcher 的 handler Map，避免把终端副作用嵌入声明。**当前定义仍可包含 visibility predicate 与异步参数 Provider，不能把整个对象称为可直接序列化的跨进程协议。**
- `/help` 和补全从 `registry.list(ctx)` 派生，分类展示不另建命令清单。`hidden` 不进入列表，但精确名称可查找；可见性过滤不是执行授权，需终端交互的命令还必须在 handler 入口检查终端能力并给出明确提示。
- registry 检查 ID 冲突，不负责证明所有命令语义正确。dispatcher 对未知名称、缺 handler 与 handler 异常分别返回结构化结果，由输入接入层呈现错误，不把失败命令交给模型猜测执行。

### 执行归属

| 类型 | 分派语义 |
|---|---|
| local | 调用 handler，dispatcher 不额外发起 Agent 对话轮次 |
| agent | 不调用本地 handler，将命令文本交给对话入口；动态技能命令使用此类 |
| hybrid | 先等待 handler，再返回供上层送入对话的说明；当前没有生产命令使用 |

`local` 描述的是分派方式，不是“业务只在本机运行”或“内部绝不调用模型”。查询事实应由真实业务结果展示，不能为了让模型复述状态而转成 hybrid，否则会诱导模型编造它未感知的运行状态。只有已发生的变化确实需要模型知晓、无法从现有对话获知且通知有明确价值时，hybrid 才有理由使用；不因类型存在而新增场景。

结构化参数为补全、提示和 handler 取参提供共同描述，但当前 dispatcher 不做通用 schema 完整校验，具体业务合法性与安全检查仍由 handler 和宿主负责。补全填值成功不能作为业务验证成功的证明。

## 动态来源与运行时变化

静态命令由代码注册，动态技能命令由 `SkillCommandSource` 投影；两者汇入同一 registry。技能事实通知触发重新查询目录与刷新命令，不另外维护 CLI 技能事实源。动态源刷新失败时保留其上次成功缓存，其他源仍可刷新；移除来源同时清理其命令。

运行时上下文必须在使用时取当前值，不捕获会随会话切换或宿主换代失效的对象快照。当前接入通过 controller、领域 client、facade 与 getter 读取活动会话、模式和 workspace；配置生效涉及宿主换代、重连、刷新本地投影及重挂 observer，而非旧设计中的 CLI 内存 RuntimeSession 原地替换。

候选列表的删除、改名和新建只是业务的交互触发方式，不是独立业务实现。CLI 将操作交给宿主，并处理结果与本地显示；通用候选层只声明能力和维护交互状态，详见[输入补全](input-completion.md)。

首位中文顿号 `、` 可作为 `/` 的输入别名：显示保留原输入，解析使用规范形式；提交阶段同时检查原始草稿与展开文本，避免粘贴内容展开后误变成命令。它是输入规范化，不是另一套注册或执行通道。

## 设计取舍

早期曾有理想化 builtin 清单、CLI 静态元数据/handler 字典与动态注册三份来源，补全和 legacy 又分走两套执行路径，导致“列表看得见但执行不到”或“真实命令不出现在帮助中”。只修帮助列表不能解决这类问题：必须统一声明、消费和执行，再清退旧清单与桥接。

把 dispatcher 留在 CLI 会令其他接入方复用时反向依赖 UI 包；因此通用机制留在 core，实际业务与交互依赖由装配方注入。反过来，把 handler 塞进声明对象也不能获得真正解耦。稳定边界是机制、声明、交互和领域责任分开。

降级应当只减少交互便利，不减少原本可用的命令能力；终端本来不能承载的编辑器则明确拒绝，不能静默无动作。为将来可复用保持正确依赖方向即可，不提前实现渠道 slash 命令、文件命令目录或插件平台。旧文件命令设想中的“声明不直接指向可执行 JS”也不应被误读成当前已提供脚本加载入口。

## 维护依据

直接实现：[注册表](../../../packages/core/src/typeahead/registry.ts)、[分派器](../../../packages/core/src/typeahead/command-dispatcher.ts)、[REPL](../../../packages/cli/src/repl.ts)、[命令注册](../../../packages/cli/src/commands)、[候选删除接入](../../../packages/cli/src/runtime/candidate-delete-controller.ts)。

维护时同时核对声明、帮助、补全、非补全执行、动态刷新、手打隐藏/不可用命令及宿主换代后的依赖。验证应能识别缺 handler、错读旧状态与绕过宿主的第二业务链，不能只验证命令名称列表。
