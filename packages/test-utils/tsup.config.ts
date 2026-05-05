import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  // vitest 由消费者提供（peerDependency），不打入 dist——避免 bundle 膨胀和版本冲突
  external: ["vitest"],
});
