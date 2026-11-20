import { mount, signal, Text, View } from "nsh";
import { ChatMarkdown } from "./ChatMarkdown";
import { setMarkdownLinkInterceptor } from "./ChatMarkdown";
import { appendCodexArtifactTemplateUsePrompt } from "./codexDirectives";
import { setMarkdownTaskChecked } from "./markdownTaskList";
import { serializeAssistantCitation } from "./assistantCitations";
import { parseContextRecords } from "./contextChips";

const CITATION = serializeAssistantCitation({ version: 1, environmentId: "env-a", threadId: "gone-thread", messageId: "m1", text: "the quoted reply text", start: 0, end: 21, prefix: "", suffix: "", comment: "check this" });
const TEMPLATE = '::artifact-template{skill_name="artifact-template-hello" skill_directory="/skills/hello" display_name="Hello World" artifact_kind="document"}';
const RESPONSE = "[Earlier response](t3-context://v1/response/reply) Can you expand?";
const RESPONSE_CONTEXT = parseContextRecords({ records: [{
  kind: "response", contextId: "reply", label: "Earlier response",
  citation: { version: 1, environmentId: "env-a", threadId: "thread", messageId: "message", text: "Earlier response", start: 0, end: 16, prefix: "", suffix: "" },
  subagents: [{ threadId: "child", title: "Review helper" }],
}] });

const CHIPS = [
  "Open [src/a.ts](/Users/dev/app/src/a.ts#L12) and `pkg/b.ts:3` or [notes](src/c.ts).", "",
  "A [thread](t3-thread://v1/missing-thread), [docs](https://example.com/docs) and $review please.", "",
  `Quote: ${CITATION}`, "",
  ":codex-followup[Prepare print version]{prompt=\"Prepare the document.\"} and :codex-file-citation{path=\"lib/d.ts\" line_range_start=\"4\"}",
].join("\n");

const BLOCKS = [
  "> [!NOTE]", "> Heads up", "", "> [!WARNING]", "> Careful", "", "<details>", "<summary>More</summary>", "", "Hidden body", "", "</details>", "", TEMPLATE,
].join("\n");

const MEDIA = ["![chart](./missing.png)", "", "![clip](./demo.mp4)", "", "![sound](./note.mp3)"].join("\n");

const text = signal(CHIPS);
const draft = signal("");
const opened = signal("none");
setMarkdownLinkInterceptor((href) => { opened.set(href); return true; });
const SKILLS = [{ name: "review", displayName: "Code Review", description: "Reviews a diff.", path: "/skills/review/SKILL.md" }];

function Fixture() {
  return (
    <View>
      <ChatMarkdown
        text={text}
        cwd={() => "/Users/dev/app"}
        skills={() => SKILLS}
        contexts={() => text() === RESPONSE ? RESPONSE_CONTEXT : {}}
        onUseArtifactTemplate={(template) => draft.update((value) => appendCodexArtifactTemplateUsePrompt(value, template))}
        onTaskListChange={({ markerOffset, checked }) => text.update((value) => setMarkdownTaskChecked(value, markerOffset, checked))}
      />
      <View onPress={() => text.set(CHIPS)} accessibilityLabel="Show chips"><Text>chips</Text></View>
      <View onPress={() => text.set(BLOCKS)} accessibilityLabel="Show blocks"><Text>blocks</Text></View>
      <View onPress={() => text.set(MEDIA)} accessibilityLabel="Show media"><Text>media</Text></View>
      <View onPress={() => text.set(RESPONSE)} accessibilityLabel="Show response"><Text>response</Text></View>
      <View onPress={() => text.set("- [ ] first\n- [x] second")} accessibilityLabel="Show tasks"><Text>tasks</Text></View>
      <Text>{`draft: ${draft()}`}</Text>
      <Text>{`opened: ${opened()}`}</Text>
      <Text>{`source: ${text()}`}</Text>
    </View>
  );
}

mount(Fixture);
