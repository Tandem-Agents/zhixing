import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { onTestFinished } from "vitest";

/** A live product-shaped entry with no home flag: only a real peer proof can exclude it. */
export async function declaredPeer(): Promise<void> {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  const root = await createTempDir("logging-declared-peer");
  const directory = path.join(root, "packages", "cli", "dist");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  const entry = path.join(directory, "index.js");
  await writeFile(entry, `
    import { declareLogWriter } from ${JSON.stringify(new URL("../writer-admission.ts", import.meta.url).href)};
    const declaration = declareLogWriter(${JSON.stringify(path.join(root, "home"))}, () => process.exit(1));
    await declaration.ready;
    process.send("ready");
    process.on("message", async () => { await declaration.close(); process.disconnect(); });
  `);
  const child = spawn(process.execPath, ["--import=tsx/esm", entry], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  onTestFinished(async () => {
    if (child.connected) child.send("close");
    const timer = setTimeout(() => child.kill(), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error("declaration peer timed out")); }, 5000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(Error("declaration peer exited")); });
  });
}
