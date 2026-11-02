import { defineConfig } from "tsup";

export default defineConfig({
  // naming 单独出口：只要命名规则的展示层（终端过程行）不拉入 MCP 宿主
  entry: ["src/index.ts", "src/naming.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node24",
});
