import { describe, expect, it, vi } from "vitest";
import { AgentError, userMessage } from "@zhixing/core";
import {
  assertKernelTerminal,
  createKernelRunCompletion,
  projectAgentResultToKernelTerminal,
} from "../kernel-terminal.js";

const usage = { inputTokens: 3, outputTokens: 5 } as const;

describe("KernelTerminal", () => {
  it("projects the complete four-terminal exact-set into fresh immutable values", () => {
    const message = userMessage("done");
    const completedUsage = { inputTokens: 3, outputTokens: 5 };
    const completed = projectAgentResultToKernelTerminal({
      reason: "completed",
      message,
      usage: completedUsage,
    });
    const terminals = [
      completed,
      projectAgentResultToKernelTerminal({
        reason: "max_turns",
        maxTurns: 7,
        usage,
      }),
      projectAgentResultToKernelTerminal({
        reason: "aborted",
        usage,
        abortReason: {
          kind: "user-cancel",
          source: "rpc",
          pressedAt: 42,
        },
        exitDelayMs: 11,
      }),
      projectAgentResultToKernelTerminal({
        reason: "error",
        error: new AgentError("provider failed", "provider_error", true),
        usage,
      }),
    ];

    expect(terminals.map((terminal) => terminal.reason)).toEqual([
      "completed",
      "max_turns",
      "aborted",
      "error",
    ]);
    expect(completed.message).not.toBe(message);
    expect(completed.usage).not.toBe(completedUsage);
    const originalBlock = message.content[0];
    if (originalBlock?.type !== "text") throw new Error("expected text block");
    originalBlock.text = "mutated after projection";
    completedUsage.inputTokens = 99;
    expect(completed.message).toEqual(userMessage("done"));
    expect(completed.usage.inputTokens).toBe(3);
    expect(terminals[3]).toEqual({
      reason: "error",
      error: {
        name: "AgentError",
        message: "provider failed",
        type: "provider_error",
        recoverable: true,
      },
      usage,
    });
    for (const terminal of terminals) {
      expect(() => assertKernelTerminal(terminal)).not.toThrow();
      expect(Object.isFrozen(terminal)).toBe(true);
      expect(Object.isFrozen(terminal.usage)).toBe(true);
    }
  });

  it("rejects unknown and incomplete internal or Kernel terminal variants", () => {
    expect(() =>
      projectAgentResultToKernelTerminal({ reason: "future", usage }),
    ).toThrow("Unknown AgentResult terminal");
    expect(() =>
      projectAgentResultToKernelTerminal({ reason: "completed", usage }),
    ).toThrow("Incomplete AgentResult terminal");
    expect(() => assertKernelTerminal({ reason: "future", usage })).toThrow(
      "Unknown Kernel terminal",
    );
    expect(() =>
      assertKernelTerminal({ reason: "error", usage, error: { message: "x" } }),
    ).toThrow("Incomplete Kernel terminal");
  });

  it("shallow-seals one transferred artifact graph without cloning it", () => {
    const terminal = projectAgentResultToKernelTerminal({
      reason: "max_turns",
      maxTurns: 2,
      usage,
    });
    const runRecord = {
      timestamp: "2026-08-29T00:00:00.000Z",
      messages: [userMessage("question")],
      usage,
    };
    const newMessages = [userMessage("answer")];
    const pendingPostTurnControl = { intent: { kind: "exit" as const } };
    const artifacts = {
      runRecord,
      newMessages,
      durationMs: 9,
      pendingPostTurnControl,
    };
    const clone = vi.spyOn(globalThis, "structuredClone");
    const completion = createKernelRunCompletion(terminal, artifacts);

    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
    expect(completion.terminal).toBe(terminal);
    expect(completion.artifacts).not.toBe(artifacts);
    expect(completion.artifacts.runRecord).toBe(runRecord);
    expect(completion.artifacts.newMessages).toBe(newMessages);
    expect(completion.artifacts.pendingPostTurnControl).toBe(
      pendingPostTurnControl,
    );
    artifacts.durationMs = 99;
    expect(completion.artifacts.durationMs).toBe(9);
    expect(Object.isFrozen(completion)).toBe(true);
    expect(Object.isFrozen(completion.artifacts)).toBe(true);
    expect(Object.isFrozen(completion.artifacts.runRecord.messages)).toBe(false);
  });
});
