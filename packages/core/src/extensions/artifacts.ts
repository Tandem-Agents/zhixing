import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureDurableDirectory, syncDirectory } from "../persistence/index.js";
import { validateExtensionManifest, type ExtensionManifest } from "./contracts.js";

/** Immutable, self-contained artifacts; no floating install on restart or recovery. */
export class ExtensionArtifacts {
  constructor(private readonly root: string) {}

  async import(manifest: ExtensionManifest, bytes: Uint8Array): Promise<string> {
    const checked = validateExtensionManifest(manifest);
    if (createHash("sha256").update(bytes).digest("hex") !== checked.digest) throw new Error("Extension artifact digest mismatch");
    const directory = join(this.root, checked.digest);
    await ensureDurableDirectory(directory);
    const entry = join(directory, checked.entry);
    try { return await this.resolve(checked); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${entry}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, entry);
      await syncDirectory(directory);
    } finally { await rm(temporary, { force: true }); }
    await this.resolve(checked);
    return entry;
  }

  async resolve(manifest: ExtensionManifest): Promise<string> {
    const checked = validateExtensionManifest(manifest);
    const entry = join(this.root, checked.digest, checked.entry);
    const bytes = await readFile(entry);
    if (createHash("sha256").update(bytes).digest("hex") !== checked.digest) throw new Error("Extension artifact unavailable or corrupt");
    return entry;
  }
}
