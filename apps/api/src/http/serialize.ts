/** A view as JSON sends it: dates as ISO strings, read-only arrays as plain arrays. */
export type Serialized<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Serialized<T[K]> }
      : T;

/** Converts a service view for a contract's output: every Date becomes an ISO string. */
export function serialize<T>(value: T): Serialized<T> {
  if (value instanceof Date) return value.toISOString() as Serialized<T>;
  if (Array.isArray(value)) return value.map((v: unknown) => serialize(v)) as Serialized<T>;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = serialize(v);
    return out as Serialized<T>;
  }
  return value as Serialized<T>;
}
