import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/credential-command-worker.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
});
