// The find panel over a diff (the patched @pierre/diffs' SearchPanelWidget in find mode): the query, the result
// ("No results", "N results", "i of N"), Match Case / Whole Word / Regexp toggles, Previous, Next and Close. Return
// goes to the next match, Shift+Return to the previous one, Escape closes. The app owns the params and the current match.
import { effect, keymap, signal, Text, View } from "nsh";
import type { InputRef, Signal } from "nsh";
import { Input } from "nsh/base";
import { PRIcon } from "../pullRequest/PRIcon";
import { HIcon } from "../header/HeaderIcons";
import { searchResultLabel, stepMatch, type DiffSearchParams } from "./diffSearch";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";

export interface DiffFindState {
  open: Signal<boolean>;
  params: Signal<DiffSearchParams>;
  current: Signal<number | null>;
}

export function createDiffFindState(): DiffFindState {
  return { open: signal<boolean>(false), params: signal<DiffSearchParams>({ text: "", caseSensitive: false, wholeWord: false, regex: false }), current: signal<number | null>(null) };
}

/** `count`: the matches found; `onReveal`: scroll the match to the middle of the diff. */
export function DiffFindBar(props: { state: DiffFindState; count: () => number; onReveal: (index: number) => void }) {
  const state = props.state;
  useOverlayOpen(() => state.open());
  const set = (patch: Partial<DiffSearchParams>) => { state.params.update((current) => ({ ...current, ...patch })); state.current.set(null); };
  const go = (previous: boolean) => {
    const next = stepMatch(props.count(), state.current(), previous);
    state.current.set(next);
    if (next !== null) props.onReveal(next);
  };
  // Shift+Return in the field goes back (Return's own event carries no modifiers here).
  const focused = signal(false);
  effect(() => { if (!focused() || !state.open()) return; return keymap.bind("shift+enter", () => go(true), { when: "always" }); });
  const close = () => { state.open.set(false); state.current.set(null); };
  const toggle = (label: string, glyph: string, key: "caseSensitive" | "wholeWord" | "regex") => (
    <View role="button" accessibilityLabel={label} accessibilityState={{ pressed: state.params()[key] }} onPress={() => set({ [key]: !state.params()[key] })}
      class={`h-6 min-w-6 items-center justify-center rounded px-1 ${state.params()[key] ? "bg-accent" : "hover:bg-accent-50"}`}>
      <Text class="font-mono text-2xs text-foreground">{glyph}</Text>
    </View>
  );
  const iconButton = (label: string, icon: string, onPress: () => void, disabled = false) => (
    <View role="button" accessibilityLabel={label} accessibilityState={{ disabled }} onPress={() => { if (!disabled) onPress(); }}
      class={`size-6 items-center justify-center rounded ${disabled ? "opacity-50" : "hover:bg-accent-50"}`}>
      {icon === "chevron-up" ? <HIcon name="chevron-up" size={14} /> : <PRIcon name={icon} size={14} />}
    </View>
  );
  return state.open() ? (
    <View class="absolute right-4 top-2 z-50 w-[420px] flex-row items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1 shadow-lg" accessibilityLabel="Find in diff">
      <Input
        ref={(node: InputRef) => node.focus()}
        accessibilityLabel="Search"
        placeholder="Search"
        value={state.params().text}
        onChange={(event) => set({ text: event.value })}
        onKeyPress={(event) => {
          if (event.key === "Escape") close();
          else if (event.key === "Enter") go(false);
        }}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        class="h-6 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground"
      />
      <Text class="shrink-0 text-xs text-muted-foreground tabular-nums" accessibilityLabel="Search result">{searchResultLabel(props.count(), state.current())}</Text>
      {toggle("Match Case", "Aa", "caseSensitive")}
      {toggle("Whole Word", "ab", "wholeWord")}
      {toggle("Regexp", ".*", "regex")}
      {iconButton("Previous", "chevron-up", () => go(true), props.count() === 0)}
      {iconButton("Next", "chevron-down", () => go(false), props.count() === 0)}
      {iconButton("Close", "x", close)}
    </View>
  ) : null;
}
