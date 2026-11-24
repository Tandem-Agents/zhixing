const CONVERSATION_VALUE_OPTIONS = new Set([
  "--query",
  "--scope",
  "--limit",
  "--cursor",
  "--name",
  "--scene",
  "--id",
  "--before",
  "--text",
  "--file",
  "--wait",
  "--to",
]);

function findConversationCommandStart(args: readonly string[]): {
  readonly commandIndex: number;
  readonly stripLeadingSeparator: boolean;
} | null {
  let idx = 0;
  let stripLeadingSeparator = false;
  if (args[idx] === "--") {
    stripLeadingSeparator = true;
    idx += 1;
  }
  while (args[idx] === "--log") {
    idx += 1;
  }
  return args[idx] === "conversation"
    ? { commandIndex: idx, stripLeadingSeparator }
    : null;
}

/** pnpm forwards one standalone separator; entry, Commander and discovery share this rule. */
export function normalizeCliArgs(args: readonly string[]): string[] {
  const conv = findConversationCommandStart(args);
  if (!conv) {
    const normalized = [...args], index = normalized.indexOf("--");
    if (index !== -1) normalized.splice(index, 1);
    return normalized;
  }
  const source = conv.stripLeadingSeparator ? args.slice(1) : [...args];
  const commandOffset = conv.stripLeadingSeparator ? conv.commandIndex - 1 : conv.commandIndex;
  const result = source.slice(0, commandOffset + 1);
  for (let i = commandOffset + 1; i < source.length; i += 1) {
    const token = source[i]!;
    if (token === "--") {
      result.push(...source.slice(i));
      break;
    }
    if (CONVERSATION_VALUE_OPTIONS.has(token) && i + 1 < source.length) {
      result.push(`${token}=${source[i + 1]!}`);
      i += 1;
      continue;
    }
    result.push(token);
  }
  return result;
}

/** Shared by process discovery and the entry's recorder lifetime. Unknown argv never proves compatibility. */
export function cliLoggingMode(args: readonly string[]): "recorder" | "host" | "policy" | "none" | "unknown" {
  const command = args[0];
  if (command === undefined) return "recorder";
  // Queries do not own an observation writer: registering one would itself
  // disturb migration and require shutdown writes for a read-only operation.
  if (command === "workspace" && ["status", "list"].includes(args[1] ?? "")) return "none";
  if (command === "backup" && args[1] === "status") return "none";
  if (["backup", "workspace", "pair"].includes(command)) return "recorder";
  if (command === "serve") return args[1] === "logs" ? "none" : "host";
  if (command === "logs") return args.some(arg => arg === "--set" || arg.startsWith("--set=")) ? "policy" : "none";
  if (["status", "stop", "doctor", "app", "device", "duty", "conversation", "help", "--help", "-h", "--version", "-V"].includes(command)) return "none";
  return "unknown";
}

/** Commander accepts both forms and the last supplied value wins. */
export function managedHomeArgument(args: readonly string[]): string | undefined {
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") break;
    if (args[i] === "--managed-home") home = args[++i];
    else if (args[i]?.startsWith("--managed-home=")) home = args[i]!.slice(15);
  }
  return home;
}
