import { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";
import path from "node:path";
import { logFailureEvidence, logStorageFailure } from "@zhixing/core/logging";
import { LegacyLogFiles, isLegacyLogFile, statLogFiles } from "./legacy-files.js";
import { consumeLogWorkerStdio } from './terminal-worker.js';

const parent = consumeLogWorkerStdio();
const send = (message: unknown): void => { if (parent) parent.send(message, () => {}); else process.send?.(message); };

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
(parent ?? process).on("message", (message: Request) => {
  if (active) {
    send({ id: message.id, error: "filesystem-busy" });
    return;
  }
  active = true;
  void dispatch(message)
    .then(
      (value) => send({ id: message.id, value }),
      (error: unknown) => {
        send({
          id: message.id,
          error: "日志文件操作未完成",
          code: logStorageFailure(error),
          evidence: logFailureEvidence(error),
        });
      },
    )
    .finally(() => {
      active = false;
    });
});
(parent ?? process).on("disconnect", () => {
  process.exit(0);
});
parent?.on('error', () => process.exit(1));

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
  if (op === "statMany") return statLogFiles(directory, legacy!, args[0] as string[]);
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
      args[5] as boolean | undefined,
    );
  if (op === "tryReadLock") {
    if (release) throw Error("nested-lock");
    release = await directory.waitLock("writer.lock", 2000, "shared");
    return release !== undefined;
  }
  if (op === "unlock") {
    await release?.();
    release = undefined;
    return;
  }
  if (readOnly) throw Error("filesystem-read-only");
  if (op === "append") {
    const [name, identity, offset, bytes] = args as [string, string, number, Uint8Array];
    if (!/^segment-[a-f0-9-]{36}\.jsonl$/u.test(name)) throw Error("segment-append-required");
    await directory.writeRange(name, offset + bytes.length, offset, bytes, identity);
    return;
  }
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
    release = await directory.waitLock("writer.lock", 2000);
    return release !== undefined;
  }
  throw Error("unknown-filesystem-operation");
}
