// The shared pieces of the diagnostics page, ported from DiagnosticsSettings.tsx and ResourceTelemetryDiagnostics.tsx:
// stat blocks, the icon-header section card, the checked-at label, refresh and copy buttons, error lines, the segmented
// window selector and the table scaffolding. Colours carry the reference's alphas through tokenAlpha (NSH squares `/NN`).
import { FadeScroll } from "../../components/FadeScroll";
import { effect, Clipboard, Scroll, signal, Text, token, View } from "nsh";
import { tokenAlpha } from "../../components/composer/tokenColor";
import { DiagnosticsIcon } from "./DiagnosticsIcon";
import { Tip } from "./providers/ui";
import { relativeParts } from "./resourceTelemetryLogic";

export type Tone = "default" | "warning" | "danger";

const mutedAlpha = (alpha: number) => tokenAlpha("muted-foreground", alpha);

/** A card with an icon heading (`SettingsSection` with `icon`) whose children may fill it edge to edge. */
export function IconSection(props: { title: string; icon?: string; headerAction?: any; children: any }) {
  return (
    <View class="gap-2.5" accessibilityLabel={`${props.title} section`}>
      <View class="min-h-7 flex-row items-start justify-between gap-4 px-4">
        <View class="min-h-7 flex-row items-center gap-2">
          {props.icon ? <DiagnosticsIcon name={props.icon} size={16} tint={token("muted-foreground")} /> : null}
          <Text class="text-base font-semibold text-foreground">{props.title}</Text>
        </View>
        <View class="min-h-7 min-w-7 flex-row items-center justify-end">{props.headerAction ?? null}</View>
      </View>
      <View class="overflow-hidden rounded-xl border border-border-60 bg-card-40">{props.children}</View>
    </View>
  );
}

/** One stat of a grid: an uppercase label, a mono value, an optional info tooltip (StatBlock). */
export function StatBlock(props: { label: string; value: string; tooltip?: string; tone?: Tone }) {
  return (
    <View class="min-w-0 flex-1 px-5 py-3" testID={`Stat ${props.label}`}>
      <View class="min-w-0 flex-row items-center gap-1.5">
        <Text class="min-w-0 truncate text-2xs font-medium uppercase tracking-widest" style={{ color: mutedAlpha(0.7) }}>{props.label}</Text>
        {props.tooltip ? (
          <View accessibilityLabel={`${props.label} details`} role="button" class="size-3.5 shrink-0 items-center justify-center rounded-sm" tooltip={<Tip label={props.tooltip} />}>
            <DiagnosticsIcon name="info" size={12} tint={mutedAlpha(0.6)} />
          </View>
        ) : null}
      </View>
      <Text
        class={`mt-1 truncate font-mono text-lg font-semibold ${props.tone === "danger" ? "text-destructive" : props.tone === "warning" ? "text-warning-foreground" : "text-foreground"}`}
      >{props.value}</Text>
    </View>
  );
}

/** The stats of one card, four to a row with hairlines between (StatsGrid). */
export function StatsGrid(props: { children: any }) {
  return <View class="flex-row">{props.children}</View>;
}

export function Divider() {
  return <View class="h-px bg-border-60" />;
}

/** `Checked 3m ago`, `Checking`, or `Updated 5m ago` for the telemetry card; refreshed every ten seconds. */
const clock = signal(Date.now());
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockUsers = 0;
function useClock() {
  effect(() => {
    clockUsers++;
    if (clockTimer === null) clockTimer = setInterval(() => clock.set(Date.now()), 10_000);
    return () => {
      clockUsers--;
      if (clockUsers <= 0 && clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; clockUsers = 0; }
    };
  });
}

export function RelativeLabel(props: { at: () => string | null; prefix: string; missing: string; invalid?: string }) {
  useClock();
  const text = () => {
    const at = props.at();
    if (at === null) return props.missing;
    const parts = relativeParts(at, clock());
    if (parts === null) return props.invalid ?? props.missing;
    return parts.suffix ? `${props.prefix} ${parts.value} ${parts.suffix}` : `${props.prefix} ${parts.value}`;
  };
  return <Text class="text-2xs" style={{ color: mutedAlpha(0.6) }}>{text()}</Text>;
}

/** A square icon button (`size="icon-xs"` / `icon-micro`), with its tooltip. */
export function IconAction(props: { label: string; icon: string; tooltip?: string; disabled?: boolean; onPress: () => void; size?: number; testID?: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      disabled={props.disabled}
      onPress={props.onPress}
      tooltip={<Tip label={props.tooltip ?? props.label} />}
      class={`${props.size === 12 ? "size-5 rounded-sm" : "size-6 rounded-lg"} items-center justify-center hover:bg-accent ${props.disabled ? "opacity-50" : ""}`}
    >
      <DiagnosticsIcon name={props.icon} size={props.size ?? 14} tint={token("muted-foreground")} />
    </View>
  );
}

export function RefreshAction(props: { label: string; pending: boolean; onPress: () => void; tooltip?: string }) {
  return <IconAction label={props.label} icon="refresh-cw" tooltip={props.tooltip ?? props.label} disabled={props.pending} onPress={props.onPress} />;
}

/** A trace id that shortens in a cell and copies whole (TraceIdCell). */
export function TraceIdCell(props: { traceId: string; short: string }) {
  const copied = signal(false);
  const copy = () => {
    void Clipboard.writeText(props.traceId).then(() => { copied.set(true); setTimeout(() => copied.set(false), 1_200); }, () => undefined);
  };
  return (
    <View class="w-full min-w-0 flex-row items-center gap-2">
      <View class="min-w-0 flex-1" tooltip={<Tip label={props.traceId} />}><Text class="truncate font-mono text-2xs text-foreground">{props.short}</Text></View>
      <IconAction label={copied() ? "Copied trace ID" : "Copy trace ID"} icon="copy" tooltip={copied() ? "Copied" : "Copy full trace ID"} onPress={copy} size={12} />
    </View>
  );
}

/** A red or amber line with the alert mark, for a failed read inside a card (`AlertTriangleIcon` rows). */
export function ErrorLine(props: { message: string; tone?: "destructive" | "warning" }) {
  const color = () => (props.tone === "warning" ? token("warning-foreground") : token("destructive"));
  return (
    <View class="flex-row items-start gap-2">
      <View class="pt-0.5"><DiagnosticsIcon name="triangle-alert" size={14} tint={color()} /></View>
      <Text class={`min-w-0 flex-1 text-xs ${props.tone === "warning" ? "text-warning-foreground" : "text-destructive"}`}>{props.message}</Text>
    </View>
  );
}

/** A block of `ErrorLine`s under a hairline; nothing when there are none. */
export function ErrorBlock(props: { lines: () => { message: string; tone?: "destructive" | "warning" }[] }) {
  return (
    <>
      {props.lines().length > 0 ? (
        <View>
          <Divider />
          <View class="gap-2 px-5 py-3">
            <Each of={props.lines()} key={(line) => line.message}>{(line) => <ErrorLine message={line().message} tone={line().tone} />}</Each>
          </View>
        </View>
      ) : null}
    </>
  );
}

/** The segmented selector of a history window (`ToggleGroup variant="segmented"`). */
export function WindowSelector(props: { label: string; options: { label: string; value: number }[]; selected: () => number; onSelect: (value: number) => void }) {
  return (
    <View role="group" accessibilityLabel={props.label} class="flex-row items-center gap-0.5 rounded-lg bg-segmented-track p-0.5">
      <Each of={props.options} key={(option) => String(option.value)}>
        {(option) => (
          <View
            role="button"
            accessibilityLabel={option().label}
            accessibilityState={{ selected: props.selected() === option().value }}
            onPress={() => props.onSelect(option().value)}
            class={props.selected() === option().value ? "rounded-md bg-segmented-active px-2.5 py-1 transition-colors duration-150 ease-in-out" : "rounded-md px-2.5 py-1 hover:bg-segmented-hover transition-colors duration-150 ease-in-out"}
          >
            <Text class="text-xs font-medium text-foreground">{option().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The widths of a table's columns, from the reference's `<col>` percentages and its minimum table width. */
export const columnWidths = (total: number, percents: readonly number[]) => percents.map((percent) => Math.round((total * percent) / 100));

/** A horizontally scrolling table: a header row of uppercase labels over rows built by `children`. */
export function DataTable(props: { total: number; percents: readonly number[]; headers: readonly string[]; right: readonly boolean[]; children: any }) {
  const widths = columnWidths(props.total, props.percents);
  return (
    <FadeScroll horizontal class="w-full">
      <View style={{ width: props.total }}>
        <View class="flex-row items-center border-b border-border-60 py-2">
          <Each of={props.headers.map((header, index) => ({ header, index }))} key={(entry) => entry.header}>
            {(entry) => (
              <View style={{ width: widths[entry().index] }} class={`px-4 ${entry().index === 0 ? "pl-5" : ""} ${props.right[entry().index] ? "items-end" : ""}`}>
                <Text class="text-3xs font-semibold uppercase tracking-widest" style={{ color: mutedAlpha(0.65) }}>{entry().header}</Text>
              </View>
            )}
          </Each>
        </View>
        {props.children}
      </View>
    </FadeScroll>
  );
}

/** A body row of a `DataTable`: cells at the given widths with a hairline above. */
export function TableRow(props: { widths: readonly number[]; children: any; testID?: string }) {
  return (
    <View class="min-h-9 flex-row items-center border-t border-border-50 hover:bg-muted-10 py-1" testID={props.testID}>
      {props.children}
    </View>
  );
}

export function Cell(props: { width: number; first?: boolean; right?: boolean; children: any }) {
  return <View style={{ width: props.width }} class={`min-w-0 px-4 ${props.first ? "pl-5" : ""} ${props.right ? "items-end" : ""}`}>{props.children}</View>;
}

export function MonoText(props: { children: any; tone?: "default" | "info" | "warning" | "muted" }) {
  const cls = props.tone === "info" ? "text-info-foreground" : props.tone === "warning" ? "text-warning-foreground" : props.tone === "muted" ? "text-muted-foreground" : "text-foreground";
  return <Text class={`font-mono text-xs ${cls}`}>{props.children}</Text>;
}

export function EmptyRow(props: { label: string }) {
  return <View class="border-t border-border-50 px-5 py-4"><Text class="text-xs text-muted-foreground">{props.label}</Text></View>;
}
