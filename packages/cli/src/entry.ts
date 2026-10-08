import { normalizeCliArgs } from './logging/entry-mode.js';

// Capture the earliest JS boundary before loading the interactive graph. The
// admitted bootstrap recorder consumes this finite observation; no extra file.
const entryAt = performance.now();

// Select one surface before creating any terminal owner. Redirected streams,
// metadata and background services never acquire the interactive screen.
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
} else if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY && process.env.TERM !== 'dumb') {
  const interactive = args.length === 0 || (await import('./index.js')).usesInteractiveTerminal(args);
  if (interactive) {
    const prepareAt = performance.now(), prepareCpu = process.cpuUsage();
    // S forwards finite, short-lived display frames. Like N, keep a modest
    // growth margin instead of retaining a server-sized spare heap. This does
    // not cap usable memory or force GC, and never changes the Host runtime.
    (await import('node:v8')).setFlagsFromString('--heap-growing-percent=20');
    const loadAt = performance.now();
    const { launchTerminal } = await import('./terminal/launch.js');
    const loadedAt = performance.now(), cpu = process.cpuUsage(prepareCpu);
    process.exit(await launchTerminal(args, { entryMs: entryAt, prepareMs: loadAt - prepareAt,
      loadMs: loadedAt - loadAt, processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000 }));
  } else await import('./command-entry.js');
} else {
  await import('./command-entry.js');
}
