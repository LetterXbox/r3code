// Port of chat/MarkdownMermaidCodeBlock.tsx: a mermaid fence draws as its diagram, with a toggle to its source
// ("Show code" / "Show diagram") and the copy button; a diagram that cannot be drawn keeps the source card, under
// the reason. While the reply streams the source shows, as in the web app.
import { colorScheme, computed, Image, signal, Text, token, View } from "nsh";
import type { ViewProps } from "nsh";
import { mixColors } from "../../sidebar/mix";
import { CopyIconButton, MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { pelePalette, renderMermaid } from "./mermaid";
import { TimelineIcon } from "./TimelineIcon";
import { expandMedia } from "./ExpandedMedia";
import { activeFindQuery, threadFindActive } from "../threadFindState";

export function MermaidCodeBlock(props: { code: () => string; open?: () => boolean; title?: () => string | null; findRowId?: () => string }) {
  const showCode = signal(false);
  const palette = computed(() => { colorScheme(); return pelePalette((name) => String(token(name as never)), mixColors); });
  const result = computed(() => (props.code().trim() === "" || props.open?.() === true ? null : renderMermaid(props.code(), palette())));
  // markdownFindContext: a find match inside the diagram's source shows the source, where the match is drawn.
  // Only the row holding the active match reveals its source (beforematch); a block with no row: any match.
  const findInSource = () => { const query = activeFindQuery().toLowerCase(); const rowId = props.findRowId?.(); return query !== "" && (rowId === undefined || threadFindActive()?.rowId === rowId) && props.code().toLowerCase().includes(query); };
  const diagram = () => { const current = result(); return !showCode() && !findInSource() && current !== null && current.ok ? current : null; };
  const toggleLabel = () => (showCode() ? "Show diagram" : "Show code");
  const toggle = (): ViewProps["children"] => (
    result() === null || !result()?.ok ? null : (
      <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel={toggleLabel()} tooltip={toggleLabel()} role="button" onPress={() => showCode.update((value) => !value)}>
        <TimelineIcon name={showCode() ? "workflow" : "code"} size={12} />
      </View>
    )
  );
  return (
    <View>
      {diagram() ? (
        <View class="border border-transparent" testID="Mermaid diagram">
          <View class="flex-row items-center justify-end gap-0.5 pr-1.5 pt-1.5" role="toolbar" accessibilityLabel="Diagram actions">
            {toggle()}
            <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel="Expand diagram" tooltip="Expand diagram" role="button" onPress={() => expandMedia({ items: [{ name: "Mermaid diagram", kind: "image", source: { kind: "url", url: diagram()?.url ?? "" } }], index: 0 })}>
              <TimelineIcon name="maximize-2" size={12} />
            </View>
            <CopyIconButton text={props.code} label="Copy code" />
          </View>
          <View class="w-full items-center py-2">
            <Image src={diagram()?.url ?? ""} accessibilityLabel="Mermaid diagram" style={{ width: diagram()?.width ?? 0, height: diagram()?.height ?? 0, maxWidth: "100%", objectFit: "contain" }} />
          </View>
        </View>
      ) : (
        <View>
          {result() !== null && !result()?.ok ? <Text class="pb-1 text-xs text-destructive" role="alert">{`Unable to render diagram: ${(result() as { message: string }).message}`}</Text> : null}
          <MarkdownCodeBlock flush code={props.code} language={() => "mermaid"} open={props.open} title={props.title} viewToggle={toggle()} />
        </View>
      )}
    </View>
  );
}
