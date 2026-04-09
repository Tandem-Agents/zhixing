# Claude Code — 系统提示词与上下文组装

> **分析状态**: ✅ 已完成（2026-04-09）
> **信息来源**: 社区逆向分析（npm source map 泄露）、claude-code-from-source.com、thtskaran/claude-code-analysis
> **关联**: `architecture-overview.md`、`context-management.md`、`tool-system.md`

## 一、系统提示词结构

### 1.1 六层优先级体系

系统提示词不是单一文本，而是由 `getSystemPrompt()` + `buildEffectiveSystemPrompt()` 动态组装：

| 优先级 | 层级名称 | 说明 |
|--------|---------|------|
| 1（最高） | Override prompt | Simple Mode 时替换整个 prompt |
| 2 | Coordinator prompt | 多 Agent 协调模式 |
| 3 | Agent prompt | 子 Agent / 主动模式 |
| 4 | Custom prompt | `--system-prompt` CLI 参数 |
| 5 | Default prompt | 标准系统提示词（7 个静态段） |
| 6（始终追加） | Append prompt | 记忆、MCP、语言等动态内容 |

高层替换低层，但 **Append 层始终追加**（不受优先级影响）。

### 1.2 七个静态段落

| # | 段落 | 核心内容 | 约 Token 数 |
|---|------|---------|------------|
| 1 | Intro | 一句话身份 + 安全策略（CYBER_RISK_INSTRUCTION）+ URL 安全 | ~100 |
| 2 | System | 输出渲染规则（GFM Markdown）、权限机制、Hook 处理、压缩说明 | — |
| 3 | Doing Tasks | 先读再改、不过度工程化、不加多余功能、不做时间估计 | ~600 |
| 4 | Executing Actions with Care | 动作风险分类——本地可逆（自由执行）vs 影响大（需确认） | ~540 |
| 5 | Using Tools | 工具偏好：Read > cat, Grep > grep, Edit > sed | ~550 |
| 6 | Tone and Style | 无 emoji、简短回复、代码引用格式 | ~320 |
| 7 | Output Efficiency | 开门见山；内部用户有更严格字数限制 | — |

系统提示词文本本身约 **2,300–3,600 tokens**，加工具定义后达 **27,000–30,000 tokens**。

### 1.3 身份设定

极简，只有一句：
> "You are an interactive agent that helps users with software engineering tasks."

故意不多定义，让模型行为由工具定义和指令段约束。

### 1.4 条件段

| 段落 | 触发条件 | 额外 Token |
|------|---------|-----------|
| Auto mode | 自主模式激活 | +188 |
| Plan mode | 进入 Plan 模式 | +142 ~ +1,297 |
| Learning mode | 教学模式 | +1,042 |
| Git status | 总是注入 | +97 |
| Token Budget | FLAG 开启 | 显示每轮 token 数 |
| Length anchors | 内部用户 | ≤25 词/工具间隔, ≤100 词/最终回复 |

## 二、CLAUDE.md / 记忆系统

### 2.1 核心设计：CLAUDE.md 不在 system prompt 中

**这是最重要的架构洞察**：CLAUDE.md 内容通过 `<system-reminder>` XML 标签注入到 **user messages** 中，而非 system prompt。

```json
{
  "role": "user",
  "content": "<system-reminder>\nAs you answer the user's questions...\n# claudeMd\nContents of /path/to/CLAUDE.md:\n[内容]\n# currentDate\nToday's date is 2026-03-18.\n</system-reminder>\n\nFix the login bug"
}
```

**原因**：system prompt 在所有用户之间共享缓存前缀。如果 CLAUDE.md 放入 system prompt，每个用户的不同配置会需要独立缓存，缓存经济模型崩溃。

### 2.2 加载层级

| 文件 | 位置 | 作用域 |
|------|------|-------|
| Managed policy | `/Library/.../ClaudeCode/CLAUDE.md` | 组织级 |
| User memory | `~/.claude/CLAUDE.md` | 所有项目 |
| Project memory | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 项目级 |
| Project rules | `./.claude/rules/*.md` | 项目级（支持 `paths:` frontmatter） |
| Local memory | `./CLAUDE.local.md` | 个人项目级（不提交） |
| Auto memory | `~/.claude/projects/.../memory/` | 自动学习 |
| Child CLAUDE.md | `./subdir/CLAUDE.md` | 子目录级 |

更具体的位置覆盖更宽泛的。

### 2.3 CLAUDE.md vs Rules

| 维度 | CLAUDE.md | `.claude/rules/*.md` |
|------|-----------|---------------------|
| 加载时机 | 会话开始注入一次 | 每次访问匹配文件时重新注入 |
| 作用域 | 全局 | 可用 `paths:` frontmatter 按文件模式限定 |
| 缓存代价 | 一次性 | 每次工具调用都付出 |
| 适用场景 | 项目约定、架构决策 | 特定文件类型的上下文指令 |

### 2.4 Auto Memory

- 上限 200 行或 25KB
- 每个会话自动加载
- 包含构建命令、调试经验、用户偏好等自动发现的信息
- "Auto-Dream" 系统在会话空闲期间合并和整理记忆

## 三、工具定义是最大的 Token 消耗者

工具定义占系统提示词的绝大部分：

| 工具 | Token 数 | 原因 |
|------|---------|------|
| TodoWrite | 2,161 | 复杂结构化字段 |
| TeammateTool | 1,645 | 每种子 Agent 类型描述 |
| Bash | 1,558 | 包含 git commit 格式、PR 创建指令 |
| SendMessage | 1,205 | Agent 间通信协议 |
| Agent | 931 | 何时产生子 Agent |
| EnterPlanMode | 878 | Plan 模式约束 |
| ReadFile | 440 | PDF/图像/notebook 支持 |
| Grep | 300 | ripgrep 语法参考 |
| Edit | 246 | 字符串替换规则 |
| Glob | 122 | 文件模式匹配 |
| **总计** | **~14,000–17,600** | 取决于激活的工具 |

**工具定义比 prompt 文本本身大 5-7 倍。**

## 四、上下文组装管线

### 4.1 API 请求结构

```json
{
  "system": [...],    // 系统提示词（2-4K tokens 文本）
  "tools": [...],     // 工具定义（14-17K tokens）
  "messages": [...]   // 对话历史
}
```

**渲染顺序**：`tools → system → messages`。这决定了缓存前缀的构成。

### 4.2 工具池组装

`assembleToolPool()` 的策略：
1. `getAllBaseTools()` 获取所有内置工具 + 动态过滤
2. **排序**：内置工具在前（按名称），MCP 工具在后（按名称）
3. **缓存断点**：内置工具列表末尾放置 `cache_control: { type: "ephemeral" }`
4. MCP 工具增删**不影响内置工具位置**，保护缓存前缀

### 4.3 MCP 工具延迟加载

当 MCP 工具数量多（>10% 上下文窗口）时启用 `defer_loading`：
- 只发送名称和一行描述，不包含完整 JSON Schema
- 模型需要时通过 `ToolSearchTool` 按需加载完整 schema
- 加载的 schema 以 message 形式追加，不修改工具定义
- 节省约 95% 的初始 token 消耗

### 4.4 `<system-reminder>` 注入

以下内容通过 `<system-reminder>` 注入到 user messages 中：
- 当前日期
- Git 状态
- CLAUDE.md 内容
- 打开的文件内容
- 当前模式状态
- Todo 列表状态

这保证了 **system prompt 冻结不变**，缓存保持热状态。

## 五、Prompt Cache 优化策略

### 5.1 动态分界标记

`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 分割两个区域：

| 位置 | 内容 | 缓存行为 |
|------|------|---------|
| 标记前（静态） | 7 个核心段落 | 全局可缓存（跨组织/跨用户） |
| 标记后（动态） | 会话指引、记忆、环境、MCP 指令 | 仅会话级缓存 |

### 5.2 三层缓存

| 层级 | 范围 | TTL |
|------|------|-----|
| Ephemeral | 每会话 | ~5 分钟（每次命中重置） |
| Extended | 每会话 | 1 小时（订阅用户） |
| Global | 跨会话/跨用户 | — |

### 5.3 五个 Sticky Latch

防止会话中途状态翻转破坏缓存：

| Latch | 保护对象 |
|-------|---------|
| `promptCache1hEligible` | 配额翻转改变 TTL |
| `afkModeHeaderLatched` | Tab 切换 |
| `fastModeHeaderLatched` | 冷却模式切换 |
| `cacheEditingHeaderLatched` | 会话中途配置切换 |
| `thinkingClearLatched` | thinking 模式翻转 |

### 5.4 2^N 问题

每个运行时条件是一个 bit，会使前缀哈希变体乘以 2^N。因此：
- **编译时** feature flags → 可放在 boundary 前
- **运行时** 检查 → 必须放在 boundary 后

### 5.5 缓存感知的功能设计

**Plan mode**：不替换工具列表（会破坏缓存），而是保留所有工具 + 添加 `EnterPlanMode`/`ExitPlanMode` 新工具 + 用 message 发送模式指令。工具定义在两种模式间完全不变。

**Compaction**：摘要请求复用父会话完全相同的 system + tools + CLAUDE.md 前缀，只在末尾追加压缩指令。缓存自动命中。

### 5.6 命名约定

源码中有显式的缓存安全命名：
- `systemPromptSection(name, compute)` — 安全，被缓存
- `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)` — 破坏缓存，需提供原因字符串

### 5.7 实际成本效果

| 场景 | 无缓存 | 有缓存（~96% 命中率） |
|------|--------|---------------------|
| 100 轮 Opus 会话 | $50–100 | $10–19 |
| 缓存读取价格 | — | 基础价 ×10%（$0.50/M vs $5/M） |

## 六、Skills 与 Bootstrap

### 6.1 `/init` 命令

分析项目结构并生成初始 `CLAUDE.md`：构建命令、技术栈、目录结构、基本约定。

### 6.2 Skills 层级

| 层级 | 角色 |
|------|------|
| L0 | 顺序 repo 级工作流 |
| L1 | 顶层编排器 |
| L2 | 领域协调器 |
| L3 | 工人（聚焦执行） |

Skills 在 auto-compact 后会被**重新注入**（rehydration，25K token 预算）。

### 6.3 启动流程

```
1. 加载配置（5 层 settings.json 级联）
2. 加载记忆（CLAUDE.md 层级 + Auto memory）
3. 组装工具池（内置 + MCP，排序 + 缓存断点）
4. 组装系统提示词（静态 7 段 + 动态段）
5. 注入 <system-reminder>（CLAUDE.md、日期、环境等）
6. API 预连接（HEAD 请求预热 TCP+TLS）
7. 进入 Agent Loop
```

## 七、核心洞察

1. **CLAUDE.md 在 messages 中，不在 system prompt 中**：保护全局缓存前缀的核心设计。

2. **工具定义是最大的 Token 消耗者**：14-17K tokens 工具 vs 2-4K tokens 文本。优化工具描述的 ROI 远高于优化 prompt 文本。

3. **每个设计决策都围绕缓存**：Plan mode 用消息而非替换工具；compaction 复用前缀；MCP 延迟加载。

4. **缓存是字节精确的前缀匹配**：两个字母大小写变化就能让缓存失效。因此有 `normalizeStructuredPromptSection()` 等稳定性工具。

5. **身份定义极简**：一句话，不多不少。避免过度约束模型行为。

6. **`DANGEROUS_` 命名约定**：在源码层面建立缓存安全意识，每个破坏缓存的操作都必须声明原因。

7. **MCP 延迟加载节省 95% 初始 Token**：`defer_loading` + `ToolSearch` 按需获取。

8. **2^N 条件组合问题**：条件段必须放在动态区，避免前缀哈希变体指数增长。
