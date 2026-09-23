import { defineConfig } from "tsup";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { createRequire } from "node:module";

async function buildExtensionKit() {
  const kit = "dist/extension-kit";
  await mkdir(kit, { recursive: true });
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("tsup"))("esbuild");
  for (const [entry, output] of [["../core/src/channels/extension-worker.ts", "channel-sdk.mjs"],
    ["src/runtime/extensions/validate-candidate-entry.ts", "validate.mjs"]]) {
    await build({ entryPoints: [entry], outfile: `${kit}/${output}`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  }
  await cp("../../docs/modules/extensions/authoring.md", `${kit}/authoring.md`);
  await cp("src/runtime/extensions/manifest.schema.json", `${kit}/manifest.schema.json`);
  // Copy the declaration closure from the actual built contract, not a second
  // handwritten SDK contract. Relative type imports remain resolvable offline.
  const root = resolve("../core/dist");
  const copied = new Set<string>();
  const copyType = async (file: string): Promise<void> => {
    if (copied.has(file)) return;
    if (relative(root, file).startsWith("..")) throw new Error("Contract declaration escaped core distribution");
    copied.add(file);
    const text = await readFile(file, "utf8");
    const destination = join(kit, "contracts", relative(root, file));
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, text);
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      await copyType(resolve(dirname(file), match[1]!.replace(/\.js$/, ".d.ts")));
    }
  };
  await copyType(join(root, "channels/extension-worker.d.ts"));
  await writeFile(`${kit}/channel-sdk.d.ts`, 'export { serveChannelExtension } from "./contracts/channels/extension-worker.js";\n');
}

export default defineConfig({
  entry: { index: "src/index.ts", "logging-files-worker": "src/logging/logging-files-worker.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    await buildExtensionKit();
    // Independently built migration artifacts, never imported by the CLI process.
    await mkdir("dist/extensions", { recursive: true });
    for (const directory of await readdir("../channels", { withFileTypes: true })) {
      if (directory.isDirectory()) {
        await cp(`../channels/${directory.name}/dist/extension`, `dist/extensions/${directory.name}`, { recursive: true });
      }
    }
  },
});
