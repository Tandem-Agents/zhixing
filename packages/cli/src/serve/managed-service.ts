import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { PlatformSecretStoreBackend } from "@zhixing/secrets";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export type ManagedServicePlatform = "win32" | "darwin" | "linux";
export type ManagedServiceStartup = "login" | "boot";

export interface ManagedServiceSpec {
  readonly platform: ManagedServicePlatform;
  readonly serviceId: string;
  readonly zhixingHome: string;
  readonly backend: PlatformSecretStoreBackend;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly definitionPath: string;
  readonly definition: string;
  readonly startup: ManagedServiceStartup;
  readonly osUser: string;
  readonly uid?: number;
}

export interface ManagedServiceInspection {
  readonly state: "absent" | "disabled" | "enabled";
  readonly running: boolean;
  readonly matches: boolean;
}

export interface ManagedServiceAdapter {
  inspect(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
  install(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
  disable(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
  start(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
}

export type ManagedServiceErrorCode =
  | "aborted"
  | "command-timeout"
  | "command-failed"
  | "definition-drift"
  | "read-back-failed"
  | "unsupported-platform";

export class ManagedServiceError extends Error {
  constructor(
    readonly code: ManagedServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedServiceError";
  }
}

export interface BuildManagedServiceSpecInput {
  readonly platform: NodeJS.Platform;
  readonly zhixingHome: string;
  readonly backend: PlatformSecretStoreBackend;
  readonly execPath: string;
  readonly entryScript: string;
  readonly osUser: string;
  readonly userHome: string;
  readonly uid?: number;
  readonly headless?: boolean;
}

export function buildManagedServiceSpec(
  input: BuildManagedServiceSpecInput,
): ManagedServiceSpec {
  if (input.platform !== "win32" && input.platform !== "darwin" && input.platform !== "linux") {
    throw new ManagedServiceError("unsupported-platform", "Managed host is unavailable on this platform");
  }
  const zhixingHome = canonicalAbsolutePath(input.zhixingHome, input.platform);
  const command = canonicalAbsolutePath(input.execPath, input.platform);
  const entryScript = canonicalAbsolutePath(input.entryScript, input.platform);
  const userHome = canonicalAbsolutePath(input.userHome, input.platform);
  if (!input.osUser || /[\u0000-\u001f\u007f]/u.test(input.osUser)) {
    throw new TypeError("Managed service OS user is invalid");
  }
  const serviceId = `dev.zhixing.host.${createHash("sha256")
    .update(`${input.osUser}\0${zhixingHome}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  const args = Object.freeze([
    entryScript,
    "serve",
    "--managed",
    "--managed-home",
    zhixingHome,
    "--managed-secret-backend",
    input.backend,
  ]);
  const environment = Object.freeze({
    ZHIXING_HOME: zhixingHome,
    ZHIXING_SECRET_BACKEND: input.backend,
    NO_COLOR: "1",
  });
  const startup: ManagedServiceStartup = input.platform === "linux" && input.headless
    ? "boot"
    : "login";
  if (startup === "boot" && input.backend !== "machine-bound") {
    throw new ManagedServiceError(
      "read-back-failed",
      "A headless managed host requires a machine-bound SecretStore",
    );
  }
  if (input.platform !== "win32" && input.uid === undefined) {
    throw new TypeError("Managed service requires the current numeric user id on this platform");
  }
  const definitionPath = input.platform === "win32"
    ? path.win32.join(zhixingHome, "distributed-runtime", "managed-service", `${serviceId}.xml`)
    : input.platform === "darwin"
      ? path.posix.join(userHome, "Library", "LaunchAgents", `${serviceId}.plist`)
      : path.posix.join(userHome, ".config", "systemd", "user", `${serviceId}.service`);
  const base = {
    platform: input.platform,
    serviceId,
    zhixingHome,
    backend: input.backend,
    command,
    args,
    environment,
    definitionPath,
    startup,
    osUser: input.osUser,
    ...(input.uid === undefined ? {} : { uid: input.uid }),
  };
  return Object.freeze({
    ...base,
    definition: renderManagedServiceDefinition(base),
  });
}

export function applyManagedServiceLaunchContext(input: {
  readonly managed?: boolean;
  readonly home?: string;
  readonly backend?: string;
}): void {
  const hasHome = input.home !== undefined;
  const hasBackend = input.backend !== undefined;
  if (input.managed !== true) {
    if (hasHome || hasBackend) {
      throw new TypeError("Managed service context requires managed launch mode");
    }
    return;
  }
  if (hasHome !== hasBackend) {
    throw new TypeError("Managed service home and SecretStore backend must be supplied together");
  }
  process.env.ZHIXING_MANAGED = "1";
  if (!hasHome || !hasBackend) return;
  if (!isPlatformSecretStoreBackend(input.backend)) {
    throw new TypeError("Managed service SecretStore backend is invalid");
  }
  process.env.ZHIXING_HOME = canonicalAbsolutePath(input.home!, process.platform);
  process.env.ZHIXING_SECRET_BACKEND = input.backend;
}

interface ManagedServiceCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ManagedServiceCommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
) => Promise<ManagedServiceCommandResult>;

export function createManagedServiceAdapter(options: {
  readonly platform?: NodeJS.Platform;
  readonly commandRunner?: ManagedServiceCommandRunner;
  readonly storageGovernor?: StorageMaintenanceGovernorPort;
  readonly commandTimeoutMs?: number;
} = {}): ManagedServiceAdapter {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new ManagedServiceError("unsupported-platform", "Managed host is unavailable on this platform");
  }
  return new NodeManagedServiceAdapter(
    platform,
    options.commandRunner ?? runManagedServiceCommand,
    options.storageGovernor,
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  );
}

class NodeManagedServiceAdapter implements ManagedServiceAdapter {
  constructor(
    private readonly platform: ManagedServicePlatform,
    private readonly run: ManagedServiceCommandRunner,
    private readonly storageGovernor: StorageMaintenanceGovernorPort | undefined,
    private readonly timeoutMs: number,
  ) {}

  async inspect(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    throwIfAborted(signal);
    const stored = await readFile(spec.definitionPath, "utf8").catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    const manager = await this.inspectManager(spec, signal);
    if (stored === undefined) {
      return manager.state === "absent"
        ? { state: "absent", running: false, matches: true }
        : { ...manager, matches: false };
    }
    return {
      ...manager,
      matches: stored === spec.definition && manager.matches,
    };
  }

  async install(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state !== "absent" && !before.matches) {
      throw new ManagedServiceError("definition-drift", "Existing managed service belongs to another installation");
    }
    if (before.state === "absent") {
      await runWithMaintenanceUrgency(() => "recovery", signal, async () => {
        await runStorageMaintenanceStep(
          this.storageGovernor,
          storageMaintenanceRequest(
            "managed-service-reconcile",
            spec.serviceId,
            definitionDigest(spec),
            { obligation: "pre-commit", maxWaitMs: 5_000 },
          ),
          () => writeDefinition(spec.definitionPath, spec.definition, signal),
        );
      });
    }
    await this.installManager(spec, signal);
    const after = await this.inspect(spec, signal);
    if (after.state !== "enabled" || !after.matches) {
      throw new ManagedServiceError("read-back-failed", "Managed service installation could not be verified");
    }
    return after;
  }

  async disable(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state === "absent") return before;
    if (!before.matches) {
      throw new ManagedServiceError("definition-drift", "Existing managed service belongs to another installation");
    }
    await this.disableManager(spec, signal);
    const after = await this.inspect(spec, signal);
    if (after.state === "enabled" || after.running) {
      throw new ManagedServiceError("read-back-failed", "Managed service disable could not be verified");
    }
    return after;
  }

  async start(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state !== "enabled" || !before.matches) {
      throw new ManagedServiceError("read-back-failed", "Managed service is not installed and enabled");
    }
    const result = await this.command(startCommand(spec), signal);
    if (result.code !== 0) {
      throw new ManagedServiceError("command-failed", "Managed service could not be started");
    }
    const after = await this.inspect(spec, signal);
    if (!after.running) {
      throw new ManagedServiceError("read-back-failed", "Managed service start could not be verified");
    }
    return after;
  }

  private assertSpec(spec: ManagedServiceSpec): void {
    if (spec.platform !== this.platform || spec.definition !== renderManagedServiceDefinition(spec)) {
      throw new ManagedServiceError("definition-drift", "Managed service specification is not canonical");
    }
  }

  private async inspectManager(
    spec: ManagedServiceSpec,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection> {
    if (this.platform === "win32") {
      const query = await this.command({
        command: "schtasks.exe",
        args: ["/Query", "/TN", spec.serviceId, "/XML"],
      }, signal);
      if (query.code !== 0) return { state: "absent", running: false, matches: true };
      const enabled = !/<Enabled>false<\/Enabled>/iu.test(query.stdout);
      const status = await this.command({
        command: "schtasks.exe",
        args: ["/Query", "/TN", spec.serviceId, "/FO", "CSV", "/NH"],
      }, signal);
      return {
        state: enabled ? "enabled" : "disabled",
        running: status.code === 0 && /running/iu.test(status.stdout),
        matches: normalizeXml(query.stdout) === normalizeXml(spec.definition),
      };
    }
    if (this.platform === "darwin") {
      const domain = `gui/${spec.uid ?? 0}`;
      const printed = await this.command({
        command: "/bin/launchctl",
        args: ["print", `${domain}/${spec.serviceId}`],
      }, signal);
      if (printed.code !== 0) return { state: "absent", running: false, matches: true };
      const disabled = await this.command({
        command: "/bin/launchctl",
        args: ["print-disabled", domain],
      }, signal);
      const isDisabled = new RegExp(`"${escapeRegExp(spec.serviceId)}"\\s*=>\\s*true`, "u")
        .test(disabled.stdout);
      return {
        state: isDisabled ? "disabled" : "enabled",
        running: /\bpid\s*=\s*\d+/u.test(printed.stdout),
        matches: true,
      };
    }
    const enabled = await this.command({
      command: "systemctl",
      args: ["--user", "is-enabled", spec.serviceId],
    }, signal);
    if (enabled.code !== 0 && enabled.stdout.trim() !== "disabled") {
      return { state: "absent", running: false, matches: true };
    }
    const active = await this.command({
      command: "systemctl",
      args: ["--user", "is-active", spec.serviceId],
    }, signal);
    return {
      state: enabled.stdout.trim() === "enabled" ? "enabled" : "disabled",
      running: active.code === 0 && active.stdout.trim() === "active",
      matches: true,
    };
  }

  private async installManager(spec: ManagedServiceSpec, signal: AbortSignal): Promise<void> {
    if (this.platform === "win32") {
      await this.requireCommand({
        command: "schtasks.exe",
        args: ["/Create", "/TN", spec.serviceId, "/XML", spec.definitionPath, "/F"],
      }, signal);
      return;
    }
    if (this.platform === "darwin") {
      const domain = `gui/${spec.uid ?? 0}`;
      const bootstrapped = await this.command({
        command: "/bin/launchctl",
        args: ["bootstrap", domain, spec.definitionPath],
      }, signal);
      if (bootstrapped.code !== 0) {
        const current = await this.inspectManager(spec, signal);
        if (current.state === "absent") {
          throw new ManagedServiceError("command-failed", "Managed service could not be installed");
        }
      }
      await this.requireCommand({
        command: "/bin/launchctl",
        args: ["enable", `${domain}/${spec.serviceId}`],
      }, signal);
      return;
    }
    if (spec.startup === "boot") {
      await this.requireCommand({
        command: "loginctl",
        args: ["enable-linger", spec.osUser],
      }, signal);
    }
    await this.requireCommand({ command: "systemctl", args: ["--user", "daemon-reload"] }, signal);
    await this.requireCommand({ command: "systemctl", args: ["--user", "enable", spec.serviceId] }, signal);
  }

  private async disableManager(spec: ManagedServiceSpec, signal: AbortSignal): Promise<void> {
    const command = this.platform === "win32"
      ? { command: "schtasks.exe", args: ["/Change", "/TN", spec.serviceId, "/DISABLE"] }
      : this.platform === "darwin"
        ? {
            command: "/bin/launchctl",
            args: ["disable", `gui/${spec.uid ?? 0}/${spec.serviceId}`],
          }
        : { command: "systemctl", args: ["--user", "disable", "--now", spec.serviceId] };
    await this.requireCommand(command, signal);
  }

  private async requireCommand(
    request: { readonly command: string; readonly args: readonly string[] },
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.command(request, signal);
    if (result.code !== 0) {
      throw new ManagedServiceError("command-failed", "Managed service manager rejected the operation");
    }
  }

  private command(
    request: { readonly command: string; readonly args: readonly string[] },
    signal: AbortSignal,
  ): Promise<ManagedServiceCommandResult> {
    throwIfAborted(signal);
    return this.run(request.command, request.args, { signal, timeoutMs: this.timeoutMs });
  }
}

function startCommand(spec: ManagedServiceSpec): { command: string; args: readonly string[] } {
  if (spec.platform === "win32") {
    return { command: "schtasks.exe", args: ["/Run", "/TN", spec.serviceId] };
  }
  if (spec.platform === "darwin") {
    return {
      command: "/bin/launchctl",
      args: ["kickstart", "-k", `gui/${spec.uid ?? 0}/${spec.serviceId}`],
    };
  }
  return { command: "systemctl", args: ["--user", "start", spec.serviceId] };
}

function renderManagedServiceDefinition(
  spec: Omit<ManagedServiceSpec, "definition">,
): string {
  if (spec.platform === "win32") {
    const command = [spec.command, ...spec.args].map(quoteWindowsArgument).join(" ");
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      "  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
      "  <Principals><Principal id=\"CurrentUser\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
      "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><Enabled>true</Enabled></Settings>",
      `  <Actions Context="CurrentUser"><Exec><Command>${xmlEscape(spec.command)}</Command><Arguments>${xmlEscape(command.slice(quoteWindowsArgument(spec.command).length + 1))}</Arguments></Exec></Actions>`,
      "</Task>",
      "",
    ].join("\n");
  }
  if (spec.platform === "darwin") {
    const args = [spec.command, ...spec.args]
      .map((value) => `      <string>${xmlEscape(value)}</string>`)
      .join("\n");
    const environment = Object.entries(spec.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `      <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
      .join("\n");
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `  <key>Label</key><string>${xmlEscape(spec.serviceId)}</string>`,
      "  <key>ProgramArguments</key><array>",
      args,
      "  </array>",
      "  <key>EnvironmentVariables</key><dict>",
      environment,
      "  </dict>",
      "  <key>RunAtLoad</key><true/>",
      "  <key>KeepAlive</key><true/>",
      "  <key>ProcessType</key><string>Background</string>",
      "</dict></plist>",
      "",
    ].join("\n");
  }
  const environment = Object.entries(spec.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return [
    "[Unit]",
    "Description=Zhixing",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[spec.command, ...spec.args].map(systemdQuote).join(" ")}`,
    environment,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function isPlatformSecretStoreBackend(value: string): value is PlatformSecretStoreBackend {
  return value === "windows-dpapi" || value === "macos-keychain" ||
    value === "linux-secret-service" || value === "machine-bound";
}

async function writeDefinition(
  filePath: string,
  definition: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (existing !== definition) {
      throw new ManagedServiceError("definition-drift", "Existing managed service definition differs");
    }
    return;
  }
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(definition, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    throwIfAborted(signal);
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function runManagedServiceCommand(
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<ManagedServiceCommandResult> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(new ManagedServiceError("aborted", "Managed service operation was cancelled")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ManagedServiceError("command-timeout", "Managed service command timed out")));
    }, options.timeoutMs);
    timer.unref();
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    })));
  });
}

function definitionDigest(spec: ManagedServiceSpec): string {
  return createHash("sha256").update(spec.definition, "utf8").digest("hex");
}

function canonicalAbsolutePath(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  if (!api.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("Managed service path must be absolute and canonical");
  }
  return api.resolve(value);
}

function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/gu, "$1$1")}"`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/%/gu, "%%").replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function normalizeXml(value: string): string {
  return value.replace(/\r\n/gu, "\n").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ManagedServiceError("aborted", "Managed service operation was cancelled");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync().catch((error: unknown) => {
      if (process.platform === "win32" && (isNodeError(error, "EPERM") || isNodeError(error, "EINVAL"))) return;
      throw error;
    });
  } finally {
    await directory.close();
  }
}
