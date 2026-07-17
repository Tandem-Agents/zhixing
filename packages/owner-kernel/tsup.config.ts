import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime.ts",
    "src/types.ts",
    "src/conversation-manager.ts",
    "src/run-turn.ts",
    "src/ephemeral-run-buffer.ts",
    "src/confirmation-hub.ts",
    "src/control-admission.ts",
    "src/conversation-assignment.ts",
    "src/job-assignment.ts",
    "src/delivery.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
