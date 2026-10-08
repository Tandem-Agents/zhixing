import solidPlugin from '@opentui/solid/bun-plugin';
import { getNodeAssets } from '@opentui/core/node-assets';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { patchParserWorker } from './opentui-parser-patch.js';
import { createOpenTuiBuildPlugin } from './opentui-build-plugin.js';

const root = path.resolve(import.meta.dir, '..');
const platform = process.platform, arch = process.arch;
if (!(platform === 'win32' && arch === 'x64') && !((platform === 'linux' || platform === 'darwin') && (arch === 'x64' || arch === 'arm64'))) {
  throw Error(`Unsupported terminal UI build host: ${platform}-${arch}`);
}
const target = platform === 'win32' ? 'bun-windows-x64' : platform === 'linux'
  ? arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'
  : arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
const dist = path.join(root, 'dist', `${platform}-${arch}`);
await mkdir(dist, { recursive: true });
// Keep OpenTUI's top-level await/dynamic imports in ESM while moving JS parsing
// into the pinned build. No runtime cache or earlier renderer admission.
const result = await Bun.build({ entrypoints: [path.join(root, 'src/entry.ts')], target: 'bun', format: 'esm', bytecode: true,
  plugins: [createOpenTuiBuildPlugin(root), solidPlugin], compile: { target, execArgv: ['--smol'], outfile: path.join(dist, platform === 'win32' ? 'ui.exe' : 'ui') } });
if (!result.success) throw new AggregateError(result.logs, 'Terminal UI compile failed');
for (const asset of getNodeAssets({ platform, arch })) {
  // The admitted patched library is the renderer, never the stock copy.
  if (['/opentui.dll', '/libopentui.so', '/libopentui.dylib'].some(name => asset.key.endsWith(name))) continue;
  const destination = path.join(dist, 'assets', asset.key);
  await mkdir(path.dirname(destination), { recursive: true });
  if (asset.key.endsWith('/parser.worker.js')) await writeFile(destination, patchParserWorker(await readFile(asset.source, 'utf8')));
  else await copyFile(asset.source, destination);
}
await mkdir(path.join(dist, 'notices'), { recursive: true });
await copyFile(path.join(root, 'native/opentui/LICENSE'), path.join(dist, 'notices/OpenTUI-MIT.txt'));
