import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, copyFile, stat, lstat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import './build-shared.mjs';

const root = path.resolve(import.meta.dirname, '..');
const inputBytes = await readFile(path.join(root, 'native/build-inputs.json'));
const inputs = JSON.parse(inputBytes);
const targetId = `${process.platform}-${process.arch}`;
const dist = path.join(root, 'dist', targetId);
const target = inputs.targets[targetId];
if (!target) throw Error('Unsupported terminal build host; build each of the five release targets on its matching host.');
// CI supplies archives, not a mutable pre-extracted toolchain or a claimed
// version receipt. Verification and fresh extraction happen before execution.
// Omitting this opt-in preserves the existing developer environment/cache API.
const archiveDirectory = process.env.ZHIXING_TERMINAL_INPUT_ARCHIVES ? path.resolve(process.env.ZHIXING_TERMINAL_INPUT_ARCHIVES) : undefined;
await mkdir(path.join(root, 'build'), { recursive: true });
const build = archiveDirectory ? await mkdtemp(path.join(root, 'build/release-')) : path.join(root, 'build');
let bun = toolCommand(process.env.ZHIXING_BUN_BINARY ?? 'bun');
let zig = toolCommand(process.env.ZHIXING_ZIG_BINARY ?? 'zig');
let recoveryZig = toolCommand(process.env.ZHIXING_RECOVERY_ZIG_BINARY ?? zig);
let sourceInput = process.env.ZHIXING_OPENTUI_SOURCE;
let depsInput = process.env.ZHIXING_OPENTUI_ZIG_DEPS;
let nodeInput = process.env.ZHIXING_NODE_API_SOURCE;
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, cwd, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, windowsHide: true, env: {
    ...process.env,
    ZIG_GLOBAL_CACHE_DIR: path.join(build, 'zig-global'),
    ZIG_LOCAL_CACHE_DIR: path.join(build, 'zig-local'),
  }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  let output = '';
  if (capture) { child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk); }
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(output.trim()) : reject(Error(`${path.basename(command)} exited ${code}: ${output.slice(-2000)}`)));
});
await mkdir(dist, { recursive: true });
await mkdir(build, { recursive: true });
if (archiveDirectory) {
  if (process.version !== `v${inputs.versions.node}`) throw Error('Release terminal builds require exact Node 24.0.0.');
  const archives = [target.bun, target.compiler, ...(target.recoveryCompiler ? [target.recoveryCompiler] : []), inputs.opentui, inputs.node.headers,
    ...(process.platform === 'win32' ? [inputs.node.windowsLibrary] : [])];
  for (const item of archives) await verifyInput(path.join(archiveDirectory, item.file), item);
  bun = path.join(await extractInput(target.bun), `bun${target.suffix}`);
  zig = path.join(await extractInput(target.compiler), `zig${target.suffix}`);
  if (target.recoveryCompiler) recoveryZig = path.join(await extractInput(target.recoveryCompiler), `zig${target.suffix}`);
  sourceInput = path.join(await extractInput(inputs.opentui), inputs.opentui.nativePath);
  const dependencyArchive = path.join(sourceInput, inputs.opentui.dependencies.file);
  await verifyInput(dependencyArchive, inputs.opentui.dependencies);
  depsInput = path.join(sourceInput, 'zig-deps');
  await mkdir(depsInput);
  await run(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar', ['-xzf', dependencyArchive, '-C', depsInput], root);
  nodeInput = await extractInput(inputs.node.headers);
  if (process.platform === 'win32') {
    await mkdir(path.join(nodeInput, 'x64'));
    await copyFile(path.join(archiveDirectory, inputs.node.windowsLibrary.file), path.join(nodeInput, 'x64/node.lib'));
  }
}
if (await run(bun, ['--version'], root, true) !== inputs.versions.bun) throw Error('UI builds require Bun 1.4.2; set ZHIXING_BUN_BINARY to the fixed developer toolchain.');
if (await run(zig, ['version'], root, true) !== inputs.versions.zig) throw Error('OpenTUI native builds require Zig 0.16.0; set ZHIXING_ZIG_BINARY.');
const recoveryVersion = process.platform === 'darwin' ? null : await run(recoveryZig, ['version'], root, true);
if (process.platform !== 'darwin' && !(archiveDirectory ? [inputs.versions.recoveryZig] : ['0.14.1', '0.16.0']).includes(recoveryVersion)) throw Error('Recovery compiler does not match the selected build inputs.');

const patches = JSON.parse(await readFile(path.join(root, 'native/opentui/patches.json'), 'utf8'));
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (patches.upstreamCommit !== inputs.opentui.commit || patches.version !== inputs.versions.opentui ||
    packageManifest.dependencies['@opentui/core'] !== inputs.versions.opentui || packageManifest.dependencies['@opentui/solid'] !== inputs.versions.opentui ||
    packageManifest.dependencies['solid-js'] !== inputs.versions.solid) throw Error('Terminal package, native patches and pinned build inputs disagree.');
const nativeSource = path.join(build, 'opentui-native');
// Build inputs are explicit developer toolchains. No installed application ever
// downloads, compiles, follows these paths, or requires a development checkout.
if (sourceInput) {
  const source = path.resolve(sourceInput);
  for (const item of patches.files) {
    if (hash(await readFile(path.join(source, item.file))) !== item.baseSha256) throw Error(`Wrong pinned OpenTUI source: ${item.file}`);
  }
  await mkdir(nativeSource, { recursive: true });
  await cp(path.join(source, 'src'), path.join(nativeSource, 'src'), { recursive: true });
  for (const name of ['build.zig', 'build.zig.zon']) await copyFile(path.join(source, name), path.join(nativeSource, name));
  const dependencies = depsInput ?? path.join(source, 'zig-deps');
  await cp(dependencies, path.join(nativeSource, 'zig-deps'), { recursive: true });
  for (const item of patches.files) {
    const lines = (await readFile(path.join(nativeSource, item.file), 'utf8')).split('\n');
    for (const edit of [...item.edits].reverse()) lines.splice(edit.at, edit.remove, ...edit.insert);
    const output = lines.join('\n');
    if (hash(output) !== item.outputSha256) throw Error(`Native patch mismatch: ${item.file}`);
    await writeFile(path.join(nativeSource, item.file), output);
  }
}
for (const item of patches.files) {
  let value;
  try { value = await readFile(path.join(nativeSource, item.file)); }
  catch { throw Error('Provide pristine fixed OpenTUI native source with ZHIXING_OPENTUI_SOURCE and its fixed zig-deps with ZHIXING_OPENTUI_ZIG_DEPS.'); }
  if (hash(value) !== item.outputSha256) throw Error(`Native build input changed: ${item.file}`);
}
await run(zig, ['build', `-Dlibrary-target=${target.zig}`, '-Doptimize=ReleaseFast', '--prefix', path.join(build, 'native-install')], nativeSource);
await copyFile(path.join(build, 'lib', target.folder, target.library), path.join(dist, target.library));
const nativeCompiler = process.platform === 'darwin' ? (archiveDirectory ? '/usr/bin/cc' : toolCommand(process.env.ZHIXING_NATIVE_CC ?? 'cc')) : recoveryZig;
const nativeCompilerVersion = process.platform === 'darwin' ? await run(nativeCompiler, ['--version'], root, true) : recoveryVersion;
const nativeArguments = process.platform === 'darwin' ? [] : ['cc', '-target', target.zig];
// Native linkers may emit import libraries/debug symbols next to -o or in cwd.
// Keep those compiler-owned outputs in build and copy only runtime artifacts.
const nativeArtifacts = path.join(build, 'terminal-native', targetId);
await mkdir(nativeArtifacts, { recursive: true });
await run(nativeCompiler, [...nativeArguments, ...(process.platform === 'win32' ? ['-municode'] : []), '-O2', '-Wall', '-Wextra',
  path.join(root, process.platform === 'win32' ? 'native/recovery-win32.c' : 'native/recovery-posix.c'),
  ...(process.platform === 'darwin' ? ['-lproc'] : []), '-o', path.join(nativeArtifacts, `recovery${target.suffix}`)], nativeArtifacts);
await run(nativeCompiler, [...nativeArguments, ...(process.platform === 'win32' ? ['-municode'] : []), '-O2', '-Wall', '-Wextra',
  path.join(root, process.platform === 'win32' ? 'native/exec-gate-win32.c' : 'native/exec-gate-posix.c'), '-o', path.join(nativeArtifacts, `exec-gate${target.suffix}`)], nativeArtifacts);
// Node-API v8 is stable across the supported Node 24 runtime. Headers/import
// library are developer build inputs only, never an installed runtime download.
const nodeApi = path.join(build, 'node-api');
if (nodeInput) {
  const source = path.resolve(nodeInput);
  await mkdir(nodeApi, { recursive: true });
  for (const name of inputs.node.headerFiles) {
    await copyFile(path.join(source, 'include/node', name), path.join(nodeApi, name));
  }
  if (process.platform === 'win32') await copyFile(path.join(source, 'x64/node.lib'), path.join(nodeApi, 'node.lib'));
}
try { for (const name of inputs.node.headerFiles) await stat(path.join(nodeApi, name)); if (process.platform === 'win32') await stat(path.join(nodeApi, 'node.lib')); }
catch { throw Error('Provide Node-API developer headers/import library with ZHIXING_NODE_API_SOURCE.'); }
if (archiveDirectory && process.platform === 'win32') await verifyInput(path.join(nodeApi, 'node.lib'), inputs.node.windowsLibrary);
await run(nativeCompiler, [...nativeArguments, '-shared', '-O2', '-Wall', '-Wextra', '-DNAPI_VERSION=8', '-I', nodeApi,
  path.join(root, process.platform === 'win32' ? 'native/foreground-win32.c' : 'native/foreground-posix.c'),
  ...(process.platform === 'win32' ? [path.join(nodeApi, 'node.lib'), '-lcrypt32'] : ['-fPIC', '-pthread']),
  ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup', '-lproc'] : []), '-o', path.join(nativeArtifacts, 'foreground.node')], nativeArtifacts);
for (const name of [`recovery${target.suffix}`, 'foreground.node', `exec-gate${target.suffix}`]) {
  await copyFile(path.join(nativeArtifacts, name), path.join(dist, name));
}
await run(bun, [path.join(root, 'scripts/build-ui.ts')], root);
// Migrate only the three sidecars emitted by the previous Windows builder.
// Unknown files (including unknown .lib/.pdb files) still fail the exact set check.
if (process.platform === 'win32') for (const name of ['foreground-win32.lib', 'foreground.pdb', 'recovery.pdb']) {
  const file = path.join(dist, name);
  try {
    if (!(await lstat(file)).isFile()) throw Error(`Unexpected compiler sidecar type: ${name}`);
    await unlink(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = [`ui${target.suffix}`, `recovery${target.suffix}`, target.library, 'foreground.node', `exec-gate${target.suffix}`, ...inputs.requiredAssets].sort();
const actualFiles = (await relativeFiles(dist)).filter(name => name !== 'manifest.json').sort();
if (JSON.stringify(files) !== JSON.stringify(actualFiles)) throw Error('Terminal dist is incomplete or contains stale/unexpected files. Use a clean target dist before rebuilding.');
const artifacts = [];
for (const name of files) artifacts.push({ name, bytes: (await stat(path.join(dist, name))).size, sha256: hash(await readFile(path.join(dist, name))) });
const nodeFiles = [];
for (const name of [...inputs.node.headerFiles, ...(process.platform === 'win32' ? ['node.lib'] : [])]) {
  nodeFiles.push({ name, sha256: hash(await readFile(path.join(nodeApi, name))) });
}
await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ protocol: 'zhixing-terminal/1', packageVersion: packageManifest.version,
  platform: process.platform, arch: process.arch, bun: inputs.versions.bun, opentui: inputs.versions.opentui, solid: inputs.versions.solid,
  nativeCommit: patches.upstreamCommit, buildInputs: { verifiedArchives: !!archiveDirectory, definitionSha256: hash(JSON.stringify(inputs)),
    node: archiveDirectory ? inputs.versions.node : null, nodeFiles, zig: inputs.versions.zig, recoveryZig: recoveryVersion, nativeCompilerVersion }, artifacts }, null, 2));
console.log(`Built ${process.platform}-${process.arch} terminal artifacts.`);

function toolCommand(command) {
  // Explicit relative tools keep the package-root meaning used by version
  // probes even when compilation runs in its own artifact/source directory.
  // Bare command names still use PATH; absolute commands remain unchanged.
  return path.isAbsolute(command) || (!/[\\/]/u.test(command) && !(process.platform === 'win32' && /^[a-z]:/iu.test(command)))
    ? command : path.resolve(root, command);
}

async function verifyInput(file, expected) {
  const value = await readFile(file);
  if (!/^[0-9a-f]{64}$/.test(expected.sha256) || hash(value) !== expected.sha256 || (expected.bytes !== undefined && value.length !== expected.bytes)) {
    throw Error(`Pinned input checksum/size mismatch: ${path.basename(file)}`);
  }
}

async function extractInput(input) {
  const destination = await mkdtemp(path.join(build, 'input-'));
  const file = path.resolve(archiveDirectory, input.file);
  // Native Windows tar is bsdtar (zip support); Unix runners use unzip for zip.
  if (input.file.endsWith('.zip') && process.platform !== 'win32') await run('unzip', ['-q', file, '-d', destination], root);
  else await run(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar', ['-xf', file, '-C', destination], root);
  return path.join(destination, input.root);
}

async function relativeFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await relativeFiles(full, base));
    else if (entry.isFile()) result.push(path.relative(base, full).split(path.sep).join('/'));
    else throw Error(`Unexpected terminal artifact type: ${full}`);
  }
  return result;
}
