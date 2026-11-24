import { describe, expect, it, vi } from "vitest";
import { ConfirmationBroker, type ConfirmationRequest } from "../../confirmation/index.js";
import {
  computeDirectoryEntriesDigest,
  coordinateConversationDirectoryPage,
  decodeProgramConversationTicket,
  encodeProgramConversationTicket,
  isProgramOrigin,
  PROGRAM_SURFACE_PRINCIPAL,
  PROGRAM_TURN_CHANNEL,
  ProgramConversationError,
  programConversationTurnId,
  programHomeId,
  verifyProgramConversationTicket,
  type DirectorySourceProvider,
  type RawDirectoryCandidate,
} from "../application.js";

function makeConfirmationRequest(id: string): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "rm -rf /tmp/demo" },
    workingDirectory: "/tmp",
    display: {
      title: "执行命令",
      body: { kind: "generic", summary: "测试确认" },
      cwd: "/tmp",
    },
    options: [{ kind: "allow-once", label: "允许一次" }],
    sessionType: "ci",
    contextId: { kind: "main" },
    createdAt: now,
    expiresAt: now + 30_000,
  };
}

describe("program-origin & directory coordination contracts", () => {
  it("enforces the three-field isProgramOrigin predicate and never misclassifies a managed channel named 'program'", () => {
    expect(
      isProgramOrigin({
        kind: "first-party",
        surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
        turnOrigin: { channel: PROGRAM_TURN_CHANNEL },
      }),
    ).toBe(true);

    // Managed channel with channelId = "program" MUST NOT match isProgramOrigin
    expect(
      isProgramOrigin({
        kind: "channel",
        surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
        turnOrigin: { channel: "program" },
      }),
    ).toBe(false);

    expect(
      isProgramOrigin({
        kind: "first-party",
        surfacePrincipal: "rpc:local",
        turnOrigin: { channel: PROGRAM_TURN_CHANNEL },
      }),
    ).toBe(false);

    expect(
      isProgramOrigin({
        kind: "first-party",
        surfacePrincipal: PROGRAM_SURFACE_PRINCIPAL,
        turnOrigin: { channel: "rpc" },
      }),
    ).toBe(false);
  });

  it("derives target-isolated physical turn IDs and home-bound zxt1 tickets", () => {
    const mTurn = programConversationTurnId("main-conv", "1");
    const bTurn = programConversationTurnId("ws:scene-a:primary", "1");
    expect(mTurn).not.toBe(bTurn);
    expect(programConversationTurnId("main-conv", "1")).toBe(mTurn);

    const homeA = programHomeId("/tmp/zhixing-home-a");
    const homeB = programHomeId("/tmp/zhixing-home-b");
    expect(homeA).not.toBe(homeB);

    const ticket = encodeProgramConversationTicket({
      homeId: homeA,
      conversationId: "ws:scene-a:primary",
      requestId: "req-1",
    });
    expect(ticket.startsWith("zxt1.")).toBe(true);
    expect(decodeProgramConversationTicket(ticket)).toEqual({
      ok: true,
      payload: {
        v: 1,
        homeId: homeA,
        conversationId: "ws:scene-a:primary",
        requestId: "req-1",
      },
    });
    expect(verifyProgramConversationTicket(ticket, homeA)).toMatchObject({
      ok: true,
      payload: {
        conversationId: "ws:scene-a:primary",
        requestId: "req-1",
      },
    });
    expect(verifyProgramConversationTicket(ticket, homeB)).toMatchObject({
      ok: false,
      code: "invalid_ticket",
    });
  });

  it("paginates mixed scopes with limit=100, ignores streaming/busy churn, expires on persistent change, and fails closed when version proof is missing", async () => {
    let busyFlag = false;
    let sceneCandidateActiveAt = "2026-11-23T12:00:00.000Z";
    const requestedLimits: number[] = [];

    const oldChats: Extract<RawDirectoryCandidate, { entryKind: "conversation" }>[] = Array.from(
      { length: 210 },
      (_, idx) => ({
        entryKind: "conversation",
        canonicalKey: `chat-20250101-${String(idx).padStart(4, "0")}`,
        conversationId: `chat-20250101-${String(idx).padStart(4, "0")}`,
        scope: "main",
        name: `旧会话 ${idx}`,
        lastActiveAt: new Date(Date.parse("2025-01-01T00:00:00.000Z") + idx * 1000).toISOString(),
        ownerSourceId: "anchor:user",
      }),
    );

    const activeChinese: Extract<RawDirectoryCandidate, { entryKind: "conversation" }> = {
      entryKind: "conversation",
      canonicalKey: "架构设计评审",
      conversationId: "架构设计评审",
      scope: "main",
      name: "架构设计评审",
      lastActiveAt: "2026-11-23T13:30:00.000Z",
      ownerSourceId: "anchor:user",
    };

    const userRecords = [activeChinese, ...oldChats].sort(
      (a, b) =>
        Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt) ||
        a.canonicalKey.localeCompare(b.canonicalKey),
    );

    const buildSources = (omitVersion = false): DirectorySourceProvider[] => [
      {
        sourceId: "anchor:user",
        enrichConversation: async (c) => ({
          entryKind: "conversation",
          canonicalKey: c.canonicalKey,
          conversationId: c.conversationId,
          scope: c.scope,
          name: c.name,
          active: true,
          busy: busyFlag,
          pendingCount: 0,
          summary: "",
          summaryTruncated: false,
          lastActiveAt: c.lastActiveAt,
        }),
        readPage: async (req) => {
          requestedLimits.push(req.limit);
          expect(req.limit).toBeLessThanOrEqual(100);
          const filtered = userRecords.filter((item) => {
            if (!req.after) return true;
            const dt = Date.parse(item.lastActiveAt) - Date.parse(req.after.lastActiveAt);
            if (dt !== 0) return dt < 0;
            return item.canonicalKey > req.after.conversationId;
          });
          const slice = filtered.slice(0, req.limit);
          return {
            sourceId: "anchor:user",
            reachable: true,
            records: slice,
            hasMore: filtered.length > req.limit,
            ...(omitVersion
              ? {}
              : {
                  version: {
                    kind: "indexed" as const,
                    epoch: 1,
                    revision: "rev-1",
                  },
                }),
          };
        },
      },
      {
        sourceId: "anchor:workscenes",
        readPage: async (req) => {
          requestedLimits.push(req.limit);
          expect(req.limit).toBeLessThanOrEqual(100);
          const wsItems: RawDirectoryCandidate[] = [
            {
              entryKind: "conversation",
              canonicalKey: "ws:team:primary",
              conversationId: "ws:team:primary",
              scope: "workscene",
              name: "团队协作",
              sceneId: "team",
              sceneName: "团队协作",
              lastActiveAt: "2026-11-23T13:00:00.000Z",
              ownerSourceId: "anchor:workscenes",
            },
            {
              entryKind: "workscene-candidate",
              canonicalKey: "ws:uninit:primary",
              scope: "workscene",
              sceneId: "uninit",
              sceneName: "待初始化场景",
              initialized: false,
              lastActiveAt: sceneCandidateActiveAt,
              ownerSourceId: "anchor:workscenes",
            },
          ];
          const filtered = wsItems.filter((item) => {
            if (!req.after) return true;
            const dt = Date.parse(item.lastActiveAt) - Date.parse(req.after.lastActiveAt);
            if (dt !== 0) return dt < 0;
            return item.canonicalKey > req.after.conversationId;
          });
          return {
            sourceId: "anchor:workscenes",
            reachable: true,
            records: filtered.slice(0, req.limit),
            hasMore: filtered.length > req.limit,
            version: {
              kind: "direct",
              entriesDigest: computeDirectoryEntriesDigest(
                wsItems.map((i) => ({
                  canonicalKey: i.canonicalKey,
                  lastActiveAt: i.lastActiveAt,
                  name: i.entryKind === "conversation" ? i.name : i.sceneName,
                })),
              ),
            },
          };
        },
      },
      {
        sourceId: "local:dev1",
        readPage: async (req) => {
          requestedLimits.push(req.limit);
          const localEntry: RawDirectoryCandidate = {
            entryKind: "conversation",
            canonicalKey: "local-12345678-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            conversationId: "local-12345678-01ARZ3NDEKTSV4RRFFQ69G5FAV",
            scope: "local",
            name: "本机终端草稿",
            lastActiveAt: "2026-11-23T12:30:00.000Z",
            ownerSourceId: "local:dev1",
          };
          const include =
            !req.after ||
            Date.parse(localEntry.lastActiveAt) < Date.parse(req.after.lastActiveAt) ||
            (Date.parse(localEntry.lastActiveAt) === Date.parse(req.after.lastActiveAt) &&
              localEntry.canonicalKey > req.after.conversationId);
          const list = include ? [localEntry] : [];
          return {
            sourceId: "local:dev1",
            reachable: true,
            records: list.slice(0, req.limit),
            hasMore: list.length > req.limit,
            version: {
              kind: "direct",
              entriesDigest: computeDirectoryEntriesDigest([
                {
                  canonicalKey: localEntry.canonicalKey,
                  lastActiveAt: localEntry.lastActiveAt,
                  name: localEntry.name,
                },
              ]),
            },
          };
        },
      },
    ];

    // 1. First page with limit = 100 puts active Chinese, ws, local-*, and candidate at the very top
    const first100 = await coordinateConversationDirectoryPage({
      request: { limit: 100, scope: "all", query: "" },
      sources: buildSources(),
    });
    expect(first100.entries).toHaveLength(100);
    expect(first100.entries.slice(0, 4).map((e) => e.canonicalKey)).toEqual([
      "架构设计评审",
      "ws:team:primary",
      "local-12345678-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ws:uninit:primary",
    ]);
    expect(first100.nextCursor).toBeDefined();
    expect(Math.max(...requestedLimits)).toBeLessThanOrEqual(100);

    // 2. Transient busy change does NOT invalidate nextCursor; full static traversal visits all 214 items once
    busyFlag = true;
    const seenKeys = new Set(first100.entries.map((e) => e.canonicalKey));
    let cursor = first100.nextCursor;
    while (cursor) {
      const next = await coordinateConversationDirectoryPage({
        request: { limit: 100, scope: "all", query: "", cursor },
        sources: buildSources(),
      });
      for (const entry of next.entries) {
        expect(seenKeys.has(entry.canonicalKey)).toBe(false);
        seenKeys.add(entry.canonicalKey);
      }
      cursor = next.nextCursor;
    }
    expect(seenKeys.size).toBe(214);

    // 3. Persistent directory mutation between pages triggers cursor_expired (exitCode 3)
    sceneCandidateActiveAt = "2026-11-23T13:59:00.000Z";
    await expect(
      coordinateConversationDirectoryPage({
        request: { limit: 100, scope: "all", query: "", cursor: first100.nextCursor },
        sources: buildSources(),
      }),
    ).rejects.toMatchObject({
      code: "cursor_expired",
      options: { exitCode: 3 },
    });

    // 4. Missing version proof when hasMore is true fails closed with temporarily_unavailable (exitCode 3)
    await expect(
      coordinateConversationDirectoryPage({
        request: { limit: 50, scope: "all", query: "" },
        sources: buildSources(true),
      }),
    ).rejects.toBeInstanceOf(ProgramConversationError);
  });

  it("resolves delivery: 'non-interactive' immediately before requestListeners and head-of-line human queue", async () => {
    const lifecycleEvents: string[] = [];
    const hubListener = vi.fn();
    const broker = new ConfirmationBroker({
      lifecycleObserver: {
        beforeRequest: async (request) => {
          lifecycleEvents.push(`before:${request.id}`);
          if (request.id === "prog-req") {
            return { accepted: true, delivery: "non-interactive" };
          }
          return { accepted: true, delivery: "durable" };
        },
        afterResolved: async (request, decision, outcome) => {
          lifecycleEvents.push(`after:${request.id}:${decision.kind}:${outcome.kind}`);
        },
      },
    });
    // Simulate ConfirmationHub mounted on the broker (`requestListeners.length > 0`)
    broker.onRequest(hubListener);

    // 1. Enqueue a human durable confirmation at the head of the queue
    const humanPromise = broker.requestConfirmation(makeConfirmationRequest("human-req"));
    await vi.waitFor(() => expect(hubListener).toHaveBeenCalledTimes(1));
    expect(broker.listPending()).toHaveLength(1);

    // 2. Inject program-origin confirmation behind the pending human confirmation on the SAME broker
    const programOutcome = await broker.requestConfirmation(makeConfirmationRequest("prog-req"));
    expect(programOutcome).toEqual({
      kind: "deny",
      reason: expect.stringContaining("无交互"),
    });
    // Must NOT notify ConfirmationHub and must NOT wait behind human-req!
    expect(hubListener).toHaveBeenCalledTimes(1);
    expect(broker.listPending().map((r) => r.request.id)).toEqual(["human-req"]);
    expect(lifecycleEvents).toContain("after:prog-req:deny:non-interactive");

    // 3. Human confirmation at the head of the queue still resolves normally
    expect(broker.resolve("human-req", { kind: "allow-once" })).toBe(true);
    expect((await humanPromise).kind).toBe("allow-once");
  });
});
