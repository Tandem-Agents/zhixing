# Capability Compiler — 工具能力的动态分层与按需暴露

> ⚠️ **DEPRECATED（2026-05-11 起）**
>
> 经 Anthropic prompt cache 经验 5（工具集自始至终不动）+ OpenAI 兼容协议无 server-side tool deferral 能力的双重验证，"工具集动态演化"范式破坏 prefix cache（tools 一变 messages 历史全失效），与知行 cache 第一优先方向冲突。tool 方向已锁定"满载稳定 + Profile 子集（启动时一次决定）"，见 [`../design/specifications/context-management-v3-redesign.md`](../design/specifications/context-management-v3-redesign.md) §七。本文保留为决策痕迹，不再作为实施依据。
>
> ---
>
> 知行设计沉淀 · 重新审视"tools schema 每次满载"的隐含假设
>
> 沉淀于 2026-05-08

---

## 一、问题背景

cli REPL 实测发现：用户在已恢复对话中输入"你好"——dump 日志显示该次 LLM 调用 payload 中 **96% 是 tools schema**（10 个工具完整 JSON schema），1% 是 user message，3% 是其他。

更具体的数据：
- system prompt：~1500 tokens
- 10 个工具完整 schema：~10K tokens（占大头）
- user message："你好" 2 个字符
- messages 历史：取决于对话累积

短对话不需要任何工具，但每次仍强制送整套 tools schema —— **结构性浪费**。

更深层影响：弱模型（如 MiniMax / siliconflow 上的开源模型）在大量工具 schema 干扰下，**注意力被稀释**，输出质量明显下降——用户实测过"作长诗时穿插随机文件名 / 项目名 / 网络字符"的胡言。

## 二、第一性分析

LLM 调用是一个 stateless function：`messages → response`。它每次决策需要的信息可拆为三类，**密度差异巨大**：

| 信息类型 | 例 | 密度 |
|---|---|---|
| **能力觉知**（"我能做什么"） | "read 能读文件" | 一行自然语言（~5 tokens / 工具） |
| **调用约定**（"具体怎么调"） | path 参数类型 / 必需 / 可选 | 完整 JSON schema（~200 tokens / 工具） |
| **上下文状态** | 用户在做什么 / 历史 | messages 已含 |

**根本错位**：当前 API 设计把"能力觉知"和"调用约定"绑定为一次性满载——LLM 在做"是否需要 read"的能力觉知阶段，被强制吃下"read 怎么调用"的完整 schema。

**关键洞察**：LLM 决策的两个认知阶段可以拆分：

- 阶段 A（**发现**）："存在 read 工具" —— **一行自然语言就够**
- 阶段 B（**调用**）："read 接受 path 参数..." —— 真正需要时才看完整 schema

阶段 B 的需求是**条件性的**——只在 LLM 真要调用某工具时发生，不是每次调用都需要所有工具的 schema。

## 三、已知方案与各自局限

### 3.1 业界主流方案对比

基于 Claude Code / OpenClaw / Hermes 源码调研：

| 方案 | 描述 | 局限 |
|---|---|---|
| Claude Code | 每次满载所有工具 schema (~44KB YAML) | 假设强模型 + Anthropic prompt cache 命中率高；弱模型 / 无 cache 场景成本极高 |
| OpenClaw | user / policy / agent 多维过滤 | 粗粒度（按用户身份过滤），不按消息内容动态适配 |
| Hermes | 静态满载（与 Claude Code 同） | 同 Claude Code |

### 3.2 我们最初考虑过的方案及其局限

| 方案 | 描述 | 局限 |
|---|---|---|
| A1 启发式预测 | 程序按 input 关键词 / 路径模式预测当前需要的 tool 子集 | 脆弱（关键词识别不准）；配置维护负担；漏识别后无补救 |
| A2 LLM 两阶段自决 | 第一阶段仅 base tools 让 LLM 输出"我需要哪些工具"，第二阶段带子集真正回答 | 每次调用延迟翻倍；弱模型选择不准 |
| A3 启发式预测 + 元工具兜底 | A1 + LLM 通过元工具 request 遗漏的 | A1 + A2 缺点叠加；启发式漏识别 → 兜底再多调用 |

### 3.3 共同隐含假设

**所有以上方案（业界 + 我们最初的）都共享同一个隐含假设**：

> "工具是预先注册的全集，每次只决定送哪些"。

这个假设来源于 API 协议——Anthropic / OpenAI 的 tools 字段要求工具列表前置注册——方案设计自然落在"如何选子集"框架里。本设计选择重新审视这个假设。

## 四、Capability Compiler 设计

### 4.1 核心机制

把 tools schema 从**预注册全集**颠覆为**会话级演化的分层 state**，由 `CapabilityCompiler` 在每次 LLM 调用前实时编译。

### 4.2 四层结构

| 层 | 形式 | 暴露条件 |
|---|---|---|
| **Always** | tools 字段完整 schema | 永远（`memory` + `request_capabilities` 元工具） |
| **Hot** | tools 字段完整 schema | 本 session 已激活 + 7 轮内活跃 |
| **Discoverable** | system prompt 一行短描述 | 工具存在但本 session 未激活 / 已降级 |
| **Cold** | 完全不暴露 | 极远 LRU 距离 / sub-agent 隔离 / 用户禁用 |

### 4.3 第一次启动 / 全新对话

| 层 | 内容 |
|---|---|
| Always | `memory` + `request_capabilities`（schema 完整） |
| Hot | （空） |
| Discoverable | `read`, `write`, `edit`, `glob`, `grep`, `bash`, `web_fetch`, `schedule`, `Task` —— system prompt 末尾一行短描述索引 |
| Cold | （空） |

LLM 看 input + 索引 → 自主决定调哪个工具。

### 4.4 升级规则（→ Hot）

| 触发 | 语义 |
|---|---|
| LLM 调用 `request_capabilities(["X"])` 元工具 | X 升级到 Hot |
| `tool_use(X)` 实际执行（即使没 unlock 直接调用） | X 升级到 Hot；本轮静默执行，下轮 schema 完整暴露 |

### 4.5 保持规则（Hot 持续不降级）

**条件**：最近 **7 轮**内有过 `tool_use(X)`（LRU 模型）。

只要工具在使用窗口内活跃就保持完整 schema 暴露——LLM 同 task 反复用同一工具不会被反复要求 unlock。

### 4.6 降级规则（Hot → Discoverable）

**触发**：连续 **7 轮**未被 `tool_use(X)` → 降级。

降级**仅影响下次 LLM 调用的 tools 字段**——messages 历史中已有的 tool_use / tool_result 不动；LLM 通过历史仍能看到该工具被怎么用过；下次想再用，重新调用即可恢复 Hot。

### 4.7 重置规则（全部退回 Discoverable）

| 触发 | 行为 |
|---|---|
| `/clear` 命令 | 与历史压缩同步 |
| `/resume` 切换对话 | 新对话 state 独立 |
| cli session 重启 | 新 process 全新开始 |

### 4.8 LLM ↔ 程序双向契约（核心设计）

**LLM 视角永远只有一个统一行为**：看 system prompt 索引 → 知道工具存在 → 想用就直接 `tool_use(X, ...)`。**LLM 不需要懂 Hot / Discoverable 区分**。

**cli 层对 LLM 输出的响应**：

| LLM 输出 | cli 当前 capabilityState | cli 处理 | LLM 视角 |
|---|---|---|---|
| `tool_use(read, ...)` | read 在 **Hot** | 直接执行，返回 tool_result | 标准调用 ✓ |
| `tool_use(read, ...)` | read 在 **Discoverable** | **静默升级 read → Hot + 直接执行 + 返回 tool_result**（不报错） | 体感与上一行完全一样 ✓ |
| `tool_use(unknown, ...)` | 全表无此工具 | 返回错误 "unknown tool" | 错误（编造的工具名） |

**关键**：Discoverable → Hot 升级**对 LLM 完全透明**。LLM 永远只看到"索引里描述的工具都能直接调"。

### 4.9 一次激活多个（强模型优化）

LLM 可一次 `request_capabilities(["read", "grep", "edit"])` 升级三个工具 → 下一轮 schema 含三个 → 减少 round 次数。这是强模型的**批量预热优化路径**。

弱模型不会用此协议 → 自动升级机制（4.8）接管 → 同样工作。

### 4.10 完整流程演示（首次任务调用）

```
[Round 1]
  cli → LLM:
    system prompt 末尾: "Capabilities: read[file], write[file], grep[query], ..."
    tools schema: [memory, request_capabilities]   ← 极简
    user: "帮我读 src/foo.ts"
  
  LLM → cli:
    tool_use("read", { path: "src/foo.ts" })       ← LLM 直接调，不必学 unlock
  
  cli 内部:
    检测：read 是 Discoverable
    动作：read → Hot；执行 read；构造 tool_result
  
[Round 2]
  cli → LLM:
    tools schema: [memory, request_capabilities, read]   ← 静默扩展
    messages: [..., tool_use(read), tool_result(...)]
  
  LLM → cli:
    "这个文件主要负责..."
```

LLM 在两轮间没看到任何"unlock"协议——只是它的 tool_use 工作了、tool_result 回来了。

## 五、设计哲学

> **LLM 视角永远只有一个简单契约：你看到的索引里描述的工具，都能直接调。复杂度藏在 cli 层。**

- 弱模型按 instinct 工作 → cli 兜底（静默升级）
- 强模型用 unlock 批量优化 → cli 配合（一次升级多个）
- 两条路径都正确，LLM 怎么用都工作

## 六、价值与对比

### 6.1 短对话场景（typical "你好"）

| 状态 | system prompt | tools 字段 | 总 schema 体积 |
|---|---|---|---|
| 当前满载 | base | 10 工具完整 schema | ~10K tokens |
| Capability Compiler | base + 一行索引 (~50 tokens) | memory + request_capabilities (~250 tokens) | **~300 tokens** |

**降低 96-97%**。短对话不再为不会用的工具付费。

### 6.2 任务对话延迟

仅"首次激活"+1 轮 round trip（与三方业界 A2 同），激活后正常往返。Hot 层让用过的工具持续可调，长 task 不重复 unlock。

### 6.3 与三方策略的根本差异

| 维度 | Claude Code | OpenClaw | Hermes | **Capability Compiler** |
|---|---|---|---|---|
| 工具暴露策略 | 满载 | 多维过滤 | 满载 | **会话级演化分层** |
| LLM 工具发现 | 每次完整 schema | 同 | 同 | **Capability Index 一行描述** |
| 弱模型友好 | 否（依赖 prompt cache） | 中 | 否 | **是（兜底自动升级）** |
| 短对话开销 | ~10K tokens | 中 | ~10K tokens | **~300 tokens** |
| 长 task 持续性 | 满载（持续可用但成本高） | 同 | 同 | **Hot 层 LRU 保持，自然瘦身** |

### 6.4 设计核心（4 点）

1. **"工具"概念分层**：Discoverable（认知层）vs Hot（执行层）
2. **system prompt 与 tools schema 双轨适配**：一个轻量（觉知）一个重量（调用），按需展开
3. **session 演化 state**：tools 字段不是每次重建，是会话级累积的 working set
4. **LLM ↔ 程序双向契约**：LLM 通过 unlock 改变下轮可用集，程序通过 LRU 自动降级——形成自适应循环

## 七、关键参数（敲定值）

| 参数 | 值 | 理由 |
|---|---|---|
| 保持窗口 N（Hot LRU） | **7 轮** | 覆盖典型 task 流程；与人类工作记忆窗口（7±2）契合；任务切换后自然清理过气工具 |

参数**硬编码不开放配置**——一致行为优先于灵活性。弱模型 / 强模型 / 任意 provider 下行为统一。

## 八、实施路径

属于实现层（spec / 落地阶段）。本文档不展开具体代码归属、API 字段名、中间件位置等。落地时需考虑的关键钩子：

- `CapabilityState` per session（内存 state，含 layer 归属与最后 tool_use 轮序）
- `CapabilityCompiler`：每次 LLM 调用前 `compile(state, history) → (systemPrompt, toolsSchema)`
- 自动升级中间件：拦截 LLM tool_use 时检查 state，Discoverable 命中则升级 + 透明转发
- LRU 后台降级：在 `onTurnComplete` hook 中评估
- system prompt 索引模板：自然语言 + 一行格式
- `request_capabilities` 元工具：批量升级入口（强模型优化路径）

落地后将转入相应 specifications/ 文档。本设计文档作为产品方向 + 哲学的源头永久保留。
