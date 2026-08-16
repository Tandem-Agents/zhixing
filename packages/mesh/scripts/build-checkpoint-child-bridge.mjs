import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

mkdirSync("build/Release", { recursive: true });
if (process.platform === "win32") {
  if (process.arch !== "x64") {
    throw new Error("checkpoint helper 当前只发布 Windows x64 构建");
  }
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
  const bytes = readFileSync(output);
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  writeFileSync(
    path.resolve("build/Release/checkpoint_child_bridge.descriptor.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      os: "win32",
      arch: "x64",
      packageVersion,
      file: "checkpoint_child_bridge.exe",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }, null, 2)}\n`,
    "utf8",
  );
} else {
  const result = spawnSync("node-gyp", ["rebuild"], { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
