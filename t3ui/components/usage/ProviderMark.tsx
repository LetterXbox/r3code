// ProviderMark (UsagePage.tsx): the provider's brand mark beside its name in the Usage page's menus, breakdown rows and
// model dialog, instead of a colour dot. `size` is the mark's own size in points (size-4 = 16, size-3.5 = 14).
import { ProviderIconView } from "../../pages/settings/providers/ui";
import { providerPresentation } from "./usageFormat";

export function ProviderMark(props: { provider: string; size?: number }) {
  const presentation = () => providerPresentation(props.provider);
  // ProviderIconView draws the artwork 4 points inside its box.
  return <ProviderIconView driver={presentation().driver} instanceId={props.provider} name={presentation().label} size={(props.size ?? 16) + 4} />;
}
