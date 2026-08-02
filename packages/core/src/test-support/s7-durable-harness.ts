import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DurableRuntimeContractDescriptor } from "../contracts/durable-contract.js";

export type DurableCaseKind = "variant" | "rejection" | "corruption";

export interface S7ExecutableScenarioObservation {
  readonly family: string;
  readonly kind: DurableCaseKind;
  readonly caseKey: string;
  readonly reasonCode?: string;
  readonly evidence: string;
}

export type S7ExecutableScenario = () => Promise<S7ExecutableScenarioObservation>;

export function defineS7DurableScenarios(
  descriptor: DurableRuntimeContractDescriptor,
  implementations: Readonly<Record<string, () => Promise<void>>>,
): ReadonlyMap<string, S7ExecutableScenario> {
  const expected = descriptor.cases
    .map(({ kind, key }) => `${kind}:${key}`)
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const actual = Object.keys(implementations)
    .sort((left, right) => left.localeCompare(right, "en-US"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((key) => !(key in implementations));
    const extra = actual.filter((key) => !expected.includes(key));
    throw new TypeError(
      `${descriptor.recordFamily} S7 scenarios are not exact; missing=${missing.join("|")}; extra=${extra.join("|")}`,
    );
  }
  return new Map(descriptor.cases.map(({ kind, key }) => {
    const execute = implementations[`${kind}:${key}`]!;
    return [
      `${descriptor.recordFamily}:${kind}:${key}`,
      observedScenario(descriptor.recordFamily, kind, key, execute),
    ] as const;
  }));
}

interface ScenarioEvidence {
  readonly details: string[];
  readonly outcomes: Array<{ readonly kind: DurableCaseKind; readonly caseKey: string }>;
  readonly reasonCodes: Set<string>;
  readonly temporaryDirectories: Set<string>;
  readonly cleanups: Array<() => void | Promise<void>>;
}

const evidenceContext = new AsyncLocalStorage<ScenarioEvidence>();
const temporaryDirectoryRootContext = new AsyncLocalStorage<string>();

export async function withS7TemporaryDirectoryRoot<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  return temporaryDirectoryRootContext.run(root, operation);
}

export function observedScenario(
  family: string,
  kind: DurableCaseKind,
  caseKey: string,
  execute: () => Promise<void>,
): S7ExecutableScenario {
  return scenario({ family }, kind, caseKey, execute);
}

function scenario(
  runtime: { readonly family: string },
  kind: DurableCaseKind,
  caseKey: string,
  execute: () => Promise<void>,
): S7ExecutableScenario {
  return async () => {
    const evidence: ScenarioEvidence = {
      details: [],
      outcomes: [],
      reasonCodes: new Set(),
      temporaryDirectories: new Set(),
      cleanups: [],
    };
    try {
      await evidenceContext.run(evidence, async () => {
        await execute();
      });
      if (evidence.details.length === 0) {
        throw new Error(
          `S7 scenario ${runtime.family}:${kind}:${caseKey} did not observe a production fact`,
        );
      }
      const outcome = onlyObserved(evidence.outcomes, "durable outcome", runtime.family, kind, caseKey);
      const reasonCode = outcome.kind === "variant"
        ? undefined
        : onlyObserved(evidence.reasonCodes, "typed reason code", runtime.family, kind, caseKey);
      return {
        family: runtime.family,
        kind: outcome.kind,
        caseKey: outcome.caseKey,
        ...(reasonCode === undefined ? {} : { reasonCode }),
        evidence: evidence.details.join(" | "),
      };
    } finally {
      for (const cleanup of [...evidence.cleanups].reverse()) {
        await cleanup();
      }
      await Promise.all(
        [...evidence.temporaryDirectories].map((directory) =>
          rm(directory, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
          })),
      );
    }
  };
}

export function registerS7Cleanup(cleanup: () => void | Promise<void>): void {
  const evidence = evidenceContext.getStore();
  if (!evidence) {
    throw new Error("S7 cleanup was registered outside a scenario");
  }
  evidence.cleanups.push(cleanup);
}

export async function createS7TempDir(prefix: string): Promise<string> {
  const root = temporaryDirectoryRootContext.getStore();
  if (!root) {
    throw new Error("S7 temporary directory root was not provided by the test owner");
  }
  const directory = path.join(root, `${prefix}-${randomUUID()}`);
  await mkdir(directory);
  const evidence = evidenceContext.getStore();
  if (!evidence) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("S7 temporary directory was created outside a scenario");
  }
  evidence.temporaryDirectories.add(directory);
  return directory;
}

function onlyObserved<T>(
  values: Iterable<T>,
  label: string,
  family: string,
  kind: DurableCaseKind,
  caseKey: string,
): T {
  const observed = [...values];
  if (observed.length !== 1) {
    throw new Error(
      `S7 scenario ${family}:${kind}:${caseKey} observed ${observed.length} ${label} values`,
    );
  }
  return observed[0]!;
}

export function observeOutcome(
  outcome: Readonly<{ kind: DurableCaseKind; caseKey: string }>,
): void {
  const outcomes = evidenceContext.getStore()?.outcomes;
  if (!outcomes) return;
  if (!outcomes.some((candidate) =>
    candidate.kind === outcome.kind && candidate.caseKey === outcome.caseKey)) {
    outcomes.push(outcome);
  }
}

export function observeError(error: Error): void {
  const reasonCode = "reasonCode" in error &&
      typeof (error as { reasonCode?: unknown }).reasonCode === "string"
    ? (error as { reasonCode: string }).reasonCode
    : "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  evidenceContext.getStore()?.details.push(
    `error:${reasonCode ?? "untyped"}:${error.message}`,
  );
  if (reasonCode !== undefined) {
    evidenceContext.getStore()?.reasonCodes.add(reasonCode);
  }
}

export function observeReasonCode(reasonCode: string, detail: string): void {
  if (!/^[A-Z][A-Z0-9_]+$/u.test(reasonCode)) {
    throw new Error(`S7 typed reason code is not stable: ${reasonCode}`);
  }
  const evidence = evidenceContext.getStore();
  evidence?.reasonCodes.add(reasonCode);
  evidence?.details.push(`decision:${reasonCode}:${detail}`);
}

export async function expectFailure(
  operation: () => Promise<unknown>,
  fragment: string,
  outcome?: Readonly<{ kind: "rejection" | "corruption"; caseKey: string }>,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected failure containing ${fragment}`);
  assert(
    caught.message.toLowerCase().includes(fragment.toLowerCase()),
    `failure did not contain ${fragment}: ${caught.message}`,
  );
  observeError(caught);
  if (outcome) observeOutcome(outcome);
}

export function assert(
  condition: unknown,
  message: string,
  outcome?: Readonly<{ kind: DurableCaseKind; caseKey: string }>,
): asserts condition {
  if (!condition) throw new Error(message);
  evidenceContext.getStore()?.details.push(`assert:${message}`);
  if (outcome) observeOutcome(outcome);
}
