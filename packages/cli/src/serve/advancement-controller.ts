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
} from "@zhixing/orchestrator/runtime";
import { AdvancementController } from "@zhixing/owner-services";

export interface ServeAdvancementControllerDeps {
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
  /** 准入投影来源——活跃会话窗口尾部（经 lazy ref 取，未就绪返回 undefined）。 */
  readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  /** 准入延迟基线观测（诊断日志）。 */
  readonly onAdmissionTiming?: (elapsedMs: number) => void;
}

export async function createServeAdvancementController(
  deps: ServeAdvancementControllerDeps,
): Promise<AdvancementController> {
  const { roles, config } = createProviderRoles({
    config: deps.config,
    credentials: deps.credentials,
  });
  const mainThinking = resolveConfiguredThinking(
    roles.main,
    config.llm?.main?.thinking,
  );
  const lightThinking = resolveConfiguredThinking(
    roles.light,
    config.llm?.light?.thinking,
  );
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
