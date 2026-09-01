import type { EvidenceCapabilitySet } from "@zhixing/core/advancement";
import type {
  AdvancementReviewerPort,
  ControlCompletionPort,
  ResourceReservationPort,
} from "@zhixing/core/contracts";

export interface AdvancementModelProviderBinding {
  readonly completion: ControlCompletionPort;
  readonly reviewer: AdvancementReviewerPort;
  readonly sessionTokenBudget?: number;
}

export interface AdvancementModelProviderRequest {
  readonly resourceMeter: Pick<
    ResourceReservationPort,
    "reserveUsage" | "consume"
  >;
  readonly evidenceCapabilities?: EvidenceCapabilitySet;
}

export interface AdvancementModelProviderFactory {
  create(request: AdvancementModelProviderRequest): AdvancementModelProviderBinding;
}

const BINDING_KEYS = ["completion", "reviewer", "sessionTokenBudget"] as const;

export function createAdvancementModelProviderBinding(
  input: AdvancementModelProviderBinding,
): AdvancementModelProviderBinding {
  const binding = Object.freeze({
    completion: input.completion,
    reviewer: input.reviewer,
    ...(input.sessionTokenBudget === undefined
      ? {}
      : { sessionTokenBudget: input.sessionTokenBudget }),
  });
  assertAdvancementModelProviderBinding(binding);
  return binding;
}

export function assertAdvancementModelProviderBinding(
  value: AdvancementModelProviderBinding,
): void {
  if (
    !isExactObject(value, BINDING_KEYS) ||
    !Object.isFrozen(value) ||
    typeof value.completion?.complete !== "function" ||
    typeof value.reviewer?.review !== "function" ||
    (value.sessionTokenBudget !== undefined &&
      (!Number.isSafeInteger(value.sessionTokenBudget) ||
        value.sessionTokenBudget <= 0))
  ) {
    throw new TypeError(
      "Advancement model provider binding must be finite and immutable",
    );
  }
}

function isExactObject(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
