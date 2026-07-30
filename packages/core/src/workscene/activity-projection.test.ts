import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorksceneActivityProjection } from "./activity-projection.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WorksceneActivityProjection", () => {
  it("derives the per-scene maximum and survives restart", async () => {
    const root = await temporaryRoot();
    const source = [
      {
        sceneId: "scene-a",
        sessions: [
          {
            conversationId: "conversation-a",
            lastActiveAt: "2026-07-30T00:00:00.000Z",
          },
          {
            conversationId: "conversation-b",
            lastActiveAt: "2026-07-30T02:00:00.000Z",
          },
        ],
      },
    ];
    const first = new WorksceneActivityProjection({ rootDir: root });
    await first.synchronize(source);
    expect(await first.get("scene-a")).toBe("2026-07-30T02:00:00.000Z");

    const reopened = new WorksceneActivityProjection({ rootDir: root });
    await reopened.synchronize(source);
    expect(await reopened.get("scene-a")).toBe(
      "2026-07-30T02:00:00.000Z",
    );
  });

  it("removes derived entries absent from the authoritative snapshot", async () => {
    const root = await temporaryRoot();
    const projection = new WorksceneActivityProjection({ rootDir: root });
    await projection.synchronize([
      {
        sceneId: "scene-a",
        sessions: [
          {
            conversationId: "conversation-a",
            lastActiveAt: "2026-07-30T00:00:00.000Z",
          },
        ],
      },
    ]);
    await projection.synchronize([]);
    expect(await projection.get("scene-a")).toBeUndefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "workscene-activity-"));
  roots.push(root);
  return root;
}
