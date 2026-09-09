# 工作场景架构

工作场景把一类持续性工作组织为可复用的工作上下文。它是知行内部的工作身份与会话边界，不是另一个产品、子 Agent 委派，也不是把主对话原地换成另一模型。管理操作与智能创建见[工作场景管理](management.md)。

## 产品与设计依据

用户始终在与知行协作：主模式承担日常交流与通用工作，进入具体场景后以该场景的上下文和 power 角色继续交互，退出后回到主模式。main、power 是配置角色，不保证某个厂商或固定模型强弱；辅助调用使用各自的角色合同，不随场景一律升级为 power。

场景的粒度、组织方式和生命周期由用户决定。模型可以理解工作、提出切换建议，但不能用固定任务分类器代替判断，也不能越过用户对管理与切换的授权。明确的用户意图优先；模糊请求可以先理解再澄清，不要求每次都先试做或强制进入场景。

稳定身份、独立上下文与明确权限负责正确性，模型负责判断和工作本身。不同场景不能隐式串用历史、工作目录或运行状态；上下文注入必须有界且来源清楚。切换不改写历史，也不承诺把所有场景信息自动汇入主模式。当前没有长期记忆模块，连续性由对话持久化、窗口、摘要和恢复链承担；未来记忆方案不在本模块定义。

## 三种边界不能混同

| 对象 | 职责 |
|---|---|
| 工作场景 | 稳定 sceneId、可改名称、活动事实、场景会话归属及可选工作空间引用 |
| 场景会话与运行体 | 保存该会话的历史，按场景身份装配 power profile、工具和执行环境；运行体不是场景登记的权威 |
| 设备工作空间 | 文件与命令执行的环境、安全边界；以 `{deviceId, bindingRef}` 引用，由所属设备解析实际路径 |

场景系统数据与用户工作目录分开。无工作目录的场景仍可用于对话、规划等工作；不能把“未绑定”解释为使用宿主 cwd。主模式的环境选择也不等于场景绑定，first-party 输入通过耐久的 `ExplicitEnvironmentSelection` 表达选择，不暗取其他设备路径。

工作空间可在创建后绑定、更换或解除，不需要删除重建场景。删除场景清理其系统数据，不删除用户工作目录。当前执行的环境由 ExecutionManifest 冻结，包括当次 binding revision；场景配置变更不能让正在运行的任务中途换根，revision 也不回写成场景的新身份。

## 当前责任分布

| 责任 | 当前落点 |
|---|---|
| 产品校验、有限操作与结果投影 | core 的 `workscene/application.ts`；向 Product API 贡献领域能力，运行内工具使用同领域的 assignment application |
| 场景权威、提交结果与物化 | authority registry、global-state adapter 及宿主 authority projection；不由 UI 或模型工具直接修改文件登记 |
| 场景会话身份、observer 与活动记录 | `WorksceneSessionOwner` 和 ConversationManager；场景身份在会话创建时确定，入口反查归属 |
| 串行操作与资源静止 | 宿主 `workscene-directory.ts`，协调权威机制与 session owner，不再充当全部产品规则的所有者 |
| 运行配置 | `workscene-runtime-projection.ts` 组合 main/power profile、场景身份、工具与解析后的环境，交运行时生命周期管理 |
| 接入面 | RPC 投影与 CLI facade/controller；切换自己的当前会话指针，不建立另一套场景权威 |

这保留了“一套底座、多入口”的设计意图，但不是让所有调用绕到一个万能 Directory：产品行为归领域，提交、恢复与资源机制归各自 owner，入口只做适配。

## 进入、退出与恢复

当前 `WorksceneSessionOwner.enter` 使用 `worksceneConversationId(sceneId, "primary")`，先取得 observer claim，记录权威活动并由 ConversationManager 获取或恢复运行会话。失败释放本次 claim。它不再按“模型入口一律新建、命令入口找最近对话”的旧策略运行，也不是每次进入都新建。

模型 enter/exit 工具经显式确认后只发出 turn-boundary 控制意图；未声明对应消费能力的接入面在发出前拒绝。CLI 命令与模型控制汇合到同一切换处理，运行中的 turn 不被中途更换上下文。一个 turn 的控制槽采用 last-wins；异类控制冲突会给出可见提示，不静默伪装为全部执行。

进入成功后 CLI 切到返回的场景会话，展示场景身份、可用历史尾部与推进状态；历史尾部是辅助展示，其失败不应伪装为会话丢失。退出释放相应 observer 并记录活动，返回主对话由接入面负责，不是服务器把所有客户端一起切回 main。主对话返回目标、场景历史与场景身份必须分别维护。

任务衔接与历史恢复不是同一件事。原设计要求模型触发进入时携带引发切换的用户输入，让场景知道接下来要做什么，而不复制整段主对话历史。当前 [CLI 切换处理](../../../packages/cli/src/repl.ts)只切换会话，不自动携带该输入，场景首轮由用户进入后提供。因此，场景历史恢复不能作为原任务已衔接的证明；这里保留需求并明确实现差异，不要求恢复旧的本地消息注入方案。

早期已确认工作模式也应能新建、浏览和恢复对话，不应只因处于工作场景就禁用 `/new`、`/resume`。当前命令没有旧禁用守卫，但 `ConversationController.newConversation()` 实际新建并切到 main；这与旧稿“在当前场景作用域内新建”的实现语义存在差异，不能把命令可用等同于场景内新建已实现。本次仅登记差异，不降低需求或修改功能。场景默认进入仍选择 primary 会话，不能据旧稿恢复本地 Repository 切换或 runtime overlay 方案。历史与恢复的正文由[对话持久化](../conversation/persistence.md)和[运行体生命周期](../conversation/runtime-lifecycle.md)承担。

## 生命周期与安全

进入、换工作空间和删除在场景维度协调。控制侧换工作空间与删除先经过 quiesce，不能只看一个 busy 标志：运行、排队、创建中状态与 observer 都可能使场景不可安全变更。获取的静止锁必须在成功或失败后释放，删除重放不能重复产生不同结果。

改名不改变文件根，不应为了刷新称呼而强制重启当前工作；活窗口内名称自然滞后与改目录是不同问题。目录变更按权威提交及后续运行装配生效，不抢改在途运行的路径与权限。

有绑定时只在正确 executor 解析并准备目录；解析失败明确失败，无绑定则装配无工作空间的 profile，不能降级到宿主目录。场景运行体不持有主模式的全局场景管理工具，当前场景工具的 sceneId 来自装配身份而非模型参数。

场景切换、失败与重启都必须保持权威对话事实、会话归属、权限与终态一致。退出不是自动删除场景，清理运行资源也不是删除历史；跨场景隐式记忆流、归档状态、预建插件框架均不属于当前合同。

## 实现入口

- [领域应用与 Product API](../../../packages/core/src/workscene/application.ts)
- [权威提交与物化](../../../packages/core/src/workscene/global-state-adapter.ts)
- [宿主目录机制](../../../packages/cli/src/serve/workscene-directory.ts)
- [场景会话 owner](../../../packages/cli/src/serve/workscene-session-owner.ts)
- [运行配置投影](../../../packages/cli/src/serve/workscene-runtime-projection.ts)
- [CLI 会话控制](../../../packages/cli/src/runtime/conversation-controller.ts)
