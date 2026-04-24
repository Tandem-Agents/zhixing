import { describe, expect, it } from "vitest";
import { userMessage } from "../../types/messages.js";
import { AgentError, isAgentError } from "../../types/errors.js";
import { resolveContextManager } from "../termination.js";
import type {
  ContextManagerHook,
  ContextManagerInput,
  ContextManagerOutput,
} from "../types.js";

// ─── 测试辅助 ───

function makeInput(overrides?: Partial<ContextManagerInput>): ContextManagerInput {
  return {
    messages: [userMessage("hi")],
    turnCount: 1,
    abortSignal: undefined,
    ...overrides,
  };
}

function makeHook(
  onTurnComplete: (input: ContextManagerInput) => Promise<ContextManagerOutput>,
): ContextManagerHook {
  return { onTurnComplete };
}

// ─── 分支测试 ───

describe("resolveContextManager", () => {
  it("hook=undefined → kind='ok', modified:false, messages 原样（调用方无依赖路径）", async () => {
    const messages = [userMessage("first"), userMessage("second")];
    const term = await resolveContextManager(
      undefined,
      makeInput({ messages }),
      undefined,
      "any-path",
    );

    expect(term.kind).toBe("ok");
    if (term.kind !== "ok") throw new Error("narrowing");
    expect(term.output.modified).toBe(false);
    // 不应是同一引用（避免调用方误改 input）
    expect(term.output.messages).not.toBe(messages);
    expect(term.output.messages).toEqual(messages);
  });

  it("hook 抛非 AgentError → kind='error', 包装为 AgentError(type='unknown', cause 保留)", async () => {
    const originalError = new Error("something broke in engine");
    const hook = makeHook(async () => {
      throw originalError;
    });

    const term = await resolveContextManager(hook, makeInput(), undefined, "tool loop");

    expect(term.kind).toBe("error");
    if (term.kind !== "error") throw new Error("narrowing");
    expect(isAgentError(term.error)).toBe(true);
    expect(term.error.type).toBe("unknown");
    expect(term.error.cause).toBe(originalError);
    expect(term.error.message).toBe("something broke in engine");
  });

  it("hook 抛错 + abortSignal 已 aborted → kind='aborted'（abort 优先，第三方 strategy 忘捕 AbortError 也归用户意图）", async () => {
    // 场景：第三方 CompactionStrategy 作者忘记在 apply 里捕获 AbortError，
    // engine 会 rethrow。本测试保证此时仍归类为 "aborted" 而非 "error:unknown"，
    // 与下面"failed + abort → aborted"形成对称契约（见 resolveContextManager 规则 #2）
    const controller = new AbortController();
    controller.abort();

    const hook = makeHook(async () => {
      throw new Error("3rd-party strategy forgot to catch AbortError");
    });

    const term = await resolveContextManager(
      hook,
      makeInput({ abortSignal: controller.signal }),
      controller.signal,
      "tool loop",
    );

    expect(term.kind).toBe("aborted");
  });

  it("hook 抛 AgentError → kind='error', 原对象原样透传（type/cause 不被二次包装）", async () => {
    const originalError = new AgentError("rate limited", "rate_limit", true);
    const hook = makeHook(async () => {
      throw originalError;
    });

    const term = await resolveContextManager(hook, makeInput(), undefined, "pure-text return");

    expect(term.kind).toBe("error");
    if (term.kind !== "error") throw new Error("narrowing");
    expect(term.error).toBe(originalError);
    expect(term.error.type).toBe("rate_limit");
  });

  it("output.failed=true + abortSignal.aborted → kind='aborted'（abort 优先于 context_overflow）", async () => {
    // 长 session 里 abort 恰好发生在 compact 期间：strategy 静默返 compacted:false，
    // engine 按 critical 返 failed:true；正确归类应是 "aborted" 而非 "context_overflow"
    const controller = new AbortController();
    controller.abort();

    const hook = makeHook(async () => ({
      messages: [userMessage("x")],
      modified: false,
      failed: true,
    }));

    const term = await resolveContextManager(
      hook,
      makeInput({ abortSignal: controller.signal }),
      controller.signal,
      "tool loop",
    );

    expect(term.kind).toBe("aborted");
  });

  it("output.failed=true + 非 abort → kind='error', AgentError.type='context_overflow', recoverable=false, pathLabel 在消息中", async () => {
    const hook = makeHook(async () => ({
      messages: [userMessage("x")],
      modified: false,
      failed: true,
    }));

    const term = await resolveContextManager(hook, makeInput(), undefined, "pre-flight");

    expect(term.kind).toBe("error");
    if (term.kind !== "error") throw new Error("narrowing");
    expect(term.error.type).toBe("context_overflow");
    expect(term.error.recoverable).toBe(false);
    expect(term.error.message).toContain("pre-flight");
  });

  it("output 正常（failed=undefined） → kind='ok', output 原样传递 modified/messages", async () => {
    const newMessages = [userMessage("compacted")];
    const hook = makeHook(async () => ({
      messages: newMessages,
      modified: true,
    }));

    const term = await resolveContextManager(hook, makeInput(), undefined, "tool loop");

    expect(term.kind).toBe("ok");
    if (term.kind !== "ok") throw new Error("narrowing");
    expect(term.output.modified).toBe(true);
    expect(term.output.messages).toBe(newMessages);
  });

  it("output 正常（failed=false 显式） → kind='ok'（不把 false 误判为终止）", async () => {
    const hook = makeHook(async () => ({
      messages: [userMessage("ok")],
      modified: false,
      failed: false,
    }));

    const term = await resolveContextManager(hook, makeInput(), undefined, "tool loop");

    expect(term.kind).toBe("ok");
  });
});
