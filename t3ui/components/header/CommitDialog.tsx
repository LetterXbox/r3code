// The commit dialog of GitActionsControl.tsx: Branch, the changed files (with an
// Edit mode to leave some out), an optional message, and Cancel / Commit on new
// branch / Commit.
import { signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { DialogInput as Input } from "../DialogInput";
import { COMMIT_DIALOG_DESCRIPTION, COMMIT_DIALOG_TITLE, commitSelection, formatDiffCount, toggleExcluded, type ChangedFile } from "./gitLogic";
import { HIcon } from "./HeaderIcons";
import { useOverlayOpen } from "../rightPanel/nativeOcclusion";
import { dialogBackdropStyle, dialogPopupMotion, keepPressInDialog } from "../dialogSurface";
import { DIALOG_MS } from "../motion/motionTokens";
import { diffAdditionClass, diffDeletionClass } from "../diff/diffColorScheme";
import { DialogCloseButton } from "../DialogCloseButton";

export interface CommitRequest { message: string; filePaths: string[] | null; featureBranch: boolean }

export function CommitDialog(props: {
  open: () => boolean;
  branch: () => string | null;
  isDefaultRef: () => boolean;
  files: () => ChangedFile[];
  onCancel: () => void;
  onCommit: (request: CommitRequest) => void;
}) {
  useOverlayOpen(() => props.open(), "commit dialog", DIALOG_MS);
  const message = signal("");
  const excluded = signal<Set<string>>(new Set());
  const editing = signal(false);
  const selection = () => commitSelection(props.files(), excluded());
  const reset = () => { message.set(""); excluded.set(new Set()); editing.set(false); };
  const cancel = () => { reset(); props.onCancel(); };
  const commit = (featureBranch: boolean) => {
    const request = { message: message().trim(), filePaths: selection().filePaths, featureBranch };
    reset();
    props.onCommit(request);
  };
  const primary = "h-8 items-center justify-center rounded-lg px-3";
  return (
    <Dialog
      open={props.open()}
      animation="fade"
      onOpenChange={({ open }) => { if (!open) cancel(); }}
      backdropStyle={dialogBackdropStyle()}
      style={[{ margin: "auto", width: 460, maxWidth: "92%" }, dialogPopupMotion(props.open)]}
    >
      <View class="relative gap-4 rounded-2xl border border-border bg-background p-6" role="group" accessibilityLabel={COMMIT_DIALOG_TITLE} onPress={keepPressInDialog}>
        <DialogCloseButton onClose={cancel} />
        <View class="gap-1.5">
          <Text class="text-lg font-semibold text-foreground">{COMMIT_DIALOG_TITLE}</Text>
          <Text class="text-sm text-muted-foreground">{COMMIT_DIALOG_DESCRIPTION}</Text>
        </View>
        <View class="gap-3 rounded-xl bg-card-40 p-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-sm text-muted-foreground">Branch</Text>
            <View class="flex-row items-center gap-2">
              <Text class="text-sm font-medium text-foreground">{props.branch() ?? "(detached HEAD)"}</Text>
              {props.isDefaultRef() ? <Text class="text-sm text-warning-foreground">Default branch</Text> : null}
            </View>
          </View>
          <View class="gap-1">
            <View class="flex-row items-center justify-between">
              <View class="flex-row items-center gap-2">
                {editing() && props.files().length > 0 ? (
                  <View
                    role="checkbox"
                    accessibilityLabel="Select all files"
                    accessibilityState={{ checked: selection().allSelected }}
                    onPress={() => excluded.set(selection().allSelected ? new Set(props.files().map((file) => file.path)) : new Set())}
                    class="size-4 items-center justify-center rounded-sm border border-input"
                  >
                    {selection().allSelected ? <HIcon name="check" size={12} /> : null}
                  </View>
                ) : null}
                <Text class="text-sm text-muted-foreground">Files</Text>
                {!selection().allSelected && !editing() ? <Text class="text-sm text-muted-foreground">{`(${selection().selected.length} of ${props.files().length})`}</Text> : null}
              </View>
              {props.files().length > 0 ? (
                <View role="button" accessibilityLabel={editing() ? "Done editing files" : "Edit files"} onPress={() => editing.update((value) => !value)} class="rounded-md px-2 py-0.5 hover:bg-accent">
                  <Text class="text-xs text-foreground">{editing() ? "Done" : "Edit"}</Text>
                </View>
              ) : null}
            </View>
            {props.files().length === 0 ? (
              <Text class="text-sm font-medium text-foreground">none</Text>
            ) : (
              <View class="gap-2">
                <View class="h-44 overflow-hidden rounded-lg bg-card">
                  <Each of={props.files()} key={(file) => file.path}>
                    {(file) => (
                      <View class="w-full flex-row items-center gap-2 rounded-md px-2 py-1 hover:bg-accent-50">
                        {editing() ? (
                          <View
                            role="checkbox"
                            accessibilityLabel={`Include ${file().path}`}
                            accessibilityState={{ checked: !excluded().has(file().path) }}
                            onPress={() => excluded.set(toggleExcluded(excluded(), file().path))}
                            class="size-4 items-center justify-center rounded-sm border border-input"
                          >
                            {!excluded().has(file().path) ? <HIcon name="check" size={12} /> : null}
                          </View>
                        ) : null}
                        <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${excluded().has(file().path) ? "text-muted-foreground" : "text-foreground"}`}>{file().path}</Text>
                        <Text class={`font-mono text-xs ${diffAdditionClass("text-emerald-700 dark:text-emerald-400")}`}>{`+${formatDiffCount(file().insertions)}`}</Text>
                        <Text class={`font-mono text-xs ${diffDeletionClass("text-red-700 dark:text-red-400")}`}>{`-${formatDiffCount(file().deletions)}`}</Text>
                      </View>
                    )}
                  </Each>
                </View>
                <View class="flex-row justify-end gap-1">
                  <Text class={`font-mono text-xs ${diffAdditionClass("text-emerald-700 dark:text-emerald-400")}`}>{`+${formatDiffCount(selection().insertions)}`}</Text>
                  <Text class="font-mono text-xs text-muted-foreground">/</Text>
                  <Text class={`font-mono text-xs ${diffDeletionClass("text-red-700 dark:text-red-400")}`}>{`-${formatDiffCount(selection().deletions)}`}</Text>
                </View>
              </View>
            )}
          </View>
        </View>
        <View class="gap-1">
          <Text class="text-sm font-medium text-foreground">Commit message (optional)</Text>
          <Input
            accessibilityLabel="Commit message"
            value={message()}
            placeholder="Leave empty to auto-generate"
            multiline
            onChange={(event) => message.set(event.value)}
            class="min-h-16 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </View>
        <View class="flex-row justify-end gap-2">
          <View role="button" accessibilityLabel="Cancel commit" onPress={cancel} class={`${primary} border border-input hover:bg-accent`}><Text class="text-sm text-foreground">Cancel</Text></View>
          <View role="button" accessibilityLabel="Commit on new branch" disabled={selection().noneSelected} onPress={() => commit(true)} class={`${primary} border border-input ${selection().noneSelected ? "opacity-64" : "hover:bg-accent"}`}><Text class="text-sm text-foreground">Commit on new branch</Text></View>
          <View role="button" accessibilityLabel="Commit" disabled={selection().noneSelected} onPress={() => commit(false)} class={`${primary} bg-primary ${selection().noneSelected ? "opacity-64" : ""}`}><Text class="text-sm font-medium text-primary-foreground">Commit</Text></View>
        </View>
      </View>
    </Dialog>
  );
}
