# Claude Code 记忆与学习系统分析

> 分析来源：官方文档 + 社区逆向分析（v2.1.88）
> 分析日期：2026-04-09
> 核心问题：Claude Code 如何实现跨会话的知识持久化？

## 一、核心结论

Claude Code 的跨会话 "记忆" 基于 **两套并行的文件化机制**：

1. **CLAUDE.md** — 用户手动编写的项目指令（类似 .editorconfig）
2. **Auto Memory** — 模型自主写入的学习笔记（默认开启，v2.1.59+）

```
用户 ──→ CLAUDE.md（手写指令）──→ 每次会话开始注入
                                        ↓
对话中 ──→ 模型判断值得记住 ──→ Auto Memory 写入
                                        ↓
下次会话 ──→ MEMORY.md（前 200 行）自动注入
```

**与 OpenClaw 的根本差异**：Claude Code 没有向量索引、没有 SQLite、没有 Dreaming 晋升。它的 "记忆" 本质上是 **纯文件读写**，极简但有效。

## 二、CLAUDE.md 层级体系

### 2.1 四层作用域

| 层级 | 位置 | 受众 | 是否进版本库 |
|------|------|------|-------------|
| 组织策略 | 系统级路径（IT 分发） | 团队/组织 | N/A（系统目录） |
| 用户级 | `~/.claude/CLAUDE.md` | 个人全局 | 否 |
| 项目级 | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享 | 是 |
| 本地级 | `./CLAUDE.local.md` | 个人×项目 | 否（建议 .gitignore） |

**组织策略路径**：
- macOS: `/Library/Application Support/ClaudeCode/CLAUDE.md`
- Linux/WSL: `/etc/claude-code/CLAUDE.md`
- Windows: `C:\Program Files\ClaudeCode\CLAUDE.md`

### 2.2 加载行为

- **祖先链遍历**：从当前工作目录向上遍历所有祖先目录，收集每层的 `CLAUDE.md` / `CLAUDE.local.md`
- **拼接而非覆盖**：所有层的内容被拼接进上下文，不是"具体层覆盖宽泛层"
- **同目录内顺序**：`CLAUDE.local.md` 接在 `CLAUDE.md` 之后（个人覆盖在团队之后）
- **子目录懒加载**：子目录的 `CLAUDE.md` 启动时不加载，工具读到该目录时才纳入
- **`@path` 导入**：CLAUDE.md 中可以 `@文件路径` 引用其他文件，递归最多 5 层
- **排除规则**：`claudeMdExcludes` 可排除单体仓库中无关团队的文件，但组织策略不可排除

### 2.3 Rules 系统

除 CLAUDE.md 外，还有模块化规则：

| 位置 | 加载方式 |
|------|---------|
| `~/.claude/rules/*.md` | 全局规则，先于项目规则加载 |
| `.claude/rules/*.md` | 项目规则，优先级高于全局 |

Rules 可以通过 YAML `paths:` 字段做**路径懒加载**（只在操作特定路径时才注入）。

### 2.4 注入位置

**关键设计决策**：CLAUDE.md 内容 **不进 system prompt**。

通过 `<system-reminder>` 标签注入到 **user message** 中。原因是保护 Anthropic prompt cache 的全局静态前缀——system prompt 在所有项目间共享，CLAUDE.md 内容会破坏缓存。

## 三、Auto Memory（自动学习笔记）

### 3.1 机制

- **默认开启**（v2.1.59+）
- 模型在对话过程中自主判断"这条信息未来有用"时，写入 memory 文件
- 用户可在 `/memory` 查看或通过配置关闭

### 3.2 存储位置

```
~/.claude/projects/<project-id>/memory/
├── MEMORY.md      ← 索引文件（自动维护）
├── topic-a.md     ← 按主题组织的详细内容
└── topic-b.md
```

- `<project-id>` 由 **git 仓库身份** 导出（同一 repo 的多个 worktree 共享）
- 非 git 项目用项目根路径
- 可通过 `autoMemoryDirectory` 自定义路径（不接受项目级 settings.json，防敏感路径暴露）

### 3.3 加载预算

每次会话启动时自动加载 **MEMORY.md 的前 200 行或前 25KB（先达到者）**。

- 更长内容应拆到 topic 文件
- Topic 文件 **启动时不加载**，需要时由模型用读文件工具主动读取
- 这个设计控制了启动成本，同时保留了深度检索能力

### 3.4 写入内容类型

模型会自动记忆的典型内容：
- 项目的构建命令和开发流程
- 调试过程中发现的陷阱
- 用户的编码偏好和风格
- 项目特有的架构约定

### 3.5 关闭方式

三种途径：
1. `/memory` 交互界面中关闭
2. `settings.json` 中 `autoMemoryEnabled: false`
3. 环境变量 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

### 3.6 与 Compaction 的交互

CLAUDE.md 在 `/compact` 后会**从磁盘重新读取**注入。这意味着：
- 只在对话中口头说的指令，压缩后可能丢失
- 但写入 CLAUDE.md 或 Auto Memory 的内容，压缩后会被重新注入

## 四、Session 持久化

### 4.1 存储

```
~/.claude/projects/<project-path-encoded>/<session-uuid>.jsonl
```

配合 `sessions-index.json` 管理索引。

### 4.2 恢复

- `--continue`：继续最近的会话
- `--resume <id>`：恢复指定会话
- `--fork-session`：分叉一个会话
- `--no-session-persistence`：不持久化

### 4.3 已知问题

`sessions-index.json` 与 JSONL 文件不同步，导致 `/resume` 列表过期（有 GitHub issue 追踪）。

## 五、"越用越聪明" 的精确机制

### 5.1 它做了什么

1. **Auto Memory 累积**：每次有价值的对话都可能写入新的 memory 条目
2. **MEMORY.md 启动注入**：下次会话自动带上之前积累的知识
3. **用户手动完善 CLAUDE.md**：用户把好的实践写进 CLAUDE.md，AI 遵循

### 5.2 它没有做什么

1. 没有模型微调或在线训练
2. 没有向量数据库或语义检索
3. 没有 Dreaming / 晋升机制
4. 没有关系网络管理
5. 没有结构化技能系统
6. 没有跨项目的知识共享

### 5.3 局限

- **200 行上限**：MEMORY.md 只加载头部，长期积累后信息密度问题突出
- **无结构约束**：自由文本记忆，质量完全依赖模型判断
- **黑盒写入**：模型自主决定记什么，用户事后才能审核
- **无检索能力**：不像 OpenClaw 有 `memory_search`，Claude Code 靠启动注入 + 读文件
- **无去重**：没有 recall 统计或晋升机制，MEMORY.md 可能有冗余内容

## 六、架构评价

### 优点

1. **极简**：纯文件读写，无外部依赖（SQLite、嵌入模型等）
2. **透明**：用户可以直接编辑所有 memory 文件
3. **层级清晰**：四层 CLAUDE.md + Auto Memory，职责分明
4. **预算控制**：200 行 / 25KB 的启动加载限制，避免 token 浪费
5. **安全**：`autoMemoryDirectory` 不接受项目级配置，防止共享项目指向敏感路径
6. **缓存友好**：CLAUDE.md 不进 system prompt，保护全局缓存

### 不足

1. **无语义检索**：只有启动注入和手动读文件，没有主动搜索
2. **无结构化记忆**：自由文本，无法按类别（人物、技能、事实）组织
3. **无关系网络**：无法理解"我老婆"指的是谁
4. **无技能概念**：学到的方法无法结构化复用
5. **无晋升机制**：所有记忆平等，无法识别高价值知识
6. **编程专用**：设计完全面向开发场景，不适合通用个人助手

## 七、与 OpenClaw 的对比

| 维度 | OpenClaw | Claude Code |
|------|----------|-------------|
| 核心理念 | 全功能记忆引擎 | 极简文件笔记 |
| 存储 | SQLite + 文件 | 纯文件 |
| 检索 | 混合检索（FTS5 + 向量） | 启动注入 + 手动读文件 |
| 自动记忆 | Memory Flush（上下文满时） | Auto Memory（模型判断时） |
| 晋升机制 | Dreaming（recall 统计 → MEMORY.md） | 无 |
| 身份系统 | 8 个 Bootstrap 文件 | CLAUDE.md 层级 |
| 技能 | Skills 系统（静态文件） | 无 |
| 关系网络 | 无 | 无 |
| 复杂度 | 高（SQLite、嵌入、QMD） | 低（纯文件 I/O） |
| 默认可用性 | Dreaming 默认关闭 | Auto Memory 默认开启 |
| 产品定位 | 通用个人助手 | 编程助手 |
