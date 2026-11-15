// TelemetryExportSettings.tsx: the "OpenTelemetry export" card at the foot of Diagnostics. Three OTLP HTTP
// endpoints (traces, metrics, logs) that the server reads after a restart, each with a status dot and a Test
// button (`server.checkOtlpEndpoint`), a note when the environment or the desktop app overrides one, and Discard
// and Save.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { registerSettingsRow } from "./settingsSearchNav";
import { SettingsButton, SettingsSection } from "../../components/SettingsLayout";
import { replaceServerSettings, serverObservability, serverSettings } from "./settingsState";
import { requestServer } from "./settingsSync";
import { SIGNALS, endpointStatus, isHttpUrl, runningOverride, type EndpointCheck, type SignalKey } from "./telemetryExportLogic";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const saved = (key: SignalKey): string => { const observability = (serverSettings() as Record<string, unknown> | null)?.observability as Record<string, unknown> | undefined; return typeof observability?.[key] === "string" ? (observability[key] as string) : ""; };

export function TelemetryExportSettings() {
  const draft = signal<Partial<Record<SignalKey, string>>>({});
  const checks = signal<Partial<Record<SignalKey, EndpointCheck>>>({});
  const saving = signal(false);
  const note = signal("");
  const running = () => serverObservability();
  const value = (key: SignalKey) => draft()[key] ?? saved(key);
  const changedSignals = () => SIGNALS.filter(({ key }) => value(key).trim() !== saved(key));
  const check = async (key: SignalKey, signalName: string, url: string) => {
    if (!isHttpUrl(url)) return;
    checks.update((all) => ({ ...all, [key]: { url, result: null } }));
    try {
      const result = await requestServer("server.checkOtlpEndpoint", { signal: signalName, url });
      checks.update((all) => (all[key]?.url !== url || all[key]?.result !== null ? all : { ...all, [key]: { url, result: result as EndpointCheck["result"] } }));
    } catch {
      checks.update((all) => { const { [key]: _drop, ...rest } = all; return rest; });
    }
  };
  const save = async () => {
    if (saving() || changedSignals().length === 0) return;
    saving.set(true);
    note.set("");
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: { observability: Object.fromEntries(changedSignals().map(({ key }) => [key, value(key)])) } }));
      draft.set({});
      note.set("Saved. Restart the server to apply.");
    } catch (cause) {
      note.set(message(cause));
    } finally {
      saving.set(false);
    }
  };
  return (
    <View ref={(node: any) => registerSettingsRow("/settings/diagnostics", "telemetry-export", node)}><SettingsSection title="OpenTelemetry export">
      <View class="gap-4 px-5 py-4" testID="Telemetry export">
        <Text class="text-xs text-muted-foreground">Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply. Environment variables override these settings.</Text>
        <Each of={[...SIGNALS]} key={(descriptor) => descriptor.key}>
          {(descriptor) => {
            const override = () => runningOverride(running(), descriptor());
            const url = () => override()?.url ?? value(descriptor().key).trim();
            const status = () => { const mine = endpointStatus(url(), checks()[descriptor().key]); return override() ? { label: `${override()!.label} · ${mine.label}`, dot: mine.dot } : mine; };
            const runningUrl = () => (typeof running()?.[descriptor().key] === "string" ? (running()![descriptor().key] as string) : "");
            return (
              <View class="gap-1.5">
                <View class="flex-row items-center justify-between gap-3">
                  <View class="flex-row items-center gap-1.5">
                    <View class={`size-2 rounded-full ${status().dot}`} />
                    <Text class="text-sm font-medium text-foreground">{`${descriptor().label} endpoint`}</Text>
                  </View>
                  <Text class="text-xs text-muted-foreground">{status().label}</Text>
                </View>
                <View class="flex-row gap-2">
                  <Input
                    value={value(descriptor().key)}
                    placeholder={`http://localhost:4318/v1/${descriptor().signal}`}
                    accessibilityLabel={`${descriptor().label} endpoint`}
                    // The web input's `title` (its pattern hint), shown on hover as the browser shows a title.
                    tooltip="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
                    disabled={saving()}
                    onChange={(e: { value: string }) => { draft.update((all) => ({ ...all, [descriptor().key]: e.value })); note.set(""); }}
                    class="h-7 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
                  />
                  <SettingsButton label="Test" accessibilityLabel={`Test ${descriptor().label} endpoint`} disabled={!isHttpUrl(url()) || checks()[descriptor().key]?.result === null} onPress={() => void check(descriptor().key, descriptor().signal, url())} />
                </View>
                {saved(descriptor().key) !== runningUrl() || override()?.variable ? (
                  <Text class="text-xs text-muted-foreground">{`Running: ${runningUrl() || "Disabled"}${override()?.variable ? ` from ${override()!.variable}` : ""}`}</Text>
                ) : null}
              </View>
            );
          }}
        </Each>
        <View class="flex-row items-center justify-between gap-3">
          <Text class="text-xs text-muted-foreground">{note()}</Text>
          <View class="shrink-0 flex-row gap-2">
            <SettingsButton label="Discard" disabled={changedSignals().length === 0 || saving()} onPress={() => { draft.set({}); note.set(""); }} />
            <SettingsButton label={saving() ? "Saving…" : "Save"} tone="primary" disabled={changedSignals().length === 0 || saving()} onPress={() => void save()} />
          </View>
        </View>
      </View>
    </SettingsSection></View>
  );
}
