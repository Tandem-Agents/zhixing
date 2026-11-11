import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  assertPhysicallyIndependentDirectory,
  FileRecoveryCheckpointTarget,
  RecoveryCheckpointTargetError,
} from "../checkpoint-target.js";

describe("恢复备份目录的物理独立判定", () => {
  it("只读预检在两侧都还没创建时按最近已存在的上级判定同卷，带码拒绝且不创建任何目录", async () => {
    const root = await createTempDir("checkpoint-independence-preflight");
    const sourceRoot = path.join(root, "home", "distributed-runtime", "authority");
    const targetRoot = path.join(root, "backup", "nested");
    const rejection = assertPhysicallyIndependentDirectory({ sourceRoot, targetRoot });
    await expect(rejection).rejects.toBeInstanceOf(RecoveryCheckpointTargetError);
    await expect(rejection).rejects.toMatchObject({ code: "not-physically-independent" });
    expect(await readdir(root)).toEqual([]);
  });

  it("打开目标时的权威判定用同一类型化错误", async () => {
    const root = await createTempDir("checkpoint-independence-open");
    const sourceRoot = path.join(root, "authority");
    await mkdir(sourceRoot);
    await expect(FileRecoveryCheckpointTarget.open({ sourceRoot, targetRoot: path.join(root, "backup") }))
      .rejects.toMatchObject({ name: "RecoveryCheckpointTargetError", code: "not-physically-independent" });
  });
});
