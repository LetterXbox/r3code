// components/ManagedPolicy.tsx: the notices an administrator's policy puts in the app. ManagedNotice is one line of policy text with
// the building mark; ManagedByOrganization reads "This environment is managed by <organization>." with a Get help link when the
// policy has a support page. (The web has no root banner for this: it appears where a whole feature is managed.)
import { openUrl, Text, View } from "nsh";
import { Image, token } from "nsh";
import building from "../../icons/building.svg";

export function ManagedNotice(props: { children?: any }) {
  return (
    <View class="flex-row items-start gap-2" accessibilityLabel="Managed by your organization">
      <View class="mt-0.5 size-3.5 shrink-0"><Image src={building} fadeDuration={0} style={{ width: 14, height: 14, tintColor: token("muted-foreground") }} /></View>
      <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{props.children}</Text>
    </View>
  );
}

export function ManagedByOrganization(props: { organization: string; supportUrl?: string | undefined }) {
  return (
    <ManagedNotice>
      This environment is managed by {props.organization}.
      {props.supportUrl ? <Text class="text-xs text-foreground underline" role="link" accessibilityLabel="Get help" onPress={() => void openUrl(props.supportUrl!).catch(() => undefined)}> Get help</Text> : null}
    </ManagedNotice>
  );
}
