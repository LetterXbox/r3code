import { mount, signal, Text, View } from "nsh";
import { ChatMarkdown } from "./ChatMarkdown";
import { setShellCommandRunner } from "./MarkdownCodeBlock";
import { loadShikiLanguage } from "./shikiHighlight";
import { closeThreadFind, threadFindOpen, threadFindQuery } from "../threadFindState";
import { updateSetting } from "../../../store";

// Warm the fixture's grammars up front so the first Shiki compile does not land mid-test.
for (const id of ["ts", "bash", "mermaid"]) loadShikiLanguage(id);

const FULL = [
  "# Heading one", "", "Some **bold**, *italic*, `inline` and a [link](https://example.com).", "",
  "- first", "  - nested item", "- second", "", "1. one", "2. two", "", "> quoted text", "", "---", "",
  "| Name | Value |", "| --- | --- |", "| alpha | 1 |", "", "```ts", "const ready = true;", "```", "", "After code",
].join("\n");

const MATH = "Euler: $e^{i\\pi}+1=0$ inline and a bad $\\frac{$ one.\n\n$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$\n\nAfter math";
const text = signal("Partial **bol");
const streaming = signal(true);
const ran = signal("none");
setShellCommandRunner((command) => ran.set(command));
const CODE = ["```ts", "export const total: number = items.length // count", "```", "", "```bash title=\"run.sh\"", "npm test", "```", "", "```bash", "echo one \\", "```"].join("\n");

function Fixture() {
  return (
    <View>
      <ChatMarkdown text={text} streaming={streaming} />
      <View onPress={() => text.set("Intro\n\n```bash\nnpm run bu")} accessibilityLabel="Stream open fence"><Text>open fence</Text></View>
      <View onPress={() => text.set('```ts\nconst value = "hi";\n```')} accessibilityLabel="Show highlighted code"><Text>highlighted</Text></View>
      <View onPress={() => { threadFindQuery.set("quoted"); threadFindOpen.set(true); text.set(FULL); }} accessibilityLabel="Find quoted"><Text>find</Text></View>
      <View onPress={closeThreadFind} accessibilityLabel="Stop find"><Text>stop</Text></View>
      <View onPress={() => { streaming.set(false); text.set(CODE); }} accessibilityLabel="Show code blocks"><Text>code</Text></View>
      <View onPress={() => { threadFindOpen.set(true); threadFindQuery.set("Start"); }} accessibilityLabel="Find in diagram"><Text>find</Text></View>
      <View onPress={() => { streaming.set(false); text.set("```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n\n```mermaid\nnot a diagram\n```"); }} accessibilityLabel="Show mermaid"><Text>mermaid</Text></View>
      <View onPress={() => { streaming.set(false); text.set(MATH); }} accessibilityLabel="Show math as written"><Text>math off</Text></View>
      <View onPress={() => { updateSetting("mathRenderingEnabled", true); streaming.set(false); text.set(MATH); }} accessibilityLabel="Show math"><Text>math</Text></View>
      <Text>{`ran: ${ran()}`}</Text>
      <View onPress={() => text.set(FULL)} accessibilityLabel="Show full markdown"><Text>full</Text></View>
    </View>
  );
}

mount(Fixture);
