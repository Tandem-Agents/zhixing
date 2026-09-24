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
  if (command === "logs") return args[1] === "policy" && args.some(arg => arg === "--set" || arg.startsWith("--set=")) ? "policy" : "none";
  if (["status", "stop", "doctor", "app", "device", "duty", "help", "--help", "-h", "--version", "-V"].includes(command)) return "none";
  return "unknown";
}
