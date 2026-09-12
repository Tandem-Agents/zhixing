# MCP Host 架构

MCP 为知行补充外部服务能力，不重复内置文件、命令与网络工具。预设以外部服务为范围；这是一项产品取舍，不代表任意第三方 server 都不会访问本地资源。

协议握手、发现与调用复用 MCP SDK；知行负责把它接入自己的生命周期、工具和安全体系。接入体验与配置管理见[接入与管理](onboarding-and-management.md)。

## 核心取舍

| 选择 | 解决的问题与边界 |
|---|---|
| 异步直接调用 SDK | 宿主本身异步，不增加同步桥或独立后台调度系统 |
| 连接与工具投影分离 | 连接属于宿主资源，工具定义属于一次运行体的能力快照；重建工具不等于重新建立所有连接 |
| 复用统一工具与安全链 | MCP 不能形成第二套执行、确认或信任系统 |
| 配置决策与设备秘密分离 | 普通配置不保存密钥；执行设备只获得连接所需的 MCP 秘密投影 |
| 先发现、后装配 | 首次工具目录必须参与工具集与提示构造；后台重连不能暗改已冻结的运行体 |
| 结果转换与限长，不做模型蒸馏 | 工具调用没有独立的摘要目标，自动摘要可能丢失后续推理需要的细节 |

当前只做 MCP Host（连接 server 的客户端），支持 stdio 与 Streamable HTTP；不包含 SSE transport、知行作为 MCP server 对外开放或向下游 CLI 注入配置。server 级预置权限规则不是当前必要能力，不应把通用权限存储的扩展接口写成已启用的 MCP 策略。

## 责任与数据流

```text
执行设备的 MCP 配置 + MCP 秘密投影
    → Host 基础设施适配器 → McpHub（连接、目录、调用、重连）
    → tools.snapshot()（工具定义与 server 身份在同次取样）
    → 运行体 extraTools → 工具边界注册与统一安全/执行链
    → 映射工具 call → hub.callTool → SDK server

Host 另持 lifecycle.connect/close；管理面只消费 status.snapshot。
```

`@zhixing/mcp` 不依赖 CLI 的配置编辑器或应用装配。`mcp-config.ts` 将配置及秘密投影变成中性的连接规格；`mcp-runtime-adapter.ts` 隐藏具体 hub，只向消费者提供工具、状态、生命周期三个需求端口。

常驻 Host 在 `serve/command.ts` 创建 MCP 资源并登记关闭，再连接、装配运行体；executor role 在其执行设备独立拥有同类资源与关闭链。`workspace-command.ts` 的独立执行路径同样负责连接与 finally 关闭。不是跨设备的全局连接单例，也不由 CLI 展示会话持有所有连接。

工作场景与执行计划从同次 MCP 快照取得工具和 server 身份，避免能力目录与身份各取一次产生漂移。MCP 与工作目录工具隔离是不同维度：没有本地工作目录不自动取消外部服务能力，但仍受执行设备可用能力与安全合同约束。默认 Task 子 Agent 从父工具集中按 profile 白名单派生，当前白名单不含 MCP，不能因父运行体有 MCP 就声称子 Agent 也能调用。

## 连接与快照生命周期

- 启动先并发连接启用的 server，完成握手与 `tools/list`，再生成运行体工具快照。单 server 连接/发现默认限时 10 秒，失败隔离，不因一个 server 失败而使其余全部不可用；不是无等待启动。
- 首次失败与被动断线均进入 `connecting`，保留最近失败原因，按 1 秒起步、上限 30 秒的指数退避重试。连接成功清除旧错误。空配置的 hub 返回空目录，调用未知 server 返回错误，关闭可空操作。
- 主动关闭前解除断线回调，取消重连计时器；异步建链完成时复核当前规格，已删除或替换的孤儿连接必须释放。Host 关闭还清空期望规格，防止在途连接在退出后重新生效。
- 已冻结的工具仍可能遇到 server 断线，调用返回明确的不可用错误。重连恢复连接不重写旧提示或旧 schema；新发现的工具需下一次运行体装配才进入快照。
- 当前关闭委托 SDK Client/transport，并释放 HTTP 连接池；hub 使用 `allSettled` 收尾。退出不应遗留子进程，但该关闭路径不能证明任意后代进程树都已被强制终止，或关闭失败都已完整报告。
- 库内 `hub.applyConfig` 能增量调整规格，但当前 Host 端口未暴露它。用户配置生效走 Host 换代，不能沿用旧的 `session.reload → computeDiff → hub.applyConfig` 接线说明。

## 工具映射合同

| 知行字段 | 当前 MCP 映射 | 含义与限制 |
|---|---|---|
| `name` | `mcp__<server>__<tool>` | server id 禁止 `__`、最长 40；动态 tool 名消毒、限长与同 server 去重，全名最长 64；调用仍使用原始 tool 名 |
| `description` | server 描述，最多 2048 字符 | 限制工具描述体积，不代表内容可信 |
| `inputSchema` | 顶层 object schema 原样使用，否则退为 `{type:"object"}` | 当前不是完整 schema 校验，也不是拒绝不合格 schema |
| `isReadOnly` / `isParallelSafe` | 仅 `readOnlyHint === true` 时为 true | 缺省 false；远端 hint 不是副作用或并发安全证明 |
| `needsPermission` | true | 最终由共同安全策略裁决，不在 MCP 层直接放行 |
| `boundaries` | `external-service`，只读为 `query`，其余为 `invoke`，`dynamic:false` | 进入共同边界分类，不另建 MCP 权威 |
| `permissionArgumentKey` | 首个必填 string 参数（若有） | 用于共同权限参数匹配 |
| `maxResultChars` | 100000 | 交共同工具结果管线处理超长结果及截断提示 |
| `interruptBehavior` | stdio 为 `grace`，HTTP 为 `cancel` | 交共同中断管线处理，不等同于每次取消都关闭整个 hub |
| `call` | server id + 原始 tool 名 + 参数 + AbortSignal | 普通失败转 `isError`；取消异常向上传递，保留共同中断语义 |

当前不消费 `openWorldHint`、`destructiveHint`、`idempotentHint`，也未从 server 自动生成 `systemPromptHints`。不要把可选字段或未来设计写成现行映射。

结果中的 text 块拼接为字符串；image/audio/resource 等非文本块用省略标记表示，不内联二进制或资源。没有标准 content 时兼容序列化 `toolResult`，透传 `isError`。这是当前输出形态边界，不是完整多模态 MCP 结果支持。

## 安全边界

MCP 工具与内置工具共用边界注册、权限、信任及执行机制。`query/invoke` 是分类输入，不能简化成“只读必放行、其他必确认”：实际结果还取决于有效策略，且分类依赖 server 提供的 hint。

stdio 使用 SDK 默认环境白名单，再过滤显式 env 中的解释器启动型危险变量；并非继承全部宿主环境。HTTP transport 注入 `@zhixing/network` 的 safe fetch，使用统一代理与 SSRF 出站约束，不走 SDK 默认全局 fetch 旁路。这些保护不能把任意本地进程变成沙箱。

MCP 秘密留在设备 SecretStore，由组合根发放最小投影；stdio 注入 env，HTTP 注入 header。秘密文件族的保护属于共同安全边界，不能通过 MCP 工具绕过。一次性接入探测与常驻连接复用同一建链与 transport 安全逻辑。

## 实现依据

- 连接、重连与释放：[hub.ts](../../../packages/mcp/src/hub.ts)、[connect.ts](../../../packages/mcp/src/connect.ts)、[transport.ts](../../../packages/mcp/src/transport.ts)。
- 映射与结果：[mapping.ts](../../../packages/mcp/src/mapping.ts)、[naming.ts](../../../packages/mcp/src/naming.ts)、[result.ts](../../../packages/mcp/src/result.ts)。
- Host 接线：[运行适配器](../../../packages/cli/src/runtime/mcp-runtime-adapter.ts)、[常驻组合根](../../../packages/cli/src/serve/command.ts)、[执行设备生命周期](../../../packages/cli/src/serve/executor-role-runtime.ts)、[工作场景投影](../../../packages/cli/src/serve/workscene-runtime-projection.ts)。
