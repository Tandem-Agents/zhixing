import { randomBytes } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import { ensureDurableDirectory, syncDirectory } from "@zhixing/core/persistence";

export type BackupTargetBinding =
  | {
      readonly kind: "directory";
      readonly targetId: string;
      readonly directory: string;
    }
  | {
      readonly kind: "paired-device";
      readonly targetId: string;
      readonly deviceId: string;
    };

interface BackupTargetConfiguration {
  readonly v: 1;
  readonly currentTargetId: string;
  readonly bindings: readonly BackupTargetBinding[];
}

export class FileBackupTargetConfiguration {
  readonly #file: string;

  constructor(zhixingHome: string) {
    this.#file = path.join(path.resolve(zhixingHome), "distributed-runtime", "recovery-backup-targets.json");
  }

  async load(): Promise<BackupTargetConfiguration | undefined> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text || !isRecord(value) || value.v !== 1 ||
      typeof value.currentTargetId !== "string" || !Array.isArray(value.bindings)) {
      throw new TypeError("Recovery backup target configuration is invalid");
    }
    assertExactKeys(value, ["bindings", "currentTargetId", "v"]);
    const bindings = value.bindings.map(validateBinding);
    if (
      new Set(bindings.map((binding) => binding.targetId)).size !== bindings.length ||
      !bindings.some((binding) => binding.targetId === value.currentTargetId)
    ) throw new TypeError("Recovery backup target configuration has an invalid current target");
    return { v: 1, currentTargetId: value.currentTargetId, bindings };
  }

  async select(binding: BackupTargetBinding): Promise<void> {
    const current = await this.load();
    const bindings = new Map((current?.bindings ?? []).map((candidate) => [candidate.targetId, candidate]));
    const existing = bindings.get(binding.targetId);
    if (existing && canonicalize(existing) !== canonicalize(binding)) {
      throw new TypeError("Recovery backup target identity is already bound differently");
    }
    bindings.set(binding.targetId, binding);
    await this.#write({
      v: 1,
      currentTargetId: binding.targetId,
      bindings: [...bindings.values()].sort((left, right) => left.targetId.localeCompare(right.targetId, "en-US")),
    });
  }

  async #write(value: BackupTargetConfiguration): Promise<void> {
    const directory = path.dirname(this.#file);
    await ensureDurableDirectory(directory);
    const temporary = `${this.#file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, canonicalize(value), { flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.#file);
    await syncDirectory(directory);
  }
}

function validateBinding(value: unknown): BackupTargetBinding {
  if (!isRecord(value) || typeof value.targetId !== "string") {
    throw new TypeError("Recovery backup target binding is invalid");
  }
  if (value.kind === "directory" && typeof value.directory === "string") {
    assertExactKeys(value, ["directory", "kind", "targetId"]);
    return { kind: "directory", targetId: value.targetId, directory: path.resolve(value.directory) };
  }
  if (value.kind === "paired-device" && typeof value.deviceId === "string") {
    assertExactKeys(value, ["deviceId", "kind", "targetId"]);
    return { kind: "paired-device", targetId: value.targetId, deviceId: value.deviceId };
  }
  throw new TypeError("Recovery backup target binding is invalid");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Recovery backup target binding has missing or unknown fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
