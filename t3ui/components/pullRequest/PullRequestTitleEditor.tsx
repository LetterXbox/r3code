// PullRequestTitleEditor.tsx: the title row, with a pencil that opens an Input and Cancel / Save
// when the host lets the viewer rename the pull request.
import { computed, Text, View } from "nsh";
import { Input } from "nsh/base";
import { PRIcon } from "./PRIcon";
import type { PullRequestActionsModel } from "./pullRequestActionsModel";
import type { PullRequestDetailData } from "./pullRequestDetail.logic";

export function PullRequestTitleEditor(props: { detail: () => PullRequestDetailData; actions: PullRequestActionsModel; right?: unknown }) {
  const actions = props.actions;
  const detail = () => props.detail();
  const draft = () => actions.titleDraft();
  // Only whether it is editing decides the branch, so typing does not rebuild the field.
  const editing = computed(() => actions.titleDraft() !== null);
  return (
    <View class="min-w-0 flex-col">
    {!editing() ? (
    <View class="min-h-6 flex-row items-center gap-1">
      <Text class="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{detail().title}</Text>
      {detail().canEditTitle ? (
        <View accessibilityLabel="Edit title" role="button" onPress={() => actions.editTitle(detail().title)} class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <PRIcon name="pencil" size={12} />
        </View>
      ) : null}
      {props.right as never}
    </View>
  ) : (
    <View class="flex-col gap-2">
      <Input
        autoFocus
        accessibilityLabel="Pull request title"
        value={draft() ?? ""}
        onChange={(event) => actions.titleDraft.set(event.value)}
        onSubmit={() => void actions.saveTitle(detail().title, draft() ?? "")}
        class="h-8 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
      />
      {actions.titleError() ? <Text class="text-xs text-destructive">{actions.titleError()}</Text> : null}
      <View class="flex-row justify-end gap-2">
        <View accessibilityLabel="Cancel title edit" role="button" onPress={() => { if (!actions.titleSaving()) actions.cancelTitle(); }} class="h-6 items-center justify-center rounded-md px-2 hover:bg-accent-50">
          <Text class="text-xs text-foreground">Cancel</Text>
        </View>
        <View
          accessibilityLabel="Save title"
          role="button"
          onPress={() => void actions.saveTitle(detail().title, draft() ?? "")}
          class={actions.titleSaving() || (draft() ?? "").trim().length === 0 ? "h-6 items-center justify-center rounded-md border border-input px-2 opacity-50" : "h-6 items-center justify-center rounded-md border border-input px-2 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"}
        >
          <Text class="text-xs text-foreground">{actions.titleSaving() ? "Saving..." : "Save"}</Text>
        </View>
      </View>
    </View>
    )}
    </View>
  );
}

