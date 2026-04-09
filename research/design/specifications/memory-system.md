# 知行记忆系统设计方案

> 设计日期：2026-04-09
> 依赖调研：openclaw/memory-system.md、claude-code/memory-system.md
> 产品定位：个人助手（非编程专用）

## 一、问题定义

### 1.1 现状

知行当前的 "个人化" 能力仅有 `ZHIXING.md`——一个扁平的项目指令文件。每次新会话，AI 是一个彻底的陌生人：不知道你是谁、你认识谁、你会什么。

### 1.2 目标

让知行成为**真正了解你的个人助手**：

- **知道你是谁**（身份画像）
- **知道谁对你重要**（关系网络）
- **知道你会什么**（技能沉淀）
- **越用越聪明**（对话中自动积累）

### 1.3 产品直觉

| 类比 | 知行的实现 |
|------|-----------|
| ZHIXING.md = 你给新员工的 onboarding doc | 项目指令（已实现） |
| Profile = 你的个人名片 | 身份画像（本方案） |
| People = 你的通讯录 + 备注 | 关系网络（本方案） |
| Skills = 你的个人技术笔记本 | 技能沉淀（本方案） |
| Auto Memory = 跟你共事后的默契 | 自动记忆（本方案） |

## 二、竞品方案提炼

### 2.1 OpenClaw 的路线：全功能记忆引擎

```
Memory Flush（上下文满→每日文件）
    → Memory Search（SQLite + FTS5 + 向量检索）
        → Dreaming（recall 统计→晋升到 MEMORY.md）
```

**取**：三阶段管线（写入→检索→晋升）的分层思想、append-only 安全设计
**舍**：SQLite + 嵌入模型的重型依赖、8 个 Bootstrap 文件的认知负担、默认关闭的 Dreaming

### 2.2 Claude Code 的路线：极简文件笔记

```
Auto Memory（模型判断→写入 MEMORY.md）
    → 启动注入（前 200 行 / 25KB）
```

**取**：纯文件无依赖、Auto Memory 默认开启的产品勇气、200 行预算控制
**舍**：无检索能力、无结构化、无关系/技能概念

### 2.3 两者都没做的

| 空白 | 知行的机会 |
|------|-----------|
| 结构化身份画像 | 不是自由文本的 USER.md，而是有 schema 的 profile.md |
| 关系网络 | 没有任何竞品维护用户的社交关系 |
| 技能自动沉淀 | OpenClaw Skills 是静态的，Claude Code 没有 skill 概念 |
| 对话→技能提取 | 两者都没有把"对话中解决的问题"自动变成可复用技能 |
| 记忆透明度 | OpenClaw flush 是黑盒，Claude Code auto memory 用户事后审核 |

## 三、知行记忆架构

### 3.1 三支柱 + 一暂存 + 一引擎

记忆系统由两层组成：**永久层**（三支柱）和**暂存层**（Journal），通过检索引擎统一接入上下文。

```
┌──────────────────────────────────────────────────────────────────┐
│                          记忆系统                                 │
│                                                                  │
│  ┌─ 永久层（Permanent）──────────────────────────────────────┐   │
│  │ ┌──────────┐  ┌──────────────┐  ┌────────────────┐       │   │
│  │ │ Profile  │  │ Relationships │ │ Skills/Knowledge│      │   │
│  │ │ 身份画像  │  │ 关系网络      │  │ 技能沉淀        │      │   │
│  │ │ 始终注入  │  │ 按需检索     │  │ 按需检索        │       │   │
│  │ └──────────┘  └──────────────┘  └────────────────┘       │   │
│  └───────────────────────────────────────────────────────────┘   │
│                             ▲ 提升(promote)                      │
│  ┌─ 暂存层（Staging）────────┼───────────────────────────────┐   │
│  │ ┌─────────────────────────┴──────────────────────────┐    │   │
│  │ │ Journal 对话日志                                     │    │   │
│  │ │ 按日暂存 → 月度凝练 → 到期淘汰                       │    │   │
│  │ │ 有价值内容被提升到永久层，其余自然衰减                 │    │   │
│  │ └────────────────────────────────────────────────────┘    │   │
│  └───────────────────────────────────────────────────────────┘   │
│                       │                                          │
│              ┌────────▼────────┐                                 │
│              │ Memory Retriever │ ← 关键词 + 标签匹配            │
│              └────────┬────────┘                                 │
│              ┌────────▼────────┐                                 │
│              │ Budget Allocator │ ← Token 预算分配               │
│              └────────┬────────┘                                 │
│              ┌────────▼────────┐                                 │
│              │ <context> 注入   │ → 首条 user message            │
│              └─────────────────┘                                 │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 存储结构

```
~/.zhixing/
├── config.json              # 已有：全局配置
├── ZHIXING.md               # 已有：用户级 AI 指令
├── me/                      # 新增：个人记忆空间
│   ├── profile.md           # 身份画像（始终注入，永久）
│   ├── people/              # 关系网络（按需检索，永久）
│   │   ├── wife-xiaoli.md
│   │   ├── friend-zhangsan.md
│   │   └── ...
│   ├── skills/              # 技能沉淀（按需检索，永久）
│   │   ├── docker-network-debug.md
│   │   ├── ts-monorepo-setup.md
│   │   └── ...
│   └── journal/             # 对话日志（按需检索，有生命周期）
│       ├── 2025-06-15.md    ← 今天的对话要点（热）
│       ├── 2025-06-14.md    ← 昨天（热）
│       ├── 2025-06-08.md    ← 一周前（温）
│       ├── 2025-05.md       ← 5 月凝练（冷，但永久保留）
│       └── 2025-04.md       ← 4 月凝练
└── projects/                # 已有：项目级数据
    └── <project-id>/
        └── sessions/
```

**对比 OpenClaw**：1 个目录（`me/`）替代 8 个 Bootstrap 文件；OpenClaw 的 `memory/` 无生命周期管理，无限累积
**对比 Claude Code**：有 schema 约束的 Markdown，不是自由文本；有明确的衰减策略

### 3.3 各支柱详细设计

#### 支柱 1：身份画像（Profile）

**文件**：`~/.zhixing/me/profile.md`

```markdown
---
name: 张三
language: 中文
timezone: Asia/Shanghai
---

## 职业
前端工程师，5 年经验。在做 AI 智能体方向。

## 技术栈
TypeScript, React, Node.js。最近在学 Rust。

## 偏好
- 喜欢简洁代码，讨厌过度设计
- 习惯先调研再动手

## 当前目标
- 构建 zhixing 个人助手项目
```

**注入策略**：始终注入到 `<context>` 中，预算上限 500 tokens。
**为什么不合并到 ZHIXING.md**：ZHIXING.md 是指令（"请这样做"），Profile 是事实（"我是谁"）。前者可提交 Git，后者绝不共享。

#### 支柱 2：关系网络（Relationships）

**文件**：`~/.zhixing/me/people/<slug>.md`

```markdown
---
name: 小丽
relation: 妻子
birthday: 1995-03-15
tags: [family, important]
---

- 在某设计公司做 UI 设计师
- 喜欢旅游，最近想去日本
- 对花粉过敏
- 上次生日送了一条项链
```

**注入策略**：按需检索。当用户消息中出现人名（"小丽"）或关系词（"老婆"、"妈妈"）时，匹配 frontmatter 的 `name` 和 `relation` 字段，注入匹配的人物档案。

**关系词映射**（内置）：
```
妻子/老婆/太太 → relation: 妻子
丈夫/老公 → relation: 丈夫
妈妈/母亲/我妈 → relation: 母亲
爸爸/父亲/我爸 → relation: 父亲
```

#### 支柱 3：技能沉淀（Skills）

**文件**：`~/.zhixing/me/skills/<slug>.md`

```markdown
---
title: Docker 容器网络调试
tags: [docker, networking, debug]
triggers: ["docker network", "容器连不上", "port mapping"]
created: 2025-06-15
source: conversation
---

## 问题特征
容器间无法通信，或容器无法访问宿主机服务。

## 排查步骤
1. 检查网络模式：`docker network ls`
2. 验证 DNS：`docker exec <c> nslookup <service>`
3. ...

## 常见陷阱
- macOS 的 `host.docker.internal` 在 Linux 上不可用
```

**注入策略**：当用户消息与 `triggers` 字段或 `tags` 字段匹配时自动注入。

**triggers 设计理念**：Skill 不是被动的笔记，而是有"触发条件"的能力单元。当用户遇到匹配的问题时，AI 自动获得这个技能加持，无需用户主动想起。

**与 OpenClaw Skills 的差异**：
- OpenClaw Skills 是静态的、手动维护的
- 知行 Skills 可以从对话中提取（AI 提议，用户确认）
- 知行 Skills 有 `triggers` 做自动匹配，OpenClaw Skills 依赖 prompt 注入

### 3.4 暂存层：Journal（对话日志）

#### 定位

Journal 是三支柱之外的**第四个存储区**，但它的本质与三支柱不同：

| | 三支柱（Profile / People / Skills） | Journal |
|---|---|---|
| 性质 | 永久记忆 | 暂存记忆 |
| 内容 | 结构化、有 schema | 自由文本（对话要点摘要） |
| 来源 | 用户显式保存 / AI 提议 | 上下文溢出时自动提取 |
| 生命周期 | 无限期 | 有衰减（日 → 月凝练 → 淘汰） |
| 类比 | 笔记本中精心整理的分类笔记 | 草稿纸上的随手记录 |

**核心理念**：Journal 是记忆系统的"新陈代谢"机制。对话中产生的大量信息，大部分是短期有用的（某次调试的具体报错、某个临时决策的背景）。真正有长期价值的内容应该被提升到三个支柱中，剩余的随时间自然衰减——就像人脑的短期记忆到长期记忆的转化过程。

#### 生命周期

```
对话溢出
    │
    ▼
┌─ 提取 + 分流 ──────────────────────────────────────┐
│                                                      │
│  身份相关 → 更新 me/profile.md          (永久)       │
│  人物相关 → 更新 me/people/*.md         (永久)       │
│  方法论   → 新建 me/skills/*.md         (永久)       │
│  其他要点 → append me/journal/日期.md   (暂存)       │
│                                                      │
└──────────────────────────────────────────────────────┘
    │
    ▼
┌─ 生命周期管理 ─────────────────────────────────────────────────┐
│                                                                 │
│  Day 0-7    [热]   完整日志，检索优先级高                       │
│  Day 8-30   [温]   完整日志，检索优先级降低                     │
│  Day 31+    [凝练] 当月所有日志被 LLM 凝练为月度摘要            │
│                    原始日志删除，仅保留 YYYY-MM.md               │
│  Month 12+  [淘汰] 超过 12 个月的月度摘要被删除                 │
│                    （真正有价值的内容早该被提升到三支柱了）       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 衰减规则

| 阶段 | 保留时间 | 文件形式 | 检索优先级 |
|------|---------|---------|-----------|
| 热（Hot） | 0-7 天 | `YYYY-MM-DD.md` | 高（score × 1.0） |
| 温（Warm） | 8-30 天 | `YYYY-MM-DD.md` | 中（score × 0.6） |
| 凝练（Condensed） | 31 天 - 12 个月 | `YYYY-MM.md` | 低（score × 0.3） |
| 淘汰（Expired） | >12 个月 | 删除 | — |

**为什么 12 个月后删除？**
- 超过一年的对话杂项信息，几乎不可能在当前对话中有用
- 如果某条信息在一年内被反复引用，说明它有价值——此时应该已被提升为 skill 或 profile 内容
- 月度凝练本身就很短（~200-500 tokens），12 个月也只有 12 个文件
- 用户如果认为某条 journal 内容重要，可以随时手动提升为 skill

#### 生命周期执行机制

**架构约束**：生命周期管理的触发逻辑必须与运行模式解耦。知行当前以 CLI 形态运行，但产品定位是个人助手——未来会有常驻服务（Server/Daemon）模式用于定时任务、通道接入（微信等）、主动巡检等场景。生命周期管理的核心操作（扫描、凝练、淘汰）应封装为**触发源无关的接口**，CLI 和 Server 各自提供不同的触发策略。

**设计原则**：
- 核心操作（`scan` / `condense` / `expire`）不感知触发来源
- 即时操作（文件删除）与延迟操作（LLM 凝练）分离
- 凝练花钱（LLM 调用），必须对用户透明
- CLI 模式下长期不用也不会出问题——下次启动时批量追赶
- Server 模式下通过 Cron 定时驱动，无需依赖用户启动

##### 触发策略总览：按运行模式分层

```
┌─────────────────────────────────────────────────────────────────┐
│               JournalManager (触发源无关)                       │
│                                                                 │
│  scan()      → 扫描文件，返回 LifecyclePlan                    │
│  expire()    → 删除过期凝练文件（纯 fs，即时）                  │
│  condense()  → LLM 凝练月度日志（异步，耗时）                  │
│                                                                 │
└───────────────┬─────────────────────────┬───────────────────────┘
                │                         │
     ┌──────────▼──────────┐   ┌──────────▼──────────┐
     │  CLI 触发策略        │   │  Server 触发策略     │
     │  (当前实现)          │   │  (未来实现)          │
     │                      │   │                      │
     │  ① 会话启动→scan+    │   │  ① Cron 定时→scan+  │
     │    expire             │   │    expire+condense   │
     │  ② 首轮对话后→       │   │  ② Heartbeat 巡检   │
     │    condense           │   │    时顺便检查        │
     │  ③ /journal gc 手动  │   │  ③ API 端点手动触发  │
     └─────────────────────┘   └─────────────────────┘
```

##### CLI 模式触发细节（当前阶段）

```
┌─ 触发点 1: 会话启动（即时）──────────────────────────────────────┐
│                                                                │
│  执行动作：                                                     │
│  ① fs.readdir('journal/') 扫描所有文件                          │
│  ② 按 mtime 分类：hot / warm / 待凝练 / 待淘汰                   │
│  ③ 即时删除：>12 个月的凝练文件（fs.unlink，<5ms）                │
│  ④ 检测凝练需求：有 >30 天的日志文件？→ 生成凝练计划               │
│  ⑤ 如果有待凝练，在欢迎信息中提示用户                             │
│                                                                │
│  时间成本：<50ms（只有文件系统 stat + 少量 unlink）               │
│  LLM 调用：无                                                   │
│  用户感知：无阻塞。若有待凝练，显示一行提示：                      │
│            "ℹ 15 条旧日志待凝练，将在首次对话后执行"              │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                          │ 用户开始对话
                          ▼
┌─ 触发点 2: 首轮对话完成后（延迟凝练）────────────────────────────┐
│                                                               │
│  前提：触发点 1 检测到凝练需求                                  │
│  时机：第一轮 agent turn 完成、结果已渲染给用户之后              │
│                                                               │
│  执行动作：                                                      │
│  ① 读取所有 >30 天的日志文件，按月分组                            │
│  ② 每个月调用 LLM："将这些对话笔记凝练为关键事实和洞察"           │
│  ③ 写入 YYYY-MM.md                                               │
│  ④ 删除原始日志文件                                               │
│  ⑤ 渲染凝练结果                                                   │
│                                                                   │
│  为什么在首轮之后？                                                │
│  - LLM 连接已热（provider 已初始化、API key 已验证）              │
│  - 用户已进入对话状态，心理上接受"后台工作"                       │
│  - 不在 session start 做，因为那时 LLM 还没连通                   │
│                                                                   │
│  并发安全：                                                       │
│  - 写入 journal/.lifecycle.lock（进程 PID + 时间戳）              │
│  - 其他实例看到 lock 且 <5 分钟 → 跳过本轮凝练                   │
│  - lock 超过 5 分钟视为过期（进程已死），可安全接管                │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ 触发点 3: 手动命令（用户控制）──────────────────────────────────┐
│                                                                   │
│  /journal         查看日志状态（文件数、年龄分布、待凝练数）       │
│  /journal gc      强制执行凝练 + 淘汰（不等首轮对话）             │
│  zhixing memory gc  CLI 命令，可用于脚本/自动化                   │
│                                                                   │
│  用途：                                                            │
│  - 用户想立即清理                                                 │
│  - 调试生命周期逻辑                                               │
│  - 集成到用户自己的 cron/CI 中                                    │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

##### Server 模式触发（未来阶段，预留接口）

当知行引入常驻服务（`zhixing serve` / Gateway）后，生命周期管理从"懒触发"升级为"定时驱动"：

| 触发源 | 时机 | 调用 |
|--------|------|------|
| Cron 定时任务 | 每天凌晨（可配置） | `scan()` → `expire()` → `condense()` |
| Heartbeat 巡检 | 周期性 agent turn 间隙 | `scan()`（仅检查，不执行凝练） |
| API 端点 | 管理接口调用 | 等同 `/journal gc` |

Server 模式下凝练不再需要"等首轮对话"——Cron 直接调用，LLM 连接由 Server 进程维护。这也是为什么 `JournalManager` 的 `condense()` 方法接收 `CondenseLLM` 参数（依赖注入），而不是自己初始化 provider。

##### CLI 模式下为什么不在其他时机执行？

| 被排除的 CLI 时机 | 原因 |
|-------------------|------|
| 会话退出时 | 用户可能 Ctrl+C 强杀进程，cleanup 永远执行不到 |
| 每轮对话后 | 增加每轮延迟，且大部分时候没有待处理的工作 |

##### 凝练执行细节

**凝练输入**：某个月所有日志文件的拼接文本

**凝练 Prompt**：
```
将以下 {N} 天的对话日志凝练为一份月度摘要。

规则：
- 保留：关键事实、重要决策、有持续价值的洞察
- 去除：临时性的调试细节、过时的状态描述、重复内容
- 如果某条信息适合作为技能（可复用方法论），标注 [SKILL_CANDIDATE]
- 格式：分为"关键事实"、"决策"、"洞察"三节
- 目标长度：200-500 tokens

对话日志：
{journal_contents}
```

**[SKILL_CANDIDATE] 标记**：凝练时如果 LLM 发现某段内容是方法论性质的，标记出来。凝练完成后，可以提示用户："发现 2 个潜在技能，是否提升为永久技能？"——这与 OpenClaw 的 Dreaming 晋升异曲同工，但更透明。

**凝练示例**：

6 月有 15 个日志文件，凝练后变成一个 `2025-06.md`：

```markdown
---
period: 2025-06
condensed_from: 15
condensed_at: 2025-07-02
---

## 关键事实
- 6 月初开始学习 Rust，从 The Book 入门
- 项目 zhixing 完成了上下文引擎和会话持久化
- 决定不使用 LangChain，采用自研 Agent Loop

## 决策
- 选择 pnpm workspace monorepo 结构（ADR-001）
- Provider 层采用适配器模式（ADR-002）

## 洞察
- CJK 文本的 token 估算需要特殊处理，约 1.5 token/字
- Anthropic prompt cache 是前缀精确匹配，任何差异导致未命中
```

##### 边界情况处理

| 场景 | 行为 |
|------|------|
| 用户 3 个月没用知行 | 下次启动时，触发点 1 检测到 3 个月的待凝练日志，触发点 2 依次凝练。可能需要 3 次 LLM 调用，总计 <30s |
| 凝练过程中用户发了新消息 | 凝练在 agent turn 之间的间隙执行，不与用户的 agent turn 并发。如果用户发消息，凝练排队等下一轮间隙 |
| 凝练失败（LLM 报错） | 不删除原始日志文件。下次启动时重试。最多重试 3 次，之后需要用户手动 `/journal gc` |
| 日志文件被用户手动删除 | 无影响。生命周期管理基于"当前存在的文件"，不维护额外索引 |
| 日志文件被用户手动编辑 | 正常处理。编辑后的内容参与凝练 |
| 两个知行实例同时运行 | 通过 `.lifecycle.lock` 文件互斥。后启动的实例跳过本轮凝练 |

#### 与现有压缩管线的集成（Memory Flush）

Journal 的**写入**发生在上下文压缩管线中。当上下文预算紧张时，在消息被丢弃之前先提取有价值的信息：

```
上下文预算紧张 (BudgetStatus: compact)
    │
    ▼
L1:   ToolResult 截断          ← 已有
L1.5: Memory Flush（新增）     ← 提取对话要点 → 分流到三支柱 + journal
L2:   Message Drop             ← 已有
L3:   LLM Summarization        ← 已有
```

**L1.5 Memory Flush 步骤详情**：

```
上下文需要压缩
    │
    ▼
LLM 提取当前对话的要点（一次调用）
    │
    ▼
┌─ 分流 ────────────────────────────┐
│                                    │
│ "用户说他最近在学 Rust"            │
│ → 更新 me/profile.md              │
│                                    │
│ "用户提到朋友张三在字节工作"        │
│ → 更新 me/people/friend-zhangsan.md│
│                                    │
│ "用 strace 排查了容器网络问题"      │
│ → 新建 me/skills/strace-debug.md  │
│                                    │
│ "讨论了项目下一步计划"              │
│ → append me/journal/2025-06-15.md │
│                                    │
└────────────────────────────────────┘
    │
    ▼
继续执行 L2/L3 压缩（消息可以安全丢弃了）
```

**与 OpenClaw flush 的区别**：OpenClaw 把所有内容都写入一个无结构的日更文件；知行在 flush 时就做分类，有价值的内容直接进入永久层，只有"杂项"才进 journal。

#### 与 OpenClaw flush 的完整对比

| 维度 | OpenClaw | 知行 |
|------|----------|------|
| flush 输出 | 全部写入 `memory/日期.md`（无结构） | 分流到三支柱 + journal（结构化） |
| 衰减 | 无（无限累积） | 日 → 月凝练 → 12 月淘汰 |
| 晋升 | Dreaming（统计召回频率，默认关闭） | flush 时直接分类 + 凝练时标记候选 |
| 凝练执行时机 | 无（没有凝练机制） | 会话启动扫描 + 首轮后延迟执行 |
| 透明度 | 静默执行，用户不知情 | 启动提示 + 凝练结果渲染 |
| 安全 | append-only + 工具白名单 | append-only + 文件锁 |
| 失败处理 | 未知 | 不删原文件，下次重试 |

## 四、记忆写入路径

### 4.1 Memory 工具

新增一个 AI 可调用的工具：

```typescript
interface MemoryToolInput {
  // 操作类型
  action: "save" | "search" | "list" | "update" | "delete";
  // 记忆类别
  category: "profile" | "person" | "skill";
  // save/update 时的文件标识
  id?: string;
  // 记忆内容（Markdown 格式）
  content?: string;
  // search 时的查询关键词
  query?: string;
}
```

**使用场景**：

| 用户说 | AI 行为 |
|--------|---------|
| "记住我叫张三" | `memory.save(category: "profile", ...)` |
| "小丽是我老婆，生日3月15号" | `memory.save(category: "person", id: "wife-xiaoli", ...)` |
| "把这个方法存为技能" | `memory.save(category: "skill", id: "docker-debug", ...)` |
| "我老婆喜欢什么？" | `memory.search(category: "person", query: "老婆 喜欢")` |
| "我有哪些技能？" | `memory.list(category: "skill")` |

### 4.2 写入策略

**对比两个竞品的写入触发**：

| 产品 | 触发时机 | 用户感知 |
|------|---------|---------|
| OpenClaw | 上下文快满时自动 flush（黑盒） | 用户不知道写了什么 |
| Claude Code | 模型随时判断（灰盒） | 显示 "Writing memory" |
| **知行** | 用户显式请求 + AI 主动提议 | **完全透明** |

**知行的写入模式**：

1. **显式模式**（Phase M2）：用户说 "记住..."、"保存..."，AI 调用 memory 工具
2. **提议模式**（Phase M5）：AI 检测到值得记忆的信息，向用户确认后保存
   - "我注意到你用了一种巧妙的方法解决了这个问题，要我保存为技能吗？"
   - 用户说 "好" → 保存；说 "不用" → 跳过
3. **自动模式**（Phase M6，未来）：类似 OpenClaw flush，上下文满时自动提取

**透明度原则**：Phase M2-M4 中，每次写入都会明确告知用户写了什么、存在哪里。不做黑盒操作。

## 五、记忆读取路径

### 5.1 上下文注入流程

```
用户发送消息
    │
    ▼
┌─ Memory Retriever ──────────────────┐
│                                      │
│  1. 始终加载 profile.md（≤500t）     │
│  2. 提取用户消息中的关键词/人名       │
│  3. 匹配 people/ 的 name/relation    │
│  4. 匹配 skills/ 的 triggers/tags    │
│  5. 按相关性排序                     │
│  6. 在预算内截取 top-K               │
│                                      │
└──────────────┬───────────────────────┘
               ▼
        ┌─ <context> ─────────────────┐
        │                              │
        │  # About You                 │
        │  张三，前端工程师...           │
        │                              │
        │  # Project Instructions      │
        │  （ZHIXING.md 内容）          │
        │                              │
        │  # Relevant Context          │
        │  ## 小丽（妻子）              │
        │  生日：3月15号...             │
        │                              │
        │  # Current Date              │
        │  2025-06-15                   │
        │                              │
        └──────────────────────────────┘
               │
               ▼
        注入到首条 user message
```

### 5.2 预算分配

总预算：contextWindow 的 5%（128K 模型约 6400 tokens）

| 区域 | 预算 | 策略 |
|------|------|------|
| Profile | 500 tokens | 固定，始终注入 |
| ZHIXING.md | 2000 tokens | 固定，始终注入 |
| 检索记忆 | 剩余（约 3900 tokens） | 动态，按相关性分配 |
| 环境信息 | 100 tokens | 固定，日期/CWD |

### 5.3 检索策略

**v1：关键词 + 标签匹配**（无外部依赖）

```
输入："帮我给小丽选个生日礼物"

1. 分词/实体提取："小丽"、"生日"、"礼物"
2. People 匹配：
   - wife-xiaoli.md → name:"小丽" ✅ (精确匹配, score: 1.0)
3. Skills 匹配：
   - 无匹配
4. 结果：注入 wife-xiaoli.md 内容
```

```
输入："Docker 容器连不上网络怎么办"

1. 关键词提取："Docker"、"容器"、"网络"
2. People 匹配：无
3. Skills 匹配：
   - docker-network-debug.md → triggers:["容器连不上"] ✅ (子串匹配, score: 0.8)
4. 结果：注入 docker-network-debug.md 内容
```

**v2（未来）：嵌入向量搜索**
当记忆条目多到关键词匹配不够精确时，可引入轻量嵌入搜索。但 v1 的简单方案应能覆盖大部分场景。

## 六、用户交互设计

### 6.1 自然语言（最自然的方式）

用户在对话中自然表达，AI 自动识别意图并调用 memory 工具：

```
用户: 记住，我叫张三，是前端工程师，在做 AI 方向
→ AI 调用 memory.save(category: "profile", ...)
→ AI 回复: "已记住你的身份信息，保存到了个人画像中。"

用户: 小丽是我女朋友，生日是 3 月 15 号，喜欢旅游
→ AI 调用 memory.save(category: "person", id: "girlfriend-xiaoli", ...)
→ AI 回复: "已记住小丽的信息。以后提到她时，我会自动调用这些信息。"

用户: 把刚才的 Docker 调试方法存为技能
→ AI 从对话上文提取方法论
→ AI 调用 memory.save(category: "skill", id: "docker-network-debug", ...)
→ AI 回复: "已保存技能'Docker 容器网络调试'。下次遇到类似问题时我会自动参考。"
```

### 6.2 斜杠命令（高效管理）

```
/me              查看/编辑个人画像
/people          列出关系网络
/people add      添加关系人
/skills          列出已有技能
/remember <文本>  快速保存（AI 自动分类到合适的类别）
```

### 6.3 直接编辑文件

用户可以用任何编辑器直接编辑 `~/.zhixing/me/` 下的文件。知行下次启动时自动识别变更。这确保了：
- 批量编辑比逐条对话更高效
- 用户始终拥有数据的完全控制权
- 即使知行不可用，数据仍然可读

## 七、"越用越聪明" 的演进路径

```
Phase M1-M4: 显式记忆
用户主动说 "记住" → AI 保存 → 后续对话自动引用
                                    │
Phase M5: 主动提议                   │
AI 检测有价值信息 → 提议保存 → 用户确认 → 保存
                                    │
Phase M6: Journal + Auto Flush       │
上下文满时 → 自动提取 → 分流到三支柱 + journal/日期.md
journal 生命周期：日 → 月凝练 → 12 月淘汰
                                    │
Phase M7: 召回优化（未来）            │
跟踪 skill 被引用次数 → 高频技能优先注入 → 低频技能降级
```

**与竞品的对比**：

| 阶段 | OpenClaw | Claude Code | 知行 |
|------|----------|-------------|------|
| 显式记忆 | ❌（无记忆工具） | ❌（无记忆工具） | ✅ Phase M2 |
| 主动提议 | ❌ | ❌ | ✅ Phase M5 |
| 自动提取 | ✅ Memory Flush（无结构） | ✅ Auto Memory（无结构） | ✅ Phase M6（结构化分流） |
| 记忆衰减 | ❌（无限累积） | ❌（无限累积） | ✅ Journal 生命周期 |
| 召回优化 | ✅ Dreaming | ❌ | ✅ Phase M7 |
| 结构化分类 | ❌（自由文本） | ❌（自由文本） | ✅ 三支柱 |
| 关系感知 | ❌ | ❌ | ✅ Phase M3 |
| 技能沉淀 | △（静态 Skills） | ❌ | ✅ Phase M4 |

## 八、渐进实现路线

每步独立可验证，不依赖后续步骤。

### Phase M1: 身份画像

**做什么**：
- `~/.zhixing/me/profile.md` 加载逻辑
- 始终注入到 `<context>` 中（扩展 `project-context.ts`）
- `/me` 斜杠命令（查看当前画像）

**验证**：
- 手动创建 profile.md 写入个人信息
- 对话中验证 AI 自然地引用你的身份（"张三"、你的技术栈等）

**交付**：
- `packages/core/src/memory/profile-loader.ts`
- `packages/cli/src/project-context.ts`（扩展）

### Phase M2: Memory 工具

**做什么**：
- 实现 `memory` 工具（save / search / list / update / delete）
- 注册到工具列表，AI 可自主调用
- 系统提示词中添加记忆管理指导

**验证**：
- 对话中说 "记住我叫张三" → AI 自动写入 profile.md
- 对话中说 "小丽是我女朋友" → AI 创建 people/girlfriend-xiaoli.md

**交付**：
- `packages/tools-builtin/src/memory.ts`
- `packages/cli/src/system-prompt.ts`（更新工具使用段）

### Phase M3: 关系网络

**做什么**：
- `people/` 目录管理（CRUD）
- 关系词映射表（"老婆" → relation:妻子）
- 检索逻辑：从用户消息中匹配人名/关系词 → 注入人物档案
- `/people` 斜杠命令

**验证**：
- 添加几个关系人后，提到人名时 AI 能引用相关信息
- 说 "我老婆喜欢什么" → AI 从关系网络中找到对应人物

**交付**：
- `packages/core/src/memory/people-store.ts`
- `packages/core/src/memory/retriever.ts`（检索）

### Phase M4: 技能沉淀

**做什么**：
- `skills/` 目录管理
- Trigger 匹配逻辑：用户消息 vs skill.triggers 子串匹配
- "存为技能" 对话流（AI 从对话上文提取方法论）
- `/skills` 斜杠命令

**验证**：
- 解决一个问题后说 "存为技能" → AI 自动提取并保存
- 后续遇到类似问题 → AI 自动引用之前保存的技能

**交付**：
- `packages/core/src/memory/skills-store.ts`
- `packages/core/src/memory/retriever.ts`（扩展 trigger 匹配）

### Phase M5: 主动提议

**做什么**：
- AI 在对话中检测到值得记忆的信息时，主动提议保存
- 提议格式："我注意到...，要我保存为技能/记住这个人吗？"
- 用户确认后才保存（尊重用户控制权）

**验证**：
- 长对话中解决复杂问题后，AI 主动提议存为技能
- 首次提到某个人的详细信息时，AI 提议添加到关系网络

**交付**：
- `packages/core/src/memory/auto-detect.ts`（意图检测）
- 系统提示词扩展（何时提议的指导）

### Phase M6: Journal + Auto Flush

**做什么**：
- `journal/` 目录 CRUD + 文件锁
- 三级触发生命周期管理：
  - 会话启动：快速扫描（fs.stat）+ 即时删除过期文件
  - 首轮对话后：延迟执行凝练（LLM 调用）
  - 手动命令：`/journal`、`/journal gc`
- 在压缩管线 L1 之后、L2 之前插入 Memory Flush 步骤
- Flush 逻辑：LLM 提取对话要点 → 分流到三支柱 + journal
- 凝练中发现的 `[SKILL_CANDIDATE]` 提示用户提升

**验证**：
- 长对话触发上下文压缩时，journal 中出现当日文件
- 创建若干模拟的 >30 天日志文件 → 启动会话 → 首轮对话后自动凝练为月度摘要
- 创建 >12 月的凝练文件 → 启动会话 → 被即时删除
- `/journal` 显示日志状态（文件数、年龄分布）
- 凝练失败时不删除原文件，下次重试

**交付**：
- `packages/core/src/memory/journal-store.ts`（CRUD + 扫描 + 过期删除）
- `packages/core/src/memory/condenser.ts`（LLM 凝练逻辑，CondenseLLM 接口解耦）
- `packages/core/src/memory/flush-strategy.ts`（L1.5 压缩管线集成）
- `packages/cli/src/run-agent.ts`（会话启动扫描 + 首轮后延迟凝练）
- `packages/cli/src/repl.ts`（`/journal` 斜杠命令）

## 九、核心类型设计

```typescript
// ─── 记忆文件元数据 ───

interface ProfileMeta {
  name: string;
  language?: string;
  timezone?: string;
}

interface PersonMeta {
  name: string;
  relation: string;
  birthday?: string;
  tags?: string[];
}

interface SkillMeta {
  title: string;
  tags: string[];
  triggers: string[];
  created: string;
  updated?: string;
  source?: "conversation" | "manual";
}

interface JournalMeta {
  /** 日志日期（YYYY-MM-DD）或凝练周期（YYYY-MM） */
  date: string;
  /** 是否为月度凝练 */
  condensed?: boolean;
  /** 凝练来源数 */
  condensedFrom?: number;
  /** 凝练时间 */
  condensedAt?: string;
}

// ─── 记忆类别 ───

type MemoryCategory = "profile" | "person" | "skill" | "journal";

// ─── 检索结果 ───

interface MemoryMatch {
  category: MemoryCategory;
  id: string;
  /** frontmatter 元数据 */
  meta: ProfileMeta | PersonMeta | SkillMeta | JournalMeta;
  /** 文件全文 */
  content: string;
  /** 匹配分数 (0-1)，journal 按衰减系数调整 */
  score: number;
  /** 匹配原因 */
  matchReason: string;
}

// ─── 检索器 ───

interface MemoryRetriever {
  /** 根据用户消息检索相关记忆（含 journal） */
  retrieve(userMessage: string, budget: number): Promise<MemoryMatch[]>;
  /** 加载 profile（始终注入） */
  loadProfile(): Promise<string | null>;
}

// ─── Journal 生命周期 ───

interface JournalLifecycleConfig {
  /** 日志文件保留天数（默认 30） */
  retentionDays: number;
  /** 月度凝练保留月数（默认 12） */
  condensedRetentionMonths: number;
}

interface JournalManager {
  /** 追加内容到当日日志 */
  appendToday(content: string): Promise<void>;
  /** 快速扫描：检测是否需要凝练/淘汰（仅 fs.stat，<50ms） */
  scan(): Promise<LifecyclePlan>;
  /** 执行即时操作：删除过期凝练文件（不需要 LLM） */
  expireOld(): Promise<{ deleted: number }>;
  /** 执行凝练：需要 LLM 调用，可能耗时 */
  condense(plan: CondensePlan, llm: CondenseLLM): Promise<CondenserResult>;
  /** 列出所有日志（含衰减阶段标记） */
  list(): Promise<JournalEntry[]>;
}

/** scan() 返回的执行计划 */
interface LifecyclePlan {
  /** 需要即时删除的过期凝练文件 */
  expiredFiles: string[];
  /** 需要凝练的月份及其日志文件 */
  condensePlan: CondensePlan | null;
  /** 当前 journal 状态摘要（用于 /journal 命令渲染） */
  stats: { hotCount: number; warmCount: number; condensedCount: number; totalFiles: number };
}

interface CondensePlan {
  /** 按月分组的待凝练文件 */
  months: { month: string; files: string[] }[];
}

interface CondenserResult {
  /** 成功凝练的月份 */
  condensedMonths: string[];
  /** 凝练中发现的潜在 skill 候选 */
  skillCandidates: string[];
  /** 删除的日志文件数 */
  deletedFiles: number;
}

/** 凝练需要的 LLM 能力（解耦，方便测试） */
interface CondenseLLM {
  condense(dailyContents: string): Promise<string>;
}

interface JournalEntry {
  id: string;           // 文件名（不含 .md）
  date: string;
  phase: "hot" | "warm" | "condensed";
  condensed: boolean;
  sizeBytes: number;
}

interface LifecycleResult {
  /** 凝练的月份 */
  condensedMonths: string[];
  /** 删除的日志文件数 */
  deletedDailyFiles: number;
  /** 删除的过期月度凝练数 */
  deletedCondensedFiles: number;
}

// ─── Memory Flush（压缩管线集成） ───

interface FlushResult {
  /** 提升到三支柱的条目 */
  promoted: { category: "profile" | "person" | "skill"; id: string }[];
  /** 写入 journal 的内容摘要 */
  journalAppended: boolean;
}

// ─── Memory 工具 ───

interface MemoryToolInput {
  action: "save" | "search" | "list" | "update" | "delete";
  category: MemoryCategory;
  id?: string;
  content?: string;
  query?: string;
}
```

## 十、决策记录

### ADR-008: 为什么用 Markdown 而非 SQLite

**背景**：OpenClaw 用 SQLite + 嵌入向量做记忆索引。

**决策**：知行用 Markdown + YAML frontmatter，不引入数据库。

**理由**：
- 透明：用户可用任何编辑器查看和编辑
- 无依赖：不需要 SQLite binding 或嵌入模型
- 可迁移：复制文件夹即完成迁移
- 人优先：即使知行崩溃，数据仍可读
- 渐进：v1 用关键词匹配足够，向量搜索可作为 v2 增强

**风险**：记忆条目很多（>100）时关键词匹配可能不够精确。但个人助手场景下，关系人通常 <50，技能 <100，关键词匹配应能覆盖。

### ADR-009: 为什么 Profile 独立于 ZHIXING.md

**背景**：可以把身份信息写进 ZHIXING.md。

**决策**：Profile 独立为 `me/profile.md`。

**理由**：
- 本质不同：ZHIXING.md 是指令（"请这样做"），Profile 是事实（"我是谁"）
- 隐私不同：ZHIXING.md 可提交 Git（团队共识），Profile 绝不共享
- 生命周期不同：ZHIXING.md 按项目变化，Profile 跨项目持久
- 注入优先级不同：Profile 始终注入且优先级最高

### ADR-010: 为什么先做显式记忆而非自动记忆

**背景**：OpenClaw 和 Claude Code 都做了自动记忆。

**决策**：先做显式（用户说"记住"）和提议（AI 建议，用户确认）模式，自动记忆放到后期。

**理由**：
- 信任优先：用户对 AI 自动写入文件需要建立信任，显式模式让用户完全掌控
- 质量优先：显式保存的内容是用户认为重要的，比 AI 猜测更准确
- 调试友好：出问题时用户知道每条记忆是怎么来的
- 渐进策略：先验证记忆系统的价值，再增加自动化程度

### ADR-011: 为什么用 triggers 而非全文搜索

**背景**：可以对 skill 全文做关键词匹配。

**决策**：skill 的自动注入基于 frontmatter 的 `triggers` 字段。

**理由**：
- 精确可控：trigger 是作者（用户/AI）明确标注的触发条件
- 无噪音：全文匹配容易误触（skill 内容中的词可能与当前话题无关）
- 可解释：用户能看到为什么某个 skill 被注入（"因为你说了'Docker network'"）
- 可维护：用户可以直接编辑 triggers 来调整触发灵敏度

### ADR-012: 为什么关系网络不用图数据库

**背景**：社交关系本质上是图结构。

**决策**：用扁平文件 + frontmatter 的 relation 字段，不引入图数据库。

**理由**：
- 个人关系通常 <50 人，不需要图查询的性能优势
- 文件方式保持与 Profile 和 Skills 的一致性
- 关系查询（"我老婆是谁"）通过 relation 字段的关键词匹配就能解决
- 复杂关系推理（"我老婆的同事"）在 v1 不做，未来需要时再考虑图结构

### ADR-013: 为什么 Journal 有衰减而三支柱没有

**背景**：OpenClaw 的 `memory/` 目录无限累积日更文件，长期后产生大量过时内容。可以选择所有记忆都永久保留，或都有 TTL。

**决策**：三支柱（Profile / People / Skills）永久保留，Journal 有明确的衰减生命周期（日 → 月凝练 → 12 月淘汰）。

**理由**：

- **信息性质不同**：三支柱存储的是**结构化的持久事实**（"我老婆叫小丽"、"Docker 网络调试方法"），这些信息的有效期是无限的。Journal 存储的是**对话杂项**（"今天调试了一个 Node.js 内存泄漏"），大部分是临时性的。
- **衰减模拟人脑**：人类记忆的工作方式就是"短期记忆 → 重复/重要 → 长期记忆，其余遗忘"。Journal 是短期记忆，三支柱是长期记忆。有价值的内容在 flush 时直接分流到三支柱（或用户后续显式提升），不需要在 journal 里永久保存。
- **防止噪音累积**：无限累积的日志会降低检索质量——在 200 个日志文件中关键词匹配，噪音比信号多。衰减确保检索池保持高信噪比。
- **月度凝练保留精华**：日志不是直接删除，而是先凝练为月度摘要（~200 tokens/月）。12 个月的凝练总共也就 ~2400 tokens，不会成为负担。凝练过程中，LLM 会自动过滤掉过时的临时信息，保留有持续价值的洞察。
- **用户有逃生通道**：如果用户认为某条 journal 内容重要，可以在 30 天内手动或通过对话将其提升为 skill/profile 内容，避免被凝练压缩。

**风险**：凝练质量依赖 LLM。低质量凝练可能丢失有价值信息。缓解措施：凝练前保留原始文件 7 天的 "grace period"（凝练执行后不立即删除原文件，等下次生命周期检查时再删除）。
