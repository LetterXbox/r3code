// Loads the generated terminal page and reports which of the markers it was asked about it contains.
import { mount, signal, Text, View } from "nsh";
import { loadTerminalDocument } from "./terminalDocument";

export const PAGE_MARKERS = [
  // Page to app: the menus, the selection actions, the links and the mapped keys' failure copy.
  '"contextmenu"', '"selection-action"', '"link-check"', '"open-path"', '"open-link"', "forceBrowser",
  "Failed to move cursor", "Failed to delete terminal input", "Failed to clear terminal",
  // App to page: menu actions, paste, the link answers, the shared grid and the palette.
  '"menu-action"', '"add-to-chat-request"', '"add-to-chat-selection"', '"link-checked"', '"grid"', "selectionBackground",
];

const result = signal("loading");
void loadTerminalDocument().then((html) => {
  const missing = PAGE_MARKERS.filter((marker) => !html.includes(marker));
  result.set(html.startsWith("<!doctype html>") && missing.length === 0 ? "page:complete" : `page:missing ${missing.join(" ")}`);
}).catch((error: unknown) => result.set(`page:error ${String(error)}`));

mount(() => <View><Text>{result()}</Text></View>);
