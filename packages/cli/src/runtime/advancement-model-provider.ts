import { resolveModelInfo } from "@zhixing-ai/core/context";
import {
  resolveMaxOutputTokens,
  validateThinkingConfig,
  type LLMRole,
  type ThinkingConfig,
} from "@zhixing-ai/core";
import {
  createAdvancementModelProviderBinding,
  createAdvancementRuntime,
  type AdvancementModelProviderFactory,
} from "@zhixing-ai/orchestrator/advancement";
import { createControlCompletionPort } from "@zhixing-ai/orchestrator/runtime";
import {
  createProviderRoles,
  getModelCapabilityOverride,
  isLLMConfigV2,
  PROTOCOL_BUDGET_DEFAULTS,
  resolveLLMRoles,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type ProviderCredentialProjection,
} from "@zhixing-ai/providers";
import type { RuntimeAdvancementConfigurationProjection } from "./runtime-configuration-projections.js";
import type { ModelRuntimePort } from "./model-runtime-port.js";

export function createHostAdvancementModelProviderFactory(input: {
  readonly configuration: RuntimeAdvancementConfigurationProjection;
  readonly credentials: ProviderCredentialProjection;
  readonly modelRuntimePort?: ModelRuntimePort;
}): AdvancementModelProviderFactory {
  const staticConfiguration = input.configuration;
  const staticCredentials = input.credentials;
  const runtimePort = input.modelRuntimePort;
  return Object.freeze({
    create(request: Parameters<AdvancementModelProviderFactory["create"]>[0]) {
      const evidenceCapabilities = request.evidenceCapabilities;
      const readLiveConfiguration = (): {
        readonly hostConfiguration: RuntimeAdvancementConfigurationProjection;
        readonly credentials: ProviderCredentialProjection;
        readonly revision: string;
      } => {
        const liveSnapshot = runtimePort?.snapshot();
        const hostConfiguration =
          liveSnapshot?.advancementConfiguration ??
          (liveSnapshot
            ? ({
                ...staticConfiguration,
                llm: liveSnapshot.modelConfiguration.llm,
                network: liveSnapshot.modelConfiguration.network,
                modelCapabilityOverrides:
                  liveSnapshot.modelConfiguration.modelCapabilityOverrides,
              } as RuntimeAdvancementConfigurationProjection)
            : staticConfiguration);
        const credentials = liveSnapshot?.providerCredentials ?? staticCredentials;
        const revision = liveSnapshot?.revision ?? "static";
        return { hostConfiguration, credentials, revision };
      };

      const assembleLive = () => {
        const { hostConfiguration, credentials, revision } = readLiveConfiguration();
        const catalogPort = runtimePort?.catalogPort();
        const discoveryByConnection = runtimePort?.discoveryByConnection();
        const { roles: rawRoles, resolvedRoles, config } = createProviderRoles({
          config: hostConfiguration,
          credentials,
          ...(catalogPort ? { catalog: catalogPort } : {}),
          ...(discoveryByConnection && Object.keys(discoveryByConnection).length > 0
            ? { discoveryByConnection }
            : {}),
        });
        const trackedBinding = runtimePort
          ? runtimePort.trackBinding({
              roles: rawRoles,
              resolvedRoles,
              revision,
            })
          : undefined;
        const tracked = trackedBinding ? trackedBinding.roles : rawRoles;
        const roles = Object.freeze({
          main: tracked.main,
          light: tracked.light,
        });
        const mainThinking = resolveConfiguredThinking(
          roles.main,
          resolvedRoles.main.params?.thinking,
        );
        const lightThinking = resolveConfiguredThinking(
          roles.light,
          resolvedRoles.light.params?.thinking,
        );
        const workspace = resolveWorkspace(config, {
          sessionType: resolveWorkspaceSessionType(),
        });
        const attentionOverrides = isLLMConfigV2(config.llm)
          ? (config.llm.attentionPolicies ?? config.modelCapabilityOverrides)
          : config.modelCapabilityOverrides;
        const resolvedAttention = resolveModelCapability(
          roles.main.model,
          getModelCapabilityOverride(
            attentionOverrides,
            roles.main.model,
          ),
          catalogPort?.bundle.attentionThresholds,
        );
        const lightProtocolDefaults =
          PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.light.resolved.protocol];
        const mainProtocolDefaults =
          PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol];
        const lightModelInfo = resolveModelInfo({
          providerId: roles.light.provider.id,
          model: roles.light.model,
          providerModels: roles.light.provider.models,
          overrides: resolvedRoles.light.resolved.modelOverrides,
          protocolDefaults: lightProtocolDefaults,
        });
        const mainModelInfo = resolveModelInfo({
          providerId: roles.main.provider.id,
          model: roles.main.model,
          providerModels: roles.main.provider.models,
          overrides: resolvedRoles.main.resolved.modelOverrides,
          protocolDefaults: mainProtocolDefaults,
        });
        const lightMaxOutputTokens = resolveMaxOutputTokens({
          userPreference: resolvedRoles.light.maxOutputPreference,
          modelCatalogMaxOutput: lightModelInfo.info.maxOutputTokens,
          protocolDefault: lightProtocolDefaults.maxOutputTokens,
          hardCap: lightModelInfo.info.maxOutputTokens,
          thinkingBudget: lightThinking?.mode === "budget" ? lightThinking.budget : undefined,
        }).maxTokens;
        const mainMaxOutputTokens = resolveMaxOutputTokens({
          userPreference: resolvedRoles.main.maxOutputPreference,
          modelCatalogMaxOutput: mainModelInfo.info.maxOutputTokens,
          protocolDefault: mainProtocolDefaults.maxOutputTokens,
          hardCap: mainModelInfo.info.maxOutputTokens,
          thinkingBudget: mainThinking?.mode === "budget" ? mainThinking.budget : undefined,
        }).maxTokens;

        return {
          trackedBinding,
          completion: createControlCompletionPort({
            roles,
            thinking: { main: mainThinking, light: lightThinking },
            meter: request.resourceMeter,
            defaultMaxOutputTokens: {
              main: mainMaxOutputTokens,
              light: lightMaxOutputTokens,
            },
          }),
          reviewer: createAdvancementRuntime({
            provider: roles.main.provider,
            model: roles.main.model,
            thinking: mainThinking,
            lightProvider: roles.light.provider,
            lightModel: roles.light.model,
            lightThinking,
            resourceMeter: request.resourceMeter,
            defaultMaxOutputTokens: mainMaxOutputTokens,
            lightDefaultMaxOutputTokens: lightMaxOutputTokens,
            workingDirectory: workspace.path ?? undefined,
            ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
            contextWindow: {
              capability: {
                optimalMaxTokens: resolvedAttention.optimalMaxTokens,
                riskMaxTokens: resolvedAttention.riskMaxTokens,
              },
            },
          }),
          sessionTokenBudget: config.advancement?.sessionTokenBudget,
        };
      };

      if (!runtimePort) {
        const staticLive = assembleLive();
        return createAdvancementModelProviderBinding({
          completion: staticLive.completion,
          reviewer: staticLive.reviewer,
          ...(staticLive.sessionTokenBudget === undefined
            ? {}
            : { sessionTokenBudget: staticLive.sessionTokenBudget }),
        });
      }

      const initialState = readLiveConfiguration();
      resolveLLMRoles(initialState.hostConfiguration, initialState.credentials);
      const initialBudget = initialState.hostConfiguration.advancement?.sessionTokenBudget;

      // 每次实际调用按最新 ModelRuntimePort 装配，全程持有 Run lease 并在调用结束后立即释放/回收，
      // 彻底消除长期持有旧 completion/reviewer 闭包导致的配置更新失效或退役连接撕裂（设计 §5.1 / §5.3）。
      return createAdvancementModelProviderBinding({
        completion: {
          async complete(completeRequest) {
            let live: ReturnType<typeof assembleLive>;
            try {
              await runtimePort?.ensureFreshBeforeAdmission();
              live = assembleLive();
            } catch (error) {
              return {
                ok: false,
                error: {
                  code: "unavailable-offline",
                  message: error instanceof Error ? error.message : String(error),
                  retryable: false,
                },
              };
            }
            const releaseLease = live.trackedBinding?.acquireRunLease();
            try {
              return await live.completion.complete(completeRequest);
            } finally {
              releaseLease?.();
              await live.trackedBinding?.dispose().catch(() => {});
            }
          },
        },
        reviewer: {
          async review(reviewInput, lease, abort) {
            await runtimePort?.ensureFreshBeforeAdmission();
            const live = assembleLive();
            const releaseLease = live.trackedBinding?.acquireRunLease();
            try {
              return await live.reviewer.review(reviewInput, lease, abort);
            } finally {
              releaseLease?.();
              await live.trackedBinding?.dispose().catch(() => {});
            }
          },
        },
        ...(initialBudget === undefined
          ? {}
          : { sessionTokenBudget: initialBudget }),
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
