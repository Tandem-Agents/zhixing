# Claude Code — 工具系统分析

> **分析状态**: ✅ 已完成（2026-04-08）
> **信息来源**: 2026-03-31 npm source map 泄露后的社区逆向分析

## Edit 工具（FileEditTool / str_replace）

### 接口

| 参数 | 类型 | 说明 |
|------|------|------|
| `file_path` | string | 目标文件路径 |
| `old_string` | string | 精确匹配的原始文本 |
| `new_string` | string | 替换后的文本（空字符串 = 删除） |

API 层面额外支持 `view`、`create`、`insert` 命令（text_editor_20250728），但内部 Claude Code 主要用 str_replace 范式。

### 验证机制

**三态匹配检查：**
- 零匹配 → 返回错误 "text not found"，强制模型重回 gather 阶段重新读取文件
- 多重匹配 → 返回错误 "ambiguous match"，拒绝执行
- 恰好一次匹配 → 执行替换

**设计原则：**
- 仅使用精确字符串匹配，**不支持正则表达式**
- 所有空白字符（空格、Tab、换行）都参与匹配，不做任何标准化
- 失败时 fail loudly，迫使模型重新读取文件获取正确上下文

**统计数据：** str_replace 操作的错误率约 ~13%，其中 77% 的失败是因为 `old_string` 不存在

### 安全与并发

- 完整安全检查链：自治门控 → 速率限制 → 路径验证 → 规范化 → 符号链接保护 → 操作记录
- `isConcurrencySafe = false` — 文件编辑必须串行执行

## Glob 工具（GlobTool）

### 接口

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | Glob 模式（如 `**/*.ts`） |
| `path` | string | 搜索起始目录（默认 CWD） |

### 行为

- 默认截断上限：**100 个文件**
- 结果按**修改时间**排序（最近修改优先）
- `isConcurrencySafe = true` — 并行安全
- 内部构建版使用 `bfs`（高性能原生搜索），外部构建用 JS 实现

## Grep 工具（GrepTool）

### 接口

| 参数 | 类型 | 说明 |
|------|------|------|
| `pattern` | string | 正则表达式 |
| `path` | string | 搜索目录（默认 CWD） |
| `glob` | string | 文件过滤 glob（如 `*.ts`） |
| `output_mode` | enum | `files_with_matches`（默认）/ `content` / `count` |
| `context` / `context_before` / `context_after` | number | 上下文行数 |
| `case_insensitive` | boolean | 大小写不敏感 |
| `head_limit` | number | 最大结果数（默认 250） |
| `offset` | number | 跳过前 N 个结果（分页） |
| `multiline` | boolean | 多行模式 |
| `file_type` | string | ripgrep 文件类型 |

### 底层实现

基于 ripgrep (`rg`) 子进程调用：

```
--hidden                    # 始终搜索隐藏文件
--glob !.git --glob !.svn   # 排除版本控制目录
--max-columns 500           # 行截断上限 500 字符
```

关键特性：
- 结果上限 **20,000 字符**
- 默认输出模式 `files_with_matches` — 鼓励两阶段工作流（先找文件，再读内容）
- `isConcurrencySafe = true`
- 内部构建版使用 `ugrep` 替代

## 重试与弹性

### 错误恢复级联（从低成本到高成本）

**Prompt-Too-Long (413) 恢复 — 3 阶段：**

```
阶段 1: Context Collapse 排空（成本: 0）
  └ 已准备好的候选块立即提交压缩
阶段 2: Reactive Compact（成本: 1 次 API 调用）
  └ 摘要整个对话，去除图片，重试
  └ 如果摘要本身太大，移除媒体后再试（strip retry）
阶段 3: 报错给用户
```

**Max-Output-Tokens 恢复 — 3 阶段：**

```
阶段 1: 透明升级（成本: 0）
  └ 8K → 64K (ESCALATED_MAX_TOKENS)
阶段 2: 恢复消息注入（最多 3 次重试）
  └ "Your previous response was truncated. Please continue..."
阶段 3: 使用已有结果完成
```

### 流式超时

- 90 秒空闲超时
- 45 秒警告
- 30+ 秒无新数据 → 记录 stall 事件
- 超时或 529 → 回退到非流式模式（5 分钟本地超时）

### 模型回退链（5 层）

```
重试同一模型（3 次）
  → 更便宜的替代模型（Sonnet → Haiku）
    → 同级别旧版本
      → 记录并优雅降级
```

回退时创建 tombstone 消息，为丢弃的工具调用保持对话历史一致性。

### 断路器

```
MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// 3 次连续压缩失败 → 跳过所有后续压缩
```

## 会话持久化

### 存储结构

```
~/.claude/
  ├── projects/
  │   └── <project-path-hash>/
  │       ├── <session-id>.jsonl
  │       └── sessions-index.json
  ├── settings.json
  └── CLAUDE.md
```

### JSONL 格式

```jsonl
{"type": "user", "message": {...}, "timestamp": "..."}
{"type": "assistant", "message": {...}, "usage": {...}}
{"type": "tool_use", "tool": "FileReadTool", "input": {...}}
{"type": "tool_result", "output": "...", "error": null}
```

### 非对称持久化策略

- 用户消息：**阻塞保存**（`await recordTranscript`）— resume 恢复必需
- 助手消息：**发后即忘**（`recordTranscript` 无 await）— 不是恢复必需品

### /resume 恢复

1. 识别当前项目 → 扫描 `projects/` 目录
2. 按修改时间排序 `.jsonl` 文件
3. 顺序加载重建完整对话上下文

## 上下文管理（5 层压缩）

### 层级概览

| 层 | 名称 | 成本 | 信息损失 | 缓存影响 |
|---|------|------|---------|---------|
| L0 | Tool Result Budget | 免费 | 低 | 无 |
| L1 | Snip Compact | 免费 | 高 | 无 |
| L2 | Microcompact | 免费 | 中 | 通过 pinning 最小化 |
| L3 | Context Collapse | 低 | 中 | 最小 |
| L4 | Auto-Compact | 高（额外 API 调用） | 低 | 完全重置 |

### L0: Tool Result Budget

- 每个工具结果有大小上限（最高 500K 字符）
- 超限：保留 2KB 内联预览 + 完整内容写入磁盘 + 提供文件路径

### L1: Snip Compact

- 免费，信息损失高
- 直接丢弃较旧的整块消息
- 主要用于无头/后台会话

### L2: Microcompact（530 行）

- 免费，针对个别工具结果操作
- 清除目标：`file_read`, `shell`, `grep`, `glob`, `web_search`, `web_fetch`, `file_edit`, `file_write`
- 替换为 `"[Old tool result content cleared]"`
- **关键创新：缓存编辑块固定（Cache Edit Block Pinning）**
  - 跟踪哪些结果在缓存前缀范围内
  - 排除缓存范围内的结果
  - 缓存范围移动后才清除候选

### L3: Context Collapse

- 两阶段操作（类似 Git 的提交模型）
- Preview：扫描对话，标记可折叠的消息块
- Commit：实际折叠。**关键：原始消息永不修改**，折叠结果存储在 collapse store，API 调用时通过 `projectView()` 叠加
- 在 Auto-Compact 之前运行，可能避免昂贵的 API 调用

### L4: Auto-Compact（351 行）

触发阈值：

```
effectiveContextWindow = contextWindow - min(modelMaxTokens, 20_000)
autoCompactThreshold = effectiveContextWindow - 13_000
// 200K context 模型：200K - 20K - 13K = 167K tokens
```

生成 **9 部分叙事摘要**：
1. 主要请求和意图
2. 关键技术概念
3. 文件和代码段（含片段）
4. 错误和修复
5. 问题解决（已解决 + 进行中）
6. 所有用户消息
7. 待办任务
8. 当前工作
9. 可选的下一步

摘要后恢复：
- 恢复最多 5 个最近读取的文件（50K token 预算，每文件 5K）
- 重新注入活跃 skill 内容（25K token 预算）

### 警告状态机（4 阶段）

```
Normal → Warning（-20K）→ Error（-20K）→ AutoCompact（-13K）→ BlockingLimit（-3K）
```

## 工具结果预算

- Per-tool 上限：可配置，默认通过 `_meta["anthropic/maxResultSizeChars"]` 注解
- 超限处理：2KB 内联预览 + 完整内容写入 `~/.claude/` 下的临时文件
- 已知 bug：持久化文件包含格式化内容（行号等），重读触发同样的"输出过大"错误

## 核心设计模式

| 模式 | 说明 |
|------|------|
| 成本意识级联 | 错误恢复/压缩都从免费选项开始 |
| 缓存优先 | 工具列表排序、Microcompact pinning、Collapse 读取时投影 |
| 流式投机执行 | 模型输出流式到达时并行执行工具 |
| Tombstone 消息 | 回退时为丢弃的工具调用留标记 |
| 粘性开关 | 功能标志激活后在会话内保持，避免破坏缓存 |
