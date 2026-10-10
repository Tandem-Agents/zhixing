/** Deliver takeover before native selection/capture routing. A fresh press is
 * a new gesture even when a previous mouse-up never reached the application. */
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
  return input;
}
