// The `[ ]` / `[x]` of a message's task items (packages/shared markdownTaskList.ts): the n-th task the view draws is the n-th
// marker in the source, outside fenced code, so a toggle writes the new state back at that marker. Pure.

const TASK_LINE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d+[.)])[ \t]+)\[[ xX]\]/;

/** Offsets of the `[` of each task marker, in reading order. */
export function taskMarkerOffsets(markdown: string): number[] {
  const offsets: number[] = [];
  let fence: { marker: string } | null = null;
  let position = 0;
  for (const line of markdown.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.marker.length) fence = null;
    } else if (open) {
      fence = { marker: open[1]! };
    } else {
      const match = TASK_LINE.exec(line);
      if (match) offsets.push(position + match[1]!.length);
    }
    position += line.length + 1;
  }
  return offsets;
}

/** The markdown with the task marker at `markerOffset` set to `checked`; unchanged when no marker is there. */
export function setMarkdownTaskChecked(markdown: string, markerOffset: number, checked: boolean): string {
  if (markerOffset < 0 || markdown[markerOffset] !== "[" || !/[ xX]/.test(markdown[markerOffset + 1] ?? "") || markdown[markerOffset + 2] !== "]") return markdown;
  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
