import { effect, signal, Text, View } from "nsh";
import { stringifiedFailure } from "../../backend/client";
import { requestedScheduledTaskId } from "../header/scheduledTaskRequest";
import { Input, Menu, MenuItem, MenuSeparator, Switch } from "nsh/base";
import { SettingsRow, SettingsSection, SettingsSelect } from "../SettingsLayout";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS, MENU_SEPARATOR_CLASS } from "../menuStyles";
import { SettingsIcon } from "../../pages/settings/SettingsIcon";
import { showToast } from "../toast";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { WebhookDeliveries } from "./WebhookDeliveries";
import { TaskEditorDialog } from "./TaskEditorDialog";
import { activeProjectId, allProjects, availableModels, backendStatus, requestBackend, runtimeMode,
  selectedModel, settingsOpen, subscribeBackend } from "../../store";
import type { AvailableModel, Project } from "../../store";
import { assertTaskUnchanged, buildTaskInput, localDateTime, readScheduledTasks, scheduledActionRequest, scheduleLabel } from "./data";
import type { ScheduledTask, ScheduledTaskOperation, TaskForm } from "./data";

type Phase = "disconnected" | "loading" | "ready" | "error";
type Operation = ScheduledTaskOperation;

function Button(props: { label: string; children: string; disabled?: boolean; onPress: () => void }) {
  return <View role="button" accessibilityLabel={props.label} disabled={props.disabled} onPress={props.onPress} class="rounded-md border border-border px-3 py-1.5 hover:bg-accent"><Text class="text-xs text-foreground">{props.children}</Text></View>;
}

/** statusVariant: the badge colour of the last run. */
const badgeClass = (status: string) => status === "failed" ? "border-destructive-foreground" : status === "completed" || status === "succeeded" ? "border-success-foreground" : "border-border";

/** One row of ScheduledTaskRow (ScheduledTasksSettings.tsx): title, the prompt, the schedule and state, the enable switch and the actions menu. */
export function ScheduledTaskList(props: { tasks: ScheduledTask[]; editingId?: string | null; onAction: (operation: Operation, task: ScheduledTask) => Promise<void>; onEdit: (task: ScheduledTask) => void; onDeliveries?: (task: ScheduledTask) => void }) {
  const pending = signal<string[]>([]);
  async function act(operation: Operation, task: ScheduledTask) {
    if (pending().includes(task.id)) return;
    pending.update((ids) => [...ids, task.id]);
    try { await props.onAction(operation, task); }
    catch (cause) { showToast({ type: "error", title: "Could not update scheduled task", description: stringifiedFailure(cause) }); }
    finally { pending.update((ids) => ids.filter((id) => id !== task.id)); }
  }
  const state = (task: ScheduledTask) => task.blockedByPolicy ?? (!task.enabled ? "Paused" : task.schedule.type === "webhook" ? "Listening" : task.nextRunAt ? `Next run ${new Date(task.nextRunAt).toLocaleString()}` : "Not scheduled");
  const item = MENU_ITEM_ROW_CLASS;
  return (
    <Each of={props.tasks} key={(task) => task.id}>
      {(task, index) => (
        <View>
          {index() > 0 ? <View class="h-px bg-border-50" /> : null}
          <SettingsRow
            title={task().title}
            description={task().prompt}
            status={
              <View class="flex-row flex-wrap items-center gap-2">
                <Text class="text-xs text-muted-foreground">{`${scheduleLabel(task().schedule)} · ${state(task())}`}</Text>
                {task().lastRunStatus !== "never" ? <View class={`h-4.5 min-w-4.5 items-center justify-center rounded-sm border px-1 ${badgeClass(task().lastRunStatus)}`}><Text class="text-xs font-medium text-foreground">{task().lastRunStatus}</Text></View> : null}
                {task().lastRunError ? <Text class="text-xs text-destructive-foreground">{task().lastRunError}</Text> : null}
              </View>
            }
            control={
              <View class="flex-row items-center gap-2">
                <Switch accessibilityLabel={`Enable ${task().title}`} checked={task().enabled} disabled={pending().includes(task().id) || props.editingId === task().id}
                  onChange={() => void act("toggle", task())} class="h-[18px] w-[30px] items-center" trackClass="h-[18px] w-[30px] justify-center rounded-full p-[2px] bg-input checked:bg-primary transition-colors duration-200 ease-in-out" thumbClass="size-3.5 rounded-full bg-background checked:translate-x-3 transition-transform duration-150 ease-in-out" />
                <Menu popupClass={MENU_POPUP_CLASS} align="end" trigger={
                  <View role="button" accessibilityLabel={`Actions for ${task().title}`} disabled={pending().includes(task().id) || props.editingId === task().id} class="size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"><SettingsIcon name="ellipsis" size={16} /></View>
                }>
                  {task().schedule.type !== "unknown" ? <MenuItem accessibilityLabel={`Edit ${task().title}`} onSelect={() => props.onEdit(task())} class={item}><SettingsIcon name="pencil" size={MENU_ITEM_ICON_SIZE} /><Text class="text-sm text-popover-foreground">Edit</Text></MenuItem> : null}
                  {task().schedule.type === "webhook"
                    ? <MenuItem accessibilityLabel={`Deliveries for ${task().title}`} onSelect={() => props.onDeliveries?.(task())} class={item}><SettingsIcon name="inbox" size={MENU_ITEM_ICON_SIZE} /><Text class="text-sm text-popover-foreground">Deliveries</Text></MenuItem>
                    : task().schedule.type !== "unknown" ? <MenuItem accessibilityLabel={`Run ${task().title} now`} onSelect={() => void act("run", task())} class={item}><SettingsIcon name="play" size={MENU_ITEM_ICON_SIZE} /><Text class="text-sm text-popover-foreground">Run now</Text></MenuItem> : null}
                  <MenuSeparator class={MENU_SEPARATOR_CLASS} />
                  <MenuItem accessibilityLabel={`Delete ${task().title}`} onSelect={() => void act("delete", task())} class={item}><SettingsIcon name="trash-2" size={MENU_ITEM_ICON_SIZE} /><Text class="text-sm text-popover-foreground">Delete</Text></MenuItem>
                </Menu>
              </View>
            }
          />
        </View>
      )}
    </Each>
  );
}

export function ScheduledTasks(props: {
  connected?: () => boolean;
  visible?: () => boolean;
  subscribe?: typeof subscribeBackend;
  request?: typeof requestBackend;
} = {}) {
  const tasks = signal<ScheduledTask[]>([]);
  const phase = signal<Phase>("disconnected");
  const error = signal("");
  const editing = signal<ScheduledTask | "new" | null>(null);
  const retry = signal(0);
  let generation = 0;

  effect(() => {
    retry();
    const current = ++generation;
    if (!(props.visible ?? settingsOpen)() || !(props.connected ?? (() => backendStatus() === "connected"))()) { phase.set("disconnected"); tasks.set([]); editing.set(null); return; }
    phase.set("loading"); error.set("");
    const cancel = (props.subscribe ?? subscribeBackend)("scheduledTasks.subscribe", {}, (value) => {
      if (current !== generation) return;
      try { tasks.set(readScheduledTasks(value)); phase.set("ready"); }
      catch (cause) { error.set(cause instanceof Error ? cause.message : String(cause)); phase.set("error"); }
    }, (cause) => { if (current === generation) { error.set(cause.message); phase.set("error"); } });
    return () => { generation++; cancel(); };
  });

  async function action(operation: Operation, task: ScheduledTask) {
    const request = scheduledActionRequest(operation, task);
    await (props.request ?? requestBackend)(request.method, request.payload);
  }

  const environmentLabel = () => String(serverEnvironment()?.label ?? "This machine");
  const deliveries = signal<ScheduledTask | null>(null);
  // The thread details card's "Edit automation" asks for one task's editor (header/scheduledTaskRequest.ts).
  effect(() => {
    const wanted = requestedScheduledTaskId();
    if (!wanted || phase() !== "ready") return;
    const task = tasks().find((item) => item.id === wanted);
    requestedScheduledTaskId.set(null);
    if (task) editing.set(task);
  });
  return <View class="gap-8">
    <SettingsSection
      title="Scheduled tasks"
      plain
      headerAction={<View role="button" accessibilityLabel="New scheduled task" disabled={phase() !== "ready"} onPress={() => editing.set("new")} class={`h-6 flex-row items-center gap-1 rounded-lg px-2 hover:bg-accent ${phase() === "ready" ? "" : "opacity-64"}`}><SettingsIcon name="plus" size={12} /><Text class="text-xs font-medium text-foreground">New task</Text></View>}
    >
      {phase() === "disconnected" && !props.connected ? (
        <View class="items-center gap-1 py-10"><Text class="text-sm font-medium text-foreground">No environments available</Text><Text class="text-sm text-muted-foreground">Connect an environment to manage scheduled tasks.</Text></View>
      ) : (
        <SettingsSection title={environmentLabel()} hideTitle>
          {phase() === "disconnected" ? <SettingsRow title="Environment disconnected" description={`Reconnect ${environmentLabel()} to view its scheduled tasks.`} /> : null}
          {phase() === "loading" ? <SettingsRow title="Loading scheduled tasks…" /> : null}
          {phase() === "error" ? <SettingsRow title="Could not load scheduled tasks" description={error()} control={<Button label="Retry scheduled tasks" onPress={() => retry.update((value) => value + 1)}>Retry</Button>} /> : null}
          {phase() === "ready" && tasks().length === 0 ? <SettingsRow title="No scheduled tasks" description="No tasks match this environment and project selection." /> : null}
          {phase() === "ready" && tasks().length > 0 ? <ScheduledTaskList tasks={tasks()} editingId={editing() && editing() !== "new" ? (editing() as ScheduledTask).id : null} onAction={action} onEdit={(task) => editing.set(task)} onDeliveries={(task) => deliveries.set(task)} /> : null}
        </SettingsSection>
      )}
    </SettingsSection>
    <Each of={editing() ? [editing() as ScheduledTask | "new"] : []} key={(item) => item === "new" ? "new" : item.id}>
      {(item) => <TaskEditorDialog task={item() === "new" ? null : item() as ScheduledTask} tasks={tasks} onClose={() => editing.set(null)} onSave={async (payload) => {
        const original = item();
        if (original !== "new") assertTaskUnchanged(original, tasks().find((task) => task.id === original.id));
        await (props.request ?? requestBackend)("scheduledTasks.upsert", payload);
      }} />}
    </Each>
    {deliveries() ? <WebhookDeliveries task={deliveries()!} request={props.request ?? requestBackend} onClose={() => deliveries.set(null)} /> : null}
  </View>;
}
