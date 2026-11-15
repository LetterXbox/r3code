// ui/middle-truncate.tsx: a one-line name cut in the middle, so the end that tells names apart stays visible
// ("feature/ui-po…" would hide what "feat…ui-polish" keeps). The value splits into a head that shrinks and a tail that
// never does; the head's own end ellipsis is the "…" in front of the tail. The full value is the tooltip
// (`title`) unless showTitle is false.
import { effect, signal, Text, untracked, View } from "nsh";

const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;
const MIN_WORD_TAIL = 4;
const WORD_BREAK = /[-_./]/;

/** splitForMiddleTruncate (middle-truncate.tsx): the head and the tail kept whole, or null when the value is too short to cut. */
export function splitForMiddleTruncate(value: string, tail?: number): { head: string; tail: string } | null {
  // Split by code point to avoid cutting surrogate pairs into broken glyphs.
  const chars = Array.from(value);
  let keep = tail ?? DEFAULT_TAIL;
  if (tail === undefined) {
    const slash = chars.lastIndexOf("/");
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1;
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null;
  let cut = chars.length - keep;
  // Start an automatic tail on a word ("machine", not "er-machine"). A shorter tail is preferred so the head stays
  // readable; a longer one is the fallback.
  if (tail === undefined && !WORD_BREAK.test(chars[cut - 1]!)) {
    const startsWord = (index: number) => WORD_BREAK.test(chars[index - 1]!);
    let snapped = -1;
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) { snapped = index; break; }
    }
    for (let index = cut - 1; snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4; index--) {
      if (startsWord(index)) snapped = index;
    }
    if (snapped > 0) cut = snapped;
  }
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

/** Whether a one-line layout of the value was cut: it wrapped, or its natural line is wider than the box. The whole
 * value is laid out unshrunk (shrink-0) so its line reports its natural width; a box that hugs its text reports the same
 * width as the line, so "fills the box" alone cannot tell a cut value from one that fits. */
export function textWasCut(lines: readonly { bounds: { size: { width: number } } }[], boxWidth: number): boolean {
  if (lines.length > 1) return true;
  const line = lines[0];
  return line !== undefined && boxWidth > 0 && line.bounds.size.width > boxWidth + 0.5;
}

/** `labelled: false` when the parent row already carries the value as its label (one label per row, not two). */
export function MiddleTruncate(props: { value: string; tail?: number; showTitle?: boolean; labelled?: boolean; class?: string; textClass?: string; textStyle?: Record<string, unknown> }) {
  // The reference cuts only an overflowing head; a value that fits stays one text. The whole value is laid out first;
  // when its line comes back cut, the head/tail split takes over, until the box grows again.
  const cut = signal(false);
  let width = 0;
  const split = () => (cut() ? splitForMiddleTruncate(props.value, props.tail) : null);
  const text = () => props.textClass ?? "";
  effect(() => { void props.value; untracked(() => cut.set(false)); });
  return (
    <View
      class={`min-w-0 flex-row overflow-hidden ${props.class ?? ""}`}
      accessibilityLabel={props.labelled === false ? undefined : props.value}
      onLayout={(event) => { const next = event.bounds.size.width; if (next > width + 0.5 && cut()) cut.set(false); width = next; }}
      {...(props.showTitle === false ? {} : { tooltip: props.value })}
    >
      {split() ? (
        <>
          <Text class={`min-w-0 shrink truncate ${text()}`} style={props.textStyle}>{split()!.head}</Text>
          <Text class={`shrink-0 truncate ${text()}`} style={props.textStyle}>{split()!.tail}</Text>
        </>
      ) : (
        <Text class={`shrink-0 truncate ${text()}`} style={props.textStyle} onTextLayout={(event) => { if (textWasCut(event.lines, width)) cut.set(true); }}>{props.value}</Text>
      )}
    </View>
  );
}
