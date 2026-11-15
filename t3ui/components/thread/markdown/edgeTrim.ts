// index.css `.chat-markdown > :first-child { margin-top: 0 }` and `> :last-child { margin-bottom: 0 }`:
// TextView has no child selectors, so the first block's top margin and the last block's bottom
// margin are cancelled with a negative margin of the same size on the wrapper.
// Margins come from CHAT_MARKDOWN_CLASSES: paragraphs, lists, quotes, tables 0.65rem; headings
// 1.25rem above and 0.5rem below; rules 1rem; details 0.5rem.
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const DETAILS = /^\s*<\/?(details|summary)\b/i;

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function lastLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) if (lines[index].trim() !== "") return lines[index];
  return "";
}

/** The wrapper class that cancels the first block's top margin, for a text segment that opens the message. */
export function trimTopClass(text: string): string {
  const line = firstLine(text);
  if (HEADING.test(line)) return "-mt-5";
  if (RULE.test(line)) return "-mt-4";
  if (DETAILS.test(line)) return "-mt-2";
  return "-mt-[0.65rem]";
}

/** The wrapper class that cancels the last block's bottom margin, for a text segment that closes the message. */
export function trimBottomClass(text: string): string {
  const line = lastLine(text);
  if (HEADING.test(line)) return "-mb-2";
  if (RULE.test(line)) return "-mb-4";
  if (DETAILS.test(line)) return "-mb-2";
  return "-mb-[0.65rem]";
}
