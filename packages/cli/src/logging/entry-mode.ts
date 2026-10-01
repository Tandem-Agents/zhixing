/** pnpm forwards one standalone separator; entry, Commander and discovery share this rule. */
export function normalizeCliArgs(args: readonly string[]): string[] {
  const normalized = [...args], index = normalized.indexOf("--");
  if (index !== -1) normalized.splice(index, 1);
  return normalized;
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
  if (["status", "stop", "doctor", "app", "device", "duty", "help", "--help", "-h", "--version", "-V"].includes(command)) return "none";
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
