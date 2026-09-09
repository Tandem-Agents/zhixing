# 工作场景管理

本文定义工作场景管理的能力边界、确认与生效时机、工作空间管理和智能创建。场景身份、会话与生命周期的总体关系见[工作场景架构](architecture.md)。

## 需求起点与保留的取舍

原始需求的核心是：模型工具与 `/work` 不应维护两套业务；应基于共同的原子管理能力，按使用场景作薄封装。创建后能够补绑、更换或解除目录，删除场景不能动用户目录。主模式管理全部场景，场景模式只管理自身相关属性。

`/work` 的 Ctrl+N 应理解用户自然表达，而不是把输入硬接为固定名称字段：使用 Main 档位、临时且非持久化的模型调用，只给必要上下文与工具；信息不足时澄清，执行经确认的真实创建。这里保留的是用户的需求含义，不沿用原始背景中的旧记忆、旧注册表接口或当时的功能缺口作为现状。

保留模型工具和界面方法这两种入口有价值：前者供智能决策，后者服务确定性交互；应消除的是重复业务与绕过权威的写入，不是消灭入口差异。面板负责浏览和快捷操作，对话负责灵活管理，不为每个能力再建一套表单。

## 能力与授权

| 使用场景 | 能力 |
|---|---|
| 主模式模型 | `workscene_list`、`workscene_change_approve`（add/remove/rename/set_workdir/clear_workdir）、`workmode_enter` |
| 场景模型 | `workmode_exit`、`workscene_rename_current`、`workscene_set_workdir_current`、`workscene_clear_workdir_current` |
| 管理接入面 | list/create/rename/setWorkdir/delete/enter/exit，通过 Product API 对应领域操作；RPC 名保留 `setWorkdir`，实际传设备工作空间引用 |

模型的写入与进入、退出都要求逐次显式确认；只读列表不需要。`WORKSCENE_MANAGEMENT_TOOLS` 统一声明动作、边界、确认姿态与适用表面。全局许可、trust 或 steward 自动放行不能替代这些工具的用户拍板，也不从此类确认自动建立长期信任。

主模式不等于免确认，场景模式也不能通过自填 sceneId 修改别的场景。当前场景身份由工具闭包注入且不向模型暴露为可任意填写的参数。工具展示与真正执行必须指向同一动作和目标；名称、设备与工作空间信息来自可核实的输入和目录，不让模型凭空声称授权或成功。

## 两种写入上下文，一个权威结果

**运行内工具**经确认、校验与设备工作空间选择后，由 `WorksceneAssignmentToolApplicationService` 写 assignment overlay，携带操作标识及必要 revision。工具只返回“已记录，本轮成功完成后生效”，不能声称已应用。读操作可折叠当前 overlay，但新建项在 applied 前不作为已存在场景继续依赖。

owner 提交固化唯一 `WorksceneAppliedResult`，随后 publish 链幂等物化与反馈。取消、失败、uncertain 或冲突不允许回到直接改登记文件或管理 post-turn 写入的旧路径。当前场景改名和工作空间变更同样遵守这条链，不因“只改自身”提前生效。

**运行外 CLI/RPC 管理**经领域应用走 control，使用请求标识、权威 revision、重放与清理机制。界面不能直接调用持久化 Registry。两条路径因提交上下文不同而有不同适配，但不拥有两个场景事实源。

enter/exit 是切换控制，不是登记写入工具的替代通道。当前 CLI 仍有 `set_workdir` 控制消费分支及重进失败处理；它不构成 assignment 管理工具的生产写入路径，不能据此把当前工具说明写回“先 emit，后落盘”。配置生效与接入面的会话切换必须分开说明。

提示词、工具声明与实际能力必须同步：主模式和场景 profile 对可用动作、确认及生效时机的说明，不得领先或滞后于生产路径；更新仍须遵守窗口内系统前缀稳定的边界。当前 [powerProfile](../../../packages/orchestrator/src/profile/default-profiles.ts)仍描述工作空间变更通过本轮后重新进入场景生效，而[当前场景工具](../../../packages/cli/src/serve/workmode-tools.ts)只暂存 assignment 变更，不发出重进意图。该提示词与工具路径的差异尚未消除，不能据提示词宣称自动重进已成立，也不能据旧消费分支恢复管理写入旁路。

## 工作空间与数据安全

- 工作空间可选。设置需要明确引用，解除使用显式 clear 动作或 `null`，缺参不能解释为解绑。
- 领域保存 `{deviceId, bindingRef}`，工具从授权目录选择设备与工作空间；原始路径只由对应设备的管理边界处理。CLI 智能创建可接收本地绝对路径，再经设备绑定管理转为引用，不把路径当作跨设备身份传播。
- 路径预检区分目录、缺失、非目录、不可访问及其他错误。缺失目录可提示并在准备执行环境时创建；非目录和权限错误不能冒充“尚不存在”。本地预检不能替代目标设备与服务端最终校验。
- 换绑定和删除需满足场景可安全变更条件，返回真实 busy、输入错误或不存在结果；不得为完成 UI 操作偷偷中止其他会话或删除用户目录。改名是轻量属性变更，不承担换根操作。
- 删除作用于场景系统数据及其会话清理；用户项目文件不是删除目标。权威删除及投影清理可恢复、可重放，不能用物理目录是否存在代替提交事实。

## CLI 管理与智能创建

`/work` 是场景浏览和进入入口，面板保留 Ctrl+N 创建、Ctrl+R 改名、Ctrl+D 删除。旧 `/enter`、旧子命令和 archive 概念不再作为另一套管理入口。候选交互与 Esc 分层由[输入补全](../cli/input-completion.md)负责。

Ctrl+N 调用 `runWorksceneCreateAssist`：

1. 注入现有场景列表和单次创建目标，使用 main 角色的文本调用驱动 `runToolLoop`；不是常驻 Agent，也不写入普通会话历史。
2. 模型可提取名称与可选目录，必要时问用户；只暴露创建工具，不带无关能力。工具先预检，再通过既有 SelectionService 确认，之后调用管理 facade。取消不能被当作已创建。
3. 首次真实创建成功后锁定结果，重复工具调用不再创建或再次确认；最终 `created` 必须绑定真实调用结果，防止模型编造成功。
4. 有限轮数与澄清次数控制交互。模型失败或耗尽时降级到名称输入，带可见原因并保留首句，不让用户重新表达；固定输入只是兜底，不是并行主路径。
5. 创建成功刷新并选中新场景，由用户进入。模型循环期间的输入、取消、进度与确认由 REPL 交互层管理，循环规格通过回调取得能力，不直接操作 TUI。

交互需区分退出输入、取消循环与取消确认，不能把三者当成创建成功；恢复 typeahead 与清理交互资源不能依赖模型配合。创建后绑定、更换或解除工作空间通过管理能力完成，不恢复“只能创建时指定，之后必须重建场景”的限制。

## 维护核对点

修改本模块时直接核对：各入口是否同属领域合同；确认是否仍不可自动绕过；工具 receipt 与 applied 是否区分；失败和重放是否保留唯一结果；场景身份、observer、在途运行及 workspace revision 是否一致；无绑定和远程解析失败是否仍无 cwd 回退；智能创建是否能澄清、取消、降级并防重复；删除是否不触碰用户工作目录。

这些是现有行为的保护边界，不要求为了文档新增测试框架、归档功能或未来管理平台。

## 实现入口

- [管理工具声明](../../../packages/core/src/workscene/management-tools.ts)
- [领域应用](../../../packages/core/src/workscene/application.ts)与[assignment 适配](../../../packages/cli/src/serve/workscene-application-adapter.ts)
- [模型工具](../../../packages/cli/src/serve/workmode-tools.ts)
- [权威适配](../../../packages/cli/src/serve/workscene-authority-projection.ts)
- [CLI facade](../../../packages/cli/src/runtime/rpc-workscene-facade.ts)与[智能创建](../../../packages/cli/src/runtime/workscene-create-assist.ts)
