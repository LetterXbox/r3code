import { expect, test } from "nsh/test";
import { highlightCodeShiki, loadShikiLanguage, readableSyntaxColor, resolveShikiLanguage } from "./shikiHighlight";

test("resolveShikiLanguage covers Shiki ids, aliases and file names beyond the regex set", () => {
  expect(resolveShikiLanguage("ts")).toBe("ts");
  expect(resolveShikiLanguage("language-haskell")).toBe("haskell");
  expect(resolveShikiLanguage("src/flake.nix")).toBe("nix");
  expect(resolveShikiLanguage("zig")).toBe("zig");
  expect(resolveShikiLanguage("klingon")).toBe(null);
});

test("Shiki colours a language the regex highlighter lacks; unknown fences fall back", () => {
  const code = "main :: IO ()\nmain = putStrLn \"hi\"";
  const plain = highlightCodeShiki("x = 1", "klingon", "dark");
  expect(plain.flat().every((token) => token.color === undefined)).toBe(true);
  const started = Date.now();
  expect(loadShikiLanguage("haskell")).toBe(true);
  const elapsed = Date.now() - started;
  const after = highlightCodeShiki(code, "haskell", "dark");
  expect(after.length).toBe(2);
  expect(after.map((line) => line.map((token) => token.text).join(""))).toEqual(code.split("\n"));
  expect(after.flat().some((token) => typeof token.color === "string")).toBe(true);
  const light = highlightCodeShiki(code, "haskell", "light");
  expect(light.flat().some((token) => token.color !== undefined)).toBe(true);
  const t0 = Date.now();
  const big = highlightCodeShiki(Array.from({ length: 200 }, (_, i) => `f${i} x = x + ${i} -- n`).join("\n"), "haskell", "dark");
  console.log(`shiki load haskell ${elapsed}ms, 200 lines ${Date.now() - t0}ms`);
  expect(big.length).toBe(200);
});

test("readableSyntaxColor darkens pale pierre-light colours and keeps dark ones", () => {
  expect(readableSyntaxColor("#0a0a0a")).toBe("#0a0a0a");
  expect(readableSyntaxColor("#1ca1c7")).not.toBe("#1ca1c7");
});
