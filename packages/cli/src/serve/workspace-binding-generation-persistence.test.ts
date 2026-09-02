import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import { createTempDir } from "@zhixing/test-utils";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FileWorkspaceBindingGenerationPersistenceFactory } from "./workspace-binding-generation-persistence.js";

describe("FileWorkspaceBindingGenerationPersistenceFactory", () => {
  it("pairs the canonical initial generation marker with the concrete Executor WAL", async () => {
    const home = await createTempDir("workspace-binding-generation");
    const log = createLog(home, "executor-authority");
    const persistence = new FileWorkspaceBindingGenerationPersistenceFactory({
      zhixingHome: home,
    }).create("catalog-initial", log);

    await expect(persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "absent",
      authorityLog: "absent",
    });
    await log.append([
      {
        stream: "executor:workspace-bindings",
        body: { established: true },
      },
    ]);
    await persistence.publishEstablishment();
    await expect(persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "present",
      authorityLog: "present",
    });

    const markerPath = path.join(
      home,
      "distributed-runtime",
      "workspace-bindings",
      "generations",
      "catalog-initial",
      "directory-established",
    );
    expect(await readFile(markerPath, "utf8")).toBe(
      "workspace-binding-directory-v1\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps successor markers paired to their own concrete catalog WAL", async () => {
    const home = await createTempDir("workspace-binding-successor");
    const initialLog = createLog(home, "executor-authority");
    const successorLog = createLog(home, "successor-authority");
    const factory = new FileWorkspaceBindingGenerationPersistenceFactory({
      zhixingHome: home,
    });
    const initial = factory.create("catalog-initial", initialLog);
    const successor = factory.create("catalog-successor", successorLog);

    await initialLog.append([
      {
        stream: "executor:workspace-bindings",
        body: { initial: true },
      },
    ]);
    await successorLog.append([
      {
        stream: "executor:workspace-bindings",
        body: { successor: true },
      },
    ]);
    await successor.publishEstablishment();

    await expect(initial.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "absent",
      authorityLog: "present",
    });
    await expect(successor.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "present",
      authorityLog: "present",
    });
  });
});

function createLog(home: string, name: string): FileAuthorityCommitLog {
  const log = new FileAuthorityCommitLog(
    path.join(home, "logs", name),
    new FileArtifactStore(path.join(home, "artifacts")),
  );
  onTestFinished(() => log.stopStorageMaintenance());
  return log;
}
