import type {
  ExecutionAbortRequest,
} from "@zhixing/core/contracts";
import type {
  ConversationAssignmentLedger,
} from "@zhixing/executor";
import type {
  ConversationInteractionAnswerPort,
} from "./durable-conversation-interactions.js";
import { ConversationInteractionRuntimeUnavailableError } from "./durable-conversation-interactions.js";
import type {
  JobInteractionAnswerPort,
} from "./durable-job-interactions.js";

export interface AssignmentOperationsPort
  extends ConversationInteractionAnswerPort {
  abortWithTicket(request: ExecutionAbortRequest): Promise<void>;
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
    const binding = await this.options.ledger.dataPlaneBinding(assignmentId);
    if (!binding) {
      throw new TypeError(
        "Data-plane operation has no durable assignment binding",
      );
    }
    if (binding.ref.execution === "conversation") {
      return this.options.conversation;
    }
    if (!this.options.job) {
      throw new ConversationInteractionRuntimeUnavailableError(
        "Job data-plane operations are not enabled on this executor",
      );
    }
    return this.options.job;
  }
}
