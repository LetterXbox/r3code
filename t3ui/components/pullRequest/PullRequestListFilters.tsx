import { tokenAlpha } from "../composer/tokenColor";
// Search field, Sort menu, Filters menu, provider menu and Refresh, ported from PullRequestListFilters.tsx,
// PullRequestCompactFilterMenu.tsx and PullRequestsColumn.tsx. Every menu is a Popup (floats over the page, closes on a
// press outside or Esc) and registers with the WebView occlusion; the Filters menu's rows open a flyout beside it.
import { effect, signal, Text, View } from "nsh";
import type { InputRef, ViewRef } from "nsh";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { Spinner } from "../sidebar/Spinner";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS } from "../menuStyles";
import {
  activeFilterCount, CHECKS_OPTIONS, DRAFT_OPTIONS, INVOLVEMENT_TABS, REVIEW_OPTIONS, SORT_OPTIONS, STATE_TABS,
  type ListFilters,
} from "./pullRequestList.logic";
import type { PullRequestListModel } from "./pullRequestListModel";
import { pullRequestFilterChoices } from "./pullRequestFilterChoices";
import { PullRequestSavedViewsMenu } from "./PullRequestSavedViewsMenu";

type OpenMenu = "sort" | "filters" | "host" | null;

const SORT_ICONS: Record<string, string> = {
  ready: "list-checks", blocked: "user-lock", updated: "clock", newest: "calendar-arrow-down", oldest: "calendar-arrow-up", largest: "maximize-2", smallest: "minimize-2",
};
const STATE_ICONS: Record<string, string> = { all: "layers", open: "git-pull-request-arrow", closed: "git-pull-request-closed", merged: "git-merge" };
const INVOLVEMENT_ICONS: Record<string, string> = { all: "layers", reviewing: "eye", authored: "pen-line" };
const DRAFT_ICONS: Record<string, string> = { "": "layers", only: "git-pull-request-draft", hide: "eye" };
const REVIEW_ICONS: Record<string, string> = { "": "layers", approved: "circle-check", "changes-requested": "circle-x", "review-required": "circle-dashed", none: "circle-slash" };
const CHECKS_ICONS: Record<string, string> = { "": "layers", passing: "circle-check", failing: "circle-x" };

/** Button variant="outline": h-8, rounded-lg, border, px-3, gap-2, text-sm. */
function Trigger(props: { label: string; name: string; icon: string; badge?: () => number; iconOnly?: boolean; onPress: () => void; anchor: (view: ViewRef) => void }) {
  return (
    <View ref={props.anchor} accessibilityLabel={props.name} role="button" style={{ backgroundColor: tokenAlpha("input", 0.32) }} onPress={props.onPress} class="h-8 flex-row items-center gap-2 rounded-lg border border-input bg-transparent px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
      <PRIcon name={props.icon} size={16} />
      {props.iconOnly ? null : <Text class="text-sm text-foreground">{props.label}</Text>}
      {props.badge && props.badge() > 0 ? (
        <View class="rounded-full bg-muted px-1.5"><Text class="text-xs text-muted-foreground">{String(props.badge())}</Text></View>
      ) : null}
    </View>
  );
}

/** MenuRadioItem: icon, label, and the check where the web's indicator sits. */
function Option(props: { label: string; name: string; selected: boolean; icon?: string; onPress: () => void; /** Why it cannot be chosen (a host that could not be read). */ unavailable?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: props.selected, disabled: props.unavailable !== undefined }}
      {...(props.unavailable ? { tooltip: props.unavailable, accessibilityHint: props.unavailable } : {})}
      onPress={() => { if (props.unavailable === undefined) props.onPress(); }}
      class={`${MENU_ITEM_ROW_CLASS} ${props.unavailable !== undefined ? "opacity-64" : ""}`}
    >
      {props.icon ? <PRIcon name={props.icon} size={MENU_ITEM_ICON_SIZE} /> : null}
      <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{props.label}</Text>
      <View class="size-4 items-center justify-center">{props.selected ? <PRIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}</View>
    </View>
  );
}

function Menu(props: { anchor: () => ViewRef | null; onClose: () => void; align?: "start" | "end"; class?: string; children: unknown }) {
  return (
    <Popup anchor={props.anchor} onClose={props.onClose} placement="bottom" align={props.align ?? "start"} class={props.class ?? "min-w-[220px]"}>
      <View class="flex-col gap-px p-1">{props.children as never}</View>
    </Popup>
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

/** MenuSearchInput: a borderless field over the menu's items with a bottom rule, a search icon (a spinner while the host is
 * asked), focused when the menu opens. */
function FilterSearch(props: { name: string; placeholder: string; value: () => string; onChange: (value: string) => void; busy?: () => boolean }) {
  return (
    <View class="shrink-0 px-2 pb-1 pt-1.5">
      <View class="h-8 flex-row items-center gap-1 border-b border-border-70 pb-1.5">
        <View class="w-4 items-center">{props.busy?.() ? <Spinner size={14} /> : <PRIcon name="search" size={14} />}</View>
        <Input accessibilityLabel={props.name} placeholder={props.placeholder} value={props.value()} onChange={(event) => props.onChange(event.value)} ref={(node: InputRef) => { node?.focus?.(); }} style={{ height: 26 }} class="min-w-0 flex-1 bg-transparent text-sm text-foreground" />
      </View>
    </View>
  );
}

type Sub = "state" | "involvement" | "author" | "labels" | "draft" | "review" | "checks" | "host" | "server" | "project" | null;

export function PullRequestListToolbar(props: { model: PullRequestListModel; refreshing: () => boolean; onRefresh: () => void }) {
  const model = props.model;
  const open = signal<OpenMenu>(null);
  const sub = signal<Sub>(null);
  const query = signal("");
  const narrow = signal(false);
  const sortAnchor = createAnchor();
  const filtersAnchor = createAnchor();
  const hostAnchor = createAnchor();
  const toggle = (menu: Exclude<OpenMenu, null>) => { sub.set(null); query.set(""); open.update((current) => (current === menu ? null : menu)); };
  const close = () => { open.set(null); sub.set(null); query.set(""); };
  const filterCount = () => activeFilterCount(model.filters(), model.state(), model.involvement(), {
    host: model.host(), environmentId: model.environmentId(), projectId: model.projectId(),
  });
  const hostOptions = () => [...new Set(model.providers().map((provider) => provider.host))];
  /** hostMenuOptions' unavailable: a host whose provider is not configured, with what it said. */
  const hostUnavailable = (host: string): string | null => {
    const summary = model.providers().find((provider) => provider.host === host);
    return summary === undefined || summary.configured ? null : (summary.detail || "This host could not be read.");
  };
  const pickSub = (next: Exclude<Sub, null>) => { query.set(""); sub.update((current) => (current === next ? null : next)); };
  const label = (list: { value: string; label: string }[], value: string) => list.find((option) => option.value === value)?.label ?? list[0]?.label ?? "";
  // useHostedFilterOptions: a typed query also asks the host (250 ms after the typing stops); its names join the loaded ones.
  const hosted = signal<{ kind: string; query: string; names: string[]; error: boolean } | null>(null);
  effect(() => {
    const kind = sub() === "author" ? "authors" : sub() === "labels" ? "labels" : null;
    const typed = query().trim();
    if (kind === null || typed === "") { hosted.set(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void model.searchFilterOptions(kind, typed)
        .then((names) => { if (live) hosted.set({ kind, query: typed, names, error: false }); })
        .catch(() => { if (live) hosted.set({ kind, query: typed, names: [], error: true }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  });
  /** useHostedFilterOptions isPending: a typed query the host has not answered yet. */
  const hostPending = (kind: string) => query().trim() !== "" && hostedFor(kind) === null;
  const hostedFor = (kind: string) => { const current = hosted(); return current && current.kind === kind && current.query === query().trim() ? current : null; };
  const authorsShown = () => pullRequestFilterChoices(model.facets().authors, hostedFor("authors")?.names ?? [], query(), "authors", model.filters().author ? [model.filters().author!] : []);
  const labelsShown = () => pullRequestFilterChoices(model.facets().labels, hostedFor("labels")?.names ?? [], query(), "labels", model.filters().labels ?? []);
  const setDraft = (value: string) => model.setFilter("draft", (value || undefined) as ListFilters["draft"]);
  const setReview = (value: string) => model.setFilter("review", (value || undefined) as ListFilters["review"]);
  const setChecks = (value: string) => model.setFilter("checks", (value || undefined) as ListFilters["checks"]);

  return (
    <View class="flex-row flex-wrap items-center gap-2" onLayout={(event) => narrow.set(event.bounds.size.width < 512)}>
      {/* PullRequestSearchInput: InputGroup, min-w-0 flex-1, 32pt tall. */}
      <View style={{ backgroundColor: tokenAlpha("input", 0.32) }} class={narrow() ? "h-8 w-full min-w-0 flex-row items-center rounded-lg border border-input bg-transparent" : "h-8 min-w-0 flex-1 flex-row items-center rounded-lg border border-input bg-transparent"}>
        <View class="pl-2.5"><PRIcon name="search" size={16} /></View>
        <View class="relative h-8 min-w-0 flex-1">
          {model.search().length === 0 ? <Text class="absolute left-2 right-2 top-1.5 truncate text-sm text-placeholder">Search pull requests, or label:bug</Text> : null}
          <Input value={model.search()} accessibilityLabel="Search pull requests" onChange={(event) => model.search.set(event.value)} onSubmit={() => model.submitSearch()} class="absolute inset-0 bg-transparent pl-2 text-sm text-foreground" />
        </View>
        {model.search() ? (
          <View accessibilityLabel="Clear search" role="button" onPress={() => model.search.set("")} class="px-2"><PRIcon name="x" size={14} /></View>
        ) : null}
      </View>

      <View>
        <Trigger anchor={sortAnchor.ref} label="Sort" name="Sort pull requests" icon="arrow-up-down" onPress={() => toggle("sort")} />
        {open() === "sort" ? (
          <Menu anchor={sortAnchor.anchor} onClose={close}>
            <Each of={SORT_OPTIONS} key={(option) => option.value}>
              {(option) => <Option label={option().label} icon={SORT_ICONS[option().value]} name={`Sort ${option().label}`} selected={model.sort() === option().value} onPress={() => { model.sort.set(option().value); close(); }} />}
            </Each>
          </Menu>
        ) : null}
      </View>

      <View>
        <Trigger anchor={filtersAnchor.ref} label="Filters" name="Filters" icon="list-filter" badge={filterCount} onPress={() => toggle("filters")} />
        {open() === "filters" ? (
          <Popup anchor={filtersAnchor.anchor} onClose={close} placement="bottom" align="end">
            <View class="flex-row items-start">
              <View class="w-60 flex-col gap-px p-1">
                <SubmenuRow label="State" icon="git-pull-request-arrow" current={label(STATE_TABS, model.state())} open={sub() === "state"} onPress={() => pickSub("state")} />
                <SubmenuRow label="Involvement" icon="eye" current={label(INVOLVEMENT_TABS, model.involvement())} open={sub() === "involvement"} onPress={() => pickSub("involvement")} />
                <View class="mx-2 my-1 h-px bg-border" />
                <SubmenuRow label="Author" icon="user-round" current={model.filters().author ?? "Anyone"} open={sub() === "author"} onPress={() => pickSub("author")} />
                <SubmenuRow label="Labels" icon="tag" current={(model.filters().labels ?? []).length > 0 ? (model.filters().labels ?? []).join(", ") : "Any"} open={sub() === "labels"} onPress={() => pickSub("labels")} />
                <SubmenuRow label="Draft" icon="git-pull-request-draft" current={label(DRAFT_OPTIONS, model.filters().draft ?? "")} open={sub() === "draft"} onPress={() => pickSub("draft")} />
                <SubmenuRow label="Review" icon="circle-check" current={label(REVIEW_OPTIONS, model.filters().review ?? "")} open={sub() === "review"} onPress={() => pickSub("review")} />
                <SubmenuRow label="Checks" icon="list-checks" current={label(CHECKS_OPTIONS, model.filters().checks ?? "")} open={sub() === "checks"} onPress={() => pickSub("checks")} />
                <View class="mx-2 my-1 h-px bg-border" />
                {model.environments().length > 1 ? <SubmenuRow label="Server" icon="layers" current={model.environments().find((env) => env.id === model.environmentId())?.label ?? "All servers"} open={sub() === "server"} onPress={() => pickSub("server")} /> : null}
                <SubmenuRow label="Project" icon="layers" current={model.projects().find((project) => project.id === model.projectId())?.title ?? "All projects"} open={sub() === "project"} onPress={() => pickSub("project")} />
                {hostOptions().length > 1 ? (
                  <>
                    <SubmenuRow label="Host" icon="plug-2" current={model.host() ?? "All"} open={sub() === "host"} onPress={() => pickSub("host")} />
                  </>
                ) : null}
              </View>
              {sub() !== null ? (
                <View class="w-56 flex-col gap-px border-l border-border p-1">
                  {sub() === "state" ? <Each of={STATE_TABS} key={(option) => option.value}>{(option) => <Option label={option().label} icon={STATE_ICONS[option().value]} name={`State ${option().label}`} selected={model.state() === option().value} onPress={() => model.state.set(option().value)} />}</Each> : null}
                  {sub() === "involvement" ? <Each of={INVOLVEMENT_TABS} key={(option) => option.value}>{(option) => <Option label={option().label} icon={INVOLVEMENT_ICONS[option().value]} name={`Involvement ${option().label}`} selected={model.involvement() === option().value} onPress={() => model.involvement.set(option().value)} />}</Each> : null}
                  {sub() === "draft" ? <Each of={DRAFT_OPTIONS} key={(option) => `draft:${option.value}`}>{(option) => <Option label={option().label} icon={DRAFT_ICONS[option().value]} name={`Draft ${option().label}`} selected={(model.filters().draft ?? "") === option().value} onPress={() => setDraft(option().value)} />}</Each> : null}
                  {sub() === "review" ? <Each of={REVIEW_OPTIONS} key={(option) => `review:${option.value}`}>{(option) => <Option label={option().label} icon={REVIEW_ICONS[option().value]} name={`Review ${option().label}`} selected={(model.filters().review ?? "") === option().value} onPress={() => setReview(option().value)} />}</Each> : null}
                  {sub() === "checks" ? <Each of={CHECKS_OPTIONS} key={(option) => `checks:${option.value}`}>{(option) => <Option label={option().label} icon={CHECKS_ICONS[option().value]} name={`Checks ${option().label}`} selected={(model.filters().checks ?? "") === option().value} onPress={() => setChecks(option().value)} />}</Each> : null}
                  {sub() === "server" ? <>
                    <Option label="All servers" icon="layers" name="Server All servers" selected={model.environmentId() === undefined} onPress={() => model.setEnvironmentId(undefined)} />
                    <Each of={model.environments()} key={(env) => env.id}>{(env) => <Option label={env().label} icon="layers" name={`Server ${env().label}`} selected={model.environmentId() === env().id} onPress={() => model.setEnvironmentId(env().id)} {...(!env().connected ? { unavailable: "Connect this environment to browse its pull requests." } : {})} />}</Each>
                  </> : null}
                  {sub() === "project" ? (
                    <>
                      <Option label="All projects" icon="layers" name="Project All projects" selected={model.projectId() === undefined} onPress={() => model.setProjectId(undefined)} />
                      <Each of={model.projects()} key={(project) => `project:${project.id}`}>{(project) => <Option label={project().title} icon="folder-git-2" name={`Project ${project().title}`} selected={model.projectId() === project().id} onPress={() => model.setProjectId(project().id)} />}</Each>
                    </>
                  ) : null}
                  {sub() === "host" ? (
                    <>
                      <Option label="All" icon="plug-2" name="Host All" selected={model.host() === undefined} onPress={() => model.host.set(undefined)} />
                      <Each of={hostOptions()} key={(name: string) => `host:${name}`}>{(name) => <Option label={name()} icon="plug-2" name={`Host ${name()}`} selected={model.host() === name()} onPress={() => model.host.set(name())} {...(hostUnavailable(name()) ? { unavailable: hostUnavailable(name())! } : {})} />}</Each>
                    </>
                  ) : null}
                  {sub() === "author" ? (
                    <>
                      <FilterSearch name="Search authors" placeholder="Search authors" value={query} onChange={(value) => query.set(value)} busy={() => hostPending("authors")} />
                      <Option label="Anyone" icon="layers" name="Author Anyone" selected={model.filters().author === undefined} onPress={() => model.setFilter("author", undefined)} />
                      <Each of={authorsShown()} key={(facet) => `author:${facet.name}`}>
                        {(facet) => <Option label={facet().name} icon="user-round" name={`Author ${facet().name}`} selected={model.filters().author?.toLowerCase() === facet().name.toLowerCase()} onPress={() => model.setFilter("author", model.filters().author?.toLowerCase() === facet().name.toLowerCase() ? undefined : facet().name)} />}
                      </Each>
                      {authorsShown().length === 0 && !hostPending("authors") ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">{hostedFor("authors")?.error ? "Couldn't search authors on the host" : "No authors found"}</Text> : null}
                    </>
                  ) : null}
                  {sub() === "labels" ? (
                    <>
                      <FilterSearch name="Search labels" placeholder="Search labels" value={query} onChange={(value) => query.set(value)} busy={() => hostPending("labels")} />
                      <Each of={labelsShown()} key={(facet) => `label:${facet.name}`}>
                        {(facet) => {
                          const selected = () => (model.filters().labels ?? []).some((name) => name.toLowerCase() === facet().name.toLowerCase());
                          return <Option label={facet().name} icon="tag" name={`Label ${facet().name}`} selected={selected()} onPress={() => {
                            const current = model.filters().labels ?? [];
                            model.setFilter("labels", selected() ? current.filter((name) => name.toLowerCase() !== facet().name.toLowerCase()) : [...current, facet().name]);
                          }} />;
                        }}
                      </Each>
                      {labelsShown().length === 0 && !hostPending("labels") ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">{hostedFor("labels")?.error ? "Couldn't search labels on the host" : "No labels found"}</Text> : null}
                    </>
                  ) : null}
                </View>
              ) : null}
            </View>
          </Popup>
        ) : null}
      </View>

      <PullRequestSavedViewsMenu preferences={model.preferences} onApply={(next) => model.applyPreferences(next)} />

      {/* PullRequestsColumn's "Filter by provider" chip is always drawn, with the "All" entry alone when there is one host. */}
      {true ? (
        <View>
          <Trigger anchor={hostAnchor.ref} label={model.host() ?? "All"} name="Filter by provider" icon="plug-2" iconOnly={model.host() !== undefined} onPress={() => toggle("host")} />
          {open() === "host" ? (
            <Menu anchor={hostAnchor.anchor} onClose={close}>
              <Option label="All" icon="plug-2" name="Provider All" selected={model.host() === undefined} onPress={() => { model.host.set(undefined); close(); }} />
              <Each of={hostOptions()} key={(name: string) => name}>
                {(name) => <Option label={name()} icon="plug-2" name={`Provider ${name()}`} selected={model.host() === name()} onPress={() => { model.host.set(name()); close(); }} {...(hostUnavailable(name()) ? { unavailable: hostUnavailable(name())! } : {})} />}
              </Each>
            </Menu>
          ) : null}
        </View>
      ) : null}

      <View
        accessibilityLabel="Refresh pull requests"
        role="button"
        onPress={() => { if (!props.refreshing()) props.onRefresh(); }}
        style={{ backgroundColor: tokenAlpha("input", 0.32) }} class={props.refreshing() ? "size-8 items-center justify-center rounded-lg border border-input bg-transparent opacity-50" : "size-8 items-center justify-center rounded-lg border border-input bg-transparent hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
      >
        <PRIcon name="refresh-cw" size={16} />
      </View>
    </View>
  );
}


/** PullRequestCompactFilterMenu (ghost-muted, size sm): the current option and a chevron; its menu lists the options. */
function CompactFilterMenu(props: { label: string; value: () => string; options: () => { value: string; label: string; icon?: string; unavailable?: string }[]; onChange: (value: string) => void }) {
  const open = signal(false);
  const anchor = createAnchor();
  const current = () => props.options().find((option) => option.value === props.value()) ?? props.options()[0];
  return current() ? (
    <View class="min-w-0">
      <View ref={anchor.ref} role="button" accessibilityLabel={props.label} onPress={() => open.set(!open())} class="h-7 min-w-0 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-accent-50">
        <Text class="min-w-0 truncate text-sm text-muted-foreground">{current()!.label}</Text>
        <PRIcon name="chevron-down" size={12} />
      </View>
      {open() ? (
        <Menu anchor={anchor.anchor} onClose={() => open.set(false)}>
          <Each of={props.options()} key={(option: { value: string; label: string; icon?: string; unavailable?: string }) => option.value}>
            {(option) => <Option label={option().label} {...(option().icon ? { icon: option().icon! } : {})} name={`${props.label}: ${option().label}`} selected={props.value() === option().value} onPress={() => { props.onChange(option().value); open.set(false); }} {...(option().unavailable ? { unavailable: option().unavailable! } : {})} />}
          </Each>
        </Menu>
      ) : null}
    </View>
  ) : null;
}

/** PullRequestsColumn's condensed topbar, shown once the in-flow filters scroll away: a "Pull request scope" breadcrumb
 * (the title, then compact state / involvement / host menus), an expandable search and a compact Refresh. */
export function PullRequestCondensedTopbar(props: { model: PullRequestListModel; refreshing: () => boolean; onRefresh: () => void }) {
  const model = props.model;
  const searchOpen = signal(false);
  const searchExpanded = () => searchOpen() || model.search().length > 0;
  const hostOptions = () => [...new Set(model.providers().map((provider) => provider.host))];
  const hostMenuOptions = () => [
    { value: "", label: "All", icon: "plug-2" },
    ...hostOptions().map((host) => {
      const summary = model.providers().find((provider) => provider.host === host);
      const unavailable = summary === undefined || summary.configured ? undefined : (summary.detail || "This host could not be read.");
      return { value: host, label: host, icon: "plug-2", ...(unavailable ? { unavailable } : {}) };
    }),
  ];
  return (
    <View class="min-w-0 flex-1 flex-row items-center gap-3">
      <View role="navigation" accessibilityLabel="Pull request scope" class="min-w-0 shrink flex-row items-center gap-1.5 overflow-hidden">
        {searchExpanded() ? null : <Text class="shrink-0 truncate text-sm font-medium text-foreground">Pull requests</Text>}
        {searchExpanded() ? null : <Text class="shrink-0 text-sm text-icon-muted">/</Text>}
        <View class="min-w-0 shrink flex-row items-center gap-1.5">
          <CompactFilterMenu label="Filter by state" value={() => model.state()} options={() => STATE_TABS.map((option) => ({ ...option, icon: STATE_ICONS[option.value]! }))} onChange={(value) => model.state.set(value as never)} />
          <CompactFilterMenu label="Filter by involvement" value={() => model.involvement()} options={() => INVOLVEMENT_TABS.map((option) => ({ ...option, icon: INVOLVEMENT_ICONS[option.value]! }))} onChange={(value) => model.involvement.set(value as never)} />
          {hostMenuOptions().length > 2 ? <CompactFilterMenu label="Filter by host" value={() => model.host() ?? ""} options={hostMenuOptions} onChange={(value) => model.host.set(value === "" ? undefined : value)} /> : null}
        </View>
      </View>
      <View class="min-w-0 flex-1" />
      <View class="shrink flex-row items-center gap-1.5">
        {searchExpanded() ? (
          <View class="h-8 w-56 min-w-24 shrink flex-row items-center rounded-lg border border-input bg-transparent px-2">
            <PRIcon name="search" size={14} />
            <Input value={model.search()} accessibilityLabel="Search pull requests" placeholder="Search pull requests, or label:bug" onChange={(event) => model.search.set(event.value)} onSubmit={() => model.submitSearch()} onBlur={() => { if (model.search().length === 0) searchOpen.set(false); }} ref={(node: InputRef) => { if (searchOpen()) node.focus(); }} class="min-w-0 flex-1 bg-transparent pl-2 text-sm text-foreground" />
          </View>
        ) : (
          <View role="button" accessibilityLabel="Search pull requests" onPress={() => searchOpen.set(true)} class="size-7 items-center justify-center rounded-md hover:bg-accent-50"><PRIcon name="search" size={16} /></View>
        )}
        <View accessibilityLabel="Refresh pull requests" role="button" onPress={() => { if (!props.refreshing()) props.onRefresh(); }} class={`size-7 items-center justify-center rounded-md ${props.refreshing() ? "opacity-50" : "hover:bg-accent-50"}`}>
          <PRIcon name="refresh-cw" size={16} />
        </View>
      </View>
    </View>
  );
}
