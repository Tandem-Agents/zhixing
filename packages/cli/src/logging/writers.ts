import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { LogWriterObservation } from "@zhixing/core/logging/storage";

const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LogProbeArgv { [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr pointer); }'
$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'node'" | Select-Object -First 257)
$complete = $rows.Count -le 256
$candidates = @()
$self = $null
function Test-ProductEntry([string]$value) {
  $entry = $value.Replace('\','/')
  return ($entry -match '(?i)(?:^|/)(?:packages/cli/(?:src/index[.]ts|dist/index[.]js)|node_modules/@zhixing/cli/dist/index[.]js)$' -or $entry -match '^(?:[.]/)?(?:src/index[.]ts|dist/index[.]js)$')
}
foreach ($row in $rows) {
  if ($candidates.Count -ge 256) { $complete = $false; break }
  $birth = ([DateTime]$row.CreationDate).ToUniversalTime().Ticks.ToString()
  $identity = @{ pid = [int]$row.ProcessId; birth = $birth }
  if ($row.ProcessId -eq [int]$env:ZHIXING_LOG_PROBE_SELF) { $self = $identity; $candidates += $identity; continue }
  if (-not $row.CommandLine) { $complete = $false; continue }
  $count = 0
  $memory = [LogProbeArgv]::CommandLineToArgvW($row.CommandLine, [ref]$count)
  if ($memory -eq [IntPtr]::Zero -or $count -gt 1024) { $complete = $false; if ($memory -ne [IntPtr]::Zero) { [void][LogProbeArgv]::LocalFree($memory) }; continue }
  try {
    $argv = @()
    for ($i = 0; $i -lt $count; $i++) { $argv += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $i * [IntPtr]::Size)) }
  } finally { [void][LogProbeArgv]::LocalFree($memory) }
  $index = 1
  $uncertain = $false
  while ($index -lt $argv.Count -and $argv[$index].StartsWith('-')) {
    $flag = $argv[$index]
    if ($flag -eq '--') { $index++; break }
    if ($flag -in @('-e','--eval','-p','--print')) { $index = $argv.Count; break }
    if ($flag -in @('--import','--require','-r','--loader','--conditions','--title')) { $index += 2 }
    elseif ($flag.Contains('=') -or $flag -in @('--no-warnings','--enable-source-maps','--trace-warnings')) { $index++ }
    else { $uncertain = $true; break }
  }
  if ($uncertain) {
    # Unknown option arity must not hide a product entry or enable guessed tail exclusions.
    for ($scan = $index + 1; $scan -lt $argv.Count; $scan++) {
      if (Test-ProductEntry $argv[$scan]) { $candidates += $identity; break }
    }
    continue
  }
  if ($index -ge $argv.Count) { continue }
  if (-not (Test-ProductEntry $argv[$index])) { continue }
  $rest = @($argv | Select-Object -Skip ($index + 1))
  # The top-level logs query was introduced as read-only. Historical serve logs was not.
  if ($rest.Count -gt 0 -and $rest[0] -eq 'logs' -and $rest -notcontains 'policy') { continue }
  $managed = [Array]::IndexOf($rest, '--managed-home')
  if ($managed -ge 0 -and $managed + 1 -lt $rest.Count -and [IO.Path]::IsPathRooted($rest[$managed + 1])) {
    if (-not [String]::Equals([IO.Path]::GetFullPath($rest[$managed + 1]).TrimEnd('\'), $env:ZHIXING_LOG_PROBE_HOME.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { continue }
  }
  $candidates += $identity
}
@{ complete = ($complete -and $null -ne $self); self = $self; candidates = @($candidates) } | ConvertTo-Json -Depth 4 -Compress
`;

/** No raw command line or environment leaves the finite platform observation. */
export function createLogWriterProbe(home: string): (signal?: AbortSignal) => Promise<LogWriterObservation> {
  let cached: LogWriterObservation | undefined;
  return async (signal) => {
    signal?.throwIfAborted();
    if (cached && Date.now() - cached.at < 1000) return cached;
    try {
      const result = process.platform === "win32" ? await windows(home, signal) : await isolatedPosix(home, signal);
      cached = { ...result, at: Date.now() };
    } catch { cached = { complete: false, at: Date.now(), candidates: [] }; }
    return cached;
  };
}
async function windows(home: string, signal?: AbortSignal): Promise<Omit<LogWriterObservation, "at">> {
  const value = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsProbe, "utf16le").toString("base64")], {
    ...process.env,
    ZHIXING_LOG_PROBE_HOME: path.resolve(home), ZHIXING_LOG_PROBE_SELF: String(process.pid),
  }, signal);
  const result = JSON.parse(value) as Omit<LogWriterObservation, "at">;
  return { ...result, ...(result.self ? { self: result.self } : { self: undefined }) };
}
function execute(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { signal, windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024, encoding: "utf8", env }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

async function isolatedPosix(home: string, signal?: AbortSignal): Promise<Omit<LogWriterObservation, "at">> {
  const built = fileURLToPath(new URL("./logging-writers-worker.js", import.meta.url));
  const args = existsSync(built) ? [built] : ["--import=tsx/esm", fileURLToPath(new URL("./logging-writers-worker.ts", import.meta.url))];
  return JSON.parse(await execute(process.execPath, [...args, home, String(process.pid)], process.env, signal));
}
