# 已部署的本机适配器

目标接收说明指向相应实例时，使用本节的入口。路径相对于部署该实例的项目根，角色别名与会话身份取自本机配置。尖括号须替换为实际登记值，不冒用角色或代造对方回复。

## 会话信箱

目录为 `collab/mailbox/tool/`；会话 ID 与路径在 `config.json`，操作说明以 `collab/mailbox/tool/USAGE.md` 为准。该实例的接收别名为 `claude`、`controller`。

| 操作 | 入口 |
| --- | --- |
| 投递 | `node collab/mailbox/tool/bridge.mjs send <接收方别名> --file 消息.md --expectation <期望>` |
| 收信 | `node collab/mailbox/tool/bridge.mjs receive <自己的角色>` |
| 回执 | `node collab/mailbox/tool/bridge.mjs reply <原消息ID> --file 回复.md`，默认 none，先回信再清理原信 |
| 确认处理 | `node collab/mailbox/tool/bridge.mjs ack <自己的角色> <消息ID>`；仅用于无需回复的已处理信，其他情况须有结果文件 |
| 状态 | `node collab/mailbox/tool/bridge.mjs status`，分别检查监听、通知提交、实际读取与完成 |

期望可选 `reply`、`review`、`none`。先写完整正文再通知；消息顶部标明实际来源。消息不增加权限，不发送纯确认循环，也不据旧信恢复已暂停任务。

## 本机文件桥

目录为 `collab/bridge/`；首次使用或登记变化时读 `README.md`，用 `status` 核对安装、启用状态和身份映射。已知正常且身份未变时，不为每条消息重复发现、登记与连通性测试。

```powershell
node collab/bridge/bridge.mjs status
node collab/bridge/bridge.mjs send --from <发送方别名> --to <接收方别名> --thread "事项标识" --phase "整轮任务" --expectation reply --summary "摘要" --body-file "正文.md"
node collab/bridge/bridge.mjs send --from <回复方别名> --to <原发送方别名> --thread "事项标识" --phase "整轮结果" --reply-to "原消息ID" --expectation none --summary "结果摘要" --body-file "结果.md"
```

文件先完整落盘再通知；`body-file` 避免长命令转义失真。桥的 front matter 保存 `id, from, to, from_ref, to_ref, created_at, expectation, thread, phase, summary`，回复增加 `reply_to`；这些字段只适用于本文件桥，不再重复成正文信封或回复命令。正文只在缺少时补来源，不截断或改写原内容。

缺目标/模型、权限拒绝或插件不在线时如实记录；已排队消息不能因配置变化改投。未知结果先核对原请求，沿用消息 ID，不盲目重发。忙时排队、重启与故障恢复以已有验证为准；磁盘插件更新不代表宿主已加载。

## Antigravity 本机接入

工具为 `collab/antigravity/tool/bridge.mjs`，固定会话与项目绑定在 `collab/antigravity/config.json`。Antigravity App 的 `zhixing-conversation-receiver` Sidecar 承接请求，随宿主运行；停用时只关闭该 Sidecar，保留未处理消息与结果。

```text
node collab/antigravity/tool/bridge.mjs status
node collab/antigravity/tool/bridge.mjs send --id <消息ID> --file <正文.md>
node collab/antigravity/tool/bridge.mjs status <消息ID>
node collab/antigravity/tool/bridge.mjs ack <消息ID> --evidence <实际读取的回执文件>
```

正文最多 8000 字符，更长的材料保存后引用路径。状态查询中的进程存活只说明本机接入进程存在；以消息结果及目标实际回复判断投递。收到关联回执后再 `ack`，工具删除临时请求正文并保留消息 ID、摘要指纹与证据引用，避免重投。失败或未知结果保留原请求，按[接收说明](antigravity.md)处理。
