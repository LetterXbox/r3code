// Appearance, ported from AppearanceSettingsPanel.tsx and ThemeSettings.tsx:
// the "Color scheme" tiles (System / Light / Dark), the "Themes" library of
// preview-circle cards, and the Typography fonts. The Interface and the
// remaining Typography rows come from the generated panel beside this.
//
// Light / dark / system re-themes the app at once (setColorScheme). A named theme, and the Contrast
// setting, are fixed into the palette when the UI bundle is built (theme.json, loaded from nsh.json "theme"
// at startup; checked against .nsh/types/nsh: `token(name)` is read only and there is no runtime setTheme),
// so picking one saves the choice and themeRequest.ts asks the launcher (tools/run_local.py) for a
// re-themed rebuild of the window; the theme shown as selected is the one the bundle was built with
// (builtTheme.ts). Progress does not insert a row into the settings layout.
import { Text, View } from "nsh";
import { SettingResetButton, SettingsRow, SettingsSlider, SettingsText } from "../../components/SettingsLayout";
import { settingValue, updateSetting } from "../../store";
import type { ThemeAppearance } from "../../themePreviews";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { ThemeWireframe } from "./ThemeArt";
import { appearanceMode, cardById, chooseAppearanceMode, chooseTheme, previewFor, themeForMode, type Mode } from "./themeSelection";
import { ThemeLibrary } from "./ThemeLibrary";

const MODES: Mode[] = ["system", "light", "dark"];
const MODE_LABEL: Record<Mode, string> = { system: "System", light: "Light", dark: "Dark" };
export { appearanceMode, chooseAppearanceMode, chooseTheme, themeForMode };

function ModeTile(props: { mode: Mode }) {
  const colors = (appearance: ThemeAppearance) => previewFor(cardById(themeForMode(appearance)), appearance);
  const active = () => appearanceMode() === props.mode;
  return (
    <View
      // The picked tile: `border-transparent bg-accent/30 ring-2 ring-inset ring-ring` (a 2pt ring, content unmoved).
      class={
        active()
          ? "flex-1 gap-1.5 rounded-xl border-2 border-ring p-[7px]"
          : "flex-1 gap-1.5 rounded-xl border border-border-70 p-2 hover:bg-accent-50 transition-colors duration-150 ease-in-out"
      }
      style={{ backgroundColor: active() ? tokenAlpha("accent", 0.3) : tokenAlpha("card", 0.6) }}
      accessibilityLabel={props.mode === "system" ? "Follow the system appearance" : `Use ${props.mode} mode`}
      testID={`Appearance mode ${props.mode} (${active() ? "on" : "off"})`}
      onPress={() => chooseAppearanceMode(props.mode)}
    >
      <View class="h-[8.75rem] overflow-hidden rounded-lg border border-border-60">
        <ThemeWireframe mode={props.mode} colors={colors} />
      </View>
      <View class="items-center">
        <Text class={active() ? "text-xs font-medium text-foreground" : "text-xs font-medium text-muted-foreground"}>
          {MODE_LABEL[props.mode]}
        </Text>
      </View>
    </View>
  );
}

const FONT_ROWS = [
  { title: "Interface font", description: "Everything outside code blocks and the terminal.", family: "fontFamilySans", size: "fontSizeInterface", min: 12, max: 20, fallback: 16, sizeLabel: "Interface font size" },
  { title: "Prompt font", description: "Only the box you write prompts in. Mono works well here.", family: "fontFamilyComposer", size: "fontSizePrompt", min: 12, max: 20, fallback: 14, sizeLabel: "Prompt font size" },
  { title: "Code font", description: "Code blocks, diffs, and file previews.", family: "fontFamilyCode", size: "fontSizeCode", min: 10, max: 18, fallback: 13, sizeLabel: "Code font size" },
  { title: "Terminal font", description: "Terminal output, independent from code blocks and diffs.", family: "fontFamilyTerminal", size: "fontSizeTerminal", min: 8, max: 20, fallback: 12, sizeLabel: "Terminal font size" },
];

function FontRow(props: { row: (typeof FONT_ROWS)[number] }) {
  const row = props.row;
  const family = () => String(settingValue(row.family) ?? "");
  const size = () => (typeof settingValue(row.size) === "number" ? (settingValue(row.size) as number) : row.fallback);
  const changed = () => family() !== "" || size() !== row.fallback;
  return (
    <SettingsRow
      title={row.title}
      description={row.description}
      resetAction={
        <View>
          {changed() ? (
            <SettingResetButton
              label={row.title.toLowerCase()}
              onPress={() => {
                updateSetting(row.family, "");
                updateSetting(row.size, row.fallback);
              }}
            />
          ) : null}
        </View>
      }
      control={
        <View class="items-end gap-2">
          <SettingsText label={row.title} value={family()} placeholder="Default" onChange={(next) => updateSetting(row.family, next.trim())} />
          <SettingsSlider label={row.sizeLabel} value={size()} min={row.min} max={row.max} step={1} unit=" px" onChange={(next) => updateSetting(row.size, next)} />
        </View>
      }
    />
  );
}

/** The four font rows that open the Typography section (TypographySettings.tsx). */
export function FontRows() {
  return (
    <Each of={FONT_ROWS} key={(row) => row.title}>
      {(row) => (
        <View>
          <FontRow row={row()} />
          <View class="h-px bg-border-50" />
        </View>
      )}
    </Each>
  );
}

export function AppearanceSettings() {
  return (
    <>
      <View class="gap-3">
        <View class="min-h-7 justify-center px-4">
          <Text class="text-base font-semibold text-foreground">Color scheme</Text>
        </View>
        <View class="flex-row gap-3" role="group" accessibilityLabel="Appearance mode">
          <Each of={MODES} key={(mode) => mode}>{(mode) => <ModeTile mode={mode()} />}</Each>
        </View>
        <ThemeLibrary />
      </View>
    </>
  );
}
