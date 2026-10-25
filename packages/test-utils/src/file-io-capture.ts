/**
 * 测试用的真实文件读写计量：拦截 FileHandle 的读写方法与 fs/promises 的整文件读写，
 * 按相对 root 的路径归类累计字节与次数。用于规模用例比较不同历史规模下的完整读量与保存量；
 * 嵌套调用（例如 FileHandle.writeFile 内部的 write）只计一次。测试结束时自动还原。
 */
import fs, { open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { onTestFinished, vi } from "vitest";

export interface FileIoTotals {
  readBytes: number;
  reads: number;
  writeBytes: number;
  writes: number;
}

export interface FileIoSnapshot extends FileIoTotals {
  /** 段偏移文件按 8 字节一项计的条目探测数 */
  segmentEntryProbes: number;
  readonly byCategory: Readonly<Record<string, FileIoTotals>>;
}

export interface FileIoCapture {
  /** 自创建或上次 reset 以来的累计。 */
  snapshot(): FileIoSnapshot;
  reset(): void;
}

/** 默认归类：权威日志、检查点、持久投影（含段偏移）、帧索引、其他。 */
export function defaultFileIoCategory(relative: string): string {
  if (relative.endsWith("/authority.log") || relative === "authority.log") return "log";
  if (relative.includes("/checkpoints/") || relative.startsWith("checkpoints/")) return "checkpoint";
  if (relative.includes("/projections/") || relative.startsWith("projections/")) return "projection";
  if (relative.includes("frame-index")) return "frame-index";
  return "other";
}

export async function captureFileIo(
  root: string,
  categorize: (relative: string) => string = defaultFileIoCategory,
): Promise<FileIoCapture> {
  const probe = await open(path.join(root, "file-io-probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await probe.close();
  const relative = (file: unknown) => path.relative(root, String(file instanceof URL ? file.pathname : file)).replaceAll("\\", "/");
  const paths = new WeakMap<object, string>();
  let totals = empty();

  const account = (file: string, kind: "read" | "write", bytes: number) => {
    if (!(bytes > 0)) return;
    const category = categorize(file);
    const bucket = (totals.byCategory as Record<string, FileIoTotals>)[category] ??= { readBytes: 0, reads: 0, writeBytes: 0, writes: 0 };
    if (kind === "read") {
      totals.readBytes += bytes; totals.reads++; bucket.readBytes += bytes; bucket.reads++;
      if (file.endsWith(".offsets")) totals.segmentEntryProbes += bytes / 8;
    } else {
      totals.writeBytes += bytes; totals.writes++; bucket.writeBytes += bytes; bucket.writes++;
    }
  };

  const openFile = fs.open;
  const opened = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await openFile(...args);
    paths.set(handle, relative(args[0]));
    return handle;
  });
  const readFile = fs.readFile, writeFile = fs.writeFile, appendFile = fs.appendFile;
  const wholeReads = vi.spyOn(fs, "readFile").mockImplementation((async (file: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    const result = await (readFile as (...args: unknown[]) => Promise<string | Buffer>)(file, ...rest);
    if (typeof file === "string" || file instanceof URL) account(relative(file), "read", typeof result === "string" ? Buffer.byteLength(result) : result.length);
    return result;
  }) as typeof fs.readFile);
  const wholeWrites = [
    vi.spyOn(fs, "writeFile").mockImplementation((async (file: Parameters<typeof fs.writeFile>[0], data: unknown, ...rest: unknown[]) => {
      await (writeFile as (...args: unknown[]) => Promise<void>)(file, data, ...rest);
      if (typeof file === "string" || file instanceof URL) account(relative(file), "write", byteLength(data));
    }) as typeof fs.writeFile),
    vi.spyOn(fs, "appendFile").mockImplementation((async (file: Parameters<typeof fs.appendFile>[0], data: unknown, ...rest: unknown[]) => {
      await (appendFile as (...args: unknown[]) => Promise<void>)(file, data, ...rest);
      if (typeof file === "string" || file instanceof URL) account(relative(file), "write", byteLength(data));
    }) as typeof fs.appendFile),
  ];
  syncBuiltinESMExports();

  const depth = new WeakMap<object, number>();
  const handleSpies = ["read", "readv", "readFile", "write", "writev", "writeFile", "appendFile"].flatMap(method => {
    const original = prototype[method];
    if (typeof original !== "function") return [];
    return [vi.spyOn(prototype, method).mockImplementation(async function (this: object, ...args: unknown[]) {
      const nested = depth.get(this) ?? 0;
      depth.set(this, nested + 1);
      try {
        const result = await original.apply(this, args) as { bytesRead?: number; bytesWritten?: number } | string | Buffer | undefined;
        if (!nested) {
          const file = paths.get(this) ?? "<unmapped>";
          if (method.startsWith("read")) account(file, "read", typeof result === "object" && result !== null && "bytesRead" in result ? result.bytesRead ?? 0 : byteLength(result));
          else account(file, "write", typeof result === "object" && result !== null && "bytesWritten" in result ? result.bytesWritten ?? 0 : byteLength(args[0]));
        }
        return result;
      } finally {
        depth.set(this, nested);
      }
    })];
  });
  onTestFinished(() => {
    for (const spy of [...handleSpies, ...wholeWrites, wholeReads, opened]) spy.mockRestore();
    syncBuiltinESMExports();
  });
  return {
    snapshot: () => structuredClone(totals),
    reset: () => { totals = empty(); },
  };
}

function empty(): FileIoSnapshot & { byCategory: Record<string, FileIoTotals> } {
  return { readBytes: 0, reads: 0, writeBytes: 0, writes: 0, segmentEntryProbes: 0, byCategory: {} };
}

function byteLength(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + byteLength(item), 0);
  return 0;
}
