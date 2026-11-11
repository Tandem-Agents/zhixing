import { defineConfig } from "tsup";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export default defineConfig({
    entry: { "extension/extension": "src/extension-entry.ts" }, outDir: "dist", format: ["esm"],
    outExtension: () => ({ js: ".mjs" }), dts: false, sourcemap: false, clean: true,
    target: "node24", splitting: false, noExternal: [/.*/],
    // Use ws's portable implementation; the extension has no native add-ons.
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    // debug 在 try/catch 中可选加载 supports-color；干净安装里没有它时，esbuild 会保留外部 require，
    // 违反“只依赖 Node 内置模块”的独立制品合同。改用等同于“未安装”的空实现，运行行为不变。
    esbuildOptions(options) {
      options.alias = { ...options.alias, "supports-color": resolve("src/vendor/no-supports-color.cjs") };
    },
    onSuccess: async () => {
      const declaration = JSON.parse(await readFile("extension.json", "utf8"));
      const bytes = await readFile("dist/extension/extension.mjs");
      await writeFile("dist/extension/manifest.json", JSON.stringify({ ...declaration,
        digest: createHash("sha256").update(bytes).digest("hex"),
      }, null, 2));
    },
});
