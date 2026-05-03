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
  SchedulerProvider,
  userMessage,
  type ChannelRegistry,
  type AgentTurnResult,
  type IPermissionStore,
} from "@zhixing/core";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import { createScheduleTool } from "@zhixing/tools-builtin";
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
  newScheduler: Scheduler | undefined;
}

interface OldResources {
  scheduler: Scheduler | null;
  deliveryStack: DeliveryStack | null;
  channels: ChannelRegistry | null;
}

export class RuntimeSession {
  // 持有的运行时资源——dispose 时释放
  private agentRuntime!: AgentRuntime;
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

  // 生命周期 flags
  private reloading = false;
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
    this.agentRuntime = await this.createAgent();

    this.schedulerInstance = this.createScheduler(
      this.deliveryStackInstance?.delivery,
    );

    // SchedulerProvider 通过 () => this.schedulerInstance 读最新 scheduler ref——
    // 即便 scheduler 重建（channels 域），provider 内部 closure 自动指向新 instance
    this.agentRuntime.registerTurnContextProvider(
      new SchedulerProvider(() => this.schedulerInstance.getStatusSummary()),
    );

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
    existingPermissionStore?: IPermissionStore,
  ): Promise<AgentRuntime> {
    // scheduleTool 通过 closure getter 读 this.schedulerInstance——swap 后自动响应
    const scheduleTool = createScheduleTool(() => {
      if (!this.schedulerInstance) {
        throw new Error("Scheduler not initialized yet");
      }
      return this.schedulerInstance;
    });

    return await createAgentRuntime({
      model: this.opts.cliModel,
      provider: this.opts.cliProvider,
      workspace: this.opts.cliWorkspace,
      extraTools: [scheduleTool],
      decorateRunBus: createRenderSubscribers(this.opts.renderer),
      onSecurityBlocked: this.opts.onSecurityBlocked,
      onUserDenied: this.opts.onUserDenied,
      enableTaskTool: true,
      permissionStore: existingPermissionStore,
    });
  }

  /**
   * 装配 scheduler——runAgentTurn 通过 this.agentRuntime closure 自动响应 swap。
   * delivery 是 value capture（Scheduler 公共 API 无 setDelivery），所以 channels 域
   * 重建时必须重建 scheduler 拿新 delivery ref。
   */
  private createScheduler(
    delivery: DeliveryStack["delivery"] | undefined,
  ): Scheduler {
    return new Scheduler({
      store: new JsonTaskStore(),
      runAgentTurn: this.makeRunAgentTurn(),
      eventBus: this.opts.schedulerEventBus,
      delivery,
      logger: {
        info: (msg, data) =>
          console.log(
            chalk.dim(`  [scheduler] ${msg}`),
            data ? chalk.dim(JSON.stringify(data)) : "",
          ),
        warn: (msg, data) =>
          console.log(
            chalk.yellow(`  [scheduler] ${msg}`),
            data ? chalk.dim(JSON.stringify(data)) : "",
          ),
        error: (msg, data) =>
          console.log(
            chalk.red(`  [scheduler] ${msg}`),
            data ? chalk.dim(JSON.stringify(data)) : "",
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

  /** 当前 agentRuntime 实例——swap 后自动指向新值 */
  get runtime(): AgentRuntime {
    return this.agentRuntime;
  }

  /** 当前 scheduler 实例——swap 后自动指向新值 */
  get scheduler(): Scheduler {
    return this.schedulerInstance;
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
   * Reload 配置——读最新 config/credentials，按 diff 重建对应资源域，swap fields，
   * 后台 dispose 旧资源。
   *
   * 调用方语义：caller 在调本方法之前应先 await 当前 in-flight turn 完成（session
   * 不内嵌 turn 等待——边界清晰，session 不读 REPL state）。
   *
   * 串行：mutex 防止并发触发；dispose 后调用返回 failed。
   */
  async reload(): Promise<ReloadResult> {
    if (this.disposed) {
      return {
        kind: "failed",
        error: new Error("RuntimeSession already disposed"),
      };
    }
    if (this.reloading) {
      return {
        kind: "failed",
        error: new Error("reload already in progress"),
      };
    }
    this.reloading = true;

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

      // ConfirmationBroker re-attach（仅 agent 重建时——新 agent 带新 broker）
      if (built.newAgentRuntime && this.attachedRenderer) {
        this.currentBrokerDetach?.();
        this.currentBrokerDetach = this.attachedRenderer.attach(
          built.newAgentRuntime.confirmationBroker,
        );
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
      this.reloading = false;
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
          this.agentRuntime.permissionStore,
        );

        // 注册 SchedulerProvider 到新 agent；closure 读 this.schedulerInstance 自动响应
        newAgentRuntime.registerTurnContextProvider(
          new SchedulerProvider(() =>
            this.schedulerInstance.getStatusSummary(),
          ),
        );
      }

      return {
        channelsRebuilt,
        newChannels,
        newDeliveryStack,
        newAgentRuntime,
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
      // newAgentRuntime 无 dispose 接口——孤立后自然 GC
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
