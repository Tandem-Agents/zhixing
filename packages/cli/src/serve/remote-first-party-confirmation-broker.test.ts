import type { StreamFrame, StreamSubscribe, StreamAck } from "@zhixing-ai/core/contracts";
import { ConfirmationHub } from "@zhixing-ai/owner-kernel/confirmation-hub";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../security/confirmation-decision.js";
import type { AssignmentDataPlaneTarget } from "./assignment-data-plane-topology.js";
import { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";
import {
  encodeRemoteConfirmationWireMeta,
  RemoteFirstPartyConfirmationBroker,
} from "./remote-first-party-confirmation-broker.js";

describe("RemoteFirstPartyConfirmationBroker", () => {
  it("bridges requested frames through ConfirmationHub and dispatches allow-once answers", async () => {
    const answer = vi.fn(async () => undefined);
    const broker = new RemoteFirstPartyConfirmationBroker({
      id: "remote-broker-1",
      answer,
    });
    const hub = new ConfirmationHub();
    const events: string[] = [];
    const unsubscribe = hub.onEvent((event) => {
      events.push(`${event.type}:${event.type === "request" ? event.entry.request.id : event.requestId}`);
    });
    hub.attach("conv:ws:1", broker, { conversationId: "ws:1" });

    broker.acceptRequested(
      {
        requestId: "req-1",
        toolName: "skill_materialize",
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-27T07:05:00.000Z",
      },
      {
        title: "写入技能文件",
        lines: [JSON.stringify({ kind: "file-write", path: "examples/starter-channel.ts", preview: "export {}" })],
      },
      { channel: "rpc", triggeredBy: "1" },
    );

    const entry = hub.findEntry("req-1");
    expect(entry).toBeDefined();
    expect(entry?.conversationId).toBe("ws:1");
    expect(entry?.request.tool).toBe("skill_materialize");
    expect(entry?.request.display.body).toEqual({
      kind: "file-write",
      path: "examples/starter-channel.ts",
      preview: "export {}",
    });
    expect(entry?.request.turnOrigin).toEqual({ channel: "rpc", triggeredBy: "1" });

    await expect(hub.resolveDurably("req-1", { kind: "allow-once", note: "ok" })).resolves.toBe(true);
    expect(answer).toHaveBeenCalledWith({
      requestId: "req-1",
      decision: { kind: "allow-once", note: "ok" },
    });
    expect(hub.findEntry("req-1")).toBeUndefined();
    expect(events).toEqual(["request:req-1", "resolved:req-1"]);

    // Subsequent finished frame from stream must be an idempotent no-op.
    broker.acceptFinished({ requestId: "req-1", outcome: "allowed" });
    expect(events).toEqual(["request:req-1", "resolved:req-1"]);
    unsubscribe();
    hub.detach("conv:ws:1");
  });

  it("rejects persistent approvals while keeping the request pending until allow-once or deny", async () => {
    const answer = vi.fn(async () => undefined);
    const broker = new RemoteFirstPartyConfirmationBroker({ answer });
    const hub = new ConfirmationHub();
    hub.attach("conv:ws:2", broker, { conversationId: "ws:2" });

    broker.acceptRequested(
      {
        requestId: "req-persist",
        toolName: "bash",
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-27T07:05:00.000Z",
      },
      { title: "执行命令", lines: ["echo hi"] },
    );

    await expect(
      hub.resolveDurably("req-persist", {
        kind: "allow-context",
        pattern: {
          pattern: { tool: "bash", argument: "echo*" },
          label: "Allow echo",
        },
      }),
    ).rejects.toThrow("当前执行端不支持持久授权，请改为仅本次允许");
    expect(answer).not.toHaveBeenCalled();
    expect(hub.findEntry("req-persist")).toBeDefined();

    await expect(
      hub.resolveDurably("req-persist", { kind: "deny", reason: "stop" }),
    ).resolves.toBe(true);
    expect(answer).toHaveBeenCalledWith({
      requestId: "req-persist",
      decision: { kind: "deny", reason: "stop" },
    });
    expect(hub.findEntry("req-persist")).toBeUndefined();
    hub.detach("conv:ws:2");
  });

  it("serializes multiple queued requests and clears remaining items on cancelAll", async () => {
    const answer = vi.fn(async () => undefined);
    const broker = new RemoteFirstPartyConfirmationBroker({ answer });
    const shown: string[] = [];
    const resolved: Array<{ readonly id: string; readonly kind: string }> = [];
    broker.onRequest((req) => shown.push(req.id));
    broker.onResolved((id, decision) => resolved.push({ id, kind: decision.kind }));

    broker.acceptRequested(
      {
        requestId: "req-a",
        toolName: "write",
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-27T07:05:00.000Z",
      },
      { title: "Write A", lines: [] },
    );
    broker.acceptRequested(
      {
        requestId: "req-b",
        toolName: "bash",
        issuedAt: "2026-11-27T07:00:01.000Z",
        expiresAt: "2026-11-27T07:05:01.000Z",
      },
      { title: "Run B", lines: [] },
    );
    broker.acceptRequested(
      {
        requestId: "req-c",
        toolName: "extension_connect",
        issuedAt: "2026-11-27T07:00:02.000Z",
        expiresAt: "2026-11-27T07:05:02.000Z",
      },
      { title: "Connect C", lines: [] },
    );

    expect(shown).toEqual(["req-a"]);
    await expect(broker.resolveDurably("req-a", { kind: "allow-once" })).resolves.toBe(true);
    expect(shown).toEqual(["req-a", "req-b"]);
    expect(broker.cancelAll("session-end")).toBe(2);
    expect(broker.listPending()).toEqual([]);
    expect(resolved).toEqual([
      { id: "req-a", kind: "allow-once" },
      { id: "req-b", kind: "cancelled" },
      { id: "req-c", kind: "cancelled" },
    ]);
  });

  it("R3-1: faithfully preserves skill_admit purpose options, stewardReason, and referee metadata while keeping legacy 1-line fallback fail-closed", async () => {
    const answer = vi.fn(async () => undefined);
    const broker = new RemoteFirstPartyConfirmationBroker({ answer });
    const hub = new ConfirmationHub();
    hub.attach("conv:ws:admit", broker, { conversationId: "ws:admit:1" });

    const originalAdmitRequest = {
      id: "skill-admit-auth:1",
      tool: "skill_admit",
      toolInput: {
        phase: "authorize-candidate",
        candidateDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        memberPaths: ["SKILL.md"],
        totalBytes: 120,
        referee: { role: "main", providerId: "loopback", model: "rehearsal-model" },
      },
      workingDirectory: "",
      operationClass: "external" as const,
      decision: {
        action: "confirm" as const,
        reason: "允许将候选技能全部可读成员送交安全裁判 loopback/rehearsal-model (role=main) 审查",
        riskLevel: "high" as const,
        matchedRules: [],
      },
      sessionType: "interactive" as const,
      contextId: { kind: "main" as const },
      createdAt: Date.parse("2026-11-27T07:00:00.000Z"),
      expiresAt: Date.parse("2026-11-27T07:05:00.000Z"),
      display: {
        title: "外部技能审查与准入授权",
        cwd: "",
        stewardReason: "允许将候选技能全部可读成员送交安全裁判 loopback/rehearsal-model (role=main) 审查",
        body: {
          kind: "generic" as const,
          summary: "候选摘要 sha256:111111111...（1 个成员，120 B）",
          details: {
            referee: "loopback/rehearsal-model (role=main)",
            candidateDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            memberCount: "1",
            totalBytes: "120",
            members: "SKILL.md",
          },
        },
      },
      options: [
        {
          kind: "allow-once" as const,
          label: "送审并在安全通过后发布入库",
          hotkey: "y",
          note: "review-and-publish",
        },
        {
          kind: "allow-once" as const,
          label: "只送审，不发布（不在当前会话回显候选内容、不自动入库）",
          hotkey: "r",
          note: "review-only",
        },
        { kind: "deny" as const, label: "拒绝送审", hotkey: "n" },
      ],
    };

    const metaLine = encodeRemoteConfirmationWireMeta(originalAdmitRequest);
    expect(metaLine).toBeDefined();

    broker.acceptRequested(
      {
        requestId: originalAdmitRequest.id,
        toolName: originalAdmitRequest.tool,
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-27T07:05:00.000Z",
      },
      {
        title: originalAdmitRequest.display.title,
        lines: [JSON.stringify(originalAdmitRequest.display.body), metaLine!],
      },
      { channel: "rpc", triggeredBy: "1" },
    );

    const surfaced = hub.findEntry("skill-admit-auth:1")?.request;
    expect(surfaced).toBeDefined();
    expect(surfaced?.display.stewardReason).toBe(originalAdmitRequest.display.stewardReason);
    expect(surfaced?.operationClass).toBe("external");
    expect(surfaced?.decision).toEqual({
      action: "confirm",
      reason: originalAdmitRequest.display.stewardReason,
      riskLevel: "high",
      matchedRules: [],
    });
    expect(surfaced?.toolInput).toEqual(originalAdmitRequest.toolInput);
    expect(surfaced?.options).toEqual(originalAdmitRequest.options);

    // Selecting option index 1 ("只送审，不发布") via official translate() produces review-only without hand-crafted note
    const optionById = new Map(surfaced!.options.map((opt, idx) => [`opt-${idx}`, opt]));
    const reviewOnlyDecision = translate({ kind: "selected", value: "opt-1" }, optionById);
    expect(reviewOnlyDecision).toEqual({ kind: "allow-once", note: "review-only" });
    await expect(hub.resolveDurably("skill-admit-auth:1", reviewOnlyDecision)).resolves.toBe(true);
    expect(answer).toHaveBeenCalledWith({
      requestId: "skill-admit-auth:1",
      decision: { kind: "allow-once", note: "review-only" },
    });

    // Legacy 1-line display without wireMeta keeps generic options with no purpose note (fail-closed)
    broker.acceptRequested(
      {
        requestId: "legacy-1",
        toolName: "skill_admit",
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-27T07:05:00.000Z",
      },
      {
        title: "Legacy",
        lines: [JSON.stringify({ kind: "generic", summary: "legacy" })],
      },
    );
    const legacySurfaced = hub.findEntry("legacy-1")?.request;
    expect(legacySurfaced?.options).toEqual([
      { kind: "allow-once", label: "仅本次允许" },
      { kind: "deny", label: "拒绝" },
    ]);
    hub.detach("conv:ws:admit");
  });
});

describe("LosslessDataPlaneRuntime first-party interaction forwarding", () => {
  it("routes firstPartySurfaceSession.answerInteraction through endpoint.answerChannel", async () => {
    const answerChannel = vi.fn(async () => undefined);
    const streamClient = {
      async subscribe(_request: StreamSubscribe): Promise<readonly StreamFrame[]> {
        return [];
      },
      async acknowledge(_ack: StreamAck): Promise<void> {
        return undefined;
      },
    };
    const remoteTarget: AssignmentDataPlaneTarget = {
      acceptTicket: vi.fn(async () => undefined),
      answerChannel,
      resolveNoInteractiveSurface: vi.fn(async () => undefined),
      ownerStream: () => streamClient,
      directSurfaceStream: () => undefined,
    };
    const runtime = new LosslessDataPlaneRuntime({
      verifier: {} as never,
      channelChallenges: Object.freeze({ kind: "absent", reason: "not-configured" }),
      targets: {
        targetForExecutor: () => remoteTarget,
      },
    });
    const session = await runtime.openFirstPartySurfaceSession({
      executorId: "exec-remote",
      assignmentId: "asg-fp-1",
      ref: {
        execution: "conversation",
        conversationId: "ws:fp:1",
        runId: "run-fp-1",
        ownerEpoch: 1,
      },
      ticket: {
        v: 1,
        ticketId: "ticket-fp-1",
        kind: "run-interact",
        assignmentId: "asg-fp-1",
        ref: {
          execution: "conversation",
          conversationId: "ws:fp:1",
          runId: "run-fp-1",
          ownerEpoch: 1,
        },
        executorId: "exec-remote",
        surfacePrincipal: "rpc:owner",
        issuedAt: "2026-11-27T07:00:00.000Z",
        expiresAt: "2026-11-28T07:00:00.000Z",
        signature: { keyId: "k1", algorithm: "ed25519", value: "sig" },
      },
      surfacePrincipal: "rpc:owner",
      adoptFrame: async () => undefined,
    });

    await session.answerInteraction?.({
      requestId: "req-fp-1",
      decision: { kind: "allow-once" },
    });

    expect(answerChannel).toHaveBeenCalledWith({
      assignmentId: "asg-fp-1",
      requestId: "req-fp-1",
      ticketId: "ticket-fp-1",
      surfacePrincipal: "rpc:owner",
      decision: { kind: "allow-once" },
    });
    await session.close();
  });
});
