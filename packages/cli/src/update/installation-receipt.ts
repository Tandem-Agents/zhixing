import path from "node:path";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { expandUserHome } from "@zhixing/core";
import {
  byteDigest,
  compareReleaseSemver,
  decodeAndValidateReleaseManifest,
  decodeProgramArtifact,
  type ProtocolSignatureVerifier,
  type ReleaseManifest,
  type StableReleaseTarget,
} from "@zhixing/core/protocol";
import { readJsonIfPresent, writeDurableBytes, writeDurableJson } from "./durable-file.js";
import { ProgramStore } from "./program-store.js";

export interface InstallationReceipt {
  readonly v: 1;
  readonly target: StableReleaseTarget;
  readonly keyId: string;
  readonly releaseVersion: string;
  readonly releaseSequence: string;
  readonly manifestDigest: string;
}

export function defaultInstallationReceiptPath(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("Windows LOCALAPPDATA is unavailable");
    return path.join(local, "ZhixingInstaller", "installation-receipt.json");
  }
  if (process.platform === "darwin") {
    return expandUserHome("~/Library/Application Support/ZhixingInstaller/installation-receipt.json");
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? expandUserHome("~/.local/state"),
    "zhixing-installer",
    "installation-receipt.json",
  );
}

export async function loadInstallationReceipt(
  receiptPath = defaultInstallationReceiptPath(),
): Promise<InstallationReceipt | undefined> {
  const input = await readJsonIfPresent(receiptPath);
  return input === undefined ? undefined : validateInstallationReceipt(input);
}

export async function commitInstallationReceipt(
  manifest: ReleaseManifest,
  manifestDigest: string,
  receiptPath = defaultInstallationReceiptPath(),
): Promise<InstallationReceipt> {
  const next = validateInstallationReceipt({
    v: 1,
    target: manifest.target,
    keyId: manifest.keyId,
    releaseVersion: manifest.releaseVersion,
    releaseSequence: manifest.releaseSequence,
    manifestDigest,
  });
  const current = await loadInstallationReceipt(receiptPath);
  assertInstallAdvance(current, next);
  await writeDurableJson(receiptPath, next);
  const readBack = await loadInstallationReceipt(receiptPath);
  if (!readBack || !sameReceipt(readBack, next)) {
    throw new Error("Installation receipt read-back failed");
  }
  return readBack;
}

export async function installProgramRelease(input: {
  readonly store: ProgramStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly manifestBytes: Uint8Array;
  readonly artifactBytes: Uint8Array;
  readonly receiptPath?: string;
  readonly handoffExisting?: (
    candidateManifestDigest: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly operationId: string } | undefined>;
  readonly signal?: AbortSignal;
  readonly terminalTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}): Promise<InstallationReceipt> {
  const manifest = decodeAndValidateReleaseManifest(input.manifestBytes, input.verifier);
  const manifestDigest = byteDigest(input.manifestBytes);
  if (manifest.target !== input.store.target) {
    throw new Error("Release manifest target does not match this installer");
  }
  if (manifest.artifact.bytes !== input.artifactBytes.byteLength || manifest.artifact.digest !== byteDigest(input.artifactBytes)) {
    throw new Error("Release artifact bytes do not match the signed manifest");
  }
  const artifact = decodeProgramArtifact(input.artifactBytes);
  if (artifact.target !== manifest.target || artifact.releaseVersion !== manifest.releaseVersion) {
    throw new Error("Program artifact identity does not match the signed manifest");
  }
  const receiptPath = input.receiptPath ?? defaultInstallationReceiptPath();
  const currentReceipt = await loadInstallationReceipt(receiptPath);
  const candidate = validateInstallationReceipt({
    v: 1,
    target: manifest.target,
    keyId: manifest.keyId,
    releaseVersion: manifest.releaseVersion,
    releaseSequence: manifest.releaseSequence,
    manifestDigest,
  });
  const pointer = await input.store.loadPointer();
  const currentProgram = pointer
    ? await input.store.verifyInstalled(pointer.current, input.verifier)
    : undefined;
  const pointerReceipt = currentProgram
    ? receiptFromManifest(currentProgram.manifest, currentProgram.digest)
    : undefined;
  assertInstallAdvance(currentReceipt, candidate);
  assertInstallAdvance(pointerReceipt, candidate);

  if (!pointer) {
    await input.store.stage(manifest, input.manifestBytes, input.artifactBytes);
    const installed = await input.store.activateStaged(manifest, manifestDigest);
    if (installed.current.manifestDigest !== manifestDigest) {
      throw new Error("Installed program pointer does not match the signed release");
    }
    await input.store.verifyInstalled(installed.current, input.verifier);
    await materializeStableInstallationSurface(input.store, installed.current, artifact.files);
    return commitInstallationReceipt(manifest, manifestDigest, receiptPath);
  }

  if (sameReceipt(pointerReceipt!, candidate) && !pointer.previous && !currentReceipt) {
    await materializeStableInstallationSurface(input.store, pointer.current, artifact.files);
    return commitInstallationReceipt(manifest, manifestDigest, receiptPath);
  }

  if (sameReceipt(pointerReceipt!, candidate) && currentReceipt && sameReceipt(currentReceipt, candidate)) {
    await materializeStableInstallationSurface(input.store, pointer.current, artifact.files);
    return currentReceipt;
  }

  if (pointer.current.manifestDigest !== manifestDigest) {
    await input.store.stage(manifest, input.manifestBytes, input.artifactBytes);
  }
  if (!input.handoffExisting) {
    throw new Error("Existing installation updates require the current-host lifecycle");
  }
  const prepared = await input.handoffExisting(manifestDigest, input.signal);
  if (!prepared) throw new Error("Current program host is unavailable for a safe update");
  const terminal = await waitForTerminalInstallation({
    store: input.store,
    verifier: input.verifier,
    candidate,
    receiptPath,
    signal: input.signal,
    timeoutMs: input.terminalTimeoutMs ?? 120_000,
    pollIntervalMs: input.pollIntervalMs ?? 100,
  });
  const installedPointer = await input.store.loadPointer();
  if (!installedPointer || installedPointer.current.manifestDigest !== manifestDigest) {
    throw new Error("Terminal program update did not install the requested release");
  }
  await input.store.verifyInstalled(installedPointer.current, input.verifier);
  return terminal;
}

export function validateInstallationReceipt(input: unknown): InstallationReceipt {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError("Installation receipt must be a plain object");
  }
  const value = input as Record<string, unknown>;
  const expected = ["keyId", "manifestDigest", "releaseSequence", "releaseVersion", "target", "v"];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError("Installation receipt has incomplete or unknown fields");
  }
  if (
    value.v !== 1 ||
    typeof value.target !== "string" ||
    !new Set(["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]).has(value.target) ||
    typeof value.keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value.keyId) ||
    typeof value.releaseVersion !== "string" ||
    typeof value.releaseSequence !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.releaseSequence) ||
    typeof value.manifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.manifestDigest)
  ) {
    throw new TypeError("Installation receipt identity is invalid");
  }
  return Object.freeze(value) as unknown as InstallationReceipt;
}

function assertInstallAdvance(
  current: InstallationReceipt | undefined,
  candidate: InstallationReceipt,
): void {
  if (!current) return;
  if (current.target !== candidate.target) {
    throw new Error("Installed target cannot be replaced by a different platform package");
  }
  const sequence = BigInt(candidate.releaseSequence) - BigInt(current.releaseSequence);
  const version = compareReleaseSemver(candidate.releaseVersion, current.releaseVersion);
  if (sequence < 0n || version < 0) throw new Error("Installer rejected a release downgrade");
  if (sequence === 0n || version === 0) {
    if (sequence !== 0n || version !== 0 || !sameReceipt(current, candidate)) {
      throw new Error("Installer rejected conflicting bytes for an existing release identity");
    }
  }
}

function receiptFromManifest(manifest: ReleaseManifest, manifestDigest: string): InstallationReceipt {
  return validateInstallationReceipt({
    v: 1,
    target: manifest.target,
    keyId: manifest.keyId,
    releaseVersion: manifest.releaseVersion,
    releaseSequence: manifest.releaseSequence,
    manifestDigest,
  });
}

async function waitForTerminalInstallation(input: {
  readonly store: ProgramStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly candidate: InstallationReceipt;
  readonly receiptPath: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<InstallationReceipt> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 ||
      !Number.isFinite(input.pollIntervalMs) || input.pollIntervalMs <= 0) {
    throw new TypeError("Installer terminal wait options are invalid");
  }
  const deadline = Date.now() + input.timeoutMs;
  while (true) {
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Installer update was aborted");
    }
    const [receipt, pointer] = await Promise.all([
      loadInstallationReceipt(input.receiptPath),
      input.store.loadPointer(),
    ]);
    if (receipt && sameReceipt(receipt, input.candidate) &&
        pointer?.current.manifestDigest === input.candidate.manifestDigest) {
      await input.store.verifyInstalled(pointer.current, input.verifier);
      return receipt;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the current-host update lifecycle");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
}

function sameReceipt(left: InstallationReceipt, right: InstallationReceipt): boolean {
  return left.v === right.v && left.target === right.target && left.keyId === right.keyId &&
    left.releaseVersion === right.releaseVersion && left.releaseSequence === right.releaseSequence &&
    left.manifestDigest === right.manifestDigest;
}

async function materializeStableInstallationSurface(
  store: ProgramStore,
  entry: { readonly directory: string },
  files: readonly { readonly path: string; readonly digest: string; readonly bytes: number; readonly mode: number }[],
): Promise<void> {
  const stableFiles = files.filter((file) =>
    file.path.startsWith("bin/") || file.path.startsWith("installer/") || file.path.startsWith("runtime/"));
  if (
    !stableFiles.some((file) => file.path === (store.target === "win32-x64" ? "bin/zz.cmd" : "bin/zz")) ||
    !stableFiles.some((file) => file.path === (store.target === "win32-x64" ? "runtime/node.exe" : "runtime/node")) ||
    !stableFiles.some((file) => file.path === "installer/program-installer.js")
  ) {
    throw new Error("Program artifact is missing its stable launcher or installer surface");
  }
  for (const file of stableFiles.sort((left, right) => left.path.localeCompare(right.path))) {
    const source = path.join(store.root, "versions", entry.directory, "program", ...file.path.split("/"));
    const destination = path.join(store.root, ...file.path.split("/"));
    const bytes = await readFile(source);
    if (bytes.byteLength !== file.bytes || byteDigest(bytes) !== file.digest) {
      throw new Error("Stable installer surface source changed after verification");
    }
    const existing = await readFile(destination).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.byteLength === file.bytes && byteDigest(existing) === file.digest) continue;
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeDurableBytes(destination, bytes, file.mode);
    await chmod(destination, file.mode);
    const durable = await readFile(destination);
    if (durable.byteLength !== file.bytes || byteDigest(durable) !== file.digest) {
      throw new Error("Stable launcher or installer read-back failed");
    }
  }
}
