// SecretSourceInput.tsx / secretReference.ts / secret-provider-onepassword definition: a credential setting is a literal
// (kept by the server and redacted for clients) or a secret reference { provider, reference } to read it from. The server
// sends references only to clients that announce clientCapabilities=settingsSecretReferences (backend/auth.ts).
export interface SecretReference { provider: string; reference: string }
export interface SecretSource { id: string; kind: string; label: string }

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** secretReference.ts isSecretReference. */
export function isSecretReference(value: unknown): value is SecretReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.provider === "string" && item.provider.trim().length > 0 && item.provider.length <= 64 && PROVIDER_ID.test(item.provider)
    && typeof item.reference === "string" && item.reference.trim().length > 0 && item.reference.length <= 1024 && !/[\r\n]/.test(item.reference);
}
/** settingsSecretValue.ts settingsSecretLiteral. */
export const settingsSecretLiteral = (value: unknown): string => (typeof value === "string" ? value : "");

/** secret-provider-onepassword definition (the only built-in provider). */
const NAME = String.raw`[A-Za-z0-9._-](?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?`;
const OP_REFERENCE = new RegExp(String.raw`^op://${NAME}(?:/${NAME}){2,3}(?:\?[a-z-]+=[A-Za-z0-9_-]+)?$`);
export const SECRET_PROVIDER_DEFINITIONS: Record<string, { label: string; referencePlaceholder: string; invalidReferenceMessage: string; isReference: (reference: string) => boolean }> = {
  one_password: {
    label: "1Password",
    referencePlaceholder: "op://vault/item/field",
    invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
    isReference: (reference) => reference.length <= 1024 && OP_REFERENCE.test(reference),
  },
};
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** env.ts isSecretsFeatureEnabled: off unless T3CODE_FEATURE_SECRETS is 1/true. */
export const secretsFeatureEnabled = () => ["1", "true"].includes((process.env.T3CODE_FEATURE_SECRETS ?? "").trim().toLowerCase());

/** useSecretSources: the configured 1Password providers, empty when the feature is off or the server cannot read references. */
export function secretSources(settings: Record<string, unknown> | null, config: Record<string, unknown> | null, featureEnabled = secretsFeatureEnabled()): SecretSource[] {
  if (!featureEnabled || config?.secretReferences !== true) return [];
  const providers = settings?.secretProviders;
  if (!providers || typeof providers !== "object") return [];
  return Object.entries(providers as Record<string, unknown>).flatMap(([id, raw]) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const account = item?.config && typeof item.config === "object" ? (item.config as Record<string, unknown>).account : undefined;
    // classifySecretProvider: only one_password with a valid account is usable.
    if (item?.kind !== "one_password" || typeof account !== "string" || account.length > 253 || !ACCOUNT_PATTERN.test(account)) return [];
    return [{ id, kind: "one_password", label: typeof item.label === "string" ? item.label : id }];
  });
}

/** SecretSourceInput's commit of a reference field: the new reference, `undefined` (cleared) or a rejection message. */
export function commitSecretReference(provider: string, kindOf: (provider: string) => string | undefined, next: string): { secret: SecretReference } | { cleared: true } | { rejected: string } {
  if (next.trim().length === 0) return { cleared: true };
  const candidate = { provider, reference: next.trim() };
  const definition = SECRET_PROVIDER_DEFINITIONS[kindOf(provider) ?? ""];
  if (!isSecretReference(candidate) || definition?.isReference(candidate.reference) === false) {
    return { rejected: definition?.invalidReferenceMessage ?? "Enter a valid secret reference." };
  }
  return { secret: candidate };
}

// The primary's config `secretReferences` flag, from the store's one config stream.
import { signal } from "nsh";
import { onServerConfigEvent } from "../../store";
import { currentServerSettings } from "./settingsSync";
const secretReferencesSupported = signal(false);
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onServerConfigEvent((event) => {
    const config = event.type === "snapshot" ? event.config : event.payload;
    if (config && typeof config === "object" && typeof (config as Record<string, unknown>).secretReferences === "boolean") {
      secretReferencesSupported.set((config as Record<string, unknown>).secretReferences === true);
    }
  });
}
/** The selected environment's secret sources (SecretSourceInput's `sources`). */
export function currentSecretSources(): SecretSource[] {
  listen();
  return secretSources(currentServerSettings(), { secretReferences: secretReferencesSupported() });
}
