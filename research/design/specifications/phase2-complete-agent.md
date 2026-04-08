# Phase 2 设计方案：从原型到可用智能体

> **状态**: 📐 方案设计（2026-04-08）
> **前置**: Phase 1 全部完成（Agent Loop + Provider + 基础工具 + CLI）
> **信息来源**: OpenClaw 源码分析 + Claude Code 社区逆向分析

## 一、总体目标

将知行从"能对话的原型"变成"能干活的编码助手"。具体标志：

1. 能精确编辑文件（而非全量重写）
2. 能搜索文件和代码内容
3. 长对话不崩溃（上下文管理）
4. API 故障能自动恢复（容错）
5. 对话可以保存和恢复（持久化）

## 二、竞品方案对比与知行策略

### 2.1 Edit 工具

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 核心机制 | `edit`（oldText/newText）+ `apply_patch`（结构化 patch） | `str_replace`（old_string/new_string） | **str_replace 为主**，简洁且经过验证 |
| 多重匹配 | pi-coding-agent 内部处理 | 返回 "ambiguous match" 错误 | **明确报错 + 报告匹配数和位置**，帮助 LLM 缩小范围 |
| 零匹配 | `wrapEditToolWithRecovery` 重读文件重试 | 返回 "text not found" 错误 | **报错 + 显示文件前几行**，引导 LLM 重新读取 |
| 批量替换 | 不支持 | 不支持 | **支持 `replace_all` 参数**（如重命名变量） |
| 别名支持 | 6 个别名 | 2 个参数 | **不做别名**，schema 清晰即可，LLM 不需要猜参数名 |

**知行超越点：**
- 多重匹配时报告具体行号和计数，让 LLM 能用更长的上下文字符串精确定位
- `replace_all` 模式解决变量重命名等高频需求（Claude Code 必须多次调用或用 Bash sed）
- 不搞别名——参数名明确，降低 LLM 出错概率

### 2.2 Glob 工具

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 实现 | 闭源（pi-coding-agent） | JS 实现（内部用 bfs） | **Node.js `glob` 包**，成熟稳定 |
| 结果上限 | 未知 | 100 个文件 | **200 个文件**，附加截断提示 |
| 排序 | 未知 | 按修改时间 | **按修改时间**（同 Claude Code，最近修改最相关） |
| 排除规则 | 未知 | 排除 .git/.svn | **排除 .git/node_modules/dist** + 尊重 .gitignore |

**知行超越点：**
- 自动排除常见噪音目录（node_modules、dist、.git 等）
- 尊重 `.gitignore`，结果更干净
- 返回文件大小，帮助 LLM 判断是否需要分段读取

### 2.3 Grep 工具

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 实现 | 闭源 + 部分靠 exec grep | 基于 ripgrep 子进程 | **基于 ripgrep**（安装为可选依赖，降级为 Node.js 内置） |
| 输出模式 | 未知 | 3 种（files_with_matches/content/count） | **3 种**（同 Claude Code，已验证好用） |
| 默认输出 | 未知 | files_with_matches | **content**（直接展示匹配，更符合"搜索"直觉） |
| 结果上限 | 未知 | 20,000 字符 / 250 条 | **30,000 字符 / 300 条**（与 bash 工具的 maxResultChars 对齐） |
| 上下文行 | 未知 | -C/-B/-A | **支持 -C/-B/-A**，默认 -C 2 |

**知行超越点：**
- 默认展示内容而非文件名，减少一步操作
- ripgrep 不可用时优雅降级为 Node.js 内置搜索
- 上下文行默认 2（Claude Code 默认 0，经常需要手动指定）

### 2.4 容错与重试

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 429 处理 | 换 auth profile | 重试同模型 3 次 → 换模型 | **指数退避 + 可选 provider failover** |
| 退避算法 | 有代码但主循环未使用 | 未明确 | **指数退避 × jitter**，基础 1s，最大 60s |
| 超时处理 | LLM 超时 → compaction | 90s 空闲超时 → 非流式降级 | **60s 空闲超时 → 重试一次** |
| 断路器 | overflow compact 最多 3 次 | auto-compact 失败 3 次停止 | **通用断路器：可配置失败次数和冷却期** |
| Failover 层级 | 在 Agent Loop 外层 | 在 query() 内部 | **在 Agent Loop 外层**（Resilience 层职责） |

**知行超越点：**
- 真正使用指数退避（OpenClaw 有代码但没用，Claude Code 策略不公开）
- 通用断路器模式，不只用于 compaction
- Resilience 层独立于 Agent Loop，关注点清晰分离

### 2.5 会话持久化

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 格式 | JSONL（含 header/branch 元数据） | JSONL（含 type 标签） | **JSONL（简化版）**，每行一条消息 |
| 存储位置 | `~/.openclaw/agents/<id>/sessions/` | `~/.claude/projects/<hash>/` | **`~/.zhixing/sessions/<id>.jsonl`** |
| 索引 | 无独立索引 | sessions-index.json | **内联元数据**（首行是 session header） |
| 持久化时机 | 流式写入 | 用户消息阻塞写/助手消息异步写 | **turn_complete 时写入**（一轮完整才持久化） |
| 恢复 | pi-coding-agent 内部 | `--resume` 扫描 + 时间排序 | **`zhixing --resume [id]`**，支持指定 session |

**知行超越点：**
- 首行 header 包含 session 元信息（创建时间、model、provider），无需额外索引文件
- Turn 级粒度写入（不是消息级），一轮要么完整保存要么不保存，避免残留状态
- `--resume` 不带 id 时显示最近 10 个 session 让用户选择

### 2.6 上下文管理

| 维度 | OpenClaw | Claude Code | **知行策略** |
|------|----------|-------------|-------------|
| 层数 | 1 层（委托 pi） | 5 层（Snip/Micro/Collapse/Auto） | **3 层**（渐进实现，不过度设计） |
| Token 计数 | 依赖 API 返回 | 权威计数 + 保守估算 | **字符估算**（Phase 2）→ **API 返回值校准**（Phase 3） |
| 触发机制 | overflow 后触发 | 主动监控 + 阈值触发 | **主动监控**（不等 413 才反应） |
| 断路器 | 3 次 overflow compact | 3 次 auto-compact 失败 | **3 次**（与两者一致） |

**知行 3 层策略：**

```
L1: ToolResult 截断（免费，轻量）
  ├ 对历史中超过 N 轮的 tool_result，截断为前 500 字符 + 摘要
  └ 触发：每轮 turn_complete 时检查

L2: 早期消息丢弃（免费，激进）
  ├ 保留首条 user 消息 + 最近 N 轮，中间的丢弃
  └ 触发：估算 token > 阈值 × 0.8

L3: LLM 摘要压缩（昂贵，高质量）
  ├ fork 子对话请求 LLM 生成摘要，替换早期消息
  └ 触发：L2 后估算 token 仍超阈值 × 0.9
  └ 断路器：连续 3 次失败停止
```

**知行超越点：**
- 3 层而非 5 层，降低实现复杂度
- L1 逐轮检查而非等溢出，更平滑
- 不做 Microcompact 的缓存 pinning（MVP 阶段 prompt cache 不是瓶颈）
- 预留 L3 的 9 部分摘要模板（借鉴 Claude Code），但 Phase 2 先用简单 prompt

## 三、渐进实现路线

每个步骤独立可验证，不依赖后续步骤。

### Phase 2A — 完整工具集

```
2A-1: Edit 工具（StrReplace）
  输入: path, old_string, new_string, replace_all?
  验证: 单元测试覆盖 零匹配/单匹配/多匹配/replace_all/空new_string(删除)
  交付: packages/tools-builtin/src/edit.ts + edit.test.ts
  
2A-2: Glob 工具
  输入: pattern, path?
  验证: 单元测试覆盖 递归/排除/排序/截断
  交付: packages/tools-builtin/src/glob.ts + glob.test.ts
  依赖: glob npm 包

2A-3: Grep 工具
  输入: pattern, path?, glob?, output_mode?, context_lines?
  验证: 单元测试覆盖 正则/文件过滤/输出模式/上下文行/截断
  交付: packages/tools-builtin/src/grep.ts + grep.test.ts
  依赖: 优先 ripgrep（child_process），降级 Node.js 内置

2A-4: CLI 集成 + System Prompt 更新
  验证: zhixing -p "把 README 中的版本号改为 0.2.0" 能正确使用 Edit
  交付: run-agent.ts 注册新工具 + system-prompt.ts 更新工具列表
```

### Phase 2B — 基础容错

```
2B-1: 指数退避重试
  位置: packages/core/src/loop/ 新增 retry.ts
  机制: Agent Loop 内拦截可恢复错误，指数退避重试
  验证: mock 429 → 自动重试 → 成功
  不修改 agent-loop.ts 主逻辑，通过 deps.callLLM 包装实现

2B-2: Token 估算
  位置: packages/core/src/context/ 新增 token-estimator.ts
  机制: 字符数 / 4 的经验公式（后续可接 tiktoken）
  验证: 对比 API 返回的真实 token 数，误差 < 30%

2B-3: 上下文预警
  位置: Agent Loop yield 新增 context_warning 事件
  机制: 每轮结束时估算 token，超阈值（80%）时 yield warning
  验证: 50 轮 mock 对话，收到 warning 事件
```

### Phase 2C — 会话持久化

```
2C-1: JSONL 序列化
  位置: packages/core/src/session/ 新增 serializer.ts
  格式: 首行 header + 后续每行一条消息
  验证: serialize → deserialize = 原始数据

2C-2: Session Store
  位置: packages/core/src/session/ 新增 store.ts
  接口: save(id, messages) / load(id) / list() / delete(id)
  存储: ~/.zhixing/sessions/<id>.jsonl
  验证: save → load → 内容一致

2C-3: CLI 集成
  功能: --resume [id] / /sessions 斜杠命令
  验证: 对话 → 退出 → resume → 上下文保持
```

### Phase 2D — 上下文管理

```
2D-1: L1 — ToolResult 截断策略
  位置: packages/core/src/context/ 新增 compaction.ts
  机制: 对超过 N 轮的 tool_result 截断为前 500 字符
  验证: 50 轮对话的 tool_result 被正确截断

2D-2: L2 — 早期消息丢弃
  机制: 保留首条 + 最近 N 轮，中间丢弃
  验证: 消息总量减少且对话可继续

2D-3: L3 — LLM 摘要压缩
  机制: fork 子对话生成摘要
  断路器: 3 次连续失败停止
  验证: 压缩后对话可继续，token 用量明显下降
```

## 四、核心类型设计（预览）

### Edit 工具

```typescript
interface EditToolInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;  // 默认 false
}

// 错误返回示例（帮助 LLM 自我修正）
// 零匹配：
// "The specified old_string was not found in <path>.
//  File has <N> lines. First 3 lines:
//  1| import { foo } from ...
//  2| ...
//  Suggestion: Use the read tool to view the file first."

// 多重匹配（replace_all=false 时）：
// "Found <N> matches for the specified old_string in <path>.
//  Matches at lines: 12, 45, 89.
//  Provide more surrounding context to make old_string unique,
//  or set replace_all=true to replace all occurrences."
```

### Retry 机制

```typescript
interface RetryConfig {
  maxRetries: number;       // 默认 3
  baseDelayMs: number;      // 默认 1000
  maxDelayMs: number;       // 默认 60_000
  jitter: boolean;          // 默认 true
  retryableErrors: string[];// ['rate_limit', 'overloaded', 'timeout']
}

// 延迟计算：min(baseDelay × 2^attempt × jitter, maxDelay)
```

### 上下文管理

```typescript
interface ContextBudget {
  maxTokens: number;          // 模型的 contextWindow
  warningThreshold: number;   // 0.8 × maxTokens
  compactThreshold: number;   // 0.9 × maxTokens
  currentEstimate: number;    // 当前估算 token 数
}

type CompactionLevel = 'tool_result_trim' | 'message_drop' | 'llm_summary';
```

## 五、文件结构规划

```
packages/
  tools-builtin/src/
    edit.ts          ← 2A-1
    glob.ts          ← 2A-2
    grep.ts          ← 2A-3
    __tests__/
      edit.test.ts
      glob.test.ts
      grep.test.ts
  
  core/src/
    loop/
      retry.ts       ← 2B-1（LLM 调用重试包装器）
    context/
      token-estimator.ts  ← 2B-2
      budget.ts           ← 2B-3
      compaction.ts       ← 2D-1/2/3
    session/
      serializer.ts  ← 2C-1
      store.ts       ← 2C-2
```

## 六、设计原则

1. **渐进增强，不重构**：每个步骤在现有代码上添加，不修改已验证的核心
2. **错误信息即教程**：工具报错不只说"失败了"，而是告诉 LLM 怎么修正
3. **成本意识级联**：恢复和压缩都从免费选项开始（借鉴 Claude Code）
4. **不等出事才处理**：主动监控 token 预算，不等 413 才反应
5. **可验证的最小单元**：每个子步骤都有明确的验证标准
