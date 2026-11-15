// Edits a description or a comment: a Write / Preview switch over the field, Cancel and Save
// (PullRequestMarkdownEditor.tsx).
import { signal, Text, View } from "nsh";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownTextarea, type PullRequestCompletionScope } from "./PullRequestMarkdownTextarea";

export function PullRequestMarkdownEditor(props: {
  value: string;
  label: string;
  saving: () => boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  /** What `@` and `#` complete in this text. */
  completion?: PullRequestCompletionScope | null;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const draft = signal(props.value);
  const preview = signal(false);
  const empty = () => draft().trim().length === 0;
  const saveDisabled = () => props.saving() || (empty() && props.allowEmpty !== true);
  const mode = (name: "write" | "preview", label: string) => (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: (name === "preview") === preview() }}
      onPress={() => { if (!props.saving()) preview.set(name === "preview"); }}
      class={(name === "preview") === preview() ? "rounded-md bg-segmented-active px-2 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}
    >
      <Text class={(name === "preview") === preview() ? "text-xs font-medium text-foreground" : "text-xs text-muted-foreground"}>{label}</Text>
    </View>
  );
  return (
    <View class="flex-col gap-2" accessibilityLabel={props.label}>
      <View class="flex-row items-center gap-0.5 self-start rounded-lg bg-segmented-track p-0.5" accessibilityLabel="Markdown editor mode">
        {mode("write", "Write")}
        {mode("preview", "Preview")}
      </View>
      {preview() ? (
        <View class="rounded-lg border border-border-60 px-3 py-2">
          {empty() ? <Text class="text-xs text-muted-foreground">Nothing to preview.</Text> : <PullRequestMarkdown text={draft} />}
        </View>
      ) : (
        <PullRequestMarkdownTextarea autoFocus disabled={props.saving()} value={draft()} rows={6} placeholder={props.placeholder} label={props.label} completion={props.completion ?? null} onValueChange={(next) => draft.set(next)}
          onModEnter={() => { if (!saveDisabled()) props.onSave(draft()); }} onEscape={() => { if (!props.saving()) props.onCancel(); }} />
      )}
      <View class="flex-row justify-end gap-2">
        <View role="button" accessibilityLabel="Cancel" onPress={() => { if (!props.saving()) props.onCancel(); }} class="h-6 flex-row items-center rounded-md px-2 hover:bg-accent-50"><Text class="text-xs text-foreground">Cancel</Text></View>
        <View
          role="button"
          accessibilityLabel="Save"
          onPress={() => { if (!saveDisabled()) props.onSave(draft()); }}
          class={saveDisabled() ? "h-6 flex-row items-center rounded-md border border-border px-2 opacity-50" : "h-6 flex-row items-center rounded-md border border-border px-2 hover:bg-accent-50"}
        >
          <Text class="text-xs text-foreground">{props.saving() ? "Saving..." : "Save"}</Text>
        </View>
      </View>
    </View>
  );
}

