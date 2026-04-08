# OpenClaw — 工具系统分析

> **分析状态**: ✅ 已完成（2026-04-08）

## 核心工具实现

### Edit 工具（精确子串替换）

OpenClaw 的编辑能力分两层：

**1. `edit` 工具（来自 pi-coding-agent）**

参数接口（多别名兼容）：

| 参数 | 别名 | 说明 |
|------|------|------|
| `path` | `file_path`, `filePath`, `file` | 目标文件 |
| `oldText` | `old_string`, `old_text`, `oldString` | 要替换的精确文本 |
| `newText` | `new_string`, `new_text`, `newString` | 替换后的文本（允许空字符串 = 删除） |

关键行为：
- 精确字符串匹配，不支持正则
- 找不到 `oldText` 时返回错误 `"Could not find the exact text in"`
- 有 `wrapEditToolWithRecovery` 机制：失败时基于磁盘重读文件内容做恢复/再执行

**2. `apply_patch` 工具（OpenClaw 自实现）**

位于 `src/agents/apply-patch.ts`，是一种结构化 patch 格式：

```
*** Begin Patch
*** Update File: src/foo.ts
@@ context line @@
-old line
+new line
*** End Patch
```

支持操作：Add / Delete / Update / Move（重命名）

启用条件受限：仅对 OpenAI 兼容的 provider 且特定模型允许列表开启

校验机制：
- 空输入、AbortError、patch 边界不合法（首行必须 `*** Begin Patch`）
- 工作区路径守卫（`assertSandboxPath`），防止写出沙箱外
- 文件写入通过 `writeFileWithinRoot` 限制

### Read 工具

来自 pi-coding-agent，OpenClaw 包了一层加入沙箱守卫和自适应分页：

| 常量 | 值 | 说明 |
|------|-----|------|
| `DEFAULT_READ_PAGE_MAX_BYTES` | 50 KiB | 默认单页大小 |
| 自适应上限 | 512 KiB | 按模型 context 窗口估算 |
| `ADAPTIVE_READ_CONTEXT_SHARE` | 0.2 | 读取内容占上下文的最大比例 |
| `MAX_ADAPTIVE_READ_PAGES` | 8 | 最大分页数 |

### Glob / Grep 工具

**来自 pi-coding-agent 闭源包**，OpenClaw 仓库内无自实现。仅在 prompt 场景列表中可见它们的名称。部分文件搜索能力也通过 `exec` 工具调用宿主 `grep -R` 命令实现。

## 重试与韧性

### 架构

```
外层 while(true) 循环
  ├── 迭代上限: 32~160 次（基础 24 + 每 auth profile 8）
  ├── 429 / rate_limit → rotate auth profile → 继续
  ├── overloaded → 可选固定 backoff（默认 0ms）→ 继续或 throw FailoverError
  ├── auth 失败 → 换 profile → 继续
  ├── context overflow → compact → 继续（最多 3 次）
  └── 无法恢复 → throw FailoverError → 外层 fallback 到其他模型
```

### 429 处理策略

- HTTP 429 → 分类为 `rate_limit`
- 文本匹配：`429`、`rate_limit`、`too many requests`、`tpm`
- **主要靠换 auth profile 解决，而非指数退避**
- 有 `computeBackoff`（指数 × jitter）函数在 `src/infra/backoff.ts`，但主循环未使用

### Overload 退避

```typescript
const maybeBackoffBeforeOverloadFailover = async (reason) => {
  if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) return;
  await sleepWithAbort(overloadFailoverBackoffMs, params.abortSignal);
};
// 默认 overloadedBackoffMs = 0（即默认不退避）
```

### 模型 Failover

- Profile 轮换超限（`overloadedProfileRotations`）→ `throw FailoverError`
- 外层 catch FailoverError → 切换到备选模型
- Thinking 级别可降级（`pickFallbackThinkingLevel`）

## 会话持久化

- 格式：**JSONL**，每个 session 一个文件
- API：`SessionManager.open(sessionFile)` 来自 pi-coding-agent
- 存储路径：`~/.openclaw/agents/<agentId>/sessions/`
- JSONL 内容：message + header + compaction 元数据 + model_change + branch 信息
- Compaction 后可物理截断旧 message（`truncateAfterCompaction`）
- 备份机制：`.bak.` / `.deleted.` / `.reset.` 旁路文件

## 上下文管理

### Context Engine 架构

- 可插拔引擎：`registerContextEngine` 替换默认实现
- Legacy 引擎的 `compact` 方法委托给 `compactEmbeddedPiSessionDirect`
- 插件/第三方引擎可通过 Hook 接管 compaction

### Overflow 检测

- `isLikelyContextOverflowError`：多关键词匹配 + 排除 TPM/429 误判
- overflow → 最多 3 次 `contextEngine.compact({ force: true, trigger: "overflow" })`
- 3 次失败后尝试工具结果截断，再失败则返回用户可见的 overflow 错误

### 上下文窗口守卫

| 阈值 | 值 |
|------|-----|
| 硬下限 | 16K tokens |
| 警告阈值 | 32K tokens |

### Compaction 配置

`reserveTokens`、`keepRecentTokens`、`reserveTokensFloor`、`maxHistoryShare`、`recentTurnsPreserve`、`qualityGuard`、`memoryFlush` 等可配置参数。

## 工具结果管理

### 核心常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MAX_TOOL_RESULT_CONTEXT_SHARE` | 0.3 | 单条结果占上下文的最大比例 |
| `HARD_MAX_TOOL_RESULT_CHARS` | 400,000 | 单条结果硬上限 |
| `MIN_KEEP_CHARS` | 2,000 | 截断后至少保留的字符数 |

### 截断算法

```
calculateMaxToolResultChars = floor(contextTokens × 0.3) × 4
取 min(计算值, 400,000)

截断策略：
  if 尾部像 error/JSON 结尾/summary → head + tail 保留
  else → 保留开头 + 按行切断
  统一添加截断后缀说明
```

### 分层处理

- **会话级**：`truncateOversizedToolResultsInSession` — 重写 JSONL 中过大的条目
- **内存级**：`truncateOversizedToolResultsInMessages` — 发送模型前裁剪（不持久化）
- **与 overflow 联动**：auto-compaction 无效时尝试一次会话内截断再重试

## 设计模式总结

| 模式 | 评价 |
|------|------|
| edit 的 oldText/newText + recovery 包装 | 实用，recovery 是亮点 |
| apply_patch 结构化 patch | 强大但仅限特定 provider/模型 |
| 重试靠 auth profile 轮换，不靠指数退避 | 不够通用 |
| Context Engine 可插拔 | 扩展性好 |
| 工具结果分层截断 | 设计精良 |
