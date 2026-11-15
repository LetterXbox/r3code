import { expect, test } from "nsh/test";
import { fileIconColor, resolveFileIcon } from "./fileIcons";

test("fm13: the app's own marks: documents, languages, diff/xml/toml, video, heic and the named files", () => {
  const token = (path: string) => resolveFileIcon(path).token;
  expect(["a.pdf", "a.docx", "a.xlsx", "a.csv", "a.pptx", "a.epub"].map(token)).toEqual(["t3-pdf", "t3-word", "t3-spreadsheet", "t3-spreadsheet", "t3-slides", "t3-epub"]);
  expect(["a.cs", "a.dart", "a.ex", "a.hs", "a.java", "a.kt", "a.lua", "a.php", "a.ps1", "a.r", "a.scala"].map(token)).toEqual(["t3-csharp", "t3-dart", "t3-elixir", "t3-haskell", "t3-java", "t3-kotlin", "t3-lua", "t3-php", "t3-powershell", "t3-r", "t3-scala"]);
  expect(["a.diff", "a.patch", "a.xml", "a.xsl", "Cargo.toml", "a.mkv", "a.mp4", "a.heic"].map(token)).toEqual(["t3-diff", "t3-diff", "t3-xml", "t3-xml", "t3-toml", "t3-video", "t3-video", "image"]);
  expect(["AGENTS.md", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "package.json"].map(token)).toEqual(["t3-agents", "t3-pnpm", "t3-pnpm", "typescript", "npm"]);
  expect(fileIconColor("t3-pdf", "light")).toBe("#d52c36");
  expect(fileIconColor("t3-pdf", "dark")).toBe("#ff6762");
});
