// The strips and states the file viewers share (files/fileSurfaceChrome.tsx in the web app): the sub-header's icon actions,
// the warning notice, the loading mark and the failure with its retry.
import { Image, Text, View } from "nsh";
import { Tooltip } from "nsh/base";
import { HIcon } from "../header/HeaderIcons";
import { Spinner } from "../sidebar/Spinner";
import code from "./icons/code.svg";
import table2 from "./icons/table-2.svg";
import copy from "../header/icons/copy.svg";
import minus from "./icons/minus.svg";
import scan from "./icons/scan.svg";
import maximize from "./icons/maximize.svg";
import rotateCcw from "./icons/rotate-ccw.svg";

/** FILE_SURFACE_SUBHEADER_CLASS: a 40 px strip with a hairline under it. */
export const FILE_SURFACE_SUBHEADER_CLASS = "h-10 min-h-10 shrink-0 flex-row items-center gap-2 border-b border-border-60 bg-background px-3";

const LOCAL_ICONS = { code, "table-2": table2, copy, minus, scan, maximize, "rotate-ccw": rotateCcw } as const;

/** One mark of a file surface action: the local ones the shared sets lack, the rest through HIcon. */
export function FileSurfaceIcon(props: { name: string; size?: number }) {
  const size = props.size ?? 14;
  const local = LOCAL_ICONS[props.name as keyof typeof LOCAL_ICONS];
  return local ? <Image src={local} fadeDuration={0} style={{ width: size, height: size }} /> : <HIcon name={props.name} size={size} />;
}

function Tip(props: { text: string }) {
  return <Tooltip class="rounded-md border border-border bg-popover px-2 py-1"><Text class="text-xs text-popover-foreground">{props.text}</Text></Tooltip>;
}

/** FileSurfaceAction: a ghost icon button with a tooltip; `pressed` makes it a toggle. */
export function FileSurfaceAction(props: { label: string; icon: string; pressed?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ ...(props.pressed === undefined ? {} : { pressed: props.pressed }), disabled: props.disabled === true }}
      disabled={props.disabled === true}
      tooltip={<Tip text={props.label} />}
      onPress={props.onPress}
      class={`size-7 shrink-0 items-center justify-center rounded-lg ${props.disabled ? "opacity-40" : props.pressed ? "bg-accent" : "hover:bg-accent"}`}
    >
      <FileSurfaceIcon name={props.icon} />
    </View>
  );
}

/** FileSurfaceNotice: a status strip in the warning colours. */
export function FileSurfaceNotice(props: { text: string }) {
  return (
    <View accessibilityLabel={props.text} class="shrink-0 border-b border-warning-8 bg-warning-surface px-3 py-1.5">
      <Text class="text-2xs text-warning-foreground">{props.text}</Text>
    </View>
  );
}

export function FileSurfaceLoading() {
  return (
    <View accessibilityLabel="Loading file" class="min-h-0 flex-1 items-center justify-center">
      <Spinner size={24} />
    </View>
  );
}

export function FileSurfaceFailure(props: { message: string; onRetry?: () => void }) {
  return (
    <View role="alert" class="min-h-0 flex-1 items-center justify-center gap-3 px-6">
      <Text class="text-center text-xs leading-relaxed text-destructive">{props.message}</Text>
      {props.onRetry ? (
        <View role="button" accessibilityLabel="Try again" onPress={props.onRetry} class="rounded-md border border-input px-2.5 py-1 hover:bg-accent">
          <Text class="text-xs text-foreground">Try again</Text>
        </View>
      ) : null}
    </View>
  );
}
