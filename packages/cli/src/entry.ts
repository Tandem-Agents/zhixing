import { normalizeCliArgs } from './logging/entry-mode.js';

// Selection precedes every terminal owner. Metadata, commands and redirected
// input retain the established route during U1; one invocation uses one root.
const args = normalizeCliArgs(process.argv.slice(2));
if (process.env.ZHIXING_TERMINAL_ROLE === 'application' &&
  (process.env.ZHIXING_TERMINAL_PIPE || process.env.ZHIXING_TERMINAL_FD === '3')) {
  // Publish the existing process compatibility proof before the heavy graph
  // loads. Other live entry loggers must not mistake N for a legacy writer.
  const home = process.env.ZHIXING_TERMINAL_HOME;
  if (home) {
    const path = await import('node:path');
    await (await import('./terminal/writer-declaration.js')).beginTerminalWriterDeclaration(home,
      path.join(path.dirname(process.argv[1]!), 'terminal', `${process.platform}-${process.arch}`, 'foreground.node'));
  }
  const { runTerminalApplication } = await import('./terminal/application.js');
  await runTerminalApplication();
} else if (process.env.ZHIXING_TERMINAL_UI === 'opentui' &&
  process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) {
  const interactive = args.length === 0 || (await import('./index.js')).usesInteractiveTerminal(args);
  if (interactive) {
    // S forwards finite, short-lived display frames. Like N, keep a modest
    // growth margin instead of retaining a server-sized spare heap. This does
    // not cap usable memory or force GC, and never changes the Host runtime.
    (await import('node:v8')).setFlagsFromString('--heap-growing-percent=20');
    const { launchTerminal } = await import('./terminal/launch.js');
    process.exit(await launchTerminal(args));
  } else await import('./legacy-entry.js');
} else {
  await import('./legacy-entry.js');
}
