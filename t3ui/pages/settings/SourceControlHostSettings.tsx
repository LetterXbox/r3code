// SourceControlHostSettings.tsx: the details of a source control host whose definition has settings but no
// credentials. Each field is a row with its own title, description and input; a secret is never shown back (a saved
// one says so in the placeholder), and a Remove button clears them all.
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { SettingsButton, SettingsRow } from "../../components/SettingsLayout";
import { replaceServerSettings, serverSettings } from "./settingsState";
import { requestServer } from "./settingsSync";
import { HOST_SETTINGS, hostFieldSaved, hostSettingsPatch, readHostSettings, removeAllPatch, type HostSettingsField } from "./sourceControlHosts";

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function SourceControlHostSettings(props: { kind: string; onSaved: () => void }) {
  const definition = HOST_SETTINGS[props.kind]!;
  const saving = signal(false);
  const error = signal("");
  const saved = () => readHostSettings(serverSettings(), props.kind);
  const anySaved = () => definition.fields.some((field) => hostFieldSaved(saved()[field.key]));
  const save = async (fields: Record<string, string>, remove = false) => {
    saving.set(true);
    error.set("");
    try {
      replaceServerSettings(await requestServer("server.updateSettings", { patch: remove ? removeAllPatch(props.kind) : hostSettingsPatch(props.kind, fields) }));
      props.onSaved();
    } catch (cause) {
      error.set(message(cause));
    } finally {
      saving.set(false);
    }
  };
  return (
    <View class="gap-3" testID={`${definition.label} host settings`}>
      <Each of={definition.fields} key={(field) => field.key}>{(field) => <HostField field={field()} kind={props.kind} saved={() => saved()[field().key]} disabled={saving} onSave={(value) => void save({ [field().key]: value })} />}</Each>
      {anySaved() ? (
        <View class="items-end pt-2">
          <SettingsButton label="Remove" accessibilityLabel={`Remove ${definition.label} settings`} disabled={saving()} onPress={() => void save({}, true)} />
        </View>
      ) : null}
      {error() ? <Text class="text-xs text-destructive-foreground">{error()}</Text> : null}
    </View>
  );
}

function HostField(props: { field: HostSettingsField; kind: string; saved: () => unknown; disabled: () => boolean; onSave: (value: string) => void }) {
  const field = props.field;
  const draft = signal("");
  let shown: unknown = undefined;
  // A plain field shows what is saved; a secret is never read back.
  const value = () => {
    if (field.secret) return draft();
    const current = props.saved();
    if (current !== shown) { shown = current; draft.set(typeof current === "string" ? current : ""); }
    return draft();
  };
  const configured = () => hostFieldSaved(props.saved());
  const commit = () => {
    const next = draft().trim();
    if (field.secret ? next === "" : next === (typeof props.saved() === "string" ? props.saved() : "")) return;
    props.onSave(next);
    if (field.secret) draft.set("");
  };
  return (
    <SettingsRow
      title={field.title}
      description={field.description}
      control={
        <View class="w-56 flex-row items-center gap-2">
          <Input
            value={value()}
            masked={field.secret}
            placeholder={field.secret && configured() ? "Stored secret, enter a new value to replace" : (field.placeholder ?? "")}
            accessibilityLabel={field.title}
            disabled={props.disabled()}
            onChange={(e: { value: string }) => draft.set(e.value)}
            onSubmit={commit}
            class="h-6.5 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground"
          />
          {field.secret && draft().trim() !== "" ? <SettingsButton label="Save" accessibilityLabel={`Save ${field.title}`} disabled={props.disabled()} onPress={commit} /> : null}
          {field.secret && configured() ? <SettingsButton label="Clear" accessibilityLabel={`Clear ${field.title}`} disabled={props.disabled()} onPress={() => props.onSave("")} /> : null}
        </View>
      }
    />
  );
}
