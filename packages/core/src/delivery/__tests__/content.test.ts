import path from "node:path";
import { utimes } from "node:fs/promises";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../../authority/index.js";
import {
  canonicalize,
  MAX_PROTOCOL_IDENTIFIER_LENGTH,
} from "../../protocol/index.js";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  compileDeliveryContent,
  DeliveryContentValidationError,
} from "../content.js";
import {
  deliveryRecord,
  emptyDeliveryProjection,
  prepareDeliveryEnqueues,
} from "../authority.js";

const NOW = "2026-07-17T02:00:00.000Z";

async function artifacts() {
  const root = await createTempDir("delivery-content");
  return new FileArtifactStore(path.join(root, "artifacts"));
}

describe("delivery content compiler", () => {
  it("externalizes content that cannot safely fit in an authority record", async () => {
    const store = await artifacts();
    const text = "x".repeat(9 * 1024);

    const compiled = await compileDeliveryContent(text, store);

    expect("ref" in compiled.content).toBe(true);
    if (!("ref" in compiled.content)) return;
    const bytes = await store.get(compiled.content.ref);
    expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual({
      markdown: text,
      text,
    });
    expect(compiled.references).toContainEqual(compiled.content.ref);
  });

  it("rejects a referenced artifact that is not canonical delivery content", async () => {
    const store = await artifacts();
    const ref = await store.put(Buffer.from(canonicalize({ arbitrary: "payload" }), "utf8"));

    await expect(compileDeliveryContent({ ref }, store)).rejects.toBeInstanceOf(
      DeliveryContentValidationError,
    );
  });

  it("preserves structured media references in the retained closure", async () => {
    const store = await artifacts();
    const media = await store.put(new Uint8Array([1, 2, 3]));
    const content = { text: "image", media: [{ type: "image" as const, ref: media }] };

    const compiled = await compileDeliveryContent(content, store);

    expect(compiled.content).toEqual(content);
    expect(compiled.references).toEqual([media]);
  });

  it("retains externalized delivery content and its nested media through a real GC sweep", async () => {
    const root = await createTempDir("delivery-content-gc");
    const store = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), store, {
      clock: () => NOW,
    });
    const media = await store.put(new Uint8Array([1, 2, 3]));
    const compiled = await compileDeliveryContent(
      {
        text: "x".repeat(9 * 1024),
        media: [{ type: "image", ref: media }],
      },
      store,
    );
    if (!("ref" in compiled.content)) throw new Error("content was not externalized");
    await appendDelivery(log, compiled.content, compiled.references);
    const orphan = await store.put(Buffer.from("orphan", "utf8"));
    const old = new Date("2020-01-01T00:00:00.000Z");
    await Promise.all([
      utimes(store.pathFor(compiled.content.ref), old, old),
      utimes(store.pathFor(media), old, old),
      utimes(store.pathFor(orphan), old, old),
    ]);

    const result = await log.collectGarbage({
      unreferencedBefore: "2021-01-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(1);
    await expect(store.has(compiled.content.ref)).resolves.toBe(true);
    await expect(store.has(media)).resolves.toBe(true);
    await expect(store.has(orphan)).resolves.toBe(false);
  }, 15_000);

  it("rejects a registered delivery content root that is not valid content", async () => {
    const root = await createTempDir("delivery-content-gc-invalid");
    const store = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), store, {
      clock: () => NOW,
    });
    const invalid = await store.put(
      Buffer.from(canonicalize({ arbitrary: "payload" }), "utf8"),
    );
    await expect(
      appendDelivery(log, { ref: invalid }, [invalid]),
    ).rejects.toMatchObject({ code: "invalid-authority-record" });
    await expect(log.readAll()).resolves.toEqual([]);
  }, 15_000);

  it("rejects a registered delivery root with an overlong identity", async () => {
    const root = await createTempDir("delivery-content-gc-identity");
    const store = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), store, {
      clock: () => NOW,
    });
    const content = await store.put(
      Buffer.from(canonicalize({ text: "retained" }), "utf8"),
    );
    await expect(
      appendDelivery(
        log,
        { ref: content },
        [content],
        "i".repeat(MAX_PROTOCOL_IDENTIFIER_LENGTH + 1),
      ),
    ).rejects.toMatchObject({ code: "invalid-authority-record" });
    await expect(log.readAll()).resolves.toEqual([]);
  }, 15_000);
});

async function appendDelivery(
  log: FileAuthorityCommitLog,
  content: { readonly ref: import("../../contracts/index.js").ArtifactRef },
  references: readonly import("../../contracts/index.js").ArtifactRef[],
  itemIdOverride?: string,
): Promise<void> {
  const identity = content.ref.digest.slice(-8);
  const prepared = prepareDeliveryEnqueues(
    emptyDeliveryProjection(),
    [
      {
        keyBody: {
          kind: "conversation-status-delivery",
          conversationId: `conversation-${identity}`,
          runId: `run-${identity}`,
          statusRevision: 1,
        },
        intent: {
          endpoint: {
            kind: "channel",
            target: { channelId: "feishu", to: "user-1" },
          },
          content,
          priority: "normal",
          createdAt: NOW,
          maxAttempts: 3,
        },
      },
    ],
    NOW,
  );
  if (!prepared.accepted) throw new Error("delivery fixture was rejected");
  await log.transactProjection(
    {},
    (state) => state,
    () => ({
      kind: "append" as const,
      entries: [
        {
          stream: `run:conversation-${identity}`,
          body: {
            t: "state",
            runId: `run-${identity}`,
            state: "failed",
            statusRevision: 1,
          },
        },
        ...prepared.records.map((record) =>
          deliveryRecord(
            record.t === "enqueued" && itemIdOverride !== undefined
              ? { ...record, itemId: itemIdOverride }
              : record,
          ),
        ),
      ],
      value: undefined,
    }),
    { candidateReferences: references },
  );
}
