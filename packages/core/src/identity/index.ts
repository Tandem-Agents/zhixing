/** Product identity is resolved at the application boundary and passed by value. */
export const DEFAULT_AGENT_DISPLAY_NAME = "知行";

export interface AgentIdentity {
  readonly displayName: string;
}

export interface AgentIdentityConfig {
  displayName?: string;
}

/** Missing or blank names retain the default; instances share no mutable state. */
export function resolveAgentIdentity(
  partial?: AgentIdentityConfig | null,
): AgentIdentity {
  return Object.freeze({
    displayName: partial?.displayName?.trim() || DEFAULT_AGENT_DISPLAY_NAME,
  });
}
