import { mainProfile, type AgentRoleProfile } from "@zhixing/orchestrator/profile";

/** Product input: workspace availability is resolved before runtime issuance. */
interface WorksceneProfileInput {
  readonly id: string;
  readonly name: string;
  readonly hasWorkspace?: boolean;
  /** Product assembly supplies the complete scene-control tool set, or none. */
  readonly hasSceneControlTools: boolean;
}

/** Workscene owns scene focus, management and exit instructions; the Kernel renders them. */
export function powerProfile(
  scene: WorksceneProfileInput,
  options: NonNullable<Parameters<typeof mainProfile>[0]> = {},
): AgentRoleProfile {
  const base = mainProfile({ ...options, hasWorkspace: scene.hasWorkspace === true });
  const focusInstructions =
    `${base.instructions}\n\n` +
    `You are now focused on the work scene "${scene.name}". ` +
    `Work in this scene is isolated from personal scope and other scenes.`;
  return {
    ...base,
    instructions: focusInstructions + (scene.hasSceneControlTools
      ? ` Inside this scene, you may use confirmed tools to rename this scene, change its device workspace, or clear its workspace binding; rename applies to registry metadata without restarting this window, while workspace changes take effect after this turn by re-entering the scene with the updated configuration. ` +
      `When the work in this scene is done — or the user signals they want to step back to the broader conversation — ` +
      `judge for yourself that the scene is complete and call the workmode_exit tool to return to the main conversation. ` +
      `Do not just narrate that you are done; leaving the scene only happens when you call workmode_exit.`
      : ""),
  };
}

/** Attached only to the entry tool; filtering that tool also removes its guidance. */
export const WORKING_MODE_TEXT = `## Working Mode (work scenes)

A work scene is an isolated context for a bounded line of work, with an optional device workspace and model. Entering one switches the conversation into that scene; leaving returns here.

Tools:
- \`workmode_enter\`: enter a work scene; the switch takes effect after the current turn.
- \`workscene_list\`: list scenes and their ids, names, optional device workspace names, and recent activity.
- \`workscene_change_approve\`: create, rename, remove, bind/change a device workspace, or clear the workspace binding with confirmation.

How to decide:
- Need scene ids or current workspace bindings: call \`workscene_list\`.
- Clear scene fit: call \`workmode_enter\` with that scene id; if none fits but one is warranted, propose it via \`workscene_change_approve\`.
- Ambiguous fit: ask the user before switching.
- Workspace management: use \`workscene_change_approve\` action \`set_workdir\` with a device and workspace name already authorized on that device, and action \`clear_workdir\` only for an explicit unbind request. Never request or transmit a remote filesystem path.
- Casual or one-off questions: stay in the main conversation.

After \`workmode_enter\`, finish the current turn normally; do not assume you are already inside the scene.`;
