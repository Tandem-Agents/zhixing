# 对话模型 (Conversation Model)

> **版本**:v2.3
> **状态**:📐 设计稿（2026-04-21 修订：新增 TurnId）
> **关联**:
>
> - [session-persistence.md](./session-persistence.md) — Transcript 持久化层（被本文档归并）
> - [server-gateway.md](./server-gateway.md) — RPC 协议层（含 Channel 接入）
> - [persistent-service.md](./persistent-service.md) — Scheduler / Background Agent 集成点
> - [message-outbox.md](./message-outbox.md) — TurnId 的消费者（因果依赖标签）

---

## 一、核心概念

知行的"对话"由三个清晰分层的概念构成,它们对应三个时间尺度,承担不同职责。

### 1.1 三层定义

```
┌─────────────────────────────────────────────────────────────────┐
│ Conversation  对话      用户视角的对话身份             长期(月/年) │
│   ↕  加载 / 持久化                                               │
│ Session       会话实例   Conversation 的内存运行态     短期(分/时) │
│   ↕  执行 turn                                                   │
│ Turn          一轮       一次 agent loop 完整执行      瞬时(秒)   │
└─────────────────────────────────────────────────────────────────┘
```


| 概念               | 它是什么                                                   | 它不是什么                            |
| ---------------- | ------------------------------------------------------ | -------------------------------- |
| **Conversation** | 用户视角的"一段持续的对话",有 ID、可命名、可列出、可重开;持久化在磁盘                 | 不是进程,不是连接,不是单次提问                 |
| **Session**      | 一个 Conversation 被加载到内存后的运行态容器:消息缓冲、provider 连接、工具集、并发锁 | 不是历史记录,不是用户能看到的概念                |
| **Turn**         | 一次完整的 agent loop——用户发一条消息,agent 回复(可能含多次工具调用),最终结束     | 不是一次 LLM API 调用(一个 Turn 内部可能有多次) |


### 1.2 类比理解

```
微信里:                              知行里:
┌─────────────────────┐              ┌─────────────────────┐
│ "和老王的聊天"       │      ←→      │    Conversation     │
│  (永久存在,云端在)   │              │    (永久,磁盘在)     │
└──────────┬──────────┘              └──────────┬──────────┘
           │ 打开微信加载                         │ 进程/server 加载
           ▼                                     ▼
┌─────────────────────┐              ┌─────────────────────┐
│  当前打开的聊天窗口   │              │       Session       │
│   (内存,关掉就没)    │              │     (内存,释放就没)  │
└──────────┬──────────┘              └──────────┬──────────┘
           │ 你发消息他回复                       │ 用户发,agent 回
           ▼                                     ▼
┌─────────────────────┐              ┌─────────────────────┐
│      一来一回        │              │ Turn                │
│     (毫秒到秒)       │              │  (毫秒到秒)         │
└─────────────────────┘              └─────────────────────┘
```

### 1.3 词汇约束

自本文档生效起,代码、注释、设计文档、用户文案中:

- **禁止裸用 "session"** — 必须明确是 `SessionRuntime`(实现层)还是 `Conversation`(用户层)
- 用户文案统一称"对话"(对应 Conversation)
- 实现层文件、类、字段统一用 `Conversation` / `SessionRuntime` / `Turn`
- 历史代码中残留的 `session`* 命名按 §13 路线统一重构

---

## 二、核心架构原则

### 原则 1:概念分层(Layering)

Conversation / Session / Turn 三层在生命周期、职责、可见性上互相独立。任何模块(Scheduler、Background Agent、Channel)需要表达"对话归属"时,只能引用 Conversation;需要表达"当前内存执行态"时,只能引用 Session;需要表达"一次完整问答"时,只能引用 Turn。**禁止跨层借用概念**。

### 原则 2:通道平权(Channel Parity)

**所有客户端形态都是"通道"(Channel),server 视角下完全平级,没有任何内置/官方/第三方的特权差别。**


| 客户端形态     | 通道实现            | transport              |
| --------- | --------------- | ---------------------- |
| 知行 CLI    | CliChannel      | WebSocket(本地 loopback) |
| 驭灵 App    | AppChannel      | WebSocket              |
| 驭灵 Web    | WebChannel      | WebSocket / SSE        |
| 钉钉机器人     | DingtalkChannel | 钉钉 SDK 长连接             |
| 飞书机器人     | LarkChannel     | 飞书 SDK                 |
| 邮件        | EmailChannel    | SMTP / IMAP            |
| RPC 调试客户端 | RpcChannel      | WebSocket(开发用)         |


WebSocket 不是亲儿子专享的协议,只是某些通道恰好用 WS 做 transport——和钉钉用钉钉 SDK 是同一性质,**对 server 一视同仁**。

后果:

- Session 释放规则统一,不区分通道类型
- 通道接口对所有实现者(包括第三方)完全相同
- server 内部无 `if (channel === "cli")` 分支
- 通道顺序(谁先接入)不影响 Conversation 行为

### 原则 3:用户视角永远是 Conversation

用户能感知、能操作、能命名、能列出的只有 Conversation。Session 与 Turn 是系统内部细节,用户文档不应出现这两个词,UI 不应暴露它们。

### 原则 4:默认零配置,可选感知

新用户从不需要理解 Conversation 概念也能使用——所有交互自动落入"默认对话"。需要话题分类的进阶用户才会接触 `/new`、`/switch` 等管理命令。

### 原则 5:Conversation 是用户资产

Conversation 数据(消息历史、元信息)归用户所有,与 server 进程、客户端进程都解耦。server 重启不丢、客户端切换不丢、跨设备一致。

### 原则 6:Conversation 是知行的唯一真相源(Single Source of Truth)

**所有通道收到的消息,一律保存到知行自己的 Conversation;知行的 transcript 是 agent 的唯一上下文来源。**

不管消息来自哪个通道——驭灵 App、钉钉机器人、飞书、邮件,**知行端都要原样保存一份到对应 Conversation 的 transcript**。第三方 IM(钉钉/微信)在它们自己客户端里也保留一份消息记录,那是它们的事,与知行**完全无关**。

为什么必须知行自己存:

1. **Agent 需要上下文**:agent 跑下一轮 Turn 时读的是知行的 SessionRuntime.messages,不能去问钉钉"我们之前聊了啥"
2. **跨通道一致**:用户在驭灵 App 说一句、在钉钉接一句、AI 都能接上——只能靠知行端统一的真相源
3. **数据所有权**:用户能 `/list`、`/history`、归档、迁移自己的对话——这要求数据归知行存、归用户控
4. **离线/降级能力**:某个 IM 平台挂了或封了,知行的 Conversation 还在,用户换通道就能继续

**通道平权在数据层的表达**:**没有哪个通道的消息可以"绕过"Conversation 直接送给 agent**。驭灵 App 也不行(虽然是自家),钉钉也不行(虽然第三方有自己的备份)。所有通道的入站/出站都强制经过 ConversationManager 的 ingest/deliver,这是架构层的硬约束,不是规范文档的软建议。

---

## 三、Conversation 详解

### 3.1 字段定义

```typescript
interface Conversation {
  /** 用户可读的稳定 ID,创建后不可改;用于跨进程引用 */
  id: string;                          // "default" | "work" | "trip-2026"

  /** 用户给的显示名,可重命名 */
  name: string;                        // "默认对话" | "工作" | "三月旅行"

  createdAt: string;                   // ISO 8601
  lastActiveAt: string;                // 最近一次 turn 完成时刻

  /** 默认对话标记,不可删除 */
  isDefault: boolean;

  /** 归档:从默认列表隐藏,但物理数据保留 */
  archived: boolean;

  /** 偏好的 model / provider(首次对话时确定,可被显式覆盖) */
  preferredModel?: string;
  preferredProvider?: string;

  /** 隔离作用域 */
  scope: ConversationScope;

  // ── 以下字段由 context-architecture.md 定义，P2+ 引入 ──

  /** 不可驱逐的消息 ID 列表（见 context-architecture §6.1） */
  pinnedMessageIds: string[];

  /** 当前场景 hint；创建时默认 'interactive'，Turn 1 由分类器覆写，之后 Sticky 只升不降（见 context-architecture §10.2） */
  currentHint: ScenarioHint;  // 默认值 'interactive'

  /** 临时对话标记（见 §3.7） */
  ephemeral?: boolean;
}

type ConversationScope =
  | { kind: "user" }                                     // 用户级:任意目录运行同源(默认)
  | { kind: "workscene"; sceneId: string };              // 工作场景级:绑定到显式 workscene 子树
```

**产品哲学**:conversation 跟着用户走、不绑 cwd —— 知行核心定位是"任意目录运行效果一致"(对齐 [ADR-003](../architecture/decisions/003-config-system.md) workspace 是用户级偏好)。default 是用户级,跨 cwd 共享;workscene 是用户显式创建的工作语境实体,绑该场景子树。**不引入 cwd 自动隔离 scope**,因为 hash 目录冒充产品概念是与产品哲学逆向的设计。

**路径源单一 dispatcher**:`conversationsDir(scope: ConversationScope): string` 是 conversation 模块的对外路径源 API,所有消费者(cli/serve 入口、TranscriptStore 等)通过此函数取得磁盘根目录,不独立拼接 path 字符串。未来增加 scope 时入口零改动(单点扩展)。

### 3.2 生命周期

```
创建 (create)
   │ 通道首次需要它 / 用户 /new / 系统自动确保 default
   ▼
持久化 (磁盘 transcript.jsonl 写入 header)
   │
   │ 任意通道引用 → 加载到内存 → 见 §四
   │
   ▼
归档 (archive,可选)
   │ 从默认 list 隐藏,物理保留
   │
   ▼
删除 (delete)
   │ 移入回收站(~/.zhixing/trash/<id>-<ts>/)
   │ 7 天后清理
   ▼
彻底消失
```

**不变式**:

- `id` 创建后不可改(rename 改的是 `name`)
- 任意时刻**最多有 1 个 Session 实例**对应同一 Conversation(详见 §四)
- Conversation 与 Session 解耦——Session 释放,Conversation 不变

### 3.3 默认对话(Default Conversation)

**永远存在一个 `id="default"` 的 Conversation,系统首次启动时自动创建,不可删除。**

理由:

- 用户从不主动建任何对话时,所有交互有归宿
- 跨通道 DM 的默认归宿(钉钉/CLI/Web 的 DM 都进 default,用户跨通道无感衔接)
- 任务结果显式指定写入对话时,默认目标
- 新手友好:80% 用户一辈子只用 default

### 3.4 标识与命名

**Conversation ID 用 slug 而非 UUID**:

- 用户在多通道说 `/switch trip-2026` 比 `/switch 550e8400-...` 自然
- 出现在日志、文件路径、命令里都可读
- 用户未显式命名时,自动生成 `chat-<日期>-<序号>`(如 `chat-20260417-1`)

**ID 生成规则**:

```typescript
function generateConversationId(name?: string): string {
  if (!name) return autoChatId();                   // chat-20260417-1
  const base = slug(name);                          // "学日语" → "xue-ri-yu" 或保留中文
  return ensureUnique(base);                        // 冲突追加 -2, -3
}
```

**保留 ID**:`default`、以 `__` 开头的(系统保留)。

### 3.5 归组:消息进入哪个 Conversation

通道收到一条用户消息时,按优先级匹配:

```
1. 显式 conversationId(RPC / 工具参数携带)
        ↓ 未指定
2. Connection 的 active conversation(用户在该 connection 上 /switch 设置的)
        ↓ 未设置
3. 通道的 BindingPolicy(per-thread / per-group / always-default 等,见 §六)
        ↓ 未配置
4. default 对话
```

默认走"sticky"模式:一旦在某 connection 切到对话 X,后续输入持续进 X 直到再次切换。

### 3.6 主对话 vs 多对话(产品定位)

知行的对话能力有清晰的功能分层,**绝大多数用户只用主对话,多对话能力是为少数有分类需求的用户准备的可选项**。任何 UI / 文档 / 默认行为都必须遵循这个分层,不能把次要功能强推给主流用户。

| 层级 | 占比预估 | 形态 | 用户操作 |
|------|---------|------|---------|
| **P0 主对话(核心场景)** | 80% | default 这一个对话承接所有日常交互 | 启动 → 直接聊,什么都不用配 |
| **P1 多对话(可选)** | 15% | 用户主动分话题:"工作"、"学习"、"旅行计划" | `/new <name>`、`/switch`、`/list` |
| **P2 高级管理(进阶)** | 5% | 重命名、归档、删除、跨对话搜索 | `/rename`、`/archive`、`/delete`、未来的 `/search` |

**P0 主对话(默认对话)**:

- `id="default"` 永远存在,系统首次启动自动创建,不可删除
- 用户启动驭灵 App / 知行 CLI / 加钉钉机器人为好友——**第一次说话就是在主对话里**,不需要任何"创建/选择对话"步骤
- 所有跨通道 DM(驭灵 App + 钉钉私聊 + CLI 直接对话)默认归入 default,实现"它认识我"——用户在 App 上聊到一半,出门换钉钉继续聊,知行能接上
- 80% 用户从安装到卸载,全程只用 default,从不接触"对话"这个词——这是**故意设计**

**P1 多对话(可选)**:

- 当用户感觉"主对话里啥都聊有点乱"时(可能是几周或几个月后),才需要这层
- 用 `/new "学日语"` 创建 → 后续在该 connection 上的对话进入"学日语"
- 不同对话之间有独立的上下文——AI 在"学日语"里不会混入"工作对话"的细节
- **创建多对话不会影响默认对话的存在和使用**:用户随时 `/switch default` 回到主对话

**P2 高级管理(进阶)**:

- 用户对话足够多时(数十个)才需要的能力
- 包括重命名、归档(从默认列表隐藏但保留数据)、删除(移入回收站)、跨对话搜索
- UI 层应"隐式存在,显式触发"——不要在主流程里塞按钮,只在 `/list` 详情或专门的管理页面暴露

**默认行为不变量**:

- 启动时不弹"创建/选择对话"的对话框
- 主对话的存在不依赖任何用户配置
- 删除掉所有非 default 对话后,系统行为退化为单一主对话场景,**不能有任何残余 UI/逻辑**让用户感到"这里曾经有对话管理功能"

### 3.7 临时对话(Ephemeral Conversation)

场景评估器判定为 `lookup` 类型时（单轮问答，无后续上下文价值），Conversation 以**临时态**创建：纯内存、不写入磁盘、不出现在 `/list` 列表中。

**生效范围**：

| 运行形态 | 临时态是否生效 | 理由 |
|---------|-------------|------|
| **Server 模式** | ✅ 生效 | IM 通道会收到大量一次性查询（"今天天气"），逐条创建 transcript 是浪费 |
| **CLI `-p "query"` 单次模式** | ✅ 生效 | 管道式单次查询，无 REPL，不可能追问 |
| **CLI REPL 交互模式** | ❌ 跳过，始终持久化 | REPL 天然交互式，用户极可能追问；启动进程 = 表达了"正式对话"的意图 |

**自动升级为持久化 Conversation**——当以下任一条件满足时：

- 发生第二轮 Turn（用户追问了）
- Turn 中执行了有副作用的工具（文件写入、命令执行等）
- `scenario.escalate` 到非 lookup（AI 主动升级场景，见 context-architecture §10.2.3）
- 用户显式命令（`/name`、`/save`）

**与原则 5 的关系**：原则 5 说"Conversation 数据归用户所有，server 重启不丢"。临时对话尚未成为正式 Conversation——它是 Conversation 的"候选态"。升级后才受原则 5 保护。这不是例外,是渐进：所有 Conversation 都从临时态开始,绝大多数在第一次 Turn 完成前就已升级。

**实现**：

- 临时对话使用特殊 id 前缀 `__ephemeral-<ts>`（被 §3.4 的保留 ID 规则覆盖）
- SessionRuntime 正常工作,但 TranscriptStore 不写入
- 升级时将内存中的 messages 一次性 flush 到新的 transcript.jsonl,id 替换为正式 slug

---

## 四、Session 详解

### 4.1 字段定义

```typescript
interface SessionRuntime {
  readonly conversationId: string;     // 锚定的 Conversation
  readonly startedAt: string;
  lastTurnAt: string | null;           // 上次 Turn 完成时刻

  /** 完整内存消息(从 Transcript 加载 + 增量) */
  messages: Message[];

  /** 当前 Turn 是否在执行(并发锁) */
  busy: boolean;

  /** 上下文 token 预算追踪 */
  budget: ContextBudget;

  /** 当前 Turn 的 abort 控制 */
  abortController: AbortController | null;

  /** 持有此 Session 的活跃 Connection 集合(由通道层注册) */
  observers: Set<ConnectionId>;

  // 方法
  /**
   * 运行一轮 turn。AsyncGenerator 流式 yield 事件,最终 return `RunResult`
   * (含 `turn` / `compactBefore?` / `newMessages` + 诊断字段)——调用方据此走
   * 原子 commitTurn 落盘(见 §12.3 commitTurn 单一事实源)。
   */
  run(text: string, source: TurnSource): AsyncGenerator<AgentYield, RunResult>;
  /**
   * 用 canonical messages 覆盖内部 state。配合 TranscriptStore.commitTurn
   * 的返回值使用,保证内存与磁盘严格一致(单向数据流,见 §12.3)。
   */
  updateMessages(canonical: Message[]): void;
  abort(): void;
  dispose(): void;
}

type TurnSource =
  | { kind: "user"; channelId: string; connectionId: string }
  | { kind: "scheduler"; taskId: string }
  | { kind: "background-agent"; agentId: string };
```

### 4.2 生命周期

```
acquire(conversationId) ─────────────────────────────────┐
                                                         │
   已存在 SessionRuntime?                                 │
     是 → 增加 observer reference → 返回                   │
     否 ↓                                                 │
                                                         │
   loadTranscript(conversationId)                        │
     → 读 transcript.jsonl                               │
     → rebuild messages(应用 compact 边界)               │
                                                         │
   new SessionRuntime                                    │
     → ConversationManager.runtimes.set(id, rt)          │
     → 注册 observer                                     │
     → 返回                                              │
                                                         │
                  使用中(可执行 Turn)                    │
                                                         │
   release(conversationId, connectionId)                 │
     → observers.delete(connectionId)                    │
     → 触发释放评估(见 §4.3)                            │
                                                         │
   dispose()                                             │
     → 等待当前 Turn 完成(最多 5s 后强制 abort)         │
     → 从 runtimes 中移除                                │
     → messages / budget / provider 连接释放             │
     → Conversation 数据保留在磁盘                       │
                                                         ▼
            下次 acquire 触发重新加载
```

### 4.3 释放规则

**Session 释放的两个触发条件,任一满足即释放**:

```
A. 主动信号:observers 集合为空持续 60 秒
     ─ 通道收到 connection 断开时调用 release()
     ─ 60 秒宽限期防止短暂重连导致频繁加载
     ─ 适用所有通道:CLI 退出、Web 关标签、钉钉适配器主动注销等

B. idle 兜底:距上次 Turn 完成 ≥ 30 分钟
     ─ 即使有"幽灵 connection"未正确注销,也强制释放
     ─ 防止内存泄漏
```

**通道平权体现**:

- 任何通道都可以注册/注销 observer——这是通道接口的标准能力
- 钉钉适配器可以选择"首条消息时注册,2 小时无活动后注销"——和 CLI "进程退出时注销" 同等待遇
- 释放规则对所有通道一致,无特殊路径

**释放后再次访问**:任何通道再次需要这个 Conversation 时,自动重新加载(从磁盘读 transcript,重建 SessionRuntime)。用户体验差别:第一次响应慢几十毫秒,无其他差别。

### 4.4 复用约束

**关键不变式**:同一 Conversation 在任意时刻最多 1 个 SessionRuntime 实例。

后果:

- 多个通道、多个 connection 引用同一 Conversation 时,**共享同一 SessionRuntime**
- 任一来源(用户/任务/背景 agent)写入消息,立即对所有 observer 可见(通过 `conversation.message-appended` 事件广播)
- 同一 Conversation 不能并发执行两个 Turn(busy=true 时新请求排队或被拒)

### 4.5 并发控制

```typescript
const MAX_PENDING = 5;

async function send(conversationId: string, text: string, source: TurnSource, opts: { blocking: boolean }) {
  const rt = await convMgr.acquire(conversationId);
  if (rt.busy) {
    if (opts.blocking) {
      if (rt.pendingQueue.length >= MAX_PENDING) {
        return { accepted: false, reason: "queue-full" };
      }
      await waitForIdle(rt);
    } else {
      return { accepted: false, reason: "busy" };
    }
  }
  // 启动 rt.run(text, source);
}
```


| 来源                | busy 时默认行为                                         |
| ----------------- | -------------------------------------------------- |
| 用户消息(任意通道)        | 排队(blocking),用户感觉是"消息发出去了,等回复"                     |
| 定时任务              | 跳过本次,emit `scheduler:task-skipped-busy`,推迟到下次 tick |
| 背景 Agent 想 append | 等 idle 后异步写入                                       |


#### 排队策略

- **队列深度上限**：5 条。超出时返回 `{ accepted: false, reason: "queue-full" }`,通道向用户显示"当前忙碌,请稍后再试"
- **处理顺序**：FIFO,跨通道公平（先到先处理,不区分来源通道）
- **abort 联动**：用户 `/abort` 时,**同时清空该 Conversation 的排队消息**,避免 abort 完立即又跑下一条排队消息
- **多通道同时发送**：多个通道对同一 Conversation 发消息时,按到达顺序排队,不做合并

**不做消息合并**的理由：合并（如把 3 条排队消息拼成一条）看似优化,但破坏了"一条消息 = 一个 Turn"的不变式,且用户在不同消息中可能表达了不同意图。

---

## 五、Turn 详解

### 5.1 定义

**Turn = 一次完整的 agent loop**,从"接收一条用户/系统输入消息"开始,到"agent 完成响应(可能含多次工具调用)"结束。

```
Turn 开始
  │
  ▼
ContextEngine.prepareTurn()          ← 组装 messages[]（见 context-architecture §三）
  │
  ▼
agent loop iteration 1: LLM 调用
  │ → 模型决定调用工具 A
  ▼
工具 A 执行
  │
  ▼
agent loop iteration 2: LLM 调用(带工具结果)
  │ → 模型决定调用工具 B
  ▼
工具 B 执行
  │
  ▼
agent loop iteration 3: LLM 调用
  │ → 模型生成最终文本回复(无更多工具)
  ▼
Turn 结束 → append 到 Transcript → emit complete 事件
```

**Turn 不是 LLM 调用次数**——一个 Turn 内部可能调用多次 LLM。Turn 是"一次完整问答"的边界。

### 5.2 持久化时机

**Turn 完成时**(原子):

- 用户消息 + agent 最终消息 + 工具调用记录 + token usage 一并 append 到 transcript.jsonl
- 中途崩溃 → 整个 Turn 不写入(用户视角:刚才那条没回复,重发即可),不留半成品

详见 [session-persistence.md](./session-persistence.md) §5(Turn-complete 时追加策略,本文档继承不变)。

### 5.3 TurnId（Outbox 因果标签载体，v2.3 新增）

> 2026-04-21 引入。规格详见 [message-outbox.md](./message-outbox.md) §3.3 和 [ADR-007](../architecture/decisions/007-message-outbox.md)。

`turnIndex` 是 Turn 在 Conversation 内的**相对序号**，不足以做跨模块的引用（两个 Conversation 的 turnIndex=3 是同一个吗？当然不是）。为了让 Scheduler、DeliveryPipeline、Outbox 等组件能表达"这件事发生在某个 turn 内"的因果关系，引入**全局唯一的 TurnId**：

```typescript
type TurnId = string;  // 例如 `turn_01J...`（ulid 或类似）

interface Turn {
  readonly turnIndex: number;    // 既有：Conversation 内相对序号
  readonly turnId: TurnId;       // 新增：全局唯一标识
  // ...既有字段
}
```

**产生时机**：ConversationManager 在 turn 开始（`setBusy(true)` 之前）生成 turnId。该 turnId 贯穿：

1. **Agent Loop**：通过 `ToolExecutionContext.turnId` 透传给所有工具调用（参见 [ADR-004 工具系统](../architecture/decisions/004-tool-system-architecture.md)）
2. **Scheduler**：工具创建的定时任务在 `task.createdInTurn` 记录该 turnId
3. **Outbox**：turn 开始时 `outbox.openSlot({ slotId: turnId })`；turn 完成 `fillSlot` / 异常 `abandonSlot`
4. **Transcript**：持久化到 transcript.jsonl 的 Turn 记录中，用于事后审计跨组件因果链

**为什么不复用 turnIndex**：

- turnIndex 是 Conversation-local，不同 Conversation 的 turnIndex 会碰撞
- turnIndex 基于写入顺序，需要在 transcript 落盘前确定；turnId 在 turn 开始时即可确定（供工具使用）
- 全局 ID 更便于跨系统传递（日志、事件、遥测）

**turnId 不替代 turnIndex**：两者并存——turnIndex 对用户可见（"第 3 轮"），turnId 对系统可见（跨组件引用）。

---

## 六、通道层(Channel)

### 6.1 平权原则的实现

通道是 server 与外界的**唯一接口**。即使 CLI 也是通道——standalone CLI 内部跑了一个 in-process 的 server,CLI 进程就是这个 in-process server 的"CliChannel"。

不存在"绕过通道层直接访问 ConversationManager"的特权路径。

### 6.2 接口层次：ChannelAdapter + Connection

通道适配器的完整接口（`ChannelAdapter` + Capability Traits）定义在 [server-gateway.md](./server-gateway.md) §四,本文档不重复。下图展示两个文档各自贡献的概念及其关系：

```
ChannelAdapter (server-gateway.md §四)
  平台接入：connect / disconnect / send
  能力 traits：StreamableChannel / ApprovableChannel / ...
  ChannelContext：config / abortSignal / onMessage / registerHttpRoute
    │
    │  一个 adapter 管理 0~N 个 connection
    │
    ▼
Connection (本文档)
  客户端连接：绑定到 Conversation、注册为 SessionRuntime observer
  生命周期：随具体客户端上下线
```

**ChannelAdapter 是"平台级"**（一个钉钉适配器实例）。**Connection 是"连接级"**（一个 CLI 进程、一个 Web 标签页、一个 RPC 客户端）。ChannelAdapter 不感知 Conversation 概念——它只负责收发消息；Connection 才是消息归入 Conversation、驱动 SessionRuntime observer 的载体。

#### Connection 定义

```typescript
interface Connection {
  id: string;
  channelId: string;
  /** 当前 active conversation(可被 /switch 改变) */
  activeConversationId: string | null;
  /** 此 connection 是否对应"持久在线"(钉钉适配器 yes,CLI 进程 no) */
  persistent: boolean;
  /** 元信息(用户身份、来源等) */
  metadata: Record<string, unknown>;
}
```

#### ChannelContext 扩展

[server-gateway.md](./server-gateway.md) §4.1 定义了 `ChannelContext` 的基础能力（config / abortSignal / eventBus / logger / onMessage / registerHttpRoute）。本文档为其**追加** Connection 管理能力：

```typescript
interface ChannelContext {
  // ── server-gateway.md 已定义 ──
  config: ChannelConfig;
  abortSignal: AbortSignal;
  eventBus: IEventBus;
  logger: Logger;
  onMessage(msg: InboundMessage): void;
  registerHttpRoute(path: string, handler: HttpHandler): void;

  // ── 本文档新增：Connection 管理 ──

  /** 通道注册 connection（客户端上线） */
  registerConnection(conn: Connection): void;

  /** 通道注销 connection（客户端下线） */
  unregisterConnection(connectionId: string): void;

  /** 订阅 server 推送（消息追加、流式 delta、复杂事件） */
  subscribe(connectionId: string, handler: (event: ServerEvent) => void): Unsubscribe;
}
```

> **与 server-gateway.md 的关系**：server-gateway.md 定义了通道适配器"如何接入平台"；本文档定义了通道适配器"如何接入对话系统"。两者合并为完整的 ChannelContext。server-gateway.md 需同步更新以包含本文档新增的三个方法。

#### BindingPolicy

通道收到入站消息时,按 §3.5 规则归入 Conversation。每个通道可声明默认归组策略：

```typescript
interface ChannelBindingPolicy {
  dm: "per-user";
  group: "per-group" | "per-user-in-group";
  thread: "per-thread";
}
```

默认：DM = per-user, group = per-group, thread = per-thread。BindingPolicy 作为 ChannelAdapter 的可选属性,在 [server-gateway.md](./server-gateway.md) 的 ChannelAdapter 接口上追加。

### 6.3 Connection 注册与释放语义

`registerConnection` / `unregisterConnection` 是通道告诉 server 的两个信号：

- **注册**：此 connection 开始引用某个 Conversation,SessionRuntime 的 observer 计数 +1
- **注销**：此 connection 不再引用,observer -1,触发 §4.3 释放评估

不同通道实现这两个信号的时机不同：


| 通道     | register 时机      | unregister 时机     |
| ------ | ---------------- | ----------------- |
| CLI    | 启动时              | 进程退出 / Ctrl+D     |
| Web    | WebSocket 连接建立   | WebSocket 断开      |
| 驭灵 App | App 前台并连上 server | App 后台杀掉 / 长时间无心跳 |
| 钉钉     | 通道适配器启动时(常驻)     | 通道适配器停止时          |


钉钉的 connection 一般是"长 register",因为钉钉适配器随 server 启停,中间一直挂着。这不是特权——这是钉钉这种"中转通道"的自然语义,任何中转类通道(飞书/Telegram/...)都同样处理。

### 6.4 内置通道

S2.7 阶段实施这三个内置通道(其余在 S5+):


| 通道 ID   | 用途                                              | 状态               |
| ------- | ----------------------------------------------- | ---------------- |
| `cli`   | 标准 CLI(REPL 与 standalone)                       | S2.7 实现          |
| `rpc`   | 调试/远程客户端(zhixing rpc 命令)                        | S2.7 已存在(归并入通道层) |
| `inbox` | 用于 Scheduler / Background Agent 内部触发 Turn 的虚拟通道 | S2.7 实现          |


第三方通道(钉钉/飞书等)在 S5+ 实施,接口已锁定。

---

## 七、CLI 模式生命周期

CLI 有两种运行形态,生命周期略有不同:

### 7.1 形态 A:Standalone CLI(in-process)

不依赖独立的 zhixing serve 进程。CLI 进程内嵌 ConversationManager 和单一 CliChannel,数据写入本地磁盘。

```
T=0   用户运行 zhixing(在 ~/dev/projectA 目录)
       │
       ├─ 进程启动 → 创建 in-process ConversationManager
       │   作用域:user(任意目录运行同源)
       ├─ 创建 CliChannel(in-process channel)
       ├─ 加载或创建 Conversation
       │   - 自动恢复本项目最近活跃对话（convRepo.findLatest()）
       │   - 无历史对话 → 创建 default conversation
       │   - REPL 内通过 /new、/switch 管理对话，不依赖启动参数
       ├─ ConversationManager.acquire(convId) → 创建 SessionRuntime #1
       ├─ CliChannel.registerConnection({ id: "cli-pid-12345", ... })
       └─ REPL 启动,prompt 显示当前对话名

T=2s  用户输入 "你好"
       │
       ├─ Turn 1 开始 → SessionRuntime #1 跑 agent loop
       ├─ 流式 yield 到 CliChannel → 终端渲染
       ├─ Turn 1 结束 → append 到 transcript.jsonl
       └─ Session #1.lastTurnAt = now

T=10s 用户输入 "再说一遍"
       └─ 同一 SessionRuntime #1 跑 Turn 2(享受 prompt cache)

T=600s 用户 Ctrl+D 退出
       │
       ├─ CliChannel.unregisterConnection("cli-pid-12345")
       ├─ SessionRuntime #1 observers 清空 → 立即进入释放流程
       ├─ Session #1.dispose() → 等待无 Turn → 释放内存
       ├─ ConversationManager 关闭
       └─ 进程退出
       
       Conversation 数据持久保留在 ~/.zhixing/projects/<id>/conversations/<convId>/transcript.jsonl
```

### 7.2 形态 B:CLI as Client(连接外部 server)

CLI 作为客户端连接 zhixing serve 启动的 server,不内嵌 ConversationManager,所有操作走 RPC。

```
T=0   server 已运行(在用户级作用域)
       
T=1s  用户运行 zhixing(检测到 ~/.zhixing/server.pid → 进入 client 模式)
       │
       ├─ CLI 通过 RpcChannel 建 WebSocket 连 server
       ├─ server 端 RpcChannel.registerConnection({ id: "rpc-conn-abc", ... })
       ├─ CLI 调 conversation.list → 选择对话 / 创建新对话
       ├─ server 端 ConversationManager.acquire(convId) → SessionRuntime
       └─ CLI 进入 REPL

T=2s  用户输入 "你好"
       │
       ├─ CLI → RPC conversation.send → server
       ├─ server 端 SessionRuntime 跑 Turn 1
       ├─ 流式 conversation.delta 推回 CLI → 终端渲染
       └─ Turn 1 结束 → server 端 append 到 transcript

T=600s 用户 Ctrl+D 退出 CLI
       │
       ├─ WebSocket 断 → server 端 RpcChannel.unregisterConnection
       ├─ SessionRuntime 的 observers 减少
       │   - 还有其他 connection? 保留
       │   - 没有? 启动 60s 宽限期 → 期满释放
       └─ CLI 进程退出
       
       SessionRuntime 可能在 server 中继续存在(供其他通道访问)
       Conversation 数据在 ~/.zhixing/conversations/<convId>/transcript.jsonl
```

### 7.3 两种形态对比


| 维度                  | Standalone CLI                            | CLI as Client                 |
| ------------------- | ----------------------------------------- | ----------------------------- |
| ConversationManager | in-process                                | 在 server                      |
| 默认作用域               | project(cwd)                              | 跟随 server(默认 user)            |
| Conversation 数据位置   | `~/.zhixing/projects/<id>/conversations/` | `~/.zhixing/conversations/`   |
| Session 生命周期        | 与进程同生死                                    | 由 server 管理(idle/observer 规则) |
| 多客户端并存              | 不支持(单 CLI)                                | 支持(多 CLI/钉钉/Web 共享)           |
| 通道                  | CliChannel(in-process)                    | RpcChannel(WebSocket)         |
| 何时启用                | 默认(无 server 运行时)                          | 自动(检测到 server.pid)            |


**用户视角无差别**:一样的命令、一样的 prompt、一样的 conversation 列表(只是数据位置不同)。

---

## 八、Server 模式生命周期

```
T=0    用户运行 zhixing serve
        │
        ├─ Server 进程启动
        ├─ 加载持久化数据
        │   ├─ 扫描 ~/.zhixing/conversations/* → 不加载到内存,仅注册元信息
        │   └─ 确保 default conversation 存在(不存在则自动创建)
        ├─ 创建 ConversationManager(空 SessionRuntime 池)
        ├─ 启动内置通道
        │   ├─ RpcChannel(WebSocket on :18900)
        │   ├─ InboxChannel(供 Scheduler 用)
        │   └─ (S5+) DingtalkChannel / LarkChannel ...
        └─ 等待事件

T=10s  钉钉适配器收到一条消息(用户:"今天天气如何")
        │
        ├─ DingtalkChannel.ingest({ text: "...", from: "user-sunhj", ... })
        ├─ 通道决定归组(BindingPolicy.dm = always-default)
        │   → conversationId = "default"
        ├─ ConversationManager.acquire("default")
        │   → SessionRuntime 不存在 → 加载 transcript → 创建 SessionRuntime #1
        ├─ DingtalkChannel.registerConnection({ id: "dingtalk-ses-001", ... })
        │   (此 connection 标记 persistent=true,通道适配器持有)
        ├─ rt.run("今天天气如何", { kind: "user", channelId: "dingtalk", ... })
        ├─ Turn 完成 → append 到 transcript
        └─ DingtalkChannel.deliver(回复给用户)

T=15s  CLI client 启动
        │
        ├─ RpcChannel 接受 WebSocket 连接
        ├─ RpcChannel.registerConnection({ id: "rpc-conn-A", ... })
        ├─ CLI 默认 active conversation = default(或最近用过的)
        └─ 用户输入 "你刚才回复钉钉那边说啥"
            │
            ├─ ConversationManager.acquire("default")
            │   → SessionRuntime #1 已存在 → 复用!
            ├─ rt.run(...) → Turn 看到刚才钉钉的对话历史 → 答得准
            └─ 流式推回 CLI

T=20s  Web 客户端也连进来,订阅 default 对话
        │
        ├─ WebChannel.registerConnection({ id: "web-conn-X", ... })
        └─ 任何后续 message-appended 事件,
            CLI / Web / 钉钉 都通过自己的 channel 收到推送

T=900s CLI 用户 Ctrl+D 退出
        │
        └─ RpcChannel.unregisterConnection("rpc-conn-A")
            SessionRuntime #1 仍有 web-conn-X + dingtalk-ses-001 → 不释放

T=2700s Web 关标签 + 钉钉适配器无活动主动 unregister
        │
        ├─ SessionRuntime #1.observers 清空 → 启动 60s 宽限期
        ├─ 60s 内无新 connection → 真正释放
        ├─ Session #1.dispose() → 内存消失
        └─ Conversation "default" 在磁盘原封不动

T=3600s 钉钉来新消息
        │
        └─ DingtalkChannel.ingest(...) → ConversationManager.acquire("default")
            → SessionRuntime 不存在 → 重新加载 → 创建 SessionRuntime #2
            → 用户感知:第一条消息响应慢约 50ms(磁盘读),后续正常
```

**关键观察**:

- 没有任何"客户端类型"的 if-else——所有通道走同样的 register/unregister/ingest 接口
- SessionRuntime 在多通道间天然共享,一致性自动保证
- 释放规则唯一,对所有通道公平

---

## 九、Transcript 持久化

继承 [session-persistence.md](./session-persistence.md) 的 JSONL 设计(Header + Turn + Compact 三种行类型),仅做术语和路径更新。

### 9.1 文件路径

```
~/.zhixing/
├─ conversations/                              ← 用户作用域(server 默认)
│   ├─ default/
│   │   ├─ meta.json                           ← Conversation 元数据(name, archived, ...)
│   │   └─ transcript.jsonl                    ← 内容日志（header + [compact?] + post-compact turns）
│   └─ work/
│       ├─ meta.json
│       └─ transcript.jsonl
│
└─ trash/                                       ← 删除的对话(7 天后清理)
    └─ <convId>-<timestamp>/
```

> **不变量**：transcript.jsonl 始终满足 `header + [compact?] + post-compact turns` —— 至多 1 个 compact 行紧跟 header；compact 之前的 turns 在 `commitTurn({compactBefore})` 时被原子截断（非归档）。详见 §9.5 / ADR-CM-017。

### 9.2 JSONL 行格式(继承不变)

详见 [session-persistence.md](./session-persistence.md) §2.3。本文档仅修订:

- `SessionHeader.sessionId` → `TranscriptHeader.conversationId`
- 新增 `meta.json`(从 header 拆出可变字段:name、archived、preferredModel/Provider)

**职责边界**:

- `meta.json` — 可变元数据,由 ConversationRepository 读写(name、archived、lastActiveAt、scope 等)
- `transcript.jsonl` — 不可变内容日志,由 TranscriptStore 追加(Header + Turn + Compact 行)。Header 是不可变的创建快照(conversationId、model、provider、projectPath、createdAt),不含 name 等可变字段
- 推论:**name 只存 meta.json**。TranscriptStore 不提供 rename。list / delete / findLatest 等身份操作由 ConversationRepository 负责,TranscriptStore 不感知

### 9.3 上下文架构 → 见 [context-architecture.md](./context-architecture.md)

上下文管理的完整设计见 [context-management-v3-redesign.md](./context-management-v3-redesign.md)（2026-05-11 更新：原指向的 context-architecture.md v1.2 已废弃——Tier 多级压缩 / 场景参数化 / 动态驱逐 / recall_history / Pinning 均已从 `packages/` 砍除；新范式为 cache 第一优先 + 段式 SegmentManager + tools 满载稳定，Phase 1 已实施）。

核心要点（2026-05-11 更新后）：

- transcript.jsonl 严格 append-only
- 段内 messages append-only + tools[] / system byte-equal → cache 完美命中
- 触顶（attention 双档阈值）在 turn 边界整段切，走"缓存安全分叉"一次性 LLM 摘要
- 段切换复用 `CompactMarker`（扩展 `segmentId` / `structuredSummary` 选填字段）；段历史走 `Conversation.segmentMetadata`
- `recall_history` / `pinnedMessageIds` / Tier 压缩 / Turn 驱逐机制**已删除**，不再是当前路径

> **历史留存**：本节曾包含"三段窗口压缩方案"（长期摘要 + 中期摘要 + 近期原文），于 2026-04-17 被 [context-architecture.md](./context-architecture.md) 取代。撤销理由见 ADR-CM-011。完整原文存于 git 历史 `conversation-model.md@v2.0`。

### 9.4 作用域选择

| 启动方式                | 作用域                                                 |
| ------------------- | --------------------------------------------------- |
| `zhixing`(无 server) | user(默认)                                            |
| `zhixing serve`     | user(默认)                                            |
| `zhixing`(有 server) | 跟随 server                                           |
| 用户显式进入 workscene    | workscene(scoped 到该 workscene 子树,enter/exit 由用户拍板) |

cli / serve 入口都构造 `{ kind: "user" }` scope —— 知行任意目录运行效果一致,对话跟着用户走、不绑 cwd(对齐 [ADR-003](../architecture/decisions/003-config-system.md))。workscene 是用户显式创建的工作语境实体,与 cli/serve 入口选择独立,由 RuntimeSession 在 enter workmode 时构造 `{ kind: "workscene"; sceneId }` scope。

### 9.5 Compact 原子截断（commitTurn 单一入口）

#### 问题

`transcript.jsonl` 每轮 Turn 追加一行，无限膨胀场景下：

- 500 轮 ≈ 5-25MB，2000 轮 ≈ 20-100MB
- `load()` 每次全量读取，`rebuildCanonicalMessages()` 却只使用最后一个 compact 标记之后的 turns
- compact 之前的 turns 在文件里是**死重** —— 每次 load 都读但不用
- 根因还包括两个隐蔽 bug：server 路径从不写 compact marker；REPL compact 的 timestamp 晚于当轮 turn 导致 normalize 丢 turn

#### 设计：commitTurn 单一原子入口

用一个原子写入 API **替代** 老 `appendTurn` / `appendCompact` 的分步写入，同时根治"磁盘无限增长"+"server 不写 compact"+"timestamp 反序"三个问题。

**ITranscriptStore.commitTurn** —— 三种载荷形态：

```typescript
interface ITranscriptStore {
  /**
   * 原子提交 turn / compact / 两者。返回 canonical messages(供 caller 回喂 SessionRuntime.updateMessages,实现单一事实源)
   *
   * {turn}                       → append 新 turn (fs.appendFile,文件级原子)
   * {turn, compactBefore}        → 原子重写:按 turnsCompacted 切分现有 turns 保留末尾,
   *                                写 [header, compactBefore, ...retained, newTurn] (writeAtomic)
   * {compactBefore}              → 原子重写无新 turn(REPL /compact 手动命令)
   */
  commitTurn(
    conversationId: string,
    payload: { turn?: Turn; compactBefore?: CompactMarker },
  ): Promise<Message[]>;

  // 其余 init / load / countTurns / exists 不变
}
```

**keepCount 切分算法**：

```
retained_count = max(0, turns.length - compactBefore.turnsCompacted)
retained       = turns.slice(-retained_count)
new_content    = [header, compactBefore, ...retained, newTurn?]
```

`turnsCompacted` 是 `compact_end` 事件的精确字段 —— 本次 compact 事务替代的文件 Turn 数(见 [context-architecture.md](./context-architecture.md))。

**原子重写** —— `writeAtomic` 三步：

```
1. 写 tmp 文件 (<file>.{pid}-{ts}-{rand}.tmp)
2. rename(tmp, file) (POSIX 原子覆盖) / unlink old + rename (Windows fallback)
3. 崩溃留下 orphan tmp 由 cleanupOrphanTmp 在下次触碰文件时静默清理
```

**文件不变量**(ADR-CM-017 新版 / ADR-TR-1..TR-9)：

```
transcript.jsonl 永远满足:
  header
  [compact?]           ← 至多 1 个 compact 行,紧跟 header
  turn_0, turn_1, ...  ← post-compact turns,按提交顺序

compact 之前的 turns 不在文件中(被 commitTurn 的 keepCount 切分原子删除)
```

**演进对比**：

| 操作 | 老方案(append + 段轮转) | 新方案(commitTurn 原子截断) |
|------|------------------------|---------------------------|
| 磁盘老 turn 清理 | 段轮转到 archive/ | 原子 rewrite 直接删除 |
| 归档段 | `archive/segment-*.jsonl` | 不保留(ADR-TR-4/TR-9 archiveOnCompact=false) |
| compact 写入 | `appendCompact` + 段轮转 | `commitTurn({compactBefore})` 一次原子重写 |
| server 持久化 | `persistTurn(turn)` + `persistCompact` 分步 | `commitTurn({turn, compactBefore?})` 原子 |
| 并发保护 | 无 | **per-id 串行锁**(ADR-TR-8) |

**lazy normalize 老文件**(ADR-TR-5)：遇到多 compact 或 timestamp 反序的老格式文件时,首次 load 同步归一化重写为新不变量形态,归一化后返回给调用方的 `LoadedTranscript` 和磁盘一致。

**单向数据流**(ADR-TR-7)：

```
run-agent 闭包订阅 compact_end → 组装 CompactMarker (accumulator L1)
  ↓
RunResult { turn, compactBefore? }
  ↓
ConversationManager.recordTurn → TranscriptStore.commitTurn
  ↓
canonical Message[] 返回 → session.runtime.updateMessages(canonical)
  ↓
adapter.messages 与磁盘严格一致
```

#### 接口影响

`ITranscriptStore` 接口重塑(向后兼容保留薄别名)：

- `commitTurn(id, payload)` — 新增,唯一原子写入入口
- `appendTurn(id, turn)` — 委托给 `commitTurn({turn})`,保留作 legacy 薄别名
- `appendCompact(id, compact)` — 委托给 `commitTurn({compactBefore})`,保留
- `load()` / `countTurns()` / `exists()` — 不变；load 内部走 lazy normalize

`SessionRuntime` 扩展：

- `run()` return 类型 `AgentResult` → `RunResult` (见 §4.1)
- 新增 `updateMessages(canonical)` — caller 拿 commitTurn 返回值回喂

`ConversationManager.recordTurn(id, turn, compactBefore?)` 签名扩展：

- ephemeral 分支:按 turnsCompacted 切 pendingTurns,覆盖 pendingCompact
- persistent 分支:调 `commitTurn` 回调 → 拿 canonical → `runtime.updateMessages(canonical)`

#### 崩溃安全

| 崩溃时机 | 磁盘状态 | 恢复策略 |
|---------|---------|---------|
| writeAtomic 写 tmp 后崩溃 | 原文件不变,tmp 留存 | 下次触碰文件时 `cleanupOrphanTmp` 静默删除 |
| POSIX rename 期间崩溃 | 原子语义保证:旧或新,不可能半 | 无需恢复 |
| Windows unlink → rename 之间崩溃 | 文件短暂不存在 | 重启后文件仍缺,需用户重建(罕见,概率 < 1ppm) |
| append fs.appendFile 崩溃 | 最多丢最后一行(JSONL 行级独立) | load 跳过损坏行 |

---

## 十、与 Scheduler / Background Agent 集成

### 10.1 Scheduler:可选 conversationId

```typescript
type TaskAction =
  | {
      kind: "agent-turn";
      prompt: string;
      model?: string;
      tools?: string[];
      /**
       * 任务执行的"对话归宿":
       * - undefined:临时 SessionRuntime,执行后立即销毁,不写入任何 Transcript
       * - "default" / "<id>":在指定 Conversation 上执行,prompt 与回复会出现在用户对话历史中
       */
      conversationId?: string;
    }
  | { kind: "system"; handler: string; params?: Record<string, unknown> };
```

**默认 undefined** 的理由:

- 高频任务(如 health-check)不污染用户对话历史
- 显式指定才"汇入对话",符合用户预期

### 10.2 任务执行流程

```
Scheduler tick → due task
     │
     ├─ task.action.conversationId == null?
     │     是 → 创建临时 SessionRuntime → 执行 → 销毁
     │     否 ↓
     │
     ├─ ConversationManager.acquire(convId)
     │     → 复用或加载
     │
     ├─ rt.busy?
     │     是 → emit "scheduler:task-skipped-busy" → 推迟到下次 tick
     │     否 ↓
     │
     └─ rt.run(prompt, { kind: "scheduler", taskId })
          → Turn 完成 → append 到 transcript
          (消息 metadata 标记 source=scheduler)
```

任务消息在 transcript 中带 `metadata.source = "scheduler"`,UI 可据此区分渲染。

### 10.3 Background Agent

`spawnBackground` 默认创建独立临时 SessionRuntime,fire-and-forget,不绑定任何 Conversation。

```typescript
interface BackgroundSpawnOptions {
  prompt: string;
  /** 可选:完成后把执行追加到指定 Conversation */
  appendToConversationId?: string;
  /** 可选:完成时通知到指定 Conversation */
  notifyConversationId?: string;
}
```

安全策略:背景 agent 的 SessionRuntime 不 attach 渲染器,工具确认走 `NonInteractiveResolver`(详见 [persistent-service.md](./persistent-service.md) ADR-022)。

---

## 十一、用户体验

### 11.1 默认行为

- 首次启动 zhixing → 自动有 default 对话 → 直接开聊
- 永远不需要主动 `/new` 也能用
- prompt 里显示当前对话名,如 `default ▸`  或 `work ▸` 

### 11.2 命令清单


| 命令                     | 用途              | 备注                                              |
| ---------------------- | --------------- | ----------------------------------------------- |
| `/switch <id-or-name>` | 列出对话 + 切换到已有对话  | CLI 统一入口: typeahead async-enum 参数补全展示对话列表; 无参时显示编号列表; 支持 ID 精确匹配和名称模糊匹配 |
| `/new <name>`          | 创建新对话并切换        | 创建新 conversation（新 ID + 新 meta + 新 transcript），不影响原对话      |
| `/rename <new-name>`   | 重命名当前对话         |                                                 |
| `/archive [id]`        | 归档(默认归档当前)      |                                                 |
| `/delete <id>`         | 删除(不可删 default) | 移入回收站                                           |
| `/history [n]`         | 查看当前对话最近 n 轮    |                                                 |
| `/clear`               | 清空当前对话历史         | `compactAll` 原子重写 transcript：保留 conversationId + meta + 写一条 compact marker（placeholder summary），老 turns 不可恢复。与自动 compact / `/compact` 共享 `commitTurn(compactBefore)` 路径。需保留原对话历史用 `/new` 创建新对话 |
| `/list`                | `/switch` 无参别名   | hidden; alias: `/conversations`,`/sessions`(deprecated) |

**CLI UX 合并决策（S3.C 实施）：**

在 CLI 模式下,"列出对话"和"切换对话"是同一个用户意图的连续动作——用户看列表几乎必然是为了选一个。因此 `/switch` 同时承担列表和切换功能:
- **typeahead 模式**: 用户选中 `/switch` 后,ArgumentProvider 的 async-enum 自动展示对话列表作为参数候选,用户箭头选择后直接切换
- **legacy 模式 / 手动输入**: `/switch <text>` 按名称模糊匹配;`/switch`（无参）显示编号列表 + 提示
- `/list` / `/conversations` / `/sessions` 保留为 hidden 别名,不出现在 typeahead 菜单
- Server 模式未来可使用独立的 UI 控件（下拉框/弹窗）,核心查询逻辑在 `ConversationRepository` 层复用

**`/delete` 延迟实施决策（随 S3.8 Ephemeral 一起落地）：**

`/delete` 是破坏性操作，设计需要在对话生命周期模型（Ephemeral / Promoted / Archived）确定后才能做对。过早实现会导致：
- 用户误删不可恢复（当前无回收站机制）
- Ephemeral 对话天然自动清理，大部分"想删的对话"不会持久化到磁盘
- 归档（`/archive`）和删除的边界不清晰

**实施时机：** Step 8（Ephemeral + auto-promote）完成后，对话分为 ephemeral / persistent / archived 三态，此时 `/delete` 的语义明确：仅作用于 persistent 和 archived 对话。

**交互设计要点：**
- 复用 `/switch` 的 `ConversationArgProvider`（async-enum 参数补全选择目标对话）
- 二次确认：`⚠ 确认删除对话「xxx」？此操作不可恢复。(y/N)`，默认 N
- 不可删 default 对话
- 删除当前对话后自动 fallback：`convRepo.findLatest()` → 有则切换，无则创建 default
- 实现方式：删除整个 `conversations/{id}/` 目录（meta.json + transcript.jsonl）
- 未来可考虑软删除（移入回收站目录，TTL 后真删），但 MVP 先做硬删除 + 确认

**`/new` vs `/clear` 语义边界**:

- `/new <name>` = 创建新 conversation（新 ID + 新 meta + 新 transcript），原对话保留在磁盘
- `/clear` = 当前 conversation 内压缩（同 ID + 同 meta），通过 compactAll 原子重写 transcript 为 `header + [marker]`，老 turns 不可恢复
- 选择依据：要保留原对话历史用 `/new`；要在当前对话内"清空重来"用 `/clear`

### 11.3 跨设备一致性

Server 模式下 ConversationManager 是单例。所有客户端(多个 CLI、Web、钉钉)看到的 Conversation 列表、消息历史完全一致。

`/switch` 是 connection-level 的——一个 CLI `/switch work` 不影响另一个 CLI 当前在 default。但他们看到的"对话列表"和"对话内容"是一致的。

---

## 十二、API 设计

### 12.1 核心组件：Repository + TranscriptStore + Manager

> **v2.1 拆分**：原 ConversationManager 拆为 ConversationRepository（core 包,磁盘 CRUD）+ ConversationManager（server 包,运行时生命周期）。见 ADR-CM-015。
>
> **v2.2 职责边界**：明确 ConversationRepository（身份 — meta.json）与 TranscriptStore（内容 — transcript.jsonl）的单一职责切割。TranscriptStore 是 append-only 日志系统,不做 CRUD 查询。见 ADR-CM-012、ADR-CM-015。

```typescript
/** core 包：Conversation 身份的磁盘 CRUD (meta.json) */
interface ConversationRepository {
  list(opts?: { includeArchived?: boolean }): Promise<Conversation[]>;
  get(id: string): Promise<Conversation | null>;
  create(opts: { name?: string; preferredModel?: string; scope?: ConversationScope }): Promise<Conversation>;
  rename(id: string, name: string): Promise<Conversation>;
  archive(id: string, archived: boolean): Promise<Conversation>;
  delete(id: string): Promise<void>;
  ensureDefault(): Promise<Conversation>;
  findLatest(): Promise<string | null>;      // list()[0].id — REPL 启动时自动恢复用
  touch(id: string): Promise<void>;          // 更新 lastActiveAt — Turn 完成后调用
}

/** core 包：Transcript 内容的原子日志 (transcript.jsonl) */
interface TranscriptStore {
  init(conversationId: string, opts: { model: string; provider: string }): Promise<void>;

  /**
   * 唯一原子写入入口,返回 canonical messages(供 ConversationManager 回喂 SessionRuntime.updateMessages)。
   * - {turn}                 → append 新 turn(fs.appendFile 文件级原子)
   * - {turn, compactBefore}  → 原子重写:按 turnsCompacted 切分保留末尾,加新 turn
   * - {compactBefore}        → 原子重写:按 turnsCompacted 切分,不加 turn(REPL /compact)
   * 同 conversationId 的调用 per-id 串行(ADR-TR-8)。
   */
  commitTurn(
    conversationId: string,
    payload: { turn?: Turn; compactBefore?: CompactMarker },
  ): Promise<Message[]>;

  /** legacy 薄别名:委托给 commitTurn({turn}) */
  appendTurn(conversationId: string, turn: Turn): Promise<void>;
  /** legacy 薄别名:委托给 commitTurn({compactBefore}),返回 canonical */
  appendCompact(conversationId: string, compact: CompactMarker): Promise<Message[]>;

  load(conversationId: string): Promise<LoadedTranscript>;   // 首次加载老文件时 lazy normalize(ADR-TR-5)
  countTurns(conversationId: string): Promise<number>;
  exists(conversationId: string): Promise<boolean>;
  // 注意：没有 list / rename / delete / findLatest — 这些是身份操作,属于 ConversationRepository
}

/** server 包：运行时生命周期管理,依赖 Repository + TranscriptStore */
interface ConversationManager {
  readonly repo: ConversationRepository;
  readonly transcripts: TranscriptStore;

  acquire(id: string): Promise<SessionRuntime>;          // 复用或加载
  release(id: string, connectionId: string): void;       // observer -1
  history(id: string, opts?: { limit?: number; before?: number }): Promise<Message[]>;  // 委托 TranscriptStore.load()

  on(event: ConversationEvent, handler: Handler): Unsubscribe;
}
```

**调用方协调模式**:

- Standalone CLI（无 ConversationManager）直接协调 Repository + TranscriptStore
- Server 模式通过 ConversationManager 统一入口,CLI as Client 走 RPC

```
创建:   repo.create()  → store.init(conversation.id, {model, provider})
恢复:   repo.findLatest() → store.load(id)
Turn:   store.appendTurn() + repo.touch()
重命名: repo.rename()  （不碰 transcript — name 只在 meta.json）
删除:   repo.delete()  （trash 整个目录,包含 transcript.jsonl）
```

### 12.2 Server RPC


| 方法                       | 鉴权  | 参数                                          | 返回                                    |
| ------------------------ | --- | ------------------------------------------- | ------------------------------------- |
| `conversation.list`      | ✅   | `{ includeArchived?: boolean }`             | `Conversation[]`                      |
| `conversation.create`    | ✅   | `{ name: string; preferredModel?: string }` | `Conversation`                        |
| `conversation.send`      | ✅   | `{ conversationId?: string; text: string }` | `{ conversationId; runId; accepted }` ¹ |
| `conversation.history`   | ✅   | `{ conversationId; limit?; before? }`       | `Message[]`                           |
| `conversation.abort`     | ✅   | `{ conversationId }`                        | `{ aborted: boolean }`                |
| `conversation.rename`    | ✅   | `{ conversationId; name }`                  | `Conversation`                        |
| `conversation.archive`   | ✅   | `{ conversationId; archived: boolean }`     | `Conversation`                        |
| `conversation.delete`    | ✅   | `{ conversationId }`                        | `{ deleted: boolean }`                |
| `conversation.subscribe` | ✅   | `{ conversationId? }`                       | (notifications)                       |

> ¹ `runId` 是本次 Turn 执行的唯一标识（UUID），客户端用它将后续 `conversation.delta` / `conversation.complete` 推送事件关联回触发请求。`accepted=false` 时 `runId` 为 null（排队满或被拒）。

**推送事件**:

- `conversation.message-appended` — 任意来源写入消息时,广播给订阅者
- `conversation.delta` — 流式 token(仅推给当前 Turn 发起者)
- `conversation.complete` — 一轮完成
- `conversation.created` / `archived` / `deleted` / `renamed`

**向后兼容**:S2.7 期间保留 `session.`* 作为 `conversation.*` 的别名(打 deprecation warning),S2.8 移除。

### 12.3 内置工具(AI 可调)

```typescript
interface ConversationToolInput {
  action: "list" | "create" | "switch" | "summary";
  name?: string;                    // create
  conversationId?: string;          // switch
  recentTurns?: number;             // summary
}
```

使用场景:

- 用户:"开个新对话聊运动健身" → AI 调 `conversation.create` + `switch`
- 用户:"我们前几天聊过啥" → AI 调 `conversation.summary` 看摘要后回答

### 12.4 CLI 启动行为

```bash
zhixing                                # REPL：自动恢复最近对话（无历史则创建 default）
zhixing -p "问题"                       # 单次模式：执行后退出（ephemeral，Step 8）
zhixing rpc conversation.send --conversationId=work --text="..."
```

> **设计决策（ADR-CM-016）：** 移除 `-c`/`-r`/`-k` 启动参数。
> REPL 默认自动恢复最近对话，对话切换通过 REPL 内 `/switch` 完成。
> 自动化场景走 Server RPC，不通过 CLI 启动参数路由。
> 迁移计划：Step 8 清除遗留 `-c`/`-r` 代码。

---

## 十三、渐进实现路线

每个阶段独立可验证,前后依赖明确。

### Phase S2.7:概念校准 + Server 持久化

**前置依赖**:S2(已完成)

**目标**:统一 Conversation/Session/Turn 三层概念;Server 端 SessionRegistry 替换为持久化的 ConversationManager;Scheduler 接入 conversationId;数据迁移完成。

**做什么**:

> **v2.1 修订要点**：
> - 新增 Step 0（文档对齐）,确保 conversation-model 与 server-gateway 接口不冲突
> - core 包新增 `ConversationRepository`（纯磁盘 CRUD）,server 包的 `ConversationManager` 依赖它（解决 standalone CLI 的包依赖问题）
> - 原 Step 9（conversation 内置工具）推迟到 S2.8（降低 S2.7 范围,工具的安全策略需独立讨论）
> - 工时修正为 18-24 小时


| Step | 内容 | 文件 | 验证 |
| ---- | --- | --- | --- |
| 0 | **文档对齐**：更新 server-gateway.md 的 ChannelContext（新增 registerConnection / unregisterConnection / subscribe）；更新 RPC 方法名 `session.*` → `conversation.*`（保留别名）；更新 ChannelAdapter 追加 bindingPolicy 可选属性 | `server-gateway.md` | 两文档的 ChannelContext 定义一致 |
| 1 | 新增 `Conversation` / `ConversationScope` / `Connection` 类型 | `packages/core/src/conversation/types.ts` | `pnpm test` 类型检查通过 |
| 2 | 重命名 `SessionStore` → `TranscriptStore`（机械 rename + JSONL header 字段 sessionId → conversationId,兼容读旧格式） | `packages/core/src/conversation/transcript-store.ts` | 单测 + 旧 jsonl 文件能读 |
| 3 | 新增 `meta.json` 拆分（从 header 拆出 archived / preferredModel） | `packages/core/src/conversation/meta-store.ts` | 单测 |
| 4 | 实现 `ConversationRepository`（纯磁盘 CRUD：list / get / create / rename / archive / delete / ensureDefault），**放在 core 包**,不涉及 SessionRuntime 或 observer | `packages/core/src/conversation/repository.ts` | 单测：CRUD 操作 + ensureDefault |
| 5 | 实现 `SessionRuntime`（替换 ServerSession,持久化加载 + observer set + busy 锁 + pendingQueue + 释放规则） | `packages/server/src/conversation/runtime.ts` | 单测：idle 30 分钟释放、observer 0 + 60s 释放、队列深度 5 |
| 6 | 实现 `ConversationManager`（acquire / release / observer 管理）。依赖 core 的 `ConversationRepository` 做持久化,自身只管运行时生命周期 | `packages/server/src/conversation/manager.ts` | 单测 + 多 connection 共享同一 SessionRuntime |
| 7 | RPC 方法 `conversation.*` 实现 + `session.*` 兼容别名 | `packages/server/src/rpc/methods/conversation.ts` | E2E：通过 `zhixing rpc conversation.list` 等命令验证 |
| 8 | Scheduler `TaskAction.conversationId` 支持（类型 + serve/command.ts 接入） | `packages/core/src/scheduler/types.ts`、`packages/cli/src/serve/command.ts` | E2E：创建带 conversationId 的任务,执行后 transcript 多一轮 |
| 9 | REPL prompt 显示当前对话名 + `/new <name>` 真实创建对话 + `/switch` / `/rename` / `/archive` / `/delete` / `/history` 命令 | `packages/cli/src/repl.ts` 与 `packages/cli/src/conversation/commands.ts` | E2E：逐条命令验证 |
| 10 | 数据迁移命令 `zhixing migrate-conversations` (--dry-run / --apply) | `packages/cli/src/migrate/conversations.ts` | dry-run 显示计划,apply 后旧数据备份到 `~/.zhixing/.backup/<ts>/` |
| 11 | Standalone CLI 模式适配：CLI 直接使用 core 的 `ConversationRepository` + 轻量 `CliSessionRuntime`（无 observer 管理——单进程单连接,进程死了 runtime 就没了） | `packages/cli/src/repl.ts` 与 `packages/cli/src/conversation/cli-runtime.ts` | 旧 REPL 行为完全保留 |


> **Step 4 与 Step 6 的分工**：ConversationRepository（core）处理"磁盘上有哪些对话、如何读写"，ConversationManager（server）处理"内存中哪些对话正在运行、谁在观察它们"。Standalone CLI 只用 ConversationRepository + 轻量 runtime,不依赖 server 包。

**验证清单**（每条都是端到端可执行）:

- 首次启动 `zhixing serve` → `~/.zhixing/conversations/default/` 自动创建,meta.json + transcript.jsonl 存在
- `zhixing rpc conversation.list` → 返回 `[{ id: "default", isDefault: true, ... }]`
- `zhixing rpc conversation.send --text="hi"` → 写入 default,推 delta + complete
- `zhixing rpc conversation.send --conversationId=default --text="再问"` → 同一 SessionRuntime,messages 含上一轮
- `zhixing rpc conversation.create --name="工作"` → 返回 `{ id: "gong-zuo", ... }`,文件创建
- 两个 `zhixing rpc --watch` + 一个 `conversation.send` → 两个 watcher 都收到 `message-appended`
- `zhixing rpc conversation.history --conversationId=default --limit=10` → 返回最近 10 轮
- Server 重启 → `conversation.list` 仍返回所有对话,history 完整
- 创建定时任务 agent-turn 不带 conversationId → 执行不污染任何 transcript
- 创建定时任务 agent-turn 带 `conversationId="default"` → default 多一轮,metadata.source=scheduler
- 任务 conversationId 指向的对话 busy → emit `scheduler:task-skipped-busy`,推迟到下次 tick
- busy 时发送超过 5 条消息 → 第 6 条返回 `queue-full`；`/abort` 后队列清空
- REPL `/list` → 看到所有对话; `/new "test"` → prompt 变 `test ▸`; `/switch default` → 切回; 历史保留
- REPL Standalone:`/dev/A` 与 `/dev/B` 启动看到同一坨用户级对话(任意目录运行同源)
- REPL Client(连 server)模式:看到 server 的用户级对话
- 进入 workscene 后 `/list` 只显示该 workscene 子树的对话;退出后回 main 看到用户级对话
- 旧 RPC `session.send` 仍可用,日志输出 deprecation warning
- Session idle 30 分钟 → 释放,内存回收;再次访问自动重载

**交付物**:

```
packages/core/src/conversation/
  ├─ types.ts                    # Conversation, ConversationScope, Connection 接口
  ├─ repository.ts               # ConversationRepository（纯磁盘 CRUD）
  ├─ transcript-store.ts          # 重命名自 session/store.ts
  ├─ transcript-serializer.ts     # 重命名自 session/serializer.ts
  ├─ meta-store.ts               # meta.json 读写
  ├─ id-generator.ts             # generateConversationId
  └─ index.ts

packages/server/src/conversation/
  ├─ manager.ts                  # ConversationManager（acquire/release/observer）
  ├─ runtime.ts                  # SessionRuntime（messages + busy + pendingQueue）
  ├─ release-policy.ts           # 释放规则（observer + idle）
  └─ default-conversation.ts     # ensureDefault（调 core repository）

packages/server/src/rpc/methods/
  └─ conversation.ts             # 新 RPC + session.* 别名

packages/cli/src/conversation/
  ├─ commands.ts                 # /list /new /switch /rename /archive /delete /history
  ├─ cli-runtime.ts              # 轻量 CliSessionRuntime（standalone 用,无 observer）
  └─ prompt.ts                   # prompt 显示对话名

packages/cli/src/migrate/
  └─ conversations.ts            # zhixing migrate-conversations
```

**预估工作量**：18-24 小时（含测试 + 迁移 + REPL 集成 + 文档同步）

> **与 v2.0 的差异**：
> - conversation 内置工具（AI 可调）推迟到 S2.8,降低 S2.7 范围
> - ConversationRepository 从 ConversationManager 中拆出到 core 包,Standalone CLI 不再依赖 server 包
> - CliChannel 推迟到 S2.8 通道层阶段统一实现；S2.7 用 `CliSessionRuntime` 过渡
> - 新增 ambient scope 验证项（非项目目录自动 user 作用域）
> - 新增队列深度验证项

---

### Phase S2.8：通道层抽象 + conversation 工具

**前置依赖**：S2.7

**目标**：把现有"CLI / RPC client / Scheduler 触发"统一抽象为 Channel 接口实现,Session 释放规则真正基于通道注册的 observer 工作。同时落地从 S2.7 推迟的 conversation 内置工具。

**做什么**：


| Step | 内容 | 验证 |
| ---- | --- | --- |
| 1 | 实现完整 `ChannelContext`（合并 server-gateway.md 基础 + 本文档 Connection 扩展） | 类型导出,接口与两个文档一致 |
| 2 | 实现内置 `RpcChannel`（WebSocket,从现有 rpc 代码抽取） | 现有 `zhixing rpc` 行为完全保留 |
| 3 | 实现内置 `CliChannel`（in-process,替换 S2.7 的 CliSessionRuntime） | standalone REPL 行为完全保留 |
| 4 | 实现内置 `InboxChannel`（虚拟通道,Scheduler / Background Agent 触发 Turn 走这条） | 任务执行的 source 字段正确 |
| 5 | `ConversationManager` 改造：observer 注册/注销由通道驱动,释放规则采用 §4.3 双触发 | 单测：observer 0 + 60s → 释放；idle 30min → 释放 |
| 6 | `ChannelRegistry`（server 启动时注册所有内置通道） | 单测 |
| 7 | 移除任何"CLI 特殊路径"代码（in-process 调用 ConversationManager 必须走 CliChannel） | grep 检查无 if (channel === "cli") |
| 8 | `conversation` 内置工具 + 系统提示注入（从 S2.7 推迟） | E2E：对话中说"开个新对话",AI 调用工具 |


**验证清单**：

- CLI client 连 → registerConnection 触发,SessionRuntime observer +1
- CLI client 断开 → unregisterConnection 触发,observer -1
- 唯一 connection 断开 → 60s 后 SessionRuntime 释放
- 60s 内重新连上 → 复用同一 SessionRuntime（无重载）
- 只有 InboxChannel 触发的 Turn（纯定时任务）→ 执行后 30 分钟 idle → 释放
- grep `packages/server/src` 无 `if.*kind.*===.*"cli"` 等通道判别分支
- 对话中说"帮我开个新对话叫学日语"→ AI 调用 conversation 工具 → 新对话创建

**预估工作量**：8-12 小时

---

### Phase S5+:第三方通道适配器

**前置依赖**:S2.8(通道接口稳定)

**目标**:接入钉钉、飞书等第三方通道。**S2.8 阶段已锁定接口**,S5+ 仅按接口实现 channel 包,无需修改核心。

**做什么**(每个通道独立可发):


| 包                           | 内容                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `@zhixing/channel-dingtalk` | DingtalkChannel:dingtalk-stream SDK + ApprovableChannel 接口 + per-user-dm BindingPolicy |
| `@zhixing/channel-lark`     | LarkChannel:飞书 SDK + 类似                                                                |
| `@zhixing/channel-web`      | WebChannel:HTTP SSE / WebSocket,带最小 Web UI                                             |


**核心约束**:实现这些包**不允许修改 server 核心代码**——任何 "需要在 ConversationManager 加分支才能跑通" 的需求都说明 S2.8 接口设计有问题,要回头改接口。

---

## 十四、决策记录 (ADRs)

### ADR-CM-001:三层概念分离

**决策**:Conversation / SessionRuntime / Turn 三层在文档与代码层面强制分离,术语不再裸用 "session"。

**理由**:三个概念有不同的生命周期(月年 / 分钟小时 / 秒)和不同的可见性(用户 / 系统 / agent)。合并必然导致语义泄漏与跨模块误解。

---

### ADR-CM-002:必须有"默认对话"

**决策**:`id="default"` 的 Conversation 系统启动时自动创建,不可删除。

**理由**:零配置体验是个人助手的产品护城河。新用户从不需要理解对话概念也能用;default 同时充当跨通道 DM 的统一归宿,实现"它认识我"的体验。

---

### ADR-CM-003:cli / serve 统一 user 作用域

**决策**:cli / serve 入口都构造 `{ kind: "user" }` scope。不按 cwd 自动隔离对话。

**理由**:知行核心产品哲学是"任意目录运行效果一致、对话跟着人走"(对齐 [ADR-003](../architecture/decisions/003-config-system.md) workspace 是用户级偏好)。"project" 在产品中不对应任何用户可感知抽象 —— 按 cwd 算 hash 自动隔离对话是 IDE 工具思路(VSCode workspace 那种),与个人助手定位逆向。workscene 是用户显式创建的工作语境,与 cwd 自动隔离机制独立;接入第三方通道的 server 同样在 user scope 下工作,无需"项目级"再分层。

---

### ADR-CM-004:conversationId 用 slug 而非 UUID

**决策**:人类可读的 slug(`default` / `work` / `trip-2026`),自动 fallback 用 `chat-<日期>-<序号>`。

**理由**:用户 `/switch trip-2026` 比 `/switch 550e8400-...` 自然百倍;在多通道指令、日志、文件路径里都可读;碰撞处理简单。

---

### ADR-CM-005:不实现对话 fork / 分支

**决策**:永不实现 Conversation 的分叉结构。换话题 = `/new`,不需要 fork 语义。

**理由**:个人助手的对话不是代码版本;fork 引入 DAG 复杂度与每行 uuid/parentUuid 的存储冗余,Claude Code 的 fork-session 实测使用率极低。

---

### ADR-CM-006:Scheduler 任务的 conversationId 默认 undefined

**决策**:`TaskAction.conversationId` 默认 `undefined`(临时一次性 SessionRuntime,不写入任何 Transcript)。

**理由**:高频任务(健康检查 / 定时投递)若默认写入对话会污染历史;用户显式想要"任务汇入对话"才指定。修订 [persistent-service.md ADR-017](./persistent-service.md#adr-017) 的 sessionId 语义。

---

### ADR-CM-007:通道平权(Channel Parity)

**决策**:所有客户端形态(知行 CLI / 驭灵 App / 驭灵 Web / 钉钉 / 飞书 / RPC client)在 server 视角下完全平级,通过统一的 Channel 接口接入。无内置通道特权,无"亲儿子专享"协议。

**理由**:

- 第三方扩展无暗规则,接口对所有实现者一致
- server 内部无 if-else 分支处理"是不是亲儿子"
- 不锁定用户对客户端的选择
- 知行的护城河是 agent 智能,不是"自家 App 体验更好"
- 在 OpenClaw / Hermes 都让 CLI 享有特权(in-process 直调核心),后续加通道时各种特殊处理——我们一次性避免这个陷阱

---

### ADR-CM-008:Session 释放采用"observer + idle"双触发

**决策**:Session 释放条件:`observers 集合空持续 60 秒` 或 `距上次 Turn ≥ 30 分钟`,任一满足即释放。规则对所有通道一致。

**理由**:

- observer 触发对应"用户主动离开"的明确语义,内存回收及时
- idle 兜底防止幽灵 connection 导致内存泄漏
- 60 秒宽限期避免短暂重连导致频繁加载
- 不区分通道类型,符合通道平权

---

### ADR-CM-009:`/new` 命令语义迁移

**决策**:`/new` 语义从早期"清空当前历史(等同 /clear)"重新分配为"创建新 conversation"——与 `/clear` 完全分离。

**理由**:`/new` 字面含义最匹配"创建新对话";"清空当前对话"语义由 `/clear` 通过 `compactAll`（原子重写当前 transcript）完整承担。两命令职责互补:
- `/new`:换一个新 conversation（新 ID + 新文件），原对话留在磁盘
- `/clear`:在当前 conversation 内压缩（同 ID + 重写 transcript），老 turns 不可恢复

---

### ADR-CM-010:Conversation 是知行的唯一真相源

**决策**:所有通道收到的消息一律保存到知行的 transcript;ConversationManager 是 agent 唯一的上下文源。任何通道(包括驭灵自家 App)不得绕过 Conversation 直接送消息给 agent。

**理由**:
- agent 跑下一轮 Turn 必须读 SessionRuntime.messages,这是技术硬约束
- 跨通道一致(用户在 App 聊一半换钉钉接着聊)只能靠统一真相源
- 数据所有权属于用户,不能依赖第三方 IM 持续可用
- 自家 App 与第三方 IM 同等待遇,符合"通道平权(ADR-CM-007)"
- 第三方 IM 自己客户端里的消息记录与知行无关,不构成"双写一致性"问题

---

### ADR-CM-011：~~三段窗口压缩~~ → **已撤销**，被上下文架构取代

**原决策（2026-04-17 早）：** SessionRuntime 给 LLM 的上下文由长期摘要 + 中期摘要 + 近期原文三段构成。

**现决策（2026-04-17）：** 撤销。上下文管理完整设计见 [context-architecture.md](./context-architecture.md)。采用场景参数化 + 多级压缩 + LLM 兜底架构。

**撤销理由**：三段窗口基线占用 70K+ tokens，违反"最小化是核心竞争力"的设计理念；且中期摘要常驻本质上是"防御性装入"，违反"按需召回"原则。

---

### ADR-CM-012:transcript.jsonl 严格 append-only

**决策**:transcript.jsonl 严格只追加,不修改/删除已有行。

**理由**:
- 用户对话是资产,磁盘数据保真不可靠压缩改写
- append-only 文件易于备份、易于审计、并发安全(无锁追加)

**修订（2026-04-17）：** 原 ADR 中的"永不删除"含义过强——转为"原子事务日志 + compact 触发原子截断"。具体归档策略见 [context-architecture.md](./context-architecture.md) §十四。磁盘治理机制见 §9.5 + ADR-CM-017（commitTurn 原子截断,至多 1 个 compact 行,无归档段）。

---

### ADR-CM-013：临时对话（Ephemeral Conversation）

**决策**：lookup 场景的单轮交互默认创建临时对话（纯内存,不持久化）。满足升级条件时自动转为持久化 Conversation。临时态在 **Server 模式 + CLI 单次模式（`-p`）** 下生效；CLI REPL 交互模式跳过临时态。

**理由**：
- 个人助手会收到大量一次性查询（"今天天气"、"翻译这句话"），为每条创建 transcript 文件是浪费
- 临时态是 Conversation 的候选态,不违反"数据归用户所有"原则——升级后受完整保护
- CLI REPL 不需要临时态：用户显式启动进程进入交互 = 表达了"这是一次正式对话"的意图
- CLI `-p` 是管道式单次查询（无 REPL、不可追问），与 Server 收到的一次性查询本质相同
- 升级触发条件（第二轮 Turn / 有副作用工具 / scenario.escalate / 用户命令）覆盖了"值得保留"的判断

---

### ADR-CM-014：消息排队策略

**决策**：同一 Conversation 的 SessionRuntime busy 时,用户消息进入 FIFO 队列,深度上限 5 条。超出返回 `queue-full`。`/abort` 同时清空队列。

**理由**：
- 无上限队列 → 用户快速连发 20 条,每条各跑一个 Turn,产生 20 次 LLM 调用,用户等到天荒地老
- 深度 5 = "合理的用户输入缓冲",超过说明用户可能在刷屏或误操作
- abort 清队列 = 用户说"停"就真的停,不会 abort 完立即开始下一条排队消息
- 不做消息合并：多条排队消息可能表达不同意图,合并破坏"一消息 = 一 Turn"不变式

---

### ADR-CM-015：ConversationRepository / TranscriptStore / ConversationManager 三组件分层

**决策**：持久化层由两个独立组件构成,运行时层在其上提供统一入口。

| 组件 | 包 | 职责 | 数据 |
|------|------|------|------|
| ConversationRepository | core | 对话身份 CRUD（list / get / create / rename / archive / delete / touch / findLatest） | meta.json |
| TranscriptStore | core | 对话内容原子日志（init / **commitTurn** / load / countTurns / exists；appendTurn / appendCompact 为 legacy 薄别名） | transcript.jsonl |
| ConversationManager | server | 运行时生命周期（acquire / release / observer / **recordTurn** / promote） | 内存 SessionRuntime |

**核心约束**：
- TranscriptStore **不做身份操作**：没有 list / rename / delete / findLatest。回答"对话是什么"的问题由 Repository 负责
- TranscriptStore **单一原子入口**：`commitTurn(id, {turn?, compactBefore?})` 是唯一写入路径,支持 append / 原子重写 / 纯 compact 三种载荷形态（见 §9.5 + ADR-CM-017）
- TranscriptStore **per-id 串行锁**：同一 conversationId 的读/写串行执行,跨 id 并发（ADR-TR-8）
- ConversationRepository **不读内容**：没有 history / load。回答"对话说了什么"的问题由 TranscriptStore（或 Manager 代理）负责
- ConversationManager.recordTurn **单向数据流**：persistent 分支调 commitTurn 拿 canonical → 立即 `session.runtime.updateMessages(canonical)` 回喂,adapter 与磁盘严格一致（ADR-TR-7）
- ConversationManager **配置守卫**：有持久化意图（loadHistory 或 initTranscript）必须提供 commitTurn 回调,否则构造时 fail-fast throw；persistent 分支运行时 assert 作 defense-in-depth
- Repository 和 TranscriptStore 互不依赖,由调用方（CLI / Manager）协调

**理由**：
- Standalone CLI 需要持久化能力但不需要 observer 管理——如果 Repository 在 server 包里,CLI 要么依赖 server 包（依赖反转）要么复制代码（维护负担）
- 分层后 CLI 只依赖 core,server 依赖 core + 自身,包依赖图干净
- TranscriptStore 是**原子日志**系统,不是 CRUD 系统。commitTurn 单一入口消除分步写（appendTurn + appendCompact）产生的 race 和 timestamp 反序问题
- 将查询/命名/生命周期操作混入日志系统会产生职责模糊和数据 drift（name 在 meta.json 和 JSONL 各存一份）
- 两个 core 组件共享路径基础设施(`getZhixingHome` 与 conversation 模块的 `conversationsDir` dispatcher)但不互相依赖,支持未来独立替换存储后端

---

### ADR-CM-016：cli/serve 统一 user 作用域(不按 cwd 隔离)

**决策**:cli / serve 入口都构造 user 作用域,不引入 cwd 自动隔离机制(无"环境作用域" / 无 ambient 升级 / 无 project 概念分支)。

**理由**:
- 知行核心产品哲学是"任意目录运行效果一致、对话跟着人走"(对齐 [ADR-003](../architecture/decisions/003-config-system.md))
- "project" 在产品中不对应任何用户可感知抽象 —— 按 cwd 算 hash 自动隔离是 IDE 工具思路,与个人助手定位逆向
- workscene 是用户显式创建的工作语境实体,与 cwd 自动隔离机制独立。需要场景隔离请用 workscene,无需基于 cwd 的隐式分层

---

### ADR-CM-017：Transcript Compact 原子截断（commitTurn 单一入口）

**决策**：用 `commitTurn(id, {turn?, compactBefore?})` **原子重写** 作为 compact 触发时的磁盘操作,不保留归档段。文件不变量永远满足 `header + [compact?] + post-compact turns`（至多 1 个 compact 行紧跟 header）。

**与老版本（v1：段轮转 archive/）对比**：

| 维度 | v1（段轮转） | v2（原子截断） |
|------|-------------|---------------|
| compact 时的磁盘操作 | 写新文件 + rename 到 archive/segment-*.jsonl | `writeAtomic` 直接重写 `transcript.jsonl` |
| compact 前 turns | 保留在归档段 | 原子删除（ADR-TR-4/TR-9 `archiveOnCompact=false`） |
| 文件组织 | 活跃段 + `archive/` 目录 | 单个 `transcript.jsonl` |
| 接口 | `appendCompact()` 内部轮转 | `commitTurn({turn?, compactBefore})` 一次原子写入 |
| 跨进程并发 | 未定义 | per-id 串行锁（ADR-TR-8） |

**理由**：
- **v1 段轮转的坏味道**：归档段不读不写就是"数据墓地"——存储成本正比于对话年龄,永不衰减。如果用户从不导出/回看,段轮转就是把磁盘增长从单文件挪到多文件,问题未解决
- **原子截断的干净性**：Phase 5 审计发现 compact 本身的语义就是"此前内容已被 summary 替代,不再需要"——既然如此,磁盘上保留老 turn 纯属冗余。归档需求由用户主动触发（未来 `archiveOnCompact` 可选开关,默认关闭）,不强制所有会话都付存储代价
- **根治三个隐蔽 bug**：§1.1（磁盘无限增长）、§1.2（server 从不写 compact marker）、§1.3（REPL compact 分两步写 timestamp 反序）—— 单原子入口让三个 bug 从架构层面消失
- **接口重塑而非内部优化**：`commitTurn` 替代 `appendTurn + appendCompact` 的分步写入,caller 代码更简洁,失败模式更可预测
- **单向数据流契约化**：commitTurn 返回 canonical messages,配合 `SessionRuntime.updateMessages` 实现"内存 ↔ 磁盘严格一致",消灭 Phase 5 前的三方状态 drift

**与 ADR-CM-012 的关系**：JSONL 日志语义不变——每次 commitTurn 是一次原子事务,中间无观察窗口；崩溃留下的 tmp 文件由 `cleanupOrphanTmp` 静默清理。append-only 演进为"原子事务 + 至多 1 次 compact 截断"（ADR-CM-012 修订注"append-only + 可归档/清理"在此落地,归档开关默认关闭）。

**源设计文档**：`research/design/drafts/transcript-retention.md`（ADR-TR-1 至 TR-9 + §4 接口清单）。

---

## 十五、术语表(快速参考)


| 术语                     | 含义                                                               |
| ---------------------- | ---------------------------------------------------------------- |
| Conversation           | 用户视角的对话身份,长期持久,有 ID/name/scope                                   |
| Ephemeral Conversation | 临时对话,纯内存,满足条件后自动升级为持久 Conversation（§3.7）                         |
| SessionRuntime         | Conversation 的内存运行实例,短期,管理 messages + provider 连接 + 并发锁           |
| Turn                   | 一次完整的 agent loop（用户消息 → agent 响应 + 工具调用 → 完成）                    |
| Transcript             | Conversation 的磁盘表示（JSONL 格式）                                     |
| ConversationRepository | core 包组件,Conversation 身份的磁盘 CRUD（meta.json）                    |
| TranscriptStore        | core 包组件,Conversation 内容的 append-only 日志（transcript.jsonl）       |
| ConversationManager    | server 包组件,管理 SessionRuntime 生命周期（acquire / release / observer），统一代理 Repository + TranscriptStore |
| ChannelAdapter         | 通道适配器接口,定义在 server-gateway.md（connect / disconnect / send + traits） |
| Connection             | 通道内的一次客户端连接,绑定到 Conversation,驱动 observer 计数                       |
| Observer               | Connection 对 SessionRuntime 的引用标记,用于释放规则                          |
| BindingPolicy          | 通道收到消息时归入哪个 Conversation 的策略                                      |
| Scope                  | Conversation 的隔离作用域（user / project）                              |
| Ambient Scope          | Standalone CLI 在无项目标识 cwd 时自动选择 user 作用域（ADR-CM-016）              |


