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
 *   re-attach 到新 broker（reload 实施时使用）
 */

import chalk from "chalk";
import {
  Scheduler,
  JsonTaskStore,
  SchedulerProvider,
  userMessage,
  type ChannelRegistry,
  type AgentTurnResult,
} from "@zhixing/core";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import { createScheduleTool } from "@zhixing/tools-builtin";
import { setupChannels } from "../serve/channels.js";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";
import { createRenderSubscribers } from "../render.js";
import type { TerminalConfirmationRenderer } from "../security/index.js";
import type { RuntimeSessionOptions, ReloadResult } from "./types.js";

export class RuntimeSession {
  // 持有的运行时资源——dispose 时释放
  private agentRuntime!: AgentRuntime;
  private schedulerInstance!: Scheduler;
  private channelsInstance: ChannelRegistry | undefined;
  private deliveryStackInstance: DeliveryStack | undefined;

  // 注入的配置/资源
  private readonly opts: RuntimeSessionOptions;

  // confirmation renderer 绑定状态——跨 reload re-attach 到新 broker
  private attachedRenderer: TerminalConfirmationRenderer | null = null;
  private currentBrokerDetach: (() => void) | null = null;

  private constructor(opts: RuntimeSessionOptions) {
    this.opts = opts;
  }

  static async create(opts: RuntimeSessionOptions): Promise<RuntimeSession> {
    const session = new RuntimeSession(opts);
    await session.bootstrap();
    return session;
  }

  /** 装配所有运行时资源——与 REPL 启动同路径 */
  private async bootstrap(): Promise<void> {
    const { config, credentials } = this.opts;

    // scheduleTool 通过 closure getter 读 this.schedulerInstance——swap 后自动响应
    const scheduleTool = createScheduleTool(() => {
      if (!this.schedulerInstance) {
        throw new Error("Scheduler not initialized yet");
      }
      return this.schedulerInstance;
    });

    this.agentRuntime = await createAgentRuntime({
      model: this.opts.cliModel,
      provider: this.opts.cliProvider,
      workspace: this.opts.cliWorkspace,
      extraTools: [scheduleTool],
      decorateRunBus: createRenderSubscribers(this.opts.renderer),
      onSecurityBlocked: this.opts.onSecurityBlocked,
      onUserDenied: this.opts.onUserDenied,
      // 主路径开启 Task 工具，让主 LLM 可派发子 agent 处理隔离任务
      enableTaskTool: true,
    });

    if (config.messaging && Object.keys(config.messaging).length > 0) {
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

      try {
        const result = await setupChannels({
          entries: config.messaging,
          credentials,
          logger: channelLogger,
        });
        this.channelsInstance = result.registry;

        this.deliveryStackInstance = await setupDelivery({
          channels: this.channelsInstance,
          zhixingHome: this.opts.zhixingHome,
          logger: {
            info: (msg) => console.log(chalk.dim(`  ${msg}`)),
            warn: (msg) => console.warn(chalk.yellow(`  ${msg}`)),
            error: (msg) => console.error(chalk.red(`  ${msg}`)),
          },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          chalk.yellow(`  [channel] Setup failed (non-fatal): ${errMsg}`),
        );
      }
    }

    this.schedulerInstance = new Scheduler({
      store: new JsonTaskStore(),
      runAgentTurn: this.makeRunAgentTurn(),
      eventBus: this.opts.schedulerEventBus,
      delivery: this.deliveryStackInstance?.delivery,
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

    // SchedulerProvider 通过 () => this.schedulerInstance.getStatusSummary() 读最新——
    // 跨 swap 自动响应（即便 scheduler 重建，provider 内部 closure 仍指向 this.schedulerInstance）
    this.agentRuntime.registerTurnContextProvider(
      new SchedulerProvider(() => this.schedulerInstance.getStatusSummary()),
    );

    await this.schedulerInstance.start();
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
   * 内部会自动 detach 旧 broker、attach 到新 broker，调用方无感。
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

  async reload(): Promise<ReloadResult> {
    throw new Error("RuntimeSession.reload not implemented yet");
  }

  /**
   * 协同 cleanup——固定顺序避免 use-after-dispose（scheduler 持有 delivery ref）。
   * 每步独立 try/catch，单步失败仅记录日志，不阻塞后续步骤。
   */
  async dispose(): Promise<void> {
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
