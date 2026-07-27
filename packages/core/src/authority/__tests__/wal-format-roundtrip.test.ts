import { Buffer } from "node:buffer";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { canonicalize, protocolDigest } from "../../protocol/index.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import {
  AUTHORITY_WAL_FILE_HEADER_BYTES,
  type AuthorityWalReader,
  encodeAuthorityWalFileHeader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
} from "../wal-frame.js";

async function newLog(root: string): Promise<FileAuthorityCommitLog> {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  return new FileAuthorityCommitLog(path.join(root, "authority-log"), artifacts, {
    clock: () => "2026-07-24T00:00:00.000Z",
  });
}

describe("authority WAL compatibility bridge", () => {
  it("keeps new logs on legacy frames with a stable sidecar identity", async () => {
    const root = await createTempDir("wal-bridge-legacy");
    const log = await newLog(root);
    await log.append([{ stream: "control", body: { t: "legacy-one" } }]);
    const firstBytes = await readFile(log.logPath);
    const firstIdentity = await readFile(log.identityPath);

    expect(firstBytes.readUInt16BE(4)).toBe(1);
    expect(firstIdentity).toHaveLength(AUTHORITY_WAL_FILE_HEADER_BYTES);

    const reopened = await newLog(root);
    await expect(reopened.readAll()).resolves.toHaveLength(1);
    await reopened.append([
      { stream: "control", body: { t: "legacy-two" } },
    ]);
    expect(await readFile(log.identityPath)).toEqual(firstIdentity);

    const metadata: unknown[] = [];
    const scanned = await scanAuthorityWalFrames(
      bufferReader(await readFile(log.logPath)),
      (_payload, _offset, frameMetadata) => {
        metadata.push(frameMetadata);
      },
    );
    expect(scanned.frameCount).toBe(2);
    expect(metadata).toEqual([undefined, undefined]);
  });

  it("dual-reads and continues an already-versioned WAL", async () => {
    const root = await createTempDir("wal-bridge-versioned");
    const logRoot = path.join(root, "authority-log");
    await mkdir(logRoot, { recursive: true });
    const logIdBytes = Buffer.alloc(32, 0x17);
    const logId = logIdBytes.toString("base64url");
    const entries = [{ stream: "control", body: { t: "versioned-one" } }];
    const payload = {
      v: 1 as const,
      lsn: 1,
      at: "2026-07-24T00:00:00.000Z",
      entries,
    };
    const envelope = {
      ...payload,
      envelopeDigest: protocolDigest("CommitEnvelope", 1, payload),
    };
    const prefixDigest = protocolDigest("AuthorityLogPrefix", 1, {
      logId,
      previousDigest: protocolDigest("AuthorityLogPrefix", 1, { logId }),
      lsn: 1,
      envelopeDigest: envelope.envelopeDigest,
    });
    const logPath = path.join(logRoot, "authority.log");
    await writeFile(
      logPath,
      Buffer.concat([
        encodeAuthorityWalFileHeader(logIdBytes),
        encodeAuthorityWalFrame(
          Buffer.from(canonicalize(envelope), "utf8"),
          { lsn: 1, prefixDigest },
        ),
      ]),
    );

    const log = await newLog(root);
    await expect(log.readAll()).resolves.toEqual([envelope]);
    await log.append([
      { stream: "control", body: { t: "versioned-two" } },
    ]);

    const metadata: unknown[] = [];
    const bytes = await readFile(logPath);
    const scanned = await scanAuthorityWalFrames(
      bufferReader(bytes.subarray(AUTHORITY_WAL_FILE_HEADER_BYTES)),
      (_payload, _offset, frameMetadata) => {
        metadata.push(frameMetadata);
      },
    );
    expect(scanned.frameCount).toBe(2);
    expect(metadata).toMatchObject([
      { lsn: 1, prefixDigest },
      { lsn: 2 },
    ]);
  });

  it("fails closed when a legacy WAL and its sidecar identity diverge", async () => {
    const root = await createTempDir("wal-bridge-corrupt-identity");
    const log = await newLog(root);
    await log.append([{ stream: "control", body: { t: "stable" } }]);
    await writeFile(log.identityPath, Buffer.from("corrupt"));
    await expect((await newLog(root)).readAll()).rejects.toMatchObject({
      code: "commit-log-corrupt",
    });

    const missingRoot = await createTempDir("wal-bridge-missing-log");
    const missing = await newLog(missingRoot);
    await missing.append([{ stream: "control", body: { t: "stable" } }]);
    expect((await stat(missing.identityPath)).isFile()).toBe(true);
    await rm(missing.logPath);
    await expect((await newLog(missingRoot)).readAll()).rejects.toMatchObject({
      code: "commit-log-corrupt",
    });
  });
});

function bufferReader(bytes: Buffer): AuthorityWalReader {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, offset + length);
    },
  };
}
