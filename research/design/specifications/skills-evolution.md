# 知行技能进化系统设计方案

> 设计日期：2026-04-10
> 依赖调研：Hermes Agent Skills 系统源码分析 + OpenClaw Skills + Claude Code 记忆系统
> 前置设计：[记忆系统设计方案](./memory-system.md)（技能沉淀 = 记忆系统三支柱之一）
> 产品定位：个人助手（越用越聪明是核心价值承诺）

## 一、问题定义

### 1.1 现状

记忆系统方案已设计了技能沉淀（Phase M4）和主动提议（Phase M5），但聚焦于技能的**创建和检索**。技能一旦创建就是静态的——不会自动更新、不跟踪使用效果、不淘汰过时内容。

### 1.2 缺失的闭环

"越用越聪明"需要的是一个**完整的学习闭环**：

```
经历 → 反思 → 固化 → 使用 → 反馈 → 迭代
```

当前设计覆盖了"固化 → 使用"，但缺少：

- **反思**：复杂任务完成后，主动回顾"这次经验有没有可复用的方法论"
- **反馈**：技能被使用后，跟踪效果——是否帮助更快解决了问题
- **迭代**：发现更优方法时，更新已有技能而非重新创建
- **治理**：过时技能的识别和淘汰

### 1.3 竞品参考

#### Hermes Agent 的做法（源码级分析）

Hermes 是目前唯一实现了技能"自主进化"的开源智能体。核心机制：

| 机制 | 实现 | 优点 | 缺点 |
|------|------|------|------|
| 系统提示引导 | `SKILLS_GUIDANCE` 鼓励模型在复杂任务后保存 | 自然、低开销 | 取决于模型遵从度 |
| 后台 Review Agent | 每 N 轮工具调用后，spawn 子 AIAgent 静默审查 | 不依赖用户主动性 | **黑盒**——用户不知道写了什么 |
| `skill_manage` 工具 | create / patch / edit / delete 四个动作 | 功能完整 | 与主循环 9200 行代码耦合 |
| 安全扫描 | `skills_guard.scan_skill` 写后校验 | 防注入 | 无内容质量评估 |
| 渐进加载 | 索引 → 全文 → 子文件 三级 | 节省 token | 模型需要主动"拉取"，增加工具调用轮次 |

**Hermes 的核心缺陷**：

1. **静默进化**：后台子 Agent 可以不经用户确认直接写入/更新技能——违反透明原则
2. **无使用追踪**：不知道技能被使用了多少次、效果如何，无法判断技能质量
3. **无生命周期**：技能只增不减，长期使用后膨胀成噪音库
4. **质量靠运气**：技能质量完全依赖模型在 Review Prompt 下的表现，无结构化质量保障
5. **单文件膨胀**：进化逻辑耦合在 `run_agent.py` 的 9200 行中

#### OpenClaw 和 Claude Code

- OpenClaw：Skills 是静态文件，用户手动维护，无进化机制
- Claude Code：无 Skills 概念，CLAUDE.md 是项目级指令不是技能

### 1.4 设计目标

构建一个**透明的、有反馈的、有生命周期的技能进化系统**，满足：

1. **闭环学习**：经历 → 反思 → 固化 → 使用 → 反馈 → 迭代
2. **用户掌控**：所有创建和更新都经过用户确认，但 agent 主动发起
3. **质量信号**：通过使用追踪和效果反馈，形成技能质量的数据依据
4. **自然衰减**：过时技能被识别和淘汰，保持技能库高信噪比
5. **渐进采用**：从手动创建到自动提议，每步独立可验证

## 二、设计原则

| 原则 | 含义 | 与 Hermes 的对比 |
|------|------|-----------------|
| **透明优先** | 所有技能变更（创建/更新/归档）必须用户可见可确认 | Hermes 静默写入 |
| **提议而非执行** | Agent 提议变更，用户确认后才执行 | Hermes 后台直接执行 |
| **数据驱动** | 技能质量由使用数据（次数、效果）支撑，不靠直觉 | Hermes 无使用追踪 |
| **自然语言交互** | 技能管理通过对话完成，不需要特殊命令 | 相同 |
| **有机生命周期** | 技能有创建、成长、衰退、归档的完整生命周期 | Hermes 只增不减 |
| **安全写入** | 所有写入前经过内容安全扫描 | 相同思路，知行更声明式 |

## 三、技能进化架构

### 3.1 四阶段生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                    Skills Evolution Engine                       │
│                                                                 │
│  ┌── 创生（Genesis）──────────────────────────────────────────┐ │
│  │                                                             │ │
│  │  ① 显式创建：用户说"存为技能" → AI 提取方法论 → 保存      │ │
│  │  ② 反思提议：复杂任务后 Agent 反思 → 提议 → 用户确认      │ │
│  │  ③ Flush 分流：上下文压缩时 L1.5 → 方法论 → skills/       │ │
│  │  ④ 凝练晋升：Journal 月度凝练发现 [SKILL_CANDIDATE] →     │ │
│  │              草拟内容 → 用户确认晋升                        │ │
│  │                                                             │ │
│  └──────────────────────────────────────────────────┬──────────┘ │
│                                                      │           │
│  ┌── 使用（Application）────────────────────────────▼──────────┐ │
│  │                                                             │ │
│  │  ① Trigger 匹配 → 自动注入上下文                            │ │
│  │  ② 使用记录：+1 useCount, 更新 lastUsedAt                  │ │
│  │  ③ 效果推断：任务完成速度、用户反馈                          │ │
│  │                                                             │ │
│  └──────────────────────────────────────────────────┬──────────┘ │
│                                                      │           │
│  ┌── 进化（Evolution）──────────────────────────────▼──────────┐ │
│  │                                                             │ │
│  │  ① 更新提议：使用技能后发现更优方法 → 提议更新 → 确认     │ │
│  │  ② 版本追踪：frontmatter 记录修订历史                      │ │
│  │  ③ 内容安全扫描：写入前检查注入/外泄模式                   │ │
│  │                                                             │ │
│  └──────────────────────────────────────────────────┬──────────┘ │
│                                                      │           │
│  ┌── 治理（Governance）─────────────────────────────▼──────────┐ │
│  │                                                             │ │
│  │  ① 活跃度追踪：90 天未使用 → 标记 stale                   │ │
│  │  ② /skills audit：批量审查 → 保留 / 归档 / 删除           │ │
│  │  ③ 归档机制：移入 skills/.archive/，不注入但可查询         │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  EventBus: skill:created · skill:used · skill:updated ·         │
│            skill:proposed · skill:stale · skill:archived         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 与记忆系统的关系

技能进化系统**不是**独立于记忆系统的新模块，而是记忆系统"技能沉淀"支柱的**深化**。具体关系：

```
记忆系统（memory-system.md）
├── 支柱 1：身份画像（Profile）       ← 不变
├── 支柱 2：关系网络（Relationships）  ← 不变
├── 支柱 3：技能沉淀（Skills）         ← 本方案深化
│   └── Skills Evolution Engine         ← 创生 + 使用 + 进化 + 治理
├── 暂存层：Journal                    ← 不变，但凝练晋升与 Skills 联动
└── Memory Retriever                    ← 不变，trigger 注入逻辑复用
```

本方案的产出增强 Phase M4/M5/M6/M7，不新增独立 Phase。

## 四、核心机制设计

### 4.1 反思提议（Reflection-Triggered Proposal）

这是知行超越 Hermes 的核心机制。不同于 Hermes 的后台静默审查，知行在对话流中自然地完成反思：

#### 触发条件

```
复杂任务完成 = 以下条件全部满足：
  ① toolCallCount >= reflectionThreshold（默认 8）
  ② 本轮 Agent 返回了不含 tool_calls 的最终回复
  ③ conversationTurns >= 3（排除简单问答）
  ④ 未使用已有技能完成任务（如果靠技能完成，不算"新发现"）
```

#### 机制

反思**不是独立的 API 调用**（不同于 Hermes 的后台子 Agent），而是通过系统提示指导，让模型在最终回复中自然地附加提议。这意味着：

- **零额外成本**：不需要额外 LLM 调用
- **用户可见**：提议是回复的一部分，不是隐藏操作
- **自然语言**：不需要特殊 UI 组件

#### 系统提示指导

```markdown
## 技能进化指导

当你完成一个复杂任务（经历了多次工具调用、试错、或改变方法）后，
反思这个过程是否包含值得复用的方法论。

判断标准：
- 是否通过试错发现了一个非显而易见的方法？
- 用户是否纠正了你的初始方法，暴露了更好的路径？
- 这个方法是否可以在未来类似场景中复用？

如果值得保存，在回复末尾自然地提议：

  "💡 这个过程中我总结了一套方法，要存为技能吗？
   名称：[技能名]
   适用场景：[什么时候有用]
   核心要点：[简要概括]"

如果已有相关技能但本次发现了改进，提议更新：

  "💡 我发现之前的技能'[名称]'可以改进，要更新吗？
   改进点：[具体改进]"

规则：
- 绝不静默创建或更新技能，必须提议并等待用户确认
- 每次对话最多提议一个技能（避免信息过载）
- 简单任务不需要反思（少于 8 次工具调用）
- 如果用户说"好"或"存吧"，调用 memory 工具保存
```

#### 与 Hermes 的对比

| 维度 | Hermes | 知行 |
|------|--------|------|
| 触发方式 | 后台子 Agent + 独立 API 调用 | 系统提示引导，最终回复中自然提议 |
| 额外成本 | 每次 review 消耗一次 LLM 调用 | 零额外成本（复用最终回复） |
| 用户感知 | 不可见 | 可见，可确认/拒绝/修改 |
| 质量控制 | 模型自行决定 | 用户审核把关 |
| 复杂度 | threading + 子 Agent + stdout 重定向 | 仅系统提示 + SkillsStore 扩展 |

### 4.2 技能更新提议（Skill Evolution Trigger）

当 Agent 使用了一个已有技能但在过程中发现了更好的方法时，应该提议更新该技能。

#### 触发条件

```
技能需要更新 = 以下任一条件：
  ① Agent 使用了某 skill 注入的方法，但中途偏离了该方法并找到了更优路径
  ② 用户明确指出 skill 中的某个步骤是错的或过时的
  ③ Agent 发现 skill 遗漏了重要的边界情况或前置条件
```

#### 机制

与新建技能提议相同——在最终回复中自然地提议更新。用户确认后，通过 `memory` 工具的 `update` 动作执行。

更新时保留修订历史（见 4.5 版本追踪）。

### 4.3 使用追踪（Usage Tracking）

这是知行独有的创新——跟踪技能的使用情况和效果，为技能质量提供数据支撑。

#### 追踪维度

| 维度 | 说明 | 更新时机 |
|------|------|---------|
| `useCount` | 累计使用次数 | 每次 trigger 匹配注入时 +1 |
| `lastUsedAt` | 最后使用时间 | 每次使用时更新 |
| `effectiveness` | 效果评估 | 对话结束后推断（见下） |

#### 效果推断

效果不需要用户显式评价。通过以下信号自动推断：

| 信号 | 推断 | 说明 |
|------|------|------|
| 注入 skill 后，toolCallCount < 当初创建时的 toolCallCount | `helpful` | 技能帮助更快完成了类似任务 |
| 注入 skill 后，用户说"不对"/"这个方法行不通" | `needs-update` | 技能内容可能过时 |
| 注入 skill 后，Agent 完全没有参考 skill 内容 | `possibly-irrelevant` | trigger 匹配可能太宽泛 |
| 未自动推断 | `unknown` | 默认值，不做假设 |

**设计要点**：效果推断是**辅助信号**，不会自动触发任何操作。它只影响两件事：
- `/skills audit` 时的排序和推荐
- Phase M7 的检索优先级（高效 skill 优先注入）

### 4.4 内容安全扫描

借鉴 Hermes 的 `_scan_memory_content`，但适配知行的架构：

#### 扫描时机

所有对 `me/skills/` 目录的写入操作（创建、更新、flush 分流、凝练晋升）在持久化前经过扫描。

#### 威胁模式

```typescript
const SKILL_THREAT_PATTERNS: ThreatPattern[] = [
  // 提示注入
  { id: "injection-role", pattern: /ignore\s+(previous|above|all)\s+instructions/i, severity: "block" },
  { id: "injection-system", pattern: /you\s+are\s+(now|no\s+longer)/i, severity: "block" },
  { id: "injection-override", pattern: /\bsystem\s*:\s*/i, severity: "warn" },

  // 数据外泄
  { id: "exfil-curl", pattern: /curl\s+.*https?:\/\/(?!localhost)/i, severity: "block" },
  { id: "exfil-wget", pattern: /wget\s+.*https?:\/\//i, severity: "block" },
  { id: "exfil-fetch", pattern: /fetch\s*\(\s*['"]https?:\/\//i, severity: "block" },

  // 凭证读取
  { id: "cred-env", pattern: /process\.env\[/i, severity: "warn" },
  { id: "cred-ssh", pattern: /\.ssh\/(id_rsa|id_ed25519|authorized_keys)/i, severity: "block" },
  { id: "cred-dotenv", pattern: /cat\s+.*\.env\b/i, severity: "block" },

  // 不可见字符（常见注入载体）
  { id: "invisible-unicode", test: (s) => /[\u200B-\u200F\u2028-\u202F\uFEFF]/.test(s), severity: "block" },
];
```

#### 扫描结果处理

| severity | 行为 |
|----------|------|
| `block` | 拒绝写入，告知用户原因 |
| `warn` | 写入但在 CLI 渲染警告，告知用户检查 |

### 4.5 版本追踪（Revision History）

技能不是一成不变的。每次更新都记录修订历史，让用户可以追溯进化过程。

#### 增强的 Frontmatter

```markdown
---
title: Docker 容器网络调试
tags: [docker, networking, debug]
triggers: ["docker network", "容器连不上", "port mapping"]
created: 2025-06-15
updated: 2025-08-03
source: conversation
version: 3
useCount: 7
lastUsedAt: 2025-08-01
effectiveness: helpful
revisions:
  - version: 1
    date: 2025-06-15
    reason: initial
    summary: "基础排查步骤：检查网络模式、验证 DNS、检查端口映射"
  - version: 2
    date: 2025-07-10
    reason: reflection-update
    summary: "新增 IPv6 排查步骤和 Docker Desktop 特殊处理"
  - version: 3
    date: 2025-08-03
    reason: user-update
    summary: "补充 Docker Compose 网络的排查方法"
---
```

**revisions 限制**：最多保留最近 10 条修订记录。更早的自动裁剪（只保留 `version: 1` 的初始记录）。

### 4.6 技能治理（Governance）

#### 生命周期状态

```
Active ──→ Stale（90 天未使用）──→ Archived（用户确认归档）
  ↑            │                        │
  └────────────┘                        ▼
   （再次使用时自动复活）          skills/.archive/
                                  不参与 trigger 注入
                                  可通过 /skills search 查询
                                  可通过 /skills restore 恢复
```

#### 状态转换规则

| 转换 | 触发条件 | 是否需要用户确认 |
|------|---------|----------------|
| Active → Stale | `lastUsedAt` 距今 > 90 天 | 否（标记，不删除） |
| Stale → Active | trigger 再次匹配并注入 | 否（自动） |
| Stale → Archived | 用户在 `/skills audit` 中确认 | **是** |
| Archived → Active | 用户执行 `/skills restore <id>` | **是** |
| Any → Deleted | 用户执行 `/skills delete <id>` | **是** |

#### /skills audit 交互

```
📊 技能库健康报告

  活跃 (Active):  12 个（90 天内使用过）
  沉寂 (Stale):    3 个（超过 90 天未使用）
  归档 (Archived):  1 个

  沉寂技能：
  1. "CentOS 7 yum 代理配置"
     创建于 2025-01-20 · 使用 2 次 · 最后使用 2025-02-15
     → [归档] [保留] [删除]

  2. "Python 2 编码修复"
     创建于 2025-02-03 · 使用 1 次 · 最后使用 2025-02-03
     → [归档] [保留] [删除]

  3. "Webpack 4 代码拆分"
     创建于 2025-03-10 · 使用 0 次 · 从未使用
     → [归档] [保留] [删除]

  效果存疑：
  4. "Node.js 内存泄漏排查"（评估: needs-update）
     创建于 2025-05-01 · 使用 3 次 · 最近一次使用时用户指出方法过时
     → [编辑] [归档] [保留]
```

### 4.7 技能索引与发现

#### 默认策略（已有设计，不变）

技能通过 `triggers` 字段匹配用户消息，命中时自动注入上下文。这是知行的核心优势——只在相关时才注入，不浪费 token。

#### 增强：轻量索引注入（新增，可选）

在系统提示中注入一行**极轻量**的索引提示（仅在技能数量 > 5 时），让 Agent 知道自己有哪些技能领域的积累：

```markdown
## 你的技能库
你有以下领域的积累经验（遇到相关问题时会自动注入详细内容）：
Docker 网络调试 · TypeScript Monorepo · Git 分支策略 · Nginx 反向代理 · ...
```

这一行通常 < 100 tokens。它解决了一个 trigger 方案的盲区：当用户的消息没有命中任何 trigger 但其实某个 skill 相关时，Agent 可以**主动问用户**"你之前有一个关于 X 的技能，需要参考吗？"。

这是 Hermes 的三级加载和知行 trigger 方案的**融合**——日常靠 trigger 精确注入，边界情况靠 Agent 的领域感知兜底。

### 4.8 Skill 冲突与优先级

当多个 skill 的 trigger 同时被命中时：

```
优先级排序 =
  ① trigger 匹配精确度（精确匹配 > 子串匹配 > tag 匹配）
  × ② effectiveness 系数（helpful: 1.0, unknown: 0.8, needs-update: 0.5）
  × ③ 新鲜度系数（30 天内: 1.0, 90 天内: 0.8, >90 天: 0.5）
```

在 token 预算内，按排序注入 top-K。预算不足时只注入排名最高的。

## 五、核心类型设计

### 5.1 增强的 SkillMeta

```typescript
interface SkillMeta {
  title: string;
  tags: string[];
  triggers: string[];
  created: string;                // ISO 8601
  updated?: string;               // ISO 8601，最后更新时间
  source: SkillSource;

  // ─── 进化追踪（新增）───
  version: number;                // 版本号，每次更新 +1
  revisions?: SkillRevision[];    // 修订历史（最多 10 条）

  // ─── 使用追踪（新增）───
  useCount: number;               // 累计使用次数
  lastUsedAt?: string;            // 最后使用时间
  effectiveness: SkillEffectiveness;  // 效果评估
}

type SkillSource =
  | "manual"           // 用户手动创建
  | "conversation"     // 对话中用户说"存为技能"
  | "reflection"       // 反思提议后用户确认
  | "flush"            // 上下文压缩时 L1.5 分流
  | "condensation";    // Journal 凝练晋升

type SkillEffectiveness =
  | "unknown"              // 默认值
  | "helpful"              // 使用后任务效率提升
  | "needs-update"         // 用户指出内容过时
  | "possibly-irrelevant"; // 注入后未被 Agent 参考

interface SkillRevision {
  version: number;
  date: string;                   // ISO 8601
  reason: SkillUpdateReason;
  summary: string;                // 变更摘要（一句话）
}

type SkillUpdateReason =
  | "initial"               // 首次创建
  | "user-update"           // 用户主动修改
  | "reflection-update"     // Agent 反思后提议更新
  | "flush-update"          // 压缩时发现新信息补充
  | "user-edit";            // 用户直接编辑文件
```

### 5.2 安全扫描

```typescript
interface SkillSecurityScanner {
  scan(content: string): ScanResult;
}

interface ScanResult {
  safe: boolean;
  threats: ThreatMatch[];
}

interface ThreatMatch {
  patternId: string;         // 威胁模式 ID
  matched: string;           // 命中的内容片段
  severity: "block" | "warn";
}
```

### 5.3 治理

```typescript
type SkillStatus = "active" | "stale" | "archived";

interface SkillAuditReport {
  active: SkillAuditEntry[];
  stale: SkillAuditEntry[];
  archived: SkillAuditEntry[];
  needsUpdate: SkillAuditEntry[];   // effectiveness = "needs-update"
}

interface SkillAuditEntry {
  id: string;
  title: string;
  status: SkillStatus;
  useCount: number;
  lastUsedAt?: string;
  created: string;
  effectiveness: SkillEffectiveness;
}
```

### 5.4 EventBus 事件

```typescript
type SkillEvents = {
  'skill:created':   { id: string; title: string; source: SkillSource };
  'skill:updated':   { id: string; title: string; version: number; reason: SkillUpdateReason };
  'skill:used':      { id: string; title: string; useCount: number; trigger: string };
  'skill:proposed':  { id: string; title: string; action: 'create' | 'update' };
  'skill:stale':     { id: string; title: string; daysSinceLastUse: number };
  'skill:archived':  { id: string; title: string };
  'skill:restored':  { id: string; title: string };
  'skill:blocked':   { id: string; title: string; threats: ThreatMatch[] };
};
```

## 六、与现有记忆系统 Phase 的集成

本方案不新增独立 Phase，而是增强 Phase M4/M5/M6/M7：

### Phase M4 增强：技能沉淀 + 进化基础

**原有内容**：
- `skills/` 目录管理、trigger 匹配、"存为技能"对话流、`/skills` 命令

**新增内容**：
- 增强的 SkillMeta（version、useCount、lastUsedAt、effectiveness、revisions）
- 使用追踪：trigger 匹配注入时更新 useCount/lastUsedAt
- 内容安全扫描：创建/更新前扫描
- 版本追踪：更新时记录 revision
- `/skills audit` 命令
- 归档机制：`skills/.archive/` 目录
- 技能索引提示（system prompt 中的一行领域列表）
- EventBus 事件发射

### Phase M5 增强：主动提议 + 反思触发 + 更新提议

**原有内容**：
- AI 检测到值得记忆的信息时主动提议保存

**新增内容**：
- 反思提议触发：复杂任务完成后（toolCallCount >= 8），系统提示引导 Agent 在回复末尾提议
- 技能更新提议：使用已有 skill 后发现改进点，提议更新而非新建
- 提议频率控制：每次对话最多 1 个提议

### Phase M6 增强：Journal + Auto Flush + 凝练晋升强化

**原有内容**：
- Journal 目录 CRUD + 凝练 + Memory Flush (L1.5)
- `[SKILL_CANDIDATE]` 标记

**新增内容**：
- 凝练时为 `[SKILL_CANDIDATE]` 自动草拟完整 skill 内容（含 title、tags、triggers、正文）
- 用户可一键确认晋升，而非手动重写
- 提供 diff 视图：如果已有同名技能，展示与现有技能的差异

### Phase M7 增强：召回优化 + 效果反馈 + 完整治理

**原有内容**：
- 跟踪 skill 被引用次数 → 高频优先注入 → 低频降级

**新增内容**：
- 效果推断逻辑（基于对话信号自动评估 effectiveness）
- 多 trigger 冲突时的优先级排序（精确度 × 效果 × 新鲜度）
- Stale 检测（90 天未使用自动标记）
- `/skills audit` 交互式审查
- 归档/恢复/删除完整流程

## 七、渐进实现路线

每步独立可验证，不依赖后续步骤。与记忆系统的 Phase 编号保持一致。

### Phase M4: 技能沉淀 + 进化基础

#### M4a: 技能 CRUD + Trigger 注入（原 Phase M4）

**做什么**：
- `skills/` 目录管理（创建/读取/更新/删除）
- Frontmatter 解析（title、tags、triggers + 新字段 version、useCount 等）
- Trigger 匹配逻辑：用户消息 vs skill.triggers 子串匹配
- "存为技能" 对话流（AI 从对话上文提取方法论，保存为 skill 文件）
- `/skills` 斜杠命令（列出所有技能，含 status/useCount）

**验证**：
- 解决一个问题后说 "存为技能" → AI 自动提取并保存，frontmatter 含完整字段
- 后续遇到类似问题 → AI 自动引用之前保存的技能
- 查看 skill 文件，version=1、useCount 随注入递增

**交付**：
```
packages/core/src/memory/skills-store.ts      # CRUD + Frontmatter 解析
packages/core/src/memory/retriever.ts          # Trigger 匹配 + useCount 更新
```

#### M4b: 内容安全扫描

**做什么**：
- `SkillSecurityScanner` 实现（正则威胁模式 + 不可见 Unicode 检测）
- 所有 skill 写入操作的前置检查
- block 时拒绝并提示、warn 时写入并渲染警告

**验证**：
- 尝试保存含 `curl http://evil.com` 的 skill → 被拒绝
- 尝试保存含不可见 Unicode 的 skill → 被拒绝
- 正常 skill 内容 → 通过

**交付**：
```
packages/core/src/memory/skill-security.ts     # 安全扫描
```

#### M4c: 版本追踪 + 归档

**做什么**：
- 更新 skill 时自动递增 version、记录 revision
- revisions 数组维护（最多 10 条，裁剪时保留 version: 1）
- `skills/.archive/` 目录 + 归档/恢复逻辑
- `/skills audit` 命令（列出 active/stale/archived + 操作菜单）

**验证**：
- 更新 skill → version +1，revisions 中出现新记录
- `/skills audit` → 正确分类并展示状态
- 归档 → skill 移入 `.archive/`，不再触发注入
- 恢复 → skill 移回 `skills/`，重新参与匹配

**交付**：
```
packages/core/src/memory/skill-governance.ts   # 状态检测 + 归档/恢复
packages/cli/src/repl.ts                       # /skills audit 命令
```

### Phase M5: 主动提议 + 反思触发

#### M5a: AI 主动提议保存（原 Phase M5）

**做什么**：
- 系统提示词中添加记忆管理指导（何时提议保存/更新）
- 提议频率控制（每次对话最多 1 个技能提议）
- 用户确认后通过 memory 工具执行保存

**验证**：
- 长对话解决复杂问题后，AI 在回复末尾提议存为技能
- 首次提到某人的详细信息时，AI 提议添加到关系网络
- 简单对话（< 3 轮）不触发提议

**交付**：
- 系统提示词扩展（何时提议的指导）

#### M5b: 反思触发提议

**做什么**：
- 系统提示中添加技能进化指导（本方案 4.1 节的内容）
- Agent Loop 中记录 toolCallCount（已有），传入系统提示的动态注入部分
- 动态注入提示：当 toolCallCount >= threshold 时，注入反思引导到动态 context

**验证**：
- 任务涉及 10+ 次工具调用后，AI 在回复中自然地提议保存技能
- 简单任务（3 次工具调用）不触发反思
- 用户说"好"→ 调用 memory 工具保存，source = "reflection"

**交付**：
```
packages/core/src/memory/reflection.ts         # 反思条件判断
packages/cli/src/system-prompt.ts              # 动态注入反思引导
```

#### M5c: 技能更新提议

**做什么**：
- 当 trigger 匹配注入了某个 skill 时，在动态 context 中标记"本次使用了技能 X"
- 系统提示指导：如果发现已注入的技能有可改进之处，在回复末尾提议更新
- 更新时自动记录 revision，reason = "reflection-update"

**验证**：
- 使用了某 skill 但发现了更好方法 → AI 提议更新
- 用户确认 → skill 文件更新，version +1，revisions 新增记录
- 用户拒绝 → 不变

**交付**：
- 系统提示词扩展（更新提议的指导）

### Phase M6 增强：凝练晋升强化

**新增做什么**：
- 凝练 Prompt 增强：要求 LLM 为 `[SKILL_CANDIDATE]` 草拟完整的 skill frontmatter + 正文
- 凝练结果中展示预览，用户可一键确认晋升
- 如果已有同名技能，展示 diff

**验证**：
- 凝练时发现方法论 → 输出含 `[SKILL_CANDIDATE]` + 草拟的完整 skill
- 用户确认 → 自动创建 skill 文件，source = "condensation"

### Phase M7 增强：使用追踪 + 效果反馈 + 完整治理

#### M7a: 效果推断

**做什么**：
- 对话结束时，如果使用了 skill，基于信号推断 effectiveness
- 推断结果写入 skill frontmatter

**验证**：
- 注入 skill 后快速完成任务 → effectiveness = "helpful"
- 注入 skill 后用户说"这个不对" → effectiveness = "needs-update"

#### M7b: 检索优先级

**做什么**：
- Trigger 冲突时的优先级排序：精确度 × 效果 × 新鲜度
- 高效 skill 优先注入

**验证**：
- 两个 skill 的 trigger 同时命中 → 效果好的优先注入

#### M7c: 完整治理循环

**做什么**：
- Stale 自动检测（CLI 启动时扫描 + Server 模式定时扫描）
- `/skills audit` 增强：效果存疑的 skill 单独展示
- CLI 启动时提示："有 3 个技能超过 90 天未使用，输入 /skills audit 审查"

## 八、与 OpenClaw / Hermes / Claude Code 的完整对比

| 维度 | OpenClaw | Claude Code | Hermes | **知行** |
|------|----------|-------------|--------|---------|
| **技能概念** | 静态 Skills 文件 | 无 | 自主进化 Skills | **进化式技能 + 使用追踪** |
| **创建方式** | 手动维护 | N/A | 系统提示引导 + 后台静默创建 | **4 种创建路径，全部用户确认** |
| **进化机制** | 无 | N/A | 后台子 Agent 静默 patch | **反思提议 + 更新提议，用户确认** |
| **使用追踪** | 无 | N/A | 无 | **useCount + lastUsedAt + effectiveness** |
| **效果反馈** | 无 | N/A | 无 | **基于对话信号的自动推断** |
| **生命周期** | 无限累积 | N/A | 无限累积 | **Active → Stale → Archived → Deleted** |
| **安全扫描** | 无 | N/A | skills_guard.scan_skill | **声明式正则 + 不可见字符检测** |
| **注入方式** | 全量注入 system prompt | N/A | 三级渐进加载（索引→全文→文件） | **Trigger 精确注入 + 领域索引兜底** |
| **优先级排序** | 无 | N/A | 无 | **精确度 × 效果 × 新鲜度** |
| **版本追踪** | 无 | N/A | frontmatter version（不强制） | **version + revisions 修订历史** |
| **用户透明度** | 可见（手动维护） | N/A | 低（后台静默） | **完全透明（提议+确认）** |
| **额外 LLM 成本** | 无 | N/A | 每次 review 一次 API 调用 | **零额外成本（复用最终回复）** |
| **治理工具** | 无 | N/A | `/skill delete` 等 | **/skills audit 交互式审查** |
| **技术实现** | 独立 SKILL.md 文件 | N/A | 耦合在 run_agent.py 9200 行中 | **独立模块 + EventBus 集成** |

## 九、决策记录

### ADR-021: 为什么反思不用后台子 Agent

**背景**：Hermes 在主循环之外 spawn 一个子 Agent 来静默审查是否需要创建/更新技能。

**决策**：知行通过系统提示引导，让主 Agent 在最终回复中自然提议，不使用后台子 Agent。

**理由**：
- **零额外成本**：不需要额外 LLM 调用，反思是最终回复的一部分
- **用户可见**：提议出现在对话中，用户可以审阅、修改、拒绝
- **架构简单**：不需要 threading + stdout 重定向 + 子 Agent 生命周期管理
- **质量更高**：用户确认机制天然过滤低质量 skill
- **一致性**：与知行"透明优先"原则一致

**风险**：模型可能不够遵从系统提示的反思引导。缓解措施：
- toolCallCount >= threshold 时，在动态 context 中显式注入反思引导
- 如果模型经常不提议，可以在 Agent Loop 层面做后置检查提醒

### ADR-022: 为什么需要使用追踪

**背景**：Hermes、OpenClaw、Claude Code 都不跟踪技能/记忆的使用效果。

**决策**：知行记录每个技能的 useCount、lastUsedAt、effectiveness。

**理由**：
- **数据驱动治理**：没有使用数据，就无法区分"有用的好技能"和"创建后再也没用的技能"
- **检索优化**：高效技能应该在 token 预算紧张时优先注入
- **用户信心**：`/skills audit` 展示使用数据，帮助用户做出"保留 or 归档"的知情决策
- **衰减依据**：90 天未使用的 stale 判断，需要 lastUsedAt 支撑

**设计约束**：
- 追踪是**被动记录**，不主动触发任何操作（不自动删除/降级）
- 所有基于追踪数据的变更都需要用户确认
- effectiveness 是推断而非确定，标注为"辅助信号"

### ADR-023: 为什么技能有生命周期而不是无限累积

**背景**：Hermes 和 OpenClaw 的技能/记忆都只增不减。

**决策**：知行技能有 Active → Stale → Archived 生命周期，且归档/删除需用户确认。

**理由**：
- **信噪比**：100 个技能中有 60 个是过时的，trigger 匹配时噪音压过信号
- **token 效率**：即使用 trigger 精确注入，过多的 stale skill 仍消耗 trigger 匹配的计算量
- **认知负担**：用户执行 `/skills` 时看到大量过时内容，降低信任感
- **与 Journal 一致**：Journal 有衰减机制，Skills 也应该有（但门槛更高——90 天 vs 30 天）
- **安全网**：归档不是删除，用户随时可恢复

### ADR-024: 为什么 Trigger 注入 + 领域索引优于三级渐进加载

**背景**：Hermes 用三级渐进加载（索引 → skill_view → 子文件），知行用 trigger 匹配自动注入。

**决策**：知行以 Trigger 注入为主，辅以系统提示中的一行领域索引。

**理由**：
- **被动精准 vs 主动搜索**：Trigger 方式无需模型主动调用工具查看 skill，减少工具调用轮次
- **token 效率**：Hermes 的索引注入全部技能名+描述到 system prompt（随技能数量线性增长），知行的 trigger 只在匹配时注入（常量开销）
- **兜底覆盖**：一行领域索引（< 100 tokens）让 Agent 知道自己有哪些领域积累，可以主动问用户
- **最佳组合**：日常场景靠 trigger 精确注入（零主动搜索成本），边界场景靠领域感知兜底
