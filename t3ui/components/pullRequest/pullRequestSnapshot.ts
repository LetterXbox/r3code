import { Storage } from "nsh";
import { parsePullRequestPage, type PullRequestPage } from "../../pages/utility-data";

const STORAGE_KEY = "r3.pullRequests.snapshots.v1";
const LIMIT = 8;
type Snapshot = { key: string; answer: unknown };
let writes: Promise<void> = Promise.resolve();

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSnapshots(): Promise<Snapshot[]> {
  const raw = await Storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(decoded)) return [];
  return decoded.flatMap((entry): Snapshot[] => {
    if (typeof entry !== "object" || entry === null || !("key" in entry) || typeof entry.key !== "string" || !("answer" in entry)) return [];
    return [{ key: entry.key, answer: entry.answer }];
  }).slice(0, LIMIT);
}

/** Keys are hashed because a connection namespace can contain credentials. */
export async function readPullRequestSnapshot(scope: string): Promise<PullRequestPage | null> {
  try {
    const key = await digest(scope);
    const snapshot = (await readSnapshots()).find((entry) => entry.key === key);
    return snapshot ? parsePullRequestPage(snapshot.answer) : null;
  } catch { return null; }
}

/** Save first-page answers only, without transient errors or continuation cursors. */
export function writePullRequestSnapshot(scope: string, answer: unknown): Promise<void> {
  writes = writes.then(async () => {
    const page = parsePullRequestPage(answer);
    const key = await digest(scope);
    const safe = {
      entries: page.entries.slice(0, 99).map(({ author, authorAvatarUrl, ...entry }) => ({ ...entry, author: { login: author, avatarUrl: authorAvatarUrl } })),
      viewers: page.viewers,
      providers: page.providers,
      truncated: page.truncated,
      errors: [],
      nextCursors: {},
    };
    parsePullRequestPage(safe);
    const held = await readSnapshots();
    await Storage.setItem(STORAGE_KEY, JSON.stringify([{ key, answer: safe }, ...held.filter((entry) => entry.key !== key)].slice(0, LIMIT)));
  }).catch(() => {});
  return writes;
}
