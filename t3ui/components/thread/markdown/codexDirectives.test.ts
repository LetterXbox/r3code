import { expect, test } from "nsh/test";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  renderCodexDirectivesForCopy,
  renderCodexInlineDirectivesAsMarkdown,
  resolveCodexArtifactTemplate,
  splitCodexArtifactTemplateMarkdown,
} from "./codexDirectives";
import { parseMarkdownFileLink } from "./fileLinkMeta";

const FILE_CITATION = ':codex-file-citation{path="outputs/report.xlsx" purpose="output"}';
const FOLLOW_UP = ':codex-followup[Prepare print version]{prompt="Prepare the document for printing."}';
const ARTIFACT_TEMPLATE = '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

test("a file citation becomes a link to its file, and a follow-up becomes its label", () => {
  expect(renderCodexInlineDirectivesAsMarkdown(`Created ${FILE_CITATION}.`)).toBe("Created [report.xlsx](<outputs/report.xlsx>).");
  expect(renderCodexInlineDirectivesAsMarkdown(`- ${FOLLOW_UP}\n- :codex-followup[Review **document**]{prompt="Review it."}`)).toBe("- Prepare print version\n- Review **document**");
  expect(renderCodexInlineDirectivesAsMarkdown(':codex-file-citation{path="src/a.ts" line_range_start="7"}')).toBe("[a.ts](<src/a.ts#L7>)");
});

test("unrelated colon syntax and malformed directives stay as written", () => {
  for (const markdown of [
    "Meeting at 10:30", ":::note\ncontent\n:::",
    ':codex-file-citation-extra{path="outputs/report.xlsx"}', ':codex-followup-extra[Label]{prompt="Prompt"}',
    ':codex-file-citation{purpose="output"}', ":codex-followup[Prepare print version]", ':codex-followup[ ]{prompt="Prepare the document for printing."}',
  ]) expect(renderCodexInlineDirectivesAsMarkdown(markdown)).toBe(markdown);
});

test("directives inside code are not read", () => {
  const fenced = `\`\`\`\n${FILE_CITATION}\n\`\`\``;
  expect(renderCodexInlineDirectivesAsMarkdown(fenced)).toBe(fenced);
  const span = `Write \`${FOLLOW_UP}\` literally`;
  expect(renderCodexInlineDirectivesAsMarkdown(span)).toBe(span);
});

test("a cited path keeps its literal characters and line through the markdown link", () => {
  for (const path of ["C:\\Users\\test\\[draft]\\report.md", "\\\\server\\share\\report.md", "/tmp/report%5C.md"]) {
    const markdown = renderCodexInlineDirectivesAsMarkdown(`:codex-file-citation{path="${path}" line_range_start="7"}`);
    const href = /\]\(<(.*)>\)$/.exec(markdown)?.[1] ?? "";
    expect(parseMarkdownFileLink(href)).toEqual({ path, line: 7 });
  }
});

test("an artifact template line is cut out of the markdown around it", () => {
  const segments = splitCodexArtifactTemplateMarkdown(`Before\n\n${ARTIFACT_TEMPLATE}\n\nAfter`);
  expect(segments.map((segment) => segment.kind)).toEqual(["markdown", "artifact-template", "markdown"]);
  expect(segments[1]).toMatchObject({ kind: "artifact-template", template: { artifactKind: "document", displayName: "Hello World", skillName: "artifact-template-hello-world" } });
  expect(splitCodexArtifactTemplateMarkdown("::artifact-template{display_name=\"x\"}")).toEqual([{ kind: "markdown", markdown: "::artifact-template{display_name=\"x\"}", sourceOffset: 0 }]);
  expect(splitCodexArtifactTemplateMarkdown(`\`\`\`\n${ARTIFACT_TEMPLATE}\n\`\`\``).map((segment) => segment.kind)).toEqual(["markdown"]);
});

test("a template needs a known kind, an absolute skill directory and an artifact-template skill name", () => {
  const good = { artifact_kind: "slack", display_name: " Standup ", skill_directory: "/skills/x", skill_name: "artifact-template-x" };
  expect(resolveCodexArtifactTemplate(good)).toEqual({ artifactKind: "slack", displayName: "Standup", skillDirectory: "/skills/x", skillName: "artifact-template-x" });
  expect(resolveCodexArtifactTemplate({ ...good, artifact_kind: "video" })).toBe(null);
  expect(resolveCodexArtifactTemplate({ ...good, skill_directory: "skills/x" })).toBe(null);
  expect(resolveCodexArtifactTemplate({ ...good, skill_name: "other" })).toBe(null);
  expect(resolveCodexArtifactTemplate({ ...good, gallery_kind: "nope" })).toBe(null);
});

test("copy writes a template as its name and kind, and Use template appends its prompt once", () => {
  expect(renderCodexDirectivesForCopy(`A\n\n${ARTIFACT_TEMPLATE}\n\nB ${FILE_CITATION}`)).toBe("A\n\nHello World (Document template)\n\nB [report.xlsx](<outputs/report.xlsx>)");
  const template = resolveCodexArtifactTemplate({ artifact_kind: "presentation", display_name: "Deck", skill_directory: "/s", skill_name: "artifact-template-deck" })!;
  expect(codexArtifactTemplateUsePrompt(template)).toBe("Create a presentation using the $artifact-template-deck template about…");
  const once = appendCodexArtifactTemplateUsePrompt("hi", template);
  expect(once).toBe("hi Create a presentation using the $artifact-template-deck template about…");
  expect(appendCodexArtifactTemplateUsePrompt(once, template)).toBe(once);
});
