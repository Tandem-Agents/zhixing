import { describe, expect, it } from "vitest";
import type { DeferredGlobalIntent, IntentStreamRecord } from "../contracts/index.js";
import {
  deferredIntentStream,
  isDeferredIntentStream,
  reduceDeferredGlobalIntent,
  validateDeferredGlobalIntent,
  validateIntentStreamRecord,
} from "./deferred-global-intent.js";

const RECORDED = "2026-08-07T08:00:00.000Z";
const REVIEWED = "2026-08-07T08:00:01.000Z";

function pending(): DeferredGlobalIntent {
  return {
    intentId: "int-01K1ZZZZZZ0000000000000000",
    localDomainId: "local:device-a",
    conversationId: "local-12345678-01K1ZZZZZZ0000000000000000",
    mutation: {
      kind: "schedule-delete",
      taskId: "task-a",
      taskRevision: 3,
    },
    recordedAt: RECORDED,
    timeSensitive: true,
    status: "pending",
  };
}

describe("deferred global intent contract", () => {
  it("accepts the closed schedule/rubric union and binds records to the conversation stream", () => {
    const value = pending();
    expect(() => validateDeferredGlobalIntent(value)).not.toThrow();
    expect(() => validateIntentStreamRecord(
      { t: "intent", intent: value },
      deferredIntentStream(value.conversationId),
    )).not.toThrow();

    const rubric: DeferredGlobalIntent = {
      ...value,
      mutation: {
        kind: "rubric-update-own",
        rubricId: "quality",
        expectedRevision: 2,
        rubric: {
          title: "质量",
          description: "验收质量",
          content: { digest: `sha256:${"a".repeat(64)}`, bytes: 12 },
        },
      },
      timeSensitive: false,
    };
    expect(() => validateDeferredGlobalIntent(rubric)).not.toThrow();
    expect(isDeferredIntentStream(deferredIntentStream(value.conversationId))).toBe(true);
    expect(isDeferredIntentStream("intent:rubric-registry")).toBe(false);
  });

  it("rejects unknown fields, wrong family classification, wrong stream and time inversion", () => {
    expect(() => validateDeferredGlobalIntent({ ...pending(), extra: true })).toThrow();
    expect(() => validateDeferredGlobalIntent({ ...pending(), timeSensitive: false })).toThrow();
    expect(() => validateIntentStreamRecord(
      { t: "intent", intent: pending() },
      "intent:another-conversation",
    )).toThrow();
    expect(() => validateDeferredGlobalIntent({
      ...pending(),
      status: "confirmed",
      reviewedAt: "2026-08-07T07:59:59.000Z",
    })).toThrow();
  });

  it("allows one pending-to-terminal transition and rejects identity change or terminal rewrite", () => {
    const first: IntentStreamRecord = { t: "intent", intent: pending() };
    const current = reduceDeferredGlobalIntent(undefined, first);
    const confirmed: IntentStreamRecord = {
      t: "intent",
      intent: { ...pending(), status: "confirmed", reviewedAt: REVIEWED },
    };
    const terminal = reduceDeferredGlobalIntent(current, confirmed);
    expect(terminal.status).toBe("confirmed");
    expect(() => reduceDeferredGlobalIntent(terminal, {
      t: "intent",
      intent: { ...pending(), status: "discarded", reviewedAt: REVIEWED },
    })).toThrow();
    expect(() => reduceDeferredGlobalIntent(current, {
      t: "intent",
      intent: {
        ...pending(),
        localDomainId: "local:device-b",
        status: "confirmed",
        reviewedAt: REVIEWED,
      },
    })).toThrow();
  });
});
