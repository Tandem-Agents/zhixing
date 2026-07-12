import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/session-adapter.ts",
    "src/runtime-host.ts",
    "src/builtin-extra-tools.ts",
    "src/segment-deps.ts",
    "src/workmode-tools.ts",
    "src/workscene-port.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
});
