# Per-Turn 上下文注入架构

> 规格目标：让 AI 在每一轮对话中拥有实时状态感知——当前时间、定时任务状态、未来可扩展到记忆预取和通道上下文。
> 调研依据：[dynamic-context-injection.md](../../source-analysis/dynamic-context-injection.md)（openclaw / hermes / claude-code 三方对比）

---

## 1. 问题

当前知行的上下文注入是 **一次性的**：

| 注入物 | 注入时机 | 注入位置 | 问题 |
|--------|---------|---------|------|
| 身份 + 工具 + 原则 | `createAgentRuntime()` 一次 | system prompt | 正确（静态内容） |
| ZHIXING.md + profile | 首条 user message | `<context>` 标签 | 正确（项目级静态） |
| 当前时间 | `buildEnvironment()` 一次 | system prompt 动态段 | **错误：REPL 全程冻结，serve 每会话冻结** |
| 定时任务状态 | 无 | 无 | **缺失：AI 完全不知道哪些任务在跑** |

后果：
- AI 在 REPL 运行 2 小时后仍报告启动时的时间
- AI 无法区分"5 秒前刚完成的定时提醒"和"历史对话中提到的旧任务"
- AI 无法在回复中自然引用定时任务的执行结果

---

## 2. 设计原则

| 原则 | 理由 |
|------|------|
| **System prompt 不变** | 保护 prompt cache 前缀，三方调研的共识 |
| **按需注入** | 没有活跃任务时不注入任务段，节省 token（Claude Code 总是注入"todo list is empty"——浪费） |
| **统一注入点** | 所有 per-turn 动态内容通过一个管道进入 user message，不散落在多处（Claude Code 有 system-reminder + attachments + section registry 三套——碎片化） |
| **可组合** | 新的上下文源 = 注册一个 provider，无需改注入管道 |
| **数据与渲染分离** | Provider 提供结构化数据，Injector 负责格式化和注入位置决策 |

---

## 3. 两层上下文模型

```
┌─────────────────────────────────────────────────────┐
│ Layer A: 项目上下文（Static Context）                  │
│                                                     │
│ 注入位置：首条 user message                           │
│ 注入时机：每次 run() 调用                              │
│ 格式标签：<context>                                   │
│ 内容：ZHIXING.md / 用户画像 / 匹配技能 / 反思提示       │
│ 更新频率：跨轮稳定，仅首条消息包含                       │
│                                                     │
│ → 已有实现（project-context.ts），不修改               │
├─────────────────────────────────────────────────────┤
│ Layer B: 轮上下文（Turn Context）          ← 新增     │
│                                                     │
│ 注入位置：最新 user message（当前轮输入）               │
│ 注入时机：每次 run() 调用                              │
│ 格式标签：<turn-context>                              │
│ 内容：当前时间 / 定时任务状态 / (future: 记忆预取...)   │
│ 更新频率：每轮都变                                    │
│                                                     │
│ → 本规格的设计目标                                    │
└─────────────────────────────────────────────────────┘
```

**对比参考项目：**

| 维度 | OpenClaw | Hermes | Claude Code | 知行 |
|------|---------|--------|-------------|------|
| 注入机制数 | 2（system prompt 分区 + plugin hook） | 1（user message 追加） | 3（section registry + system-reminder + attachments） | **2（静态 `<context>` + 动态 `<turn-context>`）** |
| 条件注入 | 无 | 无 | 无（总是注入空列表） | **有（无内容时跳过）** |
| 结构化 | plugin 自由文本 | 无结构 | XML 标签但无类型 | **Provider 接口 + 类型安全** |
| 任务状态 | 不注入 | 不注入 | 注入 todo 列表 | **注入调度器状态（含结果摘要）** |

---

## 4. 架构

### 4.1 Provider 接口

```typescript
// packages/core/src/context/turn-context.ts

interface TurnContextSection {
  /** 段落标题（如 "当前时间"、"定时任务"） */
  readonly title: string;
  /** 渲染后的文本内容 */
  readonly body: string;
}

interface TurnContextProvider {
  /** 唯一标识（用于日志和调试） */
  readonly id: string;
  
  /**
   * 判断当前轮是否需要注入。
   * 返回 false 时 render() 不会被调用，节省计算和 token。
   */
  shouldInject(): boolean;
  
  /**
   * 渲染上下文段落。
   * 仅在 shouldInject() 返回 true 时调用。
   */
  render(): TurnContextSection;
}
```

**设计要点：**
- `shouldInject()` 与 `render()` 分离：条件判断可以极轻量（检查一个 flag），避免不必要的字符串拼接
- Provider 在构造时捕获依赖（scheduler 引用、时区配置），`render()` 零参数
- 返回结构化 `TurnContextSection` 而非 raw string——Injector 控制最终格式

### 4.2 TurnContextInjector

```typescript
// packages/core/src/context/turn-context.ts

class TurnContextInjector {
  private readonly providers: TurnContextProvider[] = [];
  
  register(provider: TurnContextProvider): this {
    this.providers.push(provider);
    return this;
  }
  
  /**
   * 构建 <turn-context> 块。
   * 所有 shouldInject()=true 的 provider 按注册顺序渲染。
   * 无内容时返回 null（不注入空标签）。
   */
  build(): string | null {
    const sections = this.providers
      .filter(p => p.shouldInject())
      .map(p => p.render());
    
    if (sections.length === 0) return null;
    
    const body = sections
      .map(s => `[${s.title}] ${s.body}`)
      .join('\n');
    
    return `<turn-context>\n${body}\n</turn-context>`;
  }
  
  /**
   * 将 turn context 注入到消息列表的最新 user message。
   * 不修改原数组，返回浅拷贝。
   */
  inject(messages: Message[]): Message[] {
    const block = this.build();
    if (!block) return messages;
    
    // 找到最后一条 user message，在其文本前注入
    const result = [...messages];
    const lastUserIdx = result.findLastIndex(m => m.role === 'user');
    if (lastUserIdx === -1) return result;
    
    const lastUser = result[lastUserIdx];
    const currentText = extractUserText(lastUser);
    result[lastUserIdx] = replaceUserText(lastUser, `${block}\n\n${currentText}`);
    
    return result;
  }
}
```

### 4.3 注入格式

**示例：有活跃任务时**

```
<turn-context>
[当前时间] 2026-04-20 15:50:54 (Asia/Shanghai)
[定时任务] 1 个活跃 · 2 个最近完成
- ⏳ "每日早报" — cron 每天 08:00，下次 2026-04-21 08:00
- ✅ "5秒后提醒" — 完成于 15:45:30，结果已发送
- ✅ "查看桌面" — 完成于 15:40:12
</turn-context>

用户你好，现在几点了？
```

**示例：无任务时**

```
<turn-context>
[当前时间] 2026-04-20 15:50:54 (Asia/Shanghai)
</turn-context>

帮我看下这个文件
```

注意：没有 `[定时任务] 当前没有定时任务` 这种空段落——`shouldInject()` 返回 false 即整段跳过。

### 4.3.1 溢出保护

定时任务注入的内容量受三层机制控制，防止无限膨胀：

| 层级 | 机制 | 说明 |
|------|------|------|
| **时间窗口** | `recentWindowMs = 30min` | 已完成/失败的任务超过 30 分钟自动消失，不再注入 |
| **数量上限** | `maxActive=10, maxCompleted=5, maxFailed=3` | 超出时显示 `... 还有 N 个`，概览行始终显示总数 |
| **条件跳过** | `shouldInject()` | 三类都为空时整个段落不注入 |

**示例：大量活跃任务时**

```
<turn-context>
[当前时间] 2026-04-20 15:50:54 (Asia/Shanghai)
[定时任务] 15 个活跃 · 1 个最近完成
- ⏳ "监控 API" — 每 5 分钟，下次 15:55
- ⏳ "每日早报" — cron 每天 08:00，下次 2026-04-21 08:00
- ⏳ "周报提醒" — cron 每周五 17:00，下次 2026-04-25 17:00
...（前 10 个按下次执行时间排序）
- ... 还有 5 个活跃任务
- ✅ "数据备份" — 完成于 15:48:02，结果已发送
</turn-context>
```

概览行 `15 个活跃` 让 AI 知道全貌，详情只展示最相关的前 10 个。AI 需要完整列表时可通过 `schedule list` 工具查询。

### 4.4 注入位置

```
消息构建管道（run-agent.ts → run()）：

  params.messages（调用方传入的完整对话历史）
    │
    ├─ enrichContext()          — 检索匹配技能 + 反思提示
    ├─ injectContext()          — 首条 user message 注入 <context>
    ├─ turnContextInjector.inject()  ← 新增：最新 user message 注入 <turn-context>
    │
    ↓
  messagesWithAllContext
    │
    ↓
  runAgentLoop()
```

**关键：注入在 `run()` 内部完成**。REPL / serve / scheduler 都通过 `agentRuntime.run()` 或其等价入口调用，注入逻辑集中在一处。

---

## 5. 内置 Provider

### 5.1 TimeProvider

```typescript
class TimeProvider implements TurnContextProvider {
  readonly id = 'time';
  
  constructor(private readonly timezone: string) {}
  
  shouldInject(): boolean { return true; }  // 时间总是注入
  
  render(): TurnContextSection {
    const now = new Date();
    const formatted = now.toLocaleString('zh-CN', {
      timeZone: this.timezone,
      dateStyle: 'full',
      timeStyle: 'medium',
    });
    return {
      title: '当前时间',
      body: `${formatted} (${this.timezone})`,
    };
  }
}
```

**替换 system-prompt.ts 中的 session-level 时间注入**：`buildEnvironment()` 中移除 `Current time` 行，改由 TimeProvider per-turn 注入。

### 5.2 SchedulerProvider

```typescript
/** 任务状态快照——Scheduler 暴露的只读视图 */
interface TaskStatusSummary {
  active: Array<{
    name: string;
    schedule: string;     // 人类可读："cron 每天 08:00" / "每 30 分钟" / "一次性"
    nextRunAt?: string;   // ISO datetime
  }>;
  recentlyCompleted: Array<{
    name: string;
    completedAt: string;  // ISO datetime
    summary?: string;     // 执行结果摘要（前 100 字）
    delivered?: boolean;  // 是否已通过通道发送
  }>;
  recentlyFailed: Array<{
    name: string;
    failedAt: string;
    error: string;
  }>;
}

/** 溢出保护配置 */
interface SchedulerProviderOptions {
  /** 最近完成/失败的时间窗口（默认 30 分钟） */
  recentWindowMs?: number;
  /** 活跃任务最大显示数（默认 10） */
  maxActive?: number;
  /** 最近完成最大显示数（默认 5） */
  maxRecentlyCompleted?: number;
  /** 最近失败最大显示数（默认 3） */
  maxRecentlyFailed?: number;
}

class SchedulerProvider implements TurnContextProvider {
  readonly id = 'scheduler';
  
  private readonly maxActive: number;
  private readonly maxRecentlyCompleted: number;
  private readonly maxRecentlyFailed: number;
  
  constructor(
    private readonly getStatus: () => TaskStatusSummary,
    options: SchedulerProviderOptions = {},
  ) {
    this.maxActive = options.maxActive ?? 10;
    this.maxRecentlyCompleted = options.maxRecentlyCompleted ?? 5;
    this.maxRecentlyFailed = options.maxRecentlyFailed ?? 3;
  }
  
  shouldInject(): boolean {
    const s = this.getStatus();
    return s.active.length > 0
        || s.recentlyCompleted.length > 0
        || s.recentlyFailed.length > 0;
  }
  
  render(): TurnContextSection {
    const s = this.getStatus();
    const parts: string[] = [];
    
    // 概览行（始终显示总数，即使被截断）
    const counts: string[] = [];
    if (s.active.length > 0) counts.push(`${s.active.length} 个活跃`);
    if (s.recentlyCompleted.length > 0) counts.push(`${s.recentlyCompleted.length} 个最近完成`);
    if (s.recentlyFailed.length > 0) counts.push(`${s.recentlyFailed.length} 个最近失败`);
    parts.push(counts.join(' · '));
    
    // 活跃任务（按 nextRunAt 排序，最近要执行的排前面）
    const activeSlice = s.active.slice(0, this.maxActive);
    for (const t of activeSlice) {
      const next = t.nextRunAt
        ? `下次 ${formatTime(t.nextRunAt)}`
        : '';
      parts.push(`- ⏳ "${t.name}" — ${t.schedule}${next ? '，' + next : ''}`);
    }
    if (s.active.length > this.maxActive) {
      parts.push(`- ... 还有 ${s.active.length - this.maxActive} 个活跃任务`);
    }
    
    // 最近完成（按 completedAt 排序，最新的排前面）
    const completedSlice = s.recentlyCompleted.slice(0, this.maxRecentlyCompleted);
    for (const t of completedSlice) {
      const delivery = t.delivered ? '，结果已发送' : '';
      const summary = t.summary ? ` (${t.summary})` : '';
      parts.push(`- ✅ "${t.name}" — 完成于 ${formatTime(t.completedAt)}${summary}${delivery}`);
    }
    if (s.recentlyCompleted.length > this.maxRecentlyCompleted) {
      parts.push(`- ... 还有 ${s.recentlyCompleted.length - this.maxRecentlyCompleted} 个最近完成`);
    }
    
    // 最近失败
    const failedSlice = s.recentlyFailed.slice(0, this.maxRecentlyFailed);
    for (const t of failedSlice) {
      parts.push(`- ❌ "${t.name}" — 失败于 ${formatTime(t.failedAt)}: ${t.error}`);
    }
    
    return {
      title: '定时任务',
      body: parts.join('\n'),
    };
  }
}
```

> ⚠ **已更新（调度器重构）**：`scheduler.getStatusSummary()` 已删除——cli 去自起 Scheduler 后，
> SchedulerProvider 的数据源改为 `getSchedulerStatus` closure：cli 读 `scheduler.json` 从属投影
> （`readSchedulerSummarySync`）、daemon 直接调平台无关纯函数 `computeStatusSummary`（均先按
> `isInternal` 过滤 internal）。本节下方 getStatusSummary 实现、以及后文
> `SchedulerProvider(() => scheduler.getStatusSummary())` 直连写法为历史设计，以
> `core/scheduler/status-summary.ts` + `cli/runtime/turn-context-providers.ts` 为准。

**Scheduler 端暴露 `getStatusSummary()`：**

```typescript
// packages/core/src/scheduler/scheduler.ts — 新增方法

getStatusSummary(recentWindowMs: number = 30 * 60 * 1000): TaskStatusSummary {
  const now = this.now();
  const cutoff = new Date(now.getTime() - recentWindowMs);
  const tasks = this.getAllTasks();
  
  return {
    // 活跃 = enabled + 有下次执行时间，按 nextRunAt 升序（最近要跑的排前面）
    active: tasks
      .filter(t => t.enabled && t.state.nextRunAt)
      .sort((a, b) => (a.state.nextRunAt ?? '').localeCompare(b.state.nextRunAt ?? ''))
      .map(t => ({
        name: t.name,
        schedule: formatSchedule(t.schedule),
        nextRunAt: t.state.nextRunAt,
      })),
    // 最近完成 = 时间窗口内 + 无错误，按完成时间降序（最新的排前面）
    recentlyCompleted: tasks
      .filter(t => t.state.lastRunAt
        && new Date(t.state.lastRunAt) >= cutoff
        && !t.state.lastError)
      .sort((a, b) => (b.state.lastRunAt ?? '').localeCompare(a.state.lastRunAt ?? ''))
      .map(t => ({
        name: t.name,
        completedAt: t.state.lastRunAt!,
        summary: t.state.lastSummary?.slice(0, 100),
        delivered: true, // TODO: track delivery status in task state
      })),
    recentlyFailed: tasks
      .filter(t => t.state.lastError
        && t.state.lastRunAt
        && new Date(t.state.lastRunAt) >= cutoff)
      .map(t => ({
        name: t.name,
        failedAt: t.state.lastRunAt!,
        error: t.state.lastError!,
      })),
  };
}
```

---

## 6. 接入方式

### 6.1 run-agent.ts（中心接入点）

```typescript
// createAgentRuntime() 中：

// 初始化 turn context injector
const turnContextInjector = new TurnContextInjector();
turnContextInjector.register(new TimeProvider(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
));

// ... 返回的 AgentRuntime 对象中:
async run(params: RunParams): Promise<RunResult> {
  // ... 已有逻辑 ...
  const messagesWithContext = injectContext(params.messages, enrichedContext);
  const messagesWithTurnContext = turnContextInjector.inject(messagesWithContext);
  // ← 替换原来的 messagesWithContext，后续用 messagesWithTurnContext
  
  const gen = runAgentLoop({
    messages: messagesWithTurnContext,  // ← 包含 turn context
    // ... 其余不变 ...
  });
}
```

### 6.2 Scheduler Provider 接入

REPL（repl.ts）和 serve（command.ts）创建 scheduler 后，注册 SchedulerProvider：

```typescript
// 方案 A：通过 AgentRuntime 暴露注册接口
agentRuntime.registerTurnContextProvider(
  new SchedulerProvider(() => scheduler.getStatusSummary()),
);

// 方案 B：在 createAgentRuntime 时传入（更简洁）
const agentRuntime = await createAgentRuntime({
  extraTools: [scheduleTool],
  turnContextProviders: [
    new SchedulerProvider(() => schedulerInstance!.getStatusSummary()),
  ],
});
```

方案 B 有循环依赖问题（scheduler 未创建时 provider 就要注入）。方案 A 允许后注册。

**推荐方案 A**：`AgentRuntime` 暴露 `registerTurnContextProvider()` 方法，REPL/serve 在 scheduler 创建后调用。与 schedule 工具的 lazy getter 模式一致。

---

## 7. 实现计划

### Phase 1: 注入管道 + 时间感知

**目标**：建立 per-turn 注入管道，实现精确时间感知。

| 变更 | 文件 | 说明 |
|------|------|------|
| 新增 | `core/src/context/turn-context.ts` | `TurnContextProvider` 接口 + `TurnContextInjector` 类 + `TimeProvider` |
| 修改 | `core/src/context/index.ts` | 导出新模块 |
| 修改 | `cli/src/run-agent.ts` | `createAgentRuntime` 初始化 injector + TimeProvider，`run()` 中调用 `inject()` |
| 修改 | `cli/src/system-prompt.ts` | `buildEnvironment()` 移除 `Current time` 行（避免与 turn context 重复） |
| 修改 | `cli/src/run-agent.ts` | `AgentRuntime` 接口新增 `registerTurnContextProvider()` |

**验证**：
1. REPL 启动，问"现在几点了"→ 回答正确
2. 等待 2 分钟，再问"现在几点了"→ 回答更新后的时间（不是启动时冻结的）
3. serve 模式相同验证
4. 检查 system prompt 中不再包含时间信息

**独立性**：Phase 1 完成后，即使不做 Phase 2，时间感知已完整工作。

---

### Phase 2: 调度器感知

**目标**：AI 知道当前有哪些定时任务、最近完成/失败了什么。

| 变更 | 文件 | 说明 |
|------|------|------|
| 新增 | `core/src/context/turn-context.ts` | `SchedulerProvider` + `TaskStatusSummary` 类型 |
| 修改 | `core/src/scheduler/scheduler.ts` | 新增 `getStatusSummary()` 方法 |
| 修改 | `cli/src/repl.ts` | scheduler 创建后注册 `SchedulerProvider` |
| 修改 | `cli/src/serve/command.ts` | 同上 |

**验证**：
1. 创建一个"5 秒后提醒"任务 → 立即问"有哪些定时任务"→ AI 列出活跃任务
2. 5 秒后任务完成 → 问"有哪些定时任务"→ AI 知道任务已完成，能引用结果
3. 30 分钟后问同样的问题 → AI 不再提起已过期的完成记录
4. 没有任何任务时 → `<turn-context>` 中不包含定时任务段落

**独立性**：Phase 2 仅依赖 Phase 1 的注入管道。不需要改消息格式或 agent loop。

---

### Phase 3: 结果感知与投递状态

**目标**：AI 知道任务结果的内容和投递状态。

| 变更 | 文件 | 说明 |
|------|------|------|
| 修改 | `core/src/scheduler/types.ts` | `TaskState` 新增 `deliveryStatus?: 'sent' \| 'pending' \| 'failed'` |
| 修改 | `core/src/scheduler/scheduler.ts` | `enqueueDelivery` 后更新 `deliveryStatus` |
| 修改 | `core/src/context/turn-context.ts` | `SchedulerProvider.render()` 渲染投递状态和结果摘要 |

**验证**：
1. 创建"5 秒后提醒"+ 飞书通道 → 任务完成 → 问"提醒发了吗"→ AI 知道已通过飞书发送
2. 通道离线时 → AI 知道投递失败

**独立性**：Phase 3 是 Phase 2 的增强，不改变注入管道。

---

## 8. 与现有 Layer 3 的关系

LayerAssembler 的 Layer 3 已有 `currentTime` 和 `activeTaskHint` 参数，但存在问题：

1. **Layer 3 在 system prompt 中**：`assembleLayers()` 的输出拼进 system prompt，而 system prompt 在 `createAgentRuntime()` 时构建一次就不变了
2. **Layer 3 没有被 wired**：`currentTime` 和 `activeTaskHint` 从未被任何调用方传入

**处理方式**：不重构 LayerAssembler。Layer 3 保留作为 system prompt 的动态段（工作区、平台信息等 session-level 内容），真正的 per-turn 内容走新的 `<turn-context>` 管道。两者职责清晰分离：

| | Layer 3（system prompt） | Turn Context（user message） |
|---|---|---|
| 更新频率 | session 级（启动时确定） | 每轮 |
| 内容 | 工作区路径、平台、Node 版本 | 当前时间、任务状态 |
| 缓存影响 | 在 cache boundary 之后，轻微影响 | 不影响 system prompt cache |

---

## 9. 扩展路线（不在本期实现）

| Provider | 触发条件 | 内容 |
|----------|---------|------|
| MemoryProvider | 记忆预取命中时 | 相关记忆摘要 |
| ChannelProvider | serve 模式接收消息时 | 来源通道、发送者身份 |
| SessionProvider | 多会话切换时 | 当前会话名称、轮数 |

每个 Provider 只需实现 3 个方法（`id` / `shouldInject` / `render`），注册到 injector 即可。无需改注入管道。
