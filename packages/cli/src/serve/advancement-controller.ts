import {
  AdvancementStore,
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
import { createProviderRoles, resolveWorkspace, resolveWorkspaceSessionType } from "@zhixing/providers";
import { createAdvancementRuntime } from "@zhixing/orchestrator/advancement";
import {
  createLightCallLLM,
  createMainCallLLM,
} from "@zhixing/orchestrator/runtime";
import { AdvancementController } from "@zhixing/server";

export function createServeAdvancementController(): AdvancementController {
  const { roles, config } = createProviderRoles();
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

  const contractBuilder = new RubricContractBuilder({
    rubricStore: new RubricStore(),
    generationStrategy: new LLMRubricDraftGenerationStrategy({
      complete: (prompt) => mainCall([userMessage(prompt)]),
    }),
    revisionStrategy: new LLMRubricDraftRevisionStrategy({
      complete: (prompt) => mainCall([userMessage(prompt)]),
    }),
  });

  return new AdvancementController({
    store: new AdvancementStore(),
    admissionStrategy: new LLMAdvancementAdmissionStrategy({
      complete: (prompt) => lightCall([userMessage(prompt)]),
    }),
    contractBuilder,
    reviewer: createAdvancementRuntime({
      provider: roles.main.provider,
      model: roles.main.model,
      thinking: mainThinking,
      workingDirectory: workspace.path ?? undefined,
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
