import { copyFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/configuration.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
  banner: {
    js: 'import { createRequire as __zhixingProvidersCreateRequire } from "node:module"; const require = __zhixingProvidersCreateRequire(import.meta.url);',
  },
  onSuccess: async () => {
    copyFileSync(
      path.resolve("src/catalog/tuf/vendor/THIRD-PARTY-NOTICES.txt"),
      path.resolve("dist/THIRD-PARTY-NOTICES.txt"),
    );
  },
});
