// PullRequestRoutingSettings.tsx (components/settings/PullRequestRoutingSettings.tsx): per environment, whether machines
// trusted here may read (or act on) pull requests through each other's source control access. Shown on Connections with
// two or more environments. Device-local like the reference (client-runtime pullRequestRoutingPermissions.ts, kept in the
// app's own Storage), keyed by the saved endpoints so changing an address revokes trust.
// Not ported: the client-side router that sends a PR read to another trusted environment (state/pullRequestRouting.ts);
// this client holds one live connection, so the stored permission has nothing to route between yet.
import { signal, Storage, Text, View } from "nsh";
import { Select } from "nsh/base";
import { showToast } from "../../../components/toast";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection, UiIcon } from "../providers/ui";

export type PullRequestRoutingPermission = "off" | "read" | "read-write";
export interface StoredPullRequestRoutingPermission { environmentId: string; connectionKey: string; permission: PullRequestRoutingPermission }
export interface PullRequestRoutingEnvironment { environmentId: string; label: string; subtitle: string; kind: "desktop" | "server"; urls: string[] }

export const PULL_REQUEST_ROUTING_OPTIONS: ReadonlyArray<{ value: PullRequestRoutingPermission; label: string }> = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read PRs" },
  { value: "read-write", label: "Read and act" },
];
const summaryLabels = { "read-write": "read and act", read: "read PRs" } as const;

function routeKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "ws:", "wss:", "ssh:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href.replace(/\/+$/, "");
  } catch { return null; }
}

/** pullRequestRoutingConnectionKey: trust belongs to the saved endpoints; several routes are sorted so reordering keeps it. */
export function pullRequestRoutingConnectionKey(environment: { environmentId: string; urls: string[] }): string | null {
  if (environment.urls.length === 0) return null;
  const keys = environment.urls.map(routeKey);
  if (keys.some((key) => key === null)) return null;
  return keys.length === 1 ? JSON.stringify([environment.environmentId, keys[0]]) : JSON.stringify([environment.environmentId, ...[...(keys as string[])].sort()]);
}

export function pullRequestRoutingPermissionFor(environment: { environmentId: string; urls: string[] }, permissions: ReadonlyArray<StoredPullRequestRoutingPermission>): PullRequestRoutingPermission {
  const key = pullRequestRoutingConnectionKey(environment);
  return key === null ? "off" : (permissions.find((entry) => entry.connectionKey === key)?.permission ?? "off");
}

export function summarizePullRequestRouting(entries: ReadonlyArray<{ label: string; permission: PullRequestRoutingPermission }>): string | null {
  const groups = (["read-write", "read"] as const).flatMap((permission) => {
    const labels = entries.filter((entry) => entry.permission === permission);
    return labels.length === 0 ? [] : [`${labels.map((entry) => entry.label).join(", ")} ${summaryLabels[permission]}`];
  });
  return groups.length === 0 ? null : groups.join(" · ");
}

/** PullRequestRoutingPermissions.set: replaces the environment's entry; "off" removes it. */
export function setPermission(current: ReadonlyArray<StoredPullRequestRoutingPermission>, environment: { environmentId: string; urls: string[] }, permission: PullRequestRoutingPermission): StoredPullRequestRoutingPermission[] {
  const connectionKey = pullRequestRoutingConnectionKey(environment);
  if (connectionKey === null) throw new Error("This environment does not have a saved connection endpoint.");
  return [...current.filter((entry) => entry.environmentId !== environment.environmentId), ...(permission === "off" ? [] : [{ environmentId: environment.environmentId, connectionKey, permission }])];
}

const KEY = "githubRoutingPermissions";
const permissions = signal<StoredPullRequestRoutingPermission[]>([]);
const ready = signal(false);
let started = false;
function parse(raw: string | null): StoredPullRequestRoutingPermission[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value.filter((entry): entry is StoredPullRequestRoutingPermission => typeof entry?.environmentId === "string" && typeof entry?.connectionKey === "string" && ["read", "read-write"].includes(entry?.permission)) : [];
  } catch { return []; }
}
function hydrate() {
  if (started) return;
  started = true;
  void Storage.getItem(KEY).then((raw) => { if (!ready()) permissions.set(parse(raw)); }).catch(() => {}).finally(() => ready.set(true));
}
/** Tests start from a clean copy. */
export function resetPullRequestRoutingPermissions(): void { permissions.set([]); ready.set(false); started = false; }
export function pullRequestRoutingPermissions(): StoredPullRequestRoutingPermission[] { hydrate(); return permissions(); }

export function PullRequestRoutingSettings(props: { environments: ReadonlyArray<PullRequestRoutingEnvironment>; write?: (key: string, value: string) => Promise<void> }) {
  const saving = signal(false);
  const write = props.write ?? ((key: string, value: string) => Storage.setItem(key, value));
  const current = () => pullRequestRoutingPermissions();
  const valueFor = (environment: PullRequestRoutingEnvironment) => pullRequestRoutingPermissionFor(environment, current());
  const labelFor = (environment: PullRequestRoutingEnvironment) => PULL_REQUEST_ROUTING_OPTIONS.find((option) => option.value === valueFor(environment))?.label ?? "Off";
  const update = async (environment: PullRequestRoutingEnvironment, permission: PullRequestRoutingPermission) => {
    saving.set(true);
    try {
      const next = setPermission(current(), environment, permission);
      await write(KEY, JSON.stringify(next));
      ready.set(true);
      permissions.set(next);
    } catch {
      showToast({ type: "error", title: "Could not save pull request routing permission" });
    } finally { saving.set(false); }
  };
  return <View>{props.environments.length < 2 ? null : <FoldedSettingsSection title="Pull request sharing" testID="Pull request sharing"
    summary={summarizePullRequestRouting(props.environments.map((environment) => ({ label: environment.label, permission: valueFor(environment) }))) ?? "Off"}>
    <View class="px-4 py-2.5"><Text class="text-xs text-muted-foreground">Machines you trust here can read PR data through each other's source control access. Enable both machines. Read and act may use broader permissions than the machine that owns them. This applies only to this device.</Text></View>
    <Each of={props.environments} key={(environment) => environment.environmentId}>{(environment) => {
      const disabled = () => !ready() || saving() || pullRequestRoutingConnectionKey(environment()) === null;
      return <View class="border-t border-border-50">
        <EnvironmentRow kind={environment().kind} label={environment().label} subtitle={environment().subtitle}>
          <Select value={valueFor(environment())} disabled={disabled()}
            items={PULL_REQUEST_ROUTING_OPTIONS.map((option) => ({ value: option.value, title: option.label }))}
            onChange={(event: { value: string | null }) => { if (event.value !== null) void update(environment(), event.value as PullRequestRoutingPermission); }}
            trigger={<View accessibilityLabel={`${environment().label} pull request routing`} testID={`${environment().label} pull request routing = ${labelFor(environment())}`}
              class={`h-6 w-32 flex-row items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 hover:bg-accent ${disabled() ? "opacity-64" : ""}`}>
              <Text class="flex-1 text-xs text-foreground">{labelFor(environment())}</Text>
              <UiIcon name="chevron-down" size={14} />
            </View>}
            itemClass="min-h-7 flex-row items-center rounded-sm px-2 text-sm focus:bg-accent hover:bg-accent" popupClass="min-w-32 rounded-lg border border-border bg-popover-84 p-1" class="h-6 w-32" />
        </EnvironmentRow>
      </View>;
    }}</Each>
  </FoldedSettingsSection>}</View>;
}
