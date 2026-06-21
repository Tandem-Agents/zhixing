export const MATERIAL_TOKEN_PATTERN =
  /\[(Image|File) #(\d+) · [^\]\n]+\]/g;

export type InputMaterialKind = "image" | "file";

export interface ImageMetadata {
  readonly width?: number;
  readonly height?: number;
}

export interface InputMaterialEntry {
  readonly id: number;
  readonly kind: InputMaterialKind;
  readonly filePath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly image?: ImageMetadata;
}

export interface RegisterLocalMaterialInput {
  readonly kind: InputMaterialKind;
  readonly filePath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly image?: ImageMetadata;
}

export class InputMaterialRegistry {
  private nextId = 1;
  private readonly byId = new Map<number, InputMaterialEntry>();
  private readonly byFilePath = new Map<string, number>();

  registerLocalFile(input: RegisterLocalMaterialInput): number {
    const existingId = this.byFilePath.get(input.filePath);
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId);
      if (
        existing &&
        existing.kind === input.kind &&
        existing.mimeType === input.mimeType &&
        existing.byteSize === input.byteSize
      ) {
        return existingId;
      }
    }

    const id = this.nextId++;
    const entry: InputMaterialEntry = { id, ...input };
    this.byId.set(id, entry);
    this.byFilePath.set(input.filePath, id);
    return id;
  }

  get(id: number): InputMaterialEntry | null {
    return this.byId.get(id) ?? null;
  }

  format(id: number): string {
    const entry = this.byId.get(id);
    if (!entry) return `[File #${id} · unavailable]`;
    const label = entry.kind === "image" ? "Image" : "File";
    const details =
      entry.kind === "image"
        ? formatImageDetails(entry)
        : `${sanitizeTokenText(entry.name)} · ${formatByteSize(entry.byteSize)}`;
    return `[${label} #${entry.id} · ${details}]`;
  }

  cleanup(aliveIds: ReadonlySet<number>): void {
    for (const [id, entry] of this.byId) {
      if (aliveIds.has(id)) continue;
      this.byId.delete(id);
      if (this.byFilePath.get(entry.filePath) === id) {
        this.byFilePath.delete(entry.filePath);
      }
    }
  }

  clearAll(): void {
    this.byId.clear();
    this.byFilePath.clear();
    this.nextId = 1;
  }

  get size(): number {
    return this.byId.size;
  }
}

export function extractAliveMaterialIds(draft: string): Set<number> {
  const ids = new Set<number>();
  for (const match of draft.matchAll(MATERIAL_TOKEN_PATTERN)) {
    ids.add(parseInt(match[2]!, 10));
  }
  return ids;
}

function formatImageDetails(entry: InputMaterialEntry): string {
  const parts = [sanitizeTokenText(entry.name)];
  if (entry.image?.width && entry.image.height) {
    parts.push(`${entry.image.width}x${entry.image.height}`);
  }
  parts.push(formatByteSize(entry.byteSize));
  return parts.join(" · ");
}

function sanitizeTokenText(input: string): string {
  return input.replace(/[\]\r\n]+/g, " ").trim() || "unnamed";
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
