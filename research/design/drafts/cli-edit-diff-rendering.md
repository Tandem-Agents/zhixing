# CLI 代码编辑差异渲染方案

## 结论

CLI 需要补一层“代码编辑差异渲染”能力：当 agent 通过 `edit` / `write` 修改文件后，终端不只显示 `Edit foo.ts · applied` 这类摘要，而是展示用户真正关心的变更片段：文件、行号、hunk、增加、删除、修改颜色。

最优方案是：**diff 算法用成熟第三方库，终端 UI 渲染自己做。**

原因：

1. diff 算法不应自研。行尾、空行、连续变更、重复行、超大文件、中文内容都容易踩坑，成熟库更稳。
2. UI 必须自研。知行 CLI 是 main buffer + DECSTBM + 命令式 ANSI 流式 emit，没有应用层历史状态；第三方 terminal diff viewer 往往假设自己控制 stdout、整屏或滚动，会破坏现有 chrome / scrollback 体系。

## 当前状态

现有能力：

- `read` 工具输出带行号。
- `edit` / `write` 已被 CLI 识别为副作用工具，走独立 `✎` 行，不进入普通工具批次折叠。
- CLI 已有 `tone`、`layout`、`stringWidth`、`wrapToWidth`、`clampLine` 等终端渲染基础。
- main buffer scrollback 可长期保留历史内容，适合展示静态 diff block。

缺口：

- `edit` / `write` 成功结果没有 diff 数据。
- 目前没有 renderer-only file-change artifact。
- CLI 只有副作用摘要行，没有 hunk 渲染器。

## 产品目标

用户看到的是“agent 改了什么”，不是“工具执行成功”。

目标效果：

```text
  ✎ Modified research/design/drafts/foo.md · +34 -1
      @@ -162,3 +162,37 @@
      162   已有内容
      164 + 新增内容
          - 被删除内容
      166   后续内容
```

视觉要求：

- 文件级摘要清楚：新增 / 删除 / 修改 / 覆盖。
- hunk 只展示变更片段，不展示整个文件。
- 有主行号、符号列。
- 新增为绿色，删除为红色，上下文为弱灰或普通色。
- 长行按终端宽度裁剪或折行，不能触发终端隐式 wrap。
- 大 diff 必须折叠，避免刷屏。

## 屏幕边界

只做 main buffer scrollback 静态渲染。

明确不做：

- 不做 alt-screen diff viewer。
- 不做可交互展开 / 收起。
- 不做鼠标滚动控制。
- 不接管已绘历史，不做 resize 后重排历史。

原因：当前屏幕架构没有应用层历史状态；alt-screen 跨平台滚动也没有稳定基线。静态 diff block 写入 scrollback 是最符合现有渲染模型的方案。

## 架构方案

数据流：

```text
edit/write before-after
        ↓
diff library 生成 structured hunks
        ↓
ToolResult.presentation 携带 renderer-facing artifact
        ↓
tool_end 事件携带完整 ToolResult
        ↓
CLI side-effect renderer 读取 result.presentation
        ↓
DiffBlockRenderer 渲染 ANSI lines
        ↓
CliWriter 写入 main buffer scrollback
```

### Diff 算法层

引入成熟 diff 库，建议优先评估 `diff`。

使用目标：

- 输入：`beforeText`、`afterText`、文件路径。
- 输出：structured hunks，而不是纯 unified diff 字符串。
- 保留主行号、每行类型、hunk 范围。

不要把 diff 算法和 CLI 渲染绑死。算法层输出纯结构，CLI 才决定颜色和布局。

### 展示数据边界

不要把 diff 展示数据放进 `ToolResult.content`。

`ToolResult.content` 是 LLM-facing 协议：它会被转成 transcript 里的 `tool_result.content`，也会被模型继续消费。代码 diff 是用户界面展示数据，不应进入 LLM 上下文，不应写入 transcript，也不应成为 Feishu / 其他接入面的通用负担。

正确边界：

- `ToolResult.content`：短摘要，给 LLM / transcript 使用。
- `ToolResult.presentation`：renderer-facing 临时展示数据，随 `tool_end` 给本地渲染器使用。
- `trackMessages` 是 transcript 剥离点：只写入 `content` / `isError`，必须丢弃 `presentation`。
- `stripPresentationFromAgentYield` 是跨进程 / 跨接入面出口的统一剥离边界：RPC session delta、channel adapter、daemon-wide 事件广播等默认必须先经过它，不能各接入面手写剥离。
- 只有本地 CLI 渲染链路，或显式声明 presentation capability 的连接，才可以消费 `presentation`。
- Feishu / 其他接入面默认不接收、不发送、不持久化这份 artifact；未来如果某个通道要做自己的卡片 diff，应由该通道显式定义自己的展示模型，而不是复用 CLI ANSI/hunk 渲染数据。

硬红线：`presentation` 只能是 renderer-facing artifact，不能进入 `content`、transcript、默认 RPC payload、channel adapter、跨接入面共享协议或任何持久化消息。跨边界剥离必须集中在一个 public-yield sanitizer，避免每个接入面重复实现后漂移。没有 presentation-capable 渲染器消费时，它只能被忽略或剥离，不能影响工具语义。

这个选择比旁路 sink 更稳：`tool_end` 已经携带 `id` 和完整 `ToolResult`，CLI 本来就在消费这条 renderer-facing 流；把 artifact 放在 `result.presentation` 上，可以消掉 sink 容器、`toolUseId` 回捞、上下文注入和生命周期清理。

建议形态：

```ts
interface ToolResult {
  content: string;
  isError?: boolean;
  committedToUser?: boolean;
  presentation?: ToolPresentationArtifact;
}

type ToolPresentationArtifact =
  | {
      kind: "file-diff";
      path: string;
      operation: "created" | "modified" | "deleted" | "overwritten";
      addedLines: number;
      removedLines: number;
      hunks: readonly FileDiffHunk[];
      truncated?: boolean;
    };
```

传递方式：

1. `edit` / `write` 写入成功后在 `ToolResult.presentation` 上返回结构化 `ToolPresentationArtifact`。
2. AgentLoop 产出的 `tool_end` 事件已经携带完整 `ToolResult`，CLI 直接从 `event.result.presentation` 读取。
3. `trackMessages` 转 transcript 时只写入短摘要，丢弃 `presentation`。
4. RPC / channel / daemon 出口默认调用统一 public-yield sanitizer 剥离 `presentation`，除非该连接明确声明自己是 presentation-capable 渲染面。
5. 没有渲染器消费时，工具语义保持今天的短摘要行为。

这个方案的隔离边界最干净：工具只有一个结果对象，CLI 走现有 `tool_end` 流；LLM / transcript / 默认跨接入面出口只得到短摘要 `ToolResult.content`。

不接受的方案：

- 不把 hunk 文本塞进 `ToolResult.content`。
- 不做 renderer sink、`toolUseId` 回捞、长会话 Map 清理这类旁路基础设施。
- 不把 ANSI 渲染后的 diff 存进任何通用消息或 transcript。

### 工具层改动

`ToolResult`：

- 增加可选 `presentation?: ToolPresentationArtifact`。
- 该字段只接受结构化 artifact，不接受 ANSI 文本。
- `content` 继续是唯一 LLM-facing 摘要。
- transcript、默认 RPC / channel 出口必须通过统一 sanitizer 剥离该字段。

`AgentYield` 出口：

- 新增统一 public-yield sanitizer，用于把 `tool_end.result.presentation` 从默认公开事件中剥离。
- sanitizer 必须保留 `tool_end` 的 `id`、`name`、`duration`、`result.content`、`result.isError`、`result.committedToUser`，只删除 `presentation`。
- 所有跨进程 / 跨接入面事件出口复用该 sanitizer；禁止在 Feishu、RPC、scheduler 等接入面里各自手写一份剥离逻辑。
- presentation-capable 的本地渲染面必须显式绕过 sanitizer 或传入明确 opt-in，不能成为默认行为。

`edit`：

- 写入前读 `beforeText`。
- 执行替换得到 `afterText`。
- 写入成功后在 `presentation` 上返回 `file-diff` artifact。
- `content` 继续短摘要，例如 `Replaced text in ...`。

`write`：

- 若文件存在：读 `beforeText`，写入后与 `afterText` diff。
- 若文件不存在：按 created 处理，可只展示新增 hunk。
- 对超大文件设置上限，超过上限只给摘要，避免内存和屏幕爆炸。
- 在非 presentation-capable 的出口中，`presentation` 必须被剥离，只保留短摘要。

### CLI 渲染层

在 side-effect 工具成功路径中：

1. 仍先输出 `✎ Modified foo.ts · +N -M`。
2. 如果 `tool_end.result.presentation` 是 `file-diff` artifact，紧随其后输出 diff block。
3. 如果没有 artifact，保持现有摘要行为。

新增模块建议：

- `packages/cli/src/diff/diff-block-renderer.ts`
- `packages/cli/src/diff/types.ts`
- `packages/cli/src/diff/__tests__/diff-block-renderer.test.ts`

渲染器职责：

- 接收 `file-diff` artifact。
- 按 columns 计算 gutter 和内容宽度。
- 渲染 hunk header。
- 渲染 context / added / removed 行。
- 对长行做裁剪或 wrap，保证每段显示宽度小于终端列宽。
- 对过大 diff 做折叠提示。

建议默认折叠策略：

- 最多展示 6 个 hunk。
- 每个 hunk 最多展示 80 行。
- 总展示最多 300 行。
- 超出显示：`⋮ diff truncated · use git diff for full changes`。

## 标准视觉

语义颜色：

- added：绿色前景。
- removed：红色前景。
- context：普通或 dim。
- hunk header：dim cyan。
- gutter：dim。

默认不使用整行背景色。

原因：现有 CLI 输出层级是 `◆` 文本主级、`⟡/✎` 工具次级；大片 `bgGreen/bgRed` 会抢过 AI 文字主轴，破坏整体克制感。颜色只作为辅助，结构必须靠 `+` / `-` / 行号成立。

后续增强路线：首版可以不做 word-level 高亮，但顶级 diff 体验最终应支持行内 token / word-level 变化强调。该增强只能用于局部片段，不能默认整行铺底，也不能破坏 `+` / `-` / 行号的无颜色可读性。

行格式建议：

```text
     @@ -162,3 +162,37 @@
     162   已有内容
     164 + 新增内容
         - 被删除内容
     166   后续内容
```

默认格式采用轻 gutter：

- 单主行号，以新文件行号为主。
- 删除行没有新文件行号，行号列留空。
- `+` / `-` 紧贴内容列，靠符号和颜色识别变更。
- hunk header 保留标准 unified diff 形态：`@@ -oldStart,oldCount +newStart,newCount @@`。
- diff block 缩进对齐现有 side-effect 详情下挂视觉，不另起一套大块布局。

降级：

- 窄屏：缩短行号列和内容宽度，优先保留符号与代码内容。
- 极窄：只保留 `+` / `-` / 空格符号列和内容。

## 实施拆分

### 单元一：数据与 diff 生成

目标：工具成功后能为 CLI 产出结构化 `file-diff` presentation artifact，但不进入 `ToolResult.content` / transcript。

改动：

- 新增 renderer-facing presentation artifact 类型。
- 在 `ToolResult` 上增加可选 `presentation?: ToolPresentationArtifact`。
- 新增 diff 结构类型。
- 为 `edit` / `write` 生成 `file-diff` artifact，并随 `tool_end.result.presentation` 到达 CLI。
- 确认 `trackMessages` 只写入短摘要，presentation 不进入 transcript。
- 新增统一 public-yield sanitizer，并让 RPC session delta、channel adapter 等默认跨接入面出口复用它剥离 presentation。
- 添加边界测试：默认 session delta 不含 presentation；显式 presentation-capable 路径可以保留 presentation。
- 添加工具层测试：新增、删除、修改、覆盖、无颜色场景。

验证：

```text
pnpm --filter @zhixing/core exec tsc --noEmit
pnpm --filter @zhixing/tools-builtin exec tsc --noEmit
pnpm --filter @zhixing/tools-builtin test -- src/__tests__/edit.test.ts src/__tests__/write.test.ts
```

### 单元二：CLI 静态 diff block 渲染

目标：side-effect 成功行后展示静态 diff block。

改动：

- 新增 `DiffBlockRenderer`。
- 接入 `ToolBatchCoordinator.recordSideEffect` 或其上层 side-effect 渲染分支。
- 补渲染测试：颜色关闭、颜色开启、CJK、长行、窄列、截断。

验证：

```text
pnpm --filter @zhixing/cli exec tsc --noEmit
pnpm --filter @zhixing/cli test -- src/diff/__tests__/diff-block-renderer.test.ts src/output/__tests__/tool-batch-coordinator.test.ts
```

### 单元三：集成与体验收口

目标：真实 REPL 中 edit/write 后效果稳定，不破坏 scrollback / chrome。

改动：

- 调整摘要文案。
- 控制大 diff 折叠阈值。
- 补 e2e 或 presenter 级测试。

验证：

```text
pnpm --filter @zhixing/cli test
pnpm --filter @zhixing/tools-builtin test
pnpm cli:build
```

如工具执行上下文或事件类型变化影响上游，再跑：

```text
pnpm build
```

## 风险与裁决

### 是否把 diff 放进 `content`

不放。

原因：`content` 是 LLM-facing，塞大 diff 会污染上下文、增加 token、诱导模型复述。UI diff 应该是 renderer-facing presentation artifact。

### 是否把 diff artifact 放进 `ToolResult.presentation`

放。

原因：`tool_end` 已经携带完整 `ToolResult`，CLI 本来消费这条 renderer-facing 流。把结构化 artifact 放进 `presentation` 可以复用现有事件通道，避免 sink、`toolUseId` 回捞、Map 清理和上下文注入。边界由 `trackMessages` 与默认跨接入面出口剥离来保证。

### 是否发送给 Feishu 等其他接入面

不发送。

原因：Feishu 不具备终端 diff block 的展示语义，也不应接收 CLI 专属 ANSI/hunk 数据。其他接入面只收到普通短摘要；未来如果需要卡片化 diff，必须单独设计该通道自己的展示模型。

### 是否保留 presentation sink

不做。

原因：sink 会把一个可选展示字段升级成旁路基础设施：需要注入 `ToolExecutionContext`、透传 `toolUseId`、维护 artifact Map、处理生命周期清理。`ToolResult.presentation` 随 `tool_end` 事件直达 CLI，结构更简单，未来图片预览、表格、图表、网页预览也能复用同一模型。

### 是否让 RPC / channel 默认透传 presentation

不做。

原因：当前系统存在原样传递 `AgentYield` 的出口，`tool_end.result.presentation` 如果不剥离，会变成跨接入面展示协议。默认出口必须调用统一 public-yield sanitizer，只传短摘要；只有明确声明 presentation-capable 的本地渲染面才可以接收。

### 是否让各接入面自己剥离 presentation

不做。

原因：分散剥离会形成漂移点，未来新增字段或新增展示 artifact 时容易漏一个通道。剥离必须是单一函数、单一测试面、所有默认公开出口复用。

### 是否用 git diff

不作为主路径。

原因：工具可能编辑未跟踪文件、临时文件、非 git 工作区文件；git diff 也无法精确绑定某一次工具调用。可以作为人工验证命令，但不是 UI 数据源。

### 是否让工具自己调用 `commitToUser`

不建议作为主路径。

原因：工具层不应写 ANSI UI；不同接入面的展示需求不同。工具只产结构化 artifact，CLI 负责渲染。

### 是否第三方库直接渲染终端 diff

不采用。

原因：会绕过现有 `CliWriter` / `ScreenController` / 宽度合约，容易破坏主 REPL 屏幕模型。

## 成功标准

完成后，用户在 CLI 里能清楚看到 agent 对文件做了什么：

- 不打开文件也能扫到变更片段。
- 不被整个文件刷屏。
- 增删改颜色清晰。
- 行号可定位。
- 长 diff 可控折叠。
- 终端 chrome 和 scrollback 不乱。

这是一项 CLI 基础体验能力，不是锦上添花。它直接服务用户对 agent 行动的信任感。
