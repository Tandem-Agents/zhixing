# Codex 接收说明

## 接收入口与结果

原生会话工具可直接完成时直接使用。外部发送者使用[投递脚本](../scripts/codex-delivery.mjs)：Windows上发现唯一的 `codex-app-tools-*` 桌面管道，读取宿主公布的工具列表，核对固定thread UUID、local宿主及cwd，再调用原生 `send_message_to_thread`。不启动第二个执行者，不读取凭据，不修改模型或权限；发现多个桌面实例时失败关闭，不凭最近活跃或第一个管道猜目标。

回执 `mode: native-follow-up` 表示当前桌面接受后续消息，由宿主安排投递；实际收到关联正文才算接收完成，不据此声称某个turnId或恰好一次。本机适配调用使用目标会话上下文，因此原生包装的source_thread_id可能等于目标ID；外部发送者身份必须保留在正文，包装不把代理消息变成用户指令。发送后丢失回执记为unknown，不自动转另一入口重投。

没有新版入口时，保留旧 `codex-ipc` 协议；显式 `pipePath` 也用于旧协议。以下steer/queue规则仅适用于该旧入口：

回执的`mode: steer`和`turnId`表示宿主接受了回合内引导，实际在回合结束前读到消息才证明效果。`mode: queue-idle`只用于宿主明确拒绝引导且说明会话已空闲的情况。管道不可达或找不到所属客户端，并不能证明所有运行环境中的目标会话都空闲；此时保留原信并报告失败，不静默退回排队。桌面未运行或尚未持有目标会话时，本通道等待它恢复，不另外启动会话。

未知结果重试保持同一消息标识；监听进程或发送方换代不改变消息身份。宿主未承诺用`clientUserMessageId`保证恰好一次，因此业务仍以信件ID、receive和ack确认幂等处理，不能仅凭投递标识相同声称无重复。

已验证环境：2026-11-20，Windows Codex桌面版 `26.1117.3838.0` 已无旧管道；通过新版入口，Antigravity在原会话实际读取测试信并回信，Codex在当前活动回合收到关联标记 `AGY-CODEX-ROUNDTRIP-20261120`，回执为native-follow-up。证据在 `collab/validation/communication-20261120/result.json`；当前版本空闲时序未另做专项验证。旧版 `26.1103.4239.0` 的steer及turnId一致证据仍只代表旧协议。宿主升级后出现协议不匹配时重新核验。

## 现有本机调用

原生会话工具可直接完成时直接使用；需要适配时，选用已部署实例或其中复用的[投递脚本](../scripts/codex-delivery.mjs)，不能把本机配置当成其他环境现成可用。

- [会话信箱](local-adapters.md#会话信箱)：接收别名 `controller`，具体 ID 在 `collab/mailbox/tool/config.json`。
- [本机文件桥](local-adapters.md#本机文件桥)：Codex 身份在 `collab/bridge/config.json` 的 `controller.thread`。保留消息 ID、模式与活动 turnId；空闲投递使用本机已确认版本的 `codex queue`，不盲用 PATH 中另一版本。

不得以 resume、exec、新会话或第二个执行者替代原会话接收。实例与角色发生变化时重新核对绑定，不按旧岗位别名误投。
