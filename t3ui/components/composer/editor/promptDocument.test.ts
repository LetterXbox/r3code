import { expect, test } from "nsh/test";
import { FILE_TYPE_GLYPHS, TOKEN_GLYPHS, tokenGlyph, serializeComposerFileLink, collectPromptTokens, docToPrompt, offsetToPos, posToOffset, promptToDoc, retokenize, sameDoc } from "./promptDocument";
import type { PromptTokenContext } from "./promptDocument";
import { chipInk } from "./chipColors";
import { editorKeyName, forwardedShortcuts, isEditingChord } from "./PromptEditor";

const context = { skills: new Map([["council", "Council"]]), folders: new Set(["[src](src)"]) };

test("prose after a list keeps a Markdown boundary and preserves empty paragraphs", () => {
  const richContext = { ...context, richText: true };
  for (const list of ["1. first\n2. second", "- first\n- second", "- [ ] task"]) {
    for (const emptyLines of ["", "\n"]) {
      const text = `${list}\n\n${emptyLines}After the list`;
      const doc = promptToDoc(`${list}\nAfter the list`, richContext);
      if (emptyLines) doc.content?.splice(1, 0, { type: "paragraph" });
      expect(docToPrompt(doc)).toBe(text);
      const reopened = promptToDoc(text, richContext);
      expect(reopened.content?.length).toBe(emptyLines ? 3 : 2);
      expect(sameDoc(reopened, doc)).toBe(true);
      expect(docToPrompt(reopened)).toBe(text);
      const proseStart = text.indexOf("After");
      expect(posToOffset(reopened, offsetToPos(reopened, proseStart))).toBe(proseStart);
    }
  }
});

test("every token kind becomes an inline atom with its label, and serialises back to the exact prompt text", () => {
  const prompt = `ask $council about ${serializeComposerFileLink("apps/web/ProviderStack.tsx")} and [src](src) then @README.md and @"my dir/a b.ts" ok\nline two $council `;
  const doc = promptToDoc(prompt, context);
  const tokens = doc.content!.flatMap((block) => (block.content ?? []).filter((node) => node.type === "token").map((node) => node.attrs));
  expect(tokens).toEqual([
    { kind: "skill", value: "council", source: "$council", label: "Council", glyph: "\u{ff000}" },
    { kind: "file", value: "apps/web/ProviderStack.tsx", source: "[ProviderStack.tsx](apps/web/ProviderStack.tsx)", label: "ProviderStack.tsx", glyph: "\u{ff011}" },
    { kind: "folder", value: "src", source: "[src](src)", label: "src", glyph: "\u{ff002}" },
    { kind: "file", value: "README.md", source: "@README.md", label: "README.md", glyph: "\u{ff012}" },
    { kind: "file", value: "my dir/a b.ts", source: "@\"my dir/a b.ts\"", label: "a b.ts", glyph: "\u{ff011}" },
    { kind: "skill", value: "council", source: "$council", label: "Council", glyph: "\u{ff000}" },
  ]);
  expect(doc.content!.length).toBe(2);
  expect(docToPrompt(doc)).toBe(prompt);
});

test("a picked path serialises as the reference's markdown file link", () => {
  expect(serializeComposerFileLink("apps/web/my file (1).tsx")).toBe("[my file (1).tsx](apps/web/my%20file%20%281%29.tsx)");
  expect(collectPromptTokens("[my file (1).tsx](apps/web/my%20file%20%281%29.tsx) ", context)[0]?.value).toBe("apps/web/my file (1).tsx");
});

test("a token waits for the whitespace after it, and unknown skills, prices and packages stay text", () => {
  expect(collectPromptTokens("$council", context)).toEqual([]);
  expect(collectPromptTokens("$5 $nope @scope/pkg ", context)).toEqual([]);
  expect(collectPromptTokens("a$council ", context)).toEqual([]);
});

test("caret offsets map through tokens as one unit", () => {
  const prompt = "use $council now";
  const doc = promptToDoc(prompt, context);
  // doc positions: 1 "u", 5 before the token, 6 after it.
  expect(posToOffset(doc, 5)).toBe(4);
  expect(posToOffset(doc, 6)).toBe(12);
  expect(posToOffset(doc, 10)).toBe(16);
  expect(offsetToPos(doc, 4)).toBe(5);
  expect(offsetToPos(doc, 8)).toBe(6);
  expect(offsetToPos(doc, 12)).toBe(6);
  expect(offsetToPos(doc, 16)).toBe(10);
  const lines = promptToDoc("ab\ncd", context);
  expect(posToOffset(lines, 5)).toBe(3);
  expect(offsetToPos(lines, 3)).toBe(5);
});

test("retokenize chips newly completed tokens and keeps a token whose trailing space was deleted", () => {
  const typed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi $council there" }] }] };
  expect(sameDoc(retokenize(typed, context), promptToDoc("hi $council there", context))).toBe(true);
  const kept = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi " }, { type: "token", attrs: { kind: "skill", value: "council", source: "$council", label: "Council", glyph: "\u{ff000}" } }] }] };
  expect(sameDoc(retokenize(kept, context), kept)).toBe(true);
  expect(docToPrompt(kept)).toBe("hi $council");
});

test("token ink is readable on light and dark composer surfaces", () => {
  expect(chipInk("skill", [255, 255, 255])).not.toBe(chipInk("skill", [20, 24, 30]));
  expect(chipInk("file", [20, 24, 30]).startsWith("#")).toBe(true);
});

test("registry shortcuts pass through the editor under ProseMirror key names", () => {
  expect(editorKeyName("mod+shift+k")).toBe("Mod-Shift-k");
  expect(editorKeyName("mod+s")).toBe("Mod-s");
  expect(editorKeyName("escape")).toBe(null);
  expect(isEditingChord("Mod-c")).toBe(true);
  expect(isEditingChord("Mod-a")).toBe(true);
  expect(isEditingChord("Alt-Backspace")).toBe(true);
  expect(isEditingChord("Mod-ArrowLeft")).toBe(true);
  expect(isEditingChord("Mod-Shift-k")).toBe(false);
  expect(forwardedShortcuts().has("Mod-z")).toBe(false);
});

test("models, pull requests, threads and terminal output chip inline with their labels", () => {
  const models = { ...context, models: new Map([["codex/gpt-6.1-sol", "GPT 6.1 Sol"]]) };
  const prompt = "ask model:codex/gpt-6.1-sol and [#12](t3-context://v1/review-comment/review-comment_pr-1) about [Fix login](t3-context://v1/thread/thread-9) with [Terminal 1 lines 3-9](t3-context://v1/terminal/term-1) /plan model:codex/gpt-6.1";
  const tokens = promptToDoc(prompt, models).content![0]!.content!.filter((node) => node.type === "token").map((node) => [node.attrs!.kind, node.attrs!.label]);
  expect(tokens).toEqual([["model", "GPT 6.1 Sol"], ["pull-request", "#12"], ["thread", "Fix login"], ["terminal", "Terminal 1 lines 3-9"]]);
  expect(docToPrompt(promptToDoc(prompt, models))).toBe(prompt);
});

test("a file token draws its type's mark; unknown types and other kinds keep their kind's", () => {
  const glyph = (value: string) => tokenGlyph("file", value);
  expect(glyph("a/b.ts")).toBe(glyph("a/b.tsx"));
  expect(new Set(["a.ts", "a.md", "a.png", "a.sh", "a.yml", "a.csv", "a.zip", "a.mp4", "a.sql"].map(glyph)).size).toBe(9);
  expect(glyph("a.unknownext")).toBe("\u{ff001}");
  expect(tokenGlyph("folder", "src")).toBe("\u{ff002}");
  expect(tokenGlyph("thread", "x")).toBe("\u{ff005}");
});

test("an attached file reference draws as a file chip with its size and keeps its source", () => {
  const prompt = "[package.json](t3-context://v1/file/file_a1) ";
  const doc = promptToDoc(prompt, { ...context, fileAttachments: new Map([["file_a1", 1024]]) });
  const token = doc.content![0]!.content!.find((node) => node.type === "token");
  expect(token?.attrs?.kind).toBe("file");
  expect(token?.attrs?.label).toBe("package.json 1 KB");
  expect(docToPrompt(doc)).toBe(prompt);
});

test("copying a selection gives the prompt text with each token as its source, which chips again when pasted", async () => {
  const { selectedPromptText } = await import("./promptDocument");
  const prompt = "use $council and [src](src) now";
  const doc = promptToDoc(prompt, context);
  // doc positions: "use " is 1-4, the skill token 5, " and " 6-10, the folder token 11.
  expect(selectedPromptText(doc, 1, 6)).toBe("use $council");
  expect(selectedPromptText(doc, 5, 12)).toBe("$council and [src](src)");
  expect(selectedPromptText(doc, 3, 3)).toBe("");
  const pasted = promptToDoc(`${selectedPromptText(doc, 5, 12)} `, context);
  expect(pasted.content![0]!.content!.filter((node) => node.type === "token").length).toBe(2);
});

test("icon glyphs sit in the supplementary private-use plane, which no system font claims (U+E000.. draws SF's own glyphs)", () => {
  for (const glyph of [...Object.values(TOKEN_GLYPHS), ...Object.values(FILE_TYPE_GLYPHS)]) {
    const code = glyph.codePointAt(0)!;
    expect(code >= 0xFF000 && code <= 0xFF0FF).toBe(true);
    expect(glyph.length).toBe(2);
  }
});

test("a preview annotation token is its own kind with its own mark (not a broken generic context chip)", () => {
  const tokens = collectPromptTokens("See [Make it red](t3-context://v1/preview-annotation/preview-annotation_a1) ", { skills: new Map() });
  expect(tokens.map((t) => [t.kind, t.value])).toEqual([["preview-annotation", "Make it red"]]);
  expect(tokenGlyph("preview-annotation", "Make it red")).toBe("\u{FF007}");
});

test("a model reference chips only for a model the server offers, and never inside a formula", () => {
  const models = { ...context, models: new Map([["codex/gpt-6.1-sol", "GPT 6.1 Sol"]]) };
  const kinds = (prompt: string, ctx: PromptTokenContext = models) => promptToDoc(prompt, ctx).content![0]!.content!.filter((node) => node.type === "token").map((node) => node.attrs!.kind);
  expect(kinds("ask model:codex/gpt-6.1-sol now")).toEqual(["model"]);
  expect(kinds("ask model:codex/gone now")).toEqual([]);
  expect(kinds("ask model:codex/gpt-6.1-sol now", context)).toEqual([]);
  expect(kinds("cost $a model:codex/gpt-6.1-sol b$ now")).toEqual([]);
});

test("retokenize reverts a skill or model chip whose skill or model is gone to its text", async () => {
  const { retokenize } = await import("./promptDocument");
  const models = { ...context, models: new Map([["codex/gpt-6.1-sol", "GPT 6.1 Sol"]]) };
  const doc = promptToDoc("use $council and model:codex/gpt-6.1-sol now", models);
  const kinds = (d: typeof doc) => d.content![0]!.content!.filter((node) => node.type === "token").map((node) => node.attrs!.kind);
  expect(kinds(doc)).toEqual(["skill", "model"]);
  const reverted = retokenize(doc, { skills: new Map(), models: new Map() });
  expect(kinds(reverted)).toEqual([]);
  expect(docToPrompt(reverted)).toBe("use $council and model:codex/gpt-6.1-sol now");
});
