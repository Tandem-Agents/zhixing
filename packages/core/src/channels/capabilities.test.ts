import { describe, it, expect, vi } from "vitest";
import {
  isEditable,
  isStreamable,
  isApprovable,
  isThreadable,
  isReactable,
  isTyping,
} from "./capabilities.js";
import type { ChannelAdapter } from "./types.js";

function bareAdapter(): ChannelAdapter {
  return {
    id: "bare",
    capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
  };
}

describe("capability type guards", () => {
  it("isEditable returns false for bare adapter", () => {
    expect(isEditable(bareAdapter())).toBe(false);
  });

  it("isEditable returns true when editMessage is present", () => {
    const a = { ...bareAdapter(), editMessage: vi.fn(), deleteMessage: vi.fn() };
    expect(isEditable(a)).toBe(true);
  });

  it("isStreamable returns false for bare adapter", () => {
    expect(isStreamable(bareAdapter())).toBe(false);
  });

  it("isStreamable returns true when createStreamMessage is present", () => {
    const a = { ...bareAdapter(), createStreamMessage: vi.fn() };
    expect(isStreamable(a)).toBe(true);
  });

  it("isApprovable detects renderApproval", () => {
    expect(isApprovable(bareAdapter())).toBe(false);
    expect(isApprovable({ ...bareAdapter(), renderApproval: vi.fn() })).toBe(true);
  });

  it("isThreadable detects resolveThread", () => {
    expect(isThreadable(bareAdapter())).toBe(false);
    expect(isThreadable({ ...bareAdapter(), resolveThread: vi.fn(), sendToThread: vi.fn() })).toBe(true);
  });

  it("isReactable detects addReaction", () => {
    expect(isReactable(bareAdapter())).toBe(false);
    expect(isReactable({ ...bareAdapter(), addReaction: vi.fn(), removeReaction: vi.fn() })).toBe(true);
  });

  it("isTyping detects sendTyping", () => {
    expect(isTyping(bareAdapter())).toBe(false);
    expect(isTyping({ ...bareAdapter(), sendTyping: vi.fn(), stopTyping: vi.fn() })).toBe(true);
  });
});
