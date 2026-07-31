import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const target = path.resolve(args.target);
const adapterPath = path.resolve(args.adapter);
const output = path.resolve(args.output);
const manifest = JSON.parse(await readFile(path.join(root, "packages/cli/src/serve/fixtures/s1-terminal-performance-baseline.json"), "utf8"));
const adapter = validateAdapter(JSON.parse(await readFile(adapterPath, "utf8")), args.revision);
const scriptDigest = await fileDigest(fileURLToPath(import.meta.url));
const adapterDigest = await fileDigest(adapterPath);
const deliveryTreeDigest = await directoryDigest(path.join(target, "packages"));
const buildDigest = await directoryDigest(path.join(target, "packages", "cli", "dist"));
const workspace = await mkdtemp(path.join(tmpdir(), "zhixing-s7-terminal-"));
const observationPrefix = "__ZHIXING_TERMINAL_PERFORMANCE_V1__:";

try {
  const scenarioSetup = await prepareScenarios(adapter, { target, workspace });
  const environment = {
    platform: platform(),
    architecture: arch(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    nodeVersion: process.versions.node,
    loadProfile: "isolated-external-cli",
    runtimeParametersDigest: digest({
      samples: manifest.config.samples,
      warmups: manifest.config.warmups,
      protocol: "external-first-party-terminal-v1",
    }),
    fixedInputDigest: digest(adapter.input),
    deterministicModelDigest: digest(adapter.deterministicProvider),
  };
  const environmentFingerprint = protocolDigest("TerminalPerformanceEnvironment", 1, environment);
  const config = { version: 1, baselineCommit: manifest.baselineCommit, ...manifest.config };
  const configDigest = protocolDigest("TerminalPerformanceConfig", 1, config);
  const runs = [];
  for (const scenario of manifest.scenarios) {
    const driver = new ExternalTerminalDriver(adapter, {
      target,
      home: scenarioSetup[scenario].home,
      workspace: scenarioSetup[scenario].workspace,
    });
    const warm = scenario.startsWith("warm-");
    try {
      for (let index = 0; index < manifest.config.warmups; index += 1) {
        await driver.run(adapter.input, warm);
      }
      const rawSamples = [];
      for (let index = 0; index < manifest.config.samples; index += 1) {
        rawSamples.push(await driver.run(adapter.input, warm));
      }
      runs.push({ configDigest, environmentFingerprint, revision: args.revision, scenario, rawSamples });
    } finally {
      await driver.close();
    }
  }
  const scenarioSetupDigest = protocolDigest(
    "TerminalPerformanceScenarioSetup",
    1,
    Object.entries(scenarioSetup).map(([scenario, setup]) => ({
      scenario,
      workspace: setup.workspace === null ? "none" : "canonical-fixture",
      intent: setup.intent,
      contentDigest: setup.contentDigest,
      setupKind: setup.setupKind,
    })),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    version: 1,
    revision: args.revision,
    environment,
    environmentFingerprint,
    configDigest,
    delivery: {
      sourceRevision: args.revision,
      deliveryTreeDigest,
      buildDigest,
      harnessDigest: protocolDigest("TerminalPerformanceHarness", 1, { scriptDigest }),
      setupAdapterDigest: adapterDigest,
      scenarioSetupDigest,
    },
    runs,
  }, null, 2)}\n`, "utf8");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

class ExternalTerminalDriver {
  constructor(adapter, context) {
    this.adapter = adapter;
    this.context = context;
    this.process = undefined;
    this.buffer = "";
    this.stdoutBuffer = "";
    this.waiter = undefined;
  }

  async run(input, reuse) {
    if (!reuse || !this.process) await this.start();
    const startedAt = performance.now();
    const sample = await new Promise((resolve, reject) => {
      this.waiter = {
        resolve,
        reject,
        startedAt,
        firstFrameAt: undefined,
        lastFrameAt: undefined,
        frames: 0,
        preflights: 0,
        activityBeforeFirstFrame: 0,
      };
      this.process.stdin.write(`${input}\n`);
    });
    if (!reuse) await this.close();
    return sample;
  }

  async start() {
    await this.close();
    const command = expand(this.adapter.terminal.command, this.context);
    const commandArgs = this.adapter.terminal.args.map((item) => expand(item, this.context));
    this.process = spawn(command, commandArgs, {
      cwd: this.context.target,
      env: {
        ...process.env,
        ...expandRecord(this.adapter.environment, this.context),
        ZHIXING_TERMINAL_PERFORMANCE_OBSERVATION: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.onData(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => this.onData(chunk));
    this.process.once("exit", (code) => {
      this.waiter?.reject(new Error(`Terminal exited before sample completion (${code}): ${this.buffer.slice(-2000)}`));
      this.waiter = undefined;
    });
    await waitForOutput(this.process, new RegExp(this.adapter.protocol.ready, "u"), this.adapter.timeoutMs);
  }

  onData(chunk) {
    this.buffer += chunk;
    this.stdoutBuffer += chunk;
    const waiter = this.waiter;
    if (!waiter) return;
    const lines = this.stdoutBuffer.split(/\r?\n/u);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const at = performance.now();
      if (line === `${observationPrefix}workspace-preflight`) waiter.preflights += 1;
      if (line === `${observationPrefix}session-activity-commit` && waiter.firstFrameAt === undefined) waiter.activityBeforeFirstFrame += 1;
      if (new RegExp(this.adapter.protocol.frame, "u").test(line)) {
        waiter.firstFrameAt ??= at;
        waiter.lastFrameAt = at;
        waiter.frames += 1;
      }
      if (new RegExp(this.adapter.protocol.complete, "u").test(line)) {
        if (waiter.firstFrameAt === undefined || waiter.lastFrameAt === undefined || waiter.frames < 2) {
          waiter.reject(new Error("Public terminal stream did not produce a measurable frame sequence"));
        } else {
          waiter.resolve({
            firstTokenMs: waiter.firstFrameAt - waiter.startedAt,
            streamDurationMs: waiter.lastFrameAt - waiter.firstFrameAt,
            streamFrameCount: waiter.frames,
            workspacePreflightCalls: waiter.preflights,
            activityProjectionWritesBeforeFirstToken: waiter.activityBeforeFirstFrame,
          });
        }
        this.waiter = undefined;
      }
    }
  }

  async close() {
    const child = this.process;
    this.process = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function prepareScenarios(adapter, context) {
  const result = {};
  for (const scenario of ["cold-no-workspace", "warm-no-workspace", "cold-workspace", "warm-workspace"]) {
    const home = path.join(context.workspace, scenario, "home");
    const workspacePath = path.join(context.workspace, "canonical-workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "fixture.txt"), "s7-equivalent-workspace\n", "utf8");
    const setup = scenario.endsWith("no-workspace") ? adapter.setup.noWorkspace : adapter.setup.workspace;
    await runCommand(setup, { ...context, home, workspace: workspacePath });
    result[scenario] = {
      home,
      workspace: scenario.endsWith("no-workspace") ? null : workspacePath,
      intent: adapter.intent,
      contentDigest: await directoryDigest(workspacePath),
      setupKind: setup.kind,
    };
  }
  return result;
}

async function runCommand(spec, context) {
  const command = expand(spec.command, context);
  const commandArgs = spec.args.map((item) => expand(item, context));
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: context.target,
      env: { ...process.env, ...expandRecord(spec.environment ?? {}, context) },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Public setup command failed (${code})`)));
  });
}

function validateAdapter(value, revision) {
  if (!value || value.version !== 1 || value.revision !== revision) throw new Error("Performance adapter revision is invalid");
  for (const key of ["noWorkspace", "workspace"]) {
    const item = value.setup?.[key];
    if (!item || item.kind !== "public-cli" || typeof item.command !== "string" || !Array.isArray(item.args)) {
      throw new Error(`Performance ${key} setup must use a public CLI adapter`);
    }
  }
  if (!value.terminal || value.terminal.kind !== "public-first-party-cli") throw new Error("Performance terminal adapter is not public");
  for (const key of ["ready", "frame", "complete"]) new RegExp(value.protocol?.[key], "u");
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000) throw new Error("Performance adapter timeout is invalid");
  return value;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --target, --adapter, --output and --revision");
    result[key.slice(2)] = value;
  }
  for (const key of ["target", "adapter", "output", "revision"]) if (!result[key]) throw new Error(`Missing --${key}`);
  return result;
}

function expand(value, context) {
  return value.replaceAll("{target}", context.target).replaceAll("{home}", context.home ?? "").replaceAll("{workspace}", context.workspace ?? "");
}

function expandRecord(value, context) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item, context)]));
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Public terminal did not become ready")), timeoutMs);
    let output = "";
    const onData = (chunk) => {
      output += chunk;
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve();
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Public terminal exited during startup (${code})`)); });
  });
}

async function fileDigest(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

async function directoryDigest(directory) {
  const files = [];
  async function visit(current) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(current, { withFileTypes: true }));
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push([path.relative(directory, absolute).replaceAll("\\", "/"), await fileDigest(absolute)]);
    }
  }
  if (!(await stat(directory).catch(() => undefined))?.isDirectory()) throw new Error(`Delivery directory is missing: ${directory}`);
  await visit(directory);
  return digest(files);
}

function protocolDigest(schema, version, payload) {
  return `sha256:${createHash("sha256").update(`zhixing:${schema}:v${version}\0${canonical(payload)}`).digest("hex")}`;
}

function digest(payload) {
  return `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
