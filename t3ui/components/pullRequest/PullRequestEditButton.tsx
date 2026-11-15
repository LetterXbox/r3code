// The pencil beside an editable body (PullRequestEditButton.tsx): hidden until the nearest card (the
// comment or description it sits in) is hovered or holds focus, then opacity 150ms (the web's
// `transition-opacity`). The web does this with `group`/`group-hover:`/`group-focus-within:`; that
// combinator does not reach a descendant on this runtime's GPUI host (workspace/nsh-runtime-bugs.md),
// so the caller tracks its own hover with `createHover()` and passes it in; this button tracks its
// own focus itself, since it stays focusable (and so reachable by keyboard) while invisible.
import { signal, View } from "nsh";
import { PRIcon } from "./PRIcon";

export function PullRequestEditButton(props: { label: string; onPress: () => void; hovered: () => boolean }) {
  const focused = signal(false);
  const visible = () => props.hovered() || focused();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      onFocus={() => focused.set(true)}
      onBlur={() => focused.set(false)}
      class={`size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent-50 active:scale-[0.97] transition-all duration-150 ease-in-out ${visible() ? "opacity-100" : "opacity-0"}`}
    >
      <PRIcon name="pencil" size={12} />
    </View>
  );
}

