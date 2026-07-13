import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { EncryptedVaultSecretStore } from "./vault-secret-store.js";
import type { MasterKeyProvider, MasterKeyState } from "./master-key.js";
import { acquireFileLock } from "./file-lock.js";

const KEY_BYTES = 32;
const KEYRING_SERVICE = "dev.zhixing.secret-vault";
const COMMAND_TIMEOUT_MS = 10_000;
const MACOS_SECURITY_COMMAND = "/usr/bin/security";
const LINUX_SECRET_TOOL_COMMAND = "/usr/bin/secret-tool";
const SECRET_STORE_FILE_PREFIX = "secret-vault";

export interface PlatformSecretStoreOptions {
  readonly homeDir: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly commandRunner?: CommandRunner;
  /** 受管无头宿主提供的稳定机器身份；常规 Linux 主机自动读取 machine-id。 */
  readonly machineIdentity?: string;
}

/**
 * 返回平台 SecretStore 在本机文件系统上的完整秘密文件族前缀。
 *
 * `secret-vault` 同时覆盖加密 vault、平台密钥封装、初始化锁、读写锁和原子写
 * 临时文件；系统钥匙串中的主密钥不属于文件路径，由命令安全规则独立隔离。
 */
export function getPlatformSecretStoreProtectedPaths(
  homeDir: string,
): readonly string[] {
  if (!path.isAbsolute(homeDir)) {
    throw new TypeError("SecretStore home directory must be absolute");
  }
  return [path.join(path.resolve(homeDir), SECRET_STORE_FILE_PREFIX)];
}

interface CommandResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: Uint8Array,
) => Promise<CommandResult>;

export function createPlatformSecretStore(
  options: PlatformSecretStoreOptions,
): EncryptedVaultSecretStore {
  if (!path.isAbsolute(options.homeDir)) {
    throw new TypeError("SecretStore home directory must be absolute");
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.commandRunner ?? runCommand;
  const keyPath = path.join(options.homeDir, `${SECRET_STORE_FILE_PREFIX}.key`);
  const vaultPath = path.join(options.homeDir, `${SECRET_STORE_FILE_PREFIX}.json`);
  let masterKey: MasterKeyProvider;
  if (platform === "win32") {
    masterKey = new WindowsDpapiMasterKeyProvider(keyPath, run);
  } else if (platform === "darwin") {
    masterKey = new MacKeychainMasterKeyProvider(
      keyringAccount(options.homeDir),
      vaultPath,
      run,
    );
  } else if (platform === "linux" && hasDesktopSession(env)) {
    masterKey = new LinuxSecretServiceMasterKeyProvider(
      keyringAccount(options.homeDir),
      vaultPath,
      run,
    );
  } else {
    masterKey = new MachineBoundMasterKeyProvider(
      keyPath,
      platform,
      options.machineIdentity,
    );
  }
  masterKey = new SerializedMasterKeyProvider(masterKey, `${keyPath}.init.lock`);
  return new EncryptedVaultSecretStore({
    vaultPath,
    masterKey,
  });
}

class SerializedMasterKeyProvider implements MasterKeyProvider {
  private cached?: Buffer;

  constructor(
    private readonly delegate: MasterKeyProvider,
    private readonly lockPath: string,
  ) {}

  async state(): Promise<MasterKeyState> {
    try {
      const key = await this.loadOrCreate();
      key.fill(0);
      return "unlocked";
    } catch {
      return "unavailable";
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    if (this.cached) return Buffer.from(this.cached);
    const release = await acquireFileLock(this.lockPath, {
      staleMs: 30_000,
      waitMs: 15_000,
    });
    try {
      if (!this.cached) this.cached = await this.delegate.loadOrCreate();
      return Buffer.from(this.cached);
    } finally {
      await release();
    }
  }
}

class WindowsDpapiMasterKeyProvider implements MasterKeyProvider {
  private cached?: Buffer;
  constructor(
    private readonly keyPath: string,
    private readonly run: CommandRunner,
  ) {}

  async state(): Promise<MasterKeyState> {
    try {
      const key = await this.loadOrCreate();
      key.fill(0);
      return "unlocked";
    } catch {
      return "unavailable";
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    if (this.cached) return Buffer.from(this.cached);
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    await cleanupPrivateFileTemps(this.keyPath);
    const existing = await readFile(this.keyPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (existing) {
      const result = await this.runPowerShell("unprotect", existing);
      if (result.code !== 0) {
        result.stdout.fill(0);
        throw new Error("Windows credential protection could not unlock SecretStore");
      }
      try {
        this.cached = decodeKey(result.stdout.toString("utf8").trim());
      } finally {
        result.stdout.fill(0);
      }
      return Buffer.from(this.cached);
    }
    const key = randomBytes(KEY_BYTES);
    const encodedKey = Buffer.from(key.toString("base64url"), "utf8");
    try {
      const result = await this.runPowerShell("protect", encodedKey);
      if (result.code !== 0 || result.stdout.byteLength === 0) {
        throw new Error("Windows credential protection could not initialize SecretStore");
      }
      await writePrivateFile(this.keyPath, result.stdout);
      this.cached = Buffer.from(key);
      return Buffer.from(this.cached);
    } finally {
      encodedKey.fill(0);
      key.fill(0);
    }
  }

  private runPowerShell(
    mode: "probe" | "protect" | "unprotect",
    input?: Uint8Array,
  ): Promise<CommandResult> {
    const script = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
      `if ('${mode}' -eq 'probe') { [Console]::Out.Write('ok'); exit 0 }`,
      "$stdin=[Console]::OpenStandardInput()",
      "$memory=New-Object IO.MemoryStream",
      "$stdin.CopyTo($memory)",
      "$bytes=$memory.ToArray()",
      `if ('${mode}' -eq 'protect') {`,
      "  $plain=[Convert]::FromBase64String(([Text.Encoding]::UTF8.GetString($bytes)).Replace('-','+').Replace('_','/').PadRight(([Math]::Ceiling($bytes.Length/4.0)*4),'='))",
      "  $output=[Security.Cryptography.ProtectedData]::Protect($plain,$null,$scope)",
      "} else {",
      "  $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)",
      "  $output=[Text.Encoding]::UTF8.GetBytes(([Convert]::ToBase64String($plain).TrimEnd('=').Replace('+','-').Replace('/','_')))",
      "}",
      "$stdout=[Console]::OpenStandardOutput()",
      "$stdout.Write($output,0,$output.Length)",
    ].join(";");
    return this.run(windowsPowerShellCommand(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], input);
  }
}

class LinuxSecretServiceMasterKeyProvider implements MasterKeyProvider {
  private cached?: Buffer;
  constructor(
    private readonly account: string,
    private readonly vaultPath: string,
    private readonly run: CommandRunner,
  ) {}

  async state(): Promise<MasterKeyState> {
    try {
      const key = await this.loadOrCreate();
      key.fill(0);
      return "unlocked";
    } catch {
      return "unavailable";
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    if (this.cached) return Buffer.from(this.cached);
    const lookup = await this.run(LINUX_SECRET_TOOL_COMMAND, ["lookup", "service", KEYRING_SERVICE, "account", this.account]);
    if (lookup.code === 0 && lookup.stdout.toString("utf8").trim()) {
      try {
        this.cached = decodeKey(lookup.stdout.toString("utf8").trim());
      } finally {
        lookup.stdout.fill(0);
      }
      return Buffer.from(this.cached);
    }
    lookup.stdout.fill(0);
    if (await fileExists(this.vaultPath)) {
      throw new Error("Linux Secret Service could not unlock the existing SecretStore");
    }
    const key = randomBytes(KEY_BYTES);
    const encoded = Buffer.from(`${key.toString("base64url")}\n`, "utf8");
    try {
      const stored = await this.run(
        LINUX_SECRET_TOOL_COMMAND,
        ["store", "--label", "Zhixing SecretStore", "service", KEYRING_SERVICE, "account", this.account],
        encoded,
      );
      if (stored.code !== 0) throw new Error("Linux Secret Service could not initialize SecretStore");
      this.cached = Buffer.from(key);
      return Buffer.from(this.cached);
    } finally {
      encoded.fill(0);
      key.fill(0);
    }
  }
}

class MacKeychainMasterKeyProvider implements MasterKeyProvider {
  private cached?: Buffer;
  constructor(
    private readonly account: string,
    private readonly vaultPath: string,
    private readonly run: CommandRunner,
  ) {}

  async state(): Promise<MasterKeyState> {
    try {
      const key = await this.loadOrCreate();
      key.fill(0);
      return "unlocked";
    } catch {
      return "unavailable";
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    if (this.cached) return Buffer.from(this.cached);
    const lookup = await this.lookup();
    if (lookup.code === 0 && lookup.stdout.toString("utf8").trim()) {
      try {
        this.cached = decodeKey(lookup.stdout.toString("utf8").trim());
      } finally {
        lookup.stdout.fill(0);
      }
      return Buffer.from(this.cached);
    }
    lookup.stdout.fill(0);
    if (await fileExists(this.vaultPath)) {
      throw new Error("macOS Keychain could not unlock the existing SecretStore");
    }
    const key = randomBytes(KEY_BYTES);
    try {
      const stored = await this.run(MACOS_SECURITY_COMMAND, [
        "add-generic-password",
        "-U",
        "-a",
        this.account,
        "-s",
        KEYRING_SERVICE,
        "-w",
        key.toString("base64url"),
      ]);
      if (stored.code !== 0) throw new Error("macOS Keychain could not initialize SecretStore");
      this.cached = Buffer.from(key);
      return Buffer.from(this.cached);
    } finally {
      key.fill(0);
    }
  }

  private lookup(): Promise<CommandResult> {
    return this.run(MACOS_SECURITY_COMMAND, [
      "find-generic-password",
      "-a",
      this.account,
      "-s",
      KEYRING_SERVICE,
      "-w",
    ]);
  }
}

class MachineBoundMasterKeyProvider implements MasterKeyProvider {
  private cached?: Buffer;
  constructor(
    private readonly seedPath: string,
    private readonly platform: NodeJS.Platform,
    private readonly configuredMachineIdentity?: string,
  ) {}

  async state(): Promise<MasterKeyState> {
    try {
      const key = await this.loadOrCreate();
      key.fill(0);
      return "unlocked";
    } catch {
      return "unavailable";
    }
  }

  async loadOrCreate(): Promise<Buffer> {
    if (this.cached) return Buffer.from(this.cached);
    await mkdir(path.dirname(this.seedPath), { recursive: true, mode: 0o700 });
    await cleanupPrivateFileTemps(this.seedPath);
    const binding = await machineBinding(
      this.platform,
      this.configuredMachineIdentity,
    );
    let seed = await readFile(this.seedPath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    });
    if (!seed) {
      seed = randomBytes(KEY_BYTES);
      await writePrivateFile(this.seedPath, seed);
    }
    if (seed.byteLength !== KEY_BYTES) throw new Error("Machine SecretStore seed is invalid");
    try {
      this.cached = createHash("sha256")
        .update("zhixing-machine-secret-vault:v1\0")
        .update(binding)
        .update("\0")
        .update(seed)
        .digest();
      return Buffer.from(this.cached);
    } finally {
      seed.fill(0);
    }
  }
}

function hasDesktopSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.XDG_CURRENT_DESKTOP);
}

function keyringAccount(homeDir: string): string {
  return `vault:${createHash("sha256").update(path.resolve(homeDir), "utf8").digest("hex")}`;
}

async function machineBinding(
  platform: NodeJS.Platform,
  configuredMachineIdentity?: string,
): Promise<string> {
  const user = userInfo();
  let machineId = configuredMachineIdentity;
  if (machineId !== undefined && !isStableMachineIdentity(machineId)) {
    throw new Error("Configured SecretStore machine identity is invalid");
  }
  if (machineId === undefined && platform === "linux") {
    for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      const value = await readFile(candidate, "utf8").catch(() => "");
      if (/^[a-f0-9]{32}$/iu.test(value.trim())) {
        machineId = value.trim().toLowerCase();
        break;
      }
    }
  }
  if (machineId === undefined) {
    throw new Error("Stable machine identity is unavailable for SecretStore");
  }
  return `${platform}\0${machineId}\0${user.uid ?? user.username}`;
}

function isStableMachineIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("SecretStore master key is not canonical");
  const key = Buffer.from(value, "base64url");
  if (key.byteLength !== KEY_BYTES || key.toString("base64url") !== value) {
    key.fill(0);
    throw new Error("SecretStore master key is invalid");
  }
  return key;
}

async function writePrivateFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await link(temporary, filePath);
    await unlink(temporary);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupPrivateFileTemps(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const entries = await readdir(directory).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  let removed = false;
  for (const entry of entries) {
    if (
      entry.startsWith(`${fileName}.`) &&
      /^\d+\.[a-f0-9]{12}\.tmp$/u.test(entry.slice(fileName.length + 1))
    ) {
      await rm(path.join(directory, entry), { force: true });
      removed = true;
    }
  }
  if (removed) await syncDirectory(directory);
}

function runCommand(
  command: string,
  args: readonly string[],
  input?: Uint8Array,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      env: sanitizedCredentialCommandEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      clearChunks(stdout);
      clearChunks(stderr);
      reject(new Error(`SecretStore credential command timed out: ${command}`));
    }, COMMAND_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearChunks(stdout);
      clearChunks(stderr);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutResult = Buffer.concat(stdout);
      const stderrResult = Buffer.concat(stderr);
      clearChunks(stdout);
      clearChunks(stderr);
      resolve({
        code: code ?? -1,
        stdout: stdoutResult,
        stderr: stderrResult,
      });
    });
    child.stdin.end(input);
  });
}

function clearChunks(chunks: Buffer[]): void {
  for (const chunk of chunks) chunk.fill(0);
  chunks.length = 0;
}

function windowsPowerShellCommand(): string {
  const systemRoot = process.env.SystemRoot;
  const trustedRoot = systemRoot && path.win32.isAbsolute(systemRoot)
    ? systemRoot
    : "C:\\Windows";
  return path.win32.join(
    trustedRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function sanitizedCredentialCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
  ]) {
    delete env[name];
  }
  return env;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync().catch((error: unknown) => {
      if (process.platform === "win32" && (isNodeError(error, "EPERM") || isNodeError(error, "EINVAL"))) {
        return;
      }
      throw error;
    });
  } finally {
    await directory.close();
  }
}
