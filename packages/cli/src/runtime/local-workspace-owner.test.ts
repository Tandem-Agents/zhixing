import { readFile, readdir, writeFile } from "node:fs/promises";
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
    await server.start();
    await expect(callLocalWorkspaceHost(home, { kind: "status" })).resolves.toEqual({
      echoed: { kind: "status" },
    });

    const secret = JSON.parse(await readFile(owner.secretPath, "utf8"));
    await writeFile(owner.secretPath, `${JSON.stringify({ ...secret, token: "A".repeat(43) })}\n`, "utf8");
    await expect(callLocalWorkspaceHost(home, { kind: "status" })).rejects.toThrow("authorized");

    await server.close();
    await owner.release();
    const successor = await acquireLocalWorkspaceOwner(home);
    await successor.release();
  });

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
  });
});

async function readTypeScriptSources(root: string): Promise<Array<{ file: string; source: string }>> {
  const result: Array<{ file: string; source: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        result.push({ file, source: await readFile(file, "utf8") });
      }
    }
  };
  await visit(root);
  return result.sort((left, right) => left.file.localeCompare(right.file, "en-US"));
}
