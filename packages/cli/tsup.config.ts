import { defineConfig } from "tsup";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { bundleProgram, type ProgramBundleDynamicSite } from "./src/build/program-bundle.ts";
import { deriveTerminalChunkTable, TERMINAL_CHUNK_TABLE_MIN_BYTES } from "./src/terminal/chunk-table.ts";

/**
 * 终端制品拷入后：每个平台目录按原清单逐个核对大制品的大小与整文件摘要（不符即构建失败，绝不改写原摘要），
 * 再由这份核对一致的文件派生块表，写入 dist 清单的 chunkTables。terminal-ui 自己的清单与工具链不变。
 */
async function deriveTerminalChunkTables(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = join(root, entry.name, "manifest.json");
    if (!entry.isDirectory() || !await readFile(file).then(() => true, () => false)) continue;
    const manifest = JSON.parse(await readFile(file, "utf8")) as { artifacts?: { name: string; bytes: number; sha256: string }[]; chunkTables?: unknown };
    if (!Array.isArray(manifest.artifacts)) throw new Error(`Terminal manifest ${entry.name} has no artifacts`);
    if (manifest.chunkTables !== undefined) throw new Error(`Terminal manifest ${entry.name} already carries chunk tables`);
    const tables = [];
    for (const artifact of manifest.artifacts) {
      if (artifact.bytes <= TERMINAL_CHUNK_TABLE_MIN_BYTES) continue;
      tables.push(deriveTerminalChunkTable(artifact, await readFile(join(root, entry.name, artifact.name))));
    }
    if (tables.length) await writeFile(file, `${JSON.stringify({ ...manifest, chunkTables: tables }, null, 2)}\n`);
  }
}

async function buildExtensionKit() {
  const kit = "dist/extension-kit";
  await mkdir(kit, { recursive: true });
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("tsup"))("esbuild");
  for (const [entry, output] of [["../core/src/channels/extension-worker.ts", "channel-sdk.mjs"],
    ["src/runtime/extensions/validate-candidate-entry.ts", "validate.mjs"]]) {
    await build({ entryPoints: [entry], outfile: `${kit}/${output}`, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  }
  await cp("../../docs/modules/extensions/authoring.md", `${kit}/authoring.md`);
  await cp("src/runtime/extensions/manifest.schema.json", `${kit}/manifest.schema.json`);
  // Copy the declaration closure from the actual built contract, not a second
  // handwritten SDK contract. Relative type imports remain resolvable offline.
  const root = resolve("../core/dist");
  const copied = new Set<string>();
  const copyType = async (file: string): Promise<void> => {
    if (copied.has(file)) return;
    if (relative(root, file).startsWith("..")) throw new Error("Contract declaration escaped core distribution");
    copied.add(file);
    const text = await readFile(file, "utf8");
    const destination = join(kit, "contracts", relative(root, file));
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, text);
    for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      await copyType(resolve(dirname(file), match[1]!.replace(/\.js$/, ".d.ts")));
    }
  };
  await copyType(join(root, "channels/extension-worker.d.ts"));
  await writeFile(`${kit}/channel-sdk.d.ts`, 'export { serveChannelExtension } from "./contracts/channels/extension-worker.js";\n');
}

async function bundleSupervisorEntry() {
  // S runs before the first frame. Keep its small process-local graph in one
  // module instead of reopening dozens of shared chunks on every launch.
  // Bundle the emitted entry so tsup's dynamic route and chained source maps
  // remain authoritative; worker URLs stay beside the same CLI entry.
  const index = await readFile('dist/index.js', 'utf8');
  const entry = index.match(/import\("(\.\/launch-[A-Z0-9]+\.js)"\)/u)?.[1];
  if (!entry) throw Error('Terminal supervisor distribution entry missing');
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('tsup'))('esbuild');
  await build({ entryPoints: [join('dist', entry)], outfile: join('dist', entry),
    bundle: true, allowOverwrite: true, platform: 'node', format: 'esm', target: 'node24',
    // Mesh owns its native filesystem assets relative to its own package.
    external: ['@zhixing/mesh/*'], sourcemap: true, logLevel: 'silent' });
}

/** 单份启动图里允许出现的非字面量动态装入位置（逐条评审；变化即构建失败）。都是装原生件，不装 JS。 */
const PROGRAM_DYNAMIC_SITES: readonly ProgramBundleDynamicSite[] = [
  { package: "@zhixing/cli", call: "createRequire(<module-url>)(artifact)", count: 4,
    reason: "host-launch、foreground-process、writer-declaration 装分发目录 terminal/<平台>/ 下按清单核验过的原生件（S 的 launch 块里另有同源副本，宿主与 N 不会装入该块）" },
  { package: "@zhixing/cli", call: "createRequire(<module-url>)(filename)", count: 2,
    reason: "secret-platform 装 foreground.node：先按清单核对字节数与 sha256 再装入（含 S 的 launch 块副本）" },
  { package: "@zhixing/mesh", call: "createRequire(<module-url>)(verifyCheckpointBridgeArtifact( fileURLToPath(new URL(\"../\", <module-url>)), target ))", count: 1,
    reason: "mesh 装检查点桥接原生件：路径由 mesh 包根解析，装入前经 verifyCheckpointBridgeArtifact 核验" },
];
/** ws 的可选原生加速依赖：运行时 require 失败即退回纯 JS，与逐文件形态一致。 */
const PROGRAM_OPTIONAL_EXTERNALS = ["bufferutil", "utf-8-validate"];

async function bundleProgramEntry() {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("tsup"))("esbuild");
  await bundleProgram({ cliRoot: resolve("."), build, dynamicSites: PROGRAM_DYNAMIC_SITES, optionalExternals: PROGRAM_OPTIONAL_EXTERNALS });
}

export default defineConfig({
  entry: { index: "src/entry.ts", metadata: "src/index.ts", "logging-admission-worker": "src/logging/writer-admission-worker.ts", "logging-files-worker": "src/logging/logging-files-worker.ts", "logging-writers-worker": "src/logging/logging-writers-worker.ts", "logging-store-worker": "src/logging/store-worker.ts", "mcp-probe-worker": "src/runtime/mcp-probe-worker.ts" },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node24",
  noExternal: ["@zhixing/terminal-ui"],
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    await bundleSupervisorEntry();
    await bundleProgramEntry();
    await buildExtensionKit();
    // The independent UI/native closure survives tsup's clean build.
    await cp("../terminal-ui/dist", "dist/terminal", { recursive: true });
    await deriveTerminalChunkTables("dist/terminal");
    // Independently built migration artifacts, never imported by the CLI process.
    await mkdir("dist/extensions", { recursive: true });
    for (const directory of await readdir("../channels", { withFileTypes: true })) {
      if (directory.isDirectory()) {
        await cp(`../channels/${directory.name}/dist/extension`, `dist/extensions/${directory.name}`, { recursive: true });
      }
    }
  },
});
