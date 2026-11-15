// The header's "Check out" menu: a separate worktree, or this repository (PullRequestDetailActions.tsx).
import { signal, Text, View } from "nsh";
import { createAnchor, Popup } from "../composer/Popover";
import { PRIcon } from "./PRIcon";
import type { CheckoutMode, PullRequestCheckoutModel } from "./pullRequestCheckoutModel";

export function PullRequestCheckoutMenu(props: { term: string; checkout: PullRequestCheckoutModel; canCheckout: () => boolean }) {
  const open = signal(false);
  const anchor = createAnchor();
  const running = () => props.checkout.handoff()?.startsWith("checkout") === true;
  const disabled = () => props.checkout.handoff() !== null || props.checkout.root() === null || !props.canCheckout();
  const label = () => (running() ? "Checking out..." : "Check out");
  const choose = (mode: CheckoutMode) => { open.set(false); void props.checkout.start(mode); };
  const item = (mode: CheckoutMode, icon: string, title: string, detail: string) => (
    <View role="button" accessibilityLabel={title} onPress={() => choose(mode)} class="flex-row items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-accent-50">
      <View class="mt-1"><PRIcon name={icon} size={14} /></View>
      <View class="min-w-0 flex-col">
        <Text class="text-sm text-foreground">{title}</Text>
        <Text class="text-xs text-muted-foreground">{detail}</Text>
      </View>
    </View>
  );
  return (
    <View>
      <View
        ref={anchor.ref}
        role="button"
        tooltip={`Check out this ${props.term}`}
        accessibilityLabel={label()}
        accessibilityState={{ disabled: disabled(), expanded: open() }}
        onPress={() => { if (!disabled()) open.set(!open()); }}
        class={disabled() ? "h-6 flex-row items-center gap-1 rounded-md border border-border px-2 opacity-50" : "h-6 flex-row items-center gap-1 rounded-md border border-border px-2 hover:bg-accent-50"}
      >
        <PRIcon name="git-branch" size={14} />
        <Text class="text-xs text-foreground">{label()}</Text>
        <PRIcon name="chevron-down" size={14} />
      </View>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="bottom" align="end" class="w-72">
          <View class="flex-col p-1">
            {item("worktree", "git-branch", "In a separate worktree", "Its own folder and thread. Nothing you have open moves.")}
            {item("local", "folder-git-2", "In this repository", "Switches the branch you are working in.")}
          </View>
        </Popup>
      ) : null}
    </View>
  );
}

