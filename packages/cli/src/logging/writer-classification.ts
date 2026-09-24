import path from "node:path";
import { cliLoggingMode } from "./entry-mode.js";

/** Unknown Node option arity must never enable guessed home/read-only exclusions. */
export function isProductLogWriter(argv: readonly string[], home: string, windows = false): boolean {
  const entry = (value: string): boolean => {
    const normalized = windows ? value.replaceAll("\\", "/").toLowerCase() : value;
    return /(?:^|\/)(?:packages\/cli\/(?:src\/index\.ts|dist\/index\.js)|node_modules\/@zhixing\/cli\/dist\/index\.js)$/u.test(normalized)
      || /^(?:[.]\/)?(?:src\/index\.ts|dist\/index\.js)$/u.test(normalized);
  };
  let index = 1;
  while (argv[index]?.startsWith("-")) {
    const flag = argv[index]!;
    if (flag === "--") { index++; break; }
    if (["-e", "--eval", "-p", "--print"].includes(flag)) return false;
    if (["--import", "--require", "-r", "--loader", "--conditions", "--title"].includes(flag)) index += 2;
    else if (flag.includes("=") || ["--no-warnings", "--enable-source-maps", "--trace-warnings"].includes(flag)) index++;
    else return argv.slice(index + 1).some(entry);
  }
  if (!entry(argv[index] ?? "")) return false;
  const args = argv.slice(index + 1);
  if (cliLoggingMode(args) === "none") return false;
  const managed = args.indexOf("--managed-home"), paths = windows ? path.win32 : path.posix;
  const normalize = (value: string): string => windows ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  if (managed >= 0 && paths.isAbsolute(args[managed + 1] ?? "") && normalize(args[managed + 1]!) !== normalize(home)) return false;
  return true;
}
