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
  disableFuture(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
  disable(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
  stopCurrentExact(
    spec: ManagedServiceSpec,
    expected: ManagedServiceInspection,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection>;
  unregisterFutureExact(
    spec: ManagedServiceSpec,
    expected: ManagedServiceInspection,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection>;
  start(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection>;
}

export type ManagedServiceErrorCode =
  | "aborted"
  | "command-timeout"
  | "command-failed"
  | "permission-required"
  | "manager-unavailable"
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
    const stored = await readFile(spec.definitionPath).catch((error: unknown) => {
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
      matches: stored.equals(managedServiceDefinitionBytes(spec)) && manager.matches,
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
          () => writeDefinition(
            spec.definitionPath,
            managedServiceDefinitionBytes(spec),
            signal,
          ),
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
    await this.disableManager(spec, before, signal);
    const after = await this.inspect(spec, signal);
    if (after.state === "enabled" || after.running) {
      throw new ManagedServiceError("read-back-failed", "Managed service disable could not be verified");
    }
    return after;
  }

  async disableFuture(
    spec: ManagedServiceSpec,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state === "absent") return before;
    if (!before.matches) {
      throw new ManagedServiceError("definition-drift", "Existing managed service belongs to another installation");
    }
    if (before.state === "disabled") return before;
    await this.disableFutureManager(spec, signal);
    const after = await this.inspect(spec, signal);
    if (after.state === "enabled") {
      throw new ManagedServiceError("read-back-failed", "Managed service future disable could not be verified");
    }
    return after;
  }

  async stopCurrentExact(
    spec: ManagedServiceSpec,
    expected: ManagedServiceInspection,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (
      before.state !== expected.state ||
      before.running !== expected.running ||
      before.matches !== expected.matches ||
      !before.matches
    ) {
      throw new ManagedServiceError(
        "definition-drift",
        "Managed service instance changed before exact stop",
      );
    }
    if (!before.running) return before;
    if (this.platform === "win32") {
      await this.requireStopCommand(
        windowsTaskSchedulerCommand(["/End", "/TN", spec.serviceId]),
        signal,
      );
    } else if (this.platform === "darwin") {
      await this.requireStopCommand({
        command: "/bin/launchctl",
        args: ["bootout", `gui/${spec.uid ?? 0}/${spec.serviceId}`],
      }, signal);
    } else {
      await this.requireStopCommand({
        command: "systemctl",
        args: ["--user", "stop", spec.serviceId],
      }, signal);
    }
    const after = await this.inspect(spec, signal);
    if (after.running || !after.matches || after.state !== before.state) {
      throw new ManagedServiceError(
        "read-back-failed",
        "Managed service exact stop could not be verified",
      );
    }
    return after;
  }

  async unregisterFutureExact(
    spec: ManagedServiceSpec,
    expected: ManagedServiceInspection,
    signal: AbortSignal,
  ): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state === "absent" && expected.state === "absent") return before;
    if (
      before.state !== expected.state ||
      before.running !== expected.running ||
      before.matches !== expected.matches ||
      !before.matches
    ) {
      throw new ManagedServiceError(
        "definition-drift",
        "Managed service registration changed before exact removal",
      );
    }
    if (this.platform === "win32") {
      await this.requireStopCommand(
        windowsTaskSchedulerCommand(["/Delete", "/TN", spec.serviceId, "/F"]),
        signal,
      );
    } else if (this.platform === "darwin") {
      await this.disableFutureManager(spec, signal);
      await this.requireStopCommand({
        command: "/bin/launchctl",
        args: ["bootout", `gui/${spec.uid ?? 0}/${spec.serviceId}`],
      }, signal);
    } else {
      await this.requireCommand({
        command: "systemctl",
        args: ["--user", "disable", spec.serviceId],
      }, signal);
    }
    await runWithMaintenanceUrgency(() => "recovery", signal, async () => {
      await runStorageMaintenanceStep(
        this.storageGovernor,
        storageMaintenanceRequest(
          "managed-service-reconcile",
          spec.serviceId,
          definitionDigest(spec),
          { obligation: "pre-commit", maxWaitMs: 5_000 },
        ),
        () => rm(spec.definitionPath, { force: true }),
      );
    });
    if (this.platform === "linux") {
      await this.requireCommand({
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      }, signal);
    }
    const after = await this.inspect(spec, signal);
    if (after.state !== "absent" || after.running || !after.matches) {
      throw new ManagedServiceError(
        "read-back-failed",
        "Managed service registration removal could not be verified",
      );
    }
    return after;
  }

  async start(spec: ManagedServiceSpec, signal: AbortSignal): Promise<ManagedServiceInspection> {
    this.assertSpec(spec);
    const before = await this.inspect(spec, signal);
    if (before.state !== "enabled" || !before.matches) {
      throw new ManagedServiceError("read-back-failed", "Managed service is not installed and enabled");
    }
    await this.requireCommand(startCommand(spec), signal);
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
      const query = await this.command(
        windowsTaskInspectionCommand(spec.serviceId),
        signal,
      );
      if (query.code !== 0) {
        this.requireDefiniteAbsence(query);
        return { state: "absent", running: false, matches: true };
      }
      const projection = decodeWindowsTaskInspection(query.stdout);
      if (projection.enabled !== projection.settings.enabled) {
        throw new ManagedServiceError(
          "read-back-failed",
          "Windows managed service enabled state is inconsistent",
        );
      }
      return {
        state: projection.enabled ? "enabled" : "disabled",
        running: windowsTaskStateIsRunning(projection.state),
        matches: windowsTaskDefinitionMatches(spec, projection),
      };
    }
    if (this.platform === "darwin") {
      const domain = `gui/${spec.uid ?? 0}`;
      const printed = await this.command({
        command: "/bin/launchctl",
        args: ["print", `${domain}/${spec.serviceId}`],
      }, signal);
      if (printed.code !== 0) {
        this.requireDefiniteAbsence(printed);
        return { state: "absent", running: false, matches: true };
      }
      const disabled = await this.command({
        command: "/bin/launchctl",
        args: ["print-disabled", domain],
      }, signal);
      if (disabled.code !== 0) {
        this.throwManagerFailure(disabled);
      }
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
      this.requireDefiniteAbsence(enabled);
      return { state: "absent", running: false, matches: true };
    }
    const active = await this.command({
      command: "systemctl",
      args: ["--user", "is-active", spec.serviceId],
    }, signal);
    if (
      active.code !== 0 &&
      !/^(?:inactive|failed|deactivating)$/u.test(active.stdout.trim())
    ) {
      this.throwManagerFailure(active);
    }
    return {
      state: enabled.stdout.trim() === "enabled" ? "enabled" : "disabled",
      running: active.code === 0 && active.stdout.trim() === "active",
      matches: true,
    };
  }

  private async installManager(spec: ManagedServiceSpec, signal: AbortSignal): Promise<void> {
    if (this.platform === "win32") {
      await this.requireCommand(
        windowsTaskSchedulerCommand([
          "/Create",
          "/TN",
          spec.serviceId,
          "/XML",
          spec.definitionPath,
          "/F",
        ]),
        signal,
      );
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

  private async disableManager(
    spec: ManagedServiceSpec,
    before: ManagedServiceInspection,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.platform === "win32") {
      await this.disableFutureManager(spec, signal);
      if (before.running) {
        await this.requireStopCommand(
          windowsTaskSchedulerCommand(["/End", "/TN", spec.serviceId]),
          signal,
        );
      }
      return;
    }
    if (this.platform === "darwin") {
      const service = `gui/${spec.uid ?? 0}/${spec.serviceId}`;
      await this.disableFutureManager(spec, signal);
      if (before.running) {
        await this.requireStopCommand({
          command: "/bin/launchctl",
          args: ["bootout", service],
        }, signal);
      }
      return;
    }
    await this.requireCommand({
      command: "systemctl",
      args: ["--user", "disable", "--now", spec.serviceId],
    }, signal);
  }

  private async disableFutureManager(
    spec: ManagedServiceSpec,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.platform === "win32") {
      await this.requireCommand(
        windowsTaskSchedulerCommand(["/Change", "/TN", spec.serviceId, "/DISABLE"]),
        signal,
      );
      return;
    }
    if (this.platform === "darwin") {
      await this.requireCommand({
        command: "/bin/launchctl",
        args: ["disable", `gui/${spec.uid ?? 0}/${spec.serviceId}`],
      }, signal);
      return;
    }
    await this.requireCommand({
      command: "systemctl",
      args: ["--user", "disable", spec.serviceId],
    }, signal);
  }

  private async requireCommand(
    request: { readonly command: string; readonly args: readonly string[] },
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.command(request, signal);
    if (result.code !== 0) {
      this.throwManagerFailure(result, false);
      throw new ManagedServiceError("command-failed", "Managed service manager rejected the operation");
    }
  }

  private async requireStopCommand(
    request: { readonly command: string; readonly args: readonly string[] },
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.command(request, signal);
    if (result.code === 0 || classifyManagerFailure(this.platform, result) === "not-found") return;
    this.throwManagerFailure(result, false);
    throw new ManagedServiceError("command-failed", "Managed service could not be stopped safely");
  }

  private async command(
    request: { readonly command: string; readonly args: readonly string[] },
    signal: AbortSignal,
  ): Promise<ManagedServiceCommandResult> {
    throwIfAborted(signal);
    try {
      return await this.run(request.command, request.args, { signal, timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof ManagedServiceError) throw error;
      if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
        throw new ManagedServiceError(
          "permission-required",
          "Managed service manager permission is required",
        );
      }
      throw new ManagedServiceError(
        "manager-unavailable",
        "Managed service manager is unavailable",
      );
    }
  }

  private requireDefiniteAbsence(result: ManagedServiceCommandResult): void {
    const classification = classifyManagerFailure(this.platform, result);
    if (classification === "not-found") return;
    this.throwManagerFailure(result);
  }

  private throwManagerFailure(
    result: ManagedServiceCommandResult,
    includeNotFound = true,
  ): never | void {
    const classification = classifyManagerFailure(this.platform, result);
    if (!includeNotFound && classification === "not-found") return;
    if (classification === "permission-required") {
      throw new ManagedServiceError(
        "permission-required",
        "Managed service manager permission is required",
      );
    }
    throw new ManagedServiceError(
      "manager-unavailable",
      "Managed service manager is unavailable",
    );
  }
}

function classifyManagerFailure(
  platform: ManagedServicePlatform,
  result: ManagedServiceCommandResult,
): "not-found" | "permission-required" | "manager-unavailable" {
  const output = `${result.stdout}\n${result.stderr}`.trim().toLowerCase();
  if (
    /access is denied|permission denied|operation not permitted|not authorized|0x80070005|2147942405/u
      .test(output)
  ) {
    return "permission-required";
  }
  if (platform === "win32") {
    const hresult = result.code >>> 0;
    if (hresult === 0x80070005) return "permission-required";
    if (hresult === 0x80070002) return "not-found";
    if (/not found|cannot find|0x80070002|2147942402/u.test(output)) return "not-found";
  } else if (platform === "darwin") {
    if (result.code === 113 || /could not find service|service .* not found/u.test(output)) {
      return "not-found";
    }
  } else if (
    result.code === 4 ||
    /(?:^|\s)not-found(?:\s|$)|unit .* (?:not found|could not be found)/u.test(output)
  ) {
    return "not-found";
  }
  return "manager-unavailable";
}

function startCommand(spec: ManagedServiceSpec): { command: string; args: readonly string[] } {
  if (spec.platform === "win32") {
    return windowsTaskSchedulerCommand(["/Run", "/TN", spec.serviceId]);
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
    const osUser = xmlEscape(spec.osUser);
    return [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${osUser}</UserId></LogonTrigger></Triggers>`,
      `  <Principals><Principal id="CurrentUser"><UserId>${osUser}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
      "  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure><Enabled>true</Enabled></Settings>",
      `  <Actions Context="CurrentUser"><Exec><Command>${xmlEscape(spec.command)}</Command><Arguments>${xmlEscape(windowsCommandArguments(spec))}</Arguments></Exec></Actions>`,
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
  definition: Buffer,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await readFile(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.equals(definition)) {
      throw new ManagedServiceError("definition-drift", "Existing managed service definition differs");
    }
    return;
  }
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(definition);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    throwIfAborted(signal);
    await rename(temporary, filePath);
    await syncDirectory(path.dirname(filePath));
    const durable = await readFile(filePath);
    if (!durable.equals(definition)) {
      throw new ManagedServiceError(
        "read-back-failed",
        "Managed service definition bytes could not be verified",
      );
    }
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
  return managedServiceDefinitionDigest(spec).slice("sha256:".length);
}

export function managedServiceDefinitionDigest(spec: ManagedServiceSpec): string {
  return `sha256:${createHash("sha256")
    .update(managedServiceDefinitionBytes(spec))
    .digest("hex")}`;
}

export function managedServiceDefinitionBytes(spec: ManagedServiceSpec): Buffer {
  if (spec.platform === "win32") {
    return Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(spec.definition, "utf16le"),
    ]);
  }
  return Buffer.from(spec.definition, "utf8");
}

function windowsTaskSchedulerCommand(
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  return { command: "schtasks.exe", args: [...args, "/HRESULT"] };
}

interface WindowsTaskInspection {
  readonly taskName: string;
  readonly taskPath: string;
  readonly enabled: boolean;
  readonly state: number;
  readonly currentUser: { readonly sid: string; readonly name: string };
  readonly principal: {
    readonly id: string;
    readonly userId: string;
    readonly logonType: number;
    readonly runLevel: number;
  };
  readonly triggers: readonly {
    readonly type: number;
    readonly enabled: boolean;
    readonly userId: string | null;
  }[];
  readonly actions: {
    readonly context: string;
    readonly items: readonly {
      readonly type: number;
      readonly path: string | null;
      readonly arguments: string | null;
      readonly workingDirectory: string | null;
    }[];
  };
  readonly settings: {
    readonly enabled: boolean;
    readonly multipleInstances: number;
    readonly restartInterval: string;
    readonly restartCount: number;
  };
}

const WINDOWS_TASK_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  $identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()
  $service=New-Object -ComObject Schedule.Service
  $service.Connect()
  $task=$service.GetFolder('\').GetTask('__ZHIXING_TASK_NAME__')
  $definition=$task.Definition
  $triggers=@($definition.Triggers | ForEach-Object {
    [ordered]@{
      type=[int]$_.Type
      enabled=[bool]$_.Enabled
      userId=$(if ([int]$_.Type -eq 9) { [string]$_.UserId } else { $null })
    }
  })
  $actions=@($definition.Actions | ForEach-Object {
    [ordered]@{
      type=[int]$_.Type
      path=$(if ([int]$_.Type -eq 0) { [string]$_.Path } else { $null })
      arguments=$(if ([int]$_.Type -eq 0) { [string]$_.Arguments } else { $null })
      workingDirectory=$(if ([int]$_.Type -eq 0) { [string]$_.WorkingDirectory } else { $null })
    }
  })
  $result=[ordered]@{
    taskName=[string]$task.Name
    taskPath=[string]$task.Path
    enabled=[bool]$task.Enabled
    state=[int]$task.State
    currentUser=[ordered]@{sid=[string]$identity.User.Value;name=[string]$identity.Name}
    principal=[ordered]@{
      id=[string]$definition.Principal.Id
      userId=[string]$definition.Principal.UserId
      logonType=[int]$definition.Principal.LogonType
      runLevel=[int]$definition.Principal.RunLevel
    }
    triggers=$triggers
    actions=[ordered]@{context=[string]$definition.Actions.Context;items=$actions}
    settings=[ordered]@{
      enabled=[bool]$definition.Settings.Enabled
      multipleInstances=[int]$definition.Settings.MultipleInstances
      restartInterval=[string]$definition.Settings.RestartInterval
      restartCount=[int]$definition.Settings.RestartCount
    }
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 6))
} catch {
  $hresult=[BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$_.Exception.HResult),0)
  [Console]::Error.Write($hresult.ToString([Globalization.CultureInfo]::InvariantCulture))
  exit 1
}`.trim();

function windowsTaskInspectionCommand(
  serviceId: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (!/^dev\.zhixing\.host\.[a-f0-9]{24}$/u.test(serviceId)) {
    throw new ManagedServiceError("definition-drift", "Windows managed service identity is invalid");
  }
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_TASK_INSPECTION_SCRIPT.replace("__ZHIXING_TASK_NAME__", serviceId),
    ],
  };
}

function decodeWindowsTaskInspection(raw: string): WindowsTaskInspection {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ManagedServiceError("read-back-failed", "Windows managed service inspection is invalid");
  }
  try {
    const root = exactRecord(value, [
      "taskName", "taskPath", "enabled", "state", "currentUser", "principal", "triggers", "actions", "settings",
    ]);
    const currentUser = exactRecord(root.currentUser, ["sid", "name"]);
    const principal = exactRecord(root.principal, ["id", "userId", "logonType", "runLevel"]);
    const actions = exactRecord(root.actions, ["context", "items"]);
    const settings = exactRecord(root.settings, [
      "enabled", "multipleInstances", "restartInterval", "restartCount",
    ]);
    const triggers = strictArray(root.triggers).map((entry) => {
      const trigger = exactRecord(entry, ["type", "enabled", "userId"]);
      return {
        type: strictInteger(trigger.type),
        enabled: strictBoolean(trigger.enabled),
        userId: strictNullableString(trigger.userId),
      };
    });
    const items = strictArray(actions.items).map((entry) => {
      const action = exactRecord(entry, ["type", "path", "arguments", "workingDirectory"]);
      return {
        type: strictInteger(action.type),
        path: strictNullableString(action.path),
        arguments: strictNullableString(action.arguments),
        workingDirectory: strictNullableString(action.workingDirectory),
      };
    });
    const state = strictInteger(root.state);
    if (state < 0 || state > 4) throw new TypeError("state");
    return {
      taskName: strictString(root.taskName),
      taskPath: strictString(root.taskPath),
      enabled: strictBoolean(root.enabled),
      state,
      currentUser: {
        sid: strictNonEmptyString(currentUser.sid),
        name: strictNonEmptyString(currentUser.name),
      },
      principal: {
        id: strictString(principal.id),
        userId: strictNonEmptyString(principal.userId),
        logonType: strictInteger(principal.logonType),
        runLevel: strictInteger(principal.runLevel),
      },
      triggers,
      actions: { context: strictString(actions.context), items },
      settings: {
        enabled: strictBoolean(settings.enabled),
        multipleInstances: strictInteger(settings.multipleInstances),
        restartInterval: strictString(settings.restartInterval),
        restartCount: strictInteger(settings.restartCount),
      },
    };
  } catch (error) {
    if (error instanceof ManagedServiceError) throw error;
    throw new ManagedServiceError("read-back-failed", "Windows managed service inspection is invalid");
  }
}

function windowsTaskStateIsRunning(state: number): boolean {
  if (state === 2 || state === 4) return true;
  if (state === 1 || state === 3) return false;
  throw new ManagedServiceError("read-back-failed", "Windows managed service state is unknown");
}

function windowsTaskDefinitionMatches(
  spec: ManagedServiceSpec,
  projection: WindowsTaskInspection,
): boolean {
  const trigger = projection.triggers[0];
  const action = projection.actions.items[0];
  const currentUserIdentities = [
    projection.currentUser.sid,
    projection.currentUser.name,
    spec.osUser,
  ];
  const isCurrentUserIdentity = (identity: string): boolean =>
    currentUserIdentities.some((candidate) => windowsIdentityMatches(identity, candidate));
  return projection.taskName === spec.serviceId &&
    projection.taskPath === `\\${spec.serviceId}` &&
    projection.principal.id === "CurrentUser" &&
    isCurrentUserIdentity(projection.principal.userId) &&
    projection.principal.logonType === 3 &&
    projection.principal.runLevel === 0 &&
    projection.actions.context === "CurrentUser" &&
    projection.triggers.length === 1 && trigger?.type === 9 && trigger.enabled &&
    trigger.userId !== null && isCurrentUserIdentity(trigger.userId) &&
    projection.actions.items.length === 1 && action?.type === 0 &&
    action.path === spec.command &&
    action.arguments === windowsCommandArguments(spec) &&
    (action.workingDirectory === "" || action.workingDirectory === null) &&
    projection.settings.multipleInstances === 2 &&
    projection.settings.restartInterval === "PT1M" &&
    projection.settings.restartCount === 999;
}

function windowsCommandArguments(spec: Pick<ManagedServiceSpec, "args">): string {
  return spec.args.map(quoteWindowsArgument).join(" ");
}

function windowsIdentityMatches(actual: string, expected: string): boolean {
  return actual.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("record");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("keys");
  }
  return value as Record<string, unknown>;
}

function strictArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("array");
  return value;
}

function strictString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("string");
  return value;
}

function strictNonEmptyString(value: unknown): string {
  const result = strictString(value);
  if (result.length === 0) throw new TypeError("non-empty string");
  return result;
}

function strictNullableString(value: unknown): string | null {
  if (value === null) return null;
  return strictString(value);
}

function strictBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("boolean");
  return value;
}

function strictInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError("integer");
  return value;
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
