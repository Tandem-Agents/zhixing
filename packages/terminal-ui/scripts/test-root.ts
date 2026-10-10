import path from 'node:path';
import solidPlugin from '@opentui/solid/bun-plugin';
import { createOpenTuiBuildPlugin } from './opentui-build-plugin.js';
import { access } from 'node:fs/promises';
const root = path.resolve(import.meta.dir, '..');
const dist = path.join(root, 'dist', `${process.platform}-${process.arch}`);
process.env.OTUI_ASSET_ROOT = path.join(dist, 'assets');
process.env.ZHIXING_TERMINAL_RENDER_LIB = path.join(dist, process.platform === 'win32' ? 'opentui.dll' : process.platform === 'darwin' ? 'libopentui.dylib' : 'libopentui.so');
await access(process.env.ZHIXING_TERMINAL_RENDER_LIB);
const entries = process.argv[2] ? [process.argv[2]] : ['root', 'reading', 'reading-regressions'];
const result = await Bun.build({ entrypoints: entries.map(name => path.join(root, `src/__tests__/${name}.native.tsx`)), outdir: path.join(root, 'build/root-test'), target: 'bun',
  plugins: [createOpenTuiBuildPlugin(root), solidPlugin] });
if (!result.success) throw new AggregateError(result.logs, 'Native root test build failed');
for (const name of entries) {
  const child = Bun.spawn([process.execPath, path.join(root, `build/root-test/${name}.native.js`)], { cwd: root, env: { ...process.env }, stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code) { process.exitCode = code; break; }
}
