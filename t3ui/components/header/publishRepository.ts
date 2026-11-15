// The logic of PublishRepositoryDialog (GitActionsControl.tsx): the providers it offers, which of them are ready,
// the repository path rules and `sourceControl.publishRepository`. Pure but for the transport, which is a parameter.
import { SOURCE_HOSTS } from "../palette/addProject/addProjectLogic";
import { suggestAppAccessForRemote } from "../palette/addProject/appAccess";
import type { Request } from "./gitRuntime";

export interface PublishProviderOption {
  kind: string;
  label: string;
  /** definition.repositoryPathHint: the field's placeholder. */
  pathPlaceholder: string;
  /** definition.publishHost(signedInHost), before the discovered host is known. */
  host: (signedInHost: string | null) => string;
}

/** `definition.publishHost` per built-in provider (packages/source-control-*, shared/definition.ts). */
const PUBLISH_HOSTS: Record<string, (signedInHost: string | null) => string> = {
  github: () => "github.com",
  "cursor-origin": () => "origin.cursor.com",
  gitlab: () => "gitlab.com",
  gitcafe: () => "git.cafe",
  forgejo: (signedIn) => signedIn ?? "your server",
  bitbucket: () => "bitbucket.org",
  "azure-devops": () => "dev.azure.com",
};

/** PUBLISH_PROVIDER_OPTIONS: one per definition, the picker's label (Forgejo / Gitea) and path hint. */
export const PUBLISH_PROVIDER_OPTIONS: readonly PublishProviderOption[] = SOURCE_HOSTS.map((host) => ({
  kind: host.kind,
  label: host.pickerLabel,
  pathPlaceholder: host.repositoryPathHint,
  host: PUBLISH_HOSTS[host.kind] ?? (() => "your server"),
}));

export function publishProviderOption(kind: string | null): PublishProviderOption {
  return PUBLISH_PROVIDER_OPTIONS.find((option) => option.kind === kind) ?? PUBLISH_PROVIDER_OPTIONS[0]!;
}

/** What `server.discoverSourceControl` reports for one provider that publishing needs. */
export interface PublishDiscoveredProvider {
  kind: string;
  label: string;
  status: string;
  installHint: string;
  auth: { status: string; account: string | null; host: string | null; detail: string | null };
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : null);
/** An effect Option over the wire: a bare string, or `{ _tag: "Some", value }`. */
function option(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const tagged = dict(value);
  return tagged?._tag === "Some" && typeof tagged.value === "string" ? tagged.value : null;
}

export function readPublishDiscovery(value: unknown): PublishDiscoveredProvider[] {
  const list = dict(value)?.sourceControlProviders;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const item = dict(raw);
    if (!item || typeof item.kind !== "string") return [];
    const auth = dict(item.auth);
    return [{
      kind: item.kind,
      label: typeof item.label === "string" ? item.label : item.kind,
      status: typeof item.status === "string" ? item.status : "missing",
      installHint: typeof item.installHint === "string" ? item.installHint : "",
      auth: { status: typeof auth?.status === "string" ? auth.status : "unknown", account: option(auth?.account), host: option(auth?.host), detail: option(auth?.detail) },
    }];
  });
}

export interface PublishReadiness { ready: boolean; hint: string | null }

/** getPublishProviderReadiness. */
export function publishProviderReadiness(kind: string, discovered: readonly PublishDiscoveredProvider[]): PublishReadiness {
  const found = discovered.find((provider) => provider.kind === kind);
  if (!found) return { ready: false, hint: "Provider status unavailable. Open Settings -> Source control and rescan." };
  if (found.status !== "available") return { ready: false, hint: found.installHint };
  if (found.auth.status === "unauthenticated") {
    return { ready: false, hint: found.auth.detail ?? `${found.label} is not authenticated. Open Settings -> Source control for setup guidance.` };
  }
  return { ready: true, hint: null };
}

/** Ready providers first, then by label (`localeCompare`). */
export function sortPublishProviders(discovered: readonly PublishDiscoveredProvider[]): PublishProviderOption[] {
  const ready = (kind: string) => publishProviderReadiness(kind, discovered).ready;
  return [...PUBLISH_PROVIDER_OPTIONS].sort((left, right) => {
    if (ready(left.kind) !== ready(right.kind)) return ready(left.kind) ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

/** The provider the dialog acts on: the chosen one while it is ready, else the first ready one, else the chosen or the default. */
export function resolvePublishProvider(selected: string | null, discovered: readonly PublishDiscoveredProvider[]): string {
  if (selected !== null && publishProviderReadiness(selected, discovered).ready) return selected;
  const first = sortPublishProviders(discovered).find((option) => publishProviderReadiness(option.kind, discovered).ready)?.kind;
  return first ?? selected ?? PUBLISH_PROVIDER_OPTIONS[0]!.kind;
}

/** The repository field's prefill: `<account>/` of the signed-in account. */
export function publishRepositoryPrefill(provider: string, discovered: readonly PublishDiscoveredProvider[]): string {
  const account = discovered.find((item) => item.kind === provider)?.auth.account ?? null;
  return account ? `${account}/` : "";
}

/** The host shown before the path: the provider's, or the signed-in server's for Forgejo. */
export function publishHostFor(provider: string, discovered: readonly PublishDiscoveredProvider[]): string {
  return publishProviderOption(provider).host(discovered.find((item) => item.kind === provider)?.auth.host ?? null);
}

export function splitRepository(repository: string): { owner: string; name: string } {
  const parts = repository.trim().split("/");
  return { owner: parts[0]?.trim() ?? "", name: parts.slice(1).join("/").trim() };
}

export function canSubmitPublish(input: { allowed: boolean; ready: boolean; pending: boolean; repository: string }): boolean {
  const { owner, name } = splitRepository(input.repository);
  return input.allowed && input.ready && !input.pending && owner.length > 0 && name.length > 0;
}

export interface PublishInput {
  provider: string;
  repository: string;
  visibility: "private" | "public";
  remoteName: string;
  protocol: "ssh" | "https";
}

export interface PublishResult {
  status: "pushed" | "remote_added";
  branch: string;
  remoteName: string;
  repository: { nameWithOwner: string; url: string };
  remoteUrl: string;
}

/** `sourceControl.publishRepository` (SourceControlPublishRepositoryInput); the remote name falls back to origin. */
export async function publishRepository(cwd: string, input: PublishInput, request: Request): Promise<PublishResult> {
  const result = dict(await request("sourceControl.publishRepository", {
    cwd, provider: input.provider, repository: input.repository.trim(), visibility: input.visibility,
    remoteName: input.remoteName.trim() || "origin", protocol: input.protocol,
  }, { timeoutMs: 120_000 }));
  const repository = dict(result?.repository);
  if (!result || !repository || typeof repository.nameWithOwner !== "string" || typeof repository.url !== "string") throw new Error("The server returned an invalid publish result.");
  const remoteUrl = typeof result.remoteUrl === "string" ? result.remoteUrl : repository.url;
  // useSourceControlPublishRepositoryAction: a published repository is offered the forge app's access, as after a clone.
  void suggestAppAccessForRemote(request, remoteUrl);
  return {
    status: result.status === "pushed" ? "pushed" : "remote_added",
    branch: typeof result.branch === "string" ? result.branch : "",
    remoteName: typeof result.remoteName === "string" ? result.remoteName : "origin",
    repository: { nameWithOwner: repository.nameWithOwner, url: repository.url },
    remoteUrl,
  };
}

/** The summary step's copy. */
export function publishSummaryCopy(result: PublishResult, providerLabel: string): { title: string; body: string } {
  return result.status === "pushed"
    ? { title: "Repository published", body: `${result.branch} is now live on ${providerLabel}.` }
    : { title: "Repository created", body: `Remote "${result.remoteName}" is set up. Make a commit and push it to share your code.` };
}
