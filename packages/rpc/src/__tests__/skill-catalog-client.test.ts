import type { SkillCatalogChangedFact } from "@zhixing/core/skills/catalog";
import { describe, expect, it, vi } from "vitest";
import {
  SkillCatalogRpcClient,
  type SkillCatalogRpcRequestPort,
  type SkillCatalogRpcTransportPort,
} from "../skill-catalog-client.js";

const NOW = "2026-08-29T00:00:00.000Z";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "deploy",
    name: "Deploy",
    description: "Deploy safely",
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: { lastHitAt: NOW, hitCount: 2 },
    contentRef: { digest: `sha256:${"1".repeat(64)}`, bytes: 24 },
    revision: 3,
    digest: `sha256:${"2".repeat(64)}`,
    ...overrides,
  };
}

function harness(
  respond: (method: string, params: unknown) => unknown | Promise<unknown>,
): {
  readonly client: SkillCatalogRpcClient;
  readonly request: ReturnType<typeof vi.fn>;
  notification(method: string, payload: unknown): void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params?: unknown) =>
    await respond(method, params)
  );
  const handlers = new Map<string, (payload: unknown) => void>();
  const unsubscribe = vi.fn();
  const link: SkillCatalogRpcTransportPort = {
    getClient: async () => ({
      request: request as SkillCatalogRpcRequestPort["request"],
    }),
    onNotification(method, handler) {
      handlers.set(method, handler);
      return unsubscribe;
    },
  };
  return {
    client: new SkillCatalogRpcClient(link),
    request,
    notification(method, payload) {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Notification is not subscribed: ${method}`);
      handler(payload);
    },
    unsubscribe,
  };
}

describe("SkillCatalogRpcClient", () => {
  it("严格解码 skill.list 并投影为冻结的领域视图", async () => {
    const h = harness(() => ({ skills: [entry()], structuralVersion: 7 }));

    const view = await h.client.query({ kind: "list" });

    expect(h.request).toHaveBeenCalledWith("skill.list");
    expect(view).toMatchObject({
      catalogRevision: 7,
      entries: [{ id: "deploy", contentRef: { bytes: 24 } }],
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.entries)).toBe(true);
    expect(Object.isFrozen(view.entries[0])).toBe(true);
  });

  it.each([
    { skills: [entry()], structuralVersion: 7, extra: true },
    { skills: [entry({ unknown: true })], structuralVersion: 7 },
    { skills: [entry({ revision: 0 })], structuralVersion: 7 },
    { skills: [entry()], structuralVersion: -1 },
    { skills: "not-an-array", structuralVersion: 7 },
  ])("畸形或未知 list payload fail closed: %#", async (payload) => {
    const h = harness(() => payload);
    await expect(h.client.query({ kind: "list" })).rejects.toThrow(TypeError);
  });

  it("集中编码 set-state/archive 并严格校验两个 command acknowledgement", async () => {
    const h = harness(() => ({ ok: true }));

    await h.client.command({
      kind: "set-state",
      skillId: "deploy",
      patch: { pinned: true, mode: "work" },
    });
    await h.client.command({ kind: "archive", skillId: "deploy" });

    expect(h.request.mock.calls).toEqual([
      ["skill.setState", { skillId: "deploy", pinned: true, mode: "work" }],
      ["skill.archive", { skillId: "deploy" }],
    ]);
  });

  it("command response、patch 和 RPC error 均 fail closed/原样传播", async () => {
    const malformed = harness(() => ({ ok: true, extra: true }));
    await expect(
      malformed.client.command({ kind: "archive", skillId: "deploy" }),
    ).rejects.toThrow(TypeError);

    const invalidPatch = harness(() => ({ ok: true }));
    await expect(
      invalidPatch.client.command({
        kind: "set-state",
        skillId: "deploy",
        patch: {},
      }),
    ).rejects.toThrow(/patch/u);
    expect(invalidPatch.request).not.toHaveBeenCalled();

    const failure = new Error("wire failure");
    const rejected = harness(() => {
      throw failure;
    });
    await expect(
      rejected.client.command({ kind: "archive", skillId: "deploy" }),
    ).rejects.toBe(failure);
  });

  it("严格解码 skill.changed Fact，退订透传且畸形通知不进入 Surface", () => {
    const h = harness(() => ({ ok: true }));
    const facts: SkillCatalogChangedFact[] = [];
    const detach = h.client.onFact((fact) => facts.push(fact));

    h.notification("skill.changed", { structuralVersion: 8 });
    expect(facts).toEqual([
      { kind: "skill-catalog-changed", catalogRevision: 8 },
    ]);
    expect(Object.isFrozen(facts[0])).toBe(true);

    expect(() => h.notification("skill.changed", {})).toThrow(TypeError);
    expect(() =>
      h.notification("skill.changed", { structuralVersion: 9, extra: true })
    ).toThrow(TypeError);
    expect(facts).toHaveLength(1);

    detach();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });
});
