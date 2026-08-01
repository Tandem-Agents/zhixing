import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  LocalWorkspaceTransportServer,
  acquireLocalWorkspaceOwner,
  callLocalWorkspaceHost,
} from "./local-workspace-owner.js";

describe("local workspace management ownership", () => {
  it("admits one cross-process owner and exposes only its authenticated local transport", async () => {
    const home = await createTempDir("workspace-owner");
    const owner = await acquireLocalWorkspaceOwner(home);
    await expect(acquireLocalWorkspaceOwner(home)).rejects.toThrow("busy");

    const server = new LocalWorkspaceTransportServer(owner, async (body) => ({ echoed: body }));
    await writeFile(owner.secretPath, "stale-publication\n", "utf8");
    await writeFile(`${owner.secretPath}.tmp`, "stale-secret-publication\n", "utf8");
    await server.start();
    await expect(readFile(`${owner.secretPath}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(callLocalWorkspaceHost(home, { kind: "status" })).resolves.toEqual({
      echoed: { kind: "status" },
    });

    const secret = JSON.parse(await readFile(owner.secretPath, "utf8"));
    await writeFile(owner.secretPath, `${JSON.stringify({ ...secret, token: "A".repeat(43) })}\n`, "utf8");
    await expect(callLocalWorkspaceHost(home, { kind: "status" })).rejects.toThrow("authorized");

    await server.close();
    await expect(readFile(owner.secretPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${owner.secretPath}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await owner.release();
    const successor = await acquireLocalWorkspaceOwner(home);
    await successor.release();
  });

  it.each([
    ["write-before", ""],
    ["write-after", "valid"],
    ["sync-after", "valid"],
    ["rename-before", "valid"],
    ["rename-after", "published"],
  ] as const)(
    "lets a successor erase a hard-crash secret publication at %s",
    async (_boundary, artifact) => {
      const home = await createTempDir("workspace-owner-crash-boundary");
      const crashedOwner = await acquireLocalWorkspaceOwner(home);
      const staleSecret = `${JSON.stringify({
        v: 1,
        user: os.userInfo().username,
        token: "A".repeat(43),
      })}\n`;
      if (artifact === "published") {
        await writeFile(crashedOwner.secretPath, staleSecret, "utf8");
      } else {
        await writeFile(
          `${crashedOwner.secretPath}.tmp`,
          artifact === "valid" ? staleSecret : "",
          "utf8",
        );
      }
      await crashedOwner.release();

      const successor = await acquireLocalWorkspaceOwner(home);
      const server = new LocalWorkspaceTransportServer(successor, async () => ({ ok: true }));
      await server.start();
      await expect(readFile(`${successor.secretPath}.tmp`, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      const current = JSON.parse(await readFile(successor.secretPath, "utf8"));
      expect(current.token).not.toBe("A".repeat(43));
      await server.close();
      await successor.release();
      await expect(readFile(successor.secretPath, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps authority, capacity and outbox construction behind one production composition root", async () => {
    const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await readTypeScriptSources(sourceRoot);
    const hostConstructors = sources.filter(({ source }) => source.includes("new LocalWorkspaceManagementHost("));
    const outboxConstructors = sources.filter(({ source }) => source.includes("new LocalWorkspaceOperationOutbox("));
    expect(hostConstructors.map(({ file }) => path.basename(file))).toEqual([
      "local-workspace-management-host.ts",
    ]);
    expect(outboxConstructors.map(({ file }) => path.basename(file))).toEqual([
      "local-workspace-management-host.ts",
    ]);
    expect(sources.some(({ source }) => source.includes("workspace-settings-capacity"))).toBe(false);
    const accessSurface = sources.find(({ file }) => file.endsWith("access-surfaces.ts"))!.source;
    expect(accessSurface.indexOf('startupRollback.register(\n        "localWorkspaceHost.close"'))
      .toBeLessThan(accessSurface.indexOf("await host.start()"));
    for (const fileName of ["executor-role-runtime.ts", "workspace-command.ts"]) {
      const source = sources.find(({ file }) => file.endsWith(fileName))!.source;
      expect(source.indexOf("= createExecutorLocalWorkspaceHost({"))
        .toBeLessThan(source.indexOf("await localWorkspaceHost.start()") >= 0
          ? source.indexOf("await localWorkspaceHost.start()")
          : source.indexOf("await host.start()"));
    }
  });
});

async function readTypeScriptSources(root: string): Promise<Array<{ file: string; source: string }>> {
  const result: Array<{ file: string; source: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "__tests__") await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        result.push({ file, source: await readFile(file, "utf8") });
      }
    }
  };
  await visit(root);
  return result.sort((left, right) => left.file.localeCompare(right.file, "en-US"));
}
