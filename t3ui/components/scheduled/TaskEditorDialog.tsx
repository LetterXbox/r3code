// ScheduledTaskEditorDialog (ScheduledTasksSettings.tsx): "New task" / "Edit task" as a dialog. Where it runs, name, destination
// (a new thread each run, or one thread that is continued or restarted), project, workspace, prompt, model, the schedule
// (at a time, once, every interval, or on a webhook with its URL, filters, dedupe and signature) and Enabled.
import { Clipboard, computed, effect, signal, Text, View } from "nsh";
import { stringifiedFailure } from "../../backend/client";
import { DialogInput as Input } from "../DialogInput";
import { SettingsDialog } from "../SettingsDialog";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../SettingsLayout";
import { confirm, showToast } from "../toast";
import { readCloudLinkState } from "../../cloud/linkEnvironment";
import { allProjects, availableModels, backendUrl, openSettings, requestBackend, runtimeMode as defaultRuntimeMode, activeProjectId } from "../../store";
import { ModelPickerButton } from "../../pages/settings/ModelSelectionControl";
import { serverEnvironment, serverManagedPolicy } from "../../pages/settings/settingsState";
import { clampManagedRuntimeMode, managedCapabilityDenial, type RuntimeMode } from "../../pages/settings/managedPolicyLocks";
import { ManagedNotice } from "../coordinators/ManagedPolicy";
import type { ScheduledTask } from "./data";
import {
  DEFAULT_WEBHOOK_PROMPT, EMPTY_DRAFT, MAX_WEBHOOK_DELIVERY_AGE_MINUTES, MAX_WEBHOOK_FILTERS, THREAD_MODE_LABELS, WEEKDAY_LABELS, WEEKDAY_ORDER, WEEKDAY_SHORT, WEBHOOK_FILTER_OPS, WORKSPACE_MODE_LABELS,
  changeDraftProject, destinationDetail, emptyFilterDraft, moveDraftToThread, removeFilterDraft, scheduledTaskWorktreeBaseRef, taskToDraft, toDateTimeLocalValue, unbindDraftFromThread, upsertFromDraft, webhookAddress,
  type DraftState, type FilterDraft, type ScheduleMode, type ThreadMode, type WorkspaceMode,
} from "./taskDraft";

const field = "h-7.5 min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function Field(props: { label: string; hint?: string; children: any; class?: string }) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <View class="flex-row items-baseline justify-between"><Text class="text-sm font-medium text-foreground">{props.label}</Text>{props.hint ? <Text class="text-2xs text-muted-foreground">{props.hint}</Text> : null}</View>
      {props.children}
    </View>
  );
}

function Segmented(props: { label: string; value: string; options: { value: string; label: string; disabled?: boolean }[]; onChange: (value: string) => void }) {
  return (
    <View class="flex-row rounded-lg bg-input-32 p-0.5" accessibilityLabel={props.label}>
      <Each of={props.options} key={(option) => option.value}>
        {(option) => (
          <View role="button" accessibilityLabel={option().label} disabled={option().disabled} onPress={() => props.onChange(option().value)} class={`h-6 items-center justify-center rounded-md px-2.5 ${props.value === option().value ? "bg-accent" : ""} ${option().disabled ? "opacity-50" : ""}`}>
            <Text class="text-xs font-medium text-foreground">{option().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

const httpBaseUrl = () => { try { const url = new URL(backendUrl()); return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`; } catch { return null; } };

/** WebhookDeliveryMode: how T3 Connect relays this environment's webhooks while it is offline (the cloud link's
 * holdWebhooksWhileOffline), with the way to change it. Nothing while the environment is not linked. */
export function WebhookDeliveryMode(props: { read?: () => Promise<{ holdWebhooksWhileOffline?: boolean } | null> }) {
  const hold = signal<boolean | null>(null);
  void (props.read ?? readCloudLinkState)().then((state) => hold.set(state ? state.holdWebhooksWhileOffline === true : null), () => hold.set(null));
  return () => hold() === null ? null : (
    <Text class="text-xs text-muted-foreground">
      {hold() ? "Held for up to 24 hours while this environment is offline. " : "Forwarded live. Requests fail while this environment is offline. "}
      <Text role="link" accessibilityLabel="Change in Sharing & access" class="text-xs text-muted-foreground underline" onPress={() => openSettings("/settings/access")}>Change in Sharing & access</Text>
    </Text>
  );
}

function WebhookEndpoint(props: { task: ScheduledTask | null }) {
  const rotating = signal(false);
  const copied = signal(false);
  const endpoint = () => props.task?.webhook;
  const address = () => (endpoint() ? webhookAddress(endpoint()!, httpBaseUrl()) : null);
  const rotate = async () => {
    const task = props.task;
    if (!task || !(await confirm("Rotate this webhook URL?\nThe current URL stops working.", { variant: "destructive" }))) return;
    rotating.set(true);
    try { await requestBackend("scheduledTasks.rotateWebhookToken", { id: task.id }); }
    catch (cause) { showToast({ type: "error", title: "Could not rotate webhook URL", description: stringifiedFailure(cause) }); }
    finally { rotating.set(false); }
  };
  return (
    <View class="gap-1.5">
      {address() ? (
        <>
          <View class="flex-row items-center gap-2">
            <Input value={address()!.address} accessibilityLabel="Webhook URL" readonly class={`${field} flex-1`} />
            <SettingsButton label={copied() ? "Copied" : "Copy"} disabled={!address()!.copyable} onPress={() => { void Clipboard.writeText(address()!.address); copied.set(true); }} />
            <SettingsButton label="Rotate" disabled={rotating()} onPress={() => void rotate()} />
          </View>
          {address()!.note ? <Text class="text-xs text-muted-foreground">{address()!.note}</Text> : null}
          <WebhookDeliveryMode />
        </>
      ) : <Text class="text-sm text-muted-foreground">The URL appears after you save.</Text>}
    </View>
  );
}

function FiltersField(props: { filters: () => FilterDraft[]; onChange: (filters: FilterDraft[]) => void }) {
  const update = (index: number, patch: Partial<FilterDraft>) => props.onChange(props.filters().map((filter, at) => (at === index ? { ...filter, ...patch } : filter)));
  return (
    <View class="gap-2">
      <View class="flex-row items-center justify-between gap-2">
        <View class="min-w-0 flex-1 gap-1">
          <Text class="text-sm font-medium text-foreground">Filters</Text>
          <Text class="text-sm text-muted-foreground">Run only when every filter matches. Other requests are logged as filtered. Separate “is one of” values with commas; a value can't contain a comma.</Text>
        </View>
        <SettingsButton label="Add filter" disabled={props.filters().length >= MAX_WEBHOOK_FILTERS} onPress={() => props.onChange([...props.filters(), emptyFilterDraft()])} />
      </View>
      {/* Rows are keyed by id and read their draft through it, so typing in one does not rebuild it (and drop focus). */}
      <Each of={props.filters().map((filter) => filter.id)} key={(id) => id}>
        {(id, index) => {
          const filter = () => props.filters().find((entry) => entry.id === id()) ?? emptyFilterDraft();
          const at = () => props.filters().findIndex((entry) => entry.id === id());
          const exists = computed(() => filter().op === "exists");
          return (
            <View class="gap-2 pt-1">
              <View class="flex-row items-center gap-2">
                <Input value={filter().path} placeholder="body.action" accessibilityLabel={`Filter ${index() + 1} path`} onChange={(e: { value: string }) => update(at(), { path: e.value })} class={`${field} flex-1`} />
                <SettingsButton label="Remove" accessibilityLabel={`Remove filter ${index() + 1}`} onPress={() => props.onChange(removeFilterDraft(props.filters(), id()))} />
              </View>
              <View class="flex-row items-center gap-2">
                <SettingsSelect inline label={`Filter ${index() + 1} test`} value={filter().op} compactWidth={176} options={WEBHOOK_FILTER_OPS.map((option) => ({ value: option.op, label: option.label }))} onChange={(op) => update(at(), { op: op as FilterDraft["op"] })} />
                {exists() ? null : <Input value={filter().value} placeholder={filter().op === "in" ? "opened, reopened" : "opened"} accessibilityLabel={`Filter ${index() + 1} value`} onChange={(e: { value: string }) => update(at(), { value: e.value })} class={`${field} flex-1`} />}
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

export function TaskEditorDialog(props: {
  task: ScheduledTask | null;
  /** The tasks the server lists now, to notice that the edited one is gone and to read the webhook's stored secret. */
  tasks: () => ScheduledTask[];
  onSave: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const environment = () => serverEnvironment();
  const capabilities = () => (environment()?.capabilities ?? {}) as Record<string, unknown>;
  const offersOnce = () => capabilities().oneTimeSchedules === true || props.task?.schedule.type === "once";
  const offersThreadModes = () => capabilities().scheduledTaskThreadModes === true;
  const policy = () => serverManagedPolicy();
  const webhookDenial = () => managedCapabilityDenial(policy(), "webhookTasks");
  const environmentLabel = () => String(environment()?.label ?? "This machine");
  const projects = () => allProjects();
  const firstModel = () => availableModels()[0];
  const initial = (): DraftState => {
    if (props.task) return taskToDraft(props.task);
    const model = firstModel();
    return { ...EMPTY_DRAFT, projectId: activeProjectId() ?? projects()[0]?.id ?? "", modelProvider: model?.provider ?? "", modelId: model?.model ?? "", runtimeMode: defaultRuntimeMode() };
  };
  const draft = signal<DraftState>(initial());
  const saving = signal(false);
  const set = (patch: Partial<DraftState>) => draft.update((current) => ({ ...current, ...patch }));
  const liveTask = () => props.tasks().find((entry) => entry.id === draft().editingId) ?? props.task;
  const missing = () => draft().editingId !== null && !props.tasks().some((entry) => entry.id === draft().editingId);
  const project = () => projects().find((entry) => entry.id === draft().projectId);
  const threads = () => (project()?.threads ?? []).filter((thread) => thread.id !== draft().threadId);
  const threadTitle = (id: string) => (project()?.threads ?? []).find((thread) => thread.id === id)?.title || `Thread ${id}`;
  const selectedModel = () => { const current = draft(); return availableModels().find((entry) => entry.provider === current.modelProvider && entry.model === current.modelId) ?? null; };
  const connected = () => environment() !== null;
  // A conditional that reads `draft()` rebuilds its branch on every keystroke, which drops an input's focus: branch on memos of the one field that decides.
  const scheduleMode = computed(() => draft().scheduleMode);
  const workspaceMode = computed(() => draft().workspaceMode);
  const signatureOn = computed(() => draft().signatureEnabled);
  const threadModeMemo = computed(() => draft().threadMode);
  const hasThread = computed(() => draft().threadId !== "");
  const webhookHidden = computed(() => draft().scheduleMode === "webhook" && webhookDenial() !== undefined && draft().enabled);
  const automaticBaseRef = () => draft().workspaceMode === "worktree" && !draft().baseRef.trim();
  const baseRefsState = signal<{ cwd: string; refs: { name: string; isDefault?: boolean }[]; loading: boolean }>({ cwd: "", refs: [], loading: false });
  effect(() => {
    const cwd = automaticBaseRef() ? (project()?.path ?? "") : "";
    if (!cwd || !connected()) { baseRefsState.set({ cwd, refs: [], loading: false }); return; }
    let live = true;
    baseRefsState.set({ cwd, refs: [], loading: true });
    void requestBackend("vcs.listRefs", { cwd, limit: 100 }).then((value) => {
      if (!live) return;
      const raw = value && typeof value === "object" && Array.isArray((value as { refs?: unknown }).refs) ? (value as { refs: unknown[] }).refs : [];
      const refs = raw.flatMap((item) => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
        ? [{ name: (item as { name: string }).name, ...(typeof (item as { isDefault?: unknown }).isDefault === "boolean" ? { isDefault: (item as { isDefault: boolean }).isDefault } : {}) }]
        : []);
      baseRefsState.set({ cwd, refs, loading: false });
    }).catch(() => {
      if (live) baseRefsState.set({ cwd, refs: [], loading: false });
    });
    return () => { live = false; };
  });
  const worktreeBaseRef = () => scheduledTaskWorktreeBaseRef(draft().baseRef, baseRefsState().cwd === (project()?.path ?? "") ? baseRefsState().refs : []);
  const automaticBaseRefLoading = () => automaticBaseRef() && project() !== undefined && baseRefsState().loading;

  const submit = async () => {
    if (saving() || missing() || !connected() || automaticBaseRefLoading()) return;
    const current = draft();
    const stored = liveTask()?.webhook?.hasSecret === true;
    const result = upsertFromDraft(current, { projectIds: projects().map((entry) => entry.id), offersOnce: offersOnce(), offersThreadModes: offersThreadModes(), hasStoredSecret: stored, resolvedBaseRef: worktreeBaseRef(), commandId: `command:${crypto.randomUUID()}` });
    if ("issues" in result) { for (const issue of result.issues) showToast({ type: "error", title: issue.title, description: issue.description }); return; }
    const mode = String(result.input.runtimeMode);
    const clamped = clampManagedRuntimeMode(policy(), mode as RuntimeMode);
    saving.set(true);
    try { await props.onSave({ ...result.input, runtimeMode: clamped }); props.onClose(); }
    catch (cause) { showToast({ type: "error", title: "Could not save scheduled task", description: message(cause) }); }
    finally { saving.set(false); }
  };

  const modeOptions = (): { value: string; label: string; disabled?: boolean }[] => [
    { value: "fixed", label: "At a time" },
    ...(offersOnce() || draft().scheduleMode === "once" ? [{ value: "once", label: "Once" }] : []),
    { value: "interval", label: "Every interval" },
    { value: "webhook", label: "On webhook", disabled: webhookDenial() !== undefined && draft().scheduleMode !== "webhook" },
  ];
  const changeMode = (mode: ScheduleMode) => draft.update((current) => {
    const suggested = mode === "once" && !current.runAt ? new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000) : null;
    return { ...current, scheduleMode: mode, ...(suggested === null ? {} : { runAt: toDateTimeLocalValue(suggested), savedRunAt: suggested.toISOString() }), prompt: mode === "webhook" && !current.prompt.trim() ? DEFAULT_WEBHOOK_PROMPT : current.prompt };
  });
  const webhookBlocked = () => draft().scheduleMode === "webhook" && webhookDenial() !== undefined && draft().enabled;

  return (
    <SettingsDialog
      open
      onClose={() => { if (!saving()) props.onClose(); }}
      title={draft().editingId ? "Edit task" : "New task"}
      description="Run a prompt automatically on an interval, at a fixed time, once at a set date, or when a webhook is called."
      width={576}
      testID="Scheduled task editor"
      footer={<><SettingsButton label="Cancel" accessibilityLabel="Cancel scheduled task" disabled={saving()} onPress={props.onClose} /><SettingsButton label={draft().editingId ? "Save task" : "Create task"} accessibilityLabel="Save scheduled task" tone="primary" disabled={saving() || missing() || !connected() || automaticBaseRefLoading() || webhookBlocked()} onPress={() => void submit()} /></>}
    >
      <View class="gap-5">
        {!connected() ? <Text class="text-sm text-destructive-foreground">Reconnect this environment before saving.</Text> : null}
        <Field label="Runs on">
          <View class="h-7 flex-row items-center gap-2 rounded-lg border border-input bg-background px-3 opacity-80"><Text class="text-sm text-foreground">{environmentLabel()}</Text></View>
        </Field>
        {missing() ? <Text class="text-xs text-destructive-foreground">This scheduled task no longer exists.</Text> : null}
        <Field label="Name"><Input value={draft().title} placeholder="e.g. Check for Sentry issues" accessibilityLabel="Scheduled task title" onChange={(e: { value: string }) => set({ title: e.value })} class={field} /></Field>
        <Field label="Destination">
          {offersThreadModes() ? (
            <SettingsSelect inline label="Destination mode" value={draft().threadMode} options={(Object.keys(THREAD_MODE_LABELS) as ThreadMode[]).map((mode) => ({ value: mode, label: THREAD_MODE_LABELS[mode] }))}
              onChange={(next) => draft.update((current) => ({ ...(next === "new_thread" ? unbindDraftFromThread(current) : current), threadMode: next as ThreadMode }))} />
          ) : null}
          {!offersThreadModes() || threadModeMemo() !== "new_thread" ? (
            <SettingsSelect inline
              label="Destination thread"
              search={{ label: "Search threads", placeholder: "Search all threads...", empty: "No threads found." }}
              value={draft().threadId || " new-thread"}
              options={[
                ...(draft().threadId ? [{ value: draft().threadId, label: threadTitle(draft().threadId) }] : []),
                { value: " new-thread", label: draft().threadMode === "new_thread" ? "New thread each run" : "Started by the first run" },
                ...threads().map((thread) => ({ value: thread.id, label: thread.title || "Untitled thread" })),
              ]}
              onChange={(next) => { if (next === " new-thread") draft.update((current) => ({ ...unbindDraftFromThread(current), threadMode: offersThreadModes() ? current.threadMode : "new_thread" })); else draft.update((current) => moveDraftToThread(current, { id: next, projectId: current.projectId })); }}
            />
          ) : null}
          <View class="gap-1">
            <Text class="text-sm text-muted-foreground">{destinationDetail(draft().threadMode, draft().threadId !== "")}</Text>
            {threadModeMemo() !== "new_thread" ? <Text class="text-sm text-muted-foreground">Deleting the thread also deletes this task.</Text> : null}
          </View>
        </Field>
        <View class="flex-row gap-3">
          <Field label="Project" class="min-w-0 flex-1">
            <SettingsSelect inline label="Scheduled task project" value={draft().projectId} options={projects().map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(id) => draft.update((current) => changeDraftProject(current, id))} />
          </Field>
          <Field label="Workspace" class="min-w-0 flex-1">
            <SettingsSelect inline label="Scheduled task workspace" value={draft().workspaceMode} options={(Object.keys(WORKSPACE_MODE_LABELS) as WorkspaceMode[]).map((mode) => ({ value: mode, label: WORKSPACE_MODE_LABELS[mode] }))} onChange={(next) => set({ workspaceMode: next as WorkspaceMode })} />
          </Field>
        </View>
        {workspaceMode() === "worktree" ? (
          <Field label="Base branch">
            <View class="flex-row items-center gap-3">
              <Input value={automaticBaseRefLoading() ? "" : worktreeBaseRef()} placeholder="main" accessibilityLabel="Base branch" onChange={(e: { value: string }) => set({ baseRef: e.value })} class={`${field} flex-1`} />
              <Text class="text-xs text-muted-foreground">Start from remote</Text>
              <SettingsSwitch label="Start from remote" checked={draft().startFromOrigin} onChange={(on) => set({ startFromOrigin: on })} />
            </View>
          </Field>
        ) : null}
        {workspaceMode() === "existing_worktree" ? (
          <Field label="Checkout path"><Input value={draft().existingWorktreePath} placeholder="/path/to/checkout" accessibilityLabel="Checkout path" onChange={(e: { value: string }) => set({ existingWorktreePath: e.value })} class={field} /></Field>
        ) : null}
        <Field label="Prompt">
          <Input value={draft().prompt} multiline placeholder="What should the agent do each time this runs?" accessibilityLabel="Scheduled task prompt" onChange={(e: { value: string }) => set({ prompt: e.value })} class="max-h-64 min-h-[72px] rounded-lg border border-input bg-background px-3 py-1.5 text-sm text-foreground" />
        </Field>
        <Field label="Model">
          <View class="flex-row">
            <ModelPickerButton label="Scheduled task" selection={() => (selectedModel() ? { instanceId: selectedModel()!.provider, model: selectedModel()!.model } : null)} onSelect={(selection) => set({ modelProvider: selection.instanceId, modelId: selection.model })} />
          </View>
        </Field>
        <View class="gap-3">
          {props.task?.schedule.type === "interval" && props.task.schedule.everyMs < 60_000 ? <Text class="text-sm text-muted-foreground">This task uses a legacy interval below one minute. Saving updates it to at least one minute.</Text> : null}
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <Text class="text-sm font-medium text-foreground">Schedule</Text>
            <Segmented label="Schedule type" value={draft().scheduleMode} options={modeOptions()} onChange={(value) => changeMode(value as ScheduleMode)} />
          </View>
          {webhookDenial() !== undefined ? <ManagedNotice>{draft().scheduleMode === "webhook" ? `${webhookDenial()} Switch this task to a time or an interval, or turn it off, to save it.` : webhookDenial()!}</ManagedNotice> : null}
          {webhookHidden() ? null : scheduleMode() === "webhook" ? (
            <View class="gap-4">
              <WebhookEndpoint task={liveTask()} />
              <Text class="text-xs text-muted-foreground">{"Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."}</Text>
              <Field label="Skip requests older than" hint="minutes, optional"><Input value={draft().maxDeliveryAgeMinutes} placeholder="Run every request" accessibilityLabel={`Skip requests older than (up to ${MAX_WEBHOOK_DELIVERY_AGE_MINUTES} minutes)`} onChange={(e: { value: string }) => set({ maxDeliveryAgeMinutes: e.value })} class={field} /></Field>
              <FiltersField filters={() => draft().filters} onChange={(filters) => set({ filters })} />
              <Field label="Duplicate request key" hint="template, optional"><Input value={draft().replayKey} placeholder="{{headers.delivery-id}}" accessibilityLabel="Duplicate request key" onChange={(e: { value: string }) => set({ replayKey: e.value })} class={field} /></Field>
              <Text class="text-xs text-muted-foreground">Requests with the same key run only once within 7 days.</Text>
              <Field label="Coalesce key" hint="template, optional"><Input value={draft().coalesceKey} placeholder="{{body.id}}" accessibilityLabel="Coalesce key" onChange={(e: { value: string }) => set({ coalesceKey: e.value })} class={field} /></Field>
              <Field label="Coalesce window" hint="seconds, 10–3600"><Input value={draft().coalesceWindowSeconds} placeholder="120" accessibilityLabel="Coalesce window" onChange={(e: { value: string }) => set({ coalesceWindowSeconds: e.value })} class={field} /></Field>
              <Text class="text-xs text-muted-foreground">Coalescing runs the latest payload once when the window from the first delivery closes. Empty keys run normally.</Text>
              <View class="flex-row items-center justify-between gap-4">
                <View class="min-w-0 flex-1 gap-1"><Text class="text-sm font-medium text-foreground">Require signature</Text><Text class="text-sm text-muted-foreground">Reject requests without a valid HMAC-SHA256 signature of the body.</Text></View>
                <SettingsSwitch label="Require signature" checked={draft().signatureEnabled} onChange={(on) => set({ signatureEnabled: on })} />
              </View>
              {signatureOn() ? (
                <View class="gap-3">
                  <View class="flex-row gap-3">
                    <Field label="Header" class="min-w-0 flex-1"><Input value={draft().signatureHeader} accessibilityLabel="Signature header" onChange={(e: { value: string }) => set({ signatureHeader: e.value })} class={field} /></Field>
                    <Field label="Prefix" class="min-w-0 flex-1"><Input value={draft().signaturePrefix} placeholder="None" accessibilityLabel="Signature prefix" onChange={(e: { value: string }) => set({ signaturePrefix: e.value })} class={field} /></Field>
                  </View>
                  <View class="flex-row gap-3">
                    <Field label="Encoding" class="min-w-0 flex-1"><SettingsSelect inline label="Signature encoding" value={draft().signatureEncoding} options={[{ value: "hex", label: "hex" }, { value: "base64", label: "base64" }]} onChange={(next) => set({ signatureEncoding: next === "base64" ? "base64" : "hex" })} /></Field>
                    <Field label="Secret" class="min-w-0 flex-1"><Input value={draft().signatureSecret} masked placeholder={liveTask()?.webhook?.hasSecret ? "Unchanged" : "Shared secret"} accessibilityLabel="Signature secret" onChange={(e: { value: string }) => set({ signatureSecret: e.value })} class={field} /></Field>
                  </View>
                </View>
              ) : null}
            </View>
          ) : scheduleMode() === "once" ? (
            <View class="flex-row items-center gap-2"><Text class="text-sm font-medium text-foreground">Run on</Text><Input value={draft().runAt} placeholder="YYYY-MM-DDTHH:MM" accessibilityLabel="One-time date and time" onChange={(e: { value: string }) => set({ runAt: e.value })} class={`${field} w-56`} /></View>
          ) : scheduleMode() === "fixed" ? (
            <View class="flex-row flex-wrap items-center gap-3">
              <View class="flex-row items-center gap-2">
                <Text class="text-sm font-medium text-foreground">Run at</Text>
                <Input value={draft().timeOfDay} placeholder="09:00" accessibilityLabel="Daily time" onChange={(e: { value: string }) => set({ timeOfDay: e.value })} class={`${field} w-32`} />
                <Text class="text-xs text-muted-foreground">on</Text>
              </View>
              <View class="flex-row gap-1" accessibilityLabel="Days to run">
                <Each of={[...WEEKDAY_ORDER]} key={(day) => String(day)}>
                  {(day) => (
                    <View role="button" accessibilityLabel={`Run on ${WEEKDAY_LABELS[day()]}`} testID={`day-${day()}-${draft().weekdays.includes(day()) ? "selected" : "unselected"}`}
                      onPress={() => { const days = draft().weekdays; const next = days.includes(day()) ? days.filter((entry) => entry !== day()) : [...days, day()]; if (next.length > 0) set({ weekdays: next }); }}
                      class={`size-7 items-center justify-center rounded-lg border border-input ${draft().weekdays.includes(day()) ? "bg-accent" : ""}`}><Text class="text-xs text-foreground">{WEEKDAY_SHORT[day()]}</Text></View>
                  )}
                </Each>
              </View>
            </View>
          ) : (
            <View class="flex-row items-center gap-2"><Text class="text-sm font-medium text-foreground">Run every</Text><Input value={draft().intervalMinutes} accessibilityLabel="Interval in minutes" onChange={(e: { value: string }) => set({ intervalMinutes: e.value })} class={`${field} w-24`} /><Text class="text-xs text-muted-foreground">minutes</Text></View>
          )}
        </View>
        <View class="flex-row items-center justify-between gap-4">
          <View class="min-w-0 flex-1 gap-1"><Text class="text-sm font-medium text-foreground">Enabled</Text><Text class="text-sm text-muted-foreground">Disabled tasks stay saved but do not run.</Text></View>
          <SettingsSwitch label="Enable scheduled task" checked={draft().enabled} onChange={(on) => set({ enabled: on })} />
        </View>
      </View>
    </SettingsDialog>
  );
}
