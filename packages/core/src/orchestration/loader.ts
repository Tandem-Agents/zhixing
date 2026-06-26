import { cloneData, deepFreeze } from "./internal.js";
import { parseOrchestrationDefinitionV1 } from "./jsonc.js";
import { normalizeOrchestrationDefinitionV1 } from "./normalizer.js";
import { planOrchestrationV1 } from "./planner.js";
import { validateOrchestrationDefinitionV1 } from "./validation.js";
import type {
  OrchestrationLoadResultV1,
  OrchestrationSystemCapsV1,
} from "./types.js";

export function loadOrchestrationDefinitionV1(
  source: string | unknown,
  caps: OrchestrationSystemCapsV1,
): OrchestrationLoadResultV1 {
  const parsed =
    typeof source === "string"
      ? parseOrchestrationDefinitionV1(source)
      : { ok: true as const, value: source };

  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const validation = validateOrchestrationDefinitionV1(parsed.value, caps);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const normalizedDefinition = normalizeOrchestrationDefinitionV1(
    validation.definition,
    caps,
  );
  const plan = planOrchestrationV1(normalizedDefinition);

  return {
    ok: true,
    executable: deepFreeze({
      sourceMode: "trusted",
      definition: normalizedDefinition,
      plan,
      caps: deepFreeze(cloneData(caps)),
    }),
  };
}
