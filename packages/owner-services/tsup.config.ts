import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/advancement/index.ts",
    "src/advancement/controller.ts",
    "src/advancement/proxy-content.ts",
    "src/advancement/proxy-scheduler.ts",
    "src/advancement/recovery-maintenance.ts",
    "src/advancement/review-dispatch.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
