# 外部连接适配编写

适用：管理协议 1、Channel 合同 1、Node 24。正式安装包的 `extension-kit` 提供本文、`manifest.schema.json`、`channel-sdk.mjs`、`channel-sdk.d.ts` 及其引用合同和 `validate.mjs`；用 `extension guide` 获取本机路径，无须知行仓库源码。

## 制作候选

先用 `extension prepare` 接纳需求，后续复用操作 ID。在独立工作目录查证平台官方接口与来源，获取兼容制品或自行包装 SDK。模型使用既有工具准备环境、安装准确版本依赖并构建；不修改知行安装目录、依赖或已有连接。

入口通过 `serveChannelExtension(instanceId => adapter)` 实现 ChannelAdapter；SDK 自带 IPC、启动、健康与停止协议。将 SDK 和第三方依赖一起打包为一个 Node ESM `.mjs`，仅允许 Node 内置模块作为外部依赖。使用原生扩展或其他外部运行环境的包不符合本版本合同，不能伪装成独立制品。

实现前沿 `channel-sdk.d.ts` 的导入读取所引用的完整 `ChannelAdapter`、`ChannelContext` 和 `DeliveryResult` 类型；入口声明本身不是完整合同。适配对象直接提供 `id` 和 `capabilities`，`connect`／`disconnect` 返回 Promise，`health` 同步返回 `ready` 或 `unavailable`。`registerHttpRoute(path, handler)` 接收单个处理函数且不返回卸载函数；`send` 的所有结果都必须包含布尔型 `success` 和 `retryable`，成功还应保留平台消息身份。不要根据常见 SDK 的接口形状猜测这些字段。

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
- 群聊归组由 `declaration.bindingPolicy.group` 固定，省略为 `per-group`；适配器的 `bindingPolicy` 必须与声明一致。更新与修复不能改变已有归组，避免历史对话和未决确认失去入口。
- `send(target, content, meta)` 保留幂等键、Delivery 尝试身份与平台回执；未知结果不报成功、不盲目重试。不得伪造入站或发送成功。
- `health` 反映真实连接；`disconnect` 与 abort 释放 SDK、订阅、计时器和连接。HTTP 回调只通过 `registerHttpRoute` 注册 `/channels/<instanceId>/...` 路径，并验证平台签名。
- HTTP 处理函数收到 SDK 构造的流对象：请求是 Node `Readable`，包含 `url`（注册路径，不含原 URL 的 query）、`method` 和原请求 `headers`；读取请求头时须处理缺失值及数组。主机先缓冲请求体（最多 1 MiB），处理函数可用 `for await` 读取 Buffer 后自行解析。响应是 Node `Writable`，支持 `statusCode`（200—599）、`setHeader(name, string)`、`getHeader(name)`、`writeHead(status, headers?)`、`write` 和 `end`，响应头只接受字符串值；处理结束必须调用 `end`。SDK 缓冲完整响应后一次性回传主机，不提供 socket、Express 方法或完整的 `IncomingMessage`／`ServerResponse` 接口。
- 可选交互卡片按合同携带原签名 challenge 与真实应答者；无按钮的平台保留文本回复和取消能力，不另建确认权威。

## 接入与验证

候选经安全确认后归档，凭据完整发布后才试运行。试运行只开放验证：用户从本机配置面板取得指令，在 APP 的目标会话发送，再在同一会话按收到的回复确认。核心核对来源身份、回复目标及真实双向往返后才开放业务；进程存活、模型自述和安装成功均不能跳过验证。

操作与结果由扩展管理耐久保存。等待本人操作时结束运行；重启、配置保存后自动接续。查询用 `extension status`，撤销未完成操作用 `cancel`，停用用 `disable`；迟到的候选、配置或消息不能重新启用已撤销的连接。

账号、回复目标或公开使用配置改变时，新建独立的本人验证轮次，不重开已经完成的接入、更新或修复，也不沿用其回复目标、确认或回滚绑定。迁移承接的旧实例同样适用。普通进程重启保留当前验证轮次；同账号仅轮换秘密不要求重新绑定本人。停用优先，取消后的再次启用必须重新验证。本机配置发起的验证可没有原始对话，结果交已有可达入口；没有可达入口时保留待告知状态。

公共查询、管理工具和配置应用结果只返回操作标识、目标实例、修订、目的、阶段、候选声明和受阻原因，不返回原始请求、回送地址、验证证明或恢复检查点。原文仍在 Authority 内供接续使用，不随其他对话的状态查询进入模型上下文。配置绑定以 `configurationRevision` 标识公开配置身份，以 `projectionRevision` 引用本机完整不可变投影；不另存无业务用途的秘密修订副本。

## 更新与修复

用户要求更新时用 `extension update`，报障用 `repair`；有限自动恢复耗尽也进入同一修复操作。收到接续后，用 `extension_source` 将原版本候选、源码与构建资料导出到工作目录内的新文件，结合 `status` 的脱敏状态定位，再制作并提交候选。修复不换账号、扩权、增加功能或清除历史；缺少平台事实可自行查证，凭据仍只走本机安全入口。

首次试运行尚未通过验证而受阻时，显式 `repair` 在同一实例上接续准备，导出已保存候选，复用当前完整配置投影；没有已验证的旧版本便不建立虚假回滚。修正候选仍受账号、声明字段和能力约束；不兼容时明确受阻，允许按最新修订继续提交合规候选。取消或停用抢先提交时，迟到修正不得激活或删除该实例已保存的投影。

准备时旧版本继续服务。提交后只切换目标实例：停止新业务准入，已发调用仍按原尝试结算，随后关闭旧进程并启动候选；未发送义务与未决确认继续由原领域拥有，不等待业务 Run 结束。候选验证前不承接普通业务；已核实身份的原目标会话可直接接收新的收发确认，没有既有验证证据时按本机面板指令验证。确认、取消通路不随普通业务暂停。

成功后保留实例、账号与对话身份；候选失败或取消换版则恢复旧绑定，旧制品和完整配置投影不删除，业务事实不回退。停用会撤销启用意图，不因修复完成或迟到确认而复活。同账号凭据经安全入口完整更新可继续操作，账号或使用范围改变须撤销原操作重新确认。旧版本也不可用时明确受阻，不宣称恢复；结果保留于原对话，受影响渠道之外的主对话可查询并接收必要通知。

无法可靠接入或恢复时说明限制、影响与下一步；查证存在可行替代方式时说明条件并供用户选择，不编造或擅自切换。替代方案的质量属于模型体验验收，系统不会仅凭生成了一段建议就认定已恢复。
