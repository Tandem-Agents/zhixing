import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime-role.ts", "src/assignment-ledger.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
