import type { AgentYield } from "./types.js";

export function stripPresentationFromAgentYield(event: AgentYield): AgentYield {
  if (
    event.type !== "tool_end"
  ) {
    return event;
  }

  const result = event.result;
  // ToolResult has a closed model/public shape. Unknown display extensions
  // cannot turn into an artifact-reference side channel by changing a key.
  let plain = result.presentation === undefined;
  for (const key in result) if (Object.hasOwn(result, key) &&
    key !== 'content' && key !== 'isError' && key !== 'committedToUser') { plain = false; break; }
  if (plain) return event;
  return { ...event, result: { content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.committedToUser === undefined ? {} : { committedToUser: result.committedToUser }),
  } };
}
