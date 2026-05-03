# RuntimeSession 与配置热重载

> REPL 运行期内修改基础配置（`/config` slash 命令）+ 改完立即生效（hot reload）。本规格通过引入 `RuntimeSession` 抽象聚合 REPL 中协同生命周期的资源，支撑 blue-green swap 模式的热重载，同时消除 `repl.ts` 散落资源的 god module 债。

## 一、设计原则

- **runtime 不可变契约保留**：reload = `create new` + `replace ref` + `dispose old`，不引入 mutable refs 或 lazy build cache 等内部状态；`AgentRuntime` 仍是不可变值
- **零跨包 API 改动**：除 `CreateAgentRuntimeOptions` 加一个向后兼容的 optional 字段（`permissionStore?`），不动 orchestrator 公共 API、不动 tools-builtin、不动 core/scheduler/channels/delivery 任何接口
- **会话级单例归属正确**：用户运行期授权（`PermissionStore` session scope）从 runtime 内部 new 抽到 session 持有，跨 reload 复用——避免改完配置后用户授权全丢的 UX 灾难
- **边界清晰**：`RuntimeSession` 只管协同资源生命周期；不读 REPL state、不感知 turn 状态、不感知用户输入——业务流程归 REPL
- **dispose 顺序硬约束**：`Scheduler` 持有 `delivery` ref → 旧 scheduler stop 完成之后才能 dispose 旧 deliveryStack/channels，反序会 use-after-dispose
- **透明性优先**：reload 完成立即给用户文字反馈（成功/无变更/失败 fallback）；旧资源 dispose 走背景，不阻塞用户
- **复用现有基础设施**：`repl.ts:646-771` 已有 mutable closure getter 模式（解开 Scheduler/agentRuntime/scheduleTool 循环依赖的副产品）——swap 时替换变量，所有 closure 自动响应；不引入新概念

## 二、范围与边界

### 2.1 范围

- 引入 `RuntimeSession` 类聚合 `agentRuntime` / `scheduler` / `deliveryStack` / `channels` / `permissionStore`
- 添加 `/config` slash 命令——REPL 内修改 `~/.zhixing/config.json` + `~/.zhixing/credentials.json`
- 添加 `reload()` 流程——blue-green swap 应用配置变更
- 修复前置 sub-bug：`/switch` `/new` 漏 `convRepo.touch()`、`/exit` 半吊子 cleanup
- REPL 状态机暴露 `activeTurnPromise`，让 reload 调用方能等 in-flight turn

### 2.2 不在范围（明确不做）

- **deep link**（如 `/config provider.aibang.model` 直达）：当前 `panels/main.ts:221` 硬写 `cursor=0`，扩展点已识别（`ConfigEditorContext.initialPanel?`），等未来加 `/model` 快捷直达再做
- **`/model` 等高频快捷直达 slash**：等真实使用证据出现再加，不预先做（避免命令空间膨胀）
- **`/restart` 独立命令**：重启是退步 UX，不引入
- **CLI 子命令 `zhixing config`**：不可发现，需退出 REPL 上下文，否决
- **文件 watch 自动 reload**：当前仅 `/config completed` 触发；未来扩展为支持外部触发时，复用 `RuntimeSession.reload()` 接口
- **server 模式 hot reload**：当前 spec 仅覆盖 REPL；server / channel 模式的 reload 复用 `RuntimeSession` 但触发与反馈不同，单独 spec
- **`/config` 编辑期间用户主动 abort 已 in-flight 的 turn**：编辑器接管 stdin 后用户无法触发 abort；竞态窗口不存在
- **多 reload 并发**：`/config` 编辑器是模态 stdin 接管，单进程内不可能并发 `/config`；未来扩展触发源时再考虑 mutex

## 三、`RuntimeSession` 抽象

### 3.1 位置与公共 API

`packages/cli/src/runtime/session.ts`（新增模块）。

```typescript
export class RuntimeSession {
  static create(opts: RuntimeSessionOptions): Promise<RuntimeSession>;

  reload(): Promise<ReloadResult>;
  dispose(): Promise<void>;

  /** REPL 主回路通过 session.runtime.run(...) 调用，自动指向 swap 后的最新 runtime */
  get runtime(): AgentRuntime;

  /** 暴露给 REPL 用于 schedule tool 渲染、状态命令等 */
  get scheduler(): Scheduler;

  /**
   * 把 TerminalConfirmationRenderer attach 到当前 confirmationBroker。
   * session 持有 renderer ref + 当前 detach handle，跨 reload 自动 detach 旧 broker / attach 新 broker。
   * 返回 outer detach——调用方在退出时调用，session 内部释放绑定。
   */
  attachConfirmationRenderer(renderer: TerminalConfirmationRenderer): () => void;
}

export interface RuntimeSessionOptions {
  /** 启动期已 load 的配置——session 持有用于后续 diff */
  config: ZhixingConfig;
  credentials: ZhixingCredentials;

  /** CLI override（仅启动时一次，reload 不变；reload 永远从配置文件读） */
  cliWorkspace?: string;
  cliModel?: string;
  cliProvider?: string;

  /** 顶层资源（session 借用，不持有，不在 dispose 中关闭） */
  renderer: Renderer;

  /** Channel/scheduler/delivery setup 依赖 */
  zhixingHome: string;
  loggers: {
    channel: ChannelLogger;
    scheduler: SchedulerLogger;
    delivery: DeliveryLogger;
  };
}

export type ReloadResult =
  | { kind: "no-change" }
  | { kind: "applied"; changedDomains: ReadonlyArray<"channels" | "agent"> }
  | { kind: "failed"; error: Error };
```

设计意图：

- `create` / `reload` / `dispose` 三个生命周期入口对应"启动 / 配置变更 / 退出"三种事件
- `runtime` / `scheduler` getter 暴露给 REPL 用于业务调用——getter 而非字段，每次访问读最新 instance
- `ReloadResult` 不抛——`failed` kind 返回错误，调用方决定如何展示给用户；用 discriminated union 让 caller 必须穷举处理三种结果
- 不暴露 `agentRuntime` / `scheduler` 实例的直接持有——REPL 永远通过 getter 访问，避免外部 cache 旧引用

### 3.2 内部状态

```typescript
class RuntimeSession {
  private agentRuntime: AgentRuntime;
  private scheduler: Scheduler;
  private deliveryStack?: DeliveryStack;
  private channels?: ChannelRegistry;

  /** 跨 reload 复用：内存态用户授权（PermissionStore session scope）——丢了用户要重新点"始终允许"，UX 灾难 */
  private readonly permissionStore: IPermissionStore;

  /** 当前已 load 的 config / credentials——下次 reload 时与新文件对比 diff */
  private config: ZhixingConfig;
  private credentials: ZhixingCredentials;

  /** confirmationRenderer 跨 reload 自动 re-attach */
  private attachedRenderer?: TerminalConfirmationRenderer;
  private currentBrokerDetach?: () => void;

  /** 启动期参数——reload 时复用（CLI override 不变） */
  private readonly opts: RuntimeSessionOptions;
}
```

### 3.3 创建（`RuntimeSession.create`）

`create` 等价于 REPL 启动时的资源装配——把 `repl.ts:657-774` 的散落代码搬进来：

1. `permissionStore = new PermissionStore({ extractArgument })`——session 持有
2. 如 `config.messaging` 非空：`channels = await setupChannels(...)` + `deliveryStack = await setupDelivery(...)`
3. `agentRuntime = await createAgentRuntime({ ...opts, permissionStore, decorateRunBus: createRenderSubscribers(opts.renderer), onSecurityBlocked, onUserDenied })`
4. `scheduler = new Scheduler({ delivery: deliveryStack?.delivery, runAgentTurn: closure 读 this.agentRuntime, ... })`
5. `agentRuntime.registerTurnContextProvider(new SchedulerProvider(() => this.scheduler.getStatusSummary()))`
6. `await scheduler.start()`

`runAgentTurn` 是 closure：
```typescript
const runAgentTurn = async (params: ScheduledTaskParams): Promise<AgentTurnResult> => {
  const result = await this.agentRuntime.run({...});
  // 提取文本输出 + 构造 AgentTurnResult
};
```

通过 `this.agentRuntime` 读最新 ref——swap `this.agentRuntime` 后，**旧 scheduler 内部的 runAgentTurn 自动指向新 agent**，不需要重建 scheduler 跟随 agent 重建。scheduler 重建条件**只跟随 channels/delivery 重建**：`Scheduler` 构造时 value-capture 了 `delivery: deliveryStack?.delivery`（公共 API 无 `setDelivery`），delivery 变了必须重建 scheduler 拿新 ref；agent 变但 delivery 不变时 scheduler 保持不动——这与 §一原则"复用现有 closure getter 模式"完全一致，同时避免无谓的 timer 重启 / 持久化任务重 load 开销。

### 3.4 dispose（退出）

```typescript
async dispose(): Promise<void> {
  // detach renderer 不让进 dispose 后访问已释放的 broker
  this.currentBrokerDetach?.();

  await this.scheduler.stop();        // graceful，等 active task 或超时
  await this.deliveryStack?.stop();
  await this.channels?.dispose();
  // agentRuntime 无 dispose 接口——内部全 in-memory，自然 GC
}
```

dispose 顺序与 reload 步骤 7 一致——共享同一序列。

## 四、`/config` slash 命令

### 4.1 注册（双轨制）

REPL 当前 slash 命令走两套 [`input-typeahead.md`](input-typeahead.md) 描述的双轨制：

- **legacy handler**（`buildSlashCommands` 内）：用户敲 `/config` 时实际执行的逻辑
- **typeahead 元数据**（`REPL_COMMANDS` 数组）：自动派生 typeahead 候选 + 类目分组

`/config` 注册：

| 字段 | 值 |
|---|---|
| name | `/config` |
| aliases | （无） |
| description | `"修改基础配置（服务商 / 模型 / API Key / 消息通道等）"` |
| category | `"config"`（与已有 `/trust` `/security` 同类） |
| legacyKey | `"config"` |
| args | `[]` |
| hidden | `false` |

实现位置：
- `packages/cli/src/repl.ts` 的 `buildSlashCommands` 加 `config` handler（参考 `repl.ts:123` 内现有命令注册模式）
- `REPL_COMMANDS` 数组（`repl.ts:994` 附近）加条目，typeahead 自动派生

### 4.2 Handler 流程

```typescript
async function handleConfigCommand(deps: {
  rl: readline.Interface;
  state: ReplState;
  session: RuntimeSession;
  renderer: Renderer;
}): Promise<void> {
  const { rl, state, session, renderer } = deps;

  rl.pause();  // 让出 stdin

  try {
    // 1. 重新 load——保证用户外部编辑后的一致性，不复用启动缓存
    const config = loadConfig({ cwd: process.cwd() });
    const credentials = loadCredentials({ homeDir: resolveHomeDir() });

    // 2. 调编辑器——与 startup-check 同接口、不同 caller
    const result = await runConfigEditor({
      initialConfig: config,
      initialCredentials: credentials,
      sections: ALL_REGISTERED_SECTIONS,  // model + messaging + 未来加的 sections
      title: "基础配置",
      header: { workspaceRoot, configPath, credentialsPath },
      writers: { writeConfig, writeCredentials },
      stdin: process.stdin,
      stdout: process.stdout,
      isTTY: true,
    });

    // 3. 处理结果
    switch (result.kind) {
      case "completed": {
        // 前置等待 in-flight turn —— 调用方语义，session 不内嵌
        if (state.activeTurnPromise) {
          await state.activeTurnPromise.catch(() => {});  // turn 自身错误此处吞掉，已在 turn 路径展示
        }
        // 触发 reload
        const reloadResult = await session.reload();
        renderReloadFeedback(renderer, reloadResult);
        break;
      }
      case "cancelled":
        // 静默回 REPL，无副作用
        break;
      case "non-tty":
        // REPL 必为 TTY，理论不可能；防御性降级提示
        renderer.warn("当前终端非 TTY，无法启动配置编辑器");
        break;
    }
  } finally {
    rl.resume();
  }
}
```

### 4.3 透明性反馈

`renderReloadFeedback` 按 `ReloadResult.kind` 分支：

| Kind | 渲染 |
|---|---|
| `no-change` | `(无变更)`（淡色 dim） |
| `applied`（含变更域） | `✓ 配置已保存。下条消息使用新配置。` + 可选附"已变更：channels / agent"（按 `changedDomains`） |
| `failed` | `⚠ 配置已保存但应用失败：<error.message>。下次启动生效。`（fallback：磁盘已写新值，重启自然 pickup） |

failed 路径不抛——磁盘已写新值，行为收敛到"下次启动应用"。session 实例保持旧状态，REPL 继续运行不中断。

### 4.4 错误处理

| 错误源 | 处理 |
|---|---|
| `loadConfig` / `loadCredentials` schema 解析失败 | 不应发生——文件刚由编辑器写过；若发生抛 `ConfigSchemaError`，reload 内部 catch 转为 `failed` 结果，文件已写不影响下次启动 |
| `runConfigEditor` 内部异常（罕见——alt screen / TTY 错） | bubble 到 handler 层 catch，渲染 `⚠ 配置编辑器异常：...`，REPL 继续 |
| `session.reload()` 中途任一步失败 | reload 内部事务性回滚，返回 `failed` 结果（见 §五） |

## 五、`reload()` 流程

### 5.1 触发条件

当前期仅 `/config completed` 触发。未来扩展触发源（文件 watch / IPC / server admin API）时复用同一 `reload()` 入口——不感知触发方。

### 5.2 流程

```typescript
async reload(): Promise<ReloadResult> {
  try {
    // 1. 读最新配置（providers 包已有的 reader，自动校验 schema）
    const newConfig = loadConfig({ cwd: process.cwd() });
    const newCredentials = loadCredentials({ homeDir: resolveHomeDir() });

    // 2. diff 决策
    const diff = computeDiff(this.config, this.credentials, newConfig, newCredentials);
    if (diff.kind === "no-change") {
      return { kind: "no-change" };
    }

    // 3. 构建新内部资源（事务性——任一失败 dispose 已建的、保留旧 session 不变）
    const built = await this.buildNewResources(newConfig, newCredentials, diff);
    // built: { newChannels?, newDeliveryStack?, newAgentRuntime?, newScheduler? }

    // 4. ConfirmationBroker re-attach（如重建了 agentRuntime，broker 也是新的）
    let newBrokerDetach: (() => void) | undefined;
    if (built.newAgentRuntime && this.attachedRenderer) {
      this.currentBrokerDetach?.();
      newBrokerDetach = built.newAgentRuntime.confirmationBroker.attach(this.attachedRenderer);
    }

    // 5. swap fields
    const old = this.snapshotOld();
    this.applySwap(built, newConfig, newCredentials, newBrokerDetach);

    // 6. 后台 dispose 旧资源（顺序硬约束，详见 §5.5）
    void this.disposeOldInBackground(old);

    return { kind: "applied", changedDomains: diff.changedDomains };
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
  }
}
```

### 5.3 Diff 算法

```typescript
interface DiffResult {
  kind: "no-change" | "changed";
  channelsChanged: boolean;       // config.messaging 或 credentials.channels 变了
  agentChanged: boolean;          // 主对话相关字段变了
  changedDomains: ReadonlyArray<"channels" | "agent">;
}

function computeDiff(oldC, oldCr, newC, newCr): DiffResult {
  const channelsChanged =
    !deepEqual(oldC.messaging ?? {}, newC.messaging ?? {}) ||
    !deepEqual(oldCr.channels ?? {}, newCr.channels ?? {});

  const agentChanged =
    oldC.llm?.main?.provider !== newC.llm?.main?.provider ||
    oldC.llm?.main?.model !== newC.llm?.main?.model ||
    !deepEqual(oldC.llm?.secondary ?? null, newC.llm?.secondary ?? null) ||
    !deepEqual(oldC.providers ?? {}, newC.providers ?? {}) ||
    !deepEqual(oldCr.providers ?? {}, newCr.providers ?? {}) ||
    !deepEqual(oldC.workspace ?? {}, newC.workspace ?? {}) ||
    !deepEqual(oldC.network ?? {}, newC.network ?? {}) ||
    !deepEqual(oldC.agent ?? {}, newC.agent ?? {}) ||
    !deepEqual(oldC.intent ?? {}, newC.intent ?? {});

  if (!channelsChanged && !agentChanged) return { kind: "no-change", ... };
  return { kind: "changed", channelsChanged, agentChanged, changedDomains: [...] };
}
```

`deepEqual` 用稳定的 JSON 序列化对比（按 key 排序）或 lodash isEqual——实施细节。

**diff 必要性**：
- channel 不变时复用旧 channels 避免长连接闪断（telegram websocket / 飞书 WebHook）
- agent 不变时不重建 agentRuntime——避免无谓的 systemPrompt build / project context 加载

**scheduler 重建条件 = channels/delivery 重建**（不跟随 agent）：`Scheduler` 构造时 value-capture 了 `delivery` ref（公共 API 无 `setDelivery`），delivery 变了必须重建 scheduler 拿新 ref。**agent 变但 delivery 不变时 scheduler 不动**——`runAgentTurn` 是 closure 读 `this.agentRuntime`，swap agent 后旧 scheduler 内部 callback 自动指向新 agent，符合 §一"复用现有 closure getter 模式"原则；同时避免不必要的 stop/start + timer 重启 + 持久化任务重 load 开销。

`changedDomains` 维度仍为 `"channels" | "agent"`——前者覆盖 channels+delivery+scheduler 三者重建，后者仅覆盖 agentRuntime 重建。

### 5.4 事务性构建（`buildNewResources`）

```typescript
async buildNewResources(newConfig, newCredentials, diff): Promise<BuildResult> {
  let newChannels, newDeliveryStack, newAgentRuntime, newScheduler;

  try {
    if (diff.channelsChanged) {
      newChannels = await setupChannels(...);
      newDeliveryStack = await setupDelivery({ channels: newChannels, ... });
      // delivery 已重建，scheduler 必须重建（value-capture delivery，无 setDelivery）
      newScheduler = new Scheduler({
        store: new JsonTaskStore(),
        runAgentTurn: (params) => /* closure 读 this.agentRuntime —— swap 后自动指向最新 */,
        eventBus: createEventBus<SchedulerEventMap>(),
        delivery: newDeliveryStack.delivery,
        logger: this.opts.loggers.scheduler,
      });
      await newScheduler.start();
    }

    if (diff.agentChanged) {
      newAgentRuntime = await createAgentRuntime({
        ...this.opts,
        config: newConfig,
        credentials: newCredentials,
        permissionStore: this.permissionStore,  // 跨 swap 复用
        decorateRunBus: createRenderSubscribers(this.opts.renderer),
        onSecurityBlocked, onUserDenied,
      });
      // SchedulerProvider 通过 () => this.scheduler.getStatusSummary() 读最新 scheduler——
      // swap this.scheduler 后自动响应，无需重建 provider
      newAgentRuntime.registerTurnContextProvider(
        new SchedulerProvider(() => this.scheduler.getStatusSummary())
      );
      // **不**重建 scheduler——旧 scheduler 的 runAgentTurn closure 读 this.agentRuntime，
      // swap agent 后自动指向新 agent
    }

    return { newChannels, newDeliveryStack, newAgentRuntime, newScheduler };
  } catch (err) {
    // 回滚：dispose 已分配的（顺序与 5.5 一致）
    if (newScheduler) await newScheduler.stop().catch(noop);
    if (newDeliveryStack) await newDeliveryStack.stop().catch(noop);
    if (newChannels) await newChannels.dispose().catch(noop);
    // newAgentRuntime 无 dispose 接口，孤立后自然 GC
    throw new ReloadBuildError("build failed during reload", { cause: err });
  }
}
```

回滚保证：失败时 session 持有的旧资源完全不动；新资源已 partial 分配的全部释放。

### 5.5 后台 dispose 旧资源

swap 完成后（步骤 5），新资源已活跃——所有 closure getter 已指向新 instance。reload Promise 在此点 resolve，让用户立即看到反馈。旧资源 dispose 在背景：

```typescript
private disposeOldInBackground(old: OldSnapshot): Promise<void> {
  return (async () => {
    // 顺序硬约束：scheduler 持有 delivery ref，反序会 use-after-dispose
    if (old.scheduler !== this.scheduler) {
      await old.scheduler.stop().catch(err => this.logDisposeFailure("scheduler", err));
    }
    if (old.deliveryStack && old.deliveryStack !== this.deliveryStack) {
      await old.deliveryStack.stop().catch(err => this.logDisposeFailure("delivery", err));
    }
    if (old.channels && old.channels !== this.channels) {
      await old.channels.dispose().catch(err => this.logDisposeFailure("channels", err));
    }
    // old.agentRuntime 无 dispose 接口，replace ref 后自然 GC
  })();
}
```

`Scheduler.stop()` 内置 `shutdownTimeoutMs` 超时兜底——不会永久卡。stop 期间旧 active task（用旧 agentRuntime + 旧 deliveryStack）继续跑；stop 返回（正常完成或超时强制）后才 dispose 旧 deliveryStack。

**单步失败仅 warn log，不阻塞用户**：dispose 失败的资源最坏情况是延迟回收（GC 兜底）+ 端口占用——不影响 session 当前正常运行。

## 六、`PermissionStore` 跨 swap：归属修正

### 6.1 现状问题

[`create-agent-runtime.ts:347-349`](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts) 当前由 `createAgentRuntime` 内部 `new PermissionStore`：

```typescript
const persistentStore = new PermissionStore({
  extractArgument: (req) => toolArgumentExtractor.extract(req),
});
```

[`PermissionStore`](../../../packages/core/src/security/permission-store.ts) 三作用域：

| Scope | 存储 | 用户语义 |
|---|---|---|
| session | 纯内存 | "本次会话内一直允许" |
| workspace | `~/.zhixing/permissions/{workspaceId}.json` | "本项目一直允许" |
| global | `~/.zhixing/permissions/global.json` | "永久允许（所有项目）" |

新 store new 时懒加载磁盘——workspace / global scope 自动从磁盘恢复；**session scope 是纯内存，swap 重建会丢**。

每次 reload 都让用户重新点"本次会话允许"——UX 灾难。

### 6.2 修正

`PermissionStore` 是**会话级状态**，归属应该是 `RuntimeSession`：

- `RuntimeSession.create` 时 `new PermissionStore` 一次
- `createAgentRuntime` 通过 `CreateAgentRuntimeOptions.permissionStore?` 接收注入实例
- reload 时新 runtime 收到同一 store ref——session scope 完整保留

### 6.3 `CreateAgentRuntimeOptions` API 扩展

```typescript
export interface CreateAgentRuntimeOptions {
  // 现有字段保持不变
  model?: string;
  provider?: string;
  workspace?: string;
  extraTools?: ToolDefinition[];
  // ...

  /**
   * 可选：注入会话级 PermissionStore——跨 hot reload 复用 session scope 授权。
   * 不传时内部 new 一个新实例（向后兼容现有调用方）。
   */
  permissionStore?: IPermissionStore;
}
```

`createAgentRuntime` 内部：

```typescript
const persistentStore: IPermissionStore = options.permissionStore ?? new PermissionStore({
  extractArgument: (req) => toolArgumentExtractor.extract(req),
});
```

向后兼容——现有 server / 单元测试不传 → 行为完全等于现状；REPL 通过 RuntimeSession 传入 → 跨 reload 复用。

**注意**：`registerBuiltinRules`（`create-agent-runtime.ts:355`）每次 createAgentRuntime 都调一次——同一 store 被多次注册同一规则，PermissionStore 内部需幂等（覆盖式注册）。如不幂等需 PermissionStore 增加 `registerBuiltinRulesOnce` 或注入前外部判断——实施细节。

## 七、REPL 状态机变更

### 7.1 `activeTurnPromise`

REPL 主回路当前 [`repl.ts:1239`](../../../packages/cli/src/repl.ts) 调用 agent.run：

```typescript
const runResult = await agentRuntime.run({...});
```

Promise 在局部 try 块作用域，外部不可观测。reload 流程需要 await——必须暴露到 state：

```typescript
interface ReplState {
  // 现有字段保留
  messages: Message[];
  conversationId: string | null;
  turnCounter: number;
  convRepo: ConversationRepository;
  store: TranscriptStore;
  scheduler: Scheduler | null;
  running: boolean;

  /** 新增：当前 in-flight turn promise；turn idle 时为 null */
  activeTurnPromise: Promise<RunResult> | null;
}
```

主回路改造：

```typescript
async function runTurn(input: string) {
  state.running = true;
  const promise = session.runtime.run({
    messages: [...state.messages, userMessage(input)],
    turnIndex: state.turnCounter,
    abortSignal: interruptRuntime.controller.signal,
    // ...
  });
  state.activeTurnPromise = promise;

  try {
    const result = await promise;
    // commitTurn / 更新 state.messages / state.turnCounter / state.convRepo.touch
    return result;
  } finally {
    state.activeTurnPromise = null;
    state.running = false;
  }
}
```

`activeTurnPromise` 状态生命周期：

| 时点 | 状态 |
|---|---|
| REPL 启动后 idle | `null` |
| 用户敲回车 → run 启动 | 设为 turn promise |
| turn 完成（resolve） | 清回 `null` |
| turn abort（reject 或 resolve with abortReason） | 清回 `null`（finally 守护） |
| `/config` reload 路径读取 | 当时 `null` 或 promise；await 后即得最新 settle 状态 |

### 7.2 Sub-bug 修复

#### A. `/switch` `/new` 漏 `convRepo.touch()`

[`repl.ts:209,239`](../../../packages/cli/src/repl.ts)：两个 handler 切换/新建 conversation 后未调 `state.convRepo.touch(state.conversationId)`，导致 `lastActiveAt` 不更新——下次启动 `findLatest` 选错对话。

修复：两 handler 在切换 / 新建成功后追加：

```typescript
state.convRepo.touch(state.conversationId).catch(() => { /* swallow: lastActiveAt 更新失败不致命 */ });
```

#### B. `/exit` 半吊子 cleanup

[`repl.ts:623-631`](../../../packages/cli/src/repl.ts)：`/exit` 当前只 `scheduler.stop()` + `process.exit(0)`，漏 `deliveryStack.stop()` / `channels.dispose()`，依赖 OS 强制释放。

[`repl.ts:1061-1071`](../../../packages/cli/src/repl.ts) 的 `rl.on("close")` 监听器已包含完整 cleanup。修复：`/exit` 改为 `rl.close()`，让 close 监听器统一清理；监听器内部用 `await session.dispose()` 替代散落的 stop/dispose 调用链。

```typescript
// /exit handler
state.exitRequested = true;
rl.close();  // 不再 process.exit

// rl.on("close")
rl.on("close", async () => {
  renderer.stop();
  // session.dispose 内部已 detach confirmation renderer（见 §3.4），无需外部重复调
  await session.dispose().catch((err) => console.error("[session.dispose]", err));
  console.log(chalk.dim("\n再见 👋"));
  process.exit(0);
});
```

## 八、已实现协同

本规格不引入新概念，复用已有基础设施：

| 已有设施 | 位置 | 协同方式 |
|---|---|---|
| `runConfigEditor` 完全参数化 | `packages/cli/src/config-editor/index.ts:16` + `types.ts:160-178` | bootstrap 与 `/config` 是两个 caller，用同一接口，差异由 `ctx` 注入 |
| `setupChannels` / `setupDelivery` | `packages/cli/src/setup-delivery.ts` | RuntimeSession.create / reload 内部直调，无新接口 |
| `createAgentRuntime` | `packages/orchestrator/src/runtime/create-agent-runtime.ts:290` | 仅扩展 optional `permissionStore?` 参数 |
| `Scheduler` `stop` graceful + timeout | `packages/core/src/scheduler/scheduler.ts:119` | dispose 流程依赖此语义 |
| `ChannelRegistry.dispose` async | `packages/core/src/channels/registry.ts:104` | dispose 流程依赖此语义 |
| `TerminalConfirmationRenderer.attach(): detach` 模式 | `packages/cli/src/security/terminal-renderer.ts:84-150` | RuntimeSession.attachConfirmationRenderer 内部调用 |
| Mutable closure getter（scheduleTool / runAgentTurn / SchedulerProvider） | `packages/cli/src/repl.ts:646-771` | swap 后所有 closure 自动响应；模式不变 |
| Conversation auto-resume / convRepo.touch / TranscriptStore | `packages/cli/src/repl.ts` 多处 + `@zhixing/core/conversation` | 跨 reload 完整保留——session 不封装对话状态 |

## 九、可扩展性 / 可插拔点

设计上预留的扩展位（实施期不做，但接口形态保留兼容性）：

- **Reload 触发源解耦**：`session.reload()` 不感知触发方；未来加文件 watch（`fs.watch` 监听 `~/.zhixing/*.json`） / IPC / server admin API 都直接调 `reload()`
- **Section 注册扩展**：`runConfigEditor` 的 `sections` 是动态参数；未来加偏好（主题、字号、回显等）只需在 `config-editor/sections/` 注册新 section + REPL 调用时加进 `sections` 列表
- **Deep link**：`ConfigEditorContext.initialPanel?` 字段加进类型定义即支持 `/model`（直接打开模型选择面板）等快捷直达——不本期做但接口位置已识别
- **Diff 算法可扩展**：新加 config 字段时往 `computeDiff` 增加判断分支即可；未来若 diff 算法复杂化（如基于 JSON Patch）可换实现，公共契约 `DiffResult` 不变
- **PermissionStore 替换**：通过 `IPermissionStore` 接口注入；未来如引入持久化 session scope 或加密存储等，session 持有不同实现即可
- **Logger 注入**：`RuntimeSessionOptions.loggers` 把日志输出抽到 caller——未来 server 模式接结构化日志、CLI 接 chalk 染色都通过同一 session 类
- **Confirmation Renderer 可换**：`attachConfirmationRenderer` 接受 `TerminalConfirmationRenderer` 接口；未来 GUI / TUI 等其他 renderer 实现该接口即可

## 十、错误契约

| 场景 | 行为 |
|---|---|
| `RuntimeSession.create` 中途任一资源装配失败 | 抛 `RuntimeSessionInitError`——CLI 入口捕获后 fail-fast 退出（与现状的"启动失败 → 退出"路径一致） |
| `session.reload()` `loadConfig` / `loadCredentials` schema 错 | 返回 `failed` kind，error 为 `ConfigSchemaError` / `CredentialsSchemaError`；旧 session 不动 |
| `session.reload()` `buildNewResources` 中途失败 | reload 内部回滚 partial 资源 → 返回 `failed` kind，error 为 `ReloadBuildError`；旧 session 不动 |
| `session.reload()` swap 后后台 dispose 单步失败 | warn log，不影响 reload Promise（已 resolve `applied`）；旧资源延迟 GC，session 当前状态正常 |
| `session.dispose()` 任一步失败 | warn log，继续后续步骤；不阻塞 process exit |
| `/config` 编辑器内部异常（罕见——alt screen / TTY 错） | 在 `/config` handler 层 catch，fallback 渲染错误信息，REPL 继续 |

**统一约束**：错误消息**不含**任何凭证内容（apiKey / channel secret 等）。复用 [`packages/core/src/security/env-sanitize.ts`](../../../packages/core/src/security/env-sanitize.ts) 脱敏。

## 十一、测试要求

| 类型 | 覆盖 |
|---|---|
| 单元（RuntimeSession） | `create` 各配置组合（含/不含 messaging）；`reload` 各 diff 情况（no-change / channels-only / agent-only / both）；事务性回滚（mock setupChannels / setupDelivery / createAgentRuntime / Scheduler 任一 throw）；dispose 顺序验证（spy stop/dispose 调用顺序） |
| 单元（diff 算法） | 各字段独立变更触发对应 domain；channels 与 agent 同时变；deepEqual 边界（undefined vs `{}` / 数组顺序敏感性） |
| 单元（sub-bug 修复） | `/switch` `/new` 后 `convRepo.touch` 被调用一次；`/exit` 走 `rl.close()` 触发 close 监听器 |
| 集成（REPL → session） | REPL 启动用 `RuntimeSession.create` 替代散落 const；所有 slash 命令行为不变（/help /status /usage /model 等回归）；`/config` completed 后 `session.runtime` 指向新 instance |
| 集成（hot reload 端到端） | 临时 HOME：用户初始 config → 进入 REPL → 触发 `/config` → 修改 model → 完成 → 下条消息验证用新 model；同样验证修改 channel；同样验证修改 displayName（重建 systemPrompt） |
| 集成（PermissionStore 跨 swap） | 用户授予 session scope "本次允许 web_fetch" → reload → 同一调用不再 prompt（store ref 复用） |
| 集成（in-flight turn 等待） | reload 流程在 turn 跑中触发的并发场景（mock 长 turn）→ reload 等到 turn 完成才 swap |
| 安全 | 错误消息中**不含** apiKey / channel secret（fuzz 含 `sk-` 前缀输入，扫错误路径输出）；`bi-zhixing-credentials-block` 命中规则不变 |
| E2E | 真实 zhixing CLI：从空状态走 bootstrap → 改 model → 走 `/config` 改 model → 验证下条消息生效；channel 长连接（feishu websocket / telegram）改 model 不重建时不闪断 |

## 十二、移除项

落地本规格时，以下当前实现需要移除（避免架构债务）：

| 项 | 处置 |
|---|---|
| `repl.ts` 顶层散落的 `agentRuntime` `schedulerInstance` `channels` `deliveryStack` const/let 声明 | 全部删除——由 `session: RuntimeSession` 替代 |
| `repl.ts` 散落的 `setupChannels` / `setupDelivery` / `createAgentRuntime` / `new Scheduler` 调用链 | 移入 `RuntimeSession.create()` 内部 |
| `/exit` handler 内的 `scheduler.stop()` + `process.exit(0)` | 改为 `rl.close()`；cleanup 移入 close 监听器 |
| `rl.on("close")` 内散落的 `scheduler.stop()` + `deliveryStack.stop()` + `channels.dispose()` 调用链 | 替换为 `await session.dispose()` |
| 临时变量 `let schedulerInstance: Scheduler \| null = null;` 等局部 mutable 状态 | 收敛到 RuntimeSession 内部 instance fields |

**不移除**：
- `scheduleTool` / `runAgentTurn` / `SchedulerProvider` 的 closure getter 模式——这是 session 内部继续使用的基础设施
- `convRepo.touch` 在 commitTurn 后的现有调用——sub-bug 修复是新增调用点，不替换

## 十三、分阶段迁移

代码迁移路径——每阶段独立可回滚、可测试，降低 god module 重构风险：

| 阶段 | 内容 | 验证 |
|---|---|---|
| **1. Sub-bug 修复**（独立 PR） | `/switch` `/new` 加 `convRepo.touch()`；`/exit` 改走 `rl.close()` 路径 | 现有 REPL 行为不变 + auto-resume 选对最近对话 |
| **2. 引入 RuntimeSession 类**（独立 PR） | 新建 `packages/cli/src/runtime/session.ts`；REPL 启动改用 `RuntimeSession.create()` 替代散落 const；**`dispose` 必须实施**（替换 `rl.on("close")` 现有 cleanup chain，不可延后——否则 PR 合入即破坏 REPL 退出）；`reload` 接口可暂 throw `"not implemented"` 留待阶段 4 | 现有 REPL 行为不变；slash 命令全部回归通过；REPL 退出走 `session.dispose()` 完整 cleanup |
| **3. PermissionStore 注入**（独立 PR） | `CreateAgentRuntimeOptions.permissionStore?` 添加；RuntimeSession.create 创建并注入 | 单元测试覆盖 optional 参数向后兼容；权限授权行为不变 |
| **4. 实现 reload 流程**（独立 PR） | `RuntimeSession.reload()` 完整实现 + diff + 事务性 + 后台 dispose；REPL 状态机加 `activeTurnPromise` | 集成测试覆盖 hot reload 端到端 |
| **5. /config slash 命令**（独立 PR） | `buildSlashCommands` 加 handler；`REPL_COMMANDS` 加条目；handler 调 `session.reload()` | E2E 测试覆盖 `/config` 修改 + 透明性反馈 |

每阶段独立 PR、独立测试覆盖、独立可回滚——降低重构风险。

## 十四、不在范围内（Out of Scope）

- **deep link**（`/config provider.aibang.model` 直达）——扩展点已识别（`ConfigEditorContext.initialPanel?`），等加 `/model` 快捷直达再做
- **`/model` 等高频快捷直达 slash**——等真实使用证据出现再加
- **`/restart` 命令**——重启是退步 UX，明确不引入
- **CLI 子命令 `zhixing config`**——不可发现，否决
- **文件 watch 自动 reload**——当前仅 `/config completed` 触发；未来扩展通过同一 `reload()` 入口
- **server 模式 hot reload**——本规格仅 REPL；server 触发与反馈不同，单独 spec
- **多 reload 并发**——`/config` 模态接管 stdin，不可能并发；未来扩展触发源时再考虑 mutex
- **`AgentRuntime.dispose()` 接口**——内部全 in-memory（securityPipeline / boundaryRegistry / turnContextInjector / memoryStore / estimator），replace ref 后 GC 自然回收，不增加冗余接口
- **`Scheduler.setDelivery` / `Scheduler.swapTaskRunner` 等内部状态切换接口**——blue-green swap 不需要，避免破坏 immutable 契约
- **`tools-builtin/web-fetch` proxy 改 getter**——blue-green swap 不需要 hot field reload，跨包 API 零侵入

## 十五、引用

- 协同 spec：[`credentials-and-onboarding.md`](credentials-and-onboarding.md)（`runConfigEditor` 五级面板架构 + sections 注册 + writers 接口）· [`input-typeahead.md`](input-typeahead.md)（slash 命令双轨制注册）· [`security-system.md`](security-system.md)（`PermissionStore` / `ConfirmationBroker` 设施）· [`subagent-execution.md`](subagent-execution.md)（Task 工具的 closure capture 模式）
- 协同 ADR：[ADR-005 CLI 架构](../architecture/decisions/005-cli-architecture.md) · [ADR-006 安全系统架构](../architecture/decisions/006-security-system-architecture.md) · [ADR-008 身份与引导层](../architecture/decisions/008-identity-bootstrap-layer.md)
- 上下文：[`research/design/problems/repl-config-and-hot-reload.md`](../problems/repl-config-and-hot-reload.md)
