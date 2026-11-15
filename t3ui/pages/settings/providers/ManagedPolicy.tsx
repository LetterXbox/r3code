// ManagedPolicy.tsx: controls an administrator's policy turns off, and the notices that say so.
import { Text, View } from "nsh";
import { UiIcon } from "./ui";
import type { ManagedPolicySummary } from "./policyLogic";

export { ManagedControl } from "./ui";

/** One line of policy text with the building mark, for places a whole feature is managed. */
export function ManagedNotice(props: { children?: any }) {
  return <View class="flex-row items-start gap-2 px-4 pb-1" testID="Managed notice">
    <View class="mt-0.5"><UiIcon name="building" size={14} /></View>
    <Text class="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{props.children}</Text>
  </View>;
}

/** "This environment is managed by <organization>", with a Get help link when the policy has one. */
export function ManagedByOrganization(props: { policy: ManagedPolicySummary; onOpen: (url: string) => void }) {
  return <ManagedNotice>
    {`This environment is managed by ${props.policy.organization}.`}
    {props.policy.supportUrl ? <Text role="link" class="text-xs text-foreground underline" onPress={() => props.onOpen(props.policy.supportUrl as string)}> Get help</Text> : null}
  </ManagedNotice>;
}
