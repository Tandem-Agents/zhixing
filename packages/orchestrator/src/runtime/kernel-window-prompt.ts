import type { AssignmentGlobalQueryPort } from "@zhixing/core/contracts";
import type { DataDrivenSegment } from "./lifecycle.js";

/**
 * One immutable product-owned Kernel attention-window prompt segment.
 *
 * The Kernel understands only the finite prompt segment and its already-rendered
 * content. Product catalog entries, modes and projection policy stay outside the
 * runtime boundary.
 *
 * This is the complete finite result captured at one attention-window boundary.
 */
export interface KernelWindowPromptProjection {
  readonly revision: number;
  readonly segment: DataDrivenSegment;
  readonly content: string | null;
}

/**
 * Product-composed projection port used by the Kernel at its existing window
 * boundaries. The optional Correctness source is supplied only for durable
 * assignment runs; product policy decides how to interpret it.
 */
export interface KernelWindowPromptProjectionPort {
  project(
    source?: AssignmentGlobalQueryPort,
  ): Promise<KernelWindowPromptProjection>;
}

export function createKernelWindowPromptProjection(input: {
  readonly revision: number;
  readonly segment: DataDrivenSegment;
  readonly content: string | null;
}): KernelWindowPromptProjection {
  const projection = Object.freeze({
    revision: input.revision,
    segment: input.segment,
    content: input.content,
  });
  assertKernelWindowPromptProjection(projection);
  return projection;
}

export function assertKernelWindowPromptProjectionPort(
  port: KernelWindowPromptProjectionPort,
): void {
  if (
    !port ||
    typeof port !== "object" ||
    !Object.isFrozen(port) ||
    typeof port.project !== "function" ||
    Object.keys(port).length !== 1 ||
    !Object.hasOwn(port, "project")
  ) {
    throw new TypeError(
      "Kernel window prompt projection port must be finite and immutable",
    );
  }
}

export function assertKernelWindowPromptProjection(
  projection: KernelWindowPromptProjection,
): void {
  const keys =
    projection && typeof projection === "object"
      ? Object.keys(projection).sort()
      : [];
  if (
    !projection ||
    !Number.isSafeInteger(projection.revision) ||
    projection.revision < -1 ||
    projection.segment !== "skill-index" ||
    (projection.content !== null && typeof projection.content !== "string") ||
    !Object.isFrozen(projection) ||
    keys.length !== 3 ||
    keys[0] !== "content" ||
    keys[1] !== "revision" ||
    keys[2] !== "segment"
  ) {
    throw new TypeError("Kernel window prompt projection must be immutable");
  }
}
