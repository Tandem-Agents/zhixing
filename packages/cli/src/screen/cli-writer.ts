/** Append-only text output port for commands, Host notices and text sessions. */
export interface CliWriter {
  line(text: string): void;
  appendInline(text: string): void;
  notify(text: string): void;
  ensureSegmentBreak(): void;
}

/** Direct stream output; terminal layout and replacement belong to the UI root. */
export function createStdoutWriter(options: { readonly stdout?: Pick<NodeJS.WriteStream, "write"> } = {}): CliWriter {
  const stdout = options.stdout ?? process.stdout;
  const line = (text: string): void => {
    stdout.write(text);
    if (!text.endsWith("\n")) stdout.write("\n");
  };
  return {
    line,
    appendInline(text) { if (text.length > 0) stdout.write(text); },
    notify: line,
    ensureSegmentBreak() {},
  };
}
