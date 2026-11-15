// CloudVoiceConfiguration.tsx: the dialog that opens when a cloud provider is picked under "Transcribe with"
// (and from the key button beside the select). It reads which providers have a key saved, takes a key (or,
// for OpenRouter, a model), and saves the key before it enables the destination, so a failed save leaves the
// previous choice alone. Secret-provider references are not offered: this client has no secret sources.
import { effect, signal, Text, untracked, View } from "nsh";
import { DialogInput as Input } from "../../../components/DialogInput";
import { SettingsDialog } from "../../../components/SettingsDialog";
import { useOverlayOpen } from "../../../components/rightPanel/nativeOcclusion";
import { PillButton } from "../providers/ui";
import { audioGrant, chooseAudioDestination } from "./voiceState";
import { getCloudSpeechKeys, getCloudSpeechModels, setCloudSpeechKey, voiceConnected } from "./voiceApi";
import { CLOUD_SPEECH_LABELS, CLOUD_SPEECH_PROVIDER_NAMES, cloudSpeechDisclosure, type CloudSpeechProvider, type EnvironmentInfo, type VoiceTranscriptionDestination } from "./speech";
import { VoiceSelect } from "./VoiceControls";

/** CloudSpeechApiKey: printable ASCII, no spaces, at most 4096, and not a URL. */
export const isApiKey = (value: string) => value.length > 0 && value.length <= 4096 && /^[!-~]+$/.test(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value);
/** CloudSpeechModelId: an exact `author/model` slug, never a router shortcut. */
export const isModelId = (value: string) => value.length >= 3 && value.length <= 160 && /^(?!openrouter\/)[a-z\d][a-z\d.-]*\/[a-z\d][a-z\d._-]*$/i.test(value);

export function cloudDialogTitle(input: { provider: CloudSpeechProvider; active: boolean; remove: boolean }): string {
  const name = CLOUD_SPEECH_LABELS[input.provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[input.provider];
  const routed = input.provider === "openrouter";
  if (input.remove) return `Remove the ${company} key?`;
  if (input.active) return routed ? "Manage OpenRouter dictation" : `Manage ${company} key`;
  return `Use ${name} for dictation?`;
}

export function cloudDialogDescription(input: { provider: CloudSpeechProvider; active: boolean; remove: boolean; environment: string }): string {
  const name = CLOUD_SPEECH_LABELS[input.provider];
  if (input.remove) return `Everyone using ${name} for dictation on ${input.environment} will lose access.`;
  if (input.active && input.provider !== "openrouter") return `Anyone with dictation access to ${input.environment} can use this API key.`;
  return cloudSpeechDisclosure(input.provider, input.environment);
}

type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ready"; value: T };

export function CloudVoiceDialog(props: { environment: EnvironmentInfo; provider: CloudSpeechProvider; active: boolean; close: () => void }) {
  useOverlayOpen(true, "voice cloud dialog");
  const { environment, provider } = props;
  const name = CLOUD_SPEECH_LABELS[provider];
  const company = CLOUD_SPEECH_PROVIDER_NAMES[provider];
  const routed = provider === "openrouter";
  const connected = () => voiceConnected();
  const keys = signal<Load<Partial<Record<CloudSpeechProvider, boolean>>>>({ state: "loading" });
  const models = signal<Load<{ id: string; name: string }[]>>({ state: "loading" });
  const currentGrant = untracked(() => audioGrant());
  const currentModel = props.active && currentGrant?.destination.kind === "cloud" && currentGrant.destination.provider === "openrouter" ? currentGrant.destination.model : undefined;
  const model = signal(currentModel ?? "");
  const draft = signal("");
  const remove = signal(false);
  const busy = signal(false);
  const error = signal("");

  const loadKeys = () => {
    keys.set({ state: "loading" });
    getCloudSpeechKeys().then((value) => keys.set({ state: "ready", value }), () => keys.set({ state: "failed" }));
  };
  const loadModels = () => {
    if (!routed) return;
    models.set({ state: "loading" });
    getCloudSpeechModels().then((value) => models.set({ state: "ready", value }), () => models.set({ state: "failed" }));
  };
  effect(() => {
    if (!connected()) return;
    untracked(() => { loadKeys(); loadModels(); });
  });

  const saved = () => { const k = keys(); return k.state === "ready" ? k.value[provider] : undefined; };
  const listed = () => { const m = models(); return m.state === "ready" ? m.value : null; };
  const credential = () => (isApiKey(draft().trim()) ? draft().trim() : undefined);
  // Fixed providers edit the key only when nothing is saved or the device already uses them.
  const editingKey = () => saved() !== undefined && (routed || props.active || !saved());
  const modelChosen = () => isModelId(model()) && (listed()?.some((m) => m.id === model()) ?? false);
  const keyReady = () => (draft().trim() ? credential() !== undefined : Boolean(saved()));
  const modelChanged = () => model() !== (currentModel ?? "");
  const keyChanged = () => credential() !== undefined;
  const destination = (): VoiceTranscriptionDestination => (routed && isModelId(model())
    ? { kind: "cloud", provider: "openrouter", environmentId: environment.environmentId, model: model() }
    : { kind: "cloud", provider: provider as "openai" | "xai", environmentId: environment.environmentId });
  const canSubmit = () => (routed ? modelChosen() && keyReady() && (!props.active || modelChanged() || keyChanged()) : credential() !== undefined);

  const saveKey = async (value: string | null, thenEnable: boolean) => {
    if (!connected() || busy()) return;
    error.set("");
    busy.set(true);
    try {
      await setCloudSpeechKey(provider, value);
      loadKeys();
      if (thenEnable) chooseAudioDestination(destination());
      props.close();
    } catch {
      error.set("Couldn’t save this change. Check your connection and try again.");
    }
    busy.set(false);
  };
  const submit = () => {
    if (!canSubmit() || busy()) return;
    const grantChanges = !props.active || modelChanged();
    const key = credential();
    if (key !== undefined && (!routed || keyChanged())) return void saveKey(key, grantChanges);
    // Model-only changes never write to the environment.
    if (grantChanges) chooseAudioDestination(destination());
    props.close();
  };

  const keyHelp = () => {
    if (draft().trim() && !credential()) return "Enter an API key, not a URL or secret reference.";
    if (props.active && !routed) return "Updating the key keeps dictation enabled.";
    if (routed && saved()) return "Leave blank to keep the saved key.";
    return `Anyone with dictation access to ${environment.label} can bill this key.`;
  };
  const keyField = () => (
    <View class="gap-2">
      <Text class="text-xs font-medium text-foreground">{routed && saved() ? "Replace API key" : "API key"}</Text>
      <Input
        masked autoFocus={!routed} value={draft()} readonly={busy()} placeholder={saved() === true ? "••••••••" : "Enter API key"} maxLength={4096}
        autoCapitalize="none" autoCorrect={false} accessibilityLabel={`${company} API key`}
        onChange={(e: { value: string }) => draft.set(e.value)}
        onSubmit={submit}
        class="h-8 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground"
      />
      <Text class="text-sm text-muted-foreground">{keyHelp()}</Text>
    </View>
  );
  const modelPicker = () => {
    const entries = listed();
    if (entries) {
      const delisted = currentModel !== undefined && !entries.some((m) => m.id === currentModel);
      const selected = entries.find((m) => m.id === model());
      return (
        <View class="gap-1">
          <VoiceSelect
            inline
            label="OpenRouter model" value={model()} disabled={busy()} searchPlaceholder="Search transcription models" searchEmpty="No transcription model matches."
            triggerText={selected?.name ?? "Search transcription models"}
            items={entries.map((m) => ({ value: m.id, title: m.name }))} onChange={(next) => model.set(next)} maxWidth={384}
          />
          {delisted ? <Text role="alert" class="text-sm text-destructive-foreground">{`OpenRouter no longer lists ${currentModel}. Dictation stays off until you choose another model.`}</Text>
            : selected ? <Text class="truncate text-xs text-muted-foreground">{selected.id}</Text> : null}
        </View>
      );
    }
    if (models().state === "failed") return <PillButton label="Retry loading models" size="xs" onPress={loadModels}><Text class="text-sm text-foreground">Retry loading models</Text></PillButton>;
    return <Text class="text-sm text-muted-foreground">Loading transcription models…</Text>;
  };

  const body = () => {
    if (remove()) return null;
    if (!connected()) return <Text class="text-sm text-muted-foreground">{`Connect to ${environment.label} with dictation access to continue.`}</Text>;
    if (keys().state === "failed") return <PillButton label="Retry loading API key" size="xs" onPress={loadKeys}><Text class="text-sm text-foreground">Retry loading API key</Text></PillButton>;
    if (routed && keys().state === "ready" && saved() === undefined) return <Text class="text-sm text-muted-foreground">{`Update ${environment.label} to use OpenRouter dictation.`}</Text>;
    if (saved() === undefined) return <Text class="text-sm text-muted-foreground">Checking for an API key…</Text>;
    if (routed) {
      return (
        <View class="gap-3">
          <View class="gap-2"><Text class="text-xs font-medium text-foreground">Model</Text>{modelPicker()}</View>
          {editingKey() ? keyField()
            : !saved() ? <Text class="text-sm text-muted-foreground">{`Ask an administrator on ${environment.label} to add an API key.`}</Text>
            : <Text class="text-sm text-muted-foreground">{`Uses the API key saved on ${environment.label}. This choice applies only to this device.`}</Text>}
        </View>
      );
    }
    if (editingKey()) return keyField();
    if (!saved()) return <Text class="text-sm text-muted-foreground">{`Ask an administrator on ${environment.label} to add an API key.`}</Text>;
    return <Text class="text-sm text-muted-foreground">This choice applies only to this device. Choose Off to stop sharing.</Text>;
  };

  const footer = () => (
    <>
      {connected() && saved() && (props.active || routed) && !remove() ? (
        <View class="mr-auto"><PillButton label="Remove key…" variant="ghost" size="xs" disabled={busy()} onPress={() => remove.set(true)}><Text class="text-sm text-foreground">Remove key…</Text></PillButton></View>
      ) : null}
      <PillButton label="Cancel" size="xs" disabled={busy()} onPress={props.close}><Text class="text-sm text-foreground">Cancel</Text></PillButton>
      {connected() ? (
        remove() ? <PillButton label="Remove key" size="xs" disabled={busy()} onPress={() => void saveKey(null, false)}><Text class="text-sm text-destructive-foreground">Remove key</Text></PillButton>
          : routed ? (saved() !== undefined ? <PillButton label={props.active ? "Save" : "Save and enable"} variant="primary" size="xs" disabled={busy() || !canSubmit()} onPress={submit}><Text class="text-sm text-primary-foreground">{props.active ? "Save" : "Save and enable"}</Text></PillButton> : null)
          : editingKey() ? <PillButton label={props.active ? "Save key" : "Save and enable"} variant="primary" size="xs" disabled={busy() || !credential()} onPress={submit}><Text class="text-sm text-primary-foreground">{props.active ? "Save key" : "Save and enable"}</Text></PillButton>
          : saved() && !props.active ? <PillButton label={`Use ${name}`} variant="primary" size="xs" onPress={() => { chooseAudioDestination(destination()); props.close(); }}><Text class="text-sm text-primary-foreground">{`Use ${name}`}</Text></PillButton>
          : null
      ) : null}
    </>
  );

  return (
    <SettingsDialog
      open onClose={() => { if (!busy()) props.close(); }} width={448} testID="Voice cloud dialog"
      title={cloudDialogTitle({ provider, active: props.active, remove: remove() })}
      description={cloudDialogDescription({ provider, active: props.active, remove: remove(), environment: environment.label })}
      footer={footer()}
    >
      {body()}
      {error() ? <Text role="alert" class="text-sm text-destructive-foreground">{error()}</Text> : null}
    </SettingsDialog>
  );
}
