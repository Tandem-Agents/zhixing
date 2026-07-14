import { Buffer } from "node:buffer";
import type { ArtifactRef, LogicalRecord, MutationBatch, SealedBundle } from "../contracts/index.js";
import {
  canonicalize,
  validateConversationSealedBundle,
  validateMutationBatch,
} from "../protocol/index.js";
import { assertArtifactRef, collectArtifactRefs } from "./artifact-references.js";
import { AuthorityStorageError } from "./errors.js";

type ExecutionKind = "conversation" | "job";

export type RegisteredArtifactRoot =
  | {
      readonly schema: "DispatchEnvelope";
      readonly ref: ArtifactRef;
      readonly assignmentId: string;
      readonly execution: ExecutionKind;
    }
  | {
      readonly schema: "SealedBundle";
      readonly ref: ArtifactRef;
      readonly assignmentId: string;
    }
  | {
      readonly schema: "MutationBatch";
      readonly ref: ArtifactRef;
      readonly assignmentId: string;
    };

export function collectRegisteredArtifactRoots(
  records: readonly LogicalRecord<unknown>[],
): RegisteredArtifactRoot[] {
  const roots: RegisteredArtifactRoot[] = [];
  for (const record of records) {
    const body = plainRecord(record.body);
    if (record.stream.startsWith("run:") || record.stream.startsWith("job:")) {
      if (body?.t === "assigned") {
        roots.push({
          schema: "DispatchEnvelope",
          ref: requiredArtifactRef(body.dispatchRef, "Assigned dispatchRef"),
          assignmentId: requiredString(body.assignmentId, "Assigned assignmentId"),
          execution: record.stream.startsWith("run:") ? "conversation" : "job",
        });
      } else if (body?.t === "committed") {
        roots.push({
          schema: "SealedBundle",
          ref: requiredArtifactRef(plainRecord(body.bundle)?.ref, "Committed bundle ref"),
          assignmentId: requiredString(body.assignmentId, "Committed assignmentId"),
        });
      }
      continue;
    }
    if (record.stream === "publish" && body?.t === "publish-decision") {
      roots.push({
        schema: "MutationBatch",
        ref: requiredArtifactRef(plainRecord(body.batch)?.ref, "Publish batch ref"),
        assignmentId: requiredString(body.assignmentId, "Publish assignmentId"),
      });
      continue;
    }
    if (!record.stream.startsWith("assignment:")) continue;

    const assignmentBody = plainRecord(body?.body);
    const assignmentId = requiredString(
      record.stream.slice("assignment:".length),
      "Assignment stream id",
    );
    if (assignmentBody?.t === "received") {
      const envelope = plainRecord(assignmentBody.envelope);
      const activation = plainRecord(assignmentBody.activation);
      const activationRef = plainRecord(activation?.ref);
      roots.push({
        schema: "DispatchEnvelope",
        ref: requiredArtifactRef(envelope?.ref, "Received envelope ref"),
        assignmentId,
        execution: requiredExecution(
          activationRef?.execution,
          "Received activation execution",
        ),
      });
    } else if (assignmentBody?.t === "bundle_sealed") {
      roots.push({
        schema: "SealedBundle",
        ref: requiredArtifactRef(
          plainRecord(assignmentBody.bundle)?.ref,
          "Sealed bundle ref",
        ),
        assignmentId,
      });
      if (assignmentBody.mutationBatch !== undefined) {
        roots.push({
          schema: "MutationBatch",
          ref: requiredArtifactRef(
            plainRecord(assignmentBody.mutationBatch)?.ref,
            "Sealed mutation batch ref",
          ),
          assignmentId,
        });
      }
    }
  }
  return roots;
}

export function collectRegisteredArtifactReferences(
  root: RegisteredArtifactRoot,
  bytes: Uint8Array,
): ArtifactRef[] {
  let value: unknown;
  const text = Buffer.from(bytes).toString("utf8");
  try {
    value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text) {
      throw new TypeError("Artifact bytes are not canonical JSON");
    }
  } catch (error) {
    throw invalidRegisteredArtifact(root, "is not canonical JSON", error);
  }

  const envelope = plainRecord(value);
  try {
    if (root.schema === "SealedBundle") {
      const bundle = validateConversationSealedBundle(value as SealedBundle);
      if (bundle.assignmentId !== root.assignmentId) {
        throw new TypeError("assignmentId does not match its authority record");
      }
      return collectArtifactRefs(bundle);
    }
    if (root.schema === "MutationBatch") {
      const batch = validateMutationBatch(value as MutationBatch);
      if (batch.assignmentId !== root.assignmentId) {
        throw new TypeError("assignmentId does not match its authority record");
      }
      return collectArtifactRefs(batch);
    }
    if (envelope?.v !== 1) throw new TypeError("version must be 1");
    if (envelope.assignmentId !== root.assignmentId) {
      throw new TypeError("assignmentId does not match its authority record");
    }
    if (envelope.execution !== root.execution) {
      throw new TypeError("execution kind does not match its authority record");
    }
    if (!Array.isArray(envelope.dependencyArtifacts)) {
      throw new TypeError("dependencyArtifacts must be an array");
    }
    if (plainRecord(envelope.work) === undefined) {
      throw new TypeError("work must be a plain object");
    }
    return collectArtifactRefs(envelope);
  } catch (error) {
    throw invalidRegisteredArtifact(root, "does not match its registered schema", error);
  }
}

function requiredArtifactRef(value: unknown, label: string): ArtifactRef {
  try {
    assertArtifactRef(value);
    return value;
  } catch (error) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} is invalid`,
      { cause: error },
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requiredExecution(value: unknown, label: string): ExecutionKind {
  if (value !== "conversation" && value !== "job") {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} must identify a supported execution kind`,
    );
  }
  return value;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

function invalidRegisteredArtifact(
  root: RegisteredArtifactRoot,
  reason: string,
  cause: unknown,
): AuthorityStorageError {
  return new AuthorityStorageError(
    "invalid-authority-record",
    `${root.schema} artifact ${root.ref.digest} ${reason}`,
    { cause },
  );
}
