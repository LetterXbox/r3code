// An Input for fields inside a Dialog (SettingsDialog and the other modal cards).
//
// On the GPUI host a click on an Input inside a Dialog never reaches the field: it goes to the nearest view with a press
// handler around it or under it instead (the card's keepPressInDialog, or the dialog's backdrop, which closed the dialog),
// so the field took no focus and no text (VERIFY3 8g, the scheduled-task Name and Base branch fields). Seen in a fixture
// window (workspace/termfix/fixture.tsx): a pressable box right around the Input takes that press, and focusing the field
// from it gives the field the caret and the keys. So the press lands here and moves the focus into the field.
import { Input } from "nsh/base";
import { View } from "nsh";

type InputProps = Parameters<typeof Input>[0];

export function DialogInput(props: InputProps & { ref?: (node: any) => void }) {
  let node: any;
  return (
    <View onPress={() => node?.focus?.()} focusable={false} class={/(^|\s)flex-1(\s|$)/.test(String(props.class ?? "")) ? "min-w-0 flex-1 flex-row" : "min-w-0"}>
      <Input {...props} ref={(next: any) => { node = next; props.ref?.(next); }} />
    </View>
  );
}
