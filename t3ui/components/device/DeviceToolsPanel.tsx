// DeviceToolsPanel.tsx (components/device/DeviceToolsPanel.tsx): the Tools pane beside a booted device. Every row is a
// `device.action` variant of the contract (packages/contracts/src/device.ts DeviceActionInput); the foreground app is the
// `foregroundApp` of `device.detail` (the reference also follows a hub subscription; see STATUS). The Accessibility overlay
// and the Event log stream from the device hub over a WebSocket and are not ported.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { Scroll } from "nsh";
import { SettingsButton, SettingsSelect, SettingsSwitch } from "../SettingsLayout";
import { DIcon } from "./DeviceIcons";
import { Spinner } from "../sidebar/Spinner";

export const TEXT_SIZES = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "extra-large", label: "Extra large" },
] as const;

export const COLOR_FILTERS = [
  { value: "none", label: "None" },
  { value: "grayscale", label: "Grayscale" },
  { value: "red-green", label: "Red / green (protanopia)" },
  { value: "green-red", label: "Green / red (deuteranopia)" },
  { value: "blue-yellow", label: "Blue / yellow (tritanopia)" },
] as const;

export const ORIENTATIONS = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape_left", label: "Landscape left" },
  { value: "portrait_upside_down", label: "Upside down" },
  { value: "landscape_right", label: "Landscape right" },
] as const;

export const IOS_PERMISSIONS = [
  { value: "camera", label: "Camera" }, { value: "microphone", label: "Microphone" }, { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" }, { value: "calendar", label: "Calendar" }, { value: "reminders", label: "Reminders" },
  { value: "location", label: "Location" }, { value: "notifications", label: "Notifications" }, { value: "motion", label: "Motion" },
  { value: "media-library", label: "Media library" }, { value: "faceid", label: "Face ID" },
] as const;

export const ANDROID_PERMISSIONS = [
  { value: "camera", label: "Camera" }, { value: "microphone", label: "Microphone" }, { value: "photos", label: "Photos" },
  { value: "contacts", label: "Contacts" }, { value: "calendar", label: "Calendar" }, { value: "location", label: "Location" },
  { value: "notifications", label: "Notifications" }, { value: "motion", label: "Physical activity" },
] as const;

export const LOCATION_PRESETS = [
  { label: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  { label: "New York", latitude: 40.7128, longitude: -74.006 },
  { label: "London", latitude: 51.5074, longitude: -0.1278 },
  { label: "Stockholm", latitude: 59.3293, longitude: 18.0686 },
  { label: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
] as const;

/** LocationSection's `valid`: both fields filled and within range. */
export function parseLocation(latitude: string, longitude: string): { latitude: number; longitude: number } | null {
  if (latitude.trim() === "" || longitude.trim() === "") return null;
  const parsed = { latitude: Number(latitude), longitude: Number(longitude) };
  if (!Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) return null;
  return Math.abs(parsed.latitude) <= 90 && Math.abs(parsed.longitude) <= 180 ? parsed : null;
}

export type DeviceActBody = Record<string, unknown> & { type: string };

function Section(props: { title: string; children: any }) {
  return (
    <View class="gap-2 border-b border-border px-3 py-2.5" accessibilityLabel={props.title}>
      <Text class="text-xs font-medium text-muted-foreground">{props.title}</Text>
      {props.children}
    </View>
  );
}

function Row(props: { label: string; children: any }) {
  return (
    <View class="min-h-7 flex-row items-center justify-between gap-3">
      <Text class="shrink-0 text-xs text-muted-foreground">{props.label}</Text>
      <View class="min-w-0 flex-row items-center justify-end gap-1">{props.children}</View>
    </View>
  );
}

function SegmentedChoice(props: { label: string; value: () => unknown; disabled: () => boolean; options: readonly { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <View accessibilityLabel={props.label} class="flex-row gap-0.5 rounded-lg bg-segmented-track p-0.5">
      {props.options.map((option) => (
        <View role="button" accessibilityLabel={option.label} accessibilityState={{ selected: props.value() === option.value, disabled: props.disabled() }} disabled={props.disabled()} onPress={() => { if (!props.disabled() && props.value() !== option.value) props.onChange(option.value); }} class={`h-6 items-center justify-center rounded-md px-2.5 ${props.value() === option.value ? "bg-segmented-active" : "hover:bg-segmented-hover"} ${props.disabled() ? "opacity-64" : ""}`}>
          <Text class={`text-xs font-medium ${props.value() === option.value ? "text-foreground" : "text-muted-foreground"}`}>{option.label}</Text>
        </View>
      ))}
    </View>
  );
}

const FIELD_CLASS = "h-7 min-w-0 flex-1 rounded-lg border border-input bg-background px-[9px] font-mono text-xs text-foreground";

function SubmitRow(props: { placeholder: string; action: string; disabled: boolean; onSubmit: (value: string) => Promise<boolean> }) {
  const value = signal("");
  const submit = () => {
    const trimmed = value().trim();
    if (!trimmed || props.disabled) return;
    void props.onSubmit(trimmed).then((sent) => { if (sent) value.set(""); });
  };
  return (
    <View class="flex-row gap-1.5">
      <Input value={value()} placeholder={props.placeholder} accessibilityLabel={props.placeholder} disabled={props.disabled}
        onChange={(e: { value: string }) => value.set(e.value)} onSubmit={submit} class={FIELD_CLASS} />
      <SettingsButton label={props.action} disabled={props.disabled || value().trim().length === 0} onPress={submit} />
    </View>
  );
}

function SwitchRow(props: { label: string; checked: unknown; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <Row label={props.label}>
      <View disabled={props.disabled || props.checked === undefined}>
        <SettingsSwitch label={props.label} checked={props.checked === true} onChange={(next) => { if (!props.disabled && props.checked !== undefined) props.onChange(next); }} />
      </View>
    </Row>
  );
}

export function DeviceToolsPanel(props: {
  platform: "ios" | "android";
  settings: () => Record<string, unknown> | null;
  foregroundApp: () => { id: string } | null;
  pending: () => boolean;
  error: () => string;
  hostDiagnostics?: string;
  act: (body: DeviceActBody) => Promise<boolean>;
  onClose: () => void;
  /** Narrow device areas place tools over the viewer, as the reference does. */
  overlayWidth?: () => number | undefined;
  /** Accessibility: "Overlay element frames" (needs the hub's access). */
  axOverlay?: () => boolean;
  onAxOverlayChange?: (next: boolean) => void;
  hubAvailable?: () => boolean;
  /** iOS: the hub's event log (streams only while open). */
  eventLog?: { open: () => boolean; entries: () => { id: number; timestamp: string; summary: string }[]; onOpenChange: (next: boolean) => void };
}) {
  const isIos = props.platform === "ios";
  const disabled = () => props.pending() || props.settings() === null;
  const s = () => props.settings() ?? {};
  const act = (body: DeviceActBody) => { void props.act(body); };
  // Location
  const latitude = signal("");
  const longitude = signal("");
  // Permissions
  const appId = signal("");
  const permission = signal("camera");
  const resolvedAppId = () => appId().trim() || (props.foregroundApp()?.id ?? "");
  const permissions = isIos ? IOS_PERMISSIONS : ANDROID_PERMISSIONS;
  const decide = (decision: "grant" | "revoke" | "reset") => { if (resolvedAppId()) act({ type: "setPermission", appId: resolvedAppId(), permission: permission(), decision }); };
  return (
    <View class={`min-h-0 w-72 shrink-0 border-l border-border bg-background ${props.overlayWidth?.() !== undefined ? "absolute inset-y-0 right-0 z-10" : ""}`} style={props.overlayWidth?.() !== undefined ? { width: props.overlayWidth!() } : undefined} accessibilityLabel="Device tools">
      <View class="h-9 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
        <Text class="text-sm font-medium text-foreground">Tools</Text>
        {props.pending() ? <Spinner size={14} /> : null}
        <View class="flex-1" />
        <View role="button" accessibilityLabel="Close tools" onPress={props.onClose} class="size-6 items-center justify-center rounded hover:bg-accent"><DIcon name="x" size={14} /></View>
      </View>
      <Scroll class="min-h-0 flex-1">
        {props.error() ? <Text class="border-b border-border bg-destructive-8 px-3 py-2 text-xs text-destructive-foreground">{props.error()}</Text> : null}
        {props.settings() === null && !props.error() ? <View class="flex-row items-center gap-2 px-3 py-3"><Spinner size={14} /><Text class="text-xs text-muted-foreground">Reading device settings…</Text></View> : null}
        {props.hostDiagnostics ? <Section title="Host diagnostics"><Text class="text-xs text-muted-foreground">{props.hostDiagnostics}</Text></Section> : null}

        <Section title="App">
          <Row label="Foreground"><Text class="truncate font-mono text-xs text-foreground">{props.foregroundApp()?.id ?? "-"}</Text></Row>
          {props.foregroundApp() ? (
            <View class="flex-row gap-1.5">
              <SettingsButton label="Terminate" disabled={disabled()} onPress={() => act({ type: "terminateApp", appId: props.foregroundApp()!.id })} />
              <SettingsButton label="Relaunch" disabled={disabled()} onPress={() => act({ type: "launchApp", appId: props.foregroundApp()!.id })} />
            </View>
          ) : null}
          <SubmitRow placeholder="https://… or myapp://" action="Open" disabled={disabled()} onSubmit={(url) => props.act({ type: "openUrl", url })} />
          <SubmitRow placeholder={isIos ? "Bundle ID to launch" : "Package name to launch"} action="Launch" disabled={disabled()} onSubmit={(id) => props.act({ type: "launchApp", appId: id })} />
        </Section>

        <Section title={isIos ? "Simulator" : "Emulator"}>
          <Row label="Appearance">
            <SegmentedChoice label="Appearance" value={() => s().appearance} disabled={disabled} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => act({ type: "setAppearance", value })} />
          </Row>
          <Row label="Text size">
            <SettingsSelect label="Text size" compactWidth={160} value={String(s().textSize ?? "")} triggerLabel={TEXT_SIZES.find((o) => o.value === s().textSize)?.label ?? "Unknown"}
              options={TEXT_SIZES.map((o) => ({ ...o }))} onChange={(value) => { if (!disabled() && value !== s().textSize) act({ type: "setTextSize", value }); }} />
          </Row>
          {isIos ? (
            <>
              <Row label="Liquid Glass">
                <SegmentedChoice label="Liquid Glass" value={() => s().liquidGlass} disabled={() => disabled() || s().liquidGlass === undefined} options={[{ value: "clear", label: "Clear" }, { value: "tinted", label: "Tinted" }]} onChange={(value) => act({ type: "setLiquidGlass", value })} />
              </Row>
              <Row label="Color filter">
                <SettingsSelect label="Color filter" compactWidth={160} value={String(s().colorFilter ?? "")} triggerLabel={COLOR_FILTERS.find((o) => o.value === s().colorFilter)?.label ?? "Unknown"}
                  options={COLOR_FILTERS.map((o) => ({ ...o }))} onChange={(value) => { if (!disabled() && value !== s().colorFilter) act({ type: "setColorFilter", value }); }} />
              </Row>
            </>
          ) : (
            <Row label="Orientation">
              <SettingsSelect label="Orientation" compactWidth={160} value="" triggerLabel="Rotate to…"
                options={ORIENTATIONS.map((o) => ({ ...o }))} onChange={(value) => { if (!disabled()) act({ type: "setOrientation", value }); }} />
            </Row>
          )}
          <SwitchRow label="Reduce Motion" checked={s().reduceMotion} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "reduceMotion", value })} />
          {isIos ? (
            <>
              <SwitchRow label="Increase Contrast" checked={s().increaseContrast} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "increaseContrast", value })} />
              <SwitchRow label="Reduce Transparency" checked={s().reduceTransparency} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "reduceTransparency", value })} />
              <SwitchRow label="Show Borders" checked={s().showBorders} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "showBorders", value })} />
              <SwitchRow label="VoiceOver" checked={s().voiceOver} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "voiceOver", value })} />
            </>
          ) : (
            <SwitchRow label="Network" checked={s().networkEnabled} disabled={disabled()} onChange={(value) => act({ type: "setToggle", setting: "networkEnabled", value })} />
          )}
        </Section>

        {props.axOverlay && props.onAxOverlayChange ? (
          <Section title="Accessibility">
            <SwitchRow label="Overlay element frames" checked={props.axOverlay()} disabled={!(props.hubAvailable?.() ?? false)} onChange={(value) => props.onAxOverlayChange!(value)} />
          </Section>
        ) : null}

        <Section title="Location">
          <View class="flex-row gap-1.5">
            <Input value={latitude()} placeholder="Latitude" accessibilityLabel="Latitude" disabled={disabled()} onChange={(e: { value: string }) => latitude.set(e.value)} class={FIELD_CLASS} />
            <Input value={longitude()} placeholder="Longitude" accessibilityLabel="Longitude" disabled={disabled()} onChange={(e: { value: string }) => longitude.set(e.value)} class={FIELD_CLASS} />
          </View>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <SettingsSelect label="Location preset" compactWidth={128} value="" triggerLabel="Preset…" options={LOCATION_PRESETS.map((p) => ({ value: p.label, label: p.label }))}
              onChange={(value) => {
                const preset = LOCATION_PRESETS.find((p) => p.label === value);
                if (!preset || disabled()) return;
                latitude.set(String(preset.latitude)); longitude.set(String(preset.longitude));
                act({ type: "setLocation", latitude: preset.latitude, longitude: preset.longitude });
              }} />
            <SettingsButton label="Set" disabled={disabled() || parseLocation(latitude(), longitude()) === null} onPress={() => { const p = parseLocation(latitude(), longitude()); if (p && !disabled()) act({ type: "setLocation", ...p }); }} />
            {isIos ? <SettingsButton label="Clear" tone="ghost" disabled={disabled()} onPress={() => { if (disabled()) return; latitude.set(""); longitude.set(""); act({ type: "clearLocation" }); }} /> : null}
          </View>
        </Section>

        <Section title="Permissions">
          <Input value={appId()} placeholder={props.foregroundApp()?.id || "App ID"} accessibilityLabel="Permission app ID" disabled={disabled()} onChange={(e: { value: string }) => appId.set(e.value)} class={FIELD_CLASS} />
          <View class="flex-row flex-wrap items-center gap-1.5">
            <SettingsSelect label="Permission" compactWidth={160} value={permission()} options={permissions.map((p) => ({ ...p }))} onChange={(value) => permission.set(value)} />
            <SettingsButton label="Grant" disabled={disabled() || !resolvedAppId()} onPress={() => { if (!disabled()) decide("grant"); }} />
            <SettingsButton label="Revoke" disabled={disabled() || !resolvedAppId()} onPress={() => { if (!disabled()) decide("revoke"); }} />
            {isIos ? <SettingsButton label="Reset" tone="ghost" disabled={disabled() || !resolvedAppId()} onPress={() => { if (!disabled()) decide("reset"); }} /> : null}
          </View>
        </Section>

        {isIos ? (
          <Section title="Push notification">
            <SubmitRow placeholder="Alert text" action="Send" disabled={disabled() || !props.foregroundApp()}
              onSubmit={(payload) => (props.foregroundApp() ? props.act({ type: "sendPush", appId: props.foregroundApp()!.id, payload }) : Promise.resolve(false))} />
            {!props.foregroundApp() ? <Text class="text-xs text-muted-foreground">Open an app first.</Text> : null}
          </Section>
        ) : null}
        {isIos && props.eventLog && (props.hubAvailable?.() ?? false) ? (
          <View>
            <View role="button" accessibilityLabel="Event log" accessibilityState={{ expanded: props.eventLog.open() }} onPress={() => props.eventLog!.onOpenChange(!props.eventLog!.open())}
              class="w-full flex-row items-center gap-1.5 border-b border-border px-3 py-2.5">
              <Text class="text-xs font-medium text-muted-foreground">Event log</Text>
              <View class="flex-1" />
              <View style={{ transform: [{ rotate: props.eventLog.open() ? "180deg" : "0deg" }] }}><DIcon name="chevron-down" size={14} /></View>
            </View>
            {props.eventLog.open() ? (
              <View class="max-h-64 px-3 py-2">
                {props.eventLog.entries().length === 0 ? <Text class="font-mono text-2xs text-muted-foreground">No events yet.</Text> : props.eventLog.entries().map((entry) => (
                  <View class="flex-row gap-2"><Text class="shrink-0 font-mono text-2xs text-muted-foreground">{entry.timestamp.slice(11, 19)}</Text><Text class="truncate font-mono text-2xs text-foreground">{entry.summary}</Text></View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </Scroll>
    </View>
  );
}
