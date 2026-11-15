// ui/autocomplete.tsx over Base UI's Autocomplete (mode "none", openOnInputClick): a field with a popup of suggestions
// under it. While the field has the focus and the popup is open, ArrowDown / ArrowUp move the highlighted item
// (looping, Base UI's loopFocus), Enter picks the highlighted one (with none highlighted Enter is the field's own),
// Escape closes the popup, and Mod+1..9 (AddEnvironmentDialog.tsx's thread-jump shortcuts) pick that row. The popup:
// rounded-lg border bg-popover shadow-lg, a list in a fading scroll area (max-h-72 at the SSH call site), p-1, items
// min-h-7 rounded-sm px-2 py-1 gap-2, highlighted bg-accent; AutocompleteEmpty is p-2 centred muted text.
import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";
import { FadeScroll } from "./FadeScroll";

/** The highlighted index after a key: -1 (none) goes to the first / last; the ends loop. */
export function moveHighlight(current: number, count: number, key: "up" | "down"): number {
  if (count === 0) return -1;
  if (current < 0) return key === "down" ? 0 : count - 1;
  return key === "down" ? (current + 1) % count : (current - 1 + count) % count;
}

export function createAutocomplete<T>(options: {
  items: () => readonly T[];
  open: () => boolean;
  setOpen: (open: boolean) => void;
  onSelect: (item: T) => void;
}) {
  const focused = signal(false);
  const highlighted = signal(-1);
  // A new list starts with nothing highlighted (Base UI autoHighlight false).
  effect(() => { void options.items(); untracked(() => highlighted.set(-1)); });
  effect(() => {
    if (!focused() || !options.open()) return;
    const count = options.items().length;
    const bindings: Record<string, () => void> = {
      down: () => highlighted.set(moveHighlight(highlighted(), options.items().length, "down")),
      up: () => highlighted.set(moveHighlight(highlighted(), options.items().length, "up")),
      escape: () => options.setOpen(false),
    };
    for (let index = 0; index < Math.min(9, count); index++) {
      bindings[`mod+${index + 1}`] = () => { const item = options.items()[index]; if (item !== undefined) pick(item); };
    }
    if (highlighted() >= 0) bindings.enter = () => { const item = options.items()[highlighted()]; if (item !== undefined) pick(item); };
    return keymap.bind(bindings, { when: "always", repeat: true });
  });
  cleanup(() => focused.set(false));
  function pick(item: T) {
    options.setOpen(false);
    options.onSelect(item);
  }
  return {
    highlighted,
    pick,
    /** Spread on the field (compose with its own handlers). */
    onFocus: () => { focused.set(true); options.setOpen(true); },
    onBlur: () => focused.set(false),
    /** Typing opens the list again (Base UI reopens on input). */
    onType: () => options.setOpen(true),
  };
}

export function AutocompletePopup(props: { label?: string; maxHeight?: string; children: any }) {
  return (
    <View class="rounded-lg border border-border bg-popover shadow-lg" accessibilityLabel={props.label}>
      <FadeScroll surface="popover" class={props.maxHeight ?? "max-h-72"} contentClass="p-1">{props.children}</FadeScroll>
    </View>
  );
}

export function AutocompleteItem(props: { label: string; highlighted: boolean; onPress: () => void; onHover?: () => void; class?: string; children: any }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.highlighted }}
      onPress={props.onPress}
      onMouseEnter={props.onHover}
      class={`min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 ${props.highlighted ? "bg-accent" : "hover:bg-accent"} ${props.class ?? ""}`}
    >
      {props.children}
    </View>
  );
}

export function AutocompleteEmpty(props: { children: string }) {
  return <View class="p-2"><Text class="text-center text-sm text-muted-foreground">{props.children}</Text></View>;
}

/** Mod+N's label for row `index` (the first nine rows), as the menu shows shortcuts. */
export const autocompleteShortcutLabel = (index: number): string | null => (index < 9 ? keymap.label(`mod+${index + 1}`) : null);
