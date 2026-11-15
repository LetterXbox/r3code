// ui/dialog.tsx DialogPopup showCloseButton (default true): the ghost icon button at the card's top-right corner,
// aria-label "Close". The card it sits in must be `relative`.
import { View } from "nsh";
import { HIcon } from "./header/HeaderIcons";

export function DialogCloseButton(props: { onClose: () => void; disabled?: boolean }) {
  return (
    <View
      role="button"
      accessibilityLabel="Close"
      disabled={props.disabled}
      onPress={() => { if (!props.disabled) props.onClose(); }}
      class="absolute right-2 top-2 z-10 size-7 items-center justify-center rounded-lg hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
    >
      <HIcon name="x" size={16} />
    </View>
  );
}
