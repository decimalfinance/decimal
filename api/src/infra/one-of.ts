// Text a database column or a stored JSON blob holds as a plain string, narrowed
// to the values the contract promises (api/src/contract/). Without it the API
// would send `string` where a page switches on a fixed set of values.

/** `value` when it is one of `allowed`, else `fallback`. */
export function oneOf<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Every value of a union, as a list the compiler checks: leave one out, or add
 * one the union doesn't have, and it fails to compile.
 *   const STATUSES = allOf<DocumentStatus>()(['processing', 'processed', 'failed', 'removed']);
 */
export function allOf<T extends string>() {
  return <const L extends readonly T[]>(list: L & ([Exclude<T, L[number]>] extends [never] ? unknown : { missing: Exclude<T, L[number]> })): readonly T[] => list;
}
