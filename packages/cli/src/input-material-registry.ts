import { stringWidth } from "./tui/index.js";

export const MATERIAL_TOKEN_PATTERN =
  /\[(Image|File) #(\d+) · [^\]\n]+\]/g;

export function createMaterialTokenPattern(): RegExp {
  return new RegExp(MATERIAL_TOKEN_PATTERN.source, MATERIAL_TOKEN_PATTERN.flags);
}

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

export interface InputMaterialFormatOptions {
  readonly maxWidth?: number;
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

  format(id: number, options: InputMaterialFormatOptions = {}): string {
    const entry = this.byId.get(id);
    if (!entry) return `[File #${id} · unavailable]`;
    const label = entry.kind === "image" ? "Image" : "File";
    return formatMaterialToken(label, entry, options.maxWidth);
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
  for (const match of draft.matchAll(createMaterialTokenPattern())) {
    ids.add(parseInt(match[2]!, 10));
  }
  return ids;
}

function formatMaterialToken(
  label: "Image" | "File",
  entry: InputMaterialEntry,
  maxWidth: number | undefined,
): string {
  const fullDetails =
    entry.kind === "image"
      ? formatImageDetails(entry)
      : `${sanitizeTokenText(entry.name)} · ${formatByteSize(entry.byteSize)}`;
  const fullToken = `[${label} #${entry.id} · ${fullDetails}]`;
  if (!Number.isFinite(maxWidth) || maxWidth === undefined || maxWidth <= 0) {
    return fullToken;
  }
  if (stringWidth(fullToken) <= maxWidth) return fullToken;

  const name = sanitizeTokenText(entry.name);
  const metadataVariants = getMetadataVariants(entry);
  for (const metadata of metadataVariants) {
    const reservedDetails =
      metadata.length > 0 ? ` · ${metadata.join(" · ")}` : "";
    const fixedTokenWidth = stringWidth(
      `[${label} #${entry.id} · ${reservedDetails}]`,
    );
    const nameBudget = Math.max(1, maxWidth - fixedTokenWidth);
    const compactName = elideMiddle(name, nameBudget);
    const details = `${compactName}${reservedDetails}`;
    const token = `[${label} #${entry.id} · ${details}]`;
    if (stringWidth(token) <= maxWidth) return token;
  }

  return `[${label} #${entry.id} · ${elideMiddle(name, 1)}]`;
}

function getMetadataVariants(entry: InputMaterialEntry): readonly string[][] {
  const size = formatByteSize(entry.byteSize);
  if (entry.kind !== "image") return [[size], []];

  const dimensions =
    entry.image?.width && entry.image.height
      ? `${entry.image.width}x${entry.image.height}`
      : null;
  if (!dimensions) return [[size], []];
  return [[dimensions, size], [dimensions], [size], []];
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

function elideMiddle(input: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (stringWidth(input) <= maxWidth) return input;
  if (maxWidth === 1) return "…";

  const extension = fileExtension(input);
  if (extension && stringWidth(extension) + 1 < maxWidth) {
    const suffixWidth = stringWidth(extension);
    const prefix = takeDisplayPrefix(
      input.slice(0, -extension.length),
      maxWidth - suffixWidth - 1,
    );
    if (prefix.length > 0) return `${prefix}…${extension}`;
  }

  const suffixBudget = Math.max(1, Math.floor((maxWidth - 1) / 3));
  const prefixBudget = maxWidth - 1 - suffixBudget;
  const prefix = takeDisplayPrefix(input, prefixBudget);
  const suffix = takeDisplaySuffix(input, suffixBudget);
  return `${prefix}…${suffix}`;
}

function fileExtension(input: string): string {
  const index = input.lastIndexOf(".");
  if (index <= 0 || index === input.length - 1) return "";
  return input.slice(index);
}

function takeDisplayPrefix(input: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of input) {
    const next = width + stringWidth(ch);
    if (next > maxWidth) break;
    out += ch;
    width = next;
  }
  return out;
}

function takeDisplaySuffix(input: string, maxWidth: number): string {
  let width = 0;
  const chars = Array.from(input);
  const out: string[] = [];
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]!;
    const next = width + stringWidth(ch);
    if (next > maxWidth) break;
    out.unshift(ch);
    width = next;
  }
  return out.join("");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
