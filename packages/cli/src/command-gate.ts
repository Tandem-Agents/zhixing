import type { Command } from "commander";

const GLOBAL_EXIT_OPTIONS = new Set(["--help", "-h", "--version", "-V"]);
const GLOBAL_OPTIONS = new Set(["--log"]);

export function findUnknownCommandPath(
  argv: readonly string[],
  command: Pick<Command, "commands">,
): string | null {
  let current: Pick<Command, "commands"> = command;
  const path: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]!;
    if (GLOBAL_EXIT_OPTIONS.has(token)) return null;
    if (path.length === 0 && GLOBAL_OPTIONS.has(token)) continue;
    if (token.startsWith("-")) return null;

    const subcommand = findSubcommand(current, token);
    if (subcommand) {
      path.push(token);
      current = subcommand;
      continue;
    }

    if (current.commands.length > 0) {
      return [...path, token].join(" ");
    }
    return null;
  }

  return null;
}

function findSubcommand(
  command: Pick<Command, "commands">,
  token: string,
): Pick<Command, "commands"> | null {
  for (const subcommand of command.commands) {
    if (subcommand.name() === token) return subcommand;
    if (subcommand.aliases().includes(token)) {
      return subcommand;
    }
  }
  return null;
}
