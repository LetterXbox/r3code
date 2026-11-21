// Saved pull request filter views dropdown and save/rename dialog (#29387).
import { signal, Storage, Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";
import { createAnchor } from "../composer/Popover";
import { tokenAlpha } from "../composer/tokenColor";
import { DialogInput as Input } from "../DialogInput";
import { MENU_ITEM_ICON_SIZE, MENU_ITEM_ROW_CLASS, MENU_POPUP_CLASS } from "../menuStyles";
import { SettingsButton } from "../SettingsLayout";
import { SettingsDialog } from "../SettingsDialog";
import { showToast } from "../toast";
import { PRIcon } from "./PRIcon";
import { normalizePreferences, type PullRequestListPreferences } from "./pullRequestListPreferences";
import {
  PULL_REQUEST_SAVED_VIEWS_KEY, PULL_REQUEST_VIEW_NAME_MAX_LENGTH, pullRequestViewMatches, pullRequestViewNameError,
  readPullRequestSavedViews, writePullRequestSavedViews, type PullRequestSavedView,
} from "./pullRequestSavedViews";

const savedViews = signal<PullRequestSavedView[]>([]);
let storageLoaded = false;

export function resetPullRequestSavedViewsForTest() {
  storageLoaded = true;
  savedViews.set([]);
}

export function PullRequestSavedViewsMenu(props: {
  preferences: () => PullRequestListPreferences;
  onApply: (preferences: PullRequestListPreferences) => void;
  storage?: { read: () => Promise<string | null>; write: (raw: string) => Promise<void> };
}) {
  const store = props.storage ?? {
    read: () => Storage.getItem(PULL_REQUEST_SAVED_VIEWS_KEY),
    write: (raw: string) => Storage.setItem(PULL_REQUEST_SAVED_VIEWS_KEY, raw),
  };
  if (!storageLoaded) {
    storageLoaded = true;
    void store.read().then((raw) => {
      const read = readPullRequestSavedViews(raw);
      if (read.length > 0 && savedViews().length === 0) savedViews.set(read);
    }).catch(() => {});
  }
  const selectedId = signal<string | null>(null);
  const editor = signal<{ id?: string; name: string } | null>(null);
  const anchor = createAnchor();

  const selectedView = () => {
    const views = savedViews();
    const prefs = props.preferences();
    return views.find((view) => view.id === selectedId()) ?? views.find((view) => pullRequestViewMatches(view, prefs)) ?? null;
  };
  const modified = () => {
    const view = selectedView();
    return view !== null && !pullRequestViewMatches(view, props.preferences());
  };
  const nameError = () => {
    const current = editor();
    return current ? pullRequestViewNameError(current.name, savedViews(), current.id) : null;
  };

  async function persist(update: (current: readonly PullRequestSavedView[]) => PullRequestSavedView[]): Promise<boolean> {
    const next = update(savedViews());
    savedViews.set(next);
    try {
      await store.write(writePullRequestSavedViews(next));
      return true;
    } catch {
      showToast({ type: "error", title: "Could not save PR views", description: "Local storage is unavailable or full. Try again after freeing space or allowing storage." });
      return false;
    }
  }

  async function saveName() {
    const currentEditor = editor();
    if (!currentEditor || nameError() !== null) return;
    const id = currentEditor.id ?? crypto.randomUUID();
    const name = currentEditor.name.trim();
    const editingId = currentEditor.id;
    let missing = false;
    const ok = await persist((current) => {
      if (editingId && !current.some((view) => view.id === editingId)) {
        missing = true;
        return [...current];
      }
      const normalized = normalizePreferences(props.preferences());
      return editingId
        ? current.map((view) => (view.id === editingId ? { ...view, name } : view))
        : [...current, { id, name, preferences: normalized }];
    });
    if (missing) {
      editor.update((current) => (current ? { name: current.name } : null));
      showToast({ type: "error", title: "This saved view was removed", description: "Your name has been kept. Save it as a new view or cancel." });
      return;
    }
    if (!ok) return;
    selectedId.set(id);
    editor.set(null);
  }

  return (
    <>
      <View ref={anchor.ref}>
        <Menu
          popupClass={`${MENU_POPUP_CLASS} min-w-[200px]`}
          align="start"
          trigger={
            <View
              role="button"
              accessibilityLabel="Saved pull request views"
              tooltip={selectedView()?.name ?? "Saved pull request views"}
              style={{ backgroundColor: tokenAlpha("input", 0.32) }}
              class="h-8 flex-row items-center gap-2 rounded-lg border border-input bg-transparent px-3 hover:bg-accent-50 active:scale-[0.97] transition-transform duration-150 ease-in-out"
            >
              <PRIcon name="bookmark" size={16} />
              <Text class="max-w-40 truncate text-sm text-foreground">{selectedView()?.name ?? "Views"}</Text>
              {modified() ? <Text class="text-sm text-muted-foreground" accessibilityLabel="Modified view">*</Text> : null}
              <PRIcon name="chevron-down" size={12} />
            </View>
          }
        >
          <Each of={savedViews()} key={(view: PullRequestSavedView) => view.id}>
            {(view) => (
              <MenuItem
                accessibilityLabel={view().name}
                class={MENU_ITEM_ROW_CLASS}
                onSelect={() => {
                  selectedId.set(view().id);
                  props.onApply(normalizePreferences(view().preferences));
                }}
              >
                <PRIcon name={selectedView()?.id === view().id && !modified() ? "check" : "bookmark"} size={MENU_ITEM_ICON_SIZE} />
                <Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">{view().name}</Text>
              </MenuItem>
            )}
          </Each>
          {savedViews().length > 0 ? <MenuSeparator /> : null}
          <MenuItem
            accessibilityLabel="Save current view…"
            class={MENU_ITEM_ROW_CLASS}
            onSelect={() => editor.set({ name: props.preferences().involvement === "reviewing" ? "PRs Requesting My Review" : "" })}
          >
            <PRIcon name="plus" size={MENU_ITEM_ICON_SIZE} />
            <Text class="text-sm text-popover-foreground">Save current view…</Text>
          </MenuItem>
          {selectedView() ? (
            <>
              {modified() ? (
                <MenuItem
                  accessibilityLabel="Update saved view"
                  class={MENU_ITEM_ROW_CLASS}
                  onSelect={() => {
                    const targetId = selectedView()!.id;
                    const normalized = normalizePreferences(props.preferences());
                    void persist((current) => current.map((view) => (view.id === targetId ? { ...view, preferences: normalized } : view)));
                  }}
                >
                  <Text class="text-sm text-popover-foreground">Update saved view</Text>
                </MenuItem>
              ) : null}
              <MenuItem
                accessibilityLabel="Rename view…"
                class={MENU_ITEM_ROW_CLASS}
                onSelect={() => { const view = selectedView(); if (view) editor.set({ id: view.id, name: view.name }); }}
              >
                <Text class="text-sm text-popover-foreground">Rename view…</Text>
              </MenuItem>
              <MenuItem
                accessibilityLabel="Delete view"
                class={`${MENU_ITEM_ROW_CLASS} text-destructive`}
                onSelect={() => {
                  const targetId = selectedView()!.id;
                  void persist((current) => current.filter((view) => view.id !== targetId)).then((ok) => {
                    if (ok && selectedId() === targetId) selectedId.set(null);
                  });
                }}
              >
                <Text class="text-sm text-destructive">Delete view</Text>
              </MenuItem>
            </>
          ) : null}
        </Menu>
      </View>
      <SettingsDialog
        open={editor() !== null}
        onClose={() => editor.set(null)}
        title={editor()?.id ? "Rename PR view" : "Save PR view"}
        description="Save your search, filters, and sort order on this device."
        width={420}
        testID="Save pull request view dialog"
        footer={
          <>
            <SettingsButton label="Cancel" onPress={() => editor.set(null)} />
            <SettingsButton label="Save" accessibilityLabel="Save view" tone="primary" disabled={nameError() !== null} onPress={() => void saveName()} />
          </>
        }
      >
        <View class="gap-2">
          <Text class="text-xs font-medium text-foreground">View name</Text>
          <Input
            autoFocus
            accessibilityLabel="View name"
            placeholder="PRs Requesting My Review"
            value={editor()?.name ?? ""}
            onChange={(event) => {
              const next = event.value.slice(0, PULL_REQUEST_VIEW_NAME_MAX_LENGTH);
              editor.update((current) => (current ? { ...current, name: next } : null));
            }}
            onSubmit={() => void saveName()}
            class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
          />
          {editor()?.name && nameError() ? <Text class="text-xs text-destructive">{nameError()}</Text> : null}
        </View>
      </SettingsDialog>
    </>
  );
}
