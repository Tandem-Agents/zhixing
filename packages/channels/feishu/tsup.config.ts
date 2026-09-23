import { defineConfig } from "tsup";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export default defineConfig({
    entry: { "extension/extension": "src/extension-entry.ts" }, outDir: "dist", format: ["esm"],
    outExtension: () => ({ js: ".mjs" }), dts: false, sourcemap: false, clean: true,
    target: "node24", splitting: false, noExternal: [/.*/],
    // Use ws's portable implementation; the extension has no native add-ons.
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    onSuccess: async () => {
      const declaration = JSON.parse(await readFile("extension.json", "utf8"));
      const bytes = await readFile("dist/extension/extension.mjs");
      await writeFile("dist/extension/manifest.json", JSON.stringify({ ...declaration,
        digest: createHash("sha256").update(bytes).digest("hex"),
      }, null, 2));
    },
});
