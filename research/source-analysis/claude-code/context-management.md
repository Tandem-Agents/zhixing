# Claude Code — 上下文管理与 Token 估算

> **所属系统**: Claude Code | **分析状态**: ✅ 已分析（2026-04-08）
> **信息来源**: 社区逆向分析（v2.1.68–v2.1.91）、GitHub Issues、claude-code-from-source.com

## 模块定位

Claude Code 拥有业界最复杂的上下文管理系统——5 层分级压缩、9 段摘要模板、API 校准的 Token 计数、以及配套的熔断保护。这是其能支持超长编码会话的核心能力。

## 一、Token 计数机制

### 1.1 双轨模式：权威计数 + 保守估算

Claude Code 的 Token 计数采用"信任 API、保守补充"的策略：

| 组件 | 数据源 | 用途 |
|------|--------|------|
| **权威计数** | 最近一次 API 响应的 `usage` 字段 | 确定已知的 token 消耗基线 |
| **保守估算** | 对 API 响应之后新增的消息做偏高估计 | 确保 compact 略早而非略晚触发 |

关键函数 `tokenCountWithEstimation`：
- 锚定最近一次 API 返回的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
- 对新增消息用保守系数估算
- 总量 = 权威基线 + 新增估算

### 1.2 不使用 tiktoken

公开资料中未发现 tiktoken 依赖。这与 OpenClaw 一致——两个产品都选择了轻量级估算而非精确分词。

### 1.3 关键评价

| 优点 | 缺点 |
|------|------|
| API 值作为锚，精度高 | 新增消息的估算仍是启发式 |
| 保守倾向，宁可早压缩 | 过度保守会浪费上下文空间 |
| 考虑了 cache/thinking 口径 | 不同模型的 token 化差异未处理 |

## 二、上下文预算公式

### 2.1 有效窗口

```
effectiveContextWindow = contextWindow - min(modelMaxOutput, 20_000)
```

`min(maxOutput, 20_000)` 的设计意图：防止大额 `max_output_tokens`（如 100K）把可用输入空间压到极小。20K 上限是经验值。

### 2.2 三条阈值线

```
                    ┌─── 总 contextWindow ───────────────────┐
                    │                                         │
                    │  ┌─── effectiveContextWindow ──────┐    │
                    │  │                                  │    │
 ──────────────────┤  ├──────┤────────────┤───────┤──────┤    │
                    │  │      │            │       │      │    │
                    │  │  可用空间  │  auto-compact │ 硬挡  │ 输出 │
                    │  │      │   buffer   │buffer │预留  │    │
                    │  │      │  (13K)     │(3K)   │      │    │
                    │  └──────┴────────────┴───────┴──────┘    │
                    └─────────────────────────────────────────┘

auto-compact 触发：token 数 ≥ effectiveContextWindow - 13,000
硬挡（blocking）：token 数 ≥ effectiveContextWindow - 3,000
```

### 2.3 环境变量覆盖

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（1-100）：将 auto-compact 触发点改为 `floor(effectiveWindow * pct/100)`，但不能比默认阈值更晚（只能更激进）。

## 三、5 层分级压缩

### 3.1 层级概览

每次 API 调用前，消息按顺序经过以下层级处理。**顺序不可调换**（设计意图）。

| 层 | 名称 | 成本 | 触发时机 | 机制 |
|----|------|------|----------|------|
| L0 | `applyToolResultBudget` | 免费 | 每次 API 调用前 | 按工具裁剪单条结果（50K 字符/100K token），聚合上限 200K 字符 |
| L1 | Snip compact | 免费 | 条件触发 | 物理删除早期消息，通知 UI |
| L2 | Microcompact | 免费 | 每次序列化前 | 按 `tool_use_id` 配对，清空不再需要的 tool result |
| L3 | Context collapse | 免费/低成本 | 阈值触发 | 用摘要替换对话中的部分片段（不是全文） |
| L4 | Auto-compact | 昂贵 | 阈值触发 | Fork 子对话，用 9 段模板做全文摘要 |

### 3.2 L0：工具结果预算

```
per-tool limit:     ~50,000 chars / ~100,000 tokens
per-message limit:  ~200,000 chars（防止多工具并行撑爆单轮）
```

超出后的策略：
- **落盘**：结果写入临时文件，上下文中只保留文件路径引用
- **截断 + 提示**：截断后附加"结果已截断，使用 read 工具查看完整内容"

MCP 工具可通过 `_meta["anthropic/maxResultSizeChars"]` 提高单工具上限（最高 500K）。

### 3.3 L2：Microcompact 细节

- 保护最近 ~40K token 的 tool result（不压缩）
- 始终保留最后 3 条 tool result
- 节省量 > 20K token 时才值得执行
- 清空方式：替换为占位字符串或写临时文件后提示再读
- **缓存感知**：cached microcompact 会等 API 响应的 `cache_deleted_input_tokens` 确认真实释放量

### 3.4 L3 vs L4 的区别

| 维度 | L3 Context Collapse | L4 Auto-compact |
|------|--------------------|--------------------|
| 范围 | 局部片段 | 完整历史 |
| 粒度 | 替换若干连续消息 | 全文 9 段摘要 |
| 目的 | 尽量避免 full compact | 最终手段 |
| 执行顺序 | 在 L4 之前 | 最后 |

L3 故意排在 L4 之前：如果 collapse 后已低于阈值，可以跳过昂贵的 full compact。

### 3.5 L4：9 段摘要模板

Full auto-compact 要求 LLM 生成包含 9 个编号章节的摘要：

1. **Primary Request and Intent** — 用户的核心目标
2. **Key Technical Concepts** — 涉及的技术概念
3. **Files and Code Sections** — 文件路径、关键代码片段、函数签名
4. **Errors and Fixes** — 遇到的错误及修复方案
5. **Problem Solving** — 解决问题的思路和尝试
6. **All User Messages** — 所有非 tool result 的用户原话（列表）
7. **Pending Tasks** — 尚未完成的任务
8. **Current Work** — 当前正在进行的工作
9. **Optional Next Step** — 建议的下一步（与最近用户意图一致）

压缩后还会：
- 注入 **continuation 用户消息**（告知 LLM"之前的对话已被压缩"）
- **Rehydration**：重新注入最近读过的文件、plan、skills 等

### 3.6 Reactive Compact（413 应急）

当主动压缩失败或关闭时，收到 `413 / prompt_too_long` 后触发：
- 使用 `hasAttemptedReactiveCompact` 标记，**同类错误只尝试一次**
- 流式路径对 `prompt_too_long` 做 **withholding**（暂不暴露给消费者），给恢复逻辑时间

## 四、熔断器

### 4.1 Auto-compact 熔断

```
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

连续 3 次 auto-compact 失败后停止尝试，成功一次则清零。

### 4.2 历史问题

GitHub Issue #42055 记录：早期版本中 `consecutiveFailures` 会递增但**不在尝试前检查**，导致 compaction 失败时每轮都重试，单会话出现数千次失败。社区补丁修复了这个问题。

## 五、关键设计模式总结

| 模式 | 描述 |
|------|------|
| **API 锚定 + 保守估算** | Token 计数以 API 返回为准，新增消息保守估算 |
| **5 层递进压缩** | 从免费（截断）到昂贵（LLM 摘要），按需升级 |
| **成本优先级联** | 先做免费操作，最后才动用 API 调用 |
| **缓存感知** | Microcompact 会考虑 prompt cache 边界 |
| **结构化摘要** | 9 段模板确保压缩后不丢关键信息 |
| **熔断保护** | 3 次连续失败停止，防止成本失控 |
| **Reactive 兜底** | 主动压缩失败时，413 触发应急压缩 |
| **可配置阈值** | 环境变量可调整 auto-compact 触发点 |

## 六、9 段摘要 Prompt 模板详解

### 6.1 九个章节

| # | 章节标题 | 要求 |
|---|---------|------|
| 1 | Primary Request and Intent | 逐条覆盖用户的明确请求与意图 |
| 2 | Key Technical Concepts | 技术栈、框架、关键概念 |
| 3 | Files and Code Sections | 读/改/建的文件，**完整代码片段**，每个的重要性 |
| 4 | Errors and Fixes | 错误、用户反馈、被要求改做法的地方 |
| 5 | Problem Solving | 已解决 + 仍在排查的问题 |
| 6 | All User Messages | **所有**非 tool result 的用户消息原文列表 |
| 7 | Pending Tasks | 被明确要求但未完成的事项 |
| 8 | Current Work | 压缩前正在做的事，含文件名与代码片段 |
| 9 | Optional Next Step | 与最近用户请求一致的下一步，需**引用原文**减少任务漂移 |

### 6.2 Prompt 结构

- **System prompt**：`You are a helpful AI assistant tasked with summarizing conversations.`
- **消息列表**：**完整对话历史**
- **最后追加 user 消息**：摘要任务指令，要求先输出 `<analysis>` 做时间线分析，再输出 `<summary>` 的 9 段结构
- **关键约束**：`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.`

### 6.3 缓存优化

**复用同一 system prompt + 工具列表**：压缩调用不换 system prompt，把摘要指令作为末尾 user 消息追加，最大化 prompt cache 命中率。

### 6.4 Partial vs Full Compact

| 维度 | Full compact | Partial compact |
|------|-------------|-----------------|
| 范围 | 整段历史 | 只摘要"最近一段"，更早的保留 |
| 第 8/9 节 | Current Work / Next Step | Work Completed / Context for Continuing Work |

### 6.5 Sub-agent 摘要（5 段）

子 Agent 用更短的 5 段模板：

1. **Task Overview** — 核心请求、成功标准、约束
2. **Current State** — 已完成内容、文件与路径、关键产出
3. **Important Discoveries** — 约束、决策、错误、无效尝试
4. **Next Steps** — 待办、阻塞、优先级
5. **Context to Preserve** — 用户偏好、领域细节、承诺

### 6.6 Compaction 后续写（Continuation）

1. **续写 user 消息**：说明"会话从先前上下文耗尽处继续"，包含格式化摘要
2. **Rehydration**：重新注入最近读过的文件（约 5 个文件、~50K token 上限）、plan、skills
3. **Auto-compact 专用指令**：`Please continue the conversation from where we left off without asking the user any further questions. Continue with the last task.`

## 七、会话持久化

### 7.1 JSONL 格式

每行一条 JSON 记录，**无独立头行**（第一行通常是 `type: "system"` 记录）。

共有字段：
- `type`：记录类型（`user` / `assistant` / `tool_result` / `system` / `summary` / `result`）
- `uuid` + `parentUuid`：DAG 结构（非纯线性）
- `timestamp`、`sessionId`、`cwd`
- `message`：消息内容（含 `content` 块数组）

### 7.2 存储路径

```
~/.claude/projects/<项目路径编码>/<session-uuid>.jsonl
~/.claude/projects/<项目路径编码>/sessions-index.json
```

路径编码：绝对路径转 `-` 分隔目录名（如 `/home/user/myapp` → `-home-user-myapp`），**不是**密码学哈希。

### 7.3 sessions-index.json

含 `version` + `entries` 数组。**已知问题**：索引不随 JSONL 更新导致 `/resume` 列表过期（多个 GitHub Issue 报告）。

### 7.4 Resume / Continue

| 标志 | 行为 |
|------|------|
| `--continue` / `-c` | 加载当前目录最近的对话 |
| `--resume` / `-r` | 按 session ID 或名称恢复，不传 ID 时进入交互选择器 |
| `--name` / `-n` | 会话显示名，可用名称恢复 |
| `--fork-session` | 与 resume/continue 联用，新建 ID 而非沿用旧 ID |
| `--no-session-persistence` | 不写盘、不可恢复 |

### 7.5 写入时机

JSONL 按行追加。具体 fsync 策略未公开，但按追加模式持久化，单条损坏不影响其余记录。

## 引用

- [Claude Code from Source - Ch.5 Agent Loop](https://claude-code-from-source.com/ch05-agent-loop/)
- [Claude Code from Source - Ch.17 Performance](https://claude-code-from-source.com/ch17-performance/)
- [sam-saffron gist (v2.1.68 反混淆)](https://gist.github.com/sam-saffron-jarvis/9d8e291c4e696ac7948702d6c4884448)
- [GitHub Issue #42055 (auto-compact 熔断)](https://github.com/anthropics/claude-code/issues/42055)
- [GitHub Issue #42542 (microcompact 可见性)](https://github.com/anthropics/claude-code/issues/42542)
