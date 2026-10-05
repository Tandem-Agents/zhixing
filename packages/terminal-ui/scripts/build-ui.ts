import solidPlugin from '@opentui/solid/bun-plugin';
import { getNodeAssets } from '@opentui/core/node-assets';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { patchPasteParser, patchPasteRenderer } from './opentui-paste-patch.js';

const root = path.resolve(import.meta.dir, '..');
const platform = process.platform, arch = process.arch;
if (!(platform === 'win32' && arch === 'x64') && !((platform === 'linux' || platform === 'darwin') && (arch === 'x64' || arch === 'arm64'))) {
  throw Error(`Unsupported terminal UI build host: ${platform}-${arch}`);
}
const target = platform === 'win32' ? 'bun-windows-x64' : platform === 'linux'
  ? arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'
  : arch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
const dist = path.join(root, 'dist', `${platform}-${arch}`);
const replaceOnce = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2) throw Error('Fixed OpenTUI lifecycle patch no longer matches');
  return source.replace(before, after);
};
const recoveryLifecycle = {
  name: 'zhixing-external-recovery-owner',
  setup(build: any) {
    build.onResolve({ filter: /^solid-js$/ }, () => ({ path: Bun.resolveSync('solid-js/dist/solid.js', root) }));
    build.onResolve({ filter: /^solid-js\/store$/ }, () => ({ path: Bun.resolveSync('solid-js/store/dist/store.js', root) }));
    build.onLoad({ filter: /chunk-bun-(?:j2z63cdy|sjw2d9bq)\.js$/ }, async (args: any) => {
      let source = await readFile(args.path, 'utf8');
      if (args.path.endsWith('j2z63cdy.js')) {
        source = patchPasteRenderer(source);
        source = replaceOnce(source, 'const kittyConfig = config.useKittyKeyboard ?? {};', 'const kittyConfig = config.useKittyKeyboard === undefined ? {} : config.useKittyKeyboard;');
        source = replaceOnce(source, '    try {\n      this.setupInput();\n    } catch (error) {', '    try {\n      if (!config.externalRecoveryOwner) this.setupInput();\n    } catch (error) {');
      } else {
        source = patchPasteParser(source);
        const start = source.indexOf('async function resolveNativeLibraryPath() {');
        const end = source.indexOf('// src/lib/tree-sitter/default-parsers.ts', start);
        if (start < 0 || end < 0) throw Error('Fixed OpenTUI native loader changed');
        source = source.slice(0, start) + 'async function resolveNativeLibraryPath() { if (!process.env.ZHIXING_TERMINAL_RENDER_LIB) throw new Error("Admitted renderer asset required"); return process.env.ZHIXING_TERMINAL_RENDER_LIB; }\n\n' + source.slice(end);
        source = replaceOnce(source, 'try {\n  opentuiLib = new FFIRenderLib(opentuiLibPath);\n} catch (error) {}', '// Native initialization belongs to the admitted UI root.');
      }
      return { contents: source, loader: 'js', resolveDir: path.dirname(args.path) };
    });
  },
};
await mkdir(dist, { recursive: true });
const result = await Bun.build({ entrypoints: [path.join(root, 'src/entry.ts')], target: 'bun', plugins: [recoveryLifecycle, solidPlugin], compile: { target, outfile: path.join(dist, platform === 'win32' ? 'ui.exe' : 'ui') } });
if (!result.success) throw new AggregateError(result.logs, 'Terminal UI compile failed');
for (const asset of getNodeAssets({ platform, arch })) {
  // The admitted patched library is the renderer, never the stock copy.
  if (['/opentui.dll', '/libopentui.so', '/libopentui.dylib'].some(name => asset.key.endsWith(name))) continue;
  const destination = path.join(dist, 'assets', asset.key);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(asset.source, destination);
}
await mkdir(path.join(dist, 'notices'), { recursive: true });
await copyFile(path.join(root, 'native/opentui/LICENSE'), path.join(dist, 'notices/OpenTUI-MIT.txt'));
