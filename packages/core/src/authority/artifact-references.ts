import type { ArtifactRef } from "../contracts/index.js";

const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function dataProperties(value: object): Map<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Authority records must contain only plain objects and arrays");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Authority records cannot contain symbol properties");
  }

  const properties = new Map<string, unknown>();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("Authority records cannot contain accessor-backed properties");
    }
    properties.set(key, descriptor.value);
  }
  return properties;
}

export function assertArtifactRef(value: unknown): asserts value is ArtifactRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("ArtifactRef must be a plain object");
  }
  const properties = dataProperties(value);
  const digest = properties.get("digest");
  const bytes = properties.get("bytes");
  if (
    typeof digest !== "string" ||
    !ARTIFACT_DIGEST.test(digest) ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) < 0
  ) {
    throw new TypeError("ArtifactRef must contain a SHA-256 digest and a non-negative byte count");
  }
}

export function collectArtifactRefs(value: unknown): ArtifactRef[] {
  const found = new Map<string, ArtifactRef>();
  const active = new WeakSet<object>();

  function visit(candidate: unknown): void {
    if (candidate === null || typeof candidate !== "object") return;
    if (active.has(candidate)) {
      throw new TypeError("Authority records cannot contain cyclic values");
    }
    active.add(candidate);

    if (Array.isArray(candidate)) {
      try {
        if (Object.keys(candidate).length !== candidate.length) {
          throw new TypeError("Authority records cannot contain sparse arrays or extra properties");
        }
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError("Authority records cannot contain accessor-backed properties");
          }
          visit(descriptor.value);
        }
      } finally {
        active.delete(candidate);
      }
      return;
    }

    try {
      const properties = dataProperties(candidate);
      const digest = properties.get("digest");
      const bytes = properties.get("bytes");
      if (typeof digest === "string" && typeof bytes === "number") {
        const ref = { digest, bytes };
        assertArtifactRef(ref);
        const existing = found.get(ref.digest);
        if (existing && existing.bytes !== ref.bytes) {
          throw new TypeError("The same artifact digest cannot declare different byte counts");
        }
        found.set(ref.digest, ref);
      }
      for (const nested of properties.values()) visit(nested);
    } finally {
      active.delete(candidate);
    }
  }

  visit(value);
  return [...found.values()].sort((left, right) => left.digest.localeCompare(right.digest));
}

export function artifactDigestHex(ref: ArtifactRef): string {
  assertArtifactRef(ref);
  return ref.digest.slice("sha256:".length);
}
