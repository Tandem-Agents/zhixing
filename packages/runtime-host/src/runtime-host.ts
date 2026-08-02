/**
 * RuntimeHost —— 宿主侧 runtime 装配点:共享装配资产单一持有,按消费者发放实例。
 *
 * 两层结构:
 * - 资产层(构造注入):技能库 / 段切换依赖 / extra tools assembly
 *   (含 MCP hub)/ 调度门面 getter / 渲染装饰与安全回调钩子——全部实例共享,
 *   是配置换代的单位。
 * - 实例层(按需发放):每个对话一个 runtime 实例——AgentRuntime 闭包持有窗口级
 *   状态,设计假定是服务单一对话的窗口序列,跨对话共享即互相践踏;定时任务路径
 *   发放 ephemeral 实例,同享资产层。实例所有权归调用方(会话适配层 / 任务执行
 *   器负责 dispose),host 只管装配。
 *
 * 对话级差异经执行期上下文取,不做装配期定制。schedule 工具只提交用户可控
 * TaskSpec；origin、responder 与创建 turn 由 owner 从已认证 ingress 反绑。
 *
 * onRuntimeCreated 是发放后的统一装配后置钩子(turn-context provider 注册等):
 * 会话与 ephemeral 两条发放路径都经此,杜绝"某入口漏注册"类不对齐。
 */

import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeCapacityBinding,
  type AgentRuntimeLifecycle,
  type CreateAgentRuntimeOptions,
  type RuntimeKind,
} from "@zhixing/orchestrator/runtime";
import { mainProfile, powerProfile } from "@zhixing/orchestrator/profile";
import type { SchedulerFacade } from "@zhixing/core";
import type { WorksceneDto } from "@zhixing/core/contracts";
import type { IConfirmationBroker } from "@zhixing/core";
import type { JobExecutionInstruction } from "@zhixing/core/contracts";
import type { BuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import type { WorksceneToolDirectory } from "./workscene-port.js";
import { ExecutionSchedulerFacade } from "./execution-scheduler-facade.js";

/** 从 createAgentRuntime 公共契约推导类型——避免依赖 orchestrator 内部路径 */
type DecorateRunBusFn = NonNullable<CreateAgentRuntimeOptions["decorateRunBus"]>;
type OnSecurityBlockedFn = NonNullable<
  CreateAgentRuntimeOptions["onSecurityBlocked"]
>;
type SegmentDepsOption = CreateAgentRuntimeOptions["segmentDeps"];
type SkillStoreOption = CreateAgentRuntimeOptions["skillStore"];
type ProviderConfigurationOption = CreateAgentRuntimeOptions["providerConfiguration"];
type ConfirmationLifecycleObserverOption =
  CreateAgentRuntimeOptions["confirmationLifecycleObserver"];

export interface JobAgentRuntimeOptions {
  readonly instruction: JobExecutionInstruction;
  readonly confirmationBroker: IConfirmationBroker;
}

export interface RuntimeHostOptions {
  /** 设备本地 SecretStore 的已解密内存投影，由产品组合根持有并注入。 */
  providerConfiguration: ProviderConfigurationOption;
  /** Durable interaction observer shared by all conversation runtime trees. */
  confirmationLifecycleObserver?: ConfirmationLifecycleObserverOption;
  /** 产品组合根持有的本机秘密路径，逐实例注入安全管线且不可由用户授权覆盖。 */
  systemProtectedPaths: readonly string[];
  /** 技能库单实例——索引结构版本跨全部实例一致,任一保存全员下窗即见 */
  skillStore: SkillStoreOption;
  /** 段切换外部依赖——注意力窗口的段保护对一切运行体生效 */
  segmentDeps: SegmentDepsOption;
  /** 设备唯一容量裁决器派生的可信 workload 准入；生产组合根必须提供。 */
  deviceCapacity?: {
    readonly interactive: AgentRuntimeCapacityBinding;
    readonly scheduler: AgentRuntimeCapacityBinding;
  };
  /** extra tools 装配单例(含 task_list service 与 MCP hub) */
  extraTools: BuiltinExtraToolsAssembly;
  /** 调度门面 getter——惰性求值解装配顺序依赖 */
  scheduler: () => SchedulerFacade;
  /** per-run 渲染装饰钩子(无 TTY 宿主传日志 / 转发实现) */
  decorateRunBus: DecorateRunBusFn;
  onSecurityBlocked: OnSecurityBlockedFn;
  /**
   * 实例创建后的统一装配后置钩子——turn-context provider 注册等。两条发放
   * 路径(会话 / ephemeral)都经此调用。
   */
  onRuntimeCreated?: (runtime: AgentRuntime) => void;
  /**
   * 生命周期订阅者集合(资产层共享)——随每个发放实例下发,实例内恒定。
   * 订阅者按执行期上下文(conversationId 等)自行决定是否介入,装配期不
   * 按对话定制;无会话身份的 ephemeral run 由订阅者自然跳过。
   */
  lifecycle?: readonly AgentRuntimeLifecycle[];
  /**
   * 工作场景领域服务(可选)——提供时会话实例装配 workmode 工具组(main 装
   * enter / change_approve / list / memory_query,场景实例装 exit),LLM 由此产生
   * 进出场景意图或主模式管理动作。ephemeral
   * 实例不装(定时任务无模式语义)。
   */
  worksceneDirectory?: () => WorksceneToolDirectory;
}

export class RuntimeHost {
  private readonly executionScheduler: ExecutionSchedulerFacade;

  constructor(private readonly opts: RuntimeHostOptions) {
    this.executionScheduler = new ExecutionSchedulerFacade(opts.scheduler);
  }

  /** 发放一个 main 会话 runtime 实例。 */
  async createConversationRuntime(workspace?: string | null): Promise<AgentRuntime> {
    return this.assemble({
      withWorkmodeTools: true,
      runtimeKind: "conversation",
      ...(workspace === undefined ? {} : { workspace }),
    });
  }

  /**
   * 发放一个工作场景会话的 runtime 实例——power 装配：本机解析后的授权路径为工作区
   * （无 workspace 显式 null，by-construction 杜绝串到 cwd）、记忆域绑场景、
   * power 角色与 profile。场景对话经全域键(ws: 前缀)路由到此。
   */
  async createWorksceneRuntime(input: {
    readonly scene: WorksceneDto;
    readonly absolutePath: string | null;
  }): Promise<AgentRuntime> {
    const { scene, absolutePath } = input;
    return this.assemble({
      withWorkmodeTools: true,
      workscene: {
        workspace: absolutePath,
        primaryRole: "power",
        memoryScope: { kind: "workscene", sceneId: scene.id },
        profile: powerProfile({
          id: scene.id,
          name: scene.name,
          hasWorkspace: absolutePath !== null,
        }),
        spec: { kind: "workscene", sceneId: scene.id, sceneName: scene.name },
      },
      runtimeKind: "conversation",
    });
  }

  /**
   * 发放一个 ephemeral runtime 实例(定时任务执行体)——任务 AI 自创建的
   * 子任务非用户发起、无渠道投递目标,origin 恒 null;无模式语义,不装
   * workmode 工具组。
   */
  async createEphemeralRuntime(): Promise<AgentRuntime> {
    return this.assemble({ runtimeKind: "ephemeral" });
  }

  /**
   * 发放 executor-owned job runtime。模型、工具与确认 broker 均来自已验
   * assignment；不继承会话身份、工作场景或渠道接入面状态。
   */
  async createJobRuntime(options: JobAgentRuntimeOptions): Promise<AgentRuntime> {
    return this.assemble({
      runtimeKind: "ephemeral",
      job: options,
    });
  }

  /** Non-secret catalog derived from the same profile and extra-tool assemblers as runtime creation. */
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  } {
    const tools = new Set<string>();
    const addProfile = (profile: ReturnType<typeof mainProfile>) => {
      for (const tool of profile.enabledTools) tools.add(tool);
    };
    addProfile(mainProfile());
    const catalogScene = {
      id: "capability-catalog",
      name: "capability-catalog",
      createdAt: "1970-01-01T00:00:00.000Z",
      lastActiveAt: "1970-01-01T00:00:00.000Z",
    };
    addProfile(powerProfile(catalogScene));
    addProfile(powerProfile({ ...catalogScene, hasWorkspace: true }));
    const addExtra = (input: Parameters<BuiltinExtraToolsAssembly["assembleTools"]>[0]) => {
      for (const tool of this.opts.extraTools.assembleTools(input)) tools.add(tool.name);
    };
    addExtra({
      scheduler: this.opts.scheduler,
      worksceneDirectory: this.opts.worksceneDirectory,
    });
    addExtra({ scheduler: this.opts.scheduler });
    if (this.opts.worksceneDirectory) {
      addExtra({
        scheduler: this.opts.scheduler,
        spec: {
          kind: "workscene",
          sceneId: "capability-catalog",
          sceneName: "capability-catalog",
        },
        worksceneDirectory: this.opts.worksceneDirectory,
      });
    }
    return {
      tools: [...tools].sort(),
      mcpServers: this.opts.extraTools.mcpHub.catalog()
        .map(({ server }) => server.serverId)
        .sort(),
    };
  }

  private async assemble(
    opts?: {
      /** 会话路径装 workmode 工具组(LLM 进出场景意图的产生面) */
      withWorkmodeTools?: boolean;
      workscene?: {
        workspace: string | null;
        primaryRole: "power";
        memoryScope: { kind: "workscene"; sceneId: string };
        profile: ReturnType<typeof powerProfile>;
        spec: { kind: "workscene"; sceneId: string; sceneName: string };
      };
      /** Explicit executor-local root; null means this runtime has no file workspace. */
      workspace?: string | null;
      runtimeKind?: RuntimeKind;
      job?: JobAgentRuntimeOptions;
    },
  ): Promise<AgentRuntime> {
    const workscene = opts?.workscene;
    const job = opts?.job;
    const mcpServers = this.opts.extraTools.mcpHub.catalog()
      .map(({ server }) => server.serverId)
      .sort();
    let extraTools = this.opts.extraTools.assembleTools({
      scheduler: () => this.executionScheduler,
      spec: workscene?.spec,
      worksceneDirectory: opts?.withWorkmodeTools
        ? this.opts.worksceneDirectory
        : undefined,
    });
    const baseProfile = mainProfile();
    const requestedTools = job?.instruction.tools
      ? new Set(job.instruction.tools)
      : undefined;
    if (requestedTools) {
      const available = new Set([
        ...baseProfile.enabledTools,
        ...extraTools.map((tool) => tool.name),
      ]);
      const unknown = [...requestedTools].filter((tool) => !available.has(tool));
      if (unknown.length > 0) {
        throw new TypeError(
          `Job requested unavailable tools: ${unknown.sort().join(", ")}`,
        );
      }
      extraTools = extraTools.filter((tool) => requestedTools.has(tool.name));
    }
    const profile = job
      ? {
          ...baseProfile,
          enabledTools: requestedTools
            ? baseProfile.enabledTools.filter((tool) => requestedTools.has(tool))
            : baseProfile.enabledTools,
        }
      : workscene?.profile ??
        (opts?.workspace === null ? mainProfile({ hasWorkspace: false }) : undefined);
    const providerConfiguration =
      job?.instruction.model && this.opts.providerConfiguration.config.llm
        ? {
            ...this.opts.providerConfiguration,
            config: {
              ...this.opts.providerConfiguration.config,
              llm: {
                ...this.opts.providerConfiguration.config.llm,
                main: {
                  ...this.opts.providerConfiguration.config.llm.main,
                  model: job.instruction.model,
                },
              },
            },
          }
        : this.opts.providerConfiguration;
    // 临时运行时按调度类计费,常驻会话按交互类:两者的公平份额不同,且容量
    // 绑定必须在构造时就位——工具执行的注入点在运行时内部,事后包装拿不到。
    const capacityBinding =
      opts?.runtimeKind === "ephemeral"
        ? this.opts.deviceCapacity?.scheduler
        : this.opts.deviceCapacity?.interactive;
    const runtime = await createAgentRuntime({
      ...(capacityBinding ? { deviceCapacity: capacityBinding } : {}),
      providerConfiguration,
      systemProtectedPaths: this.opts.systemProtectedPaths,
      workspace: workscene ? workscene.workspace : opts?.workspace,
      primaryRole: workscene?.primaryRole,
      memoryScope: workscene?.memoryScope,
      profile,
      extraTools,
      executionMcpServers: mcpServers,
      decorateRunBus: this.opts.decorateRunBus,
      onSecurityBlocked: this.opts.onSecurityBlocked,
      segmentDeps: this.opts.segmentDeps,
      skillStore: this.opts.skillStore,
      runtimeKind: opts?.runtimeKind ?? "conversation",
      ...(job ? { confirmationBroker: job.confirmationBroker } : {}),
      ...(opts?.runtimeKind !== "ephemeral" && this.opts.confirmationLifecycleObserver
        ? { confirmationLifecycleObserver: this.opts.confirmationLifecycleObserver }
        : {}),
      ...(this.opts.lifecycle ? { lifecycle: this.opts.lifecycle } : {}),
    });
    this.opts.onRuntimeCreated?.(runtime);
    return runtime;
  }
}
