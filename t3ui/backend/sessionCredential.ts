// The session credential (the bearer access token an environment issues for a one-time
// pairing token), kept per environment across restarts. The reference keeps it in the desktop
// shell's connection catalog, encrypted with OS secure storage (DesktopConnectionCatalogStore.ts);
// here it is a credential of environments/connectionCatalog.ts, in the macOS Keychain
// (backend/secureStorage.ts). The pairing token itself is never stored, only the bearer it was
// exchanged for.
//
// Earlier versions kept the bearer in plain Storage under `sessionBearer:<endpoint>`. A load that
// finds no secure credential moves that value into the Keychain once and deletes the plain copy;
// a save or a forget deletes it too. With secure storage unavailable nothing is read from or
// written to plain storage: a save throws the reference's error and a load finds no credential.
import { Storage } from "nsh";
import { readConnectionCatalog, removeCatalogValue, replaceCatalogValue, updateConnectionCatalog, type StoredConnectionCredential } from "../environments/connectionCatalog";

const legacyKeyFor = (endpoint: string) => `sessionBearer:${endpoint}`;
/** The catalog's connection id of an endpoint's bearer. */
export const bearerConnectionId = (endpoint: string) => `bearer:${endpoint}`;
const credentialKey = (value: StoredConnectionCredential) => value.connectionId;

const bearerCredential = (endpoint: string, token: string): StoredConnectionCredential => ({
  connectionId: bearerConnectionId(endpoint),
  credential: { _tag: "BearerConnectionCredential", token },
});

export async function saveSessionBearer(endpoint: string, bearer: string): Promise<void> {
  if (!endpoint || !bearer) return;
  await updateConnectionCatalog((catalog) => ({ ...catalog, credentials: replaceCatalogValue(catalog.credentials, credentialKey, bearerCredential(endpoint, bearer)) }));
  await Storage.removeItem(legacyKeyFor(endpoint)).catch(() => undefined);
}

export async function loadSessionBearer(endpoint: string): Promise<string | null> {
  if (!endpoint) return null;
  const catalog = await readConnectionCatalog();
  const stored = catalog.credentials.find((value) => value.connectionId === bearerConnectionId(endpoint));
  if (stored) return stored.credential.token.length > 0 ? stored.credential.token : null;
  return migrateLegacySessionBearer(endpoint);
}

/** Moves a bearer kept by an earlier version in plain Storage into secure storage; the plain copy goes once it is safe. */
export async function migrateLegacySessionBearer(endpoint: string): Promise<string | null> {
  if (!endpoint) return null;
  const legacy = await Storage.getItem(legacyKeyFor(endpoint)).catch(() => null);
  if (!legacy) return null;
  const present = (await readConnectionCatalog()).credentials.find((value) => value.connectionId === bearerConnectionId(endpoint));
  if (present) {
    // The secure credential is the newer one: the stale plain copy only goes.
    await Storage.removeItem(legacyKeyFor(endpoint)).catch(() => undefined);
    return present.credential.token || null;
  }
  try {
    await updateConnectionCatalog((catalog) => ({ ...catalog, credentials: replaceCatalogValue(catalog.credentials, credentialKey, bearerCredential(endpoint, legacy)) }));
  } catch {
    // Secure storage cannot take it (unavailable): the plain copy stays where it is, unread.
    return null;
  }
  await Storage.removeItem(legacyKeyFor(endpoint)).catch(() => undefined);
  return legacy;
}

export async function forgetSessionBearer(endpoint: string): Promise<void> {
  if (!endpoint) return;
  const catalog = await readConnectionCatalog();
  if (catalog.credentials.some((value) => value.connectionId === bearerConnectionId(endpoint))) {
    await updateConnectionCatalog((current) => ({ ...current, credentials: removeCatalogValue(current.credentials, credentialKey, bearerConnectionId(endpoint)) }));
  }
  await Storage.removeItem(legacyKeyFor(endpoint)).catch(() => undefined);
}
