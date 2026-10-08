import { createRequire } from 'node:module';
import { beginWriterDeclaration, type LogWriterDeclarationFactory } from '../logging/writer-admission.js';

/** The admitted Windows native edge serves one fixed identity without another
 * JavaScript isolate. Other platforms retain the existing independent worker. */
export function terminalWriterDeclarationFactory(artifact: string): LogWriterDeclarationFactory | undefined {
  if (process.platform !== 'win32') return undefined;
  const native = createRequire(import.meta.url)(artifact) as {
    declareWriter(root: string, protocol: number): void;
    closeWriterDeclaration(): void;
  };
  return (root, protocol) => {
    native.declareWriter(root, protocol);
    let closed = false;
    return { ready: Promise.resolve(), async close() {
      if (!closed) { closed = true; native.closeWriterDeclaration(); }
    } };
  };
}

export function beginTerminalWriterDeclaration(home: string, artifact: string): Promise<void> {
  return beginWriterDeclaration(home, undefined, terminalWriterDeclarationFactory(artifact));
}
