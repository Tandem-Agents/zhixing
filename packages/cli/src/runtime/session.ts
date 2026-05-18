/**
 * RuntimeSession——REPL 协同生命周期资源 owner。
 *
 * 聚合 agentRuntime / scheduler / deliveryStack / channels 的 create / reload / dispose，
 * 让 REPL 主回路只关心业务流程（用户输入 / turn 状态 / 对话历史），不感知运行时资源装配。
 *
 * 设计要点：
 * - `runtime` / `scheduler` 是 getter——每次访问读最新 instance，配合 closure getter 模式
 *   让 scheduleTool / runAgentTurn / SchedulerProvider 在 swap 后自动指向新值
 * - dispose 顺序硬约束：scheduler 持有 delivery ref → 旧 scheduler stop 完成之后才能
 *   dispose 旧 deliveryStack / channels，反序会 use-after-dispose
 * - confirmationRenderer 通过 attach/detach 模式与 ConfirmationBroker 解耦，跨 reload
 *   re-attach 到新 broker
 * - PermissionStore 跨 swap 复用——保留用户 session scope 授权（"本次会话允许"）不丢
 * - reload 串行：mutex 防并发；dispose 后调用 reload 返回 failed
 */

import chalk from "chalk";
import {
  Scheduler,
  JsonTaskStore,
  userMessage,
  FsWorkSceneRegistry,
  type ChannelRegistry,
  type AgentTurnResult,
  type IPermissionStore,
  type IWorkSceneRegistry,
  type WorkScene,
  type WorkModeSwitchIntent,
} from "@zhixing/core";
import {
  createAgentRuntime,
  runContextStorage,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { IWorkModeController } from "./work-mode-controller.js";
import { powerProfile } from "@zhixing/orchestrator/profile";
import type { TaskListService } from "@zhixing/tools-builtin";
import { registerCliTurnContextProviders } from "./turn-context-providers.js";
import {
  loadConfig,
  loadCredentials,
  resolveHomeDir,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import { setupChannels } from "../serve/channels.js";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";
import { createRenderSubscribers } from "../render.js";
import type { TerminalConfirmationRenderer } from "../security/index.js";
import type { RuntimeSessionOptions, ReloadResult } from "./types.js";
import { computeDiff, type DiffResult } from "./diff.js";
import { ReloadBuildError } from "./errors.js";

interface MessagingResources {
  channels: ChannelRegistry | undefined;
  deliveryStack: DeliveryStack | undefined;
}

interface BuildResult {
  /** true 时 messaging 域已重建——swap 用此标记决定是否替换 channels/delivery 字段（包括"重建为空"的场景） */
  channelsRebuilt: boolean;
  newChannels: ChannelRegistry | undefined;
  newDeliveryStack: DeliveryStack | undefined;
  newAgentRuntime: AgentRuntime | undefined;
  /**
   * 工作模式下 agent 域变化时连带重建的 power runtime —— 与 newAgentRuntime
   * 同事务构建/回滚，swap 时替换 workScene.runtime（main 与 power 两份运行态
   * 同步刷新到新配置，退出工作模式回 main 也是新配置）。非工作模式恒 undefined。
   */
  newPowerRuntime: AgentRuntime | undefined;
  newScheduler: Scheduler | undefined;
}

interface OldResources {
  scheduler: Scheduler | null;
  deliveryStack: DeliveryStack | null;
  channels: ChannelRegistry | null;
}

export class RuntimeSession implements IWorkModeController {
  // 持有的运行时资源——dispose 时释放。
  // agentRuntime 是常驻 main 槽位（reload blue-green swap 的目标）；
  // workScene 是工作模式 overlay（enter 时装入、exit 时丢弃 GC，power runtime
  // 无 dispose 接口、内部全 in-memory，失 ref 即回收）。runtime/activeMode
  // getter 在二者间路由；scheduler / broker / turn-context 等仍锚定 main，
  // 工作模式只切 agent loop runtime，不动这些主资源。
  private agentRuntime!: AgentRuntime;
  private workScene?: { sceneId: string; runtime: AgentRuntime };
  private schedulerInstance!: Scheduler;
  private channelsInstance: ChannelRegistry | undefined;
  private deliveryStackInstance: DeliveryStack | undefined;

  // 注入的配置/资源
  private readonly opts: RuntimeSessionOptions;

  // 当前已 load 的配置——下次 reload 时与磁盘新值 diff
  private config: ZhixingConfig;
  private credentials: ZhixingCredentials;

  // confirmation renderer 绑定状态——跨 reload re-attach 到新 broker
  private attachedRenderer: TerminalConfirmationRenderer | null = null;
  private currentBrokerDetach: (() => void) | null = null;

  // 工作场景登记单例 —— 纯 fs CRUD,无 async bootstrap / dispose,生命周期
  // 同 session。reload 重建 agentRuntime 不触碰它（注册表与运行时资源正交）；
  // 后续 enter/exit 工作模式与 cli /workscene 命令共用此同一实例。
  private readonly workSceneRegistryInstance: IWorkSceneRegistry =
    new FsWorkSceneRegistry();

  // 生命周期忙标志 —— reload / 工作模式 enter / exit 共享同一 guard：三者
  // 都是 turn 边界整体切换、互斥，忙时后到者拒绝（沿用"if(busy) 拒绝"模式，
  // 非排队 mutex）。
  private lifecycleBusy = false;
  private disposed = false;

  private constructor(opts: RuntimeSessionOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.credentials = opts.credentials;
  }

  static async create(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const session = new RuntimeSession(opts);
    await session.bootstrap();
    return session;
  }

  /** 装配所有运行时资源——首次创建路径，与 reload 重建路径共用 helper */
  private async bootstrap(): Promise<void> {
    // bootstrap 下 messaging setup 失败 non-fatal——降级为无 channel 的 REPL 让用户至少能用主对话。
    // reload 路径不走这层包装：错误传播到事务性回滚，保留旧 channels 不动避免 silent regression。
    let messaging: MessagingResources;
    try {
      messaging = await this.setupMessaging(this.config, this.credentials);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        chalk.yellow(`  [channel] Setup failed (non-fatal): ${errMsg}`),
      );
      messaging = { channels: undefined, deliveryStack: undefined };
    }
    this.channelsInstance = messaging.channels;
    this.deliveryStackInstance = messaging.deliveryStack;

    // 首次创建不传 existingPermissionStore——让 createAgentRuntime 内部 new + 注册 builtin 规则
    this.agentRuntime = await this.createAgent({ kind: "main" });

    this.schedulerInstance = this.createScheduler(
      this.deliveryStackInstance?.delivery,
    );

    // builtin TurnContextProvider 装配（SchedulerProvider + TaskListProvider）经
    // 单一注册源 —— scheduler 重建（channels 域）后 provider 自动指向新 instance；
    // task_list 通过 ALS 取 conversationId + service.cache 同步读，ephemeral 路径
    // 自然降级（空列表 → 整段跳过）。
    this.attachTurnContextProviders(this.agentRuntime);

    await this.schedulerInstance.start();
  }

  /** 装配 channels + deliveryStack——messaging 配置缺失时返回空对 */
  private async setupMessaging(
    config: ZhixingConfig,
    credentials: ZhixingCredentials,
  ): Promise<MessagingResources> {
    if (!config.messaging || Object.keys(config.messaging).length === 0) {
      return { channels: undefined, deliveryStack: undefined };
    }

    const channelLogger = {
      debug: (msg: string, ...args: unknown[]) =>
        console.log(chalk.dim(`  [channel] ${msg}`), ...args),
      info: (msg: string, ...args: unknown[]) =>
        console.log(chalk.dim(`  [channel] ${msg}`), ...args),
      warn: (msg: string, ...args: unknown[]) =>
        console.warn(chalk.yellow(`  [channel] ${msg}`), ...args),
      error: (msg: string, ...args: unknown[]) =>
        console.error(chalk.red(`  [channel] ${msg}`), ...args),
    };

    let channels: ChannelRegistry | undefined;
    try {
      const result = await setupChannels({
        entries: config.messaging,
        credentials,
        logger: channelLogger,
      });
      channels = result.registry;

      const deliveryStack = await setupDelivery({
        channels,
        zhixingHome: this.opts.zhixingHome,
        logger: {
          info: (msg) => console.log(chalk.dim(`  ${msg}`)),
          warn: (msg) => console.warn(chalk.yellow(`  ${msg}`)),
          error: (msg) => console.error(chalk.red(`  ${msg}`)),
        },
      });
      return { channels, deliveryStack };
    } catch (err) {
      // setupChannels 成功后 setupDelivery 失败时，channels 已分配——dispose 防 leak 再向上抛。
      // 错误语义归属是 caller：bootstrap 路径包 try/catch 保持 non-fatal；reload 路径不包，
      // 错误自然传播到 buildNewResources 的事务性回滚（旧 channels 保持不动）。
      if (channels) {
        await channels.dispose().catch(() => {});
      }
      throw err;
    }
  }

  /**
   * 装配 agentRuntime——通过 existingPermissionStore 跨 swap 复用授权 store。
   *
   * 不传时 createAgentRuntime 内部 new 一个新 store + 注册 builtin 规则；
   * 传时复用注入实例，跳过内部 register（store 已 init 过 builtin）。
   */
  private async createAgent(
    spec: { kind: "main" } | { kind: "workscene"; scene: WorkScene },
    existingPermissionStore?: IPermissionStore,
  ): Promise<AgentRuntime> {
    const isWorkscene = spec.kind === "workscene";

    // extra tools 装配走 assembly —— scheduler getter 用 closure 读 this.schedulerInstance，
    // swap 后自动响应；task_list 工具内部通过 ALS 拿 conversationId（assembly 已封装）。
    // workmode 工具组按 spec.kind 二分注入：main 组（enter/change_approve/
    // memory_query）vs power 组（exit）。workModeController getter 延迟取 this
    // （assembly 早于 session 构造，与 scheduler getter 同构）——RuntimeSession
    // 实现 IWorkModeController，工具只依赖窄接口、可独立单测。
    const extraTools = this.opts.builtinExtraTools.assembleTools({
      scheduler: () => {
        if (!this.schedulerInstance) {
          throw new Error("Scheduler not initialized yet");
        }
        return this.schedulerInstance;
      },
      spec: { kind: isWorkscene ? "workscene" : "main" },
      workModeController: () => this,
    });

    return await createAgentRuntime({
      // 工作模式与 cli 会话级覆盖正交 —— 工作场景 runtime 不透传 cli override；
      // primaryRole=power 选 power 角色；记忆域 = 该场景；profile = powerProfile；
      // workspace：有 workdir 用之，无 workdir 显式 null（source:"none"，
      // 无文件根）。main 路径维持原样（缺省 primaryRole/memoryScope/profile，
      // createAgentRuntime 内部回退 main/personal/mainProfile）。
      model: isWorkscene ? undefined : this.opts.cliModel,
      provider: isWorkscene ? undefined : this.opts.cliProvider,
      workspace: isWorkscene
        ? (spec.scene.workdir ?? null)
        : this.opts.cliWorkspace,
      primaryRole: isWorkscene ? "power" : undefined,
      memoryScope: isWorkscene
        ? { kind: "workscene", sceneId: spec.scene.id }
        : undefined,
      profile: isWorkscene ? powerProfile(spec.scene) : undefined,
      extraTools,
      decorateRunBus: createRenderSubscribers({
        renderer: this.opts.renderer,
        writer: this.opts.writer,
        screen: this.opts.screen,
      }),
      onSecurityBlocked: this.opts.onSecurityBlocked,
      onUserDenied: this.opts.onUserDenied,
      permissionStore: existingPermissionStore,
      segmentDeps: this.opts.segmentDeps,
    });
  }

  /**
   * 把 cli 装配层 builtin TurnContextProvider（Scheduler + TaskList）注册到
   * 一个 runtime —— 所有 user-facing runtime 装配点的单一注册源。
   *
   * deps closure 单点持有：getSchedulerStatus 读 this.schedulerInstance（scheduler
   * 重建后自动指向新 instance）、taskListService 取 assembly 单例。bootstrap /
   * reload main / 工作模式 enter / reload power 四个装配点全部经此方法，杜绝
   * "某入口漏注册"类不对齐回归（与 helper 文件的对齐契约一致）。
   */
  private attachTurnContextProviders(runtime: AgentRuntime): void {
    registerCliTurnContextProviders(runtime, {
      getSchedulerStatus: () => this.schedulerInstance.getStatusSummary(),
      taskListService: this.opts.builtinExtraTools.taskListService,
    });
  }

  /**
   * 装配 scheduler——runAgentTurn 通过 this.agentRuntime closure 自动响应 swap。
   * delivery 是 value capture（Scheduler 公共 API 无 setDelivery），所以 channels 域
   * 重建时必须重建 scheduler 拿新 delivery ref。
   *
   * Logger 注入策略：
   *
   *   info 静默——启动 chrome 之前不应被日志污染；任务执行进度由 spinner 渲染，
   *   完成事件由 schedulerEventBus 的 task-completed 推送给 REPL 渲染。logger.info
   *   是子系统内部诊断输出，不属于"用户该看到的东西"。
   *
   *   warn / error 保留 console 兜底——当前 schedulerEventBus 事件不覆盖
   *   delivery-enqueue-failed / invalid-cron-expression / shutdown-timeout 等
   *   子告警，全 no-op 会让用户错过"任务执行成功但消息没投到"这类静默失败。
   *   这两类告警升级为 EventBus 专属事件后 logger 才能完全 no-op。
   */
  private createScheduler(
    delivery: DeliveryStack["delivery"] | undefined,
  ): Scheduler {
    const writer = this.opts.writer;
    return new Scheduler({
      store: new JsonTaskStore(),
      runAgentTurn: this.makeRunAgentTurn(),
      eventBus: this.opts.schedulerEventBus,
      delivery,
      logger: {
        info: () => {},
        warn: (msg, data) =>
          writer.notify(
            `${chalk.yellow(`  [scheduler] ${msg}`)} ${data ? chalk.dim(JSON.stringify(data)) : ""}`,
          ),
        error: (msg, data) =>
          writer.notify(
            `${chalk.red(`  [scheduler] ${msg}`)} ${data ? chalk.dim(JSON.stringify(data)) : ""}`,
          ),
        debug: () => {},
      },
    });
  }

  /**
   * runAgentTurn 工厂——返回的 closure 通过 this.agentRuntime 读最新 ref。
   * scheduler 重建时调用此工厂得新 closure；agent swap 时旧 closure 自动指向新 agent。
   */
  private makeRunAgentTurn(): (params: {
    prompt: string;
    model?: string;
    tools?: string[];
    abortSignal?: AbortSignal;
    context?: "scheduled-task";
  }) => Promise<AgentTurnResult> {
    return async (params) => {
      const startTime = Date.now();
      try {
        const taskPrompt =
          params.context === "scheduled-task"
            ? `[系统] 这是一个定时任务的自动执行。请直接执行以下指令并输出结果，不要反问用户、不要引导对话。\n\n${params.prompt}`
            : params.prompt;
        const result = await this.agentRuntime.run({
          messages: [userMessage(taskPrompt)],
          turnIndex: 0,
        });
        const output = result.newMessages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.content)
          .filter(
            (b): b is { type: "text"; text: string } => b.type === "text",
          )
          .map((b) => b.text)
          .join("\n");

        return {
          status: result.agentResult.reason === "completed" ? "ok" : "error",
          output: output || undefined,
          error:
            result.agentResult.reason === "error"
              ? result.agentResult.error.message
              : undefined,
          durationMs: result.durationMs,
        };
      } catch (err: unknown) {
        return {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startTime,
        };
      }
    };
  }

  /**
   * 当前活动 runtime —— REPL 唯一 agent 访问点。工作模式 overlay 优先，
   * 否则 main 槽位（reload swap 自动指向新 main）。
   */
  get runtime(): AgentRuntime {
    return this.workScene?.runtime ?? this.agentRuntime;
  }

  /**
   * 当前活动模式 —— 个人记忆维护（journal condense 等）的单一判定源：
   * 个人记忆域只在 main 模式触达，工作场景模式记忆域是 workscene，绝不能
   * 跑个人 journal（单向阀）。反映 workScene overlay：进入工作模式即
   * workscene，退出即 main —— journal-gate 判定点零改动自动随动。
   */
  get activeMode(): { kind: "main" } | { kind: "workscene"; sceneId: string } {
    return this.workScene
      ? { kind: "workscene", sceneId: this.workScene.sceneId }
      : { kind: "main" };
  }

  /** 当前 scheduler 实例——swap 后自动指向新值 */
  get scheduler(): Scheduler {
    return this.schedulerInstance;
  }

  /**
   * task_list 服务实例 —— 跨 reload 单例，cli 主线程在 conversation 切换 /
   * `/clear` 时直接调 prime() / clear() 维护 cache。assembly 持有 store，service
   * 跨 swap 持续。
   */
  get taskListService(): TaskListService {
    return this.opts.builtinExtraTools.taskListService;
  }

  /**
   * 工作场景登记单例 —— cli /workscene 命令与后续 enter/exit 工作模式
   * 共用，唯一写入入口，跨 reload 持续。
   */
  get workSceneRegistry(): IWorkSceneRegistry {
    return this.workSceneRegistryInstance;
  }

  // ─── IWorkModeController 实现 ───
  //
  // workmode agent 工具经此窄接口与 session 交互（解循环引用 + 可独立单测）。
  // registry 与 workSceneRegistry 同一实例：后者是 cli 命令既有访问名，前者
  // 是工具侧的接口契约名，单一底层字段、无分叉。

  get registry(): IWorkSceneRegistry {
    return this.workSceneRegistryInstance;
  }

  /**
   * emit 模式切换意图到当前 run 的 EventBus —— 经 runContextStorage（与
   * task_list 工具取 conversationId 同款 ALS 机制）拿 per-run bus。只 emit
   * 不执行切换；非 run 上下文（无 bus，如装配期/单测）下静默 no-op。
   */
  emitModeSwitch(intent: WorkModeSwitchIntent): void {
    runContextStorage
      .getStore()
      ?.bus.emit("workmode:switch_requested", intent);
  }

  /**
   * 把 confirmation renderer attach 到当前 broker。
   *
   * session 持有 renderer ref 与当前 detach handle；reload 重建 agentRuntime 时
   * 内部自动 detach 旧 broker、attach 到新 broker，调用方无感。
   *
   * 返回 outer detach——调用方退出时调用，session 释放绑定。
   */
  attachConfirmationRenderer(
    renderer: TerminalConfirmationRenderer,
  ): () => void {
    if (this.attachedRenderer) {
      throw new Error(
        "RuntimeSession already has a confirmation renderer attached",
      );
    }
    this.attachedRenderer = renderer;
    this.currentBrokerDetach = renderer.attach(
      this.agentRuntime.confirmationBroker,
    );

    return () => {
      this.currentBrokerDetach?.();
      this.currentBrokerDetach = null;
      this.attachedRenderer = null;
    };
  }

  /**
   * 把已绑定的 confirmation renderer 从旧 broker 切到 target runtime 的
   * broker。reload（agent 重建带新 broker）与工作模式 enter/exit（runtime
   * overlay 切换）统一走此方法，消除"内联 vs 方法"两套实现。
   *
   * 未 attach renderer（serve / 测试等无终端确认路径）时整体 no-op —— 切
   * broker 无意义。与 attachConfirmationRenderer 的"首次 attach throw"守卫
   * 互不干扰：那个守卫只管首次绑定，broker 切换不经它（detach 旧 → attach
   * 新，attachedRenderer 引用不变）。
   */
  private swapConfirmationBroker(target: AgentRuntime): void {
    if (!this.attachedRenderer) return;
    this.currentBrokerDetach?.();
    this.currentBrokerDetach = this.attachedRenderer.attach(
      target.confirmationBroker,
    );
  }

  /**
   * 进入工作模式 —— 装入 power runtime overlay。
   *
   * 内部构件，不自管 lifecycle guard（由顶层 applyModeSwitch / reload 持有
   * 同一 guard，自管会与上层持锁双重 set / 误拒）。原子契约：装配中途抛错
   * 绝不 set workScene —— 唯一可抛点是 createAgent（在 broker swap 之前，
   * 失败即 main 态完好）；attachTurnContextProviders 同步非抛、touch 是非关键
   * lastActiveAt（best-effort 不阻断不污染）、broker swap 后紧随的纯赋值不可能
   * 失败。power runtime 与 main 同为 user-facing 主循环，须挂同款 turn-context
   * provider。permissionStore 跨实例复用（与 reload 同款，session scope 授权不丢）。
   */
  async enterWorkMode(sceneId: string): Promise<void> {
    const scene = await this.workSceneRegistry.get(sceneId);
    if (!scene) {
      throw new Error(`工作场景 "${sceneId}" 不存在`);
    }
    const powerRuntime = await this.createAgent(
      { kind: "workscene", scene },
      this.agentRuntime.permissionStore,
    );
    this.attachTurnContextProviders(powerRuntime);
    await this.workSceneRegistry.touch(sceneId).catch(() => {});
    this.swapConfirmationBroker(powerRuntime);
    this.workScene = { sceneId, runtime: powerRuntime };
  }

  /**
   * 退出工作模式 —— broker 切回 main、丢弃 overlay（power runtime 无 dispose
   * 接口、内部全 in-memory，失 ref 即 GC）。非工作模式时幂等 no-op。同为
   * 内部构件，不自管 lifecycle guard。
   */
  async exitWorkMode(): Promise<void> {
    if (!this.workScene) return;
    this.swapConfirmationBroker(this.agentRuntime);
    this.workScene = undefined;
  }

  /**
   * Reload 配置——读最新 config/credentials，按 diff 重建对应资源域，swap fields，
   * 后台 dispose 旧资源。
   *
   * 调用方语义：caller 在调本方法之前应先 await 当前 in-flight turn 完成（session
   * 不内嵌 turn 等待——边界清晰，session 不读 REPL state）。
   *
   * 串行：mutex 防止并发触发；dispose 后调用返回 failed。
   */
  /**
   * 尝试进入生命周期互斥区 —— reload 与工作模式 enter/exit 共享同一 guard
   * 的唯一获取入口（互斥状态只在此 set、endLifecycleOp 唯一 clear，单一代码
   * 路径）。已 dispose 或已有操作进行中返回 false，调用方应放弃并提示（忙时
   * 后到者拒绝，非排队 mutex）。reload 在 REPL 内部经此原语；applyModeSwitch
   * 在 REPL 主回路经此原语，二者天然互斥。
   */
  tryBeginLifecycleOp(): boolean {
    if (this.disposed) return false;
    if (this.lifecycleBusy) return false;
    this.lifecycleBusy = true;
    return true;
  }

  /** 离开生命周期互斥区 —— 与 tryBeginLifecycleOp 成对，finally 中调用。 */
  endLifecycleOp(): void {
    this.lifecycleBusy = false;
  }

  async reload(): Promise<ReloadResult> {
    if (this.disposed) {
      return {
        kind: "failed",
        error: new Error("RuntimeSession already disposed"),
      };
    }
    // disposed 已在上方以专属错误消息拦截，此处 tryBegin 仅会因 busy 失败。
    if (!this.tryBeginLifecycleOp()) {
      return {
        kind: "failed",
        error: new Error("reload already in progress"),
      };
    }

    try {
      const newConfig = loadConfig({ cwd: process.cwd() });
      const newCredentials = loadCredentials({ homeDir: resolveHomeDir() });

      const diff = computeDiff(
        this.config,
        this.credentials,
        newConfig,
        newCredentials,
      );
      if (diff.kind === "no-change") {
        return { kind: "no-change" };
      }

      let built: BuildResult;
      try {
        built = await this.buildNewResources(newConfig, newCredentials, diff);
      } catch (err) {
        return {
          kind: "failed",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }

      // ConfirmationBroker re-attach（仅 agent 重建时——新 runtime 带新 broker）。
      // broker 只跟当前 active runtime：工作模式下 active=power，故重建 power 时
      // 把 broker 切到新 power（而非新 main）；非工作模式切到新 main。走统一
      // 方法（内部对未 attach renderer 自然 no-op，等价原 && 守卫）。
      if (built.newPowerRuntime && this.workScene) {
        this.swapConfirmationBroker(built.newPowerRuntime);
      } else if (built.newAgentRuntime) {
        this.swapConfirmationBroker(built.newAgentRuntime);
      }

      // Snapshot 旧资源用于后台 dispose
      const old: OldResources = {
        scheduler: built.newScheduler ? this.schedulerInstance : null,
        deliveryStack: built.channelsRebuilt
          ? (this.deliveryStackInstance ?? null)
          : null,
        channels: built.channelsRebuilt
          ? (this.channelsInstance ?? null)
          : null,
      };

      // Swap fields——新资源全部活跃后所有 closure getter 自动指向新值
      if (built.newAgentRuntime) {
        this.agentRuntime = built.newAgentRuntime;
      }
      // 工作模式下连带 swap power（保 sceneId，只换 runtime 实例）——getter
      // runtime()=workScene.runtime 随之指向新 power；REPL 侧 ConversationRuntimeState
      // 不受影响（reload 只换 runtime 实例、不碰对话运行态，两份运行态不丢）。
      if (built.newPowerRuntime && this.workScene) {
        this.workScene = {
          ...this.workScene,
          runtime: built.newPowerRuntime,
        };
      }
      if (built.newScheduler) {
        this.schedulerInstance = built.newScheduler;
      }
      if (built.channelsRebuilt) {
        this.channelsInstance = built.newChannels;
        this.deliveryStackInstance = built.newDeliveryStack;
      }
      this.config = newConfig;
      this.credentials = newCredentials;

      // 后台 dispose 旧资源（不阻塞 reload Promise——用户立即看到反馈）
      if (old.scheduler || old.deliveryStack || old.channels) {
        void this.disposeOldInBackground(old);
      }

      return { kind: "applied", changedDomains: diff.changedDomains };
    } finally {
      this.endLifecycleOp();
    }
  }

  /**
   * 事务性构建新资源——任一步失败回滚已分配的部分，throw ReloadBuildError；
   * 旧 session 保持不动。
   *
   * 重建条件：
   * - channels 域变化 → 重建 channels + deliveryStack + scheduler（Scheduler 公共 API
   *   无 setDelivery，必须重建拿新 delivery ref）
   * - agent 域变化 → 仅重建 agentRuntime（旧 scheduler 的 runAgentTurn closure 通过
   *   this.agentRuntime 自动响应 swap，不必跟随重建）
   */
  private async buildNewResources(
    newConfig: ZhixingConfig,
    newCredentials: ZhixingCredentials,
    diff: DiffResult,
  ): Promise<BuildResult> {
    let newChannels: ChannelRegistry | undefined;
    let newDeliveryStack: DeliveryStack | undefined;
    let newAgentRuntime: AgentRuntime | undefined;
    let newPowerRuntime: AgentRuntime | undefined;
    let newScheduler: Scheduler | undefined;
    let channelsRebuilt = false;

    try {
      if (diff.channelsChanged) {
        const messaging = await this.setupMessaging(newConfig, newCredentials);
        newChannels = messaging.channels;
        newDeliveryStack = messaging.deliveryStack;
        channelsRebuilt = true;

        newScheduler = this.createScheduler(newDeliveryStack?.delivery);
        await newScheduler.start();
      }

      if (diff.agentChanged) {
        // 跨 swap 复用 PermissionStore——保留 session scope 授权
        newAgentRuntime = await this.createAgent(
          { kind: "main" },
          this.agentRuntime.permissionStore,
        );

        // 注册 builtin TurnContextProvider 到新 agent —— 与 bootstrap 同源
        this.attachTurnContextProviders(newAgentRuntime);

        // 工作模式下连带重建 power —— main 与 power 两份运行态都要刷到新配置
        // （否则退出工作模式回 main 用新配置、但工作模式中 power 仍旧配置）。
        // scene 从 registry 重读（workdir/memoryScope 取最新）；createAgent
        // workscene 分支内部 primaryRole=power、roles 经 createProviderRoles
        // 重解析新 config（与 main 重建同机制）；复用 power 自身 permissionStore
        // 保 session scope 授权。scene 已被移除（极端边界）则 throw → 整体 build
        // 失败回滚、旧 power 完好。
        if (this.workScene) {
          const scene = await this.workSceneRegistry.get(
            this.workScene.sceneId,
          );
          if (!scene) {
            throw new Error(
              `工作场景 "${this.workScene.sceneId}" 已不存在，无法在 reload 中重建 power`,
            );
          }
          newPowerRuntime = await this.createAgent(
            { kind: "workscene", scene },
            this.workScene.runtime.permissionStore,
          );
          this.attachTurnContextProviders(newPowerRuntime);
        }
      }

      return {
        channelsRebuilt,
        newChannels,
        newDeliveryStack,
        newAgentRuntime,
        newPowerRuntime,
        newScheduler,
      };
    } catch (err) {
      // 回滚：dispose 已分配的新资源，顺序硬约束（scheduler → delivery → channels）
      if (newScheduler) {
        await newScheduler.stop().catch(() => {});
      }
      if (newDeliveryStack) {
        await newDeliveryStack.stop().catch(() => {});
      }
      if (newChannels) {
        await newChannels.dispose().catch(() => {});
      }
      // newAgentRuntime / newPowerRuntime 无 dispose 接口——孤立后自然 GC
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new ReloadBuildError(
        `build failed during reload: ${cause.message}`,
        { cause },
      );
    }
  }

  /**
   * 后台 dispose 旧资源——顺序硬约束 + 单步失败仅 warn log 不阻塞用户。
   * reload Promise 在 swap 完成后立即 resolve，让用户立即看到反馈。
   */
  private async disposeOldInBackground(old: OldResources): Promise<void> {
    if (old.scheduler) {
      try {
        await old.scheduler.stop();
      } catch (err) {
        console.error(
          "[RuntimeSession.disposeOld] scheduler.stop failed:",
          err,
        );
      }
    }
    if (old.deliveryStack) {
      try {
        await old.deliveryStack.stop();
      } catch (err) {
        console.error(
          "[RuntimeSession.disposeOld] deliveryStack.stop failed:",
          err,
        );
      }
    }
    if (old.channels) {
      try {
        await old.channels.dispose();
      } catch (err) {
        console.error(
          "[RuntimeSession.disposeOld] channels.dispose failed:",
          err,
        );
      }
    }
    // 旧 agentRuntime 无 dispose 接口——失去 ref 后自然 GC
  }

  /**
   * 协同 cleanup——固定顺序避免 use-after-dispose（scheduler 持有 delivery ref）。
   * 每步独立 try/catch，单步失败仅记录日志，不阻塞后续步骤。
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    // 若在工作模式：先丢弃 workScene overlay（power runtime 无 dispose 接口、
    // 内部全 in-memory，失 ref 即 GC），再走现有 main 资源 dispose 链。
    this.workScene = undefined;

    // 先 detach renderer，防 dispose 后访问已释放的 broker
    this.currentBrokerDetach?.();
    this.currentBrokerDetach = null;
    this.attachedRenderer = null;

    try {
      await this.schedulerInstance.stop();
    } catch (err) {
      console.error("[RuntimeSession.dispose] scheduler.stop failed:", err);
    }

    if (this.deliveryStackInstance) {
      try {
        await this.deliveryStackInstance.stop();
      } catch (err) {
        console.error(
          "[RuntimeSession.dispose] deliveryStack.stop failed:",
          err,
        );
      }
    }

    if (this.channelsInstance) {
      try {
        await this.channelsInstance.dispose();
      } catch (err) {
        console.error(
          "[RuntimeSession.dispose] channels.dispose failed:",
          err,
        );
      }
    }
    // agentRuntime 无 dispose 接口——内部全 in-memory，replace ref 后自然 GC
  }
}
