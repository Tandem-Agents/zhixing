import { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";
import path from "node:path";

// A dedicated process owns every native handle. It never loads product configuration,
// records arbitrary stderr, or shares the checkpoint helper with business operations.
let directory: CheckpointDirectoryHandle | undefined;
let release: (() => Promise<void>) | undefined;
let readOnly = true;
let active = false;
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
    directory = undefined;
    readOnly = requestedReadOnly;
    if (!path.isAbsolute(home)) throw Error("absolute-home-required");
    if (readOnly) {
      directory = await CheckpointDirectoryHandle.openPath(
        path.join(home, "logs", "runtime"),
        false,
        true,
      );
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
  if (!directory) throw Error("filesystem-not-open");
  if (op === "list") return directory.listEntries(args[0] as number);
  if (op === "stat") return directory.statFile(args[0] as string);
  if (op === "read")
    return directory.readFile(
      args[0] as string,
      args[1] as number,
      args[2] as number,
      args[3] as number,
    );
  if (readOnly) throw Error("filesystem-read-only");
  if (op === "write") return directory.writeFile(args[0] as string, args[1] as Uint8Array);
  if (op === "rename") return directory.renameTo(args[0] as string, directory, args[1] as string);
  if (op === "truncate")
    return directory.truncateFile(args[0] as string, args[1] as string, args[2] as number);
  if (op === "remove") {
    const name = args[0] as string,
      info = await directory.statFile(name);
    return directory.removeRetired(name, info.identity);
  }
  if (op === "sync") return directory.sync();
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
