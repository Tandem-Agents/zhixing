import { mkdir, readFile, readdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableLogCheckpoint } from "../interfaces.js";

/**
 * 精确复现耐久删除原语在"单个文件删除失败"时的真实行为:其余文件照常删完,
 * 目录屏障照常完成,最后抛出首个错误。
 *
 * 这正是 U23-43 的成因——写意图凭据若与它所描述的对象同批删除,就会在对象仍
 * 残留时被删掉,孤儿从此失去恢复入口。测试因此必须模拟"部分成功"而不是整批失败。
 *
 * 驱动方式:写意图的清理名单只装"本份意图自己新建的对象"——提交后删
 * `transientFiles`(本份意图新建又被本份意图取代的对象),回滚则删 `createdFiles`。
 * 跨代失效的旧段与旧目录页走的是退休页机制,有各自的凭据,不进写意图名单。
 * 因此"多提几次 flush 触发 compaction"并不会让段文件出现在写意图清理里;能够
 * 必然产生非空清理名单的是提交失败后的回滚,以及由未清对象继承而来的后续意图。
 */

/** 拦截开关:只影响写意图清理这一条调用。 */
let blockIntentCleanup = false;
/** 被拦下的派生对象文件名,供断言核对孤儿确实留在了磁盘上。 */
let blockedFile: string | undefined;

vi.mock("../../persistence/durable-removal.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../persistence/durable-removal.js")
  >();
  return {
    ...actual,
    durablyRemoveFiles: async (files: readonly string[]): Promise<number> => {
      // 写意图清理是唯一会把新建文件的 `.tmp` 影子一并列入的调用;退休回收与
      // 派生清空各有自己的凭据和名单,不应被这条注入波及。
      const isIntentCleanup = files.some((file) =>
        /^\..+\.tmp$/u.test(path.basename(file))
      );
      if (!blockIntentCleanup || !isIntentCleanup) {
        return actual.durablyRemoveFiles(files);
      }
      const blocked = files.find((file) =>
        path.basename(file).startsWith("segment-")
      );
      if (blocked === undefined) return actual.durablyRemoveFiles(files);
      blockedFile = path.basename(blocked);
      const removed = await actual.durablyRemoveFiles(
        files.filter((file) => file !== blocked),
      );
      throw Object.assign(new Error("injected removal failure"), {
        code: "EPERM",
        removed,
      });
    },
  };
});

const { FileDurableProjectionIndex } = await import("../index.js");

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

function checkpoint(lsn: number): DurableLogCheckpoint {
  return {
    logId: "write-intent-log",
    lsn,
    frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}`,
  };
}

function createIndex(rootDir: string) {
  return new FileDurableProjectionIndex({
    rootDir,
    projectionId: "test.write-intent-cleanup",
    reducerVersion: 1,
  });
}

type ProjectionIndex = ReturnType<typeof createIndex>;

async function commitOnce(
  index: ProjectionIndex,
  key: string,
  lsn: number,
): Promise<void> {
  const prepared = await index.prepare([{ kind: "put", key, value: { key } }]);
  index.publish(prepared, { source: checkpoint(lsn) });
  await index.flush();
}

/**
 * 用一个真实的耐久写失败点制造回滚:manifest 的临时路径被目录占用,段文件已经
 * 落盘改名、意图已经记录,提交却必然失败。回滚清理因此拿到一份非空的
 * `createdFiles`,注入即可拦下其中一个派生对象。返回被拦下的孤儿文件名。
 */
async function retainRolledBackIntent(
  index: ProjectionIndex,
  root: string,
  key: string,
  lsn: number,
): Promise<string> {
  blockedFile = undefined;
  blockIntentCleanup = true;
  const guard = path.join(root, ".manifest.tmp");
  await mkdir(guard);
  try {
    const prepared = await index.prepare([{ kind: "put", key, value: { key } }]);
    index.publish(prepared, { source: checkpoint(lsn) });
    await expect(index.flush()).rejects.toThrow();
  } finally {
    await rmdir(guard);
  }
  expect(blockedFile).toBeDefined();
  return blockedFile as string;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  return readFile(file, "utf8").then(
    (text) => JSON.parse(text) as T,
    () => undefined,
  );
}

/**
 * 判断磁盘上被保留的凭据是否处于"已提交、且 manifest 此后又被推进过"的状态:
 * compaction 收尾的退休回收会在清理之后再写一次 manifest,凭据记录的摘要因此
 * 失配,只有单调 generation 才能判出它已经提交。恢复必须按已提交语义只删
 * `transientFiles`,不得按回滚语义去删 `createdFiles`。
 */
async function retainedIntentIsCommitted(rootDir: string): Promise<boolean> {
  const intent = await readJson<{
    targetGeneration: number;
    transientFiles: string[];
  }>(path.join(rootDir, "write-intent.json"));
  const manifest = await readJson<{ generation: number }>(
    path.join(rootDir, "manifest.json"),
  );
  if (!intent || !manifest) return false;
  return (
    intent.transientFiles.length > 0 &&
    manifest.generation > intent.targetGeneration
  );
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function orphanSegments(rootDir: string): Promise<string[]> {
  const files = await readdir(rootDir);
  return files.filter((name) => name.startsWith("segment-")).sort();
}

beforeEach(() => {
  blockIntentCleanup = false;
  blockedFile = undefined;
});

describe("projection write intent cleanup", () => {
  it(
    "keeps the write intent when one of its files cannot be removed",
    async () => {
      const root = await createTempDir("write-intent-cleanup");
      const index = createIndex(root);
      await index.initialize({ source: checkpoint(0) });
      await commitOnce(index, "key-1", 1);
      const orphan = await retainRolledBackIntent(index, root, "key-2", 2);

      // 凭据必须仍在:对象没清干净就删掉凭据,孤儿从此再也没有恢复入口。
      await expect(
        exists(path.join(root, "write-intent.json")),
      ).resolves.toBe(true);
      await expect(exists(path.join(root, orphan))).resolves.toBe(true);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "finishes the cleanup from the retained intent when the index is reopened",
    async () => {
      const root = await createTempDir("write-intent-cleanup");
      const index = createIndex(root);
      await index.initialize({ source: checkpoint(0) });
      await commitOnce(index, "key-1", 1);
      const orphan = await retainRolledBackIntent(index, root, "key-2", 2);

      // 阻塞解除后重开索引:恢复必须按保留下来的凭据完成清理并删除凭据本身。
      blockIntentCleanup = false;
      const reopened = createIndex(root);
      await reopened.initialize({ source: checkpoint(0) });

      await expect(exists(path.join(root, orphan))).resolves.toBe(false);
      await expect(
        exists(path.join(root, "write-intent.json")),
      ).resolves.toBe(false);
      // 恢复不得误伤仍被 manifest 引用的数据,也不得让未提交的写入复活。
      await expect(reopened.get("key-1")).resolves.toEqual({ key: "key-1" });
      await expect(reopened.get("key-2")).resolves.toBeUndefined();
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "carries the uncleared file into the next write intent within one process",
    async () => {
      const root = await createTempDir("write-intent-cleanup");
      const index = createIndex(root);
      await index.initialize({ source: checkpoint(0) });
      await commitOnce(index, "key-1", 1);
      const orphan = await retainRolledBackIntent(index, root, "key-2", 2);

      // 同进程继续 flush 会用新意图覆盖磁盘凭据,清理义务必须随之转移而不是丢失。
      blockIntentCleanup = false;
      await commitOnce(index, "key-next", 3);

      await expect(exists(path.join(root, orphan))).resolves.toBe(false);
      await expect(
        exists(path.join(root, "write-intent.json")),
      ).resolves.toBe(false);
      await expect(index.get("key-1")).resolves.toEqual({ key: "key-1" });
      await expect(index.get("key-next")).resolves.toEqual({ key: "key-next" });
      // 清理完成后目录里不应再留下任何未被 manifest 引用的孤儿段。
      const remaining = await orphanSegments(root);
      expect(remaining).not.toContain(orphan);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "finishes the cleanup of a retained intent that already committed",
    async () => {
      const root = await createTempDir("write-intent-cleanup");
      const index = createIndex(root);
      await index.initialize({ source: checkpoint(0) });
      await commitOnce(index, "key-1", 1);
      const orphan = await retainRolledBackIntent(index, root, "key-2", 2);

      // 未清对象被后续意图继承进 `transientFiles`,清理持续被拦,凭据因此一直
      // 留在磁盘上。一直提交到留下的那份凭据处于"已提交且 manifest 又被推进过"
      // 为止,并把这个状态作为前提断言,避免用例在流程变化后静默退化成回滚场景。
      let lastKey = "key-1";
      let committed = false;
      for (let lsn = 3; lsn <= 12 && !committed; lsn += 1) {
        lastKey = `key-${lsn}`;
        await commitOnce(index, lastKey, lsn);
        committed = await retainedIntentIsCommitted(root);
      }
      expect(committed).toBe(true);
      await expect(exists(path.join(root, orphan))).resolves.toBe(true);

      blockIntentCleanup = false;
      const reopened = createIndex(root);
      await reopened.initialize({ source: checkpoint(0) });

      // 恢复必须按已提交语义收尾:清掉 `transientFiles`、删除凭据,并且不碰
      // manifest 仍在引用的任何对象。
      await expect(exists(path.join(root, orphan))).resolves.toBe(false);
      await expect(
        exists(path.join(root, "write-intent.json")),
      ).resolves.toBe(false);
      await expect(reopened.get("key-1")).resolves.toEqual({ key: "key-1" });
      await expect(reopened.get(lastKey)).resolves.toEqual({ key: lastKey });
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});
