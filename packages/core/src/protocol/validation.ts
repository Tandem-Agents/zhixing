export const MAX_PROTOCOL_IDENTIFIER_LENGTH = 480;
const CROCKFORD_ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function isProtocolIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PROTOCOL_IDENTIFIER_LENGTH
  );
}

export function assertProtocolIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isProtocolIdentifier(value)) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

export function isPrefixedUlid(value: unknown, prefix: string): value is string {
  return (
    typeof value === "string" &&
    typeof prefix === "string" &&
    prefix.length > 0 &&
    value.startsWith(prefix) &&
    CROCKFORD_ULID_PATTERN.test(value.slice(prefix.length))
  );
}

export function assertPrefixedUlid(
  value: unknown,
  prefix: string,
  label: string,
): asserts value is string {
  if (!isPrefixedUlid(value, prefix)) {
    throw new TypeError(`${label} must be ${prefix}<Ulid>`);
  }
}
