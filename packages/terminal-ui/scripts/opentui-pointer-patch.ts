/** Deliver takeover before native selection/capture routing. A fresh press is
 * a new gesture even when a previous mouse-up never reached the application.
 * 终端尺寸变化不是用户接管：原生选区拖动中时保留解析器的已按下按键，按住移动在 resize 后仍是拖动
 * （解析器判定 drag 只看这个集合）；没有拖选时照原样清空。 */
export function patchPointerTakeover(input: string): string {
  const replace = (before: string, after: string) => {
    if (input.split(before).length !== 2) throw Error('Fixed OpenTUI pointer patch no longer matches');
    input = input.replace(before, after);
  };
  replace('  processSingleMouseEvent(mouseEvent) {', `  releasePointerCapture() {
    this.setCapturedRenderable(undefined);
    if (this.currentSelection?.isDragging) this.finishSelection();
  }
  processSingleMouseEvent(mouseEvent) {
    if (mouseEvent.type === "down") this.emit("pointer-takeover");`);
  replace('    this.queryPixelResolution();\n    this.setCapturedRenderable(undefined);\n    this.stdinParser?.resetMouseState();',
    '    this.queryPixelResolution();\n    this.setCapturedRenderable(undefined);\n    if (!this.currentSelection?.isDragging) this.stdinParser?.resetMouseState();');
  return input;
}
