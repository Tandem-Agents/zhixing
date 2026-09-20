import { afterEach, describe, expect, it } from "vitest";
import { fork, type ForkOptions } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packagedExtensions } from "./catalog.js";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionPeer } from "@zhixing/core/extensions/protocol";
import { channelDeclaration } from "@zhixing/core/channels/extension";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("packaged migration artifact", () => {
  it("runs from a standalone copied file without platform packages or repository sources", async () => {
    const seed = packagedExtensions().find(({ manifest }) => manifest.id === "feishu");
    expect(seed).toBeDefined();
    expect(channelDeclaration(seed!.manifest).identityFields).toEqual(["appId"]);
    const root = await mkdtemp(join(tmpdir(), "zhixing-packaged-extension-")); roots.push(root);
    const entry = await new ExtensionArtifacts(root).import(seed!.manifest, await readFile(join(seed!.directory, seed!.manifest.entry)));
    const child = fork(entry, [], Object.assign({ cwd: root, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP }, serialization: "advanced" } as ForkOptions, { windowsHide: true }));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const peer = new ExtensionPeer((frame) => child.send(frame), async () => null);
    child.on("message", (frame) => peer.accept(frame));
    try {
      // No credentials or network operation: exercise the installed executable's protocol only.
      expect(await peer.call("control.health", null, 5_000)).toBe("starting");
      await expect(peer.call("control.start", { protocol: 999 }, 5_000)).rejects.toThrow("rejected");
      await peer.call("control.stop", null, 5_000);
    } finally { peer.close(); child.kill(); await closed; }
  });
});
