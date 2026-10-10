/** Fixed-version correction: viewport is a size, never a scrollable distance.
 * Reserve the track column even at EOF; visibility only controls its paint. */
export function patchScrollGeometry(input: string): string {
  const replace = (before: string, after: string) => {
    if (input.split(before).length !== 2) throw Error('Fixed OpenTUI scroll patch no longer matches');
    input = input.replace(before, after);
  };
  replace('const clampedSize = Math.max(0.01, Math.min(size, this._max - this._min));', 'const clampedSize = Math.max(1, size);');
  replace('    this.slider.min = 0;\n    this.slider.max = scrollRange;\n    this.slider.value = Math.min(this._scrollPosition, scrollRange);',
    '    this.slider.min = 0;\n    this.slider.viewPortSize = Math.max(1, this._viewportSize);\n    this.slider.max = scrollRange;\n    this.slider.value = Math.max(0, Math.min(this._scrollPosition, scrollRange));');
  replace('Math.round(Math.min(Math.max(0, value), this.scrollSize - this.viewportSize))', 'Math.round(Math.max(0, Math.min(value, this.scrollSize - this.viewportSize)))');
  const begin = input.indexOf('  getVirtualThumbSize() {'), end = input.indexOf('\n}\n\n// src/renderables/ScrollBar.ts', begin);
  if (begin < 0 || end < 0) throw Error('Fixed OpenTUI slider geometry changed');
  input = input.slice(0, begin) + `  getVirtualThumbSize() {
    const track = this.orientation === "vertical" ? this.height : this.width;
    const range = Math.max(0, this._max - this._min);
    if (!range || track <= 0) return 0;
    return 2 * Math.max(1, Math.min(Math.max(1, track - 1), Math.round(track * this._viewPortSize / (range + this._viewPortSize))));
  }
  getVirtualThumbStart() {
    const track = this.orientation === "vertical" ? this.height : this.width;
    const range = Math.max(0, this._max - this._min);
    if (!range) return 0;
    return 2 * Math.round((track - this.getVirtualThumbSize() / 2) * Math.max(0, Math.min(range, this._value - this._min)) / range);
  }` + input.slice(end);
  return input;
}
