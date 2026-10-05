import ts from 'typescript';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const program = ts.createProgram(['protocol.ts', 'channel.ts', 'parent-transport.ts'].map(file => path.join(root, 'src', file)), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, declaration: true, noEmitOnError: true,
  rootDir: path.join(root, 'src'), outDir: path.join(root, 'dist/shared'), types: ['node'], typeRoots: [path.join(root, 'node_modules/@types')],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
}));
if (program.emit().emitSkipped) throw Error('Shared terminal protocol did not compile.');
