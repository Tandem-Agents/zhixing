import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExtensionManifest, type ExtensionManifest } from "@zhixing/core/extensions/contracts";

export interface PackagedExtension { readonly manifest: ExtensionManifest; readonly directory: string }

/** Distribution-owned migration seeds. Installed candidates are admitted separately. */
export function packagedExtensions(): readonly PackagedExtension[] {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("CLI package root is unavailable");
    directory = parent;
  }
  const root = join(directory, "dist", "extensions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const location = join(root, entry.name);
    return { directory: location, manifest: validateExtensionManifest(JSON.parse(readFileSync(join(location, "manifest.json"), "utf8"))) };
  });
}
