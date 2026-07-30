import { canonicalize, protocolDigest } from "@zhixing/core/protocol";

export const S1_RUNTIME_BASELINE_COMMIT =
  "d9283db480b48dd009947750e14698a31295594f";

export interface TerminalPerformanceConfig {
  readonly version: 1;
  readonly baselineCommit: typeof S1_RUNTIME_BASELINE_COMMIT;
  readonly samples: number;
  readonly warmups: number;
  readonly firstTokenQuantile: number;
  readonly frameRateQuantile: number;
  readonly noiseMadMultiplier: number;
  readonly minimumRetainedRatio: number;
  readonly maximumFirstTokenIncreaseRatio: number;
  readonly maximumFrameRateDecreaseRatio: number;
}

export const S7_TERMINAL_PERFORMANCE_CONFIG: TerminalPerformanceConfig = {
  version: 1,
  baselineCommit: S1_RUNTIME_BASELINE_COMMIT,
  samples: 40,
  warmups: 5,
  firstTokenQuantile: 0.95,
  frameRateQuantile: 0.05,
  noiseMadMultiplier: 4,
  minimumRetainedRatio: 0.8,
  maximumFirstTokenIncreaseRatio: 0.1,
  maximumFrameRateDecreaseRatio: 0.05,
};

export type TerminalPerformanceScenario =
  | "cold-no-workspace"
  | "warm-no-workspace"
  | "cold-workspace"
  | "warm-workspace";

export interface TerminalPerformanceSample {
  readonly firstTokenMs: number;
  readonly streamDurationMs: number;
  readonly streamFrameCount: number;
  readonly workspaceFilesystemCalls: number;
  readonly activityProjectionWritesBeforeFirstToken: number;
}

export interface TerminalPerformanceRun {
  readonly configDigest: string;
  readonly environmentFingerprint: string;
  readonly revision: string;
  readonly scenario: TerminalPerformanceScenario;
  readonly rawSamples: readonly TerminalPerformanceSample[];
}

export interface TerminalPerformanceDistribution {
  readonly retainedSamples: number;
  readonly rejectedSamples: number;
  readonly firstTokenMs: number;
  readonly framesPerSecond: number;
}

export interface TerminalPerformanceComparison {
  readonly passed: boolean;
  readonly baseline: TerminalPerformanceDistribution;
  readonly current: TerminalPerformanceDistribution;
  readonly limits: {
    readonly firstTokenMs: number;
    readonly framesPerSecond: number;
  };
  readonly failures: readonly string[];
}

export interface TerminalPerformanceBaselineManifest {
  readonly version: 1;
  readonly baselineCommit: typeof S1_RUNTIME_BASELINE_COMMIT;
  readonly config: Omit<
    TerminalPerformanceConfig,
    "version" | "baselineCommit"
  >;
  readonly scenarios: readonly TerminalPerformanceScenario[];
  readonly capture: {
    readonly environmentFingerprintRequired: true;
    readonly sameHardwareRequired: true;
    readonly deterministicModelRequired: true;
    readonly rawSamplesRequired: true;
  };
}

export interface TerminalPerformanceReport {
  readonly configDigest: string;
  readonly environmentFingerprint: string;
  readonly baselineRevision: typeof S1_RUNTIME_BASELINE_COMMIT;
  readonly currentRevision: string;
  readonly comparisons: Readonly<
    Record<TerminalPerformanceScenario, TerminalPerformanceComparison>
  >;
  readonly passed: boolean;
  readonly raw: {
    readonly baseline: readonly TerminalPerformanceRun[];
    readonly current: readonly TerminalPerformanceRun[];
  };
}

export interface TerminalPerformanceProbe {
  run(
    scenario: TerminalPerformanceScenario,
    phase: "warmup" | "sample",
    index: number,
  ): Promise<TerminalPerformanceSample>;
}

/** Per-sample recorder used by the terminal benchmark composition root. */
export class TerminalPerformanceSampleRecorder {
  readonly #startedAt: number;
  readonly #clock: () => number;
  #firstFrameAt: number | undefined;
  #lastFrameAt: number | undefined;
  #streamFrameCount = 0;
  #workspaceFilesystemCalls = 0;
  #activityProjectionWritesBeforeFirstToken = 0;

  constructor(clock: () => number = () => performance.now()) {
    this.#clock = clock;
    this.#startedAt = clock();
  }

  workspaceFilesystemAccess(): void {
    this.#workspaceFilesystemCalls += 1;
  }

  activityProjectionWrite(): void {
    if (this.#firstFrameAt === undefined) {
      this.#activityProjectionWritesBeforeFirstToken += 1;
    }
  }

  frame(): void {
    const at = this.#clock();
    this.#firstFrameAt ??= at;
    this.#lastFrameAt = at;
    this.#streamFrameCount += 1;
  }

  finish(): TerminalPerformanceSample {
    if (
      this.#firstFrameAt === undefined ||
      this.#lastFrameAt === undefined ||
      this.#streamFrameCount < 2
    ) {
      throw new Error(
        "Terminal performance sample requires at least two stream frames",
      );
    }
    return {
      firstTokenMs: this.#firstFrameAt - this.#startedAt,
      streamDurationMs: this.#lastFrameAt - this.#firstFrameAt,
      streamFrameCount: this.#streamFrameCount,
      workspaceFilesystemCalls: this.#workspaceFilesystemCalls,
      activityProjectionWritesBeforeFirstToken:
        this.#activityProjectionWritesBeforeFirstToken,
    };
  }
}

export const S7_TERMINAL_PERFORMANCE_SCENARIOS = [
  "cold-no-workspace",
  "warm-no-workspace",
  "cold-workspace",
  "warm-workspace",
] as const satisfies readonly TerminalPerformanceScenario[];

export function terminalPerformanceConfigDigest(
  config: TerminalPerformanceConfig = S7_TERMINAL_PERFORMANCE_CONFIG,
): string {
  return protocolDigest("TerminalPerformanceConfig", 1, config);
}

export function terminalPerformanceEnvironmentFingerprint(input: {
  readonly platform: string;
  readonly architecture: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly nodeVersion: string;
  readonly loadProfile: string;
  readonly runtimeParametersDigest: string;
  readonly fixedInputDigest: string;
  readonly deterministicModelDigest: string;
}): string {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string") requireText(value, name);
    else if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Performance environment ${name} is invalid`);
    }
  }
  return protocolDigest("TerminalPerformanceEnvironment", 1, input);
}

export function validateTerminalPerformanceBaselineManifest(
  value: unknown,
): TerminalPerformanceBaselineManifest {
  const expected: TerminalPerformanceBaselineManifest = {
    version: 1,
    baselineCommit: S1_RUNTIME_BASELINE_COMMIT,
    config: {
      samples: S7_TERMINAL_PERFORMANCE_CONFIG.samples,
      warmups: S7_TERMINAL_PERFORMANCE_CONFIG.warmups,
      firstTokenQuantile:
        S7_TERMINAL_PERFORMANCE_CONFIG.firstTokenQuantile,
      frameRateQuantile: S7_TERMINAL_PERFORMANCE_CONFIG.frameRateQuantile,
      noiseMadMultiplier:
        S7_TERMINAL_PERFORMANCE_CONFIG.noiseMadMultiplier,
      minimumRetainedRatio:
        S7_TERMINAL_PERFORMANCE_CONFIG.minimumRetainedRatio,
      maximumFirstTokenIncreaseRatio:
        S7_TERMINAL_PERFORMANCE_CONFIG.maximumFirstTokenIncreaseRatio,
      maximumFrameRateDecreaseRatio:
        S7_TERMINAL_PERFORMANCE_CONFIG.maximumFrameRateDecreaseRatio,
    },
    scenarios: [...S7_TERMINAL_PERFORMANCE_SCENARIOS],
    capture: {
      environmentFingerprintRequired: true,
      sameHardwareRequired: true,
      deterministicModelRequired: true,
      rawSamplesRequired: true,
    },
  };
  if (canonicalize(value) !== canonicalize(expected)) {
    throw new TypeError("Terminal performance baseline manifest is not canonical");
  }
  return expected;
}

export function createTerminalPerformanceRun(input: Omit<
  TerminalPerformanceRun,
  "configDigest"
> & {
  readonly config?: TerminalPerformanceConfig;
}): TerminalPerformanceRun {
  const config = input.config ?? S7_TERMINAL_PERFORMANCE_CONFIG;
  if (input.rawSamples.length !== config.samples) {
    throw new TypeError("Terminal performance sample count is not canonical");
  }
  assertEnvironmentFingerprint(input.environmentFingerprint);
  input.rawSamples.forEach((sample) =>
    validateSample(sample, input.scenario),
  );
  return {
    configDigest: terminalPerformanceConfigDigest(config),
    environmentFingerprint: input.environmentFingerprint,
    revision: requireText(input.revision, "performance revision"),
    scenario: input.scenario,
    rawSamples: input.rawSamples.map((sample) => ({ ...sample })),
  };
}

export async function captureTerminalPerformance(input: {
  readonly environmentFingerprint: string;
  readonly revision: string;
  readonly scenario: TerminalPerformanceScenario;
  readonly probe: TerminalPerformanceProbe;
  readonly config?: TerminalPerformanceConfig;
}): Promise<TerminalPerformanceRun> {
  const config = input.config ?? S7_TERMINAL_PERFORMANCE_CONFIG;
  for (let index = 0; index < config.warmups; index += 1) {
    validateSample(
      await input.probe.run(input.scenario, "warmup", index),
      input.scenario,
    );
  }
  const rawSamples: TerminalPerformanceSample[] = [];
  for (let index = 0; index < config.samples; index += 1) {
    rawSamples.push(
      await input.probe.run(input.scenario, "sample", index),
    );
  }
  return createTerminalPerformanceRun({
    config,
    environmentFingerprint: input.environmentFingerprint,
    revision: input.revision,
    scenario: input.scenario,
    rawSamples,
  });
}

export async function captureTerminalPerformanceMatrix(input: {
  readonly environmentFingerprint: string;
  readonly revision: string;
  readonly probe: TerminalPerformanceProbe;
  readonly config?: TerminalPerformanceConfig;
}): Promise<readonly TerminalPerformanceRun[]> {
  const runs: TerminalPerformanceRun[] = [];
  for (const scenario of S7_TERMINAL_PERFORMANCE_SCENARIOS) {
    runs.push(await captureTerminalPerformance({ ...input, scenario }));
  }
  return runs;
}

export function compareTerminalPerformance(
  baseline: TerminalPerformanceRun,
  current: TerminalPerformanceRun,
  config: TerminalPerformanceConfig = S7_TERMINAL_PERFORMANCE_CONFIG,
): TerminalPerformanceComparison {
  const digest = terminalPerformanceConfigDigest(config);
  if (baseline.configDigest !== digest || current.configDigest !== digest) {
    throw new TypeError("Terminal performance configuration does not match");
  }
  if (
    baseline.environmentFingerprint !== current.environmentFingerprint
  ) {
    throw new TypeError(
      "Terminal performance runs were captured in different environments",
    );
  }
  if (baseline.scenario !== current.scenario) {
    throw new TypeError("Terminal performance scenarios do not match");
  }
  if (baseline.revision !== config.baselineCommit) {
    throw new TypeError("Terminal performance baseline revision is not frozen");
  }
  const baselineDistribution = analyzeRun(baseline, config);
  const currentDistribution = analyzeRun(current, config);
  const limits = {
    firstTokenMs:
      baselineDistribution.firstTokenMs *
      (1 + config.maximumFirstTokenIncreaseRatio),
    framesPerSecond:
      baselineDistribution.framesPerSecond *
      (1 - config.maximumFrameRateDecreaseRatio),
  };
  const failures: string[] = [];
  if (currentDistribution.firstTokenMs > limits.firstTokenMs) {
    failures.push("first-token-latency");
  }
  if (currentDistribution.framesPerSecond < limits.framesPerSecond) {
    failures.push("stream-frame-rate");
  }
  return {
    passed: failures.length === 0,
    baseline: baselineDistribution,
    current: currentDistribution,
    limits,
    failures,
  };
}

export function compareTerminalPerformanceMatrix(input: {
  readonly baseline: readonly TerminalPerformanceRun[];
  readonly current: readonly TerminalPerformanceRun[];
  readonly config?: TerminalPerformanceConfig;
}): TerminalPerformanceReport {
  const config = input.config ?? S7_TERMINAL_PERFORMANCE_CONFIG;
  const baseline = indexRuns(input.baseline, "baseline");
  const current = indexRuns(input.current, "current");
  const comparisons = {} as Record<
    TerminalPerformanceScenario,
    TerminalPerformanceComparison
  >;
  let environmentFingerprint: string | undefined;
  let currentRevision: string | undefined;
  for (const scenario of S7_TERMINAL_PERFORMANCE_SCENARIOS) {
    const baselineRun = baseline.get(scenario);
    const currentRun = current.get(scenario);
    if (!baselineRun || !currentRun) {
      throw new TypeError("Terminal performance matrix is incomplete");
    }
    environmentFingerprint ??= baselineRun.environmentFingerprint;
    currentRevision ??= currentRun.revision;
    if (
      baselineRun.environmentFingerprint !== environmentFingerprint ||
      currentRun.environmentFingerprint !== environmentFingerprint ||
      currentRun.revision !== currentRevision
    ) {
      throw new TypeError(
        "Terminal performance matrix mixes environments or revisions",
      );
    }
    comparisons[scenario] = compareTerminalPerformance(
      baselineRun,
      currentRun,
      config,
    );
  }
  return {
    configDigest: terminalPerformanceConfigDigest(config),
    environmentFingerprint: requireText(
      environmentFingerprint,
      "performance environment fingerprint",
    ),
    baselineRevision: S1_RUNTIME_BASELINE_COMMIT,
    currentRevision: requireText(
      currentRevision,
      "current performance revision",
    ),
    comparisons,
    passed: Object.values(comparisons).every(({ passed }) => passed),
    raw: {
      baseline: input.baseline.map(cloneRun),
      current: input.current.map(cloneRun),
    },
  };
}

export function analyzeRun(
  run: TerminalPerformanceRun,
  config: TerminalPerformanceConfig = S7_TERMINAL_PERFORMANCE_CONFIG,
): TerminalPerformanceDistribution {
  const retained = rejectNoise(run.rawSamples, config);
  if (retained.length < Math.ceil(run.rawSamples.length * config.minimumRetainedRatio)) {
    throw new Error("Terminal performance run contains excessive noise");
  }
  return {
    retainedSamples: retained.length,
    rejectedSamples: run.rawSamples.length - retained.length,
    firstTokenMs: quantile(
      retained.map(({ firstTokenMs }) => firstTokenMs),
      config.firstTokenQuantile,
    ),
    framesPerSecond: quantile(
      retained.map(framesPerSecond),
      config.frameRateQuantile,
    ),
  };
}

export function serializeTerminalPerformanceRun(
  run: TerminalPerformanceRun,
): string {
  return `${canonicalize(run)}\n`;
}

export function serializeTerminalPerformanceReport(
  report: TerminalPerformanceReport,
): string {
  return `${canonicalize(report)}\n`;
}

function indexRuns(
  runs: readonly TerminalPerformanceRun[],
  label: string,
): Map<TerminalPerformanceScenario, TerminalPerformanceRun> {
  const indexed = new Map<TerminalPerformanceScenario, TerminalPerformanceRun>();
  for (const run of runs) {
    if (indexed.has(run.scenario)) {
      throw new TypeError(`Terminal performance ${label} scenario is duplicated`);
    }
    indexed.set(run.scenario, run);
  }
  if (indexed.size !== S7_TERMINAL_PERFORMANCE_SCENARIOS.length) {
    throw new TypeError(`Terminal performance ${label} matrix is incomplete`);
  }
  return indexed;
}

function cloneRun(run: TerminalPerformanceRun): TerminalPerformanceRun {
  return {
    ...run,
    rawSamples: run.rawSamples.map((sample) => ({ ...sample })),
  };
}

function rejectNoise(
  samples: readonly TerminalPerformanceSample[],
  config: TerminalPerformanceConfig,
): readonly TerminalPerformanceSample[] {
  const latencyMedian = quantile(
    samples.map(({ firstTokenMs }) => firstTokenMs),
    0.5,
  );
  const rateMedian = quantile(samples.map(framesPerSecond), 0.5);
  const latencyMad = medianAbsoluteDeviation(
    samples.map(({ firstTokenMs }) => firstTokenMs),
    latencyMedian,
  );
  const rateMad = medianAbsoluteDeviation(
    samples.map(framesPerSecond),
    rateMedian,
  );
  return samples.filter((sample) => {
    const latencyDistance = Math.abs(sample.firstTokenMs - latencyMedian);
    const rateDistance = Math.abs(framesPerSecond(sample) - rateMedian);
    return (
      (latencyMad === 0
        ? latencyDistance === 0
        : latencyDistance <= latencyMad * config.noiseMadMultiplier) &&
      (rateMad === 0
        ? rateDistance === 0
        : rateDistance <= rateMad * config.noiseMadMultiplier)
    );
  });
}

function validateSample(
  sample: TerminalPerformanceSample,
  scenario: TerminalPerformanceScenario,
): void {
  for (const [name, value] of Object.entries(sample)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`Terminal performance ${name} is invalid`);
    }
  }
  if (
    !Number.isSafeInteger(sample.streamFrameCount) ||
    sample.streamFrameCount < 2 ||
    !Number.isSafeInteger(sample.workspaceFilesystemCalls) ||
    !Number.isSafeInteger(sample.activityProjectionWritesBeforeFirstToken)
  ) {
    throw new TypeError("Terminal performance counters are invalid");
  }
  const hasWorkspace =
    scenario === "cold-workspace" || scenario === "warm-workspace";
  if (
    sample.workspaceFilesystemCalls !== (hasWorkspace ? 1 : 0) ||
    sample.activityProjectionWritesBeforeFirstToken !== 0
  ) {
    throw new Error(
      "Terminal startup path violates the environment/workscene hot-path contract",
    );
  }
}

function framesPerSecond(sample: TerminalPerformanceSample): number {
  if (sample.streamDurationMs <= 0) {
    throw new TypeError("Terminal stream duration must be positive");
  }
  return ((sample.streamFrameCount - 1) * 1_000) / sample.streamDurationMs;
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0 || q < 0 || q > 1) {
    throw new TypeError("Performance quantile input is invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function medianAbsoluteDeviation(
  values: readonly number[],
  median: number,
): number {
  return quantile(values.map((value) => Math.abs(value - median)), 0.5);
}

function assertEnvironmentFingerprint(value: string): void {
  requireText(value, "environment fingerprint");
  if (!value.startsWith("sha256:")) {
    throw new TypeError("Environment fingerprint must be a canonical digest");
  }
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}
