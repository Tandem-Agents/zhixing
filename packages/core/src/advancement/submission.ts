import { protocolDigest } from "../protocol/index.js";
import type { Digest } from "../types/distributed.js";

/** Authenticated binding identity; the domain owns the durable disposition. */
export interface AdvancementSubmissionIdentity {
  readonly surfacePrincipal: string;
  readonly submissionId: string;
  readonly requestDigest: Digest;
}

export type AdvancementSubmissionRejectionCode = "conversation-busy" | "advancement-session-not-found" | "not-awaiting-rubric-confirmation" | "pending-rubric-draft-missing" | "rubric-draft-stale";

export type AdvancementSubmissionOutcome =
  | { readonly kind: "rejected"; readonly code: AdvancementSubmissionRejectionCode }
  | { readonly kind: "draft-saved"; readonly disposition: "original-saved" | "revision-saved"; readonly sessionId: string; readonly draftId: string; readonly draftVersion: number; readonly originalTurnId: string }
  | { readonly kind: "not-saved"; readonly sessionId: string; readonly draftId: string; readonly originalTurnId: string }
  | { readonly kind: "original-task-intent"; readonly mode: "advancement" | "direct"; readonly sessionId: string; readonly originalTurnId: string }
  | { readonly kind: "cancelled"; readonly sessionId: string }
  | { readonly kind: "contract-failed"; readonly code: "rubric-generation-failed" | "rubric-revision-failed" };

export interface AdvancementSubmissionReceipt {
  readonly identity: AdvancementSubmissionIdentity;
  readonly outcome: AdvancementSubmissionOutcome;
}

export interface AdvancementSubmissionSettledEvent {
  readonly type: "submission_settled";
  readonly conversationId: string;
  readonly timestamp: string;
  readonly sessionId?: never;
  readonly receipt: AdvancementSubmissionReceipt;
}

export function advancementSubmissionRequestId(conversationId: string, surfacePrincipal: string, submissionId: string): string {
  return "adv-sub:" + protocolDigest("AdvancementSubmissionIdentity", 1, { conversationId, surfacePrincipal, submissionId });
}

export function isAdvancementSubmissionReceipt(value: unknown): value is AdvancementSubmissionReceipt {
  if (!record(value) || !keys(value, ["identity", "outcome"])) return false;
  const id = value.identity, out = value.outcome;
  if (!record(id) || !keys(id, ["surfacePrincipal", "submissionId", "requestDigest"]) ||
      !identifier(id.surfacePrincipal) || !identifier(id.submissionId) || typeof id.requestDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(id.requestDigest) || !record(out)) return false;
  switch (out.kind) {
    case "draft-saved": return keys(out, ["kind", "disposition", "sessionId", "draftId", "draftVersion", "originalTurnId"]) &&
      (out.disposition === "original-saved" || out.disposition === "revision-saved") && identifier(out.sessionId) &&
      identifier(out.draftId) && identifier(out.originalTurnId) && Number.isSafeInteger(out.draftVersion) && Number(out.draftVersion) >= 0;
    case "not-saved": return keys(out, ["kind", "sessionId", "draftId", "originalTurnId"]) && identifier(out.sessionId) && identifier(out.draftId) && identifier(out.originalTurnId);
    case "original-task-intent": return keys(out, ["kind", "mode", "sessionId", "originalTurnId"]) &&
      (out.mode === "direct" || out.mode === "advancement") && identifier(out.sessionId) && identifier(out.originalTurnId);
    case "cancelled": return keys(out, ["kind", "sessionId"]) && identifier(out.sessionId);
    case "rejected": return keys(out, ["kind", "code"]) && ["conversation-busy", "advancement-session-not-found", "not-awaiting-rubric-confirmation", "pending-rubric-draft-missing", "rubric-draft-stale"].includes(String(out.code));
    case "contract-failed": return keys(out, ["kind", "code"]) && (out.code === "rubric-generation-failed" || out.code === "rubric-revision-failed");
    default: return false;
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]) { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)); }
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }

export function advancementSubmissionOutcome(event: Exclude<import("./types.js").AdvancementControlEvent, { readonly type: "submission_settled" }>, previous?: import("./types.js").AdvancementSession | null): AdvancementSubmissionOutcome {
    switch (event.type) {
      case "session_created": return { kind: "draft-saved", disposition: "original-saved", sessionId: event.sessionId, draftId: event.pendingRubricDraft.draftId, draftVersion: 0, originalTurnId: event.pendingRubricDraft.originalTurnId };
      case "session_regenerated": return { kind: "draft-saved", disposition: "revision-saved", sessionId: event.nextSessionId, draftId: event.pendingRubricDraft.draftId, draftVersion: 0, originalTurnId: event.pendingRubricDraft.originalTurnId };
      case "rubric_draft_revised": {
        if (!previous) throw Error("Advancement revision target is missing");
        return { kind: "draft-saved", disposition: "revision-saved", sessionId: event.sessionId, draftId: event.pendingRubricDraft.draftId, draftVersion: previous.rubricDraftVersion + 1, originalTurnId: event.pendingRubricDraft.originalTurnId };
      }
      case "rubric_confirmed":
      case "original_task_directed": return { kind: "original-task-intent", mode: event.type === "rubric_confirmed" ? "advancement" : "direct", sessionId: event.sessionId, originalTurnId: event.admissionIntent.turnId };
      case "cancelled": return { kind: "cancelled", sessionId: event.sessionId };
      default: throw Error("Advancement transition does not settle a surface submission");
    }
}
