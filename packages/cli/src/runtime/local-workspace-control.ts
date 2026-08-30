import type {
  AuthorityCallContext,
  LocalEnvironmentControlContext,
} from "@zhixing/core/contracts";
import type { WorkspaceAdministrationControlPort } from "@zhixing/core/environment/workspace-administration";
import type { ExecutorResourceGovernor } from "@zhixing/executor";

const CONTROL_BUDGET = { maxCalls: 8 };

/** Correctness adapter for target-device workspace control admission. */
export class ExecutorWorkspaceAdministrationControl
  implements WorkspaceAdministrationControlPort
{
  readonly #executorId: string;
  readonly #resources: ExecutorResourceGovernor;

  constructor(input: {
    readonly executorId: string;
    readonly resources: ExecutorResourceGovernor;
  }) {
    this.#executorId = input.executorId;
    this.#resources = input.resources;
  }

  async execute<T>(
    requestId: string,
    abort: AbortSignal,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
  ): Promise<T> {
    const context: AuthorityCallContext = {
      principal: { kind: "host", component: "resource-governor" },
      requestId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const lease = await this.#resources.acquireRoot(
      { kind: "control", id: requestId, attempt: 1 },
      CONTROL_BUDGET,
      { admissionClass: "interactive", entry: "environment-control" },
      context,
      { executorId: this.#executorId },
    );
    let failed = true;
    try {
      const result = await operation({ requestId, lease, abort });
      failed = false;
      return result;
    } finally {
      try {
        await this.#resources.settle(lease, context);
      } finally {
        await this.#resources.release(lease, context).catch((error) => {
          if (!failed) throw error;
        });
      }
    }
  }
}
