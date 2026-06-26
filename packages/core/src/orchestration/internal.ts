export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneData(item)) as T;
  }

  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) cloned[key] = cloneData(item);
    }
    return cloned as T;
  }

  return value;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item);
  }

  return value;
}
