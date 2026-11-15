// The theme editor, ported from ThemeEditorPanel.tsx and ThemeEditorHost.tsx: a name, the appearance being edited, and
// the colours either as two (a background and an accent, the rest derived from them) or, in advanced mode, every role
// grouped as the web groups them (Foundation, Brand & content, Search, Context, Status) with a filter. Saving makes a
// new theme, saves an edit, or merges into the theme of the same name that lacks this appearance's palette.
//
// A capable native host previews the draft without persisting it; closing restores the saved theme.
import { cleanup, computed, effect, keymap, Overlay, Scroll, signal, Text, View, windowSize } from "nsh";
import type { MouseEvent, PanEvent } from "nsh";
import { DialogInput } from "../../components/DialogInput";
import { SettingsButton, SettingsSwitch } from "../../components/SettingsLayout";
import { Icon } from "../../components/Icons";
import { dropdownGlassAmount, glassOutline, tokenOver } from "../../components/composer/tokenColor";
import { clampThemeEditorAnchor, resizeThemeEditor, type ThemeEditorPoint, type ThemeEditorSize } from "./themeEditorPosition";
import { showToast } from "../../components/toast/toastState";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { allThemeIds, asDefinition, copyIdentity, customThemeById, customThemeCard, customThemes, installCustomTheme, removeCustomThemes, updateCustomTheme, type CustomTheme } from "./customThemes";
import {
  appearanceLockReason, applyColorEdit, getManagedEditorColors, getThemeEditorColorFamily, getThemeRoleLabel, initialEditorDraft, mergeTargetFor, planThemeSave, setAdvanced,
  THEME_EDITOR_ROLE_GROUPS, THEME_EDITOR_SIMPLE_ROLES, type ColorFamily, type EditorDraft, type EditorSession,
} from "./themeEditorLogic";
import { applyHalves, activeThemeIds } from "./themeSelection";
import { getThemeModes, isThemeColor, themeColorToHex, type ThemeAppearance, type ThemeColorRole } from "./themePalette";
import { setEditorThemePreview } from "./themeRequest";
import { ThemeColorPicker } from "./ThemeColorPicker";

const session = signal<EditorSession | null>(null);
let sessionCount = 0;
const sessionId = signal(0);

export const themeEditorOpen = () => session() !== null;
export function openThemeEditorSession(next: EditorSession) {
  sessionId.set(++sessionCount);
  session.set(next);
}
export function closeThemeEditor() {
  setEditorThemePreview(null);
  session.set(null);
}

/** Opens the editor on a copy of `theme` (`isNew`) or on the saved theme itself. */
export function openThemeEditor(theme: CustomTheme, isNew: boolean) {
  openThemeEditorSession(
    isNew
      ? { editingThemeId: null, seedTheme: theme, seedName: theme.label, initialAppearance: theme.appearance }
      : { editingThemeId: theme.id, seedTheme: null, seedName: null, initialAppearance: theme.appearance },
  );
}

/** What the editor does once a theme is saved (ThemeEditorHost's handleSaved): make it the theme in use, and say so. */
function onSaved(saved: CustomTheme, context: { created: boolean; mergedAppearance: ThemeAppearance | null }) {
  const modes = getThemeModes(asDefinition(saved));
  if (context.mergedAppearance) {
    applyHalves(saved.id, modes);
    showToast({ type: "success", title: `${saved.label} updated`, description: `Its ${context.mergedAppearance} palette was added.` });
    return;
  }
  if (!context.created) {
    const wasActive = activeThemeIds().includes(saved.id);
    showToast({ type: "success", title: `${saved.label} saved`, description: wasActive ? "Your changes are now active." : "Your changes are saved." });
    return;
  }
  applyHalves(saved.id, modes);
  showToast({ type: "success", title: `${saved.label} created`, description: "It’s now active." });
}

function ColorField(props: { family: { label: string; role: ThemeColorRole }; value: () => string; onEdit: (value: string) => void; onEditStart: () => void; onEditCancel: () => void; onPickerOpenChange: (open: boolean) => void }) {
  const draft = signal<string | null>(null);
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  const shown = () => draft() ?? (themeColorToHex(props.value()) ?? props.value());
  const commit = () => {
    if (editTimer !== null) clearTimeout(editTimer);
    editTimer = null;
    const text = draft();
    draft.set(null);
    if (text !== null && isThemeColor(text.trim())) props.onEdit(text.trim());
  };
  return (
    <View class="min-h-8 flex-row items-center gap-2" role="group" accessibilityLabel={props.family.label}>
      <Text class="min-w-0 flex-1 text-sm text-foreground">{props.family.label}</Text>
      <ThemeColorPicker label={props.family.label} value={() => draft() !== null && isThemeColor((draft() ?? "").trim()) ? draft()! : props.value()} onChange={props.onEdit} onEditStart={props.onEditStart} onEditCancel={props.onEditCancel} onOpenChange={props.onPickerOpenChange} />
      <DialogInput
        value={shown()}
        accessibilityLabel={`${props.family.label} hex value`}
        autoCapitalize="none"
        autoCorrect={false}
        onChange={(event) => {
          draft.set(event.value);
          // Do not apply a valid intermediate value (such as #123 while typing
          // #123456) until typing pauses: repainting can otherwise replace the
          // field and interrupt input.
          if (editTimer !== null) clearTimeout(editTimer);
          const value = event.value.trim();
          editTimer = isThemeColor(value) ? setTimeout(() => { editTimer = null; props.onEdit(value); }, 200) : null;
        }}
        onBlur={commit}
        onSubmit={commit}
        class="h-8 w-36 rounded-lg border border-input bg-background px-2.5 font-mono text-xs text-foreground"
      />
    </View>
  );
}

export function ThemeEditorHost() {
  return <>{session() ? <ThemeEditorDialog session={session()!} /> : null}</>;
}

function ThemeEditorDialog(props: { session: EditorSession }) {
  const editing = props.session.editingThemeId ? customThemeById(props.session.editingThemeId) : null;
  const draft = signal<EditorDraft>(initialEditorDraft(props.session, editing));
  const previewId = (() => {
    const used = new Set(allThemeIds());
    let id = "r3-editor-preview";
    let suffix = 0;
    while (used.has(id)) id = `r3-editor-preview-${++suffix}`;
    return id;
  })();
  effect(() => {
    const current = draft();
    setEditorThemePreview({ id: previewId, label: "Editor preview", appearance: current.activeAppearance, colors: current.colorsByAppearance[current.activeAppearance] });
  });
  effect(() => () => setEditorThemePreview(null));
  const failure = signal("");
  const query = signal("");
  const position = signal<ThemeEditorPoint | null>(null);
  const panelHeight = signal(0);
  const customSize = signal<ThemeEditorSize | null>(null);
  const moving = signal(false);
  let gesture: { kind: "move" | "resize"; anchor: ThemeEditorPoint; size: ThemeEditorSize; start: ThemeEditorPoint | null } | null = null;
  let pointer: (ThemeEditorPoint & { at: number }) | null = null;
  const panelWidth = () => Math.min(customSize()?.width ?? 416, Math.max(0, windowSize().width - 16));
  const anchor = () => clampThemeEditorAnchor(position() ?? { x: windowSize().width - 16, y: windowSize().height - 16 }, windowSize(), { width: panelWidth(), height: panelHeight() });
  const move = (delta: ThemeEditorPoint) => {
    if (!gesture) return;
    if (gesture.kind === "resize") {
      const result = resizeThemeEditor({ origin: { x: gesture.anchor.x - gesture.size.width, y: gesture.anchor.y - gesture.size.height }, size: gesture.size, delta, window: windowSize() });
      customSize.set(result.size);
      position.set(result.anchor);
    } else position.set(clampThemeEditorAnchor({ x: gesture.anchor.x + delta.x, y: gesture.anchor.y + delta.y }, windowSize(), gesture.size));
  };
  const begin = (kind: "move" | "resize") => { gesture = { kind, anchor: anchor(), size: { width: panelWidth(), height: panelHeight() }, start: pointer && Date.now() - pointer.at < 1000 ? pointer : null }; moving.set(true); };
  const end = (event: PanEvent) => { if (!event.cancelled) move(event.translation); gesture = null; moving.set(false); };
  const follow = (event: MouseEvent) => {
    const point = event.pagePosition;
    if (!gesture) { pointer = { ...point, at: Date.now() }; return; }
    if (event.pressedButton === null) { gesture = null; moving.set(false); return; }
    if (!gesture.start) { gesture.start = point; return; }
    move({ x: point.x - gesture.start.x, y: point.y - gesture.start.y });
  };
  // Settings also owns Escape; the editor must dismiss first while it is open.
  const pickerOpen = signal(false);
  let pickerCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const setPickerOpen = (open: boolean) => {
    clearTimeout(pickerCloseTimer);
    if (open) pickerOpen.set(true);
    else pickerCloseTimer = setTimeout(() => { pickerCloseTimer = undefined; pickerOpen.set(false); }, 0);
  };
  cleanup(() => clearTimeout(pickerCloseTimer));
  effect(() => { if (!pickerOpen()) return keymap.bind({ escape: closeThemeEditor }, { when: "always" }); });
  useOverlayOpen(() => true, "theme editor");
  const update = (change: (current: EditorDraft) => EditorDraft) => draft.update(change);
  let pickerSnapshot: EditorDraft | null = null;
  const beginColorEdit = () => { pickerSnapshot = draft(); };
  const cancelColorEdit = () => { if (pickerSnapshot) draft.set(pickerSnapshot); pickerSnapshot = null; };
  const isEditing = editing !== null;
  const mergeTarget = () => (isEditing ? mergeTargetFor(draft().name, editing, customThemes().filter((theme) => theme.id !== editing!.id)) : mergeTargetFor(draft().name, null, customThemes()));
  const submit = () => {
    const result = planThemeSave(draft(), editing, customThemes());
    if ("error" in result) { failure.set(result.error); return; }
    const { plan } = result;
    try {
      if (plan.install) installCustomTheme(plan.saved);
      else updateCustomTheme(plan.saved);
      if (plan.retire) {
        try { removeCustomThemes([plan.retire.id]); } catch (cause) {
          // Restore the pre-merge target on a failed retirement; leaving the merge would collide on retry.
          if (plan.mergeTarget) { try { updateCustomTheme(plan.mergeTarget); } catch { /* the original failure is the one reported */ } }
          throw cause;
        }
      }
    } catch (cause) {
      failure.set(cause instanceof Error ? cause.message : isEditing ? "Could not save the theme." : "Could not create the theme.");
      return;
    }
    onSaved(plan.saved, { created: plan.created, mergedAppearance: plan.mergedAppearance });
    closeThemeEditor();
  };

  const colors = () => draft().colorsByAppearance[draft().activeAppearance];
  const advanced = computed(() => draft().isAdvanced);
  const families = (group: { families: ReadonlyArray<ColorFamily> }) => {
    const text = query().trim().toLowerCase();
    return group.families.filter((family) => !text || [family.label, ...family.roles.map((role) => getThemeRoleLabel(role))].join(" ").toLowerCase().includes(text));
  };
  const visibleGroups = () => THEME_EDITOR_ROLE_GROUPS.map((group) => ({ ...group, families: families(group) })).filter((group) => group.families.length > 0);

  const primaryLabel = () => (isEditing ? (mergeTarget() ? `Merge into “${mergeTarget()!.label}”` : "Save changes") : mergeTarget() ? `Add ${draft().activeAppearance} palette` : "Create theme");
  return (
    <Overlay anchor={anchor()} placement="top" align="end" margin={8} onCancel={() => { if (!pickerOpen()) closeThemeEditor(); }}>
      <View testID="Theme editor" accessibilityLabel={isEditing ? "Edit theme" : "Create theme"} onLayout={(event) => { const height = event.bounds.size.height; if (height !== panelHeight()) panelHeight.set(height); }} class="relative min-h-0 flex-col overflow-hidden rounded-xl border shadow-lg" style={{ width: panelWidth(), ...(customSize() ? { height: customSize()!.height } : {}), maxHeight: Math.max(0, windowSize().height - (customSize() ? 16 : 96)), backgroundColor: tokenOver("popover", "background", dropdownGlassAmount()), borderColor: glassOutline() }}>
        <View class="shrink-0 flex-row items-center gap-2 border-b border-border-70 px-3 py-2" role="button" accessibilityLabel="Move theme editor" onMouseMove={follow} onPress={() => {}} onPanStart={() => begin("move")} onPanEnd={end}>
          <Text class="shrink-0 text-sm font-medium text-foreground">{isEditing ? "Edit theme" : "Create theme"}</Text>
          <Text class="min-w-0 flex-1 truncate text-xs text-muted-foreground">Select a color below</Text>
          <View role="button" accessibilityLabel="Close theme editor" onPress={closeThemeEditor} class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent"><Icon name="x" size={14} /></View>
        </View>
        <Scroll class="min-h-0 shrink" contentClass="gap-4 p-3">
      <View class="flex-row items-center gap-3">
        <Text class="w-1/3 text-sm font-medium text-foreground">Theme name</Text>
        <DialogInput
          value={draft().name}
          accessibilityLabel="Theme name"
          placeholder={isEditing ? "Theme name" : "e.g. Aurora"}
          onChange={(event) => { update((current) => ({ ...current, name: event.value })); failure.set(""); }}
          class="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground"
        />
      </View>
      {failure() ? <Text class="text-sm text-destructive-foreground" accessibilityLabel="Theme editor error">{failure()}</Text> : null}
      <View class="flex-row items-center gap-3">
        <Text class="w-1/3 text-sm font-medium text-foreground">Appearance</Text>
        <View class="flex-row rounded-lg bg-segmented-track p-0.5" role="group" accessibilityLabel="Theme appearance">
          <Each of={["light", "dark"] as const} key={(mode) => mode}>
            {(mode) => {
              const lock = () => appearanceLockReason(mode(), editing, mergeTarget());
              return (
                <View
                  accessibilityLabel={`Theme appearance ${mode()}`}
                  aria-disabled={lock() !== null}
                  tooltip={lock() ? <Text class="max-w-64 px-2 py-1 text-xs text-popover-foreground">{lock()!}</Text> : undefined}
                  onPress={() => { if (lock() === null) update((current) => ({ ...current, activeAppearance: mode() })); }}
                  class={draft().activeAppearance === mode() ? "h-7 items-center justify-center rounded-md bg-segmented-active px-3" : "h-7 items-center justify-center rounded-md px-3 hover:bg-segmented-hover"}
                  style={{ opacity: lock() ? 0.5 : 1 }}
                >
                  <Text class="text-xs font-medium text-foreground">{mode() === "light" ? "Light" : "Dark"}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
      <View class="gap-3">
        <View class="flex-row items-start gap-3">
          <View class="w-1/3 gap-0.5">
            <Text class="text-sm font-medium text-foreground">Colors</Text>
            {advanced() ? null : <Text class="text-xs text-muted-foreground">Two colors, rest derived</Text>}
          </View>
          <View class="min-w-0 flex-1 flex-row items-center gap-3">
            {advanced() ? (
              <DialogInput value={query()} accessibilityLabel="Filter colors" placeholder="Filter colors" onChange={(event) => query.set(event.value)} class="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground" />
            ) : <View class="flex-1" />}
            <View class="flex-row items-center gap-2">
              <Text class="text-sm font-medium text-foreground">Advanced</Text>
              <SettingsSwitch label="Use advanced theme colors" checked={draft().isAdvanced} onChange={(next) => update((current) => setAdvanced(current, next, editing))} />
            </View>
          </View>
        </View>
        {advanced() ? (
          <View class="gap-5">
            <Each of={visibleGroups()} key={(group) => group.id}>
              {(group) => (
                <View class="gap-2" role="group" accessibilityLabel={group().title}>
                  <Text class="text-sm font-medium text-foreground">{group().title}</Text>
                  <Each of={group().families} key={(family) => family.id}>
                    {(family) => <ColorField family={family()} value={() => colors()[family().role]} onEdit={(value) => update((current) => applyColorEdit(current, family().role, value))} onEditStart={beginColorEdit} onEditCancel={cancelColorEdit} onPickerOpenChange={setPickerOpen} />}
                  </Each>
                </View>
              )}
            </Each>
            {visibleGroups().length === 0 ? <Text class="text-xs text-muted-foreground">No matches.</Text> : null}
          </View>
        ) : (
          <View class="gap-1">
            <Each of={THEME_EDITOR_SIMPLE_ROLES} key={(role) => role}>
              {(role) => <ColorField family={{ label: role() === "canvas" ? "Background" : "Accent", role: role() }} value={() => colors()[role()]} onEdit={(value) => update((current) => applyColorEdit(current, role(), value))} onEditStart={beginColorEdit} onEditCancel={cancelColorEdit} onPickerOpenChange={setPickerOpen} />}
            </Each>
          </View>
        )}
      </View>
        </Scroll>
        <View class="shrink-0 flex-row justify-end gap-2 border-t border-border-70 px-3 py-2">
          <SettingsButton label="Cancel" accessibilityLabel="Cancel theme editor" onPress={closeThemeEditor} />
          <SettingsButton label={primaryLabel()} accessibilityLabel="Save theme" tone="primary" disabled={draft().name.trim().length === 0} onPress={submit} />
        </View>
        <View class="absolute bottom-0 right-0 size-4" role="button" accessibilityLabel="Resize theme editor" onMouseMove={follow} onPress={() => {}} onPanStart={() => begin("resize")} onPanEnd={end} style={{ cursor: "nwse-resize" }} />
        {moving() ? <Overlay class="inset-0 z-50" accessibilityLabel="Moving theme editor" onMouseMove={follow} /> : null}
      </View>
    </Overlay>
  );
}

// Exposed for the tests and the palette command.
export { getManagedEditorColors, getThemeEditorColorFamily, copyIdentity, allThemeIds, customThemeCard };
void effect;
