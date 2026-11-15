// The shared "pick from people or labels" popup (PullRequestCandidatePicker.tsx): an icon button, a search field
// and a list that is a ghost while loading, an explanation when it failed or is empty, and a note when the host
// cut it short. The web uses a combobox so menu typeahead does not eat the keystrokes; a native Input does not.
import { effect, keymap, signal, Text, untracked, View } from "nsh";
import { moveHighlight } from "../Autocomplete";
import { Input } from "nsh/base";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import { PullRequestPeopleGhost } from "./PullRequestGhosts";

export function PullRequestCandidatePicker<T>(props: {
  icon: string;
  label: string;
  allowed: boolean;
  disabledReason: string;
  open: () => boolean;
  onToggle: () => void;
  query: () => string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  isPending: () => boolean;
  error: () => string | null;
  candidates: () => readonly T[];
  emptyLabel: string;
  noMatchLabel: string;
  errorLabel: string;
  truncatedLabel: () => string | null;
  candidateKey: (candidate: T) => string;
  disabled: () => boolean;
  onSelect: (candidate: T) => void;
  row: (candidate: T) => unknown;
  footer?: () => unknown;
}) {
  if (!props.allowed) {
    return (
      <View accessibilityLabel={props.label} accessibilityHint={props.disabledReason} tooltip={props.disabledReason} class="size-6 items-center justify-center rounded-md opacity-50">
        <PRIcon name={props.icon} size={14} />
      </View>
    );
  }
  const anchor = createAnchor();
  // Combobox autoHighlight: the first candidate is highlighted as the list changes; ArrowDown / ArrowUp move it (looping),
  // Enter picks it, Escape closes. Picking keeps the popup open (the web cancels the item-press close).
  const highlighted = signal(-1);
  const shown = () => (props.isPending() || props.error() !== null ? [] : props.candidates());
  effect(() => { const count = shown().length; untracked(() => highlighted.set(count > 0 ? 0 : -1)); });
  effect(() => {
    if (!props.open()) return;
    return keymap.bind({
      down: () => highlighted.set(moveHighlight(highlighted(), shown().length, "down")),
      up: () => highlighted.set(moveHighlight(highlighted(), shown().length, "up")),
      enter: () => { const candidate = shown()[highlighted()]; if (candidate !== undefined && !props.disabled()) props.onSelect(candidate); },
      escape: () => props.onToggle(),
    }, { when: "always", repeat: true });
  });
  return (
    <View>
      <View ref={anchor.ref} accessibilityLabel={props.label} role="button" onPress={props.onToggle} class="size-6 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
        <PRIcon name={props.icon} size={14} />
      </View>
      {props.open() ? (
        <Popup anchor={anchor.anchor} onClose={props.onToggle} placement="bottom" align="start" class="w-72">
          <View class="flex-col">
            <Input autoFocus accessibilityLabel={props.searchLabel} placeholder={props.searchLabel} value={props.query()} onChange={(event) => props.onQueryChange(event.value)} class="h-9 border-b border-border bg-transparent px-3 text-sm text-foreground" />
            <View class="max-h-72 flex-col p-1">
              {props.isPending() ? <PullRequestPeopleGhost rows={4} /> : null}
              {!props.isPending() && props.error() !== null ? <Text class="p-2 text-xs text-muted-foreground">{`${props.errorLabel} ${props.error()}`}</Text> : null}
              {!props.isPending() && props.error() === null && props.candidates().length === 0 ? <Text class="p-2 text-xs text-muted-foreground">{props.query().length > 0 ? props.noMatchLabel : props.emptyLabel}</Text> : null}
              {!props.isPending() && props.error() === null ? (
                <Each of={[...props.candidates()]} key={(candidate: T) => props.candidateKey(candidate)}>
                  {(candidate, index) => (
                    <View
                      role="button"
                      accessibilityLabel={props.candidateKey(candidate())}
                      accessibilityState={{ disabled: props.disabled() }}
                      onPress={() => props.onSelect(candidate())}
                      class={`h-8 flex-row items-center gap-2 rounded-sm px-2 ${props.disabled() ? "opacity-60" : "hover:bg-accent-50"} ${highlighted() === index() ? "bg-accent" : ""}`}
                    >
                      {props.row(candidate()) as never}
                    </View>
                  )}
                </Each>
              ) : null}
              {props.truncatedLabel() ? <Text class="px-2 py-1.5 text-xs text-muted-foreground">{props.truncatedLabel()}</Text> : null}
              {props.footer?.() as never}
            </View>
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

