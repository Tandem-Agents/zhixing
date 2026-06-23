import type { Command } from "commander";

const GLOBAL_EXIT_OPTIONS = new Set(["--help", "-h", "--version", "-V"]);
const GLOBAL_OPTIONS = new Set(["--log"]);

export function findUnknownTopLevelCommand(
  argv: readonly string[],
  command: Pick<Command, "commands">,
): string | null {
  const topLevelCommands = collectTopLevelCommandNames(command);

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (GLOBAL_EXIT_OPTIONS.has(token)) return null;
    if (GLOBAL_OPTIONS.has(token)) continue;
    if (token.startsWith("-")) return null;
    if (topLevelCommands.has(token)) return null;

    return token;
  }

  return null;
}

function collectTopLevelCommandNames(
  command: Pick<Command, "commands">,
): Set<string> {
  const names = new Set<string>();
  for (const subcommand of command.commands) {
    names.add(subcommand.name());
    for (const alias of subcommand.aliases()) {
      names.add(alias);
    }
  }
  return names;
}
