# Tool Result Anchor — 工具结果的焦点完整 + 消化后归档

> ⚠️ **DEPRECATED（2026-05-11 起）**
>
> 锚化历史 tool_result 会改写消息字节，破坏 Anthropic prompt cache 元规则①（前缀稳定）。v3 改为段切换时 tool_result raw 一并消化进摘要，平时不动 tool_result。见 [`../design/specifications/context-management-v3-redesign.md`](../design/specifications/context-management-v3-redesign.md) §九 invariant 1。本文保留为决策痕迹，不再作为实施依据。
>
> ---
>
> 知行设计沉淀 · 重新审视"tool_result 持久完整保留"的隐含假设
>
> 沉淀于 2026-05-08

---

## 一、问题背景

cli REPL 中，每次工具调用后，LLM 看到的 `tool_result` 完整内容会一直保留在 messages 历史中。

具体例子：
- 用户："帮我看下 src/foo.ts"
- LLM 调 `read("src/foo.ts")` → 返回 5000 行 / ~30K 字符
- cli 把完整 5000 行塞入 messages 作为 tool_result
- LLM 第一次看：完成 reason → 输出 "这个文件主要负责..."
- 之后用户问任何问题（哪怕完全无关）→ messages 中那 5000 行**仍在**，每轮 LLM 调用都重新发送

长 agent 任务累积更明显——读 5 个文件 + bash 跑 3 次 + grep 搜 2 次，messages 中可能堆积 50K+ tool_result 内容。在弱模型场景下，这种累积是注意力稀释的关键来源之一。

## 二、第一性分析

LLM 看 messages 时需要的信息可分两类：

| 类型 | 例 | 持续需求 |
|---|---|---|
| **任务连贯性** | "我做过什么、得出什么结论" | 长期需要 |
| **认知输入数据** | tool_result 的完整 raw（5000 行文件） | **仅在第一次消化时需要** |

**关键观察**：LLM 第一次看到 tool_result 后，会把"得到什么结论"内化进自己输出的 assistant text。之后的 messages 中：

- assistant text 仍在 → "结论"信息仍在
- tool_result 完整 raw → 实际已成冗余（关键信息已被消化进 assistant text）

但当前设计假设 tool_result 永久价值高——这是**与认知阶段的错位**。

## 三、已知方案与各自局限

业界与我们曾考虑的方案：

| 方案 | 描述 | 局限 |
|---|---|---|
| Claude Code microcompact | 选择性截断特定工具的旧 tool_result | 无明确"消化阶段"划分，按整体 context 压力动态裁 |
| OpenClaw | head+tail 截断 + 16K 上限 + ≤30% 占比 | 对所有 tool_result 一刀切，不区分消化前后 |
| Hermes | 工具专用 summary（terminal → "cmd, exit 0, 47 lines"） | 立即生效——LLM 第一次见 result 时就只看 summary，无法 reason 出 assistant text 中的具体引用 |
| B1 仅 size 阈值 | 大于阈值就 head+tail | 与"消化状态"无关，可能裁掉关键部分 |
| B2 size + age | 按时间衰减 | "时间"≠"消化状态"——粗粒度 |
| B3 立即 summary（同 Hermes） | 一返回就 summary | 同上，第一次信息丢失 |

**共同盲点**：未识别 tool_result 价值衰减的真正轴是**消化状态**——焦点期（LLM 还没消化）vs 已消化期。

## 四、设计核心

### 4.1 两态机制

把 tool_result 按"是否被 LLM 消化过"分为两态：

| 状态 | messages 中的形态 | 触发转换 |
|---|---|---|
| **Focus** | 完整 raw 内容 | 最近一次 `tool_use` 的 result |
| **Anchor** | 事实锚（一行结构化占位） | 之后再有新的 `tool_use` 时，前一个 result 立即转 Anchor |

简化的转换规则：**当前最近的 `tool_use` 的 result 是 Focus，所有更早的 result 都是 Anchor**。

### 4.2 Focus 期：完整 raw 让 LLM 消化

LLM 第一次见 tool_result 时需要完整数据来 reason —— Focus 期 `tool_result.content` 保留原始 raw。

LLM 在这一轮的 assistant text 输出中会自然总结"我看了什么、结论是什么"——关键信息被内化进对话主线。

### 4.3 Anchor 期：事实锚替代 raw

Focus → Anchor 转换时，cli 把 messages 中该 tool_result 的 content **改写**为事实锚。

**事实锚 = 程序自动生成的结构化事实占位**。它不是 LLM 写的描述、不是 summary，而是 100% 准确的硬事实（路径、行数、退出码等数字事实）。

| 工具 | Anchor 格式 |
|---|---|
| `read` | `[read src/foo.ts, 1235 lines]` |
| `bash` | `[bash "npm test", exit=0, 47 lines]`（失败时附 last error 行） |
| `grep` | `[grep "TODO", 23 matches in 7 files]` |
| `glob` | `[glob "*.ts", 142 matches]` |
| `edit` | `[edit src/foo.ts, +L1 -L2]` |
| `write` | `[write src/bar.ts, 543 bytes]` |
| `web_fetch` | `[web_fetch <url>, ~12K content]` |

**叫"锚"的理由**：它锚定一个不会漂移的事实点——不像 LLM 写的描述可能含错觉，不像 summary 可能丢关键信息，事实锚仅暴露 100% 准确的结构化数据。

### 4.4 实现机制

cli 在每次 LLM call 之前，遍历 messages 历史：

- 找到最近一次 `tool_use` 对应的 `tool_result` → 保留完整 raw（Focus）
- 其他所有历史 `tool_result.content` → 改写为事实锚（Anchor）

LLM 完全看不出"历史被改写"——它每次都是 stateless 重新看 messages，看到的就是 cli 当下编排的视图。

### 4.5 LLM 需要原内容时怎么办

**默认重调工具**：

- `read` 重新读文件（成本极低，且能拿到最新版本，文件被改过时甚至更准）
- `grep` 重新搜（成本极低）
- `bash` 重新跑（仅限查询性命令）

**v1 不提供 recall 元工具** —— 保持简洁。LLM 重调工具的成本远低于维护 result 缓存的复杂度。如果未来发现"重调成本高的工具"（如复杂 web_fetch）有强需求，再加 `recall_result(tool_use_id)` 元工具备查。

## 五、设计哲学

> **tool_result 是认知输入的快照**——焦点时完整呈现、消化后归档为事实锚。需要细节时重做工具，把决策权还给 LLM。

类比人类：你看了一份报告，记住关键事实（多少页、结论是什么），但不会记住每一段原文。需要原文时翻报告——LLM 重调工具就是"翻报告"。

## 六、价值与对比

### 6.1 长 task 累积体积

| 方案 | T5 焦点期 | T6+ 消化后 | 长期 messages 体积 |
|---|---|---|---|
| 当前知行（满载） | 完整 raw | 完整 raw（不衰减） | 大 |
| B1 size 阈值 | 完整 / 截断 | 同左 | 大 |
| B2 size + age | 完整 | 单阶时间衰减 | 中 |
| B3 立即 summary | summary（含描述错误风险） | 同左 | 小但信息丢失 |
| **本方案 Focus + Anchor** | **完整 raw**（让 LLM 真消化） | **事实锚**（结构化占位） | **极小** |

### 6.2 单条 tool_result 体积对比

以 `read("src/foo.ts")` 返回 30K 字符为例：

- 当前知行：每轮 LLM call 都送 30K → 高
- 本方案 Focus 期：30K → Anchor 期：~30 chars → **降低约 99%**

短 task 后续每轮的 messages 体积差异显著。

### 6.3 与 Hermes 立即 summary 的关键差异

- **Hermes**：tool_result 一返回就替换为 summary —— LLM 第一次见时已是 summary，无法 reason 出原 raw 中的具体引用（如 "line 42 的某个变量名"）
- **本方案**：第一次见时是完整 raw —— LLM 自然消化进 assistant text，**之后**才转事实锚

这是产品体验的关键差异——本方案不让 LLM 在 reason 阶段失去任何信息。

### 6.4 与 Capability Compiler 的统一

| 维度 | Q1.A Capability Compiler | Q1.B Tool Result Anchor |
|---|---|---|
| 思想 | tools schema 不前置满载 | tool_result 不长期累积 |
| 实现 | 按需展开 schema | 按需改写 messages |
| LLM 视角 | "我能用 X 工具" | "我做了 X 操作，得到事实 Y" |
| 复杂度位置 | cli 内部 capabilityState | cli 内部 messages 改写器 |

整个上下文系统是 cli 在每次 LLM call 前**重新组装**的产物：tools 字段动态、messages tool_result 动态。LLM 看到的视图被精心编排，复杂度在 cli 层。

### 6.5 设计核心（3 点）

1. **以"消化状态"为价值衰减轴**：不是 size、不是 age，而是 LLM 是否已消化 —— 这是 tool_result 价值的真正驱动因素
2. **Focus 期不削弱信息**：第一次让 LLM 看完整 raw，避免 B3 / Hermes "立即 summary 信息丢失"的问题
3. **事实锚而非 summary**：暴露 100% 准确的结构化事实，零幻觉风险；需要描述性信息 LLM 已写在自己的 assistant text 中

## 七、关键参数（敲定）

| 参数 | 值 | 理由 |
|---|---|---|
| Focus 数量 | **仅 1**（最近一次 `tool_use` 的 result） | 简单确定；多个 Focus 反而模糊语义 |
| recall 元工具 | **v1 不提供** | LLM 重调工具成本极低；先简洁，验证后看需不需要 |

参数硬编码不开放配置——一致行为优先于灵活性。

## 八、实施路径

属于实现层（spec / 落地阶段）。本文档不展开具体代码归属、API 字段名、中间件位置等。落地时需考虑的关键钩子：

- 每次 LLM call 前，cli 检查 messages 中所有 `tool_use` 的位置——非最近的 `tool_result.content` 改写为事实锚
- 事实锚生成器（每个工具一个）—— 输入 raw 内容，输出结构化事实字符串
- 与 messages 历史的统一管理（不破坏 `tool_use` ↔ `tool_result` 配对协议）
- v1 不引入 result store（不单独保存 raw）—— 改写直接生效

落地后将转入相应 specifications/ 文档。本设计文档作为产品方向 + 哲学的源头永久保留。
