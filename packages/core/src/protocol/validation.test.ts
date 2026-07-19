import {
  MAX_CONVERSATION_QUESTION_BYTES,
  type TaskDefinition,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { validateTaskDefinition } from "./job.js";
import { validateConversationInvocation } from "./assignment.js";
import {
  isPrefixedUlid,
  isProtocolIdentifier,
  MAX_PROTOCOL_IDENTIFIER_LENGTH,
} from "./validation.js";

function taskDefinition(channel: string): TaskDefinition {
  return {
    taskId: "task-1",
    taskRevision: 1,
    state: "enabled",
    definition: {
      kind: "user",
      spec: {
        name: "bounded delivery identity",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "run" },
        delivery: { kind: "channel", channel, to: "chat-1" },
      },
    },
  };
}

describe("protocol identifier boundary", () => {
  it("validates the exact prefixed ULID alphabet and length", () => {
    expect(isPrefixedUlid("dlv-01KXPWTM80BYB4SH423EJT1CVN", "dlv-")).toBe(true);
    expect(isPrefixedUlid("item-01KXPWTM80BYB4SH423EJT1CVN", "dlv-")).toBe(false);
    expect(isPrefixedUlid("dlv-01KXPWTM80BYB4SH423EJT1CVI", "dlv-")).toBe(false);
    expect(isPrefixedUlid("dlv-81KXPWTM80BYB4SH423EJT1CVN", "dlv-")).toBe(false);
  });

  it("uses one accepted domain at the task-definition source", () => {
    const boundary = "c".repeat(MAX_PROTOCOL_IDENTIFIER_LENGTH);
    const overflow = `${boundary}c`;

    expect(isProtocolIdentifier(boundary)).toBe(true);
    expect(isProtocolIdentifier(overflow)).toBe(false);
    expect(validateTaskDefinition(taskDefinition(boundary))).toEqual(
      taskDefinition(boundary),
    );
    expect(() => validateTaskDefinition(taskDefinition(overflow))).toThrow(
      "Delivery channel must be a non-empty bounded string",
    );
  });
});

describe("conversation invocation contract", () => {
  it("accepts closed agent and perspectives invocation snapshots", () => {
    expect(
      validateConversationInvocation({
        kind: "agent",
        source: "advancement",
        advancement: {
          sessionId: "advancement-1",
          proxyMessageId: "proxy-1",
        },
      }),
    ).toEqual({
      kind: "agent",
      source: "advancement",
      advancement: {
        sessionId: "advancement-1",
        proxyMessageId: "proxy-1",
      },
    });
    expect(
      validateConversationInvocation({
        kind: "perspectives",
        source: "channel",
        question: "Review this decision",
      }),
    ).toEqual({
      kind: "perspectives",
      source: "channel",
      question: "Review this decision",
    });
  });

  it("rejects incomplete, cross-kind, and open invocation payloads", () => {
    expect(() =>
      validateConversationInvocation({ kind: "agent", source: "advancement" }),
    ).toThrow("Advancement invocation metadata");
    expect(() =>
      validateConversationInvocation({
        kind: "agent",
        source: "channel",
        advancement: { sessionId: "advancement-1" },
      }),
    ).toThrow("Only advancement");
    expect(() =>
      validateConversationInvocation({
        kind: "perspectives",
        source: "channel",
        question: "review",
        future: true,
      }),
    ).toThrow("fields are incomplete or unknown");
  });

  it("enforces the frozen UTF-8 question budget at the protocol boundary", () => {
    const exactAscii = "q".repeat(MAX_CONVERSATION_QUESTION_BYTES);
    const exactUnicode = "界".repeat(Math.floor(MAX_CONVERSATION_QUESTION_BYTES / 3));
    expect(() =>
      validateConversationInvocation({
        kind: "perspectives",
        source: "interactive",
        question: exactAscii,
      }),
    ).not.toThrow();
    expect(() =>
      validateConversationInvocation({
        kind: "perspectives",
        source: "interactive",
        question: `${exactUnicode}界`,
      }),
    ).toThrow("UTF-8 budget");
    expect(() =>
      validateConversationInvocation({
        kind: "perspectives",
        source: "interactive",
        question: `${exactAscii}q`,
      }),
    ).toThrow("UTF-8 budget");
  });
});
