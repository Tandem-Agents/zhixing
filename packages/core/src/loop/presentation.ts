import type { AgentYield } from "./types.js";

export function stripPresentationFromAgentYield(event: AgentYield): AgentYield {
  if (
    event.type !== "tool_end" ||
    event.result.presentation === undefined
  ) {
    return event;
  }

  const { presentation: _presentation, ...result } = event.result;
  return { ...event, result };
}
