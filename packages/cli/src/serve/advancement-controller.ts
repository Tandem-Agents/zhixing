import {
  AdvancementStore,
  buildClosureSynthesisPrompt,
  createSegmentSummarizeFn,
  LLMAdvancementAdmissionStrategy,
  LLMRubricDraftGenerationStrategy,
  LLMRubricDraftRevisionStrategy,
  RubricContractBuilder,
  RubricStore,
  userMessage,
  validateThinkingConfig,
  type LLMRole,
  type ThinkingConfig,
} from "@zhixing/core";
import {
  createProviderRoles,
  getModelCapabilityOverride,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing/providers";
import {
  createAdvancementRuntime,
  createFirstPartyEvidenceProvider,
  detectEvidenceCapabilities,
} from "@zhixing/orchestrator/advancement";
import {
  createLightCallLLM,
  createMainCallLLM,
  type AgentRuntimeCapacityBinding,
} from "@zhixing/orchestrator/runtime";
import { PROTOCOL_BUDGET_DEFAULTS } from "@zhixing/providers";
import {
  governControlProvider,
  type ControlLlmGovernor,
} from "./governed-control-llm.js";
import { AdvancementController } from "@zhixing/owner-services";

export interface ServeAdvancementControllerDeps {
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
  /**
   * control 治理端口（惰性——authority runtime 在 pre-server surface 装配，
   * 晚于本控制器创建；advancement 外调发生在运行期，取值时必须已就绪，
   * 缺失即 fail-closed，不允许静默绕过治理）。
   */
  readonly governor: () => ControlLlmGovernor | undefined;
  readonly deviceCapacity?: AgentRuntimeCapacityBinding;
  /** 准入投影来源——活跃会话窗口尾部（经 lazy ref 取，未就绪返回 undefined）。 */
  readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  /** 准入延迟基线观测（诊断日志）。 */
  readonly onAdmissionTiming?: (elapsedMs: number) => void;
}

/** 惰性解析的治理端口代理——每次调用时解析真实 governor，缺失即拒绝。 */
function lazyControlGovernor(
  resolve: () => ControlLlmGovernor | undefined,
): ControlLlmGovernor {
  const required = (): ControlLlmGovernor => {
    const governor = resolve();
    if (!governor) {
      throw new Error("Advancement LLM calls require the durable authority runtime");
    }
    return governor;
  };
  return {
    acquireRoot: (workload, budget, origin, ctx) =>
      required().acquireRoot(workload, budget, origin, ctx),
    reserveUsage: (lease, usage, ctx) => required().reserveUsage(lease, usage, ctx),
    consume: (lease, usage, ctx) => required().consume(lease, usage, ctx),
    settle: (lease, ctx) => required().settle(lease, ctx),
    release: (lease, ctx) => required().release(lease, ctx),
  };
}

export async function createServeAdvancementController(
  deps: ServeAdvancementControllerDeps,
): Promise<AdvancementController> {
  const { roles: rawRoles, resolvedRoles, config } = createProviderRoles({
    config: deps.config,
    credentials: deps.credentials,
  });
  // advancement 的全部真实 LLM 外调经 control 治理边界：provider 层单点包装，
  // 每次 chat = 独立 advancement 类 control 工作（acquireRoot→流式预占/消费→终结）——
  // 后续 mainCall/lightCall/reviewer/summarize 全部消费 governed roles，零旁路
  const governor = lazyControlGovernor(deps.governor);
  const governedRole = (
    role: (typeof rawRoles)["main"],
    protocol: keyof typeof PROTOCOL_BUDGET_DEFAULTS,
  ): typeof role => {
    const provider = governControlProvider(
      {
        governor,
        origin: { admissionClass: "advancement", entry: "advancement-control" },
        workPrefix: "advancement",
        defaultMaxOutputTokens: PROTOCOL_BUDGET_DEFAULTS[protocol].maxOutputTokens,
      },
      role.provider,
    );
    return {
      provider,
      model: role.model,
      chat: (request) => provider.chat({ ...request, model: role.model }),
      ...(role.countTokens ? { countTokens: role.countTokens } : {}),
    };
  };
  const roles = {
    main: governedRole(rawRoles.main, resolvedRoles.main.resolved.protocol),
    light: governedRole(rawRoles.light, resolvedRoles.light.resolved.protocol),
    power: governedRole(rawRoles.power, resolvedRoles.power.resolved.protocol),
  };
  const mainThinking = resolveConfiguredThinking(
    roles.main,
    config.llm?.main?.thinking,
  );
  const lightThinking = resolveConfiguredThinking(
    roles.light,
    config.llm?.light?.thinking,
  );
  // 推进的两个单发调用是纯 LLM 网络往返,按容量合同不占 permit:等待响应期间
  // 持有设备槽位会挡住真正要用本机资源的工作,而自己什么也没在算。
  const mainCall = createMainCallLLM(roles, mainThinking);
  const lightCall = createLightCallLLM(roles, lightThinking);
  const workspace = resolveWorkspace(config, {
    sessionType: resolveWorkspaceSessionType(),
  });
  const advancementWindowCapability = resolveModelCapability(
    roles.main.model,
    getModelCapabilityOverride(config.modelCapabilityOverrides, roles.main.model),
  );

  // 取证能力集是运行时探测的系统事实（git 可用性 / workspace 形态），
  // 传入草案生成——required 只能落在能力集内的 kind 上；无工作区时
  // 无从独立取证，能力集为空、不装取证 provider（安全缺省）。
  const workspacePath = workspace.path ?? undefined;
  const evidenceCapabilities = workspacePath
    ? await detectEvidenceCapabilities(workspacePath)
    : undefined;

  const contractBuilder = new RubricContractBuilder({
    rubricStore: new RubricStore(),
    generationStrategy: new LLMRubricDraftGenerationStrategy({
      complete: (prompt) => mainCall([userMessage(prompt)]),
    }),
    revisionStrategy: new LLMRubricDraftRevisionStrategy({
      complete: (prompt) => mainCall([userMessage(prompt)]),
    }),
    ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
  });

  return new AdvancementController({
    store: new AdvancementStore(),
    admissionStrategy: new LLMAdvancementAdmissionStrategy({
      complete: (prompt) => lightCall([userMessage(prompt)]),
    }),
    ...(deps.recentContextProvider
      ? { recentContextProvider: deps.recentContextProvider }
      : {}),
    ...(deps.onAdmissionTiming
      ? { onAdmissionTiming: deps.onAdmissionTiming }
      : {}),
    // 收场合成走轻推理通道；失败由 controller 降级结构化直出。
    closureSynthesizer: {
      synthesize: (facts) =>
        lightCall([userMessage(buildClosureSynthesisPrompt(facts))]),
    },
    ...(config.advancement?.sessionTokenBudget !== undefined
      ? { sessionTokenBudget: config.advancement.sessionTokenBudget }
      : {}),
    contractBuilder,
    reviewer: createAdvancementRuntime({
      provider: roles.main.provider,
      model: roles.main.model,
      thinking: mainThinking,
      ...(deps.deviceCapacity
        ? { deviceCapacity: deps.deviceCapacity }
        : {}),
      workingDirectory: workspacePath,
      ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
      ...(workspacePath
        ? {
            evidenceProvider: createFirstPartyEvidenceProvider({
              workspace: workspacePath,
            }),
          }
        : {}),
      contextWindow: {
        capability: advancementWindowCapability,
        summarize: createSegmentSummarizeFn(
          (request) =>
            roles.light.provider.chat({
              ...request,
              thinking: lightThinking,
            }),
          roles.light.model,
        ),
      },
    }),
  });
}

function resolveConfiguredThinking(
  role: LLMRole,
  configured: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (configured === undefined) return undefined;
  const modelInfo = role.provider.models.find((m) => m.id === role.model);
  if (modelInfo === undefined) return configured;
  const control = modelInfo.thinkingControl ?? { type: "none" };
  if (validateThinkingConfig(configured, control)) return configured;
  return undefined;
}
