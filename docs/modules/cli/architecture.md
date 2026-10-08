# CLI 总体架构

CLI 是知行的终端接入面，负责启动、交互和呈现；会话、运行提交、权限与持久化仍由共同产品内核拥有。[迁移设计](../../workbench/terminal-architecture-migration.md)定义完整合同，[核心架构](../../../research/design/architecture/overview.md)定义权威边界。

## 默认入口与职责

`zz` 与 `zhixing` 指向同一构建入口。交互环境默认启动 OpenTUI/Solid 终端；重定向输入或不适用交互屏幕的环境使用基础文本对话。帮助、版本、纯文本管理和后台服务按真实 Commander 描述符分流。不存在开发期新旧终端开关，也没有第二套交互 renderer。

| 所有者 | 职责 | 边界 |
|---|---|---|
| S · 入口 supervisor | 准入、拉起 N/U/R、转交通道、关闭顺序和自有进程收束 | 不拥有业务事实，不解释任意脚本 |
| N · Node 应用适配 | 配置、会话/命令、确认映射、材料准备、有限显示投影与本实例存储 | 通过已认证 RPC 和领域 facade 使用产品能力，不直接运行 Agent Loop |
| U · OpenTUI/Solid | 唯一交互屏幕树、编辑、页面、滚动、选择和显示状态 | 只消费有限协议；不持产品凭据、不访问业务持久化、不自行批准操作 |
| R · 原生恢复 | 保存已取得的终端模式依据，在全部自有写者退出后最终恢复 | 不替代业务清理，不因超时与仍活跃写者争写 |
| PersistentApplicationHost | 共同产品装配与长驻运行 | 独立寿命；关闭前台不能顺手终止飞书、调度或其他接入面 |

N 的 `CoreHostConnection` 负责发现、按需启动、认证、断线恢复及观察者重挂；`ConversationController` 和领域 facade 使用同一接入身份。RPC 重连、重绘、翻阅历史不重发任务。确认 broker 只呈现权威请求并提交明确用户选择。

CLI 包同时包含后台组合根和前台适配，因此包依赖不能代替运行时边界判断。N 导入图不得拉入后台执行栈；U 的发行资产随包提供，用户无需另装 UI 运行时或编译工具。

## 输入、输出与生命周期

主页面、配置、候选、选择和临时输入共用 U 的输入所有权与公共信息行。页面切换保留适用草稿和阅读状态，业务只提供内容、选择结果与生命周期，不自行写 ANSI 或切屏。

正文由 N 的有界 Markdown 投影和显示存储供给，U 按稳定源身份维护组件、阅读锚点和选区；resize 重排已保留内容。显示存储是有界投影，不成为第二份会话权威。来源不可重读且容量不足时明确暂停，不能静默丢正文。

正常退出、取消、断连和异常共用关闭责任链：先拒新并结清 N/U/helper，再由原 R 恢复，S 确认实际退出和有限排空后返回 shell。没有旧 ScreenController、主屏滚动区与面板各自接管输入的并行机制。

基础文本对话使用独立的按行适配器，不创建原生屏幕所有者；保留文本发送、已有命令及错误结果，EOF 排空已收到的行。需要交互选择时明确取消或不可用，不把管道中的下一行当作授权。

## 实现入口

- [入口分流](../../../packages/cli/src/entry.ts)、[命令描述符](../../../packages/cli/src/index.ts)、[文本接入](../../../packages/cli/src/text-session.ts)。
- [S 启动与收束](../../../packages/cli/src/terminal/launch.ts)、[N 应用](../../../packages/cli/src/terminal/application.ts)、[U 根](../../../packages/terminal-ui/src/root.tsx)。
- [共享连接](../../../packages/cli/src/runtime/core-host-connection.ts)、[正文投影](../../../packages/cli/src/terminal/body-projection.ts)。

具体合同见[屏幕](screen-rendering.md)、[输入](input-visual.md)、[命令](command-system.md)、[正文](markdown-rendering.md)。
