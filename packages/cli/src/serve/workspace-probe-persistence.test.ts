import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createTempDir } from "@zhixing/test-utils";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FileWorkspaceProbePersistence } from "./workspace-probe-persistence.js";

describe("FileWorkspaceProbePersistence", () => {
  it("owns the canonical probe root and durably publishes its marker", async () => {
    const fixture = await createFixture();

    await expect(fixture.persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "absent",
      authorityLog: "absent",
    });
    await fixture.log.append([
      { stream: "executor:test", body: { established: true } },
    ]);
    await expect(fixture.persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "absent",
      authorityLog: "present",
    });

    await fixture.persistence.publishEstablishment();
    await fixture.persistence.publishEstablishment();

    const markerPath = path.join(
      fixture.home,
      "distributed-runtime",
      "workspace-probes",
      "probe-log-established",
    );
    expect(await readFile(markerPath, "utf8")).toBe(
      "workspace-probe-log-v1\n",
    );
    await expect(fixture.persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "present",
      authorityLog: "present",
    });
    if (process.platform !== "win32") {
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("observes a marker whose bound executor Authority log is missing", async () => {
    const fixture = await createFixture();
    await fixture.persistence.publishEstablishment();

    await expect(fixture.persistence.inspectEstablishment()).resolves.toEqual({
      establishmentMarker: "present",
      authorityLog: "absent",
    });
  });
});

async function createFixture() {
  const home = await createTempDir("workspace-probe-persistence");
  const artifacts = new FileArtifactStore(
    path.join(home, "distributed-runtime", "artifacts"),
  );
  const log = new FileAuthorityCommitLog(
    path.join(home, "distributed-runtime", "executor-authority"),
    artifacts,
  );
  onTestFinished(() => log.stopStorageMaintenance());
  return {
    home,
    log,
    persistence: new FileWorkspaceProbePersistence({
      zhixingHome: home,
      authorityLog: log,
    }),
  };
}
