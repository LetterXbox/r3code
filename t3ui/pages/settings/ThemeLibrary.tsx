// The Themes library of the Appearance panel, ported from ThemeSettings.tsx: a card per theme (the standard one, the
// built-in ones, the user's own and the community themes installed from Open VSX, whose variants share one card), "Create theme"
// and "Add theme" in the header, and per card Duplicate and, for the user's own, Edit, Export and Remove. Create and Edit open the
// editor (ThemeEditor.tsx), Add theme the import and community search dialog (ThemeImportDialog.tsx), and Remove a confirmation
// that lets a collection's variants be picked one by one.
//
// A card press uses the theme for both appearances it has; each preview circle uses it for that appearance only. The circles are
// ringed for the theme the window is painted in (themeSelection.ts: a pick is built into a new window by the launcher).
import { Clipboard, Image, signal, Text, token, View } from "nsh";
import { SettingsButton } from "../../components/SettingsLayout";
import { SettingsDialog } from "../../components/SettingsDialog";
import { showToast } from "../../components/toast/toastState";
import { useOverlayOpen } from "../../components/rightPanel/nativeOcclusion";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { ThemeSphere } from "./ThemeArt";
import sunIcon from "../../icons/sun.svg";
import moonIcon from "../../icons/moon.svg";
import paintbrush from "../../icons/paintbrush.svg";
import copyIcon from "../../icons/copy.svg";
import downloadIcon from "../../icons/download.svg";
import { THEME_CARDS, type ThemeAppearance, type ThemeCard, type ThemePreviewColors } from "../../themePreviews";
import { allThemeIds, asDefinition, customThemeCard, customThemes, removeCustomThemes, serializeThemeFile, themeFromCard, type CustomTheme } from "./customThemes";
import { environmentThemes } from "./environmentThemes";
import { SettingsIcon } from "./SettingsIcon";
import { ThemeEditorHost, openThemeEditor as openEditorFor, openThemeEditorSession } from "./ThemeEditor";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { groupCustomThemes, collectionVariantLabels } from "./themeLibraryLogic";
import { appearanceMode, cardById, chooseTheme, releaseTheme, themeForMode, useTheme } from "./themeSelection";
import { getThemeModes } from "./themePalette";

export { openEditorFor as openThemeEditor };

const importOpen = signal(false);
const removal = signal<{ theme: CustomTheme; collectionThemes: CustomTheme[] } | null>(null);

/** The appearance the editor starts from: the one the app is showing now. */
function currentAppearance(): ThemeAppearance {
  const mode = appearanceMode();
  return mode === "light" || mode === "dark" ? mode : "dark";
}

/** The Add a theme dialog opens from the library header (and from the palette). */
export function openThemeImport() {
  importOpen.set(true);
}

/** A copy of any card, opened in the editor (Duplicate). */
function duplicate(card: ThemeCard) {
  const theme = themeFromCard(card, currentAppearance(), allThemeIds());
  openThemeEditorSession({ editingThemeId: null, seedTheme: theme, seedName: theme.label, initialAppearance: theme.appearance });
}

const tip = (text: string) => <Text class="px-2 py-1 text-xs text-popover-foreground">{text}</Text>;

/** ThemePreviewCircles' button: the gradient sphere, ringed with a sun or moon badge while it is the active theme. */
function Circle(props: { colors: ThemePreviewColors; mode: ThemeAppearance; picked: boolean; label: string; onPress: () => void }) {
  return (
    <View
      class="size-[68px] items-center justify-center rounded-full p-1.5"
      accessibilityLabel={`Use ${props.label} ${props.mode} mode`}
      tooltip={tip(props.mode === "light" ? "Use for light mode only" : "Use for dark mode only")}
      testID={`${props.label} ${props.mode} (${props.picked ? "picked" : "unpicked"})`}
      onPress={props.onPress}
    >
      <View class="size-14 items-center justify-center overflow-hidden rounded-full border-2 border-background">
        <ThemeSphere colors={props.colors} mode={props.mode} />
      </View>
      {props.picked ? (
        <>
          <View class="absolute inset-0 rounded-full border-2 border-ring" />
          <View class="absolute bottom-0.5 right-0.5 size-5 items-center justify-center rounded-full border border-border-70 bg-background">
            <Image src={props.mode === "light" ? sunIcon : moonIcon} style={{ width: 12, height: 12, tintColor: token("foreground") }} />
          </View>
        </>
      ) : null}
    </View>
  );
}

function CardAction(props: { label: string; tip: string; onPress: () => void; children: any }) {
  return (
    <View
      class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
      accessibilityLabel={props.label}
      tooltip={tip(props.tip)}
      onPress={props.onPress}
    >
      {props.children}
    </View>
  );
}

/** Export: the theme file's JSON goes to the clipboard (this app has no save dialog yet). */
export function exportTheme(theme: CustomTheme) {
  void Clipboard.writeText(serializeThemeFile(asDefinition(theme))).then(
    () => { showToast({ type: "success", title: `Copied ${theme.id}.json to the clipboard.` }); },
    () => { showToast({ type: "error", title: "Couldn’t copy the theme file", description: "Try again." }); },
  );
}

interface VariantOption { themeIndex: number; label: string; mode: ThemeAppearance; colors: ThemePreviewColors; active: boolean }

function ThemeCardView(props: {
  card: ThemeCard;
  onEdit?: () => void;
  onDuplicate: () => void;
  onExport?: () => void;
  onRemove?: () => void;
  onUse: () => void;
  onUseMode: (mode: ThemeAppearance) => void;
  /** Variant navigation: the card shows one variant per appearance and a press on a circle opens the others. */
  variants?: { collectionLabel: string; options: VariantOption[]; onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void };
}) {
  const card = props.card;
  const picked = (mode: ThemeAppearance) => themeForMode(mode) === card.id;
  const active = () => picked("light") || picked("dark");
  const modes = card.previews.map((preview) => preview.mode);
  const open = signal<ThemeAppearance | null>(null);
  const cardTip = props.variants ? "Use the first variants for light and dark" : modes.length > 1 ? "Use for both light and dark" : `Use for ${modes[0]} mode only`;
  const groups = () =>
    (["light", "dark"] as const).map((mode) => {
      const options = props.variants?.options.filter((option) => option.mode === mode) ?? [];
      return { mode, options, selected: options.find((option) => option.active) ?? options[0] };
    });
  return (
    <View
      // The reference never tints a card (isActive is false for every one): the rings sit on the circles.
      class="min-w-[256px] flex-1 overflow-hidden rounded-xl border border-border-70 hover:bg-accent-50 transition-colors duration-150 ease-in-out"
      style={{ backgroundColor: tokenAlpha("card", 0.6) }}
      tooltip={tip(cardTip)}
      onPress={props.onUse}
      testID={`Theme card ${card.id} (${active() ? "active" : "inactive"})`}
    >
      {props.variants ? (
        // No role/accessibilityLabel here: this wrapper sits directly under the card's onPress={props.onUse} with no
        // Scroll between them, and nsh-runtime-bugs.md #7 collapses a labelled, roleless View in that position into
        // a leaf that drops its pressable (Circle) descendants from both the AX tree and pointer hit-testing.
        <View class="min-h-20 flex-row items-start justify-center gap-6 px-3 pt-2">
          <Each of={groups()} key={(group) => group.mode}>
            {(group) =>
              group().selected ? (
                <View class="items-center gap-0.5">
                  <Circle
                    colors={group().selected!.colors}
                    mode={group().mode}
                    picked={group().selected!.active}
                    label={`${props.variants!.collectionLabel} ${group().selected!.label}`}
                    onPress={() => {
                      props.variants!.onSelectAndUse(group().selected!.themeIndex, group().mode);
                      open.set(group().options.length > 1 && open() !== group().mode ? group().mode : null);
                    }}
                  />
                  <View class="max-w-24 flex-row items-center gap-1">
                    <Text class="text-2xs font-medium text-foreground truncate">{group().selected!.label}</Text>
                    {group().options.length > 1 ? <Text class="rounded-full bg-muted px-1 text-3xs text-muted-foreground">{`+${group().options.length - 1}`}</Text> : null}
                  </View>
                  {open() === group().mode ? (
                    // Same reason as the wrapper above: no role/accessibilityLabel, same unmitigated-ancestor bug.
                    <View class="flex-row flex-wrap justify-center gap-1">
                      <Each of={group().options} key={(option) => option.label}>
                        {(option) => (
                          <View
                            class={option().active ? "size-7 items-center justify-center rounded-full border-2 border-ring bg-background" : "size-7 items-center justify-center rounded-full border border-border-70 bg-background"}
                            accessibilityLabel={`Use ${option().label} for ${group().mode} mode${option().active ? ", currently active" : ""}`}
                            tooltip={tip(`Use ${option().label} for ${group().mode} mode`)}
                            onPress={() => { props.variants!.onSelectAndUse(option().themeIndex, group().mode); open.set(null); }}
                          >
                            <View class="size-5 overflow-hidden rounded-full"><ThemeSphere colors={option().colors} mode={group().mode} /></View>
                          </View>
                        )}
                      </Each>
                    </View>
                  ) : null}
                </View>
              ) : null
            }
          </Each>
        </View>
      ) : (
        <View class="min-h-16 flex-row items-center justify-center gap-2.5 px-3 pt-3">
          <Each of={card.previews} key={(p) => p.mode}>
            {(preview) => <Circle colors={preview().colors} mode={preview().mode} picked={picked(preview().mode)} label={card.label} onPress={() => props.onUseMode(preview().mode)} />}
          </Each>
        </View>
      )}
      <View class="flex-row items-center gap-1 px-3 pb-3 pt-2">
        <Text class="min-w-0 flex-1 text-sm font-medium text-foreground truncate" accessibilityLabel={props.variants ? `Use ${props.variants.collectionLabel}, ${card.label} variant` : `Use ${card.label} theme`} onPress={props.onUse}>
          {props.variants?.collectionLabel ?? card.label}
        </Text>
        <CardAction label={`Duplicate ${card.label}`} tip="Duplicate theme" onPress={props.onDuplicate}><Image src={copyIcon} style={{ width: 14, height: 14 }} /></CardAction>
        {props.onEdit ? <CardAction label={`Edit ${card.label}`} tip="Edit theme" onPress={props.onEdit}><SettingsIcon name="pencil" size={14} /></CardAction> : null}
        {props.onExport ? <CardAction label={`Export ${card.label}`} tip="Export theme file" onPress={props.onExport}><Image src={downloadIcon} style={{ width: 14, height: 14 }} /></CardAction> : null}
        {props.onRemove ? (
          <CardAction label={props.variants ? `Remove themes from ${props.variants.collectionLabel}` : `Remove ${card.label}`} tip={props.variants ? "Remove themes" : "Remove theme"} onPress={props.onRemove}>
            <SettingsIcon name="trash-2" size={14} />
          </CardAction>
        ) : null}
      </View>
    </View>
  );
}

/** A built-in or the standard card. */
function BuiltInCard(props: { card: ThemeCard }) {
  return <ThemeCardView card={props.card} onDuplicate={() => duplicate(props.card)} onUse={() => useTheme(props.card)} onUseMode={(mode) => chooseTheme(mode, props.card.id)} />;
}

/** One custom theme, or a collection of them with a variant shown at a time (CustomThemeCollectionCard). */
function CustomCard(props: { themes: CustomTheme[] }) {
  const themes = () => props.themes;
  const variantIndex = signal(Math.max(0, themes().findIndex((theme) => getThemeModes(asDefinition(theme)).some((mode) => themeForMode(mode) === theme.id))));
  const safeIndex = () => Math.min(variantIndex(), themes().length - 1);
  const theme = () => themes()[safeIndex()]!;
  const labels = () => collectionVariantLabels(themes());
  const several = () => themes().length > 1;
  const selectDefaults = () => {
    if (!several()) { useTheme(customThemeCard(theme())); return; }
    const light = themes().find((candidate) => getThemeModes(asDefinition(candidate)).includes("light"));
    const dark = themes().find((candidate) => getThemeModes(asDefinition(candidate)).includes("dark"));
    if (light) chooseTheme("light", light.id);
    if (dark) chooseTheme("dark", dark.id);
    variantIndex.set(0);
  };
  const variants = () =>
    several()
      ? {
          collectionLabel: theme().collection?.label ?? theme().label,
          options: themes().flatMap((variant, themeIndex) =>
            customThemeCard(variant).previews.map((preview): VariantOption => ({ themeIndex, label: labels()[themeIndex] ?? variant.label, mode: preview.mode, colors: preview.colors, active: themeForMode(preview.mode) === variant.id })),
          ),
          onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => {
            const selected = themes()[themeIndex];
            if (!selected) return;
            variantIndex.set(themeIndex);
            chooseTheme(mode, selected.id);
          },
        }
      : undefined;
  return (
    <ThemeCardView
      card={customThemeCard(theme())}
      variants={variants()}
      onDuplicate={() => duplicate(customThemeCard(theme()))}
      onEdit={() => openEditorFor(theme(), false)}
      onExport={() => exportTheme(theme())}
      onRemove={() => removal.set({ theme: theme(), collectionThemes: themes() })}
      onUse={selectDefaults}
      onUseMode={(mode) => chooseTheme(mode, theme().id)}
    />
  );
}

// --- removal ----------------------------------------------------------------

function RemoveThemesDialog(props: { theme: CustomTheme; collectionThemes: CustomTheme[]; onClose: () => void }) {
  const canRemoveCollection = props.collectionThemes.length > 1;
  const chosen = signal<string[]>(canRemoveCollection ? [] : [props.theme.id]);
  const label = props.theme.collection?.label ?? props.theme.label;
  useOverlayOpen(() => true, "remove themes");
  const confirmRemove = () => {
    const ids = chosen();
    if (ids.length === 0) return;
    try {
      for (const id of ids) releaseTheme(id);
      removeCustomThemes(ids);
    } catch {
      showToast({ type: "error", title: "Couldn’t remove theme", description: "Try again." });
      return;
    }
    props.onClose();
  };
  return (
    <SettingsDialog
      open
      onClose={props.onClose}
      title={canRemoveCollection ? `Remove themes from “${label}”?` : `Remove “${props.theme.label}”?`}
      description={canRemoveCollection ? "Select the variants you want to remove. You can restore them by importing the extension again." : "You can bring it back anytime by importing its JSON file."}
      testID="Remove themes"
      footer={
        <>
          <SettingsButton label="Cancel" accessibilityLabel="Cancel remove theme" onPress={props.onClose} />
          <SettingsButton
            label={canRemoveCollection ? `Remove selected${chosen().length > 0 ? ` (${chosen().length})` : ""}` : "Remove theme"}
            tone="destructive"
            disabled={chosen().length === 0}
            onPress={confirmRemove}
          />
        </>
      }
    >
      {canRemoveCollection ? (
        <View class="flex-row flex-wrap gap-2">
          <Each of={props.collectionThemes} key={(item) => item.id}>
            {(item) => {
              const checked = () => chosen().includes(item().id);
              return (
                <View
                  class={checked() ? "relative min-h-28 min-w-[180px] flex-1 items-center justify-center gap-2 rounded-lg border border-ring bg-accent-50 p-3" : "relative min-h-28 min-w-[180px] flex-1 items-center justify-center gap-2 rounded-lg border border-border-70 bg-muted-30 p-3"}
                  role="checkbox"
                  accessibilityLabel={`Remove ${item().label}`}
                  onPress={() => chosen.update((current) => (current.includes(item().id) ? current.filter((id) => id !== item().id) : [...current, item().id]))}
                >
                  <View class={checked() ? "absolute right-2 top-2 size-4 items-center justify-center rounded-sm border border-primary bg-primary" : "absolute right-2 top-2 size-4 rounded-sm border border-input bg-background"}>
                    {checked() ? <SettingsIcon name="check" size={10} tint={String(token("primary-foreground"))} /> : null}
                  </View>
                  <View class="min-h-12 flex-row items-center justify-center gap-1">
                    <Each of={customThemeCard(item()).previews} key={(preview) => preview.mode}>
                      {(preview) => <View class="size-11 items-center justify-center"><View class="size-8 overflow-hidden rounded-full"><ThemeSphere colors={preview().colors} mode={preview().mode} /></View></View>}
                    </Each>
                  </View>
                  <Text class="max-w-full text-sm font-medium text-foreground truncate">{item().label}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      ) : null}
    </SettingsDialog>
  );
}

// --- library ----------------------------------------------------------------

export function ThemeLibrary() {
  const create = () => {
    const seed = cardById(themeForMode(currentAppearance()));
    const theme = themeFromCard(seed, currentAppearance(), allThemeIds());
    // Create theme starts from the theme in use, as the web seeds it from the active theme, with no name yet.
    openThemeEditorSession({ editingThemeId: null, seedTheme: theme, seedName: null, initialAppearance: currentAppearance() });
  };
  const header = (
    <View class="min-h-8 flex-row flex-wrap items-center justify-between gap-3 px-4 pt-5">
      <Text class="text-base font-semibold text-foreground">Themes</Text>
      <View class="flex-row items-center gap-2">
        <View accessibilityLabel="Create theme" onPress={create} class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <Image src={paintbrush} style={{ width: 14, height: 14 }} />
          <Text class="text-xs font-medium text-foreground">Create theme</Text>
        </View>
        <View accessibilityLabel="Add theme" onPress={() => importOpen.set(true)} class="h-7 flex-row items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out">
          <SettingsIcon name="plus" size={14} />
          <Text class="text-xs font-medium text-foreground">Add theme</Text>
        </View>
      </View>
    </View>
  );
  return (
    <View class="gap-3">
      {header}
      <View class="flex-row flex-wrap gap-2">
        <Each of={THEME_CARDS} key={(card) => card.id}>{(card) => <BuiltInCard card={card()} />}</Each>
        {/* ThemeSettings.tsx: the environment's published themes, except ids a saved theme already has. */}
        <Each of={environmentThemes().filter((theme) => !customThemes().some((own) => own.id === theme.id))} key={(theme: CustomTheme) => `${theme.id}:${JSON.stringify(theme.colors)}:${JSON.stringify(theme.variants ?? null)}`}>
          {(theme) => <BuiltInCard card={customThemeCard(theme())} />}
        </Each>
        <Each of={groupCustomThemes(customThemes())} key={([key, group]) => `${key}:${group.map((theme) => theme.id + theme.label + JSON.stringify(theme.colors) + JSON.stringify(theme.variants ?? null)).join("|")}`}>
          {(entry) => <CustomCard themes={entry()[1]} />}
        </Each>
      </View>
      {importOpen() ? <ThemeImportDialog onClose={() => importOpen.set(false)} /> : null}
      {removal() ? <RemoveThemesDialog theme={removal()!.theme} collectionThemes={removal()!.collectionThemes} onClose={() => removal.set(null)} /> : null}
      <ThemeEditorHost />
    </View>
  );
}
