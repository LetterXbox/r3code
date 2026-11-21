// IssueTrackerSettings.tsx (#19274): standalone issue trackers (Linear, Jira) for one environment on
// Settings > Source control. Connects each tracker with a credential and binds projects to its scopes.
import { computed, effect, openUrl, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsButton, SettingsRow, SettingsSection, SettingsSelect } from "../../components/SettingsLayout";
import { SettingsIcon } from "./SettingsIcon";
import { SearchAnchor } from "./SearchAnchor";
import { replaceIssueTrackersSnapshot, issueTrackerSummary, parseIssueTrackerConnections, type IssueTrackerConnection } from "../../components/issue/issueLogic";
import { allProjects, backendStatus, requestBackend } from "../../store";
import { currentScope, isProjectScope, scopeEnvironments } from "./scopeState";
import { requestEnvironment } from "../../environments/connectionManager";

const UNBOUND = "";

export function IssueTrackerSettings(props: {
  request?: (method: string, payload: unknown) => Promise<unknown>;
  projects?: () => readonly { id: string; name: string }[];
  environmentId?: () => string;
  connected?: () => boolean;
} = {}) {
  const scope = () => currentScope();
  const environments = () => scopeEnvironments();
  const environment = computed(() => {
    const cur = scope();
    if (cur.kind === "environment") return environments().find((item) => item.environmentId === cur.environmentId && item.connected) ?? null;
    if (cur.kind === "project") return environments().find((item) => cur.environmentIds.includes(item.environmentId) && item.connected) ?? null;
    return environments().find((item) => item.connected) ?? null;
  });
  const envKey = () => props.environmentId?.() ?? environment()?.environmentId ?? null;
  const isPrimary = () => environment()?.isPrimary !== false;
  const isConnected = () => props.connected?.() ?? backendStatus() === "connected";
  const rpc = (method: string, payload: unknown) => {
    if (props.request) return props.request(method, payload);
    const id = envKey();
    if (!id || isPrimary()) return requestBackend(method, payload);
    return requestEnvironment(id, method, payload);
  };
  const data = signal<{ trackers: IssueTrackerConnection[]; bindings: Record<string, { tracker: string; scope: string }> } | null>(null);
  const loading = signal(false);

  async function reload(targetEnvId: string | null) {
    if (!targetEnvId || !isConnected()) { data.set(null); return; }
    loading.set(true);
    try {
      const raw = await rpc("issueTrackers.list", {});
      const parsed = parseIssueTrackerConnections(raw);
      data.set(parsed);
      replaceIssueTrackersSnapshot(targetEnvId, parsed);
    } catch {
      data.set(null);
    } finally {
      loading.set(false);
    }
  }

  effect(() => {
    const id = envKey();
    isConnected();
    if (!id) { data.set(null); return; }
    void reload(id);
  });

  const trackers = () => data()?.trackers ?? [];
  const bindings = () => data()?.bindings ?? {};
  const hasTrackers = computed(() => trackers().length > 0);
  const showLoading = computed(() => !hasTrackers() && loading());
  const visible = computed(() => Boolean((props.request || !isProjectScope()) && envKey()));

  return (
    <>
      {visible() ? (
        showLoading() ? (
          <SearchAnchor path="/settings/source-control" id="issue-trackers">
            <SettingsSection title="Issue trackers">
              <View class="px-4 py-3"><Text class="text-xs text-muted-foreground">Loading issue trackers…</Text></View>
            </SettingsSection>
          </SearchAnchor>
        ) : hasTrackers() ? (
          <SearchAnchor path="/settings/source-control" id="issue-trackers">
            <SettingsSection title="Issue trackers">
              <Each of={trackers()} key={(tracker: IssueTrackerConnection) => `${tracker.tracker}:${envKey()}`}>
                {(tracker) => (
                  <TrackerRow
                    tracker={tracker}
                    bindings={bindings}
                    environmentId={envKey()!}
                    projects={props.projects ?? allProjects}
                    rpc={rpc}
                    onChanged={() => void reload(envKey())}
                  />
                )}
              </Each>
            </SettingsSection>
          </SearchAnchor>
        ) : null
      ) : null}
    </>
  );
}

function TrackerRow(props: {
  tracker: () => IssueTrackerConnection;
  bindings: () => Record<string, { tracker: string; scope: string }>;
  environmentId: string;
  projects: () => readonly { id: string; name: string }[];
  rpc: (method: string, payload: unknown) => Promise<unknown>;
  onChanged: () => void;
}) {
  const expanded = signal(false);
  const busy = signal(false);
  const failure = signal<string | null>(null);
  const draft = signal("");
  const tracker = props.tracker;
  const usable = () => tracker().connected && tracker().account !== null;
  const summary = () => issueTrackerSummary(tracker(), props.bindings());
  const showBindings = computed(() => usable() && tracker().scopes.length > 0);
  const showRejected = computed(() => tracker().connected && tracker().account === null);

  async function submitToken(nextToken: string | null) {
    if (busy()) return;
    busy.set(true);
    failure.set(null);
    try {
      await props.rpc("issueTrackers.connect", { tracker: tracker().tracker, token: nextToken });
      draft.set("");
      props.onChanged();
    } catch (error) {
      failure.set(error instanceof Error ? error.message : "The request failed.");
    } finally {
      busy.set(false);
    }
  }

  return (
    <View class="flex-col">
      <View class="flex-row items-center justify-between gap-3 px-4 py-3">
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row flex-wrap items-center gap-2">
            <View class="relative size-5 items-center justify-center">
              <SettingsIcon name={tracker().tracker === "linear" ? "git-branch" : "tag"} size={16} />
              <View class={`absolute -left-0.5 -top-0.5 size-2 rounded-full ${usable() ? "bg-success" : "bg-muted-foreground"}`} />
            </View>
            <Text class="truncate text-sm font-medium text-foreground">{tracker().displayName}</Text>
            {showRejected() ? (
              <View class="rounded-sm bg-destructive px-1.5 py-0.5"><Text class="text-2xs font-medium text-destructive-foreground">Credential rejected</Text></View>
            ) : null}
          </View>
          <Text class="text-xs text-muted-foreground">{summary()}</Text>
        </View>
        <View
          role="button"
          accessibilityLabel={`Toggle ${tracker().displayName} details`}
          accessibilityState={{ expanded: expanded() }}
          onPress={() => expanded.set(!expanded())}
          class="size-7 items-center justify-center rounded-md hover:bg-accent-50"
        >
          <SettingsIcon name={expanded() ? "chevron-up" : "chevron-down"} size={14} />
        </View>
      </View>
      {expanded() ? (
        <View class="gap-1 border-t border-border-50 pb-2 pt-1">
          <SettingsRow
            title={tracker().credential.label}
            description={
              <View class="gap-1">
                <View class="flex-row flex-wrap items-center gap-1">
                  <Text class="text-xs text-muted-foreground">Stored on the server.</Text>
                  {tracker().credential.helpUrl ? (
                    <Text role="link" accessibilityLabel={`Create ${tracker().displayName} credential`} class="text-xs text-primary underline" onPress={() => void openUrl(tracker().credential.helpUrl!).catch(() => undefined)}>
                      Create one
                    </Text>
                  ) : null}
                </View>
                {failure() ? <Text class="text-xs text-destructive">{failure()}</Text> : null}
              </View>
            }
            control={
              <View class="w-56 flex-row items-center gap-2">
                <Input
                  value={draft()}
                  masked
                  placeholder={tracker().connected ? "Stored credential (enter to replace)" : "Enter key"}
                  accessibilityLabel={tracker().credential.label}
                  disabled={busy()}
                  onChange={(event: { value: string }) => draft.set(event.value)}
                  onSubmit={() => { const trimmed = draft().trim(); if (trimmed) void submitToken(trimmed); }}
                  class="h-7 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
                />
                {draft().trim().length > 0 ? (
                  <SettingsButton label="Save" accessibilityLabel={`Save ${tracker().displayName} credential`} disabled={busy()} onPress={() => void submitToken(draft().trim())} />
                ) : null}
                {tracker().connected ? (
                  <SettingsButton label="Disconnect" accessibilityLabel={`Disconnect ${tracker().displayName}`} tone="destructive" disabled={busy()} onPress={() => void submitToken(null)} />
                ) : null}
              </View>
            }
          />
          {showBindings() ? (
            <ProjectBindings tracker={tracker} bindings={props.bindings} projects={props.projects} rpc={props.rpc} onChanged={props.onChanged} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ProjectBindings(props: {
  tracker: () => IssueTrackerConnection;
  bindings: () => Record<string, { tracker: string; scope: string }>;
  projects: () => readonly { id: string; name: string }[];
  rpc: (method: string, payload: unknown) => Promise<unknown>;
  onChanged: () => void;
}) {
  const projects = () => props.projects();
  const pendingId = signal<string | null>(null);
  const options = () => [
    { value: UNBOUND, label: "Not bound" },
    ...props.tracker().scopes.map((scope) => ({ value: scope.key, label: `${scope.name} (${scope.key})` })),
  ];
  async function bind(projectId: string, scope: string) {
    pendingId.set(projectId);
    try {
      await props.rpc("issueTrackers.bindProject", {
        projectId,
        binding: scope === UNBOUND ? null : { tracker: props.tracker().tracker, scope },
      });
      props.onChanged();
    } finally {
      pendingId.set(null);
    }
  }
  return (
    <>
      {projects().length > 0 ? (
        <>
          <SettingsRow
            title="Projects"
            description={`Pick the ${props.tracker().displayName} ${props.tracker().scopeNoun} whose issues each project lists beside its repository's own.`}
          />
          <Each of={projects()} key={(project) => project.id}>
            {(project) => {
              const bound = () => props.bindings()[project().id];
              const value = () => (bound()?.tracker === props.tracker().tracker ? bound()!.scope : UNBOUND);
              return (
                <SettingsRow
                  title={project().name}
                  control={
                    <View class="w-56">
                      <SettingsSelect
                        label={`${props.tracker().displayName} ${props.tracker().scopeNoun} for ${project().name}`}
                        value={value()}
                        disabled={pendingId() === project().id}
                        options={options()}
                        onChange={(next) => { void bind(project().id, next); }}
                      />
                    </View>
                  }
                />
              );
            }}
          </Each>
        </>
      ) : null}
    </>
  );
}
