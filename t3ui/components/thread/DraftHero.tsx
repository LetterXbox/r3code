// DraftHeroHeadline.tsx + DraftHeroProjectHeading.tsx: "What should we build in <project>?" with the
// project name as a picker (search, the projects, Add project), inline or stacked by available width.
import { Clipboard, effect, keymap, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import { Icon } from "../Icons";
import { createAnchor, Popup } from "../composer/Popover";
import { ProjectTile } from "../sidebar/ProjectTile";
import { ADD_PROJECT_VALUE, headingFitsInline, pickerItems } from "./draftHeroLogic";
import { allProjects, composerDraft, createThread, openAddProjectPalette, openThread, projectOrganizationSupported, setDraftProject, setProjectPinned, settingValue, threadHasUnsentDraft } from "../../store";
import { holdItemOrder } from "../sidebar/projectScope";
import { Glyph } from "../sidebar/SidebarGlyph";
import { activeRules, shortcutLabel } from "../../commands/registry";
import { serverEnvironment } from "../../pages/settings/settingsState";
import { projectGroupEnvironmentDescription, projectGroupsSpanEnvironments, projectPickerEntries } from "../sidebar/projectGrouping";
import { environmentLabelFor, ProjectGroupEnvironmentBadge } from "../../environments/EnvironmentBadges";
import { TRIAGE_CLI_COMMAND } from "../palette/paletteModel";
import { scratchProjectAvailable, startWithoutProject } from "./scratchProject";
import { SCRATCH_PROJECT_TITLE } from "../../pages/settings/projectsLogic";
import { isScratchProjectPath, scratchWorkspaceRoot } from "../sidebar/serverFacts";

export function DraftHeroHeadline(props: {
  projectId: () => string | undefined;
  projects?: () => { id: string; name: string }[];
  onPickProject?: (projectId: string) => void;
  onAddProject?: () => void;
}) {
  const projects = () => props.projects?.() ?? allProjects();
  const width = signal<number | undefined>(undefined);
  const open = signal(false);
  const hovered = signal(false);
  const query = signal("");
  const error = signal<string | null>(null);
  const anchor = createAnchor();
  const project = () => projects().find((item) => item.id === props.projectId());
  // buildSidebarProjectPickerEntries: with the live store, one row per logical project (current first), opening the
  // checkout on the draft's environment; the environment badge shows when the projects span environments.
  const entries = () => props.projects ? null : projectPickerEntries(allProjects(), { environmentId: String(serverEnvironment()?.environmentId ?? ""), globalMode: settingValue("sidebarProjectGroupingMode"), overrides: settingValue("sidebarProjectGroupingOverrides") }, props.projectId() ?? null);
  // DraftHeroHeadline useOrderWhileOpen: pinning from a row keeps the rows in place while the picker is open.
  const frozenOrder = signal<string[] | null>(null);
  const baseItems = (needle: string) => { const list = entries(); return pickerItems(list ? list.map((entry) => ({ id: entry.target.id, name: entry.name })) : projects(), needle); };
  const items = () => holdItemOrder(baseItems(query()), frozenOrder());
  effect(() => { frozenOrder.set(open() ? baseItems("").map((item) => item.value) : null); });
  // ProjectPinButton: a pinned project always shows its pin, an unpinned one only on the highlighted (hovered) row.
  const hoveredRow = signal<string | null>(null);
  const highlightedRow = () => hoveredRow() ?? items().find((item) => item.value !== ADD_PROJECT_VALUE)?.value ?? null;
  const pinnable = (value: string) => !props.projects && value !== ADD_PROJECT_VALUE && projectOrganizationSupported() && allProjects().some((item) => item.id === value);
  const isPinned = (value: string) => allProjects().find((item) => item.id === value)?.pinned === true;
  const togglePin = (value: string) => { if (pinnable(value)) void setProjectPinned(value, !isPinned(value)).catch(() => {}); };
  const pinTitle = (label: string, pinned: boolean) => { const action = `${pinned ? "Unpin" : "Pin"} ${label}`; const shortcut = shortcutLabel("thread.pin"); return shortcut ? `${action} (${shortcut})` : action; };
  // isProjectPinShortcut: the thread pin shortcut pins the highlighted row while the search field has focus.
  effect(() => {
    if (!open()) return;
    const removers: (() => void)[] = [];
    const keystrokes = new Set(activeRules().filter((rule) => rule.command === "thread.pin" && rule.keystroke).map((rule) => rule.keystroke as string));
    for (const keystroke of keystrokes) {
      try { removers.push(keymap.bind(keystroke, () => { const value = highlightedRow(); if (value) togglePin(value); }, { when: "always" })); } catch { /* a chord the keymap rejects */ }
    }
    return () => { for (const remove of removers) remove(); };
  });
  const showEnvironments = () => projectGroupsSpanEnvironments(props.projects ? [] : allProjects());
  const environmentBadge = (value: string) => {
    if (!showEnvironments()) return null;
    const entry = entries()?.find((item) => item.target.id === value);
    const description = entry ? projectGroupEnvironmentDescription(entry.members, environmentLabelFor) : null;
    const first = entry?.members.find((member) => member.environmentId);
    return description && first ? <ProjectGroupEnvironmentBadge description={description} environmentId={first.environmentId!} /> : null;
  };
  const canChoose = () => projects().length > 0;
  const inline = () => headingFitsInline(width(), project()?.name ?? "");
  /** DraftHeroHeadline isScratchDraft: the scratch project (its path is the server's scratch root) reads "No project". */
  const isScratchDraft = () => { const current = project(); if (!current) return false; const path = allProjects().find((item) => item.id === current.id)?.path; return current.name === SCRATCH_PROJECT_TITLE || isScratchProjectPath(path, scratchWorkspaceRoot()); };
  function close() {
    open.set(false);
    query.set("");
    hoveredRow.set(null);
  }
  function pick(value: string) {
    close();
    if (value === ADD_PROJECT_VALUE) { (props.onAddProject ?? openAddProjectPalette)(); return; }
    if (value === props.projectId()) return;
    // DraftHeroHeadline selectProject: an empty draft opens that project's own draft instead of being retargeted.
    try {
      if (props.onPickProject) props.onPickProject(value);
      else { const id = openThread()?.id; if (id && !threadHasUnsentDraft(id)) createThread(value); else setDraftProject(value); }
      error.set(null);
    }
    catch (cause) { error.set(cause instanceof Error ? cause.message : "Could not change the project."); }
  }
  const selector = (textClass: string) => (
    <View
      ref={anchor.ref}
      class="min-w-0 max-w-full flex-row items-center"
      onPress={() => open.update((value) => !value)}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      tooltip={isScratchDraft() ? undefined : project()?.name}
      accessibilityLabel="Choose project"
      accessibilityState={{ expanded: open() }}
      role="button"
    >
      <Text class={`${textClass} min-w-0 truncate font-medium text-foreground ${open() || hovered() ? "underline" : ""}`}>{isScratchDraft() ? "No project" : project()?.name ?? "Choose a project"}</Text>
    </View>
  );
  const popup = () => (
    open() ? (
      <Popup anchor={anchor.anchor} onClose={close} placement="bottom" align="center" class="w-72">
        <View class="max-h-80 w-72">
          <View class="border-b border-border-60 px-2 py-1.5">
            <Input
              value={query()}
              placeholder="Search projects..."
              accessibilityLabel="Search projects"
              onChange={(event) => query.set(event.value)}
              onSubmit={() => { const first = items()[0]; if (first) pick(first.value); }}
              class="h-8 px-1 text-sm text-foreground"
            />
          </View>
          {items().length === 0 ? <Text class="px-3 py-3 text-center text-sm text-muted-foreground">No matching projects.</Text> : null}
          <View class="p-1">
            <Each of={items()} key={(item) => item.value}>
              {(item) => (
                <View
                  class={item().value === props.projectId() ? "h-8 flex-row items-center gap-2 rounded-md bg-accent px-2" : "h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent"}
                  onPress={() => pick(item().value)}
                  onMouseEnter={() => hoveredRow.set(item().value)}
                  accessibilityLabel={item().value === ADD_PROJECT_VALUE ? "Add project" : `Project ${item().label}`}
                  role="button"
                >
                  {item().value === ADD_PROJECT_VALUE ? <Icon name="folder-plus" size={16} /> : <ProjectTile name={item().label} projectId={item().value} size={16} />}
                  <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{item().label}</Text>
                  {pinnable(item().value) ? (
                    <View
                      role="button"
                      accessibilityLabel={`${isPinned(item().value) ? "Unpin" : "Pin"} ${item().label}`}
                      tooltip={pinTitle(item().label, isPinned(item().value))}
                      class={`ml-auto size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent ${isPinned(item().value) || highlightedRow() === item().value ? "" : "opacity-0"}`}
                      onPress={() => togglePin(item().value)}
                    >
                      <Glyph name={isPinned(item().value) && hoveredRow() === item().value ? "pin-off" : "pin"} size={14} tint={token("muted-foreground")} />
                    </View>
                  ) : null}
                  {item().value === ADD_PROJECT_VALUE ? null : environmentBadge(item().value)}
                </View>
              )}
            </Each>
          </View>
        </View>
      </Popup>
    ) : null
  );
  return (
    <View class="mx-auto w-full max-w-5xl items-center" onLayout={(event) => width.set(event.bounds.size.width)}>
      {isScratchDraft() ? (
        <View class="w-full items-center" accessibilityLabel="What should we work on?">
          <Text class="w-full text-center text-3xl font-normal tracking-tight text-foreground">What should we work on?</Text>
          <View class="mt-2 h-6 max-w-full flex-row items-center justify-center">{selector("text-sm")}</View>
        </View>
      ) : project() ? (
        inline() ? (
          <View class="w-full flex-row items-baseline justify-center gap-2" accessibilityLabel="What should we build">
            <Text class="shrink-0 text-3xl font-normal tracking-tight text-foreground">What should we build in</Text>
            <View class="min-w-0 flex-row items-baseline">
              {selector("text-3xl tracking-tight")}
              <Text class="shrink-0 text-3xl font-normal tracking-tight text-foreground">?</Text>
            </View>
          </View>
        ) : (
          <View class="w-full items-center gap-2" accessibilityLabel="What should we build">
            <Text class="text-center text-3xl font-normal tracking-tight text-foreground">What should we build?</Text>
            <View class="max-w-full flex-row justify-center">{selector("text-base")}</View>
          </View>
        )
      ) : canChoose() ? (
        <View class="w-full flex-row items-baseline justify-center gap-2">
          {selector("text-3xl tracking-tight")}
          <Text class="text-3xl font-normal tracking-tight text-foreground">to start</Text>
        </View>
      ) : (
        <Text class="w-full text-center text-3xl font-normal tracking-tight text-foreground">Add a project to start</Text>
      )}
      {/* DraftHeroHeadline's orStartWithoutProject: offered while the environment names a scratch root and this draft is not already one. */}
      {scratchProjectAvailable() && !isScratchDraft() && (project() || canChoose()) ? (
        <View class="mt-2 h-6 w-full flex-row items-center justify-center">
          <View
            role="button"
            accessibilityLabel="or start without a project"
            onPress={() => { void startWithoutProject().catch((cause) => error.set(cause instanceof Error ? cause.message : "Could not start without a project.")); }}
          >
            <Text class="text-sm font-medium text-muted-foreground hover:text-foreground hover:underline">or start without a project</Text>
          </View>
        </View>
      ) : null}
      {error() ? <Text class="mt-2 text-xs text-error-foreground">{error()}</Text> : null}
      {popup()}
    </View>
  );
}

/** contracts server.ts TRIAGE_PROMPT_FILE_NAME: a triage draft's prompt links this playbook (useStartTriage isTriagePrompt). */
export const TRIAGE_PROMPT_FILE_NAME = "triage-playbook.md";

/** TriageDraftHero: "What went wrong?", the machine and server version, and the CLI command to copy. */
export function TriageDraftHero() {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const label = () => { const value = serverEnvironment()?.label; return typeof value === "string" && value ? value : "This machine"; };
  const version = () => { const value = serverEnvironment()?.serverVersion; return typeof value === "string" && value ? value : null; };
  const copy = () => {
    void Clipboard.writeText(TRIAGE_CLI_COMMAND).then(() => { copied.set(true); clearTimeout(timer); timer = setTimeout(() => copied.set(false), 1500); }, () => {});
  };
  return (
    <View class="mx-auto w-full max-w-5xl items-center" accessibilityLabel="What went wrong?">
      <Text class="w-full text-center text-3xl font-normal tracking-tight text-foreground">What went wrong?</Text>
      <View class="mt-2 h-6 w-full flex-row items-center justify-center gap-1.5">
        <View class="min-w-0 flex-row items-baseline" tooltip="The agent reads T3 Code's logs and source here, and asks before it applies a fix or posts anything.">
          <Text class="min-w-0 truncate text-sm font-medium text-foreground">{label()}</Text>
          {version() !== null ? <Text class="ml-1.5 text-sm text-muted-foreground">{`v${version()}`}</Text> : null}
        </View>
        <Text class="text-sm text-muted-foreground">·</Text>
        <View class="flex-row items-baseline" role="button" accessibilityLabel="Copy command, for a terminal" tooltip="Copy command, for a terminal" onPress={copy}>
          <Text class="text-sm text-muted-foreground hover:text-foreground">{copied() ? "Copied" : "or run"}</Text>
          {copied() ? null : <Text class="ml-1 font-mono text-xs text-muted-foreground">{TRIAGE_CLI_COMMAND}</Text>}
        </View>
      </View>
    </View>
  );
}

/** DraftHeroHeadline isScratchDraft + isTriagePrompt: a scratch-project draft whose prompt links the triage playbook. */
export function isTriageDraft(projectId: string | undefined, prompt: string = composerDraft()): boolean {
  const project = allProjects().find((item) => item.id === projectId);
  if (!project || !(project.name === SCRATCH_PROJECT_TITLE || isScratchProjectPath(project.path, scratchWorkspaceRoot()))) return false;
  return prompt.includes(`[${TRIAGE_PROMPT_FILE_NAME}](`);
}
