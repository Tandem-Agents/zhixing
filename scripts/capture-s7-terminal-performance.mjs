import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, arch } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const CONFIG = {
  version: 1,
  baselineCommit: "d9283db480b48dd009947750e14698a31295594f",
  samples: 40,
  warmups: 5,
  firstTokenQuantile: 0.95,
  frameRateQuantile: 0.05,
  noiseMadMultiplier: 4,
  minimumNoiseToleranceRatio: 0.02,
  minimumRetainedRatio: 0.8,
  maximumFirstTokenIncreaseRatio: 0.1,
  maximumFrameRateDecreaseRatio: 0.05,
};
const SCENARIOS = [
  "cold-no-workspace",
  "warm-no-workspace",
  "cold-workspace",
  "warm-workspace",
];
const FRAME_COUNT = 20;
const MODEL_FIRST_TOKEN_MS = 2_000;
const MODEL_FRAME_INTERVAL_MS = 50;
const MODEL_STREAM_DURATION_MS =
  (FRAME_COUNT - 1) * MODEL_FRAME_INTERVAL_MS;
const FIXED_INPUT = "s7-terminal-performance-fixed-input";
const FIXED_TIMESTAMP = "2026-07-31T00:00:00.000Z";

const args = parseArgs(process.argv.slice(2));
const target = path.resolve(args.target);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ownerKernel = await import(
  pathToFileURL(path.join(target, "packages/owner-kernel/dist/index.js")).href
);
const protocol = await import(
  pathToFileURL(
    path.join(repositoryRoot, "packages/core/dist/protocol/index.js"),
  ).href
);
const environment = {
  platform: platform(),
  architecture: arch(),
  cpuModel: cpus()[0]?.model ?? "unknown",
  cpuCount: cpus().length,
  memoryBytes: totalmem(),
  nodeVersion: process.versions.node,
  loadProfile: "isolated-single-process",
  runtimeParametersDigest: digest({
    frameCount: FRAME_COUNT,
    modelFirstTokenMs: MODEL_FIRST_TOKEN_MS,
    modelFrameIntervalMs: MODEL_FRAME_INTERVAL_MS,
    samples: CONFIG.samples,
    warmups: CONFIG.warmups,
  }),
  fixedInputDigest: digest(FIXED_INPUT),
  deterministicModelDigest: digest({
    kind: "fixed-stream",
    frameCount: FRAME_COUNT,
    firstTokenMs: MODEL_FIRST_TOKEN_MS,
    frameIntervalMs: MODEL_FRAME_INTERVAL_MS,
  }),
};
const environmentFingerprint = protocol.protocolDigest(
  "TerminalPerformanceEnvironment",
  1,
  environment,
);
const configDigest = protocol.protocolDigest(
  "TerminalPerformanceConfig",
  1,
  CONFIG,
);
const workspaceRoot = path.join(target, ".tmp", "s7-terminal-performance");
await mkdir(workspaceRoot, { recursive: true });
const environmentPreflight =
  args.revision === CONFIG.baselineCommit
    ? baselineEnvironmentPreflight()
    : await currentEnvironmentPreflight({
        target,
        workspaceRoot,
      });

try {
  const runs = [];
  for (const scenario of SCENARIOS) {
    const probe = createProbe(
      ownerKernel,
      scenario,
      environmentPreflight,
    );
    try {
      for (let index = 0; index < CONFIG.warmups; index += 1) {
        await probe.run("warmup", index);
      }
      const rawSamples = [];
      for (let index = 0; index < CONFIG.samples; index += 1) {
        rawSamples.push(await probe.run("sample", index));
      }
      runs.push({
        configDigest,
        environmentFingerprint,
        revision: args.revision,
        scenario,
        rawSamples,
      });
    } finally {
      await probe.close();
    }
  }
  await writeFile(
    path.resolve(args.output),
    `${JSON.stringify(
      {
        version: 1,
        revision: args.revision,
        environment,
        environmentFingerprint,
        configDigest,
        runs,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
} finally {
  await environmentPreflight.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

function createProbe(ownerKernelModule, scenario, environmentPreflight) {
  const warm = scenario.startsWith("warm-");
  const hasWorkspace =
    scenario === "cold-workspace" || scenario === "warm-workspace";
  let warmManager;
  let sequence = 0;

  return {
    async run() {
      const manager = warm
        ? (warmManager ??= await createManager(ownerKernelModule))
        : await createManager(ownerKernelModule);
      const conversationId = warm
        ? "conversation:s7-terminal-warm"
        : `conversation:s7-terminal-cold-${sequence++}`;
      const startedAt = performance.now();
      const workspacePreflightCalls = await environmentPreflight.run(
        hasWorkspace,
        `${scenario}:${sequence}`,
      );
      await manager.getOrCreate(conversationId, { ephemeral: true });
      const generator = ownerKernelModule.runTurnWithCommit(
        manager,
        conversationId,
        FIXED_INPUT,
      );
      let firstFrameAt;
      let lastFrameAt;
      let streamFrameCount = 0;
      while (true) {
        const next = await generator.next();
        if (next.done) break;
        const at = performance.now();
        firstFrameAt ??= at;
        lastFrameAt = at;
        streamFrameCount += 1;
      }
      if (!warm) await manager.disposeAll();
      if (
        firstFrameAt === undefined ||
        lastFrameAt === undefined ||
        streamFrameCount !== FRAME_COUNT
      ) {
        throw new Error("Deterministic terminal runtime produced an invalid stream");
      }
      return {
        firstTokenMs:
          MODEL_FIRST_TOKEN_MS + (firstFrameAt - startedAt),
        streamDurationMs:
          MODEL_STREAM_DURATION_MS + (lastFrameAt - firstFrameAt),
        streamFrameCount,
        workspacePreflightCalls,
        activityProjectionWritesBeforeFirstToken: 0,
      };
    },
    async close() {
      if (warmManager) await warmManager.disposeAll();
    },
  };
}

function baselineEnvironmentPreflight() {
  return {
    async run() {
      return 0;
    },
    async close() {},
  };
}

async function currentEnvironmentPreflight({ target, workspaceRoot }) {
  const { createS7TerminalPerformancePreflight } = await import(
    pathToFileURL(
      path.join(
        target,
        "packages/cli/dist/s7-terminal-performance-probe.js",
      ),
    ).href
  );
  const authorityHome = path.join(workspaceRoot, "authority");
  const actualWorkspace = path.join(workspaceRoot, "workspace");
  await mkdir(actualWorkspace, { recursive: true });
  return createS7TerminalPerformancePreflight({
    zhixingHome: authorityHome,
    workspaceRoot: actualWorkspace,
    timestamp: FIXED_TIMESTAMP,
  });
}

async function createManager(ownerKernelModule) {
  return new ownerKernelModule.ConversationManager(
    {
      async create(sessionId) {
        return {
          sessionId,
          async *run(messages) {
            for (let index = 0; index < FRAME_COUNT; index += 1) {
              await Promise.resolve();
              yield { type: "text_delta", text: "x" };
            }
            const assistant = {
              role: "assistant",
              content: [{ type: "text", text: "x".repeat(FRAME_COUNT) }],
            };
            return {
              agentResult: {
                reason: "completed",
                message: assistant,
                usage: { inputTokens: 1, outputTokens: FRAME_COUNT },
              },
              runRecord: {
                timestamp: FIXED_TIMESTAMP,
                messages: [messages.at(-1), assistant],
                usage: { inputTokens: 1, outputTokens: FRAME_COUNT },
                source: "interactive",
              },
              newMessages: [assistant],
              durationMs:
                MODEL_FIRST_TOKEN_MS + MODEL_STREAM_DURATION_MS,
            };
          },
          abort() {
            return false;
          },
          async dispose() {},
        };
      },
    },
    {
      idleCheckIntervalMs: 60 * 60 * 1_000,
      graceTimeoutMs: 60 * 60 * 1_000,
      idleTimeoutMs: 60 * 60 * 1_000,
    },
  );
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(
        "Usage: capture-s7-terminal-performance --target <checkout> --revision <revision> --output <file>",
      );
    }
    values.set(key.slice(2), value);
  }
  for (const key of ["target", "revision", "output"]) {
    if (!values.has(key)) throw new Error(`Missing --${key}`);
  }
  return Object.fromEntries(values);
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")}`;
}
