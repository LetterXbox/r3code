// The Code tab's toolbar, ported from PullRequestCodeTab.tsx (the `toolbar` constant): the diff scope selector
// with its commit list, the file count and viewed-tick provenance, the "Diff options" menu or, from 512 px up
// (@lg), the inline whitespace / layout / wrap toggles, then fold all, hide test files and the file tree.
import { signal, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { HIcon } from "../header/HeaderIcons";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { ChevronTurn } from "../motion/Motion";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS } from "../menuStyles";

/** useOverlayOpen is applied by Popup. */
export const COMMIT_PAGE_SIZE = 10;
/** Tailwind's @lg container query: the toolbar shows its toggles inline from 32rem. */
export const TOOLBAR_WIDE_PX = 512;
/** APP_BASE_NAME in branding.ts. */
export const APP_BASE_NAME = "R3 Code";

export const tip = (text: string) => (
  <Tooltip class="max-w-72 rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{text}</Text></Tooltip>
);

export interface ScopeCommit { oid: string; headline: string }

function Row(props: { label: string; name?: string; checked?: boolean; mono?: string; muted?: boolean; onPress: () => void }) {
  return (
    <View role="button" accessibilityLabel={props.name ?? props.label} accessibilityState={props.checked === undefined ? undefined : { checked: props.checked }} onPress={props.onPress} class={MENU_ITEM_ROW_CLASS}>
      <View class="size-4 items-center justify-center">{props.checked ? <PRIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}</View>
      <Text class={`min-w-0 flex-1 truncate text-sm ${props.muted ? "text-muted-foreground" : "text-foreground"}`}>{props.label}</Text>
      {props.mono ? <Text class="shrink-0 font-mono text-xs text-muted-foreground">{props.mono}</Text> : null}
    </View>
  );
}

/** The scope trigger: "All commits" or the selected commit's headline, over the commits newest first, ten at a time. */
export function DiffScopeMenu(props: { commits: readonly ScopeCommit[]; commit: () => string | null; onSelect: (oid: string | null) => void }) {
  const open = signal(false);
  const visible = signal(COMMIT_PAGE_SIZE);
  const anchor = createAnchor();
  const label = () => props.commits.find((entry) => entry.oid === props.commit())?.headline ?? "All commits";
  const pick = (oid: string | null) => { open.set(false); props.onSelect(oid); };
  return (
    <View>
      <View ref={anchor.ref} role="button" accessibilityLabel={`Diff scope: ${label()}`} accessibilityState={{ expanded: open() }} onPress={() => open.set(!open())} class="h-7 min-w-0 max-w-64 flex-row items-center gap-1 rounded-lg bg-secondary px-2.5">
        <Text class="min-w-0 shrink truncate text-xs text-secondary-foreground">{label()}</Text>
        <ChevronTurn open={open} degrees={180}><PRIcon name="chevron-down" size={14} /></ChevronTurn>
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="start" class="w-80 max-w-[448px]">
          <View class="flex-col p-1">
            <Row label="All commits" checked={props.commit() === null} onPress={() => pick(null)} />
            <Each of={props.commits.slice(0, visible())} key={(entry: ScopeCommit) => entry.oid}>
              {(entry) => <Row label={entry().headline} name={entry().headline} mono={entry().oid.slice(0, 7)} checked={props.commit() === entry().oid} onPress={() => pick(entry().oid)} />}
            </Each>
            {props.commits.length > visible() ? (
              <Row label={`Show more (${props.commits.length - visible()} left)`} name="Show more commits" muted onPress={() => visible.set(visible() + COMMIT_PAGE_SIZE)} />
            ) : null}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

/** The narrow toolbar's "Diff options": whitespace, wrapping and the layout. */
export function DiffOptionsMenu(props: { ignoreWhitespace: () => boolean; wrap: () => boolean; layout: () => "stacked" | "split"; onIgnoreWhitespace: (value: boolean) => void; onWrap: (value: boolean) => void; onLayout: (value: "stacked" | "split") => void }) {
  const open = signal(false);
  const anchor = createAnchor();
  return (
    <View>
      <View ref={anchor.ref} role="button" accessibilityLabel="Diff options" tooltip={tip("Diff options")} onPress={() => open.set(!open())} class="size-7 items-center justify-center rounded-lg hover:bg-accent"><HIcon name="settings-2" size={14} /></View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="end" class="min-w-52">
          <View class="flex-col p-1">
            <Row label="Hide whitespace changes" checked={props.ignoreWhitespace()} onPress={() => props.onIgnoreWhitespace(!props.ignoreWhitespace())} />
            <Row label="Wrap lines" checked={props.wrap()} onPress={() => props.onWrap(!props.wrap())} />
            <View class="mx-2 my-1 h-px bg-border" />
            <Row label="Stacked" checked={props.layout() === "stacked"} onPress={() => { open.set(false); props.onLayout("stacked"); }} />
            <Row label="Split" checked={props.layout() === "split"} onPress={() => { open.set(false); props.onLayout("split"); }} />
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

export function IconToggle(props: { label: string; icon: string; pressed?: boolean; onPress: () => void; /** The tooltip when it differs from the name. */ tooltip?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { pressed: props.pressed }}
      tooltip={tip(props.tooltip ?? props.label)}
      onPress={props.onPress}
      class={`size-7 items-center justify-center rounded-lg ${props.pressed ? "bg-accent" : "hover:bg-accent"}`}
    >
      <HIcon name={props.icon} size={14} />
    </View>
  );
}

/** An icon with an explanation on hover (the reference's Tooltip around a lucide icon). */
export function NoteIcon(props: { label: string; tooltip: string; icon: string; warning?: boolean; hostIcon?: boolean }) {
  return (
    <View accessibilityLabel={props.label} tooltip={tip(props.tooltip)} class="shrink-0 items-center justify-center">
      {props.hostIcon ? <HIcon name={props.icon} size={14} /> : <PRIcon name={props.icon} size={14} />}
    </View>
  );
}

/** The dot PullRequestMetaLine puts between segments. */
export function MetaDot() {
  return <Text class="shrink-0 text-muted-foreground-70">·</Text>;
}
