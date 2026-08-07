import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  Digest,
  EnvironmentPort,
  EvidenceExecutionResult,
  EvidenceHandlerPort,
  EvidenceRequest,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  canonicalize,
  createSignedEvidenceBundle,
  evidenceObservationStateFingerprint,
  evidenceRequestDigest,
  validateEvidenceRequest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { scrubSecrets } from "@zhixing/core/security";
import { runWithDeviceCapacity } from "@zhixing/core/resources";
import type { EvidenceKind, EvidenceLocator } from "@zhixing/core/advancement";
import { PathGuard } from "@zhixing/core";
import type { AgentRuntimeCapacityBinding } from "../runtime/governed-agent-runtime.js";
import { EvidenceJournal } from "./evidence-journal.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const SUMMARY_LIMIT = 1_000;

type ObservationState =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly contentDigest: Digest };

interface CollectedItem {
  readonly kind: EvidenceKind;
  readonly locator: EvidenceLocator;
  readonly state: ObservationState;
  readonly bytes?: Uint8Array;
  readonly summary?: string;
}

class StaleEvidenceObservationError extends Error {}

export interface ExecutorEvidenceHandlerOptions {
  readonly executorId: string;
  readonly environment: EnvironmentPort;
  readonly journal: EvidenceJournal;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly capacity?: AgentRuntimeCapacityBinding;
  /** Must reject stale authority before any journal or workspace read. */
  readonly verifyCurrentOwner: (request: EvidenceRequest) => Promise<void> | void;
  readonly now?: () => string;
  /** 测试故障注入：pre 采样完成后、post 采样前执行。 */
  readonly betweenObservations?: () => Promise<void>;
  /** 测试故障注入：句柄身份取样后、读取内容前执行。 */
  readonly afterFileOpened?: (canonicalPath: string) => Promise<void>;
}

/** executor 角色的只读取证入口；全部文件访问都发生在协议与身份守卫之后。 */
export class ExecutorEvidenceHandler implements EvidenceHandlerPort {
  readonly #options: ExecutorEvidenceHandlerOptions;
  readonly #now: () => string;
  readonly #inflight = new Map<string, Promise<EvidenceExecutionResult>>();
  #accepting = true;

  constructor(options: ExecutorEvidenceHandlerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async collect(
    raw: EvidenceRequest,
    abort: AbortSignal,
  ): Promise<EvidenceExecutionResult> {
    if (!this.#accepting) {
      throw new Error("Executor evidence handler is stopping");
    }
    const request = validateEvidenceRequest(raw, this.#options.verifier);
    this.#assertRequestBinding(request);
    await this.#options.verifyCurrentOwner(request);
    const replay = await this.#options.journal.replay(request);
    if (replay) return replay;
    this.#assertRequestFresh(request);
    const existing = this.#inflight.get(request.requestId);
    if (existing) return await existing;
    const operation = this.#collectOnce(request, abort).finally(() => {
      if (this.#inflight.get(request.requestId) === operation) {
        this.#inflight.delete(request.requestId);
      }
    });
    this.#inflight.set(request.requestId, operation);
    return await operation;
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  #assertRequestBinding(request: EvidenceRequest): void {
    if (request.executorId !== this.#options.executorId) {
      throw new TypeError("Evidence request targets another executor");
    }
    if (
      !request.lease.parentId ||
      !request.lease.parentDigest ||
      Date.parse(request.expiry) > Date.parse(request.lease.expiry)
    ) {
      throw new TypeError("Evidence request is not bounded by its child lease");
    }
  }

  #assertRequestFresh(request: EvidenceRequest): void {
    const now = Date.parse(this.#now());
    if (Date.parse(request.expiry) <= now || Date.parse(request.lease.expiry) <= now) {
      throw new TypeError("Evidence request or lease has expired");
    }
  }

  async #collectOnce(
    request: EvidenceRequest,
    abort: AbortSignal,
  ): Promise<EvidenceExecutionResult> {
    const begin = await this.#options.journal.begin(request);
    if (begin.kind === "replay") return begin.result;
    abort.throwIfAborted();

    const descriptor = await this.#options.environment.capabilitySnapshot();
    const workspace = descriptor.workspaces.find(
      (candidate) => candidate.bindingRef === request.workspace.bindingRef,
    );
    const requiredKinds = new Set(request.items.map((item) => item.kind));
    if (
      descriptor.executorId !== request.executorId ||
      !workspace ||
      workspace.workspaceBindingRevision !== request.workspace.workspaceBindingRevision ||
      [...requiredKinds].some((kind) => !descriptor.evidenceCapabilities.includes(kind))
    ) {
      return await this.#options.journal.complete(request, {
        kind: "capability-gap",
      });
    }
    const resolved = await this.#options.environment.resolveWorkspace(
      request.workspace.bindingRef,
    );
    if (
      resolved.workspaceBindingRevision !== request.workspace.workspaceBindingRevision
    ) {
      return await this.#options.journal.complete(request, {
        kind: "capability-gap",
      });
    }

    const execute = () => this.#observe(request, resolved.absolutePath, abort);
    const capacity = this.#options.capacity;
    const result = capacity
      ? await runWithDeviceCapacity(
          capacity.arbiter,
          {
            serviceClass: "workload-advancement",
            atomic: capacity.atomic,
            preferred: capacity.preferred,
            maxWaitMs: capacity.maxWaitMs,
          },
          abort,
          execute,
        )
      : await execute();
    return await this.#options.journal.complete(request, result);
  }

  async #observe(
    request: EvidenceRequest,
    workspaceRoot: string,
    abort: AbortSignal,
  ): Promise<EvidenceExecutionResult> {
    let pre: CollectedItem[];
    let post: CollectedItem[];
    try {
      pre = await this.#collectStates(request, workspaceRoot, abort);
      await this.#options.betweenObservations?.();
      post = await this.#collectStates(request, workspaceRoot, abort);
    } catch (error) {
      if (!(error instanceof StaleEvidenceObservationError)) throw error;
      return staleBundle(request, this.#options.signer, this.#now());
    }
    const preStateFingerprint = fingerprint(pre);
    const postStateFingerprint = fingerprint(post);
    const consistent = preStateFingerprint === postStateFingerprint;

    const bundleItems = pre.flatMap((item, index) => {
      const requested = request.items[index]!;
      if (
        item.state.kind !== "present" ||
        !item.bytes ||
        !item.summary ||
        (requested.digestHint && requested.digestHint !== item.state.contentDigest)
      ) {
        return [];
      }
      return [
        {
          kind: item.kind,
          locator: item.locator,
          contentDigest: item.state.contentDigest,
          summary: item.summary,
          source: "independent" as const,
        },
      ];
    });
    if (bundleItems.length === 0) return { kind: "capability-gap" };
    return {
      kind: "bundle",
      bundle: createSignedEvidenceBundle(
        {
          v: 1,
          requestId: request.requestId,
          requestDigest: evidenceRequestDigest(request),
          observation: {
            observedAt: this.#now(),
            preStateFingerprint,
            postStateFingerprint,
            consistent,
          },
          items: bundleItems,
          executorId: request.executorId,
        },
        this.#options.signer,
      ),
    };
  }

  async #collectStates(
    request: EvidenceRequest,
    workspaceRoot: string,
    abort: AbortSignal,
  ): Promise<CollectedItem[]> {
    const out: CollectedItem[] = [];
    for (const item of request.items) {
      abort.throwIfAborted();
      out.push(
        await collectItem(
          workspaceRoot,
          item.kind,
          item.locator,
          this.#options.afterFileOpened,
        ),
      );
    }
    return out;
  }
}

async function collectItem(
  workspaceRoot: string,
  kind: EvidenceKind,
  locator: EvidenceLocator,
  afterFileOpened?: (canonicalPath: string) => Promise<void>,
): Promise<CollectedItem> {
  if (kind === "file-diff") {
    try {
      const paths = locator.paths?.length
        ? await safeRelativePaths(workspaceRoot, locator.paths)
        : [];
      if (locator.paths?.length && paths.length !== locator.paths.length) {
        return { kind, locator, state: { kind: "missing" } };
      }
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", ...(paths.length ? ["--", ...paths] : [])],
        { cwd: workspaceRoot, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      );
      const bytes = Buffer.from(stdout, "utf8");
      const changes = stdout.split("\n").filter((line) => line.length > 0);
      const details = changes.length > 0
        ? `：${changes.join("；")}`
        : "。";
      return present(
        kind,
        locator,
        bytes,
        `工作区当前有 ${changes.length} 项变更${details}`,
      );
    } catch {
      return { kind, locator, state: { kind: "missing" } };
    }
  }
  const declared = locator.paths;
  if (!declared?.length) return { kind, locator, state: { kind: "missing" } };
  const relative = await safeRelativePaths(workspaceRoot, declared);
  if (relative.length !== declared.length) {
    return { kind, locator, state: { kind: "missing" } };
  }
  const frames: Array<
    | { relativePath: string; state: "missing" }
    | {
        relativePath: string;
        state: "present";
        length: number;
        contentDigest: Digest;
      }
  > = [];
  const excerpts: Buffer[] = [];
  for (const item of relative) {
    try {
      const bytes = await readStableWorkspaceFile(
        workspaceRoot,
        item,
        afterFileOpened,
      );
      excerpts.push(bytes);
      frames.push({
        relativePath: item.replaceAll("\\", "/"),
        state: "present",
        length: bytes.byteLength,
        contentDigest: byteDigest(bytes),
      });
    } catch (error) {
      if (error instanceof StaleEvidenceObservationError) throw error;
      if (!isMissingFileError(error)) throw error;
      frames.push({
        relativePath: item.replaceAll("\\", "/"),
        state: "missing",
      });
    }
  }
  if (!frames.some((frame) => frame.state === "present")) {
    return { kind, locator, state: { kind: "missing" } };
  }
  const bytes = Buffer.from(canonicalize(frames), "utf8");
  const totalBytes = frames.reduce(
    (sum, frame) => sum + (frame.state === "present" ? frame.length : 0),
    0,
  );
  return present(
    kind,
    locator,
    bytes,
    kind === "log"
      ? `日志证据存在，共 ${totalBytes} 字节。${textExcerpt(Buffer.concat(excerpts))}`
      : `产物证据存在，共 ${totalBytes} 字节。`,
  );
}

async function readStableWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  afterFileOpened?: (canonicalPath: string) => Promise<void>,
): Promise<Buffer> {
  const root = await fs.realpath(workspaceRoot);
  const requested = PathGuard.resolve(relativePath, root);
  const canonical = await fs.realpath(requested);
  if (!isWithinCanonicalRoot(root, canonical)) {
    throw new StaleEvidenceObservationError("Evidence path escaped workspace");
  }
  const handle = await fs.open(canonical, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new StaleEvidenceObservationError("Evidence path is not a file");
    }
    await afterFileOpened?.(canonical);
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterCanonical = await fs.realpath(requested);
    const afterPath = await fs.stat(afterCanonical);
    if (
      afterCanonical !== canonical ||
      !isWithinCanonicalRoot(root, afterCanonical) ||
      !sameFileSnapshot(before, afterHandle) ||
      !sameFileSnapshot(afterHandle, afterPath)
    ) {
      throw new StaleEvidenceObservationError(
        "Evidence file changed while it was being observed",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFileSnapshot(
  left: Stats,
  right: Stats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isWithinCanonicalRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))
  );
}

function staleBundle(
  request: EvidenceRequest,
  signer: ProtocolSigner,
  observedAt: string,
): EvidenceExecutionResult {
  const marker = Buffer.from(
    canonicalize({ requestId: request.requestId, state: "typed-stale" }),
    "utf8",
  );
  const fingerprint = byteDigest(marker);
  const item = request.items[0]!;
  return {
    kind: "bundle",
    bundle: createSignedEvidenceBundle(
      {
        v: 1,
        requestId: request.requestId,
        requestDigest: evidenceRequestDigest(request),
        observation: {
          observedAt,
          preStateFingerprint: fingerprint,
          postStateFingerprint: byteDigest(
            Buffer.concat([marker, Buffer.from([0])]),
          ),
          consistent: false,
        },
        items: [
          {
            kind: item.kind,
            locator: item.locator,
            contentDigest: fingerprint,
            summary: "取证期间文件身份发生变化，请在工作区稳定后重试。",
            source: "independent",
          },
        ],
        executorId: request.executorId,
      },
      signer,
    ),
  };
}

function present(
  kind: EvidenceKind,
  locator: EvidenceLocator,
  bytes: Uint8Array,
  summary: string,
): CollectedItem {
  return {
    kind,
    locator,
    bytes,
    state: { kind: "present", contentDigest: byteDigest(bytes) },
    summary: scrubSecrets(summary).scrubbed.slice(0, SUMMARY_LIMIT),
  };
}

async function safeRelativePaths(
  workspaceRoot: string,
  declared: readonly string[],
): Promise<string[]> {
  const root = await fs.realpath(workspaceRoot);
  const out: string[] = [];
  for (const candidate of declared) {
    if (!PathGuard.isWithinWorkspace(candidate, root, root)) return [];
    out.push(path.relative(root, PathGuard.resolve(candidate, root)));
  }
  return out;
}

function fingerprint(items: readonly CollectedItem[]): Digest {
  return evidenceObservationStateFingerprint(
    items.map((item) => ({
      kind: item.kind,
      locator: item.locator,
      state: item.state,
    })),
  );
}

function textExcerpt(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (!text) return "";
  const excerpt = text.length > 300 ? `${text.slice(-300)}…` : text;
  return ` 摘要：${excerpt}`;
}
