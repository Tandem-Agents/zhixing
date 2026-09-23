import { describe, expect, it, vi } from "vitest";
import { ConfirmationBroker, type ConfirmationRequest } from "@zhixing/core/confirmation";
import {
  DurableConversationInteractionObserver,
  type DurableInteractionBinding,
} from "./durable-conversation-interactions.js";

describe("DurableConversationInteractionObserver", () => {
  it("delivers only the bound broker, denies an inherited child, and closes through the durable answer path", async () => {
    const observer = new DurableConversationInteractionObserver();
    const broker = new ConfirmationBroker({ lifecycleObserver: observer });
    const child = new ConfirmationBroker({ parentBrokerId: broker.id, lifecycleObserver: observer });
    const finishAndMirror = vi.fn(async () => undefined);
    const binding = {
      assignmentId: "assignment-delivery", surfacePrincipal: "surface:origin", broker,
      ledger: { requestInteraction: async () => ({ accepted: true }), interactionStreamEvents: async () => [] },
      submission: { finishAndMirror }, context: {}, stream: { append: vi.fn() }, streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const request: ConfirmationRequest = { id: "parent", tool: "extension_connect", toolInput: {}, workingDirectory: "",
      display: { title: "接入", body: { kind: "generic", summary: "接入候选" }, cwd: "" }, options: [{ kind: "allow-once", label: "允许" }],
      sessionType: "ci", contextId: { kind: "main" }, createdAt: Date.now(), expiresAt: Date.now() + 30000 };
    const pending = observer.withBinding(binding, () => broker.requestConfirmation(request));
    try {
      await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
      const denied = await observer.withBinding(binding, () => child.requestConfirmation({ ...request, id: "child" }));
      expect(denied.kind).toBe("deny");
      expect(finishAndMirror).toHaveBeenCalledWith(binding.assignmentId, "child", expect.objectContaining({ t: "auto-resolved", reason: "no-interactive-surface" }), binding.context);
      expect(broker.listPending()).toHaveLength(1);
      await expect(observer.resolveWithSurfaceTicket(broker, { assignmentId: binding.assignmentId, requestId: "parent", ticketId: "ticket", surfacePrincipal: binding.surfacePrincipal, decision: { kind: "allow-once" } })).resolves.toBe(true);
      expect((await pending).kind).toBe("allow-once");
      const unavailable = observer.withBinding(binding, () => broker.requestConfirmation({ ...request, id: "no-surface" }));
      await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
      await observer.resolveNoInteractiveSurface({ assignmentId: binding.assignmentId, requestId: "no-surface" });
      expect((await unavailable).kind).toBe("deny");
    } finally { broker.cancelAll("aborted"); child.cancelAll("aborted"); await pending; }
  });

  it("retries the durable interaction projection from the first unconfirmed record", async () => {
    const requested = {
      kind: "interaction" as const,
      event: {
        t: "requested" as const,
        requestId: "request-fixed",
        toolName: "Write",
        display: { title: "Approve", lines: ["write file"] },
        issuedAt: "2026-07-23T00:00:00.000Z",
        ttlMs: 60_000,
        expiresAt: "2026-07-23T00:01:00.000Z",
      },
    };
    const finished = {
      kind: "interaction" as const,
      event: {
        t: "finished" as const,
        requestId: "request-fixed",
        outcome: "cancelled" as const,
      },
    };
    const append = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary stream failure"))
      .mockResolvedValue(undefined);
    const binding = {
      assignmentId: "assignment-fixed",
      ledger: {
        interactionStreamEvents: vi.fn(async () => [
          { recordSeq: 4, payload: requested },
          { recordSeq: 7, payload: finished },
        ]),
      },
      stream: { append },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const observer = new DurableConversationInteractionObserver();

    await expect(observer.drainAssignment(binding)).rejects.toThrow(
      "temporary stream failure",
    );
    await observer.drainAssignment(binding);
    await observer.drainAssignment(binding);

    expect(append).toHaveBeenNthCalledWith(
      2,
      requested,
      {},
      undefined,
      "interaction:4",
    );
    expect(append).toHaveBeenNthCalledWith(
      3,
      finished,
      {},
      undefined,
      "interaction:7",
    );
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("serializes concurrent drains for the same assignment", async () => {
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const append = vi.fn(async () => {
      await appendGate;
    });
    const binding = {
      assignmentId: "assignment-fixed",
      ledger: {
        interactionStreamEvents: vi.fn(async () => [{
          recordSeq: 4,
          payload: {
            kind: "interaction" as const,
            event: {
              t: "finished" as const,
              requestId: "request-fixed",
              outcome: "cancelled" as const,
            },
          },
        }]),
      },
      stream: { append },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const observer = new DurableConversationInteractionObserver();

    const first = observer.drainAssignment(binding);
    const second = observer.drainAssignment(binding);
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    releaseAppend();
    await Promise.all([first, second]);

    expect(append).toHaveBeenCalledTimes(1);
  });

  it("persists the authorized surface ticket before waking the runtime", async () => {
    const finishAndMirror = vi.fn(async () => undefined);
    const binding = {
      assignmentId: "assignment-fixed",
      surfacePrincipal: "surface:origin",
      ledger: {
        requestInteraction: vi.fn(async () => ({
          accepted: true,
          recordSeq: 1,
          display: { title: "Approve", lines: ["write file"] },
        })),
        interactionStreamEvents: vi.fn(async () => []),
      },
      submission: { finishAndMirror },
      context: {},
      stream: { append: vi.fn(async () => undefined) },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const request = {
      id: "request-fixed",
      tool: "Write",
      display: { title: "Approve", body: { path: "report.md" } },
      createdAt: Date.parse("2026-07-23T00:00:00.000Z"),
      expiresAt: Date.parse("2026-07-23T00:01:00.000Z"),
    } as never;
    const observer = new DurableConversationInteractionObserver();
    await observer.withBinding(binding, () => observer.beforeRequest(request));
    const broker = {
      async resolveDurably(requestId: string, decision: { kind: "allow-once" }) {
        await observer.afterResolved(request, decision, { kind: "surface" });
        return requestId === request.id;
      },
    } as never;

    await expect(observer.resolveWithSurfaceTicket(broker, {
      assignmentId: binding.assignmentId,
      requestId: request.id,
      ticketId: "ticket-authorized",
      surfacePrincipal: binding.surfacePrincipal,
      decision: { kind: "allow-once" },
    })).resolves.toBe(true);
    expect(finishAndMirror).toHaveBeenCalledWith(
      binding.assignmentId,
      request.id,
      expect.objectContaining({
        authority: { via: "surface-ticket", ticketId: "ticket-authorized" },
        by: binding.surfacePrincipal,
      }),
      binding.context,
    );
  });

  it("coalesces an identical in-flight surface answer and rejects a conflicting one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const binding = {
      assignmentId: "assignment-concurrent",
      surfacePrincipal: "surface:origin",
      ledger: {
        requestInteraction: vi.fn(async () => ({
          accepted: true,
          recordSeq: 1,
          display: { title: "Approve", lines: ["write file"] },
        })),
        interactionStreamEvents: vi.fn(async () => []),
      },
      submission: { finishAndMirror: vi.fn(async () => undefined) },
      context: {},
      stream: { append: vi.fn(async () => undefined) },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const request = {
      id: "request-concurrent",
      tool: "Write",
      display: { title: "Approve", body: { path: "report.md" } },
      createdAt: Date.parse("2026-07-23T00:00:00.000Z"),
      expiresAt: Date.parse("2026-07-23T00:01:00.000Z"),
    } as never;
    const observer = new DurableConversationInteractionObserver();
    await observer.withBinding(binding, () => observer.beforeRequest(request));
    const resolveDurably = vi.fn(async (
      _requestId: string,
      decision: { kind: "allow-once" },
    ) => {
      await gate;
      await observer.afterResolved(request, decision, { kind: "surface" });
      return true;
    });
    const broker = { resolveDurably } as never;
    const answer = {
      assignmentId: binding.assignmentId,
      requestId: request.id,
      ticketId: "ticket-concurrent",
      surfacePrincipal: binding.surfacePrincipal,
      decision: { kind: "allow-once" as const },
    };

    const first = observer.resolveWithSurfaceTicket(broker, answer);
    const duplicate = observer.resolveWithSurfaceTicket(broker, answer);
    await expect(
      observer.resolveWithSurfaceTicket(broker, {
        ...answer,
        decision: { kind: "deny", reason: "different" },
      }),
    ).rejects.toThrow("different surface answer");
    expect(resolveDurably).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([true, true]);
  });

  it("lists only runtime-bound requests that remain pending in the authority ledger", async () => {
    const binding = {
      assignmentId: "assignment-pending",
      surfacePrincipal: "surface:origin",
      ledger: {
        requestInteraction: vi.fn(async () => ({
          accepted: true,
          recordSeq: 1,
          display: { title: "Approve", lines: ["write file"] },
        })),
        pendingInteractionRequests: vi.fn(async () => [{
          assignmentId: "assignment-pending",
          request: {
            v: 1,
            t: "interaction-requested",
            requestId: "request-pending",
            toolName: "Write",
            display: { title: "Approve", lines: ["write file"] },
            issuedAt: "2026-07-23T00:00:00.000Z",
            ttlMs: 60_000,
            expiresAt: "2026-07-23T00:01:00.000Z",
          },
        }]),
        interactionStreamEvents: vi.fn(async () => []),
      },
      submission: { finishAndMirror: vi.fn(async () => undefined) },
      context: {},
      stream: { append: vi.fn(async () => undefined) },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const request = {
      id: "request-pending",
      tool: "Write",
      display: { title: "Approve", body: { path: "report.md" } },
      createdAt: Date.parse("2026-07-23T00:00:00.000Z"),
      expiresAt: Date.parse("2026-07-23T00:01:00.000Z"),
    } as never;
    const observer = new DurableConversationInteractionObserver();
    await observer.withBinding(binding, () => observer.beforeRequest(request));

    await expect(observer.pendingInteractions()).resolves.toEqual([
      expect.objectContaining({
        assignmentId: binding.assignmentId,
        request: expect.objectContaining({ requestId: request.id }),
      }),
    ]);
    await observer.afterResolved(request, { kind: "deny", reason: "no" }, {
      kind: "surface",
    });
    await expect(observer.pendingInteractions()).resolves.toEqual([]);
  });

  it("accepts an authority cancellation that wins before the runtime broker settles", async () => {
    const terminalConflict = new Error(
      "Interaction requestId already has a different terminal result",
    );
    const finishAndMirror = vi.fn(async () => {
      throw terminalConflict;
    });
    const flushInteractionMirrors = vi.fn(async () => 0);
    const binding = {
      assignmentId: "assignment-cancelled",
      surfacePrincipal: "surface:origin",
      ledger: {
        requestInteraction: vi.fn(async () => ({
          accepted: true,
          recordSeq: 1,
          display: { title: "Approve", lines: ["write file"] },
        })),
        conversationInteractionOutcome: vi.fn(async () => ({
          t: "cancelled" as const,
          via: "cancel-fence" as const,
        })),
        interactionStreamEvents: vi.fn(async () => []),
      },
      submission: { finishAndMirror, flushInteractionMirrors },
      context: {},
      stream: { append: vi.fn(async () => undefined) },
      streamMeta: {},
    } as unknown as DurableInteractionBinding;
    const request = {
      id: "request-cancelled",
      tool: "Write",
      display: { title: "Approve", body: { path: "report.md" } },
      createdAt: Date.parse("2026-07-23T00:00:00.000Z"),
      expiresAt: Date.parse("2026-07-23T00:01:00.000Z"),
    } as never;
    const observer = new DurableConversationInteractionObserver();
    await observer.withBinding(binding, () => observer.beforeRequest(request));

    await expect(
      observer.afterResolved(
        request,
        { kind: "cancelled", cause: "aborted" },
        { kind: "cancel", cause: "aborted" },
      ),
    ).resolves.toBeUndefined();
    expect(finishAndMirror).toHaveBeenCalledOnce();
    expect(flushInteractionMirrors).toHaveBeenCalledWith(
      binding.assignmentId,
      binding.context,
    );
    await expect(observer.pendingInteractions()).resolves.toEqual([]);
  });
});
