import { execFile } from "node:child_process";

const CLIPBOARD_TIMEOUT_MS = 1500;
const CLIPBOARD_MAX_BUFFER = 16 * 1024 * 1024;

export interface ClipboardTextProvider {
  readText(): Promise<string | null>;
}

type ClipboardCommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<string>;

export function createSystemClipboardProvider(
  platform: NodeJS.Platform = process.platform,
  runCommand: ClipboardCommandRunner = execFileText,
): ClipboardTextProvider {
  return {
    async readText(): Promise<string | null> {
      const text = await readClipboardText(platform, runCommand);
      return text.length > 0 ? text : null;
    },
  };
}

async function readClipboardText(
  platform: NodeJS.Platform,
  runCommand: ClipboardCommandRunner,
): Promise<string> {
  if (platform === "win32") {
    return readFirstAvailable([
      {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
            "[Console]::Out.Write((Get-Clipboard -Raw))",
          ].join("; "),
        ],
      },
      {
        file: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
            "$value = Get-Clipboard",
            "if ($null -ne $value) { [Console]::Out.Write(($value -join [Environment]::NewLine)) }",
          ].join("; "),
        ],
      },
    ], runCommand);
  }
  if (platform === "darwin") {
    return readFirstAvailable([{ file: "pbpaste", args: [] }], runCommand);
  }
  return readFirstAvailable([
    { file: "wl-paste", args: [] },
    { file: "xclip", args: ["-selection", "clipboard", "-out"] },
    { file: "xsel", args: ["--clipboard", "--output"] },
  ], runCommand);
}

async function readFirstAvailable(
  candidates: readonly { file: string; args: readonly string[] }[],
  runCommand: ClipboardCommandRunner,
): Promise<string> {
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await runCommand(candidate.file, candidate.args);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: CLIPBOARD_MAX_BUFFER,
        timeout: CLIPBOARD_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
