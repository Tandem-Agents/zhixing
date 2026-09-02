import type {
  DataPlaneTicket,
  ExecutionAbortRequest,
  ExecutionRef,
} from "@zhixing/core/contracts";
import type { FirstPartyInteractionDecision } from "@zhixing/core/protocol";
import type { MeshServiceRegistry, SecureMeshConnection } from "@zhixing/mesh";
import type { AssignmentStreamClient } from "./assignment-stream-mesh.js";
import type { AssignmentRunStream } from "./conversation-assignment-worker.js";
import type { ConversationInteractionAnswerPort } from "./durable-conversation-interactions.js";

export interface AssignmentDataPlaneStreamPort {
  createStream(input: {
    readonly assignmentId: string;
    readonly ref: ExecutionRef;
  }): Promise<AssignmentRunStream>;
}

export interface AssignmentDataPlaneLocalTransportPort {
  acceptTicket(ticket: DataPlaneTicket): Promise<void>;
  authorizeOwnerPresentedSurface(
    ticketId: string,
    use: import("@zhixing/core/protocol").DataPlaneTicketUse,
    assignmentId: string,
  ): Promise<void>;
  ownerStreamClient(ownerDeviceId: string): AssignmentStreamClient;
  surfaceStreamClient(surfacePrincipal: string): AssignmentStreamClient;
}

export interface AssignmentDataPlaneMeshServiceInput {
  readonly services: MeshServiceRegistry;
  readonly operations: ConversationInteractionAnswerPort & {
    abortWithTicket(request: ExecutionAbortRequest): Promise<void>;
  };
  readonly authorizeOwner: (
    connection: SecureMeshConnection,
    assignmentId: string,
  ) => boolean;
  readonly surfacePrincipalFor: (connection: SecureMeshConnection) => string;
  readonly authorizePeer: (deviceId: string) => boolean;
  readonly ownerMayPresentSurfaceTicket: (
    connection: SecureMeshConnection,
  ) => boolean;
}

export interface AssignmentDataPlaneMeshPort extends AssignmentDataPlaneStreamPort {
  registerMeshServices(input: AssignmentDataPlaneMeshServiceInput): () => void;
}

export interface AssignmentDataPlaneChannelAnswer {
  readonly assignmentId: string;
  readonly requestId: string;
  readonly ticketId: string;
  readonly surfacePrincipal: string;
  readonly decision: FirstPartyInteractionDecision;
}

/** Finite stream/ticket role consumed by owner and surface sessions. */
export interface AssignmentDataPlaneTarget {
  acceptTicket(ticket: DataPlaneTicket): Promise<void>;
  answerChannel(input: AssignmentDataPlaneChannelAnswer): Promise<void>;
  resolveNoInteractiveSurface(input: {
    readonly assignmentId: string;
    readonly requestId: string;
  }): Promise<void>;
  ownerStream(): AssignmentStreamClient;
  directSurfaceStream(surfacePrincipal: string): AssignmentStreamClient | undefined;
}

/** Demand-owned topology-neutral directory. */
export interface AssignmentDataPlaneTargetDirectory {
  targetForExecutor(executorId: string): AssignmentDataPlaneTarget;
}

/** Remote mechanism contribution implemented by Mesh infrastructure. */
export interface AssignmentDataPlaneRemoteDirectory {
  remoteDataPlaneTarget(executorId: string): AssignmentDataPlaneTarget;
}

export interface AssignmentDataPlaneTopologyOptions {
  readonly local?: {
    readonly executorId: string;
    readonly ownerDeviceId: string;
    readonly transport: AssignmentDataPlaneLocalTransportPort;
    readonly interactions: ConversationInteractionAnswerPort;
  };
  readonly remote?: AssignmentDataPlaneRemoteDirectory;
}

/**
 * Host-only adapter selecting one local or Mesh implementation for the same
 * upper stream/ticket contract. It owns no assignment, ticket or stream fact.
 */
export class AssignmentDataPlaneTopologyAdapter
  implements AssignmentDataPlaneTargetDirectory {
  readonly #local:
    | { readonly executorId: string; readonly target: AssignmentDataPlaneTarget }
    | undefined;
  readonly #remote: AssignmentDataPlaneRemoteDirectory | undefined;

  constructor(options: AssignmentDataPlaneTopologyOptions) {
    this.#local = options.local
      ? {
          executorId: options.local.executorId,
          target: localTarget(options.local),
        }
      : undefined;
    this.#remote = options.remote;
  }

  targetForExecutor(executorId: string): AssignmentDataPlaneTarget {
    if (this.#local?.executorId === executorId) return this.#local.target;
    const remote = this.#remote;
    if (!remote) throw new Error("Remote executor data plane is unavailable");
    return remote.remoteDataPlaneTarget(executorId);
  }
}

function localTarget(
  options: NonNullable<AssignmentDataPlaneTopologyOptions["local"]>,
): AssignmentDataPlaneTarget {
  return Object.freeze({
    acceptTicket: (ticket: DataPlaneTicket) =>
      options.transport.acceptTicket(ticket),
    answerChannel: async (input: AssignmentDataPlaneChannelAnswer) => {
      await options.transport.authorizeOwnerPresentedSurface(
        input.ticketId,
        "interact",
        input.assignmentId,
      );
      await options.interactions.answerInteractionWithTicket({
        assignmentId: input.assignmentId,
        requestId: input.requestId,
        ticketId: input.ticketId,
        surfacePrincipal: input.surfacePrincipal,
        decision: input.decision,
      });
    },
    resolveNoInteractiveSurface: (input: {
      readonly assignmentId: string;
      readonly requestId: string;
    }) => options.interactions.resolveNoInteractiveSurface(input),
    ownerStream: () =>
      options.transport.ownerStreamClient(options.ownerDeviceId),
    directSurfaceStream: (surfacePrincipal: string) =>
      options.transport.surfaceStreamClient(surfacePrincipal),
  });
}
