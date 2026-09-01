import {
  resolveAgentIdentity,
  resolveModelInfo,
  resolveModelInputCapabilities,
  validateThinkingConfig,
  type LLMRole,
  type ThinkingConfig,
} from "@zhixing/core";
import {
  createKernelModelProviderBinding,
  createKernelRuntimeEnvironment,
  type KernelModelProviderFactory,
  type KernelRuntimeEnvironmentFactory,
} from "@zhixing/orchestrator/runtime";
import {
  createProviderRoles,
  ensureWorkspaceDir,
  getGlobalConfigPath,
  getModelCapabilityOverride,
  PROTOCOL_BUDGET_DEFAULTS,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  ROLE_SPECS,
  type ProviderCredentialProjection,
} from "@zhixing/providers";
import type { RuntimeConfigurationSnapshot } from "./runtime-configuration-snapshot.js";

export function createHostKernelModelProviderFactory(input: {
  readonly config: RuntimeConfigurationSnapshot;
  readonly credentials: ProviderCredentialProjection;
}): KernelModelProviderFactory {
  const config = input.config;
  const credentials = input.credentials;
  return Object.freeze({
    create(request: Parameters<KernelModelProviderFactory["create"]>[0]) {
      const effectiveConfig = request.mainModelOverride && config.llm
        ? {
            ...config,
            llm: {
              ...config.llm,
              main: {
                ...config.llm.main,
                model: request.mainModelOverride,
              },
            },
          }
        : config;
      const { roles, resolvedRoles } = createProviderRoles({
        config: effectiveConfig,
        credentials,
      });
      for (const degradation of resolvedRoles.degradations ?? []) {
        const label = ROLE_SPECS.find((spec) => spec.id === degradation.role)
          ?.labelZh ?? degradation.role;
        console.warn(
          `[zhixing] ${label} 配为 ${degradation.configured.provider} · ${degradation.configured.model} 但${degradation.reason}，已回退主模型（不影响启动；如需该角色请在配置中补全或移除该段）`,
        );
      }
      const roleThinking = {
        main: resolveRoleThinking(roles.main, effectiveConfig.llm?.main?.thinking),
        light: resolveRoleThinking(roles.light, effectiveConfig.llm?.light?.thinking),
        power: resolveRoleThinking(roles.power, effectiveConfig.llm?.power?.thinking),
      };
      const resolvedPrimary = resolvedRoles[request.primaryRole];
      const primaryRole = roles[request.primaryRole];
      const resolvedModel = resolveModelInfo({
        providerId: primaryRole.provider.id,
        model: primaryRole.model,
        providerModels: primaryRole.provider.models,
        overrides: resolvedPrimary.resolved.modelOverrides,
        protocolDefaults:
          PROTOCOL_BUDGET_DEFAULTS[resolvedPrimary.resolved.protocol],
      });
      for (const warning of resolvedModel.warnings) {
        console.warn(`[zhixing] ${warning.message}`);
      }
      const primaryModelCapability = resolveModelCapability(
        primaryRole.model,
        getModelCapabilityOverride(
          effectiveConfig.modelCapabilityOverrides,
          primaryRole.model,
        ),
      );
      return createKernelModelProviderBinding({
        primaryRole: request.primaryRole,
        roles,
        roleThinking,
        defaultMaxOutputTokens: {
          main:
            PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol]
              .maxOutputTokens,
          light:
            PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.light.resolved.protocol]
              .maxOutputTokens,
          power:
            PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.power.resolved.protocol]
              .maxOutputTokens,
        },
        primary: {
          budget: resolvedModel.info,
          inputCapabilities: resolveModelInputCapabilities({
            model: primaryRole.model,
            providerModels: primaryRole.provider.models,
            overrides: resolvedPrimary.resolved.modelInputCapabilities,
          }),
          attention: {
            optimalMaxTokens: primaryModelCapability.optimalMaxTokens,
            riskMaxTokens: primaryModelCapability.riskMaxTokens,
          },
        },
      });
    },
  });
}

export function createHostKernelRuntimeEnvironmentFactory(input: {
  readonly config: RuntimeConfigurationSnapshot;
}): KernelRuntimeEnvironmentFactory {
  const config = input.config;
  return Object.freeze({
    create(request: Parameters<KernelRuntimeEnvironmentFactory["create"]>[0]) {
      const sessionType = resolveWorkspaceSessionType();
      const workspace = request.workspace === null
        ? { path: null, source: "none" as const }
        : resolveWorkspace(config, {
            runtimeWorkspace: request.workspace,
            sessionType,
          });
      ensureWorkspaceDir(workspace);
      return createKernelRuntimeEnvironment({
        agentIdentity: resolveAgentIdentity(config.agent),
        sessionType,
        workspace,
        globalConfigPath: getGlobalConfigPath(),
        ...(config.network?.proxy === undefined
          ? {}
          : { networkProxy: config.network.proxy }),
      });
    },
  });
}

function resolveRoleThinking(
  role: LLMRole,
  configured: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (configured === undefined) return undefined;
  const modelInfo = role.provider.models.find((model) => model.id === role.model);
  if (modelInfo === undefined) return configured;
  const control = modelInfo.thinkingControl ?? { type: "none" };
  if (validateThinkingConfig(configured, control)) return configured;
  console.warn(
    `[zhixing] 模型 ${role.model} 不支持所配置的思考控制形态，已忽略该思考配置`,
  );
  return undefined;
}
