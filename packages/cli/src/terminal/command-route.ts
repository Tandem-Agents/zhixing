import type { Command } from 'commander';

interface ParsedRoute { readonly operands: readonly string[]; readonly options: Readonly<Record<string, string | boolean>> }
const routes = new WeakMap<Command, { when: (input: ParsedRoute) => boolean; management: boolean }>();
/** Metadata lives beside actual action registration; no parallel command tree. */
export function terminalCommand(command: Command, when: (input: ParsedRoute) => boolean = () => true, management = false): void {
  routes.set(command, { when, management });
}
export function commandUsesManagement(command: Command): boolean { return routes.get(command)?.management === true; }
export function terminalCommandFor(root: Command, args: readonly string[]): Command | undefined {
  if (args.some(arg => ['--help', '-h', '--version', '-V'].includes(arg))) return;
  let command = root, offset = 0;
  while (offset < args.length) {
    if (args[offset] === '--log') { offset++; continue; }
    const child = command.commands.find(candidate => candidate.name() === args[offset] || candidate.aliases().includes(args[offset]!));
    if (!child) break;
    command = child; offset++;
  }
  const route = routes.get(command); if (!route) return;
  const options: Record<string, string | boolean> = {}, operands: string[] = [];
  for (; offset < args.length; offset++) {
    const token = args[offset]!;
    if (token === '--') { operands.push(...args.slice(offset + 1)); break; }
    if (!token.startsWith('-')) { operands.push(token); continue; }
    if (token === '--log') continue;
    const split = token.indexOf('='), name = split < 0 ? token : token.slice(0, split);
    const option = command.options.find(value => value.long === name || value.short === name);
    if (!option) return; // Original Commander reports malformed/unknown arguments.
    if (option.required || option.optional) {
      const value = split < 0 ? args[++offset] : token.slice(split + 1);
      if (value === undefined || value.startsWith('--')) return;
      options[option.attributeName()] = value;
    } else options[option.attributeName()] = !option.negate;
  }
  return route.when({ operands, options }) ? command : undefined;
}
