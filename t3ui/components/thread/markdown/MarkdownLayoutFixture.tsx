import { mount, signal, Text, View } from "nsh";
import { ChatMarkdown } from "./ChatMarkdown";

const BASIC = [
  "## Heading two", "", "Paragraph under the heading.", "",
  "- first item", "  - nested item", "  - nested two", "- second item", "",
  "1. one", "2. two", "3. ten", "", "Closing paragraph.",
].join("\n");
const LONG = Array.from({ length: 12 }, (_, index) => `${index + 1}. item ${index + 1}`).join("\n");
const CODE = "Before\n\n```ts\nconst a = 1;\n```\n\nAfter";

const source = signal(BASIC);

mount(() => (
  <View class="flex-1 bg-background p-6">
    <View class="w-[560px]">
      <ChatMarkdown text={source} />
    </View>
    <View accessibilityLabel="Show long ordered list" onPress={() => source.set(LONG)}><Text>long</Text></View>
    <View accessibilityLabel="Show code between text" onPress={() => source.set(CODE)}><Text>code</Text></View>
  </View>
));
