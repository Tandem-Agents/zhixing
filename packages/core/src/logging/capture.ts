import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type {
  LogAccess,
  LogCapture,
  LogDraft,
  LogField,
  LogPolicy,
  LogRef,
  LogSource,
  LogValue,
} from "./contracts.js";

const SECRET_KEY =
  /(?:secret|passw(?:or)?d|passwd|pwd|credential|authorization|cookie|private.?key|token|api.?key|headers|environment|full.?config)/iu;
const TOKEN = /^[a-zA-Z0-9_.:-]{1,160}$/u;
const RESULTS = new Set(["success", "failure", "unknown", "refused", "cancelled"]);
export function validLogToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value) && scrubSecrets(value).scrubbed === value;
}
function plain(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw Error("invalid-log-object");
}
function field(value: unknown, name: string): unknown {
  plain(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor && !Object.hasOwn(descriptor, "value")) throw Error("log-accessor");
  return descriptor?.value;
}
function safeText(
  value: string,
  maxBytes: number,
): { text: string; redacted: boolean; truncated: boolean } {
  const prefix = value.slice(0, maxBytes);
  // Truncated credentials must not depend on a closing delimiter for redaction.
  const closed = prefix
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gu, "«已脱敏:private-key»")
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]+/gu, "«已脱敏:key»")
    .replace(
      /\b(?:token|password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*[^\s]*/giu,
      "«已脱敏:credential»",
    );
  const clean = scrubSecrets(closed).scrubbed,
    bytes = Buffer.from(clean);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString("utf8"),
    redacted: clean !== prefix,
    truncated: prefix.length !== value.length || bytes.length > maxBytes,
  };
}

/** Validated outside the producer hot path. Recursive JSON requires a finite field schema. */
export function bindLogSource(source: LogSource): LogSource {
  const copy = structuredClone(source);
  if (
    !validLogToken(copy.id) ||
    !Number.isSafeInteger(copy.version) ||
    copy.version < 1 ||
    Object.keys(copy.events).length > 64
  )
    throw Error("invalid-log-source");
  let nodes = 0;
  const validate = (fields: Readonly<Record<string, LogField>>, depth: number): void => {
    if (depth > 6 || Object.keys(fields).length > 64) throw Error("log-schema-too-large");
    for (const [key, spec] of Object.entries(fields)) {
      if (++nodes > 512 || !validLogToken(key) || key === "__proto__")
        throw Error("invalid-log-field-schema");
      if (typeof spec === "string") {
        if (!["text", "number", "boolean", "secret"].includes(spec))
          throw Error("invalid-log-field-schema");
      } else if ("fields" in spec) validate(spec.fields, depth + 1);
      else {
        if (!Number.isInteger(spec.maxItems) || spec.maxItems < 1 || spec.maxItems > 32)
          throw Error("invalid-log-array-bound");
        validate({ item: spec.items }, depth + 1);
      }
    }
  };
  for (const [event, definition] of Object.entries(copy.events)) {
    if (
      !validLogToken(event) ||
      !["debug", "info", "warn", "error"].includes(definition.level) ||
      !["critical", "detail"].includes(definition.tier) ||
      typeof definition.message !== "string"
    )
      throw Error("invalid-log-event");
    validate(definition.fields, 0);
  }
  return copy;
}

/** No input enumeration, iterators, toJSON, accessors or proxies execute here. */
export function captureLog(
  source: LogSource,
  access: LogAccess,
  draft: LogDraft,
  policy: LogPolicy,
  processId: string,
  seq: number,
): LogCapture {
  if (!validLogToken(access.scope)) throw Error("invalid-log-access");
  const event = field(draft, "event");
  if (!validLogToken(event)) throw Error("invalid-log-event");
  const definition = Object.getOwnPropertyDescriptor(source.events, event)?.value as
    | LogSource["events"][string]
    | undefined;
  if (!definition) throw Error("unknown-log-event");
  let nodes = 0,
    remaining = policy.attachmentBytes,
    redacted = false,
    truncated = false;
  const project = (value: unknown, spec: LogField): LogValue => {
    if (++nodes > 1024 || remaining <= 0) {
      truncated = true;
      return "[已截断]";
    }
    remaining -= 16;
    if (spec === "text") {
      if (typeof value !== "string") throw Error("invalid-log-text");
      const result = safeText(value, Math.max(0, remaining));
      redacted ||= result.redacted;
      truncated ||= result.truncated;
      remaining -= Buffer.byteLength(result.text);
      return result.text;
    }
    if (spec === "number" || spec === "boolean") {
      if (typeof value !== spec) throw Error("invalid-log-scalar");
      return typeof value === "number"
        ? Number.isFinite(value)
          ? value
          : null
        : (value as boolean);
    }
    if (spec === "secret") {
      redacted = true;
      return null;
    }
    plain(value);
    if ("fields" in spec) return object(value, spec.fields);
    if (!Array.isArray(value)) throw Error("invalid-log-array");
    const length = field(value, "length") as number,
      result: LogValue[] = [];
    for (let index = 0; index < Math.min(length, spec.maxItems); index++)
      result.push(project(field(value, String(index)), spec.items));
    truncated ||= length > spec.maxItems;
    return result;
  };
  const object = (
    value: unknown,
    schema: Readonly<Record<string, LogField>>,
  ): Record<string, LogValue> => {
    const result: Record<string, LogValue> = {};
    for (const [key, spec] of Object.entries(schema)) {
      const item = field(value, key);
      if (item === undefined) continue;
      if (spec === "secret" || SECRET_KEY.test(key)) {
        redacted = true;
        continue;
      }
      result[key] = project(item, spec);
    }
    return result;
  };
  const data = object(field(draft, "data") ?? {}, definition.fields);
  const refs: LogRef[] = [],
    sourceRefs = field(draft, "refs");
  if (sourceRefs !== undefined) {
    plain(sourceRefs);
    if (!Array.isArray(sourceRefs)) throw Error("invalid-log-refs");
    const count = field(sourceRefs, "length") as number;
    if (count > 16) throw Error("too-many-log-refs");
    for (let index = 0; index < count; index++) {
      const ref = field(sourceRefs, String(index));
      const kind = field(ref, "kind"),
        id = field(ref, "id"),
        storeId = field(ref, "storeId");
      if (
        !validLogToken(kind) ||
        !validLogToken(id) ||
        (storeId !== undefined && !validLogToken(storeId))
      ) {
        redacted = true;
        continue;
      }
      refs.push({
        kind,
        id,
        ...(storeId ? { storeId: storeId as string } : {}),
      });
    }
  }
  const result = field(draft, "result") as LogDraft["result"];
  if (result !== undefined && !RESULTS.has(result)) throw Error("invalid-log-result");
  const message = safeText(definition.message, 512);
  const record = {
    schema: 1 as const,
    id: randomUUID(),
    process: processId,
    seq,
    occurredAt: Date.now(),
    source: source.id,
    sourceVersion: source.version,
    event,
    level: definition.level,
    tier: definition.tier,
    refs,
    access: { scope: access.scope },
    message: message.text,
    ...(result === undefined ? {} : { result }),
    data,
    redacted: redacted || message.redacted,
    truncated,
  };
  if (Buffer.byteLength(JSON.stringify(record)) + 512 <= policy.recordBytes) return { record };
  const detail = JSON.stringify(data),
    minimal = { ...record, data: {}, truncated: true };
  while (refs.length && Buffer.byteLength(JSON.stringify(minimal)) + 512 > policy.recordBytes)
    refs.pop();
  if (Buffer.byteLength(JSON.stringify(minimal)) + 512 > policy.recordBytes)
    throw Error("log-envelope-too-large");
  return {
    record: minimal,
    ...(Buffer.byteLength(detail) <= policy.attachmentBytes ? { detail } : {}),
  };
}
