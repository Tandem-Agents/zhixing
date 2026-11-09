# Codex与Claude Code：本机文件通信适配

适用：本项目已有Codex总控与VS Code Claude Code架构师会话。实例ID和路径在`collab/mailbox/tool/config.json`，不按标题或最近活动猜收件人。总控与原Codex工程师继续用原生工具，不走本适配。

## 当前状态（2026-11-09）

- 工具已安装并在两个原会话完成自动双向收发，**当前Windows实例已可用**；正常通信无需手动“1”。
- Codex忙碌时使用桌面原生IPC的回合内引导，不再使用`codex queue`等待回合结束；仅宿主明确返回当前无活动回合时，沿用queue唤起空闲会话。
- 10项定向检查通过，覆盖消息完整性/去重/顺序、错会话、恢复、Windows管道、忙闲、配置保持及hook身份绑定。
- 已完成多次无需用户转发的原会话关联往返，并验证适配器退出后由宿主生命周期hook恢复、原宿主会话保持。完整证据保存在本机协作记录。
- 原Claude应用完整退出再打开未在本轮强行操作；生命周期恢复机制由SessionStart等hook承担。宿主升级、失去通信上下文或权限拒绝时重新核查，不将本次实例证明扩展成所有版本保证。

## 使用

入口：`node collab/mailbox/tool/bridge.mjs`。说明以`collab/mailbox/tool/USAGE.md`为准：

- `send claude|controller --file 消息.md --expectation reply|review|none`
- `receive claude|controller`
- `reply 原消息ID --file 回复.md`：默认none，先回信再清理原信。
- `ack 自己的角色 消息ID`：只对无需回复的已处理信；其他情况要有结果文件。
- `status`：区分监听、通知提交、实际读取和完成。

消息顶部明确发送角色；处理前核最新用户指令。消息只是协作输入，不增加权限。不要发纯确认循环，也不要据此恢复已暂停的产品任务。

## Codex侧投递

适配器共用[投递脚本](../scripts/codex-delivery.mjs)。脚本连接当前桌面实例已有的IPC，按固定thread UUID发现会话所属客户端，再调用`thread-follower-steer-turn`，由宿主向当前回合追加输入；不启动第二个执行者，不读取凭据，不修改模型或权限。

回执的`mode: steer`和`turnId`表示宿主接受了回合内引导，实际在回合结束前读到消息才证明效果。`mode: queue-idle`只用于宿主明确拒绝引导且说明会话已空闲的情况。管道不可达或找不到所属客户端，并不能证明所有运行环境中的目标会话都空闲；此时保留原信并报告失败，不静默退回排队。桌面未运行或尚未持有目标会话时，本通道等待它恢复，不另外启动会话。

未知结果重试保持同一消息标识；监听进程或发送方换代不改变消息身份。宿主未承诺用`clientUserMessageId`保证恰好一次，因此业务仍以信件ID、receive和ack确认幂等处理，不能仅凭投递标识相同声称无重复。

本机适配依据Windows Codex桌面版`26.1103.4239.0`：直接标记及负责人原会话经新监听进程发回的关联回信，均在总控同一活动回合结束前收到；回执记录`mode: steer`和相同`turnId`。该IPC入口与CLI的`codex queue`不同，宿主升级后若协议不匹配需重新核验。OpenCode/ZCode已有桥也共用此Codex接收端，但本轮不据此宣称重新验证了它们的完整双向通道。

## 生命周期与维护

项目本地SessionStart/UserPromptSubmit/Stop/StopFailure hook启动目标会话所属适配器，无需模型续挂。只使用宿主给该子进程的通信上下文；缺失时明确停在activation-required，不读凭据或其他进程环境。原会话关闭时退出，恢复时补扫待办。没有系统服务、第二个Claude驱动者或UI操作。

首次加载需要现有Claude会话触发正常生命周期事件；是否生效看status，不能只看配置文件。`uninstall`只移除本工具的hook并停用适配器，保留信件与结果。未知投递结果不盲目重发；故障时原手动信箱是显式降级，不算自动工具验收。
