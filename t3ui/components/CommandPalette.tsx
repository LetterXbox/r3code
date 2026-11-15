// The ⌘K palette, ported from components/CommandPalette.tsx and its parts
// (CommandPaletteContent, CommandPaletteResults, CommandPaletteAddProject, the thread/project/theme item
// builders). Rows come from palette/paletteLogic.ts and palette/addProject; this file only paints them
// and routes the keys.
//
// The card is only mounted while the palette is open: a hidden card is measured once at zero size and its
// autoFocus fires at app start, so the list stayed empty and typing went to the composer behind it.
import { FadeScroll } from "./FadeScroll";
import { currentWorkspace } from "./rightPanel/panelState";
import { textDirection } from "../textDirection";
import { cleanup, colorScheme, effect, keymap, signal, Text, token, untracked, View, windowSize } from "nsh";
import { mixColors } from "./sidebar/mix";
import { tokenClass } from "./thread/markdown/highlight";
import type { InputRef, ScrollRef } from "nsh";
import { Input, Select } from "nsh/base";
import { backendStatus, closePalette, openSettings, paletteOpen, paletteQuery } from "../store";
import { Icon } from "./Icons";
import { DIALOG_CARD_CLASS, dialogBackdropStyle } from "./dialogSurface";
import { MotionLoop } from "./motion/Motion";
import { statusPulse } from "./motion/motionTokens";
import { PaletteIcon } from "./palette/PaletteIcon";
import {
  emptyMessage, itemOffsets, placeholderFor, scrollOffsetToReveal, type PaletteGroup, type PaletteItem,
} from "./palette/paletteLogic";
import {
  browseView, completeBrowsePath, goBack, onPaletteQueryChange, paletteAccessory, paletteAutoHighlights, paletteBrowsing, paletteFooterAction,
  canOpenProjectFromFileManager, fileManagerName, isPickingProjectFolder, openProjectFromFileManager,
  paletteEscape, paletteGroups, paletteHasBackHint, paletteHeader, paletteHighlight, paletteInputPlaceholder, paletteItems, paletteMode, paletteSearch, paletteStepEmptyMessage,
  paletteWorkspace, resetPaletteMode, runPaletteEnter, runPaletteItem, runPaletteModEnter, syncPaletteModeOnOpen,
} from "./palette/paletteModel";
import { contentSummary } from "./palette/paletteSearch";
import { followProjectClones, setNewProjectPublishKind } from "./palette/addProject/addProjectState";
import { useOverlayOpen } from "./rightPanel/nativeOcclusion";
import { sourceHost } from "./palette/addProject/addProjectLogic";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { UseInAnotherAppDialogHost } from "./mcp/UseInAnotherAppDialog";
import { sessionScopeState, startSessionScopes, FILESYSTEM_READ_SCOPE } from "../backend/sessionScopes";
import type { FileAccess } from "./palette/paletteLogic";

/** The content search waits for, and needs, filesystem:read (ProjectContentSearchDialog isCheckingAccess / canReadFiles). */
function contentFileAccess(): FileAccess {
  startSessionScopes();
  const state = sessionScopeState(FILESYSTEM_READ_SCOPE);
  if (state !== "unknown") return state;
  // Pending only while the environment is connecting or connected; offline, the check cannot finish.
  const status = backendStatus();
  return status === "connected" || status === "connecting" ? "checking" : "offline";
}

// Reference (ui/command.tsx CommandDialogViewport): sm:pt-[max(10vh,titlebar+8px)]. The window has no
// system title bar (App.tsx hides it at 52px), so this is max(10% of window height, 60).
function paletteTopInset(): number {
  return Math.max(windowSize().height * 0.1, 52 + 8);
}

function Kbd(props: { children?: string; icon?: string }) {
  return (
    <View class="h-5 min-w-5 items-center justify-center rounded bg-command-footer-kbd px-1">
      {props.icon ? <Icon name={props.icon} size={12} /> : <Text class="text-xs font-medium text-foreground">{props.children}</Text>}
    </View>
  );
}

function SetupRequired(props: { hint: string }) {
  return (
    <View
      role="button"
      accessibilityLabel="Setup Required"
      tooltip={props.hint}
      onPress={() => { closePalette(); openSettings("/settings/source-control"); }}
      class="h-5 shrink-0 items-center justify-center rounded-sm border bg-warning-surface px-1.5"
      style={{ borderColor: "rgba(254,154,0,0.32)" }}
    >
      <Text class="text-[11px] font-medium text-warning-foreground">Setup Required</Text>
    </View>
  );
}

/** NewProjectPublishHostPicker: the host the new repository goes to, a ghost xs select on the row; the row's own press stays with the checkbox. */
function HostPicker(props: { hosts: { kind: string; label: string; icon: string }[]; value: string; disabled: boolean }) {
  const open = signal(false);
  useOverlayOpen(() => open(), "publish host select");
  const chosen = () => props.hosts.find((host) => host.kind === props.value);
  return (
    <Select
      open={open()}
      onOpenChange={(event: { open: boolean }) => open.set(event.open)}
      value={props.value}
      disabled={props.disabled}
      align="end"
      accessibilityLabel="Host for the new repository"
      items={props.hosts.map((host) => ({ value: host.kind, title: host.label }))}
      renderItem={(entry: { value: string; title: string }) => (
        <View class="flex-row items-center gap-1.5">
          <PaletteIcon name={props.hosts.find((host) => host.kind === entry.value)?.icon ?? "git-branch"} size={14} />
          <Text class="text-sm text-popover-foreground">{entry.title}</Text>
        </View>
      )}
      onChange={(event: { value: string | null }) => { if (event.value !== null) setNewProjectPublishKind(event.value as Parameters<typeof setNewProjectPublishKind>[0]); }}
      itemClass="min-h-7 flex-row items-center rounded-sm px-2 py-1 text-sm text-popover-foreground selected:bg-accent-50 focus:bg-accent hover:bg-accent"
      popupClass="min-w-32 rounded-lg border border-border bg-popover-84 p-1 shadow-lg"
      trigger={
        <View accessibilityLabel="Host for the new repository" class="h-6 flex-row items-center gap-1 rounded-md px-[7px] hover:bg-accent-50">
          <Text class="text-xs text-muted-foreground">{chosen()?.label ?? props.value}</Text>
          <View class="-mr-1 opacity-70"><Icon name="chevron-down" size={12} /></View>
        </View>
      }
    />
  );
}

function Checkbox(props: { checked: boolean }) {
  return (
    <View class={props.checked ? "size-4 items-center justify-center rounded-[4px] border border-primary bg-primary" : "size-4 items-center justify-center rounded-[4px] border border-input"}>
      {props.checked ? <PaletteIcon name="check" size={12} /> : null}
    </View>
  );
}

/**
 * A press on a row must not take the keyboard from the field: the keys (Escape, Backspace, the arrows) are served while the field
 * has it, and a focused row is a stop that sits outside that path. Rows are not stops, and the field takes the focus back after
 * every press.
 */
let refocusPaletteInput: () => void = () => undefined;

/** A row is painted from its item once, so an item that changes under the same value (the publish row's checkbox and host, a title) is a new row. */
function rowKey(item: PaletteItem): string {
  return `${item.value}|${item.title}${item.titleStrong ?? ""}|${item.description ?? ""}|${item.disabled ? 1 : 0}|${item.toggle ? `${item.toggle.checked}:${item.toggle.hostKind ?? ""}` : ""}|${item.shortcut ?? ""}|${item.trailing ?? ""}|${item.leadingStatus?.label ?? ""}`;
}

/** ThreadStatusLabel (ThreadStatusIndicators.tsx:633-657): a 6 pt dot and its label (text-3xs), the dot pulsing for Working and Connecting. */
function ThreadStatusDot(props: { status: NonNullable<PaletteItem["leadingStatus"]> }) {
  const status = props.status;
  return (
    <View accessibilityLabel={status.label} class="shrink-0 flex-row items-center gap-1">
      {status.pulse
        ? <MotionLoop spec={statusPulse}><View class={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} /></MotionLoop>
        : <View class={`h-1.5 w-1.5 rounded-full ${status.dotClass}`} />}
      <Text class={`text-[10px] ${status.colorClass}`}>{status.label}</Text>
    </View>
  );
}

function Row(props: { item: PaletteItem; active: () => boolean }) {
  const item = props.item;
  return (
    <View
      role="button"
      accessibilityLabel={`${item.title}${item.titleStrong ?? ""}`}
      accessibilityState={{ selected: props.active() }}
      focusable={false}
      onPress={() => { if (!item.disabled) runPaletteItem(item); refocusPaletteInput(); }}
      class={item.disabled
        ? "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1.5 opacity-64"
        : item.description
          ? (props.active() ? "min-h-7 flex-row gap-2 rounded-sm bg-accent px-2 py-1.5" : "min-h-7 flex-row gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50")
          : (props.active() ? "min-h-7 flex-row items-center gap-2 rounded-sm bg-accent px-2 py-1.5" : "min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50")}
    >
      <View class="h-5 shrink-0 items-center self-start pt-0.5">
        <PaletteIcon name={item.icon} size={16} />
      </View>
      <View class="min-w-0 flex-1 flex-col">
        <View class={item.leadingStatus ? "min-w-0 flex-row items-center gap-1.5" : "min-w-0 flex-row items-center"}>
          {item.leadingStatus ? <ThreadStatusDot status={item.leadingStatus} /> : null}
          <Text class="shrink truncate text-sm text-foreground" style={{ writingDirection: textDirection(item.title) ?? "auto" }}>
            {item.titleSegments
              ? item.titleSegments.map((segment) => segment.match
                // HighlightedSearchLine's <mark class="rounded-xs bg-primary/25 text-inherit">, flattened over the popover.
                ? <Text class={segment.kind && segment.kind !== "plain" ? tokenClass(segment.kind) : ""} style={{ backgroundColor: (colorScheme(), mixColors(token("primary"), token("popover"), 0.25)) }}>{segment.text}</Text>
                : <Text class={segment.kind && segment.kind !== "plain" ? tokenClass(segment.kind) : ""}>{segment.text}</Text>)
              : item.title}
          </Text>
          {item.titleStrong ? <Text class={/\s$/.test(item.title) ? "ml-1 shrink truncate text-sm font-semibold text-foreground" : "shrink truncate text-sm font-semibold text-foreground"}>{item.titleStrong}</Text> : null}
        </View>
        {item.description ? <Text class="truncate text-xs text-muted-foreground opacity-70">{item.description}</Text> : null}
      </View>
      {item.setupRequired ? <SetupRequired hint={item.setupRequired.hint} /> : null}
      {item.toggle ? (
        <View class="flex-row items-center gap-2 self-center">
          {item.toggle.hosts && item.toggle.hosts.length > 1 ? <HostPicker hosts={item.toggle.hosts} value={item.toggle.hostKind ?? ""} disabled={item.disabled === true} /> : null}
          <Checkbox checked={item.toggle.checked} />
        </View>
      ) : null}
      {item.trailing ? <Text class="min-w-12 shrink-0 text-right text-xs text-muted-foreground opacity-70">{item.trailing}</Text> : null}
      {item.swatches ? (
        <View class="flex-row items-center gap-1">
          {item.swatches.map((swatch) => (
            <View class="size-3 overflow-hidden rounded-full" style={{ backgroundColor: swatch.canvas }}>
              <View class="absolute -right-0.5 -top-0.5 size-2 rounded-full opacity-80" style={{ backgroundColor: swatch.accent }} />
              <View class="absolute -bottom-1 -left-1 size-2 rounded-full opacity-45" style={{ backgroundColor: swatch.messageAction }} />
            </View>
          ))}
        </View>
      ) : null}
      {item.shortcut ? <Text class="text-xs font-medium text-secondary-label">{item.shortcut}</Text> : null}
      {item.submenu ? <View class="-mr-0.5 ml-auto shrink-0 opacity-70"><PaletteIcon name="chevron-right" size={16} /></View> : null}
    </View>
  );
}

function Toggle(props: { label: string; active: () => boolean; onPress: () => void }) {
  const short = props.label === "Match case" ? "Aa" : props.label === "Match whole word" ? "ab" : ".*";
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ checked: props.active() }}
      focusable={false}
      onPress={() => { props.onPress(); refocusPaletteInput(); }}
      class={props.active() ? "h-6 min-w-7 items-center justify-center rounded-md bg-accent px-1.5" : "h-6 min-w-7 items-center justify-center rounded-md px-1.5 hover:bg-accent-50"}
    >
      <Text class="font-mono text-xs text-foreground">{short}</Text>
    </View>
  );
}

/** NewProjectSummary and RemoteRepositorySummary: the block above the list of those steps. */
function Header() {
  const newProject = () => { const header = paletteHeader(); return header?.kind === "new-project" ? header : null; };
  const repository = () => { const header = paletteHeader(); return header?.kind === "repository" ? header : null; };
  return (
    <>
      {newProject() ? (
        <View class="p-2 pb-0">
          <View class="min-h-8 flex-row gap-2 rounded-sm px-2 py-1.5">
            <View class="h-5 shrink-0 items-center self-start pt-0.5"><PaletteIcon name="folder-git-2" size={16} /></View>
            <View class="min-w-0 flex-1 flex-col">
              <Text class="truncate text-sm text-foreground">{newProject()!.name.length > 0 ? newProject()!.name : "New project"}</Text>
              <Text class="truncate text-xs text-muted-foreground opacity-85">
                {`${newProject()!.name.length > 0 ? `Creates ${newProject()!.pathPreview}` : `Goes in ${newProject()!.projectsRoot}`}${newProject()!.environmentLabel ? ` on ${newProject()!.environmentLabel}` : ""}`}
              </Text>
            </View>
          </View>
        </View>
      ) : null}
      {repository() ? (
        <View class="shrink-0 p-2 pb-0">
          <View class="px-2 py-1.5"><Text class="text-xs font-medium text-muted-foreground">Repository</Text></View>
          <View class="min-h-8 flex-row gap-2 rounded-sm px-2 py-1.5">
            <View class="h-5 shrink-0 items-center self-start pt-0.5">
              <PaletteIcon name={repository()!.source === "url" ? "link" : sourceHost(repository()!.source).icon} size={16} />
            </View>
            <View class="min-w-0 flex-1 flex-col">
              <Text class="truncate text-sm text-foreground">{repository()!.title}</Text>
              <Text class="truncate text-xs text-muted-foreground opacity-85">{repository()!.description}</Text>
            </View>
          </View>
        </View>
      ) : null}
    </>
  );
}

/** CommandPaletteSubmitButton: the field's trailing Add / Create / Clone / Continue / Lookup button. */
function SubmitButton() {
  return (
    <>
      {paletteAccessory() ? (
        <View class="absolute bottom-0 right-2.5 top-0 justify-center">
          <View
            role="button"
            accessibilityLabel={`${paletteAccessory()!.label} (${paletteAccessory()!.shortcut})`}
            disabled={paletteAccessory()!.disabled}
            onPress={() => paletteAccessory()!.submit()}
            class={paletteAccessory()!.disabled
              ? "h-6 flex-row items-center gap-1 rounded-md border border-input bg-popover px-[7px] opacity-64"
              : "h-6 flex-row items-center gap-1 rounded-md border border-input bg-popover px-[7px] hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
          >
            <Text class="text-xs font-medium text-foreground">{paletteAccessory()!.label}</Text>
            <View class="-mr-0.5 h-5 min-w-5 items-center justify-center rounded bg-muted px-1">
              <Text class="text-xs font-medium text-muted-foreground">{paletteAccessory()!.shortcut}</Text>
            </View>
          </View>
        </View>
      ) : null}
    </>
  );
}

const VIEWPORT = 420 - 98;

function PaletteCard() {
  // CommandPaletteResults.tsx scroll fade: the results fade at an edge with more rows beyond it.
  const scrollOffset = signal(0);
  const viewportHeight = signal(VIEWPORT);
  let scroller: ScrollRef | null = null;
  let input: InputRef | null = null;

  // Focus belongs to the field: on open, and again whenever a view replaces another (pressing a row takes it away).
  const focusInput = () => requestAnimationFrame(() => input?.focus());
  focusInput();
  refocusPaletteInput = focusInput;
  cleanup(() => { refocusPaletteInput = () => undefined; });
  effect(() => {
    paletteMode();
    focusInput();
  });

  // Search results and view transitions start on the first row where the view highlights one, else on none.
  effect(() => {
    paletteItems();
    paletteHighlight.set(paletteAutoHighlights() ? 0 : null);
    scroller?.scrollTo({ y: 0, animated: false });
  });

  function move(delta: number) {
    const count = paletteItems().length;
    if (!count) return;
    const current = paletteHighlight();
    const next = current === null ? (delta > 0 ? 0 : count - 1) : (current + count + delta) % count;
    paletteHighlight.set(next);
    const target = itemOffsets(paletteGroups())[next];
    if (!target) return;
    const reveal = scrollOffsetToReveal(target, scrollOffset(), viewportHeight());
    if (reveal !== null) scroller?.scrollTo({ y: reveal, animated: false });
  }

  const highlighted = (): PaletteItem | null => {
    const index = paletteHighlight();
    return index === null ? null : (paletteItems()[index] ?? null);
  };

  effect(() => {
    const unbind = keymap.bind({
      up: () => move(-1),
      down: () => move(1),
      escape: paletteEscape,
      "mod+enter": runPaletteModEnter,
    }, { when: "always" });
    const unbindBack = paletteHasBackHint() && !paletteQuery()
      ? keymap.bind("backspace", goBack, { when: "always" })
      : undefined;
    const unbindTab = paletteBrowsing()
      ? keymap.bind("tab", () => completeBrowsePath(highlighted()), { when: "always" })
      : undefined;
    return () => {
      unbind();
      unbindBack?.();
      unbindTab?.();
    };
  });

  const loading = () => paletteBrowsing() && browseView().loading;
  const stepEmpty = () => paletteStepEmptyMessage();

  return (
    <View class="absolute inset-0 items-center px-4" style={{ ...dialogBackdropStyle(), paddingTop: paletteTopInset() }} focusable={false} onPress={closePalette}>
      <View
        onPress={() => undefined}
        focusable={false}
        class={paletteMode() === "content"
          ? `h-[420px] w-[576px] max-w-full overflow-hidden ${DIALOG_CARD_CLASS} shadow-2xl`
          : `max-h-[420px] w-[576px] max-w-full overflow-hidden ${DIALOG_CARD_CLASS} shadow-2xl`}
      >
        <View class="relative">
          <View class="flex-row items-center px-2 py-1.5">
            {paletteHasBackHint() ? (
              <View accessibilityLabel="Back" role="button" onPress={goBack} class="h-[34px] w-8 justify-center pl-2">
                <Icon name="arrow-left" size={16} />
              </View>
            ) : (
              <View class="h-[34px] w-8 justify-center pl-2"><Icon name="search" size={16} /></View>
            )}
            <Input
              autoFocus
              ref={(node: InputRef) => { input = node; }}
              submitBehavior="submit"
              accessibilityLabel="Search commands, projects, and threads"
              value={paletteQuery()}
              placeholder={paletteInputPlaceholder() ?? placeholderFor(paletteMode(), paletteWorkspace()?.name)}
              onChange={(e) => onPaletteQueryChange(e.value)}
              onSubmit={() => runPaletteEnter(highlighted())}
              class={paletteAccessory() ? "h-[34px] flex-1 bg-transparent pr-28 text-sm text-foreground" : "h-[34px] flex-1 bg-transparent text-sm text-foreground"}
            />
          </View>
          <SubmitButton />
        </View>

        {paletteMode() === "content" ? (
          <View class="flex-row items-center gap-1 border-t border-border-50 px-3 py-1.5">
            <Toggle label="Match case" active={paletteSearch.caseSensitive} onPress={() => paletteSearch.caseSensitive.update((on) => !on)} />
            <Toggle label="Match whole word" active={paletteSearch.wholeWord} onPress={() => paletteSearch.wholeWord.update((on) => !on)} />
            <Toggle label="Use regular expression" active={paletteSearch.useRegex} onPress={() => paletteSearch.useRegex.update((on) => !on)} />
            <View class="flex-1" />
            {paletteQuery() ? (
              <Text class={paletteSearch.error() || paletteSearch.invalidRegex() ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                {paletteSearch.pending() ? "Searching…" : paletteSearch.error() ? paletteSearch.error() : paletteSearch.invalidRegex() ? "Invalid regular expression" : contentSummary(paletteSearch.content(), paletteSearch.truncated())}
              </Text>
            ) : null}
          </View>
        ) : null}

        <Header />
        {loading() ? <View role="alert" class="px-4 py-3"><Text class="text-sm text-muted-foreground">Loading folders...</Text></View> : null}

        {/* Content-sized up to the card's room (the working Scroll pattern): flex-1 inside a card that only has a max height collapses the list to nothing. */}
        <FadeScroll
          surface="background"
          class={paletteMode() === "content" ? "max-h-[286px]" : "max-h-[333px]"}
          contentClass="p-2"
          onScroll={(e) => {
            scrollOffset.set(e.offset.y);
            viewportHeight.set(e.size.height);
          }}
          ref={(node: ScrollRef | null) => { scroller = node; }}
        >
          {paletteItems().length === 0 && !loading() ? (
            <View class="items-center py-10">
              <Text class="text-sm text-muted-foreground">{stepEmpty() ?? ((paletteMode() === "files" || paletteMode() === "content") && !currentWorkspace()?.cwd ? "Open a project to search its files." : emptyMessage(paletteMode(), paletteQuery(), paletteSearch.pending(), contentFileAccess()))}</Text>
            </View>
          ) : null}
          <Each of={paletteGroups()} key={(group: PaletteGroup) => group.value}>
            {(group) => (
              <View class="flex-col">
                {group().label && group().items.length > 0 ? (
                  <View class="h-7 justify-center px-2">
                    <Text class="text-xs font-medium text-muted-foreground">{group().label}</Text>
                  </View>
                ) : null}
                <Each of={group().items} key={rowKey}>
                  {(item) => <Row item={item()} active={() => paletteItems()[paletteHighlight() ?? -1]?.value === item().value} />}
                </Each>
              </View>
            )}
          </Each>
        </FadeScroll>

        <View class="flex-row items-center gap-3 border-t border-command-footer-border bg-command-footer px-4 py-2.5">
          <View class="flex-row items-center gap-1">
            <Kbd icon="arrow-up" />
            <Kbd icon="arrow-down" />
            <Text class="text-sm font-medium text-muted-foreground">Navigate</Text>
          </View>
          {paletteFooterAction() !== undefined ? (
            <View class="flex-row items-center gap-1">
              <Kbd>Enter</Kbd>
              <Text class="text-sm font-medium text-muted-foreground">{paletteFooterAction()}</Text>
            </View>
          ) : null}
          {paletteHasBackHint() ? (
            <View class="flex-row items-center gap-1">
              <Kbd>Backspace</Kbd>
              <Text class="text-sm font-medium text-muted-foreground">Back</Text>
            </View>
          ) : null}
          <View class="flex-row items-center gap-1">
            <Kbd>Esc</Kbd>
            <Text class="text-sm font-medium text-muted-foreground">Close</Text>
          </View>
          <View class="flex-1" />
          {canOpenProjectFromFileManager() ? (
            <View
              role="button"
              accessibilityLabel={`Open in ${fileManagerName()}`}
              disabled={isPickingProjectFolder()}
              onPress={() => void openProjectFromFileManager()}
              class={isPickingProjectFolder() ? "h-auto rounded-md px-2 py-0.5 opacity-64" : "h-auto rounded-md px-2 py-0.5"}
            >
              <Text class="text-xs font-medium text-muted-foreground hover:text-foreground">{`Open in ${fileManagerName()}`}</Text>
            </View>
          ) : paletteMode() === "root" && paletteQuery() && paletteSearch.messagesPending() ? (
            <Text class="text-xs text-muted-foreground">Searching messages…</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function CommandPalette() {
  // Entering or leaving the palette: pick the submenu the store opened, or reset.
  effect(() => {
    // Only the open state is tracked: entering a view changes the stack, which must not re-run this.
    if (paletteOpen()) untracked(syncPaletteModeOnOpen);
    else untracked(resetPaletteMode);
  });
  // Clone progress toasts follow the connected environment for as long as the app runs.
  effect(() => {
    followProjectClones();
  });

  return (
    <>
      <LinkPullRequestDialogHost />
      <UseInAnotherAppDialogHost />
      {paletteOpen() ? <PaletteCard /> : null}
    </>
  );
}
