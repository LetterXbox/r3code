// Saved issue filter views dropdown and save/rename dialog (#29387, #37963).
import { signal, Storage, Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { createAnchor } from "../composer/Popover";
import { tokenAlpha } from "../composer/tokenColor";
import { DialogInput as Input } from "../DialogInput";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../menuStyles";
import { SettingsButton } from "../SettingsLayout";
import { SettingsDialog } from "../SettingsDialog";
import { showToast } from "../toast";
import { PRIcon } from "../pullRequest/PRIcon";
import {
  ISSUE_SAVED_VIEWS_KEY,
  ISSUE_VIEW_NAME_MAX_LENGTH,
  issueViewMatches,
  issueViewNameError,
  normalizeIssuePreferences,
  readIssueSavedViews,
  writeIssueSavedViews,
  type IssueListPreferences,
  type IssueSavedView,
} from "./issueListPreferences";

const savedViews = signal<IssueSavedView[]>([]);
let storageLoaded = false;

export function resetIssueSavedViewsForTest() {
  storageLoaded = true;
  savedViews.set([]);
}

export function IssueSavedViewsMenu(props: {
  preferences: () => IssueListPreferences;
  onApply: (preferences: IssueListPreferences) => void;
  storage?: { read: () => Promise<string | null>; write: (raw: string) => Promise<void> };
}) {
  const store = props.storage ?? {
    read: () => Storage.getItem(ISSUE_SAVED_VIEWS_KEY),
    write: (raw: string) => Storage.setItem(ISSUE_SAVED_VIEWS_KEY, raw),
  };
  if (!storageLoaded) {
    storageLoaded = true;
    void store.read().then((raw) => {
      const read = readIssueSavedViews(raw);
      if (read.length > 0 && savedViews().length === 0) savedViews.set(read);
    }).catch(() => {});
  }
  const selectedId = signal<string | null>(null);
  const editor = signal<{ id?: string; name: string } | null>(null);
  const anchor = createAnchor();

  const selectedView = () => {
    const views = savedViews();
    const prefs = props.preferences();
    return views.find((view) => view.id === selectedId()) ?? views.find((view) => issueViewMatches(view, prefs)) ?? null;
  };
  const modified = () => {
    const view = selectedView();
    return view !== null && !issueViewMatches(view, props.preferences());
  };
  const nameError = () => {
    const current = editor();
    return current ? issueViewNameError(current.name, savedViews(), current.id) : null;
  };

  async function persist(update: (current: readonly IssueSavedView[]) => IssueSavedView[]): Promise<boolean> {
    const previous = savedViews();
    const next = update(previous);
    savedViews.set(next);
    try {
      await store.write(writeIssueSavedViews(next));
      return true;
    } catch (cause) {
      savedViews.set(previous);
      showToast({
        type: "error",
        title: "Could not save view",
        description: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    }
  }

  function applyView(view: IssueSavedView) {
    selectedId.set(view.id);
    props.onApply(view.preferences);
  }

  async function saveEditor() {
    const current = editor();
    if (!current || nameError()) return;
    const trimmed = current.name.trim();
    const prefs = normalizeIssuePreferences(props.preferences());
    if (current.id) {
      const targetId = current.id;
      const ok = await persist((list) => list.map((v) => (v.id === targetId ? { ...v, name: trimmed } : v)));
      if (ok) editor.set(null);
      return;
    }
    const id = `view-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ok = await persist((list) => [...list, { id, name: trimmed, preferences: prefs }]);
    if (ok) {
      selectedId.set(id);
      editor.set(null);
    }
  }

  const triggerLabel = () => {
    const view = selectedView();
    if (!view) return "Views";
    return modified() ? `${view.name} *` : view.name;
  };

  return (
    <View>
      <Menu
        align="start"
        popupClass={`${MENU_POPUP_CLASS} min-w-[220px]`}
        trigger={
          <View
            ref={anchor.ref}
            role="button"
            accessibilityLabel="Saved issue views"
            style={{ backgroundColor: tokenAlpha("input", 0.32) }}
            class="h-8 flex-row items-center gap-2 rounded-lg border border-input bg-transparent px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
          >
            <PRIcon name="layers" size={14} />
            <Text class="max-w-36 truncate text-sm text-foreground">{triggerLabel()}</Text>
            <PRIcon name="chevron-down" size={14} />
          </View>
        }
      >
        <Each of={savedViews()} key={(view: IssueSavedView) => view.id}>
          {(view) => (
            <MenuItem accessibilityLabel={view().name} onSelect={() => applyView(view())} class={MENU_ITEM_ROW_CLASS}>
              <View class="size-4 items-center justify-center">
                {selectedView()?.id === view().id ? <PRIcon name="check" size={MENU_ITEM_ICON_SIZE} /> : null}
              </View>
              <Text class="min-w-0 flex-1 truncate text-sm text-foreground">{view().name}</Text>
            </MenuItem>
          )}
        </Each>
        {savedViews().length > 0 ? <MenuSeparator class="my-1 h-px bg-border" /> : null}
        <MenuItem
          accessibilityLabel={selectedView() && modified() ? "Update saved view" : "Save current view"}
          onSelect={() => {
            const view = selectedView();
            if (view && modified()) {
              const prefs = normalizeIssuePreferences(props.preferences());
              void persist((list) => list.map((item) => (item.id === view.id ? { ...item, preferences: prefs } : item)));
            } else {
              editor.set({ name: "" });
            }
          }}
          class={MENU_ITEM_ROW_CLASS}
        >
          <PRIcon name="plus" size={MENU_ITEM_ICON_SIZE} />
          <Text class="text-sm text-foreground">{selectedView() && modified() ? `Update "${selectedView()!.name}"` : "Save current view..."}</Text>
        </MenuItem>
        {selectedView() ? (
          <>
            <MenuItem accessibilityLabel="Rename view" onSelect={() => editor.set({ id: selectedView()!.id, name: selectedView()!.name })} class={MENU_ITEM_ROW_CLASS}>
              <PRIcon name="pencil" size={MENU_ITEM_ICON_SIZE} />
              <Text class="text-sm text-foreground">Rename view...</Text>
            </MenuItem>
            <MenuItem
              accessibilityLabel="Delete view"
              onSelect={() => {
                const target = selectedView()!;
                selectedId.set(null);
                void persist((list) => list.filter((v) => v.id !== target.id));
              }}
              class={MENU_ITEM_ROW_CLASS}
            >
              <PRIcon name="trash-2" size={MENU_ITEM_ICON_SIZE} />
              <Text class="text-sm text-foreground">Delete view</Text>
            </MenuItem>
          </>
        ) : null}
      </Menu>

      <SettingsDialog
        open={editor() !== null}
        onClose={() => editor.set(null)}
        title={editor()?.id ? "Rename saved view" : "Save issue view"}
        description="Give these filters a name so you can return to them in one click."
        width={420}
        testID="Save issue view dialog"
        footer={
          <>
            <SettingsButton label="Cancel" onPress={() => editor.set(null)} />
            <SettingsButton
              tone="primary"
              label="Save"
              accessibilityLabel="Save view"
              disabled={nameError() !== null}
              onPress={() => void saveEditor()}
            />
          </>
        }
      >
        <View class="flex-col gap-1.5">
          <Input
            autoFocus
            accessibilityLabel="View name"
            placeholder="Assigned open bugs"
            maxLength={ISSUE_VIEW_NAME_MAX_LENGTH}
            value={editor()?.name ?? ""}
            onChange={(event) => editor.update((cur) => (cur ? { ...cur, name: event.value } : null))}
            onSubmitEditing={() => void saveEditor()}
          />
          {nameError() ? <Text class="text-xs text-destructive-foreground">{nameError()!}</Text> : null}
        </View>
      </SettingsDialog>
    </View>
  );
}
