// The Typography section of Appearance (TypographySettings.tsx): the font rows (an Interface font
// and a Monospace font with their previews, or the four separate ones), Word wrap, and the folded
// Advanced rows (Separate fonts, Font smoothing). Each font row is a family field and a size select;
// what is saved is what typography.ts applies.
import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingResetButton, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "../../components/SettingsLayout";
import { settingValue, updateSetting } from "../../store";
import {
  cssFontFamilies, FONT_DEFAULTS, FONT_LIMITS, familyField, fontFamilySetting, fontSizeSetting, resolvedFamily, resolvedSize, separateFonts, sizeField, type FontKind,
} from "../../typography";
import { SettingsIcon } from "./SettingsIcon";
import { TargetRow } from "./TargetRow";
import { FontFamilyPicker } from "./FontFamilyPicker";
import { discoverInstalledFonts, fontEnumeration, isFontFamilyAvailable, isMonospaceFamilyList } from "../../desktop/fonts";

const PATH = "/settings/appearance";
const PROMPT_PREVIEW_TEXT =
  "Use $frontend-design to fix the flaky test in surface.test.ts (apps/web/src/terminal/ghostty/surface.test.ts) and align the header with SettingsPanels.tsx before shipping.";

const DEFAULT_LABEL: Record<FontKind, string> = { interface: "System default", prompt: "System default", code: "System monospace", terminal: "System monospace" };

/** The family field: a draft that commits when typing pauses, on Enter and when it loses focus; an empty one is the default. */
function FamilyField(props: { kind: FontKind; label: string }) {
  const stored = () => fontFamilySetting(props.kind);
  const draft = signal(stored());
  let committed = stored();
  let timer: ReturnType<typeof setTimeout> | null = null;
  effect(() => {
    const next = stored();
    if (next !== committed) { committed = next; draft.set(next); }
  });
  const commit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = draft().trim();
    if (next === committed) return;
    // TypographySettings acceptsFamily: a family that is not installed (or not fixed-width for code and terminal) is not saved.
    if (next.length > 0 && !acceptsFamily(next)) return;
    committed = next;
    updateSetting(familyField(props.kind), next);
  };
  const requireMonospace = props.kind === "code" || props.kind === "terminal";
  const acceptsFamily = (candidate: string) => isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamilyList(candidate));
  // draftPending (aria-invalid): a typed family that was not taken.
  const invalid = () => { const next = draft().trim(); return next.length > 0 && next !== stored().trim() && !acceptsFamily(next); };
  return (
    <Input
      accessibilityLabel={`${props.label} family`}
      testID={`${props.label} family = ${stored()}`}
      value={draft()}
      placeholder={DEFAULT_LABEL[props.kind]}
      autoCapitalize="none"
      autoCorrect={false}
      maxLength={200}
      onChange={(event) => { draft.set(event.value); if (timer) clearTimeout(timer); timer = setTimeout(commit, 400); }}
      onSubmit={commit}
      onBlur={commit}
      class={`h-8 w-44 rounded-lg border bg-background px-3 text-sm text-foreground ${invalid() ? "border-destructive" : "border-input"}`}
    />
  );
}

function sizeOptions(kind: FontKind) {
  const [min, max] = FONT_LIMITS[kind];
  return Array.from({ length: max - min + 1 }, (_, index) => ({ value: String(min + index), label: `${min + index} px` }));
}

/** FontFamilySettingsRow: the family field, the size select and the preview under them. */
function FontRow(props: { kind: FontKind; title: string; description: string; preview?: any; first?: boolean; id: string }) {
  void discoverInstalledFonts();
  const kind = props.kind;
  const changed = () => fontFamilySetting(kind) !== "" || fontSizeSetting(kind) !== FONT_DEFAULTS[kind];
  return (
    <TargetRow path={PATH} id={props.id} title={props.title} first={props.first}>
      <SettingsRow
        title={props.title}
        description={props.description}
        resetAction={
          <View>
            {changed() ? (
              <SettingResetButton label={props.title.toLowerCase()} onPress={() => { updateSetting(familyField(kind), ""); updateSetting(sizeField(kind), FONT_DEFAULTS[kind]); }} />
            ) : null}
          </View>
        }
        control={
          <View class="flex-row items-center gap-2">
            {fontEnumeration().status === "granted"
              ? <FontFamilyPicker ariaLabel={`${props.title} family`} defaultFamily={DEFAULT_LABEL[kind]} selectedFamily={fontFamilySetting(kind).trim()} requireMonospace={kind === "code" || kind === "terminal"} onSelect={(family) => updateSetting(familyField(kind), family)} />
              : <FamilyField kind={kind} label={props.title} />}
            <SettingsSelect
              label={`${props.title.replace(/ font$/i, "")} font size`}
              value={String(fontSizeSetting(kind))}
              options={sizeOptions(kind)}
              onChange={(next) => updateSetting(sizeField(kind), Number(next))}
            />
          </View>
        }
      />
      {props.preview ?? null}
    </TargetRow>
  );
}

const PREVIEW_BOX = "mx-4 mt-1 mb-3 rounded-lg border border-border bg-background px-3 py-2";

function PromptPreview() {
  return (
    <View class={PREVIEW_BOX} accessibilityLabel="Prompt font preview">
      <Text class="text-foreground" style={{ fontFamily: resolvedFamily("prompt"), fontSize: resolvedSize("prompt") }}>{PROMPT_PREVIEW_TEXT}</Text>
    </View>
  );
}

function CodePreview() {
  const style = () => ({ fontFamily: resolvedFamily("code"), fontSize: resolvedSize("code") });
  return (
    <View class="mx-4 mt-1 mb-3 overflow-hidden rounded-lg border border-border bg-code-background" accessibilityLabel="Code font preview">
      <Text class="px-3 py-1 text-code-foreground" style={style()}>@@ -1,3 +1,3 @@</Text>
      <Text class="px-3 text-code-foreground" style={style()}>{" export function formatUser(user: User) {"}</Text>
      <Text class="bg-error-surface px-3 text-code-foreground" style={style()}>{"-  return user.name.toUpperCase();"}</Text>
      <Text class="px-3 text-code-foreground" style={style()}>{"+  return `${user.name} <${user.email}>`; // 0O 1lI"}</Text>
      <Text class="px-3 pb-1 text-code-foreground" style={style()}>{" }"}</Text>
    </View>
  );
}

function TerminalPreview() {
  const style = () => ({ fontFamily: resolvedFamily("terminal"), fontSize: resolvedSize("terminal") });
  return (
    <View class="mx-4 mt-1 mb-3 gap-1 rounded-lg border border-border bg-terminal-background px-3 py-2" accessibilityLabel="Terminal font preview">
      <Text class="text-terminal-foreground" style={style()}>{"→ t3code git:(main) ✗ vpr dev"}</Text>
      <Text class="text-terminal-foreground" style={style()}>{"  VITE v7.1.1  ready in 1.24s"}</Text>
      <Text class="text-terminal-foreground" style={style()}>{"  →  Local:    http://127.0.0.1:5173/"}</Text>
      <Text class="text-terminal-foreground" style={style()}>{"  ✓ 85 passed   △ 2 warnings   ✗ 0 failed"}</Text>
    </View>
  );
}

function SwitchRow(props: { id: string; title: string; description: string; field: string; fallback: boolean; label: string; first?: boolean }) {
  const value = () => (typeof settingValue(props.field) === "boolean" ? (settingValue(props.field) as boolean) : props.fallback);
  return (
    <TargetRow path={PATH} id={props.id} title={props.title} first={props.first}>
      <SettingsRow
        title={props.title}
        description={props.description}
        resetAction={<View>{value() !== props.fallback ? <SettingResetButton label={props.title.toLowerCase()} onPress={() => updateSetting(props.field, props.fallback)} /> : null}</View>}
        control={<SettingsSwitch label={props.label} checked={value()} onChange={(next) => updateSetting(props.field, next)} />}
      />
    </TargetRow>
  );
}

const advancedOpen = signal(false);

export function TypographySection() {
  return (
    <SettingsSection title="Typography">
      {separateFonts() ? (
        <>
          <FontRow id="interface-font" kind="interface" title="Interface font" description="Everything outside code blocks and the terminal." first />
          <FontRow id="prompt-font" kind="prompt" title="Prompt font" description="Only the box you write prompts in. Mono works well here." preview={<PromptPreview />} />
          <FontRow id="code-font" kind="code" title="Code font" description="Code blocks, diffs, and file previews." preview={<CodePreview />} />
          <FontRow id="terminal-font" kind="terminal" title="Terminal font" description="Terminal output, independent from code blocks and diffs." preview={<TerminalPreview />} />
        </>
      ) : (
        <>
          <FontRow id="interface-font" kind="interface" title="Interface font" description="Everything outside code blocks and the terminal." preview={<PromptPreview />} first />
          <FontRow id="code-font" kind="code" title="Monospace font" description="Code blocks, diffs, file previews, and the terminal." preview={<><CodePreview /><TerminalPreview /></>} />
        </>
      )}
      <SwitchRow id="word-wrap" title="Word wrap" description="Wrap long lines in code blocks, diffs, and file previews by default." field="wordWrap" fallback label="Wrap code, diffs, and file previews by default" />
      <View>
        <View class="h-px bg-border-50" />
        <View role="button" accessibilityLabel="Advanced" onPress={() => advancedOpen.set(!advancedOpen())} class="min-h-10 flex-row items-center gap-1.5 px-4">
          <View class={advancedOpen() ? "rotate-90" : ""}><SettingsIcon name="chevron-right" size={14} /></View>
          <Text class="text-xs font-medium text-muted-foreground">Advanced</Text>
        </View>
        {advancedOpen() ? (
          <View>
            <TargetRow path={PATH} id="separate-fonts" title="Separate fonts">
              <SettingsRow
                title="Separate fonts"
                description="Set the prompt, code, and terminal fonts separately instead of one monospace font."
                control={<SettingsSwitch label="Separate fonts" checked={separateFonts()} onChange={(next) => updateSetting("typographyAdvanced", next)} />}
              />
            </TargetRow>
            <SwitchRow id="font-smoothing" title="Font smoothing" description="Use thinner grayscale text smoothing instead of the macOS default." field="fontSmoothing" fallback label="Font smoothing" />
          </View>
        ) : null}
      </View>
    </SettingsSection>
  );
}
