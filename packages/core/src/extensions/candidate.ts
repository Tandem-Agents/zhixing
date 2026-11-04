import { createHash } from "node:crypto";
import { readFile, link, rm, open } from "node:fs/promises";
import { join } from "node:path";
import { isBuiltin } from "node:module";
import { randomUUID } from "node:crypto";
import { parse, type AnyNode } from "acorn";
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
  validateBundledModule(candidate.code);
  return structuredClone({ ...candidate, manifest });
}

/** Inspect syntax, never comments/strings or executed code. This is not a sandbox. */
function validateBundledModule(code: string): void {
  const visit = (node: AnyNode): void => {
    const source = node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration" || node.type === "ImportExpression" ? node.source
      : node.type === "CallExpression" && node.callee.type === "Identifier" &&
        ["require", "__require"].includes(node.callee.name) ? node.arguments[0] : undefined;
    if (source?.type === "Literal" && typeof source.value === "string" && !isBuiltin(source.value)) {
      throw new TypeError("入口须为仅依赖 Node 内置模块的独立打包制品");
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") visit(child);
      } else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(parse(code, { ecmaVersion: "latest", sourceType: "module" }));
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
    const candidate = validateExtensionCandidate(JSON.parse(await readFile(join(this.root, digest, "candidate.json"), "utf8")));
    // 归档目录即身份：放错目录的另一份合法候选不能冒充所请求的这一份
    if (candidate.manifest.digest !== digest) throw new TypeError("候选包与所请求的制品摘要不一致");
    return candidate;
  }

  /**
   * 已有归档是否恰好是这份预期候选（例如随包分发种子派生的候选）保存后的字节。只做清单校验与编码比较，
   * 不解析源码：逐字节相同即说明归档就是 save 完整校验后写下的这份内容。预期本身来自可信的分发材料，
   * 不依赖归档旁的任何可被一并替换的记录。不同、缺失或预期无效时返回 false，调用方改走完整的 read。
   */
  async holdsExactly(expected: ExtensionCandidate): Promise<boolean> {
    let encoded: string;
    try {
      const manifest = validateExtensionManifest(expected.manifest);
      // 预期本身也要成立：代码必须就是清单摘要所指的那份，否则不能凭字节相同放行
      if (typeof expected.code !== "string" || createHash("sha256").update(expected.code).digest("hex") !== manifest.digest) return false;
      encoded = JSON.stringify(structuredClone({ ...expected, manifest }));
    } catch { return false; }
    const existing = await readFile(join(this.root, expected.manifest.digest, "candidate.json"), "utf8").catch(() => undefined);
    return existing === encoded;
  }
}
