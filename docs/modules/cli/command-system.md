# CLI 命令系统

命令的声明、帮助、候选和执行必须对应同一个可用集合。补全是输入辅助，不能决定业务是否存在；未知或不可用命令应给出明确错误，不能作为普通模型输入悄悄执行。本文负责 CLI slash 命令接入，启动与管理子命令仍由 Commander 入口负责。

## 声明、接入与业务责任

静态定义来自 builtin-definitions，会话、信息、任务和技能适配补入真实命令。DefaultCommandRegistry 保存名称、稳定 ID、别名、类别、参数、可见性和候选来源；声明中的函数不是跨进程 DTO，U 只接收有限投影。

当前两种表面复用声明与业务适配，但装配不同：

| 表面 | 当前接线 |
|---|---|
| 交互终端 | N 的 TerminalCandidatesOwner 持有 registry；U 发 command 行动，TerminalApplication 查找定义、归一名称后分派至对应应用适配 |
| 文本会话 | text-session 装配 DefaultCommandRegistry 与 CommandDispatcher，注册同源定义及文本处理器 |
| 独立管理命令 | index 中的 Commander 注册行动；需要交互时由终端路由和管理端口接入 U，不回到旧 REPL |

业务由当前宿主及所属领域负责：会话操作走 ConversationController 和 conversation facade，工作场景走 workscene facade，任务更新走会话应用，信任撤销走 management facade，技能走 Skill 领域 client。CLI 只协调输入、展示、连接和结果，不拥有第二份业务写入权威。

## 帮助、接受与执行

/help 与命令候选从当前 registry 派生，不能另维护一份用户可见清单。hidden 与可见性过滤是发现规则，不是权限；业务仍须验证当前身份、参数和可用能力。别名解析到同一正式名称。

候选接受先替换草稿，再由接受结果决定是否提交。带必填参数的命令不能因接受名称就误执行；手打命令也必须经同一业务校验。ArgSchema 提供参数说明与候选，不代表通用运行时验证已代替具体应用检查。

CommandDef 的 local/agent/hybrid 描述通用分派语义，不是业务部署位置。动态技能命令沿技能来源和实际接纳链进入对话；不能仅因 registry 存在 agent 定义就推断某表面的执行分支已经接通。当前没有理由为了让模型复述查询事实而新增 hybrid：查询直接展示真实结果。

首位中文顿号“、”作为 slash 输入别名时只影响解析，显示保留用户原输入。提交判定必须基于原草稿与真实输入来源，不能把展开后的粘贴正文自动升级为命令。规范化、命令发现与业务执行的三处消费须共同验证。

## 动态来源与状态变化

[技能适配](../../../packages/cli/src/terminal/skills.ts)消费 SkillCommandSource，刷新动态命令和列表，不自建技能事实源。刷新失败、停用、归档与来源移除要有明确结果，成功后帮助、候选和执行应同步；不能只刷新其中一处。

运行时上下文在使用时读取当前 controller、client、facade 和 workspace，不能捕获会因切换或宿主换代失效的对象。配置生效涉及宿主换代、重连、投影刷新与 observer 重挂，不恢复 CLI 内存 RuntimeSession 原地替换方案。

删除、改名、新建等候选动作由[输入补全](input-completion.md)触发既有业务适配；通用候选状态不执行物理删除。删除当前对话后的新建和指针衔接仍属于会话责任。

## 取舍与验证

core/typeahead 保留 UI 无关的类型、Providers、注册表和通用 dispatcher；应用不必为了调用这些机制而依赖终端渲染。新交互应用没有装配旧 registrar 和 legacy 输入分叉；文本表面仍可使用通用 dispatcher，这两者不能在文档中混为同一实现。

降级只减少界面便利，不减少原本可用的文本命令能力；必须使用专用编辑或保密输入的操作则明确要求交互终端。保留正确依赖方向不等于预建渠道 slash 命令、文件命令目录或插件平台。

文本入口保留 `/config logs` 的查询和版本化修改；长信息正文沿共享适配器分页完整输出。自动读取仅能翻正文页，不能选择业务动作、填写输入或批准确认，也不能消费后续管道行作为答复。

文本退出码汇总本次输入的已确认失败，包括材料准备、命令执行、运行错误和连接清理；后续成功不能抹掉前面的失败。错误以结构化结果传递，不靠正文颜色或措辞判断。用户取消和轮次触限保留各自终态，不一概作为执行错误。匹配对话和轮次的执行事件已确立接纳或完成时，晚到发送回执异常不能撤销该事实或触发重发。

只有接纳证据、尚无完成结果而发送回执失败时，交互与文本表面明确说明输入已接纳、原运行可能继续、最终结果未知，并指向原对话供核对；可以有限失败退出，不把通信失败写成任务失败或取消，也不无期限等待。

实现入口：[静态声明](../../../packages/cli/src/commands/builtin-definitions.ts)、[注册表](../../../packages/core/src/typeahead/registry.ts)、[通用分派器](../../../packages/core/src/typeahead/command-dispatcher.ts)、[交互装配](../../../packages/cli/src/terminal/application.ts)、[文本装配](../../../packages/cli/src/text-session.ts)、[候选](../../../packages/cli/src/terminal/candidates.ts)、[会话](../../../packages/cli/src/terminal/session-commands.ts)、[信息](../../../packages/cli/src/terminal/information-commands.ts)、[任务](../../../packages/cli/src/terminal/tasks.ts)。

核对声明、帮助、补全、手打执行、动态技能、隐藏／不可用命令、缺参数、失败反馈及换代后的依赖；名称快照不能证明命令可执行。产品未支持的命令不得提示用户回到已退役入口。
