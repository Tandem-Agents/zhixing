import { opendir, readlink, stat, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readDarwinProcessBirth, readLocalProcessDeclaration } from "@zhixing/mesh/filesystem";
import { LOG_WRITE_PROTOCOL, writerEndpoint, writerRootKey } from "./writer-admission.js";
import type { LogWriterIdentity, LogWriterObservation } from "@zhixing/core/logging/storage";
import { logFailureEvidence, type LogFailureEvidence } from "@zhixing/core/logging";
const parentPid = Number(process.argv[3]);
import { isProductLogWriter as productWriter } from "./writer-classification.js";
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
  let failure: LogFailureEvidence | undefined;
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
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") {
        complete = false;
        failure ??= logFailureEvidence(error);
      }
    }
  }
  return { complete: complete && self !== undefined, self, candidates, ...(failure ? { failure } : {}) };
}
async function posix(home: string): Promise<Omit<LogWriterObservation, "at">> {
  const text = execFileSync("ps", ["-axo", "pid=,lstart=,comm=,args="], { timeout: 1500, maxBuffer: 256 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const candidates: LogWriterIdentity[] = [];
  let self: LogWriterIdentity | undefined, complete = true;
  let failure: LogFailureEvidence | undefined;
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) { if (line.trim()) complete = false; continue; }
    if (!/^node(?:js)?$/u.test(path.basename(match[3]!))) continue;
    if (candidates.length >= 256) { complete = false; break; }
    const pid = Number(match[1]);
    let birth: string;
    try { birth = readDarwinProcessBirth(pid); } catch (error) { complete = false; failure ??= logFailureEvidence(error); continue; }
    const identity = { pid, birth };
    if (identity.pid === parentPid) { self = identity; candidates.push(identity); continue; }
    // ps loses argv quoting. Ambiguous product commands block rather than claim compatibility.
    if (productWriter(match[4]!.split(/\s+/u), home) || /@zhixing\/cli|packages\/cli/u.test(match[4]!)) candidates.push(identity);
  }
  return { complete: complete && self !== undefined, self, candidates, ...(failure ? { failure } : {}) };
}

try {
  const home = process.argv[2]!;
  const result = await (process.platform === "linux" ? linux(home) : posix(home));
  const compatible: LogWriterIdentity[] = [];
  const elsewhere = new Set<number>();
  if (process.platform === "linux") for (const candidate of result.candidates.filter(item => item.pid !== parentPid).slice(0, 8)) {
    try {
      const value = JSON.parse(readLocalProcessDeclaration(writerEndpoint(candidate.pid), candidate.pid));
      const text = (await prefix(`/proc/${candidate.pid}/stat`, 4096)).toString();
      const start = text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
      if (candidate.birth.slice(candidate.birth.lastIndexOf(":") + 1) !== start) continue;
      if (value.protocol === LOG_WRITE_PROTOCOL && value.pid === candidate.pid && /^[a-f0-9]{64}$/u.test(value.root)) {
        if (value.root === writerRootKey(home)) compatible.push(candidate); else elsewhere.add(candidate.pid);
      }
    } catch { /* No peer proof means conservative registration. */ }
  }
  process.stdout.write(JSON.stringify({ ...result, candidates: result.candidates.filter(item => !elsewhere.has(item.pid)), compatible }));
} catch (error) { process.stdout.write(JSON.stringify({ complete: false, candidates: [], failure: logFailureEvidence(error) })); }
