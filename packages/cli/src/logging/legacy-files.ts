import path from "node:path";
import { createHash } from "node:crypto";
import type { CheckpointDirectoryHandle } from "@zhixing/mesh/filesystem";

const timestamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
const dump = new RegExp(`^(?:keypress|llm-raw|llm-error)-[1-9]\\d*-${timestamp}\\.log$`, "u");
const families = [
  { parts: [], accepts: (name: string) => name === "server.log", single: "server.log" },
  { parts: ["logs"], accepts: (name: string) => dump.test(name) },
  { parts: ["logs", "llm-raw"], accepts: (name: string) => name.startsWith("llm-raw-") && dump.test(name) },
  { parts: ["logs", "llm-error"], accepts: (name: string) => name.startsWith("llm-error-") && dump.test(name) },
  { parts: ["logs", "server"], accepts: (name: string) => name === "server.log" || /^server-\d{8}-\d{6}-\d{3}-\d{4,}\.log$/u.test(name) },
];

/** Fixed historical locations only. Virtual names never become caller-supplied paths. */
export class LegacyLogFiles {
  readonly #handles = new Map<string, CheckpointDirectoryHandle>();
  readonly #entries = new Map<string, { directory: CheckpointDirectoryHandle; name: string; relativePath: string }>();
  constructor(readonly home: string, readonly openPath: (root: string, create: boolean, readOnly: boolean) => Promise<CheckpointDirectoryHandle>, readonly readOnly: boolean) {}

  async list(limit: number): Promise<readonly string[]> {
    const entries = new Map<string, { directory: CheckpointDirectoryHandle; name: string; relativePath: string }>();
    for (const family of families) {
      const root = path.join(this.home, ...family.parts);
      let directory = this.#handles.get(root);
      try {
        const current = await this.openPath(root, false, this.readOnly);
        if (directory) {
          try { if (current.identity !== directory.identity) throw Error("旧日志目录位置已变化"); }
          finally { await current.close(); }
          await directory.assertIdentity();
        } else { directory = current; this.#handles.set(root, directory); }
      } catch (error) {
        if (!directory && missing(error)) continue;
        throw error;
      }
      let names: readonly string[];
      if (family.single) {
        try { await directory.statFile(family.single); names = [family.single]; }
        catch (error) { if (missing(error)) continue; throw error; }
      } else names = await directory.listEntries(limit);
      for (const name of names) {
        if (!family.accepts(name)) continue;
        // Identity is checked again by stat/read/truncate; links never become owned files.
        const key = `legacy-${createHash("sha256").update(`${family.parts.join("/")}/${name}`).digest("hex")}.log`;
        entries.set(key, { directory, name, relativePath: [...family.parts, name].join("/") });
        if (entries.size > limit) throw Error("旧日志文件数量超过清点限额");
      }
    }
    this.#entries.clear();
    for (const [key, value] of entries) this.#entries.set(key, value);
    return [...entries.keys()].sort();
  }
  resolve(name: string): { directory: CheckpointDirectoryHandle; name: string; relativePath: string } {
    const entry = this.#entries.get(name);
    if (!entry) throw Error("旧日志未在固定位置登记");
    return entry;
  }
  async sync(): Promise<void> {
    for (const directory of this.#handles.values()) await directory.sync();
  }
  async close(): Promise<void> {
    const handles = [...this.#handles.values()];
    this.#entries.clear(); this.#handles.clear();
    await Promise.allSettled(handles.map((directory) => directory.close()));
  }
}
export function isLegacyLogFile(name: string): boolean { return /^legacy-[a-f0-9]{64}\.log$/u.test(name); }
function missing(error: unknown): boolean { return error instanceof Error && error.message === "checkpoint-child-missing"; }
