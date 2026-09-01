/**
 * RuntimeHost —— 宿主侧 runtime 装配点:共享装配资产单一持有,按消费者发放实例。
 *
 * 两层结构:
 * - 资产层(构造注入):技能库 / 段切换依赖 / 渲染装饰与安全回调钩子——全部实例共享,
 *   是配置换代的单位。
 * - 实例层(按需发放):每个对话一个 runtime 实例——AgentRuntime 闭包持有窗口级
 *   状态,设计假定是服务单一对话的窗口序列,跨对话共享即互相践踏;定时任务路径
 *   发放 ephemeral 实例,同享资产层。实例所有权归调用方(会话适配层 / 任务执行
 *   器负责 dispose),host 只管装配。
 *
 * turnContextProviders 是资产层的固定 provider 工厂:每次发放先取得只读投影，
 * 再作为 createAgentRuntime 装配输入同步注册，运行体对外可见后不再二次装配。
 */

import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeCapacityBinding,
  type AgentRuntimeLifecycle,
  type CreateAgentRuntimeOptions,
  type KernelModelProviderFactory,
  type KernelRuntimeEnvironmentFactory,
  type RuntimeKind,
} from "@zhixing/orchestrator/runtime";
import type { IConfirmationBroker } from "@zhixing/core";
import type { ArtifactStore } from "@zhixing/core/authority";
import {
  assertConversationRuntimeProjection,
  assertRuntimeToolProjection,
  type ConversationRuntimeProjection,
  type RuntimeToolProjection,
} from "./conversation-runtime-projection.js";

/** 从 createAgentRuntime 公共契约推导类型——避免依赖 orchestrator 内部路径 */
type DecorateRunBusFn = NonNullable<CreateAgentRuntimeOptions["decorateRunBus"]>;
type OnSecurityBlockedFn = NonNullable<
  CreateAgentRuntimeOptions["onSecurityBlocked"]
>;
type SegmentDepsOption = CreateAgentRuntimeOptions["segmentDeps"];
type ConfirmationLifecycleObserverOption =
  CreateAgentRuntimeOptions["confirmationLifecycleObserver"];
type TurnContextProvidersOption = NonNullable<
  CreateAgentRuntimeOptions["turnContextProviders"]
>;

export interface JobAgentRuntimeOptions {
  readonly confirmationBroker: IConfirmationBroker;
  readonly profile: NonNullable<CreateAgentRuntimeOptions["profile"]>;
  readonly runtimeTools: RuntimeToolProjection;
  readonly modelOverride?: string;
}

export interface RuntimeHostOptions {
  /** Host-owned concrete Provider adapter; RuntimeHost only requests a finite binding. */
  readonly modelProvider: KernelModelProviderFactory;
  /** Host-owned configuration/workspace projection; no source object enters the Kernel. */
  readonly runtimeEnvironment: KernelRuntimeEnvironmentFactory;
  /** Durable interaction observer shared by all conversation runtime trees. */
  confirmationLifecycleObserver?: ConfirmationLifecycleObserverOption;
  /** 产品组合根持有的本机秘密路径，逐实例注入安全管线且不可由用户授权覆盖。 */
  systemProtectedPaths: readonly string[];
  /** Executor-local immutable artifacts; skill authority remains on the anchor. */
  artifactStore: () => ArtifactStore;
  /** 段切换外部依赖——注意力窗口的段保护对一切运行体生效 */
  segmentDeps: SegmentDepsOption;
  /** 设备唯一容量裁决器派生的可信 workload 准入；生产组合根必须提供。 */
  deviceCapacity?: {
    readonly interactive: AgentRuntimeCapacityBinding;
    readonly scheduler: AgentRuntimeCapacityBinding;
    readonly orchestration: AgentRuntimeCapacityBinding;
  };
  /** per-run 渲染装饰钩子(无 TTY 宿主传日志 / 转发实现) */
  decorateRunBus: DecorateRunBusFn;
  onSecurityBlocked: OnSecurityBlockedFn;
  /** 每个实例发布前取得一份固定、有序的宿主 turn-context provider 投影。 */
  readonly turnContextProviders?: () => TurnContextProvidersOption;
  /**
   * 生命周期订阅者集合(资产层共享)——随每个发放实例下发,实例内恒定。
   * 订阅者按执行期上下文(conversationId 等)自行决定是否介入,装配期不
   * 按对话定制;无会话身份的 ephemeral run 由订阅者自然跳过。
   */
  lifecycle?: readonly AgentRuntimeLifecycle[];
}

export class RuntimeHost {
  constructor(private readonly opts: RuntimeHostOptions) {}

  /** 发放一个已由产品组合边界完整裁决的 conversation runtime 实例。 */
  async createConversationRuntime(
    projection: ConversationRuntimeProjection,
  ): Promise<AgentRuntime> {
    assertConversationRuntimeProjection(projection);
    return this.assemble({
      conversation: projection,
      runtimeKind: "conversation",
    });
  }

  /**
   * 发放一个 ephemeral runtime 实例(定时任务执行体)——任务 AI 自创建的
   * 子任务非用户发起、无渠道投递目标,origin 恒 null;无模式语义,不装
   * workmode 工具组。
   */
  async createEphemeralRuntime(
    runtimeTools: RuntimeToolProjection,
  ): Promise<AgentRuntime> {
    assertRuntimeToolProjection(runtimeTools);
    return this.assemble({ runtimeKind: "ephemeral", runtimeTools });
  }

  /**
   * 发放 executor-owned job runtime。模型、工具与确认 broker 均来自已验
   * assignment；不继承会话身份、工作场景或渠道接入面状态。
   */
  async createJobRuntime(options: JobAgentRuntimeOptions): Promise<AgentRuntime> {
    assertRuntimeToolProjection(options.runtimeTools);
    assertRuntimeProfileProjection(options.profile);
    return this.assemble({
      runtimeKind: "ephemeral",
      job: options,
      runtimeTools: options.runtimeTools,
    });
  }

  private async assemble(
    opts?: {
      conversation?: ConversationRuntimeProjection;
      runtimeKind?: RuntimeKind;
      job?: JobAgentRuntimeOptions;
      runtimeTools?: RuntimeToolProjection;
    },
  ): Promise<AgentRuntime> {
    const conversation = opts?.conversation;
    const job = opts?.job;
    const runtimeTools = conversation?.runtimeTools ?? opts?.runtimeTools;
    if (!runtimeTools) {
      throw new TypeError(
        "Runtime tool projection is required before runtime issuance",
      );
    }
    assertRuntimeToolProjection(runtimeTools);
    const profile = job?.profile ?? conversation?.profile;
    const primaryRole = conversation?.primaryRole ?? "main";
    // 临时运行时按调度类计费,常驻会话按交互类:两者的公平份额不同,且容量
    // 绑定必须在构造时就位——工具执行的注入点在运行时内部,事后包装拿不到。
    const capacityBinding =
      opts?.runtimeKind === "ephemeral"
        ? this.opts.deviceCapacity?.scheduler
        : this.opts.deviceCapacity?.interactive;
    // 先取得完整装配输入；factory 抛错时 createAgentRuntime 尚未开始，绝不发布
    // 缺少部分 provider 的运行体。createAgentRuntime 再同步捕获只读序列。
    const modelProvider = this.opts.modelProvider.create({
      primaryRole,
      ...(job?.modelOverride === undefined
        ? {}
        : { mainModelOverride: job.modelOverride }),
    });
    const runtimeEnvironment = this.opts.runtimeEnvironment.create({
      ...(conversation && Object.hasOwn(conversation, "workspace")
        ? { workspace: conversation.workspace }
        : {}),
    });
    const turnContextProviders = this.opts.turnContextProviders?.();
    return createAgentRuntime({
      ...(capacityBinding ? { deviceCapacity: capacityBinding } : {}),
      ...(this.opts.deviceCapacity
        ? { orchestrationCapacity: this.opts.deviceCapacity.orchestration }
        : {}),
      modelProvider,
      runtimeEnvironment,
      systemProtectedPaths: this.opts.systemProtectedPaths,
      primaryRole,
      runtimeIdentity: conversation?.runtimeIdentity,
      profile,
      extraTools: [...runtimeTools.extraTools],
      ...(turnContextProviders ? { turnContextProviders } : {}),
      executionMcpServers: runtimeTools.executionMcpServers,
      decorateRunBus: this.opts.decorateRunBus,
      onSecurityBlocked: this.opts.onSecurityBlocked,
      segmentDeps: this.opts.segmentDeps,
      artifactStore: this.opts.artifactStore(),
      runtimeKind: opts?.runtimeKind ?? "conversation",
      ...(job ? { confirmationBroker: job.confirmationBroker } : {}),
      ...(opts?.runtimeKind !== "ephemeral" && this.opts.confirmationLifecycleObserver
        ? { confirmationLifecycleObserver: this.opts.confirmationLifecycleObserver }
        : {}),
      ...(this.opts.lifecycle ? { lifecycle: this.opts.lifecycle } : {}),
    });
  }
}

function assertRuntimeProfileProjection(
  profile: NonNullable<CreateAgentRuntimeOptions["profile"]>,
): void {
  if (
    !profile ||
    !Array.isArray(profile.constraints) ||
    !Array.isArray(profile.enabledTools) ||
    !Object.isFrozen(profile) ||
    !Object.isFrozen(profile.constraints) ||
    !Object.isFrozen(profile.enabledTools) ||
    (profile.capabilities !== undefined &&
      !Object.isFrozen(profile.capabilities))
  ) {
    throw new TypeError("Runtime profile projection must be immutable");
  }
}
