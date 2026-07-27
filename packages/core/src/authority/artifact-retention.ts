import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  LogicalRecord,
  MutationBatch,
  SealedBundle,
} from "../contracts/index.js";
import type { OutboundContentDto } from "../channels/types.js";
import {
  canonicalize,
  isProtocolIdentifier,
  validateMutationBatch,
  validateSealedBundle,
} from "../protocol/index.js";
import { assertArtifactRef, collectArtifactRefs } from "./artifact-references.js";
import { validateAdmittedControlEnvelope } from "./control-artifacts.js";
import { AuthorityStorageError } from "./errors.js";
import { validateOutboundContentDto } from "../delivery/content-schema.js";
import { isDeliveryItemId } from "../delivery/validation.js";

type ExecutionKind = "conversation" | "job";

export type RegisteredArtifactRoot =
  | {
      readonly schema: "ControlEnvelope";
      readonly ref: ArtifactRef;
      readonly requestId: string;
    }
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
      readonly execution?: ExecutionKind;
    }
  | {
      readonly schema: "MutationBatch";
      readonly ref: ArtifactRef;
      readonly assignmentId: string;
    }
  | {
      readonly schema: "DeliveryContent";
      readonly ref: ArtifactRef;
      readonly itemId: string;
    };

export function collectRegisteredArtifactRoots(
  records: readonly LogicalRecord<unknown>[],
): RegisteredArtifactRoot[] {
  const roots: RegisteredArtifactRoot[] = [];
  for (const record of records) {
    const body = plainRecord(record.body);
    if (record.stream === "control" && body?.t === "received") {
      const envelope = plainRecord(body.envelope);
      if (envelope?.ref !== undefined) {
        assertStoredReference(envelope, "Received control envelope");
        roots.push({
          schema: "ControlEnvelope",
          ref: requiredArtifactRef(envelope.ref, "Received control envelope ref"),
          requestId: requiredString(body.requestId, "Received control requestId"),
        });
      }
      continue;
    }
    if (record.stream === "delivery" && body?.t === "enqueued") {
      const intent = plainRecord(body.intent);
      const content = plainRecord(intent?.content);
      if (content?.ref !== undefined) {
        roots.push({
          schema: "DeliveryContent",
          ref: requiredArtifactRef(content.ref, "Delivery content ref"),
          itemId: requiredDeliveryItemId(body.itemId),
        });
      }
      continue;
    }
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
          execution: record.stream.startsWith("run:") ? "conversation" : "job",
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

export interface ConversationLeafReference {
  readonly ref: ArtifactRef;
  readonly conversationId: string;
}

export interface ClassifiedArtifactReferences {
  readonly unconditional: readonly ArtifactRef[];
  readonly conversationLeaves: readonly ConversationLeafReference[];
}

/** Capability bindings name assets without making the authority log their owner. */
export function isRetainingAuthorityRecord(
  record: LogicalRecord<unknown>,
): boolean {
  const body = plainRecord(record.body);
  return !(record.stream === "control" && body?.t === "asset-grant-issued");
}

/**
 * 注册 root 解引用后的唯一分类点:会话执行产物中的内容资产本体(叶)
 * 由会话所有权决定保留,其余(容器、闭包、依赖)无条件保留。
 * 未在此登记叶位置的 schema 默认全部无条件保留——缺省保守,不会误删。
 */
export function classifyRegisteredArtifactReferences(
  root: RegisteredArtifactRoot,
  bytes: Uint8Array,
): ClassifiedArtifactReferences {
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
    if (root.schema === "DeliveryContent") {
      validateOutboundContentDto(value);
      return unconditionalOnly(value as OutboundContentDto);
    }
    if (root.schema === "ControlEnvelope") {
      const control = validateAdmittedControlEnvelope(value);
      if (control.requestId !== root.requestId) {
        throw new TypeError("requestId does not match its authority record");
      }
      if (control.body.t === "input" && control.body.attachments !== undefined) {
        const { attachments, ...restBody } = control.body;
        return classifiedReferences(
          { ...control, body: restBody },
          attachments,
          control.body.conversationId,
        );
      }
      return unconditionalOnly(control);
    }
    if (root.schema === "SealedBundle") {
      const bundle = validateSealedBundle(value as SealedBundle);
      if (bundle.assignmentId !== root.assignmentId) {
        throw new TypeError("assignmentId does not match its authority record");
      }
      if (root.execution !== undefined && bundle.body.t !== root.execution) {
        throw new TypeError("execution kind does not match its authority record");
      }
      if (bundle.body.t === "conversation") {
        const { contentAssets, ...restBody } = bundle.body;
        return classifiedReferences(
          { ...bundle, body: restBody },
          contentAssets,
          bundle.body.conversationId,
        );
      }
      return unconditionalOnly(bundle);
    }
    if (root.schema === "MutationBatch") {
      const batch = validateMutationBatch(value as MutationBatch);
      if (batch.assignmentId !== root.assignmentId) {
        throw new TypeError("assignmentId does not match its authority record");
      }
      return unconditionalOnly(batch);
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
    const work = plainRecord(envelope.work);
    if (work === undefined) {
      throw new TypeError("work must be a plain object");
    }
    if (
      root.execution === "conversation" &&
      typeof work.conversationId === "string" &&
      Array.isArray(work.contentAssets)
    ) {
      const { contentAssets, ...restWork } = work;
      return classifiedReferences(
        { ...envelope, work: restWork },
        contentAssets,
        requiredString(work.conversationId, "Dispatch conversationId"),
      );
    }
    return unconditionalOnly(envelope);
  } catch (error) {
    throw invalidRegisteredArtifact(root, "does not match its registered schema", error);
  }
}

/**
 * 记录级内容叶分类:附件与内容资产索引条目按其会话归属计为叶;
 * 其余字段(含外置容器)无条件保留。与注册 root 分类共用同一缺省纪律。
 */
export function classifyRetainedRecordReferences(
  record: LogicalRecord<unknown>,
): ClassifiedArtifactReferences {
  if (!isRetainingAuthorityRecord(record)) {
    return { unconditional: [], conversationLeaves: [] };
  }
  const body = plainRecord(record.body);
  if (record.stream.startsWith("run:") && body) {
    const conversationId = requiredString(
      record.stream.slice("run:".length),
      "Run stream conversationId",
    );
    if (body.t === "admitted" && Array.isArray(body.attachments)) {
      const { attachments, ...rest } = body;
      return classifiedReferences(
        { ...record, body: rest },
        attachments,
        conversationId,
      );
    }
    if (body.kind === "content-asset-index" && Array.isArray(body.entries)) {
      const { entries, ...rest } = body;
      return classifiedReferences(
        { ...record, body: rest },
        entries,
        conversationId,
      );
    }
  }
  if (record.stream === "control" && body?.t === "received") {
    const envelope = plainRecord(body.envelope);
    const envelopeBody = plainRecord(envelope?.body);
    if (
      envelope &&
      envelopeBody?.t === "input" &&
      typeof envelopeBody.conversationId === "string" &&
      Array.isArray(envelopeBody.attachments)
    ) {
      const { attachments, ...restBody } = envelopeBody;
      return classifiedReferences(
        {
          ...record,
          body: { ...body, envelope: { ...envelope, body: restBody } },
        },
        attachments,
        requiredString(envelopeBody.conversationId, "Input conversationId"),
      );
    }
  }
  return unconditionalOnly(record);
}

/** 会话删除 tombstone:内容叶所有权的唯一削除事实。 */
export function deletedConversationOf(
  record: LogicalRecord<unknown>,
): string | undefined {
  if (!record.stream.startsWith("run:")) return undefined;
  const body = plainRecord(record.body);
  return body?.t === "session-lifecycle" && body.mutation === "delete"
    ? record.stream.slice("run:".length)
    : undefined;
}

function classifiedReferences(
  remainder: unknown,
  leafValues: readonly unknown[],
  conversationId: string,
): ClassifiedArtifactReferences {
  return {
    unconditional: collectArtifactRefs([remainder]),
    conversationLeaves: collectArtifactRefs(leafValues).map((ref) => ({
      ref,
      conversationId,
    })),
  };
}

function unconditionalOnly(value: unknown): ClassifiedArtifactReferences {
  return { unconditional: collectArtifactRefs([value]), conversationLeaves: [] };
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

function assertStoredReference(
  value: Record<string, unknown>,
  label: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "ref") {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} must contain only ref`,
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (!isProtocolIdentifier(value)) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} must be a non-empty bounded string`,
    );
  }
  return value;
}

function requiredDeliveryItemId(value: unknown): string {
  if (!isDeliveryItemId(value)) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      "Delivery item id must be dlv-<Ulid>",
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
