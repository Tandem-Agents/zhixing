import { isLocalConversationId, parseConversationId } from "../conversation/scope-id.js";
import type { WorksceneTaskHandoff } from "../types/agent-events.js";
import { validateWorksceneTaskHandoff, type WorksceneTaskReference } from "./continuation.js";

/** Immutable run projection; no Kernel, assignment writer or topology objects. */
export interface WorksceneToolRun {
  readonly conversationId?: string;
  readonly durableConversation: boolean;
  readonly tasks: readonly WorksceneTaskReference[];
}

export interface WorksceneRunToolApplication {
  tasks(): readonly WorksceneTaskReference[];
  handoff(value: unknown): WorksceneTaskHandoff | undefined;
  canReturnToMain(): boolean;
  stopTarget(input: { conversationId: unknown; runId: unknown }):
    { readonly target: WorksceneTaskReference } | { readonly error: string };
}

/** Workscene owns handoff eligibility and the admitted task-reference boundary. */
export class WorksceneRunToolApplicationService implements WorksceneRunToolApplication {
  constructor(private readonly read: () => WorksceneToolRun) {}

  tasks(): readonly WorksceneTaskReference[] { return structuredClone(this.read().tasks); }

  handoff(value: unknown): WorksceneTaskHandoff | undefined {
    if (value === undefined) return undefined;
    validateWorksceneTaskHandoff(value);
    const run = this.read();
    if (!run.durableConversation || (run.conversationId && isLocalConversationId(run.conversationId))) {
      throw new Error("任务交接需要 Anchor 所属的耐久对话，当前运行不能接纳场景续接。");
    }
    return structuredClone(value);
  }

  canReturnToMain(): boolean {
    return parseConversationId(this.read().conversationId ?? "").scope.kind === "workscene";
  }

  stopTarget(input: { conversationId: unknown; runId: unknown }):
    { readonly target: WorksceneTaskReference } | { readonly error: string } {
    const run = this.read();
    if (!run.durableConversation) return { error: "停止委托需要当前耐久对话" };
    const target = run.tasks.find(task => task.conversationId === input.conversationId && task.runId === input.runId);
    return target ? { target: structuredClone(target) }
      : { error: "停止引用不在本轮获准委托列表中，请核对任务，不要猜测引用" };
  }
}
