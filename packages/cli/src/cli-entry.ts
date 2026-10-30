import { realpathSync } from 'node:fs';
import path from 'node:path';

/** 只在单份启动图的构建里被替换为 true；逐文件产物与源码里不存在该标识。 */
declare const __ZHIXING_PROGRAM_BUNDLE__: boolean | undefined;

/** 单份启动图所在目录（与 CLI 入口同在 dist 下）。 */
export const PROGRAM_BUNDLE_DIRECTORY = 'bundle';

/** npm's POSIX bin is a symlink. Every self-exec and adjacent asset lookup
 * uses the physical entry, while the user's cwd remains entirely unrelated. */
export function resolveCliEntry(entry = process.argv[1], realpath: (file: string) => string = realpathSync): string {
  if (!entry) throw Error('cli-entry-unavailable');
  return realpath(entry);
}

/** 与给定 CLI 入口同一分发的单份启动图入口；S 用它拉起宿主与 N。 */
export function programBundleEntry(entry: string): string {
  return path.join(path.dirname(entry), PROGRAM_BUNDLE_DIRECTORY, 'index.js');
}

/**
 * 定位随 CLI 分发的固定产物（原生件、受管服务登记）所用的规范入口。进程从单份启动图启动时，
 * 物理入口是 dist/bundle/index.js，固定产物与登记仍以同一分发的 dist/index.js 为准；
 * 逐文件启动时就是物理入口本身。显式指定入口的调用一律用 resolveCliEntry。
 */
export function resolveProgramEntry(realpath: (file: string) => string = realpathSync): string {
  const physical = resolveCliEntry(process.argv[1], realpath);
  if (typeof __ZHIXING_PROGRAM_BUNDLE__ === 'undefined' || !__ZHIXING_PROGRAM_BUNDLE__) return physical;
  const directory = path.dirname(physical);
  if (path.basename(physical) !== 'index.js' || path.basename(directory) !== PROGRAM_BUNDLE_DIRECTORY) throw Error('cli-program-bundle-layout');
  return path.join(path.dirname(directory), 'index.js');
}
