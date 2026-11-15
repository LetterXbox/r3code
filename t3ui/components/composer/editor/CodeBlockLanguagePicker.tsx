// ComposerCodeBlockLanguagePicker.tsx: the code block header's language combobox. The trigger shows the language's icon,
// its label and a chevron ("Code language: <label>"); the popup has "Search languages", the 40 languages with their
// icons, a check on the current one, and "No matching languages." when the search finds none.
import { effect, keymap, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { FileEntryIcon } from "../../files/FileEntryIcon";
import { codeBlockIconFileName } from "../../thread/markdown/markdownSegments";
import { ComposerIcon } from "../ComposerIcon";
import { createAnchor, Popup } from "../Popover";
import { Presence } from "../../motion/Motion";
import { DURATION_DEFAULT_MS } from "../../motion/motionTokens";
import { CODE_BLOCK_LANGUAGES, codeLanguageEntry, codeLanguageLabel } from "./richMarkdown";
import type { CodeBlockLanguage } from "./richMarkdown";

/** The rows the picker lists for `language` and a search (the current, unknown language first). */
export function languagePickerItems(language: string, query: string): CodeBlockLanguage[] {
  const current = codeLanguageEntry(language)?.id ?? language;
  const items: CodeBlockLanguage[] = CODE_BLOCK_LANGUAGES.some((entry) => entry.id === current) ? [...CODE_BLOCK_LANGUAGES] : [{ id: current, label: current }, ...CODE_BLOCK_LANGUAGES];
  const needle = query.trim().toLowerCase();
  return needle ? items.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.id.includes(needle)) : items;
}

function LanguageIcon(props: { language: string }) {
  return <FileEntryIcon path={props.language ? codeBlockIconFileName(props.language) : "file.txt"} kind="file" size={14} />;
}

export function CodeBlockLanguagePicker(props: { language: () => string; disabled: () => boolean; onChange: (language: string) => void }) {
  const open = signal(false);
  const query = signal("");
  const highlight = signal(0);
  const anchor = createAnchor();
  const current = () => codeLanguageEntry(props.language())?.id ?? props.language();
  const items = () => languagePickerItems(props.language(), query());
  const close = () => { open.set(false); query.set(""); };
  const pick = (entry: CodeBlockLanguage | undefined) => { if (entry && entry.id !== current()) props.onChange(entry.id); close(); };
  effect(() => {
    if (!open()) return;
    return keymap.bind({
      up: () => highlight.set(Math.max(0, highlight() - 1)),
      down: () => highlight.set(Math.min(items().length - 1, highlight() + 1)),
    }, { when: "always", repeat: true });
  });
  return (
    <View class="-ml-1.5 min-w-0 flex-row">
      <View
        ref={anchor.ref}
        role="button"
        accessibilityLabel={`Code language: ${codeLanguageLabel(props.language())}`}
        disabled={props.disabled()}
        onPress={() => { if (!props.disabled()) { highlight.set(Math.max(0, items().findIndex((entry) => entry.id === current()))); open.set(!open()); } }}
        class={`h-6 min-w-0 flex-row items-center gap-1 rounded-md px-1.5 ${open() ? "bg-accent" : "hover:bg-accent"}`}
      >
        <LanguageIcon language={current()} />
        <Text class="max-w-40 truncate text-xs text-muted-foreground">{codeLanguageLabel(props.language())}</Text>
        <View class="opacity-60"><ComposerIcon name="chevron-down" size={12} /></View>
      </View>
      <Presence when={open} ms={DURATION_DEFAULT_MS}>{(closing) => (
        <Popup animated closing={closing} anchor={anchor.anchor} onClose={close} placement="bottom" align="start" class="w-56">
          <View class="p-1">
            <Input
              autoFocus
              value={query()}
              onChange={(event) => { query.set(event.value); highlight.set(0); }}
              onSubmit={() => pick(items()[highlight()])}
              placeholder="Search languages"
              accessibilityLabel="Search languages"
              class="mb-1 h-8 bg-transparent px-2 text-sm text-foreground"
            />
            {items().length === 0 ? <Text class="px-2 py-1.5 text-sm text-muted-foreground">No matching languages.</Text> : null}
            <Scroll class="max-h-64" accessibilityLabel="Languages">
              <Each of={items()} key={(entry) => entry.id || "plain"}>
                {(entry) => (
                  <View
                    role="option"
                    accessibilityLabel={entry().label}
                    accessibilityState={{ selected: entry().id === current() }}
                    onPress={() => pick(entry())}
                    onMouseEnter={() => highlight.set(items().indexOf(entry()))}
                    class={`min-h-7 flex-row items-center gap-2 rounded-sm px-2 py-1 ${items()[highlight()] === entry() ? "bg-accent" : ""}`}
                  >
                    <LanguageIcon language={entry().id} />
                    <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{entry().label}</Text>
                    {entry().id === current() ? <ComposerIcon name="check" size={14} /> : null}
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </Popup>
      )}</Presence>
    </View>
  );
}
