import type { ScheduleMutationStager } from "@zhixing/core";
import type {
  AssignmentGlobalQueryPort,
  AssignmentMutationPort,
  AssignmentMutationRequest,
  AuthorityCapability,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";
import { scheduleTaskIdForRequest } from "@zhixing/owner-kernel";
import type { ConversationAssignmentLedger } from "@zhixing/executor";

export function createAssignmentGlobalQueryPort(input: {
  readonly state: GlobalStatePort;
  readonly capability: AuthorityCapability;
  readonly anchorEpoch: number;
}): AssignmentGlobalQueryPort {
  return {
    read: (query) => input.state.read(query, {
      principal: { kind: "assignment", capability: input.capability },
      requestId: `global-read:${protocolDigest("AssignmentGlobalQuery", 1, query)}`,
      deadlineAt: input.capability.expiry,
      authority: { domain: "global", anchorEpoch: input.anchorEpoch },
    }),
  };
}

export function createAssignmentMutationPort(input: {
  readonly ledger: ConversationAssignmentLedger;
  readonly assignmentId: string;
  readonly execution: "conversation" | "job";
  readonly anchorEpoch: number;
  readonly capability?: AuthorityCapability;
}): AssignmentMutationPort {
  const { ledger, assignmentId, execution, anchorEpoch, capability } = input;
  return {
    assignmentId,
    execution,
    async stage(request: AssignmentMutationRequest) {
      if (execution === "job" && request.domain === "session") {
        throw new Error("Job assignments cannot stage session mutations");
      }
      if (request.operationId.trim().length === 0) {
        throw new TypeError("Assignment mutation operationId must be durable and non-empty");
      }
      if (request.domain === "global" && capability) {
        assertGlobalMutationCapability(
          capability,
          assignmentId,
          execution,
          request.mutation,
        );
      }
      const requestId = `mutation:${protocolDigest("AssignmentMutationRequest", 1, {
        assignmentId,
        domain: request.domain,
        operationId: request.operationId,
      })}`;
      return ledger.stageMutation(
        assignmentId,
        request.domain === "session"
          ? {
              domain: "session",
              mutation: request.mutation,
              requestId,
            }
          : {
              domain: "global",
              mutation: request.mutation,
              requestId,
              expected: { anchorEpoch },
            },
      );
    },
    readOverlay: () => ledger.readStagedMutationOverlay(assignmentId),
  };
}

export function assignmentGlobalCapability(input: {
  readonly assignmentId: string;
  readonly execution: "conversation" | "job";
  readonly capabilities: readonly AuthorityCapability[];
}): AuthorityCapability {
  const matches = input.capabilities.filter(
    (capability) =>
      capability.assignmentId === input.assignmentId &&
      capability.scope.execution === input.execution &&
      capability.methods.includes("global.read") &&
      capability.methods.includes("global.mutate"),
  );
  if (matches.length !== 1) {
    throw new Error("Assignment has no unique global authority capability");
  }
  return matches[0]!;
}

function assertGlobalMutationCapability(
  capability: AuthorityCapability,
  assignmentId: string,
  execution: "conversation" | "job",
  mutation: Extract<AssignmentMutationRequest, { domain: "global" }>["mutation"],
): void {
  if (
    capability.assignmentId !== assignmentId ||
    capability.scope.execution !== execution ||
    !capability.methods.includes("global.mutate")
  ) {
    throw new Error("Assignment global mutation capability is misbound");
  }
  if (mutation.kind === "memory-append" || mutation.kind === "memory-delete") {
    const scope = mutation.kind === "memory-append" ? mutation.payload.scope : mutation.scope;
    const resource: `memory-domain:${string}` = scope.kind === "personal"
      ? "memory-domain:personal"
      : `memory-domain:workscene:${scope.sceneId}`;
    if (!capability.resources.includes(resource)) {
      throw new Error("Assignment capability does not cover this memory scope");
    }
  }
}

/** One deterministic schedule overlay writer per durable assignment run. */
export function createAssignmentScheduleStager(
  ledger: ConversationAssignmentLedger,
  assignmentId: string,
  anchorEpoch: number,
  execution: "conversation" | "job" = "conversation",
  capability?: AuthorityCapability,
): ScheduleMutationStager {
  const mutations = createAssignmentMutationPort({
    ledger,
    assignmentId,
    execution,
    anchorEpoch,
    capability,
  });
  return async ({ mutation, operationId }) => {
    if (!operationId) {
      throw new TypeError("Schedule mutation requires a durable operationId");
    }
    const staged = await mutations.stage({
      domain: "global",
      mutation,
      operationId,
    });
    return {
      seq: staged.recordSeq,
      ...(mutation.kind === "schedule-create"
        ? { taskId: scheduleTaskIdForRequest(staged.requestId) }
        : {}),
    };
  };
}
