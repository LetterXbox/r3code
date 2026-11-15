// chat/ThreadFindBar.tsx: the "Find in thread" popover at the chat's top right: a search input, the
// active/total count, previous and next match, and close.
import { effect, keymap, Text, untracked, View } from "nsh";
import type { InputRef } from "nsh";
import { Input } from "nsh/base";
import { TimelineIcon } from "./markdown/TimelineIcon";
import { formatThreadFindCount, THREAD_FIND_MAX_QUERY } from "./threadFind";
import { serverFindLabel } from "./threadFindServer";
import { enterStyle } from "../motion/Motion";
import { fadeInStart } from "../motion/motionTokens";

export function ThreadFindBar(props: {
  open: () => boolean;
  query: () => string;
  matchCount: () => number;
  activeIndex: () => number;
  focusRequest: () => number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /** Server search (useThreadFind): "loading" shows "Searching…", "error" "Search failed" with Retry; counting shows "1/…". */
  status?: () => "loading" | "error" | null;
  counting?: () => boolean;
  onRetry?: () => void;
}) {
  let input: InputRef | null = null;
  // Each chat.find bumps the request, so an open bar refocuses its input.
  effect(() => {
    props.focusRequest();
    // The query is selected on each refocus, so typing replaces it (inputRef.select()).
    if (props.open()) requestAnimationFrame(() => { input?.focus(); const length = untracked(props.query).length; if (length > 0) input?.setSelection(0, length); });
  });
  // ThreadFindBar: Enter steps to the next match, Shift+Enter to the previous (the input's own submit carries no modifiers).
  effect(() => {
    if (!props.open()) return;
    return keymap.bind("shift+enter", () => { if (props.matchCount() > 0) props.onPrevious(); }, { when: "always" });
  });
  const hasQuery = () => props.query().trim().length > 0;
  const status = () => props.status?.() ?? null;
  const noResults = () => hasQuery() && !status() && props.matchCount() === 0;
  const label = () => serverFindLabel({ query: props.query(), status: status(), counting: props.counting?.() === true, activeIndex: props.activeIndex(), total: props.matchCount() }, formatThreadFindCount);
  const navigationDisabled = () => props.matchCount() === 0 || status() === "loading" || props.counting?.() === true;
  const buttonClass = "size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out";
  return (
    <If when={props.open()}>
      {() => (
        <View class="absolute right-3 top-3 z-40 w-80" role="search" accessibilityLabel="Find in thread" style={enterStyle(fadeInStart)}>
          <View class="h-9 flex-row items-center gap-1 rounded-lg border border-input bg-popover pl-3 pr-1.5">
            <Input
              ref={(node) => { input = node; }}
              autoFocus
              accessibilityLabel="Find in thread"
              placeholder="Find in thread"
              maxLength={THREAD_FIND_MAX_QUERY}
              value={props.query()}
              submitBehavior="submit"
              onChange={(event) => props.onQueryChange(event.value)}
              onSubmit={() => props.onNext()}
              onKeyPress={(event) => { if (event.key === "Escape") props.onClose(); }}
              class="h-8 min-w-0 flex-1 text-sm text-foreground"
            />
            <Text
              class={`min-w-10 text-center text-xs tabular-nums ${noResults() ? "text-destructive" : "text-muted-foreground"}`}
              accessibilityLabel="Find match count"
            >
              {label()}
            </Text>
            {status() === "error" && props.onRetry ? (
              <View class="h-6 items-center justify-center rounded-md px-1.5 hover:bg-accent" onPress={props.onRetry} accessibilityLabel="Retry" role="button">
                <Text class="text-xs text-foreground">Retry</Text>
              </View>
            ) : null}
            <View class={`${buttonClass} ${navigationDisabled() ? "opacity-50" : ""}`} disabled={navigationDisabled()} onPress={props.onPrevious} accessibilityLabel="Previous match" role="button">
              <TimelineIcon name="chevron-up" size={14} />
            </View>
            <View class={`${buttonClass} ${navigationDisabled() ? "opacity-50" : ""}`} disabled={navigationDisabled()} onPress={props.onNext} accessibilityLabel="Next match" role="button">
              <TimelineIcon name="chevron-down" size={14} />
            </View>
            <View class={buttonClass} onPress={props.onClose} accessibilityLabel="Close find" role="button">
              <TimelineIcon name="x" size={14} />
            </View>
          </View>
        </View>
      )}
    </If>
  );
}
