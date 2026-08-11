import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  applyManagedServiceLaunchContext,
  buildManagedServiceSpec,
  createManagedServiceAdapter,
  managedServiceDefinitionBytes,
  type ManagedServiceCommandRunner,
} from "./managed-service.js";

const execFileAsync = promisify(execFile);

function localSpec(directory: string) {
  if (process.platform === "win32") {
    return buildManagedServiceSpec({
      platform: "win32",
      zhixingHome: path.join(directory, "home"),
      backend: "windows-dpapi",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\Program Files\\zhixing\\dist\\index.js",
      osUser: "test",
      userHome: directory,
    });
  }
  return buildManagedServiceSpec({
    platform: process.platform,
    zhixingHome: path.join(directory, "home"),
    backend: process.platform === "darwin" ? "macos-keychain" : "machine-bound",
    execPath: "/usr/bin/node",
    entryScript: "/opt/zhixing/dist/index.js",
    osUser: "test",
    userHome: directory,
    uid: 1000,
  });
}

function platformSpec(
  platform: "win32" | "darwin" | "linux",
  directory: string,
) {
  return buildManagedServiceSpec({
    platform,
    zhixingHome: platform === "win32"
      ? path.win32.join(directory, "home")
      : "/zhixing-unit-36-managed-service/home",
    backend: platform === "win32"
      ? "windows-dpapi"
      : platform === "darwin"
        ? "macos-keychain"
        : "machine-bound",
    execPath: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node",
    entryScript: platform === "win32" ? "C:\\Program Files\\zhixing\\dist\\index.js" : "/opt/zhixing/dist/index.js",
    osUser: "test",
    userHome: platform === "win32" ? directory : "/zhixing-unit-36-managed-service/user",
    ...(platform === "win32" ? {} : { uid: 1000 }),
  });
}

describe("managed service platform contract", () => {
  it("renders stable secret-free definitions for the three supported platforms", async () => {
    const windows = buildManagedServiceSpec({
      platform: "win32",
      zhixingHome: "C:\\Users\\A User\\.zhixing",
      backend: "windows-dpapi",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      entryScript: "C:\\Program Files\\zhixing\\dist\\index.js",
      osUser: "A User",
      userHome: "C:\\Users\\A User",
    });
    expect(windows.startup).toBe("login");
    expect(windows.definition).toContain('encoding="UTF-8"');
    expect(windows.definition).toContain("<LogonTrigger>");
    expect(windows.definition).toContain("--managed");
    expect(managedServiceDefinitionBytes(windows).toString("utf8")).toBe(
      windows.definition,
    );
    expect(
      new TextDecoder("utf-8", { fatal: true }).decode(
        managedServiceDefinitionBytes(windows),
      ),
    ).toBe(windows.definition);

    const mac = buildManagedServiceSpec({
      platform: "darwin",
      zhixingHome: "/Users/a user/.zhixing",
      backend: "macos-keychain",
      execPath: "/usr/local/bin/node",
      entryScript: "/Applications/Zhixing/dist/index.js",
      osUser: "a user",
      userHome: "/Users/a user",
      uid: 501,
    });
    expect(mac.definitionPath).toContain("/Library/LaunchAgents/");
    expect(mac.definition).toContain("<key>KeepAlive</key><true/>");

    const linux = buildManagedServiceSpec({
      platform: "linux",
      zhixingHome: "/home/a user/.zhixing",
      backend: "machine-bound",
      execPath: "/usr/bin/node",
      entryScript: "/opt/zhixing/dist/index.js",
      osUser: "a user",
      userHome: "/home/a user",
      uid: 1000,
      headless: true,
    });
    expect(linux.startup).toBe("boot");
    expect(linux.definition).toContain('ExecStart="/usr/bin/node"');
    expect(linux.definition).toContain('ZHIXING_HOME=/home/a user/.zhixing');

    for (const spec of [windows, mac, linux]) {
      expect(spec.args).toEqual(expect.arrayContaining(["serve", "--managed"]));
      expect(spec.args).toEqual(expect.arrayContaining([
        "--managed-home",
        spec.zhixingHome,
        "--managed-secret-backend",
        spec.backend,
      ]));
      expect(spec.definition).not.toMatch(/access[_-]?token|refresh[_-]?token|bearer|recovery material|device:/iu);
    }
    expect(() => buildManagedServiceSpec({
      platform: "linux",
      zhixingHome: "/home/test/.zhixing",
      backend: "linux-secret-service",
      execPath: "/usr/bin/node",
      entryScript: "/opt/zhixing/dist/index.js",
      osUser: "test",
      userHome: "/home/test",
      uid: 1000,
      headless: true,
    })).toThrow(/machine-bound/);
  });

  it("binds hidden managed launch arguments to the process context", () => {
    const before = {
      managed: process.env.ZHIXING_MANAGED,
      home: process.env.ZHIXING_HOME,
      backend: process.env.ZHIXING_SECRET_BACKEND,
    };
    const home = path.resolve("managed home");
    try {
      applyManagedServiceLaunchContext({
        managed: true,
        home,
        backend: process.platform === "win32" ? "windows-dpapi" : "machine-bound",
      });
      expect(process.env.ZHIXING_MANAGED).toBe("1");
      expect(process.env.ZHIXING_HOME).toBe(home);
      expect(process.env.ZHIXING_SECRET_BACKEND).toBe(
        process.platform === "win32" ? "windows-dpapi" : "machine-bound",
      );
      expect(() => applyManagedServiceLaunchContext({
        managed: true,
        home,
      })).toThrow(/supplied together/);
    } finally {
      restoreEnvironment("ZHIXING_MANAGED", before.managed);
      restoreEnvironment("ZHIXING_HOME", before.home);
      restoreEnvironment("ZHIXING_SECRET_BACKEND", before.backend);
    }
  });

  it.runIf(process.platform === "win32")(
    "writes canonical UTF-8 bytes accepted by the Windows XML parser",
    async () => {
      const directory = await createTempDir("managed-service-windows-bytes");
      const spec = localSpec(directory);
      let installed = false;
      const runner: ManagedServiceCommandRunner = async (_command, args) => {
        if (args.includes("/Query") && args.includes("/XML")) {
          return installed
            ? { code: 0, stdout: spec.definition, stderr: "" }
            : { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
        }
        if (args.includes("/FO")) {
          return { code: 0, stdout: "Ready", stderr: "" };
        }
        if (args.includes("/Create")) installed = true;
        return { code: 0, stdout: "", stderr: "" };
      };
      const adapter = createManagedServiceAdapter({
        platform: "win32",
        commandRunner: runner,
      });
      await adapter.install(spec, new AbortController().signal);
      expect(await readFile(spec.definitionPath)).toEqual(
        managedServiceDefinitionBytes(spec),
      );

      const powershell = path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = [
        "$document=New-Object System.Xml.XmlDocument",
        "$document.PreserveWhitespace=$true",
        `$document.Load('${spec.definitionPath.replace(/'/gu, "''")}')`,
        "[Console]::Out.Write($document.DocumentElement.LocalName)",
      ].join(";");
      const parsed = await execFileAsync(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8" },
      );
      expect(parsed.stdout).toBe("Task");
    },
    15_000,
  );

  it("installs, starts and disables through stable platform read-back", async () => {
    const directory = await createTempDir("managed-service-local");
    const spec = localSpec(directory);
    let installed = false;
    let enabled = false;
    let running = false;
    const calls: string[] = [];
    const runner: ManagedServiceCommandRunner = async (command, args, { signal }) => {
      if (signal.aborted) throw signal.reason;
      calls.push(`${command} ${args.join(" ")}`);
      if (args.includes("/Query") && args.includes("/XML")) {
        return installed
          ? { code: 0, stdout: enabled ? spec.definition : spec.definition.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"), stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
      }
      if (args.includes("/FO")) {
        return { code: 0, stdout: running ? "running" : "ready", stderr: "" };
      }
      if (args.includes("is-enabled")) {
        return installed
          ? { code: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n", stderr: "" }
          : { code: 1, stdout: "not-found\n", stderr: "" };
      }
      if (args.includes("is-active")) {
        return { code: running ? 0 : 3, stdout: running ? "active\n" : "inactive\n", stderr: "" };
      }
      if (args.includes("enable") || args.includes("/Create")) {
        installed = true;
        enabled = true;
      }
      if (args.includes("start") || args.includes("kickstart") || args.includes("/Run")) running = true;
      if (args.includes("disable") || args.includes("/DISABLE")) {
        enabled = false;
        running = false;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const adapter = createManagedServiceAdapter({ platform: process.platform, commandRunner: runner });
    const signal = new AbortController().signal;

    await expect(adapter.install(spec, signal)).resolves.toEqual({
      state: "enabled",
      running: false,
      matches: true,
    });
    expect(await readFile(spec.definitionPath, "utf8")).toBe(spec.definition);
    await expect(adapter.install(spec, signal)).resolves.toMatchObject({ state: "enabled" });
    await expect(adapter.start(spec, signal)).resolves.toMatchObject({ running: true });
    await expect(adapter.disable(spec, signal)).resolves.toMatchObject({
      state: "disabled",
      running: false,
    });
    expect(calls.some((call) => /daemon-reload|bootstrap|\/Create/u.test(call))).toBe(true);
    expect(calls.some((call) => /\/End|bootout|disable --now/u.test(call))).toBe(true);
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "disables future launch before safely stopping the current %s instance",
    async (platform) => {
      const directory = await createTempDir(`managed-service-${platform}-stop`);
      const generated = platformSpec(platform, directory);
      const spec = Object.freeze({
        ...generated,
        definitionPath: path.join(directory, `${platform}.definition`),
      });
      await mkdir(path.dirname(spec.definitionPath), { recursive: true });
      await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
      let enabled = true;
      let running = true;
      const calls: string[] = [];
      const runner: ManagedServiceCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (platform === "win32" && args.includes("/XML")) {
          return {
            code: 0,
            stdout: enabled
              ? spec.definition
              : spec.definition.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>"),
            stderr: "",
          };
        }
        if (platform === "win32" && args.includes("/FO")) {
          return { code: 0, stdout: running ? "running" : "ready", stderr: "" };
        }
        if (platform === "darwin" && args.includes("print-disabled")) {
          return {
            code: 0,
            stdout: enabled ? "" : `\"${spec.serviceId}\" => true`,
            stderr: "",
          };
        }
        if (platform === "darwin" && args.includes("print")) {
          return { code: 0, stdout: running ? "pid = 42" : "state = exited", stderr: "" };
        }
        if (platform === "linux" && args.includes("is-enabled")) {
          return { code: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n", stderr: "" };
        }
        if (platform === "linux" && args.includes("is-active")) {
          return { code: running ? 0 : 3, stdout: running ? "active\n" : "inactive\n", stderr: "" };
        }
        if (args.includes("/DISABLE") || args.includes("disable")) enabled = false;
        if (args.includes("/End") || args[0] === "bootout" || args.includes("--now")) running = false;
        return { code: 0, stdout: "", stderr: "" };
      };
      const adapter = createManagedServiceAdapter({ platform, commandRunner: runner });
      await expect(adapter.disable(spec, new AbortController().signal)).resolves.toMatchObject({
        state: "disabled",
        running: false,
      });
      const futureIndex = calls.findIndex((call) => /\/DISABLE| disable |disable --now/u.test(call));
      const stopIndex = platform === "linux"
        ? futureIndex
        : calls.findIndex((call) => /\/End|bootout/u.test(call));
      expect(futureIndex).toBeGreaterThanOrEqual(0);
      expect(stopIndex).toBeGreaterThanOrEqual(futureIndex);
    },
  );

  it("fails closed on definition drift, unsupported platforms and cancellation", async () => {
    const directory = await createTempDir("managed-service-drift");
    const spec = localSpec(directory);
    await writeFile(spec.definitionPath, "other installation", { encoding: "utf8", flag: "wx" })
      .catch(async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(path.dirname(spec.definitionPath), { recursive: true });
        await writeFile(spec.definitionPath, "other installation", "utf8");
      });
    const runner: ManagedServiceCommandRunner = async () => process.platform === "win32"
      ? { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
      : process.platform === "darwin"
        ? { code: 113, stdout: "", stderr: "Could not find service" }
        : { code: 4, stdout: "not-found\n", stderr: "" };
    const adapter = createManagedServiceAdapter({ platform: process.platform, commandRunner: runner });
    await expect(adapter.install(spec, new AbortController().signal)).rejects.toMatchObject({
      code: "definition-drift",
    });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(adapter.inspect(spec, cancelled.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(() => createManagedServiceAdapter({ platform: "aix" })).toThrow(/unavailable/);
  });

  it.each([
    ["win32", { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }],
    ["darwin", { code: 113, stdout: "", stderr: "Could not find service" }],
    ["linux", { code: 4, stdout: "not-found\n", stderr: "" }],
  ] as const)("accepts only documented %s manager absence", async (platform, result) => {
    const directory = await createTempDir(`managed-service-${platform}-absent`);
    const spec = platformSpec(platform, directory);
    const adapter = createManagedServiceAdapter({
      platform,
      commandRunner: async () => result,
    });
    await expect(adapter.inspect(spec, new AbortController().signal)).resolves.toEqual({
      state: "absent",
      running: false,
      matches: true,
    });
  });

  it.each([
    ["win32", "ERROR: Access is denied.", "permission-required"],
    ["darwin", "Operation not permitted", "permission-required"],
    ["linux", "Failed to connect to bus: No medium found", "manager-unavailable"],
  ] as const)(
    "fails closed before definition writes for %s manager errors",
    async (platform, stderr, code) => {
      const directory = await createTempDir(`managed-service-${platform}-failure`);
      const spec = platformSpec(platform, directory);
      const adapter = createManagedServiceAdapter({
        platform,
        commandRunner: async () => ({ code: 1, stdout: "", stderr }),
      });
      await expect(adapter.install(spec, new AbortController().signal)).rejects.toMatchObject({
        code,
      });
      await expect(readFile(spec.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
