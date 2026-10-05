import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import './build-shared.mjs';

const root = path.resolve(import.meta.dirname, '..');
const build = path.join(root, 'build');
const dist = path.join(root, 'dist', `${process.platform}-${process.arch}`);
const targets = {
  'win32-x64': { zig: 'x86_64-windows-gnu', library: 'opentui.dll', folder: 'x86_64-windows', suffix: '.exe' },
  'linux-x64': { zig: 'x86_64-linux-gnu.2.35', library: 'libopentui.so', folder: 'x86_64-linux-gnu.2.35', suffix: '' },
  'linux-arm64': { zig: 'aarch64-linux-gnu.2.35', library: 'libopentui.so', folder: 'aarch64-linux-gnu.2.35', suffix: '' },
  'darwin-x64': { zig: 'x86_64-macos.13.0', library: 'libopentui.dylib', folder: 'x86_64-macos', suffix: '' },
  'darwin-arm64': { zig: 'aarch64-macos.13.0', library: 'libopentui.dylib', folder: 'aarch64-macos', suffix: '' },
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw Error('Unsupported terminal build host; build each of the five release targets on its matching host.');
const bun = process.env.ZHIXING_BUN_BINARY ?? 'bun';
const zig = process.env.ZHIXING_ZIG_BINARY ?? 'zig';
const recoveryZig = process.env.ZHIXING_RECOVERY_ZIG_BINARY ?? zig;
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
if (await run(bun, ['--version'], root, true) !== '1.4.2') throw Error('UI builds require Bun 1.4.2; set ZHIXING_BUN_BINARY to the fixed developer toolchain.');
if (await run(zig, ['version'], root, true) !== '0.16.0') throw Error('OpenTUI native builds require Zig 0.16.0; set ZHIXING_ZIG_BINARY.');
const recoveryVersion = await run(recoveryZig, ['version'], root, true);
if (!['0.14.1', '0.16.0'].includes(recoveryVersion)) throw Error('Recovery builds require the pinned Zig 0.14.1 or 0.16.0 compiler.');

const patches = JSON.parse(await readFile(path.join(root, 'native/opentui/patches.json'), 'utf8'));
const nativeSource = path.join(build, 'opentui-native');
// Build inputs are explicit developer toolchains. No installed application ever
// downloads, compiles, follows these paths, or requires a development checkout.
if (process.env.ZHIXING_OPENTUI_SOURCE) {
  const source = path.resolve(process.env.ZHIXING_OPENTUI_SOURCE);
  for (const item of patches.files) {
    if (hash(await readFile(path.join(source, item.file))) !== item.baseSha256) throw Error(`Wrong pinned OpenTUI source: ${item.file}`);
  }
  await mkdir(nativeSource, { recursive: true });
  await cp(path.join(source, 'src'), path.join(nativeSource, 'src'), { recursive: true });
  for (const name of ['build.zig', 'build.zig.zon']) await copyFile(path.join(source, name), path.join(nativeSource, name));
  const dependencies = process.env.ZHIXING_OPENTUI_ZIG_DEPS ?? path.join(source, 'zig-deps');
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
const nativeCompiler = process.platform === 'darwin' ? (process.env.ZHIXING_NATIVE_CC ?? 'cc') : recoveryZig;
const nativeArguments = process.platform === 'darwin' ? [] : ['cc', '-target', target.zig];
await run(nativeCompiler, [...nativeArguments, ...(process.platform === 'win32' ? ['-municode'] : []), '-O2', '-Wall', '-Wextra',
  path.join(root, process.platform === 'win32' ? 'native/recovery-win32.c' : 'native/recovery-posix.c'),
  ...(process.platform === 'darwin' ? ['-lproc'] : []), '-o', path.join(dist, `recovery${target.suffix}`)], root);
if (process.platform !== 'win32') await run(nativeCompiler, [...nativeArguments, '-O2', '-Wall', '-Wextra', path.join(root, 'native/exec-gate-posix.c'), '-o', path.join(dist, 'exec-gate')], root);
// Node-API v8 is stable across the supported Node 24 runtime. Headers/import
// library are developer build inputs only, never an installed runtime download.
const nodeApi = path.join(build, 'node-api');
if (process.env.ZHIXING_NODE_API_SOURCE) {
  const source = path.resolve(process.env.ZHIXING_NODE_API_SOURCE);
  await mkdir(nodeApi, { recursive: true });
  for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h']) {
    await copyFile(path.join(source, 'include/node', name), path.join(nodeApi, name));
  }
  if (process.platform === 'win32') await copyFile(path.join(source, 'x64/node.lib'), path.join(nodeApi, 'node.lib'));
}
try { await stat(path.join(nodeApi, 'node_api.h')); if (process.platform === 'win32') await stat(path.join(nodeApi, 'node.lib')); }
catch { throw Error('Provide Node-API developer headers/import library with ZHIXING_NODE_API_SOURCE.'); }
await run(nativeCompiler, [...nativeArguments, '-shared', '-O2', '-Wall', '-Wextra', '-DNAPI_VERSION=8', '-I', nodeApi,
  path.join(root, process.platform === 'win32' ? 'native/foreground-win32.c' : 'native/foreground-posix.c'),
  ...(process.platform === 'win32' ? [path.join(nodeApi, 'node.lib')] : ['-fPIC', '-pthread']),
  ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup', '-lproc'] : []), '-o', path.join(dist, 'foreground.node')], root);
await run(bun, [path.join(root, 'scripts/build-ui.ts')], root);
const files = [`ui${target.suffix}`, `recovery${target.suffix}`, target.library, 'foreground.node', ...(process.platform === 'win32' ? [] : ['exec-gate'])];
const artifacts = [];
for (const name of files) artifacts.push({ name, bytes: (await stat(path.join(dist, name))).size, sha256: hash(await readFile(path.join(dist, name))) });
await writeFile(path.join(dist, 'manifest.json'), JSON.stringify({ protocol: 'zhixing-terminal/1', platform: process.platform, arch: process.arch, bun: '1.4.2', opentui: '0.5.14', solid: '1.9.12', nativeCommit: patches.upstreamCommit, artifacts }, null, 2));
console.log(`Built ${process.platform}-${process.arch} terminal artifacts.`);
