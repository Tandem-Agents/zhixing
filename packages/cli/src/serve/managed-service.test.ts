import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
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
  const spec = buildManagedServiceSpec({
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
  return Object.freeze({
    ...spec,
    definitionPath: path.join(directory, `${platform}.definition`),
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
      osUser: 'DOMAIN\\A & <User> "Admin"',
      userHome: "C:\\Users\\A User",
    });
    expect(windows.startup).toBe("login");
    expect(windows.definition).toContain('encoding="UTF-16"');
    expect(windows.definition).toContain("<LogonTrigger>");
    expect(windows.definition.match(
      /<UserId>DOMAIN\\A &amp; &lt;User&gt; &quot;Admin&quot;<\/UserId>/gu,
    )).toHaveLength(2);
    expect(windows.definition).toContain(
      '<Actions Context="CurrentUser">',
    );
    expect(windows.definition).not.toContain("DOMAIN\\A & <User>");
    expect(windows.definition).toContain("--managed");
    expect(managedServiceDefinitionBytes(windows).subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xfe]),
    );
    expect(
      new TextDecoder("utf-16le", { fatal: true }).decode(
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
    "writes canonical UTF-16LE bytes accepted by the Windows XML parser",
    async () => {
      const directory = await createTempDir("managed-service-windows-bytes");
      const spec = localSpec(directory);
      let installed = false;
      const runner: ManagedServiceCommandRunner = async (command, args) => {
        if (command === "powershell.exe") {
          return installed
            ? { code: 0, stdout: windowsInspectionJson(spec), stderr: "" }
            : { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
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
        "$namespace=New-Object System.Xml.XmlNamespaceManager($document.NameTable)",
        "$namespace.AddNamespace('t',$document.DocumentElement.NamespaceURI)",
        "$principal=$document.SelectSingleNode('/t:Task/t:Principals/t:Principal',$namespace)",
        "$trigger=$document.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$namespace)",
        "$actions=$document.SelectSingleNode('/t:Task/t:Actions',$namespace)",
        "[Console]::Out.Write(($document.DocumentElement.LocalName,$principal.UserId,$trigger.UserId,$principal.LogonType,$actions.Context -join '|'))",
      ].join(";");
      const parsed = await execFileAsync(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8" },
      );
      expect(parsed.stdout).toBe("Task|test|test|InteractiveToken|CurrentUser");
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "registers and reads back the current-user principal through the production Windows adapter",
    async () => {
      const directory = await createTempDir("managed-service-windows-system");
      const spec = buildManagedServiceSpec({
        platform: "win32",
        zhixingHome: path.join(directory, "home"),
        backend: "windows-dpapi",
        execPath: process.execPath,
        entryScript: path.resolve("packages/cli/dist/index.js"),
        osUser: userInfo().username,
        userHome: directory,
      });
      const signal = new AbortController().signal;
      try {
        const adapter = createManagedServiceAdapter({ platform: "win32" });
        await expect(adapter.install(spec, signal)).resolves.toMatchObject({
          state: "enabled",
          matches: true,
        });
        await expect(adapter.inspect(spec, signal))
          .resolves.toMatchObject({ state: "enabled", matches: true });

        const powershell = path.win32.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const script = [
          "$service=New-Object -ComObject Schedule.Service",
          "$service.Connect()",
          `$registered=$service.GetFolder('\\').GetTask('${spec.serviceId.replace(/'/gu, "''")}')`,
          "$document=New-Object System.Xml.XmlDocument",
          "$document.LoadXml($registered.Xml)",
          "$namespace=New-Object System.Xml.XmlNamespaceManager($document.NameTable)",
          "$namespace.AddNamespace('t',$document.DocumentElement.NamespaceURI)",
          "$principal=$document.SelectSingleNode('/t:Task/t:Principals/t:Principal',$namespace)",
          "$trigger=$document.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger',$namespace)",
          "$actions=$document.SelectSingleNode('/t:Task/t:Actions',$namespace)",
          "$principalAccount=(New-Object System.Security.Principal.SecurityIdentifier($principal.UserId)).Translate([System.Security.Principal.NTAccount]).Value",
          "[Console]::Out.Write(($principalAccount,$trigger.UserId,$principal.LogonType,$actions.Context -join '|'))",
        ].join(";");
        const readBack = await execFileAsync(
          powershell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8" },
        );
        const [principal, trigger, logonType, actionContext] = readBack.stdout.split("|");
        expect(principal).toBe(trigger);
        expect(principal?.toLocaleLowerCase("en-US").split("\\").at(-1)).toBe(
          userInfo().username.toLocaleLowerCase("en-US"),
        );
        expect(logonType).toBe("InteractiveToken");
        expect(actionContext).toBe("CurrentUser");
      } finally {
        await execFileAsync(
          "schtasks.exe",
          ["/Delete", "/TN", spec.serviceId, "/F", "/HRESULT"],
          { encoding: "buffer", windowsHide: true },
        ).catch(() => undefined);
      }
    },
    30_000,
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
      if (command === "powershell.exe") {
        return installed
          ? { code: 0, stdout: windowsInspectionJson(spec, { enabled, running }), stderr: "" }
          : { code: 1, stdout: "", stderr: "not found" };
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
    expect(await readFile(spec.definitionPath)).toEqual(managedServiceDefinitionBytes(spec));
    await expect(adapter.install(spec, signal)).resolves.toMatchObject({ state: "enabled" });
    await expect(adapter.start(spec, signal)).resolves.toMatchObject({ running: true });
    await expect(adapter.disable(spec, signal)).resolves.toMatchObject({
      state: "disabled",
      running: false,
    });
    expect(calls.some((call) => /daemon-reload|bootstrap|\/Create/u.test(call))).toBe(true);
    expect(calls.some((call) => /\/End|bootout|disable --now/u.test(call))).toBe(true);
    if (process.platform === "win32") {
      expect(calls.filter((call) => call.startsWith("schtasks.exe "))
        .every((call) => call.includes("/HRESULT"))).toBe(true);
    }
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "disables future launch before safely stopping the current %s instance",
    async (platform) => {
      const directory = await createTempDir(`managed-service-${platform}-stop`);
      const spec = platformSpec(platform, directory);
      await mkdir(path.dirname(spec.definitionPath), { recursive: true });
      await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
      let enabled = true;
      let running = true;
      const calls: string[] = [];
      const runner: ManagedServiceCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (platform === "win32" && command === "powershell.exe") {
          return {
            code: 0,
            stdout: windowsInspectionJson(spec, { enabled, running }),
            stderr: "",
          };
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
      await expect(adapter.disableFuture(spec, new AbortController().signal)).resolves.toMatchObject({
        state: "disabled",
        running: true,
      });
      expect(calls.some((call) => /\/End|bootout|--now/u.test(call))).toBe(false);

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

  it.each(["win32", "darwin", "linux"] as const)(
    "stops only the exact current %s instance while preserving future registration",
    async (platform) => {
      const directory = await createTempDir(`managed-service-${platform}-exact-stop`);
      const spec = platformSpec(platform, directory);
      await mkdir(path.dirname(spec.definitionPath), { recursive: true });
      await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
      let running = true;
      const calls: string[] = [];
      const runner: ManagedServiceCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (platform === "win32" && command === "powershell.exe") {
          return { code: 0, stdout: windowsInspectionJson(spec, { enabled: true, running }), stderr: "" };
        }
        if (platform === "darwin" && args.includes("print-disabled")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (platform === "darwin" && args.includes("print")) {
          return { code: 0, stdout: running ? "pid = 42" : "state = exited", stderr: "" };
        }
        if (platform === "linux" && args.includes("is-enabled")) {
          return { code: 0, stdout: "enabled\n", stderr: "" };
        }
        if (platform === "linux" && args.includes("is-active")) {
          return { code: running ? 0 : 3, stdout: running ? "active\n" : "inactive\n", stderr: "" };
        }
        if (args.includes("/End") || args[0] === "bootout" || args.includes("stop")) running = false;
        return { code: 0, stdout: "", stderr: "" };
      };
      const adapter = createManagedServiceAdapter({ platform, commandRunner: runner });
      const expected = await adapter.inspect(spec, new AbortController().signal);
      await expect(adapter.stopCurrentExact(spec, expected, new AbortController().signal))
        .resolves.toEqual({ state: "enabled", running: false, matches: true });
      expect(calls.some((call) => /\/DISABLE| disable |\/Delete/u.test(call))).toBe(false);
      await expect(adapter.stopCurrentExact(
        spec,
        { ...expected, state: "disabled" },
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "definition-drift" });
    },
  );

  it.each(["win32", "darwin", "linux"] as const)(
    "unregisters only the exact frozen %s service definition",
    async (platform) => {
      const directory = await createTempDir(`managed-service-${platform}-exact-unregister`);
      const spec = platformSpec(platform, directory);
      await mkdir(path.dirname(spec.definitionPath), { recursive: true });
      await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
      let registered = true;
      const calls: string[] = [];
      const runner: ManagedServiceCommandRunner = async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (platform === "win32" && command === "powershell.exe") {
          return registered
            ? { code: 0, stdout: windowsInspectionJson(spec, { enabled: true, running: true }), stderr: "" }
            : { code: 0x80070002, stdout: "", stderr: "not found" };
        }
        if (platform === "darwin" && args.includes("print-disabled")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (platform === "darwin" && args.includes("print")) {
          return registered
            ? { code: 0, stdout: "pid = 42", stderr: "" }
            : { code: 113, stdout: "", stderr: "Could not find service" };
        }
        if (platform === "linux" && args.includes("is-enabled")) {
          return registered
            ? { code: 0, stdout: "enabled\n", stderr: "" }
            : { code: 4, stdout: "not-found\n", stderr: "" };
        }
        if (platform === "linux" && args.includes("is-active")) {
          return { code: 0, stdout: "active\n", stderr: "" };
        }
        if (
          args.includes("/Delete") ||
          args[0] === "bootout" ||
          (platform === "linux" && args.includes("disable"))
        ) {
          registered = false;
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const adapter = createManagedServiceAdapter({ platform, commandRunner: runner });
      const expected = await adapter.inspect(spec, new AbortController().signal);
      await expect(adapter.unregisterFutureExact(
        spec,
        expected,
        new AbortController().signal,
      )).resolves.toEqual({ state: "absent", running: false, matches: true });
      await expect(readFile(spec.definitionPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.some((call) => /\/Delete|bootout| disable /u.test(call))).toBe(true);

      const beforeMismatchCalls = calls.length;
      await expect(adapter.unregisterFutureExact(
        spec,
        { state: "enabled", running: true, matches: true },
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "definition-drift" });
      expect(calls.length).toBe(beforeMismatchCalls + 1);
    },
  );

  it("replays a lost Windows future-disable response and re-enables the same definition", async () => {
    const directory = await createTempDir("managed-service-windows-enabled-replay");
    const spec = platformSpec("win32", directory);
    await mkdir(path.dirname(spec.definitionPath), { recursive: true });
    await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
    let enabled = true;
    let disableCalls = 0;
    let createCalls = 0;
    const runner: ManagedServiceCommandRunner = async (command, args) => {
      if (command === "powershell.exe") {
        return {
          code: 0,
          stdout: windowsInspectionJson(spec, { enabled, running: true }),
          stderr: "",
        };
      }
      if (args.includes("/DISABLE")) {
        disableCalls += 1;
        enabled = false;
        throw new Error("future-disable response lost");
      }
      if (args.includes("/Create")) {
        createCalls += 1;
        enabled = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const adapter = createManagedServiceAdapter({ platform: "win32", commandRunner: runner });
    const signal = new AbortController().signal;

    await expect(adapter.disableFuture(spec, signal)).rejects.toMatchObject({
      code: "manager-unavailable",
    });
    await expect(adapter.disableFuture(spec, signal)).resolves.toMatchObject({
      state: "disabled",
      running: true,
      matches: true,
    });
    expect(disableCalls).toBe(1);

    await expect(adapter.install(spec, signal)).resolves.toMatchObject({
      state: "enabled",
      matches: true,
    });
    expect(createCalls).toBe(1);
  });

  it("strictly projects Windows numeric state, current SID and typed collections", async () => {
    const directory = await createTempDir("managed-service-windows-inspection");
    const spec = platformSpec("win32", directory);
    await mkdir(path.dirname(spec.definitionPath), { recursive: true });
    await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
    let payload = windowsInspectionJson(spec, { state: 2 });
    const adapter = createManagedServiceAdapter({
      platform: "win32",
      commandRunner: async (command) => {
        expect(command).toBe("powershell.exe");
        return { code: 0, stdout: payload, stderr: "" };
      },
    });
    const signal = new AbortController().signal;

    await expect(adapter.inspect(spec, signal)).resolves.toEqual({
      state: "enabled",
      running: true,
      matches: true,
    });

    payload = windowsInspectionJson(spec, { enabled: false, state: 4 });
    await expect(adapter.inspect(spec, signal)).resolves.toEqual({
      state: "disabled",
      running: true,
      matches: true,
    });

    payload = windowsInspectionJson(spec, { enabled: true, settingsEnabled: false });
    await expect(adapter.inspect(spec, signal)).rejects.toMatchObject({ code: "read-back-failed" });

    payload = windowsInspectionJson(spec, { enabled: false, settingsEnabled: true });
    await expect(adapter.inspect(spec, signal)).rejects.toMatchObject({ code: "read-back-failed" });

    payload = windowsInspectionJson(spec, { principalUserId: `MACHINE\\${spec.osUser}` });
    await expect(adapter.inspect(spec, signal)).resolves.toMatchObject({ matches: true });

    payload = windowsInspectionJson(spec, { principalUserId: "S-1-5-21-9-9-9-999" });
    await expect(adapter.inspect(spec, signal)).resolves.toMatchObject({ matches: false });

    payload = windowsInspectionJson(spec, { principalUserId: "" });
    await expect(adapter.inspect(spec, signal)).rejects.toMatchObject({ code: "read-back-failed" });

    payload = windowsInspectionJson(spec, {
      triggers: [
        { type: 9, enabled: true, userId: spec.osUser },
        { type: 8, enabled: true, userId: null },
      ],
    });
    await expect(adapter.inspect(spec, signal)).resolves.toMatchObject({ matches: false });

    payload = windowsInspectionJson(spec, { state: 0 });
    await expect(adapter.inspect(spec, signal)).rejects.toMatchObject({ code: "read-back-failed" });

    payload = '{"state":3}';
    await expect(adapter.inspect(spec, signal)).rejects.toMatchObject({ code: "read-back-failed" });
  });

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
    ["win32", { code: 0x80070002, stdout: "", stderr: "����: ϵͳ�Ҳ���ָ�����ļ���" }],
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

  it.each(["win32", "darwin", "linux"] as const)(
    "classifies %s start failures through the shared manager boundary and keeps post-inspect independent",
    async (platform) => {
      const directory = await createTempDir(`managed-service-${platform}-start-classification`);
      const spec = platformSpec(platform, directory);
      await mkdir(path.dirname(spec.definitionPath), { recursive: true });
      await writeFile(spec.definitionPath, managedServiceDefinitionBytes(spec));
      const cases = [
        {
          name: "permission",
          outcome: { code: 1, stdout: "", stderr: "Access is denied" },
          code: "permission-required",
        },
        {
          name: "manager unavailable",
          outcome: { code: 1, stdout: "", stderr: "Manager session is unavailable" },
          code: "manager-unavailable",
        },
        {
          name: "documented not-found",
          outcome: documentedNotFound(platform),
          code: "command-failed",
        },
        {
          name: "other non-zero",
          outcome: { code: 9, stdout: "", stderr: "Unclassified manager rejection" },
          code: "manager-unavailable",
        },
        {
          name: "permission spawn",
          outcome: Object.assign(new Error("spawn denied"), { code: "EACCES" }),
          code: "permission-required",
        },
        {
          name: "other spawn",
          outcome: new Error("spawn failed"),
          code: "manager-unavailable",
        },
      ] as const;
      for (const entry of cases) {
        const fixture = startRunner(platform, spec, entry.outcome);
        const adapter = createManagedServiceAdapter({
          platform,
          commandRunner: fixture.runner,
        });
        const startError = await adapter.start(spec, new AbortController().signal)
          .then(() => undefined, (error: unknown) => error);
        expect(fixture.startCalls(), entry.name).toBe(1);
        expect(startError, entry.name).toMatchObject({ code: entry.code });
        expect(fixture.postInspectCalls(), entry.name).toBe(0);
      }

      const unverified = startRunner(platform, spec, { code: 0, stdout: "", stderr: "" }, false);
      await expect(createManagedServiceAdapter({
        platform,
        commandRunner: unverified.runner,
      }).start(spec, new AbortController().signal)).rejects.toMatchObject({
        code: "read-back-failed",
      });
      expect(unverified.postInspectCalls()).toBeGreaterThan(0);

      const verified = startRunner(platform, spec, { code: 0, stdout: "", stderr: "" }, true);
      await expect(createManagedServiceAdapter({
        platform,
        commandRunner: verified.runner,
      }).start(spec, new AbortController().signal)).resolves.toMatchObject({ running: true });
      expect(verified.postInspectCalls()).toBeGreaterThan(0);
      expect(await readFile(spec.definitionPath)).toEqual(managedServiceDefinitionBytes(spec));
    },
  );
});

function documentedNotFound(platform: "win32" | "darwin" | "linux") {
  if (platform === "win32") {
    return { code: 0x80070002, stdout: "", stderr: "����: ϵͳ�Ҳ���ָ�����ļ���" };
  }
  if (platform === "darwin") {
    return { code: 113, stdout: "", stderr: "Could not find service" };
  }
  return { code: 4, stdout: "not-found\n", stderr: "" };
}

function startRunner(
  platform: "win32" | "darwin" | "linux",
  spec: ReturnType<typeof platformSpec>,
  outcome: { readonly code: number; readonly stdout: string; readonly stderr: string } | Error,
  exposeRunning = false,
) {
  let starts = 0;
  let inspectionsAfterStart = 0;
  const runner: ManagedServiceCommandRunner = async (_command, args) => {
    const isStart = args.includes("/Run") || args.includes("kickstart") || args.includes("start");
    if (isStart) {
      starts += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    if (starts > 0) inspectionsAfterStart += 1;
    if (platform === "win32" && _command === "powershell.exe") {
      return {
        code: 0,
        stdout: windowsInspectionJson(spec, { running: exposeRunning }),
        stderr: "",
      };
    }
    if (platform === "darwin" && args.includes("print-disabled")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (platform === "darwin" && args.includes("print")) {
      return { code: 0, stdout: exposeRunning ? "pid = 42" : "state = exited", stderr: "" };
    }
    if (platform === "linux" && args.includes("is-enabled")) {
      return { code: 0, stdout: "enabled\n", stderr: "" };
    }
    if (platform === "linux" && args.includes("is-active")) {
      return exposeRunning
        ? { code: 0, stdout: "active\n", stderr: "" }
        : { code: 3, stdout: "inactive\n", stderr: "" };
    }
    throw new Error(`Unexpected managed service command: ${args.join(" ")}`);
  };
  return {
    runner,
    startCalls: () => starts,
    postInspectCalls: () => inspectionsAfterStart,
  };
}

function windowsInspectionJson(
  spec: ReturnType<typeof platformSpec> | ReturnType<typeof localSpec>,
  options: {
    readonly enabled?: boolean;
    readonly settingsEnabled?: boolean;
    readonly running?: boolean;
    readonly state?: number;
    readonly principalUserId?: string;
    readonly triggers?: readonly Record<string, unknown>[];
    readonly actions?: readonly Record<string, unknown>[];
  } = {},
): string {
  const sid = "S-1-5-21-1-2-3-1001";
  const trigger = { type: 9, enabled: true, userId: spec.osUser };
  const action = {
    type: 0,
    path: spec.command,
    arguments: spec.args.map(quoteWindowsTestArgument).join(" "),
    workingDirectory: "",
  };
  return JSON.stringify({
    taskName: spec.serviceId,
    taskPath: `\\${spec.serviceId}`,
    enabled: options.enabled ?? true,
    state: options.state ?? (options.running ? 4 : 3),
    currentUser: { sid, name: `MACHINE\\${spec.osUser}` },
    principal: {
      id: "CurrentUser",
      userId: options.principalUserId ?? sid,
      logonType: 3,
      runLevel: 0,
    },
    triggers: options.triggers ?? [trigger],
    actions: { context: "CurrentUser", items: options.actions ?? [action] },
    settings: {
      enabled: options.settingsEnabled ?? options.enabled ?? true,
      multipleInstances: 2,
      restartInterval: "PT1M",
      restartCount: 999,
    },
  });
}

function quoteWindowsTestArgument(value: string): string {
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/gu, "$1$1")}"`;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
