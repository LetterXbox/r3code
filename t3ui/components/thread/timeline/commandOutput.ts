// One expanded command row's streamed output (CommandOutputPanel.tsx, client-runtime state/commandOutput.ts):
// frames from `orchestration.subscribeCommandOutput` (OrchestrationV2CommandOutputFrame) replace or extend a bounded
// tail, and SGR colour escapes become coloured spans (shared terminalOutput.ts terminalOutputSpans, TERMINAL_PALETTES).
// Simplification: the reference runs a small terminal emulator over the text (cursor moves, line erase); this keeps
// SGR styles, folds CRLF, lets a bare CR rewrite the current line, and drops every other escape sequence.

export type CommandOutputFrame = { kind: "replace" | "append"; text: string; truncated: boolean; running: boolean };
export type CommandOutputView = { text: string; truncated: boolean; running: boolean };
/** TerminalSpanStyle: colours already resolved against the palette. */
export interface TerminalSpanStyle { color?: string; backgroundColor?: string; fontWeight?: "600"; opacity?: number; fontStyle?: "italic"; textDecorationLine?: "underline" | "line-through" | "underline line-through" }
export type TerminalSpan = { text: string; style: TerminalSpanStyle | null; color: string | null; bold: boolean };

export const EMPTY_COMMAND_OUTPUT: CommandOutputView = { text: "", truncated: false, running: true };
/** TERMINAL_OUTPUT_TAIL_CHARS. */
const TAIL_CHARS = 64 * 1024;
const ESC = "\u001b";

export const TERMINAL_PALETTES = {
  dark: ["#3b4048", "#f47067", "#57ab5a", "#c69026", "#539bf5", "#b083f0", "#39c5cf", "#adbac7", "#768390", "#ff938a", "#6bc46d", "#daaa3f", "#6cb6ff", "#dcbdfb", "#56d4dd", "#cdd9e5"],
  light: ["#24292f", "#cf222e", "#116329", "#7d4e00", "#0550ae", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#0969da", "#6639ba", "#3192aa", "#8c959f"],
} as const;

/** Keeps SGR (`ESC[...m`), removes other CSI / OSC sequences, folds CRLF and resolves bare CRs. */
function normalize(text: string): string {
  const stripped = text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-9;?]*[A-Za-ln-z]/gu, "")
    .replace(/\r\n/gu, "\n");
  if (!stripped.includes("\r")) return stripped;
  return stripped.split("\n").map((line) => {
    const parts = line.split("\r");
    return parts.reduce((shown, part) => (part.length >= shown.length ? part : part + shown.slice(part.length)), "");
  }).join("\n");
}

export function applyCommandOutputFrame(view: CommandOutputView, frame: CommandOutputFrame): CommandOutputView {
  const base = frame.kind === "replace" ? "" : view.text;
  let text = base + normalize(frame.text);
  let truncated = (frame.kind === "replace" ? false : view.truncated) || frame.truncated;
  if (text.length > TAIL_CHARS) {
    text = text.slice(text.length - TAIL_CHARS);
    truncated = true;
  }
  return { text, truncated, running: frame.running };
}

export function readCommandOutputFrame(value: unknown): CommandOutputFrame | null {
  if (value === null || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if ((frame.kind !== "replace" && frame.kind !== "append") || typeof frame.text !== "string") return null;
  return { kind: frame.kind, text: frame.text, truncated: frame.truncated === true, running: frame.running !== false };
}

interface Pen { fg: string; bg: string; bold: boolean; dim: boolean; italic: boolean; underline: boolean; strike: boolean; inverse: boolean }
const EMPTY_PEN: Pen = { fg: "", bg: "", bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };

/** terminalOutput.ts applySgr: SGR parameters onto the pen (38/48 with 5;n or 2;r;g;b, 58 consumed and dropped). */
function applySgr(current: Pen, params: number[]): Pen {
  const pen = { ...current };
  if (params.length === 0) params = [0];
  for (let index = 0; index < params.length;) {
    const code = params[index]!;
    if (code === 0 || Number.isNaN(code)) Object.assign(pen, EMPTY_PEN);
    else if (code === 1) pen.bold = true;
    else if (code === 2) pen.dim = true;
    else if (code === 3) pen.italic = true;
    else if (code === 4) pen.underline = true;
    else if (code === 7) pen.inverse = true;
    else if (code === 9) pen.strike = true;
    else if (code === 22) pen.bold = pen.dim = false;
    else if (code === 23) pen.italic = false;
    else if (code === 24) pen.underline = false;
    else if (code === 27) pen.inverse = false;
    else if (code === 29) pen.strike = false;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) pen.fg = String(code);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) pen.bg = String(code);
    else if (code === 39) pen.fg = "";
    else if (code === 49) pen.bg = "";
    else if (code === 38 || code === 48 || code === 58) {
      const mode = params[index + 1];
      let color: string | undefined;
      let next = index + 1;
      if (mode === 5 && params[index + 2] !== undefined) { color = `${code};5;${Math.max(0, Math.min(255, params[index + 2]!))}`; next = index + 3; }
      else if (mode === 2 && params[index + 4] !== undefined) { color = `${code};2;${[2, 3, 4].map((offset) => Math.max(0, Math.min(255, params[index + offset]!))).join(";")}`; next = index + 5; }
      if (color !== undefined && code !== 58) pen[code === 38 ? "fg" : "bg"] = color;
      index = next;
      continue;
    }
    index += 1;
  }
  return pen;
}

function xtermColor(index: number, palette: readonly string[]): string {
  if (index < 16) return palette[index]!;
  if (index >= 232) { const level = 8 + (index - 232) * 10; return `rgb(${level},${level},${level})`; }
  const cube = index - 16;
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${channel(Math.floor(cube / 36))},${channel(Math.floor(cube / 6) % 6)},${channel(cube % 6)})`;
}

function resolveColor(code: string, base: number, palette: readonly string[]): string | undefined {
  const parts = code.split(";").map(Number);
  const head = parts[0]!;
  if (head === base + 8) return parts[1] === 5 ? xtermColor(parts[2]!, palette) : `rgb(${parts[2]},${parts[3]},${parts[4]})`;
  if (head >= base && head <= base + 7) return palette[head - base];
  if (head >= base + 60 && head <= base + 67) return palette[head - base - 52];
  return undefined;
}

type Rgb = readonly [number, number, number];
function parseCssColor(color: string): Rgb | undefined {
  if (color.startsWith("#") && color.length === 7) return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as unknown as Rgb;
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/u.exec(color);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => { const scaled = value / 255; return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrastRatio(a: Rgb, b: Rgb): number {
  const [first, second] = [luminance(a), luminance(b)];
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** terminalOutput.ts spanStyle: the pen resolved against the palette (inverse swaps, low-contrast text on a badge is fixed). */
function spanStyle(pen: Pen, palette: readonly string[]): TerminalSpanStyle | null {
  if (JSON.stringify(pen) === JSON.stringify(EMPTY_PEN)) return null;
  let color = pen.fg === "" ? undefined : resolveColor(pen.fg, 30, palette);
  let backgroundColor = pen.bg === "" ? undefined : resolveColor(pen.bg, 40, palette);
  if (pen.inverse) [color, backgroundColor] = [backgroundColor, color ?? palette[7]];
  // Badges like "PASS" on green assume a terminal's own palette; keep their text readable.
  if (backgroundColor !== undefined) {
    const background = parseCssColor(backgroundColor);
    const foreground = color === undefined ? undefined : parseCssColor(color);
    if (background !== undefined && (foreground === undefined || contrastRatio(foreground, background) < 3)) color = luminance(background) > 0.35 ? "#1f2328" : "#ffffff";
  }
  const textDecorationLine = pen.underline ? (pen.strike ? "underline line-through" : "underline") : pen.strike ? "line-through" : undefined;
  return {
    ...(color === undefined ? {} : { color }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(pen.bold ? { fontWeight: "600" as const } : {}),
    ...(pen.dim ? { opacity: 0.65 } : {}),
    ...(pen.italic ? { fontStyle: "italic" as const } : {}),
    ...(textDecorationLine === undefined ? {} : { textDecorationLine: textDecorationLine as TerminalSpanStyle["textDecorationLine"] }),
  };
}

/** terminalOutputSpans: the text cut at SGR escapes, each run with its resolved style (null for the default). */
export function terminalOutputSpans(text: string, palette: readonly string[], maxSpans = 2000): TerminalSpan[] {
  const spans: TerminalSpan[] = [];
  const styles = new Map<string, TerminalSpanStyle | null>();
  let pen: Pen = EMPTY_PEN;
  let cursor = 0;
  const styleOf = () => { const key = JSON.stringify(pen); let style = styles.get(key); if (style === undefined) { style = spanStyle(pen, palette); styles.set(key, style); } return style; };
  const push = (end: number) => { if (end > cursor) { const style = styleOf(); spans.push({ text: text.slice(cursor, end), style, color: style?.color ?? null, bold: style?.fontWeight === "600" }); } };
  while (cursor < text.length && spans.length < maxSpans) {
    const escape = text.indexOf(`${ESC}[`, cursor);
    if (escape === -1) break;
    push(escape);
    const end = text.indexOf("m", escape);
    if (end === -1) { cursor = text.length; break; }
    const raw = text.slice(escape + 2, end);
    pen = applySgr(pen, raw === "" ? [] : raw.split(";").map((part) => (part === "" ? 0 : Number(part))));
    cursor = end + 1;
  }
  if (cursor < text.length) {
    const rest = text.slice(cursor).replace(/\u001b\[[0-9;]*m/gu, "");
    if (spans.length >= maxSpans) spans.push({ text: rest, style: null, color: null, bold: false });
    else { const style = styleOf(); spans.push({ text: rest, style, color: style?.color ?? null, bold: style?.fontWeight === "600" }); }
  }
  return spans;
}
