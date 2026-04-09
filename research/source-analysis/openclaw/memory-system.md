# OpenClaw 记忆与学习系统源码分析

> 分析对象：`E:\Dev\longxia\openclaw-main`
> 分析日期：2026-04-09
> 核心问题：OpenClaw "越用越聪明" 的精确机制是什么？

## 一、核心结论

OpenClaw 的 "越用越聪明" **不是在线微调模型权重**，而是一个三阶段的 **文件化记忆管线**：

1. **Memory Flush** — 对话快满时，自动把要点写入每日 Markdown 文件
2. **Memory Search** — 后续对话中，通过混合检索从历史记忆中召回相关片段
3. **Dreaming / Promotion** — 可选的定时任务，把频繁被召回的日更片段晋升到永久记忆

```
用户对话 ──→ 上下文快满 ──→ Memory Flush ──→ memory/2025-06-15.md
                                                    │
                                                    ▼
后续对话 ──→ memory_search ──→ 检索命中 ──→ 注入上下文
                                    │
                                    ▼ (记录 recall 统计)
                            short-term-recall.json
                                    │
                                    ▼ (定时 dreaming)
                                MEMORY.md (永久记忆)
```

## 二、Bootstrap 文件（长期身份）

OpenClaw 在每次会话启动时注入最多 **8 个固定文件**：

| 文件名 | 作用 |
|--------|------|
| `AGENTS.md` | Agent 行为规范 |
| `SOUL.md` | 人格与价值观 |
| `TOOLS.md` | 可用工具说明 |
| `IDENTITY.md` | 身份定义 |
| `USER.md` | 用户信息 |
| `HEARTBEAT.md` | 心跳/状态 |
| `BOOTSTRAP.md` | 启动引导 |
| `MEMORY.md` | 长期记忆摘要 |

**源码位置**：`src/agents/workspace.ts`

```typescript
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
```

**加载逻辑**：`loadWorkspaceBootstrapFiles()` 从 workspace 根目录读取所有存在的文件，`MEMORY.md` 优先于 `memory.md`（避免 Docker 大小写问题）。子代理会话只加载 `AGENTS`/`TOOLS`/`SOUL`/`IDENTITY`/`USER` 的最小集合。

**评价**：8 个文件的设计分工过细。SOUL 和 IDENTITY 的边界模糊，USER 和 MEMORY 的职责重叠。对用户而言认知负担较重。

## 三、Memory Flush（对话 → 磁盘）

### 3.1 触发条件

当上下文 token 逼近窗口上限时自动触发。

**源码位置**：`src/auto-reply/reply/agent-runner-memory.ts` → `runMemoryFlushIfNeeded`

判断条件：
- 当前 token 用量超过 `softThresholdTokens`（配置项）
- 或会话日志字节数超过 `forceFlushTranscriptBytes`

### 3.2 执行方式

触发后插入一个**静默 Agent 回合**（用户不可见），该回合：
- 只允许 `read` 和 `write` 两个工具
- `write` 被限制为 **仅 append 到当日文件**（`memory/YYYY-MM-DD.md`）
- 禁止修改 `MEMORY.md` 和其他 bootstrap 文件

**源码位置**：`src/agents/pi-tools.ts`

```typescript
const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

// write 工具被包装为 append-only，且只允许写入指定的每日文件
const toolsForMemoryFlush = isMemoryFlushRun && memoryFlushWritePath
  ? tools.flatMap((tool) => {
      if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) return [];
      if (tool.name === "write") {
        return [wrapToolMemoryFlushAppendOnlyWrite(tool, {
          root: sandboxRoot ?? workspaceRoot,
          relativePath: memoryFlushWritePath, // memory/2025-06-15.md
        })];
      }
      return [tool];
    })
  : tools;
```

**安全设计**：
- Append-only：不会覆盖已有内容
- 单文件锁定：只能写当日文件，不能动其他文件
- 工具白名单：不能执行 bash 或其他危险操作

### 3.3 配置

**源码位置**：`extensions/memory-core/src/flush-plan.ts`

```typescript
// 配置路径：agents.defaults.compaction.memoryFlush
{
  enabled: boolean;             // 总开关，默认隐式启用
  softThresholdTokens: number;  // 触发阈值
  forceFlushTranscriptBytes: string; // 强制 flush 的日志大小
}
```

### 3.4 产出

每次 flush 产出一个按日期命名的文件：

```
workspace/
  memory/
    2025-06-12.md   ← 6 月 12 日的对话要点
    2025-06-13.md
    2025-06-15.md
```

内容是 LLM 从对话中提取的要点摘要，格式为 Markdown。

## 四、Memory Search（磁盘 → 对话）

### 4.1 工具定义

OpenClaw 注册了两个记忆工具：

| 工具 | 作用 |
|------|------|
| `memory_search` | 通过关键词 / 语义搜索检索记忆 |
| `memory_get` | 按路径获取指定记忆文件 |

**源码位置**：`extensions/memory-core/index.ts`

### 4.2 索引引擎

**包**：`@openclaw/memory-host-sdk`（`packages/memory-host-sdk/`）

**存储**：SQLite 数据库

```typescript
// memory-schema.ts
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL, mtime INTEGER, size INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER, end_line INTEGER,
  hash TEXT, model TEXT,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,   -- 向量嵌入
  updated_at INTEGER
);
```

**检索方式**：混合检索（关键词 FTS5 + 向量余弦相似度），可配置后端（builtin SQLite 或 QMD）。

### 4.3 数据源

索引的内容来自：
- `memory/*.md`（每日 flush 文件）
- `MEMORY.md`（永久记忆）
- 配置的 `extraPaths`
- 可选的 session 索引

### 4.4 检索后追踪

每次 `memory_search` 返回结果后，**异步记录召回统计**（不阻塞主流程）：

```typescript
// extensions/memory-core/src/tools.ts
void recordShortTermRecalls({
  workspaceDir,
  query,
  results: trackingResults,
}).catch(() => {
  // 最佳努力，不阻塞
});
```

统计存储在 `memory/.dreams/short-term-recall.json`。

## 五、Dreaming / Short-term Promotion（日更 → 永久记忆）

### 5.1 机制

这是 OpenClaw 记忆系统中最精妙的部分：**从短期记忆中识别高价值片段，晋升到长期记忆**。

**源码位置**：`extensions/memory-core/src/short-term-promotion.ts`

流程：
1. 每次 `memory_search` 命中 `memory/` 下的日更文件 → 记录到 `short-term-recall.json`
2. 定时任务（dreaming cron）扫描统计
3. 排名算法综合考虑：recall 次数、分数、query 多样性
4. 高分片段被 **append 到 `MEMORY.md`**

```
memory/2025-06-12.md ──[被搜到 5 次]──→ 晋升到 MEMORY.md
memory/2025-06-13.md ──[被搜到 1 次]──→ 留在日更，不晋升
```

### 5.2 Dreaming 配置

**源码位置**：`extensions/memory-core/src/dreaming.ts`

```
// 预设模式
mode: "off"    ← 默认关闭
mode: "core"   ← 基础频率
mode: "rem"    ← 中等频率
mode: "deep"   ← 高频
```

**注意：默认关闭**。这说明 OpenClaw 团队认为该特性尚未稳定到可以默认启用。

### 5.3 晋升规则

只追踪来自 `memory/` 目录下、日期命名格式文件的片段。`MEMORY.md` 本身的内容不参与晋升统计（避免循环）。

## 六、Skills 系统（独立于记忆）

### 6.1 定位

Skills **不是从对话中自动学习的**，而是用户/插件预先定义的项目能力声明。

**源码位置**：`src/agents/skills.ts`、`src/agents/skills/workspace.ts`

### 6.2 加载

- 从 workspace、捆绑目录、插件目录加载 `SKILL.md` 文件
- 每个 skill 有 YAML frontmatter 描述元数据
- 默认限制：每源最多 200 条候选、提示中最多 150 个 skill、提示字符约 30K

### 6.3 与记忆的关系

Skills 和 Memory 是**完全独立的两个系统**：
- Memory = 对话中积累的经验（自动 flush / search / promote）
- Skills = 预定义的能力描述（静态文件，手动维护）

**评价**：Skills 没有从对话中自动提取的能力，是 OpenClaw 记忆系统的一个空白。用户如果想把对话中学到的方法沉淀为 Skill，必须手动创建文件。

## 七、架构评价

### 优点

1. **三阶段管线设计清晰**：flush → search → promote，职责分明
2. **安全设计优秀**：append-only write、工具白名单、文件锁定
3. **混合检索**：FTS5 + 向量，兼顾精确匹配和语义理解
4. **最佳努力追踪**：recall 统计异步执行，不影响主流程

### 不足

1. **复杂度过高**：SQLite + 嵌入模型 + QMD 后端，部署和调试成本大
2. **Bootstrap 文件过多**：8 个文件的分工边界模糊，用户认知负担重
3. **Dreaming 默认关闭**：核心差异化特性却不敢默认启用，说明稳定性存疑
4. **Skills 与 Memory 割裂**：无法从对话中自动沉淀技能
5. **无关系网络**：不维护用户的社交关系信息
6. **无结构化身份**：`USER.md` 和 `IDENTITY.md` 是自由文本，无 schema 约束
7. **Memory Flush 是黑盒**：用户不知道 flush 了什么，无法审核

## 八、关键数据路径

```
~/.openclaw/workspace/
├── AGENTS.md           ← 行为规范（启动注入）
├── SOUL.md             ← 人格（启动注入）
├── IDENTITY.md         ← 身份（启动注入）
├── USER.md             ← 用户信息（启动注入）
├── MEMORY.md           ← 永久记忆摘要（启动注入 + dreaming 晋升写入）
├── memory/
│   ├── 2025-06-12.md   ← 每日 flush 文件
│   ├── 2025-06-13.md
│   └── .dreams/
│       └── short-term-recall.json  ← 召回统计
├── TOOLS.md            ← 工具说明
├── HEARTBEAT.md        ← 心跳
└── BOOTSTRAP.md        ← 启动引导
```
