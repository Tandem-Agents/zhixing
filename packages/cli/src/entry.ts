import { normalizeCliArgs } from './logging/entry-mode.js';

// Selection precedes every terminal owner. Metadata, commands and redirected
// input retain the established route during U1; one invocation uses one root.
const args = normalizeCliArgs(process.argv.slice(2));
if (process.env.ZHIXING_TERMINAL_ROLE === 'application' &&
  (process.env.ZHIXING_TERMINAL_PIPE || process.env.ZHIXING_TERMINAL_FD === '3')) {
  const { runTerminalApplication } = await import('./terminal/application.js');
  await runTerminalApplication();
} else if (process.env.ZHIXING_TERMINAL_UI === 'opentui' &&
  process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) {
  const interactive = args.length === 0 || (await import('./index.js')).usesInteractiveTerminal(args);
  if (interactive) {
    const { launchTerminal } = await import('./terminal/launch.js');
    process.exit(await launchTerminal(args));
  } else await import('./legacy-entry.js');
} else {
  await import('./legacy-entry.js');
}
