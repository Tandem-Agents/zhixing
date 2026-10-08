# CLI 代码编辑差异展示

用户需要看到智能体具体改了什么，而不只是工具执行成功。目标是在文件摘要后展示有限的变更片段、行号和增删标记，让修改可检查且不淹没对话；这是编辑结果的展示，不是文件修改或审批的第二条执行路径。

## 核心取舍

- 差异算法使用成熟的 `diff` 库；知行负责终端布局。第三方整屏 viewer 不能绕过现有 writer、宽度与屏幕生命周期。
- 数据来自一次工具调用的 before/after，不以 `git diff` 为主数据源：工作区可能不受 Git 管理，Git 差异也不等于本次调用的修改。
- 工具产出结构化数据，不写 ANSI；展示数据与给模型的结果摘要分开，不能用大段 diff 污染模型上下文。
- 复用 `tool_end.result.presentation`，不另建 sink、按 toolUseId 回捞的 Map 或一套清理生命周期。没有展示消费者时，缺少 diff 不改变工具结果语义。

## 当前生成与隔离

`edit` 写入成功后用原文与替换结果生成 `file-diff`；`write` 在旧内容可读取时生成 created/overwritten 差异，旧内容不可读取时可只返回摘要。类型支持 deleted，但不能据此声称已有独立删除文件工具接入。

`buildFileDiffArtifact` 用 `structuredPatch` 生成三行上下文的 hunks，保存行类型、新旧行号和范围。生成与展示各自有上限：

- before/after 总长度超过 1,000,000 个字符串代码单元时不生成 hunks，统计标为 `unavailable/input-too-large`，不是虚假的 `+0 -0`。
- artifact 最多保存 1,000 行；保存截断后仍遍历 patch 统计增删总数，以 `changeStats: exact` 与 `truncated` 区分完整计数和不完整片段。
- 工具仍返回短 `content`；`presentation` 只携带结构化 artifact，不携带终端 ANSI。

`trackMessages` 从 tool_end 只提取工具 id、content 和 isError 形成模型／历史消息，不将 presentation 写入这些消息。公开 session delta 经 `stripPresentationFromAgentYield` 去掉 presentation，保留其余事件与结果字段；默认跨接入面不应负担本地 diff 展示数据。其它持久化或传输边界也必须守住展示与协议事实分离，不能仅靠某个 CLI 消费者自觉忽略。

新交互终端通过 bounded-v1 协商接收有界 file-diff／subagent 展示投影；默认 observer、模型结果及持久 transcript 仍不含 presentation。增强投影复用既有会话流及 current-anchor 责任，不另建 artifact 查询事实源。

## 当前生产链

`edit/write → tool_end.presentation → RPC 增强投影 → ConversationController → N TerminalProcessProjection → 有界正文块 → U`。

N 验证 artifact 身份与容量后生成过程／差异文本，U 在统一正文视口呈现。能力协商失败、缺少 artifact 或容量不足时应明确展示边界，工具执行事实不因展示缺失改变。旧 ToolBatchCoordinator 与 DiffBlockRenderer 已退役，不能继续用旧 renderer 单测作为当前用户链证据。

## 终端展示合同

文件摘要之后展示有限的 unified diff 片段、范围、行号与增删标记，让用户可检查改变。符号和结构必须在无颜色时仍可理解；完整路径、统计是否精确和片段是否截断由 artifact 事实决定，不伪造零变更。

[过程格式](../../../packages/cli/src/terminal/process-presentation.ts)将结构化差异转换为有限正文，[过程投影](../../../packages/cli/src/terminal/process-projection.ts)关联父工具及运行，[正文输出](../../../packages/cli/src/terminal/output.ts)进入统一显示存储。U 按视口和公共宽度策略渲染、回看和 resize；不再使用旧 renderer 的 20 列下限、6 个 hunk／80 行／300 行静态参数作为新实现事实。

差异生成上限、RPC 投影上限、正文存储预算和 U 视口预算是不同边界。超限必须说明截断，不能让界面截断改变工具结果或模型输入。git diff 只辅助检查 Git 工作区，不能保证还原非 Git 文件或本次调用的完整差异。具体屏幕生命周期见[屏幕渲染](screen-rendering.md)。

## 维护验证

必须分别验证生成、隔离、渲染和生产接入：新增／覆盖／替换、空行与行尾、重复行、中文、无变化、大输入的未知统计与片段截断；模型消息和默认 delta 无 presentation；无颜色、长行、窄屏及摘要退化；最后沿真实 REPL 的工具结果到渲染器证明 artifact 可达。不能用人工构造 renderer 输入代替生产接入证明。

实现入口：[差异生成](../../../packages/tools-builtin/src/file-diff.ts)、[消息投影](../../../packages/orchestrator/src/runtime/track-messages.ts)、[公开事件剥离](../../../packages/core/src/loop/presentation.ts)、[RPC 流](../../../packages/rpc/src/session-turn-stream.ts)、[会话控制器](../../../packages/cli/src/runtime/conversation-controller.ts)、[过程投影](../../../packages/cli/src/terminal/process-projection.ts)、[diff 格式](../../../packages/cli/src/terminal/process-presentation.ts)。
