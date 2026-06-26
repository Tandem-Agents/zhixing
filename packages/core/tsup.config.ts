import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/events/index.ts",
    "src/types/index.ts",
    "src/loop/index.ts",
    "src/resilience/index.ts",
    "src/context/index.ts",
    "src/session/index.ts",
    "src/memory/index.ts",
    "src/security/index.ts",
    "src/confirmation/index.ts",
    "src/identity/index.ts",
    "src/scheduler/index.ts",
    "src/orchestration/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
