// SecretSourceInput.tsx: a secret entered here (the masked value field), or read from a secret provider. The source select
// shows only when there are sources or the value already names one; a provider no longer configured stays listed.
import { signal, Text, View } from "nsh";
import { SettingsSelect } from "../../components/SettingsLayout";
import { DraftInput } from "./providers/ui";
import { commitSecretReference, isSecretReference, SECRET_PROVIDER_DEFINITIONS, type SecretReference, type SecretSource } from "./secretSource";

const STORED_VALUE = "__stored__";

export function SecretSourceInput(props: {
  label: string;
  value: unknown;
  sources: () => SecretSource[];
  disabled?: boolean;
  placeholder?: string;
  class?: string;
  /** A literal typed into the value field. */
  onValueCommit: (value: string) => void;
  /** A committed reference, or undefined when the reference is cleared (the setting goes back to a value). */
  onSecretChange: (secret: SecretReference | undefined) => void;
}) {
  const pendingProvider = signal<string | null>(null);
  const rejected = signal<{ text: string; message: string } | null>(null);
  const secret = () => (isSecretReference(props.value) ? props.value : undefined);
  const provider = () => pendingProvider() ?? secret()?.provider ?? null;
  const reference = () => { const current = secret(); return current && current.provider === provider() ? current.reference : ""; };
  const kindOf = (id: string) => props.sources().find((source) => source.id === id)?.kind;
  const definition = () => SECRET_PROVIDER_DEFINITIONS[kindOf(provider() ?? "") ?? ""];
  const showSource = () => props.sources().length > 0 || provider() !== null;
  const options = () => {
    const list = [{ value: STORED_VALUE, label: "Value" }, ...props.sources().map((source) => ({ value: source.id, label: source.label }))];
    const current = provider();
    if (current && !props.sources().some((source) => source.id === current)) list.push({ value: current, label: current });
    return list;
  };
  return (
    <View class={`min-w-0 flex-row items-start gap-1.5 ${props.class ?? ""}`}>
      {showSource() ? (
        <SettingsSelect label={`${props.label} source`} value={provider() ?? STORED_VALUE} options={options()} compactWidth={120}
          onChange={(next) => {
            rejected.set(null);
            if (next === STORED_VALUE) { pendingProvider.set(null); if (secret() !== undefined) props.onSecretChange(undefined); return; }
            pendingProvider.set(next === secret()?.provider ? null : next);
          }} />
      ) : null}
      {provider() === null ? (
        <DraftInput label={props.label} masked disabled={props.disabled} value="" placeholder={props.placeholder} class="min-w-0 flex-1" onCommit={props.onValueCommit} />
      ) : (
        <View class="min-w-0 flex-1 gap-1">
          <DraftInput label={`${props.label} reference`} mono disabled={props.disabled} value={rejected()?.text ?? reference()} placeholder={definition()?.referencePlaceholder ?? ""}
            onCommit={(next) => {
              const outcome = commitSecretReference(provider()!, kindOf, next);
              if ("rejected" in outcome) { rejected.set({ text: next, message: outcome.rejected }); return; }
              rejected.set(null);
              if ("cleared" in outcome) { if (pendingProvider() === null && secret() !== undefined) props.onSecretChange(undefined); return; }
              pendingProvider.set(null);
              props.onSecretChange(outcome.secret);
            }} />
          {rejected() ? <Text class="text-2xs text-destructive">{rejected()!.message}</Text> : null}
        </View>
      )}
    </View>
  );
}
