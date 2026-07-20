/** Immutable, non-secret facts describing one assembled execution runtime. */
export interface RuntimeExecutionProfile {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly providerIds: readonly string[];
}
