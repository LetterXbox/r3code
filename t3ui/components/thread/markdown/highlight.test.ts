import { expect, test } from "nsh/test";
import { highlightCode, highlightLine, resolveLanguage, tokenClass } from "./highlight";

const kinds = (line: { text: string; kind: string }[]) => line.map((token) => `${token.kind}:${token.text}`);

test("resolveLanguage accepts fence info, extensions and file names", () => {
  expect(resolveLanguage("ts")).toBe("typescript");
  expect(resolveLanguage("TSX")).toBe("typescript");
  expect(resolveLanguage("language-rust")).toBe("rust");
  expect(resolveLanguage("src/main.go")).toBe("go");
  expect(resolveLanguage("Dockerfile")).toBe("bash");
  expect(resolveLanguage("")).toBe(null);
  expect(resolveLanguage("klingon")).toBe(null);
});

test("typescript tokens: keywords, strings, numbers, calls, types", () => {
  const [line] = highlightCode('const total: Count = add(1, "x"); // done', "ts");
  const text = kinds(line);
  expect(text).toContain("keyword:const");
  expect(text).toContain("type:Count");
  expect(text).toContain("function:add");
  expect(text).toContain("number:1");
  expect(text).toContain('string:"x"');
  expect(text).toContain("comment:// done");
});

test("every line round-trips to its source text", () => {
  const source = ["fn main() {", "    let s = \"a\\\"b\";", "    /* multi", "       line */ x", "}"].join("\n");
  const lines = highlightCode(source, "rust");
  expect(lines.length).toBe(5);
  expect(lines.map((line) => line.map((token) => token.text).join(""))).toEqual(source.split("\n"));
});

test("block comments and template strings carry across lines", () => {
  const lines = highlightCode("/* a\nb */ let x = `p\nq`;", "js");
  expect(lines[0][0].kind).toBe("comment");
  expect(lines[1][0]).toEqual({ text: "b */", kind: "comment" });
  expect(lines[2][0].kind).toBe("string");
});

test("json separates keys from string values", () => {
  const [line] = highlightCode('{"name": "t3", "n": 2, "ok": true}', "json");
  const text = kinds(line);
  expect(text).toContain('property:"name"');
  expect(text).toContain('string:"t3"');
  expect(text).toContain("number:2");
  expect(text).toContain("constant:true");
});

test("bash colours commands, flags, variables and comments", () => {
  const lines = highlightCode("# install\npnpm add --save-dev $PKG", "bash");
  expect(lines[0][0].kind).toBe("comment");
  const text = kinds(lines[1]);
  expect(text).toContain("function:pnpm");
  expect(text).toContain("attr:--save-dev");
  expect(text).toContain("constant:$PKG");
});

test("diff marks added, removed and hunk lines", () => {
  const lines = highlightCode("@@ -1 +1 @@\n-old\n+new\n same", "diff");
  expect(lines.map((line) => line[0]?.kind)).toEqual(["keyword", "deleted", "inserted", "plain"]);
});

test("unsupported or empty input is plain and never throws", () => {
  expect(highlightCode("a b", "klingon")).toEqual([[{ text: "a b", kind: "plain" }]]);
  expect(highlightCode("", "ts")).toEqual([[]]);
  expect(highlightLine("let a = 1", "ts").some((token) => token.kind === "keyword")).toBe(true);
  expect(highlightCode('"unterminated\nnext', "ts").length).toBe(2);
});

test("tokenClass gives a light and a dark colour for every coloured kind", () => {
  expect(tokenClass("keyword")).toContain("dark:");
  expect(tokenClass("plain")).toBe("text-code-foreground");
});

test("HTML highlights its embedded script and style as JavaScript and CSS", async () => {
  const { highlightCode } = await import("./highlight");
  const [line] = highlightCode('<script>const a = "x";</script><style>a { color: red; }</style>', "html");
  expect(line!.some((token) => token.text === "const" && token.kind === "keyword")).toBe(true);
  expect(line!.some((token) => token.text.includes("</script") && token.kind === "tag")).toBe(true);
  expect(line!.map((token) => token.text).join("")).toBe('<script>const a = "x";</script><style>a { color: red; }</style>');
});
