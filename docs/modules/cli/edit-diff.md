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

其他接入面若需要差异展示，应明确自己的展示合同，而不是接收 CLI ANSI。旧稿的“显式 presentation-capable 连接可透传”是设计方向，不是当前 RPC 已提供的能力协商接口。

## 当前生产链的可达边界

工具生成器和 CLI 渲染器均已实现，但当前常规 REPL 并未直接消费工具的本地原始 yield：

`edit/write → tool_end → 宿主 projectSessionTurn → 剥离 presentation 的 session delta → ConversationController.onDelta → CLI 渲染`

`ToolBatchCoordinator.recordSideEffect` 能消费 file-diff artifact；没有 artifact 时只显示原有摘要。当前 RPC 剥离发生在它之前，所以不能因工具和 renderer 单测存在，就宣称常规 REPL 已实现端到端 diff 展示。端到端展示仍是产品要求，当前存在接入缺口。

## 终端展示合同

采用 main buffer 的静态 scrollback：副作用事件先封口普通工具批次，单独输出 `✎` 摘要，再下挂 diff block。当前摘要显示文件 basename、操作及可用的增删计数；完整路径仍保存在 artifact 中。

渲染器按 unified diff hunk header 展示范围，以新文件行号为主，删除行的主行号列留空；增加用 `+` 和绿色，删除用 `-` 和红色，header 弱青色，上下文与 gutter 保持克制。颜色只是辅助，无颜色时仍靠符号、行号和结构理解；默认不用整行背景抢占对话主视觉。

当前最多显示 6 个 hunk、每个 80 行、合计 300 行变更／上下文行；超限显示截断提示。长行由 `clampLine` 裁剪，不是交互式折叠。提示中的 `git diff` 只能辅助检查 Git 工作区，不能保证还原非 Git 文件或某次调用的完整差异。

屏幕目标是不触发隐式 wrap、不破坏 chrome。当前 renderer 将 columns 下限设为 20，再按 columns − 1 裁剪，因此不能把小于 20 列的极窄终端也写成已满足；旧稿“极窄时只留符号与正文”的降级尚非当前实现。屏幕所有权与历史能力见[屏幕渲染](screen-rendering.md)。

本职责不提供 alt-screen viewer、鼠标滚动接管、交互展开收起、resize 后重排已绘历史或行内 word-level 高亮。静态内容一次写出后不靠未来重绘补救。

## 维护验证

必须分别验证生成、隔离、渲染和生产接入：新增／覆盖／替换、空行与行尾、重复行、中文、无变化、大输入的未知统计与片段截断；模型消息和默认 delta 无 presentation；无颜色、长行、窄屏及摘要退化；最后沿真实 REPL 的工具结果到渲染器证明 artifact 可达。不能用人工构造 renderer 输入代替生产接入证明。

实现入口：[差异生成](../../../packages/tools-builtin/src/file-diff.ts)、[消息投影](../../../packages/orchestrator/src/runtime/track-messages.ts)、[公开事件剥离](../../../packages/core/src/loop/presentation.ts)、[RPC 流](../../../packages/rpc/src/session-turn-stream.ts)、[会话控制器](../../../packages/cli/src/runtime/conversation-controller.ts)、[副作用展示](../../../packages/cli/src/output/tool-batch-coordinator.ts)、[diff 渲染](../../../packages/cli/src/diff/diff-block-renderer.ts)。
