// Issue list filters menu, sort menu, tracker host picker, and search input (IssueListFilterPickers.tsx).
import { effect, signal, Text, View } from "nsh";
import type { InputRef, ViewRef } from "nsh";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { tokenAlpha } from "../composer/tokenColor";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS } from "../menuStyles";
import { PRIcon } from "../pullRequest/PRIcon";
import { PullRequestActorAvatar } from "../pullRequest/PullRequestActorLabel";
import { Spinner } from "../sidebar/Spinner";
import type {
  IssueCandidates,
  IssueInvolvement,
  IssueListSort,
  IssueListState,
  IssueScopeRef,
  IssueTrackerSummary,
} from "./issueLogic";
import { pullRequestLabelColor } from "./issueLogic";
import { loadIssueCandidates, type RequestFn } from "./issueStore";
import { IssueSavedViewsMenu } from "./IssueSavedViewsMenu";
import type { IssueListPreferences } from "./issueListPreferences";

export const ISSUE_STATE_OPTIONS: readonly { value: IssueListState; label: string; icon: string }[] = [
  { value: "open", label: "Open", icon: "circle-dot" },
  { value: "closed", label: "Closed", icon: "circle-check" },
  { value: "all", label: "All", icon: "layers" },
];

export const ISSUE_INVOLVEMENT_OPTIONS: readonly { value: IssueInvolvement; label: string; icon: string }[] = [
  { value: "all", label: "Everyone", icon: "layers" },
  { value: "assigned", label: "Assigned to you", icon: "user-check" },
  { value: "authored", label: "Created by you", icon: "pen-line" },
  { value: "mentioned", label: "Mentioning you", icon: "users" },
];

export const ISSUE_SORT_OPTIONS: readonly { value: IssueListSort; label: string; icon: string }[] = [
  { value: "updated", label: "Recently updated", icon: "clock" },
  { value: "created", label: "Newest created", icon: "calendar-arrow-down" },
];

type OpenMenu = "filters" | "sort" | "host" | null;
type SubMenu = "state" | "involvement" | "projects" | "labels" | "assignee" | null;

function Trigger(props: {
  label: string;
  name: string;
  icon: string;
  badge?: () => number;
  onPress: () => void;
  anchor: (view: ViewRef) => void;
}) {
  return (
    <View
      ref={props.anchor}
      accessibilityLabel={props.name}
      role="button"
      style={{ backgroundColor: tokenAlpha("input", 0.32) }}
      onPress={props.onPress}
      class="h-8 flex-row items-center gap-2 rounded-lg border border-input bg-transparent px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
    >
      <PRIcon name={props.icon} size={16} />
      <Text class="text-sm text-foreground">{props.label}</Text>
      {props.badge && props.badge() > 0 ? (
        <View class="rounded-full bg-muted px-1.5">
          <Text class="text-xs text-muted-foreground">{String(props.badge())}</Text>
        </View>
      ) : null}
    </View>
  );
}

function MenuPopup(props: { anchor: () => ViewRef | null; onClose: () => void; align?: "start" | "end"; class?: string; children: unknown }) {
  return (
    <Popup anchor={props.anchor} onClose={props.onClose} placement="bottom" align={props.align ?? "start"} class={props.class ?? "min-w-[220px]"}>
      <View class="flex-col gap-px p-1">{props.children as never}</View>
    </Popup>
  );
}

function OptionRow(props: { label: string; name: string; selected: boolean; icon?: string; onPress: () => void; swatchColor?: string | null }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      class={MENU_ITEM_ROW_CLASS}
    >
      {props.swatchColor ? <View class="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: props.swatchColor }} /> : null}
      {props.icon ? <PRIcon name={props.icon} size={MENU_ITEM_ICON_SIZE} /> : null}
      <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.label}</Text>
      <View class="size-4 items-center justify-center">{props.selected ? <PRIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}</View>
    </View>
  );
}

function SubmenuRow(props: { label: string; icon: string; current: string; open: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={`${props.label} filter`}
      accessibilityState={{ expanded: props.open }}
      onPress={props.onPress}
      class={props.open ? "min-h-8 flex-row items-center gap-2 rounded-sm bg-accent-50 px-2 py-1" : "min-h-8 flex-row items-center gap-2 rounded-sm px-2 py-1 hover:bg-accent-50"}
    >
      <PRIcon name={props.icon} size={14} />
      <Text class="flex-1 text-sm text-foreground">{props.label}</Text>
      <Text class="max-w-32 truncate text-xs text-muted-foreground">{props.current}</Text>
      <PRIcon name="chevron-right" size={14} />
    </View>
  );
}

function FilterSearch(props: { name: string; placeholder: string; value: () => string; onChange: (value: string) => void; busy?: () => boolean }) {
  return (
    <View class="shrink-0 px-2 pb-1 pt-1.5">
      <View class="h-8 flex-row items-center gap-1 border-b border-border-70 pb-1.5">
        <View class="w-4 items-center">{props.busy?.() ? <Spinner size={14} /> : <PRIcon name="search" size={14} />}</View>
        <Input
          accessibilityLabel={props.name}
          placeholder={props.placeholder}
          value={props.value()}
          onChange={(event) => props.onChange(event.value)}
          ref={(node: InputRef) => { node?.focus?.(); }}
          style={{ height: 26 }}
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground"
        />
      </View>
    </View>
  );
}

export interface IssueFilterProject {
  id: string;
  environmentId: string;
  title: string;
}

export function IssueListToolbar(props: {
  preferences: () => IssueListPreferences;
  onUpdatePreferences: (patch: Partial<IssueListPreferences>) => void;
  onReplacePreferences: (next: IssueListPreferences) => void;
  trackers: () => readonly IssueTrackerSummary[];
  scopes: () => readonly (IssueScopeRef & { environmentId?: string })[];
  projects: () => readonly IssueFilterProject[];
  refreshing: () => boolean;
  onRefresh: () => void;
  request?: RequestFn;
}) {
  const open = signal<OpenMenu>(null);
  const sub = signal<SubMenu>(null);
  const subQuery = signal("");
  const filtersAnchor = createAnchor();
  const sortAnchor = createAnchor();
  const hostAnchor = createAnchor();
  const candidates = signal<{ key: string; loading: boolean; error: string | null; data: IssueCandidates | null }>({
    key: "",
    loading: false,
    error: null,
    data: null,
  });

  const prefs = props.preferences;
  const close = () => { open.set(null); sub.set(null); subQuery.set(""); };
  const toggle = (menu: Exclude<OpenMenu, null>) => {
    sub.set(null);
    subQuery.set("");
    open.update((cur) => (cur === menu ? null : menu));
  };
  const pickSub = (next: Exclude<SubMenu, null>) => {
    subQuery.set("");
    sub.update((cur) => (cur === next ? null : next));
  };

  // Load candidate labels/assignees only when opening the Filters menu or its Label/Assignee submenus.
  effect(() => {
    if (open() !== "filters") return;
    const scopes = props.scopes();
    const key = JSON.stringify(scopes);
    if (candidates().key === key && (candidates().data || candidates().loading)) return;
    let alive = true;
    candidates.set({ key, loading: true, error: null, data: null });
    void loadIssueCandidates(scopes, props.request)
      .then((data) => { if (alive) candidates.set({ key, loading: false, error: null, data }); })
      .catch((cause) => { if (alive) candidates.set({ key, loading: false, error: cause instanceof Error ? cause.message : "Could not load candidates", data: null }); });
    return () => { alive = false; };
  });

  const hiddenSet = () => new Set((prefs().hideProjects ?? []).map(([e, p]) => `${e}:${p}`));
  const filterCount = () => {
    const p = prefs();
    return [
      p.status !== "open",
      p.who !== "all",
      (p.hideProjects?.length ?? 0) > 0,
      p.assignee,
      ...(p.label ?? []),
    ].filter(Boolean).length;
  };
  const hostOptions = () => [...new Set(props.trackers().map((t) => t.host).filter(Boolean))];
  const currentSort = () => prefs().order ?? "updated";
  const labelFor = (options: readonly { value: string; label: string }[], value: string) =>
    options.find((o) => o.value === value)?.label ?? options[0]?.label ?? "";

  const toggleHiddenProject = (proj: IssueFilterProject) => {
    const cur = [...(prefs().hideProjects ?? [])];
    const idx = cur.findIndex(([e, p]) => e === proj.environmentId && p === proj.id);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push([proj.environmentId, proj.id]);
    props.onUpdatePreferences({ hideProjects: cur });
  };

  const toggleLabel = (name: string) => {
    const cur = [...(prefs().label ?? [])];
    const idx = cur.indexOf(name);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(name);
    props.onUpdatePreferences({ label: cur });
  };

  const needle = () => subQuery().trim().toLowerCase();
  const filteredLabels = () => (candidates().data?.labels ?? [])
    .filter((l) => !needle() || l.name.toLowerCase().includes(needle()))
    .slice(0, 30);
  const filteredAssignees = () => (candidates().data?.assignees ?? [])
    .filter((a) => !needle() || a.login.toLowerCase().includes(needle()) || (a.name ?? "").toLowerCase().includes(needle()))
    .slice(0, 30);

  return (
    <View class="flex-row flex-wrap items-center gap-2">
      <View
        style={{ backgroundColor: tokenAlpha("input", 0.32) }}
        class="h-8 min-w-44 max-w-72 flex-1 flex-row items-center gap-1.5 rounded-lg border border-input px-2.5"
      >
        <PRIcon name="search" size={14} />
        <Input
          accessibilityLabel="Search issues"
          placeholder="Search issues..."
          value={prefs().q ?? ""}
          onChange={(event) => props.onUpdatePreferences({ q: event.value })}
          style={{ height: 26 }}
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground"
        />
        {prefs().q ? (
          <View role="button" accessibilityLabel="Clear search" onPress={() => props.onUpdatePreferences({ q: "" })} class="size-5 items-center justify-center rounded hover:bg-accent-50">
            <PRIcon name="x" size={12} />
          </View>
        ) : null}
      </View>

      <IssueSavedViewsMenu preferences={prefs} onApply={props.onReplacePreferences} />

      <View>
        <Trigger
          label="Filters"
          name="Issue filters"
          icon="list-filter"
          badge={filterCount}
          anchor={filtersAnchor.ref}
          onPress={() => toggle("filters")}
        />
        {open() === "filters" ? (
          <MenuPopup anchor={filtersAnchor.anchor} onClose={close} align="end" class="w-64">
            <SubmenuRow
              label="State"
              icon="circle-dot"
              current={labelFor(ISSUE_STATE_OPTIONS, prefs().status)}
              open={sub() === "state"}
              onPress={() => pickSub("state")}
            />
            <SubmenuRow
              label="Involvement"
              icon="users"
              current={labelFor(ISSUE_INVOLVEMENT_OPTIONS, prefs().who)}
              open={sub() === "involvement"}
              onPress={() => pickSub("involvement")}
            />
            {props.projects().length > 0 || hiddenSet().size > 0 ? (
              <SubmenuRow
                label="Projects"
                icon="folder-git-2"
                current={hiddenSet().size > 0 ? `${Math.max(0, props.projects().length - hiddenSet().size)} shown` : "All"}
                open={sub() === "projects"}
                onPress={() => pickSub("projects")}
              />
            ) : null}
            <SubmenuRow
              label="Labels"
              icon="tag"
              current={prefs().label?.length ? `${prefs().label!.length} selected` : "Any"}
              open={sub() === "labels"}
              onPress={() => pickSub("labels")}
            />
            <SubmenuRow
              label="Assignee"
              icon="user-check"
              current={prefs().assignee ?? "Anyone"}
              open={sub() === "assignee"}
              onPress={() => pickSub("assignee")}
            />

            {sub() === "state" ? (
              <View class="mt-1 border-t border-border pt-1">
                {ISSUE_STATE_OPTIONS.map((opt) => (
                  <OptionRow
                    label={opt.label}
                    name={`State: ${opt.label}`}
                    icon={opt.icon}
                    selected={prefs().status === opt.value}
                    onPress={() => { props.onUpdatePreferences({ status: opt.value }); close(); }}
                  />
                ))}
              </View>
            ) : null}
            {sub() === "involvement" ? (
              <View class="mt-1 border-t border-border pt-1">
                {ISSUE_INVOLVEMENT_OPTIONS.map((opt) => (
                  <OptionRow
                    label={opt.label}
                    name={`Involvement: ${opt.label}`}
                    icon={opt.icon}
                    selected={prefs().who === opt.value}
                    onPress={() => { props.onUpdatePreferences({ who: opt.value }); close(); }}
                  />
                ))}
              </View>
            ) : null}
            {sub() === "projects" ? (
              <View class="mt-1 border-t border-border pt-1">
                <Each of={[...props.projects()]} key={(p: IssueFilterProject) => `${p.environmentId}:${p.id}`}>
                  {(proj) => (
                    <OptionRow
                      label={proj().title}
                      name={`Project ${proj().title}`}
                      selected={!hiddenSet().has(`${proj().environmentId}:${proj().id}`)}
                      onPress={() => toggleHiddenProject(proj())}
                    />
                  )}
                </Each>
              </View>
            ) : null}
            {sub() === "labels" ? (
              <View class="mt-1 border-t border-border pt-1">
                <FilterSearch name="Filter labels" placeholder="Search labels..." value={subQuery} onChange={(v) => subQuery.set(v)} busy={() => candidates().loading} />
                {candidates().error ? <Text class="px-2 py-2 text-xs text-destructive-foreground">{candidates().error!}</Text> : null}
                {!candidates().loading && !candidates().error && filteredLabels().length === 0 ? (
                  <Text class="px-2 py-2 text-xs text-muted-foreground">No matching labels.</Text>
                ) : null}
                <View class="max-h-56 flex-col overflow-y-auto">
                  {filteredLabels().map((label) => (
                    <OptionRow
                      label={label.name}
                      name={`Label ${label.name}`}
                      swatchColor={label.color ? pullRequestLabelColor(label.color) : null}
                      selected={(prefs().label ?? []).includes(label.name)}
                      onPress={() => toggleLabel(label.name)}
                    />
                  ))}
                </View>
              </View>
            ) : null}
            {sub() === "assignee" ? (
              <View class="mt-1 border-t border-border pt-1">
                <FilterSearch name="Filter assignees" placeholder="Search assignees..." value={subQuery} onChange={(v) => subQuery.set(v)} busy={() => candidates().loading} />
                <OptionRow label="Anyone" name="Anyone" selected={!prefs().assignee} onPress={() => { props.onUpdatePreferences({ assignee: undefined }); close(); }} />
                {candidates().error ? <Text class="px-2 py-2 text-xs text-destructive-foreground">{candidates().error!}</Text> : null}
                <View class="max-h-56 flex-col overflow-y-auto">
                  {filteredAssignees().map((person) => (
                    <View
                      role="button"
                      accessibilityLabel={`Assignee ${person.login}`}
                      accessibilityState={{ selected: prefs().assignee === person.login }}
                      onPress={() => { props.onUpdatePreferences({ assignee: prefs().assignee === person.login ? undefined : person.login }); close(); }}
                      class={MENU_ITEM_ROW_CLASS}
                    >
                      <PullRequestActorAvatar actor={{ avatarUrl: person.avatarUrl ?? undefined }} size={16} />
                      <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{person.name ? `${person.name} (${person.login})` : person.login}</Text>
                      <View class="size-4 items-center justify-center">{prefs().assignee === person.login ? <PRIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}</View>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </MenuPopup>
        ) : null}
      </View>

      <View>
        <Trigger
          label={labelFor(ISSUE_SORT_OPTIONS, currentSort())}
          name="Sort issues"
          icon="arrow-up-down"
          anchor={sortAnchor.ref}
          onPress={() => toggle("sort")}
        />
        {open() === "sort" ? (
          <MenuPopup anchor={sortAnchor.anchor} onClose={close} align="end">
            {ISSUE_SORT_OPTIONS.map((opt) => (
              <OptionRow
                label={opt.label}
                name={`Sort: ${opt.label}`}
                icon={opt.icon}
                selected={currentSort() === opt.value}
                onPress={() => { props.onUpdatePreferences({ order: opt.value }); close(); }}
              />
            ))}
          </MenuPopup>
        ) : null}
      </View>

      {hostOptions().length > 1 || prefs().host ? (
        <View>
          <Trigger
            label={prefs().host ?? "All trackers"}
            name="Tracker host filter"
            icon="plug-2"
            anchor={hostAnchor.ref}
            onPress={() => toggle("host")}
          />
          {open() === "host" ? (
            <MenuPopup anchor={hostAnchor.anchor} onClose={close} align="end">
              <OptionRow label="All trackers" name="All trackers" selected={!prefs().host} onPress={() => { props.onUpdatePreferences({ host: undefined }); close(); }} />
              {hostOptions().map((host) => (
                <OptionRow label={host} name={`Tracker host ${host}`} selected={prefs().host === host} onPress={() => { props.onUpdatePreferences({ host }); close(); }} />
              ))}
            </MenuPopup>
          ) : null}
        </View>
      ) : null}

      <View
        role="button"
        accessibilityLabel="Refresh issues"
        accessibilityState={{ disabled: props.refreshing() }}
        style={{ backgroundColor: tokenAlpha("input", 0.32) }}
        onPress={() => { if (!props.refreshing()) props.onRefresh(); }}
        class={`size-8 items-center justify-center rounded-lg border border-input bg-transparent hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out ${props.refreshing() ? "opacity-60" : ""}`}
      >
        {props.refreshing() ? <Spinner size={14} /> : <PRIcon name="refresh-cw" size={14} />}
      </View>
    </View>
  );
}
