import { chmod, mkdir, readFile, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { expandUserHome } from "@zhixing/core";
import {
  byteDigest,
  canonicalize,
  decodeAndValidateReleaseManifest,
  decodeProgramArtifact,
  programArtifactStorageBudget,
  protocolDigest,
  validateProgramUpdateReceipt,
  type ProgramUpdateReceipt,
  type ProtocolSignatureVerifier,
  type ReleaseManifest,
  type StableReleaseTarget,
} from "@zhixing/core/protocol";
import { readJsonIfPresent, syncDirectory, writeDurableBytes, writeDurableJson } from "./durable-file.js";

export interface ProgramPointerEntry {
  readonly manifestDigest: string;
  readonly releaseVersion: string;
  readonly releaseSequence: string;
  readonly directory: string;
}

export interface ProgramPointer {
  readonly v: 1;
  readonly target: StableReleaseTarget;
  readonly generation: number;
  readonly current: ProgramPointerEntry;
  readonly previous?: ProgramPointerEntry;
}

export interface ProgramStoreDeps {
  readonly availableBytes?: (root: string) => Promise<bigint>;
}

export interface ProgramActivationExpectation {
  readonly sourceManifestDigest: string;
  readonly pointerGeneration: number;
}

export function programUpdateNoticeToken(receipt: ProgramUpdateReceipt): string {
  return protocolDigest("ProgramUpdateNotice", 1, receipt);
}

export function currentReleaseTarget(): StableReleaseTarget {
  const key = `${process.platform}-${process.arch}`;
  if (
    key === "win32-x64" || key === "darwin-x64" || key === "darwin-arm64" ||
    key === "linux-x64" || key === "linux-arm64"
  ) return key;
  throw new Error("当前系统尚无知行稳定版安装包");
}

export function defaultProgramRoot(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("Windows LOCALAPPDATA is unavailable");
    return path.join(local, "Zhixing");
  }
  if (process.platform === "darwin") {
    return expandUserHome("~/Library/Application Support/Zhixing");
  }
  return path.join(process.env.XDG_DATA_HOME ?? expandUserHome("~/.local/share"), "zhixing");
}

export class ProgramStore {
  readonly root: string;
  readonly target: StableReleaseTarget;
  readonly #availableBytes: (root: string) => Promise<bigint>;
  readonly #updateChanged = new Set<() => void>();

  constructor(
    root = defaultProgramRoot(),
    target = currentReleaseTarget(),
    deps: ProgramStoreDeps = {},
  ) {
    this.root = path.resolve(root);
    this.target = target;
    this.#availableBytes = deps.availableBytes ?? availableBytes;
  }

  async ensureDownloadCapacity(archiveBytes: number): Promise<void> {
    await this.#ensureCapacity(programArtifactStorageBudget({ archiveBytes }));
  }

  async loadPointer(): Promise<ProgramPointer | undefined> {
    const input = await readJsonIfPresent(this.pointerPath());
    return input === undefined ? undefined : validatePointer(input, this.target);
  }

  async loadCurrentManifest(verifier: ProtocolSignatureVerifier): Promise<{
    readonly manifest: ReleaseManifest;
    readonly digest: string;
    readonly bytes: Buffer;
  } | undefined> {
    const pointer = await this.loadPointer();
    if (!pointer) return undefined;
    return this.loadManifestEntry(pointer.current, verifier);
  }

  async loadPreviousManifest(verifier: ProtocolSignatureVerifier): Promise<{
    readonly manifest: ReleaseManifest;
    readonly digest: string;
    readonly bytes: Buffer;
  } | undefined> {
    const pointer = await this.loadPointer();
    if (!pointer?.previous) return undefined;
    return this.loadManifestEntry(pointer.previous, verifier);
  }

  async verifyInstalled(
    entry: ProgramPointerEntry,
    verifier: ProtocolSignatureVerifier,
  ): Promise<{ readonly manifest: ReleaseManifest; readonly digest: string; readonly bytes: Buffer }> {
    const installed = await this.loadManifestEntry(entry, verifier);
    const directory = path.join(this.root, "versions", entry.directory);
    const artifactBytes = await readFile(path.join(directory, "artifact.json"));
    await this.verifyExpanded(directory, installed.manifest, installed.bytes, artifactBytes);
    return installed;
  }

  async loadStagedManifest(
    manifestDigest: string,
    verifier: ProtocolSignatureVerifier,
  ): Promise<{ readonly manifest: ReleaseManifest; readonly digest: string; readonly bytes: Buffer }> {
    const file = path.join(this.root, "stage", programVersionDirectory(manifestDigest), "release-manifest.json");
    const bytes = await readFile(file);
    const manifest = decodeAndValidateReleaseManifest(bytes, verifier);
    const digest = byteDigest(bytes);
    if (digest !== manifestDigest || manifest.target !== this.target) {
      throw new Error("Verified program stage identity changed");
    }
    return { manifest, digest, bytes };
  }

  async loadAcceptedManifest(
    manifestDigest: string,
    verifier: ProtocolSignatureVerifier,
  ): Promise<{ readonly manifest: ReleaseManifest; readonly digest: string; readonly bytes: Buffer }> {
    const pointer = await this.loadPointer();
    const installed = pointer
      ? [pointer.current, pointer.previous].find((entry) => entry?.manifestDigest === manifestDigest)
      : undefined;
    if (installed) return this.verifyInstalled(installed, verifier);
    return this.loadStagedManifest(manifestDigest, verifier);
  }

  async loadReceipt(): Promise<ProgramUpdateReceipt | undefined> {
    const value = await readJsonIfPresent(path.join(this.root, "update-receipt.json"));
    return value === undefined ? undefined : validateProgramUpdateReceipt(value);
  }

  async writeReceipt(receipt: ProgramUpdateReceipt): Promise<void> {
    await writeDurableJson(
      path.join(this.root, "update-receipt.json"),
      validateProgramUpdateReceipt(receipt),
    );
    for (const listener of this.#updateChanged) listener();
  }

  onUpdateChanged(listener: () => void): () => void {
    this.#updateChanged.add(listener);
    return () => this.#updateChanged.delete(listener);
  }

  async consumeNotice(expectedToken: string): Promise<boolean> {
    const current = await this.loadReceipt();
    if (
      !current ||
      (current.notice !== "updated" && current.notice !== "restored") ||
      programUpdateNoticeToken(current) !== expectedToken
    ) return false;
    const consumed = validateProgramUpdateReceipt({
      v: 1,
      currentManifestDigest: current.currentManifestDigest,
      target: current.target,
      phase: "idle",
      notice: "none",
    });
    await this.writeReceipt(consumed);
    const durable = await this.loadReceipt();
    if (!durable || canonicalize(durable) !== canonicalize(consumed)) {
      throw new Error("Program update notice consumption read-back failed");
    }
    return true;
  }

  async stageInstalled(
    entry: ProgramPointerEntry,
    verifier: ProtocolSignatureVerifier,
  ): Promise<{ readonly manifest: ReleaseManifest; readonly digest: string }> {
    const installed = await this.verifyInstalled(entry, verifier);
    const artifactBytes = await readFile(
      path.join(this.root, "versions", entry.directory, "artifact.json"),
    );
    await this.stage(installed.manifest, installed.bytes, artifactBytes);
    return { manifest: installed.manifest, digest: installed.digest };
  }

  async stage(
    manifest: ReleaseManifest,
    manifestBytes: Uint8Array,
    artifactBytes: Uint8Array,
  ): Promise<string> {
    if (manifest.target !== this.target) throw new TypeError("Release manifest target does not match this program store");
    if (manifest.artifact.bytes !== artifactBytes.byteLength || manifest.artifact.digest !== byteDigest(artifactBytes)) {
      throw new TypeError("Release artifact bytes do not match manifest binding");
    }
    const artifact = decodeProgramArtifact(artifactBytes);
    if (artifact.target !== manifest.target || artifact.releaseVersion !== manifest.releaseVersion) {
      throw new TypeError("Program artifact identity does not match release manifest");
    }
    const expandedBytes = artifact.files.reduce((total, file) => total + file.bytes, 0);
    const installationBytes = artifact.files.reduce((total, file) =>
      file.path.startsWith("bin/") || file.path.startsWith("installer/") || file.path.startsWith("runtime/")
        ? total + file.bytes
        : total, 0);
    await this.#ensureCapacity(programArtifactStorageBudget({
      archiveBytes: artifactBytes.byteLength,
      expandedBytes,
      installationBytes,
    }));
    const manifestDigest = byteDigest(manifestBytes);
    const finalDirectory = path.join(this.root, "stage", programVersionDirectory(manifestDigest));
    if (await isDirectory(finalDirectory)) {
      await this.verifyExpanded(finalDirectory, manifest, manifestBytes, artifactBytes);
      return finalDirectory;
    }
    const temporary = `${finalDirectory}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(path.join(temporary, "program"), { recursive: true, mode: 0o700 });
    try {
      await writeDurableBytes(path.join(temporary, "release-manifest.json"), manifestBytes);
      await writeDurableBytes(path.join(temporary, "artifact.json"), artifactBytes);
      for (const file of artifact.files) {
        const destination = path.join(temporary, "program", ...file.path.split("/"));
        await writeDurableBytes(destination, Buffer.from(file.data, "base64url"), file.mode);
        await chmod(destination, file.mode);
      }
      await writeDurableJson(path.join(temporary, "stage.json"), {
        v: 1,
        manifestDigest,
        artifactDigest: manifest.artifact.digest,
        target: manifest.target,
        releaseVersion: manifest.releaseVersion,
      });
      await syncDirectory(temporary);
      await mkdir(path.dirname(finalDirectory), { recursive: true, mode: 0o700 });
      await rename(temporary, finalDirectory);
      await syncDirectory(path.dirname(finalDirectory));
      await this.verifyExpanded(finalDirectory, manifest, manifestBytes, artifactBytes);
      return finalDirectory;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async activateStaged(
    manifest: ReleaseManifest,
    manifestDigest: string,
    expectation?: ProgramActivationExpectation,
  ): Promise<ProgramPointer> {
    const directory = programVersionDirectory(manifestDigest);
    const staged = path.join(this.root, "stage", directory);
    const versionPath = path.join(this.root, "versions", directory);
    await mkdir(path.dirname(versionPath), { recursive: true, mode: 0o700 });
    if (!await isDirectory(versionPath)) {
      if (!await isDirectory(staged)) throw new Error("Verified update stage is missing");
      await rename(staged, versionPath);
      await syncDirectory(path.dirname(versionPath));
    }
    const durableManifest = await readFile(path.join(versionPath, "release-manifest.json"));
    const durableArtifact = await readFile(path.join(versionPath, "artifact.json"));
    await this.verifyExpanded(versionPath, manifest, durableManifest, durableArtifact);
    if (!durableManifest.equals(Buffer.from(canonicalize(manifest), "utf8")) || byteDigest(durableManifest) !== manifestDigest) {
      throw new Error("Installed program version identity changed");
    }
    const current = await this.loadPointer();
    const desired: ProgramPointerEntry = {
      manifestDigest,
      releaseVersion: manifest.releaseVersion,
      releaseSequence: manifest.releaseSequence,
      directory,
    };
    if (current?.current.manifestDigest === manifestDigest) {
      if (!samePointerEntry(current.current, desired)) {
        throw new Error("Installed program pointer conflicts with the verified target");
      }
      if (expectation && (
        current.generation !== expectation.pointerGeneration + 1 ||
        current.previous?.manifestDigest !== expectation.sourceManifestDigest
      )) {
        throw new Error("Installed program pointer does not match the accepted upgrade");
      }
      return current;
    }
    if (expectation && (
      !current ||
      current.generation !== expectation.pointerGeneration ||
      current.current.manifestDigest !== expectation.sourceManifestDigest
    )) {
      throw new Error("Program pointer changed before upgrade activation");
    }
    const next: ProgramPointer = {
      v: 1,
      target: this.target,
      generation: (current?.generation ?? 0) + 1,
      current: desired,
      ...(current ? { previous: current.current } : {}),
    };
    await writeDurableJson(this.pointerPath(), next);
    return validatePointer(await readJsonIfPresent(this.pointerPath()), this.target);
  }

  async restorePrevious(input?: {
    readonly failedManifestDigest: string;
    readonly sourceManifestDigest: string;
  }): Promise<ProgramPointer> {
    const current = await this.loadPointer();
    if (input && current?.current.manifestDigest === input.sourceManifestDigest && !current.previous) {
      return current;
    }
    if (!current?.previous) throw new Error("没有可恢复的上一可用版本");
    if (input && (
      current.current.manifestDigest !== input.failedManifestDigest ||
      current.previous.manifestDigest !== input.sourceManifestDigest
    )) {
      throw new Error("Program pointer does not match the accepted recovery");
    }
    const next: ProgramPointer = {
      v: 1,
      target: current.target,
      generation: current.generation + 1,
      current: current.previous,
    };
    await writeDurableJson(this.pointerPath(), next);
    return validatePointer(await readJsonIfPresent(this.pointerPath()), this.target);
  }

  async cleanup(activeStageDigest?: string): Promise<void> {
    const pointer = await this.loadPointer();
    if (!pointer) return;
    const keepVersions = new Set([pointer.current.directory, pointer.previous?.directory].filter(Boolean));
    await removeChildrenInBatches(path.join(this.root, "versions"), keepVersions as Set<string>);
    const keepStages = new Set(activeStageDigest ? [programVersionDirectory(activeStageDigest)] : []);
    await removeChildrenInBatches(path.join(this.root, "stage"), keepStages);
  }

  programPath(entry: ProgramPointerEntry): string {
    return path.join(this.root, "versions", entry.directory, "program");
  }

  private pointerPath(): string {
    return path.join(this.root, "current.json");
  }

  async #ensureCapacity(requiredBytes: number): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await this.#availableBytes(this.root) < BigInt(requiredBytes)) {
      throw new Error("Program store does not have enough capacity for this update");
    }
  }

  private async loadManifestEntry(entry: ProgramPointerEntry, verifier: ProtocolSignatureVerifier) {
    const file = path.join(this.root, "versions", entry.directory, "release-manifest.json");
    const bytes = await readFile(file);
    const manifest = decodeAndValidateReleaseManifest(bytes, verifier);
    const digest = byteDigest(bytes);
    if (
      digest !== entry.manifestDigest || manifest.target !== this.target ||
      manifest.releaseVersion !== entry.releaseVersion || manifest.releaseSequence !== entry.releaseSequence
    ) throw new Error("Installed release manifest does not match current pointer");
    return { manifest, digest, bytes };
  }

  private async verifyExpanded(
    directory: string,
    manifest: ReleaseManifest,
    manifestBytes: Uint8Array,
    artifactBytes: Uint8Array,
  ): Promise<void> {
    const durableManifest = await readFile(path.join(directory, "release-manifest.json"));
    const durableArtifact = await readFile(path.join(directory, "artifact.json"));
    if (!durableManifest.equals(Buffer.from(manifestBytes)) || !durableArtifact.equals(Buffer.from(artifactBytes))) {
      throw new Error("Verified update stage read-back failed");
    }
    const artifact = decodeProgramArtifact(durableArtifact);
    const actualLayout = await readProgramLayout(path.join(directory, "program"));
    const expectedFiles = artifact.files.map((file) => file.path).sort();
    const expectedDirectories = expectedProgramDirectories(expectedFiles);
    if (
      actualLayout.files.length !== expectedFiles.length ||
      actualLayout.files.some((file, index) => file !== expectedFiles[index]) ||
      actualLayout.directories.length !== expectedDirectories.length ||
      actualLayout.directories.some((entry, index) => entry !== expectedDirectories[index])
    ) {
      throw new Error("Expanded program layout read-back failed");
    }
    for (const file of artifact.files) {
      const bytes = await readFile(path.join(directory, "program", ...file.path.split("/")));
      if (bytes.byteLength !== file.bytes || byteDigest(bytes) !== file.digest) {
        throw new Error("Expanded program file read-back failed");
      }
    }
    if (manifest.artifact.digest !== byteDigest(durableArtifact)) throw new Error("Staged artifact binding changed");
  }
}

function validatePointer(input: unknown, target: StableReleaseTarget): ProgramPointer {
  const value = plainObject(input, "Program pointer");
  exact(value, ["current", "generation", ...(value.previous === undefined ? [] : ["previous"]), "target", "v"], "Program pointer");
  if (value.v !== 1 || value.target !== target || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new TypeError("Program pointer identity is invalid");
  }
  return Object.freeze({
    v: 1,
    target,
    generation: value.generation as number,
    current: pointerEntry(value.current, "current"),
    ...(value.previous === undefined ? {} : { previous: pointerEntry(value.previous, "previous") }),
  });
}

function pointerEntry(input: unknown, label: string): ProgramPointerEntry {
  const value = plainObject(input, `Program pointer ${label}`);
  exact(value, ["directory", "manifestDigest", "releaseSequence", "releaseVersion"], `Program pointer ${label}`);
  if (typeof value.manifestDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.manifestDigest)) {
    throw new TypeError(`Program pointer ${label} digest is invalid`);
  }
  if (typeof value.releaseVersion !== "string" || typeof value.releaseSequence !== "string") {
    throw new TypeError(`Program pointer ${label} release identity is invalid`);
  }
  if (typeof value.directory !== "string" || !/^[0-9A-Za-z._-]+$/u.test(value.directory)) {
    throw new TypeError(`Program pointer ${label} directory is invalid`);
  }
  return Object.freeze(value) as unknown as ProgramPointerEntry;
}

function plainObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return input as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} has incomplete or unknown fields`);
  }
}

function programVersionDirectory(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new TypeError("Program digest is invalid");
  return digest.slice("sha256:".length);
}

async function isDirectory(directory: string): Promise<boolean> {
  return stat(directory).then((entry) => entry.isDirectory()).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function removeChildrenInBatches(root: string, keep: ReadonlySet<string>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const removable = entries.filter((entry) => entry.isDirectory() && !keep.has(entry.name));
  for (let offset = 0; offset < removable.length; offset += 128) {
    await Promise.all(removable.slice(offset, offset + 128).map((entry) =>
      rm(path.join(root, entry.name), { recursive: true, force: true })));
  }
}

async function availableBytes(root: string): Promise<bigint> {
  const value = await statfs(root, { bigint: true });
  return value.bavail * value.bsize;
}

function samePointerEntry(left: ProgramPointerEntry, right: ProgramPointerEntry): boolean {
  return left.manifestDigest === right.manifestDigest &&
    left.releaseVersion === right.releaseVersion &&
    left.releaseSequence === right.releaseSequence &&
    left.directory === right.directory;
}

async function readProgramLayout(root: string): Promise<{
  readonly files: readonly string[];
  readonly directories: readonly string[];
}> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error("Expanded program layout contains an unsupported entry");
      }
      if (entry.isDirectory()) {
        directories.push(relative);
        await visit(path.join(directory, entry.name), relative);
      } else {
        files.push(relative);
      }
    }
  };
  await visit(root, "");
  return Object.freeze({
    files: Object.freeze(files.sort()),
    directories: Object.freeze(directories.sort()),
  });
}

function expectedProgramDirectories(files: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return Object.freeze([...directories].sort());
}
