// RedactedSensitiveText.tsx: an account email shown as a stable random placeholder until clicked.
import { signal, Text, View } from "nsh";
import { Tip } from "./ui";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** The same placeholder for the same value, keeping the separators so the shape reads as an email. */
export function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  const next = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return ALPHABET[Math.abs(state) % ALPHABET.length] ?? "x";
  };
  return Array.from(value, (char) => char === "@" || char === "." || char === "-" || char === "_" ? char : next()).join("");
}

export function RedactedSensitiveText(props: { value: string | null | undefined; ariaLabel: string; revealTooltip: string; hideTooltip: string; class?: string }) {
  const revealed = signal(false);
  const value = () => props.value?.trim() ?? "";
  return value() === "" ? null : <View accessibilityLabel={props.ariaLabel} role="button" testID="Redacted text" class="min-w-0 shrink" onPress={() => revealed.update((on) => !on)}
    tooltip={<Tip label={revealed() ? props.hideTooltip : props.revealTooltip} />}>
    <Text class={`min-w-0 font-mono text-2xs leading-normal text-muted-foreground hover:text-foreground ${props.class ?? ""}`}>{revealed() ? value() : redactedPlaceholder(value())}</Text>
  </View>;
}

/** ProviderAuthEmail: the signed-in account's email, redacted. */
export function ProviderAuthEmail(props: { email: string | null | undefined }) {
  return <RedactedSensitiveText value={props.email} ariaLabel="Toggle account email visibility" revealTooltip="Click to reveal email" hideTooltip="Click to hide email" class="max-w-full truncate" />;
}
