import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { checkpointBridgeTarget, checkpointBridgeArtifactDirectory } from "../src/checkpoint-bridge-artifact.ts";

process.chdir(path.resolve(import.meta.dirname, ".."));
const target = checkpointBridgeTarget();
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
  const require = createRequire(import.meta.url);
  // rebuild deletes build/, including prebuilt artifacts imported from other hosts.
  for (const action of ["configure", "build"]) {
    const result = spawnSync(process.execPath, [require.resolve("node-gyp/bin/node-gyp.js"), action], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const directory = checkpointBridgeArtifactDirectory(process.cwd(), target);
mkdirSync(directory, { recursive: true });
const output = path.join(directory, target.file);
copyFileSync(path.join("build/Release", target.file), output);
const bytes = readFileSync(output);
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
writeFileSync(path.join(directory, "descriptor.json"), `${JSON.stringify({
  schemaVersion: 1,
  os: target.os,
  arch: target.arch,
  packageVersion,
  file: target.file,
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}, null, 2)}\n`, "utf8");
