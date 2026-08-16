import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
});
