import type { ToolDefinition } from "@zhixing/core";
import type { IngressContext } from "@zhixing/core/contracts";
import type { StreamFrameAppender } from "@zhixing/core/protocol";
import {
  projectAssignmentInteractionStream,
  type ConversationAssignmentLedger,
} from "@zhixing/executor";

/**
 * conversation/job 交互承载共享的底层耐久投影与副作用原语。交互的
 * 授权语义(surface ticket / channel grant)属于各域,不进入本文件。
 */

export interface AssignmentInteractionProjectionBinding {
  readonly assignmentId: string;
  readonly ledger: ConversationAssignmentLedger;
  readonly stream: StreamFrameAppender;
  readonly streamMeta: {
    readonly turnOrigin?: NonNullable<IngressContext["turnOrigin"]>;
  };
  readonly signal?: AbortSignal;
}

/**
 * assignment 交互记录到执行流的投影所有者:同 assignment 串行冲刷,
 * 记录游标只是账本记录序号的可重建投影。
 */
export class AssignmentInteractionProjector {
  readonly #projectedRecordSeq = new Map<string, number>();
  readonly #drains = new Map<string, Promise<void>>();

  async drainAssignment(
    binding: AssignmentInteractionProjectionBinding,
  ): Promise<void> {
    const previous =
      this.#drains.get(binding.assignmentId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#projectAssignment(binding));
    this.#drains.set(binding.assignmentId, current);
    try {
      await current;
    } finally {
      if (this.#drains.get(binding.assignmentId) === current) {
        this.#drains.delete(binding.assignmentId);
      }
    }
  }

  release(assignmentId: string): void {
    this.#projectedRecordSeq.delete(assignmentId);
  }

  async #projectAssignment(
    binding: AssignmentInteractionProjectionBinding,
  ): Promise<void> {
    const projection = await projectAssignmentInteractionStream({
      assignmentId: binding.assignmentId,
      ledger: binding.ledger,
      writer: binding.stream,
      meta: binding.streamMeta,
      afterRecordSeq: this.#projectedRecordSeq.get(binding.assignmentId),
      signal: binding.signal,
    });
    this.#projectedRecordSeq.set(
      binding.assignmentId,
      projection.lastRecordSeq,
    );
  }
}

export interface AssignmentSideEffectBinding {
  readonly assignmentId: string;
  readonly ledger: ConversationAssignmentLedger;
}

export async function startAssignmentSideEffect(
  binding: AssignmentSideEffectBinding,
  tool: ToolDefinition,
  input: Record<string, unknown>,
): Promise<unknown> {
  const external = tool.boundaries?.some((boundary) =>
    boundary.boundaryType === "external-service" ||
    boundary.boundaryType === "messaging" ||
    boundary.boundaryType === "calendar" ||
    boundary.boundaryType === "financial"
  ) ?? false;
  const started = await binding.ledger.startSideEffect(binding.assignmentId, {
    kind: external ? "external-call" : "tool-mutation",
    toolName: tool.name,
    summary: `${tool.name}(${Object.keys(input).sort().join(",")})`,
    target: external
      ? "external-service"
      : tool.name === "Write" || tool.name === "Edit"
        ? "workspace-file"
        : "device-system",
  });
  return {
    binding,
    effectSeq: started.effectSeq,
  };
}

export async function finishAssignmentSideEffect(
  token: unknown,
  result: { readonly status: "ok" | "failed" | "aborted" },
): Promise<void> {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    throw new TypeError("Side-effect observer token is invalid");
  }
  const value = token as {
    binding?: AssignmentSideEffectBinding;
    effectSeq?: number;
  };
  if (!value.binding || !Number.isSafeInteger(value.effectSeq)) {
    throw new TypeError("Side-effect observer token is incomplete");
  }
  await value.binding.ledger.completeSideEffect(
    value.binding.assignmentId,
    value.effectSeq!,
    result,
  );
}
