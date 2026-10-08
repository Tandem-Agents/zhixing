import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { patchPasteParser, patchPasteRenderer } from './opentui-paste-patch.js';
import { patchParserAssets, patchParserClient } from './opentui-parser-patch.js';
import { patchAtomicWrapFFI } from './opentui-atomic-wrap-patch.js';

/** Identical admitted-library/FFI/parser/lifecycle policy for UI and native tests. */
export function createOpenTuiBuildPlugin(root: string) {
  const replaceOnce = (source: string, before: string, after: string) => {
    if (source.split(before).length !== 2) throw Error('Fixed OpenTUI lifecycle patch no longer matches');
    return source.replace(before, after);
  };
  return {
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
          source = patchParserAssets(source);
          source = patchPasteParser(source);
          source = patchParserClient(source);
          source = patchAtomicWrapFFI(source);
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
}
