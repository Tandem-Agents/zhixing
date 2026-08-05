import type { MemoryCategoryDto } from "./contracts.js";

export type MemoryCanonicalIdentity =
  | { readonly domain: "memory"; readonly category: "profile"; readonly id: "profile" }
  | { readonly domain: "people"; readonly category?: never; readonly id: string }
  | { readonly domain: "journal"; readonly category?: never; readonly id: string };

const SAFE_PERSON_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/iu;
const CALENDAR_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u;
const CALENDAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

export function canonicalMemoryIdentity(
  input: {
    readonly domain: "memory" | "journal" | "people";
    readonly category?: MemoryCategoryDto;
    readonly id: string;
  },
  options: { readonly allowJournalMonth?: boolean } = {},
): MemoryCanonicalIdentity {
  if (input.domain === "memory") {
    if (input.category !== "profile" || input.id !== "profile") {
      throw new TypeError("Profile memory identity must be memory/profile/profile");
    }
    return { domain: "memory", category: "profile", id: "profile" };
  }
  if (input.category !== undefined) {
    throw new TypeError("People and journal identities must not carry a category");
  }
  if (input.domain === "people") {
    return { domain: "people", id: assertSafePersonId(input.id) };
  }
  if (
    !isCalendarDay(input.id) &&
    !(options.allowJournalMonth && isCalendarMonth(input.id))
  ) {
    throw new TypeError("Journal memory identity must be a real calendar day");
  }
  return { domain: "journal", id: input.id };
}

export function assertSafePersonId(value: string): string {
  if (
    value.length < 1 ||
    value.length > 64 ||
    !SAFE_PERSON_ID.test(value) ||
    WINDOWS_RESERVED_BASENAME.test(value)
  ) {
    throw new TypeError("Person memory id must be a safe lowercase slug");
  }
  return value;
}

export function isCalendarDay(value: string): boolean {
  if (!CALENDAR_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isCalendarMonth(value: string): boolean {
  return CALENDAR_MONTH.test(value);
}

export function isSubstantiveJournalContent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertSubstantiveJournalContent(value: unknown): asserts value is string {
  if (!isSubstantiveJournalContent(value)) {
    throw new TypeError("Journal content must contain non-whitespace text");
  }
}

export function assertMemoryStorageIdentity(
  category: "profile" | "person" | "journal",
  id: string,
): void {
  canonicalMemoryIdentity(
    category === "profile"
      ? { domain: "memory", category: "profile", id }
      : category === "person"
        ? { domain: "people", id }
        : { domain: "journal", id },
    { allowJournalMonth: true },
  );
}
