/** The fields of `after` that differ from `before`, so a PATCH sends only what changed. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  return patch;
}
