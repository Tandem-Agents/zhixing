import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

export type ProcessIdentityReading =
  | { readonly kind: "present"; readonly birth: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/** Narrow, read-only process identity projection used only by FileLock. */
export interface ProcessIdentityResolver {
  readonly read: (pid: number) => Promise<ProcessIdentityReading>;
}

export interface ProcessIdentityResolverDeps {
  readonly platform?: NodeJS.Platform;
  readonly readFile?: typeof readFile;
  readonly execFileSync?: typeof execFileSync;
  readonly probe?: (pid: number) => "present" | "absent" | "unknown";
}

export function createProcessIdentityResolver(
  deps: ProcessIdentityResolverDeps = {},
): ProcessIdentityResolver {
  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? readFile;
  const exec = deps.execFileSync ?? execFileSync;
  const probe = deps.probe ?? probeProcess;
  let current: Promise<ProcessIdentityReading> | undefined;

  const resolve = async (pid: number): Promise<ProcessIdentityReading> => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
    const presence = probe(pid);
    if (presence !== "present") return { kind: presence };
    try {
      const birth = platform === "linux"
        ? await linuxBirth(pid, read)
        : platform === "darwin"
          ? macosBirth(pid, exec)
          : platform === "win32"
            ? windowsBirth(pid, exec)
            : undefined;
      return birth === undefined ? afterReadFailure(pid, probe) : { kind: "present", birth };
    } catch {
      return afterReadFailure(pid, probe);
    }
  };

  return {
    read(pid) {
      if (pid !== process.pid) return resolve(pid);
      current ??= resolve(pid).then((reading) => {
        if (reading.kind !== "present") current = undefined;
        return reading;
      });
      return current;
    },
  };
}

function probeProcess(pid: number): "present" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

function afterReadFailure(
  pid: number,
  probe: (pid: number) => "present" | "absent" | "unknown",
): ProcessIdentityReading {
  return probe(pid) === "absent" ? { kind: "absent" } : { kind: "unknown" };
}

async function linuxBirth(pid: number, read: typeof readFile): Promise<string | undefined> {
  const [statText, bootIdText] = await Promise.all([
    read(`/proc/${pid}/stat`, "utf8"),
    read("/proc/sys/kernel/random/boot_id", "utf8"),
  ]);
  const close = statText.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = statText.slice(close + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  const bootId = bootIdText.trim().toLowerCase();
  if (!/^[0-9]+$/u.test(startTicks ?? "") || !/^[a-f0-9-]{36}$/u.test(bootId)) return undefined;
  return `linux:${bootId}:${startTicks}`;
}

function macosBirth(pid: number, exec: typeof execFileSync): string | undefined {
  const output = exec("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
  }).trim().replace(/\s+/gu, " ");
  return output ? `darwin:${output}` : undefined;
}

function windowsBirth(pid: number, exec: typeof execFileSync): string | undefined {
  const output = exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
  ).trim();
  return /^[0-9]+$/u.test(output) ? `win32:${output}` : undefined;
}
