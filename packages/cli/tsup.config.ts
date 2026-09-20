import { defineConfig } from "tsup";
import { cp, mkdir, readdir } from "node:fs/promises";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node24",
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    // Independently built migration artifacts, never imported by the CLI process.
    await mkdir("dist/extensions", { recursive: true });
    for (const directory of await readdir("../channels", { withFileTypes: true })) {
      if (directory.isDirectory()) {
        await cp(`../channels/${directory.name}/dist/extension`, `dist/extensions/${directory.name}`, { recursive: true });
      }
    }
  },
});
