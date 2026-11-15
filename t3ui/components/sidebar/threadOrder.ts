// The order keys that arrange Pinned and Active rows, ported from
// packages/client-runtime/src/state/threadSort.ts (pinOrderKeyBetween, generateSpreadPinOrderKeys,
// planPinnedReorder, sortPinnedThreadsByOrderKey, sortActiveThreadsByOrderKey). The server keeps one
// short lowercase key per thread (`pinOrderKey`, `activeOrderKey`); a drop writes one key between the
// neighbours, or respreads the section when the keys cannot take it.
const DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) if (!DIGITS.includes(char)) return false;
  // A trailing minimum digit leaves no room before the key; generators never emit it.
  return key.at(-1) !== DIGITS[0];
}

/** Midpoint of two digit strings read as fractions in (0, 1); "" is the open bound. Needs a < b. */
function midpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("order key bounds out of order");
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? DIGITS.length : DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  if (b.length > 1) return b.charAt(0);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), "");
}

/** A key strictly between two neighbours; null when the neighbours' keys are corrupt or out of order. */
export function orderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidKey(a)) return null;
  if (b !== "" && !isValidKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return midpoint(a, b);
}

export function spreadOrderKeys(count: number): string[] {
  let width = 2;
  let space = DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = DIGITS.charAt(value % DIGITS.length) + key;
      value = Math.floor(value / DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

export interface OrderAssignment { id: string; orderKey: string }

/** The key writes that put `movedId` where `orderedIds` has it. Hidden rows' keys are reserved. */
export function planReorder(input: {
  orderedIds: readonly string[];
  keysById: ReadonlyMap<string, string | null | undefined>;
  movedId: string;
}): OrderAssignment[] {
  const { orderedIds, keysById, movedId } = input;
  const visible = new Set(orderedIds);
  const reserved = new Set([...keysById].flatMap(([id, key]) => (!visible.has(id) && key != null ? [key] : [])));
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  if ((beforeId === null || beforeKey != null) && (afterId === null || afterKey != null)) {
    let key = orderKeyBetween(beforeKey, afterKey);
    while (key !== null && reserved.has(key)) key = orderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = spreadOrderKeys(orderedIds.length + reserved.size).filter((key) => !reserved.has(key)).slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => (keysById.get(id) === keys[index] ? [] : [{ id, orderKey: keys[index]! }]));
}

type ThreadIdentity = { id: string; environmentId?: string };

/** A remote row's stored id is scoped; the reference breaks ties on the local id first. */
export function localThreadId(thread: ThreadIdentity): string {
  const prefix = thread.environmentId ? `${thread.environmentId}:` : "";
  return prefix && thread.id.startsWith(prefix) ? thread.id.slice(prefix.length) : thread.id;
}

export function compareThreadIdentity(left: ThreadIdentity, right: ThreadIdentity): number {
  return localThreadId(left).localeCompare(localThreadId(right)) || (left.environmentId ?? "").localeCompare(right.environmentId ?? "");
}

const timestamp = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Pinned rows: keyed rows by key, then keyless rows by creation time. */
export function sortPinnedByKey<T extends ThreadIdentity & { createdAt?: number; meta?: { pinOrderKey?: string | null } }>(threads: readonly T[]): T[] {
  const keyed = threads.filter((thread) => thread.meta?.pinOrderKey != null);
  const keyless = threads.filter((thread) => thread.meta?.pinOrderKey == null);
  keyed.sort((a, b) => {
    const left = a.meta!.pinOrderKey!;
    const right = b.meta!.pinOrderKey!;
    return left < right ? -1 : left > right ? 1 : compareThreadIdentity(a, b);
  });
  keyless.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || compareThreadIdentity(a, b));
  return [...keyed, ...keyless];
}

/** Active rows: keyless rows by creation or unsettle time, then keyed rows by key. */
export function sortActiveByKey<T extends ThreadIdentity & { createdAt?: number; meta?: { activeOrderKey?: string | null; unsettledAt?: number | null } }>(threads: readonly T[]): T[] {
  const keyed = threads.filter((thread) => thread.meta?.activeOrderKey != null);
  const keyless = threads.filter((thread) => thread.meta?.activeOrderKey == null);
  keyed.sort((a, b) => {
    const left = a.meta!.activeOrderKey!;
    const right = b.meta!.activeOrderKey!;
    return left < right ? -1 : left > right ? 1 : compareThreadIdentity(a, b);
  });
  const anchor = (thread: T) => Math.max(timestamp(thread.createdAt), timestamp(thread.meta?.unsettledAt));
  keyless.sort((a, b) => anchor(b) - anchor(a) || compareThreadIdentity(a, b));
  return [...keyless, ...keyed];
}

/** `order` with `movedId` taken out and put at `index` among the others. */
export function moveToIndex(order: readonly string[], movedId: string, index: number): string[] {
  const rest = order.filter((id) => id !== movedId);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, movedId);
  return rest;
}
