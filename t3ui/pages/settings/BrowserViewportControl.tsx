// The "Default browser viewport" control: the viewport select (Fill panel, Responsive, the device
// presets under "Standard"), and while the viewport is sized the width x height fields and Rotate
// (IntegrationsSettings.tsx, BrowserViewportSetting).
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsSelect } from "../../components/SettingsLayout";
import { settingValue, updateSetting } from "../../store";
import { SettingsIcon } from "./SettingsIcon";
import { VIEWPORT_PRESETS } from "./viewportPresets";
import {
  FILL_VALUE, FILL_VIEWPORT, RESPONSIVE_VALUE, parseViewport, rotateViewport, serializeViewport,
  viewportFromChoice, viewportFromDimension, viewportSelectLabel, viewportSelectValue,
  type ViewportSetting,
} from "./viewportSetting";

const FIELD = "browserDefaultViewport";

export const browserViewport = () => parseViewport(settingValue(FIELD));
export const setBrowserViewport = (next: ViewportSetting) => updateSetting(FIELD, serializeViewport(next));
export const browserViewportChanged = () => browserViewport()._tag !== FILL_VIEWPORT._tag;
export const resetBrowserViewport = () => setBrowserViewport(FILL_VIEWPORT);

const OPTIONS = [
  { value: FILL_VALUE, label: "Fill panel" },
  { value: RESPONSIVE_VALUE, label: "Responsive" },
  ...VIEWPORT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, group: "Standard", detail: preset.detail })),
];

function Dimension(props: { axis: "width" | "height"; label: string }) {
  const draft = signal("");
  let shown = "";
  const current = () => { const v = browserViewport(); return v._tag === "fill" ? (props.axis === "width" ? "1280" : "800") : String(v[props.axis]); };
  const text = () => { const now = current(); if (now !== shown) { shown = now; draft.set(now); } return draft(); };
  let timer: number | null = null;
  const commit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const next = viewportFromDimension(props.axis, draft(), browserViewport());
    if (next) setBrowserViewport(next); else draft.set(current());
  };
  return (
    <Input
      value={text()}
      onChange={(e: { value: string }) => { draft.set(e.value); if (timer) clearTimeout(timer); timer = setTimeout(commit, 600); }}
      onSubmit={commit}
      accessibilityLabel={props.label}
      class="h-7 w-20 rounded-lg border border-input bg-background px-2 text-right text-sm text-foreground"
    />
  );
}

export function BrowserViewportControl() {
  return (
    <View class="flex-row items-center justify-end gap-2">
      <SettingsSelect
        label="Default browser viewport"
        value={viewportSelectValue(browserViewport())}
        options={OPTIONS}
        compactWidth={176}
        onChange={(next) => { const choice = viewportFromChoice(next, browserViewport()); if (choice) setBrowserViewport(choice); }}
      />
      {browserViewport()._tag !== "fill" ? (
        <View class="flex-row items-center gap-1" testID={`Viewport (${viewportSelectLabel(browserViewport())})`}>
          <Dimension axis="width" label="Default viewport width" />
          <Text class="text-xs text-muted-foreground">×</Text>
          <Dimension axis="height" label="Default viewport height" />
          <View
            accessibilityLabel="Rotate"
            class="size-7 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
            onPress={() => { const v = browserViewport(); if (v._tag !== "fill") setBrowserViewport(rotateViewport(v)); }}
          >
            <SettingsIcon name="rotate-ccw" size={14} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
