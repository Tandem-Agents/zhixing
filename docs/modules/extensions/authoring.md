# 外部连接适配编写

适用：管理协议 1、Channel 合同 1、Node 24。正式安装包的 `extension-kit` 提供本文、`manifest.schema.json`、`channel-sdk.mjs`、`channel-sdk.d.ts` 及其引用合同和 `validate.mjs`；用 `extension guide` 获取本机路径，无须知行仓库源码。

## 制作候选

先用 `extension prepare` 接纳需求，后续复用操作 ID。在独立工作目录查证平台官方接口与来源，获取兼容制品或自行包装 SDK。模型使用既有工具准备环境、安装准确版本依赖并构建；不修改知行安装目录、依赖或已有连接。

入口通过 `serveChannelExtension(instanceId => adapter)` 实现 ChannelAdapter；SDK 自带 IPC、启动、健康与停止协议。将 SDK 和第三方依赖一起打包为一个 Node ESM `.mjs`，仅允许 Node 内置模块作为外部依赖。使用原生扩展或其他外部运行环境的包不符合本版本合同，不能伪装成独立制品。

`candidate.json` 包含：

| 字段 | 含义 |
|---|---|
| `manifest` | schema 所定义声明；digest 是最终入口 UTF-8 字节的 SHA-256 |
| `code` | 最终独立入口文本 |
| `provenance` | `{url, revision, kind}`：官方 HTTPS 来源、准确版本或提交，kind 为 existing 或 authored |
| `sources` | 文件名到文本的映射，保留适配源码及构建文件；有依赖时保留 package.json 与锁文件，依赖使用准确版本 |
| `build` | 可重复的构建说明，写明工具版本与命令 |

运行 `node <extension-kit>/validate.mjs <candidate.json>` 做无执行校验，再用 `extension_connect` 提交操作 ID、当前修订、候选文件和已检查的 digest。校验不等于执行授权，摘要也不证明来源可信。包、源码和对话均不放秘密；声明 sensitive 字段，由用户在目标设备 `/config` 的消息通道安全填写。

## Channel 合同要点

- `connect(context)` 只使用本实例的配置。凭据来自 `context.config.credentials`；`identityFields` 指定非秘密、必填的账号身份字段，以阻止同一账号被两个实例并行消费。不得打印凭据。
- 每条入站消息带平台认证的 `from`、稳定 `messageId`、`channelId` 和真实聊天类型。先等待 `context.onMessage` 成功，再向平台确认或推进游标；失败需允许原事件重投。不能以内存去重代替核心的耐久接纳。
- `send(target, content, meta)` 保留幂等键、Delivery 尝试身份与平台回执；未知结果不报成功、不盲目重试。不得伪造入站或发送成功。
- `health` 反映真实连接；`disconnect` 与 abort 释放 SDK、订阅、计时器和连接。HTTP 回调只通过 `registerHttpRoute` 注册 `/channels/<instanceId>/...` 路径，并验证平台签名。
- 可选交互卡片按合同携带原签名 challenge 与真实应答者；无按钮的平台保留文本回复和取消能力，不另建确认权威。

## 接入与验证

候选经安全确认后归档，凭据完整发布后才试运行。试运行只开放验证：用户从本机配置面板取得指令，在 APP 的目标会话发送，再在同一会话按收到的回复确认。核心核对来源身份、回复目标及真实双向往返后才开放业务；进程存活、模型自述和安装成功均不能跳过验证。

操作与结果由扩展管理耐久保存。等待本人操作时结束运行；重启、配置保存后自动接续。查询用 `extension status`，撤销未完成操作用 `cancel`，停用用 `disable`；迟到的候选、配置或消息不能重新启用已撤销的连接。本版本接入流程不覆盖既有实例，换版和修复沿独立管理操作推进。
