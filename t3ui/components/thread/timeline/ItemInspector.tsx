// V2ItemInspector.tsx + CommandOutputPanel.tsx: an expanded work-log row drawn from the server's structured turn item.
import { expandMedia } from "../markdown/ExpandedMedia";
import { colorScheme, effect, Image, openUrl, signal, Text, View } from "nsh";
import type { ScrollRef } from "nsh";
import { FadeScroll } from "../../FadeScroll";
import { HighlightedCodeLines } from "../markdown/HighlightedCodeLines";
import { ChatMarkdown } from "../markdown/ChatMarkdown";
import { MarkdownImage } from "../markdown/MarkdownMedia";
import { TimelineIcon } from "../markdown/TimelineIcon";
import { codeTextStyle } from "../../../typography";
import { backendConnected, backendUrl, commandOutputStreaming, requestBackend, subscribeBackend } from "../../../store";
import { assetUrlFor } from "../../sidebar/projectIcon";
import {
  fileChangeLine, formatDiffCount, isJsonToolText, todoStepLines, toolCallLines, turnItemOutputImageCount, turnItemOutputText,
  userInputQuestionLines, workspaceRelativePath, type TurnItem,
} from "./turnItemDetail";
import { applyCommandOutputFrame, EMPTY_COMMAND_OUTPUT, readCommandOutputFrame, TERMINAL_PALETTES, terminalOutputSpans, type CommandOutputView } from "./commandOutput";
import { diffAdditionClass, diffDeletionClass } from "../../diff/diffColorScheme";

type Rec = Record<string, unknown>;
const MONO = "font-mono text-2xs leading-relaxed";

/** StructuredValue: a string or pretty JSON, highlighted when it is JSON (or the given language). */
export function StructuredValue(props: { value: unknown; highlightJson?: boolean; language?: "typescript" | "html" | "json" }) {
  const text = typeof props.value === "string" ? props.value : JSON.stringify(props.value, null, 2) ?? "";
  if (!text) return null;
  const language = props.language ?? (props.highlightJson && isJsonToolText(text) ? "json" : null);
  return (
    <FadeScroll surface="background" class="max-h-80">
      <View selectable>
      {language ? (
        <HighlightedCodeLines code={() => text} language={() => language} />
      ) : (
        <Text class={`${MONO} text-muted-foreground`} style={codeTextStyle()}>{text}</Text>
      )}
      </View>
    </FadeScroll>
  );
}

/** ShellCommandBlock: the command, monospace. */
function ShellCommandBlock(props: { command: string }) {
  return (
    <View selectable>
      <Text class={`${MONO} text-foreground`} style={codeTextStyle()}>{`$ ${props.command}`}</Text>
    </View>
  );
}

/** ChatMarkdownAssetImage for a `tool-output-image` asset: minted with assets.createUrl, at most 16rem tall. */
export function ToolOutputImage(props: { threadId: string; itemId: string; index: number; /** Test seams. */ endpoint?: string; request?: (method: string, payload: unknown) => Promise<unknown> }) {
  const src = signal<string | null>(null);
  const failed = signal(false);
  const endpoint = props.endpoint ?? backendUrl();
  void (props.request ?? requestBackend)("assets.createUrl", { resource: { _tag: "tool-output-image", threadId: props.threadId, itemId: props.itemId, index: props.index } })
    .then((response) => {
      const url = endpoint ? assetUrlFor(endpoint, (response as Rec | null)?.relativeUrl) : null;
      if (url) src.set(url); else failed.set(true);
    })
    .catch(() => failed.set(true));
  return (
    <View class="max-h-64">
      {src() ? (
        // V2ItemInspector: pressing a tool's image opens the expanded viewer (expandMedia).
        <View role="button" accessibilityLabel="Expand tool output image" onPress={() => expandMedia({ items: [{ name: "Tool output image", kind: "image", source: { kind: "url", url: src() ?? "" } }], index: 0 })}>
          <Image src={src() ?? ""} accessibilityLabel="Tool output image" style={{ objectFit: "contain" }} class="max-h-64 w-full rounded-md" onError={() => failed.set(true)} />
        </View>
      ) : failed() ? (
        <Text class="text-2xs text-muted-foreground">Tool output image</Text>
      ) : null}
    </View>
  );
}

export type ToolOutputState = { output: string | null; pending: boolean; error: string | null; empty: boolean };

function ToolOutput(props: { state: ToolOutputState; images: number }) {
  const state = props.state;
  return state.output ? (
    <StructuredValue value={state.output} highlightJson />
  ) : state.pending ? (
    <Text class="text-2xs italic text-muted-foreground">{"Loading output…"}</Text>
  ) : state.error ? (
    <Text class="text-2xs text-destructive">{`Couldn't load output: ${state.error}`}</Text>
  ) : state.empty && props.images === 0 ? (
    <Text class="text-2xs italic text-muted-foreground">No output.</Text>
  ) : null;
}

/** CommandOutputPanel: subscribes while mounted, so only expanded rows of the open thread receive frames. */
export function CommandOutputPanel(props: { threadId: string; itemId: string; subscribe?: typeof subscribeBackend }) {
  const view = signal<CommandOutputView | null>(null);
  let outputScroll: ScrollRef | null = null;
  let outputAtEnd = true;
  effect(() => { view(); if (outputAtEnd) requestAnimationFrame(() => outputScroll?.scrollToEnd({ animated: false })); });
  const error = signal<string | null>(null);
  effect(() => {
    backendConnected(); // a reconnect closes the stream: subscribe again
    const stop = (props.subscribe ?? subscribeBackend)("orchestration.subscribeCommandOutput", { threadId: props.threadId, itemId: props.itemId }, (value) => {
      const frame = readCommandOutputFrame(value);
      if (frame) view.update((current) => applyCommandOutputFrame(current ?? EMPTY_COMMAND_OUTPUT, frame));
    }, (cause) => error.set(cause.message));
    return stop;
  });
  const palette = () => TERMINAL_PALETTES[colorScheme() === "light" ? "light" : "dark"];
  return (
    <View>
      {(view()?.text ?? "").length === 0 ? (
        error() ? <Text class="text-2xs text-destructive">{`Couldn't load output: ${error()}`}</Text>
          : view() === null ? <Text class="text-2xs italic text-muted-foreground">{"Loading output…"}</Text>
          : view()?.running ? null : <Text class="text-2xs italic text-muted-foreground">No output.</Text>
      ) : (
        <View>
          {view()?.truncated ? <Text class="text-2xs italic text-muted-foreground">Earlier output not shown</Text> : null}
          {/* CommandOutputPanel: scrolls (max-h-80) and follows the tail while the reader is at the bottom (4 pt edge). */}
          <FadeScroll
            surface="background"
            class="max-h-80"
            ref={(node: ScrollRef | null) => { outputScroll = node; }}
            onScroll={(event) => { outputAtEnd = event.offset.y + event.size.height >= event.contentSize.height - 4; }}
          >
            <View selectable>
            <Text class={`${MONO} text-muted-foreground`} style={codeTextStyle()}>
              {terminalOutputSpans(view()?.text ?? "", palette()).map((span) => (span.style ? <Text style={span.style}>{span.text}</Text> : span.text))}
            </Text>
            </View>
          </FadeScroll>
        </View>
      )}
    </View>
  );
}

/** ToolCallBody: images, the command or the argument lines, the output, and `exit N` for a non-zero exit. */
function ToolCallBody(props: { item: TurnItem; command?: string; args?: unknown; toolName?: string | null; exitCode?: number; state: ToolOutputState; streams: boolean }) {
  const call = toolCallLines(props.command !== undefined ? { command: props.command } : { args: props.args });
  const images = turnItemOutputImageCount(props.item);
  const threadId = typeof props.item.threadId === "string" ? props.item.threadId : "";
  return (
    <View class="gap-1.5">
      {images > 0 && threadId ? Array.from({ length: images }, (_, index) => <ToolOutputImage threadId={threadId} itemId={props.item.id} index={index} />) : null}
      {call.command ? <ShellCommandBlock command={call.command} /> : null}
      {call.args ? (
        <View class="gap-0.5">
          {call.args.map(([key, value]) => (
            <View>
              <Text class={`${MONO} text-muted-foreground`} style={codeTextStyle()}>{`${key} `}</Text>
              {key === "html" ? <StructuredValue value={value} language="html" />
                : key === "code" && isJavaScriptReplTool(props.toolName) ? <StructuredValue value={value} language="typescript" />
                : isJsonToolText(value) ? <StructuredValue value={value} language="json" />
                : <View selectable><Text class={`${MONO} text-foreground`} style={codeTextStyle()}>{value}</Text></View>}
            </View>
          ))}
        </View>
      ) : null}
      {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
      {props.streams && threadId ? <CommandOutputPanel threadId={threadId} itemId={props.item.id} /> : <ToolOutput state={props.state} images={images} />}
      {props.exitCode !== undefined && props.exitCode !== 0 ? <Text class="text-2xs text-destructive">{`exit ${props.exitCode}`}</Text> : null}
    </View>
  );
}

/** isJavaScriptReplTool (shared toolActivity.ts). */
function isJavaScriptReplTool(toolName: string | null | undefined): boolean {
  return toolName === "js" || toolName === "cua_repl.js" || toolName === "node_repl.js";
}

/**
 * The inspector body for one item. `fetched` is the item `orchestration.getTurnItem` returned for a row whose
 * output the environment withheld; `fetchState` is that fetch's progress.
 */
/** turnItemDetailRevision: "live" while the item runs, else its updatedAt. */
export function toolDiffRevision(item: Record<string, unknown>): string {
  return ["idle", "pending", "running", "waiting"].includes(String(item.status)) ? "live" : String(item.updatedAt ?? "");
}

export function ItemInspector(props: {
  item: TurnItem;
  fetched?: TurnItem | null;
  fetchState?: "pending" | "ready" | "unavailable" | "error" | null;
  fetchError?: string | null;
  needsFetch?: boolean;
  workspaceRoot?: string | null;
  /** Shows the item's diff in place (the port's diff panel has no tool-call target yet). */
  diffSlot?: any;
  /** "Open diff": the tool call's own diff in the diff panel (useRightPanelActions onOpenToolDiff). */
  onOpenToolDiff?: (target: { threadId: string; itemId: string; revision: string }) => void;
}) {
  const wire = props.item;
  const streams = wire.type === "command_execution" && commandOutputStreaming();
  const item: TurnItem = props.fetched && props.fetched.type === wire.type ? props.fetched : wire;
  const it = item as Rec;
  const fromFetch = item !== wire;
  const state: ToolOutputState = {
    output: turnItemOutputText(item),
    pending: !fromFetch && props.fetchState === "pending",
    error: fromFetch ? null : props.fetchState === "unavailable" ? "Output is no longer available." : props.fetchState === "error" ? props.fetchError ?? null : null,
    empty: props.needsFetch === true && fromFetch,
  };
  const root = props.workspaceRoot;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return (
    <View class="gap-2">
      {item.type === "reasoning" && str(it.text) ? (
        <View class="rounded-md border border-border-60 bg-card-40 p-2">
          <ChatMarkdown text={() => str(it.text)} class="text-muted-foreground" />
        </View>
      ) : null}
      {item.type === "command_execution" ? (
        <ToolCallBody item={item} command={str(it.input)} exitCode={typeof it.exitCode === "number" ? it.exitCode : undefined} state={state} streams={streams} />
      ) : null}
      {item.type === "file_change" ? (
        <View class="gap-2">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text class={`${MONO} text-muted-foreground`} style={codeTextStyle()}>{workspaceRelativePath(str(it.fileName), root)}</Text>
            {typeof it.additions === "number" || typeof it.deletions === "number" ? (
              <View class="flex-row gap-1">
                <Text class={`text-2xs ${diffAdditionClass("text-success-foreground")}`}>{`+${formatDiffCount(typeof it.additions === "number" ? it.additions : 0)}`}</Text>
                <Text class={`text-2xs ${diffDeletionClass("text-error-foreground")}`}>{`-${formatDiffCount(typeof it.deletions === "number" ? it.deletions : 0)}`}</Text>
              </View>
            ) : null}
            {props.onOpenToolDiff && str(it.threadId) && str(it.id) ? (
              <View class="h-6 justify-center rounded-md border border-input px-2 hover:bg-accent" role="button" accessibilityLabel="Open diff" onPress={() => props.onOpenToolDiff?.({ threadId: str(it.threadId), itemId: str(it.id), revision: toolDiffRevision(it) })}>
                <Text class="text-xs text-foreground">Open diff</Text>
              </View>
            ) : null}
          </View>
          {props.diffSlot ?? null}
          {/* V2ItemInspector: a failed change shows the diff it tried to apply. */}
          {it.status === "failed" && str(it.diffStr).trim() ? <StructuredValue value={str(it.diffStr)} /> : null}
          {list<Rec>(it.changes).length > 0 ? (
            <View class="gap-1">
              {list<Rec>(it.changes).filter((change) => typeof change.path === "string").map((change) => (
                <Text class={`${MONO} text-muted-foreground`} style={codeTextStyle()}>{fileChangeLine(change as never, root)}</Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {item.type === "file_search" && str(it.pattern).trim() ? <View selectable><Text class={`${MONO} text-foreground`} style={codeTextStyle()}>{str(it.pattern)}</Text></View> : null}
      {item.type === "web_search" && list<string>(it.patterns).length > 0 ? <View selectable><Text class={`${MONO} text-foreground`} style={codeTextStyle()}>{list<string>(it.patterns).join("\n")}</Text></View> : null}
      {item.type === "file_search" && list<Rec>(it.results).length > 0 ? (
        <View class="gap-1" selectable>
          {list<Rec>(it.results).map((result) => (
            <View>
              <Text class={`${MONO} text-foreground`} style={codeTextStyle()}>
                {`${workspaceRelativePath(str(result.fileName), root)}${typeof result.line === "number" ? `:${result.line}` : ""}${typeof result.column === "number" ? `:${result.column}` : ""}`}
              </Text>
              {str(result.preview) ? <Text class="mt-0.5 text-xs text-muted-foreground">{str(result.preview)}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {item.type === "web_search" && list<Rec>(it.results).length > 0 ? (
        <View class="gap-1.5">
          {list<Rec>(it.results).map((result) => {
            const href = /^https?:\/\//iu.test(str(result.url)) ? str(result.url) : null;
            const label = str(result.title) || str(result.url);
            return (
              <View>
                {href ? (
                  <View class="flex-row items-center gap-1" onPress={() => { void openUrl(href).catch(() => undefined); }} accessibilityLabel={label} role="link">
                    <Text class="text-xs font-medium text-foreground hover:underline">{label}</Text>
                    <TimelineIcon name="external-link" size={12} />
                  </View>
                ) : (
                  <Text class="text-xs font-medium text-foreground">{label || "Search result"}</Text>
                )}
                {str(result.snippet) ? <Text class="text-xs text-muted-foreground">{str(result.snippet)}</Text> : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {/* TimelineWorkEntryRow: an image-view tool shows the image it viewed (ChatMarkdownAssetImage, max 16rem). */}
      {item.type === "dynamic_tool" && str(it.viewedImagePath) ? (
        <View class="max-h-64"><MarkdownImage image={{ src: str(it.viewedImagePath), alt: str(it.viewedImagePath).split("/").pop() ?? "" } as never} ctx={{ cwd: () => root ?? null, threadId: () => str(it.threadId) || null, gallery: () => [] }} /></View>
      ) : null}
      {item.type === "dynamic_tool" ? (
        <ToolCallBody item={item} args={it.input} toolName={typeof it.toolName === "string" ? it.toolName : null} state={state} streams={false} />
      ) : null}
      {item.type === "approval_request" ? <StructuredValue value={str(it.prompt)} /> : null}
      {item.type === "user_input_request" ? <StructuredValue value={userInputQuestionLines(list(it.questions))} /> : null}
      {item.type === "notification" ? <StructuredValue value={str(it.detail)} /> : null}
      {item.type === "system_notice" ? <StructuredValue value={str(it.message)} /> : null}
      {item.type === "error" ? <StructuredValue value={str((it.failure as Rec | undefined)?.message)} /> : null}
      {item.type === "todo_list" ? <StructuredValue value={todoStepLines(list(it.steps))} /> : null}
    </View>
  );
}
