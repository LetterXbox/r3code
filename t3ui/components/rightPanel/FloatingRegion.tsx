// Wraps a floating surface that should occlude only the WebViews it overlaps (a tooltip or hover card's content):
// while mounted and laid out, its page rectangle is registered with the occlusion registry.
import { signal, View } from "nsh";
import { measureInto, useFloatingRect, type PageRect } from "./nativeOcclusion";

export function FloatingRegion(props: { label: string; children?: unknown }) {
  const rect = signal<PageRect | null>(null);
  let node: { measure(): Promise<any> } | undefined;
  useFloatingRect(() => rect(), props.label);
  return <View ref={(n: any) => { node = n; }} onLayout={() => measureInto(node, rect)}>{props.children as never}</View>;
}
