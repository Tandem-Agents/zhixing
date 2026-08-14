import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "program-installer": "src/update/program-installer-entry.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
});
