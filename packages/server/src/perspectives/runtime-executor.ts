import type {
  PerspectivesOrchestrationExecutor,
  PerspectivesOrchestrationRunInput,
} from "./types.js";

export class RuntimePerspectivesOrchestrationExecutor
  implements PerspectivesOrchestrationExecutor
{
  async run(input: PerspectivesOrchestrationRunInput) {
    const runOrchestration = input.managed.runtime.runOrchestrationV1;
    if (!runOrchestration) {
      throw new Error("session runtime does not support orchestration execution.");
    }
    return runOrchestration({
      executable: input.executable,
      runInput: input.runInput,
      contextSnapshot: input.contextSnapshot,
      abortSignal: input.abortSignal,
      eventBus: input.eventBus,
      parentLineage: "perspectives",
    });
  }
}
