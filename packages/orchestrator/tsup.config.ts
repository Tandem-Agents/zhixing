import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime/index.ts",
    "src/security/index.ts",
    "src/profile/index.ts",
    "src/subagent/index.ts",
    "src/confirmation/index.ts",
    "src/tools/index.ts",
    "src/workflow/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
