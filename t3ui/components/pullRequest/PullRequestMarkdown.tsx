// Rendered pull request bodies (descriptions, comments, thread replies), ported from PullRequestMarkdown.tsx.
// The web hands the text to its ChatMarkdown; so does this, by import from the chat thread's renderer. A video on a
// line of its own (a bare or linked .mp4/.webm/.mov/.m4v/.ogv URL, or a <video> tag) plays inline, as
// client-runtime's splitPullRequestBody lifts it out. Not ported: the host's signed media URLs (GitHub
// user-attachments needs the environment's asset reader) and the before/after media tables.
import { Video, View } from "nsh";
import { ChatMarkdown } from "../thread/markdown/ChatMarkdown";

export type BodySegment = { kind: "markdown"; text: string } | { kind: "video"; url: string };

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)\r?$/u;
const INDENTED_CODE_PATTERN = /^(?: {4}| {0,3}\t)/u;
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u;
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/u;
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu;
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu;
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu;
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu;
const VIDEO_TAG_MAX_LINES = 8;

const isWebUrl = (url: string) => /^https?:\/\//iu.test(url);

/** splitPullRequestBody, video segments only: fenced and indented code stays prose. */
export function splitPullRequestBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const markdown: string[] = [];
  let openFence: string | null = null;
  const flush = () => {
    const text = markdown.join("\n").replace(/^(?:\r?\n)+/u, "").replace(/\s+$/u, "");
    markdown.length = 0;
    if (text.trim().length > 0) segments.push({ kind: "markdown", text });
  };
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (openFence === null) openFence = marker;
      else if (marker[0] === openFence[0] && marker.length >= openFence.length && fence[2]!.trim().length === 0) openFence = null;
      markdown.push(line);
      continue;
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) { markdown.push(line); continue; }
    const url = BARE_URL_PATTERN.exec(line.trim())?.[1] ?? MARKDOWN_LINK_PATTERN.exec(line.trim())?.[1];
    if (url !== undefined && isWebUrl(url) && VIDEO_EXTENSION_PATTERN.test(url)) { flush(); segments.push({ kind: "video", url }); continue; }
    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) { markdown.push(line); continue; }
    const last = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1;
    let cursor = index;
    while (cursor < last && !VIDEO_TAG_END_PATTERN.test(lines[cursor]!)) cursor++;
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor]!) ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).join("\n"))?.[1] : undefined;
    if (source !== undefined && isWebUrl(source)) { flush(); segments.push({ kind: "video", url: source }); index = cursor; }
    else markdown.push(line);
  }
  flush();
  return segments;
}

export function PullRequestMarkdown(props: { text: string | (() => string); class?: string }) {
  const text = () => (typeof props.text === "function" ? props.text() : props.text);
  const segments = () => splitPullRequestBody(text());
  return (
    <View class={`min-w-0 flex-col gap-3 ${props.class ?? ""}`} accessibilityLabel="Pull request markdown">
      {segments().some((segment) => segment.kind === "video")
        ? segments().map((segment) => (segment.kind === "video"
          ? <Video src={segment.url} controls paused class="aspect-video w-full rounded-lg border border-border-60" accessibilityLabel="Pull request video" />
          : <ChatMarkdown text={() => segment.text} />))
        : <ChatMarkdown text={text} />}
    </View>
  );
}
