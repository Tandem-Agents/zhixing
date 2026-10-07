import path from 'node:path';
import solidPlugin from '@opentui/solid/bun-plugin';
const root = path.resolve(import.meta.dir, '..');
process.env.OTUI_ASSET_ROOT = path.join(root, 'dist', `${process.platform}-${process.arch}`, 'assets');
const result = await Bun.build({ entrypoints: [path.join(root, 'src/__tests__/root.native.tsx')], outdir: path.join(root, 'build/root-test'), target: 'bun',
  external: ['@opentui/core', '@opentui/core/testing'],
  plugins: [{ name: 'solid-client', setup(build) {
    build.onResolve({ filter: /^solid-js$/ }, () => ({ path: Bun.resolveSync('solid-js/dist/solid.js', root) }));
  } }, solidPlugin] });
if (!result.success) throw new AggregateError(result.logs, 'Native root test build failed');
const child = Bun.spawn([process.execPath, path.join(root, 'build/root-test/root.native.js')], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
process.exitCode = await child.exited;
