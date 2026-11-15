// A virtualised grid of rows (files/VirtualTablePreview.tsx): a number column, column headers (the file's header row, else
// A, B, C), 29 px rows with every other one tinted. The list draws only the rows in view, so a sheet or a table of a million rows
// costs the rows on screen; a row's cells are read when it is drawn.
import { computed, effect, List, Scroll, signal, Text, View } from "nsh";
import type { ListRef } from "nsh";

export function columnLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}

const CHAR = 7;
const SAMPLE = 200;

/** Widths in points from the first rows, the header and the column letters: 128 at least, 320 at most. */
export function gridColumnWidths(columns: number, header: readonly string[] | undefined, row: (index: number) => readonly string[], first: number, count: number): number[] {
  const widths: number[] = [];
  for (let column = 0; column < columns; column++) widths[column] = (header?.[column] ?? columnLabel(column)).length * CHAR + 24;
  for (let index = first; index < Math.min(count, first + SAMPLE); index++) {
    const cells = row(index);
    for (let column = 0; column < Math.min(columns, cells.length); column++) widths[column] = Math.max(widths[column] ?? 0, (cells[column]?.length ?? 0) * CHAR + 24);
  }
  return widths.map((width) => Math.min(320, Math.max(128, width)));
}

export interface FileGridProps {
  name: string;
  /** Rows including the header row when there is one. */
  count: number;
  columns: number;
  header?: readonly string[] | undefined;
  row: (index: number) => readonly string[];
  wrap: () => boolean;
  /** A zero-based row to scroll to the middle (a line the file was opened at). */
  revealRow?: number | null | undefined;
}

export function FileGrid(props: FileGridProps) {
  const first = () => (props.header ? 1 : 0);
  const rows = computed(() => Array.from({ length: Math.max(0, props.count - first()) }, (_value, offset) => offset + first()));
  const widths = computed(() => gridColumnWidths(props.columns, props.header, props.row, first(), props.count));
  const gutter = () => Math.max(3, String(props.count).length) * CHAR + 20;
  const list = signal<ListRef | null>(null);
  effect(() => {
    const target = props.revealRow;
    const current = list();
    if (target === null || target === undefined || !current) return;
    const index = Math.max(0, target - first());
    const frame = requestAnimationFrame(() => current.scrollToIndex({ index, animated: false, viewPosition: 0.5 }));
    return () => cancelAnimationFrame(frame);
  });
  const cell = (text: string, width: number, strong: boolean) => (
    <View style={{ width }} class="min-h-[29px] shrink-0 justify-center border-r border-border-60 px-3 py-1.5">
      <Text class={`text-xs ${strong ? "font-medium" : ""} text-foreground ${props.wrap() ? "" : "truncate"}`}>{text}</Text>
    </View>
  );
  return (
    <View class="min-h-0 flex-1" accessibilityLabel={props.name} role="table">
      <Scroll horizontal class="min-h-0 flex-1" contentClass="min-h-0">
        <View class="min-h-0 flex-1">
          <View class="min-h-[29px] shrink-0 flex-row border-b border-border bg-muted-40" accessibilityLabel="Table header">
            <View style={{ width: gutter() }} class="shrink-0 border-r border-border bg-background" />
            {Array.from({ length: props.columns }, (_value, column) => cell(props.header?.[column] ?? columnLabel(column), widths()[column] ?? 128, true))}
          </View>
          <List ref={(node) => list.set(node)} each={rows()} keyExtractor={(index) => String(index)} class="min-h-0 flex-1" contentClass="pb-4" estimatedItemSize={29} testID="Table rows">
            {(index) => (
              <View testID="Table row" accessibilityLabel={`Row ${index() + (props.header ? 0 : 1)}`} class={`min-h-[29px] flex-row border-b border-border-60 ${(index() - first()) % 2 ? "bg-muted-30" : ""}`}>
                <View style={{ width: gutter() }} class="shrink-0 justify-center border-r border-border bg-background px-2 py-1.5"><Text class="text-right text-xs text-muted-foreground">{String(index() + (props.header ? 0 : 1))}</Text></View>
                {Array.from({ length: props.columns }, (_value, column) => cell(props.row(index())[column] ?? "", widths()[column] ?? 128, false))}
              </View>
            )}
          </List>
        </View>
      </Scroll>
    </View>
  );
}
