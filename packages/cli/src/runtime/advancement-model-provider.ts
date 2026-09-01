import {
  validateThinkingConfig,
  type LLMRole,
  type ThinkingConfig,
} from "@zhixing/core";
import {
  createAdvancementModelProviderBinding,
  createAdvancementRuntime,
  type AdvancementModelProviderFactory,
} from "@zhixing/orchestrator/advancement";
import { createControlCompletionPort } from "@zhixing/orchestrator/runtime";
import {
  createProviderRoles,
  getModelCapabilityOverride,
  PROTOCOL_BUDGET_DEFAULTS,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing/providers";

export function createHostAdvancementModelProviderFactory(input: {
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
}): AdvancementModelProviderFactory {
  const hostConfig = input.config;
  const credentials = input.credentials;
  return Object.freeze({
    create(request: Parameters<AdvancementModelProviderFactory["create"]>[0]) {
      const { roles: rawRoles, resolvedRoles, config } = createProviderRoles({
        config: hostConfig,
        credentials,
      });
      const roles = Object.freeze({
        main: rawRoles.main,
        light: rawRoles.light,
      });
      const mainThinking = resolveConfiguredThinking(
        roles.main,
        config.llm?.main?.thinking,
      );
      const lightThinking = resolveConfiguredThinking(
        roles.light,
        config.llm?.light?.thinking,
      );
      const workspace = resolveWorkspace(config, {
        sessionType: resolveWorkspaceSessionType(),
      });
      const resolvedAttention = resolveModelCapability(
        roles.main.model,
        getModelCapabilityOverride(
          config.modelCapabilityOverrides,
          roles.main.model,
        ),
      );
      const evidenceCapabilities = request.evidenceCapabilities;

      return createAdvancementModelProviderBinding({
        completion: createControlCompletionPort({
          roles,
          thinking: { main: mainThinking, light: lightThinking },
          meter: request.resourceMeter,
          defaultMaxOutputTokens:
            PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.light.resolved.protocol]
              .maxOutputTokens,
        }),
        reviewer: createAdvancementRuntime({
          provider: roles.main.provider,
          model: roles.main.model,
          thinking: mainThinking,
          lightProvider: roles.light.provider,
          lightModel: roles.light.model,
          lightThinking,
          resourceMeter: request.resourceMeter,
          defaultMaxOutputTokens:
            PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol]
              .maxOutputTokens,
          workingDirectory: workspace.path ?? undefined,
          ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
          contextWindow: {
            capability: {
              optimalMaxTokens: resolvedAttention.optimalMaxTokens,
              riskMaxTokens: resolvedAttention.riskMaxTokens,
            },
          },
        }),
        ...(config.advancement?.sessionTokenBudget === undefined
          ? {}
          : { sessionTokenBudget: config.advancement.sessionTokenBudget }),
      });
    },
  });
}

function resolveConfiguredThinking(
  role: LLMRole,
  configured: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (configured === undefined) return undefined;
  const modelInfo = role.provider.models.find((model) => model.id === role.model);
  if (modelInfo === undefined) return configured;
  const control = modelInfo.thinkingControl ?? { type: "none" };
  return validateThinkingConfig(configured, control) ? configured : undefined;
}
