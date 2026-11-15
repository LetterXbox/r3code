import { settingValue } from "../../store";

export function chatWidthClass() {
  const width = settingValue("chatWidth");
  return width === "wide" ? "max-w-[1152px]" : width === "full" ? "" : "max-w-[736px]";
}

export function enterSubmits(shortcut: string | boolean | number | undefined, draft: string) {
  if (shortcut === "mod-enter") return false;
  if (shortcut === "mod-enter-multiline") return !draft.includes("\n");
  return true;
}
