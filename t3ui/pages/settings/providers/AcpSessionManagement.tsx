// AcpSessionManagementSection.tsx: native session import and agent provider routing for an ACP registry
// instance. Placed between Environment and Models with no section wrapper, as the web does. Where the web
// reports operation results without shifting the surrounding settings.
import { effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsSelect } from "../../../components/SettingsLayout";
import { showToast } from "../../../components/toast/toastState";
import { acpSectionCapabilities, initialDraft, parseProviderHeaders, type AcpConfigurableProvider, type AcpDraft, type AcpSession } from "./acpSessions";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ProviderApi } from "./data";
import type { ProviderView } from "./logic";
import { ButtonText, PillButton, Row } from "./ui";

const fail = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;

export function AcpSessionManagement(props: { api: ProviderApi; instanceId: string; provider: ProviderView; readOnly: boolean }) {
  const acp = props.api.acp;
  const caps = () => acpSectionCapabilities(props.provider);
  const projects = () => acp?.projects() ?? [];
  const selected = signal<string | null>(null);
  const projectId = () => projects().find((project) => project.id === selected())?.id ?? projects()[0]?.id ?? null;
  // A replaced project scope retires every pending continuation, as the web's projectGeneration ref does.
  let generation = 0;
  const sessions = signal<AcpSession[]>([]);
  const nextCursor = signal<string | null>(null);
  const loading = signal(false);
  const importing = signal<string | null>(null);
  const deleting = signal<string | null>(null);
  const loggingOut = signal(false);
  const providers = signal<AcpConfigurableProvider[]>([]);
  const loadingProviders = signal(false);
  const saving = signal<string | null>(null);
  const drafts = signal<Record<string, AcpDraft>>({});
  const confirming = signal<{ kind: "delete"; session: AcpSession } | { kind: "disable"; provider: AcpConfigurableProvider } | null>(null);
  const pending = () => loading() || importing() !== null || deleting() !== null || loadingProviders() || saving() !== null;
  effect(() => {
    projectId();
    untracked(() => {
      generation += 1;
      sessions.set([]); nextCursor.set(null); loading.set(false); importing.set(null); deleting.set(null); providers.set([]); loadingProviders.set(false); saving.set(null); drafts.set({});
    });
  });
  const ok = (text: string) => showToast({ type: "success", title: text });
  const bad = (title: string, cause: unknown) => showToast({ type: "error", title, description: fail(cause, "The ACP operation failed.") });

  async function loadSessions(cursor?: string) {
    const current = generation; const id = projectId();
    if (!acp || id === null || loading()) return;
    loading.set(true);
    try {
      const result = await acp.listSessions({ instanceId: props.instanceId, projectId: id, ...(cursor === undefined ? {} : { cursor }) });
      if (current !== generation) return;
      sessions.update((all) => cursor === undefined ? result.sessions : [...all, ...result.sessions]);
      nextCursor.set(result.nextCursor);
    } catch (cause) { if (current === generation) bad("Could not list ACP sessions", cause); }
    finally { if (current === generation) loading.set(false); }
  }
  async function importSession(session: AcpSession) {
    const current = generation; const id = projectId();
    if (!acp || id === null || importing() !== null) return;
    importing.set(session.sessionId);
    try {
      const result = await acp.importSession({ instanceId: props.instanceId, projectId: id, sessionId: session.sessionId, title: session.title, updatedAt: session.updatedAt });
      if (current !== generation) return;
      sessions.update((all) => all.map((candidate) => candidate.sessionId === session.sessionId ? { ...candidate, importedThreadId: result.threadId } : candidate));
      ok(result.imported ? "ACP session imported" : "ACP session already imported");
    } catch (cause) { if (current === generation) bad("Could not import ACP session", cause); }
    finally { if (current === generation) importing.set(null); }
  }
  async function deleteSession(session: AcpSession) {
    const current = generation; const id = projectId();
    if (!acp || id === null || deleting() !== null || session.importedThreadId !== null) return;
    deleting.set(session.sessionId);
    try {
      await acp.deleteSession({ instanceId: props.instanceId, projectId: id, sessionId: session.sessionId });
      if (current !== generation) return;
      sessions.update((all) => all.filter((candidate) => candidate.sessionId !== session.sessionId));
      ok("ACP session deleted");
    } catch (cause) { if (current === generation) bad("Could not delete ACP session", cause); }
    finally { if (current === generation) deleting.set(null); }
  }
  async function loadProviders(resetProviderId?: string) {
    const current = generation; const id = projectId();
    if (!acp || id === null || loadingProviders()) return;
    loadingProviders.set(true);
    try {
      const list = await acp.listProviders({ instanceId: props.instanceId, projectId: id });
      if (current !== generation) return;
      providers.set(list);
      const previous = drafts();
      drafts.set(Object.fromEntries(list.map((provider) => [provider.providerId, (resetProviderId !== undefined && provider.providerId !== resetProviderId ? previous[provider.providerId] : undefined) ?? initialDraft(provider)])));
    } catch (cause) { if (current === generation) bad("Could not list ACP providers", cause); }
    finally { if (current === generation) loadingProviders.set(false); }
  }
  async function saveProvider(provider: AcpConfigurableProvider) {
    const current = generation; const id = projectId();
    const draft = drafts()[provider.providerId];
    if (!acp || id === null || saving() !== null || loadingProviders() || draft === undefined || draft.apiType.length === 0 || draft.baseUrl.length === 0) return;
    const headers = parseProviderHeaders(draft.headers);
    if (!headers.ok) { showToast({ type: "error", title: "Invalid provider headers", description: headers.error }); return; }
    saving.set(provider.providerId);
    try {
      await acp.setProvider({ instanceId: props.instanceId, projectId: id, providerId: provider.providerId, apiType: draft.apiType, baseUrl: draft.baseUrl, ...(headers.headers === undefined ? {} : { headers: headers.headers }) });
      if (current !== generation) return;
      saving.set(null); ok("ACP provider configured");
      await loadProviders(provider.providerId);
    } catch (cause) { if (current === generation) bad("Could not configure ACP provider", cause); }
    finally { if (current === generation) saving.set(null); }
  }
  async function disableProvider(provider: AcpConfigurableProvider) {
    const current = generation; const id = projectId();
    if (!acp || id === null || saving() !== null || loadingProviders() || provider.required) return;
    saving.set(provider.providerId);
    try {
      await acp.disableProvider({ instanceId: props.instanceId, projectId: id, providerId: provider.providerId });
      if (current !== generation) return;
      saving.set(null); ok("ACP provider disabled");
      await loadProviders(provider.providerId);
    } catch (cause) { if (current === generation) bad("Could not disable ACP provider", cause); }
    finally { if (current === generation) saving.set(null); }
  }
  async function logout() {
    if (!acp || loggingOut()) return;
    loggingOut.set(true);
    try { await acp.logout(props.instanceId); sessions.set([]); nextCursor.set(null); ok("Logged out of ACP agent"); }
    catch (cause) { bad("Could not log out of ACP agent", cause); }
    finally { loggingOut.set(false); }
  }
  const updateDraft = (providerId: string, provider: AcpConfigurableProvider, update: Partial<AcpDraft>) => drafts.update((all) => ({ ...all, [providerId]: { ...(all[providerId] ?? initialDraft(provider)), ...update } }));
  const projectOptions = () => projects().map((project) => ({ value: project.id, label: project.title }));

  const sessionActions = () => <View class="flex-row flex-wrap items-center gap-2">
    {caps().canLogout ? <PillButton label="Log out" disabled={props.readOnly || loggingOut()} onPress={() => void logout()}><ButtonText>{loggingOut() ? "Logging out" : "Log out"}</ButtonText></PillButton> : null}
    {caps().canList && projects().length > 0 ? <>
      <SettingsSelect label="Project for ACP sessions" value={projectId() ?? ""} options={projectOptions()} compactWidth={160} onChange={(next) => { if (!pending()) selected.set(next); }} />
      <PillButton label="List sessions" disabled={loading() || projectId() === null} onPress={() => void loadSessions()}><ButtonText>{loading() ? "Loading" : sessions().length === 0 ? "List sessions" : "Refresh"}</ButtonText></PillButton>
    </> : null}
  </View>;

  return <View class="gap-3" testID={`ACP session management ${props.instanceId}`}>{caps().visible && acp ? <>
    <Row divider={false} title="Native sessions" description="Resume agent-owned conversations as T3 threads."
      status={caps().canList && projects().length === 0 ? <Text class="text-xs text-muted-foreground">Add a project before importing sessions.</Text> : undefined}
      control={sessionActions()}>
      {caps().canList && (sessions().length > 0 || nextCursor() !== null) ? <View class="gap-2 pb-2">
        {sessions().length > 0 ? <View class="border-y border-border-60">
          <Each of={sessions()} key={(session) => session.sessionId}>{(session) => <View class="min-w-0 flex-row items-center justify-between gap-3 border-b border-border-60 py-2">
            <View class="min-w-0 flex-1">
              <Text class="truncate text-xs text-foreground">{session().title ?? session().sessionId}</Text>
              <Text class="truncate font-mono text-3xs text-muted-foreground">{session().sessionId}</Text>
            </View>
            <View class="shrink-0 flex-row items-center gap-1">
              <PillButton label={`Import ${session().title ?? session().sessionId}`} size="xs" variant="ghost" disabled={props.readOnly || !caps().canImport || session().importedThreadId !== null || importing() !== null} onPress={() => void importSession(session())}>
                <ButtonText tone="muted">{session().importedThreadId !== null ? "Imported" : importing() === session().sessionId ? "Importing" : "Import"}</ButtonText></PillButton>
              {caps().canDelete ? <PillButton label={`Delete ${session().title ?? session().sessionId}`} size="xs" variant="ghost" disabled={props.readOnly || session().importedThreadId !== null || deleting() !== null} onPress={() => confirming.set({ kind: "delete", session: session() })}>
                <ButtonText tone="muted">{deleting() === session().sessionId ? "Deleting" : "Delete"}</ButtonText></PillButton> : null}
            </View>
          </View>}</Each>
        </View> : null}
        {nextCursor() !== null ? <View class="flex-row"><PillButton label="Load more" size="xs" variant="ghost" disabled={loading()} onPress={() => void loadSessions(nextCursor() ?? undefined)}><ButtonText tone="muted">{loading() ? "Loading" : "Load more"}</ButtonText></PillButton></View> : null}
      </View> : null}
    </Row>

    {caps().canConfigureProviders ? <View class="gap-3 border-t border-border-60 px-4 py-3">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View>
          <Text class="text-xs font-medium text-foreground">Agent providers</Text>
          <Text class="text-xs text-muted-foreground">Configure non-secret routing. Headers are write-only.</Text>
        </View>
        <PillButton label="List providers" size="xs" disabled={loadingProviders() || saving() !== null || projectId() === null} onPress={() => void loadProviders()}>
          <ButtonText>{loadingProviders() ? "Loading" : providers().length === 0 ? "List providers" : "Refresh"}</ButtonText></PillButton>
      </View>
      {!caps().canList && projects().length > 1 ? <View class="flex-row"><SettingsSelect label="Project for ACP providers" value={projectId() ?? ""} options={projectOptions()} compactWidth={192} onChange={(next) => { if (!pending()) selected.set(next); }} /></View> : null}
      {providers().length > 0 ? <View class="border-y border-border-60">
        <Each of={providers()} key={(provider) => provider.providerId}>{(provider) => {
          const draft = () => drafts()[provider().providerId] ?? initialDraft(provider());
          return <View class="gap-2 border-b border-border-60 py-3">
            <View class="flex-row items-center justify-between gap-2">
              <View class="min-w-0">
                <Text class="truncate text-xs font-medium text-foreground">{provider().providerId}</Text>
                <Text class="text-3xs text-muted-foreground">{`${provider().current === null ? "Disabled" : "Configured"}${provider().required ? " · Required" : ""}`}</Text>
              </View>
              <View class="flex-row items-center gap-1">
                <PillButton label={`Save ${provider().providerId}`} size="xs" disabled={props.readOnly || saving() !== null || loadingProviders() || draft().apiType.length === 0 || draft().baseUrl.length === 0} onPress={() => void saveProvider(provider())}>
                  <ButtonText>{saving() === provider().providerId ? "Saving" : "Save"}</ButtonText></PillButton>
                {!provider().required && provider().current !== null ? <PillButton label={`Disable ${provider().providerId}`} size="xs" variant="ghost" disabled={props.readOnly || saving() !== null || loadingProviders()} onPress={() => confirming.set({ kind: "disable", provider: provider() })}>
                  <ButtonText tone="muted">Disable</ButtonText></PillButton> : null}
              </View>
            </View>
            <View class="flex-row items-center gap-2">
              <SettingsSelect label={`${provider().providerId} protocol`} value={draft().apiType} options={provider().supported.map((protocol) => ({ value: protocol, label: protocol }))} compactWidth={144} onChange={(next) => { if (!props.readOnly && saving() === null) updateDraft(provider().providerId, provider(), { apiType: next }); }} />
              <Input accessibilityLabel={`${provider().providerId} base URL`} testID={`input ${provider().providerId} base URL`} value={draft().baseUrl} placeholder="https://api.example.com" autoCapitalize="none" autoCorrect={false} readonly={props.readOnly || saving() !== null}
                onChange={(event) => updateDraft(provider().providerId, provider(), { baseUrl: event.value })} class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
            </View>
            <Input accessibilityLabel={`${provider().providerId} write-only headers JSON`} testID={`input ${provider().providerId} write-only headers JSON`} masked value={draft().headers} placeholder={'Write-only headers JSON, e.g. {"Authorization":"Bearer …"}'} autoCapitalize="none" autoCorrect={false} readonly={props.readOnly || saving() !== null}
              onChange={(event) => updateDraft(provider().providerId, provider(), { headers: event.value })} class="h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground" />
          </View>;
        }}</Each>
      </View> : null}
    </View> : null}
    {confirming()?.kind === "delete" ? <ConfirmDialog testID="Confirm delete ACP session" message={`Permanently delete native ACP session "${(confirming() as { session: AcpSession }).session.title ?? (confirming() as { session: AcpSession }).session.sessionId}"?`}
      confirmLabel="Delete" confirmAccessibilityLabel="Confirm delete ACP session" onClose={() => confirming.set(null)} onConfirm={() => { const state = confirming(); confirming.set(null); if (state?.kind === "delete") void deleteSession(state.session); }} /> : null}
    {confirming()?.kind === "disable" ? <ConfirmDialog testID="Confirm disable ACP provider" message={`Disable ACP provider "${(confirming() as { provider: AcpConfigurableProvider }).provider.providerId}"?`}
      confirmLabel="Disable" confirmAccessibilityLabel="Confirm disable ACP provider" onClose={() => confirming.set(null)} onConfirm={() => { const state = confirming(); confirming.set(null); if (state?.kind === "disable") void disableProvider(state.provider); }} /> : null}
  </> : null}</View>;
}
