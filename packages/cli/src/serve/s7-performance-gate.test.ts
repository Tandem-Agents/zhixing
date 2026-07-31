import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  analyzeRun,
  assertComparableTerminalPerformanceCaptures,
  captureTerminalPerformanceMatrix,
  compareTerminalPerformanceMatrix,
  compareTerminalPerformance,
  createTerminalPerformanceRun,
  S1_RUNTIME_BASELINE_COMMIT,
  S7_TERMINAL_PERFORMANCE_CONFIG,
  TerminalPerformanceSampleRecorder,
  terminalPerformanceEnvironmentFingerprint,
  validateTerminalPerformanceBaselineManifest,
  validateTerminalPerformanceCaptureAsset,
  type TerminalPerformanceSample,
  type TerminalPerformanceScenario,
} from "./s7-performance-gate.js";

const ENVIRONMENT = protocolDigest("PerformanceEnvironment", 1, {
  platform: "test",
  cpu: "deterministic",
  node: "fixed",
});
const CURRENT_CAPTURE =
  process.env.ZHIXING_S7_CURRENT_PERFORMANCE_CAPTURE;

describe("S7 terminal performance gate", () => {
  it("records first-token, stream cadence and pre-token work from one monotonic clock", () => {
    const times = [100, 108, 118, 128];
    const recorder = new TerminalPerformanceSampleRecorder(() => times.shift()!);
    recorder.workspacePreflight();
    recorder.frame();
    recorder.activityProjectionWrite();
    recorder.frame();
    recorder.frame();
    expect(recorder.finish()).toEqual({
      firstTokenMs: 8,
      streamDurationMs: 20,
      streamFrameCount: 3,
      workspacePreflightCalls: 1,
      activityProjectionWritesBeforeFirstToken: 0,
    });
  });

  it("loads the frozen S1 capture manifest and derives reproducible environment identity", async () => {
    const manifest = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            "./fixtures/s1-terminal-performance-baseline.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    );
    expect(validateTerminalPerformanceBaselineManifest(manifest)).toMatchObject({
      baselineCommit: S1_RUNTIME_BASELINE_COMMIT,
      scenarios: [
        "cold-no-workspace",
        "warm-no-workspace",
        "cold-workspace",
        "warm-workspace",
      ],
    });
    const environment = {
      platform: "linux",
      architecture: "x64",
      cpuModel: "deterministic-cpu",
      cpuCount: 8,
      memoryBytes: 16 * 1024 * 1024 * 1024,
      nodeVersion: "22.17.0",
      loadProfile: "isolated",
      runtimeParametersDigest: "sha256:runtime",
      fixedInputDigest: "sha256:input",
      deterministicModelDigest: "sha256:model",
    };
    expect(terminalPerformanceEnvironmentFingerprint(environment)).toBe(
      terminalPerformanceEnvironmentFingerprint({ ...environment }),
    );
  });

  it("loads a complete raw S1 capture rather than synthesizing the baseline", async () => {
    const baseline = await readCapture(
      new URL(
        "./fixtures/s1-terminal-performance-capture.json",
        import.meta.url,
      ),
    );
    expect(baseline).toMatchObject({
      revision: S1_RUNTIME_BASELINE_COMMIT,
      environmentFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(baseline.runs).toHaveLength(4);
    expect(
      baseline.runs.every(
        ({ rawSamples }) =>
          rawSamples.length === S7_TERMINAL_PERFORMANCE_CONFIG.samples,
      ),
    ).toBe(true);
  });

  it("requires one external driver and an equivalent version-specific scenario setup", async () => {
    const baseline = await readCapture(
      new URL(
        "./fixtures/s1-terminal-performance-capture.json",
        import.meta.url,
      ),
    );
    const current = {
      ...baseline,
      revision: "current",
      delivery: {
        ...baseline.delivery,
        sourceRevision: "current",
        setupAdapterDigest: protocolDigest("SetupAdapter", 1, {
          version: "current",
        }),
      },
      runs: baseline.runs.map((run) => ({ ...run, revision: "current" })),
    };
    expect(() =>
      assertComparableTerminalPerformanceCaptures({ baseline, current }),
    ).not.toThrow();
    expect(() =>
      assertComparableTerminalPerformanceCaptures({
        baseline,
        current: {
          ...current,
          delivery: {
            ...current.delivery,
            scenarioSetupDigest: protocolDigest("ScenarioSetup", 1, {
              workspace: "different",
            }),
          },
        },
      }),
    ).toThrow("prepared equivalently");
    expect(() =>
      assertComparableTerminalPerformanceCaptures({
        baseline,
        current: {
          ...current,
          delivery: {
            ...current.delivery,
            harnessDigest: protocolDigest("Harness", 1, {
              driver: "different",
            }),
          },
        },
      }),
    ).toThrow("same external driver");
  });

  it.runIf(CURRENT_CAPTURE)(
    "compares a live current production capture with the same-machine S1 asset",
    async () => {
      const baseline = await readCapture(
        new URL(
          "./fixtures/s1-terminal-performance-capture.json",
          import.meta.url,
        ),
      );
      const current = await readCapture(pathToFileURL(CURRENT_CAPTURE!));
      expect(
        compareTerminalPerformanceMatrix({
          baseline: baseline.runs,
          current: current.runs,
        }),
      ).toMatchObject({ passed: true });
    },
  );

  it("rejects threshold regressions and mismatched environments", () => {
    const baseline = run(
      S1_RUNTIME_BASELINE_COMMIT,
      "warm-workspace",
      samples(
        "warm-workspace",
        100,
        20,
        S1_RUNTIME_BASELINE_COMMIT,
      ),
    );
    const regression = run(
      "current",
      "warm-workspace",
      samples("warm-workspace", 120, 17),
    );
    expect(compareTerminalPerformance(baseline, regression)).toMatchObject({
      passed: false,
      failures: ["first-token-latency", "stream-frame-rate"],
    });
    expect(() =>
      compareTerminalPerformance(baseline, {
        ...regression,
        environmentFingerprint: protocolDigest(
          "PerformanceEnvironment",
          1,
          { platform: "other" },
        ),
      }),
    ).toThrow("different environments");
  });

  it("mechanically rejects workspace and activity work in the wrong startup path", () => {
    expect(() =>
      run(
        "current",
        "warm-no-workspace",
        samples("warm-no-workspace", 100, 20).map((sample, index) =>
          index === 0
            ? { ...sample, workspacePreflightCalls: 1 }
            : sample,
        ),
      ),
    ).toThrow("hot-path contract");
    expect(() =>
      run(
        "current",
        "warm-workspace",
        samples("warm-workspace", 100, 20).map((sample, index) =>
          index === 0
            ? { ...sample, activityProjectionWritesBeforeFirstToken: 1 }
            : sample,
        ),
      ),
    ).toThrow("hot-path contract");
  });

  it("captures the complete cold/warm × workspace matrix with canonical warmups", async () => {
    const calls: string[] = [];
    const runs = await captureTerminalPerformanceMatrix({
      environmentFingerprint: ENVIRONMENT,
      revision: "current",
      probe: {
        async run(scenario, phase, index) {
          calls.push(`${scenario}:${phase}:${index}`);
          return samples(scenario, 100, 20)[0]!;
        },
      },
    });

    expect(runs.map(({ scenario }) => scenario)).toEqual([
      "cold-no-workspace",
      "warm-no-workspace",
      "cold-workspace",
      "warm-workspace",
    ]);
    expect(calls).toHaveLength(
      4 *
        (S7_TERMINAL_PERFORMANCE_CONFIG.warmups +
          S7_TERMINAL_PERFORMANCE_CONFIG.samples),
    );
  });

  it("produces one auditable comparison report for the complete matrix", () => {
    const baseline = matrix(S1_RUNTIME_BASELINE_COMMIT, 100, 20);
    const current = matrix("current", 108, 19.2);
    const report = compareTerminalPerformanceMatrix({ baseline, current });
    expect(report).toMatchObject({
      passed: true,
      baselineRevision: S1_RUNTIME_BASELINE_COMMIT,
      currentRevision: "current",
      environmentFingerprint: ENVIRONMENT,
    });
    expect(Object.keys(report.comparisons).sort()).toEqual(
      [
        "cold-no-workspace",
        "warm-no-workspace",
        "cold-workspace",
        "warm-workspace",
      ].sort(),
    );
    expect(report.raw.baseline).toHaveLength(4);
    expect(() =>
      compareTerminalPerformanceMatrix({
        baseline: baseline.slice(1),
        current,
      }),
    ).toThrow("incomplete");
  });

  it("rejects an outlier when an otherwise constant distribution has zero MAD", () => {
    const raw = samples("warm-no-workspace", 100, 20).map((sample) => ({
      ...sample,
      firstTokenMs: 100,
    }));
    raw[raw.length - 1] = {
      ...raw[raw.length - 1]!,
      firstTokenMs: 10_000,
    };
    const distribution = analyzeRun(
      run("current", "warm-no-workspace", raw),
    );
    expect(distribution.rejectedSamples).toBeGreaterThan(0);
  });
});

function run(
  revision: string,
  scenario: TerminalPerformanceScenario,
  rawSamples: readonly TerminalPerformanceSample[],
) {
  return createTerminalPerformanceRun({
    environmentFingerprint: ENVIRONMENT,
    revision,
    scenario,
    rawSamples,
  });
}

function samples(
  scenario: TerminalPerformanceScenario,
  firstTokenMs: number,
  framesPerSecond: number,
  revision = "current",
): TerminalPerformanceSample[] {
  const requiresWorkspacePreflight =
    revision !== S1_RUNTIME_BASELINE_COMMIT &&
    (scenario === "cold-workspace" || scenario === "warm-workspace");
  return Array.from(
    { length: S7_TERMINAL_PERFORMANCE_CONFIG.samples },
    (_, index) => ({
      firstTokenMs: firstTokenMs + ((index % 5) - 2) * 0.2,
      streamDurationMs: (19 * 1_000) / framesPerSecond,
      streamFrameCount: 20,
      workspacePreflightCalls: requiresWorkspacePreflight ? 1 : 0,
      activityProjectionWritesBeforeFirstToken: 0,
    }),
  );
}

function matrix(
  revision: string,
  firstTokenMs: number,
  framesPerSecond: number,
) {
  return (
    [
      "cold-no-workspace",
      "warm-no-workspace",
      "cold-workspace",
      "warm-workspace",
    ] as const
  ).map((scenario) =>
    run(
      revision,
      scenario,
      samples(scenario, firstTokenMs, framesPerSecond, revision),
    ),
  );
}

async function readCapture(location: URL) {
  return validateTerminalPerformanceCaptureAsset(
    JSON.parse(await readFile(fileURLToPath(location), "utf8")),
  );
}
