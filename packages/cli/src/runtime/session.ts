/**
 * RuntimeSession——REPL 协同生命周期资源 owner。
 *
 * 聚合 agentRuntime（含工作模式 power overlay）的 create / reload / dispose，让 REPL 主回路
 * 只关心业务流程（用户输入 / turn 状态 / 对话历史），不感知运行时资源装配。调度权威在核心
 * 宿主、cli 是纯交互接入面——session 不持有本地 Scheduler / channels / deliveryStack，只
 * 借用注入的 schedulerFacade 接入宿主。
 *
 * 设计要点：
 * - `runtime` 是 getter——每次访问读最新 instance（reload blue-green swap 后自动指向新值；
 *   工作模式下优先 power overlay）。`scheduler` getter 返回注入的 schedulerFacade 单例——
 *   跨 reload 稳定、不随 swap 变（只有 agentRuntime swap）。
 * - dispose 顺序：work overlay 收尾 → detach confirmation renderer → 关 schedulerFacade
 *   连接 → main 运行体末窗 onWindowClose。
 * - confirmationRenderer 通过 attach/detach 模式与 ConfirmationBroker 解耦，跨 reload
 *   re-attach 到新 broker
 * - PermissionStore 跨 swap 复用——保留用户 session scope 授权（"本次会话允许"）不丢
 * - reload 串行：mutex 防并发；dispose 后调用 reload 返回 failed
 */

import chalk from "chalk";
import {
  FsWorkSceneRegistry,
  SkillStore,
  getSkillsRoot,
  type SchedulerFacade,
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
import { createRenderSubscribers } from "../render.js";
import { readSchedulerSummarySync } from "./scheduler-projection.js";
import type { TerminalConfirmationRenderer } from "../security/index.js";
import type { RuntimeSessionOptions, ReloadResult } from "./types.js";
import { computeDiff, type DiffResult } from "./diff.js";
import { parseServerSpecs } from "./mcp-config.js";
import { ReloadBuildError } from "./errors.js";

interface BuildResult {
  newAgentRuntime: AgentRuntime | undefined;
  /**
   * 工作模式下 agent 域变化时连带重建的 power runtime —— 与 newAgentRuntime
   * 同事务构建/回滚，swap 时替换 workScene.runtime（main 与 power 两份运行态
   * 同步刷新到新配置，退出工作模式回 main 也是新配置）。非工作模式恒 undefined。
   */
  newPowerRuntime: AgentRuntime | undefined;
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
  // 后续 enter/exit 工作模式与 cli /work 命令共用此同一实例。
  private readonly workSceneRegistryInstance: IWorkSceneRegistry =
    new FsWorkSceneRegistry();

  // 技能库 store 单例 —— 与 workSceneRegistry 同范式:纯 fs 访问、无 async
  // bootstrap / dispose、生命周期同 session。reload / 模式切换重建 agentRuntime 时
  // 经 createAgent 注入同一实例,使运行时(索引读 / load_skill)与 cli 侧(/<name>
  // 唤醒、技能管理面板)共享单一锁域,index.json 读改写跨面串行、不丢更新。
  private readonly skillStoreInstance: SkillStore = new SkillStore(
    getSkillsRoot(),
  );

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
    // cli 是纯交互接入面：不自起 Scheduler、不接通道——调度权威在核心宿主，
    // schedule 工具 / turn-context 经注入的 schedulerFacade 接入（懒拉起）。
    // 首次创建不传 existingPermissionStore——让 createAgentRuntime 内部 new + 注册 builtin 规则。
    this.agentRuntime = await this.createAgent({ kind: "main" });
    this.attachTurnContextProviders(this.agentRuntime);
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

    // extra tools 装配走 assembly —— scheduler getter 用 closure 读注入的 schedulerFacade
    //（跨 reload 稳定单例）；task_list 工具内部通过 ALS 拿 conversationId（assembly 已封装）。
    // workmode 工具组按 spec.kind 二分注入：main 组（enter/change_approve/
    // memory_query）vs power 组（exit）。workModeController getter 延迟取 this
    // （assembly 早于 session 构造，与 scheduler getter 同构）——RuntimeSession
    // 实现 IWorkModeController，工具只依赖窄接口、可独立单测。
    const extraTools = this.opts.builtinExtraTools.assembleTools({
      scheduler: () => this.opts.schedulerFacade,
      spec: { kind: isWorkscene ? "workscene" : "main" },
      workModeController: () => this,
    });

    return await createAgentRuntime({
      // 工作场景与 main 路径在此分叉：工作场景用 primaryRole=power 选 power
      // 角色、记忆域绑该场景、profile=powerProfile，workspace 有 workdir 用之、
      // 无 workdir 则显式 null（source:"none"，无文件根，by-construction 杜绝
      // 串到 cwd）。main 路径缺省 primaryRole/memoryScope/profile，
      // createAgentRuntime 内部回退 main/personal/mainProfile。
      workspace: isWorkscene
        ? (spec.scene.workdir ?? null)
        : this.opts.cliWorkspace,
      primaryRole: isWorkscene ? "power" : undefined,
      memoryScope: isWorkscene
        ? { kind: "workscene", sceneId: spec.scene.id }
        : undefined,
      profile: isWorkscene ? powerProfile(spec.scene) : undefined,
      // 注入会话级单一实例,与 cli 侧 /<name>、管理面板共享锁域(见字段注释)
      skillStore: this.skillStoreInstance,
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
   * getSchedulerStatus 读 scheduler.json 从属投影（cli 无本地 scheduler）；taskListService
   * 取 assembly 单例。bootstrap / reload main / 工作模式 enter / reload power 四个装配点
   * 全部经此方法，杜绝"某入口漏注册"类不对齐回归（与 helper 文件的对齐契约一致）。
   */
  private attachTurnContextProviders(runtime: AgentRuntime): void {
    registerCliTurnContextProviders(runtime, {
      getSchedulerStatus: () => readSchedulerSummarySync(),
      taskListService: this.opts.builtinExtraTools.taskListService,
    });
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

  /** 调度门面——cli 经它接入核心宿主。 */
  get scheduler(): SchedulerFacade {
    return this.opts.schedulerFacade;
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
   * 工作场景登记单例 —— cli /work 命令与后续 enter/exit 工作模式
   * 共用，唯一写入入口，跨 reload 持续。
   */
  get workSceneRegistry(): IWorkSceneRegistry {
    return this.workSceneRegistryInstance;
  }

  /**
   * 技能库 store 单例 —— cli 的 /<name> 唤醒(SkillCommandSource)与后续技能管理
   * 面板的访问名;与注入运行时的是同一实例,跨 reload / 模式切换持续。
   */
  get skillStore(): SkillStore {
    return this.skillStoreInstance;
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
   * 彻底删除工作场景的唯一入口（带 active 守卫）—— CLI `/work remove`
   * 与 LLM 工具 `workscene_change_approve action=remove` 都过这里。
   *
   * Guard：当前活跃 sceneId 与目标 id 相同时直接抛错。power runtime 正在
   * 用该场景的 me/ 与 conversations/ 目录,物理删除后续 memory 写入 /
   * task_list 持久化 / exit digest 全撞 ENOENT。
   *
   * 业务规则不下沉到 registry(机制策略分离)：registry 是低层 CRUD 原语，
   * 不该知道 activeMode；只有持 activeMode 的 session 能做这层 policy。
   */
  async removeWorkScene(id: string): Promise<void> {
    if (this.workScene?.sceneId === id) {
      throw new Error(
        `无法删除当前活跃的工作场景 "${id}" —— 请先 /exit 退出该场景再删除`,
      );
    }
    await this.workSceneRegistryInstance.remove(id);
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
    const work = this.workScene.runtime;
    this.swapConfirmationBroker(this.agentRuntime);
    // work 运行体末窗 onWindowClose —— overlay 丢弃即实例销毁,置 undefined 前
    // 触发（否则失 ref）。失败仅 warn,不阻断退出。
    try {
      await work.dispose("workmode-exit");
    } catch (err) {
      this.opts.writer.notify(
        chalk.yellow(
          `  ⚠ 退出工作模式时运行体收尾失败: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
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
      const newConfig = loadConfig();
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

      // Swap fields——新 agent 活跃后所有 closure getter 自动指向新值。旧 main /
      // power 运行体在 swap 前触发末窗 onWindowClose("reload-replace")。失败仅 warn。
      if (built.newAgentRuntime) {
        const oldAgent = this.agentRuntime;
        try {
          await oldAgent.dispose("reload-replace");
        } catch (err) {
          this.opts.writer.notify(
            chalk.yellow(
              `  ⚠ 旧运行体收尾失败: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        this.agentRuntime = built.newAgentRuntime;
      }
      // 工作模式下连带 swap power（保 sceneId，只换 runtime 实例）——getter
      // runtime()=workScene.runtime 随之指向新 power；REPL 侧 ConversationRuntimeState
      // 不受影响（reload 只换 runtime 实例、不碰对话运行态，两份运行态不丢）。
      if (built.newPowerRuntime && this.workScene) {
        const oldPower = this.workScene.runtime;
        try {
          await oldPower.dispose("reload-replace");
        } catch (err) {
          this.opts.writer.notify(
            chalk.yellow(
              `  ⚠ 旧运行体收尾失败: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        this.workScene = {
          ...this.workScene,
          runtime: built.newPowerRuntime,
        };
      }
      this.config = newConfig;
      this.credentials = newCredentials;

      return { kind: "applied", changedDomains: diff.changedDomains };
    } finally {
      this.endLifecycleOp();
    }
  }

  /**
   * 事务性构建新资源——任一步失败回滚已分配的部分，throw ReloadBuildError；
   * 旧 session 保持不动。
   *
   * cli 是纯交互接入面，只重建 agent 域（model / profile / MCP 变化）——调度 / 通道
   * 都在核心宿主，cli reload 不涉及。
   */
  private async buildNewResources(
    newConfig: ZhixingConfig,
    newCredentials: ZhixingCredentials,
    diff: DiffResult,
  ): Promise<BuildResult> {
    let newAgentRuntime: AgentRuntime | undefined;
    let newPowerRuntime: AgentRuntime | undefined;

    try {
      if (diff.agentChanged) {
        // MCP 连接增量重连 —— 在重建 agentRuntime 之前完成，新配置的工具目录才能物化
        // 进新 runtime 的 system prompt。MCP 未变时 applyConfig 据 specEqual 自然 no-op；
        // hub 跨 swap 存活、未变 server 不被打断。
        await this.opts.builtinExtraTools.mcpHub.applyConfig(
          parseServerSpecs(newConfig.mcp, newCredentials.mcp),
        );

        // 跨 swap 复用 PermissionStore——保留 session scope 授权
        newAgentRuntime = await this.createAgent(
          { kind: "main" },
          this.agentRuntime.permissionStore,
        );

        // 注册 builtin TurnContextProvider 到新 agent —— 与 bootstrap 同源
        this.attachTurnContextProviders(newAgentRuntime);

        // 工作模式下连带重建 power —— main 与 power 两份运行态都要刷到新配置
        // （否则退出工作模式回 main 用新配置、但工作模式中 power 仍旧配置）。
        // scene 从 registry 重读（workdir/memoryScope 取最新）；复用 power 自身
        // permissionStore 保 session scope 授权。scene 已被移除（极端边界）则 throw
        // → 整体 build 失败回滚、旧 power 完好。
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

      return { newAgentRuntime, newPowerRuntime };
    } catch (err) {
      // 回滚：已激活的新 main / power 运行体补末窗 onWindowClose("assembly-rollback")，
      // 否则其末窗永不触发。回滚路径吞错（已在抛 ReloadBuildError）。
      if (newAgentRuntime) {
        await newAgentRuntime.dispose("assembly-rollback").catch(() => {});
      }
      if (newPowerRuntime) {
        await newPowerRuntime.dispose("assembly-rollback").catch(() => {});
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new ReloadBuildError(
        `build failed during reload: ${cause.message}`,
        { cause },
      );
    }
  }

  /**
   * 协同 cleanup——dispose workScene / main 运行体 + 关闭调度门面连接。
   * 每步独立 try/catch，单步失败仅记录日志，不阻塞后续步骤。
   */
  async dispose(): Promise<void> {
    this.disposed = true;

    // 若在工作模式：先触发 work 运行体末窗 onWindowClose（dispose 前 workScene
    // 须仍在,否则失 ref）,再置空、走 main 资源 dispose 链。
    if (this.workScene) {
      const work = this.workScene.runtime;
      try {
        await work.dispose("session-dispose");
      } catch (err) {
        this.opts.writer.notify(
          chalk.yellow(
            `  ⚠ 运行体收尾失败: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      this.workScene = undefined;
    }

    // 先 detach renderer，防 dispose 后访问已释放的 broker
    this.currentBrokerDetach?.();
    this.currentBrokerDetach = null;
    this.attachedRenderer = null;

    // 关闭调度门面——断开 cli 与核心宿主的连接、清订阅。
    try {
      await this.opts.schedulerFacade.dispose?.();
    } catch (err) {
      console.error(
        "[RuntimeSession.dispose] schedulerFacade.dispose failed:",
        err,
      );
    }

    // main 运行体末窗 onWindowClose（销毁链最后一步）。失败仅 warn,不抛。
    try {
      await this.agentRuntime.dispose("session-dispose");
    } catch (err) {
      this.opts.writer.notify(
        chalk.yellow(
          `  ⚠ 运行体收尾失败: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}
