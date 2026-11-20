// UserMessageContextChips.tsx preview-annotation: a chip (MousePointerClick, the record's label) whose popover is
// UserMessagePreviewAnnotationDetails: the annotated crop (the message's screenshot image, resolvePreviewAnnotationImage)
// or "Screenshot unavailable", then the page title, the comment, the target summary, the style change count and the
// picked elements.
import { signal, Text, View } from "nsh";
import { Popover } from "nsh/base";
import { DIcon } from "../../device/DeviceIcons";
import { trackOpenChange, useOverlayOpen } from "../../rightPanel/nativeOcclusion";
import { Thumbnail } from "../MessageMedia";
import { readAttachment } from "../readAttachment";
import { chipColor, type ContextChipRecord } from "./contextChips";

export function PreviewAnnotationChip(props: { record: ContextChipRecord; label: string; onOpenImage?: ((image: NonNullable<ContextChipRecord["annotationImage"]>) => void) | undefined }) {
  const open = signal(false);
  useOverlayOpen(open, "preview annotation popover");
  const color = chipColor("preview-annotation");
  const r = props.record;
  return (
    <View style={{ verticalAlign: "middle" }}>
      <Popover
        onOpenChange={trackOpenChange(open)}
        placement="top"
        popupClass="w-96 rounded-lg border border-border bg-popover-84 p-2"
        trigger={
          <View class="flex-row items-center gap-[3px] rounded-sm" accessibilityLabel={`Preview annotation, ${props.label}`} role="button">
            <DIcon name="mouse-pointer-click" size={12} {...(color ? { tint: color } : {})} />
            <Text class="max-w-72 truncate font-medium leading-none" style={color ? { color } : undefined}>{props.label}</Text>
          </View>
        }
      >
        <View class="max-w-full overflow-hidden rounded-lg border border-border-70 bg-background">
          {r.annotationImage ? (
            <Thumbnail attachment={r.annotationImage as never} load={readAttachment} class="h-64 w-full border-b border-border-70 bg-muted" fit="contain" onOpen={() => { if (r.annotationImage) props.onOpenImage?.(r.annotationImage); }} />
          ) : (
            <View class="border-b border-border-70 bg-muted px-3 py-2"><Text class="text-xs text-muted-foreground">Screenshot unavailable</Text></View>
          )}
          <View class="min-w-0 px-3 py-2.5">
            <Text class="text-xs font-medium text-foreground">{r.pageTitle?.trim() || r.pageUrl || "Preview annotation"}</Text>
            {r.comment ? <Text class="mt-1 text-sm text-foreground">{r.comment}</Text> : null}
            <View class="mt-1 flex-row items-center gap-2">
              {r.targetSummary ? <Text class="truncate text-3xs text-muted-foreground">{r.targetSummary}</Text> : null}
              {(r.styleChangeCount ?? 0) > 0 ? (
                <Text class="text-3xs text-muted-foreground" accessibilityLabel={`${r.styleChangeCount} style changes`}>{String(r.styleChangeCount)}</Text>
              ) : null}
            </View>
            {(r.annotationElements?.length ?? 0) > 0 ? (
              <View class="mt-2 gap-2 border-t border-border-60 pt-2">
                {(r.annotationElements ?? []).map((element) => (
                  <View class="min-w-0">
                    <View class="min-w-0 flex-row items-center gap-2">
                      <Text class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{element.selector || `<${element.tagName}>`}</Text>
                      {element.sourceLabel ? <Text class="shrink-0 text-xs text-muted-foreground">{element.sourceLabel}</Text> : null}
                    </View>
                    {element.htmlPreview.trim() ? <View class="mt-1 max-h-24 rounded bg-muted px-2 py-1.5"><Text class="font-mono text-3xs text-foreground">{element.htmlPreview.trim()}</Text></View> : null}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        </View>
      </Popover>
    </View>
  );
}
