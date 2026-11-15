// Reuse immutable row data when a refresh produces equivalent objects. Unknown
// or deeply nested values invalidate conservatively instead of risking stale UI.
function sameValue(left: unknown, right: unknown, depth: number): boolean {
  if (Object.is(left, right)) return true;
  if (depth === 0 || left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index], depth - 1));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key], depth - 1));
}

export function createStableRows<T>(keyOf: (row: T) => string) {
  let scope = "";
  let previous: T[] = [];
  return (nextScope: string, next: T[]): T[] => {
    if (scope !== nextScope) { scope = nextScope; previous = []; }
    const byId = new Map<string, T>();
    const duplicates = new Set<string>();
    for (const row of previous) {
      const key = keyOf(row);
      if (byId.has(key)) { byId.delete(key); duplicates.add(key); }
      else if (!duplicates.has(key)) byId.set(key, row);
    }
    const nextKeys = new Set<string>();
    for (const row of next) {
      const key = keyOf(row);
      if (nextKeys.has(key)) { byId.delete(key); duplicates.add(key); }
      nextKeys.add(key);
    }
    const rows = next.map((row) => {
      const old = byId.get(keyOf(row));
      return old !== undefined && sameValue(old, row, 4) ? old : row;
    });
    if (rows.length === previous.length && rows.every((row, index) => row === previous[index])) return previous;
    previous = rows;
    return rows;
  };
}
