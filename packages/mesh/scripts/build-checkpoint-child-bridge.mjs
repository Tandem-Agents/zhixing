import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

mkdirSync("build/Release", { recursive: true });
if (process.platform === "win32") {
  const framework = process.env.WINDIR ?? "C:\\Windows";
  const compiler = path.join(framework, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const source = path.resolve("native/checkpoint_child_bridge.cs");
  const output = path.resolve("build/Release/checkpoint_child_bridge.exe");
  const result = spawnSync(compiler, [
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/reference:System.Web.Extensions.dll",
    `/out:${output}`,
    source,
  ], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  const result = spawnSync("node-gyp", ["rebuild"], { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
