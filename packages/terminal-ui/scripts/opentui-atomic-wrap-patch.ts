/** Apply only to fixed chunk-bun-sjw2d9bq.js in the existing build-ui plugin. */
export function patchAtomicWrapFFI(source: string): string {
  if (source.includes('editorViewSetNoBreakRanges')) throw Error('Atomic-wrap FFI patch already applied');
  const once = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw Error('Fixed OpenTUI atomic-wrap FFI seam changed');
    source = source.replace(before, after);
  };
  once('    editorViewSetWrapMode: {', `    editorViewSetNoBreakRanges: {
      args: ["u32", "buffer", "u32"],
      returns: "bool"
    },
    editorViewSetWrapMode: {`);
  once('  editorViewSetWrapMode(view, mode) {', `  editorViewSetNoBreakRanges(view, ranges) {
    if (!(ranges instanceof Uint32Array) || ranges.length % 2 || ranges.length > 131072) return false;
    return this.opentui.symbols.editorViewSetNoBreakRanges(view, ranges, ranges.length / 2);
  }
  editorViewSetWrapMode(view, mode) {`);
  return source;
}
