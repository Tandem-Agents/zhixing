const ORCHESTRATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const ORCHESTRATION_ID_RULE =
  "must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens";

export function isOrchestrationId(value: string): boolean {
  return ORCHESTRATION_ID_PATTERN.test(value);
}
