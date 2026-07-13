import {
  appendFile,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../index.js";
import {
  AUTHORITY_WAL_HEADER_BYTES,
  AUTHORITY_WAL_TRAILER_BYTES,
} from "../wal-frame.js";

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

async function createStores() {
  const root = await createTempDir("authority-storage");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    lockWaitMs: 2_000,
  });
  return { root, artifacts, log };
}

describe("FileArtifactStore", () => {
  it("stores immutable content by digest and rejects corrupted content", async () => {
    const { artifacts } = await createStores();
    const bytes = Buffer.from("durable content", "utf8");

    const first = await artifacts.put(bytes);
    const second = await artifacts.put(bytes);

    expect(second).toEqual(first);
    expect(Buffer.from(await artifacts.get(first))).toEqual(bytes);

    await writeFile(artifacts.pathFor(first), Buffer.from("tampered", "utf8"));
    await expect(artifacts.get(first)).rejects.toMatchObject({
      code: "artifact-corrupt",
    });
  });
});

describe("FileAuthorityCommitLog", () => {
  it("commits multiple logical streams atomically and rebuilds projections in LSN order", async () => {
    const { log } = await createStores();

    const first = await log.append([
      { stream: "control", body: { t: "received", requestId: "req-1" } },
      { stream: "run:conv-1", body: { t: "queued", runId: "run-1" } },
    ]);
    const second = await log.append([
      { stream: "run:conv-1", body: { t: "committed", runId: "run-1" } },
    ]);

    expect(first.lsn).toBe(1);
    expect(second.lsn).toBe(2);
    expect(first.envelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await log.readStream("control")).toEqual([
      { lsn: 1, at: first.at, body: { t: "received", requestId: "req-1" } },
    ]);
    await expect(
      log.rebuildProjection<string[]>(
        [],
        (state, record) => [...state, record.body.t],
        { stream: "run:conv-1" },
      ),
    ).resolves.toEqual(["queued", "committed"]);
    await expect(
      log.rebuildProjection<string[]>(
        ["queued"],
        (state, record) => [...state, record.body.t],
        { stream: "run:conv-1", afterLsn: first.lsn },
      ),
    ).resolves.toEqual(["queued", "committed"]);
    await expect(
      log.rebuildProjection([], (state) => state, { afterLsn: second.lsn + 1 }),
    ).rejects.toMatchObject({ code: "commit-log-corrupt" });
  });

  it("serializes concurrent appenders without duplicate or skipped LSNs", async () => {
    const { log } = await createStores();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        log.append([{ stream: "control", body: { t: "event", index } }]),
      ),
    );

    const envelopes = await log.readAll();
    expect(envelopes.map((envelope) => envelope.lsn)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(envelopes.map((envelope) => JSON.stringify(envelope.entries[0]?.body))).size).toBe(12);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("resynchronizes verified tail state when another log instance appends", async () => {
    const { artifacts, log } = await createStores();
    const peer = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });

    await log.append([{ stream: "control", body: { t: "one" } }]);
    await peer.append([{ stream: "control", body: { t: "two" } }]);
    await log.append([{ stream: "control", body: { t: "three" } }]);

    expect((await log.readAll()).map((envelope) => envelope.lsn)).toEqual([1, 2, 3]);
  });

  it("refuses to commit an artifact reference until its bytes are durable", async () => {
    const { artifacts, log } = await createStores();
    const missing = { digest: `sha256:${"0".repeat(64)}`, bytes: 7 };

    await expect(
      log.append([{ stream: "publish", body: { t: "asset", content: missing } }]),
    ).rejects.toMatchObject({ code: "artifact-missing" });
    await expect(log.readAll()).resolves.toEqual([]);

    const present = await artifacts.put(Buffer.from("present", "utf8"));
    await expect(
      log.append([{ stream: "publish", body: { t: "asset", content: present } }]),
    ).resolves.toMatchObject({ lsn: 1 });
  });

  it("enforces the 32 KiB inline body boundary and accepts an artifact reference instead", async () => {
    const { artifacts, log } = await createStores();
    const emptyBodyBytes = Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
    const exact = { data: "x".repeat(32 * 1024 - emptyBodyBytes) };
    const oversized = { data: `${exact.data}x` };

    await expect(log.append([{ stream: "control", body: exact }])).resolves.toMatchObject({
      lsn: 1,
    });
    await expect(
      log.append([{ stream: "control", body: oversized }]),
    ).rejects.toThrow("inline limit");
    const ref = await artifacts.put(Buffer.from(JSON.stringify(oversized), "utf8"));
    await expect(
      log.append([{ stream: "control", body: { t: "external", ref } }]),
    ).resolves.toMatchObject({ lsn: 2 });
  });

  it("rejects non-canonical records before they can become durable facts", async () => {
    const { artifacts, root } = await createStores();
    const invalidClockLog = new FileAuthorityCommitLog(
      path.join(root, "invalid-clock-log"),
      artifacts,
      { clock: () => "2026-01-01" },
    );
    await expect(
      invalidClockLog.append([{ stream: "control", body: { t: "event" } }]),
    ).rejects.toThrow("canonical ISO");
    await expect(invalidClockLog.readAll()).resolves.toEqual([]);

    const { log } = await createStores();
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "not-allowed",
    });
    let artifactAccessorRead = false;
    const artifactAccessor = Object.defineProperty({}, "digest", {
      enumerable: true,
      get: () => {
        artifactAccessorRead = true;
        return `sha256:${"0".repeat(64)}`;
      },
    });
    expect(() => collectArtifactRefs(artifactAccessor)).toThrow("accessor-backed");
    expect(artifactAccessorRead).toBe(false);
    await expect(
      log.append([{ stream: "control", body: accessor }]),
    ).rejects.toThrow("accessor-backed");
    await expect(
      log.append([
        { stream: "control", body: { t: "event" }, extra: true } as never,
      ]),
    ).rejects.toThrow("unknown or missing fields");
    await expect(
      log.append([{ stream: "unknown", body: { t: "event" } }]),
    ).rejects.toThrow("Invalid authority logical stream");
    await expect(log.readAll()).resolves.toEqual([]);
  });

  it("isolates a partially written tail and preserves the last complete envelope", async () => {
    const { log } = await createStores();
    await log.append([{ stream: "control", body: { t: "stable" } }]);
    const stableBytes = (await readFile(log.logPath)).byteLength;
    const partial = Buffer.alloc(9);
    partial.writeUInt32BE(100, 0);
    partial.write("{bad", 4, "utf8");
    await appendFile(log.logPath, partial);

    const recovered = await log.readAll();

    expect(recovered).toHaveLength(1);
    expect((await readdir(log.quarantineDir)).length).toBe(1);
    expect((await readFile(log.logPath)).byteLength).toBe(stableBytes);
    await expect(log.append([{ stream: "control", body: { t: "after-recovery" } }])).resolves.toMatchObject({
      lsn: 2,
    });
  });

  it("fails closed on every complete corrupt frame without discarding later commits", async () => {
    const finalTail = await createStores();
    await finalTail.log.append([{ stream: "control", body: { t: "one" } }]);
    await finalTail.log.append([{ stream: "control", body: { t: "two" } }]);
    await corruptFrame(finalTail.log.logPath, 1);
    await expect(finalTail.log.readAll()).rejects.toBeInstanceOf(AuthorityStorageError);
    await expect(readdir(finalTail.log.quarantineDir)).rejects.toMatchObject({ code: "ENOENT" });

    const interior = await createStores();
    await interior.log.append([{ stream: "control", body: { t: "one" } }]);
    await interior.log.append([{ stream: "control", body: { t: "two" } }]);
    await interior.log.append([{ stream: "control", body: { t: "three" } }]);
    await corruptFrame(interior.log.logPath, 1);

    await expect(interior.log.readAll()).rejects.toBeInstanceOf(AuthorityStorageError);
    await expect(readdir(interior.log.quarantineDir)).rejects.toMatchObject({ code: "ENOENT" });

    const corruptHeader = await createStores();
    await corruptHeader.log.append([{ stream: "control", body: { t: "one" } }]);
    await corruptHeader.log.append([{ stream: "control", body: { t: "two" } }]);
    await corruptHeader.log.append([{ stream: "control", body: { t: "three" } }]);
    const bytes = await readFile(corruptHeader.log.logPath);
    const second = frameBounds(bytes, 0).nextOffset;
    bytes[second + 12] ^= 0xff;
    await writeFile(corruptHeader.log.logPath, bytes);
    await expect(corruptHeader.log.readAll()).rejects.toBeInstanceOf(
      AuthorityStorageError,
    );
    await expect(readdir(corruptHeader.log.quarantineDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps referenced artifacts, collects old orphans, and never creates a dangling commit during GC", async () => {
    const { artifacts, log } = await createStores();
    const retained = await artifacts.put(Buffer.from("retained", "utf8"));
    const orphan = await artifacts.put(Buffer.from("orphan", "utf8"));
    await log.append([{ stream: "publish", body: { t: "asset", content: retained } }]);
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(artifacts.pathFor(retained), old, old);
    await utimes(artifacts.pathFor(orphan), old, old);

    const result = await log.collectGarbage({
      unreferencedBefore: "2021-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ scanned: 2, retained: 1, deleted: 1 });
    await expect(artifacts.has(retained)).resolves.toBe(true);
    await expect(artifacts.has(orphan)).resolves.toBe(false);

    const racing = await artifacts.put(Buffer.from("racing", "utf8"));
    await utimes(artifacts.pathFor(racing), old, old);
    const [gc, append] = await Promise.allSettled([
      log.collectGarbage({ unreferencedBefore: "2021-01-01T00:00:00.000Z" }),
      log.append([{ stream: "publish", body: { t: "asset", content: racing } }]),
    ]);
    expect(gc.status).toBe("fulfilled");
    const envelopes = await log.readAll();
    if (append.status === "fulfilled") {
      await expect(artifacts.has(racing)).resolves.toBe(true);
      expect(envelopes).toHaveLength(2);
    } else {
      expect(append.reason).toMatchObject({ code: "artifact-missing" });
      await expect(artifacts.has(racing)).resolves.toBe(false);
      expect(envelopes).toHaveLength(1);
    }
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});

async function corruptFrame(file: string, frameIndex: number): Promise<void> {
  const bytes = await readFile(file);
  let offset = 0;
  for (let index = 0; index <= frameIndex; index += 1) {
    const bounds = frameBounds(bytes, offset);
    if (index === frameIndex) {
      bytes[bounds.payloadEnd - 1] =
        bytes[bounds.payloadEnd - 1] === 0x7d ? 0x7b : 0x7d;
      await writeFile(file, bytes);
      return;
    }
    offset = bounds.nextOffset;
  }
  throw new Error("Frame does not exist");
}

function frameBounds(bytes: Buffer, offset: number): {
  payloadEnd: number;
  nextOffset: number;
} {
  const payloadBytes = bytes.readUInt32BE(offset + 8);
  const payloadEnd = offset + AUTHORITY_WAL_HEADER_BYTES + payloadBytes;
  return {
    payloadEnd,
    nextOffset: payloadEnd + AUTHORITY_WAL_TRAILER_BYTES,
  };
}
