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
  /** The web backend keeps a corrupt document aside; the desktop (secure storage) one does not. */
  quarantine?(raw: string): Promise<void>;
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
  };
}

export interface CatalogStore {
  read(): Promise<ConnectionCatalogDocument>;
  update(transform: (catalog: ConnectionCatalogDocument) => ConnectionCatalogDocument): Promise<void>;
}

/**
 * makeCatalogStore: one cached copy, every read and update behind one lock. A document that fails to decode is discarded:
 * warned about, kept aside when the backend can, replaced by the empty catalog (persisted when it can be), and read as empty.
 */
export function makeCatalogStore(backend: CatalogBackend): CatalogStore {
  let cached: ConnectionCatalogDocument | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <A>(task: () => Promise<A>): Promise<A> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  const load = async (): Promise<ConnectionCatalogDocument> => {
    if (cached) return cached;
    const raw = await backend.read();
    let catalog = EMPTY_CONNECTION_CATALOG_DOCUMENT;
    if (raw !== null && raw.trim() !== "") {
      try {
        catalog = decodeConnectionCatalogDocument(raw);
      } catch (error) {
        console.warn("Discarding a corrupt web connection catalog.", { error: message(error) });
        if (backend.quarantine) {
          await backend.quarantine(raw).catch((cause: unknown) => console.warn("Could not quarantine the corrupt web connection catalog.", { error: message(cause) }));
        }
        await backend.write(encodeConnectionCatalogDocument(EMPTY_CONNECTION_CATALOG_DOCUMENT))
          .catch((cause: unknown) => console.warn("Could not persist the recovered web connection catalog.", { error: message(cause) }));
        catalog = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      }
    }
    cached = catalog;
    return catalog;
  };

  return {
    read: () => locked(load),
    update: (transform) => locked(async () => {
      const next = transform(await load());
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
