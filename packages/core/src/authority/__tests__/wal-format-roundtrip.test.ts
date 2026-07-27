import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import {
  AUTHORITY_WAL_FILE_HEADER_BYTES,
  decodeAuthorityWalFileHeader,
} from "../wal-frame.js";

/**
 * 帧格式 × 读取入口的往返矩阵。
 *
 * 引入第二种帧布局后,写侧按格式分支写了两种 trailer,而读侧的精确定位入口只
 * 实现了其中一种,legacy 日志上按 checkpoint 回读必然把 payload 中段当 trailer。
 * 这里对两种格式各跑一遍"写入 → 按自身 checkpoint 回读",把该类缺口钉在最小
 * 可复现的层面上。
 */
async function newLog(root: string): Promise<FileAuthorityCommitLog> {
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  return new FileAuthorityCommitLog(path.join(root, "authority-log"), artifacts, {
    clock: () => "2026-07-24T00:00:00.000Z",
  });
}

describe("authority WAL format roundtrip", () => {
  it("reads back an envelope at its own checkpoint on a freshly created log", async () => {
    const root = await createTempDir("wal-roundtrip-versioned");
    const log = await newLog(root);
    await log.append([{ stream: "control", body: { t: "probe", value: 1 } }]);
    const checkpoint = await log.checkpoint();

    const envelope = await log.readEnvelopeAt(checkpoint);
    expect(envelope.entries.length).toBe(1);
    expect(envelope.lsn).toBe(checkpoint.lsn);
  });

  it("reads back an envelope at its own checkpoint on a pre-existing legacy log", async () => {
    const root = await createTempDir("wal-roundtrip-legacy");
    // 旧版本创建的日志没有文件头:直接落一个空文件即可让实现判定为 legacy。
    const logPath = path.join(root, "authority-log", "authority.log");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    await (await open(path.join(root, "authority-log"), "r").catch(() => null))
      ?.close();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(logPath), { recursive: true });
    const handle = await open(logPath, "wx", 0o600);
    await handle.close();

    const log = new FileAuthorityCommitLog(
      path.join(root, "authority-log"),
      artifacts,
      { clock: () => "2026-07-24T00:00:00.000Z" },
    );
    await log.append([{ stream: "control", body: { t: "probe", value: 2 } }]);
    const checkpoint = await log.checkpoint();

    // legacy 帧没有帧级 lsn 与前缀摘要,回读只能靠信封自身身份收敛,但必须成立。
    const envelope = await log.readEnvelopeAt(checkpoint);
    expect(envelope.entries.length).toBe(1);
    expect(envelope.lsn).toBe(checkpoint.lsn);
  });

  it("keeps a pre-existing legacy log in its original format", async () => {
    const root = await createTempDir("wal-roundtrip-no-migration");
    const logPath = path.join(root, "authority-log", "authority.log");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(logPath), { recursive: true });
    const created = await open(logPath, "wx", 0o600);
    await created.close();
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority-log"),
      artifacts,
      { clock: () => "2026-07-24T00:00:00.000Z" },
    );
    await log.append([{ stream: "control", body: { t: "probe", value: 3 } }]);

    // 不主动迁移:旧二进制必须能继续读它自己创建的日志,因此开头不得出现文件头。
    const reader = await open(logPath, "r");
    try {
      const head = Buffer.alloc(AUTHORITY_WAL_FILE_HEADER_BYTES);
      await reader.read(head, 0, head.byteLength, 0);
      expect(() => decodeAuthorityWalFileHeader(head)).toThrow();
    } finally {
      await reader.close();
    }
  });
});
