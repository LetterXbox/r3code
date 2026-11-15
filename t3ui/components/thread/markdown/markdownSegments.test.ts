import { expect, test } from "nsh/test";
import { canRunInTerminal, codeBlockLabel, extractFenceTitle, splitMarkdownFences } from "./markdownSegments";

test("text and a closed fence split into three segments", () => {
  const segments = splitMarkdownFences("Intro\n\n```ts\nconst a = 1;\n```\n\nOutro");
  expect(segments.map((segment) => segment.kind)).toEqual(["text", "code", "text"]);
  const code = segments[1];
  expect(code.kind === "code" && code.language).toBe("ts");
  expect(code.kind === "code" && code.code).toBe("const a = 1;");
  expect(code.kind === "code" && code.open).toBe(false);
});

test("an unclosed fence from a streaming reply is open and still valid markdown", () => {
  const segments = splitMarkdownFences("Here:\n```bash\nnpm test\nnpm run");
  const code = segments[1];
  expect(code.kind === "code" && code.open).toBe(true);
  expect(code.kind === "code" && code.source).toBe("```bash\nnpm test\nnpm run\n```");
});

test("a longer fence is closed only by an equal or longer fence of the same kind", () => {
  const segments = splitMarkdownFences("````md\n```ts\nx\n```\n````");
  expect(segments.length).toBe(1);
  const code = segments[0];
  expect(code.kind === "code" && code.code).toBe("```ts\nx\n```");
});

test("tilde fences, empty languages and CRLF are handled", () => {
  const segments = splitMarkdownFences("~~~\r\nplain\r\n~~~");
  const code = segments[0];
  expect(code.kind === "code" && code.language).toBe("");
  expect(code.kind === "code" && code.code).toBe("plain");
  expect(codeBlockLabel("")).toBe("text");
  expect(codeBlockLabel(" rust ")).toBe("rust");
});

test("an inline triple backtick on one line is not a fence", () => {
  const segments = splitMarkdownFences("use ```code``` inline");
  expect(segments).toEqual([{ kind: "text", text: "use ```code``` inline" }]);
  expect(splitMarkdownFences("")).toEqual([]);
});

test("indented fences stay inside the text segment so lists keep their nesting", () => {
  const segments = splitMarkdownFences("1. step\n\n    ```\n    x\n    ```\n2. next");
  expect(segments.length).toBe(1);
  expect(segments[0].kind).toBe("text");
});

test("fence titles and the run-in-terminal rule follow the reference", () => {
  expect(extractFenceTitle('title="a b.ts"')).toBe("a b.ts");
  expect(extractFenceTitle("src/main.rs {1,3}")).toBe("src/main.rs");
  expect(extractFenceTitle("")).toBeNull();
  const fence = splitMarkdownFences("```bash run.sh\nnpm test\n```")[0];
  expect(fence.kind === "code" && fence.meta).toBe("run.sh");
  expect(canRunInTerminal("bash", "npm test", false)).toBe(true);
  expect(canRunInTerminal("bash", "npm test", true)).toBe(false);
  expect(canRunInTerminal("ts", "npm test", false)).toBe(false);
  expect(canRunInTerminal("sh", "echo one \\", false)).toBe(false);
  expect(canRunInTerminal("sh", "echo ‮test", false)).toBe(false);
  expect(canRunInTerminal("sh", "a\nb", false)).toBe(false);
});
