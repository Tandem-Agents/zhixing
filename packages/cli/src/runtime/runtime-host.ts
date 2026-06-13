/**
 * RuntimeHost —— 宿主侧 runtime 装配点:共享装配资产单一持有,按消费者发放实例。
 *
 * 两层结构:
 * - 资产层(构造注入):workspace / 技能库 / 段切换依赖 / extra tools assembly
 *   (含 MCP hub)/ 调度门面 getter / 渲染装饰与安全回调钩子——全部实例共享,
 *   是配置换代的单位。
 * - 实例层(按需发放):每个对话一个 runtime 实例——AgentRuntime 闭包持有窗口级
 *   状态,设计假定是服务单一对话的窗口序列,跨对话共享即互相践踏;定时任务路径
 *   发放 ephemeral 实例,同享资产层。实例所有权归调用方(会话适配层 / 任务执行
 *   器负责 dispose),host 只管装配。
 *
 * 对话级差异经执行期上下文取,不做装配期定制:schedule 工具的投递 origin 在工具
 * 执行时从 RunContext 的 conversationId 派生——同一装配闭包服务全部对话。子 agent
 * 工具白名单不含 schedule,RunContext 不透传 conversationId 到子链路无影响。
 *
 * onRuntimeCreated 是发放后的统一装配后置钩子(turn-context provider 注册等):
 * 会话与 ephemeral 两条发放路径都经此,杜绝"某入口漏注册"类不对齐。
 */

import {
  createAgentRuntime,
  runContextStorage,
  type AgentRuntime,
  type CreateAgentRuntimeOptions,
} from "@zhixing/orchestrator/runtime";
import { powerProfile } from "@zhixing/orchestrator/profile";
import type { SchedulerFacade, WorkScene } from "@zhixing/core";
import type { ScheduleToolOrigin } from "@zhixing/tools-builtin";
import type { BuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import type { IWorkModeController } from "./work-mode-controller.js";

/** 从 createAgentRuntime 公共契约推导类型——避免依赖 orchestrator 内部路径 */
type DecorateRunBusFn = NonNullable<CreateAgentRuntimeOptions["decorateRunBus"]>;
type OnSecurityBlockedFn = NonNullable<
  CreateAgentRuntimeOptions["onSecurityBlocked"]
>;
type SegmentDepsOption = CreateAgentRuntimeOptions["segmentDeps"];
type SkillStoreOption = CreateAgentRuntimeOptions["skillStore"];

export interface RuntimeHostOptions {
  /** 工作区目录——所有实例同一解析值("任何目录运行效果一致"由宿主单点解析保证) */
  workspace?: string;
  /** 技能库单实例——索引结构版本跨全部实例一致,任一保存全员下窗即见 */
  skillStore: SkillStoreOption;
  /** 段切换外部依赖——注意力窗口的段保护对一切运行体生效 */
  segmentDeps: SegmentDepsOption;
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
   * 工作模式控制器(可选)——提供时会话实例装配 workmode 工具组(main 装
   * enter / change_approve / memory_query,场景实例装 exit),LLM 由此产生
   * 进出场景意图(经 run bus 带出、定向通知发起接入面消费)。ephemeral
   * 实例不装(定时任务无模式语义)。
   */
  workModeController?: () => IWorkModeController;
}

/**
 * 从会话 id(如 "dm:feishu:ou_xxx")解析定时任务投递 origin。
 * 非渠道会话(本地对话 / ephemeral)返回 null——任务无渠道投递目标。
 */
export function parseOriginFromConversationId(
  conversationId: string,
): ScheduleToolOrigin | null {
  const parts = conversationId.split(":");
  if (parts.length >= 3 && parts[0] === "dm") {
    return { channelId: parts[1]!, to: parts.slice(2).join(":") };
  }
  return null;
}

export class RuntimeHost {
  /**
   * 会话实例共用的 origin 派生闭包——执行期从 RunContext 读当前 run 的
   * conversationId 再解析,装配期不绑定任何对话。
   */
  private readonly conversationScheduleOrigin: () => ScheduleToolOrigin | null;

  constructor(private readonly opts: RuntimeHostOptions) {
    this.conversationScheduleOrigin = () => {
      const conversationId = runContextStorage.getStore()?.conversationId;
      return conversationId
        ? parseOriginFromConversationId(conversationId)
        : null;
    };
  }

  /** 发放一个 main 会话 runtime 实例——投递 origin 执行期按当前 run 的对话派生。 */
  async createConversationRuntime(): Promise<AgentRuntime> {
    return this.assemble(this.conversationScheduleOrigin, {
      withWorkmodeTools: true,
    });
  }

  /**
   * 发放一个工作场景会话的 runtime 实例——power 装配:场景 workdir 为工作区
   * (无 workdir 显式 null,by-construction 杜绝串到 cwd)、记忆域绑场景、
   * power 角色与 profile。场景对话经全域键(ws: 前缀)路由到此。
   */
  async createWorksceneRuntime(scene: WorkScene): Promise<AgentRuntime> {
    return this.assemble(this.conversationScheduleOrigin, {
      withWorkmodeTools: true,
      workscene: {
        workspace: scene.workdir ?? null,
        primaryRole: "power",
        memoryScope: { kind: "workscene", sceneId: scene.id },
        profile: powerProfile(scene),
        spec: { kind: "workscene" },
      },
    });
  }

  /**
   * 发放一个 ephemeral runtime 实例(定时任务执行体)——任务 AI 自创建的
   * 子任务非用户发起、无渠道投递目标,origin 恒 null;无模式语义,不装
   * workmode 工具组。
   */
  async createEphemeralRuntime(): Promise<AgentRuntime> {
    return this.assemble(() => null);
  }

  private async assemble(
    scheduleOrigin: () => ScheduleToolOrigin | null,
    opts?: {
      /** 会话路径装 workmode 工具组(LLM 进出场景意图的产生面) */
      withWorkmodeTools?: boolean;
      workscene?: {
        workspace: string | null;
        primaryRole: "power";
        memoryScope: { kind: "workscene"; sceneId: string };
        profile: ReturnType<typeof powerProfile>;
        spec: { kind: "workscene" };
      };
    },
  ): Promise<AgentRuntime> {
    const workscene = opts?.workscene;
    const runtime = await createAgentRuntime({
      workspace: workscene ? workscene.workspace : this.opts.workspace,
      primaryRole: workscene?.primaryRole,
      memoryScope: workscene?.memoryScope,
      profile: workscene?.profile,
      extraTools: this.opts.extraTools.assembleTools({
        scheduler: this.opts.scheduler,
        scheduleOrigin,
        spec: workscene?.spec,
        workModeController: opts?.withWorkmodeTools
          ? this.opts.workModeController
          : undefined,
      }),
      decorateRunBus: this.opts.decorateRunBus,
      onSecurityBlocked: this.opts.onSecurityBlocked,
      segmentDeps: this.opts.segmentDeps,
      skillStore: this.opts.skillStore,
    });
    this.opts.onRuntimeCreated?.(runtime);
    return runtime;
  }
}
