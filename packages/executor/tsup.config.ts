import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime-role.ts",
    "src/assignment-ledger.ts",
    "src/assignment-stream-spool.ts",
    "src/data-plane-ticket-registry.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
