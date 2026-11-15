// The bottom terminal drawer (ThreadTerminalDrawer.tsx): the active group's
// terminals as panes, a resize edge on top, a floating New/Split/Close cluster
// for one terminal and a sidebar of groups once there are several.
import { computed, effect, Overlay, platform, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Tooltip } from "nsh/base";
import { requestBackend } from "../../store";
import { HIcon } from "../header/HeaderIcons";
import { createLiveResize } from "../rightPanel/liveResize";
import { webViewsUnderSurface } from "../rightPanel/nativeOcclusion";
import { drawerStateFor, suppressedDrawerTerminals, updateDrawer } from "./drawerState";
import { serverTerminalIds } from "../sidebar/terminalStatus";
import { panelStateFor } from "../rightPanel/panelState";
import { reconcileDrawerTerminals } from "./terminalLogic";
import { drawerTypingWanted } from "./terminalTyping";
import { releasePromptKeyboard } from "../composer/editor/PromptEditor";
import { tokenAlpha } from "../composer/tokenColor";
import { TerminalPane } from "./TerminalPanel";
import { closeEndedTerminal, closeTerminalSession, reportTerminalFocus, runTerminalChord, setTerminalFocus, TERMINAL_SHORTCUTS } from "./terminalCommands";
import { terminalSessionLabel } from "./terminalSessionInfo";
import { drawerHeightBudget } from "./terminalLayoutBudget";
import { addTerminalSelectionToChat } from "../composer/terminalContext";
import { formatShortcut } from "../header/headerLogic";
import { allocationFor, canLaunchTerminal, registerDrawerThread } from "./terminalAllocation";
import { startSessionScopes } from "../../backend/sessionScopes";
import {
  activateTerminal, activeGroup, allTerminalIds, clampTerminalHeight, newTerminal, splitTerminal, terminalActionLabels, terminalLabel,
  hasReachedSplitLimit, type SplitDirection, type TerminalDrawerState,
} from "./terminalLogic";

function Tip(props: { text: string }) {
  return <Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

function ActionButton(props: { label: string; tip: string; icon: string; disabled?: boolean; onPress: () => void; sidebar?: boolean; first?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      tooltip={<Tip text={props.tip} />}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`${props.sidebar ? `h-full px-1 ${props.first ? "" : "border-l"}` : "p-1"} items-center justify-center transition-colors duration-150 ease-in-out ${props.disabled ? "opacity-64" : props.sidebar ? "hover:bg-accent-50" : "hover:bg-accent"}`}
      style={props.sidebar && !props.first ? { borderColor: tokenAlpha("border", 0.7) } : undefined}
    >
      <HIcon name={props.icon} size={13} />
    </View>
  );
}

export function TerminalDrawer(props: {
  /** Key of the thread's drawer state. */
  stateKey: string;
  threadId: string;
  cwd: string;
  request?: (method: string, payload: unknown) => Promise<unknown>;
  windowHeight?: () => number;
  onHeight?: (height: number) => void;
  /** Reports the frames (in their shared parent) of the actions strip and of the row holding the terminal panes, so a test can prove they do not overlap. */
  onFrame?: (name: "actions" | "terminal", frame: { x: number; y: number; width: number; height: number }) => void;
  /** False while the drawer is kept mounted but closed (PersistentTerminalDrawers): a pane holding the keyboard parks its WebView. */
  shown?: () => boolean;
}) {
  const rpc = props.request ?? requestBackend;
  const failure = signal("");
  const state = (): TerminalDrawerState => drawerStateFor(props.stateKey);
  const change = (next: (current: TerminalDrawerState) => TerminalDrawerState) => updateDrawer(props.stateKey, next);
  const group = () => activeGroup(state());
  const total = () => allTerminalIds(state()).length;
  // A boolean memo for the branch that holds the terminals: read as `total() === 0` the branch ran again on every drawer
  // state update (a height commit, a click that activates a terminal, a split), and each run made every terminal's WebView again.
  const noTerminals = computed(() => total() === 0);
  const mac = platform.os === "macos" || platform.os === "ios";
  const labels = () => terminalActionLabels(state());
  const tips = () => terminalActionLabels(state(), {
    split: formatShortcut(TERMINAL_SHORTCUTS["terminal.split"], mac),
    splitVertical: formatShortcut(TERMINAL_SHORTCUTS["terminal.splitVertical"], mac),
    create: formatShortcut(TERMINAL_SHORTCUTS["terminal.new"], mac),
    close: formatShortcut(TERMINAL_SHORTCUTS["terminal.close"], mac),
  });
  const limit = () => hasReachedSplitLimit(state());
  // The tab's title is the shell's own (the server's `label`), else "Terminal N"; the active tab's close names its shortcut.
  registerDrawerThread(props.stateKey, props.threadId);
  // PersistentThreadTerminals: the drawer follows the server's terminals for this thread (not the panel's terminal tabs);
  // see reconcileDrawerTerminals for the rules.
  effect(() => {
    const ids = serverTerminalIds(props.threadId);
    const panelIds = new Set(panelStateFor(props.stateKey).surfaces.flatMap((surface) => surface.terminalIds ?? []));
    const drawerIds = ids.filter((id) => !panelIds.has(id));
    untracked(() => change((current) => reconcileDrawerTerminals(current, drawerIds, suppressedDrawerTerminals(props.stateKey))));
  });
  startSessionScopes();
  const tabLabel = (id: string) => terminalSessionLabel(props.threadId, id);
  const closeShortcut = formatShortcut(TERMINAL_SHORTCUTS["terminal.close"], mac);
  const closeTabLabel = (id: string) => `Close ${tabLabel(id)}`;
  // The web puts the shortcut in the active tab's label and tooltip; here only the tooltip, so the label stays what tests and assistive tech find.
  const closeTabTip = (id: string) => `${closeTabLabel(id)}${id === state().activeTerminalId && closeShortcut ? ` (${closeShortcut})` : ""}`;
  const windowHeight = () => props.windowHeight?.() ?? windowSize().height;
  // The height follows the pointer while the top edge is dragged and is stored on release.
  const resize = createLiveResize({
    axis: "y",
    direction: -1,
    size: () => clampTerminalHeight(state().height, windowHeight(), drawerHeightBudget()),
    clamp: (value) => clampTerminalHeight(value, windowHeight(), drawerHeightBudget()),
    commit: (value) => change((current) => ({ ...current, height: value })),
  });
  const height = () => resize.live() ?? clampTerminalHeight(state().height, windowHeight(), drawerHeightBudget());
  effect(() => { props.onHeight?.(height()); });

  function split(direction: SplitDirection) { if (!limit() && canLaunchTerminal()) change((current) => splitTerminal(current, direction, allocationFor(props.threadId))); }
  async function close(terminalId: string) {
    failure.set("");
    failure.set((await closeTerminalSession(props.stateKey, props.threadId, terminalId, rpc)) ?? "");
  }
  const closeActive = () => { const id = state().activeTerminalId; if (id) void close(id); };

  const actions = (sidebar: boolean) => (
    <>
      <ActionButton sidebar={sidebar} first label={labels().split} tip={tips().split} icon="square-split-horizontal" disabled={limit()} onPress={() => split("horizontal")} />
      {sidebar ? null : <View class="h-4 w-px bg-border" />}
      <ActionButton sidebar={sidebar} label={labels().splitVertical} tip={tips().splitVertical} icon="square-split-vertical" disabled={limit()} onPress={() => split("vertical")} />
      {sidebar ? null : <View class="h-4 w-px bg-border" />}
      <ActionButton sidebar={sidebar} label={labels().create} tip={tips().create} icon="plus" onPress={() => { if (canLaunchTerminal()) change((current) => newTerminal(current, allocationFor(props.threadId))); }} />
      {sidebar ? null : <View class="h-4 w-px bg-border" />}
      <ActionButton sidebar={sidebar} label={labels().close} tip={tips().close} icon="trash-2" onPress={closeActive} />
    </>
  );

  return (
    <View class="relative w-full min-w-0 shrink-0 border-t border-border bg-background" style={{ height: height() }} accessibilityLabel="Terminal drawer" testID="Terminal drawer">
      {/* The drag edge is a strip of its own above the content: a terminal's native web view is drawn above
          everything in its frame, so an edge laid over the content could not be grabbed. */}
      <View
        accessibilityLabel="Resize terminal drawer"
        role="button"
        focusable={false}
        class={total() <= 1 ? "absolute inset-x-0 top-0 z-10 h-[6px]" : "h-[8px] w-full shrink-0"}
        style={{ cursor: "row-resize" }}
        onMouseMove={resize.follow}
        onPress={() => {}}
        onPanStart={resize.handle.onPanStart}
        onPanEnd={resize.handle.onPanEnd}
      >
        <View class={`absolute inset-x-0 top-0 h-px ${resize.live() !== null ? "bg-primary" : "bg-transparent hover:bg-border"}`} />
        {resize.live() !== null
          ? <Overlay class="inset-0 z-50" accessibilityLabel="Resizing drawer" style={{ cursor: "row-resize" }} onMouseMove={resize.follow} />
          : null}
      </View>
      {noTerminals() ? (
        <View class="min-h-0 w-full flex-1 items-center justify-center gap-3 px-4 py-6">
          <Text class="w-full text-center text-sm text-muted-foreground">No terminal sessions for this thread yet.</Text>
          <View role="button" accessibilityLabel={labels().create} onPress={() => { if (canLaunchTerminal()) change((current) => newTerminal(current, allocationFor(props.threadId))); }} class="h-7 items-center justify-center rounded-lg border border-input px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
            <Text class="text-xs text-foreground">{labels().create}</Text>
          </View>
        </View>
      ) : (
        <View class="min-h-0 flex-1 bg-terminal-background">
          {/* The terminal's native web view is drawn above everything in its frame, so a toolbar floated over its
              corner would vanish: with one terminal the actions get a strip of their own above it, right-aligned. */}
          {total() <= 1 && !webViewsUnderSurface() ? (
            <View class="h-6 shrink-0 flex-row items-center justify-end px-2" accessibilityLabel="Terminal actions strip" onLayout={(event) => props.onFrame?.("actions", { x: event.bounds.origin.x, y: event.bounds.origin.y, width: event.bounds.size.width, height: event.bounds.size.height })}>
              <View class="flex-row items-center overflow-hidden rounded-md border border-border bg-background" accessibilityLabel="Terminal actions">{actions(false)}</View>
            </View>
          ) : null}
          <View onLayout={(event) => props.onFrame?.("terminal", { x: event.bounds.origin.x, y: event.bounds.origin.y, width: event.bounds.size.width, height: event.bounds.size.height })} class="min-h-0 flex-1 flex-row">
          <View class={`min-h-0 min-w-0 flex-1 ${group()?.splitDirection === "vertical" ? "flex-col" : "flex-row"}`}>
            <Each of={group()?.terminalIds ?? []} key={(id) => `${props.threadId}:${id}`}>
              {(id) => (
                <View class={`min-h-0 min-w-0 flex-1 ${id() !== (group()?.terminalIds[0] ?? "") ? (group()?.splitDirection === "vertical" ? "border-t" : "border-l") : ""} ${id() === state().activeTerminalId ? "border-border" : "border-border-70"}`}>
                  <TerminalPane threadId={props.threadId} terminalId={id()} cwd={props.cwd} keyboardGroup={props.stateKey} shown={props.shown} active={id() === state().activeTerminalId} forwardTyping onFocus={() => { setTerminalFocus(true); change((current) => activateTerminal(current, id())); }} onFocusState={(focused) => { reportTerminalFocus({ kind: "drawer" }, focused); if (focused) { drawerTypingWanted.set(true); void releasePromptKeyboard(); } }} onChord={(chord) => runTerminalChord(chord, { kind: "drawer" })} onAddToChat={addTerminalSelectionToChat} onSessionExited={() => void closeEndedTerminal(props.stateKey, props.threadId, id(), rpc)} />
                </View>
              )}
            </Each>
          </View>
          {/* ThreadTerminalDrawer.tsx: where web views sit under the app's surface the actions float over the terminal's
              corner (absolute right-2 top-2 z-20), as in the reference, and the prompt starts at the drawer's top. */}
          {total() <= 1 && webViewsUnderSurface() ? (
            <View class="absolute right-2 top-2 z-20 flex-row items-center overflow-hidden rounded-md border border-border bg-background" accessibilityLabel="Terminal actions" onLayout={(event) => props.onFrame?.("actions", { x: event.bounds.origin.x, y: event.bounds.origin.y, width: event.bounds.size.width, height: event.bounds.size.height })}>{actions(false)}</View>
          ) : null}
          {total() > 1 ? (
            <View class="w-36 min-w-36 shrink-0 border" style={{ borderColor: tokenAlpha("border", 0.7), backgroundColor: tokenAlpha("muted", 0.1) }} accessibilityLabel="Terminals">
              <View class="h-[22px] flex-row items-stretch justify-end border-b border-border-70">{actions(true)}</View>
              <Scroll class="min-h-0 flex-1" contentClass="px-1 py-1">
                <Each of={state().groups} key={(item) => item.id}>
                  {(item) => (
                    <View class="pb-0.5">
                      {state().groups.length > 1 || item().terminalIds.length > 1 ? (
                        <View role="button" accessibilityLabel={`Terminal group ${item().terminalIds.length > 1 ? (item().splitDirection === "vertical" ? "Stacked" : "Side by side") : "Single"}`} onPress={() => change((current) => activateTerminal(current, item().terminalIds[0] ?? ""))} class={`h-[22px] w-full flex-row items-center gap-1 rounded px-1.5 ${item().id === state().activeGroupId ? "bg-accent-50" : "hover:bg-accent-50"}`}>
                          <HIcon name={item().terminalIds.length > 1 ? (item().splitDirection === "vertical" ? "square-split-vertical" : "square-split-horizontal") : "square"} size={12} />
                          <Text class="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{item().terminalIds.length > 1 ? (item().splitDirection === "vertical" ? "Stacked" : "Side by side") : "Single"}</Text>
                          <Text class="text-2xs text-muted-foreground">{String(item().terminalIds.length)}</Text>
                        </View>
                      ) : null}
                      <Each of={item().terminalIds} key={(id) => id}>
                        {(id) => (
                          <View class={`h-6 w-full flex-row items-center gap-0.5 rounded-md pl-1.5 pr-2 ${id() === state().activeTerminalId ? "bg-accent" : "hover:bg-accent-50"}`}>
                            <View role="button" accessibilityLabel={closeTabLabel(id())} tooltip={<Tip text={closeTabTip(id())} />} onPress={() => void close(id())} class="size-4 items-center justify-center"><HIcon name="square-terminal" size={12} /></View>
                            <View role="button" accessibilityLabel={tabLabel(id())} onPress={() => change((current) => activateTerminal(current, id()))} class="min-w-0 flex-1 flex-row items-center"><Text class="truncate text-xs text-foreground">{tabLabel(id())}</Text></View>
                          </View>
                        )}
                      </Each>
                    </View>
                  )}
                </Each>
              </Scroll>
            </View>
          ) : null}
          </View>
        </View>
      )}
      {failure() ? <Text class="px-3 py-1 text-xs text-destructive" role="alert">{failure()}</Text> : null}
    </View>
  );
}
