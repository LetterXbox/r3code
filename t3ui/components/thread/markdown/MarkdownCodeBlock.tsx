import { cleanup, Clipboard, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import type { ScrollRef, ViewRef } from "nsh";
import { codeTextStyle } from "../../../typography";
import { findCodeMatches } from "../threadFind";
import { activeFindQuery, threadFindActiveBlock } from "../threadFindState";
import { settingValue } from "../../../store";
import { HighlightedCodeLines } from "./HighlightedCodeLines";
import { canRunInTerminal, codeBlockIconFileName, codeBlockLabel } from "./markdownSegments";
import { runProjectScript } from "../../header/projectScriptRun";
import { TimelineIcon } from "./TimelineIcon";
import { FileEntryIcon } from "../../files/FileEntryIcon";
import { resolveFileIcon } from "../../files/fileIcons";

/** Copy-to-clipboard icon button that flips to a check for 1.2s, as the reference's copy button does. */
export function CopyIconButton(props: { text: () => string; label: string }) {
  const copied = signal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (
    <View
      class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out"
      accessibilityLabel={copied() ? "Copied" : props.label}
      tooltip={copied() ? "Copied" : props.label}
      role="button"
      onPress={() => {
        void Clipboard.writeText(props.text());
        copied.set(true);
        clearTimeout(timer);
        timer = setTimeout(() => copied.set(false), 1200);
      }}
    >
      <TimelineIcon name={copied() ? "check" : "copy"} size={12} />
    </View>
  );
}

let shellCommandRunner: ((command: string) => void) | null = null;
/** Replaces what "Run in terminal" does for every code block (the thread terminal drawer by default). */
export function setShellCommandRunner(runner: ((command: string) => void) | null) {
  shellCommandRunner = runner;
}

/** The reference defaults code wrapping to the "Word wrap" client setting (on unless switched off). */
export function defaultWordWrap(): boolean {
  const value = settingValue("wordWrap");
  return value !== false && value !== "false";
}

/**
 * Port of chat/MarkdownCodeBlock.tsx: the card with the language label on the left, a wrap toggle
 * and copy on the right, and the syntax highlighted lines below (highlight.ts).
 */
export function MarkdownCodeBlock(props: {
  code: () => string; language: () => string; canWrap?: boolean;
  /** The fence has not closed or the reply is streaming: no "Run in terminal" yet. */
  open?: () => boolean;
  /** `title="a.ts"` / a file name in the fence's info string: shown in place of the language. */
  title?: () => string | null;
  /** Runs a shell command in a new terminal; the thread's terminal drawer by default (ChatView's runShellCommand). */
  onRunShellCommand?: (command: string) => void;
  /** Extra header action before copy (the mermaid block's diagram toggle). */
  viewToggle?: any; /** The caller spaces it (ChatMarkdown's flow), so it carries no margin of its own. */ flush?: boolean;
  /** This block holds its row's active find match (its first match here): drawn active, scrolled sideways into view. */
  findActive?: () => boolean }) {
  // useThreadFindNavigation codeScroller: the active match in an unwrapped block scrolls it sideways into view (16pt in).
  let card: ViewRef | null = null;
  let scroller: ScrollRef | null = null;
  const activeMatch = () => (props.findActive?.() && findCodeMatches(props.code(), activeFindQuery()).length > 0 ? 0 : null);
  effect(() => {
    if (activeMatch() === null) return;
    const first = findCodeMatches(props.code(), activeFindQuery())[0];
    untracked(() => { if (card) threadFindActiveBlock.set(card); });
    // Code is monospace: a column is about 0.6 of the font size wide.
    const charWidth = (codeTextStyle().fontSize ?? 12) * 0.6;
    const frame = requestAnimationFrame(() => scroller?.scrollTo({ x: Math.max(0, first.column * charWidth - 16), animated: false }));
    return () => cancelAnimationFrame(frame);
  });
  cleanup(() => { if (card && untracked(threadFindActiveBlock) === card) threadFindActiveBlock.set(null); });
  const wrapOverride = signal<boolean | null>(null);
  const wrapped = computed(() => wrapOverride() ?? defaultWordWrap());
  const wrapLabel = () => (wrapped() ? "Disable line wrap" : "Wrap lines");
  const canRun = () => canRunInTerminal(props.language(), props.code(), props.open?.() === true);
  const run = () => {
    const command = props.code().trim();
    const runner = props.onRunShellCommand ?? shellCommandRunner;
    if (runner) runner(command);
    else runProjectScript({ id: "chat-code-block", name: "Chat code block", command, icon: "play", runOnWorktreeCreate: false }, { rememberAsLastInvoked: false, shellHistory: "preserve" });
  };
  // MarkdownCodeBlockTitleContent: a fence title always shows its file icon + name; otherwise
  // show the language's icon alone when pierre-icons has a specific one for it, else the plain
  // language text (no icon) - matching the reference's icon-over-text header.
  const fenceTitle = () => props.title?.() || null;
  const iconFileName = () => fenceTitle() ?? codeBlockIconFileName(props.language());
  const hasSpecificIcon = () => resolveFileIcon(iconFileName()).glyph !== "file";
  return (
    <View ref={(node: ViewRef) => { card = node; }} class={`${props.flush ? "" : "my-[0.65rem] "}overflow-hidden rounded-lg bg-code-background leading-snug`}>
      <View class="flex-row items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3">
        <View class="min-w-0 flex-row items-center gap-1.5" accessibilityLabel={fenceTitle() ? undefined : `Language: ${codeBlockLabel(props.language())}`} tooltip={!fenceTitle() && hasSpecificIcon() ? codeBlockLabel(props.language()) : undefined}>
          {fenceTitle() || hasSpecificIcon() ? <FileEntryIcon path={iconFileName()} kind="file" size={14} /> : null}
          {fenceTitle() || !hasSpecificIcon() ? (
            <Text class="min-w-0 truncate font-mono text-2xs text-muted-foreground">{fenceTitle() || codeBlockLabel(props.language())}</Text>
          ) : null}
        </View>
        <View class="flex-row items-center gap-0.5" role="toolbar" accessibilityLabel="Code block actions">
          {props.canWrap === false ? null : (
            <View
              class={`size-6 items-center justify-center rounded-md hover:bg-accent ${wrapped() ? "bg-accent" : ""}`}
              accessibilityLabel={wrapLabel()}
              accessibilityState={{ selected: wrapped() }}
              tooltip={wrapLabel()}
              role="button"
              onPress={() => wrapOverride.set(!wrapped())}
            >
              <TimelineIcon name="wrap-text" size={12} />
            </View>
          )}
          {canRun() ? (
            <View class="size-6 items-center justify-center rounded-md hover:bg-accent active:scale-[0.97] transition-transform duration-150 ease-in-out" accessibilityLabel="Run in terminal" tooltip="Run in terminal" role="button" onPress={run}>
              <TimelineIcon name="play" size={12} />
            </View>
          ) : null}
          {props.viewToggle ?? null}
          <CopyIconButton text={props.code} label="Copy code" />
        </View>
      </View>
      {wrapped() ? (
        <View class="px-3 pb-2.5 pt-1">
          <HighlightedCodeLines code={props.code} language={props.language} wrap={() => true} activeMatch={activeMatch} />
        </View>
      ) : (
        <Scroll horizontal class="px-3 pb-2.5 pt-1" ref={(node: ScrollRef) => { scroller = node; }}>
          <HighlightedCodeLines code={props.code} language={props.language} wrap={() => false} activeMatch={activeMatch} />
        </Scroll>
      )}
    </View>
  );
}
