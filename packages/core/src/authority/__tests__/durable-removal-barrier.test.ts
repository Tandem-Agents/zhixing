import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRef } from "../../contracts/index.js";

/**
 * 目录同步探针:记录每次目录屏障并可注入一次失败。
 *
 * 通过 mock `durable-directory` 而不是各消费者,既能观测"删除后是否真的完成了
 * 屏障",也能证明屏障失败时调用方不会拿到可推进状态的结论。
 */
const directorySyncs: string[] = [];
let failSyncFor: string | undefined;

vi.mock("../../persistence/durable-directory.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../persistence/durable-directory.js")
  >();
  return {
    ...actual,
    syncDirectory: async (directory: string): Promise<void> => {
      directorySyncs.push(path.resolve(directory));
      if (
        failSyncFor !== undefined &&
        path.resolve(directory) === path.resolve(failSyncFor)
      ) {
        failSyncFor = undefined;
        throw Object.assign(new Error("injected directory sync failure"), {
          code: "EIO",
        });
      }
      await actual.syncDirectory(directory);
    },
  };
});

const {
  FileArtifactStore,
  FileArtifactTemporaryPresenceStore,
  FileAuthorityCommitLog,
  FileResumableArtifactReceiver,
} = await import("../index.js");
const { byteDigest } = await import("../../protocol/index.js");
const { durablyRemoveFile, durablyRemoveFiles } = await import(
  "../../persistence/index.js"
);

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;
const RECEIVER_OPTIONS = { maxArtifactBytes: 1024 * 1024 } as const;

function refFor(bytes: Uint8Array): ArtifactRef {
  return { digest: byteDigest(bytes), bytes: bytes.byteLength };
}

function syncsOf(directory: string): number {
  const resolved = path.resolve(directory);
  return directorySyncs.filter((entry) => entry === resolved).length;
}

/** 扫描型执行点的删除结论:计数本身,或 GC 结果中的 deleted。 */
function removalCountOf(result: unknown): number {
  if (typeof result === "number") return result;
  if (
    typeof result === "object" &&
    result !== null &&
    "deleted" in result &&
    typeof (result as { readonly deleted: unknown }).deleted === "number"
  ) {
    return (result as { readonly deleted: number }).deleted;
  }
  throw new TypeError("Scanning removal must report a deletion count");
}

beforeEach(() => {
  directorySyncs.length = 0;
  failSyncFor = undefined;
});

afterEach(() => {
  failSyncFor = undefined;
});

describe("durable removal barrier", () => {
  /**
   * 每个执行点都必须满足同一份合同:删除结论只在目录屏障成功后才返回,而屏障
   * 失败后的重试即使观察到目标已缺失,也要重新同步目录。
   */
  interface RemovalExecutionPoint {
    readonly name: string;
    /**
     * targeted:调用方指名目标并消费该目标的删除结论,因此重试即使观察到缺失
     * 也必须重新完成屏障,才能返回"已删除/不存在"。
     * scanning:调用方不指名目标,只对本轮实际发现并删除的对象计数;重试时该
     * 目标已不在扫描结果内,不产生任何关于它的结论,故本轮零删除、零屏障即为
     * 正确——但已计入的删除必须先过屏障。
     */
    readonly kind: "targeted" | "scanning";
    /** 建立"该目标已存在"的初始物理状态,返回被删目标所在目录。 */
    readonly prepare: (root: string) => Promise<{
      readonly directory: string;
      readonly remove: () => Promise<unknown>;
    }>;
  }

  const executionPoints: readonly RemovalExecutionPoint[] = [
    {
      name: "FileArtifactStore.discard",
      kind: "targeted",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const ref = await store.put(Buffer.from("discard"));
        return {
          directory: path.dirname(store.pathFor(ref)),
          remove: () => store.discard(ref),
        };
      },
    },
    {
      name: "FileArtifactStore.delete",
      kind: "targeted",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const ref = await store.put(Buffer.from("delete"));
        return {
          directory: path.dirname(store.pathFor(ref)),
          remove: () => store.delete(ref),
        };
      },
    },
    {
      name: "FileArtifactStore.deleteIfUnreferencedBatch",
      kind: "targeted",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const ref = await store.put(Buffer.from("batch"));
        return {
          directory: path.dirname(store.pathFor(ref)),
          remove: () =>
            store.deleteIfUnreferencedBatch([ref], async () => ({
              status: "current",
              retained: [],
            })),
        };
      },
    },
    {
      name: "FileAuthorityCommitLog.collectGarbage",
      kind: "scanning",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const log = new FileAuthorityCommitLog(path.join(root, "log"), store);
        const ref = await store.put(Buffer.from("sweep"));
        return {
          directory: path.dirname(store.pathFor(ref)),
          remove: () =>
            log.collectGarbage({
              unreferencedBefore: new Date(Date.now() + 60_000).toISOString(),
            }),
        };
      },
    },
    {
      name: "FileResumableArtifactReceiver.discard",
      kind: "targeted",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const partials = path.join(root, "partials");
        const receiver = new FileResumableArtifactReceiver(
          store,
          partials,
          RECEIVER_OPTIONS,
        );
        const bytes = Buffer.from("resumable partial payload");
        const ref = { digest: byteDigest(bytes), bytes: bytes.byteLength + 8 };
        await receiver.append(ref, 0, bytes);
        return { directory: partials, remove: () => receiver.discard(ref) };
      },
    },
    {
      name: "FileResumableArtifactReceiver.discardPartialsBefore",
      kind: "scanning",
      prepare: async (root) => {
        const store = new FileArtifactStore(path.join(root, "artifacts"));
        const partials = path.join(root, "partials");
        const receiver = new FileResumableArtifactReceiver(
          store,
          partials,
          RECEIVER_OPTIONS,
        );
        const bytes = Buffer.from("expiring partial payload");
        const ref = { digest: byteDigest(bytes), bytes: bytes.byteLength + 8 };
        await receiver.append(ref, 0, bytes);
        return {
          directory: partials,
          remove: () =>
            receiver.discardPartialsBefore(new Date(Date.now() + 60_000)),
        };
      },
    },
    {
      name: "FileArtifactTemporaryPresenceStore.removeScopes",
      kind: "targeted",
      prepare: async (root) => {
        const presence = new FileArtifactTemporaryPresenceStore(
          path.join(root, "presence"),
        );
        const ref = refFor(Buffer.from("presence scope"));
        await presence.mark(ref, "scope-a");
        await presence.mark(ref, "scope-b");
        return {
          // 仍有第二个 scope 时目录不会被回收,屏障必须落在 digest 目录上。
          directory: path.join(
            presence.rootDir,
            ref.digest.slice("sha256:".length),
          ),
          remove: () => presence.removeScopes(ref, ["scope-a"]),
        };
      },
    },
    {
      name: "FileArtifactTemporaryPresenceStore.remove",
      kind: "targeted",
      prepare: async (root) => {
        const presence = new FileArtifactTemporaryPresenceStore(
          path.join(root, "presence"),
        );
        const ref = refFor(Buffer.from("presence whole"));
        await presence.mark(ref, "scope-a");
        return {
          directory: presence.rootDir,
          remove: () => presence.remove(ref),
        };
      },
    },
    {
      name: "FileArtifactTemporaryPresenceStore.finishLegacyMigration",
      kind: "targeted",
      prepare: async (root) => {
        const presence = new FileArtifactTemporaryPresenceStore(
          path.join(root, "presence"),
        );
        const ref = refFor(Buffer.from("presence migration"));
        await presence.mark(ref, "scope-a");
        await presence.beginLegacyMigration(ref);
        return {
          directory: path.join(
            presence.rootDir,
            ref.digest.slice("sha256:".length),
          ),
          remove: () => presence.finishLegacyMigration(ref),
        };
      },
    },
    {
      name: "FileArtifactTemporaryPresenceStore.removeStagingFiles",
      kind: "scanning",
      prepare: async (root) => {
        const presence = new FileArtifactTemporaryPresenceStore(
          path.join(root, "presence"),
        );
        const ref = refFor(Buffer.from("presence staging"));
        await presence.mark(ref, "scope-a");
        const digestDirectory = path.join(
          presence.rootDir,
          ref.digest.slice("sha256:".length),
        );
        const [marker] = (await readdir(digestDirectory)).filter((name) =>
          name.endsWith(".json")
        );
        await writeFile(
          path.join(digestDirectory, `.${marker}.tmp`),
          "staging",
          "utf8",
        );
        return {
          directory: digestDirectory,
          remove: () => presence.removeStagingFiles(),
        };
      },
    },
  ];

  for (const point of executionPoints) {
    it(
      `${point.name} completes its directory barrier before reporting removal`,
      async () => {
        const root = await createTempDir("durable-removal");
        const { directory, remove } = await point.prepare(root);

        directorySyncs.length = 0;
        await remove();
        expect(syncsOf(directory)).toBeGreaterThanOrEqual(1);
      },
      DURABLE_IO_TEST_TIMEOUT_MS,
    );

    it(
      `${point.name} retries the barrier after a sync failure`,
      async () => {
        const root = await createTempDir("durable-removal");
        const { directory, remove } = await point.prepare(root);

        // 首次:unlink 生效但目录同步失败,调用方必须拿到失败而不是删除结论。
        failSyncFor = directory;
        await expect(remove()).rejects.toThrow(
          /injected directory sync failure/u,
        );

        directorySyncs.length = 0;
        const retried = await remove();
        if (point.kind === "targeted") {
          // 目标已经不在,屏障仍必须重新执行——这正是历次复发的缺口。
          expect(syncsOf(directory)).toBeGreaterThanOrEqual(1);
        } else {
          // 扫描型重试不再发现该目标,因此不得把上一轮未确认的删除计入结论。
          expect(removalCountOf(retried)).toBe(0);
        }
      },
      DURABLE_IO_TEST_TIMEOUT_MS,
    );
  }

  it(
    "reports a missing artifact only after the barrier succeeded",
    async () => {
      const root = await createTempDir("durable-removal");
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const ref = await store.put(Buffer.from("missing disposition"));
      const directory = path.dirname(store.pathFor(ref));
      const load = async () => ({ status: "current" as const, retained: [] });

      failSyncFor = directory;
      await expect(
        store.deleteIfUnreferencedBatch([ref], load),
      ).rejects.toThrow(/injected directory sync failure/u);

      directorySyncs.length = 0;
      const results = await store.deleteIfUnreferencedBatch([ref], load);
      expect(results[0]?.disposition).toBe("missing");
      expect(syncsOf(directory)).toBeGreaterThanOrEqual(1);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the partial finalize barrier when the receiver promotes an artifact",
    async () => {
      const root = await createTempDir("durable-removal");
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const partials = path.join(root, "partials");
      const receiver = new FileResumableArtifactReceiver(
        store,
        partials,
        RECEIVER_OPTIONS,
      );
      const bytes = Buffer.from("finalized payload");
      const ref = refFor(bytes);

      directorySyncs.length = 0;
      const progress = await receiver.append(ref, 0, bytes);
      expect(progress.complete).toBe(true);
      // 提升成功后 partial 必须在同一调用内完成删除屏障。
      expect(syncsOf(partials)).toBeGreaterThanOrEqual(1);
      await expect(stat(receiverPartialPath(partials, ref))).rejects.toThrow();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

describe("durable removal primitive", () => {
  it(
    "completes every directory barrier before surfacing a partial failure",
    async () => {
      const root = await createTempDir("durable-removal");
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      await writeFile(first, "first", "utf8");
      await writeFile(second, "second", "utf8");
      // 目录项:删除时抛 EPERM 而非 ENOENT,模拟中途出现的非缺失故障。
      const blocked = path.join(root, "blocked-directory");
      await mkdir(blocked);

      directorySyncs.length = 0;
      await expect(
        durablyRemoveFiles([first, blocked, second]),
      ).rejects.toThrow();

      // 首个错误被保留,但两个真实删除必须已经过屏障,失败路径不得留下更宽的
      // 未耐久窗口。
      expect(syncsOf(root)).toBeGreaterThanOrEqual(1);
      await expect(stat(first)).rejects.toThrow();
      await expect(stat(second)).rejects.toThrow();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "skips the barrier only when there is nothing to remove",
    async () => {
      const root = await createTempDir("durable-removal");
      directorySyncs.length = 0;
      await expect(durablyRemoveFiles([])).resolves.toBe(0);
      expect(directorySyncs).toEqual([]);

      // 目标缺失仍是一次删除结论,必须完成屏障。
      await expect(
        durablyRemoveFile(path.join(root, "absent")),
      ).resolves.toBe(false);
      expect(syncsOf(root)).toBe(1);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

describe("durable removal single source", () => {
  /**
   * 静态对账:除耐久删除原语自身外,authority 生产代码不得再直接调用文件系统
   * 删除,唯一例外是清理本次写入自建的临时/暂存文件——它们从未被任何下游状态
   * 引用,残留由既有 staging 清理与 sweep 兜底。
   */
  const SELF_CREATED = /temporar|staging|tmp/iu;

  it("keeps every authority deletion on the shared durable primitive", async () => {
    const authorityDir = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      "..",
    );
    const files = (await readdir(authorityDir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts"),
      )
      .map((entry) => path.join(authorityDir, entry.name));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const lines = source.split(/\r?\n/u);
      lines.forEach((line, index) => {
        const match = /\b(?:rm|rmdir|unlink)\(/u.exec(line);
        if (!match) return;
        // 参数区从调用括号延伸到行尾:自建临时/暂存文件在同一行写明其命名。
        if (SELF_CREATED.test(line.slice(match.index))) return;
        offenders.push(`${path.basename(file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

function receiverPartialPath(root: string, ref: ArtifactRef): string {
  return path.join(
    root,
    `${ref.digest.slice("sha256:".length)}.${ref.bytes}.part`,
  );
}
