import { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";
import path from "node:path";
import { LegacyLogFiles, isLegacyLogFile } from "./legacy-files.js";

// A dedicated process owns every native handle. It never loads product configuration,
// records arbitrary stderr, or shares the checkpoint helper with business operations.
let directory: CheckpointDirectoryHandle | undefined;
let release: (() => Promise<void>) | undefined;
let readOnly = true;
let active = false;
let legacy: LegacyLogFiles | undefined;
interface Request {
  id: number;
  op: string;
  args: unknown[];
}
process.on("message", (message: Request) => {
  if (active) {
    process.send?.({ id: message.id, error: "filesystem-busy" });
    return;
  }
  active = true;
  void dispatch(message)
    .then(
      (value) => process.send?.({ id: message.id, value }),
      (error: unknown) => {
        const code =
          error instanceof Error
            ? /NTSTATUS 0x[0-9a-f]+|Win32 \d+|checkpoint-child-missing/iu.exec(error.message)?.[0]
            : undefined;
        process.send?.({
          id: message.id,
          error: `日志文件操作 ${message.op} 未完成${code ? `（${code}）` : ""}`,
        });
      },
    )
    .finally(() => {
      active = false;
    });
});
process.on("disconnect", () => {
  process.exit(0);
});

async function dispatch({ op, args }: Request): Promise<unknown> {
  if (op === "open") {
    const [home, requestedReadOnly] = args as [string, boolean];
    if (directory && readOnly === requestedReadOnly) return;
    await release?.();
    release = undefined;
    await directory?.close();
    await legacy?.close();
    directory = undefined;
    readOnly = requestedReadOnly;
    legacy = new LegacyLogFiles(home, (root, create, ro) => CheckpointDirectoryHandle.openPath(root, create, ro), readOnly);
    if (!path.isAbsolute(home)) throw Error("absolute-home-required");
    if (readOnly) {
      try { directory = await CheckpointDirectoryHandle.openPath(
        path.join(home, "logs", "runtime"),
        false,
        true,
      ); } catch (error) { if (!(error instanceof Error) || error.message !== "checkpoint-child-missing") throw error; }
    } else {
      // The existing product home is the ownership boundary. If it does not yet
      // exist, logging retries after normal product initialization creates it.
      const root = await CheckpointDirectoryHandle.openPath(home, false);
      let logs: CheckpointDirectoryHandle | undefined;
      try {
        logs = await root.openDirectory("logs", true);
        await root.sync();
        directory = await logs.openDirectory("runtime", true);
        await logs.sync();
        await directory.sync();
      } finally {
        await logs?.close();
        await root.close();
      }
    }
    return;
  }
  if (op === "list") {
    const limit = args[0] as number, own = directory ? await directory.listEntries(limit) : [];
    if (own.some(isLegacyLogFile)) throw Error("reserved-legacy-name");
    const all = [...own, ...await legacy!.list(limit)];
    if (all.length > limit) throw Error("log-inventory-limit");
    return all;
  }
  if (!directory && !(typeof args[0] === "string" && isLegacyLogFile(args[0]))) throw Error("filesystem-not-open");
  if (typeof args[0] === "string" && isLegacyLogFile(args[0])) {
    const entry = legacy!.resolve(args[0]);
    if (op === "stat") return { ...await entry.directory.statFile(entry.name), legacyPath: entry.relativePath };
    if (op === "read") return entry.directory.readFile(entry.name, args[1] as number, args[2] as number, args[3] as number, args[4] as string | undefined);
    if (readOnly) throw Error("filesystem-read-only");
    if (op === "truncate" && args[2] === 0) return entry.directory.truncateFile(entry.name, args[1] as string, 0);
    if (op === "remove") {
      if (typeof args[1] !== "string") throw Error("legacy-identity-required");
      await entry.directory.removeRetired(entry.name, args[1]); await entry.directory.sync(); return;
    }
    throw Error("legacy-read-only");
  }
  if (!directory) throw Error("filesystem-not-open");
  if (op === "stat") return directory.statFile(args[0] as string);
  if (op === "read")
    return directory.readFile(
      args[0] as string,
      args[1] as number,
      args[2] as number,
      args[3] as number,
      args[4] as string | undefined,
    );
  if (readOnly) throw Error("filesystem-read-only");
  if (op === "write") return directory.writeFile(args[0] as string, args[1] as Uint8Array);
  if (op === "rename") {
    if (isLegacyLogFile(args[1] as string)) throw Error("reserved-legacy-name");
    return directory.renameTo(args[0] as string, directory, args[1] as string);
  }
  if (op === "truncate")
    return directory.truncateFile(args[0] as string, args[1] as string, args[2] as number);
  if (op === "remove") {
    const name = args[0] as string,
      info = await directory.statFile(name);
    return directory.removeRetired(name, args[1] as string | undefined ?? info.identity);
  }
  if (op === "sync") { await directory.sync(); await legacy?.sync(); return; }
  if (op === "tryLock") {
    if (release) throw Error("nested-lock");
    release = await directory.tryLock("writer.lock");
    return release !== undefined;
  }
  if (op === "unlock") {
    await release?.();
    release = undefined;
    return;
  }
  throw Error("unknown-filesystem-operation");
}
