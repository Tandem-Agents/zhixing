import type {
  ExecutionAbortRequest,
} from "@zhixing/core/contracts";
import type {
  ConversationAssignmentLedger,
} from "@zhixing/executor";
import type {
  ConversationInteractionAnswerPort,
} from "./durable-conversation-interactions.js";
import type {
  JobInteractionAnswerPort,
} from "./durable-job-interactions.js";
import { JobInteractionRuntimeUnavailableError } from "./durable-job-interactions.js";

export interface AssignmentOperationsPort
  extends ConversationInteractionAnswerPort {
  abortWithTicket(request: ExecutionAbortRequest): Promise<void>;
}

/**
 * Routes interaction operations from the durable assignment execution domain.
 * Local and mesh adapters share this predicate instead of inspecting live
 * workers or reproducing the execution-domain switch.
 */
export class AssignmentInteractionRouter
  implements ConversationInteractionAnswerPort {
  constructor(
    private readonly options: {
      readonly ledger: ConversationAssignmentLedger;
      readonly conversation: ConversationInteractionAnswerPort;
      readonly job?: JobInteractionAnswerPort;
    },
  ) {}

  async answerInteractionWithTicket(
    input: Parameters<
      ConversationInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void> {
    return (await this.#forAssignment(input.assignmentId))
      .answerInteractionWithTicket(input);
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    return (await this.#forAssignment(input.assignmentId))
      .resolveNoInteractiveSurface(input);
  }

  async #forAssignment(
    assignmentId: string,
  ): Promise<ConversationInteractionAnswerPort> {
    return routeAssignmentExecution(
      this.options.ledger,
      assignmentId,
      this.options,
    );
  }
}

/**
 * Routes data-plane operations from the durable assignment execution domain.
 * It never probes whichever worker happens to be live.
 */
export class AssignmentOperationsRouter implements AssignmentOperationsPort {
  constructor(
    private readonly options: {
      readonly ledger: ConversationAssignmentLedger;
      readonly conversation: AssignmentOperationsPort;
      readonly job?: AssignmentOperationsPort & JobInteractionAnswerPort;
    },
  ) {}

  async answerInteractionWithTicket(
    input: Parameters<
      ConversationInteractionAnswerPort["answerInteractionWithTicket"]
    >[0],
  ): Promise<void> {
    return (await this.#forAssignment(input.assignmentId))
      .answerInteractionWithTicket(input);
  }

  async resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void> {
    return (await this.#forAssignment(input.assignmentId))
      .resolveNoInteractiveSurface(input);
  }

  async abortWithTicket(request: ExecutionAbortRequest): Promise<void> {
    const operations = await this.#forAssignment(request.assignmentId);
    const binding = await this.options.ledger.dataPlaneBinding(
      request.assignmentId,
    );
    if (!binding || binding.ref.execution !== request.ref.execution) {
      throw new TypeError(
        "Abort request execution domain differs from its durable assignment",
      );
    }
    return operations.abortWithTicket(request);
  }

  async #forAssignment(
    assignmentId: string,
  ): Promise<AssignmentOperationsPort> {
    return routeAssignmentExecution(
      this.options.ledger,
      assignmentId,
      this.options,
    );
  }
}

async function routeAssignmentExecution<TConversation, TJob>(
  ledger: ConversationAssignmentLedger,
  assignmentId: string,
  routes: {
    readonly conversation: TConversation;
    readonly job?: TJob;
  },
): Promise<TConversation | TJob> {
  const binding = await ledger.dataPlaneBinding(assignmentId);
  if (!binding) {
    throw new TypeError(
      "Data-plane operation has no durable assignment binding",
    );
  }
  if (binding.ref.execution === "conversation") return routes.conversation;
  if (!routes.job) {
    throw new JobInteractionRuntimeUnavailableError(
      "Job data-plane operations are not enabled on this executor",
    );
  }
  return routes.job;
}
