import { opendir, readlink, stat, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readDarwinProcessBirth } from "@zhixing/mesh/filesystem";
import type { LogWriterIdentity, LogWriterObservation } from "@zhixing/core/logging/storage";
const parentPid = Number(process.argv[3]);
function productEntry(value: string): boolean {
  return /(?:^|\/)(?:packages\/cli\/(?:src\/index\.ts|dist\/index\.js)|node_modules\/@zhixing\/cli\/dist\/index\.js)$/u.test(value) || /^(?:[.]\/)?(?:src\/index\.ts|dist\/index\.js)$/u.test(value);
}
function productWriter(argv: readonly string[], home: string): boolean {
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const flag = argv[index]!;
    if (flag === "--") { index++; break; }
    if (["-e", "--eval", "-p", "--print"].includes(flag)) return false;
    if (["--import", "--require", "-r", "--loader", "--conditions", "--title"].includes(flag)) index += 2;
    else if (flag.includes("=") || ["--no-warnings", "--enable-source-maps", "--trace-warnings"].includes(flag)) index++;
    // Unknown arity: conservatively include any product entry, without guessed tail exclusions.
    else return argv.slice(index + 1).some(productEntry);
  }
  if (!productEntry(argv[index] ?? "")) return false;
  const args = argv.slice(index + 1);
  if (args[0] === "logs" && !args.includes("policy")) return false;
  const managed = args.indexOf("--managed-home");
  if (managed >= 0 && path.isAbsolute(args[managed + 1] ?? "") && path.resolve(args[managed + 1]!) !== path.resolve(home)) return false;
  return true;
}
async function prefix(file: string, max = 65536): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(max + 1), { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    if (bytesRead > max) throw Error("process-observation-oversized");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function linux(home: string): Promise<Omit<LogWriterObservation, "at">> {
  const boot = (await prefix("/proc/sys/kernel/random/boot_id", 256)).toString().trim();
  const candidates: LogWriterIdentity[] = [];
  let self: LogWriterIdentity | undefined, complete = true, inspected = 0;
  const deadline = performance.now() + 1500;
  const directory = await opendir("/proc", { bufferSize: 64 });
  let entries = 0;
  for await (const entry of directory) {
    if (++entries > 32768) { complete = false; break; }
    const name = entry.name;
    if (!/^\d+$/u.test(name)) continue;
    if (performance.now() > deadline) { complete = false; break; }
    try {
      const root = `/proc/${name}`;
      if ((await stat(root)).uid !== process.getuid?.()) continue;
      const executable = path.basename(await readlink(`${root}/exe`));
      if (!/^node(?:js)?$/u.test(executable)) continue;
      if (++inspected > 256) { complete = false; break; }
      const text = (await prefix(`${root}/stat`, 4096)).toString(), start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
      if (!start || !/^\d+$/u.test(start)) throw Error("unknown-process-birth");
      const identity = { pid: Number(name), birth: `${boot}:${start}` };
      if (identity.pid === parentPid) { self = identity; candidates.push(identity); continue; }
      const argv = (await prefix(`${root}/cmdline`)).toString().split("\0");
      if (productWriter(argv, home)) candidates.push(identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") complete = false;
    }
  }
  return { complete: complete && self !== undefined, self, candidates };
}
async function posix(home: string): Promise<Omit<LogWriterObservation, "at">> {
  const text = execFileSync("ps", ["-axo", "pid=,lstart=,comm=,args="], { timeout: 1500, maxBuffer: 256 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const candidates: LogWriterIdentity[] = [];
  let self: LogWriterIdentity | undefined, complete = true;
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) { if (line.trim()) complete = false; continue; }
    if (!/^node(?:js)?$/u.test(path.basename(match[3]!))) continue;
    if (candidates.length >= 256) { complete = false; break; }
    const pid = Number(match[1]);
    let birth: string;
    try { birth = readDarwinProcessBirth(pid); } catch { complete = false; continue; }
    const identity = { pid, birth };
    if (identity.pid === parentPid) { self = identity; candidates.push(identity); continue; }
    // ps loses argv quoting. Ambiguous product commands block rather than claim compatibility.
    if (productWriter(match[4]!.split(/\s+/u), home) || /@zhixing\/cli|packages\/cli/u.test(match[4]!)) candidates.push(identity);
  }
  return { complete: complete && self !== undefined, self, candidates };
}

try { process.stdout.write(JSON.stringify(await (process.platform === "linux" ? linux(process.argv[2]!) : posix(process.argv[2]!)))); } catch { process.stdout.write(JSON.stringify({ complete: false, candidates: [] })); }
