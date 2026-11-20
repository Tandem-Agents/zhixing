import { resolveAgentIdentity } from "@zhixing-ai/core/identity";
import { resolveModelInfo } from "@zhixing-ai/core/context";
import {
  resolveMaxOutputTokens,
  resolveModelInputCapabilities,
  validateThinkingConfig,
  type LLMRole,
  type SessionModelSelection,
  type ThinkingConfig,
} from "@zhixing-ai/core";
import {
  createKernelModelProviderBinding,
  createKernelRuntimeEnvironment,
  type KernelModelProviderFactory,
  type KernelRuntimeEnvironmentFactory,
} from "@zhixing-ai/orchestrator/runtime";
import {
  bindRole,
  createProviderRoles,
  ensureWorkspaceDir,
  getGlobalConfigPath,
  getModelCapabilityOverride,
  isLLMConfigV2,
  PROTOCOL_BUDGET_DEFAULTS,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  ROLE_SPECS,
  type ProviderCredentialProjection,
} from "@zhixing-ai/providers";
import type {
  RuntimeKernelEnvironmentConfigurationProjection,
  RuntimeModelConfigurationProjection,
} from "./runtime-configuration-projections.js";
import type { ModelRuntimePort } from "./model-runtime-port.js";

export function createHostKernelModelProviderFactory(input: {
  readonly configuration: RuntimeModelConfigurationProjection;
  readonly credentials: ProviderCredentialProjection;
  readonly modelRuntimePort?: ModelRuntimePort;
}): KernelModelProviderFactory {
  const staticConfiguration = input.configuration;
  const staticCredentials = input.credentials;
  const runtimePort = input.modelRuntimePort;
  return Object.freeze({
    create(request: Parameters<KernelModelProviderFactory["create"]>[0]) {
      const liveSnapshot = runtimePort?.snapshot();
      const configuration = liveSnapshot?.modelConfiguration ?? staticConfiguration;
      const credentials = liveSnapshot?.providerCredentials ?? staticCredentials;
      const revision = liveSnapshot?.revision ?? "static";

      // 兼容旧 job mainModelOverride（v1 配置沿用主角色覆写；v2 配置保持 roles.* 纯净，经 sessionPrimary 独立叠加完整参数）
      const sessionOverride: SessionModelSelection | undefined = request.sessionOverride;
      const isV2 = isLLMConfigV2(configuration.llm);
      let effectiveConfiguration: RuntimeModelConfigurationProjection = configuration;
      if (request.mainModelOverride && configuration.llm && !isV2 && configuration.llm.main) {
        effectiveConfiguration = {
          ...configuration,
          llm: {
            ...configuration.llm,
            main: {
              ...configuration.llm.main,
              model: request.mainModelOverride,
            },
          },
        };
      }

      const catalogPort = runtimePort?.catalogPort();
      const discoveryByConnection = runtimePort?.discoveryByConnection();
      const {
        roles: rawRoles,
        resolvedRoles,
        sessionPrimary: rawSessionPrimary,
        effectivePrimary,
      } = createProviderRoles({
        config: effectiveConfiguration,
        credentials,
        ...(catalogPort ? { catalog: catalogPort } : {}),
        ...(discoveryByConnection && Object.keys(discoveryByConnection).length > 0
          ? { discoveryByConnection }
          : {}),
        primaryRole: request.primaryRole,
        ...(sessionOverride ? { sessionOverride } : {}),
      });
      const trackedBinding = runtimePort
        ? runtimePort.trackBinding({
            roles: rawRoles,
            resolvedRoles,
            revision,
            ...(rawSessionPrimary ? { sessionPrimary: rawSessionPrimary } : {}),
            ...(effectivePrimary ? { effectivePrimary } : {}),
          })
        : undefined;
      const roles = trackedBinding ? trackedBinding.roles : rawRoles;
      const trackedSessionPrimary = trackedBinding ? trackedBinding.sessionPrimary : rawSessionPrimary;
      for (const degradation of resolvedRoles.degradations ?? []) {
        const label = ROLE_SPECS.find((spec) => spec.id === degradation.role)
          ?.labelZh ?? degradation.role;
        console.warn(
          `[zhixing] ${label} 配为 ${degradation.configured.provider} · ${degradation.configured.model} 但${degradation.reason}，已回退主模型（不影响启动；如需该角色请在配置中补全或移除该段）`,
        );
      }

      // 设计 §5.1：roleThinking 与 defaultMaxOutputTokens 统一消费已解析角色（含未配/降级回落主角色的完整参数）
      const roleThinking = {
        main: resolveRoleThinking(roles.main, resolvedRoles.main.params?.thinking),
        light: resolveRoleThinking(roles.light, resolvedRoles.light.params?.thinking),
        power: resolveRoleThinking(roles.power, resolvedRoles.power.params?.thinking),
      };
      const resolveMaxOutput = (
        roleObj: LLMRole,
        resolvedEntry: typeof resolvedRoles.main.resolved,
        prefs: { readonly explicitRequest?: number; readonly userPreference?: number },
        thinking: ThinkingConfig | undefined,
      ): number => {
        const info = resolveModelInfo({
          providerId: roleObj.provider.id,
          model: roleObj.model,
          providerModels: roleObj.provider.models,
          overrides: resolvedEntry.modelOverrides,
          protocolDefaults: PROTOCOL_BUDGET_DEFAULTS[resolvedEntry.protocol],
        });
        return resolveMaxOutputTokens({
          explicitRequest: prefs.explicitRequest,
          userPreference: prefs.userPreference,
          modelCatalogMaxOutput: info.info.maxOutputTokens,
          protocolDefault: PROTOCOL_BUDGET_DEFAULTS[resolvedEntry.protocol].maxOutputTokens,
          hardCap: info.info.maxOutputTokens,
          thinkingBudget: thinking?.mode === "budget" ? thinking.budget : undefined,
        }).maxTokens;
      };
      const resolveRoleMaxOutput = (roleId: "main" | "light" | "power"): number =>
        resolveMaxOutput(
          roles[roleId],
          resolvedRoles[roleId].resolved,
          { userPreference: resolvedRoles[roleId].maxOutputPreference },
          roleThinking[roleId],
        );

      const hasPrimaryRoleOverrides =
        request.primaryRoleOverrides?.params !== undefined ||
        request.primaryRoleOverrides?.maxOutputPreference !== undefined;
      const useV2MainModelOverride =
        isV2 &&
        Boolean(request.mainModelOverride) &&
        sessionOverride?.mode !== "override";

      let sessionPrimary: LLMRole | undefined;
      let sessionPrimaryThinking: ThinkingConfig | undefined;
      let sessionPrimaryMaxOutputTokens: number | undefined;
      let resolvedPrimary = resolvedRoles[request.primaryRole];

      if (trackedSessionPrimary && effectivePrimary && sessionOverride?.mode === "override") {
        sessionPrimary = trackedSessionPrimary;
        resolvedPrimary = effectivePrimary;
        sessionPrimaryThinking = resolveRoleThinking(
          sessionPrimary,
          sessionOverride.params?.thinking,
        );
        sessionPrimaryMaxOutputTokens = resolveMaxOutput(
          sessionPrimary,
          effectivePrimary.resolved,
          { explicitRequest: sessionOverride.maxOutputPreference },
          sessionPrimaryThinking,
        );
      } else if (useV2MainModelOverride || hasPrimaryRoleOverrides) {
        const baseRole = roles[request.primaryRole];
        const baseResolved = resolvedRoles[request.primaryRole];
        sessionPrimary = useV2MainModelOverride
          ? bindRole(baseRole.provider, request.mainModelOverride!)
          : baseRole;
        resolvedPrimary = baseResolved;
        const effectiveConfiguredThinking =
          request.primaryRoleOverrides?.params !== undefined
            ? request.primaryRoleOverrides.params.thinking
            : baseResolved.params?.thinking;
        sessionPrimaryThinking = resolveRoleThinking(
          sessionPrimary,
          effectiveConfiguredThinking,
        );
        sessionPrimaryMaxOutputTokens = resolveMaxOutput(
          sessionPrimary,
          baseResolved.resolved,
          {
            explicitRequest: request.primaryRoleOverrides?.maxOutputPreference,
            userPreference: baseResolved.maxOutputPreference,
          },
          sessionPrimaryThinking,
        );
      }

      const primaryRole = sessionPrimary ?? roles[request.primaryRole];
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
      const attentionOverrides = isLLMConfigV2(effectiveConfiguration.llm)
        ? (effectiveConfiguration.llm.attentionPolicies ?? effectiveConfiguration.modelCapabilityOverrides)
        : effectiveConfiguration.modelCapabilityOverrides;
      const primaryModelCapability = resolveModelCapability(
        primaryRole.model,
        getModelCapabilityOverride(
          attentionOverrides,
          primaryRole.model,
        ),
        catalogPort?.bundle.attentionThresholds,
      );
      return createKernelModelProviderBinding({
        primaryRole: request.primaryRole,
        roles,
        roleThinking,
        defaultMaxOutputTokens: {
          main: resolveRoleMaxOutput("main"),
          light: resolveRoleMaxOutput("light"),
          power: resolveRoleMaxOutput("power"),
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
        ...(sessionPrimary ? { sessionPrimary } : {}),
        ...(sessionPrimaryThinking !== undefined ? { sessionPrimaryThinking } : {}),
        ...(sessionPrimaryMaxOutputTokens !== undefined
          ? { sessionPrimaryMaxOutputTokens }
          : {}),
        ...(trackedBinding ? { acquireRunLease: trackedBinding.acquireRunLease } : {}),
        ...(trackedBinding ? { dispose: trackedBinding.dispose } : {}),
      });
    },
  });
}

export function createHostKernelRuntimeEnvironmentFactory(input: {
  readonly configuration: RuntimeKernelEnvironmentConfigurationProjection;
  readonly zhixingHome: string;
}): KernelRuntimeEnvironmentFactory {
  const configuration = input.configuration;
  const globalConfigPath = getGlobalConfigPath(process.env, input.zhixingHome);
  const agentIdentity = resolveAgentIdentity(configuration.agent);
  return Object.freeze({
    create(request: Parameters<KernelRuntimeEnvironmentFactory["create"]>[0]) {
      const sessionType = resolveWorkspaceSessionType();
      const workspace = request.workspace === null
        ? { path: null, source: "none" as const }
        : resolveWorkspace(configuration, {
            runtimeWorkspace: request.workspace,
            sessionType,
          });
      ensureWorkspaceDir(workspace);
      return createKernelRuntimeEnvironment({
        agentIdentity,
        sessionType,
        workspace,
        globalConfigPath,
        ...(configuration.network?.proxy === undefined
          ? {}
          : { networkProxy: configuration.network.proxy }),
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
