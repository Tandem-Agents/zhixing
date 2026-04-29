import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime/index.ts", "src/security/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
