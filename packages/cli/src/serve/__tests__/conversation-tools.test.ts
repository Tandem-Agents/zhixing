import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@zhixing/core/events";
import type { AgentEventMap } from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { SkillCatalogLoadApplicationService } from "@zhixing/core/skills/catalog";
import { builtinIndexEntries } from "../../../../core/src/skills/builtin.js";
import { skillNameToId } from "@zhixing/core/skills/id";
import { BUILTIN_TOOL_FACTORIES } from "@zhixing/tools-builtin";
import { createConversationTool } from "../conversation-tools.js";
import { discoverConversations } from "../conversation-communication-binding.js";

describe("conversation model entry", () => {
  const context = { workingDirectory: ".", turnId: "run-a", toolCallId: "call-send" };
  const inConversation = <T>(operation: () => Promise<T>, id = "source-a") =>
    runContextStorage.run(
      { bus: createEventBus<AgentEventMap>(), lineage: "main", conversationId: id },
      operation,
    );

  it.each([
    "main",
    "work",
  ] as const)("discovers and loads the builtin skill in %s without user installation", async (mode) => {
    const id = skillNameToId("对话通信");
    expect(
      builtinIndexEntries(mode, new Set()).find((entry) => entry.id === id)?.description,
    ).toContain("联系其他对话");
    const readContent = vi.fn();
    const stageUsage = vi.fn();
    const load = BUILTIN_TOOL_FACTORIES.load_skill({
      skillCatalogLoad: new SkillCatalogLoadApplicationService({
        readScope: async () => ({ kind: "builtin-only" }),
        readContent,
        stageUsage,
      }),
    } as never);
    const result = await load.call({ id }, context);
    expect(result.isError).toBe(false);
    for (const action of ["discover", "read", "send", "observe"])
      expect(result.content).toContain(action);
    expect(result.content).toContain("不必轮询等待");
    expect(readContent).not.toHaveBeenCalled();
    expect(stageUsage).not.toHaveBeenCalled();
  });

  it("binds source/retry identity to execution, defaults read to self and preserves receipts", async () => {
    const invoke = vi.fn(async () => ({
      accepted: true,
      messageId: "m",
      runId: "b-run",
      conversationId: "b",
    }));
    const tool = createConversationTool({ invoke });
    await inConversation(() => tool.call({ action: "read" }, context));
    expect(invoke).toHaveBeenLastCalledWith("source-a", {
      action: "read",
      conversationId: "source-a",
    });
    const request = { action: "send", conversationId: "b", input: "核实后回信" };
    const first = await inConversation(() => tool.call(request, context));
    expect(first.isError).toBe(false);
    const original = invoke.mock.calls.at(-1);
    expect(JSON.parse(first.content)).toMatchObject({ accepted: true, messageId: "m" });
    await inConversation(() => tool.call(request, context));
    expect(invoke.mock.calls.at(-1)).toEqual(original);
    await inConversation(() => tool.call(request, { ...context, toolCallId: "next" }));
    expect(invoke.mock.calls.at(-1)).not.toEqual(original);
    expect(request).not.toHaveProperty("operationId");
  });

  it("rejects model-supplied source/operation identities, malformed reads and missing runtime", async () => {
    const invoke = vi.fn();
    const tool = createConversationTool({ invoke });
    for (const fields of [
      { sourceConversationId: "forged" },
      { operationId: "forged" },
      { source: { kind: "user" } },
    ]) {
      expect(
        (
          await inConversation(() =>
            tool.call(
              { action: "send", conversationId: "b", input: "message", ...fields },
              context,
            ),
          )
        ).isError,
      ).toBe(true);
    }
    expect(
      (await inConversation(() => tool.call({ action: "read", before: { shardId: "s" } }, context)))
        .isError,
    ).toBe(true);
    expect((await tool.call({ action: "discover" }, context)).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not claim success or auto retry when the target is unavailable", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("目标设备离线");
    });
    const result = await inConversation(() =>
      createConversationTool({ invoke }).call(
        { action: "send", conversationId: "b", input: "消息" },
        context,
      ),
    );
    expect(result).toEqual({ content: "目标设备离线", isError: true });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("merges available owner directories without losing summaries or hiding partial discovery", async () => {
    const entry = { conversationId: "b", name: "审查", summary: "已核实", busy: true };
    const port = { invoke: async () => ({ conversations: [entry] }) };
    expect(
      await discoverConversations(
        [
          port,
          port,
          {
            invoke: async () => {
              throw new Error("offline");
            },
          },
        ],
        "a",
      ),
    ).toEqual({ conversations: [entry], partial: true });
  });
});
