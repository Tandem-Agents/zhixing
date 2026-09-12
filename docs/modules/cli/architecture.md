# CLI 总体架构

CLI 是知行的终端接入面：负责启动入口、交互和呈现，不拥有另一套智能体执行与会话权威。本文说明整体职责与关键取舍；具体操作见 [CLI 使用说明](../../../packages/cli/README.md)，终端能力见[屏幕渲染与能力边界](screen-rendering.md)。

## 目标与取舍

让用户直接进入可用的个人智能体，而不是先理解、手动拼装服务拓扑。技术选择由实际交互需求驱动，不以引入 UI 框架、复制其他产品或预设代码规模为目标；简单实现仍须完整承担输入、流式输出、确认和恢复体验。

| 选择 | 当前取舍与理由 |
|---|---|
| 进程内直接运行，还是客户端／宿主分离 | 对话入口已采用宿主／RPC。执行、持久化和多入口协作由共享权威承担；客户端负责发现、按需启动或连接宿主，保留无需手动先启动服务的体验，而非保留旧单体实现 |
| 自定义命令解析，还是成熟命令框架 | 启动命令使用 Commander，避免重复实现解析与帮助；REPL 使用自己的命令注册和分派机制，两者服务不同入口 |
| 引入 React／Ink，还是按需管理终端状态 | 当前使用原生终端能力与自有输入、渲染组件，无 React／Ink 依赖。不再承诺从 readline 升级到 Ink；未来选型须证明具体收益，也不能假定替换渲染零成本 |
| 原生回卷，还是完整应用内历史画面 | 主 REPL 保留终端回卷与复制体验，应用管理活动输出及固定交互区；代价是不能任意重排已进入回卷的历史，详见屏幕能力正文 |
| 一次性提示组件，还是持续交互系统 | 表单式引导不能替代 REPL；持续输入、输出、确认和独占面板需要明确的生命周期与输出协调 |

## 入口与运行责任

`zz` 与 `zhixing` 指向同一构建入口。`src/index.ts` 的 Commander 命令树分派交互、管理及内部服务启动路径；默认入口经启动检查进入 `startRepl()`。当前没有旧稿中的 `-p/--print` 单次模式及启动期 `--continue/--resume` 参数，不能把旧命令示例当成可执行合同。

```text
Commander → 启动检查 → REPL 输入／命令分派
                            ↓
             ConversationController／领域 facade／确认 broker
                            ↓
                  CoreHostConnection → 已认证 RPC → 宿主产品能力
                            ↑
             对话流／事件投影 → 呈现订阅 → 输出与屏幕组件
```

- `CoreHostConnection` 管理共享连接、发现与按需启动、断线重建及订阅重挂；会话、调度、管理和确认等共享同一接入身份，不各建连接。设备拓扑允许时也可接入当前 anchor，不要求每个接入设备都启动本地宿主。
- `ConversationController` 管理当前观察的对话及本地提交、旁观输出；领域 facade 调用宿主能力。会话接受、运行提交、执行与持久化仍归宿主及 owner 责任链，不在 CLI 重建。
- `RpcEventBus` 将宿主事件信封还原为供渲染消费的运行投影，按观察对话过滤并维护生命周期；它不是内核事件总线，更不是监听全部事件即可得到完整可观测性的保证。
- `RpcConfirmationBroker` 接入宿主确认能力，终端负责呈现与提交用户选择，不自行决定授权。确认合同见[确认架构](../confirmation/architecture.md)。

CLI 包还包含服务启动和部署装配代码，因此依赖不止 `@zhixing/core`。必须区分包内装配入口与交互接入面的职责，不能以包依赖多为由把执行权威放回 REPL。

## 输入、输出与可见状态

REPL 命令声明、帮助、补全与执行按[命令系统](command-system.md)协作；不在本文维护另一份命令清单。当前输入包含自有输入缓冲、补全、粘贴与面板交互，不能再概括为一个 `readline/promises` 循环。

输出由渲染器及 `CliWriter`、`ScreenController` 等协调，主屏输出区与固定输入／状态区共享终端，不能让业务代码任意直写 stdout 破坏布局。Markdown 使用 `marked` 与自有流式／块级渲染，颜色和代码高亮使用 `chalk`、`cli-highlight`；旧方案中的 `marked-terminal`、`ora` 已不是当前依赖。

模型、用量、成本、工具及执行状态应通过产品事实的呈现让用户理解进展，不暴露全部内部事件。相关口径见[用量与上下文展示](usage-display.md)、[子任务展示](subagents.md)；视觉与面板边界见[视觉设计语言](visual-language.md)。主屏与独占面板的输出切换、恢复和尺寸变化遵循屏幕正文，不把“原生 ANSI”误写成没有 UI 状态。

## 上下文与对话连续性

稳定的角色、行为与安全输入和变化的任务状态应分离，避免无意义地改写稳定前缀；动态信息不得冻结在启动时，也不能据此承诺整次请求缓存命中。组装责任属于[上下文架构](../context/architecture.md)与[逐轮注入](../context/turn-context-injection.md)，不是 CLI 自建 prompt 目录或按入口重复拼装。知行的产品定位是个人智能体，不限于编码助手。

对话已经具备持久化和启动恢复；CLI 经宿主恢复对话及读取历史摘要展示，对话切换／新建通过 REPL 能力完成。终端回卷只是显示，不是会话存储；清屏、清窗口与删除历史也不是同一动作。用户域、工作场景域及接受／恢复语义由[对话持久化](../conversation/persistence.md)说明，不沿用旧的按项目散落 session JSONL 方案。本地部署与存储不意味着模型请求必然离线或不会使用网络。

## 实现入口

- [入口与命令树](../../../packages/cli/src/index.ts)、[REPL 装配](../../../packages/cli/src/repl.ts)。
- [宿主连接](../../../packages/cli/src/runtime/core-host-connection.ts)、[事件投影](../../../packages/cli/src/runtime/rpc-event-bus.ts)。
- [屏幕协调](../../../packages/cli/src/screen/screen-controller.ts)、[Markdown 输出](../../../packages/cli/src/output/markdown/markdown-stream.ts)。

当前总体架构取代早期单体 CLI 与三阶段 UI 路线图；屏幕与文本转换的详细合同分别见[屏幕渲染](screen-rendering.md)和 [Markdown 流式渲染](markdown-rendering.md)，不在本篇重复定义。
