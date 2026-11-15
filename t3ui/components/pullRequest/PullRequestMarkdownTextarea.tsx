// The multiline field every pull request composer writes in (PullRequestMarkdownTextarea.tsx): it completes `@login`,
// `#123` and GitLab `!123` from the host while typing (a list under the field; Up/Down choose, Return or Tab insert,
// Escape closes it), sends on Mod+Return and cancels on Escape (the editor's onKeyDown).
import { colorScheme, effect, keymap, signal, Text, View } from "nsh";
import { resolveState, toneColor } from "./pullRequestPresentation";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { holdLast, Presence } from "../motion/Motion";
import { DURATION_DEFAULT_MS } from "../motion/motionTokens";
import {
  completionOptionsInput, debouncedPullRequestCompletionSearch, detectPullRequestComposerTrigger, insertPullRequestCompletion, parseCompletionOptions,
  pullRequestCompletionKey, pullRequestCompletions, type CompletionSupport, type PullRequestCompletion,
} from "./pullRequestCompletion.logic";

/** The repository whose users `@` completes and whose issues and change requests `#` does. */
export interface PullRequestCompletionScope {
  request: (method: string, payload: unknown) => Promise<unknown>;
  projectId: string;
  host?: string;
  support: CompletionSupport;
}

/** Null on hosts that complete nothing, so no sigil opens a list that cannot fill. */
export function pullRequestCompletionScope(detail: { capabilities: { mentions?: boolean; referenceSigils?: string[] }; projectId: string; host?: string }, request: PullRequestCompletionScope["request"]): PullRequestCompletionScope | null {
  const { mentions, referenceSigils } = detail.capabilities;
  return mentions === true || (referenceSigils?.length ?? 0) > 0
    ? { request, projectId: detail.projectId, ...(detail.host ? { host: detail.host } : {}), support: { mentions: mentions === true, referenceSigils: referenceSigils ?? [] } }
    : null;
}

const COMPLETION_SEARCH_DEBOUNCE_MS = 200;
const COMPLETION_SUGGESTION_LIMIT = 8;
const EMPTY_STATE = {
  mention: { label: "Mention a user", pending: "Searching users...", failed: "Couldn't search users on the host", none: "No matching users" },
  reference: { label: "Reference an issue or change request", pending: "Searching...", failed: "Couldn't search the host", none: "No matching issues or change requests" },
} as const;

function CompletionRow(props: { completion: PullRequestCompletion }) {
  const completion = () => props.completion;
  return completion().kind === "mention"
    ? <View class="min-w-0 flex-1 flex-row items-center gap-2">
      <Text class="truncate text-sm font-medium text-foreground">{(completion() as Extract<PullRequestCompletion, { kind: "mention" }>).actor.login}</Text>
      {(completion() as Extract<PullRequestCompletion, { kind: "mention" }>).actor.name && (completion() as Extract<PullRequestCompletion, { kind: "mention" }>).actor.name !== (completion() as Extract<PullRequestCompletion, { kind: "mention" }>).actor.login
        ? <Text class="min-w-0 truncate text-sm text-muted-foreground">{(completion() as Extract<PullRequestCompletion, { kind: "mention" }>).actor.name}</Text> : null}
    </View>
    : <View class="min-w-0 flex-1 flex-row items-center gap-2">
      <ReferenceStateIcon candidate={(completion() as Extract<PullRequestCompletion, { kind: "reference" }>).candidate} />
      <Text class="shrink-0 text-sm font-medium text-foreground tabular-nums">{(completion() as Extract<PullRequestCompletion, { kind: "reference" }>).candidate.reference}</Text>
      <Text class="min-w-0 truncate text-sm text-muted-foreground">{(completion() as Extract<PullRequestCompletion, { kind: "reference" }>).candidate.title}</Text>
    </View>;
}

/** ReferenceStateIcon: a change request's state mark, or an issue's (Open issue / Closed issue), toned like the list's. */
function ReferenceStateIcon(props: { candidate: { kind: "issue" | "change-request"; state: "open" | "closed" | "merged" } }) {
  const presentation = props.candidate.kind === "change-request"
    ? resolveState({ state: props.candidate.state, isDraft: false })
    : props.candidate.state === "open"
      ? { label: "Open issue", icon: "circle-dot", tone: resolveState({ state: "open", isDraft: false }).tone }
      : { label: "Closed issue", icon: "circle-check", tone: resolveState({ state: "merged", isDraft: false }).tone };
  return <View accessibilityLabel={presentation.label} role="image"><PRIcon name={presentation.icon} size={16} tint={toneColor(presentation.tone, colorScheme() === "dark" ? "dark" : "light")} /></View>;
}

export function PullRequestMarkdownTextarea(props: {
  value: string;
  onValueChange: (next: string) => void;
  placeholder?: string;
  label: string;
  /** Visible rows; the field is 1.5 rem a row plus its padding (the web's `rows`). */
  rows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  size?: "sm" | "default";
  /** What `@` and `#` complete; absent completes nothing. */
  completion?: PullRequestCompletionScope | null;
  /** Mod+Return: send the text (the field's owner decides whether it can). */
  onModEnter?: () => void;
  /** Escape with no list open: leave the field. */
  onEscape?: () => void;
  /** Minimum height override in points (default: rows). */
  minHeight?: number;
}) {
  const rows = props.rows ?? 3;
  const focused = signal(false);
  const caret = signal<number | null>(null);
  const dismissedAt = signal<number | null>(null);
  const highlight = signal({ query: "", index: 0 });
  const typedKey = signal<string | null>(null);
  const hosted = signal<{ authors: ReturnType<typeof parseCompletionOptions>["authors"]; references: ReturnType<typeof parseCompletionOptions>["references"] } | null>(null);
  const failed = signal(false);
  const asking = signal(false);
  const selection = signal<{ start: number; end?: number } | undefined>(undefined);
  const anchor = createAnchor();

  const trigger = () => {
    const scope = props.completion;
    const at = caret();
    return !scope || at === null || props.disabled ? null : detectPullRequestComposerTrigger(props.value, at, scope.support);
  };
  const open = () => focused() && trigger() !== null && trigger()?.rangeStart !== dismissedAt();
  const candidates = () => (open() ? pullRequestCompletions(trigger(), hosted(), COMPLETION_SUGGESTION_LIMIT) : []);
  const activeIndex = () => { const current = trigger(); return current !== null && highlight().query === current.query ? Math.min(highlight().index, Math.max(0, candidates().length - 1)) : 0; };
  const active = () => candidates()[activeIndex()];
  // The popup plays its 150ms exit after the trigger is gone (candidates() is [] then): it keeps the last list.
  const heldCandidates = holdLast(() => (open() ? candidates() : null));
  const shownCandidates = () => (open() ? candidates() : heldCandidates() ?? []);

  // The query is sent after a pause; older answers stay useful meanwhile, narrowed to what is typed now.
  effect(() => {
    const key = open() ? pullRequestCompletionKey(trigger()) : null;
    const timer = setTimeout(() => typedKey.set(key), key === null ? 0 : COMPLETION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });
  effect(() => {
    const current = trigger(); const scope = props.completion; const key = typedKey();
    if (!open() || !current || !scope) return;
    const search = debouncedPullRequestCompletionSearch(current, key);
    let stale = false;
    asking.set(true); failed.set(false);
    void scope.request("pullRequests.filterOptions", completionOptionsInput(current, scope.projectId, search, scope.host)).then((answer) => {
      if (!stale) { hosted.set(parseCompletionOptions(answer)); asking.set(false); }
    }, () => { if (!stale) { failed.set(true); asking.set(false); } });
    return () => { stale = true; };
  });

  function select(completion: PullRequestCompletion) {
    const current = trigger();
    if (!current) return;
    const next = insertPullRequestCompletion(props.value, current, completion.token);
    props.onValueChange(next.text);
    selection.set({ start: next.cursor });
    caret.set(next.cursor);
  }
  const move = (step: number) => {
    const list = candidates();
    if (list.length === 0) return;
    highlight.set({ query: trigger()?.query ?? "", index: (activeIndex() + step + list.length) % list.length });
  };

  // The list takes Up/Down/Return/Tab/Escape while it is open; otherwise Mod+Return sends and Escape leaves.
  effect(() => {
    if (!focused()) return;
    if (open()) {
      // With nothing to choose, Return and the arrows stay the field's own.
      const keys: Record<string, () => void> = { escape: () => dismissedAt.set(trigger()?.rangeStart ?? null) };
      if (candidates().length > 0) {
        keys.up = () => move(-1); keys.down = () => move(1);
        keys.enter = () => { const choice = active(); if (choice) select(choice); };
        keys.tab = () => { const choice = active(); if (choice) select(choice); };
      }
      return keymap.bind(keys, { when: "always", repeat: true });
    }
    const off: (() => void)[] = [];
    if (props.onModEnter) off.push(keymap.bind("mod+enter", () => props.onModEnter?.(), { when: "always" }));
    if (props.onEscape) off.push(keymap.bind("escape", () => props.onEscape?.(), { when: "always" }));
    return () => off.forEach((stop) => stop());
  });

  const kind = () => trigger()?.kind ?? "mention";
  return (
    <View class="relative w-full">
      <View ref={anchor.ref}>
        <Input
          multiline
          autoFocus={props.autoFocus}
          readonly={props.disabled}
          accessibilityLabel={props.label}
          placeholder={props.placeholder}
          value={props.value}
          {...(selection() ? { selectedRange: selection() } : {})}
          onChange={(event) => { props.onValueChange(event.value); dismissedAt.set(null); if (caret() === null || caret() === props.value.length) caret.set(event.value.length); }}
          onSelectionChange={(event) => { selection.set(undefined); caret.set(event.start === event.end ? event.start : null); }}
          onFocus={() => focused.set(true)}
          onBlur={() => { focused.set(false); caret.set(null); }}
          class={props.size === "sm" ? "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground" : "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"}
          style={{ minHeight: props.minHeight ?? rows * 20 + 16 }}
        />
      </View>
      <Presence when={open} ms={DURATION_DEFAULT_MS}>{(closing) => <Popup animated closing={closing} anchor={anchor.anchor} onClose={() => dismissedAt.set(trigger()?.rangeStart ?? null)} placement="bottom" align="start" class="w-72">
        {shownCandidates().length > 0
          ? <View class="flex-col p-1" accessibilityLabel={EMPTY_STATE[kind()].label}>
            <Each of={shownCandidates()} key={(completion: PullRequestCompletion) => completion.token}>{(completion, index) => <View role="button" accessibilityLabel={`Complete ${completion().token}`} accessibilityState={{ selected: index() === activeIndex() }}
              onPress={() => select(completion())} onMouseEnter={() => { if (index() !== activeIndex()) highlight.set({ query: trigger()?.query ?? "", index: index() }); }}
              class={index() === activeIndex() ? "h-8 flex-row items-center gap-2 rounded-md bg-accent px-2" : "h-8 flex-row items-center gap-2 rounded-md px-2"}>
              <CompletionRow completion={completion()} />
            </View>}</Each>
          </View>
          : <Text class="px-3 py-2 text-xs text-muted-foreground">{EMPTY_STATE[kind()][asking() ? "pending" : failed() ? "failed" : "none"]}</Text>}
      </Popup>}</Presence>
    </View>
  );
}
