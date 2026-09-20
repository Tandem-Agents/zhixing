import { createHash } from "node:crypto";
import { readFile, link, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltin } from "node:module";
import { randomUUID } from "node:crypto";
import { ensureDurableDirectory, syncDirectory } from "../persistence/index.js";
import { validateExtensionManifest, type ExtensionCandidate } from "./contracts.js";

/** Inert validation. Executing code is a separate, confirmed management effect. */
export function validateExtensionCandidate(value: unknown): ExtensionCandidate {
  if (!value || typeof value !== "object") throw new TypeError("需要候选包");
  const candidate = value as ExtensionCandidate;
  const manifest = validateExtensionManifest(candidate.manifest);
  if (typeof candidate.code !== "string" || Buffer.byteLength(candidate.code) > 16 * 1024 * 1024 ||
      createHash("sha256").update(candidate.code).digest("hex") !== manifest.digest) throw new TypeError("制品摘要不匹配或体积超限");
  const source = candidate.provenance;
  if (!source || !["existing", "authored"].includes(source.kind) || typeof source.revision !== "string" || !source.revision.trim() || source.revision.length > 512) throw new TypeError("需要固定来源版本");
  const url = new URL(source.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new TypeError("来源必须是无凭据的 HTTPS 文档或仓库地址");
  if (!candidate.sources || typeof candidate.sources !== "object" || Array.isArray(candidate.sources) ||
      !Object.keys(candidate.sources).length || Object.keys(candidate.sources).length > 200 ||
      typeof candidate.build !== "string" || !candidate.build.trim() || candidate.build.length > 16000 ||
      Buffer.byteLength(JSON.stringify(candidate)) > 24 * 1024 * 1024) throw new TypeError("需要保留源码和固定版本的构建说明");
  for (const [name, text] of Object.entries(candidate.sources)) {
    if (!/^[a-zA-Z0-9_.\/-]+$/.test(name) || name.startsWith("/") || name.split("/").some(part => !part || part === "..") ||
        /(^|\/)(\.env(?:\.|$)|credentials\.json$|node_modules(?:\/|$))/i.test(name) || typeof text !== "string") throw new TypeError("源码包包含无效或禁止的文件");
  }
  const pkg = candidate.sources["package.json"];
  if (pkg) {
    const packageJson = JSON.parse(pkg);
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (Object.values(dependencies).some(v => typeof v !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v)) ||
        (Object.keys(dependencies).length && !["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some(name => candidate.sources[name]))) throw new TypeError("依赖须使用准确版本并保留锁文件");
  }
  // Obvious unresolved module imports are rejected before trial; the protocol
  // handshake remains the runtime check. This is not a JavaScript sandbox.
  for (const match of candidate.code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) {
    if (!isBuiltin(match[1]!)) throw new TypeError("入口须为仅依赖 Node 内置模块的独立打包制品");
  }
  return structuredClone({ ...candidate, manifest });
}

/** Immutable archive: exact code, source, provenance and build recipe survive restart. */
export class ExtensionCandidates {
  constructor(private readonly root: string) {}
  async save(input: ExtensionCandidate): Promise<void> {
    const candidate = validateExtensionCandidate(input);
    const directory = join(this.root, candidate.manifest.digest);
    await ensureDurableDirectory(directory);
    const path = join(directory, "candidate.json");
    const encoded = JSON.stringify(candidate);
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    if (existing !== undefined) {
      if (existing !== encoded) throw new Error("同一制品的来源或源码记录冲突");
      return;
    }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await readFile(path, "utf8") !== encoded) throw new Error("同一制品的来源或源码记录冲突");
      }
      await syncDirectory(directory);
    } finally { await rm(temporary, { force: true }); }
  }
  async read(digest: string): Promise<ExtensionCandidate> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("Invalid candidate digest");
    return validateExtensionCandidate(JSON.parse(await readFile(join(this.root, digest, "candidate.json"), "utf8")));
  }
}
