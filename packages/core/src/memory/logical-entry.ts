import type { ArtifactRef, JsonValue } from "../contracts/index.js";
import { protocolDigest } from "../protocol/canonical.js";
import type {
  MemoryAppendPayload,
  MemoryCategoryDto,
  MemoryLogicalEntry,
  MemoryScopeRef,
} from "./contracts.js";

export function projectMemoryLogicalEntry(
  payload: MemoryAppendPayload,
  current: MemoryLogicalEntry | undefined,
  options: { readonly revision: number; readonly updatedAt?: string },
): MemoryLogicalEntry {
  const base = payload.domain === "memory"
    ? {
        category: payload.category,
        id: payload.id,
        meta: payload.meta,
        content: payload.content,
      }
    : payload.domain === "people"
      ? {
          id: payload.id,
          meta: payload.meta as unknown as Record<string, JsonValue>,
          content: payload.content,
        }
      : {
          id: payload.date ?? requireJournalDate(options.updatedAt),
          meta: { date: payload.date ?? requireJournalDate(options.updatedAt) },
          content: current?.content
            ? `${current.content}\n\n---\n\n${payload.content}`
            : payload.content,
        };
  const identity = {
    domain: payload.domain,
    scope: payload.scope,
    ...base,
  };
  return {
    ...structuredClone(identity),
    revision: options.revision,
    digest: memoryLogicalEntryDigest(identity),
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
  } as MemoryLogicalEntry;
}

export function memoryLogicalEntryDigest(value: object): ArtifactRef["digest"] {
  return protocolDigest("MemoryLogicalEntry", 1, value);
}

export function memoryLogicalEntryKey(entry: Pick<
  MemoryLogicalEntry,
  "scope" | "domain" | "category" | "id"
>): string {
  return memoryLogicalIdentityKey(
    entry.scope,
    entry.domain,
    entry.category,
    entry.id,
  );
}

export function memoryLogicalIdentityKey(
  scope: MemoryScopeRef,
  domain: "memory" | "journal" | "people",
  category: MemoryCategoryDto | undefined,
  id: string,
): string {
  return `${scope.kind === "personal" ? "personal" : `workscene:${scope.sceneId}`}\0${domain}\0${category ?? ""}\0${id}`;
}

export function sameMemoryScope(
  left: MemoryScopeRef,
  right: MemoryScopeRef,
): boolean {
  return left.kind === right.kind &&
    (left.kind === "personal" ||
      (right.kind === "workscene" && left.sceneId === right.sceneId));
}

export function memoryLogicalEntryMatches(
  entry: MemoryLogicalEntry,
  input: {
    readonly scope: MemoryScopeRef;
    readonly domain: "memory" | "journal" | "people";
    readonly category?: MemoryCategoryDto;
    readonly query?: string;
  },
): boolean {
  if (
    !sameMemoryScope(entry.scope, input.scope) ||
    entry.domain !== input.domain ||
    (input.category !== undefined && entry.category !== input.category)
  ) {
    return false;
  }
  const needle = input.query?.trim().toLocaleLowerCase();
  return !needle || memoryLogicalSearchText(entry).includes(needle);
}

export function compareMemoryLogicalEntries(
  left: MemoryLogicalEntry,
  right: MemoryLogicalEntry,
): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    left.id.localeCompare(right.id, "en-US");
}

function memoryLogicalSearchText(entry: MemoryLogicalEntry): string {
  return `${entry.id} ${JSON.stringify(entry.meta)} ${entry.content}`.toLocaleLowerCase();
}

function requireJournalDate(updatedAt: string | undefined): string {
  if (!updatedAt) {
    throw new TypeError("Journal memory projection requires a date or authority time");
  }
  return updatedAt.slice(0, 10);
}
