// A native popup menu that makes the WebViews step aside while it is open (nativeOcclusion.ts).
import { Menu } from "nsh/desktop";
import type { MenuItem } from "nsh/desktop";
import { registerOverlay } from "../rightPanel/nativeOcclusion";

export function popupOverOverlay(items: readonly (MenuItem | null | undefined | false)[], at?: { x: number; y: number }, label = "file menu"): Promise<void> {
  const release = registerOverlay(label);
  return Menu.popup(items, at).then(release, release);
}
