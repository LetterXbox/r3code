// The connection catalog's secure document: connection/storage.ts (CatalogBackend, makeCatalogStore, decodeCatalog) over
// the desktop shell's DesktopConnectionCatalogStore.ts (the document is kept in OS secure storage, never in plain
// storage). The reference's catalog also holds the targets and profiles; this app keeps its saved-environment list in
// plain Storage (no secrets in it: pages/settings/environments/savedEnvironments.ts), so the secure document holds the
// credentials only (`StoredConnectionCredential`, BearerConnectionCredential).
import { SECURE_STORAGE_UNAVAILABLE_MESSAGE, secureStorage, setSecureStorageForTest, type SecureStorage } from "../backend/secureStorage";

export interface BearerConnectionCredential { _tag: "BearerConnectionCredential"; token: string }
export interface StoredConnectionCredential { connectionId: string; credential: BearerConnectionCredential }
export interface ConnectionCatalogDocument { schemaVersion: 1; credentials: StoredConnectionCredential[] }

export const EMPTY_CONNECTION_CATALOG_DOCUMENT: ConnectionCatalogDocument = Object.freeze({ schemaVersion: 1, credentials: [] }) as ConnectionCatalogDocument;

/** The reference's catalogError: a ConnectionTransientError (reason remote-unavailable) with this detail. */
export class ConnectionCatalogError extends Error {
  readonly _tag = "ConnectionTransientError";
  readonly reason = "remote-unavailable";
  constructor(operation: string, cause: unknown) {
    super(`Could not ${operation} the local connection catalog: ${String(cause)}`);
    this.name = "ConnectionCatalogError";
  }
}

/** decodeConnectionCatalogDocument: a JSON text of the document, or a throw. */
export function decodeConnectionCatalogDocument(raw: string): ConnectionCatalogDocument {
  const value = JSON.parse(raw) as unknown;
  const document = value as { schemaVersion?: unknown; credentials?: unknown } | null;
  if (!document || typeof document !== "object" || document.schemaVersion !== 1 || !Array.isArray(document.credentials)) throw new Error("The connection catalog document is not valid.");
  const credentials = document.credentials.map((entry): StoredConnectionCredential => {
    const item = entry as { connectionId?: unknown; credential?: { _tag?: unknown; token?: unknown } } | null;
    if (!item || typeof item.connectionId !== "string" || item.credential?._tag !== "BearerConnectionCredential" || typeof item.credential.token !== "string") {
      throw new Error("The connection catalog document is not valid.");
    }
    return { connectionId: item.connectionId, credential: { _tag: "BearerConnectionCredential", token: item.credential.token } };
  });
  return { schemaVersion: 1, credentials };
}

export const encodeConnectionCatalogDocument = (document: ConnectionCatalogDocument): string => JSON.stringify(document);

/** replaceCatalogValue / removeCatalogValue (client-runtime storageDocument.ts). */
export function replaceCatalogValue<A>(values: readonly A[], key: (value: A) => string, next: A): A[] {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}
export function removeCatalogValue<A>(values: readonly A[], key: (value: A) => string, removedKey: string): A[] {
  return values.filter((value) => key(value) !== removedKey);
}

export interface CatalogBackend {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  /** Preserve the unreadable document before replacing it. */
  quarantine(raw: string): Promise<void>;
}

const CATALOG_ACCOUNT = "connection-catalog";

/** makeCatalogBackend with a desktop bridge: the document in secure storage; unavailable reads as no document, a save as the error. */
export function makeSecureCatalogBackend(storage: SecureStorage): CatalogBackend {
  return {
    async read() {
      try {
        if (!(await storage.isEncryptionAvailable())) return null;
        return await storage.get(CATALOG_ACCOUNT);
      } catch (cause) {
        throw new ConnectionCatalogError("load", cause);
      }
    },
    async write(raw) {
      let stored: boolean;
      try {
        stored = await storage.isEncryptionAvailable();
        if (stored) await storage.set(CATALOG_ACCOUNT, raw);
      } catch (cause) {
        throw new ConnectionCatalogError("save", cause);
      }
      if (!stored) throw new ConnectionCatalogError("save", SECURE_STORAGE_UNAVAILABLE_MESSAGE);
    },
    async quarantine(raw) {
      try {
        if (!(await storage.isEncryptionAvailable())) throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE);
        await storage.set(`${CATALOG_ACCOUNT}.unreadable-${crypto.randomUUID()}`, raw);
      } catch (cause) {
        throw new ConnectionCatalogError("preserve", cause);
      }
    },
  };
}

export interface CatalogStore {
  read(): Promise<ConnectionCatalogDocument>;
  update(transform: (catalog: ConnectionCatalogDocument) => ConnectionCatalogDocument): Promise<void>;
}

/**
 * Serialize access to the catalog. An unreadable document stays in place until
 * an update can preserve it in secure storage and write a replacement.
 */
export function makeCatalogStore(backend: CatalogBackend): CatalogStore {
  let cached: ConnectionCatalogDocument | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <A>(task: () => Promise<A>): Promise<A> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const load = async (): Promise<
    { kind: "readable"; catalog: ConnectionCatalogDocument } | { kind: "unreadable"; raw: string }
  > => {
    if (cached) return { kind: "readable", catalog: cached };
    const raw = await backend.read();
    if (raw === null) {
      cached = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      return { kind: "readable", catalog: cached };
    }
    try {
      cached = decodeConnectionCatalogDocument(raw);
      return { kind: "readable", catalog: cached };
    } catch {
      console.warn("Could not decode the local connection catalog.");
      return { kind: "unreadable", raw };
    }
  };

  return {
    read: () => locked(async () => {
      const loaded = await load();
      return loaded.kind === "readable" ? loaded.catalog : EMPTY_CONNECTION_CATALOG_DOCUMENT;
    }),
    update: (transform) => locked(async () => {
      const loaded = await load();
      const next = transform(loaded.kind === "readable" ? loaded.catalog : EMPTY_CONNECTION_CATALOG_DOCUMENT);
      if (loaded.kind === "unreadable") await backend.quarantine(loaded.raw);
      await backend.write(encodeConnectionCatalogDocument(next));
      cached = next;
    }),
  };
}

let store: CatalogStore | null = null;
const catalogStore = (): CatalogStore => (store ??= makeCatalogStore(makeSecureCatalogBackend(secureStorage())));

export const readConnectionCatalog = (): Promise<ConnectionCatalogDocument> => catalogStore().read();
export const updateConnectionCatalog = (transform: (catalog: ConnectionCatalogDocument) => ConnectionCatalogDocument): Promise<void> => catalogStore().update(transform);

/** Tests only: runs the catalog over `storage` (backend/fakeKeychain.ts) from an empty cache; null restores the real one. */
export function useSecureStorageForTest(storage: SecureStorage | null) {
  setSecureStorageForTest(storage);
  store = null;
}
