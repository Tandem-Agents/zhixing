// Fixed OpenTUI 0.5.14 seam. Keep its delimiter parser and one stdin reader;
// only replace the whole-paste collector for our explicitly configured root.
const once = (source: string, before: string, after: string): string => {
  if (source.split(before).length !== 2) throw Error('Fixed OpenTUI paste owner seam changed');
  return source.replace(before, after);
};

export function patchPasteRenderer(source: string): string {
  source = once(source, '    this.stdinParser = new StdinParser2({',
    '    this.stdinParser = new StdinParser2({\n      externalPaste: config.externalPaste ? events => { for (const event of events) this.handleStdinEvent(event); return config.externalPaste(); } : undefined,');
  return once(source, '      this.stdinParser.push(data);\n      this.drainStdinParser();',
    '      for (let offset = 0; offset < data.length; offset += 1024) {\n        this.stdinParser.push(data.subarray(offset, offset + 1024));\n        this.drainStdinParser();\n      }');
}

export function patchPasteParser(source: string): string {
  source = once(source, '  paste = null;\n  constructor(options = {}) {',
    '  paste = null;\n  externalPaste;\n  constructor(options = {}) {\n    this.externalPaste = options.externalPaste;');
  source = once(source, '              this.paste = createPasteCollector();',
    '              this.paste = createPasteCollector();\n              if (this.externalPaste) this.paste.sink = this.externalPaste(this.events.splice(0));');
  source = once(source, `      this.events.push({
        type: "paste",
        bytes: joinPasteBytes(paste.parts, paste.totalLength)
      });`, `      if (this.externalPaste) paste.sink?.end();
      else this.events.push({
        type: "paste",
        bytes: joinPasteBytes(paste.parts, paste.totalLength)
      });`);
  source = once(source, '  pushPasteBytes(bytes) {', `  pushPasteBytes(bytes) {
    if (this.externalPaste) {
      this.paste.sink?.write(bytes);
      return;
    }`);
  return once(source, '    this.unitStart = 0;\n    this.paste = null;\n    this.mouseParser.reset();',
    '    this.unitStart = 0;\n    this.paste?.sink?.abort();\n    this.paste = null;\n    this.mouseParser.reset();');
}
