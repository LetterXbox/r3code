// TimelinePendingApprovalRow.tsx: "Why am I being asked this?" is a PopoverTrigger with openOnHover whose
// tooltip-style popup explains why full access still asks. Opens on hover (300 ms) or press; closes on leaving trigger and popup,
// a press outside or Escape.
import { signal, Text, View } from "nsh";
import { createAnchor, hoverOpen, Popup } from "../composer/Popover";
import { FULL_ACCESS_OVERRIDE_QUESTION, fullAccessOverrideExplanation } from "./approvalLogic";

export function FullAccessOverrideQuestion(props: { override: () => string }) {
  const open = signal(false);
  const anchor = createAnchor();
  const { hover, cancel } = hoverOpen((next) => open.set(next));
  return (
    <View
      ref={anchor.ref}
      class="rounded px-1 hover:bg-accent"
      role="button"
      accessibilityLabel={FULL_ACCESS_OVERRIDE_QUESTION}
      onMouseEnter={hover.onMouseEnter}
      onMouseLeave={hover.onMouseLeave}
      onPress={() => { cancel(); open.set(!open()); }}
    >
      <Text class="text-xs font-medium text-muted-foreground">{FULL_ACCESS_OVERRIDE_QUESTION}</Text>
      {open() ? (
        <Popup anchor={anchor.anchor} onClose={() => open.set(false)} placement="top" align="center" animated class="max-w-[352px] px-2 py-1">
          <View accessibilityLabel={FULL_ACCESS_OVERRIDE_QUESTION} onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
            <Text class="text-xs text-popover-foreground">{fullAccessOverrideExplanation(props.override())}</Text>
          </View>
        </Popup>
      ) : null}
    </View>
  );
}
